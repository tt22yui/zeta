# Zeta 功能计划

> 本文件记录本轮迭代的功能计划与进度，供后续推进参考。

## 产品定位与架构原则

- **核心：以打标签为主。** Zeta 的产品价值主张是「文件标签管理」——标签编进文件名（`报告#工作#重要.md`），提供侧边栏标签/统计、打标签工具、按键标签筛选等围绕标签的一体化体验。标签相关能力（解析 `parse_tags`、改 `build_new_name`、命令 `add_tag/remove_tag`，见 `src-tauri/src/lib.rs`）是产品的内聚核心。

- **其余功能=右键菜单「插件」。** 打开 / 删除 / 重命名 / 复制 / 剪切 / 解散文件夹 / 收入文件夹 / 刷新 / 预览等文件管理能力，定位为**可插拔的右键菜单扩展**，按需启用、与标签主线解耦（核心不依赖它们）。

- **演进方向**：当前右键菜单是硬编码 `items` 数组（`App.tsx:1850-1880`）。计划将菜单项抽象为**插件注册表**（每项 = 元数据 + 触发回调），支持条件显隐（单选/多选/文件夹/是否含标签）与按需启停，让「加插件」不碰核心代码。详见剩余工作第 3 项。

## 计划六项

1. 空格预览文件
2. 右键功能完善：打开文件 / 复制 / 删除 / 剪切 / 复制文件名 / 复制路径
3. 多标签浏览
4. 收入文件夹：选中项收入一个新建文件夹
5. 解散文件夹：文件夹内容上移到上级，删除空壳
6. 设置功能：独立设置面板 + 持久化（见下方计划 6）

## 进度总览

| 计划项       | 状态      | 说明                                     |
| --------- | ------- | -------------------------------------- |
| 1. 空格预览文件 | ✅ 完成    | 图片/视频/音频/PDF/文本全格式，右侧抽屉面板              |
| 2. 右键功能完善 | ⚠️ 部分完成 | 见下方明细                                  |
| 3. 多标签浏览  | ❌ 未开始   | 本轮跳过，待后续推进                             |
| 4. 收入文件夹  | ✅ 完成    | `HistoryOp::CollectFolder` + 命名弹窗 + 撤销 |
| 5. 解散文件夹  | ✅ 完成    | 子项上移 + 删空壳 + 撤销                        |
| 6. 设置功能   | ✅ 完成    | 设置面板 + 主题三态 + 历史 + 标签分隔符，见下方计划 6 |

## 计划 2 明细

| 子项                 | 状态   | 说明                          |
| ------------------ | ---- | --------------------------- |
| 打开文件               | ✅ 已有 | 本轮修复了 opener scope 权限 bug   |
| 删除                 | ✅ 已有 | —                           |
| 复制文件名（Ctrl+C）      | ✅ 新增 | 单选时展示，走 IPC clipboard       |
| 复制路径（Ctrl+Shift+C） | ✅ 新增 | 单选时展示，走 IPC clipboard       |
| 复制文件               | ❌ 未做 | 需 Windows `CF_HDROP` 文件级剪贴板 |
| 剪切文件               | ❌ 未做 | 同上，纯文本 `writeText` 实现不了     |

## 额外完成（计划外）

- **Bug 修复**：`opener:allow-open-path` 缺少 path scope，导致 `not allowed to open path`（v0.1.2 既有缺陷）。修复方式见 `src-tauri/capabilities/default.json`。

- **Material Design 3 借鉴 4 处**（仅 styles.css 令牌层，未改视觉风格）：

  - Shape token 补全 6 档（`--r-xs/sm/md/lg/xl/full`）

  - State layer 半透明叠加令牌（`--state-hover/focus/pressed`，8/12/16%）

  - 自适应断点对齐 MD3（600 紧凑 / 840 中等 / 1240 展开）

  - Color role 语义命名（`--on-accent` / `--on-accent-container`），修复深色模式主按钮文字对比度

