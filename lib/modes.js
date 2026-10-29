/**
 * 插件的几种操作方式（模式）。
 *
 * - `direct`  直控：DSH 直接驱动已绑定的 Codex 会话（codex_send / watch / result）。
 * - `subagent` 子智能体：codex_task 用独立进程执行，只回最终结果。
 * - `hybrid`  混合：有绑定会话走直控，没有绑定或显式要求隔离时走子智能体。
 *
 * 模式是全局设置（设置页可切换），会写进 `<DSH_HOME>/codex-link/ui.json`；
 * 工具调用里也可以用 `mode` 参数临时覆盖。
 *
 * @module dsh-plugin-codex-link/modes
 */

/** 全部模式。顺序即设置页的展示顺序。 */
export const MODES = Object.freeze([
  Object.freeze({
    id: 'direct',
    label: '直控会话',
    description: 'DSH 直接驱动已绑定的 Codex 会话：发送指令、实时读过程、可追加或中止。',
  }),
  Object.freeze({
    id: 'subagent',
    label: '子智能体',
    description: 'codex_task 每次起一个独立 Codex 进程执行任务，只回最终结果，不占用你正在看的会话。',
  }),
  Object.freeze({
    id: 'hybrid',
    label: '混合',
    description: '有绑定会话时直控；没有绑定或任务要求隔离时，用子智能体独立执行。',
  }),
]);

/** 默认模式；与 cordis.patch.yml 的 `mode` 默认值保持一致。 */
export const DEFAULT_MODE = 'hybrid';

/** 模式 id 列表。 */
export const MODE_IDS = Object.freeze(MODES.map((mode) => mode.id));

/**
 * 取一个合法模式 id，非法时回退。
 *
 * @param {unknown} value 原始值。
 * @param {string} [fallback] 回退模式。
 * @returns {string} 模式 id。
 */
export function resolveMode(value, fallback = DEFAULT_MODE) {
  return typeof value === 'string' && MODE_IDS.includes(value) ? value : fallback;
}

/**
 * 取模式的展示信息。
 *
 * @param {string} id 模式 id。
 * @returns {{ id: string, label: string, description: string }} 模式信息。
 */
export function describeMode(id) {
  return MODES.find((mode) => mode.id === id) ?? MODES[MODES.length - 1];
}

/**
 * 决定 `codex_task` 的实际执行通道。
 *
 * @param {{ requested?: string, pluginMode: string, hasBinding: boolean }} options 决策输入。
 * @returns {'isolated' | 'session'} 实际通道。
 */
export function resolveTaskChannel(options) {
  const requested = options.requested === 'isolated' || options.requested === 'session' ? options.requested : 'auto';
  if (requested === 'isolated' || requested === 'session') return requested;
  if (options.pluginMode === 'subagent') return 'isolated';
  if (options.pluginMode === 'direct') return 'session';
  return options.hasBinding ? 'session' : 'isolated';
}
