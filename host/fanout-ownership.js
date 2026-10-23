/**
 * Host 关注点模块：fan-out 父任务 ownership 判定与所有权索引。
 *
 * 本模块是「这个父任务属于哪个 root、这个 root 还能不能写它」的唯一 owner：
 * 活动绑定的解析顺序、已结算索引、已回收归属提示、冷恢复读凭据与创建时归属快照
 * 都在这里创建、读写与销毁。其它 Host 模块只能经冻结命令面使用它们，
 * 拿不到任何 Map / Set 引用（票据 11 / R2「状态唯一 owner」）。
 *
 * 分成三层（每层单向依赖，无环）：
 * 1. `createOwnershipIndex()`：**唯一**持有 5 个索引容器的闭包，只暴露命令与只读投影；
 * 2. 模块级无状态判定（能力投影、续作准入、归属证据）：只接收冻结的 `judges` 命令面；
 * 3. `createFanoutOwnershipService()`：装配 = 建索引 + 建命令面 + 转发（不做判定）。
 *
 * 所有判定 fail-closed：拿不到证据就返回 null / false / not_owner，绝不用字符串 id
 * 或已结算索引兜底授权写操作；关闭语义由注入的 isClosed 表达，关闭后一律 fail-closed。
 *
 * @module dsh-expert-group/host/fanout-ownership
 */

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * manager 权威视角的父任务终态判定，与 snapshotTaskIsTerminal（只按恢复负载推导）互补。
 *
 * 为什么两套判定都要：恢复负载里的任务可能被 manager 在**同一个同步恢复窗口内**聚合到
 * 终态（例如无 shard 的恢复任务直接聚合为 completed，或恢复重排后立即收敛），此时
 * manager 因 restoringSnapshot 不再发布 task_settled，归属只能按这里的权威状态归还；
 * 只看恢复负载会让归属 id 一直滞留到 close（审核发现 04 的轻微泄漏）。
 *
 * 只接受 manager 的任务投影（getTask/taskSnapshot）：status 非 pending 或 settledAt 是
 * 数字即视为终态；stub/未知形态（null、缺字段）一律判非终态，宁可保留 binding 也不能
 * 误释放活动任务的 ownership。
 *
 * @param {object|null|undefined} taskView manager 的任务投影。
 * @returns {boolean}
 */
function managerTaskIsTerminal(taskView) {
  if (taskView === null || typeof taskView !== "object") return false;
  if (typeof taskView.settledAt === "number") return true;
  return typeof taskView.status === "string" && taskView.status !== "pending";
}

/**
 * 逐动作能力项的白名单归一：只保留 { allowed, reason? }，拒绝路径必须带稳定原因码。
 *
 * manager 的能力投影是内部结构；Host 在这里再收敛一次，保证 RPC / 快照 / 客户端
 * 三处看到的是同一形状，且没有额外字段穿透到客户端。
 */
function capabilityEntry(entry, fallbackReason = "not_supported") {
  if (entry === null || typeof entry !== "object" || typeof entry.allowed !== "boolean") {
    return { allowed: false, reason: fallbackReason };
  }
  if (entry.allowed === true) return { allowed: true };
  const reason = typeof entry.reason === "string" && entry.reason.length > 0 ? entry.reason : fallbackReason;
  return { allowed: false, reason };
}

/** 统一拒绝项：能力不可用时必须带稳定原因码，绝不返回 undefined。 */
function deniedCapability(reason) {
  return { allowed: false, reason };
}

/** 归属提示上限：与 fanout.js 的迟到回调记忆同阶，远大于单次回收批量（maxTasks=64）。 */
const RECLAIMED_OWNER_MEMORY = 256;

/**
 * continuation 归属拒绝的可诊断分类（只读、不泄露任务负载）。
 *
 * 只用于 Host 侧日志/结构化解构，不参与任何授权决策：授权只看
 * 「活动绑定 + exact parent Agent + 绑定代际 token 仍 live」这三个硬条件。
 */
function describeContinuationOwnership({ owner, boundAgent, parent, bindingToken }) {
  if (typeof owner !== "string" || owner.length === 0) return "no_active_binding";
  if (owner !== parent?.id) return "owner_mismatch";
  if (boundAgent === undefined) return "parent_agent_unresolved";
  if (boundAgent !== parent) return "parent_agent_replaced";
  if (bindingToken === undefined) return "generation_evidence_missing";
  if (bindingToken.agent !== parent) return "generation_owner_mismatch";
  return "generation_not_live";
}

