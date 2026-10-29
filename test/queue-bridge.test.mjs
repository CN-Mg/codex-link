/**
 * queue-bridge.js 的单元测试：输出解析、成功/失败/超时。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { QueueError, parseQueueOutput, queueMessage } from '../lib/queue-bridge.js';

/**
 * 构造假子进程。
 *
 * @returns {any} 子进程。
 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = undefined;
  child.kill = () => {};
  return child;
}

test('parseQueueOutput 提取消息 id', () => {
  assert.equal(
    parseQueueOutput('Queued message 01a18320-8ef0-71b0-8c8a-197ceb092c3c for thread 01a171fb-3679'),
    '01a18320-8ef0-71b0-8c8a-197ceb092c3c',
  );
  assert.equal(parseQueueOutput('anything else'), null);
  assert.equal(parseQueueOutput(''), null);
});

test('queueMessage 成功并解析消息 id', async () => {
  const child = fakeChild();
  const promise = queueMessage({
    binaryPath: 'C:\\fake\\codex.exe',
    threadId: 'thread-1',
    text: '查询当前时间',
    spawnImpl: () => child,
  });
  child.stdout.emit('data', 'Queued message 01a18320-aaaa for thread thread-1\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 0, null);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.messageId, '01a18320-aaaa');
});

test('queueMessage 非零退出码抛 QUEUE_FAILED', async () => {
  const child = fakeChild();
  const promise = queueMessage({
    binaryPath: 'C:\\fake\\codex.exe',
    threadId: 'thread-1',
    text: 'x',
    spawnImpl: () => child,
  });
  child.stderr.emit('data', 'not found\n');
  await new Promise((resolve) => setImmediate(resolve));
  child.emit('close', 1, null);
  await assert.rejects(promise, (error) => {
    assert.equal(error instanceof QueueError, true);
    assert.equal(error.code, 'QUEUE_FAILED');
    assert.match(error.message, /not found/u);
    return true;
  });
});

test('queueMessage 超时抛 QUEUE_TIMEOUT', async () => {
  const child = fakeChild();
  const promise = queueMessage({
    binaryPath: 'C:\\fake\\codex.exe',
    threadId: 'thread-1',
    text: 'x',
    timeoutMs: 20,
    spawnImpl: () => child,
  });
  await assert.rejects(promise, (error) => {
    assert.equal(error.code, 'QUEUE_TIMEOUT');
    return true;
  });
});
