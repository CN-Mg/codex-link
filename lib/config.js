/**
 * dsh-plugin-codex-link 的配置解析。
 *
 * Cordis loader 会按 `Config` 的默认值补齐配置，但 `apply()` 也可能被测试或
 * 工具直接调用，所以这里自己解析并钳制每个值，不信任调用方传进来的形状。
 *
 * 单位说明：所有时间参数单位为毫秒，所有字符上限单位为字符（UTF-16 码元）。
 *
 * @module dsh-plugin-codex-link/config
 */

import { MODE_IDS } from './modes.js';

/** 允许的 Codex 沙箱模式。 */
export const SANDBOX_MODES = Object.freeze(['read-only', 'workspace-write', 'danger-full-access']);

/** 允许的审批策略：`never` 让 Codex 不弹审批；`on-request` 等值会触发审批请求。 */
export const APPROVAL_POLICIES = Object.freeze(['never', 'on-request', 'untrusted']);

/** 审批请求的默认应答策略。`deny` 明确拒绝并记录，`allow` 自动批准（高风险）。 */
export const APPROVAL_ANSWERS = Object.freeze(['deny', 'allow']);

/** 窗口聚焦模式。v1 只支持 `off` 与 `project`。 */
export const FOCUS_MODES = Object.freeze(['off', 'project']);

/** 代码侧默认值，与 cordis.patch.yml 中的默认配置保持一致。 */
export const DEFAULTS = Object.freeze({
  /** 总开关；false 时不注册工具、不启动子进程。 */
  enabled: true,
  /** 默认交互工作区：Codex 的 Wechat 项目目录。 */
  workspaceRoot: 'C:\\Users\\Bolin\\Desktop\\DSH\\Wechat',
  /** 默认会话名；首次使用按此名在工作区里定位，找不到才新建。 */
  defaultThreadName: '微信工作区（DSH）',
  /** 显式指定 codex 可执行文件；null 表示动态发现。 */
  codexPath: null,
  /** 新建会话时 Codex 使用的沙箱模式。 */
  sandbox: 'workspace-write',
  /** 新建会话时 Codex 使用的审批策略；`never` 不会弹出审批请求。 */
  approvalPolicy: 'never',
  /** 沙箱是否允许网络访问。 */
  networkAccess: false,
  /** 收到审批请求时的应答：拒绝并记录，或自动批准。 */
  approvals: 'deny',
  /** app-server `initialize` 的超时。 */
  startupTimeoutMs: 20_000,
  /** 单次 RPC 请求（含一轮 turn 的启动）的超时。 */
  requestTimeoutMs: 600_000,
  /** codex_watch 默认短等时长。 */
  watchDefaultWaitMs: 8_000,
  /** codex_watch 允许的最大短等时长。 */
  watchMaxWaitMs: 20_000,
  /** 每个会话保留的事件条数上限。 */
  eventBufferLimit: 2_000,
  /** summary 模式下单条事件的字符上限。 */
  summaryChars: 500,
  /** full 模式下单条事件的字符上限。 */
  fullChars: 4_000,
  /** 窗口聚焦模式：off 不做任何窗口操作，project 只把 Codex 带到项目。 */
  focusMode: 'off',
  /** 默认操作方式：direct 直控会话 / subagent 子智能体 / hybrid 混合。 */
  mode: 'hybrid',
  /** 同时运行的独立子任务上限（codex_task 的 subagent 通道）。 */
  maxParallelTasks: 2,
});

/**
 * 取一个有限数字并钳制到 [min, max]。
 *
 * @param {unknown} value 原始值。
 * @param {number} min 下界。
 * @param {number} max 上界。
 * @param {number} fallback 非法值时的回退。
 * @returns {number} 解析后的数字。
 */
function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

/**
 * 取一个正的安全整数。
 *
 * @param {unknown} value 原始值。
 * @param {number} fallback 非法值时的回退。
 * @returns {number} 解析后的整数。
 */
function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

/**
 * 从白名单里挑一个值，非法时回退。
 *
 * @param {unknown} value 原始值。
 * @param {readonly string[]} allowed 白名单。
 * @param {string} fallback 回退值。
 * @returns {string} 解析后的值。
 */