/**
 * 活动绑定的读证据（与写路径同一套硬条件）：owner + exact parent Agent + 绑定代际 token。
 * 只回答「这次读取是否有可证明的来源」，不回答任务是否可写。
 *
 * 无状态：只读 lineage，不接触任何索引容器，因此可以安全地放在模块级。
 *
 * @param {object} lineage - 父任务绑定小接口。
 * @param {object} parent - 调用方 exact root Agent。
 * @param {string} parentTaskId
 * @returns {"active_binding"|null}
 */
function activeBindingReplayEvidence(lineage, parent, parentTaskId) {
  const owner = typeof lineage.resolveOwner === "function" ? lineage.resolveOwner(parentTaskId) : undefined;
  if (typeof owner !== "string" || owner !== parent.id) return null;
  const boundAgent = typeof lineage.parentAgentOf === "function" ? lineage.parentAgentOf(parentTaskId) : undefined;
  if (boundAgent !== parent) return null;
  const bindingToken = typeof lineage.parentTokenOf === "function" ? lineage.parentTokenOf(parentTaskId) : undefined;
  if (bindingToken === undefined || bindingToken.agent !== parent) return null;
  return lineage.isLiveGeneration(parent, bindingToken) ? "active_binding" : null;
}

/**
 * 创建 ownership 索引（**唯一**持有 5 个归属容器的闭包）。
 *
 * 返回面只有命令与只读投影：调用方拿不到 Set/Map 本身，也无法绕过命令写状态。
 * 生命周期：随 ownership 服务创建；`close()` 归还全部恢复任务归属并丢弃进程内索引。
 *
 * @param {object} deps
 * @param {object} deps.lineage - 父任务绑定小接口（resolveOwner / releaseParentTask 等）。
 * @param {Function} deps.warn - 日志旁路，释放失败不得影响归还语义。
 * @returns {Readonly<object>} 冻结命令面。
 */
