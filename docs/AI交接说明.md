# 亿幕画布（ComfyCanvas）AI 交接说明

## 1. 项目是什么

这是一个 Windows 桌面端的无限画布创作工具。用户希望把“文本创作、AI 剧本、AI 图片、AI 视频、本地 ComfyUI 工作流、素材与导演台剪辑”放在同一张画布上，用连线组织创作流程。

产品目标不是只画出连线，而是让连线代表真实的数据传递：上游文本、图片、视频、音频等内容可以被下游节点作为生成输入；生成完成后的图片、视频、文本结果自动回到对应画布节点，并可以继续连接到下一步。

## 2. 用户最重视的验收标准

不要把“编译通过”当作完成。用户要求实际在桌面程序里验收，至少满足：

1. AI 文本/剧本、AI 图片、AI 视频（或本地 ComfyUI 视频工作流）三类节点，各至少成功产出一次真实内容。
2. 至少两条不同的内容链路能真实贯通，例如：文本 → 图片 → 视频、图片 → 视频、文本 → 剧本 → 图片。
3. 生成的图片/视频必须自动显示在画布上；视频必须能在画布内播放。
4. 节点连线必须真实传递兼容类型，不能只是一条视觉线。
5. 任何不兼容的连接要在连线时给出明确原因和下一步建议，不能静默失败。
6. 程序仍在持续开发。默认只构建单个测试 EXE；用户明确要求发布时，可以构建安装包、便携 ZIP 并发布 GitHub Release，但不能把未完成的真实平台验收描述为已经通过。

## 3. 工作目录与重要路径

主工作区：

`D:\Codex\ComfyCanvas-workspace`

核心目录：

- `src\`：React / TypeScript 前端。
- `src\App.tsx`：画布主编排层，项目状态、节点、连线、ComfyUI 调用、在线 API 生成和 UI 状态集中在这里。文件很大，修改时必须小范围、先搜索调用链。
- `src\DirectorMode.tsx`：导演台/时间线编辑器。
- `src\AiGenerationNodes.tsx`：AI 文本、图片等生成编辑器和参考图片导入。
- `src\ComfyWorkflowParameters.ts`：ComfyUI `/object_info` 扫描、输入绑定、工作流校验、输出发现与历史结果解析。
- `src\WorkflowLibrary.tsx`：Comfy 工作流库。
- `src\app.css`：历史样式很大，避免随意全局覆盖。
- `src\ui\tokens.css`：当前暖黑、暖金、米白主题 token；绿色只用于连接成功/状态语义。
- `src\core\`：应优先放纯逻辑和测试，不要继续把复杂逻辑堆进 App。
- `src-tauri\src\main.rs`：Tauri/Rust 后端，包含 ComfyUI 通信、媒体缓存、托管素材、本地 API 凭据调用、在线平台适配。
- `src-tauri\tauri.conf.json`：Tauri 配置。
- `docs\操作与验收指南.md`：操作与验收步骤。
- `docs\产品重构与验收.md`：重构记录与验收矩阵。

当前单文件测试程序：

`C:\Users\Administrator\Desktop\亿幕画布-测试版.exe`

正确构建出的原始 EXE：

`D:\Codex\ComfyCanvas-workspace\src-tauri\target\release\comfy-canvas-offline.exe`

## 4. 技术结构

前端：React + TypeScript + Vite。

桌面端：Tauri + Rust。

本地工作流：ComfyUI HTTP/WebSocket，通常地址为 `http://127.0.0.1:8188`。用户本机 ComfyUI 输出目录曾确认是：

`D:\ComfyUI-aki-v2\ComfyUI\output`

媒体不应长期以 Data URL 保存到 localStorage。桌面版已建立受管素材仓储：

`AppLocalData\workspace-v1\projects\<projectId>\assets\...`

前端通过 `workspaceAssetClient.ts` 分块上传，Rust 只允许受管素材路径作为 asset 协议范围，禁止任意路径暴露。

## 5. 画布节点与类型原则

已有 typed graph 基础，主要文件：

- `src\core\nodes\builtins\catalog.ts`
- `src\core\graph\types.ts`
- `src\core\graph\validation.ts`
- `src\core\execution\plan.ts`

类型包括：`text`、`storyboard`、`image`、`video`、`audio`、`latent` 等。

接手时必须坚持：

- 文本可作为图片/视频/剧本的提示词输入。
- 图片可作为图生图、图生视频、首帧/参考图输入。
- 视频可进入导演台或支持视频输入的下游节点。
- 音频仅接收支持 AUDIO 的目标。
- 输入端口有单输入限制时，不能用后一个连接静默覆盖前一个连接。
- 连接必须保存 `fromPort` / `toPort`，老项目没有端口信息时需迁移并提示歧义，不要靠节点名字猜测。
- 如果平台模型本身不支持某种模式，应在模型选择时隐藏或禁用该模式；不要等点击生成后才报模糊错误。

