/**
 * 会话删除的 RPC 命令面（票据 04）：两个**无会话域** action 的输入校验、响应形状与错误映射。
 *
 * ## 两个 action
 * - `session-delete-candidates`：按范围进行的候选查询（工作区成员 / 未分组成员）；
 * - `session-delete`：把用户选中的闭包目标交给票据 02 的作业，回传五态聚合与守恒计数。
 *
 * ## 两个范围（请求体的唯一两种合法形态）
 * 两个 action 共用同一套范围协议：
 * - **工作区范围** `{ workspaceId }`：旧客户端的兼容形态，行为与引入范围之前完全一致；
 * - **未分组范围** `{ scope: "ungrouped" }`：不属于任何工作区的会话（成员口径见
 *   `host/index-assembly-session-delete-rpc` 的未分组成员读面）。
 * 同时给出 workspaceId 与 scope、scope 取值不是 "ungrouped"、两者都缺，一律 400 bad-request。
 * 未分组范围**没有**「工作区不存在」这件事，因此这条范围不会返回 404。
 *
 * 两者都**不要求 sessionId**，因此登记在 RPC 核心的无会话域分发表里；命令面本身放在本模块，
 * 分发表只负责把解码后的 body 转进来、把结果写成统一 envelope（AGENTS.md：分发表不写业务）。
 *
 * ## 为什么错误码集中在这里
 * 候选查询与删除执行对外的**稳定错误码**只有一份定义：输入非法（400）、工作区不存在（404）、
 * 作业忙碌（409）、候选/能力不可用（503）。它们由 {@link sessionDeleteRpcError} 抛出，由
 * {@link mapSessionDeleteRpcError} 映射成 `(status, code, message[, details])`，再由
 * `host/index-rpc-action-core` 的 mapRpcError 直接采用——错误映射仍然只有一条路径。
 *
 * ## 忙碌为什么不排队
 * 作业自身（票据 02）已经有「同一时刻只跑一个、第二个立即拒绝」的语义。这里只把它翻译成
 * 409 + `{accepted:false, busy:true}` 的结构化 details：排队会把「用户点了两次删除」变成
 * 两次真实删除（规格决策 20）。
 *
 * ## 目标归属校验（修正票据 10 的信任边界）
 * `session-delete` 的 `targets` 是**客户端提供的不可信输入**：只校验形状不够，还必须由服务端
 * 判定「这个会话属于该工作区」。规则只有一条闭包式判据：
 * - 目标在工作区成员集合里（注册表公开 getter 的 `sessionIds`），**或**
 * - 沿父链（header `parentSession` ∪ DEG 子会话记录的 `parentId`）上溯能到达某个成员。
 *
 * 三类失败的口径：
 * - 工作区不存在（成员读面明确返回 undefined）→ 404 `workspace-not-found`；
 * - 成员集合读失败、父链判不了（清单读不出来/形状非法）→ 503 `delete-unavailable`（不猜）；
 * - 目标确实在区外 → 400 `delete-targets-outside-workspace`，**整批拒绝**（绝不部分执行）。
 *
 * 成员集合只在「有目标不是成员」时才去读清单/血缘：全是成员时是 O(1) 的集合命中，不需要
 * 任何额外读面（也不会因为持久化读故障而拒绝一次本来合法的删除）。
 *
 * ## 未分组范围的授权判据（与工作区范围不同）
 * 工作区范围认「成员**或**成员后代」；未分组范围恰好相反，每个目标必须**同时**满足：
 * - 目标 ∈ U（持久化清单里 origin !== "subagent" 的会话）；
 * - 目标 ∉ W（全部工作区实体的 `sessionIds` 并集）；
 * - `closure(target) ∩ W = ∅`：作业会删除所选根的**整个后代闭包**，只校验目标自己会让一个
 *   未分组根间接删掉挂在它下面的工作区会话。
 * 任一目标不满足 → 400 `delete-targets-outside-ungrouped`，整批拒绝、不启动作业。
 * **不**因为目标的祖先属于工作区就拒绝：宿主侧栏按**直接**成员归组，工作区会话的后代仍会
 * 显示在未分组区，删除它们（连同自己的后代）是用户可见、可预期的行为。
 *
 * 与工作区范围不同，未分组范围**没有快路径**：U/W/闭包三件事缺一不可，因此每次都要读
 * 未分组成员读面与清单（读不通即 503，不猜）。
 *
 * ## 未分组范围的执行前二次授权（TOCTOU 收敛）
 * 上面那次授权读的是一份**请求时刻**的 U/W 快照，而作业会在另一个时刻重新捕获事实、重算
 * 冻结计划并执行。两次读取之间工作区成员关系可能变化（例如另一个客户端把目标拉进工作区），
 * 于是「被授权的集合」与「真正被删的集合」可能不是同一个——只校验请求快照就删，等于允许
 * 一次未经检查的删除。
 *
 * 因此未分组分支在调用作业时注入 `authorize`：作业在冻结计划之后、任何删除动作之前回调它，
 * 一次性拿到**实际计划**的成员与根；这里重新读一遍未分组成员读面（新鲜 U/W），要求
 * `plan.members ∩ W = ∅`——工作区成员绝不能被本次删除（否则会连带删掉别的范围里的会话）。
 * 违反 → 400 `delete-targets-outside-ungrouped`（details 给出越界成员），作业随即终止、
 * 零删除；读面不可用 → 503 `delete-unavailable`（与授权阶段同一口径）。
 *
 * **剩余窗口**（不声称完全消除竞态）：authorize 返回后，作业仍要逐目标走「闸门读 → 意图
 * 条目落盘 → 判活 → 改名」这一串步骤；因此窗口不是瞬间，而是「一次闸门读 + 一次队列写入 +
 * 两次判活」的量级，越靠后的目标离授权点越远（前面目标的迁移也会改变磁盘状态）。这里做到
 * 的是两点：检查对象 = 将要删除的实际冻结计划；检查点位于第一处真正副作用（意图落盘与改名）
 * 之前，中间不额外插入判定分支。
 *
 * 工作区范围**不注入**这个回调：其授权语义（成员或成员后代）不要求 `closure ∩ W = ∅` 的强
 * 保证，保持既有行为零回归。
 *
 * ## DEG 连线的读面从严（授权路径）
 * 授权路径上的 DEG 子会话记录是**证据**，不是补充：header 血缘之外，只有它能把「header
 * 已经消失、但仍挂在成员下面的子会话」连回来。因此读面缺失、抛错或返回非数组时一律 503
 * `delete-unavailable`——绝不降级成空数组。降级成空数组等于「证据消失 = 关系不存在」，会让
 * 一个真实后代被漏掉，从而放行一次越界删除。
 *
 * 这与作业侧的口径**刻意不同**：作业期读 DEG 失败等价于「没有记录」（header 血缘仍然生效，
 * 且只会导致少删/跳过），而授权期必须从严——「授权从严、执行从宽」才是安全方向。
 *
 * ## 实例锁不可用的消息（本票据）
 * 删除能力因实例锁不可用时，候选查询与删除动作都返回稳定的 `delete-unavailable`（503），
 * 但**可读消息**由候选组合面给出：它包含锁文件绝对路径与「重新启动 DSH」的操作步骤，客户端
 * 直接显示，用户不需要去猜要删哪个文件。其它不可用原因保持通用消息。
 *
 * @module dsh-expert-group/host/session-delete-rpc
 */
