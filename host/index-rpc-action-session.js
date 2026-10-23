/**
 * RPC action 会话域（R4f · 票据 20）——需要会话上下文的 7 个 action。
 *
 * 与核心模块的分工：
 * - 本模块只持有「先解析 sessionId/agent/recorded/isChild，再按 action 分支」的会话域 handler；
 * - 响应 envelope（send/fail）与错误映射由 host/index-rpc-action-core.js 的共享适配器唯一提供，
 *   本模块**不复制**，只从 per-request 的 { send, fail } 窄面消费；
 * - 因此两个模块之间没有 import 边（组合根把本模块的 routes/resolveSession 交给核心模块），
 *   既保证适配器只有一份，也不会产生 ESM 环。
 *
 * 依赖形状：deps 按协作方分 4 组（services / reads / storage / models）；不接收 ctx。
 * 注册点、register 顺序与 disposer 顺序一律仍留在 index.js（票据 20 铁律 1/2）。
 */
import { EFFORT_MARKER, ROLE_MARKER } from "./expert-guards.js";
import { SettingsDirectoryChangedError } from "./settings-runtime.js";
import { SETTINGS_NAMESPACE } from "./settings-schema.js";
import { hasUsageMetrics, projectUsage } from "./usage-projection.js";
import { EXPERT_ROUTE_MARKER, MAX_MODEL_CANDIDATES_PER_ROLE, MODEL_ROUTE_NOT_CONFIGURED, modelRouteErrorMessage, modelRouteFieldsFromRecord, persistedModelRouteIsAuthoritative } from "../shared/model-route.js";
import { PROMPT_OVERRIDES_SETTINGS_KEY, promptOverrideFor } from "../shared/prompts.js";
import { projectStructuredResult } from "../shared/structured.js";
import { persistDomainEntry, removeDomainEntry } from "../storage.js";

/**
 * 会话域 action → handler 的显式分发表（与核心模块的分发表互补，无重叠、无前缀匹配）。
 * 顺序与迁移前源码顺序一致：notification-snapshot → get → session-override-* →
 * model-preflight → commit。
 */
const SESSION_ROUTES = [
  ["notification-snapshot", handleNotificationSnapshot],
  ["get", handleGet],
  ["session-override-get", handleSessionOverrideGet],
  ["session-override-set", handleSessionOverrideSet],
  ["session-override-clear", handleSessionOverrideSet],
  ["model-preflight", handleModelPreflight],
  ["commit", handleCommit],
];

/**
 * 组合根装配面：交出**已绑定本模块 deps** 的分发表与会话上下文解析命令（不把 deps 交给外部）。
 *
 * 绑定发生在工厂内：核心模块只拿到 { action -> (req) => Promise } 的窄面，既不需要知道
 * 会话域的依赖形状，也不可能把共享适配器复制一份 —— envelope 仍通过 req.send/req.fail 传入。
 */
export function createIndexRpcActionSession(deps) {
  return {
    routes: new Map(SESSION_ROUTES.map(([action, run]) => [action, (req) => run(deps, req)])),
    resolveSession: (body, fail) => resolveSessionRequest(deps, body, fail),
  };
}

/**
 * 会话上下文前置解析（原始源行归属 2955–2966）：
 * 返回 { sessionId, agent, recorded, isChild }；缺 sessionId 时已写出 400 回执并返回 undefined。
 *
 * 子代理判定优先级（逐条与迁移前一致）：
 * 1. 客户端提示（来自 sessions 列表的 parentId/origin，可靠且与 agent 是否在线无关）；
 * 2. 在线 agent 的会话头；
 * 3. 持久化的 childModels 记录（子代理已结束后仍能识别）。
 */
function resolveSessionRequest(deps, body, fail) {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (sessionId.length === 0) { fail(400, "bad-request", "缺少 sessionId"); return void 0; }
  const agent = deps.services.agents.get(sessionId);
  const childHint = body.childHint === true;
  const liveChild = agent?.session?.header?.origin === "subagent" || agent?.session?.header?.parentSession !== void 0;
  const recorded = deps.reads.source().childModels?.[sessionId];
  const isChild = childHint || liveChild || recorded !== void 0;
  return { sessionId, agent, recorded, isChild };
}

