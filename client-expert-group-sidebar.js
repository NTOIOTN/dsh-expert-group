(function installExpertGroupSidebar(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-sidebar");
  const MODEL_SYMBOL = Symbol.for("dsh-expert-group/client-expert-group-model");
  const MODEL = global[MODEL_SYMBOL] || {};
  const modelApi = () => global[MODEL_SYMBOL] || MODEL;
  /**
   * 右侧栏对外的代理运行状态：默认是 running | ready 两个规范值。
   *
   * unknown 是**轻量（partial）快照专用**的中性值（见 client-expert-group-model.js 的
   * UNKNOWN_RUNTIME_STATUS）：证据不足时不声明运行、也不声明结束。完整快照永远不会产生它，
   * 因此正常渲染、无障碍标签与圆点语义都不受影响。
   */
  const RUNTIME_STATUS_LABELS = Object.freeze({ running: "running", ready: "ready", unknown: "unknown" });
  /**
   * 规范运行状态到 primitives.StateDot 的语义映射：
   * running 用 ongoing（DSH 原生 1 秒追逐动画），ready 用 done（绿色静态圆点），
   * unknown 用 idle——官方词表里唯一「无进展信息」的中性态，既不是进行中也不是已完成。
   * 插件不自造第二套动画，动画只由官方组件提供。
   */
  const RUNTIME_STATE_DOT = Object.freeze({ running: "ongoing", ready: "done", unknown: "idle" });
  // ACTIVE_STATUSES / RETRY_STATUSES 只服务于 fan-out 管理语义（取消/重试判定），不是展示状态词表。
  const ACTIVE_STATUSES = new Set(["queued", "waiting", "running"]);
  const RETRY_STATUSES = new Set(["failed", "timed_out", "interrupted"]);
  // 父任务的规范终态表示全部分片已结算，且不会把未知/展示态误判为空闲。
  const FANOUT_SETTLED_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
  const STYLE_ID = "dsh-expert-group/expert-group-sidebar";
  /**
   * Expert Group 页的右侧栏宽度：**恒为视口宽度的 20%**（1600px 视口 ⇒ 320px）。
   *
   * 这是精确比例，插件不做最小值 clamp；最终落值交给宿主 setRightbar 自己的 clamp。
   * 当用户切到同一右栏里的其它页面时，右栏切到 50% 的可调模式，避免窄栏让新页面
   * 静默回落后再被插件浮出成独立窗口。
   */
  const RIGHTBAR_WIDTH_RATIO = 0.2;
  const OTHER_RIGHTBAR_WIDTH_RATIO = 0.5;
  /**
   * 「宿主里那份右栏宽度是否仍是插件写的」的匹配容差（px）。
   *
   * 面板的实际渲染宽度会被浏览器做子像素取整与布局舍入，不可能与插件写入的整数 target 逐字节
   * 相等；1px 足以覆盖这类规范化，又远小于任何一次真实用户拖拽（拖拽是数十像素量级），因此
   * 不会把「用户已经改过宽度」误判成「还是插件那份值」。
   */
  const RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX = 1;
  /**
   * 同一个「未收敛的宽度 mismatch」允许的**恢复写入**上限（次）。
   *
   * 背景：宿主可能持续 clamp（请求 640，只渲染 320），或 React 延迟若干帧才把新宽度提交到 DOM。
   * 这两种情况下「面板实际渲染宽度 != 插件 target」会一直是真，而它同时又是「宿主夺回了那份 px」
   * 的证据；若每条同步路径（面板 observer / 2.5 秒轮询 / sessions 通知）都据此 force 重写，
   * 就会与宿主的 clamp 无限拉锯：layout store 被同一个值反复改写、宿主反复重渲染（用户看到抖动）。
   *
   * 因此用一份 per-session 状态跟踪同一个恢复事件（session、**当前视口下预期**的 target、
   * 观测到的实际宽度），同一个未收敛 mismatch 最多执行 2 次恢复写入：一次立即恢复 + 一次重试，
   * 足以覆盖「宿主延迟一帧才提交」这类真实时序；再多就只是拉锯。上限**不能**被正常轮询自行重置——
   * 只有观测到实际宽度已经等于 target（收敛）、**预期 target 真的改变**、所有权周期变化或 dispose
   * 时才清除状态。
   *
   * 事件同一性里的 target 必须是**按当前视口算出来的预期值**，而不是「上次成功写入的值」：宿主持续
   * clamp 时，视口从 3200 挪到 3201 / 3202，20% 取整后仍是同一个 640，那份 px 依然代表 20%——
   * 这不是新的一次 mismatch，绝不能因此重新获得预算；只有窗口真正最大化（3200 → 4000，预期
   * 640 → 800）才是一次新事件。否则用户轻微拖动窗口边缘就能无限重写，正是本预算要挡住的形状。
   */
  const RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS = 2;
  /**
   * DEG 的品牌图标 artwork：与宿主「智能体团队」入口同源的双人（users）图标。
   *
   * 4 条 path 逐字节取自宿主 primitives 的 IconUsersOutlineRegular（16×16 网格、1px 描边：
   * 前一人的头/肩轮廓 + 后面第二人的两条轮廓）。宿主新版本已导出该具名组件，运行期优先直接
   * 复用它；本包的依赖版本（0.1.7-alpha.2）只有单人的 IconUserOutlineRegular，因此缺导出时
   * 回落到本模块用同一组 path 构造的等价组件——两条路径下品牌图标的形状完全一致。
   *
   * 这是运行期取用的唯一一份路径数据：侧栏 better tab / 原生 guide 图标与 client.js 的设置页
   * 导航图标都从这里取（client.js 只在侧栏 IIFE 缺失时才用自己那份同值兜底字面量）。
   */
  const BRAND_ICON_PATHS = Object.freeze([
    "M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
    "M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
    "M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
    "M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
  ]);

  /**
   * 右栏 tab 的宿主渲染观测标记（不是 sidebarRight service 的方法契约）。
   *
   * DSH 右栏把停靠 tab 渲染成 `[data-sidebar-right-panel] [data-dockkit-tab="<tabId>"]`，
   * tabId 与 `sidebarRight.active()/close()` 使用的 id 同源。插件只读这些标记判断 tab/列组成；
   * 布局适配只在组成可证明时向 split 容器写入受控的 `grid-template-columns`，不注册自己的
   * class、不改 DOM 结构、也不依赖 CSS module hash。
   *
   * 真实 DockKit 层级（右栏已分栏时）：
   *   [data-sidebar-right-panel][data-sidebar-right-session]
   *     [data-dockkit-split]                     ← 实际列宽由它的内联 grid-template-columns 决定
   *       div[data-dockkit-host="dock"][data-dockkit-column="0"]
   *         [data-dockkit-strip-tabs] > [data-dockkit-tab="<tabId>"]   ← tab 在列的后代里
   *       div[data-dockkit-host="dock"][data-dockkit-column="1"] …
   * `data-dockkit-pane` 只出现在活跃的非浮动 section 上，因此**不能**用它当列的唯一判据。
   */
  const RIGHTBAR_PANEL_SELECTOR = "[data-sidebar-right-panel]";
  /** 面板的会话归属：只有与当前 surface 的会话完全相等才允许被选中。 */
  const RIGHTBAR_PANEL_SESSION_ATTRIBUTE = "data-sidebar-right-session";
  const RIGHTBAR_TAB_SELECTOR = "[data-dockkit-tab]";
  const RIGHTBAR_TAB_ID_ATTRIBUTE = "data-dockkit-tab";
  const RIGHTBAR_PANE_SELECTOR = "[data-dockkit-pane]";
  const RIGHTBAR_PANE_ID_ATTRIBUTE = "data-dockkit-pane";
  const RIGHTBAR_PANE_COLUMN_ATTRIBUTE = "data-dockkit-column";
  /** 分栏容器与 dock 列（cell）的公开标记。 */
  const RIGHTBAR_SPLIT_SELECTOR = "[data-dockkit-split]";
  const RIGHTBAR_SPLIT_ATTRIBUTE = "data-dockkit-split";
  const RIGHTBAR_DOCK_HOST_ATTRIBUTE = "data-dockkit-host";
  const RIGHTBAR_DOCK_HOST_VALUE = "dock";
  /** 列自己的 tab 条容器：tab 芯片是它的后代，不是列/pane 的直接子节点。 */
  const RIGHTBAR_STRIP_TABS_SELECTOR = "[data-dockkit-strip-tabs]";
  const RIGHTBAR_STRIP_TABS_ATTRIBUTE = "data-dockkit-strip-tabs";
  /**
   * 首次分栏后的列宽配比。
   *
   * 用户第一次点行尾 >> 分栏时，宿主把右栏总宽度临时扩到视口的 50%；而 DockKit 的分栏默认
   * 把两条列轨**等分**（`minmax(0,0.5fr) 0px minmax(0,0.5fr)`），于是 Expert Group 页只占
   * 视口的 25%（右栏 1/2 × 50%）。本插件不改宿主那份总宽度（它仍必须是 50%），只按
   * 「列 0 是 Expert Group、列 1 是当前 session 的另一个已知页」这条唯一可证明的组成关系，
   * 把 split 容器的内联 `grid-template-columns` 写成 `minmax(0,0.4fr) 0px minmax(0,0.6fr)`：
   *
   * - grid 轨道按各自的 fr 分配可用宽度，因此 0.4 : 0.6 就是 40% : 60%；
   * - 右栏总宽 50% × 40% = 视口 20%（Expert Group 页），50% × 60% = 视口 30%（子代理页）；
   * - 中间那条 0px 分隔轨由 parseSplitTracks 原样保留，插件绝不改写它（不同 DSH 版本可能
   *   是别的宽度，它不属于配比语义）。
   *
   * 只用这一条内联属性：列内的 flex-grow 不参与真实列宽计算，插件也绝不碰宿主的其它声明。
   */
  const SIDEBAR_SPLIT_EXPERT_TRACK = "0.4";
  const SIDEBAR_SPLIT_OTHER_TRACK = "0.6";
  /**
   * 宿主当前没有内联轨道声明时使用的规范分隔轨。
   *
   * 真实右栏的分隔轨是 0px；只有当 split 上**没有**任何内联 grid-template-columns 时才用它
   * （宿主换成了别的非三轨写法时插件不会写，见 applyRatio 的承载性判定）。
   */
  const SIDEBAR_SPLIT_GAP_TRACK = "0px";
  /** 插件这唯一一次分栏布局写入的属性名（恢复判定与写入共用同一常量）。 */
  const SIDEBAR_SPLIT_TRACK_PROPERTY = "grid-template-columns";
  /** Expert Group 的 kind；兼容旧宿主把 kind 直接用于 data-dockkit-tab 的 DOM 形态。 */
  const EXPERT_GROUP_TAB_IDS = new Set(["dsh-expert-group", "expert-group"]);
  /**
   * DockKit 新版会把 kind 加计数器生成 tabId（例如 dsh-expert-group1）。当 openTabs 暂时
   * 不可读时，仍可从公开 DOM 标记识别这种真实 id；无法识别的随机 id 则保持 fail-closed。
   */
  function isGeneratedExpertGroupTabId(value) {
    return typeof value === "string" && /^(?:dsh-)?expert-group\d+$/.test(value);
  }
  /** 浮动 tab 没有 tabId 属性，只能用 subagentchat body + 打开时的标题做保守正向证据。 */
  const RIGHTBAR_FLOAT_SELECTOR = "[data-dockkit-float]";
  const RIGHTBAR_FLOAT_TITLE_SELECTOR = "[data-dockkit-float-title]";

  /**
   * 外部关闭的确认次数：目标 tab 连续两次被观测到从 DOM 里消失，才把箭头复位成 `>>`。
   *
   * 为什么不是一次：观测点（MutationObserver 回调、2.5 秒轮询、visibilitychange）可能落在宿主
   * 提交窗口的中间态上——面板刚展开、tab 已入 store 但 DOM 还没提交，甚至面板被整体重挂载。
   * 一次缺失不足以证明用户关掉了 tab，而「连续两次缺失」在时间上必然跨越了这些过渡帧。
   * 任一正向证据（tab 节点仍在，或 active() 就是目标 tab）都会把计数清零。
   */
  const SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS = 2;
  /** 打开后等待 active() 提交的最长时间；超时只释放待确认记录，不伪造 << 状态。 */
  const SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS = 15000;
  /**
   * 共享来源账本里「Auto 打开已经发出、tabId 始终没落地」的**占位条目**存活上限。
   *
   * 取值理由：与本地 opening 的等待窗口（SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS，15 秒）对齐——
   * 两者回答的是同一个问题「这次打开还要等多久才算没有落地证据」。窗口内保留占位：它承担「同一个资源
   * 绝不并发第二次 openResource」的去重语义（autoOpenCandidate 的 origin.has(key)）。窗口外释放占位，
   * 让「资源仍 running 且地址上确实没有 tab」的形状能有一次有界重试——每次重试至少间隔一个窗口，
   * 绝不自转（同一批微任务内还有 sidebarAutoFailedKeysRef 失败屏障兜底）。
   *
   * 为什么必须有这条 TTL：占位同时占着归属账本的容量槽位（SIDEBAR_AUTO_KEY_LIMIT = 128），而候选
   * 选择又靠 origin.has(key) 跳过重试。宿主始终没落地该 tab 时，一批占位会把账本占满，Auto 从此
   * 再也开不出任何新 tab——纯可用性故障，而且只有整页刷新（清掉内存账本）才能恢复。
   */
  const SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS = SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS;
  /**
   * 别的 scope（别的 root / sidebar session）的占位回收阈值：留出 4 倍余量，避免打断另一个 surface
   * 仍在进行中的打开动作；超过它还在的占位一律回收（占位本身不是归属证据，回收不会授权任何关闭，
   * 而且别的 scope 的候选选择必须在发出 openResource 前重新核对它自己的 inventory，因此也不可能
   * 因此开出重复 tab）。
   */
  const SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS = 4 * SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS;
  /** 首次 split 的跨 inventory/DOM 提交 deadline，避免临时 50% 状态无限期占用右栏。 */
  const SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS = 15000;
  /** RAF 被后台节流时的短 fallback；只负责放行一次 split 尝试，不改变事务提交 deadline。 */
  const SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS = 250;
  /**
   * 「分栏配比暂不可读」时的短延迟重试参数。
   *
   * 场景：DSH 重启后宿主从持久化布局恢复右栏分栏，第二列的 tab 条 / inventory 归属会**比
   * split 容器晚若干帧**才提交。此时既不能证明组成仍成立，也不能证明组成已失效；旧实现把
   * 「读不出来」直接当成「组成失效」立刻交还宿主，用户看到 40/60 → 50/50 的闪回。
   *
   * 因此这类「暂不可读」只在**已经写进过目标配比**之后进入 pending：保持当前样式并安排一次
   * 短延迟重试（去重：同一时刻最多一个待执行重试），读面恢复后由重试或任何一次既有同步自动
   * 重新落回目标配比。重试预算用尽仍读不出来时按「组成确实失效」交还宿主——预算有界，绝不
   * 无限重排定时器，也不会把 0.4/0.6 无限期留在真实的单列结构上。
   */
  const SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS = 400;
  const SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS = 4;
  /** 侧栏打开状态的复合键分隔符：会话 id、rootSessionId 与资源地址都是单行文本，NUL 不会出现在其中。 */
  const SIDEBAR_TAB_KEY_SEPARATOR = "\u0000";
  /**
   * 右栏 tab 的两个来源。
   *
   * - `auto`：「自动打开」（Auto）本次运行亲手打开的 tab，只有它允许被自动关闭；
   * - `manual`：用户点击箭头打开、或外部已存在但不由本插件自动动作发起的 tab。
   * 双来源是「手动优先」判定唯一依据：自动同步绝不关闭 manual 来源的 tab。
   */
  const SIDEBAR_TAB_ORIGIN_AUTO = "auto";
  const SIDEBAR_TAB_ORIGIN_MANUAL = "manual";
  /**
   * 自动关闭的有界重试上限。
   *
   * 宿主 close(tabId) 可能同步抛错或长期失败；自动同步每 2.5 秒一轮，没有上限就会变成
   * 后台重试风暴。达到上限后只撤销「这是 Auto 打开的」记账（tab 原样留给用户手动关闭），
   * 绝不猜测 tabId、也绝不改用批量关闭入口。
   */
  const SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS = 3;
  /**
   * 自动来源/抑制记集合的条目上限（按插入顺序淘汰最旧一项）。
   *
   * 复合键含 rootSessionId：面板实例跨多个 root 复用时，别的 root 的键在当前快照里无法判定
   * 是否仍然存在（快照只描述当前 root），因此除了「快照里已消失就清理」之外还需要这条上限，
   * 保证长期运行的面板不会无界增长。
   */
  const SIDEBAR_AUTO_KEY_LIMIT = 128;
  /**
   * 宿主 close() 请求的 watchdog 上限。
   *
   * 宿主 closeIn 在 actions / surface 缺失、tab 不存在或 canCloseTab=false 时会静默 no-op，也可能
   * 返回一个永不 settle 的 Promise。没有上限，Auto 的 busy 闸门与 pending 锁就会被一次宿主调用永久
   * 占住（后续候选再也推进不了）。10 秒 = 四次 2.5 秒轮询：足够正常宿主结算，也足够在真实 UI 上
   * 表现为「这一轮让位、下一轮重试」。
   */
  const SIDEBAR_TAB_CLOSE_WATCHDOG_MS = 10000;
  /**
   * close 请求 resolve 之后的验证窗口：resolve 只代表请求完成，绝不代表 tab 已经关闭。
   *
   * 验证只认 readSidebarOpenTabs() 的**精确 tabId** 结果，并沿用既有的
   * SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS = 2 次连续缺失确认（2.5 秒轮询 ⇒ 正常验证窗口约 5 秒）。
   * 10 秒是这条验证链的上限：超时后释放租约、保留 record / origin / attempt，由下一次同步决定重试。
   */
  const SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS = 10000;
  /**
   * watchdog 超时后的迟到结果隔离窗。
   *
   * 宿主 Promise 不可取消：超时之后它仍可能迟到 resolve / reject。隔离窗至少跨过一次 2.5 秒
   * inventory 采样，因此这段时间里同一个 tab 绝不再发第二次 close，迟到结果也就没有机会与新的
   * 一次关闭重叠——它只能作用于仍匹配的旧租约（见 requestSidebarTabClose 的收口）。
   *
   * **这个窗口覆盖不到的边界**（必须由别的证据补齐，绝不能被它假装覆盖）：
   * 1. 它是**固定长度**，只保证「窗口内不重叠」——宿主可能在窗口释放之后才落地一次不可取消的副作用；
   * 2. 它不知道这个 tabId 此刻承载的是谁——宿主可以把已经释放的 tabId 复用给**另一个资源**。
   * 因此「重试之前必须用地址证据证明这个 tabId 仍然是我们要关的那个资源」是独立于本窗口的硬闸门
   * （见 sidebarTabPresenceInInventory 的 contentId 判据与 closeSidebarTabWithLease 的 preflight）：
   * 本窗口只负责把迟到结果的落点钉死在旧租约上，绝不承担「id 没有被复用」这个假设。
   */
  const SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS = 3000;
  /**
   * 自动关闭失败后的冷却慢车道：60 秒起，指数退避 60/120/240/480 秒，上限 15 分钟。
   *
   * 三次快速预算用尽（或「resolve 后 inventory 仍 present」累计三次）后**不再删除 origin**，而是
   * 进入冷却：冷却期内同一个 key 零次 close 请求，origin / record 原样保留，到期后允许一次新的
   * 真实 close（失败则退避到下一档）。
   */
  const SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS = 60000;
  const SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS = 900000;

  /**
   * 关闭租约的四种结算原因。
   *
   * 等待者（用户触发的手动单项与批量）绝不能只看一个布尔「成功/失败」：同一个 tabId 上的两次
   * 关闭可能属于**不同的 key**（宿主把已经释放的 id 回收给了另一个资源），而「上一次结算是
   * recycled」对没有地址证据的等待者什么都不能证明。因此结算必须携带原因，等待者用自己的期望
   * 地址重新探针复核之后再决定下一步（见 closeSidebarTabWithLease 的等待分支）。
   * 布尔写法保留兼容：true ⇒ "closed"、false ⇒ "failed"。
   */
  const SIDEBAR_TAB_CLOSE_SETTLE_REASONS = new Set(["closed", "recycled", "failed", "timeout"]);
  function closeSettleReason(outcome) {
    if (SIDEBAR_TAB_CLOSE_SETTLE_REASONS.has(outcome) === true) return outcome;
    return outcome === true ? "closed" : "failed";
  }

  function object(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function text(value, fallback) {
    if (typeof value !== "string" || value.trim() === "") return fallback;
    return value.trim();
  }

  /**
   * 读取当前视口宽度（px）；读不到（没有 window、非有限数、非正数）时返回 null。
   *
   * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store 的
   * 是像素值；因此「换算」与「视口是否变了」必须共用这一个读面，绝不能在两处各读一次
   * （那会让比例换算与变化检测读到不同的视口）。读不到时返回 null，调用方一律放弃写入，
   * 保留宿主当前值，绝不猜一个宽度。
   */
  function viewportWidthOf() {
    let value = null;
    try { value = globalThis.window?.innerWidth ?? globalThis.innerWidth; } catch { value = null; }
    const width = Number(value);
    return Number.isFinite(width) && width > 0 ? width : null;
  }

  /**
   * 元素查询的三种结果。**必须区分「没命中」与「读面有歧义」**，两者对调用方的含义完全不同：
   *
   * - `missing`：这个选择器在当前 DOM 里确实一个都没命中。它表示「当前宿主版本没有这个读法」，
   *   调用方可以继续尝试其它选择器；
   * - `unique`：恰好命中一个元素，可以当作证据使用；
   * - `ambiguous`：命中多个（读面有歧义，例如新旧 frame 同时残留），或查询本身抛错 / 读面不可用
   *   （无 document、没有 querySelectorAll、代理抛错）。它**不是**「这个读法不存在」，因此绝不允许
   *   被别的选择器「兜底」掩盖掉——把多命中降级成 missing 会让旧节点的唯一候选冒充当前 AppFrame。
   */
  const ELEMENT_QUERY_MISSING = "missing";
  const ELEMENT_QUERY_UNIQUE = "unique";
  const ELEMENT_QUERY_AMBIGUOUS = "ambiguous";

  /**
   * 查询一个选择器，返回 `{ status, element }`（element 只在 unique 时非 null）。
   *
   * 只返回这三种状态，任何异常都归一为 `ambiguous`（读不出来 ≠ 读到了空），绝不抛给调用方，
   * 也绝不按 DOM 顺序取第一个命中：第一个命中无法证明它就是目标元素。
   */
  function elementQueryOf(doc, selector) {
    let nodes = null;
    try {
      if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") {
        return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
      }
      nodes = Array.from(doc.querySelectorAll(selector));
    } catch {
      return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    }
    if (nodes.length === 0) return { status: ELEMENT_QUERY_MISSING, element: null };
    if (nodes.length > 1) return { status: ELEMENT_QUERY_AMBIGUOUS, element: null };
    return { status: ELEMENT_QUERY_UNIQUE, element: nodes[0] };
  }

  /**
   * 解析当前宿主的 AppFrame 根元素；无法**唯一**定位时返回 null。
   *
   * 只用宿主公开的 DOM 标记，与本文件既有的 AppFrame 读法（rightbarTransitionTargets）一致：
   * 1. 主读法 [data-shell-overlay]：覆盖层是 AppFrame 的**直接子节点**，其 parentElement 即 AppFrame；
   * 2. 兜底 [data-rightbar-collapsed] / [data-rightbar-instant]：AppFrame 自己的公开状态属性
   *    （旧宿主可能没有覆盖层）。
   *
   * 歧义传播规则（本函数的 fail-closed 边界）：
   * - 任何一个选择器**多命中或查询异常** → 立刻返回 null，不再看后面的读法：此时读面已经不可信，
   *   让另一个选择器的唯一候选去「兜底」等于用旧 frame 冒充当前 AppFrame；
   * - 只有真正 `missing`（零命中）才继续尝试下一个选择器；
   * - 候选元素去重后必须**恰好一个**：零个表示定位不到 AppFrame，多个不同元素表示读面有歧义
   *   （比如新旧 frame 同时残留），两者都返回 null——调用方按「读不到」处理，绝不挑一个猜。
   */
  function appFrameElementOf(doc) {
    const candidates = [];
    const push = (element) => {
      if (element === null || element === undefined || element.nodeType !== 1) return;
      if (candidates.includes(element) === false) candidates.push(element);
    };
    const overlay = elementQueryOf(doc, "[data-shell-overlay]");
    if (overlay.status === ELEMENT_QUERY_AMBIGUOUS) return null;
    if (overlay.status === ELEMENT_QUERY_UNIQUE) {
      let parent = null;
      try { parent = overlay.element.parentElement ?? null; } catch { parent = null; }
      push(parent);
    }
    for (const selector of ["[data-rightbar-collapsed]", "[data-rightbar-instant]"]) {
      const state = elementQueryOf(doc, selector);
      if (state.status === ELEMENT_QUERY_AMBIGUOUS) return null;
      if (state.status === ELEMENT_QUERY_UNIQUE) push(state.element);
    }
    return candidates.length === 1 ? candidates[0] : null;
  }

  /**
   * 读取当前宿主 AppFrame 的宽度（px）；定位不到、尺寸非法时返回 null。
   *
   * 为什么不能拿 window.innerWidth 顶替：宿主 LayoutController 维护的 layout store 里那份
   * viewportWidth 是用 **AppFrame 根元素的 getBoundingClientRect().width** 更新的，它是右栏宽度
   * 上限 clamp 的参照系，并不恒等于 window.innerWidth（页面缩放、滚动条、外层留白、嵌入形态都会
   * 让两者不等）。把 innerWidth 写进宿主那个权威槽位等于换了一个量去改宿主的判据：frame 比 window
   * 窄时反而抬高上限，写出宿主自己永远不会写的宽度。
   *
   * fail-closed 边界（绝不猜测宿主尺寸）：
   * - AppFrame 定位不到或归属有歧义（见 appFrameElementOf）→ null；
   * - 解析结果就是 document.body / document.documentElement → null：它们是「整个文档」，
   *   不是 AppFrame，宽度语义完全不同，绝不拿它们顶替；
   * - 没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数 → null。
   */
  function hostAppFrameWidthOf() {
    try {
      const doc = globalThis.document;
      const frame = appFrameElementOf(doc);
      if (frame === null) return null;
      if (frame === doc?.body || frame === doc?.documentElement) return null;
      const rect = typeof frame.getBoundingClientRect === "function" ? frame.getBoundingClientRect() : null;
      if (rect === null || typeof rect !== "object") return null;
      const width = Number(rect.width);
      return Number.isFinite(width) && width > 0 ? width : null;
    } catch { return null; }
  }

  /**
   * 取一个方法而不读取它的调用形态。
   *
   * Cordis 的服务代理对未声明属性可能直接抛错，因此属性读取一律包在 try 里；
   * 只返回「确实是函数」的候选，其它（缺失、proxy 抛错、非函数属性）统一按 null 处理，
   * 调用方据此走兼容路径而不是拿到一个到调用时才炸的引用。
   */
  function methodOf(target, name) {
    if (target === null || target === undefined) return null;
    try {
      const candidate = target[name];
      return typeof candidate === "function" ? candidate : null;
    } catch { return null; }
  }

  /**
   * 安全解析一个可选客户端服务（uiWorkspace / sidebarRight / sessions 等）。
   *
   * 每个候选项都按「get(name) → 直接属性」两段式探测：Cordis 的服务代理对未声明服务的
   * 属性读取会抛错，任何一层失败都只表示「这个候选项没有它」，继续看下一个。
   * 查找顺序由调用方给出（本插件约定：显式注入的 deps → tab 的 props.ctx → install ctx），
   * 全部未命中返回 null —— 调用方必须据此走兼容路径，绝不把异常带进渲染路径。
   */
  function resolveClientService(candidates, name) {
    for (const candidate of candidates) {
      if (candidate === null || candidate === undefined) continue;
      try {
        if (typeof candidate.get === "function") {
          const value = candidate.get(name);
          if (value !== null && value !== undefined) return value;
        }
      } catch { /* 未声明服务读取即抛错：按「该候选没有它」处理。 */ }
      try {
        const value = candidate[name];
        if (value !== null && value !== undefined) return value;
      } catch { /* 同上。 */ }
    }
    return null;
  }

  /**
   * DSH 原生 subagentchat 侧栏资源地址前缀。
   * 与 `@deepseek-ai/dsh-client-ui-subagent` 的 SUBAGENT_CHAT_ADDRESS 同值：
   * 地址由宿主原生 tab 类型解析，插件只负责生成同一个规范形状。
   */
  const SUBAGENT_CHAT_ADDRESS_PREFIX = "dsh-resource://subagentchat/session/";
  /** `sidebarRight.openResource` 的 kind：声明「这个地址由 subagentchat tab 认领」。 */
  const SUBAGENT_CHAT_KIND = "subagentchat";
  /**
   * 目录项 mode 的三个规范值（0.1.7-alpha.2 新增 `unknown`）。
   *
   * `unknown` 表示宿主的父目录只保留了身份、尚未解析出可续接性（读取 child 会话历史后才能确定）。
   * 插件因此按**不可续接**降级展示：地址照旧可构造（宿主原生主视图与侧栏都能处理该值），
   * 但不显示任何「可继续」相关文案或续接入口。已知模式（one-shot / continuable）行为完全不变。
   */
  const SUBAGENT_MODES = new Set(["one-shot", "continuable", "unknown"]);

  /**
   * 把任意来源的地址候选归一为 SubagentAddress（{ parentSessionId, childSessionId, mode }）。
   *
   * 只接受三个字段齐全、mode 是规范值（含新增的 `unknown`）的对象；字段名兼容 DSH 的正式命名
   * 与目录项里常见的别名（parentId / id / sessionId），任何缺失或非法值都返回 null（fail-closed）。
   */
  function normalizeSubagentAddress(value) {
    const source = object(value);
    const parentSessionId = text(source.parentSessionId, text(source.parentId, null));
    const childSessionId = text(source.childSessionId, text(source.id, text(source.sessionId, null)));
    const mode = text(source.mode, null);
    if (parentSessionId === null || childSessionId === null || mode === null) return null;
    if (SUBAGENT_MODES.has(mode) !== true) return null;
    return { parentSessionId, childSessionId, mode };
  }

  /**
   * 构造 subagentchat 资源地址：
   * `dsh-resource://subagentchat/session/<encodeURIComponent(child)>?parent=<URLSearchParams(parent)>&mode=<URLSearchParams(mode)>`。
   *
   * 路径段与查询串分别复用 DSH 原生实现的编码方式（查询串由 URLSearchParams 生成，空格为 +），
   * 因此宿主原生侧栏聊天 tab 能直接解析并定位到该子代理会话。地址不可构造时返回 null。
   */
  function subagentChatAddress(value) {
    const address = normalizeSubagentAddress(value);
    if (address === null) return null;
    const query = typeof global.URLSearchParams === "function"
      ? new global.URLSearchParams({ parent: address.parentSessionId, mode: address.mode }).toString()
      : "parent=" + encodeAddressPart(address.parentSessionId) + "&mode=" + encodeAddressPart(address.mode);
    return SUBAGENT_CHAT_ADDRESS_PREFIX
      + encodeAddressPart(address.childSessionId)
      + "?" + query;
  }

  /** 资源地址里的会话 id 按 DSH 的规范做路径百分号编码；查询串优先由 URLSearchParams 负责编码。 */
  function encodeAddressPart(value) {
    const raw = String(value);
    return typeof encodeURIComponent === "function" ? encodeURIComponent(raw) : raw;
  }

  /**
   * 侧栏打开状态的复合键：sessionId + rootSessionId + 资源地址。
   *
   * DSH 的 Tab 域按（Session，tabId）保留记录；同一个 root 可能在 root/child surface 各有一份
   * session-scoped 右栏。因此键必须同时含当前 session、所属 root 和资源地址，避免把一个 surface
   * 的关闭箭头或 tabId 借给另一个 surface。
   */
  function sidebarTabKey(sessionId, rootSessionId, resourceAddress) {
    return String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR
      + String(rootSessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(resourceAddress);
  }

  /**
   * 「同一个 tab 的关闭在途」锁的复合键：sessionId + rootSessionId + 宿主 tabId。
   *
   * 与 sidebarTabKey（按资源地址记账）刻意不同：同一个资源地址在别的 session / 别的 root 里对应的是
   * 另一个右栏 tab，只有 tabId 才能证明「宿主正在处理同一个 tab」。关闭的副作用作用在 tabId 上，
   * 因此重复关闭的判据也只能是 tabId。
   */
  function sidebarTabCloseKey(sessionId, rootSessionId, tabId) {
    return String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR
      + String(rootSessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(tabId);
  }

  function sessionEntries(value) {
    if (value == null) return [];
    if (Array.isArray(value)) {
      if (value.every((entry) => Array.isArray(entry) && entry.length >= 2)) return value;
      return value.map((entry, index) => [String(index), entry]);
    }
    if (typeof value.entries === "function") {
      try { return Array.from(value.entries()); } catch { return []; }
    }
    if (typeof value === "object") return Object.entries(value);
    return [];
  }

  function sessionIdOf(value, fallback) {
    const source = object(value);
    return text(source.sessionId, text(source.id, text(fallback, null)));
  }

  /**
   * 读取宿主当前可见的会话。
   *
   * 旧版 DSH 在 sessions 快照上提供 `current` 字段；0.1.6-alpha.2 的
   * SessionListState 已移除该字段，当前主视图改由对应会话的
   * `retainedBy.mainView > 0` 表示。这里集中兼容两种公开快照形状，避免自动打开、
   * 原生回退和面板首屏各自维护一份过期的 current 读取逻辑。
   */
  function currentSessionIdOf(snapshot) {
    const source = object(snapshot);
    const explicit = text(source.current, null);
    if (explicit !== null) return explicit;
    // 兼容未来/过渡宿主把当前会话包装成 { id/sessionId } 的只读值。
    const currentObject = sessionIdOf(source.current, null);
    if (currentObject !== null) return currentObject;
    // 显式 current=null 是宿主报告「当前没有可见 surface」，不能再用 retainedBy.mainView
    // 的旧兼容证据把已经消失的会话复活，否则事务取消永远看不到 session-null 边沿。
    if (source.current === null) return null;
    const named = text(source.currentSessionId, text(source.activeSessionId, null));
    if (named !== null) return named;
    for (const [fallback, value] of sessionEntries(source.byId ?? source.sessions)) {
      const summary = object(value);
      const retainedBy = object(summary.retainedBy);
      const mainView = retainedBy.mainView;
      if ((typeof mainView === "number" && mainView > 0) || mainView === true) {
        return sessionIdOf(summary, fallback);
      }
    }
    return null;
  }

  function parentIdOf(value) {
    const source = object(value);
    const origin = object(source.origin);
    return text(source.parentId, text(source.parentSessionId, text(origin.parentId, text(origin.parentSessionId, null))));
  }

  function listSnapshot(deps, ctx) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.getSnapshot === "function") {
      try { return list.getSnapshot() || {}; } catch { return {}; }
    }
    if (typeof sessions?.getSnapshot === "function") {
      try { return sessions.getSnapshot() || {}; } catch { return {}; }
    }
    return sessions?.snapshot || {};
  }

  function rootIdsOf(deps, ctx) {
    const snapshot = listSnapshot(deps, ctx);
    const entries = sessionEntries(snapshot.byId ?? snapshot.sessions ?? snapshot);
    const sessions = new Map();
    for (const [fallback, value] of entries) {
      const id = sessionIdOf(value, fallback);
      if (id !== null) sessions.set(id, value);
    }
    const roots = new Set();
    for (const [id, value] of sessions) {
      let rootId;
      if (typeof deps.resolveRootSessionId === "function") {
        try { rootId = deps.resolveRootSessionId(id, value, snapshot); } catch { rootId = undefined; }
      }
      rootId = text(rootId, null);
      if (rootId === null) {
        let current = id;
        const visited = new Set();
        while (!visited.has(current)) {
          visited.add(current);
          const parent = parentIdOf(sessions.get(current));
          if (parent === null || parent === current || !sessions.has(parent)) break;
          current = parent;
        }
        rootId = current;
      }
      if (rootId !== null) roots.add(rootId);
    }
    // 会话列表还没 hydration 时，当前会话仍是一个可寻址的根。
    if (roots.size === 0) {
      const current = currentSessionIdOf(snapshot);
      if (current !== null) {
        let rootId = current;
        if (typeof deps.resolveRootSessionId === "function") {
          try { rootId = text(deps.resolveRootSessionId(current, undefined, snapshot), current); } catch { /* 使用 current。 */ }
        }
        roots.add(rootId);
      }
    }
    return [...roots];
  }

  /**
   * 自动打开目标：所有已知 root 会话 ∪ 宿主当前可见会话。
   *
   * 右侧栏页面是按会话 surface 挂载的：root 会话与 child（子代理）会话各自有自己的
   * surface。只遍历 root 会让「用户当前正在看的 child 会话」永远不自动打开，因此把
   * 当前会话也纳入目标——它本身可能就是 child，也可能是一个尚未进入 byId 的 root。
   *
   * 目标按会话 id 精确去重（Set）：root 与 child 是不同 surface，不会互相折叠；
   * 当前会话恰好等于某个已知 root 时也只保留一项。root 排在前面，保持原有打开顺序。
   */
  function openTargetIdsOf(deps, ctx) {
    const targets = new Set(rootIdsOf(deps, ctx));
    const current = currentSessionIdOf(listSnapshot(deps, ctx));
    if (current !== null) targets.add(current);
    return [...targets];
  }

  function subscribeSessions(deps, ctx, listener) {
    const sessions = deps.sessions || ctx?.sessions;
    const list = sessions?.list;
    if (typeof list?.subscribe === "function") {
      try { return list.subscribe(listener); } catch { return () => {}; }
    }
    if (typeof sessions?.subscribe === "function") {
      try { return sessions.subscribe(listener); } catch { return () => {}; }
    }
    return () => {};
  }

  /**
   * 解析「打开会话」入口：只使用工作区服务的公开导航面 `uiWorkspace.openSession(target)`。
   *
   * 返回 `{ open, acceptsAddress, available }`：
   * - `open(target)`：真正可调用的导航入口；
   * - `acceptsAddress`：该入口是否认识 SubagentAddress；
   * - `available`：宿主是否提供了这个入口。为 false 时调用方**不渲染**任何导航入口，
   *   绝不显示点了没反应的按钮（已删除的 `sessions.open` / `ctx.sessions.open` /
   *   历史 `deps.openSession` 回退全部移除：0.1.7-alpha.2 只有工作区服务这一个入口）。
   *
   * 入口只在「确实取到了 openSession 方法」时才算可用；属性读取抛错（未声明服务）、
   * 方法缺失、非函数一律按不可用处理。
   */
  function getOpenSession(deps, ctx) {
    const workspace = resolveClientService([deps, ctx, deps?.ctx], "uiWorkspace");
    const openWorkspaceSession = methodOf(workspace, "openSession");
    if (openWorkspaceSession !== null) {
      return {
        open: (target) => openWorkspaceSession.call(workspace, target),
        acceptsAddress: true,
        available: true,
      };
    }
    return { open: () => {}, acceptsAddress: false, available: false };
  }

  /** fan-out 管理状态：只用于取消/重试判定与 data-task-status，不作为展示状态词。 */
  function statusOf(node) {
    const value = text(object(node).status, "unknown");
    return value || "unknown";
  }

  /**
   * 逐动作能力读取（票据 09）：只有 Host 明确给出 allowed 布尔时才作为权威。
   *
   * 返回 true/false/null：
   * - true/false：严格按能力渲染（Host 是唯一判定来源）；
   * - null：旧 Host/旧快照没有该字段（或形状非法）→ 调用方回退既有的
   *   ACTIVE_STATUSES / RETRY_STATUSES 推导，兼容未升级的 Host。
   * 这里刻意不把「有 capabilities 但缺该动作」当成允许：缺项与缺失整块同义，都回退。
   */
  function capabilityAllowed(node, action) {
    const capabilities = object(object(node).capabilities);
    const entry = object(capabilities[action]);
    return typeof entry.allowed === "boolean" ? entry.allowed : null;
  }

  /**
   * 规范运行状态（展示与图标唯一使用的状态）。
   * 模型可用时由模型按官方源字段归一，模型缺失时才退回可证明的 running 布尔。
   */
  function runtimeStatusOf(node, entry, options) {
    const model = modelApi();
    if (typeof model.runtimeStatusOf === "function") return model.runtimeStatusOf(node, entry, options);
    // 模型缺失的降级路径：没有证据链可判，轻量快照下一律中性。
    if (options?.partial === true && object(node).running !== true) return "unknown";
    return object(node).running === true ? "running" : "ready";
  }

  /**
   * 官方目录项的查找表工厂：把会话投影 `projectionsBySession[parentId].values.subagentCatalog`
   * 预建为 parentId → (childId → entry) 的两级 Map，消除「每渲染一行就线性扫描一次目录」的成本
   * （大列表下渲染成本曾随条目数线性放大）。
   *
   * 0.1.7-alpha.2 的目录项只保证身份类字段（id / createdAt / mode / label），**不再带 activity**：
   * 「这个子代理是否在运行」必须从 byId 投影的 `SessionSummary.running` 派生（与 DSH 原生
   * 子代理目录同一算法）。因此这里在不改变其他字段的前提下补一个 activity：
   * - 目录项自带合法 activity（running/inactive）时原样保留，不覆盖更强证据；
   * - 否则用 byId 的布尔 running 派生 running/inactive；
   * - byId 也没有布尔 running 时保持缺失，由模型的活动证据链继续回退到 DEG 元数据，
   *   绝不把未知猜成「未运行」。
   * 任务标题与元数据仍只在渲染层从 byId 与 DEG 元数据读取，本表不产出展示文案。
   *
   * 逐条对齐旧线性扫描的语义，保证渲染行为零变化：
   * - 目录缺失、非数组、投影快照形状不符时按空目录处理（查不到任何条目）；
   * - id 取 entry.id，缺失时回退 entry.sessionId，且沿用 text() 的去空白口径；
   * - 重复 id 保留**第一个**匹配项（旧扫描在首处匹配即返回）；
   * - 每个 parentId 的桶按需构建一次并缓存在闭包里：同一帧内同一父节点的所有行共用
   *   同一份表，整帧的总成本从 O(行数 × 条目数) 降到 O(条目数)。
   */
  function createCatalogLookup(snapshot) {
    const tables = new Map();
    const tableFor = (parentId) => {
      const cached = tables.get(parentId);
      if (cached !== undefined) return cached;
      const table = new Map();
      const projection = object(object(object(snapshot).projectionsBySession)[parentId]);
      const values = object(projection.values);
      const entries = Array.isArray(values.subagentCatalog) ? values.subagentCatalog : [];
      for (const entry of entries) {
        const source = object(entry);
        if (source.kind === "diagnostic") continue;
        const id = text(source.id, text(source.sessionId, null));
        // 先到先得：与旧的「首个匹配即返回」保持同序同结果。
        if (id !== null && !table.has(id)) table.set(id, withSessionActivity(source, snapshot, id));
      }
      tables.set(parentId, table);
      return table;
    };
    return (parentId, childId) => {
      if (parentId === null || childId === null) return null;
      const table = tableFor(parentId);
      return table.has(childId) ? table.get(childId) : null;
    };
  }

  /** 目录 activity 的两个规范值（0.1.7-alpha.2 的目录投影不再携带，由 byId 的 running 派生）。 */
  const CATALOG_ACTIVITIES = new Set(["running", "inactive"]);

  /**
   * 给目录项补上活动证据：目录自带合法 activity 时原样返回，否则从 byId 的布尔 running 派生。
   * 两处证据都没有时返回原对象（保持「未知」，交由模型的活动证据链继续回退）。
   */
  function withSessionActivity(entry, snapshot, sessionId) {
    if (CATALOG_ACTIVITIES.has(text(entry.activity, null)) === true) return entry;
    const running = sessionRunningOf(snapshot, sessionId);
    if (running === null) return entry;
    return { ...entry, activity: running ? "running" : "inactive" };
  }

  /**
   * 权威会话标题：只接受 sessions 快照的 byId[id].title。
   * displayTitle 会在没有标题时回落到 session id，因此绝不拿它当标题文案。
   */
  function authoritativeTitleOf(snapshot, sessionId) {
    if (sessionId === null) return null;
    const summary = object(object(object(snapshot).byId)[sessionId]);
    return text(summary.title, null);
  }

  /**
   * byId 投影里的会话运行状态（官方活动轴）。
   *
   * 0.1.7-alpha.2 的子代理目录投影只保证身份类字段（id/createdAt/mode/label），不再携带
   * activity，因此「这个子代理是否在运行」必须从 byId 投影的 SessionSummary.running 读取；
   * 非布尔（快照缺失、字段缺失）返回 null，调用方继续回退到 DEG 自己的元数据证据。
   */
  function sessionRunningOf(snapshot, sessionId) {
    if (sessionId === null) return null;
    const summary = object(object(object(snapshot).byId)[sessionId]);
    return typeof summary.running === "boolean" ? summary.running : null;
  }

  /**
   * 第三行动态摘要：模型可用时复用 DSH 原生代理行的同源组合，否则只保留权威标题。
   * 根节点是导航树入口，不代表可恢复的专家执行，因此明确省略 mode，只保留 title/activity。
   */
  function agentSummaryOf(node, entry, title) {
    const model = modelApi();
    if (typeof model.formatAgentSummary === "function") {
      const source = object(node);
      if (source.kind === "root") {
        // 不改变普通专家的 mode 语义；root-only 副本同时屏蔽目录 mode 与 continuable 回退。
        const rootEntry = entry === null || entry === undefined ? entry : { ...object(entry), mode: undefined };
        const rootNode = { ...source, continuable: undefined };
        return model.formatAgentSummary({ title, entry: rootEntry, node: rootNode });
      }
      return model.formatAgentSummary({ title, entry, node });
    }
    return text(title, "");
  }

  function metadataOf(node) {
    const model = modelApi();
    if (typeof model.formatExpertMetadata === "function") return model.formatExpertMetadata(node);
    const source = object(node);
    return [text(source.role, source.kind === "root" ? "Orchestrator" : "Expert"), text(source.provider, "未知供应商"), text(source.model, "未知模型"), text(source.effort, "默认")].join(" · ");
  }

  /**
   * 第一行文案。
   *
   * - 根节点固定为中文「主代理」：绝不显示 root taskName/title/displayTitle/session id，
   *   也不接受任何 session- 前缀回退；根会话的权威标题只出现在第三行摘要里。
   * - 普通专家节点继续显示 Host 投影的最新 dispatch 短描述（context.label /
   *   lastDispatch.description / 冷会话标题），重复 dispatch 后即为最新描述。
   * - fan-out 分支标题保留 role、分片数与规范运行状态词。
   */
  function titleOf(node) {
    const source = object(node);
    if (source.kind === "fanout") {
      const role = text(source.role, "Expert");
      const count = Array.isArray(source.shards) ? source.shards.length : 0;
      return role.charAt(0).toUpperCase() + role.slice(1) + " · " + count + " shards · " + RUNTIME_STATUS_LABELS[runtimeStatusOf(source, null)];
    }
    if (source.kind === "root") return "主代理";
    return text(source.taskName, "未命名任务");
  }

  /**
   * 具名图标（仅用于折叠箭头与 fan-out 取消/重试动作）。
   *
   * 图标词表按 0.1.7-alpha.2 契约：后缀编码**描边粗细**（`*Regular` = 1px，`*Medium` = 1.3px），
   * 渲染尺寸由 `size` prop 承载；旧的 `*14` / `*16` 后缀名在该版本已全部消失。
   * 这里的 IconWarningOutlineRegular 只是「具名图标缺失」时的通用兜底图标，
   * 与代理运行状态无关：运行状态只由 StateDot 表达。
   * 兜底名本身也必须是 alpha.2 存在的导出，否则 `createElement(undefined)` 照样会渲染报错。
   */
  function makeIcon(primitives, name, props) {
    const Icon = primitives?.[name] || primitives?.IconWarningOutlineRegular;
    return typeof Icon === "function" ? Icon(props || { size: 14 }) : null;
  }

  /**
   * DEG 品牌图标组件（双人 users 图标）：better tab 与原生 guide 卡片共用同一个组件。
   *
   * 解析顺序刻意是「宿主优先、内联回落」：
   * 1. 宿主 primitives 导出了 IconUsersOutlineRegular 时直接用它——官方 artwork 将来改稿，
   *    插件自动跟随，不需要同步维护第二份形状定义；
   * 2. 该导出缺失（旧宿主 / 本包依赖的 alpha.2）时，用同一组 BRAND_ICON_PATHS 构造等价组件，
   *    保证任何宿主版本下看到的都是同一个图标；
   * 3. react 不可用（契约外直载安装）时返回 null；调用方据此整条 icon 字段都不写，
   *    注册契约的其余部分逐字节不变，install 绝不因缺依赖抛错。
   *
   * props 只消费 `size` 与 `className`（与宿主 IconProps 一致）：尺寸由调用方注入，插件的
   * 内联组件不固定渲染尺寸，也不引入第二套描边粗细。
   */
  function createBrandIcon(react, primitives) {
    if (typeof primitives?.IconUsersOutlineRegular === "function") return primitives.IconUsersOutlineRegular;
    if (typeof react?.createElement !== "function") return null;
    return function DegBrandIcon(props) {
      const size = props?.size ?? 16;
      // 4 条 path 逐条作为独立 child 传入（而不是传一个数组）：真实 React 与测试替身看到的
      // 子节点形状一致，断言「4 条 path」时不需要额外展平；key 用 path 数据本身，
      // 四条 d 互不相同，重渲染时不会错位复用。
      return react.createElement("svg", {
        width: size,
        height: size,
        viewBox: "0 0 16 16",
        fill: "none",
        className: props?.className,
        "aria-hidden": "true",
        strokeWidth: 1,
        xmlns: "http://www.w3.org/2000/svg",
      }, ...BRAND_ICON_PATHS.map((d) => react.createElement("path", {
        key: d,
        d,
        stroke: "currentColor",
        fill: "none",
      })));
    };
  }

  /**
   * 状态圆点：优先使用注入的官方 primitives.StateDot。
   * running → state:ongoing（DSH 原生 1 秒追逐动画），ready → state:done（绿色静态圆点）。
   * 只有官方组件不可用时才退化为无动画的静态圆点——插件不复制也不改写原生动画。
   */
  function stateDotOf(react, primitives, status) {
    const StateDot = primitives?.StateDot;
    if (typeof StateDot === "function") {
      return react.createElement(StateDot, { state: RUNTIME_STATE_DOT[status] || RUNTIME_STATE_DOT.ready });
    }
    return react.createElement("span", {
      className: "deg_expert_group_state_dot",
      "data-state": status,
      "aria-hidden": "true",
    });
  }

  /** 状态图标：外层 span 承担无障碍名称，内容始终是规范运行状态的圆点。 */
  function statusIcon(react, primitives, status) {
    const label = RUNTIME_STATUS_LABELS[status] || RUNTIME_STATUS_LABELS.ready;
    return react.createElement("span", {
      className: "deg_expert_group_status_icon",
      role: "img",
      "aria-label": label,
      title: label,
      "data-status": status,
    }, stateDotOf(react, primitives, status));
  }

  function safeNormalize(raw) {
    const model = modelApi();
    if (typeof model.normalizeExpertGroupSnapshot !== "function") return null;
    try { return model.normalizeExpertGroupSnapshot(raw); } catch { return null; }
  }

  /**
   * 结构相等比较（只用于上屏内容的「有没有真的变化」判定）。
   *
   * 输入是 normalizeExpertGroupSnapshot 逐字段重建出来的纯数据：只有原始值、数组与普通对象，
   * 无函数、无循环引用，因此不需要序列化，也不需要防环弱表。
   *
   * 实现刻意做到「无分配 + 第一处不同即早退」：空闲轮询的典型输入是整棵树完全相同，此时
   * 只做一次遍历、不产生任何中间对象；一旦真有变化（通常发生在树的浅层），比较立刻返回 false，
   * 把成本降到常数级。旧实现每次都把响应当作变化、整树重新渲染，这才是热点。
   */
  function snapshotContentEquals(left, right) {
    if (Object.is(left, right)) return true;
    if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
    if (Array.isArray(left) || Array.isArray(right)) {
      if (Array.isArray(left) !== Array.isArray(right) || left.length !== right.length) return false;
      for (let index = 0; index < left.length; index += 1) {
        if (snapshotContentEquals(left[index], right[index]) !== true) return false;
      }
      return true;
    }
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    for (const key of leftKeys) {
      if (Object.prototype.hasOwnProperty.call(right, key) !== true) return false;
      if (snapshotContentEquals(left[key], right[key]) !== true) return false;
    }
    return true;
  }

  /**
   * 两次归一化快照「上屏内容」是否等价。
   *
   * 只比较真正影响渲染的部分：schemaVersion、sessionId、rootSessionId 与 root 子树。
   * 顶层 generatedAt 必须显式忽略——Host 每次响应都填新的 Date.now()，把它算进比较等于
   * 「每次轮询都是新内容」，内容比较就彻底失效，也就回到了每次全树重渲染。
   *
   * 比较方向是单向的：内容相等 ⇒ 不更新状态；内容不等 ⇒ 一定更新，绝不吞掉真实变化。
   */
  function samePanelSnapshot(left, right) {
    if (left === right) return true;
    if (left === null || left === undefined || right === null || right === undefined) return false;
    return left.schemaVersion === right.schemaVersion
      && left.sessionId === right.sessionId
      && left.rootSessionId === right.rootSessionId
      // partial 必须参与比较：任务树内容恰好一致时（轻量快照与完整快照投影结果相同），
      // 从 partial→完整 的升级仍要上屏，否则中性渲染会一直留在界面上。
      && (left.partial === true) === (right.partial === true)
      // recovery 必须参与比较：恢复成功/失败切换时任务树可能一字未变，但错误横幅必须
      // 立刻出现或消失——漏掉它会让「重试成功」停在旧横幅上（反之亦然）。
      && snapshotContentEquals(left.recovery ?? null, right.recovery ?? null)
      && snapshotContentEquals(left.root, right.root);
  }

  /**
   * 注入侧声明 RPC adapter 协议的字段名。
   *
   * 历史实现按被调用函数的 `length >= 2` 猜测 adapter 是 connection-first 还是 request-first：
   * 默认参数、rest 参数、bind 与 wrapper 都会改变 `Function.length`（例如
   * `(...args) => base(...args)` 的 length 是 0），判定会因此翻到错误的一侧。
   * 现在协议只能由注入侧显式声明，判定完全不读取被调用函数的形态。
   */
  const RPC_ADAPTER_PROTOCOL_FIELD = "rpcAdapterProtocol";
  /**
   * RPC adapter 的三种合法调用约定。
   *
   * - object：新公开契约 `fn({ connection, request, init })`，参数含义与顺序无关；
   * - connection-first：v1 契约 `fn(connection, request, init)`，本插件长期注入的形状，
   *   也是未声明协议时的默认兼容边界；
   * - request-first：v1 的另一种最小约定 `fn(request, connection, init)`。它在旧实现里
   *   只能靠 arity 猜出来，现在必须由注入侧显式声明才生效。
   */
  const RPC_ADAPTER_PROTOCOLS = Object.freeze({
    object: "object",
    "connection-first": "connection-first",
    "request-first": "request-first",
  });

  /**
   * 解析当前注入的 RPC adapter 协议。
   *
   * 协议判定的唯一来源是注入侧（deps）的显式声明，因此默认参数、rest、bind、wrapper
   * 以及任何函数形态变化都不可能改变调用约定。
   *
   * 兼容边界：未声明（缺字段、null、空串或纯空白）按 v1 的 connection-first 调用——
   * client.js 注入的 requestPluginRpc 正是这个形状，历史宿主不需要任何改动。需要
   * request-first 或对象参数的历史/新 adapter 必须显式声明。
   *
   * 声明了未知协议时 fail-closed 抛出明确错误，绝不回落到猜测：静默按错误的参数顺序
   * 调用会得到难以定位的传输层错误，明确拒绝才能让宿主立刻发现问题。
   */
  function rpcAdapterProtocolOf(deps) {
    const declared = deps?.[RPC_ADAPTER_PROTOCOL_FIELD];
    if (declared === undefined || declared === null || declared === "") return RPC_ADAPTER_PROTOCOLS["connection-first"];
    if (typeof declared !== "string") throw new TypeError("RPC adapter 协议标识必须是字符串");
    const protocol = declared.trim();
    if (protocol === "") return RPC_ADAPTER_PROTOCOLS["connection-first"];
    if (protocol === RPC_ADAPTER_PROTOCOLS.object
      || protocol === RPC_ADAPTER_PROTOCOLS["connection-first"]
      || protocol === RPC_ADAPTER_PROTOCOLS["request-first"]) return protocol;
    throw new Error("未知的 RPC adapter 协议：" + protocol);
  }

  /**
   * 按声明的协议组装调用实参。
   *
   * init 必须原样透传：adapter 依赖它把 AbortSignal 交给 Connection 或同源 fetch，
   * 也依赖它决定两条传输的 error/envelope 语义。
   */
  function rpcAdapterArguments(protocol, ctx, request, init) {
    const connection = ctx?.connection;
    if (protocol === RPC_ADAPTER_PROTOCOLS.object) return [{ connection, request, init }];
    if (protocol === RPC_ADAPTER_PROTOCOLS["request-first"]) return [request, connection, init];
    return [connection, request, init];
  }

  async function callRpc(deps, ctx, request, init = {}) {
    const fn = deps.requestPluginRpc;
    if (typeof fn !== "function") throw new Error("当前 DSH 未提供插件 RPC");
    const protocol = rpcAdapterProtocolOf(deps);
    const response = await fn(...rpcAdapterArguments(protocol, ctx, request, init));
    if (response?.ok === false) throw new Error(text(response.error?.message, "RPC 请求失败"));
    if (typeof response?.json === "function") {
      const payload = await response.json();
      if (payload?.ok === false) throw new Error(text(payload.error?.message, "RPC 请求失败"));
      const body = payload?.value ?? payload;
      return body?.snapshot ?? body;
    }
    if (response?.value !== undefined) return response.value?.snapshot ?? response.value;
    return response?.snapshot ?? response;
  }

  function styleTag() {
    if (typeof document === "undefined" || typeof document.createElement !== "function") return;
    if (document.querySelector?.("style[data-plugin-css=\"" + STYLE_ID + "\"]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-expert-group";
    tag.dataset.pluginCss = STYLE_ID;
    tag.textContent = [
      ".deg_expert_group{display:flex;flex-direction:column;min-width:0;height:100%;overflow:auto;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);font-size:12px;line-height:16px}",
      ".deg_expert_group_header{display:flex;align-items:center;min-height:28px;gap:6px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}",
      ".deg_expert_group_header_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".deg_expert_group_header_action,.deg_expert_group_chevron,.deg_expert_group_action,.deg_expert_group_sidebar_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".deg_expert_group_header_action{width:24px;height:24px;margin-left:auto}",
      // 标题栏 Auto 开关：紧凑到与标题同一行，右对齐且不换行，绝不遮挡标题或右侧操作按钮。
      ".deg_expert_group_header_auto{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;margin-left:8px;font-weight:400;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
      ".deg_expert_group_header_auto_input{margin:0;cursor:pointer}",
      ".deg_expert_group_header_auto_input:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_header_auto_label{font-size:12px;line-height:16px}",
      // 恢复失败横幅（票据 04）：与标题栏的「快照读取失败」错误面完全独立，位于头部之下、
      // 任务树之上；失败原因码与一行 message 同排，重试按钮固定右侧。整块用 flex-wrap：
      // 窄右栏时补充行自动换到第二排，绝不挤压任务树的可点击区域。
      ".deg_expert_group_recovery{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:6px 0 0;padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-state-warning-primary,#f59e0b));border-radius:6px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-weight:600}",
      // 主文案严格一行：超长 message 用省略号收束，完整内容在 title 里（Host 已限长 200 字符）。
      ".deg_expert_group_recovery_text{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      // 补充行（重试动作本身失败）：次级颜色、可换行，绝不覆盖主原因码。
      ".deg_expert_group_recovery_retry_error{flex:1 1 100%;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-weight:400}",
      ".deg_expert_group_recovery_retry{flex:0 0 auto;box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:inherit;font-weight:600;cursor:pointer}",
      ".deg_expert_group_recovery_retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
      ".deg_expert_group_recovery_retry:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_recovery_retry:disabled{cursor:default;opacity:.7}",
      ".deg_expert_group_header_action:hover,.deg_expert_group_chevron:hover,.deg_expert_group_action:hover:not(:disabled),.deg_expert_group_sidebar_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
      ".deg_expert_group_header_action:focus-visible,.deg_expert_group_chevron:focus-visible,.deg_expert_group_action:focus-visible,.deg_expert_group_sidebar_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_tree{min-width:0;padding-top:5px}",
      ".deg_expert_group_node{position:relative;min-width:0;padding-left:16px}",
      ".deg_expert_group_node_root{padding-left:0}",
      ".deg_expert_group_row{box-sizing:border-box;display:grid;grid-template-columns:20px 20px minmax(0,1fr);min-width:0;height:60px;min-height:60px;padding:4px 0}",
      // 第一行必须是 auto：默认单行 16px 时与旧布局逐像素相同；分片第一行换行时按内容撑高，
      // 绝不把多行文本压进 16px 行盒而与第二行重叠——它没有省略号语义（见 .deg_expert_group_shard_task）。
      // 第二、三行保持 16px 是因为省略号只在单行行盒上生效：行盒被内容撑开时 WebKit/Blink 会退化成
      // 裁切而不是显示 "…"，原生右栏与项目既有行为都以 "…" 结尾。
      ".deg_expert_group_row_main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 16px 16px;min-width:0}",
      // 第一行使用独立的内联容器：任务文字按内容宽度收缩，箭头紧跟在文字后方；名称过长时文字
      // 只在箭头前的可用空间内省略，不会把箭头推出右栏视口。第一行仍由内容撑高，兼容分片任务名换行。
      ".deg_expert_group_task_line{grid-area:1 / 1;display:flex;align-items:center;min-width:0;gap:2px}",
      ".deg_expert_group_meta{grid-area:2 / 1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}",
      // 两枚 20px chevron 重叠 10px，总宽 30px；按钮同步预留空间，避免箭头覆盖标题。
      ".deg_expert_group_sidebar_action{flex:0 0 30px;width:30px;height:20px;margin:-2px 0;padding:0;color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
      ".deg_expert_group_sidebar_action:hover{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
      // 打开态（可关闭的 <<）：同一枚按钮换成主题 business/info 色，缺 token 的老宿主退回 cyan。
      // 属性选择器 + 类选择器的特异度高于共享 hover 规则，因此这里显式重复 hover：「已打开」的
      // 身份色在悬停时同样保持；键盘聚焦沿用共享 focus-visible 的 outline（它不设置颜色），
      // 颜色因此仍是打开态的青色，聚焦轮廓与颜色同时可读。
      ".deg_expert_group_sidebar_action[data-open=true]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_action[data-open=true]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_double_arrow{display:inline-flex;align-items:center;justify-content:center;width:30px;height:20px;line-height:0}",
      ".deg_expert_group_double_arrow>*+*{margin-left:-10px}",
      ".deg_expert_group_double_arrow_icon path{stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}",
      ".deg_expert_group_line{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".deg_expert_group_task{min-width:0;flex:0 1 auto;font-weight:600;cursor:pointer}",
      // fan-out 分片第一行是「分片代号  任务名称」：代号已经占掉单行相当一部分宽度，
      // 继续按单行省略会让任务名称几乎不可读。这里改成可换行：完整文本按行折行展示，
      // overflow-wrap:anywhere 让超长且无分隔符的名称（中文长句、长英文标识）也能折行，
      // 绝不溢出到第二、三行或右侧的取消/重试按钮下面。行高由内容撑开（.deg_expert_group_shard
      // 只设 min-height），因此名称越长行越高而不是被裁掉。
      ".deg_expert_group_shard_task{overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}",
      ".deg_expert_group_task:hover,.deg_expert_group_content:hover{text-decoration:underline}",
      ".deg_expert_group_content{grid-area:3 / 1;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}",
      ".deg_expert_group_chevron{width:20px;height:20px;padding:0;align-self:start}",
      ".deg_expert_group_fanout_header>.deg_expert_group_chevron{align-self:center}",
      ".deg_expert_group_chevron_placeholder{display:inline-block;width:20px;height:20px}",
      ".deg_expert_group_status_icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}",
      // 兜底圆点：官方 primitives.StateDot 缺失时才使用，静态、无动画。
      ".deg_expert_group_state_dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
      ".deg_expert_group_state_dot[data-state=running]{color:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary))}",
      ".deg_expert_group_state_dot[data-state=ready]{color:var(--dsw-alias-state-success-primary)}",
      // 轻量（partial）快照的中性圆点：用次要文字色，既不是「运行中」蓝也不是「已完成」绿。
      ".deg_expert_group_state_dot[data-state=unknown]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
      // 固定 30px 批量控件紧跟标题文字；不占独立 grid 尾列，也不使用自动外边距推向行尾。
      // 标题自身 min-width:0 + 单行省略，窄宽度下只收缩文字，箭头与批量控件保持固定占位。
      ".deg_expert_group_trailing{display:flex;flex:0 0 30px;align-items:center;justify-content:center;width:30px;height:20px;min-width:30px}",
      ".deg_expert_group_task_line_trailing{justify-content:flex-start}",
      ".deg_expert_group_idle_title_line{display:flex;align-items:center;min-width:0;gap:2px}",
      ".deg_expert_group_idle_title_line>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
      // 批量关闭按钮：与单会话箭头同尺寸（30×20）与同色系（主题 business/info，缺 token 退回 cyan），
      // 形状是同一枚「两个左尖括号」图标。pending 期间 disabled + aria-busy，绝不重复发出关闭序列。
      ".deg_expert_group_sidebar_batch_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 30px;width:30px;height:20px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_batch_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
      ".deg_expert_group_sidebar_batch_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
      ".deg_expert_group_sidebar_batch_action:disabled{opacity:.45;cursor:wait}",
      // 「零」占位：inventory 已知为空时的非交互蓝色实心圆（直径 12px）。它只占位：
      // 没有 button / hover / tabindex，不进入键盘与可访问性交互面。
      ".deg_expert_group_sidebar_batch_zero{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary,#22d3ee))}",
      // 树线锚点固定在每一级父行的 20px 状态列中心，避免依赖窗口测量。
      ".deg_expert_group_children{position:relative;min-width:0;margin:0;padding:0;--deg-parent-row-height:60px}",
      ".deg_expert_group_children>.deg_expert_group_node,.deg_expert_group_children>.deg_expert_group_fanout,.deg_expert_group_children>.deg_expert_group_idle_group{--deg-tree-anchor:14px;position:relative}",
      ".deg_expert_group_children>.deg_expert_group_fanout{--deg-tree-anchor:14px}",
      ".deg_expert_group_children>:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_children>:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",

      ".deg_expert_group_node>.deg_expert_group_row,.deg_expert_group_fanout_header,.deg_expert_group_idle_group>.deg_expert_group_row{position:relative}",
      ".deg_expert_group_node:not(.deg_expert_group_node_root)>.deg_expert_group_row:before,.deg_expert_group_fanout_header:before,.deg_expert_group_idle_group>.deg_expert_group_row:before{position:absolute;top:var(--deg-tree-anchor,14px);left:-6px;width:16px;border-top:1px solid var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_row>*,.deg_expert_group_fanout_header>*{position:relative;z-index:1}",
      // 空闲分组没有隐式首项 spacer；折叠、展开和空列表都保持直接相邻。
      ".deg_expert_group_idle_group{position:relative;min-width:0;padding-left:16px;--deg-tree-anchor:14px}",
      ".deg_expert_group_idle_group>.deg_expert_group_children{margin:0;padding:0;--deg-parent-row-height:28px}",
      // 空闲分组标题行同样是 grid：状态列 + chevron 列 + 可收缩标题列 + 批量 trailing slot。
      // 第四列用 auto（与 .deg_expert_group_fanout_header 的 actions 列同款）：slot 存在时按它自己的
      // 30px 宽占位，slot 为空（没有批量能力）时该列宽度为 0——标题宽度因此与改动前逐像素一致，
      // 绝不会因为「能力缺失」而平白被压掉 30px。空 idleChildren 时该 slot 承载不可交互的零圆点。
      ".deg_expert_group_idle_group>.deg_expert_group_row.deg_expert_group_idle_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr);align-items:center;height:28px;min-height:28px;padding:4px 0}",
      ".deg_expert_group_idle_group>.deg_expert_group_row{margin:0}",
      ".deg_expert_group_fanout{position:relative;margin-top:0;padding-left:16px}",
      ".deg_expert_group_fanout_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;align-items:center;min-width:0;min-height:28px;gap:4px}",
      ".deg_expert_group_fanout_shards{position:relative;min-width:0;--deg-parent-row-height:28px}",
      // 分片第一行可以换行，行高不再固定 48px，所以树线锚点绑定到**固定 20px 高**的状态图标
      // 中心（3px 上内边距 + 10px），而不是行高的一半：水平连接线与垂直树线继续对准状态列，
      // 多行名称只让行变高，树形结构与高度语义不受影响。
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard{--deg-tree-anchor:13px;position:relative}",
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_fanout_shards>.deg_expert_group_shard:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
      ".deg_expert_group_shard{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;min-width:0;min-height:48px;padding:3px 0;gap:0 3px}",
      ".deg_expert_group_shard[data-expanded=false]{min-height:24px}",
      ".deg_expert_group_actions{display:flex;align-items:flex-start;gap:2px}",
      ".deg_expert_group_action{width:24px;height:24px;padding:0}",
      ".deg_expert_group_action:disabled{opacity:.45;cursor:wait}",
      ".deg_expert_group_empty{padding:16px 2px;color:var(--dsw-alias-label-secondary)}",
      ".deg_expert_group_skeleton{height:52px;margin:4px 0;border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));opacity:.65}",
      ".deg_expert_group_error{display:flex;align-items:center;gap:4px;padding:6px 0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:11px}",
      ".deg_expert_group_count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}",
    ].join("");
    document.head?.appendChild(tag);
  }

  /**
   * 宿主 AppFrame 右栏拖拽手柄的稳定公开标记（div[data-side="rightbar"]）。
   *
   * 宿主 AppFrame 的 DragHandle 渲染成 <div class="…handle" data-side={props.side}>，右栏那一枚
   * 的 side 就是 "rightbar"（左栏是 "sidebar"）；它只在「右栏已展开 + 非全屏 + 宽度大于 0」时
   * 出现，是用户拖拽改变右栏宽度的**唯一**入口（pointerdown → setPointerCapture → setRightbar）。
   * 属性名与取值都是宿主自己写死的公开标记，插件只读它、绝不改写宿主 DOM 结构。
   */
  const RIGHTBAR_DRAG_HANDLE_SELECTOR = "[data-side=rightbar]";

  /**
   * 读取一个节点的属性原文；读不到（没有 getAttribute、抛错、返回非字符串）返回 null。
   *
   * 一律不抛：属性读面缺失与属性缺失在这里是同一件事——调用方只允许按「读不出来」fail-closed，
   * 绝不允许猜一个默认值。
   */
  function attributeOf(node, name) {
    try {
      if (node === null || node === undefined || typeof node.getAttribute !== "function") return null;
      const raw = node.getAttribute(name);
      return typeof raw === "string" ? raw : null;
    } catch { return null; }
  }

  /**
   * 判断 node 是否与 root 处在**同一个 dock 作用域**内（父链上不跨过 boundaries 里的任一个标记）。
   *
   * 用途：右栏一列的内容区里可能嵌着另一个完整 dock（它有自己的 host/split 与 tab 条），
   * 那种 tab 属于嵌套页面，不能算进当前列。判定从 node 的父节点一路走到 root（不含 root 自身）：
   * 途中遇到任何 boundary 标记就返回 false。
   * 返回三态：true＝同作用域，false＝跨了作用域，null＝父链/属性读面不可用（调用方 fail-closed）。
   */
  function withinSameDockScope(node, root, boundaries) {
    let parent = null;
    try { parent = node?.parentNode ?? null; } catch { return null; }
    let guard = 0;
    while (parent !== null && parent !== undefined && parent !== root) {
      guard += 1;
      if (guard > 512) return null;
      if (typeof parent.getAttribute !== "function") return null;
      for (const name of boundaries) {
        if (attributeOf(parent, name) !== null) return false;
      }
      try { parent = parent.parentNode ?? null; } catch { return null; }
    }
    return parent === root;
  }

  /**
   * 读一个 dock host 的 DOM 布尔 `hidden`。
   *
   * 真实 DockLayout（app.asar 里 US 组件渲染 host 的那一处）写的是 React 的 `hidden: !w`，
   * 其中 w = 「这个 host 的 tab 就是它所属 pane 的 activeTabId」：同一 pane 只有**一个** host
   * 不带 hidden，其余 host 全部带 hidden。hidden 是 HTMLElement 的布尔 IDL 属性，因此这里只认
   * 真正的布尔值；属性读面缺失、抛错或返回非布尔（替身没实现、宿主换了渲染方式）一律返回 null，
   * 调用方按「读不出来」fail-closed，绝不把 undefined 当成「可见」。
   */
  function hostHiddenStateOf(host) {
    try {
      const value = host?.hidden;
      return typeof value === "boolean" ? value : null;
    } catch { return null; }
  }

  /**
   * 读取一个 dock **逻辑列**（= 同一 data-dockkit-column 下的全部 host）的**唯一活跃 tab 条**。
   *
   * 真实 DockLayout 对**每个 tab** 渲染一个 div[data-dockkit-host="dock"]，同一 pane 的多个 tab
   * 共享同一个 data-dockkit-column；而 tab 条本身**只挂在活跃 tab 的那个 host 上**：
   *   hidden: !w                            ← 非活跃 host 带 DOM hidden
   *   children: [ w && <TabStrip …/>, … ]   ← 非活跃 host 连 strip 都不渲染
   * 活跃 host 的那条 strip 里列出的是**该 pane 的全部 tab**（TabStrip 渲染 pane.tabs），所以只要
   * 取到唯一活跃 strip，这一逻辑列的 tab 组成就是完整的——多开一个子代理 tab 只会多出一个
   * hidden 的空 host，绝不能让整列因此变成「读不出来」而退回宿主的 1:1。
   *
   * 判定（任一条不成立即整列 fail-closed，绝不猜）：
   * - 每个 host 的 hidden 必须是可读的布尔值；
   * - hidden === true 且该 host 没有自己的 strip → 真实非活跃 host，跳过；
   * - hidden === false 且**恰好一条**自己的 strip → 活跃 host，收集这条 strip；
   * - 可见 host 没有 strip、hidden host 却带着自己的 strip、querySelectorAll 或父链读面抛错
   *   → 结构不是本插件认识的那一种，fail-closed；
   * - 一个逻辑列出现多个活跃 strip host，或整列一个活跃 strip 都没有 → fail-closed。
   *
   * 列内容区里嵌着的另一个 dock 也有自己的 strip，靠 withinSameDockScope 排除（父链上跨过
   * host/split 的 strip 不算本列）。返回 null 表示读不出来；可读时返回**恰好一条** strip 的数组。
   */
  function cellStripNodesOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return null;
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return null;
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return null;
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return null; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return null;
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；它若带着自己的 tab 条，说明结构不是这一种，fail-closed。
        if (owned.length !== 0) return null;
        continue;
      }
      // 可见 host 必须恰好有一条自己的 tab 条：零条（tab 条没渲染出来）或多条都无法证明组成。
      if (owned.length !== 1) return null;
      activeCount += 1;
      if (activeCount > 1) return null;
      activeStrip = owned[0];
    }
    // 整列必须恰好一个活跃 host：整列全 hidden（一条 strip 都没有）同样读不出组成。
    if (activeCount !== 1 || activeStrip === null) return null;
    return [activeStrip];
  }

  /**
   * 读取一个逻辑列自己的 tabId 集合。
   *
   * 只认**唯一活跃 strip** 里的 tab 芯片（strip 内部更深一层的 strip 属于嵌套 dock，不算本列）。
   * 读面抛错、活跃 strip 不是恰好一条、strip 里没有任何 tab、未知或空 tabId 都让整列读不出来，
   * 调用方据此 fail-closed，绝不把「读不到」当成空列。
   *
   * 同一条 strip 里出现重复 tabId 同样是结构异常（一个 tab 不可能在同一个 tablist 里出现两次）：
   * 这里绝不能用 Set 静默吞掉重复，否则「读面不完整」会被误判成正常组成。
   */
  function cellTabIdsOf(column) {
    const ids = new Set();
    const strips = cellStripNodesOf(column);
    // 读面契约：可读时恰好一条活跃 strip；null 或长度不为 1 都表示这一列读不出来。
    if (strips === null || strips.length !== 1) return { ids, readable: false };
    const strip = strips[0];
    if (typeof strip.querySelectorAll !== "function") return { ids, readable: false };
    let tabNodes = null;
    try { tabNodes = Array.from(strip.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return { ids, readable: false }; }
    for (const node of tabNodes) {
      const scoped = withinSameDockScope(node, strip, [RIGHTBAR_STRIP_TABS_ATTRIBUTE]);
      if (scoped === null) return { ids, readable: false };
      if (scoped !== true) continue;
      const tabId = text(attributeOf(node, RIGHTBAR_TAB_ID_ATTRIBUTE), null);
      if (tabId === null) return { ids, readable: false };
      if (ids.has(tabId)) return { ids, readable: false };
      ids.add(tabId);
    }
    if (ids.size === 0) return { ids, readable: false };
    return { ids, readable: true };
  }

  /**
   * Expert Group 的 tabId 集合（kind 规范化 + DockKit 生成的 id）。
   *
   * inventory 是公开只读读面（sidebarRight.openTabs.getSnapshot），可用时它把 kind 映射成真实
   * tabId（DockKit 生成的 `dsh-expert-group1` 这类 id 仍在集合里）；读面缺失/抛错/返回非数组时
   * 退回旧宿主里 kind 直接当 tabId 用的 DOM 形态，并由 isGeneratedExpertGroupTabId 继续识别
   * 计数器后缀。其它旧逻辑允许在 inventory 缺失时保留基础 kind 兼容集合；严格的分栏配比
   * 读面另用 sidebarTabSetsForSession（内部走 tabKindsForSession），只接受当前 session 的
   * inventory 归属。
   */
  function expertGroupTabIdsOf(inventory, sessionId) {
    const expertTabIds = new Set(EXPERT_GROUP_TAB_IDS);
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return expertTabIds;
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
        const tabId = text(candidate.tabId, null);
        if (tabId !== null) expertTabIds.add(tabId);
      } catch {
        // 单条 inventory 记录损坏时跳过它，不能阻断其它 tab 的 pane 定位。
      }
    }
    return expertTabIds;
  }

  /**
   * 面板里的全部 dock pane 节点（顺序保留用于诊断，方向以 data-dockkit-column 为准）。
   *
   * 读不到（没有 querySelectorAll、查询抛错）时返回 null：调用方按「这一轮 pane 读面不可用」
   * fail-closed，绝不把「读不到」当成「没有 pane」。
   */
  function paneNodesOf(panel) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
    try { return Array.from(panel.querySelectorAll(RIGHTBAR_PANE_SELECTOR)); } catch { return null; }
  }

  /**
   * 只建立当前 session 的 tabId -> kind 映射。inventory 缺失、session 无效或同一 tabId 出现
   * 冲突 kind 时返回 null；配比路径不能用全局 kind 或生成式 id 猜测旧 pane 的归属。
   */
  function tabKindsForSession(inventory, sessionId) {
    if (!Array.isArray(inventory) || typeof sessionId !== "string" || sessionId === "") return null;
    const tabKinds = new Map();
    for (const entry of inventory) {
      try {
        const candidate = object(entry);
        if (text(candidate.sessionId, null) !== sessionId) continue;
        const tabId = text(candidate.tabId, null);
        const kind = text(candidate.kind, text(candidate.type, null));
        if (tabId === null || kind === null) continue;
        const previous = tabKinds.get(tabId);
        if (previous !== undefined && previous !== kind) return null;
        tabKinds.set(tabId, kind);
      } catch {
        // 单条损坏记录不参与映射；若 DOM 仍引用它，后续会按未知归属 fail-closed。
      }
    }
    return tabKinds;
  }

  /**
   * 当前 session 的 tabId 读面：expert = Expert Group 页的 id 集合；known = 本会话全部已知 tabId。
   *
   * 沿用 tabKindsForSession 的严格归属：inventory 读不出来、session 无效、同一 tabId 出现冲突
   * kind 时返回 null（调用方整体 fail-closed），绝不退回全局 kind 或用生成式 id 猜测归属。
   * 静态 EXPERT_GROUP_TAB_IDS 作为旧宿主（kind 直接当 tabId）的兼容基线同时进入两个集合。
   */
  function sidebarTabSetsForSession(inventory, sessionId) {
    const tabKinds = tabKindsForSession(inventory, sessionId);
    if (tabKinds === null) return null;
    const expert = new Set(EXPERT_GROUP_TAB_IDS);
    const known = new Set(EXPERT_GROUP_TAB_IDS);
    for (const [tabId, kind] of tabKinds) {
      known.add(tabId);
      if (EXPERT_GROUP_TAB_IDS.has(kind)) expert.add(tabId);
    }
    return { expert, known };
  }

  /**
   * 按 data-sidebar-right-session 精确挑选属于当前 surface 的右栏面板。
   *
   * 面板会迟到挂载、也可能在一次 surface 重挂载里同时留下新旧两个；`querySelector` 的第一个命中
   * 无法证明归属，因此这里要求面板自带会话归属标记并与本轮 session **完全相等**，而且全局恰好
   * 一个匹配（零个＝还没挂载或不属于这一页，多个＝归属不明确）。缺属性、读面不可用或有歧义
   * 都返回 null，调用方保持 fail-closed，绝不猜第一个面板。
   */
  function rightbarPanelForSession(doc, sessionId) {
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    if (typeof sessionId !== "string" || sessionId === "") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    let matched = null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== sessionId) continue;
      if (matched !== null) return null;
      matched = node;
    }
    return matched;
  }

  /**
   * 面板级读面（面板内的 tab/pane 观察与组成判定）共用的「当前 session 面板」解析入口。
   *
   * 第一判据与 rightbarPanelForSession 完全一致：面板自带 data-sidebar-right-session、与当前
   * session 完全相等、且全局唯一时才可用；零个（面板还没挂载 / 不属于这一页）或多个（归属不明确）
   * 都返回 null，调用方一律 fail-closed——绝不按 DOM 顺序取第一个面板，那正是跨 session 误命中的根因。
   *
   * 唯一的兼容分支是**旧宿主形状**：data-sidebar-right-session 出现之前的面板没有归属标记，
   * 此时 DOM 里读不到任何带标记的面板。只有这种「整轮都没有归属标记」的形状才退回 querySelector
   * 的旧读法，而且要求面板至多一个（多于一个＝归属不可能证明，直接 fail-closed）。只要出现过任何
   * 一个带标记的面板（现代宿主），这个分支整体失效：当前 session 自己的面板没挂载时保持 null，
   * 绝不拿别的 session 的面板顶替。
   */
  function rightbarPanelForSessionCompat(doc, sessionId) {
    const panel = rightbarPanelForSession(doc, sessionId);
    if (panel !== null) return panel;
    if (doc === null || doc === undefined || typeof doc.querySelectorAll !== "function") return null;
    let nodes = null;
    try { nodes = Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR)); } catch { return null; }
    // 归属标记一旦存在就不再兼容：多个面板、或任一面板带标记，都只能按精确归属判定。
    if (nodes.length > 1) return null;
    for (const node of nodes) {
      if (attributeOf(node, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    }
    if (nodes.length === 1) return nodes[0];
    // 旧替身/旧宿主的读面形状：面板选择器只能通过 querySelector 命中。这里同样要求命中节点
    // 没有归属标记——带了标记说明它是别的 session 的面板，不能拿来顶替。
    if (typeof doc.querySelector !== "function") return null;
    let single = null;
    try { single = doc.querySelector(RIGHTBAR_PANEL_SELECTOR) ?? null; } catch { return null; }
    if (single === null || single === undefined) return null;
    if (attributeOf(single, RIGHTBAR_PANEL_SESSION_ATTRIBUTE) !== null) return null;
    return single;
  }

  /**
   * 读取 split 容器的直接 dock 列，并按列号归并成**逻辑列**。
   *
   * 只有 split 的**直接子节点**里 `data-dockkit-host="dock"` 且带非空 `data-dockkit-column`
   * 的才是真实列：浮动 host（data-dockkit-host="floating"）、resize 手柄、嵌套 split 的子列
   * 都不算列。列号缺失（读不出来或空串）一律整轮 fail-closed——拿不到列号的节点不能被当成一列。
   *
   * 真实 DockLayout 是「**每个 tab 一个 host**」：同一个 pane 的多个 tab 各有自己的
   * div[data-dockkit-host="dock"]，它们共享同一个 data-dockkit-column（只有活跃 tab 的那个 host
   * 不带 hidden、也只有它渲染 tab 条）。因此同列多个 host 是**合法**结构，这里按列号归并成
   * { column, hosts }：hosts 保留 DOM 顺序，顺序本身没有语义（组成判定只看活跃 strip 里的
   * tab 集合），列号到 host 的归属仍然是精确的。
   */
  function dockCellsOf(split) {
    const cells = [];
    let children = null;
    try { children = split?.children ?? null; } catch { children = null; }
    if (children === null || children === undefined) return { cells, readable: false };
    const byColumn = new Map();
    for (const child of Array.from(children)) {
      if (child === null || typeof child.getAttribute !== "function") return { cells, readable: false };
      if (attributeOf(child, RIGHTBAR_DOCK_HOST_ATTRIBUTE) !== RIGHTBAR_DOCK_HOST_VALUE) continue;
      const column = text(attributeOf(child, RIGHTBAR_PANE_COLUMN_ATTRIBUTE), null);
      if (column === null) return { cells, readable: false };
      const merged = byColumn.get(column);
      if (merged === undefined) byColumn.set(column, { column, hosts: [child] });
      else merged.hosts.push(child);
    }
    for (const entry of byColumn.values()) cells.push(entry);
    return { cells, readable: true };
  }

  /**
   * 判断一个 split 容器是不是「列 0 = Expert Group、列 1 = 当前 session 的另一个已知页」。
   *
   * fail-closed 的边界（任一条不成立就 false，插件一个字节都不写）：
   * - 归并后的逻辑列不是**恰好两列**，或列号不是精确的 0/1（三列、缺列、未知列号都没有可证明的 40:60）；
   * - 任一逻辑列读不出自己的活跃 strip / tabId（整列没有活跃 strip、多个活跃 strip、
   *   可见 host 没有 strip、hidden host 却带 strip、hidden 状态不可读、未知 tabId、读面抛错）；
   * - 列 0 里混进非 Expert Group 页，或列 1 里出现 Expert Group 页；
   * - 同一个 tabId 同时出现在两列，或同一条 strip 里重复出现（重复归属），
   *   或出现本会话 inventory 里没有的 tab（未知归属）。
   *
   * 同列多个 host（真实「每个 tab 一个 host」形态）本身合法：判定用的是归并后的逻辑列与它唯一的
   * 活跃 strip（该 strip 列出整个 pane 的 tab），因此多个子代理 tab 与单个子代理 tab 得到完全
   * 相同的 40:60 结论。
   */
  function splitOwnsExpertPair(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return false;
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return false;
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return false;
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    const otherTabs = cellTabIdsOf(byColumn.get("1"));
    if (expertTabs.readable !== true || otherTabs.readable !== true) return false;
    let expertCount = 0;
    for (const tabId of expertTabs.ids) {
      if (otherTabs.ids.has(tabId)) return false;
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) !== true) return false;
      expertCount += 1;
    }
    if (expertCount === 0) return false;
    for (const tabId of otherTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return false;
      if (tabSets.expert.has(tabId) === true) return false;
    }
    return true;
  }

  /**
   * 一个逻辑列的「暂不可读」判定（与 cellStripNodesOf 同一套读面，但区分失败原因）。
   *
   * 返回 "readable" | "unavailable" | "foreign"：
   * - "readable"：恰好一条活跃 tab 条且 tab 组成可读——这一列有完整组成，轮不到 pending 分支；
   * - "unavailable"：整列只有 hidden host（tab 条还没渲染出来）。这是重启恢复窗口里第二列的
   *   典型形状，只有这种形状才允许 pending；
   * - "foreign"：可见 host 没有 tab 条、非活跃 host 却带着自己的 tab 条、一个逻辑列出现多个活跃
   *   strip host、hidden 状态不可读、host 列表为空、读面抛错。这些都不是「还没读完」而是
   *   「结构不是本插件认识的那一种」，必须按原有 fail-closed 语义交还宿主。
   */
  function cellPendingStateOf(column) {
    const hosts = column?.hosts ?? null;
    if (!Array.isArray(hosts) || hosts.length === 0) return "foreign";
    let activeStrip = null;
    let activeCount = 0;
    for (const host of hosts) {
      if (host === null || host === undefined || typeof host.querySelectorAll !== "function") return "foreign";
      const hidden = hostHiddenStateOf(host);
      if (hidden === null) return "foreign";
      let nodes = null;
      try { nodes = Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR)); } catch { return "foreign"; }
      const owned = [];
      for (const node of nodes) {
        const scoped = withinSameDockScope(node, host, [RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_SPLIT_ATTRIBUTE]);
        if (scoped === null) return "foreign";
        if (scoped === true) owned.push(node);
      }
      if (hidden === true) {
        // 真实非活跃 host 完全没有 strip；带了自己的 tab 条说明结构不是这一种。
        if (owned.length !== 0) return "foreign";
        continue;
      }
      if (owned.length !== 1) return "foreign";
      activeCount += 1;
      if (activeCount > 1) return "foreign";
      activeStrip = owned[0];
    }
    if (activeCount !== 1 || activeStrip === null) return "unavailable";
    return cellTabIdsOf(column).readable === true ? "readable" : "foreign";
  }

  /**
   * 区分「两列但第二列内容暂不可读」与「组成明确不再是目标」。
   *
   * 为什么需要它：重启恢复（宿主从持久化布局恢复右栏）时，split 容器往往比列内的 tab 条 /
   * inventory 归属早几帧出现。这段窗口里 splitOwnsExpertPair 会返回 false，但 false 同时
   * 覆盖了两种完全不同的现实：
   * - **暂不可读**（本函数返回 "unavailable"）：结构上仍是两列，列 0 明确是本会话的
   *   Expert Group 页，只有列 1 整列还没有活跃 tab 条（tab 条比 split 容器晚若干帧提交）。
   *   此时组成只是「还没读完」，插件应当保持已写下的配比并短延迟重试，绝不闪回宿主默认值；
   * - **明确非目标 / 单列**（返回 "foreign"）：列数不是精确的 0/1 两列、列 0 不是 Expert Group
   *   页、列 0 的 tab 无法归属、或两列里混进重复/未知归属。这些都没有可证明的 40:60，必须
   *   按原有 fail-closed 语义交还宿主。
   *
   * 归属判定与 splitOwnsExpertPair 完全同源（同一份 tabSets、同一条唯一活跃 strip 读法），
   * 因此这里**不引入任何新的宽松证据**：pending 只在「目标那一侧已经被证明」时才成立，
   * 首次接管（从未写过目标配比）也绝不会因为列 1 读不出来就去猜页面归属。
   */
  function splitPairPendingOf(split, tabSets) {
    if (tabSets === null || tabSets === undefined || typeof tabSets !== "object") return "foreign";
    const breakdown = dockCellsOf(split);
    if (breakdown.readable !== true || breakdown.cells.length !== 2) return "foreign";
    const byColumn = new Map(breakdown.cells.map((entry) => [entry.column, entry]));
    if (!byColumn.has("0") || !byColumn.has("1")) return "foreign";
    // 列 0 必须是可读且明确属于本会话的 Expert Group 页：读不出来就没有「已确认的目标」。
    const expertTabs = cellTabIdsOf(byColumn.get("0"));
    if (expertTabs.readable !== true || expertTabs.ids.size === 0) return "foreign";
    for (const tabId of expertTabs.ids) {
      if (tabSets.known.has(tabId) !== true) return "foreign";
      if (tabSets.expert.has(tabId) !== true) return "foreign";
    }
    // 列 1 只有「整列还没有活跃 tab 条」这一种形状算暂不可读；其余（组成读得出来、可见 host
    // 没有 strip、一个逻辑列多个活跃 strip、hidden 不可读等）都是「明确不是目标」，交回严格判定。
    return cellPendingStateOf(byColumn.get("1")) === "unavailable" ? "unavailable" : "foreign";
  }

  /**
   * 在面板里按给定判据挑出**唯一**的分栏容器。
   *
   * 面板内部可能同时存在多个 split（列的内容区里嵌着的另一个 dock 也有自己的 split），因此
   * 判据命中多个时一律视为归属不明确并返回 null（调用方 fail-closed，绝不挑第一个猜测）；
   * 返回数组的形态让调用方可以自行决定「零个 / 一个 / 多个」的处理方式（见下面的两个包装）。
   */
  function uniqueSplitBy(panel, matches) {
    if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return [];
    let nodes = null;
    try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_SPLIT_SELECTOR)); } catch { return []; }
    const resolved = [];
    for (const node of nodes) {
      if (matches(node) !== true) continue;
      resolved.push(node);
      if (resolved.length > 1) break;
    }
    return resolved;
  }

  /**
   * 在面板里找出**唯一**可解析的分栏容器。
   *
   * 只有满足 splitOwnsExpertPair 的那一个才是本插件的目标：零个表示还没分栏或形态不认识，
   * 多个表示归属不明确——两种情况都返回 null（调用方 fail-closed）。
   */
  function resolveSplitContainer(panel, tabSets) {
    const resolved = uniqueSplitBy(panel, (node) => splitOwnsExpertPair(node, tabSets) === true);
    return resolved.length === 1 ? resolved[0] : null;
  }

  /**
   * 找出面板里**唯一**的「暂不可读 pending」分栏容器（见 splitPairPendingOf 的说明）。
   *
   * 零个表示这一轮没有任何可保持目标配比的两列结构，多个表示归属不明确——调用方据此走
   * 原有的交还宿主分支，绝不挑第一个猜测。返回数组（而不是元素或 null），因为「零个」与
   * 「多个」在这里都必须与「恰好一个」区分开。
   */
  function splitPairPendingContainers(panel, tabSets) {
    return uniqueSplitBy(panel, (node) => splitPairPendingOf(node, tabSets) === "unavailable");
  }

  /**
   * 解析 grid-template-columns 的三轨形态。
   *
   * 真实右栏是「列 0 | 0px 分隔轨 | 列 1」三条轨道，两端必须是 `minmax(0,<数字>fr)`：只有这种
   * 形态才谈得上 40% / 60%，其余（单轨、repeat()、固定 px、轨道数不符、括号不闭合）一律返回
   * null，调用方绝不写。中间那条轨道原样返回给调用方复用——它是宿主自己的分隔轨，插件不改写。
   */
  function parseSplitTracks(raw) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (value === "") return null;
    const tracks = [];
    let depth = 0;
    let current = "";
    for (const character of value) {
      if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
      if (depth < 0) return null;
      if (depth === 0 && /\s/.test(character)) {
        if (current !== "") { tracks.push(current); current = ""; }
        continue;
      }
      current += character;
    }
    if (depth !== 0 || current === "") return null;
    tracks.push(current);
    if (tracks.length !== 3) return null;
    const first = splitEndTrackFr(tracks[0]);
    const last = splitEndTrackFr(tracks[2]);
    if (first === null || last === null) return null;
    return { first, last, middle: tracks[1] };
  }

  /** 端点轨道必须是 `minmax(0,<数字>fr)` 或 CSSOM 规范化后的 `minmax(0px,<数字>fr)`；其余形态一律不认。 */
  function splitEndTrackFr(track) {
    const match = /^minmax\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(track);
    if (match === null) return null;
    const value = Number(match[1]);
    return Number.isFinite(value) ? value : null;
  }

  /**
   * 右栏拖拽手柄锁：**只在 Expert Group 页确实是当前活动页时**生效，切换页面或卸载立刻恢复。
   *
   * 需求：Expert Group 页的宽度固定为视口宽度的 20%，用户不能在这一页上把右栏拖成别的宽度；
   * 而其它右侧分页（子代理聊天、文件等）必须继续能正常 resize。因此绝不能全局禁用这个手柄
   * （那是宿主 AppFrame 的公共元素，别的页面、甚至同一会话里的其它 tab 都要用它），只能在
   * 「当前活动 tab 就是 Expert Group」时逐次加锁、离开时逐次解锁。
   *
   * 最小侵入写法：只往这一个元素的内联样式上写两条属性（禁用指针事件 + 复位光标形状），
   * 不注入全局 CSS、不加 class、不改 DOM 结构，也绝不碰宿主的 data-* 属性：
   * - pointer-events: none —— 拖拽入口（pointerdown）根本收不到事件，宽度不可能被拖走；
   * - cursor: default —— 鼠标悬停时不再显示 col-resize 的「可拖拽」暗示。
   * 两条都带 important：宿主自己给手柄写了 hover 态样式，普通内联声明可能被主题的
   * !important 规则盖掉（与过渡抑制同一取舍）。
   *
   * 恢复用「值与优先级都仍等于本次写入才还原」的保守判定：锁存窗口内被宿主/主题/页面脚本
   * 改写过的属性一律保留外部状态，原本没有内联声明就删除，绝不用旧值覆盖新值。
   *
   * 句柄的存活性复用**已有的 tab 观察生命周期**：Expert Group 面板已挂在 body 子树的
   * childList observer + 2.5 秒轮询 + visibilitychange 上（见 syncSidebarTabs），宿主重新挂载
   * 这枚手柄本身就是一次 childList 变化，因此锁会随那条生命周期重新找句柄并补写——插件不为
   * 此再加一个长期 MutationObserver，宿主上的观察器数量与既有行为完全一致。
   *
   * 解锁（切换页面）与 dispose 都必须还原样式：绝不在宿主上留下「永久不可拖拽」的手柄，
   * 也绝不留下任何全局样式或残留属性。
   *
   * 全程 fail-safe：没有 document / 没有 querySelector / 句柄还没挂载 / style 不是可写对象，
   * 都只是「这一次没锁上」，绝不影响页面打开与渲染。
   */
  function createRightbarDragLock() {
    /** 插件写入手柄的两条最小侵入样式（顺序固定：先禁用指针事件，再复位光标）。 */
    const HANDLE_STYLE_WRITES = Object.freeze([
      { name: "pointer-events", value: "none" },
      { name: "cursor", value: "default" },
    ]);
    let locked = false;
    let element = null;
    /** 每条属性写入前的内联值与优先级；解锁时逐条按「未被外部改写」判定后还原。 */
    let previous = null;

    const readHandle = () => {
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        return doc.querySelector(RIGHTBAR_DRAG_HANDLE_SELECTOR) ?? null;
      } catch { return null; }
    };
    const readStyle = (style, name) => {
      try { return typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : ""; } catch { return ""; }
    };
    const readPriority = (style, name) => {
      try { return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(name) : ""; } catch { return ""; }
    };

    /** 还原锁期间写过的内联样式；只回写「当前值与优先级都仍是本次写入」的那些属性。 */
    const restore = () => {
      const target = element;
      const saved = previous;
      element = null;
      previous = null;
      if (target === null || saved === null) return;
      let style = null;
      try { style = target.style || null; } catch { style = null; }
      if (style === null) return;
      for (const entry of saved) {
        try {
          if (readStyle(style, entry.name) !== entry.written) continue;
          if (readPriority(style, entry.name) !== entry.writtenPriority) continue;
          if (entry.value === "" || entry.value === null || entry.value === undefined) style.removeProperty?.(entry.name);
          else style.setProperty(entry.name, entry.value, entry.priority || "");
        } catch { /* 单条属性还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */ }
      }
    };

    /** 查找并锁定手柄；句柄不在 DOM 里时返回 false，由下一次同步（面板的 tab 观察生命周期 / 会话通知）补上。 */
    const apply = () => {
      if (locked !== true) return false;
      const candidate = readHandle();
      if (candidate === null) return false;
      if (candidate !== element) {
        // 宿主换了一枚新手柄（React 重挂载）：旧节点已经不在文档里，直接改记新节点，
        // 不为它保留恢复信息（还原一个已被移除的节点没有任何意义）。
        element = candidate;
        previous = null;
      }
      let style = null;
      try { style = candidate.style || null; } catch { style = null; }
      if (style === null || typeof style.setProperty !== "function") return false;
      if (previous === null) {
        previous = HANDLE_STYLE_WRITES.map(({ name }) => ({
          name,
          value: readStyle(style, name),
          priority: readPriority(style, name),
          written: null,
          writtenPriority: null,
        }));
      }
      HANDLE_STYLE_WRITES.forEach(({ name, value }, index) => {
        // 已经是锁状态就不重复写：既避免无谓的样式写入，也让重复同步保持幂等。
        if (readStyle(style, name) === value) return;
        try {
          style.setProperty(name, value, "important");
          // 写入后回读：宿主可能规范化或忽略 priority，恢复判定必须用「实际写入的状态」。
          previous[index].written = readStyle(style, name);
          previous[index].writtenPriority = readPriority(style, name);
        } catch { /* 写入失败：保留已经写上的那几条，绝不影响页面其它行为。 */ }
      });
      return true;
    };

    return {
      /**
       * 同步锁状态：true 立即锁（已锁时再核对一遍：宿主重建句柄或改写内联样式时按需补写），
       * false 立刻还原样式。返回当前是否处于锁定态，便于调用方与测试断言。
       */
      setLocked(next) {
        const target = next === true;
        if (target === locked) {
          if (target) apply();
          return locked;
        }
        locked = target;
        if (target) apply();
        else restore();
        return locked;
      },
      isLocked: () => locked,
      /** 卸载收尾：还原样式并复位状态，绝不在宿主上留下全局或残留样式。 */
      dispose() {
        locked = false;
        restore();
      },
    };
  }

  /**
   * 分栏列宽的写入器：只往 split 容器的**内联 grid-template-columns** 上写一条三轨值。
   *
   * 需求：用户第一次分栏后右栏总宽度保持视口的 50%，但 Expert Group 页必须回到视口 20%——
   * 也就是右栏内部 40% / 60%，而不是宿主默认的等分（等分时 Expert Group 页只剩视口 25%）。
   * 真实 DockKit 右栏的实际列宽由 split 容器这一条内联 grid-template-columns 决定
   * （`minmax(0,0.5fr) 0px minmax(0,0.5fr)`）：列内的 flex-grow 不参与真实列宽计算，因此这里
   * 只把它改成 `minmax(0,0.4fr) 0px minmax(0,0.6fr)`，中间那条分隔轨原样保留。
   *
   * 触发时机（与手柄锁完全共用同一条生命周期，不新挂任何 observer）：
   * - install 期的 openTargets（sessions / Better 状态通知）；
   * - 面板的 MutationObserver（body 子树 childList）、2.5 秒轮询、visibilitychange；
   * - 分栏事务提交后与关闭点击后的那次同步。
   * 因此宿主把新列渲染出来的那一帧之后配比会被补上，列消失后同一条链路会立刻还原。
   *
   * 写入与恢复规则（保守，绝不覆盖宿主后续写入）：
   * - 首次接管这个容器时保存宿主的原值与优先级（绝不用插件自己的值当原值）；
   * - 组成仍有效时：已经是目标值 → 零写入；仍是插件写下的状态（宿主只规范了文本形式）→ 零写入；
   *   回到宿主自己的默认形态（两端 fr 相等的等分，或捕获到的原值）→ 重新施加目标配比；
   *   其它不等的值视为宿主/用户的刻意改动 → 让位，不写；
   * - 交还（dispose / 单列 / Expert Group 消失 / 三列 / 读面不可用 / session 切换）时，只有
   *   「当前值与优先级都仍然是本次写入」才写回原值，被外部改写过的值一律保留；
   * - dispose 之后任何迟到回调都不再写入（disposed 短路）。
   *
   * 全程 fail-safe：没有 document / 没有容器 / 当前值承载不了三轨形态 / style 不可写，都只是
   * 「这一轮没写」，绝不影响页面打开、分栏事务与手柄锁。
   */
  function createSplitTrackRatio() {
    /** 当前接管中的容器（最多一个）：元素身份 + 本写入器写下的实际状态（含宿主规范化后的文本）。 */
    let applied = null;
    /** 首次接管时的宿主原值与优先级；按容器身份记忆，绝不让插件自己的值被当成原值。 */
    let hostCapture = null;
    /** dispose 之后所有同步（含已经排队的迟到回调）一律短路，绝不再碰宿主样式。 */
    let disposed = false;
    /**
     * 「暂不可读」pending 的记账（**只在已经写进过目标配比之后**才可能成立）。
     *
     * 语义：容器上当前就是插件写下的目标配比，但这一轮读面读不出「列 1 是本会话的另一个已知页」，
     * 也没有任何证据说明组成真的失效了（结构仍是两列、列 0 仍是 Expert Group 页）。
     * 此时用 applyRatio 维持/修复目标配比，并安排一次短延迟重试去重新求值——这正是重启恢复
     * 窗口里避免 target → host default 闪回的机制。
     *
     * attempts 的语义是「**实际执行过的** pending retry timer 轮数」：只有 schedulePendingRetry
     * 的回调真正跑起来才自增，外部同步（sessions 广播 / observer / 轮询）只读取它、绝不修改，
     * 因此同一个 400ms 等待期内的任意多次通知都不会提前耗尽预算。
     */
    let pending = null;
    /** 去重用的待执行重试定时器句柄：同一时刻最多一个，重复同步绝不堆积。 */
    let pendingRetryTimer = null;
    /**
     * 最近一次同步传入的**真实读面函数**（install 收尾接线的 splitTrackReader.readTarget）。
     *
     * 重试 timer 必须用它重新读一遍当前 document / session / panel / split / inventory 状态，
     * 绝不能把上一轮那个 "pending" 结论原样回放：回放的话 timer 自己永远看不到「读面已经恢复」，
     * 收敛就只能依赖外部的 sessions / observer 通知，而重启恢复窗口里恰恰没有这些通知——
     * 结果是重试预算被白白烧完，配比反而被交还给宿主默认值（闪回）。
     *
     * 读面本身是纯函数式的现读（不依赖 this，也不缓存 DOM），因此这里只保存函数引用即可，
     * 每次调用都会重新求值。读面为 null（install 收尾前）时 pending 不可能被建立。
     */
    let lastReader = null;

    /** 读一条内联值与优先级；任何能力缺失/抛错都返回 null，由调用方按「读不到」处理。 */
    const readInline = (style, name, readerName) => {
      try {
        if (style === null || style === undefined) return null;
        const reader = style[readerName];
        if (typeof reader !== "function") return null;
        const value = reader.call(style, name);
        return value === null || value === undefined ? "" : String(value);
      } catch { return null; }
    };
    const readValue = (style, name) => readInline(style, name, "getPropertyValue");
    const readPriority = (style, name) => readInline(style, name, "getPropertyPriority");

    /** split 容器的内联样式对象；读不到（没有 style / 替身缺 API）时返回 null。 */
    const styleOf = (container) => {
      try {
        const style = container?.style ?? null;
        if (style === null || typeof style.setProperty !== "function") return null;
        return style;
      } catch { return null; }
    };

    /**
     * 目标值：沿用宿主当前那条分隔轨，只把两端换成 0.4 / 0.6。
     *
     * parsed 为 null 表示宿主当前没有内联声明（没有可沿用的分隔轨）：这时用规范分隔轨，
     * 写成与真实右栏一致的三轨形态。
     */
    const composeDesired = (parsed) =>
      "minmax(0," + SIDEBAR_SPLIT_EXPERT_TRACK + "fr) "
      + (parsed === null ? SIDEBAR_SPLIT_GAP_TRACK : parsed.middle)
      + " minmax(0," + SIDEBAR_SPLIT_OTHER_TRACK + "fr)";

    /** 记录宿主原本的内联值与优先级（同一个容器只记一次，宿主重渲染不会让插件值变成新基线）。 */
    const captureHostStyle = (container) => {
      if (hostCapture !== null && hostCapture.container === container) return true;
      const style = styleOf(container);
      if (style === null) return false;
      const value = readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      const priority = readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      if (value === null || priority === null) return false;
      hostCapture = { container, value, priority };
      return true;
    };

    /**
     * 当前值是否值得让插件重新施加目标配比。
     *
     * - 还没捕获过这个容器的宿主原值 → true（首次接管，按插件契约施加）；
     * - 值与捕获到的宿主原值一致 → true（宿主重渲染回自己的默认值）；
     * - 宿主当前没有内联声明 → true（宿主没有自己的意见，写它不会覆盖宿主写下的值）；
     * - 三轨形态两端 fr 相等 → true（宿主默认的等分，文本形式可能与捕获值不同）；
     * - 其余（不等的第三值，例如用户/别的插件拖过分隔条）→ false：插件让位并保留外部状态。
     */
    const shouldApply = (container, parsed, current) => {
      if (hostCapture === null || hostCapture.container !== container) return true;
      if (current === "") return true;
      if (hostCapture.value === current) return true;
      return parsed !== null && parsed.first === parsed.last;
    };

    /**
     * 按容器当前值决定这一轮要不要写。
     *
     * 返回值只表示「这一轮之后容器上的配比是不是目标状态」：让位（保留外部值）时返回 false，
     * 但绝不因此去改写宿主样式。
     */
    const applyRatio = (container) => {
      const style = styleOf(container);
      if (style === null) return false;
      const current = readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      const currentPriority = readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY);
      if (current === null || currentPriority === null) return false;
      const parsed = parseSplitTracks(current);
      // 宿主换成了别的非三轨写法（固定 px、repeat() 等）：插件不猜结构，直接让位。
      // 只有「宿主没有内联声明」（空值）才用规范分隔轨补一条三轨值。
      if (current !== "" && parsed === null) return false;
      const desired = composeDesired(parsed);
      // 1) 已经是目标值：零写入（重复同步、面板重挂载都走这条路径）。
      if (current === desired) return true;
      // 2) 仍是插件自己写下的状态（宿主可能只规范了文本形式）：零写入，避免写入回环。
      if (applied !== null && applied.container === container
        && current === applied.written && currentPriority === applied.writtenPriority) return true;
      // 3) 外部刻意改过的非等分值：让位，保留外部值，绝不盖回目标配比。
      if (shouldApply(container, parsed, current) !== true) return false;
      // 4) 首次接管先记住宿主原值；记不下来就不写（绝不让插件自己的值成为恢复基线）。
      if (captureHostStyle(container) !== true) return false;
      // 沿用宿主原本的优先级：插件只改「谁长多少」，绝不顺手改级联强度，也不用 !important 压主题。
      try { style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY, desired, currentPriority); } catch { return false; }
      // 回读：宿主可能规范化文本形式（例如补空格），恢复判定必须用实际写入的状态。
      applied = {
        container,
        written: readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY),
        writtenPriority: readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY),
      };
      return true;
    };

    /** 交还控制权：只有当前值与优先级都仍是本次写入，才写回宿主原值（否则保留外部状态）。 */
    const restore = () => {
      const entry = applied;
      applied = null;
      if (entry === null) return;
      const style = styleOf(entry.container);
      if (style === null) return;
      if (readValue(style, SIDEBAR_SPLIT_TRACK_PROPERTY) !== entry.written) return;
      if (readPriority(style, SIDEBAR_SPLIT_TRACK_PROPERTY) !== entry.writtenPriority) return;
      if (hostCapture === null || hostCapture.container !== entry.container) return;
      try {
        if (hostCapture.value === "") style.removeProperty(SIDEBAR_SPLIT_TRACK_PROPERTY);
        else style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY, hostCapture.value, hostCapture.priority);
      } catch { /* 还原失败只影响外观，后续同步仍按同一规则重试。 */ }
    };

    /** 取消待执行的重试（去重的唯一出口）：dispose、容器更换、状态离开 pending 时都必须调用。 */
    const cancelPendingRetry = () => {
      if (pendingRetryTimer === null) return;
      const timer = pendingRetryTimer;
      pendingRetryTimer = null;
      try {
        // 句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };

    /** 结束 pending：清掉容器身份、重试预算与待执行定时器（三个字段必须一起复位，绝不留半状态）。 */
    const clearPending = () => {
      pending = null;
      cancelPendingRetry();
    };

    /**
     * 为「暂不可读」安排一次短延迟重试。
     *
     * 三条硬约束（对应契约里的「有界、去重、可取消」）：
     * - 去重：pendingRetryTimer 非空就直接返回，重复同步（面板 observer / 2.5 秒轮询 / 宿主广播）
     *   绝不堆积定时器；
     * - 有界：**实际执行过的 timer 轮数**达到上限后不再重排，按「组成确实失效」交还宿主样式；
     * - 可取消：dispose、容器更换、状态离开 pending 时都会 cancelPendingRetry。
     *
     * 预算的记账点只有一个：**这个回调真正开始执行的那一刻**。外部同步（sessions 广播 /
     * observer / 轮询）无论触发多少次都不消耗预算——它们只是在同一个 400ms 等待期内重复求值，
     * 若也去自增 attempts，真实 timer 一轮都没跑预算就被烧完，重启恢复窗口会提前闪回宿主比例。
     *
     * 回调里先出队，把这一轮计入预算，再用**真实读面**重新求值一次（sync(lastReader)）：
     * 若读面已经恢复，sync 会走正常路径重新落到目标配比并立即清空 pending；若仍是 pending，
     * sync 会在预算内重排下一个 timer，预算耗尽时则 clearPending + restore（有界收敛）。
     * 没有可用调度器时只是「这一轮不重试」，任何一次既有同步仍会重新求值，绝不影响页面其它行为。
     */
    const schedulePendingRetry = (container) => {
      if (disposed || pendingRetryTimer !== null) return;
      try {
        pendingRetryTimer = globalThis.setTimeout(() => {
          pendingRetryTimer = null;
          if (disposed) return;
          // 迟到 timer：容器/状态已经变过（session 切换、容器重挂载、已收敛），一律不再动作。
          if (pending === null || pending.container !== container) return;
          const entry = pending;
          // 读面函数缺失时不做任何猜测性写入：这一轮什么都不做，等下一次真实同步。
          if (typeof lastReader !== "function") return;
          // 这一轮 timer 确实执行了 → 只有这里消耗一轮预算（外部同步绝不走这条路径）。
          pending = { container, attempts: entry.attempts + 1 };
          sync(lastReader);
          // sync 自己会在「仍是 pending 且预算未耗尽」时重排。这里只兜底它提前返回的情况
          // （例如 document 读面不可用）：pending 还在、预算还有、却没有 timer，必须补一个，
          // 否则有界重试会静默中断；attempts 已经自增，因此补排也必然有界。
          if (pending !== null && pending.container === container
            && pendingRetryTimer === null
            && pending.attempts < SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS) {
            schedulePendingRetry(container);
          }
        }, SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS);
      } catch {
        // 没有可用调度器：放弃这一轮重试（pending 保留，下一次同步会重新求值）。
        pendingRetryTimer = null;
      }
    };

    /**
     * 按当前右栏 DOM 组成重估一次列宽配比。
     *
     * 读面全部由调用方以参数交进来（readTarget 每次现读 session / panel / split 容器）：
     * 这里**不引用** install 体内的任何后置 const（那是 TDZ 陷阱的来源），所有输入都是显式依赖，
     * 调用点必须自己保证它们就绪。
     *
     * readTarget 返回 { status, container }：
     * - status 缺省 / "target"：组成可证明，按 applyRatio 施加目标配比；
     * - status "pending"：**已经写过目标配比**、但这一轮读不出列 1 的组成（重启恢复窗口）——
     *   继续用 applyRatio 维持/修复目标配比并短延迟重试，绝不闪回宿主默认值，也绝不覆盖外部值；
     * - 其余（null、单列、明确非目标）：交还宿主样式。
     *
     * 返回 true 表示这一轮之后插件仍持有 pending 或配比确实落在容器上（含幂等命中），
     * false 表示已还原 / 让位 / 未写入。调用方（requestSplitTrackSync 的各入口）不使用这个布尔值，
     * 它只服务于重试回调的兜底重排。
     */
    const sync = (readTarget) => {
      if (disposed) return false;
      // 记住本次的真实读面：pending 重试 timer 必须用它重新现读状态，而不是回放上一轮结论。
      if (typeof readTarget === "function") lastReader = readTarget;
      // document 读面不可用：连「有没有分栏容器」都无法证明，保持现状（绝不猜测性还原）。
      let doc = null;
      try { doc = globalThis.document ?? null; } catch { doc = null; }
      if (doc === null || typeof doc.querySelector !== "function") return applied !== null;
      // readTarget 自己负责「面板属于哪个 session」与「两列分不分得清」；拿不到可证明的组成
      // （面板没挂载 / 单列 / 三列 / Expert Group 页消失 / session 切换 / 读面抛错）时交还宿主。
      let target = null;
      // 读面抛错等价于「组成读不出来」：交还宿主，绝不让异常外溢到同步调用点
      // （那些调用点只包了「失败不影响宿主」的兜底，异常外溢会让后面的宽度/手柄逻辑一起被跳过）。
      try { target = typeof readTarget === "function" ? readTarget(doc) : null; } catch { target = null; }
      if (target === null || target.container === null || target.container === undefined) {
        clearPending();
        restore();
        return false;
      }
      // 容器换了（宿主重挂载 / 切到另一条 surface）：先作废上一轮的 pending 记账，再交还旧容器。
      if (pending !== null && pending.container !== target.container) clearPending();
      if (applied !== null && applied.container !== target.container) restore();
      // 「暂不可读」只在**已经写过目标配比**之后才成立：没有 applied 就没有需要保持的样式，
      // 首次接管必须继续走原有 fail-closed 语义——绝不因为列 1 读不出来就去猜页面归属，
      // 也绝不凭空列或缺失 inventory 把未知页面当成目标（这条边界不能放松）。
      if (target.status === "pending" && applied !== null && applied.container === target.container) {
        // attempts 只统计**实际执行过的 pending retry timer 轮数**（由 schedulePendingRetry 的
        // 回调自增）。外部同步——sessions 广播、面板 observer、2.5 秒轮询——无论在同一等待期内
        // 触发多少次，都既不消耗预算也不重置预算，只维持 pending 并保证最多一个 timer。
        const attempts = pending !== null && pending.container === target.container ? pending.attempts : 0;
        if (attempts < SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS) {
          // 暂不可读期间同样要维持配比，不能只「保持当前样式」：宿主可能在这段窗口里重渲染回
          // 它自己的等分形态（甚至清掉内联声明），那样错误比例会一直留在屏幕上，直到预算耗尽
          // 也回不到 40/60。这里复用与「组成可证明」时**完全相同**的 applyRatio：
          // - 目标值 / 宿主自己的等分 / 宿主清空内联声明 → 保持或修复回目标配比；
          // - 外部刻意写下的非等分值 → 由 shouldApply 让位，绝不覆盖（不引入第二套写入规则）。
          applyRatio(target.container);
          // 首次进入 pending 才建立记账（attempts 从 0 起）；已存在时原样保留已消耗的预算，
          // 绝不因外部同步累加（那会让预算在 timer 一轮都没跑时就被烧完）或重置。
          if (pending === null) pending = { container: target.container, attempts: 0 };
          schedulePendingRetry(target.container);
          // 保持 pending：组成还没恢复，继续有界重试（applyRatio 让位时也不改写外部值）。
          return true;
        }
        // 预算已经被**实际 timer 轮次**耗尽仍读不出来：按「组成确实失效」交还宿主样式并停止重排。
        clearPending();
        restore();
        return false;
      }
      // 组成可证明：清空 pending 记账后按目标配比重新求值（读面恢复时这一步会清掉重试预算）。
      clearPending();
      // 「暂不可读」但还没有可保持的样式：这一轮什么都不写（不是目标，也不猜测），
      // 由后续同步在组成可证明时再施加。
      if (target.status === "pending") return false;
      return applyRatio(target.container);
    };

    return {
      sync,
      /**
       * 卸载收尾：取消待执行的重试、还原内联声明并置位 disposed，之后任何迟到同步都不再写入。
       * 定时器必须在这里释放——卸载后插件不得再碰宿主样式，也不留下泄漏的 timer。
       */
      dispose() {
        disposed = true;
        clearPending();
        restore();
      },
    };
  }

  /* ----------------------------------------------------------------------------------------------- *
   * realm 级共享 Auto 账本（跨 bundle 重新执行/HMR）、持久归属标记（跨整页刷新）与有界诊断
   * ----------------------------------------------------------------------------------------------- */

  /**
   * 本 realm 的共享 Auto 账本槽位。
   *
   * 症状与根因（现场证据）：DSH 的 ClientModuleSystem 支持 HMR，插件客户端模块被失效后会在**同一个
   * realm 重新执行整份 bundle**（见 client-freshness.js 的 REGISTERED_LOADERS_KEY 说明）。这些账本
   * 原先建在 createExpertGroupPanel 的工厂闭包里，bundle 重新执行即全部归零：一个正在运行的子代理
   * 期间跑过构建（HMR）之后，它那个已经打开的 tab 在下一次收养时只能落到 manual 兜底——Auto 从此
   * 再也不会把它收回去（用户看到的正是「只有能跑构建的角色更容易残留」）。
   *
   * 因此账本必须挂在 realm 的 globalThis 上（与 client-freshness 同一手法、同一条注释风格）：
   * 首次执行创建，之后每次 bundle 重新执行都复用同一批 Map。整页刷新或进程重启后 realm 是新的，
   * 账本自然为空——那条安全取舍由**持久归属标记**（见 SIDEBAR_AUTO_OWNERSHIP_KEY）承担。
   *
   * globalThis 不可用 / 被冻结 / 写入被拒时退回「每次执行各自 new Map」的旧行为，绝不抛错（同
   * client-freshness 的降级策略）。
   */
  const SIDEBAR_SHARED_AUTO_LEDGER_KEY = Symbol.for("dsh-expert-group/sidebar#shared-auto-ledger");
  const SIDEBAR_SHARED_AUTO_LEDGER_VERSION = 1;
  /** 持久归属标记的版本化键（与 dsh-expert-group:rightbar-presented:v1 同命名风格）。 */
  const SIDEBAR_AUTO_OWNERSHIP_KEY = "dsh-expert-group:auto-ownership:v1";
  const SIDEBAR_AUTO_OWNERSHIP_LIMIT = 128;
  const SIDEBAR_AUTO_OWNERSHIP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO = "auto";
  const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL = "manual";
  /** 归属标记的内存索引槽位（与 localStorage 同源 write-through；测试可重置）。 */
  const SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY = Symbol.for("dsh-expert-group/sidebar#auto-ownership-memory");
  /** 有界诊断环形缓冲：只记结论摘要，绝不记提示词 / 消息正文 / 令牌 / 凭据。 */
  const SIDEBAR_AUTO_DIAG_KEY = "dsh-expert-group:auto-diag:v1";
  const SIDEBAR_AUTO_DIAG_LIMIT = 60;
  const SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS = 360;
  const SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS = 96;
  /** 账本里八份 Map 的字段名（顺序即诊断里的 sizes 顺序）。 */
  const SIDEBAR_SHARED_AUTO_LEDGER_FIELDS = [
    "origin", "suppressed", "closeAttempts", "closeAttemptOwners",
    "closeVerifications", "closeCooldowns", "tabMisses", "tabCloseInFlight",
  ];

  /** 安全取 realm 的 globalThis：不可用时给 null，调用方一律走降级分支。 */
  const sidebarRealmHost = () => {
    try {
      return typeof globalThis === "object" && globalThis !== null ? globalThis : null;
    } catch {
      return null;
    }
  };

  /** 安全读 localStorage：缺失 / 被拒 / 抛错一律返回 null（调用方静默降级）。 */
  const sidebarLocalStorage = () => {
    try {
      const host = sidebarRealmHost();
      const storage = host === null ? null : host.localStorage;
      if (storage === null || storage === undefined) return null;
      if (typeof storage.getItem !== "function" || typeof storage.setItem !== "function") return null;
      return storage;
    } catch {
      return null;
    }
  };

  /** 有界文本字段：非字符串按字符串化处理并截断，空值返回 undefined（不写这个字段）。 */
  const sidebarBoundedText = (value) => {
    if (value === null || value === undefined) return undefined;
    const text = typeof value === "string" ? value : String(value);
    if (text.length === 0) return undefined;
    return text.length > SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS ? text.slice(0, SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS) : text;
  };

  /** 复合键摘要：只落 hash，绝不落 session / root / 地址原文。 */
  const sidebarAutoKeyDigest = (key) => {
    const source = typeof key === "string" ? key : String(key);
    let hash = 0x811c9dc5;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return "k" + hash.toString(36);
  };

  const sidebarAutoScopedKey = (sessionId, rootId, address) => String(sessionId) + "|" + String(rootId) + "|" + String(address);

  /**
   * realm 共享 Auto 来源账本（sharedAutoLedger.origin）条目的唯一构造函数。
   *
   * 条目形状：{ sessionId, rootSessionId, address, tabId }。**tabId 是这条账本的全部证明力所在**：
   * 它必须是「写入这一刻，插件亲眼在宿主 inventory 里读到的那个 tab」。
   *
   * - 非 null：这条条目证明「这个 tab 是 Auto 亲手打开/替换并落地的那一个」。任何据此认定 auto 的
   *   位置都必须要求 entry.tabId 与当前观察到的 tabId **逐字相等**；只要求「有条目」是不够的
   *   （缺陷 1：旧 tab 被用户/宿主移除而插件未观察到时，同 realm 的收养会把用户新开的同地址 tab
   *   当成 Auto 的旧 tab 认领，资源一空闲就把它关掉）。
   * - null：只表示「本次运行已经为这个资源发出过一次 Auto 打开、落地证据还没到」这条**去重记账**，
   *   它**不是**归属证据——任何收养 / 关闭判据都不许把它当作 auto。
   *
   * 只有插件亲眼观察到的那次 Auto 打开/替换落地（recordSidebarTab 从宿主 inventory 读到 tabId 的
   * 那一刻）才允许写入或刷新 tabId。宿主合法重 mint 新 id 而插件没有观察到时，这条绑定随之失配，
   * 收养一律退化成 manual——宁可漏收一次（tab 留在右栏交给用户手动处理），也绝不误关一个可能是
   * 用户自己刚打开的 tab。
   */
  const sidebarAutoOriginEntry = (sessionId, rootId, address, tabId) => ({
    sessionId,
    rootSessionId: rootId,
    address,
    tabId: typeof tabId === "string" && tabId.length > 0 ? tabId : null,
    /**
     * 写入时刻：**只有占位**（tabId === null，「打开已发出、落地证据还没到」）用它判 TTL，
     * 见 SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS 与 sweepAutoOpenPlaceholders。
     * 落地条目（tabId 非 null）不使用它：那条生命周期由既有收口路径负责（verified-closed /
     * inventory-absent / tab-recycled / resource-running），比 TTL 精确得多，绝不能被 TTL 顺手回收。
     */
    writtenAt: Date.now(),
  });

  /** 读一条来源账本条目绑定的 tabId：缺失 / 畸形一律 null（调用方必须按「不是我们的 tab」处理）。 */
  const sidebarAutoOriginTabIdOf = (entry) => {
    if (entry === null || entry === undefined || typeof entry !== "object") return null;
    return typeof entry.tabId === "string" && entry.tabId.length > 0 ? entry.tabId : null;
  };

  /** 读一条来源账本条目的写入时刻：缺失 / 畸形一律 0（按「最旧」处理，优先回收）。 */
  const sidebarAutoOriginWrittenAtOf = (entry) => {
    if (entry === null || entry === undefined || typeof entry !== "object") return 0;
    const value = Number(entry.writtenAt);
    return Number.isFinite(value) ? value : 0;
  };

  /**
   * 写一条诊断（环形、有界、失败静默）。
   *
   * 结构：{ t, kind, event?, action?, verdict?, reason?, key?, origin?, reused?, degraded?, sizes? }，
   * key 一律是摘要（sidebarAutoKeyDigest），绝不含原文；单条 JSON 超过硬上限时先丢 sizes 再整体丢弃。
   */
  const recordSidebarAutoDiag = (entry) => {
    try {
      const storage = sidebarLocalStorage();
      if (storage === null) return;
      const source = entry !== null && typeof entry === "object" ? entry : {};
      const normalized = { t: Date.now() };
      for (const field of ["kind", "event", "action", "verdict", "reason", "key", "origin"]) {
        const value = sidebarBoundedText(source[field]);
        if (value !== undefined) normalized[field] = value;
      }
      if (source.reused === true) normalized.reused = true;
      if (source.degraded === true) normalized.degraded = true;
      if (source.sizes !== null && typeof source.sizes === "object") {
        const sizes = {};
        for (const name of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
          const value = Number(source.sizes[name]);
          if (Number.isFinite(value) === true) sizes[name] = Math.max(0, Math.trunc(value));
        }
        normalized.sizes = sizes;
      }
      let serialized = JSON.stringify(normalized);
      if (serialized.length > SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS) {
        delete normalized.sizes;
        serialized = JSON.stringify(normalized);
      }
      if (serialized.length > SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS) return;
      let list = [];
      const raw = storage.getItem(SIDEBAR_AUTO_DIAG_KEY);
      if (typeof raw === "string" && raw.length > 0) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed) === true) list = parsed.slice(-SIDEBAR_AUTO_DIAG_LIMIT);
      }
      list.push(JSON.parse(serialized));
      storage.setItem(SIDEBAR_AUTO_DIAG_KEY, JSON.stringify(list.slice(-SIDEBAR_AUTO_DIAG_LIMIT)));
    } catch {
      /* 诊断只服务排查：任何失败都静默，绝不阻断功能。 */
    }
  };

  /** 新建一份共享 Auto 账本（八份 Map + 必要元数据）。 */
  const createSidebarSharedAutoLedger = () => {
    const ledger = { version: SIDEBAR_SHARED_AUTO_LEDGER_VERSION, createdAt: Date.now() };
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) ledger[field] = new Map();
    return ledger;
  };

  /**
   * 鸭子类型校验：只认「版本一致 + 八份 Map 都在」的账本，避免跨 realm / 旧格式的脏值被复用。
   * 不用 instanceof：测试替身与 vm realm 里的 Map 不共享构造函数。
   */
  const isSidebarSharedAutoLedger = (value) => {
    if (value === null || typeof value !== "object") return false;
    if (value.version !== SIDEBAR_SHARED_AUTO_LEDGER_VERSION) return false;
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
      const map = value[field];
      if (map === null || typeof map !== "object" || typeof map.get !== "function" || typeof map.set !== "function") return false;
    }
    return true;
  };

  /** 各 Map 规模的只读快照（诊断用；缺失字段按 0 计）。 */
  const sidebarSharedAutoLedgerSizes = (ledger) => {
    const sizes = {};
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) {
      const map = ledger === null || ledger === undefined ? null : ledger[field];
      sizes[field] = map !== null && typeof map === "object" && Number.isFinite(Number(map.size)) ? Number(map.size) : 0;
    }
    return sizes;
  };

  const sidebarSharedAutoLedgerTotal = (ledger) => {
    const sizes = sidebarSharedAutoLedgerSizes(ledger);
    let total = 0;
    for (const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS) total += sizes[field];
    return total;
  };

  /**
   * 取本 realm 的共享 Auto 账本：命中即复用（reused=true），否则新建并写回 realm 槽位。
   *
   * 写回失败（globalThis 被冻结 / 受限）时只返回这一份新账本，绝不抛错：行为退回「每次执行各自
   * new Map」的旧语义，功能可用性不受影响。
   */
  const resolveSidebarSharedAutoLedger = () => {
    const host = sidebarRealmHost();
    let existing = null;
    if (host !== null) {
      try { existing = host[SIDEBAR_SHARED_AUTO_LEDGER_KEY]; } catch { existing = null; }
    }
    if (isSidebarSharedAutoLedger(existing) === true) {
      return { ledger: existing, reused: true, degraded: false };
    }
    const created = createSidebarSharedAutoLedger();
    let degraded = host === null;
    if (host !== null) {
      try {
        Object.defineProperty(host, SIDEBAR_SHARED_AUTO_LEDGER_KEY, { value: created, configurable: true, writable: true });
      } catch {
        degraded = true;
      }
    }
    return { ledger: created, reused: false, degraded };
  };

  /**
   * 归属标记的内存索引（懒加载 + write-through）：命中 realm 槽位即复用，否则新建并写回。
   * 槽位不可用时返回 null——此时所有读写直接走 localStorage（仍然正确，只是每次都要解析）。
   */
  const sidebarOwnershipMemory = () => {
    const host = sidebarRealmHost();
    if (host === null) return null;
    try {
      const existing = host[SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY];
      if (existing !== null && typeof existing === "object" && existing.entries instanceof Map) return existing;
    } catch { return null; }
    try {
      const created = { entries: new Map(), loaded: false };
      Object.defineProperty(host, SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY, { value: created, configurable: true, writable: true });
      return created;
    } catch {
      return null;
    }
  };

  /**
   * 把持久条目数组整理成 Map：只做两件「数据卫生」的事——丢掉 TTL 过期条目、同一 key 去重
   * （manual 优先）。
   *
   * **这里刻意不做任何按上限的 LRU 淘汰**（缺陷 2）：条目描述的 owner 在载入这一刻完全可能仍然
   * 有效（宿主里那个 tab 还开着，只是插件这一帧还没有 inventory 证据），LRU 淘汰它们等于永久丢掉
   * 一批仍然打开的 Auto owner——它们再也不会被自动收回，刷新也不能恢复。容量改由**写入路径**
   * 分账 fail-closed 控制：新增 auto 条目在满额时被拒绝，manual 条目照常写入（见
   * writeSidebarAutoOwnership / sidebarOwnershipAcceptsNewAuto）。
   */
  const normalizeSidebarOwnershipEntries = (raw, now) => {
    const entries = new Map();
    if (Array.isArray(raw) !== true) return entries;
    for (const item of raw) {
      if (item === null || typeof item !== "object") continue;
      const key = typeof item.key === "string" ? item.key : null;
      if (key === null) continue;
      const updatedAt = Number(item.updatedAt);
      if (Number.isFinite(updatedAt) !== true || now - updatedAt > SIDEBAR_AUTO_OWNERSHIP_TTL_MS) continue;
      const origin = item.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const previous = entries.get(key);
      if (previous !== undefined && previous.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) continue;
      /**
       * tabId 是「写下这条归属的那一刻，宿主 inventory 里这个地址的 tab id」（缺省表示这次写入没有
       * 可证明的 tab）。只有 **auto** 条目在收养时会按它比对（见 recordSidebarTab 的 tabId 绑定闸门）：
       * 宿主重新 mint 了新 id 就说明这条条目描述的那个 tab 已经不存在，此时宁可退化成 manual
       * （漏收一次、留给用户手动处理），也绝不让 Auto 去关一个可能是用户自己刚打开的 tab。
       */
      entries.delete(key);
      entries.set(key, {
        key,
        origin,
        updatedAt,
        reason: sidebarBoundedText(item.reason),
        tabId: sidebarBoundedText(item.tabId),
      });
    }
    return entries;
  };

  /** 读取（必要时从 localStorage 懒加载）归属索引；两处都不可用时返回空的临时索引。 */
  const sidebarOwnershipEntries = () => {
    const memory = sidebarOwnershipMemory();
    if (memory === null) {
      const storage = sidebarLocalStorage();
      if (storage === null) return new Map();
      try {
        const raw = storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
        return normalizeSidebarOwnershipEntries(raw === null || raw.length === 0 ? [] : JSON.parse(raw), Date.now());
      } catch {
        return new Map();
      }
    }
    if (memory.loaded !== true) {
      memory.loaded = true;
      const storage = sidebarLocalStorage();
      if (storage !== null) {
        try {
          const raw = storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
          memory.entries = normalizeSidebarOwnershipEntries(raw === null || raw.length === 0 ? [] : JSON.parse(raw), Date.now());
        } catch {
          memory.entries = new Map();
        }
      }
    }
    return memory.entries;
  };

  /** 把索引写回 localStorage（失败 / 不可用一律静默：内存仍然一致，只是不持久）。 */
  const persistSidebarOwnership = (entries) => {
    const storage = sidebarLocalStorage();
    if (storage === null) return false;
    try {
      const list = [];
      for (const entry of entries.values()) {
        const item = { key: entry.key, origin: entry.origin, updatedAt: entry.updatedAt };
        if (entry.reason !== undefined) item.reason = entry.reason;
        // tabId 必须随条目一起持久化：整页刷新之后它是唯一能证明「这条 auto 归属描述的是哪个 tab」的证据。
        if (entry.tabId !== undefined) item.tabId = entry.tabId;
        list.push(item);
      }
      storage.setItem(SIDEBAR_AUTO_OWNERSHIP_KEY, JSON.stringify(list));
      return true;
    } catch {
      return false;
    }
  };

  /**
   * 读一个地址的持久归属：返回 { origin, tabId }，没有标记时返回 null。
   *
   * - origin 命中 manual 一律 manual（安全侧），命中 auto 才 auto；
   * - tabId 是写入那一刻宿主 inventory 里这个地址的 tab id（没有可证明的 tab 时为 null）；
   *   只有 auto 条目会被调用方按它比对，manual 条目只按 origin 判定。
   *
   * 读取本身绝不修改任何状态，失败一律当作「没有标记」（调用方按 manual 兜底）。
   * options.quiet === true 时连诊断也不写：调用点可能是每轮同步都会跑的判据（自动打开候选、
   * 空闲资源的抑制清除扫描），它们的结论由各自的决策 / 删除诊断承担，不该把有界诊断环挤满。
   */
  const readSidebarAutoOwnershipEntry = (sessionId, rootId, address, options) => {
    try {
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const entry = sidebarOwnershipEntries().get(key);
      const origin = entry === undefined
        ? null
        : (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO);
      if (options === null || options === undefined || options.quiet !== true) {
        recordSidebarAutoDiag({ kind: "ownership", event: "hit", origin, key: sidebarAutoKeyDigest(key) });
      }
      if (entry === undefined) return null;
      return {
        origin,
        tabId: typeof entry.tabId === "string" && entry.tabId.length > 0 ? entry.tabId : null,
      };
    } catch {
      return null;
    }
  };

  /** 持久表里的 auto 条目数（容量只对 auto 计账：manual 是用户意图，恒优先、从不被容量拒绝）。 */
  const sidebarOwnershipAutoCount = (entries) => {
    let count = 0;
    for (const entry of entries.values()) {
      if (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO) count += 1;
    }
    return count;
  };

  /**
   * 持久表是否还容得下这个地址的一条 **auto** 归属（fail-closed 容量判据，缺陷 2）。
   *
   * 判据只有一条：写入之后 auto 条目数不得超过 SIDEBAR_AUTO_OWNERSHIP_LIMIT。**绝不为了腾位而
   * 淘汰任何已有条目**——持久表里的 auto 条目描述的 owner 在本帧完全可能仍然有效（宿主里那个 tab
   * 还开着），LRU（或任何「看起来更旧」的排序）淘汰它同样会让那个 tab 永久失去 Auto 归属，刷新
   * 也不能恢复。
   *
   * manual 条目不参与这里的容量判定：它表达用户意图，写入 / 改写一律照常（手动恒优先）。因此本
   * 函数回答的是「新增/改写一条 auto 条目能不能被保留」，而不是「表里总共有多少条」。
   *
   * 读取失败（localStorage 不可用 / 抛错）按「容得下」处理：内存账本仍然守着同一份容量，持久层
   * 只是「刷新之后的记忆」，读不到它不该让自动打开整体失效（与既有的静默降级一致）。
   */
  const sidebarOwnershipAcceptsNewAuto = (sessionId, rootId, address) => {
    try {
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const existing = entries.get(key);
      const existingIsAuto = existing !== undefined && existing.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const nextAutoCount = sidebarOwnershipAutoCount(entries) - (existingIsAuto ? 1 : 0) + 1;
      return nextAutoCount <= SIDEBAR_AUTO_OWNERSHIP_LIMIT;
    } catch {
      return true;
    }
  };

  /**
   * 写入归属标记（内存与 localStorage 同一处收口）并记一条诊断；返回是否真的写进去了。
   *
   * tabId 只在**调用方真的读到了宿主 inventory 里这个地址的 tab** 时才传（当前唯一的 auto 调用点
   * 是 recordSidebarTab）：它把这条归属绑定到具体的 tab 上，刷新之后的收养必须靠它证明「还是同一个
   * tab」（见 recordSidebarTab 的 tabId 绑定闸门）。manual 条目不需要它，传 undefined 即可。
   *
   * 容量 fail-closed（缺陷 2）：会挤掉仍有效 owner 的新增 / 改写（即写入之后 auto 条目数超过上限）
   * **一律拒绝**，并留下一条 reject/capacity 诊断。manual 写入从不被容量拒绝——但同样绝不为了腾位
   * 去淘汰任何已有条目，因此持久表最多是「上限条 auto + 用户自己产生的 manual 条目」。
   * 到达上限是可用性代价而不是错误：那个资源不自动打开，用户仍然可以手动打开（手动打开照常写
   * manual 归属，见 handleSidebarAction 的入口写入）。
   */
  const writeSidebarAutoOwnership = (sessionId, rootId, address, origin, reason, tabId) => {
    try {
      const normalizedOrigin = origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      if (normalizedOrigin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
        && sidebarOwnershipAcceptsNewAuto(sessionId, rootId, address) !== true) {
        recordSidebarAutoDiag({ kind: "ownership", event: "reject", origin: normalizedOrigin, reason: "capacity", key: sidebarAutoKeyDigest(key) });
        return false;
      }
      entries.delete(key);
      entries.set(key, {
        key,
        origin: normalizedOrigin,
        updatedAt: Date.now(),
        reason: sidebarBoundedText(reason),
        tabId: sidebarBoundedText(tabId),
      });
      persistSidebarOwnership(entries);
      recordSidebarAutoDiag({ kind: "ownership", event: "write", origin: normalizedOrigin, reason, key: sidebarAutoKeyDigest(key) });
      return true;
    } catch {
      /* 归属标记只影响「刷新之后还认不认」，任何失败都静默。 */
      return false;
    }
  };

  /**
   * 删除归属标记（与写入同源：内存删掉后立刻落盘）。
   *
   * 默认**拒绝**删除 manual 条目：manual 是用户的手动意图（手动关闭 / 手动打开），而调用这条删除的
   * 路径全是 Auto 自己的收口（verified-close / inventory-absent / tab-recycled / resource-running）。
   * 让 Auto 的收口顺手删掉用户的抑制，就等于「刷新之后用户的关闭又被撤销」——正是 P1-B 要堵的洞。
   * 因此这里只回答「Auto 自己的归属是否已经不需要了」，manual 条目一律保留并留一条 keep 诊断。
   *
   * options.manual === true 是唯一的例外：只有「观察到资源已经明确空闲（ready）」那条专用清点路径
   * 才允许清除 manual（见 clearManualSuppressionOfIdleResources），语义是「这一轮运行已经结束，
   * 用户当时的关闭意图不再需要跨运行保留」。
   */
  const deleteSidebarAutoOwnership = (sessionId, rootId, address, reason, options) => {
    try {
      const entries = sidebarOwnershipEntries();
      const key = sidebarAutoScopedKey(sessionId, rootId, address);
      const entry = entries.get(key);
      if (entry === undefined) {
        recordSidebarAutoDiag({ kind: "ownership", event: "delete-miss", reason, key: sidebarAutoKeyDigest(key) });
        return false;
      }
      if (entry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
        && (options === null || options === undefined || options.manual !== true)) {
        recordSidebarAutoDiag({ kind: "ownership", event: "keep", origin: SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, reason, key: sidebarAutoKeyDigest(key) });
        return false;
      }
      entries.delete(key);
      persistSidebarOwnership(entries);
      recordSidebarAutoDiag({ kind: "ownership", event: "delete", reason, key: sidebarAutoKeyDigest(key) });
      return true;
    } catch {
      return false;
    }
  };

  /** 记录一次自动打开/自动关闭决策（候选 + 结算），失败原因只留截断后的一行。 */
  const recordSidebarAutoDecision = (event, candidate, verdict, reason) => {
    recordSidebarAutoDiag({
      kind: "decision",
      event,
      action: candidate === null || candidate === undefined ? undefined : candidate.kind,
      verdict,
      reason,
      key: candidate === null || candidate === undefined ? undefined : sidebarAutoKeyDigest(candidate.key),
    });
  };

  function createExpertGroupPanel(deps) {
    const config = object(deps);
    const react = config.react;
    const primitives = config.primitives || {};
    if (!react || typeof react.createElement !== "function") {
      return function MissingReactPanel() { return null; };
    }
    styleTag();

    /**
     * 最近一次成功的 normalized 快照缓存（挂在 createExpertGroupPanel 闭包上，跨 Panel 实例共享，
     * 按 rootSessionId 隔离）。
     *
     * 症状与根因：真实 DSH 的 keyed session surface 在切换会话时可能卸载旧 Panel 实例、再用同一个
     * Panel 函数挂载新实例。旧实例卸载后，新实例的 useState 从「snapshot=null + loading=true」重新
     * 开始，于是同一个 root 的任务树会先渲染两条 .deg_expert_group_skeleton，等 RPC 回来才恢复——
     * 用户在切换子代理时看到的就是这两块灰色占位闪烁。
     *
     * 缓存只解决内容首屏：命中时让新实例的初始 state 直接就是「已加载」的快照（loading=false），
     * 首帧即渲染任务树；没有缓存的真正首次访问仍按原语义显示 skeleton。后台刷新（RPC、通知、轮询、
     * 尾随刷新、展开状态）一律照旧发起，因此缓存不延迟数据更新，也不改变任何错误语义。
     *
     * 只缓存 normalized 成功快照（safeNormalize 通过且真正上屏的那一份）：失败、被取消或过期 root
     * 的响应都不进缓存，所以「旧会话内容不得显示到新会话」的边界不受影响。
     *
     * 渲染纯性：缓存的「命中即重排 LRU」副作用绝不能出现在渲染路径上。渲染期的访问被压缩到
     * 两处且都只允许纯读 peek：新实例挂载那一帧（懒初始化）与同一实例切换 root 的视图回退分支；
     * 同一 root 的普通重渲染（通知、轮询、展开状态变化）完全不触碰缓存。LRU 重排与写入一律
     * 收敛到事件路径，详见下方 peekCachedSnapshot / writeCachedSnapshot 的说明。
     */
    /**
     * 缓存的两条访问通道（渲染纯性的边界）：
     *
     * - peekCachedSnapshot：**纯读**，命中返回快照、未命中返回 null，绝不改动 Map 的迭代顺序。
     *   计算首屏状态必须发生在渲染期（React 的任何取值入口都在渲染阶段，要让首帧直接显示缓存
     *   的任务树，就不可能把这一次读取推迟到 effect），因此渲染路径只允许走这条纯读通道；
     *   纯读是「同样缓存内容 ⇒ 同样结果」的引用透明读取，不会给渲染引入可观察副作用。
     * - writeCachedSnapshot：唯一会**改动**缓存的入口（delete+set 重排 LRU、超限淘汰、写入新值），
     *   只允许在事件路径（RPC 成功回调）调用。旧实现在每次渲染里用「命中即重排」的读函数
     *   （readCachedSnapshot），StrictMode 的双渲染会把每次渲染额外变成两次 LRU 重排，
     *   视图回退分支更是每帧空转重排——那些重排全部从这里删除。
     *
     * 提权（LRU 新鲜度）语义因此收敛为「最近成功拉取过的 root 最新」：正在被观察的 root 由它自己的
     * 成功刷新（含内容不变的轮询响应）保持新鲜，只被渲染过却始终没拉取成功的 root 不会顶掉别人。
     */
    const SNAPSHOT_CACHE_LIMIT = 32;
    /** rootSessionId → 最近成功的 normalized 快照；Map 的迭代顺序即 LRU 顺序（末尾最新）。 */
    const snapshotCache = new Map();
    /**
     * 日常打开/关闭子代理 tab 不改写右栏宽度；只有首次从 Expert Group-only 单 pane 创建
     * 子代理 pane 时，install 侧事务会在 split() 前临时从 20% 扩到 50%。目标资源在返回 pane
     * 的 openTabs + DOM 证据都落地后才提交 other 模式，失败则恢复 Expert Group 的 20% 锁定。
     *
     * 这样移除了旧实现的 expandedSubagentTabs / pendingSubagentWidthTabs 与两档 25%↔50%
     * 换算，同时保留 tab 的开/关与外部关闭同步语义：它们只维护 sidebarTabRecordsRef 中的
     * 精确 tabId 记录。
     */
    /** 纯读缓存：命中返回快照，未命中返回 null；绝不重排 LRU、绝不写入（渲染路径只允许用它）。 */
    const peekCachedSnapshot = (rootSessionId) => {
      if (rootSessionId === "" || snapshotCache.has(rootSessionId) !== true) return null;
      return snapshotCache.get(rootSessionId) ?? null;
    };
    /**
     * 写缓存并做有限 LRU 淘汰：同一 root 覆盖旧值并移到最新；超过上限时从最久未使用的 root 开始
     * 删除，保证长时间反复切换会话也不会无界增长（上限内每个 root 至多一份快照）。
     */
    const writeCachedSnapshot = (rootSessionId, next) => {
      if (rootSessionId === "" || next === null || next === undefined) return;
      snapshotCache.delete(rootSessionId);
      snapshotCache.set(rootSessionId, next);
      while (snapshotCache.size > SNAPSHOT_CACHE_LIMIT) {
        const oldest = snapshotCache.keys().next();
        if (oldest.done === true) break;
        snapshotCache.delete(oldest.value);
      }
    };
    /**
     * 某个 root 的初始展示状态：命中缓存就是「已有快照、已加载」，未命中仍是 skeleton 语义。
     * 错误信息不缓存——上一次失败不该污染新实例的首屏（真正的失败会在本次刷新里重新得到）。
     * 只做纯读 peek：命中不改变 LRU 顺序，因此调用它（挂载帧 / 视图回退分支，含 StrictMode
     * 双渲染）不会产生任何缓存副作用。
     */
    const initialStateFor = (rootSessionId) => {
      const cached = peekCachedSnapshot(rootSessionId);
      return { rootSessionId, snapshot: cached, loading: cached === null, error: null };
    };

    /**
     * 跨 Panel 实例共享的 Auto 账本（同一插件 install 内共享；重装插件或重启进程即随之消失）。
     *
     * 症状与根因：真实 DSH 的 keyed session surface 会卸载旧 Panel 实例、再用同一个已安装组件挂载
     * 新实例，而宿主右栏的 tab 与它自己那份 inventory 原样保留。这三份账本原先都建在 Panel 内的
     * useRef 上，卸载即丢失，因此新实例在 syncSidebarTabRecords() 的收养路径里只能把宿主里已经
     * 存在的 tab 记成 manual 来源（recordSidebarTab 的兜底），Auto 随后主动放弃关闭它——用户看到的
     * 就是「子代理已经空闲，Auto 开出来的那个 tab 却永远留在右栏」。
     *
     * 只共享回答「这个 tab 是不是 Auto 亲手打开、还归不归 Auto 管」所必需的集合：
     * - origin：Auto 亲手发出过打开动作的资源（键与打开记录同构）；它同时是「绝不重复打开」的记账；
     * - suppressed：用户手动关闭过的资源，Auto 不得立刻重开；
     * - closeAttempts：自动关闭的有界重试计数（重挂载不得白送或重置预算）；
     * - closeAttemptOwners：每条 closeAttempts 预算**当前所有者**的不可复用令牌（见下方说明）。
     *
     * 重试预算必须带所有者身份：预支与回滚分别发生在「候选选择」和「动作在副作用之前被撤销」两个
     * 时刻，中间可能跨越一次面板重挂载或同一个实例的 A→B→A 回代。预算本身按 key 共享，因此旧代次
     * 的迟到回滚若只按 key 写回 attemptsBefore，就会删掉/覆盖新代次已经预支的那一笔预算——同一个
     * key 的实际 close 次数随之突破 3 次上限。owner 账本把「这笔预算现在是谁的」也放进同一层共享
     * 状态，回滚只认对象身份，旧令牌一律 fail-safe。
     *
     * 其余状态一律留在 Panel 实例内：在途动作与预留（reservation）、Auto 代次（epoch）、失败屏障、
     * busy 闸门、tab 打开记录（records/openings）、手动意图都属于「当前这一帧 surface 的在途状态」，
     * 跨实例共享只会让旧实例的在途状态污染新实例。键始终是（sidebar session + rootSessionId +
     * 资源地址）复合键，因此共享也不会让不同 root / 不同 session 互相影响。
     *
     * 生命周期（本轮修复）：这八份 Map 不只是「同一 install 内共享」，而是**本 realm 内共享**——
     * bundle 被 HMR 重新执行之后仍复用同一批 Map（见 resolveSidebarSharedAutoLedger）。否则一次
     * 构建（fixer 角色最容易触发）就会把「这个 tab 是 Auto 亲手打开的」全部抹掉，tab 随即被收养成
     * manual 并永久留在右栏。跨整页刷新/进程重启的归属由持久标记层负责（SIDEBAR_AUTO_OWNERSHIP_KEY）。
     */
    const sharedAutoLedgerState = resolveSidebarSharedAutoLedger();
    const sharedAutoLedger = sharedAutoLedgerState.ledger;
    recordSidebarAutoDiag({
      kind: "install",
      reused: sharedAutoLedgerState.reused,
      degraded: sharedAutoLedgerState.degraded,
      sizes: sidebarSharedAutoLedgerSizes(sharedAutoLedger),
    });
    if (sharedAutoLedgerState.reused === true && sharedAutoLedgerState.degraded !== true
      && sidebarSharedAutoLedgerTotal(sharedAutoLedger) > 0) {
      // 只在「复用了一份非空账本」时提示一行：用户开着 DevTools 就能确认 HMR 之后归属没有丢。
      try {
        console.info("[dsh-expert-group] 本 realm 已有共享 Auto 账本：本次装载复用既有的归属 / 预算 / 确认计数（bundle 重新执行或 HMR）");
      } catch { /* 控制台不可用不影响功能。 */ }
    }
    /**
     * realm 共享的 Auto 来源账本：key → { sessionId, rootSessionId, address, tabId }。
     *
     * tabId 是「Auto 打开/替换落地那一刻，插件亲眼在宿主 inventory 里读到的那个 tab」，它让这份
     * 跨 bundle 重新执行（HMR）/ 跨 Panel 实例的账本不再只是一句「我们打开过」——所有据此认定
     * auto 的位置都必须比对 tabId（见 sidebarAutoOriginEntry / sidebarAutoOriginTabIdOf）。
     */
    const sharedSidebarAutoOrigin = sharedAutoLedger.origin;
    const sharedSidebarAutoSuppressed = sharedAutoLedger.suppressed;
    const sharedSidebarAutoCloseAttempts = sharedAutoLedger.closeAttempts;
    /**
     * 跨 Panel 实例共享的「这条自动关闭重试预算归谁」账本：key → 本次预支预算的**不可复用**令牌。
     *
     * 键与 closeAttempts 完全同构，取值是候选选择那一刻新建的对象（对象身份即所有权），因此任何
     * 旧代次手里的令牌都不可能与后来者的令牌相等。写入与删除与 closeAttempts 同步进行，并沿用同一
     * 个 trimAutoKeyMap/128 上限，绝不引入第二份无界 Map。
     */
    const sharedSidebarAutoCloseAttemptOwners = sharedAutoLedger.closeAttemptOwners;
    /**
     * 跨 Panel 实例共享的「close 请求已经发出、等待 inventory 验证」状态：key → 验证记录
     * { sessionId, rootSessionId, tabId, address, attemptToken, manual, misses, deadline, lease }。
     *
     * 关闭请求 resolve 之后绝不能立刻收口：记录只在**连续两次可读 inventory 都读不到这个精确 tabId**
     * 时才算 verified-closed。验证链因此必须与来源账本同层共享——重挂载后的新实例继续采样、继续收口，
     * 而不是把「请求完成」当成「已经关闭」。租约同时被这条记录持有，下一轮同步绝不会重复 close。
     */
    const sharedSidebarAutoCloseVerifications = sharedAutoLedger.closeVerifications;
    /**
     * 跨 Panel 实例共享的自动关闭失败冷却：key → { step, until }。
     *
     * 与重试计数同层共享：scope remount 或同一个实例 A→B→A 绝不能绕过失败上限（否则频繁重挂载就等于
     * 无限重试）。generation token 只负责阻止旧动作越权，不改变这份预算的生命周期。
     */
    const sharedSidebarAutoCloseCooldowns = sharedAutoLedger.closeCooldowns;
    /**
     * 跨 Panel 实例共享的 Auto 候选采样计数：key → { sessionId, rootSessionId, tabId, misses }。
     *
     * 症状与根因：候选选择阶段的在场判据原先只采**一次**样。宿主 inventory 只要在这一帧短暂缺项
     * （布局换桶、面板重挂载、宿主提交窗口的中间态都是正常抖动），单次 absent 就会立刻删掉这个 key
     * 的 record / 来源 / 预算——tab 明明还在宿主里，却永久失去 Auto 归属，资源结束后再也不会被
     * 自动收回（用户看到的正是「偶尔漏收」）。记录同步器（record.misses）与关闭验证链
     * （verification.misses）都要求 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS 次**连续**缺失，候选选择
     * 必须与它们同一条确认语义，否则同一份 inventory 在两处被解释成两种强度。
     *
     * - 生命周期：第一次 absent/recycled 采样时写入；任一 present 采样立刻清零（与既有语义一致）；
     *   这个 key 的 Auto 关闭记账整体收口时（clearAutoCloseAttempt，覆盖预算 / owner / 冷却的
     *   所有入口）一并删除，因此绝不跨代残留；
     * - 计数只对**同一个 tabId** 有效：record 换成宿主新分配的 tabId 时旧计数自动作废；
     * - 限容：**纯 LRU**（按最近一次采样时间排序）+ SIDEBAR_AUTO_KEY_LIMIT，绝不新增无界 Map；
     *   绝不用当前实例的局部 record / 在途状态判定别的 scope 的共享条目（见 trimSharedSidebarAutoTabMisses）。
     */
    const sharedSidebarAutoTabMisses = sharedAutoLedger.tabMisses;
    /**
     * sharedSidebarAutoTabMisses 的限容淘汰：**纯 LRU**——按「最近一次采样」排序，淘汰最久没被采样的条目。
     *
     * 为什么这条 Map 绝不能用 trimAutoKeyMap(map, true) 那套「活动感知」淘汰：
     * 1. 生命周期不匹配。这份计数必须**跨 Panel 实例、跨 root / sidebar session 共享**（确认序列要在
     *    重挂载之后继续推进），而活动判定 sidebarAutoCloseKeyIsActive 读的是**当前这个实例**的局部
     *    在途状态（pending / opening / reservation / verification / cooldown）与**当前 scope** 的
     *    record。别的 scope 的条目在当前实例里天然「不活动」，于是它们会在别的 scope 的一次普通采样
     *    写入时被当成历史条目淘汰——正是本插件要修的「偶尔漏收」：目标 key 的确认计数被打回 1，永远
     *    到不了 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS，record / origin 保留但那个 tab 再也不自动收回。
     * 2. 采样计数本来就与在途状态无关：它只回答「这个 tabId 连续几次被**可读采样**判为不在场」。
     *    跨 scope 的条目同样需要完整数满两次，因此可淘汰性只能由「最后一次采样有多旧」决定，绝不能由
     *    当前帧的 record / 在途状态决定。
     *
     * 为什么 128 上限够用：确认只需 2 次采样，而**每次采样都会把这个 key 重新插到队尾**
     * （见 sampleAutoTabMisses），所以一个正在确认中的 key 只有在「它两次采样之间又插入了 128 次其它
     * 采样」时才会被挤掉；每个 surface 每轮至多推进自己的一条采样，真实轮询周期远小于这个量级。
     * 上限本身继续防止复合键（session + root + 资源地址）随长生命周期无界增长。
     */
    const trimSharedSidebarAutoTabMisses = () => {
      while (sharedSidebarAutoTabMisses.size > SIDEBAR_AUTO_KEY_LIMIT) {
        const oldest = sharedSidebarAutoTabMisses.keys().next();
        if (oldest.done === true) break;
        sharedSidebarAutoTabMisses.delete(oldest.value);
      }
    };
    /**
     * 跨 Panel 实例共享的「同一个 tab 上已经有一次关闭在途」租约：key =（sidebar session + root + tabId）
     * → 租约对象（身份 + 结算信号）。
     *
     * 症状与根因：宿主右栏的 close() 可能是异步的（返回 Promise，结算后才真的移除 tab）。旧 Panel 实例
     * 发出这次关闭后就被卸载了，但那次调用的续体仍在运行；而它的 pending 锁与 busy 闸门都是**实例级**
     * 的，新实例一概看不见——宿主 inventory 里这个 tab 还在，新实例收养它之后会为同一个 tabId 再发一次
     * close。宿主若非幂等（或复用了 tabId），用户就会看到重复副作用（关掉别人的 tab / 抛错）。
     *
     * 因此这把锁必须与来源账本同层共享：身份是（当前 sidebar session + root + tabId），Auto 单 tab 关闭、
     * 手动单 tab 关闭与批量关闭三个入口共用它；只在真正调用宿主 close 的那一小段持有，并在 finally 归还。
     * 锁只回答「这个 tab 现在有人在关吗」，不携带任何 Panel 实例状态。
     *
     * 值不是「无结果的 token」而是一份**可结算的租约**：它额外携带那一次 close 的真实结果（成功 / 失败）
     * 与一个等待信号。竞争方（用户触发的手动单项与批量）必须等到结算再决定下一步——上次成功就当作这个
     * tab 已经被关掉、绝不再 close；上次失败才允许用当前 inventory 复核同一个 tabId 后做一次有限重试。
     * 少了这层结果信号，等待者只能看到「锁空了」：要么对已经关掉的 tab 重复 close，要么把一次失败的
     * 竞争当成「有人处理了」而丢掉用户的关闭意图。
     */
    const sharedSidebarTabCloseInFlight = sharedAutoLedger.tabCloseInFlight;

    function Panel(props) {
      const ctx = props?.ctx || config.ctx;
      let tabInfo = null;
      if (typeof props?.useTabInfo === "function") {
        try { tabInfo = props.useTabInfo(); } catch { tabInfo = null; }
      }
      const tabParams = object(tabInfo?.tab?.navigation?.params);
      // 每次渲染只读一次 sessions 快照：官方目录项（mode/activity）与权威 title 都来自它，
      // 会话订阅触发的重渲染因此能刷新第三行。0.1.7-alpha.2 的目录改为按会话 id 索引的
      // 会话投影（projectionsBySession[sessionId].values.subagentCatalog）。
      const sessionsSnapshot = listSnapshot(config, ctx);
      // 目录查找表与快照同一帧只建一次：每行渲染都用它取官方目录项（mode/activity），
      // 旧实现每行都要线性扫描一次 entries，行数一多就成了主要渲染成本。
      const catalogEntryOf = createCatalogLookup(sessionsSnapshot);
      const fallbackCurrent = currentSessionIdOf(sessionsSnapshot);
      const scopedId = typeof config.sessions?.scopeOf === "function" ? config.sessions.scopeOf(ctx) : undefined;
      const scope = props?.scope || props?.tab?.scope || tabInfo?.scope || {};
      const sessionId = text(scope.sessionId, text(props?.sessionId, text(props?.rootSessionId, text(tabParams.rootSessionId, text(scopedId, fallbackCurrent)))));
      let resolvedRoot = sessionId;
      if (typeof config.resolveRootSessionId === "function" && sessionId !== null) {
        try { resolvedRoot = text(config.resolveRootSessionId(sessionId, undefined, listSnapshot(config, ctx)), sessionId); } catch { resolvedRoot = sessionId; }
      }
      const rootSessionId = resolvedRoot || "";
      // 右栏 tab 域按当前 Session 隔离；缺失时回退 root，保持旧宿主的确定性作用域。
      const sidebarSessionId = sessionId || rootSessionId;
      // 同一个 root 的最近成功快照由闭包缓存提供：重新挂载（新 Panel 实例）时首帧直接渲染任务树，
      // 不再先闪两条 skeleton；没有缓存的真正首次访问仍然是 snapshot=null + loading=true。
      // 这里用懒初始化：只有挂载那一帧才读一次缓存（StrictMode 会重复调用初始化函数，但缓存读
      // 是纯读、不重排 LRU，因此双调用没有任何可见副作用）。
      const statePair = typeof react.useState === "function"
        ? react.useState(() => initialStateFor(rootSessionId))
        : [initialStateFor(rootSessionId), () => {}];
      const state = statePair[0];
      const setState = statePair[1];
      // rootSessionId 属于请求边界：切换 surface 时先在渲染层隐藏旧树，避免旧会话内容
      // 在新会话首屏等待期间继续占据右栏。真实响应提交时也会再次校验该边界。
      // 切到另一个 root 时用的初始状态是**目标 root** 的状态（有缓存即直接显示它的树）：
      // 缓存按 root 隔离，因此绝不会把旧 root 的内容显示到新 root 上。
      // 只有这条回退分支需要再读一次缓存，且同样走纯读通道；同一 root 的普通重渲染
      // （通知、轮询、展开状态变化）完全不触碰缓存。
      const viewState = state.rootSessionId === rootSessionId ? state : initialStateFor(rootSessionId);
      const versionPair = typeof react.useState === "function" ? react.useState(0) : [0, () => {}];
      const version = versionPair[0];
      const bump = versionPair[1];
      /**
       * 面板标题栏 Auto 开关的本地乐观值（null = 跟随权威读面）。
       *
       * 开关的持久化要走一次 settings-commit 往返；没有本地覆盖时，用户点击后要等下一次
       * 轮询（最长 2.5 秒）才会看到勾选状态变化。这里先乐观翻转，写失败或权威值变化时
       * 立刻回退到读面值（绝不让开关停在错误状态）。
       */
      const autoOpenDraftPair = typeof react.useState === "function" ? react.useState(null) : [null, () => {}];
      const autoOpenDraft = autoOpenDraftPair[0];
      const setAutoOpenDraft = autoOpenDraftPair[1];
      const model = modelApi();
      // 展开状态只依赖 storage 与 root；缓存 store 可避免每次 RPC/通知重渲染都重复读取
      // sessionStorage 和解析同一份展开键。
      const createStore = () => typeof model.createExpansionStore === "function"
        ? model.createExpansionStore({ storage: config.storage, rootSessionId })
        : null;
      const store = typeof react.useMemo === "function"
        ? react.useMemo(createStore, [config.storage, rootSessionId])
        : createStore();
      const mountedRef = typeof react.useRef === "function" ? react.useRef(true) : { current: true };
      const requestSequenceRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
      const contextRef = typeof react.useRef === "function" ? react.useRef(ctx) : { current: ctx };
      contextRef.current = ctx;
      /**
       * 最近一次渲染算出的根会话 id（每次渲染同步写入，与 contextRef 同一模式）。
       *
       * 管理动作（取消/重试）在确认弹窗的 await 之后才发请求，而确认弹窗是宿主级模态：
       * 用户完全可能在它打开期间切换会话。那时 runAction 闭包里捕获的 rootSessionId 已经过期，
       * 用它发请求会把动作打到用户已经切走的旧会话上。这里保存当前选中值，确认完成后重读，
       * 保证动作始终绑定「请求发出这一刻」面板正在展示的根会话。
       */
      const currentRootRef = typeof react.useRef === "function" ? react.useRef(rootSessionId) : { current: rootSessionId };
      currentRootRef.current = rootSessionId;
      const currentSidebarSessionRef = typeof react.useRef === "function" ? react.useRef(sidebarSessionId) : { current: sidebarSessionId };
      currentSidebarSessionRef.current = sidebarSessionId;
      /**
       * surface 身份令牌：给每一条「跨 await 的异步动作」用的**不可复用**身份。
       *
       * 症状与根因：异步动作（自动打开/关闭、批量关闭、等待竞争租约）在 await 之后只用
       * mountedRef + currentRootRef + currentSidebarSessionRef 复核「当前 surface」。这三条判据
       * 比较的是**当前字符串值**，于是有一条真实交错会漏过去：同一个 Panel 实例快速
       * root/sidebar session A→B→A 之后，旧闭包捕获的字符串会与当前值**重新相等**——旧动作由此
       * 把自己的迟到收尾当成当前 surface 的收尾继续执行，删掉「A 里已经换成新 tabId 的 record /
       * Auto 来源」，并用旧快照推进同步。字符串判据挡得住「切走了没回来」，挡不住「切走又切回」。
       *
       * 因此每个 Panel 实例在挂载时生成一份唯一身份，并在 sidebarSessionId / rootSessionId 每一次
       * 变化时换成**新对象**（A→B→A 两次都换）：异步动作启动时捕获自己那一份，await 之后只回答
       * 「还是不是我出发时那一份」。令牌必须比较对象身份，绝不能只比较当前字符串值。
       *
       * 生成时机：首次渲染（挂载）与「root/sidebar session 与上一帧不同」的那一帧。同一组值下的
       * 普通重渲染（轮询、通知、展开状态变化）与 StrictMode 的双渲染都不会换令牌（hook 槽位不变），
       * 因此正在执行的异步动作不会被误判成 stale；组件重挂载则必然换（新实例 = 新 ref 槽位）。
       */
      const surfaceTokenScopeRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      const surfaceTokenRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      const surfaceTokenScope = surfaceTokenScopeRef.current;
      if (surfaceTokenScope === null
        || surfaceTokenScope.rootSessionId !== rootSessionId
        || surfaceTokenScope.sidebarSessionId !== sidebarSessionId) {
        surfaceTokenScopeRef.current = { rootSessionId, sidebarSessionId };
        surfaceTokenRef.current = { rootSessionId, sidebarSessionId };
      }
      /** 本帧闭包捕获的 surface 身份：所有异步动作在启动时捕获它，await 之后只与这一份比较。 */
      const surfaceToken = surfaceTokenRef.current;
      /**
       * 异步动作的 surface 闸门：mounted / root / sidebar session 三条既有判据**同时**成立，
       * 并且令牌仍然是出发时那一份，才允许继续。
       *
       * 两组判据缺一不可：字符串判据负责「切走了、没回来」与「别的 root 的同地址记录」，令牌负责
       * 「切走了又切回同一组值」（A→B→A）与「重挂载后的旧闭包」。await 之后、旧闭包调用
       * syncSidebarTabs() 之前、以及会改共享 Auto 账本 / 记录 / 手动抑制的迟到收尾分支，都必须先过
       * 这一道闸门。
       */
      const sidebarSurfaceStillCurrent = () => mountedRef.current === true
        && currentRootRef.current === rootSessionId
        && currentSidebarSessionRef.current === sidebarSessionId
        && surfaceTokenRef.current === surfaceToken;
      const refreshStateRef = typeof react.useRef === "function"
        ? react.useRef({ rootSessionId: null, inFlight: null, pending: false })
        : { current: { rootSessionId: null, inFlight: null, pending: false } };
      const refresh = () => {
        const refreshState = refreshStateRef.current;
        // 同一组件实例切换 root 时，立即放弃旧请求；旧 Promise 的 finally 通过对象身份检查，
        // 不会清理或触发新 root 的请求。
        if (refreshState.rootSessionId !== rootSessionId) {
          refreshState.inFlight?.controller?.abort?.();
          refreshState.inFlight = null;
          refreshState.pending = false;
          refreshState.rootSessionId = rootSessionId;
        }
        if (refreshState.inFlight !== null) {
          // 通知、轮询和手工重试在同一请求期间只合并成一次尾随刷新。
          refreshState.pending = true;
          return refreshState.inFlight.promise;
        }
        const requestSequence = ++requestSequenceRef.current;
        if (rootSessionId === "") {
          setState({ rootSessionId, snapshot: null, loading: false, error: null });
          return Promise.resolve();
        }
        const controller = typeof globalThis.AbortController === "function" ? new globalThis.AbortController() : null;
        const request = { rootSessionId, requestSequence, controller, promise: null };
        refreshState.inFlight = request;
        // 切换 root 时目标 root 的缓存快照必须在**事件路径**里预先读好（纯读，不重排 LRU）：
        // setState 的 updater 可能被 React 在渲染期调用、也可能在 StrictMode 下被调用两次，
        // updater 里读缓存（旧实现）就等于把缓存访投放回渲染阶段。
        const cachedBaseline = peekCachedSnapshot(rootSessionId);
        setState((previous) => {
          if (previous.rootSessionId === rootSessionId) {
            // 同一 root：保留当前快照（尾随刷新绝不清屏）。状态本身没有变化（没有待展示的错误、
            // loading 语义与当前快照一致）时返回原对象 —— React 直接 bail out，2.5s 轮询与
            // 会话通知的空转不再产生任何重渲染。
            const nextLoading = previous.snapshot === null;
            if (previous.error === null && previous.loading === nextLoading) return previous;
            return { rootSessionId, snapshot: previous.snapshot, loading: nextLoading, error: null };
          }
          // 切换 root：用目标 root 的缓存快照顶首屏，缓存未命中仍然是「snapshot=null + loading」
          // 的 skeleton 语义。缓存按 root 隔离，因此这里绝不会把旧 root 的内容显示到新 root 上。
          return { rootSessionId, snapshot: cachedBaseline, loading: cachedBaseline === null, error: null };
        });
        const promise = (async () => {
          try {
            const raw = await callRpc(
              config,
              contextRef.current,
              { action: "expert-group-snapshot", sessionId: rootSessionId },
              controller === null ? {} : { signal: controller.signal },
            );
            const next = safeNormalize(raw);
            if (next === null) throw new Error("快照格式无效");
            // 只有当前请求、当前 root 且页面仍挂载时才允许提交，防止旧 surface 的慢响应
            // 覆盖新会话，同时保证一次尾随刷新不会被旧请求的收尾逻辑吞掉。
            if (mountedRef.current === true
              && refreshState.inFlight === request
              && requestSequence === requestSequenceRef.current
              && rootSessionId === request.rootSessionId) {
              // 只有真正上屏的这份成功快照进缓存：被取消、过期或失败的响应都不写。
              // 写入同时完成 LRU 提权：正在被观察的 root 由它自己的成功拉取保持新鲜
              // （渲染期不再有任何重排，因此提权只能发生在这里）。
              writeCachedSnapshot(rootSessionId, next);
              setState((previous) => {
                // 内容级比较：Host 每次响应都是全新对象（generatedAt 还是新的 Date.now()），
                // 引用不同但上屏内容深度相等时不产生新状态 —— React 直接 bail out，
                // 大任务树空闲时每 2.5s 的全树重渲染就此消失。真实变化一定更新，绝不吞掉。
                if (previous.rootSessionId === rootSessionId
                  && previous.loading === false
                  && previous.error === null
                  && samePanelSnapshot(previous.snapshot, next)) return previous;
                return { rootSessionId, snapshot: next, loading: false, error: null };
              });
            }
          } catch (error) {
            const aborted = controller?.signal?.aborted === true || error?.name === "AbortError";
            if (!aborted
              && mountedRef.current === true
              && refreshState.inFlight === request
              && requestSequence === requestSequenceRef.current
              && rootSessionId === request.rootSessionId) {
              setState((previous) => {
                // 失败时保留当前 root 的最后有效快照（同实例的当前态，或该 root 的缓存快照），
                // 只在标题栏给出错误提示与重试入口；缓存未命中时仍是原来的空态语义。
                // 缓存读取同样在事件路径预先完成（cachedBaseline），updater 保持纯函数。
                const baseline = previous.rootSessionId === rootSessionId
                  ? previous.snapshot
                  : cachedBaseline;
                const message = error instanceof Error ? error.message : String(error);
                // 同一条错误、同一份快照的重复失败同样不产生新状态：失败横幅已经在上屏，
                // 每 2.5s 重排一次标题栏没有意义（错误文案变化时才更新）。
                if (previous.rootSessionId === rootSessionId
                  && previous.error === message
                  && previous.loading === false
                  && previous.snapshot === baseline) return previous;
                return { rootSessionId, snapshot: baseline, loading: false, error: message };
              });
            }
          }
          if (refreshState.inFlight !== request) return;
          refreshState.inFlight = null;
          if (refreshState.pending && mountedRef.current === true && refreshState.rootSessionId === rootSessionId) {
            refreshState.pending = false;
            void refresh();
          } else {
            refreshState.pending = false;
          }
        })();
        request.promise = promise;
        return promise;
      };
      /**
       * 最近一次渲染的 refresh（每次渲染同步写入）。
       *
       * refresh 是闭包：它只认自己那一轮渲染的 rootSessionId，并往对应 root 的状态边界写入。
       * runAction 的 await 可能跨越一次 root 切换，此时旧闭包的 refresh 会为**旧 root** 再发一次
       * 快照请求、并把旧 root 的状态写回新 surface。动作完成后的尾随刷新统一走这个引用，
       * 与当前渲染（也就是当前选中 root）保持一致。
       */
      const refreshRef = typeof react.useRef === "function" ? react.useRef(refresh) : { current: refresh };
      refreshRef.current = refresh;
      /**
       * 子代理侧栏打开状态：复合键（sessionId + rootSessionId + 资源地址）→
       * { sessionId, rootSessionId, tabId, title, misses, origin }。
       *
       * 用 ref 而不是 state 的理由与 pendingSet 相同：一次渲染里可能同时存在多个已打开的子代理
       * （每个 root、每个资源地址各一条记录），状态必须按「哪个 root 的哪个地址」隔离，绝不使用
       * 单一全局 boolean——那会让两个子代理互相顶掉，也无法区分不同会话。重渲染统一走 bump。
       * misses 是该 tab 连续被观测到缺失的次数（见 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS）。
       * origin 是该 tab 的来源（auto | manual，见 SIDEBAR_TAB_ORIGIN_*）：只有 auto 来源才允许
       * 被自动同步关闭，manual 来源（用户手动打开、外部已存在的 tab）一律不碰。
       */
      const sidebarTabRecordsRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
       /**
        * 已发起但尚未从 active() 得到落地证据的打开动作：
        * key → { sessionId, rootSessionId, resourceAddress, expiresAt, origin }。
        *
        * DSH 的 openResource 可能先提交导航意图，下一次渲染才出现 active tab；这段窗口不能让第二次
        * 点击再次 openResource，也不能提前伪造 <<。observer/轮询读到匹配 active() 后才转成正式记录。
        */
       const sidebarTabOpeningRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * Auto（自动打开运行中的子代理侧栏）的来源与抑制账本，键与打开记录完全同构
       * （sidebar session + rootSessionId + 资源地址），因此不同会话/root 的状态互不影响。
       *
       * - 来源：Auto 本次运行亲手发出过打开动作的资源。它同时是「不要重复打开」的记账：
       *   命中即跳过（哪怕这次打开始终没有落地证据，也绝不再发第二次 openResource）；
       *   只有这个集合里的 key 才允许被自动关闭。
       * - 抑制：用户手动关闭过的资源。Auto 不得立刻重开它；用户手动重新打开同一资源时清除
       *   （手动意图始终优先）。
       * 两个集合都按当前快照与上限清理（见 syncAutoSidebarTabs 的清理阶段）。
       */
      // 这几个集合指向 createExpertGroupPanel 闭包里的共享账本：重挂载后的新实例靠它认领旧实例开出的
      // tab（见 sharedSidebarAutoOrigin 的说明）。ref 只是持有者，读写结构逐字不变。
      const sidebarAutoOriginRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoOrigin) : { current: sharedSidebarAutoOrigin };
      const sidebarAutoSuppressedRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoSuppressed) : { current: sharedSidebarAutoSuppressed };
      /** 自动关闭的重试记账：key → 已尝试次数（成功或资源重新变成运行中时清空）；跨重挂载保留。 */
      const sidebarAutoCloseAttemptsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseAttempts) : { current: sharedSidebarAutoCloseAttempts };
      /**
       * 自动关闭重试预算的所有者账本：key → 本次预支预算的不可复用令牌；与重试计数同层共享。
       *
       * 只有「当前 owner 就是自己出发时那一份令牌」的动作才允许回滚这次预支（见 releaseAutoCloseAttempt），
       * 因此旧代次在副作用之前被撤销时绝不可能删掉/覆盖新代次已经预支的预算。
       */
      const sidebarAutoCloseAttemptOwnersRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseAttemptOwners) : { current: sharedSidebarAutoCloseAttemptOwners };
      /** 关闭请求的验证记录（跨重挂载保留：验证由后续任意一次同步按精确 inventory 完成）。 */
      const sidebarAutoCloseVerificationsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseVerifications) : { current: sharedSidebarAutoCloseVerifications };
      /** 自动关闭失败冷却账本（跨重挂载保留：remount 绝不能绕过失败上限）。 */
      const sidebarAutoCloseCooldownsRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoCloseCooldowns) : { current: sharedSidebarAutoCloseCooldowns };
      /**
       * Auto 候选采样到的「这个 tab 连续不在场」计数（跨重挂载保留，见 sharedSidebarAutoTabMisses）。
       *
       * 与来源 / 抑制 / 预算同层共享：一次重挂载绝不能把「已经确认缺失一次」重置成「还没采样过」，
       * 否则同一条确认语义会被 remount 反复打断（那正是「单次缺失即收口」的另一种写法）。
       */
      const sidebarAutoTabMissesRef = typeof react.useRef === "function" ? react.useRef(sharedSidebarAutoTabMisses) : { current: sharedSidebarAutoTabMisses };
      /**
       * 自动打开的**预留**（reservation）：key → { sessionId, rootSessionId, address, epoch }。
       *
       * 与来源标记严格分离：预留只在候选选择的那一刻写入，用来挡住同一资源的重复动作；只有
       * openResource 真的成功发出、且宿主有可追踪能力时才升级成「Auto 亲手打开」的来源。
       * split busy、准备失败、layout 失效、open 抛错、root/sidebar session 变化等失败路径一律
       * 撤销预留（见 handleSidebarAction 的 finally）：否则一次失败会被永久记成「已经开过」，
       * 该资源在本次运行里再也打不开。
       */
      const sidebarAutoReservationRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * 自动动作的级联标记与失败屏障。
       *
       * 撤销预留之后，「下一次同步」会立刻重新选中同一个资源，而自动动作收尾时又会立刻跑一次
       * 尾随同步。若宿主的失败是**持续**的（本会话的 split 事务仍在途 ⇒ busy；宿主持续拒绝分栏；
       * openResource 持续抛错），「失败 → 撤销预留 → 立刻重选」这条链路会在微任务里自转：它永远
       * 不让出宏任务，宿主的提交证据也就永远不会被观察到，页面与预算一起被拖住。
       *
       * 因此：同一次级联（自动动作收尾引发的那条同步链）里失败过的 key 不再入选；失败仍然可重试，
       * 但下一次尝试一定发生在**外部同步轮**（2.5 秒轮询 / observer / 可见性变化 / 会话通知）里，
       * 那里才能观察到形成失败条件的宿主状态是否已经改变。
       */
      const sidebarAutoCascadeRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
      const sidebarAutoFailedKeysRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * Auto 动作代次：Auto 开关的权威值每次变化（含关闭）时递增。
       *
       * 在途自动动作在自己那一轮渲染的闭包里捕获取代次，并在每个 await 之后、真正调用宿主
       * openResource()/close() 之前复核：代次不符说明用户已经关掉（或重新打开）Auto，那次自动
       * 动作一律放弃——绝不把「已经关掉的 Auto」变成一次迟到的用户可见打开。
       */
      const sidebarAutoEpochRef = typeof react.useRef === "function" ? react.useRef(0) : { current: 0 };
      /**
       * 用户手动意图记录：key → { sessionId, rootSessionId, address, intent }。
       *
       * 唯一目的：Auto 的动作正在同一个 key 上等待（split/layout/open）时，手动点击不能被 pending
       * 锁直接丢弃。意图只记录「用户要打开还是关闭」，由在途动作在副作用之前让位，或由同一条同步
       * 链路在它收尾后结算（见 applyPendingManualIntent）：手动关闭绝不被 Auto 随后重开，手动打开
       * 的最终 tab 一律记为 manual 来源。
       */
      const sidebarManualIntentRef = typeof react.useRef === "function" ? react.useRef(new Map()) : { current: new Map() };
      /**
       * Auto 动作串行闸门。
       *
       * 自动同步可能同时看到多个候选（多个运行中的子代理），但同一 tick 里连发多个
       * split()/openResource() 会互相抢 pane（第二个动作看到的 pane 证据仍是第一帧之前的）。
       * 因此一次只放行一个动作，动作收尾后由同一条同步链路推进下一个候选。
       */
      const sidebarAutoBusyRef = typeof react.useRef === "function" ? react.useRef(false) : { current: false };
      /** 最近一次同步观察到的 Auto 开关值；变化时 bump 一次（空闲轮询绝不重渲染）。 */
      const sidebarAutoSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /**
       * 当前首次 split 的用户意图；它跨越 split → openResource → openTabs/DOM 提交窗口，
       * 只能在目标 tab 已经落到返回的 pane 后才交给 install 侧结算。
       */
      const sidebarSplitIntentRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /** 侧栏箭头动作的同 key 在途集合（打开/关闭共用一把锁）：重复点击只允许一次动作穿过。 */
      const sidebarTabPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 批量关闭动作的聚合锁，按 (sidebar session, root) 组合键隔离（主代理行 / 空闲分组标题行共用同一把）。
       *
       * 一次点击会顺序 await 多个 close(tabId)：整段序列在途期间必须拒绝第二次点击，否则双击会
       * 让同一个 tabId 被关闭两次（第二次必然抛错），也会让两次序列交错发出关闭请求。
       *
       * 锁键必须含 root + sidebar session，而不是一个组件级 boolean：宿主 close 返回的 Promise
       * 可能长时间不 settle，而用户完全可以在它挂起期间切换 root。单一 boolean 会让旧 root 的
       * 在途序列把**新 root** 的批量按钮一并置成 disabled —— 一次与它无关的切换被旧锁阻塞，
       * 且旧序列一旦永不 settle 就永久阻塞。集合里只保留仍在途的 scope，结算时精确删除自己那一项。
       */
      const sidebarBatchPendingRef = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 批量关闭锁的复合键：当前 sidebar session + 当前 root。
       *
       * 两者缺一不可：同一个 root 的 root/child surface 各有自己的右栏，不同 root 更是完全独立的
       * surface；只有完全相同的两者才共享同一把锁（同一 scope 内 running/idle 两个批量入口互斥）。
       */
      const sidebarBatchScopeKey = (sessionId, rootId) => String(sessionId) + SIDEBAR_TAB_KEY_SEPARATOR + String(rootId);
      /**
       * 最近一次同步算出的「批量候选 tabId 签名」。
       *
       * 主代理行与空闲分组标题行的批量控件/零圆点由渲染期现读的 openTabs inventory 决定，
       * 因此 inventory 变化必须触发一次重渲染——但 2.5 秒轮询在没有变化时绝不能再 bump，
       * 否则空闲时会变成定时重渲染。这里只在签名真的变化时 bump（见 syncSidebarTabs）。
       */
      const sidebarBatchSignatureRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      /**
       * 最近一次渲染的右栏 tab 同步器（每次渲染同步写入，写法与 refreshRef 一致）。
       *
       * 挂载 effect 只在 sessionId/rootSessionId 变化时重建，而 observer / 轮询 / 可见性回调必须在
       * 「最近一次渲染」的闭包里执行——那里的 rootSessionId 与 sidebarRight 才是当前的。
       * 因此回调只读这个引用，绝不长期持有某一轮渲染的旧闭包。
       */
      const sidebarTabSyncRef = typeof react.useRef === "function" ? react.useRef(null) : { current: null };
      if (typeof react.useEffect === "function") {
        react.useEffect(() => {
          mountedRef.current = true;
          const refreshState = refreshStateRef.current;
          refreshState.rootSessionId = rootSessionId;
          refreshState.pending = false;
          void refresh();
          /**
           * sessions 通知：快照本身是**渲染输入**（第三行的权威 title、mode、activity 与目录项
           * 都来自 sessions 快照，且是在渲染期现读的），因此这条通知必须显式 bump 一次版本号
           * 触发一次重新渲染，不能只依赖 refresh 的状态写入。
           *
           * 原因：轮询空转时 refresh 会因「内容深度相等」直接 bail out（不再产生新状态），
           * 若这里不 bump，sessions 驱动的第三行更新就会跟着一起停掉。bump 与轮询无关：
           * 它只在宿主真的发布了新 sessions 快照时才发生，是事件驱动的必要重渲染。
           */
          const unsubscribe = subscribeSessions(config, contextRef.current, () => {
            bump((value) => value + 1);
            void refresh();
          });
          const poll = () => {
            // 右栏 tab 的外部关闭同步先跑：它不依赖页面可见性（隐藏标签页里用户也可能在别处关掉
            // 这个 tab），且没有任何打开记录时立刻返回，不触碰 DOM。
            sidebarTabSyncRef.current?.();
            try {
              if (globalThis.document?.hidden === true) return;
            } catch { /* 某些宿主 document 代理读取 hidden 会抛错，按可见处理。 */ }
            void refresh();
          };
          const timer = typeof globalThis.setInterval === "function" ? globalThis.setInterval(poll, 2500) : null;
          const documentRef = globalThis.document;
          const onVisibilityChange = () => {
            try {
              if (documentRef?.hidden !== true) {
                void refresh();
                // 回到前台时补一次同步：后台期间 MutationObserver 可能被浏览器节流。
                sidebarTabSyncRef.current?.();
              }
            } catch { /* 可见性通知只是加速恢复，读取失败不影响轮询。 */ }
          };
          try { documentRef?.addEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
          // 挂载（或切换 root 后重挂载）时立刻对齐一次：记录可能来自同一个 root 的上一个实例。
          sidebarTabSyncRef.current?.();
          /**
           * 外部关闭观察器：站在宿主已公开的 DOM 标记上观察，插件绝不改写宿主 DOM。
           *
           * 观察面固定为 document.body 子树而不是面板节点：右栏面板会迟到挂载（展开后才出现）、
           * 也会被宿主按 surface 整体重挂载，盯住具体节点会在重挂载后失联；而回调本身在没有任何
           * 打开记录时立即返回，空闲时（绝大多数时间）连一次 DOM 查询都不会发生。
           * 没有 MutationObserver / 没有 document.body / observe 抛错时静默降级为「只靠既有
           * 2.5 秒轮询与 visibilitychange 兜底」，绝不因为观察器缺失影响面板渲染。
           */
                     let unsubscribeOpenTabs = null;
           try {
             const inventory = sidebarRight?.openTabs ?? null;
             const subscribe = methodOf(inventory, "subscribe");
             if (subscribe !== null) {
               const cleanup = subscribe.call(inventory, () => { sidebarTabSyncRef.current?.(); });
               if (typeof cleanup === "function") unsubscribeOpenTabs = cleanup;
             }
           } catch { /* 旧宿主没有公开 inventory 或订阅失败时继续靠 observer/轮询。 */ }
           let tabObserver = null;
          try {
            const doc = globalThis.document;
            const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
            const target = doc?.body ?? null;
            if (typeof Observer === "function" && target !== null && target !== undefined) {
              tabObserver = new Observer(() => { sidebarTabSyncRef.current?.(); });
              tabObserver.observe(target, { childList: true, subtree: true });
            }
          } catch {
            try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
            tabObserver = null;
          }
          return () => {
            mountedRef.current = false;
            // 面板卸载 = 这一页不再由插件渲染：立刻把手柄交还宿主（无条件解锁，方向永远安全，
            // 重新挂载后的第一次同步会按宿主证据锁回去）。
            try { releaseRightbarDragLock?.(); } catch { /* 同上。 */ }
            const splitIntent = sidebarSplitIntentRef.current;
            sidebarSplitIntentRef.current = null;
            if (splitIntent !== null && cancelSidebarSplit !== null) {
              try { cancelSidebarSplit.call(config, splitIntent.token, { reason: "unmount" }); } catch { /* 事务收口失败不能阻断卸载。 */ }
            }
            requestSequenceRef.current += 1;
            refreshState.pending = false;
            refreshState.inFlight?.controller?.abort?.();
            refreshState.inFlight = null;
            if (typeof unsubscribe === "function") unsubscribe();
             if (typeof unsubscribeOpenTabs === "function") unsubscribeOpenTabs();
            if (timer !== null && typeof globalThis.clearInterval === "function") globalThis.clearInterval(timer);
            try { documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange); } catch { /* 可选 API。 */ }
            // 观察器必须与本次挂载同生共死：留一个仍在观察 body 的 observer 就是长期泄漏。
            try { tabObserver?.disconnect?.(); } catch { /* 可选 API。 */ }
          };
        }, [rootSessionId, sidebarSessionId]);
      }
      const navigation = getOpenSession(config, contextRef.current);
      /**
       * 导航与侧栏动作依赖的可选服务（每个渲染帧解析一次，成本是可忽略的属性读取）。
       *
       * 候选顺序与 getOpenSession 一致：显式注入的 deps → tab 的 props.ctx → install ctx。
       * 三者都拿不到时保持 null：主视图导航退回旧接口，标题后箭头不渲染（绝不出现点了没反应的按钮）。
       */
      const serviceCandidates = [config, ctx, config.ctx];
      const sessionsService = resolveClientService(serviceCandidates, "sessions");
      const sidebarRight = resolveClientService(serviceCandidates, "sidebarRight");
      /**
       * install 侧注入的「右栏拖拽手柄锁」重估入口：真正的状态与 DOM 写入都在 install 闭包里
       * （只有它知道当前可见会话与宿主提交的活跃 tab），面板只负责在自己已有的观察/轮询
       * 生命周期上顺带请求一次。直接使用 createExpertGroupPanel 的宿主或测试没有这个入口，
       * 此时保持 no-op：面板渲染与交互逐字节不变。
       */
      const requestRightbarDragSync = typeof config.syncRightbarDragLock === "function" ? config.syncRightbarDragLock : null;
      /** 面板卸载时的无条件解锁入口（语义见 install 侧 releaseRightbarDragLock 的说明）。 */
      const releaseRightbarDragLock = typeof config.releaseRightbarDragLock === "function" ? config.releaseRightbarDragLock : null;
      /**
       * 首次 split 的宽度事务只由 install 侧协调：面板报告用户意图、split 回执和资源提交，
       * 自己不直接写 layout。没有 install 注入时保持旧宿主的 no-op 兼容路径。
       */
      const beginSidebarSplit = typeof config.beginSidebarSplit === "function" ? config.beginSidebarSplit : null;
      const markSidebarSplitPane = typeof config.markSidebarSplitPane === "function" ? config.markSidebarSplitPane : null;
      const markSidebarSplitOpen = typeof config.markSidebarSplitOpen === "function" ? config.markSidebarSplitOpen : null;
      const commitSidebarSplit = typeof config.commitSidebarSplit === "function" ? config.commitSidebarSplit : null;
      const cancelSidebarSplit = typeof config.cancelSidebarSplit === "function" ? config.cancelSidebarSplit : null;
      const openSidebarResource = methodOf(sidebarRight, "openResource");
      /**
       * Auto（自动打开运行中的子代理侧栏）的实时读面：install 注入的 getter，每次同步现读。
       *
       * 直接 createExpertGroupPanel（旧宿主/单测）没有该依赖时按**关闭**处理：默认行为必须
       * 与历史逐字节一致（不做任何自动 open/close）。读取抛错同样按关闭处理——自动行为只是
       * 体验增强，绝不能影响面板渲染或既有的手动箭头。
       */
      const readAutoOpenSetting = typeof config.getAutoOpenSubagentSidebar === "function"
        ? config.getAutoOpenSubagentSidebar
        : null;
      /** 面板标题栏 Auto 开关的写面；缺失时开关只读（渲染 disabled），绝不假装能改。 */
      const writeAutoOpenSetting = typeof config.setAutoOpenSubagentSidebar === "function"
        ? config.setAutoOpenSubagentSidebar
        : null;
      const autoOpenEnabled = () => {
        if (readAutoOpenSetting === null) return false;
        try { return readAutoOpenSetting() === true; } catch { return false; }
      };
      /**
       * 标题栏 Auto 开关的点击处理：先本地乐观翻转，再把显式布尔交给写面持久化。
       *
       * 写面缺失或返回非 true（只读文档、宿主校验/并发失败）时立刻清掉本地值，开关回退到权威读面；
       * 成功时本地值与读面一致，下一次同步观察到权威值变化会再清一次（幂等，绝不闪回）。
       */
      const toggleAutoOpen = (next) => {
        const value = next === true;
        if (writeAutoOpenSetting === null) return;
        setAutoOpenDraft(value);
        void Promise.resolve()
          .then(() => writeAutoOpenSetting(value))
          .then(
            (accepted) => { if (accepted !== true) setAutoOpenDraft(null); },
            () => { setAutoOpenDraft(null); },
          );
      };
      // 新版宿主提供公开 split()，返回新 pane 的 PaneId；只有拿到这个回执后才打开资源，
      // 避免 preferNewPane 失败时静默回落到 Expert Group 所在 pane。旧宿主没有 split() 时
      // 保留 preferNewPane 兼容路径，但绝不调用 float()，不制造用户可见浮窗。
      const splitSidebarPane = methodOf(sidebarRight, "split");
      // 可关闭 toggle 的两个方法能力：close() 负责关闭，active()/openTabs 提供「打开后真的落地了」的证据。
      // 两类确认能力都可能缺失（旧宿主），此时箭头退回静态 >> 打开行为，绝不猜 tabId。
      const closeSidebarResource = methodOf(sidebarRight, "close");
      // 宽度不足时 openResource 会按宿主契约回落到当前 pane；插件不调用 float，
      // 避免把用户的右栏页面变成独立悬浮窗口。右栏宽度策略在 install 侧统一处理。
      const readActiveSidebarResource = methodOf(sidebarRight, "active");
       /**
        * 读取公开 openTabs inventory：它按 Session 给出已提交 tab 的 tabId/kind/contentId，
        * 不依赖 active pane，因此宿主将焦点留在其它 pane/tab 时仍能确认目标子代理。
        * 旧宿主没有该 inventory 或读取失败时返回 null，调用方继续使用 active() 兼容路径。
        */
       const readSidebarOpenTabs = () => {
         let inventory = null;
         try { inventory = sidebarRight?.openTabs ?? null; } catch { return null; }
         const getSnapshot = methodOf(inventory, "getSnapshot");
         if (getSnapshot === null) return null;
         try {
           const snapshot = getSnapshot.call(inventory);
           return Array.isArray(snapshot) ? snapshot : null;
         } catch { return null; }
       };
       /**
        * split() 会按宿主 seed 规则先放入一个 guide tab。公开 openTabs 不带 paneId，
        * 只有同一 session 的 split 前后 tabId 差分中恰好一个新增 kind=guide，才足以唯一识别这次
        * 新建 pane 的种子；inventory 延迟、跨 session、并发新增多个 guide 或记录损坏时都 fail-closed，
        * 避免把其它并发提交的 tab 错当成 replaceTab。
        */
       const seededGuideTabId = (beforeTabs, sessionId) => {
         const expectedSessionId = text(sessionId, null);
         if (expectedSessionId === null || !Array.isArray(beforeTabs)) return null;
         const beforeIds = new Set();
         for (const tab of beforeTabs) {
           try {
             const candidate = object(tab);
             if (text(candidate.sessionId, null) !== expectedSessionId) continue;
             const tabId = text(candidate.tabId, null);
             if (tabId !== null) beforeIds.add(tabId);
           } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
         }
         const afterTabs = readSidebarOpenTabs();
         if (!Array.isArray(afterTabs)) return null;
         const newGuideTabIds = [];
         for (const tab of afterTabs) {
           try {
             const candidate = object(tab);
             if (text(candidate.sessionId, null) !== expectedSessionId
               || text(candidate.kind, null) !== "guide") continue;
             const tabId = text(candidate.tabId, null);
             if (tabId !== null && !beforeIds.has(tabId)) newGuideTabIds.push(tabId);
           } catch { /* 损坏的 inventory 记录不影响其它 tab。 */ }
         }
         return newGuideTabIds.length === 1 ? newGuideTabIds[0] : null;
       };
             const sidebarOpenTabsAvailable = readSidebarOpenTabs() !== null;
                     const snapshot = viewState.snapshot;
      /**
       * 轻量（partial）快照标记：Host 首屏返回 partial:true 表示它跳过了全部冷读，
       * 状态与任务名可能不完整。渲染层据此把「没有任何活动证据」的圆点与活动文案保持中性；
       * 完整快照（partial:false/缺失）与旧宿主一律走既有渲染路径，逐字不变。
       */
      const partialSnapshot = snapshot?.partial === true;
      /**
       * 容器（空闲分组）在轻量快照下使用的中性运行状态：取值与模型导出的
       * UNKNOWN_RUNTIME_STATUS 同源，模型缺失时按同名字面量兜底，避免两处各存一份词表。
       */
      const neutralRuntimeStatus = typeof model.UNKNOWN_RUNTIME_STATUS === "string" && model.UNKNOWN_RUNTIME_STATUS.length > 0
        ? model.UNKNOWN_RUNTIME_STATUS
        : "unknown";
       const sidebarSnapshotSyncRef = typeof react.useRef === "function"
         ? react.useRef({ rootSessionId, sidebarSessionId, snapshot })
         : { current: { rootSessionId, sidebarSessionId, snapshot } };
       if (typeof react.useEffect === "function") {
         react.useEffect(() => {
           const previous = sidebarSnapshotSyncRef.current;
           sidebarSnapshotSyncRef.current = { rootSessionId, sidebarSessionId, snapshot };
           if (previous.rootSessionId === rootSessionId
             && previous.sidebarSessionId === sidebarSessionId
             && previous.snapshot !== snapshot) sidebarTabSyncRef.current?.();
         }, [rootSessionId, sidebarSessionId, snapshot]);
       }
      const retry = () => { void refresh(); };
      const expand = (node) => store ? store.isExpanded(node) : (node?.kind === "root" || (typeof model.defaultExpanded === "function" && model.defaultExpanded(node)));
      const toggle = (node) => {
        if (store) store.toggle(node);
        bump((value) => value + 1);
      };
      /**
       * 打开会话的主视图导航（唯一入口：工作区服务的 `uiWorkspace.openSession`）。
       *
       * 已知子代理优先传 SubagentAddress（宿主据此恢复直系父与续跑能力，与 DSH 原生子代理行的
       * openChild 语义一致），地址缺失时传裸 session id。工作区入口不存在时这里不会被调用：
       * 渲染层在 `navigation.available !== true` 时不生成任何可点击的导航入口，绝不显示
       * 点了没反应的按钮。
       */
      const handleOpen = (id, address) => {
        if (navigation.available !== true) return;
        if (typeof id !== "string" || id.length === 0) return;
        navigation.open(address === null || address === undefined || navigation.acceptsAddress !== true ? id : address);
      };

      /**
       * 子代理地址解析（渲染层唯一的地址来源，主视图导航与侧栏箭头共用）。
       *
       * 1. `sessions.subagentAddress(childId)`：DSH 维护的「直系父会话 + 模式」权威地址，
       *    存在即优先使用；
       * 2. 会话投影目录项的合法 mode：目录已 hydration 时沿用 DSH 目录证据（含新增的
       *    `unknown`）。`unknown` 是合法地址值，但**不可续接**：它绝不被降级成
       *    continuable，宿主据此按只读呈现；
       * 3. 目录尚未 hydration 时，DEG Host 快照节点的 `continuable: true` 是本插件自身的
       *    明确证据，可与树遍历提供的 parentId 组成 continuable 地址。`false` 不映射为
       *    one-shot，避免把缺失/未知模式误当成合法地址；目录已有显式 mode（含 unknown）时
       *    保持该权威值，不被节点回退覆盖。
       * 4. 都拿不到时返回 null：主视图仍传裸 id，但绝不构造侧栏地址（避免打不开的地址）。
       */
      const subagentAddressOfChild = (childId, parentId, node) => {
        const id = text(childId, null);
        if (id === null) return null;
        const lookup = methodOf(sessionsService, "subagentAddress");
        if (lookup !== null) {
          let addressed;
          try { addressed = lookup.call(sessionsService, id); } catch { addressed = null; }
          const normalized = normalizeSubagentAddress(addressed);
          if (normalized !== null) return normalized;
          // undefined/null 表示地址尚未被 DSH 发现，允许继续走 Host 快照兜底；
          // 宿主若已经返回了非空但非法对象，则保守拒绝，不能用较弱证据覆盖坏地址。
          if (addressed !== undefined && addressed !== null) return null;
        }
        const parent = text(parentId, null);
        const entry = catalogEntryOf(parent, id);
        const entrySource = object(entry);
        const entryHasMode = Object.prototype.hasOwnProperty.call(entrySource, "mode");
        const entryMode = text(entrySource.mode, null);
        // DSH 目录懒加载时 entry 可能暂时不存在，或投影项尚未带 mode 字段；DEG 的 Host
        // 快照已明确证明其 child 是 continuable，此证据足以构造同一规范地址。只对 true 回退，
        // false 仍表示未知；若目录显式带了 mode（含 unknown 或非法值），则保留目录权威值，
        // 绝不用较弱证据把它说成可续接。
        const mode = entryHasMode
          ? entryMode
          : (object(node).continuable === true ? "continuable" : null);
        return normalizeSubagentAddress({
          parentSessionId: parent,
          childSessionId: id,
          mode,
        });
      };

      /**
       * 标题后「在右侧栏打开」箭头按钮：与 DSH 原生子代理行同款（IconChevronRightOutlineRegular）。
       *
       * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名箭头图标可用。
       * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
       *
       * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
       * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
       * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
       * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
       * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
       * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
       * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
       * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
       * 必须同时存在：鼠标事件不得冒泡到任务名/第三行的导航处理器，键盘 Enter/Space 在按钮上的
       * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
       * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
       */
      /**
       * 当前 active tab 的 id（读面缺失、读取或调用抛错、没有 tab 时一律返回 null）。
       *
       * 只用于「正向存在证据」：active() 返回的目标 tabId 说明宿主的存储里这个 tab 还在。
       * 反过来不成立——active() 返回别的 tab 只说明用户切到了别的 tab/pane，绝不能当作
       * 「目标 tab 没了」的证据去复位或关闭。
       */
      const activeSidebarTabId = () => {
        if (readActiveSidebarResource === null) return null;
        try { return text(object(readActiveSidebarResource.call(sidebarRight)).id, null); } catch { return null; }
      };

      /**
       * 当前右栏面板里所有 tab 的 id 集合。
       *
       * 读不到「当前右栏面板」（折叠、surface 切换中、宿主还没挂载）、没有 DOM 查询能力、
       * 或查询抛错时统一返回 null——调用方据此保持现有状态。空 Set 表示「面板在、但确实没有
       * 任何 tab」，那是真实的缺失证据，不是「读不到」。
       */
      const presentSidebarTabIds = () => {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        // 只读当前 session 自己的面板：零个匹配（还没挂载 / 不属于这一页）或归属不明确时返回 null，
        // 调用方保持现状；绝不退回 DOM 第一个面板——别的会话残留的面板会把它的 tab 当成
        // 本会话的缺失证据，从而误判「用户收回了 tab」。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined) return null;
        if (typeof panel.querySelectorAll !== "function") return null;
        let nodes = null;
        try { nodes = panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR); } catch { return null; }
        if (nodes === null || nodes === undefined) return null;
        let entries = [];
        try { entries = Array.from(nodes); } catch { return null; }
        const ids = new Set();
        for (const node of entries) {
          let raw = null;
          try { raw = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { raw = null; }
          const id = text(raw, null);
          if (id !== null) ids.add(id);
        }
        return ids;
      };

      /**
       * 找到包含指定 tab 的 DockKit pane。
       *
       * openTabs 公开读面只给 tabId/kind/contentId，不提供 paneId；而 openResource 在没有 paneId
       * 且无法再 split 时会回落到 active pane。这里仅读取宿主已经渲染的
       * data-dockkit-pane / data-dockkit-tab 标记，不改 DOM，也不调用宿主内部 split。
       */
      const paneIdsContainingTabs = (panel, tabIds, extraMatcher = null) => {
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
        let nodes;
        try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return new Set(); }
        const paneIds = new Set();
        for (const node of nodes) {
          let rawTabId = null;
          try { rawTabId = typeof node?.getAttribute === "function" ? node.getAttribute("data-dockkit-tab") : null; } catch { rawTabId = null; }
          const tabId = text(rawTabId, null);
          const matched = tabIds.has(tabId) || (typeof extraMatcher === "function" && extraMatcher(tabId));
          if (!matched) continue;
          const visited = new Set();
          let parent = null;
          try { parent = node?.parentElement ?? node?.parentNode ?? null; } catch { parent = null; }
          while (parent !== null && parent !== undefined && !visited.has(parent)) {
            visited.add(parent);
            let rawPaneId = null;
            try {
              rawPaneId = typeof parent.getAttribute === "function"
                ? parent.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
                : null;
            } catch { rawPaneId = null; }
            const paneId = text(rawPaneId, null);
            if (paneId !== null) {
              paneIds.add(paneId);
              break;
            }
            try { parent = parent.parentElement ?? parent.parentNode ?? null; } catch { parent = null; }
          }
        }
        return paneIds;
      };

      /**
       * 读取某个真实 tab 所在的 DockKit pane。只接受 DOM 明确给出的 paneId；
       * openTabs 没有 paneId 时，inventory 本身不能证明资源没有回落到 Expert Group pane。
       */
      const paneIdContainingTab = (tabId) => {
        const doc = globalThis.document;
        if (doc === null || doc === undefined || typeof doc.querySelector !== "function") return null;
        // 与 existingSubagentPaneId 同源：只认当前 session 面板里的 data-dockkit-pane 标记。
        // 面板解析不出来（读面缺失或归属不明确）时返回 null，split 提交证据继续 fail-closed，
        // 绝不把别的 session 的 paneId 当成「目标资源已经落到本次 split 的 pane」的证据。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined) return null;
        const paneIds = paneIdsContainingTabs(panel, new Set([tabId]));
        return paneIds.size === 1 ? [...paneIds][0] : null;
      };

      /**
       * 目标资源的精确提交证据：同一 surface、subagentchat kind、同一 contentId，
       * 并且 DOM 把该 tab 放在本次 split 返回的 pane 中。guide、active-only 或错误 pane
       * 都会继续等待，不会把临时 50% 状态提交成 other 模式。
       */
      const sidebarSplitTargetEvidence = (resourceAddress, expectedPaneId = null) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return null;
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.contentId, null) !== resourceAddress) continue;
            const tabId = text(candidate.tabId, null);
            if (tabId === null) continue;
            const paneId = paneIdContainingTab(tabId);
            if (paneId === null) continue;
            // 同地址可以短暂存在多个 tab：首条记录可能还在旧 pane，必须继续搜索，
            // 直到找到真正落在本次 split 返回 pane 的候选，避免错误 pane 永久遮蔽正确证据。
            if (expectedPaneId !== null && paneId !== expectedPaneId) continue;
            return { tabId, paneId };
          } catch {
            // 单条 inventory 损坏时继续检查其余记录。
          }
        }
        return null;
      };

      /**
       * 读取当前 DOM 中 Expert Group 所在的 pane 集合。
       *
       * 这个集合只由公开的 tab/pane 标记构成：inventory 用来把 kind 映射成真实 tabId，
       * DOM 用来确认 tab 的实际 pane。没有证据时返回空集合，调用方必须保持 fail-closed。
       */
      const expertGroupPaneIds = (panel) => {
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return new Set();
        // tabId 集合来自共享读面 helper（与分栏配比那条路径同源，避免两处判定漂移）。
        return paneIdsContainingTabs(
          panel,
          expertGroupTabIdsOf(readSidebarOpenTabs(), sidebarSessionId),
          isGeneratedExpertGroupTabId,
        );
      };

      /**
       * 解析已有的子代理目标 pane。
       *
       * 首次打开时只有 Expert Group pane，返回 null 让打开流程通过公开 split() 创建子代理 pane；
       * 已经存在多个 pane 时，选最右侧且不包含 Expert Group 的 pane，并显式传给 openResource。
       * 这样后续所有 >> 都复用同一个右侧 pane，不会因为 active pane 恰好在左侧而回落到左侧。
       * DOM 读面缺失、pane/tab 结构不完整或查询抛错时统一返回 null，保留旧宿主兼容语义。
       */
      const existingSubagentPaneId = () => {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return null;
        // 归属边界：pane 只能从**当前 session 自己的面板**里复用。同一次 install 里 DOM 可能同时
        // 残留多个 session 的面板（React 重挂载窗口），querySelector 的首个命中无法证明归属；
        // 解析不出来时保持 null，让打开流程决定是先 split 还是走旧宿主兼容分支——绝不把别的
        // session 的 paneId 传给 openResource（那会让资源落到别人的右栏布局上）。
        const panel = rightbarPanelForSessionCompat(doc, sidebarSessionId);
        if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
        const expertPaneIds = expertGroupPaneIds(panel);
        // 没有任何证据证明哪个 pane 是 Expert Group 时，不能把最右 pane 猜成安全目标；
        // 保持 null，让打开流程决定是调用公开 split() 还是走旧宿主兼容分支。
        if (expertPaneIds.size === 0) return null;
        // 候选 pane 与它们的 DOM 顺序/列号：这里刻意只用 pane 标识与列号判定（pane 读面本身
        // 读不到时才 fail-closed），绝不复用分栏配比那条更严的 pane 组成读面——否则一个读不到
        // tabId 的 pane 就会让「复用已有子代理 pane」退化成再 split 一个新 pane。
        const panes = paneNodesOf(panel);
        if (panes === null) return null;
        const candidates = [];
        for (let index = 0; index < panes.length; index += 1) {
          const pane = panes[index];
          let rawPaneId = null;
          try {
            rawPaneId = typeof pane?.getAttribute === "function"
              ? pane.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
              : null;
          } catch { rawPaneId = null; }
          const paneId = text(rawPaneId, null);
          if (paneId === null || expertPaneIds.has(paneId)) continue;
          let rawColumn = null;
          try {
            rawColumn = typeof pane?.getAttribute === "function"
              ? pane.getAttribute(RIGHTBAR_PANE_COLUMN_ATTRIBUTE)
              : null;
          } catch { rawColumn = null; }
          const columnText = text(rawColumn, null);
          const column = columnText === null ? null : Number(columnText);
          candidates.push({ paneId, column: Number.isFinite(column) ? column : null, index });
        }
        candidates.sort((left, right) => {
          if (left.column !== null && right.column !== null && left.column !== right.column) {
            return right.column - left.column;
          }
          if (left.column !== null && right.column === null) return -1;
          if (left.column === null && right.column !== null) return 1;
          return right.index - left.index;
        });
        return candidates[0]?.paneId ?? null;
      };

      /**
       * 右栏 tab 外部关闭同步与浮动存在性查询的判定边界（供下方 helper 与同步器使用）。
       *
       * 停靠 tab 节点或匹配的浮动 subagentchat 标题是存在性证据；active() 返回目标 tab 是
       * 额外的正向证据。判定与动作边界：
       * - 没有任何打开记录时立即返回，连 DOM 查询都不做（空闲路径零成本）；
       * - 没有 DOM 证据（无 document / 无面板 / 查询能力缺失 / 查询抛错）时保持现有状态，
       *   绝不在缺少证据时复位——折叠右栏、切换 surface、面板重挂载都会短暂读不到面板；
       * - 只检查当前 root 的记录：root 切换或卸载时，别的会话的记录原样保留（更不会去关闭它的 tab）；
       * - 目标 tab 连续 SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS 次被观测到缺失才删除记录并 bump，
       *   任何一次正向证据都会把计数清零（防止把宿主提交窗口的中间态误判成用户关闭）；
       * - 这里只改插件自己的记录，绝不调用 close()：外部关闭已经发生，再关一次是多余且危险的。
       */
      const presentFloatingSubagentTitles = () => {
         const doc = globalThis.document;
         if (!doc || typeof doc.querySelectorAll !== "function") return null;
         let floats = null;
         try { floats = Array.from(doc.querySelectorAll(RIGHTBAR_FLOAT_SELECTOR)); } catch { return null; }
         const titles = new Set();
         for (const float of floats) {
           if (typeof float?.querySelector !== "function") return null;
           let chat = null;
           let titleNode = null;
           try {
             chat = float.querySelector("[data-sidebar-chat]");
             titleNode = float.querySelector(RIGHTBAR_FLOAT_TITLE_SELECTOR);
           } catch { return null; }
           if (chat === null || titleNode === null) continue;
           const title = text(titleNode.textContent, null);
           if (title !== null) titles.add(title);
         }
         return titles;
       };

       /**
        * 外部关闭同步（低成本、幂等、绝不抛错）。
        *
        * 停靠 tab 通过宿主渲染的 tabId 标记观察，浮动 tab 通过 subagentchat body 与打开时标题做
        * 保守正向匹配；active() 返回目标 tab 也是正向证据。面板、浮动查询或任何 DOM 能力缺失时
        * 保持现有状态，绝不把焦点切换或 surface 过渡猜成关闭。
        */
              const knownSidebarResourceAddresses = () => {
         const addresses = new Set();
         const add = (node, parentId) => {
           const source = object(node);
           if (source.kind === "fanout") {
             const shards = Array.isArray(source.shards) ? source.shards : [];
             for (const shard of shards) {
               const shardSource = object(shard);
               const childId = text(shardSource.childId, null);
               if (childId === null) continue;
               const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, {
                 ...shardSource,
                 kind: "expert",
               }));
               if (address !== null) addresses.add(address);
             }
           } else {
             const childId = text(source.sessionId, text(source.childId, null));
             if (childId !== null) {
               const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, source));
               if (address !== null) addresses.add(address);
             }
           }
           if (Array.isArray(source.children)) {
             for (const child of source.children) add(child, parentId);
           }
         };
         const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
         for (const child of children) add(child, rootSessionId);
         return addresses;
       };
      /**
       * 当前 root 专家树里的「运行中」资源地址（普通专家、嵌套专家与最新 fan-out 分片）。
       *
       * 与 renderThreeLines 使用**同一个**规范地址 helper（subagentAddressOfChild + subagentChatAddress），
       * 因此批量候选与单会话箭头指向的是同一个 contentId，绝不存在第二套地址推导。
       *
       * 纳入条件只有一条：runtimeStatusOfNode(...) === "running"（与行内圆点、第三行摘要同源）。
       * ready/unknown 一律不纳入——未知状态绝不混进「可以关闭」的集合，空闲专家由空闲分组单独负责。
       *
       * parent 证据缺失或非法时 fail-closed：subagentAddressOfChild 会返回 null，该节点直接跳过，
       * 绝不用猜测的 parent 补出一个地址（猜出来的地址可能关掉另一个会话的 tab）。
       */
      const sidebarExpertResourceAddresses = (node, parentId, addresses) => {
        const source = object(node);
        const kind = text(source.kind, null);
        if (kind === "fanout") {
          const shards = Array.isArray(source.shards) ? source.shards : [];
          for (const shard of shards) {
            const shardSource = object(shard);
            // 只认最新 attempt 的 childId：旧 attempt 的子会话不再由这一行代表，也不是可导航目标。
            const childId = text(shardSource.childId, null);
            if (childId === null) continue;
            if (runtimeStatusOfNode(shardSource, parentId, childId) !== "running") continue;
            const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, {
              ...shardSource,
              kind: "expert",
            }));
            if (address !== null) addresses.add(address);
          }
          return;
        }
        if (kind !== "expert") return;
        const childId = text(source.sessionId, text(source.childId, null));
        if (childId !== null && runtimeStatusOfNode(source, parentId, childId) === "running") {
          const address = subagentChatAddress(subagentAddressOfChild(childId, parentId, source));
          if (address !== null) addresses.add(address);
        }
        // 嵌套专家：parent 就是它的宿主专家会话；宿主缺失时内层地址推导 fail-closed。
        if (Array.isArray(source.children)) {
          for (const child of source.children) sidebarExpertResourceAddresses(child, childId, addresses);
        }
      };

      /** 当前快照的 root 直接子节点（快照缺失时为空数组）。 */
      const sidebarRootChildren = () => (Array.isArray(snapshot?.root?.children) ? snapshot.root.children : []);

      /**
       * 空闲证据规则（空闲分组与空闲批量关闭候选的**唯一**判定入口）。
       *
       * 只有 runtimeStatusOfNode(...) === "ready"（**有证据**表明当前未运行）才算空闲：
       * - 轻量快照（partial:true）下「没有任何活动证据」的节点被归一为中性值 unknown，
       *   它既不是 running 也不是 ready，因此既不得进入空闲分组、也不得成为空闲批量关闭候选——
       *   否则用户会依据轻量快照关掉实际仍在运行、只是首屏读不到状态的会话；
       * - 完整快照（partial:false）到达后不会再出现 unknown，规则自动回到既有行为，不留永久性差异；
       * - running 与 unknown 一样被排除，保守方向不变。
       *
       * partial 证据规则通过 options 一路传到模型的活动证据链，与行内圆点、第三行文案同源；
       * 这里只读当前渲染的 partialSnapshot，切换 root 或快照换代都会随闭包一起更新。
       */
      const sidebarNodeIsIdleReady = (node, parentId, childId) =>
        runtimeStatusOfNode(node, parentId, childId, { partial: partialSnapshot }) === "ready";

      /**
       * 空闲分组的**成员**判定（显示从宽）。
       *
       * 在严格判据之外，额外接受轻量快照下「没有任何活动证据」的 unknown 节点：它们与 ready
       * 一样被收纳进分组，只是圆点与文案保持中性（见 renderExpert / renderIdleGroup）。
       * 这样同一份数据在 partial:true 与 partial:false 下分组**成员集合与顺序完全一致**，
       * 消除「同一节点在两条路径之间来回跳位」的用户可见缺陷。
       *
       * 只放宽**显示**：任何会真的操作宿主资源的路径（批量关闭候选、manual 抑制清理）都必须继续
       * 使用严格的 sidebarNodeIsIdleReady，不得改用本函数。
       */
      const sidebarNodeIsIdleMembership = (node, parentId, childId) => {
        const status = runtimeStatusOfNode(node, parentId, childId, { partial: partialSnapshot });
        if (status === "ready") return true;
        // unknown 只可能来自 partial 快照（完整快照的证据链不会返回它）：此时纳入分组显示。
        return partialSnapshot === true && status === neutralRuntimeStatus;
      };

      /**
       * 空闲分组收纳 ready 直接专家和已结算的 fan-out 父任务。
       * 父任务必须命中 manager 终态，不能仅凭子会话暂时未运行或未知状态提前移动（manager 的聚合
       * 状态本身就是真实证据，不是「没有证据」，因此不受 partial 影响）。
       *
       * 直接专家走 sidebarNodeIsIdleMembership：**显示从宽**——轻量快照下没有活动证据的专家
       * （unknown）也纳入分组，使它在 partial / full 下的组内相对位置完全一致。
       *
       * 为什么显示要放宽：排序键是 createdAt，而轻量快照没有冷读、拿不到专家会话的创建时间
       * （真实 child_models 记录里也没有该字段），因此同一批节点在 partial 与 full 下的排序结果
       * 本来就可能不同；若再让「是否进组」也随证据变化，同一次 partial↔full 切换会**同时**改变
       * 分组归属与组内下标，用户在空闲列表里看到的就是「某个 fan-out 分组每隔 2.5 秒来回跳」。
       * 让成员集合在两条路径下一致，位置变化就只剩「锚点补齐前的一次性收敛」，不再是反复跳动。
       *
       * 操作安全性不变：unknown 节点**仍然不参与**任何批量/清理动作——空闲批量关闭候选
       * （idleSidebarResourceAddresses）与 manual 抑制清理（clearManualSuppressionOfIdleResources）
       * 都继续用严格的 sidebarNodeIsIdleReady 判定，绝不放宽。
       */
      const sidebarIdleChildren = () => sidebarRootChildren()
        .filter((node) => {
          if (node.kind === "fanout") return FANOUT_SETTLED_STATUSES.has(statusOf(node));
          return node.kind === "expert"
            && sidebarNodeIsIdleMembership(node, rootSessionId, text(node.sessionId, null));
        });

      /**
       * 当前 root 专家树里「运行中」的资源地址集合（主代理行批量关闭的唯一候选来源）。
       * 与空闲分组互斥：这里只遍历 root.children 中的专家/fan-out 节点，空闲成员不参与。
       */
      const runningSidebarResourceAddresses = () => {
        const addresses = new Set();
        for (const child of sidebarRootChildren()) sidebarExpertResourceAddresses(child, rootSessionId, addresses);
        return addresses;
      };

      /**
       * 空闲分组的资源地址集合（空闲批量关闭的**唯一**候选来源）。
       *
       * 注意这里与分组**成员**判定是两条不同严格度的规则（修复 B 的「显示从宽、操作从严」）：
       * 分组成员用 sidebarNodeIsIdleMembership（unknown 也进组显示），而候选在这里用严格的
       * sidebarNodeIsIdleReady 再复核一次——轻量快照下没有活动证据（unknown）的节点虽然现在会
       * 出现在分组里，但绝不会成为可关闭的目标。两道关口的差异是**有意**的：
       * 位置稳定性优先，操作安全性不变（一次误关会毁掉用户正在运行的会话，代价远高于一次跳位）。
       * fan-out 父任务代表其最新 attempt 的分片会话，只收录当前未运行（ready）的会话地址。
       */
      const idleSidebarResourceAddresses = (nodes) => {
        const addresses = new Set();
        for (const node of Array.isArray(nodes) ? nodes : []) {
          const source = object(node);
          if (source.kind === "fanout") {
            for (const shard of Array.isArray(source.shards) ? source.shards : []) {
              const shardSource = object(shard);
              const shardChildId = text(shardSource.childId, null);
              // childId 缺失（Host 在轻量快照里清空了无法证明归属的 child）与 unknown 状态一样，
              // 都不能进候选：没有精确地址就没有可关闭的目标，没有证据就不能判定它已空闲。
              if (shardChildId === null || sidebarNodeIsIdleReady(shardSource, rootSessionId, shardChildId) !== true) continue;
              const shardAddress = subagentChatAddress(subagentAddressOfChild(shardChildId, rootSessionId, {
                ...shardSource,
                kind: "expert",
              }));
              if (shardAddress !== null) addresses.add(shardAddress);
            }
            continue;
          }
          const childId = text(source.sessionId, text(source.childId, null));
          if (childId === null) continue;
          // 防御式复核：实参与 idleChildren 的成员判定逐字相同，因此对既有成员的结果完全不变；
          // 即使调用方以后传进来一份非 idleChildren 的列表，unknown/running 也绝不会漏成候选。
          if (sidebarNodeIsIdleReady(source, rootSessionId, text(source.sessionId, null)) !== true) continue;
          const address = subagentChatAddress(subagentAddressOfChild(childId, rootSessionId, source));
          if (address !== null) addresses.add(address);
        }
        return addresses;
      };

      /**
       * 一次批量动作的候选集合：当前 openTabs inventory ∩ 给定的规范地址集合。
       *
       * 匹配条件缺一不可（全部来自公开只读 inventory 的字段）：
       * - candidate.sessionId === 当前 sidebar session：绝不操作别的 surface 的 tab；
       * - kind === "subagentchat"：同 session 下别的 kind 不是本插件的资源；
       * - tabId 与 contentId 都非空：缺任何一个都无法精确关闭，也就没有可关闭的候选；
       * - contentId 精确等于集合中的地址：同一个 kind 下也可能是另一个子代理的地址。
       *
       * 结果按 tabId 去重：宿主 inventory 理论上可能有重复记录，重复 tabId 只能关一次。
       *
       * 候选携带 { tabId, address } **两个字段**，而不是只带 tabId：候选集合是点击那一刻的渲染
       * 快照，而真正调用 close() 之前可能已经跨过若干次 await（前一个候选的 close、宿主的提交）。
       * 宿主可以把一个已经释放的 tabId 回收给**另一个资源**——只按 tabId 执行就等于盲关别人的 tab。
       * 地址与 tabId 一起进候选，执行时才能用同一个地址做「这个 id 此刻仍然是我们要关的那个资源」
       * 的复核（见 handleSidebarBatchClose 与 sidebarTabPresenceInInventory 的 contentId 判据）。
       */
      const sidebarBatchCandidates = (addresses, inventory) => {
        const seen = new Set();
        const candidates = [];
        for (const entry of inventory) {
          // 单条损坏记录（getter 抛错、非对象、缺字段）只跳过这一条：其余可关闭的 tab 照旧成候选。
          let candidate = null;
          try {
            candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            const tabId = text(candidate.tabId, null);
            if (tabId === null) continue;
            const contentId = text(candidate.contentId, null);
            if (contentId === null || addresses.has(contentId) !== true) continue;
            if (seen.has(tabId) === true) continue;
            seen.add(tabId);
            candidates.push({ tabId, address: contentId });
          } catch { continue; }
        }
        return candidates;
      };

      /**
       * 两类标题行的批量状态（渲染期纯读，一次渲染只算一次）。
       *
       * 四态语义严格区分「未知」「零」「有候选但关不掉」：
       * - inventory 读不出来（旧宿主 / 读面抛错 / 非数组）→ kind "none"：不渲染零圆点、也不渲染按钮；
       * - inventory 已知是数组且候选数为 0 → kind "zero"：非交互蓝色实心圆占位（需要左箭头图标可用）。
       *   零状态只由「候选集合为空」决定，**不依赖 close 能力**：本行确实没有可关闭的会话时，
       *   蓝点表达的就是这个事实，与宿主能否关闭无关；
       * - 候选数 > 0 且 close 能力可用 → kind "close"：可点击的双左尖括号批量关闭按钮；
       * - 候选数 > 0 但 close 不可用 → kind "none"：既不能误报「零」（inventory 里明明有本行的
       *   打开会话），也绝不渲染一个点了不会关的假按钮，这一行整个不出现行尾控件。
       *
       * 判定的顺序有实质意义：必须先算候选再看 close 能力。反过来（先看 close）会把「有候选但
       * 关不掉」误判成「零」，那正是蓝点最不该出现的场合。
       */
      const sidebarBatchStateFor = (addresses) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return { kind: "none", candidates: [] };
        const candidates = sidebarBatchCandidates(addresses, inventory);
        if (candidates.length === 0) return { kind: "zero", candidates: [] };
        if (closeSidebarResource === null) return { kind: "none", candidates: [] };
        return { kind: "close", candidates };
      };

      /**
       * 两行批量状态的合并签名：只在候选集合真的变化时触发一次重渲染（空闲轮询绝不空转重渲染）。
       * 两行必须一起进签名——只跟踪主代理行会让空闲分组的手动开/关 tab 迟迟不被反映。
       *
       * 候选是 { tabId, address }：签名必须把**两个字段**都编码进去。只取 tabId 会让「同一个 id 换了
       * 资源地址」这种真实变化被当成没变化（按钮计数不变，但该关的目标已经变了）；直接 join 对象则退化
       * 成 "[object Object]"——两种都会让签名失去意义。分隔符用 NUL，与复合键同一个约定。
       */
      const sidebarBatchSignatureOf = (runningState, idleState) => {
        const part = (state) => (state.kind === "close"
          ? "close:" + state.candidates
            .map((candidate) => candidate.tabId + SIDEBAR_TAB_KEY_SEPARATOR + candidate.address)
            .join(",")
          : state.kind);
        return part(runningState) + "|" + part(idleState);
      };

      /**
       * 等宿主完成一次布局提交，再读取 DockLayout 的可分栏判定。
       *
       * `layout.panels` 的 setRightbar action 只同步派发 store 更新；真实宿主的 `DockLayout`
       * 通过 React 提交后才会更新 `onRoom` 读面，而 `sidebarRight.split()` 会立即读取这个
       * 读面。若在同一调用栈内 split，宿主仍可能看到旧的窄栏并弹出「栏宽不足」。
       * 优先使用 RAF，让 React 的 layout effect 和浏览器布局先完成；无 RAF 的旧宿主退回
       * 一个宏任务，再退回 microtask。这个等待只发生在新版 install 注入的 split 事务里，
       * 旧宿主没有事务入口时仍保持原同步兼容路径。
       */
      const waitForSidebarSplitLayoutCommit = () => new Promise((resolve) => {
        let settled = false;
        let fallbackTimer = null;
        const clearFallback = () => {
          if (fallbackTimer === null) return;
          try { globalThis.clearTimeout?.(fallbackTimer); } catch { /* 清理失败时 callback 仍会由 settled 防重。 */ }
          fallbackTimer = null;
        };
        const settle = () => {
          if (settled) return;
          settled = true;
          clearFallback();
          resolve();
        };
        const scheduleFallback = (delay) => {
          try {
            const setTimeout = globalThis.setTimeout;
            if (typeof setTimeout !== "function" || settled) return false;
            fallbackTimer = setTimeout(settle, delay);
            return true;
          } catch {
            return false;
          }
        };
        try {
          const requestAnimationFrame = globalThis.requestAnimationFrame;
          if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(() => settle());
            // 视觉帧可能被后台标签页节流；fallback 只负责结束等待，随后仍由事务检查决定是否 split。
            if (scheduleFallback(SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS)) return;
          }
        } catch { /* 继续尝试不依赖视觉帧的宿主调度器。 */ }
        if (scheduleFallback(0)) return;
        try {
          const queueMicrotask = globalThis.queueMicrotask;
          if (typeof queueMicrotask === "function") {
            queueMicrotask(settle);
            return;
          }
        } catch { /* 最后的同步收口保证 Promise 不会永久悬挂。 */ }
        settle();
      });

      /**
       * 子代理页必须先通过公开 split() 获得独立 paneId，再由 openResource 显式定位；split() 明确
       * 失败时不打开资源，避免回落到 Expert Group pane。旧宿主没有 split() 时保留 preferNewPane
       * 兼容路径。这里不调用 float，因为 float 的用户可见结果是独立窗口。
       */

      /**
       * 清理当前 split 事务；失败时由 install 侧按实际 pane 组成决定是否恢复 20%。
       *
       * 同一个 key 的「在途打开记录」与 split 意图属于同一次点击：事务一旦收口，那次打开就不该
       * 再被后续同步当成「还没确认的打开」而重建关闭记录（用户明明已经收回了这个 tab）。因此这里
       * 一并删除该 key 的 opening 记录；意图缺失时它是一次幂等空操作。
       */
      const cancelPendingSidebarSplit = (reason, expectedIntentToken) => {
        const intent = sidebarSplitIntentRef.current;
        if (intent === null) return;
        /**
         * 可选的令牌闸门：显式传入令牌的调用方（关闭收口）必须与当前意图的**不可复用令牌**逐对象
         * 相等才允许取消；不传令牌的调用方（卸载、超时、动作被撤销、打开失败）保持既有语义——它们
         * 手里的意图就是它们此刻正在处理的那一份。null 是**有效**的期望值：它只可能来自「出发时根本
         * 没有意图」，此刻槽位里的任何意图都必然是后来者，一律不取消。
         */
        if (expectedIntentToken !== undefined && intent.token !== expectedIntentToken) return;
        sidebarSplitIntentRef.current = null;
        // 意图里带着 key，收口范围因此精确到这一次点击，绝不误伤别的行的在途记录。
        sidebarTabOpeningRef.current.delete(intent.key);
        if (cancelSidebarSplit === null) return;
        try { cancelSidebarSplit.call(config, intent.token, { reason }); } catch { /* 收口失败不能阻断面板同步。 */ }
      };
      /**
       * 关闭收口专用的 split 事务取消：只有当前意图**仍然是这次关闭出发时看到的那一份**才允许取消。
       *
       * 特征判据必须是比较意图的**不可复用令牌**（每次 beginSidebarSplit 新建的对象身份），而不是
       * 只比 key：split 意图槽位在一个实例里只有一份，同一个 key 上的新一次打开会把它整份替换掉，
       * 旧 close 的迟到收口（尤其 verified-recycled）若按 key 取消，取消的就是新 generation 的
       * split/open 事务——右栏从临时 50% 掉回、新 pane 的打开失去归属，而那次打开与这次关闭毫无关系。
       *
       * 令牌为 null（出发时根本没有意图）时一律不取消：它只可能属于后来者。
       */
      const cancelPendingSidebarSplitOfClose = (key, splitIntentToken) => {
        const intent = sidebarSplitIntentRef.current;
        if (intent === null || intent.key !== key) return;
        if (splitIntentToken === null || splitIntentToken === undefined) return;
        if (intent.token !== splitIntentToken) return;
        cancelPendingSidebarSplit("close", splitIntentToken);
      };

      /**
       * 只有 inventory 与 DOM 同时证明目标资源位于本次返回的 pane，才结束临时扩栏事务。
       * 该检查复用已有 observer、可见性回调和轮询，不另挂长期 observer。
       */
      const tryCommitSidebarSplit = () => {
        const intent = sidebarSplitIntentRef.current;
        if (intent === null || intent.resourceIssued !== true || commitSidebarSplit === null) return;
        const evidence = sidebarSplitTargetEvidence(intent.resourceAddress, intent.paneId);
        if (evidence === null) return;
        try {
          if (commitSidebarSplit.call(config, intent.token, evidence) === true) {
            sidebarSplitIntentRef.current = null;
          }
        } catch {
          // 宿主提交窗口仍可能在下一次 observer/轮询中完成，保留事务继续等待。
        }
      };

      /**
       * 第一阶段：既有「右栏 tab 记录/库存同步」（外部关闭观察、在途打开结算、批量签名更新）。
       *
       * 它保留了原有的提前 return（records 为空时不做任何 DOM 查询）；自动同步因此被拆到
       * 独立的第二阶段（syncSidebarTabs），那些短路不会再吞掉自动打开/关闭。
       */
      const syncSidebarTabRecords = () => {
        // 右栏拖拽手柄锁复用这条既有生命周期（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）：
        // 活跃 tab 一变就重估，绝不为它单独再挂一个长期 observer。请求失败只影响这一次重估。
        try { requestRightbarDragSync?.(); } catch { /* 手柄锁只是体验优化，绝不影响面板。 */ }
        /**
         * 标题行批量控件/零圆点由渲染期现读的 openTabs inventory 决定，因此这里必须在**任何提前 return
         * 之前**比较一次候选签名：records 为空时旧实现会直接返回，inventory 变化就再也不会被反映，
         * 用户手动打开的 tab（没有本插件的打开记录）也会永远看不到可关闭的批量按钮。
         *
         * 只有签名真的变化才 bump：2.5 秒轮询在没有变化时绝不产生重渲染。
         */
        const batchSignatureNow = sidebarBatchSignatureOf(
          sidebarBatchStateFor(runningSidebarResourceAddresses()),
          sidebarBatchStateFor(idleSidebarResourceAddresses(sidebarIdleChildren())),
        );
        if (sidebarBatchSignatureRef.current !== batchSignatureNow) {
          sidebarBatchSignatureRef.current = batchSignatureNow;
          bump((value) => value + 1);
        }
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
         const now = Date.now();
                   const openingResolved = [];
          /**
           * 初始收养的判据是「当前（sidebar session + root）还没有任何打开记录」，而不是全局
           * records.size：同一个 Panel 实例会按新的 props.scope 切换到另一个 root，前一个 root
           * 遗留的记录绝不能让当前 root 跳过这一步——否则宿主里已经存在的 tab 永远收不到记录，
           * Auto 也就再也认不出自己打开过的 tab（箭头停在 >>，资源结束后也不会自动关闭）。
           *
           * 记录键始终是（sidebar session + root + 地址）复合键，因此按 scope 收养不会覆盖或
           * 误伤别的 root 的记录。tabId 一律当场从当前 openTabs inventory 现读（见 recordSidebarTab），
           * 绝不跨重挂载缓存 tabId：宿主的 tabId 只由它自己那份 inventory 证明。
           */
          let scopedRecordExists = false;
          for (const record of records.values()) {
            if (record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId) {
              scopedRecordExists = true;
              break;
            }
          }
          if (scopedRecordExists !== true) {
            for (const resourceAddress of knownSidebarResourceAddresses()) {
              if (sidebarAdoptionEvidenceAvailable(resourceAddress) !== true) continue;
              const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
              if (recordSidebarTab(key, resourceAddress)) openings.delete(key);
            }
          }
         for (const [key, opening] of openings) {
           if (now >= opening.expiresAt) {
             if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("timeout");
             openingResolved.push(key);
             continue;
           }
           if (opening.sessionId !== sidebarSessionId || opening.rootSessionId !== rootSessionId) continue;
           if (recordSidebarTab(key, opening.resourceAddress)) openingResolved.push(key);
         }
         for (const key of openingResolved) {
           openings.delete(key);
         }
         // 先完成精确 split 提交，再执行关闭同步；guide-only 或错误 pane 仍继续等待。
         tryCommitSidebarSplit();
         /**
          * 手动意图的兜底结算扫描（在任何提前 return 之前）：
          * 在途动作收尾、打开记录落地或超时都可能让一个意图变成可结算状态。数量级等于用户点击次数，
          * 因此每轮扫描的成本可以忽略；仍然在途的意图由 applyPendingManualIntent 自己跳过。
          * 别的 session/root 的条目在这里永远结算不了（它属于那个 surface 自己的闭包），直接删除，
          * 保证面板跨 root 复用时不泄漏手动意图。
          */
         for (const key of [...sidebarManualIntentRef.current.keys()]) {
           const entry = sidebarManualIntentRef.current.get(key);
           if (entry === undefined) continue;
           if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) {
             sidebarManualIntentRef.current.delete(key);
             continue;
           }
           applyPendingManualIntent(key);
         }
         // 先完成打开记录，再执行关闭同步；同 pane 回落不再被转换成独立浮窗。
         // 这里保留「没有打开记录就直接返回」的既有短路（它保证空闲时不会发生任何 DOM 查询）；
         // 批量控件的聚合状态更新已经在**这个短路之前**完成，因此 records 为空时 inventory 的变化
         // 照旧能被反映，而用户手动打开的 tab 也不再依赖本插件的打开记录。
         if (records.size === 0) return;
        const present = presentSidebarTabIds();
        if (present === null) return;
        const floatingTitles = presentFloatingSubagentTitles();
         if (floatingTitles === null) return;
         const activeTabId = activeSidebarTabId();
        const stale = [];
        for (const [key, record] of records) {
          if (record.sessionId !== sidebarSessionId || record.rootSessionId !== rootSessionId) continue;
          if (present.has(record.tabId) === true
             || record.tabId === activeTabId
             || (text(record.title, null) !== null && floatingTitles.has(record.title))) {
            record.misses = 0;
            continue;
          }
          record.misses += 1;
          if (record.misses >= SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS) stale.push(key);
        }
        if (stale.length === 0) return;
        for (const key of stale) {
          // 外部关闭同步只维护「这个 tab 还在不在」的记录：宽度不再随 tab 开关变化。
          records.delete(key);
        }
        bump((value) => value + 1);
      };

      /**
       * 当前 sidebar session 的公开 inventory 里，某个资源地址对应的已提交 tabId。
       *
       * 返回值必须区分两种「没有」——这是能力降级 fail-closed 的唯一判据：
       * - readable === false：inventory 不可读（旧宿主 / 读取抛错）。此时既证明不了资源已打开，
       *   也证明不了它没打开，调用方一律不得据此自动打开（否则可能开出重复页）；
       * - readable === true && tabId === null：读到了 inventory，确认这个地址没有已提交 tab。
       * 判定字段与 recordSidebarTab 逐条同源（同 session、kind、contentId），因此「自动打开前的
       * 存在性检查」与「关闭用的 tabId」永远来自同一个来源，绝不按「当前 active 是谁」猜 tab。
       */
      const sidebarResourceTabStateOf = (resourceAddress) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return { readable: false, tabId: null };
        for (const entry of inventory) {
          /**
           * 单条畸形条目（属性 getter 抛错）只跳过它自己：它既证明不了资源已打开，也不代表整份
           * inventory 不可读，因此绝不让它把异常抛到同步链路上、也绝不因此改变 readable 的语义。
           */
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.contentId, null) !== resourceAddress) continue;
            return { readable: true, tabId: text(candidate.tabId, null) };
          } catch { continue; }
        }
        return { readable: true, tabId: null };
      };
      /**
       * 收养路径（面板重挂载 / 切换 root 后从宿主重建记录）的证据门槛。
       *
       * 收养没有「本次动作」这一上下文，而 recordSidebarTab 的 active() 兜底读面**不带 session**：
       * 同一个 root 的 child surface 是独立右栏，它自己的 active tab 不能证明当前 session 已经打开
       * 了这个资源。若在 inventory 可读时也接受兜底，新 Session 就会借用旧 Session 的 tabId（<< 指向
       * 别人的 tab，点击会关闭别的栏里的会话）。
       *
       * 因此：inventory 可读 ⇒ 必须由**当前 session** 的条目证明；只有 inventory 不可读（旧宿主 /
       * 读取抛错）才沿用 active() 这一唯一证据——那条路径的既有契约是「外部已存在的 tab 记为手动
       * 来源，Auto 既不接管也不关闭」（见 recordSidebarTab 与 Auto 的相关用例）。
       */
      const sidebarAdoptionEvidenceAvailable = (resourceAddress) => {
        const state = sidebarResourceTabStateOf(resourceAddress);
        if (state.readable !== true) return true;
        return state.tabId !== null;
      };
      /**
       * active() 是否已经是这个资源（kind 与 contentId 同时匹配）。
       *
       * inventory 不可读或提交延迟时，它仍能证明「这个资源已经开着」：这样的 tab 只算手动/未知
       * 来源，Auto 既不接管（不写 auto 来源）也不重复打开；它只在「可追踪」判定里作为证据使用。
       */
      const sidebarActiveResourceMatches = (resourceAddress) => {
        if (readActiveSidebarResource === null) return false;
        let tab = null;
        try { tab = object(readActiveSidebarResource.call(sidebarRight)); } catch { return false; }
        if (text(tab.kind, null) !== SUBAGENT_CHAT_KIND) return false;
        return text(tab.contentId, null) === resourceAddress;
      };
      /**
       * 自动打开必须同时具备的能力（缺一项即 fail-closed，绝不自动打开）：
       * 1. 公开 close()：没有它，Auto 打开的 tab 将来无法被精确回收（只能用 tabId 关闭，绝不改用
       *    批量入口或按 active 猜）；
       * 2. 落地证据读面（active() 或 openTabs inventory）与左箭头图标：没有证据就无法确认这次打开
       *    有没有落地，也就没有可关闭的 << 状态；
       * 3. 公开 openResource()：没有它连打开动作都发不出去。
       * 只约束自动路径：这些能力缺失时手动箭头与历史行为逐条不变。
       */
      const sidebarAutoOpenCapable = () => openSidebarResource !== null
        && closeSidebarResource !== null
        && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
        && typeof primitives?.IconChevronLeftOutlineRegular === "function";

      /** 当前 surface 自己的手动意图记录；别的 session/root 的键在当前闭包里一律不可见。 */
      const sidebarManualIntentOf = (key) => {
        const entry = sidebarManualIntentRef.current.get(key);
        if (entry === undefined) return undefined;
        if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) return undefined;
        return entry;
      };
      /**
       * Auto 同步第二阶段的候选选择：先给一个「该关的」候选，再给一个「该开的」候选。
       *
       * 一个同步轮次最多产出一个候选（见 sidebarAutoBusyRef）：多个候选由动作收尾后的同一条
       * 同步链路逐个推进，绝不并发发多个 split/openResource。
       */
      const autoCloseCandidate = (running) => {
        const origin = sidebarAutoOriginRef.current;
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
        const attempts = sidebarAutoCloseAttemptsRef.current;
        for (const [key, entry] of origin) {
          // 只处理当前 surface 的记账：别的 session/root 的键在当前快照里无法判定，绝不越权操作。
          if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
          if (running.has(entry.address) === true) {
            // 资源重新变成运行中：它已经开着就保持开着，重试预算、owner 身份与失败冷却一并清零。
            // **绝不**丢弃仍在验证中的关闭：那条链属于「已经发出的一次关闭」，它的收口（删记录、
            // 撤销来源 / 登记抑制）与重试预算无关；丢掉它会让 record 与箭头永久停在 <<。
            /**
             * 归属标记同源清理：只有在「这个 key 上确实有过一次关闭在途/预算消耗」时才清——那才是
             * 「资源又跑起来了，旧归属已经过期」的形状；普通的运行中 Auto tab（刚打开、没有任何关闭
             * 记账）绝不能被顺手清掉，否则一次刷新就会把它降级成 manual，正是本插件要修的漏收。
             * 清掉之后，下一次自动打开会重新打点（见 recordSidebarTab 的 auto-open 写入）。
             */
            if (attempts.has(key) === true
              || sidebarAutoCloseCooldownsRef.current.has(key) === true
              || sidebarAutoCloseVerificationsRef.current.has(key) === true) {
              deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, "resource-running");
            }
            clearAutoCloseBudget(key);
            continue;

          }
          const record = records.get(key);
          const scopedRecord = record !== undefined
            && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId
            ? record
            : undefined;
          if (scopedRecord === undefined) {
            // 没有已确认的 tabId 时绝不猜一个 id 去关：这次打开仍在途就继续等它落地，
            // 否则只撤销来源标记（元素已经不在这个 surface 上了）。
            const opening = openings.get(key);
            if (opening !== undefined && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId) continue;
            if (sidebarTabPendingRef.current.has(key) === true) continue;
            origin.delete(key);
            clearAutoCloseAttempt(key);
            continue;
          }
          if (scopedRecord.origin !== SIDEBAR_TAB_ORIGIN_AUTO) {
            // 记录已经被手动接管（用户手动打开或外部 tab）：手动优先，撤销自动来源，绝不关闭它。
            origin.delete(key);
            clearAutoCloseAttempt(key);
            continue;
          }
          /**
           * 来源账本 ⇄ 记录 的 tabId 绑定闸门（与收养路径同一条判据，缺陷 1 的第二个消费点）。
           *
           * 这本账本是 realm 共享的，条目里的 tabId 是「Auto 打开/替换落地那一刻亲眼看到的 tab」。
           * 条目与记录指向同一个 tab 时它才证明这条关闭候选仍是我们自己开出来的那个 tab；一旦两者
           * 对不上（宿主重 mint 了新 id、而插件没有观察到那次替换），账本那条已经不能代表任何还在
           * 我们手里的 tab —— 按安全侧撤销这条自动来源，绝不按它关闭。
           *
           * 条目 tabId 为 null（这次自动打开已经发出、落地证据还没到）不触发本闸门：那种条目本身
           * 就不是归属证据，真正的判据在下一条（scopedRecord 的 tabId）与关闭 preflight 上。
           */
          const boundAutoTabId = sidebarAutoOriginTabIdOf(entry);
          if (boundAutoTabId !== null && boundAutoTabId !== scopedRecord.tabId) {
            origin.delete(key);
            clearAutoCloseAttempt(key);
            continue;
          }
          /**
           * 同一个 tab 上已经有一次关闭在途（典型：旧 Panel 实例的 close Promise 还没结算，当前实例
           * 刚刚从宿主 inventory 收养了它）：这一轮直接让位，绝不排队第二次关闭。
           *
           * 这里既不推进重试计数、也不撤销来源——那次关闭的成败由发起它的链路按成功路径结算；当前
           * 轮次只是「有人在关，别插手」。真正的执行点还会再确认一次（候选选择与执行之间隔着一次
           * 微任务跳转与一次可能的组件重挂载，见 handleSidebarAction）。
           */
          if (sidebarTabCloseInFlight(scopedRecord.tabId) === true) continue;
          /**
           * 宿主的公开 inventory 明确读到这个 tabId 不在（absent），或已经被回收给**另一个资源**
           * （recycled：条目暴露的 contentId 与本 key 的资源地址不一致）——两者都必须先过
           * 「连续两次可读采样」的确认闸门，才允许收口这个 key 的归属：
           *
           * 单次缺项**不构成**「tab 已经不在」的证据。宿主 inventory 在这类时机短暂缺项是正常抖动
           * （布局换桶、面板重挂载、提交窗口的中间态），而单次 absent 就删掉 record / 来源 / 预算等于
           * 让一个仍然开着的 tab 永久脱离 Auto（正是用户报的「偶尔漏收」）；单次 recycled 更是把一次
           * 读取抖动升格成「旧 tab 已消失」，会顺手清掉冷却与预算。记录同步器与关闭验证链都要求
           * SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS 次连续缺失，候选选择必须与它们同一条强度。
           *
           * 计数语义（见 sharedSidebarAutoTabMisses）：
           * - present：计数清零，照旧继续走关闭路径；
           * - absent / recycled：累加连续计数，未达确认次数时**保留** record / 来源 / 预算 / 冷却，
           *   本轮既不关闭也不收口（下一轮可读采样继续确认）；
           * - unreadable（旧宿主只有 active()）：既不证明存在也不证明不存在，绝不推进计数——保持既有
           *   语义，仍按已确认记录发起关闭，由 closeSidebarTabWithLease 的 preflight fail-closed。
           *
           * 确认收口时两种证据的收口范围与旧实现逐字一致：absent 清预算（保留冷却），recycled 连冷却
           * 一起清（这个 key 的 tab 已经不存在，一条永远等不到自己 tab 的冷却只会白白屏蔽真实关闭）。
           * 别的 key 的记录不在本次收口范围内：每个 key 只按自己的地址与自己的 record 结算。
           */
          const recordPresence = sidebarTabPresenceInInventory(scopedRecord.tabId, entry.address);
          const recordMissing = recordPresence === "absent" || recordPresence === "recycled";
          if (recordMissing === true) {
            // 还没到连续两次的确认次数：本轮保留 record / 来源 / 预算 / 冷却，既不关闭也不收口。
            if (sampleAutoTabMisses(key, scopedRecord.tabId, true) < SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS) continue;
          } else if (recordPresence === "present") {
            // 任一正向证据清零，与记录同步器「正向证据清零」逐字同源。
            sampleAutoTabMisses(key, scopedRecord.tabId, false);
          }
          // 落到这里的其余情况只有 unreadable：既不推进计数也不清零——读不到既不证明存在也不证明不存在，
          // 与关闭验证链同一条语义，随后仍按已确认记录走关闭路径（preflight 会 fail-closed）。
          if (recordPresence === "absent") {
            records.delete(key);
            origin.delete(key);
            clearAutoCloseAttempt(key);
            deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, "inventory-absent");
            bump((value) => value + 1);
            continue;
          }
          if (recordPresence === "recycled") {
            records.delete(key);
            origin.delete(key);
            clearAutoCloseBudget(key);
            deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, "tab-recycled");
            bump((value) => value + 1);
            continue;
          }
          if (closeSidebarResource === null) {
            // 宿主没有公开 close（旧宿主）：撤销记账，绝不退化成别的关闭方式。
            origin.delete(key);
            clearAutoCloseAttempt(key);
            continue;
          }
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          // 本次级联里已经为它尝试过并失败：同一批微任务里绝不重试（见 sidebarAutoFailedKeysRef）。
          if (sidebarAutoFailedKeysRef.current.has(key) === true) continue;
          // 用户刚刚在这个 key 上表达过手动意图：交给手动链路结算，Auto 本轮让位（手动恒优先）。
          if (sidebarManualIntentOf(key) !== undefined) continue;
          // 上一次关闭请求还在验证中（租约被验证链持有）：这一轮让位，绝不为同一个 key 再发一次 close。
          if (sidebarAutoCloseVerificationsRef.current.has(key) === true) continue;
          // 冷却慢车道：冷却期内零次 close 请求，origin / record 一律保留（绝不删除归属）。
          if (autoCloseCooldownActive(key) === true) continue;
          // 冷却到期：清空快速预算，允许一次新的真实 close（失败后再退避到下一档）。
          releaseExpiredAutoCloseCooldown(key);
          const used = attempts.get(key) ?? 0;
          if (used >= SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS) {
            // 快速预算用尽：**保留 origin 与 record**，改为进入冷却慢车道（60 秒起指数退避）。
            // 绝不删除归属——删除就等于让一个仍然打开的 tab 永久脱离 Auto（「偶尔漏收」的症状）。
            enterAutoCloseCooldown(key);
            continue;
          }
          /**
           * 每次候选都创建一份**不可复用**的身份令牌（对象身份，而不是可重复的计数或字符串），并
           * 登记进共享 owner 账本：这条预算现在归这一次动作。只有令牌仍然匹配的动作才允许回滚它，
           * 因此旧代次在副作用之前被撤销时绝不可能删掉/覆盖新代次已经预支的那一笔预算。
           */
          const attemptToken = { key, attemptsBefore: used };
          attempts.set(key, used + 1);
          sidebarAutoCloseAttemptOwnersRef.current.set(key, attemptToken);
          // 与来源 / 抑制两个集合同一把安全阀：复合键跨 root 保留，计数绝不能随长生命周期无界增长。
          // owner 账本与它同序写入，因此用同一个上限、同一套淘汰规则（绝不新增无界 Map）。
          trimAutoKeyMap(attempts, true);
          trimAutoKeyMap(sidebarAutoCloseAttemptOwnersRef.current, true);
          // attemptsBefore 让「动作在真正调用 close 之前被撤销」的路径能精确回退这一次尝试计数，
          // 否则一次被取消的自动关闭就会白烧掉一次有界重试预算；attemptToken 是回滚的**所有权凭据**，
          // 必须随 autoContext 一路带到每个可能回滚的分支（见 handleSidebarAction）。
          return { key, address: entry.address, kind: "close", attemptsBefore: used, attemptToken };
        }
        return null;
      };
      const autoOpenCandidate = (running) => {
        // 能力降级 fail-closed：close()/落地证据/左箭头任一缺失时绝不自动打开（见 sidebarAutoOpenCapable）。
        if (sidebarAutoOpenCapable() !== true) return null;
        const origin = sidebarAutoOriginRef.current;
        const suppressed = sidebarAutoSuppressedRef.current;
        const reservations = sidebarAutoReservationRef.current;
        const records = sidebarTabRecordsRef.current;
        const openings = sidebarTabOpeningRef.current;
        for (const address of running) {
          const key = sidebarTabKey(sidebarSessionId, rootSessionId, address);
          // 本次级联里已经为它尝试过并失败：绝不在同一批微任务里重试（见 sidebarAutoFailedKeysRef）。
          if (sidebarAutoFailedKeysRef.current.has(key) === true) continue;
          // 用户手动关闭过：绝不立刻重开（抑制只由用户手动重新打开，或资源明确空闲后的清点清除）。
          if (suppressed.has(key) === true) continue;
          /**
           * 持久 manual 抑制（跨整页刷新）：内存里的 suppressed 在刷新之后是空的，但用户的关闭意图
           * 落在持久条目上（见 SIDEBAR_AUTO_OWNERSHIP_KEY）——manual 恒优先，这里必须与内存抑制同强度
           * 地跳过这个地址。少了这一步，「资源仍在运行 + 用户已手动关闭该 tab + 刷新」会被 Auto
           * 重新打开（P1-B）。
           *
           * 抑制的清除时机**只**由资源状态决定：观察到这个地址明确空闲（ready）时清除（见
           * clearManualSuppressionOfIdleResources）。因此刷新时正在运行、用户已关闭的 tab 不会被重开，
           * 而子代理真正结束之后标记消失，下一次运行仍能正常自动打开。
           *
           * 读面走 quiet 通道：这条判据每轮同步都会执行，结论由下面那条决策诊断承担。
           */
          const persistedForOpen = readSidebarAutoOwnershipEntry(sidebarSessionId, rootSessionId, address, { quiet: true });
          if (persistedForOpen !== null && persistedForOpen.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) {
            recordSidebarAutoDecision("open", { key, kind: "open" }, "skip", "persisted-manual");
            continue;
          }
          // 本次运行已经为它成功发出过打开动作：绝不重复打开（与失败无关，失败会撤销预留）。
          if (origin.has(key) === true) continue;
          /**
           * 容量 fail-closed：内存账本或持久表装不下这条新 owner 时**不打开**（记 owner-capacity
           * 诊断）。绝不为了腾位淘汰别的 scope 仍然有效的 owner——到达上限是可用性代价而不是错误：
           * 用户仍然可以手动打开这个资源（手动打开照常写 manual 归属）。
           */
          if (autoSidebarOwnershipHasCapacity(key, address) !== true) {
            recordSidebarAutoDecision("open", { key, kind: "open" }, "skip", "owner-capacity");
            continue;
          }
          // 已经有一个候选为它预留：同一资源绝不并发两个动作。
          if (reservations.has(key) === true) continue;
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          // 用户在同一个 key 上有未结算的手动意图：让手动链路先结算，Auto 本轮跳过。
          if (sidebarManualIntentOf(key) !== undefined) continue;
          const record = records.get(key);
          if (record !== undefined && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId) continue;
          const opening = openings.get(key);
          if (opening !== undefined && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId) continue;
          /**
           * 存在性检查必须「先可读、再确认没有」：
           * - inventory 不可读时无法证明资源没打开，fail-closed 跳过这个候选（宁可不动，也不开出重复页）；
           * - inventory 可读但没有该地址、而 active() 已经是它（提交延迟 / 别的 pane）：同样视为已经存在
           *   的手动/未知来源，不重复打开，也不写 auto 来源。
           */
          const state = sidebarResourceTabStateOf(address);
          if (state.readable !== true) continue;
          if (state.tabId !== null) continue;
          if (sidebarActiveResourceMatches(address) === true) continue;
          /**
           * 先写**预留**再发动作：任何重入（observer/轮询/尾随同步）都不会为同一个资源再选一次。
           * 预留只是候选去重，绝不等于「Auto 已经打开」——只有 openResource 真的成功发出后才会
           * 升级成来源标记；失败路径在 handleSidebarAction 的 finally 里撤销它，使后续同步可以重试。
           */
          const epoch = sidebarAutoEpochRef.current;
          reservations.set(key, { sessionId: sidebarSessionId, rootSessionId, address, epoch });
          trimAutoKeyMap(reservations);
          return { key, address, kind: "open", epoch };
        }
        return null;
      };
      /**
       * 上限淘汰（复合键跨 root 保留时的安全阀，见 SIDEBAR_AUTO_KEY_LIMIT）。
       *
       * activeAware = true 时优先淘汰「没有当前 record / 没有在途动作 / 没有验证 / 没有冷却」的历史条目；
       * 若 128 项全是活动条目，则**什么都不淘汰**（fail-closed）。false 保持既有语义（按插入顺序丢最旧）。
       *
       * 注意（缺陷 2）：这里调用 sidebarAutoCloseKeyIsActive 判「活动」，而它读的是**当前这个 Panel
       * 实例**的在途状态与**当前 scope**的 record。因此这套淘汰只允许用在「条目重新出现时会自行重建」
       * 的记账上（重试预算 / owner 令牌 / 冷却 / 抑制）。**归属账本不复用它**：那种判据会把别的
       * root 仍然有效的 Auto owner 判成 inactive 淘汰掉（内存），那个 tab 从此永久脱离 Auto——
       * 归属容量改由 autoOpenCandidate 在发出 openResource 之前 fail-closed 拒绝（不淘汰任何人），
       * 见 autoSidebarOwnershipHasCapacity。
       */
      const trimAutoKeyMap = (map, activeAware) => {
        while (map.size > SIDEBAR_AUTO_KEY_LIMIT) {
          let victim = null;
          for (const candidate of map.keys()) {
            if (activeAware !== true || sidebarAutoCloseKeyIsActive(candidate) !== true) {
              victim = candidate;
              break;
            }
          }
          if (victim === null) break;
          map.delete(victim);
        }
      };
      /**
       * 这个 key 现在是否还有「活动的 Auto 关闭记账」。
       *
       * 判据（任一成立即活动）：仍在途的打开记录 / 预留 / pending 动作 / 关闭验证 / 失败冷却 / 当前 scope
       * 下仍有精确 record。限容淘汰与「快照缺项」清理都必须给这些 key 让位——它们仍然可能被精确关闭。
       */
      const sidebarAutoCloseKeyIsActive = (key) => {
        if (sidebarTabPendingRef.current.has(key) === true) return true;
        if (sidebarTabOpeningRef.current.has(key) === true) return true;
        if (sidebarAutoReservationRef.current.has(key) === true) return true;
        if (sidebarAutoCloseVerificationsRef.current.has(key) === true) return true;
        if (sidebarAutoCloseCooldownsRef.current.has(key) === true) return true;
        const record = sidebarTabRecordsRef.current.get(key);
        return record !== undefined
          && record.sessionId === sidebarSessionId
          && record.rootSessionId === rootSessionId;
      };
      /** 清空一个 key 的失败冷却与重试预算（verified-closed / 手动接管 / 资源重新运行共用）。 */
      const clearAutoCloseBudget = (key) => {
        clearAutoCloseAttempt(key);
        sidebarAutoCloseCooldownsRef.current.delete(key);
      };
      /** 进入冷却慢车道：60 秒起指数退避、上限 15 分钟；origin / record 一律保留。 */
      const enterAutoCloseCooldown = (key) => {
        const cooldowns = sidebarAutoCloseCooldownsRef.current;
        const previous = cooldowns.get(key);
        const step = previous === undefined ? 0 : Math.min(previous.step + 1, 4);
        const delay = Math.min(SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS * (2 ** step), SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS);
        cooldowns.set(key, { step, until: Date.now() + delay });
        trimAutoKeyMap(cooldowns, true);
      };
      /** 冷却是否仍在生效：生效期内同一个 key 零次 close 请求。 */
      const autoCloseCooldownActive = (key) => {
        const entry = sidebarAutoCloseCooldownsRef.current.get(key);
        return entry !== undefined && entry.until > Date.now();
      };
      /** 冷却到期：清空快速预算，让这个 key 重新进入快速车道（失败后由 enterAutoCloseCooldown 退避到下一档）。 */
      const releaseExpiredAutoCloseCooldown = (key) => {
        const cooldowns = sidebarAutoCloseCooldownsRef.current;
        const entry = cooldowns.get(key);
        if (entry === undefined || entry.until > Date.now()) return;
        clearAutoCloseAttempt(key);
      };
      /**
       * 新 owner 能不能被**内存账本 + 持久表**同时保留（fail-closed 容量判据，缺陷 2）。
       *
       * 判据刻意与当前面板的局部状态无关：内存账本只回答「还装得下吗」（size < 上限），持久表由
       * sidebarOwnershipAcceptsNewAuto 回答（写入之后 auto 条目数不越过上限）。**绝不**再看
       * 「这个 key 在别的 scope 里是否活动」来决定谁可以被淘汰：
       *
       * - 旧实现在这里扫描整本 origin，用 sidebarAutoCloseKeyIsActive（它读的是**当前这个实例**的
       *   pending / opening / reservation / verification / cooldown 与**当前 scope**的 record）挑一个
       *   「不活动」的条目当可淘汰对象。别的 root / sidebar session 的条目在当前实例里天然「不活动」，
       *   于是 B scope 打开 128 个资源就能把 A scope 仍然有效的 owner 判成 inactive 淘汰掉——A 那个
       *   tab 从此永久脱离 Auto（自动关闭只遍历这本账本，刷新也不能恢复）。
       * - 换成纯 LRU 同样不安全：淘汰依据只是「更旧」，而被淘汰的条目完全可能仍然对应一个打开的 tab。
       *
       * 因此到达上限时唯一的动作是**不开**（记录 owner-capacity 诊断，见 autoOpenCandidate）：
       * 不打开只是可用性代价（用户仍可手动打开，手动打开照常写 manual 归属），而误淘汰是永久漏收。
       * owner 释放（verified-closed / inventory-absent / tab-recycled / 资源重新运行等既有收口）之后，
       * 新的自动打开自动恢复正常。
       */
      const autoSidebarOwnershipHasCapacity = (key, address) => {
        const origin = sidebarAutoOriginRef.current;
        if (origin.has(key) !== true && origin.size >= SIDEBAR_AUTO_KEY_LIMIT) return false;
        return sidebarOwnershipAcceptsNewAuto(sidebarSessionId, rootSessionId, address);
      };
      /**
       * 无条件收口一个 key 的共享自动关闭记账（重试预算 + owner 身份）。
       *
       * 只用于「这个 key 的预算整体不再需要」的路径：资源重新变成运行中、记录消失或被手动接管、
       * inventory 已证明 tab 不在、宿主没有公开 close、有界重试用尽、成功关闭后的收口与清理阶段。
       * 预算与 owner 必须同生共死：只删预算而留下 owner，会让旧令牌在**下一次**预支之后仍被误判成
       * 所有者；只删 owner 而留下预算，则旧令牌只能 fail-safe 地放弃回滚（白烧一次预算，但有界性
       * 不受影响）。两者一起删，语义最直白。
       */
      const clearAutoCloseAttempt = (key) => {
        sidebarAutoCloseAttemptsRef.current.delete(key);
        sidebarAutoCloseAttemptOwnersRef.current.delete(key);
        // 候选采样计数与这条预算同生共死：预算整体不再需要时，采样序列也一并作废，绝不跨代残留。
        sidebarAutoTabMissesRef.current.delete(key);
      };
      /**
       * 候选选择阶段的「这个 tab 连续不在场」计数（见 sharedSidebarAutoTabMisses）。
       *
       * 只有计数记录里的 tabId 与当前 record 的 tabId 一致时才有效：宿主为同一个 key 重新分配了
       * tabId（旧 tab 消失、同一个资源换成新 tab）之后，旧计数绝不能计入新一代的确认。
       */
      const autoTabMissesOf = (key, tabId) => {
        const entry = sidebarAutoTabMissesRef.current.get(key);
        if (entry === undefined || entry.tabId !== tabId) return 0;
        return Number.isFinite(entry.misses) ? entry.misses : 0;
      };
      /**
       * 记一次候选采样结果，返回这个 tabId 的连续不在场次数。
       *
       * present（missing !== true）一律清零，与记录同步器「任一正向证据清零」逐字同源；absent 与
       * recycled 共用同一条连续计数（两者都独立证明「这个 tabId 已经不再承载我们的资源」）。
       * unreadable 的采样绝不走到这里——读不到既不证明存在也不证明不存在，绝不推进计数。
       */
      const sampleAutoTabMisses = (key, tabId, missing) => {
        const map = sidebarAutoTabMissesRef.current;
        // 先读旧计数（只有同一个 tabId 才有效），再摘掉旧条目：两步都不能省（见下面的 LRU 说明）。
        const previousMisses = autoTabMissesOf(key, tabId);
        map.delete(key);
        // present：清零就是「条目保持删除状态」，与记录同步器「任一正向证据清零」逐字同源。
        if (missing !== true) return 0;
        const misses = previousMisses + 1;
        map.set(key, { sessionId: sidebarSessionId, rootSessionId, tabId, misses });
        /**
         * 次序即 LRU：Map 对已存在的键 set 不会改变插入位置，因此上面先 delete 再 set，让这次采样把这
         * 个 key 刷到队尾；淘汰也只按「最后一次采样有多旧」进行（见 trimSharedSidebarAutoTabMisses）。
         * 与其它 Auto 账本同一个 SIDEBAR_AUTO_KEY_LIMIT 上限：候选采样计数绝不成为第二个无界 Map。
         */
        trimSharedSidebarAutoTabMisses();
        return misses;
      };
      /**
       * 一次「已经真的关掉」的结算后的预算收口（成功关闭 / 已证明 tab 消失）。
       *
       * - 手动动作（autoContext === null）：手动恒优先，直接清空这个 key 的预算与 owner；
       * - 自动关闭动作：只有 owner 仍是本次动作的令牌时才清空。旧代次的迟到结算绝不碰后来者的预算——
       *   它可能已经在同一个 key 上重新预支了一笔，清零就等于把 3 次上限又还给它；
       * - 自动打开动作（没有 close 令牌，却因为期间出现了记录而走到关闭）：只要这个 key 上已经存在
       *   任何更新的 owner，就同样不清零——令牌不属于本次动作，那笔预算就与它无关。
       */
      const settleAutoCloseAttempt = (key, context) => {
        if (context !== null && context !== undefined) {
          const owners = sidebarAutoCloseAttemptOwnersRef.current;
          if (context.kind === "close") {
            if (owners.get(key) !== context.attemptToken) return;
          } else if (owners.has(key) === true) {
            return;
          }
        }
        clearAutoCloseAttempt(key);
      };
      /**
       * 当前 surface 下某个宿主 tabId 的关闭锁身份（见 sharedSidebarTabCloseInFlight）。
       *
       * session / root 都取**当前渲染**的值：旧实例的迟到收尾用它自己那一轮的 surface 身份归还锁，
       * 因此绝不会误删新实例（或别的 root / session）持有的那一把。
       */
      const sidebarTabCloseKeyOf = (tabId) => sidebarTabCloseKey(sidebarSessionId, rootSessionId, tabId);
      /** 当前 surface 下一个 tabId 的在途关闭租约（没有在途关闭时返回 null）。 */
      const sidebarTabCloseLeaseOf = (tabId) => sharedSidebarTabCloseInFlight.get(sidebarTabCloseKeyOf(tabId)) ?? null;
      /**
       * 这个 tab 当前是否有一次关闭在途。
       *
       * 只读探测，供候选选择阶段提前让位：不为一个已经在关的 tab 预支一次有界重试预算，也不把它
       * 记成「尝试失败」（真正的执行点还会在调用宿主 close 之前再确认一次，见 handleSidebarAction）。
       */
      const sidebarTabCloseInFlight = (tabId) => sidebarTabCloseLeaseOf(tabId) !== null;
      /**
       * 取得一个 tab 的关闭权（fail-closed）：已经有一次关闭在途时返回 null，调用方按各自的并发语义
       * 决定「等待它结算」还是「直接让位」。
       *
       * 租约不是无结果的 token，而是一份**可结算的信号**：token.ok 记录那一次关闭的**验证结果**
       * （true = inventory 连续两次读不到这个精确 tabId，verified-closed；false = 失败 / 超时 / 未验证），
       * token.wait() 让竞争者等到结算再决定下一步——上次已验证关闭就不必再 close，上次未验证才用当前
       * inventory 证明同一个 tabId 仍在之后做一次有限重试。宿主 Promise 的 resolve 绝不直接置 ok=true：
       * 它只把租约推进到 verifying，真正的结算由验证链或 watchdog 完成。
       *
       * 返回的 release 只在「Map 里仍然是本次 token」时才删除，因此旧实例的迟到收尾绝不会删掉新实例
       * （或后来者）持有的锁；release 只归还这一个身份，不触碰任何 Panel 状态（绝不改另一个实例的
       * pending / records / 来源账本）。调用方必须把它放进 finally：同步 throw、Promise reject、组件
       * 卸载后迟到的续体都走同一条归还路径，锁绝不留到下一次动作。
       */
      const acquireSidebarTabClose = (tabId) => {
        const key = sidebarTabCloseKeyOf(tabId);
        if (sharedSidebarTabCloseInFlight.has(key) === true) return null;
        let settleWaiters = null;
        const settled = new Promise((resolve) => { settleWaiters = resolve; });
        const token = {
          key,
          /**
           * 结算原因：null = 尚未结算；"closed" = 这次 close 已被 inventory 验证为关闭（或缺席）；
           * "recycled" = 这次 close 的依据是「这个 tabId 已被宿主回收给另一个资源」（旧 tab 已消失，
           * close 一次都没有发出）；"failed" = 失败 / 未验证 / 让位；"timeout" = watchdog 或验证窗口超时。
           * 宿主 Promise 的 resolve **绝不**直接把结果置成 "closed"（resolve 只代表请求完成）。
           */
          result: null,
          /**
           * 结算结果的布尔投影（仅 "closed" 为 true），保留给「只关心关没关」的读取点。
           *
           * 竞争方**不得**只看它：跨 key 交错时（A 的「旧 tab 已消失」与 T 自己的关闭落在同一个
           * tabId 上）布尔值分不清「谁证明的、凭什么证明的」。等待者必须读 result，并用自己的
           * 期望地址重新探针复核之后再决定（见 closeSidebarTabWithLease 的等待分支）。
           */
          ok: null,
          settled: false,
          /** 租约状态：in-flight（请求已发出）→ verifying（等待 inventory 验证）/ quarantined（超时隔离窗）。 */
          state: "in-flight",
          /** 验证窗口或迟到隔离窗的截止时间（虚拟时间；0 = 未设置）。 */
          holdUntil: 0,
          /** 等待这次关闭结算（永不 reject：结果通过 token.result / token.ok 读取）。 */
          wait: () => settled,
          /** 结算入口的同一份实现（同步链路需要从 map 里归还隔离窗到期的租约，见 verifyPendingSidebarCloses）。 */
          release: null,
        };
        sharedSidebarTabCloseInFlight.set(key, token);
        let released = false;
        /**
         * 结算并归还租约。outcome 是**原因**（四值，见 SIDEBAR_TAB_CLOSE_SETTLE_REASONS），布尔写法保留
         * 兼容：true ⇒ "closed"、false ⇒ "failed"。先写结果再唤醒等待者（等待者读到的一定是这次关闭的
         * 原因，而不是「锁空了」），最后只在 Map 里仍然是自己这个 token 时才删除——旧实例的迟到收尾
         * 绝不移除后来者的租约。
         */
        const release = (outcome) => {
          if (released === true) return;
          released = true;
          const reason = closeSettleReason(outcome);
          token.result = reason;
          token.ok = reason === "closed";
          token.settled = true;
          const resolve = settleWaiters;
          settleWaiters = null;
          if (resolve !== null) resolve(reason);
          if (sharedSidebarTabCloseInFlight.get(key) === token) sharedSidebarTabCloseInFlight.delete(key);
        };
        token.release = release;
        return {
          token,
          /** 保留租约到 holdUntil：期间候选选择一律让位（绝不重复 close），迟到结果也没有机会重叠。 */
          hold(state, holdUntil) {
            if (released === true) return;
            token.state = state;
            token.holdUntil = holdUntil;
          },
          /**
           * 结算并归还：先写结果再唤醒等待者（等待者读到的一定是这次关闭的结果，而不是「锁空了」），
           * 最后只在 Map 里仍然是自己这个 token 时才删除——旧实例的迟到收尾绝不移除后来者的租约。
           * ok 只有在 inventory 验证为关闭（verified-closed）时才为 true。
           */
          release,
        };
      };
      /**
       * 当前 inventory 里这个**精确 tabId** 的在场证据（必须属于当前 sidebar session，且仍是本插件的
       * 子代理会话 kind）。四态返回，因为「读不到」「确认没有」与「这个 id 已经换了资源」必须分开：
       * - "present"：命中同一个 (session, kind, tabId)，且条目若暴露了资源地址就与期望地址逐字一致
       *   → 可以安全地再发一次 close；
       * - "absent"：这个 tab 已经离开宿主，绝不再 close（用户的关闭意图已经达成）；
       * - "recycled"：tabId 还在，但它此刻承载的是**另一个资源**的地址——旧 tab 已经消失、宿主把这个
       *   id 回收给了别的资源。绝不对这个 id 发 close（那会关掉别人的 tab），只按「旧 tab 已消失」
       *   收口自己这个 key 的记账；
       * - "unreadable"：证明不了任何事 → fail-closed，绝不按 active tab 猜一个 id 去关。
       *
       * expectedAddress 是可选的第二个判据（调用方拿得到这个 key 的资源地址时才传）：
       * 地址判据**只在条目真的暴露了可读的非空 contentId 时才生效**——条目缺 contentId、值为空串或
       * 类型不可读（getter 抛错被跳过）都**不构成任何 mismatch 证据**，一律退回 present（这是本轮
       * 刻意的 fail-open 取舍，必须保留）。绝不能用可能系统性缺失的字段推断「id 被复用」，那会退化成
       * 永远不关闭：只要宿主某一版 inventory 结构性缺 contentId，本插件的每一次关闭都会在 preflight
       * 被判定成 recycled，一个 tab 也关不掉（用户可见的**永久漏收**），比下面的残余风险更糟。
       *
       * **残余风险（本轮已知、未消除）**：contentId 缺失 ⇒ 无法区分「这个 tabId 仍是我们的 tab」与
       * 「这个 tabId 已被宿主回收给另一个资源」。在这种宿主上，一次基于 tabId 的关闭请求理论上可能
       * 落到复用了这个 id 的新 tab 上。风险边界由三件事共同限制，缺一不可：
       * 1. 命中条件仍要求 (当前 sidebar session + kind=subagentchat + 精确 tabId) 三条同时成立，
       *    别的 surface、别的 kind 的同名 id 一律不会被命中；
       * 2. 关闭入口仍受「会话 + root + tabId」租约与迟到隔离窗约束（同一时刻只有一个在途请求），
       *    不会并发重复发请求；
       * 3. 只有具备可关闭 tabId 的 Auto 归属、用户手动点击或批量候选才会走到这里，绝不主动扫描
       *    inventory 去关闭任何 tab。
       * 一旦宿主提供了 contentId，判据立刻恢复为地址逐字比较（同一个函数、同一条记录）。
       *
       * 地址判据与 recordSidebarTab / sidebarBatchCandidates 逐条同源：一条 record 能存在，本身就要
       * 求当时的 inventory 条目（或 active()）的 contentId 与 key 的资源地址逐字相等；而传给宿主
       * openResource() 的也正是同一个地址字符串。因此「现在这一条的 contentId 变了」恰好就是
       * 「这个 tabId 已经不是我们的资源」的精确证据（见 closeSidebarTabWithLease 的 preflight）。
       */
      const sidebarTabPresenceInInventory = (tabId, expectedAddress = null) => {
        const inventory = readSidebarOpenTabs();
        if (inventory === null) return "unreadable";
        const expected = text(expectedAddress, null);
        for (const entry of inventory) {
          // 单条畸形记录只跳过它自己：它既不证明存在，也不代表整份 inventory 不可读。
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.tabId, null) !== tabId) continue;
            // 没有期望地址，或这一条没有暴露可读地址：无法证伪 → 保持既有的 present 语义。
            if (expected === null) return "present";
            const contentId = text(candidate.contentId, null);
            // fail-open（刻意保留）：条目没有可读的 contentId 时无法证伪，只能按 present 处理，
            // 否则在「inventory 结构性缺 contentId」的宿主上永远关不掉任何 tab。残余风险见上方说明。
            if (contentId === null) return "present";
            return contentId === expected ? "present" : "recycled";
          } catch { continue; }
        }
        return "absent";
      };
      /**
       * 发出一次宿主 close 请求，并用 watchdog 封顶。返回 "resolved" | "rejected" | "timeout"。
       *
       * 宿主 Promise 不可取消：超时之后它仍可能迟到 resolve / reject。这里用一次性的 settled 闸门把
       * 迟到结果彻底隔离——它既不释放租约、也不清理任何归属，只让这一次调用安静地结束；同一个 tab 在
       * 隔离窗（SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS）内绝不会再收到第二次 close。
       */
      const requestSidebarTabClose = (tabId) => new Promise((resolve) => {
        let settled = false;
        let timer = null;
        const finish = (outcome) => {
          if (settled === true) return;
          settled = true;
          if (timer !== null) {
            try { globalThis.clearTimeout?.(timer); } catch { /* 清理失败不影响结果。 */ }
          }
          resolve(outcome);
        };
        try {
          timer = typeof globalThis.setTimeout === "function"
            ? globalThis.setTimeout(() => finish("timeout"), SIDEBAR_TAB_CLOSE_WATCHDOG_MS)
            : null;
        } catch { timer = null; }
        let result = null;
        try {
          // close() 可同步抛错；结算前不能删掉来源，否则失败 tab 会被当成手动 tab 而永不重试。
          result = closeSidebarResource.call(sidebarRight, tabId);
        } catch {
          finish("rejected");
          return;
        }
        Promise.resolve(result).then(() => finish("resolved"), () => finish("rejected"));
      });
      /**
       * 等待一个竞争租约结算，最多等 timeoutMs；超时返回 false（绝不无限 await）。
       *
       * 手动单项与批量关闭共用这条等待：宿主的 Promise 可能永不 settle，没有上限就会把用户的点击
       * 永久挂在一次与它无关的宿主调用上。
       */
      const waitForSidebarCloseLease = (leaseToken, timeoutMs) => new Promise((resolve) => {
        let done = false;
        let timer = null;
        const finish = (value) => {
          if (done === true) return;
          done = true;
          if (timer !== null) {
            try { globalThis.clearTimeout?.(timer); } catch { /* 同上。 */ }
          }
          resolve(value);
        };
        try {
          timer = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout(() => finish(false), timeoutMs) : null;
        } catch { timer = null; }
        Promise.resolve(leaseToken.wait()).then(() => finish(true), () => finish(true));
      });
      /**
       * 登记一条「close 请求已经发出、等待 inventory 验证」记录，并让租约保持在验证窗口里。
       *
       * 记录随来源账本同层共享：重挂载后的新实例继续采样、继续收口；租约被它持有，因此下一轮同步
       * 绝不会为同一个 tab 再发第二次 close。attemptToken 与 manual 决定验证成功后如何收口预算与来源。
       */
      const beginSidebarCloseVerification = (lease, tabId, verify) => {
        const entry = {
          sessionId: sidebarSessionId,
          rootSessionId,
          tabId,
          address: verify?.address ?? null,
          attemptToken: verify?.attemptToken ?? null,
          manual: verify?.manual === true,
          /**
           * 这次关闭出发时看到的 split 意图身份（不可复用令牌，见 sidebarSplitIntentRef）。
           *
           * 收口时只有当前意图**仍然是这一份**才允许取消它：这次关闭可能在验证窗口里跨越一次
           * 面板重挂载或用户/Auto 的新一次打开，按 key 无条件取消会把同 key 新 generation 的
           * split/open 事务一起掐掉（右栏从临时 50% 掉回、新 pane 的打开失去归属）。
           */
          splitIntentToken: verify?.splitIntentToken ?? null,
          misses: 0,
          deadline: Date.now() + SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS,
          lease,
        };
        sidebarAutoCloseVerificationsRef.current.set(verify.key, entry);
        trimAutoKeyMap(sidebarAutoCloseVerificationsRef.current, true);
        lease.hold("verifying", entry.deadline);
        return entry;
      };
      /**
       * verified-closed / verified-recycled 的唯一收口点：删除 record、按令牌结算 attempt、撤销
       * origin（手动则登记抑制）、清掉冷却与验证记录，最后归还租约并**带上原因**（见 reason 参数）。
       *
       * 两种证据走同一条收口：连续两次读不到这个**精确 tabId**，或连续两次读到这个 id 已经被另一个
       * 资源复用（地址不一致）——后者说明旧 tab 已经消失、这个 id 不再属于我们，同样不能再关。
       * 但两者的**租约结算原因必须不同**（"closed" vs "recycled"）：等待者可能是另一个 key 的关闭，
       * 它只能用自己的地址证据复核，绝不能把「这个 id 被别人回收了」当成「我那个 tab 已经关掉」。
       *
       * 记录只在它的 tabId 与本次验证完全一致时才删除：旧代次的验证绝不能删掉新 tabId 的 record。
       */
      const finishVerifiedSidebarClose = (key, entry, reason) => {
        const records = sidebarTabRecordsRef.current;
        const record = records.get(key);
        const scopedRecord = record !== undefined
          && record.sessionId === sidebarSessionId
          && record.rootSessionId === rootSessionId
          ? record
          : undefined;
        /**
         * (key, tabId, attemptToken) 一致性闸门：这次验证只对「它自己关闭的那个 tabId」有收口权。
         * 宿主换过 tabId 时（旧 tab 消失、同一个资源换成新 tab），旧验证只能归还自己的租约并清理
         * 自己那一笔令牌对应的预算，绝不删除新 generation 的 record / origin / 冷却。
         */
        const sameTab = scopedRecord !== undefined && scopedRecord.tabId === entry.tabId;
        /**
         * 分栏事务的收口只认**这次关闭出发时看到的那一份意图**（不可复用令牌逐对象相等）：
         * record 可能已被记录同步层删掉，但这次关闭确实发生了，事务必须收口，否则右栏会一直停在
         * 临时 50%。反过来，意图已经被新 generation 取代时（用户/Auto 重新打开同一个资源）绝不取消
         * 它——旧 close 的迟到收口取消一个新事务，会让右栏从 50% 掉回、新 pane 的打开失去归属。
         */
        cancelPendingSidebarSplitOfClose(key, entry.splitIntentToken);
        if (sameTab === true) {
          records.delete(key);
          if (entry.attemptToken === null || entry.attemptToken === undefined) clearAutoCloseAttempt(key);
          else settleAutoCloseAttempt(key, { kind: "close", attemptToken: entry.attemptToken });
          sidebarAutoCloseCooldownsRef.current.delete(key);
          sidebarAutoOriginRef.current.delete(key);
          if (entry.manual === true && entry.address !== null && entry.address !== undefined) {
            sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
            trimAutoKeyMap(sidebarAutoSuppressedRef.current);
            // 手动关闭：抑制语义同步落到持久归属标记上（刷新之后同样绝不再当 auto）。
            writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
          } else if (entry.address !== null && entry.address !== undefined) {
            // 验证关闭成功 / inventory 已证明这个 tabId 不在：归属标记同步删除，绝不残留陈旧 auto。
            deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, "verified-closed");
          }
        } else if (entry.attemptToken !== null && entry.attemptToken !== undefined) {
          // tabId 已经不属于这次验证：只按令牌结算本次动作自己的那一笔预算（owner 已被后来者替换时
          // settleAutoCloseAttempt 会自动放弃）。
          settleAutoCloseAttempt(key, { kind: "close", attemptToken: entry.attemptToken });
        }
        sidebarAutoCloseVerificationsRef.current.delete(key);
        // 结算原因随租约带给等待者：recycled 与 closed 对**别人**的证明力完全不同（见 token.result）。
        entry.lease?.release?.(reason === "recycled" ? "recycled" : "closed");
        bump((value) => value + 1);
      };

      /**
       * 关闭请求的验证链（每轮同步跑一次）：
       * 1. 隔离窗到期的迟到结果租约：只归还自己那一把（不碰 record / origin / attempt）；
       * 2. 验证记录：只有连续两次可读 inventory 都读不到这个**精确 tabId**、或读到这个 id 已经被
       *    **另一个资源**复用（contentId 与本 key 的资源地址不一致）才算 verified-closed；
       *    present 重置缺失计数并保留归属；unreadable 不推进缺失计数（读不到证明不了任何事）；
       *    超过验证窗口仍未验证则释放租约、保留 record/origin/attempt，由下一次同步决定是否重试。
       */
      const verifyPendingSidebarCloses = () => {
        const now = Date.now();
        for (const [, token] of sharedSidebarTabCloseInFlight) {
          if (token.state !== "quarantined") continue;
          if (token.holdUntil > now) continue;
          // 隔离窗到期只说明那次请求**从未被验证**（watchdog 超时）：结算原因必须是 timeout，
          // 绝不能是 closed——等待者据此知道「什么都没被证明」，需要自己用地址证据复核。
          token.release?.("timeout");
        }
        const verifications = sidebarAutoCloseVerificationsRef.current;
        for (const [key, entry] of [...verifications]) {
          if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
          // 地址证据来自这次关闭自己那个 key 的资源地址（批量入口没有 key，地址为 null ⇒ 不比较地址）。
          const presence = sidebarTabPresenceInInventory(entry.tabId, entry.address);
          if (presence === "present") entry.misses = 0;
          else if (presence !== "unreadable") entry.misses += 1;
          /**
           * absent 与 recycled 都独立证明「这个精确 tabId 已经不再承载我们的资源」，因此可以混用同
           * 一个缺失计数：两种证据各采一次同样满足「连续两次」的确认要求（unreadable 绝不推进计数）。
           */
          if (presence !== "present" && presence !== "unreadable"
            && entry.misses >= SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS) {
            // 结算原因按证据分型：recycled（id 已被别的资源占用）绝不能对外冒充 verified-closed。
            finishVerifiedSidebarClose(key, entry, presence === "recycled" ? "recycled" : "closed");
            continue;
          }
          if (now >= entry.deadline) {
            // 验证超时：释放租约与验证记录，**保留** record / origin / attempt。
            verifications.delete(key);
            entry.lease?.release?.("timeout");
            // 同一批微任务级联里绝不立刻重选同一个 key（下一轮外部同步才重试）。
            sidebarAutoFailedKeysRef.current.add(key);
          }
        }
      };

      /**
       * 关闭一个 tab 的唯一执行入口（单 tab 关闭与批量关闭共用），把「租约 + 结算信号 + 有限重试」
       * 全部收在这里。
       *
       * 并发语义由 waitForCompeting 区分：
       * - true（用户触发的手动单项与批量）：同一个 tabId 上已经有一次关闭在途时，等待它结算，然后
       *   **用它自己的期望地址重新探针复核**再决定——结算原因只说明「上一次关闭凭什么结束」，而
       *   这个 tabId 在两次关闭之间完全可能被宿主回收给另一个资源：
       *   · 复核为 present（且地址一致）⇒ 这个 id 此刻仍然是我们要关的那个 tab，才允许一次有限重试；
       *   · 复核为 absent ⇒ 我们的 tab 已经不在，按 verified-closed 收口，绝不再 close；
       *   · 复核为 recycled ⇒ 这个 id 已承载别的资源，按 verified-recycled 收口自己这个 key；
       *   · 复核为 unreadable ⇒ fail-closed，什么都不做；
       *   · 上一次结算原因是 recycled 而**自己又没有期望地址**可复核 ⇒ 一律跳过：别人的
       *     「旧 tab 已消失」对没有地址证据的等待者什么都证明不了（recycled-unverifiable）。
       * - false（Auto 自动同步）：遇到在途关闭立刻返回 contended 让位，绝不 await、绝不排队重试
       *   （调用方负责回退本轮 closeAttempts/预留并维持防微任务循环屏障）。
       *
       * status 语义（只有 verified-closed / closed / verified-recycled 才允许调用方收口归属）：
       * - verified-closed：preflight 或验证链用**精确 tabId** 的 inventory 证据证明这个 tab 已经不在；
       * - verified-recycled：这个 tabId 已经被宿主回收给**另一个资源**（条目暴露的资源地址与本次
       *   关闭那个 key 的地址不一致）⇒ 旧 tab 已经消失、新 tab 不是我们的。close **一次都没有发出**，
       *   但结论与 verified-closed 等价：这个 key 的 record / 预算 / 冷却必须收口，且绝不允许重试；
       * - request-resolved-unverified：宿主 close 已经 resolve，但仍在验证窗口里（记录/来源/计数全部保留）；
       * - failed：宿主 close 同步抛错或 rejected（请求真的发出过，绝不回滚 count）；
       * - timeout：watchdog 超时（同样不回滚 count，租约进入迟到隔离窗）；
       * - contended / contended-timeout：有人在关，本次不发 / 等待竞争租约超过同一个 10 秒上限；
       * - recycled-unverifiable：上次结算是 recycled，而本次等待者没有地址证据可复核 ⇒ 跳过
       *   （既不关闭也不收口归属），等下一次带地址证据的动作或同步链自行收口；
       * - unreadable：inventory 不可读（或地址不可证伪时保持既有语义），fail-closed 不发；
       * - stale：等待期间 surface 换代；unavailable：宿主没有 close 能力。
       */
      const closeSidebarTabWithLease = async (tabId, options) => {
        if (closeSidebarResource === null) return { status: "unavailable", closed: false };
        const waitForCompeting = options?.waitForCompeting === true;
        // verify：close 请求 resolve 之后的验证上下文 { key, address, attemptToken, manual }。
        const verify = options?.verify ?? null;
        let lease = acquireSidebarTabClose(tabId);
        if (lease === null) {
          if (waitForCompeting !== true) return { status: "contended", closed: false };
          const competing = sidebarTabCloseLeaseOf(tabId);
          // 探测与读取之间没有 await，因此这里理论上不可达；真出现只可能是锁被别的实现动过，
          // fail-closed 让位总好过在拿不到结算信号的情况下盲发一次 close。
          if (competing === null) return { status: "contended", closed: false };
          // 等待结算：同一个 10 秒 watchdog 上限，绝不无限 await（宿主 Promise 不可取消）。
          const settledInTime = await waitForSidebarCloseLease(competing, SIDEBAR_TAB_CLOSE_WATCHDOG_MS);
          if (settledInTime !== true) return { status: "contended-timeout", closed: false };
          /**
           * 等待可能跨越一次组件重挂载、root / sidebar session 切换，或同一个实例的 A→B→A 快速
           * 回返：那次关闭属于旧 surface，本次动作绝不在新 surface 上继续（旧 tab 的归属由它自己
           * 那一轮的链路与既有同步器结算）。批量入口在 await 之后也有同一道复核，这里是共享执行
           * 入口里的等价收口；判据含不可复用的 surface 令牌，因此「切走又切回同一组值」同样作废。
           */
          if (sidebarSurfaceStillCurrent() !== true) return { status: "stale", closed: false };
          /**
           * 等待者绝不直接采信别人的结算结论（旧实现只读布尔 ok），一律用自己的期望地址重新探针：
           *
           * 结算原因只回答「上一次关闭凭什么结束」：closed / recycled / failed / timeout。它**不**回答
           * 「此刻这个 tabId 是不是我那个 tab」——两次关闭之间，宿主完全可能把这个已经释放的 id 回收给
           * 另一个资源。跨 key 交错时（A 的 verified-recycled 与 T 的等待落在同一个 tabId 上），把 A 的
           * 「旧 tab 已消失」当成 T 自己的关闭完成，就会让 T 误删自己的 record / 来源 / 抑制，或者相反：
           * 对别人复用的新 tab 再发一次 close。地址复核是唯一的防线。
           */
          const settledReason = competing.result;
          if (settledReason === "recycled"
            && (verify?.address === null || verify?.address === undefined)) {
            // 没有地址证据的等待者遇到 recycled：既不关闭也不收口——跳过这一次，绝不盲从别人的结论。
            return { status: "recycled-unverifiable", closed: false };
          }
          /**
           * 只有当前 inventory 明确证明同一个 tabId 仍存在**且仍然是我们要关的那个资源**（条目暴露的
           * contentId 与本次关闭的地址一致），才允许这一次有限重试。
           * - recycled：这个 id 已经被宿主回收给别的资源 ⇒ 旧 tab 已经消失，绝不重试（绝不关别人的 tab），
           *   按「旧 tab 已消失」结算，调用方据此收口自己这个 key 的记账；
           * - absent：同上（用户的关闭意图已经达成）；unreadable：fail-closed。
           */
          const presence = sidebarTabPresenceInInventory(tabId, verify?.address ?? null);
          if (presence === "unreadable") return { status: "unreadable", closed: false };
          if (presence === "recycled") return { status: "verified-recycled", closed: false };
          if (presence !== "present") return { status: "verified-closed", closed: true };
          lease = acquireSidebarTabClose(tabId);
          // 已经有别人接手（或又一次在途）：有限重试到此为止，绝不排队等第二次。
          if (lease === null) return { status: "contended", closed: false };
        }
        /**
         * 调用 close 之前的 preflight：必须用**当前** openTabs inventory 精确确认目标 tabId，并且
         * ——只要调用方给了这个 key 的资源地址——确认这个 id 此刻仍然承载**同一个资源地址**。
         *
         * 这是本插件唯一一次在副作用之前回答「这仍然是我们决定要关的那个 tab 吗」的地方：
         * - present：可以调用 close；
         * - absent：精确证据上的 verified-closed；
         * - recycled：id 已被宿主回收给别的资源（旧 tab 已经消失）⇒ 绝不调用 close（那会关掉别人的
         *   tab），按「旧 tab 已消失」结算并让调用方收口本 key 的 record / 预算 / 冷却；
         * - unreadable：一律 fail-closed（不调用 close、不清理归属），绝不把「读不到」当成「没有」。
         */
        const preflight = sidebarTabPresenceInInventory(tabId, verify?.address ?? null);
        /**
         * 手动路径在**读面缺失**（旧宿主没有 openTabs）时的兼容：没有验证证据，但用户明确要求关闭——
         * 照旧调用 close 并按历史语义收口，绝不因为读面缺失把用户的关闭意图丢掉。
         * 自动路径没有这条退路：没有精确证据时 fail-closed（不调用 close、不清理归属）。
         */
        const manualWithoutEvidence = preflight === "unreadable" && verify !== null && verify.manual === true;
        if (preflight === "unreadable" && manualWithoutEvidence !== true) {
          // 什么都没发出、也什么都没证明：结算原因只能是 failed（等待者必须自己复核）。
          lease.release("failed");
          return { status: "unreadable", closed: false };
        }

        if (preflight === "absent") {
          lease.release("closed");
          return { status: "verified-closed", closed: true };
        }
        if (preflight === "recycled") {
          /**
           * 地址证据证明这个 tabId 已经换了资源：旧 tab 已经消失。绝不调用 close——重试一次就会把
           * 别人（复用了这个 id 的新 tab）关掉。
           *
           * 租约必须按**原因**归还（"recycled"），而不是布尔 ok=true：这个结论只对「本次关闭那个
           * key」有效（旧 tab 已消失），对同一个 tabId 上**别的 key** 的等待者完全没有证明力——
           * 「id 被复用」恰恰意味着这个 id 现在承载的不是我们的资源。等待者一律用自己的期望地址重新
           * 探针复核后再决定（见 closeSidebarTabWithLease 的等待分支），没有地址证据的一方直接跳过。
           *
           * 本次调用自己的 key 不受这条归还值影响：调用方按 verified-recycled 收口自己的 record /
           * 预算 / 冷却（见 handleSidebarAction），并且同样过 (key, tabId) 一致性闸门。
           */
          lease.release("recycled");
          return { status: "verified-recycled", closed: false };
        }
        const outcome = await requestSidebarTabClose(tabId);
        if (outcome === "rejected") {
          // 请求真的发出去过并失败：租约按未验证归还（failed），绝不回滚 count（那会突破三次快速上限）。
          lease.release("failed");
          return { status: "failed", closed: false };
        }
        if (outcome === "timeout") {
          // 迟到结果隔离窗：租约保留到隔离窗结束（由同步链路归还），期间绝不再发第二次 close。
          lease.hold("quarantined", Date.now() + SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS);
          return { status: "timeout", closed: false };
        }
        /**
         * resolve 只代表请求完成：登记验证记录并**保留租约**，由后续同步按精确 inventory 收口。
         * 没有可验证的 key（调用方没有 Auto 记账，例如批量入口）时按未验证归还租约，绝不当作已关闭。
         */
        if (manualWithoutEvidence === true) {
          // 无 inventory 读面的手动关闭：历史语义（用户意图优先），按「已关闭」结算并归还租约。
          lease.release("closed");
          return { status: "closed", closed: true };
        }
        if (verify === null || verify.key === null || verify.key === undefined) {
          // 没有可验证的 key（批量入口）：请求完成了但**什么都没被证明** ⇒ failed，等待者自己复核。
          lease.release("failed");
          return { status: "request-resolved-unverified", closed: false };
        }

        beginSidebarCloseVerification(lease, tabId, verify);
        return { status: "request-resolved-unverified", closed: false };
      };
      /**
       * 清理已经离开当前快照的复合键（来源与抑制两个集合），避免长期泄漏。
       *
       * 只清理当前 surface 的键：别的 session/root 的资源不在这一份快照里，无法判定是否仍存在。
       * 本轮已经选中的候选键必须保留——它正要被关闭，删掉记账会让这次关闭失去来源身份。
       */
      const cleanupAutoSidebarKeys = (known, actingKey) => {
        for (const map of [sidebarAutoOriginRef.current, sidebarAutoSuppressedRef.current]) {
          for (const [key, entry] of map) {
            if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
            if (key === actingKey) continue;
            if (known.has(entry.address) === true) continue;
            /**
             * 快照里暂时缺了这个地址，但 key 上仍有活动记账（record / 在途打开 / pending / 验证 / 冷却）：
             * 绝不删除 origin——否则冷却到期后就再也关不掉这个 tab（快照缺项不等于宿主里没有）。
             */
            if (sidebarAutoCloseKeyIsActive(key) === true) continue;
            map.delete(key);
            clearAutoCloseBudget(key);
          }
        }
        // 预留同样要清理，但**在途动作自己那一条绝不能被清理**：它的 finally 才是唯一的释放点，
        // 提前删掉会让同一条动作在收尾时把后来者的预留一起删掉。
        for (const [key, entry] of sidebarAutoReservationRef.current) {
          if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
          if (key === actingKey) continue;
          if (known.has(entry.address) === true) continue;
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          sidebarAutoReservationRef.current.delete(key);
        }
      };
      /**
       * 回收「Auto 打开已经发出、tabId 始终没落地」的共享来源**占位**（缺陷 2）。
       *
       * 为什么必须有这一步：占位同时承担两件事——(a) autoOpenCandidate 靠 origin.has(key) 跳过
       * 「本次运行已经为它打开过」，(b) 它占着归属账本的容量槽位（128）。宿主始终没落地该 tab 时，
       * 这两件事都会变成长期伤害：资源明明还在 running，Auto 却既不再打开、又占着名额，一批这样的
       * 占位就能把账本占满，让 Auto 再也开不出任何新 tab——只有整页刷新（内存账本归零）才能恢复。
       *
       * 判据（只在期限到达之后才动，期限见 SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS）：
       * - 本 scope：先按当前 inventory **精确核对**。地址上仍然没有 tab ⇒ 释放占位，让下一轮外部同步
       *   重新选出这个候选（一次有界重试：至少间隔一个 TTL 窗口，同一批微任务里还有失败屏障兜底）；
       *   地址上已经有 tab ⇒ 同样释放（归属判定已经由 record / 收养路径接管，占位不再有意义）；
       *   **inventory 读不出来 ⇒ 一律保留（fail-closed）**：读不到既不证明存在、也不证明不存在，
       *   绝不当成「没有 tab」去释放。
       * - 别的 scope：占位本身不是归属证据（tabId 为空），释放它不会授权任何关闭；而对方候选选择
       *   必须在发出 openResource 之前重新核对它自己的 inventory，因此也不可能因此开出重复 tab。
       *   为免打断另一个 surface 仍在进行中的打开，这里用 4 倍期限（FOREIGN_TTL）。
       *
       * 在途动作（pending / 本地 opening）绝不释放：那两种状态说明这次打开还在被观察，提前释放会让
       * 尾随同步立刻再开一次。
       */
      const sweepAutoOpenPlaceholders = (running) => {
        const originMap = sidebarAutoOriginRef.current;
        if (originMap.size === 0) return;
        const now = Date.now();
        for (const [key, entry] of [...originMap]) {
          // 已落地的条目（tabId 非空）由既有收口路径负责（verified-closed / inventory-absent /
          // tab-recycled / resource-running），TTL 绝不去碰它们。
          if (sidebarAutoOriginTabIdOf(entry) !== null) continue;
          const age = now - sidebarAutoOriginWrittenAtOf(entry);
          const scoped = entry.sessionId === sidebarSessionId && entry.rootSessionId === rootSessionId;
          if (scoped !== true) {
            if (age < SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS) continue;
            originMap.delete(key);
            recordSidebarAutoDiag({ kind: "ownership", event: "delete", reason: "placeholder-foreign-expired", key: sidebarAutoKeyDigest(key) });
            continue;
          }
          if (age < SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS) continue;
          if (sidebarTabPendingRef.current.has(key) === true) continue;
          if (sidebarTabOpeningRef.current.has(key) === true) continue;
          const state = sidebarResourceTabStateOf(entry.address);
          if (state.readable !== true) {
            // fail-closed：读不到 inventory 时保留占位，绝不把「读不到」当成「没有 tab」。
            recordSidebarAutoDiag({ kind: "ownership", event: "keep", reason: "placeholder-unreadable", key: sidebarAutoKeyDigest(key) });
            continue;
          }
          originMap.delete(key);
          recordSidebarAutoDiag({
            kind: "ownership",
            event: "delete",
            reason: state.tabId === null
              ? (running !== null && running !== undefined && running.has(entry.address) === true
                ? "placeholder-retry"
                : "placeholder-released")
              : "placeholder-superseded",
            key: sidebarAutoKeyDigest(key),
          });
        }
      };
      /**
       * 放行一个自动动作。
       *
       * 复用用户点击的同一条入口（handleSidebarAction + origin=auto）：同一把 pending 锁、同一段
       * split 事务、同一套「用真实 tabId 关闭」的记录语义，因此自动路径不存在第二套打开/关闭实现。
       * 动作收尾后才重新推进同步，下一个候选（或清理）由那条链路继续。
       */
      const launchAutoSidebarAction = (candidate) => {
        sidebarAutoBusyRef.current = true;
        /**
         * 自动打开/自动关闭决策的诊断记录（只记结论与 key 摘要，绝不记提示词/正文/令牌）：
         * 候选选中时记一条 launch，结算/失败时再记一条，便于事后离线核对「某次构建之后这个 tab 为什么
         * 没被收回去」。
         */
        recordSidebarAutoDecision("launch", candidate, "candidate");
        void Promise.resolve()
          // candidate 作为自动动作上下文（kind/epoch/预留）传入：动作必须在每个 await 之后
          // 复核它是否仍然有效，并在收尾时无条件释放预留（见 handleSidebarAction）。
          .then(() => handleSidebarAction(candidate.key, candidate.address, SIDEBAR_TAB_ORIGIN_AUTO, candidate))
          .then(
            () => { recordSidebarAutoDecision("settle", candidate, "ok"); },
            (error) => {
              /* 打开/关闭失败只影响这一次动作：状态由既有记录与重试记账负责。 */
              recordSidebarAutoDecision("settle", candidate, "failed", sidebarBoundedText(error === null || error === undefined ? undefined : error.message));
            },
          )
          .then(() => {
            sidebarAutoBusyRef.current = false;
            /**
             * 尾随同步只用来推进「下一个候选」。它必须带着级联标记执行：这一轮里失败过的 key
             * 不会被重新选中，因此「失败 → 撤销预留 → 立刻重选」不在微任务里自转（见
             * sidebarAutoFailedKeysRef）。真正的重试留给下一个外部同步轮。
             *
             * 但这次推进同样只能由**仍然有效**的那一轮 surface 发起：动作的 await 可能跨越一次组件
             * 重挂载 / root 切换，此时本闭包的 mountedRef 已经是 false（旧实例的挂载 effect 已清理），
             * 而它手里的旧快照与共享 Auto 来源账本不是一回事——旧闭包的 syncSidebarTabs() 会把新
             * Panel 刚写入的其它 Auto 来源当成「已经离开旧快照」清掉（新 Panel 随后再也认不出自己
             * 打开过的 tab），并且「旧实例入口放弃动作 → 尾随同步又选中同一个候选」会形成不让出宏
             * 任务的微任务自转（页面被拖住）。因此这里与 handleSidebarAction 的收尾闸门用同一条判据
             * （含不可复用的 surface 令牌，重挂载与 A→B→A 都算失配）：surface 失配时只归还本实例的
             * 级联闸门，绝不调用旧闭包的同步；新 Panel 的下一轮外部同步会按真实 inventory 继续推进
             * 候选与清理。
             */
            if (sidebarSurfaceStillCurrent() !== true) return;
            sidebarAutoCascadeRef.current = true;
            try {
              // 用引用取最新一轮渲染的同步器（与 observer/轮询同一写法），绝不复用当前闭包。
              sidebarTabSyncRef.current?.();
            } finally {
              sidebarAutoCascadeRef.current = false;
            }
          });
      };
      /**
       * 观察到「资源已经明确空闲」时清除这个地址的 manual 抑制（内存 + 持久两层）。
       *
       * 清除时机只按**资源状态**判定（onIdle）：
       * - 资源仍在运行（在 running 集合里）⇒ 一律保留：这正是「刷新时正在运行、用户已手动关闭的 tab」
       *   的形状，清掉就等于把用户的关闭又撤销一次（P1-B）；
       * - 资源已明确空闲（ready）⇒ 清除：这一轮运行已经结束，用户当时的关闭意图不再需要跨运行保留，
       *   下一次运行必须能正常自动打开（否则一次手动关闭就永久关掉了这个地址的自动行为）；
       * - 快照里既看不到运行也看不到空闲（暂时缺项 / 状态 unknown）⇒ 一律保留：那既不证明在运行、
       *   也不证明已结束，按 fail-closed 不动。空闲集合由 idleSidebarResourceAddresses 给出，它用的是
       *   **严格**证据规则（sidebarNodeIsIdleReady），因此轻量快照下虽然 unknown 节点也会显示在空闲
       *   分组里（修复 B 的显示从宽），它们的 manual 抑制仍然一律保留、绝不被这里清掉。
       *
       * 只清 manual：
       * - 内存层（sidebarAutoSuppressedRef）与持久层是同一个语义的两份存储，必须一起清，否则刷新前的
       *   内存抑制会继续挡住下一次运行；
       * - **auto 标记绝不在这里清除**（origin !== manual 直接跳过）：一个正在等待收口的 auto tab 一旦
       *   在空闲观察里被降级成 manual，就再也不会被自动收回——auto 仍只由 verified-close /
       *   inventory-absent / tab-recycled 三条路径清除（见 deleteSidebarAutoOwnership 的说明）。
       *
       * 限项：只遍历当前 root 的空闲地址（快照已有），因此不会跨 scope 误清别的 root / session 的键
       * （键由当前 sidebar session + root + 地址现算）。
       */
      const clearManualSuppressionOfIdleResources = (idle) => {
        if (idle === null || idle === undefined || idle.size === 0) return;
        for (const address of idle) {
          const key = sidebarTabKey(sidebarSessionId, rootSessionId, address);
          if (sidebarAutoSuppressedRef.current.has(key) === true) sidebarAutoSuppressedRef.current.delete(key);
          const persisted = readSidebarAutoOwnershipEntry(sidebarSessionId, rootSessionId, address, { quiet: true });
          if (persisted === null || persisted.origin !== SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) continue;
          deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, address, "resource-idle", { manual: true });
        }
      };
      /**
       * 第二阶段：Auto（自动打开运行中的子代理侧栏）同步。
       *
       * 顺序固定为「先关后开」，并且只在有属于当前 root 的真实快照时动作：
       * 1. 关闭：Auto 亲手打开过的资源一旦不在运行中集合里，就用**已确认记录里的真实 tabId** 走
       *    既有 handleSidebarAction 关闭路径（绝不猜 tabId、绝不调用批量关闭）；
       * 2. 打开：运行中、尚未打开、且没有被用户手动关闭抑制的资源走既有打开路径；
       * 3. 清理：把已经离开当前快照的复合键从来源/抑制集合里移除。
       *
       * 开关关闭时不做任何自动 open/close（历史行为逐字节不变），已打开的 tab 交由用户手动处理；
       * 清理阶段与开关无关，它只维护插件自己的记账，不触碰宿主。
       */
      const syncAutoSidebarTabs = () => {
        const source = snapshot;
        // 没有快照（首次加载 / 读取失败）时没有「谁在运行」的证据：既不打开也不关闭。
        if (source === null || source === undefined) return;
        // root 切换瞬间旧快照可能仍在 state 里：只有属于当前 root 的快照才能决定动作。
        if (text(source.rootSessionId, null) !== rootSessionId) return;
        const known = knownSidebarResourceAddresses();
        const running = runningSidebarResourceAddresses();
        const enabled = autoOpenEnabled();
        /**
         * 先回收过期的打开占位（缺陷 2）：它只维护插件自己的记账、绝不触碰宿主，因此与 Auto 开关无关
         * （与下面的记账清理同一条边界）。放在候选选择之前，被回收的容量当轮就能重新用上。
         */
        sweepAutoOpenPlaceholders(running);
        /**
         * manual 抑制的清除只由「明确空闲」驱动，且与 Auto 开关无关（与上面的记账清理同一条边界：
         * 它只维护本插件自己的标记，绝不触碰宿主）。先清再选候选：清掉之后这一轮的开候选判据读到的
         * 就是最新状态；空闲地址本来就不在 running 集合里，因此这一步不会为本次运行重新打开任何 tab。
         */
        clearManualSuppressionOfIdleResources(idleSidebarResourceAddresses(sidebarIdleChildren()));
        let candidate = null;
        if (enabled === true && sidebarAutoBusyRef.current !== true) {
          candidate = autoCloseCandidate(running) ?? autoOpenCandidate(running);
        }
        cleanupAutoSidebarKeys(known, candidate === null ? null : candidate.key);
        if (candidate === null) return;
        launchAutoSidebarAction(candidate);
      };

      /**
       * 自动动作是否仍然有效：Auto 仍开启、动作代次未变、面板仍挂在同一个 root / sidebar session 上。
       *
       * 这是「关闭 Auto 取消在途打开」的判据：Auto getter 每次现读（权威读面），代次在开关变化时
       * 递增，surface 身份用与 handleSidebarAction 入口相同的三个 ref 复核。任一项不成立，那次自动
       * 动作一律放弃副作用。
       */
      const autoActionStillValid = (context) => {
        if (context === null || context === undefined) return false;
        if (autoOpenEnabled() !== true) return false;
        if (sidebarAutoEpochRef.current !== context.epoch) return false;
        return mountedRef.current === true
          && currentRootRef.current === rootSessionId
          && currentSidebarSessionRef.current === sidebarSessionId;
      };
      /**
       * 撤销一次自动动作的在途记账（Auto 关闭 / 代次过期 / 手动接管 / 失败路径共用）。
       *
       * 三件事缺一不可：
       * 1. 收口这次动作开出的 split 事务：否则右栏会停在事务的临时 50%，直到 15 秒 deadline 才回落；
       * 2. 删掉这个 key 的在途打开记录：这次打开没有发出，不能让后续同步把它当成「还没确认的打开」；
       * 3. 释放预留：失败绝不等于「已经打开过」，下一次同步必须能重新选中这个资源。
       * 来源标记只在 openResource 成功发出时才存在，因此这里不删除它（关闭类动作被撤销后，
       * 那个 tab 仍然属于 Auto，开关重新打开后仍可被自动回收）。
       */
      const abandonAutoSidebarAction = (key, context) => {
        if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("auto-abandoned");
        sidebarTabOpeningRef.current.delete(key);
        sidebarAutoReservationRef.current.delete(key);
        releaseAutoCloseAttempt(key, context);
      };
      /**
       * 回退候选选择时预支的那一次自动关闭重试（动作在真正调用 close 之前被撤销时调用）。
       *
       * 只有**这条预算当前的所有者**才允许回滚：owner 账本里登记的必须与本次动作出发时拿到的是
       * 同一份不可复用令牌。旧代次的迟到收尾（重挂载、同一个实例 A→B→A、Auto 关闭取消）完全可能
       * 在新代次已经为同一个 key 重新预支预算之后才跑到这里——令牌不匹配时一律 fail-safe：绝不写、
       * 绝不删共享 attempts，否则新代次的预算会被删掉（等于复活），同一个 key 的实际 close 次数就会
       * 突破 3 次上限。owner 不存在或已被限容淘汰时同样 fail-safe（宁可白烧一次预算，也绝不动可能
       * 属于后来者的计数）。
       */
      const releaseAutoCloseAttempt = (key, context) => {
        if (context === null || context === undefined || context.kind !== "close") return;
        const owners = sidebarAutoCloseAttemptOwnersRef.current;
        const token = context.attemptToken;
        if (token === null || token === undefined || owners.get(key) !== token) return;
        const attempts = sidebarAutoCloseAttemptsRef.current;
        // owner 还在、预算已经不在了（被限容淘汰或被别的收口路径清掉）：只清掉自己这一份 owner。
        if (attempts.has(key) !== true) {
          owners.delete(key);
          return;
        }
        if (context.attemptsBefore === 0) attempts.delete(key);
        else {
          attempts.set(key, context.attemptsBefore);
          // 回退同样要限容：这一步是 set 的第二条路径，少了它这个 Map 就可能在长生命周期里无界增长。
          trimAutoKeyMap(attempts);
        }
        // 回滚完成即交还所有权：此后同一个 key 的新预支由新的令牌持有，旧令牌再也回不来。
        owners.delete(key);
      };
      /**
       * 自动动作在副作用之前必须让位的「手动接管」状态：
       * - "close"：用户在同一个 key 上留下过关闭意图——Auto 绝不能在关闭意图之后再打开一个 tab；
       * - "open"：用户手动要求打开这个资源——打开照常发出，但最终 tab 必须记成 manual 来源；
       * - null：没有手动接管。
       */
      const autoTakeoverStateOf = (key) => {
        const intent = sidebarManualIntentOf(key);
        if (intent === undefined) return null;
        return intent.intent === "close" ? "close" : "open";
      };
      /**
       * 记录一次「在途动作期间」的用户手动意图。
       *
       * 触发点只有两个（用户点击落在一个已被 pending 锁或未落地打开占用的 key 上）：意图方向按
       * 点击那一刻的按钮语义判定——已经有记录（<<）表示要关闭，没有记录（>>）表示要打开，
       * 绝不按动作在途时的中间态猜方向。方向判定与 handleSidebarAction 的分支条件同源。
       */
      const recordSidebarManualIntent = (key, resourceAddress) => {
        const record = sidebarTabRecordsRef.current.get(key);
        const scoped = record !== undefined
          && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
        sidebarManualIntentRef.current.set(key, {
          sessionId: sidebarSessionId,
          rootSessionId,
          address: resourceAddress,
          intent: scoped ? "close" : "open",
        });
      };
      /**
       * 结算一个 key 上的手动意图（在途动作收尾后，以及同步的兜底扫描里调用）。
       *
       * 手动恒优先，但**只按当下的真实状态结算**，绝不盲目重放那次点击：
       * - 还有动作在途（pending）或打开尚未落地：这一轮什么都不做，等下一次收尾再结算；
       * - 「打开」：已经开着就把来源改回 manual（Auto 不再管它）；还没开出才补发一次**手动**打开，
       *   走与点击完全相同的入口（唯一区别是 origin=manual，因此后续绝不会被自动关闭）；
       * - 「关闭」：有精确 tabId 时走同一入口关闭并登记抑制；没有可关闭的 tab 时只登记抑制，
       *   绝不为了「执行这次关闭」而先打开一个 tab。
       */
      const applyPendingManualIntent = (key) => {
        const entry = sidebarManualIntentOf(key);
        if (entry === undefined) return;
        // 同一 key 仍有动作在途：它收尾时会再结算一次，绝不在这里并发派发第二个动作。
        if (sidebarTabPendingRef.current.has(key) === true) return;
        const opening = sidebarTabOpeningRef.current.get(key);
        const openingScoped = opening !== undefined
          && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId;
        const record = sidebarTabRecordsRef.current.get(key);
        const recordScoped = record !== undefined
          && record.sessionId === sidebarSessionId && record.rootSessionId === rootSessionId;
        if (entry.intent === "open") {
          if (openingScoped) {
            // 这次打开仍在途：把它的来源改成 manual，落地后就是手动 tab（绝不并发第二次 openResource）。
            opening.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
            sidebarManualIntentRef.current.delete(key);
            return;
          }
          if (recordScoped) {
            // 用户手动打开 = 他重新要这个会话：清除抑制，并把来源收回 manual（Auto 不得再自动关它）。
            record.origin = SIDEBAR_TAB_ORIGIN_MANUAL;
            writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-open");
            sidebarAutoSuppressedRef.current.delete(key);
            sidebarAutoOriginRef.current.delete(key);
            // 手动接管这个 key：未结算的自动关闭预算（含 owner）一并作废，Auto 不得再按旧预算重试。
            clearAutoCloseAttempt(key);
            sidebarManualIntentRef.current.delete(key);
            return;
          }
          sidebarManualIntentRef.current.delete(key);
          void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
          return;
        }
        // intent === "close"
        if (recordScoped) {
          sidebarManualIntentRef.current.delete(key);
          // 手动关闭信号在这里就落持久标记（抑制写入要等验证收口，太晚；手动恒优先必须立刻生效）。
          writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
          void handleSidebarAction(key, entry.address, SIDEBAR_TAB_ORIGIN_MANUAL);
          return;
        }
        if (openingScoped) {
          /**
           * 打开仍在途、此刻没有可精确关闭的 tabId：抑制先登记（用户要的是关闭，Auto 不得重开），
           * 意图保留到它落地或超时——由同一条同步链路再结算一次，绝不在没有 tabId 时猜一个 id 去关。
           */
          sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
          trimAutoKeyMap(sidebarAutoSuppressedRef.current);
          writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
          return;
        }
        // 没有可关闭的 tab：只登记抑制与撤销自动记账，绝不为了「执行关闭」先打开一个 tab。
        sidebarManualIntentRef.current.delete(key);
        sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: entry.address });
        trimAutoKeyMap(sidebarAutoSuppressedRef.current);
        writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
        sidebarAutoOriginRef.current.delete(key);
        // 手动关闭意图接管这个 key：未结算的自动关闭预算（含 owner）一并作废。
        clearAutoCloseAttempt(key);
      };

      /**
       * 右栏 tab 的完整同步入口（挂载 effect / 2.5 秒轮询 / sessions 通知 / observer / 可见性变化
       * 全部只经由它）：先跑既有的记录/库存同步，再跑 Auto 自动同步。
       *
       * 顺序不可颠倒：自动打开必须建立在「库存与在途记录已经结算完」的基础上，否则同一个资源
       * 会被先记录再打开，重复消耗 pane。
       */
      const syncSidebarTabs = () => {
        /**
         * 外部同步轮（挂载 / 2.5 秒轮询 / observer / 可见性变化 / 会话通知）都是新的一轮：自动动作的
         * 失败屏障在这里失效，因此同一个资源仍然可以被重试。自动动作收尾的那条尾随同步例外——它
         * 只是同一批微任务里的推进，不构成「宿主状态可能已经改变」的新证据。
         */
        if (sidebarAutoCascadeRef.current !== true) sidebarAutoFailedKeysRef.current.clear();
        syncSidebarTabRecords();
        // 关闭请求的验证链先跑：上一轮 close 的验证结果必须先收口，候选选择才按真实归属推进。
        verifyPendingSidebarCloses();
        // Auto 开关是渲染输入：设置页保存或面板自身切换后必须重渲染一次（标题栏开关的勾选态）。
        // 与批量签名同一模式：只有真的变化才 bump，空闲轮询绝不产生重渲染。
        const autoNow = autoOpenEnabled();
        if (sidebarAutoSignatureRef.current !== autoNow) {
          sidebarAutoSignatureRef.current = autoNow;
          /**
           * 开关的权威值一变（含关闭）就推进自动动作代次：已经发出、仍在等待 split/layout 的在途
           * 自动动作会在下一次复核时放弃——「关闭 Auto」必须立刻取消还没落地的自动打开，而不是
           * 等它把 tab 打开之后再交给用户手动关。已存在的 tab 不受影响（关闭 Auto 绝不自动关 tab）。
           */
          sidebarAutoEpochRef.current += 1;
          // 权威值变化后丢弃本地乐观值，开关始终收敛到读出的事实。
          setAutoOpenDraft(null);
          bump((value) => value + 1);
        }
        syncAutoSidebarTabs();
      };
      // 挂载 effect 与轮询/observer 回调都只经由这个引用取最新闭包（见 sidebarTabSyncRef 的说明）。
      sidebarTabSyncRef.current = syncSidebarTabs;

      /**
       * 打开成功后按宿主 openTabs/active() 证据记录「可关闭的 tabId」。
       *
       * openTabs 条目或 active() 返回的 tab 满足下面三条才记录，缺一条都只说明「还没有可证明的落地证据」：
       * - 有效 id：没有 id 就无法在之后精确关闭，也就没有任何可关闭状态可言；
       * - `kind === "subagentchat"`：active 可能仍是用户原本在看的别的 tab；
       * - `contentId === 资源地址`：同一个 kind 下也可能是另一个子代理的地址。
       * 不满足时保持 >> 的打开语义（按钮照旧可再次点击打开），绝不猜测 tabId。
       *
       * origin 的来源优先级（缺陷 1 之后的定稿判据，**每一层都必须自带证据**）：
       * 手动意图 / 持久 manual > 显式传入的动作来源（**且必须带因果证明**）> 已存在记录（**且 tabId
       * 必须相等**）> 在途打开记录（**且因果证明成立**）> realm 共享来源账本（tabId 逐字相等）>
       * 持久 auto（tabId 逐字相等）> **manual** 兜底。最后那条兜底正是规格要求：「外部已存在但未由
       * 自动动作发起的 tab 视为手动来源」，因此自动同步永远关不掉一个它没有亲手打开过的 tab。
       *
       * 为什么「本次动作声明的来源」还不够：宿主 openResource() 的公开契约里**没有返回值**（返回
       * void，见 lib/types/client/service.d.ts），而且默认 revealIfOpened=true —— 同一个
       * (kind, contentId) 已经有 tab 时它**揭示那一个**，绝不新建。所以「调用过 openResource」+
       * 「随后 inventory 里有一个同地址 tab」并不能证明那个 tab 是我们创建出来的：它完全可能是用户
       * 在等待窗口里从 DSH 其它入口打开的同一个资源。认领它就等于事后替用户关掉他的 tab。
       *
       * 因此 actionProof.autoProven 只由「发出 openResource **之前**亲眼确认 inventory 可读、且该
       * 地址没有已提交 tab」写成（见 handleSidebarAction 的因果证明点）。缺证明一律 manual。
       */
      const recordSidebarTab = (key, resourceAddress, actionOrigin, actionProof) => {
        if (closeSidebarResource === null) return false;
         if (readActiveSidebarResource === null && readSidebarOpenTabs() === null) return false;
        // 左箭头图标缺失时不会渲染 <<，因此也不该建立只在 << 上才有意义的记录。
        if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return false;
        const declaredOrigin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO || actionOrigin === SIDEBAR_TAB_ORIGIN_MANUAL
          ? actionOrigin
          : null;
        /**
         * 本次动作是否带**因果证明**：只有 handleSidebarAction 的自动路径会传它，而且只在
         * 「发出 openResource 之前 inventory 可读且该地址确实没有 tab」时为 true。
         * 手动路径带 null（不需要证明：手动动作恒按 manual 记账）。
         */
        const declaredAutoProven = actionProof !== null && actionProof !== undefined
          && actionProof.autoProven === true;
        let tab = null;
        const inventory = readSidebarOpenTabs();
        if (inventory !== null) {
          for (const entry of inventory) {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sidebarSessionId) continue;
            if (text(candidate.kind, null) !== SUBAGENT_CHAT_KIND) continue;
            if (text(candidate.contentId, null) !== resourceAddress) continue;
            const candidateId = text(candidate.tabId, null);
            if (candidateId !== null) {
              tab = { id: candidateId, kind: candidate.kind, contentId: candidate.contentId, title: null };
              break;
            }
          }
        }
        if (tab !== null && readActiveSidebarResource !== null) {
          try {
            const activeSource = object(readActiveSidebarResource.call(sidebarRight));
            if (text(activeSource.id, null) === tab.id) tab = { ...tab, title: text(activeSource.title, null) };
          } catch { /* inventory 已足够确认 tabId，标题读取失败不阻塞 toggle。 */ }
        }
        if (tab === null) {
          try { tab = readActiveSidebarResource.call(sidebarRight); } catch { return false; }
        }
        const source = object(tab);
        const tabId = text(source.id, null);
         const tabTitle = text(source.title, null);
        if (tabId === null) return false;
        if (text(source.kind, null) !== SUBAGENT_CHAT_KIND) return false;
        if (text(source.contentId, null) !== resourceAddress) return false;
        const previous = sidebarTabRecordsRef.current.get(key);
        const opening = sidebarTabOpeningRef.current.get(key);
        const previousScoped = previous !== undefined
          && previous.sessionId === sidebarSessionId && previous.rootSessionId === rootSessionId
          ? previous
          : undefined;
        const openingScoped = opening !== undefined
          && opening.sessionId === sidebarSessionId && opening.rootSessionId === rootSessionId
          ? opening
          : undefined;
        /**
         * 别的写入者证据（缺陷 1 的第二个判据）：这次打开**还没有**把 openResource 发给宿主
         * （causalIssuedAt 还是 null），我们却已经能读到这个地址上的 tab —— 那只可能是别人先打开的
         * （用户从 DSH 其它入口、或另一个 surface）。这次动作从此不再是这个 tab 的因果来源，落地
         * 时一律按 manual 记账，并把它写进在途记录，后续任何一次落地观察都不会再翻案。
         */
        if (openingScoped !== undefined
          && (openingScoped.causalIssuedAt === null || openingScoped.causalIssuedAt === undefined)) {
          openingScoped.foreignWriter = true;
        }
        /**
         * 手动接管优先于调用方声明的来源：用户在那个 key 上留下过「要打开」的手动意图时，即使这次
         * 打开是 Auto 发出的，最终 tab 也必须记成 manual——手动打开的最终来源必须是 manual，
         * Auto 绝不能在资源结束后把它当成自己的 tab 关掉。
         */
        const manualTakeover = sidebarManualIntentOf(key);
        /**
         * 共享 Auto 来源账本（键与打开记录同构，见 sharedSidebarAutoOrigin）。
         *
         * 收养路径（面板重挂载后 / 切 root 后从 inventory 重建记录）没有「本次动作的显式来源」，
         * 实例内的 previous 与 opening 也都是空的；唯一能证明「这个 tab 是 Auto 亲手打开的」的
         * 就是这条跨实例账本。缺了它，收养只能落到 manual 兜底，Auto 从此不再管这个 tab。
         *
         * 只认显式记成 auto 的账本条目，并且必须同 session + 同 root、且绑定的 tabId 与当前证据
         * 逐字相等（见下面的绑定闸门）：别的 scope 的条目一律不可见，来源未知的外部 tab、其它 pane
         * 的同地址 tab，以及「同地址但已经换了 tabId」的 tab 都不会被误收养成 Auto 的 tab。
         */
        const sharedOrigin = sidebarAutoOriginRef.current.get(key);
        const sharedOriginScoped = sharedOrigin !== undefined
          && sharedOrigin.sessionId === sidebarSessionId && sharedOrigin.rootSessionId === rootSessionId
          ? sharedOrigin
          : undefined;
        /**
         * tabId 绑定闸门（缺陷 1，与持久条目那条闸门逐字同源，只是证据来自另一层）：
         *
         * 共享账本的条目里记着「Auto 打开/替换落地那一刻亲眼看到的 tab」。只要求「有条目」是不够的：
         * 旧 tab 被用户或宿主移除而插件没有观察到时，同一个 realm 里的下一次收养（重挂载 / 记录被判
         * stale 后的重建）会在同地址上看到**用户新开的 tab**——它的 tabId 与条目里那个不一样。不比对
         * tabId 就按 auto 收养，等于替用户认领他刚打开的 tab，资源随后的 idle 就会把它自动关掉。
         *
         * 条目没有 tabId（null：这次自动打开已经发出、落地证据还没到）同样**不是** auto 证据：它只
         * 回答「这次运行是否已经为它发过打开」，任何归属判定都必须按「证据不足」处理。
         */
        const sharedOriginTabId = sidebarAutoOriginTabIdOf(sharedOriginScoped);
        const sharedOriginBound = sharedOriginTabId !== null && sharedOriginTabId === tabId;
        const sharedOriginStale = sharedOriginScoped !== undefined && sharedOriginBound !== true;
        /**
         * 持久归属标记是「整页刷新 / 进程重启 / HMR 之后」唯一还活着的证据（见 SIDEBAR_AUTO_OWNERSHIP_KEY）：
         * 命中 manual 一律 manual（手动恒优先，安全侧）；命中 auto 还要过下面那条 tabId 绑定闸门才按
         * auto 收养；没有标记按既有 manual 兜底。内存（含 realm 共享账本）与持久层不一致时以 manual
         * 为准，并在下面把内存来源一并抹掉，绝不留「内存 auto / 持久 manual」的歧义。
         */
        const persistedEntry = readSidebarAutoOwnershipEntry(sidebarSessionId, rootSessionId, resourceAddress);
        const persistedManual = persistedEntry !== null && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL;
        /**
         * tabId 绑定闸门（P1-A）：持久 auto 条目只认「写入时那个 tab」。
         *
         * 条目里的 tabId 是记录这条 auto 归属时宿主 inventory 里这个地址的 tab。整页刷新之后持久条目
         * 是唯一还活着的证据，而右栏里同地址的 tab 完全可能是**另一次 tab 创建**出来的（旧 tab 被用户
         * 或宿主移除而插件没观察到、用户随后从 DSH 其它入口打开同一地址）。不比对 tabId 就按 auto 收养，
         * 等于替用户认领他刚打开的 tab——资源随后 idle，Auto 就会把它关掉。
         *
         * 判定顺序（三档，manual 恒优先）：
         * 1. manual：手动意图（manualIntentOpen）/ 持久 manual 一律 manual，安全侧；
         * 2. 陈旧 auto：持久条目的 tabId 与当前证据不符（或旧格式条目根本没记 tabId）⇒ 它**不再**
         *    作为 auto 证据参与收养。若内存里也没有别的来源证据，最终落到下面的 manual 兜底，并在统一
         *    写入点把这条陈旧条目改写成 manual（理由 manual-stale-auto），避免它长期误导后续判断；
         * 3. auto：只有「内存来源证据」或「tabId 逐字相等的持久 auto」才认 auto。
         *
         * 为什么内存证据（本次动作声明的来源 / 已有记录 / 在途打开）仍然优先：它们是**本 realm 亲眼
         * 观察到的** Auto 动作；但「亲眼观察」必须落实到**证据**上，不能只凭「有一个 auto 来源」：
         * - 本次动作声明的来源（declaredOrigin）：必须带因果证明（actionProof.autoProven，见上面的
         *   说明）——宿主 openResource 没有返回值、而且默认是「已存在就揭示」，光调用过它不足以
         *   证明随后出现的那个 tab 是我们创建的；
         * - 已有记录（previous.origin）：必须 previous.tabId === 当前落地 tabId —— 记录说的是
         *   「T 这个 tab 归 Auto」，宿主换了一个新 id 之后这条记录已经不指向任何还在我们手里的 tab；
         * - 在途打开（opening）：必须 causalProof === "proven"（发出之前亲眼确认地址上没有 tab）、
         *   causalIssuedAt 非空（openResource 真的发出去过）、且 foreignWriter 未置位（期间没有
         *   观察到别的写入者）。
         * 而 realm 共享来源账本与持久条目各要多过一道 tabId 逐字相等的绑定闸门。任何一层缺证据都
         * 按安全侧落 manual：宁可漏收一次，也绝不误关用户刚打开的 tab。
         *
         * 取舍（刻意）：本机页面刷新时宿主从它自己的持久化布局里带回**同一批 tabId**，因此正常刷新场景
         * 仍然恢复 auto；只有宿主真的重新 mint 了 id 时才退化成 manual——宁可漏收一次（那个 tab 留在
         * 右栏里交给用户手动处理，绝不会自己消失），也绝不误关一个可能是用户刚打开的 tab。
         */
        const persistedAutoBound = persistedEntry !== null
          && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
          && persistedEntry.tabId !== null
          && persistedEntry.tabId === tabId;
        const persistedStaleAuto = persistedEntry !== null
          && persistedEntry.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
          && persistedAutoBound !== true;
        /**
         * 内存两层的证据闸门（缺陷 1）：
         * - previous：记录必须**绑定当前这个 tabId**，否则那条 auto 记录描述的是另一个已经不存在的
         *   tab（宿主重 mint / 回收），继承它就等于替用户认领他刚打开的 tab；
         * - opening：因果证明成立、openResource 真的发出过、期间没有别的写入者（见 causalProof /
         *   causalIssuedAt / foreignWriter 的说明）。
         */
        const previousUsableAuto = previousScoped !== undefined
          && previousScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
          && previousScoped.tabId === tabId;
        const openingUsableAuto = openingScoped !== undefined
          && openingScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
          && openingScoped.causalProof === "proven"
          && openingScoped.causalIssuedAt !== null && openingScoped.causalIssuedAt !== undefined
          && openingScoped.foreignWriter !== true;
        /**
         * 声明的来源也要过证据闸门：声明 auto 但缺因果证明时**直接落 manual**，绝不继续借用更弱的
         * 层（那正是缺陷 1 的误关形状：这次落地可能压根不是我们的动作打出来的那个 tab）。
         */
        const declaredUsable = declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO
          ? (declaredAutoProven === true ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL)
          : declaredOrigin;
        const manualIntentOpen = manualTakeover !== undefined && manualTakeover.intent === "open";
        const origin = manualIntentOpen || persistedManual
          ? SIDEBAR_TAB_ORIGIN_MANUAL
          : (declaredUsable
            ?? (previousUsableAuto === true
              ? SIDEBAR_TAB_ORIGIN_AUTO
              : (openingUsableAuto === true
                ? SIDEBAR_TAB_ORIGIN_AUTO
                : (sharedOriginBound === true
                  ? SIDEBAR_TAB_ORIGIN_AUTO
                  : (persistedAutoBound === true ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL)))));
        const recordOrigin = origin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;
        /**
         * 证据存在但 tabId 对不上（或根本没有 tabId）时，那条共享账本条目已经被这一轮判定为**不是**
         * 本次归属的证据，必须就地清掉：它会一直躺在 realm 账本里，在下一次收养里继续参与判断
         * （长期误导），也会让「本次运行已经为它发过打开」这条去重记账与真实状态脱节。
         *
         * 清掉不会造成重复打开：这个地址此刻确实有 tab（收养的前提就是 inventory 里读到了它），
         * autoOpenCandidate 的「inventory 里已经有这个地址的 tab」判据会照常跳过。持久 manual 与
         * 内存 auto 的歧义同样按 manual 清理（既有语义）。
         */
        if (sharedOriginStale === true
          || (persistedManual === true && sharedOriginScoped !== undefined)) {
          sidebarAutoOriginRef.current.delete(key);
        }
        /**
         * 归属成立（auto）时，把**当前亲眼观察到的 tabId** 写进共享来源账本：关闭候选的遍历与
         * 「绝不重复打开」的记账都长在这份账本上，两者本来就是同一份归属证据；缺了它，收养出来的
         * record 虽然是 auto，Auto 却永远不会再为它选出关闭候选（仍然漏收）。
         *
         * 这里也是**唯一**允许刷新 tabId 的位置之一（另一个是 handleSidebarAction 里 openResource
         * 成功落地的那次调用）：tabId 一律来自本次从宿主 inventory / active 读到的证据，绝不缓存、
         * 绝不猜测。刻意不做任何限容淘汰——归属容量由 autoOpenCandidate 在发出 openResource 之前
         * fail-closed 判定（见 autoSidebarOwnershipHasCapacity），收养路径绝不允许挤掉别的 scope
         * 仍然有效的 owner。
         */
        if (recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO) {
          sidebarAutoOriginRef.current.set(
            key,
            sidebarAutoOriginEntry(sidebarSessionId, rootSessionId, resourceAddress, tabId),
          );
        }
        /**
         * 归属标记与内存账本在**同一处**收口（写入 / 删除同源）：
         * - auto：DEG 自己成功打开（openIssued 成功落地）时写 auto-open；收养证据证明是 Auto 时写
         *   auto-adopt。同一地址此前若是 manual，必须由这次自动打开改回 auto（这是插件新开的一次自动行为）；
         * - manual：手动打开 / 手动接管 / 来源未知的外部 tab 一律写 manual（手动恒优先）。
         */
        writeSidebarAutoOwnership(
          sidebarSessionId,
          rootSessionId,
          resourceAddress,
          recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO : SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
          recordOrigin === SIDEBAR_TAB_ORIGIN_AUTO
            ? (declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? "auto-open" : "auto-adopt")
            /**
             * 陈旧 auto 被降级成 manual 时用独立理由：诊断里据此能区分「用户手动接管」
             * （manual-takeover）与「某条 auto 证据的 tabId 与当前 tab 不符，按安全侧退让」两种完全
             * 不同的原因，事后排查「这个 tab 为什么没被自动收回」时才有的放矢。
             *
             * - manual-stale-auto：持久条目的 tabId 与当前 tab 不符（跨整页刷新的那条证据）；
             * - manual-stale-origin：realm 共享来源账本的 tabId 与当前 tab 不符或缺席（同一次页面
             *   会话内、宿主重 mint 了 tabId 而插件没有观察到那次替换）；
             * - manual-unproven-open：本次自动打开**没有**因果证明（发出前没能确认地址上没有 tab），
             *   或因果证明成立却在途期间观察到了别的写入者——落地到的这个 tab 无法与「用户自己打开的
             *   同一个资源」区分，按安全侧落 manual（缺陷 1）。
             */
            : (manualIntentOpen === true
              ? "manual-open"
              : (persistedStaleAuto === true
                ? "manual-stale-auto"
                : (sharedOriginStale === true
                  ? "manual-stale-origin"
                  : (declaredOrigin === SIDEBAR_TAB_ORIGIN_AUTO && declaredAutoProven !== true
                    ? "manual-unproven-open"
                    : (openingScoped !== undefined && openingScoped.origin === SIDEBAR_TAB_ORIGIN_AUTO
                      && openingUsableAuto !== true && previousUsableAuto !== true
                      ? "manual-unproven-open"
                      : "manual-takeover"))))),
          // 条目与内存账本同源写入当前的 tabId：下一次刷新后的收养按它比对（见上面的绑定闸门）。
          tabId,
        );
        if (previous !== undefined && previous.sessionId === sidebarSessionId
          && previous.rootSessionId === rootSessionId && previous.tabId === tabId) {
          previous.title = tabTitle ?? previous.title;
          previous.misses = 0;
          previous.origin = recordOrigin;
          return true;
        }
        sidebarTabRecordsRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, tabId, title: tabTitle, misses: 0, origin: recordOrigin });
         bump((value) => value + 1);
         return true;
      };

      /**
       * 侧栏箭头点击的唯一入口：打开与关闭共用一条路径，同一 key 上串行（pending 防重入）。
       *
       * 串行窗口覆盖从「读记录」到「记录落定」的整段同步逻辑：打开时 openResource 可能同步触发
       * 宿主的提交，重入点击若穿过检查就会发出第二次 openResource（第二个重复 tab）或提前走关闭。
       * 抛错处理：openResource / close 抛错只影响这一次动作，绝不写状态——打开失败保持 >>，
       * 关闭失败保持 <<（用户可以再点一次），两种情况都不会把按钮和真实世界对不上。
       *
       * origin 是**内部**参数，默认 manual：普通 UI 调用（箭头、键盘）一律手动来源；只有自动同步
       * 显式传 auto。它决定三件事：记录来源、手动动作是否清除抑制/自动来源、关闭时是否登记抑制。
       *
       * autoAction 也是**内部**参数，只在自动路径上出现：{ kind, epoch, attemptsBefore, attemptToken }。
       * 它让同一条实现能在每个 await 之后、真正调用宿主 open/close 之前复核「Auto 是否仍然开启、动作
       * 是否已过期、用户是否已经手动接管」，并在收尾时无条件释放在途预留（见 finally）。关闭类候选还
       * 带着预支预算时新建的 attemptToken：回滚/收口共享重试计数只认这份不可复用的所有权凭据。
       */
      const handleSidebarAction = async (key, resourceAddress, actionOrigin, autoAction) => {
        const origin = actionOrigin === SIDEBAR_TAB_ORIGIN_AUTO ? SIDEBAR_TAB_ORIGIN_AUTO : SIDEBAR_TAB_ORIGIN_MANUAL;
        /**
         * 手动来源的动作在入口就把归属标记改写成 manual（手动恒优先，且必须在任何 await 之前落盘）：
         * 有记录 ⇒ 用户在关闭这个 tab（manual-close）；没有记录 ⇒ 用户在打开它（manual-open）。
         * 这条写入同时抹掉内存里的共享来源，绝不留「内存 auto / 持久 manual」的歧义。
         */
        if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
          const manualRecord = sidebarTabRecordsRef.current.get(key);
          writeSidebarAutoOwnership(
            sidebarSessionId,
            rootSessionId,
            resourceAddress,
            SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
            manualRecord === undefined ? "manual-open" : "manual-close",
          );
        }
        const autoContext = origin === SIDEBAR_TAB_ORIGIN_AUTO && autoAction !== null && typeof autoAction === "object"
          ? {
            kind: autoAction.kind === "close" ? "close" : "open",
            epoch: Number.isFinite(Number(autoAction.epoch)) ? Number(autoAction.epoch) : sidebarAutoEpochRef.current,
            attemptsBefore: Number.isFinite(Number(autoAction.attemptsBefore)) ? Number(autoAction.attemptsBefore) : 0,
            // 只有候选选择真的登记过一份令牌时才带上它：缺失/畸形一律按 null 处理，后续回滚因此
            // fail-safe 地放弃（绝不按 key 盲写共享计数）。
            attemptToken: autoAction.attemptToken !== null && autoAction.attemptToken !== undefined
              && typeof autoAction.attemptToken === "object"
              ? autoAction.attemptToken
              : null,
          }
          : null;
        // React 重挂载或 root 切换后，旧 DOM 可能短暂保留旧 handler；它不能操作当前 session-scoped 服务。
        // 这里的判据含不可复用的 surface 令牌：同一个实例 A→B→A 之后，旧 handler 手里的字符串会重新
        // 相等，只有令牌能证明它已经不属于当前 surface。
        if (sidebarSurfaceStillCurrent() !== true) {
          /**
           * 连入口都没通过的自动动作：这里必须自己释放候选选择时写下的预留（以及自动关闭的重试记账）。
           * 这些键属于已经被换掉的 surface，当前闭包之后再也不会为它们做清理。
           */
          if (autoContext !== null) {
            sidebarAutoReservationRef.current.delete(key);
            releaseAutoCloseAttempt(key, autoContext);
          }
          return;
        }
        const pending = sidebarTabPendingRef.current;
        if (pending.has(key)) {
          /**
           * 同一个 key 上已经有动作在途（典型：Auto 正在等 split 返回 pane / 等布局提交 / 等打开落地）。
           * 用户此刻的手动点击绝不能因为「锁被占用」而消失：它被记成手动意图，由在途动作在副作用之前
           * 让位、或由本函数收尾后立即结算（见 applyPendingManualIntent）。手动意图只在手动路径上记录。
           */
          if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
          return;
        }
        pending.add(key);
        /** 本次动作是否真的把 openResource 发给了宿主：只有它才允许建立 auto 来源标记。 */
        let openIssued = false;
        try {
          /**
           * 副作用之前的第一道复核（自动路径）：Auto 开关的权威值与动作代次都可能在等待期间变化。
           * 关闭 Auto 时必须在这里放弃——包括「已经 split 出 pane」的前一阶段遗留在途记录的情况。
           */
          if (autoContext !== null && autoActionStillValid(autoContext) !== true) {
            abandonAutoSidebarAction(key, autoContext);
            return;
          }
          const record = sidebarTabRecordsRef.current.get(key);
          if (record === undefined && sidebarTabOpeningRef.current.has(key)) {
            /**
             * 打开已经发出、落地证据还没到：手动点击同样不能丢。按意图记账，等它落地（或超时）后
             * 由同步链路结算；在这之前绝不补发第二次 openResource，也绝不猜 tabId 去关闭。
             */
            if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) recordSidebarManualIntent(key, resourceAddress);
            return;
          }
          // 关闭态：只调用记录里的精确 tabId。绝不根据 active() 当前是谁来决定关哪个 tab。
          if (record !== undefined && closeSidebarResource !== null) {
            /**
             * 关闭的唯一执行入口（见 closeSidebarTabWithLease）：
             * - 手动单项（用户触发）：同一个 tabId 上已经有一次关闭在途时等待它结算——上次成功就当作
             *   这个 tab 已经被关掉（绝不再 close），上次失败才用**当前** inventory 证明同一个 tabId
             *   仍在之后做一次有限重试。用户的关闭意图因此既不会重复，也不会在竞争失败时被静默丢失；
             * - 自动动作：遇到在途关闭立刻让位，绝不 await（Auto 同步绝不能被一次永不结算的宿主
             *   Promise 拖住），并回退本轮 closeAttempts/预留、记入本次级联的失败屏障。
             */
            /**
             * 这次关闭出发时看到的 split 意图身份（不可复用令牌）。
             *
             * 它的作用域**只到这次关闭**：收口时只有当前意图仍然是这一份才允许取消（见
             * cancelPendingSidebarSplitOfClose）。只按 key 取消的旧写法会把验证窗口里出现的
             * 同 key 新 generation 的 split/open 事务一起掐掉。出发时没有意图就记 null——
             * 那一刻之后出现的任何意图都只属于后来者，这次关闭一律不碰。
             */
            const splitIntentAtClose = sidebarSplitIntentRef.current;
            const closeSplitIntentToken = splitIntentAtClose !== null && splitIntentAtClose.key === key
              ? splitIntentAtClose.token
              : null;
            const closeOutcome = await closeSidebarTabWithLease(record.tabId, {
              waitForCompeting: origin === SIDEBAR_TAB_ORIGIN_MANUAL,
              /**
               * 验证上下文：close 请求 resolve 之后必须由 inventory 的精确 tabId 证据收口。
               * 手动关闭同样要验证（attemptToken = null ⇒ 验证成功后按手动语义登记抑制）。
               * splitIntentToken 随验证记录一起保留：验证链的收口可能在若干轮同步之后才发生。
               */
              verify: {
                key,
                address: resourceAddress,
                attemptToken: autoContext === null ? null : autoContext.attemptToken,
                manual: origin === SIDEBAR_TAB_ORIGIN_MANUAL,
                splitIntentToken: closeSplitIntentToken,
              },
            });

            /**
             * await 之后的 surface 身份闸门（单项关闭的收尾边界，与批量入口同一条判据）。
             *
             * 这次 await 可能跨越一次组件重挂载或 root / sidebar session 切换：本闭包里的 ref、
             * records 与快照都已经不属于当前 surface，而**共享**的 Auto 来源 / 抑制 / 重试记账却是
             * 同一份。此时若还按旧闭包继续收尾（删记录、删共享来源、登记抑制、bump）并调用旧闭包的
             * syncSidebarTabs()，旧快照会把新 Panel 刚刚写入的**其它** Auto 来源当成「已经离开当前
             * 快照」而清掉——新 Panel 随后再也认不出自己打开过的 tab，资源结束后也不会自动关闭它。
             *
             * 因此任何返回结果（closed / failed / settled-closed / contended / unreadable / stale）
             * 都必须在写共享账本、删记录、登记抑制或调用旧闭包同步**之前**复核 surface 身份；任一失配
             * 立即停止本实例的后续收尾。判据含不可复用的 surface 令牌：同一个实例 A→B→A 之后
             * root/sidebar session 字符串会重新相等，只有令牌能证明这次收尾已经不属于当前 surface
             * （否则旧动作会删掉 A 里已经换成新 tabId 的 record / Auto 来源）。租约已经由
             * closeSidebarTabWithLease 自己的 finally 结算并归还（这里绝不重复释放），旧 tab 的归属交给
             * 新 Panel 后续同步按真实 inventory 结算：成功关掉的由那次同步收口，失败 / 还没落地的则仍
             * 留在 inventory 里等下一轮有界重试。
             */
            if (sidebarSurfaceStillCurrent() !== true) {
              return;
            }
            if (closeOutcome.status === "contended" || closeOutcome.status === "contended-timeout") {
              /**
               * 让位路径（自动动作）：这次关闭根本没有发出，因此必须归还候选选择时预支的那一次重试
               * 预算与在途预留，否则一次「有人在关」的等待就会白烧掉一次有界重试，甚至让 Auto 提前
               * 放弃这个 tab。**绝不在这里清理来源**：来源只在关闭真的成功后才允许撤销（失败 / 让位
               * 都必须继续归 Auto 管，留给后续同步重试）。
               */
              if (autoContext !== null) {
                sidebarAutoReservationRef.current.delete(key);
                releaseAutoCloseAttempt(key, autoContext);
                /**
                 * 同时记进本次级联的失败屏障：这次关闭没有发出，但它绝不能在**同一批微任务级联**里被
                 * 重新选中（候选与执行之间只隔一次微任务，动作收尾的尾随同步会立刻再选一次；若冲突
                 * 持续存在，那会变成不让出宏任务的微任务死循环）。屏障在下一次外部同步轮自动失效，
                 * 那时锁通常已经归还，重试照常。
                 */
                sidebarAutoFailedKeysRef.current.add(key);
              }
              return;
            }
            /**
             * 只有拿到「已经关掉」的结算才收口：亲手关闭成功，或等待竞争租约后拿到成功 / inventory
             * 已证明 tab 消失的结算。失败、inventory 不可读（fail-closed）与「有人接手」都不允许在
             * 这里改写记录或来源——记录只由真实结算（这里或既有同步器）收口，绝不因为「这次不是自己
             * 亲手关的」就跳过收口，否则会留下一份与宿主 inventory 不符的账。
             */
            if (closeOutcome.status === "unreadable") {
              // preflight 没通过：close 根本没有发出 → 按令牌回滚这次预支，绝不清理归属。
              if (autoContext !== null) {
                sidebarAutoReservationRef.current.delete(key);
                releaseAutoCloseAttempt(key, autoContext);
                sidebarAutoFailedKeysRef.current.add(key);
              }
              return;
            }
            if (closeOutcome.status === "stale") {
              // 等待期间 surface 换代：close 没有发出 → 同样按令牌回滚，旧 tab 交给新 generation 收口。
              if (autoContext !== null) {
                sidebarAutoReservationRef.current.delete(key);
                releaseAutoCloseAttempt(key, autoContext);
              }
              return;
            }
            if (closeOutcome.status === "failed" || closeOutcome.status === "timeout") {
              /**
               * 请求真的发出去过（reject 或 watchdog 超时）：**绝不回滚 count**——回滚就等于把三次快速
               * 上限又还给它，实际 close 次数会突破上限。record / origin / 冷却一律保留，留给后续同步重试。
               */
              sidebarAutoFailedKeysRef.current.add(key);
              return;
            }
            if (closeOutcome.status === "request-resolved-unverified") {
              /**
               * resolve 只代表请求完成：验证链已经登记在共享账本里，record / origin / attempt 全部保留。
               * 这里直接返回，绝不落到下面的 openResource 分支，也绝不当成「已经关掉」收口。
               */
              return;
            }
            /**
             * verified-closed：精确 inventory 证据证明这个 tab 已经不在；
             * verified-recycled：这个 tabId 已经被宿主回收给另一个资源（地址不一致）——旧 tab 已经
             *   消失、close 一次也没有发出，但「这个 key 已经没有自己的 tab」这个结论与 verified-closed
             *   完全等价，因此收口规则一致（下面的 (key, tabId) 一致性闸门照旧生效）；
             * closed：旧宿主没有 inventory 读面时的手动关闭（历史语义，用户意图优先）。
             * 只有这三种结算允许收口归属。
             */
            if (closeOutcome.status === "verified-closed" || closeOutcome.status === "closed"
              || closeOutcome.status === "verified-recycled") {


              /**
               * 关闭成功后一起收口这个 key 上尚未结算的分栏事务。
               *
               * 现实窗口：目标 tab 已经进入公开 inventory（所以这里能拿到可关闭的 tabId），但宿主的
               * pane 组成证据还没提交（dockkit 尚未把它渲染进 split 返回的 pane）。此时只删记录会让
               * 右栏停在事务的临时 50%，直到 15 秒 deadline 才回落——用户看到的就是「收回后右栏卡在
               * 50% 十几秒」，同一行的下一次点击也只会撞上残留事务。取消事务既清掉在途事务，也让
               * 既有同步器按最新组成重估宽度（Expert Group-only ⇒ 立即回到 20%）。
               *
               * 只有同 key 的意图会被取消：别的行的在途打开照旧继续。
               */
              /**
               * (key, tabId) 一致性闸门：只有这个 key 当前记录的 tabId 仍是本次动作关闭的那一个，才允许
               * 收口 record / origin。宿主换过 tabId（旧 tab 消失、同一个资源换成新 tab）时，旧代次的
               * 结算只能清理它自己那一笔预算，绝不能删掉新 generation 的 record 与 Auto 归属。
               */
              const currentRecord = sidebarTabRecordsRef.current.get(key);
              const recordStillSame = currentRecord !== undefined && currentRecord.tabId === record.tabId;
              /**
               * 分栏事务只收口**这次关闭出发时看到的那一份意图**：这次关闭确实发生了，事务必须收口
               * （否则右栏停在临时 50%）；但同一个 key 上如果已经出现新 generation 的 split/open
               * 事务（用户或 Auto 重新打开了这个资源），旧 close 的结算绝不取消它——那会把新一次打开
               * 的 pane 归属与临时扩栏一起打断。令牌逐对象比较，A→B→A 或同 key 重开都无法冒充。
               */
              cancelPendingSidebarSplitOfClose(key, closeSplitIntentToken);
              if (recordStillSame === true) {
                sidebarTabRecordsRef.current.delete(key);
              }
              // 重试预算按所有权收口：手动关闭恒优先，直接清空；自动关闭只有 owner 仍是本次动作的
              // 令牌时才清空（旧代次的迟到成功结算绝不把后来者重新预支的预算一起清零）。
              settleAutoCloseAttempt(key, autoContext);

              /**
               * 关闭成功后收口来源与抑制记账（两种开放的语义差别就在这两行）：
               *
               * - 自动关闭：只撤销来源标记——本次运行不会再对同一个资源重复动作；
               * - 手动关闭：除撤销来源外还要登记**抑制**，Auto 不得立刻把它重新打开。抑制只由
               *   用户手动重新打开同一资源清除（手动意图优先）。
               *
               * 「等待竞争租约后拿到成功结算」同样走这里：tab 确实已经被关掉，收口规则与亲手关闭一致；
               * 反过来说，让位 / 失败 / inventory 不可读的路径一律在上面 return，绝不提前清理来源。
               */
              // 来源与抑制同样只在这个 key 仍然指向本次关闭的那个 tabId 时收口：否则删掉的会是
              // 新 generation 刚刚为**新 tabId** 写下的 Auto 归属。
              if (recordStillSame === true && closeOutcome.status === "verified-recycled") {
                /**
                 * 地址复用证明旧 tab 已经消失：这个 key 的失败冷却也随之失效，必须一起清掉。否则一条
                 * 永远等不到自己 tab 的冷却（最长 15 分钟）会白白屏蔽这个 key 后续的真实关闭。
                 * 仍然只在 record 仍指向本次证明消失的那个 tabId 时清理：后来者已经接管这个 key 时，
                 * 它的冷却记账不属于这次结算（与 finishVerifiedSidebarClose 的 sameTab 闸门同源）。
                 */
                sidebarAutoCloseCooldownsRef.current.delete(key);
              }
              if (recordStillSame === true) {
                sidebarAutoOriginRef.current.delete(key);
                if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
                  sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
                  trimAutoKeyMap(sidebarAutoSuppressedRef.current);
                  writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
                }
              }

              bump((value) => value + 1);
              // 关闭改变了右栏组成，必须立刻重估一次：宽度与手柄锁都在同一条同步链路上。
              syncSidebarTabs();
            }
            return;
          }
          if (openSidebarResource === null) return;
          /**
           * 自动动作的副作用复核点：真实的用户可见副作用（split / openResource）之前必须重新确认
           * 「Auto 仍开启」「动作代次没过期」「用户没有在同一个 key 上手动接管」。返回值：
           * - "proceed"：照常执行；
           * - "abort"：Auto 已关闭/动作已过期，或用户要求关闭 → 撤销在途记账，绝不发出副作用；
           * - "manual"：用户手动要求打开 → 动作可以继续，但最终 tab 必须记成 manual 来源。
           * 手动路径（autoContext === null）永远是 "proceed"，历史行为逐字不变。
           */
          const reviewAutoSideEffect = () => {
            if (autoContext === null) return "proceed";
            if (autoContext === null) return "proceed";
            if (autoActionStillValid(autoContext) !== true) return "abort";
            /**
             * 这里刻意**不**再加一道「持久 manual ⇒ abort」的闸门（持久抑制的判据只落在候选选择处，
             * 见 autoOpenCandidate）。原因：这条路是「候选已经选中、正在等宿主布局」的在途窗口，窗口里
             * 出现的 manual 条目可能来自用户**手动打开同一个资源**（handleSidebarAction 的入口写入），
             * 那种形状的既有契约是「这一次打开照常发出，但最终 tab 记成 manual」（见 autoTakeoverStateOf
             * 的 "open" 分支与「等待布局期间手动打开」用例）；在这里 abort 会连同用户的手动意图一起
             * 丢掉（那次点击不会补发 openResource）。
             *
             * 窗口里的「手动关闭」不依赖持久条目：它由 applyPendingManualIntent 立刻写抑制，并且
             * autoTakeoverStateOf 返回 "close" ⇒ 下面直接 abort，行为逐字不变。
             */
            const takeover = autoTakeoverStateOf(key);
            if (takeover === "close") return "abort";
            if (takeover === "open") return "manual";
            return "proceed";
          };
          /** 本次打开最终要记的来源：自动动作只在没有手动接管时才是 auto。 */
          let effectiveOrigin = origin;
          const canTrackOpen = closeSidebarResource !== null
             && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
             && typeof primitives?.IconChevronLeftOutlineRegular === "function";
          const canObserveOpenCommit = canTrackOpen
            && globalThis.document !== null && globalThis.document !== undefined;
          if (canObserveOpenCommit) {
            sidebarTabOpeningRef.current.set(key, {
              sessionId: sidebarSessionId,
              rootSessionId,
              resourceAddress,
              expiresAt: Date.now() + SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,
              origin,
              /**
               * 因果证明状态（缺陷 1）：这一次打开到底凭什么说「随后落地的那个 tab 是我们创建的」。
               *
               * - causalProof："pending"（还没判）→ "proven"（发出 openResource 之前亲眼确认
               *   inventory 可读且该地址没有已提交 tab）/ "failed"（有 tab 或读不到，一律不认领）；
               * - causalIssuedAt：openResource 真正发给宿主的时刻（null = 还没发出）。在此之前读到
               *   同地址 tab 只可能是**别的写入者**；
               * - foreignWriter：期间观察到别的写入者的证据（见 recordSidebarTab 的置位点）。
               *
               * 三个字段缺一不可：任何一层不成立都不允许把落地证据认成 auto（宁可漏收一次）。
               */
              causalProof: "pending",
              causalIssuedAt: null,
              foreignWriter: false,
            });
          }
          /**
           * 手动打开的意图优先于自动记账：
           *
           * - 清除抑制：用户手动重新打开 = 他重新要这个会话，Auto 之后可以继续管理它；
           * - 撤销自动来源：这次打开是手动来源，Auto 绝不能在资源结束时把它当成自己的 tab 关掉。
           * 两条都在发动作之前写，因此这一段没有 await，不存在与自动同步交叉的窗口。
           */
          if (origin === SIDEBAR_TAB_ORIGIN_MANUAL) {
            sidebarAutoSuppressedRef.current.delete(key);
            sidebarAutoOriginRef.current.delete(key);
            // 用户手动重新打开同一资源：手动接管，这个 key 上未结算的自动关闭预算（含 owner）一并作废。
            clearAutoCloseAttempt(key);
          }
          const targetPaneId = existingSubagentPaneId();
          let openOptions = null;
          let splitToken = null;
          if (targetPaneId !== null) {
            // 已经有独立子代理 pane：后续资源固定复用它，不再消耗新的 pane 配额。
            openOptions = { kind: SUBAGENT_CHAT_KIND, paneId: targetPaneId, preferNewPane: false };
          } else if (splitSidebarPane !== null) {
            // 新版公开 split() 是唯一能确认「确实创建了另一个 pane」的回执。
            // 返回 undefined 或调用抛错都表示宿主拒绝分栏；此时不打开资源，避免
            // openResource 静默回落到当前的 Expert Group pane。
            const tabsBeforeSplit = readSidebarOpenTabs();
            if (beginSidebarSplit !== null) {
              let preparation = null;
              try {
                preparation = beginSidebarSplit.call(config, {
                  sessionId: sidebarSessionId,
                  rootSessionId,
                  key,
                  resourceAddress,
                });
              } catch {
                preparation = null;
              }
              if (preparation?.busy === true) {
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              // install coordinator 已接管新版 split 时，null/缺 token 表示宽度或 surface
              // 准备失败；必须在调用 split() 之前中止，不能把 20% 状态下的 split 静默发给宿主。
              if (preparation === null || typeof preparation !== "object"
                || preparation.token === null || preparation.token === undefined) {
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              splitToken = preparation.token;
              if (splitToken !== null) {
                sidebarSplitIntentRef.current = {
                  token: splitToken,
                  key,
                  resourceAddress,
                  paneId: null,
                  resourceIssued: false,
                };
              }
              // 宽度 action 返回只代表 store 已写入；必须等宿主把新宽度提交到 DockLayout，
              // 否则 split() 仍会读到旧 room.row=false，并弹出「栏宽不足」。
              await waitForSidebarSplitLayoutCommit();
              const splitStillCurrent = sidebarSurfaceStillCurrent() === true
                && sidebarSplitIntentRef.current?.token === splitToken;
              if (!splitStillCurrent) {
                // session 切换、卸载或 deadline 已经收口时，不得让旧点击继续操作新 surface。
                if (sidebarSplitIntentRef.current?.token === splitToken) cancelPendingSidebarSplit("split-stale");
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              /**
               * 布局等待是这条路径上唯一会跨越用户操作窗口的 await：用户可能在这里关闭了 Auto，
               * 也可能在同一个 key 上手动接管。此时连 split() 都还没调用，直接放弃是代价最小的时机。
               */
              const afterLayoutReview = reviewAutoSideEffect();
              if (afterLayoutReview === "abort") {
                abandonAutoSidebarAction(key, autoContext);
                if (autoTakeoverStateOf(key) === "close") {
                  // 用户要的是关闭：立刻登记抑制，Auto 不得在下一轮同步里把它重新选成候选。
                  sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
                  trimAutoKeyMap(sidebarAutoSuppressedRef.current);
                  writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
                }
                return;
              }
              if (afterLayoutReview === "manual") effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
            }
            let paneId = null;
            try { paneId = splitSidebarPane.call(sidebarRight); } catch { paneId = null; }
            if (typeof paneId !== "string" || paneId.trim() === "") {
              if (splitToken !== null) cancelPendingSidebarSplit("split-failed");
              sidebarTabOpeningRef.current.delete(key);
              return;
            }
            if (splitToken !== null) {
              let accepted = true;
              if (markSidebarSplitPane !== null) {
                try { accepted = markSidebarSplitPane.call(config, splitToken, paneId) !== false; } catch { accepted = false; }
              }
              if (!accepted) {
                cancelPendingSidebarSplit("pane-rejected");
                sidebarTabOpeningRef.current.delete(key);
                return;
              }
              if (sidebarSplitIntentRef.current?.token === splitToken) {
                sidebarSplitIntentRef.current.paneId = paneId;
              }
            }
            const guideTabId = seededGuideTabId(tabsBeforeSplit, sidebarSessionId);
            // split() 的默认 guide 也必须在同一次导航意图中被替换，否则新 pane 会出现
            // 一个多余的「开始」tab；replaceTab 仍是公开 openResource 选项。
            openOptions = { kind: SUBAGENT_CHAT_KIND, paneId, preferNewPane: false };
            if (guideTabId !== null) openOptions.replaceTab = guideTabId;
          } else {
            // 旧宿主没有公开 split()：保留历史 preferNewPane 请求，兼容旧版本。
            openOptions = { kind: SUBAGENT_CHAT_KIND, preferNewPane: true };
          }
          /**
           * 真正发出副作用之前的最后一道复核：从「读记录」到这里可能已经跨过 split 前的布局等待，
           * Auto 开关与用户手动意图都可能变化。只有通过复核才允许调用宿主 openResource()——绝不把
           * 一个已经关掉的 Auto 变成一次迟到的自动打开。
           */
          const beforeOpenReview = reviewAutoSideEffect();
          if (beforeOpenReview === "abort") {
            abandonAutoSidebarAction(key, autoContext);
            if (autoTakeoverStateOf(key) === "close") {
              // 用户要的是关闭：立刻登记抑制，绝不在同一轮或下一轮同步里把这个资源重新打开。
              sidebarAutoSuppressedRef.current.set(key, { sessionId: sidebarSessionId, rootSessionId, address: resourceAddress });
              trimAutoKeyMap(sidebarAutoSuppressedRef.current);
              writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, resourceAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
            }
            return;
          }
          if (beforeOpenReview === "manual") effectiveOrigin = SIDEBAR_TAB_ORIGIN_MANUAL;
          /**
           * 副作用之前的**因果证明**（缺陷 1，与复核点在同一个同步段里，中间没有任何 await）。
           *
           * 宿主 openResource() 的公开契约里没有返回值（void），默认 revealIfOpened=true —— 同一个
           * (kind, contentId) 已经有 tab 时它只是**揭示**那一个。因此「我们调用过 openResource」+
           * 「随后 inventory 里出现同地址 tab」并不构成因果：那个 tab 完全可能是用户刚刚从 DSH 其它
           * 入口打开的同一个资源。这里在发动作之前亲眼核对一次：
           * - inventory 可读、且该地址没有已提交 tab ⇒ 之后出现的那个 tab 只可能是本次调用打出来的
           *   （同一帧内没有别的写入者能插进来），记为 proven；
           * - 已经有 tab（用户在等待窗口里打开了它）、或 inventory 读不出来（证明不了）⇒ 一律降级
           *   manual：这次调用最多只是揭示别人的 tab，绝不认领、绝不在资源结束后把它关掉。
           *
           * 取舍（刻意）：宁可漏收一次（那个 tab 留在右栏交给用户手动处理），也绝不误关用户刚打开的
           * tab。手动路径（autoContext === null）不需要证明：它本来就记 manual。
           */
          let openProof = null;
          if (autoContext !== null) {
            const openWitness = sidebarResourceTabStateOf(resourceAddress);
            const autoProven = openWitness.readable === true && openWitness.tabId === null;
            openProof = { autoProven };
            if (autoProven !== true) {
              /**
               * 刻意**不**在这里改 effectiveOrigin：留成 auto 才能让「声明过 auto 但缺因果证明」这个
               * 事实一路带到来源判据（recordSidebarTab 的 declaredUsable ⇒ manual，理由
               * manual-unproven-open，诊断里一眼能看出是**没证明出来**而不是用户手动接管）。
               * 占位写入与最终归属都由 openProof 把关。
               */
              recordSidebarAutoDecision("open", { key, kind: "open" }, "downgrade", "causal-unproven");
            }
            const pendingOpening = sidebarTabOpeningRef.current.get(key);
            if (pendingOpening !== undefined
              && pendingOpening.sessionId === sidebarSessionId && pendingOpening.rootSessionId === rootSessionId) {
              pendingOpening.causalProof = autoProven === true ? "proven" : "failed";
            }
          }
          /**
           * 「已发出」标记必须写在**调用之前**、与调用处在同一个同步段里（时序加固，可用性阻塞）。
           *
           * 宿主链路（已按实现核实，见 @deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js 与
           * client-store 的 snapshot store）：openResource → store.actions.openContent → zustand setState
           * 的同步 forEach → adopt() 里 store.subscribe(sync) 注册的回调 → inventory.publish() →
           * openTabs.set → 插件在挂载期注册的 inventory 订阅回调。整条链路上没有任何 await / 微任务，
           * 宿主因此会在 openResource() **返回之前**同步重入本插件一次（syncSidebarTabs →
           * syncSidebarTabRecords → 对在途 opening 调 recordSidebarTab）。
           *
           * 若标记晚于这次重入写入（旧实现），重入结算读到的 causalIssuedAt 还是 null，于是按
           * 「别的写入者」置位 foreignWriter 并把 tab 记成 manual、落盘持久 manual 归属；随后的声明式
           * Auto 记录又被持久 manual 压制，资源结束也收不回来（不会误关，但正常自动收回失效）。
           *
           * 三件套一条都不放宽：标记只让重入结算把这次 landing 认作**本次调用**打出来的 tab，是否可作
           * auto 证据仍由 recordSidebarTab 判：发出前 inventory 可读且该地址无 tab（causalProof ===
           * "proven"）+ 标记非空 + 期间没有别的写入者（foreignWriter !== true）。调用**同步抛错**时立刻
           * 回滚标记（下面的 try/catch），绝不留下「已经发出」的假证据。
           */
          const issuedOpening = autoContext === null ? undefined : sidebarTabOpeningRef.current.get(key);
          const issuedOpeningScoped = issuedOpening !== undefined
            && issuedOpening.sessionId === sidebarSessionId && issuedOpening.rootSessionId === rootSessionId
            ? issuedOpening
            : undefined;
          // 回滚用的原值：畸形值按 null（「还没发出」）处理，绝不把脏值留在记录里。
          const issuedAtBefore = issuedOpeningScoped === undefined
            || issuedOpeningScoped.causalIssuedAt === null || issuedOpeningScoped.causalIssuedAt === undefined
            ? null
            : issuedOpeningScoped.causalIssuedAt;
          if (issuedOpeningScoped !== undefined) issuedOpeningScoped.causalIssuedAt = Date.now();
          try {
            openSidebarResource.call(sidebarRight, resourceAddress, openOptions);
          } catch (error) {
            /**
             * 同步抛错：宿主没有完成这次打开，这次调用必须回到「从未发出」的状态——否则任何一条把它们
             * 联系起来的后续判据（重入结算 / 重试 / 收养）都可能把失败的动作当成已发出的证据。
             * 回滚后原样抛出，交给外层 catch 收口（撤销来源占位、清掉在途记录）。
             */
            if (issuedOpeningScoped !== undefined) issuedOpeningScoped.causalIssuedAt = issuedAtBefore;
            throw error;
          }
          openIssued = true;
          /**
           * 预留 → 来源的升级点：只有 openResource 真的成功发出、且宿主具备可追踪能力（能读到 tabId、
           * 能精确关闭）时，才把这次打开记成「Auto 亲手打开」。openResource 抛错时直接走 catch，
           * 来源标记绝不写；能力不足时也不写——将来无法精确回收的 tab 不归 Auto 管。
           */
          if (effectiveOrigin === SIDEBAR_TAB_ORIGIN_AUTO && canTrackOpen === true
            && openProof !== null && openProof.autoProven === true) {
            /**
             * 此刻落地证据还没到（tabId 未知）：这里只写下「本次运行已经为它发出过一次 Auto 打开」
             * 这条去重记账，tabId 一律留空——它不是归属证据（见 sidebarAutoOriginEntry）。真正的
             * tabId 只由 recordSidebarTab 在宿主 inventory 里**亲手读到那个 tab** 时写入 / 刷新。
             *
             * 刻意不做限容淘汰：归属容量由候选选择阶段在发出 openResource 之前 fail-closed 判定
             * （见 autoSidebarOwnershipHasCapacity），这里绝不允许挤掉别的 scope 仍然有效的 owner。
             *
             * 覆盖闸门（时序加固）：这次打开可能在**调用内部**就已经被重入结算（宿主同步发布 inventory，
             * 见上面「已发出」标记的说明），结算会把**真实 tabId** 写进这条账本条目。那条条目比占位强，
             * 绝不能用 tabId=null 的占位把它覆盖回「落地证据还没到」：覆盖会让这条账本条目短暂失去
             * tabId 绑定（紧接着的声明式 recordSidebarTab 通常会按当时的证据重新写下绑定，但那条写入
             * 依赖「此刻还读得到 tabId」；读不到时这次丢失就一直留着），此后重挂载 / 重收养只能看到共享
             * 账本，绑定失配即退化 manual，Auto 再也收不回这个 tab——与本次加固要修的症状同类。
             * 只放行「没有 tabId」的写入（含条目缺失 / 畸形值），其余一律保留现场。
             */
            const landedOriginEntry = sidebarAutoOriginRef.current.get(key);
            if (sidebarAutoOriginTabIdOf(landedOriginEntry) === null) {
              sidebarAutoOriginRef.current.set(
                key,
                sidebarAutoOriginEntry(sidebarSessionId, rootSessionId, resourceAddress, null),
              );
            }
          }
          if (splitToken !== null) {
            let acknowledged = true;
            if (markSidebarSplitOpen !== null) {
              try { acknowledged = markSidebarSplitOpen.call(config, splitToken) !== false; } catch { acknowledged = false; }
            }
            if (!acknowledged) {
              cancelPendingSidebarSplit("resource-not-acknowledged");
            } else if (sidebarSplitIntentRef.current?.token === splitToken) {
              sidebarSplitIntentRef.current.resourceIssued = true;
            }
          }
          // 记录必须发生在 openResource 之后：它读的是宿主提交后的 active tab，是打开的证据。
          // openProof 把「发出之前地址上没有 tab」这条因果证据一路带进来源判据（见 recordSidebarTab）。
          const opened = recordSidebarTab(key, resourceAddress, effectiveOrigin, openProof);
          // 只要这次打开的 tab 已经落定，就不能留下 opening 记录：它的语义是「这次打开还没有确定
          // 证据」（split 事务仍在等待 pane 证据、或本来就没有事务时都一样）。残留的 opening 会让
          // 用户收回这个 tab 之后的下一次同步把关闭记录重新建回来（<< 复活），并把之后的点击挡成
          // 「点了没反应」——在途状态一律由上面的 split 意图与取消路径负责收口。
          if (opened) sidebarTabOpeningRef.current.delete(key);
          // openResource 可能已经同步提交 tab：立即推进一次同步，让同 pane 回退不依赖下一轮 observer。
          // 若宿主稍后才渲染 DOM，keepMounted + observer/轮询仍会继续补偿。
          // 旧闭包绝不允许在新 surface 上推进同步：中间的宿主调用可能已经触发一次重挂载或 A→B→A
          // 回返，那时这份闭包手里的快照会把新 Panel 的账本当成本轮的旧状态处理。新 Panel 自己的
          // 下一轮外部同步会按真实 inventory 继续收口。
          if (sidebarSurfaceStillCurrent() === true) syncSidebarTabs();
        } catch {
           if (sidebarSplitIntentRef.current?.key === key) cancelPendingSidebarSplit("resource-failed");
           sidebarTabOpeningRef.current.delete(key);
           /* 宿主暂时打不开/关不掉这个地址：只影响这一次侧栏动作，状态绝不被污染。 */
         }
        finally {
          pending.delete(key);
          /**
           * 自动动作收尾时释放在途记账（split busy、准备失败、layout 失效、open 抛错、surface 变化、
           * 被撤销都走这里）。必须按 surface 是否仍是出发时那一份分成两种行为：
           *
           * - 仍是出发时那一份：历史行为逐字不变——预留必须释放（否则一次失败会被永久记成「已经
           *   打开过」，该资源在本次运行里再也打不开），打开没有真正发出时撤销残留来源，并结算用户
           *   在这个窗口里留下的手动意图；
           * - generation 已经换掉（组件重挂载，或同一个实例 A→B→A）：只能清理**明确属于本实例这一次
           *   动作**的在途记录——预留是本实例的 Map，且候选选择在预留存在期间绝不会为同一个 key 再选
           *   一次，因此这一刻它只可能是本次动作写下的那一笔。共享 Auto 账本（来源 / 抑制 / 重试）与
           *   手动意图一律不碰：openIssued 为假说明本次动作从来没有发出过 openResource，此刻那个 key
           *   上的来源只可能属于新 generation 已经成功打开的那次动作（旧实现无条件 delete 会把它清掉，
           *   新 Panel 从此再也认不出自己开出的 tab，资源结束后也不会自动关闭它）。
           */
          const surfaceCurrent = sidebarSurfaceStillCurrent() === true;
          if (autoContext !== null) {
            sidebarAutoReservationRef.current.delete(key);
            if (surfaceCurrent === true && autoContext.kind === "open" && openIssued !== true) {
              sidebarAutoOriginRef.current.delete(key);
              // 本次打开没有发出：把 key 记进失败屏障，同一批微任务里绝不再重选它（见其说明）。
              sidebarAutoFailedKeysRef.current.add(key);
            }
            if (surfaceCurrent === true && openIssued === true) sidebarAutoFailedKeysRef.current.delete(key);
          }
          /**
           * 在途动作收尾后立刻结算用户在这个窗口里表达的手动意图：手动恒优先，绝不因为「那次点击撞上
           * 了 pending 锁」而丢失。没有意图时这一步是幂等空操作。
           *
           * 只由仍然属于当前 surface 的闭包结算：applyPendingManualIntent 会改共享的来源 / 抑制 / 重试
           * 账本，并可能派发新的打开或关闭动作；surface 换代后这些收尾属于新 Panel 的下一轮外部同步。
           */
          if (surfaceCurrent === true) applyPendingManualIntent(key);
        }
      };

      /**
       * 批量关闭的唯一入口（主代理行 = 当前 root 的运行中专家/分片；空闲分组标题行 = ready 专家/已结算 fan-out 的空闲分片）。
       *
       * 与单会话箭头共用的三条并发与生命周期边界：
       * 1) 聚合锁覆盖整段 await 序列：双击/连击只允许第一次穿过，pending 期间按钮 disabled + aria-busy；
       *    锁按 (sidebar session, root) 组合键隔离，只拒绝**同一个 surface** 的重复点击——别的
       *    root/session 的批量按钮保持可用，绝不被一个与它无关的在途序列（甚至永不 settle 的
       *    宿主 Promise）阻塞；
       * 2) 候选集合在**点击那一刻**从同一个 inventory 快照固定下来（渲染期算好、随点击闭包传入），
       *    后续再点同一个按钮也不会把新出现的 tab 混进这一轮；但这个快照只用来决定「处理哪些候选」，
       *    真正调用 close 之前必须逐个重读**当前** inventory：等待前一个候选的 close 期间，同一个 tab
       *    可能已经被单项入口成功关掉，按旧快照再 close 一次就是重复副作用。inventory 读不到时
       *    fail-closed 跳过，绝不按 active tab 猜；
       * 3) 每次 await 前后都过 surface 闸门（mountedRef / currentRootRef / currentSidebarSessionRef
       *    三条既有判据 + 不可复用的 surface 令牌）：root 或 sidebar session 切换、组件卸载，以及
       *    「切走又切回同一组值」（A→B→A）之后立即停止后续关闭，绝不让旧点击继续操作新 surface。
       *
       * 单项失败严格隔离：close 同步抛错或返回 rejected Promise 只跳过这一项并继续其余项，
       * 也绝不把失败项标成已关闭——关闭记录一律交给宿主 inventory 与既有同步器确认（这里不删记录）。
       * 与单项入口共用同一个执行入口（closeSidebarTabWithLease）：候选上已经有一次关闭在途时等待它
       * 结算，上次成功就直接收口、上次失败才用当前 inventory 复核后接管一次有限重试；用户按下的
       * 批量意图绝不在冲突里被静默丢失，也绝不对已经关掉的 tab 重复调用 close。
       */
      const handleSidebarBatchClose = async (candidates) => {
        if (sidebarSurfaceStillCurrent() !== true) return;
        if (closeSidebarResource === null) return;
        if (Array.isArray(candidates) !== true || candidates.length === 0) return;
        // 锁只覆盖「这一个 surface」：同一个 scope 的重复点击被拦下，别的 root/session 的批量按钮
        // 完全不受影响（它的键不在集合里）。
        const scopeKey = sidebarBatchScopeKey(sidebarSessionId, rootSessionId);
        const pendingScopes = sidebarBatchPendingRef.current;
        if (pendingScopes.has(scopeKey) === true) return;
        pendingScopes.add(scopeKey);
        // 立刻进入 pending 态：按钮 disabled + aria-busy，第二次点击在 has 检查处被拦下。
        bump((value) => value + 1);
        try {
          for (const candidate of candidates) {
            // await 之前：surface 已经换掉（卸载、root/session 切换，或同一个实例 A→B→A 回返）即停止
            // 后续关闭。判据含不可复用的 surface 令牌，字符串重新相等不算「还是当前 surface」。
            if (sidebarSurfaceStillCurrent() !== true) return;
            /**
             * 候选形状闸门：候选必须**同时**携带 tabId 与资源地址（见 sidebarBatchCandidates）。
             * 缺任何一个都无法在副作用之前回答「这个 id 此刻仍然是我们要关的那个资源」——一律跳过
             * 这一项（其余候选继续处理），绝不退化成「只按 tabId 盲关」。
             */
            const tabId = text(object(candidate).tabId, null);
            const candidateAddress = text(object(candidate).address, null);
            if (tabId === null || candidateAddress === null) continue;
            /**
             * 每个候选调用前重新读**当前** inventory，并同时复核**地址**：候选集合只是点击那一刻的
             * 渲染快照，而等待前一个候选的 close 期间，同一个 tab 完全可能已经被别的入口（用户刚点的
             * 单项箭头、Auto 的关闭、旧 Panel 的迟到收尾）成功关闭，甚至这个 tabId 已经被宿主回收给了
             * 另一个资源。只有「present 且条目暴露的地址与候选地址逐字一致」才允许调用 close；
             * absent / recycled / unreadable 一律跳过这一项，绝不按 active tab 或渲染时快照猜一个 id。
             */
            if (sidebarTabPresenceInInventory(tabId, candidateAddress) !== "present") continue;
            // 批量关闭是显式手动语义：按候选地址把持久标记改写成 manual（手动恒优先）。
            writeSidebarAutoOwnership(sidebarSessionId, rootSessionId, candidateAddress, SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, "manual-close");
            /**
             * 与单 tab 关闭共用同一个执行入口（同一把 session + root + tabId 租约 + 结算信号）：
             * 这个 tab 上已经有一次关闭在途时（典型：用户刚点的单项箭头还停在宿主 Promise 里），
             * 批量必须等待它结算再决定——上次成功就直接收口（绝不重复 close），上次失败且当前
             * inventory 仍证明这个精确 tabId 存在**且地址一致**时才接管**一次**有限重试。用户按下的
             * 批量意图因此绝不在冲突里被静默丢失，也不会对已经关掉的 tab 重复调用 close。
             */
            await closeSidebarTabWithLease(tabId, {
              waitForCompeting: true,
              /**
               * 批量入口没有 key（它的候选只有 tabId + 地址）：按手动语义处理，不做验证收口——记录由
               * 同步层结算。地址必须传下去：它既是 preflight 的地址判据，也是等待竞争租约时等待者
               * 自己那份复核证据（没有地址证据的等待者遇到 recycled 结算只能跳过）。
               */
              verify: { key: null, address: candidateAddress, attemptToken: null, manual: true },
            });

            // await 之后：surface 已切换（含同一个实例 A→B→A 回返）时不再继续（已经发出的那一次
            // 关闭照旧由宿主结算）。判据含不可复用的 surface 令牌，字符串重新相等不算「还是当前 surface」。
            if (sidebarSurfaceStillCurrent() !== true) return;
          }
        } finally {
          // 只释放自己那一个 scope：旧序列的收尾绝不改写别的 root/session 的锁。
          pendingScopes.delete(scopeKey);
          // 重渲染与同步只服务**自己这一轮渲染**的 surface：root/session 已经切换时它们会去操作
          // 新 surface（旧 scope 的 bump 会让新 root 白白重渲染、旧闭包的 sync 会去同步旧 root）。
          // 判据含不可复用的 surface 令牌：同一个实例 A→B→A 之后字符串会重新相等，但这一轮批量序列
          // 已经不属于当前 surface，收尾交给新 Panel 自己的同步（bump 只由它自己发起）。
          if (sidebarSurfaceStillCurrent() === true) {
            bump((value) => value + 1);
            // 关闭序列结束后推进一次同步：候选集合与签名都按宿主 inventory 重新读取，
            // 真正被宿主关掉的 tab 由既有同步器（present/active/浮窗标题证据）结算，插件不抢先删记录。
            syncSidebarTabs();
          }
        }
      };

      /**
       * 标题行批量控件（主代理行与空闲分组标题行共用）。
       *
       * 三态渲染：
       * - 候选 > 0 且 close 可用：与单会话箭头同款的双左尖括号按钮（30×20），
       *   aria-label/title 说明会关闭几个 tab，type=button，preventDefault + stopPropagation 必须同时存在；
       * - inventory 已知且候选为 0：非交互蓝色实心圆（12px）占位，没有 button / hover / tabindex；
       * - inventory 不可读，或候选 > 0 但 close 不可用：什么都不渲染（未知态绝不假报「零」，
       *   「关不掉」也绝不退化成「零」）。
       *
       * 这里**不看 openResource**：批量关闭只读取公开 inventory 并调用 close()，不需要打开任何资源。
       * 以打开能力当门槛会让「宿主能关不能开」（或注入面只给了 close）的右栏整行失去控件。
       * 唯一的渲染能力门槛是左尖括号图标：缺它时连零占位也不渲染。
       *
       * 绝不使用 aria-pressed：这是批量命令，不是 toggle 状态。
       */
      const renderSidebarBatchSlot = (addresses, label) => {
        const state = sidebarBatchStateFor(addresses);
        if (state.kind === "none") return null;
        if (state.kind === "zero") {
          // 左箭头图标缺失时连零占位也不渲染：没有可用的批量按钮能力就不该出现「本行有批量入口」的暗示。
          if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
          return react.createElement("div", { className: "deg_expert_group_trailing" },
            react.createElement("span", {
              className: "deg_expert_group_sidebar_batch_zero",
              "data-zero": "true",
              "aria-hidden": "true",
            }));
        }
        if (typeof primitives?.IconChevronLeftOutlineRegular !== "function") return null;
        const count = state.candidates.length;
        const accessibleName = "在侧边栏关闭 " + count + " 个" + label;
        // 只看**当前** scope 的锁：别的 root/session 的在途序列绝不影响这一行的按钮状态。
        const pending = sidebarBatchPendingRef.current.has(sidebarBatchScopeKey(sidebarSessionId, rootSessionId));
        return react.createElement("div", { className: "deg_expert_group_trailing" },
          react.createElement("button", {
            type: "button",
            className: "deg_expert_group_sidebar_batch_action",
            title: accessibleName,
            "aria-label": accessibleName,
            "aria-busy": pending || undefined,
            disabled: pending,
            onClick: (event) => {
              event?.preventDefault?.();
              event?.stopPropagation?.();
              // 候选集合固定为这次渲染算出的那一份：点击后 inventory 再变也不影响本轮。
              return handleSidebarBatchClose(state.candidates);
            },
            onKeyDown: (event) => { event?.stopPropagation?.(); },
          }, react.createElement("span", {
            className: "deg_expert_group_double_arrow",
            "data-direction": "close",
            "aria-hidden": "true",
          },
          makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
          makeIcon(primitives, "IconChevronLeftOutlineRegular", { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }))));
      };

      /**
       * 标题后「在右侧栏打开 / 关闭」箭头按钮：与 DSH 原生子代理行同款箭头图标。
       *
       * 渲染条件缺一不可：宿主提供 `sidebarRight.openResource`、地址可解析、具名右箭头图标可用。
       * 任何一条不满足都不渲染按钮——空按钮或兜底警告图标冒充箭头都是误导。
       *
       * 两种形态共用同一枚 20×20 按钮：
       * - `>>`（默认，橙色）：打开。可关闭能力齐备时额外带 aria-pressed=false / data-open=false；
       * - `<<`（打开态，青色）：关闭该行对应的那个 tab。只有「close + active + 左箭头图标」三件能力
       *   全部具备、且已经用 active() 证据记录过 tabId 时才出现；缺任何一件就退回静态 `>>`，
       *   绝不显示一个点了不会关的假 toggle 状态。
       *
       * 首次打开时优先调用 DSH 公开 `split()`，用返回的 paneId 显式定位资源；只有旧宿主没有
       * split() 时才回退到 `preferNewPane: true`。这样不会把分栏失败静默成与 Expert Group 同 pane。
       * 已有子代理 pane 时必须显式传 paneId 并关闭 preferNewPane；否则宿主在无法再 split 时会把
       * 请求回落到当前 active pane，多个子代理就会错误地与 Expert Group 共用左侧 pane。
       * 日常打开/关闭子代理 tab 不改宽度；首次从 Expert Group-only 单 pane 分栏时，install
       * 事务会在 split() 前临时写入 50%，目标 tab 确认落到返回 pane 后保留可调的 50% 模式，
       * 失败则恢复 20% 锁定。其余 tab 操作只使用精确 tabId 记录/释放，不制造浮窗。
       * 只在右侧栏打开该子代理会话页，绝不切换主视图。preventDefault + stopPropagation
       * 必须同时存在：鼠标事件不得冒泡到任务名/第三行的导航处理器，键盘 Enter/Space 在按钮上的
       * 默认行为也要拦下（否则会触发最近的导航祖先）。宿主暂时无法打开该地址（seat 尚未 mint）
       * 时抛错由插件吞掉：既不影响主视图，也不影响同一行其它按钮。
       */
      const renderSidebarOpenAction = (address, label) => {
        if (openSidebarResource === null) return null;
        const resourceAddress = subagentChatAddress(address);
        if (resourceAddress === null) return null;
        if (typeof primitives?.IconChevronRightOutlineRegular !== "function") return null;
        const toggleCapable = closeSidebarResource !== null
          && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
          && typeof primitives?.IconChevronLeftOutlineRegular === "function";
        // 键含 rootSessionId：两个子代理、两个 root 的状态互不影响。
        const key = sidebarTabKey(sidebarSessionId, rootSessionId, resourceAddress);
        const openRecord = toggleCapable === true ? sidebarTabRecordsRef.current.get(key) : undefined;
        const isOpen = openRecord !== undefined;
        const accessibleName = (isOpen ? "在侧边栏关闭 " : "在侧边栏打开 ") + label;
        const buttonProps = {
          type: "button",
          className: "deg_expert_group_sidebar_action",
          title: accessibleName,
          "aria-label": accessibleName,
          onClick: (event) => {
            event?.preventDefault?.();
            event?.stopPropagation?.();
            return handleSidebarAction(key, resourceAddress);
          },
          onKeyDown: (event) => { event?.stopPropagation?.(); },
        };
        if (toggleCapable === true) {
          // aria-pressed 表达 toggle 语义；data-open 让主题样式精确命中打开态（青色 <<）。
          buttonProps["aria-pressed"] = isOpen;
          buttonProps["data-open"] = isOpen ? "true" : "false";
        }
        // 两个方向都是「两个同向图标」：打开是 >>，打开态是 <<。图标清单与 makeIcon 的具名图标
        // 契约一致，两条分支都已确认对应具名图标存在（右箭头在上面的渲染条件里，左箭头在能力判定里）。
        const arrowIcon = isOpen ? "IconChevronLeftOutlineRegular" : "IconChevronRightOutlineRegular";
        return react.createElement("button", buttonProps, react.createElement("span", {
          className: "deg_expert_group_double_arrow",
          "data-direction": isOpen ? "close" : "open",
          "aria-hidden": "true",
        },
        makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true }),
        makeIcon(primitives, arrowIcon, { size: 20, className: "deg_expert_group_double_arrow_icon", "aria-hidden": true })));
      };

      const renderChevron = (node, open) => react.createElement("button", {
        type: "button", className: "deg_expert_group_chevron", title: open ? "折叠" : "展开",
        "aria-label": open ? "折叠" : "展开", "aria-expanded": open, onClick: (event) => { event?.stopPropagation?.(); toggle(node); },
      }, makeIcon(primitives, open ? "IconChevronDownOutlineRegular" : "IconChevronRightOutlineRegular", { size: 14 }));

      /**
       * 每个代理节点固定三行；行内容与折叠状态无关，永不因展开状态隐藏任何一行。
       * 第一行：任务名（根节点是固定「主代理」，专家是最新 dispatch 短描述）；
       * 第二行：角色 · provider · model · effort 元数据；
       * 第三行：普通代理是 DSH 原生同源的 title · mode · activity；根节点只保留动态 title/activity。
       *
       * 第一行文案完整交给 CSS 处理，渲染层不做任何 grapheme 硬截断——完整文本同时是
       * React 文本、title（悬浮提示）与无障碍标签的来源，用户始终能读到全名。
       * 省略行为按行粒度区分（options.oneLine）：
       * - 默认 true：普通专家/根节点维持单行省略（.deg_expert_group_line 的
       *   overflow:hidden + text-overflow:ellipsis + white-space:nowrap），节点行高与树线语义不变；
       * - false：fan-out 分片第一行是「分片代号  任务名称」的组合文本，代号会占满单行额度，
       *   因此改用可换行样式（见 .deg_expert_group_shard_task），在右栏窄宽度下完整展示多行名称。
       *
       * 可导航的第一行与第三行是 role=button 的 div（不是嵌套 <button>，避免无效 HTML）：
       * 鼠标点击行为不变，同时支持键盘 Enter/Space，并带 tabIndex 与 aria-label。
       *
       * 标题后的侧栏箭头是**独立**的 <button>（任务标题行的内联位置，绝不包在可导航 div 里）：
       * 它只打开右侧栏的 subagentchat 页，不参与主视图导航，因此点击必须拦下冒泡。
       */
      const renderThreeLines = (node, options = {}) => {
        const source = object(node);
        const fullName = titleOf(source);
        const oneLine = options.oneLine !== false;
        const parentId = text(options.parentId, null);
        const clickableId = text(options.sessionId, text(source.sessionId, text(source.childId, null)));
        // 地址既决定主视图导航的目标形态（SubagentAddress 还是裸 session id），也决定侧栏
        // 箭头能否渲染；每行只解析一次，两条路径共用同一份结果。
        const address = subagentAddressOfChild(clickableId, parentId, source);
        // 工作区导航入口缺失（宿主未提供 uiWorkspace.openSession）时不渲染任何导航入口：
        // 行仍显示完整信息，但不再是 role=button，绝不留下点了没反应的按钮。
        const navigable = navigation.available === true && clickableId !== null;
        const onNavigate = navigable ? () => handleOpen(clickableId, address) : undefined;
        const onKeyDown = onNavigate === undefined ? undefined : (event) => {
          if (event?.key !== "Enter" && event?.key !== " ") return;
          // Space 默认会滚动页面，Enter 可能冒泡触发父级行为：两者都拦下。
          event.preventDefault?.();
          event.stopPropagation?.();
          onNavigate();
        };
        const taskLabel = "打开任务会话：" + fullName;
        const navigateProps = onNavigate === undefined ? {} : {
          role: "button",
          tabIndex: 0,
          "aria-label": taskLabel,
          onKeyDown,
        };
        const entry = catalogEntryOf(parentId, clickableId);
        const summary = agentSummaryOf(source, entry, authoritativeTitleOf(sessionsSnapshot, clickableId));
        const summaryProps = onNavigate === undefined ? {} : {
          role: "button",
          tabIndex: 0,
          "aria-label": "打开任务会话：" + (summary === "" ? fullName : summary),
          onKeyDown,
        };
        const metadata = metadataOf(source);
        const taskClassName = "deg_expert_group_line deg_expert_group_task"
          + (oneLine ? "" : " deg_expert_group_shard_task");
        const trailing = options.trailing === undefined ? null : options.trailing;
        const taskChildren = [
          react.createElement("div", { className: taskClassName, title: fullName, onClick: onNavigate, ...navigateProps }, fullName),
          renderSidebarOpenAction(address, fullName),
        ];
        if (trailing !== null) taskChildren.push(trailing);
        const taskLine = react.createElement("div", {
          className: "deg_expert_group_task_line" + (trailing === null ? "" : " deg_expert_group_task_line_trailing"),
        }, ...taskChildren);
        // 主代理批量控件作为标题行的相邻 flex 项，标题收缩省略时控件仍固定在标题末尾。
        // 其它专家 / 分片 / 空闲成员不传 trailing，单会话箭头结构保持不变。
        return react.createElement("div", { className: "deg_expert_group_row_main", "data-kind": source.kind || "expert", "data-expanded": true },
          taskLine,
          react.createElement("div", { className: "deg_expert_group_meta", title: metadata }, metadata),
          react.createElement("div", { className: "deg_expert_group_line deg_expert_group_content", title: summary, onClick: onNavigate, ...summaryProps }, summary));
      };

      /**
       * 代理节点的规范运行状态与官方目录证据。
       * 目录项来自会话投影 projectionsBySession[parentId].values.subagentCatalog（只保证
       * 身份/时间/模式/标签）；childId 由调用方给出（专家取 node.sessionId，分片取最新 attempt
       * 的 childId），缺失时只用快照证据。运行状态本身必须继续来自目录 activity 与 DEG 元数据，
       * 目录项缺失也绝不把 running 猜成 ready。
       */
      const runtimeStatusOfNode = (node, parentId, childId, options) => runtimeStatusOf(
        node,
        catalogEntryOf(parentId, childId ?? text(object(node).sessionId, null)),
        options,
      );

      const renderExpert = (node, index, parentId) => {
        // 轻量快照里没有活动证据的专家行渲染中性圆点（不声明已结束），完整快照不受影响。
        const runtimeStatus = runtimeStatusOfNode(node, parentId, undefined, { partial: partialSnapshot });
        return react.createElement("div", { key: node.id || node.sessionId || "expert-" + index, className: "deg_expert_group_node" },
          react.createElement("div", { className: "deg_expert_group_row", "data-status": runtimeStatus, "data-expanded": true },
            statusIcon(react, primitives, runtimeStatus),
            react.createElement("span", { className: "deg_expert_group_chevron_placeholder", "aria-hidden": "true" }),
            react.createElement("div", null, renderThreeLines(node, { sessionId: node.sessionId, parentId }))),
          Array.isArray(node.children) && node.children.length > 0
            ? react.createElement("div", { className: "deg_expert_group_children" }, node.children.map((child, childIndex) => renderExpert(child, childIndex, parentId)))
            : null);
      };

      /**
       * 空闲分组是容器而非代理：它的圆点直接用规范值 ready（绿色静态圆点），
       * 分组内成员各自按官方目录证据决定 running/ready。
       */
      const renderIdleGroup = (nodes, trailing) => {
        // 空列表同样要渲染：snapshot 已经加载（调用方只在有快照时调用）时「空闲子代理（0）」与零圆点
        // 是用户看得到的零状态；加载中 / 没有快照时调用方根本不会走到这里，绝不伪造零。
        const members = Array.isArray(nodes) ? nodes : [];
        const group = { kind: "idle-group", id: rootSessionId + "__idle__", taskName: "空闲子代理", status: "idle", children: members };
        const open = expand(group);
        const idleTitleChildren = [
          react.createElement("div", { className: "deg_expert_group_line deg_expert_group_task" }, "空闲子代理（" + members.length + "）"),
        ];
        // 空闲分组的批量候选只来自当前 idleChildren；运行中的专家或分片会被排除。
        // slot 与计数标题同属第三列的 inline flex，标题按可用宽度省略，slot 不会被推到行尾。
        if (trailing !== undefined && trailing !== null) idleTitleChildren.push(trailing);
        // 轻量快照下分组容器同样不声明「已结束」：它收纳的成员状态可能还没被完整读取，
        // 因此容器圆点跟随成员的中性态；完整快照仍按既有 ready 圆点渲染。
        const idleGroupStatus = partialSnapshot === true ? neutralRuntimeStatus : "ready";
        return react.createElement("div", { className: "deg_expert_group_idle_group", "data-expanded": open },
          react.createElement("div", { className: "deg_expert_group_row deg_expert_group_idle_header", "data-status": idleGroupStatus, "data-expanded": open },
            statusIcon(react, primitives, idleGroupStatus),
            renderChevron(group, open),
            react.createElement("div", { className: "deg_expert_group_idle_title_line" }, ...idleTitleChildren)),
          open ? react.createElement("div", { className: "deg_expert_group_children deg_expert_group_idle_children" }, members.map((node, index) => node.kind === "fanout" ? renderFanout(node, index) : renderExpert(node, index, rootSessionId))) : null);
      };

      const pendingSet = typeof react.useRef === "function" ? react.useRef(new Set()) : { current: new Set() };
      /**
       * 恢复重试的本地状态（票据 04）：{ rootSessionId, inFlight, error }。
       *
       * 为什么用 ref 而不是 state：与 pendingSet 同一模式——重试期间要立刻禁用按钮并显示
       * 进度，只靠 Host 快照（2.5s 轮询 + 完整快照缓存）会有明显延迟；这里用 ref + bump
       * 驱动一次同步重渲染。rootSessionId 绑定发起时的 root：同一实例切换 root 后，
       * 旧请求的迟到结果绝不会显示在新会话的横幅上（也不会把新 root 的按钮标成处理中）。
       *
       * error 只保存**重试动作本身**的失败细节（业务失败返回的 error 块或传输/校验异常），
       * 它是补充信息；恢复失败的主原因码始终来自 snapshot.recovery（Host 权威投影）。
       */
      const recoveryRetryRef = typeof react.useRef === "function"
        ? react.useRef({ rootSessionId: null, inFlight: false, error: null })
        : { current: { rootSessionId: null, inFlight: false, error: null } };
      /**
       * 任务管理动作（取消分片 / 重试分片 / 取消父任务）的唯一入口。三条并发边界：
       *
       * 1) 去重锁覆盖「确认弹窗 await + RPC 发送 + 尾随刷新」全程：占位发生在**发起确认之前**，
       *    因此确认弹窗还开着时的重复点击（双击、连击、键盘重复触发）会在 has(key) 处静默返回，
       *    既不会弹出第二个确认，也不会并发发出第二个 RPC。旧实现先确认后占锁，await 期间锁是空的，
       *    重复点击会穿过检查并各发一次请求。
       * 2) 确认返回后重读**当前**选中的根会话（currentRootRef 每次渲染同步更新）再发请求：
       *    确认期间用户切换了 root 时，动作绑定切走后的新会话，绝不用闭包里捕获的旧值。
       * 3) 确认期间或 RPC 在途期间组件被卸载（宿主切换 surface 的常见形态）时静默放弃：
       *    不发请求、不刷新、不写状态，杜绝迟到 setState 与卸载后重新拉起的轮询请求。
       *
       * 锁键沿用「动作类型 + parentTaskId + shardId」而不含 rootSessionId：同一实例切换 root 后，
       * 新树里同 id 的按钮在这段收尾窗口内也会显示处理中，直到动作结算（最长一次 RPC 时长）。
       * 这是刻意取舍——锁只需要在「同一实例的同一个动作」上成立，加入 root 会让锁出现第二事实源，
       * 反而可能在切换瞬间漏锁；跨实例的重复提交由 Host 侧的任务状态判定兜底。
       */
      const runAction = async (request, key, requiresConfirm, message) => {
        // 已卸载的实例不再接受新动作（按钮即使还残留在旧 DOM 上也不会发出请求）。
        if (mountedRef.current !== true) return;
        // 同键动作进行中：静默忽略，不排队也不提示。
        if (pendingSet.current.has(key)) return;
        // 先占锁再确认：锁必须在第一个 await 之前生效，否则重复点击会穿过上面的空闲检查。
        pendingSet.current.add(key);
        // 立刻让同键动作进入 pending 态（按钮 disabled + aria-busy），单击到确认弹窗之间的
        // 空隙里再次点击同样会被 has(key) 拦下。
        bump((value) => value + 1);
        try {
          if (requiresConfirm) {
            // 没有确认能力时什么都不做：破坏性操作绝不降级为静默执行。
            if (typeof config.confirm !== "function") return;
            let accepted = false;
            try { accepted = await config.confirm(message); } catch { accepted = false; }
            if (accepted !== true) return;
            // 确认弹窗打开期间 surface 可能已被卸载：卸载即静默放弃，不再发请求。
            if (mountedRef.current !== true) return;
          }
          // 重读当前选中 root：ref 在每次渲染同步写入，因此这里拿到的是「确认完成这一刻」
          // 用户实际选中的会话。空会话无法定位任务，直接放弃而不是发一条无目标的请求。
          const targetSessionId = typeof currentRootRef.current === "string" ? currentRootRef.current : "";
          if (targetSessionId === "") return;
          await callRpc(config, contextRef.current, { ...request, sessionId: targetSessionId });
          // RPC 在途期间卸载：不刷新、不写状态（动作本身已由 Host 侧收下，无需再补）。
          if (mountedRef.current !== true) return;
          // 走最新渲染的 refresh：确认期间切换过 root 时，用旧闭包刷新会把旧 root 的快照
          // 写回新 surface，也会为旧 root 多发一次请求。
          await refreshRef.current();
        } catch (error) {
          // 卸载后的失败没有可展示的错误面，静默丢弃，绝不 setState。
          if (mountedRef.current !== true) return;
          // 操作失败与快照失败共用标题错误面：旧快照继续可见，用户可直接重试。
          setState((previous) => ({ ...previous, error: error instanceof Error ? error.message : String(error) }));
        } finally {
          // 释放锁无条件执行（含提前 return 的分支）；只有仍挂载时才触发重渲染。
          pendingSet.current.delete(key);
          if (mountedRef.current === true) bump((value) => value + 1);
        }
      };

      /**
       * 恢复重试入口（票据 04）：调用 fanout-restore-retry，成功后刷新快照。
       *
       * 失败语义（与既有动作错误面完全隔离）：
       * - RPC 业务失败（restored:false）不是异常：Host 会把稳定原因码放在回执的 error 块里，
       *   这里记录到横幅的补充行，**不**写入 title 区的「快照读取失败」槽；
       * - 传输/校验异常（404 根会话不存在、网络失败）同样只记录补充行；横幅本身继续由
       *   snapshot.recovery 驱动，因此「失败保持错误态与原因码」不依赖一次成功的快照刷新；
       * - 成功（restored:true）后无论刷新是否成功，下一次成功快照都会把 recovery 变成 ok，
       *   横幅随之消失（快照不再含 failed 块）。
       *
       * 并发边界与 runAction 一致：卸载后不写状态；切换 root 后旧结果只落回旧 root 的账本
       * 而不污染当前 surface；同一 root 的在途重试直接忽略重复点击。
       */
      const retryRecovery = async () => {
        if (mountedRef.current !== true) return;
        const targetSessionId = typeof currentRootRef.current === "string" ? currentRootRef.current : "";
        if (targetSessionId === "") return;
        const previous = recoveryRetryRef.current;
        if (previous.rootSessionId === targetSessionId && previous.inFlight === true) return;
        recoveryRetryRef.current = { rootSessionId: targetSessionId, inFlight: true, error: null };
        bump((value) => value + 1);
        let failure = null;
        try {
          const result = await callRpc(config, contextRef.current, {
            action: "fanout-restore-retry",
            sessionId: targetSessionId,
          });
          if (result?.restored !== true) {
            const error = object(result?.error);
            const code = text(error.code, null);
            // restored:false 且没有 error 块 = 磁盘上没有可恢复快照（Host 的既有早退语义）：
            // 这不是失败，但也没有清除错误态，保持横幅并让用户知道重试没有恢复任何任务。
            failure = code === null
              ? { code: "NO_RESTORABLE_SNAPSHOT", message: "当前没有可恢复的持久化任务" }
              : { code, message: text(error.message, "") };
          }
        } catch (error) {
          failure = {
            code: "RETRY_FAILED",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const stillCurrent = mountedRef.current === true && currentRootRef.current === targetSessionId;
        recoveryRetryRef.current = { rootSessionId: targetSessionId, inFlight: false, error: stillCurrent ? failure : null };
        // 卸载或已切走：迟到结果不触发刷新/重渲染（新 surface 自己维护状态）。
        if (stillCurrent !== true) return;
        bump((value) => value + 1);
        // 无论成功还是失败都刷新：成功让横幅随 recovery=ok 消失，失败则把 Host 重新记录的
        // 原因码/任务树取回来（失败原因码仍以 snapshot.recovery 为权威）。
        await refreshRef.current();
      };

      const renderAction = (label, Icon, onClick, pending) => react.createElement("button", {
        type: "button", className: "deg_expert_group_action", title: pending ? label + "（处理中）" : label,
        "aria-label": pending ? label + "（处理中）" : label, "aria-busy": pending || undefined, disabled: pending, onClick,
      }, makeIcon(primitives, Icon, { size: 14 }));

      const renderShard = (task, shard, index) => {
        const shardKey = text(shard.shardId, "shard-" + index);
        const latestChildId = text(shard.childId, null);
        const status = statusOf(shard);
        // shardId 只在 parentTaskId 内唯一；折叠存储必须使用复合 id，避免不同 fan-out
        // 中同名 shard 互相覆盖。最新 attempt childId 仍是唯一导航目标。
        // 第一行文本：有任务名称时是"分片代号  任务名称"，没有名称的旧数据只有分片代号。
        // 拼接结果作为完整文本进入 renderThreeLines，并以 oneLine:false 走分片专用的可换行
        // 第一行样式：渲染层不再做 grapheme 截断，分片代号因此不会挤掉任务名称的显示额度。
        // shardId 仍是 key、data-shard-id 与取消/重试请求的唯一标识，
        // 展示文本绝不参与任何管理动作定位。名字为空白时按缺失处理，不显示悬空分隔符。
        const shardTaskName = text(shard.taskName, null);
        const shardNode = {
          ...shard,
          id: task.parentTaskId + ":" + shardKey,
          kind: "expert",
          taskName: shardTaskName === null || shardTaskName === shardKey ? shardKey : shardKey + "  " + shardTaskName,
          content: text(shard.prompt, ""),
        };
        const cancelKey = "cancel:" + task.parentTaskId + ":" + shardKey;
        const retryKey = "retry:" + task.parentTaskId + ":" + shardKey;
        const actions = [];
        // 票据 09：能力字段存在时严格按能力渲染；缺失时回退既有状态推导（旧 Host 兼容）。
        // 拒绝原因不再由界面解释——Host 已把「为什么不可用」收敛成稳定原因码，
        // 按钮的有无就是唯一可见结论，绝不给用户一个点了只会被拒绝的入口。
        const cancelCapability = capabilityAllowed(shard, "cancel");
        const retryCapability = capabilityAllowed(shard, "retry");
        const showCancel = cancelCapability === null ? ACTIVE_STATUSES.has(status) : cancelCapability === true;
        const showRetry = retryCapability === null ? RETRY_STATUSES.has(status) : retryCapability === true;
        if (showCancel) actions.push(renderAction("取消分片 " + shardKey, "IconStopFillRegular", () => runAction({ action: "fanout-cancel-shard", parentTaskId: task.parentTaskId, shardId: shardKey }, cancelKey, true, "确认取消分片 " + shardKey + "？"), pendingSet.current.has(cancelKey)));
        if (showRetry) actions.push(renderAction("重试分片 " + shardKey, "IconRefreshOutlineRegular", () => runAction({ action: "fanout-retry-shard", parentTaskId: task.parentTaskId, shardId: shardKey }, retryKey, false, ""), pendingSet.current.has(retryKey)));
        // 展示状态用规范运行状态，证据与第三行同源（最新 attempt 的 childId 查目录项）；
        // status 仍保留给取消/重试判定（管理语义不变）。
        const runtimeStatus = runtimeStatusOfNode(shardNode, rootSessionId, latestChildId);
        return react.createElement("div", { key: shardKey, className: "deg_expert_group_shard", "data-shard-id": shardKey, "data-status": runtimeStatus, "data-expanded": true },
          statusIcon(react, primitives, runtimeStatus),
          react.createElement("span", { className: "deg_expert_group_chevron_placeholder", "aria-hidden": "true" }),
          renderThreeLines(shardNode, { sessionId: latestChildId, parentId: rootSessionId, oneLine: false }),
          react.createElement("div", { className: "deg_expert_group_actions" }, actions));
      };

      const renderFanout = (task, index) => {
        const shards = Array.isArray(task.shards) ? task.shards : [];
        const open = expand(task);
        const incomplete = shards.filter((shard) => ACTIVE_STATUSES.has(statusOf(shard))).length;
        const parentKey = "cancel-parent:" + task.parentTaskId;
        // 父任务取消同样以 Host 能力为准；能力缺失时保留「有活跃分片或父任务仍活跃」的旧判定。
        const cancelCapability = capabilityAllowed(task, "cancel");
        const showCancel = cancelCapability === null
          ? (ACTIVE_STATUSES.has(statusOf(task)) || incomplete > 0)
          : cancelCapability === true;
        const actions = showCancel
          ? [renderAction("取消父任务（未完成 " + incomplete + " 个分片）", "IconStopFillRegular", () => runAction({ action: "fanout-cancel-parent", parentTaskId: task.parentTaskId }, parentKey, true, "确认取消父任务？未完成 " + incomplete + " 个分片。"), pendingSet.current.has(parentKey))]
          : [];
        // data-status 是对外的规范运行状态；管理状态改由 data-task-status 暴露，
        // 供了解 fan-out 内部结算的消费方读取，展示层不再出现 succeeded/failed 等词。
        const runtimeStatus = runtimeStatusOf(task, null);
        return react.createElement("div", { key: task.parentTaskId || "fanout-" + index, className: "deg_expert_group_fanout", "data-status": runtimeStatus, "data-task-status": statusOf(task) },
          react.createElement("div", { className: "deg_expert_group_fanout_header" },
            statusIcon(react, primitives, runtimeStatus),
            renderChevron(task, open),
            react.createElement("div", { className: "deg_expert_group_line deg_expert_group_task", title: titleOf(task), onClick: navigation.available === true && task.sessionId ? () => handleOpen(task.sessionId) : undefined }, titleOf(task)),
            react.createElement("div", { className: "deg_expert_group_actions" }, actions)),
          // 箭头函数按 (shard, index, array) 收到与旧 `renderShard.bind(null, task)` 完全相同的实参
          // （renderShard 只用前两个），但不再每次渲染都新建一个绑定函数。
          open ? react.createElement("div", { className: "deg_expert_group_fanout_shards deg_expert_group_tree_children" }, shards.map((shard, shardIndex) => renderShard(task, shard, shardIndex))) : null);
      };

      const children = Array.isArray(snapshot?.root?.children) ? snapshot.root.children : [];
      // 普通专家按实际运行状态分组，fan-out 父任务则按 manager 的聚合终态进入空闲组。
      // 轻量快照（partial）下没有活动证据的专家是 unknown：**仍进空闲组显示**（位置与完整快照
      // 一致，不再因证据缺失而换组），但圆点/文案保持中性，且不参与任何批量关闭或抑制清理
      // （见 sidebarNodeIsIdleMembership 与 idleSidebarResourceAddresses 的分工）。
      // fan-out 展示与取消/重试仍使用各自的 manager 状态，不受分组位置影响。
      const idleChildren = sidebarIdleChildren();
      const visibleChildren = children.filter((node) => !idleChildren.includes(node));
      // 两行标题后的批量 slot 内容：主代理行只覆盖运行中的普通专家/最新分片，空闲标题行只覆盖
      // idleChildren（因此天然继承同一套证据规则：unknown 成员不在其中，绝不成为关闭候选）。
      // 两者都只在渲染期纯读 openTabs inventory 与 close 能力（inventory 读不出来、
      // 或候选存在但 close 缺失时返回 null，不渲染任何东西）；打开能力不参与这里的判定。
      const rootBatchSlot = renderSidebarBatchSlot(runningSidebarResourceAddresses(), "运行中的子代理");
      const idleBatchSlot = renderSidebarBatchSlot(idleSidebarResourceAddresses(idleChildren), "空闲子代理");
      const root = snapshot?.root;
      const rootOpen = root === null ? true : expand(root);
      // 根行的圆点走与专家行同一条 partial 规则：轻量快照里没有活动证据的根会话渲染中性圆点，
      // 而不是「已结束」的绿色圆点；完整快照与旧宿主下与既有渲染逐字一致。
      const rootStatus = runtimeStatusOf(root, null, { partial: partialSnapshot });
      /**
       * 恢复失败横幅（票据 04）：**独立**于标题栏的「快照读取失败」错误面。
       *
       * 两者语义不同，绝不合并：
       * - 快照读取失败 = 这次 RPC 没拿到任务树（viewState.error + 重试按钮）；
       * - 恢复失败 = 任务树读得到，但持久化恢复失败（磁盘快照可能不完整，fail-closed 生效），
       *   需要重新读取持久化快照并重跑恢复。
       *
       * 横幅只由 Host 的权威投影 snapshot.recovery 驱动（旧 Host 缺失该块 ⇒ 不渲染）；
       * 本地 retry 状态只补充「重试中/重试失败」这一行，不替代原因码。
       */
      const recovery = snapshot?.recovery ?? null;
      const recoveryFailed = recovery !== null && recovery.status === "failed";
      const recoveryRetry = recoveryRetryRef.current;
      // rootSessionId 绑定：切换 root 后旧请求的 in-flight/error 不属于当前 surface。
      const recoveryRetryPending = recoveryRetry.inFlight === true && recoveryRetry.rootSessionId === rootSessionId;
      const recoveryCode = recovery === null ? null : text(recovery.code, "RESTORE_FAILED");
      // 补充行只在「当前仍是失败态，且重试失败与当前原因码同一来源」时显示：
      // Host 后来换了原因码（例如先 INVALID_SNAPSHOT、修复后变 BUDGET_EXCEEDED）时，
      // 旧重试的文案不再适用，必须让位给新的主原因码（两个稳定本地码始终保留）。
      const recoveryRetryError = recoveryFailed === true
        && recoveryRetry.rootSessionId === rootSessionId
        && recoveryRetry.error !== null
        && (recoveryRetry.error.code === recoveryCode
          || recoveryRetry.error.code === "RETRY_FAILED"
          || recoveryRetry.error.code === "NO_RESTORABLE_SNAPSHOT")
        ? recoveryRetry.error
        : null;
      const recoveryMessage = recovery === null ? null : text(recovery.message, null);
      const recoveryBanner = recoveryFailed !== true
        ? null
        : react.createElement("div", {
          className: "deg_expert_group_recovery",
          role: "alert",
          "data-recovery-status": "failed",
          "data-recovery-code": recoveryCode,
          // title 提供完整文案：可见行按一行省略，悬停仍可读到全部（仍受 Host 200 字上限约束）。
          title: recoveryMessage === null ? "恢复失败（" + recoveryCode + "）" : recoveryMessage,
        },
        react.createElement("span", { className: "deg_expert_group_recovery_text" },
          "任务恢复失败（" + recoveryCode + "）" + (recoveryMessage === null ? "" : "：" + recoveryMessage)),
        recoveryRetryError === null
          ? null
          : react.createElement("span", { className: "deg_expert_group_recovery_retry_error", role: "status" },
            "重试未恢复（" + text(recoveryRetryError.code, "RETRY_FAILED") + "）"
            + (text(recoveryRetryError.message, "") === "" ? "" : "：" + text(recoveryRetryError.message, ""))),
        react.createElement("button", {
          type: "button",
          className: "deg_expert_group_recovery_retry",
          // retryable=false 只影响提示语（结构性快照缺陷）；按钮仍保留：重试会重读磁盘，
          // 外部修复后仍可能成功，入口绝不隐藏。
          title: recovery.retryable === false
            ? "该原因通常需要修复持久化快照后才能恢复；点击会重新读取当前持久化快照"
            : "重新读取当前持久化快照并重跑恢复",
          "aria-label": "重试恢复",
          "aria-busy": recoveryRetryPending || undefined,
          disabled: recoveryRetryPending,
          onClick: retryRecovery,
          // 文字按钮：进度态把文案换成「重试中…」，可见且可被辅助技术读到。
        }, recoveryRetryPending ? "重试中…" : "重试恢复"));
      const body = viewState.loading && snapshot === null
        ? react.createElement("div", { className: "deg_expert_group_tree", "aria-busy": "true" }, react.createElement("div", { className: "deg_expert_group_skeleton" }), react.createElement("div", { className: "deg_expert_group_skeleton" }))
        : snapshot === null
          ? react.createElement("div", { className: "deg_expert_group_empty" }, "暂无 Expert Group 任务")
          : react.createElement("div", { className: "deg_expert_group_tree" },
            react.createElement("div", { className: "deg_expert_group_node deg_expert_group_node_root", "data-root": "true" },
              react.createElement("div", { className: "deg_expert_group_row", "data-status": rootStatus, "data-expanded": true }, statusIcon(react, primitives, rootStatus), renderChevron(root, rootOpen), react.createElement("div", null, renderThreeLines(root, { sessionId: root.sessionId, parentId: null, expanded: true, trailing: rootBatchSlot }))),
              rootOpen ? react.createElement("div", { className: "deg_expert_group_children" }, [
                ...visibleChildren.map((node, index) => node.kind === "fanout" ? renderFanout(node, index) : renderExpert(node, index, rootSessionId)),
                renderIdleGroup(idleChildren, idleBatchSlot),
              ]) : null));
      /**
       * 标题栏「Auto」开关（紧凑、与标题同一行，不遮挡标题与行内批量控件）：
       *
       * - 勾选态：权威读面（install 注入的 getter，每次渲染现读）叠加本地乐观值；
       * - 可访问性：input 自带 aria-label="Auto"，可见文字也是 Auto，说明性文案只放在 title 里，
       *   不新增任何长段落；
       * - 写面缺失（直接 createExpertGroupPanel 的旧宿主/单测）时 disabled：绝不渲染一个点了没反应的开关。
       */
      const autoOpenChecked = autoOpenDraft === null ? autoOpenEnabled() : autoOpenDraft === true;
      const autoOpenToggle = react.createElement("label", {
        className: "deg_expert_group_header_auto",
        title: "自动打开运行中的子代理侧栏会话",
      },
      react.createElement("input", {
        type: "checkbox",
        className: "deg_expert_group_header_auto_input",
        "aria-label": "Auto",
        checked: autoOpenChecked,
        disabled: writeAutoOpenSetting === null,
        onChange: (event) => toggleAutoOpen(event?.target?.checked === true),
      }),
      react.createElement("span", { className: "deg_expert_group_header_auto_label" }, "Auto"));
      return react.createElement("section", { className: "deg_expert_group", "data-version": version, "aria-label": "Expert Group" },
        react.createElement("header", { className: "deg_expert_group_header" },
          react.createElement("span", { className: "deg_expert_group_header_title" }, "Expert Group"),
          autoOpenToggle,
          viewState.error !== null ? react.createElement("span", { className: "deg_expert_group_error", title: viewState.error }, "快照读取失败") : null,
          viewState.error !== null ? react.createElement("button", { type: "button", className: "deg_expert_group_header_action", title: "重试", "aria-label": "重试", onClick: retry }, makeIcon(primitives, "IconRefreshOutlineRegular", { size: 14 })) : null), recoveryBanner, body);
    }
    Panel.displayName = "ExpertGroupPanel";
    return Panel;
  }


  /**
   * 原生右栏「视觉连续性遮罩」（仅 DEG 侧补偿，**不是动画抑制**）。
   *
   * 真实诊断闭环：root→child 时 DSH 原生 RightbarSeat 的 surface 按 session key 重挂载——current
   * 变化后旧 [data-sidebar-right-panel] 先被移除，新 panel 稍后才挂上（仍是 collapsed），直到 DEG
   * openSurfaceTab 之后新 panel 才拿到 data-sidebar-right-open。这段「旧已删、新未开」的 DOM 空窗里
   * 右栏整块消失；transition/transform/visibility 抑制只能作用于存在的节点，覆盖不到它。
   *
   * 因此在 openSurfaceTab 之前把旧 panel 的**非交互视觉壳**克隆一份钉在旧位置：
   * - 只复制上一帧的视觉结构：clone 子树所有 id 移除（避免 DOM id 重复）、输入控件清空
   *   value/textContent（绝不携带、也绝不读取用户数据）；
   * - host 固定定位、pointer-events:none、aria-hidden=true、overflow:hidden、z-index 高于 panel：
   *   不拦截交互、不进入可访问性树、不影响布局；
   * - 新 panel 真正 open（不同节点 + data-sidebar-right-open + aria-hidden 非 true）或 500ms 兜底
   *   到点即移除；每次只允许一个遮罩，新一次 capture 先释放旧的；
   * - 绝不调用 layout/openRightbar、不触发 session 导航、不改动旧/新 panel 的 style；
   * - 任何 DOM API 缺失或异常都安全降级为「不创建遮罩」，绝不影响打开流程。
   */
  const RIGHTBAR_CONTINUITY_OVERLAY_ID = "dsh-expert-group-rightbar-continuity-overlay";
  /** 兜底释放时间（毫秒）：新 panel 迟迟不 open 时绝不长期遮盖 UI。 */
  const RIGHTBAR_CONTINUITY_FALLBACK_MS = 500;
  function createNativeRightbarContinuityOverlay() {
    let host = null;
    let observer = null;
    let timer = null;
    let originalPanel = null;

    const removeHost = (element) => {
      if (element === null || element === undefined) return;
      try {
        if (typeof element.remove === "function") element.remove();
        else element.parentNode?.removeChild?.(element);
      } catch { /* 移除失败也不能留下引用 */ }
    };
    /** 幂等释放：清 timer、断开 observer、移除宿主。 */
    const release = () => {
      if (timer !== null) {
        try { globalThis.clearTimeout?.(timer); } catch { /* 可选 API */ }
        timer = null;
      }
      if (observer !== null) {
        try { observer.disconnect?.(); } catch { /* 可选 API */ }
        observer = null;
      }
      const current = host;
      host = null;
      originalPanel = null;
      removeHost(current);
      return true;
    };
    /** 是否已经出现「不同于旧节点、并且真的 open」的原生 panel。 */
    const hasOpenedPanel = () => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelectorAll !== "function") return false;
      let panels = [];
      try { panels = Array.from(doc.querySelectorAll("[data-sidebar-right-panel]") ?? []); } catch { return false; }
      for (const candidate of panels) {
        if (candidate === null || candidate === undefined || candidate === originalPanel) continue;
        if (isOwnOverlayNode(candidate) === true) continue; // 遮罩内部的克隆不算新 panel
        try {
          if (typeof candidate.hasAttribute !== "function" || candidate.hasAttribute("data-sidebar-right-open") !== true) continue;
          if (typeof candidate.getAttribute === "function" && candidate.getAttribute("aria-hidden") === "true") continue;
          return true;
        } catch { /* 单个候选读取失败继续看其它 */ }
      }
      return false;
    };
    /** 遮罩宿主自身或其中的节点（遮罩绝不能把自己算成「新 panel」，也不能被别的探测命中）。 */
    const isOwnOverlayNode = (node) => {
      if (host === null || node === null || node === undefined) return false;
      try {
        let current = node;
        for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
          if (current === host) return true;
          current = current.parentNode ?? null;
        }
      } catch { return false; }
      return false;
    };
    /**
     * 只清理非交互视觉壳：移除 id（避免 DOM id 重复）、把克隆降级为纯视觉节点
     * （去掉 data-sidebar-right-panel，否则遮罩自己的克隆会被当成「新 panel」而瞬间自我释放，
     * 也可能被右栏探测当成真实面板）、清空输入控件；不读取任何值。
     * data-sidebar-right-open 必须保留：原生 CSS 用它决定 panel 是展开还是 collapsed，
     * 去掉后克隆会渲染成滑出屏幕的 collapsed 状态，遮罩就失去意义了。
     */
    const scrubClone = (node, depth = 0) => {
      if (node === null || node === undefined || depth > 12) return;
      try { node.removeAttribute?.("id"); } catch { /* 单个节点失败继续 */ }
      try { node.removeAttribute?.("data-sidebar-right-panel"); } catch { /* 同上 */ }
      try {
        const tag = typeof node.tagName === "string" ? node.tagName.toUpperCase() : "";
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          node.value = "";
          node.textContent = "";
        }
      } catch { /* 同上 */ }
      let children = [];
      try { children = Array.from(node.childNodes ?? node.children ?? []); } catch { children = []; }
      for (const child of children) scrubClone(child, depth + 1);
    };
    const observeBody = () => {
      const doc = globalThis.document;
      const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
      const body = doc?.body ?? null;
      if (typeof Observer !== "function" || body === null || typeof body !== "object") return;
      try {
        observer = new Observer(() => { if (hasOpenedPanel() === true) release(); });
        observer.observe(body, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ["data-sidebar-right-open", "aria-hidden"],
        });
      } catch {
        try { observer?.disconnect?.(); } catch { /* 忽略 */ }
        observer = null;
      }
    };
    const startFallback = () => {
      try {
        timer = globalThis.setTimeout(() => { timer = null; release(); }, RIGHTBAR_CONTINUITY_FALLBACK_MS);
      } catch { timer = null; /* 没有可用调度器：最坏情况由调用方 release */ }
    };
    /** 抢拍旧 panel 的视觉壳；返回幂等 release（供访问终止路径收口）。没有可复制目标时返回 null。 */
    const capture = () => {
      release(); // 每次只允许一个遮罩
      const doc = globalThis.document;
      if (!doc || typeof doc.createElement !== "function" || doc.body === null || doc.body === undefined) return null;
      let panel = null;
      try { panel = typeof doc.querySelector === "function" ? doc.querySelector("[data-sidebar-right-panel]") : null; } catch { panel = null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try { rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null; } catch { rect = null; }
      if (rect === null || typeof rect !== "object") return null;
      const left = Number(rect.left);
      const top = Number(rect.top);
      const width = Number(rect.width);
      const height = Number(rect.height);
      // 定位拿不到有效数字时不创建：宁可没有遮罩，也不能把 fixed 层丢到左上角盖住 UI。
      if ([left, top, width, height].every((value) => Number.isFinite(value)) !== true) return null;
      let clone = null;
      try { clone = typeof panel.cloneNode === "function" ? panel.cloneNode(true) : null; } catch { clone = null; }
      if (clone === null || clone === undefined) return null;
      let created = null;
      try {
        scrubClone(clone);
        try {
          if (clone.style !== undefined && clone.style !== null) clone.style.pointerEvents = "none";
        } catch { /* host 本身已经 pointer-events:none */ }
        removeHost(typeof doc.getElementById === "function" ? doc.getElementById(RIGHTBAR_CONTINUITY_OVERLAY_ID) : null);
        created = doc.createElement("div");
        created.id = RIGHTBAR_CONTINUITY_OVERLAY_ID;
        created.setAttribute("aria-hidden", "true");
        created.setAttribute("style",
          "position:fixed;z-index:2147482999;pointer-events:none;overflow:hidden;background:inherit;"
          + "left:" + left + "px;top:" + top + "px;width:" + width + "px;height:" + height + "px;");
        created.appendChild(clone);
        doc.body.appendChild(created);
      } catch {
        removeHost(created);
        return null;
      }
      host = created;
      originalPanel = panel;
      // 新 panel 可能已经在这次同步提交里 open（例如 openTab 已提交）→ 立刻检查一次。
      if (hasOpenedPanel() === true) {
        release();
        return release;
      }
      observeBody();
      startFallback();
      return release;
    };
    return Object.freeze({ capture, release });
  }

  function installExpertGroupSidebar(ctx, deps) {
    const config = { ...object(deps), ctx };
    /**
     * 「任务管理」关闭时 Expert Group 不注册任何侧边栏入口。
     *
     * 返回幂等 no-op disposer（可重复调用且不释放任何别人的所有权），调用方因此可以沿用
     * 同一份 install/dispose 契约：关闭时直接释放既有 install 的 disposer，重新开启时重新
     * install 一次。这里只表示「本插件不注册」，不触碰 DSH 或 dsh-better-sidebar 的
     * tabsEnabled 偏好，也不回退到另一种注册方式。
     */
    if (config.taskManagementEnabled === false) return () => {};
    /**
     * 右栏拖拽手柄锁（Expert Group 页专属）：只在当前活动 tab 就是 Expert Group 时生效，
     * 切换页面、切换会话或卸载都会按同一条证据链恢复。状态与 DOM 写入都在这里，面板只通过
     * config.syncRightbarDragLock 请求一次重估（见下面 rightbarDragSyncImpl 的说明）。
     */
    const rightbarDragLock = createRightbarDragLock();
    /**
     * 首次分栏后的列宽配比（右栏内部的 40% / 60%，即视口的 20% / 30%）。
     *
     * 它与手柄锁是**两件事**、但共用同一条同步链路：手柄锁决定用户能不能拖总宽度，这里决定
     * split 容器里两条列轨各占多少。触发与恢复条件见 createSplitTrackRatio 的说明。
     */
    const splitTrackRatio = createSplitTrackRatio();
    /**
     * 列宽配比重估的读面（在 install 收尾时接线，见下面 splitTrackReader 赋值处的说明）。
     *
     * 读面必须以参数形式交给 splitTrackRatio：install 函数体里的 readSurfaceOpenTabs /
     * currentSurfaceSessionId 都是后置 const，而 openTargets() 会在函数体里就触发同步——
     * 直接在 splitTrackRatio 内部引用它们会撞上 TDZ（typeof 为 undefined），异常又被同步入口的
     * try/catch 吞掉，配比就永远写不进去。改成显式读面回调后，这条依赖是**编译器可见**的：
     * 调用点必须自己保证读面就绪。
     */
    let splitTrackReader = null;
    /** 请求一次列宽配比重估；读面还没接线时安全跳过（绝不猜组成、也不碰样式）。 */
    const requestSplitTrackSync = () => {
      // splitTrackReader 在 install 收尾前可能还未接线；disposed 优先阻断已排队的迟到回调。
      // 顺序不能反过来，否则早期注册期会在 disposed 的 TDZ 上求值。
      if (splitTrackReader === null || disposed) return false;
      return splitTrackRatio.sync(splitTrackReader.readTarget);
    };
    /**
     * 重估入口的真实实现：必须等 currentSurfaceSessionId / activeTabEvidenceOf（本闭包末尾才定义）
     * 就绪后才能求值，因此用一个可空引用转交——注册期（install 中段）与渲染期调用都不会踩到 TDZ。
     */
    let rightbarDragSyncImpl = null;
    /**
     * 请求一次「右栏拖拽手柄锁」重估。面板（挂载 / body 子树变更 / 2.5 秒轮询 / 可见性变化）与
     * openTargets（sessions 与 Better 状态通知）都经这里；dispose 后一律不再碰宿主 DOM。
     */
    const requestRightbarDragSync = () => {
      // 实现体在 install 函数体中段才赋值（它依赖同样后置的 currentSurfaceSessionId / 活跃 tab 读面），
      // 因此这里必须按引用转发，不能内联——注册期与渲染期调用都不会踩到 TDZ。
      // 引用为空时短路，既避开早期 disposed 的 TDZ，也阻断 dispose 后已经排队的迟到通知。
      if (rightbarDragSyncImpl === null || disposed) return;
      try { rightbarDragSyncImpl(); } catch { /* 手柄锁只是体验优化，绝不影响面板渲染。 */ }
    };
    /**
     * 面板卸载时的**无条件解锁**（离开 Expert Group 页这条边沿）。
     *
     * 为什么不用证据判定：面板卸载正是「这一页不再由插件渲染」的时刻，而宿主对活跃 tab 的
     * 提交可能还没落地——此刻读 active() 可能仍返回 Expert Group，于是锁会被错误地留在别的
     * 页面上（用户会突然发现右侧栏拖不动）。无条件解锁的方向永远安全：最坏情况是 Expert Group
     * 页在一次 surface 重挂载的空窗里短暂可拖，而重新挂载后的第一次同步会立刻锁回去。
     */
    const releaseRightbarDragLock = () => {
      if (disposed) return;
      try { rightbarDragLock.setLocked(false); } catch { /* 同上。 */ }
      // 面板卸载 = 这一页不再由插件渲染：列宽配比同样立刻交还宿主（下一轮同步会按最新组成
      // 重新写）。它与手柄锁同一方向、同一无条件的理由：宁可短暂地回到宿主默认比例，
      // 也绝不把插件的 grid-template-columns 留在别人的页面上。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响卸载。 */ }
    };
    /**
     * 品牌图标：两个注册面（Better tab 与原生 guide 卡片）共用同一个组件。
     *
     * react 缺失时 createBrandIcon 返回 null，注册描述符里就完全不写 icon 字段——
     * 图标只是外观，缺依赖必须保持「其余注册契约逐字节不变」，绝不因此改变 tab 的行为。
     */
    const brandReact = typeof config.react?.createElement === "function" ? config.react : null;
    const brandIcon = createBrandIcon(brandReact, object(config.primitives));
    // Cordis 对未声明服务的属性读取会抛错；所有可选依赖都经 get/direct 两段式
    // 安全探测。探测到 betterSidebar 后始终由它独占，禁用也绝不回退到 native。
    const optionalService = (name) => {
      try {
        const value = typeof ctx?.get === "function" ? ctx.get(name) : null;
        if (value) return value;
      } catch { /* 服务未安装。 */ }
      try { return ctx?.[name] || null; } catch { return null; }
    };
    const better = config.betterSidebar || optionalService("betterSidebar");
    const sessions = config.sessions || optionalService("sessions");
    const tabs = config.sidebarRightTabs || optionalService("sidebarRightTabs");
    const nativeSidebar = config.sidebarRight || optionalService("sidebarRight");
    const slots = config.slots || optionalService("slots");
    const disposers = [];
    let disposed = false;
    /**
     * 每个 surface 会话的「本次访问」记账（root 与 child 各自独立）。
     *
     * 实测症状：root → child 后右栏空白、刷新 child 才显示；再切回 root 时 root 的右栏又是错的。
     * 根因是宿主右栏 surface/store 按 session 懒创建、binding 由 passive effect 提交，而
     * 插件解析出的当前可见会话可能早于宿主 surface 绑定完成：
     * - Better 0.19.1 的 native surface 对「非当前会话」调用 openTabIn，只要方法存在就返回成功，
     *   但未 mint 的会话会静默 no-op；
     * - 于是在同步通知里发 scoped openTab，既会把 child 的请求落到旧 root binding，又会把目标
     *   永久记成「已打开/已展开」，后续通知再也不会重试。
     *
     * 记账模型（按「访问」而不是按 install 生命周期）：
     * - 「宿主已提交的活跃 surface」每次变化（Better getSnapshot().sessionId 变化；无证据的
     *   native/旧 Better 的当前可见会话）就是一次新的访问，拥有独立的一次打开 + 一次展开预算；
     * - 同一次访问里的重复通知绝不重复打开/展开（尊重用户手动关闭右栏）；
     * - 切走再切回、或同一 sessionId 的 surface 被重新挂载（宿主重新提交活跃会话）都会开新访问，
     *   于是会重新确保页面与右栏——这是 root→child→root 与「刷新 child 再回 root」的自愈路径。
     *   公开 API 观察不到「挂载」本身，只能用上述可观察边界近似：没有任何可观察变化的重挂载
     *   无法区分（属已知限制）。
     *
     * 每条记录里的字段都是「本次访问」的预算：
     * - visitEpoch：这些预算所属的访问代次；旧代次排下的任务在回调里一律作废；
     * - openAttempts / openFailures：本次访问已发出的打开请求次数、其中失败的次数（各有上限）；
     * - openState：idle | opened。只有在「当前可见 + 宿主已提交」时发出的请求才算 opened；
     * - expandDone：本次访问是否已成功调用过 layout.openRightbar（成功即消费，不再重复）；
     * - readinessRetries：本次访问内为「等宿主提交」排过的短重试次数（有上限）。
     * 另外跨会话还有一份 rightbarPresented（见下方「右栏展示生命周期」）：右栏这份**全局**展示
     * 是否已经展开过，它才是「切换 child 时不再重展开」的判据。
     */
    const surfaceRecords = new Map();
    /** 每次访问最多发出的打开请求次数（首次 + 通知/定时器驱动的有界重试）。 */
    const MAX_SURFACE_OPEN_ATTEMPTS = 3;
    /** 每次访问内自动定时重试的上限（其余重试机会由后续通知驱动，同样受上面的总次数约束）。 */
    const MAX_SURFACE_OPEN_RETRIES = 1;
    /** 打开请求的 defer 延迟：至少一个宏任务，排在宿主本次提交（surface/seat/binding）之后。 */
    const SURFACE_OPEN_DELAY_MS = 0;
    /** 打开失败后的短重试间隔（timer 纳入 dispose 清理）。 */
    const SURFACE_OPEN_RETRY_MS = 250;
    /** 「等宿主提交活跃会话」的短重试上限与间隔：通知先到、binding 稍后提交时靠它兜住。 */
    const MAX_READINESS_RETRIES = 3;
    const HOST_COMMIT_RETRY_MS = 250;
    const surfaceRecordOf = (sessionId) => {
      let record = surfaceRecords.get(sessionId);
      if (record === undefined) {
        record = {
          visitEpoch: 0,
          openAttempts: 0,
          openRetries: 0,
          openFailures: 0,
          openState: "idle",
          expandDone: false,
          readinessRetries: 0,
          commitState: "unknown",
          transitionRestore: null,
          continuityRelease: null,
        };
        surfaceRecords.set(sessionId, record);
      }
      return record;
    };
    /**
     * 安全收口一条访问记录上**尚未消费**的过渡抑制句柄。
     *
     * 句柄在 runSurfaceOpen() 里、openSurfaceTab() 之前创建（Better/native 的 openTab 可能同步把
     * 右栏面板置为展开，动画从那一刻开始），正常情况下会由 runRightbarExpand() 交给
     * callOpenRightbar() 并在延迟后恢复。凡是「这次访问不会再调用 layout.openRightbar」的终态
     * （访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、右栏读面不符、dispose…）
     * 都必须在这里立刻恢复，绝不能把 transition:none 留给宿主。
     */
    /** 收口一条访问记录上的连续性遮罩（幂等）。遮罩与过渡抑制是两件事，但生命周期完全一致。 */
    const releaseContinuityOverlayOf = (record) => {
      if (record === undefined || record === null) return false;
      const release = record.continuityRelease ?? null;
      record.continuityRelease = null;
      if (typeof release !== "function") return false;
      try { release(); } catch { /* 释放失败不能阻断其它收尾动作。 */ }
      return true;
    };
    const releaseTransitionRestore = (record, options = {}) => {
      if (record === undefined || record === null) return false;
      // 所有既有收口路径（访问过期/切走、右栏已由别的访问展开、打开重试用尽、宿主未提交、dispose…）
      // 都必须同时释放连续性遮罩，避免它长期遮住 UI。
      // 唯一例外是「同一个 surface 的访问代次变化」（options.keepContinuity）：那是宿主提交了新的
      // active surface，属于同一次切换窗口的中途通知，此时释放遮罩会把正在覆盖的 DOM 空窗重新暴露
      // 出来。遮罩仍然由「新 panel open / 500ms 兜底 / 打开失败 / 切走 / 终止边沿 / dispose」收口。
      if (options.keepContinuity !== true) releaseContinuityOverlayOf(record);
      const restore = record.transitionRestore ?? null;
      record.transitionRestore = null;
      if (typeof restore !== "function") return false;
      try { restore(); } catch { /* 恢复失败不能阻断其它收尾动作。 */ }
      return true;
    };
    /** 把某条记录绑定到本次访问代次；代次不同就重置该 surface 的访问预算（普通重复通知沿用）。 */
    const beginVisitFor = (sessionId, epoch) => {
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch === epoch) return record;
      // 新访问：先收口上一次访问遗留在记录上的抑制句柄（它属于旧访问，永远不会再被消费）。
      // 连续性遮罩例外保留：同一个 surface 的代次变化只是宿主提交了新的 active surface，切换窗口
      // 还在进行，遮罩必须继续覆盖空窗（由新 panel open / 兜底 / 终止路径收口）。
      releaseTransitionRestore(record, { keepContinuity: true });
      record.visitEpoch = epoch;
      record.openAttempts = 0;
      record.openRetries = 0;
      record.openFailures = 0;
      record.openState = "idle";
      record.expandDone = false;
      record.readinessRetries = 0;
      // 提交确认状态属于一次访问：新访问重新开始判断（否则「已确认 → 缺失」的边沿会反复触发）。
      record.commitState = "unknown";
      return record;
    };
    /**
     * 访问代次：宿主活跃 surface（有证据用 Better snapshot.sessionId，否则用 插件解析出的当前可见会话）
     * 与当前可见会话的组合一旦变化就 +1。作用：
     * - 旧代次排下的打开/展开任务会在回调里被 visitEpoch 校验拦掉（root 的旧 timer 不会污染
     *   child，反之亦然），并且代次变化时顺手取消上一个会话的待执行任务；
     * - 同一 sessionId 的 surface 重新挂载（snapshot 从 null 变回 S，或切走再切回）同样开新访问，
     *   因此会重新确保页面与展开。
     */
    let currentVisitKey = null;
    let currentVisitEpoch = 0;
    let currentVisitSessionId = null;
    /**
     * 同一 sessionId 的 surface 重挂载序号：current 与宿主活跃会话都没变、但宿主读面显示
     * 此前已确认的 expert-group 变成「明确没有 active tab」时 +1（见 openTargets 的边沿检测），
     * 用来强制开启一次新访问。持续缺失不会重复 +1，用户手动切到其它 kind 也不会 +1。
     */
    let currentRemountSerial = 0;
    const beginVisit = (current, hostSessionId) => {
      const key = String(current) + "|" + String(hostSessionId) + "|" + String(currentRemountSerial);
      if (key === currentVisitKey) return currentVisitEpoch;
      currentVisitKey = key;
      currentVisitEpoch += 1;
      // 代次变化：上一个可见会话的遗留任务立刻取消（它们属于旧访问，绝不能在这次访问里执行）。
      if (currentVisitSessionId !== null) {
        cancelSurfaceOpenTimer(currentVisitSessionId);
        cancelRightbarExpand(currentVisitSessionId);
        // 上一个可见会话遗留的过渡抑制同样属于旧访问：立刻收口，绝不留 transition:none。
        // 连续性遮罩要分两种情形：
        // - 可见会话真的换人了（current 变了），或宿主报 null（Better 禁用/未提交的终止标记）：
        //   旧遮罩已经没有意义，必须释放；
        // - 仍然是同一个可见会话，只是宿主提交了新的 active surface / 重挂载序号变化：这正是切换
        //   DOM 空窗的中途通知，遮罩必须继续覆盖（由新 panel open / 500ms 兜底 / 终止路径收口），
        //   否则它会在空窗中间消失，用户依旧看到右栏整块闪一下。
        releaseTransitionRestore(surfaceRecords.get(currentVisitSessionId), {
          keepContinuity: currentVisitSessionId === current && hostSessionId !== null,
        });
      }
      currentVisitSessionId = current;
      return currentVisitEpoch;
    };
    /**
     * 读宿主右栏真正承载的会话（Better 公开状态面；由 setSession() 在切换提交时写入并通知）：
     * - available=false：宿主没有该 API（旧 Better / native 路径），或属性读取/调用抛错 →
     *   调用方走兼容语义（退回 插件解析出的当前可见会话），异常绝不外泄；
     * - available=true, sessionId=null：有 API 但读不到活跃会话（未建立/切换中）→ 视为
     *   「尚未提交」：此时绝不发打开请求（那正是会落到旧 binding 被静默丢弃的情况），只等通知
     *   或有限重试；
     * - available=true, sessionId=S：宿主 binding 已提交到 S，是唯一可信的「已提交」证据。
     */
    const readHostActiveSurface = () => {
      let readSnapshot;
      try {
        const candidate = better?.getSnapshot;
        if (typeof candidate !== "function") return { available: false, sessionId: null };
        readSnapshot = candidate;
      } catch { return { available: false, sessionId: null }; }
      try {
        return { available: true, sessionId: text(object(readSnapshot.call(better)).sessionId, null) };
      } catch { return { available: false, sessionId: null }; }
    };
    /**
     * Expert Group 页的右栏宽度策略（纯插件侧的兼容桥，不修改 DSH 本体）。
     *
     * 目标：这一页的右侧栏宽度是**固定的视口宽度 20%**（1600px 视口 ⇒ 320px 写入宿主），
     * 由 applyRightbarWidth(sessionId) 在页面被激活之前写入宿主 layout store。
     *
     * 背景：右侧栏宽度是宿主 layout store 的 `rightbar` 偏好，为 null 时首次打开会被落成
     * `max(300, round(视口宽 × 45%))`。也就是说「打开时的宽度」只能在第一次 openRightbar
     * 生效之前，由已经写入的偏好决定，因此写入必须留在同步栈里、早于宿主的首次展开。
     *
     * 公开的 ctx.layout（ILayout）只有 openRightbar/closeRightbar 这类展示动作，没有
     * setRightbar；而 LayoutController 运行时实例把布局 store 的 bound actions 放在
     * `layout.panels` 上，其中存在 setRightbar(px)。因此这里逐层 duck-type 取用它：
     * 任何一层缺失、服务代理抛错或调用抛错都必须安全忽略——写入失败绝不能让右栏打开
     * 失败，此时宿主自己的默认值继续生效，契约不变。
     *
     * 记账口径是**按 surface 会话**（rightbarWidths），不是全局布尔值：宿主那份宽度是全局偏好，
     * 全局标记会让会话 B 因为「A 写过」而被跳过。同一会话只在「目标 px 变化」时重写，
     * 重复通知绝不把用户/宿主当前的宽度反复打回 20%。
     */
    /**
     * 「右栏此前已经展示过」的持久标记（跨浏览器刷新）。
     *
     * 症状：Ctrl+F5 / 重新打开浏览器后，第一次在主代理与子代理之间切换又会播放一次右栏展开动画。
     * 根因：rightbarPresented 与 rightbarWidths 一样都是 install 生命周期的内存变量，刷新后归零；
     * 而刷新后宿主 layout store 的 rightbarShown 也回到 false，DEG 必须继续调用
     * layout.openRightbar(true, false)（跳过调用右栏就可能不显示），于是这次调用又带出一次过渡动画。
     *
     * 因此这里把「曾经成功展示过右栏」持久化到 localStorage（带版本号的键）：
     * - 只有 layout.openRightbar 调用成功后才写入；
     * - 读取失败、写入失败（隐私模式、配额、storage 被禁用、无 DOM）都静默回退为「没有标记」，
     *   也就是刷新后仍会正常打开，只是这次会播放一次动画——绝不把异常带出插件；
     * - 标记只影响「这次打开要不要动画」，绝不用于跳过 openRightbar 调用。
     */
    const RIGHTBAR_PRESENTED_KEY = "dsh-expert-group:rightbar-presented:v1";
    /** 安全读持久标记：任何探测/读取异常都按「没有标记」处理。 */
    const readPersistedRightbarPresented = () => {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.getItem !== "function") return false;
        return storage.getItem(RIGHTBAR_PRESENTED_KEY) === "1";
      } catch { return false; }
    };
    /** 安全写持久标记：写入失败只影响「下次刷新要不要动画」，绝不影响本次打开。 */
    const persistRightbarPresented = () => {
      try {
        const storage = globalThis.localStorage;
        if (!storage || typeof storage.setItem !== "function") return false;
        storage.setItem(RIGHTBAR_PRESENTED_KEY, "1");
        return true;
      } catch { return false; }
    };

    /**
     * 右栏目标探测依赖的公开 DOM 标记清单：探测选择器与 MutationObserver 的 attributeFilter 共用同一份，
     * 避免出现「探测认某个标记、观察却不监听它」的漂移。
     */
    const RIGHTBAR_TARGET_MARKERS = [
      "data-sidebar-right-panel",  // 右栏面板本体
      "data-sidebar-right-open",   // 面板展开状态（动画开始）
      "data-shell-overlay",        // 覆盖层：其父元素即 AppFrame
      "data-rightbar-collapsed",   // AppFrame 折叠状态
      "data-rightbar-instant",     // AppFrame 瞬时展开状态
      // dsh-better-sidebar 0.12.x 的稳定宿主属性：宿主（body 下）出现/变化时也要重新命中目标。
      // 只在本清单末尾追加，绝不删除上面任何旧标记。
      "data-dsh-better-sidebar",
    ];
    /**
     * 自动打开右栏时需要临时抑制过渡的宿主元素：只认宿主已存在的公开 DOM 标记，不依赖 CSS module class，
     * 也不假设某一版 DSH 的组件实现。
     *
     * 1. `[data-sidebar-right-panel]`：右栏面板本体。它可能被宿主（不同 DSH 版本/运行时实现，例如把
     *    面板 portal 到 frame 之外）挂到 AppFrame 子树之外，因此不能假设它继承 frame 上的变量；
     *    唯一依赖的探测契约就是这个公开属性。它自带
     *    `transform: translateX(100%) ↔ none` + `transition: transform var(--ds-transition-duration-slow)`，
     *    是「刷新后首次打开仍看到滑入动画」的真实动画来源，必须单独抑制。
     * 2. AppFrame 根元素：`[data-shell-overlay]` 的父元素（覆盖层是 frame 的直接子节点），兜底认
     *    frame 自己的公开属性 `[data-rightbar-collapsed]` / `[data-rightbar-instant]`——它的
     *    grid-template-columns 过渡同样要抑制。内联自定义属性会沿祖先继承给子树，即使第 2 条落到
     *    frame 的包装元素上，frame 上的过渡也仍读得到被置 0 的变量。
     *
     * 3. dsh-better-sidebar 0.12.x：它在 document.body 下创建带稳定公开属性
     *    `[data-dsh-better-sidebar]` 的宿主，宿主的**直接子节点**里 class 含 panel 的是右面板
     *    （真实 CSS module 名带 hash，所以只能用「直接子 + class 含 panel」这两条稳定特征定位，
     *    绝不硬编码 hash）；右面板自带 transform/width 过渡，是这一版真实可见的滑入动画来源。
     *    同级还有 class 含 bottomPanel 的底部面板：它与右栏展开无关，必须用 :not() 明确排除，
     *    否则会连带抑制它的动画。注意不能写成无边界全文匹配 `[class*='panel']`（那会命中所有
     *    子孙节点，误伤面过大）。
     * 4. `#root`：Better 在它上面写 `margin-right: var(--dsh-sidebar-width)` 并对 margin-right 使用
     *    过渡，展开时整页位移的动画来自这里，因此也要抑制。它本身的 margin-right 原值不做任何改写。
     *
     * 返回描述符对象 { element, kind }：
     * - kind "panel"：真正的右栏面板（原生 [data-sidebar-right-panel] / Better 右面板）。它不仅会滑动，
     *   collapsed 状态还是 transform: translateX(100%) + visibility: hidden，所以除过渡外还要把
     *   transform/visibility 在窗口内钉成 none/visible（见 suppressRightbarTransition 的说明）；
     * - kind "frame"：AppFrame / #root 这类只承担布局过渡的容器，绝不写 transform/visibility。
     *
     * 同一元素被多个选择器命中时只返回一次（只要有一个来源是 panel 就按 panel 处理）；任何探测失败
     * （无 document、querySelector 抛错、DOM 结构不符）都返回已收集到的部分（可能为空）：
     * 调用方按「能抑制多少算多少」处理，绝不抛错。
     */
    const rightbarTransitionTargets = () => {
      const targets = [];
      const byElement = new Map(); // element → targets 下标：同一元素只保留一次
      const push = (element, kind) => {
        if (!element) return;
        const index = byElement.get(element);
        if (index !== undefined) {
          if (kind === "panel") targets[index].kind = "panel";
          return;
        }
        byElement.set(element, targets.length);
        targets.push({ element, kind });
      };
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return targets;
        // 先面板、后 frame：面板是可见动画（与瞬时闪烁）的真实来源。
        push(doc.querySelector("[data-sidebar-right-panel]"), "panel");
        const overlay = doc.querySelector("[data-shell-overlay]");
        if (overlay?.parentElement) push(overlay.parentElement, "frame");
        push(doc.querySelector("[data-rightbar-collapsed]"), "frame");
        push(doc.querySelector("[data-rightbar-instant]"), "frame");
        // dsh-better-sidebar 0.12.x：宿主的直接子节点中 class 含 panel 的右面板（必须排除 bottomPanel）。
        push(doc.querySelector("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"), "panel");
        // Better 的整页 margin-right 过渡挂在 #root 上：只抑制布局过渡，绝不写 transform/visibility。
        push(doc.querySelector("#root"), "frame");
      } catch { /* 探测失败：返回已收集到的部分，其余按「无法抑制」处理。 */ }
      return targets;
    };

    /**
     * AppFrame 是否报告右栏已折叠（用户手动关闭或从未展开）：
     * 折叠时不把 panel 钉成可见——那等于把用户关掉的右栏抢回来。读不到（无 document / querySelector
     * 抛错）时按「未折叠」处理，与旧行为一致。
     */
    const frameRightbarCollapsed = () => {
      try {
        const doc = globalThis.document;
        if (!doc || typeof doc.querySelector !== "function") return false;
        return doc.querySelector("[data-rightbar-collapsed]") !== null;
      } catch { return false; }
    };

    /**
     * 临时抑制右栏过渡（只在插件自动打开右栏这条路径上使用，作用域仅限本次命中的那几个元素）。
     *
     * 为什么用 CSS 变量 + 内联 transition 而不是改写 DSH：右栏面板的 .panel（transform）与 AppFrame
     * 的 .frame（grid-template-columns）、.handle（left）过渡都读 --ds-transition-duration-slow；
     * 在被抑制的元素上内联置 0ms 后，这一次变化瞬时完成，页面其它动画与用户手动拖拽完全不受影响
     * （不动 document 级样式、不写全局 CSS，也不改 DSH 源码）。内联 transition: none 同时是兜底：
     * 老版本或自定义主题若把过渡写成字面量时长，也仍然是瞬时的；对挂在 frame 之外的右栏面板而言，
     * 它还是唯一能覆盖其自身 transform 过渡的手段（frame 上的变量继承不到它）。
     *
     * 每个目标元素各自保存 transition 与变量的原值；返回的组合恢复函数按同样顺序逐元素还原，
     * 原本没有内联声明就删除。没有任何可用目标时返回 null——调用方照常调用 openRightbar，只是会播放一次动画。
     */
    const RIGHTBAR_TRANSITION_VAR = "--ds-transition-duration-slow";
    const suppressRightbarTransition = () => {
      /** 已经处理过的元素：同一元素被多个选择器命中（或 observer 多次回调）时只处理一次。 */
      const handled = new Set();
      const restores = [];
      /**
       * 对一个目标元素做临时抑制。所有目标都抑制 transition 与过渡时长变量；真正的 panel
       * （pinPanel=true）额外固定 transform:none + visibility:visible。
       *
       * 为什么 panel 还需要这两项：DSH 原生 panel 的 collapsed 状态是
       * transform: translateX(100%) + visibility: hidden，open 才是 none/visible，transition 只负责滑动。
       * 只把 transition 置 0 的话，React 在 surface 切换提交里仍可能先提交 collapsed/hidden 再提交
       * expanded/open，视觉上就是右栏本体「瞬间消失又出现」的闪烁。窗口内把 transform/visibility 直接
       * 内联钉成可见状态、提交完成后按原值（含 priority）归还，才能同时消除滑动与闪烁。
       * #root 与 bottomPanel 绝不做这件事：前者只管布局过渡，后者与右栏展开无关。
       */
      const applyToElement = (element, pinPanel) => {
        let style = null;
        try { style = element.style || null; } catch { style = null; }
        if (style === null || typeof style.setProperty !== "function") return;
        /** 读内联值与优先级：没有这些 API 的最小替身一律按「无内联声明 / 无优先级」处理。 */
        const readValue = (name) => {
          try { return typeof style.getPropertyValue === "function" ? style.getPropertyValue(name) : ""; } catch { return ""; }
        };
        const readPriority = (name) => {
          try { return typeof style.getPropertyPriority === "function" ? style.getPropertyPriority(name) : ""; } catch { return ""; }
        };
        // 写入顺序固定：先过渡变量、再 transition；真正的 panel 再补 transform/visibility。
        const writes = [
          { name: RIGHTBAR_TRANSITION_VAR, value: "0ms" },
          { name: "transition", value: "none" },
        ];
        if (pinPanel === true) {
          writes.push({ name: "transform", value: "none" }, { name: "visibility", value: "visible" });
        }
        const previous = new Map();
        for (const { name } of writes) previous.set(name, { value: readValue(name), priority: readPriority(name) });
        /**
         * 恢复单个属性：只有当前值**与优先级**都仍等于本次写入时才还原旧值/旧优先级。
         * 抑制窗口内被外部（宿主、主题脚本或页面代码）改写过的属性一律保留外部状态——绝不用旧值
         * 覆盖新值，也绝不动我们没写过的东西；读不到值（style 没有 getPropertyValue）的极简 DOM
         * 替身按旧行为直接还原，兼容最小测试替身与老宿主。
         */
        const restoreIfUnchanged = (name, written, writtenPriority, prev) => {
          try {
            if (typeof style.getPropertyValue === "function" && style.getPropertyValue(name) !== written) return false;
            if (typeof style.getPropertyPriority === "function" && style.getPropertyPriority(name) !== writtenPriority) return false;
            if (prev.value === "" || prev.value === null || prev.value === undefined) style.removeProperty?.(name);
            // 还原旧值时连旧优先级一起还原（原本没有优先级就写空字符串）。
            else style.setProperty(name, prev.value, prev.priority || "");
            return true;
          } catch { return false; /* 单个还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */ }
        };
        try {
          // 内联 !important：主题若用 transition: ... !important 覆盖，这里仍要保证这一次瞬时完成；
          // 不支持 priority 参数的宿主会忽略第三个实参（等价于原来的两参写入），行为安全降级。
          for (const { name, value } of writes) style.setProperty(name, value, "important");
        } catch {
          // 写入失败：把已经写进去的属性还原掉（同样只在仍是本次写入状态时才还原），跳过这个元素。
          for (const { name, value } of writes) {
            restoreIfUnchanged(name, value, readPriority(name), previous.get(name));
          }
          return;
        }
        // 写完后回读优先级：宿主可能规范化或忽略它，恢复判定必须用「实际写入的状态」。
        // 恢复顺序与写入相反（先撤销 panel 的可见性钉住，再恢复 transition 与变量），
        // 这样「只有过渡项」的目标恢复顺序仍与旧实现一致（transition → 变量）。
        const written = [...writes].reverse().map(({ name, value }) => ({
          name,
          value,
          priority: readPriority(name),
          prev: previous.get(name),
        }));
        restores.push(() => {
          // 每个属性各自独立判定：外部改过的保留外部状态，没改过的恢复（原本无内联声明就删除）。
          for (const entry of written) {
            restoreIfUnchanged(entry.name, entry.value, entry.priority, entry.prev);
          }
        });
      };
      const applyTargets = () => {
        // 右栏本身已折叠（用户手动关闭 / 从未展开）时不钉 panel 的可见性：那是把用户关掉的右栏抢回来。
        const collapsed = frameRightbarCollapsed();
        for (const target of rightbarTransitionTargets()) {
          if (handled.has(target.element)) continue;
          handled.add(target.element);
          applyToElement(target.element, target.kind === "panel" && collapsed !== true);
        }
      };
      // 当前可查到的目标立刻内联抑制：调用方保证这一步发生在 openSurfaceTab() 之前，
      // 因为 Better/native 的 openTab 可能同步展开 panel，动画在那时就已经开始。
      applyTargets();
      /**
       * 面板可能比这次抑制更晚挂载（seat 尚未 mint 出 surface、面板还没插到 DOM 上）：
       * 用一个**短生命周期** MutationObserver 盯住 documentElement/body 的子树，并监听五个公开标记
       * 的属性变化：data-sidebar-right-panel（面板本体）、data-sidebar-right-open（面板展开状态）、
       * data-shell-overlay（覆盖层，其父元素即 AppFrame）、data-rightbar-collapsed 与
       * data-rightbar-instant（AppFrame 的折叠/瞬时状态）。一旦面板出现或这些公开状态变化，就对
       * 新增目标执行同样的逐元素抑制（去重由 handled 保证）。
       * 仍然只改这几个元素的内联样式：不注入全局 style，也不动 document/body 的全局 transition。
       * 没有 MutationObserver、没有 document、observe 抛错时静默降级为「只抑制当前已存在的目标」。
       * 观察者由返回的恢复句柄 disconnect（dispose 与延迟恢复都会走它）。
       */
      let observer = null;
      try {
        const doc = globalThis.document;
        const Observer = globalThis.MutationObserver ?? doc?.defaultView?.MutationObserver;
        const root = doc?.documentElement ?? doc?.body ?? null;
        if (typeof Observer === "function" && root !== null && typeof root === "object") {
          observer = new Observer(() => { applyTargets(); });
          try {
            observer.observe(root, {
              childList: true,
              subtree: true,
              attributes: true,
              attributeFilter: [...RIGHTBAR_TARGET_MARKERS],
            });
          } catch {
            // observe 失败：断开并放弃观察，只保留已经写好的内联抑制。
            try { observer.disconnect(); } catch { /* 断开失败也不能阻断后续恢复。 */ }
            observer = null;
          }
        }
      } catch { observer = null; }
      if (restores.length === 0 && observer === null) return null;
      /** 恢复句柄：先 disconnect（避免恢复后又被重新抑制），再逐元素还原样式。 */
      return () => {
        const current = observer;
        observer = null;
        if (current !== null) {
          try { current.disconnect(); } catch { /* 断开失败不能阻断样式还原。 */ }
        }
        for (const restore of restores) {
          try { restore(); } catch { /* 单个目标还原失败不能阻断其它目标。 */ }
        }
      };
    };

    /**
     * 过渡抑制的兜底恢复延迟（毫秒）。
     *
     * 后台标签页、节能模式或被隐藏的 iframe 里 requestAnimationFrame 可能被严重节流甚至永不触发，
     * 因此**即使 RAF 可用也必须同时**安排一个有界 fallback timer：两条路径任一先到就取消另一方并
     * 恢复样式。250ms 足以覆盖正常两帧提交（约 32ms），又不会让 frame 长期停在 transition:none。
     */
    const RIGHTBAR_INSTANT_FALLBACK_MS = 250;
    /**
     * 安排过渡抑制的恢复（同一时刻只保留一个待恢复句柄，重复打开先恢复上一个）。
     *
     * 时机：必须在宿主完成这次提交之后才还原，否则过渡会在列宽变化落地前被重新打开。两条互备路径：
     * - 连排两帧 requestAnimationFrame：第一帧足够让 React 把宿主 store 的列宽变化提交到 DOM，
     *   第二帧在无过渡状态下完成布局后再还原；
     * - 有界 fallback timer：RAF 被节流/永不触发时保底恢复（没有 RAF 时它是唯一路径）；
     * - 任一触发即取消另一方，保证只恢复一次、也不留下没人消费的任务；
     * - 两类调度都不可用时立刻还原；任何调度异常都只影响「这次打开有没有动画」，绝不影响右栏显示。
     */
    let pendingInstantRestore = null; // { restore, cancel }
    const flushInstantRestore = () => {
      const pending = pendingInstantRestore;
      if (pending === null) return;
      pendingInstantRestore = null;
      try { pending.cancel(); } catch { /* 取消失败不影响立即还原。 */ }
      try { pending.restore(); } catch { /* 还原失败不能影响宿主布局。 */ }
    };
    const scheduleInstantRestore = (restore) => {
      flushInstantRestore();
      let settled = false;
      let firstFrame = null;
      let secondFrame = null;
      let fallbackTimer = null;
      /** 取消两类尚未执行的任务（恢复前与 dispose 共用）。 */
      const cancelPending = () => {
        try { if (firstFrame !== null) globalThis.cancelAnimationFrame?.(firstFrame); } catch { /* 可选 API。 */ }
        try { if (secondFrame !== null) globalThis.cancelAnimationFrame?.(secondFrame); } catch { /* 可选 API。 */ }
        try { if (fallbackTimer !== null) globalThis.clearTimeout?.(fallbackTimer); } catch { /* 可选 API。 */ }
      };
      const settle = () => {
        if (settled) return;
        settled = true;
        // 先取消另一方，保证只恢复一次，也不留没人消费的任务。
        cancelPending();
        if (pendingInstantRestore !== null && pendingInstantRestore.restore === restore) pendingInstantRestore = null;
        try { restore(); } catch { /* 见上：只影响这次打开有没有动画。 */ }
      };
      const cancel = () => { settled = true; cancelPending(); };
      // fallback 先排：RAF 被节流时它是唯一保底，绝不让 frame 长期停在 transition:none。
      try {
        fallbackTimer = globalThis.setTimeout(settle, RIGHTBAR_INSTANT_FALLBACK_MS);
      } catch { fallbackTimer = null; }
      let rafScheduled = false;
      try {
        const raf = globalThis.requestAnimationFrame;
        if (typeof raf === "function") {
          firstFrame = raf(() => { secondFrame = raf(settle); });
          rafScheduled = true;
        }
      } catch { /* RAF 不可用：完全依赖上面的 fallback timer。 */ }
      // 两类调度都不可用：立刻还原（最坏情况是这次打开又播放一次动画，绝不留抑制态）。
      if (fallbackTimer === null && rafScheduled !== true) {
        settle();
        return;
      }
      pendingInstantRestore = { restore, cancel };
    };

    /** 视觉连续性遮罩单例：每次 capture 先释放上一个，保证同时最多一个遮罩。 */
    const continuityOverlay = createNativeRightbarContinuityOverlay();

    /**
     * 本安装生命周期内、按 surface 会话记账的右栏宽度：sessionId → 已写入的 px。
     *
     * 为什么必须按会话隔离：右栏宽度是宿主 layout store 里的一份**全局**偏好，插件为会话 A
     * 写入的值会留在宿主里；如果沿用「整个 install 只写一次」的全局标记，会话 B 首次激活就会
     * 因为「A 已经写过」而被跳过，B 只能继承 A 的（可能已经过期的）宽度——这正是要修掉的
     * 「session A 的动作覆盖 session B 的状态」。按 sessionId 各自记账后，A 的写入只标记 A，
     * B 激活时一定会写自己的 20%，两者互不覆盖。
     */
    const rightbarWidths = new Map();
    /**
     * sessionId → 上次成功写入宽度时所用的**视口宽度**（px）。
     *
     * 与 rightbarWidths 同为 per-session 的目标值记账（同样只在 install 生命周期内有效、
     * dispose 一并清空），但记的是「那份像素值是按哪个视口算出来的」。窗口最大化 / 全屏后
     * 视口变化，这份记账就是常驻同步路径发现「必须重算」的判据（见 rightbarWidthViewportChanged）。
     */
    const rightbarWidthViewports = new Map();
    /**
     * 最近一次成功写入宽度的 surface 会话：宿主那份全局宽度当前归谁。
     *
     * 宿主 setRightbar 写的是全局 layout store；因此 session A → B → A 的每次 surface 切换都必须
     * 重新把当前会话的宽度写回：宿主里那份值此刻属于上一个会话，不能只因为 rightbarWidths 里
     * 留着 A 的旧目标值就跳过。同一次激活内的重复通知仍由各会话自己的记账去重，避免在 Expert
     * Group 页保持活跃时无意义地覆盖宿主状态。
     */
    let rightbarWidthSurfaceSessionId = null;
    /**
     * sessionId → 该会话的宽度模式（"expert" / "other" / "split-pending"）。
     *
     * 为什么必须按会话归属：宿主那份宽度虽然是全局的，但「这份宽度代表哪一种组成」只对写它的
     * 那个会话成立。用全局单值记 mode 时，root-a 的 other / split-pending 会被当成 root-b 的
     * 现状——B 的首次宽度预置被跳过、B 的 50% 判定被抑制。归属迁移时旧会话的 transient 记账
     * 随归属一起失效（见 claimRightbarWidthOwnership），新会话自己的条目一概不动。
     */
    const rightbarWidthModes = new Map();
    /**
     * openTargets 刚刚成功预置宽度的会话集合：用于避免同一同步栈末尾的活跃页确认再次重复写入。
     * 一旦证据表明当前不是 Expert Group，或这次预置被消费，就立即清除**该会话**的标记。
     */
    const rightbarWidthPreparedSessions = new Set();
    /** 最近一次被公开 active() 证明确实处于 Expert Group 页、且宽度已经落到宿主的会话集合。 */
    const rightbarWidthActiveSessions = new Set();
    /**
     * 同一个「未收敛的宽度 mismatch」的恢复写入记账：sessionId → { target, actualWidth, attempts }。
     *
     * 只记**恢复边沿**（宿主夺回了那份 px）的写入，不记首次接管 / 从其它分页返回 Expert Group /
     * 分栏事务的 50% 与收口 20% 这些正常写入；因此它既不会挡住正常写入，也不会让正常轮询把预算
     * 重置（见 RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS）。
     *
     * 事件同一性由 (target, 观测到的实际宽度) 决定，其中 target 是**按当前视口算出来的预期值**
     * （不是「上次成功写入的值」，见 recoverRightbarWidth）：
     * - 没有记账、预期 target 变了、或观测到的实际宽度变了 → 新的一次 mismatch 事件，重新获得完整预算；
     * - 三者都相同 → 同一个未收敛事件，预算用尽后一律拒绝写入。
     *
     * 「预期 target 变了」必须用当前视口重算：宿主持续 clamp 时视口挪一两个像素、20% 取整后仍是同一个
     * px，那不是新事件；只有窗口真正最大化到取整结果改变才是一次新事件。
     */
    const rightbarWidthRecoveries = new Map();
    /** 清除某个会话的恢复写入记账（收敛 / 所有权周期变化 / dispose 共用）。 */
    const clearRightbarWidthRecovery = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      rightbarWidthRecoveries.delete(sessionId);
    };
    /**
     * 恢复边沿的**有界预算**判定：返回 true 表示这一次「宿主夺回了宽度」的恢复写入允许执行。
     *
     * 只在恢复边沿调用（统一入口是 recoverRightbarWidth：recomputeOwnedWidth 的 hostReclaimed 分支
     * 与 confirmed 分支的同一判据），因此首次接管、从其它分页返回、分栏事务的 50% / 收口 20% 等
     * 正常写入完全不受影响。
     *
     * target 参数必须是**按当前视口算出来的预期值**（`Math.round(视口宽度 × 比例)`），不能传「上次
     * 成功写入的值」：宿主持续 clamp 时，视口 3200 → 3201 → 3202 的预期值都是 640，用预期值做事件
     * 同一性，这些视口变化才会被正确地归入同一个未收敛事件、不再重新获得预算。
     *
     * 预算在**调用时**消耗（而不是写入成功后）：写入本身几乎不会失败，而「尝试过就计数」能保证
     * 即使宿主每次都把写入吞掉，也不会出现无限重试——这正是本预算要挡住的形状。
     */
    const allowRightbarRecoveryWrite = (sessionId, target, actualWidth) => {
      if (sessionId === null || sessionId === undefined) return false;
      if (typeof target !== "number" || Number.isFinite(target) !== true) return false;
      if (typeof actualWidth !== "number" || Number.isFinite(actualWidth) !== true) return false;
      const recorded = rightbarWidthRecoveries.get(sessionId);
      const sameEvent = recorded !== undefined
        && recorded.target === target
        && Math.abs(recorded.actualWidth - actualWidth) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX;
      if (sameEvent !== true) {
        // 新的一次 mismatch 事件（首次观测 / target 变了 / 观测到的实际宽度变了）。
        rightbarWidthRecoveries.set(sessionId, { target, actualWidth, attempts: 1 });
        return true;
      }
      if (recorded.attempts >= RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS) return false;
      recorded.attempts += 1;
      return true;
    };
    /** 读取某个会话当前的宽度模式；没有已确认模式时返回 null。 */
    const widthModeOf = (sessionId) => (sessionId === null || sessionId === undefined
      ? null
      : rightbarWidthModes.get(sessionId) ?? null);
    /** 写入（mode 非空）或清除（mode 为 null）某个会话的宽度模式。 */
    const setWidthMode = (sessionId, mode) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthModes.get(sessionId) ?? null;
      const next = mode === null || mode === undefined ? null : mode;
      if (next === null) rightbarWidthModes.delete(sessionId);
      else rightbarWidthModes.set(sessionId, next);
      // 模式（= 宽度所有权周期）**发生变化**时，恢复事件记账随之失效：新周期里的第一次 mismatch
      // 是新事件，重新获得完整预算。两条刻意收紧的边界：
      // - 只在**已有非空模式**被换掉（expert ↔ other、或交还成 null）时清除。null → expert 是
      //   「首次确认这一份 expert 所有权」，恢复记账仍属于同一个周期，不能被重置；
      // - 无条件清除会让 confirmed 分支每一轮同步都重置预算（它每轮都用同一个值调用本函数），
      //   正常轮询就能无限重写——正是本预算要挡住的形状。
      if (previous !== null && previous !== next) clearRightbarWidthRecovery(sessionId);
    };
    /** 某个会话是否刚被 openTargets 预置过宽度（同一同步栈内不重复写）。 */
    const isWidthPrepared = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthPreparedSessions.has(sessionId);
    /** 标记/清除某个会话的「刚预置过宽度」状态。 */
    const setWidthPrepared = (sessionId, prepared) => {
      if (sessionId === null || sessionId === undefined) return;
      if (prepared === true) rightbarWidthPreparedSessions.add(sessionId);
      else rightbarWidthPreparedSessions.delete(sessionId);
    };
    /** 某个会话的 Expert Group 页是否已被 active() 证明落地（宽度已经成功写到宿主）。 */
    const isWidthActive = (sessionId) => sessionId !== null && sessionId !== undefined
      && rightbarWidthActiveSessions.has(sessionId);
    /** 标记/清除某个会话的「已确认活跃」状态。 */
    const setWidthActive = (sessionId, active) => {
      if (sessionId === null || sessionId === undefined) return;
      if (active === true) rightbarWidthActiveSessions.add(sessionId);
      else rightbarWidthActiveSessions.delete(sessionId);
    };
    /** 清除某个会话的全部 transient 宽度记账（模式 + 预置 + 已确认活跃）。 */
    const clearRightbarWidthMarks = (sessionId) => {
      setWidthMode(sessionId, null);
      setWidthPrepared(sessionId, false);
      setWidthActive(sessionId, false);
      // 模式/所有权周期结束时，这个会话的「恢复事件」记账一并失效：下一次 mismatch 是新事件。
      clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 把宿主那份全局宽度的归属迁移到 sessionId（每次成功写入后调用）。
     *
     * 旧主人的 transient 记账（模式 / 预置 / 已确认活跃）描述的是「宿主那份宽度属于它」时的状态，
     * 归属一换就不再成立：必须一起失效，否则 A 的 other / split-pending 会在 B 激活时被当成 B 的
     * 现状（B 的首次预置被跳过），切回 A 时又会挡住 A 自己的 50% 重放。新会话自己的条目一概不动；
     * per-session 的目标值 rightbarWidths 不受影响，切回时仍按该会话自己的目标重估。
     */
    const claimRightbarWidthOwnership = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return;
      const previous = rightbarWidthSurfaceSessionId;
      if (previous !== null && previous !== sessionId) clearRightbarWidthMarks(previous);
      rightbarWidthSurfaceSessionId = sessionId;
    };
    /**
     * 首次从 Expert Group-only pane 创建子代理 pane 的**按会话隔离**事务表：sessionId → 事务。
     *
     * 归属与并发边界：
     * - busy 只对本会话成立：同一 session 的第二次 split 仍被防重入（绝不产生竞争 pane/重复 tab），
     *   但别的 session 的在途事务不再阻塞本会话——用全局单例记这件事时，A 未收口的在途事务会让
     *   切到 B 之后的行尾箭头直接拿到 busy（用户看到的是「点了没反应」）。
     * - token / deadline / commit / cancel 全部按 token 反查**自己那一条**：迟到的 observer 回调、
     *   deadline 回调或取消请求只能收口它自己的事务，既不结算也不回滚别的会话。
     * - 会话切换、无可见 surface 与 dispose 只逐条取消表里的事务（各自清理自己的 transient 记账），
     *   宿主那份全局宽度的归属仍由当前 surface 的同步链路决定，绝不由旧事务的迟到回调改写。
     */
    const rightbarSplitTransactions = new Map();
    /** 按 token 反查仍然在途的事务；已被 commit/cancel 收口的 token 一律返回 null（迟到回调的安全边界）。 */
    const transactionOf = (token) => {
      if (token === null || token === undefined) return null;
      for (const transaction of rightbarSplitTransactions.values()) {
        if (transaction.token === token) return transaction;
      }
      return null;
    };
    /** 从表里移除自己那一条（按 identity 比对，绝不误删同会话后来居上的新事务）。 */
    const releaseSidebarSplitTransaction = (transaction) => {
      if (rightbarSplitTransactions.get(transaction.sessionId) === transaction) {
        rightbarSplitTransactions.delete(transaction.sessionId);
      }
    };
    /** 逐条收口全部在途事务（无可见 surface / dispose）：每条只清理自己所属 session 的 transient 记账。 */
    const cancelAllSidebarSplits = (reason) => {
      for (const transaction of [...rightbarSplitTransactions.values()]) {
        try { cancelSidebarSplit(transaction.token, { reason }); } catch { /* 单条收口失败不能阻断其余事务与 disposer。 */ }
      }
    };
    /** 分栏事务自己的 deadline 句柄，不能借用 panel 的 opening 记录或 observer 生命周期。 */
    const clearSidebarSplitDeadline = (transaction) => {
      if (transaction === null || transaction === undefined) return;
      const timer = transaction.deadlineTimer;
      transaction.deadlineTimer = null;
      if (timer === null || timer === undefined) return;
      try { globalThis.clearTimeout?.(timer); } catch { /* 收口路径必须继续执行。 */ }
    };
    /**
     * 为某个 surface 会话写入固定 20% 的右栏宽度；返回是否真的写了。
     *
     * 写入时机：只有该会话的 Expert Group surface 被激活（openTargets 里的当前可见会话）时才写，
     * 并且**同一会话不重复改写**——宿主里的这个值可能已经是用户拖拽或宿主自己算出的结果；
     * 视口宽度变化导致同一会话的目标 px 变化时会重写一次。
     *
     * 20% 是精确比例：插件不做任何最小值 clamp（宿主 setRightbar 自己有 clamp，它才是权威边界）。
     *
     * 写入前会 best-effort 同步宿主自己那份视口缓存：宿主 clamp 用的是 AppFrame 根元素宽度，
     * 冷启动时它可能还停在旧值，会把目标宽度夹小（2560 视口写 1280，宿主按 1280 缓存夹成 896），
     * 而插件的记账已认为「这个视口写过」，偏差不会自愈。同步值只取**能唯一、可靠读到的 AppFrame
     * 宽度**（见 hostAppFrameWidthOf），绝不拿 window.innerWidth 顶替；读不到就完全跳过同步。
     * 目标像素值仍按 window.innerWidth 的比例换算，本次已读取的同一个视口宽度贯穿始终。
     *
     * 兼容：layout 服务缺失、服务代理读属性抛错、setRightbar 不是函数或调用抛错时一律返回 false
     * 且**不记账**——写入失败不算应用，后续通知仍可重试，宿主自己的默认宽度继续生效。
     * 可选的视口同步 action 缺失、读属性抛错或调用抛错都不阻断既有 setRightbar 路径。
     */
    const applyRightbarWidth = (sessionId, ratio = RIGHTBAR_WIDTH_RATIO, force = false) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 视口宽度读不到（无 DOM 环境）就没有可换算的比例：放弃写入，保留宿主当前值。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const normalizedRatio = Number(ratio);
      if (!Number.isFinite(normalizedRatio) || normalizedRatio <= 0) return false;
      const target = Math.round(viewportWidth * normalizedRatio);
      if (force !== true && rightbarWidths.get(sessionId) === target) return false;
      const layout = config.layout || optionalService("layout");
      // panels 与两个 action 的属性读取必须**逐项独立隔离**：可选的 setViewportWidth 读属性抛错
      // （Cordis 服务代理对未声明属性就会抛）绝不能把必要的 setRightbar 一起挡掉。
      let panels = null;
      try { panels = layout?.panels ?? null; } catch { panels = null; }
      const setRightbar = methodOf(panels, "setRightbar");
      if (setRightbar === null) return false;
      const setViewportWidth = methodOf(panels, "setViewportWidth");
      // 宿主 setRightbar 按 layout store 的 viewportWidth 做上限 clamp，而那份缓存来自 AppFrame 根
      // 元素宽度（冷启动时可能还停在旧值，把目标宽度夹小）。只有能唯一、可靠读到 AppFrame 宽度时
      // 才先把它同步给宿主；读不到 AppFrame、尺寸非法时**不同步、不猜测宿主尺寸**，直接走原有写入。
      const appFrameWidth = hostAppFrameWidthOf();
      if (appFrameWidth !== null) {
        try { setViewportWidth?.call(panels, appFrameWidth); } catch { /* 校准不是展示侧栏的前置条件，失败时保留原有写入兼容路径。 */ }
      }
      try {
        // bound action 是闭包，不依赖 this；仍显式带上接收者，兼容将来改成方法式绑定。
        setRightbar.call(panels, target);
      } catch {
        // 调用失败不算写入成功：保持未记账（后续通知仍可重试），宿主当前宽度继续生效。
        return false;
      }
      rightbarWidths.set(sessionId, target);
      // 连同「这次换算用的视口宽度」一起记账：它才是「宿主那份像素值是否还对应当前视口」的判据，
      // 也是常驻同步路径发现窗口最大化 / 全屏 / 拖拽后必须重新写入的唯一来源。
      rightbarWidthViewports.set(sessionId, viewportWidth);
      // 写入成功即接管宿主那份全局宽度：旧会话的 transient 记账随归属一起失效（见 claim 说明）。
      claimRightbarWidthOwnership(sessionId);
      return true;
    };
    /**
     * 某个会话「上次写入宽度时用的视口宽度」是否已经变了（窗口最大化 / 全屏 / 拖拽 / 旋转屏幕）。
     *
     * 右栏宽度是视口比例，视口一变，之前写下的像素值就不再代表 20% / 50%：必须按新视口重新
     * 换算并写入。这是常驻同步路径**唯一**的重新写入判据——同一视口下的重复通知仍然一个字节
     * 都不写（保留「宿主里那份值可能是用户拖拽结果」的原有去重语义）。
     *
     * 没有写过宽度（没有记账）时返回 false：那种情况由「首次接管 / 从其它分页返回」等既有
     * 分支负责写入，不在这里重复承担。
     */
    const rightbarWidthViewportChanged = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const recorded = rightbarWidthViewports.get(sessionId);
      if (recorded === undefined) return false;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      return recorded !== viewportWidth;
    };
    /**
     * 读当前会话对应右栏面板的**实际渲染宽度**（px）。
     *
     * 这是「宿主里那份宽度到底是谁写的」唯一可验证的公开证据：只读
     * [data-sidebar-right-panel] 与 getBoundingClientRect()，不注册 class、不读任何私有状态。
     *
     * 一律 fail-closed（返回 null）：面板归属无法精确解析（零个 / 多个 / 缺
     * data-sidebar-right-session）、没有 getBoundingClientRect、矩形读不出来、宽度不是有限正数
     * （null / 0 / NaN / 负值 / 非数字）——这些都不构成「宽度等于某个值」的证据，调用方必须保留
     * 宿主当前值，等后续可验证的同步。
     */
    const readRightbarPanelWidth = (sessionId) => {
      if (typeof sessionId !== "string" || sessionId === "") return null;
      let panel = null;
      try { panel = rightbarPanelForSession(globalThis.document, sessionId); } catch { return null; }
      if (panel === null || panel === undefined) return null;
      let rect = null;
      try {
        rect = typeof panel.getBoundingClientRect === "function" ? panel.getBoundingClientRect() : null;
      } catch { return null; }
      if (rect === null || typeof rect !== "object") return null;
      let width = null;
      try { width = Number(rect.width); } catch { return null; }
      if (Number.isFinite(width) !== true || width <= 0) return null;
      return width;
    };
    /**
     * 宿主里那份右栏宽度是否**仍是插件上一次成功写入的 target**（见 rightbarWidths）。
     *
     * 为什么需要它：other 模式的宽度是**可调**的，用户在其它右侧分页上拖出的宽度由宿主持有。
     * 只有「面板实际渲染宽度 == 插件上次写的 px」才能证明宿主里那份值仍是插件写的（或用户恰好
     * 拖回了同一个值，等价于没有改动），此时按模式重算视口才不会覆盖用户的拖拽结果。
     *
     * 任何一环读不出来（没有上次 target / 面板宽度读不到 / 宽度对不上）都返回 false：宁可这一次
     * 不重算，也绝不猜测写入——宿主当前值原样保留，后续 confirmed / other 分支仍会按证据重估。
     */
    const hostWidthMatchesPluginTarget = (sessionId) => {
      const ownership = rightbarOwnershipOf(sessionId);
      return ownership !== null && ownership.matches === true;
    };
    /**
     * 一次性读出「宿主那份宽度 vs 插件 target」的**所有权观测**；读不出来时返回 null（fail-closed）。
     *
     * 返回 { target, actualWidth, matches, differs }：
     * - matches：面板实际渲染宽度仍等于插件上次写入的 target（所有权仍在插件手里）；
     * - differs：面板实际渲染宽度明确不等于 target（宿主夺回了那份 px）。
     *
     * 为什么合成一个函数：同一轮同步里既要判 matches 又要判 differs，还会消费恢复预算，分开调用会
     * 把同一份 DOM 证据读两遍（readRightbarPanelWidth → getBoundingClientRect 会触发布局）。
     * 任何一环读不出来（没有 target / 面板定位不到 / 宽度不是有限正数）一律返回 null——读不出来就
     * 不构成任何证据，调用方必须原样保留宿主当前值。
     */
    const rightbarOwnershipOf = (sessionId) => {
      const target = rightbarWidths.get(sessionId);
      if (typeof target !== "number" || Number.isFinite(target) !== true) return null;
      const actualWidth = readRightbarPanelWidth(sessionId);
      if (actualWidth === null) return null;
      const delta = Math.abs(actualWidth - target);
      return {
        target,
        actualWidth,
        matches: delta <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
        differs: delta > RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
      };
    };
    /**
     * 消费一次「所有权观测」：观测到收敛（实际宽度 == target）就清掉恢复事件记账。
     *
     * 这正是「状态清除」的唯一判据：宿主终于把 target 提交到 DOM 上之后，下一次 mismatch 必须是
     * **新的一次恢复事件**（重新获得完整预算），而不是被上一次已经用尽的预算永久挡住。
     * 读不出观测（null）时什么都不做——没有证据就不清除，保持原有记账。
     */
    const settleRightbarRecovery = (sessionId, ownership) => {
      if (ownership !== null && ownership.matches === true) clearRightbarWidthRecovery(sessionId);
    };
    /**
     * 恢复 / 视口重写的**统一入口**：所有「实际宽度明确偏离当前视口预期 target」的写入都走这里。
     *
     * 为什么必须统一：恢复写入的判据散落在两条分支上（confirmed 分支与 recomputeOwnedWidth 的
     * unknown 分支）时，只要其中一条把「视口变化」当成**独立**边沿、不消费预算，宿主持续 clamp 的
     * 场景就能被无限绕过——视口从 3200 挪到 3201 / 3202，20% 取整后仍是同一个 target 640，
     * 每一次视口变化都变成「一次新的恢复事件」，用户轻微拖动窗口边缘就会与宿主的 clamp 无限拉锯。
     * 因此两条分支共用这一份判定（per-session，按预期 target + 观测到的实际宽度记账）。
     *
     * 三条口径：
     * - **没有公开 DOM 证据（ownership 为 null：面板定位不到，或 getBoundingClientRect().width
     *   不是有限正数）就是不写**：恢复 / 视口重算入口一律 fail-closed，一个字节都不写，既不消费
     *   mismatch 预算，也绝不新建 / 重置一次 mismatch 事件。右栏宽度是宿主 layout store 里的**全局**
     *   偏好，插件只在能证明「这份 px 现在是谁的」时才允许改写它；读面不可用期间没有任何证据说明
     *   面板宽度偏离了 target，写下去就是无据改写宿主状态（而且是每次视口变化 / 通知 / 轮询都写的
     *   无界改写）。宿主那份值原样保留，等后续**可验证**的同步（readRightbarPanelWidth 恢复可读）——
     *   这条收紧只作用于恢复 / 视口重算入口，首次接管、从其它分页返回、分栏事务收口等正常写入
     *   语义完全不受影响；
     * - 实际宽度已经等于**当前视口下预期**的 target：这不是 mismatch，只是视口记账需要更新（例如
     *   宿主已经自己落到了正确宽度），正常写一次即可，不消费预算；
     * - 实际宽度明确偏离预期 target：同一个 (预期 target, 实际宽度) 的写入共用 per-session 预算，
     *   用尽后一律拒绝；预期 target 真正改变（窗口最大化导致取整结果变化）时是一次**新事件**，
     *   重新获得完整预算。
     *
     * 调用方负责「该不该尝试写入」的边沿判定（视口变化 / 宿主夺回宽度 / 模式证据），这里只负责
     * 「这次写入允不允许」：不读任何私有状态、不新增轮询或定时器。
     */
    const recoverRightbarWidth = (sessionId, ratio, ownership) => {
      if (sessionId === null || sessionId === undefined) return false;
      // 没有任何公开 DOM 证据：直接 fail-closed。这里刻意不调用 applyRightbarWidth（更不带 force），
      // 因此既不会写宿主宽度，也不会触碰恢复预算记账（不新建、不重置、不消费）。
      if (ownership === null || ownership === undefined) return false;
      // 预期 target 必须与 applyRightbarWidth 用同一套换算（同一视口宽度 × 同一比例、同样取整），
      // 否则事件同一性会把「同一份预期值」判成两次不同事件。
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return false;
      const expectedTarget = Math.round(viewportWidth * ratio);
      if (Math.abs(ownership.actualWidth - expectedTarget) <= RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX) {
        // 实际宽度已经等于预期 target：只是视口记账需要更新，不属于 mismatch，不消费预算。
        return applyRightbarWidth(sessionId, ratio, true) === true;
      }
      if (allowRightbarRecoveryWrite(sessionId, expectedTarget, ownership.actualWidth) !== true) return false;
      return applyRightbarWidth(sessionId, ratio, true) === true;
    };
    /**
     * 组成证据为 unknown 时，按**本会话已经证明过的宽度模式**重算「视口变化 / 宿主夺回宽度」。
     *
     * 两条触发边沿（都只作用于 expert 模式，见下面的 other 分支说明）：
     * 1. 视口宽度变了（窗口最大化 / 全屏 / 拖拽窗口边缘）：那份 px 不再代表原来的比例；
     * 2. **宿主夺回了那份 px**（面板实际渲染宽度 != 插件上次写入的 target）：DSH 重启后宿主从
     *    持久化布局恢复它自己那份旧值的时序正是「视口没变但那份值已经不是插件的」，
     *    只按视口判据永远等不到重算（见 rightbarOwnershipOf 的 differs）。
     *
     * 为什么「面板宽度 != 插件 target」就足以证明宿主夺回了所有权（只在 expert 模式消费）：
     * Expert Group 页的手柄由插件锁住（rightbarDragLock），用户在这一页**拖不动**右栏；而 20%
     * 又是插件独占的固定比例，不存在「用户在该页自定义宽度」的语义。因此这一页上面板宽度偏离
     * target 只有两种可能：宿主自己重渲染回了它那份持久化值，或用户恰好拖到了同一个值（等价于
     * 没有改动）。两种情形都应当把 20% 写回去——但**必须有界**（见 recoverRightbarWidth）。
     *
     * 为什么 unknown 仍然可以重算：组成读面（inventory / DOM）回答的是「当前右栏里有哪些页」，
     * 而这里消费的是本会话**自己**的宽度记账——它记的是「宿主那份 px 是按哪个比例、哪个视口
     * 写下去的」，与组成读面无关。视口一变（窗口最大化 / 全屏 / 拖拽窗口边缘），那份 px 就不再
     * 代表原来的比例（实测：1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640），因此
     * 必须按同一比例重算；否则读面暂不可用的宿主会一直停在过期宽度上。
     *
     * fail-closed 边界（绝不放松）：
     * - 没有任何模式证据（mode 为空且 prepared/active 都没有）时返回 false，一个字节都不写；
     *   组成读面不可用时**绝不臆测** 20% 或 50%，也绝不把 unknown 当成 confirmed；
     * - **没有宽度 DOM 证据（面板宽度读不出来）时同样一个字节都不写**：expert 模式虽然不要求
     *   「面板宽度仍等于插件 target」（那是 other 的可调保护），但**要求这条读面本身可用**——
     *   ownership 为 null 时 recoverRightbarWidth 直接 fail-closed，既不写宽度也不动恢复预算
     *   （见该函数第一条口径）。模式证据只回答「该写哪个比例」，不构成「可以无据改写宿主全局
     *   宽度」的证据；
     * - **other 模式额外要求宿主宽度所有权**：other 的 50% 是可调状态，用户可以在该页手动拖宽，
     *   仅凭「模式是 other」就重算会覆盖用户的拖拽结果。因此只有 hostWidthMatchesPluginTarget
     *   证明宿主里那份 px 仍是插件上次写的 target 时才重算；读不到或对不上一律不写（见该函数说明）。
     *   expert 模式不受此限制：20% 是插件**独占**的固定比例，不存在「用户在该页拖宽」的语义；
     * - **other 模式只认视口变化这一条边沿**：宿主夺回宽度在 other 模式里正是「用户拖过一次」
     *   的典型形状，据此重算会覆盖用户的拖拽结果，因此那一模式绝不消费 hostReclaimed；
     *   other 的视口重算还额外要求 hostWidthMatchesPluginTarget（实际宽度仍等于插件上次的 target），
     *   这条真实用户拖拽保护不受本预算逻辑影响，绝不放宽；
     * - expert 模式去重：视口没变、且宿主那份值仍等于插件 target 时什么都不做；
     * - 写入失败由 applyRightbarWidth 自己保证不记账，后续通知仍可重试；
     * - 手柄锁与组合归属语义完全不变：本函数不碰 rightbarDragLock，也不改写任何 transient 记账
     *   （prepared / active 保持原样，因此下一次视口变化仍然有据可依）。
     */
    const recomputeOwnedWidth = (sessionId) => {
      if (sessionId === null || sessionId === undefined) return false;
      const viewportChanged = rightbarWidthViewportChanged(sessionId) === true;
      // expert 模式下还有第二条触发边沿：宿主已经夺回那份 px（面板宽度不再等于插件 target）。
      // DSH 重启后宿主恢复持久化旧值的时序正是「视口没变但那份值已经不是插件的」，只按视口判据
      // 永远等不到重算。一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
      const ownership = rightbarOwnershipOf(sessionId);
      // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
      settleRightbarRecovery(sessionId, ownership);
      const hostReclaimed = ownership !== null && ownership.differs === true;
      if (viewportChanged !== true && hostReclaimed !== true) return false;
      const mode = widthModeOf(sessionId);
      // 只有已确认的模式才给出比例：expert = 20%，other = 50%。split-pending 不会走到这里
      // （在途事务在 rightbarDragSyncImpl 里更早 return，收口时也必然被改写成 expert/other/null），
      // 万一出现也一律不猜。
      let ratio = null;
      if (mode === "expert") {
        // 20% 是插件独占的固定比例：视口变化与「宿主夺回宽度」两条边沿都必须重算。
        ratio = RIGHTBAR_WIDTH_RATIO;
      } else if (mode === "other") {
        // other 是可调模式，**只认视口变化这一条边沿**：
        // - 宿主夺回宽度（面板宽度 != 插件 target）在 other 模式里恰恰是「用户拖过一次」的
        //   典型形状，绝不能据此重算，否则会把用户的拖拽结果覆盖成 50%；
        // - 视口变化本身也必须先证明所有权（面板宽度仍等于插件 target）才允许重算；
        // 读不到面板宽度时所有权不成立 → 一个字节都不写，用户的宽度原样保留。
        if (viewportChanged !== true) return false;
        if (ownership === null || ownership.matches !== true) return false;
        ratio = OTHER_RIGHTBAR_WIDTH_RATIO;
      } else if (mode === null && (isWidthPrepared(sessionId) || isWidthActive(sessionId))) {
        // prepared / active 只由**成功的 20% 写入**置位（openTargets 预置，或 confirmed 分支 /
        // 事务收口时按 20% 恢复成功），因此它们证明的模式就是 expert；这里绝不据此推断 50%。
        ratio = RIGHTBAR_WIDTH_RATIO;
      }
      if (ratio === null) return false;
      // 写入判据与 confirmed 分支**共用**同一份有界预算（见 recoverRightbarWidth）：视口变化本身不再
      // 自动等于「可以再写一次」——取整后仍是同一个 target 的视口变化不是新的 mismatch 事件，
      // 否则宿主持续 clamp 时轻微拖动窗口边缘就能无限重写。
      return recoverRightbarWidth(sessionId, ratio, ownership) === true;
    };
    /**
     * 自动展开右侧栏：按 surface 会话隔离 + 异步延迟执行。
     *
     * 两次实测反馈决定了这里的两个硬约束：
     * 1. 「新会话右栏偶尔短暂弹出又收回，必须 Ctrl+F5」——宿主 ui-sidebar-right 的
     *    RightbarSeat 用 syncPresentation({ shown: false }) → layout.closeRightbar() 上报
     *    「这个 surface 还没展开」，而宿主右栏 surface 的 expanded 状态是按 sessionId 隔离、
     *    由页面打开（openTab → planSetExpanded(true)）才置位的。在同一同步栈里紧跟页面打开
     *    调 layout.openRightbar，会赶在宿主完成本次提交（surface 建立、seat 就位）之前，
     *    随后被 seat 的「未展开」报文反手关掉——表现为闪一下又收回。因此展开必须 defer 到
     *    宿主提交之后：这里只安排一个异步回调，回调里才真正调用宿主公开契约
     *    ctx.layout.openRightbar(true, false)。
     * 2. 「点进子代理会话后右栏不展开」——child 是另一个 sessionId，有自己的 surface 与
     *    expanded 状态；用「整个 install 只展开一次」的全局布尔值管理，child 永远拿不到
     *    自己的机会。因此逐次访问的记账按 sessionId 隔离。
     *    （注意：上面那条历史结论针对的是「永不复位的整个 install 布尔值」；下面新增的
     *    rightbarPresented 记的是**右栏这份全局展示**，宿主明确报告 surface 没了就会复位，
     *    所以它既不会让 child 永远拿不到机会，也不会在切换 child 时重复展开。）
     *
     * 记账规则（每个 surface 会话独立 + 一份跨会话的「右栏展示」记账）：
     * - 每个 surface 的每次访问最多展开一次：调用成功即在本访问内消费，同一访问的后续通知
     *   绝不再排（用户此时手动关掉右栏，本次访问不会把它重新拉开）；
     * - 跨会话另记一份 rightbarPresented（右栏展示生命周期）：成功展开过一次后，继续切换到
     *   别的 child 只切换页面/tab 内容（openTab / openTabIn / scoped openTab），绝不再调
     *   layout.openRightbar——否则每进入一个 surface 都会重展开一次，表现为右栏闪烁；
     * - 只有宿主**明确**报告 Expert Group surface 没了（此前已确认的 active tab 变成
     *   「没有 active tab」）才结束这次展示生命周期，下一次访问允许再展开一次；
     * - 调用抛错：记一次失败，最多 RIGHTBAR_EXPAND_MAX_ATTEMPTS 次尝试（含短延迟自动重试），
     *   避免把「布局 store 临时不可用」变成永久失败；
     * - 宿主这一层没有 openRightbar：不消耗机会、也不排自动重试，交给后续通知再试——
     *   服务稍后可用时仍能展开一次，同时不会留下没人消费的定时器。
     *
     * 只对「当前可见 surface」调用（插件解析出的当前可见会话）：右栏是全局的，为后台 root 展开
     * 等于替用户切走当前视图，而页面都没打开就展开只会拉出一个空右栏。
     *
     * 安全边界：layout 服务缺失、Cordis 服务代理读属性即抛错、openRightbar 调用抛错、
     * 调度器（setTimeout）本身抛错或被 deferred 回调跨过 dispose，全部静默吞掉。自动展开
     * 只是锦上添花，绝不能让 Expert Group 页面打不开（页面默认选择仍由 Better openTab /
     * native openNativeTab 完成）。
     */
    const RIGHTBAR_EXPAND_DELAY_MS = 0; // 至少一个宏任务：排到宿主本次提交（surface/seat）之后
    const RIGHTBAR_EXPAND_RETRY_MS = 250; // 调用抛错后的短重试间隔
    const RIGHTBAR_EXPAND_MAX_ATTEMPTS = 3; // 每个 surface 的调用尝试上限（含自动重试）
    /** 已排队的异步展开：sessionId → timer handle（同一会话同时只保留一个）。 */
    const rightbarExpandTimers = new Map();
    /**
     * 调用失败次数：sessionId → attempts（只有真的调用过并抛错才累加）。
     * 属于「右栏展示生命周期」的预算：宿主明确报告 surface 没了（见 openTargets 的重挂载
     * 边沿）时整体清零，新生命周期重新拥有完整的尝试次数。
     */
    const rightbarExpandFailures = new Map();
    /**
     * 右栏「展示生命周期」记账（跨 surface 会话共用一份）。
     *
     * 实测症状：从主代理首次切到子代理时右栏首次打开动画正常；首次打开完成后再继续切换不同
     * 子代理，右栏会闪烁。根因与记账范围有关：展开机会原先按「每个 session 的每次访问」记，
     * 每进入一个新 surface 都会再排一次 layout.openRightbar(true, false)，而 DSH 的公开 API
     * 会同步改写右栏展示状态，于是内容切换的同时右栏被反复重展开。
     *
     * 语义修正：右栏是**全局**的一份展示，不是每个 session 一份。成功展开过一次就置位，之后
     * 切换 surface 只切换对应页面/tab 的内容，绝不再调用 layout.openRightbar。
     *
     * 复位条件只有一个（保守、只认宿主的明确证据）：宿主读面显示此前已确认的 expert-group
     * 变成「没有 active tab」（seat 卸载 / 布局重置 / 用户关掉右栏，见 openTargets 的重挂载
     * 边沿）时结束本次展示生命周期——下一次访问既能重新确保页面，也允许再展开一次；同一时刻
     * rightbarExpandFailures 一并清零，展开失败计数绝不跨生命周期继承。
     * 读面缺失或抛错（旧 Better / native 的 unknown）不做任何推断：那时无法区分「用户手动关掉」
     * 与「surface 还在」，一律保持「已展示」语义，绝不重新拉开右栏（尊重用户的显式操作）。
     */
    let rightbarPresented = false;
    /**
     * 「右栏此前已经展示过」的持久标记（含本次 install 生命周期内刚成功展开过的情形）。
     * 与 rightbarPresented 的区别：后者是可被宿主「明确缺失」边沿复位的内存态，前者跨刷新存活，
     * 只决定「这次自动打开是否需要播放动画」，绝不用于跳过 openRightbar 调用。
     */
    let rightbarPresentedPersisted = readPersistedRightbarPresented();

    /** 取消某个会话尚未执行的异步展开（dispose 与「已消费」路径共用）。 */
    const cancelRightbarExpand = (sessionId) => {
      const timer = rightbarExpandTimers.get(sessionId);
      if (timer === undefined) return;
      rightbarExpandTimers.delete(sessionId);
      try {
        // 定时器句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的异步展开：插件卸载后不得再操作宿主 layout。 */
    const cancelAllRightbarExpands = () => {
      for (const sessionId of [...rightbarExpandTimers.keys()]) cancelRightbarExpand(sessionId);
    };

    /**
     * 真正调用宿主动作，返回 ok / unavailable / failed 供调用方记账。
     * 每次调用都重新取一次服务（与宽度预置同一条路径：优先注入的 config.layout，回退可选
     * 服务查找），这样「服务稍后才可用」也能被后续尝试接住。
     */
    const callOpenRightbar = (preparedRestore = null) => {
      // 准备好的抑制句柄来自 runSurfaceOpen()（在 openTab 之前就已生效）；一旦拿不到 layout action，
      // 必须立刻收口，绝不能把 transition:none 留在宿主上。
      const releasePrepared = () => {
        if (typeof preparedRestore !== "function") return;
        try { preparedRestore(); } catch { /* 恢复失败不能阻断其它收尾。 */ }
      };
      const layout = config.layout || optionalService("layout");
      let openRightbar = null;
      try {
        const candidate = layout?.openRightbar;
        if (typeof candidate === "function") openRightbar = candidate;
      } catch {
        // Cordis 服务代理对未声明属性会抛错：按「宿主没有这个 action」处理。
        releasePrepared();
        return "unavailable";
      }
      if (openRightbar === null) {
        releasePrepared();
        return "unavailable";
      }
      // 刷新后（本生命周期内已经展示过右栏）仍然必须调用 openRightbar：宿主 layout store 的
      // rightbarShown 刷新后可能是 false，跳过调用右栏就可能不显示。区别只在于这次打开要
      // 瞬时完成：优先复用「页面打开之前就已经开始」的抑制句柄（panel 可能在 openTab 时就展开，
      // 那时动画已经开始）；只有没有句柄时才按现有逻辑临时创建，兼容独立重试与旧调用路径。
      // 临时创建同样拿不到目标（无 DOM / 元素缺失）时为 null，行为与旧版本完全一致。
      const restoreTransition = typeof preparedRestore === "function"
        ? preparedRestore
        : (rightbarPresentedPersisted ? suppressRightbarTransition() : null);
      let result = "ok";
      try {
        // 宿主动作是方法式绑定：显式带上接收者，避免将来 layout 改成类实例后丢失 this。
        openRightbar.call(layout, true, false);
      } catch {
        // 调用抛错不影响页面打开：只影响这一次自动展开，失败会被记账。
        result = "failed";
      }
      // 恢复必须晚于宿主的这次提交：绝不在同一同步栈里还原，否则过渡会在列宽落地前重新生效。
      if (restoreTransition !== null) scheduleInstantRestore(restoreTransition);
      return result;
    };

    /**
     * 为某次访问排队一次异步展开（同一访问只会成功展开一次）。
     * 已消费、已排队、代次过期、已 dispose 或环境没有可用调度器时什么都不做——绝不阻塞页面打开。
     */
    const scheduleRightbarExpand = (sessionId, epoch, delay) => {
      if (disposed || sessionId === null) return false;
      // 右栏这次展示生命周期已经展开过：连定时器都不排（切换 surface 时不产生任何 layout 调用）。
      if (rightbarPresented) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.expandDone) return false;
      if (rightbarExpandTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          rightbarExpandTimers.delete(sessionId);
          runRightbarExpand(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动展开，页面打开与其它行为都不受影响。
        return false;
      }
      rightbarExpandTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 展开体。三重校验后才调用 layout：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 不得污染新 surface）；
     * 2. 仍是当前可见会话（右栏是全局的，绝不为后台会话展开）；
     * 3. 本次访问的页面已经落地（openState === "opened"）——宿主有证据时还要求宿主已提交，
     *    否则会把内容展开到旧 surface 或被 seat 立刻关掉。
     * 成功一次即 expandDone（同一访问内不再重复，尊重用户随后手动关闭），并置位右栏展示
     * 生命周期 rightbarPresented（跨 surface 会话共用，切换 child 时不再重复展开）。
     */
    const runRightbarExpand = (sessionId, epoch) => {
      if (disposed) return;
      const record = surfaceRecordOf(sessionId);
      // 右栏已经在本展示生命周期里展开过（例如另一个 surface 的展开先成功）：绝不再调宿主 layout，
      // 同时收口本次访问可能已经开始的抑制（它不会再被消费）。
      if (rightbarPresented) {
        releaseTransitionRestore(record);
        return;
      }
      // 旧代次：句柄属于别的访问，绝不能在这里收口（那会撕掉新访问的抑制）。
      if (record.visitEpoch !== epoch) return;
      if (record.expandDone) return;
      if ((rightbarExpandFailures.get(sessionId) || 0) >= RIGHTBAR_EXPAND_MAX_ATTEMPTS) {
        releaseTransitionRestore(record);
        return;
      }
      if (currentSurfaceSessionId() !== sessionId) {
        // 用户已切走：这次访问不会再为它调用 openRightbar，收口抑制（切回时是新访问、会重新抑制）。
        releaseTransitionRestore(record);
        return;
      }
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        releaseTransitionRestore(record);
        return;
      }
      if (record.openState !== "opened") {
        // 页面还没落地：后续 runSurfaceOpen 会在下一次 openTab 之前重新抑制，这里先收口避免悬空。
        releaseTransitionRestore(record);
        return;
      }
      // 句柄所有权移交：callOpenRightbar 负责在调用 layout.openRightbar 之后统一延迟恢复，
      // 或在拿不到 layout action 时立刻收口。
      const preparedRestore = typeof record.transitionRestore === "function" ? record.transitionRestore : null;
      record.transitionRestore = null;
      const result = callOpenRightbar(preparedRestore);
      if (result === "ok") {
        record.expandDone = true;
        // 置位全局展示生命周期：之后切换 surface 只切内容，不再重复展开（消除右栏闪烁）。
        rightbarPresented = true;
        // 持久标记：刷新后仍能识别「右栏曾经展示过」，下一次自动打开以无过渡方式提交，
        // 不再重新播放一次展开动画（写入失败只影响下次刷新有没有动画，静默回退）。
        rightbarPresentedPersisted = true;
        persistRightbarPresented();
        rightbarExpandFailures.delete(sessionId);
        return;
      }
      // 宿主没有这个 action：不消耗机会、不排自动重试，等下一次通知再试。
      if (result === "unavailable") return;
      const failures = (rightbarExpandFailures.get(sessionId) || 0) + 1;
      rightbarExpandFailures.set(sessionId, failures);
      // 失败重试同样必须异步（回到宿主提交之后），且次数有上限，不会无限重排定时器；
      // 排不出重试任务时收口句柄（此时句柄通常已交给 callOpenRightbar 消费，这里是兜底）。
      if (failures >= RIGHTBAR_EXPAND_MAX_ATTEMPTS
        || scheduleRightbarExpand(sessionId, epoch, RIGHTBAR_EXPAND_RETRY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };

    /**
     * 为「当前可见会话的本次访问」安排一次异步展开。
     * 页面必须先落地（openState === "opened"），否则展开只会拉出一个空右栏；本次访问已经展开过
     * 就绝不再排——用户手动关闭右栏后，本次访问的重复通知不会把它重新拉开。
     * 另有全局闸门：右栏这份展示（跨 surface 会话只有一份）已经展开过时，后续切换只切换内容，
     * 绝不再调用 layout.openRightbar（rightbarPresented 只控制「要不要调用 openRightbar」）。
     */
    const scheduleCurrentSurfaceExpand = () => {
      const current = currentSurfaceSessionId();
      const record = current === null ? undefined : surfaceRecords.get(current);
      if (rightbarPresented) {
        // 已经展示过右栏：这次 surface 切换只需要「把新 panel 的 expanded transform 提交过程变瞬时」，
        // 不需要再调用 layout.openRightbar。因此把 openTab 前准备好的抑制句柄转交给延迟恢复
        // （两帧 RAF + 250ms fallback），覆盖 React 把 data-sidebar-right-open/transform 提交到 DOM
        // 的窗口；绝不能在这里直接 release，否则新 panel 仍会播放一次从右侧滑入的动画。
        const preparedRestore = typeof record?.transitionRestore === "function" ? record.transitionRestore : null;
        if (preparedRestore === null) return;
        record.transitionRestore = null;
        scheduleInstantRestore(preparedRestore);
        return;
      }
      if (current === null) return;
      if (record === undefined) return;
      if (record.visitEpoch !== currentVisitEpoch) return;
      if (record.openState !== "opened") return;
      if (record.expandDone) return;
      // 排程失败（没有可用调度器 / setTimeout 抛错）：这次访问不会再调用 openRightbar，
      // 立刻收口抑制句柄，绝不让 observer 与内联样式悬在宿主上。
      if (scheduleRightbarExpand(current, record.visitEpoch, RIGHTBAR_EXPAND_DELAY_MS) !== true) {
        releaseTransitionRestore(record);
      }
    };
    const nativeSidebarFor = (target) => {
      if (typeof config.sidebarRightForSession === "function") {
        try { return config.sidebarRightForSession(target, ctx); } catch { return null; }
      }
      try {
        const scoped = typeof sessions?.scope === "function" ? sessions.scope(target) : null;
        return scoped?.get?.("sidebarRight") || scoped?.sidebarRight || null;
      } catch { return null; }
    };
    /**
     * 自动打开 Expert Group 页面 + 展开右栏（每次 sessions/Better 通知都调用一次）。
     *
     * 目标只有一个：**当前可见会话**（插件解析出的当前可见会话）。宿主右栏是按 session 懒创建的，
     * 对非当前会话的 scoped open 会被静默 no-op（Better 0.19.1 的 native surface 对未 mint 的
     * 会话就是「openTabIn 存在即返回成功」）。因此这里：
     * 1. 绝不为后台 root/child 预发打开请求——它们成为 current 时自然会拿到属于自己的一次访问；
     * 2. 打开请求不在同步栈里发出，而是 defer 一个宏任务，等宿主把 surface/binding 提交完
     *    （runSurfaceOpen 会复核访问代次、插件解析出的当前可见会话，以及 Better 已提交的活跃会话）；
     * 3. 宿主明确还没提交时只做有限次「等提交」重试，绝不把请求落到旧 binding、也绝不把它
     *    记成已完成；
     * 4. 页面真正落地后才排程 layout.openRightbar(true, false)（同样 defer、同样按访问记账，
     *    成功一次即消费，用户的后续手动关闭在本次访问内不会被覆盖）。
     *
     * 宽度策略：Expert Group 页的右栏宽度固定为视口宽度的 20%（RIGHTBAR_WIDTH_RATIO），
     * 由 applyRightbarWidth(current) 在页面打开之前按 surface 会话写入宿主 layout store；
     * 插件不写第二套宽度状态、不操作 DOM/grid，也不通过 openTab 参数伪造 width。同一会话
     * 的重复通知不重复改写，切换会话时为新会话写它自己的一份（见 rightbarWidths 的说明）。
     * 注意写入仍在同步栈里执行，必须早于宿主第一次展开。
     *
     * 拖拽手柄锁也在这条访问路径上重估（requestRightbarDragSync）：宿主报告「当前活跃 tab
     * 就是 Expert Group」时锁住 [data-side=rightbar]，切到别的页面立刻交还宿主。
     *
     * 顺序是硬约束：宽度写入（同步）→ 打开页面（deferred）→ 展开右栏（deferred）。宿主
     * ui-sidebar-right 的 RightbarSeat 在右栏 surface 还没挂载时会以
     * syncPresentation({ shown: false }) → layout.closeRightbar() 收尾，任何同步/过早的展开都会
     * 被它立刻关掉。
     *
     * 契约不变：Better Sidebar 可用时由它独占（用户禁用它则不自动打开，也绝不回退 native
     * 注册）；否则走 native（含旧 openTabIn 兼容）。打开失败保持未打开状态等待后续通知。
     */
    /**
     * 读取宿主右栏的公开只读 tab inventory（**跨 pane** 的全量已提交 tab 表）。
     *
     * 为什么需要它：宿主刷新后会从持久化布局恢复**全部 pane** 的 tab，而 `active()` 只返回
     * 当前活跃 pane 的 active tab。只看 active() 无法回答「这个会话的 Expert Group 页是否已经
     * 存在于另一个 pane」，于是插件会在当前 pane 再开一个重复的 Expert Group 页
     * （多 pane/分页下刷新一次多一个重复页）。
     *
     * 读面缺失（旧宿主没有 openTabs）、读属性抛错、没有 getSnapshot、返回非数组/null 或调用
     * 抛错时一律返回 null：调用方据此**完全**回退旧的 active() 兼容语义，绝不把「读不到」
     * 当成「不存在」，也绝不当成「已存在」。
     */
    const readSurfaceOpenTabs = () => {
      let inventory = null;
      try { inventory = nativeSidebar?.openTabs ?? null; } catch { return null; }
      const getSnapshot = methodOf(inventory, "getSnapshot");
      if (getSnapshot === null) return null;
      try {
        const snapshot = getSnapshot.call(inventory);
        return Array.isArray(snapshot) ? snapshot : null;
      } catch { return null; }
    };
    /**
     * 读取已渲染右栏的页面组成：DOM 能看到其它 tab 时，它是跨 pane「其它页存在」的直接证据。
     *
     * DOM 只提供 tabId，不提供 kind、更不提供 sessionId；这两样都只能来自 openTabs inventory。
     * 因此**归属**是这里的第一判据：一个节点只有在 inventory 里明确属于本次查询的 sessionId 时，
     * 才算这个会话的组成。
     *
     * 会话切换时旧会话的 tab 节点可能还留在 DOM 里（宿主 React 重挂载窗口）：它在 inventory 里
     * 挂在别的 sessionId 名下，因此在这里拿不到 kind，落进下面的 unknown 桶——既不会被当成当前
     * 会话的「其它页」（这正是修复点：只按 tabId 建全局 kind 表时，root-a 的残留节点会把 root-b
     * 判成 50%），也不会被当成 Expert Group-only。
     *
     * fail-closed 语义（与修复前一致，不能放松）：
     * - 节点没有 tabId、或 tabId 在 inventory 里找不到**属于本次会话**的归属（含挂在别的会话
     *   名下的旧节点）→ "unknown"（读不到 ≠ 不存在）；
     * - inventory 不可用（返回 null）时所有非 Expert Group 节点都归入 unknown；
     * - 已知是 Expert Group 的 tabId（含 DockKit 生成的 kind+计数器形态）永远不是「其它页」。
     * 只有「明确属于当前会话、且 kind 不是 Expert Group」的节点才返回 "other"。
     *
     * 面板归属同样按 session 精确解析（rightbarPanelForSession）：DOM 里可能同时残留多个 session
     * 的面板（React 重挂载窗口），querySelector 的首个命中不能证明归属，读它的 tab 节点就会把别的
     * 会话的页算成本会话的组成。零个/多个匹配、或现代宿主里当前面板缺归属标记都返回 null
     * （＝这一面在本轮读不到），绝不退回全局第一个面板。
     *
     * sessionId 省略（传 null）时不做任何归属判定：调用方只用来探测 DOM 读面本身是否可用
     * （见 compositionReadFacesUnavailable），因此这里保留旧的兼容读法（querySelector 的命中），
     * 只回答「DOM 读面在不在」，它的返回值也不会被当成任何会话的组成证据。
     */
    const readRightbarDomComposition = (sessionId = null) => {
      const doc = globalThis.document;
      if (!doc || typeof doc.querySelector !== "function") return null;
      let panel = null;
      if (typeof sessionId === "string" && sessionId !== "") {
        // 实际 session 判定：只读这个会话自己的面板。
        panel = rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
      } else {
        // 探测读面能力（无归属判定）。
        try { panel = doc.querySelector(RIGHTBAR_PANEL_SELECTOR); } catch { return null; }
      }
      if (panel === null || panel === undefined || typeof panel.querySelectorAll !== "function") return null;
      let nodes;
      try { nodes = Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR)); } catch { return null; }
      const inventory = readSurfaceOpenTabs();
      // 只登记「明确属于当前会话」的 tabId → kind；别的会话与 sessionId 缺失的记录一律不参与判定。
      const kindByTabId = new Map();
      if (inventory !== null && sessionId !== null && sessionId !== undefined) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const tabId = text(candidate.tabId, null);
            const kind = text(candidate.kind, text(candidate.type, null));
            if (tabId !== null && kind !== null) kindByTabId.set(tabId, kind);
          } catch {
            // 单条坏记录不阻断其它 tab 的归属；无法归属的节点仍由下面的 fail-closed 分支处理。
          }
        }
      }
      let hasOther = false;
      let hasUnknown = false;
      for (const node of nodes) {
        let tabId = null;
        try { tabId = text(node?.getAttribute?.("data-dockkit-tab"), null); } catch { tabId = null; }
        if (tabId === null) { hasUnknown = true; continue; }
        if (EXPERT_GROUP_TAB_IDS.has(tabId) || isGeneratedExpertGroupTabId(tabId)) continue;
        if (!kindByTabId.has(tabId)) { hasUnknown = true; continue; }
        const kind = kindByTabId.get(tabId);
        if (EXPERT_GROUP_TAB_IDS.has(kind)) continue;
        hasOther = true;
      }
      if (hasOther) return "other";
      if (hasUnknown) return "unknown";
      return "expert-only";
    };

    /** 同步栈内只读取「其它页是否已经存在」，不触碰 active()，避免改变宿主提交时序。 */
    const hasOtherRightbarPage = (sessionId) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return true;
          } catch {
            // 单条坏记录不构成其它页的正向证据。
          }
        }
      }
      // DOM 读面同样只认属于该会话的节点：旧会话残留的 tab 不算当前会话的其它页。
      return readRightbarDomComposition(sessionId) === "other";
    };

    /**
     * 跨 pane 的「这个会话的 Expert Group 页已经存在」判定。
     *
     * 命中口径与 activeTabEvidenceOf 的证据口径一致（同 sessionId + kind 为 expert-group）：
     * inventory 是全部 pane 已提交 tab 的并集，因此这里**不区分 pane**——这正是修复点，
     * 非活跃 pane 里的同一个页也是「已经存在」。tabId/contentId 不参与判定：它们是关闭/定位
     * 用的元数据，缺失不影响「页面已存在」这一事实。
     *
     * 返回值语义（两种 false 对调用方是同一件事：回退旧的打开语义）：
     * - true：读面证明页面已存在；
     * - false：读面证明不存在，或读面根本不可用（fail-closed，绝不因为读不到就跳过打开）。
     */
    const hasExistingExpertGroupTab = (sessionId) => {
      if (sessionId === null) return false;
      const inventory = readSurfaceOpenTabs();
      if (inventory === null) return false;
      for (const entry of inventory) {
        try {
          // 单条 inventory 记录来自宿主对象；某些代理对象字段读取失败时，不能让
          // 一条坏记录阻断其它记录和旧的打开回退语义。
          const candidate = object(entry);
          if (text(candidate.sessionId, null) !== sessionId) continue;
          if (!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind, null))) continue;
          return true;
        } catch {
          continue;
        }
      }
      return false;
    };
    /**
     * 保守的「页面真的提交成 active」证据（只用插件已能访问的公开读面，不依赖未公开的 DSH 改动）。
     *
     * 为什么需要它：better.openTab() 返回 void；在它之外，插件此前只能证明宿主活跃会话是谁。
     * 即使调用没抛错，宿主右栏的 surface 也可能还没 mint / tab 还没提交（DSH SidebarRight 对
     * 未挂载会话的 open 会静默 no-op）。DSH 公开的 sidebarRight.active()（active tab of the
     * active pane，未挂载时返回 undefined）正好回答「这个 tab 到底有没有落地」。
     *
     * 读法：优先按目标会话解析出的 scoped sidebarRight，其次当前挂载的 nativeSidebar；只要其中
     * 任意一个有 active() 就用它。返回值：
     * - "confirmed"：active tab 的 kind/type 就是 expert-group（真正落地）；
     * - "missing"：读面存在但没有 active tab / 没有 kind（尚未 mint 或被静默 no-op）；
     * - "other"：active tab 是别的 kind（例如用户手动切走的 tab）；
     * - "unknown"：宿主没有该读面、属性读取或调用抛错、或宿主的活跃会话还不是目标会话
     *   （此时 active() 读的是别的 surface，不能当证据）——调用方必须退回旧 native / 旧 Better
     *   的兼容语义，绝不能让老版本失效。
     */
    const activeTabEvidenceOf = (sessionId) => {
      const host = readHostActiveSurface();
      // 宿主有活跃会话证据但还没提交到目标：此刻 active() 读的是别的 surface，不能当证据。
      if (host.available && host.sessionId !== sessionId) return "unknown";
      let reader = null;
      let owner = null;
      try {
        const scoped = nativeSidebarFor(sessionId);
        if (typeof scoped?.active === "function") { reader = scoped.active; owner = scoped; }
      } catch { /* 服务代理读取即抛错：按「没有读面」处理。 */ }
      if (reader === null) {
        try {
          if (typeof nativeSidebar?.active === "function") { reader = nativeSidebar.active; owner = nativeSidebar; }
        } catch { /* 同上。 */ }
      }
      if (reader === null) return "unknown";
      try {
        // 方法式绑定：显式带上接收者，避免将来改成类实例后丢失 this。
        const tab = reader.call(owner);
        const kind = text(object(tab).kind, text(object(tab).type, null));
        if (kind === null) return "missing";
        return EXPERT_GROUP_TAB_IDS.has(kind) ? "confirmed" : "other";
      } catch {
        // 调用抛错按「无证据」处理：自动打开降级为既有语义，绝不影响页面打开。
        return "unknown";
      }
    };
    /**
     * 组合 active()、openTabs 与宿主 DOM 的证据：active() 只回答当前 pane，不能代表整个右栏。
     *
     * 只要 openTabs 或 DOM 证明当前右栏存在其它 tab，就进入 50% 可调模式；仅有 Expert Group
     * 证据时才进入 20% 锁定模式。missing 与 unknown 保持独立：前者解锁但不改宽度，后者
     * 不改变已确认状态，避免读面暂态把用户宽度覆盖掉；两种组合读面都不可用时不采信 active-only
     * 证据，防止把一个 pane 的暂态读数误当成整个右栏的 Expert Group-only 组成。
     */
    const rightbarCompositionEvidenceOf = (sessionId, activeEvidence) => {
      const inventory = readSurfaceOpenTabs();
      if (inventory !== null) {
        for (const entry of inventory) {
          try {
            const candidate = object(entry);
            if (text(candidate.sessionId, null) !== sessionId) continue;
            const kind = text(candidate.kind, text(candidate.type, null));
            if (kind !== null && !EXPERT_GROUP_TAB_IDS.has(kind)) return "other";
          } catch {
            // 坏记录不能否定 active() 的证据；DOM 读面仍有机会给出其它页的正向证据。
          }
        }
      }
      // DOM 按 sessionId 归属：只有 inventory 明确算在当前会话名下的节点才参与组成判定，
      // 旧会话残留或无法归属的节点都归入 unknown，绝不推断成其它页。
      const domComposition = readRightbarDomComposition(sessionId);
      if (domComposition === "other") return "other";
      if (domComposition === "unknown") return "unknown";
      // active() 只够让既有宿主继续锁住当前 Expert Group 手柄；它本身不足以支撑会创建新 pane
      // 的 split 事务，否则会把一个 pane 的暂态读数扩展成整个右栏的 ownership 结论。
      // beginSidebarSplit 因此把这个 unknown 当作 fail-closed，唯一例外是「连组合读面都不存在」
      // 的 active-only 兼容宿主：那里的判据由 isActiveOnlySplitCompatible 单独给出（见其说明）。
      if (inventory === null && domComposition === null && activeEvidence === "confirmed") return "unknown";
      return activeEvidence;
    };
    /**
     * 两个组合读面是否都不可用（openTabs inventory 读不到 + 右栏 DOM 也读不到）。
     *
     * 这就是「旧宿主 / 读面还没就绪」的宿主形状：插件手上只剩 active() 这一份公开证据。
     * 读函数自己已经把「没有该 API / 属性读取抛错 / 调用抛错」吞成 null，因此这里的 try/catch
     * 只是防御服务代理在读取瞬间抛错，一律按「这一面不可用」处理（读不到 ≠ 不存在）。
     */
    const compositionReadFacesUnavailable = () => {
      let inventoryUnavailable = false;
      let domUnavailable = false;
      try { inventoryUnavailable = readSurfaceOpenTabs() === null; } catch { inventoryUnavailable = true; }
      // 这里只探测 DOM 读面本身是否可用（不传 sessionId，不做归属判定）：只要面板与节点查询
      // 能读，返回值就不是 null（最坏是保守的 "unknown"），读面可用性结论与修复前一致。
      try { domUnavailable = readRightbarDomComposition() === null; } catch { domUnavailable = true; }
      return inventoryUnavailable && domUnavailable;
    };
    /**
     * 发出一次 Expert Group 页面打开请求（Better 优先，native 回退）。
     * 返回 true 表示请求已成功发出；false 表示当前宿主无法定位该 surface（保持未打开状态，
     * 留给后续会话/设置通知重试）。Better openTab 返回 void，调用未抛错即视为已发出。
     */
    const openSurfaceTab = (target) => {
      if (better) {
        if (typeof better.openTab !== "function") return false;
        try {
          // target 必须显式为 right，第二参数是 Better Sidebar 的 SessionScope；
          // scope.sessionId 接受任意 surface 会话 id（root 或 child）。
          better.openTab({ type: "expert-group", target: "right" }, { sessionId: target });
          return true;
        } catch { return false; }
      }
      try {
        // native 用 openNativeTab 的 boolean 返回值判定「已成功发起」。
        return openNativeTab(target) === true;
      } catch { return false; }
    };

    /** 已排队的「打开请求」：sessionId → timer handle（与展开 timer 分开记账，dispose 一并清理）。 */
    const surfaceOpenTimers = new Map();
    /** 取消某个会话尚未执行的打开请求。 */
    const cancelSurfaceOpenTimer = (sessionId) => {
      const timer = surfaceOpenTimers.get(sessionId);
      if (timer === undefined) return;
      surfaceOpenTimers.delete(sessionId);
      try {
        // 句柄由所在环境的 setTimeout 生成，必须用同一环境的 clearTimeout 释放。
        globalThis.clearTimeout?.(timer);
      } catch { /* 取消失败不能阻止其它所有权释放。 */ }
    };
    /** 一次性取消所有待执行的打开请求（dispose 用）。 */
    const cancelAllSurfaceOpens = () => {
      for (const sessionId of [...surfaceOpenTimers.keys()]) cancelSurfaceOpenTimer(sessionId);
    };

    /**
     * 为某次访问排队一次「打开页面」请求：一律 defer 到至少一个宏任务之后，等宿主把
     * surface/binding 提交完再发；同一次访问同时只保留一个待执行任务。
     * 代次过期、已落地、次数用尽、已排队、已 dispose 或没有可用调度器时什么都不做。
     */
    const scheduleSurfaceOpen = (sessionId, epoch, delay) => {
      if (disposed || sessionId === null) return false;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return false;
      if (record.openState === "opened") return false;
      if (record.openAttempts >= MAX_SURFACE_OPEN_ATTEMPTS) return false;
      if (surfaceOpenTimers.has(sessionId)) return false;
      let timer;
      try {
        timer = globalThis.setTimeout(() => {
          // 先出队再执行：回调里若决定重试，会重新排队一个新的 timer。
          surfaceOpenTimers.delete(sessionId);
          runSurfaceOpen(sessionId, epoch);
        }, delay);
      } catch {
        // 没有可用调度器：放弃自动打开，安装与其它行为都不受影响。
        return false;
      }
      surfaceOpenTimers.set(sessionId, timer);
      return true;
    };

    /**
     * deferred 打开体。发请求前逐条校验：
     * 1. 仍是同一个访问代次（旧 generation 的 timer 绝不污染新 surface）；
     * 2. 用户仍在这个会话上（插件解析出的当前可见会话 已切走就直接放弃，新会话有它自己的访问）；
     * 3. 宿主有权威证据时，必须已经提交到这个会话（host.sessionId === sessionId）。未提交时
     *    绝不发请求——那正是会落到旧 binding 被静默丢弃的情况——只做有限次「等宿主提交」重试；
     * 4. 这个会话的 Expert Group 页在**任意 pane** 里都还不存在（公开只读 openTabs inventory）。
     *    已存在时绝不发请求（那会在当前 pane 再开一个重复页），但仍按「已打开」结算并排展开。
     * 只有真正通过全部校验的请求才算本次访问的 openState = "opened"；失败不记账为成功，按上限重试。
     */
    const runSurfaceOpen = (sessionId, epoch) => {
      if (disposed) return;
      const record = surfaceRecordOf(sessionId);
      if (record.visitEpoch !== epoch) return;
      if (record.openState === "opened") return;
      if (currentSurfaceSessionId() !== sessionId) return;
      const host = readHostActiveSurface();
      if (host.available && host.sessionId !== sessionId) {
        // 宿主 binding 还没提交到目标：有限等待（等通知或短重试），绝不盲目发请求。
        // 预算用尽或排不出重试任务（没有可用调度器）时，这次访问不会再走到 openRightbar，
        // 必须立刻收口抑制句柄，绝不把 observer/内联样式悬在宿主上。
        if (record.readinessRetries < MAX_READINESS_RETRIES
          && scheduleSurfaceOpen(sessionId, epoch, HOST_COMMIT_RETRY_MS) === true) {
          record.readinessRetries += 1;
        } else {
          releaseTransitionRestore(record);
        }
        return;
      }
      if (record.openAttempts >= MAX_SURFACE_OPEN_ATTEMPTS) {
        // 打开次数已用尽：这次访问同样不会再调用 openRightbar，收口未消费的句柄。
        releaseTransitionRestore(record);
        return;
      }
      // 跨 pane 已存在判定（必须在真正发请求之前）：宿主刷新后会从持久化布局恢复**全部 pane**
      // 的 tab，而 active() 只返回当前活跃 pane 的 tab——只看 active() 会得出「页面不存在」，
      // 于是在当前 pane 再开一个重复的 Expert Group 页。公开只读 inventory（openTabs.getSnapshot）
      // 是跨 pane 的权威证据，命中即按「已打开」结算：
      // - 不调用 openSurfaceTab：既不新建重复页，也不把焦点抢到别的 pane 的 tab 上；
      // - 不写 record.commitState = "confirmed"：inventory 只能证明 tab 已提交，不能证明它是
      //   当前活跃 pane 的 active tab；写成 confirmed 会伪造出「已确认 → 明确缺失」的重挂载边沿，
      //   把 rightbarPresented 复位并反复重展开右栏（保持 "unknown" 才与读面证据一致）；
      // - 但照旧消费本次访问（openState = "opened"，与成功路径同一条完成语义）并排程右栏展开，
      //   绝不因为跳过 openTab 就让用户看到「页面明明在、右栏却没打开」。
      // 读面缺失/返回 null/抛错时 hasExistingExpertGroupTab 一律返回 false：完全回退旧语义。
      if (hasExistingExpertGroupTab(sessionId)) {
        record.openState = "opened";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        scheduleCurrentSurfaceExpand();
        return;
      }
      record.openAttempts += 1;
      // 注意：视觉连续性遮罩**不在这里**创建。DSH 原生 session-key 重挂载会在本函数执行之前
      // （openTargets 之后的下一帧里）就把旧 panel 删掉，因此抢拍必须在 openTargets() 里、
      // scheduleSurfaceOpen() 之前完成；这里只复用 record 上已有的句柄，绝不再新 clone。
      // 时序硬约束：Better/native 的 openTab 可能**同步**把右栏面板置为展开（公开属性
      // data-sidebar-right-open + transform 过渡），动画从那一刻就已经开始；而 layout.openRightbar
      // 要等下一轮 deferred 展开体才会被调用。因此抑制必须在这里、在 openSurfaceTab() 之前开始，
      // 并把恢复句柄挂到本次访问记录上，等真正调用 openRightbar 之后交给 scheduleInstantRestore 延迟恢复。
      // 启动条件只看「持久标记」：只要宿主上曾经展示过右栏（含本生命周期内刚成功的那次切换），
      // 之后每次自动打开**另一个 surface** 的 openTab 都可能让这个 surface 的 panel 进入 expanded
      // （data-sidebar-right-open → transform: none + 过渡），动画从那一刻开始，所以必须在 openTab
      // 之前抑制这次提交。rightbarPresented 只决定「要不要调用 layout.openRightbar」，不决定
      // 「要不要抑制 panel 动画」——这正是此前「首次展开后切换 surface 仍会滑入」的漏点。
      // 同一访问已有句柄时绝不覆盖（重复通知、重试都复用同一个句柄）。
      if (rightbarPresentedPersisted && typeof record.transitionRestore !== "function") {
        record.transitionRestore = suppressRightbarTransition();
      }
      const opened = openSurfaceTab(sessionId);
      // 保守提交确认：openTab/openTabIn 是 void（openTabIn 的返回值对未挂载会话也不可信），
      // 只有公开读面确认 expert-group 已成为 active，或宿主根本没有该读面（unknown 兼容路径）
      // 时，才算这次打开真的落地。
      const evidence = opened ? activeTabEvidenceOf(sessionId) : "unknown";
      if (opened && (evidence === "confirmed" || evidence === "unknown")) {
        record.openState = "opened";
        record.commitState = evidence === "confirmed" ? "confirmed" : "unknown";
        record.openFailures = 0;
        cancelSurfaceOpenTimer(sessionId);
        // 页面落地后才排程展开（展开永远排在打开之后）。
        scheduleCurrentSurfaceExpand();
        return;
      }
      // 请求已发出但没落地（或调用本身失败）：绝不结算、绝不展开。自动定时重试有独立上限
      // （其余机会留给后续通知），总次数仍受 MAX_SURFACE_OPEN_ATTEMPTS 约束；异常已在
      // openSurfaceTab 内部吞掉，绝不抛给调用方。
      if (evidence === "missing") record.commitState = "missing";
      else if (evidence === "other") record.commitState = "other";
      record.openFailures += 1;
      // 重试预算还够、且重试任务确实排得出去时才算消费一次重试；否则立刻收口抑制句柄
      // （重试用尽 / 调度不可用都意味着这次访问不会再调用 layout.openRightbar），
      // 绝不把 observer 与 transition:none 留给宿主。
      if (record.openRetries < MAX_SURFACE_OPEN_RETRIES
        && record.openAttempts < MAX_SURFACE_OPEN_ATTEMPTS
        && scheduleSurfaceOpen(sessionId, epoch, SURFACE_OPEN_RETRY_MS) === true) {
        record.openRetries += 1;
      } else {
        releaseTransitionRestore(record);
      }
    };

    const openTargets = () => {
      if (disposed) return;
      // 页面打开最终只服务当前可见 surface；后台 root/child 不会被这里打开。旧实现为了
      // 判断「是否有目标」先枚举所有 session 并逐个解析 root，切换会话时形成 O(S²) 主线程工作。
      // current 已经是唯一实际会被打开的目标，直接读取一次即可保留同样的行为。
      const current = currentSurfaceSessionId();
      const targets = current === null ? [] : [current];
      // hydration 尚未产生任何可打开 surface 时，不得提前改写宿主宽度偏好；
      // 等后续会话通知带来目标后，再在真正打开前写入该会话的 20%。
      if (targets.length === 0) {
        // 「没有当前可见 surface」是一次**访问终止边沿**，绝不能直接 return 绕过 beginVisit：
        // 上一个会话可能还留着待执行的 open/expand timer，以及未消费的抑制句柄
        // （MutationObserver + panel/frame 的内联 transition:none），绕过清理就会永久留在宿主上。
        // 这里用 (null, null) 走一次与普通访问完全相同的收尾路径：取消上一个可见会话的遗留 timer，
        // 并收口它记录上的抑制句柄；key 相同（持续无 current）时是幂等空操作。
        beginVisit(null, null);
        // 同时 flush 全局待恢复任务：终止边沿必须立刻把过渡样式交还宿主，不能等 RAF/250ms
        // fallback。普通 child 切换永远走不到这里（current 非空），所以不会误 flush 正常展开的
        // 恢复窗口。
        flushInstantRestore();
        // 没有可服务的 surface 就没有 Expert Group 页：手柄锁必须跟着交还宿主（这里 current
        // 为 null，重估只会解锁，不会读任何宿主读面）。
        requestRightbarDragSync();
        return;
      }
      if (better) {
        let enabled = true;
        try { enabled = typeof better.isTabEnabled !== "function" || better.isTabEnabled("expert-group") !== false; } catch { enabled = false; }
        if (!enabled || typeof better.openTab !== "function") {
          // Better 被用户禁用（expert-group tab 关掉）或宿主没有 openTab：这是**本次访问的终止边沿**，
          // 不是「什么都没发生」。仍要结束当前访问：取消该会话遗留的 open/expand timer 并收口
          // 未消费的抑制句柄；但绝不写入右栏宽度、不打开/展开右栏（禁用语义与用户右栏状态都不受影响）。
          // 用 (current, null) 作为终止标记：之后 Better 恢复可用时 visit key 会再次变化，
          // 自然开启新访问继续（不会因为终止过就永久停摆）。
          beginVisit(current, null);
          // 同样是终止边沿：立刻 flush 全局待恢复任务（上一次成功展开排下的 RAF/fallback），
          // 不能等到延迟恢复才把 transition:none 交还宿主。
          flushInstantRestore();
          // 插件这次不会打开任何页面：手柄锁按宿主当前的活跃 tab 重估（页面确实还是
          // Expert Group 时保持锁定，用户切到别的页时立刻交还宿主）。
          requestRightbarDragSync();
          return;
        }
      }
      // 宽度写入先于页面打开：Better 被禁用时上面已 return，不会在「DEG 什么都不开」的
      // 情况下改写宿主的宽度偏好；Expert Group 首次展开前仍需先落盘 20%。
      // 当前如果已经是其它右栏页，50% 模式由右栏同步器负责，不能在每次 session 通知时被
      // 这里的「新 surface」分支重新覆盖成 20%。
      // 不在这里提前读取 active()：openTargets 发生在页面提交前，某些宿主的 active() 读面
      // 会影响调度器就绪时序。上一轮同步已经确认的 mode 足以阻止 50% 可调状态被 20%预置覆盖。
      // 跨 pane 已存在其它页时，当前 Expert Group 不能在这里抢先写 20%；同步器会直接
      // 把总右栏初始化到 50%。这里不读 active()，只用 inventory/DOM 的正向存在证据。
      // mode / prepared / active 全部按 sessionId 读取：root-a 的 other / split-pending 绝不是
      // root-b 的现状，不能阻止 root-b 的首次预置。
      const otherPagePresent = hasOtherRightbarPage(current);
      // 只按**本会话**自己的在途事务判定：别的 session 的 split-pending 与 root-b 的首次预置无关。
      const splitPending = rightbarSplitTransactions.has(current);
      const expertPageCanOwnWidth = splitPending !== true
        && widthModeOf(current) !== "other" && otherPagePresent !== true;
      const widthSurfaceChanged = rightbarWidthSurfaceSessionId !== current;
      const shouldPrepareWidth = expertPageCanOwnWidth && (widthSurfaceChanged
        || isWidthActive(current)
        || !rightbarWidths.has(current));
      if (shouldPrepareWidth && applyRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, widthSurfaceChanged)) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        // 只有本次确实写入才标记 prepared；把 Map 里的旧目标当作“刚写过”会漏掉
        // 「其它分页改宽 → 返回 Expert Group」这条必须强制恢复 20% 的进入边沿。
        setWidthPrepared(current, true);
      }
      // 宿主真正承载右栏的会话（Better 证据优先）；两者都没读到时按 current 兜底，
      // 但「有 API 却读不到活跃会话」会被记成 null，也就是「尚未提交」，只等通知/有限重试。
      const host = readHostActiveSurface();
      const observedActive = host.available ? host.sessionId : current;
      // 同一 sessionId 的 surface 重挂载：宿主把某个此前已确认 expert-group 的目标变成
      // 「明确没有 active tab」（seat 卸载 / 布局被重置）时，开一次新的访问代次重新确保。
      // 只在「已确认 → 明确缺失」这条边沿触发：
      // - 持续缺失不会重复触发（重置后 commitState 回到 unknown）；
      // - active 是别的 kind（用户手动切走 tab）不算重挂载，也不在普通通知里抢回用户 tab；
      // - 读面缺失或抛错时是 unknown，不做任何推断（旧 native / 旧 Better 语义不变）。
      if (current !== null) {
        const previousRecord = surfaceRecords.get(current);
        if (previousRecord !== undefined
          && previousRecord.commitState === "confirmed"
          && activeTabEvidenceOf(current) === "missing") {
          currentRemountSerial += 1;
          // 宿主明确卸载/关掉了这个 surface：右栏这次展示生命周期结束，下一次访问允许重新展开
          // 一次（这也是用户手动关闭右栏后唯一的重开路径）。
          rightbarPresented = false;
          // 该 session 在旧访问里可能还排着一个尚未执行的展开 timer：必须在复位处就地取消，
          // 不依赖随后 beginVisit 的代次变化兜底（那条路径靠「serial 变化必然改 key」这一隐性
          // 顺序耦合；一旦这里的复位与 beginVisit 之间插入别的分支、或那道取消被重排，
          // 旧 timer 就会占着 rightbarExpandTimers 的槽位，新访问的 scheduleRightbarExpand
          // 因「该 session 已有待执行 timer」提前返回 false，重挂载后就再也调不到
          // layout.openRightbar）。取消本身是幂等的：没有待执行 timer 时是无操作。
          cancelRightbarExpand(current);
          // 展开失败预算同样只属于「一次展示生命周期」：必须一起复位，否则旧生命周期里已经
          // 失败到 RIGHTBAR_EXPAND_MAX_ATTEMPTS 的 surface 在新生命周期里永远不会再尝试展开
          // （失败计数绝不能被继承到新生命周期）。
          rightbarExpandFailures.clear();
        }
      }
      // 访问代次：宿主活跃 surface、当前可见会话或重挂载序号变化 = 一次新访问（重复通知不改变
      // 代次，因此不会重置本次访问的打开/展开预算）。
      const epoch = beginVisit(current, observedActive);
      if (current !== null) {
        const record = beginVisitFor(current, epoch);
        // 视觉连续性遮罩（不是动画抑制）：真实时序是 openTargets(current=child) → 旧 panel removed
        // → 新 panel added(collapsed) → runSurfaceOpen → 新 panel open。也就是说旧 panel 在
        // scheduleSurfaceOpen() 的 deferred 打开轮之前就已经被 DSH 的 session-key 重挂载删掉了，
        // 等到 runSurfaceOpen 再 clone 就太晚（旧节点已不存在）。因此必须在这里、在旧 panel 仍然
        // 存在的那一刻抢拍，正好覆盖 openTargets → panel removed 的窗口。
        // 只对「后续 surface 切换」启用：rightbarPresented 表示本生命周期已经展示过右栏，
        // rightbarPresentedPersisted 表示宿主上确实呈现过（含本生命周期内刚成功的那次）。
        // 首次无持久标记、首次自动打开、用户手动开关都不满足条件，因此不会创建遮罩。
        // 同一访问（同一 epoch 的重复通知）只创建一次：record 上已有句柄时直接复用。
        if (rightbarPresented === true && rightbarPresentedPersisted === true
          && typeof record.continuityRelease !== "function") {
          record.continuityRelease = continuityOverlay.capture();
        }
        // 只为「当前可见会话」的本次访问排队打开：绝不预发后台目标的请求（宿主对未挂载会话
        // 的 scoped open 会静默 no-op，却被当成已完成，于是目标被永久跳过）。
        scheduleSurfaceOpen(current, epoch, SURFACE_OPEN_DELAY_MS);
      }
      // 展开同样只排队（defer 到宿主提交之后），并且要求本次访问的页面已经落地。
      scheduleCurrentSurfaceExpand();
      // 最后按宿主当前提交的活跃 tab 重估手柄锁：这条通知路径覆盖会话切换与 Better 设置变化；
      // 页面还没落地时证据是 missing/unknown —— missing 会解锁，unknown 保持现状而不误锁别页。
      // 刻意排在这里（而不是函数开头）：宿主读面的调用顺序与打开流程保持原样，绝不提前读面。
      requestRightbarDragSync();
    };
    /**
     * 右栏拖拽手柄锁的重估实现（在 install 末尾接线，早于 subscribeSessions 的首次通知）。
     *
     * 判定只用宿主公开读面：**当前可见会话**的活跃 tab 必须是 Expert Group。
     * - "confirmed"：锁住 [data-side=rightbar]，用户在这一页上拖不动右栏；
     * - "other" / "missing"：用户在别的右侧分页或没有活跃 tab → 立刻解锁并还原样式；
     * - "unknown"（旧宿主没有 active() 读面等）：无法证明当前页就是 Expert Group，
     *   按兼容处理**不解锁也不加锁**——保持上一次已确认的状态，绝不误伤其它页面。
     *
     * 只用 currentSurfaceSessionId() 解析出的当前会话：后台 root/child 的活跃 tab 与用户
     * 眼前这一页无关，拿它决定手柄锁会锁错页面。
     */
    rightbarDragSyncImpl = () => {
      // 分栏配比与手柄锁共用这条同步链路（面板 observer / 2.5 秒轮询 / visibilitychange 与
      // sessions 通知都会走到这里），因此宿主把第二个 pane 渲染出来、或用户把子代理 pane 关掉
      // 之后，配比会在同一轮里被补上或还原，不为它另挂 observer、也不读取任何额外宿主状态。
      // 刻意排在下面的 early return 之前：这些分支全都不代表「pane 组成没变」。
      try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响宽度与手柄的判定。 */ }
      const current = currentSurfaceSessionId();
      if (current === null) {
        // 没有任何可见 surface：所有在途事务都不可能再提交，逐条收口（每条只清理自己所属会话的
        // transient 记账）；统一回滚失败由后续同步重试。
        cancelAllSidebarSplits("session-missing");
        // 没有可见 surface：归属会话的 transient 记账一并失效（它描述的是「宿主那份宽度属于
        // 该会话」时的状态，不能留给下一个会话当现状）。per-session 的目标值不受影响，该会话
        // 下次被激活时会按自己的目标重估。
        clearRightbarWidthMarks(rightbarWidthSurfaceSessionId);
        rightbarDragLock.setLocked(false);
        return;
      }
      // 可见 surface 已切到**另一会话**：别会话的在途事务（可能有多个）已经不可能由用户继续完成，
      // 只收口它们本身（deadline + 各自的 transient 记账）——绝不回滚宽度、绝不改写当前会话的
      // active/prepared/mode，也不按旧会话去锁手柄；宿主那份全局宽度交给下面这轮针对 current 的
      // 同步自行判定 20%/50%。本会话自己的事务不进这个循环，因此不会被别的会话的同步收口。
      for (const [sessionId, transaction] of [...rightbarSplitTransactions]) {
        if (sessionId === current) continue;
        try { cancelSidebarSplit(transaction.token, { reason: "session-switched" }); } catch { /* 后续同步仍会重估。 */ }
      }
      if (rightbarSplitTransactions.has(current)) {
        // split → openTabs/DOM 提交期间保持 50% 且不锁手柄；guide-only 不足以结算。
        // 只对本会话成立：别的会话的在途事务不阻塞本会话的宽度/手柄判定。
        rightbarDragLock.setLocked(false);
        return;
      }
      const activeEvidence = activeTabEvidenceOf(current);
      let evidence = rightbarCompositionEvidenceOf(current, activeEvidence);
      if (evidence === "unknown" && activeEvidence === "confirmed" && compositionReadFacesUnavailable()) {
        // 旧宿主没有 inventory/DOM 组合读面时，active() 仍是宽度模式与手柄锁的唯一兼容证据。
        // 注意：这条恢复分支只服务宽度/手柄模式；split 事务入口另有更窄的局部例外
        // （isActiveOnlySplitCompatible），那个例外必须单独判定，绝不与这里共用 fail-open。
        evidence = "confirmed";
      }
      if (evidence === "unknown") {
        // 组成不可判定 → 绝不改手柄锁、也绝不臆测模式（fail-closed 语义不变）；但本会话
        // **已经接管过**的宽度模式与组成读面无关，视口变了（或宿主重启后夺回了那份 px）就必须按
        // 同一比例重算，否则窗口最大化后宿主会一直保留旧视口下的 px 偏好（见 recomputeOwnedWidth）。
        recomputeOwnedWidth(current);
        return;
      }
      if (evidence === "confirmed") {
        // openTargets 已在同一同步栈为这个 surface 成功预置过 20% 时，只消费 prepared 标记；
        // 否则这是从其它可调分页重新进入 Expert Group，必须强制恢复 20%。只有宽度已经成功
        // 落到宿主（本轮 prepared 或此前 active）才允许提交 expert 模式并锁手柄。
        // prepared / active 只按当前 sessionId 读取：别的会话的记账绝不参与判定。
        const prepared = isWidthPrepared(current);
        const alreadyActive = isWidthActive(current);
        let widthReady = prepared || alreadyActive;
        if (!widthReady) {
          // 归属由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
          widthReady = applyRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, true);
        } else {
          const viewportChanged = rightbarWidthViewportChanged(current) === true;
          // 一次面板读数同时给出 matches / differs 两份结论（见 rightbarOwnershipOf）。
          const ownership = rightbarOwnershipOf(current);
          // 收敛（实际宽度 == target）即清除恢复事件记账：下一次 mismatch 必须是新事件。
          settleRightbarRecovery(current, ownership);
          const hostReclaimed = ownership !== null && ownership.differs === true;
          if (viewportChanged || hostReclaimed) {
            // 两条重新写入边沿，缺一不可：
            // 1. 窗口最大化 / 全屏 / 拖拽改变了视口：20% 是**视口比例**，必须按新视口重新换算并写入，
            //    否则右栏会一直停在最大化之前那份旧像素宽度上（1600 写 320，3200 仍是 320）；
            // 2. **宿主夺回了那份 px**：DSH 重启后宿主从持久化布局恢复它自己那份旧值，而这份恢复
            //    晚于插件的首次写入（视口一直没变）。Expert Group 页的手柄被插件锁住、20% 又是插件
            //    独占比例，因此「面板宽度不再等于插件 target」就是宿主夺回所有权的可验证证据，必须
            //    把 20% 重新写回去，否则用户看到的是「重启后右栏从 640 缩到 320」。
            // 两条判据都为假时一个字节都不写：同一视口的重复通知仍然保持原有去重语义。
            //
            // 写入许可与 recomputeOwnedWidth（unknown 分支）**共用**同一份有界预算：视口变化不再是
            // 绕过预算的独立边沿——取整后仍是同一个 target 的视口变化（3200 → 3201 → 3202 都是 640）
            // 不是新的一次 mismatch 事件；只有预期 target 真的改变才重新获得预算。宿主持续 clamp 或
            // React 延迟提交时「实际宽度 != target」会一直为真，否则就会与宿主的 clamp 无限拉锯。
            //
            // 这条边沿同样要过证据关：面板宽度读不出来（ownership 为 null）时 recoverRightbarWidth
            // 直接 fail-closed——即使视口真的变了，这里也一个字节都不写（读面不可用期间没有任何证据
            // 说明面板宽度偏离了 target，写下去就是无据改写宿主那份**全局**宽度偏好）。
            recoverRightbarWidth(current, RIGHTBAR_WIDTH_RATIO, ownership);
          }
        }
        setWidthPrepared(current, false);
        setWidthActive(current, widthReady);
        setWidthMode(current, widthReady ? "expert" : null);
        rightbarDragLock.setLocked(widthReady);
        return;
      }
      if (evidence === "missing") {
        // 没有 active tab 不等于存在其它页：清理当前会话已确认的模式并交还手柄，但不猜测性写入 50%。
        clearRightbarWidthMarks(current);
        rightbarDragLock.setLocked(false);
        return;
      }
      // 第一次确认任一 pane 存在其它页时把总右栏预置到 50%；随后只交还手柄，用户拖动出的
      // 宽度由宿主持有。重复通知不会重写 50%（只按当前会话的 other 模式去重），宽度桥接失败
      // 则保持模式未提交，便于以后重试。
      const otherModeMissing = widthModeOf(current) !== "other";
      // 「首次确认其它页」这条边沿无条件预置 50%；视口变化触发的重算则**必须先证明宿主宽度所有权**
      // （面板实际宽度仍等于插件上次写入的 target）。50% 是可调状态，用户在其它右侧分页上拖出的
      // 宽度由宿主持有，仅凭「视口变了」就重算会直接覆盖用户的拖拽结果——这与 unknown 分支里的
      // 同一判据（见 recomputeOwnedWidth）保持完全一致的口径。
      const otherNeedsRecompute = otherModeMissing
        || (rightbarWidthViewportChanged(current) && hostWidthMatchesPluginTarget(current));
      if (otherNeedsRecompute) {
        // 写入失败时只在「首次确认其它页」这条边沿把模式置回未提交，视口重算失败不得抹掉
        // 已经确认的 other 模式。
        if (applyRightbarWidth(current, OTHER_RIGHTBAR_WIDTH_RATIO, true)) {
          setWidthMode(current, "other");
        } else if (otherModeMissing) {
          setWidthMode(current, null);
        }
      }
      setWidthPrepared(current, false);
      setWidthActive(current, false);
      rightbarDragLock.setLocked(false);
    };

    /**
     * 当前 surface 会话 id（由 currentSessionIdOf 兼容解析），不解析成 root。
     *
     * global `sidebarRight.openTab(kind, options)` 没有会话参数：它只会画在「已挂载
     * 会话」上，也就是当前 surface。当前视图可能正是一个 child 子代理会话，此时它的 root
     * 反而是「非当前目标」——用 global 去开它会画到 child 的 surface 上，也会错误地把该
     * root 记成已打开。因此这里返回原始 current，只允许与它完全相同的目标借用 global
     * 接口；解析不出当前会话时返回 null，任何目标都不算当前 surface，全部改走按会话定位。
     */
    const currentSurfaceSessionId = () => currentSessionIdOf(listSnapshot({ ...config, sessions }, ctx));
    /**
     * 打开某个 surface 会话的原生 Expert Group 页面；返回 false 表示当前 DSH 无法按该
     * 会话定位页面（保持未打开状态，由后续会话通知重试）。
     *
     * 顺序固定：
     * 1. 按会话解析出的 session-scoped `sidebarRight.openTab(kind, options)`——公开
     *    接口，作用域实例把该 surface 会话带进打开请求，是唯一能服务任意 surface 的
     *    正规路径（root 与 child 同样适用）；
     * 2. 根级 `sidebarRight.openTab(kind, options)`——同一公开接口，但作用在已挂载
     *    会话上，所以**只有与当前 surface 完全相同的目标**才允许调用；用它去开别的
     *    surface 会把页面画到错误的会话上，也会错误地把那些目标当成已打开；
     * 3. 旧 `openTabIn(sessionId, kind, options)`——它**不属于** ISidebarRight，只是
     *    Tab domain 的按会话内部路径，是旧 DSH 里唯一能按任意会话定位的兼容回退。
     */
    const openNativeTab = (target) => {
      const scopedSidebar = nativeSidebarFor(target);
      if (typeof scopedSidebar?.openTab === "function") {
        scopedSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (target === currentSurfaceSessionId() && typeof nativeSidebar?.openTab === "function") {
        nativeSidebar.openTab("expert-group", { revealIfOpened: true });
        return true;
      }
      if (typeof nativeSidebar?.openTabIn === "function") {
        nativeSidebar.openTabIn(target, "expert-group", { revealIfOpened: true });
        return true;
      }
      return false;
    };
    /**
     * split 入口的**窄口径 active-only 兼容例外**（本文件唯一一处；rightbarCompositionEvidenceOf
     * 的结论本身不变）。
     *
     * 为什么需要它：真实 DSH 重启后首次进入 Expert Group 页时，宿主只提供 active()——
     * sidebarRight.openTabs 这个公开 inventory 与 dockkit 的右栏 DOM 读面都还不存在（或读不到）。
     * rightbarCompositionEvidenceOf 对这种 active-only 形状保守返回 "unknown"，而 beginSidebarSplit
     * 原本把 unknown 当 fail-closed，于是行尾橙色 >> 的点击在调用 split()/openResource() 之前就
     * 静默中止：宿主上什么都没发生，用户看到的就是「点了没反应」。
     *
     * 为什么只在这里放开：这条例外只作用于「会创建新 pane」的 split 入口，并且要求三个条件同时
     * 成立，缺一不可：
     * 1. active() 明确就是 Expert Group（other/missing/unknown 一律不放行，绝不放开错误状态）；
     * 2. 目标就是当前可见 surface（否则新 pane 会落到后台会话的布局上）；
     * 3. openTabs inventory 与右栏 DOM **两个组合读面都不可用**（任意一面返回非 null 就说明宿主
     *    能给出真实组成证据，此时必须回到 fail-closed，由 rightbarCompositionEvidenceOf 说话）。
     * 读面不可用（null）本身不代表「没有其它页」，只代表宿主没有这个读面；在这种宿主上 active()
     * 就是唯一的公开组成证据，且既有宽度策略早已按同口径采信它。新宿主只要有 inventory 或 DOM，
     * 条件 3 立刻不成立，行为与修复前完全一致。
     *
     * 边界：只放宽「是否开始本次事务」。事务内部的临时 50% → split → paneId → openResource
     * （preferNewPane:false）→ 目标 tab 的 inventory+DOM 提交证据 → 15 秒 deadline → 取消回滚
     * 全部逻辑逐字不变；读面一直不可用时同样由 deadline 收口回 20%。
     */
    const isActiveOnlySplitCompatible = (sessionId, activeEvidence) => {
      if (activeEvidence !== "confirmed") return false;
      try { if (currentSurfaceSessionId() !== sessionId) return false; } catch { return false; }
      return compositionReadFacesUnavailable();
    };

    /**
     * 首次从 Expert Group-only pane 分栏的协调器。
     *
     * split() 在右栏仅 20% 时可能返回 undefined；事务在调用前强制写入 50%，暂时交还拖拽手柄，
     * 并把 pane、openResource、openTabs 与 DOM 证据拆成几个阶段。只有目标 subagentchat tab
     * 已经位于 split 返回的 pane 才提交 other 模式；失败时若只留下 guide pane，保留 50% 供用户调整。
     * 入口的 composition 判定见 isActiveOnlySplitCompatible：它只放宽「是否开始本次事务」，
     * 事务本身（paneId 回执、preferNewPane:false、提交证据、deadline、取消回滚）逐字不变。
     */
    const beginSidebarSplit = (details) => {
      if (disposed) return { busy: true };
      const input = details !== null && typeof details === "object" ? details : {};
      const sessionId = text(input.sessionId, null);
      if (sessionId === null || currentSurfaceSessionId() !== sessionId) return null;
      // 防重入只针对**同一个 session**：本会话已有在途事务时拒绝第二次 split，绝不产生竞争 pane；
      // 别的 session 的在途事务与本次请求无关，不得把点击挡成 busy（一个卡住的会话不再冻结全部会话）。
      if (rightbarSplitTransactions.has(sessionId)) return { busy: true };
      // split 只允许从已确认的 Expert Group-only composition 开始。active() 缺失、当前
      // 已是其它页或 openTabs/DOM 给出其它 pane 证据时都 fail-closed，避免把新 pane
      // 叠到一个已经可调的用户布局上；唯一例外是上面那个窄口径的 active-only 兼容分支。
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition !== "confirmed" && isActiveOnlySplitCompatible(sessionId, activeEvidence) !== true) return null;
      const prepared = applyRightbarWidth(sessionId, OTHER_RIGHTBAR_WIDTH_RATIO, true);
      if (prepared !== true) return null;
      const token = {};
      const transaction = {
        token,
        sessionId,
        rootSessionId: text(input.rootSessionId, null),
        key: text(input.key, null),
        resourceAddress: text(input.resourceAddress, null),
        paneId: null,
        resourceIssued: false,
        // 只捕获**本会话**的旧模式/活跃记账：取消时要还原的也是这个会话自己的状态，
        // 别的会话的记账既不是它的前态、也不能被它写回去。
        previousMode: widthModeOf(sessionId),
        previousActive: isWidthActive(sessionId),
        deadlineTimer: null,
      };
      // 先入表再写宽度：deadline / commit / cancel 都按这张表反查，表里没有的事务一律不再被结算。
      rightbarSplitTransactions.set(sessionId, transaction);
      // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
      clearRightbarWidthMarks(sessionId);
      setWidthMode(sessionId, "split-pending");
      try { rightbarDragLock.setLocked(false); } catch { /* 临时解锁失败不阻断公开 split；同步会继续收口。 */ }
      try {
        transaction.deadlineTimer = globalThis.setTimeout(() => {
          // 迟到的 deadline 只收口**仍然在途的自己那一条**：已被 commit/cancel 收口的 token 查不到
          // 事务，什么都不做，绝不误伤同会话后来居上的新事务或别的会话。
          if (transactionOf(token) !== null) {
            try { cancelSidebarSplit(token, { reason: "deadline" }); } catch { /* deadline 仍须保持有界。 */ }
          }
        }, SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS);
      } catch {
        // 宿主若没有可用的 timer，不能留下永久 50%/解锁状态；直接走同一取消路径。
        cancelSidebarSplit(token, { reason: "deadline-unavailable" });
        return null;
      }
      return { token };
    };

    const markSidebarSplitPane = (token, paneId) => {
      const transaction = transactionOf(token);
      if (transaction === null || typeof paneId !== "string" || paneId.trim() === "") return false;
      transaction.paneId = paneId;
      return true;
    };

    const markSidebarSplitOpen = (token) => {
      const transaction = transactionOf(token);
      if (transaction === null || transaction.paneId === null) return false;
      transaction.resourceIssued = true;
      return true;
    };

    const commitSidebarSplit = (token, evidence) => {
      const transaction = transactionOf(token);
      const observed = evidence !== null && typeof evidence === "object" ? evidence : {};
      if (transaction === null
        || transaction.resourceIssued !== true
        || transaction.paneId === null
        || text(observed.paneId, null) !== transaction.paneId
        || text(observed.tabId, null) === null) return false;
      clearSidebarSplitDeadline(transaction);
      releaseSidebarSplitTransaction(transaction);
      // 迟到提交边界：只有事务所属会话**仍是当前可见 surface** 时，才允许把宿主那份全局宽度
      // 的归属迁移到它名下。用户已经切到别的会话时只收口本事务自己的 transient 记账——
      // 绝不动当前会话的宽度归属、模式、手柄，否则一个后台面板的迟到 observer 回调就会
      // 把用户眼前的会话改回旧会话的布局。
      let current = null;
      try { current = currentSurfaceSessionId(); } catch { current = null; }
      if (current !== transaction.sessionId) {
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      // 提交后宿主那份宽度归本会话的 other 组成所有（本轮没有写宽度，因此显式接管归属）。
      claimRightbarWidthOwnership(transaction.sessionId);
      clearRightbarWidthMarks(transaction.sessionId);
      setWidthMode(transaction.sessionId, "other");
      try { rightbarDragLock.setLocked(false); } catch { /* 提交后的手柄必须可调，失败由后续同步重试。 */ }
      return true;
    };

    function cancelSidebarSplit(token, details) {
      const transaction = transactionOf(token);
      if (transaction === null) return false;
      clearSidebarSplitDeadline(transaction);
      // 只移除自己那一条：同会话后来居上的新事务、以及别的会话的在途事务都不受影响。
      releaseSidebarSplitTransaction(transaction);
      const current = currentSurfaceSessionId();
      if (current !== transaction.sessionId) {
        if (current === null) {
          // 终止边沿（没有任何可见 surface 接手）：宿主那份全局宽度只能由这里收口，
          // 否则会长期停留在事务期间的临时 50%。恢复的是旧事务会话自己的 20%。
          const restored = applyRightbarWidth(transaction.sessionId, RIGHTBAR_WIDTH_RATIO, true);
          claimRightbarWidthOwnership(transaction.sessionId);
          setWidthPrepared(transaction.sessionId, restored === true);
          setWidthActive(transaction.sessionId, restored === true);
          setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
          try { rightbarDragLock.setLocked(restored === true); } catch { /* 后续同步重估。 */ }
          return true;
        }
        // 可见 surface 已切到**另一会话**：只清理这个被切走的事务和它自己的 transient 记账，
        // 绝不回滚宽度、绝不改写当前会话的 active/prepared/mode，也不按旧会话去锁手柄——宿主
        // 那份全局宽度交给随后针对 current 的同步自行判定 20%/50%。
        clearRightbarWidthMarks(transaction.sessionId);
        return true;
      }
      let activeEvidence = "unknown";
      try { activeEvidence = activeTabEvidenceOf(transaction.sessionId); } catch { activeEvidence = "unknown"; }
      let composition = "unknown";
      try { composition = rightbarCompositionEvidenceOf(transaction.sessionId, activeEvidence); } catch { composition = "unknown"; }
      if (composition === "other") {
        // split 已留下一个真实的其它 pane（通常是 seeded guide）：保留 50%，继续允许用户调整。
        // 本轮没有写宽度，因此显式接管归属（旧会话的 transient 记账随之失效）。
        claimRightbarWidthOwnership(transaction.sessionId);
        clearRightbarWidthMarks(transaction.sessionId);
        setWidthMode(transaction.sessionId, "other");
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步仍会重估。 */ }
        return true;
      }
      const shouldRestoreExpert = transaction.previousMode === "expert" || composition === "confirmed";
      if (shouldRestoreExpert) {
        // 归属已由写入路径接管（applyRightbarWidth → claimRightbarWidthOwnership）。
        const restored = applyRightbarWidth(transaction.sessionId, RIGHTBAR_WIDTH_RATIO, true);
        setWidthPrepared(transaction.sessionId, restored === true);
        setWidthActive(transaction.sessionId, restored === true);
        setWidthMode(transaction.sessionId, restored === true ? "expert" : null);
        try { rightbarDragLock.setLocked(restored === true); } catch { /* 后续同步重估。 */ }
      } else {
        // 还原的只是本会话自己的前态（别的会话的记账与它无关）。
        setWidthPrepared(transaction.sessionId, false);
        setWidthActive(transaction.sessionId, transaction.previousActive === true);
        setWidthMode(transaction.sessionId, transaction.previousMode === "other" ? "other" : null);
        try { rightbarDragLock.setLocked(false); } catch { /* 后续同步重估。 */ }
      }
      return true;
    }

    // 面板只多拿这几个事务注入点：其余 config 字段逐项不变；没有 install coordinator 的
    // 直接 createExpertGroupPanel 测试/宿主仍沿用旧的 split + openResource 兼容路径。
    const panel = createExpertGroupPanel({
      ...config,
      syncRightbarDragLock: requestRightbarDragSync,
      releaseRightbarDragLock,
      beginSidebarSplit,
      markSidebarSplitPane,
      markSidebarSplitOpen,
      commitSidebarSplit,
      cancelSidebarSplit,
    });

    const unsubscribe = subscribeSessions({ ...config, sessions }, ctx, openTargets);
    disposers.push(typeof unsubscribe === "function" ? unsubscribe : () => {});

    if (better) {
      if (typeof better.registerTab === "function") {
        const release = better.registerTab({
          id: "expert-group",
          title: "expert group",
          single: true,
          component: panel,
          // Better 的 tab 图标契约是「size → React 元素」的函数（宿主只把尺寸传进来，
          // 渲染时机与容器由它决定），因此这里传的是工厂而不是元素。缺 react 时整条
          // icon 字段都不写：宿主照常渲染一个无图标的 tab，注册契约的其余字段不变。
          ...(brandIcon === null ? {} : { icon: (size) => brandReact.createElement(brandIcon, { size }) }),
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof better.subscribeState === "function") {
        try {
          const unsubscribeState = better.subscribeState(openTargets);
          if (typeof unsubscribeState === "function") disposers.push(unsubscribeState);
        } catch { /* 旧版 Better Sidebar 没有设置订阅时仍可初次打开。 */ }
      }
      openTargets();
    } else {
      if (typeof tabs?.register === "function") {
        const release = tabs.register({
          id: "dsh-expert-group",
          kind: "expert-group",
          // 子代理 tab 成为 active 后仍保留面板 body，observer/轮询才能继续完成同 pane 的 float 回退。
          keepMounted: true,
          title: () => "expert group",
          guide: [{
            order: 40,
            title: () => "expert group",
            description: () => "查看当前会话的专家任务树",
            // 原生 guide 卡片的图标契约与 Better 相反：宿主以**组件**形式渲染它
            // （`<Icon size={22|26} />`），因此传组件本身，不预构造元素。
            // 缺 react 时同样整条不写，宿主退回到自己的立方体占位。
            ...(brandIcon === null ? {} : { icon: brandIcon }),
          }],
        });
        if (typeof release === "function") disposers.push(release);
      }
      if (typeof slots?.register === "function") {
        const release = slots.register({ name: "sidebar.right.pane.tab", key: "dsh-expert-group" }, panel);
        if (typeof release === "function") disposers.push(release);
      }
      openTargets();
    }
    /**
     * 视口尺寸变化（窗口最大化 / 全屏 / 拖拽窗口边缘 / 旋转屏幕）后重新换算右栏宽度。
     *
     * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store
     * 的是像素值。没有这条边沿，窗口最大化后宿主会一直沿用最大化之前那份旧像素宽度，比例不再
     * 成立（1600 视口写 320，最大化到 3200 后仍是 320，而正确值是 640）。
     *
     * 四条约束：
     * - 只读公开的 window 事件，且全程按**可选 API** 处理：没有 window、没有 addEventListener、
     *   代理读取抛错时静默降级为「只靠既有 observer + 2.5 秒轮询兜底」——那条链路同样会靠
     *   视口记账发现变化并补写（见 rightbarWidthViewportChanged），因此老宿主不会失效；
     * - **add 与 remove 必须同时存在**才注册：宿主只有 addEventListener 时（旧 WebView、被冻结
     *   的事件面），注册会成功而 dispose 的注销永远失败，那次 install 的闭包就被永久留在宿主
     *   window 上——每装一次泄漏一个，卸载后仍会被 resize 事件唤醒。这种宿主整条放弃快路径，
     *   同样退回上面那条 observer + 2.5 秒轮询兜底，功能不缺失；
     * - 监听在 install 注册、dispose 移除（走统一的 disposers），绝不在宿主上留下长期监听；
     * - 高频 resize 只在**视口宽度真的变了**时才请求同步：同一宽度的连发事件直接短路，既不做
     *   无谓的组成读面求值，也让行为保持确定性（同步栈内立即生效，不需要推进任何定时器）。
     */
    let lastObservedViewportWidth = viewportWidthOf();
    const onViewportResize = () => {
      if (disposed) return;
      const viewportWidth = viewportWidthOf();
      if (viewportWidth === null) return;
      if (lastObservedViewportWidth === viewportWidth) return;
      lastObservedViewportWidth = viewportWidth;
      // 复用既有的宽度/手柄/配比同步链路：不新开一条并行路径，也不直接在这里写宽度。
      requestRightbarDragSync();
    };
    try {
      const viewportTarget = globalThis.window ?? null;
      // 注册条件必须**同时**要求 add 与 remove：宿主只有 addEventListener 时注册会成功、
      // dispose 的注销却永远失败，闭包被永久留在宿主 window 上（每次安装泄漏一个，且卸载后
      // 仍会被 resize 事件唤醒）。宁可少一条快路径，也绝不在宿主上留下摘不掉的监听——
      // 缺少任一 API 时完全依赖既有的 observer + 2.5 秒轮询兜底，它们同样按视口记账补写。
      if (typeof viewportTarget?.addEventListener === "function"
        && typeof viewportTarget?.removeEventListener === "function") {
        viewportTarget.addEventListener("resize", onViewportResize);
        disposers.push(() => {
          try { viewportTarget.removeEventListener("resize", onViewportResize); } catch { /* 注销抛错的宿主只能放弃这条监听。 */ }
        });
      }
    } catch { /* 没有 window 或代理读取抛错：只靠既有 observer 与 2.5 秒轮询兜底。 */ }
    // 到这里 install 函数体里的全部读面（readSurfaceOpenTabs / currentSurfaceSessionId /
    // rightbarDragSyncImpl）都已初始化完成：接线配比读面，后续每一轮同步都能安全求值。
    // 刻意排在 install 函数体的**最后**：任何一次同步（包括下面这次立即求值）都要等这些读面
    // 初始化完成，否则会撞上 const 的 TDZ（异常被同步入口的 try/catch 吞掉，配比就永远写不进去）。
    // 在它之前发生的同步（install 中段那一轮 openTargets）只会拿到 null 读面并安全跳过。
    splitTrackReader = {
      /**
       * 读当前 surface 那条 surface 的分栏容器：session → panel → split 三级读面都必须精确唯一。
       *
       * 返回 { status, container }：
       * - "target"：组成可证明，容器就是本次要施加配比的那一个；
       * - "pending"：结构上仍是两列、列 0 明确是本会话的 Expert Group 页，但列 1 的内容这一轮
       *   读不出来（重启恢复窗口：tab 条 / inventory 归属还没提交）。容器照常返回，调用方据此
       *   保持已写下的配比并短延迟重试——这正是「不闪回宿主默认值」的唯一来源；
       * - null：会话读不出来、inventory 不可用、没有属于本会话的 panel、panel 归属有歧义、
       *   或组成明确不是目标（单列 / 三列 / Expert Group 消失 / 归属冲突）。调用方交还宿主样式。
       *
       * fail-closed 边界不因 pending 放松：pending 只在列 0 的目标身份**已被证明**时才可能返回，
       * 任何未知归属、重复或混合列都仍然走 null（明确非目标），绝不靠猜测进入 pending。
       */
      readTarget(doc) {
        let sessionId = null;
        try { sessionId = currentSurfaceSessionId(); } catch { sessionId = null; }
        if (typeof sessionId !== "string" || sessionId === "") return null;
        // 严格归属：tabId 必须能在当前 session 的 inventory 里对上，绝不用全局 kind 猜测。
        const tabSets = sidebarTabSetsForSession(readSurfaceOpenTabs(), sessionId);
        if (tabSets === null) return null;
        // panel 按 data-sidebar-right-session 精确选择：同名多 panel = 归属不明确，直接放弃。
        const panel = rightbarPanelForSession(doc, sessionId);
        if (panel === null) return null;
        const container = resolveSplitContainer(panel, tabSets);
        if (container !== null) return { status: "target", container };
        // 两列结构仍在、列 0 仍是 Expert Group 页，只有列 1 的内容读不出来：暂不可读。
        // 单列 / 三列 / 混合列 / 重复列号等形状在这里都拿不到 "unavailable"，一律交还宿主。
        const candidates = splitPairPendingContainers(panel, tabSets);
        if (candidates.length === 1) return { status: "pending", container: candidates[0] };
        return null;
      },
    };
    // install 收尾立即求值一次：中段那一轮 openTargets 触发的同步当时读面还是 null（已跳过），
    // 而右栏 DOM 此刻可能已经是「两列」的形状（刷新恢复的分栏）——不能让 Expert Group 页
    // 停在宿主的等分比例上等下一次 observer/轮询。
    try { requestSplitTrackSync(); } catch { /* 配比只是布局微调，绝不影响 install。 */ }
    return () => {
      if (disposed) return;
      // 先置位再取消事务：cancel/observer 可能同步重入同步入口，必须让它们看到已销毁状态。
      disposed = true;
      // 逐条收口：每条事务只清理自己所属会话的 transient 记账与 deadline，互不干扰。
      cancelAllSidebarSplits("dispose");
      // 先清掉未执行的所有 deferred 任务（展开 + 补偿打开重试）：卸载后插件不得再碰宿主
      // layout，也不留下泄漏的 timer。
      cancelAllRightbarExpands();
      cancelAllSurfaceOpens();
      // 过渡抑制同样要收尾：取消挂起的延迟恢复、收口所有记录上尚未消费的句柄，并立刻把
      // frame/panel 上的内联样式还原、断开 observer，绝不把「无过渡」这个临时状态留给宿主。
      flushInstantRestore();
      for (const record of surfaceRecords.values()) releaseTransitionRestore(record);
      // 连续性遮罩单例兜底释放（记录级释放已经覆盖它，这里防漏）。
      continuityOverlay.release();
      // 右栏拖拽手柄锁收尾：还原内联样式（锁本身复用面板那条 tab 观察生命周期，不另持观察器），
      // 绝不在宿主上留下「永久不可拖拽」的手柄；宽度记账同样只属于本次安装，一并清空。
      rightbarDragLock.dispose();
      // 首次分栏的列宽配比同样只属于本次安装：把 split 容器的内联 grid-template-columns 还回
      // 宿主原本的值与优先级，并置位 disposed（此后的迟到同步一律不再写入）。
      splitTrackRatio.dispose();
      rightbarWidths.clear();
      // 视口记账与 rightbarWidths 同属本次安装的目标值状态，一并清空（resize 监听已由 disposers 移除）。
      rightbarWidthViewports.clear();
      // per-session 的 transient 记账（模式 / 预置 / 已确认活跃）同样只属于本次安装生命周期。
      rightbarWidthModes.clear();
      rightbarWidthPreparedSessions.clear();
      rightbarWidthActiveSessions.clear();
      // 恢复事件记账（target / 观测到的实际宽度 / 已用预算）同样只属于本次安装生命周期。
      rightbarWidthRecoveries.clear();
      for (let index = disposers.length - 1; index >= 0; index -= 1) {
        try { disposers[index](); } catch { /* 一个 disposer 失败不能阻止其它所有权释放。 */ }
      }
    };
  }

  global[SYMBOL] = Object.freeze({
    createExpertGroupPanel,
    installExpertGroupSidebar,
    /**
     * 品牌图标 artwork 的**唯一**运行期来源（双人 users 图标，与宿主「智能体团队」入口同源）。
     * client.js 的设置页导航图标适配优先取用它；侧栏模块缺失时才回落到 client.js 内的同值
     * 兜底字面量，两处一致性由测试断言守住。
     */
    BRAND_ICON_PATHS,
    /** 品牌图标组件解析（宿主导出优先、内联 artwork 回落、react 缺失返回 null）。 */
    createBrandIcon,
  });
})(globalThis);
