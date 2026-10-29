/**
 * dsh-plugin-codex-link — Cordis Host 插件入口。
 *
 * 装配顺序：
 *   配置 → 事件注册表 → Codex app-server 客户端 → 审批应答 → 绑定存储 →
 *   控制器 → 工具注册 → system prompt 指南 → 卸载清理。
 *
 * 设计取舍：插件只依赖 Node 内置模块与 DSH 提供的 `ctx.tools` 服务，不 import
 * 任何 @deepseek-ai/* 包，避免 profile 的 peer 依赖在加载期出问题。
 *
 * @module dsh-plugin-codex-link
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { describeConfig, resolveConfig } from './config.js';
import { CodexAppServer } from './app-server.js';
import { codexHome, resolveCodexBinary } from './codex-binary.js';
import { createThreadRegistry } from './events.js';
import {
  ThreadError,
  ensureDefaultThread,
  interruptThread,
  listThreads,
  matchThreadRef,
  readTurn,
  sendInstruction,
  startThread,
  summarizeThread,
} from './threads.js';
import { BindingsStore } from './bindings.js';
import { MODES, describeMode, resolveMode, resolveTaskChannel } from './modes.js';
import { TaskError, TaskRunner } from './task.js';
import { UiStore } from './ui-store.js';
import { defaultHome, isDirectoryPath, listDirectory, resolveWorkspaceRoot } from './workspace.js';
import { queueMessage } from './queue-bridge.js';
import { RolloutTail } from './rollout-tail.js';
import { buildToolSpecs } from './tools.js';
import { guideText } from './prompt.js';

/** Cordis 插件名，同时作为服务/行 id。 */
export const name = 'dsh-plugin-codex-link';

/** 只依赖工具服务；缺失时插件保持 pending，避免在无工具环境里空转。 */
export const inject = ['tools'];

/** UUID 形状的会话 ID。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** 绑定文件里记录「默认会话」的保留键（避免每次重新搜索导致重复新建）。 */
const DEFAULT_THREAD_KEY = '__default__';

/**
 * 设置页路由的诊断日志路径：`<DSH_HOME>/codex-link/route.log`。
 *
 * 宿主控制台日志在桌面端不易查看，注册成功/失败写一个追加文件，
 * 面板 404 时可以直接据此判断是「没注册」还是「路径不匹配」。
 *
 * @returns {string} 日志路径。
 */
function routeLogPath() {
  const home =
    typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
      ? process.env.DSH_HOME.trim()
      : join(homedir(), '.dsh');
  return join(home, 'codex-link', 'route.log');
}

/**
 * 追加一行路由诊断日志；失败不影响插件。
 *
 * @param {string} message 日志内容。
 */
