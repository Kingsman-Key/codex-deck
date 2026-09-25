# Codex Deck

[![CI](https://github.com/Kingsman-Key/codex-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/Kingsman-Key/codex-deck/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Kingsman-Key/codex-deck?include_prereleases)](https://github.com/Kingsman-Key/codex-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-7CFFB2.svg)](LICENSE)

一个真正“多开”而不是“切号”的 Codex 桌面启动器。

首页固定提供一个受保护的“当前 Codex”入口，直接使用原来的 `~/.codex`，因此旧聊天和现有登录不会消失。新增配置则各自使用独立的 `CODEX_HOME` 与 Chromium `--user-data-dir`，所以工作账号、个人账号、DeepSeek 和其他 Responses 兼容模型可以同时运行。回到 Codex Deck，点击卡片即可打开或聚焦对应窗口，不需要退出账号、替换全局 `auth.json` 或重启 Codex。

> 当前首版已在 macOS Apple Silicon 上完成构建与真实启动验证。Windows 启动路径和聚焦逻辑已经预留，但还需要 Windows 实机回归。

## 下载

从 [GitHub Releases](https://github.com/Kingsman-Key/codex-deck/releases) 获取 macOS Apple Silicon 的 DMG/ZIP 或 Windows x64 的安装版/免安装版 EXE，也可以克隆源码后自行构建。当前安装包尚未签名：macOS 首次打开可能需要在 Finder 中右键选择“打开”，Windows 可能显示 SmartScreen 提示。

## 已实现

- 卡片式配置总控台，点击启动或切回对应 Codex 窗口。
- Codex Deck 重启后会重新识别仍在运行的 macOS 窗口并按 `--user-data-dir` 聚焦，不会重复启动同一个隔离配置。
- 受保护的“当前 Codex”入口直接复用原 `~/.codex`，保留旧聊天和当前登录。
- 其余配置隔离登录、浏览器状态、会话数据库、日志与缓存。
- 独立配置启动前会安全同步主 Codex 的本地项目目录、排序与展开状态；只迁移目标已有线程的项目归属，不复制设备标识、推送令牌或整份全局状态。
- ChatGPT 账号：首次打开独立窗口后完成一次正常登录。
- ChatGPT 账号可选复制当前文件型 `auth.json` 到自己的隔离配置；API profile 缺少桌面登录时也会单次复制，用于通过 Codex 桌面壳的登录门槛，均不修改原文件或覆盖目标已有认证。
- 隔离配置可一键把当前 Codex 中相同 `model_provider` 的旧会话复制到自己的目录，原目录不做修改。
- 历史工具支持导出可读 Markdown/JSONL 副本，也可以把 A provider 的会话复制给 B provider 并改写目标 provider 标签。
- “复制上下文并切到目标”会读取来源最近会话、写入剪贴板并聚焦目标窗口，再按 `Cmd/Ctrl+V` 粘贴。
- profile 可设置启动时自动复制当前 Codex 最新上下文并打开该配置，默认关闭。
- profile 也可设置启动时从主库增量同步该 provider 的新增历史；已有目标记录不会被删除。
- CC Switch 导入的非 ChatGPT provider 默认启用历史自动同步；不同 OpenAI 账号保持独立，避免同 `openai` tag 串历史。
- 从 CC Switch 导入的 profile 可以重新注入保存过的 OAuth/API 登录态，避免 Safari 回调必须回到默认 Codex 实例。
- DeepSeek 官方 API 预设：使用 `https://api.deepseek.com` 的 Responses API；隔离实例会生成受控模型目录，可在 Codex 模型选择器中切换 `deepseek-flash` 与 `deepseek-v4-pro`，推理强度提供低、高、最大三档（默认高）。
- DeepSeek 模型请求由隔离配置和系统安全存储中的 DeepSeek Key 路由；本地复制的 Codex 登录文件只负责桌面壳，不会把 provider 改回 OpenAI。
- 自定义 OpenAI Responses 兼容接口、Base URL 和模型 ID。
- 启动时只读发现 CC Switch 的 Codex 配置，确认后可批量导入，不修改 CC Switch 数据库。
- 导入时保留经净化的 provider TOML；旧模型目录作为来源副本留存，但不会在未通过当前 schema 校验时挂载到运行配置。API Key 进入系统安全存储，OAuth 登录态只写入对应实例的隔离 `auth.json`。
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

生成 Windows x64 安装版和免安装版（推荐在 Windows 或项目的 Windows GitHub Actions 中运行）：

```bash
npm run dist:win
```

未签名的本地构建只适合自己使用。正式发布仍需配置 Apple Developer ID 签名与公证。

### Windows 预览版

Windows 版提供 `Setup` 安装程序和 `Portable` 免安装程序。目标机器需先安装官方 ChatGPT/Codex 桌面应用；OpenAI 当前通过 Microsoft Store 分发，也可以运行 `winget install --id 9PLM9XGG6VKS -s msstore`。如果 Codex Deck 没有自动找到桌面程序，可在设置中手动选择可执行文件。[OpenAI：ChatGPT desktop app for Windows](https://learn.chatgpt.com/docs/windows/windows-app)

Windows 包由 `windows-latest` 原生 GitHub Actions runner 构建并执行同一套类型检查与测试，但多实例启动、窗口聚焦、退出以及 Microsoft Store 安装路径仍需 Windows 10/11 实机回归。WSL 项目可以由官方应用处理，Codex Deck 自身仍运行在 Windows 用户环境中。

## 使用方式

1. 需要旧聊天或原登录时，直接点第一张“当前 Codex”卡片。
2. 需要多开账号或模型时，点“添加配置”并选择连接方式：
   - **ChatGPT 账号**：创建后点卡片，在出现的独立 Codex 窗口登录一次。
   - **DeepSeek 官方 API**：填写 DeepSeek Key，默认直连官方 Responses API。
   - **DeepSeek · OpenRouter**：兼容旧配置；填写 OpenRouter Key 和对应模型 ID。
   - **自定义 Responses**：填写兼容 OpenAI Responses API 的地址、模型和 Key。
3. 日常使用时只打开 Codex Deck，点击不同卡片即可进入对应窗口。“原有历史”和“独立历史”徽标会提示数据边界。

DeepSeek 已提供 Responses API，Codex Deck 默认按 DeepSeek 官方 Codex 集成方式直连，不再要求先经过 OpenRouter。旧版 `deepseek-v4-flash` 会迁移为当前 `deepseek-flash`；隔离实例启动时会重建经过当前 Codex schema 验证的 `deepseek-models.json`，模型选择器可在 `deepseek-flash` 和 `deepseek-v4-pro` 间切换。Deck 同时写入 Codex 桌面端推理档位白名单，再与模型目录声明的能力取交集，因此 DeepSeek 模型显示低、高、最大三档而不是误缺“最大”。模型目录和桌面配置都在 Codex 启动时读取，因此升级后需要先关闭对应 DeepSeek 窗口，再从 Codex Deck 重新打开。[DeepSeek Codex 集成指南](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) · [DeepSeek Responses API](https://api-docs.deepseek.com/api/create-response/)

### 为什么独立窗口看不到旧聊天？

这是隔离生效后的正常边界，不是聊天被删除。不同 `CODEX_HOME` 不共享配置、认证和会话历史；所以原聊天仍在 `~/.codex`，从“当前 Codex”入口打开即可看到。独立窗口不能共享或链接正在写入的 SQLite/会话目录，否则并发运行可能造成串号或状态损坏。API/DeepSeek profile 会在缺少桌面认证时单次复制当前 Codex 的文件型登录，只用于通过桌面壳；模型请求仍由该 profile 的 `model_provider` 和加密 API Key 直接路由到 DeepSeek。点击卡片上的“历史工具”可以迁移旧历史、导出可读副本，或把 A provider 的会话复制给 B provider；这些操作只复制匹配 `model_provider` 的索引、JSONL 和消息库，目标已有记录时会拒绝覆盖。跨 provider 转移主要保证能查看，续写旧会话可能因 `encrypted_content` 无法由另一个后端解密而失败。[Codex 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)

### 为什么独立窗口只剩“最近聊天”，项目文件夹不见了？

项目文件夹通常仍在本机，丢失的是隔离窗口自己的侧边栏项目目录缓存。v0.3.2 会在目标实例停止时、下一次启动前，从“当前 Codex”同步项目目录、顺序、展开状态和目标已有聊天的项目归属；写入前会保留 `.codex-global-state.json.codex-deck-backup`，不会复制整份账号/设备状态，也不会触碰运行中实例的 SQLite。更新后先关闭对应 DeepSeek/Codex 窗口，再从 Codex Deck 打开一次即可。Codex 的本地项目本来就是由文件夹组成，并在 Projects 视图中显示。[OpenAI：Projects and chats](https://learn.chatgpt.com/docs/projects)

## 从 CC Switch 导入

Codex Deck 启动时会自动只读检查 `~/.cc-switch/cc-switch.db`。发现尚未导入的 Codex 配置后，首页会显示提示；也可以从设置页手动打开导入窗口。

1. 在导入窗口核对配置名称、认证类型、模型和兼容性。
2. 勾选需要的配置，点击“导入所选配置”。
3. 导入完成后直接点击对应卡片，每个配置仍使用独立的 Codex 状态和桌面登录目录。

导入不会修改或删除 CC Switch 中的任何内容，也不会在预览界面显示 Key、Token 或 Cookie。远程 HTTP provider 会按安全规则禁用；localhost、127.0.0.1 和 ::1 仍允许 HTTP。重复导入会根据来源 ID 识别并跳过。

## 隔离结构

```text
~/.codex/                         # “当前 Codex”：原登录与原聊天，原地使用

Codex Deck state/                 # 其余配置：严格隔离
├── profiles.json                  # 名称、颜色、provider 等非敏感元数据
├── secrets.json                   # safeStorage 加密后的 API Key
└── profiles/<profile-id>/
    ├── codex-home/
    │   ├── config.toml            # 该配置的 provider/model
    │   ├── auth.json              # 隔离桌面壳认证；API 请求另由安全存储中的 Key 路由
    │   ├── deepseek-models.json   # DeepSeek profile：Deck 生成并校验的可选模型目录
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

前两个变量隔离 Codex 状态，最后一个参数隔离桌面应用登录与 Electron 单实例锁。“当前 Codex”不设置这些覆盖项，直接打开原环境；其余卡片绝不共享可写的会话数据库。这正是“多个窗口同时存在”和普通账号切换器之间的关键差别。

同一个 provider 的多个账号不能靠 `model_provider` 区分：两个 OpenAI 账号都会写入 `openai` 标签。因此 Codex Deck 不对 ChatGPT/OpenAI profile 默认做主库历史合并，每个账号继续使用自己的 `CODEX_HOME` 保留独立历史；需要跨账号使用某段上下文时，使用“复制上下文并切到目标”或显式历史转移。

## 借鉴与取舍

调研时间：2026-09-23。星数来自当日 GitHub API，只用于判断社区活跃度。

| 项目 | 当日 Stars | 许可证 | 借鉴内容 / 取舍 |
| --- | ---: | --- | --- |
| [farion1231/cc-switch](https://github.com/farion1231/cc-switch) | 134,137 | MIT | 借鉴清晰的 provider 管理体验；没有沿用“修改全局配置后重启”的切换模式。 |
| [jlcodes99/cockpit-tools](https://github.com/jlcodes99/cockpit-tools) | 18,296 | CC BY-NC-SA 4.0（README；GitHub 未识别） | 借鉴“默认实例 + 独立实例初始化模式”的产品结构，形成“当前 Codex”入口和缺失认证补全；许可证与本项目 MIT/公开商用边界不兼容，因此未复制代码。 |
| [Lampese/codex-switcher](https://github.com/Lampese/codex-switcher) | 836 | 未声明 | 参考 Tauri 桌面交互与安全关注点；未复制代码。它仍要求切换前关闭 Codex。 |
| [JqyModi/codex-multi-launcher](https://github.com/JqyModi/codex-multi-launcher) | 140 | 未声明 | 产品目标最接近；仓库只公开网站和安装包且无许可证，因此未复用程序代码。 |
| [nhocconan/codex-multi](https://github.com/nhocconan/codex-multi) | 1 | MIT | 借鉴“一配置一 `CODEX_HOME`”与共享 skills 的边界。它只覆盖 CLI，本项目扩展到桌面多窗口。 |
| [thomast8/doppel](https://github.com/thomast8/doppel) | 5 | MIT | 借鉴 Electron 用户目录隔离和独立窗口的思路；首版不克隆/重签整个应用包，减少更新复杂度。 |

实现依据也与 OpenAI 当前公开行为一致：[`CODEX_HOME` 是配置、认证、日志、会话和 skills 的状态根目录](https://learn.chatgpt.com/docs/config-file/environment-variables)，而自定义 provider 的 `wire_api` 目前只支持 [`responses`](https://learn.chatgpt.com/docs/config-file/config-reference)。

## 安全边界

- 不读取浏览器 Cookie，不上传登录态，不提供自动轮换账号。
- “当前 Codex”是唯一允许原地使用 `~/.codex` 的受保护入口；其他实例不共享、软链接或复制正在写入的会话 SQLite 数据库。
- API/DeepSeek 配置仅在目标缺少 `auth.json` 时单次复制当前文件型登录，绝不覆盖；provider Key 仍单独加密并在进程启动时注入。
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
