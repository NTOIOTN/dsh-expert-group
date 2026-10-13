# 桌面版专用卸载器（profile 固定为 desktop）。
#
# 用法（仓库根直接执行，不需要任何额外参数）：
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\desktop-uninstall.ps1
#   pwsh -NoProfile -ExecutionPolicy Bypass -File .\desktop-uninstall.ps1 -DshInstallDirectory 'D:\deepseek-harness'
#
# 与 desktop-install.ps1 的职责严格互补：安装走应用自带 CLI 的 plugin add，卸载就走同一个
# 自带 CLI 的 plugin remove。参数与解析顺序（-DshInstallDirectory -> $env:DSH_INSTALL_DIR ->
# D:\deepseek-harness）与 desktop-install.ps1 完全一致，两个脚本可以互相接续使用。
#
# 硬边界（有意为之，勿放宽）：
#   - 只认 <appRoot>\resources\runtime\cli\bin\dsh.cmd 这个绝对路径，绝不回退到 PATH 上的
#     全局 dsh：全局 dsh 拒绝对 desktop profile 执行 plugin，会报
#     'profile "desktop" is managed exclusively by the Electron application'。
#   - 只通过自带 CLI 移除依赖；绝不手工改写 profile 里的 package.json / pnpm-lock.yaml /
#     pnpm-workspace.yaml / cordis.yml / cordis.patch.yml 等任何文件。
#   - 不删除 profile 的任何用户配置与共享材料：cordis.yml、cordis.patch.yml、
#     pnpm-workspace.yaml、其它 manifest 与 lock、.plugin-manager 日志、
#     plugin-releases\dsh-expert-group\pack-* 与 cli-install-* 回滚材料、
#     storages\dsh_expert_group.json、其它插件与共享依赖，全部原样保留。
#   - DSH_HOME 必须是**完全限定**的绝对路径（盘符绝对 C:\... / C:/...，或 UNC 绝对
#     \\server\share\...）。相对路径（foo、.\foo）会随调用时的当前目录漂移；盘符相对
#     （C:foo）与当前盘根相对（\foo）同样依赖进程状态。基于它们做出的「这个目录属于本 profile」
#     判断全部失去意义，而删除不可逆，因此一律直接拒绝而不是补全。
#     注意不能用 [System.IO.Path]::IsPathRooted 判定：它在 Windows 上把 C:foo 与 \foo 也判为
#     true；也不能用 IsPathFullyQualified（Windows PowerShell 5.1 的 .NET Framework 上没有
#     这个 API）。判据见 Test-FullyQualifiedPath。
#   - **DSH_HOME 本身允许是用户配置的 junction / symlink**（用户有权把 home 放到别的盘），
#     与 desktop-install.ps1 的 Resolve-RealDirectoryPath / Assert-ProfilePathIsolation 判据一致：
#     home 一级的 reparse point 只解析、不拒绝。脚本先把 home 解析成真实目录，之后所有
#     profile 路径都从真实 home 出发构造。
#   - 解析完成后，profiles 与 profiles\desktop 这两级必须是**真实非 reparse 目录**：这两级被
#     换成链接时，自带 CLI 会对着 DSH_HOME 之外的 profile 执行 remove，递归删除也会穿透链接
#     删掉无关内容，因此一律 fail closed 中止。
#   - 读取 profile 清单与调用 remove CLI 之前，各做一次逐级 reparse point 检查；调用 CLI 之前
#     那次把检查与写操作之间的时间窗口压到最小。检查从**真实 home** 开始，因此 home 自身的
#     链接不再被误判，而 profiles / profile 层的链接仍被拒绝。
#   - 唯一的文件系统删除动作是清理「插件自身」的残留目录
#     profiles\desktop\node_modules\dsh-expert-group。删之前逐级检查「盘符根 -> 目标」上每一个
#     现存路径组件，任一为 reparse point（符号链接 / junction / 挂载点）就拒绝删除。同时断言
#     删除目标的规范化路径与「由 DSH_HOME 逐级拼出来的插件自身目录」严格相等，不接受字符串
#     前缀这类弱判断。只检查现存组件；读不到属性（权限不足 / 链接损坏）一律 fail closed。
#   - 不自动重启桌面版：最后一步由用户完成。
#
# 幂等语义（三态，必须区分）：
#   1) dependencies 与 dsh.profile.bundles 都没有本插件、且插件目录也不存在 -> 成功跳过，不调 CLI；
#   2) dependencies 里没有、但 dsh.profile.bundles 仍登记 -> profile 不一致，fail closed（不假装成功）；
#   3) dependencies 与 bundles 都已清除、只剩插件自身残留目录 -> 只清理该目录后成功返回。
#   已登记（dependencies 里有）时：CLI remove -> 复核 dependencies 与 bundles -> 再删残留目录。
#
# 兼容性：语法保持 Windows PowerShell 5.1 可用（不使用 ?? / ?. / 三元运算），
# 文件为 UTF-8 BOM + LF 行尾（与 desktop-install.ps1 / web-install.ps1 一致，
# WinPS 5.1 靠 BOM 才能正确读中文注释与中文提示）。
#
# 提示：卸载不删除 profiles\desktop\storages\dsh_expert_group.json 等运行期数据；
# 需要彻底清理时请自行确认后再手工处理，本脚本不做这件事。

param(
  # DSH 应用安装根目录：其下应有 resources\runtime\cli\bin\dsh.cmd。
  # 缺省取 $env:DSH_INSTALL_DIR，再退回 D:\deepseek-harness。
  [string]$DshInstallDirectory = ""
)

$ErrorActionPreference = "Stop"

# ── 0a. 仓库与应用根目录：全部基于 $PSScriptRoot，不依赖调用时的当前目录 ───────────

# $PSScriptRoot 在 pwsh 7 与 Windows PowerShell 5.1 下都可用；保留 MyInvocation 兜底。
$repoRoot = $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  $repoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
}
if ([string]::IsNullOrWhiteSpace($repoRoot)) {
  throw "无法定位脚本所在目录（PSScriptRoot 为空）。请用 -File 方式执行本脚本。"
}

