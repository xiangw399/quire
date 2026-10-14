<#
Quire 的文件类型注册。

只做加法，不动任何默认程序：

  1. 把 Quire 注册成一个可选的处理程序（Applications\Quire.exe + 正确的 DefaultIcon）；
  2. 为每类文件注册一个独立 ProgId（Quire.markdown / Quire.html / …），各自指向自己的图标，
     并挂进各扩展名的 OpenWithProgids 与 Applications\Quire.exe\SupportedTypes。

于是"打开方式"和"设置 → 默认应用"里都能看到 Quire，图标也是对的；至于要不要用 Quire 打开
某类文件，永远由你在系统界面里点。

注意一个 Windows 行为（实测）：当你在"打开方式"里勾了"始终使用"之后，系统会把这条选择写进
受保护的 UserChoice 记录，并指向**应用级** ProgId（Applications\Quire.exe）。也就是说这类文件的
图标会跟着**应用图标**走，而不是本类型的那枚页面图标。这不是注册没生效——UserChoice 是系统
保护的记录，程序删不掉（删掉会被立刻用新哈希重建），我们也不会去动它。

用法：
  注册    powershell -ExecutionPolicy Bypass -File register-file-types.ps1 -AppDir "D:\Quire"
  注销    powershell -ExecutionPolicy Bypass -File register-file-types.ps1 -AppDir "D:\Quire" -Action unregister
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$AppDir,
  # 每类图标所在目录；默认取发行目录里随包分发的那份。
  [string]$IconDir,
  [ValidateSet('register', 'unregister')][string]$Action = 'register'
)

$ErrorActionPreference = 'Stop'

$exeName = 'Quire.exe'
$exe = Join-Path $AppDir $exeName
if (-not $IconDir) { $IconDir = Join-Path $AppDir 'resources\app\assets\file' }

$classes = 'HKCU:\Software\Classes'
$appKey = Join-Path $classes "Applications\$exeName"

# 类型 → 独立 ProgId、图标、扩展名、在资源管理器"类型"列里显示的名字
$TYPES = @(
  @{ ProgId = 'Quire.markdown'; Icon = 'markdown.ico'; Label = 'Markdown 文档'; Ext = @('.md', '.markdown') }
  @{ ProgId = 'Quire.html';     Icon = 'html.ico';     Label = 'HTML 文档';     Ext = @('.html', '.htm') }
  @{ ProgId = 'Quire.text';     Icon = 'text.ico';     Label = '文本文档';      Ext = @('.txt') }
  @{ ProgId = 'Quire.pdf';      Icon = 'pdf.ico';      Label = 'PDF 文档';      Ext = @('.pdf') }
  @{ ProgId = 'Quire.code';     Icon = 'code.ico';     Label = '代码文件';      Ext = @('.js', '.mjs', '.cjs', '.json', '.css') }
  @{ ProgId = 'Quire.table';    Icon = 'table.ico';    Label = '表格文本';      Ext = @('.csv', '.tsv') }
  @{ ProgId = 'Quire.image';    Icon = 'image.ico';    Label = '图片';          Ext = @('.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg') }
)

function Set-DefaultValue {
  param([string]$Path, [string]$Value)
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  Set-Item -Path $Path -Value $Value
}

function Set-Entry {
  param([string]$Path, [string]$Name, [string]$Value)
  if (-not (Test-Path $Path)) { New-Item -Path $Path -Force | Out-Null }
  New-ItemProperty -Path $Path -Name $Name -Value $Value -PropertyType String -Force | Out-Null
}

function Remove-RegistryKey {
  param([string]$Path)
  # 用 .NET 而不是 Remove-Item：PowerShell 的 provider 对"没有子键的键"会报
  # "Cannot delete a subkey tree because the subkey does not exist"，容易误判成删除成功。
  if (-not (Test-Path $Path)) { return }
  $subPath = $Path -replace '^HKCU:\\', ''
  try {
    [Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($subPath, $false)
  } catch {
    Write-Warning "无法删除 $Path：$($_.Exception.Message)"
  }
}

if ($Action -eq 'unregister') {
  $removed = 0
  foreach ($type in $TYPES) {
    foreach ($extension in $type.Ext) {
      # OpenWithProgids 与 SupportedTypes 下面写的是"值"（名字就是 ProgId / 扩展名），不是子键；
      # 按子键去 Test-Path 会永远找不到，卸载时就会留下垃圾。
      $openWithKey = Join-Path (Join-Path $classes $extension) 'OpenWithProgids'
      if ($null -ne (Get-ItemProperty -Path $openWithKey -Name $type.ProgId -ErrorAction SilentlyContinue)) {
        Remove-ItemProperty -Path $openWithKey -Name $type.ProgId -Force -ErrorAction SilentlyContinue
        $removed += 1
      }
      Remove-ItemProperty -Path (Join-Path $appKey 'SupportedTypes') -Name $extension -Force -ErrorAction SilentlyContinue
    }
    Remove-RegistryKey (Join-Path $classes $type.ProgId)
  }
  Remove-RegistryKey $appKey
  Write-Host ("[Quire] 已注销文件类型注册（清掉 {0} 条 OpenWithProgids；默认程序从未被改动）" -f $removed)
  return
}

if (-not (Test-Path $exe)) { throw "找不到 $exe，请在发行目录里运行本脚本。" }

# 1. 应用级注册：出现在"打开方式"与"默认应用"里
Set-DefaultValue -Path $appKey -Value 'Quire'
Set-Entry -Path $appKey -Name 'FriendlyAppName' -Value 'Quire'
# 索引必须写在引号外面。写成 "…\Quire.exe,0" 会让 shell 去找一个叫 Quire.exe,0 的文件，
# 找不到就退回系统"空白文档"通用图标——这正是之前 .md/.html 图标变怪的原因。
Set-DefaultValue -Path (Join-Path $appKey 'DefaultIcon') -Value ('"{0}",0' -f $exe)

# 2. 每类文件一个 ProgId，各带自己的图标与打开命令
$registered = @()
foreach ($type in $TYPES) {
  $progId = $type.ProgId
  $progKey = Join-Path $classes $progId
  $iconPath = Join-Path $IconDir $type.Icon

  Set-DefaultValue -Path $progKey -Value $type.Label
  Set-DefaultValue -Path (Join-Path $progKey 'DefaultIcon') -Value $iconPath
  Set-DefaultValue -Path (Join-Path $progKey 'shell\open\command') -Value ('"{0}" "%1"' -f $exe)
  # 让这个 ProgId 在系统界面里以应用条目的身份出现
  Set-Entry -Path (Join-Path $progKey 'Application') -Name 'ApplicationName' -Value 'Quire'

  foreach ($extension in $type.Ext) {
    Set-Entry -Path (Join-Path (Join-Path $classes $extension) 'OpenWithProgids') -Name $progId -Value ''
    Set-Entry -Path (Join-Path $appKey 'SupportedTypes') -Name $extension -Value ''
    $registered += $extension
  }
}

Write-Host ("[Quire] 已注册 {0} 个扩展名：{1}" -f $registered.Count, ($registered -join ' '))
Write-Host '[Quire] 默认程序未被改动：要不要用 Quire 打开某类文件，请在“打开方式”里自行选择。'
