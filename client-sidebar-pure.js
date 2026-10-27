/**
 * 客户端侧栏 · 常量 / 归一 / 无障碍播报 / 格式化助手（R5 / sidebar-pure）
 *
 * 本模块只放「无 DOM、无轮询、无可变状态」的纯数据面：展示词表与选择器常量、
 * 宽度偏好归一、模型 API 的惰性取用、快照归一化、状态归一、无障碍播报事件推导，
 * 以及 Panel 用的格式化/角色显示名助手。
 *
 * 唯一的运行时依赖是 ledger 模块的 sidebarLocalStorage（宽度偏好持久化与账本共用
 * 同一份「安全读 localStorage」实现，不复制第二份）；装配顺序因此把 ledger 排在
 * pure 之前（见 scripts/client-source-manifest.mjs）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-pure")]
 * 装配：只从 globalThis 检查点取回依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarPure(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const AUTO_LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const AUTO_LEDGER = global[AUTO_LEDGER_SYMBOL] || {};
  const {
    sidebarLocalStorage,
  } = AUTO_LEDGER;

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
  /**
   * attempt 状态的展示文案（票据 12 时间线）。
   *
   * 协议词表 → 用户可读词；不在表里的值原样展示（未知值不猜、也不隐藏）。
   * 这些文案只属于时间线，不参与任务行圆点（圆点仍只有 running/ready/unknown）。
   */
  /** 「查看全部」展开选择的记账上限（见 renderAttemptTimeline 的有界淘汰）。 */
  const TIMELINE_EXPANDED_KEY_LIMIT = 256;
  const ATTEMPT_STATUS_LABELS = Object.freeze({
    queued: "排队", waiting: "等待", running: "运行中", succeeded: "成功", failed: "失败",
    cancelled: "已取消", timed_out: "超时", interrupted: "已中断", idle: "空闲", ready: "就绪", unknown: "未知",
  });
  /**
   * 状态筛选下拉的选项：**恰好三项**——运行中 / 未完成 / 已完成。
   * value 必须与 model.STATUS_FILTER_GROUPS 的（同样是三个）键一致；
   * 渲染层不解析协议状态，只把分组键交给模型过滤器。三组对协议状态词表构成完整划分，
   * 因此任何节点都不会在某个状态筛选下从视图里消失（失败/超时/中断/取消与证据不足的
   * idle/ready/unknown 统一归入「未完成」）。
   */
  const STATUS_FILTER_OPTIONS = Object.freeze([
    Object.freeze({ value: "running", label: "运行中" }),
    Object.freeze({ value: "incomplete", label: "未完成" }),
    Object.freeze({ value: "completed", label: "已完成" }),
  ]);
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
   * 用户可调宽度的边界与持久化键（票据 18）。
   *
   * 20% 只是**默认值**：用户拖拽手柄或按方向键调整之后，比例写进 localStorage，之后每次
   * 挂载、视口变化与「宿主夺回宽度」的恢复写入都按这份偏好重算（见 resolveExpertRightbarWidthRatio）。
   * 边界取舍：
   * - 下限 15%：再窄用量摘要条（用时/tok/s/tok/命中/context）与批量控件会挤成不可读的一列；
   * - 上限 50%：与宿主「其它右侧分页」的可调上限一致，Expert Group 页绝不比宿主自己的分栏模式更宽；
   * - 比例是**视口比例**，写进宿主 layout store 的仍是取整后的像素值。
   */
  const RIGHTBAR_WIDTH_RATIO_MIN = 0.15;
  const RIGHTBAR_WIDTH_RATIO_MAX = 0.5;
  const RIGHTBAR_WIDTH_PREFERENCE_KEY = "dsh-expert-group/rightbar-width-ratio:v1";

  /**
   * 比例归一：只接受可转成有限数字的值，并 clamp 到 [0.15, 0.5]；非法值返回 null。
   *
   * 返回 null 而不是默认值：调用方必须能区分「明确是 0（或坏值）→ 拒绝这次输入」与
   * 「用户想要 20%」。持久化读面才负责把非法/缺失归一到默认 20%。
   */
  function clampRightbarWidthRatio(value) {
    const numeric = typeof value === "number" ? value : Number(value);
    if (Number.isFinite(numeric) !== true) return null;
    if (numeric < RIGHTBAR_WIDTH_RATIO_MIN) return RIGHTBAR_WIDTH_RATIO_MIN;
    if (numeric > RIGHTBAR_WIDTH_RATIO_MAX) return RIGHTBAR_WIDTH_RATIO_MAX;
    return numeric;
  }

  /**
   * 读取持久化的宽度偏好：缺失、坏值或被越界写成极端值的旧数据一律归一到默认 20%。
   *
   * localStorage 不可用（隐私模式、被宿主策略禁用、SSR）时返回默认值，绝不抛错；宽度功能
   * 因此退化成「每次都用默认比例」，但页面与轮询不受影响。
   */
  function readStoredRightbarWidthRatio() {
    const storage = sidebarLocalStorage();
    if (storage === null) return RIGHTBAR_WIDTH_RATIO;
    let raw = null;
    try { raw = storage.getItem(RIGHTBAR_WIDTH_PREFERENCE_KEY); } catch { raw = null; }
    if (typeof raw !== "string" || raw.trim() === "") return RIGHTBAR_WIDTH_RATIO;
    const clamped = clampRightbarWidthRatio(Number(raw.trim()));
    return clamped === null ? RIGHTBAR_WIDTH_RATIO : clamped;
  }

  /**
   * 写入宽度偏好：先 clamp 再落盘；存储不可用/抛错时静默失败。
   *
   * 写入失败**不**回滚本次宽度：用户已经看到的宽度必须立即生效，偏好丢失只影响下次挂载。
   */
  function storeRightbarWidthRatio(value) {
    const clamped = clampRightbarWidthRatio(value);
    if (clamped === null) return null;
    const storage = sidebarLocalStorage();
    if (storage === null) return clamped;
    try { storage.setItem(RIGHTBAR_WIDTH_PREFERENCE_KEY, String(clamped)); } catch { /* 见上：本次仍生效。 */ }
    return clamped;
  }

  /** Expert Group 页当前生效的宽度比例：持久化偏好（已 clamp）或默认 20%。 */
  const resolveExpertRightbarWidthRatio = () => readStoredRightbarWidthRatio();
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
   * SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS = 2 次连续缺失确认（运行态 2.5 秒轮询 ⇒ 正常验证窗口约 5 秒；
   * 票据 16 之后空闲态按阶梯退避、隐藏/非活跃暂停，验证窗口相应变宽，但 inventory 通知与 observer
   * 仍会立刻推进，因此这只是「最坏情况下再确认一次」的上界，而不是常见路径的延迟）。
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

  // ── 票据 25 / 26 / 27 / 28：侧栏消费的宿主 meta 与派发入参归一 ─────────────────
  //
  // 这些是纯函数：不做 RPC、不读写宿主状态，只在渲染/事件路径把注入值收敛成
  // 「有界、缺字段保持缺失」的形状。所有 RPC 仍走 callRpc 这唯一入口。

  /** meta.activeRoles/roles 的条目上限：Host 侧最多 16 个自定义 + 6 个内置角色。 */
  const HOST_META_ROLE_LIMIT = 32;

  /**
   * 宿主 meta 的只读归一（票据 25/26/27）。
   *
   * 只保留侧栏真正消费的字段，且**缺什么就是什么**：
   * - roles：activeRoles（优先）或 roles，去重、限条数；只按宿主运行期列表收集，
   *   不按客户端静态内置角色表过滤：保留历史显示名，不因角色表收缩而丢标签；
   * - roleLabels：角色 id → 显示名（含历史角色显示名，包括已删除角色的持久化标签）；
   * - modelPrices：原样数组（每一项的合法性由 findModelPrice/estimateUsageCost 再校验）；
   * - throttle：diagnostics.fanout.concurrency.throttle（role/provider 的 limit/running/queued/etaMs）；
   * - usage：全局用量聚合（totals/byRole/...），只用于诊断区展示。
   */
  function normalizeHostMeta(value) {
    const source = object(value);
    const roles = [];
    const rawRoles = Array.isArray(source.activeRoles) ? source.activeRoles : (Array.isArray(source.roles) ? source.roles : []);
    for (const entry of rawRoles) {
      if (roles.length >= HOST_META_ROLE_LIMIT) break;
      const role = text(entry, null);
      if (role !== null && roles.indexOf(role) === -1) roles.push(role);
    }
    const diagnostics = object(source.diagnostics);
    const fanout = object(diagnostics.fanout);
    const concurrency = object(fanout.concurrency);
    return {
      roles,
      roleLabels: object(source.roleLabels),
      /**
       * 全局角色默认（与 Host 的 resolveRole 同源）：侧栏「会话模型」据此显示「跟随全局默认」。
       * 原样保留映射形状，逐角色合法性由 normalizeSessionModelSelection 在消费点再校验。
       */
      roleDefaults: object(source.roleDefaults),
      /**
       * 全局主代理配置（{ defaults, candidates, fallbackLimit }，批次 A 读面）。
       *
       * 只在 get().orchestrator 读不到时用作「已配置值」的兜底展示；优先级判定（覆盖 > 时段 >
       * 全局）仍由 Host 读面给出，客户端绝不自己重算一套。
       */
      orchestrator: object(source.orchestrator),
      modelPrices: Array.isArray(source.modelPrices) ? source.modelPrices : [],
      usage: object(source.usage),
      throttle: Object.keys(concurrency.throttle === undefined ? {} : object(concurrency.throttle)).length === 0
        ? null
        : object(concurrency.throttle),
      capabilities: object(source.capabilities),
    };
  }

  // ── 侧栏「会话模型」：与设置页同一套会话级覆盖语义的纯函数投影 ─────────────
  //
  // 侧边栏与设置页是两个独立客户端组件（classic bundle，无法互相 import），因此这里保留
  // 一组**形状收敛**的纯函数：不发 RPC、不读写宿主状态，只把注入值收敛成有界结构。
  // 所有读写仍走 callRpc 这唯一入口，语义与设置页 useSessionOverrideSection 逐条对齐。

  /** 主代理在会话覆盖表里的保留键（与 Host 的 ORCHESTRATOR_SELECTION_KEY 同值）。 */
  const ORCHESTRATOR_ROW_KEY = "orchestrator";

  /** meta.roles 缺失/为空时的回退角色表（与 Host 内置角色同源，顺序即展示顺序）。 */
  const SESSION_MODEL_ROLE_FALLBACK = Object.freeze(["explorer", "librarian", "oracle", "designer", "fixer", "observer"]);

  /**
   * 归一一个会话级 selection：只接受非空 provider/model 与可选字符串 effort。
   *
   * 返回的始终是新的普通对象：响应里的未知字段不会被带进 UI 状态，也不会被回写进请求体。
   */
  function normalizeSessionModelSelection(selection) {
    if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return null;
    if (typeof selection.provider !== "string" || selection.provider.length === 0) return null;
    if (typeof selection.model !== "string" || selection.model.length === 0) return null;
    const effort = typeof selection.reasoningEffort === "string" ? selection.reasoningEffort : "";
    return {
      provider: selection.provider,
      model: selection.model,
      ...(effort.length > 0 ? { reasoningEffort: effort } : {}),
    };
  }

  /** 归一「角色 -> selection」映射：只保留给定角色的合法 selection，坏值整条丢弃。 */
  function normalizeSessionModelOverrides(raw, roles) {
    const overrides = {};
    const source = raw !== null && typeof raw === "object" && Array.isArray(raw) !== true ? raw : {};
    for (const role of Array.isArray(roles) ? roles : []) {
      const selection = normalizeSessionModelSelection(source[role]);
      if (selection !== null) overrides[role] = selection;
    }
    return overrides;
  }

  /**
   * 归一 session-override-get/set/clear 的成功响应。
   *
   * 只有 ok===true 且 revision 是非负安全整数才算成功；其余一律返回 null 由调用方降级为
   * 「读取失败」而不是伪造一份空覆盖。
   */
  function normalizeSessionModelView(body, roles) {
    const source = object(body);
    if (source.ok !== true) return null;
    if (Number.isSafeInteger(source.revision) !== true || source.revision < 0) return null;
    return {
      overrides: normalizeSessionModelOverrides(source.overrides, roles),
      revision: source.revision,
      live: source.live === true,
    };
  }

  /** applyState 的六个稳定取值（Host 契约，见 host/orchestrator-model.js）；读面出现别的值按缺失降级。 */
  const ORCHESTRATOR_APPLY_STATES = ["applied", "pending", "unapplied", "manual", "none", "host-not-ready"];

  /**
   * 主代理行的读面投影：applyState 六态 + 按状态选出的「显示值」。
   *
   * 六态判定表在 Host（host/orchestrator-model.js）：客户端**不得**再用 effective 猜测
   * 「是否实际生效」。这里只按状态选显示值——applied / manual 显示实际套用值，其余
   * （pending / unapplied / host-not-ready / none）显示期望配置。
   * 读面缺失（旧宿主 / get 失败）时按 hostReady 归到 host-not-ready 或 none。
   */
  function sessionModelOrchestratorOf(statusValue, metaValue) {
    const status = object(statusValue);
    const raw = text(status.applyState, null);
    const state = ORCHESTRATOR_APPLY_STATES.includes(raw) === true
      ? raw
      : (status.hostReady === false ? "host-not-ready" : "none");
    const applied = normalizeSessionModelSelection(status.applied);
    // effective 已含「覆盖 > 时段 > 全局」的层级解析，因此不再单独读 configured（同一事实的重复来源）。
    const expected = normalizeSessionModelSelection(status.effective)
      ?? normalizeSessionModelSelection(object(object(metaValue).orchestrator).defaults);
    return {
      state,
      selection: (state === "applied" || state === "manual" ? applied : null) ?? expected,
    };
  }

  /** 草稿 -> 可提交 selection：effort 为空表示「模型默认」，请求里不携带该字段。 */
  function sessionModelSelectionOfDraft(draft) {
    const provider = typeof draft?.provider === "string" ? draft.provider : "";
    const model = typeof draft?.model === "string" ? draft.model : "";
    const effort = typeof draft?.reasoningEffort === "string" ? draft.reasoningEffort : "";
    return { provider, model, ...(effort.length > 0 ? { reasoningEffort: effort } : {}) };
  }

  /** 逐字段比较两个草稿/选择（effort 缺失与空串等价）。 */
  function sessionModelSelectionEquals(left, right) {
    return (left?.provider ?? "") === (right?.provider ?? "")
      && (left?.model ?? "") === (right?.model ?? "")
      && (left?.reasoningEffort ?? "") === (right?.reasoningEffort ?? "");
  }

  /**
   * 角色行的模型候选：provider 非空时取该 group 的 models，否则汇总全部 group 的 models。
   *
   * 只按 id 去重、保持目录声明顺序：候选只用于输入提示（datalist），不参与任何校验。
   */
  function sessionModelModelOptions(provider, groups) {
    const source = Array.isArray(groups) ? groups : [];
    const group = source.find((entry) => text(object(entry).id, null) === provider);
    const models = [];
    const pool = group === undefined
      ? source.flatMap((entry) => (Array.isArray(object(entry).models) ? object(entry).models : []))
      : (Array.isArray(object(group).models) ? object(group).models : []);
    for (const entry of pool) {
      const item = object(entry);
      const id = text(item.id, null);
      if (id === null || models.some((existing) => existing.id === id)) continue;
      models.push(item);
    }
    return models;
  }

  /**
   * 「会话模型」的**行键**：固定第一行主代理（保留键，不是角色）+ meta 角色清单。
   *
   * 只用于覆盖归一 / 待提交改动 / 本地校验：这些判据必须认识主代理的那条覆盖，
   * 但渲染角色行仍然只用 sessionModelRolesOf（主代理另有固定行）。
   */
  function sessionModelRowKeysOf(metaValue) {
    return [ORCHESTRATOR_ROW_KEY, ...sessionModelRolesOf(metaValue)];
  }

  /** 角色清单：meta.roles 优先（保持 Host 顺序、去重），缺失/为空时回退内置角色表。 */
  function sessionModelRolesOf(metaValue) {
    const source = metaValue === null || metaValue === undefined ? {} : object(metaValue);
    const roles = [];
    for (const entry of Array.isArray(source.roles) ? source.roles : []) {
      const role = text(entry, null);
      if (role !== null && roles.indexOf(role) === -1) roles.push(role);
    }
    return roles.length === 0 ? SESSION_MODEL_ROLE_FALLBACK.slice() : roles;
  }

  /**
   * 快照里是否存在任何用量事实（票据 25 的懒加载触发条件）。
   *
   * 只在渲染后的 effect 里读（纯读 normalized 快照），不发请求；命中一次就够：
   * 面板据此按需读取 meta.modelPrices 计算估算成本，不改变任何既有轮询节奏。
   */
  function snapshotHasUsageFact(value, depth = 0) {
    if (depth > 8 || value === null || typeof value !== "object") return false;
    const source = object(value);
    const usage = object(source.usage);
    for (const field of ["inputTokens", "outputTokens", "totalTokens", "billedInputTokens", "requests"]) {
      if (typeof usage[field] === "number" && Number.isFinite(usage[field])) return true;
    }
    // 快照根是 root 字段（不是 children）：先看根节点自身，再看它的子节点/分片/attempt。
    if (snapshotHasUsageFact(source.root, depth + 1)) return true;
    for (const child of Array.isArray(source.children) ? source.children : []) {
      if (snapshotHasUsageFact(child, depth + 1)) return true;
    }
    for (const shard of Array.isArray(source.shards) ? source.shards : []) {
      if (snapshotHasUsageFact(shard, depth + 1)) return true;
      for (const attempt of Array.isArray(object(shard).attempts) ? object(shard).attempts : []) {
        if (snapshotHasUsageFact(attempt, depth + 1)) return true;
      }
    }
    return false;
  }

  /**
   * 分片「最新 attempt 的 childId」，缺失时回退分片自身的 childId（两者都没有返回 null）。
   *
   * 分片每次重试都会换一个 child 会话，只有最新 attempt 才代表这一行**当前**对应的 DSH 会话；
   * 读旧 attempt 的投影会拿到历史会话的数字（用户会看到与状态矛盾的用量）。摘要条聚合与
   * 按需投影加载必须共用这一条归属规则，避免两处各判一次而漂移。
   */
  function latestShardChildIdOf(shard) {
    const source = object(shard);
    const attempts = Array.isArray(source.attempts) ? source.attempts : [];
    const latest = attempts.length === 0 ? null : object(attempts[attempts.length - 1]);
    return text(latest?.childId, text(source.childId, null));
  }

  /**
   * 收集当前 DEG 树里所有「可投影会话」的 id（按首次出现顺序去重）。
   *
   * 用途：sessionStats 属于客户端按需投影，只有会话被打开过或经公开的
   * sessions.refreshProjections(sessionId) 显式刷新后才会进入 sessions 快照；未打开过的 child
   * 不会自动加载，旧专家行因此只能回退 DEG（出现「用时<1s」与缺 TPS）。面板需要在拿到 DEG
   * 快照后按需请求一次，因此先要有这份「树里出现了哪些会话」的纯读清单。
   *
   * 归属规则与摘要条同源：
   * - root：根节点的 sessionId；
   * - 普通专家（可嵌套）：node.sessionId；
   * - 分片：最新 attempt 的 childId，缺失回退 shard.childId；
   * - fan-out 父任务没有单一会话，只贡献各 shard 的最新 childId；
   * - children 递归（深度与节点数都有界，坏数据/手工构造的超大树不会把渲染期卡死）。
   * 缺失或非字符串的 id 直接跳过，绝不猜一个 id 去请求投影。
   */
  function collectSnapshotSessionIds(snapshot) {
    const ids = [];
    const seen = new Set();
    let visited = 0;
    const push = (value) => {
      const id = text(value, null);
      if (id === null || seen.has(id)) return;
      seen.add(id);
      ids.push(id);
    };
    const visit = (node, depth) => {
      if (depth > 12 || visited >= 4096) return;
      const source = object(node);
      if (Object.keys(source).length === 0) return;
      visited += 1;
      push(source.sessionId);
      for (const shard of Array.isArray(source.shards) ? source.shards : []) push(latestShardChildIdOf(shard));
      for (const child of Array.isArray(source.children) ? source.children : []) visit(child, depth + 1);
    };
    visit(object(snapshot).root, 0);
    return ids;
  }

  /**
   * 读取当前视口宽度（px）；读不到（没有 window、非有限数、非正数）时返回 null。
   *
   * 右栏宽度是**视口比例**（Expert Group 页 20%、其它右侧分页 50%），但写进宿主 layout store 的
   * 是像素值；因此「换算」与「视口是否变了」必须共用这一个读面，绝不能在两处各读一次
   * （那会让比例换算与变化检测读到不同的视口）。读不到时返回 null，调用方一律放弃写入，
   * 保留宿主当前值，绝不猜一个宽度。
   */
  /** fan-out 管理状态：只用于取消/重试判定与 data-task-status，不作为展示状态词。 */
  function statusOf(node) {
    const value = text(object(node).status, "unknown");
    return value || "unknown";
  }
  const ANNOUNCEMENT_ACTIVE_STATUSES = new Set(["queued", "waiting", "running"]);
  const ANNOUNCEMENT_FINISHED_STATUSES = new Set(["succeeded", "success", "completed", "complete", "done", "ready"]);
  const ANNOUNCEMENT_FAILED_STATUSES = new Set(["failed", "error", "timed_out", "timeout", "interrupted"]);
  const ANNOUNCEMENT_CANCELLED_STATUSES = new Set(["cancelled", "canceled"]);
  /** 一次播报里最多列出多少个任务：多分片同时结束时只给前 5 个 + 总数，避免长句无法听完。 */
  const ANNOUNCEMENT_MAX_ITEMS = 5;

  /**
   * 从 normalized 快照里收集「播报身份 → { name, status }」。
   *
   * 键必须稳定：普通节点用 id/sessionId，fanout 的分片用 parentTaskId:shardId（shardId 只在
   * 父任务内唯一）。名称只用于播报文案：root 固定「主代理」（与第一行同源），专家用 taskName，
   * 分片优先 taskName、其次 shardId。任何字段缺失都不猜名称，回退到稳定 id。
   */
  function collectAnnouncementTasks(snapshot) {
    const result = new Map();
    const root = object(object(snapshot).root);
    if (Object.keys(root).length === 0) return result;
    const visit = (node, fallbackName) => {
      const source = object(node);
      const id = text(source.id, text(source.sessionId, text(source.parentTaskId, null)));
      if (id === null) return;
      const isRoot = source.kind === "root";
      const name = isRoot
        ? "主代理"
        : text(source.taskName, text(source.sessionId, fallbackName));
      result.set(id, { name: text(name, id), status: statusOf(source) });
      for (const child of Array.isArray(source.children) ? source.children : []) visit(child, id);
      for (const shard of Array.isArray(source.shards) ? source.shards : []) {
        const shardId = text(shard.shardId, null);
        if (shardId === null) continue;
        const shardName = text(shard.taskName, shardId);
        result.set(id + ":" + shardId, { name: shardName, status: statusOf(shard) });
      }
    };
    visit(root, "主代理");
    return result;
  }

  /**
   * 单条状态迁移 → 播报类别；不需要播报时返回 null。
   *
   * 只有**可证明的前态**才产生事件：
   * - 前态是 unknown（轻量快照/证据不足）时不播报，避免「数据补齐」被误读成任务完成；
   * - 同一状态不播报（相同快照的每一轮轮询因此天然去重）；
   * - 取消/失败优先于完成：终态重叠时按用户更关心的坏消息归类；
   * - 完成只认「前态活跃/空闲 → 终态成功」：已经完成的任务再次完成没有新信息。
   */
  function announcementKindOf(previousStatus, nextStatus) {
    if (previousStatus === nextStatus) return null;
    if (previousStatus === "unknown" || nextStatus === "unknown") return null;
    if (ANNOUNCEMENT_CANCELLED_STATUSES.has(nextStatus)) return "cancel";
    if (ANNOUNCEMENT_FAILED_STATUSES.has(nextStatus)) return "fail";
    if (ANNOUNCEMENT_FINISHED_STATUSES.has(nextStatus)) {
      return ANNOUNCEMENT_ACTIVE_STATUSES.has(previousStatus) || previousStatus === "idle" ? "finish" : null;
    }
    if (ANNOUNCEMENT_ACTIVE_STATUSES.has(nextStatus) && ANNOUNCEMENT_ACTIVE_STATUSES.has(previousStatus) !== true) return "start";
    return null;
  }

  /**
   * 比较前后两份播报身份表，返回本轮的状态迁移事件（无变化返回空数组）。
   *
   * 频率控制完全来自「差异」而不是定时器：轮询重复返回同一棵树时事件集合为空，
   * 因此不会重复播报；渲染层把同一轮的多个事件合并成一句（最多 5 项 + 总数），
   * 绝不会为每个节点各播一次。新出现的节点只有**正在运行**才算「开始」——
   * 首次加载历史里的已完成任务绝不补播。文案与分隔符由渲染层按宿主语言拼接（票据 19）。
   */
  function announcementEventsOf(previousTasks, nextTasks) {
    const events = [];
    for (const [id, next] of nextTasks) {
      const previous = previousTasks.get(id);
      const kind = previous === undefined
        ? (ANNOUNCEMENT_ACTIVE_STATUSES.has(next.status) ? "start" : null)
        : announcementKindOf(previous.status, next.status);
      if (kind === null) continue;
      // 只产出结构化事件；文案与分隔符由渲染层按宿主语言拼接（票据 19）。
      events.push({ kind, name: next.name });
    }
    return events;
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
  const modelFunction = (name) => {
    const api = modelApi();
    return api !== null && api !== undefined && typeof api[name] === "function" ? api[name] : null;
  };
  const finiteNumber = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  const formatDurationText = (value) => {
    const fn = modelFunction("formatDuration");
    return fn === null ? null : fn(value);
  };
  /** 摘要条用的紧凑时长（<1s / 1.2s / 1m / 28m27s / 1h / 1h2m），与模型层同一实现。 */
  const formatCompactDuration = (value) => {
    const fn = modelFunction("formatDurationCompact");
    return fn === null ? null : fn(value);
  };
  const formatClockText = (value) => {
    const fn = modelFunction("formatClockTime");
    return fn === null ? null : fn(value);
  };
  const formatIsoText = (value) => {
    const fn = modelFunction("formatIsoTime");
    return fn === null ? null : fn(value);
  };
  const failureSummaryText = (value) => {
    const fn = modelFunction("formatFailureSummary");
    return fn === null ? null : fn(value);
  };
  const isFailureStatusOf = (status) => {
    const fn = modelFunction("isFailureStatus");
    return fn === null ? ["failed", "timed_out", "interrupted"].includes(status) : fn(status) === true;
  };
  const retryWarningThreshold = () => {
    const value = modelApi()?.RETRY_WARNING_THRESHOLD;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 3;
  };
  /**
   * 角色显示名（票据 27）：节点 roleLabel → snapshot.roleLabels → meta.roleLabels → 角色 id。
   * 后两个来源含历史角色显示名（包括已删除角色的持久化标签）。
   *
   * snapshot 与 meta 的合并只在这里发生一次（snapshot 优先），因此筛选下拉、元数据行与
   * 派发表单看到的是同一份显示名；这里只合并宿主/快照给出的显示名，**不按静态内置
   * 角色表过滤**：保留历史显示名，不因角色表收缩而丢标签。
   */
  const mergedRoleLabelsOf = (snapshot, meta) => {
    const sources = [
      snapshot === null || snapshot === undefined ? null : object(snapshot.roleLabels),
      meta === null ? null : object(meta.roleLabels),
    ];
    const merged = {};
    let any = false;
    for (const source of sources) {
      if (source === null) continue;
      for (const key of Object.keys(source)) {
        if (merged[key] !== undefined) continue;
        const label = text(source[key], null);
        if (label === null) continue;
        merged[key] = label;
        any = true;
      }
    }
    return any ? merged : null;
  };
  const roleLabelFromMap = (role, labels) => {
    const api = modelApi();
    return typeof api?.roleLabelFrom === "function" ? api.roleLabelFrom(role, labels) : null;
  };
  const roleLabelFor = (role, nodeLabel, labels) => text(nodeLabel, null)
    ?? roleLabelFromMap(role, labels)
    ?? text(role, null);


  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    ACTIVE_STATUSES, ANNOUNCEMENT_MAX_ITEMS, ATTEMPT_STATUS_LABELS, BRAND_ICON_PATHS,
    EXPERT_GROUP_TAB_IDS, FANOUT_SETTLED_STATUSES, OTHER_RIGHTBAR_WIDTH_RATIO, RETRY_STATUSES,
    RIGHTBAR_DOCK_HOST_ATTRIBUTE, RIGHTBAR_DOCK_HOST_VALUE, RIGHTBAR_FLOAT_SELECTOR, RIGHTBAR_FLOAT_TITLE_SELECTOR,
    RIGHTBAR_PANEL_SELECTOR, RIGHTBAR_PANEL_SESSION_ATTRIBUTE, RIGHTBAR_PANE_COLUMN_ATTRIBUTE, RIGHTBAR_PANE_ID_ATTRIBUTE,
    RIGHTBAR_PANE_SELECTOR, RIGHTBAR_SPLIT_ATTRIBUTE, RIGHTBAR_SPLIT_SELECTOR, RIGHTBAR_STRIP_TABS_ATTRIBUTE,
    RIGHTBAR_STRIP_TABS_SELECTOR, RIGHTBAR_TAB_ID_ATTRIBUTE, RIGHTBAR_TAB_SELECTOR, RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
    RIGHTBAR_WIDTH_RATIO, RIGHTBAR_WIDTH_RATIO_MAX, RIGHTBAR_WIDTH_RATIO_MIN, RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS,
    RUNTIME_STATE_DOT, RUNTIME_STATUS_LABELS, SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS, SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS,
    SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS, SIDEBAR_AUTO_KEY_LIMIT, SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS, SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS,
    SIDEBAR_SPLIT_EXPERT_TRACK, SIDEBAR_SPLIT_GAP_TRACK, SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS, SIDEBAR_SPLIT_OTHER_TRACK,
    SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS, SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS, SIDEBAR_SPLIT_TRACK_PROPERTY, SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS,
    SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS, SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS, SIDEBAR_TAB_CLOSE_WATCHDOG_MS, SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS,
    SIDEBAR_TAB_KEY_SEPARATOR, SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS, SIDEBAR_TAB_ORIGIN_AUTO, SIDEBAR_TAB_ORIGIN_MANUAL,
    STATUS_FILTER_OPTIONS, STYLE_ID, TIMELINE_EXPANDED_KEY_LIMIT, announcementEventsOf,
    clampRightbarWidthRatio, closeSettleReason, collectAnnouncementTasks, collectSnapshotSessionIds,
    failureSummaryText, finiteNumber, formatClockText, formatCompactDuration,
    formatDurationText, formatIsoText, isFailureStatusOf, isGeneratedExpertGroupTabId,
    latestShardChildIdOf, mergedRoleLabelsOf, modelApi, modelFunction,
    normalizeHostMeta, normalizeSessionModelOverrides, normalizeSessionModelSelection, normalizeSessionModelView,
    object, resolveExpertRightbarWidthRatio, retryWarningThreshold, roleLabelFor,
    safeNormalize, sessionModelModelOptions, sessionModelOrchestratorOf, sessionModelRolesOf, sessionModelRowKeysOf, sessionModelSelectionEquals,
    sessionModelSelectionOfDraft, snapshotHasUsageFact, statusOf, storeRightbarWidthRatio,
    text,
  });
})(globalThis);
