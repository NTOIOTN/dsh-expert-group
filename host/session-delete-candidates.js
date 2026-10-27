/**
 * 会话删除的候选查询组合（票据 04）：把「工作区成员 × 持久化清单 × 宿主会话表 × 收敛队列」
 * 合成一份**可直接给界面用**的候选快照。
 *
 * ## 成员口径（规格决策 23）
 * 唯一来源是工作区注册表的公开 getter（`workspaceRegistry.get(workspaceId).sessionIds`）：
 * 归档不改变成员关系，所以归档会话仍在候选内；已脱离注册表的会话属于「未分组」，由**未分组
 * 范围**单独查询（见下）；同 cwd 但从没被登记的会话同样不在。本模块**不做任何成员推断**——
 * 不知道谁是成员就不猜。
 *
 * ## 未分组范围的成员口径
 * 成员由装配段的未分组成员读面给出（`U − W`，U = 持久化清单里 origin !== "subagent" 的会话，
 * W = 全部工作区成员的并集；见 `host/index-assembly-session-delete-rpc`）。本模块只**消费**
 * 这个读面，不自己拼 U/W：候选与删除授权必须对「谁在未分组里」给出同一个答案，两处各算一份
 * 迟早会分叉。除成员来源以外，判定与工作区范围**逐字共用**同一套组合（live / live-descendant /
 * pending-cleanup / absent / 标题回退），因此未分组候选的结论与作业入口不会出现两套口径。
 *
 * ## 一次读文档（票据 04 的 oracle 验收）
 * 收敛队列只在闸门的批量查询里读**一次**（`gate.checkMany` 内部一次 `entries()`），
 * 然后按会话 ID 集合判定；绝不逐候选调用单条读（那会把一次候选查询变成 N 次聚合文档读取）。
 * 会话表按 ID 懒查（`sessions.get`），同样不走全表扫描。
 *
 * ## 可处理性 = 是不是 live 闭包 × 闸门
 * - `live` / `live-descendant`：目标自己或它的后代仍被宿主占用（规格决策 2/3）。后代来自
 *   header 血缘 ∪ DEG 子会话记录的并集，与作业期冻结闭包用的是同一套展开（闭包模块）；
 * - `pending-cleanup`：上一次删除的收尾没做完（隔离目录还在，或收敛队列仍有未完成条目）。
 *   判定用票据 01 的闸门（同一个纯函数），因此候选结论与作业入口 S0 不会分叉；
 * - 两者都不成立才是 `actionable: true`（含 absent）。
 *
 * ## 优先级：pending-cleanup 先于 live
 * 作业入口的顺序是「S0 闸门 → S1/S2 判活」，候选必须预测作业**实际会怎么判**，否则会给出
 * 一个点击后才发现被跳过的勾选框。因此这里与作业保持同一顺序。
 *
 * ## absent 的定义（规格决策 1/24）
 * 成员但持久化清单里**没有 header**：日志已经不在，只剩工作区记账/DEG 数据等残留。
 * 它 `actionable: true`、进入全选与「将处理数 N」，但确认框单列「仅清理残留」；唯一例外是
 * 同时满足闸门条件——那时按 `pending-cleanup` 阻塞（决策 24）。
 *
 * ## 不可用时的错误消息（本票据）
 * 删除能力因**实例锁**不可用时，错误消息里直接带锁文件绝对路径与操作步骤（「请删除 … 后重启
 * DSH」）；RPC 原因码仍然是稳定的 `delete-unavailable`。其它原因（收敛文档损坏、持久化缺失、
 * 记账写入口不可用…）在通用消息后追加探测给出的原因码，例如
 * `会话删除能力不可用（delete-workspace-bookkeeping-unavailable）`，多个原因用「、」连接，
 * 并在 `details` 里同时给出 `{reasons, checks}` 供定位。探测没有给出原因时仍用通用消息——
 * 既绝不把非锁问题伪装成「请删除锁文件」，也绝不编造原因。
 *
 * @module dsh-expert-group/host/session-delete-candidates
 */
import {
  DELETE_BLOCK_REASONS,
  buildSessionChildIndex,
  findLiveBlockerInSubtree,
  normalizeDegChildLinks,
  normalizeSessionHeaders,
} from "./session-delete-closure.js";
import { DELETE_GATE_REASONS } from "./session-delete-gate.js";
import { STARTUP_PROBE_REASONS } from "./session-delete-probe.js";
import { SESSION_DELETE_RPC_CODES, SESSION_DELETE_RPC_MESSAGES, sessionDeleteRpcError } from "./session-delete-rpc.js";