# 应用根目录：参数优先，其次环境变量，最后退回本机默认安装位置（与 desktop-install.ps1 一致）。
$appRoot = $DshInstallDirectory
if ([string]::IsNullOrWhiteSpace($appRoot)) { $appRoot = $env:DSH_INSTALL_DIR }
if ([string]::IsNullOrWhiteSpace($appRoot)) { $appRoot = "D:\deepseek-harness" }
$appRoot = [System.IO.Path]::GetFullPath($appRoot)
# 自带 CLI：只认这个绝对路径，绝不回退到 PATH 上的全局 dsh。
$cli = Join-Path $appRoot "resources\runtime\cli\bin\dsh.cmd"

# DSH_HOME 与 profile 路径在路径安全工具（下面一节）定义之后再解析：它们的校验要用到
# Test-FullyQualifiedPath，而 PowerShell 按自上而下的顺序执行，函数必须先定义后调用。

# ── 0b. 路径安全工具（全部 fail closed） ───────────────────────────────────────

# 把路径规范成「用于相等比较的规范形式」：分隔符统一成 '\'、去掉尾部斜杠（根除外）、
# 大小写折叠。判不出结论（空路径、取不到路径根）时返回 $null，由调用方按 fail closed 处理。
function ConvertTo-ComparablePath {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $normalized = $Path.Replace([char]47, [char]92)
  $root = ""
  try {
    $root = [System.IO.Path]::GetPathRoot($normalized)
  } catch {
    return $null
  }
  if ([string]::IsNullOrEmpty($root)) { return $null }
  if ($normalized.Length -gt $root.Length) { $normalized = $normalized.TrimEnd([char]92) }
  if ([string]::IsNullOrEmpty($normalized)) { return $null }
  return $normalized.ToLowerInvariant()
}

# 把绝对路径规范成「目录规范形式」：分隔符由 GetFullPath 归一、去掉无意义的**尾部分隔符**，
# 但**保留大小写**（调用方要用它去访问真实文件系统，也要把它交给外部 CLI）。
# 为什么需要与 ConvertTo-ComparablePath 分开：后者是「用于相等比较」的形式（大小写折叠），
# 拿它去拼路径会把 DSH_HOME 变成全小写再交给自带 CLI；这里只做形态归一，不动大小写。
# 为什么必须去掉尾分隔符：同一目录的 "C:\a\b" 与 "C:\a\b\" 是同一个目录，保留尾分隔符会让
# 后续的「逐级拼回 == 规范化结果」自检在完全合法的路径上失败（fail closed 方向的误伤）。
# 根必须保持为根：GetPathRoot("C:\") 是 "C:\"，其长度等于路径长度，因此不会被 TrimEnd 成 "C:"——
# 一旦退化成 "C:"，它就变成「盘符相对」写法，语义完全变了（那正是本脚本要拒绝的东西）。
function ConvertTo-CanonicalDirectoryPath {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $null }
  $full = ""
  try {
    $full = [System.IO.Path]::GetFullPath($Path)
  } catch {
    return $null
  }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root)) { return $null }
  # 仅当路径确实比根长（即根之下还有内容）时才允许裁剪尾分隔符；根自身原样保留。
  if ($full.Length -gt $root.Length) { $full = $full.TrimEnd([char]92, [char]47) }
  if ([string]::IsNullOrEmpty($full)) { return $null }
  return $full
}

# 判断路径是否为**完全限定**的绝对路径：盘符绝对（C:\... 或 C:/...，含盘符根 C:\）
# 或 UNC 绝对（\\server\share\...，服务器名与共享名都必须存在）。
# 为什么不能用 [System.IO.Path]::IsPathRooted：它在 Windows 上把 C:foo（盘符相对）与
# \foo（当前盘根相对）也判为 true，这两者仍依赖进程的当前目录 / 当前盘，基于它们做的
# 「这个目录属于本 profile」判断会随调用环境漂移；而删除不可逆，必须排除。
# 为什么不用 [System.IO.Path]::IsPathFullyQualified：那是 .NET Core 2.1 / .NET Standard 2.1
# 才有的 API，Windows PowerShell 5.1（.NET Framework 4.x）上不存在，脚本要兼容两个宿主
# （本机实测 WinPS 5.1 上 HasIsPathFullyQualified=False）。
# 判据用 GetPathRoot 的返回值形态（两个宿主实测一致）：
#   "C:\foo"             -> "C:\"              盘符根（长度 3、以 '\' 结尾）          -> 接受
#   "C:/foo"             -> "C:\"              同上（GetPathRoot 已把分隔符归一）     -> 接受
#   "C:\"                -> "C:\"              盘符根本身                              -> 接受
#   "\\server\share\x"   -> "\\server\share"   UNC 根（\\ + 服务器名 + \ + 共享名）    -> 接受
#   "\\server\share"     -> "\\server\share"   共享根本身                              -> 接受
#   "C:foo"              -> "C:"               以 ':' 结尾                              -> 拒绝（盘符相对）
#   "\foo" / "/foo"      -> "\"                长度为 1                                -> 拒绝（当前盘根相对）
#   "foo" / ".\foo"      -> ""                 空                                      -> 拒绝（相对）
#   "\\server"           -> "\\server"         以 '\\' 开头但不是「\\ + 服务器名 + \ + 共享名」
#                                              （缺共享名）                            -> 拒绝（不完整 UNC）
# 路径中的空格不参与判定，天然支持（例如 "F:\01 AI\dsh-home"）。
function Test-FullyQualifiedPath {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
  $root = ""
  try {
    $root = [System.IO.Path]::GetPathRoot($Path)
  } catch {
    return $false
  }
  if ([string]::IsNullOrEmpty($root)) { return $false }
  $separator = [string][char]92
  # 长度为 1 的根只可能是 "\" 或 "/"：当前盘根相对。
  if ($root.Length -eq 1) { return $false }
  # 以 ':' 结尾的根是 "C:" 这种盘符相对写法（"C:\" 不会以 ':' 结尾）。
  if ($root.EndsWith(":")) { return $false }
  # UNC 形态的根（以 "\\" 开头）必须同时具备**非空**的服务器名与共享名：
  # GetPathRoot 对不完整写法 "\\server" 与 "\\server\" 分别返回 "\\server" 与 "\\server\"，
  # 前者缺共享名、后者共享名为空，都依赖当前环境的重定向解析（目标甚至可能根本不存在），必须拒绝。
  # 完整写法返回 "\\server\share"（尾部斜杠会被 GetPathRoot 去掉），去掉前导 "\\" 后
  # 形如 "server\share"：分隔符必须出现在中间，既不能在开头（服务器名为空）也不能在结尾（共享名为空）。
  if ($root.StartsWith($separator + $separator, [System.StringComparison]::Ordinal)) {
    $tail = $root.Substring(2)
    $shareIndex = $tail.IndexOf([char]92)
    if ($shareIndex -lt 1 -or $shareIndex -ge ($tail.Length - 1)) { return $false }
  }
  return $true
}

