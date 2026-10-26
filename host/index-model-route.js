/**
 * 入口会话覆盖 / 模型路由 / 设置校验域（R4b · 票据 16）。
 *
 * 这一域持有三类**纯派生**语义（没有任何模块级可变状态）：
 * 1. 会话级模型覆盖的只读投影与代次读取（sessionOverrideProjectionOf / resolveRole）；
 * 2. 模型目录解析与启动前路由计划（validateSelection* / executeModelRoutePlan /
 *    preflightSelectionEntry / restoredFanoutModelRoute）；
 * 3. settings 写入边界的语义校验与提交（validateSettingsCandidate /
 *    commitSettingsCandidate）：提示词覆盖、通知事件、并发映射、上下文继承、单价、
 *    候选模型与默认模型，顺序与错误码逐条不变。
 *
 * ## 组合根保留的职责（票据 16 铁律 1/3）
 * 这里没有任何 ctx 注册点：settings 观察点由 installSettingsSection（index.js 原注册点）
 * 负责，RPC 分发仍在 index.js。域服务**不接收 ctx**，也不持有任何容器——
 * 读源一律经 deps.settingsRead（同一 owner 实例的两个读能力）。
 *
 * ## 读面一致性（不得改变）
 * 需要「同一代读」的路径（如会话覆盖 + 代次）只调一次 readSnapshot()，把返回值向下传；
 * 设置写入边界的「已保存值」优先读宿主 describe()，读不到才回落 readSettingsSource()，
 * 与迁移前逐字同义。
 *
 * @module dsh-expert-group/host/index-model-route
 */
import { imageCapability } from "../image-routing.js";
import { MAX_CONCURRENCY_LIMIT, MAX_PROVIDER_LIMIT, MIN_CONCURRENCY_LIMIT, MIN_PROVIDER_LIMIT } from "../fanout.js";
import {
  MAX_MODEL_CANDIDATES_PER_ROLE,
  MODEL_CANDIDATES_EXHAUSTED,
  MODEL_ROUTE_ERROR_CODES,
  MODEL_ROUTE_OK,
  buildModelRoutePlan,
  classifyModelRouteError,
  isPrecheckModelRouteFailure,
  modelRouteErrorCodeOf,
  modelRouteErrorMessage,
  modelRouteFieldsFromRecord,
  modelSelectionKeyOf,
  normalizeModelFallbackLimit,
  normalizeModelRouteMarker,
  normalizeModelSelection,
} from "../shared/model-route.js";
import {
  PROMPT_OVERRIDES_SETTINGS_KEY,
  PROMPT_OVERRIDE_INVALID_CODE,
  PROMPT_OVERRIDE_MAX_GRAPHEMES,
  PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE,
  STATUS_ROLE_IDS,
  countPromptGraphemes,
} from "../shared/prompts.js";
import { abortErrorFor, createAbortError } from "./rpc-request-lifecycle.js";
import { assertInheritContextCandidate, normalizeSnapshot } from "./settings-read-projection.js";
import {
  CONFIG_MIGRATION_VERSION,
  NOTIFICATION_EVENT_TYPES,
  SETTINGS_NAMESPACE,
  normalizeNotificationEvents,
  normalizeRoleConcurrencyLimit,
  normalizeRoleTimeoutMs,
} from "./settings-schema.js";
import { assertModelPrices } from "./usage-projection.js";
import { mergePeakValleyDraft, peakValleyChangedRoles, resolvePeakValleyProfiles } from "./peak-valley-settings.js";
import { routeSnapshotMarkerOf as routeSnapshotMarkerValue } from "../shared/route-snapshot.js";
import { resolvePeakValleyRoute } from "./peak-valley-route.js";
import { restoredFanoutModelRoute as restoredFanoutModelRouteFrom } from "./fanout-route-restore.js";

/**
 * 创建会话覆盖 / 模型路由 / 设置校验域能力面。
 *
 * @param {object} deps - 窄能力面（**禁止**传整个 ctx）。
 * @param {object} deps.llm - 模型目录服务（listProviders / listModels / resolveCallConfig / resolveModelInfo）。
 * @param {object} deps.settings - 宿主 settings 服务（describe 读面）。
 * @param {(callback: Function) => Promise<unknown>} deps.settingsRuntime - host/settings-runtime（提交串行链与目录代次）。
 * @param {(patch: object, revision: number, generation: number) => Promise<unknown>} deps.updateSettingsAtGeneration -
 *   带代次栅栏的宿主写入命令（settingsRuntime.updateAtGeneration 的窄投影）。
 * @param {(namespace: string) => boolean} deps.configMigrationPending - 配置迁移标记投影。
 * @param {object} deps.settingsRead - settings 读面与投影（host/index-settings-storage 的同一实例）。
 * @param {(role: string) => boolean} deps.isActiveRole - 角色是否启用（与 settings 写入面同一判定）。
 * @param {object} deps.roles - 角色目录能力面 { roleCatalog, activeRoles }。
 * @param {() => object|undefined} deps.getFanoutHost - fan-out Host 晚绑定取值。
 * @param {(message: string) => Error} deps.ValidationError - 组合根的 ValidationError 构造器（RPC 400 映射依赖同一类型）。
 * @param {(value: unknown) => (string|undefined)} deps.normalizeSubagentProvider - subagent provider 名归一（纯函数，属 R4d 域）。
 * @returns {object} 域能力面（见各 installer 返回对象）。
 */
export function createIndexModelRouteDomain(deps) {
  const api = {};
  Object.assign(api, installSessionOverrides(deps, api));
  Object.assign(api, installModelSelection(deps, api));
  Object.assign(api, installSettingsValueValidation(deps, api));
  Object.assign(api, installModelCandidatesValidation(deps, api));
  Object.assign(api, installSettingsCandidateValidation(deps, api));
  Object.assign(api, installSettingsCommit(deps, api));
  return { ...api };
}
/**
 * M1：会话级模型覆盖只读投影与解析（票据 21）。
 *
 * 无状态：投影与代次都来自同一份 readSnapshot()，因此内容与代次永远同源。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} M1 能力面。
 */
function installSessionOverrides(deps, api) {
  const { settingsRead, roles } = deps;
  const { readSnapshot } = settingsRead;
  const { activeRoles } = roles;

    /**
     * 会话级模型覆盖的只读投影与代次读取（票据 21）。
     *
     * 一次 readSnapshot() 同时给出内容与代次，避免读面两次读 domain 时看到不同代的状态。
     * 只投影**当前启用角色**：与 get root 的 overrides 投影同源，已停用角色（例如关闭
     * Observer 之后的 observer）的历史覆盖不进入设置页，也不会被误当成可编辑项。
     * 选择字段只保留 provider/model/可选的 reasoningEffort；历史坏值缺 provider 或
     * model 时整条丢弃（读取面绝不回传半个选择）。
     *
     * @param {object} snap - 已归一的 readSnapshot() 快照。
     * @param {string} sessionId - 根会话 id。
     * @param {Iterable<string>} [allowedRoles] - 允许投影的角色集合。
     * @returns {{overrides: object, revision: number}}
     */
    function sessionOverrideProjectionOf(snap, sessionId, allowedRoles = activeRoles()) {
      const allowed = new Set(allowedRoles);
      const overrides = {};
      for (const [role, selection] of Object.entries(snap?.sessionOverrides?.[sessionId] ?? {})) {
        if (!allowed.has(role)) continue;
        if (selection === null || typeof selection !== "object" || Array.isArray(selection)) continue;
        if (typeof selection.provider !== "string" || selection.provider.length === 0
          || typeof selection.model !== "string" || selection.model.length === 0) continue;
        overrides[role] = {
          provider: selection.provider,
          model: selection.model,
          ...(typeof selection.reasoningEffort === "string" ? { reasoningEffort: selection.reasoningEffort } : {}),
        };
      }
      const rawRevision = snap?.sessionOverrideRevisions?.[sessionId];
      const revision = Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : 0;
      return { overrides, revision };
    }


    /**
     * 构造带代次的会话覆盖冲突（409）。
     *
     * 与 settings 冲突同一语义：客户端保留自己的输入，只把权威 revision/覆盖推进到
     * 本地状态并提示重试；绝不自动以 Host 值覆盖用户正在编辑的草稿。
     */
    function sessionOverrideConflictError(currentRevision, overrides) {
      const error = new Error("本会话的模型覆盖已被其他页面修改，请刷新后重试");
      error.code = "SESSION_OVERRIDE_CONFLICT";
      error.currentRevision = currentRevision;
      error.overrides = overrides;
      return error;
    }


    /** 读取某会话某角色解析后的模型选择：会话覆盖优先，其次全局默认；均未配置返回 null。 */
    function resolveRole(sessionId, role) {
      const snap = readSnapshot();
      const selection = snap.sessionOverrides?.[sessionId]?.[role] ?? snap.defaults?.[role];
      if (selection == null) return null;
      return {
        provider: String(selection.provider ?? ""),
        model: String(selection.model ?? ""),
        reasoningEffort: selection.reasoningEffort === void 0 ? void 0 : String(selection.reasoningEffort),
      };
    }

  return { sessionOverrideProjectionOf, sessionOverrideConflictError, resolveRole };
}
/**
 * M2：模型目录解析与启动前路由计划（票据 24）。
 *
 * 无状态：候选/降级上限每次从 readSnapshot() 现读，绝不缓存；路由计划只做预检类失败降级，
 * 429/5xx/超时/未知错误原样上抛。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面（跨组调用在运行期解析）。
 * @returns {object} M2 能力面。
 */
