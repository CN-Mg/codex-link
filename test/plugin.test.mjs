/**
 * 插件入口的装配测试：用假 Cordis 上下文验证工具注册、system prompt 与清理钩子。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { apply } from '../lib/index.js';

/**
 * 构造一个记录注册行为的假 Cordis 上下文。
 *
 * @returns {{
 *   ctx: any,
 *   tools: Array<any>,
 *   sections: Array<any>,
 *   effects: Array<{ fn: Function, label: string }>,
 *   routes: Array<any>,
 * }} 假上下文与记录。
 */
function fakeContext() {
  const tools = [];
  const sections = [];
  const effects = [];
  const routes = [];
  const ctx = {
    tools: {
      register(spec) {
        tools.push(spec);
        return () => {};
      },
    },
    get(name) {
      if (name === 'webServer') {
        return {
          register(definition) {
            routes.push(definition);
            return () => {};
          },
        };
      }
      if (name !== 'systemPrompt') return undefined;
      return {
        section(section) {
          sections.push(section);
        },
      };
    },
    effect(fn, label) {
      effects.push({ fn, label });
    },
  };
  return { ctx, tools, sections, effects, routes };
}

test('apply 注册 10 个工具、1 段指南、1 组设置页路由与 1 个清理钩子', () => {
  const { ctx, tools, sections, effects, routes } = fakeContext();
  apply(ctx, {});
  assert.equal(tools.length, 10);
  assert.deepEqual(
    tools.map((spec) => spec.name),
    [
      'codex_status',
      'codex_threads',
      'codex_use',
      'codex_send',
      'codex_task',
      'codex_watch',
      'codex_result',
      'codex_interrupt',
      'codex_usage',
      'codex_open_project',
    ],
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].name, 'codex-link:guide');
  assert.match(sections[0].text(), /codex_send/u);
  assert.match(sections[0].text(), /codex_task/u);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/.dsh-codex-link');
  assert.equal(effects.length, 1);
  assert.equal(effects[0].label, 'dsh-plugin-codex-link: shutdown');

  // 卸载钩子必须可执行且不抛异常（此时 app-server 尚未启动）。
  const dispose = effects[0].fn();
  assert.doesNotThrow(() => dispose());
});

test('enabled=false 时不注册任何工具', () => {
  const { ctx, tools, sections, effects, routes } = fakeContext();
  apply(ctx, { enabled: false });
  assert.equal(tools.length, 0);
  assert.equal(sections.length, 0);
  assert.equal(effects.length, 0);
  assert.equal(routes.length, 0);
});

test('宿主缺少工具服务时安全降级', () => {
  const ctx = { tools: undefined, get: () => undefined, effect: () => {} };
  assert.doesNotThrow(() => apply(ctx, {}));
});