# 把路径拆成「盘符根 / UNC 根 + 逐级目录组件」的候选列表，顺序由浅到深。
# 为什么不用字符串 Substring 手工切分：含空格、正/反斜杠混用、根自身带尾分隔符的路径容易切错，
# 而这里每一级的判定都决定「要不要拒绝一次删除」，切错就是安全漏洞。
# 因此改为用 GetPathRoot 取根、对剩余部分按分隔符切段后用 Combine 逐级拼回，
# 最后校验拼回结果与 GetFullPath 的结果一致（不一致一律抛错，绝不带着可疑路径继续）。
function Get-PathComponentList {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Path)
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw "无法解析路径组件：路径为空，安全检查无法进行，已中止。"
  }
  # 用规范形式（去掉无意义尾分隔符、保留大小写）作为唯一基准：带尾分隔符的合法目录
  # （例如用户把 DSH_HOME 写成 "D:\dsh-home\"）在旧实现里会因为「拼回结果没有尾分隔符」
  # 而被判为「组件切分不可信」直接中止，那是对完全合法输入的误拒。
  $full = ConvertTo-CanonicalDirectoryPath -Path $Path
  if ([string]::IsNullOrEmpty($full)) {
    throw ("无法规范化路径：" + $Path + "，安全检查无法进行，已中止。")
  }
  $root = [System.IO.Path]::GetPathRoot($full)
  if ([string]::IsNullOrEmpty($root)) {
    throw ("无法确定路径根：" + $Path + "，安全检查无法进行，已中止。")
  }
  $list = New-Object 'System.Collections.Generic.List[string]'
  # 根自身也要查：挂载点卷（volume mount point）就是根一级的 reparse point。
  $list.Add($root)
  $prefix = $root
  $rest = $full.Substring($root.Length)
  foreach ($segment in @($rest.Split([char[]]@(92, 47), [System.StringSplitOptions]::RemoveEmptyEntries))) {
    $prefix = [System.IO.Path]::Combine($prefix, $segment)
    $list.Add($prefix)
  }
  # 逐级拼回必须与规范形式一致，否则说明切分逻辑对这条路径不成立，宁可不删。
  # 两侧都过 ConvertTo-ComparablePath（分隔符统一、去掉尾分隔符、大小写折叠）后再比较：
  # 拼回结果天然不带尾分隔符，若直接与规范形式做大小写敏感比较，任何带尾分隔符的合法输入
  # 都会被判为不一致；比较本身只关心「是不是同一串组件」，用同一比较形式即可消除这种无意义差异。
  $rebuilt = $list[$list.Count - 1]
  $rebuiltKey = ConvertTo-ComparablePath -Path $rebuilt
  $fullKey = ConvertTo-ComparablePath -Path $full
  if ($null -eq $rebuiltKey -or $null -eq $fullKey -or -not ($rebuiltKey -ceq $fullKey)) {
    throw ("无法解析路径组件：" + $Path + "（逐级拼回得到 " + $rebuilt + "，与规范形式 " + $full + " 不一致）。`n" + "    组件切分不可信时无法保证每一级都被检查，已按 fail closed 中止。")
  }
  return $list
}

# 读取一个「可能不存在」的文件系统项。
# 只把明确的 ItemNotFound 当作「不存在」；权限不足、损坏链接等一律抛错中止——
# 用 Test-Path 判断存在性会把「读不出来」误报成「不存在」，从而整段跳过安全检查（fail open）。
function Get-OptionalFileSystemItem {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  if ([string]::IsNullOrWhiteSpace($Path)) {
    throw ("无法读取文件系统项（" + $Purpose + "）：路径为空。安全检查需要读取它是否存在与是否为链接，读不到就无法判定，已按 fail closed 中止。")
  }
  try {
    return (Get-Item -LiteralPath $Path -Force -ErrorAction Stop)
  } catch {
    $notFound = $false
    if ($null -ne $_.Exception -and $_.Exception -is [System.Management.Automation.ItemNotFoundException]) { $notFound = $true }
    if (-not $notFound -and $null -ne $_.CategoryInfo -and $_.CategoryInfo.Category -eq [System.Management.Automation.ErrorCategory]::ObjectNotFound) { $notFound = $true }
    if ($notFound) { return $null }
    throw ("无法读取文件系统项（" + $Purpose + "）：" + $Path + "（" + [string]$_.Exception.Message + "）。安全检查需要读取它是否存在与是否为链接，读不到就无法判定，已按 fail closed 中止。")
  }
}

