@echo off
setlocal
cd /d "%~dp0"
echo [1/3] 运行核心单元测试...
call npm.cmd test
if errorlevel 1 goto :failed
echo [2/3] 检查 TypeScript 并构建前端...
call npm.cmd run build
if errorlevel 1 goto :failed
echo [3/3] 检查 Tauri / Rust 后端...
cd /d "%~dp0src-tauri"
cargo check
if errorlevel 1 goto :failed
echo.
echo [亿幕画布] 核心测试、前端构建和 Rust 检查均通过。
exit /b 0

:failed
echo.
echo [亿幕画布] 检查未通过，请从上方第一条错误开始处理。
pause
exit /b 1
