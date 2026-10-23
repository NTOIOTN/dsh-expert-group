/**
 * 入口 finalize 收口域（R4a · 票据 15）：root 收口的等待/结论/工具/兜底状态机。
 *
 * 覆盖 F1–F5：root 用户等待 guard、root turn 等待工作登记、admission token 诊断、
 * 两阶段收口（waiting 回执 + pending-close 活视图）、收口结论构造与一次性投递、
 * 三个 root-only 工具定义、以及 agent/turn-stopping 兜底等待。
 *
 * ## 组合根保留的职责（铁律 1/2）
 * - 三个 `ctx.effect(() => tools.register(...))` 的注册仍由 index.js 在原注册点执行；
 * - `ctx.on("agent/turn-stopping")` 的注册同样留在 index.js，本模块只返回 handler；
 * - root/child guard 的安装（F6）本轮仍留在 index.js：它包含动态 `agent.ctx.effect` /
 *   `agent.ctx.tools.guard` 注册点，先按铁律保留在原处。
 *
 * ## 状态所有权（唯一 owner 在本模块）
 * `FINALIZE_TOKEN_DIAGNOSTIC_LIMIT` 与 `lastRefusedScopeRelease`（只读投影）。
 * pending-close 批次状态仍挂在自动恢复域的 `rootAdmissionBatches` 上：本模块只经
 * `getAdmissionBatch()` 读取 exact 批次并按原语义原地写它（ticket 17 迁移时改走命令）。
 *
 * @module dsh-expert-group/host/index-finalize
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { diagnosticToken } from "./runtime-diagnostics.js";
import { PRODUCER_SOURCE_KIND } from "./plugin-identity.js";

/**
 * 创建 finalize 收口域能力面（F1–F5）。
 *
 * ## 注入形态（票据 33 · C3 收窄：18 项 → 7 组）
 * 参数按**能力组**组织、每组单一关注点；收窄只改注入形态——F1–F5 五个 installer 读取的
 * 扁平字段名、判定顺序与全部语义逐字不变（域内有一层展开表）。
 *
 * 1. `host`：Host 组合（lineage / handoff）；
 * 2. `rootWait`：**root 等待域的全部读写 seam**——账本 `rootTurnWaits`、卸载闩
 *    `isRootWaitStopping`、用户等待登记 `writeRootUserWait`、投递诊断 `noteRootWaitDelivery`、
 *    人工关闭计数 `noteRootWaitAbandon`、权威后代查询 `snapshotRootTurnDescendants`。
 *    六者同一 owner（root 等待域）、同一关注点（收口时读写等待账本），故合为一组；
 * 3. `identity`：**root 身份与代次**——`isLiveRootAgent`（live 判定）、
 *    `isRootAgentIdentity`（结构身份）、`rootGenerationRegistry`（代次表）。三者共同回答
 *    "这是不是当前活着的那个 root"，缺一不可；
 * 4. `diagnostics`：**诊断日志**——`logger`（宿主 logger）与 `logTurnWaitError`（等待路径
 *    告警，logger 的受控包装）。同一关注点：只输出固定前缀与安全错误名；
 * 5. `admission`：**admission 批次状态**——`markHandoffAdmissionPaused`（暂停完成标记）与
 *    `getAdmissionBatch`（批次只读读取）。两者都只在收口的批次判定里使用；
 * 6. `notification`：**用户可见通知**——投递 `sendSystemToast`、文案 `localizedUserWaitToast`、
 *    标签 `rootNotificationLabel`。同一条通知链路的三个环节，只影响提示；
 * 7. `delegation`：委派跟踪器 `delegationTracker`（scope 诊断工具的活动范围读面）。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx），字段见上。
 * @returns {object} finalize 域能力面。
 */
export function createFinalizeDomain(deps) {
  // 命名空间 → 扁平依赖袋：F1–F5 是同文件内的装配层，字段名与各处注释/日志语义一一对应，
  // 改成嵌套读取只会让 1150 行实现四处变形。收窄只作用于域工厂的注入面（跨模块契约）。
  const flat = {
    host: deps.host.host,
    rootTurnWaits: deps.rootWait.rootTurnWaits, isRootWaitStopping: deps.rootWait.isRootWaitStopping,
    writeRootUserWait: deps.rootWait.writeRootUserWait,
    noteRootWaitDelivery: deps.rootWait.noteRootWaitDelivery, noteRootWaitAbandon: deps.rootWait.noteRootWaitAbandon,
    snapshotRootTurnDescendants: deps.rootWait.snapshotRootTurnDescendants,
    isLiveRootAgent: deps.identity.isLiveRootAgent, isRootAgentIdentity: deps.identity.isRootAgentIdentity,
    rootGenerationRegistry: deps.identity.rootGenerationRegistry,
    logger: deps.diagnostics.logger, logTurnWaitError: deps.diagnostics.logTurnWaitError,
    markHandoffAdmissionPaused: deps.admission.markHandoffAdmissionPaused,
    getAdmissionBatch: deps.admission.getAdmissionBatch,
    sendSystemToast: deps.notification.sendSystemToast,
    localizedUserWaitToast: deps.notification.localizedUserWaitToast,
    rootNotificationLabel: deps.notification.rootNotificationLabel,
    delegationTracker: deps.delegation.delegationTracker,
  };
  const api = {};
  Object.assign(api, installFinalizeWaitWork(flat, api));
  Object.assign(api, installFinalizeBatch(flat, api));
  Object.assign(api, installFinalizePendingClose(flat, api));
  Object.assign(api, installFinalizeTools(flat, api));
  Object.assign(api, installFinalizeTurnStopping(flat, api));
  return api;
}

/**
 * F1：root 用户等待 guard 与等待工作登记。
 *
 * @param {object} deps - 见 `createFinalizeDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} F1 能力面。
 */
function installFinalizeWaitWork(deps, api) {
  const {
    host,
    rootTurnWaits,
    isLiveRootAgent,
    isRootWaitStopping,
    writeRootUserWait,
    markHandoffAdmissionPaused,
    rootGenerationRegistry,
    sendSystemToast,
    localizedUserWaitToast,
    rootNotificationLabel,
  } = deps;
function rootUserWaitGuard(agent, execution) {
  if (execution?.agent !== agent || (execution?.name !== "ask_user_question" && execution?.name !== "exit_plan_mode")) return void 0;
  if (isRootWaitStopping() || !isLiveRootAgent(agent)) return "Cannot start user wait because the exact root Agent is no longer live.";
  // 统一登记点：root 用户等待只有这一处写入，因此通知也接在这里，避免出现第二份登记。
  const previousWait = writeRootUserWait(agent, {
    agent,
    session: agent.session,
    generation: rootGenerationRegistry.generationOf(agent.id),
    tool: execution.name,
  });
  // 同一次等待里重复进入 guard（重试/重复调用）不重复提示；等待被清理后再次登记才再提示一次。
  if (previousWait === void 0 || previousWait.tool !== execution.name) {
    sendSystemToast(localizedUserWaitToast(execution.name, rootNotificationLabel(agent.session)), "waiting");
  }
  return void 0;
}

/**
 * 把一批已 settle 的 accepted admission 登记进唯一的 root turn 等待登记表。
 *
 * 判定必须与 finalize 的 acceptedEntries 完全一致：reused / continue_parent_turn
 * 的 admission 不产生"未结算工作"，但它们**仍然可能留下正在运行的子代理**
 * （continue_parent_turn 的 child 就是典型的后台运行），因此这里对它们只做
 * `engage`（保证该 root 已进入等待体系，让 turn-stopping 兜底参与判定），
 * 不登记工作项。
 *
 * @param {object} parent - exact root Agent。
 * @param {object[]} entries - 开放批次里的 accepted admission entry。
 * @returns {{tracked:number, engaged:number, invalid:number}} 登记统计。
 */
function registerRootTurnWaitWork(parent, entries) {
  let tracked = 0;
  let engaged = 0;
  let invalid = 0;
  for (const entry of entries) {
    const outcome = entry?.outcome;
    if (outcome?.kind !== "continuable") continue;
    if (outcome.reused === true || outcome.continueParentTurn === true) {
      if (rootTurnWaits.engage(parent)) engaged += 1;
      continue;
    }
    const admission = outcome.handoffAdmission;
    // admission 已失效（被其他路径释放/清理）：没有可结算的工作，也不登记——
    // 登记一个永远不会结算的键会让 root 永久等待。
    if (admission === void 0 || host.handoff.contains(admission) !== true || admission.parent !== parent) {
      invalid += 1;
      continue;
    }
    const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
    if (token === void 0) {
      invalid += 1;
      continue;
    }
    if (rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0) {
      // 等待登记成功即「该 admission 的等待屏障已建立」——这正是 cohort 的 pauseDone
      // 在旧实现里表达的语义（字段名来自 goal pause 时代，这里保留以免扩大改动面）。
      markHandoffAdmissionPaused(admission);
      tracked += 1;
    }
  }
  return { tracked, engaged, invalid };
}

/** tokenDiagnostics 有界数组的上限：超出部分只计数，避免诊断本身变成泄漏面。 */
  return { rootUserWaitGuard, registerRootTurnWaitWork };
}

