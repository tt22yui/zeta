# Changelog

本项目的所有重要变更都会记录在此文件中。

## [v0.1.2] - 2026-09-02

### 工程改进

- GitHub Actions 发布工作流增加 npm 依赖缓存（`setup-node` 配置 `cache: npm`），复用 `package-lock.json` 缓存 `node_modules`，缩短 CI 安装耗时。

### 文档

- AGENTS.md 新增「发布日志」章节，沉淀各版本发布记录。

