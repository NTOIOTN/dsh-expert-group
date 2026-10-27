/**
 * 主代理（Orchestrator）模型配置的**写入管线**（批次 A 地基的第二个关注点）。
 *
 * ## 为什么单独成一个模块
 * 运行期 manager（host/orchestrator-model）负责"会话状态与事件判定"（谁被接管、什么时候
 * 该写、写完之后怎么记账）；本模块只回答"这一次该写什么、能不能写"：
 * 1. **目标解析**（resolveTarget）：复用 host/orchestrator-settings 的层解析（覆盖 > 时段 >
 *    全局 > 不干预），自动意图遇到覆盖层就让位，显式意图则正是要写覆盖层；
 * 2. **catalog 预检**（chooseCandidate）：复用注入的 models.resolveSelection，按候选顺序
 *    切换，只对预检类失败降级；
 * 3. **写入**（writeSelection）：只调一次 selectModel，并统一处理"返回值表达失败"与抛错；
 * 4. **手动接管的持久化**（persistManualOverride）：把用户在主界面 picker 选的模型写进
 *    session_overrides.orchestrator（手动手动优先，但重启后仍只影响该会话）。
 *
 * ## 手动持久化的顺序保证（H1：乱序覆盖修复）
 * `models.resolveSelection` 是异步的（模型目录解析）。若每条 model/selection 事件各自
 * 跑完预检就落盘，**先选的旧值可能后落盘**：用户先选 A、再选 B，而 A 的目录解析更慢，
 * 于是 B 先写、A 最后覆盖——重启后就恢复到用户早就改掉的旧模型。
 *
 * 因此手动持久化有两条保证，缺一不可：
 * 1. **串行**：manager 把「预检 + 落盘」整体排进该会话既有的串行链，同一会话的手动
 *    持久化不会并发执行；
 * 2. **新鲜度栅栏**：本函数在每个检查点询问注入的 `isStale()`（由 manager 按**每会话
 *    意图代次**实现）。已有更新的手动选择/显式配置写入时，本次落盘整体放弃——
 *    不写、不改任何状态，只记一条安全原因码。
 * 栅栏判定与落盘调用之间**没有 await**，因此"判定通过后又被更新的值抢先写入"不可能发生。
 *
 * manager 仍独占全部**运行期状态**（自写令牌、意图代次、applied 记账）：本模块无状态，
 * 绝不持有会话记录，也不决定"写完之后算不算生效"——那是 B4 的重新校验，属于 manager。
 *
 * @module dsh-expert-group/host/orchestrator-write
 */
import { ORCHESTRATOR_SELECTION_KEY, modelSelectionKeyOf, normalizeModelSelection } from "../shared/model-route.js";
import { orchestratorLayerOf, orchestratorPeriodOf, orchestratorPlanOf } from "./orchestrator-settings.js";

/**
 * 把一条已归一的选择转成 selectModel 的入参：**effort 缺省时删除该键**。
 *
 * 产品语义：effort 缺省 = 使用模型默认档。写空串或 null 会把 adapter 当前的默认档
 * 固化成用户配置，后续模型默认档演进就再也跟不上。
 *
 * @param {object} selection - 已归一的选择。
 * @returns {{provider: string, model: string, reasoningEffort?: string}|null} 写入入参。
 */
export function writeSelectionOf(selection) {
  const normalized = normalizeModelSelection(selection);
  if (normalized === undefined) return null;
  return {
    provider: normalized.provider,
    model: normalized.model,
    ...(normalized.reasoningEffort === void 0 ? {} : { reasoningEffort: normalized.reasoningEffort }),
  };
}

/**
 * 创建写入管线。
 *
 * 注入面 5 组：settings（快照）/ models（catalog 预检）/ clock（时段判定与"现在"）/
 * logger（只记安全错误名）/ persistence（手动接管的覆盖写入）。
 *
 * @param {object} deps - 见上。
 * @returns {object} 管线命令面。
 */
