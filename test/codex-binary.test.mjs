/**
 * codex-binary.js 的单元测试：只依赖注入的假文件系统与假命令执行器。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CodexBinaryError,
  binDirectoryCandidates,
  pathCandidates,
  resolveCodexBinary,
} from '../lib/codex-binary.js';

/**
 * 构造一个假文件系统。
 *
 * @param {Record<string, number>} files 路径 → mtimeMs。
 * @param {string[]} [directories] 额外存在的目录。
 * @returns {{ existsSync: Function, readdirSync: Function, statSync: Function, files: Record<string, number> }} 假 fs。
 */
function fakeFs(files, directories = []) {
  const dirs = new Set(directories);
  for (const path of Object.keys(files)) {
    const parts = path.split(/[\\/]/u);
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join('\\'));
    }
  }
  return {
    files,
    existsSync(path) {
      return Object.hasOwn(files, path) || dirs.has(path);
    },
    readdirSync(path) {
      const prefix = `${path}\\`;
      const found = new Set();
      for (const file of Object.keys(files)) {
        if (!file.startsWith(prefix)) continue;
        found.add(file.slice(prefix.length).split('\\')[0]);
      }
      return [...found];
    },
    statSync(path) {
      if (!Object.hasOwn(files, path)) throw new Error(`ENOENT: ${path}`);
      return { mtimeMs: files[path] };
    },
  };
}

test('bin 目录候选按修改时间倒序', () => {
  const files = {
    'C:\\AppData\\OpenAI\\Codex\\bin\\old\\codex.exe': 100,
    'C:\\AppData\\OpenAI\\Codex\\bin\\new\\codex.exe': 300,
    'C:\\AppData\\OpenAI\\Codex\\bin\\mid\\codex.exe': 200,
  };
  const candidates = binDirectoryCandidates({
    localAppData: 'C:\\AppData',
    platform: 'win32',
    fs: fakeFs(files),
  });
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    [
      'C:\\AppData\\OpenAI\\Codex\\bin\\new\\codex.exe',
      'C:\\AppData\\OpenAI\\Codex\\bin\\mid\\codex.exe',
      'C:\\AppData\\OpenAI\\Codex\\bin\\old\\codex.exe',
    ],
  );
});

test('PATH 候选按顺序查找 codex.exe', () => {
  const fs = fakeFs({ 'C:\\bin\\codex.exe': 1, 'D:\\tools\\codex.exe': 1 });
  const candidates = pathCandidates({ env: { PATH: 'C:\\bin;D:\\tools' }, platform: 'win32', fs });
  assert.deepEqual(
    candidates.map((candidate) => candidate.path),
    ['C:\\bin\\codex.exe', 'D:\\tools\\codex.exe'],
  );
});

test('优先使用配置里的 codexPath', () => {
  const fs = fakeFs({ 'C:\\configured\\codex.exe': 1 });
  const resolved = resolveCodexBinary({
    configuredPath: 'C:\\configured\\codex.exe',
    env: {},
    platform: 'win32',
    fs,
    execFileSyncImpl: () => 'codex-cli 9.9.9\n',
  });
  assert.equal(resolved.path, 'C:\\configured\\codex.exe');
  assert.equal(resolved.version, 'codex-cli 9.9.9');
  assert.equal(resolved.source, 'config');
});

test('配置路径失效时回退到最新 bin 目录', () => {
  const fs = fakeFs({
    'C:\\AppData\\OpenAI\\Codex\\bin\\aaa\\codex.exe': 10,
    'C:\\AppData\\OpenAI\\Codex\\bin\\bbb\\codex.exe': 20,
  });
  const resolved = resolveCodexBinary({
    configuredPath: 'C:\\missing\\codex.exe',
    env: {},
    platform: 'win32',
    localAppData: 'C:\\AppData',
    fs,
    execFileSyncImpl: () => 'codex-cli 1.0.0',
  });
  assert.match(resolved.path, /bbb[\\/]codex\.exe$/u);
});

test('全部候选不可用时抛 CodexBinaryError', () => {
  const fs = fakeFs({});
  assert.throws(
    () =>
      resolveCodexBinary({
        env: {},
        platform: 'win32',
        localAppData: 'C:\\AppData',
        fs,
        execFileSyncImpl: () => {
          throw new Error('boom');
        },
      }),
    (error) => {
      assert.equal(error instanceof CodexBinaryError, true);
      assert.equal(error.code, 'CODEX_NOT_FOUND');
      return true;
    },
  );
});
