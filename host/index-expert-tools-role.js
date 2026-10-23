/**
 * 入口 role 工具定义与挂载域（R4d · 票据 18）。
 *
 * 这一域负责：
 * - 已构造好的 role-named 工具定义对象（schema / 描述 / render / execute）；
 * - `execute` 的 admission 流水线（句柄边界 → schema → ticket → 路由/deny/persona →
 *   图片 → scope admission → 回执映射）；
 * - Observer 自动图片路由（复用同一 selection / PNG 预处理 / child admission）；
 * - role 工具挂载表（toolDisposers / mountedRoleSignatures）与其指纹刷新判定。
 *
 * ## 铁律（票据 18）
 * 本模块**不接收 ctx**、不调用 `tools.register`：定义对象由本模块构造，注册 effect 与
 * disposer 顺序仍由 `index.js` 在原注册点执行（`ctx.effect(() => tools.register(...))`）。
 *
 * ## 状态唯一 owner
 * 本模块独占 `toolDisposers`（role -> disposer）与 `mountedRoleSignatures`（注册时的
 * 有效定义指纹），以及 `routeImageToObserver`（observer 路由句柄）。对外只暴露命令
 * （prepareMount / commitMount / release）与只读投影（isMounted / mountedRoleIds /
 * signatureOf / routeImageToObserver），容器本体不出模块。
 *
 * @module dsh-expert-group/index-expert-tools-role
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { buildRoleToolDescription } from "../prompt-contracts.js";
import { buildObserverVisualTask } from "../prompt-contracts.js";
import { buildImageContent, decideImageRoute, imageCapability } from "../image-routing.js";
import { delegationScopeKey, delegationTaskKey } from "../shared/structured-path.js";
import { READONLY_DENY } from "../shared/protocol.js";
import { buildExpertTaskPrompt } from "./expert-task-prompt.js";
import { abortErrorFor, throwIfAborted } from "./rpc-request-lifecycle.js";
import {
  CONTINUABLE_MARKER,
  DENY_MARKER,
  EFFORT_MARKER,
  PARENT_MARKER,
  PERSONA_MARKER,
  ROLE_MARKER,
  ensureExpertSendMessageDenied,
} from "./expert-guards.js";
import {
  EXPERT_INHERIT_CONTEXT_MARKER,
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
} from "../shared/model-route.js";
import { OUTPUT_SCHEMA_ERROR_CODES, OUTPUT_SCHEMA_REQUESTED_MARKER } from "../shared/structured.js";

/**
 * Observer 自动图片路由：固定纯视觉任务 + 真实 PNG durable 副本 + 同一 admission 语义。
 *
 * @param {object} deps - 窄能力面（4 组：identity / models / core / storage）。
 * @returns {object} `forRole(role, closure)` 能力。
 */