function createOwnershipIndex({ lineage, warn }) {
  /**
   * 本次进程内由 restore() 建立 ownership 的父任务 id。
   * 恢复任务的 ownership 必须保留到真实终态或关闭路径释放：RPC 查询、事件归属过滤与
   * 持久化投影都依赖 lineage 的 parentSessions 映射；恢复时立即释放会让任务无法寻址，
   * 并让后续 snapshot 丢掉 parentSessions。只跟踪本进程内恢复的任务，不使用「bind 时
   * 就记账」的写法——submit 的绑定由 manager 快照路径负责，避免维护第二套所有权真相。
   */
  const restoredOwnership = new Set();
  /**
   * 已终态、且活动 ownership 已到期的恢复任务 -> 父会话 id。
   *
   * 只保存 parentSessions 索引（与持久化快照同形）：任务数据永远来自 manager 的权威
   * listTasks()/getTask()，这里不复制 task/result，也不做第二套任务数据库。
   * lineage 的 parentSessions 只表达**活动**绑定，终态任务在 restore()/真实终态时必须
   * 释放；但任务树仍要按根列出这些任务，否则冷启动后它们会从任何根的任务树中消失。
   * 归属解析顺序：lineage 当前绑定 → 本索引。
   */
  const settledParentSessions = new Map();
  /**
   * 任务创建/恢复时快照的父会话归属：parentTaskId -> parentSessionId。
   *
   * 为什么需要第三份索引：root 被销毁时（index.js 走 lineage.releaseAgent）会按父会话
   * 整批摘除活动绑定；若 root 先销毁、任务后结算，归还路径就再也解析不到归属——持久化
   * 投影丢映射，重启后该任务从任务树消失（审核发现 04）。这份快照只用于**归还路径的
   * 兜底**，绝不参与 resolvedOwner 的寻址与访问控制（那必须只看活动绑定）。
   */
  const ownershipSnapshot = new Map();
  /**
   * 冷恢复读凭据：parentTaskId -> { agent, token, ownerId }。
   *
   * 只由 restore() 为一个**本进程确实恢复过**的任务写入，并绑定当时的 exact root Agent
   * 与它的 generation token。用途仅限 continuation 的只读幂等重放（duplicate 回执），
   * 不参与任何授权写决策；close() 时整体丢弃。
   */
  const restoreReadCredentials = new Map();
  /**
   * 已回收任务的**归属提示**：parentTaskId -> parentSessionId（有界、只在内存）。
   *
   * 回收会同时移除任务与全部归属索引，之后查询只能回答 "not-found"；这份提示把
   * "这个任务曾属于你、但已被回收" 收敛成票据 05/09 约定的 task_not_found。只含 id
   * （不复制任务数据）、有界、不写 storage、重启即消失，因此**不是**任务墓碑；对其它
   * root 一律仍是 not_owner（不泄露跨 root 存在性）。
   */
  const reclaimedTaskOwners = new Map();

  /**
   * 父任务归属解析：优先当前代际的活动绑定，其次终态任务的持久化归属索引。
   * 两者都只回答「这个父任务属于哪个根会话」，不回答任务是否还在活动。
   */
  function resolvedOwner(parentTaskId) {
    const active = typeof lineage.resolveOwner === "function"
      ? lineage.resolveOwner(parentTaskId)
      : (typeof lineage.parentSessionOf === "function" ? lineage.parentSessionOf(parentTaskId) : undefined);
    if (typeof active === "string" && active.length > 0) return active;
    const settled = settledParentSessions.get(parentTaskId);
    return typeof settled === "string" && settled.length > 0 ? settled : null;
  }

  /**
   * 归还路径的归属解析：先活动绑定（与寻址/事件过滤同一语义），活动绑定已消失时
   * 回退到任务创建/恢复时快照的父会话归属。
   *
   * 回退只服务「写 settled 索引」这一件事：root 先被销毁时 lineage 已无绑定，若直接
   * 放弃，持久化投影就丢映射，重启后该任务从任务树消失。
   */
  function returnOwner(parentTaskId) {
    const active = resolvedOwner(parentTaskId);
    if (typeof active === "string" && active.length > 0) return active;
    const snapshotOwner = ownershipSnapshot.get(parentTaskId);
    return typeof snapshotOwner === "string" && snapshotOwner.length > 0 ? snapshotOwner : null;
  }

  /** 记一条已回收任务的归属提示（有界，插入序淘汰最旧项）。 */
  function rememberReclaimedOwner(parentTaskId, ownerId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    if (typeof ownerId !== "string" || ownerId.length === 0) return;
    reclaimedTaskOwners.delete(parentTaskId);
    reclaimedTaskOwners.set(parentTaskId, ownerId);
    while (reclaimedTaskOwners.size > RECLAIMED_OWNER_MEMORY) {
      const oldest = reclaimedTaskOwners.keys().next().value;
      reclaimedTaskOwners.delete(oldest);
    }
  }

  /** 已回收任务的归属提示（只读；没有记录返回 null）。内部不过关闭闸门。 */
  function reclaimedOwnerOf(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return null;
    const owner = reclaimedTaskOwners.get(parentTaskId);
    return typeof owner === "string" && owner.length > 0 ? owner : null;
  }

  /** 记下创建/恢复时的归属快照（命令；调用方给不出容器）。 */
  function rememberOwnerSnapshot(parentTaskId, ownerId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    if (typeof ownerId !== "string" || ownerId.length === 0) return;
    ownershipSnapshot.set(parentTaskId, ownerId);
  }

  /** 撤销一个父任务的归属快照（submit 失败路径用）。 */
  function forgetOwnerSnapshot(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    ownershipSnapshot.delete(parentTaskId);
  }

  /**
   * 归还父任务归属：把归属写进 settled 索引并把创建/恢复时的快照用完即删。
   *
   * settled 索引是任务树与持久化投影的归属来源：lineage 释放活动绑定后，任务数据仍由
   * manager 权威持有，但只有靠这份索引才能按根找回（否则重启后丢节点）。
   *
   * @param {string} parentTaskId
   * @param {boolean} [releaseBinding] - 是否同时释放 lineage 的活动绑定。三个真实释放点
   *   （settle 事件的真实终态、restore 窗口内的同步收口、close）传 true；submit 的任务
   *   沿用既有语义不在这里释放——它的绑定由 root 销毁/关闭路径负责。
   */
  function settleOwnership(parentTaskId, releaseBinding = false) {
    const owner = returnOwner(parentTaskId);
    if (typeof owner === "string" && owner.length > 0) settledParentSessions.set(parentTaskId, owner);
    ownershipSnapshot.delete(parentTaskId);
    if (releaseBinding) {
      restoredOwnership.delete(parentTaskId);
      lineage.releaseParentTask(parentTaskId);
    }
  }

  /**
   * 真实终态边界的归还：恢复任务的活动 ownership 到期，submit 的任务保持既有绑定语义。
   * 把「是否释放绑定」的判定留在 owner 内部，调用方拿不到 restoredOwnership。
   */
  function settleRestoredOwnership(parentTaskId) {
    settleOwnership(parentTaskId, restoredOwnership.has(parentTaskId));
  }

  /**
   * 回收提交成功后的宿主侧清理：删除全部归属索引、记下归属提示并释放 lineage 绑定。
   * 归属索引的全部出处都必须清理，否则重启后任务树/查询仍能寻址到已回收任务。
   */
  function discardReclaimedOwnership(parentTaskId, ownerId) {
    settledParentSessions.delete(parentTaskId);
    ownershipSnapshot.delete(parentTaskId);
    restoreReadCredentials.delete(parentTaskId);
    restoredOwnership.delete(parentTaskId);
    rememberReclaimedOwner(parentTaskId, ownerId);
    try {
      lineage.releaseParentTask(parentTaskId);
    } catch (error) {
      warn("dsh-expert-group: fan-out reclaim lineage release failed: " + describeError(error));
    }
  }

  /** 标记「本进程由 restore 建立 ownership」（真实终态/关闭时归还）。 */
  function markRestored(parentTaskId) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    restoredOwnership.add(parentTaskId);
  }

  /** 记录冷恢复读凭据（只服务 continuation 的只读幂等重放）。 */
  function recordRestoreCredential(parentTaskId, credential) {
    if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return;
    if (credential === null || typeof credential !== "object") return;
    restoreReadCredentials.set(parentTaskId, credential);
  }

  /** 读取冷恢复读凭据（只读；没有则 undefined）。 */
  function restoreCredentialOf(parentTaskId) {
    return restoreReadCredentials.get(parentTaskId);
  }

  /** 已结算归属的只读投影（拷贝成 [id, owner] 数组，绝不交出 Map）。 */
  function settledParentSessionEntries() {
    return [...settledParentSessions];
  }

  /** 只读诊断计数（不含任何 id 或任务数据）。 */
  function diagnostics() {
    return Object.freeze({
      settledTasks: settledParentSessions.size,
      reclaimedTasks: reclaimedTaskOwners.size,
    });
  }

  /**
   * 关闭时的 ownership 收敛：所有恢复任务的归属先归还（写入 settled 索引，供关闭时的
   * 最终持久化投影使用），再丢弃其余进程内索引。
   *
   * 关闭是 ownership 的另一个真实释放点：模块已封锁，不可能再有 settle 事件。
   * manager.close() 会把仍未终态的恢复任务写成 cancelled，关闭时的最终持久化投影仍要
   * 按 settled 索引取归属，否则重启后这些任务丢节点。已回收归属提示只在进程内服务
   * task_not_found 语义，关闭后不再有意义；读凭据与创建时快照随模块一起丢弃。
   */
  function close() {
    for (const parentTaskId of [...restoredOwnership]) settleOwnership(parentTaskId, true);
    restoredOwnership.clear();
    ownershipSnapshot.clear();
    restoreReadCredentials.clear();
    reclaimedTaskOwners.clear();
  }

  return Object.freeze({
    // ── 只读投影 ──────────────────────────────────────────────────────────
    resolvedOwner,
    returnOwner,
    reclaimedOwnerOf,
    restoreCredentialOf,
    settledParentSessionEntries,
    diagnostics,
    // ── 命令（建立/归还/回收归属；调用方拿不到索引本身）─────────────────────
    rememberOwnerSnapshot,
    forgetOwnerSnapshot,
    settleOwnership,
    settleRestoredOwnership,
    discardReclaimedOwnership,
    markRestored,
    recordRestoreCredential,
    close,
  });
}

