/**
 * 供 Host 与 Client 共享的常量与轻量工具。此文件保持无副作用，
 * 既可由 Node ESM 导入，也可在需要时被客户端逻辑复制使用；
 * 唯一依赖是同目录下同样无外部依赖的 role-registry.js。
 * @module dsh-expert-group/shared
 */
import { listOptionalRoles, listRoles, roleStatusLabels } from "./role-registry.js";

/** 旧版 Host 的兼容 HTTP 路由（同源、仅 POST JSON）。 */
export const RPC_PATH = "/api/dsh-expert-group";

/** DSH Connection 的独立认证逻辑频道；不能占用 Gateway 独占的 /api interceptor。 */
export const RPC_CHANNEL = "/dsh-expert-group";
export const RPC_ENDPOINT = "rpc";

/** 已启用角色的插件工具名（role-named）；顺序与元数据来自统一角色注册表。 */
export const ROLES = listRoles().filter((role) => role.optional !== true).map((role) => role.id);

/** observer 默认禁用，按配置启用；可选角色同样来自统一角色注册表。 */
export const OPTIONAL_ROLES = listOptionalRoles().map((role) => role.id);

/**
 * 注意：插件不再内置任何角色默认模型——新安装后所有角色为空，
 * 由用户在侧边栏从「设置 → 模型」已配置的模型中自行选择，并通过
 * 「保存」（全局持久）或「应用」（仅当前会话）提交。
 */

/**
 * 所有专家角色（含可写的 designer/fixer）一律禁止的再委派工具。
 * 父代理是唯一编排者：专家是叶子工作者，不得再创建子代理/孙代理，
 * 也不得调用 workflow/ralph/goal 等任何多代理编排能力。
 */
export const EXPERT_DELEGATION_DENY = [
  // 专家只能通过最终 assistant 输出交付结果，禁止主动发送中间 report。
  "report",
  "subagent",
  // Harness 外层入口：专家 child 即使看见这些名字也不得绕过插件。
  "subagent_fork",
  ...listRoles().map((role) => "subagent_" + role.toolName),
  // dsh-expert-group 的唯一插件命名空间：叶子专家不得再次调用。
  // 角色工具名来自注册表：注册表新增角色会自动进入 deny，不会因漏改清单而扩大权限。
  ...listRoles().map((role) => role.toolName),
  "run_code",
  "workflow",
  "ralph",
  "create_goal",
  "update_goal",
  "send_message",
  "interrupt_agent",
  "todo_write",
];

/**
 * 所有专家 child 还需过滤仅属于当前 live root 的工具。此处独立于历史
 * EXPERT_DELEGATION_DENY，避免破坏外部对旧再委派清单的兼容契约。
 */
export const ROOT_ONLY_TOOL_DENY = [
  "dsh_expert_group_finalize",
  "dsh_expert_group_release_scope",
  // 票据 11：人工逃生只属于 root；专家 child 绝不能关闭等待账本。
  "dsh_expert_group_abandon_wait",
];

/**
 * 只读角色（explorer/librarian/oracle/observer）禁止的写操作与命令，
 * 并展开组合覆盖全部 EXPERT_DELEGATION_DENY，保证只读角色同样不能再委派。
 */
export const READONLY_DENY = [
  "write",
  "edit",
  "bash",
  "pwsh",
  ...EXPERT_DELEGATION_DENY,
  ...ROOT_ONLY_TOOL_DENY,
];

/**
 * 单个内置角色的完整 deny 候选。
 *
 * - 只读角色：READONLY_DENY（已含委派与 root-only）；
 * - 可写角色：EXPERT_DELEGATION_DENY + ROOT_ONLY_TOOL_DENY。
 * 未知角色由调用方按只读处理（fail-closed），这里不提供默认分支。
 *
 * @param {object|undefined} entry - 注册表记录。
 * @returns {string[]} 去重后的 deny 候选（仍需按宿主可见性过滤）。
 */
export function expertDenyCandidates(entry) {
  // 未知/缺失记录一律按只读处理（fail-closed）：绝不能因为查询不到角色就给出更宽的集合。
  const base = entry === void 0 || entry === null || entry.readOnly === true
    ? READONLY_DENY
    : [...EXPERT_DELEGATION_DENY, ...ROOT_ONLY_TOOL_DENY];
  return [...new Set(base)];
}

/** 注册表记录 → 显示名映射（冻结副本）。 */
export function roleLabelsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.label;
  }
  return Object.freeze(map);
}

/** 注册表记录 → 状态标签映射（冻结副本，供页面 "Xxx running" 文案）。 */
export function roleStatusLabelsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.statusLabel;
  }
  return Object.freeze(map);
}

/** 注册表记录 → 职责描述映射（冻结副本）。 */
export function roleDescriptionsOf(records) {
  const map = {};
  for (const entry of Array.isArray(records) ? records : []) {
    if (typeof entry?.id !== "string") continue;
    map[entry.id] = entry.description;
  }
  return Object.freeze(map);
}

/**
 * PTC 的 run_code 是展示传输，不是可交给 tools.restrict() 的全局工具。
 * 过滤器保留静态 deny 清单的完整性，同时只返回当前视图中真正可限制的名称。
 * @param {string[]} denyList - 静态候选 deny 工具名。
 * @param {(name: string) => boolean} isVisible - 当前父代理视图可见性判断。
 * @returns {string[]} 去重后的可限制工具名。
 */
/**
 * 将当前父代理可见的动态 MCP 工具并入只读 deny 候选。
 * MCP 工具名由宿主动态提供，静态清单无法覆盖；缺少公开 schema 时不猜测
 * 其读写语义，调用方应保持 fail-closed（至少拒绝 mcp__ 前缀工具）。
 * @param {string[]} denyList - 静态 deny 候选。
 * @param {unknown[]} visibleSchemas - tools.schemas(parent) 返回的当前视图。
 * @returns {string[]} 合并并去重后的 deny 候选。
 */
export function isReadonlyDynamicMcpName(name) {
  return typeof name === "string" && name.startsWith("mcp__");
}

export function readonlyDenyCandidates(denyList, visibleSchemas) {
  const candidates = Array.isArray(denyList) ? denyList.slice() : [];
  if (!Array.isArray(visibleSchemas)) return candidates;
  for (const schema of visibleSchemas) {
    const name = schema?.name;
    if (isReadonlyDynamicMcpName(name)) candidates.push(name);
  }
  return candidates;
}

