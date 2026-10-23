/**
 * 原生会话状态 DOM 文案定位。
 *
 * 在宿主渲染的会话状态行里按 session/role 作用域定位文本节点，供状态文案重写使用。
 * 本文件由原 `shared.js` 的 2898–3318 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/status-dom
 */
import { STATUS_ROLE_LABELS, isPluginChildSession, normalizeStatusRole } from "./prompts.js";
import { replaceNativeStatusPrefix } from "./native-text.js";

/**
 * CSS Module 稳定局部名匹配：只认局部名本身，不绑定构建 hash 形态。
 * Vite 默认产物是 `_label_hash_line`，旧夹具/其它工具链是 `hash_label`；两种形状都只依赖
 * 局部名，因此既不能硬编码完整 hash，也不能只认某一种前后缀拼接。
 * @param {string|undefined} className - 元素的 class 属性值。
 * @param {string} localName - CSS Module 局部名（turnStatus / label / visuallyHidden）。
 * @returns {boolean} 任一 class token 的局部名命中时返回 true。
 */
const localClassTokenPatterns = new Map();
function hasLocalClassToken(className, localName) {
  if (typeof className !== "string") return false;
  // 局部名只来自本文件的常量；缓存两个正则是因为这段代码在每次 observer 通知里对
  // 每个候选元素都会跑一遍，热路径上不值得反复编译同一个正则。
  let patterns = localClassTokenPatterns.get(localName);
  if (patterns === void 0) {
    patterns = [new RegExp("(?:^|_)" + localName + "$"), new RegExp("^_" + localName + "(?:_|$)")];
    localClassTokenPatterns.set(localName, patterns);
  }
  return className.split(/\s+/).some((token) => patterns[0].test(token) || patterns[1].test(token));
}

/**
 * DSH 0.1.7 的隐藏 announcement 语义。aria-atomic=true 是它最稳定的标记，
 * visuallyHidden 局部名 / hidden / aria-hidden=true 是等价的隐藏形状；隐藏节点永远不能
 * 成为可见文案目标，也不能被附加动画。
 * @param {object} node - 候选元素。
 * @returns {boolean} 明确隐藏时返回 true。
 */
function isHiddenStatusCandidate(node) {
  if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
  if (node.getAttribute("aria-atomic") === "true") return true;
  if (node.getAttribute("aria-hidden") === "true") return true;
  const hidden = node.getAttribute("hidden");
  if (hidden !== null && hidden !== void 0) return true;
  return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
}

/**
 * 唯一主文本节点：恰好一个 trim 后非空的直接 Text，其余子节点只能是 aria-hidden=true 计时器。
 * 旧版 turnStatus 与新版 turn-process label 共用这条形状约束，避免命中 notice、拼装状态或容器。
 * @param {object} node - 候选容器元素。
 * @returns {object|undefined} 可安全改写的 Text 节点。
 */
function singleNativeStatusTextNode(node) {
  const childNodes = Array.from(node?.childNodes ?? []);
  const textNodes = childNodes.filter((child) => child?.nodeType === 3);
  const accessoryNodes = childNodes.filter((child) => child?.nodeType !== 3);
  const hasOnlyAriaHiddenAccessories = accessoryNodes.every((child) =>
    child?.nodeType === 1 && typeof child?.getAttribute === "function" && child.getAttribute("aria-hidden") === "true"
  );
  if (textNodes.length !== 1 || typeof textNodes[0].nodeValue !== "string" || textNodes[0].nodeValue.trim().length === 0 || !hasOnlyAriaHiddenAccessories) return void 0;
  return textNodes[0];
}

/** 深度优先收集后代元素；label 查找只在 button 子树内做，范围固定且很小。 */
function collectDescendantElements(node, out = []) {
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child?.nodeType !== 1) continue;
    out.push(child);
    collectDescendantElements(child, out);
  }
  return out;
}

/**
 * DSH 0.1.7 的可见状态目标是 span，不是任意带 label 局部名的元素：
 * 按钮内部的图标/计时器容器或嵌套控件同样可能叫 label，但只有 span 承担可见文案。
 * 大小写不敏感（真实 DOM 给 SPAN，fake DOM 给 span），缺失 tagName 时保守拒绝。
 * @param {object} element - 候选元素。
 * @returns {boolean} 元素是 span 时返回 true。
 */
