/**
 * 入口恢复登记表 / 记录生命周期 / 模型降级域（R4c · 票据 17）。
 *
 * 这一域持有 R4c 的**唯一可变状态**：
 * - `recoveryRecords`：childId -> durable recovery record（连续恢复计数、恢复 op 表、
 *   任务绑定、feedback 门控状态）。记录跨 Activation 存活，只在父代理真销毁、
 *   插件卸载或惰性替换清理时删除；
 * - `childActivationStates`：childId -> 当前 Activation 的身份与生命周期；
 * - `requestRetryStates` / `modelFallbackStates` / `modelFallbackRouteDisposers`：
 *   per-Agent 的请求级重试预算与运行期模型降级链（WeakMap，随 Agent 销毁摘除）；
 * - `rootAdmissionBatches` / `rootAdmissionEpoch`：root admission 的显式 epoch；
 * - `pendingCreations` / `recoveryOpSeq`：新建 child 的 acceptance 预登记 FIFO 与
 *   自动恢复 op 的单调 id。
 *
 * ## 组合根保留的职责（铁律 1/2）
 * `ctx.effect` 的 recovery 生命周期注册与 `recovery.addDisposeHook` 的调用顺序
 * 仍留在 `index.js` 的原注册点：本模块只提供 `clearAllRecoveryState()` 与
 * `recordsView` 等窄能力。运行期模型降级的 `agent.ctx.on("agent/request", ...)`
 * 是**动态注册点**：本模块只返回 handler（`modelRouteOverrideHandler`）与
 * disposer 记账命令，注册语句仍由 `index.js` 的薄 adapter 执行。
 *
 * ## 状态所有权（铁律 3）
 * `recoveryRecords` 是 Map 子类实例：读面（get/has/values/keys/entries/size/for-of、
 * 以及 host 侧 `instanceof Map` 判定）照旧可用，`set/delete/clear` 一律抛错；
 * 写入只经本模块的命令。`index.js` 不得直接读写容器。
 *
 * ## 行为等价
 * 记录形状、op 生命周期、模型降级判定（候选链定位、triedRoutes 去重、预算边界）、
 * admission epoch 与 pending-close 语义全部与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-recovery
 */
import { isFanoutAgent, isFanoutIdentity, FANOUT_PARENT_AGENT_MARKER } from "../fanout-host.js";
import { isSubagentCapacityError } from "../shared/capacity-errors.js";
import { createAdmissionBatchCoordinator } from "../shared/delegation-cohort.js";
import {
  CONTEXT_INHERITANCE_ERROR_CODES,
  DEFAULT_MODEL_FALLBACK_LIMIT,
  EXPERT_ROUTE_MARKER,
  MODEL_CANDIDATES_EXHAUSTED,
  buildModelRoutePlan,
  modelRouteFieldsFromRecord,
  modelRouteKeyOf,
  normalizeModelFallbackLimit,
  normalizeModelRouteMarker,
  normalizeModelSelection,
} from "../shared/model-route.js";
import { OUTPUT_SCHEMA_ERROR_CODES } from "../shared/structured.js";
import { sameDurableSessionId } from "../shared/structured-path.js";
import {
  FEEDBACK_DELIVERY_LIMIT,
  RECOVERY_RECORD_LIMIT,
  createFeedbackIdentityLedger,
} from "../shared/recovery-ledger.js";
import {
  clearRecoveryOpTimer,
  createRequestRetryState,
  resetRequestRetryState,
} from "../shared/retry-policy.js";
import { createSessionGenerationState } from "../shared/session-generation.js";
import { rollbackCreatedChildAcceptance } from "../shared/pending-creation.js";
import {
  CONTINUABLE_MARKER,
  EFFORT_MARKER,
  PARENT_MARKER,
  ROLE_MARKER,
  hasPluginAdmissionProof,
  isRegisteredExpertRole,
} from "./expert-guards.js";
import { firstNonEmptyText } from "./settings-read-projection.js";

/** recovery record 存储的写入闸门（只有本模块持有这些符号）。 */
const WRITE_SET = Symbol("dsh-expert-group/recovery-records.set");
const WRITE_DELETE = Symbol("dsh-expert-group/recovery-records.delete");
const WRITE_CLEAR = Symbol("dsh-expert-group/recovery-records.clear");

/**
 * recovery record 存储（唯一 owner 的真实容器 + 只读视图）。
 *
 * 为什么是 Map 子类而不是普通 Map 包装：
 * host 侧（expert-group-runtime / snapshot-cache / projection）对
 * `recoveryRecords instanceof Map` 有硬校验，只读视图必须仍是 Map 实例；
 * 三个写入符号在本模块闭包内，`index.js` 与其它域无法经普通 API 写入。
 */
class RecoveryRecordStore extends Map {
  [WRITE_SET](key, value) { return super.set(key, value); }
  [WRITE_DELETE](key) { return super.delete(key); }
  [WRITE_CLEAR]() { return super.clear(); }
  /** @override 只读：写入必须经本域命令。 */
  set() { throw new TypeError("recoveryRecords 只读：请使用 R4c 域命令"); }
  /** @override 只读：删除必须经本域命令。 */
  delete() { throw new TypeError("recoveryRecords 只读：请使用 R4c 域命令"); }
  /** @override 只读：清空必须经本域命令。 */
  clear() { throw new TypeError("recoveryRecords 只读：请使用 R4c 域命令"); }
}

/**
 * 容量淘汰的「live Activation」判定：agents.get(childId) 仍返回对象即视为 live。
 *
 * 为什么不能只看 childId 或 record.agent：record 跨 Activation 存活，而迟到 settlement
 * 的 exact 身份门控依赖 record.agent / record.session。只要宿主仍持有该 child 的 Agent
 * 对象，就必须保留 record，否则结算信息会随记录一起丢失并留下 detached 活动范围。
 * 读面缺失（注入不完整）或 agents.get 抛错时无法证明已停止 → fail-closed 视为 live。
 *
 * @param {object} agents - agents registry（只读查询）。
 * @param {string} childId - exact child session id。
 * @returns {boolean} 仍有 live Agent（或无法证明没有）返回 true。
 */
function recordHasLiveChildAgent(agents, childId) {
  if (agents === null || typeof agents !== "object" || typeof agents.get !== "function") return true;
  try {
    const agent = agents.get(childId);
    return agent !== null && typeof agent === "object";
  } catch {
    return true;
  }
}

/**
 * pendingRecoveries 判定：必须存在且 size === 0 才允许淘汰。
 * 缺失或形状异常（旧记录 / 测试替身）时无法证明恢复链已结算 → fail-closed 视为仍有恢复。
 */
function recordHasPendingRecoveries(record) {
  const pending = record.pendingRecoveries;
  if (pending === null || typeof pending !== "object" || typeof pending.size !== "number") return true;
  return pending.size > 0;
}

/**
 * gated feedback 判定：非空 gatedRecoveryFeedbacks 或非空 recoveryFeedbackDeliveries 都保护记录。
 * 前者是仍待按 exact generation 重投递的撤回消息，后者是本代已投递 id 的去重账本；
 * 淘汰它们会让门控失效或让迟到副本被当成新 settlement。字段缺失（旧形状/测试替身）
 * 同样按「受保护」处理（fail-closed）。
 */
function recordHasGatedFeedback(record) {
  const gated = record.gatedRecoveryFeedbacks;
  if (!Array.isArray(gated) || gated.length > 0) return true;
  const deliveries = record.recoveryFeedbackDeliveries;
  if (!(deliveries instanceof Set)) return true;
  return deliveries.size > 0;
}

/**
 * 未结算 child turn/end 判定：委托 handoff 域的只读查询（不写状态、不发事件）。
 * 查询面缺失、抛错或没有明确返回 false 时一律按「仍有挂起」fail-closed 处理：
 * 淘汰这类记录会丢失尚未完成的 handoff 结算信息。
 */
function recordHasPendingChildTurnEnds(handoff, record) {
  if (handoff === null || typeof handoff !== "object"
    || typeof handoff.hasPendingChildTurnEndsForRecord !== "function") return true;
  try {
    return handoff.hasPendingChildTurnEndsForRecord(record) !== false;
  } catch {
    return true;
  }
}

/**
 * 容量淘汰资格（可核对规则）：以下条件**全部**成立才允许淘汰。
 * 1. 没有 live Activation（agents.get(childId) 不是对象）；
 * 2. pendingRecoveries 存在且 size === 0；
 * 3. 没有非空 gatedRecoveryFeedbacks / recoveryFeedbackDeliveries；
 * 4. handoff 域没有该 record 的未结算 child turn/end。
 * fail-closed：任何一步状态缺失或形状异常都返回 false（仍受保护）。因此
 * RECOVERY_RECORD_LIMIT 只是可淘汰历史记录的软上限，记录数允许暂时超过它。
 *
 * @param {string} childId - exact child session id（store 的键）。
 * @param {object} record - durable recovery record。
 * @param {{agents?:object, handoff?:object}} evictionDeps - 只读依赖面。
 * @returns {boolean} 可淘汰返回 true。
 */
function recoveryRecordIsEvictable(childId, record, evictionDeps) {
  if (record === null || typeof record !== "object") return false;
  if (recordHasLiveChildAgent(evictionDeps?.agents, childId)) return false;
  if (recordHasPendingRecoveries(record)) return false;
  if (recordHasGatedFeedback(record)) return false;
  return !recordHasPendingChildTurnEnds(evictionDeps?.handoff, record);
}

