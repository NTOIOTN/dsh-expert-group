/**
 * 会话删除的交互层（票据 06/07/09）：状态、异步编排、五个插槽注册与两个文档级守卫。
 *
 * ## 分层
 * - **状态**：一个极小的 store（getSnapshot / subscribe / 单一 dispatch）。React 组件用
 *   useSyncExternalStore 订阅它，因此「操作条的数字」与「行首勾选框」永远来自同一份快照。
 * - **纯转移**：模式开关、勾选、全选、结算后重置、Escape 优先级全部来自
 *   client-session-delete-selection.js（票据 05）；本模块只做「读端口 → 纯转移 → 再读端口」
 *   的编排，不重建第二条真相。
 * - **渲染**：全部在 client-session-delete-view.js（纯渲染）；本模块只把状态投影成视图数据。
 * - **插槽**：行尾按钮（order 300）、会话菜单两行（460/470）、行首勾选框、shell.overlay
 *   操作条。全部走宿主公开插槽注册，绝不注入改写宿主 DOM。
 *
 * ## 两个文档级守卫（只在需要时存在）
 * - 点击捕获：多选模式期间整行点击切换勾选，并阻止宿主行打开会话。用**窄目标**识别会话行
 *   （data-row-key="session:<id>"），行内已有控件（勾选框、行尾按钮、菜单触发器）一律放行，
 *   工作区标题行与搜索框根本匹配不上。宿主 DOM 认不出来时整条守卫自动降级为「只有勾选框可点」。
 * - Escape：一律交给状态机的 escapeAction（弹窗打开时只关弹窗，否则退出多选）。
 *
 * ## 执行后不留常驻反馈（票据 09 口径）
 * 成功一律静默：多选全部成功就直接退出并刷新列表，单条成功什么都不弹。本模块**没有**任何
 * 常驻通知条 / 结算条 / 结果卡的渲染路径。只有「有目标没删掉」（failed / skipped / raced）
 * 或「请求本身失败」时，才挂一个**一次性结果弹窗**（与确认框同一套骨架、焦点在关闭按钮、
 * Esc/遮罩可关、看过即关），既没有重试按钮也不会留在界面上。多选无论成功还是部分失败都
 * 退出多选——失败已经用那个弹窗说清楚了。
 *
 * ## 结算后的收敛（票据 08）
 * 结算一落地就做两件事：调公开的 `ctx.sessions.refresh()` 让行立刻消失，再清掉 `deleted` /
 * `absent` 目标留下的本地键（展开态 + 归属账本）。实现全在
 * `client-session-delete-local-keys.js`；本模块只负责「什么时候调」，并且**永不**因为刷新或
 * 清理失败改写结算结果（失败只进诊断返回值）。启动安装时还会补扫一次别的标签页留下的待清
 * 理标记（纯本地读，无网络）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-session-delete-ui")]。
 */
