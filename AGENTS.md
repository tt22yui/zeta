# Zeta — AI 协作规则

> 本文件供 AI 编码助手（Cursor / Claude Code / Codex / Trae 等）在改进、审查、发布本项目时自动遵循。
> 规则来源于本项目的既有硬性约定与历史经验，改动前请优先核对本文件。

## 项目概览

- **Zeta** 是一个基于 **Tauri v2** 的桌面文件管理器（带文件标签功能），**公开开源项目**。

- 后端：Rust。前端：React / TypeScript / Tailwind CSS / Vite。

- 解析/业务纯逻辑集中在 `src-tauri/src/lib.rs`；前端入口 `src/App.tsx`、IPC 封装 `src/api.ts`。

## 发布与打包规范

- **发布包仅包含 macOS dmg 和 Windows zip 绿色包，禁止生成 NSIS 安装包**。

- Windows zip 文件名必须为英文，格式：`Zeta-win64-v<版本号>.zip`。

- macOS dmg 文件名为 `Zeta_x.x.x_*.dmg`。

- 版本号遵循语义化版本；**每次发布包变更需更新版本号**（package.json、src-tauri/Cargo.toml、tauri.conf.json 等处保持一致）。

- Tauri 构建 `--bundles` 参数不支持 `zip`：Windows 发布用 `--no-bundle` 生成 exe 后**手动压缩为 zip**。

- Tauri build 缓存可能记录旧项目路径，路径变更后需 `cargo clean` 清空 `target` 缓存。

- Vite 开发服务器调试端口固定为 `5117`（`strictPort: true`），Tauri `devUrl` 指向 `http://localhost:5117`。

- 发布流程：提交代码 → 更新版本号 → **创建对应 git 标签即视为发布**，随后直接构建发布包，不再单独维护发布前流程。

## 代码与工程约定

- **命令应标记** **`#[tauri::command(async)]`**，将文件 I/O 放到异步线程池，避免阻塞 UI 主线程；保留 `State` 参数即可。

- **纯逻辑要抽成可独立测试的函数/结构体**（如 `parse_tags`、`build_new_name`、`strip_tag`、`History`），命令层只做薄封装；用 `cargo test` 覆盖（零配置即可运行）。

- 标签编进文件名（如 `报告#工作#重要.md`）。**移除多个标签时，要累积每次改名后的新路径**，不要复用旧路径，否则报「找不到文件」。

- 文件瘦身：避免把业务逻辑堆积成单个超大文件；保持 `lib.rs` 职责单一。

- 地址栏分隔符按平台统一：Windows 用 `\`，macOS 用 `/`。

- 地址栏访问历史：去重、最近优先、持久化保留 30 条，**仅记录成功进入的目录**。

- `@tauri-apps/plugin-fs` 的 `watch()` 有约 2000ms 批量防抖，需用 `watchImmediate()` 实现实时监听。

- UNC 路径（SMB 共享）不支持 notify 监听，需用约 3 秒定时轮询自动刷新（用 silent 模式避免加载闪烁）。

- **避免重复加载**：应用内操作（打标签/删除/重命名）后显式 reload 了就不应再由本次触发的事件重复 reload（用 `selfOpAt` 短窗口标记跳过自身 watch）。

- 验证：改动后用 `npm run tsc -- --noEmit`（前端）、`cargo check` / `cargo test`（后端）确认通过。

## 界面与体验约定

> 参考成熟开源项目（Files 文件管理器、Raycast 等）的「交互流畅、界面简洁」经验提炼。

- **响应即感知**：交互延迟尽量低于用户感知阈值（约 50ms）。先渲染 UI，再异步加载数据；大目录用虚拟化/分片渲染，避免一次渲染全部 DOM 行。静默刷新（UNC/轮询）跳过 loading 态，避免闪烁。

- **键盘优先、可被发现**：常用操作都要能纯键盘完成；右键菜单标 `role="menu"/"menuitem"` 并支持 ↑↓/Home/End/Enter/Esc 导航。快捷键要内联显示在对应菜单项右侧（如 `Ctrl+Shift+Z`），不在文档/工具提示里藏。全局快捷键不与输入框冲突。

- **单一强调色、克制用色**：一个主强调色 + 语义色（成功/警告/危险）即可，不堆彩色；深浅色模式全部走设计令牌（`styles.css` 的 `--tc-*` 变量），不写死颜色。

- **信息层级克制**：每屏保留一个主操作，减少边框/分割线等视觉噪音；状态栏、文件名做单行截断，窄窗自适应。

- **地址栏即导航**（Omnibar 理念）：地址栏既能显示当前目录也能输入目标路径；历史去重、最近优先、持久化保留 30 条，仅记录成功进入的目录，分隔符按平台统一（Win `\` / macOS `/`）。

- **操作反馈即时**：打标签/删除/重命名后状态立即反映，不贪快也要可见；批量操作（删除/改名）展示进度，避免误以为卡死。应用内操作后显式 reload，短窗口跳过自身 watch 防重复加载闪烁。

- **动效克制**：转场/过渡控制在约 150–200ms、使用一致缓动；尊重系统「减少动画」偏好。不做炫技动画。

- **平台一致**：跟随系统深浅色；键盘快捷键用平台惯例（Win `Ctrl` / macOS `Cmd`）；无边框窗口保留缩放与拖拽命中区。

## 安全与隐私

- **生产环境必须配置 CSP**（`security.csp`），不要留 `null`；CSP 需豁免 IPC（`connect-src 'self' ipc: http://ipc.localhost`），dev 用 `devCsp: null` 以便 HMR。

