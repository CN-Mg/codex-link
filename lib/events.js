/**
 * Codex 通知 → 进度事件的归一化与有界缓冲。
 *
 * 这里不做任何 RPC：只把 `turn/started`、`item/*`、`turn/completed` 等通知
 * 变成 agent 能读、微信能播报的短文本，并按会话保存增量事件与游标。
 *
 * 游标格式为 `<实例 epoch>:<单调序号>`；DSH 重启后 epoch 改变，旧游标会被
 * 标记为 `stale`，调用方应重新建立基线。
 *
 * @module dsh-plugin-codex-link/events
 */

/**
 * 截断文本并补省略号。
 *
 * @param {unknown} value 任意值。
 * @param {number} max 最大字符数。
 * @returns {string} 截断后的字符串。
 */
export function clip(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 从回合的 items 里取最后一条助手回答。
 *
 * @param {Array<any> | null | undefined} items 回合 items。
 * @returns {string} 回答文本；没有时为空串。
 */
export function finalAnswerOf(items) {
  if (!Array.isArray(items)) return '';
  let fallback = '';
  for (const item of items) {
    if (item?.type !== 'agentMessage' || typeof item.text !== 'string') continue;
    fallback = item.text;
    if (item.phase === 'final_answer') return item.text;
  }
  return fallback;
}

/**
 * 把文件改动列表压缩成一行。
 *
 * @param {Array<{ path?: string }> | undefined} changes 改动列表。
 * @param {number} [max] 最多列几个路径。
 * @returns {string} 摘要。
 */
function describeChanges(changes, max = 3) {
  if (!Array.isArray(changes) || changes.length === 0) return '无文件清单';
  const paths = changes.map((change) => (typeof change?.path === 'string' ? change.path : '?'));
  const head = paths.slice(0, max).join(', ');
  return paths.length > max ? `${head} 等 ${paths.length} 个文件` : head;
}

/**
 * 创建线程注册表：保存每个 Codex 会话的状态、事件缓冲与游标。
 *
 * @param {{ eventBufferLimit?: number, summaryChars?: number, fullChars?: number, now?: () => number }} [options]
 * @returns {{
 *   observe: (method: string, params: any) => void,
 *   stateOf: (threadId: string) => any,
 *   eventsSince: (threadId: string, cursor?: string, options?: { detail?: 'summary' | 'full', limit?: number }) => any,
 *   markActive: (threadId: string, turnId: string) => void,
 *   recordLastTurn: (threadId: string, turn: any) => void,
 *   recordApprovalDenied: (threadId: string, params: any, reason: string) => void,
 *   getRateLimits: () => any,
 *   readonly epoch: string,
 * }} 注册表。
 */
export function createThreadRegistry(options = {}) {
  const eventBufferLimit = options.eventBufferLimit ?? 2_000;
  const summaryChars = options.summaryChars ?? 500;
  const fullChars = options.fullChars ?? 4_000;
  const now = options.now ?? (() => Date.now());

  const epoch = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let seq = 0;
  /** @type {Map<string, any>} */
  const threads = new Map();
  let rateLimits = null;

  /**
   * 取得或创建线程状态。
   *
   * @param {string} threadId 会话 ID。
   * @returns {any} 线程状态。
   */
  function ensure(threadId) {
    let thread = threads.get(threadId);
    if (thread === undefined) {
      thread = {
        threadId,
        status: 'idle',
        activeTurnId: null,
        lastTurn: null,
        usage: null,
        events: [],
        dropped: 0,
        createdAt: now(),
      };
      threads.set(threadId, thread);
    }
    return thread;
  }

  /**
   * 追加一条事件；缓冲满时淘汰最旧一条。
   *
   * @param {any} thread 线程状态。
   * @param {{ kind: string, text: string, meta?: any }} event 事件。
   * @returns {any} 记录。
   */
  function push(thread, event) {
    seq += 1;
    const record = { seq, at: now(), kind: event.kind, text: event.text, meta: event.meta ?? null };
    thread.events.push(record);
    if (thread.events.length > eventBufferLimit) {
      thread.events.shift();
      thread.dropped += 1;
    }
    return record;
  }

  /**
   * 合并同一条目的流式片段（只进 full 视图，summary 会过滤掉）。
   *
   * @param {any} thread 线程状态。
   * @param {string} kind 事件种类。
   * @param {string} itemId 条目 id。
   * @param {string} delta 新片段。
   * @returns {any} 记录。
   */
  function appendDelta(thread, kind, itemId, delta) {
    const last = thread.events[thread.events.length - 1];
    if (last !== undefined && last.kind === kind && last.meta?.itemId === itemId) {
      last.text = clip(`${last.text}${delta}`, fullChars);
      last.at = now();
      return last;
    }
    return push(thread, { kind, text: clip(delta, fullChars), meta: { itemId } });
  }

  /**
   * 处理 `item/started`。
   *
   * @param {any} thread 线程状态。
   * @param {any} item 条目。
   */
  function onItemStarted(thread, item) {
    if (item === null || typeof item !== 'object') return;
    switch (item.type) {
      case 'commandExecution':
        push(thread, {
          kind: 'tool_call',
          text: `正在执行命令：${clip(item.command, 180)}（cwd=${clip(item.cwd, 120)}）`,
          meta: { itemId: item.id, itemType: item.type, command: item.command, cwd: item.cwd },
        });
        return;
      case 'fileChange':
        push(thread, {
          kind: 'tool_call',
          text: `正在修改文件：${describeChanges(item.changes)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'mcpToolCall':
        push(thread, {
          kind: 'tool_call',
          text: `调用 MCP 工具：${clip(item.server, 60)}/${clip(item.tool, 60)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'dynamicToolCall':
        push(thread, {
          kind: 'tool_call',
          text: `调用工具：${clip(item.tool, 80)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'webSearch':
        push(thread, {
          kind: 'tool_call',
          text: `联网检索：${clip(item.query ?? item.action ?? '查询', 120)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'collabAgentToolCall':
        push(thread, {
          kind: 'tool_call',
          text: `协作代理：${clip(item.tool, 60)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'reasoning':
        push(thread, { kind: 'thinking', text: '推理中…', meta: { itemId: item.id } });
        return;
      case 'plan':
        push(thread, { kind: 'plan', text: `计划：${clip(item.text, summaryChars)}`, meta: { itemId: item.id } });
        return;
      default:
        return;
    }
  }

  /**
   * 处理 `item/completed`。
   *
   * @param {any} thread 线程状态。
   * @param {any} item 条目。
   */
  function onItemCompleted(thread, item) {
    if (item === null || typeof item !== 'object') return;
    switch (item.type) {
      case 'commandExecution': {
        const exit = item.exitCode === null || item.exitCode === undefined ? '?' : String(item.exitCode);
        const duration = item.durationMs === null || item.durationMs === undefined ? '?' : String(item.durationMs);
        push(thread, {
          kind: 'tool_result',
          text: `命令完成（exit=${exit}，${duration}ms）：${clip(item.command, 140)}`,
          meta: { itemId: item.id, itemType: item.type, exitCode: item.exitCode },
        });
        return;
      }
      case 'fileChange':
        push(thread, {
          kind: 'tool_result',
          text: `文件改动完成（${clip(item.status, 40)}）：${describeChanges(item.changes)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'mcpToolCall':
        push(thread, {
          kind: 'tool_result',
          text: `MCP 调用${item.status === 'completed' ? '完成' : `结束（${clip(item.status, 30)}）`}：${clip(item.server, 60)}/${clip(item.tool, 60)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'dynamicToolCall':
        push(thread, {
          kind: 'tool_result',
          text: `工具调用${item.success === false ? '失败' : '完成'}：${clip(item.tool, 80)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'webSearch':
        push(thread, {
          kind: 'tool_result',
          text: `联网检索完成：${clip(item.query ?? '查询', 100)}`,
          meta: { itemId: item.id, itemType: item.type },
        });
        return;
      case 'agentMessage':
        push(thread, {
          kind: 'message',
          text: `${item.phase === 'final_answer' ? '回答' : '消息'}：${clip(item.text, summaryChars)}`,
          meta: { itemId: item.id, itemType: item.type, phase: item.phase ?? null },
        });
        return;
      case 'plan':
        push(thread, { kind: 'plan', text: `计划：${clip(item.text, summaryChars)}`, meta: { itemId: item.id } });
        return;
      default:
        return;
    }
  }

  /**
   * 处理一条 Codex 通知。
   *
   * @param {string} method 通知方法名。
   * @param {any} params 通知参数。
   */
  function observe(method, params) {
    const payload = params !== null && typeof params === 'object' ? params : {};

    if (method === 'account/rateLimits/updated') {
      rateLimits = payload.rateLimits ?? payload.rateLimitsByLimitId ?? payload;
      return;
    }

    const threadId = typeof payload.threadId === 'string' ? payload.threadId : '';
    if (threadId === '') return;
    const thread = ensure(threadId);

    switch (method) {
      case 'turn/started': {
        const turn = payload.turn ?? {};
        thread.status = 'active';
        thread.activeTurnId = typeof turn.id === 'string' ? turn.id : null;
        push(thread, {
          kind: 'turn_started',
          text: `开始执行（turn ${clip(turn.id, 8)}）`,
          meta: { turnId: turn.id ?? null },
        });
        return;
      }
      case 'turn/completed': {
        const turn = payload.turn ?? {};
        const finalText = finalAnswerOf(turn.items);
        thread.status = 'idle';
        thread.activeTurnId = null;
        thread.lastTurn = {
          turnId: typeof turn.id === 'string' ? turn.id : null,
          status: typeof turn.status === 'string' ? turn.status : 'unknown',
          durationMs: typeof turn.durationMs === 'number' ? turn.durationMs : null,
          startedAt: typeof turn.startedAt === 'number' ? turn.startedAt : null,
          completedAt: typeof turn.completedAt === 'number' ? turn.completedAt : null,
          finalText,
          error: turn.error ?? null,
        };
        push(thread, {
          kind: 'turn_completed',
          text: [
            `回合结束（${thread.lastTurn.status}`,
            thread.lastTurn.durationMs === null ? '' : `，${thread.lastTurn.durationMs}ms`,
            '）',
            finalText === '' ? '' : `：${clip(finalText, summaryChars)}`,
          ].join(''),
          meta: { turnId: thread.lastTurn.turnId, status: thread.lastTurn.status },
        });
        return;
      }
      case 'thread/status/changed': {
        const status = payload.status ?? {};
        if (typeof status.type === 'string') thread.status = status.type;
        if (status.type === 'idle') thread.activeTurnId = null;
        return;
      }
      case 'thread/tokenUsage/updated': {
        thread.usage = payload.tokenUsage ?? null;
        return;
      }
      case 'item/started':
        if (thread.activeTurnId === null && typeof payload.turnId === 'string') thread.activeTurnId = payload.turnId;
        onItemStarted(thread, payload.item);
        return;
      case 'item/completed':
        onItemCompleted(thread, payload.item);
        return;
      case 'item/agentMessage/delta':
        appendDelta(thread, 'assistant_delta', String(payload.itemId ?? ''), String(payload.delta ?? ''));
        return;
      case 'item/commandExecution/outputDelta':
        appendDelta(thread, 'command_output', String(payload.itemId ?? ''), String(payload.delta ?? ''));
        return;
      case 'item/fileChange/outputDelta':
        appendDelta(thread, 'command_output', String(payload.itemId ?? ''), String(payload.delta ?? ''));
        return;
      case 'error': {
        const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload).slice(0, 300);
        push(thread, { kind: 'error', text: `错误：${clip(message, summaryChars)}` });
        return;
      }
      case 'warning': {
        const message = typeof payload.message === 'string' ? payload.message : JSON.stringify(payload).slice(0, 300);
        push(thread, { kind: 'warning', text: `提示：${clip(message, summaryChars)}` });
        return;
      }
      default:
        return;
    }
  }

  /**
   * 线程当前快照。
   *
   * @param {string} threadId 会话 ID。
   * @returns {any} 状态快照；未知会话返回 null。
   */
  function stateOf(threadId) {
    const thread = threads.get(threadId);
    if (thread === undefined) return null;
    return {
      threadId,
      status: thread.status,
      activeTurnId: thread.activeTurnId,
      lastTurn: thread.lastTurn,
      usage: thread.usage,
      buffered: thread.events.length,
      dropped: thread.dropped,
      lastSeq: thread.events.length === 0 ? 0 : thread.events[thread.events.length - 1].seq,
    };
  }

  /**
   * 解析游标。
   *
   * @param {string | undefined} cursor 游标文本。
   * @returns {{ epoch: string, seq: number } | null} 解析结果；非法时为 null。
   */
  function decodeCursor(cursor) {
    if (typeof cursor !== 'string') return null;
    const match = /^([a-z0-9]+):(\d+)$/u.exec(cursor.trim());
    if (match === null) return null;
    return { epoch: match[1], seq: Number(match[2]) };
  }

  /**
   * 取游标之后的增量事件。
   *
   * @param {string} threadId 会话 ID。
   * @param {string} [cursor] 上次返回的游标。
   * @param {{ detail?: 'summary' | 'full', limit?: number }} [options] 选项。
   * @returns {{
   *   events: Array<{ seq: number, kind: string, text: string }>,
   *   cursor: string,
   *   stale: boolean,
   *   hasMore: boolean,
   *   truncated: boolean,
   *   threadState: any,
   * }} 增量事件与下一次游标。
   */
  function eventsSince(threadId, cursor, options = {}) {
    const detail = options.detail === 'full' ? 'full' : 'summary';
    const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 200) : 100;
    const thread = threads.get(threadId);
    if (thread === undefined) {
      return { events: [], cursor: `${epoch}:${seq}`, stale: false, hasMore: false, truncated: false, threadState: null };
    }

    const decoded = decodeCursor(cursor);
    let stale = false;
    let fromSeq = 0;
    if (decoded !== null) {
      if (decoded.epoch !== epoch) stale = true;
      else fromSeq = decoded.seq;
    }

    const afterCursor = thread.events.filter((event) => event.seq > fromSeq);
    const visible =
      detail === 'full'
        ? afterCursor
        : afterCursor.filter((event) => event.kind !== 'assistant_delta' && event.kind !== 'command_output');
    const slice = visible.slice(0, limit);
    const maxChars = detail === 'full' ? fullChars : summaryChars;

    let nextCursor;
    if (slice.length > 0) {
      nextCursor = `${epoch}:${slice[slice.length - 1].seq}`;
    } else if (visible.length === 0) {
      const lastSeq = thread.events.length === 0 ? 0 : thread.events[thread.events.length - 1].seq;
      nextCursor = `${epoch}:${Math.max(lastSeq, fromSeq)}`;
    } else {
      nextCursor = `${epoch}:${fromSeq}`;
    }

    return {
      events: slice.map((event) => ({ seq: event.seq, kind: event.kind, text: clip(event.text, maxChars) })),
      cursor: nextCursor,
      stale,
      hasMore: visible.length > slice.length,
      truncated: thread.dropped > 0,
      threadState: stateOf(threadId),
    };
  }

  return {
    observe,
    stateOf,
    eventsSince,
    /**
     * 标记某会话当前活跃的回合（`turn/start` 响应比通知更早可用）。
     *
     * @param {string} threadId 会话 ID。
     * @param {string} turnId 回合 ID。
     */
    markActive(threadId, turnId) {
      const thread = ensure(threadId);
      thread.status = 'active';
      thread.activeTurnId = turnId;
    },
    /**
     * 记录一次回合结果（用于结果工具的回退）。
     *
     * @param {string} threadId 会话 ID。
     * @param {any} lastTurn 回合摘要。
     */
    recordLastTurn(threadId, lastTurn) {
      ensure(threadId).lastTurn = lastTurn;
    },
    /**
     * 记录一次被拒绝的审批请求。
     *
     * @param {string} threadId 会话 ID。
     * @param {any} params 审批参数。
     * @param {string} reason 拒绝原因。
     */
    recordApprovalDenied(threadId, params, reason) {
      const thread = ensure(threadId);
      const command = typeof params?.command === 'string' ? `命令：${clip(params.command, 160)}` : '';
      push(thread, {
        kind: 'approval_denied',
        text: `审批被拒绝${reason === '' ? '' : `（${reason}）`}${command === '' ? '' : `：${command}`}`,
        meta: { method: params?.method ?? null },
      });
    },
    /**
     * 最近一次额度通知（没有时返回 null，调用方应主动查询）。
     *
     * @returns {any} 额度快照。
     */
    getRateLimits() {
      return rateLimits;
    },
    /** 本实例的游标前缀；重启后改变。 */
    get epoch() {
      return epoch;
    },
  };
}
