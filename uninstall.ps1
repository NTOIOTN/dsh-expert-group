# 从用户的 web profile 卸载 dsh-expert-group，并清理同名安装副本。
# 用法：powershell -ExecutionPolicy Bypass -File .\uninstall.ps1
$ErrorActionPreference = "Stop"

Write-Host "卸载 dsh-expert-group..." -ForegroundColor Cyan

$dsh = Get-Command dsh -ErrorAction SilentlyContinue
if ($null -eq $dsh) {
  throw "未找到 dsh 命令。请先安装 @deepseek-ai/dsh 并确保其 bin 目录在 PATH 中。"
}

$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
$profileDir = Join-Path $dshHome "profiles\web"
$profileManifest = Join-Path $profileDir "package.json"
# -Encoding UTF8：WinPS 5.1 的 Get-Content 默认按 ANSI 读取，会破坏 UTF-8 manifest 的
# 中文字段并让 ConvertFrom-Json 失败；显式声明使 WinPS 5.1 与 pwsh 7 行为一致。
$manifest = if (Test-Path -LiteralPath $profileManifest) { Get-Content -LiteralPath $profileManifest -Raw -Encoding UTF8 | ConvertFrom-Json } else { $null }

# 卸载当前包名（与 package.json 的 name 一致）。
foreach ($pkg in @("dsh-expert-group")) {
  $installed = $false
  if ($null -ne $manifest -and $null -ne $manifest.dependencies) {
    $installed = @($manifest.dependencies.PSObject.Properties | Where-Object { $_.Name -eq $pkg }).Count -gt 0
  }
  if ($installed) {
    & dsh plugin --profile web remove $pkg
    if ($LASTEXITCODE -ne 0) {
      throw "dsh plugin remove $pkg 失败，退出码 $LASTEXITCODE"
    }
  }
}

# 清理 install.ps1 复制出的安装副本（全局位置与旧的 profile 内 packages 位置都处理）。
# 与安装白名单语义对齐：install.ps1 现在只复制 package.json files 声明的发布面，安装副本
# 自身就是完整的「整包」目录，因此卸载的逆操作仍然是整目录删除，不改成按白名单逐项删除——
# 逐项删除只认同名单，会把旧版整目录复制遗留在用户目录里的 test/、.scratch/、tgz 等
# 残留永久留下，反而破坏卸载的收尾保证。
foreach ($pkg in @("dsh-expert-group")) {
  foreach ($target in @((Join-Path $dshHome "profiles\packages\$pkg"), (Join-Path $profileDir "packages\$pkg"))) {
    if (Test-Path -LiteralPath $target) {
      Remove-Item -LiteralPath $target -Recurse -Force
      Write-Host "已清理安装副本：$target" -ForegroundColor DarkGray
    }
  }
}

Write-Host "完成。重启 DSH Web 后生效。" -ForegroundColor Green
