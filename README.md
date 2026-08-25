# ComfyCanvas（亿幕画布）

这是亿幕无限画布桌面应用的最新可开发源码。当前发布版本为 `v0.2.1`；仓库保留继续修改、安装依赖和重新构建所需的文件，不包含历史备份、构建缓存或可重新生成的产物。

当前仍属于持续迭代版本：核心项目保存、强类型连线、工作流参数和平台能力表均已开始模块化；外部 API、ComfyUI 与粗剪预览导出仍需根据用户实际账号、模型和工作流验证。请先阅读：

- [操作、验收与交接指南](./docs/操作与验收指南.md)
- [产品重构与验收基线](./docs/产品重构与验收.md)

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
npm.cmd test
npm.cmd run build
npm.cmd run tauri -- dev
```

也可双击 `启动开发版.cmd`。它会先检查 `node`、`npm`、`cargo`、`rustc`、关键前端依赖和开发端口 `1430`；依赖缺失时会使用锁定文件执行 `npm.cmd ci`，端口被占用时不会自动杀进程，而是显示占用进程并停止。只想检查环境、不启动程序，可运行：

```powershell
.\启动开发版.cmd --check
```

这个脚本启动的是 **Tauri + Vite 开发会话**，不是安装版，也不会构建 EXE。开发版窗口依赖它启动的本机 Vite 服务；不要直接打开 `src-tauri\target\debug` 下的裸 EXE。正式安装包通过 `npm.cmd run tauri -- build` 构建，便携程序通过 `npm.cmd run tauri -- build -- --no-bundle` 构建。

`v0.2.1` 的安装包与便携 ZIP 发布在 GitHub Releases，更新内容见 [v0.2.1 版本说明](./docs/版本说明-0.2.1.md)。

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

在 AI 视频节点中选择“自带 API Key”后，平台、模型与生成模式会按能力联动；界面只展示当前适配器实际能够提交的选项：

| 平台 / 适配器 | 当前可提交模式 | 当前明确不宣称支持的能力 |
| --- | --- | --- |
| 万相 | 文生、单首帧；`kf2v` 可首尾帧 | 通用多参考、单请求多条视频 |
| 可灵 `kling-v1-6` | 文生、单首帧、首尾帧 | 当前适配器的多图参考、原生音频、单请求多条视频 |
| 豆包 Seedance 1.0 Pro | 文生、单首帧、首尾帧 | 多参考、原生音频、单请求多条视频 |

若用户明确选择已适配的 Seedance 2 模型，界面会按该模型单独显示多参考能力；未知模型一律降级为保守选项。平台密钥只保存在当前电脑的应用本地配置中，不随项目文件或 Git 仓库上传。真实账号开通状态、模型名和平台契约仍须使用该账号实测。

## 已适配的在线图片 API

- OpenAI Images：支持文生图和单张参考图编辑。
- Google Nano Banana：通过 Gemini API 接入 Nano Banana 2、Lite、Pro 与旧版 2.5；支持文生图和最多 14 张参考图。Lite 与旧版 2.5 会自动锁定 1K，其他 Gemini 3 图片模型可选 1K、2K、4K。
- Midjourney：由于官方没有面向普通用户开放公共 API，应用只生成并复制官方 `/imagine` 手动命令，不执行非官方 Discord 自动化；生成完成后可将图片导回画布。

Nano Banana 的 Gemini API Key 在“在线服务配置”中填写，只保存在当前电脑。Midjourney 手动命令模式不需要在应用里保存 Discord 凭据。

## 未纳入仓库的内容

- `node_modules/`、`dist/`、`target*/`：依赖与构建缓存，可重新生成
- `src-tauri/gen/`：Tauri 自动生成的架构文件
- `release/`：构建后的 EXE 与外部运行组件
- 历史备份、旧版 EXE、日志、编辑器配置和临时文件

这些内容不影响继续开发和重新构建项目。
