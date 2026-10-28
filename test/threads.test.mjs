/**
 * threads.js 的单元测试：会话匹配、默认会话、发送/中止/取结果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createThreadRegistry } from '../lib/events.js';
import {
  ThreadError,
  ensureDefaultThread,
  interruptThread,
  listThreads,
  matchThreadRef,
  readTurn,
  sendInstruction,
  startThread,
  summarizeThread,
  threadTitle,
} from '../lib/threads.js';

/**
 * 构造一个记录调用并返回预设响应的假 app-server。
 *
 * @param {Record<string, any | Function>} handlers 方法 → 响应或函数。
 * @returns {{ calls: Array<{ method: string, params: any }>, call: Function }} 假对象。
 */
function fakeServer(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (handler === undefined) throw new Error(`unexpected method: ${method}`);
      return typeof handler === 'function' ? handler(params) : handler;
    },
  };
}

/** 默认插件配置，供测试使用。 */
const SETTINGS = {
  workspaceRoot: 'C:\\Users\\Bolin\\Desktop\\DSH\\Wechat',
  defaultThreadName: '微信工作区（DSH）',
  sandbox: 'workspace-write',
  approvalPolicy: 'never',
  requestTimeoutMs: 10_000,
  watchDefaultWaitMs: 1_000,
  watchMaxWaitMs: 2_000,
};

test('threadTitle / summarizeThread 使用 name → preview → 目录名', () => {
  assert.equal(threadTitle({ name: '甲', preview: '乙' }), '甲');
  assert.equal(threadTitle({ preview: '乙' }), '乙');
  assert.equal(threadTitle({ cwd: 'D:\\project' }), 'project');
  const summary = summarizeThread({ id: 'id1', name: '会话', cwd: 'D:\\x', status: { type: 'idle' }, updatedAt: 5 });
  assert.deepEqual(summary, {
    id: 'id1',
    title: '会话',
    preview: '',
    cwd: 'D:\\x',
    status: 'idle',
    updatedAt: 5,
    archived: false,
  });
});

test('listThreads 传递过滤参数并映射摘要', async () => {
  const server = fakeServer({
    'thread/list': { data: [{ id: 'a', name: '甲', cwd: 'D:\\w', status: { type: 'idle' } }] },
  });
  const threads = await listThreads(server, { cwd: 'D:\\w', query: '甲', limit: 5 });
  assert.equal(threads.length, 1);
  assert.equal(threads[0].title, '甲');
  assert.equal(server.calls[0].params.cwd, 'D:\\w');
  assert.equal(server.calls[0].params.searchTerm, '甲');
  assert.equal(server.calls[0].params.limit, 5);
});

test('matchThreadRef：ID/前缀/序号/标题/片段/多义', () => {
  const threads = [
    { id: '01a171fb-3679-74b3-826c-57f4e36974c5', title: '微信工作区（DSH）' },
    { id: '01a180db-1ecb-7fd2-914f-20a0e9a76443', title: 'TERCOM 第四阶段' },
    { id: '01a180db-9999-7777-8888-999999999999', title: 'TERCOM 第三阶段' },
  ];
  assert.equal(matchThreadRef(threads, '01a171fb-3679-74b3-826c-57f4e36974c5').thread.title, '微信工作区（DSH）');
  assert.equal(matchThreadRef(threads, '1').thread.title, '微信工作区（DSH）');
  assert.equal(matchThreadRef(threads, '3').thread.title, 'TERCOM 第三阶段');
  assert.equal(matchThreadRef(threads, '「微信工作区（DSH）」').thread.title, '微信工作区（DSH）');
  assert.equal(matchThreadRef(threads, 'TERCOM 第四阶段').thread.title, 'TERCOM 第四阶段');
  assert.equal(matchThreadRef(threads, '微信').thread.title, '微信工作区（DSH）');

  const prefix = matchThreadRef(threads, '01a180db');
  assert.equal(prefix.thread, undefined);
  assert.equal(prefix.candidates.length, 2);

  const ambiguous = matchThreadRef(threads, 'TERCOM');
  assert.equal(ambiguous.candidates.length, 2);

  assert.deepEqual(matchThreadRef(threads, '不存在'), { candidates: [] });
  assert.deepEqual(matchThreadRef(threads, ''), { candidates: [] });
});

test('ensureDefaultThread：找到同名会话则不新建', async () => {
  const server = fakeServer({
    'thread/list': {
      data: [
        { id: 'found', name: '微信工作区（DSH）', cwd: SETTINGS.workspaceRoot, status: { type: 'idle' } },
      ],
    },
  });
  const thread = await ensureDefaultThread(server, SETTINGS);
  assert.equal(thread.id, 'found');
  assert.equal(thread.created, false);
  assert.equal(server.calls.some((call) => call.method === 'thread/start'), false);
});