import {
  buildSessionChildIndex,
  collectSessionSubtree,
  normalizeDegChildLinks,
  normalizeSessionHeaders,
} from "./session-delete-closure.js";

/** 两个 action 的名字（与 RPC 分发表的键必须逐字一致）。 */
export const SESSION_DELETE_ACTIONS = Object.freeze({
  /** 候选查询（工作区维度）。 */
  CANDIDATES: "session-delete-candidates",
  /** 执行删除（闭包目标集合）。 */
  REMOVE: "session-delete",
});

/**
 * 单次删除请求允许的目标数上限。
 *
 * 普通 JSON 请求体上限是 16KiB（host/rpc-transport），一个会话 ID 约 37 字节，200 个目标
 * 约 7.4KB，仍留有一倍余量。更大的工作区需要客户端分批提交（票据 05 的客户端职责），
 * 服务端不因为「数量大」而静默截断或排队。
 */
export const SESSION_DELETE_TARGETS_LIMIT = 200;

/** 对外稳定错误码（会进入 `error.code`，客户端据此决定提示与入口可用性）。 */
export const SESSION_DELETE_RPC_CODES = Object.freeze({
  /** 请求体缺少/含非法的 workspaceId（400）。 */
  BAD_REQUEST: "bad-request",
  /** 工作区已不存在（404）。 */
  WORKSPACE_NOT_FOUND: "workspace-not-found",
  /** 候选查询读不到必需的事实（成员/清单/会话表）：入口必须不可用（503）。 */
  CANDIDATES_UNAVAILABLE: "delete-candidates-unavailable",
  /** 删除能力整体不可用（探测未过、收敛文档不可读、作业未装配）（503）。 */
  CAPABILITY_UNAVAILABLE: "delete-unavailable",
  /** targets 形状非法（非数组、空、含非字符串、超过上限）（400）。 */
  TARGETS_INVALID: "delete-targets-invalid",
  /**
   * targets 里有会话**不属于该工作区**（既不是成员，也不是成员后代）（400）。
   *
   * 这是服务端的信任边界：客户端传来的目标列表一律当作不可信输入，必须用服务端自己的
   * 成员/血缘事实复核。整批拒绝，绝不部分执行。
   */
  TARGETS_OUTSIDE_WORKSPACE: "delete-targets-outside-workspace",
  /**
   * targets 里有会话**不属于未分组范围**（400）。
   *
   * 未分组的判据与工作区范围相反：目标必须是持久化清单里的独立会话（非 subagent）、
   * 不是任何工作区成员，且它的**整棵后代闭包**里没有工作区成员。整批拒绝，绝不部分执行。
   */
  TARGETS_OUTSIDE_UNGROUPED: "delete-targets-outside-ungrouped",
  /** 已有删除作业在执行（409）。 */
  JOB_BUSY: "delete-job-busy",
});