/**
 * continuation 只读幂等重放的证据判定。
 *
 * 两级证据，都要求「exact Agent 对象 + 仍然 live 的 generation token」，绝不接受单纯的
 * 字符串 parent id 或 settledParentSessions 兜底：
 * 1. `active_binding`：同进程的活动绑定（owner 命中活动 parentSessions、绑定的 exact
 *    parent Agent 就是调用方、绑定时的 generation token 仍 live）；
 * 2. `restore_credential`：冷恢复时由 restore() 记录的 exact Agent + token（同 id 的
 *    replacement 不是凭据里的对象，因此拿不到读权限）。
 *
 * 返回 null 表示没有可证明的来源 → 调用方必须结构化拒绝（fail-closed）。
 */
function continuationReplayEvidence(judges, parent, parentTaskId, activeBinding) {
  if (parent === undefined || parent === null || typeof parent.id !== "string") return null;
  if (activeBinding !== null) return activeBinding;
  const credential = judges.index.restoreCredentialOf(parentTaskId);
  if (credential === undefined || credential.agent !== parent || credential.token === undefined) return null;
  if (typeof credential.ownerId === "string" && credential.ownerId !== parent.id) return null;
  return judges.lineage.isLiveGeneration(parent, credential.token) ? "restore_credential" : null;
}

