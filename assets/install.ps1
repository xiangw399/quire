# 安装「Quire」——不依赖安装器自解压
#
# 为什么需要它：NSIS 生成的安装包运行时必须先把自身解压到临时目录，某些环境
# （临时目录被策略/杀软限制、从网络位置或压缩包内直接运行、TEMP 路径异常）会在这一步
# 失败，报 "Error writing temporary file"。这个脚本不写任何临时文件：它在就地放置的
# 发行目录旁直接复制、建快捷方式、写卸载信息，因此上述环境都能装。
#
# 用法（在解压出来的目录里运行）：
#     powershell -ExecutionPolicy Bypass -File install.ps1
# 卸载：
#     powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall

[CmdletBinding()]
param(
  # 安装到哪里。默认按用户安装，不需要管理员。
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Quire'),
  # 只装不建快捷方式。
  [switch]$NoShortcuts,
  # 卸载。
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$appName = 'Quire'
$exeName = 'Quire.exe'
$source = $PSScriptRoot

function Get-ShortcutPath {
  Join-Path ([Environment]::GetFolderPath('Desktop')) "$appName.lnk"
}

function New-Shortcuts {
  param([string]$Target, [string]$WorkingDirectory)

  $shell = New-Object -ComObject WScript.Shell
  $desktop = Get-ShortcutPath
  $link = $shell.CreateShortcut($desktop)
  $link.TargetPath = Join-Path $Target $exeName
  $link.WorkingDirectory = $WorkingDirectory
  $link.Description = $appName
  $link.Save()

  $programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
  $menuDir = Join-Path $programs $appName
  New-Item -ItemType Directory -Path $menuDir -Force | Out-Null
  $menu = $shell.CreateShortcut((Join-Path $menuDir "$appName.lnk"))
  $menu.TargetPath = Join-Path $Target $exeName
  $menu.WorkingDirectory = $WorkingDirectory
  $menu.Save()

  # 让阅读器出现在「打开方式」里，可关联文档后缀。
  $classes = 'HKCU:\Software\Classes\Applications\' + $exeName
  New-Item -Path $classes -Force | Out-Null
  New-Item -Path (Join-Path $classes 'shell\open\command') -Force | Out-Null
  Set-ItemProperty -Path $classes -Name 'FriendlyAppName' -Value $appName
  Set-ItemProperty -Path (Join-Path $classes 'shell\open\command') -Name '(default)' -Value ('"' + (Join-Path $Target $exeName) + '" "%1"')

  return @($desktop, (Join-Path $menuDir "$appName.lnk"))
}

function Remove-Shortcuts {
  $desktop = Get-ShortcutPath
  if (Test-Path $desktop) { Remove-Item $desktop -Force }
  $menuDir = Join-Path (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs') $appName
  if (Test-Path $menuDir) { Remove-Item $menuDir -Recurse -Force }
  Remove-Item -Path ('HKCU:\Software\Classes\Applications\' + $exeName) -Recurse -Force -ErrorAction SilentlyContinue
}

function Write-UninstallEntry {
  param([string]$Target, [string]$Version)
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $appName
  New-Item -Path $key -Force | Out-Null
  Set-ItemProperty -Path $key -Name 'DisplayName' -Value $appName
  Set-ItemProperty -Path $key -Name 'DisplayVersion' -Value $Version
  Set-ItemProperty -Path $key -Name 'Publisher' -Value 'Quire'
  Set-ItemProperty -Path $key -Name 'InstallLocation' -Value $Target
  # 卸载入口带上安装目录：安装脚本里的默认值是默认安装位置，自定义过 -InstallDir
  # 时，不带这个参数就会去删默认位置（或什么都不删）。
  Set-ItemProperty -Path $key -Name 'UninstallString' -Value ('powershell -ExecutionPolicy Bypass -File "' + (Join-Path $Target 'install.ps1') + '" -Uninstall -InstallDir "' + $Target + '"')
  Set-ItemProperty -Path $key -Name 'NoModify' -Value 1 -Type DWord
  Set-ItemProperty -Path $key -Name 'NoRepair' -Value 1 -Type DWord
}

function Get-AppVersion {
  $manifest = Join-Path $source 'resources\app\package.json'
  if (Test-Path $manifest) {
    try { return (Get-Content $manifest -Raw | ConvertFrom-Json).version } catch { }
  }
  return '0.1.0'
}

# 只有能证明是本应用安装目录的路径才允许被递归删除。
#
# 默认值是安全的，但 -InstallDir 是命令行参数：没有这道闸，
# `install.ps1 -Uninstall -InstallDir C:\Users\me` 就是一句删库命令。
function Assert-RemovableInstallDir {
  param([string]$Target)

  $full = [System.IO.Path]::GetFullPath($Target)
  $trimmed = $full.TrimEnd('\')
  $root = [System.IO.Path]::GetPathRoot($full).TrimEnd('\')

  if ($trimmed -eq $root) { throw "拒绝卸载：$full 是驱动器根目录。" }
  if ($trimmed -ieq ([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')) { throw "拒绝卸载：$full 是当前用户的主目录。" }
  if (-not (Test-Path (Join-Path $full $exeName))) { throw "拒绝卸载：$full 下没有 $exeName，不像本应用的安装目录。" }
}

if ($Uninstall) {
  Write-Host "卸载 $appName（$InstallDir）"
  Assert-RemovableInstallDir -Target $InstallDir
  Remove-Shortcuts
  Remove-Item -Path ('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $appName) -Recurse -Force -ErrorAction SilentlyContinue
  if (Test-Path $InstallDir) {
    # 卸载时不能删掉自己正在运行的脚本：先把副本放到别处再删目录。
    $self = Join-Path $InstallDir 'install.ps1'
    if (Test-Path $self) { Remove-Item $self -Force -ErrorAction SilentlyContinue }
    Remove-Item -Path $InstallDir -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "已删除 $InstallDir"
  }
  Write-Host '卸载完成。'
  return
}

if (-not (Test-Path (Join-Path $source $exeName))) {
  throw "找不到 $exeName。请在解压出来的发行目录里运行本脚本。"
}

Write-Host "源目录   $source"
Write-Host "安装到   $InstallDir"

New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
# 逐项复制：不经过任何临时打包/解包步骤，这是这个脚本存在的意义。
$copied = 0
Get-ChildItem -Path $source -Recurse -Force | ForEach-Object {
  $relative = $_.FullName.Substring($source.Length).TrimStart('\')
  $target = Join-Path $InstallDir $relative
  if ($_.PSIsContainer) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  } else {
    New-Item -ItemType Directory -Path (Split-Path $target -Parent) -Force | Out-Null
    Copy-Item -Path $_.FullName -Destination $target -Force
    $copied += 1
  }
}
Write-Host "已复制 $copied 个文件"

# 安装后的目录里也放一份本脚本，卸载入口才有东西可指。
Copy-Item -Path (Join-Path $source 'install.ps1') -Destination (Join-Path $InstallDir 'install.ps1') -Force -ErrorAction SilentlyContinue

Write-UninstallEntry -Target $InstallDir -Version (Get-AppVersion)

if (-not $NoShortcuts) {
  $made = New-Shortcuts -Target $InstallDir -WorkingDirectory $InstallDir
  Write-Host '已创建快捷方式：'
  $made | ForEach-Object { Write-Host "  $_" }
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "启动：$InstallDir\$exeName"
