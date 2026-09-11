# Zeta · 文件标签管理器

> **English:** [README.en.md](README.en.md)

一个轻量、跨平台的桌面文件管理器，核心亮点是**基于文件名的标签系统**：给文件打标签、删标签，本质上就是一次改名，无需任何数据库。

> 标签即改名：从文件名里第一个 `#` 开始，每个 `#xxx` 段就是一个标签。
> `文档_报告#项目#2024.pdf` → 基础名 `文档_报告`，标签 `项目`、`2024`。

## 截图预览

> TODO：待补充截图

## 特性

- **标签即改名**：打标签/删标签走系统重命名，无 SQLite、无 Excel 解析、无搜索内核，轻量纯粹。
- **原生文件资源管理器**：浏览目录、驱动器切换、面包屑、前进/后退/上一级。
- **标签侧栏**：实时统计当前目录各标签的文件数，点击即可为选中文件打上该标签。
- **彩色类型图标**：按扩展名区分文件类型，视觉上快速定位。
- **完整的键盘导航**：与系统资源管理器一致的交互体验。
  - 方向键移动选中，`Shift` 范围多选，`Ctrl`(macOS `⌘`) 仅移动光标
  - `Ctrl+A` 全选 · `Esc` 清除 · `Enter` 打开 · `←` 上级
  - `F2` 行内重命名 · `F5` 刷新 · 直接敲字符按名称前缀定位
- **跨平台无边框窗口**：自定义标题栏，Windows/Linux 右侧控制、macOS traffic-light 红绿灯。

## 技术栈

| 层 | 技术 |
| --- | --- |
| 桌面框架 | Tauri 2（Rust） |
| 前端 | React 18 + TypeScript + Vite 5 |
| 后端 | Rust，文件操作通过 `#[tauri::command]` 暴露 |
| 打包 | `tauri-bundler`（macOS 产出 dmg；Windows 只产绿色 exe 并手动压 zip，不生成安装包） |

## 标签约定

- 文件名从**第一个 `#`** 开始解析，每个 `#xxx` 段为一个标签。
- 第一个 `#` 之前的部分为**基础名**（不含扩展名）。
- 文件名解析统一在 Rust 侧完成，前端不做二次解析。

## 开发

前置依赖：[Node.js ≥ 18](https://nodejs.org/) 与 [Rust](https://www.rust-lang.org/tools/install)。

```bash
# 1. 安装前端依赖
npm install

# 2. 启动开发模式（前端热更新 + Rust 后端）
npm run tauri dev
```

> Windows PowerShell 若因脚本执行策略拦 `npm`，改用 `npm.cmd`。

### 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run tauri dev` | 开发模式运行 |
| `npm run tauri build` | 构建发行版（macOS 产出 dmg） |
| `npm run tauri build -- --no-bundle` | Windows 绿色包：不生成任何安装包（含 NSIS），随后手动把 `target/release/zeta.exe` 压成 `Zeta-win64-v<版本号>.zip` |
| `cargo check`（在 `src-tauri/`） | 检查 Rust 编译错误 |
| `tsc --noEmit` | 检查前端类型错误 |

## 发布构建（GitHub Actions）

仓库已配置 `.github/workflows/release.yml`：推送到 `v*` 格式的标签时，自动在 Windows / macOS 上构建并上传到 GitHub Releases。

```bash
git tag v0.1.5
git push origin --tags
```

> macOS 仅产出 Apple Silicon（aarch64）dmg，未提供 Intel x64 包。

> 当前未配置代码签名与公证：Windows 产物会有 SmartScreen 提示，macOS 产物为 ad-hoc 签名，本机可运行。

## 命令一览（Tauri）

| 命令 | 作用 |
| --- | --- |
| `list_dir` | 列出目录内容并解析标签 |
| `list_subdirs` | 列出子文件夹完整路径（地址栏面包屑下钻） |
| `get_drives` | 获取 Windows 盘符（跨平台返回空） |
| `get_default_dir` | 默认打开目录（下载目录回退到家目录） |
| `get_home_dir` | 用户主目录（地址栏 `~` 展开） |
| `add_tag` / `remove_tag` | 打标签 / 删标签（重命名 + 入撤销栈） |
| `set_tag_separator` | 同步标签分隔符到后端内存态（持久化由前端负责） |
| `rename_file` | 重命名（入撤销栈） |
| `delete_file` | 移动到回收站（UNC 路径改为永久删除，不入撤销栈） |
| `dissolve_folder` | 解散文件夹：子项上移到上级并删除空壳（可撤销） |
| `collect_into_folder` | 收入文件夹：新建文件夹并把选中项移入（可撤销） |
| `read_text_preview` | 读取文本文件前 1 MiB 用于预览面板 |
| `undo` / `redo` / `can_undo` / `can_redo` | 撤销栈操作与查询 |

> 说明：`undo` / `redo` / `delete_file` 后端已实现并注册，但界面尚未接入（无 `Ctrl+Z` / `Delete` 快捷键与菜单项），进度见 [PLAN.md](PLAN.md)。

## 目录结构

```
├── src/                 # React 前端
│   ├── App.tsx          # 主视图与交互
│   ├── api.ts           # Tauri 命令封装（invoke）
│   ├── types.ts         # 前后端共享类型
│   └── styles.css       # 全局样式
├── src-tauri/           # Rust 后端
│   ├── src/lib.rs       # 命令层 + 标签解析 + 撤销栈
│   └── tauri.conf.json  # 窗口与打包配置
└── .github/workflows/   # CI 发布构建
```

## 许可证

本项目基于 [Apache License 2.0](LICENSE) 开源发布，你可以自由使用、修改、分发，但请保留版权与许可声明。