(function installSessionDeleteUiModule(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-session-delete-ui");
  const SELECTION = global[Symbol.for("dsh-expert-group/client-session-delete-selection")] ?? {};
  const VIEW = global[Symbol.for("dsh-expert-group/client-session-delete-view")] ?? {};
  const POLL = global[Symbol.for("dsh-expert-group/client-sidebar-poll")] ?? {};
  const LOCAL_KEYS = global[Symbol.for("dsh-expert-group/client-session-delete-local-keys")] ?? {};
  const {
    escapeAction, exitSelection, initialSelectionState, isSelectionOpen, isSessionActionable,
    isSessionSelected, markSettling, openSelection,
    requestDeleteAll, requestDeleteCandidates, selectionCandidateOf, selectionCounts,
    selectionTargets, submitSelection, toggleSelectAllActionable, toggleSelection,
    UNGROUPED_SCOPE,
  } = SELECTION;

  /** 空回调：插槽 owner props 缺失时的默认值（不新建箭头、不产生额外闭包）。 */
  const NOOP = function noop() {};

  /** 会话行的宿主标识前缀（宿主 Rows 的 data-row-key="session:<id>"）。 */
  const ROW_KEY_PREFIX = "session:";

  /** 停靠条与侧栏 footer 之间的间距（px）。 */
  const DOCK_GAP = 8;

  /** 多选期间挂在 body 上的标记类：样式表用它给侧栏列表容器预留操作条高度的底部留白。 */
  const RESERVE_CLASS = "deg_sd_selecting";

  /** 真机定位用的 RPC 失败诊断键（渲染进程 localStorage → leveldb，可由根代理读取）。 */
  const RPC_DIAGNOSTIC_KEY = "dsh-expert-group:session-delete:last-rpc-error";

  /** 诊断里的 message 上限：避免把超长错误页/堆栈写进 localStorage。 */
  const RPC_DIAGNOSTIC_MESSAGE_LIMIT = 300;

  /** 行内「已有控件」白名单：命中即放行（它们自己处理点击，且不应切换勾选）。 */
  const CONTROL_SELECTOR = 'button,a,input,select,textarea,[role="menuitem"],[role="checkbox"],[contenteditable="true"]';

  /** 非空字符串归一：会话/工作区 ID 都是不透明字符串，不 trim、不猜大小写。 */
  function readId(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  /**
   * 宿主工作区快照 → 会话所属的**范围 key**（三态，绝不猜）：
   *
   * - `""`：范围未就绪。选择器缺失、`items` 不是数组、会话 ID 为空、**任一条目形状破损**
   *   （不是对象，或 `sessionIds` 不是数组），或命中了某个工作区却给不出合法 workspaceId，
   *   都属于这一类——入口保持禁用、多选入口不渲染（fail-closed：宁可让用户点不了，也不拿
   *   一个猜出来的范围去查候选）。破损快照**绝不**被当成「确实未分组」：只要有一行证明不了
   *   「它不属于任何工作区」，整份快照就不可信；
   * - `UNGROUPED_SCOPE`：`items` 是数组，但没有任何工作区包含该会话 → 未分组范围。宿主
   *   原生「未分组」分组里的会话本来就不在任何 sessionIds 里，它们只能走这个范围；
   * - 其他非空字符串：该会话所属工作区的 ID。
   *
   * `items` 是**空数组是合法状态**（用户一个工作区都没有）：此时所有会话都是未分组，
   * 入口必须可用。客户端误判方向是安全的——服务端按真实 registry 复核授权，客户端只决定
   * 发哪个范围（`{ workspaceId }` 还是 `{ scope: "ungrouped" }`）。
   *
   * @param {Array|undefined} items - useWorkspaces 快照的 items。
   * @param {string} sessionId - 行上的会话 ID。
   * @returns {string} 范围 key，`""` 表示未就绪。
   */
  function scopeKeyOf(items, sessionId) {
    if (!Array.isArray(items) || readId(sessionId) === null) return "";
    for (const item of items) {
      // 条目形状破损（不是对象 / 是数组 / sessionIds 不是数组）：这一份快照里「谁属于哪个
      // 工作区」已经不可全信，继续往下扫只会用残缺事实推出「未分组」这个**肯定结论**。
      // 因此不走 continue，直接整份按未就绪处理（fail-closed，入口禁用的代价远小于误判）。
      // 注意 items 是空数组不进这个分支：用户没有工作区是合法状态，全部会话确实都是未分组。
      const sessionIds = Array.isArray(item) ? null : item?.sessionIds;
      if (!Array.isArray(sessionIds)) return "";
      if (sessionIds.includes(sessionId) !== true) continue;
      // 命中却给不出合法工作区 ID：同样是破损快照，按未就绪处理。
      return readId(item.workspaceId) ?? "";
    }
    return typeof UNGROUPED_SCOPE === "string" ? UNGROUPED_SCOPE : "";
  }

  /**
   * 结算后的收敛动作（票据 08）：一次公开列表刷新 + 已删目标的本地键清理。
   *
   * 组合模块自己已经把「刷新失败 / 清理失败」收敛成返回值，这里再兜一层 try/catch：
   * 界面永远不会因为本地清理或刷新失败而报错，更不会把一次已经落盘的删除显示成失败。
   */
  async function convergeSettlement(ctx, settlement) {
    const converge = LOCAL_KEYS.convergeAfterSettlement;
    if (typeof converge !== "function" || settlement === null || settlement === undefined) return;
    try {
      await converge(ctx, settlement);
    } catch {
      // 收敛只是「让界面和本地数据跟上」，失败留到下一次刷新/启动再补。
    }
  }

  /** 启动空闲清扫：安装期同步跑一次（纯本地读；失败不阻断界面安装）。 */
  function sweepStartupLocalKeys() {
    const sweep = LOCAL_KEYS.sweepPendingLocalKeys;
    if (typeof sweep !== "function") return;
    try {
      sweep();
    } catch {
      // 其它标签页留下的标记留给下一次刷新再清。
    }
  }

  /**
   * 解析宿主 Connection（**安装期解析一次**，候选与删除两个 action 共用）。
   *
   * 真实宿主的插件 ctx 上**没有** `.connection` 属性：Cordis 的服务只经 `ctx.get(name)`
   * 暴露，直接读属性会命中 traceable 代理的 inject 校验（或拿到 undefined）。两段式探测与
   * 本仓库其它桥接一致：
   * 1. 先读 `ctx.connection`（测试替身与把 connection 挂在 ctx 上的旧宿主）；
   * 2. 再 `ctx.get("connection")`（真实宿主；网关对未声明服务会在 get 上抛错，必须 try/catch）。
   *
   * 只解析一次的原因：一次安装里 Connection 不会变；两个 action 用同一份结果，避免「候选走
   * get、删除走属性」这种半残状态。
   *
   * @returns {object|undefined} Connection（含 `rpc.call`）或 undefined。
   */
  function resolveConnection(ctx) {
    try {
      if (ctx?.connection) return ctx.connection;
    } catch {
      // 代理拒答属性读取：继续走服务查找。
    }
    try {
      return typeof ctx?.get === "function" ? ctx.get("connection") : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Connection 缺失时的可读失败（**绝不落到 fetch 兜底**）。
   *
   * 没有 Connection 时共享 callRpc 会退回 `fetch("/api/…")`：那个端点在没有 Connection 的
   * 宿主上只会回 404，最终变成不可读的「RPC 请求失败」。这里提前拒绝并给出用户能看懂的原因，
   * 界面因此显示「读取可删除会话失败：当前 DSH 未提供 Connection」。
   */
  function missingConnectionError() {
    return new Error("当前 DSH 未提供 Connection");
  }

  /**
   * 把一次 RPC 失败写成可落盘的诊断（**只用于真机定位**）。
   *
   * 桌面版渲染进程的 localStorage 落在 leveldb 里，可由根代理直接读取；真机上客户端只拿到
   * 无消息的传输失败时，这条记录是唯一能说明「宿主到底抛了什么」的证据。三条硬约束：
   * 1. **只在失败时写**（成功路径一次都不写，避免每次点击都写盘）；
   * 2. 整个写入包在 try/catch 里：localStorage 可能不可用（隐私模式/超配额/未注入），
   *    任何异常都不得影响原有失败路径；
   * 3. 只写固定键、只保留必要字段，不写第二个键、不清理别人的键。
   *
   * @param {unknown} error - 原始失败值（可能是 Error，也可能是别的东西）。
   * @param {object} request - 发出的 RPC 请求体。
   * @param {boolean} connectionMissing - 本次失败是否因为解析不到 Connection。
   */
  function recordRpcFailure(error, request, connectionMissing) {
    try {
      const storage = global.localStorage;
      if (storage === null || storage === undefined || typeof storage.setItem !== "function") return;
      const message = typeof error?.message === "string"
        ? error.message
        : (error === undefined || error === null ? "" : String(error));
      const stack = typeof error?.stack === "string" ? error.stack.split("\n") : [];
      storage.setItem(RPC_DIAGNOSTIC_KEY, JSON.stringify({
        at: Date.now(),
        action: request?.action ?? null,
        connection: connectionMissing ? "missing" : "resolved",
        requestKeys: Object.keys(request !== null && typeof request === "object" ? request : {}),
        errorName: error?.name ?? null,
        errorCode: error?.code ?? null,
        errorMessage: message.slice(0, RPC_DIAGNOSTIC_MESSAGE_LIMIT),
        errorStack: stack.length === 0 ? null : stack.slice(0, 2).join("\n"),
      }));
    } catch {
      // 诊断只是尽力而为：任何异常都不得影响原始失败路径。
    }
  }

  /** 把插件 RPC 端口接成票据 05 期望的 { call }：唯一传输入口仍是 callRpc。 */
  function makePort(ctx, deps) {
    const requestPluginRpc = deps?.requestPluginRpc;
    const callRpc = POLL.callRpc;
    // 安装期解析一次：两个 action（候选 / 删除）共用同一个 connection。
    const connection = resolveConnection(ctx);
    const connectionMissing = connection === undefined || connection === null;
    return {
      call: async (request) => {
        try {
          if (typeof callRpc !== "function") throw new Error("当前 DSH 未提供插件 RPC");
          // 解析不到 Connection：直接给可读原因，绝不进入 fetch 兜底（那只会变成「RPC 请求失败」）。
          if (connectionMissing) throw missingConnectionError();
          // 共享 callRpc 只读 ctx.connection，因此把解析结果作为它的 ctx 位置传入；
          // 它的协议判定与既有语义一字未改。
          return await callRpc({ requestPluginRpc }, { connection }, request);
        } catch (error) {
          // 失败才写诊断（成功路径零写入）；写完**原样抛出**，错误对象与文案都不变。
          recordRpcFailure(error, request, connectionMissing);
          throw error;
        }
      },
    };
  }

  /**
   * 一次性结果弹窗的状态（票据 09 口径：执行后不留常驻反馈）。
   *
   * 只有两个字段：
   * - counts：本轮结算的五态计数（没有结算就为 null，例如请求在发出前就被拒）；
   * - message：一句话失败说明（已经翻译好的可展示文案），没有失败就是 null。
   *
   * 渲染层据此在同一个弹窗里先说「做完了什么、还剩谁」，再补一句失败原因；弹窗只有「关闭」
   * 一个按钮，关掉即结束，既没有重试按钮也不会留在界面上。
   */
  function outcomeDialogOf(counts, message) {
    return { kind: "outcome", counts: counts ?? null, message: message ?? null };
  }

  /** 「行仍保留」的目标数（failed / skipped / raced）：只有它大于 0 才需要打扰用户。 */
  function keptCountOf(counts) {
    if (counts === null || typeof counts !== "object") return 0;
    return (Number(counts.failed) || 0) + (Number(counts.skipped) || 0) + (Number(counts.raced) || 0);
  }

  /** 候选查询失败的一句话（入口级失败：连多选/确认框都还没开出来）。 */
  function candidatesFailureText(t, error) {
    return t("sidebar.sessionDelete.error.candidates", {
      message: error === null || error === undefined ? "" : error.message,
    });
  }

  /** 删除失败的一句话（端口给出的 message 已经是可展示文案，这里不拼路径与堆栈）。 */
  function deleteFailureText(t, error) {
    return t("sidebar.sessionDelete.error.delete", {
      message: error === null || error === undefined ? "" : error.message,
    });
  }

  /**
   * 把一轮删除的结果投影成「要不要打扰用户」：成功（含 absent）一律静默。
   *
   * 只有两种事实会弹一次性结果弹窗（票据 09 口径）：
   * 1. 有目标没被删掉（failed / skipped / raced）——用户必须知道谁还在；
   * 2. 请求本身失败（ok !== true）——哪怕前面的批次真的删掉了几个，也要给出原因。
   * 其余情况返回 null：界面什么都不渲染，列表刷新后行自然消失。
   *
   * @param {(key: string, vars?: object) => string} t - 文案函数。
   * @param {object} outcome - requestDeleteAll / submitSelection 的返回（ok / settlement / error）。
   * @returns {object|null} 弹窗状态或 null（静默）。
   */
  function outcomeDialogOfSettlement(t, outcome) {
    const failed = outcome?.ok !== true;
    const settlement = outcome?.settlement ?? null;
    const counts = settlement === null ? null : settlement.counts;
    if (failed !== true && keptCountOf(counts) === 0) return null;
    return outcomeDialogOf(counts, failed === true ? deleteFailureText(t, outcome?.error) : null);
  }

  /**
   * 会话删除的界面 store。
   *
   * state 的字段就是渲染需要的全部事实：
   * - selection：票据 05 的多选状态机（候选、选中集合、结算中、最近一次结算）；
   * - busy：一次在途的候选/删除请求（入口与操作条据此禁用，防重复点击）；
   * - dialog：确认框 / 不可删除说明 / 一次性结果弹窗（kind、targets 或计数与失败说明）；
   * - anchor：操作条的定位（贴侧栏列表底部停靠，见 anchorStyle）。
   *
   * 所有转移都走同一个 dispatch：多选与单条共用一条「读候选 → 冻结 → 提交」的路径，
   * 不存在第二套提交逻辑。
   */
  function makeDeleteUiStore(deps) {
    const port = deps.port;
    const t = deps.t;
    // 宿主上下文：只在结算后取公开的会话列表刷新口（ctx 本体不进组件，也不进渲染数据）。
    const ctx = deps.ctx;
    const listeners = new Set();
    let state = {
      selection: initialSelectionState(),
      busy: false,
      dialog: null,
      anchor: null,
    };

    /** 写入新快照并通知订阅者；单个订阅者抛错不得阻断其余订阅者与状态推进。 */
    function emit(next) {
      state = next;
      for (const listener of Array.from(listeners)) {
        try { listener(); } catch { /* 订阅者异常与状态推进无关 */ }
      }
    }

    function patch(next) {
      emit({ ...state, ...next });
    }

    function getSnapshot() {
      return state;
    }

    function subscribe(listener) {
      if (typeof listener !== "function") return NOOP;
      listeners.add(listener);
      return listeners.delete.bind(listeners, listener);
    }

    // 外移动作（open-single）只通过这一个窄句柄读写状态：端口、文案、快照与唯一的写入口。
    const handle = { port, t, get: getSnapshot, patch };

    /**
     * 唯一的状态入口。
     *
     * @param {string} action - 稳定动作名（见各分支；测试与渲染层都只用这些名字）。
     * @param {object} [payload] - 动作参数（toggle 需要 sessionId；open-* 需要 workspaceId，
     *   它是**范围 key**：工作区 ID 或 UNGROUPED_SCOPE，空串表示范围未就绪）。
     * @returns {Promise<unknown>|unknown} 有 I/O 的分支返回 Promise。
     */
    async function dispatch(action, payload) {
      if (action === "toggle") {
        const next = toggleSelection(state.selection, payload?.sessionId);
        if (next !== state.selection) patch({ selection: next });
        return;
      }
      if (action === "select-all") {
        // 开关语义：未全选 → 全选；已全选 → 清空（纯转移在状态机里，见 toggleSelectAllActionable）。
        const next = toggleSelectAllActionable(state.selection);
        if (next !== state.selection) patch({ selection: next });
        return;
      }
      if (action === "cancel") {
        // 请求在途时不收取消：此刻磁盘上可能已经变了，关掉弹窗只会掩盖真实结果。
        if (state.dialog !== null && state.dialog.phase !== "running") patch({ dialog: null });
        return;
      }
      if (action === "exit") {
        patch({ selection: exitSelection(), dialog: null });
        return;
      }
      if (action === "anchor") {
        const next = payload ?? null;
        if (next === null) return;
        const current = state.anchor;
        if (current !== null && current.left === next.left && current.bottom === next.bottom && current.width === next.width) return;
        patch({ anchor: next });
        return;
      }
      if (action === "open-single") {
        await openSingleAction(handle, payload);
        return;
      }
      if (action === "open-multi") {
        const scopeKey = readId(payload?.workspaceId);
        if (scopeKey === null) return;
        if (state.busy === true) return;
        patch({ busy: true });
        const opened = await openSelection(port, scopeKey, readId(payload?.sessionId));
        if (opened.ok !== true) {
          // 候选查询失败 → 不进入多选（决策 25）；失败本身用一次性弹窗说清（不留常驻提示）。
          patch({ busy: false, dialog: outcomeDialogOf(null, candidatesFailureText(t, opened.error)) });
          return;
        }
        patch({ busy: false, selection: opened.state });
        return;
      }
      if (action === "delete-selected") {
        await startBatchAction(handle);
        return;
      }
      if (action === "confirm") {
        const dialog = state.dialog;
        if (dialog === null || dialog.kind !== "confirm" || dialog.phase === "running") return;
        patch({ dialog: { ...dialog, phase: "running", error: null } });
        if (dialog.scope === "single") {
          // 单条删除不进入多选（决策 21）：一次请求，成功静默、失败给一个一次性弹窗。
          const outcome = await requestDeleteAll(port, {
            workspaceId: dialog.workspaceId,
            targets: [dialog.targets[0].sessionId],
          });
          patch({ dialog: outcomeDialogOfSettlement(t, outcome) });
          // 部分批次已经真的删掉了：结算为空的失败不动本地键，有结算的照常收敛。
          await convergeSettlement(ctx, outcome.settlement);
          return;
        }
        const settled = await submitSelection(port, markSettling(state.selection, true));
        // 新口径：无论成功还是部分失败都退出多选；失败由一次性弹窗告知，不留结算条。
        patch({ dialog: outcomeDialogOfSettlement(t, settled), selection: exitSelection() });
        await convergeSettlement(ctx, settled.settlement);
      }
    }

    return Object.freeze({ dispatch, getSnapshot, subscribe });
  }

  /**
   * 一轮批量删除：操作条上的「删除」只负责打开本轮确认框。
   *
   * 确认框的数量、absent 计数与标题一律取自**当前**选中集合的候选快照（进入多选时或每次
   * 结算后都会重拉），绝不拿另一份快照去二次提交。新口径下界面上没有「重试」按钮，因此
   * 这里只有一条路径；重来就是重新进多选、重新勾选。
   */
  async function startBatchAction(handle) {
    const state = handle.get();
    if (isSelectionOpen(state.selection) !== true || state.busy === true) return;
    const selection = state.selection;
    const targets = selectionTargets(selection);
    if (targets.length === 0) return;
    const counts = selectionCounts(selection);
    let absent = 0;
    for (const target of targets) if (target.absent === true) absent += 1;
    handle.patch({
      dialog: {
        kind: "confirm",
        scope: "batch",
        // 范围 key（工作区 ID 或 UNGROUPED_SCOPE）；批量提交走 selection 状态，这里只为确认框留档。
        workspaceId: selection.workspaceId,
        targets,
        absent,
        blocked: counts.blocked,
        phase: "idle",
        error: null,
      },
    });
  }

  /**
   * 单条删除的第一步：先取该会话的候选状态，再决定「确认框」还是「不可删除说明」。
   *
   * 为什么必须先查候选：被占用/待清理的目标不该弹一个注定被跳过的确认框（测试 A4）。
   * 候选查询失败一律 fail-closed：不弹确认框、不发删除请求，只用一个一次性弹窗说明原因。
   */
  async function openSingleAction(handle, payload) {
    // payload.workspaceId 是范围 key（工作区 ID 或 UNGROUPED_SCOPE）；请求体由状态机翻译。
    const scopeKey = readId(payload?.workspaceId);
    const sessionId = readId(payload?.sessionId);
    const state = handle.get();
    // 行身份或范围认不出来：静默失败（不猜范围、不发请求、不弹框）。
    if (scopeKey === null || sessionId === null) return;
    if (state.busy === true || isSelectionOpen(state.selection) === true) return;
    handle.patch({ busy: true });
    const loaded = await requestDeleteCandidates(handle.port, scopeKey);
    if (loaded.ok !== true) {
      // 候选读不到就不发删除请求（fail-closed），失败用一次性弹窗说清。
      handle.patch({ busy: false, dialog: outcomeDialogOf(null, candidatesFailureText(handle.t, loaded.error)) });
      return;
    }
    let candidate = null;
    for (const entry of Array.isArray(loaded.snapshot?.candidates) ? loaded.snapshot.candidates : []) {
      if (entry?.sessionId === sessionId) { candidate = entry; break; }
    }
    if (candidate === null || candidate.actionable !== true) {
      handle.patch({ busy: false, dialog: { kind: "blocked", blockedBy: candidate === null ? null : candidate.blockedBy } });
      return;
    }
    // 标题优先用侧栏那一行显示的名字：候选里的标题来自清单 header，可能与用户看到的行不同。
    const title = readId(payload?.title) ?? candidate.title;
    handle.patch({
      busy: false,
      // 弹窗里的 workspaceId 同样是范围 key：提交时由 requestDeleteAll 翻译成请求体。
      dialog: { kind: "confirm", scope: "single", workspaceId: scopeKey, targets: [{ ...candidate, title }], absent: 0, blocked: 0, phase: "idle", error: null },
    });
  }

  /** 多选模式下的整行点击：命中会话行 → 切换勾选并吞掉这次打开。 */
  function handleRowClickEvent(event, dispatch) {
    const target = event?.target;
    // 降级：宿主 DOM 认不出来时不做任何拦截，勾选框仍是唯一入口（绝不因此报错）。
    if (target === null || target === undefined || typeof target.closest !== "function") return;
    const row = target.closest('[data-row-key^="session:"]');
    if (row === null || row === undefined || typeof row.getAttribute !== "function") return;
    const control = target.closest(CONTROL_SELECTOR);
    if (control !== null && control !== undefined) return;
    const key = row.getAttribute("data-row-key");
    if (typeof key !== "string" || key.length <= ROW_KEY_PREFIX.length) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    void dispatch("toggle", { sessionId: key.slice(ROW_KEY_PREFIX.length) });
  }

  /** 文档级 Escape：优先级只有一个判定点（弹窗打开时只关弹窗，否则退出多选）。 */
  function handleDocumentKeyDown(event, ui) {
    if (event?.key !== "Escape") return;
    const state = ui.getSnapshot();
    const next = escapeAction(state.selection, { confirmOpen: state.dialog !== null });
    if (next === "none") return;
    event.preventDefault?.();
    event.stopPropagation?.();
    void ui.dispatch(next === "close-confirm" ? "cancel" : "exit");
  }

  /**
   * 操作条的落点：落进「预留留白」里，不覆盖任何宿主内容。
   *
   * ## 零覆盖是怎么做到的
   * 进入多选时 body 上会挂 RESERVE_CLASS，样式表据此给侧栏列表容器
   * （宿主 SidebarRoot 的 regionArea）加一段等于操作条高度的 padding-bottom。列表因此被
   * 顶上去，留白条就位于「列表底边」与「footer（头像/设置）」之间——操作条停在这段留白里，
   * 与会话行、分组标题、工作区标题、搜索框、footer 全部零交集。
   *
   * 锚点取 regionArea 自身的底边（= footer 顶边），再往上收 DOCK_GAP：条子的下沿始终在
   * 留白条内、footer 之上。操作条只有一行，预留高度恒为 48px（票据 09 删掉了结算条专用
   * 的加高预留，那条 CSS 钩子与渲染路径一起消失）。
   *
   * 测量链逐级降级，任何一级缺失都不抛错：
   * 1. 会话行 → [role=tree] → 最近的 regionArea（列表容器）；
   * 2. 找不到 regionArea（宿主类名变化）→ 退回列表矩形底边（旧的底部停靠，仍不碰顶部内容）；
   * 3. 测不到列表（侧栏折叠成 rail / 窄屏未展开）→ 左下角固定兜底位。
   * 水平方向永远取列表矩形的 left/width，因此不会越到对话区或底部输入框上。
   */
  function anchorStyle() {
    let anchor = null;
    try {
      const doc = globalThis.document;
      const row = typeof doc?.querySelector === "function" ? doc.querySelector('[data-row-key^="session:"]') : null;
      const tree = typeof row?.closest === "function" ? row.closest('[role="tree"]') : null;
      const rect = typeof tree?.getBoundingClientRect === "function" ? tree.getBoundingClientRect() : null;
      const width = Number(rect?.width);
      if (Number.isFinite(width) && width > 0) {
        // 列表容器的底边 = 预留留白的下沿 = footer 顶边。
        const region = typeof tree?.closest === "function" ? tree.closest('[class*="regionArea"]') : null;
        const regionRect = typeof region?.getBoundingClientRect === "function" ? region.getBoundingClientRect() : null;
        const regionBottom = Number(regionRect?.bottom);
        const dock = Number.isFinite(regionBottom) ? regionBottom : Number(rect?.bottom);
        if (Number.isFinite(dock)) {
          const viewportHeight = Number(globalThis.innerHeight);
          const base = Number.isFinite(viewportHeight) ? viewportHeight : dock;
          anchor = {
            left: Math.round(Number(rect.left)),
            bottom: Math.max(DOCK_GAP, Math.round(base - dock + DOCK_GAP)),
            width: Math.round(width),
          };
        }
      }
    } catch {
      anchor = null;
    }
    const box = anchor ?? { left: 8, bottom: DOCK_GAP + 4, width: 264 };
    return { position: "fixed", left: box.left + "px", bottom: box.bottom + "px", width: box.width + "px" };
  }

  /**
   * 预留留白：多选期间给 body 加标记类，退出/卸载时摘掉。
   *
   * 只动「插件自己的类名 + 插件样式表里的规则」：不新建 DOM、不改宿主结构，宿主类名变化时
   * 规则自然匹配不到（退化为旧的底部停靠），也不会残留任何状态。执行后没有任何常驻反馈，
   * 因此这里与弹窗无关：弹窗自带全屏遮罩，不需要（也不该）改动侧栏布局。
   */
  function useReserveClass(react, state) {
    const visible = isSelectionOpen(state.selection) === true;
    react.useEffect(() => {
      const list = globalThis.document?.body?.classList;
      if (typeof list?.add !== "function" || typeof list.remove !== "function") return undefined;
      if (visible === true) list.add(RESERVE_CLASS); else list.remove(RESERVE_CLASS);
      return () => { list.remove(RESERVE_CLASS); };
    }, [visible]);
  }


  /**
   * 弹窗视图：单条确认（标题=会话标题）、批量确认（数量 + 前 5 个标题 + 被占用数 +
   * 仅残留数）、「不可删除」说明与一次性结果。确认框必写「此操作不可恢复」；
   * 结果弹窗只说「做完了什么、还剩谁、为什么」，一条「关闭」按钮，看过即关。
   */
  function dialogViewOf(ui, state) {
    const dialog = state.dialog;
    if (dialog === null) return null;
    const t = ui.text;
    if (dialog.kind === "outcome") {
      const lines = [];
      // 没有结算（请求在发起前就被拒）时只有一句失败原因，不编造「已删除 0 个」。
      const sentence = VIEW.outcomeSentence(t, dialog.counts);
      if (sentence.length > 0) lines.push(sentence);
      if (typeof dialog.message === "string" && dialog.message.length > 0) lines.push(dialog.message);
      return {
        kind: "outcome",
        title: t("sidebar.sessionDelete.dialog.title"),
        lines,
        error: null,
        running: false,
      };
    }
    if (dialog.kind === "blocked") {
      return {
        kind: "blocked",
        title: t("sidebar.sessionDelete.blocked.title"),
        lines: [VIEW.blockedReasonText(t, dialog.blockedBy)],
        error: null,
        running: false,
      };
    }
    const targets = Array.isArray(dialog.targets) ? dialog.targets : [];
    const lines = [];
    if (dialog.scope === "single") {
      lines.push(t("sidebar.sessionDelete.dialog.single", { title: targets.length > 0 ? (targets[0].title ?? "") : "" }));
    } else {
      lines.push(t("sidebar.sessionDelete.dialog.batch", { count: targets.length }));
      if (dialog.absent > 0) lines.push(t("sidebar.sessionDelete.dialog.absent", { count: dialog.absent }));
      if (dialog.blocked > 0) lines.push(t("sidebar.sessionDelete.dialog.blocked", { count: dialog.blocked }));
      const first = [];
      for (let index = 0; index < targets.length && index < 5; index += 1) {
        first.push(targets[index].title ?? targets[index].sessionId);
      }
      lines.push(t("sidebar.sessionDelete.dialog.first", { count: first.length, titles: first.join(", ") }));
    }
    lines.push(t("sidebar.sessionDelete.dialog.irreversible"));
    return {
      kind: "confirm",
      title: t("sidebar.sessionDelete.dialog.title"),
      lines,
      error: dialog.error,
      running: dialog.phase === "running",
    };
  }

  /**
   * 行 → 范围 key（工作区 ID / UNGROUPED_SCOPE / "" 未就绪）。
   *
   * 唯一来源是宿主工作区 UI 提供的 root scope 标准席位 useWorkspaces（选择器 Hook）。三态
   * 判定全在 scopeKeyOf 里：读不到选择器、快照没有 items、或快照形状破损时返回空串，入口据此
   * 禁用（fail-closed），绝不猜一个范围去查候选；快照正常但会话不在任何工作区里 → 未分组，
   * 入口照常可用（此前这里返回空串，导致未分组会话的三个删除入口全部失效）。
   */
  function useSessionScope(props, sessionId) {
    const selector = props?.useWorkspaces;
    if (typeof selector !== "function") return "";
    const value = selector((snapshot) => scopeKeyOf(snapshot?.items, sessionId));
    return typeof value === "string" ? value : "";
  }

  /**
   * 文档级守卫的安装/注销（随模式进出）。
   *
   * 注册条件与钩子纪律：hook 无条件调用、effect 依赖只看「是否多选 / 是否有弹窗」，因此
   * 每次模式切换都恰好注册一次、退出时清理一次，不会在宿主 document 上留下永久监听。
   * 宿主没有 document.addEventListener 时整条守卫不安装（点行不拦截、勾选框仍可用）。
   */
  function useDocumentWiring(react, props, state) {
    const open = isSelectionOpen(state.selection);
    // 弹窗打开时也要装守卫：Escape 的优先级由状态机判定（弹窗打开时只关弹窗）。
    const visible = open === true || state.dialog !== null;
    react.useEffect(() => {
      const doc = globalThis.document;
      if (visible !== true || typeof doc?.addEventListener !== "function") return undefined;
      const ui = props.ui;
      const sync = () => { void ui.dispatch("anchor", anchorStyle()); };
      const onClick = (event) => { if (open === true) handleRowClickEvent(event, ui.dispatch); };
      const onKeyDown = (event) => handleDocumentKeyDown(event, ui);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("keydown", onKeyDown, true);
      sync();
      const view = globalThis.window;
      if (typeof view?.addEventListener === "function") view.addEventListener("resize", sync);
      return () => {
        try { doc.removeEventListener("click", onClick, true); } catch { /* 摘不掉就放弃这条监听 */ }
        try { doc.removeEventListener("keydown", onKeyDown, true); } catch { /* 同上 */ }
        if (typeof view?.removeEventListener === "function") {
          try { view.removeEventListener("resize", sync); } catch { /* 同上 */ }
        }
      };
    }, [open, visible]);
  }

  // ── 五个插槽组件（全部是纯投影：状态来自 store，渲染来自 view 模块）─────────────────

  /** 行尾悬停按钮：空会话（无标题）不渲染；范围未就绪或多选进行中时禁用（未分组同样可删）。 */
  function SessionDeleteRowAction(props) {
    const react = props.react;
    const state = react.useSyncExternalStore(props.ui.subscribe, props.ui.getSnapshot);
    const scopeKey = useSessionScope(props, props.sessionId);
    const title = typeof props.displayTitle === "string" ? props.displayTitle.trim() : "";
    if (title === "") return null;
    // 只有「范围未就绪」才禁用：未分组范围（UNGROUPED_SCOPE）同样是合法可删范围。
    const locked = scopeKey === "" || state.busy === true;
    return VIEW.renderRowActionButton(react.createElement, props.primitives, props.ui.text, {
      title,
      disabled: locked,
      onClick: props.ui.dispatch.bind(null, "open-single", { workspaceId: scopeKey, sessionId: props.sessionId, title }),
    });
  }

  /** 会话菜单末行（单条删除，危险色）：执行前先关菜单，避免弹窗被菜单挡住。 */
  function SessionDeleteMenuDelete(props) {
    const react = props.react;
    const state = react.useSyncExternalStore(props.ui.subscribe, props.ui.getSnapshot);
    const scopeKey = useSessionScope(props, props.sessionId);
    const menu = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
    const closeMenu = typeof menu?.[1] === "function" ? menu[1] : NOOP;
    const title = typeof props.displayTitle === "string" ? props.displayTitle.trim() : "";
    if (title === "") return null;
    const locked = scopeKey === "" || state.busy === true;
    const run = props.ui.dispatch.bind(null, "open-single", { workspaceId: scopeKey, sessionId: props.sessionId, title });
    return VIEW.renderMenuItem(react.createElement, props.primitives, props.ui.text, {
      label: props.ui.text("sidebar.sessionDelete.menu"),
      danger: true,
      attribute: "data-deg-session-delete-menu",
      disabled: locked,
      onSelect: () => { closeMenu(false); void run(); },
    });
  }

  /**
   * 会话菜单的多选入口：以该行所属**范围**（工作区或未分组）为多选范围，可处理时预选该行
   * （决策 27）。只有范围未就绪时才不渲染——未分组会话同样有多选删除。
   */
  function SessionDeleteMenuMulti(props) {
    const react = props.react;
    const state = react.useSyncExternalStore(props.ui.subscribe, props.ui.getSnapshot);
    const scopeKey = useSessionScope(props, props.sessionId);
    const menu = typeof props.useMenuOpenState === "function" ? props.useMenuOpenState() : null;
    const closeMenu = typeof menu?.[1] === "function" ? menu[1] : NOOP;
    if (scopeKey === "") return null;
    const locked = state.busy === true || isSelectionOpen(state.selection) === true;
    const run = props.ui.dispatch.bind(null, "open-multi", { workspaceId: scopeKey, sessionId: props.sessionId });
    return VIEW.renderMenuItem(react.createElement, props.primitives, props.ui.text, {
      label: props.ui.text("sidebar.sessionDelete.multi"),
      // 与「删除会话」同格式（危险色 + 同款垃圾桶图标）：用户明确要求入口外观一致。
      danger: true,
      attribute: "data-deg-session-delete-multi",
      disabled: locked,
      onSelect: () => { closeMenu(false); void run(); },
    });
  }

  /** 行首勾选框：只对「多选中 + 可处理」的目标渲染（宿主只在非归档空行的行首挂载本席位）。 */
  function SessionDeleteLeadingCheck(props) {
    const react = props.react;
    const state = react.useSyncExternalStore(props.ui.subscribe, props.ui.getSnapshot);
    if (isSelectionOpen(state.selection) !== true) return null;
    if (isSessionActionable(state.selection, props.sessionId) !== true) return null;
    const candidate = selectionCandidateOf?.(state.selection, props.sessionId) ?? null;
    return VIEW.renderLeadingCheckbox(react.createElement, props.ui.text, {
      title: candidate === null ? null : candidate.title,
      checked: isSessionSelected(state.selection, props.sessionId) === true,
      disabled: state.busy === true || state.selection.settling === true,
      onToggle: props.ui.dispatch.bind(null, "toggle", { sessionId: props.sessionId }),
    });
  }

  /**
   * 侧栏顶部浮层：多选时是操作条，否则什么都不渲染；最上面叠弹窗。
   *
   * 只渲染一个 Fragment：操作条与弹窗各自负责自己的定位与层级（弹窗自带全屏遮罩）。
   * 执行后没有任何常驻节点：成功与失败都不会在这里留下卡片或条子（票据 09 口径）。
   */
  function SessionDeleteOverlay(props) {
    const react = props.react;
    const ui = props.ui;
    const state = react.useSyncExternalStore(ui.subscribe, ui.getSnapshot);
    const dialogRef = react.useRef(null);
    useDocumentWiring(react, props, state);
    useReserveClass(react, state);
    const t = ui.text;
    const bar = isSelectionOpen(state.selection) === true
      ? VIEW.renderBar(react.createElement, props.primitives, t, {
        counts: selectionCounts(state.selection),
        busy: state.busy === true || state.selection.settling === true,
        style: state.anchor ?? undefined,
        onSelectAll: ui.dispatch.bind(null, "select-all"),
        onDelete: ui.dispatch.bind(null, "delete-selected"),
        onExit: ui.dispatch.bind(null, "exit"),
      })
      : null;
    return react.createElement(react.Fragment, null,
      bar,
      VIEW.renderDialog(react.createElement, t, dialogViewOf(ui, state), {
        dialogRef,
        onCancel: ui.dispatch.bind(null, "cancel"),
        onConfirm: ui.dispatch.bind(null, "confirm"),
      }));
  }

  /**
   * 装配入口：建立 store 与端口，并把五个组件注册到宿主公开插槽。
   *
   * 顺序（order）是行为契约的一部分：行尾按钮 300（归档 100 / 置顶 200 之后）、会话菜单
   * 460（置顶 100 / 重命名 200 / 分叉 300 / 归档 400 / 会话 ID 450 之后）、多选入口 470。
   * 宿主缺少插槽注册面时整段降级为 no-op，绝不让客户端入口失败。
   */
  function installSessionDeleteUi(ctx, deps) {
    // 启动空闲清扫（票据 08）：别的标签页留下的待清理标记在这里补清一次。
    sweepStartupLocalKeys();
    const slots = ctx?.slots;
    const react = deps?.react;
    if (slots === null || slots === undefined || typeof slots.inject !== "function" || typeof slots.register !== "function") return NOOP;
    if (react === null || react === undefined || typeof react.createElement !== "function") return NOOP;
    const t = VIEW.deleteTranslator(ctx);
    const ui = Object.freeze({ ...makeDeleteUiStore({ port: makePort(ctx, deps), t, ctx }), text: t });
    const primitives = deps?.primitives ?? {};
    // 注入面只放「共享句柄 + 运行期依赖」：组件不认识 ctx，也不各自建 store。
    const injected = () => ({ ui, react, primitives });
    slots.inject("sidebar.workspaces.session.row.action", () => slots.register({
      name: "sidebar.workspaces.session.row.action",
      id: "dsh-expert-group-session-delete",
      order: 300,
      inject: injected,
    }, SessionDeleteRowAction));
    slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
      name: "sidebar.workspaces.session.menu.item",
      id: "dsh-expert-group-session-delete",
      order: 460,
      inject: injected,
    }, SessionDeleteMenuDelete));
    slots.inject("sidebar.workspaces.session.menu.item", () => slots.register({
      name: "sidebar.workspaces.session.menu.item",
      id: "dsh-expert-group-session-delete-multi",
      order: 470,
      inject: injected,
    }, SessionDeleteMenuMulti));
    slots.inject("sidebar.session.row.leading", () => slots.register({
      name: "sidebar.session.row.leading",
      id: "dsh-expert-group-session-delete",
      inject: injected,
    }, SessionDeleteLeadingCheck));
    slots.inject("shell.overlay", () => slots.register({
      name: "shell.overlay",
      id: "dsh-expert-group-session-delete",
      order: 10,
      inject: injected,
    }, SessionDeleteOverlay));
    return NOOP;
  }

  global[SYMBOL] = Object.freeze({
    ROW_KEY_PREFIX,
    RESERVE_CLASS,
    anchorStyle,
    convergeSettlement,
    sweepStartupLocalKeys,
    handleDocumentKeyDown,
    handleRowClickEvent,
    installSessionDeleteUi,
    makeDeleteUiStore,
    SessionDeleteLeadingCheck,
    SessionDeleteMenuDelete,
    SessionDeleteMenuMulti,
    SessionDeleteOverlay,
    SessionDeleteRowAction,
    scopeKeyOf,
  });
})(globalThis);