export function createRoleToolObserverRoute({ identity, models, core, storage }) {
  function forRole(role, closure) {
    const scopeAdmission = {
      serialize: (...args) => closure.serialize(...args),
      delegateWithScopeAdmission: (...args) => closure.delegateWithScopeAdmission(...args),
    };
    const resolvePersonaForAdmission = (...args) => storage.resolvePersonaForAdmission(...args);

    async function observerImageRoute({ parent, image, images, signal, preparedAttachments, onAccepted }) {
      throwIfAborted(signal);
      const rootToken = identity.tokenFor(parent);
      if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
      const resolvedRole = models.resolveRole(parent.id, role);
      if (resolvedRole == null) throw new Error("Observer 专家尚未配置模型，请先在设置页选择 Observer 模型");
      const selection = await models.validateSelectionWithSignal(resolvedRole, signal);
      throwIfAborted(signal);
      let targetInfo;
      try {
        targetInfo = await models.resolveModelInfo(selection.provider, selection.model, signal);
      } catch (error) {
        // 取消不能被"能力查询失败"兜底吞掉：原样上抛，由 mapRpcError 映射为 499。
        const aborted = abortErrorFor(error, signal);
        if (aborted !== void 0) throw aborted;
        throw new Error("Observer 模型 image 能力查询失败，无法安全投递图片；原始输入已保留", { cause: error });
      }
      throwIfAborted(signal);
      if (imageCapability(targetInfo) !== "supported") {
        throw new Error("Observer 模型未明确声明 image 输入能力，无法安全投递图片；原始输入已保留");
      }
      const inputImages = Array.isArray(images) && images.length > 0 ? images : [image];
      const imageAttachments = Array.isArray(preparedAttachments)
        ? preparedAttachments.slice()
        : await Promise.all(inputImages.map((inputImage) => core.prepareRoleImage({ attachment: inputImage }, signal, "Observer")));
      throwIfAborted(signal);
      if (imageAttachments.length === 0) throw new Error("Observer 图片输入不能为空；原始输入已保留");
      // 自动图片入口只给 Observer 派发**纯视觉子任务**：正文固定为视觉契约 + 无用户
      // 文字上下文说明（函数不接受任何用户输入），主任务仍由主代理持有并综合。
      const observerTaskPrompt = buildExpertTaskPrompt("observer", buildObserverVisualTask());
      const promptContent = buildImageContent({ attachments: imageAttachments, text: observerTaskPrompt, role: "Observer" });
      const observerDeny = ensureExpertSendMessageDenied(core.effectiveDeny(parent, READONLY_DENY, true));
      // 自动图片入口也走同一 admission 语义：persona 只解析一次，既交给宿主
      // composition，也写入内部 marker 供冷恢复兜底（绝不进入视觉任务 prompt）。
      const childPersona = resolvePersonaForAdmission("observer");
      // Observer 自动图片路由**永远**使用非继承 provider（票据 29）：Observer 的
      // 安全边界是“只接收视觉任务，不接收用户上下文”，即使设置被外部写成
      // inheritContext.observer=true，这里也强制 spawn，绝不继承父日志。
      const observerSubagentProvider = core.resolveSubagentProviderForRole(role, parent);
      const request = {
        label: "用户图片",
        prompt: promptContent,
        parent,
        subagentProvider: observerSubagentProvider.provider,
        agentOptions: {
          provider: selection.provider,
          model: selection.model,
          [EFFORT_MARKER]: selection.reasoningEffort,
          [ROLE_MARKER]: role,
          [PARENT_MARKER]: parent.id,
          [CONTINUABLE_MARKER]: true,
          [DENY_MARKER]: observerDeny,
          [PERSONA_MARKER]: childPersona,
          [EXPERT_SUBAGENT_PROVIDER_MARKER]: observerSubagentProvider.provider,
          [EXPERT_INHERIT_CONTEXT_MARKER]: observerSubagentProvider.inheritContext,
        },
        persona: childPersona,
        toolFilter: { deny: observerDeny },
        maxDepth: 1,
      };
      const scope = delegationScopeKey(parent.id, role);
      // 去重必须使用与真实 child prompt 相同的规范化 Observer 任务，兼容旧/新包装复用。
      const taskKey = delegationTaskKey(observerTaskPrompt + "\n[images:" + imageAttachments.map((attachment) => attachment.attachmentId).join(",") + "]");
      const routeKey = core.routeKeyOf({
        ...selection,
        subagentProvider: observerSubagentProvider.provider,
        inheritContext: observerSubagentProvider.inheritContext,
      });
      throwIfAborted(signal);
      const outcome = await scopeAdmission.serialize(scope, () => scopeAdmission.delegateWithScopeAdmission({
        scope,
        taskKey,
        routeKey,
        request,
        parent,
        signal,
        label: "用户图片",
        affectedPaths: [],
        allowOverlap: false,
        handoffExpected: false,
        rootToken,
      }));
      // 先把已接受的 child 上报给调用方（admission 之后仍可能因为取消/路由变化失败，
      // 调用方需要 childId 才能用公开 subagents.interrupt 尽力清理这个已创建的 child）。
      if (typeof onAccepted === "function" && outcome?.kind === "continuable" && typeof outcome.subagentId === "string") {
        onAccepted(outcome.subagentId);
      }
      // admission 之后再次 fail-fast：客户端已取消时不得把已启动的 Observer 当成功返回
      // （child 已创建无法撤回，但结果必须保持 gateway/cancelled 语义）。
      throwIfAborted(signal);
      if (outcome?.kind !== "continuable" || typeof outcome.subagentId !== "string") {
        throw new Error(outcome?.warning ?? outcome?.reason ?? "Observer 图片 admission 未接受");
      }
      return { childId: outcome.subagentId, attachments: imageAttachments, reused: outcome.reused === true };
    }

    return observerImageRoute;
  }

  return { forRole };
}

/**
 * role 工具的 execute 流水线。
 *
 * @param {object} deps - 窄能力面（6 组：records / core / models / roles / storage / identity）。
 * @returns {object} `forRole(role, closure)` 能力。
 */
/**
 * role 工具执行入口：句柄边界 → schema 校验 → admission ticket → 派发 → 回执映射。
 *
 * @param {object} deps - 窄能力面（3 组：records / identity / dispatch）。
 * @returns {object} `forRole(role, closure)` 能力。
 */