# 从盘符根（或 UNC 根）开始逐级向下，返回路径上第一个 reparse point 组件（含最终项本身）；
# 整条路径都不是链接时返回 $null。
# 语义（fail closed）：任何一级读不到对象 / 属性读不出来都抛错中止，绝不返回 $null 假装「不是链接」。
# 为什么必须逐级而不是只看最终项：祖先目录被换成 junction / symlink 时，最终项看起来仍是
# 一个普通目录，而递归删除会穿透链接删掉目标之外的无关内容。
function Get-FirstReparsePointComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  foreach ($candidate in (Get-PathComponentList -Path $Path)) {
    $item = Get-OptionalFileSystemItem -Path $candidate -Purpose $Purpose
    # 只对「确实存在」的组件做链接判定；不存在的组件不可能把删除导向别处。
    if ($null -eq $item) { continue }
    $attributes = $item.Attributes
    if ($null -eq $attributes) {
      throw ("无法读取路径属性：" + $candidate + "（Attributes 为空），无法判定是否为链接，已按 fail closed 中止。")
    }
    if ((([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) {
      return $candidate
    }
  }
  return $null
}

# 逐级检查「盘符根 -> 目标」上每一个现存组件；任一为 reparse point 就抛错拒绝。
function Assert-NoReparsePointOnPath {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $linkPath = Get-FirstReparsePointComponent -Path $Path -Purpose $Purpose
  if ($null -ne $linkPath) {
    throw ("拒绝删除：路径组件 " + $linkPath + " 是符号链接 / junction / 挂载点（reparse point）。`n" + "    递归删除会穿透该链接，可能删掉 profile 之外的无关内容，因此按 fail closed 中止。`n" + "    请确认该链接指向何处后手工处理（本脚本不代劳）。")
  }
}

# 判断路径是否为「已存在的真实目录，且整条路径链上没有 reparse point」。
# 为什么需要它：DSH_HOME 本身允许是链接（已先解析成真实目录），而 profiles 与
# profiles\desktop 这两级**不允许**是链接——它们被换成链接时，CLI remove 会写进 DSH_HOME 之外的
# profile，后续所有校验都会在错误路径上「自洽通过」。
# 三态语义（必须严格区分，否则就是 fail open）：
#   - 返回 $true ：路径存在、可读、是目录，且逐级无 reparse point；
#   - 返回 $false：路径**确实不存在**（仅此一种），由调用方决定「允许缺失」还是报错；
#   - 抛错      ：路径存在但读不出来 / 属性读不出来 / 是链接 / 不是目录。这几种都无法判定
#                 「它是不是被重定向」，一律按 fail closed 中止，绝不返回 $false 蒙混过关。
function Test-RealDirectoryComponent {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $item = Get-OptionalFileSystemItem -Path $Path -Purpose $Purpose
  if ($null -eq $item) { return $false }
  $attributes = $item.Attributes
  if ($null -eq $attributes) {
    throw ("无法读取路径属性（" + $Purpose + "）：" + $Path + "（Attributes 为空），无法判定它是否为链接，已按 fail closed 中止。")
  }
  if (-not $item.PSIsContainer) {
    throw ("路径不是目录（" + $Purpose + "）：" + $Path + "。profile 路径必须是真实目录，实际不是，已按 fail closed 中止。")
  }
  $linkPath = Get-FirstReparsePointComponent -Path $Path -Purpose $Purpose
  if ($null -ne $linkPath) {
    throw ("profile 路径被重定向（" + $Purpose + "）：" + $linkPath + " 是符号链接 / junction / 挂载点（reparse point）。`n" + "    CLI remove 会对着 DSH_HOME 之外的 profile 执行，且删除可能穿透链接，因此按 fail closed 中止。`n" + "    请把 profile 还原成 DSH_HOME 下的真实目录后再重试（DSH_HOME 自身是链接是允许的，已被解析）。")
  }
  return $true
}

# 解析目录的真实物理路径：逐级解析「盘符根 -> 目标目录」路径上的每一个 reparse point
# （符号链接 / junction / 挂载点），返回规范形式（分隔符统一、无尾部斜杠、大小写折叠）。
# 与 desktop-install.ps1 的 Resolve-RealDirectoryPath 同一判据，但保持本脚本自包含。
# 只用于解析 DSH_HOME 自身，不做任何写入。
# 注意：Resolve-Path 在两个 PowerShell 版本下都不会解析 junction / symlink，不能拿它当判据；
# 这里只用 FileSystem provider 的属性位与 Target（PS 5.1 与 pwsh 7 都支持），不引入外部工具。
# fail closed 语义：下列任一情况都抛错中止，绝不返回「未解析完的路径」——
# 拿一个没解析完的路径继续做安全判断，可能把链接指向的目录当成 DSH_HOME（fail open）：
#   1) 路径不存在（含路径链上任何一级不存在），或任一级组件的属性读不出来；
#   2) 是 reparse point 但链接目标为空 / 不可读（拿不到 Target）；
#   3) 链接目标（含相对目标的基准目录）无法规范化；
#   4) 沿链接追下去出现环（同一个规范化目标被再次访问）；
#   5) 沿链接追踪超过上限（恰好 16 跳仍合法，第 17 个链接一律拒绝）。
# 本函数只服务 DSH_HOME：home 必须真实存在（卸载要读它下面的 profile），因此这里
# 「路径不存在」直接抛错，而不是像通用解析器那样放行不存在的尾部组件。
function Resolve-RealDirectoryPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  $maxHops = 16
  $visited = New-Object 'System.Collections.Generic.List[string]'
  $current = ""
  try {
    $current = [System.IO.Path]::GetFullPath($Path)
  } catch {
    throw ("解析真实路径失败：无法规范化 " + $Path + "（" + [string]$_.Exception.Message + "）。`n" + "    规范化失败时无法解析真实路径，已按 fail closed 中止。")
  }
  # 起点也计入「已访问」：链接指回起点同样构成环，必须在第一次回环时就中止。
  $startKey = ConvertTo-ComparablePath -Path $current
  if ($null -eq $startKey) {
    throw ("解析真实路径失败：无法规范化 " + $Path + "，已按 fail closed 中止。")
  }
  $visited.Add($startKey)

  # 跳数语义（必须精确，否则会多拒一条合法链）：
  #   $hopCount = 已成功解析掉的链接数；maxHops = 允许解析的链接数上限（16）。
  # 每次循环「先找下一个链接」：找不到即整条路径已无 reparse point，可以返回；
  # 找到且已解析满 16 个，说明要解析的是第 17 个链接 -> 中止。
  $hopCount = 0
  while ($true) {
    $linkPath = Get-FirstReparsePointComponent -Path $current -Purpose "真实路径解析"
    if ($null -eq $linkPath) {
      # 返回值用「目录规范形式」而不是 ConvertTo-ComparablePath：后者会把路径折叠成小写，
      # 而调用方要拿它拼 profile 路径、并把它绑定给 $env:DSH_HOME 交给自带 CLI。
      # 环检测用的 $visited 仍然用可比较形式（大小写折叠），那是比较语义，不是路径语义。
      $resolved = ConvertTo-CanonicalDirectoryPath -Path $current
      if ([string]::IsNullOrEmpty($resolved)) {
        throw ("解析真实路径失败：无法规范化解析结果 " + $current + "，已按 fail closed 中止。")
      }
      return $resolved
    }
    if ($hopCount -ge $maxHops) {
      throw ("解析真实路径失败：沿链接追踪超过 " + $maxHops + " 跳仍未到达真实目录（起点：" + $Path + "）。`n" + "    可能是超长链接链或环，已按 fail closed 中止。")
    }

    # 读取链接目标：读不到 / 为空一律中止（绝不猜测、也绝不退回 lexical 路径）。
    $item = Get-OptionalFileSystemItem -Path $linkPath -Purpose "真实路径解析"
    if ($null -eq $item) {
      throw ("解析真实路径失败：" + $linkPath + " 在解析过程中已不存在，无法继续，已按 fail closed 中止。")
    }
    $targets = @($item.Target)
    if ($targets.Count -eq 0) {
      throw ("解析真实路径失败：" + $linkPath + " 是链接但读不到链接目标（Target 为空）。`n" + "    无法确认它最终指向哪个目录，已按 fail closed 中止；请检查该链接是否损坏。")
    }
    $target = [string]$targets[0]
    if ([string]::IsNullOrWhiteSpace($target)) {
      throw ("解析真实路径失败：" + $linkPath + " 是链接但链接目标为空字符串，无法解析，已按 fail closed 中止。")
    }

    # 相对 target 以「链接所在目录」为基准解析（junction / symlink 都可能给出相对目标）。
    if (-not [System.IO.Path]::IsPathRooted($target)) {
      $linkParent = Split-Path -Parent $linkPath
      if ([string]::IsNullOrWhiteSpace($linkParent)) {
        throw ("解析真实路径失败：" + $linkPath + " 的相对链接目标（" + $target + "）无法定位基准目录，已按 fail closed 中止。")
      }
      $target = [System.IO.Path]::Combine($linkParent, $target)
    }

    $next = ""
    try {
      $next = [System.IO.Path]::GetFullPath($target)
    } catch {
      throw ("解析真实路径失败：链接目标无法规范化（" + $linkPath + " -> " + $target + "：" + [string]$_.Exception.Message + "）。`n" + "    规范化失败时无法可靠解析真实目录，已按 fail closed 中止。")
    }

    # 把「链接点之后的剩余组件」接回目标之后：C:\a\link\b 中 link -> D:\x 时真实路径是 D:\x\b。
    if ($current.Length -gt $linkPath.Length) {
      $tail = $current.Substring($linkPath.Length)
      try {
        $next = [System.IO.Path]::GetFullPath($next + $tail)
      } catch {
        throw ("解析真实路径失败：链接目标与剩余路径拼接后无法规范化（" + $linkPath + " -> " + $target + "，剩余 " + $tail + "：" + [string]$_.Exception.Message + "）。`n" + "    规范化失败时无法可靠解析真实目录，已按 fail closed 中止。")
      }
    }

    # 环检测：同一个规范化目标被第二次访问即判定为环。用规范形式比较，避免大小写/分隔符差异绕过。
    $nextKey = ConvertTo-ComparablePath -Path $next
    if ($null -eq $nextKey) {
      throw ("解析真实路径失败：链接目标规范化失败（" + $linkPath + " -> " + $next + "），已按 fail closed 中止。")
    }
    if ($visited.Contains($nextKey)) {
      throw ("解析真实路径失败：链接出现环，" + $next + " 被重复访问（当前跳数 " + $hopCount + "）。`n" + "    环状链接无法解析出真实目录，已按 fail closed 中止。")
    }
    $visited.Add($nextKey)
    $current = $next
    $hopCount++
  }
  # 正常路径永远走不到这里：$hopCount -ge $maxHops 的判定在循环体内，
  # 循环只能通过 return 或 throw 退出。保留这一行作为兜底，避免将来改动后静默返回 $null。
  throw ("解析真实路径失败：沿链接追踪超过 " + $maxHops + " 跳仍未到达真实目录（起点：" + $Path + "）。`n" + "    可能是超长链接链或环，已按 fail closed 中止。")
}

# 判断「目标路径」是否确实落在「边界目录」之内，比较保持路径段边界。
# 为什么不能简单地拼 $Boundary + '\' 再前缀比较：Boundary 是盘符根（C:\）时，规范化后
# 本身已以 '\' 结尾，盲目再拼一个 '\' 会得到 C:\\ 这种双反斜杠，让一次完全合法的删除被
# 误拒（fail closed 方向的误伤）；反过来，若为省事退化成裸前缀比较，C:\profiles 会
# 「包含」C:\profiles-evil，那又是 fail open。因此这里显式区分「边界已以分隔符结尾」
# 与「需要补一个分隔符」两种情况，且只在边界确实不是根时才允许补分隔符。
# 比较两侧都必须是 ConvertTo-ComparablePath 的规范形式（分隔符统一、无尾分隔符、大小写折叠）。
function Test-PathWithinBoundary {
  param(
    [Parameter(Mandatory = $true)][string]$NormalizedPath,
    [Parameter(Mandatory = $true)][string]$NormalizedBoundary
  )
  $separator = [string][char]92
  $prefix = $NormalizedBoundary
  if (-not $prefix.EndsWith($separator, [System.StringComparison]::Ordinal)) {
    # 盘符根 "c:\" 已以分隔符结尾，走上面这条分支不补；UNC 根 "\\server\share" 不带尾分隔符，
    # 这里补一个 '\'。两种形态都不会产生双反斜杠。
    $prefix = $prefix + $separator
  }
  return $NormalizedPath.StartsWith($prefix, [System.StringComparison]::Ordinal)
}

# 删除前的统一安全检查：目标必须「规范化后严格等于」期望路径，且路径链上没有链接。
# 为什么用严格相等而不是前缀比较：前缀比较会把期望目录之外的兄弟目录一并放行，
# 而删除不可逆，因此这里只接受「正是那个目录」。
function Assert-SafeDeleteTarget {
  param(
    [Parameter(Mandatory = $true)][string]$Target,
    [Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Boundary,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $normalizedTarget = ConvertTo-ComparablePath -Path $Target
  $normalizedExpected = ConvertTo-ComparablePath -Path $Expected
  $normalizedBoundary = ConvertTo-ComparablePath -Path $Boundary
  if ($null -eq $normalizedTarget -or $null -eq $normalizedExpected -or $null -eq $normalizedBoundary) {
    throw ("无法规范化路径，删除安全检查无法进行，已中止：" + $Target)
  }
  if ($normalizedTarget -cne $normalizedExpected) {
    throw ("拒绝删除：" + $Target + " 不是预期的插件自身目录 " + $Expected + "，已按 fail closed 中止。")
  }
  # 边界复核：期望路径由 boundary 逐级拼出，这里独立再验一次它确实落在 boundary 之内，
  # 防止将来有人把 Expected 的来源换掉而检查仍「看起来通过」。
  if (-not (Test-PathWithinBoundary -NormalizedPath $normalizedTarget -NormalizedBoundary $normalizedBoundary)) {
    throw ("拒绝删除：" + $Target + " 不在 " + $Boundary + " 之内，已按 fail closed 中止。")
  }
  Assert-NoReparsePointOnPath -Path $Target -Purpose $Purpose
}

# 读取 desktop profile 的 package.json 并解析成对象。
# -Encoding UTF8 是硬要求：WinPS 5.1 的 Get-Content 默认按 ANSI 读取，会把 manifest 里的
# 中文字段读成乱码并让 ConvertFrom-Json 失败；显式声明后 WinPS 5.1 与 pwsh 7 行为一致。
# 解析失败一律抛错（fail closed）：拿不到可信的 profile 状态时既不能 remove、也不能清理残留。
function Read-ProfileManifest {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw ("无法按 UTF-8 解析 desktop profile 清单（" + $Purpose + "）：" + $Path + "`n" + "    " + [string]$_.Exception.Message + "`n" + "    清单不可信时不做任何 remove 或删除，已中止。")
  }
}

# 判断插件是否登记在 manifest 的 dependencies 里。
# 只认 dependencies：dsh.profile.bundles 是 bundle 层配置，单独存在不代表依赖已装上。
function Test-PluginRegistered {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest.dependencies) { return $false }
  return ($null -ne $Manifest.dependencies.PSObject.Properties[$packageName])
}

# 判断 bundle 清单里是否仍登记插件名（remove 后必须为「不再包含」）。
function Test-PluginInBundles {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest.dsh) { return $false }
  if ($null -eq $Manifest.dsh.profile) { return $false }
  if ($null -eq $Manifest.dsh.profile.bundles) { return $false }
  foreach ($bundle in @($Manifest.dsh.profile.bundles)) {
    if ([string]$bundle -eq $packageName) { return $true }
  }
  return $false
}

