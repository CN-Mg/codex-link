/**
 * config.js 的单元测试。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS, describeConfig, resolveConfig } from '../lib/config.js';

test('默认值完整且工作区指向 Codex 的 Wechat 项目', () => {
  const settings = resolveConfig(undefined);
  assert.equal(settings.enabled, true);
  assert.equal(settings.workspaceRoot, 'C:\\Users\\Bolin\\Desktop\\DSH\\Wechat');
  assert.equal(settings.defaultThreadName, '微信工作区（DSH）');
  assert.equal(settings.sandbox, 'workspace-write');
  assert.equal(settings.approvalPolicy, 'never');
  assert.equal(settings.approvals, 'deny');
  assert.equal(settings.watchDefaultWaitMs <= settings.watchMaxWaitMs, true);
});

test('非法值被钳制/回退', () => {
  const settings = resolveConfig({
    enabled: false,
    sandbox: 'root',
    approvalPolicy: 'always',
    approvals: 'maybe',
    startupTimeoutMs: -1,
    eventBufferLimit: 2.5,
    summaryChars: 0,
    focusMode: 'thread',
    watchDefaultWaitMs: 99_999,
    watchMaxWaitMs: 5_000,
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.sandbox, DEFAULTS.sandbox);
  assert.equal(settings.approvalPolicy, DEFAULTS.approvalPolicy);
  assert.equal(settings.approvals, DEFAULTS.approvals);
  assert.equal(settings.startupTimeoutMs, DEFAULTS.startupTimeoutMs);
  assert.equal(settings.eventBufferLimit, DEFAULTS.eventBufferLimit);
  assert.equal(settings.summaryChars, DEFAULTS.summaryChars);
  assert.equal(settings.focusMode, 'off');
  assert.equal(settings.watchMaxWaitMs, 5_000);
  assert.ok(settings.watchDefaultWaitMs <= settings.watchMaxWaitMs);
});

test('显式配置覆盖默认值', () => {
  const settings = resolveConfig({
    workspaceRoot: 'D:\\project',
    defaultThreadName: 'custom',
    codexPath: 'D:\\codex\\codex.exe',
    sandbox: 'read-only',
    networkAccess: true,
  });
  assert.equal(settings.workspaceRoot, 'D:\\project');
  assert.equal(settings.defaultThreadName, 'custom');
  assert.equal(settings.codexPath, 'D:\\codex\\codex.exe');
  assert.equal(settings.sandbox, 'read-only');
  assert.equal(settings.networkAccess, true);
});

test('describeConfig 输出关键字段', () => {
  const text = describeConfig(resolveConfig(undefined));
  assert.match(text, /工作区=/u);
  assert.match(text, /默认会话=/u);
  assert.match(text, /sandbox=/u);
});
