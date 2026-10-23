/**
 * 入口手动派发提交域（R4e · 票据 19）。
 *
 * 手动派发（单专家 / fan-out / 模板派发）与 fanout 工具 execute 的关键步骤逐项同源：
 * 1) spawn provider 就绪；2) `resolveRoleModelRoute` 真实预检（primary → 有序候选 fallback）；
 * 3) `submitFanoutTask(parent, args, precheckRoute)` 提交并登记 root wait。
 * 因此手动派发不会绕过 admission、affectedPaths 冲突、角色/provider 并发限制、wait
 * ledger 或目标交接；只读角色的 deny 由 manager 构造 child 请求时按同一注册表施加。
 *
 * 失败一律返回稳定 code/status 的结构化结果（`manualDispatchFailure` 形状），
 * 取消则原样上抛由 RPC 映射 499——绝不把客户端/状态问题伪装成 500 internal。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册：本域没有 ctx 注册点。
 *
 * @module dsh-expert-group/host/index-manual-dispatch
 */
import {
  modelRouteErrorCodeOf,
  modelRouteErrorMessage,
} from "../shared/model-route.js";

/**
 * 创建手动派发提交能力面。
 *
 * @param {object} deps - 窄能力面（7 组）。
 * @param {object} deps.failures - 模板规划域的失败构造器：`manualDispatchFailure`、
 *   `manualDispatchVerdictFailure`、`manualDispatchSchemaFailure`（同一 code 词表）。
 * @param {object} deps.routing - 模型路由域：`resolveRoleModelRoute(role, parentId, signal)`。
 * @param {object} deps.commands - fan-out 任务命令面：`submitFanoutTask`、
 *   `buildFanoutContinuationHandle`。
 * @param {object} deps.core - 专家核心域：`spawnProviderReady()`。
 * @param {object} deps.abort - 取消面：`createAbortError()`。
 * @param {object} deps.identity - 根身份面：`agents`、`lineage`、`isLiveRootAgent`。
 * @param {object} deps.reads - fan-out RPC 只读解析面（host/index-fanout-rpc.js）：
 *   `fanoutRpcSessionId`、`fanoutRpcIsChildSession`、`fanoutRpcRootSession`。
 * @returns {object} `{ runManualFanoutDispatch, requireManualFanoutRoot }`。
 */