/**
 * F2：admission token 诊断与两阶段收口（waiting 回执 + pending-close 标记）。
 *
 * @param {object} deps - 见 `createFinalizeDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} F2 能力面。
 */
function installFinalizeBatch(deps, api) {
  const { host, logger, isLiveRootAgent, getAdmissionBatch } = deps;
  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const registerRootTurnWaitWork = (...args) => api.registerRootTurnWaitWork(...args);
  const pendingCloseAcceptedCount = (...args) => api.pendingCloseAcceptedCount(...args);
const FINALIZE_TOKEN_DIAGNOSTIC_LIMIT = 32;

/**
 * 把调用方传入的（可选）admissionTokens 与批次的有效 admission 集合做**纯诊断**核对。
 *
 * 不变量：本函数只产出诊断，绝不改变收口集合，也绝不参与放行/拒绝判定。
 * - 缺失（expected 里有、调用方没传）只记录到 missing，不阻塞收口；
 * - 未知 token（含从未交付给调用方的 discarded ticket 对应的凭据）与重复条目只记录到
 *   有界数组并计数，一律忽略；
 * - 非字符串条目计入 invalid，不改变有效集合；
 * - 有界数组去重且最多 FINALIZE_TOKEN_DIAGNOSTIC_LIMIT 条，其余只通过 ignored 计数；
 *   诊断里绝不含 prompt / 任务正文，只有 token 字符串本身。
 *
 * @param {string[]} expectedTokens - 服务端枚举的有效 admission token（批次内唯一）。
 * @param {unknown} rawTokens - 调用方传入的 admissionTokens（可缺省、可为任意形状）。
 * @returns {{provided:number, expected:number, missing:string[], unknown:string[],
 *   duplicates:string[], invalid:number, ignored:number}} 诊断快照。其中 provided 是
 *   调用方传入的原始条目数（含重复与非字符串），ignored 是不影响收口集合的条目数。
 */
function finalizeTokenDiagnostics(expectedTokens, rawTokens) {
  const supplied = Array.isArray(rawTokens)
    ? rawTokens
    : rawTokens === void 0 || rawTokens === null ? [] : [rawTokens];
  const expectedSet = new Set(expectedTokens);
  const provided = [];
  let invalid = 0;
  for (const item of supplied) {
    if (typeof item === "string") provided.push(item);
    else invalid += 1;
  }
  const seen = new Set();
  const seenDuplicates = new Set();
  const unknown = [];
  const duplicates = [];
  let ignored = invalid;
  for (const token of provided) {
    if (seen.has(token)) {
      ignored += 1;
      if (!seenDuplicates.has(token) && duplicates.length < FINALIZE_TOKEN_DIAGNOSTIC_LIMIT) {
        seenDuplicates.add(token);
        duplicates.push(token);
      }
      continue;
    }
    seen.add(token);
    if (!expectedSet.has(token)) {
      ignored += 1;
      if (unknown.length < FINALIZE_TOKEN_DIAGNOSTIC_LIMIT) unknown.push(token);
    }
  }
  const missing = [];
  for (const token of expectedTokens) {
    if (!seen.has(token) && missing.length < FINALIZE_TOKEN_DIAGNOSTIC_LIMIT) missing.push(token);
  }
  return {
    provided: supplied.length,
    expected: expectedTokens.length,
    missing,
    unknown,
    duplicates,
    invalid,
    ignored,
  };
}

/**
 * root-only 显式收口：按「当前 root/run + admissionEpoch」定位整批工作，登记服务端
 * 枚举出的已接受 admission，然后**立即**返回非终态 waiting 回执（两阶段语义）。
 *
 * 1. 批次定位键只有「当前 root 的开放批次 + admissionEpoch」：服务端自己枚举该 epoch
 *    下**全部有效** admission（过滤 discarded），调用方不需要、也不应该枚举 token；
 *    `admissionTokens` 只是可选诊断参数（缺失/多余/重复/未知/非字符串都不阻塞收口，
 *    只通过 tokenDiagnostics 回报）；保留 outcome 已 settle、safeParallelWork、
 *    continue_parent_turn、accepted handoff、root generation 等真实前提校验；
 * 2. 把每个 accepted admission **一次性**登记进唯一的 root turn 等待登记表，并把批次
 *    标为 pending-close（保存 exact admission 凭据）；
 * 3. **立即**返回 `{kind:"waiting", admissionEpoch, acceptedCount, reason:"experts-running",
 *    tokenDiagnostics}`（tokenDiagnostics 只是可选诊断，不影响收口集合）。
 *    工具调用绝不在 run_code 内等待专家结束，也绝不使用 `exec.signal` 等待——PTC 的
 *    600000ms 墙钟因此不再能截断收口；
 * 4. 继续等待由 root turn 的 `agent/turn-stopping` serial 边界承担（见
 *    awaitRootTurnWaitFallback）：它用**本次 root turn 的 signal** 等待同一张账本，
 *    释放条件仍是 host/turn-wait.js 的 fail-closed 静止判定（无未结算工作 + root-scoped
 *    查询明确无 running 后代；unknown / 查询失败一律继续等待，**不设任何超时**）；
 * 5. 等待明确释放后，插件以同步 `Agent.steer` 向同一 run 的下一 step 投递**一次**
 *    DEG 来源的终态结论，然后一次性关闭批次。
 *
 * 与旧实现的关键差异：
 * - **不再在工具调用内等待**：waiting 是非终态回执，终态结论通过后续模型 step 交付；
 * - **不再调用 exec.concludeTurn()**：turn 由宿主在工具返回后自然关闭；
 * - **不再暂停/恢复任何 goal**：不再有 paused/concluded 之类的回执字段；
 * - 相同批次的重复合法 finalize 返回**稳定** waiting（不重复登记、不关闭、不投递）；
 *   回执里的 acceptedCount 报告该批次当前的完整 accepted 集（含 pending-close 期间
 *   新接受的 admission）。
 */
async function finalizeRootAdmissionBatch(parent, exec, args, rootToken) {
  const rawEpoch = args?.admissionEpoch;
  const epoch = Number.isSafeInteger(rawEpoch) ? rawEpoch : 0;
  const base = {
    admissionEpoch: epoch,
    acceptedCount: 0,
  };
  // 拒绝回执的统一构造：reason 是稳定机器码（契约与测试按它断言），message 是
  // 「当前真实状态 + 下一步动作」的可执行提示，渲染文本必须同时带出两者。
  // tokenDiagnostics 只属于 waiting（诊断与拒绝原因无关），拒绝路径不携带。
  const reject = (reason, message, extra) => ({
    kind: "rejected",
    ...base,
    ...(extra === void 0 ? {} : extra),
    reason,
    message,
  });
  if (args?.summaryCompleted !== true || args?.outcomesChecked !== true) {
    return reject("summary-or-outcome-check-required",
      "finalize 之前必须先在 root 回复里写出总结并检查每个 role 结果；请把 summaryCompleted 与 outcomesChecked 都设为 true 后重试。");
  }
  if (args?.safeParallelWork === true) {
    return reject("safe-parallel-work-remains",
      "仍有安全的非重叠并行工作可以派发；请先派发它们，确认没有安全并行工作后再调用 finalize。");
  }
  if (!Number.isSafeInteger(rawEpoch)) {
    return reject("invalid-admission-epoch",
      "admissionEpoch 必须是 role 工具回执里的整数；请传入该值重试（没有调用任何 role 工具时用 0）。");
  }
  const batch = getAdmissionBatch(parent);
  if (batch === void 0) {
    // 没有开放批次且 epoch 为 0：本 turn 没有真实 admission，保持既有幂等 no-admission。
    // admissionTokens 只是诊断，传多传少都不改变这个结论。
    if (epoch === 0) return { kind: "noop", ...base, reason: "no-admission" };
    return reject("no-admission-batch",
      "该 root 当前没有开放的 admission 批次（admissionEpoch " + epoch + " 不存在）；请先调用 role 工具取得 admissionEpoch，或在不传 tokens 时用 epoch 0 收口。");
  }
  // 已关闭批次上的「无 admission」调用（epoch 0）是幂等 no-admission，不是 stale：
  // 模型在没有调用任何 role 工具时被要求用这个凭据收口，重复调用必须与首次调用（没有
  // 开放批次时的 no-admission）得到同一个结论。这个判定必须早于 epoch 比较——0 永远
  // 不等于任何真实 epoch，放在后面会被 stale 分支抢先。**非零** epoch 仍按
  // stale-admission-epoch 拒绝（那是真的过期凭据）。
  if (batch.closed === true && epoch === 0) {
    return { kind: "noop", ...base, reason: "no-admission" };
  }
  if (batch.epoch !== epoch) {
    return reject(
      batch.closed ? "stale-admission-epoch" : "admission-epoch-mismatch",
      batch.closed
        ? "admissionEpoch " + epoch + " 已经收口关闭；不要重复 finalize，若之后新建了 admission，请用新回执里的 admissionEpoch 重试。"
        : "当前打开的 admissionEpoch 是 " + batch.epoch + "；请用该值重试。",
    );
  }
  if (batch.closed === true) return { kind: "noop", ...base, reason: "already-finalized" };
  if (batch.finalizing === true) {
    return reject("finalization-in-progress",
      "同一批次正在收口；不要并发调用 finalize，等本次调用返回 waiting 即可。");
  }
  // 收口集合 = 服务端枚举的**整批有效** admission（唯一判定来源）。被
  // discardRootAdmission 丢弃的 ticket 从未把凭据交给调用方（未知/越权 childId 的
  // 拒绝路径），既不在集合里，也不参与诊断的 expected。调用方传不传 admissionTokens、
  // 传了什么都**不改变**这个集合——token 只是可选诊断。
  const expectedEntries = [...batch.entries.entries()]
    .filter(([, entry]) => entry?.discarded !== true);
  const expectedTokens = expectedEntries.map(([token]) => token);
  const tokenDiagnostics = finalizeTokenDiagnostics(expectedTokens, args?.admissionTokens);
  const entries = expectedEntries.map(([, entry]) => entry);
  const pendingEntries = entries.filter((entry) => entry?.settled !== true || entry.outcome === void 0);
  if (pendingEntries.length > 0) {
    return reject("admission-outcome-pending",
      "epoch " + batch.epoch + " 仍有 " + pendingEntries.length + " 个 admission 没有返回结果；请等这些 role 工具返回后再调用 finalize。");
  }
  // continue_parent_turn 的 admission 仍在有效集合里，但它本身没有 handoff。若同一
  // 开放批次后续已没有安全并行工作，仍应只收口普通 accepted admission；只有纯 continue
  // 批次才拒绝 finalize，避免安全并行任务把批次永久锁死。
  const acceptedEntries = entries.filter((entry) => entry.outcome?.kind === "continuable"
    && entry.outcome.reused !== true && entry.outcome.continueParentTurn !== true);
  if (acceptedEntries.length === 0 && entries.some((entry) => entry.outcome?.continueParentTurn === true)) {
    return reject("continue-parent-turn",
      "本批次只有 continue_parent_turn 的 admission，没有可收口的已接受工作；不需要调用 finalize，继续这些安全并行工作即可。");
  }
  if (acceptedEntries.some((entry) => entry.outcome.handoffAdmission === void 0)) {
    return reject("accepted-handoff-missing",
      "有已接受的 admission 缺少 handoffAdmission；请等该 role 工具返回完整结果（含 handoff）后再调用 finalize。");
  }
  if (acceptedEntries.length === 0) {
    batch.closed = true;
    return { kind: "noop", ...base, reason: "no-accepted-admission" };
  }
  // 同一批次的重复**合法** finalize 必须得到稳定的 waiting：既不重复登记 work，也不
  // 重复关闭或投递。这项判定放在全部校验之后，因此错误/陈旧凭据仍会按上面的分支立即
  // rejected；诊断按批次**当前**有效集合现算（pending-close 期间的新 admission 会被计入）。
  if (batch.pendingClose !== void 0) {
    return {
      kind: "waiting",
      ...base,
      // 批次仍开放时可能有 pending-close 期间新接受的 admission；回执报告批次当前的
      // 完整 accepted 集（初始那次回执是已返回的快照，不追写）。
      acceptedCount: pendingCloseAcceptedCount(parent),
      reason: "experts-running",
      tokenDiagnostics,
    };
  }
  // 两阶段收口：① 登记等待工作并标记 pending-close（同步、无任何 await）；
  // ② 立即返回非终态 waiting。登记必须在返回前完成，否则「登记前到达的 child 完成
  // 通知」会找不到工作项而变成空操作；而工具调用本身绝不等待。
  batch.finalizing = true;
  try {
    if (!host.lineage.isLiveGeneration(parent, rootToken)) {
      batch.closed = true;
      return reject("root-generation-retired",
        "root 代际已退休，本次收口不会登记也不会投递；不要重试，由当前 root 重新开始。",
        { acceptedCount: acceptedEntries.length });
    }
    registerRootTurnWaitWork(parent, acceptedEntries);
    // pending-close 保存 exact admission 对象：等待账本的记录会在一次静止收口后被
    // 销毁（此时 isEngaged() 为 false），后续 turn-stopping 只能靠这份凭据重新登记
    // 尚未结算的 work —— 它绝不重新登记已结算项（登记键会永远等不到结算）。
    //
    // 这里**不**缓存 acceptedCount：批次在收口前始终开放（pending-close 期间新接受的
    // admission 会被原地追加进 admissions），任何数量都必须在使用点现算（见
    // pendingCloseAcceptedCount），否则旧快照会漏掉新工作。
    batch.pendingClose = {
      admissionEpoch: epoch,
      admissions: acceptedEntries.map((entry) => entry.outcome.handoffAdmission),
    };
    return {
      kind: "waiting",
      ...base,
      acceptedCount: acceptedEntries.length,
      reason: "experts-running",
      tokenDiagnostics,
    };
  } finally {
    batch.finalizing = false;
  }
}

  return { finalizeTokenDiagnostics, finalizeRootAdmissionBatch, FINALIZE_TOKEN_DIAGNOSTIC_LIMIT };
}

