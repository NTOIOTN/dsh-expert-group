/**
 * 入口宿主能力矩阵投影域（R4e · 票据 19）。
 *
 * 只读，不调用任何业务方法、不触发注册、不写入任何状态：回答"当前宿主提供了哪些
 * seam、哪些是硬依赖、哪些降级"。
 *
 * 四类状态：
 * - **硬依赖**（tools/subagents/agents/settings/webServer/systemPrompt/llm）：由插件
 *   `inject` 声明决定能否加载，这里只反映实际可达性（缺失即 unknown）；
 * - **rootTurnWait**：权威档是 `subagents.listDescendants` **加上**可调用的
 *   `agents.list()` 快照（catalog 只证明 session residency，运行判定必须交叉校验）；
 *   降级档是 `workspace/session-activity` waterfall（只能报告 activity，不能证明 quiet）；
 *   两档都无法证明静止时等待一律 fail-closed；
 * - **Connection RPC**：可选能力，缺失时回落 legacy route，无法建立通道时 fail-closed；
 * - **storageDomain / attachments / sessionQuery**：运行期硬依赖与两个可选能力。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx：waterfall 探测以 `ctxProbe.hasWaterfall()` 注入（组合根已在 try/catch 内
 * 读取未声明的 ctx 属性）；Connection 状态经 `connection.describe()` 只读投影。
 *
 * @module dsh-expert-group/host/index-capability-report
 */
import { CAPABILITY_REPORT_VERSION } from "./runtime-diagnostics.js";

/**
 * 创建宿主能力矩阵能力面。
 *
 * @param {object} deps - 窄能力面（6 组）。
 * @param {object} deps.services - 插件 `inject` 声明的宿主服务契约（同一关注点：可达性）：
 *   `tools`、`subagents`、`agents`、`settings`、`webServer`、`systemPrompt`、`llm`。
 * @param {object} deps.ctxProbe - 宿主上下文探针：`hasWaterfall()`（严格 Cordis Context 对
 *   未声明属性会抛，try/catch 由组合根持有）。
 * @param {object} deps.storage - storage 绑定诊断面：`describe()`。
 * @param {object} deps.attachments - 附件服务存在性读面：`present()`。
 * @param {object} deps.sessionQuery - sessionQuery 存在性读面：`present()`。
 * @param {object} deps.connection - Connection 通道只读状态：`describe()`。
 * @returns {{describeHostCapabilities: () => object}} 能力矩阵投影。
 */
