/**
 * DSH 会话 → Codex 会话绑定的本地持久化。
 *
 * 不依赖宿主存储服务：一个 JSON 文件即可，写入走「临时文件 + rename」的原子
 * 替换，避免 DSH 异常退出时留下半个文件。文件损坏时按空表处理并告警，不阻塞
 * 插件启动。
 *
 * @module dsh-plugin-codex-link/bindings
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 默认的本地文件系统接口；测试通过 options 注入替身。 */
const NODE_FS = Object.freeze({ existsSync, mkdirSync, readFileSync, renameSync, writeFileSync });

/**
 * 计算默认绑定文件路径：`<DSH_HOME>/codex-link/bindings.json`。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function defaultBindingsPath(env = process.env) {
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'codex-link', 'bindings.json');
}

/** DSH 会话到 Codex 会话的绑定存储。 */
export class BindingsStore {
  /**
   * @param {{ filePath?: string, fs?: typeof NODE_FS, logger?: { warn?: Function } | null }} [options] 依赖注入。
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? defaultBindingsPath();
    this.fs = options.fs ?? NODE_FS;
    this.logger = options.logger ?? null;
    /** @type {Record<string, { threadId: string, threadTitle: string, updatedAt: number }> | null} */
    this.data = null;
  }

  /**
   * 懒加载绑定文件。
   *
   * @returns {Record<string, { threadId: string, threadTitle: string, updatedAt: number }>} 绑定表。
   */
  #load() {
    if (this.data !== null) return this.data;
    this.data = {};
    try {
      if (!this.fs.existsSync(this.filePath)) return this.data;
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [sessionId, value] of Object.entries(parsed)) {
          if (value === null || typeof value !== 'object') continue;
          if (typeof value.threadId !== 'string' || value.threadId === '') continue;
          this.data[sessionId] = {
            threadId: value.threadId,
            threadTitle: typeof value.threadTitle === 'string' ? value.threadTitle : '',
            updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : 0,
          };
        }
      }
    } catch (error) {
      this.logger?.warn?.(`[codex-link] 绑定文件读取失败，按空表处理：${error instanceof Error ? error.message : String(error)}`);
      this.data = {};
    }
    return this.data;
  }

  /**
   * 读取某个 DSH 会话的绑定。
   *
   * @param {string} sessionId DSH 会话 ID。
   * @returns {{ threadId: string, threadTitle: string, updatedAt: number } | null} 绑定或 null。
   */
  get(sessionId) {
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    return this.#load()[sessionId] ?? null;
  }

  /**
   * 写入绑定并落盘。
   *
   * @param {string} sessionId DSH 会话 ID。
   * @param {{ threadId: string, threadTitle?: string }} binding 绑定。
   * @returns {{ threadId: string, threadTitle: string, updatedAt: number }} 写入后的记录。
   */
  set(sessionId, binding) {
    const data = this.#load();
    const record = {
      threadId: String(binding.threadId),
      threadTitle: typeof binding.threadTitle === 'string' ? binding.threadTitle : '',
      updatedAt: Date.now(),
    };
    data[sessionId] = record;
    this.#save();
    return record;
  }

  /**
   * 删除绑定并落盘。
   *
   * @param {string} sessionId DSH 会话 ID。
   * @returns {boolean} 是否删除了记录。
   */
  remove(sessionId) {
    const data = this.#load();
    if (!Object.hasOwn(data, sessionId)) return false;
    delete data[sessionId];
    this.#save();
    return true;
  }

  /**
   * 原子写入绑定文件。
   */
  #save() {
    const data = this.#load();
    const directory = dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    try {
      this.fs.mkdirSync(directory, { recursive: true });
      this.fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      this.fs.renameSync(temporary, this.filePath);
    } catch (error) {
      this.logger?.warn?.(`[codex-link] 绑定文件写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