- **弹窗重构**：引入 `@headlessui/react`，统一覆盖层系统。

  - 4 处原生 `window.confirm/prompt` → 自定义 `ConfirmDialog` / `PromptDialog`（居中 Modal、遮罩、ESC、焦点陷阱、ARIA；复用 `--tc-*` 令牌）

  - 预览抽屉动画迁移到 headlessui `Transition`（移除手写 `@keyframes preview-in`，尊重 `prefers-reduced-motion`）

  - 注：headlessui v2 移除非模态 Dialog，预览抽屉改用 `Transition` 包裹 `<aside>`（不锁列表交互）

- **后退/前进键盘快捷键**：列表内纯 `←`/`→` 绑定 `goBack`/`goForward`（替代原 `←`=上一级 / `→`=打开条目）；打开改用 `Enter`、上一级改用 `Backspace`；工具栏按钮 title 同步为 `(←)/(→)`

## 剩余工作

### 计划内未做

1. **多标签浏览**

   - 标签页状态管理（每页独立目录 / 选中 / 历史）

   - 拖拽拆分 / 合并标签

   - 上下文隔离（watch、selfOpAt、reload 不能跨标签串扰）

   - 标签栏 UI + 新增/关闭交互

2. **复制文件 / 剪切文件**

   - Windows：走 `CF_HDROP` 文件级剪贴板（IPC 调系统 API 或 `clipboard-win` crate）

   - macOS：走 `NSPasteboard` 的 fileURL 类型

   - 粘贴时区分复制 / 剪切（剪切粘贴后删除源）

   - 属于右键插件之一，纳入插件注册表（见下）

3. **右键菜单插件化（构架演进）**

   - 把 `App.tsx:1850-1880` 的硬编码 `items` 数组改为「插件注册表」：每一项 = `{ key, label, matches(selection), component?, action }`

   - 内置插件先抽取：刷新 / 打开 / 复制文件名 / 复制路径 / 重命名 / 解散 / 收入 / 删除 / 移除标签；后续「插件」只需注册，不再碰核心

   - 条件显隐：单选 / 多选 / 是文件夹 / 含标签——由 `matches(selection)` 集中声明，替换现在的散落 if

   - 可选：持久化显隐开关（沿用 `zeta.*` localStorage 键），用户可按需启用/隐藏某插件

4. **设置功能（计划 6）** — ✅ 已完成

   - 独立设置面板 `src/SettingsDialog.tsx`（@headlessui/react 居中 Dialog，走 `--tc-*` 令牌）。入口：顶部工具栏齿轮按钮。

   - 持久化统一为单键 `zeta.settings`（`src/settings.ts`，宽容解析 + 默认回退）。

   - 外观：主题三态（跟随系统 / 浅色 / 深色）。styles.css 深色块移入 `html[data-theme="dark"]`，index.html 首帧脚本读设置写 `data-theme` 防闪白/闪深，system 模式由 matchMedia 解析 + 监听跟随。

   - 历史：地址栏历史条数上限（默认 30，范围 1~100）；启动是否恢复上次路径开关。

   - 标签：标签分隔符可配置。后端标签纯函数 `parse_tags`/`build_new_name`/`strip_tag`/`build_entry` 增加 `sep: char` 参数，新增 `TagSettings` State、`set_tag_separator` 命令与 `sanitize_sep` 校验；持久化仍由前端 `zeta.settings` 负责、后端内存态随启动/变更同步。

   - 插件：仅占位分组「插件管理即将推出」，待右键菜单插件注册表落地后实现按需启停。

   - 本轮明确不做：预览行为开关、插件实际启停、迁移既有 `#` 标签文件（改分隔符后旧 `#` 标签不再被解析，属配置变更固有代价）。

## 验证状态

- `npx tsc --noEmit`：通过

- `npm run build`（tsc + vite build）：通过

- `cargo test`：28 passed（含 read\_text\_preview、collect\_into\_folder、dissolve\_folder、parse/build/strip 自定义分隔符、sanitize\_sep 等纯逻辑测试）

- `cargo check`：通过

- 手动验证待做：`npm run tauri dev` 实测——弹窗重构（Confirm/Prompt 居中、焦点、深色）、空格预览各格式抽屉动画、`←`/`→` 后退前进、打标签/删除/改名后自刷新、设置面板（主题三态切换、历史上限、恢复路径开关、分隔符启停）