export function createManualFanoutDispatch({ failures, routing, commands, core, abort, identity, reads }) {
  /**
   * 手动派发/模板共用的提交路径。
   *
   * 与 fanout 工具 execute 的关键步骤逐项同源：
   * 1) spawn provider 就绪；
   * 2) resolveRoleModelRoute 做真实预检（primary → 有序候选 fallback）；
   * 3) submitFanoutTask(parent, args, precheckRoute) 提交并登记 root wait。
   *
   * 因此手动派发不会绕过 admission、冲突检查、并发限制、wait ledger 或目标交接；
   * 只读角色的 deny 由 manager 构造 child 请求时按同一注册表施加。
   *
   * @param {object} parent - exact live root Agent。
   * @param {object} plan - buildManualDispatchPlan 的成功结果。
   * @param {AbortSignal|undefined} signal - RPC 请求取消信号。
   * @returns {Promise<object>} {ok:true, receipt} 或 manualDispatchFailure。
   */
  async function runManualFanoutDispatch(parent, plan, signal) {
    if (!core.spawnProviderReady()) {
      return failures.manualDispatchFailure(503, "subagent-unavailable", "subagent provider 不可用，无法派发专家任务");
    }
    let route;
    try {
      route = await routing.resolveRoleModelRoute(plan.role, parent.id, signal);
    } catch (error) {
      // 取消必须原样上抛（由 RPC 映射 499），其它预检失败回结构化 code，不回传原始错误正文。
      if (signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") throw error;
      const routeCode = modelRouteErrorCodeOf(error);
      return failures.manualDispatchFailure(
        400,
        "model-route-unavailable",
        "角色 " + plan.role + " 的模型预检失败："
          + modelRouteErrorMessage(routeCode),
        { code: routeCode },
      );
    }
    if (route === null) {
      return failures.manualDispatchFailure(400, "role-model-not-configured", plan.role + " 专家尚未配置模型");
    }
    if (signal?.aborted === true) throw abort.createAbortError();

    let result;
    try {
      result = commands.submitFanoutTask(parent, plan.args, route);
    } catch (error) {
      // schema 在提交阶段可能因 provider 能力不足被拒绝（输出契约不降级）。
      if (error?.name === "OutputSchemaError") return failures.manualDispatchSchemaFailure(error);
      // manager 的校验/冲突/容量拒绝保持其稳定 code（客户端可按同一词表处理）。
      if (error?.name === "FanoutValidationError") {
        return failures.manualDispatchVerdictFailure({
          code: error.code,
          message: error.message,
          field: error.field,
          violation: error.violation,
          conflict: error.conflict,
        });
      }
      throw error;
    }
    if (result?.accepted === false) {
      // manager 关闭/回收屏障等“当前不可提交”的拒绝：与 500 内部错误区分，可重试。
      const reclaimInProgress = result.code === "RECLAIM_IN_PROGRESS";
      return failures.manualDispatchFailure(
        reclaimInProgress ? 409 : 503,
        reclaimInProgress ? "dispatch-reclaim-in-progress" : "dispatch-unavailable",
        reclaimInProgress ? "已有回收正在进行中，请稍后重试" : "fan-out 当前不可提交",
        typeof result.code === "string" ? { code: result.code } : undefined,
      );
    }

    const continuation = commands.buildFanoutContinuationHandle(result.task);
    return {
      ok: true,
      receipt: {
        kind: "fanout",
        accepted: true,
        mode: plan.mode,
        parentTaskId: result.parentTaskId,
        role: result.role,
        status: result.status,
        // 幂等命中必须显式标注 duplicate，让客户端知道这一击没有新建任务。
        ...(result.duplicate === true ? { duplicate: true } : {}),
        ...(Number.isSafeInteger(result.task?.round) ? { round: result.task.round } : {}),
        shardIds: result.shardIds,
        ...(continuation === void 0 ? {} : { continuation }),
        task: result.task,
      },
    };
  }

  /**
   * 手动派发/模板动作的 root 解析（root-only + exact live root）。
   *
   * 复用 fanoutRpcRootSession 的同一套判定（非子会话、非 DEG child、registry 有 live
   * Agent），并额外要求当前代际 token 仍 live：同 id replacement / 已销毁 root 不能
   * 借旧 sessionId 派发新 child。失败统一 404，不泄露跨 root 的存在性。
   *
   * @param {object} body - RPC body。
   * @returns {{ok:true, parent:object, sessionId:string} | {ok:false, failure:object}}
   */
  function requireManualFanoutRoot(body) {
    const sessionId = reads.fanoutRpcSessionId(body);
    if (sessionId.length === 0) {
      return { ok: false, failure: failures.manualDispatchFailure(400, "bad-request", "缺少 sessionId") };
    }
    if (reads.fanoutRpcIsChildSession(sessionId)) {
      return { ok: false, failure: failures.manualDispatchFailure(404, "session-not-found", "根会话不存在或尚未恢复") };
    }
    const parent = reads.fanoutRpcRootSession(sessionId);
    let live = false;
    if (parent !== void 0) {
      try {
        live = identity.isLiveRootAgent(parent) && identity.lineage.isLiveGeneration(parent, identity.lineage.tokenFor(parent));
      } catch {
        live = false;
      }
    }
    if (live !== true) {
      return { ok: false, failure: failures.manualDispatchFailure(404, "session-not-found", "根会话不存在或尚未恢复") };
    }
    return { ok: true, parent, sessionId };
  }


  return { runManualFanoutDispatch, requireManualFanoutRoot };
}
