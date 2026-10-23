/**
 * 入口图片路由的 claim / cleanup-token 状态域（R4e · 票据 19）。
 *
 * 两阶段图片路由的**唯一状态 owner**：`routeClaims`（路由声明）与
 * `observerCleanupTokens`（Observer 一次性清理凭据），以及后者的容量预占计数。
 *
 * 设计约束（与迁移前一致）：
 * - claim/token id 由 `randomUUID()` 生成，客户端只能回传收到的 id（不可猜测）；
 * - 真实路由指纹只留在 Host 内存，响应只回传 id（不泄露 provider/model）；
 * - 绑定签发它的 root sessionId + exact root generation token：跨会话回放、同 id
 *   root replacement 后的旧 claim 都必定失败；
 * - 有界：容量上限 + TTL 惰性淘汰（无定时器），校验成功后按消费策略删除；
 * - cleanup token **只淘汰过期项**，容量控制在启动 Observer 之前用原子预占完成——
 *   淘汰仍活跃的 token 会让对应 child 失去客户端补偿通道，退化成孤儿。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册：两个 `ctx.effect` 清理注册仍由 `index.js` 在原注册点执行，
 * 这里只暴露 `clearRouteClaims()` / `clearObserverCleanupTokens()` 命令。
 * `index.js` 不对容器做任何 get/set/delete/clear。
 *
 * ## 对外接口
 * 签发/校验/撤销/标记 committing、cleanup token 的预占/签发/撤销/消费、只读计数投影
 * （`describeImageRouteState()`），以及尽力中断 Observer child 的清理命令。
 *
 * @module dsh-expert-group/host/index-image-claims
 */
import { randomUUID } from "node:crypto";

/**
 * 创建图片路由 claim/token 状态域。
 *
 * @param {object} deps - 窄能力面（4 组）。
 * @param {object} deps.agents - Agent 读面：`get(sessionId)`（解析 root agent）。
 * @param {object} deps.lineage - 根代际面：`isLiveGeneration(parent, token)`
 *   （claim/token 绑定 exact root generation）。
 * @param {object} deps.subagents - subagent 服务：`interrupt(childId, { kind: "ancestor", agent })`
 *   （尽力清理孤儿 Observer child）。
 * @param {Function} deps.resolveMainImageRoute - wire 域的路由取证函数（校验 claim 时重算指纹）。
 * @returns {object} claim/token 命令面 + 只读计数投影。
 */