- **权限白名单最小化**：只在 `src-tauri/capabilities/default.json` 声明确实用到的权限；`core:window:default` 已含 `is-maximized`/`is-minimized` 等，不要重复声明；删除权限时先核对 `src-tauri/gen/schemas/acl-manifests.json`。

- 前端一律经 IPC 调命令访问后端能力，不直接内联系统级操作；外部能力（如用默认应用打开路径）走官方插件包并配对应权限（如 `opener:allow-open-path`）。

- 窗口/启动避免白屏：`visible: false` 隐藏启动 + 原生 `backgroundColor` + 前端就绪后 `show()`（配 `core:window:allow-show`）。

## 提交与隐私审查（开源注意事项）

- 本项目为**公开开源仓库**，任何提交的历史都不会被轻易抹除。**提交前必须进行隐私/敏感内容审查**。

- **禁止**提交：`.env`、凭据、API 密钥、个人真实用户名/本机绝对路径（如 `C:\Users\<用户名>`、`/Users/`）、本地独有配置（如 `.trae/`）。

- 使用 `git add` 时按文件逐个确认，**不要盲目** **`git add -A`** **/** **`git add .`**，避免把敏感文件带进历史。

- 定位到个人路径泄漏时，用 `git filter-repo` / `git filter-branch` 重写历史并校验远端无残留。

- 提交信息遵循 Conventional Commits（`feat`/`fix`/`refactor`/`chore`/`docs` 等）。

- **提交信息一律使用中文撰写**：type/scope 仍用英文规范词（如 `feat`、`fix`），description 与 body 用中文描述本次改动。

- **推送需授权**：除非用户明确授意（如「推送」「push」），否则只提交、不主动 `git push`；被问及是否推送时，如实说明本地领先远端的提交情况并等待确认。

## 角色：严谨工程架构师（默认协作模式）

> 本项目默认遵循该角色：把**正确、可维护、可测试**放在首位，节奏交由用户掌控。适用于日常迭代；原型探索、发布打包、破坏性操作与隐私审查均按既有章节规则执行。

- **结构优先**：改动前先理解现有职责边界，保持解耦与单一职责；纯逻辑抽成可独立测试的函数/结构体，命令层只做薄封装（沿用 `cargo test` 覆盖）。

- **先验证后收尾**：改动用 `cargo check` / `cargo test`、`npx tsc --noEmit` 确认通过；不接受未经验证的改动作为完成。

- **最小而完整**：只做被要求且必要的改动，不叠冗余抽象、不提前为假设的未来需求设计；改动尺度小、可审阅。

- **命名与注释克制**：命名表意清晰，注释仅解释「为什么」而非转述代码，语言与用户输入保持一致；贴合既有风格，不引入炫技写法。

- **保留安全底线（强制）**：提交前隐私/敏感审查、提交信息遵循 Conventional Commits、**除非用户授意否则不主动 push**、严禁任何破坏性 git 操作。

