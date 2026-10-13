# 桌面版专用安装编排器（profile 固定为 desktop）。
#
# 用法（仓库根直接执行，不需要任何额外参数）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\desktop-install.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\desktop-install.ps1 -DshInstallDirectory 'D:\deepseek-harness'
#
# 阶段（顺序即下方执行顺序）：预检 -> build -> test -> 持久目录打包 ->
# 解包/发布面检查 -> 安装前完整备份 -> CLI add -> CLI list -> 安装后 profile 与逐文件 SHA256 校验。
# 每个阶段的输出都落盘到 $packDir\logs\，任一命令失败立即中止并保留全部产物。
#
# 硬边界（有意为之，勿放宽）：
#   - 不调用、不点源 web-install.ps1：那个脚本是 web profile 的安装器，两者职责不同。
#   - 不使用 --force、不执行 plugin remove、不自动重试、不自动回滚、不自动重启桌面版。
#   - 只通过应用自带 CLI 操作 desktop profile，绝不手工改写 profile 里的任何文件。
#   - 打包目录与备份目录都带唯一时间戳，不覆盖、不清理历史目录（旧包是回滚材料）。
#
# 已知基线失败白名单（逐项证据吻合，不使用数量阈值，也不接受弱证据）：
#   完整测试当前有且仅有两条既有断言失败，与部署无关（本仓库当前实测基线，非外部文档转述）。
#   白名单条目必须同时吻合下列全部字段才算通过（任一项不符即中止）：
#     标题、failureType、name、code、operator、expected、actual，
#     以及 error 文本（精确相等或逐片段包含），
#     且 stack 的「首帧」必须结构化精确命中指定的断言行 (文件, 行, 列) 三元组。
#   1) 标题：package files、exports、bin 和 bundle patch 都指向当前工作区中的可发布文件
#      failureType=testCodeFailure / name=AssertionError / code=ERR_ASSERTION / operator=strictEqual
#      expected='./bin/prompt-inspector.mjs' / actual='bin/prompt-inspector.mjs'
#      error=严格相等断言 diff；断言首帧=(test/package-portability.test.mjs, 92, 10)
#   2) 标题：README 与实现一致：goals 可选服务决策、诊断入口与敏感性边界都有文档标记
#      failureType=testCodeFailure / name=AssertionError / code=ERR_ASSERTION / operator==
#      expected=true / actual=false / error='README 必须记录 meta 的 capabilities 字段'
#      断言首帧=(test/capability-diagnostics.test.mjs, 416, 10)
#   首帧定位必须是「结构化解析 + 三元组整体相等」，绝不做子串 / IndexOf 命中：
#     - 从首帧的末尾括号组里取出定位串，拆成 路径段 + 行号 + 列号；
#       路径归一化：去掉 file: / file:// 前缀、反斜杠统一成 '/'、剥掉查询串与锚点；
#       真实 Windows 首帧还会把盘符路径里的空格写成百分号转义（例如 file:///F:/01%20AI/...），
#       因此同时产出「原始」与「百分号解码后」两个候选：任一候选按「路径段边界」与白名单文件
#       精确相等即算文件维度吻合（比较时忽略大小写，Windows 路径大小写不敏感）；解码失败不额外放宽。
#       行列按整数整体相等。因此 ':92:100'、':92:10x'、':92:10 extra' 这类被追加或改写的
#       定位一律拒绝，前后多出位置文本、括号里不是单一 location 也一律拒绝。
#     - 每个白名单条目最多只能被接受一次：同一条已知失败重复出现（即便 '# fail N' 与解析数
#       一致）也一律中止，杜绝用「同一条基线失败刷满失败数」掩盖新失败。
#     - 白名单条目「不要求全部出现」：基线被修好后可以 0 条失败直接通过。
#   明确拒绝的弱证据：
#     - location（测试定义行）单独命中不算通过；location 只用于与期望文件做一致性交叉核对，
#       真正的定位证据只能是 stack 首帧的断言行。
#     - 同一标题下换成别的断言位置 / 别的 expected / actual，一律视为非基线失败并中止。
#     - TAP 结构无法识别、失败块缺少 stack 或断言详情、失败块解析数与 '# fail N' 不符、
#       以及任何白名单之外的失败，全部立即中止——不允许用「失败数不超过 2」这类阈值蒙混过关。
#
# profile 路径隔离检查必须 fail closed：
#   - 不允许用非终止性的 Test-Path 当早退条件：Test-Path 返回 false 无法区分「不存在」「无权读取」
#     与「损坏的 reparse point」，任何以它为依据的 continue 都是 fail open。判定存在性、目录属性
#     与链接属性一律走严格读取器（Get-ExistingFileSystemItem），读不到就中止。
#   - 读取 reparse point 属性失败（Get-Item 拿不到对象、链接目标读不出来）时抛错中止，
#     绝不退化成「不是链接」继续往下走；只有明确读到「不是 reparse point」才返回 false。
#   - profiles 与 profiles\desktop 是本次安装必需的既有目录：必须严格读取成功、属性可读、
#     且确实是目录，随后再做链接判定；任一条不满足立即中止，不得跳过检查。
#   - profiles\web 是可选的：不得用 Test-Path 判断它是否存在，只能枚举已验证可读的 profiles
#     目录（-Force -ErrorAction Stop）精确找名称为 web 的文件系统项；枚举失败、无法判定或出现
#     重复项都中止，只有「确实不存在」才跳过同源比较。存在时必须是目录并完整解析真实路径。
#   - 真实路径解析必须「逐级解析每一个祖先组件」，不能只看最终项本身：
#     解析范围是「盘符根 -> 目标目录」的每一级，任何一级是 reparse point 都读取并解析它的 Target
#     （支持绝对与相对目标，相对目标以链接所在目录为基准），然后把链接点之后的剩余组件接回目标之后。
#     遇到「对象缺失 / 属性或 Target 读不出来 / 目标无法规范化 / 出现环 / 总链接跳数超过 16」时抛错中止，
#     绝不返回未解析的路径去和 web profile 做比较（那会让两个不同目录被误判成同源而放行）。
#     只看最终项会漏掉「祖先目录被换成 junction」这种重定向：例如 DSH_HOME 是链接、而 profiles\web
#     又指向 profiles\desktop 时，desktop 的 lexical 路径与 web 的真实路径文本不同，同源比较会放行。
#   - DSH_HOME 本身允许是链接（用户有权把 home 放到别的盘），因此 home 一级的 reparse point 只解析、不拒绝；
#     拒绝只针对 profiles 与 profiles\desktop 这两级自身是 reparse point 的情况。
#   - desktop 与 web 的同源比较必须用规范化后的真实路径：分隔符统一、忽略尾部斜杠、大小写不敏感，
#     避免大小写或写法差异把「同一个物理目录」判成不同源。
#   - profile 根 profiles / profiles\desktop 是 reparse point，或 desktop 与 web 的 realpath
#     相同，都直接拒绝。
#
# 兼容性：语法保持 Windows PowerShell 5.1 可用（不使用 ?? / ?. / 三元运算），
# 文件为 UTF-8 BOM + LF 行尾（与 web-install.ps1 一致，WinPS 5.1 靠 BOM 才能正确读中文注释）。

param(
  # DSH 应用安装根目录：其下应有 resources\runtime\cli\bin\dsh.cmd。
  # 缺省取 $env:DSH_INSTALL_DIR，再退回 D:\deepseek-harness。
  [string]$DshInstallDirectory = ""
)

$ErrorActionPreference = "Stop"

# ── 0. 路径解析：全部基于 $PSScriptRoot，不依赖调用时的当前目录 ───────────────────

# $PSScriptRoot 在 pwsh 7 与 Windows PowerShell 5.1 下都可用；保留 MyInvocation 兜底。
$repoRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  $repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  throw "无法定位脚本所在目录（PSScriptRoot 为空）。请用 -File 方式执行本脚本。"
}

$appRoot = $DshInstallDirectory
if ([string]::IsNullOrWhiteSpace($appRoot)) { $appRoot = $env:DSH_INSTALL_DIR }
if ([string]::IsNullOrWhiteSpace($appRoot)) { $appRoot = "D:\deepseek-harness" }
# 统一成绝对路径，便于日志核对与 file: 规范化比较。
$appRoot = [System.IO.Path]::GetFullPath($appRoot)
# 自带 CLI：只认这个绝对路径，绝不回退到 PATH 上的全局 dsh
# （全局 dsh 拒绝对 desktop profile 执行 plugin，会报 profile 由 Electron 应用独占管理）。
$cli = Join-Path $appRoot "resources\runtime\cli\bin\dsh.cmd"

$dshHome = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshHome)) { $dshHome = Join-Path $env:USERPROFILE ".dsh" }
$dshHome = [System.IO.Path]::GetFullPath($dshHome)

# 本脚本只服务桌面版：profile 名硬编码，参数无法改变它。
$profileName = "desktop"
$profileDir = Join-Path $dshHome "profiles\$profileName"
$packRoot = Join-Path $dshHome "plugin-releases\dsh-expert-group"

$packageName = "dsh-expert-group"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$packDir = Join-Path $packRoot "pack-$stamp"
$backupDir = Join-Path $packRoot "cli-install-$stamp"
$logDir = Join-Path $packDir "logs"

# 发布面泄漏目录（开发面目录混进发布包即视为泄漏）。
$leakPattern = "\\(test|bench|\.scratch|docs)\\"
# desktop profile 的管理文件：逐个记录存在性与 SHA256，安装前后都要比对。
$mgmtFiles = @(
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  ".npmrc",
  "cordis.yml",
  "cordis.patch.yml",
  "compatibility.json"
)
# 其中这三项是用户配置与模型路由，安装前后必须逐字节不变。
$userConfigFiles = @("cordis.yml", "cordis.patch.yml", "pnpm-workspace.yaml")

# ── 1. 通用工具函数 ──────────────────────────────────────────────────────────────

$script:PhaseLogPath = $null
$script:GlobalLogPath = $null

# 追加一行到全局日志（pack 目录建好后就一直可用，供最早的路径诊断使用）。
function Add-GlobalLog {
  param([Parameter(Mandatory = $true)][string]$Line)
  if ([string]::IsNullOrWhiteSpace($script:GlobalLogPath)) { return }
  $stamped = "[" + (Get-Date -Format "HH:mm:ss") + "] " + $Line
  Add-Content -LiteralPath $script:GlobalLogPath -Value $stamped -Encoding UTF8
}

# 同时写当前阶段日志与全局日志。$script:PhaseLogPath 为 $null 时只写全局日志。
function Write-StageLog {
  param([Parameter(Mandatory = $true)][string]$Line)
  if (-not [string]::IsNullOrWhiteSpace($script:PhaseLogPath)) {
    Add-Content -LiteralPath $script:PhaseLogPath -Value $Line -Encoding UTF8
  }
  Add-GlobalLog -Line $Line
}

# 控制台输出 + 日志；-Detail 用于命令原始输出，不额外加阶段前缀。
function Write-Stage {
  param(
    [Parameter(Mandatory = $true)][string]$Message,
    [ConsoleColor]$Color = [ConsoleColor]::Gray,
    [switch]$Detail
  )
  Write-Host $Message -ForegroundColor $Color
  if ($Detail) { Write-StageLog -Line $Message } else { Write-StageLog -Line ("[stage] " + $Message) }
}

# 开启新阶段：写阶段日志文件头并输出横幅。
function Start-Stage {
  param([Parameter(Mandatory = $true)][string]$Name)
  $script:PhaseLogPath = Join-Path $logDir ($Name + ".log")
  $header = @(
    "================================================================",
    ("阶段: " + $Name),
    ("开始: " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss")),
    "================================================================"
  )
  foreach ($line in $header) { Add-Content -LiteralPath $script:PhaseLogPath -Value $line -Encoding UTF8 }
  Add-GlobalLog -Line ("==== 阶段开始: " + $Name + " ====")
  Write-Host ""
  Write-Host ("==== " + $Name + " ====") -ForegroundColor Cyan
}

# 中止：写日志、红字提示、抛错。不用 exit，避免在被调用场景下直接掐断宿主会话。
function Stop-Install {
  param([Parameter(Mandatory = $true)][string]$Reason)
  Write-StageLog -Line ("[FAIL] " + $Reason)
  Write-Host ("失败：" + $Reason) -ForegroundColor Red
  throw $Reason
}

# 把参数数组拼成可直接复制到终端复跑的命令行（含空格的参数加引号）。
function Format-CommandLine {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @()
  )
  $parts = @()
  if ($Executable -match "\s") { $parts += ('"' + $Executable + '"') } else { $parts += $Executable }
  foreach ($a in $Arguments) {
    if ($a -match "\s") { $parts += ('"' + $a + '"') } else { $parts += $a }
  }
  return ($parts -join " ")
}

# 执行外部命令：stdout/stderr 合并落盘并回显，返回退出码。
# 关键：调用期间把 $ErrorActionPreference 降为 Continue。pwsh 7.4+ 的
# PSNativeCommandUseErrorActionPreference 默认 true，在 Stop 语义下非零退出码会被包装成
# 终止性错误，导致拿不到 $LASTEXITCODE 也无法给出中文诊断；这里改为显式判码。
function Invoke-NativeCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [string[]]$Arguments = @(),
    [Parameter(Mandatory = $true)][string]$LogPath,
    [string]$WorkDir = $repoRoot
  )
  $commandLine = Format-CommandLine -Executable $Executable -Arguments $Arguments
  Write-Host ("> " + $commandLine) -ForegroundColor DarkGray
  Write-StageLog -Line ("> " + $commandLine)

  $previousPreference = $ErrorActionPreference
  $exitCode = -1
  $output = ""
  try {
    $ErrorActionPreference = "Continue"
    Push-Location -LiteralPath $WorkDir
    try {
      $output = (& $Executable @Arguments 2>&1 | Out-String)
      $exitCode = $LASTEXITCODE
    } finally {
      Pop-Location
    }
  } catch {
    $output = "命令执行抛出异常：" + $_.Exception.Message
    $exitCode = -1
  } finally {
    $ErrorActionPreference = $previousPreference
  }

  if (-not [string]::IsNullOrEmpty($output)) {
    $output = $output.TrimEnd([char]13, [char]10)
    Write-Host $output -ForegroundColor Gray
    Add-Content -LiteralPath $LogPath -Value $output -Encoding UTF8
  }
  Add-Content -LiteralPath $LogPath -Value ("[exit code] " + $exitCode) -Encoding UTF8
  return $exitCode
}

# 逐文件 SHA256 清单（相对路径 -> 哈希）。用于打包物、安装目标与备份的一致性比对。
function Get-FileHashMap {
  param([Parameter(Mandatory = $true)][string]$Root)
  $map = @{}
  $items = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Force)
  foreach ($item in $items) {
    $relative = $item.FullName.Substring($Root.Length).TrimStart([char]92, [char]47) -replace "\\", "/"
    $map[$relative] = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  return $map
}

# 写文本文件，保证 UTF-8 无 BOM（Node 需要按 ESM 解析这些辅助脚本）。
function Write-TextFileNoBom {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Content
  )
  $encoding = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

