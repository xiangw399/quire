# 部署绿色版到工作区之外，并建好入口
#
# 为什么不能直接用 release 目录：受限目录（例如被 agent 会话/沙箱接管的目录）里的文件会带
# Low 完整性级别，从那里启动的程序继承该级别，Chromium 建沙箱时以 0x80000003 退出。
# zip 也必须先解压，不能从压缩包里直接运行（那会在临时目录里跑，症状与安装包报错相同）。
#
# 用法：powershell -File tools\deploy-portable.ps1 [-Target <安装目录>]

[CmdletBinding()]
param(
  # 部署到哪。默认与安装包一致的用户级目录。
  [string]$Target = (Join-Path $env:LOCALAPPDATA 'Quire')
)

$source = Join-Path (Split-Path $PSScriptRoot -Parent) 'release\Quire'
$target = $Target
$exe = Join-Path $target 'Quire.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Quire.lnk'

Write-Host '=== 1. 部署目录 ==='
if (-not (Test-Path $source)) {
  Write-Host "找不到发布目录: $source" -ForegroundColor Red
  return
}
Write-Host "从 $source"
Write-Host "到   $target"
robocopy $source $target /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
Write-Host ("文件数: " + (Get-ChildItem $target -Recurse -File | Measure-Object).Count)

Write-Host ''
Write-Host '=== 2. 快捷方式 ==='
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcut)
$link.TargetPath = $exe
$link.WorkingDirectory = $target
$link.Description = 'Quire'
$link.Save()
Write-Host "已创建: $shortcut"

Write-Host ''
Write-Host '=== 3. 启动它 ==='
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
Start-Process -FilePath $exe -WorkingDirectory $target
Start-Sleep -Seconds 8
$running = Get-Process -Name 'Quire' -ErrorAction SilentlyContinue
if ($running) {
  Write-Host ("启动成功：进程 " + $running.Count + " 个（主进程 + GPU + 网络 + 渲染器）") -ForegroundColor Green
} else {
  Write-Host '进程不在，读启动日志看走到哪一步：' -ForegroundColor Yellow
  Get-Content "$env:APPDATA\Quire\boot.log" -ErrorAction SilentlyContinue | Select-Object -Last 12
}