function isSpanStatusLabelElement(element) {
  return typeof element?.tagName === "string" && element.tagName.toLowerCase() === "span";
}

/**
 * DSH 会话边界可能使用任一公开 data-* 属性；状态行自身没有属性时还要沿祖先查找。
 * markerless DOM 只能在所有已发现属性都精确指向当前会话时写入，否则保持原生文案。
 */
const NATIVE_SESSION_ATTRIBUTES = [
  "data-session-id",
  "data-conversation-session-id",
  "data-conversation-session",
  "data-session",
];

function nativeStatusSessionValues(node, boundary) {
  const values = [];
  let current = node;
  while (current !== null && current !== void 0) {
    if (typeof current.getAttribute === "function") {
      for (const name of NATIVE_SESSION_ATTRIBUTES) {
        const value = current.getAttribute(name);
        if (typeof value === "string" && value.length > 0) values.push(value);
      }
    }
    if (boundary !== void 0 && current === boundary) break;
    current = current.parentNode;
  }
  return values;
}

/**
 * 按指定边界校验候选节点：markerless 需要至少一条当前会话证据；已有 scope 时即使
 * 只靠 scope 证明归属，也必须拒绝节点自身或祖先携带的冲突 session 属性。
 */
function nativeStatusNodeMatchesSession(node, sessionId, boundary, requireEvidence) {
  if (sessionId === void 0 || sessionId === null || String(sessionId).length === 0) return false;
  const values = nativeStatusSessionValues(node, boundary);
  const expected = String(sessionId);
  return (!requireEvidence || values.length > 0) && values.every((value) => value === expected);
}

/** 读取节点自身携带的全部公开会话属性值（空值忽略）。 */
function sessionValuesOf(node) {
  const values = [];
  if (typeof node?.getAttribute === "function") {
    for (const name of NATIVE_SESSION_ATTRIBUTES) {
      const value = node.getAttribute(name);
      if (typeof value === "string" && value.length > 0) values.push(value);
    }
  }
  return values;
}

/**
 * 定位 DSH 0.2.0-rc1 的会话证据容器。
 *
 * RC1 的 data-conversation-session 不在 [data-conversation-scroll] 上，而在它的
 * [data-conversation-content] 外层容器上；只读 scroll 自身会把当前会话判定成"无标记"，
 * 于是两棵 conversation 并存时整体放弃，新运行行完全漏掉。
 *
 * 语义边界：
 * - 没有 [data-conversation-content] 祖先时返回 undefined：绝不越过 scroll 向上猜证据，
 *   既有 legacy 形态（会话属性直接落在 scope 或状态节点上）语义完全不变；
 * - 有 content 祖先时，就近取它或它最近带会话属性的祖先作为证据容器；冲突属性仍由
 *   nativeStatusNodeMatchesSession 的"链上所有已发现属性必须一致"兜住。
 * @param {object} scope - 已确定的 [data-conversation-scroll] 会话边界。
 * @returns {object|undefined} 证据容器；没有 content 祖先时返回 undefined。
 */
function nativeConversationEvidenceOwner(scope) {
  let content;
  let current = scope;
  while (current !== null && current !== void 0) {
    if (typeof current.getAttribute === "function" && current.getAttribute("data-conversation-content") !== null) {
      content = current;
      break;
    }
    current = current.parentNode;
  }
  if (content === void 0) return void 0;
  let node = content;
  while (node !== null && node !== void 0) {
    if (typeof node.getAttribute === "function" && sessionValuesOf(node).length > 0) return node;
    node = node.parentNode;
  }
  return content;
}

/** scope 的会话证据：scope 自身的会话属性 + RC1 content 外层的会话属性。 */
function nativeStatusScopeIds(scope) {
  return [...sessionValuesOf(scope), ...sessionValuesOf(nativeConversationEvidenceOwner(scope))];
}

/** 候选节点的会话证据边界：RC1 用 content 外层，legacy 用 scope 自身。 */
function nativeStatusSessionBoundary(scope) {
  return nativeConversationEvidenceOwner(scope) ?? scope;
}

/**
 * RC1 装饰子树判定：aria-hidden=true / inert / hidden / visuallyHidden 局部名都属于
 * "不承载可见文案"的动画副本（TextShimmer 的扫光副本就在这里）。
 *
 * 与 isHiddenStatusCandidate 分开：后者还要把 aria-atomic 的隐藏 announcement 视为不可见
 * 候选，而这里只用于"在跑马灯里找真实可见文案"，不需要把 announcement 排除法混进来。
 * @param {object} node - 候选元素。
 * @returns {boolean} 属于装饰子树时返回 true。
 */