/** 稳定错误消息（与码一一对应；只有 targets 这类输入错误允许更具体的文案）。 */
export const SESSION_DELETE_RPC_MESSAGES = Object.freeze({
  [SESSION_DELETE_RPC_CODES.BAD_REQUEST]: "缺少 workspaceId",
  [SESSION_DELETE_RPC_CODES.WORKSPACE_NOT_FOUND]: "工作区不存在或已移除",
  [SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE]: "会话删除候选查询不可用",
  [SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE]: "会话删除能力不可用",
  [SESSION_DELETE_RPC_CODES.TARGETS_INVALID]: "targets 必须是非空字符串数组",
  [SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_WORKSPACE]: "删除目标必须属于该工作区或其后代会话",
  [SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED]: "删除目标必须属于未分组会话",
  [SESSION_DELETE_RPC_CODES.JOB_BUSY]: "已有删除作业正在执行，请稍后再试",
});

/** 稳定错误码 → HTTP 状态的唯一映射（400/404/409/503 的语义与既有错误一致）。 */
const STATUS_OF_CODE = Object.freeze({
  [SESSION_DELETE_RPC_CODES.BAD_REQUEST]: 400,
  [SESSION_DELETE_RPC_CODES.WORKSPACE_NOT_FOUND]: 404,
  [SESSION_DELETE_RPC_CODES.TARGETS_INVALID]: 400,
  [SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_WORKSPACE]: 400,
  [SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED]: 400,
  [SESSION_DELETE_RPC_CODES.JOB_BUSY]: 409,
  [SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE]: 503,
  [SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE]: 503,
});

/**
 * 构造带稳定 `code` 的失败（**不携带路径、堆栈或请求体**）。
 *
 * @param {string} code - {@link SESSION_DELETE_RPC_CODES} 之一。
 * @param {string} [message] - 覆盖默认消息（只用于 targets 这类需要说清形状的输入错误）。
 * @param {object} [extra] - `{details, cause}`；details 只在确有结构化附加信息时提供。
 * @returns {Error} 带 `code`（以及可选 `details`）的错误。
 */
export function sessionDeleteRpcError(code, message, extra = {}) {
  const text = typeof message === "string" && message.length > 0
    ? message
    : (SESSION_DELETE_RPC_MESSAGES[code] ?? "会话删除失败");
  const error = extra?.cause === undefined ? new Error(text) : new Error(text, { cause: extra.cause });
  error.code = code;
  if (extra?.details !== undefined) error.details = extra.details;
  return error;
}

/**
 * 把会话删除的稳定错误码映射成 `(status, code, message[, details])`（**纯函数**）。
 *
 * @param {unknown} error - 任意异常；不认识的错误返回 undefined，交给既有 mapRpcError 继续处理。
 * @returns {{status: number, code: string, message: string, details?: object}|undefined} 映射结果。
 */
export function mapSessionDeleteRpcError(error) {
  const code = typeof error?.code === "string" ? error.code : undefined;
  if (code === undefined) return undefined;
  const status = STATUS_OF_CODE[code];
  if (status === undefined) return undefined;
  const message = typeof error?.message === "string" && error.message.length > 0
    ? error.message
    : (SESSION_DELETE_RPC_MESSAGES[code] ?? "会话删除失败");
  return {
    status,
    code,
    message,
    ...(error?.details === undefined ? {} : { details: error.details }),
  };
}