## 6. ComfyUI 当前设计与注意事项

ComfyUI 不能靠节点名称硬猜。当前逻辑应以实时 `/object_info` 和当前 API 工作流为准：

1. 每次运行前扫描真实输入/输出插槽。
2. 图片、视频、音频、文本、latent 要按真实类型绑定。
3. 文本提示词要写入真实的 STRING/TEXT 正向提示槽；无可识别槽或存在歧义时应阻止运行并标出具体节点和插槽。
4. 图片应绑定到声明为上传/加载的图像槽，不能把第一个 IMAGE 插槽当作正确槽。
5. 输出优先真实 `output_node` 和媒体插槽，不能把 Prompt Preview、普通 VAE/Preview 节点误当成最终成片。
6. 历史结果回流时只接收经验证的目标，按 images / videos / audio / gifs 真实分类。

最近发生过的真实问题：ComfyUI 已生成 `LTX2_00081-audio.mp4`，但画布显示 `0:00/0:00` 或空白。已确认该文件和 `/view` 都可访问，原因是画布视频卡片把同一个 `/view` URL 同时当主源和 fallback，没有可靠使用本机缓存。最新源码已将视频节点改为优先受管缓存，失败后仅一次回退至 Comfy `/view`。

这项修复需要在当前测试 EXE 中由用户重新实际生成并确认。不要仅凭单元测试说已解决。

## 7. 在线 API 配置原则

支持的适配方向包括 OpenAI 兼容、Gemini、万相、可灵 Kling、豆包 Seedance、Ollama 等。不同模型能力不同，不能做“万能接口”的假承诺。

前端能力表：

- `src\core\providers\imageCapabilities.ts`
- `src\core\providers\videoCapabilities.ts`

Rust 最终请求校验：`src-tauri\src\main.rs`。

配置 UI 的用户要求：

1. 节点下方只显示与该节点类型匹配的平台和模型。
2. “未配置”点击后打开最基础的连接配置；连接测试和保存成功后变成“已配置”。
3. 点击“已配置”应允许更换当前配置，不应在每次点击生成时突然弹出配置页。
4. 不要保留“免费本机测试”之类误导按钮。
5. 连接配置页只保留必要内容：平台、接口地址、协议、认证方式、密钥、测试连接、保存。模型能力/手动分类等复杂内容应隐藏到必要时或自动识别。
6. 用户可自行提供密钥；不要把密钥写入项目导出、日志、UI 文本或 Git。

真实 API 目前仍需用户使用自己的测试密钥验收；代码级适配和错误归类不等于云端成功。

## 8. 项目保存、切换与异步安全

相关文件：

- `src\core\project\repository.ts`
- `src\core\project\migrate.ts`
- `src\core\project\commands.ts`
- `src\core\project\portability.ts`
- `src\core\project\comfyWorkflowImport.ts`
- `src\core\execution\runRegistry.ts`
- `src\core\execution\inputSignature.ts`

规则：

- 项目切换、导入、新建、关闭前必须 flush 当前保存，避免 debounce 丢失最后编辑。
- 远端任务必须带 `projectId + nodeId + runId`，返回时校验仍属于当前项目和当前运行；重跑、停止、删除节点、切项目后旧结果不得写回。
- 若生成期间输入、参考图、工作流或连线变化，旧回包应丢弃并提示“输入已变更，请重新生成”。
- 不可把所有 DataURL 复制到当前项目和多条历史里。
- 导入 Comfy UI 编辑器 JSON 时不能把它误当成本项目 JSON；应要求 API 工作流导入到工作流库。
- 便携项目需带工作流库和 portability manifest；本机路径、未内嵌素材和缺失模型必须给用户清单提示。

## 9. 导演台状态

导演台已有改造：右侧素材库独立滚动、竖屏 9:16 使用 contain、空时间线 5 秒、导入大量素材不应撑破预览和时间线、切项目时异步导入要取消。

但仍需要真实桌面端导入 20+ 素材、重启、9:16 导出测试。不要因为纯逻辑测试通过就宣称导演台已完全验收。

## 10. 已有测试与开发命令

在工作区 PowerShell 中运行：

```powershell
cd D:\Codex\ComfyCanvas-workspace
npm.cmd test -- --run
npm.cmd run build
cargo check --locked --manifest-path src-tauri\Cargo.toml
cargo test --locked --manifest-path src-tauri\Cargo.toml
```

开发启动器：