/**
 * 「notification-snapshot」 的 handler（原始源行归属 2968–2988）。
 */
async function handleNotificationSnapshot(deps, req) {
  const { describeRolePrompts, notificationHost, rootGenerationRegistry, settingsSource } = deps.reads;
  const { body, send, fail, sessionId, isChild } = req;

  if (body.action === "notification-snapshot") {
    // 终止快照按 root session 隔离；child 无论在线与否都不能读取父会话的权威状态。
    if (isChild) { fail(400, "bad-request", "notification-snapshot 只能查询根会话"); return; }
    // 只读动作：不接受 after/cursor 之类的轮询参数，读取结果与"上次读到哪"无关，
    // 因此客户端轮询频率不会影响投递正确性（快照一直保留到新 run 或 root dispose）。
    const view = notificationHost.snapshotOf(sessionId);
    // 只读提示词投影与 meta / get / settings-commit 同源：同一个 describeRolePrompts
    // 作用在同一份归一 settings 快照上，因此六角色默认 persona、覆盖与"已自定义"
    // 结论完全一致，客户端不必再发一次 meta 往返，也不会按缺失字段自行退化。
    // 这里刻意只读 settingsSource()：通知轮询每 2 秒一次，投影只描述配置、
    // 与"谁在运行"无关，不需要为它读 storage domain 的全量快照。
    send(200, {
      ok: true,
      rootId: sessionId,
      rootGeneration: rootGenerationRegistry.generationOf(sessionId) ?? null,
      runSeq: view.runSeq,
      snapshot: view.snapshot,
      rolePrompts: describeRolePrompts(settingsSource()),
    });
    return;
  }
}

/**
 * 「get」 的 handler（原始源行归属 2990–3106）。
 */