# ── 1. 路径解析：DSH_HOME 必须完全限定并解析成真实目录 ─────────────────────────────

$dshHomeInput = $env:DSH_HOME
if ([string]::IsNullOrWhiteSpace($dshHomeInput)) { $dshHomeInput = Join-Path $env:USERPROFILE ".dsh" }
if ([string]::IsNullOrWhiteSpace($dshHomeInput)) {
  throw "无法确定 DSH_HOME（$env:DSH_HOME 为空且 USERPROFILE 不可用）。"
}
if (-not (Test-FullyQualifiedPath -Path $dshHomeInput)) {
  throw ("DSH_HOME 必须是完全限定的绝对路径（盘符绝对如 C:\... 或 UNC 绝对如 \\server\share\...），当前为：" + $dshHomeInput + "。相对路径、盘符相对路径（如 C:foo）与当前盘根相对路径（如 \foo）都会随调用环境漂移，无法用于安全地定位并删除目录。")
}
# DSH_HOME 自身允许是用户配置的 junction / symlink（与 desktop-install.ps1 一致）：这里只解析、
# 不拒绝。解析得到的真实目录是后续所有 profile 路径的基准，因此 home 一级的链接不再被误判，
# 而 profiles / profile 层的链接仍会在下面的逐级检查里被拒。
$dshHome = Resolve-RealDirectoryPath -Path $dshHomeInput