function installModelSelection(deps, api) {
  const { llm, settingsRead, getFanoutHost, normalizeSubagentProvider, ValidationError, clock } = deps;
  const { readSnapshot } = settingsRead;
  /**
   * 只读时钟（票据 03）：派发期唯一时间来源。
   *
   * 每次派发只调用一次 now()（见 resolvePeakValleyRoute），同一个时间戳既判定 period
   * 又写快照的 decidedAt。这里不做任何缓存或替换：注入的时钟必须连「跨过边界」都能被
   * 测试确定性驱动（测试用可推进的 fake clock，不 monkey-patch 全局 Date）。
   */
  const hostClock = clock !== null && typeof clock === "object" && typeof clock.now === "function"
    ? clock
    : { now: () => Date.now() };

  // 跨组调用统一走域内能力面（运行期解析，构造期不依赖 install 顺序）。
  const resolveRole = (...args) => api.resolveRole(...args);


    /**
     * 校验 provider/model 在当前模型目录内，并用 resolveCallConfig 校验/归一 effort。
     * 关键语义：只有调用方**显式**传了 reasoningEffort 时，才把 effort 持久化到返回值；
     * 未显式传时保持 undefined，绝不把 adapter 的默认档固化进 settings（否则会覆盖模型的默认档演进）。
     */
    async function validateSelection(selection) {
      return validateSelectionWithSignal(selection, arguments[1]);
    }


    /**
     * 构造一条带稳定 causeCode 的模型选择错误（票据 24）。
     *
     * 外层保持 ValidationError（RPC 仍映射 400 invalid-selection），causeCode 只用于
     * 启动前 fallback 的预检分类与设置预检 RPC；message 只包含模型名与固定原因，
     * 绝不携带原始错误正文、凭据或 prompt。
     */
    function modelSelectionError(message, code, cause) {
      const error = new ValidationError(message);
      error.causeCode = code;
      if (cause !== void 0) error.cause = cause;
      return error;
    }


    async function validateSelectionWithSignal(selection, signal) {
      if (!selection || typeof selection !== "object" || Array.isArray(selection)
        || typeof selection.provider !== "string" || selection.provider.length === 0
        || typeof selection.model !== "string" || selection.model.length === 0) {
        throw modelSelectionError(
          "模型选择不完整或类型无效：需要字符串 provider 与 model",
          MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION,
        );
      }
      const rawEffort = selection.reasoningEffort;
      if (rawEffort !== void 0 && rawEffort !== null && rawEffort !== "" && typeof rawEffort !== "string") {
        throw modelSelectionError(
          "reasoningEffort 必须是字符串，或使用 undefined/null/空字符串表示未指定",
          MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION,
        );
      }
      const explicitEffort = rawEffort === void 0 || rawEffort === null || rawEffort === "" ? void 0 : rawEffort;
      // provider/model catalog 只用于提示；目录缺项、延迟或查询失败不能替代精确解析。
      // RC1 的目录 API 没有 AbortSignal 参数，因此查询完成后必须再次检查请求生命周期。
      // 目录查询是 advisory：失败仍交给后续 exact resolveCallConfig 判定。
      if (signal?.aborted === true) throw createAbortError();
      try { if (typeof llm.listProviders === "function") await llm.listProviders(); } catch {}
      if (signal?.aborted === true) throw createAbortError();
      try { if (typeof llm.listModels === "function") await llm.listModels(selection.provider); } catch {}
      if (signal?.aborted === true) throw createAbortError();
      let resolved;
      try {
        const config = {
          provider: selection.provider,
          model: selection.model,
          ...(explicitEffort === void 0 ? {} : { reasoningEffort: explicitEffort }),
        };
        resolved = signal === void 0
          ? await llm.resolveCallConfig(config)
          : await llm.resolveCallConfig(config, signal);
      } catch (error) {
        // resolveCallConfig 是可取消的 exact 解析；不能把请求取消包装成用户输入错误，
        // 否则 RPC 层无法映射为 499，且底层 adapter 会继续占用已关闭请求的资源。
        if (signal?.aborted === true || error?.name === "AbortError" || error?.code === "ABORT_ERR") {
          throw error?.name === "AbortError" || error?.code === "ABORT_ERR" ? error : createAbortError();
        }
        // 原始错误码必须在包装时保留：启动前 fallback 只对预检类失败降级，
        // 运行期错误（429/5xx/超时）与未知错误不得被误判成"换个模型再试"。
        const causeCode = classifyModelRouteError(error);
        if (causeCode === MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_REASONING_EFFORT) {
          throw modelSelectionError(
            `reasoningEffort "${explicitEffort}" 不受 model "${selection.model}" 支持`,
            causeCode,
            error,
          );
        }
        throw modelSelectionError(
          modelRouteErrorMessage(causeCode) + "（" + selection.provider + "/" + selection.model + "）",
          causeCode,
          error,
        );
      }
      if (!resolved || typeof resolved !== "object" || typeof resolved.provider !== "string" || typeof resolved.model !== "string") {
        throw modelSelectionError("模型解析结果无效", MODEL_ROUTE_ERROR_CODES.INVALID_SELECTION);
      }
      return {
        provider: resolved.provider,
        model: resolved.model,
        ...(explicitEffort === void 0 ? {} : { reasoningEffort: String(explicitEffort) }),
      };
    }


    /**
     * 读取一条**已解析**模型选择的输入能力（票据 24：候选级 image/输入类型预检）。
     *
     * 刻意独立于 validateSelectionWithSignal：设置保存、会话覆盖、Observer 自动路由等
     * 既有调用方的返回形状保持不变，只有显式需要能力信息的预检与 image 路由才调用这里。
     *
     * - resolveModelInfo 不存在（旧宿主/测试替身）→ 空输入类型 + image:"unknown"；
     * - inputModalities 只保留 "text"/"image" 并去重（其它值忽略，未知形态归一为空数组）；
     * - image 三态复用 image-routing.js 的 imageCapability（缺失/异常 => unknown）；
     * - 取消错误不在这里吞掉：调用方必须用 abortErrorFor 判定并原样上抛。
     *
     * @param {{provider:string, model:string}} selection - 已通过 validateSelectionWithSignal 的选择。
     * @param {AbortSignal} [signal] - 请求级取消信号。
     * @returns {Promise<{inputModalities:string[], image:"supported"|"unsupported"|"unknown"}>}
     */
    async function readSelectionCapabilities(selection, signal) {
      if (typeof llm.resolveModelInfo !== "function") {
        return { inputModalities: [], image: "unknown" };
      }
      const info = await llm.resolveModelInfo(selection.provider, selection.model, signal);
      const inputModalities = [];
      if (Array.isArray(info?.inputModalities)) {
        for (const modality of info.inputModalities) {
          if (modality !== "text" && modality !== "image") continue;
          if (!inputModalities.includes(modality)) inputModalities.push(modality);
        }
      }
      return { inputModalities, image: imageCapability(info) };
    }


    /**
     * 全部候选都不可用时的结构化错误（票据 24）。
     *
     * message 只列 provider/model 与稳定错误码，绝不包含凭据、完整 prompt 或原始错误
     * 正文；attempts 作为结构化字段供 RPC/测试断言，code 固定为 MODEL_CANDIDATES_EXHAUSTED。
     */
    function modelCandidatesExhaustedError(attempts, lastRouteErrorCode) {
      const rendered = attempts
        .map((attempt) => attempt.provider + "/" + attempt.model + "（" + attempt.code + "）")
        .join("、");
      const error = new ValidationError(
        "所有模型候选均不可用（已尝试 " + attempts.length + " 个："
        + (rendered.length === 0 ? "无" : rendered) + "）；最后错误码："
        + (lastRouteErrorCode ?? MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED),
      );
      error.code = MODEL_CANDIDATES_EXHAUSTED;
      error.causeCode = lastRouteErrorCode ?? MODEL_ROUTE_ERROR_CODES.ROUTE_RESOLUTION_FAILED;
      error.attempts = attempts.map((attempt) => ({ ...attempt }));
      error.validation = true;
      return error;
    }


    /** 读取当前设置里的全局候选列表（会话覆盖不参与候选顺序）。 */
    function candidateSelectionsOfRole(role) {
      const candidates = readSnapshot()?.candidates?.[role];
      return Array.isArray(candidates) ? candidates : [];
    }


    /** 当前生效的自动降级上限（读取面已归一为 0..4）。 */
    function currentModelFallbackLimit() {
      return normalizeModelFallbackLimit(readSnapshot()?.fallbackLimit);
    }


    /** 按角色构造有序路由计划：primary 来自 resolveRole（可含会话覆盖），候选来自全局设置。 */
    function buildRoleModelRoutePlan(role, primary) {
      return buildModelRoutePlan(primary, candidateSelectionsOfRole(role), currentModelFallbackLimit());
    }


    /** 路由元数据 -> agentOptions marker（只含 JSON 安全、可审计字段）。 */
    function routeMarkerOf(route) {
      return {
        ...(route.requestedPrimary === undefined ? {} : { requestedPrimary: { ...route.requestedPrimary } }),
        ...(Number.isSafeInteger(route.candidateIndex) && route.candidateIndex >= 0 ? { candidateIndex: route.candidateIndex } : {}),
        ...(Number.isSafeInteger(route.fallbackCount) && route.fallbackCount >= 0 ? { fallbackCount: route.fallbackCount } : {}),
        ...(route.lastRouteErrorCode === undefined ? {} : { lastRouteErrorCode: route.lastRouteErrorCode }),
      };
    }


    /** 从 agentOptions marker 读取扁平路由字段（形状不合法时返回空对象）。 */
    function routeFieldsOfMarker(value) {
      const marker = normalizeModelRouteMarker(value);
      return marker === undefined ? {} : marker;
    }

    /**
     * 执行一次启动前路由计划（票据 24 的唯一 fallback 实现）。
     *
     * 只对预检类失败继续下一个候选；取消原样上抛；429/5xx/超时/未知错误立即上抛，
     * 绝不做透明换模型。全部失败时抛 MODEL_CANDIDATES_EXHAUSTED，消息只含尝试过的
     * provider/model 与最后错误码。
     *
     * 第三参 requirements 描述本次派发对输入类型的要求（当前只有
     * { inputModalities: ["image"] }）：
     * - 只有要求 image 时才探测能力，纯文本派发不调用 resolveModelInfo；
     * - image 必须是 "supported" 才继续，"unsupported"/"unknown" 都按
     *   UNSUPPORTED_CAPABILITY 预检失败跳过该候选（unknown 绝不当成支持）；
     * - 能力查询本身失败时：取消原样上抛；预检类错误包装成同 code 的
     *   modelSelectionError 后继续降级；非预检（429/5xx/超时/未知）原样上抛；
     * - 成功的 route 带 capabilities，供 role tool 的 image admission 复用，避免二次查询。
     *   未要求 image 时 capabilities 是 { inputModalities: [], image: "unknown" }，
     *   表示“本次没有探测”，绝不伪造成 supported。
     *
     * @param {{plan:Array<{selection:unknown,candidateIndex:number}>, requestedPrimary?:object}} planInfo
     * @param {AbortSignal} [signal]
     * @param {{inputModalities?:string[]}} [requirements]
     */
    async function executeModelRoutePlan(planInfo, signal, requirements) {
      const requiresImage = Array.isArray(requirements?.inputModalities)
        && requirements.inputModalities.includes("image");
      const attempts = [];
      for (const item of planInfo.plan) {
        try {
          const selection = await validateSelectionWithSignal(item.selection, signal);
          let capabilities = { inputModalities: [], image: "unknown" };
          if (requiresImage) {
            try {
              capabilities = await readSelectionCapabilities(selection, signal);
            } catch (error) {
              const abort = abortErrorFor(error, signal);
              if (abort !== undefined) throw abort;
              const code = classifyModelRouteError(error);
              // 只有预检类失败可以换候选；429/5xx/超时/未知必须原样上抛，等待调用方退避。
              if (!isPrecheckModelRouteFailure({ causeCode: code })) throw error;
              throw modelSelectionError(
                modelRouteErrorMessage(code) + "（" + selection.provider + "/" + selection.model + "）",
                code,
                error,
              );
            }
            if (capabilities.image !== "supported") {
              // 固定中文原因，只含 provider/model；不携带底层错误正文。
              throw modelSelectionError(
                "模型未明确声明 image 输入能力（" + selection.provider + "/" + selection.model + "）",
                MODEL_ROUTE_ERROR_CODES.UNSUPPORTED_CAPABILITY,
              );
            }
          }
          const lastRouteErrorCode = attempts.length === 0 ? undefined : attempts[attempts.length - 1].code;
          return {
            selection,
            capabilities,
            ...(planInfo.requestedPrimary === undefined ? {} : { requestedPrimary: planInfo.requestedPrimary }),
            candidateIndex: item.candidateIndex,
            fallbackCount: attempts.length,
            ...(lastRouteErrorCode === undefined ? {} : { lastRouteErrorCode }),
            // 层标（票据 03）：仅供 resolvePeakValleyRoute 组装快照时判断「实际落在哪一层」。
            // 普通（未启用峰谷）计划没有该字段，因此未启用时的返回值形状逐字不变。
            ...(item.tier === undefined ? {} : { tier: item.tier }),
          };
        } catch (error) {
          const abort = abortErrorFor(error, signal);
          if (abort !== undefined) throw abort;
          const shape = normalizeModelSelection(item.selection);
          const provider = shape?.provider ?? (typeof item.selection?.provider === "string" ? item.selection.provider : "");
          const model = shape?.model ?? (typeof item.selection?.model === "string" ? item.selection.model : "");
          const code = modelRouteErrorCodeOf(error);
          attempts.push({ provider, model, code });
          if (!isPrecheckModelRouteFailure(error)) throw error;
        }
      }
      const lastCode = attempts.length === 0 ? undefined : attempts[attempts.length - 1].code;
      throw modelCandidatesExhaustedError(attempts, lastCode);
    }


    /**
     * 解析角色实际路由（票据 03：启用峰谷时在派发时刻冻结快照）。
     *
     * 三条事实在这里落地（规格书决策 1）：
     * - 未启用峰谷：完全保持迁移前行为——不生成快照、不读时钟、不碰峰谷配置；
     * - 会话覆盖命中：tier=normal-override，直接使用普通配置候选链，period 仍记录墙钟；
     * - 无覆盖：tier=period，使用该时段 profile 的计划，时段层之后拼接普通层作为**显式**
     *   跨层回退源（该角色在时段层缺配时直接从普通层开始并写 PEAK_VALLEY_ROLE_MISSING）。
     *
     * 返回 null 表示两层都没有配置该角色主模型（调用方保留既有 NOT_CONFIGURED 文案）。
     * requirements 原样透传给 executeModelRoutePlan（fanout/纯文本派发不传）。
     */
    async function resolveRoleModelRoute(role, sessionId, signal, requirements) {
      const settingsSnapshot = readSnapshot();
      if (settingsSnapshot?.peakValley?.enabled !== true) {
        const primary = resolveRole(sessionId, role);
        if (primary === null) return null;
        return executeModelRoutePlan(buildRoleModelRoutePlan(role, primary), signal, requirements);
      }
      return resolvePeakValleyRoute({
        role,
        sessionId,
        signal,
        requirements,
        settingsSnapshot,
        clock: hostClock,
        ValidationError,
        executeModelRoutePlan,
      });
    }

    /**
     * 单条 selection 的只读预检（票据 24 的 model-preflight RPC）。
     *
     * 复用真实 validateSelectionWithSignal 与同一错误分类；只返回稳定 code 与固定
     * 可读原因，绝不返回原始错误正文/凭据。取消仍原样上抛（由 RPC 映射为 499）。
     */
    async function preflightSelectionEntry(selection, signal) {
      const shape = normalizeModelSelection(selection);
      const provider = shape?.provider ?? (typeof selection?.provider === "string" ? selection.provider : "");
      const model = shape?.model ?? (typeof selection?.model === "string" ? selection.model : "");
      const reasoningEffort = shape?.reasoningEffort ?? (typeof selection?.reasoningEffort === "string" && selection.reasoningEffort.length > 0
        ? selection.reasoningEffort
        : null);
      try {
        const normalized = await validateSelectionWithSignal(selection, signal);
        let capabilities = { inputModalities: [], image: "unknown" };
        try {
          capabilities = await readSelectionCapabilities(normalized, signal);
        } catch (error) {
          // 能力查询失败不得把可用模型误报为不可用：预检仍返回 ok:true，image 保持 unknown。
          // 取消是唯一例外——必须原样上抛，由 RPC 层映射为 499。
          const abort = abortErrorFor(error, signal);
          if (abort !== undefined) throw abort;
        }
        return {
          provider: normalized.provider,
          model: normalized.model,
          reasoningEffort: normalized.reasoningEffort ?? null,
          ok: true,
          code: MODEL_ROUTE_OK,
          message: modelRouteErrorMessage(MODEL_ROUTE_OK),
          inputModalities: capabilities.inputModalities,
          image: capabilities.image,
        };
      } catch (error) {
        const abort = abortErrorFor(error, signal);
        if (abort !== undefined) throw abort;
        const code = modelRouteErrorCodeOf(error);
        return {
          provider,
          model,
          reasoningEffort,
          ok: false,
          code,
          message: modelRouteErrorMessage(code),
          // 失败/无效 selection 没有可探测的目标：空能力 + unknown，绝不补成 supported。
          inputModalities: [],
          image: "unknown",
        };
      }
    }



  return {
    validateSelection,
    validateSelectionWithSignal,
    executeModelRoutePlan,
    resolveRoleModelRoute,
    preflightSelectionEntry,
    restoredFanoutModelRoute: (input) => restoredFanoutModelRouteFrom(input, {
      getFanoutHost,
      readSnapshot,
      normalizeSubagentProvider,
    }),
    candidateSelectionsOfRole,
    routeMarkerOf,
    // 路由快照 marker（票据 03）：独立于扁平 marker；非法快照返回 undefined，绝不写半截。
    routeSnapshotMarkerOf: (route) => routeSnapshotMarkerValue(route?.snapshot),
    routeFieldsOfMarker,
  };
}
/**
 * M3：settings 写入边界的值校验（提示词覆盖 / 通知事件 / 变更集推导）。
 *
 * 无状态纯校验：所有规则与读取归一共享同一批常量，只把「静默丢弃」换成「显式拒绝」。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} M3 能力面。
 */
