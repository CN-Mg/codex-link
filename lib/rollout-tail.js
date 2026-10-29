/**
 * 读取 Codex 会话的 rollout JSONL（增量），用于 queue 回退通道：
 * 消息被投递进桌面端正在打开的会话后，执行过程与结果只出现在该会话的
 * rollout 文件里。
 *
 * 不依赖 sqlite：rollout 文件名带 thread id，按 `sessions/<年>/<月>/<日>/`
 * 逐层找即可；找到后缓存路径，用字节偏移量增量读取。
 *
 * @module dsh-plugin-codex-link/rollout-tail
 */

import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 默认文件系统接口；测试可注入替身。 */
const NODE_FS = Object.freeze({ closeSync, openSync, readSync, readdirSync, statSync });

/**
 * 在 sessions 目录下递归查找带某个 thread id 的 rollout 文件。
 *
 * @param {string} sessionsRoot `~/.codex/sessions`。
 * @param {string} threadId 会话 ID。
 * @param {typeof NODE_FS} [fs] 文件系统接口。
 * @returns {string | null} 文件路径。
 */
export function findRolloutPath(sessionsRoot, threadId, fs = NODE_FS) {
  const target = String(threadId).toLowerCase();
  /** @param {string} directory @param {number} depth */
  function walk(directory, depth) {
    if (depth > 4) return null;
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = walk(path, depth + 1);
        if (found !== null) return found;
        continue;
      }
      if (!entry.name.startsWith('rollout-') || !entry.name.endsWith('.jsonl')) continue;
      if (entry.name.toLowerCase().includes(target)) return path;
    }
    return null;
  }
  return walk(sessionsRoot, 0);
}

/**
 * 从 rollout 的一行里提取进度事件。
 *
 * @param {any} record 解析后的 JSON 记录。
 * @returns {{ events: Array<{ kind: string, text: string }>, completed?: { turnId: string | null, finalText: string, durationMs: number | null }, running?: boolean, usage?: any }} 归一化结果。
 */
export function normalizeRolloutRecord(record) {
  const events = [];
  if (record === null || typeof record !== 'object') return { events };
  const payload = record.payload !== null && typeof record.payload === 'object' ? record.payload : {};
  const type = record.type;
  const payloadType = payload.type;

  if (type === 'event_msg') {
    if (payloadType === 'task_started') {
      events.push({ kind: 'turn_started', text: '开始执行' });
      return { events, running: true };
    }
    if (payloadType === 'agent_message' && typeof payload.message === 'string') {
      events.push({ kind: 'message', text: `消息：${clip(payload.message, 500)}` });
      return { events };
    }
    if (payloadType === 'token_count' && payload.info !== null && typeof payload.info === 'object') {
      return { events, usage: payload.info.total_token_usage ?? null };
    }
    if (payloadType === 'item_completed' && payload.item !== null && typeof payload.item === 'object') {
      const item = payload.item;
      if (item.type === 'command_execution') {
        const exit = item.exit_code ?? item.exitCode ?? '?';
        events.push({ kind: 'tool_result', text: `命令完成（exit=${String(exit)}）：${clip(item.command, 140)}` });
      } else if (item.type === 'agent_message' && typeof item.text === 'string') {
        events.push({ kind: 'message', text: `消息：${clip(item.text, 500)}` });
      } else if (item.type === 'file_change') {
        events.push({ kind: 'tool_result', text: '文件改动完成' });
      }
      return { events };
    }
    if (payloadType === 'task_complete') {
      const finalText = typeof payload.last_agent_message === 'string' ? payload.last_agent_message : '';
      events.push({ kind: 'turn_completed', text: `回合结束：${clip(finalText, 300)}` });
      return {
        events,
        completed: {
          turnId: typeof payload.turn_id === 'string' ? payload.turn_id : null,
          finalText,
          durationMs: typeof payload.duration_ms === 'number' ? payload.duration_ms : null,
        },
      };
    }
    return { events };
  }

  if (type === 'response_item') {
    if (payloadType === 'function_call') {
      events.push({ kind: 'tool_call', text: `调用工具：${clip(payload.name, 80)}` });
      return { events };
    }
    if (payloadType === 'function_call_output') {
      const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
      events.push({ kind: 'tool_result', text: `工具返回：${clip(output, 240)}` });
      return { events };
    }
    if (payloadType === 'message' && payload.role === 'assistant') {
      const text = Array.isArray(payload.content)
        ? payload.content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('')
        : '';
      if (text !== '') events.push({ kind: 'message', text: `回答：${clip(text, 500)}` });
      return { events };
    }
    return { events };
  }

  return { events };
}

/**
 * 截断文本。
 *
 * @param {unknown} value 任意值。
 * @param {number} max 最大长度。
 * @returns {string} 截断结果。
 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

/** 增量读取某个会话的 rollout。 */
export class RolloutTail {
  /**
   * @param {{ sessionsRoot: string, threadId: string, fs?: typeof NODE_FS, logger?: { warn?: Function } | null }} options 参数。
   */
  constructor(options) {
    this.sessionsRoot = options.sessionsRoot;
    this.threadId = options.threadId;
    this.fs = options.fs ?? NODE_FS;
    this.logger = options.logger ?? null;
    /** @type {string | null} */
    this.path = null;
    this.offset = 0;
  }

  /**
   * 定位 rollout 文件（缓存）。
   *
   * @returns {boolean} 是否找到。
   */
  ensureLocated() {
    if (this.path !== null) return true;
    this.path = findRolloutPath(this.sessionsRoot, this.threadId, this.fs);
    return this.path !== null;
  }

  /** 把读取位置移到文件末尾（投递前调用，避免读到旧回合）。 */
  startAtEnd() {
    if (!this.ensureLocated()) return;
    try {
      this.offset = this.fs.statSync(this.path).size;
    } catch {
      this.offset = 0;
    }
  }

  /**
   * 读取新追加的内容并归一化。
   *
   * @returns {{ events: Array<{ kind: string, text: string }>, completed: any, running: boolean, usage: any }} 本次增量。
   */
  poll() {
    const result = { events: [], completed: null, running: false, usage: null };
    if (!this.ensureLocated() || this.path === null) return result;

    let size = 0;
    try {
      size = this.fs.statSync(this.path).size;
    } catch {
      return result;
    }
    if (size <= this.offset) return result;

    let fd = null;
    let text = '';
    try {
      fd = this.fs.openSync(this.path, 'r');
      const length = size - this.offset;
      const buffer = Buffer.alloc(length);
      const read = this.fs.readSync(fd, buffer, 0, length, this.offset);
      text = buffer.slice(0, read).toString('utf8');
      this.offset += read;
    } catch (error) {
      this.logger?.warn?.(`[codex-link] rollout 读取失败：${error instanceof Error ? error.message : String(error)}`);
      return result;
    } finally {
      if (fd !== null) {
        try {
          this.fs.closeSync(fd);
        } catch {
          /* 忽略 */
        }
      }
    }

    for (const line of text.split(/\r?\n/u)) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let record;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const normalized = normalizeRolloutRecord(record);
      result.events.push(...normalized.events);
      if (normalized.running === true) result.running = true;
      if (normalized.usage !== undefined && normalized.usage !== null) result.usage = normalized.usage;
      if (normalized.completed !== undefined && normalized.completed !== null) {
        result.completed = normalized.completed;
        result.running = false;
      }
    }
    return result;
  }
}
