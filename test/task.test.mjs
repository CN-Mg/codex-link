/**
 * task.js 的单元测试：用假子进程模拟 `codex exec --json` 事件流。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { TaskError, TaskRunner } from '../lib/task.js';

/** 测试用配置。 */
const SETTINGS = {
  workspaceRoot: 'C:\\Users\\Bolin\\Desktop\\DSH\\Wechat',
  sandbox: 'workspace-write',
  codexPath: null,
  requestTimeoutMs: 5_000,
};

/**
 * 构造一个假子进程。
 *
 * @returns {{ child: any, stdout: PassThrough, stderr: PassThrough }} 假子进程与管道。
 */
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
  };
  return { child, stdout: child.stdout, stderr: child.stderr };
}

/**
 * 构造一个 TaskRunner，返回最近一次 spawn 的假子进程。
 *
 * @param {{ maxParallel?: number }} [options] 选项。
 * @returns {{ runner: TaskRunner, spawns: Array<{ child: any, args: string[] }> }} 运行器与 spawn 记录。
 */
function makeRunner(options = {}) {
  const spawns = [];
  const runner = new TaskRunner({
    settings: SETTINGS,
    maxParallel: options.maxParallel ?? 2,
    resolveBinary: () => ({ path: 'C:\\fake\\codex.exe', version: 'fake 1.0', source: 'test' }),
    spawnImpl: (command, args) => {
      const { child } = fakeChild();
      spawns.push({ child, command, args });
      return child;
    },
  });
  return { runner, spawns };
}

/**
 * 写一行 JSON 并等待事件循环转一圈。
 *
 * @param {PassThrough} stream 目标流。
 * @param {unknown} value 值。
 * @returns {Promise<void>} resolve。
 */
async function writeLine(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
}

test('成功：解析 thread id、最终回答与用量', async () => {
  const { runner, spawns } = makeRunner();
  const promise = runner.run({ task: '查询当前时间' });
  const { child } = spawns[0];
  await writeLine(child.stdout, { type: 'thread.started', thread_id: '01a18310-test' });
  await writeLine(child.stdout, { type: 'item.completed', item: { id: 'i0', type: 'error', message: 'fallback' } });
  await writeLine(child.stdout, { type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: '11:30:00' } });
  await writeLine(child.stdout, {
    type: 'turn.completed',
    usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 },
  });
  child.emit('close', 0, null);
  const result = await promise;
  assert.equal(result.ok, true);
  assert.equal(result.text, '11:30:00');
  assert.equal(result.threadId, '01a18310-test');
  assert.equal(result.usage.output_tokens, 5);
  assert.equal(runner.activeCount, 0);
});

test('失败：turn.failed 时返回 TASK_FAILED 并带原因', async () => {
  const { runner, spawns } = makeRunner();
  const promise = runner.run({ task: 'x' });
  await writeLine(spawns[0].child.stdout, { type: 'turn.failed', error: { message: 'workspace routing discovery failed' } });
  spawns[0].child.emit('close', 1, null);
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TASK_FAILED');
  assert.match(result.errorDetail, /workspace routing discovery failed/u);
});

test('超时：返回 TASK_TIMEOUT 并标记进程已被终止', async () => {
  const { runner, spawns } = makeRunner();
  const promise = runner.run({ task: 'x', timeoutMs: 30 });
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'TASK_TIMEOUT');
  assert.equal(spawns[0].child.killed, true);
});

test('并发上限：超过 maxParallel 抛 TASK_BUSY', async () => {
  const { runner, spawns } = makeRunner({ maxParallel: 1 });
  const first = runner.run({ task: 'a', timeoutMs: 1_000 });
  await assert.rejects(runner.run({ task: 'b' }), (error) => {
    assert.equal(error instanceof TaskError, true);
    assert.equal(error.code, 'TASK_BUSY');
    return true;
  });
  spawns[0].child.emit('close', 0, null);
  await first;
  assert.equal(runner.activeCount, 0);
});

test('空任务被拒绝', async () => {
  const { runner } = makeRunner();
  await assert.rejects(runner.run({ task: '  ' }), (error) => {
    assert.equal(error.code, 'EMPTY_PROMPT');
    return true;
  });
});

test('spawn 参数包含沙箱、工作目录与 -- 分隔', async () => {
  const { runner, spawns } = makeRunner();
  const promise = runner.run({ task: '任务内容', cwd: 'D:\\work', sandbox: 'read-only', model: 'gpt-x' });
  const { command, args } = spawns[0];
  assert.equal(command, 'C:\\fake\\codex.exe');
  assert.deepEqual(args.slice(0, 6), ['exec', '--json', '--skip-git-repo-check', '-C', 'D:\\work', '--sandbox']);
  assert.ok(args.includes('read-only'));
  assert.ok(args.includes('--model'));
  assert.equal(args[args.indexOf('--model') + 1], 'gpt-x');
  assert.equal(args[args.length - 2], '--');
  assert.equal(args[args.length - 1], '任务内容');
  spawns[0].child.emit('close', 0, null);
  await promise;
});

test('dispose 终止在跑的子进程', async () => {
  const { runner, spawns } = makeRunner();
  const promise = runner.run({ task: 'long', timeoutMs: 10_000 });
  runner.dispose();
  assert.equal(spawns[0].child.killed, true);
  assert.equal(runner.activeCount, 0);
  spawns[0].child.emit('close', 1, null);
  const result = await promise;
  assert.equal(result.ok, false);
});
