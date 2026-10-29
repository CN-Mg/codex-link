/**
 * ui-store.js 的单元测试：模式读写、损坏文件容错。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { UiStore, defaultUiPath } from '../lib/ui-store.js';

/**
 * 建临时目录并在结束后清理。
 *
 * @param {(directory: string) => void} body 测试体。
 */
function withTempDirectory(body) {
  const directory = mkdtempSync(join(tmpdir(), 'codex-link-ui-'));
  try {
    body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('默认路径位于 DSH_HOME 下', () => {
  assert.match(defaultUiPath({ DSH_HOME: 'C:\\dsh' }), /codex-link[\\/]ui\.json$/u);
});

test('默认模式来自配置，读写后持久化', () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, 'ui.json');
    const store = new UiStore({ filePath, defaultMode: 'hybrid' });
    assert.equal(store.getMode(), 'hybrid');
    assert.equal(store.setMode('subagent'), 'subagent');
    assert.equal(store.getMode(), 'subagent');
    assert.equal(JSON.parse(readFileSync(filePath, 'utf8')).mode, 'subagent');

    const reopened = new UiStore({ filePath });
    assert.equal(reopened.getMode(), 'subagent');
  });
});

test('非法模式回退默认值', () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, 'ui.json');
    writeFileSync(filePath, JSON.stringify({ mode: 'nope' }), 'utf8');
    const store = new UiStore({ filePath, defaultMode: 'direct' });
    assert.equal(store.getMode(), 'direct');
  });
});

test('损坏 JSON 按默认值处理并告警', () => {
  withTempDirectory((directory) => {
    const filePath = join(directory, 'ui.json');
    writeFileSync(filePath, '{oops', 'utf8');
    const warnings = [];
    const store = new UiStore({ filePath, logger: { warn: (message) => warnings.push(message) } });
    assert.equal(store.getMode(), 'hybrid');
    assert.equal(warnings.length, 1);
    assert.equal(store.setMode('direct'), 'direct');
  });
});
