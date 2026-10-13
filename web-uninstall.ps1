# 从用户的 web profile 卸载 dsh-expert-group，并清理同名安装副本。
# 用法：powershell -ExecutionPolicy Bypass -File .\web-uninstall.ps1
#
# 安全边界（有意为之，勿放宽）：
#   - DSH_HOME 必须是**完全限定**的绝对路径（盘符绝对 C:\... / C:/...，或 UNC 绝对
#     \\server\share\...）。相对路径（foo、.\foo）会随调用时的当前目录漂移；
#     盘符相对（C:foo）与当前盘根相对（\foo）同样依赖进程状态。基于它们做出的「这个目录
#     属于本 profile」判断全部失去意义，而删除不可逆，因此一律直接拒绝而不是补全。
#     注意不能用 [System.IO.Path]::IsPathRooted 判定：它在 Windows 上把 C:foo 与 \foo
#     也判为 true；也不能用 IsPathFullyQualified（Windows PowerShell 5.1 的 .NET Framework
#     上没有这个 API）。判据见 Test-FullyQualifiedPath。
#   - **DSH_HOME 本身允许是用户配置的 junction / symlink**（用户有权把 home 放到别的盘），
#     与 desktop-install.ps1 的 Resolve-RealDirectoryPath / Assert-ProfilePathIsolation 判据一致：
#     home 一级的 reparse point 只解析、不拒绝。脚本先把 home 解析成真实目录，之后所有
#     profile 路径都从真实 home 出发构造。**解析完成后还要验证真实目标确实存在、属性可读、
#     且是目录**：home 链接损坏或指向不存在的目录时，解析结果会是一条不存在的路径，若就此返回，
#     脚本会把「home 不存在」误当成「profile 未初始化」，于是走进「无操作成功」或「清理安装副本
#     成功」两条路径（fail open）。这种情形一律 fail closed 中止，不调 CLI、不删任何东西。
#   - 解析完成后，profiles 与 profiles\web 这两级（以及最终删除目标的路径链）必须是
#     **真实非 reparse 目录**：这两级被换成链接时，CLI 会对着 DSH_HOME 之外的 profile 执行
#     remove，递归删除也会穿透链接删掉无关内容，因此一律 fail closed 中止。
#   - 读取 profile 清单与调用 remove CLI 之前，各做一次逐级 reparse point 检查；调用 CLI
#     之前那次把检查与写操作之间的时间窗口压到最小。检查从**真实 home** 开始，因此 home
#     自身的链接不再被误判，而 profiles / profile 层的链接仍被拒绝。
#   - 调用 CLI remove 之前，还要把**本插件自己在 web profile 内的三条目标路径链**逐条检查完：
#     <profile>\node_modules\<pkg>、<home>\profiles\packages\<pkg>、<profile>\packages\<pkg>。
#     任一被链接重定向（含祖先目录）都在 CLI 之前 fail closed，CLI 调用次数保持 0——CLI 一旦跑起来
#     就会顺着链接改写 DSH_HOME 之外的内容，那时再拒绝已经太晚。只查这三条链，**不遍历**
#     node_modules 的其它条目：pnpm 会在那里正常使用符号链接，递归禁止会误伤正常的依赖布局。
#   - 上述第一条链有**唯一一个**有意的例外：pnpm 对目录参数保存的是 `link:<目录>` 依赖，正常安装的
#     web 插件入口按设计就是一条指向 <home>\profiles\packages\<pkg> 的 junction（本机 pnpm 11.21.0
#     实测）。**实测语义**：`pnpm remove` / `dsh plugin --profile web remove` 在 nodeLinker: hoisted 下
#     **不会删除**这条 junction（代码级原因见 Remove-ManagedPluginEntryLink 的注释），入口按预期残留。
#     所以这条例外的用途不是「让 CLI 顺手删掉它」，而是**让流程能走到 CLI 之后由本脚本自己解除它**：
#     若在 CLI 之前一律拒绝链接，正常安装过的 web profile 将永远无法卸载（安全边界退化成功能缺失）。
#     例外必须严格，只接受同时满足下面三条的那一个组件：
#       1) 该组件正是本插件入口；
#       2) 它的 LinkType **精确等于** "Junction"——与 CLI 之后的 Remove-ManagedPluginEntryLink 共用
#          同一套判据（同一实现点），避免两处漂移；SymbolicLink / MountPoint / 读不到类型一律拒绝；
#       3) 它解析到的真实目录规范化后**严格等于**受管理的 <home>\profiles\packages\<pkg>。
#     指向任意外部路径、相对目标、损坏目标一律拒绝。
#   - 每次递归删除之前，逐级检查「盘符根 -> 目标」上每一个现存路径组件，任一为 reparse point
#     （符号链接 / junction / 挂载点）就拒绝删除。只检查现存组件；读不到属性（权限不足 /
#     链接损坏）一律 fail closed，绝不当作「不存在」放行。
#   - 删除目标必须与「由 DSH_HOME 逐级拼出来的插件自身目录」规范化后严格相等，不接受字符串
#     前缀之类的弱判断。web 的两个副本位置分别独立检查。
#   - 先把所有待删目标检查完，再进入删除阶段：避免出现「删掉一个、另一个因链接被拒」的半完成状态。
#     **这一轮预检必须早于「解除插件入口」与 CLI remove**（见第 5 节）：预检失败时入口与安装副本
#     都要保持原状。CLI remove 本身不可回滚，因此「CLI 已跑」这一层无法纳入全有或全无，
#     脚本能保证的是「预检全通过之后才调 CLI」与「CLI 之后复核失败则不清理任何副本」。
#   - CLI remove 成功后必须重读 profile manifest，复核 dependencies 与 dsh.profile.bundles
#     都不再含本插件；复核失败一律不删任何安装副本。
#   - 复核通过后还要处理 profile 内 <profile>\node_modules\<pkg> 这条**插件入口**：CLI 只保证
#     manifest 与它自己的记账，而 pnpm 在 nodeLinker: hoisted 下不会删除 `link:` 目录依赖的
#     node_modules 入口，因此入口按预期残留，必须由本脚本自己解除（非递归删除链接本身）。
#     解除前必须确认它正是「本插件入口 -> 受管理的 <home>\profiles\packages\<pkg>」这条 junction；
#     普通目录、指向别处的链接、悬挂链接、LinkType 非 Junction、解析失败一律 fail closed 中止，
#     且不清理任何安装副本。入口本来就不存在（或未登记插件的幂等路径下）时按正常流程继续。
#
# 兼容性：语法保持 Windows PowerShell 5.1 可用（不使用 ?? / ?. / 三元运算），
# 文件为 UTF-8 BOM + LF 行尾（WinPS 5.1 靠 BOM 才能正确读中文注释与中文提示）。
$ErrorActionPreference = "Stop"

