/**
 * 子代理目录与原生行元数据（catalog 投影 / RPC 元数据 / DOM 注入 / 状态桥）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-subagent-metadata")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientSubagentMetadata(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-subagent-metadata");
  const clientNativeStatusSymbol = Symbol.for("dsh-expert-group/client-native-status");
  const clientNativeStatus = global[clientNativeStatusSymbol] || {};
  const {
    STATUS_ROLE_LABELS, STATUS_ROLE_MARKER, collectNativeStatusSessionIds, createNativeStatusRowRewriter, isPluginChildSession, normalizeStatusRole,
    resolveNativeStatusTargets, resolveRunningStatusText, resolveStatusIdentity,
  } = clientNativeStatus;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  let requestPluginRpc = null;
  let RPC_PATH = null;
  let RPC_CHANNEL = null;
  let RPC_ENDPOINT = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
    requestPluginRpc = host.requestPluginRpc ?? null;
    RPC_PATH = host.RPC_PATH ?? null;
    RPC_CHANNEL = host.RPC_CHANNEL ?? null;
    RPC_ENDPOINT = host.RPC_ENDPOINT ?? null;
  }

    /** 使用 shell.overlay 注入的全局 useSessions；旧 slot 则使用现有 sessions.list。 */
    function useSessionList(ctx, useSessions) {
      if (typeof useSessions === "function") return useSessions((snapshot) => snapshot);
      return react.useSyncExternalStore(ctx.sessions.list.subscribe, ctx.sessions.list.getSnapshot);
    }

    /** 将 sessions.byId 和 pending interaction 统一成可遍历条目；异常快照按空集合处理。 */
    function readEntries(value) {
      if (value == null) return [];
      // Map.entries() 的物化结果本身也是数组；保留 [key, value]，不能再次读取数组索引。
      if (Array.isArray(value)) {
        if (value.every((entry) => Array.isArray(entry) && entry.length === 2)) return value;
        return value.map((entry, index) => [String(index), entry]);
      }
      if (typeof value.entries === "function") {
        try { return Array.from(value.entries()); } catch { return []; }
      }
      if (typeof value === "object") return Object.entries(value);
      return [];
    }

    function sessionIdOf(session, fallbackId) {
      const id = session?.sessionId ?? session?.id ?? fallbackId;
      return typeof id === "string" && id.length > 0 ? id : void 0;
    }

    /**
     * 解析 DSH 当前主视图会话。
     *
     * RC2 移除了 session-list 快照里的 current 字段，当前主视图改由会话行的
     * retainedBy.mainView 持有计数表达；旧宿主仍优先使用 current。readEntries 让
     * 两代宿主及测试替身的 object/Map/entry-array 形状保持同一套 fail-closed 语义。
     */
    function currentSessionIdOf(sessionList) {
      const legacyCurrent = metadataString(sessionList?.current);
      if (legacyCurrent !== void 0) return legacyCurrent;
      for (const [fallbackId, session] of readEntries(sessionList?.byId)) {
        if (!(Number(session?.retainedBy?.mainView) > 0)) continue;
        const currentId = sessionIdOf(session, fallbackId);
        if (currentId !== void 0) return currentId;
      }
      return void 0;
    }

    /** 从任意兼容形状的 session-list 快照中读取一个明确的会话条目。 */
    function sessionEntryOf(sessionList, sessionId) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return void 0;
      for (const [fallbackId, session] of readEntries(sessionList?.byId)) {
        if (sessionIdOf(session, fallbackId) === sessionId) return session;
      }
      return void 0;
    }

    /** 当前选中 child 需沿 parentId/parentSessionId 找到所属 root，循环或缺失快照均安全停止。 */
    function rootSessionIdOf(sessionEntries, currentSessionId) {
      if (typeof currentSessionId !== "string" || currentSessionId.length === 0) return void 0;
      const sessions = new Map();
      for (const [fallbackId, session] of sessionEntries) {
        const sessionId = sessionIdOf(session, fallbackId);
        if (sessionId !== void 0) sessions.set(sessionId, session);
      }
      if (!sessions.has(currentSessionId)) return void 0;
      let rootSessionId = currentSessionId;
      let candidate = currentSessionId;
      const visited = new Set();
      while (!visited.has(candidate)) {
        visited.add(candidate);
        const parentId = sessions.get(candidate)?.parentId ?? sessions.get(candidate)?.parentSessionId;
        if (typeof parentId !== "string" || parentId.length === 0 || parentId === candidate) break;
        rootSessionId = parentId;
        if (!sessions.has(parentId)) break;
        candidate = parentId;
      }
      return rootSessionId;
    }

    /** 把任意 DSH session-list 快照变成 rootSessionIdOf 接受的稳定 entries。 */
    function expertGroupRootSessionIdOf(sessionId, _session, snapshot) {
      const entries = readEntries(snapshot?.byId ?? snapshot?.sessions ?? snapshot);
      return rootSessionIdOf(entries, sessionId) ?? sessionId;
    }

    function sessionRoleOf(session) {
      return normalizeStatusRole(
        session?.[STATUS_ROLE_MARKER]
          ?? session?.metadata?.[STATUS_ROLE_MARKER]
          ?? session?.role
          ?? session?.metadata?.role
          ?? session?.child?.role,
      );
    }

    const SUBAGENT_METADATA_MARKER = "data-deg-subagent-metadata";
    const SUBAGENT_METADATA_CLASS = "deg_subagent_metadata";

    /** 元数据只接受非空字符串；这样 RPC 或快照中的对象、数字不会进入用户可见文案。 */
    function metadataString(value) {
      if (typeof value !== "string") return void 0;
      const text = value.trim();
      return text.length > 0 ? text : void 0;
    }

    function readSubagentMetadataField(value, field) {
      const sources = [value, value?.child, value?.metadata];
      for (const source of sources) {
        const text = metadataString(source?.[field]);
        if (text !== void 0) return text;
      }
      return void 0;
    }

    /**
     * 统一快照和 RPC 的 child 字段。没有完整的 role/provider/model/reasoningEffort
     * 时保留空对象，由 formatSubagentMetadata 决定不渲染半截文案。
     */
    function normalizeSubagentMetadata(value) {
      const source = value && typeof value === "object" ? value : {};
      const normalized = {};
      const role = sessionRoleOf(source) ?? normalizeStatusRole(readSubagentMetadataField(source, "role"));
      if (role !== void 0) normalized.role = role;
      for (const field of ["provider", "model", "reasoningEffort"]) {
        const text = readSubagentMetadataField(source, field);
        if (text !== void 0) normalized[field] = text;
      }
      return normalized;
    }

    /** 角色显示名是固定映射，未知角色、模型或思考深度都不产生 DOM 文案。 */
    function formatSubagentMetadata(value) {
      const metadata = normalizeSubagentMetadata(value);
      const label = metadata.role === void 0 ? void 0 : STATUS_ROLE_LABELS[metadata.role];
      // provider 用于确认 RPC 返回的是完整 child 配置，但问题5只展示模型与思考深度。
      if (label === void 0 || metadata.provider === void 0 || metadata.model === void 0 || metadata.reasoningEffort === void 0) return null;
      return [label, metadata.model, metadata.reasoningEffort].join(" · ");
    }

    function subagentTaskNameOf(value) {
      const sources = [value, value?.child, value?.metadata];
      for (const field of ["taskName", "task", "title", "displayTitle", "label", "name"]) {
        for (const source of sources) {
          const text = metadataString(source?.[field]);
          if (text !== void 0) return text;
        }
      }
      return void 0;
    }

    function subagentParentIdOf(session) {
      const direct = metadataString(session?.parentId) ?? metadataString(session?.parentSessionId);
      if (direct !== void 0) return direct;
      const origin = session?.origin;
      if (origin && typeof origin === "object") {
        return metadataString(origin.parentId)
          ?? metadataString(origin.parentSessionId)
          ?? sessionIdOf(origin);
      }
      // origin="subagent" 只说明类型，不能据此猜测它属于哪个 root。
      return origin !== "subagent" ? metadataString(origin) : void 0;
    }

    /**
     * 读取一份子代理目录投影值（`projectionsBySession[sessionId].values.subagentCatalog`）。
     *
     * 0.1.7-alpha.2 的子代理目录是按会话 id 索引的投影值，目录项固定为数组，只保证身份类
     * 字段（id/createdAt/mode/label）。非数组（缺失、旧形状、读取异常）一律按空目录处理。
     */
    function subagentCatalogEntries(value) {
      return Array.isArray(value) ? value : [];
    }

    /**
     * 把会话投影 `projectionsBySession` 转成有序父子关系。
     *
     * 每个会话的 `values.subagentCatalog` 是该会话的直系子代理；递归层级与父子树由
     * collectSubagentCatalog 在该关系上从 root 做 DFS 重建。目录项只提供身份/时间/模式/标签：
     * 任务标题与运行状态一律继续从 byId 投影与 DEG 自己的元数据读取，绝不用目录项冒充展示数据。
     */
    function readSubagentCatalogRelations(projectionsBySession) {
      const relations = [];
      for (const [fallbackParentId, projection] of readEntries(projectionsBySession)) {
        const parentId = metadataString(fallbackParentId) ?? sessionIdOf(fallbackParentId);
        if (parentId === void 0) continue;
        const snapshot = projection && typeof projection === "object" ? projection : {};
        for (const rawEntry of subagentCatalogEntries(snapshot.values?.subagentCatalog)) {
          const entry = rawEntry && typeof rawEntry === "object" ? rawEntry : {};
          const childId = sessionIdOf(entry);
          if (childId === void 0) continue;
          relations.push({
            parentId,
            childId,
            child: entry,
            taskName: metadataString(entry.label),
          });
        }
      }
      return relations;
    }

    /**
     * 当前会话所属 root：byId 的父子字段优先，投影目录作为补充证据。
     *
     * 目录只提供父子关系（身份/层级），因此这里只沿投影里的 parent 链上溯，
     * 不读取任何展示字段。
     */
    function resolveSubagentRootSessionId(sessionEntries, currentSessionId, projectionsBySession) {
      if (typeof currentSessionId !== "string" || currentSessionId.length === 0) return void 0;
      const fromSessions = rootSessionIdOf(sessionEntries, currentSessionId);
      if (fromSessions !== void 0) return fromSessions;
      const parents = new Map();
      for (const relation of readSubagentCatalogRelations(projectionsBySession)) {
        if (!parents.has(relation.childId)) parents.set(relation.childId, relation.parentId);
      }
      let candidate = currentSessionId;
      const visited = new Set();
      while (!visited.has(candidate)) {
        visited.add(candidate);
        const parentId = parents.get(candidate);
        if (parentId === void 0 || parentId === candidate) break;
        candidate = parentId;
      }
      return candidate;
    }

    /**
     * 目录顺序优先于 byId 枚举顺序；从 root 做 DFS，既覆盖直接 child，也覆盖递归 child。
     * 不把 root 本身放入结果，因而不会猜测根会话的模型或思考深度。
     *
     * 目录来源固定为会话投影 `projectionsBySession[sessionId].values.subagentCatalog`：
     * 它只提供身份/时间/模式/标签，因此任务名与运行状态仍从 byId 投影与 DEG 元数据读取。
     */
    function collectSubagentCatalog(sessionList, currentRootSessionId) {
      const sessionEntries = readEntries(sessionList?.byId);
      const sessions = new Map();
      for (const [fallbackId, session] of sessionEntries) {
        const sessionId = sessionIdOf(session, fallbackId);
        if (sessionId !== void 0) sessions.set(sessionId, session);
      }
      const childrenByParent = new Map();
      const addChild = (parentId, childId, child, taskName) => {
        if (typeof parentId !== "string" || typeof childId !== "string" || parentId === childId) return;
        if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
        const children = childrenByParent.get(parentId);
        if (children.some((entry) => entry.childId === childId)) return;
        children.push({ childId, child, taskName: metadataString(taskName) });
        if (!sessions.has(childId) && child && typeof child === "object") sessions.set(childId, child);
      };
      // 会话投影目录是显式顺序来源，先加入它，再用 byId 的父子字段补齐投影尚未落地的 child。
      for (const relation of readSubagentCatalogRelations(sessionList?.projectionsBySession)) {
        addChild(relation.parentId, relation.childId, relation.child, relation.taskName);
      }
      for (const [sessionId, session] of sessions) {
        const parentId = subagentParentIdOf(session);
        if (parentId !== void 0) addChild(parentId, sessionId, session, void 0);
      }
      if (typeof currentRootSessionId !== "string" || currentRootSessionId.length === 0) return [];

      const result = [];
      const visited = new Set([currentRootSessionId]);
      const visit = (parentId) => {
        for (const { childId, child, taskName: catalogTaskName } of childrenByParent.get(parentId) ?? []) {
          if (visited.has(childId)) continue;
          visited.add(childId);
          const session = sessions.get(childId) ?? child;
          const metadata = normalizeSubagentMetadata(session);
          result.push({
            sessionId: childId,
            // catalog entry.label 是原生菜单任务名的直接来源，byId 字段只作 fallback。
            taskName: catalogTaskName ?? subagentTaskNameOf(session),
            ...metadata,
            metadata,
          });
          visit(childId);
        }
      };
      visit(currentRootSessionId);
      return result;
    }

    /** 同源 Host RPC 的唯一 child 元数据读取入口；失败和非 child 响应都安全返回 null。 */
    async function requestSubagentMetadata(sessionId, request = globalThis?.fetch, signal, connection) {
      if (typeof sessionId !== "string" || sessionId.length === 0) return null;
      if (typeof request !== "function" && typeof connection?.rpc?.call !== "function") return null;
      try {
        const rpc = connection?.rpc;
        const response = typeof rpc?.call === "function"
          ? await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, { action: "get", sessionId, childHint: true }, signal)
          : await request(RPC_PATH, {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            ...(signal === void 0 ? {} : { signal }),
            body: JSON.stringify({ action: "get", sessionId, childHint: true }),
          });
        if (response?.ok !== true) return null;
        const payload = typeof response?.json === "function" ? await response.json() : response?.value;
        if (payload?.ok !== true || payload?.kind !== "child") return null;
        return normalizeSubagentMetadata(payload.child);
      } catch {
        return null;
      }
    }

    function nativeElementChildren(node) {
      return Array.from(node?.childNodes ?? []).filter((child) => child?.nodeType === 1);
    }

    function nativeElements(root) {
      if (root == null) return [];
      const elements = root?.nodeType === 1 ? [root] : [];
      try {
        for (const element of Array.from(root.querySelectorAll?.("*") ?? [])) {
          if (!elements.includes(element)) elements.push(element);
        }
      } catch {}
      return elements;
    }

    /** 只遍历当前 treeitem 自己的 row；嵌套 treeitem 由独立循环处理。 */
    function nativeRowElements(root) {
      if (root == null) return [];
      const elements = root?.nodeType === 1 ? [root] : [];
      const visit = (node) => {
        for (const child of Array.from(node?.childNodes ?? [])) {
          if (child?.nodeType !== 1 || hasNativeRole(child, "treeitem")) continue;
          elements.push(child);
          visit(child);
        }
      };
      visit(root);
      return elements;
    }

    function hasNativeRole(node, role) {
      return node?.getAttribute?.("role") === role;
    }

    function hasLocalClass(node, localName) {
      const className = node?.getAttribute?.("class");
      if (typeof className !== "string") return false;
      // CSS Module 常见形态是 label_hash/label__hash；不把 not-label 拆分成 label。
      return className.split(/\s+/).some((token) => {
        if (token.startsWith("not-" + localName) || token.startsWith("not_" + localName)) return false;
        return token === localName
          || token.startsWith(localName + "_")
          || token.startsWith(localName + "-")
          || token.endsWith("_" + localName)
          || token.includes("_" + localName + "_");
      });
    }

    function findNativeTrees(root) {
      const trees = [];
      if (hasNativeRole(root, "tree")) trees.push(root);
      try {
        for (const tree of Array.from(root?.querySelectorAll?.('[role="tree"]') ?? [])) {
          if (!trees.includes(tree)) trees.push(tree);
        }
      } catch {}
      return trees;
    }

    function findTreeItems(tree) {
      const items = [];
      if (hasNativeRole(tree, "treeitem")) items.push(tree);
      try {
        for (const item of Array.from(tree?.querySelectorAll?.('[role="treeitem"]') ?? [])) {
          if (!items.includes(item)) items.push(item);
        }
      } catch {}
      return items;
    }

    function isSubagentTreeAriaLabel(value) {
      const label = metadataString(value);
      return label !== void 0 && /(subagent|child[ -]?agent|子代理)/i.test(label);
    }

    function nativeTreeHasCatalogTask(tree, taskNames) {
      return findTreeItems(tree).some((item) => {
        const parts = findNativeSubagentRowParts(item);
        return taskNames.has(metadataString(parts.label?.textContent));
      });
    }

    /**
     * aria-label 能明确表明子代理菜单时只接受唯一候选；否则用目录任务名匹配，
     * 多个候选树视为歧义并 fail closed，避免污染其他 tree。
     */
    function findNativeSubagentTrees(root, catalog) {
      const trees = findNativeTrees(root);
      if (!Array.isArray(catalog) || trees.length === 0) return [];
      const ariaTrees = trees.filter((tree) => isSubagentTreeAriaLabel(tree?.getAttribute?.("aria-label")));
      if (ariaTrees.length > 1) return [];
      if (ariaTrees.length === 1) return ariaTrees;
      const taskNames = new Set(catalog
        .map((record) => metadataString(record?.taskName))
        .filter((taskName) => taskName !== void 0));
      if (taskNames.size === 0) return [];
      const matchingTrees = trees.filter((tree) => nativeTreeHasCatalogTask(tree, taskNames));
      return matchingTrees.length === 1 ? matchingTrees : [];
    }

    function findNativeSubagentTreeItems(root, catalog) {
      const items = [];
      for (const tree of findNativeSubagentTrees(root, catalog)) {
        for (const item of findTreeItems(tree)) {
          if (!items.includes(item)) items.push(item);
        }
      }
      return items;
    }

    function nativeContains(parent, child) {
      if (parent === child) return true;
      if (typeof parent?.contains === "function") return parent.contains(child);
      let current = child?.parentNode;
      while (current != null) {
        if (current === parent) return true;
        current = current.parentNode;
      }
      return false;
    }

    /** class hash 不稳定，所以只按 token 局部名识别；没有局部名时退回 row 的稳定子节点顺序。 */
    function findNativeSubagentRowParts(item) {
      const elements = nativeRowElements(item).filter((element) => !isSubagentMetadataNode(element));
      const labelNodes = elements.filter((element) => hasLocalClass(element, "label"));
      const summaryNodes = elements.filter((element) => hasLocalClass(element, "summary"));
      let label = labelNodes.length === 1 ? labelNodes[0] : void 0;
      let summary = summaryNodes.length === 1 ? summaryNodes[0] : void 0;
      const contentNodes = elements.filter((element) => hasLocalClass(element, "content"));
      if (contentNodes.length > 1 || labelNodes.length > 1 || summaryNodes.length > 1) {
        return { label: void 0, summary: void 0 };
      }
      const content = contentNodes.length === 1 ? contentNodes[0] : void 0;
      const containers = [];
      // 无 content class 时仅把 row 自身的恰好两个子块视为结构 fallback。
      for (const container of content !== void 0 ? [content] : contentNodes.length === 0 ? [item] : []) {
        if (container != null && !containers.includes(container)) containers.push(container);
      }
      for (const container of containers) {
        const children = nativeElementChildren(container).filter((element) => !isSubagentMetadataNode(element));
        // 只有恰好两个稳定 row 子块时才使用结构 fallback，避免猜测任意节点。
        if (children.length !== 2) continue;
        if (label === void 0 && labelNodes.length === 0) label = children[0];
        if (summary === void 0 && summaryNodes.length === 0) summary = children.find((element) => element !== label);
        if (label !== void 0 && summary !== void 0) break;
      }
      if (label === summary) return { label: void 0, summary: void 0 };
      return { label, summary };
    }

    function isSubagentMetadataNode(node) {
      return typeof node?.getAttribute === "function" && node.getAttribute(SUBAGENT_METADATA_MARKER) !== null;
    }

    function findSubagentMetadataNodes(root) {
      return (root?.getAttribute?.("role") === "treeitem" ? nativeRowElements(root) : nativeElements(root))
        .filter(isSubagentMetadataNode);
    }

    function removeSubagentMetadataNode(node) {
      try {
        if (typeof node?.remove === "function") node.remove();
        else node?.parentNode?.removeChild?.(node);
      } catch {}
    }

    function removeSubagentMetadata(root) {
      const nodes = findSubagentMetadataNodes(root);
      for (const node of nodes) removeSubagentMetadataNode(node);
      return nodes.length;
    }

    function rpcMetadataFor(rpcMetadata, sessionId) {
      if (rpcMetadata instanceof Map) return rpcMetadata.get(sessionId);
      return rpcMetadata?.[sessionId];
    }

    function metadataForSubagentRecord(record, rpcMetadata) {
      const rpc = rpcMetadataFor(rpcMetadata, record?.sessionId);
      return normalizeSubagentMetadata({ ...(record?.metadata ?? {}), ...record, ...(rpc ?? {}) });
    }

    /**
     * 只处理已选定子代理 tree 中能按任务名匹配目录的 treeitem。
     * 唯一 label 可直接匹配；重复 label 必须有稳定 session id，否则保守跳过。
     */
    function nativeSubagentSessionIdOf(item) {
      for (const name of ["data-session-id", "data-subagent-id", "data-id"]) {
        const value = metadataString(item?.getAttribute?.(name));
        if (value !== void 0) return value;
      }
      return void 0;
    }

    function applySubagentMetadata(root, catalog, rpcMetadata) {
      const records = Array.isArray(catalog) ? catalog : [];
      const items = findNativeSubagentTreeItems(root, records);
      const recordsByTask = new Map();
      const recordsBySession = new Map();
      for (const record of records) {
        const taskName = metadataString(record?.taskName);
        if (taskName === void 0 || typeof record?.sessionId !== "string") continue;
        if (!recordsByTask.has(taskName)) recordsByTask.set(taskName, []);
        recordsByTask.get(taskName).push(record);
        if (recordsBySession.has(record.sessionId)) recordsBySession.set(record.sessionId, null);
        else recordsBySession.set(record.sessionId, record);
      }
      const rowLabelCounts = new Map();
      const rowParts = new Map();
      for (const item of items) {
        const parts = findNativeSubagentRowParts(item);
        rowParts.set(item, parts);
        const taskName = metadataString(parts.label?.textContent);
        if (taskName !== void 0) rowLabelCounts.set(taskName, (rowLabelCounts.get(taskName) ?? 0) + 1);
      }
      for (const item of items) {
        const parts = rowParts.get(item) ?? { label: void 0, summary: void 0 };
        const existing = findSubagentMetadataNodes(item);
        const taskName = metadataString(parts.label?.textContent);
        const candidates = taskName === void 0 ? [] : recordsByTask.get(taskName) ?? [];
        const rowSessionId = nativeSubagentSessionIdOf(item);
        let record;
        if (rowSessionId !== void 0) {
          const candidate = recordsBySession.get(rowSessionId);
          if (candidate !== null && candidate?.taskName === taskName) record = candidate;
        } else if (taskName !== void 0 && rowLabelCounts.get(taskName) === 1 && candidates.length === 1) {
          // 唯一任务名可直接匹配；重复 label 没有稳定 id 时必须保持不注入。
          record = candidates[0];
        }
        const text = parts.summary == null || record === void 0
          ? null
          : formatSubagentMetadata(metadataForSubagentRecord(record, rpcMetadata));
        if (text === null || parts.summary?.parentNode == null) {
          for (const node of existing) removeSubagentMetadataNode(node);
          continue;
        }
        const node = existing[0] ?? parts.summary.ownerDocument?.createElement?.("span") ?? parts.summary.parentNode?.ownerDocument?.createElement?.("span");
        if (node == null) continue;
        if (existing.length > 1) {
          for (const duplicate of existing.slice(1)) removeSubagentMetadataNode(duplicate);
        }
        if (!isSubagentMetadataNode(node)) {
          node.setAttribute?.(SUBAGENT_METADATA_MARKER, "");
          node.className = SUBAGENT_METADATA_CLASS;
        }
        if (node.textContent !== text) node.textContent = text;
        if (node.parentNode !== parts.summary.parentNode || node.nextSibling !== parts.summary) {
          parts.summary.parentNode.insertBefore(node, parts.summary);
        }
      }
      // 菜单重建后旧 marker 可能暂时落在 tree 外；它们也属于插件所有权，必须立即清掉。
      for (const node of findSubagentMetadataNodes(root)) {
        if (!items.some((item) => nativeContains(item, node))) removeSubagentMetadataNode(node);
      }
      return findSubagentMetadataNodes(root).length;
    }

    /**
     * 安装 DSH 宿主原生运行状态桥。插件只观察并替换宿主已经渲染的主文本节点，
     * 不创建自己的状态行，不写入 class/style/aria，也不触碰宿主的鲸鱼动画和计时器。
     *
     * 多 scope 语义：主视图与右侧 sidebar.chat 会同时渲染同构的 conversation scope，
     * 各自绑定自己的 session。因此桥不再只挑"一个当前会话"，而是为文档中每个身份可验证的
     * 原生状态目标建立一条独立 lane（按 sessionId 归并）：
     * - lane 归属来自 scope 自己的会话证据（scope 自身 + [data-conversation-content] 外层）；
     *   多个 scope 若都唯一证明属于同一会话则共享 lane 并一起更新，缺失或冲突证据仍 fail-closed；
     * - 每条 lane 用自己的 session 快照（running / 插件 marker）与自己的 RPC 身份
     *   （kind / role）决定文案，异步请求带 per-lane serial + AbortController：
     *   旧响应、被取消的响应和其他会话的响应都不能写进本 lane；
     * - 会话离开快照、停止运行或插件卸载时，只恢复该 lane 覆盖过的字段，
     *   其他 lane（例如仍在运行的主视图）保持自己的角色文案。
     */
    function installNativeStatusBridge(ctx) {
      const doc = typeof document !== "undefined" ? document : null;
      const root = doc?.body ?? doc?.documentElement;
      const sessionStore = ctx?.sessions?.list;
      if (root == null || typeof sessionStore?.getSnapshot !== "function" || typeof sessionStore?.subscribe !== "function") return () => {};

      let disposed = false;
      let sessionList = {};
      let observer = null;
      /** sessionId -> lane：每个会话拥有自己的重写器、身份缓存与在途请求。 */
      const lanes = new Map();

      /**
       * 建立一条会话 lane。lane 只改写自己会话的目标：row rewriter 决定"改哪几个字段"，
       * lane 决定"这个会话现在是什么身份、该显示什么文案"。
       */
      const createLane = (sessionId) => ({
        sessionId,
        rewriter: createNativeStatusRowRewriter({
          resolveTargets: () => resolveNativeStatusTargets(root, sessionId, true),
        }),
        identityKey: null,
        rpcState: { sessionId: void 0, kind: "pending", role: void 0 },
        requestSerial: 0,
        controller: null,
      });

      /** 快照里该会话的最新条目：异步响应回来时要看最新 running，而不是发起请求时的快照。 */
      const currentEntryOf = (sessionId) => sessionEntryOf(sessionList, sessionId);

      /**
       * 用本 lane 自己的快照与 RPC 身份决定文案。身份态只在 rpcState.sessionId 等于本 lane
       * 会话时生效，因此任何跨会话残留都退化成 pending（fail-closed），不会借用别人的角色。
       */
      const renderLane = (lane, entry) => {
        if (disposed) return;
        const statusText = resolveRunningStatusText({
          sessionId: lane.sessionId,
          currentSessionId: lane.sessionId,
          running: entry?.running,
          session: entry,
          kind: lane.rpcState.sessionId === lane.sessionId ? lane.rpcState.kind : "pending",
          role: lane.rpcState.sessionId === lane.sessionId ? lane.rpcState.role : void 0,
        });
        lane.rewriter.apply(statusText);
      };

      /**
       * 同步一条 lane 的身份并立即渲染一次。身份键必须同时包含**运行状态**：
       * - 空闲时挂载的 lane 没有发过身份查询，会话真正开始生成时必须走一次转换去查询，
       *   否则会一直停留在"没有身份"的 pending 分支，永远保留宿主原文；
       * - 运行 → 停止也必须走同一条转换路径：中止在途请求并按 serial 让迟到响应失效，
       *   随后同一会话重新运行时可以再次查询（不复用停止前的缓存或在途状态）。
       * 只有身份形状与运行状态都没变时才提前返回，避免重复请求（例如宿主重渲染）。
       */
      const refreshLane = (lane, entry) => {
        const markedRole = normalizeStatusRole(entry?.[STATUS_ROLE_MARKER] ?? entry?.metadata?.[STATUS_ROLE_MARKER]);
        const childSession = isPluginChildSession(entry);
        const nextKey = [lane.sessionId, childSession ? "child" : "root", markedRole ?? "", entry?.running === true ? "running" : "idle"].join("\u0000");
        if (nextKey === lane.identityKey) {
          renderLane(lane, entry);
          return;
        }
        lane.identityKey = nextKey;
        lane.requestSerial += 1;
        lane.controller?.abort();
        lane.controller = null;
        lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "pending", role: markedRole };
        renderLane(lane, entry);
        // 非运行态不需要身份确认：不为后台/已停止会话发无谓请求。
        if (entry?.running !== true) return;
        const requestToken = lane.requestSerial;
        lane.controller = typeof AbortController === "function" ? new AbortController() : null;
        (async () => {
          try {
            const response = await requestPluginRpc(ctx.connection, {
              action: "get", sessionId: lane.sessionId, childHint: childSession,
            }, lane.controller === null ? {} : { signal: lane.controller.signal });
            // stale / 跨会话守卫：serial、lane 归属或插件生命周期任一变化都不得写 DOM。
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane) return;
            if (!response?.ok) {
              lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "unknown", role: markedRole };
              renderLane(lane, currentEntryOf(lane.sessionId));
              return;
            }
            const json = await response.json();
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane) return;
            const identity = resolveStatusIdentity({ sessionId: lane.sessionId, responseSessionId: lane.sessionId, response: json });
            if (identity === null) return;
            const markerFallbackKind = markedRole !== void 0 && identity.kind === "unknown" ? "child" : identity.kind;
            lane.rpcState = { sessionId: lane.sessionId, kind: markerFallbackKind, role: identity.role ?? markedRole };
            renderLane(lane, currentEntryOf(lane.sessionId));
          } catch (error) {
            if (disposed || requestToken !== lane.requestSerial || lanes.get(lane.sessionId) !== lane || error?.name === "AbortError") return;
            lane.rpcState = { sessionId: lane.sessionId, kind: markedRole !== void 0 ? "child" : "unknown", role: markedRole };
            renderLane(lane, currentEntryOf(lane.sessionId));
          }
        })();
      };

      /** 丢弃一条 lane：取消在途请求并恢复它覆盖过的字段（只恢复插件确实写过的值）。 */
      const dropLane = (lane) => {
        lane.requestSerial += 1;
        lane.controller?.abort();
        lane.controller = null;
        lane.rewriter.restore();
        lanes.delete(lane.sessionId);
      };

      const sync = () => {
        if (disposed) return;
        try {
          sessionList = sessionStore.getSnapshot() ?? {};
        } catch {
          sessionList = {};
        }
        // DOM 决定候选会话：每个有唯一会话证据的 scope/状态行对应自己的 lane，
        // 因此主视图与侧栏各自绑定自己的 session，不再依赖"当前主视图会话"。
        const candidates = collectNativeStatusSessionIds(root);
        const candidateIds = new Set(candidates);
        for (const sessionId of candidates) {
          const entry = currentEntryOf(sessionId);
          // 快照里没有这个会话（例如其他会话的历史 DOM）时不建立 lane，保持宿主原文。
          if (entry === void 0) continue;
          const lane = lanes.get(sessionId) ?? createLane(sessionId);
          lanes.set(sessionId, lane);
          refreshLane(lane, entry);
        }
        // 会话从快照移除，或其 DOM scope 整体卸载时，都释放 lane 与旧节点引用；
        // scope 重建后会建立新 lane 并重新确认身份，避免 detached DOM 被长期保留。
        for (const lane of [...lanes.values()]) {
          if (currentEntryOf(lane.sessionId) === void 0 || !candidateIds.has(lane.sessionId)) {
            dropLane(lane);
          }
        }
      };

      let unsubscribe = () => {};
      try {
        const cleanup = sessionStore.subscribe(sync);
        if (typeof cleanup === "function") unsubscribe = cleanup;
      } catch {
        // 会话服务拒绝订阅时仍保留一次初始渲染，并由原生文案安全降级。
      }
      sync();

      const Observer = doc?.defaultView?.MutationObserver
        ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
      if (typeof Observer === "function") {
        try {
          // DOM 变化同样走完整 sync：宿主可能先建行、后建 scope，只重渲染会漏掉刚出现的
          // lane；同一身份不会重复发 RPC（identityKey 未变时只做一次幂等渲染）。
          observer = new Observer(() => sync());
          observer.observe(root, { childList: true, subtree: true, characterData: true });
        } catch {
          observer = null;
        }
      }
      return () => {
        if (disposed) return;
        disposed = true;
        try { unsubscribe(); } catch {}
        try { observer?.disconnect(); } catch {}
        observer = null;
        // 卸载必须让每条 lane 都恢复宿主原文，并取消全部在途身份请求。
        for (const lane of [...lanes.values()]) dropLane(lane);
      };
    }

    /**
     * shell.overlay 中的独立元数据桥：仅为原生子代理菜单插入一行文本，始终返回 null。
     * 会话快照变化时重建目录；RPC 和 observer 各自拥有 cleanup，旧响应不能污染新 root。
     */
    function SubagentMetadataBridge({ ctx, useSessions }) {
      const sessionList = useSessionList(ctx, useSessions) ?? {};
      const sessionEntries = react.useMemo(() => readEntries(sessionList.byId), [sessionList]);
      const currentSessionId = currentSessionIdOf(sessionList);
      const projectionsBySession = sessionList.projectionsBySession;
      const currentRootSessionId = react.useMemo(
        () => resolveSubagentRootSessionId(sessionEntries, currentSessionId, projectionsBySession),
        [currentSessionId, sessionEntries, projectionsBySession],
      );
      const catalog = react.useMemo(
        () => collectSubagentCatalog({ byId: sessionEntries, projectionsBySession }, currentRootSessionId),
        [currentRootSessionId, sessionEntries, projectionsBySession],
      );
      const catalogRef = react.useRef(catalog);
      catalogRef.current = catalog;
      // 只把 root、身份、任务名和可用元数据纳入 key；activity 变化不应重启相同 RPC。
      const catalogKey = JSON.stringify({
        root: currentRootSessionId ?? null,
        records: catalog.map((record) => ({
          sessionId: record.sessionId,
          taskName: record.taskName,
          role: record.role,
          provider: record.provider,
          model: record.model,
          reasoningEffort: record.reasoningEffort,
        })),
      });
      const [rpcState, setRpcState] = react.useState(() => ({ catalogKey: "", values: new Map() }));
      const rpcMetadata = rpcState.catalogKey === catalogKey ? rpcState.values : null;

      react.useEffect(() => {
        let cancelled = false;
        const controller = typeof AbortController === "function" ? new AbortController() : null;
        setRpcState({ catalogKey, values: new Map() });
        const unresolved = catalogRef.current.filter((record) => formatSubagentMetadata(record) === null);
        if (unresolved.length > 0) {
          void Promise.all(unresolved.map(async (record) => [
            record.sessionId,
            await requestSubagentMetadata(record.sessionId, globalThis?.fetch, controller?.signal, ctx.connection),
          ])).then((results) => {
            if (cancelled) return;
            const values = new Map();
            for (const [sessionId, metadata] of results) {
              if (typeof sessionId === "string" && metadata !== null) values.set(sessionId, metadata);
            }
            setRpcState((previous) => previous.catalogKey === catalogKey
              ? { catalogKey, values }
              : previous);
          }).catch(() => {});
        }
        return () => {
          cancelled = true;
          controller?.abort();
        };
      }, [catalogKey]);

      react.useEffect(() => {
        const doc = typeof document !== "undefined" ? document : null;
        const root = doc?.body ?? doc?.documentElement;
        let disposed = false;
        if (root == null) return () => {};
        const render = () => {
          if (!disposed) applySubagentMetadata(root, catalogRef.current, rpcMetadata);
        };
        render();
        const Observer = doc?.defaultView?.MutationObserver
          ?? (typeof globalThis !== "undefined" ? globalThis.MutationObserver : void 0);
        if (typeof Observer !== "function") return () => {
          disposed = true;
          removeSubagentMetadata(root);
        };
        const observer = new Observer(() => {
          // applySubagentMetadata 只在文案或位置变化时写 DOM，observer 不会因自身更新循环触发。
          render();
        });
        observer.observe(root, { childList: true, subtree: true, characterData: true });
        return () => {
          disposed = true;
          observer.disconnect();
          removeSubagentMetadata(root);
        };
      }, [catalogKey, rpcMetadata]);
      return null;
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    SubagentMetadataBridge, applySubagentMetadata, bindClientRuntime, collectSubagentCatalog, expertGroupRootSessionIdOf,
    findNativeSubagentRowParts, findNativeSubagentTreeItems, findNativeSubagentTrees, formatSubagentMetadata, installNativeStatusBridge,
    normalizeSubagentMetadata, removeSubagentMetadata, requestSubagentMetadata,
  });
})(globalThis);
