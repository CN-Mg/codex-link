/**
 * Codex 会话的列举、匹配、默认会话保障，以及「发指令 / 中止 / 取结果」。
 *
 * 这个模块只依赖注入进来的 `server`（有 `call(method, params)`），因此可以
 * 在单测里替换成假对象，不碰真实 Codex。
 *
 * @module dsh-plugin-codex-link/threads
 */

import { basename } from 'node:path';

/** 会话相关错误；`code` 供工具层直接回传给模型。 */
export class ThreadError extends Error {
  /**
   * @param {string} code 稳定错误码（如 `THREAD_NOT_FOUND`）。
   * @param {string} message 中文说明。
   * @param {{ candidates?: any[] }} [extra] 附加信息。
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ThreadError';
    this.code = code;
    this.candidates = extra.candidates ?? null;
  }
}

/** UUID 形状的会话 ID。 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/**
 * 会话的展示标题：优先 name，其次 preview，最后目录名或 ID。
 *
 * @param {any} thread thread/list 或 thread/start 返回的 Thread 对象。
 * @returns {string} 标题。
 */
export function threadTitle(thread) {
  const candidates = [thread?.name, thread?.preview, thread?.cwd === undefined ? undefined : basename(String(thread.cwd))];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate.trim();
  }
  return typeof thread?.id === 'string' ? thread.id : '(未知会话)';
}

/**
 * 把 Codex 的 Thread 对象压成工具层使用的摘要。
 *
 * @param {any} thread Codex Thread。
 * @returns {{
 *   id: string,
 *   title: string,
 *   preview: string,
 *   cwd: string,
 *   status: string,
 *   updatedAt: number | null,
 *   archived: boolean,
 * }} 摘要。
 */
export function summarizeThread(thread) {
  return {
    id: typeof thread?.id === 'string' ? thread.id : '',
    title: threadTitle(thread),
    preview: typeof thread?.preview === 'string' ? thread.preview : '',
    cwd: typeof thread?.cwd === 'string' ? thread.cwd : '',
    status: typeof thread?.status?.type === 'string' ? thread.status.type : 'unknown',
    updatedAt: typeof thread?.updatedAt === 'number' ? thread.updatedAt : null,
    archived: thread?.archived === true,
  };
}

/**
 * 列出 Codex 会话。
 *
 * 服务端的 `searchTerm` 只匹配「提取出的标题」，刚创建、还没有消息的会话
 * 在状态库里标题为空，因此这里先按 searchTerm 查；查不到再拉一批最近会话
 * 在本地按标题/预览过滤，保证「刚建的会话」也能被搜到。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {{ cwd?: string, query?: string, limit?: number, archived?: boolean }} [options] 过滤条件。
 * @returns {Promise<Array<ReturnType<typeof summarizeThread>>>} 会话摘要列表（按更新时间倒序）。
 */
export async function listThreads(server, options = {}) {
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 100) : 15;
  const query = typeof options.query === 'string' ? options.query.trim() : '';

  /**
   * 执行一次 thread/list 并映射。
   *
   * @param {{ searchTerm?: string, limit: number }} extra 额外参数。
   * @returns {Promise<Array<ReturnType<typeof summarizeThread>>>} 会话摘要。
   */
  async function fetchPage(extra) {
    /** @type {Record<string, unknown>} */
    const params = {
      limit: extra.limit,
      archived: options.archived === true,
      sortKey: 'updated_at',
      sortDirection: 'desc',
      useStateDbOnly: true,
    };
    if (typeof options.cwd === 'string' && options.cwd.trim() !== '') params.cwd = options.cwd.trim();
    if (typeof extra.searchTerm === 'string' && extra.searchTerm !== '') params.searchTerm = extra.searchTerm;
    const response = await server.call('thread/list', params);
    const data = Array.isArray(response?.data) ? response.data : [];
    return data.map((thread) => summarizeThread(thread)).filter((thread) => thread.id !== '');
  }

  if (query === '') return fetchPage({ limit });

  const searched = await fetchPage({ limit, searchTerm: query });
  if (searched.length > 0) return searched;

  const recent = await fetchPage({ limit: 100 });
  const lower = query.toLowerCase();
  return recent
    .filter(
      (thread) =>
        thread.title.toLowerCase().includes(lower) ||
        thread.preview.toLowerCase().includes(lower) ||
        thread.cwd.toLowerCase().includes(lower),
    )
    .slice(0, limit);
}

