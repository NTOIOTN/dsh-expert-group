/**
 * 原生运行状态投影（状态行文本、会话作用域、前缀重写与行重写器）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-native-status")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientNativeStatus(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-native-status");

    // ── 当前页面运行状态桥：只读取当前会话的 running 与插件 role，并复用 DSH 原生状态行。
    //    DEG 不创建第二个状态容器，只在宿主原生主文本节点存在且前缀匹配时替换角色文案；
    //    宿主自己的鲸鱼动画、计时器、class、style 和 aria 始终由 DSH 保持。 ───────────────
    // 浏览器 bundle 通过 window.__ModuleLoader__ 加载，运行期不能 import role-registry.js，
    // 因此这里保留唯一一份"协议适配"投影：role id 列表 + 英文状态标签。
    // 权威来源是 role-registry.js 的 id/statusLabel；新增或改名角色必须同时更新这里，
    // 并由 test/role-registry.test.mjs（注册表侧）与既有客户端契约测试（页面侧）共同锁定。
    const STATUS_ROLE_IDS = ["explorer", "librarian", "oracle", "designer", "fixer", "observer"];
    // role id 始终保持小写用于身份匹配；页面显示只使用这里的固定英文标签。
    const STATUS_ROLE_LABELS = {
      explorer: "Explorer",
      librarian: "Librarian",
      oracle: "Oracle",
      designer: "Designer",
      fixer: "Fixer",
      observer: "Observer",
    };
    const STATUS_ROLE_MARKER = "__degExpertRole";

    /** 只接受插件定义的英文 role id；未知/外部角色不参与文案替换。 */
    function normalizeStatusRole(role) {
      if (typeof role !== "string") return void 0;
      const normalized = role.trim().toLowerCase();
      return STATUS_ROLE_IDS.includes(normalized) ? normalized : void 0;
    }

    /** 只有 DSH 明确给出 parentId、subagent origin 或 session snapshot subagent 时才判定为 child。 */
    function isPluginChildSession(session) {
      return session !== null
        && typeof session === "object"
        && ((typeof session.parentId === "string" && session.parentId.length > 0)
          || (typeof session.parentSessionId === "string" && session.parentSessionId.length > 0)
          || session.origin === "subagent"
          || (session.subagent !== null && typeof session.subagent === "object"));
    }

    /** 从当前 session 绑定的 RPC 响应解析 child kind 与英文 role；未知响应不猜测身份。 */
    function resolveStatusIdentity({ sessionId, responseSessionId, response } = {}) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      const reportedSessionId = response?.sessionId ?? responseSessionId;
      if (reportedSessionId !== sessionId) return null;
      if (response?.ok === false) return { sessionId, kind: "unknown", role: void 0 };
      if (response?.kind === "child") {
        return { sessionId, kind: "child", role: normalizeStatusRole(response?.child?.role) };
      }
      if (response?.kind === "root") return { sessionId, kind: "root", role: void 0 };
      return { sessionId, kind: "unknown", role: void 0 };
    }

    /**
     * 当前会话状态文案的唯一决策点：running-only、单一当前角色、未知回退。
     * 已有插件 marker 优先确认 child；无 marker 的旧 child 再由 RPC kind=child 补足。
     *
     * 返回值是**不带末尾省略号**的前缀文案（"Explorer running" / "Orchestrator running"）：
     * 它与 shared.js 的同名实现语义同步，用来替换宿主原生文案里的运行前缀
     * （见 replaceNativeStatusPrefix）；逗号、用时与末尾省略号仍由宿主自己的文本提供。
     */
    function resolveRunningStatusText({ sessionId, currentSessionId, running, session, kind, role } = {}) {
      if (sessionId === void 0 || sessionId === null || sessionId !== currentSessionId || running !== true) return null;
      const markedChild = isPluginChildSession(session);
      const normalizedRole = normalizeStatusRole(role);
      const roleText = normalizedRole === void 0 ? null : STATUS_ROLE_LABELS[normalizedRole] + " running";
      if (kind === "pending") return markedChild ? roleText : null;
      if (kind === "unknown") return markedChild ? roleText : null;
      if (kind === "child") return roleText;
      if (kind === "root") return markedChild ? null : "Orchestrator running";
      if (kind !== void 0 && kind !== null) return null;
      if (markedChild) return roleText;
      return "Orchestrator running";
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

    /**
     * 优先使用 session-scoped bridge 自身的 DOM anchor；右侧 subagentchat 与主视图可同时存在
     * 多棵可见 conversation scope，此 anchor 是唯一不依赖可见性猜测的归属证据。
     * 没有 scope marker 时仍监听 root，但实际写入必须由原生状态节点或祖先的精确会话属性证明归属。
     */
    function findNativeConversationScope(root, sessionId, anchor) {
      const anchoredScope = anchor?.closest?.("[data-conversation-scroll]");
      if (anchoredScope !== null && anchoredScope !== void 0) return anchoredScope;

      const scopes = [];
      if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
      for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      if (scopes.length === 0) {
        // DSH RC1 的 ChatView 真实 DOM 没有稳定的 conversation scope marker。
        // 即使 TurnStatus 尚未创建，也必须监听 root；节点出现后 observer 才能即时接管首帧。
        // findNativeStatusTextNode 会再要求候选节点沿祖先链提供精确会话属性。
        return root;
      }

      // 会话证据与候选边界共用同一份定义：RC1 的会话标记在 scroll 的
      // [data-conversation-content] 外层，只读 scope 自身会把当前会话判成"无标记"。
      const scopeIds = (scope) => nativeStatusScopeIds(scope);
      const exact = sessionId === void 0 || sessionId === null
        ? []
        : scopes.filter((scope) => scopeIds(scope).includes(String(sessionId)));
      const tagged = scopes.filter((scope) => scopeIds(scope).length > 0);
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
      return candidates.length === 1 ? candidates[0] : void 0;
    }

    /**
     * CSS Module 稳定局部名匹配：只认局部名本身，不绑定构建 hash 形态。
     * Vite 默认产物是 `_label_hash_line`，旧夹具/其它工具链是 `hash_label`；两种形状都只
     * 依赖 "label" 这一个稳定局部名，因此既不能硬编码完整 hash，也不能只认某一种拼接。
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
     * visuallyHidden 局部名 / hidden / aria-hidden=true 是等价的隐藏形状。
     * 只按属性语义判断，不读布局：CSS Module hash 变化不会影响判定，隐藏节点永远不会被写成可见文案。
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
     * 新旧两种形状共用同一形状约束，避免命中拼装状态、notice 或带额外子节点的容器。
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
     */
    function isSpanStatusLabelElement(element) {
      return typeof element?.tagName === "string" && element.tagName.toLowerCase() === "span";
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
     * 语义边界（与 shared.js 同名实现同步）：
     * - 没有 [data-conversation-content] 祖先时返回 undefined：绝不越过 scroll 向上猜证据，
     *   既有 legacy 形态（会话属性直接落在 scope 或状态节点上）语义完全不变；
     * - 有 content 祖先时，就近取它或它最近带会话属性的祖先作为证据容器；冲突属性仍由
     *   nativeStatusNodeMatchesSession 的"链上所有已发现属性必须一致"兜住。
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
     * 候选，而这里只用于"在跑马灯里找真实可见文案"。
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
     * DSH 0.2.0-rc1 官方运行行的字段集合（与 shared.js 同名实现同步）。
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
     * 与多义候选（同 scope 多个可见 label，例如历史 turn 的按钮）一律放弃，交由 legacy 兜底而不是猜。
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
     * 在已确定的会话 scope 内定位 legacy（非 RC1）形态的运行状态主文本节点。
     * 文案只检查为非空 Text，不绑定任何 locale；候选优先级为 DSH 0.1.7 的可见 turn-process
     * label，其次是 0.1.6 的 legacy turnStatus。新版缺失或多义时回退 legacy，legacy 自身多义
     * 仍保持"不改"的保守语义；两种形状的隐藏 announcement 都永不作为目标。
     * RC1 的 [data-chat-running] 行由 resolveNativeStatusTargets 优先处理，不在这里兜底。
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


    /** 文档中所有原生 conversation scope（含 root 自身）：多 scope 并存时的最小遍历单位。 */
    function collectNativeConversationScopes(root) {
      const scopes = [];
      if (root?.matches?.("[data-conversation-scroll]")) scopes.push(root);
      for (const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]") ?? [])) {
        if (!scopes.includes(scope)) scopes.push(scope);
      }
      return scopes;
    }

    /**
     * 一个 scope 的会话身份：scope 自身与 RC1 content 外层的全部会话属性必须一致地指向
     * 同一个会话；缺失（0 个值）或冲突（多个不同值）都不提供身份。
     *
     * 这是多 scope（主视图 + 右侧 sidebar.chat）并存的归属依据：每个 scope 自己证明自己
     * 属于哪个会话，插件不需要、也不允许再依赖"单个主视图会话"去猜侧栏目标。
     */
    function nativeScopeSessionId(scope) {
      const values = new Set(nativeStatusScopeIds(scope));
      if (values.size !== 1) return void 0;
      for (const value of values) return value;
      return void 0;
    }

    /** legacy 状态节点（没有 conversation scope）的会话身份：同样要求祖先链上唯一。 */
    function nativeStatusNodeSessionId(node) {
      const values = new Set(nativeStatusSessionValues(node, void 0));
      if (values.size !== 1) return void 0;
      for (const value of values) return value;
      return void 0;
    }

    /**
     * 收集当前文档里所有"身份可验证"的原生状态目标所属的会话 id（每个会话 id 对应一条
     * 独立 lane）。判定规则与写入规则同源，因此 lane 候选本身就 fail-closed：
     * - 有 conversation scope 时逐个 scope 取唯一会话身份；缺失/冲突的 scope 不产生 lane；
     * - 没有 scope（legacy 形态）时按状态节点自身的唯一会话属性归并；冲突节点被忽略。
     * 真实会话是否存在、是否 running、身份是什么，仍由调用方按 session snapshot 与 RPC 决定。
     */
    function collectNativeStatusSessionIds(root) {
      const ids = new Set();
      const scopes = collectNativeConversationScopes(root);
      if (scopes.length > 0) {
        for (const scope of scopes) {
          const sessionId = nativeScopeSessionId(scope);
          if (sessionId !== void 0) ids.add(sessionId);
        }
        return ids;
      }
      const statuses = [];
      if (root?.matches?.('[role="status"]')) statuses.push(root);
      for (const status of Array.from(root?.querySelectorAll?.('[role="status"]') ?? [])) {
        if (!statuses.includes(status)) statuses.push(status);
      }
      for (const status of statuses) {
        if (status?.getAttribute?.("aria-live") !== "polite") continue;
        const sessionId = nativeStatusNodeSessionId(status);
        if (sessionId !== void 0) ids.add(sessionId);
      }
      for (const button of Array.from(root?.querySelectorAll?.("button[data-turn-process]") ?? [])) {
        const sessionId = nativeStatusNodeSessionId(button);
        if (sessionId !== void 0) ids.add(sessionId);
      }
      return ids;
    }

    /**
     * 解析当前会话的原生运行状态**全字段**目标（纯 DOM 选择，不写入；与 shared.js 同名实现同步）：
     * - RC1：返回 { visibleText, shimmerAttributes, announcements } 三项完整字段；
     * - legacy（0.1.7 label / 0.1.6 turnStatus）：只返回可见 Text，另外两项为空。
     *
     * 会话判定：优先 data-conversation-scroll 边界；RC1 的会话标记在它的
     * [data-conversation-content] 外层，因此证据与候选边界都按 nativeStatusScopeIds /
     * nativeStatusSessionBoundary 取；没有 scope marker 时扫描 root 并强制要求祖先会话证据。
     * 任何冲突、歧义或缺少证据的情况都返回 undefined，让调用方保持宿主原文。
     */
    function resolveNativeStatusScopeTargets(scope, sessionId) {
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

    function resolveNativeStatusTargets(root, sessionId, includeSameSessionScopes = false) {
      const scopes = collectNativeConversationScopes(root);

      if (scopes.length === 0) {
        const textNode = findNativeTurnStatusTextNode(root, sessionId, true);
        return textNode === void 0 ? void 0 : { visibleText: textNode, shimmerAttributes: [], announcements: [] };
      }

      const exact = sessionId === void 0 || sessionId === null
        ? []
        : scopes.filter((scope) => nativeStatusScopeIds(scope).includes(String(sessionId)));
      const tagged = scopes.filter((scope) => nativeStatusScopeIds(scope).length > 0);
      if (includeSameSessionScopes && exact.length > 1) {
        const resolved = exact
          .filter((scope) => nativeScopeSessionId(scope) === String(sessionId))
          .map((scope) => resolveNativeStatusScopeTargets(scope, sessionId))
          .filter((targets) => targets !== void 0);
        if (resolved.length === 0) return void 0;
        return {
          visibleTexts: resolved.map((targets) => targets.visibleText).filter((node) => node != null),
          shimmerAttributes: resolved.flatMap((targets) => targets.shimmerAttributes),
          announcements: resolved.flatMap((targets) => targets.announcements),
        };
      }
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

      return resolveNativeStatusScopeTargets(candidates[0], sessionId);
    }

    /**
     * 选择当前页面会话的原生运行状态**可见**主文本节点（公开只读 seam）。
     * RC1 返回 [data-shimmer="true"] 非装饰子树里的真实可见 Text；legacy 形态继续返回
     * 各自唯一的可见 Text。选择与会话判定语义与 shared.js 的同名导出同步。
     */
    function findNativeStatusTextNode(root, sessionId) {
      return resolveNativeStatusTargets(root, sessionId)?.visibleText;
    }

    /**
     * 原生运行状态文案的可替换前缀候选（票据 19：中英文 locale 都生效）。
     *
     * DSH 0.2.0-rc1 在输入区上方渲染宿主自己的运行状态行：中文 locale 形如
     * 「深度求索中，用时8分12秒...」，英文 locale 可能是 "Deep diving..." / "Deep thinking..." /
     * "Thinking..."。插件只拥有这一段前缀：替换它就能把当前会话的角色投影到宿主原生行上，
     * 而逗号、用时、末尾省略号以及前后兄弟节点/动画全部保持宿主原样。
     *
     * 投影同步：权威列表在 shared.js 的 NATIVE_RUNNING_STATUS_PREFIXES，classic bundle 无法
     * import ESM，因此这里是手写投影；两处必须逐项同值（测试同时覆盖两侧）。
     */
    const NATIVE_RUNNING_STATUS_PREFIXES = Object.freeze([
      "深度求索中",
      "Deep diving",
      "Deep thinking",
      "Thinking",
    ]);
    /** 向后兼容：旧导出名继续指中文主前缀；新代码只用候选列表。 */
    const NATIVE_RUNNING_STATUS_PREFIX = NATIVE_RUNNING_STATUS_PREFIXES[0];

    /**
     * 只替换原生运行前缀的纯函数（fail-closed）。本实现与 shared.js 的同名导出语义同步
     * （classic bundle 无法 import ESM 权威实现，两处只允许逐字保持同一份语义）。
     *
     * 边界语义：
     * - 原文里没有任何候选前缀时返回 null：调用方必须保持宿主原文案，绝不猜测或整行重建；
     * - 只替换**第一处**出现（中英文候选混排时取原文最靠前的那个；同位置优先更长候选），
     *   其余内容逐字节保留（分隔逗号、用时、末尾省略号、空白与大小写）；
     * - 原文或替换文案不是非空字符串时返回 null。
     * @param {unknown} currentText - 宿主当前渲染的原生文案。
     * @param {unknown} replacementText - 角色文案（例如 "Explorer running"，不带省略号）。
     * @returns {string|null} 替换后的完整文案；没有可替换前缀时返回 null。
     */
    function replaceNativeStatusPrefix(currentText, replacementText) {
      if (typeof currentText !== "string" || currentText.length === 0) return null;
      if (typeof replacementText !== "string" || replacementText.length === 0) return null;
      let match = null;
      for (const prefix of NATIVE_RUNNING_STATUS_PREFIXES) {
        const at = currentText.indexOf(prefix);
        if (at === -1) continue;
        if (match === null || at < match.at || (at === match.at && prefix.length > match.prefix.length)) {
          match = { at, prefix };
        }
      }
      if (match === null) return null;
      return currentText.slice(0, match.at) + replacementText + currentText.slice(match.at + match.prefix.length);
    }

    /**
     * 只保存/替换/恢复一个原生主文本节点的**前缀**；不触碰 class/style、计时器或 aria，
     * 也不重建整行。DOM 适配、MutationObserver 与 React 生命周期由调用方持有；本函数只处理
     * 「原生前缀 → 角色文案」的保存/替换/恢复，因此可在无 DOM 的 node:test 中用最小 mock 验证。
     *
     * 原文跟进规则（同一个 Text 节点上的内容随时可能被宿主改写）：
     * - 角色变化：只换前缀，逗号/用时/末尾省略号继续沿用宿主最新原文；
     * - 宿主重渲染、locale 切换或用时刷新：当前值不再是本插件写入的那一份时，把宿主最新值
     *   认定为原文，清理时恢复它——绝不把旧语言或旧用时写回去；
     * - 原文没有原生前缀（例如英文 locale 的 "Deep diving..."）时不做任何写入。
     *
     * 可选 decorate/undecorate 钩子仅用于调用方管理附加生命周期；当前原生状态桥不传入
     * 任何装饰钩子，因此不会向宿主节点添加 marker、样式或动画。rewriter 仍保证换目标和
     * 清理时先处理旧目标，避免调用方留下 stale 状态。
     */
    function createNativeTextRewriter(options = {}) {
      const findNode = typeof options.findNode === "function" ? options.findNode : () => void 0;
      const getText = typeof options.getText === "function" ? options.getText : (node) => node?.nodeValue;
      const setText = typeof options.setText === "function" ? options.setText : (node, value) => { node.nodeValue = value; };
      const isConnected = typeof options.isConnected === "function" ? options.isConnected : (node) => node?.isConnected !== false;
      const decorate = typeof options.decorate === "function" ? options.decorate : () => {};
      const undecorate = typeof options.undecorate === "function" ? options.undecorate : () => {};
      let activeNode;
      let originalText;
      let rewrittenText;

      function restore() {
        // 只在"当前值仍是我们写入的那一份"时回写：宿主已自行改写内容时保持宿主最新值，
        // 避免把旧语言、旧用时或旧角色文案盖回去。
        if (activeNode !== void 0 && isConnected(activeNode) && getText(activeNode) === rewrittenText) {
          setText(activeNode, originalText);
        }
        activeNode = void 0;
        originalText = void 0;
        rewrittenText = void 0;
        undecorate();
      }

      function apply(text) {
        if (typeof text !== "string" || text.length === 0) {
          restore();
          return;
        }
        const candidate = findNode();
        if (candidate === null || candidate === void 0) {
          restore();
          return;
        }
        const currentText = getText(candidate);
        if (activeNode !== candidate) {
          restore();
          activeNode = candidate;
          originalText = currentText;
        } else if (currentText !== rewrittenText) {
          // 同一 Text 节点上的原文被宿主更新（locale 切换、用时刷新、React 重写）；
          // 跟进外部值，清理时恢复的必须是最新原文。
          originalText = currentText;
        }
        const next = replaceNativeStatusPrefix(originalText, text);
        // 没有可替换的原生前缀（英文 locale、宿主已换成完成文案等）时保持原文，不做任何写入。
        rewrittenText = next === null ? currentText : next;
        if (next !== null && currentText !== next) setText(activeNode, next);
        // 装饰放在文本写入之后：无论首次接管、节点替换还是重复通知，装饰都针对当前目标。
        decorate(activeNode);
      }

      return { apply, restore };
    }

    /**
     * 原生状态行上的字段清单：可见 Text、data-shimmer-text 装饰属性、隐藏 announcement Text。
     * legacy 形态只有一个可见 Text 字段。同一 (节点, 属性) 组合只保留一份，避免重复写入。
     */
    function nativeStatusFieldDescriptors(targets) {
      const fields = [];
      if (targets?.visibleText != null) fields.push({ node: targets.visibleText, attribute: void 0 });
      for (const node of targets?.visibleTexts ?? []) {
        if (node != null) fields.push({ node, attribute: void 0 });
      }
      for (const node of targets?.shimmerAttributes ?? []) {
        if (node != null) fields.push({ node, attribute: "data-shimmer-text" });
      }
      for (const node of targets?.announcements ?? []) {
        if (node != null) fields.push({ node, attribute: void 0 });
      }
      return fields.filter((field, index) => fields.findIndex(
        (other) => other.node === field.node && other.attribute === field.attribute,
      ) === index);
    }

    /**
     * 原生运行行的多字段重写器。
     *
     * 为什么不复用"整行一个 createNativeTextRewriter"：RC1 的同一行里，可见文案、装饰副本的
     * data-shimmer-text、隐藏 announcement 是三个互相独立的宿主字段，宿主（计时器刷新、locale
     * 切换、React 重渲染）会分别更新它们。每个字段交给一个独立的 createNativeTextRewriter
     * 处理，就同时得到既有语义：各自保存原文、各自跟进最新值、各自只在"值仍是我们写入的那
     * 一份"时才恢复——既不写回旧后缀，也不碰从未覆盖过的字段、节点与动画。
     *
     * 目标集合在本轮变小时（会话切换、停止、节点重建、announcement 消失），旧字段立即恢复；
     * apply(null/空) 等价于 restore()。
     */
    function createNativeStatusRowRewriter(options = {}) {
      const resolveTargets = typeof options.resolveTargets === "function" ? options.resolveTargets : () => void 0;
      let entries = [];

      /** 单个字段的读写适配：Text 用 nodeValue，装饰副本用 data-shimmer-text 属性。 */
      const createFieldRewriter = (node, attribute) => {
        const read = () => (attribute === void 0 ? node?.nodeValue : node?.getAttribute?.(attribute));
        const write = (value) => {
          if (attribute === void 0) {
            node.nodeValue = value;
            return;
          }
          node?.setAttribute?.(attribute, value);
        };
        return createNativeTextRewriter({
          findNode: () => node,
          getText: () => read(),
          setText: (_candidate, value) => write(value),
          isConnected: () => node?.isConnected !== false,
        });
      };

      const restoreEntries = (list) => {
        for (const entry of list) entry.rewriter.restore();
      };

      function restore() {
        restoreEntries(entries);
        entries = [];
      }

      function apply(text) {
        const targets = typeof text === "string" && text.length > 0 ? resolveTargets() : void 0;
        const fields = targets === void 0 ? [] : nativeStatusFieldDescriptors(targets);
        if (fields.length === 0) {
          restore();
          return;
        }
        const next = [];
        for (const field of fields) {
          let entry = entries.find((candidate) => candidate.node === field.node && candidate.attribute === field.attribute);
          if (entry === void 0) {
            entry = { node: field.node, attribute: field.attribute, rewriter: createFieldRewriter(field.node, field.attribute) };
          }
          entry.rewriter.apply(text);
          next.push(entry);
        }
        // 本轮不再覆盖的字段必须立刻恢复：只回写插件确实写过的那一份值。
        restoreEntries(entries.filter((entry) => !next.includes(entry)));
        entries = next;
      }

      return { apply, restore };
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    NATIVE_RUNNING_STATUS_PREFIX, NATIVE_RUNNING_STATUS_PREFIXES, STATUS_ROLE_IDS, STATUS_ROLE_LABELS, STATUS_ROLE_MARKER,
    collectNativeStatusSessionIds, createNativeStatusRowRewriter, createNativeTextRewriter, findNativeConversationScope, findNativeStatusTextNode,
    isPluginChildSession, normalizeStatusRole, replaceNativeStatusPrefix, resolveNativeStatusTargets, resolveRunningStatusText,
    resolveStatusIdentity,
  });
})(globalThis);
