/**
 * 入口工具面装配域（R4d · 票据 18）：routing / orchestrator 提示词的动态重建。
 *
 * 这一域负责“提示词跟随 provider 与角色目录”的部分：
 * - provider 不可用时如实声明专家团队不可用，绝不声称工具可用；
 * - 其余情况只列出当前启用的 role-named 工具，取值完全来自角色目录；
 * - orchestrator system section 在启用时重建，内容来自角色目录与只读设置快照。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**：`systemPrompt.section` 的调用点仍在装配 adapter 的原注册点。
 * `refreshRoutingPrompt` 通过注入的 `section` 命令创建/释放 section，disposer 仍归
 * 入口 effect 树所有。
 *
 * ## 状态唯一 owner
 * 本模块不持有跨域容器：提示词 disposer 以返回句柄的形式交回入口（本模块闭包内）。
 *
 * @module dsh-expert-group/index-expert-tools-surface
 */
import { buildOrchestratorPrompt, isRootAgentContext } from "../orchestrator.js";

/**
 * routing / orchestrator 提示词的动态重建（provider 可用性与角色目录的只读投影）。
 *
 * @param {object} deps - 窄能力面（5 组：systemPrompt / config / roles / core / storage）。
 * @returns {object} 提示词重建能力面。
 */
export function createRoutingPrompt({ systemPrompt, config, roles, core, storage }) {
  const { activeRoles } = roles;
  const source = () => storage.readSnapshot();

  /** 根据 provider 可用性与已挂载角色，动态重建编排提示词；provider 不可用时绝不声称工具可用。 */
  let routingDisposer;
  let orchestratorDisposer;
  function rootPromptText(text) {
    return (assemblyContext) => isRootAgentContext(assemblyContext) ? text : "";
  }
  function refreshRoutingPrompt() {
    if (routingDisposer !== void 0) {
      try { routingDisposer(); } catch { /* 释放旧 routing 段落失败只影响旧实例回收，刷新必须继续注册新段落；当前为有意降级，若需观测请走宿主 logger（本模块不持有 logger）。 */ }
      routingDisposer = void 0;
    }
    if (orchestratorDisposer !== void 0) {
      try { orchestratorDisposer(); } catch { /* 同上：orchestrator 段落释放失败只影响旧实例回收，不能让刷新路径失败；当前为有意降级，若需观测请走宿主 logger（本模块不持有 logger）。 */ }
      orchestratorDisposer = void 0;
    }
    const providerReady = core.spawnProviderReady();
    const roles = activeRoles();
    if (config.enableOrchestrator === true) {
      orchestratorDisposer = systemPrompt.section({
        name: "dsh-expert-group:orchestrator",
        order: 1,
        text: (assemblyContext) => isRootAgentContext(assemblyContext)
          ? buildOrchestratorPrompt({
            roles,
            providerReady,
            observerPreferred: source().observerPreferred === true,
            rootSessionId: assemblyContext.agent.id,
          })
          : "",
      });
    }
    if (!providerReady) {
      const text = "The expert subagent team is currently unavailable because the \"spawn\" subagent provider is not ready" +
        (config.enableObserver === true ? " (observer would also be unavailable in this state)" : "") + ".";
      routingDisposer = systemPrompt.section({ name: "dsh-expert-group:routing", order: 117, text: rootPromptText(text) });
      return;
    }
    // routing 只列出真正的 role-named 工具：取值完全来自 role 目录，没有第二条分支。
    const routingToolsText = roles.join(", ");
    // routing 只提供 provider、角色和图片路由等动态事实；完整 workflow 已在 root
    // orchestrator system section 中出现一次，避免同一等待/收口契约再次膨胀 system 输入。
    const text = [
      `Enabled expert tools: ${routingToolsText || "none"}.`,
      ...(config.enableObserver === true ? [
        "Image tasks may use observer only when the current image routing policy allows it, and observer accepts only the Host-provided durable image attachment for that task; a client file path is never a substitute. Automatic image routing follows the fixed visual-only task contract; any role tool may receive a direct image attachment when its selected model explicitly supports image; preserve durable PNG attachment boundaries. Only pass the image parameter when forwarding a real image attachment; omit it entirely otherwise and never fabricate placeholder attachment metadata.",
      ] : []),
    ].join(" ");
    routingDisposer = systemPrompt.section({ name: "dsh-expert-group:routing", order: 117, text: rootPromptText(text) });
  }

  return { refreshRoutingPrompt };
}
