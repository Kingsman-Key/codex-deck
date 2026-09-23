# 为 Codex Deck 贡献

感谢你帮助改进 Codex Deck。提交 Issue 或 Pull Request 前，请先搜索是否已有相同问题。

## 本地开发

需要 Node.js 24 和 npm。克隆仓库后运行：

```bash
npm ci
npm run dev
```

提交代码前至少运行：

```bash
npm run verify
npm audit --audit-level=moderate
```

Electron 主进程、打包或 UI 有实质变化时，还应运行 `npm run pack` 并实际打开生产应用检查相关界面。

## 安全边界

- 不要提交真实 API Key、Token、Cookie、`auth.json`、CC Switch 数据库或运行时状态。
- 每个 Codex 实例必须保持独立 `CODEX_HOME` 与 `--user-data-dir`。
- CC Switch 来源数据库只能以只读方式访问。
- 远程自定义 provider 必须使用 HTTPS；只有本地回环地址允许 HTTP。
- 第三方代码和素材必须有清晰且兼容的许可证，并在 PR 中说明来源。

## Pull Request

请保持改动范围清晰，在说明中列出行为变化、验证方式和仍待确认的平台。新增或修改业务文件时同步更新就近的 `项目进度.md` 和根目录索引。