/** workspaceId 归一：必须是**非空字符串**（工作区 ID 不透明，不 trim、不猜测大小写）。 */
function readWorkspaceId(body) {
  const workspaceId = body?.workspaceId;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.BAD_REQUEST);
  }
  return workspaceId;
}

/** 未分组范围的唯一合法 scope 取值（与客户端协议逐字一致）。 */
const UNGROUPED_SCOPE = "ungrouped";

/**
 * 归一请求范围（两个 action 共用；非法形态一律 400）。
 *
 * 合法形态只有两种：`{ workspaceId }`（工作区）与 `{ scope: "ungrouped" }`（未分组）。
 * - 同时给出 workspaceId 与 scope：范围有歧义，客户端必须二选一（绝不静默挑一个）；
 * - scope 取值不是 "ungrouped"：不认识的 scope 不能被当成工作区范围（那样会丢掉 scope 语义）；
 * - 两者都缺：沿用既有文案「缺少 workspaceId」——旧客户端与既有回归用例依赖这条稳定消息。
 *
 * @param {object} body - 已解码的请求体。
 * @returns {{kind: "workspace", workspaceId: string}|{kind: "ungrouped"}} 范围描述。
 */
function readRangeOf(body) {
  const scope = body?.scope;
  if (body?.workspaceId !== undefined && scope !== undefined) {
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.BAD_REQUEST, "不能同时提供 workspaceId 与 scope");
  }
  if (scope !== undefined) {
    if (scope !== UNGROUPED_SCOPE) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.BAD_REQUEST, "scope 只能是 ungrouped");
    }
    return { kind: "ungrouped" };
  }
  return { kind: "workspace", workspaceId: readWorkspaceId(body) };
}

/**
 * targets 归一与校验：只接受字符串 ID，去重保持顺序，数量不超过上限。
 *
 * 去重是**静默**的（同一目标出现两次不是客户端错误）；非字符串、空串、空数组与超限都是
 * 客户端输入错误，必须显式拒绝——绝不把「少删了几个」当成成功。
 */
function normalizeTargets(targets) {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.TARGETS_INVALID);
  }
  const unique = [];
  const seen = new Set();
  for (const entry of targets) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.TARGETS_INVALID, "targets 只能包含非空会话 ID 字符串");
    }
    if (seen.has(entry)) continue;
    seen.add(entry);
    unique.push(entry);
    if (unique.length > SESSION_DELETE_TARGETS_LIMIT) {
      throw sessionDeleteRpcError(
        SESSION_DELETE_RPC_CODES.TARGETS_INVALID,
        "单次最多删除 " + SESSION_DELETE_TARGETS_LIMIT + " 个会话",
      );
    }
  }
  return unique;
}

/**
 * 标题映射归一（best effort）：只接受「非空字符串键 → 非空字符串值」。
 *
 * 标题只用于让回执/阻塞原因指名是谁，绝不参与任何删除判定，因此非法条目直接丢弃，
 * 不因为标题脏数据而拒绝整次删除。
 */
function normalizeTitles(titles) {
  if (titles === null || typeof titles !== "object" || Array.isArray(titles)) return undefined;
  const resolved = new Map();
  for (const [sessionId, title] of Object.entries(titles)) {
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    if (typeof title !== "string" || title.length === 0) continue;
    resolved.set(sessionId, title);
  }
  if (resolved.size === 0) return undefined;
  return (sessionId) => resolved.get(sessionId);
}

/** 可迭代成员集合归一成 Set（只接受非空字符串；其余条目丢弃）。 */
function memberSetOf(members) {
  if (members instanceof Set) return members;
  const set = new Set();
  for (const entry of members ?? []) {
    if (typeof entry === "string" && entry.length > 0) set.add(entry);
  }
  return set;
}

/**
 * 沿父链上溯，判断某个会话能否到达一个工作区成员（**纯函数**）。
 *
 * 父链来源是闭包模块的同一份索引（header `parentSession` 优先、DEG 记录补齐），因此这里与
 * 作业期的闭包展开不会对「谁是成员的后代」给出不同答案。自环/环按「判不了」处理并返回
 * false：血缘被外部篡改成环时只能拒绝，绝不能凭一个环把区外会话放进来。
 *
 * @param {Map<string, string>} parentOf - 子 → 父。
 * @param {Set<string>} memberSet - 工作区成员集合。
 * @param {string} sessionId - 待判定的会话。
 * @returns {boolean} 能到达某个成员返回 true。
 */