function isDecorativeNativeStatusNode(node) {
  if (node === null || node === void 0 || typeof node?.getAttribute !== "function") return false;
  if (node.getAttribute("aria-hidden") === "true") return true;
  const hidden = node.getAttribute("hidden");
  if (hidden !== null && hidden !== void 0) return true;
  const inert = node.getAttribute("inert");
  if (inert !== null && inert !== void 0) return true;
  return hasLocalClassToken(node.getAttribute("class"), "visuallyHidden");
}

/**
 * 收集非装饰子树里的可见 Text（深度优先）。
 * 装饰子树整棵跳过：它的文字与真实可见文案相同，但属于宿主动画的一部分。
 * @param {object} node - 起始元素。
 * @param {Array} [out] - 收集结果。
 * @param {boolean} [hidden] - 祖先是否已判定为装饰。
 * @returns {Array} trim 后非空的可见 Text 节点。
 */
function collectVisibleStatusTextNodes(node, out = [], hidden = false) {
  const hiddenHere = hidden || isDecorativeNativeStatusNode(node);
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child?.nodeType === 3) {
      if (!hiddenHere && typeof child.nodeValue === "string" && child.nodeValue.trim().length > 0) out.push(child);
      continue;
    }
    if (child?.nodeType !== 1) continue;
    collectVisibleStatusTextNodes(child, out, hiddenHere);
  }
  return out;
}

/**
 * DSH 0.2.0-rc1 官方运行行的字段集合。
 *
 * 结构（实测 DOM）：
 * conversation[data-conversation-content][data-conversation-session]
 *   > [data-conversation-scroll] > [data-chat-running]
 *     ├─ role=status/aria-live=polite/aria-atomic=true 的隐藏 announcement
 *     ├─ 鲸鱼尾巴等 aria-hidden 装饰
 *     └─ [data-shimmer="true"]
 *         ├─ 可见子树：唯一的真实文案 Text（含"深度求索中，用时8分12秒..."）
 *         └─ aria-hidden/inert 装饰副本：data-shimmer-text 保存同一份完整标签
 *
 * fail-closed：行、跑马灯容器、可见 Text 任一项不是恰好一个就整体放弃，绝不猜可见性；
 * 归属由行到会话边界的属性链证明（冲突或缺证据时放弃）。
 * @param {object} scope - 已唯一确定的 conversation scope。
 * @param {string} sessionId - 当前页面会话 id。
 * @param {boolean} requireSessionEvidence - 是否要求链上至少一条当前会话属性。
 * @param {object} [sessionBoundary] - 会话证据边界。
 * @returns {{visibleText:object, shimmerTextNodes:Array, announcementTexts:Array}|undefined}
 */
