# Codex Deck

[![CI](https://github.com/Kingsman-Key/codex-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Kingsman-Key/codex-deck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Kingsman-Key/codex-deck?include_prereleases)](https://github.com/Kingsman-Key/codex-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-7CFFB2.svg)](LICENSE)

一个真正“多开”而不是“切号”的 Codex 桌面启动器。

每个配置都有独立的 `CODEX_HOME` 与 Chromium `--user-data-dir`，所以工作账号、个人账号、DeepSeek 和其他 Responses 兼容模型可以同时运行。回到 Codex Deck，点击卡片即可打开对应窗口；已经运行时则直接聚焦，不需要退出账号、替换 `auth.json` 或重启 Codex。

> 当前首版已在 macOS Apple Silicon 上完成构建与真实启动验证。Windows 启动路径和聚焦逻辑已经预留，但还需要 Windows 实机回归。

## 下载

从 [GitHub Releases](https://github.com/Kingsman-Key/codex-deck/releases) 获取最新发布版本。v0.2.0 当前提供 GitHub 自动生成的源码归档；预构建 DMG/ZIP 因发布时大文件上传链路异常缓慢暂未附加，可以克隆源码后运行 `npm ci` 与 `npm run dist` 在本机生成。当前构建尚未使用 Apple Developer ID 签名和公证，因此只建议开发者测试使用；首次打开可能需要在 Finder 中右键应用并选择“打开”。

## 已实现

- 卡片式配置总控台，点击启动或切回对应 Codex 窗口。
- 每个配置隔离登录、浏览器状态、会话数据库、日志与缓存。
- ChatGPT 账号：首次打开独立窗口后完成一次正常登录。
- 可选复制当前文件型 `auth.json` 到新配置，不修改原文件。
- DeepSeek 预设：通过 OpenRouter 的 Responses API 使用 DeepSeek。
- 自定义 OpenAI Responses 兼容接口、Base URL 和模型 ID。
- 启动时只读发现 CC Switch 的 Codex 配置，确认后可批量导入，不修改 CC Switch 数据库。
- 导入时保留兼容的 provider TOML 与模型目录；API Key 进入系统安全存储，OAuth 登录态只写入对应实例的隔离 `auth.json`。
- API Key 使用 Electron `safeStorage` 加密，只在启动目标进程时注入环境变量。
- 启动前清除继承到的 OpenAI/Codex 凭据变量，避免串号。
- Skills 与 Plugins 复用主 `~/.codex` 目录，其余状态保持隔离。
- 删除配置时把数据移入系统废纸篓，而不是直接永久删除。
- `⌘/Ctrl + 1…9` 快速打开前九个配置。

## 直接运行

```bash
npm install
npm run dev
```

生成本机应用：

```bash
npm run pack
open "release/mac-arm64/Codex Deck.app"
```

生成可分发的 DMG/ZIP：

```bash
npm run dist
```

未签名的本地构建只适合自己使用。正式发布仍需配置 Apple Developer ID 签名与公证。

## 使用方式

1. 点“添加配置”。
2. 选择连接方式：
   - **ChatGPT 账号**：创建后点卡片，在出现的独立 Codex 窗口登录一次。
   - **DeepSeek · OpenRouter**：填写 OpenRouter Key，可修改 DeepSeek 模型 ID。
   - **自定义 Responses**：填写兼容 OpenAI Responses API 的地址、模型和 Key。
3. 日常使用时只打开 Codex Deck，点击不同卡片即可进入对应窗口。

DeepSeek 官方 API 当前公开的是 Chat Completions，而 Codex 的自定义 provider 只支持 Responses 协议。因此首版没有假装直连官方 DeepSeek，而是提供已经支持 `/responses` 的 OpenRouter 预设；如果你有自己的 Responses 转换网关，也可以用“自定义 Responses”。

## 从 CC Switch 导入

Codex Deck 启动时会自动只读检查 `~/.cc-switch/cc-switch.db`。发现尚未导入的 Codex 配置后，首页会显示提示；也可以从设置页手动打开导入窗口。

1. 在导入窗口核对配置名称、认证类型、模型和兼容性。
2. 勾选需要的配置，点击“导入所选配置”。
3. 导入完成后直接点击对应卡片，每个配置仍使用独立的 Codex 状态和桌面登录目录。

导入不会修改或删除 CC Switch 中的任何内容，也不会在预览界面显示 Key、Token 或 Cookie。远程 HTTP provider 会按安全规则禁用；localhost、127.0.0.1 和 ::1 仍允许 HTTP。重复导入会根据来源 ID 识别并跳过。

## 隔离结构

```text
Codex Deck state/
├── profiles.json                  # 名称、颜色、provider 等非敏感元数据
├── secrets.json                   # safeStorage 加密后的 API Key
└── profiles/<profile-id>/
    ├── codex-home/
    │   ├── config.toml            # 该配置的 provider/model
    │   ├── auth.json              # 仅该账号可见，可由 Codex 正常刷新
    │   ├── imported-config.toml   # 可选：经脱敏改写的 CC Switch 配置
    │   ├── imported-model-catalog.json # 可选：该配置的模型目录副本
    │   ├── skills -> ~/.codex/skills
    │   └── plugins -> ~/.codex/plugins
    └── browser-data/              # Electron 登录态与单实例锁
```

启动目标窗口时同时设置：

```text
CODEX_HOME=<profile>/codex-home
CODEX_SQLITE_HOME=<profile>/codex-home
--user-data-dir=<profile>/browser-data
```

前两个变量隔离 Codex 状态，最后一个参数隔离桌面应用登录与 Electron 单实例锁。这正是“多个窗口同时存在”和普通账号切换器之间的关键差别。

## 借鉴与取舍

调研时间：2026-09-23。星数来自当日 GitHub API，只用于判断社区活跃度。

| 项目 | 当日 Stars | 许可证 | 借鉴内容 / 取舍 |
| --- | ---: | --- | --- |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 134,137 | MIT | 借鉴清晰的 provider 管理体验；没有沿用“修改全局配置后重启”的切换模式。 |
| [Lampese/codex-switcher](https://github.com/Lampese/codex-switcher) | 836 | 未声明 | 参考 Tauri 桌面交互与安全关注点；未复制代码。它仍要求切换前关闭 Codex。 |
| [JqyModi/codex-multi-launcher](https://github.com/JqyModi/codex-multi-launcher) | 140 | 未声明 | 产品目标最接近；仓库只公开网站和安装包且无许可证，因此未复用程序代码。 |
| [nhocconan/codex-multi](https://github.com/nhocconan/codex-multi) | 1 | MIT | 借鉴“一配置一 `CODEX_HOME`”与共享 skills 的边界。它只覆盖 CLI，本项目扩展到桌面多窗口。 |
| [thomast8/doppel](https://github.com/thomast8/doppel) | 5 | MIT | 借鉴 Electron 用户目录隔离和独立窗口的思路；首版不克隆/重签整个应用包，减少更新复杂度。 |

实现依据也与 OpenAI 当前公开行为一致：[`CODEX_HOME` 是配置、认证、日志、会话和 skills 的状态根目录](https://learn.chatgpt.com/docs/config-file/environment-variables)，而自定义 provider 的 `wire_api` 目前只支持 [`responses`](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 安全边界

- 不读取浏览器 Cookie，不上传登录态，不提供自动轮换账号。
- CC Switch 数据库始终以只读方式扫描；导入只向 Codex Deck 自己的隔离目录写入副本。
- `auth.json` 和 API Key 都按密码处理，不会写入日志或 Git。
- 元数据与加密密钥文件分离，配置文件只保存环境变量名。
- 自定义远端地址必须是 HTTPS；只有 localhost/127.0.0.1/::1 允许 HTTP。
- 本项目是社区工具，与 OpenAI、DeepSeek、OpenRouter 均无隶属或官方合作关系。

## 开发与验证

```bash
npm run typecheck
npm test
npm run build
npm run pack
npm audit --audit-level=moderate
```

项目进度、文件索引和后续里程碑见 [项目进度.md](项目进度.md)。

欢迎提交 Issue 和 Pull Request。开始贡献前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告，不要在公开 Issue 中粘贴 Key、Token、Cookie 或 `auth.json`。