export function restrictableDenyNames(denyList, isVisible) {
  if (!Array.isArray(denyList) || typeof isVisible !== "function") return [];
  const result = [];
  const seen = new Set();
  for (const name of denyList) {
    if (name === "run_code" || seen.has(name) || !isVisible(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

/**
 * 从父 inbox 注入的 DSH 消息提取专家反馈 child id。
 *
 * 结构化通知仍只接受 subagent-settled/subagent-report，且 senderSessionId 必须是非空字符串。
 * 真实宿主在部分路径不会附带 source，只会把固定的自动完成前缀写入多个 text block；
 * 此处只接受该完整固定前缀和 canonical UUID，避免从普通正文、代码块或用户消息猜测 child。
 * 解析只是身份归类，调用方仍必须通过 exact activation、turnEnded 和 cohort 结算保护。
 *
 * B（兼容边界）：本 helper 只做**身份归类**，不代表该形态可以释放 handoff。core 当前只铸
 * `subagent-settled`(form=notice) 的 UUID settlement；`subagent-report`(form=relay) 没有
 * correlation id（不同 message.id、无 turn/admission 关联），无法证明属于哪一轮 admission。
 * 调用方必须对 relay fail-closed，不得让它进入 markPendingHandoffFeedback / 通配 release
 * 路径（见 index.js 的 agent/inbox/inserted handler）。
 * @param {object} [message] - DSH inbox 消息。
 * @param {{allowSourceLess?:boolean}} [options] - 仅 session/event/spliced 可打开无 source 解析。
 * @returns {string|undefined} 匹配的 child session id。
 */
export function subagentFeedbackChildId(message, options = {}) {
  const source = message?.source;
  if (source?.kind === "subagent-settled" || source?.kind === "subagent-report") {
    return typeof source.senderSessionId === "string" && source.senderSessionId.length > 0
      ? source.senderSessionId
      : void 0;
  }
  // 无 source 的文本形态默认拒绝；只有 root session/event/spliced 显式打开时才解析。
  // 普通 agent/inbox/inserted 不能仅凭正文猜测 child，避免用户文本伪造 settlement。
  if (options?.allowSourceLess !== true
    || source !== void 0 || message === null || typeof message !== "object") return void 0;
  const content = message.content;
  if (!Array.isArray(content)) return void 0;
  const text = content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
  const match = /^Background subagent ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}) finished and will do no further work unless you send it more\./i.exec(text);
  return match?.[1];
}

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

/**
 * 为每个 Session generation 保存 transient turn/claimed 状态。cold resume 会创建
 * 新的 Session 对象但保留 durable id；对象作为 WeakMap key 可以让新 generation
 * 从空状态开始，同时不影响 recovery record 中持久的 task/op/activity。
 */
export function createSessionGenerationState() {
  const states = new WeakMap();
  const validSession = (session) => session !== null
    && (typeof session === "object" || typeof session === "function");
  const get = (session) => {
    if (!validSession(session)) return void 0;
    let state = states.get(session);
    if (state === void 0) {
      state = { handledTurnEnds: new Set(), claimed: new Map() };
      states.set(session, state);
    }
    return state;
  };
  const reset = (session) => validSession(session) ? states.delete(session) : false;
  const claimTurn = (session, turn) => {
    if (!Number.isSafeInteger(turn)) return false;
    const state = get(session);
    if (state === void 0 || state.handledTurnEnds.has(turn)) return false;
    state.handledTurnEnds.add(turn);
    return true;
  };
  return { get, reset, claimTurn };
}

/**
 * 保存失败 admission 的 exact terminal tombstone。tombstone 不依赖 cohort entry
 * 的存活；迟到 turn/end 可按 child、durable Session、messageId/turn 反查并消费。
 * 没有可反查的 messageId/turn 时不保存，避免产生无期限 generic fallback。
 */
export function createHandoffFailureRegistry() {
  const failures = new Map();
  const validObject = (value) => value !== null
    && (typeof value === "object" || typeof value === "function");
  const validString = (value) => typeof value === "string" && value.length > 0;
  const sessionIdOf = (session) => validString(session?.id) ? session.id : void 0;
  const descriptorOf = (admission, context = {}) => {
    const session = admission?.session ?? context.session;
    const sessionId = admission?.sessionId ?? context.sessionId ?? sessionIdOf(session);
    const messageId = admission?.messageId ?? context.messageId;
    const turn = Number.isSafeInteger(admission?.turn) ? admission.turn
      : Number.isSafeInteger(context.turn) ? context.turn : void 0;
    return {
      token: admission?.token,
      childId: admission?.childId ?? context.childId,
      session,
      sessionId,
      messageId: validString(messageId) ? messageId : void 0,
      turn,
    };
  };
  const get = (parent) => failures.get(parent);
  const remember = (parent, admissions, context = {}) => {
    if (!validObject(parent) || !Array.isArray(admissions)) return 0;
    let records = failures.get(parent);
    let count = 0;
    for (const admission of admissions) {
      const descriptor = descriptorOf(admission, context);
      if (!validString(descriptor.token) || !validString(descriptor.childId)
        || (!validString(descriptor.messageId) && !Number.isSafeInteger(descriptor.turn))) continue;
      if (records === void 0) { records = new Map(); failures.set(parent, records); }
      records.set(descriptor.token, descriptor);
      count += 1;
    }
    return count;
  };
  const sessionMatches = (record, query) => {
    if (record.session !== void 0 && query.session !== void 0 && record.session === query.session) return true;
    const querySessionId = query.sessionId ?? sessionIdOf(query.session);
    return validString(record.sessionId) && validString(querySessionId) && record.sessionId === querySessionId;
  };
  const messageMatches = (record, query) => {
    if (!validString(record.messageId)) return false;
    if (record.messageId === query.messageId) return true;
    return query.messageIds instanceof Set && query.messageIds.has(record.messageId);
  };
  const matches = (record, childId, query = {}) => {
    if (record.childId !== childId) return false;
    // 已知 token 仍校验 caller 提供的 Session/turn/message metadata；token 只是
    // 缩小候选，不得让旧 generation 或错误 turn 越过 exact terminal 边界。
    if (validString(query.token) && record.token !== query.token) return false;
    if (!sessionMatches(record, query)) return false;
    if (Number.isSafeInteger(record.turn) && record.turn !== query.turn) return false;
    return messageMatches(record, query) || (Number.isSafeInteger(record.turn) && record.turn === query.turn);
  };
  const lookup = (parent, childId, query = {}) => {
    const records = failures.get(parent);
    if (!(records instanceof Map) || !validString(childId)) return void 0;
    for (const record of records.values()) {
      if (matches(record, childId, query)) return record;
    }
    return void 0;
  };
  const consume = (parent, childId, query = {}) => {
    const records = failures.get(parent);
    if (!(records instanceof Map)) return false;
    const record = lookup(parent, childId, query);
    if (record === void 0) return false;
    records.delete(record.token);
    if (records.size === 0) failures.delete(parent);
    return true;
  };
  const clearChild = (parent, childId) => {
    const records = failures.get(parent);
    if (!(records instanceof Map) || !validString(childId)) return 0;
    let count = 0;
    for (const [token, record] of records) {
      if (record.childId !== childId) continue;
      records.delete(token);
      count += 1;
    }
    if (records.size === 0) failures.delete(parent);
    return count;
  };
  const pruneUnmatchable = (parent) => {
    const records = failures.get(parent);
    if (!(records instanceof Map)) return 0;
    let count = 0;
    for (const [token, record] of records) {
      if (validString(record.messageId) || Number.isSafeInteger(record.turn)) continue;
      records.delete(token);
      count += 1;
    }
    if (records.size === 0) failures.delete(parent);
    return count;
  };
  return {
    get, remember, lookup, consume, clearChild, pruneUnmatchable,
    delete: (parent) => failures.delete(parent),
    has: (parent) => failures.has(parent),
    clear: () => failures.clear(),
  };
}

/**
 * 判断 cold-resume 前后的 Session 是否仍是同一个 durable child。DSH 会为新
 * Activation 创建不同的 Session/Agent 对象，因此不能使用对象引用；同时要求
 * durable id 与当前 child id 一致，避免错误 record 被复用。
 */
export function sameDurableSessionId(left, right, childId) {
  try {
    return typeof left?.id === "string" && left.id.length > 0
      && typeof right?.id === "string" && right.id.length > 0
      && left.id === right.id
      && (childId === void 0 || left.id === childId);
  } catch {
    return false;
  }
}


/**
 * 从结构化 ToolExecution 读取 root 文件操作目标。DSH PTC 的每个结构化
 * 内层 dispatch 同样经过工具 guard，并直接呈现内层 name/arguments；因此这里只
 * 读取已解析的 arguments.file_path/path，绝不解析 PTC transport、bash 或 pwsh 文本。
 * @param {object} [execution] - ToolExecution 或结构化内层执行对象。
 * @returns {{toolName:string, path:string|null, workspaceWide:boolean}|undefined}
 */
export function structuredToolTarget(execution) {
  const toolName = execution?.name;
  if (!["read", "edit", "write", "glob", "grep"].includes(toolName)) return void 0;
  const args = execution?.arguments;
  const field = toolName === "glob" || toolName === "grep" ? "path" : "file_path";
  const value = args !== null && typeof args === "object" && typeof args[field] === "string"
    ? args[field].trim()
    : "";
  if (value.length > 0) return { toolName, path: value, workspaceWide: false };
  if (toolName === "glob" || toolName === "grep") return { toolName, path: null, workspaceWide: true };
  return void 0;
}

function activeTaskPathsForGuard(task, workspaceRoot) {
  if (!Array.isArray(task?.affectedPaths)) return [];
  return normalizeAffectedPathsForWorkspace(task.affectedPaths, workspaceRoot);
}

function activeTaskGuardLabel(task) {
  const role = typeof task?.role === "string" && task.role.length > 0 ? task.role : "unknown role";
  const description = typeof task?.description === "string" && task.description.length > 0
    ? task.description
    : typeof task?.taskKey === "string" && task.taskKey.length > 0 ? task.taskKey : "unnamed task";
  return role + " (" + description + ")";
}

/**
 * 检查 root 自身结构化文件操作是否会碰到活动专家范围。
 * 返回值遵循 tools.guard 的约定：字符串表示拒绝，undefined 表示放行。
 * - 任一活动任务没有 affectedPaths 时先拒绝，避免把未知范围误当作安全；
 * - glob/grep 无 path 视为 workspace-wide 未知范围；
 * - 明确路径只比较 normalizeAffectedPaths 与活动范围的交集；
 * - rootAgentId 与 execution.agent.id 不一致时直接放行，防止 root guard 影响 child。
 * @param {object} [execution] - 当前 ToolExecution（也可能是 PTC transport 内层执行）。
 * @param {Array} [activeTasks] - 当前 root 的 tracker.listActiveTasks 快照。
 * @param {string} [rootAgentId] - 安装 guard 的 root session id。
 * @param {string|object} [workspaceRootOrOptions] - 稳定 workspace root；也接受
 *   {workspaceRoot} 选项以便调用方显式传参。
 * @returns {string|undefined} 拒绝原因或 undefined。
 */
export function rootStructuredPathGuard(execution, activeTasks, rootAgentId, workspaceRootOrOptions) {
  const workspaceRoot = typeof workspaceRootOrOptions === "string"
    ? workspaceRootOrOptions
    : workspaceRootOrOptions?.workspaceRoot;
  if (typeof rootAgentId === "string" && execution?.agent?.id !== rootAgentId) return void 0;
  const target = structuredToolTarget(execution);
  if (target === void 0) return void 0;
  const tasks = Array.isArray(activeTasks) ? activeTasks : [];
  if (tasks.length === 0) return void 0;
  const missing = tasks.filter((task) => activeTaskPathsForGuard(task, workspaceRoot).length === 0);
  if (missing.length > 0) {
    const labels = missing.map(activeTaskGuardLabel).join(", ");
    return "Root structured file operation cannot safely continue because affectedPaths is missing for active expert task(s): " + labels + ".";
  }
  if (target.workspaceWide) {
    const labels = tasks.map(activeTaskGuardLabel).join(", ");
    return "Root structured file operation cannot safely continue because " + target.toolName + " has an unknown/workspace-wide path that may overlap active expert task(s): " + labels + ".";
  }
  const targetPaths = normalizeAffectedPathsForWorkspace([target.path], workspaceRoot);
  const conflicts = [];
  for (const task of tasks) {
    const activePaths = activeTaskPathsForGuard(task, workspaceRoot);
    const overlaps = [];
    for (const incoming of targetPaths) {
      for (const active of activePaths) {
        if (affectedPathEntriesOverlap(incoming, active)) overlaps.push({ incoming, active });
      }
    }
    if (overlaps.length > 0) conflicts.push({ task, overlaps });
  }
  if (conflicts.length === 0) return void 0;
  const details = conflicts.map(({ task, overlaps }) =>
    activeTaskGuardLabel(task) + " (" + overlaps.map(({ incoming, active }) => incoming.value + " <-> " + active.value).join(", ") + ")",
  ).join("; ");
  return "Root structured file operation " + target.toolName + " on " + target.path + " is blocked because it overlaps active expert work: " + details + ".";
}

/**
 * 把一次委派的 prompt 文本归一化为稳定的任务 key：
 * NFKC（全角→半角）→ trim → 连续空白折叠为单个空格 → 英文小写。
 * 归一化后完全相同的任务会被识别为重复，触发「复用」而不是重复启动。
 */
export function delegationTaskKey(text) {
  return String(text ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * 同一父代理 + 同一角色的临界区/复用 scope key。
 * parentId 是 session id（UUID），role 是英文字母，用 "::" 分隔不会冲突。
 */
export function delegationScopeKey(parentId, role) {
  return `${String(parentId)}::${String(role)}`;
}

/**
 * 归一化专家任务声明的影响范围。未带类型前缀的字符串按路径处理，末尾斜杠
 * 明确表示目录；file:/dir:/directory:/symbol: 前缀可消除歧义。路径统一使用
 * 小写正斜杠，符号保留大小写，避免把大小写敏感语言的不同符号误判为相同范围。
 * @param {unknown} affectedPaths - 工具输入的字符串数组。
 * @returns {Array<{kind:"path"|"file"|"directory"|"symbol", value:string}>} 去重后的范围。
 */
export function normalizeAffectedPaths(affectedPaths) {
  if (!Array.isArray(affectedPaths)) return [];
  const result = [];
  const seen = new Set();
  for (const item of affectedPaths) {
    if (typeof item !== "string") continue;
    const raw = item.normalize("NFKC").trim();
    if (raw.length === 0) continue;
    const typed = /^(file|dir|directory|symbol)\s*:(.*)$/i.exec(raw);
    const type = typed?.[1]?.toLowerCase();
    if (type === "symbol") {
      const value = String(typed?.[2] ?? "").trim();
      if (value.length === 0) continue;
      const entry = { kind: "symbol", value };
      const key = `${entry.kind}:${entry.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(entry);
      }
      continue;
    }
    const hadTrailingSlash = /[\\/]$/.test(raw);
    let value = String(typed?.[2] ?? raw)
      .trim()
      .replace(/\\/g, "/")
      .replace(/\/{2,}/g, "/");
    while (value.startsWith("./")) value = value.slice(2);
    value = value.replace(/\/+$/, "").toLowerCase();
    if (value.length === 0) continue;
    const entry = {
      kind: type === "file" ? "file" : type === "dir" || type === "directory" || hadTrailingSlash ? "directory" : "path",
      value,
    };
    const key = `${entry.kind}:${entry.value}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result;
}

function canonicalWorkspacePath(value) {
  if (typeof value !== "string") return "";
  let raw = value.normalize("NFKC").trim().replace(/\\/g, "/");
  if (raw.length === 0) return "";
  const unc = raw.startsWith("//");
  raw = raw.replace(/\/{2,}/g, "/");
  let prefix = "";
  let rest = raw;
  let absolute = false;
  const drive = /^([A-Za-z]):\//.exec(raw);
  if (drive !== null) {
    prefix = drive[1].toLowerCase() + ":/";
    rest = raw.slice(3);
    absolute = true;
  } else if (unc) {
    prefix = "//";
    rest = raw.replace(/^\/+/, "");
    absolute = true;
  } else if (raw.startsWith("/")) {
    prefix = "/";
    rest = raw.replace(/^\/+/, "");
    absolute = true;
  }
  const segments = [];
  for (const segment of rest.split("/")) {
    if (segment.length === 0 || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") segments.pop();
      else if (!absolute) segments.push("..");
      continue;
    }
    segments.push(segment.toLowerCase());
  }
  const joined = segments.join("/");
  if (prefix === "/") return joined.length > 0 ? "/" + joined : "/";
  if (prefix === "//") return joined.length > 0 ? "//" + joined : "//";
  if (prefix.length > 0) return prefix + joined;
  return joined.length > 0 ? joined : ".";
}

/**
 * 将路径统一到可选 workspace root 下的稳定形式。相对路径只在传入 workspaceRoot
 * 时解析，绝不读取 process.cwd；绝对路径直接规范化。Windows 分隔符、大小写、
 * 重复分隔符和 . / .. 片段使用同一规则处理，便于 root 与专家声明相互比较。
 * @param {unknown} value - 文件或目录路径。
 * @param {unknown} workspaceRoot - 可选稳定工作区根目录。
 * @returns {string} 规范化后的路径；非法/空输入返回空字符串。
 */
export function normalizeWorkspacePath(value, workspaceRoot) {
  if (typeof value !== "string") return "";
  const path = value.normalize("NFKC").trim().replace(/\\/g, "/");
  if (path.length === 0) return "";
  const absolute = path.startsWith("/") || /^[A-Za-z]:\//.test(path);
  if (absolute || typeof workspaceRoot !== "string" || workspaceRoot.trim().length === 0) {
    return canonicalWorkspacePath(path);
  }
  const root = canonicalWorkspacePath(workspaceRoot);
  return canonicalWorkspacePath(root.length === 0 || root === "." ? path : root + "/" + path);
}

/**
 * 统一一组专家影响范围；除字符串外也接受 tracker 快照中的已归一化范围对象，
 * 这样 root guard 可在不改变既有 tracker API 的前提下重新绑定 workspace root。
 * symbol 不做路径解析，只保持原有精确相等语义。
 * @param {unknown} affectedPaths - 字符串或 {kind,value} 范围数组。
 * @param {unknown} workspaceRoot - 可选稳定工作区根目录。
 * @returns {Array<{kind:string,value:string}>} 统一后的范围。
 */
export function normalizeAffectedPathsForWorkspace(affectedPaths, workspaceRoot) {
  if (!Array.isArray(affectedPaths)) return [];
  const raw = [];
  for (const item of affectedPaths) {
    if (typeof item === "string") {
      raw.push(item);
      continue;
    }
    if (item === null || typeof item !== "object" || typeof item.value !== "string") continue;
    if (item.kind === "symbol") raw.push("symbol:" + item.value);
    else if (item.kind === "file") raw.push("file:" + item.value);
    else if (item.kind === "directory") raw.push("dir:" + item.value);
    else raw.push(item.value);
  }
  return normalizeAffectedPaths(raw).map((entry) => entry.kind === "symbol"
    ? entry
    : { ...entry, value: normalizeWorkspacePath(entry.value, workspaceRoot) },
  ).filter((entry) => entry.value.length > 0);
}

/**
 * 判断两个已归一化影响范围是否相交。符号只在完全相同时相交；文件不会被
 * 当作祖先，目录和未显式标记类型的路径则会与其后代相交。
 * @param {object} left - normalizeAffectedPaths 返回的单个范围。
 * @param {object} right - normalizeAffectedPaths 返回的单个范围。
 * @returns {boolean} 存在相交范围返回 true。
 */
export function affectedPathEntriesOverlap(left, right) {
  if (left === null || typeof left !== "object" || right === null || typeof right !== "object") return false;
  if (typeof left.value !== "string" || typeof right.value !== "string") return false;
  if (left.kind === "symbol" || right.kind === "symbol") {
    return left.kind === "symbol" && right.kind === "symbol" && left.value === right.value;
  }
  if (left.value === right.value) return true;
  if (left.value.startsWith(`${right.value}/`)) return right.kind !== "file";
  if (right.value.startsWith(`${left.value}/`)) return left.kind !== "file";
  return false;
}

/**
 * 返回两组影响范围的全部交集对，供活动任务登记和单元测试复用。
 * @param {unknown} left - 第一组范围。
 * @param {unknown} right - 第二组范围。
 * @returns {Array<{left:object, right:object}>} 每一项是一对相交范围。
 */
export function findAffectedPathOverlaps(left, right) {
  const leftEntries = normalizeAffectedPaths(left);
  const rightEntries = normalizeAffectedPaths(right);
  const overlaps = [];
  for (const leftEntry of leftEntries) {
    for (const rightEntry of rightEntries) {
      if (affectedPathEntriesOverlap(leftEntry, rightEntry)) overlaps.push({ left: leftEntry, right: rightEntry });
    }
  }
  return overlaps;
}

/**
 * 从新建预登记 FIFO 队列取第一个匹配 parentId+role 的待创建项（P3，
 * startContinuable 新建路径的 binding acceptance 竞态预登记）：
 * agent/created 同步触发且早于 startContinuable resolve，需要按
 * parentId+role 找到本次新建的预登记项并立即写入 pendingMessage 绑定。
 * 父+角色串行（delegationTracker.serialize）保证同 scope 最多一个匹配项；
 * 不同角色互不干扰。匹配即从队列删除并返回；无匹配返回 undefined。
 * @param {Array} list - pendingCreations 队列（元素 { taskKey, parentId, role }）。
 * @param {string} parentId - 父代理 session id。
 * @param {string} role - 角色名。
 * @param {object} [parent] - 可选的 exact root Agent；提供时拒绝同 id 旧代际。
 * @returns {object|undefined} 匹配项（已从队列移除）；无匹配返回 undefined。
 */
export function takePendingCreation(list, parentId, role, parent) {
  if (!Array.isArray(list)) return void 0;
  const idx = list.findIndex(
    (item) => item !== null && typeof item === "object" && item.parentId === parentId && item.role === role
      && (parent === void 0 || item.parent === parent),
  );
  if (idx === -1) return void 0;
  return list.splice(idx, 1)[0];
}

/**
 * 回滚已被 agent/created 同步消费、但 startContinuable 未返回有效 messageId 的
 * 新建 acceptance。通过 transaction.record/childId/taskKey 做 exact ownership 判断，
 * 不触碰既有 recovery op 或其他 task；保留 durable record 时标记失效，
 * 让调用方禁止后续错误 reused。
 */
export function rollbackCreatedChildAcceptance({ recoveryRecords, transaction, releaseActivity, dropRecord, message = "child acceptance failed" } = {}) {
  if (!(recoveryRecords instanceof Map) || transaction === null || typeof transaction !== "object") {
    return { activityReleased: false, bindingRemoved: false, recordRemoved: false };
  }
  let activityReleased = false;
  if (transaction.activityId !== void 0 && typeof releaseActivity === "function") {
    try { activityReleased = releaseActivity(transaction.activityId) === true; } catch {}
  }
  const childId = transaction.childId;
  const record = transaction.record;
  if (!validStringValue(childId) || record === void 0 || recoveryRecords.get(childId) !== record) {
    return { activityReleased, bindingRemoved: false, recordRemoved: false };
  }
  let bindingRemoved = false;
  const binding = record.tasks?.get(transaction.taskKey);
  if (transaction.taskBindingOwned === true && binding === transaction.binding
    && binding?.childId === childId) {
    if (transaction.previousBinding === void 0) record.tasks.delete(transaction.taskKey);
    else record.tasks.set(transaction.taskKey, transaction.previousBinding);
    record.taskRecoveryContexts?.delete(transaction.taskKey);
    bindingRemoved = true;
  }
  if (transaction.recordOwned !== true) {
    record.invalidAcceptance = true;
    return { activityReleased, bindingRemoved, recordRemoved: false };
  }
  const noDurableState = (record.tasks?.size ?? 0) === 0
    && (record.pendingRecoveries?.size ?? 0) === 0;
  if (!noDurableState) {
    // 事务创建后若又出现 durable task/op，也不能删除 record；同时
    // 禁止这次失败 acceptance 让 reuseOrSteer 静默复用该 child。
    record.invalidAcceptance = true;
    return { activityReleased, bindingRemoved, recordRemoved: false };
  }
  let recordRemoved = false;
  if (typeof dropRecord === "function") {
    try { dropRecord(childId, message, record); recordRemoved = recoveryRecords.get(childId) !== record; } catch {}
  }
  // callback 异常或 no-op 时也必须再次校验 record identity；不能把同 childId
  // 的并发替代 record 当作本事务目标删除。
  if (!recordRemoved && recoveryRecords.get(childId) === record) recordRemoved = recoveryRecords.delete(childId);
  return { activityReleased, bindingRemoved, recordRemoved };
}

function validStringValue(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * 任务指纹默认 TTL：10 分钟。同一归一化 prompt 只在此窗口内视为「重复任务」，
 * 到期后惰性删除，相同 prompt 可再次进入复用判定——
 * 避免相同任务在父会话整个生命周期内永久失效（例如修复后重试同一 prompt）。
 */
export const TASK_TTL_DEFAULT_MS = 10 * 60 * 1000;

/**
 * 读取任务记忆条目记录的时刻。旧版本把值直接存成时间戳，新版本存
 * { childId, routeKey, at }；两种格式都要能读出时间，避免升级后旧条目被误判过期。
 * @param {unknown} record - scope.tasks 的值。
 * @returns {number} 记住时刻；非法输入返回 0（视为最旧）。
 */
function taskRecordAt(record) {
  if (typeof record === "number" && Number.isFinite(record)) return record;
  return Number.isFinite(record?.at) ? record.at : 0;
}

/**
 * 读取任务记忆条目绑定的 childId（旧格式没有绑定）。
 * @param {unknown} record - scope.tasks 的值。
 * @returns {string|undefined} 非空 childId；无绑定返回 undefined。
 */
function taskRecordChildId(record) {
  return typeof record?.childId === "string" && record.childId.length > 0 ? record.childId : void 0;
}

/**
 * 创建轻量委派跟踪器：按 scope（父代理 + 角色）做 FIFO 串行临界区、
 * 记录最近新建/恢复的 child 与其 route（provider/model/reasoningEffort 组合）、
 * 以及「任务 key → 它自己的 child」绑定表与 LRU 记忆（默认上限 32 条）。
 *
 * 多 child 语义：同一 parent+role 下不同任务各自拥有独立 child，相同任务复用
 * 它原来那个 child；因此按任务定位必须走 getTaskChild，而不是 getChild。
 * 纯内存、无依赖、可单测。
 * @param {object} [options] - 可选配置：
 *   - taskLimit: 任务记忆 LRU 上限（默认 32）；
 *   - taskTtlMs: 任务指纹有效期（毫秒，默认 TASK_TTL_DEFAULT_MS，10 分钟）；
 *     过期记录在 hasTask 时惰性删除；
 *   - now: 时钟注入函数（默认 () => Date.now()），测试可伪造时间验证 TTL，
 *     无需真实等待。
 */
export function createDelegationTracker(options = {}) {
  // LRU 上限：超过后淘汰最久未用的任务 key，防止长期运行的内存增长。
  const taskLimit = Number.isSafeInteger(options?.taskLimit) && options.taskLimit > 0 ? options.taskLimit : 32;
  // 任务指纹 TTL：正有限毫秒数生效，否则回落默认 10 分钟。
  const taskTtlMs = Number.isFinite(options?.taskTtlMs) && options.taskTtlMs > 0 ? options.taskTtlMs : TASK_TTL_DEFAULT_MS;
  // 时钟注入：默认真实时间；测试传 now() 伪造时钟即可验证过期行为。
  const now = typeof options?.now === "function" ? options.now : () => Date.now();
  /**
   * scope -> { childId, routeKey, tasks: Map(key -> { childId, routeKey, at }, 插入序=LRU), queue: Promise 链 }
   *
   * scope.childId 只表示「本 scope 最近一次新建/恢复的 child」，用于诊断、快照恢复
   * 与 route 变更判定，**不再**表示「本 scope 唯一的可复用 child」：同一 parent+role
   * 下允许多个独立 child 并存，每个任务 key 通过 tasks 表绑定到它自己的 child。
   */
  const scopes = new Map();
  /** parentId -> Promise：只保护范围预检和登记这个短临界区，不串行专家实际执行。 */
  const parentQueues = new Map();
  /** activityId -> 活动任务范围；仅当前插件进程内存，不写入 settings 或跨会话存储。 */
  const activeTasks = new Map();
  let activeTaskSeq = 0;

  /**
   * 复制活动项快照。
   *
   * 副本**不携带** parentAgent：它是 live root Agent 的强引用，只用于内部 owner 过滤
   * （completeActiveTasksForChild），不得经 listActiveTasks / 诊断 / 工具回执外泄。
   * detached 统一归一为布尔值，保证「是否已脱离 root」在快照里始终可读。
   */
  function copyActiveTask(task) {
    const { parentAgent: _parentAgent, ...rest } = task;
    return {
      ...rest,
      detached: task.detached === true,
      affectedPaths: task.affectedPaths.map((path) => ({ ...path })),
    };
  }

  /**
   * 把某 parent 的活动项标记为 detached：root 销毁/代际退休不是停止证据（票据 07），
   * 活动项必须继续按同一 parentId 阻塞同路径任务。
   *
   * 只移除 parentAgent 强引用，保留 parentId/role/taskKey/childId/messageId/affectedPaths：
   * - 同一 parentId 的后续 generation 仍会看到这条保护（不得继承释放）；
   * - 该 child 自己的权威停止信号仍能按 childId + messageId 精确命中；
   * - 已销毁 root 对象不会被 tracker 长期持有。
   * @param {object} task - 内部活动项。
   */
  function detachActiveTask(task) {
    task.detached = true;
    delete task.parentAgent;
  }

  function activeTasksForParent(parentId) {
    const id = String(parentId);
    return [...activeTasks.values()].filter((task) => task.parentId === id);
  }

  /** 把可迭代的任务 key 或活动 id 归一为字符串 Set，供终态关联复用。 */
  function stringSet(values) {
    const result = new Set();
    if (values === null || values === void 0 || typeof values[Symbol.iterator] !== "function") return result;
    for (const value of values) {
      if (typeof value === "string") result.add(value);
    }
    return result;
  }

  /**
   * 用稳定 admission messageId 优先定位本 child 的活动任务；taskKey 只在消息
   * 关联不可用或恢复 op 显式携带 key 时作为辅助。活动登记独立于 scope.tasks
   * TTL/LRU 和 recovery record.tasks 的上限，因此任务绑定被淘汰后仍可终态清理。
   */
  function matchingActiveTaskIdsForTurn({ parentId, role, childId, turnMsgIds, taskKeys } = {}) {
    const messageIds = stringSet(turnMsgIds);
    const keys = stringSet(taskKeys);
    const messageMatches = [];
    const keyFallbacks = [];
    for (const [activityId, task] of activeTasks) {
      if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.childId !== childId) continue;
      if (typeof task.messageId === "string" && messageIds.has(task.messageId)) {
        messageMatches.push(activityId);
      } else if (typeof task.messageId !== "string" && keys.has(task.taskKey)) {
        // taskKey 只能兜底尚未获得 admission messageId 的早期竞态。若同 child
        // 已有任何稳定消息命中，绝不按 key 扩大集合，避免 TTL 后同 key 新任务
        // 被旧 turn 误删。
        keyFallbacks.push(activityId);
      }
    }
    return messageMatches.length > 0 ? messageMatches : keyFallbacks;
  }

  function scopeWarningFor(conflicts, missing, allowOverlap, missingIncoming = false) {
    const parts = [];
    if (conflicts.length > 0) {
      const details = conflicts.map(({ task, overlaps }) => {
        const label = task.description.length > 0 ? task.description : task.taskKey;
        const ranges = overlaps.map(({ incoming, active }) => incoming.value + " <-> " + active.value).join(", ");
        return task.role + " (" + label + "): " + ranges;
      }).join("; ");
      parts.push("Affected-path conflict advisory: this task overlaps active expert work: " + details + "." + (allowOverlap === true
        ? " Continuing only because allowOverlap=true was explicitly set."
        : " It was not started; set allowOverlap=true only after explicitly deciding that the overlap is safe."));
    }
    if (missingIncoming === true) {
      parts.push("Affected-path conflict check cannot be completed because the new task is missing affectedPaths.");
    }
    if (missing.length > 0) {
      const labels = missing.map((task) => task.role + " (" + (task.description.length > 0 ? task.description : task.taskKey) + ")").join(", ");
      parts.push("Affected-path conflict check cannot be completed because affectedPaths is missing for " + labels + ".");
    }
    return parts.join(" ");
  }

  function entryOf(scope) {
    let entry = scopes.get(scope);
    if (entry === void 0) {
      entry = { childId: void 0, routeKey: void 0, tasks: new Map(), queue: Promise.resolve() };
      scopes.set(scope, entry);
    }
    return entry;
  }

  return {
    /**
     * 同 scope FIFO 串行临界区：callback 依次执行，前一个失败不影响后一个。
     * index.js 在临界区内完成「复用/排队/新建」判定，杜绝并发重复 start。
     */
    async serialize(scope, callback) {
      const entry = entryOf(scope);
      const run = entry.queue.then(callback, callback);
      entry.queue = run.catch(() => {});
      return run;
    },

    /**
     * 按父代理短暂串行范围预检和登记。回调不得在其中 await 专家执行；因此独立
     * 任务完成登记后仍可并行运行，同时不会出现两个角色同时看见空登记表的竞态。
     */
    async serializeParent(parentId, callback) {
      const key = String(parentId);
      const previous = parentQueues.get(key) ?? Promise.resolve();
      const run = previous.then(callback, callback);
      parentQueues.set(key, run.catch(() => {}));
      return run;
    },

    /**
     * 检查新任务与同一父代理下的活动范围。缺少新任务或既有任务范围时只给出
     * unchecked advisory，不阻止；存在明确交集时默认 blocked，除非 allowOverlap。
     */
    checkActiveTaskScope({ parentId, affectedPaths, allowOverlap = false } = {}) {
      const normalizedAffectedPaths = normalizeAffectedPaths(affectedPaths);
      const active = activeTasksForParent(parentId);
      const missing = [];
      const conflicts = [];
      if (normalizedAffectedPaths.length === 0) {
        // 当前任务没有可比范围：这是新任务自身缺少声明，不能把已声明范围的
        // 活动任务误报为缺失；仍只返回 unchecked advisory，不阻断派发。
        return {
          status: "unchecked",
          blocked: false,
          warning: scopeWarningFor([], [], allowOverlap, true),
          affectedPaths: normalizedAffectedPaths,
          conflicts: [],
          missing: [],
          missingIncoming: true,
        };
      }
      for (const task of active) {
        if (task.affectedPaths.length === 0) {
          missing.push(task);
          continue;
        }
        const overlaps = [];
        for (const incoming of normalizedAffectedPaths) {
          for (const activePath of task.affectedPaths) {
            if (affectedPathEntriesOverlap(incoming, activePath)) overlaps.push({ incoming, active: activePath });
          }
        }
        if (overlaps.length > 0) conflicts.push({ task, overlaps });
      }
      const blocked = conflicts.length > 0 && allowOverlap !== true;
      return {
        status: conflicts.length > 0 ? "conflict" : missing.length > 0 ? "unchecked" : "clear",
        blocked,
        warning: scopeWarningFor(conflicts, missing, allowOverlap),
        affectedPaths: normalizedAffectedPaths,
        conflicts: conflicts.map(({ task, overlaps }) => ({
          task: copyActiveTask(task),
          overlaps: overlaps.map(({ incoming, active }) => ({ incoming: { ...incoming }, active: { ...active } })),
        })),
        missing: missing.map(copyActiveTask),
      };
    },

    /** 将已通过预检的任务登记为活动任务；返回不可变快照。 */
    registerActiveTask({ parentId, parentAgent, role, taskKey, description, affectedPaths, childId } = {}) {
      const task = {
        id: "activity-" + (++activeTaskSeq),
        parentId: String(parentId ?? ""),
        ...(parentAgent !== void 0 ? { parentAgent } : {}),
        role: String(role ?? ""),
        taskKey: String(taskKey ?? ""),
        description: typeof description === "string" ? description : "",
        affectedPaths: normalizeAffectedPaths(affectedPaths),
        ...(typeof childId === "string" && childId.length > 0 ? { childId } : {}),
        // 新登记的活动项仍由当前 root generation 持有；只有 dropParent（root 销毁/
        // 代际退休）会把它转为 detached，且转换本身**不**释放保护。
        detached: false,
      };
      activeTasks.set(task.id, task);
      return copyActiveTask(task);
    },

    /**
     * 在 child/message admission 已知时回填活动登记。messageId 是独立于任务
     * fingerprint 与 record.tasks 的稳定终态关联：两者被 TTL/LRU 淘汰后，turn/end
     * 仍可按 childId + messageId 精确完成这一个活动任务。
     */
    bindActiveTask(activityId, childId, messageId) {
      const task = activeTasks.get(activityId);
      if (task === void 0) return false;
      if (typeof childId === "string" && childId.length > 0) task.childId = childId;
      if (typeof messageId === "string" && messageId.length > 0) task.messageId = messageId;
      return typeof task.childId === "string" && task.childId.length > 0;
    },

    /**
     * inbox claim 早于 admission 返回时，按 taskKey 只补回第一个尚未拥有稳定
     * messageId 的活动项。Map 保持插入序：同 child 同 key 的旧任务已绑定 m_old
     * 时绝不覆盖它；一个 claimed message 也不能绑定多个活动项。
     */
    bindActiveTasksByTaskKey({ parentId, role, childId, taskKey, messageId } = {}) {
      if (typeof childId !== "string" || childId.length === 0 || typeof taskKey !== "string" || typeof messageId !== "string" || messageId.length === 0) return 0;
      for (const task of activeTasks.values()) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.childId !== childId || task.taskKey !== taskKey) continue;
        if (typeof task.messageId === "string" && task.messageId.length > 0) continue;
        task.messageId = messageId;
        return 1;
      }
      return 0;
    },

    /** 返回本 turn 命中的活动 id，供恢复 op 在原绑定被淘汰后仍保留终态关联。 */
    activeTaskIdsForTurn(options) {
      return matchingActiveTaskIdsForTurn(options);
    },

    /** 通过稳定活动 id 终态清理，避免同 child 的其他活动任务被误删。 */
    completeActiveTasksByIds(activityIds) {
      let count = 0;
      for (const activityId of stringSet(activityIds)) {
        if (activeTasks.delete(activityId)) count += 1;
      }
      return count;
    },

    /** 按 childId + turn message ids（taskKey 仅辅助）终态清理命中的活动项。 */
    completeActiveTasksForTurn(options) {
      let count = 0;
      for (const activityId of matchingActiveTaskIdsForTurn(options)) {
        if (activeTasks.delete(activityId)) count += 1;
      }
      return count;
    },

    /** 释放尚未 admission 成功的活动登记，避免失败请求留下永久冲突。 */
    releaseActiveTask(activityId) {
      return activeTasks.delete(activityId);
    },

    /** 按任务终态移除精确的活动登记；childId 可选以保护旧 route 的迟到事件。 */
    completeActiveTask({ parentId, role, taskKey, childId } = {}) {
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "") || task.taskKey !== String(taskKey ?? "")) continue;
        if (childId !== void 0 && task.childId !== childId) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /**
     * child 或其恢复记录被确定清理时移除该 child 的全部活动登记。
     *
     * owner 过滤语义（票据 07）：只有当两边都能给出 owner 且**不是同一个**时才拒绝。
     * detached 活动项的 parentAgent 已被移除，它表示「原 root 已销毁/退休，但该 child
     * 未必停止」，绝不能据此当成「属于别的 generation」而永久拒绝释放——否则权威
     * child 停止证据（disposal）到达后保护永远无法解除。
     */
    completeActiveTasksForChild(childId, parentId, parentAgent) {
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.childId !== childId || (parentId !== void 0 && task.parentId !== String(parentId))) continue;
        if (parentAgent !== void 0 && task.parentAgent !== void 0 && task.parentAgent !== parentAgent) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /**
     * 只读计数：活动范围总数与其中已脱离 root 的数量（运行时诊断用）。
     * @returns {{total:number, detached:number}}
     */
    activeTaskCounts() {
      let detached = 0;
      for (const task of activeTasks.values()) {
        if (task.detached === true) detached += 1;
      }
      return { total: activeTasks.size, detached };
    },

    /**
     * 只读诊断：列出已脱离 root 的活动范围。
     *
     * 刻意不返回 parentAgent、description、prompt 或 affectedPaths 原文：这里只回答
     * 「哪个 child/角色/任务仍持有保护、是否已脱离 root」，供诊断与人工排查使用。
     * @returns {Array<object>} 脱挂活动项摘要（含 activityId / parentId / role / taskKey / childId / messageId）。
     */
    listDetachedActiveTasks() {
      const result = [];
      for (const task of activeTasks.values()) {
        if (task.detached !== true) continue;
        result.push({
          activityId: task.id,
          parentId: task.parentId,
          role: task.role,
          taskKey: task.taskKey,
          ...(typeof task.childId === "string" ? { childId: task.childId } : {}),
          ...(typeof task.messageId === "string" ? { messageId: task.messageId } : {}),
          detached: true,
        });
      }
      return result;
    },

    /**
     * 释放「已脱离 root」的活动范围——root 销毁/代际退休后唯一可用的证据入口。
     *
     * 证据边界（票据 07）：
     * - 提供非空 turnMsgIds：只释放该 child 本 turn 稳定 messageId 命中的活动项
     *   （child turn/end 证据）；
     * - 省略/空 turnMsgIds：释放该 child 的全部 detached 活动项（权威 child disposal）。
     * 未绑定 messageId 的活动项（admission 竞态）不会被 turn/end 误删，只在 disposal
     * 或后续 turn 的 messageId 命中时释放。
     * @param {string} childId - exact child session id。
     * @param {{turnMsgIds?: Iterable<string>}} [options] - 本 turn 的稳定消息 id 集合。
     * @returns {number} 实际释放条数。
     */
    completeDetachedActiveTasksForChild(childId, { turnMsgIds } = {}) {
      if (typeof childId !== "string" || childId.length === 0) return 0;
      const messageIds = stringSet(turnMsgIds);
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.detached !== true || task.childId !== childId) continue;
        if (messageIds.size > 0 && (typeof task.messageId !== "string" || !messageIds.has(task.messageId))) continue;
        activeTasks.delete(activityId);
        count += 1;
      }
      return count;
    },

    /**
     * 重建或 followup recovery 后把相关活动项改绑到替代 child/恢复消息。优先
     * 使用 recovery op 保存的 activityIds；taskKeys 仅兼容旧记录或早期竞态。
     */
    rebindActiveTasks({ parentId, role, oldChildId, newChildId, messageId, taskKeys, activityIds } = {}) {
      const keys = stringSet(taskKeys);
      const ids = stringSet(activityIds);
      let count = 0;
      for (const [activityId, task] of activeTasks) {
        if (task.parentId !== String(parentId ?? "") || task.role !== String(role ?? "")) continue;
        if (task.childId !== oldChildId || (!ids.has(activityId) && !keys.has(task.taskKey))) continue;
        task.childId = newChildId;
        if (typeof messageId === "string" && messageId.length > 0) task.messageId = messageId;
        count += 1;
      }
      return count;
    },

    /** 为 node:test 和可观测告警提供当前父代理的活动任务快照。 */
    listActiveTasks(parentId) {
      return activeTasksForParent(parentId).map(copyActiveTask);
    },

    /**
     * 读取本 scope 最近一次新建/恢复的 child（诊断、route 判定与快照恢复用）。
     * **不是**「本 scope 唯一 child」：独立任务可能同时存在多个 child，按任务
     * 定位必须使用 getTaskChild / listChildIds。
     */
    getChild(scope) {
      const entry = scopes.get(scope);
      if (entry === void 0 || entry.childId === void 0) return void 0;
      return { childId: entry.childId, routeKey: entry.routeKey };
    },

    /**
     * 记录 scope 最近一次新建/恢复的 child 与其 route。
     *
     * 任务记忆的清理规则（多 child 语义）：只删除「属于被替换 child」或「route 与
     * 新 route 不同」的任务标记——同一 route 下并存的其他独立 child 仍必须能被
     * 相同 prompt 复用，因此普通的新建 child **不得**清空整张任务表。
     */
    setChild(scope, { childId, routeKey }) {
      const entry = entryOf(scope);
      const sameRoute = entry.routeKey === routeKey;
      const replacedChildId = entry.childId;
      if (replacedChildId !== childId || !sameRoute) {
        for (const [taskKey, record] of [...entry.tasks]) {
          const owner = taskRecordChildId(record);
          const ownerRoute = typeof record?.routeKey === "string" ? record.routeKey : void 0;
          // 保留条件一：仍绑定到本 route 上某个具体 child —— 同 route 下并存的其他
          // 独立 child（以及被替换 child 自己的任务）都必须能被相同 prompt 复用。
          if (owner !== void 0 && ownerRoute === routeKey) continue;
          // 保留条件二：同 route 且绑定信息不完整（旧格式/旧写入点）—— route 没有变化，
          // 旧语义的任务去重仍然成立。
          if (sameRoute && ownerRoute === void 0) continue;
          // 其余情况（route 已变、或记录指向别的不再可验证的 child）一律清理。
          entry.tasks.delete(taskKey);
        }
      }
      entry.childId = childId;
      entry.routeKey = routeKey;
      return entry;
    },

    /**
     * 读取某任务 key 当前绑定的 child；无绑定、已过期或格式非法时返回 undefined。
     * 相同 prompt（归一化后同一 key）据此复用**它自己的** child，而不是本 scope
     * 最近一次新建的 child。
     */
    getTaskChild(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return void 0;
      const record = entry.tasks.get(taskKey);
      if (record === void 0) return void 0;
      if (now() - taskRecordAt(record) >= taskTtlMs) {
        entry.tasks.delete(taskKey);
        return void 0;
      }
      const childId = taskRecordChildId(record);
      if (childId === void 0) return void 0;
      return {
        childId,
        routeKey: typeof record?.routeKey === "string" ? record.routeKey : void 0,
      };
    },

    /** 列出本 scope 记录到的全部 child（诊断/多 child 展示；去重且保持记忆顺序）。 */
    listChildIds(scope) {
      const entry = scopes.get(scope);
      if (entry === void 0) return [];
      const ids = [];
      const seen = new Set();
      if (typeof entry.childId === "string" && entry.childId.length > 0) {
        ids.push(entry.childId);
        seen.add(entry.childId);
      }
      for (const record of entry.tasks.values()) {
        const childId = taskRecordChildId(record);
        if (childId === void 0 || seen.has(childId)) continue;
        seen.add(childId);
        ids.push(childId);
      }
      return ids;
    },

    /** 清除 scope 的 child 记录（可指定 childId：不匹配时不动）；返回是否清除。 */
    clearChild(scope, childId) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      if (childId !== void 0 && entry.childId !== childId) return false;
      scopes.delete(scope);
      return true;
    },

    /**
     * 该 scope 是否已记录过这个（归一化后的）任务 key；过期记录惰性删除。
     * 任务被记住但没有 child 绑定时同样返回 true（旧格式记录/旧语义）。
     */
    hasTask(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      const record = entry.tasks.get(taskKey);
      if (record === void 0) return false;
      // 超过 TTL 的记录视为过期：删除并返回 false，相同 prompt 到期后可再次复用
      // （例如用户修复问题后重试同一任务，不再被永久判为重复）。
      if (now() - taskRecordAt(record) >= taskTtlMs) {
        entry.tasks.delete(taskKey);
        return false;
      }
      return true;
    },

    /**
     * 记住任务 key（LRU：重复记忆刷新位置；超上限淘汰最旧）。值记录记住时刻、
     * 本任务绑定的 child 与 route，供 TTL 判断、相同 prompt 复用与 route 变更清理。
     * childId/routeKey 缺省时只记时间（沿用旧的 scope 级去重语义）。
     */
    rememberTask(scope, taskKey, { childId, routeKey } = {}) {
      const entry = entryOf(scope);
      const previous = entry.tasks.get(taskKey);
      const binding = { at: now() };
      // 未显式给出 child/route 时保留既有绑定（重复记忆只刷新时间，不丢归属）。
      const boundChildId = typeof childId === "string" && childId.length > 0 ? childId : taskRecordChildId(previous);
      if (boundChildId !== void 0) binding.childId = boundChildId;
      const boundRouteKey = typeof routeKey === "string" && routeKey.length > 0
        ? routeKey
        : (typeof previous?.routeKey === "string" ? previous.routeKey : void 0);
      if (boundRouteKey !== void 0) binding.routeKey = boundRouteKey;
      if (entry.tasks.has(taskKey)) entry.tasks.delete(taskKey);
      entry.tasks.set(taskKey, binding);
      while (entry.tasks.size > taskLimit) {
        const oldest = entry.tasks.keys().next().value;
        entry.tasks.delete(oldest);
      }
    },

    /**
     * 忘记某 scope 的某个任务 key（任务确定失败后调用）：该任务可重新排队/新建，
     * 而不是在 TTL 窗口内被永久判为 reused。不影响 child 记录与其他任务。
     * @returns {boolean} 确实存在并删除了返回 true；未知 key 返回 false。
     */
    forgetTask(scope, taskKey) {
      const entry = scopes.get(scope);
      if (entry === void 0) return false;
      return entry.tasks.delete(taskKey);
    },

    /**
     * 父代理销毁/root 代际退休时清理 scope 与短队列，但**不释放**影响范围保护（票据 07）。
     *
     * root 结束、代际更新都不是停止证据：活动项保留并标记 detached、移除 parentAgent
     * 强引用（parentId 保留），继续按同一 parentId 阻塞同路径新任务，直到该 child 自己的
     * 权威停止信号（child turn/end 或 child disposal）经 completeActiveTasksForTurn /
     * completeActiveTasksForChild / completeDetachedActiveTasksForChild 删除。
     *
     * 这样做避免「root 结束即释放」把仍在运行的 child 写入范围暴露给 root 的结构化文件
     * 工具；保护可观测性由 listDetachedActiveTasks / activeTaskCounts 提供。
     * @param {string} parentId - 正在销毁/退休的父代理 id（同 id 新 generation 不继承释放）。
     */
    dropParent(parentId) {
      const id = String(parentId);
      const prefix = `${id}::`;
      for (const scope of scopes.keys()) {
        if (scope.startsWith(prefix)) scopes.delete(scope);
      }
      for (const task of activeTasks.values()) {
        if (task.parentId !== id) continue;
        detachActiveTask(task);
      }
      parentQueues.delete(id);
    },
  };
}