function recordRouteLog(message) {
  try {
    const file = routeLogPath();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${new Date().toISOString()} ${message}\n`, 'utf8');
  } catch {
    /* 诊断日志失败不能影响插件 */
  }
}

/** 需要应答的审批请求方法。 */
const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'applyPatchApproval',
  'execCommandApproval',
]);

/**
 * 相对时间描述。
 *
 * @param {number | null} unixSeconds Unix 秒。
 * @returns {string} 相对时间。
 */
function relativeTime(unixSeconds) {
  if (typeof unixSeconds !== 'number' || unixSeconds <= 0) return '未知';
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (deltaSeconds < 60) return '刚刚';
  if (deltaSeconds < 3600) return `${Math.floor(deltaSeconds / 60)} 分钟前`;
  if (deltaSeconds < 86_400) return `${Math.floor(deltaSeconds / 3600)} 小时前`;
  return `${Math.floor(deltaSeconds / 86_400)} 天前`;
}

/**
 * 本地时间字符串。
 *
 * @param {number | null} unixSeconds Unix 秒。
 * @returns {string} 本地时间。
 */
function localTime(unixSeconds) {
  if (typeof unixSeconds !== 'number' || unixSeconds <= 0) return '未知';
  return new Date(unixSeconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 会话 ID 的短形式。
 *
 * @param {string} id 会话 ID。
 * @returns {string} 前 8 位。
 */
function shortId(id) {
  return typeof id === 'string' ? id.slice(0, 8) : '????';
}

/**
 * 构造控制器：工具层只调这里，控制器再落到 app-server / 注册表 / 绑定。
 *
 * @param {{
 *   settings: ReturnType<typeof resolveConfig>,
 *   appServer: CodexAppServer,
 *   registry: ReturnType<typeof createThreadRegistry>,
 *   bindings: BindingsStore,
 *   uiStore: UiStore,
 *   taskRunner: TaskRunner,
 *   sessionCwdOf: (sessionId: string) => string | null,
 *   logger: any,
 * }} dependencies 依赖。
 * @returns {Record<string, Function>} 控制器方法。
 */
function createController({ settings, appServer, registry, bindings, uiStore, taskRunner, sessionCwdOf, logger }) {
  /** @type {{ path: string, version: string, source: string } | null} */
  let binaryCache = null;
  /** @type {{ threads: Array<any>, at: number } | null} */
  let recentCache = null;
  /**
   * queue 回退通道的在途状态：threadId → 读取器与结果。
   *
   * @type {Map<string, any>}
   */
  const queueFallbacks = new Map();
  const RECENT_TTL_MS = 5 * 60_000;

  /**
   * 目标会话被桌面端占用时，用官方 `codex queue` 投递，并从 rollout 读结果。
   *
   * @param {any} thread 目标会话摘要。
   * @param {string} text 指令原文。
   * @returns {Promise<string>} 面向用户的说明文本。
   */
  async function startQueueFallback(thread, text) {
    const binary = await binaryInfo();
    const tail = new RolloutTail({
      sessionsRoot: join(codexHome(), 'sessions'),
      threadId: thread.id,
      logger,
    });
    if (!tail.ensureLocated()) {
      throw new ThreadError(
        'THREAD_NOT_FOUND',
        `会话「${thread.title}」被 Codex 占用，且找不到它的 rollout 记录，无法走 queue 回退。`,
      );
    }
    tail.startAtEnd();
    const queued = await queueMessage({ binaryPath: binary.path, threadId: thread.id, text, logger });
    queueFallbacks.set(thread.id, {
      tail,
      messageId: queued.messageId,
      startedAt: Date.now(),
      running: true,
      completed: null,
      usage: null,
      threadTitle: thread.title,
    });
    const entry = queueFallbacks.get(thread.id);
    return {
      entry,
      text: [
        `会话「${thread.title}」正被 Codex 桌面端占用，已改用官方 queue 投递（消息 ${queued.messageId === null ? '未知' : queued.messageId}）。`,
        '消息会出现在你打开的 Codex 对话里；用 codex_watch 跟踪过程、codex_result 取结果。',
      ].join('\n'),
    };
  }

  /**
   * 轮询一次 queue 回退通道。
   *
   * @param {any} entry queue 回退状态。
   * @returns {{ events: Array<{ kind: string, text: string }>, completed: any, running: boolean, usage: any }} 增量。
   */
  function pollQueueFallback(entry) {
    const slice = entry.tail.poll();
    if (slice.usage !== null && slice.usage !== undefined) entry.usage = slice.usage;
    if (slice.completed !== null && slice.completed !== undefined) {
      entry.completed = slice.completed;
      entry.running = false;
    } else if (slice.events.length > 0) {
      entry.running = true;
    }
    return slice;
  }

  /**
   * 解析当前生效的工作区。
   *
   * 优先级：配置 → 设置页覆盖 → 当前 DSH 会话目录 → 用户主目录。
   * 前面不存在时逐级回退，保证其他机器上零配置也能用。
   *
   * @param {string} [sessionId] DSH 会话 ID（工具调用时传入）。
   * @returns {ReturnType<typeof resolveWorkspaceRoot>} 生效工作区。
   */
  function workspaceFor(sessionId) {
    const sessionCwd = typeof sessionCwdOf === 'function' ? sessionCwdOf(sessionId ?? '') : null;
    return resolveWorkspaceRoot({
      configured: settings.workspaceRoot,
      override: uiStore.getWorkspaceRoot(),
      sessionCwd,
      home: defaultHome(),
    });
  }

  /**
   * 把生效工作区套进 settings，供 threads 模块直接使用。
   *
   * @param {string} [sessionId] DSH 会话 ID。
   * @returns {ReturnType<typeof resolveConfig>} 使用生效工作区的设置。
   */
  function workspaceSettings(sessionId) {
    return { ...settings, workspaceRoot: workspaceFor(sessionId).path };
  }

  /**
   * 取 Codex 可执行文件信息（带缓存）。
   *
   * @returns {Promise<{ path: string, version: string, source: string }>} 可执行文件信息。
   */
  async function binaryInfo() {
    if (binaryCache === null) binaryCache = resolveCodexBinary({ configuredPath: settings.codexPath });
    return binaryCache;
  }

  /**
   * 最近一次列举的会话（供序号/前缀匹配）。
   *
   * @param {string} [sessionId] DSH 会话 ID，用于解析工作区。
   * @returns {Promise<Array<any>>} 会话摘要。
   */
  async function recentThreads(sessionId) {
    if (recentCache !== null && Date.now() - recentCache.at < RECENT_TTL_MS) return recentCache.threads;
    const threads = await listThreads(appServer, { cwd: workspaceFor(sessionId).path, limit: 50 });
    recentCache = { threads, at: Date.now() };
    return threads;
  }

  /**
   * 按用户引用解析出目标会话。
   *
   * @param {string} ref 引用文本。
   * @param {string} [sessionId] DSH 会话 ID，用于解析工作区。
   * @returns {Promise<any>} 会话摘要。
   */
  async function resolveRef(ref, sessionId) {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (raw === '') throw new ThreadError('EMPTY_REF', '没有指定 Codex 会话引用');

    if (UUID_PATTERN.test(raw)) {
      return { id: raw, title: raw.slice(0, 8), preview: '', cwd: '', status: 'unknown', updatedAt: null, archived: false };
    }

    if (/^\d+$/u.test(raw)) {
      const threads = await recentThreads(sessionId);
      const result = matchThreadRef(threads, raw);
      if (result.thread !== undefined) return result.thread;
      throw new ThreadError('THREAD_NOT_FOUND', `序号 ${raw} 超出范围；先用 codex_threads 查看列表。`);
    }

    let result = matchThreadRef(await listThreads(appServer, { limit: 50 }), raw);
    if (result.thread === undefined && result.candidates.length === 0) {
      const searched = await listThreads(appServer, { limit: 50, query: raw });
      result = matchThreadRef(searched, raw);
    }
    if (result.thread !== undefined) return result.thread;
    if (result.candidates.length > 1) {
      const names = result.candidates.slice(0, 8).map((thread) => `[${shortId(thread.id)}] ${thread.title}`).join('；');
      throw new ThreadError('AMBIGUOUS_THREAD', `匹配到 ${result.candidates.length} 个会话：${names}。请用序号或完整 ID 再试。`, {
        candidates: result.candidates,
      });
    }
    throw new ThreadError('THREAD_NOT_FOUND', `找不到会话「${raw}」。先用 codex_threads 查看可用会话。`);
  }

  /**
   * 取得工具调用应操作的目标会话。
   *
   * @param {string} sessionId DSH 会话 ID。
   * @param {{ thread?: string, create?: boolean }} [options] 请求选项。
   * @returns {Promise<any>} 会话摘要。
   */
  async function targetThread(sessionId, options = {}) {
    if (options.create === true) {
      const thread = await startThread(appServer, workspaceSettings(sessionId), {});
      bindings.set(sessionId, { threadId: thread.id, threadTitle: thread.title });
      return thread;
    }
    if (typeof options.thread === 'string' && options.thread.trim() !== '') {
      return resolveRef(options.thread, sessionId);
    }
    const binding = bindings.get(sessionId);
    if (binding !== null) {
      return {
        id: binding.threadId,
        title: binding.threadTitle === '' ? binding.threadId.slice(0, 8) : binding.threadTitle,
        preview: '',
        cwd: workspaceFor(sessionId).path,
        status: 'unknown',
        updatedAt: null,
        archived: false,
      };
    }
    const knownDefault = bindings.get(DEFAULT_THREAD_KEY);
    const thread = await ensureDefaultThread(appServer, workspaceSettings(sessionId), logger, {
      knownThreadId: knownDefault === null ? null : knownDefault.threadId,
    });
    bindings.set(DEFAULT_THREAD_KEY, { threadId: thread.id, threadTitle: thread.title });
    bindings.set(sessionId, { threadId: thread.id, threadTitle: thread.title });
    return thread;
  }

  /**
   * 轮询等待某个回合完成。
   *
   * @param {string} threadId 会话 ID。
   * @param {string | null} turnId 回合 ID。
   * @returns {Promise<any>} 回合摘要。
   */
  async function waitTurn(threadId, turnId) {
    const deadline = Date.now() + settings.requestTimeoutMs;
    for (;;) {
      const state = registry.stateOf(threadId);
      if (state !== null && state.lastTurn !== null) {
        if (turnId === null || state.lastTurn.turnId === turnId) return state.lastTurn;
      }
      if (Date.now() >= deadline) {
        throw new ThreadError('TURN_TIMEOUT', `等待回合完成超时（${settings.requestTimeoutMs}ms）；可继续 codex_watch 或 codex_interrupt。`);
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 300).unref?.();
      });
    }
  }

  /**
   * 格式化会话列表。
   *
   * @param {Array<any>} threads 会话摘要。
   * @param {string} header 标题。
   * @returns {string} 文本。
   */
  function formatThreads(threads, header) {
    if (threads.length === 0) return `${header}\n（没有找到会话）`;
    const lines = threads.map((thread, index) => {
      const state = registry.stateOf(thread.id);
      const status = state?.status ?? thread.status;
      return [
        `${index + 1}. [${shortId(thread.id)}] ${thread.title}`,
        `   状态=${status}`,
        thread.cwd === '' ? '' : `目录=${thread.cwd}`,
        thread.updatedAt === null ? '' : `更新=${relativeTime(thread.updatedAt)}`,
      ]
        .filter((part) => part !== '')
        .join(' ');
    });
    return [header, ...lines].join('\n');
  }

  /**
   * 格式化额度窗口。
   *
   * @param {any} window Codex 返回的窗口对象。
   * @returns {string} 文本。
   */
  function formatWindow(window) {
    if (window === null || typeof window !== 'object') return '不可用';
    const used = typeof window.usedPercent === 'number' ? window.usedPercent : null;
    if (used === null) return '不可用';
    const remaining = Math.max(0, 100 - used);
    const resetAt = typeof window.resetsAt === 'number' ? window.resetsAt : null;
    const etaSeconds = resetAt === null ? null : Math.max(0, resetAt - Math.floor(Date.now() / 1000));
    const eta =
      etaSeconds === null
        ? ''
        : etaSeconds >= 3600
          ? `（约 ${Math.floor(etaSeconds / 3600)} 小时 ${Math.floor((etaSeconds % 3600) / 60)} 分后）`
          : `（约 ${Math.max(1, Math.floor(etaSeconds / 60))} 分后）`;
    return `已用 ${used}%，剩余 ${remaining}%，重置 ${localTime(resetAt)}${eta}`;
  }

  /**
   * 当前生效的操作方式 id。
   *
   * @returns {string} 模式 id。
   */
  function currentMode() {
    return resolveMode(uiStore.getMode(), settings.mode);
  }

  /**
   * 组装设置页需要的全局状态。
   *
   * @returns {Promise<any>} 可 JSON 序列化的面板状态。
   */
  async function buildPanelState() {
    const mode = currentMode();
    let binary = null;
    let binaryError = null;
    try {
      const info = await binaryInfo();
      binary = { path: info.path, version: info.version, source: info.source };
    } catch (error) {
      binaryError = error instanceof Error ? error.message : String(error);
    }
    const defaultBinding = bindings.get(DEFAULT_THREAD_KEY);
    const workspace = workspaceFor('');
    return {
      mode,
      modeLabel: describeMode(mode).label,
      modes: MODES.map((item) => ({ ...item, active: item.id === mode })),
      binding:
        defaultBinding === null
          ? null
          : { threadId: defaultBinding.threadId, title: defaultBinding.threadTitle, updatedAt: defaultBinding.updatedAt },
      workspace: {
        effective: workspace.path,
        source: workspace.source,
        configured: settings.workspaceRoot,
        override: uiStore.getWorkspaceRoot(),
        home: defaultHome(),
        candidates: workspace.candidates,
      },
      workspaceRoot: workspace.path,
      defaultThreadName: settings.defaultThreadName,
      sandbox: settings.sandbox,
      approvals: settings.approvals,
      appServer: { state: appServer.state, activeTasks: taskRunner.activeCount },
      binary,
      binaryError,
    };
  }

  /**
   * 列出设置页可选的 Codex 会话。
   *
   * @param {{ limit?: number, all?: boolean }} [options] 过滤条件。
   * @returns {Promise<any>} 会话列表与当前绑定。
   */
  async function listPanelSessions(options = {}) {
    const limit = Number.isSafeInteger(options.limit) ? Math.min(Math.max(options.limit, 1), 100) : 50;
    const showAll = options.all === true;
    const workspace = workspaceFor('');
    const sessions = await listThreads(appServer, { cwd: showAll ? undefined : workspace.path, limit });
    const defaultBinding = bindings.get(DEFAULT_THREAD_KEY);
    return {
      sessions: sessions.map((thread) => ({
        threadId: thread.id,
        title: thread.title,
        cwd: thread.cwd,
        status: thread.status,
        updatedAt: thread.updatedAt,
      })),
      total: sessions.length,
      workspaceRoot: workspace.path,
      workspaceSource: workspace.source,
      scope: showAll ? 'all' : 'workspace',
      currentThreadId: defaultBinding === null ? null : defaultBinding.threadId,
    };
  }

  /**
   * 设置页切换操作方式。
   *
   * @param {string} mode 模式 id。
   * @returns {{ mode: string, modeLabel: string }} 生效后的模式。
   */
  function applyPanelMode(mode) {
    const next = uiStore.setMode(mode);
    logger.info?.(`[codex-link] 操作方式切换为：${describeMode(next).label}`);
    return { mode: next, modeLabel: describeMode(next).label };
  }

  /**
   * 设置页选择工作区；空串表示恢复自动。
   *
   * @param {string} workspaceRoot 目录路径。
   * @returns {{ workspaceRoot: string }} 生效后的覆盖值。
   */
  function applyPanelWorkspace(workspaceRoot) {
    const next = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
    if (next !== '' && !isDirectoryPath(next)) {
      throw new ThreadError('WORKSPACE_NOT_FOUND', `目录不存在或不可访问：${next}`);
    }
    const saved = uiStore.setWorkspaceRoot(next);
    recentCache = null;
    logger.info?.(`[codex-link] 设置页工作区：${saved === '' ? '恢复自动' : saved}`);
    return { workspaceRoot: saved };
  }

  /**
   * 设置页把某个会话设为默认目标（全局），并同步进当前 DSH 会话绑定。
   *
   * @param {string} threadId 会话 ID。
   * @returns {Promise<{ threadId: string, title: string }>} 绑定结果。
   */
  async function applyDefaultThread(threadId) {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    if (id === '') throw new ThreadError('THREAD_NOT_FOUND', '没有选择 Codex 会话');
    const threads = await listThreads(appServer, { limit: 100 });
    const matched = threads.find((thread) => thread.id === id);
    const title = matched === undefined ? id.slice(0, 8) : matched.title;
    bindings.set(DEFAULT_THREAD_KEY, { threadId: id, threadTitle: title });
    recentCache = null;
    logger.info?.(`[codex-link] 默认会话设置为：${title}（${id}）`);
    return { threadId: id, title };
  }

  return {
    /**
     * 连接与配置状态。
     *
     * @returns {Promise<string>} 文本。
     */
    async status(sessionId) {
      let binaryText;
      try {
        const binary = await binaryInfo();
        binaryText = `${binary.path}（${binary.version === '' ? '版本未知' : binary.version}，来源 ${binary.source}）`;
      } catch (error) {
        binaryText = `不可用：${error instanceof Error ? error.message : String(error)}`;
      }
      const mode = currentMode();
      const workspace = workspaceFor(sessionId);
      const lines = [
        `操作方式：${describeMode(mode).label}（${mode}）`,
        `工作区：${workspace.path}（来源=${workspace.source}${settings.workspaceRoot === '' ? '，配置为自动' : ''}）`,
        `Codex app-server：${appServer.state}`,
        `Codex 可执行文件：${binaryText}`,
        `配置：${describeConfig(settings)}`,
      ];
      if (taskRunner.activeCount > 0) lines.push(`运行中的子任务：${taskRunner.activeCount}`);
      if (appServer.stderrTail.length > 0) {
        lines.push(`最近 stderr：${appServer.stderrTail.slice(-2).join(' | ').slice(0, 400)}`);
      }
      const rateLimits = registry.getRateLimits();
      if (rateLimits !== null) lines.push('最近额度通知：已缓存（可用 codex_usage 查询最新）');
      return lines.join('\n');
    },

    /**
     * 列出会话。
     *
     * @param {{ query?: string, limit?: number, all?: boolean }} args 参数。
     * @param {string} [sessionId] DSH 会话 ID，用于解析工作区。
     * @returns {Promise<string>} 文本。
     */
    async threads(args, sessionId) {
      const limit = Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 15;
      const showAll = args.all === true;
      const workspace = workspaceFor(sessionId);
      const threads = await listThreads(appServer, {
        cwd: showAll ? undefined : workspace.path,
        query: typeof args.query === 'string' ? args.query : undefined,
        limit,
      });
      if (!showAll) recentCache = { threads, at: Date.now() };
      return formatThreads(
        threads,
        showAll
          ? `Codex 会话（全部，共 ${threads.length} 条）`
          : `Codex 会话（工作区 ${workspace.path}，共 ${threads.length} 条）`,
      );
    },

    /**
     * 切换绑定。
     *
     * @param {{ thread?: string, create?: boolean }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async use(args, sessionId) {
      const thread = await targetThread(sessionId, { thread: args.thread, create: args.create === true });
      bindings.set(sessionId, { threadId: thread.id, threadTitle: thread.title });
      if (recentCache !== null && !recentCache.threads.some((item) => item.id === thread.id)) recentCache = null;
      return `已绑定 Codex 会话：${thread.title}（id=${thread.id}，短 ID=${shortId(thread.id)}）。之后 codex_send 默认发到这个会话。`;
    },

    /**
     * 发送指令。
     *
     * @param {{ text: string, thread?: string, mode?: string, wait?: boolean }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async send(args, sessionId) {
      const thread = await targetThread(sessionId, { thread: args.thread });
      const text = typeof args.text === 'string' ? args.text : '';
      let result;
      try {
        result = await sendInstruction(appServer, registry, workspaceSettings(sessionId), {
          threadId: thread.id,
          text,
          mode: args.mode === 'steer' || args.mode === 'interrupt' ? args.mode : 'auto',
        });
      } catch (error) {
        // 直控目标被桌面端占用（active writer）：改走官方 queue 回退。
        if (settings.queueFallback && error?.code === 'BUSY_THREAD') {
          const fallback = await startQueueFallback(thread, text);
          return fallback.text;
        }
        throw error;
      }
      const header =
        result.mode === 'interrupt'
          ? `已中止会话「${thread.title}」的回合 ${shortId(result.turnId ?? '')}。`
          : `已发送到 Codex 会话「${thread.title}」（id=${thread.id}，turn=${shortId(result.turnId ?? '')}，方式=${result.mode}）。`;
      if (args.wait !== true) return `${header}\n用 codex_watch 跟踪过程，codex_result 取结果。`;
      const lastTurn = await waitTurn(thread.id, result.turnId);
      return [
        header,
        `状态=${lastTurn.status} 耗时=${lastTurn.durationMs === null ? '未知' : `${lastTurn.durationMs}ms`}`,
        lastTurn.finalText === '' ? '（没有文本回答）' : `回答：\n${lastTurn.finalText}`,
      ].join('\n');
    },

    /**
     * 增量读取过程。
     *
     * @param {{ thread?: string, cursor?: string, waitMs?: number, detail?: string }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async watch(args, sessionId) {
      const thread = await targetThread(sessionId, { thread: args.thread });
      const detail = args.detail === 'full' ? 'full' : 'summary';
      const waitMs = Number.isSafeInteger(args.waitMs)
        ? Math.min(Math.max(args.waitMs, 0), settings.watchMaxWaitMs)
        : settings.watchDefaultWaitMs;

      // queue 回退通道：过程与结果从 rollout 增量读取。
      const queueEntry = queueFallbacks.get(thread.id);
      if (queueEntry !== undefined) {
        const deadline = Date.now() + waitMs;
        /** @type {Array<{ kind: string, text: string }>} */
        const collected = [];
        while (Date.now() < deadline) {
          const slice = pollQueueFallback(queueEntry);
          collected.push(...slice.events);
          if (queueEntry.completed !== null || collected.length > 0) break;
          await new Promise((resolve) => {
            setTimeout(resolve, 250).unref?.();
          });
        }
        const status = queueEntry.completed !== null ? 'completed' : queueEntry.running ? 'running' : 'queued';
        const header = `会话「${thread.title}」状态=${status}（queue 通道，消息 ${queueEntry.messageId ?? '未知'}）`;
        const body =
          collected.length === 0 ? '（暂无新事件）' : collected.map((event) => `[${event.kind}] ${event.text}`).join('\n');
        const footer =
          queueEntry.completed === null
            ? ''
            : `\n回合已结束；用 codex_result 取最终回答。`;
        return `${header}\n${body}${footer}`;
      }

      const cursor = typeof args.cursor === 'string' ? args.cursor : undefined;
      const deadline = Date.now() + waitMs;
      let slice = registry.eventsSince(thread.id, cursor, { detail, limit: 100 });
      while (slice.events.length === 0 && slice.threadState?.status === 'active' && Date.now() < deadline) {
        await new Promise((resolve) => {
          setTimeout(resolve, 250).unref?.();
        });
        slice = registry.eventsSince(thread.id, cursor, { detail, limit: 100 });
      }

      const state = registry.stateOf(thread.id);
      const header = [
        `会话「${thread.title}」状态=${state?.status ?? 'unknown'}`,
        `游标=${slice.cursor}`,
        slice.stale ? '旧游标来自上一个插件实例，已从可用事件重新开始。' : '',
        slice.truncated ? '缓冲曾溢出，早期事件已丢弃。' : '',
        slice.hasMore ? '还有更多事件，继续用同一游标调用即可。' : '',
      ]
        .filter((part) => part !== '')
        .join(' ');

      const body =
        slice.events.length === 0
          ? '（暂无新事件）'
          : slice.events.map((event) => `[${event.kind}] ${event.text}`).join('\n');
      const footer =
        state !== null && state.lastTurn !== null && state.status !== 'active'
          ? `\n回合已结束（${state.lastTurn.status}）；用 codex_result 取最终回答。`
          : '';
      return `${header}\n${body}${footer}`;
    },

    /**
     * 取回合结果。
     *
     * @param {{ thread?: string, turnId?: string }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async result(args, sessionId) {
      const thread = await targetThread(sessionId, { thread: args.thread });

      const queueEntry = queueFallbacks.get(thread.id);
      if (queueEntry !== undefined) {
        if (queueEntry.completed === null) pollQueueFallback(queueEntry);
        if (queueEntry.completed === null) {
          return `会话「${thread.title}」仍在执行（queue 通道，消息 ${queueEntry.messageId ?? '未知'}）；继续 codex_watch。`;
        }
        const completed = queueEntry.completed;
        const usage = queueEntry.usage ?? null;
        const usageText =
          usage === null
            ? ''
            : `\n用量：input=${usage.input_tokens ?? usage.inputTokens ?? '?'} cached=${usage.cached_input_tokens ?? usage.cachedInputTokens ?? '?'} output=${usage.output_tokens ?? usage.outputTokens ?? '?'}`;
        return [
          `会话「${thread.title}」回合 ${shortId(completed.turnId ?? '')}：状态=completed（queue 通道）`,
          `耗时=${completed.durationMs === null ? '未知' : `${completed.durationMs}ms`}${usageText}`,
          completed.finalText === '' ? '（没有文本回答）' : `回答：\n${completed.finalText}`,
        ].join('\n');
      }

      const outcome = await readTurn(appServer, registry, {
        threadId: thread.id,
        turnId: typeof args.turnId === 'string' ? args.turnId : undefined,
      });
      const usage = outcome.usage?.last ?? null;
      const usageText =
        usage === null
          ? ''
          : `\n用量：input=${usage.inputTokens ?? '?'} cached=${usage.cachedInputTokens ?? '?'} output=${usage.outputTokens ?? '?'}`;
      return [
        `会话「${thread.title}」回合 ${shortId(outcome.turnId ?? '')}：状态=${outcome.status}`,
        `耗时=${outcome.durationMs === null ? '未知' : `${outcome.durationMs}ms`}${usageText}`,
        outcome.finalText === '' ? '（没有文本回答）' : `回答：\n${outcome.finalText}`,
      ].join('\n');
    },

    /**
     * 中止当前回合。
     *
     * @param {{ thread?: string }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async interrupt(args, sessionId) {
      const thread = await targetThread(sessionId, { thread: args.thread });
      if (queueFallbacks.has(thread.id)) {
        throw new ThreadError(
          'NOT_SUPPORTED',
          `会话「${thread.title}」当前走 queue 回退通道，插件无法中止；请在 Codex 里停止该回合。`,
        );
      }
      const result = await interruptThread(appServer, registry, { threadId: thread.id });
      return `已中止会话「${thread.title}」的回合 ${shortId(result.turnId)}。`;
    },

    /**
     * 派遣一个子任务（子智能体通道或绑定会话通道）。
     *
     * @param {{ task: string, channel?: string, thread?: string, cwd?: string, sandbox?: string, model?: string, timeoutMs?: number }} args 参数。
     * @param {string} sessionId DSH 会话 ID。
     * @returns {Promise<string>} 文本。
     */
    async task(args, sessionId) {
      const taskText = typeof args.task === 'string' ? args.task.trim() : '';
      if (taskText === '') throw new TaskError('EMPTY_PROMPT', '任务内容不能为空');

      const requested = args.channel === 'isolated' || args.channel === 'session' ? args.channel : 'auto';
      const binding = bindings.get(sessionId);
      const hasBinding = binding !== null || (typeof args.thread === 'string' && args.thread.trim() !== '');
      const channel = resolveTaskChannel({ requested, pluginMode: currentMode(), hasBinding });

      if (channel === 'session') {
        const thread = await targetThread(sessionId, { thread: args.thread });
        let sent;
        try {
          sent = await sendInstruction(appServer, registry, workspaceSettings(sessionId), {
            threadId: thread.id,
            text: taskText,
            mode: 'auto',
          });
        } catch (error) {
          if (settings.queueFallback && error?.code === 'BUSY_THREAD') {
            const fallback = await startQueueFallback(thread, taskText);
            const deadline = Date.now() + settings.requestTimeoutMs;
            while (fallback.entry.completed === null && Date.now() < deadline) {
              pollQueueFallback(fallback.entry);
              if (fallback.entry.completed !== null) break;
              await new Promise((resolve) => {
                setTimeout(resolve, 300).unref?.();
              });
            }
            const completed = fallback.entry.completed;
            if (completed === null) {
              throw new TaskError('TASK_TIMEOUT', `${fallback.text}\n等待 queue 回退结果超时；用 codex_watch 继续跟踪。`);
            }
            const usage = fallback.entry.usage ?? null;
            const usageText =
              usage === null
                ? ''
                : `\n用量：input=${usage.input_tokens ?? usage.inputTokens ?? '?'} cached=${usage.cached_input_tokens ?? usage.cachedInputTokens ?? '?'} output=${usage.output_tokens ?? usage.outputTokens ?? '?'}`;
            return [
              `子任务完成（通道=queue 回退，会话「${thread.title}」，thread=${thread.id}）`,
              `耗时=${completed.durationMs === null ? '未知' : `${completed.durationMs}ms`}${usageText}`,
              completed.finalText === '' ? '（没有文本回答）' : `回答：\n${completed.finalText}`,
            ].join('\n');
          }
          throw error;
        }
        const lastTurn = await waitTurn(thread.id, sent.turnId);
        const usage = registry.stateOf(thread.id)?.usage?.last ?? null;
        const usageText =
          usage === null
            ? ''
            : `\n用量：input=${usage.inputTokens ?? '?'} cached=${usage.cachedInputTokens ?? '?'} output=${usage.outputTokens ?? '?'}`;
        return [
          `子任务完成（通道=session，会话「${thread.title}」，thread=${thread.id}）`,
          `状态=${lastTurn.status} 耗时=${lastTurn.durationMs === null ? '未知' : `${lastTurn.durationMs}ms`}${usageText}`,
          lastTurn.finalText === '' ? '（没有文本回答）' : `回答：\n${lastTurn.finalText}`,
        ].join('\n');
      }

      const outcome = await taskRunner.run({
        task: taskText,
        cwd:
          typeof args.cwd === 'string' && args.cwd.trim() !== ''
            ? args.cwd.trim()
            : workspaceFor(sessionId).path,
        sandbox: args.sandbox,
        model: args.model,
        timeoutMs: args.timeoutMs,
      });
      if (!outcome.ok) {
        throw new TaskError(
          outcome.errorCode === undefined ? 'TASK_FAILED' : outcome.errorCode,
          outcome.errorDetail ?? '子任务失败',
        );
      }
      const usage = outcome.usage ?? null;
      const usageText =
        usage === null
          ? ''
          : `\n用量：input=${usage.input_tokens ?? usage.inputTokens ?? '?'} cached=${usage.cached_input_tokens ?? usage.cachedInputTokens ?? '?'} output=${usage.output_tokens ?? usage.outputTokens ?? '?'}`;
      return [
        `子任务完成（通道=isolated，thread=${outcome.threadId === null ? '未知' : outcome.threadId}）`,
        `耗时=${outcome.durationMs}ms${usageText}`,
        outcome.threadId === null ? '' : `（要接管这个会话，可先 codex_use ${outcome.threadId}）`,
        outcome.text === '' ? '（没有文本回答）' : `回答：\n${outcome.text}`,
      ]
        .filter((line) => line !== '')
        .join('\n');
    },

    /**
     * 设置页：读取全局状态。
     *
     * @returns {Promise<any>} 状态。
     */
    async panelState() {
      return buildPanelState();
    },

    /**
     * 设置页：列出可选会话。
     *
     * @param {{ limit?: number, all?: boolean }} [options] 过滤条件。
     * @returns {Promise<any>} 会话列表。
     */
    async panelSessions(options) {
      return listPanelSessions(options);
    },

    /**
     * 设置页：切换操作方式。
     *
     * @param {string} mode 模式 id。
     * @returns {{ mode: string, modeLabel: string }} 生效后的模式。
     */
    setMode(mode) {
      return applyPanelMode(mode);
    },

    /**
     * 设置页：把某个会话设为默认目标。
     *
     * @param {string} threadId 会话 ID。
     * @returns {Promise<{ threadId: string, title: string }>} 绑定结果。
     */
    async bindThread(threadId) {
      return applyDefaultThread(threadId);
    },

    /**
     * 设置页：选择工作区；空串表示恢复自动。
     *
     * @param {string} workspaceRoot 目录路径。
     * @returns {{ workspaceRoot: string }} 生效后的覆盖值。
     */
    setWorkspace(workspaceRoot) {
      return applyPanelWorkspace(workspaceRoot);
    },

    /**
     * 设置页：浏览目录（文件夹选择器）。
     *
     * @param {{ path?: string }} [options] 目录路径。
     * @returns {ReturnType<typeof listDirectory>} 子目录列表。
     */
    browseDirectory(options) {
      return listDirectory({ path: options?.path, home: defaultHome() });
    },

    /**
     * 查询额度。
     *
     * @returns {Promise<string>} 文本。
     */
    async usage() {
      const response = await appServer.call('account/rateLimits/read', {});
      const snapshot = response?.rateLimits ?? response?.rateLimitsByLimitId?.codex ?? null;
      if (snapshot === null) return 'Codex 没有返回额度信息（可能未登录或账号不支持）。';
      const lines = [
        `套餐：${snapshot.planType ?? '未知'}`,
        `5 小时窗口：${formatWindow(snapshot.primary)}`,
        `7 天窗口：${formatWindow(snapshot.secondary)}`,
      ];
      const resetCredits = response?.rateLimitResetCredits?.availableCount;
      if (typeof resetCredits === 'number') lines.push(`额外重置额度：${resetCredits}`);
      return lines.join('\n');
    },

    /**
     * 把 Codex 窗口带到指定项目。
     *
     * @param {{ cwd?: string }} args 参数。
     * @param {string} [sessionId] DSH 会话 ID，用于解析默认工作区。
     * @returns {Promise<string>} 文本。
     */
    async openProject(args, sessionId) {
      const cwd =
        typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : workspaceFor(sessionId).path;
      if (cwd === '') throw new ThreadError('WORKSPACE_NOT_FOUND', '没有可用的工作区，请先在设置页选择目录。');
      const binary = await binaryInfo();
      const child = spawn(binary.path, ['app', cwd], { detached: true, stdio: 'ignore', windowsHide: false });
      child.unref();
      return `已请求 Codex 桌面端打开项目：${cwd}（若已打开会切到该项目；线程级聚焦需在 Codex 里选择）。`;
    },
  };
}

/**
 * Cordis 插件挂载点。
 *
 * @param {any} ctx 宿主上下文。
 * @param {any} config loader 配置。
 */
export function apply(ctx, config) {
  const settings = resolveConfig(config);
  const debugEnabled = process.env.DSH_CODEX_LINK_DEBUG === '1';
  const logger = {
    info: (message) => console.log(`[codex-link] ${message}`),
    warn: (message) => console.warn(`[codex-link] ${message}`),
    debug: (message) => {
      if (debugEnabled) console.log(`[codex-link] ${message}`);
    },
  };

  if (!settings.enabled) {
    logger.info('配置 enabled=false，插件不注册工具');
    return;
  }

  const registry = createThreadRegistry({
    eventBufferLimit: settings.eventBufferLimit,
    summaryChars: settings.summaryChars,
    fullChars: settings.fullChars,
  });
  const appServer = new CodexAppServer({ settings, logger });
  const bindings = new BindingsStore({ logger });
  const uiStore = new UiStore({ logger, defaultMode: settings.mode });
  const taskRunner = new TaskRunner({ settings, logger, maxParallel: settings.maxParallelTasks });

  appServer.onNotification((method, params) => {
    registry.observe(method, params);
  });
  appServer.setServerRequestHandler((request) => {
    const method = typeof request.method === 'string' ? request.method : '';
    const params = request.params !== null && typeof request.params === 'object' ? request.params : {};
    if (APPROVAL_METHODS.has(method)) {
      if (settings.approvals === 'allow') return { decision: 'approved' };
      registry.recordApprovalDenied(typeof params.threadId === 'string' ? params.threadId : '', { ...params, method }, '插件默认拒绝');
      return { decision: { denied: { rejection: 'dsh-plugin-codex-link: 审批默认被拒绝（可在插件配置中把 approvals 改为 allow）' } } };
    }
    logger.warn(`未处理的 Codex 客户端请求：${method}`);
    return { error: { code: -32601, message: `dsh-plugin-codex-link 未实现：${method}` } };
  });

  /**
   * 读取某个 DSH 会话的工作目录，供「工作区自动」使用。
   *
   * 宿主不同版本可能把 cwd 放在 `session.cwd` 或 `session.meta.cwd`，两处都试；
   * 服务不可用时返回 null，回退到用户主目录。
   *
   * @param {string} sessionId DSH 会话 ID。
   * @returns {string | null} 会话工作目录。
   */
  const sessionCwdOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    try {
      const sessions = typeof ctx.get === 'function' ? ctx.get('sessions') : undefined;
      const session = sessions?.get?.(sessionId);
      const cwd = session?.meta?.cwd ?? session?.cwd;
      return typeof cwd === 'string' && cwd.trim() !== '' ? cwd.trim() : null;
    } catch {
      return null;
    }
  };

  const controller = createController({
    settings,
    appServer,
    registry,
    bindings,
    uiStore,
    taskRunner,
    sessionCwdOf,
    logger,
  });

  const tools = ctx?.tools;
  if (tools === undefined || typeof tools.register !== 'function') {
    logger.warn('宿主没有工具服务，插件不注册任何工具');
    return;
  }

  /** @type {Array<() => void>} */
  const disposers = [];
  for (const spec of buildToolSpecs({ controller })) {
    try {
      const dispose = tools.register(spec);
      if (typeof dispose === 'function') disposers.push(dispose);
    } catch (error) {
      logger.warn(`工具 ${spec.name} 注册失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined;
  if (systemPrompt !== undefined && systemPrompt !== null && typeof systemPrompt.section === 'function') {
    systemPrompt.section({
      name: 'codex-link:guide',
      order: 68,
      text: () => guideText(settings, uiStore.getMode()),
    });
  }

  // 设置页的路由：webServer 可能在 apply 之后才就绪，优先用 Cordis 的
  // `ctx.inject(['webServer'], …)` 等它；没有 inject 能力时退回直接注册。
  const mountPanelRoutes = (routeCtx) => {
    recordRouteLog('准备注册设置页路由');
    const dispose = registerPanelRoutes(routeCtx, controller, logger, (message) => recordRouteLog(`registerPanelRoutes: ${message}`));
    if (typeof dispose !== 'function') {
      logger.warn('设置页 Codex 联动 面板不可用：宿主 webServer 未就绪（工具不受影响）');
      recordRouteLog('面板路由不可用（工具不受影响）');
      return;
    }
    logger.info(`设置页路由已注册：${ROUTE_PREFIX}`);
    recordRouteLog('设置页路由已注册');
    if (typeof routeCtx.effect === 'function') {
      routeCtx.effect(
        () => () => {
          try {
            dispose();
          } catch {
            /* 忽略注销失败 */
          }
        },
        'dsh-plugin-codex-link: panel routes',
      );
      return;
    }
    if (routeCtx === ctx) {
      disposers.push(dispose);
      return;
    }
    if (typeof routeCtx.on === 'function') {
      // 理论到不了这里：inject 子 fiber 一定有 effect。保守兜底。
      disposers.push(dispose);
    }
  };
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (routeCtx) => {
      mountPanelRoutes(routeCtx);
    });
  } else {
    mountPanelRoutes(ctx);
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 忽略单个资源的注销失败 */
          }
        }
        taskRunner.dispose();
        appServer.dispose();
        logger.info('插件已卸载，Codex 子进程已清理');
      },
      'dsh-plugin-codex-link: shutdown',
    );
  }

  logger.info(
    `已挂载：工作区=${settings.workspaceRoot === '' ? '自动（会话目录 → 主目录）' : settings.workspaceRoot} 默认会话=${settings.defaultThreadName} 方式=${uiStore.getMode()}`,
  );
}