/**
 * 找出「最旧且通过淘汰资格判定」的 record id（Map 插入序 = LRU 顺序）。
 *
 * 跳过条件：
 * - protectedRecord：刚创建的那条必须留下，创建者手里还拿着它；
 * - recoveryRecordIsEvictable 返回 false：live / 有挂起恢复 / 有 gated feedback /
 *   有挂起 child turn-end 的记录一律顺延到下一条（见该函数的四重判据）。
 *
 * @param {Map} store - recovery record 存储（只读遍历）。
 * @param {object} protectedRecord - 不得淘汰的刚创建 record。
 * @param {{agents?:object, handoff?:object}} evictionDeps - 只读依赖面。
 * @returns {string|undefined} 可淘汰的 childId；没有可淘汰项时返回 undefined。
 */
function oldestEvictableRecordId(store, protectedRecord, evictionDeps) {
  for (const [childId, record] of store.entries()) {
    if (record === protectedRecord) continue;
    if (recoveryRecordIsEvictable(childId, record, evictionDeps)) return childId;
  }
  return void 0;
}

/**
 * 把 record 存储修剪到 RECOVERY_RECORD_LIMIT 以内（可淘汰历史记录的软上限）。
 *
 * 只在新建 record 之后调用，因此容量增长点唯一。淘汰走既有的 dropRecoveryRecord：
 * releaseScope 保持 false（容量淘汰不等于该 child 已权威停止，活动范围保护要保留），
 * 同时由 expectedRecord 精确锁定同一条 record，避免淘汰并发替换后的新记录。
 *
 * 容量语义（正确性优先于容量）：256 只是「可淘汰历史记录」的软上限，不是硬上限。
 * live Activation / 非空 pendingRecoveries / 非空 gated feedback / 有挂起 child
 * turn-end 的记录永不淘汰，因此 store.size 可以暂时超过 256；淘汰这些记录会丢失
 * 恢复链与交接结算信息，比内存暂时超限严重得多。资格判定 fail-closed：状态缺失或
 * 形状异常一律按「受保护」处理。
 *
 * 防御边界：
 * - 单次循环必须有真实减量，否则立即退出：dropRecoveryRecord 因 exact 身份不匹配
 *   而拒绝删除时不会无限重试；
 * - 本函数不 catch 异常，调用点用 try/catch 包住，保证创建流程不被修剪失败打断。
 *
 * @param {Map} store - recovery record 存储。
 * @param {object} protectedRecord - 刚创建、不得被淘汰的 record。
 * @param {function} dropRecord - 域内 dropRecoveryRecord（childId, message, expectedRecord, options）。
 * @param {{agents?:object, handoff?:object}} evictionDeps - 只读依赖面：agents registry 与
 *   handoff 域能力面（只调用只读查询，不写状态、不发事件）。
 */
function pruneRecoveryRecords(store, protectedRecord, dropRecord, evictionDeps) {
  while (store.size > RECOVERY_RECORD_LIMIT) {
    const victimId = oldestEvictableRecordId(store, protectedRecord, evictionDeps);
    if (victimId === void 0) return;
    const sizeBefore = store.size;
    dropRecord(victimId, "recovery record capacity exceeded", store.get(victimId), { releaseScope: false });
    if (store.size >= sizeBefore) return;
  }
}

/**
 * 创建恢复登记表 / 模型降级域能力面。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx）。
 * @param {object} deps.host - Host 组合根（只用到 lineage 代次表与 handoff 索引）。
 * @param {object} deps.agents - agents registry（只读查询）。
 * @param {object} deps.delegation - delegationTracker（活动范围登记）。
 * @param {object} deps.handoff - handoff 域能力面（admission / feedback 门控 / 代际迁移）。
 * @param {object} deps.finalize - finalize 域能力面（pending-close 批次登记）。
 * @param {object} deps.storage - settings/storage 域读面与 child_models 写命令。
 * @param {object} deps.identity - root/child 身份与存活判定。
 * @param {function} deps.ensureModelRouteOverride - 组合根的动态注册 adapter（幂等安装 route 覆盖 listener）。
 * @returns {object} 恢复登记表 / 模型降级域能力面。
 */
export function createIndexRecoveryDomain(deps) {
  const store = new RecoveryRecordStore();
  const api = {};
  Object.assign(api, installRecoveryRecords(deps, api, store));
  Object.assign(api, installActivationState(deps, api, store));
  Object.assign(api, installModelFallback(deps, api));
  Object.assign(api, installModelRoutePersistence(deps));
  Object.assign(api, installAdmissionBatches(deps, api));
  Object.assign(api, installPendingCreations(deps, api));
  return { ...api };
}

/**
 * R1：recovery record 注册表（唯一 owner）与记录生命周期命令。
 *
 * 记录的创建 / 迁移 / 删除、Session generation 绑定与 feedback 门控状态迁移全部
 * 收敛在这里；域外只能经 getRecord() / recordEntries() / recordCount() 读取，
 * 写入必须走 ensure / move / drop 命令。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} api - 域内能力面（跨组调用在运行期解析）。
 * @param {Map} store - recovery record 存储（唯一真实容器）。
 * @returns {object} 记录注册表能力面。
 */
