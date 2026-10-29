/**
 * 工具定义（模型可见面）。
 *
 * 这里刻意**不 import 任何 @deepseek-ai/* 包**：DSH 宿主在加载插件时提供工具
 * 注册服务，工具规格用原生 JSON Schema 即可。这样插件在测试环境里也能被
 * 直接 import，不依赖 profile 的 peer 依赖。
 *
 * 所有工具统一返回 `{ text }`，由渲染函数输出为一段文本块。
 *
 * @module dsh-plugin-codex-link/tools
 */

/** 统一输出形状：一段给模型读的文本。 */
const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: { text: { type: 'string' } },
    required: ['text'],
  },
  /**
   * 把返回值渲染成文本块。
   *
   * @param {unknown} _args 调用参数（未使用）。
   * @param {{ text?: unknown }} value 工具返回值。
   * @returns {Array<{ type: 'text', text: string }>} 文本块。
   */
  render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : String(value ?? '') }],
};

/**
 * 构造一个工具规格，并把异常统一转换成 `错误码: 说明` 的文本。
 *
 * @param {string} name 工具名。
 * @param {string} description 给模型看的说明。
 * @param {Record<string, unknown>} parameters JSON Schema。
 * @param {(args: any, exec: any) => Promise<string>} body 执行体。
 * @returns {Record<string, unknown>} 工具规格。
 */
function makeTool(name, description, parameters, body) {
  return {
    name,
    description,
    parameters,
    output: TEXT_OUTPUT,
    /**
     * 执行工具。
     *
     * @param {any} args 模型参数。
     * @param {any} exec 执行上下文（`signal`、`agent`）。
     * @returns {Promise<{ text: string }>} 文本结果。
     */
    async execute(args, exec) {
      try {
        const text = await body(args ?? {}, exec ?? {});
        return { text: typeof text === 'string' ? text : String(text) };
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'ERROR';
        const message = error instanceof Error ? error.message : String(error);
        return { text: `${code}: ${message}` };
      }
    },
  };
}

/**
 * 构造全部工具规格。
 *
 * @param {{
 *   controller: {
 *     status: () => Promise<string>,
 *     threads: (args: any) => Promise<string>,
 *     use: (args: any, sessionId: string) => Promise<string>,
 *     send: (args: any, sessionId: string) => Promise<string>,
 *     watch: (args: any, sessionId: string) => Promise<string>,
 *     result: (args: any, sessionId: string) => Promise<string>,
 *     interrupt: (args: any, sessionId: string) => Promise<string>,
 *     usage: () => Promise<string>,
 *     openProject: (args: any) => Promise<string>,
 *   },
 * }} dependencies 控制器。
 * @returns {Array<Record<string, unknown>>} 工具规格列表。
 */