/** 非空字符串归一（会话 ID 只为非空字符串）。 */
function readId(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** 标题归一：只接受非空字符串，其余（含数字、空串）一律 undefined。 */
function readTitle(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 合成候选快照（**纯函数**：输入是四份快照事实，输出是确定的候选数组与计数）。
 *
 * @param {object} params
 * @param {Iterable<string>} params.memberIds - 工作区成员（注册表公开 getter，保持其顺序）。
 * @param {Array<object>} params.headers - 已归一的持久化清单 header（{@link normalizeSessionHeaders}）。
 * @param {Array<{childId: string, parentId: string}>} params.degChildren - 已归一的 DEG 子会话连线。
 * @param {(sessionId: string) => boolean} params.isLive - 判活回调（抛错原样上抛）。
 * @param {(sessionId: string) => boolean} [params.pendingCleanupOf] - 闸门结论：是否 pending-cleanup。
 * @param {(sessionId: string) => string|undefined} [params.titleOf] - 标题兜底（live 会话 header）。
 * @returns {{candidates: object[], total: number, actionableCount: number, blockedCount: number,
 *   absentCount: number}} 候选快照；计数守恒 `total = actionableCount + blockedCount`。
 */
export function composeSessionDeleteCandidates({
  memberIds,
  headers,
  degChildren,
  isLive,
  pendingCleanupOf,
  titleOf,
}) {
  const index = buildSessionChildIndex(headers, degChildren);
  // 标题尽力而为：清单 header 的 title（宿主契约目前没有这个字段）→ live 会话 header 的
  // title → null。绝不伪造会话名，客户端会回退到侧栏已知标题。
  const resolveTitle = (sessionId) => {
    const headerTitle = readTitle(index.headerOf.get(sessionId)?.title);
    if (headerTitle !== undefined) return headerTitle;
    const fallback = typeof titleOf === "function" ? readTitle(titleOf(sessionId)) : undefined;
    return fallback ?? null;
  };
  const candidates = [];
  const seen = new Set();
  for (const raw of memberIds ?? []) {
    const sessionId = readId(raw);
    if (sessionId === undefined || seen.has(sessionId)) continue;
    seen.add(sessionId);
    const absent = index.headerOf.has(sessionId) !== true;
    const title = resolveTitle(sessionId);
    const blockedBy = resolveBlocker({
      sessionId,
      title,
      index,
      isLive,
      pendingCleanupOf,
      resolveTitle,
    });
    candidates.push({ sessionId, title, actionable: blockedBy === null, absent, blockedBy });
  }
  let actionableCount = 0;
  let absentCount = 0;
  for (const candidate of candidates) {
    if (candidate.actionable === true) actionableCount += 1;
    if (candidate.absent === true) absentCount += 1;
  }
  return {
    candidates,
    total: candidates.length,
    actionableCount,
    blockedCount: candidates.length - actionableCount,
    absentCount,
  };
}

/**
 * 单个候选的阻塞者（与作业入口同一判定顺序：闸门 → 自身 live → 后代 live）。
 *
 * @param {object} params - 见 {@link composeSessionDeleteCandidates}。
 * @returns {{kind: string, sessionId: string, title: (string|null)}|null} 阻塞者或 null。
 */
function resolveBlocker({ sessionId, title, index, isLive, pendingCleanupOf, resolveTitle }) {
  if (typeof pendingCleanupOf === "function" && pendingCleanupOf(sessionId) === true) {
    return { kind: DELETE_BLOCK_REASONS.PENDING_CLEANUP, sessionId, title };
  }
  const live = findLiveBlockerInSubtree(index, sessionId, isLive);
  if (live === null) return null;
  return { kind: live.kind, sessionId: live.sessionId, title: resolveTitle(live.sessionId) };
}

/**
 * 把「实例锁原因码 + 锁文件路径」拼成用户可执行的消息（**纯函数**）。
 *
 * 只认锁这一类原因：收敛文档损坏 / 持久化缺失等其它不可用原因一律返回 undefined——
 * 绝不能把非锁问题伪装成「请删除锁文件」。
 *
 * 每条消息都必须同时包含**锁文件绝对路径**与「重启 DSH」，用户才知道下一步做什么。
 *
 * 用 if 链而不是「计算键的对象字面量」：本仓库的 C3 对账把动态键当作需要登记的形态，
 * 这里没有登记的必要，也避免再增加一处动态键。
 *
 * @param {string} reason - {@link STARTUP_PROBE_REASONS} 里的实例锁原因码。
 * @param {string} lockPath - 锁文件绝对路径。
 * @returns {string|undefined} 可执行消息；非锁原因返回 undefined。
 */
function lockUnavailableMessage(reason, lockPath) {
  if (reason === STARTUP_PROBE_REASONS.INSTANCE_LOCK_STALE) {
    return "会话删除暂不可用：上次异常退出遗留了实例锁文件，请删除 " + lockPath + " 后重启 DSH";
  }
  if (reason === STARTUP_PROBE_REASONS.INSTANCE_LOCK_HELD) {
    return "会话删除暂不可用：另一个 DSH 实例正在执行删除（锁文件 " + lockPath
      + "）；确认没有其它实例在运行后，请删除该文件并重启 DSH";
  }
  if (reason === STARTUP_PROBE_REASONS.INSTANCE_LOCK_MALFORMED) {
    return "会话删除暂不可用：实例锁文件无法解析，请删除 " + lockPath + " 后重启 DSH";
  }
  if (reason === STARTUP_PROBE_REASONS.INSTANCE_LOCK_UNREADABLE) {
    return "会话删除暂不可用：实例锁文件读不出来，请检查该文件权限后删除 " + lockPath + " 并重启 DSH";
  }
  if (reason === STARTUP_PROBE_REASONS.INSTANCE_LOCK_LOST) {
    return "会话删除暂不可用：实例锁已在运行期丢失（锁文件 " + lockPath + "），请重启 DSH 后重试";
  }
  return undefined;
}

/** 从能力快照里取锁文件路径（没有就是没有，绝不伪造）。 */
function readLockPath(snapshot) {
  const lockPath = snapshot?.lockPath;
  return typeof lockPath === "string" && lockPath.length > 0 ? lockPath : undefined;
}

/**
 * 读取删除能力快照（**只读探测快照，不读成员/清单/队列**）。
 *
 * 装配段把 `readAvailability` 挂在闸门门面上；没有它（旧装配/测试替身）就返回 undefined，
 * 调用方按「无法判定」处理——不拦截、也不伪造锁消息。
 *
 * @param {object} gate - 闸门能力面。
 * @returns {{available: boolean, reasons: string[], checks: object[], lockPath?: string}|undefined}
 *   能力快照（检查明细只做浅拷贝，用于非锁原因的诊断，不参与任何判定）。
 */
function readCapabilityOf(gate) {
  const read = gate?.readAvailability;
  if (typeof read !== "function") return undefined;
  try {
    const snapshot = read();
    if (snapshot === null || typeof snapshot !== "object") return undefined;
    const lockPath = readLockPath(snapshot);
    return {
      available: snapshot.available === true,
      reasons: Array.isArray(snapshot.reasons) ? [...snapshot.reasons] : [],
      // 探测快照已带五项检查明细（{name, ok, reason?, lockPath?}）：原样浅拷贝，绝不补造缺失项。
      checks: Array.isArray(snapshot.checks) ? snapshot.checks.map((check) => ({ ...check })) : [],
      ...(lockPath === undefined ? {} : { lockPath }),
    };
  } catch {
    return undefined;
  }
}

/**
 * 把「实例锁不可用」翻译成用户可执行的消息（**纯函数**）。
 *
 * 判定顺序：必须同时满足「快照里带锁文件路径」与「原因是锁类原因码」，否则返回 undefined，
 * 由调用方使用通用消息。路径只出现在 message 与 details 里，RPC 原因码保持稳定不变。
 *
 * @param {object|undefined} capability - {@link readCapabilityOf} 的返回值。
 * @returns {{reason: string, lockPath: string, message: string, details: {reason: string, lockPath: string}}
 *   |undefined} 锁相关不可用的描述；不是锁问题返回 undefined。
 */
export function describeLockUnavailable(capability) {
  const lockPath = readLockPath(capability);
  if (lockPath === undefined) return undefined;
  const reasons = Array.isArray(capability?.reasons) ? capability.reasons : [];
  for (const reason of reasons) {
    const message = lockUnavailableMessage(reason, lockPath);
    if (message === undefined) continue;
    return { reason, lockPath, message, details: { reason, lockPath } };
  }
  return undefined;
}

/**
 * 把探测给出的不可用原因码拼成**带原因的诊断消息**与结构化 details（**纯函数**）。
 *
 * 只用于**非实例锁**分支（或在锁原因下拿不到锁路径时）：候选查询整体失败时，运维/用户
 * 需要立刻判断是五项检查里的哪一项没过，因此消息里直接列出原因码，例如
 * `会话删除能力不可用（delete-workspace-bookkeeping-unavailable）`，多个原因用「、」连接。
 * 没有可展示的原因（旧装配没有探测、探测尚未给出原因、探针读失败）时返回 undefined，
 * 调用方保留原来的通用消息——绝不编造原因，也绝不在这里猜锁路径。
 *
 * details 形状固定：
 * - `reasons: string[]`：快照给出的原因码（按快照顺序，重复项丢弃）；
 * - `checks: [{name, ok, reason?, detail?}]`：探测快照的检查明细（含每项的可诊断子原因）；
 *   快照没有明细时**不编造**，只给 reasons。
 * 锁文件路径不进入这里：锁专用消息与 details 由 {@link describeLockUnavailable} 负责。
 *
 * @param {{available: boolean, reasons: string[], checks?: object[]}|undefined} capability
 *   {@link readCapabilityOf} 的返回值。
 * @returns {{message: string, details: {reasons: string[], checks?: object[]}}|undefined}
 *   诊断描述；没有原因可展示时返回 undefined。
 */
export function describeCapabilityUnavailable(capability) {
  const reasons = [];
  for (const reason of Array.isArray(capability?.reasons) ? capability.reasons : []) {
    if (typeof reason !== "string" || reason.length === 0) continue;
    if (reasons.includes(reason)) continue;
    reasons.push(reason);
  }
  if (reasons.length === 0) return undefined;
  // 检查明细只投影诊断需要的字段（name/ok/reason/detail）：不转发锁路径等实现细节。
  const checks = [];
  for (const check of Array.isArray(capability?.checks) ? capability.checks : []) {
    if (check === null || typeof check !== "object") continue;
    if (typeof check.name !== "string" || check.name.length === 0) continue;
    checks.push({
      name: check.name,
      ok: check.ok === true,
      ...(typeof check.reason === "string" && check.reason.length > 0 ? { reason: check.reason } : {}),
      // 子原因（service-missing / list-threw: … 等）只用于定位五项检查里的具体失败点。
      ...(typeof check.detail === "string" && check.detail.length > 0 ? { detail: check.detail } : {}),
    });
  }
  const base = SESSION_DELETE_RPC_MESSAGES[SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE];
  return {
    message: base + "（" + reasons.join("、") + "）",
    details: { reasons, ...(checks.length === 0 ? {} : { checks }) },
  };
}

/**
 * 闸门批量结论里「不可用」的分支：翻译成稳定错误（**两个范围共用**，绝不返回空候选）。
 *
 * 三段口径与之前逐字一致：
 * 1. **实例锁**原因且拿得到锁文件路径：把「删哪个文件 + 重启 DSH」写进错误消息，
 *    details 保持既有形状（{reason, lockPath}），绝不退化成原因码列表；
 * 2. 其它原因（收敛文档损坏、持久化缺失、记账写入口不可用…，以及锁原因但拿不到锁路径）：
 *    在通用消息后追加探测原因码，便于定位是五项检查里的哪一项失败；
 * 3. 探测没有给出原因（旧装配/尚未探测）：保留原来的通用消息，绝不编造原因。
 *
 * @param {object} gateOutcome - `gate.checkMany` 的返回值。
 * @param {object} gate - 闸门能力面（可能带只读能力快照）。
 * @returns {void} 可用时正常返回。
 * @throws {Error} 503 `delete-unavailable`（带可执行消息与 details）。
 */
function throwGateUnavailable(gateOutcome, gate) {
  if (gateOutcome?.available === true && gateOutcome?.queueReadable === true) return;
  const capability = readCapabilityOf(gate);
  const lockIssue = gateOutcome?.available !== true
    ? describeLockUnavailable(capability)
    : undefined;
  const diagnosis = lockIssue === undefined ? describeCapabilityUnavailable(capability) : undefined;
  throw sessionDeleteRpcError(
    SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE,
    lockIssue?.message ?? diagnosis?.message,
    lockIssue !== undefined
      ? { details: lockIssue.details }
      : (diagnosis === undefined ? {} : { details: diagnosis.details }),
  );
}

/**
 * 由成员集合 + 三份快照事实产出候选快照（**两个范围共用**：只有 `memberIds` 的来源不同）。
 *
 * 宿主会话事实按会话 ID 在**一次查询内**记忆：判活与标题取的是同一次 `sessions.get`，
 * 同一个会话（含被指名的 live 后代）不会被重复询问，也不做全表扫描。
 *
 * @param {object} params
 * @param {Iterable<string>} params.memberIds - 本范围的成员（工作区成员 / 未分组成员）。
 * @param {Array<object>} params.headers - 已归一的持久化清单 header。
 * @param {Array<{childId: string, parentId: string}>} params.degChildren - 已归一的 DEG 连线。
 * @param {object} params.gateOutcome - `gate.checkMany` 的结论（已确认可用）。
 * @param {(sessionId: string) => {live: boolean, title?: string}} params.readSession - 宿主会话事实。
 * @returns {object} {@link composeSessionDeleteCandidates} 的快照。
 */
function composeScopeSnapshot({ memberIds, headers, degChildren, gateOutcome, readSession }) {
  const facts = new Map();
  const factsOf = (sessionId) => {
    if (facts.has(sessionId)) return facts.get(sessionId);
    let read;
    try {
      read = readSession(sessionId);
    } catch (error) {
      // 判活读不通 = 无法证明未被占用：整个查询失败，绝不把候选标成可处理。
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE, undefined, { cause: error });
    }
    const outcome = { live: read?.live === true, title: read?.title };
    facts.set(sessionId, outcome);
    return outcome;
  };
  return composeSessionDeleteCandidates({
    memberIds,
    headers,
    degChildren,
    isLive: (sessionId) => factsOf(sessionId).live,
    pendingCleanupOf: (sessionId) => gateOutcome.verdicts?.get(sessionId)?.blockedBy === DELETE_GATE_REASONS.PENDING_CLEANUP,
    titleOf: (sessionId) => factsOf(sessionId).title,
  });
}

/**
 * 创建候选查询能力面。
 *
 * @param {object} deps - 窄能力面（不读 ctx、不读全局状态）。
 * @param {{checkMany: Function}} deps.gate - 票据 01 的闸门（批量查询：一次读收敛文档）。
 * @param {(workspaceId: string) => (string[]|undefined)} deps.readMembers - 工作区成员；undefined = 工作区不存在。
 * @param {() => Promise<Iterable<unknown>>} deps.readHeaders - 持久化清单（**每次查询只读一次**）。
 * @param {() => Iterable<unknown>} deps.readDegChildren - DEG 子会话连线（读失败等价于没有记录）。
 * @param {(sessionId: string) => {live: boolean, title?: string}} deps.readSession - 宿主会话事实
 *   （一次 `sessions.get` 同时给出「是否仍被占用」与 header 标题）；拿不到事实时必须抛错。
 * @param {() => Promise<{ungroupedIds: string[], workspaceIds: string[]}>} [deps.readUngroupedMembers]
 *   未分组成员读面（`U − W`，由装配段从持久化清单与全部工作区实体算出来）；缺省 = 未分组
 *   范围不可用（503），绝不退化成空列表。
 * @returns {{list: Function, listUngrouped: Function, availability: Function}} 候选查询能力面。
 */
export function installSessionDeleteCandidates({
  gate,
  readMembers,
  readHeaders,
  readDegChildren,
  readSession,
  readUngroupedMembers,
}) {
  /** 取成员：工作区不存在返回 undefined；读面故障抛「候选查询不可用」。 */
  function membersOf(workspaceId) {
    const members = readMembers(workspaceId);
    if (members === undefined || members === null) return undefined;
    if (!Array.isArray(members)) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE);
    }
    return members;
  }

  /**
   * 取持久化清单：读失败/形状非法都按「候选查询不可用」fail-closed（不猜谁是 absent）。
   *
   * 非数组（含 undefined）必须算失败：`normalizeSessionHeaders(undefined)` 会安静地返回空表，
   * 那样每个成员都会被报成 absent（可清理），等于把一次读故障变成一次删除邀请。
   */
  async function headersOf() {
    let raw;
    try {
      raw = await readHeaders();
    } catch (error) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE, undefined, { cause: error });
    }
    if (!Array.isArray(raw)) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE);
    }
    return normalizeSessionHeaders(raw);
  }

  /** DEG 连线只做补充：读不通时返回空数组（header 血缘仍然生效，不会因此漏判 live 后代）。 */
  function degChildrenOf() {
    try {
      return normalizeDegChildLinks(readDegChildren?.() ?? []);
    } catch {
      return [];
    }
  }

  /**
   * 取未分组成员：读面缺失/抛错/形状非法一律抛「候选查询不可用」。
   *
   * 未分组范围**没有**「工作区不存在」这种明确否定：读面读不通只能是不可用，绝不能退化成
   * 空集合——那会被界面当成「没有可删的未分组会话」，等于把一次读故障变成假成功。
   *
   * 读面返回 `{ungroupedIds, workspaceIds}`；候选只消费前者（W 是删除授权用的判据）。
   */
  async function ungroupedOf() {
    if (typeof readUngroupedMembers !== "function") {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE);
    }
    let read;
    try {
      read = await readUngroupedMembers();
    } catch (error) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE, undefined, { cause: error });
    }
    if (read === null || typeof read !== "object"
      || !Array.isArray(read.ungroupedIds) || !Array.isArray(read.workspaceIds)) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE);
    }
    return read.ungroupedIds;
  }

  /**
   * 一个范围的快照（**两个范围共用**）：成员已解析，其余读序与判定完全相同。
   *
   * 读序：清单（一次）→ DEG 连线 → 闸门批量（一次）→ 组合快照。把读序留在一个地方，
   * 两个范围就不会在读次数或判定顺序上分叉（性能断言与一致性断言都依赖这份顺序）。
   */
  async function snapshotFor(memberIds) {
    const headers = await headersOf();
    const degChildren = degChildrenOf();
    // 一次性批量闸门：读一次收敛文档 → 一次判定 → 每个成员一个结论（含整批可用性事实）。
    const gateOutcome = await gate.checkMany(memberIds);
    throwGateUnavailable(gateOutcome, gate);
    return composeScopeSnapshot({ memberIds, headers, degChildren, gateOutcome, readSession });
  }

  return Object.freeze({
    /**
     * 查询某个工作区的全部候选。
     *
     * @param {string} workspaceId - 工作区 ID（由 RPC 命令面保证非空字符串）。
     * @returns {Promise<object>} {@link composeSessionDeleteCandidates} 的快照。
     */
    async list(workspaceId) {
      const members = membersOf(workspaceId);
      if (members === undefined) {
        throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.WORKSPACE_NOT_FOUND);
      }
      return await snapshotFor(members);
    },
    /**
     * 查询未分组范围的候选（成员来源由装配段注入，判定与工作区范围逐字相同）。
     *
     * @returns {Promise<object>} {@link composeSessionDeleteCandidates} 的快照。
     */
    async listUngrouped() {
      const memberIds = await ungroupedOf();
      return await snapshotFor(memberIds);
    },
    /**
     * 只读的删除能力快照（供**删除动作**在作业之前短路）：只读探测快照，不读成员/清单/队列。
     *
     * 三种返回：`undefined` = 读面缺失（调用方按「无法判定」处理：不拦截、也不伪造消息）；
     * `{available:true}` = 能力可用；`{available:false, message?, details?}` = 不可用，
     * 其中 `@message` **只在实例锁原因下出现**（其它原因由候选查询自行拼原因码消息，
     * 见 {@link describeCapabilityUnavailable}；删除动作因此不会被非锁原因提前拦截）。
     *
     * @returns {{available: boolean, message?: string, details?: object}|undefined} 能力快照。
     */
    availability() {
      const capability = readCapabilityOf(gate);
      if (capability === undefined) return undefined;
      if (capability.available === true) return { available: true };
      const lockIssue = describeLockUnavailable(capability);
      return {
        available: false,
        ...(lockIssue === undefined ? {} : { message: lockIssue.message, details: lockIssue.details }),
      };
    },
  });
}