function installSettingsValueValidation(deps, api) {
  const { settings, settingsRead, ValidationError } = deps;
  const { readSettingsSource, defaultPersonaForRole } = settingsRead;

    /**
     * 构造一条提示词覆盖校验错误。
     *
     * 外层仍是既有 ValidationError（RPC 层映射为 400 invalid-selection，客户端错误
     * 分类不变），并显式带上 validation 标记；附加 code 只用于测试与诊断精确区分
     * 「角色键错了」与「文本内容不合法」，绝不携带任何提示词正文。
     *
     * @param {string} message - 用户可读的中文错误。
     * @param {string} code - PROMPT_OVERRIDE_* 稳定 code。
     * @returns {Error} 带 code/validation 标记的 ValidationError。
     */
    function promptOverrideError(message, code) {
      const error = new ValidationError(message);
      error.code = code;
      error.validation = true;
      return error;
    }


    /**
     * 构造一条峰谷校验错误（票据 02）。
     *
     * 外层仍是 ValidationError（RPC 层保持 400），并显式带稳定 error.code；
     * mapRpcError 对三个 PEAK_VALLEY_* 做白名单透传，其余 ValidationError 仍统一映射成
     * invalid-selection。错误构造函数必须由组合根注入，否则 RPC 层的 instanceof 会退化成 500。
     *
     * @param {string} message - 用户可读的中文错误。
     * @param {string} code - PEAK_VALLEY_* 稳定 code。
     * @returns {Error} 带 code 的 ValidationError。
     */
    function peakValleyError(message, code) {
      const error = new ValidationError(message);
      error.code = code;
      return error;
    }


    /**
     * settings 写入边界上的专家提示词覆盖校验。
     *
     * 与读取归一（normalizePromptOverrides）共用同一批规则，但语义是"显式拒绝"而不是
     * "静默丢弃"：客户端提交的候选有问题时必须拿到结构化错误，不能让它以为保存成功。
     * 候选必须是普通对象；未知角色键、非字符串值、纯空白文本与超过 grapheme 上限的
     * 文本都抛 ValidationError（RPC 层映射为 400 invalid-selection）。
     *
     * 已接受的非空文本按原样返回：不 trim、不压缩空白、不截断，也不做任何模板替换。
     *
     * 「与默认逐字相同」是唯一的删除规则（恢复默认语义）：Host 拥有 DEFAULT_EXPERT_PERSONA，
     * 因此在写入边界自己判定，而不是要求客户端先做一次可能过期的比较。比较是**逐字
     * 精确比较**，不做 trim 或空白折叠——因此首尾空白不同的文本仍然算自定义覆盖并被保留。
     * 删除键而不是保存一份默认副本，是为了让该角色继续跟随未来默认 persona 更新。
     *
     * @param {unknown} value - candidate.promptOverrides。
     * @returns {Record<string,string>} 归一后的覆盖映射（含 0 个键表示清空全部覆盖）。
     */
    function normalizePromptOverrideCandidate(value, allowedRoles = STATUS_ROLE_IDS) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw promptOverrideError("设置 promptOverrides 无效", PROMPT_OVERRIDE_INVALID_CODE);
      }
      const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
      const unknownRole = Object.keys(value).find((role) => !allowed.has(role));
      if (unknownRole !== void 0) {
        throw promptOverrideError("未知专家角色: " + unknownRole, PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE);
      }
      const normalized = {};
      for (const [role, text] of Object.entries(value)) {
        if (typeof text !== "string") {
          throw promptOverrideError(role + " 提示词必须是字符串", PROMPT_OVERRIDE_INVALID_CODE);
        }
        if (text.trim().length === 0) {
          throw promptOverrideError(role + " 提示词不能为空", PROMPT_OVERRIDE_INVALID_CODE);
        }
        if (countPromptGraphemes(text) > PROMPT_OVERRIDE_MAX_GRAPHEMES) {
          throw promptOverrideError(role + " 提示词超过 " + PROMPT_OVERRIDE_MAX_GRAPHEMES + " 字符上限", PROMPT_OVERRIDE_INVALID_CODE);
        }
        // 逐字相同 => 删除键（不保存冗余覆盖）；只要有一个字符不同就必须保留，
        // 包括只差首尾空白这种用户有意保留的格式。
        if (text === defaultPersonaForRole(role)) continue;
        normalized[role] = text;
      }
      return normalized;
    }


    /**
     * 公开 settings 写入入口（settings.update / settings.replace / mutate）与插件
     * 自持 settings-commit 共用的提示词覆盖语义断言。
     *
     * 直接复用 normalizePromptOverrideCandidate：未知角色键、非字符串、纯空白与超过
     * grapheme 上限都拿到同一个结构化错误（ValidationError + 稳定 code），
     * 「与默认逐字相同」与「空对象」按合法输入放行。缺字段（旧文档 / 旧客户端）没有
     * 可校验的映射，保持兼容、不拒绝写入。
     *
     * @param {unknown} value - 解析后 settings 值里的 promptOverrides。
     * @param {readonly string[]} [allowedRoles] - 候选设置自己的角色集合。
     */
    function assertPromptOverridesCandidate(value, allowedRoles = STATUS_ROLE_IDS) {
      if (value === void 0) return;
      normalizePromptOverrideCandidate(value, allowedRoles);
    }


    /**
     * 通知事件开关候选的严格校验（票据 14）。
     *
     * 与读取面的宽容归一不同，写入面必须拒绝未声明类别与非布尔值：静默丢弃未知键会让
     * 用户以为"我设置了某些通知"却没有任何效果，而 truthy 值会把显式关闭悄悄改回开启。
     * 缺失的类别按开启补齐（旧客户端只提交一个类别时，其余两类保持历史行为）。
     *
     * @param {unknown} value - candidate.notificationEvents。
     * @returns {{completed: boolean, waiting: boolean, failed: boolean}} 归一后的完整集合。
     */
    function normalizeNotificationEventCandidate(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError("设置 notificationEvents 无效");
      }
      for (const key of Object.keys(value)) {
        if (!NOTIFICATION_EVENT_TYPES.includes(key)) throw new ValidationError("设置 notificationEvents 无效");
      }
      for (const type of NOTIFICATION_EVENT_TYPES) {
        const flag = value[type];
        if (flag !== void 0 && typeof flag !== "boolean") throw new ValidationError("设置 notificationEvents 无效");
      }
      return normalizeNotificationEvents(value);
    }


    // 单条模型选择的比较键来自 shared.js 的 modelSelectionKeyOf（票据 20/24）：
    // 只有 provider/model/规范化 effort 参与比较，历史多余字段与键顺序不会误判成模型变更。

    /**
     * 写入边界上的「当前已保存值」：优先直接读宿主 describe()。
     *
     * 提交串行链内 describe() 就是最新已落盘值，用它做「候选 vs 已保存」差异推导
     * 比读源快照更准（读源快照依赖 document-updated 事件刷新，且在外部静默写入的
     * 窗口里会滞后）。describe 不可读 / 条目缺失 / value 非对象时回落到 readSettingsSource()
     * 的最近一次归一快照，两者都没有时返回空对象（差异推导因此只认候选自身）。
     *
     * @returns {object} 已保存的 settings 值（未归一，交给 normalizeSnapshot 处理）。
     */
    function readSavedSettingsValue() {
      try {
        if (typeof settings?.describe === "function") {
          const descriptors = settings.describe();
          const descriptor = Array.isArray(descriptors)
            ? descriptors.find((entry) => entry?.ns === SETTINGS_NAMESPACE)
            : undefined;
          if (descriptor !== undefined && descriptor.value !== null && typeof descriptor.value === "object") {
            return descriptor.value;
          }
        }
      } catch { /* describe 不可读：回落到读源快照。 */ }
      return readSettingsSource() ?? {};
    }


    /**
     * 解析客户端上报的变更集（协议字段 `changed`，票据 20/24）。
     *
     * 兼容两种形状：
     * - 未携带 / 非数组（旧客户端）：返回 null，调用方退回「已保存值 vs 候选」的差异推导；
     * - 字符串数组：顶层字段名、`defaults.<role>` 与 `candidates.<role>` 角色级路径；
     *   `defaults` / `candidates` 分别表示整份默认映射/整份候选映射。
     * 峰谷（票据 02）用同一套路径语法挂在子树下：`peak.defaults.<role>`、
     * `peak.candidates.<role>`、`valley.defaults.<role>`、`valley.candidates.<role>`；
     * `peak` / `valley` 表示该层整份配置都变了，`peak.defaults` 表示该层整份默认映射。
     * 非字符串条目一律忽略：多版本客户端混合时，多一个未知字段不能变成保存失败。
     *
     * @param {unknown} value - RPC body.changed。
     * @returns {{roles: Set<string>, allRoles: boolean, candidateRoles: Set<string>, allCandidates: boolean,
     *   peak: object, valley: object}|null} 普通配置的变更集 + 峰/谷两层的同构变更集。
     */
    function declaredChangedModelRolesOf(value) {
      if (!Array.isArray(value)) return null;
      const roles = new Set();
      const candidateRoles = new Set();
      let allRoles = false;
      let allCandidates = false;
      const declaredLayer = () => ({ roles: new Set(), allRoles: false, candidateRoles: new Set(), allCandidates: false });
      const layers = { peak: declaredLayer(), valley: declaredLayer() };
      for (const entry of value) {
        if (typeof entry !== "string") continue;
        const field = entry.trim();
        if (field === "defaults") { allRoles = true; continue; }
        if (field === "candidates") { allCandidates = true; continue; }
        if (field.startsWith("defaults.")) {
          const role = field.slice("defaults.".length);
          if (role.length > 0) roles.add(role);
          continue;
        }
        if (field.startsWith("candidates.")) {
          const role = field.slice("candidates.".length);
          if (role.length > 0) candidateRoles.add(role);
          continue;
        }
        // 峰谷子树：peak.* / valley.* 与顶层同构；整层变更同时声明默认与候选两份。
        const layer = field.startsWith("peak.") ? "peak" : field.startsWith("valley.") ? "valley" : void 0;
        if (layer === void 0) continue;
        const rest = field.slice(layer.length + 1);
        if (rest === "defaults") { layers[layer].allRoles = true; continue; }
        if (rest === "candidates") { layers[layer].allCandidates = true; continue; }
        if (rest.startsWith("defaults.")) {
          const role = rest.slice("defaults.".length);
          if (role.length > 0) layers[layer].roles.add(role);
          continue;
        }
        if (rest.startsWith("candidates.")) {
          const role = rest.slice("candidates.".length);
          if (role.length > 0) layers[layer].candidateRoles.add(role);
        }
      }
      return { roles, allRoles, candidateRoles, allCandidates, ...layers };
    }


    /**
     * 本次提交需要做模型解析的角色集合（票据 20 的核心判定）。
     *
     * 解析范围 = 客户端声明的变更集 ∪ 与已保存值的实际差异：
     * - 只改通知/提示词等无关字段时两者都为空，**不会**因为存量失效模型阻塞保存；
     * - 声明了 `defaults.<role>` 或该角色的模型字段确实变了，才调用
     *   validateSelectionWithSignal 做真实目录解析；其余角色一律沿用已保存值；
     * - 差异兜底保证「任何真实模型写入都不会绕过目录校验」，即使客户端漏报变更集；
     * - 删除角色默认行（候选里没有该角色）不需要解析：没有可解析的选择，删除守卫
     *   由客户端在模型配置区承担。
     *
     * @param {object} candidate - 完整候选（replace 语义不变）。
     * @param {unknown} changed - RPC body.changed。
     * @param {object} savedSnapshot - 已归一的最新生效设置快照。
     * @returns {Set<string>} 需要真实目录解析的角色 id。
     */
    function modelRolesToResolve(candidate, changed, savedSnapshot) {
      const declared = declaredChangedModelRolesOf(changed);
      const savedDefaults = savedSnapshot?.defaults ?? {};
      const roles = new Set();
      for (const [role, selection] of Object.entries(candidate?.defaults ?? {})) {
        const candidateKey = modelSelectionKeyOf(selection);
        const savedKey = modelSelectionKeyOf(savedDefaults[role]);
        // 比较键为空 = 候选不是一条合法选择（缺 provider/model 或不是对象）：这种值
        // 必须走真实解析并以同样的结构化错误被拒绝，绝不能被"看起来没变"放过去。
        const differs = candidateKey !== savedKey || candidateKey.length === 0;
        const declaredChanged = declared !== null && (declared.allRoles || declared.roles.has(role));
        if (!differs && !declaredChanged) continue;
        roles.add(role);
      }
      return roles;
    }


    /**
     * 候选列表的稳定比较键（票据 24）：只比较 provider/model/规范化 effort 的顺序序列。
     * 任一条形状非法时用固定哨兵，保证非法候选一定会进入真实校验并被拒绝。
     */
    function modelSelectionListKey(list) {
      if (!Array.isArray(list)) return "\u0000invalid-list";
      return list.map((entry) => {
        const key = modelSelectionKeyOf(entry);
        return key.length === 0 ? "\u0000invalid" : key;
      }).join("\u0001");
    }


    /**
     * 本次提交需要校验的候选角色集合：声明了 candidates.<role> 或候选列表确实变化。
     * 未变更角色的存量失效候选不得阻塞保存（沿用票据 20 语义）。
     */
    function modelCandidateRolesToResolve(candidate, changed, savedSnapshot, rawSavedCandidates) {
      const declared = declaredChangedModelRolesOf(changed);
      const savedCandidates = savedSnapshot?.candidates ?? {};
      const roles = new Set();
      const sourceCandidates = candidate?.candidates;
      if (sourceCandidates === null || typeof sourceCandidates !== "object" || Array.isArray(sourceCandidates)) return roles;
      const rawCandidates = rawSavedCandidates !== null && typeof rawSavedCandidates === "object" && !Array.isArray(rawSavedCandidates)
        ? rawSavedCandidates
        : {};
      for (const [role, list] of Object.entries(sourceCandidates)) {
        if (!Array.isArray(list)) continue;
        const candidateKey = modelSelectionListKey(list);
        // 读取归一为了安全会丢弃非法候选；若客户端原样提交旧文档里的非法项，
        // 不能因此把「未变更」误判成变更并阻塞无关保存。这里同时接受原始已保存键
        // 与归一后键，任一相同即视为未变更。
        const savedKey = modelSelectionListKey(savedCandidates[role] ?? []);
        const rawSavedKey = modelSelectionListKey(Array.isArray(rawCandidates[role]) ? rawCandidates[role] : []);
        const differs = candidateKey !== savedKey && candidateKey !== rawSavedKey;
        const declaredChanged = declared !== null && (declared.allCandidates || declared.candidateRoles.has(role));
        if (differs || declaredChanged) roles.add(role);
      }
      return roles;
    }

  return {
    promptOverrideError,
    peakValleyError,
    normalizePromptOverrideCandidate,
    assertPromptOverridesCandidate,
    normalizeNotificationEventCandidate,
    readSavedSettingsValue,
    declaredChangedModelRolesOf,
    modelRolesToResolve,
    modelCandidateRolesToResolve,
  };
}
/**
 * M4：候选模型 / 并发映射 / 单价的写入面结构校验（票据 24 / 25 / 26）。
 *
 * 无状态：只做结构/范围校验，不触碰模型目录（目录解析在 M2 与 M5 里发生）。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} M4 能力面。
 */