function reachesWorkspaceMember(parentOf, memberSet, sessionId) {
  const visited = new Set([sessionId]);
  let current = parentOf.get(sessionId);
  while (typeof current === "string" && current.length > 0) {
    if (memberSet.has(current)) return true;
    if (visited.has(current)) return false;
    visited.add(current);
    current = parentOf.get(current);
  }
  return false;
}

/**
 * 目标归属判定的**唯一实现**（纯函数：输入成员集合与父链，输出区外目标列表）。
 *
 * @param {object} params
 * @param {Iterable<string>|Set<string>} params.members - 工作区成员集合。
 * @param {Iterable<string>} params.targets - 归一后的目标会话 ID（已去重）。
 * @param {Map<string, string>} params.parentOf - 子 → 父（可缺省：此时只认成员本身）。
 * @returns {{ok: true}|{ok: false, outside: string[]}} 判定结果；`outside` 保持目标顺序。
 */
export function evaluateWorkspaceTargets({ members, targets, parentOf }) {
  const memberSet = memberSetOf(members);
  const parents = parentOf instanceof Map ? parentOf : new Map();
  const outside = [];
  for (const sessionId of targets ?? []) {
    if (typeof sessionId !== "string" || sessionId.length === 0) continue;
    if (memberSet.has(sessionId)) continue;
    if (reachesWorkspaceMember(parents, memberSet, sessionId)) continue;
    outside.push(sessionId);
  }
  return outside.length === 0 ? { ok: true } : { ok: false, outside };
}

/** 把读面故障收敛成「删除能力不可用」（503）：绝不把「读不通」当成「不属于工作区」。 */
function unavailable(cause) {
  return sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE, undefined, { cause });
}

/**
 * 授权路径上的 DEG 连线读面（**严格**：缺失/抛错/形状非法一律 503，绝不降级成空数组）。
 *
 * 为什么不能像作业侧那样「读不通就当没有记录」：DEG 记录是 header 血缘之外的**唯一**证据，
 * 用来把 header 已消失、但仍挂在某成员下面的子会话连回闭包。授权时把「读不出来」当成「没有
 * 关系」，会漏掉这样一条真实后代，从而放行一次会连带删掉工作区成员的删除——这正是必须
 * fail-closed 的那类错误。
 *
 * @param {object|undefined} port - 目标归属读面。
 * @returns {unknown[]} DEG 子会话记录数组（形状由 normalizeDegChildLinks 再归一）。
 * @throws {Error} 503 `delete-unavailable`（读面缺失、读失败或返回非数组）。
 */
function readDegChildrenStrict(port) {
  const read = port?.readDegChildren;
  if (typeof read !== "function") {
    // 没有读面 = 无法证明闭包里没有工作区成员，绝不跳过。
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  }
  let records;
  try {
    records = read.call(port);
  } catch (error) {
    throw unavailable(error);
  }
  if (!Array.isArray(records)) throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  return records;
}

/**
 * 校验删除目标是否都落在该工作区闭包内（服务端的信任边界，**不可跳过**）。
 *
 * @param {object|undefined} port - `{readMembers, readHeaders, readDegChildren}`。
 * @param {string} workspaceId - 请求里的工作区 ID。
 * @param {string[]} targets - 归一后的目标列表。
 * @returns {Promise<void>} 校验通过时正常返回。
 * @throws {Error} 404（工作区不存在）/ 503（读面不可用）/ 400（目标在区外）。
 */
async function assertTargetsWithinWorkspace(port, workspaceId, targets) {
  if (port === null || typeof port !== "object" || typeof port.readMembers !== "function") {
    // 没有成员读面 = 无法证明目标合法：fail-closed，绝不跳过校验直接删。
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  }
  let members;
  try {
    members = port.readMembers(workspaceId);
  } catch (error) {
    throw unavailable(error);
  }
  if (members === undefined || members === null) {
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.WORKSPACE_NOT_FOUND);
  }
  if (!Array.isArray(members)) throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  const memberSet = memberSetOf(members);
  // 快路径：全是成员——不需要读清单/血缘（也就不受持久化读故障影响）。
  if (targets.every((sessionId) => memberSet.has(sessionId))) return;
  let rawHeaders;
  try {
    rawHeaders = await port.readHeaders?.();
  } catch (error) {
    throw unavailable(error);
  }
  if (!Array.isArray(rawHeaders)) {
    // 清单读不出来 → 父链判不了 → fail-closed（不把任何目标当成「合法后代」）。
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  }
  const index = buildSessionChildIndex(
    normalizeSessionHeaders(rawHeaders),
    normalizeDegChildLinks(readDegChildrenStrict(port)),
  );
  const verdict = evaluateWorkspaceTargets({ members: memberSet, targets, parentOf: index.parentOf });
  if (verdict.ok === true) return;
  throw sessionDeleteRpcError(
    SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_WORKSPACE,
    SESSION_DELETE_RPC_MESSAGES[SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_WORKSPACE],
    { details: { sessionIds: verdict.outside } },
  );
}

