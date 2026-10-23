/**
 * 入口工具面装配域（R4d · 票据 18）：fanout 工具定义 + routing/orchestrator 提示词。
 *
 * 这一域负责“工具面与提示词跟随 provider 与角色目录”的部分：
 * - fanout 通用工具的定义对象（role 由参数选择，与 role-named 工具共享 provider 能力检测）；
 * - routing / orchestrator system section 的**动态重建**（provider 不可用时如实声明不可用）。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**：`ctx.effect(() => tools.register(...))` 与 `systemPrompt.section`
 * 的调用点仍在 `index.js` 的原注册点（装配 adapter 只做时机与顺序）。`refreshRoutingPrompt`
 * 通过注入的 `section` 命令创建/释放 section，disposer 仍归入口 effect 树所有。
 *
 * ## 状态唯一 owner
 * 本模块不持有容器：fanout 工具的 disposer 由 role 挂载表（`toolMount`）持有；
 * 提示词 disposer 以返回句柄的形式交回入口（`refreshRoutingPrompt` 返回值），
 * 入口继续用原来的路由/编排 disposer 变量保存。
 *
 * @module dsh-expert-group/index-expert-tools-surface
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildOrchestratorPrompt, isRootAgentContext } from "../orchestrator.js";
import { createAbortError } from "./rpc-request-lifecycle.js";
import { OUTPUT_SCHEMA_ERROR_CODES } from "../shared/structured.js";

/**
 * fanout 通用工具定义与挂载（role 由参数选择，单入口）。
 *
 * @param {object} deps - 窄能力面（6 组：commands / models / identity / core / roles / toolMount）。
 * @returns {object} 挂载能力面。
 */