# 本脚本只服务桌面版：profile 名硬编码，参数无法改变它。
$profileName = "desktop"
$packageName = "dsh-expert-group"
$profilesDir = Join-Path $dshHome "profiles"
$profileDir = Join-Path $profilesDir $profileName
$profileManifest = Join-Path $profileDir "package.json"
$pluginDir = Join-Path (Join-Path $profileDir "node_modules") $packageName

# ── 2. 预检：自带 CLI 与 desktop profile 都必须真实存在 ──────────────────────────

Write-Host "卸载 dsh-expert-group（desktop profile）..." -ForegroundColor Cyan
Write-Host ("  DSH_HOME        ：" + $dshHome) -ForegroundColor DarkGray
# 只在「确实沿链接解析过」时提示：把输入路径与解析结果各自折叠成可比较形式再比。
# 为什么不直接比较两个字符串：两侧的大小写与尾分隔符写法都可能不同（解析结果来自文件系统，
# 输入来自用户环境变量），直接比较会在正常的非链接场景下也「不相等」，打印误导性提示。
$dshHomeKey = ConvertTo-ComparablePath -Path $dshHome
$lexicalHomeKey = ConvertTo-ComparablePath -Path $dshHomeInput
if ($null -eq $dshHomeKey -or $null -eq $lexicalHomeKey -or -not ($lexicalHomeKey -ceq $dshHomeKey)) {
  Write-Host ("  DSH_HOME 输入   ：" + $dshHomeInput + "（是链接，已解析为真实目录）") -ForegroundColor DarkGray
}
Write-Host ("  桌面版 profile  ：" + $profileDir) -ForegroundColor DarkGray
Write-Host ("  应用自带 CLI    ：" + $cli) -ForegroundColor DarkGray

