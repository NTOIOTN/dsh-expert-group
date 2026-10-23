/**
 * 客户端侧栏 · 拖拽锁与分栏配比（R5 / sidebar-layout）
 *
 * 右栏分栏的交互面：拖拽锁（点击抑制、指针捕获、清理）与 split 容器列轨配比。
 *
 * 依赖 dom 模块的 RIGHTBAR_DRAG_HANDLE_SELECTOR / parseSplitTracks 与 pure 模块的
 * SIDEBAR_SPLIT_* 常量；本模块自身不读写宿主 layout store。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-layout")]
 * 装配：只从 globalThis 检查点取回依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarLayout(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-layout");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_SPLIT_EXPERT_TRACK, SIDEBAR_SPLIT_GAP_TRACK, SIDEBAR_SPLIT_OTHER_TRACK, SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS, SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS, SIDEBAR_SPLIT_TRACK_PROPERTY,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    RIGHTBAR_DRAG_HANDLE_SELECTOR, parseSplitTracks,
  } = DOM;

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

  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    createRightbarDragLock, createSplitTrackRatio,
  });
})(globalThis);