async function handleGet(deps, req) {
  const {
    activeRoles, describeRolePrompts, roleCatalog, roleLabelsProjection, routeFieldsOfMarker,
    sessionOverrideProjectionOf, source, usageFor, usageSummaryFor
  } = deps.reads;
  // config 在外层被子分支的 `const config = header?.config` 遮蔽：这里先解构「全局配置」，
  // 子分支仍按原语义使用请求头里的 config（块级遮蔽与迁移前完全一致）。
  const { config } = deps.services;
  const { body, send, sessionId, agent, recorded, isChild } = req;

  if (body.action === "get") {
    if (isChild) {
      // 优先在线 agent 的实际请求头，其次在线 agent 的 options，
      // 最后落到持久化记录——保证子代理结束后仍能显示当时使用的模型与思考深度。
      //
      // 例外（运行期降级）：持久化记录带**实际路由快照**（candidateIndex/
      // fallbackCount 与 provider/model）时，provider/model/effort 必须整体取
      // 同一份快照。运行期降级只改 child_models、绝不改 agent.options，请求头也
      // 只在下一次请求后才更新；混用会让详情页短暂显示「候选索引 + 主模型 + 旧
      // effort」，而删掉的 effort 又会从 header/options 里被读回来。
      const header = agent?.session?.requestHeader?.();
      const config = header?.config;
      const persistedRouteAuthoritative = persistedModelRouteIsAuthoritative(recorded);
      send(200, {
        ok: true,
        kind: "child",
        child: {
          provider: persistedRouteAuthoritative
            ? recorded.provider
            : config?.provider ?? agent?.options?.provider ?? recorded?.provider ?? "",
          model: persistedRouteAuthoritative
            ? recorded.model
            : config?.model ?? agent?.options?.model ?? recorded?.model ?? "",
          reasoningEffort: persistedRouteAuthoritative
            ? recorded?.reasoningEffort
            : config?.reasoningEffort ?? agent?.options?.[EFFORT_MARKER] ?? recorded?.reasoningEffort,
          // 子代理角色：优先在线 agent 的 options marker，其次持久化记录；
          // 缺失时留空（客户端隐藏角色前缀，显示与旧版一致）。
          role: agent?.options?.[ROLE_MARKER] ?? recorded?.role,
          // 实际路由（票据 24）：只回传确实记录过的字段；缺失时省略而不是伪造 0。
          // 持久化记录是**运行期**权威：运行期降级只更新 child_models（绝不改
          // agent.options），因此 recorded 必须覆盖 admission marker，marker 只在
          // 持久化字段缺失（写入尚未落地/旧记录）时补齐。
          ...(() => {
            const persistedRoute = modelRouteFieldsFromRecord(recorded);
            if (Object.keys(persistedRoute).length > 0) return persistedRoute;
            return routeFieldsOfMarker(agent?.options?.[EXPERT_ROUTE_MARKER]);
          })(),
          // 用量（票据 25）：live 账本优先（去抖窗口内也最新），其次 child_models.usage；
          // 缺失为 null，客户端据此显示“用量不可用”，绝不显示 0 成本。
          usage: (() => {
            const live = usageFor(sessionId);
            if (live !== null) return live;
            const stored = projectUsage(recorded?.usage);
            return stored !== null && hasUsageMetrics(stored) ? stored : null;
          })(),
          // 结构化交付（票据 30）：只读结果；缺失为 null，不伪造回退标记。
          // schema 原文永不回传，只有是否声明过与最终结果本身。
          structured: projectStructuredResult(recorded?.structured),
          ...(recorded?.outputSchemaRequested === true ? { outputSchemaRequested: true } : {}),
        },
      });
      return;
    }
    // 根会话：返回角色/全局默认/会话覆盖，不依赖 agent 是否已恢复——消除
    // 重启后“会话不存在或尚未恢复”的开机竞态。
    const snap = source();
    const roles = activeRoles();
    const defaults = {};
    const overrides = {};
    const candidates = {};
    for (const role of roles) {
      defaults[role] = snap.defaults?.[role] ?? null;
      overrides[role] = snap.sessionOverrides?.[sessionId]?.[role] ?? null;
      // 候选是全局配置：会话覆盖只替换 primary，不改变这里的列表。
      candidates[role] = snap.candidates?.[role] ?? [];
    }
    // 全局提示词覆盖与角色模型配置同源：都来自 settings，与会话无关，
    // 因此这里只返回已保存的有效覆盖（缺失键表示该角色跟随默认 persona）。
    const promptOverrides = {};
    // 内置角色目录：只投影已保存的有效提示词覆盖。
    for (const entry of roleCatalog().records()) {
      const value = promptOverrideFor(snap[PROMPT_OVERRIDES_SETTINGS_KEY], entry.id);
      if (value !== void 0) promptOverrides[entry.id] = value;
    }
    // 主代理实际生效的模型元数据：只取在线 agent 的真实请求头/options，
    // 与 child 分支同源同口径；agent 不在线或字段缺失时留空字段，由
    // 客户端静默隐藏——绝不用 defaults/overrides 猜测当前主模型，那只是
    // 角色配置，不是实际生效值。
    const rootHeader = agent?.session?.requestHeader?.();
    const rootConfig = rootHeader?.config;
    send(200, {
      ok: true,
      kind: "root",
      roles, defaults, overrides,
      // 会话级覆盖代次（票据 21）：设置页打开/保存时以它做 CAS 栅栏；旧客户端
      // 忽略该未知字段，旧 Host 更不会出现它，客户端缺字段时按"不支持"降级。
      overrideRevision: sessionOverrideProjectionOf(snap, sessionId).revision,
      roleLabels: roleLabelsProjection(),
      // 模型候选读取面（票据 24）：有序数组 + 自动降级上限；非法读取值已在
      // normalizeSnapshot 里回退为空/默认 2，客户端无需再容错。
      candidates,
      fallbackLimit: snap.fallbackLimit,
      // 并发映射（票据 26）：与 meta 同源的归一值；设置页读取面据此渲染
      // 逐角色/provider 编辑面（UI 属客户端波次），旧客户端忽略未知字段。
      roleLimits: snap.roleLimits ?? {},
      providerLimits: snap.providerLimits ?? {},
      // 上下文继承（票据 29）：与 meta 同源的归一映射；设置页读取面据此渲染开关
      // （UI 属客户端波次），旧客户端忽略未知字段。
      inheritContext: snap.inheritContext ?? {},
      // 单价（票据 25）：与 meta 同源的归一原始单价；设置页据此编辑每百万 token 价格。
      modelPrices: Array.isArray(snap.modelPrices) ? snap.modelPrices : [],
      rolePrompts: describeRolePrompts(snap),
      promptOverrides,
      // 当前 root 的用量摘要（票据 25）：按 child_models.parentId 限定，最多 16 个最近任务。
      usageSummary: usageSummaryFor(sessionId),
      provider: snap.provider ?? "",
      enableObserver: config.enableObserver === true,
      observerPreferred: snap.observerPreferred === true,
      agent: {
        provider: rootConfig?.provider ?? agent?.options?.provider ?? "",
        model: rootConfig?.model ?? agent?.options?.model ?? "",
        reasoningEffort: rootConfig?.reasoningEffort ?? agent?.options?.[EFFORT_MARKER],
      },
    });
    return;
  }
}