/**
 * 该 root 的写入证据（票据 09）：live root + exact parent Agent + 绑定代际 token。
 *
 * 与 continuation 写路径复用**同一个**函数（activeBindingReplayEvidence），因此
 * 「读能力」与「写能力」不会出现两套规则。这里只按 sessionId 从 registry 解析 exact
 * Agent：同 id replacement 得到的是另一个对象，绑定证据自然失效（fail-closed）。
 */
function liveWriteBindingFor(judges, sessionId, parentTaskId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
  const agent = typeof judges.getAgent === "function" ? judges.getAgent(sessionId) : undefined;
  if (agent === null || agent === undefined) return false;
  return activeBindingReplayEvidence(judges.lineage, agent, parentTaskId) !== null;
}

/**
 * 提交父任务：分配 id、绑定 ownership、失败时释放。
 *
 * 创建时快照归属：root 早于任务结算被销毁时，lineage 的活动绑定已被整批摘除，
 * 归还路径只能靠这份快照把归属写回 settled 索引（任务树与重启投影都依赖它）。
 */
function submitOwnership(judges, parent, args = {}) {
  const { lineage, index } = judges;
  const parentTaskId = lineage.allocateParentTaskId(parent);
  lineage.bindParentTask({ parentTaskId, parentId: parent.id, parentAgent: parent });
  index.rememberOwnerSnapshot(parentTaskId, parent.id);
  try {
    const result = judges.getManager().submit({ parentTaskId, ...args });
    if (result.parentTaskId !== parentTaskId) {
      lineage.releaseParentTask(parentTaskId);
      index.forgetOwnerSnapshot(parentTaskId);
    }
    return { ...result, task: judges.getManager().getTask(result.parentTaskId) };
  } catch (error) {
    lineage.releaseParentTask(parentTaskId);
    index.forgetOwnerSnapshot(parentTaskId);
    throw error;
  }
}

/**
 * 按根会话过滤 manager 的权威任务（任务树的唯一数据来源）。
 *
 * 与 lineage.tasksOwnedBy 的差别只有一个：这里同时覆盖**活动 ownership 已到期**
 * 的已终态恢复任务。归属仍按 parentSessions 语义解析，因此不会把任务串到别的根。
 */
function tasksOwnedBy(judges, sessionId) {
  if (judges.isClosed() || typeof sessionId !== "string" || sessionId.length === 0) return [];
  return judges.getManager().listTasks().filter((task) => {
    const parentTaskId = task?.parentTaskId;
    return typeof parentTaskId === "string" && judges.index.resolvedOwner(parentTaskId) === sessionId;
  });
}

/**
 * 单任务归属解析（C7 冷恢复用）：返回当前活动绑定，其次已终态任务的归属索引。
 * 关闭后返回 null，与 getTask/listTasks 的关闭语义一致。
 */
function ownerOf(judges, parentTaskId) {
  if (judges.isClosed() || typeof parentTaskId !== "string" || parentTaskId.length === 0) return null;
  return judges.index.resolvedOwner(parentTaskId);
}

/**
 * 已回收任务的归属提示（只读，供 RPC 把查询/动作回执收敛为 task_not_found）。
 * 只回答「哪个 root 曾拥有这个 id」，不回答任何任务状态；不参与授权。
 */
function reclaimedOwnerProjection(judges, parentTaskId) {
  if (judges.isClosed()) return null;
  return judges.index.reclaimedOwnerOf(parentTaskId);
}

/**
 * 「该 exact live root 能否证明自己拥有这个父任务」的只读判定。
 *
 * 授权条件与 continuation 写路径**同一套硬条件**（activeBindingReplayEvidence），
 * 绝不接受单纯的字符串 parent id，也不使用 settledParentSessions 兜底：
 * 1. 活动绑定存在且 ownerId 精确等于调用方 id；
 * 2. 绑定的 exact parent Agent 就是调用方对象（同 id replacement 不是该对象）；
 * 3. 绑定当时的 generation token 仍是调用方的 live generation；
 * 4. 任务非终态 —— 终态任务不会再产生 task_settled，登记原因等于永久 paused。
 *
 * 只读：不改变任何状态、不注册任何凭据，返回 false 表示无法证明归属（fail-closed）。
 */