# 卸载当前包名（与 package.json 的 name 一致）。
$packageName = "dsh-expert-group"

# ── 0. 路径安全工具（全部 fail closed） ─────────────────────────────────────────

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
# 拿它去拼路径会把 DSH_HOME 变成全小写再交给 dsh CLI；这里只做形态归一，不动大小写。
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

# 读取一个「已确认含 ReparsePoint 属性」的项所报告的 LinkType 名称；读不到时返回空串。
# 为什么单独抽成函数：CLI **之前**的入口放行（Assert-NoReparsePointExceptManagedEntryLink）与
# CLI **之后**的入口解除（Remove-ManagedPluginEntryLink）必须用**同一套判据**。两处若各写一份，
# 将来极易漂移成「前放行、后拒绝」（或反之），卸载就会卡在「入口已摘/未摘、副本已删/未删」的
# 半完成状态。判据因此只在这里实现一次，两处都调用它。
# 为什么用 PSObject.Properties 而不是直接写 $Item.LinkType：属性不存在时前者返回 $null、后者在
# 严格模式或某些宿主上会抛错；这里把「读不到类型」明确归一成空串，由调用方按 fail closed 处理。
# LinkType 是 PowerShell 文件系统 provider 在 PS 5.1 与 pwsh 7 上都提供的 ETS 属性（本机实测一致）。
function Get-ReparsePointLinkType {
  param([AllowNull()]$Item)
  if ($null -eq $Item) { return "" }
  $linkTypeProperty = $Item.PSObject.Properties["LinkType"]
  if ($null -eq $linkTypeProperty) { return "" }
  if ($null -eq $linkTypeProperty.Value) { return "" }
  return [string]$linkTypeProperty.Value
}