/**
 * 「session-override-get」 的 handler（原始源行归属 3118–3127）。
 */
async function handleSessionOverrideGet(deps, req) {
  const { fanoutRpcRootSession, sessionOverrideProjectionOf, source } = deps.reads;
  const { body, send, fail, sessionId, isChild } = req;

  if (body.action === "session-override-get") {
    if (isChild) { fail(404, "session-not-found", "根会话不存在或尚未恢复"); return; }
    const snap = source();
    const view = sessionOverrideProjectionOf(snap, sessionId);
    // live 用现有 exact root/live 判定（与 fan-out 读根解析同一入口）：agent 在线、
    // 且不是任何父会话的子代理。离线时仍返回持久化覆盖，供设置页只读展示。
    const live = fanoutRpcRootSession(sessionId) !== void 0;
    send(200, { ok: true, sessionId, overrides: view.overrides, revision: view.revision, live });
    return;
  }
}

/**
 * 「session-override-set」 / 「session-override-clear」 的 handler（原始源行归属 3128–3244）。
 */
async function handleSessionOverrideSet(deps, req) {
  const { sessionOverrideConflictError, validateSelectionWithSignal } = deps.models;
  const { fanoutRpcRootSession, isActiveRole, sessionOverrideProjectionOf, source } = deps.reads;
  const { enqueueWrite, host, observeStorageWrite, storageBinding } = deps.storage;
  const { body, signal, send, fail, sessionId, isChild } = req;

  if (body.action === "session-override-set" || body.action === "session-override-clear") {
    const clearOnly = body.action === "session-override-clear";
    if (isChild) { fail(400, "read-only", "子代理会话只读，不能修改会话级模型覆盖"); return; }
    // 写入必须由 live root 发起：离线会话的覆盖无法证明归属于当前调用方，
    // 且客户端本就应按只读处理；这里再 fail-closed 一次。
    if (fanoutRpcRootSession(sessionId) === void 0) {
      fail(404, "session-not-found", "会话不存在或尚未恢复");
      return;
    }
    const expectedRevision = body.expectedRevision;
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      fail(400, "bad-request", "expectedRevision 无效");
      return;
    }
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (!isActiveRole(role)) { fail(400, "invalid-role", "未启用的角色: " + role); return; }
    /**
     * 选择校验在写临界区之外完成（与既有 session commit 一致）：目录解析可能是
     * 异步的，放进临界区只会拉长串行链；非法模型因此不会产生任何 domain 写入。
     * reasoningEffort 的显式性由 validateSelectionWithSignal 保持：未传就仍是未指定。
     */
    let selection;
    if (!clearOnly) {
      selection = await validateSelectionWithSignal(body.selection, signal);
    }
    await enqueueWrite(async () => {
      const binding = host.storage.active();
      if (binding?.sessionAuthoritative !== true
        || binding?.sessionOverrideMetaAuthoritative !== true
        || binding.sessionOverrideMetaTable === void 0) {
        throw new Error("storage domain is not ready for session override write");
      }
      if (!storageBinding.isCurrent(binding)) throw new Error("storage domain binding was replaced");
      // CAS 读与写必须落在同一个串行临界区：前一批写完成后这里才是权威代次。
      const current = source();
      const view = sessionOverrideProjectionOf(current, sessionId);
      if (view.revision !== expectedRevision) {
        throw sessionOverrideConflictError(view.revision, view.overrides);
      }
      const next = { ...(current.sessionOverrides?.[sessionId] ?? {}) };
      if (clearOnly) delete next[role];
      else next[role] = selection;
      const nextRevision = view.revision + 1;
      const isCurrent = () => storageBinding.isCurrent(binding);
      /**
       * 先写代次、再写内容：反过来的话，内容成功而代次失败会留下"覆盖已变但
       * revision 未前进"的状态，下一个持旧代次的写入会静默覆盖这次结果。
       * 内容写失败时尽力把代次回滚到旧值（回滚失败也只会多一次冲突提示，
       * 不会造成丢失更新）。
       */
      const metaWrite = await persistDomainEntry({
        table: binding.sessionOverrideMetaTable,
        key: sessionId,
        value: { revision: nextRevision },
        isCurrent,
      });
      if (metaWrite.detached) {
        // binding 在代次写入后被替换：不再写内容，让调用方显式重试。
        const detached = new Error("storage domain binding was replaced");
        detached.code = "PERSISTENCE_GENERATION_STALE";
        detached.category = "generation-stale";
        throw detached;
      }
      try {
        if (Object.keys(next).length > 0) {
          const result = await persistDomainEntry({
            table: binding.sessionTable,
            key: sessionId,
            value: next,
            isCurrent,
          });
          if (result.detached) {
            const detached = new Error("storage domain binding was replaced");
            detached.code = "PERSISTENCE_GENERATION_STALE";
            detached.category = "generation-stale";
            throw detached;
          }
        } else {
          // 清掉最后一个角色后删除整行：读取面继续把"没有覆盖"表达为缺行，
          // 旧读者看到的形状与从未写过完全一致（不留下空对象）。
          const removed = await removeDomainEntry({ table: binding.sessionTable, key: sessionId, isCurrent });
          if (removed.detached) {
            const detached = new Error("storage domain binding was replaced");
            detached.code = "PERSISTENCE_GENERATION_STALE";
            detached.category = "generation-stale";
            throw detached;
          }
        }
      } catch (error) {
        // 内容写失败：尽力回滚代次，避免"内容没变、代次却前进"的无谓冲突。
        try {
          await persistDomainEntry({
            table: binding.sessionOverrideMetaTable,
            key: sessionId,
            value: { revision: view.revision },
            isCurrent,
          });
        } catch { /* 回滚是尽力而为：失败也只是多一次可重试的冲突提示。 */ }
        throw error;
      }
    }).then(() => {
      observeStorageWrite(true, void 0, "session_overrides");
    }, (error) => {
      // 冲突不是存储故障：只在真正的写入失败上记录健康状态。
      if (error?.code !== "SESSION_OVERRIDE_CONFLICT") observeStorageWrite(false, error, "session_overrides");
      throw error;
    });
    const view = sessionOverrideProjectionOf(source(), sessionId);
    send(200, {
      ok: true,
      sessionId,
      overrides: view.overrides,
      revision: view.revision,
      live: true,
    });
    return;
  }
}