/**
 * 未分组读面归一（**纯函数、永不抛错**）：只接受 `{ungroupedIds, workspaceIds}` 两个数组。
 *
 * 形状非法返回 undefined，由调用方翻译成 503——绝不把「读不懂」当成「没有未分组会话」，
 * 更不把空集合当成「所有目标都合法」。
 *
 * @param {unknown} raw - 未分组成员读面的返回值。
 * @returns {{ungrouped: Set<string>, workspace: Set<string>}|undefined} 归一后的两个集合。
 */
function readUngroupedFacts(raw) {
  if (raw === null || typeof raw !== "object") return undefined;
  if (!Array.isArray(raw.ungroupedIds) || !Array.isArray(raw.workspaceIds)) return undefined;
  return { ungrouped: memberSetOf(raw.ungroupedIds), workspace: memberSetOf(raw.workspaceIds) };
}

/**
 * 单个目标是否落在未分组范围内（**纯函数**）。
 *
 * 三条判据缺一不可，理由见模块头「未分组范围的授权判据」：
 * 1. 目标 ∈ U（未分组成员读面给出的独立会话集合）；
 * 2. 目标 ∉ W（防御性冗余：U 的定义已排除 W，这里再显式确认一次）；
 * 3. `closure(target) ∩ W = ∅`——作业会删除整棵后代闭包，闭包里出现工作区成员就是越界。
 *
 * @param {object} index - {@link buildSessionChildIndex} 的结果（后代闭包的唯一来源）。
 * @param {Set<string>} ungroupedSet - U。
 * @param {Set<string>} workspaceSet - W。
 * @param {string} sessionId - 待判定的目标。
 * @returns {boolean} 合法返回 true。
 */
function isUngroupedTarget(index, ungroupedSet, workspaceSet, sessionId) {
  if (!ungroupedSet.has(sessionId)) return false;
  if (workspaceSet.has(sessionId)) return false;
  for (const memberId of collectSessionSubtree(index, sessionId)) {
    if (workspaceSet.has(memberId)) return false;
  }
  return true;
}

/**
 * 校验删除目标是否都落在未分组范围内（服务端的信任边界，**不可跳过**）。
 *
 * 与工作区版本一样：校验发生在作业之前，因此「部分非法」= 整批拒绝；读面缺失/抛错/形状非法
 * 一律 503 `delete-unavailable`（fail-closed），绝不猜。
 *
 * @param {object|undefined} port - `{readUngroupedMembers, readHeaders, readDegChildren}`。
 * @param {string[]} targets - 归一后的目标列表。
 * @returns {Promise<void>} 校验通过时正常返回。
 * @throws {Error} 503（读面不可用）/ 400（目标在未分组范围之外）。
 */
async function assertTargetsWithinUngrouped(port, targets) {
  if (port === null || typeof port !== "object" || typeof port.readUngroupedMembers !== "function") {
    // 没有未分组成员读面 = 无法证明目标合法：fail-closed，绝不跳过校验直接删。
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  }
  let raw;
  try {
    raw = await port.readUngroupedMembers();
  } catch (error) {
    throw unavailable(error);
  }
  const facts = readUngroupedFacts(raw);
  if (facts === undefined) throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  let rawHeaders;
  try {
    rawHeaders = await port.readHeaders?.();
  } catch (error) {
    throw unavailable(error);
  }
  if (!Array.isArray(rawHeaders)) {
    // 清单读不出来 → 后代闭包判不了 → fail-closed（不把任何目标当成「闭包里没有成员」）。
    throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
  }
  const index = buildSessionChildIndex(
    normalizeSessionHeaders(rawHeaders),
    normalizeDegChildLinks(readDegChildrenStrict(port)),
  );
  const outside = [];
  for (const sessionId of targets) {
    if (!isUngroupedTarget(index, facts.ungrouped, facts.workspace, sessionId)) outside.push(sessionId);
  }
  if (outside.length === 0) return;
  throw sessionDeleteRpcError(
    SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED,
    SESSION_DELETE_RPC_MESSAGES[SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED],
    { details: { sessionIds: outside } },
  );
}