function ownsTask(judges, parent, parentTaskId) {
  if (judges.isClosed()) return false;
  if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") return false;
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
  const task = judges.getManager().getTask(parentTaskId);
  if (task === null || managerTaskIsTerminal(task)) return false;
  return activeBindingReplayEvidence(judges.lineage, parent, parentTaskId) !== null;
}

/**
 * 「该 exact live root 是否仍拥有该父任务的写绑定」的只读判定（票据 09）。
 *
 * 与 ownsTask 的唯一差别是**不排除终态任务**：终态任务的取消/重试/续作仍要由同一个
 * 归属证据授权（submit 任务的绑定按既有语义保留到 root 销毁/关闭）。
 */
function hasLiveWriteBinding(judges, parent, parentTaskId) {
  if (judges.isClosed()) return false;
  if (parent === null || typeof parent !== "object" || typeof parent.id !== "string") return false;
  if (typeof parentTaskId !== "string" || parentTaskId.length === 0) return false;
  return activeBindingReplayEvidence(judges.lineage, parent, parentTaskId) !== null;
}

/** 回收等**删除型**写动作的归属证据判定（只读）：只返回布尔，不泄露证据形态。 */
function liveWriteBinding(judges, parent, parentTaskId) {
  return activeBindingReplayEvidence(judges.lineage, parent, parentTaskId) !== null;
}

/**
 * 逐动作能力（票据 09）：归属判定 + manager 能力的唯一合并入口。
 *
 * 判定顺序固定：
 * 1. 归属不匹配（活动绑定与已结算索引都不指向该 root）→ 全部 not_owner；
 * 2. 归属匹配但任务不在 manager 里（含已回收）→ 全部 task_not_found；
 * 3. 归属匹配 → **读永远 allowed**（活动绑定或冷恢复的已结算任务都可读）；
 * 4. 写动作需要 live 写绑定：活动绑定 + 绑定的 exact parent Agent 就是 registry 里
 *    这一代 root + 绑定代际 token 仍 live；否则一律 owner_not_live。
 *
 * @returns {object} { parentTaskId, read, cancel, retry, continue, shards }；永不抛错。
 */
function evaluateCapabilities(judges, sessionId, parentTaskId) {
  const taskId = typeof parentTaskId === "string" ? parentTaskId.trim() : "";
  const denyAll = (reason) => ({
    parentTaskId: taskId,
    read: deniedCapability(reason),
    cancel: deniedCapability(reason),
    retry: deniedCapability(reason),
    continue: deniedCapability(reason),
    shards: {},
  });
  if (judges.isClosed() || taskId.length === 0) return denyAll("task_not_found");
  // 先判归属（票据 09 的固定顺序）：非归属 root 连「任务是否存在」都不进入能力判定。
  const owner = judges.index.resolvedOwner(taskId);
  if (typeof owner !== "string" || owner !== sessionId) {
    // 已回收任务换算成 task_not_found（与票据 05/09 的查询语义一致），但不暴露任务数据。
    if (judges.index.reclaimedOwnerOf(taskId) === sessionId) return denyAll("task_not_found");
    return denyAll("not_owner");
  }
  const manager = judges.getManager();
  const task = manager.getTask(taskId);
  if (task === null || task === void 0) return denyAll("task_not_found");
  // 归属匹配：读能力（含冷恢复的已结算任务）无条件成立。
  const canWrite = liveWriteBindingFor(judges, sessionId, taskId);
  const managerCaps = typeof manager.taskCapabilities === "function" ? manager.taskCapabilities(taskId) : null;
  const shards = {};
  for (const shard of Array.isArray(task.shards) ? task.shards : []) {
    const shardId = typeof shard?.shardId === "string" && shard.shardId.length > 0 ? shard.shardId : null;
    if (shardId === null) continue;
    if (canWrite !== true) {
      shards[shardId] = {
        cancel: deniedCapability("owner_not_live"),
        retry: deniedCapability("owner_not_live"),
      };
      continue;
    }
    const source = managerCaps?.shards !== null && typeof managerCaps?.shards === "object"
      ? managerCaps.shards[shardId]
      : undefined;
    shards[shardId] = {
      cancel: capabilityEntry(source?.cancel),
      retry: capabilityEntry(source?.retry),
    };
  }
  const actionCapability = (name) => (canWrite === true
    ? capabilityEntry(managerCaps?.[name])
    : deniedCapability("owner_not_live"));
  return {
    parentTaskId: taskId,
    read: { allowed: true },
    cancel: actionCapability("cancel"),
    retry: actionCapability("retry"),
    continue: actionCapability("continue"),
    shards,
  };
}