function installRecoveryRecords(deps, api, store) {
  const { host, agents, delegation, handoff, identity } = deps;
  const {
    clearPendingChildTurnEnds,
    releaseHandoffAdmission,
    clearChildHandoffFailure,
    retargetHandoffAdmissionActivation,
    tombstoneGatedRecoveryFeedbacks,
    migrateChildHandoff,
    forgetParentTurnEnds,
    forgetFailedHandoffParent,
    clearPendingHandoffAdmissions,
    settlePendingChildTurnEnds,
    failPendingHandoffAdmission,
    removePendingHandoffAdmission,
  } = handoff;
  const { isRootAgentIdentity } = identity;
  const delegationTracker = delegation;
  /** 写入命令：普通 set/delete/clear 在只读视图上抛错，只有本域能改容器。 */
  const recordSet = (key, value) => store[WRITE_SET](key, value);
  const recordDelete = (key) => store[WRITE_DELETE](key);
  const recordClear = () => store[WRITE_CLEAR]();

  /**
   * 把 recovery record 绑定到当前 Session generation，并切换 transient 状态。
    * cold resume/replacement 会产生新的 Session 对象；新对象必须拥有新的 turn
    * 去重集合和 claimed 映射，但 durable tasks/op/activity 保持在 record。
    */
   function bindRecoverySession(record, session, previousActivation) {
     if (record === void 0 || session === null
       || (typeof session !== "object" && typeof session !== "function")) return void 0;
     const previousSession = record.session;
     if (!(record.sessionState?.get instanceof Function)) {
       const previousHandled = record.handledTurnEnds instanceof Set ? [...record.handledTurnEnds] : [];
       const previousClaimed = record.claimed instanceof Map ? [...record.claimed] : [];
       record.sessionState = createSessionGenerationState();
       if (previousSession !== void 0) {
         const previousState = record.sessionState.get(previousSession);
         for (const turn of previousHandled) previousState.handledTurnEnds.add(turn);
         for (const pair of previousClaimed) previousState.claimed.set(pair[0], pair[1]);
       }
     }
     if (previousSession !== void 0 && previousSession !== session) {
       record.sessionState.reset(previousSession);
       // Session/Activation generation 变化后，旧 child 的撤回消息不能被新
       // generation 当作最终 feedback 重投递；恢复 op/activity 仍由 durable record 保留。
       tombstoneGatedRecoveryFeedbacks(record);
       record.recoveryFeedbackDeliveries?.clear?.();
       if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
     }
     const nextActivation = record.agent;
     if (previousActivation !== void 0 && previousActivation !== nextActivation
       && Array.isArray(record.gatedRecoveryFeedbacks)) {
       tombstoneGatedRecoveryFeedbacks(record);
       record.recoveryFeedbackDeliveries?.clear?.();
       record.gatedRecoveryFeedbacks.length = 0;
     }
     if (record.parentAgent !== void 0 && typeof record.childId === "string"
       && nextActivation !== void 0) {
       retargetHandoffAdmissionActivation(record.parentAgent, record.childId, nextActivation, {
         previousActivation, nextSession: session,
       });
     }
     if (Array.isArray(record.pendingFeedbacks) && nextActivation !== void 0) {
       // A4：activation replacement / cold-resume 会产生新的 Agent/Session generation。
       // pending marker 的关联证据是「到达时刻的 activation + Session generation」，
       // 迁移必须保证它不能被新代际消费：
       // - wildcard（admissionId === undefined）是 activation 级结论，跨代即失效 →
       //   直接丢弃。否则旧代际的 union 会把新代际登记的 token 提前标记成 feedbackSeen
       //   → 提前 release；丢弃后新代际会用自己的 settlement 重建快照消费（不会死锁）。
       // - exact marker 的身份是 admission token/messageId，不随代际漂移：保留并更新
       //   activation，让它在后续 turn/end 仍能精确命中同一 token。
       const generationChanged = (previousActivation !== void 0 && previousActivation !== nextActivation)
         || (previousSession !== void 0 && previousSession !== session);
       record.pendingFeedbacks = record.pendingFeedbacks.filter((pendingFeedback) => {
         if (pendingFeedback === null || typeof pendingFeedback !== "object") return false;
         if (pendingFeedback.activation !== void 0 && previousActivation !== void 0
           && pendingFeedback.activation !== previousActivation) return false;
         if (pendingFeedback.admissionId === void 0 && generationChanged) return false;
         pendingFeedback.activation = nextActivation;
         return true;
       });
     }
     record.session = session;
     const state = record.sessionState.get(session);
     record.handledTurnEnds = state.handledTurnEnds;
     record.claimed = state.claimed;
     return state;
   }

   /**
    * replacement child 不得继承旧 child/session 的 transient turn 归属。
    * durable recovery 数据仍留在同一 record，供新 Activation 接续。
    */
   function resetRecoverySession(record) {
     if (record === void 0) return;
     if (record.sessionState?.reset instanceof Function) record.sessionState.reset(record.session);
     record.session = void 0;
     record.handledTurnEnds = new Set();
     record.claimed = new Map();
   }

   /**
    * 取得（或创建）某专家 child 的 durable recovery record。
   * cold resume 会创建新的 Agent wrapper，但只要它仍挂载同一个 Session 且
   * parentAgent exact 相同，就必须接管原 record，而不是丢弃 tasks/op。
   * 不同 Session 或不同 owner 才使用 expectedRecord 做 owner-scoped drop。
   */
  function ensureRecoveryRecord(childId, parentId, role, parentAgent, childAgent, continuable = false) {
    let record = store.get(childId);
    const parentMismatch = record !== void 0
      && ((parentAgent !== void 0 && record.parentAgent !== void 0 && record.parentAgent !== parentAgent)
        || (record.parentId !== void 0 && record.parentId !== parentId)
        || (record.role !== void 0 && record.role !== role));
    if (parentMismatch) {
      // expectedRecord 身份保护：并发 cold Activation 不能删除已经被另一条
      // generation 原子接管的 record。
      // 归属/角色变化只说明这条 record 不再可信，不证明 child 已停止：保留保护。
      dropRecoveryRecord(childId, "recovery child owner or role changed", record, { releaseScope: false });
      record = void 0;
    }
    if (record !== void 0 && childAgent !== void 0) {
      // Agent wrapper 可因 cold resume 改变；只要任一侧已有 activation/session
      // 身份，就必须通过 durable Session id 校验，避免不同 child 误接管 record。
      const comparable = record.agent !== void 0 || record.session !== void 0 || childAgent.session !== void 0;
      const sameDurableSession = sameDurableSessionId(record.session, childAgent.session, childId);
      if (comparable && !sameDurableSession) {
        // 新 session generation 接管 record 不代表旧执行体已停止：保留保护。
        dropRecoveryRecord(childId, "recovery child session generation changed", record, { releaseScope: false });
        record = void 0;
      }
    }
    if (record !== void 0 && record.parentAgent === void 0 && parentAgent !== void 0) {
      record.parentAgent = parentAgent;
    }
    // marker 和 cold-resume 快照都只能由插件专家路径传入 true；把可信身份
    // 落到运行时 record，避免冷恢复 Agent.options 缺失 marker 时被忽略。
    if (record !== void 0 && continuable === true) record.continuable = true;
    if (record === void 0) {
      record = {
        childId,
        parentId,
        role,
        // 记录父 root 的 exact generation；同 id 的替代 root 不得接管此 record。
        parentAgent,
        continuable: continuable === true,
        /** 连续自动恢复次数：仅在插件自动发送恢复指令时 +1；成功 turn 清零。 */
        recoveryCount: 0,
        /** 进行中的自动恢复 op 表（B4）：opId -> op，每个触发恢复的 turn 一个
         *  独立 op，互不串链、互不重复恢复；取代旧的单一恢复槽位。 */
        pendingRecoveries: new Map(),
        /**
         * 恢复未决时从父 inbox 同步撤回的 DSH feedback。每项保存 parent/child/
         * durable Session/Activation 快照；只允许当前精确 generation 在最终边界
         * 重投递，旧 replacement 的通知只能丢弃。
         */
        gatedRecoveryFeedbacks: [],
        // finalized feedback id 持久化为 blocked/delivered，防止重复 inserted 越过门控。
        recoveryFeedbackTombstones: new Map(),
        recoveryFeedbackDeliveries: new Set(),
        /**
         * 无 message.id delivery 的对象身份 tombstone（item 2）。
         *
         * 无 id 时协议不提供可寻址身份，inbox.remove 也无从调用；只能用 exact message
         * 对象身份把「已被 recovery gate 拦下的 delivery」钉住，避免 gate 关闭后同一
         * 对象再走普通 handoff 队列。WeakSet 不持有消息，随 GC 自动回收，不做无界 Set。
         */
        recoveryFeedbackObjectTombstones: new WeakSet(),
        /**
         * 已消费过的父 inbox feedback message.id 账本（A1，createFeedbackIdentityLedger）。
         *
         * 宿主会以同一 message.id 重复投递同一条 child settlement；副本不能被当作新结论
         * 去消费 cohort 里的 token，否则会把本轮 token 的 feedbackSeen 提前置 true，
         * 导致 root 在结果真正回来之前提前放行。
         *
         * 生命周期与 record 一致，**不做插入序淘汰**（淘汰会让旧副本重新变成新
         * settlement）；达到 FEEDBACK_DELIVERY_LIMIT 时进入 fail-closed 饱和，
         * 无身份 settlement 只能走保守队列路径。
         */
        feedbackIdentityLedger: createFeedbackIdentityLedger({ limit: FEEDBACK_DELIVERY_LIMIT }),
        // terminal=true 表示当前 generation 已经决定交接；后续同一终态的重复
        // inserted 不得再次撤回，新 turn 的 claim/turn 会显式打开下一代 gate。
        recoveryFeedbackActive: false,
        recoveryFeedbackTerminal: false,
        recoveryFeedbackTerminalTurn: void 0,

        /** B1：最近一次 session 引用缓存——跨 Activation 存活，事件处理不再依赖
         *  事件不再依赖 agents.get(childId) 是否 live（Activation 释放后仍可读）。 */
        session: void 0,
        // transient turn/claimed 状态按 Session generation 隔离；其余字段保持 durable。
        sessionState: createSessionGenerationState(),
        /** 当前 child Activation 的 exact Agent；同 id 的旧对象事件不得接管记录。 */
        agent: void 0,
        handledTurnEnds: new Set(),
        /** B2：message.id -> turn 认领映射（agent/inbox/claimed 写入）。
         *  覆盖「消息被 inbox 认领但 user/message 未落盘」（pre-step reject/
         *  取消/异常）的归属缺口；record 生命周期内不清空，按 messageId 覆盖。 */
        claimed: new Map(),
        /** B3：任务绑定表 taskKey -> { messageId, childId, outcome?, blocks?,
         *  failureMessage?, pendingMessage? }——供成功输出缓存、
         *  确定失败记录与 forgetTask 反查。
         *  S1-D：steer/startContinuable admission 前以 pendingMessage:true
         *  预登记（messageId 尚不确定），admission 返回后回填 messageId 并清
         *  标记；claimed 补绑只处理 pendingMessage === true && messageId ===
         *  null 且任务文本匹配的项。S2：上限 TASK_BINDING_LIMIT 条，超限按
         *  插入序淘汰最旧。 */
        tasks: new Map(),
      };
      recordSet(childId, record);
      // 容量修剪：新建记录位于插入序末尾，只会淘汰更旧且通过四重资格判定（无 live
      // Agent / 无待结算恢复 op / 无 gated feedback / 无挂起 child turn-end）的记录；
      // 保护成立时 store 允许暂时超过软上限。用 try/catch 兜底：容量修剪是资源治理，
      // 绝不能让它的异常打断 record 创建（record 已写入容器，创建者仍应拿到可用对象）。
      try {
        pruneRecoveryRecords(store, record, dropRecoveryRecord, { agents, handoff });
      } catch { /* 修剪失败只意味着暂时超出上限。 */ }
    }
    return record;
  }

  /** 从 recovery 重建预登记中消费匹配 parent+role 的原记录。 */
  /**
   * 将 durable recovery record 原子迁移到替代 child。旧 child 的迟到事件因 map
   * 中不再有旧 id 而被忽略；未完成的 root handoff 原因同步迁移到新 child。
   */
  function moveRecoveryRecordToChild(record, childId, childAgent) {
    const previousChildId = record.childId;
    if (previousChildId !== childId) {
      // child replacement 会复用数字 turn；清空旧 Session 的 transient 映射，
      // 但不动 durable tasks/pendingRecoveries/activity/cohort。
      resetRecoverySession(record);
      // 旧 child 的 settlement 不能成为 replacement child 新任务的反馈；即使
      // 同一 parent 仍处于 handoff，也只能由新 generation 自己产生最终通知。
      tombstoneGatedRecoveryFeedbacks(record);
      record.recoveryFeedbackDeliveries?.clear?.();
      if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
      record.recoveryFeedbackTerminal = false;
      record.recoveryFeedbackTerminalTurn = void 0;
      recordDelete(previousChildId);
      migrateChildHandoff(record.parentAgent, previousChildId, childId, childAgent, record.agent);
    }
    const provisional = store.get(childId);
    if (provisional !== void 0 && provisional !== record) recordDelete(childId);
    record.childId = childId;
    recordSet(childId, record);
    return previousChildId;
  }

  /**
   * 删除某 child 的恢复记录（父代理真销毁/插件卸载时防泄漏）。
   * 先清理所有 pending op，保留 accepted/messageId 事实并终止其投递信号。
   *
   * 影响范围保护必须与「记录被丢弃」解耦（票据 07）：root 销毁/代际退休、卸载、
   * owner/session 归属变化等原因丢弃 record 时，并不等于该 child 已经停止。只有调用方
   * 明确声明 releaseScope=true（该 child 已被权威 disposal/terminal turn 证明停止）
   * 时才同时移除它的活动登记；其余原因保留保护，等待真实停止证据。
   *
   * @param {string} childId - exact child session id。
   * @param {string} message - 诊断用原因文案（不写入任何持久化状态）。
   * @param {object} [expectedRecord] - 期望删除的 record（并发替换保护）。
   * @param {{releaseScope?:boolean}} [options] - releaseScope 缺省 false。
   */
  function dropRecoveryRecord(childId, message, expectedRecord, { releaseScope = false } = {}) {
    const record = store.get(childId);
    if (expectedRecord !== void 0 && record !== expectedRecord) return;
    if (record === void 0) return;
    recordDelete(childId);
    // record 已不再有可验证的 current generation，撤回消息不可重投递，避免
    // 已替换/已销毁 child 的旧异常把父代理重新唤醒。
    if (Array.isArray(record.gatedRecoveryFeedbacks)) record.gatedRecoveryFeedbacks.length = 0;
    clearPendingChildTurnEnds(record.parentAgent, record);
    for (const entry of host.handoff.filter((item) => item.parent === record.parentAgent && item.childId === childId)) {
      releaseHandoffAdmission(entry);
      host.handoff.remove(entry);
    }
    clearChildHandoffFailure(record.parentAgent, childId);
    // 只在调用方证明了权威停止时才释放影响范围（releaseScope=true）。root 销毁/
    // 代际退休/卸载只会丢弃 record，活动项继续以 detached 形式阻塞同路径任务。
    if (releaseScope === true) {
      delegationTracker.completeActiveTasksForChild(childId, record.parentId, record.parentAgent);
    }
    for (const op of [...record.pendingRecoveries.values()]) {
      // 先同步终结状态：已排入 microtask 或正等待 sendMessage 的迟到回调必须观察到
      // done/非 dispatching。先清理该 op 的 timer；保留 accepted/messageId，
      // 避免抹掉 manager 已接受消息的事实。
      clearRecoveryOpTimer(op);
      op.dispatching = false;
      op.done = true;
      if (op.controller !== void 0) op.controller.abort();
    }
    record.pendingRecoveries.clear();
  }

  /** 删除某父代理名下全部恢复记录（父代理销毁时防内存泄漏）。 */
  function dropParentRecoveryRecords(parent) {
    if (!isRootAgentIdentity(parent)) return;
    forgetParentTurnEnds(parent);
    forgetFailedHandoffParent(parent);
    clearPendingHandoffAdmissions(parent);
    for (const childId of [...store.keys()]) {
      const record = store.get(childId);
      if (record?.parentAgent === parent) {
        // root 销毁/代际退休不释放影响范围保护（票据 07）：只丢弃 record。
        dropRecoveryRecord(childId, "父代理已销毁，等待被中止", record, { releaseScope: false });
      }
    }
  }

  /**
   * 卸载 / 收尾：取消全部 pending recovery op 后丢弃所有记录。
   *
   * 迁移前该函数体是 recovery.addDisposeHook 的回调；注册时机（addDisposeHook 的
   * 调用顺序）仍留在 index.js 的原注册点，这里只提供函数体（铁律 1）。
   */
  function clearAllRecoveryState() {
    for (const record of store.values()) {
      for (const op of record.pendingRecoveries?.values?.() ?? []) {
        clearRecoveryOpTimer(op);
        try { op.controller?.abort?.(); } catch { /* 取消是幂等的，忽略迟到 controller 异常。 */ }
      }
      record.pendingRecoveries?.clear?.();
    }
    recordClear();
  }

  /**
   * 回滚助手（shared/pending-creation）需要的 Map 读面 + 精确删除能力。
   *
   * 它是 Map 实例（helper 的 instanceof 守卫要求），但 get/delete 都经本域命令；
   * 不暴露 set/clear，也不把真实容器交出去。
   */
  const rollbackRecordView = Object.create(Map.prototype, {
    get: { value: (key) => store.get(key) },
    delete: { value: (key) => store[WRITE_DELETE](key) },
  });

  /**
   * 新建 child 的 acceptance 事务回滚。agent/created 可能在 startContinuable 返回前
   * 同步消费 pendingCreation，因此 catch 不能只看预登记队列；事务记录 exact Agent、
   * record、taskKey、activity 与 handoff admission 的所有权。
   */
  function rollbackCreationTransaction(transaction, message) {
    if (transaction === void 0) return;
    const { parent, handoffAdmission } = transaction;
    if (handoffAdmission !== void 0) {
      failPendingHandoffAdmission(parent, handoffAdmission, transaction.record);
      settlePendingChildTurnEnds(parent, false, handoffAdmission);
      removePendingHandoffAdmission(handoffAdmission);
    }
    rollbackCreatedChildAcceptance({
      recoveryRecords: rollbackRecordView,
      transaction,
      releaseActivity: (activityIdToRelease) => delegationTracker.releaseActiveTask(activityIdToRelease),
      // 事务回滚发生在 admission 边界：child 可能已经创建，不能据此释放范围保护；
      // 回滚助手自己负责释放本次预登记的 activityId。
      dropRecord: (childId, reason, record) => dropRecoveryRecord(childId, reason, record, { releaseScope: false }),
      message,
    });
  }

  return {
    // 只读投影：Map 子类实例，host 侧 instanceof Map 判定与 for-of/get/values 照旧可用。
    recordsView: store,
    getRecord: (childId) => store.get(childId),
    hasRecord: (childId) => store.has(childId),
    recordEntries: () => [...store.entries()],
    recordIds: () => [...store.keys()],
    recordCount: () => store.size,
    ensureRecoveryRecord,
    moveRecoveryRecordToChild,
    dropRecoveryRecord,
    dropParentRecoveryRecords,
    bindRecoverySession,
    resetRecoverySession,
    clearAllRecoveryState,
    rollbackCreationTransaction,
  };
}