export function buildToolSpecs({ controller }) {
  /**
   * 从执行上下文里取当前 DSH 会话 ID。
   *
   * @param {any} exec 执行上下文。
   * @returns {string} DSH 会话 ID，取不到时返回空串。
   */
  const sessionIdOf = (exec) => {
    const candidate = exec?.agent?.session?.id;
    return typeof candidate === 'string' ? candidate : '';
  };

  return [
    makeTool(
      'codex_status',
      '查看 Codex 联动状态：app-server 连接、Codex 版本与可执行文件路径、默认工作区/默认会话、当前 DSH 会话绑定的 Codex 会话。排查问题或确认环境时先调它。',
      { type: 'object', properties: {}, additionalProperties: false },
      () => controller.status(),
    ),
    makeTool(
      'codex_threads',
      '列出 Codex 会话（序号、短 ID、标题、目录、状态、更新时间）。默认只看默认交互工作区；传 all=true 查看全部会话，query 按标题搜索。切换会话前先用它或直接 codex_use。',
      {
        type: 'object',
        properties: {
          query: { type: 'string', description: '按会话标题搜索的片段（可选）。' },
          limit: {
            type: 'integer',
            description: '最多返回多少条，默认 15，上限 50。',
            minimum: 1,
            maximum: 50,
          },
          all: { type: 'boolean', description: 'true 时不按默认工作区过滤，列全部会话。' },
        },
        additionalProperties: false,
      },
      (args) => controller.threads(args),
    ),
    makeTool(
      'codex_use',
      '切换当前 DSH 会话要操作的 Codex 会话。thread 支持：完整会话 ID、ID 前缀（≥6 位）、codex_threads 输出的序号、标题或标题片段。唯一匹配才切换，多个匹配会返回候选。create=true 时在默认工作区新建会话并绑定。绑定会持久化，DSH 重启后仍生效。',
      {
        type: 'object',
        properties: {
          thread: {
            type: 'string',
            description: '目标会话引用：ID、ID 前缀、序号、标题或标题片段。create=true 时可省略。',
          },
          create: { type: 'boolean', description: 'true 表示在默认工作区新建一个 Codex 会话并绑定。' },
        },
        additionalProperties: false,
      },
      (args, exec) => controller.use(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_send',
      '向当前绑定（或 thread 指定的）Codex 会话发送一条指令并启动回合。返回 turnId 后请用 codex_watch 跟踪过程、用 codex_result 取结果。会话正在运行且由 DSH 发起时，mode="steer" 可追加要求；mode="interrupt" 直接中止当前回合。默认不会覆盖用户正在其它 Codex 窗口里执行的回合（会返回 BUSY_THREAD）。',
      {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要交给 Codex 的完整指令文本。' },
          thread: { type: 'string', description: '临时指定会话（ID/标题等）；省略则用当前绑定或默认会话。' },
          mode: {
            type: 'string',
            enum: ['auto', 'steer', 'interrupt'],
            description: 'auto=空闲则新开回合、运行中则追加；steer=强制追加到当前回合；interrupt=中止当前回合。',
          },
          wait: {
            type: 'boolean',
            description: 'true 时在工具内等待回合结束并直接返回结果（默认 false，先返回 turnId 用 watch 跟踪）。',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      (args, exec) => controller.send(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_task',
      '派遣一个 Codex 子任务（子智能体）：把整件事交给 Codex 执行，只返回最终回答、线程 id、耗时与用量。channel=auto 时按当前操作方式决定：混合/直控且有绑定会话→在绑定会话里执行；子智能体模式或没有绑定→起独立 Codex 进程执行（不占用你正在看的会话，也不会出现在你打开的对话里）。需要盯过程或中途干预时改用 codex_send + codex_watch。',
      {
        type: 'object',
        properties: {
          task: { type: 'string', description: '要 Codex 完成的完整任务描述，原样传递，不要添加来源前缀。' },
          channel: {
            type: 'string',
            enum: ['auto', 'isolated', 'session'],
            description: 'auto=按当前操作方式与绑定情况决定；isolated=独立进程（子智能体）；session=在绑定会话里执行。',
          },
          thread: { type: 'string', description: 'channel=session 时指定会话（ID/标题等）；省略则用当前绑定或默认会话。' },
          cwd: { type: 'string', description: 'channel=isolated 时的工作目录；省略用默认工作区。' },
          sandbox: {
            type: 'string',
            enum: ['read-only', 'workspace-write', 'danger-full-access'],
            description: 'channel=isolated 时的沙箱；省略用插件配置的 sandbox。',
          },
          model: { type: 'string', description: '可选模型名（isolated 通道生效）。' },
          timeoutMs: {
            type: 'integer',
            description: '子任务超时毫秒数，默认用插件 requestTimeoutMs。',
            minimum: 1000,
            maximum: 3600000,
          },
        },
        required: ['task'],
        additionalProperties: false,
      },
      (args, exec) => controller.task(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_watch',
      '增量读取 Codex 运行过程：工具调用、命令执行与退出码、文件改动、助手消息、错误、回合结束。传回上次返回的 cursor 即可续读。默认短等 8 秒；没有新事件时返回当前状态与同一游标。detail="full" 时附带命令输出与流式片段。',
      {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '会话引用；省略则用当前绑定或默认会话。' },
          cursor: { type: 'string', description: '上次 codex_watch 返回的游标；省略则返回缓冲区内的历史事件。' },
          waitMs: {
            type: 'integer',
            description: '没有事件时最多短等多少毫秒，默认 8000，上限 20000。',
            minimum: 0,
            maximum: 20000,
          },
          detail: {
            type: 'string',
            enum: ['summary', 'full'],
            description: 'summary 只给关键进度；full 额外包含命令输出与流式片段。',
          },
        },
        additionalProperties: false,
      },
      (args, exec) => controller.watch(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_result',
      '取 Codex 回合的最终结果：回答文本、状态、耗时、token 用量。默认取当前绑定会话最近完成的回合；也可指定 thread 或 turnId 回查。',
      {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '会话引用；省略则用当前绑定或默认会话。' },
          turnId: { type: 'string', description: '指定回合 ID；省略则取最近完成的回合。' },
        },
        additionalProperties: false,
      },
      (args, exec) => controller.result(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_interrupt',
      '中止指定 Codex 会话（默认当前绑定）正在运行的回合。',
      {
        type: 'object',
        properties: {
          thread: { type: 'string', description: '会话引用；省略则用当前绑定或默认会话。' },
        },
        additionalProperties: false,
      },
      (args, exec) => controller.interrupt(args, sessionIdOf(exec)),
    ),
    makeTool(
      'codex_usage',
      '查询 Codex 账号额度：5 小时窗口与 7 天窗口的已用百分比、剩余百分比、重置时间，以及套餐类型。数据来自 Codex app-server 的 account/rateLimits/read，不是估算。',
      { type: 'object', properties: {}, additionalProperties: false },
      () => controller.usage(),
    ),
    makeTool(
      'codex_open_project',
      '把 Codex 桌面端窗口带到默认工作区（或 cwd 指定的项目）。这是项目级操作，不会改变当前绑定的会话。',
      {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: '要打开的项目目录；省略则用默认工作区。' },
        },
        additionalProperties: false,
      },
      (args) => controller.openProject(args),
    ),
  ];
}
