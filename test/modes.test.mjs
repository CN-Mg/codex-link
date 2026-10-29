/**
 * modes.js 的单元测试：默认模式、非法回退与 codex_task 通道决策。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_MODE, MODES, MODE_IDS, describeMode, resolveMode, resolveTaskChannel } from '../lib/modes.js';

test('模式列表稳定且包含三种方式', () => {
  assert.deepEqual(MODE_IDS, ['direct', 'subagent', 'hybrid']);
  assert.equal(MODES.length, 3);
  assert.equal(DEFAULT_MODE, 'hybrid');
  assert.equal(describeMode('direct').label, '直控会话');
  assert.equal(describeMode('unknown').id, 'hybrid');
});

test('resolveMode 拒绝非法值并回退', () => {
  assert.equal(resolveMode('subagent'), 'subagent');
  assert.equal(resolveMode('nope'), DEFAULT_MODE);
  assert.equal(resolveMode(undefined), DEFAULT_MODE);
  assert.equal(resolveMode('direct', 'hybrid'), 'direct');
});

test('resolveTaskChannel：显式通道优先', () => {
  assert.equal(resolveTaskChannel({ requested: 'isolated', pluginMode: 'direct', hasBinding: true }), 'isolated');
  assert.equal(resolveTaskChannel({ requested: 'session', pluginMode: 'subagent', hasBinding: false }), 'session');
});

test('resolveTaskChannel：按插件模式与绑定情况决定', () => {
  assert.equal(resolveTaskChannel({ requested: 'auto', pluginMode: 'subagent', hasBinding: true }), 'isolated');
  assert.equal(resolveTaskChannel({ requested: 'auto', pluginMode: 'direct', hasBinding: false }), 'session');
  assert.equal(resolveTaskChannel({ requested: 'auto', pluginMode: 'hybrid', hasBinding: true }), 'session');
  assert.equal(resolveTaskChannel({ requested: 'auto', pluginMode: 'hybrid', hasBinding: false }), 'isolated');
});