export function createRoleToolExecute({ records, identity, dispatch, core }) {
  function forRole(role, closure) {
    // 句柄校验来自同一 role 闭包（无状态）。
    const handles = {
      readExplicitHandle: (...args) => closure.readExplicitHandle(...args),
      describeHandleValue: (...args) => closure.describeHandleValue(...args),
      rejectedHandleResult: (...args) => closure.rejectedHandleResult(...args),
    };
    // 派发分组按同一 role/closure 绑定（与挂在闭包里语义一致）。
    const dispatchApi = dispatch.forRole(role, closure);

    /**
     * 结构化声明预校验（admission 之前）：返回 {declaration} 或 {rejected}。
     *
     * @param {object} args - 工具入参。
     * @returns {{declaration?: object, rejected?: object}}
     */
    function validateOutputSchema(args) {
      try {
        return { declaration: core.normalizeOutputSchemaDeclaration(args?.outputSchema, role) };
      } catch (error) {
        return {
          rejected: handles.rejectedHandleResult(
            "schema",
            error?.code ?? OUTPUT_SCHEMA_ERROR_CODES.INVALID,
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    }


    /**
     * 显式取消（cancelChildId）：按 childId 精确定位并请求取消，不派发、不投递。
     *
     * @param {{childId:string, parent:object}} input - exact childId 与调用方 root Agent。
     * @returns {Promise<object>} cancelled / rejected 回执（不带 admission 凭据）。
     */
    async function cancelChild({ childId, parent }) {
      if (!core.spawnProviderReady()) {
        throw new Error(`subagent provider "spawn" is not available (missing a supported activation seam/provider capabilities/prepareContinuable); the ${role} expert tool cannot cancel a child`);
      }
      const cancelled = await closure.cancelExplicitChild({
        childId,
        parent,
        scope: delegationScopeKey(parent.id, role),
      });
      return cancelled.ok === true
        ? { kind: "cancelled", started: false, accepted: true, cancelled: true, childId: cancelled.childId }
        : handles.rejectedHandleResult("child-not-found", "CHILD_NOT_FOUND", cancelled.warning);
    }


    async function execute(args, exec) {
        const parent = exec?.agent;
        const signal = exec?.signal;
        if (!parent) throw new Error(`${role} subagent tool requires a calling agent (exec.agent was undefined)`);
        const rootToken = identity.tokenFor(parent);
        if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        // 插件委派工具只属于根/父代理。子代理即使因运行时工具合并而看见
        // role-named expert tools，也必须在执行边界被拒绝，避免再次自我委派或绕过父代理编排。
        if (parent.session?.header?.parentSession !== void 0) {
          throw new Error(`${role} is root-only; child agents are leaf workers and must report to their parent`);
        }
        // 显式句柄（cancelChildId / childId）的输入边界：字段只要**存在**就必须是合法的
        // 非空、非纯空白字符串。空串/纯空白/非字符串一律 fail-closed，绝不被当作「未提供」
        // 而继续普通派发或新建 child。校验发生在 beginRootAdmission 之前：被拒绝的句柄不
        // 登记任何 admission、不产生凭据、也绝不 interrupt 或派发（见 rejectedHandleResult）。
        const cancelHandle = handles.readExplicitHandle(args, "cancelChildId");
        if (cancelHandle.invalid === true) {
          return handles.rejectedHandleResult(
            "invalid-child-id",
            "INVALID_CANCEL_CHILD_ID",
            role + " 取消被拒绝：cancelChildId 必须是非空字符串（收到 " + handles.describeHandleValue(args?.cancelChildId)
              + "）；本次调用没有取消任何 child、也没有派发任何任务。要取消请传入此前回执里的 subagentId，"
              + "或者完全省略 cancelChildId",
          );
        }
        const continueHandle = handles.readExplicitHandle(args, "childId");
        if (continueHandle.invalid === true) {
          return handles.rejectedHandleResult(
            "invalid-child-id",
            "INVALID_CHILD_ID",
            role + " 续作被拒绝：childId 必须是非空字符串（收到 " + handles.describeHandleValue(args?.childId)
              + "）；本条 prompt 没有派发。要续作请传入此前回执里的 subagentId，或完全省略 childId 派发新任务",
          );
        }
        // 显式取消（cancelChildId）优先于续作 childId，并且在 beginRootAdmission **之前**
        // 处理：它只按 childId 精确定位并请求取消，不派发任务、不投递消息、不登记新
        // admission，因此既不产生 finalize 需要收口的 token，也不会把 root 的当前
        // admission 批次留成未结算状态。缺少前置条件时 fail-closed。
        // 未知/越权目标返回无凭据的 rejected：它同样没有登记 admission，用带凭据的
        // advisory 会伪造出「已为这个 child 开了一批要 finalize 的 admission」的假象。
        // 显式取消（cancelChildId）优先于续作 childId，并且在 beginRootAdmission **之前**
        // 处理：它只按 childId 精确定位并请求取消，不派发任务、不投递消息、不登记新 admission。
        // 该分支整体在 dispatch 域里（provider 就绪判定与 child 定位同源）。
        if (cancelHandle.present === true) return cancelChild({ childId: cancelHandle.value, parent });
        // 结构化声明（票据 30）：先在 admission 之前做完整的形状/子集/64KiB 校验。
        // 被拒绝的声明没有登记任何 admission、没有创建 child，因此回执不带凭据。
        const schemaResult = validateOutputSchema(args);
        if (schemaResult.rejected !== undefined) return schemaResult.rejected;
        const outputSchemaDeclaration = schemaResult.declaration;

      const admissionTicket = records.beginRootAdmission(parent);
      const phase = { value: "provider" };
      try {
        const result = await dispatchApi.runRoleAdmission({
          args,
          signal,
          parent,
          rootToken,
          admissionTicket,
          outputSchemaDeclaration,
          continueHandle,
          phase,
        });
        if (result.rejected !== undefined) return result.rejected;
        const outcome = result.outcome;
        // role tool 只返回 admission 结果；root turn 等待由显式 finalize 处理。
        const admissionFields = { admissionEpoch: admissionTicket.epoch, admissionToken: admissionTicket.token };
        const visibleOutcome = outcome.kind === "advisory"
          ? { ...outcome, ...admissionFields }
          : {
            kind: "continuable",
            started: true,
            accepted: true,
            ...admissionFields,
            subagentId: outcome.subagentId,
            ...(typeof outcome.messageId === "string" ? { messageId: outcome.messageId } : {}),
            ...(outcome.reused === true ? { reused: true } : {}),
            ...(outcome.queued === true ? { queued: true } : {}),
            // 两个 scopeWarning 来源（delegationTracker 的范围软警告 + 忽略占位 image
            // 的提示）必须拼接而不是互相覆盖：对象展开的后者覆盖前者会让范围软警告
            // 对模型不可见（审核发现的既有缺陷）。任一为空时保持另一段原文。
            ...(result.scopeWarning.length === 0 ? {} : { scopeWarning: result.scopeWarning }),
          };
        records.recordRootAdmissionOutcome(admissionTicket, {
          ...outcome,
          continueParentTurn: args.continue_parent_turn === true,
        });
        admissionTicket.settle();
        return visibleOutcome;
      } catch (error) {
        const failure = records.roleAdmissionFailure(phase.value, error);
        const visibleFailure = {
          kind: "failure",
          started: false,
          accepted: false,
          admissionEpoch: admissionTicket.epoch,
          admissionToken: admissionTicket.token,
          ...failure,
        };
        records.recordRootAdmissionOutcome(admissionTicket, visibleFailure);
        admissionTicket.settle();
        return visibleFailure;
      }
    }

    return { execute };
  }

  return { forRole };
}

/**
 * role 工具的 admission 派发：取消、schema 校验、路由/deny/persona/request、scope 准入。
 *
 * @param {object} deps - 窄能力面（6 组：core / models / roles / storage / records / identity）。
 * @returns {object} `forRole(role, closure)` 能力。
 */
export function createRoleToolDispatch({ core, models, roles, storage, records, identity }) {
  /**
   * admission 主流程：provider 就绪 → 路由 → deny/persona → request → scope 准入。
   *
   * 放在工厂作用域（而非 forRole 内）是为让每个函数体都落在 200 行硬上限内：
   * role 与闭包由调用方显式传入，语义与挂在闭包里完全一致。
   *
   * @param {string} role - 角色 id。
   * @param {object} closure - role 闭包（serialize / delegate / 句柄校验）。
   * @param {object} input - 一次调用的入参、ticket 与失败阶段引用。
   * @returns {Promise<{outcome?: object, scopeWarning?: string, rejected?: object}>}
   */
  async function runRoleAdmission(role, closure, { args, signal, parent, rootToken, admissionTicket, outputSchemaDeclaration, continueHandle, phase }) {
      const { resolveContinueTarget, rejectedHandleResult } = closure;
      const scopeAdmission = {
        serialize: (...args) => closure.serialize(...args),
        delegateWithScopeAdmission: (...args) => closure.delegateWithScopeAdmission(...args),
      };
        if (!core.spawnProviderReady()) {
          throw new Error(`subagent provider "spawn" is not available (missing a supported activation seam/provider capabilities/prepareContinuable); the ${role} expert tool cannot start a child`);
        }
        phase.value = "selection";
        // 启动前路由（票据 24）：primary -> 有序候选，只对预检类失败降级；
        // 全部失败抛 MODEL_CANDIDATES_EXHAUSTED，绝不在此处发起任何模型请求。
        // 真实 image 任务把“需要 image 输入”带进路由：主模型不支持时跳过候选，
        // 而不是等 admission 才拒绝。占位/空 image 不要求能力（与下面的忽略逻辑一致）。
        const route = await models.resolveRoleModelRoute(role, parent.id, signal, core.imageRequirementsOf(args.image));
        if (route === null) {
          throw new Error(`${role} 专家尚未配置模型：请在“dsh-expert-group”设置页为该角色选择模型（候选来自设置中已添加的模型）；右侧「专家模型」侧边栏仅用于当前会话点击“应用”`);
        }
        const selection = route.selection;
        if (!identity.isLiveGeneration(parent, rootToken)) throw new Error("root generation is no longer live");
        // 所有专家（含 designer/fixer）都禁止再委派（防孙代理）；只读角色再叠加
        // 写/命令限制。deny 列表必须按“当前组合里实际可见的工具”动态计算：
        // 平台门控的 bash/pwsh 与 preset 域内的 workflow 可能不存在，
        // 静态全量列入会在子代理创建窗口触发 tools.restrict 的未知工具错误。
        // 保留历史再委派 deny 的调用边界（只读再叠加写/命令限制）。
        const deny = core.expertDenyForAdmission(parent, roles.require(role));
        // send_message 是 scope-local 工具，不能依赖 effectiveDeny 的全局可见性判断；
        // 显式加入 child filter 后，DSH 不会再向专家追加英文通信指令。
        const childDeny = ensureExpertSendMessageDenied(deny);
        const taskPrompt = buildExpertTaskPrompt(role, args.prompt);
        phase.value = "admission";
        let promptContent = [{ type: "text", text: taskPrompt }];
        let imageAttachment;
        // 主代理在没有真实图片时也可能构造 image 参数（attachmentId 为空串/全零
        // 尺寸，或显式命名为 "placeholder"）。这类输入不代表任何真实图片，按
        // “无图片”处理：忽略该参数、正常拉起子代理，并在返回中附带 scopeWarning
        // 提醒模型下次完全省略，而不是让整个 admission 失败导致子代理拉不起来。
        let ignoredImageWarning = "";
        if (args.image !== void 0) {
          const imageRole = role === "observer" ? "Observer" : role;
          if (Object.prototype.hasOwnProperty.call(args.image, "pngPath")
            && typeof args.image.pngPath === "string" && args.image.pngPath.length > 0) {
            throw new Error(`${imageRole} image 不接受客户端提供的 pngPath；原始输入已保留`);
          }
          // 空值/非对象输入不携带任何图片信息，同样按无图片处理。
          const looksEmpty = args.image === null || typeof args.image !== "object" || Array.isArray(args.image)
            || core.isEmptyImagePlaceholderMeta(args.image.attachment);
          if (looksEmpty) {
            ignoredImageWarning = `${imageRole} image 参数为空或占位元数据，已按“无图片”处理并忽略该参数；之后没有图片时请完全省略（omit）image 参数，不要构造占位 attachment 元数据`;
          } else {
            // 直接图片 admission 必须建立在目标 role 的模型明确声明 image 能力上；unknown 也拒绝，
            // 避免把图片交给可能只支持文本的 child。
            // 路由阶段已经为真实 image 派发探测过能力：优先复用 route.capabilities，
            // 避免二次 resolveModelInfo；只有 route 没有能力信息时才回退到原查询。
            let targetInfo = route.capabilities;
            if (targetInfo === undefined || targetInfo === null) {
              try {
                targetInfo = await models.resolveModelInfo(selection.provider, selection.model, signal);
              } catch (error) {
                throw new Error(`${imageRole} 模型 image 能力查询失败，无法安全投递图片；原始输入已保留`, { cause: error });
              }
            }
            const imageRoute = decideImageRoute({
              // 直接 role tool 使用同一三态路由函数作为严格能力断言；返回的 target
              // 只用于判断是否可安全投递，不会把图片改路由到 Observer。
              mainImage: "unsupported",
              observerImage: imageCapability(targetInfo),
              observerPreferred: true,
            });
            if (imageRoute.target === "error") {
              const message = role === "observer"
                ? imageRoute.message
                : `${imageRole} 模型未明确声明 image 输入能力，无法安全投递图片；`;
              throw new Error(`${message} 原始输入已保留`);
            }
            imageAttachment = await core.prepareRoleImage(args.image, signal, imageRole);
            promptContent = buildImageContent({
              attachment: imageAttachment,
              text: taskPrompt,
               role: imageRole,
            });
          }
        }
        // persona 在 admission 边界**只解析一次**：同一个值既交给宿主 composition
        // (request.persona)，也写入内部 marker 供 agent/created 持久化与冷恢复兜底。
        // 设置页保存的自定义提示词只影响之后新建的 child，既有 running/idle/ready
        // child 保持创建时的 persona；marker 绝不进入任务 prompt。
        const childPersona = storage.resolvePersonaForAdmission(role);
        // 目标 subagent provider（票据 29）在 admission 边界解析一次：Observer 永远
        // spawn；开启继承的角色必须拿到合格的 fork provider 且父日志已有已完成 turn，
        // 否则显式失败（resolveSubagentProviderForRole 抛出稳定 code），绝不静默降级。
        const subagentTarget = core.resolveSubagentProviderForRole(role, parent);
        // 目标 provider 必须显式声明 outputSchema 能力；不支持时拒绝派发，
        // 绝不静默把结构化请求退化成纯文本（错误在 admission 失败通道返回稳定 code）。
        if (outputSchemaDeclaration !== undefined) {
          core.assertOutputSchemaProviderSupport(subagentTarget.provider, role);
        }
        const request = {
          label: args.description,
          prompt: promptContent,
          parent,
          // 内部字段：只供 startExpertActivation 选择宿主 provider，调用宿主前剥离。
          subagentProvider: subagentTarget.provider,
          agentOptions: {
            provider: selection.provider,
            model: selection.model,
            [EFFORT_MARKER]: selection.reasoningEffort,
            // 目标 subagent provider / 继承开关 marker（票据 29）：随 child_models 落盘，
            // 恢复/重建只读它，不按当前设置重新选择。
            [EXPERT_SUBAGENT_PROVIDER_MARKER]: subagentTarget.provider,
            [EXPERT_INHERIT_CONTEXT_MARKER]: subagentTarget.inheritContext,
            // 实际路由（票据 24）：candidateIndex=0 表示 primary；fallbackCount 与
            // lastRouteErrorCode 随 child_models 落盘，侧栏/恢复只读该快照。
            [EXPERT_ROUTE_MARKER]: models.routeMarkerOf(route),
            // 角色/父代理 marker：agent/created 时与模型快照一同持久化，
            // 供重启后按 parentId+role+route 恢复可复用 child。
            [ROLE_MARKER]: role,
            [PARENT_MARKER]: parent.id,
            // RC1 会把 request.toolFilter 应用到 child composition（childCtx.tools.restrict），
            // 同时把同一份 admission deny 边界随 child options 传入 DEG 私有 runtime guard：
            // 前者在创建窗口生效，后者在 child 生命周期内持续生效并在冷恢复后重建。
            [DENY_MARKER]: childDeny,
            // 同一份 persona 的内部快照：Host 不持久化 RC1 agentOptions，因此它会随
            // child_models 落盘，供冷恢复重建时优先于当前 settings 覆盖。
            [PERSONA_MARKER]: childPersona,
          },
          // 两个字段都是 child composition 注入项：RC1 由宿主应用到 child 系统提示词
          // section 与 childCtx.tools.restrict，legacy provider 仍按自身 capability 消费。
          persona: childPersona,
          toolFilter: { deny: childDeny },
          // 第二道硬防线：专家是叶子工作者，maxDepth 1 禁止其再创建孙代理
          // （子代理 depth 为 1，再委派 depth 2 会触发 SubagentDepthError）。
          maxDepth: 1,
          // schema 原文只进入宿主派发请求；内部 marker 只记录“声明过”，供
          // agent/created / persistChildDispatch 写入 outputSchemaRequested。
          ...(outputSchemaDeclaration === undefined ? {} : { outputSchema: outputSchemaDeclaration.schema }),
        };
        if (outputSchemaDeclaration !== undefined) {
          request.agentOptions[OUTPUT_SCHEMA_REQUESTED_MARKER] = true;
          core.markStructuredRequest(request, { requested: true, notRestored: false });
        }
        // 所有专家委派统一走可续接（continuable）子代理：
        // 无条件写入 continuable 标记，agent/created 据此持久化，重启恢复
        // 只接受带标记的 child（无 one-shot 路径）。
        request.agentOptions[CONTINUABLE_MARKER] = true;
        // 按 parent.id + role 进入临界区做去重与复用（所有模式共用，不绕过）。
        const scope = delegationScopeKey(parent.id, role);
        const taskInput = imageAttachment?.attachmentId
          ? `${taskPrompt}\n[image:${imageAttachment.attachmentId}]`
          : taskPrompt;
        const taskKey = delegationTaskKey(taskInput);
        // routeKey 纳入目标 provider 与继承开关（票据 29）：继承开关变化必然改变
        // route，既有 spawn child 不会被当作同一 route 静默续作/复用。
        const routeKey = core.routeKeyOf({
          ...selection,
          subagentProvider: subagentTarget.provider,
          inheritContext: subagentTarget.inheritContext,
        });
        // run_in_background 只保留为兼容输入；省略、true、false 都统一走
        // 非阻塞 admission。是否结束当前 root turn 只由 continue_parent_turn 决定。
        const handoffExpected = args.continue_parent_turn !== true;
        // 显式续作句柄：只接受本 root 该角色已登记的 childId。校验失败直接返回
        // advisory，绝不回落到「当前 scope 最近 child」或新建 child。
        // 续作句柄的存在性/合法性已在上面的 pre-admission 边界判定：这里 present 即
        // 一定是合法的非空字符串，非法形态永远不会走到这一步（不会静默变成新建）。
        const continueRequested = continueHandle.present === true;
        const resolvedContinue = continueRequested
          ? resolveContinueTarget({ childId: continueHandle.value, parent, scope, taskKey, currentRouteKey: routeKey })
          : { target: void 0, warning: "" };
        if (continueRequested && resolvedContinue.target === void 0) {
          // 未知/越权但格式合法的 childId：绝不派发、绝不投递、绝不 interrupt，也绝不
          // 回落到「当前 scope 最近 child」或静默改成新建。
          //
          // 返回值必须**不带** admission 凭据：带 admissionEpoch/admissionToken 的
          // advisory 会伪造出「已为它开了一批要 finalize 的 admission」的假象，让模型
          // 把一次纯拒绝当成真实 child admission 去收口。
          //
          // 同时必须把上面已经 begin 的内部 ticket 记录为已拒绝并 settle（见
          // discardRootAdmission）：否则本批会永久停在 admission-outcome-pending，
          // 而该 token 又从未交给调用方，最终把整个 root 批次毒化成无法收口。
          records.discardRootAdmission(admissionTicket, {
            kind: "rejected",
            reason: "child-not-found",
            code: "CHILD_NOT_FOUND",
          });
          return { rejected: rejectedHandleResult("child-not-found", "CHILD_NOT_FOUND", resolvedContinue.warning) };
        }

        // 所有输入形态都只等待 scope/admission、必要的 child 投递和 Goal pause CAS，
        // 绝不等待 child 的最终文本、turn/end、自动恢复或 feedback。
        const outcome = await scopeAdmission.serialize(scope, () =>
          scopeAdmission.delegateWithScopeAdmission({
            scope, taskKey, routeKey, request, parent, signal: signal, label: args.description,
            queue: args.queue === true, affectedPaths: args.affectedPaths, allowOverlap: args.allowOverlap === true,
            handoffExpected, rootToken,
            explicitChildId: resolvedContinue.target?.childId,
          }));
      return { outcome, scopeWarning: core.mergeScopeWarnings(outcome.scopeWarning, ignoredImageWarning) };
  }

  function forRole(role, closure) {
    return { runRoleAdmission: (input) => runRoleAdmission(role, closure, input) };
  }

  return { forRole };
}

/**
 * role-named 工具定义对象（schema / 描述 / render / execute）。
 *
 * @param {object} deps - 窄能力面（2 组：roles / execute）。
 * @returns {object} `definitionFor(role, closure)` 能力。
 */
export function createRoleToolDefinition({ roles, execute }) {
  function definitionFor(role, closure) {
    const executeApi = execute.forRole(role, closure);
    return defineTool({
      name: role,
      description: buildRoleToolDescription(role, roles.roleCatalog()),
      parameters: {
        description: {
          type: "string",
          required: true,
          description: "A 3-5 word task label.",
        },
        prompt: {
          type: "string",
          required: true,
          description: "A complete self-contained task for the expert child.",
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
          description: "Optional structured-output JSON Schema (object root, dsh-tools enforced subset). When set, the child must return a structured result matching it; DEG validates the declaration before dispatch (invalid, >64KiB UTF-8, or an unsupported provider is rejected and no child is created). The schema is passed through to the host request and is never written to event history or snapshots; the structured result is read-only and does not change the expert's final text summary contract.",
        },
        affectedPaths: {
          type: "array",
          items: { type: "string" },
          description: "Optional files, directories (trailing slash or dir:), or symbols (symbol:). Omit only when scope cannot be checked.",
        },
        image: {
          type: "object",
          additionalProperties: false,
          description: "Optional image attachment. Provide this parameter ONLY when forwarding a real image attachment from the current conversation; omit it entirely when there is no image and never fabricate or placeholder-fill attachment metadata. The Host makes a real PNG durable copy for extensionless names. Do not guess a path.",
          properties: {
            attachment: {
              type: "object",
              required: true,
              additionalProperties: false,
              properties: {
                attachmentId: { type: "string", required: true },
                mediaType: { type: "string", enum: ["image/png", "image/jpeg", "image/webp", "image/gif"], required: true },
                bytes: { type: "integer", required: true },
                width: { type: "integer", required: true },
                height: { type: "integer", required: true },
                name: { type: "string" },
              },
            },
          },
        },
        allowOverlap: {
          type: "boolean",
          default: false,
          description: "Set true only when an affected-path overlap is explicitly safe; otherwise a conflict returns an advisory without child action.",
        },
        run_in_background: {
          type: "boolean",
          description: "Compatibility input only: omitted, true, and false all use non-blocking admission; false never waits for child output or feedback.",
        },
        continue_parent_turn: {
          type: "boolean",
          default: false,
          description: "Set true only for explicitly confirmed immediate independent work with non-overlapping affectedPaths; otherwise leave false and inspect outcomes before root-only finalize.",
        },
        queue: {
          type: "boolean",
          default: false,
          description: "Only meaningful together with childId (an explicit continuation): queue=true delivers the follow-up through the public subagents.sendMessage path and never requests a cancel; queue=false may first request a public interrupt for an explicit pause/redirect. Without childId the value is ignored because a different prompt always starts an independent child. This is not a waiting mechanism; DSH delivers feedback later.",
        },
        childId: {
          type: "string",
          description: "Optional explicit continuation handle: the subagentId returned by an earlier role-tool admission. When set, this prompt is delivered to exactly that child. Omit it to dispatch a brand-new independent task: a different prompt never continues or redirects an existing child on its own.",
        },
        cancelChildId: {
          type: "string",
          description: "Optional explicit cancel handle: request cancellation of exactly this child (public subagents.interrupt) without dispatching a task or sending any message. Takes precedence over childId. Cancelling is always addressed by an exact childId; this tool never guesses a target from the parent session and role, so other independent children stay running.",
        },
      },
      output: {
        schema: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "continuable" },
                started: { type: "boolean" },
                accepted: { type: "boolean" },
                admissionEpoch: { type: "number", required: true },
                admissionToken: { type: "string", required: true },
                subagentId: { type: "string", required: true },
                // startContinuable/sendMessage 的 admission messageId 是调用方关联 turn 的公开结果。
                // 旧快照复用且没有任务绑定时可能没有新消息，因此保持可选。
                messageId: { type: "string" },
                // 可选标志：reused = 重复任务复用既有 child（未排队）；
                // queued = 已排队到既有 child。二者都保持 started 文案兼容。
                reused: { type: "boolean" },
                queued: { type: "boolean" },
                scopeWarning: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "advisory" },
                started: { type: "boolean", required: true, const: false },
                accepted: { type: "boolean", required: true, const: false },
                admissionEpoch: { type: "number", required: true },
                admissionToken: { type: "string", required: true },
                reason: { type: "string", required: true },
                code: { type: "string", required: true },
                warning: { type: "string", required: true },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "failure" },
                started: { type: "boolean", required: true, const: false },
                accepted: { type: "boolean", required: true, const: false },
                admissionEpoch: { type: "number", required: true },
                admissionToken: { type: "string", required: true },
                reason: { type: "string", required: true },
                code: { type: "string", required: true },
                message: { type: "string", required: true },
              },
            },
            {
              // 显式句柄（childId / cancelChildId）在 admission 之前被拒绝：没有登记新
              // admission、没有创建或投递任何 child，因此**不带** admissionEpoch/
              // admissionToken。用独立 kind 与带凭据的 advisory/continuable 明确区分：
              // 伪造凭据会让模型把它当成真实 child admission 并拿去 finalize。
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "rejected" },
                started: { type: "boolean", required: true, const: false },
                accepted: { type: "boolean", required: true, const: false },
                reason: { type: "string", required: true },
                code: { type: "string", required: true },
                warning: { type: "string", required: true },
              },
            },
            {
              // 显式取消（cancelChildId）的结果：只报告按 childId 定位的取消请求，
              // 既不是新 admission 也不是失败，因此保持独立变体。
              type: "object",
              additionalProperties: false,
              properties: {
                kind: { type: "string", required: true, const: "cancelled" },
                started: { type: "boolean", required: true, const: false },
                accepted: { type: "boolean", required: true, const: true },
                cancelled: { type: "boolean", required: true, const: true },
                childId: { type: "string", required: true },
              },
            },
          ],
        },
        render(_args, value) {
          // admissionEpoch/admissionToken 是 root-only finalize 收口必需的公开凭据，必须
          // 出现在模型可见的 render 文本里：epoch 是模块级单调计数器（跨会话累计、重启
          // 归零），模型既无法从其他工具返回中读到、也无法推断；schema 的 continuable/
          // advisory/failure 三个变体都把它们标注为 required，但只渲染人性化文案会让模型
          // 只能靠猜 token 反复调用 finalize
          // （线上实测：连续 5 次匹配失败）。这里统一追加，保持单行紧凑文本。
          // 取消结果不携带 admission 凭据（它不进 admission 批次），因此只在凭据
          // 确实存在时追加后缀；其余变体保持既有文案与凭据位置不变。
          const admission = Number.isSafeInteger(value.admissionEpoch)
            ? ' (admissionEpoch: ' + value.admissionEpoch + ', admissionToken: "' + value.admissionToken + '")'
            : "";
          if (value.kind === "advisory") return [{ type: "text", text: value.warning + admission }];
          // 显式句柄在 admission 之前被拒绝：没有 admission 凭据可渲染，只报可读原因。
          if (value.kind === "rejected") return [{ type: "text", text: value.warning }];
          if (value.kind === "failure") return [{ type: "text", text: `${role} admission failed: ${value.message}${admission}` }];
          // 取消是按 childId 定位的独立动作：文案必须点名被取消的 child，避免模型
          // 以为这是对「当前角色」的批量操作。
          if (value.kind === "cancelled") return [{ type: "text", text: `cancelled ${role} subagent ${value.childId}: cancel requested for the exact childId${admission}` }];
          const notice = typeof value.scopeWarning === "string" && value.scopeWarning.length > 0
            ? [{ type: "text", text: value.scopeWarning }]
            : [];
          // 复用/排队与新建使用不同的明确文案；保持原有 started 文案兼容。
          if (value.reused === true) {
            return [...notice, { type: "text", text: `reused ${role} subagent ${value.subagentId}: duplicate task detected, no new prompt queued${admission}` }];
          }
          if (value.queued === true) {
            return [...notice, { type: "text", text: `steered ${role} subagent ${value.subagentId} at next-step${admission}` }];
          }
          return [...notice, { type: "text", text: `started ${role} subagent ${value.subagentId}${admission}` }];
        },
      },
      // 角色工具会修改 admission、handoff、recovery、settings 和 storage 状态。
      // 不声明 isConcurrencySafe，让 DSH 以默认 exclusive 模式调度，避免把这些
      // 共享状态写入误判为可与兄弟工具并行执行。
      execute: executeApi.execute,
    });
  }

  return { definitionFor };
}

