@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title YH Universal Runtime

set "NODE_EXE="
if defined YH_NODE_EXE if exist "%YH_NODE_EXE%" set "NODE_EXE=%YH_NODE_EXE%"
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fN"
)
if not defined NODE_EXE goto node_missing

for %%I in ("%NODE_EXE%") do set "NODE_DIR=%%~dpI"
set "PATH=%NODE_DIR%;%PATH%"

"%NODE_EXE%" -e "const [M,m]=process.versions.node.split('.').map(Number); process.exit(((M===20&&m>=19)||(M===22&&m>=12)||M>22)?0:1)"
if errorlevel 1 goto node_too_old

set "NEED_INSTALL=0"
if not exist "node_modules\vite\bin\vite.js" set "NEED_INSTALL=1"
if not exist "node_modules\three\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\@babylonjs\core\package.json" set "NEED_INSTALL=1"
if not exist "node_modules\ws\package.json" set "NEED_INSTALL=1"
if "%NEED_INSTALL%"=="1" goto install_dependencies

goto start_yh

:install_dependencies
echo.
echo 首次启动：正在安装 YH 依赖。此步骤需要联网；后续启动无需重复安装。
set "NPM_CMD="
if exist "%NODE_DIR%npm.cmd" set "NPM_CMD=%NODE_DIR%npm.cmd"
if not defined NPM_CMD (
  for /f "delims=" %%N in ('where npm.cmd 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%~fN"
)
if not defined NPM_CMD goto npm_missing
call "%NPM_CMD%" ci --no-audit --no-fund
if errorlevel 1 goto npm_failed

goto start_yh

:start_yh
echo.
echo 正在启动 YH 本机服务。服务就绪后会自动打开浏览器。
echo 此窗口保持打开；按 Ctrl+C 可停止服务。
echo.
"%NODE_EXE%" ".\scripts\start-windows.mjs"
set "RUN_RESULT=%ERRORLEVEL%"
echo.
if "%RUN_RESULT%"=="0" (
  echo YH 已停止。
) else (
  echo YH 已退出，错误代码：%RUN_RESULT%。请查看上方提示。
)
echo 按任意键关闭此窗口。
pause >nul
exit /b %RUN_RESULT%

:node_missing
echo.
echo 未找到 Node.js。请安装 Node.js 20.19 或更高版本，或 22.12 或更高版本，并确保 node.exe 可从 PATH 找到。
echo 安装后重新双击 Start_YH.bat 即可；无需输入 PowerShell 命令。
goto show_error

:node_too_old
echo.
echo 找到的 Node.js 版本过旧。YH 需要 Node.js 20.19+ 或 22.12+。
echo 请更新 Node.js 后重新双击 Start_YH.bat。
goto show_error

:npm_missing
echo.
echo 找到了 Node.js，但没有找到 npm.cmd，无法自动安装依赖。
echo 请安装包含 npm 的 Node.js 发行版后重新双击 Start_YH.bat。
goto show_error

:npm_failed
echo.
echo npm 依赖安装失败。请检查网络后重新双击 Start_YH.bat；无需手动输入命令。

:show_error
echo.
echo 按任意键关闭此窗口。
pause >nul
exit /b 1