/**
 * R2：child Activation 身份表与请求级重试状态。
 *
 * childActivationStates 只记录当前 Activation 的 exact Agent 与 live 状态；
 * requestRetryStates 是 per-Agent WeakMap（随 Agent 销毁摘除，不写 durable record）。
 * 域外只能经下面的读命令与状态工厂访问，不得持有这两个容器。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} api - 域内能力面。
 * @param {Map} store - recovery record 存储（只读读取 parent 归属）。
 * @returns {object} Activation 与重试状态能力面。
 */
function installActivationState(deps, api, store) {
  const { identity } = deps;
  const { isLiveRootAgent } = identity;

  /**
   * childId -> 当前 Activation 的身份与生命周期。DSH 没有公开的 closing 状态，
   * 因此只把 agent/created 标记为 live；收到匹配对象的 agent/disposed 后删除
   * 状态表项。helper 对未知/已释放状态保守交给公开 sendMessage，由 manager
   * 重新处理 admission，避免把 agents.get() 返回的 teardown 中 Agent 当作仍可直接投递目标。
   */
  const childActivationStates = new Map();
  /**
   * Agent 对象 -> 当前 Session/turn/step 的模型请求重试状态。这里使用 WeakMap，
   * 让被替换或销毁的 Agent 不会被迟到 request-error 事件复活；每个状态只存
   * 运行时去重信息，不写入专家任务的 durable recovery record。
   */
  const requestRetryStates = new WeakMap();

  function requestRetryStateFor(agent, session, turn, step) {
    if (agent === null || (typeof agent !== "object" && typeof agent !== "function")) return void 0;
    let state = requestRetryStates.get(agent);
    if (state === void 0) {
      state = createRequestRetryState(session);
      requestRetryStates.set(agent, state);
    }
    const sessionChanged = state.session !== session;
    const turnChanged = state.turn !== void 0 && state.turn !== turn;
    const stepChanged = state.step !== void 0 && state.step !== step;
    if (sessionChanged || turnChanged || stepChanged) {
      resetRequestRetryState(state, session, turn, step);
    } else {
      state.session = session;
      if (state.turn === void 0) state.turn = turn;
      if (state.step === void 0) state.step = step;
    }
    return state;
  }

  function invalidateRequestRetryState(agent) {
    const state = api.readRequestRetryState(agent);
    if (state?.waitController instanceof AbortController) state.waitController.abort();
    requestRetryStates.delete(agent);
  }

  function requestRetryStateIsCurrent(agent, session, turn, step, state, generation) {
    return requestRetryStates.get(agent) === state
      && state.session === session
      && state.turn === turn
      && state.step === step
      && state.generation === generation
      && requestRetryTarget(agent) !== void 0;
  }

  function requestRetryTarget(agent) {
    if (isLiveRootAgent(agent)) return { agent, record: void 0 };
    if (typeof agent?.id !== "string") return void 0;
    const record = store.get(agent.id);
    const activation = childActivationStates.get(agent.id);
    const isPluginChildRecord = record !== null
      && typeof record === "object"
      && typeof record.role === "string"
      // 运行期目录（内置 + 自定义）与持久化 admission 证据都算插件专家身份，
      // 角色删除后 recovery record 仍可参与请求级重试（票据 27）。
      && (isRegisteredExpertRole(record.role) || hasPluginAdmissionProof(record))
      && typeof record.parentId === "string"
      && record.parentId.length > 0
      && (agent?.options?.[CONTINUABLE_MARKER] === true || record.continuable === true);
    if (!isPluginChildRecord
      || record.agent !== agent
      || activation?.agent !== agent
      || activation.status !== "live"
      || !isLiveRootAgent(record.parentAgent)) return void 0;
    if (record.session !== void 0 && agent.session !== void 0 && record.session !== agent.session) return void 0;
    return { agent, record };
  }

  /**
   * 读取 Host 在本次 turn/step 里已经消耗的重试次数。
   *
   * provider 可选：运行期降级后「每个模型各自有 5 次预算」，而 Host 的 llm/retry
   * 事件在同一个 step 里会按不同 provider 交替出现（durable 事件 data.provider 由
   * dsh-llm-retry 写入）。传入当前模型 provider 时只统计该 provider 的事件，
   * 避免上一个模型消耗的 5 次把新候选立刻顶成 exhausted；不传时保持旧语义
   * （统计整个 step，root 与既有调用点行为不变）。
   *
   * @param {object} session - durable Session。
   * @param {number} turn - 当前 turn。
   * @param {number} step - 当前 step。
   * @param {string} [provider] - 当前模型 provider；省略表示不区分 provider。
   * @returns {number} Host 已记录的最大 retry 序号（没有记录返回 0）。
   */
  function hostRetryCountFor(session, turn, step, provider) {
    const events = Array.isArray(session?.events) ? session.events : [];
    const scopeProvider = typeof provider === "string" && provider.length > 0 ? provider : void 0;
    let count = 0;
    for (const event of events) {
      if (event?.type !== "llm/retry"
        || event.data?.turn !== turn
        || event.data?.step !== step) continue;
      // provider 未知（旧事件/测试替身）时只在「不限定 provider」的调用里计入，
      // 限定 provider 的调用必须精确匹配，绝不猜测归属。
      if (scopeProvider !== void 0 && event.data?.provider !== scopeProvider) continue;
      const retry = event.data?.retry;
      if (Number.isSafeInteger(retry) && retry > count) count = retry;
    }
    return count;
  }

  function requestRetryStateIsExhausted(agent, session, turn) {
    const state = api.readRequestRetryState(agent);
    return state?.session === session && state.turn === turn && state.exhausted === true;
  }

  return {
    readChildActivation: (childId) => childActivationStates.get(childId),
    /**
     * 登记当前 Activation（agent/created 与 fan-out child 创建共用）。
     * 新对象覆盖同 id 的旧 Activation；disposed 时由 forgetChildActivation 精确摘除。
     */
    noteChildActivation: (childId, agent) => { childActivationStates.set(childId, { agent, status: "live" }); },
    forgetChildActivation: (childId, agent) => {
      const current = childActivationStates.get(childId);
      if (current?.agent === agent) childActivationStates.delete(childId);
    },
    activationCount: () => childActivationStates.size,
    /** 卸载时丢弃全部 Activation 身份（WeakSet 之外的唯一容器）。 */
    clearChildActivationStates: () => { childActivationStates.clear(); },
    requestRetryStateFor,
    invalidateRequestRetryState,
    requestRetryStateIsCurrent,
    isRequestRetryState: (agent, state) => requestRetryStates.get(agent) === state,
    readRequestRetryState: (agent) => requestRetryStates.get(agent),
    forgetRequestRetryState: (agent) => { requestRetryStates.delete(agent); },
    requestRetryTarget,
    hostRetryCountFor,
    requestRetryStateIsExhausted,
  };
}