function installModelCandidatesValidation(deps, api) {
  const { ValidationError } = deps;

  // 跨组调用统一走域内能力面（运行期解析）。
  const validateSelectionWithSignal = (...args) => api.validateSelectionWithSignal(...args);


    /**
     * 候选映射的结构校验（票据 24）：普通对象、已知角色、数组、每角色最多
     * MAX_MODEL_CANDIDATES_PER_ROLE（当前 3）条。
     * 单条 selection 的形状/目录解析在 validateModelCandidatesCandidate 内逐条执行；
     * 只有变更中的角色才走真实解析，未变更角色的存量失效值不阻塞保存。
     */
    function assertModelCandidatesCandidate(value, allowedRoles = STATUS_ROLE_IDS) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError("设置 candidates 无效");
      }
      const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
      for (const [role, list] of Object.entries(value)) {
        if (!allowed.has(role)) throw new ValidationError("未知专家角色候选: " + role);
        if (!Array.isArray(list)) throw new ValidationError("角色 " + role + " 的模型候选必须是数组");
        if (list.length > MAX_MODEL_CANDIDATES_PER_ROLE) {
          throw new ValidationError("角色 " + role + " 的模型候选最多 " + MAX_MODEL_CANDIDATES_PER_ROLE + " 个");
        }
      }
    }


    /**
     * 逐角色并发映射的写入面校验（票据 26）。
     *
     * 规则（保存时**只**做结构/范围校验，不调用模型目录、不解析模型）：
     * - 值必须是普通对象（数组/null 都拒绝）；
     * - 角色键必须属于内置角色集：
     *   否则一次保存就会写进一个永远不会被调度读到的键，用户看到配置却永不生效；
     * - 值必须是 1..64 的安全整数（与 roleConcurrencyLimit/任务级上限同界）。
     *
     * 非法条目**整次保存拒绝**：并发上限是安全/成本边界，静默丢弃会让用户以为
     * 限制已生效。读取面对历史坏值另有一套宽容归一（normalizeRoleLimitsForRead）。
     *
     * @param {unknown} value - candidate.roleLimits。
     * @param {readonly string[]} allowedRoles - 候选设置自己的角色 id 集合。
     * @returns {Record<string, number>} 归一后的映射（用于写入 patch）。
     */
    function assertRoleLimitsCandidate(value, allowedRoles) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError("设置 roleLimits 无效");
      }
      const allowed = new Set(Array.isArray(allowedRoles) ? allowedRoles : STATUS_ROLE_IDS);
      const normalized = {};
      for (const [role, limit] of Object.entries(value)) {
        if (role.trim().length === 0 || !allowed.has(role)) {
          throw new ValidationError("设置 roleLimits 含未知角色: " + role);
        }
        if (!Number.isSafeInteger(limit) || limit < MIN_CONCURRENCY_LIMIT || limit > MAX_CONCURRENCY_LIMIT) {
          throw new ValidationError("设置 roleLimits." + role + " 必须是 " + MIN_CONCURRENCY_LIMIT + "~" + MAX_CONCURRENCY_LIMIT + " 的整数");
        }
        normalized[role] = limit;
      }
      return normalized;
    }


    /**
     * 逐 provider 并发映射的写入面校验（票据 26）。
     *
     * 规则：
     * - 值必须是普通对象；
     * - provider 键只要求非空字符串（**不查模型目录**：目录不可用不应阻塞限流配置保存，
     *   provider 是否真实存在由模型配置负责）；
     * - 值是 0..64 的安全整数；0 = 显式不限制（与未设置等价，但语义更明确）。
     *
     * @param {unknown} value - candidate.providerLimits。
     * @returns {Record<string, number>} 归一后的映射。
     */
    function assertProviderLimitsCandidate(value) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError("设置 providerLimits 无效");
      }
      const normalized = {};
      for (const [provider, limit] of Object.entries(value)) {
        if (provider.trim().length === 0) {
          throw new ValidationError("设置 providerLimits 的 provider 键必须是非空字符串");
        }
        if (!Number.isSafeInteger(limit) || limit < MIN_PROVIDER_LIMIT || limit > MAX_PROVIDER_LIMIT) {
          throw new ValidationError("设置 providerLimits." + provider + " 必须是 " + MIN_PROVIDER_LIMIT + "~" + MAX_PROVIDER_LIMIT + " 的整数");
        }
        normalized[provider] = limit;
      }
      return normalized;
    }


    /**
     * 逐条校验变更角色的候选模型，并拒绝重复（同一 provider+model+规范化 effort）。
     * 返回值写入设置 patch；未变更角色沿用已保存的归一候选，绝不重新解析目录。
     */
    async function validateModelCandidatesCandidate(value, rolesToResolve, savedCandidates, signal) {
      const validated = {};
      for (const [role, list] of Object.entries(value)) {
        if (!rolesToResolve.has(role)) {
          const saved = Array.isArray(savedCandidates[role]) ? savedCandidates[role] : [];
          validated[role] = saved.map((selection) => ({ ...selection }));
          continue;
        }
        const seen = new Set();
        const selections = [];
        for (const choice of list) {
          const selection = await validateSelectionWithSignal(choice, signal);
          const key = modelSelectionKeyOf(selection);
          if (seen.has(key)) {
            throw new ValidationError("模型候选重复：" + selection.provider + "/" + selection.model
              + (selection.reasoningEffort === undefined ? "" : "（" + selection.reasoningEffort + "）"));
          }
          seen.add(key);
          selections.push(selection);
        }
        validated[role] = selections;
      }
      return validated;
    }

  return {
    assertModelCandidatesCandidate,
    assertRoleLimitsCandidate,
    assertProviderLimitsCandidate,
    validateModelCandidatesCandidate,
  };
}
/**
 * M5：完整 settings 候选校验（唯一写入前语义边界）。
 *
 * 只解析变更集中的启用角色（声明 ∪ 实际差异），未变更角色沿用已保存值——
 * 一次无关保存不会被存量失效模型整体阻塞。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} M5 能力面。
 */
