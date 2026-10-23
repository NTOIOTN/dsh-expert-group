/**
 * 组合根顶层的第 S9 段（R1 票据 06）：自 index.js 第 1450–1709 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

import { isReadonlyDynamicMcpName } from "../shared/protocol.js";
import {
  EXPERT_PERSONA_PREFIX_ORDER,
  compositionErrorMessage,
  restrictableDenyNamesInScope,
  restrictableScopeNames,
  EXPERT_PERSONA_PREFIX_SECTION,
  isRegisteredPluginExpertChild,
  isPluginExpertChildOptions,
  CONTINUABLE_MARKER,
  PARENT_MARKER,
  shouldBlockExpertSendMessage,
  ROLE_MARKER,
  DENY_MARKER,
  resolveExpertReportIdentity,
  isPluginExpertChildIdentity,
  shouldBlockExpertDeniedTool,
  shouldBlockExpertReport,
  roleCatalogEntry,
} from "./expert-guards.js";
import {
  installShadowedExpertSendMessage,
  recordExpertShadowStatus,
  SHADOW_STATUS,
  forgetExpertShadowStatus,
} from "./send-message-shadow.js";

/** 解析宿主 SECTION_ORDERS 中的 persona 前缀排序；缺失或非有限值时退回 DSH 固定值 0。 */
function resolvePersonaPrefixOrder(promptService) {
  const order = typeof promptService?.getSectionOrder === "function"
    ? promptService.getSectionOrder("DEPLOYMENT_PERSONA_PREFIX")
    : void 0;
  return Number.isFinite(order) ? order : EXPERT_PERSONA_PREFIX_ORDER;
}

/**
 * 旧 RC1 startLocal 兼容层：把 admission 算出的 child composition 直接补到 child 自己的
 * scoped context 上（persona + 工具 deny 边界）。
 *
 * 为什么需要：部分宿主版本的 RC1 初次创建路径只把 descriptor 写进 child session，不把
 * request.persona / request.toolFilter 应用到 child scope。结果是 expert child 既拿不到
 * 角色系统提示词，又仍然"看得见" send_message；宿主一旦在 child 视图里解析到带 adjacent
 * 标记的 send_message，就会把 parent agent id、send_message 调用说明与结果回传要求追加到
 * 首条任务消息，污染 buildExpertTaskPrompt 的「身份行 + 任务正文」两段结构。
 *
 * 三步（顺序有语义）：
 * ① 在 child 自身作用域注册 send_message 遮蔽定义：own 层遮蔽 inherited，使宿主的
 *    `get("send_message", child)` 解析到不带 adjacent 标记、且 fail-closed 的定义；
 *    随后用对象身份比对判定它是否真的生效。
 * ② 施加 admission 的 deny：只把当前 scope 的 restrictableNames 里的名字交给
 *    tools.restrict()，避免 own 层名称让整次 restriction 抛错。
 * ③ 注册角色 persona section（与宿主 child composition 同名，作用域内遮蔽全局默认项）。
 *
 * 时机：调用点在 agent/created（早于宿主 guidance 判定与首条任务消息提交，也早于第一次
 * system prompt 组装），因此补上的 section、restriction 与遮蔽定义都会被首个模型 step 采用。
 *
 * fail loud 的边界（只对确有证据的一种情况抛错）：
 * - foreign（child 视图确实解析到别人的 send_message 定义）→ 抛错，让 agent/created 监听器
 *   失败并拒绝该 expert child admission（宿主不会写出受污染的首条任务消息）；抛错前回滚本次
 *   已安装的层，并删除该 child 的进程内状态映射，绝不留下半装状态或失败的 child_models 记录。
 * - 其余情况一律不抛错：verified / absent（判定完成，宿主判定不命中）、unavailable（宿主没有
 *   tools.register 能力，保持兼容层 no-op 语义）、unverified（缺 tools.get 或没有 scope，
 *   无法判定）→ 只记录状态 + 告警。
 * - 本函数只对 DEG 认证过的 expert child 生效：root agent 与非 DEG agent 不会走到这里。
 *
 * 幂等与兼容（宿主已正确应用 composition 时必须完全无害）：
 * - shadow 注册按 child scope 幂等：重复安装不重复注册、不抛错。
 * - tools.restrict() 的限制是相交叠加，重复施加不会放宽边界；宿主施加过的那份由宿主
 *   自己的 disposer 负责撤销，这里只撤销自己那一层。
 * - 同名 section 已在该 scope 注册时按「已存在」处理（宿主 scoped section 遮蔽全局同名
 *   项），绝不因重复注册抛错而让 child 创建失败。
 * - 缺少 tools.register / tools.restrict / systemPrompt.section 的宿主或测试替身直接跳过；
 *   除 foreign 外的注册失败也只告警降级。
 *
 * @param {object} childCtx - child Agent 的 scoped context（agent.ctx）。
 * @param {object} [spec] - 兼容层输入。
 * @param {string[]} [spec.deny] - admission 计算出的 deny 清单（可含静态与动态 MCP 名称）。
 * @param {string} [spec.persona] - resolvePersonaForAdmission(role) 的结果，原样注册。
 * @param {object} [spec.scope] - 该 child 的 Agent 对象，作为 tools.view(scope) 的视图作用域
 *   （显式传入，绝不从 childCtx 读未注入的懒 agent getter）；缺失时 restrict 判据退回全局视图。
 * @param {Function} [spec.isVisible] - 没有 restrictableNames 时的可见性探针。
 * @param {object} [spec.logger] - 宿主 logger，仅用于非致命告警。
 * @returns {(() => void)|undefined} 组合 disposer；什么都没安装时返回 undefined，
 *   与 installExpertReportGuard 的 no-op 语义一致（避免被误记为「已安装」而挡住重试）。
 */