/**
 * R3：运行期模型降级（候选路由覆盖 + 失败预算状态机）。
 *
 * 候选链快照按 exact Agent 惰性构建并固定：同一 child 的 candidateIndex /
 * fallbackCount 必须单调可解释。降级只覆盖 agent/request waterfall 的返回值，
 * 绝不修改 agent.options、不重建 child、不写私有事件。
 *
 * 动态注册点（铁律 2）：本组只返回 handler 与 disposer 记账命令，
 * agent.ctx.on("agent/request", ...) 仍由 index.js 的薄 adapter 执行。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} api - 域内能力面。
 * @returns {object} 模型降级能力面。
 */
function installModelFallback(deps, api) {
  const { host, agents, storage, identity } = deps;
  const { readSnapshot, writeChildModelPatch } = storage;
  const { isLiveRootAgent } = identity;
  // 跨组调用：R2 的状态判定与 Activation 读面（运行期解析，避免组间定义顺序耦合）。
  const requestRetryTarget = (...args) => api.requestRetryTarget(...args);
  const readChildActivation = (...args) => api.readChildActivation(...args);
  const writeModelRouteSnapshot = (...args) => api.writeModelRouteSnapshot(...args);
  // 动态注册点仍由组合根的薄 adapter 执行（铁律 2）：切换前必须先真的装上覆盖落点。
  const ensureModelRouteOverride = (...args) => deps.ensureModelRouteOverride(...args);

  // ── 运行期模型降级：候选路由覆盖 + 失败预算状态机 ────────────────────────
  //
  // 目标：把「降级到候选模型」从启动前预检扩展到**运行中**的模型失败。
  // 三条硬边界（与既有语义对齐，不在本层改变）：
  // 1. 同一子代理会话内继续：只覆盖 route，不重建 child、不重建 Session，
  //    因此上下文（messages/tools/system prompt）原样保留；
  // 2. 不修改 agent.options：Host 的 agent/request waterfall 每次尝试都会重新调用，
  //    覆盖只通过该 waterfall 的返回值生效，真实 provider/model 由 route 决定；
  // 3. 不写私有事件：可见性只更新 DEG 自己的 child_models 快照。

  /**
   * Agent 对象 -> 运行期降级状态（WeakMap）。
   *
   * 为什么用 WeakMap + Agent 对象身份：
   * - cold-resume/replacement 会创建新的 Agent，新 Agent 天然获得全新预算与候选链快照，
   *   旧 Agent 的迟到 hook 既取不到状态也无法污染新代际；
   * - 只保存 route 覆盖 / 候选位置 / 已降级次数与候选链快照，绝不保存 prompt、
   *   凭据或 failure 原文；
   * - 与 requestRetryStates（per turn/step 预算）分工不同：链状态跨 step 存活，
   *   因为「这个 child 已经换到第几个候选」属于 Agent 生命周期事实。
   */
  const modelFallbackStates = new WeakMap();

  /**
   * Agent -> agent/request route 覆盖 listener 的 disposer。
   *
   * 安装是幂等的（同一 Agent 只装一次）；Agent 销毁时必须显式摘除，
   * 避免本表继续持有已销毁 Agent 的 listener 引用。
   */
  const modelFallbackRouteDisposers = new WeakMap();

  /** 从 agent.options 读取 admission/恢复写入的真实路由（含显式 effort）。 */
  function admissionModelRouteOf(agent) {
    const provider = agent?.options?.provider;
    const model = agent?.options?.model;
    if (typeof provider !== "string" || provider.length === 0) return void 0;
    if (typeof model !== "string" || model.length === 0) return void 0;
    const effort = agent?.options?.[EFFORT_MARKER];
    return {
      provider,
      model,
      ...(typeof effort === "string" && effort.length > 0 ? { reasoningEffort: effort } : {}),
    };
  }

  /**
   * 两条路由是否指向同一个模型。
   *
   * effort 不参与判定：降级的目标是「换模型」，同一 provider+model 只改 effort
   * 不构成一次降级，也不允许被候选链当成新候选重复消耗次数。
   */
  function sameModelRoute(left, right) {
    return left !== void 0
      && right !== void 0
      && left.provider === right.provider
      && left.model === right.model;
  }

  /** 当前生效路由：运行期覆盖优先，否则就是 admission/恢复写入的 options 路由。 */
  function currentModelRouteOf(agent, chain) {
    return chain?.override !== void 0 ? chain.override : admissionModelRouteOf(agent);
  }

  /**
   * 请求级重试 + 运行期降级的统一目标判定。
   *
   * 与 requestRetryTarget 的唯一差异：并行 fan-out 分片 child 没有 DEG 的
   * recovery record（它们由 fan-out 自己的 attempt 账本管理），因此这里用
   * 「fan-out marker + 持久化 fan-out 身份 + live activation + live 父 root」
   * 四重证据补上目标判定，让分片也获得同一套请求级重试与运行期降级。
   * 证据强度与专家 child 对齐：任何一环不成立都返回 undefined（回到 Host 默认行为），
   * 绝不靠 role/parentId 这类可复制 metadata 猜测身份。
   *
   * root 仍由 requestRetryTarget 命中（既有重试语义完全不变），但它没有角色候选链，
   * modelFallbackChainFor 会返回 undefined，运行期降级对 root 恒不生效。
   *
   * 候选链存在与否同时决定请求级预算的归属（见 modelFallbackChainFor 的注释）：
   * 有候选链时插件按 AUTO_RECOVERY_LIMIT 管理「每个模型 5 次」，没有候选链时
   * 完全保持 Host retryPolicy 与既有终态语义。
   *
   * @param {object} agent - request-error payload 上的 exact Agent。
   * @returns {{agent:object, role:string|undefined}|undefined}
   */
  function requestFallbackTarget(agent) {
    const expert = requestRetryTarget(agent);
    if (expert !== void 0) {
      return {
        agent,
        role: firstNonEmptyText(expert.record?.role, agent?.options?.[ROLE_MARKER]) ?? void 0,
      };
    }
    if (typeof agent?.id !== "string") return void 0;
    let persisted;
    try { persisted = readSnapshot()?.childModels?.[agent.id]; } catch { persisted = void 0; }
    if (!isFanoutAgent(agent) && !isFanoutIdentity(persisted)) return void 0;
    const activation = readChildActivation(agent.id);
    if (activation?.agent !== agent || activation.status !== "live") return void 0;
    const parentId = firstNonEmptyText(
      agent?.options?.[FANOUT_PARENT_AGENT_MARKER],
      persisted?.fanoutParentAgentId,
      persisted?.parentId,
      agent?.options?.[PARENT_MARKER],
    );
    if (parentId === null) return void 0;
    if (!isLiveRootAgent(host.lineage.activeRoot(parentId))) return void 0;
    return {
      agent,
      role: firstNonEmptyText(agent?.options?.[ROLE_MARKER], persisted?.role) ?? void 0,
    };
  }

  /**
   * 在候选链里定位当前路由的位置；找不到返回 -1（表示「不在链上」）。
   *
   * 恢复策略（cold-resume 序号可能过期）：先按 provider+model 在**新计划**里精确匹配；
   * 匹配不到时才考虑复用持久化序号，并且必须校验该序号指向的计划项与当前路由
   * 同 provider+model——用户在中途改过候选列表时，旧序号可能指向完全不同的模型，
   * 直接复用会把「降级到第 2 个候选」错记成「当前就在第 2 个候选」。校验失败返回 -1
   * 表示「明确从头开始」：nextModelCandidateOf 会从计划头扫描，并靠 triedRoutes
   * 跳过当前路由，绝不回到同一个失败模型。
   */
  function modelRouteIndexInPlan(plan, route, marker, recordedRoute) {
    if (route !== void 0) {
      for (let index = 0; index < plan.length; index += 1) {
        if (sameModelRoute(plan[index]?.selection, route)) return index;
      }
    }
    const markerIndex = Number.isSafeInteger(marker?.candidateIndex)
      ? marker.candidateIndex
      : Number.isSafeInteger(recordedRoute?.candidateIndex)
        ? recordedRoute.candidateIndex
        : void 0;
    if (markerIndex !== void 0 && markerIndex >= 0 && markerIndex < plan.length
      && sameModelRoute(plan[markerIndex]?.selection, route)) return markerIndex;
    return -1;
  }

  /**
   * 惰性构建某个 child 的候选链快照（按 Agent 缓存，只建一次）。
   *
   * 一致性边界（明确取舍，避免用户中途改配置把同一 child 的降级序列打乱）：
   * - primary 优先取 admission 写入的 requestedPrimary（已包含会话覆盖），
   *   其次取 agent.options 的真实路由；两者都不存在时不做任何降级；
   * - 候选列表与 fallbackLimit 取**首次需要降级那一刻**的全局 settings 快照，
   *   之后随 Agent 固定：同一 child 的 candidateIndex/fallbackCount 必须单调、
   *   可解释，不能因为用户在运行中途改候选/改上限而跳变或回退；
   * - 新 child、以及 cold-resume 产生的新 Agent 会按当时的 settings 重新构建链，
   *   因此用户中途修改候选只影响之后创建的 child（与 persona/deny 的既有边界一致）。
   * 读源不可用时按「没有候选」处理：绝不凭空降级，也绝不因为读配置失败而改变
   * 既有请求级重试/终态语义。
   *
   * @param {object} agent - exact Agent。
   * @param {{role?:string}} target - requestFallbackTarget 的结果。
   * @returns {object|undefined} 链状态；无角色/无 primary 时返回 undefined。
   */
  function modelFallbackChainFor(agent, target) {
    const cached = modelFallbackStates.get(agent);
    if (cached !== void 0) return cached;
    const role = typeof target?.role === "string" && target.role.length > 0 ? target.role : void 0;
    if (role === void 0) return void 0;
    let persisted;
    try { persisted = typeof agent?.id === "string" ? readSnapshot()?.childModels?.[agent.id] : void 0; } catch { persisted = void 0; }
    const marker = normalizeModelRouteMarker(agent?.options?.[EXPERT_ROUTE_MARKER]);
    const recordedRoute = modelRouteFieldsFromRecord(persisted);
    const requestedPrimary = marker?.requestedPrimary ?? recordedRoute.requestedPrimary;
    const primary = requestedPrimary ?? admissionModelRouteOf(agent);
    if (primary === void 0) return void 0;
    let candidates = [];
    let fallbackLimit = DEFAULT_MODEL_FALLBACK_LIMIT;
    try {
      const snapshot = readSnapshot();
      candidates = Array.isArray(snapshot?.candidates?.[role]) ? snapshot.candidates[role] : [];
      fallbackLimit = normalizeModelFallbackLimit(snapshot?.fallbackLimit);
    } catch { /* 读源不可用：保持空候选/默认上限，等价于「不降级」。 */ }
    const planInfo = buildModelRoutePlan(primary, candidates, fallbackLimit);
    const route = admissionModelRouteOf(agent);
    const index = modelRouteIndexInPlan(planInfo.plan, route, marker, recordedRoute);
    const persistedFallbackCount = Number.isSafeInteger(marker?.fallbackCount) && marker.fallbackCount >= 0
      ? marker.fallbackCount
      : Number.isSafeInteger(recordedRoute?.fallbackCount) && recordedRoute.fallbackCount >= 0
        ? recordedRoute.fallbackCount
        : void 0;
    const chain = {
      role,
      plan: planInfo.plan,
      fallbackLimit: planInfo.fallbackLimit,
      index,
      // 已试过的路由键：index 已知时由单调前进保证不回头；index 未知（设置已改到
      // 找不到当前路由）时用它兜住，避免在两个候选之间来回 ping-pong 消耗预算。
      // 去重口径与运行期一致：provider+model（忽略 effort），effort-only 变化
      // 不构成一次切换（见 shared.js modelRouteKeyOf 的注释）。
      triedRoutes: new Set(route === void 0 ? [] : [modelRouteKeyOf(route)]),
      override: void 0,
      // admission 阶段（启动前预检）已经消耗的降级次数；运行期降级与它共用同一上限。
      baselineFallbacks: persistedFallbackCount ?? (index >= 0 ? index : 0),
      switches: 0,
    };
    modelFallbackStates.set(agent, chain);
    return chain;
  }

  /**
   * 选取候选链里的下一个模型。
   *
   * 预算边界：buildModelRoutePlan 已按 fallbackLimit 截断计划，这里再校验
   * 「admission 降级次数 + 运行期降级次数 + 1 <= fallbackLimit」，两道条件同时满足
   * 才允许切换——这样即使 settings 在运行中途被改大，也不会让已有 child 越界降级。
   *
   * @param {object} chain - 链状态。
   * @param {object} currentRoute - 当前生效路由。
   * @returns {{index:number, candidateIndex:number, selection:object}|undefined}
   */
  function nextModelCandidateOf(chain, currentRoute) {
    const start = chain.index >= 0 ? chain.index + 1 : 0;
    for (let index = start; index < chain.plan.length; index += 1) {
      const selection = normalizeModelSelection(chain.plan[index]?.selection);
      if (selection === void 0) continue;
      if (sameModelRoute(selection, currentRoute)) continue;
      // 已试路由按 provider+model 去重：同一模型换 effort 不是一次有效切换。
      if (chain.triedRoutes.has(modelRouteKeyOf(selection))) continue;
      if (chain.baselineFallbacks + chain.switches + 1 > chain.fallbackLimit) return void 0;
      return { index, candidateIndex: chain.plan[index].candidateIndex, selection };
    }
    return void 0;
  }

  /**
   * 安装运行期 route 覆盖（幂等）。
   *
   * 与 installEffortInjection 并排安装在同一 Agent 的 scoped ctx 上；prepend:true
   * 让本 listener 处于最外层：先让内层（effort 注入 / 宿主 model-selection）算出
   * route，最后再整体覆盖 provider/model/effort，避免 effort 注入把失败模型的
   * 推理档位重新补回候选路由。
   *
   * 只读取插件自己的 WeakMap 状态；没有覆盖时原样透传 resolved，绝不改变
   * 未降级 child（以及 root）的既有请求形状。
   *
   * @param {object} agent - exact Agent。
   * @returns {boolean} 已安装（或已装过）返回 true。
   */
  function modelRouteOverrideHandler(agent) {
  return async (_payload, next) => {
      const resolved = await next();
      const override = modelFallbackStates.get(agent)?.override;
      if (override === void 0 || resolved === null || typeof resolved !== "object") return resolved;
      const effort = typeof override.reasoningEffort === "string" && override.reasoningEffort.length > 0
        ? override.reasoningEffort
        : void 0;
      const routeMatched = resolved.provider === override.provider && resolved.model === override.model;
      const effortMatched = effort === void 0
        ? resolved.reasoningEffort === void 0
        : resolved.reasoningEffort === effort;
      if (routeMatched && effortMatched) return resolved;
      // 与宿主 installModelSelection 同一语义：覆盖 provider/model 时丢弃继承的
      // reasoningEffort；候选未声明 effort 就交还 adapter 解析默认档，绝不把
      // 另一个 provider/失败模型的档位带过去（那会变成 INVALID_REQUEST 或静默降档）。
      const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
      return {
        ...rest,
        provider: override.provider,
        model: override.model,
        ...(effort === void 0 ? {} : { reasoningEffort: effort }),
      };
    };
  }

  /**
   * 尝试降级到候选链里的下一个模型。
   *
   * 只修改插件自己的状态并返回 true；由调用方返回 {kind:"retry"} 让 Host 重新
   * prepareRequest —— 下一次尝试会重新走 agent/request waterfall，从而拿到覆盖后的
   * provider/model，同一 Session、同一 child、上下文完全保留。
   *
   * 并发/竞态：本函数只由 request-error hook 在 activeKey 临界区内调用（同一 turn/step
   * 一次只有一个失败在处理）；状态写入是同步的，因此不会有两个失败同时抢到同一个
   * 候选位置；持久化是异步旁路，不参与竞争。
   *
   * @param {object} agent - exact Agent。
   * @param {{role?:string}} target - requestFallbackTarget 的结果。
   * @param {object} state - 当前 turn/step 的请求级重试状态。
   * @returns {boolean} true = 已切换（调用方应返回 retry）。
   */
  function switchToNextModelCandidate(agent, target, state) {
    const chain = modelFallbackChainFor(agent, target);
    if (chain === void 0 || chain.plan.length <= 1) return false;
    const currentRoute = currentModelRouteOf(agent, chain);
    if (currentRoute === void 0) return false;
    const next = nextModelCandidateOf(chain, currentRoute);
    if (next === void 0) return false;
    // 覆盖必须真有落点：拿不到 scoped ctx 时拒绝切换，否则 loop 会用同一路由重发，
    // 把候选预算白白耗在同一个失败模型上。
    if (ensureModelRouteOverride(agent) !== true) return false;
    chain.index = next.index;
    chain.override = { ...next.selection };
    chain.switches += 1;
    chain.triedRoutes.add(modelRouteKeyOf(next.selection));
    // 新候选重新获得完整请求级预算。取消语义：调用方必须先排除 signal.aborted
    // （本函数只处理真实失败），因此这里不会把用户中断当成降级触发。
    state.retryCount = 0;
    state.exhausted = false;
    state.generation = Number.isSafeInteger(state.generation) ? state.generation + 1 : 1;
    writeModelRouteSnapshot(agent, chain, next);
    return true;
  }

  function clearRequestRetryStateForSessionEvent(session, event) {
    if (typeof session?.id !== "string") return;
    const liveAgent = agents.get(session.id);
    const record = api.getRecord(session.id);
    const agent = liveAgent?.session === session ? liveAgent
      : record?.session === session ? record.agent : void 0;
    if (agent === void 0) return;
    const state = api.readRequestRetryState(agent);
    if (state?.session !== session) return;
    const type = event?.type;
    if (type === "turn/start" || type === "step/start") {
      resetRequestRetryState(state, session, event.data?.turn, event.data?.step);
    } else if (type === "turn/end" || type === "step/end") {
      // 终态（exhausted）必须活到 turn/end 真正被结算：handoff admission 会把
      // handleChildTurnEnd 推迟到父 inbox settlement 之后，而本函数在 turn/end
      // 事件的 finally 里同步执行；若在这里无条件删除状态，延迟结算的
      // handleChildTurnEnd 会读到 requestRetryExhausted=false，把一次不可恢复的
      // 模型失败当成可恢复失败继续自动续跑。新 turn/start（或 step/start）会
      // resetRequestRetryState 清掉 exhausted，因此不会跨 turn 抑制恢复；
      // Agent 销毁时 invalidateRequestRetryState 也会删除，不会泄漏。
      if (state.exhausted !== true) api.forgetRequestRetryState(agent);
    }
  }

  return {
    requestFallbackTarget,
    modelFallbackChainFor,
    currentModelRouteOf,
    switchToNextModelCandidate,
    clearRequestRetryStateForSessionEvent,
    hasModelRouteOverrideDisposer: (agent) => modelFallbackRouteDisposers.has(agent),
    noteModelRouteOverrideDisposer: (agent, dispose) => { modelFallbackRouteDisposers.set(agent, dispose); },
    /**
     * agent/request route 覆盖 handler（动态注册点交给组合根，铁律 2）。
     *
     * 只读取本域的 WeakMap 状态；没有覆盖时原样透传 resolved，绝不改变未降级
     * child（以及 root）的既有请求形状。
     *
     * @param {object} agent - exact Agent。
     * @returns {function} waterfall handler。
     */
    modelRouteOverrideHandler,
    /**
     * Agent 销毁时摘除 listener 与链状态：迟到 hook 不能复活旧预算，
     * 也不能把覆盖应用到同 id 的新代际。
     *
     * @param {object} agent - exact Agent。
     */
    dropModelFallbackState: (agent) => {
      const dispose = modelFallbackRouteDisposers.get(agent);
      if (dispose !== void 0) {
        modelFallbackRouteDisposers.delete(agent);
        try { dispose(); } catch { /* disposer 抛错不影响销毁路径。 */ }
      }
      modelFallbackStates.delete(agent);
    },
  };
}