/**
 * F3：pending-close 活视图、收口结论构造与一次性投递。
 *
 * @param {object} deps - 见 `createFinalizeDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} F3 能力面。
 */
function installFinalizePendingClose(deps, api) {
  const { host, logger, rootTurnWaits, isLiveRootAgent, markHandoffAdmissionPaused, noteRootWaitDelivery, getAdmissionBatch } = deps;
/**
 * 取 pending-close 批次的**同步快照**（未关闭、且确实登记过收口）。
 *
 * 只返回已保存的状态对象本身：它由 finalize 一次性写入，之后只能**原地**追加
 * pending-close 期间新接受的 exact admission（见 notePendingCloseAdmission），绝不
 * 重建或拷贝——拷贝会让投递前的身份校验失去意义。
 *
 * @returns {object|undefined} pending-close 状态；无待收口批次时为 undefined。
 */
function pendingCloseBatchFor(parent) {
  const batch = getAdmissionBatch(parent);
  if (batch === void 0 || batch.closed === true || batch.pendingClose === void 0) return void 0;
  return batch.pendingClose;
}

/**
 * 取开放批次里**当前**已接受的 exact 工作（活视图，不是冻结快照）。
 *
 * why 必须是活视图：pending-close 是**批次级** latch，批次在收口前始终开放——用户插话
 * 后的后续 root turn 仍会通过 beginRootAdmission 把新的 role admission 加进**同一个**
 * epoch。冻结在 finalize 时刻的 admission 列表会漏掉这些新工作：重新等待会少等一项，
 * 收口结论的 acceptedCount 也会停在旧值。
 *
 * 判定与 finalizeRootAdmissionBatch 的 acceptedEntries 完全一致：reused /
 * continueParentTurn 不产生「未结算工作」（它们留下的运行中 child 由 root-scoped
 * 后代查询负责挡住）。
 *
 * @param {object} parent - exact root Agent。
 * @returns {{token:string, admission:object, released:boolean}[]} 已接受工作；
 *   `released` 为 true 表示该 admission 已离开 host.handoff（已结算 / 已释放）。
 */
function acceptedBatchWorks(parent) {
  const batch = getAdmissionBatch(parent);
  if (batch === void 0) return [];
  const works = [];
  for (const entry of batch.entries.values()) {
    const outcome = entry?.outcome;
    if (entry?.settled !== true || outcome === void 0) continue;
    if (outcome.kind !== "continuable" || outcome.reused === true || outcome.continueParentTurn === true) continue;
    const admission = outcome.handoffAdmission;
    if (admission === void 0 || admission.parent !== parent) continue;
    const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
    if (token === void 0) continue;
    works.push({ token, admission, released: host.handoff.contains(admission) !== true });
  }
  return works;
}

/**
 * 批次当前**完整 accepted 集**的规模。
 *
 * 收口结论与重复的 waiting 回执都用它现算：pending-close 期间新接受的 admission 也是
 * 这个批次的一部分，回放 finalize 时刻的旧快照会让模型看到与实际收口集合不符的数量。
 * 初始那次 waiting 回执是已返回的快照，不做追写。
 */
function pendingCloseAcceptedCount(parent) {
  return acceptedBatchWorks(parent).length;
}

/**
 * 把 pending-close 期间**新接受**的 role admission 立即归入同一次收口的 exact work 集。
 *
 * why 需要这个写入口：该批次的收口等待可能正在飞（被打断的 turn 之后，模型在新 step
 * 里又拉起一个专家）。只依赖 turn-stopping 起点的一次性重新登记时，这段等待里新接受
 * 的工作就不在等待账本上，静止判定只剩「查不到 running 后代」这条启发式依据——一旦新
 * child 恰好不在 running 列表里（例如它已经结束 turn、精确结算尚未到达），批次就会在
 * exact work 未释放时提前收口并投递终态结论。
 *
 * 登记键必须与精确结算用的键完全一致（admission 自己的 token）；已经离开 host.handoff
 * 的凭据绝不登记，否则会留下一个永远等不到结算的键，让 root 永久悬挂。
 *
 * @param {object} parent - exact root Agent。
 * @param {object} admission - 新接受的 exact handoff admission。
 * @returns {boolean} 是否成功进入等待账本（诊断用；判定不依赖它）。
 */
function notePendingCloseAdmission(parent, admission) {
  const pendingClose = pendingCloseBatchFor(parent);
  if (pendingClose === void 0 || admission === void 0 || admission.parent !== parent) return false;
  if (host.handoff.contains(admission) !== true) return false;
  const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
  if (token === void 0) return false;
  // 归入 exact work 集：只把同一个 exact admission 对象追加进快照数组，绝不重建该对象
  // ——deliverRootFinalizationConclusion 依赖 pendingClose 的对象身份做重复投递复查。
  if (!pendingClose.admissions.includes(admission)) pendingClose.admissions.push(admission);
  const tracked = rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0;
  // 与 finalize / turn-stopping 的登记路径一致：登记成功即「等待屏障已建立」，
  // cohort 才会把该 admission 判定为可精确结算。
  if (tracked) markHandoffAdmissionPaused(admission);
  return tracked;
}

/**
 * 依据 pending-close 保存的 exact admission 信息**以及开放批次当前的已接受工作活视图**，
 * 重新登记**尚未结算**的 work 并把该 root engage 进同一张等待账本。
 *
 * 为什么必须能「重新登记」：等待账本的一条记录在一次静止收口后立即销毁，此后
 * `track`/`settle` 都找不到它，`isEngaged()` 也为 false。若只依赖账本现状，
 * pending-close 批次就会在「child 先静止、turn-stopping 后到」的合法时序里既收不了口、
 * 也投递不了结论（登记键必须与精确结算用的键完全一致，因此这里用 admission 自己的
 * token，而不是 batch/ticket token）。
 *
 * 只登记仍在 handoff 里的 admission：已结算/已释放的凭据再登记会得到一个永远等不到
 * 结算的键，让 root 永久悬挂（fail-closed 的另一面）。
 *
 * @returns {number} 本次成功登记的 work 数（诊断用；判定不依赖它）。
 */
function reengagePendingCloseWorks(parent, pendingClose) {
  // 并集：① finalize 快照里保存的 exact admission；② 开放批次当前的已接受工作活视图
  // （含 pending-close 期间新接受的 admission——它们必须被本次等待一并覆盖）。
  const candidates = [
    ...pendingClose.admissions,
    ...acceptedBatchWorks(parent).map((work) => work.admission),
  ];
  const seen = new Set();
  let tracked = 0;
  for (const admission of candidates) {
    if (admission === void 0 || admission.parent !== parent) continue;
    if (host.handoff.contains(admission) !== true) continue;
    const token = typeof admission.token === "string" && admission.token.length > 0 ? admission.token : void 0;
    if (token === void 0 || seen.has(token)) continue;
    seen.add(token);
    if (rootTurnWaits.track(parent, { kind: "admission", token }) !== void 0) {
      markHandoffAdmissionPaused(admission);
      tracked += 1;
    }
  }
  // 即使没有可登记的工作（reused/continue 批次或已全部结算），也必须 engage：静止
  // 判定要由同一状态机给出**明确**结论，而不是「从未参与」这种无法证明的默认。
  rootTurnWaits.engage(parent);
  return tracked;
}

/**
 * 构造一次收口结论的模型可见正文。
 *
 * 只表达「收口已完成 + admissionEpoch + acceptedCount」这三项**插件自己拥有**的事实：
 * 专家的具体结果由 DSH 的结算通知各自提供，插件消息不复制、不改写任何专家收尾文本，
 * 也刻意不与 Host 自动完成通知的固定前缀同形（避免被当作 child settlement）。
 */
function rootFinalizationConclusionText(admissionEpoch, acceptedCount) {
  return "Expert group finalization: the expert batch you finalized is finalized"
    + " (admissionEpoch " + admissionEpoch
    + ", acceptedCount " + acceptedCount + ")."
    + " Every expert task accepted in that batch has actually finished;"
    + " each expert's own closing output arrived separately as a subagent settlement message,"
    + " which this notice deliberately does not repeat."
    + " Do not call dsh_expert_group_finalize again for this batch and do not poll for status;"
    + " continue the task from here.";
}

/**
 * 一次性投递某批次的终态收口结论，并关闭该批次。
 *
 * 前置条件（缺一不可，全部在**同一同步临界区**内复查）：
 * 1. 该 exact 批次仍是同一个、仍未关闭、且 pendingClose 仍是本次持有的那个对象
 *    （重复 turn-stopping / 竞态下不会二次投递）；
 * 2. 本次 waiter 的 signal 未被取消（取消不是专家完成）；
 * 3. exact root Agent 仍是当前 live root，且 generation token 仍 live（root 退休、
 *    代际替换或插件卸载期间绝不由旧 root 投递）；
 * 4. runtime 提供 rc.2 的公开 `Agent.steer`。**不**降级为 `inject`：inject 不保证
 *    唤醒后续模型 step，静默降级会让模型永远收不到收口结论；此处保留 pending-close，
 *    留给具备该能力的 runtime 或后续 turn（只记一次告警，不刷日志）。
 *
 * @returns {boolean} 是否完成投递并关闭。
 */
function deliverRootFinalizationConclusion(parent, pendingClose, signal) {
  const batch = getAdmissionBatch(parent);
  if (batch === void 0 || batch.closed === true || batch.pendingClose !== pendingClose) return false;
  if (signal?.aborted === true) return false;
  if (!isLiveRootAgent(parent)) return false;
  const rootToken = host.lineage.tokenFor(parent);
  if (!host.lineage.isLiveGeneration(parent, rootToken)) return false;
  if (typeof parent?.steer !== "function") {
    if (batch.steerUnavailableLogged !== true) {
      batch.steerUnavailableLogged = true;
      logger.warn("dsh-expert-group: root Agent.steer is unavailable; the finalization conclusion was not delivered");
    }
    // 票据 11：这是真实的投递失败（runtime 缺公开 steer），必须可观测；
    // 批次保持 pending-close，等待后续具备该能力的 turn/runtime 重试。
    noteRootWaitDelivery(parent, false, "steer-unavailable");
    return false;
  }
  // 收口时刻的完整 accepted 集：pending-close 期间新接受的 admission 也在其中，
  // 因此这里必须**现算**，而不是回放 finalize 时的快照值。判定与身份复查处于同一
  // 同步临界区，结论里的数量与真正被释放的 exact work 集一致。
  const acceptedCount = pendingCloseAcceptedCount(parent);
  let message;
  try {
    message = createUserMessage({
      content: [{ type: "text", text: rootFinalizationConclusionText(pendingClose.admissionEpoch, acceptedCount) }],
      source: { kind: PRODUCER_SOURCE_KIND },
    });
  } catch (error) {
    logger.warn("dsh-expert-group: root finalization message construction failed: "
      + (error instanceof Error ? error.name : "Error"));
    noteRootWaitDelivery(parent, false, "message-construction-failed");
    return false;
  }
  try {
    parent.steer(message);
  } catch (error) {
    // 投递失败保持 pending-close：结论还没有进入模型上下文，批次不能算收口完成。
    logger.warn("dsh-expert-group: root finalization steer failed: "
      + (error instanceof Error ? error.name : "Error"));
    noteRootWaitDelivery(parent, false, "steer-failed");
    return false;
  }
  batch.closed = true;
  batch.pendingClose = void 0;
  noteRootWaitDelivery(parent, true, "delivered");
  return true;
}



  return {
    pendingCloseBatchFor,
    acceptedBatchWorks,
    pendingCloseAcceptedCount,
    notePendingCloseAdmission,
    reengagePendingCloseWorks,
    rootFinalizationConclusionText,
    deliverRootFinalizationConclusion,
  };
}