/**
 * 子代理容量耗尽的稳定错误码（DSH 0.1.7-alpha.2 新增的进程内容量上限）。
 *
 * 宿主用一套 `maxActiveSubagents` 名额约束「共享不间断 continuable 父链」的存活 child
 * 数量；名额耗尽时**接纳不排队**（等待后代的父代理不能又等自己占用的名额），
 * 直接拒绝新的新建/冷恢复。
 *
 * 同一语义会以**两种形态**到达 DEG，必须都覆盖：
 * - `ACTIVATION_LIMIT_REACHED`：进程内公开服务（startContinuable / sendMessage 的冷恢复、
 *   重建路径）抛出的原始码；
 * - `subagent/delivery-unavailable`：宿主 Remote 控制面（浏览器 prompt / interrupt）
 *   把 DRAINING / ACTIVATION_CLOSING / **ACTIVATION_LIMIT_REACHED** /
 *   CONTINUATION_UNAVAILABLE / PERSISTENCE_UNAVAILABLE 统一折叠后的包装码。
 *
 * 列表里还包含 DEG 自己的 `SUBAGENT_CAPACITY_REACHED`：翻译后的错误可能再次经过
 * 上层分类（例如 steer 抛给工具 admission 分类），识别必须**幂等**，否则已翻译的
 * 容量错误会在第二次判定时丢失结构化身份。
 *
 * ⚠ `subagent/delivery-unavailable` **不是**容量专属：它还覆盖 DRAINING 等不可回落
 * 情形，因此它只在「调用点上下文已排除排空/权限语义」时才按容量处置（见
 * {@link isSubagentCapacityError} 的 `assumeCapacity` 选项），绝不单独作为回落依据。
 */
export const SUBAGENT_CAPACITY_ERROR_CODES = Object.freeze([
  "ACTIVATION_LIMIT_REACHED",
  "SUBAGENT_CAPACITY_REACHED",
]);

/**
 * 容量耗尽时面向用户的可读提示。
 *
 * 语义与宿主发布说明一致：等待子代理完成，或继续使用现有子代理。刻意不写死具体名额
 * 数值——默认值（8）是宿主配置项，可被用户改，写死会立刻过期。也不回显原始错误码。
 */
export const SUBAGENT_CAPACITY_MESSAGE =
  "已达到同时运行的子代理数量上限；请等待现有子代理完成，或继续使用当前已有的子代理";

/**
 * 判断错误是否表示子代理容量耗尽（纯函数）。
 *
 * 只接受结构化 code 的**精确**匹配：`ACTIVATION_LIMIT_REACHED` 是原始码；
 * `subagent/delivery-unavailable` 只有在调用方显式声明该上下文已排除排空/权限
 * 语义时才按容量处置（`options.assumeCapacity === true`），否则返回 false，
 * 避免把 DRAINING 之类的不可回落错误伪装成可等待。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - `{assumeCapacity}`：该调用点是否已排除非容量语义。
 * @returns {boolean} 容量耗尽返回 true。
 */
export function isSubagentCapacityError(error, options = {}) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (SUBAGENT_CAPACITY_ERROR_CODES.includes(code)) return true;
  return options?.assumeCapacity === true && code === "subagent/delivery-unavailable";
}

/**
 * 把容量耗尽错误翻译成面向用户的可读结果（纯函数）。
 *
 * 返回 `{ code, message, retryable }`：容量耗尽是**可重试**的暂态条件（等某个子代理
 * 结束后同一请求即可成功），因此 `retryable` 为 true，供调用方决定是否保留重试预算。
 * 非容量错误返回 undefined，调用方据此保持既有上抛/重建语义。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - 透传给 {@link isSubagentCapacityError}。
 * @returns {{code:string, message:string, retryable:boolean}|undefined}
 */
export function describeSubagentCapacityFailure(error, options = {}) {
  if (!isSubagentCapacityError(error, options)) return undefined;
  return {
    // 稳定的自有 code：不转发宿主原始码，避免调用方重新依赖已折叠的宿主细节。
    code: "SUBAGENT_CAPACITY_REACHED",
    message: SUBAGENT_CAPACITY_MESSAGE,
    retryable: true,
  };
}

/**
 * 构造一个携带 DEG 自有稳定 code 的容量耗尽错误。
 *
 * 用于「向用户抛出可读提示」的调用点：既保留结构化 code（供上层分类表识别并保持
 * 可重试语义），又不把宿主原始错误码/英文文案泄漏到用户可见文本里。非容量错误
 * 返回 undefined，调用方据此保持原样上抛。
 *
 * @param {object} [error] - 宿主抛出的错误。
 * @param {object} [options] - 透传给 {@link isSubagentCapacityError}。
 * @returns {Error|undefined}
 */
export function createSubagentCapacityError(error, options = {}) {
  const described = describeSubagentCapacityFailure(error, options);
  if (described === undefined) return undefined;
  const capacityError = new Error(described.message);
  capacityError.name = "SubagentCapacityError";
  capacityError.code = described.code;
  capacityError.retryable = described.retryable;
  return capacityError;
}

/**
 * 判断 ordinary interrupt 失败后是否可以安全继续 manager sendMessage（纯函数）。
 * 只有目标 Activation 已进入关闭/不可恢复状态时才回落；这类失败表示 live
 * direct cancel 已失去意义，manager sendMessage 仍可负责 cold admission。
 * UNAUTHORIZED（父 authority/lineage 不匹配）、DRAINING、AbortError、容量耗尽
 * 与未知错误必须原样抛出，不能把权限、取消或容量错误伪装成成功回落——
 * 容量耗尽时 sendMessage 的冷恢复同样会被拒绝，回落只会立刻再次失败。
 * @param {object} [error] - interrupt 抛出的错误。
 * @returns {boolean} 允许继续 sendMessage 时返回 true。
 */
export function interruptFailureCanFallback(error) {
  if (isSubagentCapacityError(error)) return false;
  return error?.code === "ACTIVATION_CLOSING" || error?.code === "NOT_RESUMABLE";
}

// ── 自动恢复（自愈监督）：纯函数判定 ────────────────────────────────────────

/**
 * 同一 child 连续自动恢复次数上限：同一 child 连续失败/空返回时，插件最多自动
 * 发送 5 次「继续执行」指令；超过后不再自动恢复，任务记录转为确定失败。
 */
export const AUTO_RECOVERY_LIMIT = 5;

/**
 * 给确定的恢复投递失败追加真实累计次数。所有 failPendingRecoveryOp 分支使用
 * 它，因此父不可用、sendMessage/rebuild reject 与无效 messageId 不会丢失重试
 * 上下文；已经含有该片段时保持幂等，避免嵌套错误路径重复拼接。
 */
export function appendRecoveryRetryCount(message, recoveryCount) {
  const text = typeof message === "string" && message.length > 0 ? message : "自动恢复失败";
  const count = Number.isSafeInteger(recoveryCount) && recoveryCount > 0 ? recoveryCount : 0;
  if (count === 0 || /已自动重试\s+\d+\s+次/.test(text)) return text;
  return text + "；已自动重试 " + count + " 次";
}

/**
 * record.tasks 任务绑定表上限（S2）：超过后按 Map 插入序淘汰最旧。
 * 任务绑定用于成功输出缓存与确定失败记录；64 条足以覆盖
 * 一个 child 生命周期内的活跃任务，防止长期运行内存增长。
 */
export const TASK_BINDING_LIMIT = 64;

/**
 * record.claimed 认领映射上限（S2）：超过后按 Map 插入序淘汰最旧。
 * 认领映射只用于「消息被 inbox 认领但 user/message 未落盘」的归属兜底，
 * 512 条覆盖长时间运行的全部活跃消息，淘汰极旧的条目不影响新归属判定。
 */
export const CLAIMED_LIMIT = 512;

/**
 * record.processedFeedbackMessageIds 上限：父 inbox settlement 的 message.id 去重账本。
 *
 * 与 CLAIMED_LIMIT 的关键差别：这里**不做插入序淘汰**。淘汰会让一条迟到副本重新变成
 * 「新 settlement」并消费后续轮次的 token（审核缺陷 A1）；因此达到上限后改为 fail-closed
 * 饱和：不再记录新 id，并置 record.feedbackIdentitySaturated，使没有稳定身份的
 * settlement 只能走保守路径（不得立即消费已结束的 turn group）。饱和需要同一 child
 * 记录累计 4096 条 settlement，属于不可达的极端值，只作为资源上界存在。
 */
export const FEEDBACK_DELIVERY_LIMIT = 4096;

/**
 * 父 inbox settlement 身份账本（A1 的可测纯状态机）。
 *
 * 语义：
 * - `claim(id)` 对同一 id 的第二次调用返回 duplicate=true（副本必须完全跳过消费/排队）；
 * - **永不淘汰**已记账 id：淘汰会让迟到副本重新变成新 settlement；
 * - 达到 limit 后进入饱和：不再记账、`saturated` 置 true，之后 claim 返回
 *   `{duplicate:false, unproven:true}`，调用方必须走保守路径（不提前 resume）。
 *
 * 生命周期：由调用方（index.js 的 child recovery record）持有，record 被 drop/owner
 * 变更时随之丢弃。message.id 是 DSH 为每条消息新铸的 UUID，不存在「同 id 被合法复用
 * 为下一轮真实 settlement」的情况，因此在 record 生命周期内保留 id 是可证明完备的。
 *
 * @param {{limit?:number}} [options] - 记账上限（资源上界，不是安全边界）。
 * @returns {{claim:(id:string)=>{duplicate:boolean,unproven:boolean}, size:number, saturated:boolean}}
 */
export function createFeedbackIdentityLedger({ limit } = {}) {
  const cap = Number.isSafeInteger(limit) && limit > 0 ? limit : FEEDBACK_DELIVERY_LIMIT;
  const ids = new Set();
  let saturated = false;
  return {
    claim(id) {
      if (typeof id !== "string" || id.length === 0) return { duplicate: false, unproven: true };
      if (ids.has(id)) return { duplicate: true, unproven: false };
      if (saturated || ids.size >= cap) {
        saturated = true;
        return { duplicate: false, unproven: true };
      }
      ids.add(id);
      return { duplicate: false, unproven: false };
    },
    get size() { return ids.size; },
    get saturated() { return saturated; },
  };
}

/**
 * 把 Map 裁剪到上限（S2 资源上限）：超过 limit 时按插入序删除最旧条目。
 * 就地修改并返回被删除的 key 列表；limit 非正整数或输入非法视为不裁剪。
 * @param {Map} map - 目标 Map（record.tasks / record.claimed）。
 * @param {number} limit - 上限条数。
 * @returns {Array} 被淘汰的 key 列表。
 */
export function evictOldestEntries(map, limit) {
  const removed = [];
  if (!(map instanceof Map) || !Number.isSafeInteger(limit) || limit < 0) return removed;
  while (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest === void 0) break;
    map.delete(oldest);
    removed.push(oldest);
  }
  return removed;
}

/**
 * 收集某 turn 内所有 assistant/message 事件中的非空文本块。
 * 纯函数：只依赖事件日志结构（{type:"assistant/message", data:{turn, message:{content}}}），
 * 不依赖 DOM / Node 服务。
 * @param {Array} events - session.events（不可变事件日志）。
 * @param {number} turn - turn 号。
 * @returns {Array<{type:"text", text:string}>} 该 turn 的非空文本块（保持出现顺序）。
 */
export function turnTextBlocks(events, turn) {
  const blocks = [];
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return blocks;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    if (event?.data?.turn !== turn) continue;
    const content = event?.data?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      // 纯空白文本不算有效输出：trim 后为空则跳过。
      if (block?.type === "text" && typeof block?.text === "string" && block.text.trim().length > 0) {
        blocks.push({ type: "text", text: block.text });
      }
    }
  }
  return blocks;
}

/**
 * 某 turn 内是否有非空 assistant 文本输出（「空返回」判定）。
 * @param {Array} events - session.events。
 * @param {number} turn - turn 号。
 * @returns {boolean} 有非空文本输出返回 true。
 */
export function turnHasNonEmptyText(events, turn) {
  return turnTextBlocks(events, turn).length > 0;
}

/**
 * 读取一条 user/message 事件的消息 id。
 * 生产 DSH 契约是 SessionEventMap['user/message'] = UserMessage：id/role/content/
 * source **平铺在 event.data 上**，因此必须优先读 event.data.id。历史日志与旧测试
 * 夹具曾把消息包在 event.data.message 里，保留该形状作为回退（只在平铺 id 缺失或
 * 为空串时使用），避免回归旧数据；两种形状都没有可用字符串 id 时返回 undefined。
 * 注意：这里只读取 id，不改变 assistant/message（其 payload 确实是
 * { turn, step, message }）与 tool/result 的既有语义。
 * @param {object} [event] - 单条 SessionEvent。
 * @returns {string|undefined} 可用消息 id。
 */
function messageIdOfEvent(event) {
  const data = event?.data;
  if (data === null || typeof data !== "object") return void 0;
  if (typeof data.id === "string" && data.id.length > 0) return data.id;
  const legacy = data.message;
  if (legacy !== null && typeof legacy === "object"
    && typeof legacy.id === "string" && legacy.id.length > 0) return legacy.id;
  return void 0;
}

/**
 * 收集某 turn 内所有 user/message 的消息 id。
 * 用于按消息归属判定 turn：turn/end 的 data.reason 不携带消息 id，需要回看该
 * turn 的 user/message 事件才能确认「这个 turn 是哪次委派/恢复指令触发的」。
 * 读到的 id 直接决定活动 affectedPaths 的终态释放能否命中本 turn：拿不到 id 时
 * rootStructuredPathGuard 会永久阻塞与已结束专家任务重叠的 root 结构化文件操作。
 * @param {Array} events - session.events。
 * @param {number} turn - turn 号。
 * @returns {Set<string>} 该 turn 内的消息 id 集合。
 */
export function messageIdsOfTurn(events, turn) {
  const ids = new Set();
  if (!Array.isArray(events) || !Number.isSafeInteger(turn)) return ids;
  let started = false;
  for (const event of events) {
    if (event?.type === "turn/start") {
      if (event?.data?.turn === turn) started = true;
      else if (started) break; // 已越过该 turn 的边界（turn/start 按 turn 号顺序追加）
      continue;
    }
    if (started && event?.type === "user/message") {
      const id = messageIdOfEvent(event);
      if (id !== void 0) ids.add(id);
    }
  }
  return ids;
}

/**
 * 某 turn 的消息 id 归属：事件日志中的 user/message 与 claimed 认领映射
 * （message.id -> turn）的**并集**。claimed 覆盖「消息已被 inbox 认领但
 * user/message 未落盘」的缺口（pre-step reject / 取消 / 异常），保证消息
 * 恢复 op 完结与任务绑定都能找到归属（B2 路径 B）。
 * @param {Map<string, number>} [claimed] - message.id -> turn 认领映射。
 * @param {Array} [events] - session.events。
 * @param {number} turn - turn 号。
 * @returns {Set<string>} 该 turn 的消息 id 集合。
 */
