/**
 * Codex app-server 的 JSON-RPC 客户端。
 *
 * 协议是「每行一个 JSON 对象」：请求带 `id`，响应带同一个 `id`；通知只有
 * `method`；服务端也会反向发起请求（审批、用户输入等），客户端必须应答，
 * 否则 Codex 会一直等下去。
 *
 * 这个模块不关心 Codex 语义，只做分帧、关联、超时、取消与分发，便于单测。
 *
 * @module dsh-plugin-codex-link/rpc-client
 */

/** 请求超时。`code` 固定为 `RPC_TIMEOUT`。 */
export class RpcTimeoutError extends Error {
  /**
   * @param {string} method 超时的方法名。
   * @param {number} timeoutMs 超时时间。
   */
  constructor(method, timeoutMs) {
    super(`Codex 请求超时（${method}，${timeoutMs}ms）`);
    this.name = 'RpcTimeoutError';
    this.code = 'RPC_TIMEOUT';
    this.method = method;
  }
}

/** 连接已关闭。`code` 固定为 `APP_SERVER_UNAVAILABLE`。 */
export class RpcClosedError extends Error {
  /**
   * @param {string} [reason] 关闭原因。
   */
  constructor(reason = 'Codex app-server 连接已关闭') {
    super(reason);
    this.name = 'RpcClosedError';
    this.code = 'APP_SERVER_UNAVAILABLE';
  }
}

/** app-server 返回的 JSON-RPC 错误。 */
export class RpcRemoteError extends Error {
  /**
   * @param {string} method 方法名。
   * @param {{ code?: number, message?: string, data?: unknown }} error RPC 错误体。
   */
  constructor(method, error) {
    super(`${method} 失败：${error?.message ?? '未知 RPC 错误'}`);
    this.name = 'RpcRemoteError';
    this.code = 'RPC_ERROR';
    this.method = method;
    this.data = error?.data;
    this.rpcCode = error?.code;
  }
}

/**
 * 创建一个基于可读/可写流（或任意 `write`/事件源）的 RPC 会话。
 *
 * `readable` 需要实现 Node 可读流接口（`on('data')`、`on('end')`、`on('error')`），
 * 测试里可以直接用 `PassThrough`。
 *
 * @param {{
 *   readable: import('node:stream').Readable,
 *   writable: { write: (chunk: string) => unknown },
 *   defaultTimeoutMs?: number,
 *   logger?: { warn?: Function, debug?: Function } | null,
 * }} options 依赖注入。
 * @returns {{
 *   request: (method: string, params?: unknown, options?: { timeoutMs?: number, signal?: AbortSignal }) => Promise<any>,
 *   notify: (method: string, params?: unknown) => void,
 *   on: (method: string, handler: (params: any) => void) => () => void,
 *   onAny: (handler: (method: string, params: any) => void) => () => void,
 *   setServerRequestHandler: (handler: ((request: { id: unknown, method: string, params: any }) => Promise<unknown> | unknown) | null) => void,
 *   close: (reason?: string) => void,
 *   readonly closed: boolean,
 * }} RPC 会话句柄。
 */
