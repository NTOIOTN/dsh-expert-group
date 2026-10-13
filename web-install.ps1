# 安装 dsh-expert-group 到 DSH 的全局插件位置（$DSH_HOME\profiles\packages\dsh-expert-group），
# 与工程/源码目录完全解耦：删除本脚本所在的原始目录后插件仍可正常运行。
# 支持从解压后的包目录直接运行：powershell -ExecutionPolicy Bypass -File .\web-install.ps1
# 同时清理同名旧安装位置（profiles\web\packages\*）。
# 复制面 = package.json 的 files 白名单：test/、test-support/、bench/、.scratch/ 等
# 开发内容与构建产物 tgz 不会进入用户目录。
# 维护用干跑模式（不做任何写入，仅供发布门禁/人工核对安装清单）：
#   powershell -ExecutionPolicy Bypass -File .\web-install.ps1 -DryRun [-DryRunListPath <文件>]
param(
  # 干跑模式：只解析并输出安装白名单，不做任何写入、不构建 bundle、不调用 dsh CLI。
  # 发布门禁测试用它核对「实际安装清单 == package.json 的 files 白名单」。
  [switch]$DryRun,
  # 干跑清单的落盘路径：显式以 UTF-8 写出，避免控制台代码页差异影响测试读取。
  [string]$DryRunListPath
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sourcePath = $scriptDir
$packageName = "dsh-expert-group"

<#
  解析安装白名单：以 package.json 的 files 字段（npm 发布面的唯一事实源）为准。
  设计要点：
  - 旧实现整目录复制（只排除 node_modules），会把 test/、test-support/、bench/、
    .scratch/ 开发草稿与构建产物 tgz 一并带进用户 profiles，既膨胀体积又泄露开发内容，
    因此这里改为逐项复制 files 声明的条目。
  - files 缺省或为空时直接抛错而不是回退整目录：宁可安装中断，也不放大安装面。
  - npm 语义下 package.json 自身始终随包发布（files 里通常不写它），显式补入，
    否则 dsh plugin add 与 Node 的包解析都无法识别安装目录。
  - 每项必须是仓库内相对路径：绝对路径、drive 前缀与 .. 越界项一律拒绝。
  - 该函数被 DryRun 与真实复制共用，保证发布门禁验证的就是实际安装行为。
#>
function Get-InstallWhitelistEntries {
  param([string]$Source)

  $manifestPath = Join-Path $Source "package.json"
  if (-not (Test-Path -LiteralPath $manifestPath)) {
    throw "源目录缺少 package.json，无法解析安装白名单：$Source"
  }
  try {
    # -Encoding UTF8：WinPS 5.1 的 Get-Content 默认按 ANSI 读取，UTF-8 manifest 的
    # 中文 description 会被读成乱码导致 ConvertFrom-Json 失败；pwsh 7 默认 UTF-8 无此
    # 问题，显式声明让两个宿主行为一致。
    $sourceManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "无法解析源 package.json $manifestPath：$($_.Exception.Message)"
  }

  $declared = @($sourceManifest.files | Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) })
  if ($declared.Count -eq 0) {
    throw "源 package.json 的 files 白名单为空，拒绝整目录复制。请先在 package.json 中声明发布面。"
  }

  $entries = @($declared + @("package.json"))
  $normalized = @()
  foreach ($entry in $entries) {
    # 统一分隔符为 /（npm 约定）并剥掉 ./ 前缀与尾部斜杠，得到仓库内相对路径。
    $relative = ([string]$entry).Trim() -replace '\\', '/'
    while ($relative.StartsWith("./")) { $relative = $relative.Substring(2) }
    $relative = $relative.TrimEnd('/')
    if ($relative -eq "" -or $relative.StartsWith("/") -or $relative -match "(^|/)\.\.(/|$)" -or $relative.Contains(":")) {
      throw "package.json files 含越界或非相对路径项，拒绝安装：$entry"
    }
    $normalized += $relative
  }
  # 去重，避免同一路径被复制两次（例如 files 同时列了目录与其子项）。
  return @($normalized | Select-Object -Unique)
}