export function createFanoutToolSurface({ commands, models, identity, core, roles, toolMount }) {
  /**
   * 通用 fan-out 工具只注册一个入口，role 由参数选择；它与旧的 role-named 工具
   * 共享 provider 能力检测，但不进入 delegationTracker 的单 child 去重路径。
   */
  function buildFanoutDefinition() {
    return defineTool({
      name: "fanout",
      description: "向一个专用 role 提交多个独立 shard 的 fan-out 任务；原子校验、per-role 并发、wait-all、取消与手工重试由 Host 管理，调用立即返回 parentTaskId。"
        + "同一逻辑任务需要多轮续作（例如按上一轮结果继续修）时，不要重复提交新任务：带 continuation.parentTaskId 再调用本工具即可复用同一个父任务与同一批 child，"
        + "每个分片会新增一个 attempt（保留原 childId、保留历史 attempt），提交后父任务立即回到 running，本轮全部分片结束后回到 ready 并可继续下一轮。"
        + "工具回执里的 continuation 字段给出 parentTaskId/shardId/childId/attempt/父级状态/reusable 以及下一轮调用所需字段。"
        + "可选 timeoutMs：顶层是父任务默认超时、分片内的 timeoutMs 可覆盖它，0 表示显式禁用、省略则交给角色默认值（设置页 roleTimeoutMs）；"
        + "启用值为 1000–86400000 毫秒且必须是 1000 的整数倍（精度 1 秒），超时只影响之后创建的 attempt。"
        + "容量已满时，宿主可按 RPC fanout-reclaim（sessionId + parentTaskIds）回收本 root 已结算的父任务；"
        + "回收不保留任务墓碑，针对已回收 parentTaskId 的查询返回 task_not_found；"
        + "回收后同一 requestId 再提交视为新任务（旧幂等记录随任务删除），不会命中旧任务句柄。",
      parameters: {
        // 枚举与运行时校验同源（内置角色目录），不会出现"枚举里有但校验拒绝"。
        role: { type: "string", enum: roles.activeRoles(), required: true, description: "One enabled expert role shared by all shards. 复用时必须与原任务的 role 一致。" },
        basePrompt: { type: "string", required: true, description: "Shared public goal delivered to every shard child. 复用时它是**本轮**的共享目标。" },
        shards: {
          type: "array",
          required: true,
          description: "Ordered non-empty shard list; every item needs a unique shardId and prompt. Optional name is the human-readable shard task name shown after the shard id in the Expert Group sidebar (shard id stays the stable key for cancel/retry). 复用时必须与原任务的分片数量与 shardId 结构完全一致，prompt 是本轮该分片的指令。",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              shardId: { type: "string", required: true },
              name: {
                type: "string",
                description: "Optional human-readable shard task name, e.g. 实现添加任务名称. Trimmed, non-blank and at most 256 UTF-8 bytes; omitted names fall back to shardId in the sidebar.",
              },
              prompt: { type: "string", required: true },
              outputSchema: {
                type: "object",
                additionalProperties: true,
                description: "Optional structured-output JSON Schema for this shard (object root, dsh-tools enforced subset). Validated before dispatch: an invalid schema, >64KiB UTF-8, or a provider without outputSchema capability rejects the whole fan-out and creates no child. In-process retries reuse the same schema; after cold restore the schema is not restored and that round is marked schema_not_restored. The schema is never written to task snapshots or event history.",
              },
              affectedPaths: { type: "array", items: { type: "string" } },
              // 分片级超时覆盖（票据 06）：0 = 显式禁用；启用值 1000–86400000 毫秒且为
              // 1000 的整数倍。优先于父任务级默认值与角色级设置默认值。
              timeoutMs: {
                type: "integer",
                description: "Optional per-shard timeout override in milliseconds: 0 disables the timeout for this shard; enabled values are 1000–86400000 and must be multiples of 1000 (1-second precision). It overrides the task-level timeoutMs and the per-role settings default (roleTimeoutMs). The timer starts when an attempt enters running and settles that latest attempt as timed_out, which can be retried by hand but is never retried automatically. Only attempts created after this call are affected; running shards are never changed.",
              },
            },
          },
        },
        continuation: {
          type: "object",
          additionalProperties: false,
          description: "可选：把本次调用作为**同一逻辑 fan-out 任务的下一轮续作**。给出上一轮回执里的 parentTaskId，并用 role/basePrompt/shards 描述本轮指令；role 与 shardId 结构必须与原任务一致。要求上一轮 wait-all 已完成（回执 continuation.reusable=true）。",
          properties: {
            parentTaskId: { type: "string", required: true, description: "上一轮回执里的 parentTaskId（必须属于当前 root）。" },
            requestId: { type: "string", description: "可选幂等键：同一 requestId 的重复续作不会重复追加 attempt。" },
          },
        },
        requestId: { type: "string", description: "Optional idempotency key for a new task (ignored when continuation is present; use continuation.requestId there)." },
        allowOverlap: { type: "boolean", default: false, description: "Explicitly allow write-role affectedPaths overlap." },
        concurrencyLimit: {
          type: "integer",
          description: "Optional per-task running-child limit from 1 to 64, counted against this task's own running shards only. Dispatch requires BOTH this task-level limit AND the per-role shared pool (settings roleConcurrencyLimit, current value, plugin default 20) to allow the shard; the two caps are enforced independently. The per-role pool is a shared cap for the whole role and follows the current setting, so it may grow or shrink for later dispatches; a task-level value is frozen into the task snapshot and survives restore.",
        },
        // 父任务默认超时（票据 06）：与分片级同一校验语义，可被分片覆盖。
        timeoutMs: {
          type: "integer",
          description: "Optional default shard timeout in milliseconds for this parent task: 0 disables it; enabled values are 1000–86400000 and must be multiples of 1000 (1-second precision). A shard-level timeoutMs overrides this value, and the per-role settings default (roleTimeoutMs) applies only when neither is set. The timer starts when an attempt enters running; a timeout settles the latest attempt as timed_out (retryable by hand, never auto-retried). It applies only to attempts created after this call and never changes running shards; omitted values keep the existing task default on continuation.",
        },
      },
      output: {
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: { type: "string", const: "fanout", required: true },
            accepted: { type: "boolean", required: true },
            parentTaskId: { type: "string", required: true },
            role: { type: "string", required: true },
            status: { type: "string", required: true },
            duplicate: { type: "boolean" },
            reopened: { type: "boolean" },
            round: { type: "integer" },
            shardIds: { type: "array", items: { type: "string" }, required: true },
            // continuation 句柄：parentTaskId/shardId/childId/attempt/父级状态/reusable 与
            // 下一轮调用字段；内容随状态机扩展，这里允许额外字段。
            continuation: { type: "object", additionalProperties: true },
            // task 是 manager 的只读快照，字段随状态机版本扩展；这里明确允许额外字段。
            task: { type: "object", additionalProperties: true },
          },
        },
        render(_args, value) {
          const continuation = value?.continuation;
          const suffix = continuation === undefined
            ? ""
            : "; continuation: round " + continuation.round + " " + (continuation.running ? "running" : "ready")
              + ", reusable=" + (continuation.reusable === true)
              + ", nextAttemptByShard=" + JSON.stringify(continuation.nextAttemptByShard ?? {});
          const verb = value?.reopened === true ? " continued" : " accepted";
          return [{
            type: "text",
            text: "fan-out " + value.parentTaskId + verb + " (" + value.status + "); shards: "
              + (value.shardIds ?? []).join(", ") + suffix,
          }];
        },
      },
      async execute(args, exec) {
        const parent = exec?.agent;
        if (parent === void 0) throw new Error("fanout tool requires a calling root agent");
        if (parent.session?.header?.parentSession !== void 0) throw new Error("fanout is root-only; child agents cannot create fan-out tasks");
        if (!identity.isLiveGeneration(parent, identity.tokenFor(parent))) throw new Error("root generation is no longer live");
        if (!core.spawnProviderReady()) throw new Error("subagent provider spawn is not ready");
        const role = typeof args?.role === "string" ? args.role.trim() : "";
        if (!roles.isActiveRole(role)) throw new Error("未启用的 fan-out role: " + role);

        // 多轮复用：复用判定由主代理发起，插件负责校验 + 执行 + 回执。复用时不再解析模型
        // （不新建 child），但仍要求 role 属于当前启用的 role 集合，避免对被禁用的 role 续作。
        const continuation = args?.continuation;
        if (continuation !== void 0 && continuation !== null) {
          if (typeof continuation !== "object" || Array.isArray(continuation)) {
            throw new Error("continuation 必须是对象（{ parentTaskId, requestId? }）");
          }
          const parentTaskId = typeof continuation.parentTaskId === "string" ? continuation.parentTaskId.trim() : "";
          if (parentTaskId.length === 0) throw new Error("continuation.parentTaskId 必须是非空字符串");
          // 结构化声明只能存在于一次新的 activation 上；多轮续作把 prompt 投递给既有
          // child（不新建 activation），宿主不会重新建立结构化契约。显式拒绝比静默
          // 忽略 schema 更安全，也保持“绝不静默退文本”的边界。
          if (Array.isArray(args?.shards) && args.shards.some((shard) => shard?.outputSchema !== undefined)) {
            throw core.outputSchemaError(
              OUTPUT_SCHEMA_ERROR_CODES.UNSUPPORTED,
              "fan-out continuation 不能重新声明 outputSchema：续作复用既有 child，宿主不会为新消息建立结构化契约",
            );
          }
          if (exec?.signal?.aborted === true) throw createAbortError();
          const result = commands.continueFanoutTask(parent, {
            parentTaskId,
            role,
            basePrompt: args?.basePrompt,
            shards: args?.shards,
            // 超时（票据 06）：本轮显式给出的父任务默认值覆盖任务级默认；
            // 省略时沿用旧值，且只影响本轮之后创建的 attempt。
            timeoutMs: args?.timeoutMs,
            requestId: continuation.requestId,
          });
          const continuationHandle = commands.buildFanoutContinuationHandle(result.task);
          return {
            kind: "fanout",
            accepted: true,
            parentTaskId: result.parentTaskId,
            role: result.role,
            status: result.status,
            reopened: true,
            // 幂等命中：同一 requestId 的重复续作不追加 attempt，回执显式标注 duplicate，
            // 让主代理知道这一轮已经提交过（避免误以为又开了一轮）。
            ...(result.duplicate === true ? { duplicate: true } : {}),
            ...(Number.isSafeInteger(result.round) ? { round: result.round } : {}),
            shardIds: result.shardIds,
            ...(continuationHandle === void 0 ? {} : { continuation: continuationHandle }),
            task: result.task,
          };
        }

        // 提交前的快速预检（票据 24）：与分片 buildRequest 共用同一套路由计划，
        // 因此 primary 失效但候选可用时，任务仍能提交并由各分片走同一 fallback。
        const precheckRoute = await models.resolveRoleModelRoute(role, parent.id, exec?.signal);
        if (precheckRoute === null) throw new Error(role + " 专家尚未配置模型");
        if (exec?.signal?.aborted === true) throw createAbortError();
        const result = commands.submitFanoutTask(parent, { ...args, role }, precheckRoute);
        const continuationHandle = commands.buildFanoutContinuationHandle(result.task);
        return {
          kind: "fanout",
          accepted: true,
          parentTaskId: result.parentTaskId,
          role: result.role,
          status: result.status,
          ...(result.duplicate === true ? { duplicate: true } : {}),
          ...(Number.isSafeInteger(result.task?.round) ? { round: result.task.round } : {}),
          shardIds: result.shardIds,
          ...(continuationHandle === void 0 ? {} : { continuation: continuationHandle }),
          task: result.task,
        };
      },
    });
  }

  /**
   * 挂载前置判定：已挂载或 provider 未就绪时返回 null（不制造空工具）。
   *
   * @returns {{definition: object, label: string}|null} 已构造的定义对象。
   */
  function prepareFanoutMount() {
    if (toolMount.isMounted("fanout") || !core.spawnProviderReady()) return null;
    return { definition: buildFanoutDefinition(), label: "dsh-expert-group: tool fanout" };
  }

  /** 注册成功后回填 disposer（调用点在 index.js 的 effect 之后）。 */
  function commitFanoutMount(disposeTool) {
    toolMount.commitMount("fanout", disposeTool);
  }

  function unmountFanoutTool() {
    if (!toolMount.isMounted("fanout")) return;
    toolMount.release("fanout");
  }


  return { prepareFanoutMount, commitFanoutMount, unmountFanoutTool };
}

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
      try { routingDisposer(); } catch {}
      routingDisposer = void 0;
    }
    if (orchestratorDisposer !== void 0) {
      try { orchestratorDisposer(); } catch {}
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
    // 保留旧 routing 的稳定 role 列表，并在独立字段中追加通用 fanout 能力。
    const toolsText = roles.map((role) => `${role}`).join(", ");
    const routingToolsText = [...roles, "fanout"].join(", ");
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
