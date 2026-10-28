/**
 * tools.js 的单元测试：规格形状、会话上下文透传、错误映射。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ThreadError } from '../lib/threads.js';
import { buildToolSpecs } from '../lib/tools.js';

/**
 * 构造一个记录调用参数的假控制器。
 *
 * @param {Record<string, Function>} [overrides] 覆盖部分方法。
 * @returns {{ calls: Array<{ method: string, args: any, sessionId?: string }>, controller: any }} 假控制器。
 */
function fakeController(overrides = {}) {
  const calls = [];
  const make = (method) => async (...args) => {
    calls.push({ method, args });
    const handler = overrides[method];
    if (handler !== undefined) return handler(...args);
    return `${method}-ok`;
  };
  return {
    calls,
    controller: {
      status: make('status'),
      threads: make('threads'),
      use: make('use'),
      send: make('send'),
      watch: make('watch'),
      result: make('result'),
      interrupt: make('interrupt'),
      usage: make('usage'),
      openProject: make('openProject'),
    },
  };
}

/**
 * 按名字取工具。
 *
 * @param {Array<any>} specs 规格列表。
 * @param {string} name 工具名。
 * @returns {any} 规格。
 */
function specOf(specs, name) {
  const spec = specs.find((candidate) => candidate.name === name);
  assert.ok(spec, `缺少工具 ${name}`);
  return spec;
}

test('注册全部 9 个工具且参数是 object schema', () => {
  const { controller } = fakeController();
  const specs = buildToolSpecs({ controller });
  assert.deepEqual(
    specs.map((spec) => spec.name),
    [
      'codex_status',
      'codex_threads',
      'codex_use',
      'codex_send',
      'codex_watch',
      'codex_result',
      'codex_interrupt',
      'codex_usage',
      'codex_open_project',
    ],
  );
  for (const spec of specs) {
    assert.equal(spec.parameters.type, 'object');
    assert.equal(typeof spec.output.render, 'function');
    assert.equal(typeof spec.execute, 'function');
  }
  assert.deepEqual(specOf(specs, 'codex_send').parameters.required, ['text']);
});

test('execute 透传 sessionId 并渲染文本块', async () => {
  const { calls, controller } = fakeController({ use: async (args, sessionId) => `bound:${sessionId}:${args.thread}` });
  const specs = buildToolSpecs({ controller });
  const value = await specOf(specs, 'codex_use').execute({ thread: '微信工作区（DSH）' }, { agent: { session: { id: 'sess-1' } } });
  assert.deepEqual(value, { text: 'bound:sess-1:微信工作区（DSH）' });
  assert.equal(calls[0].method, 'use');
  const [block] = specOf(specs, 'codex_use').output.render({}, value);
  assert.deepEqual(block, { type: 'text', text: 'bound:sess-1:微信工作区（DSH）' });
});

test('控制器抛错时返回“错误码: 说明”', async () => {
  const { controller } = fakeController({
    send: async () => {
      throw new ThreadError('BUSY_THREAD', '会话正在运行');
    },
  });
  const specs = buildToolSpecs({ controller });
  const value = await specOf(specs, 'codex_send').execute({ text: 'hi' }, { agent: { session: { id: 's' } } });
  assert.deepEqual(value, { text: 'BUSY_THREAD: 会话正在运行' });
});

test('普通异常回退为 ERROR 前缀', async () => {
  const { controller } = fakeController({
    usage: async () => {
      throw new Error('boom');
    },
  });
  const specs = buildToolSpecs({ controller });
  const value = await specOf(specs, 'codex_usage').execute({}, {});
  assert.deepEqual(value, { text: 'ERROR: boom' });
});

test('缺少 exec 上下文时不抛异常', async () => {
  const { controller } = fakeController();
  const specs = buildToolSpecs({ controller });
  const value = await specOf(specs, 'codex_threads').execute({ all: true }, undefined);
  assert.deepEqual(value, { text: 'threads-ok' });
});
