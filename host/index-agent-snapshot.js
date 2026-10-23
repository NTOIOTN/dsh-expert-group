/**
 * 入口 agent/created 的专家身份解析与 child 模型快照域（R4e · 票据 19）。
 *
 * 这一域只做两件事，且都**没有注册点**：
 * 1. `resolveExpertIdentity(agent)`：解析 role/parentId/continuable 与 cold-resume 快照。
 *    优先当前 agentOptions marker；marker 缺失时从 DEG 自有 child_models 记录补全
 *    （仅当 role/parentId/continuable 三项都成立才接受，与迁移前同一判定）。
 * 2. `persistChildModel(...)`：把 child 的实际 provider/model/effort、角色显示名、
 *    admission deny/persona、实际路由元数据、subagent provider 与继承开关、结构化交付
 *    标记与 shadow 生效性快照写入 child_models（同一份 storage 串行链）。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册事件、不持容器：`ctx.on("agent/created")` 与 guard 安装仍由
 * `index.js` 的原注册点/装配 adapter 完成；本模块只返回纯读写命令。
 *
 * ## 行为等价
 * 写入字段集合、条件展开顺序、malformed 值过滤（validPersonaMarker）、cold-resume
 * 保留原值的优先级、以及 `writeChildModel().then(flushPendingStructuredPatch)` 的
 * 异步形态与迁移前逐行一致。
 *
 * @module dsh-expert-group/host/index-agent-snapshot
 */