# 读取一个「已存在」路径的文件系统项；读不到就抛错（fail closed）。
# 为什么必须抛错：这两个函数的调用方（profile 路径隔离检查）要回答的是
# 「profile 有没有被重定向到别处」这种安全判断题。如果读不到属性就返回 $null /
# 返回 $false（旧实现），调用方会把它当成「不是链接 / 路径没变」继续往下走，
# 于是 CLI add 可能写进一个链接指向的目录，而后续校验全在错误路径上「自洽通过」。
# 因此这里只区分两种情况：路径不存在（ItemNotFound 类）与路径存在但读不出来（其它异常），
# 两者都抛错；只有真正读到了对象才把对象交给调用方判断。
function Get-ExistingFileSystemItem {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $item = $null
  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    # 刻意不再调用 Test-Path 去区分「路径不存在」与「路径存在但读不出来」：
    # Test-Path 本身就会在权限不足 / 损坏的 reparse point 上返回 false，用它做二次判断
    # 只会把「读不出来」误报成「不存在」，掩盖真实原因。两种情况的处置本来就完全一致——中止。
    # 因此这里统一报「无法读取」，把 Get-Item 的原始异常文本带上，供人工定位。
    $message = ""
    if ($null -ne $_.Exception) { $message = [string]$_.Exception.Message }
    Stop-Install -Reason ("无法读取文件系统项（" + $Purpose + "）：" + $Path + "（" + $message + "）。" + "`n" + "    路径隔离检查需要读取该路径的存在性、属性与链接信息，读不到就无法判定，已按 fail closed 中止。" + "`n" + "    请检查该路径是否存在、当前账户是否有读取权限、以及它若是链接时目标是否可读。")
  }
  if ($null -eq $item) {
    Stop-Install -Reason ("无法读取文件系统项属性（" + $Purpose + "）：" + $Path + "（Get-Item 未返回对象）。" + "`n" + "    无法判定它是否为链接，已按 fail closed 中止。")
  }
  return $item
}

