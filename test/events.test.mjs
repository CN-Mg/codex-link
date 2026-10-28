/**
 * events.js 的单元测试：通知 → 进度事件、游标、缓冲与结果提取。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { clip, createThreadRegistry, finalAnswerOf } from '../lib/events.js';

/**
 * 构造一个最小回合对象。
 *
 * @param {{ id?: string, status?: string }} [options] 覆盖项。
 * @returns {any} 回合。
 */
function turn(options = {}) {
  return {
    id: options.id ?? 'turn-1',
    status: options.status ?? 'completed',
    durationMs: 1234,
    items: [
      { type: 'reasoning', id: 'r1', summary: [], content: [] },
      { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: 'D:\\p', exitCode: 0, durationMs: 500, status: 'completed' },
      { type: 'agentMessage', id: 'm1', text: '搞定', phase: 'final_answer' },
    ],
  };
}

test('clip 与 finalAnswerOf 的基础行为', () => {
  assert.equal(clip('abcdef', 4), 'abc…');
  assert.equal(clip('abc', 10), 'abc');
  assert.equal(clip(undefined, 5), '');
  assert.equal(finalAnswerOf(undefined), '');
  assert.equal(finalAnswerOf(turn().items), '搞定');
  assert.equal(
    finalAnswerOf([
      { type: 'agentMessage', text: '前面', phase: null },
      { type: 'other' },
    ]),
    '前面',
  );
});

test('turn 生命周期：开始、工具调用、结果与最终回答', () => {
  const registry = createThreadRegistry({ summaryChars: 200 });
  registry.observe('turn/started', { threadId: 't1', turn: { id: 'turn-1' } });
  registry.observe('item/started', {
    threadId: 't1',
    turnId: 'turn-1',
    item: { type: 'commandExecution', id: 'c1', command: 'npm test', cwd: 'D:\\p' },
  });
  registry.observe('item/started', {
    threadId: 't1',
    turnId: 'turn-1',
    item: { type: 'fileChange', id: 'f1', changes: [{ path: 'src/a.js' }], status: 'completed' },
  });
  assert.equal(registry.stateOf('t1').status, 'active');
  assert.equal(registry.stateOf('t1').activeTurnId, 'turn-1');

  registry.observe('item/completed', {
    threadId: 't1',
    turnId: 'turn-1',
    item: { type: 'commandExecution', id: 'c1', command: 'npm test', exitCode: 0, durationMs: 500 },
  });
  registry.observe('item/agentMessage/delta', { threadId: 't1', turnId: 'turn-1', itemId: 'm1', delta: '搞' });
  registry.observe('item/agentMessage/delta', { threadId: 't1', turnId: 'turn-1', itemId: 'm1', delta: '定' });
  registry.observe('turn/completed', { threadId: 't1', turn: turn() });

  const state = registry.stateOf('t1');
  assert.equal(state.status, 'idle');
  assert.equal(state.activeTurnId, null);
  assert.equal(state.lastTurn.status, 'completed');
  assert.equal(state.lastTurn.finalText, '搞定');

  const summary = registry.eventsSince('t1', undefined, { detail: 'summary' });
  const kinds = summary.events.map((event) => event.kind);
  assert.deepEqual(kinds, ['turn_started', 'tool_call', 'tool_call', 'tool_result', 'turn_completed']);
  assert.equal(summary.stale, false);
  assert.match(summary.events.at(-1).text, /回合结束/u);

  const full = registry.eventsSince('t1', undefined, { detail: 'full' });
  assert.equal(full.events.some((event) => event.kind === 'assistant_delta'), true);
});

test('游标续读：第二次调用不重复返回事件', () => {
  const registry = createThreadRegistry();
  registry.observe('turn/started', { threadId: 't1', turn: { id: 'turn-1' } });
  const first = registry.eventsSince('t1', undefined);
  assert.equal(first.events.length, 1);
  const second = registry.eventsSince('t1', first.cursor);
  assert.equal(second.events.length, 0);
  assert.equal(second.cursor, first.cursor);

  registry.observe('item/started', { threadId: 't1', item: { type: 'reasoning', id: 'r1' } });
  const third = registry.eventsSince('t1', first.cursor);
  assert.equal(third.events.length, 1);
  assert.equal(third.events[0].kind, 'thinking');
});

test('旧实例游标被标记 stale', () => {
  const registry = createThreadRegistry();
  registry.observe('turn/started', { threadId: 't1', turn: { id: 'turn-1' } });
  const stale = registry.eventsSince('t1', 'oldepoch:3');
  assert.equal(stale.stale, true);
  assert.equal(stale.events.length, 1);
});

test('缓冲溢出后标记 truncated 并淘汰最旧事件', () => {
  const registry = createThreadRegistry({ eventBufferLimit: 3 });
  for (let index = 0; index < 6; index += 1) {
    registry.observe('item/started', { threadId: 't1', item: { type: 'reasoning', id: `r${index}` } });
  }
  const slice = registry.eventsSince('t1', undefined);
  assert.equal(slice.events.length, 3);
  assert.equal(slice.truncated, true);
  assert.equal(registry.stateOf('t1').dropped, 3);
});

test('token 用量与额度通知被缓存', () => {
  const registry = createThreadRegistry();
  registry.observe('thread/tokenUsage/updated', {
    threadId: 't1',
    tokenUsage: { total: { inputTokens: 10 }, last: { inputTokens: 2, outputTokens: 3 } },
  });
  registry.observe('account/rateLimits/updated', { rateLimits: { primary: { usedPercent: 5 } } });
  assert.equal(registry.stateOf('t1').usage.last.outputTokens, 3);
  assert.equal(registry.getRateLimits().primary.usedPercent, 5);
});

test('错误/警告/审批拒绝进入事件流', () => {
  const registry = createThreadRegistry();
  registry.observe('error', { threadId: 't1', message: 'stream failed' });
  registry.observe('warning', { threadId: 't1', message: 'slow' });
  registry.recordApprovalDenied('t1', { command: 'rm -rf /' }, '插件默认拒绝');
  const slice = registry.eventsSince('t1', undefined);
  assert.deepEqual(
    slice.events.map((event) => event.kind),
    ['error', 'warning', 'approval_denied'],
  );
});
