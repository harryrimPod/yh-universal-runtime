$ErrorActionPreference = 'Stop'
$NodeExe = $env:YH_NODE_EXE
if (-not $NodeExe) {
  $found = Get-Command node -ErrorAction SilentlyContinue
  if ($found) { $NodeExe = $found.Source }
}
if (-not $NodeExe -or -not (Test-Path -LiteralPath $NodeExe)) {
  throw "找不到 Node.js。请安装 Node 22+ 并加入 PATH，或设置环境变量 YH_NODE_EXE 指向 node.exe。"
}
$NodeDir = Split-Path -Parent $NodeExe
$env:PATH = "$NodeDir;$env:PATH"

if (-not (Test-Path -LiteralPath '.\node_modules')) {
  $NpmCli = Join-Path $NodeDir 'node_modules\npm\bin\npm-cli.js'
  if (Test-Path -LiteralPath $NpmCli) {
    & $NodeExe $NpmCli install
  } else {
    npm.cmd install
  }
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败，退出码：$LASTEXITCODE" }
}

Write-Host 'YH Universal Runtime 正在本机启动。浏览器打开 http://127.0.0.1:5173，按 Ctrl+C 关闭。'
& $NodeExe '.\scripts\dev.mjs'