/**
 * 按引用匹配会话：完整 ID → ID 前缀 → 序号 → 标题精确 → 标题包含。
 *
 * @param {Array<{ id: string, title: string }>} threads 候选列表。
 * @param {string} ref 用户引用（ID、短 ID、序号、标题或标题片段）。
 * @returns {{ thread?: any, candidates?: any[] }} 唯一匹配或候选集合。
 */
export function matchThreadRef(threads, ref) {
  const raw = typeof ref === 'string' ? ref.trim().replace(/^["'「『]+|["'」』]+$/gu, '') : '';
  if (raw === '') return { candidates: [] };

  if (UUID_PATTERN.test(raw)) {
    const lower = raw.toLowerCase();
    const exact = threads.find((thread) => String(thread.id).toLowerCase() === lower);
    return exact === undefined ? { candidates: [] } : { thread: exact };
  }

  if (/^\d+$/u.test(raw)) {
    const index = Number(raw) - 1;
    const picked = threads[index];
    return picked === undefined ? { candidates: [] } : { thread: picked };
  }

  if (/^[0-9a-f]{6,}$/iu.test(raw)) {
    const lower = raw.toLowerCase();
    const matches = threads.filter((thread) => String(thread.id).toLowerCase().startsWith(lower));
    if (matches.length === 1) return { thread: matches[0] };
    return { candidates: matches };
  }

  const lower = raw.toLowerCase();
  const exactTitle = threads.filter((thread) => String(thread.title).trim().toLowerCase() === lower);
  if (exactTitle.length === 1) return { thread: exactTitle[0] };
  if (exactTitle.length > 1) return { candidates: exactTitle };

  const contains = threads.filter((thread) => String(thread.title).toLowerCase().includes(lower));
  if (contains.length === 1) return { thread: contains[0] };
  if (contains.length > 1) return { candidates: contains };

  return { candidates: [] };
}

/**
 * 确保默认会话存在：先用已知 ID 验证，再按工作区 + 标题精确查找，最后才新建。
 *
 * Codex 的 `thread/list` 只返回有内容的会话（刚创建、还没有回合的空会话不可见），
 * 因此把上次解析到的默认会话 ID 记在绑定文件里，比每次重新搜索更可靠。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} settings 插件配置。
 * @param {{ info?: Function, warn?: Function } | null} [logger] 日志。
 * @param {{ knownThreadId?: string | null }} [options] 已知的默认会话 ID。
 * @returns {Promise<ReturnType<typeof summarizeThread> & { created: boolean }>} 默认会话摘要。
 */
export async function ensureDefaultThread(server, settings, logger = null, options = {}) {
  const wanted = settings.defaultThreadName.trim();

  if (typeof options.knownThreadId === 'string' && options.knownThreadId !== '') {
    try {
      const resumed = await server.call('thread/resume', { threadId: options.knownThreadId, excludeTurns: true });
      if (typeof resumed?.thread?.id === 'string') {
        const summary = summarizeThread({ ...resumed.thread, name: resumed.thread.name ?? wanted });
        return { ...summary, created: false };
      }
    } catch {
      // 已知 ID 失效（被删/归档）：继续走搜索与新建。
    }
  }

  const threads = await listThreads(server, {
    cwd: settings.workspaceRoot,
    query: wanted,
    limit: 20,
  });
  const found = threads.find((thread) => thread.title.trim() === wanted && thread.archived === false);
  if (found !== undefined) return { ...found, created: false };

  logger?.info?.(`[codex-link] 工作区里没有会话「${wanted}」，新建一个`);
  const created = await startThread(server, settings, {
    cwd: settings.workspaceRoot,
    name: settings.defaultThreadName,
  });
  return { ...created, created: true };
}

/**
 * 在工作区新建一个 Codex 会话，并尽量设置标题。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {ReturnType<typeof import('./config.js').resolveConfig>} settings 插件配置。
 * @param {{ cwd?: string, name?: string }} [options] 覆盖项。
 * @returns {Promise<ReturnType<typeof summarizeThread>>} 新会话摘要。
 */
export async function startThread(server, settings, options = {}) {
  const cwd = typeof options.cwd === 'string' && options.cwd.trim() !== '' ? options.cwd.trim() : settings.workspaceRoot;
  const name =
    typeof options.name === 'string' && options.name.trim() !== '' ? options.name.trim() : settings.defaultThreadName;

  const response = await server.call('thread/start', {
    cwd,
    sandbox: settings.sandbox,
    approvalPolicy: settings.approvalPolicy,
  });
  const threadId = response?.thread?.id;
  if (typeof threadId !== 'string' || threadId === '') {
    throw new ThreadError('THREAD_START_FAILED', 'Codex 没有返回新会话 ID');
  }
  try {
    await server.call('thread/name/set', { threadId, name });
  } catch {
    // 命名失败不阻塞使用：用 preview/标题兜底。
  }
  const summary = summarizeThread({ ...response.thread, name, cwd });
  return { ...summary, id: threadId };
}

/**
 * 恢复会话并读取其状态。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {string} threadId 会话 ID。
 * @returns {Promise<{ status: string, thread: any }>} 恢复结果。
 */
async function resumeThread(server, threadId) {
  try {
    const response = await server.call('thread/resume', { threadId, excludeTurns: true });
    const thread = response?.thread ?? {};
    const status = typeof thread.status?.type === 'string' ? thread.status.type : 'idle';
    return { status, thread };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/lock|busy|already|running|writer/iu.test(message)) {
      throw new ThreadError(
        'BUSY_THREAD',
        `会话当前被其它 Codex 客户端占用，暂不能写入：${message}。请等待该回合结束，或在 Codex 里关闭该会话后重试。`,
      );
    }
    if (/not found|no rollout|unknown thread/iu.test(message)) {
      throw new ThreadError('THREAD_NOT_FOUND', `找不到会话 ${threadId}：${message}`);
    }
    throw error;
  }
}

/**
 * 向指定会话发送指令。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {ReturnType<typeof import('./events.js').createThreadRegistry>} registry 事件注册表。
 * @param {{ call: Function }} _settings 未使用占位，保持签名一致。
 * @param {{ threadId: string, text: string, mode?: 'auto' | 'steer' | 'interrupt' }} options 请求。
 * @returns {Promise<{ threadId: string, turnId: string | null, mode: 'start' | 'steer' | 'interrupt', thread: any }>} 发送结果。
 */
export async function sendInstruction(server, registry, _settings, options) {
  const threadId = String(options.threadId ?? '');
  const text = typeof options.text === 'string' ? options.text.trim() : '';
  const mode = options.mode === 'steer' || options.mode === 'interrupt' ? options.mode : 'auto';
  if (threadId === '') throw new ThreadError('THREAD_NOT_FOUND', '没有可写入的 Codex 会话');
  if (text === '' && mode !== 'interrupt') throw new ThreadError('EMPTY_PROMPT', '指令内容不能为空');

  if (mode === 'interrupt') {
    const interrupted = await interruptThread(server, registry, { threadId });
    return { threadId, turnId: interrupted.turnId, mode: 'interrupt', thread: interrupted.thread };
  }

  const resumed = await resumeThread(server, threadId);
  const state = registry.stateOf(threadId);
  const ownTurnId = typeof state?.activeTurnId === 'string' ? state.activeTurnId : null;

  if (resumed.status === 'active') {
    if (mode === 'steer' || (mode === 'auto' && ownTurnId !== null)) {
      if (ownTurnId === null) {
        throw new ThreadError(
          'BUSY_THREAD',
          '该会话正在运行，但当前回合不是由 DSH 发起的，无法直接追加指令；请等待它结束，或在 Codex 里中止后重试。',
        );
      }
      const input = [{ type: 'text', text, text_elements: [] }];
      await server.call('turn/steer', { threadId, expectedTurnId: ownTurnId, input });
      return { threadId, turnId: ownTurnId, mode: 'steer', thread: summarizeThread(resumed.thread) };
    }
    throw new ThreadError(
      'BUSY_THREAD',
      '该会话正在运行，DSH 不能并发再开一轮；可改用 mode="steer" 追加指令，或等它结束。',
    );
  }

  const input = [{ type: 'text', text, text_elements: [] }];
  const response = await server.call('turn/start', { threadId, input });
  const turnId = typeof response?.turn?.id === 'string' ? response.turn.id : null;
  if (turnId !== null) registry.markActive(threadId, turnId);
  return { threadId, turnId, mode: 'start', thread: summarizeThread(resumed.thread) };
}

/**
 * 中止会话当前回合。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {ReturnType<typeof import('./events.js').createThreadRegistry>} registry 事件注册表。
 * @param {{ threadId: string }} options 请求。
 * @returns {Promise<{ threadId: string, turnId: string, thread: any }>} 中止结果。
 */
export async function interruptThread(server, registry, options) {
  const threadId = String(options.threadId ?? '');
  if (threadId === '') throw new ThreadError('THREAD_NOT_FOUND', '没有可中止的 Codex 会话');

  const state = registry.stateOf(threadId);
  let turnId = typeof state?.activeTurnId === 'string' ? state.activeTurnId : null;
  let thread = null;

  if (turnId === null) {
    const resumed = await resumeThread(server, threadId);
    thread = resumed.thread;
    if (resumed.status !== 'active') {
      throw new ThreadError('NOT_RUNNING', `会话 ${threadId} 当前没有正在运行的回合，无需中止。`);
    }
    try {
      const turns = await server.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc' });
      const latest = Array.isArray(turns?.data) ? turns.data[0] : undefined;
      if (typeof latest?.id === 'string') turnId = latest.id;
    } catch {
      // 取不到 turnId 时退回下面的错误提示。
    }
    if (turnId === null) {
      throw new ThreadError('NOT_RUNNING', '会话处于运行状态，但无法确定当前回合 ID，中止失败。');
    }
  }

  await server.call('turn/interrupt', { threadId, turnId });
  if (thread === null) {
    try {
      const resumed = await resumeThread(server, threadId);
      thread = resumed.thread;
    } catch {
      thread = null;
    }
  }
  return { threadId, turnId, thread: thread === null ? null : summarizeThread(thread) };
}

/**
 * 读取回合结果；优先用本实例事件缓存，缺失时回查 app-server。
 *
 * @param {{ call: Function }} server app-server 客户端。
 * @param {ReturnType<typeof import('./events.js').createThreadRegistry>} registry 事件注册表。
 * @param {{ threadId: string, turnId?: string }} options 请求。
 * @returns {Promise<{
 *   threadId: string,
 *   turnId: string | null,
 *   status: string,
 *   durationMs: number | null,
 *   finalText: string,
 *   usage: any,
 *   source: 'local' | 'remote',
 * }>} 结果。
 */
export async function readTurn(server, registry, options) {
  const threadId = String(options.threadId ?? '');
  if (threadId === '') throw new ThreadError('THREAD_NOT_FOUND', '没有指定 Codex 会话');
  const state = registry.stateOf(threadId);
  const wantedTurnId = typeof options.turnId === 'string' && options.turnId !== '' ? options.turnId : null;

  if (state?.lastTurn !== undefined && state.lastTurn !== null) {
    if (wantedTurnId === null || state.lastTurn.turnId === wantedTurnId) {
      return {
        threadId,
        turnId: state.lastTurn.turnId,
        status: state.lastTurn.status,
        durationMs: state.lastTurn.durationMs,
        finalText: state.lastTurn.finalText,
        usage: state.usage,
        source: 'local',
      };
    }
  }

  const turns = await server.call('thread/turns/list', { threadId, limit: 10, sortDirection: 'desc' });
  const data = Array.isArray(turns?.data) ? turns.data : [];
  const turn =
    data.find((candidate) => candidate?.id === wantedTurnId) ?? (wantedTurnId === null ? data[0] : undefined);
  if (turn === undefined) {
    throw new ThreadError(
      'TURN_NOT_FOUND',
      state?.status === 'active' ? '会话仍在运行，暂时没有完成的结果；请先继续 codex_watch。' : '没有找到对应的回合结果。',
    );
  }
  const items = Array.isArray(turn.items) ? turn.items : [];
  let finalText = '';
  for (const item of items) {
    if (item?.type === 'agentMessage' && typeof item.text === 'string') {
      finalText = item.text;
      if (item.phase === 'final_answer') break;
    }
  }
  return {
    threadId,
    turnId: typeof turn.id === 'string' ? turn.id : wantedTurnId,
    status: typeof turn.status === 'string' ? turn.status : 'unknown',
    durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
    finalText,
    usage: state?.usage ?? null,
    source: 'remote',
  };
}
