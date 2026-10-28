/**
 * Codex 可执行文件的动态发现。
 *
 * Codex 桌面端每次更新都会新建一个带哈希的 bin 目录（例如
 * `%LOCALAPPDATA%\OpenAI\Codex\bin\08d187884f2330d1\codex.exe`），旧目录可能
 * 被清空。因此这里不硬编码路径，而是按优先级探测，并缓存解析结果；调用失败
 * 时可以再重新发现一次。
 *
 * @module dsh-plugin-codex-link/codex-binary
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 找不到可用 Codex 时抛出的错误，`code` 固定为 `CODEX_NOT_FOUND`。 */
export class CodexBinaryError extends Error {
  /**
   * @param {string} message 面向用户的中文说明。
   * @param {Array<{ path: string, source: string, reason: string }>} candidates 探测过的候选。
   */
  constructor(message, candidates) {
    super(message);
    this.name = 'CodexBinaryError';
    this.code = 'CODEX_NOT_FOUND';
    this.candidates = candidates;
  }
}

/** 默认的本地文件系统接口；测试通过 options 注入替身。 */
const NODE_FS = Object.freeze({
  existsSync,
  readdirSync,
  statSync,
});

/**
 * 列出 Codex 安装目录下所有带 `codex.exe` 的哈希目录，按修改时间倒序。
 *
 * @param {{ localAppData?: string, platform?: string, fs?: typeof NODE_FS }} [options]
 * @returns {Array<{ path: string, source: string, mtimeMs: number }>} 候选可执行文件。
 */
export function binDirectoryCandidates(options = {}) {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? NODE_FS;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  if (platform !== 'win32' || typeof localAppData !== 'string' || localAppData === '') return [];

  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin');
  if (!fs.existsSync(binRoot)) return [];

  /** @type {Array<{ path: string, source: string, mtimeMs: number }>} */
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync(binRoot);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const executable = join(binRoot, entry, 'codex.exe');
    if (!fs.existsSync(executable)) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(executable).mtimeMs;
    } catch {
      mtimeMs = 0;
    }
    found.push({ path: executable, source: 'bin', mtimeMs });
  }
  found.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return found;
}

/**
 * 从 PATH 环境变量里找 codex 可执行文件。
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: string, fs?: typeof NODE_FS }} [options]
 * @returns {Array<{ path: string, source: string }>} 按 PATH 顺序排列的候选。
 */
export function pathCandidates(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? NODE_FS;
  const pathValue = typeof env.PATH === 'string' ? env.PATH : typeof env.Path === 'string' ? env.Path : '';
  if (pathValue === '') return [];
  const names = platform === 'win32' ? ['codex.exe'] : ['codex'];
  /** @type {Array<{ path: string, source: string }>} */
  const found = [];
  for (const directory of pathValue.split(platform === 'win32' ? ';' : ':')) {
    if (directory.trim() === '') continue;
    for (const name of names) {
      const candidate = join(directory.trim(), name);
      if (fs.existsSync(candidate)) found.push({ path: candidate, source: 'path' });
    }
  }
  return found;
}

/**
 * 按优先级解析出可用的 Codex 可执行文件，并用 `--version` 验证它能启动。
 *
 * @param {{
 *   configuredPath?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   localAppData?: string,
 *   fs?: typeof NODE_FS,
 *   execFileSyncImpl?: Function,
 * }} [options] 依赖注入点。
 * @returns {{ path: string, version: string, source: string }} 解析结果。
 * @throws {CodexBinaryError} 所有候选都不可用时抛出。
 */
export function resolveCodexBinary(options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fs = options.fs ?? NODE_FS;
  const run = options.execFileSyncImpl ?? execFileSync;

  /** @type {Array<{ path: string, source: string }>} */
  const candidates = [];
  const configuredPath = typeof options.configuredPath === 'string' ? options.configuredPath.trim() : '';
  if (configuredPath !== '') candidates.push({ path: configuredPath, source: 'config' });
  if (typeof env.CODEX_BIN === 'string' && env.CODEX_BIN.trim() !== '') {
    candidates.push({ path: env.CODEX_BIN.trim(), source: 'env' });
  }
  candidates.push(...binDirectoryCandidates({ localAppData: options.localAppData, platform, fs }));
  candidates.push(...pathCandidates({ env, platform, fs }));

  const seen = new Set();
  /** @type {Array<{ path: string, source: string, reason: string }>} */
  const tried = [];
  for (const candidate of candidates) {
    const key = candidate.path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!fs.existsSync(candidate.path)) {
      tried.push({ ...candidate, reason: 'not-found' });
      continue;
    }
    try {
      const output = String(
        run(candidate.path, ['--version'], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
        }),
      ).trim();
      const version = output.split(/\r?\n/)[0]?.trim() ?? '';
      return { path: candidate.path, version, source: candidate.source };
    } catch (error) {
      tried.push({ ...candidate, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  throw new CodexBinaryError(
    [
      '未找到可用的 Codex 可执行文件。',
      '请确认已安装 Codex CLI/桌面端，或把 `codexPath` 配置为 codex.exe 的绝对路径。',
      `已探测：${tried.length} 个候选（config / CODEX_BIN / %LOCALAPPDATA%\\OpenAI\\Codex\\bin / PATH）。`,
    ].join(''),
    tried,
  );
}

/**
 * 计算 Codex 用户数据目录（`~/.codex`），用于读取绑定/日志等。
 *
 * @param {NodeJS.ProcessEnv} [env] 环境变量。
 * @returns {string} 配置目录。
 */
export function codexHome(env = process.env) {
  if (typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() !== '') return env.CODEX_HOME.trim();
  return join(homedir(), '.codex');
}