# 判断一个已存在的文件系统项是否为 reparse point（符号链接 / junction / mount point）。
# PowerShell 5.1 与 pwsh 7 的 FileSystem provider 都会填充 Attributes 的 ReparsePoint 位，
# 因此只用这一位做判据；LinkType / Target 仅用于诊断信息。
# 语义约定（fail closed）：只有「明确读到属性且该位为 0」才返回 $false；
# 路径不存在或属性读不出来时抛错，绝不返回 $false 让调用方误以为「不是链接」。
# 说明：Assert-ProfilePathIsolation 现在直接读属性位（要在同一次读取里同时拿到
# Attributes 与 LinkType/Target 诊断信息），不再经过本函数；这里保留它作为同类判定的
# 单一入口，供后续需要「只问是不是链接」的调用点复用，避免各处重复实现这套 fail closed 语义。
function Test-IsReparsePoint {
  param([Parameter(Mandatory = $true)][string]$Path)
  # 不做 Test-Path 早退：严格读取器读不到对象（不存在 / 无权读取 / 损坏链接）时抛错中止，
  # 这里拿到的 item 一定是「明确读到的对象」，属性判定才有意义。
  $item = Get-ExistingFileSystemItem -Path $Path -Purpose "reparse point 判定"
  $attributes = $item.Attributes
  if ($null -eq $attributes) {
    Stop-Install -Reason ("无法读取路径属性：" + $Path + "（Attributes 为空）。" + "`n" + "    无法判定它是否为链接，已按 fail closed 中止。")
  }
  return (([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

# 把路径规范成「用于同源比较的规范形式」：分隔符统一成 '\'、去掉尾部斜杠（根除外）、大小写折叠。
# 为什么需要它：desktop 与 web 的同源比较只关心「是不是同一个物理目录」，因此 Windows 的大小写差异、
# 正/反斜杠混用、结尾多一个 '\' 都不能造成「看起来不同」的误判（那会放行一次真实的同源覆盖）。
# 判不出结论（空路径、取不到路径根）时抛错中止，绝不返回半成品去比较。
function ConvertTo-ComparablePath {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    Stop-Install -Reason ("无法比较真实路径：路径为空。" + "`n" + "    路径隔离检查需要两个非空路径才能判定是否同源，已按 fail closed 中止。")
  }
  $normalized = $Path.Replace([char]47, [char]92)
  $root = ""
  try {
    $root = [System.IO.Path]::GetPathRoot($normalized)
  } catch {
    Stop-Install -Reason ("无法规范化路径：" + $Path + "（" + [string]$_.Exception.Message + "）。" + "`n" + "    规范化失败时无法可靠比较两个目录是否同源，已按 fail closed 中止。")
  }
  if ([string]::IsNullOrEmpty($root)) {
    Stop-Install -Reason ("无法规范化路径：" + $Path + "（取不到路径根，可能是相对路径或非法路径）。" + "`n" + "    规范化失败时无法可靠比较两个目录是否同源，已按 fail closed 中止。")
  }
  if ($normalized.Length -gt $root.Length) { $normalized = $normalized.TrimEnd([char]92) }
  if ([string]::IsNullOrEmpty($normalized)) {
    Stop-Install -Reason ("无法规范化路径：" + $Path + "（去掉尾部斜杠后为空）。" + "`n" + "    规范化失败时无法可靠比较两个目录是否同源，已按 fail closed 中止。")
  }
  return $normalized.ToLowerInvariant()
}

# 判断两个路径是否指向同一个真实目录：两侧都规范成可比形式后整体比较（大小写不敏感）。
# 比较用 -ceq：两侧已经折叠过大小写，用大小写敏感的比较让「这里本来就是大小写不敏感」这件事显式可见。
function Test-SameRealDirectory {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )
  return ((ConvertTo-ComparablePath -Path $Left) -ceq (ConvertTo-ComparablePath -Path $Right))
}

# 从盘符根（或 UNC 根）开始逐级向下，返回路径上第一个 reparse point 组件（含最终项本身）；
# 整条路径都不是链接时返回 $null。
# 为什么必须逐级检查而不是只看最终项：只看最终项会漏掉「祖先目录是链接」这种重定向——
# 例如 DSH_HOME 是 junction（合同明确允许），而 profiles\web 又是指向 profiles\desktop 的链接时，
# desktop 的 lexical 路径与 web 解析出来的真实路径文本不同，同源比较会把物理上同一个目录判成
# 不同源而放行（fail open）。逐级解析后两者才会收敛到同一个真实目录。
# 语义（fail closed）：任何一级读不到对象 / 属性读不出来都抛错中止，绝不返回 $null 假装「不是链接」。
function Get-FirstReparsePointComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $full = ""
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
  } catch {
    Stop-Install -Reason ("解析真实路径失败：无法规范化 " + $Path + "（" + [string]$_.Exception.Message + "）。" + "`n" + "    规范化失败时无法逐级检查链接，已按 fail closed 中止。")
  }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root)) {
    Stop-Install -Reason ("解析真实路径失败：" + $Path + " 取不到路径根（可能是相对路径或非法路径），无法逐级检查链接，已按 fail closed 中止。")
  }
  # 候选 = 盘符根/UNC 根自身 + 它下面每一个目录组件，顺序由浅到深。
  # 根也要查：挂载点卷（volume mount point）就是根一级的 reparse point。
  $candidates = New-Object 'System.Collections.Generic.List[string]'
  $candidates.Add($root)
  $prefix = $root
  $rest = $full.Substring($root.Length)
  foreach ($segment in @($rest.Split([char[]]@(92, 47), [System.StringSplitOptions]::RemoveEmptyEntries))) {
    $prefix = [System.IO.Path]::Combine($prefix, $segment)
    $candidates.Add($prefix)
  }
  foreach ($candidate in $candidates) {
    $item = Get-ExistingFileSystemItem -Path $candidate -Purpose $Purpose
    $attributes = $item.Attributes
    if ($null -eq $attributes) {
      Stop-Install -Reason ("解析真实路径失败：" + $candidate + " 的 Attributes 读不出来，无法判定是否为链接，已按 fail closed 中止。")
    }
    if ((([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      return $candidate
    }
  }
  return $null
}

# 解析目录的真实物理路径：逐级解析「盘符根 -> 目标目录」路径上的每一个 reparse point
# （符号链接 / junction / 挂载点），返回用于同源比较的规范形式（分隔符统一、无尾部斜杠、大小写折叠）。
# 只用于比较「两个路径是否落在同一个真实目录」，不做任何写入。
# 注意：Resolve-Path 在两个 PowerShell 版本下都不会解析 junction / symlink，不能拿它当判据；
# 这里只用 FileSystem provider 的属性位与 Target（PS 5.1 与 pwsh 7 都支持），不引入外部工具。
# fail closed 语义：下列任一情况都抛错中止，绝不返回「未解析完的路径」去和 web profile 比较——
# 拿一个没解析完的路径去比较，可能把两个其实指向同一处的目录判成不同源而放行（fail open）：
#   1) 路径不存在，或任一级组件的属性读不出来；
#   2) 是 reparse point 但链接目标为空 / 不可读（拿不到 Target）；
#   3) 链接目标（含相对目标的基准目录）无法规范化；
#   4) 沿链接追下去出现环（同一个规范化目标被再次访问）；
#   5) 沿链接追踪超过上限（恰好 16 跳仍合法，第 17 个链接一律拒绝）。
function Resolve-RealDirectoryPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $maxHops = 16
  $visited = New-Object 'System.Collections.Generic.List[string]'
  $current = ""
  try {
    $current = [System.IO.Path]::GetFullPath($Path)
  } catch {
    Stop-Install -Reason ("解析真实路径失败：无法规范化 " + $Path + "（" + [string]$_.Exception.Message + "）。" + "`n" + "    规范化失败时无法解析真实路径，已按 fail closed 中止。")
  }

  # 跳数语义（必须精确，否则会多拒一条合法链）：
  #   $hopCount = 已成功解析掉的链接数；maxHops = 允许解析的链接数上限（16）。
  # 每次循环「先找下一个链接」：
  #   - 找不到链接：说明整条路径已无 reparse point，直接返回（这才是「解析完成」的唯一判据）；
  #   - 找到链接且 $hopCount -ge $maxHops：说明要解析的是第 17 个链接 → 中止；
  #   - 否则解析该链接，$hopCount++ 后回到循环顶部重新检查「是否已无链接」。
  # 因此恰好 16 跳的链会在第 16 次解析后回到顶部、发现没有链接而正常返回；17 跳必被拒。
  # 旧写法 for ($hop = 0; $hop -lt 16; ...) 在顶部就先判跳数上限，等于只允许 15 跳，
  # 恰好 16 跳的合法链会被误判成「超过 16 跳」而中止（off-by-one，fail closed 方向的误伤）。
  $hopCount = 0
  while ($true) {
    # 逐级（盘符根 -> 目标目录）找第一个链接组件；整条路径都不是链接时返回 $null，
    # 此时 $current 已经是没有任何链接的物理路径，可以直接规范化返回。
    # 刻意不做 Test-Path 早退：路径不存在、无权读取、链接目标损坏一律由严格读取器抛出并中止，
    # 避免「读不到就当解析完成」把未解析路径拿去做同源比较（那是 fail open）。
    $linkPath = Get-FirstReparsePointComponent -Path $current -Purpose "真实路径解析"
    if ($null -eq $linkPath) {
      return (ConvertTo-ComparablePath -Path $current)
    }
    if ($hopCount -ge $maxHops) {
      Stop-Install -Reason ("解析真实路径失败：沿链接追踪超过 " + $maxHops + " 跳仍未到达真实目录（起点：" + $Path + "）。" + "`n" + "    可能是超长链接链或环，已按 fail closed 中止。")
    }

    # 读取链接目标：读不到 / 为空一律中止（绝不猜测、也绝不退回 lexical 路径）。
    $item = Get-ExistingFileSystemItem -Path $linkPath -Purpose "真实路径解析"
    $targets = @($item.Target)
    if ($targets.Count -eq 0) {
      Stop-Install -Reason ("解析真实路径失败：" + $linkPath + " 是链接但读不到链接目标（Target 为空）。" + "`n" + "    无法确认它最终指向哪个目录，已按 fail closed 中止；请检查该链接是否损坏。")
    }
    $target = [string]$targets[0]
    if ([string]::IsNullOrWhiteSpace($target)) {
      Stop-Install -Reason ("解析真实路径失败：" + $linkPath + " 是链接但链接目标为空字符串，无法解析，已按 fail closed 中止。")
    }

    # 相对 target 以「链接所在目录」为基准解析（junction / symlink 都可能给出相对目标）。
    if (-not [System.IO.Path]::IsPathRooted($target)) {
      $linkParent = Split-Path -Parent $linkPath
      if ([string]::IsNullOrWhiteSpace($linkParent)) {
        Stop-Install -Reason ("解析真实路径失败：" + $linkPath + " 的相对链接目标（" + $target + "）无法定位基准目录，已按 fail closed 中止。")
      }
      $target = [System.IO.Path]::Combine($linkParent, $target)
    }

    $next = ""
    try {
      $next = [System.IO.Path]::GetFullPath($target)
    } catch {
      Stop-Install -Reason ("解析真实路径失败：链接目标无法规范化（" + $linkPath + " -> " + $target + "：" + [string]$_.Exception.Message + "）。" + "`n" + "    规范化失败时无法可靠比较真实目录，已按 fail closed 中止。")
    }

    # 把「链接点之后的剩余组件」接回目标之后：C:\a\link\b 中 link -> D:\x 时真实路径是 D:\x\b。
    if ($current.Length -gt $linkPath.Length) {
      $tail = $current.Substring($linkPath.Length)
      try {
        $next = [System.IO.Path]::GetFullPath($next + $tail)
      } catch {
        Stop-Install -Reason ("解析真实路径失败：链接目标与剩余路径拼接后无法规范化（" + $linkPath + " -> " + $target + "，剩余 " + $tail + "：" + [string]$_.Exception.Message + "）。" + "`n" + "    规范化失败时无法可靠比较真实目录，已按 fail closed 中止。")
      }
    }

    # 环检测：同一个规范化目标被第二次访问即判定为环。用规范形式比较，避免大小写/分隔符差异绕过。
    $nextKey = ConvertTo-ComparablePath -Path $next
    if ($visited.Contains($nextKey)) {
      Stop-Install -Reason ("解析真实路径失败：链接出现环，" + $next + " 被重复访问（当前跳数 " + $hopCount + "）。" + "`n" + "    环状链接无法解析出真实目录，已按 fail closed 中止。")
    }
    $visited.Add($nextKey)
    $current = $next
    # 记一次「成功解析掉的链接」。必须放在这里：上限判定用的是「已解析数」，
    # 若漏掉这一步，$hopCount 永远是 0，第 17 个链接就不会被拒绝（超长链会一路解析到底）。
    $hopCount++
  }
  # 正常路径永远走不到这里：$hopCount -ge $maxHops 的判定在循环体内，
  # 循环只能通过 return 或 Stop-Install 退出。保留这一行作为兜底，避免将来改动后静默返回 $null。
  Stop-Install -Reason ("解析真实路径失败：沿链接追踪超过 " + $maxHops + " 跳仍未到达真实目录（起点：" + $Path + "）。" + "`n" + "    可能是超长链接链或环，已按 fail closed 中止。")
}

# 断言「已明确读到的文件系统项」确实是目录（而不是文件 / 设备 / 其它类型）。
# 为什么单独抽出来：profiles 与 profiles\desktop 是本次安装必需的既有目录，
# 「是目录」是后续所有链接判定与 CLI 写入的前提；属性读不出来时同样中止（fail closed）。
function Assert-DirectoryItem {
  param(
    [Parameter(Mandatory = $true)]$Item,
    [Parameter(Mandatory = $true)][string]$Purpose,
    [Parameter(Mandatory = $true)][string]$Path
  )
  # 判据用 PSIsContainer（FileSystem provider 在所有 PowerShell 版本上都填这一位）；
  # 不用 .IsDirectory——在 pwsh 7 的 DirectoryInfo 上它可能取不到值（空），
  # 那会把正常目录误判成「不是目录」，属于 fail closed 方向上的误伤，必须避免。
  if (-not $Item.PSIsContainer) {
    Stop-Install -Reason ("路径不是目录（" + $Purpose + "）：" + $Path + "。" + "`n" + "    本次安装需要该路径是真实目录，实际不是，已按 fail closed 中止。")
  }
}

# desktop profile 的路径隔离检查（01-preflight 预检、07-install 的 CLI add 紧前、08-verify 安装后，共三次）。
# 目的：确认 profile 目录没有被重定向到别处——否则 CLI add 会写进一个完全不同的目录，
# 而后续所有校验都会在错误的路径上「自洽地」通过。
# 明确允许 DSH_HOME 本身由用户配置成链接（用户有权把 home 放到别的盘）：home 一级的 reparse point
# 只解析、不拒绝；真正拒绝的是 profiles 与 profiles\desktop 这两级（必需的既有目录）自身是 reparse point，
# 以及可选的 profiles\web 解析后与 desktop 同源的情况。
# 全程 fail closed：判不出结论（对象读不到、属性读不出、不是目录、链接目标不可读、出现环、
# 超过跳数上限、web 项重复）一律中止，绝不放行；desktop 与 web 的 realpath 相同也直接中止。
function Assert-ProfilePathIsolation {
  param([Parameter(Mandatory = $true)][string]$Stage)

  $profilesDir = Join-Path $dshHome "profiles"
  $webProfileDir = Join-Path $profilesDir "web"

  # ── 第一级与第二级：profiles 与 profiles\desktop 是本次安装必需的既有目录 ────────────
  # 这两项必须全部满足，缺一不可：
  #   1) 严格读取成功（不存在 / 无权读取 / 损坏的 reparse point 都读不到对象 → 中止）；
  #   2) Attributes 可读（判不出是否链接 → 中止）；
  #   3) 确实是目录（是文件 / 其它类型 → 中止）；
  #   4) 不是 reparse point（是符号链接 / junction / mount point → 中止）。
  # 刻意不再用「Test-Path 为 false 就 continue」跳过：Test-Path 返回 false 时无法区分
  # 「确实不存在」「无权读取」「链接目标损坏」三种情况，跳过检查就是 fail open——
  # 只要能把这两级读失败，后面的 CLI add 就会写进一个从未被检查过的目录。
  foreach ($candidate in @($profilesDir, $profileDir)) {
    # 顺序固定为 profiles -> desktop；两者都必须走完整套检查，任何一项不满足都立即中止。
    $purpose = "profiles 目录检查"
    if ($candidate -eq $profileDir) { $purpose = "desktop profile 目录检查" }

    $item = Get-ExistingFileSystemItem -Path $candidate -Purpose $purpose
    $attributes = $item.Attributes
    if ($null -eq $attributes) {
      Stop-Install -Reason ("无法读取路径属性（" + $purpose + "）：" + $candidate + "（Attributes 为空）。" + "`n" + "    无法判定它是否为链接，已按 fail closed 中止。")
    }
    Assert-DirectoryItem -Item $item -Purpose $purpose -Path $candidate

    if ((([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      $linkKind = "reparse point"
      if (-not [string]::IsNullOrWhiteSpace([string]$item.LinkType)) { $linkKind = [string]$item.LinkType }
      $linkTarget = (@($item.Target) -join ", ")
      Stop-Install -Reason ("profile 路径被重定向：" + $candidate + " 是 " + $linkKind + "（目标：" + $linkTarget + "）。" + "`n" + "    本次安装拒绝在链接指向的目录上执行 CLI add：请把 desktop profile 还原成 " + $dshHome + " 下的真实目录后再重试。")
    }
  }

  # ── 第三级：profiles\web 是可选的，存在才做同源比较 ─────────────────────────────────
  # 同样不能用 Test-Path 判断它「是否存在」：Test-Path 为 false 也可能是无权读取或链接损坏，
  # 那会把「有 web profile 但读不到」当成「没有 web profile」而跳过同源比较（fail open）。
  # 改为枚举「已验证可读」的 profiles 目录（-Force 含隐藏项，-ErrorAction Stop 让枚举失败抛出），
  # 精确匹配名称为 web 的文件系统项；枚举失败 / 项数不为 1 / 出现重复项都中止。
  $webChildren = @()
  $webEnumeration = "directories"
  try {
    $webChildren = @(Get-ChildItem -LiteralPath $profilesDir -Force -Directory -ErrorAction Stop | Where-Object { $_.Name -eq "web" })
  } catch {
    Stop-Install -Reason ("无法枚举 profiles 目录以确认 web profile 是否存在：" + $profilesDir + "（" + [string]$_.Exception.Message + "）。" + "`n" + "    枚举失败时无法判断 web profile 是否存在，也就无法排除 desktop 与 web 同源，已按 fail closed 中止。")
  }
  if ($webChildren.Count -eq 0) {
    # 目录枚举里没有 web，再确认它不是「同名的非目录项」（普通文件 / 其它类型）：
    # 那种情况既不是「不存在」，也不能当目录交给 Resolve-RealDirectoryPath，一律中止。
    $webEnumeration = "files"
    try {
      $webChildren = @(Get-ChildItem -LiteralPath $profilesDir -Force -File -ErrorAction Stop | Where-Object { $_.Name -eq "web" })
    } catch {
      Stop-Install -Reason ("无法枚举 profiles 目录以确认 web profile 是否存在：" + $profilesDir + "（" + [string]$_.Exception.Message + "）。" + "`n" + "    枚举失败时无法判断 web profile 是否存在，已按 fail closed 中止。")
    }
  }
  if ($webChildren.Count -gt 1) {
    Stop-Install -Reason ("profiles 目录里名为 web 的文件系统项出现 " + $webChildren.Count + " 次（" + $webEnumeration + " 枚举）：" + $profilesDir + "。" + "`n" + "    重复项无法判定哪一个才是 web profile，也就无法可靠地做同源比较，已按 fail closed 中止。")
  }

  if ($webChildren.Count -eq 1) {
    $webItem = $webChildren[0]
    if (-not $webItem.PSIsContainer) {
      Stop-Install -Reason ("web profile 路径不是目录：" + $webProfileDir + "（实际类型：" + [string]$webItem.GetType().Name + "）。" + "`n" + "    既不能按目录解析它的真实路径，也不能排除 desktop 与 web 同源，已按 fail closed 中止。")
    }
    # 两个 realpath 都必须解析成功；任一解析不出来（坏链接 / 环 / 超过跳数 / 目标缺失）都会在
    # Resolve-RealDirectoryPath 内部中止，不会退化成「用未解析路径比较」这种 fail open 行为。
    # 解析覆盖整条路径的每一个祖先组件（含 DSH_HOME 本身是链接的情况），因此这里拿到的是物理路径；
    # 比较再统一走 Test-SameRealDirectory（大小写不敏感、分隔符统一、忽略尾部斜杠）。
    $desktopReal = Resolve-RealDirectoryPath -Path $profileDir
    $webReal = Resolve-RealDirectoryPath -Path $webProfileDir
    if (Test-SameRealDirectory -Left $desktopReal -Right $webReal) {
      Stop-Install -Reason ("profile 路径被重定向：desktop（" + $profileDir + "）与 web（" + $webProfileDir + "）解析到同一个真实目录 " + $desktopReal + "。" + "`n" + "    这会让 desktop 安装实际改写 web profile，本次安装已中止；请先修好 profile 目录布局。")
    }
  }

  Write-Stage -Message ("  [" + $Stage + "] profile 路径隔离通过：profiles 与 profiles\desktop 均存在、可读且为非链接目录，desktop 与 web 不同源")
}

# ── 2. 打包目录（最早创建，后续所有日志与产物都落在它下面） ──────────────────────

if (-not (Test-Path -LiteralPath $packRoot)) {
  New-Item -ItemType Directory -Path $packRoot -Force | Out-Null
}
if (Test-Path -LiteralPath $packDir) {
  throw "打包目录已存在，拒绝覆盖：$packDir（请重新执行以获取新的时间戳）"
}
New-Item -ItemType Directory -Path $packDir | Out-Null
New-Item -ItemType Directory -Path $logDir | Out-Null
$script:GlobalLogPath = Join-Path $logDir "desktop-install.log"

Add-GlobalLog -Line "desktop-web-install.ps1 启动"
Add-GlobalLog -Line ("repoRoot   = " + $repoRoot)
Add-GlobalLog -Line ("appRoot    = " + $appRoot)
Add-GlobalLog -Line ("cli        = " + $cli)
Add-GlobalLog -Line ("dshHome    = " + $dshHome)
Add-GlobalLog -Line ("profileDir = " + $profileDir)
Add-GlobalLog -Line ("packDir    = " + $packDir)
Add-GlobalLog -Line ("backupDir  = " + $backupDir)

Write-Host "dsh-expert-group 桌面版安装编排器" -ForegroundColor Cyan
Write-Host ("  仓库根   : " + $repoRoot)
Write-Host ("  应用根   : " + $appRoot)
Write-Host ("  自带 CLI : " + $cli)
Write-Host ("  目标 profile : " + $profileDir)
Write-Host ("  打包目录 : " + $packDir)
Write-Host ("  备份目录 : " + $backupDir)

# ── 3. 预检 ──────────────────────────────────────────────────────────────────────

Start-Stage -Name "01-preflight"

Write-Stage -Message ("检查仓库根：" + $repoRoot)
if (-not (Test-Path -LiteralPath $repoRoot)) { Stop-Install -Reason ("仓库根目录不存在：" + $repoRoot) }
$repoManifestPath = Join-Path $repoRoot "package.json"
if (-not (Test-Path -LiteralPath $repoManifestPath)) {
  Stop-Install -Reason ("仓库根缺少 package.json，可能不是仓库根：" + $repoRoot)
}
$repoManifest = $null
try {
  # 显式 -Encoding UTF8：WinPS 5.1 的 Get-Content 默认按 ANSI 读取，中文 description 会变乱码。
  $repoManifest = Get-Content -LiteralPath $repoManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
} catch {
  Stop-Install -Reason ("无法解析仓库 package.json：" + $_.Exception.Message)
}
if ([string]$repoManifest.name -ne $packageName) {
  Stop-Install -Reason ("仓库 package.json 的 name 是 '" + [string]$repoManifest.name + "'，期望 '" + $packageName + "'")
}
$packageVersion = [string]$repoManifest.version
Write-Stage -Message ("  包名/版本：" + $packageName + " " + $packageVersion)

# 外部命令预检：node / pnpm / git / tar 都必须在 PATH 上解析到真实可执行文件。
$requiredCommands = @("node", "pnpm", "git", "tar")
foreach ($name in $requiredCommands) {
  $command = Get-Command $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($null -eq $command) {
    Stop-Install -Reason ("预检失败：PATH 上找不到 " + $name + "。请先安装并确保它在 PATH 中。")
  }
  Write-Stage -Message ("  " + $name + " -> " + $command.Source)
}

# Node 版本必须满足 package.json 的 engines 约束（本仓库为 ^22.19.0 || >=24.0.0）。
$nodeVersionRaw = (& node --version 2>&1 | Out-String).Trim()
$nodeMatch = [regex]::Match($nodeVersionRaw, "^v(\d+)\.(\d+)\.(\d+)")
if (-not $nodeMatch.Success) {
  Stop-Install -Reason ("无法识别 node 版本输出：" + $nodeVersionRaw)
}
$nodeMajor = [int]$nodeMatch.Groups[1].Value
$nodeMinor = [int]$nodeMatch.Groups[2].Value
$nodeOk = ($nodeMajor -gt 24) -or (($nodeMajor -eq 24) -and ($nodeMinor -ge 0)) -or (($nodeMajor -eq 22) -and ($nodeMinor -ge 19))
if (-not $nodeOk) {
  Stop-Install -Reason ("Node 版本不满足 engines 约束（需要 ^22.19.0 或 >=24.0.0），当前：" + $nodeVersionRaw)
}
Write-Stage -Message ("  node 版本：" + $nodeVersionRaw)

# 自带 CLI：必须是该绝对路径上的文件，绝不回退 PATH 上的全局 dsh。
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  Stop-Install -Reason ("未找到应用自带 CLI：" + $cli + "。请用 -DshInstallDirectory 指定正确的应用根目录（不要改用 PATH 上的全局 dsh）。")
}
Write-Stage -Message ("  自带 CLI 存在：" + $cli)

# profile 路径隔离：必须在任何 CLI 写操作（add）之前确认 profile 没有被重定向。
# 这一关是 fail closed 的：profiles / profiles\desktop 读不到、不是目录或本身是链接都直接中止，
# 不存在「读不到就跳过」的分支；下面的 profile 初始化检查只在通过这一关之后才有意义。
Assert-ProfilePathIsolation -Stage "01-preflight"

# desktop profile 必须已经初始化（存在 package.json）；本脚本不会创建 profile。
if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
  Stop-Install -Reason ("desktop profile 目录不存在：" + $profileDir + "。请先启动一次桌面版完成初始化。")
}
$profileManifestPath = Join-Path $profileDir "package.json"
if (-not (Test-Path -LiteralPath $profileManifestPath -PathType Leaf)) {
  Stop-Install -Reason ("desktop profile 未初始化（缺少 " + $profileManifestPath + "）。请先启动一次桌面版。")
}
Write-Stage -Message "  desktop profile 已初始化"

# 只读探测当前 profile 是否已登记本插件（仅用于日志，不做任何写入）。
try {
  $profileManifestBefore = Get-Content -LiteralPath $profileManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  $depProperty = $null
  if ($null -ne $profileManifestBefore.dependencies) {
    $depProperty = $profileManifestBefore.dependencies.PSObject.Properties[$packageName]
  }
  if ($null -ne $depProperty) {
    Write-Stage -Message ("  当前 profile 已登记 " + $packageName + " = " + [string]$depProperty.Value)
  } else {
    Write-Stage -Message ("  当前 profile 尚未登记 " + $packageName + "（本次为首次安装）")
  }
} catch {
  Stop-Install -Reason ("无法解析 desktop profile manifest：" + $_.Exception.Message)
}

Write-Stage -Message "预检通过" -Color Green

# ── 4. 构建 ──────────────────────────────────────────────────────────────────────

Start-Stage -Name "02-build"
$buildExit = Invoke-NativeCommand -Executable "pnpm" -Arguments @("run", "build") -LogPath (Join-Path $logDir "build.log")
if ($buildExit -ne 0) {
  Stop-Install -Reason ("构建失败（pnpm run build 退出码 " + $buildExit + "），已中止；不要用旧产物继续打包。")
}
$buildLog = Get-Content -LiteralPath (Join-Path $logDir "build.log") -Raw -Encoding UTF8
if ($buildLog -notmatch "DEG build verification passed") {
  Stop-Install -Reason "构建日志中未出现 'DEG build verification passed' 判据，构建结果不可信，已中止。"
}
Write-Stage -Message "构建通过" -Color Green

# ── 5. 测试 ──────────────────────────────────────────────────────────────────────

Start-Stage -Name "03-test"
# 直接用 node --test 而不是 pnpm run test：需要显式指定 TAP reporter（脚本要按标题 + 文件 + 行号
# 精确识别失败），pnpm run test 转发 --test-reporter 的兼容性不如直接调用稳定。
# 测试文件集合与 package.json 的 test 脚本一致：test/*.test.mjs。
$testLogPath = Join-Path $logDir "test.log"
$testExit = Invoke-NativeCommand -Executable "node" -Arguments @("--test", "--test-reporter=tap", "test/*.test.mjs") -LogPath $testLogPath
$tapText = Get-Content -LiteralPath $testLogPath -Raw -Encoding UTF8
if ([string]::IsNullOrEmpty($tapText)) {
  Stop-Install -Reason "测试日志为空，无法判定测试结果，已中止。"
}
# ── TAP 失败块的结构化解析 ─────────────────────────────────────────────────────
# 不再对整份文本做 \n 字面量替换（那会破坏错误文本本身的精确匹配），改为按 TAP 诊断块的
# 真实结构（缩进 + 块标量）逐字段提取。任何无法解析的字段都保持为空字符串，
# 由白名单匹配负责拒绝——解析阶段绝不放宽判据。

# 去掉 YAML 风格的包裹引号（单引号内的 '' 表示一个字面单引号）。
function ConvertFrom-TapScalar {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Raw)
  $value = $Raw.Trim()
  if ($value.Length -ge 2) {
    $first = $value.Substring(0, 1)
    $last = $value.Substring($value.Length - 1, 1)
    if (($first -eq "'" -and $last -eq "'") -or ($first -eq '"' -and $last -eq '"')) {
      $value = $value.Substring(1, $value.Length - 2)
      if ($first -eq "'") { $value = $value.Replace("''", "'") }
    }
  }
  return $value
}

# 解析所有失败块。块形态：
#   not ok 12 - 标题
#     ---
#     failureType: 'testCodeFailure'
#     error: |-                      <- 块标量，内容再缩进 2 空格
#       ...
#     code: 'ERR_ASSERTION'
#     name: 'AssertionError'
#     expected: 'x'
#     actual: 'y'
#     operator: 'strictEqual'
#     stack: |-
#       TestContext.<anonymous> (file:///.../test/foo.test.mjs:92:10)
#     ...
function Get-TapFailureRecords {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][AllowEmptyCollection()][string[]]$Lines)
  $records = @()
  $index = 0
  $total = $Lines.Count
  while ($index -lt $total) {
    $notOkMatch = [regex]::Match($Lines[$index], '^\s*not ok\s+(\d+)\s+-\s+(.*)$')
    if (-not $notOkMatch.Success) { $index++; continue }

    $record = @{
      Number = [int]$notOkMatch.Groups[1].Value
      Title = $notOkMatch.Groups[2].Value.Trim()
      Location = ""
      FailureType = ""
      Error = ""
      Code = ""
      Name = ""
      Expected = ""
      Actual = ""
      Operator = ""
      Stack = ""
    }
    $index++

    # 收集块体：直到 '...' 结束行、下一个 not ok / ok 行或文本结束。
    $blockLines = @()
    while ($index -lt $total) {
      $candidate = $Lines[$index]
      $candidateTrimmed = $candidate.Trim()
      if ($candidateTrimmed -eq "...") { $index++; break }
      if ($candidateTrimmed -match '^not ok\s+\d+\s+-') { break }
      if ($candidateTrimmed -match '^ok\s+\d+\s+-') { break }
      $blockLines += $candidate
      $index++
    }

    # 块内按缩进解析 `key: value` 与 `key: |-` 块标量。
    $position = 0
    while ($position -lt $blockLines.Count) {
      $blockLine = $blockLines[$position]
      $keyMatch = [regex]::Match($blockLine, '^(\s*)([A-Za-z_][A-Za-z0-9_]*):\s?(.*)$')
      if (-not $keyMatch.Success) { $position++; continue }
      $keyIndent = $keyMatch.Groups[1].Value.Length
      $key = $keyMatch.Groups[2].Value
      $inlineValue = $keyMatch.Groups[3].Value
      $inlineTrimmed = $inlineValue.Trim()

      if ($inlineTrimmed -eq "|-" -or $inlineTrimmed -eq "|" -or $inlineTrimmed -eq ">-") {
        # 块标量：后续缩进更深（或空行）的行都属于它。
        $scalarLines = @()
        $position++
        while ($position -lt $blockLines.Count) {
          $scalarLine = $blockLines[$position]
          if ($scalarLine.Trim() -eq "") { $scalarLines += ""; $position++; continue }
          $scalarIndent = ([regex]::Match($scalarLine, '^\s*')).Value.Length
          if ($scalarIndent -le $keyIndent) { break }
          $stripCount = [Math]::Min($keyIndent + 2, $scalarLine.Length)
          $scalarLines += $scalarLine.Substring($stripCount)
          $position++
        }
        $inlineValue = ($scalarLines -join "`n")
      } else {
        $position++
      }

      $value = ConvertFrom-TapScalar -Raw $inlineValue
      switch ($key) {
        "location" { $record.Location = $value }
        "failureType" { $record.FailureType = $value }
        "error" { $record.Error = $value }
        "code" { $record.Code = $value }
        "name" { $record.Name = $value }
        "expected" { $record.Expected = $value }
        "actual" { $record.Actual = $value }
        "operator" { $record.Operator = $value }
        "stack" { $record.Stack = $value }
        default { }
      }
    }
    $records += $record
  }
  return $records
}

