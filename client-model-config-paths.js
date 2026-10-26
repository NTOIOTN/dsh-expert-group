/**
 * 「模型配置」区域的纯 draft/path 原语族（R8 票据 28）。
 *
 * 从 client-model-config.js 机械外移：正文逐行保留，只有 wrapper、导出面与文件头是本票新增的。
 * 本模块**不依赖任何兄弟 IIFE**（不碰 provider / namespace / schema / card 结构），因此处在
 * 依赖链最底层：client-model-config-rows.js 与 client-model-config.js 都只读它的检查点，
 * 反向依赖被禁止（由 scripts/check-dependency-graph.mjs 的 C1 校验）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-model-config-paths")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在 rows 与 client-model-config.js 之前）。
 */
(function installClientModelConfigPaths(global) {
  "use strict";

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（与相邻侧车模块约定一致）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config-paths");

  /** 草稿里必须被显式删除的"空值"：空字符串与 undefined 都不应写进用户层。 */
  function isBlankDraftValue(value) {
    return value === undefined || value === null || value === "";
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  /**
   * schema 节点判定。
   *
   * schemastery 的节点是**可调用对象**（`typeof node === "function"`），因此不能只接受
   * plain object：`isPlainObject(schemaNode)` 恒为 false，会让协议词表、默认值等
   * schema 派生的读取全部静默退化成空。这里同时接受可调用节点与普通对象字面量，
   * 这样测试里手写的 schema 描述对象也仍然可用。
   */
  function isSchemaNode(value) {
    return isPlainObject(value) || typeof value === "function";
  }

  function isNonEmptyString(value) {
    return typeof value === "string" && value.trim().length > 0;
  }

  /** JSON 等值判定：草稿比较、pathOps 去重与冲突判定共用同一套语义。 */
  function jsonEqual(left, right) {
    if (Object.is(left, right)) return true;
    if (left === undefined || right === undefined) return left === right;
    if (typeof left !== typeof right) return false;
    if (left === null || right === null) return false;
    if (typeof left !== "object") return false;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  /** 纯 JSON 深拷贝：草稿必须与 settings 快照解耦，绝不就地修改宿主对象。 */
  function deepClone(value) {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => deepClone(item));
    const clone = {};
    for (const [key, item] of Object.entries(value)) clone[key] = deepClone(item);
    return clone;
  }

  /**
   * 按路径读取嵌套值；数组下标同样支持。
   * @param {unknown} value
   * @param {readonly string[]} path
   * @returns {unknown}
   */
  function getPath(value, path) {
    let current = value;
    for (const key of Array.isArray(path) ? path : []) {
      if (Array.isArray(current)) {
        current = current[Number(key)];
        continue;
      }
      if (current === null || typeof current !== "object") return undefined;
      current = current[key];
    }
    return current;
  }

  /**
   * 按路径判断键是否存在（`undefined` 值也算存在：这是用户覆盖的判定依据）。
   * @param {unknown} value
   * @param {readonly string[]} path
   * @returns {boolean}
   */
  function hasPath(value, path) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) {
      return isPlainObject(value) && Object.keys(value).length > 0;
    }
    const parent = getPath(value, segments.slice(0, -1));
    const key = segments[segments.length - 1];
    if (Array.isArray(parent)) return Number.isSafeInteger(Number(key)) && Number(key) >= 0 && Number(key) < parent.length;
    if (parent === null || typeof parent !== "object") return false;
    return Object.prototype.hasOwnProperty.call(parent, key);
  }

  /**
   * 不可变写入：复制路径上的每一层容器，绝不修改入参。
   * @param {Record<string, unknown>} root
   * @param {readonly string[]} path
   * @param {unknown} value
   * @returns {Record<string, unknown>}
   */
  function setPath(root, path, value) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) throw new Error("setPath 需要非空路径");
    if (Array.isArray(root)) {
      const next = [...root];
      next[Number(segments[0])] = segments.length === 1 ? value : setPath(next[Number(segments[0])], segments.slice(1), value);
      return next;
    }
    const source = isPlainObject(root) ? root : {};
    const next = { ...source };
    const [head, ...rest] = segments;
    next[head] = rest.length === 0 ? value : setPath(source[head], rest, value);
    return next;
  }

  /**
   * 不可变删除：路径末端的容器类型与原值一致；路径不存在时原样返回。
   * @param {Record<string, unknown>} root
   * @param {readonly string[]} path
   * @returns {Record<string, unknown>}
   */
  function deletePath(root, path) {
    const segments = Array.isArray(path) ? path : [];
    if (segments.length === 0) return isPlainObject(root) ? {} : root;
    if (!hasPath(root, segments)) return root;
    if (Array.isArray(root)) {
      const next = [...root];
      const [head, ...rest] = segments;
      if (rest.length === 0) next.splice(Number(head), 1);
      else next[Number(head)] = deletePath(next[Number(head)], rest);
      return next;
    }
    const next = { ...root };
    const [head, ...rest] = segments;
    if (rest.length === 0) Reflect.deleteProperty(next, head);
    else next[head] = deletePath(next[head], rest);
    return next;
  }

  function getSubtree(root, path) {
    const value = getPath(root, path);
    return isPlainObject(value) ? value : {};
  }

  /**
   * 从 provider 路由 id 推导凭据引用：与 DSH 内置模型设置页完全同一条规则。
   * @param {string} provider
   * @returns {string}
   */
  function deriveKeyRef(provider) {
    const text = isNonEmptyString(provider) ? provider : "";
    return text.toUpperCase().replace(/[^A-Z0-9]+/g, "_") + "_API_KEY";
  }

  /**
   * 计算从 `before` 到 `after` 的最小路径操作序列。
   * 只命名两边观察到的键：只在一侧出现的键产生 set/unset，值相等的键不产生操作。
   *
   * @param {readonly string[]} base
   * @param {unknown} before
   * @param {unknown} after
   * @param {readonly string[]} [allowedKeys]
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function pathOps(base, before, after, allowedKeys) {
    const prefix = Array.isArray(base) ? base : [];
    const previous = isPlainObject(before) ? before : {};
    const next = isPlainObject(after) ? after : {};
    const allowed = Array.isArray(allowedKeys) ? new Set(allowedKeys) : null;
    const ops = [];
    for (const [key, value] of Object.entries(next)) {
      if (allowed !== null && !allowed.has(key)) continue;
      if (jsonEqual(previous[key], value)) continue;
      ops.push({ op: "set", path: [...prefix, key], value: deepClone(value) });
    }
    for (const key of Object.keys(previous)) {
      if (allowed !== null && !allowed.has(key)) continue;
      if (Object.prototype.hasOwnProperty.call(next, key)) continue;
      ops.push({ op: "unset", path: [...prefix, key] });
    }
    return ops;
  }

  /** 是否有可提交的路径操作。 */
  function hasOps(ops) {
    return Array.isArray(ops) && ops.length > 0;
  }

  /**
   * namespace revision 冲突判定：提交前复核卡片读到的 revision 是否仍是当前值。
   * @param {number} expectedRevision
   * @param {number} currentRevision
   * @returns {boolean}
   */
  function revisionConflictOf(expectedRevision, currentRevision) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return false;
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) return true;
    return expectedRevision !== currentRevision;
  }

  /**
   * 卡片进入编辑态时固定的基线：草稿基底 + revision 栅栏 + 继承来源。
   * @param {{ revision?: number, user?: unknown, base?: unknown, value?: unknown }} snapshot
   * @param {readonly string[]} path
   * @returns {{ revision: number | null, userSubtree: Record<string, unknown>, effectiveSubtree: Record<string, unknown>, inherited: Record<string, unknown> }}
   */
  function createEditorBaseline(snapshot, path) {
    const source = isPlainObject(snapshot) ? snapshot : {};
    const revision = Number.isSafeInteger(source.revision) && source.revision >= 0 ? source.revision : null;
    const user = source.user;
    const pinned = getPath(source.base, path);
    return {
      revision,
      userSubtree: getSubtree(user, path),
      effectiveSubtree: getSubtree(source.value, path),
      inherited: isPlainObject(pinned) ? deepClone(pinned) : {},
    };
  }

  /**
   * 恢复默认：删除用户覆盖（settings.mutate 的 unset 操作），继承值随即生效。
   * @param {readonly string[]} path
   * @returns {Array<{ op: "unset", path: string[] }>}
   */
  function restoreDefaultOps(path) {
    return [{ op: "unset", path: [...(Array.isArray(path) ? path : []), "models"] }];
  }

  /**
   * 相对 *已存储* 用户层的最小子树操作（provider 资料编辑用）：
   * 只命名卡片能看到的字段，未展示的字段绝不重建。
   *
   * @param {unknown} stored - 已存储的用户子树（可能不存在）。
   * @param {Record<string, unknown>} draft - 卡片编辑后的子树。
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function providerSubtreeOps(stored, draft) {
    return pathOps([], stored, draft);
  }

  // 只暴露被下游实际消费的符号（无全量外挂）：rows 读 13 个、client-model-config.js 读 18 个；
  // 这里把 18 个原语整体发布，避免"谁读谁"的清单随调用点漂移（模块级只读面，非可变状态）。
  global[SYMBOL] = Object.freeze({
    isBlankDraftValue,
    isPlainObject,
    isSchemaNode,
    isNonEmptyString,
    jsonEqual,
    deepClone,
    getPath,
    hasPath,
    setPath,
    deletePath,
    getSubtree,
    deriveKeyRef,
    pathOps,
    hasOps,
    revisionConflictOf,
    createEditorBaseline,
    restoreDefaultOps,
    providerSubtreeOps,
  });
})(globalThis);
