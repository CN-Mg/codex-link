/**
 * 设置页路由的单元测试：用假 ctx/req/res 验证 state/sessions/mode/bind 与错误分支。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ROUTE_PREFIX, registerPanelRoutes } from '../lib/index.js';

/**
 * 注册路由并返回捕获的定义。
 *
 * @param {any} controller 假控制器。
 * @param {string[]} warnings 告警收集。
 * @returns {any} 路由定义。
 */
function setup(controller, warnings) {
  const ctx = {
    get(name) {
      if (name !== 'webServer') return undefined;
      return {
        register(definition) {
          return () => {};
        },
      };
    },
  };
  let captured = null;
  ctx.get = (name) =>
    name === 'webServer'
      ? {
          register(definition) {
            captured = definition;
            return () => {};
          },
        }
      : undefined;
  const dispose = registerPanelRoutes(ctx, controller, { warn: (message) => warnings.push(message) });
  assert.equal(typeof dispose, 'function');
  return captured;
}

/**
 * 构造假请求。
 *
 * @param {string} method 方法。
 * @param {string} url 地址。
 * @param {unknown} [body] 请求体。
 * @returns {any} 请求。
 */
function fakeRequest(method, url, body) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.setEncoding = () => {};
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', JSON.stringify(body));
    req.emit('end');
  });
  return req;
}

/**
 * 构造假响应。
 *
 * @returns {any} 响应。
 */
function fakeResponse() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body ?? '';
    },
  };
}

/** 基础假控制器。 */
function fakeController() {
  return {
    async panelState() {
      return { mode: 'hybrid', appServer: { state: 'stopped' } };
    },
    async panelSessions() {
      return { sessions: [{ threadId: 't1', title: '会话' }], total: 1 };
    },
    setMode(mode) {
      return { mode, modeLabel: '直控会话' };
    },
    async bindThread(threadId) {
      return { threadId, title: '会话' };
    },
    setWorkspace(workspaceRoot) {
      return { workspaceRoot };
    },
    browseDirectory(options) {
      return { path: options?.path ?? 'C:\\Users\\me', parent: null, entries: [], drives: ['C:\\'], error: null };
    },
  };
}

test('GET /state 返回面板状态', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const response = fakeResponse();
  await routes.handler(fakeRequest('GET', `${ROUTE_PREFIX}/state`), response);
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(response.body), { mode: 'hybrid', appServer: { state: 'stopped' } });
});

test('GET /sessions 传递 all/limit', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const response = fakeResponse();
  await routes.handler(fakeRequest('GET', `${ROUTE_PREFIX}/sessions?all=1&limit=5`), response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).total, 1);
});

test('POST /mode 切换方式并回传 state', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const response = fakeResponse();
  await routes.handler(fakeRequest('POST', `${ROUTE_PREFIX}/mode`, { mode: 'direct' }), response);
  assert.equal(response.status, 200);
  const body = JSON.parse(response.body);
  assert.equal(body.mode, 'direct');
  assert.equal(body.state.mode, 'hybrid');
});

test('POST /bind 绑定默认会话', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const response = fakeResponse();
  await routes.handler(fakeRequest('POST', `${ROUTE_PREFIX}/bind`, { threadId: '01a18310' }), response);
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).binding.threadId, '01a18310');
});

test('未知路由 404，控制器异常 500', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const notFound = fakeResponse();
  await routes.handler(fakeRequest('GET', `${ROUTE_PREFIX}/nope`), notFound);
  assert.equal(notFound.status, 404);

  const failing = fakeController();
  failing.panelState = async () => {
    throw new Error('boom');
  };
  const routes2 = setup(failing, warnings);
  const failed = fakeResponse();
  await routes2.handler(fakeRequest('GET', `${ROUTE_PREFIX}/state`), failed);
  assert.equal(failed.status, 500);
  assert.match(JSON.parse(failed.body).error, /boom/u);
});

test('POST /workspace 保存工作区，GET /fs 浏览目录', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const saved = fakeResponse();
  await routes.handler(fakeRequest('POST', `${ROUTE_PREFIX}/workspace`, { workspaceRoot: 'D:\\project' }), saved);
  assert.equal(saved.status, 200);
  assert.equal(JSON.parse(saved.body).workspaceRoot, 'D:\\project');

  const listing = fakeResponse();
  await routes.handler(fakeRequest('GET', `${ROUTE_PREFIX}/fs?path=D%3A%5Cproject`), listing);
  assert.equal(listing.status, 200);
  const body = JSON.parse(listing.body);
  assert.equal(body.path, 'D:\\project');
  assert.deepEqual(body.drives, ['C:\\']);
});

test('client-error 记录告警并返回 200', async () => {
  const warnings = [];
  const routes = setup(fakeController(), warnings);
  const response = fakeResponse();
  await routes.handler(fakeRequest('POST', `${ROUTE_PREFIX}/client-error`, { scope: 'render', message: 'crash' }), response);
  assert.equal(response.status, 200);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /crash/u);
});
