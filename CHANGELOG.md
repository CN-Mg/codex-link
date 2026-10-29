# Changelog

本项目遵循语义化版本；每次发布在此记录一行摘要。

## 0.3.0 — 2026-10-29

- 工作区可配置化：
  - 插件配置 `workspaceRoot` 留空时自动解析：当前 DSH 会话目录 → 用户主目录（逐级检查目录是否存在）；
  - 设置页新增「工作区」卡片与文件夹浏览器：可浏览、选择、用主目录、恢复自动，保存到 `ui.json`；
  - 工具（会话列举/新建/子任务/打开项目）统一使用解析后的工作区。
- 默认会话名改为通用的「DSH 工作区」；已有绑定不受影响。
- 设置页路由新增 `POST /workspace`、`GET /fs`，并补充对应单测。
- 其他机器安装后**无需改配置即可运行**（会落到当前会话目录或主目录）。

## 0.2.2 — 2026-10-29

- 设置页路由增加诊断日志 <DSH_HOME>/codex-link/route.log：记录注册成功/失败、webServer 是否就绪与失败原因，便于再次出现 404 时定位。
## 0.2.1 — 2026-10-29

- 修复设置页面板「读取失败：HTTP 404」：宿主 webServer 可能在插件 pply() 之后才就绪，
  改用 ctx.inject(['webServer'], …) 等待服务再注册路由，避免设置页拿不到 /.dsh-codex-link 数据。
- 设置页路由注册成功时写入日志 设置页路由已注册：/.dsh-codex-link，便于排查。
## 0.2.0 — 2026-10-29

- 新增 `codex_task` 工具：把整件事交给 Codex 子智能体执行，只回最终回答、线程 id、耗时与用量。
  - `channel=isolated` 用 `codex exec --json` 独立进程执行，不占用桌面端正打开的会话，也不与其抢写；
  - `channel=session` 在绑定会话里执行并等结果；
  - `auto` 按当前操作方式与绑定情况决定。
- 新增三种操作方式与切换：**直控会话 / 子智能体 / 混合**（默认混合），保存在 `<DSH_HOME>/codex-link/ui.json`。
- 新增设置页左侧面板（client plugin）：`设置 → Codex 联动`，参考微信插件的 `settings.section` 面板机制。
  - 卡片式切换操作方式，立即生效；
  - 显示 app-server 状态、Codex 版本、默认工作区、当前默认会话；
  - 会话列表（只看默认工作区 / 全部），一键设为默认会话。
- 新增宿主路由 `/.dsh-codex-link`（state/sessions/mode/bind/client-error），无 `webServer` 时自动降级。
- 子任务并发上限（`maxParallelTasks`，默认 2）、超时与进程树清理。
- system prompt 指南补充操作方式、`codex_task` 用法与选择面板说明。

## 0.1.0 — 2026-10-28

- 首个版本：`dsh-plugin-codex-link` Host 插件。
- 9 个工具：`codex_status`、`codex_threads`、`codex_use`、`codex_send`、`codex_watch`、`codex_result`、`codex_interrupt`、`codex_usage`、`codex_open_project`。
- 通过 Codex 自带的 `codex app-server`（JSON-RPC over stdio）驱动 Codex，Codex 侧无需安装插件。
- 支持按 ID / 前缀 / 序号 / 标题切换目标会话，绑定持久化。
- 增量读取运行过程（工具调用、命令退出码、文件改动、错误、回合结束），游标续读。
- 默认工作区 `C:\Users\Bolin\Desktop\DSH\Wechat`，默认会话 `微信工作区（DSH）`，缺失时自动创建。
- 审批默认拒绝并记录；沙箱默认 `workspace-write` 且禁网。
- 参考 `dsh-plugin-infj-pet`（session-ee1ce3b5）的打包与测试风格、`dsh-peak-runner` 的宿主插件写法。