# CLI 必须存在，否则不可能完成卸载；这里不做任何「改用手工删文件」的降级。
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) {
  throw ("未找到应用自带 CLI：" + $cli + "。请用 -DshInstallDirectory 指定正确的应用根目录（不要改用 PATH 上的全局 dsh）。")
}

# profile 路径隔离（从真实 home 出发逐级检查，全部 fail closed）：
#   profiles 与 profiles\desktop 必须存在、可读、是目录、且整条路径链上没有 reparse point。
# 与 desktop-install.ps1 的 Assert-ProfilePathIsolation 同一判据：DSH_HOME 自身是链接已在上一步
# 解析掉，这里拒绝的是 profile 层被换成链接（那会让自带 CLI 写进 DSH_HOME 之外的目录）。
$null = Test-RealDirectoryComponent -Path $profilesDir -Purpose "profiles 目录检查"
$null = Test-RealDirectoryComponent -Path $profileDir -Purpose "desktop profile 目录检查"

if (-not (Test-Path -LiteralPath $profileDir -PathType Container)) {
  throw ("desktop profile 目录不存在：" + $profileDir + "。请先启动一次桌面版完成初始化。")
}
if (-not (Test-Path -LiteralPath $profileManifest -PathType Leaf)) {
  throw ("desktop profile 未初始化（缺少 " + $profileManifest + "）。请先启动一次桌面版。")
}

# 读取 profile 清单之前先做一次路径隔离检查：profiles\desktop（或其祖先）是符号链接 / junction
# 时，清单与自带 CLI 操作都会落到 DSH_HOME 之外的真实目录上，必须先 fail closed 中止。
# 调用 CLI remove 之前还会再查一次（见下），把检查与写操作之间的时间窗口压到最小。
Assert-NoReparsePointOnPath -Path $profileManifest -Purpose "profile 路径隔离（读取清单前）"

# 只读解析：拿不到可信的 manifest 就中止，绝不继续往下删。
$manifest = Read-ProfileManifest -Path $profileManifest -Purpose "卸载前读取"
$registered = Test-PluginRegistered -Manifest $manifest
$inBundles = Test-PluginInBundles -Manifest $manifest
# 残留目录的存在性也要参与幂等判定，因此这里先严格读一次（读不到一律 fail closed）。
$residualItem = Get-OptionalFileSystemItem -Path $pluginDir -Purpose "检查插件残留目录"
$hasResidualDir = ($null -ne $residualItem)

# ── 3. 幂等三态：dependencies / dsh.profile.bundles / 插件目录必须分别判定 ─────────

if (-not $registered -and $inBundles) {
  # bundle 层仍登记本插件、但依赖已不存在：profile 处于不一致状态。
  # 这时既不能假装卸载成功（dependencies 与 bundles 的说法互相矛盾），也不该去删残留目录
  # （那会把状态改得更难诊断），因此 fail closed 并给出明确诊断。
  throw ("profile 状态不一致：" + $profileManifest + " 的 dependencies 中没有 " + $packageName + "，但 dsh.profile.bundles 仍包含它。" + "`n" + "    请先人工核对该字段（或手工执行 " + $cli + " plugin --profile " + $profileName + " remove " + $packageName + "）后再重跑本脚本；本次不做任何删除。")
}

if (-not $registered -and -not $inBundles -and -not $hasResidualDir) {
  Write-Host ("  未在 " + $profileManifest + " 的 dependencies 与 dsh.profile.bundles 中找到 " + $packageName + "，且插件目录不存在，无需卸载。") -ForegroundColor Yellow
  Write-Host "完成（幂等跳过）。桌面版无需重启。" -ForegroundColor Green
  return
}

