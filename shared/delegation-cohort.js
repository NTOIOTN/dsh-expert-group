/**
 * admission 批次与 handoff cohort 状态机。
 *
 * 同一 root turn 内的 role tool admission 批次、按 generation 管理的 cohort，以及按 turn 分组结算的 teardown 反馈。
 * 本文件由原 `shared.js` 的 203–572 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/delegation-cohort
 */

/**
 * 管理一个 root Agent 当前尚未完成的 admission batch。
 *
 * role tool 在第一次异步校验前就加入 batch，因此同一 root turn 中已被调度的
 * 后续 role tool 会共享这个 batch；accepted、advisory 和异常路径都必须 settle
 * 自己的 ticket，最后一个 ticket settle 后才允许 accepted caller 继续收口。
 * 不使用定时器：新 batch 只会在上一 batch 的 admission 全部结算后建立。
 *
 * @returns {{begin:Function}} 创建 ticket 的最小状态机。
 */
export function createAdmissionBatchCoordinator() {
  let current;

  const finish = (batch) => {
    if (batch.pending !== 0 || batch.finished === true) return;
    batch.finished = true;
    for (const resolve of batch.waiters.splice(0)) resolve();
  };

  const begin = () => {
    if (current === void 0 || current.finished === true) {
      current = { pending: 0, finished: false, waiters: [] };
    }
    const batch = current;
    batch.pending += 1;
    let settled = false;
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    batch.waiters.push(resolveReady);

    return {
      settle() {
        // 失败重试或 finally 兜底可能重复调用；重复结算不能把 sibling 提前释放。
        if (settled) return false;
        settled = true;
        batch.pending -= 1;
        finish(batch);
        return true;
      },
      whenReady() {
        return ready;
      },
    };
  };

  return { begin };
}

/**
 * 管理一个 root generation 的后台 admission cohort。entry 以对象身份消费；多个
 * accepted message 若落在同一 child turn，会共享一个 turnGroup。父 feedback 只有
 * senderSessionId 时按 exact child activation 标记全部已结束 group，未结束 future turn
 * 保持未反馈，避免同一 teardown 只释放一个 turn 或一个 token。
 */
