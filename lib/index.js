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

import { describeConfig, resolveConfig } from './config.js';
import { CodexAppServer } from './app-server.js';
import { resolveCodexBinary } from './codex-binary.js';
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
 *   logger: any,
 * }} dependencies 依赖。
 * @returns {Record<string, Function>} 控制器方法。
 */
function createController({ settings, appServer, registry, bindings, logger }) {
  /** @type {{ path: string, version: string, source: string } | null} */
  let binaryCache = null;
  /** @type {{ threads: Array<any>, at: number } | null} */
  let recentCache = null;
  const RECENT_TTL_MS = 5 * 60_000;

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
   * @returns {Promise<Array<any>>} 会话摘要。
   */
  async function recentThreads() {
    if (recentCache !== null && Date.now() - recentCache.at < RECENT_TTL_MS) return recentCache.threads;
    const threads = await listThreads(appServer, { cwd: settings.workspaceRoot, limit: 50 });
    recentCache = { threads, at: Date.now() };
    return threads;
  }

  /**
   * 按用户引用解析出目标会话。
   *
   * @param {string} ref 引用文本。
   * @returns {Promise<any>} 会话摘要。
   */
  async function resolveRef(ref) {
    const raw = typeof ref === 'string' ? ref.trim() : '';
    if (raw === '') throw new ThreadError('EMPTY_REF', '没有指定 Codex 会话引用');

    if (UUID_PATTERN.test(raw)) {
      return { id: raw, title: raw.slice(0, 8), preview: '', cwd: '', status: 'unknown', updatedAt: null, archived: false };
    }

    if (/^\d+$/u.test(raw)) {
      const threads = await recentThreads();
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
      const thread = await startThread(appServer, settings, {});
      bindings.set(sessionId, { threadId: thread.id, threadTitle: thread.title });
      return thread;
    }
    if (typeof options.thread === 'string' && options.thread.trim() !== '') {
      return resolveRef(options.thread);
    }
    const binding = bindings.get(sessionId);
    if (binding !== null) {
      return {
        id: binding.threadId,
        title: binding.threadTitle === '' ? binding.threadId.slice(0, 8) : binding.threadTitle,
        preview: '',
        cwd: settings.workspaceRoot,
        status: 'unknown',
        updatedAt: null,
        archived: false,
      };
    }
    const knownDefault = bindings.get(DEFAULT_THREAD_KEY);
    const thread = await ensureDefaultThread(appServer, settings, logger, {
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

  return {
    /**
     * 连接与配置状态。
     *
     * @returns {Promise<string>} 文本。
     */
    async status() {
      let binaryText;
      try {
        const binary = await binaryInfo();
        binaryText = `${binary.path}（${binary.version === '' ? '版本未知' : binary.version}，来源 ${binary.source}）`;
      } catch (error) {
        binaryText = `不可用：${error instanceof Error ? error.message : String(error)}`;
      }
      const lines = [
        `Codex app-server：${appServer.state}`,
        `Codex 可执行文件：${binaryText}`,
        `配置：${describeConfig(settings)}`,
      ];
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
     * @returns {Promise<string>} 文本。
     */
    async threads(args) {
      const limit = Number.isSafeInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 50) : 15;
      const showAll = args.all === true;
      const threads = await listThreads(appServer, {
        cwd: showAll ? undefined : settings.workspaceRoot,
        query: typeof args.query === 'string' ? args.query : undefined,
        limit,
      });
      if (!showAll) recentCache = { threads, at: Date.now() };
      return formatThreads(threads, showAll ? `Codex 会话（全部，共 ${threads.length} 条）` : `Codex 会话（工作区 ${settings.workspaceRoot}，共 ${threads.length} 条）`);
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
      const result = await sendInstruction(appServer, registry, settings, {
        threadId: thread.id,
        text: typeof args.text === 'string' ? args.text : '',
        mode: args.mode === 'steer' || args.mode === 'interrupt' ? args.mode : 'auto',
      });
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
      const result = await interruptThread(appServer, registry, { threadId: thread.id });
      return `已中止会话「${thread.title}」的回合 ${shortId(result.turnId)}。`;
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
     * @returns {Promise<string>} 文本。
     */
    async openProject(args) {
      const cwd = typeof args.cwd === 'string' && args.cwd.trim() !== '' ? args.cwd.trim() : settings.workspaceRoot;
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

  const controller = createController({ settings, appServer, registry, bindings, logger });

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
      text: () => guideText(settings),
    });
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* 忽略单个工具注销失败 */
          }
        }
        appServer.dispose();
        logger.info('插件已卸载，Codex 子进程已清理');
      },
      'dsh-plugin-codex-link: shutdown',
    );
  }

  logger.info(`已挂载：工作区=${settings.workspaceRoot} 默认会话=${settings.defaultThreadName}`);
}

export { resolveConfig } from './config.js';
export { ThreadError } from './threads.js';
export { AppServerError } from './app-server.js';
export { CodexBinaryError, resolveCodexBinary } from './codex-binary.js';
export { summarizeThread };
