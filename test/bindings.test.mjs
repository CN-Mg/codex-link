/**
 * bindings.js 的单元测试：持久化、原子写入、损坏文件容错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BindingsStore, defaultBindingsPath } from '../lib/bindings.js';

/**
 * 建一个临时目录并在用完后清理。
 *
 * @param {(directory: string) => void} body 测试体。
 */
function withTempDirectory(body) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-link-bindings-'));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('默认路径位于 DSH_HOME 下', () => {
  assert.match(defaultBindingsPath({ DSH_HOME: 'C:\\dsh' }), /codex-link[\\/]bindings\.json$/u);
  assert.match(defaultBindingsPath({}), /\.dsh[\\/]codex-link[\\/]bindings\.json$/u);
});

test('set/get 落盘，重新打开后仍能读到', () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, 'bindings.json');
    const store = new BindingsStore({ filePath });
    store.set('session-a', { threadId: 'thread-1', threadTitle: '微信工作区（DSH）' });
    assert.equal(store.get('session-a').threadId, 'thread-1');

    const raw = JSON.parse(readFileSync(filePath, 'utf8'));
    assert.equal(raw['session-a'].threadTitle, '微信工作区（DSH）');

    const reopened = new BindingsStore({ filePath });
    assert.equal(reopened.get('session-a').threadId, 'thread-1');
    assert.equal(reopened.get('missing'), null);
  });
});

test('remove 删除绑定', () => {
  withTempDirectory((directory) => {
    const store = new BindingsStore({ filePath: join(directory, 'bindings.json') });
    store.set('s1', { threadId: 't1' });
    assert.equal(store.remove('s1'), true);
    assert.equal(store.remove('s1'), false);
    assert.equal(store.get('s1'), null);
  });
});

test('损坏的 JSON 按空表处理，不抛异常', () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, 'bindings.json');
    writeFileSync(filePath, '{ not json', 'utf8');
    const warnings = [];
    const store = new BindingsStore({ filePath, logger: { warn: (message) => warnings.push(message) } });
    assert.equal(store.get('anything'), null);
    assert.equal(warnings.length, 1);
    store.set('s2', { threadId: 't2' });
    assert.equal(store.get('s2').threadId, 't2');
    assert.doesNotThrow(() => JSON.parse(readFileSync(filePath, 'utf8')));
  });
});