# 把 stack 的首帧解析成结构化的断言行定位 (File, Line, Column)。
# 为什么不能用 IndexOf / 子串：真实首帧形如
#   TestContext.<anonymous> (file:///F:/.../test/package-portability.test.mjs:92:10)
# 子串命中会把 ':92:100'、':92:10x'、':92:10（后接别的文本）乃至「同一行里恰好出现
# ':92:10' 的别的定位」全部当成命中，等于把定位证据放宽成「文本里出现过这串数字」。
# 这里改成：从首帧末尾的括号组里取出唯一 location，拆成 路径段 + 行号 + 列号 三元组；
# 路径只做形式归一化（file: URL 前缀、反斜杠、查询串/锚点），不做任何模糊匹配；
# 行列必须是完整数字 token，整体相等才算命中。
# file URL 的三种形态分别按下面的意图归一化（详见函数内的实现注释）：
#   file:///C:/x、file://C:/x  -> C:/x（盘符路径，前导斜杠由 ConvertTo-TapFrameAbsolutePath 归一）
#   file://server/share/x      -> //server/share/x（UNC：authority 必须保留，server 是主机名而不是相对路径）
#   file://localhost/C:/x      -> C:/x（localhost 等价本机，按本机 file URL 处理）
# 非 file scheme（http:/https:/data: 等）仍在上面被直接拒绝，不放宽到未知 scheme。
# 返回 @{ Ok = $true/$false; Reason = "..." ; File = ""; Line = -1; Column = -1 }。
# 任何解析不出唯一 location 的情况都返回 Ok = $false（调用方据此判失败，绝不放行）。
function Get-TapStackFrameLocation {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Frame)

  $result = @{ Ok = $false; Reason = ""; Candidates = @(); DecodeError = ""; Line = -1; Column = -1 }
  $frameText = [string]$Frame
  if ([string]::IsNullOrWhiteSpace($frameText)) {
    $result.Reason = "stack 首帧为空"
    return $result
  }

  # 只认「末尾括号组」这一个位置来源；括号里必须恰好是一个 location，不能夹带别的文本。
  $frameMatch = [regex]::Match($frameText, '^(?<locator>.*?)\((?<inner>[^()]*)\)\s*$')
  if (-not $frameMatch.Success) {
    $result.Reason = "首帧不含末尾括号定位（形如 '(...:行:列)'）"
    return $result
  }
  $inner = $frameMatch.Groups["inner"].Value.Trim()
  if ([string]::IsNullOrWhiteSpace($inner)) {
    $result.Reason = "首帧括号内为空"
    return $result
  }
  if ($inner -match "\s") {
    $result.Reason = ("首帧括号内不是单一 location（含空白）：'" + $inner + "'")
    return $result
  }
  if ($inner.Contains(":")) {
    $schemeMatch = [regex]::Match($inner, '^(?<scheme>[A-Za-z][A-Za-z0-9+.-]*)://')
    if ($schemeMatch.Success -and $schemeMatch.Groups["scheme"].Value.ToLowerInvariant() -ne "file") {
      $result.Reason = ("首帧 location 不是 file: URL（scheme='" + $schemeMatch.Groups["scheme"].Value + "'）")
      return $result
    }
  }

  # 结尾必须是「:行:列」，且行、列都必须是完整的十进制数字 token；
  # ':92:100' / ':92:10x' / ':92:10:5' 都会在这里被判为不合法（不是整体相等的问题，是形状就不对）。
  $locationMatch = [regex]::Match($inner, '^(?<file>.+):(?<line>[0-9]+):(?<column>[0-9]+)$')
  if (-not $locationMatch.Success) {
    $result.Reason = ("首帧定位不是 '文件:行:列' 形状：'" + $inner + "'")
    return $result
  }

  $filePart = $locationMatch.Groups["file"].Value
  $linePart = $locationMatch.Groups["line"].Value
  $columnPart = $locationMatch.Groups["column"].Value

  # 形式归一化：只处理 file: / file:// 前缀，再去掉查询串/锚点，最后把反斜杠统一成 '/'。
  # 顺序刻意是「先按 file URL 拆 scheme，再切查询串/锚点，最后统一分隔符」：
  #   - 先切 '?'/'#' 再转分隔符，是为了不让反斜杠形态里可能出现的转义干扰 URL 语义；
  #   - 分隔符统一放在最后，保证下面的「协议相对前缀 //」判定看到的是统一形态。
  # UNC authority 必须保留：标准 UNC file URL 'file://server/share/x' 去掉 'file://' 后是
  #   'server/share/x'，若直接这么交给后续处理就会被当成「相对 RepoRoot 的路径」，
  #   于是 \\server\share\repo 下的合法首帧被误判成 'RepoRoot/server/share/...' 而错误拒绝。
  #   因此这里把 authority 补回成 '//server/share/x'（协议相对形态），authority 段原样保留。
  # localhost 按本机 file URL 处理：'file://localhost/C:/x' -> 'C:/x'（不是 UNC 主机名）。
  # 盘符 URL 的三种写法 'file:///C:/x'、'file://C:/x'、'file:/C:/x' 剥掉前缀后分别得到
  #   '/C:/x'、'C:/x'、'/C:/x'：第一种原样保留，第二种补前导斜杠，第三种同样保留；
  #   前导斜杠最终由 ConvertTo-TapFrameAbsolutePath 归一成 'C:/x'（见下面对应注释）。
  # 边界：'file://C:relative' 这种「盘符相对」形态不是合法 file URL，会落到 authority 分支被拒（fail closed），
  #   这是刻意的——宁可拒绝也不猜它相对哪个目录。
  # 反斜杠 UNC 形态 '\\\\server\\share\\x' 不含 scheme，走的是最后的分隔符统一分支，
  #   归一后就是 '//server/share/x'，因此后面的「去掉多余前导斜杠」循环必须保留 UNC 根（见下）。
  $normalized = $filePart
  if ($normalized -match '^(?i)file://') {
    $normalized = $normalized.Substring(7)
    # 剥掉 'file://' 后分三种形态处理：
    #   1) 以 '/' 开头            -> 盘符或本机绝对路径（file:///C:/x 剩下 '/C:/x'），不做额外处理；
    #   2) 单字母盘符（F:/x）     -> RFC 8089 里没有 authority 的盘符 URL（file://C:/x），
    #                               补一个前导斜杠归一成 '/F:/x'，绝不能让 'F:' 被当成 UNC 主机；
    #   3) 其余                   -> 第一个 '/' 之前是 authority（file://server/share/x）。
    if ($normalized -match '^(?i)[A-Za-z]:[/\\]') {
      # 盘符 URL：补前导斜杠，交给 ConvertTo-TapFrameAbsolutePath 按 '/C:/x' 归一成 'C:/x'。
      # 不补的话 'F:' 会被下面当成 authority，拼出不存在的 '//F:/repo/...'，合法盘符首帧会被误拒。
      $normalized = "/" + $normalized
    } elseif (-not $normalized.StartsWith("/")) {
      $authorityEnd = $normalized.IndexOf("/")
      $authority = ""
      $authorityTail = ""
      if ($authorityEnd -lt 0) {
        # 形如 'file://server'：没有路径段，整个剩余部分就是 authority。
        $authority = $normalized
      } else {
        $authority = $normalized.Substring(0, $authorityEnd)
        $authorityTail = $normalized.Substring($authorityEnd)
      }
      if ($authority -ieq "localhost") {
        # localhost 等价本机：丢弃 authority，只留路径（'file://localhost/C:/x' -> '/C:/x'）。
        $normalized = $authorityTail
      } else {
        # 其它 authority 一律按 UNC 主机保留成协议相对形态（'server/share/x' -> '//server/share/x'）。
        $normalized = "//" + $authority + $authorityTail
      }
    }
  } elseif ($normalized -match '^(?i)file:') {
    $normalized = $normalized.Substring(5)
  }
  $queryIndex = $normalized.IndexOf("?")
  if ($queryIndex -ge 0) { $normalized = $normalized.Substring(0, $queryIndex) }
  $fragmentIndex = $normalized.IndexOf("#")
  if ($fragmentIndex -ge 0) { $normalized = $normalized.Substring(0, $fragmentIndex) }
  # 注意：PowerShell 里反斜杠不是转义字符，"\\" 这个字面量就是「两个反斜杠字符」，
  # 因此 Replace("\\", "/") 只会替换「连续两个反斜杠」，原始 UNC 首帧（\\server\share\repo\...）
  # 内部的单反斜杠分隔符一个都不会被替换，归一后既丢 UNC 根又残留反斜杠，与 UNC 形式的 RepoRoot
  # 整体比较必然失败。这里必须按单字符替换：'\'(92) -> '/'(47)，与脚本里其它归一化点保持一致。
  $normalized = $normalized.Replace([char]92, [char]47)
  # 只把「多余的前导斜杠」折成单斜杠，且保留两个前导斜杠这一 UNC / 协议相对根：
  # '///C:/x' -> '/C:/x'（盘符 URL 的三斜杠形态），而 '//server/share/x' 保持不变。
  while ($normalized.StartsWith("///")) { $normalized = $normalized.Substring(1) }
  if ([string]::IsNullOrWhiteSpace($normalized)) {
    $result.Reason = "首帧定位的文件路径为空"
    return $result
  }

  # 真实 Windows 首帧会把盘符路径里的空格等字符写成百分号转义（例如 F:/01%20AI/...），
  # 而白名单写的是仓库相对路径，因此这里同时给出「原始」与「解码后」两个候选。
  # 解码失败（非法百分号转义）不额外放宽判据：保留原始候选并记下原因，由调用方按候选逐个精确比较，
  # 解不开的路径只会匹配失败，不会被当成命中。
  $result.Ok = $true
  $result.Candidates = @($normalized)
  try {
    $decodedPath = [System.Uri]::UnescapeDataString($normalized)
    if (-not [string]::IsNullOrEmpty($decodedPath) -and $decodedPath -cne $normalized) {
      $result.Candidates += $decodedPath
    }
  } catch {
    $result.DecodeError = [string]$_.Exception.Message
  }
  $result.Line = [int]$linePart
  $result.Column = [int]$columnPart
  return $result
}

