# ComfyCanvas（亿幕画布）

这是亿幕无限画布桌面应用的最新可开发源码，整理自最后确认的 `r122` 版本。仓库保留继续修改、安装依赖和重新构建所需的文件，不包含历史备份、构建缓存或可重新生成的产物。

## 项目内容

- `src/`：React 无限画布、AI 剧本、AI 图片、AI 视频、积分与工作流功能
- `src-tauri/`：Tauri / Rust 桌面端、ComfyUI 调用、文件保存与视频转码接口
- `package.json` / `package-lock.json`：前端依赖与锁定版本
- `src-tauri/Cargo.toml` / `Cargo.lock`：Rust 依赖与锁定版本
- `src-tauri/icons/icon.ico`：桌面程序图标

## 开发与构建

需要安装 Node.js、Rust 和 Tauri 所需的 Windows 编译环境。

```powershell
npm.cmd ci
npm.cmd run build
npm.cmd run tauri -- build
```

## 外部运行依赖

视频导出需要 FFmpeg。FFmpeg 是第三方外部依赖，不属于本项目源码，也因当前 Windows 二进制文件为 144,550,912 字节、超过 GitHub 普通仓库单文件 100MB 限制而不提交。正式 NSIS 安装包构建时会从 `release/ffmpeg.exe` 自动打包 FFmpeg；单独分发裸 EXE 时仍需按下列方式提供。

使用方式任选其一：

1. 将 `ffmpeg.exe` 放在构建后的亿幕画布 EXE 旁边；
2. 将 FFmpeg 加入系统 `PATH`；
3. 设置环境变量 `YM_FFMPEG_PATH` 指向 `ffmpeg.exe`。

整理时使用的 FFmpeg 校验值：

```text
SHA256 1128471E5CCF6A08FD4DCCE8791B123495A831F704AC9F9F5DF0023F774A2F3D
```

本地 ComfyUI 也是独立程序，不包含在此仓库中；应用会连接用户已有的 ComfyUI 服务。应用优先检查正在运行的 `8188/8189` 端口，不再依赖固定磁盘路径。需要提示未启动的自定义安装位置时，可设置 `YM_COMFYUI_PATH`。

## 已适配的在线视频 API

- 阿里百炼·万相：填写 DashScope API Key。
- 可灵 Kling：填写可灵开放平台 Access Key 与 Secret Key；桌面端在本机生成短期 JWT，不会把 Secret Key 写入源码或日志。
- 豆包·火山方舟：填写方舟 API Key，以及控制台实际开通的 Seedance 模型或推理接入点 ID。

在 AI 视频节点中选择“自带 API Key”后，平台、模型与生成模式会按能力联动。可灵当前接入文生视频和单图生视频；豆包当前接入文生视频、图生视频与多图参考。平台密钥只保存在当前电脑的应用本地配置中，不随项目文件或 Git 仓库上传。

## 未纳入仓库的内容

- `node_modules/`、`dist/`、`target*/`：依赖与构建缓存，可重新生成
- `src-tauri/gen/`：Tauri 自动生成的架构文件
- `release/`：构建后的 EXE 与外部运行组件
- 历史备份、旧版 EXE、日志、编辑器配置和临时文件

这些内容不影响继续开发和重新构建项目。