/** 设置页路由前缀（与 client.js 中的常量保持一致）。 */
export const ROUTE_PREFIX = '/.dsh-codex-link';

/**
 * 写一个 JSON 响应。
 *
 * @param {any} res HTTP 响应。
 * @param {number} status 状态码。
 * @param {unknown} value JSON 值。
 */
function jsonResponse(res, status, value) {
  try {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  } catch {
    /* 连接可能已断开 */
  }
}

/**
 * 读取请求体 JSON，失败时按空对象处理。
 *
 * @param {any} req HTTP 请求。
 * @returns {Promise<any>} 解析后的请求体。
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.setEncoding?.('utf8');
    req.on('data', (chunk) => {
      raw += String(chunk);
      if (raw.length > 64_000) raw = raw.slice(0, 64_000);
    });
    req.on('end', () => {
      try {
        resolve(raw.trim() === '' ? {} : JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', () => resolve({}));
  });
}

/**
 * 构造设置页路由的 handler（不依赖 ctx，便于单测）。
 *
 * @param {Record<string, Function>} controller 控制器。
 * @param {{ warn?: Function }} logger 日志。
 * @returns {(req: any, res: any) => Promise<void>} HTTP handler。
 */
export function createPanelHandler(controller, logger) {
  return async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = url.pathname;
      if (route === `${ROUTE_PREFIX}/state` && req.method === 'GET') {
        return jsonResponse(res, 200, await controller.panelState());
      }
      if (route === `${ROUTE_PREFIX}/sessions` && req.method === 'GET') {
        return jsonResponse(
          res,
          200,
          await controller.panelSessions({
            all: url.searchParams.get('all') === '1',
            limit: Number(url.searchParams.get('limit') ?? 50),
          }),
        );
      }
      if (route === `${ROUTE_PREFIX}/client-error` && req.method === 'POST') {
        const body = await readJsonBody(req);
        logger.warn?.(`设置页客户端错误[${String(body.scope ?? 'client')}]：${String(body.message ?? '')}`);
        return jsonResponse(res, 200, { recorded: true });
      }
      if (route === `${ROUTE_PREFIX}/mode` && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = controller.setMode(String(body.mode ?? ''));
        return jsonResponse(res, 200, { ...result, state: await controller.panelState() });
      }
      if (route === `${ROUTE_PREFIX}/bind` && req.method === 'POST') {
        const body = await readJsonBody(req);
        const binding = await controller.bindThread(String(body.threadId ?? ''));
        return jsonResponse(res, 200, { binding, state: await controller.panelState() });
      }
      if (route === `${ROUTE_PREFIX}/workspace` && req.method === 'POST') {
        const body = await readJsonBody(req);
        const result = controller.setWorkspace(String(body.workspaceRoot ?? ''));
        return jsonResponse(res, 200, { ...result, state: await controller.panelState() });
      }
      if (route === `${ROUTE_PREFIX}/fs` && req.method === 'GET') {
        const path = url.searchParams.get('path') ?? '';
        return jsonResponse(res, 200, controller.browseDirectory({ path }));
      }
      return jsonResponse(res, 404, { error: 'not found' });
    } catch (error) {
      return jsonResponse(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  };
}