/**
 * F4：三个 root-only 工具定义（注册仍由 index.js 的原注册点执行）。
 *
 * @param {object} deps - 见 `createFinalizeDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} F4 能力面。
 */
function installFinalizeTools(deps, api) {
  const {
    host,
    logger,
    rootTurnWaits,
    delegationTracker,
    isLiveRootAgent,
    getAdmissionBatch,
    snapshotRootTurnDescendants,
    logTurnWaitError,
    noteRootWaitAbandon,
  } = deps;
  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const finalizeRootAdmissionBatch = (...args) => api.finalizeRootAdmissionBatch(...args);
const finalizeTool = defineTool({
  name: "dsh_expert_group_finalize",
  description: "Finalize the current root turn only after every result of the current admission batch has returned, the root summary and integration/review/verification check is done, and no safe non-overlapping parallel work remains. The batch is located by the current root/run plus admissionEpoch alone: the server enumerates the complete effective admission set, so admissionTokens is an optional diagnostic argument and missing, extra, duplicate, unknown, discarded, or non-string tokens never block finalization (they are only reported in tokenDiagnostics). This root-only action registers every accepted expert task on the root turn wait ledger and returns immediately with a non-terminal waiting receipt carrying admissionEpoch, acceptedCount, and tokenDiagnostics: it never waits inside the tool call, because the root turn lifecycle keeps waiting at the agent/turn-stopping boundary on that same ledger, with no timeout. A waiting receipt means the wait is registered, not that any expert finished; it is not an asynchronous task handle and there is no status to poll. After that receipt, do not call finalize again for that batch and do not poll for status: once every accepted task has actually finished, the plugin closes the batch and steers one DEG-sourced finalization message into your next step automatically. Do not call it while safe parallel work remains; a pure continue_parent_turn batch has no accepted admission to finalize. Every rejected receipt carries a stable reason code and an actionable message.",
  parameters: {
    admissionEpoch: {
      type: "number",
      required: true,
      description: "The admissionEpoch returned by the role tools for the batch being checked; it is the only batch location key. Use 0 when no role tool was called.",
    },
    admissionTokens: {
      type: "array",
      items: { type: "json" },
      description: "Optional diagnostic list of admissionToken values from role-tool receipts. It never changes the finalized batch: missing, extra, duplicate, unknown, discarded, or non-string entries are ignored for finalization and only reported back in tokenDiagnostics. Omit it in normal use.",
    },
    summaryCompleted: {
      type: "boolean",
      required: true,
      description: "Set true only after stating the accepted tasks and planned integration, review, and verification work in the root response.",
    },
    outcomesChecked: {
      type: "boolean",
      required: true,
      description: "Set true only after checking every listed role outcome, including rejected, advisory, and failure results.",
    },
    safeParallelWork: {
      type: "boolean",
      required: true,
      description: "Set true when any safe, non-overlapping, non-duplicate parallel work remains; finalize rejects that value.",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // waiting 是登记完成但非终态；收口结论只通过后续 root 上下文消息表达。
        kind: { type: "string", required: true, enum: ["waiting", "noop", "rejected"] },
        admissionEpoch: { type: "number", required: true },
        acceptedCount: { type: "number", required: true },
        reason: { type: "string", required: true },
        message: { type: "string" },
        /**
         * 可选诊断字段（票据 10）：只有 waiting 回执携带，其余 kind 省略。
         * unknown / duplicates / missing 是有界字符串数组（去重、最多 32 条），其余
         * 只通过计数表达；它们只描述调用方凭据与批次有效集合的差异，绝不改变收口集合，
         * 也不含 prompt / 任务正文。
         */
        tokenDiagnostics: {
          type: "object",
          additionalProperties: false,
          properties: {
            provided: { type: "number", required: true },
            expected: { type: "number", required: true },
            missing: { type: "array", required: true, items: { type: "string" } },
            unknown: { type: "array", required: true, items: { type: "string" } },
            duplicates: { type: "array", required: true, items: { type: "string" } },
            invalid: { type: "number", required: true },
            ignored: { type: "number", required: true },
          },
        },
      },
    },
    render(_args, value) {
      // render 必须带上 message，否则 rejected 的 self-diagnosis 文案在模型可见的
      // 工具输出里被丢弃（reason 是机器码，message 才是可执行提示）。
      const base = "root finalization: " + value.reason + (value.message ? " — " + value.message : "");
      // waiting 是非终态回执：模型必须看到「等待已登记、不要重试、不要轮询」，
      // 否则会把 waiting 误当成最终结论，或者反复调用 finalize。
      if (value.kind === "waiting") {
        const diagnostics = value.tokenDiagnostics;
        // 诊断只回显计数与有界数组长度：渲染文本不展开 token 明细，避免把内部凭据
        // 刷进模型上下文；需要具体条目时读回执 JSON（票据 22：渲染文案保持最短）。
        const summary = diagnostics === void 0 ? ""
          : " — tokens " + diagnostics.provided + "/" + diagnostics.expected
            + " (missing " + diagnostics.missing.length
            + ", unknown " + diagnostics.unknown.length
            + ", duplicates " + diagnostics.duplicates.length
            + ", invalid " + diagnostics.invalid
            + ", ignored " + diagnostics.ignored + ")";
        return [{ type: "text", text: base
          + " — waiting registered for " + value.acceptedCount + " accepted expert task(s) in admissionEpoch "
          + value.admissionEpoch + summary
          + "; do not call finalize again and do not poll for status" }];
      }
      return [{ type: "text", text: base }];
    },
  },
  isConcurrencySafe: () => false,
  execute(args, exec) {
    const parent = exec?.agent;
    const epoch = Number.isSafeInteger(args?.admissionEpoch) ? args.admissionEpoch : 0;
    // root-only / 代际边界不再抛异常：调用方必须拿到结构化的 rejected 回执（稳定
    // reason + 可执行 message），否则只能看到一条异常文本，无法按 reason 恢复。
    if (!isLiveRootAgent(parent)) {
      return {
        kind: "rejected",
        admissionEpoch: epoch,
        acceptedCount: 0,
        reason: "root-only",
        message: "dsh_expert_group_finalize 只能由当前 live root agent 调用；专家子代理不要收口，直接返回自己的结果。",
      };
    }
    const rootToken = host.lineage.tokenFor(parent);
    if (!host.lineage.isLiveGeneration(parent, rootToken)) {
      return {
        kind: "rejected",
        admissionEpoch: epoch,
        acceptedCount: 0,
        reason: "root-generation-retired",
        message: "root 代际已退休，本次收口不会登记也不会投递；不要重试，由当前 root 重新开始。",
      };
    }
    return finalizeRootAdmissionBatch(parent, exec, args, rootToken);
  },
});

