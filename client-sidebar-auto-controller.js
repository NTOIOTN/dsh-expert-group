/**
 * 客户端侧栏 · Panel 自动打开 / 预算 / 关闭租约（R6 票据 24 / sidebar-auto-controller）
 *
 * ## 职责边界
 * 本模块是 Auto（自动打开运行中的子代理侧栏）与「按精确 tabId 关闭」的**唯一判定与写入面**：
 * 1. 候选选择：该关的（origin 里已不在 running 集合）与该开的（running、未打开、未被抑制）；
 * 2. 预算：自动关闭的有界重试、失败冷却、owner 令牌、连续缺失采样（转移函数本身在 tab-state）；
 * 3. 关闭租约：同一 tabId 的在途关闭身份、结算信号、迟到隔离窗与 preflight 证据判定；
 * 4. 记账收口：verified-closed / inventory-absent / tab-recycled 三条收口路径的容器写入；
 * 5. 清理：离开快照的复合键、过期打开占位、资源明确空闲后的 manual 抑制清除。
 *
 * ## 状态所有权（规格书 §状态所有权(3)）
 * - **容器身份**不在这里创建：实例级 Map/Set 由 Panel 的 ref 持有，realm 级共享账本由
 *   client-sidebar-auto-ledger.js 创建。本模块只通过注入的 scope 读写**同一批容器**，
 *   绝不 new 长期容器，也不缓存跨帧结论。
 * - Panel 每次调用都把**本帧**的 scope 传进来（sessionId / rootSessionId / ref / 窄命令），
 *   因此「旧闭包只认旧 surface」的既有语义逐字保留：本模块绝不把某一帧的值留到下一帧。
 *
 * ## 关键语义（逐条保留，不得放宽）
 * - fail-closed：读不到 inventory 既不证明存在也不证明不存在；能力缺失（close / 落地证据 /
 *   左箭头）时绝不自动打开；
 * - 关闭必须是「精确 tabId + 地址证据」：recycled 与 closed 的证明力不同，租约归还原因必须分型；
 * - 预算与 owner 令牌同生共死；限容淘汰绝不淘汰仍可能被精确关闭的 key；
 * - 占位（tabId 为空）不是归属证据，过期回收只维护插件自己的记账，绝不触碰宿主。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-auto-controller")]
 * 装配：真实依赖边为 pure / dom / auto-ledger / tab-state → 本模块 → 主 sidebar（见
 * scripts/client-source-manifest.mjs）。本文件不注册任何 Hook。
 */