if ($DryRun) {
  # 干跑：只输出白名单相对路径（每行一项，/ 分隔），不做任何文件系统写入、
  # 不构建 client bundle、不调用 dsh CLI，因此在测试与 CI 中可安全执行。
  $dryRunEntries = @(Get-InstallWhitelistEntries -Source $sourcePath)
  if (-not [string]::IsNullOrWhiteSpace($DryRunListPath)) {
    # 显式 UTF-8 落盘（PS 5.1 会带 BOM，读取方需容忍 BOM）：非 ASCII 条目也不会因
    # 控制台代码页差异被读成乱码，测试因此可在任意 Windows/locale 下稳定断言。
    $dryRunEntries | Set-Content -LiteralPath $DryRunListPath -Encoding UTF8
  }
  foreach ($dryRunEntry in $dryRunEntries) { Write-Output $dryRunEntry }
  exit 0
}

# 源码目录和正式 npm 包都携带组合脚本；安装前统一刷新唯一的 classic client bundle，
# 保证复制到 profile 的生成物与三个源文件严格同步。
$clientAssembler = Join-Path $sourcePath "scripts\assemble-client.mjs"
if (Test-Path -LiteralPath $clientAssembler) {
  Write-Host "生成 Expert Group 客户端 bundle ..." -ForegroundColor Cyan
  & node $clientAssembler
  if ($LASTEXITCODE -ne 0) { throw "客户端 bundle 生成失败，退出码 $LASTEXITCODE" }
}

# 全局安装位置必须位于 $DSH_HOME\profiles 目录树内：这样 Node 的父目录查找能找到
# $DSH_HOME\profiles\node_modules 的平坦依赖回退（@deepseek-ai/schemastery 等 Host
# 运行时依赖都在那里）。直接 link 工程源码目录会让 index.js 的嵌套 import 无法解析，
# 且工程目录删除后插件即失效——全局安装正是为了避免这一点。
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\web"
$installTarget = Join-Path $dshHome "profiles\packages\$packageName"

Write-Host "全局安装 $packageName ..." -ForegroundColor Cyan
Write-Host "  源目录：$sourcePath"
Write-Host "  全局安装位置：$installTarget"

# 使用解析后的 profile 对象判断插件是否已经完成正式登记；不靠原始文本猜测。
$profileManifest = Join-Path $profileDir "package.json"
$manifest = $null
if (Test-Path -LiteralPath $profileManifest) {
  try {
    # 同上：profile manifest 由 dsh/插件写入 UTF-8，WinPS 5.1 需显式编码读取。
    $manifest = Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  } catch {
    throw "无法解析 DSH profile manifest $profileManifest：$($_.Exception.Message)"
  }
}

$dependencyProperty = $null
if ($null -ne $manifest -and $null -ne $manifest.dependencies) {
  $dependencyProperty = $manifest.dependencies.PSObject.Properties[$packageName]
}
$dependencyValue = if ($null -ne $dependencyProperty) { [string]$dependencyProperty.Value } else { $null }
$bundleValues = @()
if ($null -ne $manifest -and $null -ne $manifest.dsh -and $null -ne $manifest.dsh.profile -and $null -ne $manifest.dsh.profile.bundles) {
  $bundleValues = @($manifest.dsh.profile.bundles)
}
$hasDependency = $null -ne $dependencyProperty -and -not [string]::IsNullOrWhiteSpace($dependencyValue)
$hasBundle = @($bundleValues | Where-Object { $_ -is [string] -and $_ -eq $packageName }).Count -gt 0
$profileRegistered = $hasDependency -and $hasBundle

# CLI 可用时仍由 DSH 正式管理注册；CLI 不在 PATH 时只能升级已登记插件。
$dsh = Get-Command dsh -ErrorAction SilentlyContinue
$dshCommand = $null
if ($null -ne $dsh) {
  $dshCommand = if (-not [string]::IsNullOrWhiteSpace([string]$dsh.Source)) {
    [string]$dsh.Source
  } else {
    [string]$dsh.Name
  }
}
$hasDshCommand = -not [string]::IsNullOrWhiteSpace($dshCommand)
if (-not $hasDshCommand -and -not $profileRegistered) {
  throw "未找到 dsh 命令，且 profile 尚未有效登记 $packageName。请先安装 @deepseek-ai/dsh 并确保其 bin 目录在 PATH 中，再通过 DSH CLI 执行首次注册；脚本不会手工修改 profile。"
}
if ($hasDshCommand) {
  Write-Host "  已检测到 DSH CLI，将执行正式 remove/add 注册流程。" -ForegroundColor DarkGray
} else {
  Write-Host "  未找到 DSH CLI，但 profile 已有效登记 $packageName。将仅同步源码。" -ForegroundColor Yellow
}

