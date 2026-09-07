# Zeta · Tag Box — Filename-based Tag Manager

> **中文:** [README.md](README.md)

A lightweight, cross-platform desktop file manager. Its core highlight is a **filename-based tagging system**: tagging and un-tagging a file is essentially just a rename — no database required.

> Tags are renames: starting from the first `#` in a filename, each `#xxx` segment is a tag.
> `文档_报告#项目#2024.pdf` → base name `文档_报告`, tags `项目`, `2024`.

## Screenshots

> TODO: pending screenshots

## Features

- **Tags are renames**: adding/removing tags goes through the system rename — no SQLite, no spreadsheet parsing, no search kernel, lightweight and pure.
- **Native file explorer**: browse directories, drive switching, breadcrumbs, forward/back/up.
- **Tag sidebar**: live counts of files per tag in the current directory; click to tag the selected files.
- **Colored type icons**: distinguish file types by extension for quick visual scanning.
- **Full keyboard navigation**: interaction consistent with the system file explorer.
  - Arrow keys to move the selection, `Shift` for range multi-select, `Ctrl` (macOS `⌘`) to move the cursor only
  - `Ctrl+A` select all · `Esc` clear · `Enter` open · `←` parent · `Del` delete to Trash
  - `F2` inline rename · `F5` refresh · type characters to jump by name prefix
- **Undo/Redo**: tagging, un-tagging, and renaming are all pushed onto the undo stack — mistakes can be reverted.
- **Cross-platform frameless window**: custom title bar with Windows/Linux right-side controls and macOS traffic-light buttons.
- **Delete to Trash**: `Delete` uses the system Recycle Bin — no accidental loss, and not recorded in the undo stack.

## Tech Stack

| Layer | Technology |
| --- | --- |
| Desktop framework | Tauri 2 (Rust) |
| Frontend | React 18 + TypeScript + Vite 5 |
| Backend | Rust, file operations exposed via `#[tauri::command]` |
| Packaging | `tauri-bundler` (nsis / dmg / etc.) |

## Tag Conventions

- Filenames are parsed starting from the **first `#`**; each `#xxx` segment is a tag.
- The part before the first `#` is the **base name** (without extension).
- Filename parsing is done uniformly on the Rust side; the frontend does not re-parse.

## Development

Prerequisites: [Node.js ≥ 18](https://nodejs.org/) and [Rust](https://www.rust-lang.org/tools/install).

```bash
# 1. Install frontend dependencies
npm install

# 2. Start development mode (frontend hot-reload + Rust backend)
npm run tauri dev
```

> On Windows PowerShell, if `npm` is blocked by the execution policy, use `npm.cmd` instead.

### Common Commands

| Command | Description |
| --- | --- |
| `npm run tauri dev` | Run in development mode |
| `npm run tauri build` | Build and package a release |
| `cargo check` (in `src-tauri/`) | Check for Rust compilation errors |
| `tsc --noEmit` | Check frontend type errors |

## Release Builds (GitHub Actions)

The repo ships a `.github/workflows/release.yml`: pushing a `v*` tag automatically builds on Windows / macOS and uploads to GitHub Releases.

```bash
git tag v0.1.0
git push origin --tags
```

> Code signing and notarization are not configured yet: Windows artifacts may trigger a SmartScreen warning, and macOS artifacts are ad-hoc signed — they run on your own machine.

## Tauri Commands Overview

| Command | Purpose |
| --- | --- |
| `list_dir` | List directory contents and parse tags |
| `get_drives` | Get Windows drive letters (empty on other platforms) |
| `get_default_dir` | Default directory to open (Downloads, falling back to home) |
| `add_tag` / `remove_tag` | Add / remove tags (rename + push to undo stack) |
| `rename_file` | Rename (push to undo stack) |
| `delete_file` | Move to Trash (not in the undo stack) |
| `undo` / `redo` / `can_undo` / `can_redo` | Undo-stack operations and queries |

## Project Structure

```
├── src/                 # React frontend
│   ├── App.tsx          # Main view and interactions
│   ├── api.ts           # Tauri command wrappers (invoke)
│   ├── types.ts         # Shared types between frontend and backend
│   └── styles.css       # Global styles
├── src-tauri/           # Rust backend
│   ├── src/lib.rs       # Command layer + tag parsing + undo stack
│   └── tauri.conf.json  # Window and packaging configuration
└── .github/workflows/   # CI release builds
```

## License

This project is open-sourced under the [Apache License 2.0](LICENSE). You are free to use, modify, and distribute it, but please keep the copyright and license notices.