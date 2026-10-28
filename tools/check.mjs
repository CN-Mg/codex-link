/**
 * 静态检查：清单、补丁层、README 工具表、模块可导入性与常见密钥泄漏。
 *
 * 只依赖 Node 内置模块，在仓库根目录运行：`node tools/check.mjs`。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const failures = [];
let checks = 0;

/**
 * 记录一次检查结果。
 *
 * @param {boolean} condition 是否通过。
 * @param {string} message 失败说明。
 */
function check(condition, message) {
  checks += 1;
  if (!condition) failures.push(message);
}

/**
 * 读取仓库内文件。
 *
 * @param {string} relative 相对路径。
 * @returns {string} 文件内容。
 */
function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

// 1. 必要文件。
for (const file of [
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
  '.gitignore',
  'lib/index.js',
  'lib/config.js',
  'lib/codex-binary.js',
  'lib/rpc-client.js',
  'lib/app-server.js',
  'lib/threads.js',
  'lib/events.js',
  'lib/bindings.js',
  'lib/tools.js',
  'lib/prompt.js',
]) {
  check(existsSync(join(root, file)), `缺少文件：${file}`);
}

// 2. package.json 与 bundle 约定。
const manifest = JSON.parse(read('package.json'));
check(manifest.name === 'dsh-plugin-codex-link', 'package.json 的 name 不匹配');
check(manifest.type === 'module', 'package.json 必须是 ESM（"type": "module"）');
check(manifest.main === 'lib/index.js', 'package.json 的 main 必须指向 lib/index.js');
check(typeof manifest.dsh?.bundle?.patch === 'string', 'package.json 缺少 dsh.bundle.patch');
check(existsSync(join(root, manifest.dsh?.bundle?.patch ?? '')), 'dsh.bundle.patch 指向的文件不存在');
check(manifest.dsh?.bundle?.patch === './cordis.patch.yml', 'bundle patch 应指向 ./cordis.patch.yml');

// 3. cordis.patch.yml 的 insert 行。
const patch = read('cordis.patch.yml');
check(patch.includes('dsh-plugin-codex-link'), 'cordis.patch.yml 缺少插件 id/name');
check(/defaultThreadName:\s*['"]?微信工作区（DSH）/u.test(patch), 'cordis.patch.yml 缺少默认会话名');
check(patch.includes('workspaceRoot'), 'cordis.patch.yml 缺少 workspaceRoot');

// 4. README 覆盖全部工具。
const readme = read('README.md');
for (const tool of [
  'codex_status',
  'codex_threads',
  'codex_use',
  'codex_send',
  'codex_watch',
  'codex_result',
  'codex_interrupt',
  'codex_usage',
  'codex_open_project',
]) {
  check(readme.includes(tool), `README 未记录工具：${tool}`);
}

// 5. 每个 lib 模块都能被独立导入（不依赖宿主 peer 包）。
const libDirectory = join(root, 'lib');
for (const file of readdirSync(libDirectory).filter((name) => name.endsWith('.js')).sort()) {
  try {
    await import(pathToFileURL(join(libDirectory, file)).href);
    checks += 1;
  } catch (error) {
    failures.push(`模块无法导入：lib/${file}（${error instanceof Error ? error.message : String(error)}）`);
  }
}

// 6. 常见密钥/危险路径的粗筛。
const sources = readdirSync(libDirectory)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, text: readFileSync(join(libDirectory, name), 'utf8') }));
for (const source of sources) {
  check(!/sk-[A-Za-z0-9]{20,}/u.test(source.text), `lib/${source.name} 疑似包含 API Key`);
  check(!/AKIA[0-9A-Z]{16}/u.test(source.text), `lib/${source.name} 疑似包含 AWS Key`);
  check(!/BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/u.test(source.text), `lib/${source.name} 疑似包含私钥`);
}

// 7. 文件大小护栏：避免单文件失控。
for (const source of sources) {
  const size = statSync(join(libDirectory, source.name)).size;
  check(size < 120_000, `lib/${source.name} 过大（${size} 字节），请拆分`);
}

if (failures.length > 0) {
  console.error(`check 失败：${failures.length}/${checks}`);
  for (const failure of failures) console.error(` - ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`check 通过：${checks} 项`);
}