export function createHandoffAdmissionCohort() {
  const entries = [];
  // teardown feedback 只有 child id 时仍需绑定 exact Agent activation：每次无 id feedback
  // 快照「调用时刻已存在」的 admission token，并把这些 token 并入该 activation 的累计集合。
  // 消费判定只看调用时刻的 entries + turnEnded，因此注册晚于本次 feedback 的 token 不会被
  // 本次调用消费；同一 activation 上后续登记的 token 会由下一次 feedback 消费（见 markFeedback）。
  const settlementTokenSnapshotsByActivation = new WeakMap();
  let sequence = 0;
  const owns = (entry) => entries.includes(entry);
  const validId = (value) => typeof value === "string" && value.length > 0;
  // 外部事件可能携带 null/primitive group；访问其 fields 前统一校验，
  // 但未建立 group（undefined）仍表示单 entry 的正常路径。
  const isValidTurnGroup = (value) => value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && value.entries instanceof Array;
  const groupEntries = (entry) => {
    if (entry?.turnGroup === void 0) return [entry];
    if (!isValidTurnGroup(entry.turnGroup)) return [];
    return entry.turnGroup.entries.filter(owns);
  };
  const register = (root, childId, activation) => {
    const entry = {
      token: "admission-" + (++sequence),
      root,
      childId: validId(childId) ? childId : void 0,
      messageId: void 0,
      turn: void 0,
      activation,
      turnGroup: void 0,
      turnEnded: false,
      feedbackSeen: false,
      feedbackExact: false,
      pauseDone: false,
      failed: false,
    };
    entries.push(entry);
    return entry;
  };
  const bind = (entry, childId, messageId) => {
    if (!owns(entry) || !validId(childId)) return false;
    if (entry.turnGroup !== void 0 && !isValidTurnGroup(entry.turnGroup)) return false;
    const previousChildId = entry.childId;
    entry.childId = childId;
    // 新 admission 尚未进入 turn group 时，childId 与 undefined 比较也可能命中；
    // 只有确实存在 group 才能同步迁移 group.childId，避免写入 undefined。
    if (entry.turnGroup !== void 0 && entry.turnGroup.childId === previousChildId) entry.turnGroup.childId = childId;
    if (validId(messageId)) entry.messageId = messageId;
    return true;
  };
  const rebindChild = (entry, childId) => {
    if (!owns(entry) || !validId(childId)) return false;
    if (entry.turnGroup !== void 0 && !isValidTurnGroup(entry.turnGroup)) return false;
    entry.childId = childId;
    entry.messageId = void 0;
    if (entry.turnGroup !== void 0) {
      entry.turnGroup.childId = childId;
      entry.turnGroup.entries = entry.turnGroup.entries.filter(owns);
    }
    return true;
  };
  /**
   * 标记一个 admission 的 turn 已结束。
   *
   * @param {object} entry - cohort entry。
   * @param {string} messageId - 该 turn 的 admission messageId。
   * @param {number} [turn] - turn 号。
   * @param {object} [activation] - exact child Activation。
   * @param {object} [group] - 该 turn 的 turn group。
   * @param {{deferSnapshotFeedback?:boolean}} [options] - P1：调用方判定本次 turn/end
   *   **不是可消费边界**（recoverable failure 的 turn/end）时必须传 `deferSnapshotFeedback:true`：
   *   turnEnded/turn/group 等事实照常记录（后续合法 settlement 仍需要它），但**不得**用
   *   activation 级 snapshot 把 token 提前标成 feedbackSeen。snapshot 的语义是「某条
   *   activation 级 settlement 覆盖了调用时刻存在的全部 token」，而 recoverable failure 的
   *   turn/end 并不是结算；一旦在此消费，父 inbox 之后到达的合法 UUID settlement 就再也
   *   找不到未消费 entry，对应 reason 永不释放（goal 永久 paused）。
   * @returns {boolean} 是否成功标记。
   */
  const markTurnEnd = (entry, messageId, turn, activation, group, options) => {
    if (!owns(entry) || !validId(messageId) || entry.messageId !== messageId) return false;
    if (activation !== void 0 && entry.activation !== void 0 && entry.activation !== activation) return false;
    if (group !== void 0 && !isValidTurnGroup(group)) return false;
    if (entry.turnGroup !== void 0 && !isValidTurnGroup(entry.turnGroup)) return false;
    entry.turnEnded = true;
    if (turn !== void 0) entry.turn = turn;
    if (activation !== void 0) entry.activation = activation;
    if (group !== void 0) entry.turnGroup = group;
    const deferSnapshotFeedback = options?.deferSnapshotFeedback === true;
    if (!deferSnapshotFeedback && activation !== void 0
      && (typeof activation === "object" || typeof activation === "function")) {
      const tokens = settlementTokenSnapshotsByActivation.get(activation);
      if (tokens instanceof Set && tokens.has(entry.token)) {
        for (const member of groupEntries(entry)) {
          if (tokens.has(member.token)) member.feedbackSeen = true;
        }
      }
    }
    return true;
  };
  const ensureTurnGroup = (root, childId, turn, activation, messageIds) => {
    if (!validId(childId)) return void 0;
    const ids = messageIds instanceof Set ? messageIds : void 0;
    const childEntries = entries.filter((item) => item.root === root && item.childId === childId);
    if (childEntries.some((item) => item.turnGroup !== void 0 && !isValidTurnGroup(item.turnGroup))) return void 0;
    const existing = childEntries.find((item) => isValidTurnGroup(item.turnGroup)
      && (turn === void 0 || item.turnGroup.turn === turn)
      && (activation === void 0 || item.turnGroup.activation === void 0 || item.turnGroup.activation === activation));
    let group = existing?.turnGroup;
    if (group === void 0) group = { root, childId, turn, activation, entries: [] };
    for (const entry of entries) {
      if (entry.root !== root || entry.childId !== childId
        || (activation !== void 0 && entry.activation !== void 0 && entry.activation !== activation)
        || (ids !== void 0 && !ids.has(entry.messageId))) continue;
      if (!group.entries.includes(entry)) group.entries.push(entry);
      entry.turnGroup = group;
      if (turn !== void 0) entry.turn = turn;
      if (activation !== void 0) entry.activation = activation;
    }
    return group.entries.length > 0 ? group : void 0;
  };
  const markTurnEndGroup = (root, childId, messageIds, turn, activation, group) => {
    if (!validId(childId) || !(messageIds instanceof Set)) return [];
    if (group !== void 0 && !isValidTurnGroup(group)) return [];
    const target = group ?? { root, childId, turn, activation, entries: [] };
    const matched = [];
    for (const entry of entries) {
      if (entry.root !== root || entry.childId !== childId || !messageIds.has(entry.messageId)) continue;
      if (!markTurnEnd(entry, entry.messageId, turn, activation, target)) continue;
      if (!target.entries.includes(entry)) target.entries.push(entry);
      matched.push(entry);
    }
    return matched;
  };
  /**
   * 消费一个 feedback。
   *
   * @param {object} root - exact root Agent。
   * @param {string} childId - durable child session id。
   * @param {string|undefined} messageId - admission token / admission messageId；undefined 表示
   *   无 admission 身份的 activation 级 settlement。
   * @param {object} [activation] - exact child Activation。
   * @param {Set<string>} [restrictTokens] - 可选候选白名单：wildcard 消费只能命中该集合内的
   *   token。调用方（index.js）用它把「本次 feedback 到达时刻已存在的 token 快照」固定下来，
   *   从而让**过期 pending marker 无法在被再次消费时把覆盖范围扩展到之后新登记的 token**
   *   （审核缺陷：wildcard union snapshot 提前释放下一轮）。
   * @returns {object|undefined} 被消费的 group/entry。
   */
  const markFeedback = (root, childId, messageId, activation, restrictTokens) => {
    if (!validId(childId)) return void 0;
    const restrict = restrictTokens instanceof Set ? restrictTokens : void 0;
    const childEntries = entries.filter((item) => item.root === root && item.childId === childId
      && (activation === void 0 || item.activation === activation));
    if (childEntries.some((item) => item.turnGroup !== void 0 && !isValidTurnGroup(item.turnGroup))) return void 0;
    if (messageId === void 0 && activation !== void 0 && (typeof activation === "object" || typeof activation === "function")) {
      const snapshot = new Set(entries.filter((item) => item.root === root && item.childId === childId
        && (item.activation === void 0 || item.activation === activation) && item.failed !== true
        && item.turnEnded === true
        && (restrict === void 0 || restrict.has(item.token))).map((item) => item.token));
      // 零 admission feedback 不建立空 marker；只有真实 token 存在时才更新 snapshot。
      //
      // snapshot 用**合并（union）**而不是首次固化：同一 activation 可以先后承载多个
      // admission（典型是 `queue=true` steer 复用既有 child——第二轮 admission 在原 child
      // 上登记 token2，但 feedback 仍是「只有 childId、没有 admissionId」的 teardown 通知）。
      // 固化语义下 token2 永远不在首轮建立的 snapshot 里，candidates 过滤会把它排除，
      // token2 的 feedbackSeen 永不置 true → cohort.ready() 永 false → child reason 永不释放
      // → durable goal 永久停在 paused（线上缺陷 2）。
      //
      // 为什么合并仍然满足原设计意图（「旧 feedback 不消费未来 token」）：
      // 1. snapshot 在**本次 markFeedback 调用时刻**重建，注册晚于本次调用的 token 不在
      //    集合里，也不会被本次调用消费——时间边界由构造时机保证，而不是由固化保证；
      // 2. 合并只影响同一 activation 的**下一次**无 id feedback 能看到的历史并集：那时
      //    新 token 已经存在，本就应当被消费（feedback 到达晚于 token 登记）；
      // 3. 真正的「未来 turn」保护仍在：candidates 还要求 entry.turnEnded === true，
      //    未结束的 turn 不会被任何 feedback 标记，等待它自己的 turn/end 边界。
      // 残余边界：同一条旧 settlement 被重复投递时，重复调用会看到并集（上层 index.js 的
      // messageId/admissionId 去重与 exact activation 校验是第一道防线，见
      // markPendingHandoffFeedback）。
      if (snapshot.size > 0) {
        const existing = settlementTokenSnapshotsByActivation.get(activation);
        if (existing instanceof Set) {
          for (const admissionToken of snapshot) existing.add(admissionToken);
        } else {
          settlementTokenSnapshotsByActivation.set(activation, snapshot);
        }
      }
    }
    const matching = entries.filter((item) => item.root === root && item.childId === childId
      && (activation === void 0 || item.activation === activation)
      && (messageId === void 0 || item.messageId === messageId || item.token === messageId)
      && item.turnEnded === true && item.feedbackSeen !== true && item.failed !== true);
    // restrict 只收紧 wildcard（activation 级）候选：exact 路径的身份来自 admission
    // token/messageId，调用方传入的到达快照与它无关，不得因此漏消费。
    const candidates = messageId === void 0 && activation !== void 0
      ? matching.filter((item) => (restrict === void 0 || restrict.has(item.token))
        && settlementTokenSnapshotsByActivation.get(activation)?.has(item.token))
      : matching.slice(0, 1);
    if (candidates.length === 0 || candidates.some((item) => item.turnGroup !== void 0 && !isValidTurnGroup(item.turnGroup))) return void 0;
    if (messageId !== void 0) {
      candidates[0].feedbackSeen = true;
      candidates[0].feedbackExact = true;
      return candidates[0].turnGroup ?? candidates[0];
    }
    // 无 admissionId 的 settlement 属于整个 exact activation：把当前已结束的
    // 所有 turnGroup 都标记，未结束的 future turn 保持 false，等待后续 turn/end。
    const seenGroups = new Set();
    for (const candidate of candidates) {
      const group = candidate.turnGroup;
      if (group !== void 0) {
        if (seenGroups.has(group)) continue;
        seenGroups.add(group);
      }
      const tokens = activation !== void 0 && (typeof activation === "object" || typeof activation === "function")
        ? settlementTokenSnapshotsByActivation.get(activation)
        : void 0;
      for (const member of groupEntries(candidate)) {
        if (tokens === void 0 || tokens.has(member.token)) member.feedbackSeen = true;
      }
    }
    return candidates[0].turnGroup ?? candidates[0];
  };
  const updateActivation = (root, childId, nextActivation, { previousActivation, token, nextSession } = {}) => {
    if (root === null || (typeof root !== "object" && typeof root !== "function")
      || !validId(childId) || (typeof nextActivation !== "object" && typeof nextActivation !== "function")) return 0;
    const matches = entries.filter((entry) => entry.root === root && entry.childId === childId
      && (token === void 0 || entry.token === token)
      && (previousActivation === void 0 || entry.activation === void 0 || entry.activation === previousActivation));
    if (matches.length === 0 || matches.some((entry) => entry.turnGroup !== void 0 && !isValidTurnGroup(entry.turnGroup))) return 0;
    if (previousActivation !== void 0 && previousActivation !== nextActivation
      && (typeof previousActivation === "object" || typeof previousActivation === "function")) {
      const previousSnapshot = settlementTokenSnapshotsByActivation.get(previousActivation);
      if (previousSnapshot instanceof Set) {
        // A4：activation 代际迁移时**丢弃**旧 activation 的 token 快照，绝不 union 到新
        // activation。理由：该快照表达「旧代际已收到一条 activation 级（无 admissionId）
        // settlement」，把它迁移到新 activation 会让同一条旧结论跨代覆盖新代际登记的
        // token（审核缺陷：activation 级 wildcard 跨代消费 → 提前 release）。
        //
        // 丢弃不会造成漏消费：新 activation 的下一条 wildcard feedback 会在 markFeedback
        // 内按「调用时刻仍存在的 entries」重建快照（见上），那时新 token 已登记、本就应被
        // 消费；而旧代际的 token 身份由 exact admissionId 通道与 index.js 的 exact marker
        // 保留，不依赖 activation 级快照。
        settlementTokenSnapshotsByActivation.delete(previousActivation);
      }
    }
    for (const entry of matches) {
      if (nextSession !== void 0) entry.session = nextSession;
      entry.activation = nextActivation;
      if (entry.turnGroup !== void 0) {
        entry.turnGroup.activation = nextActivation;
        entry.turnGroup.childId = childId;
      }
    }
    return matches.length;
  };
  const markFeedbackGroup = (root, childId, group, activation) => {
    if (!validId(childId) || !isValidTurnGroup(group)) return void 0;
    const entry = entries.find((item) => item.root === root && item.childId === childId
      && (activation === void 0 || item.activation === activation)
      && item.turnGroup === group && item.turnEnded === true && item.failed !== true);
    if (entry === void 0) return void 0;
    for (const member of groupEntries(entry)) member.feedbackSeen = true;
    return entry.turnGroup ?? entry;
  };
  const markPauseDone = (entry) => {
    if (!owns(entry)) return false;
    entry.pauseDone = true;
    return true;
  };
  const allPaused = (root) => {
    const cohort = entries.filter((entry) => entry.root === root && entry.failed !== true);
    return cohort.length > 0 && cohort.every((entry) => entry.pauseDone === true);
  };
  const ready = (root, entry) => {
    if (!owns(entry) || entry.root !== root || entry.failed === true || !allPaused(root)) return false;
    if (entry.turnGroup !== void 0 && !isValidTurnGroup(entry.turnGroup)) return false;
    const members = entry.feedbackExact === true ? [entry] : groupEntries(entry);
    return members.every((member) => member.turnEnded === true
      && member.feedbackSeen === true && member.pauseDone === true);
  };
  const remove = (entry) => {
    if (!owns(entry)) return false;
    entries.splice(entries.indexOf(entry), 1);
    if (entry.turnGroup !== void 0 && isValidTurnGroup(entry.turnGroup)) {
      entry.turnGroup.entries = entry.turnGroup.entries.filter((member) => member !== entry);
    }
    return true;
  };
  const clearRoot = (root) => {
    let count = 0;
    for (let index = entries.length - 1; index >= 0; index--) {
      if (entries[index].root !== root) continue;
      entries.splice(index, 1);
      count += 1;
    }
    return count;
  };
  const roots = () => [...new Set(entries.map((entry) => entry.root))];
  return {
    register,
    bind,
    rebindChild,
    ensureTurnGroup,
    markTurnEnd,
    markTurnEndGroup,
    markFeedback,
    updateActivation,
    markFeedbackGroup,
    markPauseDone,
    allPaused,
    ready,
    remove,
    clearRoot,
    roots,
    entriesFor(root) { return entries.filter((entry) => entry.root === root); },
  };
}