export function installExpertChildComposition(childCtx, spec = {}) {
  const disposers = [];
  const warn = (message) => {
    try { spec.logger?.warn?.(message); } catch { /* 日志失败不得影响 child 创建 */ }
  };
  /** 逆序释放本次安装的层；单个失败不阻断其余清理，并清空数组保证只释放一次。 */
  const releaseInstalled = () => {
    for (const dispose of [...disposers].reverse()) {
      try { dispose(); } catch (error) {
        warn("dsh-expert-group: expert child composition fallback cleanup failed: " + compositionErrorMessage(error));
      }
    }
    disposers.length = 0;
  };

  // ① 宿主引导段防线：在 child 自身作用域遮蔽全局 send_message（own 层遮蔽 inherited）。
  // own 层注册天然豁免于 restriction，因此即使下面的 deny 名单仍含 send_message（宿主全局层
  // 提供该名字时它属于 restrictableNames），被隐藏的也只是 inherit 的那份，child 解析到的
  // 始终是本遮蔽定义，宿主 guidance 判定不会再看到 adjacent 标记。
  //
  // 本步同时做生效性判定（对象身份比对，不读宿主 adjacent symbol）：verified / absent 表示
  // 宿主判定一定不命中；unavailable / unverified 无法判定，只记录；只有 foreign（child 确实
  // 解析到别人的定义）才 fail loud —— 此时抛出异常会让 agent/created 监听器失败，而
  // @deepseek-ai/cordis 的 serial 派发对每个监听器 await 且**没有** try/catch（cordis lib
  // 的 serial()），@deepseek-ai/dsh-agent 的 agents.announce 正是用它串行派发：announce/publish
  // 因此拒绝 → 宿主 dispose 该 child → admission 被拒，且宿主不会执行到 subagent-index.js 里
  // 追加 parent/send_message 引导段的那一步（不会产生受污染的首条任务消息）。
  const shadow = installShadowedExpertSendMessage(childCtx, warn, spec.scope);
  if (shadow.dispose !== void 0) disposers.push(shadow.dispose);
  const shadowChildId = recordExpertShadowStatus(spec.scope, shadow.status, shadow.reason);
  if (shadow.status === SHADOW_STATUS.FOREIGN) {
    warn("dsh-expert-group: expert child send_message shadow is not effective (foreign): " + shadow.reason);
    // 回滚本次已安装的层：child 会被宿主 dispose，但 DEG 自己不能留半装状态；
    // 同时删除 childId 状态映射——被拒的 child 不会写 child_models 快照。
    releaseInstalled();
    forgetExpertShadowStatus(shadowChildId);
    throw new Error(
      "dsh-expert-group: 拒绝该 expert child admission —— child 工具作用域解析到的 send_message 不是 DEG 的 fail-closed 遮蔽定义（"
      + shadow.reason + "）。宿主 dsh-subagent 会在提交首条任务消息前读取 tools.get(\"send_message\", child)，"
      + "并在该定义带 adjacent 标记时把「Your parent agent id … send_message …」引导段追加进任务 prompt；"
      + "DEG 拒绝让 expert child 以受污染的任务开场运行。可操作提示：检查是否有其它插件或子层把 send_message 注册进该 child 作用域、"
      + "或宿主 tools.register/view 的遮蔽语义是否已变化，排除冲突后重新派发该任务。",
    );
  }

  // ② 工具边界：尝试施加 admission 的 deny 清单。判据优先取当前 child scope 的
  // restrictableNames（工具服务 restrict() 内部同一判据），拿不到该 API 时才回退到
  // 可见性探针；两条路径都不把 run_code 交给 restrict，也不把 restrict 会拒绝的名字交出去。
  const toolService = childCtx?.tools;
  const denyCandidates = Array.isArray(spec.deny)
    ? [...new Set(spec.deny.filter((name) => typeof name === "string" && name.length > 0 && name !== "run_code"))]
    : [];
  if (denyCandidates.length > 0 && typeof toolService?.restrict === "function") {
    const probe = typeof spec.isVisible === "function"
      ? spec.isVisible
      : typeof toolService?.get === "function" ? (name) => toolService.get(name) !== void 0 : void 0;
    const names = restrictableDenyNamesInScope(denyCandidates, restrictableScopeNames(toolService, spec.scope), probe);
    if (names.length > 0) {
      try {
        const dispose = toolService.restrict({ deny: names });
        if (typeof dispose === "function") disposers.push(dispose);
      } catch (error) {
        // 失败只降级为「schema 未隐藏」：scoped guard 仍按同一份 deny 名单拒绝调用。
        warn("dsh-expert-group: expert child composition fallback could not restrict tools: " + compositionErrorMessage(error));
      }
    }
  }

  // ③ 角色系统提示词：与宿主 child composition 同名 section，作用域内遮蔽全局默认项。
  const promptService = childCtx?.systemPrompt;
  if (typeof spec.persona === "string" && spec.persona.length > 0 && typeof promptService?.section === "function") {
    try {
      const dispose = promptService.section({
        name: EXPERT_PERSONA_PREFIX_SECTION,
        order: resolvePersonaPrefixOrder(promptService),
        text: spec.persona,
      });
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      const message = compositionErrorMessage(error);
      // 同名 section 已在该 scope 注册 = 宿主已经应用过 composition，属于正常情况。
      if (!/already registered/iu.test(message)) {
        warn("dsh-expert-group: expert child composition fallback could not register persona section: " + message);
      }
    }
  }

  if (disposers.length === 0) return void 0;
  return () => {
    // 逆序释放：后注册的先撤销；三类 disposer 来自不同服务，单个失败不阻断其余清理。
    releaseInstalled();
    // 进程内状态只服务活动 child：释放时一并清理，避免 childId 映射跨 child 泄漏
    //（durable 侧仍由 child_models 记录里的 [SHADOW_MARKER] 保留审计痕迹）。
    forgetExpertShadowStatus(shadowChildId);
  };
}