export function createHostCapabilityReport({ services, ctxProbe, storage, attachments, sessionQuery, connection }) {
  const hardDependencyCapability = (service) => ({
    required: true,
    status: service === undefined || service === null ? "unknown" : "available",
  });

  /**
   * 宿主能力矩阵。
   *
   * - rootTurnWait 描述 root turn 等待所依赖的宿主 seam：权威档是
   *   `subagents.listDescendants` **加上**同一份 exact runtime `agents.list()` 快照
   *   （catalog 只证明 session residency；运行判定必须用 runtime Agent.status 交叉校验，
   *   并用 runtime 快照验证 live 后代已被 catalog 完整覆盖——缺任何一半都不能证明静止），
   *   降级档是 `workspace/session-activity` waterfall（只能报告 activity，不能证明
   *   quiet）。两档都无法证明静止时一律继续等待（fail-closed，绝不把未知当成无人
   *   运行）；专家派发与设置页继续可用，降级由 status/degradation 字段显式说明。
   *   因此投影是四档：
   *   1. listing + 可调用的 `agents.list()` 都在 → `available` / degradation `null`
   *      （完整 catalog 与 runtime 交叉校验，可证明静止）；
   *   2. 只有 listing（缺 runtime 快照，等待实际 fail-closed）→ `degraded` +
   *      `root-turn-wait-runtime-agent-listing-unavailable`；
   *   3. 缺完整 catalog，但 `agents.list()` 可调用（strict runtime-only fallback，仍能
   *      给出可证明的状态）或只有 waterfall（只能提供正向 running 证据）→ `degraded` +
   *      `root-turn-wait-descendant-listing-unavailable`；
   *   4. 三者都不可用 → `unavailable` + `root-turn-wait-descendant-query-unavailable`。
   * - Connection RPC 是**可选能力**：缺失时回落 legacy exact route，无法建立通道时
   *   fail-closed（legacy 拒绝并返回 503），状态与失败类别都从固定枚举取值。
   * - storageDomain 是运行期硬依赖；attachments / sessionQuery 是可选能力，缺失时
   *   只禁用图片规范化 / 冷会话精确读取。
   *
   * 只读：不调用任何业务方法、不触发注册、不写入任何状态。
   */
  function describeHostCapabilities() {
    const storageState = storage.describe();
    // root turn 等待的后代查询能力**分两档**，绝不能只把「ctx.waterfall 是函数」当成
    // provider 可用（那只能证明 Cordis 事件服务在，不能证明有任何 provider）：
    // - `available`：`subagents.listDescendants` 存在——权威、可证明「没有 running 后代」；
    // - `degraded`：只有 waterfall——它**只能报告 activity，不能证明 quiet**：
    //   唯一可用的明确结论是「确有 running 后代」（用于继续等待）；sentinel、任何
    //   空数组（含其他 listener 返回的 fresh `[]`）、无 subagent 族与 malformed 都
    //   是未知，等待继续；
    // - `unavailable`：两者都没有，等待一律 fail-closed。
    // 严格 Context 对未声明属性抛错，因此读取本身也要 fail-closed。
    let descendantListingAvailable = false;
    try {
      descendantListingAvailable = typeof services.subagents?.listDescendants === "function";
    } catch {
      descendantListingAvailable = false;
    }
    let sessionActivityAvailable = false;
    try {
      sessionActivityAvailable = ctxProbe.hasWaterfall();
    } catch {
      sessionActivityAvailable = false;
    }
    // 权威静止证明的另一半：**可调用且返回数组**的 agents.list()。只看到 listing 就报
    // available 会误报——缺 runtime 快照时等待实际 fail-closed（无法校验运行判定与覆盖
    // 关系）；可调用但返回非数组同样不能当快照用（等待侧对此也 fail-closed）。
    // 这里只做只读可用性探测：读取属性并在 try 内调用一次，绝不触发注册或写入状态。
    let runtimeAgentListingAvailable = false;
    try {
      const listAgents = services.agents?.list;
      if (typeof listAgents === "function") {
        runtimeAgentListingAvailable = Array.isArray(listAgents.call(services.agents));
      }
    } catch {
      runtimeAgentListingAvailable = false;
    }
    // Connection 通道状态由 host/index-connection-channel.js 独占，这里只读投影。
    const connectionState = connection.describe();
    const connectionStatus = connectionState.transport === "handle"
      ? "available"
      : connectionState.transport === "route"
        ? "degraded"
        : connectionState.registrationFailed === true
          ? "fail-closed"
          : connectionState.probe === "absent" ? "legacy" : "pending";
    return {
      version: CAPABILITY_REPORT_VERSION,
      // 模型候选与启动前 fallback（票据 24）：本版本始终提供保存期预检与
      // primary -> candidates 的启动前降级；客户端据此显示候选编辑器。
      modelFallback: true,
      // 上下文继承（票据 29）：本版本提供服务端角色级开关、fork provider 选择、seed
      // 边界检查、Observer 隔离、持久化与恢复；设置页继承开关与 token 成本提示属
      // 后续客户端波次。
      contextInheritance: true,
      // 结构化交付（票据 30）：本版本提供服务端 outputSchema 声明/校验/透传、
      // 结果后台捕获、回退标记、持久化与只读投影；侧栏结构化结果展示属客户端波次。
      structuredOutput: true,
      // 会话级模型覆盖（票据 21）：本版本提供 root-only 的读取 / 带代次写入 / 清除、
      // 独立代次表与设置页读取面；客户端据此显示"仅本会话"编辑区。
      sessionOverride: true,
      host: {
        // 声明于 inject 的硬依赖：缺任何一个插件都不加载（最低宿主契约）。
        tools: hardDependencyCapability(services.tools),
        subagents: hardDependencyCapability(services.subagents),
        agents: hardDependencyCapability(services.agents),
        settings: hardDependencyCapability(services.settings),
        webServer: hardDependencyCapability(services.webServer),
        systemPrompt: hardDependencyCapability(services.systemPrompt),
        llm: hardDependencyCapability(services.llm),
        // rootTurnWait：可选宿主 seam；缺失时等待判定一律 fail-closed（继续等待）。
        rootTurnWait: {
          required: false,
          status: descendantListingAvailable && runtimeAgentListingAvailable
            ? "available"
            : descendantListingAvailable || runtimeAgentListingAvailable || sessionActivityAvailable
              ? "degraded"
              : "unavailable",
          degradation: descendantListingAvailable && runtimeAgentListingAvailable
            ? null
            : descendantListingAvailable
              // 完整 catalog 在、runtime 快照不可用：等待 fail-closed，诊断必须如实降级。
              ? "root-turn-wait-runtime-agent-listing-unavailable"
              : runtimeAgentListingAvailable || sessionActivityAvailable
                // 缺完整 catalog，但仍有可证明的查询路径：strict runtime-only fallback
                // （agents.list() + 严格血缘/状态校验）或 waterfall-only（只能正向 running）。
                ? "root-turn-wait-descendant-listing-unavailable"
                : "root-turn-wait-descendant-query-unavailable",
        },
        // Connection RPC：可选能力，缺失时回落 legacy route。
        connectionRpc: {
          required: false,
          status: connectionStatus,
          probe: connectionState.probe,
          transport: connectionState.transport,
          failure: connectionState.failure,
        },
        storageDomain: {
          required: true,
          status: storageState.hasBinding === true ? "available" : "pending",
          binding: typeof storageState.status === "string" ? storageState.status : "none",
        },
        attachments: {
          required: false,
          status: attachments.present() === false ? "absent" : "available",
          degradation: attachments.present() === false ? "image-normalization-disabled" : null,
        },
        sessionQuery: {
          required: false,
          status: sessionQuery.present() === false ? "absent" : "available",
          degradation: sessionQuery.present() === false ? "cold-session-read-disabled" : null,
        },
      },
    };
  }

  return { describeHostCapabilities };
}
