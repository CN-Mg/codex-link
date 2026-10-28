/**
 * rpc-client.js 的单元测试：用内存流模拟 app-server 的按行 JSON-RPC。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';

import {
  RpcClosedError,
  RpcRemoteError,
  RpcTimeoutError,
  createRpcSession,
} from '../lib/rpc-client.js';

/**
 * 创建一个测试会话，并返回写出的消息。
 *
 * @param {{ defaultTimeoutMs?: number }} [options] 选项。
 * @returns {{ session: ReturnType<typeof createRpcSession>, input: PassThrough, outbound: () => any[], flush: (message: any) => void }} 句柄。
 */
function makeSession(options = {}) {
  const input = new PassThrough();
  /** @type {string[]} */
  const written = [];
  const session = createRpcSession({
    readable: input,
    writable: {
      write(chunk) {
        written.push(String(chunk));
      },
    },
    defaultTimeoutMs: options.defaultTimeoutMs ?? 1_000,
  });
  return {
    session,
    input,
    outbound: () =>
      written
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line)),
    flush: (message) => input.write(`${JSON.stringify(message)}\n`),
  };
}

/**
 * 等待一个宏任务，让 Promise 链跑完。
 *
 * @returns {Promise<void>} resolve。
 */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

test('请求-响应关联按 id 工作', async () => {
  const { session, outbound, flush } = makeSession();
  const promise = session.request('ping', { value: 1 });
  const [sent] = outbound();
  assert.equal(sent.method, 'ping');
  assert.deepEqual(sent.params, { value: 1 });
  flush({ jsonrpc: '2.0', id: sent.id, result: { ok: true } });
  const result = await promise;
  assert.deepEqual(result, { ok: true });
  session.close();
});

test('分片与粘包的 JSON 行都能解析', async () => {
  const { session, input, outbound, flush } = makeSession();
  const first = session.request('a');
  const second = session.request('b');
  const [head] = outbound();
  const idA = head.id;
  const idB = idA + 1;
  const payload = `${JSON.stringify({ jsonrpc: '2.0', id: idA, result: 'A' })}\n${JSON.stringify({
    jsonrpc: '2.0',
    id: idB,
    result: 'B',
  })}\n`;
  input.write(payload.slice(0, 10));
  input.write(payload.slice(10));
  await tick();
  assert.equal(await first, 'A');
  assert.equal(await second, 'B');
  flush({ jsonrpc: '2.0', method: 'noop' });
  session.close();
});

test('通知按方法与通配分发', async () => {
  const { session, flush } = makeSession();
  /** @type {string[]} */
  const seen = [];
  const offMethod = session.on('turn/started', (params) => seen.push(`m:${params.threadId}`));
  const offAny = session.onAny((method) => seen.push(`any:${method}`));
  flush({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't1' } });
  await tick();
  assert.deepEqual(seen, ['any:turn/started', 'm:t1']);
  offMethod();
  offAny();
  flush({ jsonrpc: '2.0', method: 'turn/started', params: { threadId: 't2' } });
  await tick();
  assert.deepEqual(seen, ['any:turn/started', 'm:t1']);
  session.close();
});

test('服务端请求会被应答；未设置处理器时回 -32601', async () => {
  const { session, outbound, flush } = makeSession();
  flush({ jsonrpc: '2.0', id: 'srv1', method: 'item/commandExecution/requestApproval', params: { threadId: 't1' } });
  await tick();
  const [response] = outbound();
  assert.equal(response.id, 'srv1');
  assert.equal(response.error.code, -32601);

  session.setServerRequestHandler(() => ({ decision: 'approved' }));
  flush({ jsonrpc: '2.0', id: 'srv2', method: 'item/commandExecution/requestApproval', params: {} });
  await tick();
  const [, second] = outbound();
  assert.deepEqual(second.result, { decision: 'approved' });
  session.close();
});

test('超时抛 RpcTimeoutError', async () => {
  const { session } = makeSession({ defaultTimeoutMs: 20 });
  await assert.rejects(session.request('slow'), (error) => {
    assert.equal(error instanceof RpcTimeoutError, true);
    assert.equal(error.code, 'RPC_TIMEOUT');
    return true;
  });
  session.close();
});

test('关闭后所有在途请求失败，新请求立即失败', async () => {
  const { session } = makeSession({ defaultTimeoutMs: 5_000 });
  const promise = session.request('pending');
  session.close('测试关闭');
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof RpcClosedError, true);
    assert.equal(error.code, 'APP_SERVER_UNAVAILABLE');
    return true;
  });
  await assert.rejects(session.request('after'), RpcClosedError);
});

test('JSON-RPC 错误转成 RpcRemoteError', async () => {
  const { session, outbound, flush } = makeSession();
  const promise = session.request('thread/resume');
  const [sent] = outbound();
  flush({ jsonrpc: '2.0', id: sent.id, error: { code: -32603, message: 'no rollout found' } });
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof RpcRemoteError, true);
    assert.equal(error.code, 'RPC_ERROR');
    assert.match(error.message, /no rollout found/u);
    return true;
  });
  session.close();
});

test('可取消：AbortSignal 中止在途请求', async () => {
  const { session } = makeSession({ defaultTimeoutMs: 5_000 });
  const controller = new AbortController();
  const promise = session.request('abort-me', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(promise, (error) => {
    assert.equal(error.name, 'AbortError');
    return true;
  });
  session.close();
});