# 把「首帧里的文件路径」与「仓库根」组合成规范化的 lexical 绝对路径，用于整体比较。
# 为什么必须相对仓库根比较，而不是比后缀：后缀匹配（以 '/' + 白名单相对路径结尾）会把
# 任意 other/test/package-portability.test.mjs 也判成命中——只要别处存在同名测试文件，
# 就能伪造出「首帧落在白名单文件里」的定位证据，等于把基线门禁放宽。
# 规则：
#   1) 绝对路径（含 'C:\...'、'/C:/...'、'\\\\server\\share\\...'）直接规范化；
#      相对路径按 RepoRoot 组合后再规范化；
#   2) 分隔符统一成 '/'、去掉非根的尾部 '/'；
#   3) 用 OrdinalIgnoreCase 做整体相等比较（Windows 大小写不敏感）；
#   4) 任一侧规范化失败（空路径、非法路径、取不到仓库根）一律返回 $false——
#      绝不退回后缀匹配，避免「算不出来就当命中」这种 fail open 行为。
function ConvertTo-TapFrameAbsolutePath {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$RepoRoot
  )
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  if ([string]::IsNullOrWhiteSpace($RepoRoot)) { return $null }
  $candidate = $Path.Trim()
  if ($candidate.Length -eq 0) { return $null }
  # '/C:/x' 这种「盘符前多一个前导斜杠」的形式（file:///C:/x 剥掉 file:// 后就长这样）
  # 在 Windows 上会被 Path.GetFullPath 当成「当前盘根目录下的相对路径」而拼出 C:\C:\x，
  # 因此先归一化成 'C:/x' 再交给 GetFullPath。
  # '//server/share/x'（UNC authority 保留后的形态）刻意不走这条分支：它以双斜杠开头，
  # 不匹配下面的盘符形状，Path.IsPathRooted 会判为根路径，GetFullPath 会把它规范化成
  # \\server\share\x，从而与 RepoRoot 侧（\\server\share\repo 或 //server/share/repo）整体可比。
  if ($candidate -match '^/[A-Za-z]:[/\\]') { $candidate = $candidate.Substring(1) }
  $full = ""
  $rootFull = ""
  try {
    $rootFull = [System.IO.Path]::GetFullPath($RepoRoot)
  } catch {
    return $null
  }
  try {
    if ([System.IO.Path]::IsPathRooted($candidate)) {
      $full = [System.IO.Path]::GetFullPath($candidate)
    } else {
      $full = [System.IO.Path]::GetFullPath((Join-Path $rootFull $candidate))
    }
  } catch {
    return $null
  }
  if ([string]::IsNullOrWhiteSpace($full)) { return $null }
  $normalized = $full.Replace([char]92, [char]47)
  $pathRoot = ""
  try { $pathRoot = [System.IO.Path]::GetPathRoot($normalized) } catch { return $null }
  if ([string]::IsNullOrEmpty($pathRoot)) { return $null }
  $trimmedRoot = $pathRoot.Replace([char]92, [char]47)
  if ($normalized.Length -gt $trimmedRoot.Length) { $normalized = $normalized.TrimEnd([char]47) }
  if ([string]::IsNullOrWhiteSpace($normalized)) { return $null }
  return $normalized
}

# 判断归一化后的首帧文件路径是否与白名单文件（仓库相对路径）指向同一个文件。
# 判据：两侧都相对 RepoRoot 规范化成 lexical 绝对路径后整体相等（大小写不敏感、分隔符统一、
# 忽略非根尾部斜杠）。不做后缀匹配、不做包含匹配：'F:/other/test/x.test.mjs' 与
# 'F:/repo/test/x.test.mjs' 规范化后文本不同，必须拒绝。
# 任一候选规范化失败返回 $false（调用方据此判定位证据不吻合，绝不放行）。
function Test-TapFrameFileMatches {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyString()][string]$FrameFile,
    [Parameter(Mandatory = $true)][string]$ExpectedFile,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  $left = ConvertTo-TapFrameAbsolutePath -Path $FrameFile -RepoRoot $RepoRoot
  if ($null -eq $left) { return $false }
  $right = ConvertTo-TapFrameAbsolutePath -Path $ExpectedFile -RepoRoot $RepoRoot
  if ($null -eq $right) { return $false }
  return $left.Equals($right, [System.StringComparison]::OrdinalIgnoreCase)
}

# 首帧路径候选（原始 / 百分号解码后）中只要有任意一个命中白名单文件就算文件维度吻合。
# 仍然逐个做「相对仓库根规范化 + 整体相等」的精确比较，不做包含/后缀匹配；
# 全部候选都不命中（或都规范化失败）才返回 $false。
function Test-TapFrameFileMatchesAny {
  param(
    [Parameter(Mandatory = $true)][AllowNull()][AllowEmptyCollection()][string[]]$FrameFiles,
    [Parameter(Mandatory = $true)][string]$ExpectedFile,
    [Parameter(Mandatory = $true)][string]$RepoRoot
  )
  foreach ($candidate in @($FrameFiles)) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }
    if (Test-TapFrameFileMatches -FrameFile $candidate -ExpectedFile $ExpectedFile -RepoRoot $RepoRoot) { return $true }
  }
  return $false
}

# 统一换行后再切分，避免 CRLF 让行尾锚点与 |- 判定失配。
$tapText = $tapText.Replace("`r`n", "`n").Replace("`r", "`n")
if ($tapText -notmatch "(?m)^TAP version 13\s*$") {
  Stop-Install -Reason "测试输出不是可识别的 TAP（缺少 'TAP version 13' 头），无法定位失败，已中止。"
}
$failures = @(Get-TapFailureRecords -Lines ($tapText -split "`n"))

# 交叉核对：失败块解析数必须等于 TAP 自己声明的 '# fail N'，否则说明有失败块没被解析出来。
$tapFailSummary = [regex]::Match($tapText, "(?m)^# fail\s+(\d+)\s*$")
if (-not $tapFailSummary.Success) {
  Stop-Install -Reason "TAP 输出缺少 '# fail N' 汇总行，无法交叉核对失败集合是否完整，已中止。"
}
$declaredFailCount = [int]$tapFailSummary.Groups[1].Value
if ($declaredFailCount -ne $failures.Count) {
  Stop-Install -Reason ("TAP 失败块解析数（" + $failures.Count + "）与汇总行 '# fail " + $declaredFailCount + "' 不一致，无法确认失败集合完整，已中止。")
}

Write-Stage -Message ("测试退出码：" + $testExit + "；TAP 失败块数：" + $failures.Count + "（与 '# fail " + $declaredFailCount + "' 一致）")

# 基线失败白名单：必须逐项证据吻合，且 stack 首帧「结构化精确命中」指定断言行。
# 刻意不使用 location（测试定义行）作为定位证据——它只做一致性交叉核对。
# 定位证据拆成三个字段（FrameFile / FrameLine / FrameColumn），比较时整体相等；
# 不再保留任何 file:line:col 字符串，杜绝退回子串匹配。
$baselineWhitelist = @(
  @{
    Title = "package files、exports、bin 和 bundle patch 都指向当前工作区中的可发布文件"
    File = "test/package-portability.test.mjs"
    FailureType = "testCodeFailure"
    Name = "AssertionError"
    Code = "ERR_ASSERTION"
    Operator = "strictEqual"
    Expected = "./bin/prompt-inspector.mjs"
    Actual = "bin/prompt-inspector.mjs"
    ErrorEquals = ""
    ErrorContains = @(
      "Expected values to be strictly equal:",
      "+ 'bin/prompt-inspector.mjs'",
      "- './bin/prompt-inspector.mjs'"
    )
    FrameFile = "test/package-portability.test.mjs"
    FrameLine = 92
    FrameColumn = 10
  },
  @{
    Title = "README 与实现一致：goals 可选服务决策、诊断入口与敏感性边界都有文档标记"
    File = "test/capability-diagnostics.test.mjs"
    FailureType = "testCodeFailure"
    Name = "AssertionError"
    Code = "ERR_ASSERTION"
    Operator = "=="
    Expected = "true"
    Actual = "false"
    ErrorEquals = "README 必须记录 meta 的 capabilities 字段"
    ErrorContains = @()
    FrameFile = "test/capability-diagnostics.test.mjs"
    FrameLine = 416
    FrameColumn = 10
  }
)

# 首帧定位的可读描述（日志与失败信息用）。
function Format-BaselineFrameTarget {
  param([Parameter(Mandatory = $true)][hashtable]$Entry)
  return ([string]$Entry.FrameFile + ":" + [string]$Entry.FrameLine + ":" + [string]$Entry.FrameColumn)
}