export function messageIdsOfTurnWithClaimed(claimed, events, turn) {
  const ids = messageIdsOfTurn(events, turn);
  if (claimed instanceof Map && Number.isSafeInteger(turn)) {
    for (const [messageId, claimedTurn] of claimed) {
      if (claimedTurn === turn && typeof messageId === "string") ids.add(messageId);
    }
  }
  return ids;
}

/**
 * 提取消息 content 中的文本块拼接（S1-D claimed 补绑按任务文本匹配用）。
 * 与 turnTextBlocks 同构：只取 {type:"text", text} 块，保持出现顺序。
 * @param {object} [message] - user 消息（含 content 块数组）。
 * @returns {string} 拼接后的文本。
 */
export function messageTextOf(message) {
  const blocks = message?.content;
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block?.text === "string")
    .map((block) => block.text)
    .join("");
}

/**
 * 恢复消息 id 的 claimed 占位写入（P2）：manager 投递成功后把
 * message.id -> null 记入 claimed 占位（null = 尚未绑定 turn，后续
 * agent/inbox/claimed 用真实 turn 覆盖）。
 * **已有条目绝不覆盖**：promise resolve 可能晚于 inbox 认领事件，若已写入
 * 真实 turn，直接 set(null) 会把真实归属抹掉——先查 has 再写。
 * @param {Map<string, number|null>} claimed - message.id -> turn 认领映射。
 * @param {string} messageId - 恢复消息 id。
 * @returns {boolean} 确实写入占位返回 true；已存在条目（不覆盖）或非法输入返回 false。
 */
export function rememberClaimedPlaceholder(claimed, messageId) {
  if (!(claimed instanceof Map) || typeof messageId !== "string" || messageId.length === 0) return false;
  if (claimed.has(messageId)) return false;
  claimed.set(messageId, null);
  return true;
}

/**
 * claimed 补绑 pendingMessage 任务（S1-D 任务 binding 的 acceptance 竞态）：
 * 当 claimed 消息 id 在 record.tasks 中找不到 binding 时（正常路径的
 * steer/startContinuable admission 回调晚于 inbox 认领事件），用消息文本
 * 的归一化任务 key 匹配 binding 表中「pendingMessage === true 且
 * messageId === null」的项；匹配则回填 binding.messageId = claimed 消息 id
 * 并清 pendingMessage。只处理待回填的项，已确定的绑定绝不被覆盖。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {object} [message] - 被 inbox 认领的消息（含 id 与 content 文本块）。
 * @returns {boolean} 发生补绑返回 true。
 */
export function rebindPendingTaskByClaimed(tasks, message) {
  if (!(tasks instanceof Map) || message === null || typeof message !== "object") return false;
  const messageId = message.id;
  if (typeof messageId !== "string" || messageId.length === 0) return false;
  // 消息 id 已落在某个 binding 上：正常路径已回填，无需补绑。
  for (const binding of tasks.values()) {
    if (binding?.messageId === messageId) return false;
  }
  const taskKey = delegationTaskKey(messageTextOf(message));
  if (taskKey.length === 0) return false;
  const binding = tasks.get(taskKey);
  if (binding === void 0 || binding.pendingMessage !== true || binding.messageId !== null) return false;
  binding.messageId = messageId;
  binding.pendingMessage = false;
  return true;
}

/**
 * forgetTask 的 child 身份保护判定（P5）：仅当 scope 当前记录的 child 与
 * record 的 childId 一致时才允许 forget——旧 route child 的迟到失败不得
 * 删除新 route 同名任务指纹（route 切换后 delegationTracker 的 child 已
 * 换成新 child，tasks 记录也已清空重建）。
 * @param {string|undefined} currentChildId - delegationTracker.getChild(scope) 的 childId。
 * @param {string|undefined} recordChildId - 恢复记录所属 child 的 session id。
 * @returns {boolean} childId 一致（且 recordChildId 非空）返回 true。
 */
export function shouldForgetTask(currentChildId, recordChildId) {
  return typeof recordChildId === "string" && recordChildId.length > 0 && currentChildId === recordChildId;
}

/**
 * 收集一个 turn 应结算的任务 key：恢复 op 继承的 taskKeys 与消息 id 反查结果
 * 取并集。handleChildTurnEnd 用它清理活动范围登记，applyTurnToTasks 用同一
 * 规则回写绑定，避免恢复消息替换原消息 id 后丢失原任务归属。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Set<string>} [turnMsgIds] - 该 turn 的消息 id 并集。
 * @param {Array|Set} [taskKeys] - 恢复 op 继承的原任务 key。
 * @returns {Array<string>} 去重后的命中任务 key。
 */
export function taskKeysForTurn(tasks, turnMsgIds, taskKeys) {
  const targets = new Set();
  if (taskKeys !== void 0 && taskKeys !== null) {
    for (const key of taskKeys) {
      if (typeof key === "string") targets.add(key);
    }
  }
  if (tasks instanceof Map && turnMsgIds instanceof Set) {
    for (const [key, binding] of tasks) {
      if (typeof binding?.messageId === "string" && turnMsgIds.has(binding.messageId)) targets.add(key);
    }
  }
  return [...targets];
}

/**
 * 把一次 turn/end 的结局回写到任务绑定表（S1-C，B3 任务绑定跨恢复链传播）。
 * handleChildTurnEnd 与恢复失败收口共用本纯函数：
 * - outcome === "success"：命中绑定写入 outcome:"success" 与 blocks（该 turn
 *   的非空文本块），messageId 保留原消息 id（供 reused 识别原任务）；
 * - outcome === "failed"：命中绑定写入 outcome:"failed" 与 failureMessage
 *   （确定失败，含恢复链达上限），返回被写终态的 taskKey 列表——调用方据此
 *   delegationTracker.forgetTask（相同 prompt 可重新排队而非永久 reused）；
 * - outcome === "recoverable"：不写终态（恢复链继续，由调用方创建新 op 并
 *   继承 taskKeys，不要丢）。
 * 命中范围：显式 taskKeys（恢复 turn 经 op 继承的原任务 key）∪ 按 turnMsgIds
 * 反查 binding.messageId 的项；taskKeys 缺省时仅按 turnMsgIds 反查。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Array} [events] - session.events（成功时取输出文本块）。
 * @param {number} turn - turn 号。
 * @param {Set<string>} [turnMsgIds] - 该 turn 消息 id 并集（事件 ∪ claimed）。
 * @param {"success"|"failed"|"recoverable"} outcome - 任务结局。
 * @param {object} [reason] - turn/end 的 data.reason（failureMessage 缺省兜底）。
 * @param {string} [failureMessage] - 确定失败的完整错误文案（调用方已格式化）。
 * @param {Array|Set} [taskKeys] - 恢复 op 继承的任务 key 列表（可选）。
 * @returns {Array<string>} 被写为确定失败的 taskKey 列表（调用方 forgetTask）。
 */
export function applyTurnToTasks(tasks, events, turn, turnMsgIds, outcome, reason, failureMessage, taskKeys) {
  const written = [];
  if (!(tasks instanceof Map) || (outcome !== "success" && outcome !== "failed")) return written;
  // 与活动范围终态清理共用同一归属规则，避免恢复消息换 id 后失去原任务 key。
  const targets = taskKeysForTurn(tasks, turnMsgIds, taskKeys);
  if (outcome === "success") {
    const blocks = turnTextBlocks(events, turn);
    for (const key of targets) {
      const binding = tasks.get(key);
      if (binding === void 0 || typeof binding !== "object") continue;
      binding.outcome = "success";
      binding.blocks = blocks;
    }
  } else {
    const message = typeof failureMessage === "string" && failureMessage.length > 0
      ? failureMessage
      : `subagent run failed${reason?.kind !== void 0 ? ` (${String(reason.kind)})` : ""}`;
    for (const key of targets) {
      const binding = tasks.get(key);
      if (binding === void 0 || typeof binding !== "object") continue;
      binding.outcome = "failed";
      binding.failureMessage = message;
      written.push(key);
    }
  }
  return written;
}

/**
 * 将尚未投递的自动恢复任务标记为被新任务取代（纯函数契约）：
 * - 只处理显式 taskKeys，保持恢复 op 的任务归属，不触碰消息/事件日志；
 * - 写入明确的 outcome:"superseded" 与 failureMessage，供后续复用识别；
 * - 将 pendingMessage 清除，防止迟到 claimed 事件重新绑定已失效任务。
 * @param {Map} tasks - taskKey -> binding 表。
 * @param {Array|Set} taskKeys - 要失效化的任务 key 集合。
 * @param {string} message - 面向任务记录的取代原因。
 * @returns {Array<string>} 实际写入为 superseded 的 taskKey 列表。
 */
export function supersedeTaskBindings(tasks, taskKeys, message) {
  const written = [];
  if (!(tasks instanceof Map) || taskKeys === void 0 || taskKeys === null) return written;
  for (const key of taskKeys) {
    if (typeof key !== "string") continue;
    const binding = tasks.get(key);
    if (binding === void 0 || typeof binding !== "object") continue;
    binding.outcome = "superseded";
    binding.failureMessage = typeof message === "string" && message.length > 0
      ? message
      : "task was superseded by a newer task";
    if (binding.pendingMessage === true) binding.pendingMessage = false;
    written.push(key);
  }
  return written;
}

/**
 * 只有 DSH 明确标注由根/父代理或用户发起的取消，才是用户意图明确的终态。
 * hook、disposed、legacy 或缺少来源的 aborted 都可能是宿主短暂故障，必须走
 * 自动继续而不是静默放弃原任务。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {boolean} 明确 parent/user 取消返回 true。
 */
export function hasExplicitParentOrUserCancellation(reason) {
  return reason?.kind === "aborted" && (reason?.reason?.kind === "parent" || reason?.reason?.kind === "user");
}

/**
 * DSH 结构化 turn/end 错误中明确不可通过自动 continuation 修复的错误码。
 * 未知 code 保持旧的 recoverable 策略；只有已知的认证、权限、配置、路由、
 * 非法请求和上下文限制错误才 fail-closed，绝不解析错误文本。
 */
export const PERMANENT_TURN_ERROR_CODES = Object.freeze([
  "AUTHORIZATION",
  "UNAUTHENTICATED",
  "ACCESS_DENIED",
  "PERMISSION",
  "PERMISSION_DENIED",
  "MISSING_CREDENTIAL",
  "INVALID_CREDENTIAL",
  "CONFIGURATION",
  "CONFIG_ERROR",
  "INVALID_CONFIGURATION",
  "INVALID_CONFIG",
  "INVALID_ARGUMENT",
  "INVALID_ARGS",
  "REQUEST_EXTENSION",
  "CONTEXT_WINDOW_EXCEEDED",
  "QUOTA",
  "ABORTED",
  "CANCELLED",
  "CANCELED",
]);

/**
 * 判断 turn/end 是否携带已知永久错误。只读取结构化 reason.error.code。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {boolean} 已知永久错误返回 true。
 */
export function isPermanentTurnError(reason) {
  if (reason?.kind !== "error" || reason?.error === null || typeof reason?.error !== "object") return false;
  if (typeof reason.error.code === "string" && PERMANENT_TURN_ERROR_CODES.includes(reason.error.code)) return true;
  return isPermanentPiAiFailure(reason.error);
}

/**
 * 一次 turn/end 的结局分类：
 * - "success"：completed 且有非空文本输出（成功，恢复计数清零）；
 * - "terminal"：明确 parent/user 取消，或结构化永久错误；
 * - "recoverable"：其他非成功结果，包括来源不明的 aborted、未知 code 的 error、
 *   max-tokens、空 completed、refusal、blocked、interrupted 与未知 kind。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @param {boolean} hasNonEmptyOutput - 该 turn 是否有非空 assistant 文本输出。
 * @returns {"success"|"recoverable"|"terminal"}
 */
export function classifyTurnOutcome(reason, hasNonEmptyOutput) {
  if (reason?.kind === "completed" && hasNonEmptyOutput === true) return "success";
  if (hasExplicitParentOrUserCancellation(reason) || isPermanentTurnError(reason)) return "terminal";
  return "recoverable";
}

/**
 * 判断原 child 无法继续时是否允许按既有安全边界重建。除明确 NOT_RESUMABLE、
 * child 已销毁或 route 已改变外，宿主、权限和显式取消错误必须保留原错误契约。
 *
 * 容量耗尽**不**允许重建：它表示进程名额已被占满，与 child 是否可用无关，
 * 重建只会立刻再次撞上限（并消耗一份本可用于其他角色的名额），因此必须显式排除。
 *
 * @param {object} [error] - sendMessage/start 失败。
 * @param {object} [state] - childDestroyed / routeChanged 状态。
 * @returns {boolean} 可以创建替代 continuable child 返回 true。
 */
export function shouldRebuildRecoveryChild(error, state = {}) {
  if (isSubagentCapacityError(error)) return false;
  return error?.code === "NOT_RESUMABLE" || state?.childDestroyed === true || state?.routeChanged === true;
}

/**
 * 重建 child 成功后是否可以把它写为当前 parent+role scope：无当前 child 的
 * cold-resume scope 与仍指向被替换 old child 的 scope 都应更新；已经被并发新任务
 * 安全替换成其他 child 时必须保持该新 child，不得覆盖。
 */
export function shouldInstallRebuiltChild(currentChildId, oldChildId) {
  return currentChildId === void 0 || currentChildId === oldChildId;
}

/**
 * startContinuable await 返回后的重建提交 guard。父销毁、插件卸载或 op 被终止
 * 时 record 已从 recoveryRecords 删除，迟到 child 绝不能重新插回记录或
 * 活动范围登记。controller abort 也表示这次 admission 的结果必须被丢弃。
 */
export function recoveryRebuildCanCommit(recoveryRecords, record, op) {
  return recoveryRecords instanceof Map
    && recoveryRecords.get(record?.childId) === record
    && recoveryOpIsPending(record?.pendingRecoveries, op)
    && !recoveryOpIsAccepted(op)
    && op?.controller?.signal?.aborted !== true;
}

/**
 * 是否需要自动恢复：任何非成功且非明确取消的结果，且未达到连续恢复上限。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @param {boolean} hasNonEmptyOutput - 该 turn 是否有非空 assistant 文本输出。
 * @param {number} recoveryCount - 该 child 当前的连续自动恢复次数。
 * @returns {boolean} 需要自动恢复返回 true。
 */
export function shouldAutoRecover(reason, hasNonEmptyOutput, recoveryCount) {
  if (classifyTurnOutcome(reason, hasNonEmptyOutput) !== "recoverable") return false;
  const count = Number.isSafeInteger(recoveryCount) && recoveryCount >= 0 ? recoveryCount : 0;
  return count < AUTO_RECOVERY_LIMIT;
}

/**
 * 自动恢复每次失败后的等待时长（毫秒）。索引从 1 开始，严格对应本次即将
 * 发出的恢复指令次数；超出预算或非法值返回 undefined，调用方应保守地终止
 * 该恢复而不是发出没有明确退避策略的第 6 次指令。
 */
export const RECOVERY_BACKOFF_DELAYS = Object.freeze([2000, 4000, 8000, 16000, 32000]);

export function recoveryDelayForCount(recoveryCount) {
  if (!Number.isSafeInteger(recoveryCount) || recoveryCount < 1 || recoveryCount > AUTO_RECOVERY_LIMIT) return void 0;
  return RECOVERY_BACKOFF_DELAYS[recoveryCount - 1];
}

/**
 * DSH 公开 agent/request-error payload 中允许自动重试的稳定错误码。
 * 这里只接受结构化 failure.code；message、stack 和 reason 文本不参与判定，
 * 因而未知的 upstream_unavailable 变体会 fail-closed。
 */
export const REQUEST_RETRYABLE_FAILURE_CODES = Object.freeze([
  "SERVER",
  "RATE_LIMIT",
  "TIMEOUT",
  "TRANSPORT",
  "EMPTY_RESPONSE",
  "upstream_unavailable",
  "UPSTREAM_UNAVAILABLE",
  "PI_AI_ERROR",
  "AUTH",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "INVALID_REQUEST",
  "BAD_REQUEST",
  "NO_PROVIDER",
  "NO_ADAPTER",
  "UNKNOWN_MODEL",
  "MODEL_NOT_FOUND",
]);

// PI_AI_ERROR 的 message 来自上游/流传输层，必须匹配已知完整前缀或边界明确的短语。
// 不能用任意 contains：pending、认证、HTTP 4xx、quota 等文案必须保持终态。
const PI_AI_TRANSIENT_MESSAGE_PATTERNS = Object.freeze([
  /^\s*upstream_stream_incomplete(?:\s*:|\b)/i,
  /^\s*upstream_unavailable(?:\s*:|\b)/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?stream[\s_-]+ended[\s_-]+(?:before|without)\b/i,
  /^\s*(?:(?:error|cause|request|stream|upstream)\s*:\s*)?(?:network|connection|socket|fetch)[\s_-]+(?:error|failure|failed|reset|refused|closed|timeout)\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?(?:[A-Za-z][A-Za-z0-9_-]*\s+)?ECONN[A-Z0-9_]*\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?other\s+side\s+closed\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?HTTP2\s+request\s+did\s+not\s+get\s+a\s+response\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?WebSocket\s+closed\s+unexpectedly\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?(?:terminated|(?:the\s+)?(?:request|stream|connection|socket)(?:\s+was)?\s+terminated)\b/i,
  /^\s*(?:(?:error|cause)\s*:\s*)?premature\s+close\b/i,
]);

const PI_AI_PERMANENT_MESSAGE_PATTERNS = Object.freeze([
  /\b(?:pending|deferred|unauthorized|forbidden|invalid[\s_-]+request|model[\s_-]+not[\s_-]+allowed|quota)\b/i,
  /(?:^|[^0-9])(?:400|401|403|413)(?=$|[^0-9])/i,
  /\b(?:authentication|authorization|credential)[\s_-]+(?:failed|invalid|missing|required|denied)\b/i,
]);

/**
 * PI_AI_ERROR 中已知的永久错误只按结构化 message 的明确边界匹配。
 * 未知 message 保持既有未知错误策略，不在这里擅自扩大终态集合。
 * @param {string} [message] - PI AI 错误消息。
 * @returns {boolean} 已知永久消息返回 true。
 */
