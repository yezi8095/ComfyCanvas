@echo off
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul

rem Development launcher only: starts Vite and the Tauri development window.
rem It does not build or launch a production installer.
set "APP_NAME=ComfyCanvas"
set "DEV_PORT=1430"
set "PROJECT_DIR=%~dp0"
set "MODE=%~1"

if /i "%MODE%"=="--help" goto :help
if not "%MODE%"=="" if /i not "%MODE%"=="--check" (
  echo [%APP_NAME%] Unknown option: %MODE%
  goto :help
)

cd /d "%PROJECT_DIR%"
if errorlevel 1 (
  echo [%APP_NAME%] Cannot open project directory: %PROJECT_DIR%
  pause
  exit /b 1
)

echo.
echo ==============================================
echo   %APP_NAME% - development startup check
echo   Project directory: %CD%
echo ==============================================

call :require_command node.exe "Node.js"
if errorlevel 1 goto :failed
call :require_command npm.cmd "npm"
if errorlevel 1 goto :failed
call :require_command cargo.exe "Rust / Cargo"
if errorlevel 1 goto :failed
call :require_command rustc.exe "Rust compiler"
if errorlevel 1 goto :failed

echo [Check] Node.js:
node.exe --version
if errorlevel 1 goto :failed
echo [Check] npm:
call npm.cmd --version
if errorlevel 1 goto :failed
echo [Check] Rust:
cargo.exe --version
if errorlevel 1 goto :failed

if not exist "package.json" (
  echo [%APP_NAME%] package.json is missing. Start from the complete source directory, not dist or target.
  goto :failed
)

call :check_dependencies
if errorlevel 1 (
  if /i "%MODE%"=="--check" (
    echo [%APP_NAME%] Frontend dependencies are incomplete. Run this file without --check, or run npm.cmd ci.
    goto :failed
  )
  call :install_dependencies
  if errorlevel 1 goto :failed
)

if /i "%MODE%"=="--check" (
  call :check_dev_port
  if errorlevel 1 (
    echo [%APP_NAME%] Preflight found port %DEV_PORT% in use. Normal startup stops to avoid opening an old Vite page.
    exit /b 2
  )
  echo.
  echo [%APP_NAME%] Development preflight passed. No server or desktop window was started.
  exit /b 0
)

call :check_dev_port
if errorlevel 1 goto :failed

echo.
echo [%APP_NAME%] Starting Tauri development mode...
echo [%APP_NAME%] Tauri will start Vite at http://127.0.0.1:%DEV_PORT% and open a desktop development window.
echo [%APP_NAME%] This is not a production EXE installer. Closing the development session ends this run.
echo.
call npm.cmd run tauri -- dev
if errorlevel 1 (
  echo.
  echo [%APP_NAME%] Tauri development startup failed. Start with the first error shown above.
  echo Common causes: missing Windows C++ Build Tools, incomplete Rust toolchain, port %DEV_PORT% in use, or incomplete dependencies.
  goto :failed
)

echo.
echo [%APP_NAME%] Development session ended normally.
exit /b 0

:require_command
where %~1 >nul 2>nul
if errorlevel 1 (
  echo [%APP_NAME%] Missing required command: %~2.
  echo Install the required runtime, then run this file again. Node.js LTS and Rust stable-msvc are recommended.
  exit /b 1
)
exit /b 0

:check_dependencies
if not exist "node_modules\@tauri-apps\cli\package.json" exit /b 1
if not exist "node_modules\vite\package.json" exit /b 1
call npm.cmd ls --depth=0 --omit=optional >nul 2>nul
if errorlevel 1 exit /b 1
exit /b 0

:install_dependencies
echo.
echo [%APP_NAME%] Installing frontend development dependencies...
if exist "package-lock.json" (
  call npm.cmd ci --no-audit --no-fund
) else (
  echo [%APP_NAME%] package-lock.json is missing. npm install will be used; review the lockfile after installation.
  call npm.cmd install --no-audit --no-fund
)
if errorlevel 1 (
  echo [%APP_NAME%] Dependency installation failed. Keep this window open and use the npm error above.
  exit /b 1
)
call :check_dependencies
if errorlevel 1 (
  echo [%APP_NAME%] npm finished, but a required development dependency is still unavailable.
  exit /b 1
)
exit /b 0

:check_dev_port
set "PORT_BUSY="
for /f "tokens=5" %%P in ('netstat -ano ^| findstr /i "LISTENING" ^| findstr /r /c:":%DEV_PORT% "') do (
  set "PORT_BUSY=1"
  echo [%APP_NAME%] Port %DEV_PORT% is already in use by PID %%P:
  tasklist /fi "PID eq %%P" /fo table /nh 2>nul
)
if defined PORT_BUSY (
  echo Close the previous Vite / npm / Tauri development process and retry. This launcher never kills processes automatically.
  exit /b 1
)
exit /b 0

:failed
echo.
if /i "%MODE%"=="--check" (
  echo [%APP_NAME%] Development preflight failed. No server or desktop window was started.
  exit /b 1
)
echo [%APP_NAME%] Development mode did not start. Keep this window open, then press any key to close it.
pause >nul
exit /b 1

:help
echo.
echo Usage:
echo   Double-click this launcher       Start Tauri development mode
echo   this-launcher.cmd --check        Check dependencies and port %DEV_PORT%, without starting the app
echo.
echo This script does not build an installer and does not launch a bare target\debug EXE.
exit /b 0
