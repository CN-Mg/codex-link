/**
 * 设置页使用的全局状态：操作方式与工作区。
 *
 * 与按 DSH 会话保存的绑定文件分开：这些是整台机器共享的选择，走
 * `<DSH_HOME>/codex-link/ui.json`，写临时文件再 rename，损坏时按默认值处理。
 *
 * @module dsh-plugin-codex-link/ui-store
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { DEFAULT_MODE, resolveMode } from './modes.js';

/** 默认的本地文件系统接口；测试可注入替身。 */
const NODE_FS = Object.freeze({ existsSync, mkdirSync, readFileSync, renameSync, writeFileSync });

/**
 * 计算默认 UI 状态文件路径：`<DSH_HOME>/codex-link/ui.json`。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 绝对路径。
 */
export function defaultUiPath(env = process.env) {
  const home =
    typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh');
  return join(home, 'codex-link', 'ui.json');
}

/** 全局 UI 状态存储。 */
export class UiStore {
  /**
   * @param {{ filePath?: string, fs?: typeof NODE_FS, logger?: { warn?: Function } | null, defaultMode?: string }} [options]
   */
  constructor(options = {}) {
    this.filePath = options.filePath ?? defaultUiPath();
    this.fs = options.fs ?? NODE_FS;
    this.logger = options.logger ?? null;
    this.defaultMode = resolveMode(options.defaultMode, DEFAULT_MODE);
    /** @type {{ mode: string, workspaceRoot: string } | null} */
    this.data = null;
  }

  /**
   * 懒加载状态。
   *
   * @returns {{ mode: string, workspaceRoot: string }} 状态。
   */
  #load() {
    if (this.data !== null) return this.data;
    this.data = { mode: this.defaultMode, workspaceRoot: '' };
    try {
      if (!this.fs.existsSync(this.filePath)) return this.data;
      const parsed = JSON.parse(this.fs.readFileSync(this.filePath, 'utf8'));
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data.mode = resolveMode(parsed.mode, this.defaultMode);
        if (typeof parsed.workspaceRoot === 'string') this.data.workspaceRoot = parsed.workspaceRoot.trim();
      }
    } catch (error) {
      this.logger?.warn?.(`[codex-link] ui 状态读取失败，用默认值：${error instanceof Error ? error.message : String(error)}`);
      this.data = { mode: this.defaultMode, workspaceRoot: '' };
    }
    return this.data;
  }

  /** 落盘当前状态。 */
  #save() {
    const data = this.#load();
    const directory = dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    try {
      this.fs.mkdirSync(directory, { recursive: true });
      this.fs.writeFileSync(temporary, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
      this.fs.renameSync(temporary, this.filePath);
    } catch (error) {
      this.logger?.warn?.(`[codex-link] ui 状态写入失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * 当前模式。
   *
   * @returns {string} 模式 id。
   */
  getMode() {
    return this.#load().mode;
  }

  /**
   * 设置模式并落盘。
   *
   * @param {string} mode 模式 id。
   * @returns {string} 生效后的模式 id（非法值回退默认）。
   */
  setMode(mode) {
    const data = this.#load();
    data.mode = resolveMode(mode, this.defaultMode);
    this.#save();
    return data.mode;
  }

  /**
   * 设置页选择的工作区；空串表示自动。
   *
   * @returns {string} 工作区路径或空串。
   */
  getWorkspaceRoot() {
    return this.#load().workspaceRoot;
  }

  /**
   * 保存设置页选择的工作区。
   *
   * @param {string} workspaceRoot 目录路径；空串表示恢复自动。
   * @returns {string} 生效后的值。
   */
  setWorkspaceRoot(workspaceRoot) {
    const data = this.#load();
    data.workspaceRoot = typeof workspaceRoot === 'string' ? workspaceRoot.trim() : '';
    this.#save();
    return data.workspaceRoot;
  }
}