/**
 * 最近一次 release_scope 拒绝释放的只读摘要（诊断用）：
 * 只有时间戳、活动条数与固定原因码，不含 child/agent id 或任务正文。
 * @type {{at:number, activeCount:number, reason:string}|null}
 */
let lastRefusedScopeRelease = null;

const scopeDiagnosisTool = defineTool({
  name: "dsh_expert_group_release_scope",
  description: "Read-only diagnosis of the DEG plugin's active file-range scope for one exact child. This root-only tool never releases the guard and never stops, resumes, notifies, or concludes the child or the current root turn: it returns a stable scope-release-refused receipt with the still-active activities so the caller can see what holds the scope. The guard is released only by authoritative child stop evidence (that child's turn/end or disposal) or a process restart; root completion, root generation replacement, and manual actions never release it. Call it only to inspect why a path is still guarded.",
  parameters: {
    childId: {
      type: "string",
      required: true,
      description: "The exact durable child session id whose active DEG scope should be inspected.",
    },
    role: {
      type: "string",
      description: "Optional exact role filter; use it when the same child id has historical route records.",
    },
    reason: {
      type: "string",
      required: true,
      description: "Short diagnostic note for the caller's own record; it is validated for non-emptiness and never changes the outcome.",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // 稳定拒绝回执：任何调用都不会释放保护，因此 kind 固定，不提供成功变体。
        kind: { type: "string", required: true, const: "scope-release-refused" },
        childId: { type: "string", required: true },
        activeCount: { type: "number", required: true },
        // 固定原因码：authoritative-stop-required / no-active-scope。
        reason: { type: "string", required: true },
        /**
         * 仍然持有保护的活动项摘要：activityId / role / taskKey 是插件内部标识，
         * childId 仅为 exact 匹配回显，detached 表示所属 root 已销毁/代际退休。
         * 不包含 prompt、description、affectedPaths 或 parentAgent。
         */
        active: {
          type: "array",
          required: true,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              activityId: { type: "string", required: true },
              role: { type: "string", required: true },
              taskKey: { type: "string", required: true },
              childId: { type: "string" },
              detached: { type: "boolean", required: true },
            },
          },
        },
        hint: { type: "string", required: true },
      },
    },
    render(_args, value) {
      const activeText = value.active.length === 0
        ? "no active scope"
        : value.active.map((task) => task.role + "/" + task.activityId + (task.detached ? " (detached)" : "")).join(", ");
      return [{ type: "text", text: "DEG scope NOT released for " + value.childId
        + " (" + value.reason + ", active " + value.activeCount + ": " + activeText + "). " + value.hint }];
    },
  },
  isConcurrencySafe: () => false,
  execute(args, exec) {
    const parent = exec?.agent;
    if (!isLiveRootAgent(parent)) throw new Error("dsh_expert_group_release_scope is root-only and requires the current live root agent");
    const childId = typeof args?.childId === "string" ? args.childId.trim() : "";
    const role = typeof args?.role === "string" && args.role.trim().length > 0 ? args.role.trim() : void 0;
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
    if (childId.length === 0) throw new Error("dsh_expert_group_release_scope childId must be non-empty");
    if (reason.length === 0) throw new Error("dsh_expert_group_release_scope reason must be non-empty");
    // 只读诊断（票据 07/11）：人工动作不释放影响范围保护。活动项一律保留，等待该
    // child 自己的权威停止证据；同一 parentId 下 detached 的旧代际活动项同样列出，
    // 因为它们仍会阻塞当前 root 的同路径任务。
    const active = delegationTracker.listActiveTasks(parent.id)
      .filter((task) => task.childId === childId && (role === void 0 || task.role === role))
      .map((task) => ({
        activityId: task.id,
        role: task.role,
        taskKey: task.taskKey,
        ...(typeof task.childId === "string" ? { childId: task.childId } : {}),
        detached: task.detached === true,
      }));
    const refusalReason = active.length === 0 ? "no-active-scope" : "authoritative-stop-required";
    lastRefusedScopeRelease = { at: Date.now(), activeCount: active.length, reason: refusalReason };
    return {
      kind: "scope-release-refused",
      childId,
      activeCount: active.length,
      reason: refusalReason,
      active,
      hint: active.length === 0
        ? "该 child 当前没有活动范围，无需释放；DEG 也不会因人工调用改变任何保护。"
        : "DEG 只在权威停止证据（该 child 的 turn/end 或 disposal）或进程重启后释放影响范围保护；root 结束、代际更新与人工动作都不会释放，请等待该 child 的真实停止信号。",
    };
  },
});