export function createOrchestratorWriter({ settings, models, clock, logger, persistence }) {
  /** 只记固定前缀与安全错误名：绝不输出 message 原文（可能含路径/凭据）。 */
  function logFailure(action, error) {
    try {
      const label = error instanceof Error ? error.name : typeof error;
      logger?.warn?.("dsh-expert-group: orchestrator writer " + action + " failed: " + label);
    } catch {
      // 日志失败绝不影响主流程。
    }
  }

  /**
   * 记录一次**按判据主动放弃**（不是失败）。
   *
   * 只写动作标签与固定原因码：放弃判据里包含会话与选择，但日志绝不输出选择值、会话 id
   * 或错误正文（可能含路径/凭据），因此诊断可定位而不可泄漏。
   *
   * @param {string} action - 动作标签（preflight / persist 两个检查点各一个）。
   * @param {string} reason - 安全原因码（目前只有 "superseded"）。
   */
  function logSkip(action, reason) {
    try {
      logger?.warn?.("dsh-expert-group: orchestrator writer " + action + " skipped: " + reason);
    } catch {
      // 日志失败绝不影响主流程。
    }
  }

  /**
   * 解析本次意图的目标（层 + 候选计划）。
   *
   * @param {string} sessionId - 根会话 id。
   * @param {boolean} explicit - 是否为用户的显式配置写入（会话覆盖 set/clear）。
   * @returns {{outcome: string, plan?: object, period?: string}} outcome 为 "ready" 时带 plan/period；
   *   否则 outcome 就是放弃原因（"override" / "not-configured"）。
   */
  function resolveTarget(sessionId, explicit) {
    const snapshot = settings.snapshot();
    const period = orchestratorPeriodOf(snapshot, clock.now());
    const layer = orchestratorLayerOf(snapshot, sessionId, period);
    if (layer.source === "override" && explicit !== true) {
      // 用户的显式覆盖已经在该会话生效；自动触发重复写它只会制造无意义的 model/selection。
      return { outcome: "override" };
    }
    const plan = orchestratorPlanOf(layer.config);
    if (plan === null) return { outcome: "not-configured" };
    return { outcome: "ready", plan, period };
  }

  /**
   * catalog 预检 + 候选顺序切换（只对预检类失败降级）。
   *
   * @param {object} plan - orchestratorPlanOf 的计划。
   * @param {() => boolean} isSuperseded - 每次预检前询问"意图是否已被取代"。
   * @returns {Promise<{selection: object, candidateIndex: number}|null>} 选中项；全部失败为 null。
   */
  async function chooseCandidate(plan, isSuperseded) {
    for (const entry of plan.plan) {
      const candidate = normalizeModelSelection(entry.selection);
      if (candidate === undefined) continue;
      if (isSuperseded()) return null;
      try {
        const resolved = await models.resolveSelection(candidate);
        return { selection: normalizeModelSelection(resolved) ?? candidate, candidateIndex: entry.candidateIndex };
      } catch (error) {
        logFailure("preflight", error);
      }
    }
    return null;
  }

  /**
   * 把一条选择写进根会话的原生模型（**只调用一次** selectModel）。
   *
   * 宿主可能用返回值表达失败（形状未在契约里定死）：只有显式 ok === false 才按失败处理
   * ——其它任何返回值（含 void / 对象 / 布尔）都按成功，避免把正常写入误判成失败而反复重试。
   * 抛错与"返回值失败"同一语义：调用方（manager）据此清令牌并保持 applied 不变。
   *
   * @param {Function} selectModel - 已绑定的 sessionController.selectModel。
   * @param {string} sessionId - 根会话 id。
   * @param {object} selection - 已归一的选择。
   * @returns {Promise<{ok: boolean, outcome?: string}>} 写入结果。
   */
  async function writeSelection(selectModel, sessionId, selection) {
    const payload = writeSelectionOf(selection);
    if (payload === null) return { ok: false, outcome: "invalid-selection" };
    try {
      const written = await selectModel({ sessionId, ...payload });
      if (written !== null && typeof written === "object" && written.ok === false) {
        throw Object.assign(new Error("selectModel rejected the selection"), { name: "SelectModelRejected" });
      }
      return { ok: true };
    } catch (error) {
      logFailure("selectModel", error);
      return { ok: false, outcome: "write-failed" };
    }
  }

  /** 当前应生效目标（层级解析）的比较键；没有配置时为空串。 */
  function effectiveKeyOf(sessionId) {
    const snapshot = settings.snapshot();
    const period = orchestratorPeriodOf(snapshot, clock.now());
    const layer = orchestratorLayerOf(snapshot, sessionId, period);
    const effective = layer.config === null ? null : normalizeModelSelection(layer.config.defaults);
    return modelSelectionKeyOf(effective);
  }

  /**
   * 把手动接管的模型持久化成会话覆盖（B2 第 3 条，best-effort）。
   *
   * 语义：手动优先直到会话结束，但**重启后仍只影响该会话**，因此写 session_overrides
   * 的那一行，而不是全局配置。先走同一条 catalog 预检；预检失败/写入失败只记诊断，
   * 绝不回滚"手动接管"这一事实（那是事件层已经确定的状态）。
   *
   * ## 新鲜度栅栏（H1）
   * `isStale` 是 manager 给出的**每会话意图代次**判据，在预检前后各问一次：
   * - 预检前：已经被取代的旧值连目录查询都不做（省掉无意义的异步等待）；
   * - 预检返回后、落盘之前：这才是真正的栅栏——预检期间用户可能已经选了更新的模型。
   *
   * 判为过时就整体放弃：不写、不改状态、只记 `skipped: superseded` 诊断。
   * 判据只看代次，与选择值无关，因此不需要（也不应该）比较任何模型字段。
   *
   * @param {string} sessionId - 根会话 id。
   * @param {object} selection - 用户手动选择的模型。
   * @param {() => boolean} [isStale] - 新鲜度判据；省略时不做栅栏（保留无栅栏的旧调用形态）。
   * @returns {Promise<void>} 完成后无返回值（失败/放弃只记诊断）。
   */
  async function persistManualOverride(sessionId, selection, isStale) {
    // 检查点 1（预检前）：本会话已有更新的手动/意图代次 => 不必再查模型目录。
    if (isStale !== void 0 && isStale() === true) {
      logSkip("manual-override-preflight", "superseded");
      return;
    }
    let resolved;
    try {
      resolved = normalizeModelSelection(await models.resolveSelection(selection))
        ?? normalizeModelSelection(selection);
    } catch (error) {
      logFailure("manual-override-preflight", error);
      return;
    }
    if (resolved === undefined) return;
    // 检查点 2（预检返回后、落盘之前）：预检是异步的，期间用户可能已经改选了更新的模型；
    // 此时若继续落盘，旧值会覆盖新值（重启后恢复到旧模型）。判据只看代次。
    if (isStale !== void 0 && isStale() === true) {
      logSkip("manual-override-persist", "superseded");
      return;
    }
    // 同值不重复写：宿主可能对同一次用户操作回显多条 model/selection。
    const existing = settings.snapshot()?.sessionOverrides?.[sessionId]?.[ORCHESTRATOR_SELECTION_KEY];
    if (modelSelectionKeyOf(existing) === modelSelectionKeyOf(resolved)) return;
    // 栅栏判定与入队之间没有任何 await：persistence.writeOrchestratorOverride 内部是
    // 同步入写链（组合根的 enqueueWrite），因此"判定通过的先后"就是"写入队列的先后"，
    // 更新的值不会被判定更早、执行更晚的旧值反超。
    try {
      await persistence.writeOrchestratorOverride({ sessionId, selection: resolved });
    } catch (error) {
      logFailure("manual-override-persist", error);
    }
  }

  return { resolveTarget, chooseCandidate, writeSelection, effectiveKeyOf, persistManualOverride };
}