/**
 * 多轮复用：对**本 root 拥有的**父任务续作一轮（同一 parentTaskId / childId，新 attempt）。
 *
 * 全部前置条件都在 manager 状态修改**之前**判定，任一不满足即结构化拒绝、不追加 attempt、
 * 不改变任务状态（fail-closed）。判定顺序：
 * 1. 调用方必须是当前代际的 exact live root（同 id replacement / 已销毁 root 一律拒绝）；
 * 2. 父任务必须由**当前代际**的活动绑定拥有（不使用 settledParentSessions 兜底——那只是
 *    冷恢复后的寻址索引，不构成可写权限证据）；
 * 3. 执行路由必须就绪：continueMessage 已接线，且每个分片既有 child 的 session 可解析。
 *
 * manager 自己负责 role/shard 结构一致性、上一轮 wait-all 是否完成、attempt/requestId
 * 预算与幂等；这里不重复实现。
 *
 * @param {object} judges - 冻结命令面。
 * @param {object} parent - 调用方的 exact root Agent。
 * @param {{parentTaskId:string, role:string, basePrompt:string, shards:object[], requestId?:string}} args
 * @returns {object} 结构化结果（accepted/reason/round/nextAttemptByShard/task）。
 */
function runContinuation(judges, parent, args = {}) {
  const { lineage } = judges;
  if (judges.isClosed()) return { accepted: false, changed: false, code: "RUNTIME_CLOSED", reason: "runtime_closed" };
  const parentTaskId = typeof args?.parentTaskId === "string" ? args.parentTaskId.trim() : "";
  if (parentTaskId.length === 0) return { accepted: false, changed: false, reason: "missing_parent_task_id" };
  /**
   * 已回收任务：显式稳定的"任务已回收"拒绝（票据 05）。回收释放了 lineage 绑定，若继续
   * 走归属判定只会得到 not_owned_by_root，让调用方误以为"这是别人的任务"。
   */
  if (judges.index.reclaimedOwnerOf(parentTaskId) === parent?.id) {
    return {
      accepted: false,
      changed: false,
      code: "TASK_RECLAIMED",
      reason: "task_reclaimed",
      parentTaskId,
      reclaimed: true,
    };
  }
  /**
   * 幂等重放（**只读**，不新增 attempt/child/事件）：已记录的 requestId 直接返回上次结果。
   *
   * 读权限边界：重放同样必须有**明确的来源证据**，不能用「字符串 parent id 相同」或
   * settledParentSessions 兜底来授权——否则同 id replacement root 可以读到旧代际的
   * 续作结果。只接受活动绑定或冷恢复凭据；都没有时不在这里返回，继续走写路径前置
   * 条件并以 not_owned_by_root 结构化拒绝（fail-closed）。
   */
  const replayRequestId = typeof args?.requestId === "string" && args.requestId.length > 0 ? args.requestId : undefined;
  if (replayRequestId !== undefined) {
    const replayEvidence = continuationReplayEvidence(
      judges,
      parent,
      parentTaskId,
      activeBindingReplayEvidence(lineage, parent, parentTaskId),
    );
    if (replayEvidence !== null) {
      const currentTask = judges.getManager().getTask(parentTaskId);
      const recorded = currentTask?.continuationRequests?.[replayRequestId];
      if (recorded !== undefined && recorded !== null && typeof recorded.result === "object") {
        // 重放不触发任何等待工作重新登记（index.js 按 duplicate 标记跳过）。
        return { ...recorded.result, duplicate: true, ...(currentTask === null ? {} : { task: currentTask }) };
      }
    }
  }
  // 1. 调用方代际：token 必须已存在（activateRoot 时铸造）且仍是 exact live generation。
  const callerToken = typeof lineage.tokenOf === "function" ? lineage.tokenOf(parent) : undefined;
  if (callerToken === undefined || !lineage.isLiveGeneration(parent, callerToken)) {
    return { accepted: false, changed: false, reason: "not_live_root", parentTaskId, ownership: "caller_not_live" };
  }
  // 2. 活动 ownership + 绑定代际证据：不做 settled 兜底，也不接受 replacement 继承。
  //    与只读重放共用同一个证据函数，保证读写边界一致。
  const owner = typeof lineage.resolveOwner === "function" ? lineage.resolveOwner(parentTaskId) : undefined;
  const boundAgent = typeof lineage.parentAgentOf === "function" ? lineage.parentAgentOf(parentTaskId) : undefined;
  const bindingToken = typeof lineage.parentTokenOf === "function" ? lineage.parentTokenOf(parentTaskId) : undefined;
  if (activeBindingReplayEvidence(lineage, parent, parentTaskId) === null) {
    return {
      accepted: false,
      changed: false,
      reason: "not_owned_by_root",
      parentTaskId,
      ownership: describeContinuationOwnership({ owner, boundAgent, parent, bindingToken }),
    };
  }
  // 3. 任务存在 + 执行路由就绪（两者都只读）。
  const task = judges.getManager().getTask(parentTaskId);
  if (task === null) return { accepted: false, changed: false, reason: "unknown_parent_task", parentTaskId };
  const readiness = judges.continuationReadiness(task);
  if (readiness?.ok !== true) {
    return {
      accepted: false,
      changed: false,
      reason: typeof readiness?.reason === "string" ? readiness.reason : "continue_route_unavailable",
      parentTaskId,
      shardIds: Array.isArray(readiness?.shardIds) ? readiness.shardIds : [],
    };
  }
  const result = judges.getManager().continueTask({ ...args, parentTaskId });
  const nextTask = judges.getManager().getTask(parentTaskId);
  return { ...result, ...(nextTask === null ? {} : { task: nextTask }) };
}