# 卸载本包已有依赖，避免同一行重复注册导致工具重名。
if ($hasDshCommand) {
  foreach ($pkg in @($packageName)) {
    $installed = $false
    if ($null -ne $manifest -and $null -ne $manifest.dependencies) {
      $installed = $null -ne $manifest.dependencies.PSObject.Properties[$pkg]
    }
    if ($installed) {
      Write-Host "  卸载已有依赖 $pkg ..." -ForegroundColor Yellow
      & $dshCommand plugin --profile web remove $pkg
      if ($LASTEXITCODE -ne 0) { throw "$dshCommand plugin remove $pkg 失败，退出码 $LASTEXITCODE" }
    }
  }
}

# 清理目标安装副本（profiles\web\packages\*）。
foreach ($legacy in @("$profileDir\packages\$packageName")) {
  if (Test-Path $legacy) {
    Remove-Item $legacy -Recurse -Force
    Write-Host "  已删除旧安装副本 $legacy" -ForegroundColor DarkGray
  }
}

# 同步全局安装副本：先清理旧副本，再严格按 package.json 的 files 白名单逐项复制。
# 白名单外的一切（test/、test-support/、bench/、.scratch/、tgz、docs/、node_modules）
# 都不会进入用户目录；目录项递归复制，文件项直接复制。
# 若脚本本身就运行在安装目标目录内（重新安装场景），跳过自复制。
if ($sourcePath -ne $installTarget) {
  if (Test-Path $installTarget) { Remove-Item $installTarget -Recurse -Force }
  New-Item -ItemType Directory -Path $installTarget -Force | Out-Null

  $whitelist = @(Get-InstallWhitelistEntries -Source $sourcePath)
  foreach ($entry in $whitelist) {
    # 白名单在解析阶段已统一为 / 分隔并校验过相对性；这里再转成本机分隔符拼路径。
    $relativePath = $entry -replace '/', '\'
    $sourceItem = Join-Path $sourcePath $relativePath
    if (-not (Test-Path -LiteralPath $sourceItem)) {
      throw "安装白名单项在源目录中不存在：$relativePath（请同步修正 package.json 的 files）"
    }

    # 关键：先确保父目录存在，再把条目复制到父目录里，让 Copy-Item 自行拼接叶子名。
    # 若直接以该条目自身的完整目标路径作为 -Destination 且该路径已存在，Copy-Item 会
    # 在目标下多套一层同名目录，导致安装目录结构错位。
    $targetParent = Split-Path -Parent (Join-Path $installTarget $relativePath)
    if (-not (Test-Path -LiteralPath $targetParent)) {
      New-Item -ItemType Directory -Path $targetParent -Force | Out-Null
    }

    # 白名单可能出现重叠（既列目录又列其子项）或重复项：先删除同名目标，避免
    # Copy-Item 把源目录合并进已有同名目录而产生「新旧混合」的安装副本。
    $copied = Join-Path $targetParent (Split-Path -Leaf $relativePath)
    if (Test-Path -LiteralPath $copied) { Remove-Item -LiteralPath $copied -Recurse -Force }
    Copy-Item -LiteralPath $sourceItem -Destination $targetParent -Recurse -Force
  }
  Write-Host ("  已按 files 白名单复制 {0} 项到安装目录（node_modules 与未声明内容不复制）" -f $whitelist.Count) -ForegroundColor DarkGray
} else {
  Write-Host "  脚本位于安装目标目录内，跳过复制" -ForegroundColor DarkGray
}

# CLI 可用时通过 DSH 的正式流程加入 web profile；无 CLI 时仅保留现有登记并同步源码。
if ($hasDshCommand) {
  & $dshCommand plugin --profile web add $installTarget
  if ($LASTEXITCODE -ne 0) {
    throw "$dshCommand plugin add 失败，退出码 $LASTEXITCODE"
  }
  Write-Host "完成 CLI 注册与源码同步。请重启 DSH Web（dsh web）后刷新页面。验证：$dshCommand --profile web --dump-config" -ForegroundColor Green
} else {
  Write-Host "已跳过 CLI 注册，保留现有 profile 登记。源码已同步。请重启 DSH Web（dsh web）后刷新页面。" -ForegroundColor Green
}