export function createRpcSession(options) {
  const { readable, writable } = options;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? 30_000;
  const logger = options.logger ?? null;

  /** @type {Map<number | string, { method: string, resolve: Function, reject: Function, timer: ReturnType<typeof setTimeout>, cleanup?: () => void }>} */
  const pending = new Map();
  /** @type {Map<string, Set<(params: any) => void>>} */
  const methodHandlers = new Map();
  /** @type {Set<(method: string, params: any) => void>} */
  const anyHandlers = new Set();

  /** @type {((request: { id: unknown, method: string, params: any }) => Promise<unknown> | unknown) | null} */
  let serverRequestHandler = null;
  let closed = false;
  let buffer = '';
  let nextId = 2;

  /**
   * 把对象按一行 JSON 写出去。
   *
   * @param {unknown} message 要写的消息。
   */
  function send(message) {
    if (closed) return;
    try {
      writable.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      logger?.warn?.(`[codex-link] 写入 app-server 失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 构造 JSON-RPC 错误响应。
   *
   * @param {unknown} id 请求 id。
   * @param {number} code 错误码。
   * @param {string} message 错误文本。
   */
  function sendError(id, code, message) {
    send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  /**
   * 处理一条完整消息。
   *
   * @param {any} message 解析后的 JSON 对象。
   */
  function dispatch(message) {
    if (message === null || typeof message !== 'object') return;

    // 服务端请求：同时带 id 与 method。
    if (message.id !== undefined && typeof message.method === 'string') {
      const request = { id: message.id, method: message.method, params: message.params };
      if (serverRequestHandler === null) {
        sendError(message.id, -32601, `未处理的客户端请求：${message.method}`);
        return;
      }
      Promise.resolve()
        .then(() => serverRequestHandler(request))
        .then((result) => {
          if (result !== null && typeof result === 'object' && 'error' in result) {
            send({ jsonrpc: '2.0', id: message.id, error: result.error });
            return;
          }
          send({ jsonrpc: '2.0', id: message.id, result: result ?? {} });
        })
        .catch((error) => {
          logger?.warn?.(`[codex-link] 应答 ${message.method} 失败：${error instanceof Error ? error.message : String(error)}`);
          sendError(message.id, -32603, '内部错误');
        });
      return;
    }

    // 响应。
    if (message.id !== undefined && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const entry = pending.get(message.id);
      if (entry === undefined) {
        logger?.debug?.(`[codex-link] 收到未知 id 的响应：${String(message.id)}`);
        return;
      }
      pending.delete(message.id);
      clearTimeout(entry.timer);
      entry.cleanup?.();
      if (Object.hasOwn(message, 'error')) {
        entry.reject(new RpcRemoteError(entry.method, message.error ?? {}));
      } else {
        entry.resolve(message.result);
      }
      return;
    }

    // 通知：只有 method。
    if (typeof message.method === 'string') {
      const params = message.params;
      for (const handler of anyHandlers) {
        try {
          handler(message.method, params);
        } catch (error) {
          logger?.warn?.(`[codex-link] 通知处理失败（${message.method}）：${error instanceof Error ? error.message : String(error)}`);
        }
      }
      const handlers = methodHandlers.get(message.method);
      if (handlers !== undefined) {
        for (const handler of handlers) {
          try {
            handler(params);
          } catch (error) {
            logger?.warn?.(`[codex-link] 通知处理失败（${message.method}）：${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  /**
   * 追加原始数据并切分完整的行。
   *
   * @param {string} chunk 新到的数据。
   */
  function feed(chunk) {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === '') continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        logger?.warn?.(`[codex-link] 无法解析 app-server 输出：${line.slice(0, 200)}`);
        continue;
      }
      dispatch(message);
    }
  }

  readable.setEncoding?.('utf8');
  readable.on('data', (chunk) => feed(String(chunk)));
  readable.on('error', (error) => {
    close(`app-server 读取失败：${error instanceof Error ? error.message : String(error)}`);
  });
  readable.on('end', () => {
    close('app-server 已退出');
  });

  /**
   * 关闭会话并让所有在途请求失败。
   *
   * @param {string} [reason] 关闭原因。
   */
  function close(reason = 'Codex app-server 连接已关闭') {
    if (closed) return;
    closed = true;
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.cleanup?.();
      entry.reject(new RpcClosedError(reason));
    }
  }

  /**
   * 发起一个请求。
   *
   * @param {string} method 方法名。
   * @param {unknown} [params] 参数。
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [requestOptions] 请求选项。
   * @returns {Promise<any>} 响应结果。
   */
  function request(method, params, requestOptions = {}) {
    if (closed) return Promise.reject(new RpcClosedError());
    const timeoutMs = requestOptions.timeoutMs ?? defaultTimeoutMs;
    const signal = requestOptions.signal;
    const id = nextId;
    nextId += 1;

    return new Promise((resolve, reject) => {
      /**
       * 清理取消监听。
       */
      function cleanup() {
        if (signal !== undefined) signal.removeEventListener('abort', onAbort);
      }
      /**
       * 取消请求。
       */
      function onAbort() {
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        clearTimeout(entry.timer);
        cleanup();
        const error = new Error(`请求已取消（${method}）`);
        error.code = 'ABORTED';
        error.name = 'AbortError';
        reject(error);
      }

      const timer = setTimeout(() => {
        const entry = pending.get(id);
        if (entry === undefined) return;
        pending.delete(id);
        cleanup();
        reject(new RpcTimeoutError(method, timeoutMs));
      }, timeoutMs);

      pending.set(id, { method, resolve, reject, timer, cleanup });
      if (signal?.aborted === true) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  /**
   * 发送一个通知（不期待响应）。
   *
   * @param {string} method 方法名。
   * @param {unknown} [params] 参数。
   */
  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params });
  }

  return {
    request,
    notify,
    /**
     * 订阅指定通知。
     *
     * @param {string} method 通知方法名。
     * @param {(params: any) => void} handler 处理函数。
     * @returns {() => void} 取消订阅。
     */
    on(method, handler) {
      let handlers = methodHandlers.get(method);
      if (handlers === undefined) {
        handlers = new Set();
        methodHandlers.set(method, handlers);
      }
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    /**
     * 订阅所有通知。
     *
     * @param {(method: string, params: any) => void} handler 处理函数。
     * @returns {() => void} 取消订阅。
     */
    onAny(handler) {
      anyHandlers.add(handler);
      return () => anyHandlers.delete(handler);
    },
    /**
     * 设置服务端请求的处理函数；返回 `{ error }` 会作为 JSON-RPC 错误应答。
     *
     * @param {((request: { id: unknown, method: string, params: any }) => Promise<unknown> | unknown) | null} handler 处理函数。
     */
    setServerRequestHandler(handler) {
      serverRequestHandler = handler;
    },
    close,
    /**
     * 是否已关闭。
     *
     * @returns {boolean} 关闭状态。
     */
    get closed() {
      return closed;
    },
  };
}