/**
 * 创建 ownership 服务（装配层：建索引 + 建冻结命令面 + 转发，不做任何判定）。
 *
 * @param {object} deps
 * @param {object} deps.lineage - 父任务绑定小接口：bindParentTask / parentAgentOf /
 *   parentSessionOf / resolveOwner / parentTokenOf / tokenOf / tokenFor / isLiveGeneration /
 *   allocateParentTaskId / releaseParentTask。
 * @param {Function} deps.getAgent - (sessionId) => exact root Agent 或 undefined（registry 读面）。
 * @param {Function} deps.getManager - () => 唯一 manager（任务读面与能力投影的唯一权威）。
 * @param {Function} deps.continuationReadiness - (task) => continuation 路由就绪投影或 undefined。
 * @param {Function} deps.isClosed - () => 是否已 close；关闭后所有判定 fail-closed。
 * @param {Function} deps.warn - (message) => void；日志旁路，异常不得影响判定。
 * @returns {Readonly<object>} 冻结命令面（命令 + 只读投影），不含任何可写索引引用。
 */
export function createFanoutOwnershipService({
  lineage,
  getAgent,
  getManager,
  continuationReadiness,
  isClosed,
  warn,
}) {
  // 唯一状态容器：索引闭包自己持有 5 个 Map/Set，外面只能拿到命令。
  const index = createOwnershipIndex({ lineage, warn });
  // 冻结命令面：判定函数只读它，不再各自捕获 deps（C3 参数组保持 6 组）。
  const judges = Object.freeze({ lineage, getAgent, getManager, continuationReadiness, isClosed, index });

  return Object.freeze({
    // ── 只读投影（归属解析 / 终态判定 / 诊断计数）─────────────────────────────
    resolvedOwner: index.resolvedOwner,
    returnOwner: index.returnOwner,
    ownerOf: (parentTaskId) => ownerOf(judges, parentTaskId),
    tasksOwnedBy: (sessionId) => tasksOwnedBy(judges, sessionId),
    reclaimedOwnerOf: (parentTaskId) => reclaimedOwnerProjection(judges, parentTaskId),
    taskIsTerminal: managerTaskIsTerminal,
    settledParentSessionEntries: index.settledParentSessionEntries,
    diagnostics: index.diagnostics,
    // ── 命令（建立/归还/回收归属；调用方拿不到索引本身）────────────────────────
    submit: (parent, args = {}) => submitOwnership(judges, parent, args),
    settleOwnership: index.settleOwnership,
    settleRestoredOwnership: index.settleRestoredOwnership,
    discardReclaimedOwnership: index.discardReclaimedOwnership,
    rememberOwnerSnapshot: index.rememberOwnerSnapshot,
    markRestored: index.markRestored,
    recordRestoreCredential: index.recordRestoreCredential,
    // ── 判定命令（只读结论；写权限统一走 live 写绑定）──────────────────────────
    ownsTask: (parent, parentTaskId) => ownsTask(judges, parent, parentTaskId),
    hasLiveWriteBinding: (parent, parentTaskId) => hasLiveWriteBinding(judges, parent, parentTaskId),
    liveWriteBinding: (parent, parentTaskId) => liveWriteBinding(judges, parent, parentTaskId),
    capabilitiesOf: (sessionId, parentTaskId) => evaluateCapabilities(judges, sessionId, parentTaskId),
    continueTask: (parent, args = {}) => runContinuation(judges, parent, args),
    close: index.close,
  });
}