# 本脚本唯一认的受管理入口链接类型：pnpm 在 Windows 上建的是 **junction**。
# 判定要求**精确等于**（-ceq，大小写敏感）：SymbolicLink / MountPoint / 读不到类型（空串）
# 一律返回 $false，由调用方 fail closed 拒绝。为什么不能只看 ReparsePoint 位：符号链接与 junction
# 的删除语义、目标可及性都不同，本脚本只承诺处理实测到的那一种；放宽成「任意链接」会让一条
# 本不该由本脚本处理的链接被悄悄放行（CLI 之前）或被悄悄摘掉（CLI 之后）。
# 这是**唯一**的判定点，两个调用方共用，避免判据漂移。
function Test-IsManagedEntryJunction {
  param([AllowNull()]$Item)
  return ((Get-ReparsePointLinkType -Item $Item) -ceq "Junction")
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

# 插件入口路径链的检查：与 Assert-NoReparsePointOnPath 同一逐级判据，但**恰好放行一条**链接——
# 「本插件入口 -> 受管理的安装目录」这条 pnpm link。
#
# 为什么必须有这条例外（实测语义，勿凭直觉删除）：
#   - web-install.ps1 用 `dsh plugin --profile web add <绝对目录>` 注册插件，而 pnpm 对**目录**参数
#     保存的是 `link:<目录>` 依赖，并在 node_modules 下建立一条 **junction**（本机 pnpm 11.21.0 实测：
#     node_modules\dsh-expert-group 的 Attributes 含 ReparsePoint、Target 正是该目录）。
#     也就是说，正常安装的 web 插件，其入口**按设计就是一条链接**，不是普通目录。
#   - **实测**：`pnpm remove <名字>` / `dsh plugin --profile web remove` 在 nodeLinker: hoisted 下
#     **不会删除** node_modules 下这条 junction——它只清掉 manifest 的 dependencies 与
#     dsh.profile.bundles，入口按预期残留（代码级原因见 Remove-ManagedPluginEntryLink 的注释）。
#     因此这里的放行不是「让 CLI 去删它」，而是「让流程能走到 CLI 之后由本脚本自己解除它」；
#     真正解除它的那一步在 CLI 之后，且判据与这里完全一致（见下）。
#   - 若这里一律拒绝链接，正常安装过的 web profile 将**永远无法用本脚本卸载**（每次都 fail closed），
#     那是把安全边界退化成功能缺失。
#
# 例外必须严格，只接受同时满足下面三条的那一个组件：
#   1) 该组件正是本插件入口（AllowedLinkPath）；
#   2) 它的 LinkType **精确等于** "Junction"（与 CLI 之后的 Remove-ManagedPluginEntryLink 共用
#      Test-IsManagedEntryJunction 这一个判定点）；SymbolicLink / MountPoint / 读不到类型一律拒绝——
#      两边判据必须一致，否则会出现「CLI 之前放行、CLI 之后拒绝」的半完成状态；
#   3) 它最终解析到的真实目录**规范化后严格等于**受管理的安装目录（AllowedLinkTarget）。
# 指向任意外部路径（包括 profile 内别的目录、别的盘、相对路径目标、损坏目标）一律拒绝——
# 那正是要防的重定向。解析失败（链接损坏 / 目标不存在 / 成环 / 超过跳数上限）同样 fail closed。
# 只检查传入的这一条路径链，不遍历 node_modules 的其它条目：pnpm 会在那里正常使用符号链接，
# 递归禁止会误伤正常的依赖布局。
function Assert-NoReparsePointExceptManagedEntryLink {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Purpose,
    [Parameter(Mandatory = $true)][string]$AllowedLinkPath,
    [Parameter(Mandatory = $true)][string]$AllowedLinkTarget
  )
  $allowedPathKey = ConvertTo-ComparablePath -Path $AllowedLinkPath
  $allowedTargetKey = ConvertTo-ComparablePath -Path $AllowedLinkTarget
  if ($null -eq $allowedPathKey -or $null -eq $allowedTargetKey) {
    throw ("无法规范化路径，插件入口链接例外判定无法进行，已中止：" + $AllowedLinkPath)
  }
  foreach ($candidate in (Get-PathComponentList -Path $Path)) {
    $item = Get-OptionalFileSystemItem -Path $candidate -Purpose $Purpose
    # 只对「确实存在」的组件做链接判定；不存在的组件不可能把操作导向别处。
    if ($null -eq $item) { continue }
    $attributes = $item.Attributes
    if ($null -eq $attributes) {
      throw ("无法读取路径属性：" + $candidate + "（Attributes 为空），无法判定是否为链接，已按 fail closed 中止。")
    }
    if ((([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) { continue }
    $candidateKey = ConvertTo-ComparablePath -Path $candidate
    if ($null -ne $candidateKey -and $candidateKey -ceq $allowedPathKey) {
      # 例外第 2 条：LinkType 必须**精确等于** "Junction"。判据与 CLI 之后的
      # Remove-ManagedPluginEntryLink 共用 Test-IsManagedEntryJunction（同一个实现点），
      # 因此不可能出现「CLI 之前放行一条 SymbolicLink / MountPoint、CLI 之后再拒绝它」的漂移。
      # 这次收紧只作用于「放行」方向：非 Junction 一律 fail closed，不放宽任何既有拒绝路径。
      $candidateLinkType = Get-ReparsePointLinkType -Item $item
      if (-not (Test-IsManagedEntryJunction -Item $item)) {
        throw ("拒绝继续：插件入口 " + $candidate + " 是 reparse point，但 LinkType 不是 Junction（实际为 [" + $candidateLinkType + "]）。`n" + "    CLI 之前的放行与 CLI 之后的解除必须用同一套判据（只接受本插件实测到的 pnpm junction）；符号链接 / 挂载点 / 读不到类型一律按 fail closed 中止，本次不调用 CLI、不做任何删除。")
      }
      # 例外第 3 条：只在这一个组件上评估；解析用与 DSH_HOME 相同的 Resolve-RealDirectoryPath，
      # 因此「目标不存在 / 目标不是目录 / 成环 / 超跳」都会抛错中止，不会被当成放行。
      $resolvedLink = Resolve-RealDirectoryPath -Path $candidate
      $resolvedLinkKey = ConvertTo-ComparablePath -Path $resolvedLink
      if ($null -ne $resolvedLinkKey -and $resolvedLinkKey -ceq $allowedTargetKey) { continue }
      throw ("拒绝继续：插件入口 " + $candidate + " 是符号链接 / junction / 挂载点（reparse point），它指向 " + $resolvedLink + "，不是受管理的安装目录 " + $AllowedLinkTarget + "。`n" + "    只允许「本插件入口 -> 受管理安装目录」这一条 pnpm link，指向其它位置一律按 fail closed 中止。")
    }
    throw ("拒绝继续：路径组件 " + $candidate + " 是符号链接 / junction / 挂载点（reparse point）。`n" + "    CLI remove 会顺着该链接改写 DSH_HOME 之外的 profile 内容，因此按 fail closed 中止。`n" + "    请确认该链接指向何处后手工处理（本脚本不代劳）。")
  }
}

# 判断路径是否为「已存在的真实目录，且整条路径链上没有 reparse point」。
# 为什么需要它：DSH_HOME 本身允许是链接（已先解析成真实目录），而 profiles 与
# profiles\web 这两级**不允许**是链接——它们被换成链接时，CLI remove 会写进 DSH_HOME 之外的
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
# 调用方有两个：DSH_HOME 自身，以及「本插件入口 -> 受管理安装目录」这条链接的目标校验
# （见 Assert-NoReparsePointExceptManagedEntryLink）。只做读取，不做任何写入。
# 注意：Resolve-Path 在两个 PowerShell 版本下都不会解析 junction / symlink，不能拿它当判据；
# 这里只用 FileSystem provider 的属性位与 Target（PS 5.1 与 pwsh 7 都支持），不引入外部工具。
# fail closed 语义：下列任一情况都抛错中止，绝不返回「未解析完的路径」——
# 拿一个没解析完的路径继续做安全判断，可能把链接指向的目录当成 DSH_HOME（fail open）：
#   1) 路径不存在（含路径链上任何一级不存在），或任一级组件的属性读不出来；
#   2) 是 reparse point 但链接目标为空 / 不可读（拿不到 Target）；
#   3) 链接目标（含相对目标的基准目录）无法规范化；
#   4) 沿链接追下去出现环（同一个规范化目标被再次访问）；
#   5) 沿链接追踪超过上限（恰好 16 跳仍合法，第 17 个链接一律拒绝）。
# 两个调用方都要求解析结果**真实存在**（DSH_HOME 要读它下面的 profile；插件入口链接必须指向
# 受管理的安装目录），因此这里「路径不存在」直接抛错，而不是像通用解析器那样放行不存在的尾部组件。
# 注意：「路径链上读不到链接」并不能代替这一条——Windows 上指向不存在目标的 junction 用 Get-Item
# 仍能读到对象与 Target，于是循环会「成功」解析出一条不存在的路径。
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
      # 而调用方要拿它拼 profile 路径、并把它绑定给 $env:DSH_HOME 交给 dsh CLI。
      # 环检测用的 $visited 仍然用可比较形式（大小写折叠），那是比较语义，不是路径语义。
      $resolved = ConvertTo-CanonicalDirectoryPath -Path $current
      if ([string]::IsNullOrEmpty($resolved)) {
        throw ("解析真实路径失败：无法规范化解析结果 " + $current + "，已按 fail closed 中止。")
      }
      # 解析完成后必须验证「真实目标确实存在、属性可读、且是目录」，缺一不可：
      #   - 链接损坏 / 指向不存在的目录时，上面的循环会解析出一条**不存在**的路径并原样返回
      #     （Windows 上指向不存在目标的 junction 用 Get-Item 仍能读到对象与 Target，
      #     所以「读不到链接」这条防线拦不住它）；
      #   - 拿到这样的路径后，调用方会把「home 不存在」误当成「profile 未初始化」，
      #     于是走进「无操作成功」或「清理安装副本成功」两条路径——用户看到的是绿色完成，
      #     实际什么都没做，这是 fail open。
      # 因此这里在唯一的返回点做终检：读不到对象、属性读不出来、不是目录，一律中止。
      $resolvedItem = Get-OptionalFileSystemItem -Path $resolved -Purpose "校验 DSH_HOME 解析结果"
      if ($null -eq $resolvedItem) {
        throw ("解析真实路径失败：解析结果的真实目录不存在：" + $resolved + "（输入 " + $Path + "）。`n" + "    该输入可能是 DSH_HOME，也可能是插件入口链接；链接已损坏或指向不存在的目录时，无法确认要操作哪个目录，已按 fail closed 中止。`n" + "    请修正该路径或重建该链接后重试（本脚本不会在不确定的目录上做任何删除）。")
      }
      $resolvedAttributes = $resolvedItem.Attributes
      if ($null -eq $resolvedAttributes) {
        throw ("解析真实路径失败：无法读取解析结果的属性：" + $resolved + "（输入 " + $Path + "）。`n" + "    属性读不出来时无法判定它是目录还是文件，已按 fail closed 中止。")
      }
      if (-not $resolvedItem.PSIsContainer) {
        throw ("解析真实路径失败：解析结果不是目录：" + $resolved + "（输入 " + $Path + "）。`n" + "    DSH_HOME 必须是目录（卸载要读它下面的 profile），插件入口链接也必须指向目录，已按 fail closed 中止。")
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

# 解除「本插件入口 -> 受管理安装目录」这条 pnpm link 入口链接（只摘链接，绝不穿透目标）。
#
# 为什么卸载脚本必须自己做这件事（实测语义，勿凭直觉删除）：
#   web-install.ps1 用 `dsh plugin --profile web add <绝对目录>` 注册插件，pnpm 对**目录**参数
#   保存的是 `link:<目录>` 依赖，并在 <profile>\node_modules\<pkg> 建立一条 **junction** 指向
#   <home>\profiles\packages\<pkg>（本机 pnpm 11.21.0 实测）。但 CLI 的 remove 子命令
#   只清掉 manifest 的 dependencies 与 dsh.profile.bundles，**不会删除这条 junction**。
#   代码级原因：web profile 设 nodeLinker: hoisted，pnpm 在该模式下跳过唯一会删除
#   node_modules\<name> 的 prune 路径，改用依赖图差集删除；而 `link:` 依赖在 lockfile 里没有
#   `packages:` 条目、refToRelative 也返回 null，永远进不了差集。file:<tgz> 依赖（desktop 侧）
#   不受影响，所以 desktop 卸载正常。
#   结论：入口链接必须由本脚本自己解除，而不是把复核放宽成「入口还在也算卸载成功」。
#
# fail-closed 边界（任一不满足即抛错中止，绝不删任何东西）：
#   1) 必须能用 Get-OptionalFileSystemItem 读到对象（读不出来一律中止，不把「读不到」当「不存在」）；
#   2) Attributes 必须含 ReparsePoint；
#   3) LinkType 必须**精确等于** "Junction"——SymbolicLink / MountPoint / 读不到类型一律拒绝。
#      判定走 Test-IsManagedEntryJunction，与 CLI 之前的 Assert-NoReparsePointExceptManagedEntryLink
#      共用同一个实现点：两处判据必须一致，否则会出现「CLI 之前放行、CLI 之后拒绝」的半完成状态；
#   4) 用与 DSH_HOME 相同的 Resolve-RealDirectoryPath 解析后，必须**规范化后严格等于**
#      $ManagedTarget（复用 ConvertTo-ComparablePath + -ceq，不做长度 / 前缀之类的弱判断）；
#   5) 删除后必须重新读取确认它已消失，仍然存在即中止。
#
# 删除原语必须是 [System.IO.Directory]::Delete($path, $false)：第二个参数 $false 表示**非递归**，
# 只摘掉链接本身，链接目标目录与其内文件完好无损（PS 5.1.19041 与 pwsh 7.6.3 实测一致）。
# **禁止**对入口做递归删除（-Recurse）：递归删除会穿透 junction，删掉链接目标里的内容。
# 既有的 Assert-SafeDeleteTarget 会主动拒绝 reparse point，它的职责是保护后续的递归删除
# （安装副本），不适用于入口链接，因此这里刻意不复用它。
#
# 并发与原子性限制（有意记录，勿当成待修缺陷）：
#   「读取文件系统项 -> 读取 LinkType -> 解析真实目标 -> 规范化比较 -> Directory.Delete」这一串步骤
#   **不是原子的**，本脚本也不持有任何锁。若同一用户下有并发进程在上面任意两步之间把入口路径换成
#   了别的东西（或把链接目标改指别处），路径式删除无法提供「删掉的正是刚才校验过的那个对象」这种
#   身份绑定：[System.IO.Directory]::Delete 只认路径，Windows 上也没有可在不引入新依赖的前提下使用
#   的「按句柄删除」原语。因此**并发修改不属于本脚本的安全保证范围**——本脚本只保证「在无并发修改
#   的前提下，逐级判据全部成立才动那一个受管理入口」。这与文件内既有的「检查与写操作仍然不是原子的」
#   表述是同一层限制（见 CLI remove 之前绑定 $env:DSH_HOME 那段的说明）。
#
# 返回值：入口本来就不存在时返回 $false（调用方按「无需处理」继续正常流程）；解除成功返回 $true。
function Remove-ManagedPluginEntryLink {
  param(
    [Parameter(Mandatory = $true)][string]$EntryPath,
    [Parameter(Mandatory = $true)][string]$ManagedTarget,
    [Parameter(Mandatory = $true)][string]$Purpose
  )
  $item = Get-OptionalFileSystemItem -Path $EntryPath -Purpose $Purpose
  if ($null -eq $item) { return $false }
  $attributes = $item.Attributes
  if ($null -eq $attributes) {
    throw ("拒绝解除插件入口（" + $Purpose + "）：" + $EntryPath + "（Attributes 为空），无法判定它是否为链接，已按 fail closed 中止。")
  }
  if ((([System.IO.FileAttributes]$attributes -band [System.IO.FileAttributes]::ReparsePoint) -eq 0)) {
    throw ("拒绝解除插件入口（" + $Purpose + "）：" + $EntryPath + " 存在但不是链接（Attributes 为 " + [string]$attributes + "，不含 ReparsePoint）。`n" + "    本脚本只解除「本插件入口 -> 受管理安装目录」这一条受管理的 pnpm junction，普通目录不属于本脚本所有，一律不删。")
  }
  # LinkType 必须精确等于 "Junction"：SymbolicLink / MountPoint 与「读不到类型」都要拒绝。
  # 为什么不只看 ReparsePoint 位：SymbolicLink 与 junction 的删除语义、目标可及性都不同，
  # 而本脚本只承诺处理实测到的那一种（pnpm 在 Windows 上建的是 junction）；放宽到「任意链接」
  # 会让一条本不该由本脚本处理的链接被悄悄摘掉。
  # 判定走 Test-IsManagedEntryJunction：它与 CLI 之前的 Assert-NoReparsePointExceptManagedEntryLink
  # **共用同一个实现点**，两处判据不可能漂移（否则会出现「CLI 前放行、CLI 后拒绝」的半完成状态）。
  $linkType = Get-ReparsePointLinkType -Item $item
  if (-not (Test-IsManagedEntryJunction -Item $item)) {
    throw ("拒绝解除插件入口（" + $Purpose + "）：" + $EntryPath + " 是链接，但 LinkType 不是 Junction（实际为 [" + $linkType + "]）。`n" + "    只接受本插件实测到的 pnpm junction，其它链接类型（符号链接 / 挂载点 / 读不到类型）一律按 fail closed 中止。")
  }
  # 解析用与 DSH_HOME 相同的 Resolve-RealDirectoryPath：目标不存在 / 不是目录 / 成环 / 超跳都会抛错，
  # 因此「悬挂链接」与「解析失败」天然走 fail closed，不会被当成放行。
  $resolved = Resolve-RealDirectoryPath -Path $EntryPath
  $resolvedKey = ConvertTo-ComparablePath -Path $resolved
  $managedTargetKey = ConvertTo-ComparablePath -Path $ManagedTarget
  if ($null -eq $resolvedKey -or $null -eq $managedTargetKey) {
    throw ("拒绝解除插件入口（" + $Purpose + "）：无法规范化 " + $EntryPath + " 或 " + $ManagedTarget + "，严格相等判定无法进行，已按 fail closed 中止。")
  }
  if (-not ($resolvedKey -ceq $managedTargetKey)) {
    throw ("拒绝解除插件入口（" + $Purpose + "）：" + $EntryPath + " 指向 " + $resolved + "，不是受管理的安装目录 " + $ManagedTarget + "。`n" + "    只允许「本插件入口 -> 受管理安装目录」这一条链接，指向其它位置一律按 fail closed 中止。")
  }
  # 非递归删除：$false 表示只删除链接本身，不递归进入目标目录。
  [System.IO.Directory]::Delete($EntryPath, $false)
  # 删除后必须重新读取确认它真的消失了：读不出来（权限 / 状态异常）同样算复核失败。
  $afterItem = Get-OptionalFileSystemItem -Path $EntryPath -Purpose ($Purpose + "（解除后复核）")
  if ($null -ne $afterItem) {
    throw ("解除插件入口失败（" + $Purpose + "）：" + $EntryPath + " 在非递归删除之后仍然存在，无法确认卸载完成。`n" + "    请人工核对该路径后重试（本脚本不会改用它法强行删除）。")
  }
  return $true
}

# ── 1. 路径解析：DSH_HOME 必须完全限定并解析成真实目录 ─────────────────────────────

$dshHomeInput = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE ".dsh" }
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

$profilesDir = Join-Path $dshHome "profiles"
$profileDir = Join-Path $profilesDir "web"
$profileManifest = Join-Path $profileDir "package.json"

# 本插件在 web profile 内的三条目标路径（调用 CLI remove 之前必须逐条检查，见第 4 节）。
# 为什么单独定义：CLI 会顺着这些路径读/写插件目录，任一条被链接重定向都会让 CLI 操作到
# DSH_HOME 之外的内容；那时再拒绝已经太晚（CLI 已经跑过了）。
# 为什么与第 5 节 copyTargets 的表达式分开写：那边的 Target / Expected 刻意由两条独立表达式构造，
# 好让「删除目标 == 预期目录」的断言不是同义反复；这里只是同名的只读判定基准，两者互不替代。
$pluginEntryDir = Join-Path (Join-Path $profileDir "node_modules") $packageName
$managedPackageDir = Join-Path (Join-Path $dshHome "profiles") ("packages\" + $packageName)
$profilePackageDir = Join-Path (Join-Path $profileDir "packages") $packageName

# 刻意**不在这里**查找 PATH 上的 dsh：只有确认真的需要执行 remove 时才需要 CLI。
# 为什么：本脚本管理的 web 安装副本必须能在「profile 未初始化」「未登记且 bundle 不残留」这些
# 无需 CLI 的状态下被清理干净；若在读取 manifest 之前就无条件要求 PATH 里有 dsh，
# 那么一台只想清理副本、根本没装 dsh CLI 的机器会提前失败，幂等路径永远不可达。
# CLI 的查找与存在性校验放在下面 $registered 分支里（见「查找 PATH 上的 dsh」一节）。

Write-Host "卸载 dsh-expert-group（web profile）..." -ForegroundColor Cyan
# 只在「确实沿链接解析过」时提示：把输入路径与解析结果各自折叠成可比较形式再比。
# 为什么不直接比较两个字符串：两侧的大小写与尾分隔符写法都可能不同（解析结果来自文件系统，
# 输入来自用户环境变量），直接比较会在正常的非链接场景下也「不相等」，打印误导性提示。
$dshHomeKey = ConvertTo-ComparablePath -Path $dshHome
$lexicalHomeKey = ConvertTo-ComparablePath -Path $dshHomeInput
if ($null -eq $dshHomeKey -or $null -eq $lexicalHomeKey -or -not ($lexicalHomeKey -ceq $dshHomeKey)) {
  Write-Host ("  DSH_HOME 是链接，已解析为真实目录：" + $dshHome) -ForegroundColor DarkGray
}

# ── 2. profile 路径隔离（从真实 home 出发逐级检查，全部 fail closed） ───────────────
# profiles 与 profiles\web 这两级必须是「真实非 reparse 目录」；存在但不满足（是链接 / 不是
# 目录 / 读不出属性）一律中止。缺失是允许的：profiles 不存在说明这台机器还没初始化过
# web profile，profile 不存在时下面的 manifest 读取会返回 $null，脚本保持「未初始化也允许
# 清理安装副本」的既有幂等语义，最终由删除目标的存在性判定收尾。
$null = Test-RealDirectoryComponent -Path $profilesDir -Purpose "profiles 目录检查"
$null = Test-RealDirectoryComponent -Path $profileDir -Purpose "web profile 目录检查"

# 读取 profile 清单之前先做一次路径隔离检查：profiles\web（或其祖先）是符号链接 / junction 时，
# 清单与 CLI 操作都会落到 DSH_HOME 之外的真实目录上，必须先 fail closed 中止。
# 调用 CLI remove 之前还会再查一次（见下），把检查与写操作之间的时间窗口压到最小。
Assert-NoReparsePointOnPath -Path $profileManifest -Purpose "profile 路径隔离（读取清单前）"

# ── 3. profile 状态读取（只读；读不到可信状态就不动任何东西） ─────────────────────

# -Encoding UTF8 是硬要求：WinPS 5.1 的 Get-Content 默认按 ANSI 读取，会破坏 UTF-8 manifest 的
# 中文字段并让 ConvertFrom-Json 失败；显式声明使 WinPS 5.1 与 pwsh 7 行为一致。
# 文件不存在时返回 $null（保持既有语义：profile 尚未初始化也允许清理安装副本）；
# 存在但解析失败一律抛错——拿不到可信状态时既不 remove，也不删副本。
function Read-ProfileManifest {
  param([Parameter(Mandatory = $true)][string]$Path)
  $item = Get-OptionalFileSystemItem -Path $Path -Purpose "读取 profile 清单"
  if ($null -eq $item) { return $null }
  try {
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop)
  } catch {
    throw ("无法按 UTF-8 解析 web profile 清单：" + $Path + "`n" + "    " + [string]$_.Exception.Message + "`n" + "    清单不可信时不做任何 remove 或删除，已中止。")
  }
}

# 判断插件是否登记在 manifest 的 dependencies 里。
# 只认 dependencies：dsh.profile.bundles 是 bundle 层配置，单独存在不代表依赖已装上。
function Test-PluginRegistered {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest) { return $false }
  if ($null -eq $Manifest.dependencies) { return $false }
  return ($null -ne $Manifest.dependencies.PSObject.Properties[$packageName])
}

# 判断 bundle 清单里是否仍登记插件名。
function Test-PluginInBundles {
  param([Parameter(Mandatory = $true)]$Manifest)
  if ($null -eq $Manifest) { return $false }
  if ($null -eq $Manifest.dsh) { return $false }
  if ($null -eq $Manifest.dsh.profile) { return $false }
  if ($null -eq $Manifest.dsh.profile.bundles) { return $false }
  foreach ($bundle in @($Manifest.dsh.profile.bundles)) {
    if ([string]$bundle -eq $packageName) { return $true }
  }
  return $false
}

# 先把「清单不存在」与「清单不可信」分成两条路，再决定要不要调 CLI：
#   - 不存在：profile 尚未初始化。此时 registered / inBundles 一律按 $false 处理，不调 CLI，
#     直接进入「只清理本脚本拥有的 web 安装副本」的幂等路径（这是既有的、必须可达的语义）；
#   - 存在但读不出来 / 解析失败：拿不到可信状态，一律中止，既不 remove 也不删副本。
# 为什么必须在这里分流，而不是靠判断函数吞掉 $null：Test-PluginRegistered / Test-PluginInBundles
# 的 $Manifest 是 Mandatory 参数，PowerShell 会在进入函数体之前就拒绝 $null 并抛绑定异常，
# 函数内的 null 判断根本执行不到，于是「未初始化」这条合法路径在旧实现里是不可达的。
# 也不改用 AllowNull：那只是把「缺状态」混进「有状态」的正常流程里，语义仍然模糊；
# 显式分流才能让「未初始化」和「状态不可信」各自得到正确的处置。
$profileManifestItem = Get-OptionalFileSystemItem -Path $profileManifest -Purpose "读取 profile 清单"
$profileInitialized = ($null -ne $profileManifestItem)
$manifest = $null
$registered = $false
$inBundles = $false
if ($profileInitialized) {
  $manifest = Read-ProfileManifest -Path $profileManifest
  $registered = Test-PluginRegistered -Manifest $manifest
  $inBundles = Test-PluginInBundles -Manifest $manifest
}

# ── 4. 卸载：dependencies 与 bundle 的状态必须一致，不一致就 fail closed ──────────

if (-not $registered -and $inBundles) {
  # bundle 层仍登记本插件、但依赖已不存在：profile 处于不一致状态。
  # 这时既不能假装卸载成功，也不该去删安装副本（那会把状态改得更难诊断），直接中止。
  throw ("profile 状态不一致：" + $profileManifest + " 的 dependencies 中没有 " + $packageName + "，但 dsh.profile.bundles 仍包含它。" + "`n" + "    请先人工核对该字段（或手工执行 dsh plugin --profile web remove " + $packageName + "）后再重跑本脚本；本次不做任何删除。")
}

# ── 5. 安装副本安全预检：必须早于「解除插件入口」与「调用 CLI remove」 ─────────────

# 清理 web-install.ps1 复制出的安装副本（全局位置与旧的 profile 内 packages 位置都处理）。
# 与安装白名单语义对齐：web-install.ps1 现在只复制 package.json files 声明的发布面，安装副本
# 自身就是完整的「整包」目录，因此卸载的逆操作仍然是整目录删除，不改成按白名单逐项删除——
# 逐项删除只认同名单，会把旧版整目录复制遗留在用户目录里的 test/、.scratch/、tgz 等
# 残留永久留下，反而破坏卸载的收尾保证。
# Target 与 Expected 由两条独立表达式构造：相等性断言因此不是同义反复，将来任一条被改错都会
# 在这里被拒。
$copyTargets = @(
  @{
    Target = Join-Path (Join-Path $dshHome "profiles") ("packages\" + $packageName);
    Expected = Join-Path $dshHome ("profiles\packages\" + $packageName);
    Boundary = $dshHome
  },
  @{
    Target = Join-Path (Join-Path $profileDir "packages") $packageName;
    Expected = Join-Path $profileDir ("packages\" + $packageName);
    Boundary = $profileDir
  }
)

# 第一阶段（预检）：把所有「存在且将被删除」的目标逐个做安全检查；任一不通过就整体中止，
# 不进入删除阶段，避免出现「删掉一个、另一个因链接被拒」的半完成状态。
#
# 为什么这一轮预检必须**早于**「解除插件入口链接」与 CLI remove（顺序是有意的，勿调回）：
#   - 本脚本自身可回滚的两步是「解除入口」与「删除副本」：只有预检全通过之后才允许它们发生，
#     这样预检失败时**入口与安装副本都保持原状**，用户看到的就是一次干净的中止；
#   - 若把预检放在解除入口之后，就会出现「入口已摘掉、安装副本仍在」的半完成状态：卸载报错，
#     但用户环境已经被改动过，重跑时的路径与首次运行不同，诊断也更难；
#   - **不可回滚的一层（有意记录，勿当成缺陷）**：CLI remove 一旦执行就无法撤销——它已经改写了
#     profile manifest 与它自己的记账。因此「CLI 已跑」这件事无法纳入全有或全无，本脚本能保证的
#     只是「预检全部通过之后才调用 CLI」，以及「CLI 之后的复核失败时不清理任何安装副本」；
#   - 顺序因此固定为：路径隔离检查 -> 清单状态判定 -> **副本安全预检（本节）** -> CLI remove
#     -> manifest 复核 -> 解除插件入口 -> 删除副本（第 6 节）；
#   - 已知代价（有意接受）：预检与真正删除之间的时间窗口因此变长（中间夹着 CLI remove 与入口
#     解除）。这段时间里的并发修改本就不在本脚本的安全保证范围内（见 Remove-ManagedPluginEntryLink
#     的 TOCTOU 说明）；换来的是上面那条更强的原子性，取舍是划算的。
$pendingDeletions = New-Object 'System.Collections.Generic.List[string]'
foreach ($entry in $copyTargets) {
  $item = Get-OptionalFileSystemItem -Path $entry.Target -Purpose "清理安装副本"
  if ($null -eq $item) { continue }
  Assert-SafeDeleteTarget -Target $entry.Target -Expected $entry.Expected -Boundary $entry.Boundary -Purpose "清理安装副本"
  $pendingDeletions.Add($entry.Target)
}

$removed = $false
if ($registered) {
  # 调用期间把 $ErrorActionPreference 降为 Continue：pwsh 7.4+ 的
  # PSNativeCommandUseErrorActionPreference 默认 true，在 Stop 语义下非零退出码会被包装成
  # 终止性错误，导致拿不到 $LASTEXITCODE、也无法给出中文诊断。这里显式保存 / 恢复并判码。
  # 紧前再查一次：从读取清单到这里之间，profiles\web 完全可能被人为换成链接。
  Assert-NoReparsePointOnPath -Path $profileManifest -Purpose "profile 路径隔离（调用 CLI remove 前）"
  # 本插件在 web profile 内的三条目标路径链也必须在**调用 CLI 之前**检查完，一条都不能漏：
  #   <profile>\node_modules\<pkg>  —— pnpm 的 link: 入口（按设计就是一条链接，见 Assert-NoReparsePointExceptManagedEntryLink）
  #   <home>\profiles\packages\<pkg> —— web-install.ps1 复制出的全局安装副本
  #   <profile>\packages\<pkg>       —— 旧版 profile 内安装副本
  # 为什么必须在 CLI 之前：CLI remove 一旦跑起来，它自己就会顺着这些路径去读/写/删 DSH_HOME 之外的
  # 内容，那时再拒绝已经太晚（CLI 已经执行过）。检查失败一律 fail closed，CLI 调用次数保持 0。
  # 只查本插件自己的这三条链，不遍历 node_modules 的其它条目：pnpm 会在那里正常使用符号链接，
  # 递归禁止会误伤正常的依赖布局。
  Assert-NoReparsePointExceptManagedEntryLink -Path $pluginEntryDir -Purpose "插件入口路径隔离（调用 CLI remove 前）" -AllowedLinkPath $pluginEntryDir -AllowedLinkTarget $managedPackageDir
  Assert-NoReparsePointOnPath -Path $managedPackageDir -Purpose "受管理安装副本路径隔离（调用 CLI remove 前）"
  Assert-NoReparsePointOnPath -Path $profilePackageDir -Purpose "profile 内安装副本路径隔离（调用 CLI remove 前）"
  # 查找 PATH 上的 dsh：只有走到这里（$registered 为 true、确实要执行 remove）才需要它。
  # 放在这个位置有两个好处：
  #   1) 未初始化 / 未登记的幂等路径不再因为「机器上没有 dsh」而提前失败（那些路径本来不调 CLI）；
  #   2) 「CLI 不存在」这条诊断只在真正需要 CLI 时出现，不会被误报成「profile 状态有问题」。
  # 找不到就 fail closed：不降级成手工删文件（手工改 profile 会破坏 dsh 自己的一致性假设）。
  $dsh = Get-Command dsh -ErrorAction SilentlyContinue
  if ($null -eq $dsh) {
    throw "未找到 dsh 命令。请先安装 @deepseek-ai/dsh 并确保其 bin 目录在 PATH 中。"
  }
  # 把 $env:DSH_HOME 临时绑定到**已解析的真实目录**：CLI 默认继承调用者的 DSH_HOME（可能是链接），
  # 而本脚本所有的隔离检查都是针对解析后的真实 home 做的。两者指向不同写法时，检查与写操作之间
  # 就存在一个「home 链接在其后被改指向别处」的窗口；绑定后 CLI 与检查指向同一个 home。
  # 已知限制（有意保留）：检查与写操作仍然不是原子的，这里只消除「两者指向不同路径」这一层差异，
  # 不引入额外锁机制。
  $previousDshHome = $env:DSH_HOME
  $dshHomeWasSet = -not [string]::IsNullOrWhiteSpace($previousDshHome)
  $previousPreference = $ErrorActionPreference
  $exitCode = -1
  try {
    $ErrorActionPreference = "Continue"
    $env:DSH_HOME = $dshHome
    & dsh plugin --profile web remove $packageName
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
    throw ("dsh plugin --profile web remove " + $packageName + " 失败，退出码 " + $exitCode + "。profile 可能已被部分修改，请人工核对 " + $profileManifest + " 与 node_modules，不要反复重试；本次不清理安装副本。")
  }
  $removed = $true
}

# 只有真的调用过 remove 才需要复核；未登记时保持既有幂等语义（跳过 remove，继续清理副本）。
if ($removed) {
  # 复核前必须先确认清单**仍然存在**：CLI 成功却把 profile 清单整个删掉（或改成不可读）时，
  # 我们拿不到任何可信状态，既无法证明插件已被移除，也无法证明 profile 还完整。
  # 这里刻意不把「清单消失」当成「卸载成功」——那是 fail open；先 fail closed 中止，不清理副本。
  $afterItem = Get-OptionalFileSystemItem -Path $profileManifest -Purpose "卸载后复核读取清单"
  if ($null -eq $afterItem) {
    throw ("卸载后复核失败：" + $profileManifest + " 在 CLI remove 之后已不存在，无法确认卸载结果与 profile 完整性，本次不清理安装副本。" + "`n" + "    请人工核对 profile 目录后重跑本脚本。")
  }
  $after = Read-ProfileManifest -Path $profileManifest
  if ($null -eq $after) {
    throw ("卸载后复核失败：" + $profileManifest + " 已不可读，无法确认卸载结果，本次不清理安装副本。")
  }
  if (Test-PluginRegistered -Manifest $after) {
    throw ("卸载后复核失败：" + $profileManifest + " 的 dependencies 仍包含 " + $packageName + "。CLI 报告成功但磁盘状态不符，本次不清理安装副本，请人工核对 profile。")
  }
  if (Test-PluginInBundles -Manifest $after) {
    throw ("卸载后复核失败：" + $profileManifest + " 的 dsh.profile.bundles 仍包含 " + $packageName + "。本次不清理安装副本，请人工核对该字段。")
  }
  # manifest 之外还要处理 profile 内的插件入口：CLI 的 remove 只清 manifest 与它自己的记账，
  # 而 pnpm 在 nodeLinker: hoisted 下**不会删除** `link:` 目录依赖的 node_modules 入口
  # （实测语义与代码级原因见 Remove-ManagedPluginEntryLink 的注释），入口因此按预期残留。
  # 残留时若照旧打印「完成」并继续删安装副本，会留下一条**悬挂链接**且用户以为已经卸载干净
  # （fail open），所以这里由本脚本自己解除这条受管理入口链接。
  # 解除只认「本插件入口 -> 受管理安装目录」这一条 junction：普通目录 / 指向别处的链接 /
  # 悬挂链接 / 解析失败一律抛错中止，且不清理任何安装副本（原有 fail closed 语义原样保留）。
  $entryAfterItem = Get-OptionalFileSystemItem -Path $pluginEntryDir -Purpose "卸载后复核插件入口"
  if ($null -ne $entryAfterItem) {
    # 解除成功与否由函数自己复核（非递归删除后会重新读取确认已消失）。任何一步不成立都在函数里
    # 抛错，这里再包一层是为了把「失败发生在卸载收尾阶段、因此本次不清理任何安装副本」这条
    # 结论显式写给用户：否则用户只看到「入口不是链接」，不知道该不该继续清理其它位置的副本。
    try {
      $null = Remove-ManagedPluginEntryLink -EntryPath $pluginEntryDir -ManagedTarget $managedPackageDir -Purpose "卸载后复核插件入口"
    } catch {
      throw ("卸载后复核失败：" + $pluginEntryDir + " 在 CLI remove 之后仍然存在，且无法按「本插件入口 -> 受管理安装目录」这条受管理链接解除它。`n" + "    " + [string]$_.Exception.Message + "`n" + "    本次不清理任何安装副本（状态不明时不做更多改动），也不会去删其它位置的安装副本。`n" + "    请人工核对该路径是普通目录还是链接、以及它指向何处后重试。")
    }
    Write-Host ("  已解除插件入口链接：" + $pluginEntryDir) -ForegroundColor DarkGray
  }
  Write-Host "  CLI remove 完成，且 dependencies 与 dsh.profile.bundles 均已清除" -ForegroundColor DarkGray
} else {
  # 未登记（或 profile 未初始化）的幂等路径：CLI 不参与，但入口链接仍可能残留——典型场景是
  # 上一次卸载已经清掉 manifest、却把入口链接留了下来（旧版本没有解除入口这一步）。
  # 这条路径下若不处理入口，下面会直接删掉链接目标，留下一条**悬挂链接**（fail open）。
  # 因此这里按同一规则校验并解除；普通目录 / 指向别处的链接 / 悬挂链接 / 无法判定一律抛错中止，
  # 且不清理任何安装副本；入口本来就不存在时保持原有的正常清理流程不变。
  $entryUnregisteredItem = Get-OptionalFileSystemItem -Path $pluginEntryDir -Purpose "未登记路径的插件入口复核"
  if ($null -ne $entryUnregisteredItem) {
    $null = Remove-ManagedPluginEntryLink -EntryPath $pluginEntryDir -ManagedTarget $managedPackageDir -Purpose "未登记路径的插件入口复核"
    Write-Host ("  已解除残留的插件入口链接：" + $pluginEntryDir) -ForegroundColor DarkGray
  }
  Write-Host ("  " + $profileManifest + " 中未登记 " + $packageName + "，跳过 CLI remove。") -ForegroundColor Yellow
}

# ── 6. 清理安装副本：删除阶段（预检已在第 5 节全部通过） ───────────────────────────

# 第二阶段：全部检查通过后才真正删除。
foreach ($target in $pendingDeletions) {
  Remove-Item -LiteralPath $target -Recurse -Force
  Write-Host "已清理安装副本：$target" -ForegroundColor DarkGray
}

# ── 7. 明确不删除的内容与已知限制（有意为之，勿改成「顺手清理」） ─────────────────
#   - <profile>\cordis.yml、cordis.patch.yml、pnpm-workspace.yaml：用户配置与模型路由。
#   - 其它 manifest / lock 配置（package.json 里除本插件外的依赖、pnpm-lock.yaml 的其它条目）。
#   - 其它插件与共享依赖：本脚本只经 CLI 移除本插件，不碰 node_modules 里的任何其它条目。
#   - 已存在但不属于本脚本形态的路径（普通目录 / 指向别处的链接 / 悬挂链接）：一律 fail closed
#     中止，绝不替用户删除（见 Remove-ManagedPluginEntryLink 的 fail-closed 边界）。
#
# 已知限制（**有意不处理**，勿在无新决策的前提下「顺手修掉」）：
#   <profile>\node_modules\.bin 下的本插件 shim 会在卸载后残留。
#     现象：卸载完成后 .bin 里仍留着 prompt-inspector、prompt-inspector.CMD、prompt-inspector.ps1
#       三个 shim，内容指向 %~dp0\..\dsh-expert-group\bin\prompt-inspector.mjs；该目标已随安装副本
#       一起被删除，因此误执行这几个 shim 会直接报错（找不到文件），不会静默做错事。
#     成因：与插件入口 junction 残留**同源**——pnpm 在 nodeLinker: hoisted 下不清理 node_modules
#       下的任何条目（含 .bin），CLI 的 remove 只清 manifest 与它自己的记账。
#     为什么不由本脚本清理：.bin 是 **profile 共用目录**，里面还有其它插件（js-yaml、playwright 等）
#       的条目，本机实测共 18 项。要清理就必须先精确判定「哪些 shim 属于本插件」，那需要解析 shim
#       内容或依赖 pnpm 的内部记账，等于引入一个新的删除动作与一套新的安全边界；判错一步就是删掉
#       其它插件的可用 shim。本轮有意不做，宁可留下几个「已失效但无害」的 shim，也不冒险误删。
#     用户侧影响：仅影响手动敲 prompt-inspector 这条命令（会报错）；插件本身的加载与运行不经过 .bin，
#       因此不影响卸载结果的正确性。

Write-Host "完成。重启 DSH Web 后生效。" -ForegroundColor Green