import {
  ROLE_MARKER,
  PARENT_MARKER,
  CONTINUABLE_MARKER,
  DENY_MARKER,
  PERSONA_MARKER,
  EFFORT_MARKER,
  validPersonaMarker,
  registerPluginExpertChildAgent,
} from "./expert-guards.js";
import {
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  EXPERT_INHERIT_CONTEXT_MARKER,
  modelRouteFieldsFromRecord,
  normalizeModelRouteMarker,
} from "../shared/model-route.js";
import { OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";
import { shadowMarkerFields } from "./send-message-shadow.js";

/**
 * 创建专家身份解析与 child 模型快照能力面。
 *
 * @param {object} deps - 窄能力面（5 组）。
 * @param {object} deps.storage - settings/storage 域：`readSnapshot()`（完整快照读面）与
 *   `writeChildModel(childId, record)`（同一条串行写链）。
 * @param {object} deps.roles - 角色目录投影：`roleLabelOfRole(role)`。
 * @param {object} deps.core - 专家核心域：`validSubagentProviderName`、
 *   `flushPendingStructuredPatch(childId)`。
 * @param {object} deps.modelRoute - 模型路由域：`installFallbackOverride(agent)`（动态注册
 *   adapter 仍由组合根提供，见 index.js 的 installModelFallbackRouteOverride）。
 * @returns {object} `{ resolveExpertIdentity, persistChildModel, installFallbackRoute }`。
 */
export function createAgentSnapshotDomain({ storage, roles, core, modelRoute, guards }) {
  /**
   * 解析专家的角色身份与冷恢复快照。
   * @param {object} agent - exact Agent 对象。
   * @returns {{role: *, parentId: *, isContinuable: boolean, recordedExpert: object|undefined}}
   */
  function resolveExpertIdentity(agent) {
    let role = agent?.options?.[ROLE_MARKER];
    let parentId = agent?.options?.[PARENT_MARKER];
    // 所有专家委派统一走 continuable child：agentOptions 无条件
    // 写入 CONTINUABLE_MARKER=true，agent/created 据此持久化；重启恢复只接受
    // 带标记的 child（旧版 one-shot 与无标记记录不可 steer，恢复时忽略）。
    let isContinuable = agent?.options?.[CONTINUABLE_MARKER] === true;
    // B5：cold-resume 的专家 child 不带 marker（dsh-subagent 冷恢复只还原
    // provider/model），从持久化 childModels 快照补 role/parentId/continuable，
    // 据此补登记恢复记录并保留快照里的推理深度。
    let recordedExpert;
    if ((typeof role !== "string" || typeof parentId !== "string") && typeof agent?.id === "string") {
      const recorded = storage.readSnapshot().childModels?.[agent.id];
      if (typeof recorded?.role === "string" && typeof recorded?.parentId === "string" && recorded?.continuable === true) {
        role = recorded.role;
        parentId = recorded.parentId;
        isContinuable = true;
        recordedExpert = recorded;
      }
    }
    return { role, parentId, isContinuable, recordedExpert };
  }

  /**
   * 读取某个 child 的模型快照记录（不存在返回 undefined；不缓存、不改写）。
   * @param {string} childId - child 的 agent id。
   * @returns {object|undefined} child_models 记录。
   */
  function readChildModel(childId) {
    return storage.readSnapshot()?.childModels?.[childId];
  }

  /**
   * 持久化 child 的实际模型配置与专家元数据。
   *
   * @param {object} agent - exact Agent 对象。
   * @param {object} expert - resolveExpertIdentity 的结果加 isExpertChild 判定。
   * @param {{effort: *}} input - 已解析的显式推理深度。
   */
  function persistChildModel(agent, expert, { effort }) {
    const { role, parentId, isContinuable, recordedExpert, isExpertChild, pluginChildAuthenticated } = expert;
    const denyMarkerSnapshot = agent.options?.[DENY_MARKER] !== void 0
      ? agent.options[DENY_MARKER]
      : recordedExpert?.[DENY_MARKER];
    // persona 与 deny 同源：优先当前 marker，cold-resume 则保留 DEG 快照中的记录值，
    // 避免恢复写回把"创建时的人格"擦成当前 settings 覆盖。这里只接受通过形状校验的
    // 字符串——marker 在 durable schema 里是 string 字段，malformed 值写回会让整条
    // child_models 记录在真实 storage-domain 写入边界被拒绝（连带丢掉 provider/model）。
    const personaMarkerSnapshot = validPersonaMarker(agent.options?.[PERSONA_MARKER])
      ?? validPersonaMarker(recordedExpert?.[PERSONA_MARKER]);
    // 实际路由快照（票据 24）：优先当前 agentOptions marker；cold-resume 的 Host 不还原
    // agentOptions，因此回落到 DEG 自有 child_models 记录里的扁平字段，避免恢复写回擦除。
    const recordedRouteFields = modelRouteFieldsFromRecord(recordedExpert);
    const routeMarkerSnapshot = normalizeModelRouteMarker(agent.options?.[EXPERT_ROUTE_MARKER])
      ?? (Object.keys(recordedRouteFields).length === 0 ? undefined : recordedRouteFields);
    // 上下文继承快照（票据 29）：优先本次派发写入的 agentOptions marker；cold-resume
    // 的 Host 不还原 agentOptions，回落到 DEG 自有 child_models 记录，避免恢复写回
    // 把“该 child 是继承型”擦成普通 spawn。
    const subagentProviderSnapshot = core.validSubagentProviderName(agent.options?.[EXPERT_SUBAGENT_PROVIDER_MARKER])
      ?? core.validSubagentProviderName(recordedExpert?.subagentProvider);
    const inheritContextSnapshot = typeof agent.options?.[EXPERT_INHERIT_CONTEXT_MARKER] === "boolean"
      ? agent.options[EXPERT_INHERIT_CONTEXT_MARKER]
      : (typeof recordedExpert?.inheritContext === "boolean" ? recordedExpert.inheritContext : void 0);
    if (pluginChildAuthenticated) registerPluginExpertChildAgent(agent);
    if (isExpertChild) {
      // 该监听器在早期 guard listener 之后运行；此时 role/parentId 已从 marker、
      // cold-resume 快照或 recovery record 建立，必须再次尝试 child scoped guard。
      guards.installExpertReportGuard(agent, { role, parentId, source: recordedExpert === void 0 ? "marker" : "snapshot" });
    }
    if (typeof agent?.options?.provider === "string" && typeof agent?.options?.model === "string" && (isExpertChild || effort !== void 0)) {
      void storage.writeChildModel(agent.id, {
        provider: agent.options.provider,
        model: agent.options.model,
        reasoningEffort: effort === void 0 ? void 0 : String(effort),
        ...(isExpertChild ? {
          role,
          // 角色显示名快照：历史任务在角色不再可用时仍能显示标签。
          ...(typeof roles.roleLabelOfRole(role) === "string" ? { roleLabel: roles.roleLabelOfRole(role) } : {}),
          parentId,
          ...(isContinuable ? { continuable: true } : {}),
          // Host recovery 不持久化 RC1 agentOptions；把 admission deny 快照放入
          // DEG 自有 child_models，供 cold-resume 的 scoped guard 恢复同一边界。
          ...(denyMarkerSnapshot === void 0
            ? {}
            : { [DENY_MARKER]: Array.isArray(denyMarkerSnapshot)
              ? [...denyMarkerSnapshot]
              : denyMarkerSnapshot }),
          // 同一份 admission persona 快照：cold-resume 恢复写回不得擦除记录值；
          // malformed 值在写入前已被过滤，不会污染 durable schema。
          ...(personaMarkerSnapshot === void 0 ? {} : { [PERSONA_MARKER]: personaMarkerSnapshot }),
          // 实际路由元数据（票据 24）：与 provider/model 同层落盘，恢复/续作只读不重选。
          ...(routeMarkerSnapshot === undefined ? {} : routeMarkerSnapshot),
          // 目标 subagent provider 与继承开关（票据 29）：恢复/重建只读这两个字段，
          // 绝不按当前设置重新选择。旧记录缺失时按 spawn/false 处理。
          ...(subagentProviderSnapshot === void 0 ? {} : { subagentProvider: subagentProviderSnapshot }),
          ...(inheritContextSnapshot === void 0 ? {} : { inheritContext: inheritContextSnapshot }),
          // 结构化交付（票据 30）：只保留“声明过”的布尔与已捕获的只读结果；
          // cold-resume 不重新声明 schema，但既有结果/标记必须原样保留，不能被
          // 基础记录写回擦掉。
          ...(agent?.options?.[OUTPUT_SCHEMA_REQUESTED_MARKER] === true
            || recordedExpert?.outputSchemaRequested === true
            ? { outputSchemaRequested: true }
            : {}),
          ...(recordedExpert?.structured === undefined ? {} : { structured: recordedExpert.structured }),
          // shadow 生效性判定快照：composition 已在本监听器之前安装并判定，
          // 因此这里能写出 verified/absent 等实际结果（foreign 会让本监听器不会被执行）。
          ...shadowMarkerFields(agent.id),
        } : {}),
      }).then(() => core.flushPendingStructuredPatch(agent.id));
    }
  }

  /**
   * 为专家 child 安装运行期模型降级覆盖（动态 agent.ctx.on 注册 adapter 在组合根）。
   * @param {object} agent - exact Agent 对象。
   */
  function installFallbackRoute(agent) {
    modelRoute.installFallbackOverride(agent);
  }

  return { resolveExpertIdentity, readChildModel, persistChildModel, installFallbackRoute };
}
