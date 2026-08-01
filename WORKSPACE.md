# ComfyCanvas 新工作区

此目录是从 2026-08-01 最新代码整理出的干净副本，后续开发以这里为准。

## 目录

- `src/`：React 前端与无限画布功能
- `src-tauri/`：Tauri / Rust 桌面端
- `release/ComfyCanvas-latest.exe`：整理时的最新版程序
- `release/ffmpeg.exe`：视频导出运行组件

## 开发命令

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run tauri -- build --no-bundle
```

历史目录、旧 EXE、`node_modules`、`dist` 和所有 `target-rXXX` 构建缓存均不属于本工作区。