function installSettingsCandidateValidation(deps, api) {
  const { ValidationError, roles } = deps;
  const { roleCatalog, activeRoles } = roles;

  // 跨组调用统一走域内能力面（运行期解析）。
  const normalizePromptOverrideCandidate = (...args) => api.normalizePromptOverrideCandidate(...args);
  const normalizeNotificationEventCandidate = (...args) => api.normalizeNotificationEventCandidate(...args);
  const assertModelCandidatesCandidate = (...args) => api.assertModelCandidatesCandidate(...args);
  const assertRoleLimitsCandidate = (...args) => api.assertRoleLimitsCandidate(...args);
  const assertProviderLimitsCandidate = (...args) => api.assertProviderLimitsCandidate(...args);
  const assertModelPricesCandidate = (...args) => api.assertModelPricesCandidate(...args);
  const readSavedSettingsValue = (...args) => api.readSavedSettingsValue(...args);
  const peakValleyError = (...args) => api.peakValleyError(...args);
  const declaredChangedModelRolesOf = (...args) => api.declaredChangedModelRolesOf(...args);
  const modelRolesToResolve = (...args) => api.modelRolesToResolve(...args);
  const modelCandidateRolesToResolve = (...args) => api.modelCandidateRolesToResolve(...args);
  const validateModelCandidatesCandidate = (...args) => api.validateModelCandidatesCandidate(...args);
  const validateSelectionWithSignal = (...args) => api.validateSelectionWithSignal(...args);

    /**
     * 峰谷提交的字段粒度合并（票据 02）。
     *
     * 克隆源取本次提交里**已归一**的普通配置（而不是上一版落盘值）：同一次保存里
     * 用户刚改的普通配置与被克隆出的峰/谷视角必须自洽。合并规则与错误码由
     * host/peak-valley-settings 的唯一实现负责，这里只提供上下文。
     *
     * @param {object} candidate - 完整 settings 候选。
     * @param {object} savedPeakValley - 已归一的旧 peakValley 状态（合并基线）。
     * @param {object} savedOrdinary - 已归一的旧普通配置（未显式提供的普通字段回退来源）。
     * @param {object} rawSaved - describe() 的原始旧值（用于取旧 peakValley 原值）。
     * @param {{candidates: boolean, fallbackLimit: boolean}} provided - 本次是否显式提供对应普通字段。
     * @returns {object|undefined} 合并后的峰谷状态；未提交 peakValley 时返回 undefined。
     */
    function mergePeakValleyCandidate(candidate, savedPeakValley, savedOrdinary, rawSaved, provided) {
      if (candidate.peakValley === void 0) return void 0;
      return mergePeakValleyDraft({
        draft: candidate.peakValley,
        saved: rawSaved?.peakValley,
        ordinary: {
          provider: candidate.provider,
          defaults: candidate.defaults,
          candidates: provided.candidates ? candidate.candidates : savedOrdinary.candidates,
          fallbackLimit: provided.fallbackLimit ? candidate.fallbackLimit : savedOrdinary.fallbackLimit,
        },
        makeError: peakValleyError,
      });
    }

    /**
     * 使用当前 Host 目录校验完整候选；串行提交边界负责最后的代次检查。
     *
     * 模型解析只覆盖变更集（票据 20）：未变更角色沿用已保存值，绝不再用真实目录
     * 重新解析——否则一次「只改通知开关」的保存会被某个存量失效模型整体阻塞。
     * 返回的 `modelRoles` 供调用方记录/测试观察「这次到底解析了哪些角色」。
     *
     * @param {unknown} candidate - 完整 settings 候选（replace 语义）。
     * @param {AbortSignal} [signal] - 请求生命周期信号。
     * @param {unknown} [changed] - 客户端上报的变更集（可选，旧客户端不携带）。
     * @returns {Promise<{value: object, modelRoles: string[]}>} 归一后的候选与已解析角色。
     */
    async function validateSettingsCandidate(candidate, signal, changed) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new ValidationError("设置候选值无效");
      }
      if (typeof candidate.provider !== "string") throw new ValidationError("设置 provider 无效");
      if (!candidate.defaults || typeof candidate.defaults !== "object" || Array.isArray(candidate.defaults)) {
        throw new ValidationError("设置 defaults 无效");
      }
      if (typeof candidate.notificationEnabled !== "boolean") throw new ValidationError("设置 notificationEnabled 无效");
      if (!Number.isSafeInteger(candidate.notificationVolume) || candidate.notificationVolume < 0 || candidate.notificationVolume > 100) {
        throw new ValidationError("设置 notificationVolume 无效");
      }
      // 通知事件类型（票据 14）：缺字段（旧客户端/旧文档）不写 patch；显式提供时严格校验
      // 只含声明过的三个类别且值必须是布尔，绝不用 truthy 值隐式关闭/开启某一类通知。
      const hasNotificationEvents = candidate.notificationEvents !== void 0;
      const notificationEvents = hasNotificationEvents
        ? normalizeNotificationEventCandidate(candidate.notificationEvents)
        : void 0;
      // 旧客户端没有该字段时保持缺省语义，并在提交 patch 中省略它；显式提供时严格要求安全整数。
      const hasRoleConcurrencyLimit = candidate.roleConcurrencyLimit !== void 0;
      const roleConcurrencyLimit = hasRoleConcurrencyLimit
        ? normalizeRoleConcurrencyLimit(candidate.roleConcurrencyLimit)
        : void 0;
      if (hasRoleConcurrencyLimit && roleConcurrencyLimit !== candidate.roleConcurrencyLimit) {
        throw new ValidationError("设置 roleConcurrencyLimit 无效");
      }
      // 角色默认超时（票据 06）：缺字段（旧客户端）不写 patch；显式提供时必须严格
      // 落在 0 或 1000~86,400,000 的整秒毫秒数上。归一后不等于原值（含 1500、
      // 负数、字符串）就是非法，绝不静默回退成“不启用”。
      const hasRoleTimeoutMs = candidate.roleTimeoutMs !== void 0;
      const roleTimeoutMs = hasRoleTimeoutMs ? normalizeRoleTimeoutMs(candidate.roleTimeoutMs) : void 0;
      if (hasRoleTimeoutMs && roleTimeoutMs !== candidate.roleTimeoutMs) {
        throw new ValidationError("设置 roleTimeoutMs 无效");
      }
      if (candidate.observerPreferred !== void 0 && typeof candidate.observerPreferred !== "boolean") {
        throw new ValidationError("设置 observerPreferred 无效");
      }
      // 任务管理开关沿用旧字段的兼容语义：缺字段表示旧客户端，不写 patch；
      // 显式提供时严格要求布尔，绝不用 truthy 值隐式关闭侧边栏注册。
      const hasTaskManagementEnabled = candidate.taskManagementEnabled !== void 0;
      if (hasTaskManagementEnabled && typeof candidate.taskManagementEnabled !== "boolean") {
        throw new ValidationError("设置 taskManagementEnabled 无效");
      }
      // 自动打开沿用同一兼容语义（与 taskManagementEnabled 逐字同款）：缺字段表示旧客户端，
      // 不写 patch；显式提供时严格要求布尔，绝不用 truthy 值隐式开启自动行为。
      const hasAutoOpenSubagentSidebar = candidate.autoOpenSubagentSidebar !== void 0;
      if (hasAutoOpenSubagentSidebar && typeof candidate.autoOpenSubagentSidebar !== "boolean") {
        throw new ValidationError("设置 autoOpenSubagentSidebar 无效");
      }
      // 左侧栏入口沿用同一兼容语义（与 taskManagementEnabled / autoOpenSubagentSidebar 逐字同款）：
      // 缺字段表示旧客户端，不写 patch；显式提供时严格要求布尔，绝不用 truthy 值隐式隐藏入口。
      const hasSidebarEntryEnabled = candidate.sidebarEntryEnabled !== void 0;
      if (hasSidebarEntryEnabled && typeof candidate.sidebarEntryEnabled !== "boolean") {
        throw new ValidationError("设置 sidebarEntryEnabled 无效");
      }
      // 角色集合固定为内置六角色（自定义角色能力已删除）。
      const candidateRoleRegistry = roleCatalog();
      const candidateRoleIds = STATUS_ROLE_IDS;
      /**
       * 并发映射（票据 26）：缺字段 = 旧客户端/旧文档，不写 patch、保持已有映射；
       * 显式提供时只做结构/范围校验（不触碰模型目录），非法条目整次保存拒绝。
       * 判定在任何 await 之前完成，避免半个候选进入后续模型解析。
       */
      const hasRoleLimits = candidate.roleLimits !== void 0;
      const roleLimits = hasRoleLimits ? assertRoleLimitsCandidate(candidate.roleLimits, candidateRoleIds) : void 0;
      const hasProviderLimits = candidate.providerLimits !== void 0;
      const providerLimits = hasProviderLimits ? assertProviderLimitsCandidate(candidate.providerLimits) : void 0;
      /**
       * 上下文继承映射（票据 29）：缺字段 = 旧客户端/旧文档，不写 patch、保持已有映射；
       * 显式提供时 fail-closed：Observer、未知角色与非布尔值整次保存拒绝。
       * 判定与限流映射一样在任何 await 之前完成。
       */
      const hasInheritContext = candidate.inheritContext !== void 0;
      const inheritContext = hasInheritContext ? assertInheritContextCandidate(candidate.inheritContext) : void 0;
      // 提示词覆盖沿用同一"缺字段即不覆盖"兼容语义：旧客户端提交的候选被原样放行，
      // 已有的自定义提示词不会被一次无关的通知设置保存清空。
      const hasPromptOverrides = candidate[PROMPT_OVERRIDES_SETTINGS_KEY] !== void 0;
      const promptOverrides = hasPromptOverrides
        ? normalizePromptOverrideCandidate(candidate[PROMPT_OVERRIDES_SETTINGS_KEY], candidateRoleIds)
        : void 0;
      // 候选映射（票据 24）：缺字段 = 旧客户端，不写 patch、保持原值；显式提供时先做
      // 结构校验（unknown role/非数组/超过每角色上限），再只解析变更中的角色。
      const hasCandidates = candidate.candidates !== void 0;
      if (hasCandidates) assertModelCandidatesCandidate(candidate.candidates, candidateRoleIds);
      // 自动降级上限：缺字段不写 patch；显式提供时只接受 0..4 的安全整数。
      const hasFallbackLimit = candidate.fallbackLimit !== void 0;
      const fallbackLimit = hasFallbackLimit ? normalizeModelFallbackLimit(candidate.fallbackLimit) : void 0;
      if (hasFallbackLimit && fallbackLimit !== candidate.fallbackLimit) {
        throw new ValidationError("设置 fallbackLimit 无效");
      }
      // 单价（票据 25）：缺字段 = 旧客户端/旧文档，不写 patch、保持已有单价；
      // 显式提供时 fail-closed 校验（结构/范围/未知键/重复 provider+model），
      // 空数组是合法的“清空全部”。判定在任何 await 之前完成。
      const hasModelPrices = candidate.modelPrices !== void 0;
      const modelPrices = hasModelPrices ? assertModelPricesCandidate(candidate.modelPrices) : void 0;
      // provider catalog 是 advisory；每个"变更中"的启用角色默认模型最终由 resolveCallConfig
      // 精确验证。解析范围见 modelRolesToResolve：只覆盖变更集（声明 ∪ 实际差异），
      // 未变更角色沿用已保存值，绝不再用真实目录重新解析——一次「只改通知开关」的保存
      // 因此不会被某个存量失效模型整体阻塞（票据 20）。
      // 未启用角色（尤其是关闭 Observer 后遗留的 defaults.observer）按原值保留，
      // 避免无关的通知设置保存因已失效的隐藏运行配置失败。
      const rawSavedSettings = readSavedSettingsValue();
      const savedSnapshot = normalizeSnapshot(rawSavedSettings, activeRoles());
      const savedDefaults = savedSnapshot.defaults;
      // 峰谷（票据 02）：字段粒度合并 + 首次启用克隆。基线是 describe() 的权威旧值，
      // 只有显式提供的子字段参与合并；全部判定都在任何 await 之前完成。
      const hasPeakValley = candidate.peakValley !== void 0;
      const savedPeakValley = savedSnapshot.peakValley;
      const peakValleyMerged = hasPeakValley
        ? mergePeakValleyCandidate(candidate, savedPeakValley, savedSnapshot, rawSavedSettings, {
            candidates: hasCandidates,
            fallbackLimit: hasFallbackLimit,
          })
        : void 0;
      // 峰/谷两层各自与已保存状态比对（∪ 客户端声明）；结果按层分组（HIGH-2：分层消费）。
      const peakValleyChanges = peakValleyMerged === void 0
        ? void 0
        : peakValleyChangedRoles(peakValleyMerged, savedPeakValley, declaredChangedModelRolesOf(changed));
      const modelRoles = modelRolesToResolve(candidate, changed, savedSnapshot);
      const candidateRoles = hasCandidates
        ? modelCandidateRolesToResolve(candidate, changed, savedSnapshot, rawSavedSettings?.candidates)
        : new Set();
      // 目录代次守卫的角色并集：峰/谷两层的 candidateRoles 同样受 generation 保护（票据 02 / D4）。
      const allCandidateRoles = new Set([...candidateRoles,
        ...(peakValleyChanges?.peak?.candidateRoles ?? []), ...(peakValleyChanges?.valley?.candidateRoles ?? [])]);
      // 候选逐条解析放在 defaults 之前：非法候选应在进入默认模型解析前被拒绝。
      const candidates = hasCandidates
        ? await validateModelCandidatesCandidate(candidate.candidates, candidateRoles, savedSnapshot.candidates ?? {}, signal)
        : void 0;
      const defaults = {};
      // 启用集合来自内置目录（observer 是否启用由 Config 决定）；
      // activeRoles() 与 roleCatalog().enabledIds({ enableObserver }) 是同一份投影。
      const enabledRoles = new Set(activeRoles());
      const resolvedRoles = [];
      for (const [role, selection] of Object.entries(candidate.defaults)) {
        if (!enabledRoles.has(role)) {
          defaults[role] = selection;
          continue;
        }
        if (modelRoles.has(role)) {
          defaults[role] = await validateSelectionWithSignal(selection, signal);
          resolvedRoles.push(role);
          continue;
        }
        // 未变更：沿用已保存值（与候选的模型字段相同），不做任何目录解析。
        const savedSelection = savedDefaults[role];
        defaults[role] = savedSelection !== undefined && typeof savedSelection === "object"
          ? { ...savedSelection }
          : selection;
      }
      // 峰谷两套 profile 的目录解析在普通 defaults 之后：非法候选先行拒绝。
      const peakValleyResolved = peakValleyMerged === void 0
        ? void 0
        : await resolvePeakValleyProfiles({
            state: peakValleyMerged,
            changes: peakValleyChanges,
            savedState: savedPeakValley,
            enabledRoles: activeRoles(),
            resolveSelection: validateSelectionWithSignal,
            resolveCandidates: validateModelCandidatesCandidate,
            signal,
          });
      return {
        value: {
          ...candidate,
          defaults,
          // 峰谷状态按整份状态写入（已含合并结果与 Host 派生的 initialized）；
          // 缺字段（旧客户端）时不出现该键，patch 里也不会写。
          ...(hasPeakValley ? { peakValley: peakValleyResolved.state } : {}),
          ...(hasCandidates ? { candidates } : {}),
          ...(hasFallbackLimit ? { fallbackLimit } : {}),
          ...(hasNotificationEvents ? { notificationEvents } : {}),
          ...(hasPromptOverrides ? { [PROMPT_OVERRIDES_SETTINGS_KEY]: promptOverrides } : {}),
          // 并发映射按整份映射 replace（票据 26）：空对象 = 显式清空全部覆盖，
          // 与「缺字段 = 保持原值」是两种不同语义。
          ...(hasRoleLimits ? { roleLimits } : {}),
          ...(hasProviderLimits ? { providerLimits } : {}),
          // 上下文继承按整份映射 replace（票据 29）：空对象 = 显式清空全部继承开关。
          ...(hasInheritContext ? { inheritContext } : {}),
          // 单价按整份数组 replace（票据 25）：空数组 = 显式清空全部单价；
          // 缺字段仍由调用方决定不写 patch（保持已有值）。
          ...(hasModelPrices ? { modelPrices } : {}),
          observerPreferred: candidate.observerPreferred === true,
          // 缺字段（旧客户端/旧文档）按开启归一：默认必须维持侧边栏注册的历史行为。
          taskManagementEnabled: candidate.taskManagementEnabled !== false,
          // 缺字段（旧客户端/旧文档）按关闭归一：默认必须维持「无自动 open/close」的历史行为。
          autoOpenSubagentSidebar: candidate.autoOpenSubagentSidebar === true,
          // 缺字段（旧客户端/旧文档）按开启归一：默认必须维持左侧栏入口可见的历史行为。
          sidebarEntryEnabled: candidate.sidebarEntryEnabled !== false,
        },
        // 本次真正调用过真实目录解析的角色（测试与诊断据此证明"只解析变更项"）。
        // 峰/谷两层的角色同样计入：目录代次守卫必须覆盖 peak/valley（票据 02 / D4）。
        modelRoles: [...resolvedRoles, ...(peakValleyResolved?.resolvedRoles ?? [])],
        modelCandidateRoles: [...allCandidateRoles],
      };
    }

  return { validateSettingsCandidate };
}
/**
 * M6：settings 提交（DEG 自有提交端点的唯一写入边界）。
 *
 * 顺序固定：同步校验提示词覆盖 → 完整候选校验 → 目录代次复核 → 带 expectedRevision 写入 →
 * 从 describe() 重建回执。响应形状与「缺字段不写 patch」规则逐条不变。
 *
 * @param {object} deps - 见 createIndexModelRouteDomain。
 * @param {object} api - 域内能力面。
 * @returns {object} M6 能力面。
 */