$unrecognized = @()
# 每个白名单条目最多只能被接受一次：同一条已知失败重复出现时，第二次起一律判为
# 非基线失败并中止——否则「同一条基线失败重复刷满 '# fail N'」就能掩盖真正的新失败。
# 注意：白名单条目「不要求全部出现」，基线被修好后 0 条失败也完全合法。
$acceptedWhitelistTitles = @{}
foreach ($failure in $failures) {
  $titleHits = @($baselineWhitelist | Where-Object { $_.Title -ceq $failure.Title })
  if ($titleHits.Count -eq 0) {
    $unrecognized += ("[非白名单标题] " + $failure.Title)
    continue
  }
  if ($titleHits.Count -gt 1) {
    $unrecognized += ("[白名单自身重复，无法唯一判定] " + $failure.Title)
    continue
  }
  $entry = $titleHits[0]
  if ($acceptedWhitelistTitles.ContainsKey($entry.Title)) {
    $unrecognized += ("[基线失败重复出现，同一白名单条目只允许接受一次] " + $failure.Title + " @ " + (Format-BaselineFrameTarget -Entry $entry))
    continue
  }

  $mismatch = @()
  if ($failure.FailureType -cne $entry.FailureType) { $mismatch += ("failureType='" + $failure.FailureType + "' 期望 '" + $entry.FailureType + "'") }
  if ($failure.Name -cne $entry.Name) { $mismatch += ("name='" + $failure.Name + "' 期望 '" + $entry.Name + "'") }
  if ($failure.Code -cne $entry.Code) { $mismatch += ("code='" + $failure.Code + "' 期望 '" + $entry.Code + "'") }
  if ($failure.Operator -cne $entry.Operator) { $mismatch += ("operator='" + $failure.Operator + "' 期望 '" + $entry.Operator + "'") }
  if ($failure.Expected -cne $entry.Expected) { $mismatch += ("expected='" + $failure.Expected + "' 期望 '" + $entry.Expected + "'") }
  if ($failure.Actual -cne $entry.Actual) { $mismatch += ("actual='" + $failure.Actual + "' 期望 '" + $entry.Actual + "'") }
  if (-not [string]::IsNullOrEmpty($entry.ErrorEquals)) {
    if ($failure.Error -cne $entry.ErrorEquals) { $mismatch += ("error='" + $failure.Error + "' 期望 '" + $entry.ErrorEquals + "'") }
  }
  foreach ($needle in @($entry.ErrorContains)) {
    if ($failure.Error.IndexOf($needle, [System.StringComparison]::Ordinal) -lt 0) {
      $mismatch += ("error 缺少片段 '" + $needle + "'")
    }
  }

  # 唯一的定位证据：stack 的首个非空帧必须「结构化」精确命中期望的断言行。
  # 判据 = 路径段边界匹配 + 行号整体相等 + 列号整体相等；不做任何子串命中。
  $stackLines = @($failure.Stack -split "`n" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($stackLines.Count -eq 0) {
    $mismatch += "失败块缺少 stack，无法确认断言行"
  } else {
    $firstFrame = [string]$stackLines[0]
    $frameLocation = Get-TapStackFrameLocation -Frame $firstFrame
    if (-not $frameLocation.Ok) {
      $mismatch += ("stack 首帧无法解析出唯一断言行定位（" + $frameLocation.Reason + "；实际首帧：" + $firstFrame + "）")
    } elseif (-not (Test-TapFrameFileMatchesAny -FrameFiles $frameLocation.Candidates -ExpectedFile ([string]$entry.FrameFile) -RepoRoot $repoRoot)) {
      $mismatch += ("stack 首帧文件不匹配：实际 '" + ($frameLocation.Candidates -join " | ") + "' 期望 '" + [string]$entry.FrameFile + "'（实际首帧：" + $firstFrame + "）")
    } elseif ($frameLocation.Line -ne [int]$entry.FrameLine) {
      $mismatch += ("stack 首帧行号不匹配：实际 " + $frameLocation.Line + " 期望 " + [int]$entry.FrameLine + "（实际首帧：" + $firstFrame + "）")
    } elseif ($frameLocation.Column -ne [int]$entry.FrameColumn) {
      $mismatch += ("stack 首帧列号不匹配：实际 " + $frameLocation.Column + " 期望 " + [int]$entry.FrameColumn + "（实际首帧：" + $firstFrame + "）")
    }
  }

  # location 仅做一致性交叉核对：存在且能解析出路径时，必须落在期望文件里；不能单独作为通过依据。
  # 注意：TAP 里的 Windows 路径可能是单反斜杠也可能是双反斜杠转义，这里统一折叠后再比较。
  if (-not [string]::IsNullOrWhiteSpace($failure.Location)) {
    $locationForward = $failure.Location -replace "\\+", "/"
    if ($locationForward.IndexOf($entry.File, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
      $mismatch += ("location 与期望文件不一致：" + $failure.Location)
    }
  }

  if ($mismatch.Count -gt 0) {
    $unrecognized += ("[白名单标题但证据不吻合] " + $failure.Title + " | " + ($mismatch -join " ; "))
    continue
  }
  # 记账：该白名单条目已被消费一次，后续再出现同一标题即视为重复基线失败。
  $acceptedWhitelistTitles[$entry.Title] = $true
  Write-Stage -Message ("  已确认基线失败：" + $failure.Title + " @ " + (Format-BaselineFrameTarget -Entry $entry)) -Color Yellow
}

if ($unrecognized.Count -gt 0) {
  $detail = ($unrecognized -join ("`n" + "    "))
  Stop-Install -Reason ("测试出现 " + $unrecognized.Count + " 个无法归入基线的失败，已中止（不允许吞掉错误）：" + "`n" + "    " + $detail)
}

if ($testExit -ne 0 -and $failures.Count -eq 0) {
  Stop-Install -Reason ("测试退出码非 0（" + $testExit + "）但 TAP 中没有可解析的失败块，无法定位原因，已中止。")
}
if ($failures.Count -eq 0) {
  Write-Stage -Message "测试零失败，继续" -Color Green
} else {
  Write-Stage -Message ("测试仅有 " + $failures.Count + " 个已记录的基线失败（逐项证据已核对），继续") -Color Green
}

# ── 6. 打包到持久目录 ────────────────────────────────────────────────────────────

Start-Stage -Name "04-pack"
$tgzPath = Join-Path $packDir ($packageName + "-" + $packageVersion + ".tgz")
$packExit = Invoke-NativeCommand -Executable "pnpm" -Arguments @("pack", "--pack-destination", $packDir) -LogPath (Join-Path $logDir "pnpm-pack.log")
if ($packExit -ne 0) {
  Stop-Install -Reason ("pnpm pack 失败（退出码 " + $packExit + "），已中止。")
}
if (-not (Test-Path -LiteralPath $tgzPath -PathType Leaf)) {
  Stop-Install -Reason ("未生成预期 tgz：" + $tgzPath)
}
$tgzHash = (Get-FileHash -LiteralPath $tgzPath -Algorithm SHA256).Hash.ToLowerInvariant()

# git 身份信息（仅供人工核对包的来源，不是门禁）。
$gitSha = ""
$gitDirty = -1
$gitCmd = Get-Command git -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if ($null -ne $gitCmd) {
  $gitSha = (& $gitCmd.Source -C $repoRoot rev-parse HEAD 2>&1 | Out-String).Trim()
  $dirtyLines = @(& $gitCmd.Source -C $repoRoot status --porcelain 2>&1)
  $gitDirty = $dirtyLines.Count
}

Write-Stage -Message ("  版本   : " + $packageVersion)
Write-Stage -Message ("  git    : " + $gitSha + " (dirty=" + $gitDirty + ")")
Write-Stage -Message ("  tgz    : " + $tgzPath)
Write-Stage -Message ("  sha256 : " + $tgzHash)

# ── 7. 解包与发布面检查 ──────────────────────────────────────────────────────────

Start-Stage -Name "05-unpack"
$unpackDir = Join-Path $packDir "unpacked"
New-Item -ItemType Directory -Path $unpackDir -Force | Out-Null
$tarExit = Invoke-NativeCommand -Executable "tar" -Arguments @("-xzf", $tgzPath, "-C", $unpackDir) -LogPath (Join-Path $logDir "unpack.log")
if ($tarExit -ne 0) {
  Stop-Install -Reason ("解包失败（tar 退出码 " + $tarExit + "），已中止。")
}
$unpackedPackage = Join-Path $unpackDir "package"
if (-not (Test-Path -LiteralPath $unpackedPackage -PathType Container)) {
  Stop-Install -Reason ("解包结果缺少 package 目录：" + $unpackedPackage)
}

# 以 package.json 的 files 白名单为发布面唯一事实源（npm 语义下 package.json 自身必然随包发布）。
$declaredEntries = @($repoManifest.files | Where-Object { $_ -is [string] -and -not [string]::IsNullOrWhiteSpace($_) })
if ($declaredEntries.Count -eq 0) {
  Stop-Install -Reason "仓库 package.json 的 files 白名单为空，无法确定发布面，已中止。"
}
$expectedEntries = @($declaredEntries | ForEach-Object { ([string]$_).Trim() -replace "\\", "/" }) + @("package.json")

$unpackedFiles = @(Get-ChildItem -LiteralPath $unpackedPackage -Recurse -File -Force)
$unpackedMap = Get-FileHashMap -Root $unpackedPackage
Write-Stage -Message ("  解包文件数：" + $unpackedFiles.Count + "；files 白名单项数：" + $declaredEntries.Count)

# 7.1 每个白名单项都必须真实存在于包内。
$missingEntries = @()
foreach ($entry in $expectedEntries) {
  if (-not $unpackedMap.ContainsKey($entry)) { $missingEntries += $entry }
}
if ($missingEntries.Count -gt 0) {
  Stop-Install -Reason ("发布面缺失 " + $missingEntries.Count + " 项：" + "`n" + "    " + ($missingEntries -join ("`n" + "    ")))
}

# 7.2 包内不得出现白名单之外的额外文件（防止开发面被意外带出）。
$expectedSet = @{}
foreach ($entry in $expectedEntries) { $expectedSet[$entry] = $true }
$extraEntries = @($unpackedMap.Keys | Where-Object { -not $expectedSet.ContainsKey($_) } | Sort-Object)
if ($extraEntries.Count -gt 0) {
  Stop-Install -Reason ("发布面出现 " + $extraEntries.Count + " 个白名单之外的额外文件：" + "`n" + "    " + ($extraEntries -join ("`n" + "    ")))
}

# 7.3 泄漏目录检查：test/、bench/、.scratch/、docs/ 一律不得进入发布面。
$leaked = @($unpackedFiles | Where-Object { $_.FullName -match $leakPattern })
if ($leaked.Count -gt 0) {
  $leakedNames = @($leaked | ForEach-Object { $_.FullName.Substring($unpackedPackage.Length) })
  Stop-Install -Reason ("发布面泄漏开发目录 " + $leaked.Count + " 个文件：" + "`n" + "    " + ($leakedNames -join ("`n" + "    ")))
}

# 7.4 包内 manifest 的 files 必须与仓库一致（pnpm pack 会规范化 manifest，这是发布面的真实形态）。
$unpackedManifest = Get-Content -LiteralPath (Join-Path $unpackedPackage "package.json") -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
if ([string]$unpackedManifest.name -ne $packageName -or [string]$unpackedManifest.version -ne $packageVersion) {
  Stop-Install -Reason ("包内 manifest 名称/版本与仓库不一致：包内 " + [string]$unpackedManifest.name + "@" + [string]$unpackedManifest.version)
}
$unpackedDeclared = @($unpackedManifest.files | ForEach-Object { ([string]$_).Trim() -replace "\\", "/" })
$repoDeclared = @($declaredEntries | ForEach-Object { ([string]$_).Trim() -replace "\\", "/" })
$manifestDrift = @()
foreach ($entry in $repoDeclared) { if ($unpackedDeclared -notcontains $entry) { $manifestDrift += ("包内缺少: " + $entry) } }
foreach ($entry in $unpackedDeclared) { if ($repoDeclared -notcontains $entry) { $manifestDrift += ("包内多出: " + $entry) } }
if ($manifestDrift.Count -gt 0) {
  Stop-Install -Reason ("包内 package.json 的 files 与仓库不一致：" + "`n" + "    " + ($manifestDrift -join ("`n" + "    ")))
}

# 7.5 发布面逐文件 SHA256 清单落盘（后续与 desktop 安装目录双向比对）。
$manifestLines = @()
foreach ($relative in ($unpackedMap.Keys | Sort-Object)) {
  $manifestLines += ($relative + "`tsha256=" + $unpackedMap[$relative])
}
if ($manifestLines.Count -eq 0) { $manifestLines = @("(空)") }
$manifestLines | Set-Content -LiteralPath (Join-Path $packDir "release-surface.sha256.txt") -Encoding UTF8
$surfaceJson = @{ package = $packageName; version = $packageVersion; tgz = $tgzPath; tgzSha256 = $tgzHash; fileCount = $unpackedMap.Count; files = $unpackedMap }
Set-Content -LiteralPath (Join-Path $packDir "release-surface.sha256.json") -Encoding UTF8 -Value (ConvertTo-Json -InputObject $surfaceJson)

Write-Stage -Message ("发布面检查通过：" + $unpackedMap.Count + " 个文件全部在 files 白名单内，无 test/bench/.scratch/docs 泄漏") -Color Green

# ── 8. 安装前完整备份 ────────────────────────────────────────────────────────────

Start-Stage -Name "06-backup"
if (Test-Path -LiteralPath $backupDir) {
  Stop-Install -Reason ("备份目录已存在，拒绝覆盖：" + $backupDir)
}
New-Item -ItemType Directory -Path $backupDir | Out-Null

# 8.1 管理文件快照：逐个记存在性 + sha256（不存在的项也要记 exists=false）。
$mgmtRows = @()
foreach ($name in $mgmtFiles) {
  $filePath = Join-Path $profileDir $name
  if (Test-Path -LiteralPath $filePath -PathType Leaf) {
    $hash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $filePath -Destination $backupDir -Force
    $mgmtRows += ($name + "`texists=true`tsha256=" + $hash)
  } else {
    $mgmtRows += ($name + "`texists=false`tsha256=")
  }
}
$mgmtRows | Set-Content -LiteralPath (Join-Path $backupDir "profile-management-files.txt") -Encoding UTF8
Write-Stage -Message ("  已记录 " + $mgmtRows.Count + " 个管理文件的存在性与 SHA256")

# 8.2 安装前的插件列表（CLI 只读命令）。
$listBeforePath = Join-Path $backupDir "plugin-list.before.txt"
$listBeforeExit = Invoke-NativeCommand -Executable $cli -Arguments @("plugin", "--profile", $profileName, "list") -LogPath $listBeforePath
if ($listBeforeExit -ne 0) {
  Stop-Install -Reason ("无法记录安装前插件列表（CLI 退出码 " + $listBeforeExit + "），已中止。")
}

# 8.3 依赖树备份：必须解引用复制（pnpm 的 symlink/junction 会让普通递归复制跟随到 profile 外的 store），
#     并对「源树（跟随链接）」与「备份树」逐相对路径 SHA256 比对，missing/extra/mismatch 全 0 才算成功。
$profileNodeModules = Join-Path $profileDir "node_modules"
$backupNodeModules = Join-Path $backupDir "node_modules"
$backupTreeSourceFiles = 0
$backupTreeDestFiles = 0
if (Test-Path -LiteralPath $profileNodeModules -PathType Container) {
  $backupScript = @'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
// 依赖树备份：dereference 跟随 pnpm 的 symlink/junction，把真实文件内容复制进备份目录，
// 避免备份树里留下指向 profile 外 store 的链接（那样备份既不完整、也无法逐文件核对）。
const [src, dst] = process.argv.slice(2);
fs.cpSync(src, dst, { recursive: true, dereference: true, force: true });
const walk = (root) => {
  const out = new Map();
  const rec = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const q = path.join(dir, e.name);
      const s = fs.statSync(q); // 跟随链接
      if (s.isDirectory()) rec(q);
      else if (s.isFile()) out.set(path.relative(root, q).split(path.sep).join("/"), crypto.createHash("sha256").update(fs.readFileSync(q)).digest("hex"));
      else throw new Error("不支持的文件类型: " + q);
    }
  };
  rec(root);
  return out;
};
const a = walk(src), b = walk(dst);
const missing = [...a.keys()].filter((k) => !b.has(k));
const extra = [...b.keys()].filter((k) => !a.has(k));
const mismatch = [...a.keys()].filter((k) => b.has(k) && a.get(k) !== b.get(k));
const lines = [...a.keys()].sort().map((k) => k + "\tsha256=" + a.get(k));
fs.writeFileSync(path.join(path.dirname(dst), "node-modules-backup.sha256.txt"), lines.join("\n") + "\n", "utf8");
console.log("BACKUP_TREE " + JSON.stringify({ sourceFiles: a.size, destFiles: b.size, missing: missing.length, extra: extra.length, mismatch: mismatch.length }));
if (missing.length || extra.length || mismatch.length) {
  console.log("missing:", missing.slice(0, 20));
  console.log("extra:", extra.slice(0, 20));
  console.log("mismatch:", mismatch.slice(0, 20));
  process.exit(1);
}
console.log("BACKUP_TREE_OK");
'@
  $backupScriptPath = Join-Path $backupDir "backup-node-modules.mjs"
  Write-TextFileNoBom -Path $backupScriptPath -Content $backupScript
  $treeExit = Invoke-NativeCommand -Executable "node" -Arguments @($backupScriptPath, $profileNodeModules, $backupNodeModules) -LogPath (Join-Path $logDir "backup-node-modules.log")
  if ($treeExit -ne 0) {
    Stop-Install -Reason ("依赖树备份与哈希比对不一致（退出码 " + $treeExit + "），已中止；备份目录保留在 " + $backupDir)
  }
  $treeLog = Get-Content -LiteralPath (Join-Path $logDir "backup-node-modules.log") -Raw -Encoding UTF8
  if ($treeLog -notmatch "BACKUP_TREE_OK") {
    Stop-Install -Reason "依赖树备份未打印 BACKUP_TREE_OK，无法确认备份完整性，已中止。"
  }
  $treeMatch = [regex]::Match($treeLog, "BACKUP_TREE\s+(\{.*?\})")
  if ($treeMatch.Success) {
    $treeSummary = $treeMatch.Groups[1].Value | ConvertFrom-Json
    $backupTreeSourceFiles = [int]$treeSummary.sourceFiles
    $backupTreeDestFiles = [int]$treeSummary.destFiles
  }
  Write-Stage -Message ("  依赖树备份完成：源 " + $backupTreeSourceFiles + " 文件 / 备份 " + $backupTreeDestFiles + " 文件，逐文件 SHA256 全一致") -Color Green
} else {
  New-Item -ItemType Directory -Path $backupNodeModules -Force | Out-Null
  Write-Stage -Message "  profile 下没有 node_modules，依赖树备份记为 0 文件" -Color Yellow
}