test('ensureDefaultThread：找不到则新建并命名', async () => {
  const server = fakeServer({
    'thread/list': { data: [] },
    'thread/start': { thread: { id: 'new-id', cwd: SETTINGS.workspaceRoot, status: { type: 'idle' } } },
    'thread/name/set': {},
  });
  const thread = await ensureDefaultThread(server, SETTINGS);
  assert.equal(thread.id, 'new-id');
  assert.equal(thread.created, true);
  assert.equal(server.calls.some((call) => call.method === 'thread/name/set'), true);
});

test('startThread 传沙箱与审批策略', async () => {
  const server = fakeServer({
    'thread/start': { thread: { id: 'tid', cwd: SETTINGS.workspaceRoot, status: { type: 'idle' } } },
    'thread/name/set': {},
  });
  await startThread(server, SETTINGS, { name: '新会话' });
  const startCall = server.calls.find((call) => call.method === 'thread/start');
  assert.equal(startCall.params.cwd, SETTINGS.workspaceRoot);
  assert.equal(startCall.params.sandbox, 'workspace-write');
  assert.equal(startCall.params.approvalPolicy, 'never');
});

test('sendInstruction：空闲会话走 turn/start 并标记活跃', async () => {
  const registry = createThreadRegistry();
  const server = fakeServer({
    'thread/resume': { thread: { id: 'tid', status: { type: 'idle' } } },
    'turn/start': { turn: { id: 'turn-9', status: 'inProgress' } },
  });
  const result = await sendInstruction(server, registry, SETTINGS, { threadId: 'tid', text: '做点事' });
  assert.equal(result.mode, 'start');
  assert.equal(result.turnId, 'turn-9');
  assert.equal(registry.stateOf('tid').activeTurnId, 'turn-9');
  const turnCall = server.calls.find((call) => call.method === 'turn/start');
  assert.deepEqual(turnCall.params.input[0].text, '做点事');
});

test('sendInstruction：本插件发起的活跃回合同意 steer', async () => {
  const registry = createThreadRegistry();
  registry.markActive('tid', 'turn-9');
  const server = fakeServer({
    'thread/resume': { thread: { id: 'tid', status: { type: 'active' } } },
    'turn/steer': {},
  });
  const result = await sendInstruction(server, registry, SETTINGS, {
    threadId: 'tid',
    text: '再加一点',
    mode: 'steer',
  });
  assert.equal(result.mode, 'steer');
  assert.equal(result.turnId, 'turn-9');
  const steerCall = server.calls.find((call) => call.method === 'turn/steer');
  assert.equal(steerCall.params.expectedTurnId, 'turn-9');
});

test('sendInstruction：其它客户端占用的活跃回合返回 BUSY_THREAD', async () => {
  const registry = createThreadRegistry();
  const server = fakeServer({
    'thread/resume': { thread: { id: 'tid', status: { type: 'active' } } },
  });
  await assert.rejects(
    sendInstruction(server, registry, SETTINGS, { threadId: 'tid', text: '插队' }),
    (error) => {
      assert.equal(error instanceof ThreadError, true);
      assert.equal(error.code, 'BUSY_THREAD');
      return true;
    },
  );
});

test('interruptThread：用登记的回合 ID 中止', async () => {
  const registry = createThreadRegistry();
  registry.markActive('tid', 'turn-7');
  const server = fakeServer({
    'turn/interrupt': {},
    'thread/resume': { thread: { id: 'tid', status: { type: 'idle' } } },
  });
  const result = await interruptThread(server, registry, { threadId: 'tid' });
  assert.equal(result.turnId, 'turn-7');
  assert.equal(server.calls[0].method, 'turn/interrupt');
});

test('readTurn：优先本地缓存，否则回查 app-server', async () => {
  const registry = createThreadRegistry();
  registry.recordLastTurn('tid', {
    turnId: 'turn-1',
    status: 'completed',
    durationMs: 12,
    finalText: '本地答案',
    error: null,
  });
  const local = await readTurn(fakeServer({}), registry, { threadId: 'tid' });
  assert.equal(local.source, 'local');
  assert.equal(local.finalText, '本地答案');

  const server = fakeServer({
    'thread/turns/list': {
      data: [{ id: 'turn-2', status: 'completed', durationMs: 20, items: [{ type: 'agentMessage', text: '远端答案' }] }],
    },
  });
  const remote = await readTurn(server, createThreadRegistry(), { threadId: 'tid2', turnId: 'turn-2' });
  assert.equal(remote.source, 'remote');
  assert.equal(remote.finalText, '远端答案');
  assert.equal(remote.durationMs, 20);
});