export function createImageRouteClaims({ agents, lineage, subagents, resolveMainImageRoute }) {
  /**
   * 一次 image-route 的"路由声明"（route claim），用于消除 TOCTOU：
   * Host 判定能力后，client 才真正 `session.prompt`，期间模型可能再次切换。
   *
   * 设计约束：
   * - **不可猜测**：claim id 由 Node 内置 `randomUUID()` 生成，客户端只能回传自己收到的 id；
   * - **不泄露**：真实 fingerprint（provider/model 摘要）只留在 Host 内存，响应只回传 id；
   * - **绑定会话与代际**：claim 绑定签发它的 root sessionId + exact root generation token，
   *   跨会话回放、同 id root replacement 后的旧 claim 都必定失败；
   * - **有界**：容量上限 + TTL 惰性淘汰（无定时器），校验成功后立即消费，避免无界增长。
   */
  const ROUTE_CLAIM_LIMIT = 64;
  const ROUTE_CLAIM_TTL_MS = 5 * 60 * 1000;
  /**
   * claim id -> {
   *   sessionId, fingerprint, rootToken, target: "main"|"observer",
   *   state: "issued"|"committing", observerAttachments?: object[], capability?: object, expiresAt
   * }
   *
   * 只保存 Host 创建的 durable PNG attachment ref + 能力三态投影 + exact root token 引用：
   * 图片字节与用户文本都不进入 claim 表（Observer 也无从拿到用户原文）。
   * 每个 claim 的 refs 数量受图片上限约束（1-16），整表容量上限 64，因此有界。
   */
  const routeClaims = new Map();

  /**
   * Observer commit 成功后签发的一次性清理 token：客户端在 root prompt 失败/取消时用它
   * 请求 Host 中断刚创建的 child，避免孤儿 child 向 root 反馈。
   *
   * 表同样是进程内、有界 + TTL：只存 `{ sessionId, rootToken, childId, expiresAt }`，
   * 不含 provider/model/用户文本；无论 interrupt 成功与否都在校验后消费。
   *
   * 容量策略（关键）：**只淘汰过期项**。表满时绝不淘汰仍可能活跃的 token ——
   * 那会让客户端 finalizer 拿到 404 并把对应 child 变成孤儿。正确做法是在 commit
   * 启动 Observer **之前**做容量预占：见 reserveObserverCleanupSlot。
   */
  const OBSERVER_CLEANUP_LIMIT = 64;
  const observerCleanupTokens = new Map();
  /** 已预占但尚未签发的槽位数（并发 commit 的原子容量预占）。 */
  let pendingCleanupReservations = 0;

  /** 路由证据的稳定摘要：只用于 Host 内部比较，绝不回传客户端。 */
  function routeFingerprint(route) {
    if (route === null || typeof route !== "object") return "";
    const provider = typeof route.provider === "string" ? route.provider : "";
    const model = typeof route.model === "string" ? route.model : "";
    if (provider.length === 0 || model.length === 0) return "";
    return provider + "\u0000" + model;
  }

  /**
   * claim/清理 token 是否仍属于签发时的 exact root generation。
   *
   * 同 id 的 root 被重建/替换（或已销毁、卸载阻塞）后，旧 token 必须立即失效：
   * 插件对 `lineage` 是硬依赖，因此这里 fail-closed —— 查询异常、缺少 token
   * 或 lineage 能力缺失都返回 false，绝不猜测"还是同一个 root"。
   * @param {object} parent - 当前 agents.get(sessionId) 解析出的根 agent。
   * @param {{rootToken?: unknown}} entry - 签发时记录的 root token。
   * @returns {boolean} 是否仍是同一代 live root。
   */
  function isEntryGenerationLive(parent, entry) {
    if (parent === void 0 || entry === null || typeof entry !== "object") return false;
    if (typeof entry.rootToken !== "string" && (entry.rootToken === null || typeof entry.rootToken !== "object")) return false;
    try {
      if (typeof lineage?.isLiveGeneration !== "function") return false;
      return lineage.isLiveGeneration(parent, entry.rootToken) === true;
    } catch {
      return false;
    }
  }

  /** 惰性淘汰：先清过期项，再按插入顺序淘汰最旧项，保证 claim 表容量有界。 */
  function pruneRouteClaims(now) {
    for (const [id, entry] of routeClaims) {
      if (entry.expiresAt <= now) routeClaims.delete(id);
    }
    while (routeClaims.size >= ROUTE_CLAIM_LIMIT) {
      const oldest = routeClaims.keys().next();
      if (oldest.done === true) break;
      routeClaims.delete(oldest.value);
    }
  }

  /**
   * 清理 token 的惰性淘汰：**只删除过期项**，绝不淘汰容量上限内的活跃 token。
   *
   * 淘汰活跃 token 会让对应 Observer child 失去客户端补偿通道（client finalizer 404），
   * 从而退化成孤儿 child。真正的容量控制在 commitment 之前用预占完成。
   */
  function pruneObserverCleanupTokens(now) {
    for (const [id, entry] of observerCleanupTokens) {
      if (entry.expiresAt <= now) observerCleanupTokens.delete(id);
    }
  }

  /**
   * 在启动 Observer **之前**原子预占一个 cleanup token 槽位。
   *
   * 先清理过期项，再判断 `已签发 + 已预占 >= 上限`：检查与自增之间没有 await，
   * 因此并发 commit 不可能超发（同一时刻只有一个调用栈能完成 check+increment）。
   * @returns {boolean} 是否预占成功；false 表示容量已满，调用方必须拒绝本次 commit 且不启动 child。
   */
  function reserveObserverCleanupSlot() {
    pruneObserverCleanupTokens(Date.now());
    if (observerCleanupTokens.size + pendingCleanupReservations >= OBSERVER_CLEANUP_LIMIT) return false;
    pendingCleanupReservations += 1;
    return true;
  }

  /** 释放未被消费的预占（admission 失败、后置检查失败等路径）。 */
  function releaseObserverCleanupSlot() {
    if (pendingCleanupReservations > 0) pendingCleanupReservations -= 1;
  }

  /**
   * 为刚接受 admission 的 Observer child 签发一次性清理 token。
   *
   * 调用方**必须**先成功 `reserveObserverCleanupSlot()`：这里把预占转成真实 token，
   * 净占用保持不变（-1 预占 / +1 token），因此签发后仍不可能超过上限。
   * @param {{sessionId: string, rootToken: unknown, childId: string}} input - 绑定信息。
   * @returns {string} 不透明 token（只在 commit 成功响应中回传客户端）。
   */
  function issueObserverCleanupToken({ sessionId, rootToken, childId }) {
    if (pendingCleanupReservations > 0) pendingCleanupReservations -= 1;
    pruneObserverCleanupTokens(Date.now());
    const id = randomUUID();
    observerCleanupTokens.set(id, { sessionId, rootToken, childId, expiresAt: Date.now() + ROUTE_CLAIM_TTL_MS });
    return id;
  }

  /** 删除一个刚签发、但最终没有交付给客户端的 cleanup token。 */
  function revokeObserverCleanupToken(token) {
    if (typeof token !== "string" || token.length === 0) return;
    observerCleanupTokens.delete(token);
  }

  /**
   * 校验并**消费**一个 Observer 清理 token。
   *
   * 结构化校验：token 必须是非空有界字符串、必须查到记录、必须属于同一 root session、
   * 必须绑定同一个 childId、且必须是同一 exact root generation。任何一项不满足都返回
   * ok:false 并给出稳定的内部 reason（对外只映射成 404，不泄露是哪一项）。
   * 无论 interrupt 是否成功，校验通过后 token 都会被删除（一次性语义）。
   *
   * @param {{token?: unknown, sessionId?: string, childId?: unknown}} input - 校验输入。
   * @returns {{ok: boolean, reason?: string, parent?: object, childId?: string}} 校验结果。
   */
  function consumeObserverCleanupToken({ token, sessionId, childId }) {
    if (typeof token !== "string" || token.length === 0 || token.length > 128) return { ok: false, reason: "unknown-token" };
    const entry = observerCleanupTokens.get(token);
    if (entry === void 0) return { ok: false, reason: "unknown-token" };
    if (entry.expiresAt <= Date.now()) {
      observerCleanupTokens.delete(token);
      return { ok: false, reason: "expired-token" };
    }
    if (entry.sessionId !== sessionId) return { ok: false, reason: "session-mismatch" };
    if (typeof childId !== "string" || childId.length === 0 || entry.childId !== childId) return { ok: false, reason: "child-mismatch" };
    const parent = agents.get(sessionId);
    if (parent === void 0 || !isEntryGenerationLive(parent, entry)) return { ok: false, reason: "generation-mismatch" };
    // 全部校验通过才消费：伪造/跨会话/串 child 的请求不能把合法客户端的 token 烧掉。
    // 此后无论 interrupt 成功与否，token 都不再可重放（一次性语义）。
    observerCleanupTokens.delete(token);
    return { ok: true, parent, childId: entry.childId };
  }

  /**
   * 为当前 root session 的待生效路由签发一个 claim。
   *
   * target=observer 的 claim 会暂存 Host 创建的 durable PNG refs（不含字节、不含用户文本），
   * 供两阶段提交时使用；main 的 claim 只保存路由摘要。两者都绑定 exact root generation。
   *
   * @param {object} input - 签发输入。
   * @param {string} input.sessionId - 签发该 claim 的根会话 id。
   * @param {{provider?: string, model?: string}} input.route - 能力判定所依据的路由证据。
   * @param {"main"|"observer"} input.target - 该 claim 允许被哪一种消费动作使用。
   * @param {unknown} input.rootToken - `lineage.tokenFor(parent)` 的 exact 代际 token。
   * @param {object[]} [input.observerAttachments] - 仅 observer：Host 侧 durable PNG refs。
   * @param {object} [input.capability] - 只读能力三态投影，供 commit 响应复用。
   * @returns {{id: string, fingerprint: string}} claim id（可回传）与内部摘要（不回传）。
   */
  function issueRouteClaim({ sessionId, route, target, rootToken, observerAttachments, capability }) {
    const now = Date.now();
    pruneRouteClaims(now);
    const id = randomUUID();
    const fingerprint = routeFingerprint(route);
    routeClaims.set(id, {
      sessionId,
      fingerprint,
      rootToken,
      target,
      state: "issued",
      ...(Array.isArray(observerAttachments) ? { observerAttachments: observerAttachments.slice() } : {}),
      ...(capability === void 0 ? {} : { capability }),
      expiresAt: now + ROUTE_CLAIM_TTL_MS,
    });
    return { id, fingerprint };
  }

  /**
   * 校验（可选消费）一个 route claim 是否仍与当前待生效路由一致。
   *
   * 结构化校验：claim 必须是字符串、长度有界、必须查到记录、必须属于同一 root session、
   * 必须是同一 exact root generation（同 id 重建/替换后旧 claim 立即失效）、且当前
   * effective route 摘要必须与签发时完全相同。任何一项不满足都返回 ok:false ——
   * 绝不把任意字符串当作成功。
   *
   * 消费语义（两阶段 Observer 的关键）：
   * - "always"：成功即删除（commit 与 main 的复用场景）；
   * - "main-only"：只有 target=main 的 claim 成功即删除；observer 的 claim **只验证不消费**，
   *   因为它还要交给 image-route-observer-commit 一次性消费；
   * - "never"：只读复核，不改变 claim 生命周期（Host 自检与 admission 后核对）。
   *
   * @param {{claim?: unknown, sessionId?: string, consume?: "always"|"main-only"|"never"}} input - 校验输入。
   * @returns {{ok: boolean, reason?: "unknown-claim"|"session-mismatch"|"generation-mismatch"|"route-changed", target?: string, entry?: object}} 校验结果。
   */
  function verifyRouteClaim({ claim, sessionId, consume = "never" }) {
    if (typeof claim !== "string" || claim.length === 0 || claim.length > 128) return { ok: false, reason: "unknown-claim" };
    const entry = routeClaims.get(claim);
    if (entry === void 0 || entry.expiresAt <= Date.now()) {
      routeClaims.delete(claim);
      return { ok: false, reason: "unknown-claim" };
    }
    if (entry.sessionId !== sessionId) return { ok: false, reason: "session-mismatch" };
    const parent = agents.get(sessionId);
    if (parent === void 0) return { ok: false, reason: "session-mismatch" };
    if (isEntryGenerationLive(parent, entry) !== true) {
      // 同一 sessionId 的 root 已被重建/替换/销毁：旧 claim 一律失效并清理。
      routeClaims.delete(claim);
      return { ok: false, reason: "generation-mismatch" };
    }
    const current = routeFingerprint(resolveMainImageRoute(parent));
    const changed = current !== entry.fingerprint;
    // 摘要相等即视为未变化；两边都为空表示"签发时与现在都无法确定路由"，此时
    // unknown → main-first 语义仍然一致，同样允许校验通过（不能因为无法确定就把
    // 每一次图片提交都判失败）。路由已变化时无论消费策略如何都保持 claim 可诊断：
    // 调用方（validate/commit）会显式删除它。
    if (changed === false && (consume === "always" || (consume === "main-only" && entry.target === "main"))) {
      routeClaims.delete(claim);
    }
    return changed ? { ok: false, reason: "route-changed", target: entry.target } : { ok: true, target: entry.target, entry };
  }

  /** route claim 失败的结构化错误：非 validation，避免被映射为 400 客户端输入错误。 */
  function routeClaimError(reason) {
    const messages = {
      "route-changed": "模型路由在图片提交期间发生变化，已放弃本次提交；请重新发送图片",
      "route-commit-in-progress": "该图片提交正在处理中，请勿重复提交",
    };
    const error = new Error(messages[reason] ?? "图片路由声明无效或已过期，请重新发送图片");
    error.code = reason === "route-changed" || reason === "route-commit-in-progress" ? reason : "route-claim-invalid";
    return error;
  }

  /**
   * 尽力清理已创建的 Observer child（admission 已接受但 commit 后续检测失败/取消时）。
   *
   * 只用现有公开 `subagents.interrupt(childId, { kind: "ancestor", agent: parent })` 契约：
   * 清理失败不能掩盖原始错误，也不重试；不记录 child id。
   * @param {unknown} childId - 已接受的 child id（非字符串时直接返回）。
   * @param {object} parent - 该 child 的父代理。
   */
  async function interruptObserverChild(childId, parent) {
    if (typeof childId !== "string" || childId.length === 0) return;
    try {
      if (typeof subagents?.interrupt !== "function") return;
      await subagents.interrupt(childId, { kind: "ancestor", agent: parent });
    } catch {
      // best-effort：孤儿 child 的清理失败不改变本请求的错误结果。
    }
  }

  /**
   * 删除一个 claim（客户端取消、校验失败、响应未交付或一次性消费后的统一回收点）。
   * @param {string} claim - claim id（非字符串时为 no-op）。
   */
  function revokeRouteClaim(claim) {
    if (typeof claim !== "string") return;
    routeClaims.delete(claim);
  }

  /**
   * 把 claim 标记为 committing（一次性语义：同一 claim 不允许并发/重复 commit）。
   * @param {string} claim - claim id。
   * @returns {boolean} 是否确实标记了一个处于 issued 的 claim。
   */
  function markRouteClaimCommitting(claim) {
    const entry = typeof claim === "string" ? routeClaims.get(claim) : void 0;
    if (entry === void 0 || entry.state !== "issued") return false;
    entry.state = "committing";
    return true;
  }

  /** 卸载/释放：清空 claim 表（唯一入口，容器不出模块）。 */
  function clearRouteClaims() {
    routeClaims.clear();
  }

  /** 卸载/释放：清空 cleanup token 表并复位预占计数。 */
  function clearObserverCleanupTokens() {
    observerCleanupTokens.clear();
    pendingCleanupReservations = 0;
  }

  /**
   * 只读计数投影（诊断用）：只含数字，不含 claim/token id、child id、provider 或 model。
   * @returns {{claims: number, cleanupTokens: number, cleanupReservations: number,
   *   claimLimit: number, cleanupTokenLimit: number}} 有界计数。
   */
  function describeImageRouteState() {
    return {
      claims: routeClaims.size,
      cleanupTokens: observerCleanupTokens.size,
      cleanupReservations: pendingCleanupReservations,
      claimLimit: ROUTE_CLAIM_LIMIT,
      cleanupTokenLimit: OBSERVER_CLEANUP_LIMIT,
    };
  }

  return {
    issueRouteClaim,
    verifyRouteClaim,
    routeClaimError,
    revokeRouteClaim,
    markRouteClaimCommitting,
    clearRouteClaims,
    clearObserverCleanupTokens,
    describeImageRouteState,
    reserveObserverCleanupSlot,
    releaseObserverCleanupSlot,
    issueObserverCleanupToken,
    revokeObserverCleanupToken,
    consumeObserverCleanupToken,
    interruptObserverChild,
  };
}