$installContext = @{
  package = $packageName
  version = $packageVersion
  tgz = $tgzPath
  tgzSha256 = $tgzHash
  packDir = $packDir
  backupDir = $backupDir
  repoRoot = $repoRoot
  appRoot = $appRoot
  cli = $cli
  dshHome = $dshHome
  profileDir = $profileDir
  gitSha = $gitSha
  gitDirty = $gitDirty
  startedAt = (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
}
Set-Content -LiteralPath (Join-Path $backupDir "install-context.json") -Encoding UTF8 -Value (ConvertTo-Json -InputObject $installContext)

Write-Stage -Message ("备份完成：" + $backupDir + "（只读材料，后续步骤不移动、不删除）") -Color Green

# ── 9. 安装（唯一写操作，全部经 CLI） ────────────────────────────────────────────

Start-Stage -Name "07-install"
Write-Stage -Message "通过自带 CLI 安装本次 tgz（不使用 --force、不 remove、失败不重试）" -Color Yellow
# 预检阶段已经查过一次，但这里要再查一次：从预检到真正调用 CLI add 之间隔着 build / test /
# pack / 解包 / 备份等耗时阶段，profile 目录完全可能在这段时间里被人为改成链接，甚至被删掉
# （删掉同样是中止条件，不再是「读不到就跳过」）。把检查放在 add 调用「紧前」，
# 把「预检结论」与「实际写入」之间的时间窗口压到最小。
Assert-ProfilePathIsolation -Stage "07-install"
$addLogPath = Join-Path $backupDir "add.log"
$addExit = Invoke-NativeCommand -Executable $cli -Arguments @("plugin", "--profile", $profileName, "add", $tgzPath) -LogPath $addLogPath
if ($addExit -ne 0) {
  $addFailReason = "CLI 安装阶段失败（exit=" + $addExit + "）。安装可能已部分修改 desktop profile：" + "`n" + "    请人工核对 " + $profileDir + " 的 package.json / pnpm-lock.yaml / node_modules 与备份 " + $backupDir + "，" + "`n" + "    不要 --force、不要反复重试。全部包、备份与日志均已保留。"
  Stop-Install -Reason $addFailReason
}
# 软校验：add 输出里应能看到本次 tgz 路径（Windows 路径反斜杠按 / 归一后比较，避免转义差异误判）。
$addLogText = Get-Content -LiteralPath $addLogPath -Raw -Encoding UTF8
$tgzForward = $tgzPath -replace "\\", "/"
$addLogForward = $addLogText -replace "\\", "/"
if ($addLogForward.IndexOf($tgzForward, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
  Write-Stage -Message "  提示：add 日志中未直接出现本次 tgz 路径（最终以 profile 与 lock 校验为准）" -Color Yellow
}
Write-Stage -Message "CLI 安装完成" -Color Green

$listAfterPath = Join-Path $backupDir "list.after.txt"
$listAfterExit = Invoke-NativeCommand -Executable $cli -Arguments @("plugin", "--profile", $profileName, "list") -LogPath $listAfterPath
if ($listAfterExit -ne 0) {
  Stop-Install -Reason ("安装后 plugin list 失败（退出码 " + $listAfterExit + "），已中止；请人工核对 profile 状态。")
}
Write-Stage -Message "安装后 plugin list 已记录" -Color Green

# ── 10. 安装后校验 ───────────────────────────────────────────────────────────────

Start-Stage -Name "08-verify"

# 安装后再次确认 profile 路径没有被重定向（add 过程中也可能被人为改写）：
# 校验必须发生在与安装前同一个真实目录上，否则后面的「自洽通过」毫无意义。
Assert-ProfilePathIsolation -Stage "08-verify"

# 10.1 profile 与发布面双向比对（路径集合 + 逐文件 SHA256），由 Node 完成（PowerShell 处理链接语义不便）。
$verifyScript = @'
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const [profileDir, packDir, pkgName, tgzPath] = process.argv.slice(2);
const problems = [];
const fail = (msg) => problems.push(msg);
const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
const norm = (p) => path.resolve(p).replace(/\\/g, "/").toLowerCase();
const inside = (child, parent) => norm(child) === norm(parent) || norm(child).startsWith(norm(parent) + "/");
// 真实路径解析：realpathSync 失败（路径消失 / 权限不足 / 链接损坏）时记 fail 并返回 null，
// 由调用方按 fail closed 处理；绝不退回 lexical 比较——lexical 比较在 DSH_HOME 是符号链接时
// 会把合法安装误判成越界，在 profile 被别名时又可能把越界误判成合法，两个方向都不可接受。
const realpathOrFail = (p, label) => {
  try {
    return fs.realpathSync(p);
  } catch (error) {
    fail("无法解析真实路径（" + label + "）：" + p + "（" + error.message + "），已按 fail closed 中止");
    return null;
  }
};

// ── pnpm-lock.yaml 的小型缩进结构解析（fail closed，不引入 YAML 依赖） ──────────
// 为什么不用「整份 lock 文本里出现本轮 tgz 路径」这种判据：lock 的 packages 段、别的 importer、
// 甚至历史残留条目都可能包含同一路径，那样会把「根本没写进 desktop profile 依赖」误判为通过。
// 这里按 pnpm-lock.yaml 的真实层级（importers -> <importer> -> dependencies -> <pkg>）定向取值，
// 任何一层缺失或歧义都返回 { ok: false, reason }，由调用方报错中止。
// 特别是「重复键」：importers 段里的 importer 键、importer 下的 dependencies 键、dependencies 段里的
// 目标依赖键、以及目标条目内的 specifier / version 字段，只要重复出现就一律拒绝解析——
// 绝不静默取首项或末项（YAML 重复键的真实语义不可靠，取哪一项都可能与 pnpm 实际使用的不一致）。
const lockIndentOf = (line) => (/^[ ]*/.exec(line))[0].length;
const lockKeyOf = (raw) => {
  let key = raw.trim();
  if (key.length >= 2 && ((key.startsWith("'") && key.endsWith("'")) || (key.startsWith('"') && key.endsWith('"')))) {
    key = key.slice(1, -1);
  }
  return key;
};
// 在 [from, ...] 范围内，收集缩进恰好为 indent 的 `key:` 行（遇到缩进小于 stopIndent 的行停止，
// 说明已离开当前层级）。返回全部命中行的下标：调用方据此区分「0 处 = 缺失」「1 处 = 唯一」
// 「>1 处 = 重复键」。重复键绝不允许静默取首项或末项——那会让门禁读到一份「碰巧合法」的条目，
// 而 pnpm 实际使用的可能是另一份（YAML 重复键的真实语义就是不可靠）。
const findLockKeysAtIndent = (lines, from, indent, key, stopIndent) => {
  const pattern = new RegExp("^ {" + indent + "}(.+?):\\s*$");
  const hits = [];
  for (let i = from; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const ind = lockIndentOf(line);
    if (ind < stopIndent) break;
    if (ind !== indent) continue;
    const m = pattern.exec(line);
    if (m && lockKeyOf(m[1]) === key) hits.push(i);
  }
  return hits;
};
// 读取 importers.<importerName>.dependencies.<depName> 的字段集合。
// 返回值统一为 { ok: true, fields } / { ok: false, reason }：
//   - importers / importer / dependencies 任一层的键重复（>1 处）→ 拒绝；
//   - 目标依赖键不是恰好出现 1 次 → 拒绝；
//   - 条目内 specifier / version 等字段键重复 → 拒绝。
// 任何一层重复都不得静默取首项或末项，一律 fail closed 交给调用方中止。
const readLockImporterDependency = (lockText, importerName, depName) => {
  const lines = lockText.split(/\r?\n/);
  const importersAt = lines.findIndex((line) => /^importers:\s*$/.test(line));
  if (importersAt < 0) return { ok: false, reason: "pnpm-lock.yaml 缺少顶层 importers 段" };

  const importerHits = findLockKeysAtIndent(lines, importersAt + 1, 2, importerName, 2);
  if (importerHits.length === 0) return { ok: false, reason: "pnpm-lock.yaml 的 importers 段里找不到 importer '" + importerName + "'" };
  if (importerHits.length > 1) return { ok: false, reason: "pnpm-lock.yaml 的 importers 段里 importer '" + importerName + "' 重复出现 " + importerHits.length + " 次（重复键拒绝解析）" };
  const importerAt = importerHits[0];

  const depsHits = findLockKeysAtIndent(lines, importerAt + 1, 4, "dependencies", 4);
  if (depsHits.length === 0) return { ok: false, reason: "importer '" + importerName + "' 下找不到 dependencies 段" };
  if (depsHits.length > 1) return { ok: false, reason: "importer '" + importerName + "' 下的 dependencies 键重复出现 " + depsHits.length + " 次（重复键拒绝解析）" };
  const depsAt = depsHits[0];

  // 目标依赖键必须唯一出现，避免在别的区块里取到同名条目。
  const depMatches = [];
  const depPattern = /^ {6}(.+?):\s*$/;
  for (let i = depsAt + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const ind = lockIndentOf(line);
    if (ind < 6) break;
    if (ind !== 6) continue;
    const m = depPattern.exec(line);
    if (m && lockKeyOf(m[1]) === depName) depMatches.push(i);
  }
  if (depMatches.length === 0) return { ok: false, reason: "dependencies 段里找不到依赖 '" + depName + "'" };
  if (depMatches.length > 1) return { ok: false, reason: "依赖 '" + depName + "' 在 dependencies 段里重复出现 " + depMatches.length + " 次（重复键拒绝解析）" };

  // 字段键同样必须唯一：specifier / version 重复出现时不能取首项或末项。
  // 用 Object.create(null) 避免 __proto__ 之类键名落到原型链上。
  const fields = Object.create(null);
  const fieldPattern = /^ {8}([A-Za-z0-9_]+):\s*(.*)$/;
  for (let i = depMatches[0] + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;
    const ind = lockIndentOf(line);
    if (ind < 8) break;
    if (ind !== 8) continue;
    const m = fieldPattern.exec(line);
    if (!m) continue;
    if (Object.prototype.hasOwnProperty.call(fields, m[1])) {
      return { ok: false, reason: "依赖 '" + depName + "' 的字段 '" + m[1] + "' 重复出现（重复键拒绝解析）" };
    }
    fields[m[1]] = m[2].trim();
  }
  return { ok: true, fields };
};
// 把 lock 里的 file: 引用解析成候选绝对路径（归一化后比较）。
// 不是 file: 引用时返回 null；pnpm 在 version 字段追加的 peer 解析后缀 (...)(...) 会先剥掉。
const resolveLockFileSpec = (rawValue, baseDir) => {
  let value = String(rawValue).trim();
  if (value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"')))) {
    value = value.slice(1, -1);
  }
  if (!value.startsWith("file:")) return null;
  value = value.slice("file:".length).replace(/(\([^()]*\))+$/, "");
  const candidates = [value];
  try {
    const decoded = decodeURIComponent(value);
    if (decoded !== value) candidates.push(decoded);
  } catch (error) {
    // 非法百分号转义：保留原始候选即可
  }
  return candidates.map((candidate) => norm(path.resolve(baseDir, candidate)));
};

// 1) profile package.json 登记的依赖必须指向本轮 tgz（file: 规范化后比较）。
const profileManifestPath = path.join(profileDir, "package.json");
const manifest = JSON.parse(fs.readFileSync(profileManifestPath, "utf8"));
const spec = manifest.dependencies ? manifest.dependencies[pkgName] : undefined;
console.log("dependencies[" + pkgName + "] = " + spec);
if (!spec) {
  fail("profile package.json 未登记依赖 " + pkgName);
} else {
  const expected = norm(tgzPath);
  const resolved = norm(path.resolve(profileDir, String(spec).replace(/^file:/, "")));
  console.log("resolved spec = " + resolved);
  if (resolved !== expected) {
    fail("依赖 spec 未指向本轮 tgz：登记=" + resolved + " 期望=" + expected);
  } else {
    console.log("SPEC_OK");
  }
}

// 2) bundles 必须包含且仅包含一次插件名。
const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
const bundleHits = bundles.filter((b) => b === pkgName).length;
console.log("bundles hits = " + bundleHits + " / total " + bundles.length);
if (bundleHits !== 1) {
  fail("dsh.profile.bundles 中 " + pkgName + " 出现 " + bundleHits + " 次（期望恰好 1 次）");
}

// 3) 安装目标必须是 desktop profile 内的真实目录，不能是外部软链。
//    containment 判据：realpath(安装目标) 必须落在 realpath(profileDir) 之内（两侧都 canonicalize）。
//    这样既不会因为 DSH_HOME 是符号链接而把合法安装误判成越界，也仍然拒绝真实落在 profile 之外的目标。
const degDir = path.join(profileDir, "node_modules", pkgName);
if (!fs.existsSync(degDir)) {
  fail("安装目标不存在：" + degDir);
} else {
  const lst = fs.lstatSync(degDir);
  // containment 的两侧都必须先做 realpath 归一：DSH_HOME 允许是符号链接（用户有权把 home 放到别的盘），
  // 此时 canonical 的安装目录与 lexical 的 profileDir 文本不同源，直接比较会把合法安装误判成越界。
  // 任一侧 canonicalize 失败都记 fail（绝不退回 lexical 比较），由末尾统一按 fail closed 中止。
  const real = realpathOrFail(degDir, "安装目标");
  const realProfileDir = realpathOrFail(profileDir, "desktop profile 目录");
  console.log("installed realpath = " + real);
  console.log("profile realpath = " + realProfileDir);
  console.log("isSymbolicLink = " + lst.isSymbolicLink());
  if (lst.isSymbolicLink()) { fail("安装目标是符号链接（期望真实目录）：" + degDir); }
  if (real !== null && realProfileDir !== null && !inside(real, realProfileDir)) { fail("安装目标真实路径落在 profile 之外：" + real + "（profile 真实路径 " + realProfileDir + "）"); }

  // 4) 插件名/版本。
  const installedManifest = JSON.parse(fs.readFileSync(path.join(degDir, "package.json"), "utf8"));
  console.log("installed package = " + installedManifest.name + "@" + installedManifest.version);
  const base = path.join(packDir, "unpacked", "package");
  const candidateManifest = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8"));
  if (installedManifest.name !== pkgName) { fail("安装目录 package name 不是 " + pkgName + "：" + installedManifest.name); }
  if (installedManifest.version !== candidateManifest.version) {
    fail("安装目录版本 " + installedManifest.version + " 与候选包 " + candidateManifest.version + " 不一致");
  } else {
    console.log("VERSION_OK " + installedManifest.version);
  }

  // 5) 发布面双向比对：路径集合 + 逐文件 SHA256（包 -> 安装目录，安装目录 -> 包）。
  const walk = (root, cur, out) => {
    for (const e of fs.readdirSync(path.join(root, cur), { withFileTypes: true })) {
      const rel = cur ? cur + "/" + e.name : e.name;
      if (e.isDirectory()) walk(root, rel, out);
      else if (e.isFile()) out.push(rel);
      else fail("不支持的文件类型：" + path.join(root, rel));
    }
    return out;
  };
  const refs = walk(base, "", []).sort();
  const got = walk(degDir, "", []).sort();
  const refSet = new Set(refs);
  const gotSet = new Set(got);
  const missing = refs.filter((r) => !gotSet.has(r));
  const extra = got.filter((r) => !refSet.has(r));
  const mismatch = refs.filter((r) => gotSet.has(r) && sha(path.join(base, r)) !== sha(path.join(degDir, r)));
  console.log("release surface: " + (refs.length - missing.length - mismatch.length) + "/" + refs.length + " 与候选 tgz 逐文件一致");
  console.log("双向比对: 包内 " + refs.length + " / 安装目录 " + got.length + " / missing " + missing.length + " / extra " + extra.length + " / mismatch " + mismatch.length);
  if (missing.length) { fail("安装目录缺少发布面文件：" + JSON.stringify(missing.slice(0, 20))); }
  if (extra.length) { fail("安装目录多出发布面之外的文件：" + JSON.stringify(extra.slice(0, 20))); }
  if (mismatch.length) { fail("发布面 SHA256 不一致：" + JSON.stringify(mismatch.slice(0, 20))); }
}

// 6) pnpm-lock.yaml：必须精确落在 desktop profile 根 importer（"."）的 dependencies 下，
//    且 specifier 与 version 两个字段都指向本轮 tgz。
//    刻意不做「整份 lock 文本包含该路径」的模糊判据——别处出现同一路径不能算通过。
const lockPath = path.join(profileDir, "pnpm-lock.yaml");
if (!fs.existsSync(lockPath)) {
  fail("缺少 pnpm-lock.yaml：" + lockPath);
} else {
  const lockRaw = fs.readFileSync(lockPath, "utf8");
  const lockLookup = readLockImporterDependency(lockRaw, ".", pkgName);
  if (!lockLookup.ok) {
    fail("pnpm-lock.yaml 中无法唯一定位 importers['.'].dependencies." + pkgName + "：" + lockLookup.reason + "（不做全文件模糊匹配，已按 fail closed 处理）");
  } else {
    const lockEntry = lockLookup.fields;
    const expectedLockTarget = norm(tgzPath);
    for (const field of ["specifier", "version"]) {
      const rawField = lockEntry[field];
      if (rawField === undefined) {
        fail("pnpm-lock.yaml 的 " + pkgName + " 条目缺少 " + field + " 字段");
        continue;
      }
      console.log("lock " + field + " = " + rawField);
      const candidates = resolveLockFileSpec(rawField, profileDir);
      if (candidates === null) {
        fail("pnpm-lock.yaml 的 " + pkgName + "." + field + " 不是 file: 引用：" + rawField);
        continue;
      }
      console.log("lock " + field + " resolved = " + candidates.join(" | "));
      if (!candidates.includes(expectedLockTarget)) {
        fail("pnpm-lock.yaml 的 " + pkgName + "." + field + " 未指向本轮 tgz：解析=" + candidates.join(" | ") + " 期望=" + expectedLockTarget);
        continue;
      }
      console.log("LOCK_" + field.toUpperCase() + "_OK");
    }
  }
}

if (problems.length) {
  console.log("VERIFY_PROBLEMS " + problems.length);
  for (const p of problems) { console.log("  - " + p); }
  process.exit(1);
}
console.log("VERIFY_OK");
'@
$verifyScriptPath = Join-Path $backupDir "verify-install.mjs"
Write-TextFileNoBom -Path $verifyScriptPath -Content $verifyScript
$verifyExit = Invoke-NativeCommand -Executable "node" -Arguments @($verifyScriptPath, $profileDir, $packDir, $packageName, $tgzPath) -LogPath (Join-Path $logDir "verify-install.log")
if ($verifyExit -ne 0) {
  Stop-Install -Reason ("安装后校验未通过（退出码 " + $verifyExit + "）：详见 " + (Join-Path $logDir "verify-install.log") + "；安装可能已部分修改 profile，请人工核对，不要 --force 或反复重试。")
}
Write-Stage -Message "发布面与安装目录双向比对通过" -Color Green

# 10.2 用户配置必须逐字节不变（cordis.yml / cordis.patch.yml / pnpm-workspace.yaml）。
foreach ($name in $userConfigFiles) {
  $filePath = Join-Path $profileDir $name
  $beforeRow = $null
  foreach ($row in $mgmtRows) {
    if ($row.StartsWith($name + "`t")) { $beforeRow = $row; break }
  }
  if ($null -eq $beforeRow) { Stop-Install -Reason ("备份清单缺少 " + $name + " 的记录，无法比对") }
  $beforeHash = ""
  $beforeMatch = [regex]::Match($beforeRow, "sha256=([0-9a-fA-F]{64})")
  if ($beforeMatch.Success) { $beforeHash = $beforeMatch.Groups[1].Value.ToLowerInvariant() }
  $existsNow = Test-Path -LiteralPath $filePath -PathType Leaf
  $afterHash = ""
  if ($existsNow) { $afterHash = (Get-FileHash -LiteralPath $filePath -Algorithm SHA256).Hash.ToLowerInvariant() }
  $beforeShort = "(不存在)"
  if ($beforeHash -ne "") { $beforeShort = $beforeHash.Substring(0, 12) }
  $afterShort = "(不存在)"
  if ($afterHash -ne "") { $afterShort = $afterHash.Substring(0, 12) }
  Write-Stage -Message ("  " + $name + "：before=" + $beforeShort + " after=" + $afterShort)
  if ($beforeHash -ne $afterHash) {
    Stop-Install -Reason ("用户配置在安装过程中被改动：" + $name + "（before=" + $beforeHash + " after=" + $afterHash + "）。请人工核对，不要继续覆盖。")
  }
}
Write-Stage -Message "用户配置（cordis.yml / cordis.patch.yml / pnpm-workspace.yaml）逐字节未变" -Color Green

# 10.3 管理文件存在性不得被翻转（安装前存在的必须还在，且不存在的不应凭空出现）。
foreach ($row in $mgmtRows) {
  $name = $row.Split("`t")[0]
  $existedBefore = $row.Contains("exists=true")
  $existsNow = Test-Path -LiteralPath (Join-Path $profileDir $name) -PathType Leaf
  if ($existedBefore -and -not $existsNow) {
    Stop-Install -Reason ("管理文件在安装后消失：" + $name)
  }
  if (-not $existedBefore -and $existsNow) {
    Write-Stage -Message ("  提示：安装前不存在的管理文件 " + $name + " 现在已存在（多为 CLI 正常补写）") -Color Yellow
  }
}

# 10.4 依赖树规模：文件数必须与安装前一致（pnpm 打印的 +N -M 只是条目重组）。
if ($backupTreeSourceFiles -gt 0) {
  $currentTreeFiles = @(Get-ChildItem -LiteralPath $profileNodeModules -Recurse -File -Force).Count
  Write-Stage -Message ("  依赖树文件数：安装前 " + $backupTreeSourceFiles + " -> 现在 " + $currentTreeFiles)
  if ($currentTreeFiles -ne $backupTreeSourceFiles) {
    Write-Stage -Message "  警告：依赖树文件数与安装前不一致（可能包含正常的条目重组，请人工确认）" -Color Yellow
  }
} else {
  Write-Stage -Message "  安装前无依赖树备份，跳过文件数比对" -Color Yellow
}

# 10.5 插件集合比对（安装前 vs 安装后）——解析不完整一律 fail closed，不再静默跳过。
# 真实 CLI（dsh plugin --profile desktop list）输出的是 pnpm 树形列表。
# 下面是「只展示 3 条条目」的精简样例，因此汇总行写 3 packages——示例里的条目数与汇总行必须自洽：
#   Legend: production dependency, optional only, dev only
#
#   dsh-profile-web C:\Users\...\.dsh\profiles\desktop (PRIVATE)
#   │
#   │   dependencies:
#   ├── @deepseek-ai/dsh-browser-use@0.2.0-rc.2
#   ├── dsh-expert-group@0.1.1
#   └── dshmarket@1.66.11
#
#   3 packages
# 注意：真实 CLI 输出里可能有嵌套条目（多级树线），必须完整保留，不能只取顶层；
# 解析出的条目数必须与末尾 'N packages' 汇总行完全相等，否则一律中止（下面有强校验）。
# 旧实现只认行首的 '-' / '*'，会把真实列表解析成空集后「跳过比对」——那等于没有校验。
# 这里改为识别真实树线（├── / └──，含嵌套前缀）、拆出 name@version，并与末尾 'N packages' 汇总行对齐。
# 版本 token 的 name/version 切分规则：npm 包名边界之后第一个 '@' 才是版本分隔符，
# 即 token.IndexOf('@', 1)——scoped 包名开头的 '@'（下标 0）被跳过，
# 而 peer 后缀里出现的 '/'（如 foo@1.0.0(@scope/bar@2.0.0)）不会被误当成包名边界。
# 拆出的包名与版本还要做形状校验（合理 npm 包名 + 合法 semver，允许 pnpm 的 peer 解析后缀），
# 任何解析异常一律中止（fail closed），绝不放行到集合比对。
function Get-PluginListSnapshot {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Label
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Stop-Install -Reason ("插件列表文件不存在：" + $Path + "（" + $Label + "）")
  }
  $entryPattern = '^\s*[│|─\s]*(?:[├└]──|[+|`]--)\s+(?<entry>\S.*?)\s*$'
  $footerPattern = '^\s*(?<count>\d+)\s+packages?\s*$'

  $names = @()
  $versions = @{}
  $footerCount = -1
  foreach ($line in @(Get-Content -LiteralPath $Path -Encoding UTF8)) {
    $footerMatch = [regex]::Match($line, $footerPattern)
    if ($footerMatch.Success) {
      if ($footerCount -ge 0) {
        Stop-Install -Reason ("插件列表出现多个 'N packages' 汇总行（" + $Label + "）：" + $Path)
      }
      $footerCount = [int]$footerMatch.Groups["count"].Value
      continue
    }
    $entryMatch = [regex]::Match($line, $entryPattern)
    if (-not $entryMatch.Success) { continue }
    $token = $entryMatch.Groups["entry"].Value.Trim()
    # name/version 分隔符 = npm 包名边界之后的第一个 '@'。
    # 从下标 1 开始找：下标 0 的 '@' 只可能是 scoped 包名的 scope 前缀（@scope/pkg@1.0.0），必须保留。
    # 刻意不用「最后一个 '/' 之后找 '@'」：pnpm 的 peer 解析后缀里会带 scoped 包名，
    # 例如 foo@1.0.0(@scope/bar@2.0.0)，最后一个 '/' 落在 peer 后缀内部，
    # 会把包名切成 'foo@1.0.0(@scope' 这种垃圾串，导致合法条目被误判成解析失败。
    # 切出来的 name / version 仍然要过 Test-PluginNameToken / Test-PluginVersionToken 完整校验，
    # 因此这里放宽定位规则不会放过任何 malformed token。
    $separatorIndex = $token.IndexOf("@", 1)
    if ($separatorIndex -le 0 -or $separatorIndex -ge ($token.Length - 1)) {
      Stop-Install -Reason ("插件列表条目缺少 name@version 分隔符（" + $Label + "）：'" + $token + "'")
    }
    $entryName = $token.Substring(0, $separatorIndex)
    $entryVersion = $token.Substring($separatorIndex + 1)
    if ([string]::IsNullOrWhiteSpace($entryName) -or [string]::IsNullOrWhiteSpace($entryVersion)) {
      Stop-Install -Reason ("插件列表条目无法拆出包名与版本（" + $Label + "）：'" + $token + "'")
    }
    # 形状校验：包名必须是合理 npm 包名，版本必须是「合法 semver + 可选 peer 后缀」。
    # 解析出奇怪 token 时一律中止，而不是拿它去和安装前集合比对——那会把「列表格式变了」
    # 误判成「插件集合变了/没变」，两种误判都可能让门禁失效。
    if (-not (Test-PluginNameToken -Name $entryName)) {
      Stop-Install -Reason ("插件列表条目的包名不是合理 npm 包名（" + $Label + "）：'" + $entryName + "'（原始条目：'" + $token + "'）")
    }
    if (-not (Test-PluginVersionToken -Version $entryVersion)) {
      Stop-Install -Reason ("插件列表条目的版本不是合法 semver（" + $Label + "）：'" + $entryVersion + "'（原始条目：'" + $token + "'）")
    }
    if ($versions.ContainsKey($entryName)) {
      Stop-Install -Reason ("插件列表出现重复包名（" + $Label + "）：" + $entryName)
    }
    $versions[$entryName] = $entryVersion
    $names += $entryName
  }

  if ($footerCount -lt 0) {
    Stop-Install -Reason ("插件列表缺少 'N packages' 汇总行，无法确认解析完整（" + $Label + "）：" + $Path)
  }
  if ($names.Count -eq 0) {
    Stop-Install -Reason ("插件列表未解析出任何条目（" + $Label + "）：" + $Path)
  }
  if ($names.Count -ne $footerCount) {
    Stop-Install -Reason ("插件列表解析条目数（" + $names.Count + "）与汇总行 'N packages'（" + $footerCount + "）不一致（" + $Label + "）：" + $Path)
  }

  return @{ Names = $names; Versions = $versions; FooterCount = $footerCount }
}

# npm 包名形状：单段名或 scope/名，两段都必须是「字母数字开头 + 字母数字 . _ -」。
# 真实 CLI 列表里出现的都是合法 npm 包名（含 @deepseek-ai/dsh-browser-use 这类 scoped 包）。
# 这里刻意用锚定的字符类而不是 \S 之类的宽松匹配：任何带空格、路径分隔符、非法字符的 token
# 都会被判为非法，避免把「解析跑偏后的垃圾串」当成合法包名继续比对。
$script:PluginNameSegmentPattern = '^[A-Za-z0-9][A-Za-z0-9._-]*$'
# semver 形状（允许 pre-release / build metadata）。
$script:SemverPattern = '^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<prerelease>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+(?<build>[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$'

# 校验插件列表条目里的包名是否为合理 npm 包名。
function Test-PluginNameToken {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Name)
  if ([string]::IsNullOrWhiteSpace($Name)) { return $false }
  $segments = @()
  if ($Name.StartsWith("@")) {
    $rest = $Name.Substring(1)
    $slashIndex = $rest.IndexOf("/")
    if ($slashIndex -lt 0) { return $false }
    $segments = @($rest.Substring(0, $slashIndex), $rest.Substring($slashIndex + 1))
  } else {
    $segments = @($Name)
  }
  foreach ($segment in $segments) {
    if ([string]::IsNullOrWhiteSpace($segment)) { return $false }
    if (-not [regex]::IsMatch($segment, $script:PluginNameSegmentPattern)) { return $false }
  }
  return $true
}