/**
 * root-only 人工逃生：在**权威后代查询明确无活动后代**时关闭当前 admission 批次的
 * 等待账本（票据 11）。
 *
 * 边界（fail-closed，逐条对应票据验收）：
 * 1. 只接受当前 live root，且 generation 仍 live；
 * 2. 必须有**开放**的 admission 批次（closed/abandoned 一律 no-open-batch）；
 * 3. 后代查询必须明确回答 known===true；查询失败/降级/未知一律拒绝并返回稳定原因码；
 * 4. running 非空一律拒绝（只回数量，不回 child id）；
 * 5. 成功后只做三件事：标记 batch.abandoned/closed、清 pendingClose、收口等待账本。
 *    绝不调用 delegationTracker/fanoutHost/cancel/notify 的任何释放或取消方法——
 *    专家 child 继续运行，影响范围保护继续持有，真实停止判定不受影响。
 */
const abandonWaitTool = defineTool({
  name: "dsh_expert_group_abandon_wait",
  description: "Root-only manual escape for a root turn wait ledger. Call it only when the authoritative root-scoped descendant query explicitly reports that no descendant is running (known and empty). It closes the current admission batch's wait ledger and marks the batch abandoned: it never cancels, interrupts, or concludes any expert child, never releases the DEG file-range scope, never changes the fanout manager, and never affects the real stop boundary. Query failure, capability degradation, or unknown descendant state is rejected with a stable reason code (descendant-query-unknown); running descendants are rejected as descendants-active; no open admission batch is rejected as no-open-batch. This tool is a last resort for a batch that is demonstrably still while the root turn cannot settle, not a way to skip waiting for live experts.",
  parameters: {
    reason: {
      type: "string",
      required: true,
      description: "Why the wait ledger is being closed manually. Required and non-empty; it is validated for non-emptiness and never changes the authoritative descendant check.",
    },
  },
  output: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        // 成功只回「等待账本已关闭」；拒绝是结构化回执，绝不抛异常。
        kind: { type: "string", required: true, enum: ["wait-abandoned", "rejected"] },
        admissionEpoch: { type: "number", required: true },
        outstanding: { type: "number", required: true },
        // 成功回执：关闭时刻（诊断用）。
        abandonedAt: { type: "number" },
        // 拒绝回执：稳定机器码 + 可执行提示。
        reason: { type: "string" },
        message: { type: "string" },
        // 查询未知时的底层原因码（固定 token，不含错误消息）。
        descendantReason: { type: "string" },
        // 仍有运行后代时的数量（只回数量，不回任何 id）。
        activeCount: { type: "number" },
      },
    },
    render(_args, value) {
      if (value.kind === "wait-abandoned") {
        return [{
          type: "text",
          text: "root wait ledger abandoned: admissionEpoch " + value.admissionEpoch
            + ", outstanding " + value.outstanding
            + "; no child was cancelled and no scope was released",
        }];
      }
      let text = "root wait abandon rejected: " + value.reason;
      if (value.activeCount !== undefined) text += " — active descendants: " + value.activeCount;
      if (value.descendantReason) text += " — descendant query: " + value.descendantReason;
      if (value.message) text += " — " + value.message;
      return [{ type: "text", text }];
    },
  },
  isConcurrencySafe: () => false,
  async execute(args, exec) {
    const parent = exec?.agent;
    const reason = typeof args?.reason === "string" ? args.reason.trim() : "";
    // 拒绝回执统一构造：admissionEpoch/outstanding 固定可与成功回执同形。
    const reject = (code, message, extra) => ({
      kind: "rejected",
      admissionEpoch: 0,
      outstanding: 0,
      reason: code,
      message,
      ...(extra ?? {}),
    });
    if (!isLiveRootAgent(parent)) {
      return reject("root-only", "dsh_expert_group_abandon_wait 只能由当前 live root agent 调用；专家子代理不要关闭等待账本。");
    }
    if (reason.length === 0) {
      return reject("invalid-reason", "reason 必须是非空字符串：请写明本次人工关闭等待账本的原因。");
    }
    const rootToken = host.lineage.tokenFor(parent);
    if (!host.lineage.isLiveGeneration(parent, rootToken)) {
      return reject("root-generation-retired", "root 代际已退休，不能关闭等待账本；不要重试，由当前 root 重新开始。");
    }
    const batch = getAdmissionBatch(parent);
    if (batch === void 0 || batch.closed === true || batch.abandoned === true) {
      return reject("no-open-batch", "该 root 当前没有开放的 admission 批次（或批次已关闭），没有可关闭的等待账本；请勿重复调用。");
    }
    let snapshot;
    try {
      snapshot = await snapshotRootTurnDescendants(parent.id);
    } catch (error) {
      // 同步/异步查询抛错都按未知处理：绝不凭异常逃生。
      logTurnWaitError("abandon-wait-query", error);
      snapshot = { known: false, running: [], reason: "descendant-query-failed" };
    }
    // await 之后必须复查：root 可能已退休、批次可能已被 finalize/另一路径关闭或替换。
    if (!isLiveRootAgent(parent)) {
      return reject("root-only", "root 在查询期间已不再是 live root；不要重试。", { admissionEpoch: batch.epoch });
    }
    if (getAdmissionBatch(parent) !== batch || batch.closed === true || batch.abandoned === true) {
      return reject("no-open-batch", "等待期间该 admission 批次已被关闭或替换；不要重试。", { admissionEpoch: batch.epoch });
    }
    if (snapshot?.known !== true) {
      // 固定原因码：底层 reason 只作为诊断 token 回显，绝不把错误消息/异常原文带出。
      const descendantReason = diagnosticToken(snapshot?.reason, "descendant-query-unknown");
      return reject(
        "descendant-query-unknown",
        "无法权威确认后代是否已停止（查询失败/降级/状态未知），拒绝关闭等待账本；等待会继续，未知状态不能当作无活动后代。",
        { admissionEpoch: batch.epoch, descendantReason },
      );
    }
    // known===true 但 running 不是数组：契约不成立，按未知拒绝（人工逃生必须比等待
    // 判定更保守，绝不能把 malformed 当成空列表）。
    if (!Array.isArray(snapshot.running)) {
      return reject(
        "descendant-query-unknown",
        "权威查询的回答结构非法（running 不是数组），拒绝关闭等待账本；等待会继续。",
        { admissionEpoch: batch.epoch, descendantReason: "descendant-query-malformed" },
      );
    }
    const running = snapshot.running;
    if (running.length > 0) {
      return reject(
        "descendants-active",
        "权威查询显示仍有运行中的后代，拒绝关闭等待账本；请等待这些专家真正结束。",
        { admissionEpoch: batch.epoch, activeCount: running.length },
      );
    }
    // 唯一写入：标记批次 + 清 pendingClose + 收口等待账本。绝不触碰 child/manager/scope。
    batch.abandoned = true;
    batch.closed = true;
    batch.pendingClose = void 0;
    const abandoned = rootTurnWaits.abandon(parent, "manual-abandon");
    noteRootWaitAbandon();
    return {
      kind: "wait-abandoned",
      admissionEpoch: batch.epoch,
      outstanding: abandoned.outstanding,
      abandonedAt: Date.now(),
    };
  },
});
  return {
    finalizeTool,
    scopeDiagnosisTool,
    abandonWaitTool,
    readLastRefusedScopeRelease: () => lastRefusedScopeRelease,
  };
}