/**
 * PTC nested dispatch 会复制外层 execution.agent；全局 guard 因而必须按当前 Agent
 * 的内部登记、marker 与真实 parentSession 做精确 lineage 校验。这里不读取 snapshot，避免把
 * 已替换或已销毁的 child 误判为当前调用者；Host 侧 subagents.sendMessage 不经过此层。
 */
export function shouldBlockGlobalExpertSendMessage(execution) {
  if (execution?.name !== "send_message") return void 0;
  const agent = execution?.agent;
  let options;
  let parentSession;
  try {
    options = agent?.options;
    parentSession = agent?.session?.header?.parentSession;
  } catch {
    return void 0;
  }
  // marker 只是复制来的 metadata；必须先命中插件登记的 exact Agent 对象。
  // origin 缺失在不同 DSH 版本中是合法情况，因此不把它当作认证凭据。
  if (!isRegisteredPluginExpertChild(agent)
    || !isPluginExpertChildOptions(options)
    || options[CONTINUABLE_MARKER] !== true
    || parentSession !== options[PARENT_MARKER]) return void 0;
  return shouldBlockExpertSendMessage(options, execution, {
    role: options[ROLE_MARKER],
    parentId: options[PARENT_MARKER],
    source: "registered-agent",
  });
}

/**
 * 维护 Host root 的可序列化 generation。generation 使用插件实例级单调序号，
 * 因而即使清理了某个 root id 的当前 Map 项，同 id 后续重建也不会得到旧版本。
 * 只保留当前 live root 的对象引用，避免 registry 持有已销毁 Agent；retire 对旧
 * 对象做精确匹配，迟到的旧 disposed 事件不会删除新 root 的 generation。
 */