export function isPermanentPiAiMessage(message) {
  return typeof message === "string"
    && PI_AI_PERMANENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * PI_AI_ERROR 只允许已知上游/流传输模式进入 request retry。
 * @param {object} [failure] - 公开 request-error payload 的结构化 failure。
 * @returns {boolean} 已知瞬态 PI AI 错误返回 true。
 */
export function isTransientPiAiFailure(failure) {
  if (failure === null || typeof failure !== "object" || failure.code !== "PI_AI_ERROR") return false;
  if (isPermanentPiAiMessage(failure.message)) return false;
  return typeof failure.message === "string"
    && PI_AI_TRANSIENT_MESSAGE_PATTERNS.some((pattern) => pattern.test(failure.message));
}

/**
 * 判断 PI_AI_ERROR 是否是已知永久错误，以阻止 child turn/end continuation。
 * @param {object} [failure] - turn/end reason.error 或 request failure。
 * @returns {boolean} 已知永久 PI AI 错误返回 true。
 */
export function isPermanentPiAiFailure(failure) {
  return failure !== null
    && typeof failure === "object"
    && failure.code === "PI_AI_ERROR"
    && isPermanentPiAiMessage(failure.message);
}

/**
 * 判断一个 agent/request-error failure 是否属于插件允许接管的瞬态错误。
 * @param {object} [failure] - 公开 request-error payload 的结构化 failure。
 * @returns {boolean} code 和 PI_AI_ERROR message 均明确可重试时返回 true。
 */
export function isTransientRequestFailure(failure) {
  if (failure === null || typeof failure !== "object" || typeof failure.code !== "string") return false;
  if (failure.code === "PI_AI_ERROR") return isTransientPiAiFailure(failure);
  return REQUEST_RETRYABLE_FAILURE_CODES.includes(failure.code);
}

/**
 * 判断 Host 的 dsh-llm-retry 是否声明会处理该结构化错误。插件只用它避免
 * 另起并发退避；实际等待和 durable retry 事件仍由 Host 公开 hook 处理。
 * @param {object} [retryPolicy] - request-error payload 的 resolved retryPolicy。
 * @param {object} [failure] - request-error payload 的结构化 failure。
 * @returns {boolean} Host policy 覆盖该 code 时返回 true。
 */
export function requestRetryPolicyCoversFailure(retryPolicy, failure) {
  if (!isTransientRequestFailure(failure) || retryPolicy === null || typeof retryPolicy !== "object") return false;
  if (retryPolicy.mode === "always") return true;
  return retryPolicy.mode === "normal"
    && Array.isArray(retryPolicy.retryableCodes)
    && retryPolicy.retryableCodes.includes(failure.code);
}

/**
 * 创建一个 Agent/Session 绑定的请求级重试状态。WeakSet/WeakMap 只保存运行时
 * 对象身份，不把 payload 或 failure 写入持久日志；Set 仅保存不透明 requestId。
 */
export function createRequestRetryState(session) {
  return {
    session,
    turn: void 0,
    step: void 0,
    retryCount: 0,
    exhausted: false,
    generation: 0,
    seenPayloads: new WeakSet(),
    seenFailures: new WeakSet(),
    seenRequestIds: new Set(),
  };
}

/**
 * 切换到新的 Session/turn/step 前清空请求级去重和预算状态。
 * @param {object} state - createRequestRetryState 返回的状态。
 * @param {object} session - 当前 durable Session。
 * @param {number} [turn] - 新 turn。
 * @param {number} [step] - 新 step。
 * @returns {object} 原状态，便于调用方链式保存。
 */
export function resetRequestRetryState(state, session, turn, step) {
  if (state === null || typeof state !== "object") return state;
  if (typeof state.waitController?.abort === "function") state.waitController.abort();
  state.waitController = void 0;
  state.session = session;
  state.turn = Number.isSafeInteger(turn) ? turn : void 0;
  state.step = Number.isSafeInteger(step) ? step : void 0;
  state.retryCount = 0;
  state.exhausted = false;
  state.generation = Number.isSafeInteger(state.generation) ? state.generation + 1 : 1;
  state.activeKey = void 0;
  state.seenPayloads = new WeakSet();
  state.seenFailures = new WeakSet();
  state.seenRequestIds = new Set();
  return state;
}

/**
 * 标记一次 request-error 事件并按对象/requestId 去重。没有可靠对象身份或
 * requestId 时不猜测结构等价，允许后续真实请求尝试继续消耗独立预算。
 * @param {object} state - 请求级状态。
 * @param {object} payload - request-error payload。
 * @param {object} [failure] - payload.failure。
 * @returns {boolean} 已处理过同一事件对象时返回 true。
 */
export function markRequestRetryEvent(state, payload, failure) {
  if (state === null || typeof state !== "object") return false;
  const payloadObject = payload !== null && (typeof payload === "object" || typeof payload === "function");
  const failureObject = failure !== null && (typeof failure === "object" || typeof failure === "function");
  const requestId = typeof failure?.requestId === "string" && failure.requestId.length > 0
    ? failure.requestId : void 0;
  const duplicate = (payloadObject && state.seenPayloads.has(payload))
    || (failureObject && state.seenFailures.has(failure))
    || (requestId !== void 0 && state.seenRequestIds.has(requestId));
  if (payloadObject) state.seenPayloads.add(payload);
  if (failureObject) state.seenFailures.add(failure);
  if (requestId !== void 0) state.seenRequestIds.add(requestId);
  return duplicate;
}

/**
 * 清除某个 recovery op 自己持有的 timer（可重复调用）。先摘掉句柄并标记取消，
 * 再调用注入的 clearTimeout，确保迟到 callback 即使无法被宿主取消也不会 dispatch；
 * 不读取或改写其他 op 的状态。
 */
export function clearRecoveryOpTimer(op, clearTimeoutFn = globalThis.clearTimeout) {
  if (op === null || typeof op !== "object") return false;
  const timer = op.timer;
  if (timer === void 0) return false;
  op.timer = void 0;
  op.timerCancelled = true;
  if (typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  return true;
}

/**
 * 为一个 recovery op 安排唯一的退避 timer。scheduler、生命周期 guard 和错误
 * 收口均可注入，测试无需真实等待；生产调用使用宿主 setTimeout。timer 到期后
 * 只负责清除自身句柄并调用 onReady，具体 queueMicrotask、record/op 身份检查和
 * manager admission 仍由插件调用方完成。
 *
 * timerScheduled 一旦置 true 就不会再次安排同一 op；timerFired/timerCancelled
 * 处理重复、迟到和取消竞态。onReady 或 isActive 抛错/拒绝时交给 onError，避免
 * timer callback 产生未处理异常。
 */
export function scheduleRecoveryOpTimer(op, recoveryCount, onReady, options = {}) {
  if (op === null || typeof op !== "object" || typeof onReady !== "function") return false;
  if (op.done === true || recoveryOpIsAccepted(op) || op.timerScheduled === true) return false;
  const delay = recoveryDelayForCount(recoveryCount);
  if (delay === void 0) return false;
  const setTimeoutFn = typeof options?.setTimeout === "function" ? options.setTimeout : globalThis.setTimeout;
  const clearTimeoutFn = typeof options?.clearTimeout === "function" ? options.clearTimeout : globalThis.clearTimeout;
  const isActive = typeof options?.isActive === "function" ? options.isActive : () => true;
  const onError = typeof options?.onError === "function" ? options.onError : () => {};
  if (typeof setTimeoutFn !== "function") return false;

  op.timerScheduled = true;
  op.timerCancelled = false;
  let timer;
  const reportError = (error) => {
    try {
      onError(error);
    } catch {
      // 错误处理器本身不能把宿主 timer callback 变成未处理异常。
    }
  };
  const callback = () => {
    if (op.timerFired === true || op.timerCancelled === true) return;
    op.timerFired = true;
    // callback 开始即清空句柄；后续 admission/queue 只靠 op/record guard 防迟到。
    op.timer = void 0;
    let active;
    try {
      active = isActive() === true;
    } catch (error) {
      reportError(error);
      return;
    }
    if (!active) return;
    try {
      const result = onReady();
      if (result !== void 0 && result !== null && typeof result.then === "function") {
        Promise.resolve(result).catch(reportError);
      }
    } catch (error) {
      reportError(error);
    }
  };
  try {
    timer = setTimeoutFn(callback, delay);
  } catch (error) {
    reportError(error);
    return false;
  }
  // 处理测试 scheduler 或宿主替换实现意外同步触发 callback 的边界，避免把
  // 已到期的句柄重新写回 op，造成后续 clear/dispatch 误判。
  if (op.timerFired === true || op.timerCancelled === true) {
    if (timer !== void 0 && typeof clearTimeoutFn === "function") clearTimeoutFn(timer);
  } else {
    op.timer = timer;
  }
  return true;
}

/**
 * 创建一个自动恢复 op（B4）：每个触发恢复的 turn 一个**独立** op，互不串链、
 * 互不重复恢复——单个全局槽位无法区分并发恢复。普通 steer 与自动恢复
 * 交错时仍由插件统一 helper 管理：自动恢复和 queue=true continuation 都走公开
 * manager sendMessage；自动恢复不调用 interrupt，普通 queue=false 才先请求取消，最终仍由 sendMessage 完成 admission。
 * @param {number|string} id - op 唯一 id（调用方保证单调递增）。
 * @param {number} triggerTurn - 触发恢复的 turn 号。
 * @returns {object} 新的 op：{ id, triggerTurn, messageId:null, accepted:false,
 *   dispatching:false, taskKeys:Set, activityIds:Set, controller, done }——accepted
 *   表示 manager sendMessage 已越过 admission 边界，即使外围 callback 尚未消费
 *   messageId 也不可 supersede；dispatching 表示同 scope 锁内正在等待该边界。
 *   taskKeys 是本 op 对应的原任务 key；
 *   activityIds 是独立于 task binding LRU 的活动范围终态关联（恢复链跨 op
 *   传播，S1-C）；controller 供统一投递 helper 的 signal 使用，
 *   由 dispatchRecovery 填写、dropRecoveryRecord 清理时 abort。timer 由
 *   scheduleRecoveryOpTimer 填写，timerScheduled/timerFired/timerCancelled
 *   共同防止同一 op 重复安排、迟到 callback 和取消竞态。
 */
export function createRecoveryOp(id, triggerTurn) {
  return {
    id,
    triggerTurn,
    messageId: null,
    // manager sendMessage 返回 messageId 前为 false；即使 messageId 尚未被外层
    // 回调消费，accepted=true 也表示消息已经越过 manager admission 边界。
    accepted: false,
    // dispatchRecovery 持有同 scope 锁等待 manager admission 时置 true；
    // supersede 不应在未知 acceptance 的窗口强行取消它。
    dispatching: false,
    // S1-C：本 op 对应的原任务 key 集合。首个 op 由触发 turn 的消息 id 反查
    // record.tasks 填入；恢复链上后续 op 继承前一个 op 的 taskKeys——恢复 turn
    // 完结时据此把结局回写到原任务绑定（success/failed），不因消息 id 变化丢失。
    taskKeys: new Set(),
    // P1：即使 record.tasks 已淘汰原 binding，恢复投递失败或后续终态仍能
    // 精确撤销对应 affectedPaths 活动登记，不影响同 child 的其他任务。
    activityIds: new Set(),
    controller: void 0,
    // timer 生命周期由 shared.js seam 管理；未安排时句柄为空。
    timer: void 0,
    timerScheduled: false,
    timerFired: false,
    timerCancelled: false,
    done: false,
  };
}

/**
 * 判断 manager 是否已经接受恢复消息（纯函数）：
 * messageId 可能还没被外围回调消费，但 accepted=true 已经越过
 * manager sendMessage 的 admission 边界，不能再被普通新任务 supersede。
 * @param {object} [op] - recovery op。
 * @returns {boolean} 已接受返回 true。
 */
export function recoveryOpIsAccepted(op) {
  if (op === null || typeof op !== "object") return false;
  return op.accepted === true || (typeof op.messageId === "string" && op.messageId.length > 0);
}

/**
 * 判断 recovery op 是否仍可被新任务取代（纯函数）：
 * dispatching 表示同 scope 锁内正在等待 manager admission，状态尚未确定，
 * 也不能在锁外抢先取消；accepted/messageId 则明确表示已越过 acceptance 边界。
 * @param {object} [op] - recovery op。
 * @returns {boolean} 仍可 supersede 返回 true。
 */
export function recoveryOpCanBeSuperseded(op) {
  if (op === null || typeof op !== "object") return false;
  if (op.done === true || op.dispatching === true) return false;
  return !recoveryOpIsAccepted(op);
}

/**
 * 在 pending 恢复 op 中查找「恢复消息已落入该 turn」的 op（B4）：
 * 恢复 turn 结束时按恢复 messageId 找到对应 op 并完结（done）；
 * 随后该 turn 再失败时按正常规则创建新 op。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {Set<string>} [turnMsgIds] - 该 turn 的消息 id 集合（含 claimed 并集）。
 * @returns {object|undefined} 匹配的 op；无匹配返回 undefined。
 */
export function findRecoveryOpByMessage(pendingRecoveries, turnMsgIds) {
  if (!(pendingRecoveries instanceof Map) || !(turnMsgIds instanceof Set)) return void 0;
  for (const op of pendingRecoveries.values()) {
    if (typeof op?.messageId === "string" && turnMsgIds.has(op.messageId)) return op;
  }
  return void 0;
}

/**
 * 是否存在触发该 turn 的进行中恢复 op（扫描场景判定「恢复是否已发出」，B4）。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {number} turn - turn 号。
 * @returns {boolean} 存在未完结且 triggerTurn === turn 的 op 返回 true。
 */
export function recoveryOpPendingForTurn(pendingRecoveries, turn) {
  if (!(pendingRecoveries instanceof Map) || !Number.isSafeInteger(turn)) return false;
  for (const op of pendingRecoveries.values()) {
    if (op?.triggerTurn === turn && op?.done !== true) return true;
  }
  return false;
}

/**
 * op 是否仍挂在该记录的 pending 表里（B7）：steer 异步回调落地前必须校验
 * （记录被删除/插件卸载/父代理销毁后，回调必须丢弃，不能推进已失效的状态）。
 * @param {Map<number|string, object>} [pendingRecoveries] - opId -> op。
 * @param {object} [op] - 要校验的 op。
 * @returns {boolean} 仍 pending 返回 true。
 */
export function recoveryOpIsPending(pendingRecoveries, op) {
  return pendingRecoveries instanceof Map && pendingRecoveries.get(op?.id) === op && op?.done !== true;
}

/**
 * 判断 recovery microtask 是否可以在创建 tracker scope 前开始 dispatch（纯函数）。
 * 必须同时确认 child 仍映射到同一 record，且 op 仍挂在 pending 表、尚未 accepted；
 * 这样父销毁/插件卸载后的迟到 microtask 会直接返回，不会由 serialize 的 entryOf
 * 重建一个空 scope。调用方在 guard 与 serialize 之间不得 await。
 * @param {Map<string, object>} [recoveryRecords] - childId -> recovery record。
 * @param {string} childId - microtask 捕获的 child session id。
 * @param {object} [record] - microtask 捕获的 recovery record。
 * @param {object} [op] - microtask 捕获的 recovery op。
 * @returns {boolean} 仍可开始 dispatch 返回 true。
 */
export function recoveryDispatchCanStart(recoveryRecords, childId, record, op) {
  return recoveryRecords instanceof Map
    && recoveryRecords.get(childId) === record
    && recoveryOpIsPending(record?.pendingRecoveries, op)
    && !recoveryOpIsAccepted(op);
}

/**
 * 把 turn/end 的 reason 转成面向子代理的中文原因说明。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {string} 中文原因文案。
 */
export function recoveryReasonText(reason) {
  const kind = reason?.kind;
  if (kind === "error") {
    const message = reason?.error?.message;
    if (typeof message === "string" && message.length > 0) return `执行出错：${message}`;
    return "执行出错";
  }
  if (kind === "max-tokens") return "达到输出 token 上限";
  if (kind === "completed") return "没有返回任何文本输出";
  if (kind === "aborted") return "执行被取消";
  // B9：blocked（pre-step 拒绝，消息被认领但未落盘）与 refusal 统一为「任务被拒绝」。
  if (kind === "refusal" || kind === "blocked") return "任务被拒绝";
  return `未知结束原因（${String(kind ?? "未知")}）`;
}

/**
 * 生成自动恢复的「继续执行」指令（以 user 消息文本发送给子代理）。
 * @param {object} [reason] - turn/end 的 data.reason。
 * @returns {string} 中文恢复指令文本。
 */
export function buildRecoveryMessage(reason) {
  return `你上一次执行没有返回有效结果（原因：${recoveryReasonText(reason)}）。请继续完成你收到的原始任务，并在完成后给出完整最终回复；不要重复已经成功的步骤。`;
}

/**
 * 从会话事件日志中读取最近一次 turn/end 的底层错误消息（纯函数形态的
 * childTurnError：只读 events，不依赖 Agent 对象）。
 * @param {Array} [events] - session.events。
 * @returns {string|null} 最近一次底层错误消息；无可用详情返回 null。
 */
export function lastTurnErrorMessage(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type !== "turn/end") continue;
    const message = event?.data?.reason?.error?.message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return null;
}

/**
 * 当前页面状态文案允许使用的英文专家 role id。根会话不属于 role 列表，
 * 由 resolveRunningStatusText 固定映射为 Orchestrator。
 */
export const STATUS_ROLE_IDS = [...ROLES, ...OPTIONAL_ROLES];

// ── 专家提示词覆盖的共享配置边界 ──────────────────────────────────────────
// Host 与客户端必须使用同一份角色集合、同一上限与同一「空白即无效」语义，
// 否则设置页会显示一份可保存、Host 却拒绝（或反之）的草稿。这里是唯一来源；
// 客户端 bundle 通过同目录复制使用同样的字面量。
// 本模块保持无 Node 依赖：只做字符串/对象归一，不读取 settings 或任何 Host 状态。

/** dsh-expert-group settings namespace 中承载六角色自定义提示词的字段名。 */
export const PROMPT_OVERRIDES_SETTINGS_KEY = "promptOverrides";

/**
 * 单个专家提示词的最大 Unicode grapheme 数量（32,000）。
 *
 * 用 grapheme 而不是 UTF-16 code unit：中文、emoji 与组合字符的显示计数必须与
 * 用户直觉一致；组合字符（例如带连接符的 emoji）算一个字符，不会被重复计数。
 *
 * 注意这是**显示/校验口径**，与传输体积是两件独立的事：grapheme 与 UTF-8 字节
 * 不成固定比例（ASCII 1 字节、CJK/emoji 基础码位最多 4 字节，而 ZWJ 组合簇的字节
 * 数没有固定上界）。整份候选的字节预算由 host/rpc-transport 的
 * RPC_SETTINGS_COMMIT_BODY_LIMIT 独立负责，超限是结构化 413 而不是截断。
 */
export const PROMPT_OVERRIDE_MAX_GRAPHEMES = 32000;

/** 提示词覆盖的稳定错误 code：保存候选在写入边界被拒绝时返回。 */
export const PROMPT_OVERRIDE_INVALID_CODE = "INVALID_PROMPT_OVERRIDE";

/**
 * 未注册角色被写入覆盖时的稳定错误 code。
 *
 * 与「非法角色」分开：未知角色键是调用方拼错了角色集合，而不是提示词内容问题。
 */
export const PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE = "UNKNOWN_PROMPT_ROLE";

/**
 * 按用户可感知的 Unicode 字符计数。
 *
 * 优先使用 Intl.Segmenter（Node 与目标浏览器都提供）；只有不可用时才回退到
 * [...text] 的 code point 计数——回退会低估组合字符（用户看到 1 个字符，这里算 N 个），
 * 因此上限判定只会更宽松，绝不会因为环境差异拒绝用户能看到的合法长度。
 *
 * @param {unknown} text - 待计数文本；非字符串按空字符串处理。
 * @returns {number} grapheme 数量（非负安全整数）。
 */
export function countPromptGraphemes(text) {
  const value = typeof text === "string" ? text : "";
  if (value.length === 0) return 0;
  try {
    const segmenter = typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
      ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
      : null;
    if (segmenter !== null) {
      let count = 0;
      for (const _segment of segmenter.segment(value)) count += 1;
      return count;
    }
  } catch { /* 环境不支持 Segmenter：回退到 code point 计数 */ }
  let count = 0;
  for (const _codePoint of value) count += 1;
  return count;
}

/**
 * 归一化一份提示词覆盖候选。
 *
 * 归一规则（Host 写入校验与客户端草稿必须一致）：
 * - 未知角色键、非字符串值与纯空白文本被丢弃（等价于该角色没有覆盖）；
 * - 非空文本保留首尾空白与换行，绝不 trim、压缩空白或截断；
 * - 超过 grapheme 上限的文本被丢弃（Host 在写入边界会显式拒绝，这里只保证读取安全）。
 *
 * @param {unknown} value - settings 文档里的 promptOverrides 原始值。
 * @param {readonly string[]} [allowedRoles] - 允许的角色集合；运行期目录由调用方传入，
 *   缺省为内置六角色。
 * @returns {Record<string,string>} 归一后的普通对象（含 0 个键表示无覆盖）。
 */
export function normalizePromptOverrides(value, allowedRoles = STATUS_ROLE_IDS) {
  const result = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return result;
  const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
  for (const [role, text] of Object.entries(value)) {
    if (!allowed.has(role)) continue;
    if (typeof text !== "string") continue;
    if (text.trim().length === 0) continue;
    if (countPromptGraphemes(text) > PROMPT_OVERRIDE_MAX_GRAPHEMES) continue;
    result[role] = text;
  }
  return result;
}

/**
 * 读取一个角色的有效自定义覆盖。
 *
 * @param {unknown} value - settings 文档里的 promptOverrides 原始值。
 * @param {string} role - 专家角色 id。
 * @returns {string|undefined} 有效覆盖文本；没有覆盖（或值不合法）时返回 undefined。
 */
export function promptOverrideFor(value, role) {
  if (typeof role !== "string" || role.length === 0) return void 0;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return void 0;
  const text = value[role];
  if (typeof text !== "string" || text.trim().length === 0) return void 0;
  return text;
}

/**
 * role id 保持小写用于身份匹配；页面显示只使用注册表提供的英文状态标签。
 * 这里包含可选角色：历史会话或已关闭 Observer 的 child 仍需要正确的状态文案。
 */
export const STATUS_ROLE_LABELS = roleStatusLabels({ enableObserver: true });

/**
 * 归一化插件角色元数据；未知、空值和外部角色都返回 undefined，避免客户端
 * 猜测历史/外部会话的身份。大小写归一只用于可靠匹配，不改变持久化数据。
 * @param {unknown} role - RPC/marker 提供的角色值。
 * @param {readonly string[]} [allowedRoles] - 允许的角色集合；运行期目录（内置 + 自定义）
 *   由 Host 传入，缺省为内置六角色（客户端 bundle 的静态副本与之一致）。
 * @returns {string|undefined} 已验证的英文 role id。
 */
export function normalizeStatusRole(role, allowedRoles = STATUS_ROLE_IDS) {
  if (typeof role !== "string") return void 0;
  const normalized = role.trim().toLowerCase();
  const allowed = Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS;
  return allowed.includes(normalized) ? normalized : void 0;
}

/**
 * 判断会话摘要是否明确表示专家 child。只有 parentId 或 DSH 的 subagent origin
 * 存在时才视为 child；普通根会话不会因缺失插件 metadata 而被误判为未知 child。
 * @param {object} [session] - useSessions 当前快照中的 SessionSummary。
 * @returns {boolean} 明确为 child 返回 true。
 */
export function isPluginChildSession(session) {
  return session !== null
    && typeof session === "object"
    && ((typeof session.parentId === "string" && session.parentId.length > 0) || session.origin === "subagent");
}

/**
 * 从插件 RPC 响应中解析与 sessionId 绑定的状态身份。响应没有当前 session 的
 * 身份时直接丢弃；未知 kind 返回 unknown，客户端因此保持原生文案而不猜测 root/child。
 * @param {object} input - 当前请求 sessionId、响应所属 sessionId 与 JSON 响应。
 * @returns {{sessionId:string, kind:"child"|"root"|"unknown", role:string|undefined}|null}
 */
export function resolveStatusIdentity({ sessionId, responseSessionId, response } = {}) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  const reportedSessionId = response?.sessionId ?? responseSessionId;
  if (reportedSessionId !== sessionId) return null;
  if (response?.ok === false) return { sessionId, kind: "unknown", role: void 0 };
  if (response?.kind === "child") {
    return {
      sessionId,
      kind: "child",
      role: normalizeStatusRole(response?.child?.role),
    };
  }
  if (response?.kind === "root") return { sessionId, kind: "root", role: void 0 };
  return { sessionId, kind: "unknown", role: void 0 };
}

/**
 * CSS Module 稳定局部名匹配：只认局部名本身，不绑定构建 hash 形态。
 * Vite 默认产物是 `_label_hash_line`，旧夹具/其它工具链是 `hash_label`；两种形状都只依赖
 * 局部名，因此既不能硬编码完整 hash，也不能只认某一种前后缀拼接。
 * @param {string|undefined} className - 元素的 class 属性值。
 * @param {string} localName - CSS Module 局部名（turnStatus / label / visuallyHidden）。
 * @returns {boolean} 任一 class token 的局部名命中时返回 true。
 */
const localClassTokenPatterns = new Map();
function hasLocalClassToken(className, localName) {
  if (typeof className !== "string") return false;
  // 局部名只来自本文件的常量；缓存两个正则是因为这段代码在每次 observer 通知里对
  // 每个候选元素都会跑一遍，热路径上不值得反复编译同一个正则。
  let patterns = localClassTokenPatterns.get(localName);
  if (patterns === void 0) {
    patterns = [new RegExp("(?:^|_)" + localName + "$"), new RegExp("^_" + localName + "(?:_|$)")];
    localClassTokenPatterns.set(localName, patterns);
  }
  return className.split(/\s+/).some((token) => patterns[0].test(token) || patterns[1].test(token));
}

/**
 * DSH 0.1.7 的隐藏 announcement 语义。aria-atomic=true 是它最稳定的标记，
 * visuallyHidden 局部名 / hidden / aria-hidden=true 是等价的隐藏形状；隐藏节点永远不能
 * 成为可见文案目标，也不能被附加动画。
 * @param {object} node - 候选元素。
 * @returns {boolean} 明确隐藏时返回 true。
 */
function isHiddenStatusCandidate(node) {
  if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
  if (node.getAttribute("aria-atomic") === "true") return true;
  if (node.getAttribute("aria-hidden") === "true") return true;
  const hidden = node.getAttribute("hidden");
  if (hidden !== null && hidden !== void 0) return true;
  return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
}

/**
 * 唯一主文本节点：恰好一个 trim 后非空的直接 Text，其余子节点只能是 aria-hidden=true 计时器。
 * 旧版 turnStatus 与新版 turn-process label 共用这条形状约束，避免命中 notice、拼装状态或容器。
 * @param {object} node - 候选容器元素。
 * @returns {object|undefined} 可安全改写的 Text 节点。
 */
function singleNativeStatusTextNode(node) {
  const childNodes = Array.from(node?.childNodes ?? []);
  const textNodes = childNodes.filter((child) => child?.nodeType === 3);
  const accessoryNodes = childNodes.filter((child) => child?.nodeType !== 3);
  const hasOnlyAriaHiddenAccessories = accessoryNodes.every((child) =>
    child?.nodeType === 1 && typeof child?.getAttribute === "function" && child.getAttribute("aria-hidden") === "true"
  );
  if (textNodes.length !== 1 || typeof textNodes[0].nodeValue !== "string" || textNodes[0].nodeValue.trim().length === 0 || !hasOnlyAriaHiddenAccessories) return void 0;
  return textNodes[0];
}

/** 深度优先收集后代元素；label 查找只在 button 子树内做，范围固定且很小。 */
function collectDescendantElements(node, out = []) {
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child?.nodeType !== 1) continue;
    out.push(child);
    collectDescendantElements(child, out);
  }
  return out;
}

/**
 * DSH 0.1.7 的可见状态目标是 span，不是任意带 label 局部名的元素：
 * 按钮内部的图标/计时器容器或嵌套控件同样可能叫 label，但只有 span 承担可见文案。
 * 大小写不敏感（真实 DOM 给 SPAN，fake DOM 给 span），缺失 tagName 时保守拒绝。
 * @param {object} element - 候选元素。
 * @returns {boolean} 元素是 span 时返回 true。
 */
function isSpanStatusLabelElement(element) {
  return typeof element?.tagName === "string" && element.tagName.toLowerCase() === "span";
}

/**
 * DSH 会话边界可能使用任一公开 data-* 属性；状态行自身没有属性时还要沿祖先查找。
 * markerless DOM 只能在所有已发现属性都精确指向当前会话时写入，否则保持原生文案。
 */
const NATIVE_SESSION_ATTRIBUTES = [
  "data-session-id",
  "data-conversation-session-id",
  "data-conversation-session",
  "data-session",
];

function nativeStatusSessionValues(node, boundary) {
  const values = [];
  let current = node;
  while (current !== null && current !== void 0) {
    if (typeof current.getAttribute === "function") {
      for (const name of NATIVE_SESSION_ATTRIBUTES) {
        const value = current.getAttribute(name);
        if (typeof value === "string" && value.length > 0) values.push(value);
      }
    }
    if (boundary !== void 0 && current === boundary) break;
    current = current.parentNode;
  }
  return values;
}