# 去掉 pnpm 可能附加的 peer 解析后缀 "(...)(...)"。
# 关键点：不是「无条件剥离」，而是「剥离后剩下的部分必须正好是一个合法 semver」；
# 例如 '1.2' 的结尾不是括号，剥离后仍是 '1.2'，过不了 semver 校验，因此照旧被拒。
# 这样既保留真实树里的 '1.66.11'、'0.2.0-rc.2'、'1.0.0(react@18.0.0)' 形式，
# 又不会因为「后缀剥离」把非法 token 洗成合法 token。
function Get-BaseVersionToken {
  param([Parameter(Mandatory = $true)][string]$Version)
  return ($Version -replace "(\([^()]*\))+$", "")
}

# 校验版本 token 是否为「合法 semver + 可选的 peer 解析后缀」。
function Test-PluginVersionToken {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Version)
  if ([string]::IsNullOrWhiteSpace($Version)) { return $false }
  if ($Version -ne $Version.Trim()) { return $false }
  $base = Get-BaseVersionToken -Version $Version
  if ([string]::IsNullOrWhiteSpace($base)) { return $false }
  if (-not [regex]::IsMatch($base, $script:SemverPattern)) { return $false }
  # 剩余部分必须是零个或多个成对括号的 peer 后缀，不允许出现别的尾巴（如 ':10'、'.bak'）。
  $remainder = $Version.Substring($base.Length)
  if ($remainder.Length -eq 0) { return $true }
  return [regex]::IsMatch($remainder, '^(\([^()]*\))+$')
}

$beforeSnapshot = Get-PluginListSnapshot -Path $listBeforePath -Label "安装前 plugin list"
$afterSnapshot = Get-PluginListSnapshot -Path $listAfterPath -Label "安装后 plugin list"
Write-Stage -Message ("  插件列表解析：安装前 " + $beforeSnapshot.FooterCount + " 个包 / 安装后 " + $afterSnapshot.FooterCount + " 个包（均与 'N packages' 汇总行一致）")

# 目标插件必须出现，且版本等于本轮 package.json 里的版本。
if (-not $afterSnapshot.Versions.ContainsKey($packageName)) {
  Stop-Install -Reason ("安装后 plugin list 中找不到目标插件 " + $packageName + "，已中止。")
}
$installedVersionToken = [string]$afterSnapshot.Versions[$packageName]
$installedBaseVersion = Get-BaseVersionToken -Version $installedVersionToken
if ($installedBaseVersion -ne $packageVersion) {
  Stop-Install -Reason ("安装后 plugin list 中 " + $packageName + " 的版本是 '" + $installedVersionToken + "'（解析为 " + $installedBaseVersion + "），期望本轮版本 " + $packageVersion + "，已中止。")
}
Write-Stage -Message ("  目标插件版本核对通过：" + $packageName + "@" + $installedVersionToken)

# 除目标插件外，其余「包名 -> 版本」集合必须与安装前精确一致；消失、版本变化、异常新增一律中止。
$pluginSetProblems = @()
foreach ($name in $beforeSnapshot.Names) {
  if ($name -eq $packageName) { continue }
  $beforeVersion = [string]$beforeSnapshot.Versions[$name]
  if (-not $afterSnapshot.Versions.ContainsKey($name)) {
    $pluginSetProblems += ("消失：" + $name + "@" + $beforeVersion)
    continue
  }
  $afterVersion = [string]$afterSnapshot.Versions[$name]
  if ($beforeVersion -cne $afterVersion) {
    $pluginSetProblems += ("版本变化：" + $name + " " + $beforeVersion + " -> " + $afterVersion)
  }
}
foreach ($name in $afterSnapshot.Names) {
  if ($name -eq $packageName) { continue }
  if (-not $beforeSnapshot.Versions.ContainsKey($name)) {
    $pluginSetProblems += ("异常新增：" + $name + "@" + [string]$afterSnapshot.Versions[$name])
  }
}
if ($pluginSetProblems.Count -gt 0) {
  Stop-Install -Reason ("安装前后其它插件集合不一致（" + $pluginSetProblems.Count + " 项），已中止：" + "`n" + "    " + ($pluginSetProblems -join ("`n" + "    ")))
}
$otherPluginCount = 0
foreach ($name in $afterSnapshot.Names) { if ($name -ne $packageName) { $otherPluginCount++ } }
Write-Stage -Message ("  其它 " + $otherPluginCount + " 个插件的包名与版本与安装前精确一致") -Color Green

# ── 11. 收尾 ─────────────────────────────────────────────────────────────────────

Write-Stage -Message "安装与校验全部通过" -Color Green
Write-Host ""
Write-Host "安装完成。产物与日志：" -ForegroundColor Green
Write-Host ("  包目录    : " + $packDir)
Write-Host ("  tgz       : " + $tgzPath)
Write-Host ("  tgz sha256: " + $tgzHash)
Write-Host ("  备份目录  : " + $backupDir)
Write-Host ("  日志目录  : " + $logDir)
Write-Host ""
Write-Host "请自行完全退出并重启桌面版（含托盘常驻进程）后生效；本脚本不会自动重启。" -ForegroundColor Yellow
Write-Host "重启后确认：设置页出现 dsh-expert-group；新会话工具面出现角色短名 explorer/librarian/oracle/designer/fixer。" -ForegroundColor Yellow

exit 0
