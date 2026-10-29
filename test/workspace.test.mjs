/**
 * workspace.js 的单元测试：解析优先级、目录存在性回退与目录浏览。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultHome,
  isDirectoryPath,
  listDirectory,
  parentDirectory,
  resolveWorkspaceRoot,
} from '../lib/workspace.js';

/**
 * 构造一个假文件系统：只把给定路径当作存在的目录。
 *
 * @param {string[]} directories 存在的目录。
 * @param {Record<string, string[]>} [children] 目录 → 子目录名。
 * @returns {{ existsSync: Function, statSync: Function, readdirSync: Function }} 假 fs。
 */
function fakeFs(directories, children = {}) {
  const dirs = new Set(directories.map((path) => path.toLowerCase()));
  return {
    existsSync(path) {
      return dirs.has(path.toLowerCase());
    },
    statSync(path) {
      if (!dirs.has(path.toLowerCase())) throw new Error(`ENOENT: ${path}`);
      return { isDirectory: () => true };
    },
    readdirSync(path) {
      const names = children[path] ?? [];
      return names.map((name) => ({ name, isDirectory: () => true }));
    },
  };
}

test('优先级：配置 > 设置页 > 会话目录 > 主目录', () => {
  const fs = fakeFs(['D:\\config', 'D:\\settings', 'D:\\session', 'C:\\Users\\me']);
  const options = { fs, home: 'C:\\Users\\me' };

  assert.equal(resolveWorkspaceRoot({ ...options, configured: 'D:\\config' }).path, 'D:\\config');
  assert.equal(resolveWorkspaceRoot({ ...options, configured: 'D:\\config' }).source, 'config');

  assert.equal(
    resolveWorkspaceRoot({ ...options, override: 'D:\\settings', sessionCwd: 'D:\\session' }).path,
    'D:\\settings',
  );
  assert.equal(resolveWorkspaceRoot({ ...options, override: 'D:\\settings' }).source, 'settings');
  assert.equal(resolveWorkspaceRoot({ ...options, sessionCwd: 'D:\\session' }).source, 'session');
});

test('不存在的目录逐级回退，最终回退主目录', () => {
  const fs = fakeFs(['C:\\Users\\me']);
  const result = resolveWorkspaceRoot({
    fs,
    home: 'C:\\Users\\me',
    configured: 'D:\\missing',
    override: 'D:\\also-missing',
    sessionCwd: 'D:\\nope',
  });
  assert.equal(result.path, 'C:\\Users\\me');
  assert.equal(result.source, 'home');
  assert.equal(result.candidates.filter((candidate) => candidate.exists).length, 1);
});

test('全部候选缺失时 source=none，不抛异常', () => {
  const fs = fakeFs([]);
  const result = resolveWorkspaceRoot({ fs, home: 'C:\\missing-home' });
  assert.equal(result.source, 'none');
  assert.equal(result.path, 'C:\\missing-home');
});

test('isDirectoryPath 对空值/不存在路径返回 false', () => {
  const fs = fakeFs(['D:\\ok']);
  assert.equal(isDirectoryPath('D:\\ok', fs), true);
  assert.equal(isDirectoryPath('D:\\nope', fs), false);
  assert.equal(isDirectoryPath('', fs), false);
  assert.equal(isDirectoryPath(undefined, fs), false);
});

test('parentDirectory：根目录返回 null', () => {
  assert.equal(parentDirectory('D:\\a\\b'), 'D:\\a');
  assert.equal(parentDirectory('C:\\'), null);
});

test('listDirectory 列出子目录、父目录并支持盘符', () => {
  const fs = fakeFs(['C:\\Users\\me'], {
    'C:\\Users\\me': ['work', 'projects', 'notes'],
  });
  const result = listDirectory({ path: 'C:\\Users\\me', fs, home: 'C:\\Users\\me' });
  assert.equal(result.path, 'C:\\Users\\me');
  assert.deepEqual(
    result.entries.map((entry) => entry.name),
    ['notes', 'projects', 'work'],
  );
  assert.equal(result.parent, 'C:\\Users');
  assert.equal(result.error, null);
});

test('listDirectory 读取失败时返回 error 而不是抛异常', () => {
  const fs = {
    existsSync: () => false,
    statSync: () => {
      throw new Error('ENOENT');
    },
    readdirSync: () => {
      throw new Error('EACCES: denied');
    },
  };
  const result = listDirectory({ path: 'Z:\\secret', fs, home: 'C:\\Users\\me' });
  assert.match(result.error, /EACCES/u);
  assert.deepEqual(result.entries, []);
});

test('defaultHome 优先 USERPROFILE', () => {
  assert.equal(defaultHome({ USERPROFILE: 'C:\\Users\\abc' }), 'C:\\Users\\abc');
  assert.equal(defaultHome({ HOME: '/home/abc' }), '/home/abc');
});