/**
 * 按指定边界校验候选节点：markerless 需要至少一条当前会话证据；已有 scope 时即使
 * 只靠 scope 证明归属，也必须拒绝节点自身或祖先携带的冲突 session 属性。
 */
function nativeStatusNodeMatchesSession(node, sessionId, boundary, requireEvidence) {
  if (sessionId === void 0 || sessionId === null || String(sessionId).length === 0) return false;
  const values = nativeStatusSessionValues(node, boundary);
  const expected = String(sessionId);
  return (!requireEvidence || values.length > 0) && values.every((value) => value === expected);
}

/** 读取节点自身携带的全部公开会话属性值（空值忽略）。 */
function sessionValuesOf(node) {
  const values = [];
  if (typeof node?.getAttribute === "function") {
    for (const name of NATIVE_SESSION_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  return values;
}

/**
 * 定位 DSH 0.2.0-rc1 的会话证据容器。
 *
 * RC1 的 data-conversation-session 不在 [data-conversation-scroll] 上，而在它的
 * [data-conversation-content] 外层容器上；只读 scroll 自身会把当前会话判定成"无标记"，
 * 于是两棵 conversation 并存时整体放弃，新运行行完全漏掉。
 *
 * 语义边界：
 * - 没有 [data-conversation-content] 祖先时返回 undefined：绝不越过 scroll 向上猜证据，
 *   既有 legacy 形态（会话属性直接落在 scope 或状态节点上）语义完全不变；
 * - 有 content 祖先时，就近取它或它最近带会话属性的祖先作为证据容器；冲突属性仍由
 *   nativeStatusNodeMatchesSession 的"链上所有已发现属性必须一致"兜住。
 * @param {object} scope - 已确定的 [data-conversation-scroll] 会话边界。
 * @returns {object|undefined} 证据容器；没有 content 祖先时返回 undefined。
 */
function nativeConversationEvidenceOwner(scope) {
  let content;
  let current = scope;
  while (current !== null && current !== void 0) {
    if (typeof current.getAttribute === "function" && current.getAttribute("data-conversation-content") !== null) {
      content = current;
      break;
    }
    current = current.parentNode;
  }
  if (content === void 0) return void 0;
  let node = content;
  while (node !== null && node !== void 0) {
    if (typeof node.getAttribute === "function" && sessionValuesOf(node).length > 0) return node;
    node = node.parentNode;
  }
  return content;
}

/** scope 的会话证据：scope 自身的会话属性 + RC1 content 外层的会话属性。 */
function nativeStatusScopeIds(scope) {
  return [...sessionValuesOf(scope), ...sessionValuesOf(nativeConversationEvidenceOwner(scope))];
}

/** 候选节点的会话证据边界：RC1 用 content 外层，legacy 用 scope 自身。 */
function nativeStatusSessionBoundary(scope) {
  return nativeConversationEvidenceOwner(scope) ?? scope;
}

/**
 * RC1 装饰子树判定：aria-hidden=true / inert / hidden / visuallyHidden 局部名都属于
 * "不承载可见文案"的动画副本（TextShimmer 的扫光副本就在这里）。
 *
 * 与 isHiddenStatusCandidate 分开：后者还要把 aria-atomic 的隐藏 announcement 视为不可见
 * 候选，而这里只用于"在跑马灯里找真实可见文案"，不需要把 announcement 排除法混进来。
 * @param {object} node - 候选元素。
 * @returns {boolean} 属于装饰子树时返回 true。
 */
function isDecorativeNativeStatusNode(node) {
  if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
  if (node.getAttribute("aria-hidden") === "true") return true;
  const hidden = node.getAttribute("hidden");
  if (hidden !== null && hidden !== void 0) return true;
  const inert = node.getAttribute("inert");
  if (inert !== null && inert !== void 0) return true;
  return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
}

/**
 * 收集非装饰子树里的可见 Text（深度优先）。
 * 装饰子树整棵跳过：它的文字与真实可见文案相同，但属于宿主动画的一部分。
 * @param {object} node - 起始元素。
 * @param {Array} [out] - 收集结果。
 * @param {boolean} [hidden] - 祖先是否已判定为装饰。
 * @returns {Array} trim 后非空的可见 Text 节点。
 */
function collectVisibleStatusTextNodes(node, out = [], hidden = false) {
  const hiddenHere = hidden || isDecorativeNativeStatusNode(node);
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child?.nodeType === 3) {
      if (!hiddenHere && typeof child.nodeValue === "string" && child.nodeValue.trim().length > 0) out.push(child);
      continue;
    }
    if (child?.nodeType !== 1) continue;
    collectVisibleStatusTextNodes(child, out, hiddenHere);
  }
  return out;
}

/**
 * DSH 0.2.0-rc1 官方运行行的字段集合。
 *
 * 结构（实测 DOM）：
 * conversation[data-conversation-content][data-conversation-session]
 *   > [data-conversation-scroll] > [data-chat-running]
 *     ├─ role=status/aria-live=polite/aria-atomic=true 的隐藏 announcement
 *     ├─ 鲸鱼尾巴等 aria-hidden 装饰
 *     └─ [data-shimmer="true"]
 *         ├─ 可见子树：唯一的真实文案 Text（含"深度求索中，用时8分12秒..."）
 *         └─ aria-hidden/inert 装饰副本：data-shimmer-text 保存同一份完整标签
 *
 * fail-closed：行、跑马灯容器、可见 Text 任一项不是恰好一个就整体放弃，绝不猜可见性；
 * 归属由行到会话边界的属性链证明（冲突或缺证据时放弃）。
 * @param {object} scope - 已唯一确定的 conversation scope。
 * @param {string} sessionId - 当前页面会话 id。
 * @param {boolean} requireSessionEvidence - 是否要求链上至少一条当前会话属性。
 * @param {object} [sessionBoundary] - 会话证据边界。
 * @returns {{visibleText:object, shimmerTextNodes:Array, announcementTexts:Array}|undefined}
 */
