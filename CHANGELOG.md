# Changelog

本项目遵循语义化版本；每次发布在此记录一行摘要。

## 0.1.0 — 2026-10-28

- 首个版本：`dsh-plugin-codex-link` Host 插件。
- 9 个工具：`codex_status`、`codex_threads`、`codex_use`、`codex_send`、`codex_watch`、`codex_result`、`codex_interrupt`、`codex_usage`、`codex_open_project`。
- 通过 Codex 自带的 `codex app-server`（JSON-RPC over stdio）驱动 Codex，Codex 侧无需安装插件。
- 支持按 ID / 前缀 / 序号 / 标题切换目标会话，绑定持久化。
- 增量读取运行过程（工具调用、命令退出码、文件改动、错误、回合结束），游标续读。
- 默认工作区 `C:\Users\Bolin\Desktop\DSH\Wechat`，默认会话 `微信工作区（DSH）`，缺失时自动创建。
- 审批默认拒绝并记录；沙箱默认 `workspace-write` 且禁网。
- 参考 `dsh-plugin-infj-pet`（session-ee1ce3b5）的打包与测试风格、`dsh-peak-runner` 的宿主插件写法。