/**
 * 「model-preflight」 的 handler（原始源行归属 3246–3291）。
 */
async function handleModelPreflight(deps, req) {
  const { candidateSelectionsOfRole, isActiveRole, preflightSelectionEntry, source } = deps.reads;
  const { body, signal, send, fail, isChild } = req;

  if (body.action === "model-preflight") {
    // root-only 只读预检（票据 24）：返回 primary 与每个候选的真实可用性。
    // 不创建 child、不写 settings、不发起模型请求；只调用 validateSelectionWithSignal
    // （目录/凭据/能力解析）并复用同一错误分类。
    if (isChild) { fail(400, "read-only", "model-preflight 只能查询根会话"); return; }
    const role = typeof body.role === "string" ? body.role.trim() : "";
    if (!isActiveRole(role)) { fail(400, "invalid-role", "未启用的角色: " + role); return; }
    const snap = source();
    const primarySelection = snap.defaults?.[role];
    const primary = primarySelection === undefined || primarySelection === null
      ? {
        provider: "",
        model: "",
        reasoningEffort: null,
        ok: false,
        code: MODEL_ROUTE_NOT_CONFIGURED,
        message: modelRouteErrorMessage(MODEL_ROUTE_NOT_CONFIGURED),
        // 没有主选择就没有可探测的目标：保持与 preflightSelectionEntry 同形状。
        inputModalities: [],
        image: "unknown",
      }
      : await preflightSelectionEntry(primarySelection, signal);
    let candidateSelections;
    if (body.candidates !== void 0) {
      if (!Array.isArray(body.candidates)) { fail(400, "bad-request", "candidates 必须是数组"); return; }
      if (body.candidates.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
        fail(400, "bad-request", "候选最多 " + MAX_MODEL_CANDIDATES_PER_ROLE + " 个");
        return;
      }
      candidateSelections = body.candidates;
    } else {
      candidateSelections = candidateSelectionsOfRole(role);
    }
    const candidates = [];
    for (const selection of candidateSelections) {
      candidates.push(await preflightSelectionEntry(selection, signal));
    }
    send(200, {
      ok: true,
      role,
      primary,
      candidates,
      fallbackLimit: snap.fallbackLimit,
    });
    return;
  }
}