`D:\Codex\ComfyCanvas-workspace\启动开发版.cmd`

支持 `--help` 与 `--check`。脚本保持 ASCII，避免 Windows cmd 解析 UTF-8 中文导致启动失败。

构建单个测试 EXE 必须使用：

```powershell
cd D:\Codex\ComfyCanvas-workspace
npm.cmd exec tauri build -- --no-bundle
```

不要只运行 `cargo build --release` 后把 exe 交给用户；它曾因未打包前端而访问 `127.0.0.1:1430` 并出现 `ERR_CONNECTION_REFUSED`。

用户明确要求正式发布时，使用 `npm.cmd run tauri -- build` 生成 NSIS 安装包；便携 ZIP 必须同时包含构建后的主程序和 `ffmpeg.exe`。

## 11. 当前未完成/必须优先验证的事项

优先级 P0：

1. 当前测试 EXE 中实测 ComfyUI 图片/视频生成回流：视频卡显示画面、正确比例、可播放，不再出现 `0:00/0:00`。
2. 只保留真正最终输出节点回流，杜绝中间 Preview/音频结果重复回到画布。
3. 实测两条以上真实数据连线链路，确认上游输出真的作为下游输入提交。
4. AI 文本、图片、视频三类节点分别真实跑通一次；对未配置节点应显示“未配置”，对有效连接显示“已配置”。
5. 修复任何“按钮看起来可点但实际无效”的控件，尤其视频控制、提示词库、配置切换、@图片。

### 2026-08-20 P0 第 2 项代码级更新

- History 回流现在会排除 ComfyUI 明确标记为 `temp` / `preview` / `input` 的临时文件；自定义节点的兼容回退只有在文件明确标记 `type: output` 时才允许建画布素材。
- 同一个最终视频保存节点若同时回传缩略图、伴生音频或同一文件的重复 media group，只建立最终视频卡；独立 SaveAudio 输出节点仍会保留音频卡。
- 已增加 Preview、视频伴生结果、兼容回退和重复文件测试；`npm.cmd test -- --run` 为 22 个测试文件、185 个用例通过，`npm.cmd run build` 通过。
- 这只是代码级验证。仍需用当前 LTX / MiniMax 等真实工作流重新生成，确认画布只新增预期最终节点，且最终视频可播放；在该桌面实测完成前不要把 P0 第 2 项标为完全验收。

优先级 P1：

1. 提示词库：可打开，能创建、搜索、分类（正面/负面/自定义分类）、重命名与插入；关闭提示词库不能关闭文本编辑器。
2. 画布视频卡不显示无效的全屏/音量伪按钮；浏览器原生控件应可用或移除无效装饰。
3. API 配置 UI 继续极简化，并对每个节点只显示适配配置。
4. 导入的 Comfy API 工作流应显示真实缺失项和可修复路径；不能因为严格校验导致用户原本能在 ComfyUI 使用的工作流完全无法运行。

## 12. 协作与安全规则

- 工作树很脏，存在多轮未提交修改。**绝对不要** `git reset --hard`、`git checkout -- .`、删除目录、覆盖用户数据。
- 先在当前最新版工作区上检查再修改。不要从旧复制目录改完再覆盖最新文件。
- 每次修改先定位影响模块，修改后至少跑相关测试、TypeScript/Vite build，涉及 Rust 再跑 cargo check/test。
- 任何修改影响视频回流、Comfy、项目存储、连线或 API 调用时，都要告知用户需要在桌面实际复测。
- 密钥只允许本机安全存储与请求时使用，不能保存进项目导出、历史、README、Git 或错误日志。
- 积分/充值目前不是可用商业功能，只是本地演示。不要引导用户付款或宣称具有真实扣费/退款能力。

## 13. 给下一位 AI 的直接任务提示词

可直接复制下面这段交给下一位 AI：

> 你接手 Windows Tauri 项目 `D:\Codex\ComfyCanvas-workspace`。这是“亿幕画布”，目标是让文本、图片、视频、ComfyUI 工作流在无限画布中真实连接和生成。不要做安装包，不要重置或清理当前 Git 工作树。先读 `docs\AI交接说明.md`、`docs\操作与验收指南.md` 和 `docs\产品重构与验收.md`。当前首要任务不是新增 UI，而是在当前测试 EXE 中和用户共同验收：AI 文本、图片、视频/Comfy 三类各真实产出一次；至少两条连线链路真实把上游内容传入下游；Comfy 最终视频可靠回流到画布并可播放。每次改动必须基于当前最新版，运行相关测试与 build，并明确告诉用户哪些需要桌面实测。严禁把视觉连线当成数据已贯通，也严禁用模糊节点名猜 ComfyUI 输入/输出。