export function createRootGenerationRegistry() {
  let nextGeneration = 0;
  const current = new Map();
  return {
    activate(rootId, agent) {
      if (typeof rootId !== "string" || rootId.length === 0 || agent === void 0) return void 0;
      const existing = current.get(rootId);
      if (existing?.agent === agent) return existing.generation;
      const generation = ++nextGeneration;
      current.set(rootId, { agent, generation });
      return generation;
    },
    retire(rootId, agent) {
      const existing = current.get(rootId);
      if (existing?.agent !== agent) return false;
      current.delete(rootId);
      return true;
    },
    generationOf(rootId) {
      return current.get(rootId)?.generation;
    },
    isCurrent(rootId, agent) {
      return current.get(rootId)?.agent === agent;
    },
    clear() {
      current.clear();
    },
  };
}

/**
 * 把 report/send_message 的交付硬防线安装到 continuable child 自有工具层。
 * 非插件 child 返回 no-op，根代理不会经过此 child setup 接缝；快照只在
 * setup 执行时读取，不修改 DSH 的 agent.options。
 */
export function installExpertReportGuard(childCtx, readChildModel, resolvedIdentity, childAgent) {
  // 与全局 guard 保持同一信任边界：身份 marker 不能替代 exact Agent provenance。
  if (!isRegisteredPluginExpertChild(childAgent)) return () => {};
  // childCtx 只提供该 child 自有的 tools guard；Agent 身份从调用方显式传入，
  // 避免读取未注入的 childCtx.agent 懒 getter。
  const options = childAgent?.options;
  const persisted = typeof readChildModel === "function" && typeof childAgent?.id === "string"
    ? readChildModel(childAgent.id)
    : void 0;
  // RC1 child 的 agentOptions 不由 Host recovery 持久化；优先使用当前 marker，
  // cold-resume 则从 DEG 自有 child_models 快照恢复，旧快照继续走静态 fallback。
  const denyOptions = options?.[DENY_MARKER] !== void 0
    ? options
    : persisted?.[DENY_MARKER] !== void 0
      ? { ...options, [DENY_MARKER]: persisted[DENY_MARKER] }
      : options;
  const identity = resolvedIdentity ?? resolveExpertReportIdentity(options, childAgent?.id, readChildModel);
  if (!isPluginExpertChildIdentity(identity)) return () => {};
  return childCtx.tools.guard((execution) => {
    const deniedToolReason = shouldBlockExpertDeniedTool(denyOptions, execution, identity);
    if (deniedToolReason !== void 0) return deniedToolReason;
    const reportReason = shouldBlockExpertReport(options, execution, identity);
    if (reportReason !== void 0) return reportReason;
    const sendMessageReason = shouldBlockExpertSendMessage(options, execution, identity);
    if (sendMessageReason !== void 0) return sendMessageReason;
    // 只读性来自运行期目录（内置 + 自定义）；未知/已删除角色按只读处理（fail-closed），
    // 避免历史/外部角色因目录缺项而获得动态 MCP 访问权。
    const roleEntry = roleCatalogEntry(identity.role);
    if ((roleEntry === void 0 || roleEntry.readOnly === true) && isReadonlyDynamicMcpName(execution?.name)) {
      return "只读专家 child 禁止调用动态 MCP 工具";
    }
    return void 0;
  });
}