/**
 * R3-a：候选切换的 child_models 快照旁路写入（可见性来源）。
 *
 * 与降级状态机分开成组：这里只有一个纯写入函数，依赖面仅 storage 的 child_models
 * 写命令；写入失败只由 writeChildModelPatch 内部告警，绝不让「快照没写上」把一次
 * 已经生效的降级回滚成失败。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} 快照写入能力面。
 */
function installModelRoutePersistence(deps) {
  const { storage } = deps;
  const { writeChildModelPatch } = storage;

  /**
   * 把候选切换写进 child_models 快照（侧栏/用量统计的可见性来源）。
   *
   * 旁路持久化：写入失败只由 writeChildModelPatch 内部告警，绝不让「快照没写上」
   * 把一次已经生效的降级回滚成失败。写入走同一串行队列，因此不会与 usage/
   * structured 等其它 child_models patch 互相覆盖。
   *
   * 刻意省略 lastRouteErrorCode：运行期失败码（429/5xx/TIMEOUT/…）不在
   * MODEL_ROUTE_ERROR_CODES 的稳定枚举里，硬塞会让投影把「限流」误读成「模型不可用」；
   * 预检阶段写入的旧值原样保留。
   *
   * @param {object} agent - exact Agent。
   * @param {object} chain - 链状态。
   * @param {{index:number, candidateIndex:number, selection:object}} next - 选中的候选。
   */
  function writeModelRouteSnapshot(agent, chain, next) {
    if (typeof agent?.id !== "string") return;
    const effort = typeof next.selection.reasoningEffort === "string" && next.selection.reasoningEffort.length > 0
      ? next.selection.reasoningEffort
      : void 0;
    void writeChildModelPatch(agent.id, {
      provider: next.selection.provider,
      model: next.selection.model,
      ...(effort === void 0 ? {} : { reasoningEffort: effort }),
      candidateIndex: next.candidateIndex,
      fallbackCount: chain.baselineFallbacks + chain.switches,
    }, effort === void 0
      // 候选未声明 effort：**显式删除**旧档位（浅合并会保留主模型/上一个候选的
      // reasoningEffort，投影就会显示「候选模型 + 主模型思考档」）。删除后运行期
      // route 覆盖同样会清空继承 effort，由新 provider 自行解析默认档。
      ? { remove: ["reasoningEffort"] }
      : undefined).catch(() => { /* 旁路持久化失败已由 writeChildModelPatch 记录，绝不向上抛。 */ });
  }

  return { writeModelRouteSnapshot };
}

