/**
 * 工作区解析与目录浏览。
 *
 * 工作区（Codex 项目目录）的优先级：
 *   1. 插件配置 `workspaceRoot`（非空且目录存在）
 *   2. 设置页保存的覆盖值（`ui.json` 的 `workspaceRoot`，非空且目录存在）
 *   3. 当前 DSH 会话的工作目录（工具调用时可取到）
 *   4. 用户主目录
 *
 * 前两级都不存在时逐级回退，而不是直接报错——这让插件在其他机器上
 * 无需先改配置也能跑起来。
 *
 * @module dsh-plugin-codex-link/workspace
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

/** 默认的文件系统接口；测试可注入替身。 */
const NODE_FS = Object.freeze({ existsSync, readdirSync, statSync });

/**
 * 用户主目录（优先用 Windows 的 USERPROFILE）。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 主目录路径。
 */
export function defaultHome(env = process.env) {
  if (typeof env.USERPROFILE === 'string' && env.USERPROFILE.trim() !== '') return env.USERPROFILE.trim();
  if (typeof env.HOME === 'string' && env.HOME.trim() !== '') return env.HOME.trim();
  return homedir();
}

/**
 * 判断路径是否是存在的目录。
 *
 * @param {string} path 路径。
 * @param {typeof NODE_FS} [fs] 文件系统接口。
 * @returns {boolean} 是否是目录。
 */
export function isDirectoryPath(path, fs = NODE_FS) {
  if (typeof path !== 'string' || path.trim() === '') return false;
  try {
    return fs.statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析出生效的工作区。
 *
 * @param {{
 *   configured?: string,
 *   override?: string,
 *   sessionCwd?: string | null,
 *   home?: string,
 *   fs?: typeof NODE_FS,
 * }} options 候选来源。
 * @returns {{
 *   path: string,
 *   source: 'config' | 'settings' | 'session' | 'home' | 'none',
 *   candidates: Array<{ path: string, source: string, exists: boolean }>,
 * }} 生效工作区。
 */
export function resolveWorkspaceRoot(options = {}) {
  const fs = options.fs ?? NODE_FS;
  const home = options.home ?? defaultHome();
  /** @type {Array<{ path: string, source: string }>} */
  const ordered = [];
  const add = (value, source) => {
    if (typeof value === 'string' && value.trim() !== '') ordered.push({ path: value.trim(), source });
  };
  add(options.configured, 'config');
  add(options.override, 'settings');
  add(options.sessionCwd ?? '', 'session');
  add(home, 'home');

  const candidates = ordered.map((candidate) => ({
    ...candidate,
    exists: isDirectoryPath(candidate.path, fs),
  }));
  const chosen = candidates.find((candidate) => candidate.exists);
  if (chosen === undefined) {
    return { path: ordered.length === 0 ? '' : ordered[ordered.length - 1].path, source: 'none', candidates };
  }
  return { path: resolvePath(chosen.path), source: chosen.source, candidates };
}

/**
 * 父目录；根目录时返回 null。
 *
 * @param {string} path 目录路径。
 * @returns {string | null} 父目录。
 */
export function parentDirectory(path) {
  const parent = dirname(path);
  return parent === path ? null : parent;
}

/**
 * 列出某个目录下的子目录，供设置页的文件夹浏览器使用。
 *
 * @param {{
 *   path?: string,
 *   home?: string,
 *   fs?: typeof NODE_FS,
 *   limit?: number,
 * }} [options] 参数。
 * @returns {{
 *   path: string,
 *   parent: string | null,
 *   entries: Array<{ name: string, path: string }>,
 *   drives: string[],
 *   error: string | null,
 * }} 列表结果。
 */
export function listDirectory(options = {}) {
  const fs = options.fs ?? NODE_FS;
  const home = options.home ?? defaultHome();
  const limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? Math.min(options.limit, 500) : 200;
  const start =
    typeof options.path === 'string' && options.path.trim() !== '' ? resolvePath(options.path.trim()) : home;

  /** @type {Array<{ name: string, path: string }>} */
  const entries = [];
  let error = null;
  try {
    const dirents = fs.readdirSync(start, { withFileTypes: true });
    for (const dirent of dirents) {
      if (!dirent.isDirectory()) continue;
      entries.push({ name: dirent.name, path: join(start, dirent.name) });
      if (entries.length >= limit) break;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'));
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }

  const parent = parentDirectory(start);
  /** @type {string[]} */
  const drives = [];
  if (parent === null && process.platform === 'win32') {
    for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
      const drive = `${letter}:\\`;
      try {
        if (fs.existsSync(drive)) drives.push(drive);
      } catch {
        /* 盘符探测失败忽略 */
      }
    }
  }

  return { path: start, parent, entries, drives, error };
}