/**
 * 未分组范围的**执行前二次授权**（TOCTOU 收敛，见模块头同名小节）。
 *
 * 授权阶段读的是请求时刻的 U/W 快照，而作业会在之后重新捕获事实并执行；两次读取之间
 * 工作区成员关系可能变化。这个回调由作业在**冻结计划之后、任何删除动作之前**调用一次，
 * 拿到的是真正要删的成员集合，因此这里必须重新读一遍 U/W，而不是复用授权阶段的结论。
 *
 * 判据只有一条：`plan.members ∩ W = ∅`。**不**要求 `plan.members ⊆ U`——计划里包含
 * 未分组根的后代（可能是 subagent 会话、也可能 header 已消失），它们本来就不在 U 里，
 * 用 U 去卡会把合法闭包误判成越界。
 *
 * 失败口径与授权阶段一致：读面不可用 → 503 `delete-unavailable`；发现工作区成员 →
 * 400 `delete-targets-outside-ungrouped`（details 给出越界成员）。两种都让作业零删除。
 *
 * @param {object|undefined} port - `{readUngroupedMembers}`（与授权阶段同一份读面）。
 * @returns {(plan: {members: string[]}) => Promise<void>} 供作业调用的授权回调。
 */
function buildUngroupedReauthorizer(port) {
  return async ({ members }) => {
    if (port === null || typeof port !== "object" || typeof port.readUngroupedMembers !== "function") {
      // 读面在两次调用之间消失（卸载/热重载）：无法证明，按不可用拒绝。
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
    }
    let raw;
    try {
      raw = await port.readUngroupedMembers();
    } catch (error) {
      throw unavailable(error);
    }
    const facts = readUngroupedFacts(raw);
    if (facts === undefined) throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
    const intruding = [];
    for (const sessionId of members ?? []) {
      if (typeof sessionId !== "string" || sessionId.length === 0) continue;
      if (facts.workspace.has(sessionId)) intruding.push(sessionId);
    }
    if (intruding.length === 0) return;
    throw sessionDeleteRpcError(
      SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED,
      SESSION_DELETE_RPC_MESSAGES[SESSION_DELETE_RPC_CODES.TARGETS_OUTSIDE_UNGROUPED],
      { details: { sessionIds: intruding } },
    );
  };
}

/**
 * 装配一个**晚绑定**的命令面（RPC 核心的 deps 在更早的装配段构造，真正的命令面在更后段才
 * 存在）：每次调用都按 `readCommands` 现取，段未装配/已卸载时按「能力不可用」fail-closed。
 *
 * 错误映射用模块级纯函数（不需要命令面在场），否则「段缺失」这个错误码自己会掉进 500。
 *
 * @param {object} deps
 * @param {() => (object|undefined)} deps.readCommands - 命令面读取器（晚绑定）。
 * @returns {{handle: Function, mapError: Function}} 与 {@link installSessionDeleteRpc} 同形的窄面。
 */
export function installSessionDeleteCommandFace({ readCommands }) {
  return Object.freeze({
    handle: (...args) => {
      const commands = typeof readCommands === "function" ? readCommands() : undefined;
      if (commands === undefined || commands === null || typeof commands.handle !== "function") {
        throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
      }
      return commands.handle(...args);
    },
    mapError: (error) => mapSessionDeleteRpcError(error),
  });
}

/**
 * 创建会话删除的 RPC 命令面。
 *
 * @param {object} deps - 窄能力面（不读 ctx、不读全局状态）。
 * @param {{list: Function, listUngrouped: Function}} deps.candidates - 票据 04 的候选查询组合面
 *   （`list(workspaceId)` 工作区范围 / `listUngrouped()` 未分组范围）。
 * @param {{run: (request: object) => Promise<object>}} deps.job - 票据 02 的删除作业。
 * @param {object} deps.workspaceTargets - 目标归属校验的读面（工作区与未分组两个范围共用；
 *   缺省 = 校验无法进行 = 一律 503）：
 *   `{readMembers(workspaceId), readUngroupedMembers(), readHeaders(), readDegChildren()}`。
 * @returns {{handle: Function, mapError: Function}} 命令面：按 action 产出响应体 / 映射自己的错误码。
 */