/**
 * R4：root admission 的显式 epoch 与批次收口判定。
 *
 * role tool 只登记并返回 token；finalize 以「当前 root 的开放批次 + epoch」
 * 定位整批并收口。pending-close 期间新接受的 admission 同步进入等待集，
 * 收口结论的 acceptedCount 因此取收口时刻的完整集合。
 *
 * @param {object} deps - 窄能力面。
 * @returns {object} admission 批次能力面。
 */
function installAdmissionBatches(deps) {
  const { finalize } = deps;
  const { notePendingCloseAdmission } = finalize;

  /**
   * root admission 的显式 epoch。role tool 只负责登记并返回 token；finalize 以
   * 「当前 root 的开放批次 + admissionEpoch」定位整批并收口后关闭当前 epoch，后续
   * admission 会创建新 epoch，不会把迟到调用或下一轮调用并入已经收口的批次。
   */
  const rootAdmissionBatches = new WeakMap();
  let rootAdmissionEpoch = 0;
  function createRootAdmissionBatch() {
    return {
      epoch: ++rootAdmissionEpoch,
      coordinator: createAdmissionBatchCoordinator(),
      entries: new Map(),
      sequence: 0,
      /**
       * 在途 ticket 计数：begin 时 +1、settle 时 -1。
       *
       * 只用于判定「本批是否已经只剩被丢弃的 ticket」（见 discardRootAdmission），
       * 让「只发生过拒绝」的空批次可以被安全撤下；不参与 finalize 的凭据校验，
       * 也不改变任何已公开的回执语义。
       */
      pendingTickets: 0,
      closed: false,
      finalizing: false,
      /**
       * 两阶段收口的 pending-close 登记（见 finalizeRootAdmissionBatch）。
       *
       * finalize 在登记完成后把本批次标为 pending-close：工具立即返回 waiting，等待
       * 职责移交给 root turn 的 `agent/turn-stopping` serial 边界。这里保存的是
       * **exact admission 对象**（而不是 token 或 id），因为等待账本的记录会在一次静止
       * 收口后被销毁，后续 turn 只能靠这份精确凭据重新登记尚未结算的 work；用 id/token
       * 猜身份会重新登记一个永远不会结算的键。
       *
       * `admissions` 是**批次级**闩锁的一部分，而不是冻结的快照：批次在收口前始终开放，
       * pending-close 期间新接受的 admission 会在接受时刻被追加进来（并同步登记进等待
       * 账本），因此「重新等待」与「收口结论的 acceptedCount」看到的都是该批次收口
       * 时刻的完整 accepted 集。
       */
      pendingClose: void 0,
      /** steer 不可用的告警只记一次（不影响批次状态）。 */
      steerUnavailableLogged: false,
    };
  }
  function beginRootAdmission(parent) {
    if (parent === null || (typeof parent !== "object" && typeof parent !== "function")) return void 0;
    let batch = rootAdmissionBatches.get(parent);
    if (batch === void 0 || batch.closed === true) {
      batch = createRootAdmissionBatch();
      rootAdmissionBatches.set(parent, batch);
    }
    const ticket = batch.coordinator.begin();
    batch.pendingTickets += 1;
    const token = batch.epoch + ":" + (++batch.sequence);
    const entry = { token, epoch: batch.epoch, settled: false, outcome: void 0, discarded: false, ticket };
    batch.entries.set(token, entry);
    return {
      ...ticket,
      token,
      epoch: batch.epoch,
      entry,
      // outcome 记录点需要 exact root 才能把「pending-close 期间新接受的 work」写进
      // 同一批次的等待集（见 recordRootAdmissionOutcome / notePendingCloseAdmission）。
      parent,
      settle() {
        const settled = ticket.settle();
        if (settled) {
          entry.settled = true;
          batch.pendingTickets -= 1;
        }
        return settled;
      },
      whenReady: () => ticket.whenReady(),
    };
  }
  function recordRootAdmissionOutcome(admission, outcome) {
    if (admission?.entry === void 0) return;
    admission.entry.outcome = outcome;
    admission.entry.settled = true;
    // pending-close 批次仍开放时，新接受的 exact work 必须在**接受时刻**就进入
    // pending-close 的 work 集与等待账本（见 notePendingCloseAdmission）：否则批次级
    // 闩锁与「该批次的 exact 工作集」会脱节，收口等待可能少等这一项、结论里的
    // acceptedCount 也会停在旧值。判定与 finalize 的 acceptedEntries 完全一致：
    // reused / continueParentTurn 不产生未结算工作。
    if (outcome?.kind === "continuable" && outcome.reused !== true && outcome.continueParentTurn !== true
      && outcome.handoffAdmission !== void 0) {
      notePendingCloseAdmission(admission.parent, outcome.handoffAdmission);
    }
  }
  /**
   * 丢弃一个**已经 beginRootAdmission**、但最终没有向调用方交出任何 admission 结论的 ticket。
   *
   * 只用于「格式合法但目标未知/越权」的拒绝路径（childId 的 CHILD_NOT_FOUND）：这次调用
   * 没有派发、没有投递、没有 interrupt，也没有产生任何 handoff，因此：
   * 1. 记录 rejected outcome 并 settle 协调器，让本批在途计数归位，批次不会停在
   *    admission-outcome-pending（否则 finalize 永远收不了口）；
   * 2. 把 entry 标记为 discarded —— 收口集合由服务端枚举，只能包含**模型真正收到凭据**
   *    的 admission；把模型永远拿不到的 ticket 留在有效集合里，会让 expected 与
   *    tokenDiagnostics 虚高，也会让批次停在 admission-outcome-pending（这正是
   *    「毒化 root batch」）；
   * 3. 若本批已无在途 ticket、且全部 entry 都是 discarded，就把整批从 map 撤下：之后
   *    「本 turn 没有真实 admission」的 finalize(epoch 0，且不传 token) 仍然回到既有的
   *    no-admission 幂等语义，而不是被一个空批次挡成 admission-epoch-mismatch。
   *
   * 撤批是精确的：只在本批仍是该 root 的当前批次、未 closed、未进入 pending-close/
   * finalizing、且没有任何在途 ticket 时执行，绝不撤掉后续真实 admission 所属的批次。
   */
  function discardRootAdmission(admission, outcome) {
    if (admission?.entry === void 0) return;
    admission.entry.outcome = outcome;
    admission.entry.discarded = true;
    admission.settle();
    admission.entry.settled = true;
    const batch = rootAdmissionBatches.get(admission.parent);
    if (batch === void 0 || batch.closed === true || batch.pendingClose !== void 0 || batch.finalizing === true) return;
    if (batch.pendingTickets !== 0) return;
    for (const entry of batch.entries.values()) {
      if (entry.discarded !== true) return;
    }
    if (rootAdmissionBatches.get(admission.parent) === batch) rootAdmissionBatches.delete(admission.parent);
  }
  function roleAdmissionFailure(phase, error) {
    const message = error instanceof Error ? error.message : String(error);
    // 上下文继承（票据 29）：显式失败必须保留稳定 code，供主代理区分“宿主没有继承
    // provider”“父会话还没有已完成 turn”与普通 admission 失败；绝不归成泛化错误。
    if (error?.code === CONTEXT_INHERITANCE_ERROR_CODES.UNAVAILABLE
      || error?.code === CONTEXT_INHERITANCE_ERROR_CODES.EMPTY) {
      return { reason: "context", code: error.code, message };
    }
    // 结构化声明（票据 30）：非法/超限/不支持都必须保留稳定 code，
    // 不能归成泛化的 ADMISSION_FAILED；schema 原文不在 message 里。
    if (error?.code === OUTPUT_SCHEMA_ERROR_CODES.INVALID
      || error?.code === OUTPUT_SCHEMA_ERROR_CODES.TOO_LARGE
      || error?.code === OUTPUT_SCHEMA_ERROR_CODES.UNSUPPORTED) {
      return { reason: "schema", code: error.code, message };
    }
    if (phase === "provider") return { reason: "provider", code: "PROVIDER_UNAVAILABLE", message };
    if (phase === "selection") {
      // 候选耗尽保留稳定 code，便于主代理区分“没有可用候选”与普通输入错误。
      return {
        reason: "selection",
        code: error?.code === MODEL_CANDIDATES_EXHAUSTED ? MODEL_CANDIDATES_EXHAUSTED : "MODEL_SELECTION_INVALID",
        message,
      };
    }
    // 容量耗尽：结构化 code 优先于文案启发式（它已由 DEG 翻译成可读提示，不再匹配
    // steer/messageId 等英文关键词），归入可重试的 steer 失败并保留可读文案。
    if (isSubagentCapacityError(error)) {
      return { reason: "capacity", code: "SUBAGENT_CAPACITY_REACHED", message };
    }
    if (/startContinuable|child admission returned an invalid childId/i.test(message)) {
      return { reason: "start", code: "START_FAILED", message };
    }
    if (/steer|followup|messageId/i.test(message)) return { reason: "steer", code: "STEER_FAILED", message };
    return { reason: "admission", code: "ADMISSION_FAILED", message };
  }

  return {
    beginRootAdmission,
    recordRootAdmissionOutcome,
    discardRootAdmission,
    roleAdmissionFailure,
    getAdmissionBatch: (parent) => rootAdmissionBatches.get(parent),
  };
}

