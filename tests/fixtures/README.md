# 桌面端离线验收夹具

这些夹具不包含用户素材、密钥或外部下载内容。媒体文件由本机 `ffmpeg` 重复生成，
`generated/` 中的二进制已被目录内的 `.gitignore` 排除，不应提交到仓库。

## 生成

在仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DesktopAcceptanceFixtures.ps1
```

如果 `ffmpeg` 不在 PATH，并且仓库的 `release/`、Rust `target/` 中也没有：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\New-DesktopAcceptanceFixtures.ps1 `
  -FfmpegPath "D:\path\to\ffmpeg.exe"
```

脚本会覆盖旧生成物并校验：

- `small-image-under-4mb.png`：小于 4 MiB，用于普通图片导入。
- `large-image-over-4mb.bmp`：大于 4 MiB，用于验证桌面受管素材仓储；浏览器预览模式应明确拒绝。
- `sample-video-4s.mp4`：4 秒、含声音的短视频，用于画布和导演台导入。
- `sample-audio-3s.wav`：3 秒离线正弦音频，用于音频节点导入。

脚本最后会打印每个媒体文件的绝对路径与字节数，直接在桌面程序的文件选择框中使用。

## JSON 预期

- `minimal-project.json`：应能作为亿幕项目打开，出现一个“验收提示词”文本节点。
- `rejected-comfyui-editor-workflow.json`：这是 ComfyUI **编辑器/UI JSON**。从“打开项目”入口选择时应被拒绝，并提示应改用工作流库或 API 工作流导入；不能静默打开为空项目。

## 建议桌面验收顺序

1. 启动 Tauri 开发版，打开 `minimal-project.json`，确认文本节点存在。
2. 导入小 PNG，确认画布显示且重启程序后仍能恢复。
3. 导入大 BMP，确认桌面版接受并写入应用受管目录；再重启核验。
4. 将 MP4、WAV 分别导入画布与导演台，确认预览、播放、项目切换和重启恢复。
5. 从“打开项目”选择拒绝用 JSON，确认得到针对 ComfyUI UI JSON 的明确提示。