function findNativeRunningRowParts(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const rows = [];
  if (scope?.matches?.("[data-chat-running]")) rows.push(scope);
  for (const row of Array.from(scope?.querySelectorAll?.("[data-chat-running]") ?? [])) {
    if (!rows.includes(row)) rows.push(row);
  }
  if (rows.length !== 1) return void 0;
  const row = rows[0];
  if (!nativeStatusNodeMatchesSession(row, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

  const shimmers = collectDescendantElements(row).filter((element) => element?.getAttribute?.("data-shimmer") === "true");
  if (shimmers.length !== 1) return void 0;
  const visibleTexts = collectVisibleStatusTextNodes(shimmers[0]);
  if (visibleTexts.length !== 1) return void 0;
  const visibleText = visibleTexts[0];
  // 不只校验 running row：实际被写入的 Text 和属性节点也可能带冲突会话标记。
  if (!nativeStatusNodeMatchesSession(visibleText, sessionId, sessionBoundary, requireSessionEvidence)) return void 0;

  const shimmerTextNodes = collectDescendantElements(row).filter((element) => {
    const value = element?.getAttribute?.("data-shimmer-text");
    return value !== null && value !== void 0;
  });
  if (shimmerTextNodes.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
  const announcementTexts = [];
  for (const element of collectDescendantElements(row)) {
    if (element?.getAttribute?.("role") !== "status") continue;
    if (element?.getAttribute?.("aria-live") !== "polite") continue;
    if (element?.getAttribute?.("aria-atomic") !== "true") continue;
    const textNode = singleNativeStatusTextNode(element);
    if (textNode !== void 0) announcementTexts.push(textNode);
  }
  if (announcementTexts.some((node) => !nativeStatusNodeMatchesSession(node, sessionId, sessionBoundary, requireSessionEvidence))) return void 0;
  return { visibleText, shimmerTextNodes, announcementTexts };
}

/**
 * DSH 0.1.7 把可见运行状态放进 button[data-turn-process] 内的 span.label。
 * 只有可见、且恰好唯一命中的 label 才是候选：隐藏 announcement 永不入选，非 span 元素
 * 与多义候选（同 scope 多个可见 label，例如历史 turn 的按钮）一律放弃，让 legacy 兜底而不是猜。
 * @param {object} scope - 已唯一确定的 conversation scope。
 * @returns {object|undefined} label 内的主 Text 节点。
 */
function findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const matches = [];
  for (const button of Array.from(scope?.querySelectorAll?.("button[data-turn-process]") ?? [])) {
    if (button?.getAttribute?.("data-turn-process") === null || button?.getAttribute?.("data-turn-process") === void 0) continue;
    if (isHiddenStatusCandidate(button)) continue;
    for (const candidate of collectDescendantElements(button)) {
      if (!isSpanStatusLabelElement(candidate)) continue;
      if (!hasLocalClassToken(candidate?.getAttribute?.("class"), "label")) continue;
      if (isHiddenStatusCandidate(candidate)) continue;
      const textNode = singleNativeStatusTextNode(candidate);
      if (textNode === void 0) continue;
      if ((requireSessionEvidence || sessionBoundary !== void 0)
        && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
      matches.push(textNode);
    }
  }
  return matches.length === 1 ? matches[0] : void 0;
}

/**
 * 在已确定的会话 scope 内定位 legacy（非 RC1）形态的原生状态主文本节点：
 * 依次尝试 DSH 0.1.7 的 button[data-turn-process] > span.label 与 0.1.6 的 turnStatus。
 * RC1 的 [data-chat-running] 行由 resolveNativeStatusTargets 优先处理，不在这里兜底。
 * markerless 根节点由调用方显式要求祖先会话证据；有 scope marker 时沿用 scope 选择结果。
 */
function findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence = false, sessionBoundary = void 0) {
  if (scope == null) return void 0;
  const labelNode = findNativeTurnProcessLabelTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
  if (labelNode !== void 0) return labelNode;

  const statuses = [];
  if (scope?.matches?.('[role="status"]')) statuses.push(scope);
  for (const status of Array.from(scope?.querySelectorAll?.('[role="status"]') ?? [])) {
    if (!statuses.includes(status)) statuses.push(status);
  }
  let match;
  for (const status of statuses) {
    if (status?.getAttribute?.("role") !== "status" || status?.getAttribute?.("aria-live") !== "polite") continue;
    if (isHiddenStatusCandidate(status)) continue;
    if (!hasLocalClassToken(status?.getAttribute?.("class"), "turnStatus")) continue;
    const textNode = singleNativeStatusTextNode(status);
    if (textNode === void 0) continue;
    if ((requireSessionEvidence || sessionBoundary !== void 0)
      && !nativeStatusNodeMatchesSession(textNode, sessionId, sessionBoundary, requireSessionEvidence)) continue;
    if (match !== void 0) return void 0;
    match = textNode;
  }
  return match;
}

/**
 * 解析当前会话的原生运行状态**全字段**目标（纯 DOM 选择，不写入）：
 * - RC1：返回 { visibleText, shimmerAttributes, announcements } 三项完整字段；
 * - legacy（0.1.7 label / 0.1.6 turnStatus）：只返回可见 Text，另外两项为空。
 *
 * 会话判定：优先 data-conversation-scroll 边界；RC1 的会话标记在它的
 * [data-conversation-content] 外层，因此证据与候选边界都按 nativeStatusScopeIds /
 * nativeStatusSessionBoundary 取；没有 scope marker 时扫描 root 并强制要求祖先会话证据。
 * 任何冲突、歧义或缺少证据的情况都返回 undefined，让调用方保持宿主原文。
 * @param {object} root - 通常为 document.body 的 DOM 根。
 * @param {string} sessionId - 当前页面会话 id。
 * @returns {{visibleText:object, shimmerAttributes:Array, announcements:Array}|undefined}
 */
function resolveNativeStatusTargets(root, sessionId) {
  const scopes = [];
  if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
  for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
    if (!scopes.includes(scope)) scopes.push(scope);
  }

  if (scopes.length === 0) {
    const textNode = findNativeTurnStatusTextNode(root, sessionId, true);
    return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
  }

  const exact = sessionId === void 0 || sessionId === null
    ? []
    : scopes.filter((scope) => nativeStatusScopeIds(scope).includes(String(sessionId)));
  const tagged = scopes.filter((scope) => nativeStatusScopeIds(scope).length > 0);
  let candidates = [];
  if (exact.length === 1) {
    candidates = exact;
  } else if (exact.length > 1) {
    const visible = exact.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
    if (visible.length === 1) candidates = visible;
  } else if (tagged.length === 0 && scopes.length === 1) {
    candidates = scopes;
  } else if (tagged.length === 0) {
    const visible = scopes.filter((scope) => typeof scope?.getClientRects === "function" && scope.getClientRects().length > 0);
    if (visible.length === 1) candidates = visible;
  }
  if (candidates.length !== 1) return void 0;

  const scope = candidates[0];
  const requireSessionEvidence = nativeStatusScopeIds(scope).includes(String(sessionId));
  const sessionBoundary = nativeStatusSessionBoundary(scope);
  const parts = findNativeRunningRowParts(scope, sessionId, requireSessionEvidence, sessionBoundary);
  if (parts !== void 0) {
    return {
      visibleText: parts.visibleText,
      shimmerAttributes: parts.shimmerTextNodes,
      announcements: parts.announcementTexts,
    };
  }
  const textNode = findNativeTurnStatusTextNode(scope, sessionId, requireSessionEvidence, sessionBoundary);
  return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
}

/**
 * 选择当前页面会话的原生运行状态**可见**主文本节点（公开只读 seam）。
 *
 * RC1 返回 [data-shimmer="true"] 非装饰子树里的真实可见 Text；0.1.7/0.1.6 的 legacy 形态
 * 继续返回各自唯一的可见 Text。选择与会话判定语义与 client.js 的同名实现同步。
 * @param {object} root - 通常为 document.body 的 DOM 根。
 * @param {string} sessionId - 当前页面会话 id。
 * @returns {object|undefined} 要改写的可见 Text 节点。
 */
export function findNativeStatusTextNode(root, sessionId) {
  return resolveNativeStatusTargets(root, sessionId)?.visibleText;
}


/**
 * 计算当前会话的插件运行状态文案（纯函数）：
 * - 只接受页面当前会话且 running === true；
 * - 明确为 child 时必须有已验证的插件 role；
 * - 根会话使用 Orchestrator；
 * - 空闲、等待、完成、无会话、无法从 marker/RPC 得到有效 role 时返回 null，让 DSH 保留原文案。
 *
 * 返回值是**不带末尾省略号**的前缀文案（"Explorer running" / "Orchestrator running"）：
 * 它只替换宿主原生文案里的运行前缀（见 replaceNativeStatusPrefix），逗号、用时与末尾省略号
 * 仍来自宿主自己的文本，因此这里追加省略号会渲染出 "running...，用时..." 这种双重标点。
 * @param {object} input - 当前/目标 session id、running、会话摘要、RPC kind 和可选 role。
 * @returns {string|null} 要替换的原生前缀文案，或保持宿主原文的 null。
 */
export function resolveRunningStatusText({ sessionId, currentSessionId, running, session, kind, role } = {}) {
  if (sessionId === void 0 || sessionId === null || sessionId !== currentSessionId || running !== true) return null;
  const markedChild = isPluginChildSession(session);
  const normalizedRole = normalizeStatusRole(role);
  const roleText = normalizedRole === void 0 ? null : STATUS_ROLE_LABELS[normalizedRole] + " running";
  if (kind === "pending" || kind === "unknown") return markedChild ? roleText : null;
  if (kind === "child") return roleText;
  if (kind === "root") return markedChild ? null : "Orchestrator running";
  if (kind !== void 0 && kind !== null) return null;
  if (markedChild) return roleText;
  return "Orchestrator running";
}