export function installSessionDeleteRpc({ candidates, job, workspaceTargets }) {
  /**
   * 候选查询：范围解析 → 组合面 → 原样回传快照（客户端拿到的字段名是协议的一部分）。
   *
   * 工作区范围多带 `workspaceId`，未分组范围只带 `scope`——两者都没有「另一个范围的字段」，
   * 客户端据此切换选中锁定的口径。未分组范围**不会**返回 workspace-not-found。
   */
  async function candidatesOf(body) {
    const range = readRangeOf(body);
    if (range.kind === "ungrouped") {
      if (candidates === null || typeof candidates !== "object" || typeof candidates.listUngrouped !== "function") {
        // 命令面没有未分组读面（旧装配/替身）：fail-closed 成「候选查询不可用」，
        // 绝不退化成空候选列表（那会被界面当成「没有可删的会话」）。
        throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE);
      }
      const snapshot = await candidates.listUngrouped();
      return { scope: "ungrouped", ...snapshot };
    }
    const snapshot = await candidates.list(range.workspaceId);
    return { scope: "workspace", workspaceId: range.workspaceId, ...snapshot };
  }

  /** 删除执行：范围解析 → 入参校验 → 目标归属校验 → 交给作业 → 忙碌/不可用时抛稳定错误码。 */
  async function removeOf(body) {
    const range = readRangeOf(body);
    const targets = normalizeTargets(body?.targets);
    // 信任边界：目标归属只认服务端自己的成员/血缘事实（客户端传什么都不作数）。
    // 校验发生在作业之前，因此「部分非法」= 整批拒绝，绝不会先删掉合法的那几个。
    if (range.kind === "ungrouped") {
      await assertTargetsWithinUngrouped(workspaceTargets, targets);
    } else {
      await assertTargetsWithinWorkspace(workspaceTargets, range.workspaceId, targets);
    }
    // 实例锁不可用时提前短路：错误消息里直接带锁文件路径与操作步骤（客户端会把 message 显示
    // 出来，用户才知道要删哪个文件）。原因码仍是稳定的 delete-unavailable。
    // 其它不可用原因（收敛文档损坏、持久化缺失…）**不在这里拦截**：作业照原流程逐目标判定，
    // 消息保持通用，绝不把非锁问题伪装成「请删除锁文件」。
    const capability = typeof candidates?.availability === "function" ? candidates.availability() : undefined;
    if (capability !== undefined && capability.available !== true && typeof capability.message === "string") {
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE, capability.message, {
        ...(capability.details === undefined ? {} : { details: capability.details }),
      });
    }
    const titleOf = normalizeTitles(body?.titles);
    // 未分组范围额外注入执行前二次授权：作业冻结计划后会按**新鲜**的 U/W 再复核一次实际
    // 成员集合（两次读取之间成员关系可能变化，只校验请求快照会放行未经检查的删除）。
    // 工作区范围不注入：它不要求 closure ∩ W = ∅ 的强保证，保持既有语义零回归。
    const authorize = range.kind === "ungrouped" ? buildUngroupedReauthorizer(workspaceTargets) : undefined;
    let summary;
    try {
      summary = await job.run({
        sessionIds: targets,
        ...(titleOf === undefined ? {} : { titleOf }),
        ...(authorize === undefined ? {} : { authorize }),
      });
    } catch (error) {
      // 作业端口自身的故障（装配缺失、快照读失败等）：一律收敛成「能力不可用」，不泄露细节。
      if (typeof error?.code === "string" && STATUS_OF_CODE[error.code] !== undefined) throw error;
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE, undefined, { cause: error });
    }
    if (summary?.accepted !== true) {
      if (summary?.busy === true) {
        // 忙碌是**可重试的状态冲突**（409），不是内部错误：details 保留作业给出的结构化回执。
        throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.JOB_BUSY, undefined, {
          details: {
            accepted: false,
            busy: true,
            requestedSessionIds: Array.isArray(summary.requestedSessionIds) ? summary.requestedSessionIds : targets,
            inFlightSessionIds: Array.isArray(summary.inFlightSessionIds) ? summary.inFlightSessionIds : [],
          },
        });
      }
      // 其余拒绝（快照不可用）：本次什么都没动，删除入口应置为不可用。
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
    }
    return summary;
  }

  return Object.freeze({
    /**
     * 按 action 产出一个响应体（handler 负责补 `ok:true` 并写出 envelope）。
     *
     * @param {string} action - {@link SESSION_DELETE_ACTIONS} 之一。
     * @param {object} body - 已解码的请求体。
     * @returns {Promise<object>} 响应体（不含 `ok`）。
     */
    async handle(action, body) {
      if (action === SESSION_DELETE_ACTIONS.CANDIDATES) return await candidatesOf(body);
      if (action === SESSION_DELETE_ACTIONS.REMOVE) return await removeOf(body);
      // 分发表保证只有这两个 action 会进来；真到了这里说明路由表与命令面不同步。
      throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.BAD_REQUEST, "未知 action");
    },
    mapError: mapSessionDeleteRpcError,
  });
}
