/**
 * 客户端侧栏 · 轮询调度与 RPC 适配（R5 / sidebar-poll）
 *
 * 侧栏轮询的唯一调度面：快照结构比较、轮询节奏与退避、fan-out 事件批次读取、
 * RPC 失败归因与 callRpc 适配。
 *
 * 本模块不持有轮询状态：所有节流/失败计数都由调用方（Panel）以参数传入，
 * 模块内函数保持纯函数形态，便于既有轮询回归用例直接覆盖。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-poll")]
 * 装配：只从 globalThis 检查点取回依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarPoll(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-poll");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    modelApi, object, text,
  } = PURE;

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
   *
   * 顶层 revision（票据 12）**不参与**这里：它是 Host 对「除 generatedAt 与 revision 自身之外全部
   * 内容」的摘要，语义上等价于下面的逐字段比较，但把它加进来会改变既有短路语义（旧 Host 缺失
   * revision 时两侧恒不相等，轮询会退化成每轮全树重渲染）。客户端因此只归一/导出 revision，
   * 内容相等判定继续完全由本函数负责。
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
   * 侧栏轮询时间表（票据 16）：整个面板的刷新节奏只有这一份常量来源。
   *
   * 语义分层（互不干扰，失败优先）：
   * - 运行态 activeMs：有任务在跑时必须保持接近实时的刷新（沿用既有的 2.5 秒）；
   * - 空闲 idleStepsMs：没有任何运行中的任务时逐档退避（2.5 → 5 → 10 → 20 → 30 秒），
   *   长期空转不再每 2.5 秒发一次请求；
   * - 连续失败 failureBaseMs 起按 1/2/4/8/16… 指数递进，封顶 failureMaxMs（30 秒）。
   *
   * 所有时间都以毫秒计，且只影响「下一轮什么时候排」，不参与任何内容比较；
   * 测试通过注入 setInterval/clearInterval 观察与推进，绝不真实等待。
   */
  const PANEL_POLL_TIMINGS = Object.freeze({
    activeMs: 2500,
    idleStepsMs: Object.freeze([2500, 5000, 10000, 20000, 30000]),
    failureBaseMs: 1000,
    failureMaxMs: 30000,
  });

  /**
   * 连续失败第 n 次应等待多久（n 从 1 开始）：1s → 2s → 4s → 8s → 16s → 30s（封顶）。
   *
   * 指数上限先按 2^(n-1) 计算，再与 failureMaxMs 取小；n 过大时直接钳到封顶，
   * 避免 Math.pow 溢出成 Infinity（那会让 setInterval 收到非法延时）。
   */
  function panelFailureDelayMs(failureCount) {
    const count = Number.isSafeInteger(failureCount) && failureCount > 0 ? failureCount : 0;
    if (count === 0) return 0;
    const exponential = PANEL_POLL_TIMINGS.failureBaseMs * Math.pow(2, Math.min(count - 1, 16));
    return Math.min(exponential, PANEL_POLL_TIMINGS.failureMaxMs);
  }

  /**
   * 空闲第 n 档的刷新间隔：2.5s → 5s → 10s → 20s → 30s；超过最后一档后停在 30s。
   *
   * idleLevel 由调用方按「连续多少个成功且空闲的轮询周期」推进，绝不因为一次失败而前进或后退
   * （失败有自己的退避轴，两者正交）。
   */
  function panelIdleDelayMs(idleLevel) {
    const steps = PANEL_POLL_TIMINGS.idleStepsMs;
    const level = Number.isSafeInteger(idleLevel) && idleLevel > 0 ? idleLevel : 0;
    return steps[Math.min(level, steps.length - 1)];
  }

  /**
   * 下一轮轮询间隔（失败优先）：失败退避 > 运行态 2.5s > 空闲阶梯退避。
   *
   * @param {{failureCount?: number, running?: boolean, idleLevel?: number}} state
   * @returns {number} 毫秒
   */
  function panelNextPollDelayMs(state) {
    const source = object(state);
    const failureDelay = panelFailureDelayMs(source.failureCount);
    if (failureDelay > 0) return failureDelay;
    if (source.running !== false) return PANEL_POLL_TIMINGS.activeMs;
    return panelIdleDelayMs(source.idleLevel);
  }

  /**
   * 归一化 fanout-events 响应（票据 15；Host 契约见 index.js 的 fanout-events 分支）。
   *
   * 关键判据是 conclusive：只有 events 是数组时，这份响应才真的回答了「游标之后有没有新事件」。
   * 旧 Host 或测试替身可能对任何 action 都回同一份载荷（例如只给 snapshot），此时**绝不**把
   * 「读不到」当成「没有变化」——调用方必须退回全量快照，宁可多拉一次，也不让界面停在旧数据上。
   *
   * cursor 缺失/非法时保持 null（不伪造）：下一轮仍用当前游标重读，绝不假装已经同步过。
   */
  function readFanoutEventBatch(raw) {
    const source = object(raw);
    const events = Array.isArray(source.events) ? source.events : null;
    const cursor = Number.isSafeInteger(source.cursor) && source.cursor >= 0 ? source.cursor : null;
    const earliestSequence = Number.isSafeInteger(source.earliestSequence) && source.earliestSequence > 0
      ? source.earliestSequence
      : null;
    return {
      events,
      cursor,
      earliestSequence,
      gap: source.gap === true,
      dropped: Number.isSafeInteger(source.dropped) && source.dropped > 0 ? source.dropped : 0,
      conclusive: events !== null,
    };
  }

  /**
   * 游标是否过旧（读不到的事件已经永久缺失）。
   *
   * Host 的 gap 字段是权威答案；缺失该字段时按 Host 的同一公式自行判定：
   * 序号从 1 开始，所以只有「确实裁剪过队首」（earliest > 1）且 cursor 落在裁剪区间里才算缺口——
   * cursor=0 与 earliest=1 时前面本来就没有事件，绝不能误判成 gap 而每轮都全量重拉。
   */
  function fanoutBatchIsStale(batch, cursor) {
    if (batch === null || batch === undefined) return false;
    if (batch.gap === true) return true;
    if (batch.earliestSequence === null || batch.earliestSequence === undefined) return false;
    const after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    return batch.earliestSequence > 1 && after < batch.earliestSequence;
  }

  /**
   * 快照里是否还有运行中的任务（决定运行态 2.5s 还是空闲阶梯退避）。
   *
   * 复用模型的运行状态证据链（runtimeStatusOf：目录/Host running 布尔/协议 status），
   * 因此刷新节奏与界面上的圆点永不互相矛盾，插件也不自建第二套状态词表。
   *
   * 两个刻意保守的边界：
   * - partial（轻量快照）下证据不足时模型给出中性值 unknown，这里按「可能有活」处理，
   *   保持 2.5s——轻量快照只会持续一个刷新周期（见 pollOnce 对 partial 的强制全量），
   *   宁可多刷一轮，也不在状态未知时退到 30 秒；
   * - 遍历有界（最多 4096 个节点），坏数据或手工构造的超大树绝不可能把调度器卡死。
   */
  function snapshotHasRunningWork(snapshot) {
    if (snapshot === null || typeof snapshot !== "object") return false;
    if (snapshot.partial === true) return true;
    const model = modelApi();
    const runtimeStatusOf = typeof model.runtimeStatusOf === "function" ? model.runtimeStatusOf : null;
    if (runtimeStatusOf === null) return false;
    const pending = [snapshot.root];
    let visited = 0;
    while (pending.length > 0 && visited < 4096) {
      const node = pending.pop();
      visited += 1;
      if (node === null || typeof node !== "object") continue;
      let status;
      try { status = runtimeStatusOf(node, undefined, {}); } catch { status = "unknown"; }
      if (status === "running") return true;
      if (Array.isArray(node.children)) for (const child of node.children) pending.push(child);
      if (Array.isArray(node.shards)) for (const shard of node.shards) pending.push(shard);
    }
    return false;
  }

  /**
   * 当前面板所在 tab 的活跃度证据（票据 16）：true / false / null（未知）。
   *
   * 读面优先级固定：
   * 1. 注入的 deps.isTabActive()：install 侧或宿主可以给出的明确注入点，测试同样经此驱动；
   * 2. 宿主 tab 信息（props.useTabInfo()）里显式给出的 active / isActive 布尔；
   * 3. 都没有 ⇒ null（未知）：生产环境退回 document 可见性这一既有判据。
   *
   * 刻意**不**从 sidebarRight.active() 之类的旁证推断：那描述的是「某个 pane 的活跃 tab」，
   * 与「本面板所在 tab 是否活跃」不是同一件事，凭它暂停轮询会把正常的后台观察误停。
   */
  function readPanelTabActivity(deps, props, tabInfo) {
    const injected = deps?.isTabActive;
    if (typeof injected === "function") {
      try {
        const value = injected();
        if (value === true || value === false) return value;
      } catch { /* 注入读面抛错：按未知处理，退回文档可见性。 */ }
    }
    for (const candidate of [tabInfo, tabInfo?.tab]) {
      const source = object(candidate);
      if (source.active === true || source.active === false) return source.active;
      if (source.isActive === true || source.isActive === false) return source.isActive;
    }
    return null;
  }

  /**
   * 把一轮轮询结果记进调度器状态（票据 16）。
   *
   * 记账规则：
   * - 同一轮（id 相同）只记一次：多个 tick 观察到同一个在途轮次时绝不能把失败/空闲档加两次；
   * - 取消/旧代次（cancelled）不记失败，也不推进空闲档（那不是一次真实的刷新结论）；
   * - 成功 ⇒ 失败计数清零，并按「还有没有运行中的任务」推进或清零空闲档；
   * - 失败 ⇒ 失败计数 +1（封顶 16 档，足够超过 30 秒封顶），空闲档保持不变（正交）。
   */
  function applyPanelPollCycle(scheduler, cycle, latestSnapshot) {
    if (scheduler === null || scheduler === undefined) return;
    if (cycle === null || cycle === undefined || typeof cycle !== "object") return;
    const id = Number.isSafeInteger(cycle.id) ? cycle.id : null;
    if (id !== null) {
      if (id <= scheduler.lastCycleId) return;
      scheduler.lastCycleId = id;
    }
    if (cycle.cancelled === true) return;
    if (cycle.ok === true) {
      scheduler.failureCount = 0;
      const effective = cycle.snapshot === null || cycle.snapshot === undefined ? latestSnapshot : cycle.snapshot;
      if (snapshotHasRunningWork(effective)) {
        scheduler.running = true;
        scheduler.idleLevel = 0;
      } else {
        scheduler.running = false;
        scheduler.idleLevel = Math.min(
          scheduler.idleLevel + 1,
          PANEL_POLL_TIMINGS.idleStepsMs.length - 1,
        );
      }
    } else {
      scheduler.failureCount = Math.min(scheduler.failureCount + 1, 16);
    }
    scheduler.delay = panelNextPollDelayMs(scheduler);
  }

  /**
   * 面板标题栏错误槽的来源分类（票据 13：状态可读性）。
   *
   * 症状：快照轮询失败与用户动作（取消/重试分片、取消父任务）失败共用同一个标题栏错误面，
   * 该错误面固定渲染「快照读取失败」——于是一次动作失败会被读成「任务树坏了」，用户去点重试
   * 只会重新拉一次快照，动作失败的真实原因与后续动作都得不到提示。
   *
   * 三类来源的边界（渲染层只按来源选择固定文案，完整 message 始终只放在 title 属性里）：
   * - snapshot：快照请求失败（首屏、2.5 秒轮询、手动刷新都没拿到任务树）；
   * - action：用户动作失败（动作被 Host 结构化拒绝，或动作链路上非 RPC 层的失败）；
   * - rpc：动作内部的 RPC 传输/协议失败（adapter 抛错、响应体读不出来、协议标识非法）。
   *
   * 快照请求本身即使失败在传输层也归 snapshot：用户看到的事实是「任务树没读到」，
   * 传输细节属于 title。这条边界保证动作失败再也不会显示「快照读取失败」。
   */
  const PANEL_ERROR_SOURCES = Object.freeze({
    snapshot: "snapshot",
    action: "action",
    rpc: "rpc",
  });

  // 三类来源的固定短文案已迁到消息表（sidebar.error.*，见渲染层 errorLabelOf）；
  // 这里只保留来源枚举，title 属性仍然是受限的 message。

  /**
   * callRpc 传输/协议失败的分类标记。
   *
   * 用 Symbol 而不是可枚举字段：adapter 抛出的错误对象可能被宿主或别的插件共享，插件绝不
   * 在它上面留下可见字段。标记不改变 message/name/原型链，因此快照路径里
   * `error?.name === "AbortError"` 的取消判定与既有断言逐字不变。`Symbol.for` 保证同一进程内
   * 重新执行本模块（HMR / 双份加载）仍认得同一个标记。
   */
  const RPC_FAILURE_KIND = Symbol.for("dsh-expert-group/rpc-failure-kind");
  const RPC_FAILURE_TRANSPORT = "rpc";

  /**
   * 给传输/协议失败打标记并原样返回（不吞、不改写、不重新包装对象形态的错误）。
   *
   * - 任何对象形态的抛出值（Error / DOMException / 自定义错误对象）原样返回：message/name/stack
   *   逐字保留，AbortError 的取消判定与既有断言不变；
   * - adapter 抛出原始值（字符串 / 数字）时包一层 Error，message 与既有
   *   `error instanceof Error ? error.message : String(error)` 的结果逐字一致；
   * - 冻结或不可扩展的错误对象打不了标记：静默返回原错误，分类退回 action 语义
   *   （宁可少一个 rpc 文案，也绝不因为打标记失败而丢掉错误本身）。
   */
  function markRpcTransportFailure(error) {
    // 任何对象形态的抛出值（Error、DOMException、自定义错误对象）都原样返回：只包住字符串/数字等
    // 原始值。这样 `error.name`（取消判定）、`error.message`（title 文案）与既有断言都不变。
    const failure = error !== null && typeof error === "object"
      ? error
      : new Error(error === undefined || error === null ? "RPC 请求失败" : String(error));
    try {
      Object.defineProperty(failure, RPC_FAILURE_KIND, {
        value: RPC_FAILURE_TRANSPORT,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch { /* 冻结对象：保留原错误，分类按 action 处理。 */ }
    return failure;
  }

  /**
   * 读回 RPC 传输/协议失败标记；没有标记（= 不是 RPC 层失败）返回 null。
   *
   * 只认本模块写下的那个值：宿主或 adapter 自己碰巧挂了一个同名字段也不会被误判成传输失败。
   */
  function rpcFailureKindOf(error) {
    if (error === null || typeof error !== "object") return null;
    try {
      return error[RPC_FAILURE_KIND] === RPC_FAILURE_TRANSPORT ? RPC_FAILURE_TRANSPORT : null;
    } catch { return null; }
  }

  /**
   * Host 结构化拒绝（ok:false）对应的 Error。
   *
   * message 与既有行为逐字一致（测试与用户可见文案都依赖它）；额外把稳定 code/details
   * 挂成**不可枚举**属性：既有 deepEqual / 文案断言不受影响，而「会话模型」等需要按
   * 稳定 code 分支的入口可以读取它。details 只由消费方按白名单读取，绝不整段渲染。
   */
  function rpcBusinessError(errorBlock) {
    const block = object(errorBlock);
    const error = new Error(text(block.message, "RPC 请求失败"));
    try {
      Object.defineProperty(error, "code", {
        value: text(block.code, null),
        configurable: true,
        enumerable: false,
        writable: false,
      });
      Object.defineProperty(error, "details", {
        value: block.details,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch { /* 冻结/不可扩展错误对象：保留 message 即可。 */ }
    return error;
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

  /**
   * 唯一的 RPC 调用入口。
   *
   * 失败分类（票据 13）：**传输/协议**层失败（没有 adapter、协议标识非法、adapter 抛错或
   * Promise reject、响应体读不出来）会打上传输失败标记，动作路径据此把错误槽呈现为「请求失败」；
   * 而 Host 的结构化拒绝（`ok:false`）说明这次往返已经完成、只是 Host 对请求本身说不，
   * 因此不打标记，动作路径按「操作失败」呈现。快照路径不区分这两类——它一律呈现自身的
   * 「快照读取失败」，传输细节只留在 title 里。
   *
   * 所有既有语义逐字保留：错误 message 仍是 adapter / Host 给出的原文，AbortError 仍是同名错误
   * （快照路径的可取消判定不依赖 instanceof），成功 envelope 的三种形状照旧解包。
   *
   * 可选的 select 参数（票据 15）：默认解包仍返回「快照本体」。快照增量同步需要读到与快照**同级**
   * 的 cursor（若 Host 将来在响应顶层提供），而默认解包会把同级字段丢掉，因此这条路径传入 select
   * 拿到未收窄的 envelope。不传 select 时三种 envelope 形状的返回值逐字不变（既有调用方零影响）。
   */
  async function callRpc(deps, ctx, request, init = {}, select) {
    const fn = deps.requestPluginRpc;
    if (typeof fn !== "function") throw markRpcTransportFailure(new Error("当前 DSH 未提供插件 RPC"));
    let protocol;
    try {
      protocol = rpcAdapterProtocolOf(deps);
    } catch (error) {
      // 协议标识非法 = 请求根本没进入传输层，属于协议层失败。
      throw markRpcTransportFailure(error);
    }
    let response;
    try {
      response = await fn(...rpcAdapterArguments(protocol, ctx, request, init));
    } catch (error) {
      // adapter 同步抛错 / Promise reject / 取消：全都是传输层失败（标记不改 name，取消判定照旧）。
      throw markRpcTransportFailure(error);
    }
    if (response?.ok === false) throw rpcBusinessError(response.error);
    if (typeof response?.json === "function") {
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        // 响应回来了但读不出协议体：同样属于协议层失败。
        throw markRpcTransportFailure(error);
      }
      if (payload?.ok === false) throw rpcBusinessError(payload.error);
      const body = payload?.value ?? payload;
      return typeof select === "function" ? select(body) : (body?.snapshot ?? body);
    }
    if (response?.value !== undefined) {
      if (typeof select === "function") return select(response.value);
      return response.value?.snapshot ?? response.value;
    }
    return typeof select === "function" ? select(response) : (response?.snapshot ?? response);
  }


  // 只暴露兄弟模块与主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    PANEL_ERROR_SOURCES, PANEL_POLL_TIMINGS, RPC_FAILURE_TRANSPORT, applyPanelPollCycle,
    callRpc, fanoutBatchIsStale, panelNextPollDelayMs,
    readFanoutEventBatch, readPanelTabActivity, rpcFailureKindOf, samePanelSnapshot,
    // 运行态判定同时服务轮询节奏与「无 fanout 事件时仍刷新快照」：同一口径只有一个来源。
    snapshotHasRunningWork,
  });
})(globalThis);