(function installSidebarAutoController(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-controller");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS, SIDEBAR_AUTO_KEY_LIMIT, SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS,
    SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS, SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS, SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS,
    SIDEBAR_TAB_CLOSE_WATCHDOG_MS, SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS, SIDEBAR_TAB_ORIGIN_AUTO,
    closeSettleReason, object, text,
  } = PURE;
  const DOM_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-dom");
  const DOM = global[DOM_SYMBOL] || {};
  const {
    SUBAGENT_CHAT_KIND, sidebarTabCloseKey, sidebarTabKey,
  } = DOM;
  const LEDGER_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
  const LEDGER = global[LEDGER_SYMBOL] || {};
  const {
    SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL, deleteSidebarAutoOwnership, readSidebarAutoOwnershipEntry,
    recordSidebarAutoDecision, recordSidebarAutoDiag, sidebarAutoKeyDigest,
    sidebarAutoOriginTabIdOf, sidebarAutoOriginWrittenAtOf, sidebarOwnershipAcceptsNewAuto,
    writeSidebarAutoOwnership,
  } = LEDGER;

  /* ----------------------------------------------------------------------------------------------- *
   * 本文件按「真实调用链」分成四层工厂，每层只依赖下一层：
   *   租约执行面 → 记账清理 → 关闭验证链 → 候选选择 → createSidebarAutoController（组合根）
   * 组合根把四层摊平成主 IIFE 期望的单一对象，因此 Panel 侧的调用点一个都不用改。
   * ----------------------------------------------------------------------------------------------- */

  /** 关闭租约 / 在场证据 / close 请求（本模块的底层执行面）。 */
  function createSidebarTabClosePort(scope) {
    const {
      closeSidebarResource, readSidebarOpenTabs, rootSessionId,
      sharedSidebarTabCloseInFlight, sidebarRight, sidebarSessionId,
    } = scope;
    function sidebarTabCloseKeyOf(tabId) {
      return sidebarTabCloseKey(sidebarSessionId, rootSessionId, tabId);
    }
    function sidebarTabCloseLeaseOf(tabId) {
      return sharedSidebarTabCloseInFlight.get(sidebarTabCloseKeyOf(tabId)) ?? null;
    }
    function sidebarTabCloseInFlight(tabId) {
      return sidebarTabCloseLeaseOf(tabId) !== null;
    }
    function acquireSidebarTabClose(tabId) {
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
    }
    function sidebarTabPresenceInInventory(tabId, expectedAddress = null) {
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
    }
    function requestSidebarTabClose(tabId) {
      return new Promise((resolve) => {
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
    }
    function waitForSidebarCloseLease(leaseToken, timeoutMs) {
      return new Promise((resolve) => {
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
    }
    return Object.freeze({
      sidebarTabCloseKeyOf, sidebarTabCloseLeaseOf, sidebarTabCloseInFlight, acquireSidebarTabClose, sidebarTabPresenceInInventory, requestSidebarTabClose, waitForSidebarCloseLease,
    });
  }

  /** Auto 记账清理（活动判定 / 容量 / 快照清理 / 占位回收 / manual 抑制）。 */
  function createSidebarAutoBookkeeping(scope) {
    const {
      clearAutoCloseBudget, rootSessionId, sidebarAutoCloseCooldownsRef,
      sidebarAutoCloseVerificationsRef, sidebarAutoOriginRef, sidebarAutoReservationRef,
      sidebarAutoSuppressedRef, sidebarResourceTabStateOf, sidebarSessionId,
      sidebarTabOpeningRef, sidebarTabPendingRef, sidebarTabRecordsRef,
    } = scope;
    function sidebarAutoCloseKeyIsActive(key) {
      if (sidebarTabPendingRef.current.has(key) === true) return true;
      if (sidebarTabOpeningRef.current.has(key) === true) return true;
      if (sidebarAutoReservationRef.current.has(key) === true) return true;
      if (sidebarAutoCloseVerificationsRef.current.has(key) === true) return true;
      if (sidebarAutoCloseCooldownsRef.current.has(key) === true) return true;
      const record = sidebarTabRecordsRef.current.get(key);
      return record !== undefined
        && record.sessionId === sidebarSessionId
        && record.rootSessionId === rootSessionId;
    }
    function autoSidebarOwnershipHasCapacity(key, address) {
      const origin = sidebarAutoOriginRef.current;
      /**
       * 容量按 **scope** 计账，不再用 origin.size（跨 scope 合计）。
       *
       * origin 是 realm 级共享 Map（多个面板实例 / 多个会话共用），旧实现拿合计值判定：别的会话
       * 占满 128 条时，当前会话会被永久拒绝——与持久层已经修掉的跨会话死锁是同一类缺陷。
       * 这里只数 (sessionId, rootSessionId) 逐字相等的条目，并排除 key 自己那一格（覆盖写不占
       * 新增额度）。绝不为了腾位淘汰任何 origin 条目：仍有效的 owner 被删掉就是永久漏收。
       */
      let scopedCount = 0;
      for (const [entryKey, entry] of origin) {
        if (entryKey === key) continue;
        if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
        scopedCount += 1;
      }
      if (scopedCount >= SIDEBAR_AUTO_KEY_LIMIT) return false;
      return sidebarOwnershipAcceptsNewAuto(sidebarSessionId, rootSessionId, address);
    }
    function cleanupAutoSidebarKeys(known, actingKey) {
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
    }
    function sweepAutoOpenPlaceholders(running) {
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
    }
    function clearManualSuppressionOfIdleResources(idle) {
      if (idle === null || idle === undefined || idle.size === 0) return;
      for (const address of idle) {
        const key = sidebarTabKey(sidebarSessionId, rootSessionId, address);
        if (sidebarAutoSuppressedRef.current.has(key) === true) sidebarAutoSuppressedRef.current.delete(key);
        const persisted = readSidebarAutoOwnershipEntry(sidebarSessionId, rootSessionId, address, { quiet: true });
        if (persisted === null || persisted.origin !== SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL) continue;
        deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, address, "resource-idle", { manual: true });
      }
    }
    return Object.freeze({
      sidebarAutoCloseKeyIsActive, autoSidebarOwnershipHasCapacity, cleanupAutoSidebarKeys, sweepAutoOpenPlaceholders, clearManualSuppressionOfIdleResources,
    });
  }

  /** 关闭验证链与唯一执行入口（preflight / 租约结算 / 有限重试）。 */
  function createSidebarCloseVerification(scope, tabClosePort) {
    const {
      bump, cancelPendingSidebarSplitOfClose, clearAutoCloseAttempt,
      closeSidebarResource, rootSessionId, settleAutoCloseAttempt,
      sharedSidebarTabCloseInFlight, sidebarAutoCloseCooldownsRef, sidebarAutoCloseVerificationsRef,
      sidebarAutoFailedKeysRef, sidebarAutoOriginRef, sidebarAutoSuppressedRef,
      sidebarSessionId, sidebarSurfaceStillCurrent, sidebarTabRecordsRef,
      trimAutoKeyMap,
    } = scope;
    // 下层工厂的函数在本层以同名局部别名调用：函数体与拆分前逐字一致。
    const { acquireSidebarTabClose, requestSidebarTabClose, sidebarTabCloseLeaseOf, sidebarTabPresenceInInventory } = tabClosePort;
    const { waitForSidebarCloseLease } = tabClosePort;
    function beginSidebarCloseVerification(lease, tabId, verify) {
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
    }
    function finishVerifiedSidebarClose(key, entry, reason) {
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
    }
    function verifyPendingSidebarCloses() {
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
    }
    async function closeSidebarTabWithLease(tabId, options) {
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
      } else {
        beginSidebarCloseVerification(lease, tabId, verify);
      }
      return { status: "request-resolved-unverified", closed: false };
    }
    return Object.freeze({
      beginSidebarCloseVerification, finishVerifiedSidebarClose, verifyPendingSidebarCloses, closeSidebarTabWithLease,
    });
  }

  /** 候选选择（该关的 / 该开的）与能力降级判据。 */
  function createSidebarAutoCandidates(scope, tabClosePort, bookkeeping) {
    const {
      autoCloseCooldownActive, bump, clearAutoCloseAttempt,
      clearAutoCloseBudget, closeSidebarResource, enterAutoCloseCooldown,
      openSidebarResource, primitives, readActiveSidebarResource,
      releaseExpiredAutoCloseCooldown, rootSessionId, sampleAutoTabMisses,
      sidebarActiveResourceMatches, sidebarAutoCloseAttemptOwnersRef, sidebarAutoCloseAttemptsRef,
      sidebarAutoCloseCooldownsRef, sidebarAutoCloseVerificationsRef, sidebarAutoEpochRef,
      sidebarAutoFailedKeysRef, sidebarAutoOriginRef, sidebarAutoReservationRef,
      sidebarAutoSuppressedRef, sidebarManualIntentOf, sidebarOpenTabsAvailable,
      sidebarResourceTabStateOf, sidebarSessionId, sidebarTabOpeningRef,
      sidebarTabPendingRef, sidebarTabRecordsRef, trimAutoKeyMap,
    } = scope;
    // 下层工厂的函数在本层以同名局部别名调用：函数体与拆分前逐字一致。
    const { sidebarTabCloseInFlight, sidebarTabPresenceInInventory } = tabClosePort;
    const { autoSidebarOwnershipHasCapacity } = bookkeeping;
    function sidebarAutoOpenCapable() {
      return openSidebarResource !== null
      && closeSidebarResource !== null
      && (readActiveSidebarResource !== null || sidebarOpenTabsAvailable === true)
      && typeof primitives?.IconChevronLeftOutlineRegular === "function";
    }
    function autoCloseCandidate(running) {
      const origin = sidebarAutoOriginRef.current;
      const records = sidebarTabRecordsRef.current;
      const openings = sidebarTabOpeningRef.current;
      const attempts = sidebarAutoCloseAttemptsRef.current;
      for (const [key, entry] of origin) {
        // 只处理当前 surface 的记账：别的 session/root 的键在当前快照里无法判定，绝不越权操作。
        if (entry.sessionId !== sidebarSessionId || entry.rootSessionId !== rootSessionId) continue;
        const runningNow = running.has(entry.address);
        let scopedRecord = records.get(key);
        if (scopedRecord === undefined
          || scopedRecord.sessionId !== sidebarSessionId || scopedRecord.rootSessionId !== rootSessionId) scopedRecord = undefined;
        if (scopedRecord === undefined) {
          // 这个 key 的打开/动作仍在途：运行中交给下面的运行态清理（预算/冷却复位），空闲时等它
          // 落地、本轮不撤销归属。
          if (openings.has(key) || sidebarTabPendingRef.current.has(key)) {
            if (!runningNow) continue;
          } else {
            /**
             * 本实例没有记录不等于宿主里没有这个 tab（records 实例级、origin realm 级）：DOM
             * 渲染抖动、Panel 重挂载、收养只成功一部分都会走到这里。恢复前必须**权威读**持久层
             * （缓存里的 auto 不能掩盖另一 realm 写入的 manual）；并且只有宿主 inventory 仍以
             * **同一个 tabId + 同一 contentId** 承载这个地址时才重建记录；读不到时 fail-closed
             * 保留归属，明确已不是那个 tab 才撤销。
             */
            const persisted = readSidebarAutoOwnershipEntry(sidebarSessionId, rootSessionId, entry.address, { quiet: true, authoritative: true });
            const boundTabId = sidebarAutoOriginTabIdOf(entry);
            const presence = persisted === undefined ? "unreadable" : sidebarTabPresenceInInventory(boundTabId, entry.address);
            if (persisted?.origin === SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
              || (presence !== "unreadable" && presence !== "present" && !runningNow)) {
              origin.delete(key);
              clearAutoCloseBudget(key);
              continue;
            }
            if (presence === "present" && sidebarResourceTabStateOf(entry.address).tabId === boundTabId) {
              records.set(key, scopedRecord = { sessionId: sidebarSessionId, rootSessionId, tabId: boundTabId, title: null, misses: 0, origin: SIDEBAR_TAB_ORIGIN_AUTO });
            } else if (!runningNow) {
              continue;
            }
          }
        }
        if (runningNow === true) {
          // 资源重新变成运行中：它已经开着就保持开着，重试预算、owner 身份与失败冷却一并清零。
          // **绝不**丢弃仍在验证中的关闭：那条链属于「已经发出的一次关闭」，它的收口（删记录、
          // 撤销来源 / 登记抑制）与重试预算无关；丢掉它会让 record 与箭头永久停在 <<。
          if (attempts.has(key)
            || sidebarAutoCloseCooldownsRef.current.has(key)
            || sidebarAutoCloseVerificationsRef.current.has(key)) {
            deleteSidebarAutoOwnership(sidebarSessionId, rootSessionId, entry.address, "resource-running");
          }
          clearAutoCloseBudget(key);
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
    }
    function autoOpenCandidate(running) {
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
    }
    return Object.freeze({
      sidebarAutoOpenCapable, autoCloseCandidate, autoOpenCandidate,
    });
  }

  /**
   * 组合根：把四层摊平成主 IIFE 期望的单一对象（字段与拆分前的 19 个名字逐项一致）。
   *
   * 每次调用建一层新对象，兄弟函数之间的调用直接落在同一个闭包里——不绕回 Panel 包装层。
   */
  function createSidebarAutoController(scope) {
    const tabClosePort = createSidebarTabClosePort(scope);
    const bookkeeping = createSidebarAutoBookkeeping(scope);
    const verification = createSidebarCloseVerification(scope, tabClosePort);
    const candidates = createSidebarAutoCandidates(scope, tabClosePort, bookkeeping);
    return Object.freeze({
      ...candidates,
      ...verification,
      ...bookkeeping,
      ...tabClosePort,
    });
  }

  global[SYMBOL] = Object.freeze({ createSidebarAutoController });
})(globalThis);