function installSettingsCommit(deps, api) {
  const { settings, settingsRuntime, updateSettingsAtGeneration, configMigrationPending, settingsRead, roles, ValidationError } = deps;
  const { describeRolePrompts } = settingsRead;
  const { activeRoles } = roles;

  // 跨组调用统一走域内能力面（运行期解析）。
  const assertPromptOverridesCandidate = (...args) => api.assertPromptOverridesCandidate(...args);
  const validateSettingsCandidate = (...args) => api.validateSettingsCandidate(...args);


    /**
     * 校验完成后立即写入宿主配置（DEG 自有提交端点的唯一写入边界）。
     *
     * 新契约下宿主**没有** validate 钩子，因此本方法就是唯一的写入前语义边界，
     * 顺序固定为：
     * 1. 提示词覆盖的完整语义校验（未知角色键、非字符串、纯空白、超 grapheme 上限）
     *    ——在任何 await 之前同步执行，非法候选绝不进入宿主写入；
     * 2. `validateSettingsCandidate`：provider/defaults/通知/并发/开关的类型与范围校验，
     *    以及**变更集中**启用角色的模型目录解析（未变更角色沿用已保存值，票据 20）；
     * 3. 目录代次复核：校验完成到写入之间目录代次变化则拒绝；
     * 4. `updateAtGeneration` 在串行链内带 expectedRevision 写入宿主配置，并在调用
     *    宿主写入前再复核一次代次。
     *
     * **保证边界（规格书记录的降级）**：上述代次复核只覆盖 DEG 自己的提交路径，且只
     * 覆盖到宿主写入调用之前。DEG 不承诺通用宿主写入路径（settings.update / mutate，
     * 例如模型配置区）也保证模型目录有效，也不封住宿主异步落盘期间的竞态——宿主没有
     * 提供验证接缝，DEG 的锁无法协调外部写入。
     *
     * revision 冲突由宿主写入的 expectedRevision 栅栏返回（串行链保证后一条提交看到
     * 前一条落盘后的 revision）。
     *
     * 读取面语义：0.1.7 的 `describe().value` 是 defaults resolved 结果，因此
     * provider 空串、promptOverrides 空对象等“未配置”值都会出现；归一逻辑按
     * 缺失字段回退默认值处理，与旧 `scope.get()` 的解析结果同形。
     *
     * @param {object} candidate - 完整 settings 候选（replace 语义不变）。
     * @param {number} expectedRevision - 客户端观察到的 settings revision。
     * @param {AbortSignal} [signal] - 请求生命周期信号。
     * @param {unknown} [changed] - 客户端上报的变更集（`string[]`；旧客户端不携带）。
     *   仅用于决定「哪些角色要做真实模型解析」，**不改变** replace 写入语义：
     *   候选仍是完整值，patch 仍按顶层键整值写入。
     */
    /**
     * 单价候选的严格校验（票据 25）。
     *
     * 复用 host/usage-projection.js 的 assertModelPrices 作为唯一规则来源，只把错误类型
     * 换成 RPC 层能映射成 400 的 ValidationError；绝不在组合根复制第二套字段校验。
     * 单价是成本展示的输入，非法条目必须整次保存拒绝，不能像读取面那样静默丢弃。
     *
     * @param {unknown} value - candidate.modelPrices。
     * @returns {object[]} 归一后的完整数组（用于 replace 写入）。
     */
    function assertModelPricesCandidate(value) {
      try {
        return assertModelPrices(value);
      } catch (error) {
        throw new ValidationError(error instanceof Error ? error.message : "设置 modelPrices 无效");
      }
    }

    function commitSettingsCandidate(candidate, expectedRevision, signal, changed) {
      // 旧客户端缺少任务管理字段时既不写 patch，也不在响应里新增字段（保持历史形状）。
      const hasTaskManagementEnabled = candidate?.taskManagementEnabled !== void 0;
      // 自动打开同理：缺字段不写 patch，也不在响应里新增字段——一次无关的通知设置保存
      // 绝不能把用户已经开启的自动打开重置回默认关闭。
      const hasAutoOpenSubagentSidebar = candidate?.autoOpenSubagentSidebar !== void 0;
      // 左侧栏入口同理：缺字段不写 patch，也不在响应里新增字段——一次无关的通知设置保存
      // 绝不能把用户已经关闭（或开启）的左侧栏入口重置回默认值。
      const hasSidebarEntryEnabled = candidate?.sidebarEntryEnabled !== void 0;
      // 提示词覆盖同理：缺字段不写 patch，避免旧客户端的保存顺带清空已有自定义提示词。
      const hasPromptOverrides = candidate?.[PROMPT_OVERRIDES_SETTINGS_KEY] !== void 0;
      // 通知事件类型（票据 14）同样是显式字段才写 patch / 才回传：旧客户端的响应形状不变。
      const hasNotificationEvents = candidate?.notificationEvents !== void 0;
      // 模型候选/降级上限（票据 24）同样只写显式提供的字段：旧客户端不传时保持原值，
      // 响应也维持历史形状（不新增字段）。
      const hasCandidates = candidate?.candidates !== void 0;
      const hasFallbackLimit = candidate?.fallbackLimit !== void 0;
      // 并发映射（票据 26）同一规则：缺字段 = 旧客户端，不写 patch、不在响应里新增字段；
      // 显式空对象则表示「清空全部逐角色/provider 覆盖」（与缺字段语义不同）。
      const hasRoleLimits = candidate?.roleLimits !== void 0;
      const hasProviderLimits = candidate?.providerLimits !== void 0;
      // 上下文继承（票据 29）同一规则：缺字段 = 保持已有映射且响应保持历史形状；
      // 显式空对象表示全部关闭（与缺字段语义不同）。
      const hasInheritContext = candidate?.inheritContext !== void 0;
      // 单价（票据 25）同一规则：缺字段 = 旧客户端，不写 patch、不在响应里新增字段；
      // 显式空数组表示清空全部单价（与缺字段语义不同）。
      const hasModelPrices = candidate?.modelPrices !== void 0;
      // 峰谷（票据 02）同一规则：缺字段 = 旧客户端，不写 patch、不在响应里新增字段；
      // 显式提供时整值写入合并后的完整状态（含 Host 派生的 initialized）。
      const hasPeakValley = candidate?.peakValley !== void 0;
      return settingsRuntime.enqueueCommit(async () => {
        const generation = settingsRuntime.generation;
        // 写入前的第一道语义边界：与 validateSettingsCandidate 内部同一批规则，
        // 但这里先于任何 await 运行，保证非法覆盖不会在异步校验期间进入宿主写入路径。
        assertPromptOverridesCandidate(candidate?.[PROMPT_OVERRIDES_SETTINGS_KEY], STATUS_ROLE_IDS);
        const validated = await validateSettingsCandidate(candidate, signal, changed);
        const validatedSettings = validated.value;
        // 目录代次栅栏只保护「这次真的要写模型字段」的提交（票据 20）：与模型无关的保存
        // 不依赖目录，用写入时刻的代次参与复核，因此不会被提交期间到达的目录事件误判成
        // 过期；确有模型变更时仍用提交起始代次，语义与票据 03 完全一致。
        const hasModelChanges = validated.modelRoles.length > 0 || validated.modelCandidateRoles.length > 0;
        const generationForWrite = hasModelChanges ? generation : settingsRuntime.generation;
        if (!settingsRuntime.isCurrentGeneration(generationForWrite)) {
          throw new ValidationError("模型目录在保存期间发生变化，请刷新目录后重试");
        }
        // 一次性配置迁移的持久化开关：读取面把旧的 10 解释为 20，首次保存把标记
        // 与其它字段写进同一份 patch；之后 10 原样保留（用户可手动改回）。
        const migrationMarked = configMigrationPending();
        const patch = {
          ...(migrationMarked ? { configMigrationVersion: CONFIG_MIGRATION_VERSION } : {}),
          provider: validatedSettings.provider,
          defaults: validatedSettings.defaults,
          // 候选/降级上限只在显式提供时写入；候选按整份映射 replace（与 defaults 同语义）。
          ...(hasCandidates ? { candidates: validatedSettings.candidates } : {}),
          ...(hasFallbackLimit ? { fallbackLimit: validatedSettings.fallbackLimit } : {}),
          // 峰谷状态是**顶层整值**：合并与克隆已在 validateSettingsCandidate 内完成，
          // 这里只落一份完整快照，客户端原 expectedRevision 仍做同一道 CAS。
          ...(hasPeakValley ? { peakValley: validatedSettings.peakValley } : {}),
          notificationEnabled: validatedSettings.notificationEnabled,
          notificationVolume: validatedSettings.notificationVolume,
          // 通知事件类型同样「缺字段即不覆盖」：旧客户端保存通知开关不得重置事件过滤。
          ...(candidate.notificationEvents === void 0 ? {} : { notificationEvents: validatedSettings.notificationEvents }),
          ...(candidate.roleConcurrencyLimit === void 0 ? {} : { roleConcurrencyLimit: validatedSettings.roleConcurrencyLimit }),
          // 角色默认超时同样「缺字段即不覆盖」：旧客户端保存通知设置不得把它重置为 0。
          ...(candidate.roleTimeoutMs === void 0 ? {} : { roleTimeoutMs: validatedSettings.roleTimeoutMs }),
          // 旧客户端缺失该字段时不覆盖已有值；新客户端显式提交 true/false。
          ...(candidate.observerPreferred === void 0 ? {} : { observerPreferred: validatedSettings.observerPreferred }),
          // 任务管理同样是「缺字段即不覆盖」：旧客户端保存通知设置不得顺带重置侧边栏注册。
          ...(hasTaskManagementEnabled ? { taskManagementEnabled: validatedSettings.taskManagementEnabled } : {}),
          // 自动打开沿用同一写面规则：只有显式提供该字段的候选才能改写它。
          ...(hasAutoOpenSubagentSidebar ? { autoOpenSubagentSidebar: validatedSettings.autoOpenSubagentSidebar } : {}),
          // 左侧栏入口沿用同一写面规则：只有显式提供该字段的候选才能改写它。
          ...(hasSidebarEntryEnabled ? { sidebarEntryEnabled: validatedSettings.sidebarEntryEnabled } : {}),
          // 提示词覆盖按整份映射提交（不做键级合并）：空对象显式清空全部自定义提示词。
          ...(hasPromptOverrides ? { [PROMPT_OVERRIDES_SETTINGS_KEY]: validatedSettings[PROMPT_OVERRIDES_SETTINGS_KEY] } : {}),
          // 并发映射按整份映射 replace（票据 26）：空对象显式清空覆盖，回到默认值/不限制。
          ...(hasRoleLimits ? { roleLimits: validatedSettings.roleLimits } : {}),
          ...(hasProviderLimits ? { providerLimits: validatedSettings.providerLimits } : {}),
          // 上下文继承按整份映射 replace（票据 29）：空对象显式关闭全部继承。
          ...(hasInheritContext ? { inheritContext: validatedSettings.inheritContext } : {}),
          // 单价按整份数组 replace：空数组显式清空；缺字段保持已有值。
          ...(hasModelPrices ? { modelPrices: validatedSettings.modelPrices } : {}),
        };
        await updateSettingsAtGeneration({ ...patch }, expectedRevision, generationForWrite);
        const descriptor = settings.describe().find((entry) => entry.ns === SETTINGS_NAMESPACE);
        // 提交后基线改从 describe() 读取（旧 settings.get 已从宿主删除）；value 是
        // defaults resolved 结果，与读取面同一份权威值。
        const committedSettings = { ...normalizeSnapshot(descriptor?.value, activeRoles()) };
        // 旧客户端没有这些字段；它的提交/返回保持历史形状，新客户端会在 normalize 后显式携带值。
        if (candidate.observerPreferred === void 0) delete committedSettings.observerPreferred;
        if (candidate.roleConcurrencyLimit === void 0) delete committedSettings.roleConcurrencyLimit;
        if (candidate.roleTimeoutMs === void 0) delete committedSettings.roleTimeoutMs;
        if (!hasTaskManagementEnabled) delete committedSettings.taskManagementEnabled;
        if (!hasAutoOpenSubagentSidebar) delete committedSettings.autoOpenSubagentSidebar;
        if (!hasSidebarEntryEnabled) delete committedSettings.sidebarEntryEnabled;
        if (!hasPromptOverrides) delete committedSettings[PROMPT_OVERRIDES_SETTINGS_KEY];
        if (!hasNotificationEvents) delete committedSettings.notificationEvents;
        if (!hasCandidates) delete committedSettings.candidates;
        if (!hasFallbackLimit) delete committedSettings.fallbackLimit;
        // 峰谷同上：旧客户端不传时响应保持历史形状（不新增字段）。
        if (!hasPeakValley) delete committedSettings.peakValley;
        // 并发映射同上：旧客户端不传时响应保持历史形状（不新增字段）。
        if (!hasRoleLimits) delete committedSettings.roleLimits;
        if (!hasProviderLimits) delete committedSettings.providerLimits;
        // 上下文继承同理：旧客户端不传时响应保持历史形状（不新增字段）。
        if (!hasInheritContext) delete committedSettings.inheritContext;
        // 单价同理：旧客户端不传时响应保持历史形状（不新增字段）。
        if (!hasModelPrices) delete committedSettings.modelPrices;
        // 并发映射的读取期丢弃诊断同理：它是诊断，不是可回写的配置。
        delete committedSettings.limitDiagnostics;
        // 上下文继承的读取期丢弃诊断同样只是诊断，不是可回写的配置。
        delete committedSettings.inheritContextDiagnostics;
        // 单价读取期丢弃诊断同样只是诊断，不是可回写的配置。
        delete committedSettings.modelPriceDiagnostics;
        // 峰谷读取期丢弃诊断同样只是诊断，不是可回写的配置。
        delete committedSettings.peakValleyDiagnostics;
        // 迁移标记必须随响应回传：客户端据此关闭读取别名，保存 10 之后读回仍是 10。
        // 首次保存时标记刚随 patch 落盘；后续保存时文档里本来就有该标记。
        const committedMigrationVersion = descriptor?.value?.configMigrationVersion;
        if (Number.isSafeInteger(committedMigrationVersion) && committedMigrationVersion >= 1) {
          committedSettings.configMigrationVersion = committedMigrationVersion;
        }
        return {
          settings: committedSettings,
          // 保存成功后直接回传最新只读投影：客户端据此更新基线、dirty 与"已自定义"
          // 标识，不必再发一次 meta 往返，也不需要自己重算默认 persona。
          rolePrompts: describeRolePrompts(committedSettings),
          revision: descriptor?.revision,
        };
      });
    }

  // assertModelPricesCandidate 也被 M5（validateSettingsCandidate）调用，因此一并暴露。
  return { commitSettingsCandidate, assertModelPricesCandidate };
}