/**
 * F5：agent/turn-stopping 兜底等待（handler 由 index.js 在原注册点注册）。
 *
 * @param {object} deps - 见 `createFinalizeDomain`。
 * @param {object} api - 域内能力面。
 * @returns {object} F5 能力面。
 */
function installFinalizeTurnStopping(deps, api) {
  const {
    logger,
    rootTurnWaits,
    isLiveRootAgent,
    isRootAgentIdentity,
    isRootWaitStopping,
    markHandoffAdmissionPaused,
    getAdmissionBatch,
  } = deps;
  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const acceptedBatchWorks = (...args) => api.acceptedBatchWorks(...args);
  const pendingCloseBatchFor = (...args) => api.pendingCloseBatchFor(...args);
  const reengagePendingCloseWorks = (...args) => api.reengagePendingCloseWorks(...args);
  const deliverRootFinalizationConclusion = (...args) => api.deliverRootFinalizationConclusion(...args);
/**
 * 收集「已接受、但还没有被 finalize 收口」的 role admission。
 *
 * 判定必须与 finalizeRootAdmissionBatch 的 acceptedEntries 完全一致（同一个
 * outcome 形状），否则兜底会漏掉或多算：reused/continueParentTurn 不需要工作项，
 * 未 settle 的 admission 还在执行中、不能提前登记。
 *
 * 额外过滤：host.handoff 里已经没有这个 exact admission（典型是 release 成功后的
 * 清理）时不能登记——登记一个永远不会结算的键会让 root 永久等待。
 */
function pendingRootAutomaticAdmissions(parent) {
  const batch = getAdmissionBatch(parent);
  // finalize 已经在收口（finalizing）或已收口（closed）时一律让路：那是模型必需
  // 路径，等待结论都由它负责，兜底重复介入只会产生竞争。
  if (batch === void 0 || batch.closed === true || batch.finalizing === true) return [];
  // 活视图：包含 pending-close 期间新接受的 admission（同一开放批次的 exact work 集）。
  // 工作键必须与「精确结算」用的键完全一致：结算走 handoff admission 自己的 token
  // （见 settleAdmissionTurnWait / registerRootTurnWaitWork / acceptedBatchWorks）。
  // 用 batch/ticket token 登记会得到一个永远不会被结算的键 —— 模型遗漏 finalize 时
  // 兜底就会永久挂住 turn。
  return acceptedBatchWorks(parent)
    .filter((work) => work.released !== true)
    .map((work) => ({ token: work.token, admission: work.admission }));
}

/**
 * root turn 即将关闭时的等待兜底（与 finalize 共用**同一个**等待账本/状态机）。
 *
 * 为什么需要它：`dsh_expert_group_finalize` 仍是模型必需路径（prompt 契约要求模型
 * 调用它登记等待），但模型可能遗漏它；纯 `continue_parent_turn` 批次与 fan-out 也可能
 * 在 turn 结束时仍有子代理在跑。此时若直接关闭 turn，root 会变 idle。
 *
 * 本函数**不**暂停/恢复任何 goal，也不主动结束 turn：它把「本 turn 已接受、但还没被
 * finalize 登记的 admission」补登记进同一张等待表，然后等同一张表的静止判定成立。
 * DSH 的 `agent/turn-stopping` 是 serial 事件且会 await 监听器返回的 Promise，
 * 因此等待期间 turn 保持打开，其他 agent 事件照常推进。
 *
 * 对**未 finalize** 的批次只做「补登记 + 等」：不清理 admission、不写任何终态结论——
 * 那些都属于正常的 feedback/release 路径。
 *
 * ## pending-close 批次的接续（两阶段收口的后半段）
 * finalize 已经登记并返回 waiting 的批次由本函数完成收口：
 * - **重新登记**：等待账本的记录可能已在一次静止收口后销毁（此时 `isEngaged()` 为
 *   false、登记集为空），因此这里按 pending-close 保存的 exact admission **以及开放
 *   批次当前的已接受工作活视图**重新登记尚未结算的 work 并 engage，保证「child 先静止、
 *   turn-stopping 后到」以及「pending-close 期间又接受了新 admission」都能被本次等待
 *   完整覆盖；等待在飞期间新接受的 admission 由接受时刻的登记负责（同一个账本）；
 * - **本 turn 的 signal**：等待使用 `payload.signal`（root turn 生命周期），而不是
 *   run_code 子执行的 exec.signal；
 * - **取消不是完成**：等待被取消（用户插话 / abort / root 退休 / 卸载）时批次保持
 *   pending-close，不关闭、不投递，留给后续 root turn 重建等待；
 * - **一次性投递**：等待明确 released 且 signal 未取消、exact root/generation 仍 live
 *   时，才投递一次终态结论并关闭批次。
 *
 * @param {object} parent - exact live root Agent。
 * @param {AbortSignal} [signal] - 本次 root turn 的 signal。
 * @returns {Promise<void>} 静止、收口完成或等待被取消后返回。
 */
async function awaitRootTurnWaitFallback(parent, signal) {
  // 票据 11：人工逃生已经关闭该批次时直接放行。abandoned 是显式标记（closed 之外
  // 的语义位），保证即使账本仍被其它路径 engage 也绝不重新等待或投递。
  if (getAdmissionBatch(parent)?.abandoned === true) return;
  // 同步取一次 pending-close 快照：等待期间批次可能被其它边界关闭或代际退休，
  // 投递前的身份复查（deliverRootFinalizationConclusion）据此拒绝过期投递。
  const pendingClose = pendingCloseBatchFor(parent);
  for (const candidate of pendingRootAutomaticAdmissions(parent)) {
    // candidate 来自当前开放 batch 且仍在 handoff；只有真实 token 成功进入等待账本后，
    // 才标记其真实 cohort entry 的 pauseDone，绝不为缺失 admission 伪造完成。
    const tracked = rootTurnWaits.track(parent, { kind: "admission", token: candidate.token });
    if (tracked !== void 0) markHandoffAdmissionPaused(candidate.admission);
  }
  if (pendingClose !== void 0) reengagePendingCloseWorks(parent, pendingClose);
  // 即使没有补登记的工作项，只要该 root 曾经 engage 过等待体系（例如纯
  // continue_parent_turn 留下的正在运行的 child），也必须让同一状态机判定一次。
  if (!rootTurnWaits.isEngaged(parent)) return;
  const outcome = await rootTurnWaits.wait(parent, signal);
  if (outcome.released !== true) {
    // 取消（用户插话 / abort / root 退休 / 插件卸载）不是专家完成：pending-close 批次
    // 保持开放，既不关闭也不投递，后续 root turn 可以重建等待继续收口。
    logger.warn("dsh-expert-group: root turn wait fallback was cancelled (" + outcome.reason + ")");
    return;
  }
  if (pendingClose === void 0) return;
  deliverRootFinalizationConclusion(parent, pendingClose, signal);
}

/**
 * DSH 的 agent/turn-stopping 是 serial 事件：监听器可以返回 Promise，loop 会 await
 * 后再关闭 turn，因此这里可以安全地保持 turn 打开直到专家真正结束。监听器自身绝不
 * 抛错——DSH 会把 turn-stopping 的异常变成 turn 错误，兜底必须 fail-open。
 */
function onTurnStopping(payload) {
  const parent = payload?.agent;
  if (isRootWaitStopping() || !isRootAgentIdentity(parent) || !isLiveRootAgent(parent)) return;
  // 票据 11：人工逃生关闭的批次直接放行，不再等待、不再投递。
  if (getAdmissionBatch(parent)?.abandoned === true) return;
  // 同步前置判定：既没有进入等待体系、也没有可补登记的 admission、也没有待收口的
  // pending-close 批次时直接放行——绝不为了「形式上返回 Promise」而在每个 turn 边界
  // 插入一次多余的异步查询。pending-close 必须参与：它的等待账本记录可能已被销毁
  // （isEngaged() 为 false），只看账本现状会漏掉整条收口链路。
  if (pendingCloseBatchFor(parent) === void 0
    && !rootTurnWaits.isEngaged(parent)
    && pendingRootAutomaticAdmissions(parent).length === 0) return;
  return awaitRootTurnWaitFallback(parent, payload?.signal).catch((error) => {
    logger.warn("dsh-expert-group: root turn wait fallback failed: " + (error instanceof Error ? error.message : String(error)));
  });
}


  return { pendingRootAutomaticAdmissions, awaitRootTurnWaitFallback, onTurnStopping };
}