/**
 * R5：自动恢复 op 的单调 id 与新建 child 的 acceptance 预登记 FIFO。
 *
 * 两个状态都是域的私有计数器/队列：域外只能经命令递增与入队/出队，
 * 不得直接 splice 容器（铁律 3）。
 *
 * @param {object} deps - 窄能力面。
 * @param {object} api - 域内能力面。
 * @returns {object} op id 与预登记队列能力面。
 */
function installPendingCreations(deps, api) {
  const { delegation, handoff } = deps;
  const { failPendingHandoffAdmission, settlePendingChildTurnEnds, removePendingHandoffAdmission } = handoff;
  const delegationTracker = delegation;
  const dropRecoveryRecord = (...args) => api.dropRecoveryRecord(...args);


  /** 自动恢复 op 的单调递增 id（B4：每个触发恢复的 turn 一个独立 op）。 */
  let recoveryOpSeq = 0;

  /** P3：startContinuable 新建路径的 binding acceptance 竞态预登记 FIFO 队列。
   *  元素 { taskKey, parentId, role }——在 delegateBackground 调用
   *  startContinuable **之前**推入；agent/created（同步触发且早于 promise
   *  resolve）按 parentId+role 取第一个匹配项并立即写入 pendingMessage 绑定，
   *  消除「inbox 已认领消息但 record.tasks 尚无绑定」的竞态。父+角色串行
   *  （delegationTracker.serialize）保证同 scope 最多一个待创建项；不同角色
   *  互不干扰。startContinuable 返回/抛错后若仍未消费则清理残留。 */
  const pendingCreations = [];
  /** 分配下一个恢复 op id（每个触发恢复的 turn 一个独立 op）。 */
  function nextRecoveryOpId() { return ++recoveryOpSeq; }
  /** 预登记一个新建 child 的 acceptance 事务（FIFO）。 */
  function pushPendingCreation(entry) { pendingCreations.push(entry); }
  /** 是否已存在匹配的预登记项。 */
  function hasPendingCreation(predicate) { return pendingCreations.some(predicate); }
  /** 取出第一个匹配的预登记项（不删除）。 */
  function findPendingCreation(predicate) { return pendingCreations.find(predicate); }
  /** 删除指定预登记项（不存在时无操作）。 */
  function removePendingCreation(entry) {
    const index = pendingCreations.indexOf(entry);
    if (index !== -1) pendingCreations.splice(index, 1);
  }
  /** root 代际退休：丢弃该父代理名下的全部预登记项。 */
  function prunePendingCreationsForParent(parent) {
    for (let index = pendingCreations.length - 1; index >= 0; index--) {
      if (pendingCreations[index].parent === parent) pendingCreations.splice(index, 1);
    }
  }

  return {
    nextRecoveryOpId,
    pushPendingCreation,
    hasPendingCreation,
    findPendingCreation,
    removePendingCreation,
    prunePendingCreationsForParent,
  };
}