function pickOne(value, allowed, fallback) {
  return typeof value === 'string' && allowed.includes(value) ? value : fallback;
}

/**
 * 解析原始配置为插件内部使用的设置对象。
 *
 * @param {unknown} raw loader 传入的配置（可能为 undefined）。
 * @returns {{
 *   enabled: boolean,
 *   workspaceRoot: string,
 *   defaultThreadName: string,
 *   codexPath: string | null,
 *   sandbox: string,
 *   approvalPolicy: string,
 *   networkAccess: boolean,
 *   approvals: string,
 *   startupTimeoutMs: number,
 *   requestTimeoutMs: number,
 *   watchDefaultWaitMs: number,
 *   watchMaxWaitMs: number,
 *   eventBufferLimit: number,
 *   summaryChars: number,
 *   fullChars: number,
 *   focusMode: string,
 *   mode: string,
 *   maxParallelTasks: number,
 * }} 归一化后的设置。
 */
export function resolveConfig(raw) {
  const config = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};

  const workspaceRoot =
    typeof config.workspaceRoot === 'string' && config.workspaceRoot.trim() !== ''
      ? config.workspaceRoot.trim()
      : DEFAULTS.workspaceRoot;

  const defaultThreadName =
    typeof config.defaultThreadName === 'string' && config.defaultThreadName.trim() !== ''
      ? config.defaultThreadName.trim()
      : DEFAULTS.defaultThreadName;

  const codexPath =
    typeof config.codexPath === 'string' && config.codexPath.trim() !== ''
      ? config.codexPath.trim()
      : null;

  const watchMaxWaitMs = clampNumber(config.watchMaxWaitMs, 1_000, 120_000, DEFAULTS.watchMaxWaitMs);
  const watchDefaultWaitMs = clampNumber(
    config.watchDefaultWaitMs,
    0,
    watchMaxWaitMs,
    Math.min(DEFAULTS.watchDefaultWaitMs, watchMaxWaitMs),
  );

  return {
    enabled: config.enabled !== false,
    workspaceRoot,
    defaultThreadName,
    codexPath,
    sandbox: pickOne(config.sandbox, SANDBOX_MODES, DEFAULTS.sandbox),
    approvalPolicy: pickOne(config.approvalPolicy, APPROVAL_POLICIES, DEFAULTS.approvalPolicy),
    networkAccess: config.networkAccess === true,
    approvals: pickOne(config.approvals, APPROVAL_ANSWERS, DEFAULTS.approvals),
    startupTimeoutMs: positiveInteger(config.startupTimeoutMs, DEFAULTS.startupTimeoutMs),
    requestTimeoutMs: positiveInteger(config.requestTimeoutMs, DEFAULTS.requestTimeoutMs),
    watchDefaultWaitMs,
    watchMaxWaitMs,
    eventBufferLimit: positiveInteger(config.eventBufferLimit, DEFAULTS.eventBufferLimit),
    summaryChars: positiveInteger(config.summaryChars, DEFAULTS.summaryChars),
    fullChars: positiveInteger(config.fullChars, DEFAULTS.fullChars),
    focusMode: pickOne(config.focusMode, FOCUS_MODES, DEFAULTS.focusMode),
    mode: pickOne(config.mode, MODE_IDS, DEFAULTS.mode),
    maxParallelTasks: positiveInteger(config.maxParallelTasks, DEFAULTS.maxParallelTasks),
  };
}

/**
 * 生成适合放进 `codex_status` 回执的一行配置摘要。
 *
 * @param {ReturnType<typeof resolveConfig>} settings 已解析的设置。
 * @returns {string} 单行描述。
 */
export function describeConfig(settings) {
  return [
    `工作区=${settings.workspaceRoot}`,
    `默认会话=${settings.defaultThreadName}`,
    `sandbox=${settings.sandbox}`,
    `审批策略=${settings.approvalPolicy}`,
    `审批应答=${settings.approvals}`,
    `网络=${settings.networkAccess ? '允许' : '禁止'}`,
    `聚焦=${settings.focusMode}`,
    `方式=${settings.mode}`,
  ].join(' ');
}