if ($registered) {
  # ── 3a. 通过应用自带 CLI 移除插件 ──
  Write-Host ("  执行：" + $cli + " plugin --profile " + $profileName + " remove " + $packageName) -ForegroundColor DarkGray
  # 紧前再查一次：从读取清单到这里之间，profiles\desktop 完全可能被人为换成链接。
  Assert-NoReparsePointOnPath -Path $profileManifest -Purpose "profile 路径隔离（调用 CLI remove 前）"
  # 插件目标路径链也必须在**调用 CLI 之前**检查一次，而不是只在清理阶段检查：
  # node_modules 或插件目标本身是 junction 时，CLI 的 remove 会顺着链接去改写/删除 DSH_HOME
  # 之外的内容；那时再拒绝已经太晚（CLI 已经跑过了）。这里只检查「本插件自身的那条路径链」
  # （<profile>\node_modules\<packageName>），不遍历 node_modules 的其它条目——pnpm 会在
  # node_modules 里正常使用符号链接，递归禁止会误伤正常的依赖布局。
  Assert-NoReparsePointOnPath -Path $pluginDir -Purpose "插件目标路径隔离（调用 CLI remove 前）"
  # 调用期间把 $ErrorActionPreference 降为 Continue：pwsh 7.4+ 的 PSNativeCommandUseErrorActionPreference
  # 默认 true，在 Stop 语义下非零退出码会被包装成终止性错误，导致拿不到 $LASTEXITCODE、
  # 也无法给出中文诊断。这里显式保存 / 恢复并判码（与 desktop-install.ps1 的 Invoke-NativeCommand 同一取舍）。
  # 把 $env:DSH_HOME 临时绑定到**已解析的真实目录**：自带 CLI 默认继承调用者的 DSH_HOME
  # （可能是链接），而本脚本所有的隔离检查都是针对解析后的真实 home 做的。两者指向不同写法时，
  # 检查与写操作之间就存在一个「home 链接在其后被改指向别处」的窗口；绑定后 CLI 与检查指向同一个 home。
  # 已知限制（有意保留）：检查与写操作仍然不是原子的，这里只消除「两者指向不同路径」这一层差异，
  # 不引入额外锁机制。
  $previousDshHome = $env:DSH_HOME
  $dshHomeWasSet = -not [string]::IsNullOrWhiteSpace($previousDshHome)
  $previousPreference = $ErrorActionPreference
  $exitCode = -1
  try {
    $ErrorActionPreference = "Continue"
    $env:DSH_HOME = $dshHome
    & $cli plugin --profile $profileName remove $packageName
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousPreference
    # 原样恢复：原来有值就写回原值，原来未设置（或为空）就重新变回「未设置」。
    if ($dshHomeWasSet) {
      $env:DSH_HOME = $previousDshHome
    } else {
      Remove-Item -LiteralPath "Env:DSH_HOME" -ErrorAction SilentlyContinue
    }
  }
  if ($exitCode -ne 0) {
    throw ("plugin --profile " + $profileName + " remove " + $packageName + " 失败，退出码 " + $exitCode + "。profile 可能已被部分修改，请人工核对 " + $profileManifest + "、pnpm-lock.yaml 与 node_modules，不要 --force、不要反复重试。")
  }
  Write-Host "  CLI remove 完成" -ForegroundColor DarkGray

  # ── 3b. 卸载后校验：dependencies 与 dsh.profile.bundles 都必须不再出现本插件 ──
  # 重新从磁盘读取，而不是复用卸载前的对象：校验的对象必须是 CLI 落盘后的真实状态。
  # 复核前先确认清单**仍然存在**：CLI 成功却把 profile 清单整个删掉时，我们拿不到任何可信状态，
  # 既无法证明插件已被移除，也无法证明 profile 还完整。刻意不把「清单消失」当成「卸载成功」——
  # 那是 fail open；先 fail closed 中止，不清理残留目录。
  $afterItem = Get-OptionalFileSystemItem -Path $profileManifest -Purpose "卸载后校验读取清单"
  if ($null -eq $afterItem) {
    throw ("卸载后校验失败：" + $profileManifest + " 在 CLI remove 之后已不存在，无法确认卸载结果与 profile 完整性，本次不清理残留目录。" + "`n" + "    请人工核对 profile 目录后重跑本脚本。")
  }
  $after = Read-ProfileManifest -Path $profileManifest -Purpose "卸载后校验"
  if (Test-PluginRegistered -Manifest $after) {
    throw ("卸载后校验失败：" + $profileManifest + " 的 dependencies 仍包含 " + $packageName + "。CLI 报告成功但磁盘状态不符，请人工核对 profile；本次不清理残留目录。")
  }
  if (Test-PluginInBundles -Manifest $after) {
    throw ("卸载后校验失败：" + $profileManifest + " 的 dsh.profile.bundles 仍包含 " + $packageName + "。请人工核对该字段后再重启桌面版；本次不清理残留目录。")
  }
  Write-Host ("  校验通过：dependencies 与 dsh.profile.bundles 均不再包含 " + $packageName) -ForegroundColor DarkGray
} else {
  Write-Host "  dependencies 与 dsh.profile.bundles 均已清除，仅剩插件自身残留目录，将只清理该目录。" -ForegroundColor Yellow
}

# ── 4. 清理插件自身残留目录（唯一的删除动作） ────────────────────────────────────

# CLI remove 可能已经把目录删掉，因此这里重新读一次，而不是复用前面的判定结果。
$residualNow = Get-OptionalFileSystemItem -Path $pluginDir -Purpose "清理插件残留目录"
if ($null -ne $residualNow) {
  # 期望路径独立重建一次，与待删目标做规范化严格相等比较（不共用同一个变量）。
  $expectedPluginDir = Join-Path (Join-Path $profileDir "node_modules") $packageName
  Assert-SafeDeleteTarget -Target $pluginDir -Expected $expectedPluginDir -Boundary $profileDir -Purpose "清理插件残留目录"
  Remove-Item -LiteralPath $pluginDir -Recurse -Force
  Write-Host ("  已清理插件自身残留目录：" + $pluginDir) -ForegroundColor DarkGray
} else {
  Write-Host ("  无残留目录：" + $pluginDir) -ForegroundColor DarkGray
}

# ── 5. 明确不删除的内容（有意为之，勿改成「顺手清理」） ───────────────────────────
#   - cordis.yml / cordis.patch.yml / pnpm-workspace.yaml：用户配置与模型路由。
#   - 其它 manifest / lock 配置（package.json 里除本插件外的依赖、pnpm-lock.yaml 的其它条目）。
#   - .plugin-manager 日志。
#   - plugin-releases\dsh-expert-group\pack-* 与 cli-install-*：安装与回滚材料。
#   - storages\dsh_expert_group.json：插件运行期数据（设置、通知偏好等）。
#   - 其它插件与共享依赖：本脚本只经 CLI 移除本插件，不碰 node_modules 里的任何其它条目。

Write-Host "完成。请完全退出并重启桌面版后生效。" -ForegroundColor Green