/**
 * role 工具挂载表：挂载判定、注册回填、卸载与定义指纹。
 *
 * @param {object} deps - 窄能力面（6 组：closures / definition / observerRoute / core / roles / logger）。
 * @returns {object} 挂载能力面。
 */
export function createIndexExpertRoleTools({ closures, definition, observerRoute, core, roles, logger }) {
  /** 已挂载角色对应的工具注销器；注册必须归当前 ctx Fiber 所有。 */
  const toolDisposers = new Map();
  /** 已挂载角色工具的「有效定义指纹」（票据 27 补强）。 */
  const mountedRoleSignatures = new Map();
  let routeImageToObserver;

  /**
   * 角色有效定义的稳定指纹（只覆盖影响工具描述/静态元数据的字段）。
   *
   * @param {object|undefined} entry - 运行期目录里的角色记录。
   * @returns {string} 可逐字比较的 JSON 指纹；未知角色返回空串。
   */
  function roleDefinitionSignature(entry) {
    if (entry === null || typeof entry !== "object") return "";
    return JSON.stringify([
      entry.id ?? "",
      entry.label ?? "",
      entry.statusLabel ?? "",
      entry.description ?? "",
      entry.persona ?? "",
      entry.readOnly === true,
      Array.isArray(entry.toolDeny) ? entry.toolDeny : [],
    ]);
  }

  /**
   * 挂载前置判定（provider 就绪 / 已挂载 / 角色存在），并构造定义对象与 observer 路由。
   *
   * @param {string} role - 角色 id。
   * @returns {{definition: object, label: string}|null} 已构造的定义对象；不该挂载时 null。
   */
  function prepareMount(role) {
    // 对齐 dsh-tool-subagent：provider 缺失或能力不足时不注册工具，等 provider-added 再挂载。
    if (toolDisposers.has(role)) return null;
    if (!core.spawnProviderReady()) return null;
    // 未注册角色不挂载工具（内置角色目录是唯一角色来源）；
    // persona 在 admission 边界解析，因此这里不再缓存角色人格快照。
    if (!roles.roleCatalog().has(role)) return null;
    const closure = closures.forRole(role);
    // 浏览器原生提交会通过私有的 sendSession 进入 Host RPC；Observer 路由复用与
    // role tool 相同的 selection、PNG 预处理和 child admission，避免自动图片入口
    // 另起一套未经持久化/去重的子代理生命周期。
    if (role === "observer") routeImageToObserver = observerRoute.forRole(role, closure);
    return { definition: definition.definitionFor(role, closure), label: "dsh-expert-group: tool " + role };
  }

  /** 注册成功后回填 disposer 与定义指纹（调用点在 index.js 的 effect 之后）。 */
  function commitMount(role, disposeTool) {
    toolDisposers.set(role, disposeTool);
    // 记录挂载时的有效定义：目录同步据此判断是否需要重挂载（描述/静态元数据刷新）。
    mountedRoleSignatures.set(role, roleDefinitionSignature(roles.roleCatalog().get(role)));
  }

  /** 卸载某角色工具及其 effect；幂等。 */
  function release(role) {
    if (role === "observer") routeImageToObserver = void 0;
    const dispose = toolDisposers.get(role);
    if (dispose === void 0) return;
    toolDisposers.delete(role);
    mountedRoleSignatures.delete(role);
    try { dispose(); } catch (error) {
      logger.warn(`dsh-expert-group: dispose tool ${role} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    prepareMount,
    commitMount,
    release,
    roleDefinitionSignature,
    isMounted: (role) => toolDisposers.has(role),
    mountedRoleIds: () => [...toolDisposers.keys()],
    signatureOf: (role) => mountedRoleSignatures.get(role),
    // 只读投影：RPC 图片路由按值取当前 observer 路由（未挂载时为 undefined）。
    routeImageToObserver: () => routeImageToObserver,
  };
}