function findNativeRunningRowParts(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const rows = [];
  if (scope?.matches?.("[data-chat-running]")) rows.push(scope);
  for (const row of Array.from(scope?.querySelectorAll?.("[data-chat-running]") ?? [])) {
    if (!rows.includes(row)) rows.push(row);
  }
  if (rows.length !== 1) return void 0;
  const row = rows[0];
  if (!nativeStatusNodeMatchesSession(row, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

  const shimmers = collectDescendantElements(row).filter((element) => element?.getAttribute?.("data-shimmer") === "true");
  if (shimmers.length !== 1) return void 0;
  const visibleTexts = collectVisibleStatusTextNodes(shimmers[0]);
  if (visibleTexts.length !== 1) return void 0;
  const visibleText = visibleTexts[0];
  // 不只校验 running row：实际被写入的 Text 和属性节点也可能带冲突会话标记。
  if (!nativeStatusNodeMatchesSession(visibleText, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

  const shimmerTextNodes = collectDescendantElements(row).filter((element) => {
    const value = element?.getAttribute?.("data-shimmer-text");
    return value !== null && value !== void 0;
  });
  if (shimmerTextNodes.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
  const announcementTexts = [];
  for (const element of collectDescendantElements(row)) {
    if (element?.getAttribute?.("role") !== "status") continue;
    if (element?.getAttribute?.("aria-live") !== "polite") continue;
    if (element?.getAttribute?.("aria-atomic") !== "true") continue;
    const textNode = singleNativeStatusTextNode(element);
    if (textNode !== void 0) announcementTexts.push(textNode);
  }
  if (announcementTexts.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
  return { visibleText, shimmerTextNodes, announcementTexts };
}

/**
 * DSH 0.1.7 把可见运行状态放进 button[data-turn-process] 内的 span.label。
 * 只有可见、且恰好唯一命中的 label 才是候选：隐藏 announcement 永不入选，非 span 元素
 * 与多义候选（同 scope 多个可见 label，例如历史 turn 的按钮）一律放弃，让 legacy 兜底而不是猜。
 * @param {object} scope - 已唯一确定的 conversation scope。
 * @returns {object|undefined} label 内的主 Text 节点。
 */
function findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const matches = [];
  for (const button of Array.from(scope?.querySelectorAll?.("button[data-turn-process]") ?? [])) {
    if (button?.getAttribute?.("data-turn-process") === null || button?.getAttribute?.("data-turn-process") === void 0) continue;
    if (isHiddenStatusCandidate(button)) continue;
    for (const candidate of collectDescendantElements(button)) {
      if (!isSpanStatusLabelElement(candidate)) continue;
      if (!hasLocalClassToken(candidate?.getAttribute?.("class"), "label")) continue;
      if (isHiddenStatusCandidate(candidate)) continue;
      const textNode = singleNativeStatusTextNode(candidate);
      if (textNode === void 0) continue;
      if ((requireSessionEvidence || sessionBoundary !== void 0)
        && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
      matches.push(textNode);
    }
  }
  return matches.length === 1 ? matches[0] : void 0;
}

/**
 * 在已确定的会话 scope 内定位 legacy（非 RC1）形态的原生状态主文本节点：
 * 依次尝试 DSH 0.1.7 的 button[data-turn-process] > span.label 与 0.1.6 的 turnStatus。
 * RC1 的 [data-chat-running] 行由 resolveNativeStatusTargets 优先处理，不在这里兜底。
 * markerless 根节点由调用方显式要求祖先会话证据；有 scope marker 时沿用 scope 选择结果。
 */
function findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const labelNode = findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
  if (labelNode !== void 0) return labelNode;

  const statuses = [];
  if (scope?.matches?.('[role="status"]')) statuses.push(scope);
  for (const status of Array.from(scope?.querySelectorAll?.('[role="status"]') ?? [])) {
    if (!statuses.includes(status)) statuses.push(status);
  }
  let match;
  for (const status of statuses) {
    if (status?.getAttribute?.("role") !== "status" || status?.getAttribute?.("aria-live") !== "polite") continue;
    if (isHiddenStatusCandidate(status)) continue;
    if (!hasLocalClassToken(status?.getAttribute?.("class"), "turnStatus")) continue;
    const textNode = singleNativeStatusTextNode(status);
    if (textNode === void 0) continue;
    if ((requireSessionEvidence || sessionBoundary !== void 0)
      && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
    if (match !== void 0) return void 0;
    match = textNode;
  }
  return match;
}

/**
 * 解析当前会话的原生运行状态**全字段**目标（纯 DOM 选择，不写入）：
 * - RC1：返回 { visibleText, shimmerAttributes, announcements } 三项完整字段；
 * - legacy（0.1.7 label / 0.1.6 turnStatus）：只返回可见 Text，另外两项为空。
 *
 * 会话判定：优先 data-conversation-scroll 边界；RC1 的会话标记在它的
 * [data-conversation-content] 外层，因此证据与候选边界都按 nativeStatusScopeIds /
 * nativeStatusSessionBoundary 取；没有 scope marker 时扫描 root 并强制要求祖先会话证据。
 * 任何冲突、歧义或缺少证据的情况都返回 undefined，让调用方保持宿主原文。
 * @param {object} root - 通常为 document.body 的 DOM 根。
 * @param {string} sessionId - 当前页面会话 id。
 * @returns {{visibleText:object, shimmerAttributes:Array, announcements:Array}|undefined}
 */
function resolveNativeStatusTargets(root, sessionId) {
  const scopes = [];
  if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
  for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
    if (!scopes.includes(scope)) scopes.push(scope);
  }

  if (scopes.length === 0) {
    const textNode = findNativeTurnStatusTextNode(root, sessionId, true);
    return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
  }

  const exact = sessionId === void 0 || sessionId === null
    ? []
    : scopes.filter((scope) => nativeStatusScopeIds(scope).includes(String(sessionId)));
  const tagged = scopes.filter((scope) => nativeStatusScopeIds(scope).length > 0);
  let candidates = [];
  if (exact.length === 1) {
    candidates = exact;
  } else if (exact.length > 1) {
    const visible = exact.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
    if (visible.length === 1) candidates = visible;
  } else if (tagged.length === 0 && scopes.length === 1) {
    candidates = scopes;
  } else if (tagged.length === 0) {
    const visible = scopes.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
    if (visible.length === 1) candidates = visible;
  }
  if (candidates.length !== 1) return void 0;

  const scope = candidates[0];
  const requireSessionEvidence = nativeStatusScopeIds(scope).includes(String(sessionId));
  const sessionBoundary = nativeStatusSessionBoundary(scope);
  const parts = findNativeRunningRowParts(scope, sessionId, requireSessionEvidence, sessionBoundary);
  if (parts !== void 0) {
    return {
      visibleText: parts.visibleText,
      shimmerAttributes: parts.shimmerTextNodes,
      announcements: parts.announcementTexts,
    };
  }
  const textNode = findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
  return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
}

/**
 * 选择当前页面会话的原生运行状态**可见**主文本节点（公开只读 seam）。
 *
 * RC1 返回 [data-shimmer="true"] 非装饰子树里的真实可见 Text；0.1.7/0.1.6 的 legacy 形态
 * 继续返回各自唯一的可见 Text。选择与会话判定语义与 client.js 的同名实现同步。
 * @param {object} root - 通常为 document.body 的 DOM 根。
 * @param {string} sessionId - 当前页面会话 id。
 * @returns {object|undefined} 要改写的可见 Text 节点。
 */
export function findNativeStatusTextNode(root, sessionId) {
  return resolveNativeStatusTargets(root, sessionId)?.visibleText;
}


/**
 * 计算当前会话的插件运行状态文案（纯函数）：
 * - 只接受页面当前会话且 running === true；
 * - 明确为 child 时必须有已验证的插件 role；
 * - 根会话使用 Orchestrator；
 * - 空闲、等待、完成、无会话、无法从 marker/RPC 得到有效 role 时返回 null，让 DSH 保留原文案。
 *
 * 返回值是**不带末尾省略号**的前缀文案（"Explorer running" / "Orchestrator running"）：
 * 它只替换宿主原生文案里的运行前缀（见 replaceNativeStatusPrefix），逗号、用时与末尾省略号
 * 仍来自宿主自己的文本，因此这里追加省略号会渲染出 "running...，用时..." 这种双重标点。
 * @param {object} input - 当前/目标 session id、running、会话摘要、RPC kind 和可选 role。
 * @returns {string|null} 要替换的原生前缀文案，或保持宿主原文的 null。
 */
export function resolveRunningStatusText({ sessionId, currentSessionId, running, session, kind, role } = {}) {
  if (sessionId === void 0 || sessionId === null || sessionId !== currentSessionId || running !== true) return null;
  const markedChild = isPluginChildSession(session);
  const normalizedRole = normalizeStatusRole(role);
  const roleText = normalizedRole === void 0 ? null : STATUS_ROLE_LABELS[normalizedRole] + " running";
  if (kind === "pending" || kind === "unknown") return markedChild ? roleText : null;
  if (kind === "child") return roleText;
  if (kind === "root") return markedChild ? null : "Orchestrator running";
  if (kind !== void 0 && kind !== null) return null;
  if (markedChild) return roleText;
  return "Orchestrator running";
}

/**
 * 文案层（票据 19）：集中消息表 + locale 解析。
 *
 * 设计边界：
 * - 本文件是 Host 与客户端共享语义的**权威副本**；浏览器无法 import 本模块，因此
 *   client-expert-group-model.js 里有一份逐键同值的投影（构建期由装配脚本排在其前执行）。
 *   两份漂移由 test/expert-group-model.test.mjs 的键值对比守住。
 * - 默认语言是 zh；支持 zh / en 两种语言。缺失键回退 zh，zh 也缺失时返回中性占位符，
 *   绝不让空串或键名出现在界面上。
 * - 变量插值只支持 {name} 形式；缺失变量保留原占位符（便于发现调用方漏传），绝不输出 undefined。
 */
export const SUPPORTED_LOCALES = Object.freeze(["zh", "en"]);
export const DEFAULT_LOCALE = "zh";
/** 两份语言表都缺键时的唯一中性占位：绝不显示空串，也绝不把内部键名暴露给用户。 */
export const MISSING_MESSAGE_TEXT = "—";

/**
 * 消息表：扁平点分键 → 各语言文案。
 *
 * 覆盖面（票据 19 范围）：侧栏关键路径、设置页核心控件、系统通知标题/正文、运行状态播报。
 * 角色 persona/提示词与长诊断行不在本表范围（不在本期翻译范围）。
 */
export const MESSAGE_CATALOG = Object.freeze({
  "sidebar.title": { zh: "Expert Group", en: "Expert Group" },
  "sidebar.empty": { zh: "暂无 Expert Group 任务", en: "No Expert Group tasks yet" },
  "sidebar.error.snapshot": { zh: "快照读取失败", en: "Snapshot read failed" },
  "sidebar.error.action": { zh: "操作失败", en: "Action failed" },
  "sidebar.error.rpc": { zh: "请求失败", en: "Request failed" },
  "sidebar.refresh": { zh: "刷新", en: "Refresh" },
  "sidebar.retry": { zh: "重试", en: "Retry" },
  "sidebar.partial": { zh: "数据不完整", en: "Incomplete data" },
  "sidebar.partial.title": {
    zh: "数据不完整：轻量快照已先上屏，状态与任务名可能尚未读取完整",
    en: "Incomplete data: a lightweight snapshot is shown first; statuses and task names may not be fully loaded yet",
  },
  "sidebar.updated": { zh: "更新于 {time}", en: "Updated {time}" },
  "sidebar.updated.title": {
    zh: "最后更新时间（本次数据上屏的时刻）",
    en: "Last update time (when this data was rendered)",
  },
  "sidebar.idleGroup": { zh: "空闲子代理（{count}）", en: "Idle subagents ({count})" },
  "sidebar.idleGroup.name": { zh: "空闲子代理", en: "Idle subagents" },
  "sidebar.search.label": { zh: "任务过滤", en: "Filter tasks" },
  "sidebar.search.aria": { zh: "搜索任务", en: "Search tasks" },
  "sidebar.search.placeholder": { zh: "搜索任务名 / 角色 / 模型", en: "Search task name / role / model" },
  "sidebar.filter.role": { zh: "按角色筛选", en: "Filter by role" },
  "sidebar.filter.status": { zh: "按状态筛选", en: "Filter by status" },
  "sidebar.filter.allRoles": { zh: "全部角色", en: "All roles" },
  "sidebar.filter.allStatuses": { zh: "全部状态", en: "All statuses" },
  "sidebar.filter.empty": { zh: "没有匹配的任务", en: "No matching tasks" },
  "sidebar.collapse": { zh: "收起", en: "Collapse" },
  "sidebar.expand": { zh: "展开", en: "Expand" },
  "sidebar.timeline.showAll": { zh: "查看全部", en: "Show all" },
  "sidebar.recovery.retry": { zh: "重试恢复", en: "Retry recovery" },
  "sidebar.recovery.retrying": { zh: "重试中…", en: "Retrying…" },
  "sidebar.recovery.failed": { zh: "任务恢复失败（{code}）", en: "Task recovery failed ({code})" },
  "sidebar.recovery.retryFailed": { zh: "重试未恢复（{code}）", en: "Retry did not recover ({code})" },
  "sidebar.sessionModel.open": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.title": { zh: "会话模型", en: "Session models" },
  "sidebar.sessionModel.hint": {
    zh: "只影响本会话的专家派发，不改变全局默认；清除后恢复跟随全局默认。",
    en: "Affects expert dispatch in this session only; global defaults are unchanged. Clear an override to follow the global default again.",
  },
  "sidebar.sessionModel.openTitle": {
    zh: "按会话修改专家模型，不影响全局默认",
    en: "Change expert models for this session; global defaults are unchanged",
  },
  "sidebar.sessionModel.close": { zh: "关闭会话模型", en: "Close session models" },
  "sidebar.sessionModel.noSession": {
    zh: "未打开会话：打开一个会话后可在此临时覆盖角色模型。",
    en: "No open session: open a session to temporarily override role models here.",
  },
  "sidebar.sessionModel.child": {
    zh: "当前是子代理会话，会话级模型覆盖只读。",
    en: "This is a subagent session; session model overrides are read-only.",
  },
  "sidebar.sessionModel.loading": { zh: "正在读取本会话覆盖…", en: "Loading session overrides…" },
  "sidebar.sessionModel.unavailable": {
    zh: "本会话覆盖读取失败，请稍后重试。",
    en: "Failed to read session overrides; please retry later.",
  },
  "sidebar.sessionModel.unsupported": {
    zh: "当前宿主版本不支持会话级模型覆盖。",
    en: "This host version does not support session model overrides.",
  },
  "sidebar.sessionModel.offline": {
    zh: "会话未运行：会话级覆盖只读。",
    en: "The session is not running; session overrides are read-only.",
  },
  "sidebar.sessionModel.followGlobal": { zh: "跟随全局默认", en: "Follow global default" },
  "sidebar.sessionModel.override": { zh: "本会话覆盖", en: "Session override" },
  "sidebar.sessionModel.revision": { zh: "代次 {revision}", en: "Revision {revision}" },
  "sidebar.sessionModel.provider": { zh: "供应商", en: "Provider" },
  "sidebar.sessionModel.model": { zh: "模型", en: "Model" },
  "sidebar.sessionModel.effort": { zh: "思考深度", en: "Reasoning effort" },
  "sidebar.sessionModel.effortDefault": { zh: "模型默认", en: "Model default" },
  "sidebar.sessionModel.save": { zh: "保存覆盖", en: "Save override" },
  "sidebar.sessionModel.clear": { zh: "清除", en: "Clear" },
  "sidebar.sessionModel.saving": { zh: "保存中…", en: "Saving…" },
  "sidebar.sessionModel.saved": { zh: "已保存本会话覆盖", en: "Session override saved" },
  "sidebar.sessionModel.cleared": { zh: "已清除，恢复全局默认", en: "Cleared; global default restored" },
  "sidebar.sessionModel.conflict": {
    zh: "其他页面已修改本会话覆盖（当前代次 {revision}）；你的输入已保留，请确认后重试。",
    en: "Another page changed this session's overrides (current revision {revision}); your input was kept, please review and retry.",
  },
  "sidebar.sessionModel.failed": { zh: "保存失败：{message}", en: "Save failed: {message}" },
  "sidebar.sessionModel.retry": { zh: "重新读取", en: "Reload" },
  "sidebar.sessionModel.globalSummary": { zh: "全局：{provider} / {model}", en: "Global: {provider} / {model}" },
  "sidebar.sessionModel.emptyGlobal": { zh: "未配置全局默认", en: "No global default configured" },
  "sidebar.sessionModel.emptyRoles": { zh: "没有可配置的专家角色。", en: "No configurable expert roles." },
  "sidebar.sessionModel.columnRole": { zh: "专家", en: "Expert" },
  "sidebar.sessionModel.columnModel": { zh: "模型选择", en: "Model" },
  "sidebar.sessionModel.tableLabel": { zh: "会话模型覆盖", en: "Session model overrides" },
  "sidebar.sessionModel.saveChanges": { zh: "保存", en: "Save" },
  "sidebar.sessionModel.invalidDraft": {
    zh: "请为已修改的角色选择供应商和模型。",
    en: "Choose a provider and model for every edited role.",
  },
  "sidebar.sessionModel.clearRole": {
    zh: "清除{role}的本会话覆盖",
    en: "Clear the session override for {role}",
  },
  "settings.title": { zh: "dsh-expert-group", en: "dsh-expert-group" },
  "settings.hint": {
    zh: "专家模型使用 DSH 当前已配置的 provider 和模型目录。",
    en: "Expert models use the providers and model catalog configured in DSH.",
  },
  "settings.taskManagement": { zh: "任务管理", en: "Task management" },
  "settings.auto": { zh: "Auto", en: "Auto" },
  "settings.autoTitle": {
    zh: "自动打开运行中的子代理侧栏会话",
    en: "Automatically open running subagent sidebar sessions",
  },
  "settings.notifications": { zh: "通知弹窗", en: "Notifications" },
  "settings.notificationVolume": { zh: "通知音量", en: "Notification volume" },
  "settings.notificationEvents": { zh: "通知事件", en: "Notification events" },
  "settings.notificationVolume.range": { zh: "通知音量滑块", en: "Notification volume slider" },
  "settings.notificationVolume.number": { zh: "通知音量数值", en: "Notification volume value" },
  "settings.notificationEvent.completed": { zh: "任务完成", en: "Task completed" },
  "settings.roleTimeout.aria": { zh: "角色默认超时", en: "Default role timeout" },
  "settings.notificationEvent.completed.aria": { zh: "通知任务完成", en: "Notify on task completed" },
  "settings.notificationEvent.waiting.aria": { zh: "通知等待用户", en: "Notify on waiting for user" },
  "settings.notificationEvent.failed.aria": { zh: "通知任务失败", en: "Notify on task failed" },

  "settings.notificationEvent.waiting": { zh: "等待用户", en: "Waiting for user" },
  "settings.notificationEvent.failed": { zh: "任务失败", en: "Task failed" },

  "settings.unifiedProvider": { zh: "统一供应商", en: "Unified provider" },
  "settings.noProvider": { zh: "无", en: "None" },
  "settings.observerPreferred": { zh: "Observer优先", en: "Prefer Observer" },
  "settings.concurrencyLimit": { zh: "单个角色并发上限", en: "Per-role concurrency limit" },
  "settings.concurrencyLimit.title": {
    zh: "取值范围 1–64 的整数；默认 20；保存后生效",
    en: "An integer from 1–64; defaults to 20; takes effect after saving",
  },
  "settings.roleTimeout": { zh: "角色默认超时 (s)", en: "Default role timeout (s)" },
  "settings.roleTimeout.title": {
    zh: "默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
    en: "Defaults to 10 hours (36000 s); 0 disables it; enabled values are 1–86400 s (integer, 1 s precision). Applies only to attempts created after saving; running shards are unchanged.",
  },
  "settings.save": { zh: "保存", en: "Save" },
  "settings.saving": { zh: "保存中…", en: "Saving…" },
  "settings.discard": { zh: "放弃修改", en: "Discard changes" },
  "settings.saved": { zh: "已保存", en: "Saved" },
  "settings.unsaved": { zh: "有未保存的修改", en: "Unsaved changes" },
  "announce.start": { zh: "任务开始：{name}", en: "Task started: {name}" },
  "announce.finish": { zh: "任务完成：{name}", en: "Task finished: {name}" },
  "announce.fail": { zh: "任务失败：{name}", en: "Task failed: {name}" },
  "announce.cancel": { zh: "任务取消：{name}", en: "Task cancelled: {name}" },
  "announce.more": { zh: "等 {count} 项", en: "and {count} more" },
  "notify.termination.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.termination.completed": { zh: "任务已完成。", en: "Task completed." },
  "notify.termination.blocked": { zh: "任务被阻塞，需要你处理。", en: "Task blocked; your input is needed." },
  "notify.termination.error": { zh: "任务因错误终止。", en: "Task terminated with an error." },
  "notify.termination.aborted": { zh: "任务已中止。", en: "Task aborted." },
  "notify.termination.interrupted": { zh: "任务被中断。", en: "Task interrupted." },
  "notify.termination.max-tokens": { zh: "任务达到 token 上限。", en: "Task reached the token limit." },
  "notify.termination.unknown": { zh: "任务已终止。", en: "Task terminated." },
  "notify.test.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.title": { zh: "Expert Group", en: "Expert Group" },
  "notify.wait.body": { zh: "需要你操作", en: "Your action is required" },
  "notify.test.body": {
    zh: "测试通知：系统通知通道可用。",
    en: "Test notification: the system notification channel is available.",
  },
  "notify.waitLong.body": {
    zh: "专家任务已等待超过 30 分钟仍未结算。若权威查询确认没有运行中的后代，可用 dsh_expert_group_abandon_wait 手动关闭等待账本；它不会终止专家，也不会释放影响范围保护。",
    en: "The expert task has been waiting more than 30 minutes without settling. If an authoritative query confirms no running descendants, use dsh_expert_group_abandon_wait to close the wait ledger manually; it neither stops experts nor releases impact-scope protection.",
  },
  "notify.waitQueryDegraded.body": {
    zh: "无法确认专家后代的运行状态（后代查询降级或失败），root turn 会继续等待；未知状态不等于专家已完成。",
    en: "The running state of expert descendants cannot be confirmed (descendant query degraded or failed); the root turn keeps waiting. Unknown is not the same as completed.",
  },
  "notify.waitDeliveryFailed.body": {
    zh: "专家批次已静止，但收口结论投递失败；批次保持待收口，插件会在后续 root turn 重试。",
    en: "The expert batch is quiescent but delivering the finalization result failed; the batch remains pending and the plugin retries on later root turns.",
  },
});

/**
 * 语言标识归一：`zh-CN` / `zh_TW` / `EN-us` 都归一为主语言子标签；不支持的返回 null。
 * @param {unknown} value
 * @returns {"zh"|"en"|null}
 */
export function normalizeLocale(value) {
  if (typeof value !== "string") return null;
  const primary = value.trim().toLowerCase().split(/[-_]/)[0];
  if (primary === "zh") return "zh";
  if (primary === "en") return "en";
  return null;
}

/**
 * 按候选顺序解析语言：返回第一个受支持的 locale，全部不可识别时回退默认 zh。
 * 纯函数（不读环境），便于测试注入。
 */
export function resolveLocale(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const normalized = normalizeLocale(candidate);
    if (normalized !== null) return normalized;
  }
  return DEFAULT_LOCALE;
}

/**
 * 取一条文案并做变量插值（缺失键回退 zh；两份都缺失返回中性占位，绝不显示空串或键名）。
 * @param {string} locale - zh / en（其它值按默认 zh 处理）。
 * @param {string} key - 消息表键。
 * @param {Record<string, unknown>} [vars] - {name} 形式的插值变量。
 */
export function translateMessage(locale, key, vars = {}) {
  const normalized = normalizeLocale(locale) ?? DEFAULT_LOCALE;
  const entry = MESSAGE_CATALOG[key];
  if (entry === void 0 || entry === null) return MISSING_MESSAGE_TEXT;
  const template = typeof entry[normalized] === "string" && entry[normalized].length > 0
    ? entry[normalized]
    : (typeof entry[DEFAULT_LOCALE] === "string" ? entry[DEFAULT_LOCALE] : "");
  if (template.length === 0) return MISSING_MESSAGE_TEXT;
  const values = vars !== null && typeof vars === "object" ? vars : {};
  return template.replace(/\{([a-z][a-z0-9_]*)\}/gi, (match, name) => {
    const value = values[name];
    return value === void 0 || value === null ? match : String(value);
  });
}

/**
 * Host 侧 locale 解析顺序：config.locale → 环境 LANG/LC_ALL/LC_MESSAGES → Intl 运行时 locale → zh。
 *
 * 「无法可靠获取」= 所有候选都无法归一成受支持语言（缺失、空串、fr 等）。此时回退 zh 并调用
 * onFallback（组合根用它记一条 warn），绝不静默切换到 en 或抛出。
 * @param {{configLocale?:unknown, env?:Record<string,unknown>, intl?:{DateTimeFormat?:Function}, onFallback?:Function}} [options]
 */
export function resolveHostLocale(options = {}) {
  const env = options.env ?? {};
  const candidates = [options.configLocale, env.LC_ALL, env.LC_MESSAGES, env.LANG];
  const recognized = candidates.filter((candidate) => normalizeLocale(candidate) !== null);
  if (recognized.length === 0) {
    let intlLocale = null;
    try {
      const intl = options.intl ?? (typeof Intl !== "undefined" ? Intl : null);
      intlLocale = intl?.DateTimeFormat?.().resolvedOptions?.().locale ?? null;
    } catch { intlLocale = null; }
    if (normalizeLocale(intlLocale) === null) {
      try { options.onFallback?.({ reason: "locale-unresolved" }); } catch { /* 记录失败不影响通知。 */ }
      return DEFAULT_LOCALE;
    }
    return normalizeLocale(intlLocale);
  }
  return resolveLocale(recognized);
}

/**
 * 原生运行状态行的可替换前缀候选（票据 19：中文/英文 locale 都生效）。
 *
 * 顺序即匹配优先级：中文宿主用「深度求索中」，英文宿主可能是 "Deep diving" / "Deep thinking" /
 * "Thinking"。只替换原文中**最早出现**的候选中第一个（同一位置优先更长的候选），未知前缀仍
 * fail-closed（返回 null，保持宿主原文）。
 */
export const NATIVE_RUNNING_STATUS_PREFIXES = Object.freeze([
  "深度求索中",
  "Deep diving",
  "Deep thinking",
  "Thinking",
]);

/**
 * 向后兼容的单一前缀导出：保留旧名字给既有消费方读取，值仍是中文主前缀。
 * 新代码必须使用 NATIVE_RUNNING_STATUS_PREFIXES（中英文都生效）。
 */
export const NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIXES[0];

/**
 * 只替换原生运行前缀的纯函数（fail-closed）。
 *
 * 边界语义：
 * - 原文里没有任何候选前缀时返回 null：调用方必须保持宿主原文案，绝不猜测或整行重建；
 * - 只替换**第一处**出现（中英文候选混排时取原文中最靠前的那个；同位置优先更长的候选），
 *   其余内容逐字节保留（分隔逗号、用时、末尾省略号、空白与大小写）；
 * - 原文或替换文案不是非空字符串时返回 null。
 * @param {unknown} currentText - 宿主当前渲染的原生文案。
 * @param {unknown} replacementText - 角色文案（例如 "Explorer running"，不带省略号）。
 * @returns {string|null} 替换后的完整文案；没有可替换前缀时返回 null。
 */
export function replaceNativeStatusPrefix(currentText, replacementText) {
  if (typeof currentText !== "string" || currentText.length === 0) return null;
  if (typeof replacementText !== "string" || replacementText.length === 0) return null;
  let match = null;
  for (const prefix of NATIVE_RUNNING_STATUS_PREFIXES) {
    const at = currentText.indexOf(prefix);
    if (at === -1) continue;
    if (match === null || at < match.at || (at === match.at && prefix.length > match.prefix.length)) {
      match = { at, prefix };
    }
  }
  if (match === null) return null;
  return currentText.slice(0, match.at) + replacementText + currentText.slice(match.at + match.prefix.length);
}

/**
 * 创建只操作一个原生文本节点的前缀重写器。
 *
 * DOM 适配、MutationObserver 与 React 生命周期由 client.js 持有；本函数只处理
 * 「原生前缀 → 角色文案」的保存/替换/恢复，因此可在无 DOM 的 node:test 中用最小 mock 验证。
 * 它永远不触碰 class/style、兄弟计时器、aria 属性或其它节点，也不重建整行。
 *
 * 原文跟进规则（同一个 Text 节点上的内容随时可能被宿主改写）：
 * - 角色变化：只换前缀，逗号/用时/末尾省略号继续沿用宿主最新原文；
 * - 宿主重渲染、locale 切换或用时刷新：当前值不再是本插件写入的那一份时，把宿主最新值
 *   认定为原文，清理时恢复它——绝不把旧语言或旧用时写回去；
 * - 原文没有原生前缀（例如英文 locale 的 "Deep diving..."）时不做任何写入。
 *
 * 可选 decorate/undecorate 钩子仅用于调用方管理附加生命周期；当前原生状态桥不传入
 * 任何装饰钩子，因此不会向宿主节点添加 marker、样式或动画。rewriter 仍保证换目标和
 * 清理时先处理旧目标，避免调用方留下 stale 状态。
 * @param {object} options - findNode/getText/setText/isConnected/decorate/undecorate 适配函数。
 * @returns {{apply:(text:string|null)=>void, restore:()=>void}}
 */
export function createNativeTextRewriter(options = {}) {
  const findNode = typeof options.findNode === "function" ? options.findNode : () => void 0;
  const getText = typeof options.getText === "function" ? options.getText : (node) => node?.nodeValue;
  const setText = typeof options.setText === "function" ? options.setText : (node, value) => { node.nodeValue = value; };
  const isConnected = typeof options.isConnected === "function" ? options.isConnected : (node) => node?.isConnected !== false;
  const decorate = typeof options.decorate === "function" ? options.decorate : () => {};
  const undecorate = typeof options.undecorate === "function" ? options.undecorate : () => {};
  let activeNode;
  let originalText;
  let rewrittenText;

  function restore() {
    // 只在"当前值仍是我们写入的那一份"时回写：宿主已自行改写内容时保持宿主最新值，
    // 避免把旧语言、旧用时或旧角色文案盖回去。
    if (activeNode !== void 0 && isConnected(activeNode) && getText(activeNode) === rewrittenText) {
      setText(activeNode, originalText);
    }
    activeNode = void 0;
    originalText = void 0;
    rewrittenText = void 0;
    undecorate();
  }

  function apply(text) {
    if (typeof text !== "string" || text.length === 0) {
      restore();
      return;
    }
    const candidate = findNode();
    if (candidate === null || candidate === void 0) {
      restore();
      return;
    }
    const currentText = getText(candidate);
    if (activeNode !== candidate) {
      restore();
      activeNode = candidate;
      originalText = currentText;
    } else if (currentText !== rewrittenText) {
      // DSH 在同一 Text 节点上更新原文（locale 切换、用时刷新、React 重写）；
      // 跟进外部值，清理时恢复的必须是最新原文。
      originalText = currentText;
    }
    const next = replaceNativeStatusPrefix(originalText, text);
    // 没有可替换的原生前缀（英文 locale、宿主已换成完成文案等）时保持原文，不做任何写入。
    rewrittenText = next === null ? currentText : next;
    if (next !== null && currentText !== next) setText(activeNode, next);
    // 装饰放在文本写入之后：无论首次接管、节点替换还是重复通知，装饰都针对当前目标。
    decorate(activeNode);
  }

  return { apply, restore };
}

/**
 * 视为「当前未运行」的 Agent 状态集合。
 *
 * 默认 `["idle", "ready"]` 保持 0.1.x 的兼容语义（ready 只是「两轮之间」）；DSH rc.2 的
 * `Agent.status` 只有 `idle` / `running`，因此等待判定传入 `["idle"]`，让 `ready` 落到
 * 「状态非法」→ `known:false`（fail-closed），绝不被当成空闲。
 */
const DEFAULT_IDLE_STATUSES = Object.freeze(["idle", "ready"]);

function normalizeIdleStatuses(value) {
  if (!Array.isArray(value)) return new Set(DEFAULT_IDLE_STATUSES);
  const statuses = value.filter((item) => typeof item === "string" && item.length > 0);
  return statuses.length > 0 ? new Set(statuses) : new Set(DEFAULT_IDLE_STATUSES);
}

/**
 * runtime agents.list() 快照的后代索引：**唯一**的血缘/身份/状态校验实现。
 *
 * 续接对话时插件本地 tracker 可能为空，因此判定只能依赖 runtime Agent 自身的 exact
 * 血缘（`session.header.parentSession` 链）与状态字段：parentSession 链最终指向 rootId
 * 的 Agent 才算这个 root 的后代；root 自身、其他 root 与非 subagent 运行时 Agent 都不计入。
 *
 * 校验规则（任一不成立都返回 known:false，绝不猜测）：
 * - 列表不是数组、条目不是对象、id 缺失或**重复**、header 不是非数组 object；
 * - `origin` 存在但不是 string（`origin: null` 等既非 subagent 也非已确认 foreign）；
 * - **当前 root 自己**出现在快照里却声称有父会话（root -> child -> root 环）或父字段无效；
 * - 显式声明 subagent 却没有父会话、父会话字段非法、父链成环或链上父级不在 live 列表；
 * - 状态不是字符串，或既不是 running 也不在 idleStatuses 里（rc.2 严格模式下 ready 即非法）。
 *
 * rootId 优先级：当前 exact root 永远先判为「本树」，即使它自身显式声明非 subagent 的
 * origin（例如 `"user"`）也不会被 foreign 分类排除，它的正常 subagent child / 孙辈仍算后代；
 * 其他已确认 foreign 的顶层会话能证明其整支不属于当前 root（false），但真正缺父、非 root 环、
 * 重复 id、非法状态或 subagent 无父会话仍然 fail-closed。空列表是可信的空状态。
 *
 * @param {unknown} agents - agents.list() 返回的 live Agent 数组。
 * @param {string} rootId - 当前 exact root id。
 * @param {{idleStatuses?:string[]}} [options] 视为「当前未运行」的状态集合。
 * @returns {{known:boolean, reason?:string, descendants:Map<string,object>}} 后代索引
 *   （id → { parentSession, status, node }）。
 */
export function collectRuntimeRootDescendants(agents, rootId, options = {}) {
  const idleStatuses = normalizeIdleStatuses(options?.idleStatuses);
  const unknown = (reason = "runtime-descendant-identity-unknown") => ({
    known: false, reason, descendants: new Map(),
  });
  if (typeof rootId !== "string" || rootId.length === 0 || !Array.isArray(agents)) {
    return unknown("runtime-child-query-unknown");
  }
  // 第一遍：只建立可解释的血缘索引；任何一条无法解释的记录都直接保守失败，
  // 因为无法证明它不属于当前 root 的子树。
  const index = new Map();
  for (const node of agents) {
    if (node === null || typeof node !== "object") return unknown();
    const id = node.id;
    if (typeof id !== "string" || id.length === 0) return unknown();
    // 同一 id 出现两次（同 id 新旧 Agent 并存）无法区分代际，不能猜测。
    if (index.has(id)) return unknown("runtime-agent-duplicate-id");
    const header = node.session?.header;
    // header 必须是非 null、非数组的 object：数组 / 字符串等无法解释，绝不能当成
    // 「没有父会话的顶层会话」而放行。
    if (header === null || typeof header !== "object" || Array.isArray(header)) return unknown();
    const parentSession = header.parentSession;
    const origin = header.origin;
    // origin 若存在必须是 string：`origin: null` / 数字等既不是 subagent 也不是已确认
    // foreign，归属无法解释 ⇒ 未知。`origin === undefined` 保持兼容（历史 host 不写该字段）。
    if (origin !== void 0 && typeof origin !== "string") {
      return unknown("runtime-agent-origin-invalid");
    }
    // 当前 root 自己出现在快照里时**必须**符合 DEG root 身份：parentSession 必须缺省。
    // 否则 root -> child -> root 这类环会被第二遍的 rootId 捷径掩盖（rootId 只是 memo 的
    // 初值，不能代替 header 校验）。任何字符串 parentSession 或无效父字段都不可解释。
    if (id === rootId) {
      if (parentSession !== void 0) return unknown("runtime-root-parent-conflict");
      index.set(id, { root: true });
      continue;
    }
    // 非 subagent origin 的 runtime Agent（另一个 root、fork/副本会话等）不属于任何专家子树。
    if (typeof origin === "string" && origin !== "subagent") {
      index.set(id, { foreign: true });
      continue;
    }
    if (parentSession === void 0) {
      // 显式声明 subagent 却没有父会话：身份自相矛盾，无法归属。
      if (origin === "subagent") return unknown();
      index.set(id, { parentSession: void 0 });
      continue;
    }
    if (typeof parentSession !== "string" || parentSession.length === 0) return unknown();
    index.set(id, { parentSession, status: node.status, node });
  }

  // 第二遍：按父链归属。memo 里已知归属的节点不重复回溯；成环或父级缺失都返回未知。
  const lineage = new Map([[rootId, true]]);
  // 已确认 foreign 的 runtime Agent（非 subagent origin，例如另一个 root 的 `"user"` 会话）
  // **先验地**不属于当前 root：父链在它那里终止时，整支都能被证明「不是当前 root 的后代」
  // （false），而不是未知——否则另一个 root 的专家子树会让当前 root 永久 fail-closed。
  // 顺序保护：rootId 自己先入 memo（lineage 初始化即含 true），因此即使当前 root 自身带
  // 非 subagent origin，也永远优先判为「本树」。
  for (const [id, entry] of index) {
    if (entry.foreign === true && id !== rootId) lineage.set(id, false);
  }
  const isDescendant = (id, visiting) => {
    if (lineage.has(id)) return lineage.get(id);
    if (visiting.has(id)) return void 0;
    const entry = index.get(id);
    // 未知 id / 未登记的 foreign 条目：前者仍然未知（绝不猜测），后者只可能是「非本树」。
    if (entry === void 0) return void 0;
    if (entry.foreign === true) return false;
    visiting.add(id);
    // 父链在另一个顶层会话处终止：该 Agent 属于那个 root，不是当前 root 的后代。
    const resolved = entry.parentSession === void 0 ? false : isDescendant(entry.parentSession, visiting);
    if (resolved !== void 0) lineage.set(id, resolved);
    return resolved;
  };

  const descendants = new Map();
  for (const [id, entry] of index) {
    // root 自身不是自己的后代；非 subagent 运行时 Agent 已在上一步排除。
    if (id === rootId || entry.foreign === true) continue;
    const descendant = isDescendant(id, new Set());
    if (descendant === false) continue;
    // 血缘链断裂（父级不在 live 列表里）时无法证明它不在当前子树内，只能 fail closed。
    if (descendant === void 0) return unknown("runtime-descendant-lineage-unknown");
    if (typeof entry.status !== "string") return unknown();
    // running 或「明确未运行」之外的任何状态（含 rc.2 里不存在的 ready）都不能当成空闲。
    if (entry.status !== "running" && !idleStatuses.has(entry.status)) {
      return unknown("runtime-descendant-status-unknown");
    }
    descendants.set(id, entry);
  }
  return { known: true, descendants };
}

/**
 * 递归判断当前 root 的全部后代 runtime Agent 是否仍在运行（通知/终止门控使用）。
 *
 * 复用 collectRuntimeRootDescendants 的同一份校验；返回形状保持既有契约不变。
 *
 * @param {unknown} agents - agents.list() 返回的 live Agent 数组。
 * @param {string} rootId - 当前 exact root id。
 * @param {{idleStatuses?:string[]}} [options] 视为「当前未运行」的状态集合。
 */
export function evaluateRunningRootDescendants(agents, rootId, options = {}) {
  const built = collectRuntimeRootDescendants(agents, rootId, options);
  if (built.known !== true) {
    return {
      known: false,
      blocked: true,
      reason: built.reason ?? "runtime-descendant-identity-unknown",
      runningDescendants: [],
    };
  }
  const runningDescendants = [];
  for (const entry of built.descendants.values()) {
    if (entry.status === "running") runningDescendants.push(entry.node);
  }
  return {
    known: true,
    blocked: runningDescendants.length > 0,
    ...(runningDescendants.length > 0 ? { reason: "runtime-running-descendant" } : {}),
    runningDescendants,
  };
}

/**
 * 同步读取 runtime agents.list() 并转换为终止门控可消费的快照。
 * 查询缺失、抛错或非数组结果均为未知；终止判定必须 fail closed。
 * @param {unknown} list - 读取 live Agent 的函数（通常是 () => agents.list()）。
 * @param {string} rootId - 当前 exact root id。
 */
export function snapshotRunningRootDescendants(list, rootId, options = {}) {
  if (typeof list !== "function") {
    return { known: false, blocked: true, reason: "runtime-child-query-unknown", runningDescendants: [] };
  }
  try {
    return evaluateRunningRootDescendants(list(), rootId, options);
  } catch {
    return { known: false, blocked: true, reason: "runtime-child-query-unknown", runningDescendants: [] };
  }
}

// ── 模型候选与启动前 fallback（票据 24）────────────────────────────────────
//
// 这一节只放**纯函数/常量**：设置归一、候选计划与错误分类都不依赖 Host 服务，
// 因此组合根、Host 投影模块与测试可以共用同一套判定，避免出现第二份实现。
// 任何函数都不得读取凭据或 prompt；错误分类只返回稳定 code，绝不返回原始 message。

/** 自动降级默认上限（每任务每角色最多 2 次降级）。 */
export const DEFAULT_MODEL_FALLBACK_LIMIT = 2;
/** 自动降级上限的硬上限：防止链式降级放大成本。 */
export const MAX_MODEL_FALLBACK_LIMIT = 4;
/** 每个角色允许配置的候选模型数量上限。 */
export const MAX_MODEL_CANDIDATES_PER_ROLE = 8;

/** 全部候选都不可用时使用的稳定错误码（ValidationError.code）。 */
export const MODEL_CANDIDATES_EXHAUSTED = "MODEL_CANDIDATES_EXHAUSTED";
/** 预检成功的稳定状态码（只用于 RPC 投影，不写入子代理快照）。 */
export const MODEL_ROUTE_OK = "OK";
/** 角色尚未配置主模型时预检 RPC 的状态码。 */
export const MODEL_ROUTE_NOT_CONFIGURED = "NOT_CONFIGURED";

/**
 * 模型解析失败的稳定分类码。
 *
 * 只有预检类失败允许触发启动前 fallback；运行期错误（429/5xx/超时/取消）绝不进入
 * 这里的分类集合，必须原样上抛。
 */
export const MODEL_ROUTE_ERROR_CODES = Object.freeze({
  INVALID_SELECTION: "INVALID_SELECTION",
  MODEL_NOT_FOUND: "MODEL_NOT_FOUND",
  PROVIDER_NOT_FOUND: "PROVIDER_NOT_FOUND",
  CREDENTIAL_UNAVAILABLE: "CREDENTIAL_UNAVAILABLE",
  CATALOG_UNAVAILABLE: "CATALOG_UNAVAILABLE",
  UNSUPPORTED_REASONING_EFFORT: "UNSUPPORTED_REASONING_EFFORT",
  UNSUPPORTED_CAPABILITY: "UNSUPPORTED_CAPABILITY",
  /**
   * 提供方限流（HTTP 429 / rate limit / 配额）的稳定原因码（票据 26）。
   *
   * 为什么单独一个码：429 在「派发前」与「运行中」两个阶段都**不得**触发自动换模型
   * ——派发前由 provider 名额排队承担，运行中由宿主请求级退避重试承担。因此它必须
   * 与 ROUTE_RESOLUTION_FAILED（未知解析失败）区分开，才能让诊断、快照
   * （lastRouteErrorCode）与 shard 错误投影如实说明「这是限流，不是模型不可用」。
   *
   * 它**不在** PRECHECK_MODEL_ROUTE_ERROR_CODE_SET 里：isPrecheckModelRouteFailure()
   * 对它恒为 false，executeModelRoutePlan 因此立即上抛、绝不尝试下一个候选。
   */
  PROVIDER_RATE_LIMITED: "PROVIDER_RATE_LIMITED",
  ROUTE_RESOLUTION_FAILED: "ROUTE_RESOLUTION_FAILED",
});

const MODEL_ROUTE_ERROR_CODE_SET = new Set(Object.values(MODEL_ROUTE_ERROR_CODES));

/** 允许在启动前触发降级的错误码集合（模型/provider/凭据/目录/能力/形状）。 */
const PRECHECK_MODEL_ROUTE_ERROR_CODE_SET = new Set([
  MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION,
  MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND,
  MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND,
  MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE,
  MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE,
  MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT,
  MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY,
]);

/**
 * agentOptions 上的实际路由 marker。
 *
 * 与其它 marker 一样只存在于 agent options / child_models，不进入任务 prompt；
 * 冷恢复时 Host 不还原 agentOptions，因此真正权威的来源仍是 child_models 的扁平字段。
 */
export const EXPERT_ROUTE_MARKER = "__degExpertRoute";

/**
 * agentOptions 上的目标 subagent provider marker（票据 29）。
 *
 * 记录本次 child 实际使用的 subagent provider 名（"spawn" 或继承型 fork provider）。
 * 与其它 marker 一样只存在于 agent options / child_models，不进入任务 prompt；
 * 冷恢复时 Host 不还原 agentOptions，因此权威来源仍是 child_models 的扁平字段
 * `subagentProvider`。它的作用有二：
 * 1. agent/created 在持久化前就能读到本次派发选择的 provider；
 * 2. 恢复/重建路径只读该快照，不按当前设置重新选择（绝不把继承型 child 静默改回 spawn）。
 */
export const EXPERT_SUBAGENT_PROVIDER_MARKER = "__degExpertSubagentProvider";

/**
 * agentOptions 上的上下文继承 marker（票据 29）。
 *
 * 只有布尔值才是合法快照：true 表示该 child 使用继承型 provider（seed 来自父日志的
 * 已完成 turn 前缀），false/缺失表示普通 spawn。投影侧缺失时省略字段，绝不伪造 false。
 */
export const EXPERT_INHERIT_CONTEXT_MARKER = "__degExpertInheritContext";

/**
 * 上下文继承的稳定错误码（票据 29）。
 *
 * - `UNAVAILABLE`：宿主没有可用的继承型 provider（未注册、缺 prepareContinuable、
 *   inheritsParentContext !== true 或能力位不足），或 legacy 路径不支持 fork；
 * - `EMPTY`：父会话日志可读但没有任何已完成 turn，无法构造继承 seed。
 *
 * 两者都必须显式失败，绝不静默回退 spawn（那会把“继承上下文”降级成“无上下文”）。
 */
export const CONTEXT_INHERITANCE_ERROR_CODES = Object.freeze({
  UNAVAILABLE: "CONTEXT_INHERITANCE_UNAVAILABLE",
  EMPTY: "CONTEXT_INHERITANCE_EMPTY",
});

/**
 * 允许开启上下文继承的内置角色集合（票据 29）。
 *
 * 只包含内置非 Observer 角色：Observer 的安全边界是“只接收视觉任务、不接收用户上下文”，
 * 因此不允许出现在设置映射里。
 */
export const CONTEXT_INHERITANCE_ROLE_IDS = Object.freeze(ROLES.slice());

/** 自动降级上限归一：只接受 0..4 的安全整数，非法/缺失回退默认 2。 */
export function normalizeModelFallbackLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MODEL_FALLBACK_LIMIT
    ? value
    : DEFAULT_MODEL_FALLBACK_LIMIT;
}

/**
 * 单条模型选择的严格形状归一。
 *
 * provider/model 必须是非空字符串；reasoningEffort 只接受字符串或缺省（undefined/null/
 * 空串都表示未指定）。非法形状返回 undefined，由调用方决定是拒绝保存还是跳过候选。
 * 该函数**不做 trim**：与既有 settings/defaults 语义保持一致，模型名逐字匹配。
 */
export function normalizeModelSelection(selection) {
  if (selection === null || typeof selection !== "object" || Array.isArray(selection)) return undefined;
  if (typeof selection.provider !== "string" || selection.provider.length === 0) return undefined;
  if (typeof selection.model !== "string" || selection.model.length === 0) return undefined;
  const rawEffort = selection.reasoningEffort;
  if (rawEffort !== undefined && rawEffort !== null && rawEffort !== "" && typeof rawEffort !== "string") return undefined;
  const effort = typeof rawEffort === "string" && rawEffort.length > 0 ? rawEffort : undefined;
  return {
    provider: selection.provider,
    model: selection.model,
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
  };
}

/**
 * 单条模型选择的比较键：provider + model + 规范化 effort。
 *
 * 规范化 effort 指 undefined/null/空串视为同一档“未指定”；这样重复候选判定不会因为
 * 旧配置里的空串 effort 与缺省字段不同而漏判。非对象/缺 provider/model 返回空串。
 */
export function modelSelectionKeyOf(selection) {
  const normalized = normalizeModelSelection(selection);
  if (normalized === undefined) return "";
  return normalized.provider + "\u0000" + normalized.model + "\u0000" + (normalized.reasoningEffort ?? "");
}

/** 稳定错误码准入：只接受本模块声明的枚举，拒绝把任意字符串写进快照。 */
export function normalizeModelRouteErrorCode(value) {
  if (typeof value !== "string") return undefined;
  return MODEL_ROUTE_ERROR_CODE_SET.has(value) ? value : undefined;
}

/**
 * 把一次模型解析错误分类为稳定 code。
 *
 * 分类顺序：显式 causeCode → code/name 枚举 → HTTP 状态 → 保守的消息模式。
 * 只有明确的预检类失败会被归类为可降级 code；未知错误、5xx、超时一律是
 * ROUTE_RESOLUTION_FAILED（非预检），限流是 PROVIDER_RATE_LIMITED（同样非预检），
 * 调用方必须原样抛出而不是切换候选。
 */
export function classifyModelRouteError(error) {
  const explicit = normalizeModelRouteErrorCode(error?.causeCode);
  if (explicit !== undefined) return explicit;
  const rawCode = typeof error?.code === "string" ? error.code.trim() : "";
  const rawName = typeof error?.name === "string" ? error.name.trim() : "";
  const token = (rawCode || rawName).toUpperCase().replace(/[\s-]+/g, "_");
  if (token.length > 0) {
    // 限流（票据 26）：单独归类为 PROVIDER_RATE_LIMITED，既保留“非预检、绝不换候选”
    // 的既有判定，又能让诊断区分「provider 限流」与「未知解析失败」。
    if (["RATE_LIMIT", "RATE_LIMIT_EXCEEDED", "RATE_LIMITED", "TOO_MANY_REQUESTS", "PROVIDER_RATE_LIMITED", "QUOTA_EXCEEDED"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    }
    if (["OVERLOADED", "ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "TIMEOUT", "ABORT_ERR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
    }
    if (["UNSUPPORTED_REASONING_EFFORT", "UNSUPPORTEDREASONINGEFFORTERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT;
    }
    if (["MODEL_NOT_FOUND", "ERR_MODEL_NOT_FOUND", "MODELNOTFOUNDERROR", "UNKNOWN_MODEL"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    }
    if (["PROVIDER_NOT_FOUND", "PROVIDERNOTFOUNDERROR", "UNKNOWN_PROVIDER"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND;
    }
    if (["CREDENTIAL_UNAVAILABLE", "MISSING_CREDENTIAL", "MISSING_API_KEY", "NO_API_KEY", "AUTH_FAILED", "AUTHENTICATIONERROR", "CREDENTIALERROR", "UNAUTHORIZED", "INVALID_API_KEY"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    }
    if (["CATALOG_UNAVAILABLE", "MODEL_DIRECTORY_UNAVAILABLE", "DIRECTORY_UNAVAILABLE", "ENOENT"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE;
    }
    if (["UNSUPPORTED_CAPABILITY", "CAPABILITY_INCOMPATIBLE", "UNSUPPORTED_INPUT", "UNSUPPORTED_IMAGE", "UNSUPPORTEDTOOLERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY;
    }
    if (["INVALID_SELECTION", "INVALID_MODEL_SELECTION", "INVALIDSELECTIONERROR"].includes(token)) {
      return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    }
  }
  const status = Number(error?.statusCode ?? error?.status ?? error?.httpStatus ?? error?.response?.status);
  if (Number.isInteger(status)) {
    if (status === 401 || status === 403) return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    if (status === 404) return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    if (status === 400 || status === 422) return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    // 429 是限流（票据 26 的稳定原因码），5xx 仍是未知解析失败；两者都不可降级。
    if (status === 429) return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    if (status >= 500) return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
  }
  const message = typeof error?.message === "string" ? error.message : "";
  if (message.length > 0) {
    // 限流文本（429 / rate limit / 限流 / 配额）归 PROVIDER_RATE_LIMITED；
    // 超时与 overload 仍按未知解析失败处理（它们是不同的运行期失败形态）。
    if (/rate.?limit|too many requests|\b429\b|限流|配额/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED;
    }
    if (/overload|超时|timed?\s*out/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
    }
    if (/(model|模型).{0,24}(not found|does not exist|unknown|不存在|未找到|已移除)/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND;
    }
    if (/(provider|提供方).{0,24}(not found|unknown|不存在|未找到)/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND;
    }
    if (/credential|api.?key|unauthor|authenticat|missing key|凭据|密钥|鉴权/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE;
    }
    if (/catalog|directory|模型目录|目录不可用/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE;
    }
    if (/unsupported.{0,24}(reasoning|effort|capabilit|input|image)|not support|不支持.{0,24}(档位|能力|思考|输入)/i.test(message)) {
      return /effort|reasoning|档位|思考/i.test(message)
        ? MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT
        : MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY;
    }
    if (/invalid.{0,16}(selection|model)|模型选择/i.test(message)) {
      return MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION;
    }
  }
  return MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
}

/** 读取错误上的稳定 code：优先显式 causeCode，否则按分类器推断。 */
export function modelRouteErrorCodeOf(error) {
  return normalizeModelRouteErrorCode(error?.causeCode) ?? classifyModelRouteError(error);
}

/** 该错误是否属于启动前可降级的预检类失败。 */
export function isPrecheckModelRouteFailure(error) {
  return PRECHECK_MODEL_ROUTE_ERROR_CODE_SET.has(modelRouteErrorCodeOf(error));
}

/** 预检类错误码的只读判定（供投影层拒绝任意字符串进入快照）。 */
export function isModelRouteErrorCode(value) {
  return MODEL_ROUTE_ERROR_CODE_SET.has(value);
}

/** 稳定 code 的中文可读原因（不包含原始 message/凭据/prompt）。 */
export function modelRouteErrorMessage(code) {
  switch (code) {
    case MODEL_ROUTE_OK: return "可用";
    case MODEL_ROUTE_NOT_CONFIGURED: return "尚未配置模型";
    case MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION: return "模型选择不完整或类型无效";
    case MODEL_ROUTE_ERROR_CODES.MODEL_NOT_FOUND: return "模型不存在或已被移除";
    case MODEL_ROUTE_ERROR_CODES.PROVIDER_NOT_FOUND: return "provider 不存在";
    case MODEL_ROUTE_ERROR_CODES.CREDENTIAL_UNAVAILABLE: return "provider 凭据不可用";
    case MODEL_ROUTE_ERROR_CODES.CATALOG_UNAVAILABLE: return "模型目录不可用";
    case MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT: return "模型不支持该思考档位";
    case MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY: return "模型能力不兼容";
    case MODEL_ROUTE_ERROR_CODES.PROVIDER_RATE_LIMITED: return "提供方限流（429/配额），需要退避重试";
    case MODEL_CANDIDATES_EXHAUSTED: return "所有模型候选均不可用";
    default: return "模型解析失败";
  }
}

/**
 * 构造有序路由计划：[primary, candidate1, candidate2, ...]。
 *
 * - 最多 1 + fallbackLimit 个可尝试项；fallbackLimit=0 时只有 primary；
 * - 与 primary 或更早候选完全重复（同一 provider+model+规范化 effort）的候选项被跳过，
 *   且不占用降级次数；
 * - candidateIndex 保留候选在**原始配置里的位置**（primary=0，第一个候选=1），
 *   因此重复项被跳过后，实际使用的候选索引仍然可解释。
 *
 * @param {unknown} primary - 生效主选择（可能是会话覆盖）。
 * @param {unknown[]} candidates - 全局候选列表（有序）。
 * @param {unknown} fallbackLimit - 自动降级上限。
 * @returns {{plan: Array<{selection: unknown, candidateIndex: number}>, requestedPrimary: object|undefined, fallbackLimit: number}}
 */
export function buildModelRoutePlan(primary, candidates, fallbackLimit) {
  const limit = normalizeModelFallbackLimit(fallbackLimit);
  const normalizedPrimary = normalizeModelSelection(primary);
  const plan = [{ selection: normalizedPrimary ?? primary, candidateIndex: 0 }];
  const seen = new Set();
  if (normalizedPrimary !== undefined) seen.add(modelSelectionKeyOf(normalizedPrimary));
  const list = Array.isArray(candidates) ? candidates.slice(0, MAX_MODEL_CANDIDATES_PER_ROLE) : [];
  let added = 0;
  for (let index = 0; index < list.length && added < limit; index += 1) {
    const normalized = normalizeModelSelection(list[index]);
    const key = normalized === undefined ? "" : modelSelectionKeyOf(normalized);
    if (key.length > 0 && seen.has(key)) continue;
    if (key.length > 0) seen.add(key);
    plan.push({ selection: normalized ?? list[index], candidateIndex: index + 1 });
    added += 1;
  }
  return { plan, requestedPrimary: normalizedPrimary, fallbackLimit: limit };
}

/**
 * 从子代理持久化记录/运行期 marker 投影实际路由字段（票据 24）。
 *
 * 缺失字段直接省略，绝不补 0：只有真正记录过 candidateIndex=0（primary）时才会输出 0。
 * lastRouteErrorCode 只接受本模块声明的稳定码，避免任意字符串进入快照。
 */
export function projectModelRouteFields(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const projected = {};
  if (Number.isSafeInteger(source.candidateIndex) && source.candidateIndex >= 0) projected.candidateIndex = source.candidateIndex;
  if (Number.isSafeInteger(source.fallbackCount) && source.fallbackCount >= 0) projected.fallbackCount = source.fallbackCount;
  const code = normalizeModelRouteErrorCode(source.lastRouteErrorCode);
  if (code !== undefined) projected.lastRouteErrorCode = code;
  return projected;
}

/**
 * 校验并归一 agentOptions 上的路由 marker。
 *
 * candidateIndex/fallbackCount 必须是非负安全整数；requestedPrimary 可选但出现时必须是
 * 合法选择；lastRouteErrorCode 可选但只接受稳定码。形状不合法返回 undefined，调用方
 * 应退回 child_models 记录或干脆不写路由字段（绝不写入半截/malformed marker）。
 */
export function normalizeModelRouteMarker(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!Number.isSafeInteger(value.candidateIndex) || value.candidateIndex < 0) return undefined;
  if (!Number.isSafeInteger(value.fallbackCount) || value.fallbackCount < 0) return undefined;
  const requestedPrimary = normalizeModelSelection(value.requestedPrimary);
  const lastRouteErrorCode = normalizeModelRouteErrorCode(value.lastRouteErrorCode);
  if (value.lastRouteErrorCode !== undefined && lastRouteErrorCode === undefined) return undefined;
  return {
    ...(requestedPrimary === undefined ? {} : { requestedPrimary }),
    candidateIndex: value.candidateIndex,
    fallbackCount: value.fallbackCount,
    ...(lastRouteErrorCode === undefined ? {} : { lastRouteErrorCode }),
  };
}

/**
 * 从持久化记录（child_models 的扁平字段）读取路由字段。
 *
 * 与 normalizeModelRouteMarker 不同：这里允许只有部分字段（旧记录/旧进程快照），
 * 投影时缺失字段省略；恢复路由时由调用方再要求 provider/model 存在。
 */
export function modelRouteFieldsFromRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return {};
  const requestedPrimary = normalizeModelSelection(record.requestedPrimary);
  const projected = projectModelRouteFields(record);
  return {
    ...(requestedPrimary === undefined ? {} : { requestedPrimary }),
    ...projected,
  };
}

// ── 结构化交付（票据 30） ──────────────────────────────────────────────────

/**
 * 结构化输出声明（outputSchema）序列化后的 UTF-8 字节上限。
 *
 * 宿主本身没有这个上限（见 docs/specs/03-host-contract-report.md §4.4），这是 DEG
 * 在派发前自管的策略：超限拒绝派发，且 schema 原文永远不进入事件历史/快照。
 */
export const OUTPUT_SCHEMA_MAX_BYTES = 64 * 1024;

/** 结构化声明被拒绝时的稳定错误码（工具回执/RPC 都只回传这些 token）。 */
export const OUTPUT_SCHEMA_ERROR_CODES = Object.freeze({
  INVALID: "OUTPUT_SCHEMA_INVALID",
  TOO_LARGE: "OUTPUT_SCHEMA_TOO_LARGE",
  UNSUPPORTED: "OUTPUT_SCHEMA_UNSUPPORTED",
});

/**
 * 「本次 activation 请求了结构化输出」的内部 marker。
 *
 * 它只存在于内存里的 request.agentOptions（Host 不持久化 agentOptions），值只是布尔，
 * 绝不携带 schema 原文；child_models 只据此保存 outputSchemaRequested。
 */
export const OUTPUT_SCHEMA_REQUESTED_MARKER = "__degOutputSchemaRequested";

/**
 * 结构化结果回退原因（稳定枚举）。
 *
 * - missing_structured：请求了 schema，但宿主结果没有 structured（通常 stopReason=error，
 *   文本 output 仍在）；不得因此把已结束的 child/task 判为失败。
 * - result_unavailable：activation.result 拒绝，或 structured 不是无损 JSON。
 * - result_too_large：结构化结果序列化后超过 64 KiB，只记录字节数，不保存值。
 * - schema_not_restored：冷恢复/重建创建了新 activation，但宿主 descriptor 不保存
 *   outputSchema，本轮没有重新声明契约。
 */
export const STRUCTURED_RESULT_FALLBACK_REASONS = Object.freeze({
  MISSING_STRUCTURED: "missing_structured",
  RESULT_UNAVAILABLE: "result_unavailable",
  RESULT_TOO_LARGE: "result_too_large",
  SCHEMA_NOT_RESTORED: "schema_not_restored",
});

const STRUCTURED_FALLBACK_REASON_SET = new Set(Object.values(STRUCTURED_RESULT_FALLBACK_REASONS));

/** UTF-8 字节数：schema 与 structured 结果共用的唯一口径。 */
export function utf8ByteLength(text) {
  return typeof text === "string" ? new TextEncoder().encode(text).byteLength : 0;
}

/**
 * 归一结构化结果投影（只读、有界）。
 *
 * 输入是 child_models.structured 或 runtime 组装出的同形对象；输出只保留白名单字段：
 * - value：仅当它仍是无损 JSON 且序列化后 <= 64 KiB 时保留；
 * - bytes/receivedAt：安全非负整数；
 * - fallback：布尔；reason：本模块声明的稳定枚举。
 *
 * 旧记录/被篡改的记录即使携带超大或非 JSON 的值，也不会原样进入快照/RPC：此时降级为
 * fallback=true + result_too_large/result_unavailable，并且不输出 value。
 */
export function projectStructuredResult(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  let projectedValue;
  let bytes = Number.isSafeInteger(value.bytes) && value.bytes >= 0 ? value.bytes : undefined;
  let fallback = value.fallback === true;
  let reason = STRUCTURED_FALLBACK_REASON_SET.has(value.reason) ? value.reason : undefined;
  if (Object.prototype.hasOwnProperty.call(value, "value")) {
    let serialized;
    try {
      serialized = JSON.stringify(value.value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      fallback = true;
      if (reason === undefined) reason = STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_UNAVAILABLE;
    } else {
      const measured = utf8ByteLength(serialized);
      if (measured > OUTPUT_SCHEMA_MAX_BYTES) {
        fallback = true;
        reason = STRUCTURED_RESULT_FALLBACK_REASONS.RESULT_TOO_LARGE;
        bytes = measured;
      } else {
        // 深拷贝一份纯 JSON 值，避免投影把调用方对象引用带进快照。
        try { projectedValue = JSON.parse(serialized); } catch { projectedValue = undefined; }
        bytes = measured;
      }
    }
  }
  const projected = {
    ...(projectedValue === undefined ? {} : { value: projectedValue }),
    ...(bytes === undefined ? {} : { bytes }),
    ...(Number.isSafeInteger(value.receivedAt) && value.receivedAt >= 0 ? { receivedAt: value.receivedAt } : {}),
    ...(fallback ? { fallback: true } : {}),
    ...(reason === undefined ? {} : { reason }),
  };
  return Object.keys(projected).length === 0 ? null : projected;
}

/**
 * child_models/attempt 记录上的结构化投影字段。
 *
 * 缺失时整体省略（不伪造 false）；outputSchemaRequested 只在记录真的写了布尔值时输出。
 */
export function structuredProjectionFields(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const structured = projectStructuredResult(source.structured);
  return {
    ...(structured === null ? {} : { structured }),
    ...(typeof source.outputSchemaRequested === "boolean" ? { outputSchemaRequested: source.outputSchemaRequested } : {}),
  };
}
