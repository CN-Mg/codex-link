/**
 * rollout-tail.js 的单元测试：路径定位、记录归一化、增量读取。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RolloutTail, findRolloutPath, normalizeRolloutRecord } from '../lib/rollout-tail.js';

/**
 * 用真实临时目录建一个 sessions 结构。
 *
 * @param {string} threadId 会话 ID。
 * @returns {{ root: string, file: string, cleanup: () => void }} 目录、rollout 文件与清理函数。
 */
function makeRollout(threadId) {
  const root = mkdtempSync(join(tmpdir(), 'codex-link-rollout-'));
  const day = join(root, '2026', '10', '29');
  mkdirSync(day, { recursive: true });
  const file = join(day, `rollout-2026-10-29T18-00-00-${threadId}.jsonl`);
  writeFileSync(file, '', 'utf8');
  return { root, file, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test('findRolloutPath 按 thread id 在日期目录里找到文件', () => {
  const threadId = '01a18743-a637-7030-aede-b9f02b80c8d8';
  const fixture = makeRollout(threadId);
  try {
    const found = findRolloutPath(fixture.root, threadId);
    assert.equal(found, fixture.file);
    assert.equal(findRolloutPath(fixture.root, 'missing-thread'), null);
  } finally {
    fixture.cleanup();
  }
});

test('normalizeRolloutRecord：任务开始/工具/完成/用量', () => {
  assert.deepEqual(normalizeRolloutRecord({ type: 'unknown' }), { events: [] });

  const started = normalizeRolloutRecord({ type: 'event_msg', payload: { type: 'task_started' } });
  assert.equal(started.running, true);
  assert.equal(started.events[0].kind, 'turn_started');

  const call = normalizeRolloutRecord({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell' },
  });
  assert.equal(call.events[0].kind, 'tool_call');
  assert.match(call.events[0].text, /shell/u);

  const output = normalizeRolloutRecord({
    type: 'response_item',
    payload: { type: 'function_call_output', output: '11:21:20' },
  });
  assert.equal(output.events[0].kind, 'tool_result');
  assert.match(output.events[0].text, /11:21:20/u);

  const message = normalizeRolloutRecord({
    type: 'event_msg',
    payload: { type: 'agent_message', message: '当前时间 11:21' },
  });
  assert.equal(message.events[0].kind, 'message');
  assert.match(message.events[0].text, /当前时间 11:21/u);

  const token = normalizeRolloutRecord({
    type: 'event_msg',
    payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10 } } },
  });
  assert.deepEqual(token.usage, { input_tokens: 10 });

  const complete = normalizeRolloutRecord({
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: 'turn-1',
      last_agent_message: '当前时间 11:21',
      duration_ms: 1234,
    },
  });
  assert.deepEqual(complete.completed, { turnId: 'turn-1', finalText: '当前时间 11:21', durationMs: 1234 });
});

test('RolloutTail 只读投递之后新增的内容', () => {
  const threadId = '01a18743-tail';
  const fixture = makeRollout(threadId);
  writeFileSync(
    fixture.file,
    `${JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: '旧回合' } })}\n`,
    'utf8',
  );
  try {
    const tail = new RolloutTail({ sessionsRoot: fixture.root, threadId });
    assert.equal(tail.ensureLocated(), true);
    tail.startAtEnd();
    assert.deepEqual(tail.poll().events, []);

    const first = JSON.stringify({ type: 'event_msg', payload: { type: 'task_started' } });
    const second = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: '新回答' },
    });
    const third = JSON.stringify({
      type: 'event_msg',
      payload: { type: 'task_complete', turn_id: 'turn-2', last_agent_message: '新回答', duration_ms: 500 },
    });
    appendFileSync(fixture.file, `${first}\n${second}\n`, 'utf8');

    const slice = tail.poll();
    assert.equal(slice.events.some((event) => event.text.includes('新回答')), true);
    assert.equal(slice.completed, null);

    appendFileSync(fixture.file, `${third}\n`, 'utf8');
    const finished = tail.poll();
    assert.deepEqual(finished.completed, { turnId: 'turn-2', finalText: '新回答', durationMs: 500 });
    assert.equal(finished.running, false);
  } finally {
    fixture.cleanup();
  }
});

test('RolloutTail 找不到文件时 poll 返回空而不是抛异常', () => {
  const tail = new RolloutTail({ sessionsRoot: join(tmpdir(), 'codex-link-none'), threadId: 'missing' });
  assert.equal(tail.ensureLocated(), false);
  assert.deepEqual(tail.poll(), { events: [], completed: null, running: false, usage: null });
});