/**
 * 「commit」 的 handler（原始源行归属 3292–3422）。
 */
async function handleCommit(deps, req) {
  const {
    settingsRuntime, updateSettingsAtGeneration, validateSelection, validateSelectionWithSignal
  } = deps.models;
  const { isActiveRole, sessionOverrideProjectionOf, source } = deps.reads;
  const { settings } = deps.services;
  const { enqueueWrite, host, observeStorageWrite, storageBinding } = deps.storage;
  const { body, signal, send, fail, sessionId, agent, isChild } = req;

  if (body.action === "commit") {
    // 写操作从严：客户端提示或在线会话头表明是子代理，一律拒绝；
    // 子代理已结束且提示缺失（历史会话）时仍会被持久化记录识别为子代理。
    if (isChild) { fail(400, "read-only", "子代理会话只读，不能修改角色模型"); return; }
    if (agent === void 0) { fail(404, "session-not-found", "会话不存在或尚未恢复"); return; }
    // scope：defaults 保留旧 RPC 的全局兼容写入；全局配置入口是“dsh-expert-group”设置页，session 仅当前会话。
    const scope = body.scope === "defaults" ? "defaults" : "session";
    let legacyExpectedRevision;
    if (scope === "defaults") {
      // 旧调用方没有 revision 字段时由 Host 在请求入口捕获快照；队列前端
      // 再由 settings service 比较它，避免完整 defaults 静默覆盖并发修改。
      const suppliedRevision = body.expectedRevision;
      if (suppliedRevision !== void 0 && (!Number.isSafeInteger(suppliedRevision) || suppliedRevision < 0)) {
        fail(400, "bad-request", "expectedRevision 无效");
        return;
      }
      const descriptor = typeof settings.describe === "function"
        ? settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE)
        : void 0;
      const currentRevision = suppliedRevision === void 0 ? descriptor?.revision : suppliedRevision;
      if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
        fail(409, "settings-conflict", "无法安全确认 settings revision，请刷新后重试");
        return;
      }
      legacyExpectedRevision = currentRevision;
    }
    const changes = Array.isArray(body.changes) ? body.changes : null;
    if (changes === null || changes.length === 0) {
      fail(400, "bad-request", "changes 需要至少一个 { role, selection }");
      return;
    }
    const changeInputs = [];
    for (const change of changes) {
      const role = typeof change?.role === "string" ? change.role : "";
      if (!isActiveRole(role)) { fail(400, "invalid-role", `未启用的角色: ${role}`); return; }
      const selection = typeof change?.selection === "object" && change.selection !== null ? change.selection : null;
      if (!selection || typeof selection.provider !== "string" || typeof selection.model !== "string") {
        fail(400, "bad-request", "selection 需要 provider 与 model");
        return;
      }
      changeInputs.push({ role, selection });
    }
    if (scope === "defaults") {
      // 旧全局路由的动态校验也必须在 settings 队列内；代次检查紧邻 update，
      // 目录事件不能插入校验完成与 settings 写入之间。
      await settingsRuntime.enqueueCommit(async () => {
        const generation = settingsRuntime.generation;
        const normalizedChanges = [];
        for (const change of changeInputs) {
          normalizedChanges.push({ role: change.role, selection: await validateSelectionWithSignal(change.selection, signal) });
        }
        if (!settingsRuntime.isCurrentGeneration(generation)) throw new SettingsDirectoryChangedError();
        const current = source();
        const defaults = { ...(current.defaults ?? {}) };
        for (const change of normalizedChanges) defaults[change.role] = change.selection;
        // settings 只保存全局配置，局部 update 不携带 domain 运行数据；
        // 与新 settings-commit 共用实际写入边界和 captured revision。
        await updateSettingsAtGeneration({ defaults }, legacyExpectedRevision, generation);
      });
    } else {
      const normalizedChanges = [];
      for (const change of changeInputs) {
        normalizedChanges.push({ role: change.role, selection: await validateSelection(change.selection, signal) });
      }
      await enqueueWrite(async () => {
        const binding = host.storage.active();
        if (binding?.sessionAuthoritative !== true
          || binding?.sessionOverrideMetaAuthoritative !== true
          || binding.sessionOverrideMetaTable === void 0) {
          throw new Error("storage domain is not ready for session override write");
        }
        const current = source();
        const next = { ...(current.sessionOverrides?.[sessionId] ?? {}) };
        for (const change of normalizedChanges) next[change.role] = change.selection;
        if (!storageBinding.isCurrent(binding)) throw new Error("storage domain binding was replaced");
        const isCurrent = () => storageBinding.isCurrent(binding);
        /**
         * 旧 RPC 的 session 提交同样推进代次（票据 21）：它没有 expectedRevision，
         * 但覆盖内容确实变了；若不推进，设置页手里的旧代次会静默覆盖这次写入。
         * 写入顺序与新动作同源：先代次、后内容，内容失败时尽力回滚代次。
         */
        const priorRevision = sessionOverrideProjectionOf(current, sessionId).revision;
        const metaWrite = await persistDomainEntry({
          table: binding.sessionOverrideMetaTable,
          key: sessionId,
          value: { revision: priorRevision + 1 },
          isCurrent,
        });
        if (metaWrite.detached) {
          const detached = new Error("storage domain binding was replaced");
          detached.code = "PERSISTENCE_GENERATION_STALE";
          detached.category = "generation-stale";
          throw detached;
        }
        let result;
        try {
          result = await persistDomainEntry({
            table: binding.sessionTable,
            key: sessionId,
            value: next,
            isCurrent,
          });
        } catch (error) {
          try {
            await persistDomainEntry({
              table: binding.sessionOverrideMetaTable,
              key: sessionId,
              value: { revision: priorRevision },
              isCurrent,
            });
          } catch { /* 回滚尽力而为。 */ }
          throw error;
        }
        if (result.detached) {
          const detached = new Error("storage domain binding was replaced");
          detached.code = "PERSISTENCE_GENERATION_STALE";
          detached.category = "generation-stale";
          throw detached;
        }
      }).then(() => {
        observeStorageWrite(true, void 0, "session_overrides");
      }, (error) => {
        // 记录健康状态后继续 reject：RPC 仍必须把失败显式返回给调用方。
        observeStorageWrite(false, error, "session_overrides");
        throw error;
      });
    }
    const snap = source();
    send(200, { ok: true, scope, defaults: snap.defaults ?? {}, overrides: snap.sessionOverrides?.[sessionId] ?? {} });
    return;
  }
}