/**
 * 在给定的 webServer 上注册设置页路由。
 *
 * 宿主没有 `webServer` 时返回 null（工具照常可用，只是设置页拿不到数据），
 * 由调用方决定是重试还是降级。真实宿主里 webServer 可能在插件 apply 之后
 * 才就绪，所以 `apply()` 优先用 `ctx.inject(['webServer'], …)` 等待它。
 *
 * @param {any} ctx 宿主上下文。
 * @param {Record<string, Function>} controller 控制器。
 * @param {{ warn?: Function }} logger 日志。
 * @returns {(() => void) | null} 注销函数。
 */
export function registerPanelRoutes(ctx, controller, logger, record = null) {
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    record?.('webServer 未就绪（get 返回空或缺少 register）');
    return null;
  }
  try {
    const dispose = webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: createPanelHandler(controller, logger),
    });
    record?.(`注册成功 path=${ROUTE_PREFIX}`);
    return dispose;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn?.(`设置页路由注册失败：${message}`);
    record?.(`注册失败：${message}`);
    return null;
  }
}

export { resolveConfig } from './config.js';
export { ThreadError } from './threads.js';
export { AppServerError } from './app-server.js';
export { CodexBinaryError, resolveCodexBinary } from './codex-binary.js';
export { summarizeThread };
