(function installModelConfig(global) {
  "use strict";

  /**
   * 「模型配置」区域的**唯一纯数据流实现**（浏览器安全的 classic IIFE）。
   *
   * 这里只放纯逻辑，不放 React 组件、不发请求、不读写 DOM：
   * - provider 目录装配（`llm/listProviders` × `llm/listConfigurableProviders`）；
   * - credentials 引用推导（与 DSH 内置模型设置页同一条 `<ROUTE>_API_KEY` 规则）；
   * - settings 命名空间路径操作（用户覆盖 materialize / 恢复默认 / 应用草稿）；
   * - 模型目录草稿（模型 ID、显示名、上下文窗口、最大输出 token、输入类型）；
   * - 七个可多选思考档位与 `reasoningEfforts` 的双向映射；
   * - provider 卡片的应用/取消草稿、revision 冲突判定与角色联动守卫。
   *
   * client.js 只从 `globalThis[Symbol.for("dsh-expert-group/client-model-config")]`
   * 取回这份实现并负责渲染，因此同一份判定既被设置页使用，也被 node:test 直接调用，
   * 不存在"测试里一份、界面里另一份"的平行实现。
   */

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（与相邻侧车模块约定一致）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config");

  /**
   * 七个可多选思考档位，顺序固定为 DSH 的 pi-ai 词表顺序
   * （`packages/llm/llm-pi-ai/src/catalog.ts` 的 THINKING_LEVEL_GATE）。
   * 界面永远按这个顺序渲染七个复选框，与当前目录是否声明支持无关。
   */
  const REASONING_EFFORTS = Object.freeze([
    "off", "minimal", "low", "medium", "high", "xhigh", "max",
  ]);

  /** `off` 档写入的**空字符串值**：DSH 的 schemastery 联合把 `off` 表达为"无 dispatch 值"。 */
  const REASONING_EFFORT_EMPTY = "";

  /** 目录条目的输入类型词表（text / image）。 */
  const INPUT_MODALITIES = Object.freeze(["text", "image"]);

  /** 模型目录未声明输入类型时的回退（与 DSH 的 `defaultInput` 默认值一致）。 */
  const DEFAULT_INPUT_MODALITIES = Object.freeze(["text"]);

  /** 容量字段：K/M 后缀词表与十进制换算（1K = 1000，1M = 1000000）。 */
  const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;
  const CAPACITY_SCALE = Object.freeze({ k: 1000, m: 1000000 });

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

  /** 模型显示名的归一读取：空显示名回退到模型 ID。 */
  function modelDisplayNameOf(model) {
    if (!isPlainObject(model)) return "";
    if (isNonEmptyString(model.name)) return model.name;
    return typeof model.id === "string" ? model.id : "";
  }

  /**
   * 读一条已存储模型条目的输入类型：数组优先，未声明时返回回退值。
   * @param {unknown} model
   * @param {readonly string[]} [fallback]
   * @returns {string[]}
   */
  function modelInputOf(model, fallback) {
    const declared = isPlainObject(model) ? model.input : undefined;
    if (Array.isArray(declared) && declared.length > 0) {
      return declared.filter((value) => typeof value === "string");
    }
    if (Array.isArray(fallback) && fallback.length > 0) return [...fallback];
    return [...DEFAULT_INPUT_MODALITIES];
  }

  /** 一行模型草稿的浅拷贝读取；非对象按空行处理。 */
  function modelRowOf(value) {
    return isPlainObject(value) ? { ...value } : {};
  }

  /** 把任意数组归一为模型草稿数组（逐行浅拷贝，隐藏字段原样保留）。 */
  function modelDraftsOf(value) {
    return Array.isArray(value) ? value.map((entry) => modelRowOf(entry)) : [];
  }

  /** 描述输入类型字段是否存在用户覆盖。 */
  function inputOverrideOf(model) {
    const declared = isPlainObject(model) ? model.input : undefined;
    return Array.isArray(declared) && declared.length > 0;
  }

  /** 思考档位多选集合的空值：七档全不勾选。 */
  function emptyEffortSelection() {
    const selection = {};
    for (const level of REASONING_EFFORTS) selection[level] = false;
    return selection;
  }

  /**
   * 从模型条目的 `reasoningEfforts` 映射恢复勾选状态。
   *
   * 已有条目：只有"键存在且值不是 false"才算勾选（`off` 的空字符串 / null 都是勾选）。
   * 新条目（字段缺失）与显式 `false`：七档全部不勾选。
   * `reasoningEfforts: false` 表示"非推理模型"，不作为任何档位的勾选来源。
   * @param {unknown} model
   * @returns {Record<string, boolean>}
   */
  function effortSelectionFor(model) {
    const selection = emptyEffortSelection();
    if (!isPlainObject(model)) return selection;
    const declared = model.reasoningEfforts;
    if (declared === false || !isPlainObject(declared)) return selection;
    for (const level of REASONING_EFFORTS) {
      if (!Object.prototype.hasOwnProperty.call(declared, level)) continue;
      selection[level] = declared[level] !== false;
    }
    return selection;
  }

  /** 两份勾选状态是否等价（只比较七个可见档位）。 */
  function effortSelectionEqual(left, right) {
    const a = isPlainObject(left) ? left : {};
    const b = isPlainObject(right) ? right : {};
    return REASONING_EFFORTS.every((level) => (a[level] === true) === (b[level] === true));
  }

  /** `reasoningEfforts` 里未被界面展示的键（未知键必须原样保留）。 */
  function unknownEffortKeysOf(declared) {
    if (!isPlainObject(declared)) return [];
    return Object.keys(declared).filter((key) => !REASONING_EFFORTS.includes(key));
  }

  /** 判断一份映射在"七档可见键"之外是否还有内容。 */
  function hasUnknownEffortKeys(declared) {
    return unknownEffortKeysOf(declared).length > 0;
  }

  /** 记录两条模型路径的 diff 行（纯函数，供侧栏/测试断言使用）。 */
  function reasoningDiffLines(before, after) {
    const lines = [];
    const beforePaths = new Map();
    const afterPaths = new Map();
    const collect = (map, rows) => {
      (Array.isArray(rows) ? rows : []).forEach((row, index) => {
        if (!isPlainObject(row) || !isNonEmptyString(row.id)) return;
        map.set(row.id.trim(), { index, efforts: jsonEqual(row.reasoningEfforts, undefined) ? undefined : row.reasoningEfforts });
      });
    };
    collect(beforePaths, before);
    collect(afterPaths, after);
    const ids = [...new Set([...beforePaths.keys(), ...afterPaths.keys()])];
    for (const id of ids) {
      const previous = beforePaths.get(id);
      const next = afterPaths.get(id);
      if (previous === undefined) {
        lines.push({ id, kind: "added", levels: selectedLevelsOf(next?.efforts) });
        continue;
      }
      if (next === undefined) {
        lines.push({ id, kind: "removed", levels: selectedLevelsOf(previous.efforts) });
        continue;
      }
      const beforeLevels = selectedLevelsOf(previous.efforts);
      const afterLevels = selectedLevelsOf(next.efforts);
      const added = afterLevels.filter((level) => !beforeLevels.includes(level));
      const removed = beforeLevels.filter((level) => !afterLevels.includes(level));
      if (added.length > 0 || removed.length > 0) lines.push({ id, kind: "changed", added, removed });
    }
    return lines;
  }

  /** 一份 `reasoningEfforts` 映射当前勾选的档位（用于 diff 展示）。 */
  function selectedLevelsOf(declared) {
    if (!isPlainObject(declared)) return [];
    return REASONING_EFFORTS.filter((level) => Object.prototype.hasOwnProperty.call(declared, level) && declared[level] !== false);
  }

  /**
   * 把勾选状态写回一份 `reasoningEfforts` 映射。
   *
   * - `off` 勾选写空字符串值，其余档位写同名小写字符串；
   * - 只增删七个可见键，未展示的未知键原样保留；
   * - 七档全不勾选且没有未知键时返回 `undefined`（调用方据此删除该字段）。
   *
   * @param {Record<string, boolean>} selection
   * @param {unknown} previous
   * @returns {Record<string, unknown> | undefined}
   */
  function applyEffortSelection(selection, previous) {
    const source = isPlainObject(selection) ? selection : {};
    const next = isPlainObject(previous) ? { ...previous } : {};
    for (const level of REASONING_EFFORTS) {
      if (source[level] === true) next[level] = level === "off" ? REASONING_EFFORT_EMPTY : level;
      else Reflect.deleteProperty(next, level);
    }
    if (Object.keys(next).length === 0) return undefined;
    return next;
  }

  /**
   * 归一一条模型草稿里的 `reasoningEfforts`：
   * 界面写入的键都指向档位名（或 `off` 的空字符串），因此直接复用七档映射规则。
   * @param {Record<string, unknown>} model
   * @returns {Record<string, unknown>}
   */
  function normalizeEffortsEntry(model) {
    const row = modelRowOf(model);
    const declared = row.reasoningEfforts;
    if (!isPlainObject(declared)) {
      if (declared === false) Reflect.deleteProperty(row, "reasoningEfforts");
      return row;
    }
    const selection = {};
    for (const level of REASONING_EFFORTS) {
      selection[level] = Object.prototype.hasOwnProperty.call(declared, level) && declared[level] !== false;
    }
    const next = applyEffortSelection(selection, declared);
    if (next === undefined) Reflect.deleteProperty(row, "reasoningEfforts");
    else row.reasoningEfforts = next;
    return row;
  }

  /** 构建一条新模型草稿：新模型七档全不勾选，输入类型留空（继承目录/默认值）。 */
  function createModelRow(id) {
    return { id: typeof id === "string" ? id : "" };
  }

  /** 读取一行草稿的输入类型勾选（未声明时回退到目录/默认值）。 */
  function inputSelectionFor(model, fallback) {
    return modelInputOf(model, fallback);
  }

  /**
   * 应用一条模型行的编辑。
   *
   * `patch` 里的 `undefined` / `''` / `null` 都表示清空该字段（从用户层删除），
   * 其余字段原样保留，因此隐藏字段与未知键都不会被重建丢失。
   *
   * @param {Record<string, unknown>} model
   * @param {Record<string, unknown>} patch
   * @returns {Record<string, unknown>}
   */
  function patchModelDraft(model, patch) {
    const row = modelRowOf(model);
    const next = { ...row };
    for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
      if (isBlankDraftValue(value)) Reflect.deleteProperty(next, key);
      else next[key] = value;
    }
    return normalizeEffortsEntry(next);
  }

  /**
   * 整表替换一条模型行的 `reasoningEfforts`（卡片草稿路径）。
   * @param {readonly unknown[]} models
   * @param {number} index
   * @param {Record<string, boolean>} selection
   * @returns {Record<string, unknown>[]}
   */
  function setModelEffortSelection(models, index, selection) {
    const rows = modelDraftsOf(models);
    return rows.map((row, at) => {
      if (at !== index) return row;
      const next = { ...row };
      const efforts = applyEffortSelection(selection, row.reasoningEfforts);
      if (efforts === undefined) Reflect.deleteProperty(next, "reasoningEfforts");
      else next.reasoningEfforts = efforts;
      return next;
    });
  }

  /**
   * 整表替换一条模型行的输入类型（卡片草稿路径）。
   * @param {readonly unknown[]} models
   * @param {number} index
   * @param {readonly string[] | undefined} modalities
   * @returns {Record<string, unknown>[]}
   */
  function setModelInputSelection(models, index, modalities) {
    const rows = modelDraftsOf(models);
    return rows.map((row, at) => {
      if (at !== index) return row;
      const next = { ...row };
      const declared = Array.isArray(modalities)
        ? modalities.filter((value) => INPUT_MODALITIES.includes(value))
        : [];
      if (declared.length === 0) Reflect.deleteProperty(next, "input");
      else next.input = declared;
      return next;
    });
  }

  /** 删除一条模型行。 */
  function removeModelRow(models, index) {
    return modelDraftsOf(models).filter((_row, at) => at !== index);
  }

  /** 追加一条空模型行（新模型七档全不勾选）。 */
  function appendModelRow(models, id) {
    return [...modelDraftsOf(models), createModelRow(id)];
  }

  /**
   * 容量字段文本 -> 数值：空文本表示继承（`undefined`），不可读文本为 `NaN`。
   * @param {string} text
   * @returns {number | undefined}
   */
  function parseCapacity(text) {
    const trimmed = typeof text === "string" ? text.trim() : "";
    if (trimmed.length === 0) return undefined;
    const match = CAPACITY_PATTERN.exec(trimmed);
    if (match === null) return Number.NaN;
    const suffix = match[2] === undefined ? undefined : match[2].toLowerCase();
    const scale = suffix === undefined ? 1 : CAPACITY_SCALE[suffix];
    const scaled = Number(match[1]) * scale;
    const rounded = Math.round(scaled);
    return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
  }

  /** 容量数值 -> 最短文本拼写（K/M 后缀，整千整百万才缩写）。 */
  function formatCapacity(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "";
    if (!Number.isInteger(value) || value <= 0) return String(value);
    if (value % CAPACITY_SCALE.m === 0) return String(value / CAPACITY_SCALE.m) + "M";
    if (value % CAPACITY_SCALE.k === 0) return String(value / CAPACITY_SCALE.k) + "K";
    return String(value);
  }

  /**
   * 归一并校验模型草稿数组：schema 之前先拒绝适配器无法表达的行。
   * @param {unknown} value
   * @returns {{ ok: boolean, rows: Record<string, unknown>[], error: string | null }}
   */
  function validateModelRows(value) {
    const rows = modelDraftsOf(value);
    const seen = new Set();
    for (const [index, row] of rows.entries()) {
      const position = index + 1;
      const id = typeof row.id === "string" ? row.id.trim() : "";
      if (id.length === 0) return { ok: false, rows, error: "第 " + position + " 行：模型 ID 不能为空" };
      if (seen.has(id)) return { ok: false, rows, error: "第 " + position + " 行：模型 ID 重复（" + id + "）" };
      seen.add(id);
      if (row.name !== undefined && (typeof row.name !== "string" || row.name.length === 0)) {
        return { ok: false, rows, error: "第 " + position + " 行：显示名必须是非空文本" };
      }
      for (const field of ["contextWindow", "maxTokens"]) {
        const raw = row[field];
        if (raw === undefined) continue;
        if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
          return {
            ok: false,
            rows,
            error: "第 " + position + " 行：" + (field === "contextWindow" ? "上下文窗口" : "最大输出 token") + "必须是正整数",
          };
        }
      }
      const declared = row.reasoningEfforts;
      if (declared !== undefined && declared !== false && !isPlainObject(declared)) {
        return { ok: false, rows, error: "第 " + position + " 行：思考档位映射必须是对象（或 false）" };
      }
    }
    return { ok: true, rows, error: null };
  }

  /**
   * 归一模型草稿：去掉纯空白字段、把 ID/显示名去首尾空白、重建七档映射。
   * @param {unknown} value
   * @returns {Record<string, unknown>[]}
   */
  function normalizeModelRows(value) {
    return modelDraftsOf(value)
      .map((row) => {
        const next = { ...row };
        if (typeof next.id === "string") next.id = next.id.trim();
        if (typeof next.name === "string") {
          const trimmed = next.name.trim();
          if (trimmed.length === 0) Reflect.deleteProperty(next, "name");
          else next.name = trimmed;
        }
        return normalizeEffortsEntry(next);
      })
      .filter((row) => {
        // 完全空白的行（用户在"添加模型"后没填 ID）不写进用户层。
        const onlyIdentity = Object.keys(row).length <= 1;
        return !(onlyIdentity && (row.id === undefined || row.id === ""));
      });
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

  /** 卡片当前是否持有用户覆盖（`user` 层存在该路径）。 */
   function modelCatalogOverridden(baseline) {
     if (!isPlainObject(baseline) || !isPlainObject(baseline.userSubtree)) return false;
     return Object.prototype.hasOwnProperty.call(baseline.userSubtree, "models")
       && Array.isArray(baseline.userSubtree.models);
   }

   function isOverridden(baseline) {
     if (!isPlainObject(baseline)) return false;
     return Object.keys(baseline.userSubtree ?? {}).length > 0;
   }

  /**
   * 模型目录的显示内容：有用户覆盖时用覆盖，否则用"适配器/组合层默认"的继承值。
   * 继承值优先取组合层（`base`）钉住的行，缺失时回退到已解析生效值里的行。
   *
   * @param {ReturnType<typeof createEditorBaseline>} baseline
   * @returns {{ overridden: boolean, models: Record<string, unknown>[], inherited: Record<string, unknown>[] }}
   */
  function inheritedModelsOf(baseline) {
    const source = isPlainObject(baseline) ? baseline : {};
    const overridden = modelCatalogOverridden(source);
    if (overridden) {
      return { overridden: true, models: modelDraftsOf(source.userSubtree?.models), inherited: [] };
    }
    const baseRows = Array.isArray(source.inherited?.models) ? source.inherited.models : undefined;
    const effectiveRows = Array.isArray(source.effectiveSubtree?.models) ? source.effectiveSubtree.models : [];
    return { overridden: false, models: modelDraftsOf(baseRows ?? effectiveRows), inherited: modelDraftsOf(baseRows ?? effectiveRows) };
  }

  /**
   * 卡片会话在删除用户覆盖后使用的默认模型目录。
   * 用户覆盖存在时不能从 effectiveSubtree 回退，因为 effectiveSubtree 仍包含覆盖本身。
   * @param {ReturnType<typeof createEditorBaseline>} baseline
   * @returns {Record<string, unknown>[]}
   */
  function fallbackModelsOf(baseline) {
    const source = isPlainObject(baseline) ? baseline : {};
    const baseRows = Array.isArray(source.inherited?.models) ? source.inherited.models : undefined;
    if (baseRows !== undefined) return modelDraftsOf(baseRows);
    if (modelCatalogOverridden(source)) return [];
    return modelDraftsOf(source.effectiveSubtree?.models);
  }

  /**
   * 首次编辑时 materialize 用户覆盖：把草稿整体写到用户层（settings.mutate 的 set 操作）。
   * @param {readonly string[]} path
   * @param {readonly unknown[]} models
   * @returns {Array<{ op: "set", path: string[], value: unknown }>}
   */
  function materializeOverrideOps(path, models) {
    return [{
      op: "set",
      path: [...(Array.isArray(path) ? path : []), "models"],
      value: modelDraftsOf(models),
    }];
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
   * 卡片提交的路径操作：相对进入编辑态时的 user 基线做 diff。
   * 未覆盖 + 草稿没有任何内容时不产生任何操作（不 materialize 空覆盖）。
   *
   * `profilePath` 是 **profile 子树**在命名空间内的路径（整段即 profile 时为空数组），
   * `draft` 是编辑后的 profile 子树（含 `models`、`baseURL`、`apiKeyEnv` 等卡片可见字段）。
   * diff 在 profile 层级进行，因此只命名卡片看到的键，未展示的字段绝不重建或删除。
   *
   * @param {{ profilePath: readonly string[], baseline: unknown, draft: Record<string, unknown>, catalogTouched?: boolean }} options
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
   function modelCatalogOps({ profilePath, baseline, draft, catalogTouched }) {
     const overridden = isOverridden(baseline);
     const rawDraft = isPlainObject(draft) ? draft : {};
     const includeModels = catalogTouched !== false;
     const sourceNext = includeModels
       ? rawDraft
       : (isPlainObject(baseline?.userSubtree) && Object.prototype.hasOwnProperty.call(baseline.userSubtree, "models")
         ? { ...rawDraft, models: deepClone(baseline.userSubtree.models) }
         : deletePath(rawDraft, ["models"]));
     const next = Array.isArray(sourceNext.models) && sourceNext.models.length === 0 && includeModels
       ? deletePath(sourceNext, ["models"])
       : sourceNext;
     // 未覆盖时只允许 materialize 真正有内容的草稿：直接点"应用"不能凭空写一份空 profile。
     if (!overridden && Object.keys(next).length === 0) return [];
     return pathOps(profilePath, overridden ? baseline.userSubtree : undefined, next, EDITABLE_PROFILE_FIELDS);
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

  /**
   * provider 卡片有权编辑的 profile 字段。
   *
   * 只命名卡片看到的字段是刻意的：settings.yaml 里的隐藏高级字段（transport、retryPolicy、
   * compat…）不进入草稿，因此既不会被显示，也不会在提交时被重建或删除（与 DSH 内置模型
   * 设置页"卡片只写自己的字段"同一条原则）。
   */
  const EDITABLE_PROFILE_FIELDS = Object.freeze(["displayName", "apiKeyEnv", "baseURL", "api", "models"]);

  /**
   * 把一份 profile 收敛到卡片有权编辑的字段。`models` 只在确实是数组时保留（空数组表示
   * "已清空目录"，等同恢复默认）。
   *
   * @param {unknown} source
   * @returns {Record<string, unknown>}
   */
  function modelEditableProfileOf(source) {
    if (!isPlainObject(source)) return {};
    const next = {};
    for (const field of EDITABLE_PROFILE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
      const value = source[field];
      if (value === undefined || value === null) continue;
      if (field === "models" && !Array.isArray(value)) continue;
      next[field] = deepClone(value);
    }
    return next;
  }

  /**
   * 「写入前 materialize」：把当前生效值（effective value）里卡片能看到的字段导入草稿。
   *
   * 这是"首次编辑才 materialize 用户覆盖"的实现方式：卡片在用户真正编辑时先导入，
   * 提交时再与 **已存储的用户层** diff，因此
   * - 没有用户覆盖时，导入值 + 编辑值就是这份覆盖的全部内容（等价于写入用户层）；
   * - 已有用户覆盖时，只有实际改动才会变成 set，未被改动的字段不会重复写入；
   * - 卡片编辑期间到达的外部提交不会让"已存在的用户覆盖"被误判成删除。
   *
   * @param {unknown} source - 已解析生效值里的 profile 子树（`namespace.value` 的路径值）。
   * @returns {Record<string, unknown>}
   */
  function importNamespace(source) {
    return modelEditableProfileOf(source);
  }

  /**
   * 把一份完整的模型目录草稿换算成提交用的路径操作。
   *
   * @param {readonly string[]} modelsPath - 模型数组在命名空间内的路径。
   * @param {readonly {}[]} models - 归一后的模型目录（空数组表示"沿用适配器默认"）。
   * @returns {Array<{ op: "set" | "unset", path: string[], value?: unknown }>}
   */
  function catalogOpsFor(modelsPath, models) {
    const path = Array.isArray(modelsPath) ? modelsPath : [];
    const rows = modelDraftsOf(models);
    if (rows.length === 0) return [{ op: "unset", path: [...path] }];
    return [{ op: "set", path: [...path], value: rows }];
  }

  /**
   * 把「用户覆盖 materialize / 恢复默认」判定收敛成一次决策，供 UI 与测试共用。
   * @param {{ overridden: boolean, dirty: boolean, models: readonly unknown[] }} input
   * @returns {"reset" | "materialize" | "replace" | "noop"}
   */
  function modelOverrideDecision({ overridden, dirty, models }) {
    if (!dirty) return "noop";
    const empty = modelDraftsOf(models).length === 0;
    if (overridden && empty) return "reset";
    if (!overridden) return "materialize";
    return "replace";
  }

  /** 供 UI 显示的选择：把已存储行的模型选项归一为 `{ id, name }` 列表。 */
  function modelChoicesOf(rows) {
    return modelDraftsOf(rows)
      .filter((row) => isNonEmptyString(row.id))
      .map((row) => ({ id: row.id.trim(), name: modelDisplayNameOf(row) }));
  }

  /** 使目录行按 ID 索引，便于"取模型"时保留用户已调整的容量字段。 */
  function indexModelsById(rows) {
    const index = new Map();
    for (const row of modelDraftsOf(rows)) {
      if (isNonEmptyString(row.id)) index.set(row.id.trim(), row);
    }
    return index;
  }

  /**
   * 采纳端点/目录返回的候选模型：已存在的行（用户调过的数值）优先，其余新增。
   * 新采纳的行七档全不勾选（`effortSelectionFor` 对缺失字段即全不勾选）。
   *
   * @param {readonly unknown[]} rows
   * @param {readonly { id?: unknown, name?: unknown, contextWindow?: unknown, maxTokens?: unknown, inputModalities?: unknown }[]} candidates
   * @returns {Record<string, unknown>[]}
   */
  function adoptModels(rows, candidates) {
    const index = indexModelsById(rows);
    const next = modelDraftsOf(rows).map((row) => {
      const id = isNonEmptyString(row.id) ? row.id.trim() : "";
      return id.length === 0 ? row : index.get(id);
    });
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      if (!isPlainObject(candidate) || !isNonEmptyString(candidate.id)) continue;
      const id = candidate.id.trim();
      if (index.has(id)) continue;
      const row = { id };
      if (isNonEmptyString(candidate.name)) row.name = candidate.name;
      if (typeof candidate.contextWindow === "number") row.contextWindow = candidate.contextWindow;
      if (typeof candidate.maxTokens === "number") row.maxTokens = candidate.maxTokens;
      if (Array.isArray(candidate.inputModalities) && candidate.inputModalities.length > 0) {
        row.input = candidate.inputModalities.filter((value) => typeof value === "string");
      }
      index.set(id, row);
      next.push(row);
    }
    return next;
  }

  /**
   * 合并 provider 目录与已注册路由：声明顺序优先，未声明的活动路由追加在后。
   * @param {readonly { id?: unknown, name?: unknown }[]} registered
   * @param {readonly Record<string, unknown>[]} directory
   * @returns {Record<string, unknown>[]}
   */
  function joinProviderDirectory(registered, directory) {
    const active = new Set();
    for (const provider of Array.isArray(registered) ? registered : []) {
      if (isPlainObject(provider) && isNonEmptyString(provider.id)) active.add(provider.id);
    }
    const declared = new Set();
    const rows = [];
    for (const entry of Array.isArray(directory) ? directory : []) {
      if (!isPlainObject(entry) || !isNonEmptyString(entry.provider)) continue;
      declared.add(entry.provider);
      rows.push({
        provider: entry.provider,
        displayName: isNonEmptyString(entry.displayName) ? entry.displayName : entry.provider,
        settingsNs: typeof entry.settingsNs === "string" ? entry.settingsNs : "",
        settingsPath: Array.isArray(entry.settingsPath) ? [...entry.settingsPath] : [],
        active: active.has(entry.provider),
        declared: entry.declared === true,
        error: typeof entry.error === "string" && entry.error.length > 0 ? entry.error : undefined,
      });
    }
    for (const provider of Array.isArray(registered) ? registered : []) {
      if (!isPlainObject(provider) || !isNonEmptyString(provider.id) || declared.has(provider.id)) continue;
      rows.push({
        provider: provider.id,
        displayName: isNonEmptyString(provider.name) ? provider.name : provider.id,
        settingsNs: "",
        settingsPath: [],
        active: true,
        declared: false,
        error: undefined,
      });
    }
    return rows;
  }

  /** provider 卡片是否可编辑（有可写 settings 命名空间与 profile 路径）。 */
  function providerEditable(row, namespace) {
    return isPlainObject(row) && isNonEmptyString(row.settingsNs) && isPlainObject(namespace);
  }

  /** provider 卡片是否可删除（用户层存在 profile）。 */
  function providerRemovable(row, namespace) {
    if (!isPlainObject(row) || !isPlainObject(namespace)) return false;
    if (row.settingsPath.length === 0 && row.settingsNs !== "") {
      // 整段即 profile：用户层存在任意键即视为可删除。
      return hasPath(namespace.user, row.settingsPath);
    }
    return hasPath(namespace.user, row.settingsPath);
  }

  /** 从有效配置与组合层读出 provider 的 profile（草稿基底）。 */
  function providerProfileOf(row, namespace) {
    if (!isPlainObject(row) || !isPlainObject(namespace)) return {};
    return getSubtree(namespace.value, row.settingsPath);
  }

  /** provider profile 的 apiKeyEnv（未声明时为空字符串）。 */
  function apiKeyEnvOf(row, namespace) {
    const profile = providerProfileOf(row, namespace);
    return isNonEmptyString(profile.apiKeyEnv) ? profile.apiKeyEnv : "";
  }

  /** provider 卡片的凭据引用：profile 的 apiKeyEnv 优先，否则用同一条推导规则。 */
  function credentialRefOf(row, namespace) {
    const named = apiKeyEnvOf(row, namespace);
    return named.length > 0 ? named : deriveKeyRef(isPlainObject(row) ? row.provider : "");
  }

  /**
   * 从命名空间自己的 schema 读出可选协议列表（手写 route 的 `api` 字段）。
   *
   * 显式给出非空 `settingsPath` 时按该路径查询（provider 的 profile 基路径不一定是
   * `providers`）；省略或给空数组时按 pi-ai profile 的默认形状 `providers.<route>.api`
   * 查询。`nodeAtPath` 自己会穿过 dict 的 inner 节点，因此这里不需要知道中间层是 dict
   * 还是 object。
   *
   * @param {unknown} root - 已 rehydrate 的 schema 节点。
   * @param {string} provider
   * @param {{ nodeAtPath?: Function }} operations
   * @param {readonly string[]} [settingsPath]
   * @returns {string[]}
   */
   function protocolChoices(root, provider, operations, settingsPath) {
     if (!isPlainObject(operations) || typeof operations.nodeAtPath !== "function") return [];
     if (!isNonEmptyString(provider)) return [];
     const profilePath = Array.isArray(settingsPath) && settingsPath.length > 0
      ? settingsPath
      : ["providers", provider];
     let node;
    try {
      node = operations.nodeAtPath(root, [...profilePath, "api"]);
    } catch {
      return [];
    }
    if (!isSchemaNode(node) || node.type !== "union" || !Array.isArray(node.list)) return [];
    return node.list
      .map((entry) => (isSchemaNode(entry) ? entry.value : undefined))
      .filter((value) => typeof value === "string" && value.length > 0);
  }

  /**
   * 创建一个基于 describe 视图的同步 schema 适配器。
   *
   * 只使用设置服务自己的公开面：schema 来自 describe 返回的 `SettingsNamespaceView.schema`，
   * rehydrate/validate/nodeAtPath 优先用注入的公开服务（DSH 的 `settingsSchema`）；宿主没有
   * 该服务时退化为"直接按 schemastery 的 `new Schema(信封)` 语义读取 schema 信封"，
   * 再没有就只能不校验（把拒绝留给正式 settings API）。因此这里既不碰 DSH 核心文件，
   * 也不复制 schemastery 的实现。
   *
   * @param {{ rehydrate?: Function, validate?: Function, nodeAtPath?: Function }} operations
   * @param {{ Schema?: Function }} [fallback] - 可选的结构化兜底（测试注入 schemastery 用）。
   */
  function createSchemaAdapter(operations, fallback) {
    const ops = isPlainObject(operations) ? operations : {};
    const schemaConstructor = isPlainObject(fallback) && typeof fallback.Schema === "function" ? fallback.Schema : null;
    const rehydrate = typeof ops.rehydrate === "function" ? ops.rehydrate : null;
    const validate = typeof ops.validate === "function" ? ops.validate : null;
    const nodeAtPath = typeof ops.nodeAtPath === "function" ? ops.nodeAtPath : null;
    /** 结构化兜底实现：与 DSH 公开服务同语义的遍历/校验最小集合。 */
    const structural = {
      rehydrate(serialized) {
        if (schemaConstructor === null) return undefined;
        try {
          return new schemaConstructor(serialized);
        } catch {
          return undefined;
        }
      },
      /**
       * 用 schema 节点自身做一次真实校验（DSH 的 schema 服务同语义：校验语义在节点上，
       * 服务只负责把抛错转成文本）。宿主没有 schmastery 构造器时退化为"不本地校验"，
       * 拒绝仍然由正式 settings API 负责。
       */
      validateNode(schema, draft) {
        if (schema === undefined || schema === null || typeof schema !== "function") return undefined;
        try {
          schema(draft);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      nodeAtPath(root, path) {
        let node = root;
        for (const key of Array.isArray(path) ? path : []) {
          if (node === null || node === undefined || typeof node !== "object") return undefined;
          if (node.type === "object") node = isPlainObject(node.dict) ? node.dict[key] : undefined;
          else if (node.type === "dict" || node.type === "array") node = node.inner;
          else return undefined;
        }
        return node;
      },
    };
    return {
      available: rehydrate !== null || schemaConstructor !== null,
      rehydrate(serialized) {
        if (rehydrate !== null) {
          try {
            return rehydrate(serialized);
          } catch {
            // 无法 rehydrate 的 schema 信封不能证明任何草稿合法：按"无 schema"处理。
            return undefined;
          }
        }
        return structural.rehydrate(serialized);
      },
      /**
       * 校验草稿；没有 schema 能力时返回 `undefined`（交给正式的 settings API 拒绝）。
       * @returns {string | undefined}
       */
      validate(schema, draft) {
        if (schema === undefined || schema === null) return undefined;
        if (validate !== null) {
          try {
            const outcome = validate(schema, draft);
            if (outcome !== undefined && outcome !== null) return String(outcome);
            // 注入的公开服务返回"通过"时仍需结构化复核：DSH 的 schema 服务只把
            // 抛错转成文本，真实校验语义始终在 schema 节点自身。
            return structural.validateNode(schema, draft);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        }
        return structural.validateNode(schema, draft);
      },
      nodeAtPath(root, path) {
        if (root === undefined || root === null) return undefined;
        if (nodeAtPath !== null) {
          try {
            return nodeAtPath(root, path);
          } catch {
            return undefined;
          }
        }
        return structural.nodeAtPath(root, path);
      },
    };
  }

  /**
   * 读取一个命名空间的 schema 节点与默认值（模型目录的继承来源）。
   * @param {{ schema?: unknown, value?: unknown, base?: unknown }} namespace
   * @param {ReturnType<typeof createSchemaAdapter>} adapter
   */
  function namespaceSchemaInfo(namespace, adapter) {
    const view = isPlainObject(namespace) ? namespace : {};
    const root = adapter === undefined ? undefined : adapter.rehydrate(view.schema);
    return {
      root,
      modelsNode: adapter === undefined ? undefined : adapter.nodeAtPath(root, ["models"]),
      defaultInput: (() => {
        const node = adapter === undefined ? undefined : adapter.nodeAtPath(root, ["defaultInput"]);
        const value = isSchemaNode(node) ? node.meta?.default : undefined;
        return Array.isArray(value) ? value.filter((entry) => typeof entry === "string") : undefined;
      })(),
    };
  }

  /**
   * 卡片保存前的本地校验：只校验卡片有权编辑的字段。
   *
   * 未展示的未知字段不参与判定（它们也不产生路径操作），因此这里不会因为
   * 结构外字段而拒绝一次合法编辑。
   *
   * @param {Record<string, unknown>} draft - 卡片草稿（profile 子树）。
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateProfileDraft(draft) {
    if (!isPlainObject(draft)) return null;
    for (const field of ["displayName", "baseURL", "api", "apiKeyEnv"]) {
      const value = draft[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "string") return field + " 必须是文本";
    }
    if (draft.models !== undefined) {
      const checked = validateModelRows(draft.models);
      if (!checked.ok) return checked.error;
    }
    return null;
  }

  // ── 角色联动：将要删除/取消的档位是否正被某些角色默认使用 ────────────────────

  /**
   * 计算受影响角色：provider 的某一档位将被删除（或该 provider 整体被删除）时，
   * `dsh-expert-group.defaults.<role>.reasoningEffort` 仍指向这一档的角色必须被列出。
   *
   * 绝不自动改写角色配置：调用方据此阻止保存并提示用户先去角色配置里改。
   *
   * @param {unknown} defaults - settings 里的 `defaults` 映射。
   * @param {{ provider: string, removedLevels?: readonly string[], removeProvider?: boolean }} change
   * @returns {Array<{ role: string, reasoningEffort: string }>}
   */
  function rolesAffectedByChange(defaults, change) {
    const source = isPlainObject(defaults) ? defaults : {};
    const provider = isNonEmptyString(change?.provider) ? change.provider : "";
    if (provider.length === 0) return [];
    const removed = new Set(
      (Array.isArray(change?.removedLevels) ? change.removedLevels : [])
        .filter((level) => typeof level === "string" && level.length > 0),
    );
    const removeProvider = change?.removeProvider === true;
    const affected = [];
    for (const [role, selection] of Object.entries(source)) {
      if (!isPlainObject(selection)) continue;
      if (selection.provider !== provider) continue;
      const effort = selection.reasoningEffort;
      if (typeof effort !== "string" || effort.length === 0) continue;
      if (removeProvider || removed.has(effort)) affected.push({ role, reasoningEffort: effort });
    }
    return affected;
  }

  /**
   * 角色联动拦截提示文案（中文，列出受影响角色）。
   * @param {readonly string[]} levels
   * @param {readonly { role: string, reasoningEffort: string }[]} affected
   * @param {(role: string) => string} [labelOf]
   * @returns {string}
   */
  function reasoningGuardMessage(levels, affected, labelOf) {
    const label = typeof labelOf === "function" ? labelOf : (role) => role;
    const parts = affected.map((entry) => label(entry.role) + "（" + entry.reasoningEffort + "）");
    return "无法保存：将删除的思考档位 " + levels.join("、") + " 正被以下专家角色使用：" + parts.join("、")
      + "。请先在这些角色的配置中改用其它档位，本页不会自动改写角色配置。";
  }

  /**
   * 从两份模型草稿算出"将被删除的档位"，只在保存前用于角色联动守卫。
   *
   * 整行被删除时该行声明的档位随行一起消失，因此**同样计入**删除集合（票据 20）：
   * 删除一条正被角色默认使用的模型行与删除整个 provider 是同一类破坏，不能因为
   * "只删了一行"就静默放过。
   * - 单行删除（卡片上的「删除」）→ 只计入被删那一行的档位；
   * - 「恢复默认」（draft.models 整个被移除）→ 所有原有行都算删除，与旧行为一致。
   *
   * 注意这是**档位级**判定（provider + reasoningEffort），不是模型 id 级判定：
   * 与既有"取消档位"守卫保持同一粒度，宁可多提示也不静默破坏角色默认配置。
   *
   * @param {readonly unknown[]} before - 进入编辑态时的行（继承或用户覆盖）。
   * @param {readonly unknown[]} after - 当前草稿行。
   * @returns {string[]} 将随这次保存消失的档位 id（去重、保持出现顺序）。
   */
  function removedLevelsOf(before, after) {
    const levels = new Set();
    const afterIndex = indexModelsById(after);
    for (const row of modelDraftsOf(before)) {
      if (!isNonEmptyString(row.id)) continue;
      const id = row.id.trim();
      const nextRow = afterIndex.get(id);
      const previousLevels = selectedLevelsOf(row.reasoningEfforts);
      if (nextRow === undefined) {
        // 整行被删除：它的档位随之消失，必须参与角色联动守卫。
        for (const level of previousLevels) levels.add(level);
        continue;
      }
      const nextLevels = selectedLevelsOf(nextRow.reasoningEfforts);
      for (const level of previousLevels) if (!nextLevels.includes(level)) levels.add(level);
    }
    return [...levels];
  }

  // ── 设置文档读取（沿用公开 settings API 的视图形状） ───────────────────────

  /**
   * 从 describe 视图取出命名空间视图。
   * @param {unknown} view
   * @param {string} ns
   * @returns {Record<string, unknown> | undefined}
   */
  function namespaceViewOf(view, ns) {
    const namespaces = isPlainObject(view) && Array.isArray(view.namespaces) ? view.namespaces : [];
    return namespaces.find((entry) => isPlainObject(entry) && entry.ns === ns);
  }

  /**
   * 从 settings 快照读角色默认选择（角色联动的数据源）。
   * @param {unknown} settingsValue
   * @returns {Record<string, unknown>}
   */
  function roleDefaultsOf(settingsValue) {
    const defaults = isPlainObject(settingsValue) ? settingsValue.defaults : undefined;
    return isPlainObject(defaults) ? defaults : {};
  }

  /**
   * 决定一次提交要写什么：路径操作、将被取消的档位、以及角色的守卫结论。
   *
   * 卡片只把"自己的草稿 + 进入编辑态时已存储的用户层"交给这里，因此
   * - 未覆盖时：materialize 用户覆盖（写入卡片可见的全部字段）；
   * - 已覆盖时：相对权威用户层的最小 diff，外部提交的字段不会被误删；
   * - 空档位行 / 空白显示名等在草稿校验阶段就被拒绝，不进入这里。
   *
   * @param {{
   *   provider: string,
   *   profilePath: readonly string[],
   *   storedUser: unknown,
   *   draft: Record<string, unknown>,
   *   inheritedModels: readonly unknown[],
   *   roleDefaults: unknown,
   *   catalogTouched?: boolean,
   * }} input
   * @returns {{
   *   ops: Array<{ op: "set" | "unset", path: string[], value?: unknown }>,
   *   removedLevels: string[],
   *   affectedRoles: Array<{ role: string, reasoningEffort: string }>,
   * }}
   */
  function modelCardApply(input) {
    const source = isPlainObject(input) ? input : {};
    const catalogTouched = source.catalogTouched === true;
    const profilePath = Array.isArray(source.profilePath) ? source.profilePath : [];
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const storedUser = source.storedUser;
    const baseline = { userSubtree: getSubtree(storedUser, profilePath) };
    const ops = modelCatalogOps({ profilePath, baseline, draft, catalogTouched });
    const rows = catalogTouched
      ? (Array.isArray(draft.models) ? draft.models : [])
      : [];
    // 档位守卫覆盖两类删除（票据 20）：取消某个档位、删除整行模型（含「恢复默认」
    // 隐式删除全部行）。删行不再需要 catalogReset 这个额外开关：草稿里的消失即删除。
    const removedLevels = catalogTouched
      ? removedLevelsOf(source.inheritedModels, rows)
      : [];
    const affectedRoles = removedLevels.length === 0
      ? []
      : rolesAffectedByChange(source.roleDefaults, { provider: source.provider, removedLevels });
    return { ops, removedLevels, affectedRoles, rows };
  }

  /**
   * provider 目录行的渲染面：与 DSH 内置模型设置页同一份 join 结果，只补上"是否已由用户配置"。
   *
   * @param {readonly Record<string, unknown>[]} rows
   * @param {(ns: string) => Record<string, unknown> | undefined} namespaceOf
   * @returns {{ configured: Record<string, unknown>[], addable: Record<string, unknown>[] }}
   */
  function providerListSections(rows, namespaceOf) {
    const lookup = typeof namespaceOf === "function" ? namespaceOf : () => undefined;
    const sections = [];
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!isPlainObject(row)) continue;
      const namespace = lookup(row.settingsNs);
      if (!isPlainObject(namespace)) continue;
      sections.push({
        row,
        namespace,
        // 用户层存在该 profile 才算"已配置"：值等于默认值也仍是覆盖，只看键是否存在。
        configured: hasPath(namespace.user, row.settingsPath),
      });
    }
    return {
      configured: sections.filter((entry) => entry.configured),
      addable: sections.filter((entry) => !entry.configured),
    };
  }

  /**
   * API Key 输入框的渲染面：只写不读明文、可按状态禁用、并给出引用提示。
   *
   * @param {{ provider: string, credentialRef: string, credential?: { configured?: boolean, writable?: boolean }, typed?: string, readOnly?: boolean }} input
   * @returns {{ ref: string, value: string, type: "password", autoComplete: "off", disabled: boolean, placeholder: string, hint: string }}
   */
  function apiKeyField(input) {
    const source = isPlainObject(input) ? input : {};
    const configured = isPlainObject(source.credential) && source.credential.configured === true;
    const writable = !isPlainObject(source.credential) || source.credential.writable !== false;
    const ref = isNonEmptyString(source.credentialRef) ? source.credentialRef : "";
    return {
      ref,
      value: typeof source.typed === "string" ? source.typed : "",
      type: "password",
      autoComplete: "off",
      disabled: source.readOnly === true || !writable,
      placeholder: writable ? (configured ? "已配置（留空表示不修改）" : "粘贴 API Key 后点应用") : "当前凭据只读",
      hint: ref.length === 0 ? "未设置凭据引用" : "凭据引用：" + ref + "（API Key 只写入 credentials 服务，保存后不回显明文）",
    };
  }

  /**
   * provider 卡片的渲染面：把"卡片看到的数据 + 可执行动作"收敛成一个可断言的对象。
   *
   * 界面按它渲染，测试按它断言，因此"模型配置区有哪些控件、哪些默认值、哪些禁用条件"
   * 不需要依赖 React 渲染器也能被验证。
   *
   * @param {{
   *   row: Record<string, unknown>,
   *   namespace: Record<string, unknown>,
   *   draft: Record<string, unknown>,
   *   expandedRows?: ReadonlySet<number> | readonly number[],
   *   defaultInput?: readonly string[],
   *   protocols?: readonly string[],
   *   credentialRef?: string,
   *   credential?: { configured?: boolean, writable?: boolean },
   *   typed?: string,
   *   readOnly?: boolean,
   *   fallbackModels?: readonly unknown[],
   * }} input
   */
  function buildModelCardModel(input) {
    const source = isPlainObject(input) ? input : {};
    const row = isPlainObject(source.row) ? source.row : {};
    const profilePath = Array.isArray(row.settingsPath) ? row.settingsPath : [];
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const inherited = modelDraftsOf(source.fallbackModels);
    const models = Array.isArray(draft.models) ? modelDraftsOf(draft.models) : inherited;
    // 「已按用户覆盖」= 草稿里有一份**非空**的模型目录。清空目录（恢复默认的草稿态）
    // 意味着回到适配器默认，而不是一份空覆盖。
    const overridden = typeof source.catalogOverridden === "boolean"
       ? source.catalogOverridden
       : Array.isArray(draft.models) && draft.models.length > 0;
    const expanded = new Set(
      source.expandedRows instanceof Set
        ? [...source.expandedRows]
        : (Array.isArray(source.expandedRows) ? source.expandedRows : []),
    );
    const defaultInput = Array.isArray(source.defaultInput) ? source.defaultInput : undefined;
    const credential = isPlainObject(source.credential) ? source.credential : undefined;
    const apiKey = apiKeyField({
      provider: row.provider,
      credentialRef: source.credentialRef ?? credentialRefOf(row, source.namespace),
      credential,
      typed: typeof source.typed === "string" ? source.typed : "",
      readOnly: source.readOnly === true,
    });
    const nameOf = (field, model) => {
      if (field === "id") return typeof model.id === "string" ? model.id : "";
      return typeof model.name === "string" ? model.name : "";
    };
    return {
      provider: row.provider,
      displayName: isNonEmptyString(row.displayName) ? row.displayName : row.provider,
      profilePath,
      readOnly: source.readOnly === true,
      apiKey,
      baseUrl: {
        value: typeof draft.baseURL === "string" ? draft.baseURL : "",
        placeholder: "留空表示使用适配器默认端点",
      },
      protocol: {
        value: typeof draft.api === "string" ? draft.api : "",
        options: [{
          value: "",
          label: "适配器默认",
        }, ...(Array.isArray(source.protocols) ? source.protocols : [])
          .filter((choice) => typeof choice === "string" && choice.length > 0)
          .map((choice) => ({ value: choice, label: choice }))],
      },
      models: models.map((model, index) => {
        const selection = effortSelectionFor(model);
        const inputSelected = modelInputOf(model, defaultInput);
        return {
          index,
          position: index + 1,
          id: { value: nameOf("id", model), editable: true },
          name: { value: nameOf("name", model), editable: true },
          contextWindow: {
            value: typeof model.contextWindow === "number" ? formatCapacity(model.contextWindow) : "",
            placeholder: "继承适配器默认",
          },
          maxTokens: {
            value: typeof model.maxTokens === "number" ? formatCapacity(model.maxTokens) : "",
            placeholder: "继承适配器默认",
          },
          reasoningDefaults: { value: "模型默认", editable: false },
          efforts: REASONING_EFFORTS.map((level) => ({ level, checked: selection[level] === true })),
          inputs: INPUT_MODALITIES.map((modality) => ({
            modality,
            checked: inputSelected.includes(modality),
            // 至少保留一个输入类型：只剩一个已勾选项时该项不可再取消。
            locked: inputSelected.length === 1 && inputSelected.includes(modality),
          })),
          advancedOpen: expanded.has(index),
        };
      }),
      modelCatalog: {
        overridden,
        label: overridden ? "已按用户覆盖" : "适配器默认（首次编辑时写入用户覆盖）",
        emptyHint: "没有模型：留空表示沿用适配器内置目录",
        canReset: overridden,
      },
      actions: {
        apply: source.readOnly === true ? "disabled" : "enabled",
        cancel: "enabled",
        fetchModels: source.readOnly === true ? "disabled" : "enabled",
        addModel: source.readOnly === true ? "disabled" : "enabled",
        addProvider: source.readOnly === true ? "disabled" : "enabled",
        removeProvider: source.readOnly === true ? "disabled" : "enabled",
        edit: "enabled",
      },
    };
  }

  /**
   * provider 卡片的一次编辑会话（纯状态机，界面与测试共用）。
   *
   * 它只做与渲染无关的判定：合并草稿、算动作、校验、以及一次成功/失败提交的结论，
   * 因此"每个卡片独立应用/取消 + revision 冲突保护 + 角色联动守卫"可以在没有 React
   * 渲染器的情况下被完整验证。
   *
   * @param {{ provider: string, settingsNs?: string, profilePath: readonly string[], storedUser: unknown, value: unknown, revision: number, roleDefaults?: unknown }} input
   */
  function createCardSession(input) {
    const source = isPlainObject(input) ? input : {};
    const provider = isNonEmptyString(source.provider) ? source.provider : "";
    const settingsNs = typeof source.settingsNs === "string" ? source.settingsNs : "";
    const profilePath = Array.isArray(source.profilePath) ? source.profilePath : [];
    const startingUser = isPlainObject(source.storedUser) ? source.storedUser : {};
    let appliedUser = deepClone(startingUser);
    let currentEffective = source.value;
    let baseline = createEditorBaseline({
      revision: source.revision,
      user: appliedUser,
      base: source.base,
      value: currentEffective,
    }, profilePath);
    let fallbackModels = fallbackModelsOf(baseline);
    let draft = importNamespace(
      !isPlainObject(currentEffective) || profilePath.length === 0
        ? currentEffective
        : getPath(currentEffective, profilePath),
    );
    let catalogTouched = false;
    let catalogReset = false;
    let keyDraft = "";
    let closed = false;
    return {
      provider,
      settingsNs,
      profilePath,
      get draft() { return draft; },
      get revision() { return baseline.revision; },
      get closed() { return closed; },
      get overridden() {
        return catalogTouched
          ? Array.isArray(draft.models) && draft.models.length > 0
          : modelCatalogOverridden(baseline);
      },
      get modelRows() {
        return Array.isArray(draft.models) ? modelDraftsOf(draft.models) : modelDraftsOf(fallbackModels);
      },
      /** 交给渲染面的当前模型（与界面渲染用的是同一份数据）。 */
      cardModel(extra = {}) {
        return buildModelCardModel({
          row: { provider, settingsPath: profilePath },
          draft,
          fallbackModels: fallbackModels,
          catalogOverridden: catalogTouched
             ? Array.isArray(draft.models) && draft.models.length > 0
             : modelCatalogOverridden(baseline),
          ...extra,
        });
      },
      /** 用户开始编辑：首次编辑才把生效值导入草稿（等价于 materialize 用户覆盖）。 */
      edit(update) {
        if (closed) return draft;
        const imported = catalogReset || Array.isArray(draft.models) || fallbackModels.length === 0
          ? draft
          : { ...draft, models: deepClone(fallbackModels) };
        const beforeModels = isPlainObject(imported) && Object.prototype.hasOwnProperty.call(imported, "models")
          ? imported.models
          : undefined;
        const next = update(imported);
        const afterModels = isPlainObject(next) && Object.prototype.hasOwnProperty.call(next, "models")
          ? next.models
          : undefined;
        if (!jsonEqual(beforeModels, afterModels)) catalogTouched = true;
        draft = next;
        return draft;
      },
      /** 恢复默认：删除用户覆盖（草稿层）。 */
      resetModels() {
        catalogTouched = true;
        catalogReset = true;
        draft = deletePath(draft, ["models"]);
        return draft;
      },
      setFallbackModels(models) {
        fallbackModels = modelDraftsOf(models);
        return fallbackModels;
      },
      typeKey(value) {
        keyDraft = typeof value === "string" ? value : "";
        return keyDraft;
      },
      /** 尚未提交的 API Key 明文（只存在于卡片内存里，用于"获取模型"探测）。 */
      get keyValue() { return keyDraft.trim(); },
      /** 取消：丢弃草稿与凭据输入，回到当前已存储状态（含已接受的权威视图）。 */
      cancel() {
        draft = importNamespace(
          !isPlainObject(currentEffective) || profilePath.length === 0
            ? currentEffective
            : getPath(currentEffective, profilePath),
        );
        catalogTouched = false;
        catalogReset = false;
        keyDraft = "";
        return draft;
      },
      /**
       * 计算一次"应用"的结果，但**不落盘**：返回要提交的路径操作与凭据输入，
       * 由宿主面负责真正写入（正式 settings API + credentials 服务）。
       */
      plan() {
        const key = keyDraft.trim();
        // pi-ai only names the conventional credential reference when a key is
        // actually supplied. Without this field the credential would be stored
        // successfully but the provider profile would not point at it.
        const draftForSave = key.length > 0 && settingsNs === "llm-pi-ai"
          && !isNonEmptyString(draft.apiKeyEnv)
          ? { ...draft, apiKeyEnv: deriveKeyRef(provider) }
          : draft;
        const validation = validateProfileDraft(draftForSave);
        if (validation !== null) return { ok: false, error: validation };
        if (Array.isArray(draftForSave.models)) {
          const rows = validateModelRows(draftForSave.models);
          if (!rows.ok) return { ok: false, error: rows.error };
        }
        const result = modelCardApply({
          provider,
          profilePath,
          storedUser: appliedUser,
          draft: draftForSave,
          inheritedModels: inheritedModelsOf(baseline).models,
          roleDefaults: source.roleDefaults,
          catalogTouched,
          catalogReset,
        });
        if (result.affectedRoles.length > 0) {
          return {
            ok: false,
            guard: true,
            removedLevels: result.removedLevels,
            affectedRoles: result.affectedRoles,
            error: reasoningGuardMessage(result.removedLevels, result.affectedRoles),
          };
        }
        const settingsDraft = deletePath(draftForSave, ["models"]);
        const ops = result.ops.length === 0 && key.length > 0 && !hasPath(appliedUser, profilePath)
          && Object.keys(settingsDraft).length === 0
          ? [{ op: "set", path: [...profilePath], value: {} }]
          : result.ops;
        return {
          ok: true,
          ops,
          expectedRevision: baseline.revision,
          keyValue: key.length === 0 ? undefined : key,
        };
      },
      /**
       * 提交成功后的收口：接受权威用户层与 revision 作为新基线，草稿回到已存储状态。
       *
       * 只接受卡片有权编辑的字段（隐藏高级字段继续留在用户层里，由宿主视图负责），
       * 因此接受之后的 plan() 恒为"无待提交操作"。
       */
      accept(view) {
        if (isPlainObject(view)) {
          appliedUser = isPlainObject(view.user) ? deepClone(view.user) : {};
          currentEffective = view.value;
          baseline = createEditorBaseline({
            revision: view.revision,
            user: appliedUser,
            base: view.base,
            value: view.value,
          }, profilePath);
          fallbackModels = fallbackModelsOf(baseline);
          draft = importNamespace(
            !isPlainObject(view.value) || profilePath.length === 0
              ? view.value
              : getPath(view.value, profilePath),
          );
        }
        catalogTouched = false;
        catalogReset = false;
        return draft;
      },
      close() {
        closed = true;
        return draft;
      },
    };
  }

  /**
   * 「模型配置」折叠区的渲染面：区域默认折叠、标题中文、展开后才读取目录。
   *
   * 两个 provider 入口与原生模型设置页同级：
   * - 添加提供方：从 DSH 已知但用户层尚未配置的 provider 中选择；
   * - 添加自定义提供方：声明 DSH 目录中不存在的新 route，需要 `llm-pi-ai` namespace
   *   提供至少一个合法协议，并且 settings 文档可写。
   *
   * @param {{
   *   open?: boolean,
   *   status?: string,
   *   configured?: readonly unknown[],
   *   addable?: readonly unknown[],
   *   error?: string | null,
   *   writable?: boolean,
   *   protocols?: readonly unknown[],
   *   canCreateCustom?: boolean,
   * }} input
   */
  function buildSectionModel(input) {
    const source = isPlainObject(input) ? input : {};
    const open = source.open === true;
    const status = typeof source.status === "string" ? source.status : "idle";
    const readOnly = source.writable === false;
    const addableCount = Array.isArray(source.addable) ? source.addable.length : 0;
    // 自定义入口的可用性独立判定：schema 能给出合法协议才可能提交，否则入口禁用而不是
    // 打开一张永远无法提交的卡片。
    const customAllowed = source.canCreateCustom === true;
    return {
      title: "模型配置",
      open,
      // 默认折叠是需求本身：折叠时既不渲染卡片，也不读取 provider 目录。
      disclosure: { expanded: open, bodyId: "deg-model-config-body", label: open ? "收起" : "展开" },
      status,
      loading: status === "loading",
      error: typeof source.error === "string" && source.error.length > 0 ? source.error : null,
      readOnly,
      configuredCount: Array.isArray(source.configured) ? source.configured.length : 0,
      addableCount,
      entries: {
        addProvider: { label: "添加提供方" },
        addCustom: { label: "添加自定义提供方", protocols: Array.isArray(source.protocols) ? source.protocols.length : 0 },
      },
      actions: {
        toggle: "enabled",
        addProvider: readOnly || status !== "ready" || addableCount === 0 ? "disabled" : "enabled",
        addCustom: readOnly || status !== "ready" || !customAllowed ? "disabled" : "enabled",
        reload: status === "loading" ? "disabled" : "enabled",
      },
      hint: "与 DSH 内置模型设置页同一份数据流：provider 目录、凭据状态与模型目录都来自宿主公开接口，保存走正式 settings API 与 schema 校验。",
    };
  }

  // ── 自定义 provider 创建（route id / Base URL / 协议 / 模型 校验） ─────────────

  /**
   * 自定义 provider 的 route id 词表：小写字母开头，只含小写字母、数字与连字符。
   *
   * 点号、下划线与其它标点一律排除，因为凭据引用由 route id 推导
   * （`deriveKeyRef` 把每段非字母数字折叠成一个下划线），允许这类字符会让
   * `a.b`、`a-b`、`a_b` 全部折叠到同一个引用而产生凭据冲突。这条规则同时是原生
   * provider 路由使用的字符集（字母/数字/连字符）。
   */
  const ROUTE_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;

  /** 没有 `URL` 构造器时的降级检查（只做形状校验，不解析端口与 IPv6）。 */
  const BASE_URL_FALLBACK_PATTERN = /^https?:\/\/[^\s/?#]+[^\s]*$/i;

  /**
   * 校验自定义 provider 的 Base URL。
   *
   * 用 `URL` 构造器而不是正则：端口、IPv6 方括号、百分号编码与主机名存在性都由平台
   * 解析器判定，正则无法覆盖（例如 `https://[::1` 未闭合、`https://host:99999` 非法端口、
   * `https://` 缺失主机都必须是错误）。降级路径只在宿主环境没有 `URL` 时使用。
   *
   * @param {unknown} value
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateBaseUrl(value) {
    if (typeof value !== "string" || value.trim().length === 0) return "请填写 Base URL（HTTP 或 HTTPS）";
    const trimmed = value.trim();
    const UrlConstructor = typeof URL === "function" ? URL : undefined;
    if (UrlConstructor === undefined) {
      return BASE_URL_FALLBACK_PATTERN.test(trimmed) ? null : "Base URL 必须以 http:// 或 https:// 开头，并包含主机名";
    }
    let parsed;
    try {
      parsed = new UrlConstructor(trimmed);
    } catch {
      // 未闭合的 IPv6 字面量、非法端口、缺少 scheme 等都会走到这里。
      return "Base URL 不是合法的 URL（请检查协议、主机、端口与括号）";
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "Base URL 只支持 http:// 或 https://";
    }
    if (typeof parsed.hostname !== "string" || parsed.hostname.length === 0) {
      return "Base URL 必须包含主机名";
    }
    if (parsed.port !== "") {
      const port = Number(parsed.port);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65535) return "Base URL 的端口必须在 1-65535 之间";
    }
    return null;
  }

  /**
   * 校验自定义 provider 的 route id。
   *
   * 去重同时按原始 route 与推导出的凭据引用判定：`a-b` 与 `ab` 这类不同 route 只要折叠出
   * 同一个 credential ref 就必须拒绝，否则第二个 provider 会静默复用第一个的 API Key。
   *
   * @param {unknown} value
   * @param {readonly string[]} [taken] - 已经存在的 route id（DSH 目录与已配置 provider）。
   * @returns {string | null} 失败文案，或 null 表示通过。
   */
  function validateRouteId(value, taken) {
    if (typeof value !== "string") return "请填写 provider 路由 ID";
    const trimmed = value.trim();
    if (trimmed.length === 0) return "请填写 provider 路由 ID";
    if (trimmed.length < 2) return "provider 路由 ID 至少 2 个字符";
    if (trimmed.length > 64) return "provider 路由 ID 最多 64 个字符";
    if (!ROUTE_ID_PATTERN.test(trimmed)) {
      return "provider 路由 ID 只允许小写字母、数字与连字符，且必须以字母开头、字母或数字结尾";
    }
    const existing = (Array.isArray(taken) ? taken : []).filter((id) => isNonEmptyString(id));
    if (existing.includes(trimmed)) return "provider「" + trimmed + "」已存在，请改用其它路由 ID";
    const wantedRef = deriveKeyRef(trimmed);
    const collided = existing.find((id) => id !== trimmed && deriveKeyRef(id) === wantedRef);
    if (collided !== undefined) {
      return "provider「" + trimmed + "」与「" + collided + "」会使用同一个凭据引用（"
        + wantedRef + "），请改用其它路由 ID";
    }
    return null;
  }

  /**
   * 校验自定义 provider 的协议：必须是宿主 schema 暴露的合法协议之一。
   * @param {unknown} value
   * @param {readonly string[]} [protocols]
   * @returns {string | null}
   */
  function validateProtocol(value, protocols) {
    const allowed = (Array.isArray(protocols) ? protocols : []).filter((entry) => isNonEmptyString(entry));
    if (allowed.length === 0) return "当前宿主没有提供可用的协议选项";
    if (!isNonEmptyString(value)) return "请选择协议";
    return allowed.includes(value) ? null : "协议「" + value + "」不在宿主支持的协议列表中";
  }

  /**
   * 校验自定义 provider 的完整草稿。
   *
   * 字段级错误同时返回，便于卡片逐字段提示；`ok` 只在整个草稿都能提交时为 true。
   *
   * @param {{
   *   routeId?: unknown,
   *   displayName?: unknown,
   *   baseURL?: unknown,
   *   api?: unknown,
   *   models?: unknown,
   *   apiKey?: unknown,
   *   takenRoutes?: readonly string[],
   *   protocols?: readonly string[],
   * }} input
   * @returns {{ ok: boolean, errors: Record<string, string>, error: string | null, routeId: string, profile: Record<string, unknown>, models: Record<string, unknown>[], apiKey: string }}
   */
  function validateCustomProviderDraft(input) {
    const source = isPlainObject(input) ? input : {};
    const errors = {};
    const routeId = typeof source.routeId === "string" ? source.routeId.trim() : "";
    const displayName = typeof source.displayName === "string" ? source.displayName.trim() : "";
    const baseURL = typeof source.baseURL === "string" ? source.baseURL.trim() : "";
    const apiKey = typeof source.apiKey === "string" ? source.apiKey.trim() : "";
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));

    const routeFailure = validateRouteId(routeId, source.takenRoutes);
    if (routeFailure !== null) errors.routeId = routeFailure;
    const urlFailure = validateBaseUrl(baseURL);
    if (urlFailure !== null) errors.baseURL = urlFailure;
    const protocolFailure = validateProtocol(source.api, protocols);
    if (protocolFailure !== null) errors.api = protocolFailure;
    if (displayName.length > 0 && displayName.length > 200) errors.displayName = "显示名最多 200 个字符";

    const rows = normalizeModelRows(source.models);
    if (rows.length === 0) errors.models = "至少配置一个模型";
    else {
      const checked = validateModelRows(rows);
      if (!checked.ok) errors.models = checked.error;
    }

    const profile = {};
    if (routeFailure === null && urlFailure === null && protocolFailure === null && Object.keys(errors).length === 0) {
      // 只有真正要写凭据时才声明凭据引用：留空 API Key 表示使用 provider 原生/环境凭据
      // （ambient authentication），此时写入 `apiKeyEnv` 会让宿主去找一条永远不存在的密钥。
      if (apiKey.length > 0) profile.apiKeyEnv = deriveKeyRef(routeId);
      if (displayName.length > 0) profile.displayName = displayName;
      profile.baseURL = baseURL;
      profile.api = source.api;
      profile.models = rows;
    }
    const firstError = Object.keys(errors).length === 0 ? null : errors[Object.keys(errors)[0]];
    return {
      ok: Object.keys(errors).length === 0,
      errors,
      error: firstError,
      routeId,
      profile,
      models: rows,
      apiKey,
    };
  }

  /**
   * 自定义 provider 创建卡片的**状态机**（纯状态机，界面与测试共用）。
   *
   * 二阶段提交是这里最重要的语义：settings（profile）先写，API Key 再单独写
   * credentials。settings 成功后把 `settingsCommitted` 固定下来，因此 credentials
   * 写入失败后的重试只重试 credentials，绝不会重复 mutate 已经写好的 profile。
   *
   * @param {{
   *   settingsNs: string,
   *   profileBasePath: readonly string[],
   *   revision: number,
   *   protocols?: readonly string[],
   *   takenRoutes?: readonly string[],
   *   displayName?: string,
   *   models?: readonly unknown[],
   * }} input
   */
  function createCustomProviderDraft(input) {
    const source = isPlainObject(input) ? input : {};
    const settingsNs = typeof source.settingsNs === "string" ? source.settingsNs : "";
    const profileBasePath = Array.isArray(source.profileBasePath) ? source.profileBasePath : [];
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));
    let takenRoutes = (Array.isArray(source.takenRoutes) ? source.takenRoutes : [])
      .filter((entry) => isNonEmptyString(entry));
    // 栅栏是否已经定稿：定稿后 rebase 不再改写 revision（只为冲突语义保留）。
    let fenceFrozen = false;
    let draft = {
      routeId: "",
      displayName: typeof source.displayName === "string" ? source.displayName : "",
      baseURL: "",
      api: protocols.length === 1 ? protocols[0] : "",
      apiKey: "",
      models: modelDraftsOf(source.models ?? [createModelRow()]),
    };
    let settingsCommitted = false;
    let committedRevision = null;
    let committedProfilePath = null;
    let committedCredentialRef = null;
    let expectedRevision = Number.isSafeInteger(source.revision) ? source.revision : undefined;

    /** 已提交后的凭据引用：固定成提交那一刻推导出的值，绝不再随 route 编辑漂移。 */
    const committedRef = () => (
      committedCredentialRef !== null
        ? committedCredentialRef
        : deriveKeyRef(typeof draft.routeId === "string" ? draft.routeId.trim() : "")
    );
    return {
      settingsNs,
      get draft() { return draft; },
      get settingsCommitted() { return settingsCommitted; },
      get committedProfilePath() { return committedProfilePath; },
      /** 已提交时为固定引用，未提交时按当前 route 推导（便于卡片展示预期引用）。 */
      get credentialRef() { return committedRef(); },
      get revision() { return committedRevision === null ? expectedRevision : committedRevision; },
      /**
       * 同步候选 route 词表（任何时候都同步），并在**尚未写盘前**接受一次 revision 纠正。
       *
       * revision 语义：
       * - 用户开始编辑、以及 settings 写成功之后，栅栏完全冻结。此后 mirror/load 推进
       *   revision 时自动跟随会让 CAS 失效，从而可能覆盖别人在这段时间里的写入；这种情况
       *   必须交给宿主按 revision 语义拒绝，界面再提示用户重新打开。
       * - 在这之前（刚打开卡片、还没输入任何字符）允许用最新 revision 纠正：卡片可能在
       *   Describe 视图还没读到/还过期时打开，用陈旧栅栏会把每一次正常提交都误判成冲突。
       *
       * `takenRoutes` 不受上述限制：route 占用情况任何时候都应该是最新的。
       *
       * @param {{ revision?: number, takenRoutes?: readonly string[], frozen?: boolean }} next
       */
      rebase(next) {
        if (settingsCommitted) return draft;
        const snapshot = isPlainObject(next) ? next : {};
        // 定稿这一次仍允许贴上 revision，之后就只读。
        if (!fenceFrozen && Number.isSafeInteger(snapshot.revision)) {
          expectedRevision = snapshot.revision;
        }
        if (snapshot.frozen === true) fenceFrozen = true;
        if (Array.isArray(snapshot.takenRoutes)) {
          takenRoutes = snapshot.takenRoutes.filter((entry) => isNonEmptyString(entry));
        }
        return draft;
      },
      /**
       * 编辑草稿：`patch` 里出现的键整体替换，未出现的键原样保留。
       *
       * `settingsCommitted` 之后只允许修改 API Key：profile 已经按当时的 route/字段落盘，
       * 再改 route、URL、协议或模型就会让界面描述的东西与实际写入的 provider 不一致，
       * 凭据也会被写到另一条引用上。这里的拒绝是状态机级的不变式，界面同时会禁用这些字段。
       */
      edit(patch) {
        const next = { ...draft };
        for (const [key, value] of Object.entries(isPlainObject(patch) ? patch : {})) {
          if (settingsCommitted && key !== "apiKey") continue;
          if (key === "models") next.models = modelDraftsOf(value);
          else if (isBlankDraftValue(value)) next[key] = "";
          else next[key] = value;
        }
        draft = next;
        return draft;
      },
      /** 校验草稿；返回逐字段错误与将要写入的 profile。 */
      validate() {
        return validateCustomProviderDraft({
          routeId: draft.routeId,
          displayName: draft.displayName,
          baseURL: draft.baseURL,
          api: draft.api,
          apiKey: draft.apiKey,
          models: draft.models,
          takenRoutes,
          protocols,
        });
      },
      /** profile 在命名空间内的完整路径（route id 是路径最后一段）。 */
      profilePath() {
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        return routeId.length === 0 ? null : [...profileBasePath, routeId];
      },
      /**
       * 一次提交的结论。
       *
       * 已经写成功 profile 时只返回凭据阶段（`ops` 为 undefined），因此重试不会重复
       * settings mutate。凭据阶段使用**提交时固定**的 credential ref，即使卡片上的
       * route 字段后来被改动过，也不会出现"旧 profile + 新 route 的凭据"错配。
       *
       * @returns {{ ok: boolean, error?: string, errors?: Record<string, string>, phase?: "settings" | "credentials" | "done", ops?: Array<{ op: "set", path: string[], value: unknown }>, credentialRef?: string, keyValue?: string, expectedRevision?: number }}
       */
      plan() {
        const keyValue = typeof draft.apiKey === "string" ? draft.apiKey.trim() : "";
        if (settingsCommitted) {
          const credentialRef = committedRef();
          return keyValue.length === 0
            ? { ok: true, phase: "done", credentialRef, keyValue: undefined }
            : { ok: true, phase: "credentials", credentialRef, keyValue };
        }
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        const credentialRef = routeId.length === 0 ? "" : deriveKeyRef(routeId);
        const checked = this.validate();
        if (!checked.ok) {
          return { ok: false, error: checked.error, errors: checked.errors };
        }
        const profilePath = this.profilePath();
        return {
          ok: true,
          phase: "settings",
          credentialRef,
          keyValue: keyValue.length === 0 ? undefined : keyValue,
          expectedRevision,
          ops: [{ op: "set", path: profilePath, value: deepClone(checked.profile) }],
        };
      },
      /**
       * settings 阶段成功：固定 profile 已写入的事实、新的 revision 与凭据引用。
       *
       * **保留** API Key 明文输入：profile 已经落盘，但凭据可能还没写成功（credentials
       * 服务失败、用户中断）。只要明文还在卡片内存里，重复点击提交就只会重试凭据写入，
       * 绝不会重复 mutate settings。明文不进入 settings、不回显在输入框以外的地方，
       * 并在凭据写入成功（`acceptCredential`）或卡片关闭时被丢弃。
       */
      acceptSettings(view, credentialRef) {
        const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
        settingsCommitted = true;
        committedProfilePath = [...profileBasePath, routeId];
        committedCredentialRef = isNonEmptyString(credentialRef) ? credentialRef : deriveKeyRef(routeId);
        if (isPlainObject(view) && Number.isSafeInteger(view.revision)) committedRevision = view.revision;
        return draft;
      },
      /** credentials 阶段成功：清空明文输入。 */
      acceptCredential() {
        draft = { ...draft, apiKey: "" };
        return draft;
      },
    };
  }

  /** 自定义创建入口的可用性：`llm-pi-ai` namespace 存在 + 至少一个协议 + settings 可写。 */
  function canCreateCustomProvider({ namespace, protocols, writable } = {}) {
    if (!isPlainObject(namespace)) return false;
    if (writable === false) return false;
    return (Array.isArray(protocols) ? protocols : []).some((entry) => isNonEmptyString(entry));
  }

  /**
   * 自定义 provider 创建卡片的渲染面：与 provider 卡片同层的可断言对象。
   *
   * @param {{
   *   draft: Record<string, unknown>,
   *   protocols?: readonly string[],
   *   errors?: Record<string, string>,
   *   error?: string | null,
   *   readOnly?: boolean,
   *   saving?: boolean,
   *   submitted?: boolean,
   *   credentialRef?: string,
   *   defaultInput?: readonly string[],
   *   expandedRows?: ReadonlySet<number> | readonly number[],
   * }} input
   */
  function buildCustomCardModel(input) {
    const source = isPlainObject(input) ? input : {};
    const draft = isPlainObject(source.draft) ? source.draft : {};
    const errors = isPlainObject(source.errors) ? source.errors : {};
    const readOnly = source.readOnly === true;
    const saving = source.saving === true;
    const submitted = source.submitted === true;
    const expanded = new Set(
      source.expandedRows instanceof Set
        ? [...source.expandedRows]
        : (Array.isArray(source.expandedRows) ? source.expandedRows : []),
    );
    const defaultInput = Array.isArray(source.defaultInput) ? source.defaultInput : undefined;
    const rows = modelDraftsOf(draft.models);
    const routeId = typeof draft.routeId === "string" ? draft.routeId.trim() : "";
    const protocols = (Array.isArray(source.protocols) ? source.protocols : [])
      .filter((entry) => isNonEmptyString(entry));
    const disabled = readOnly || saving;
    // profile 已经写盘之后只允许重试 API Key：route 与 credential ref 都可能已经落盘，
    // 继续编辑它们会让"旧 profile + 新 route 的凭据"错配。固定字段在这里统一禁用。
    const profileLocked = submitted || readOnly;
    const profileDisabled = profileLocked || saving;
    const credentialRef = isNonEmptyString(source.credentialRef)
      ? source.credentialRef
      : (routeId.length === 0 ? "" : deriveKeyRef(routeId));
    return {
      title: "添加自定义提供方",
      readOnly,
      saving,
      submitted,
      profileLocked,
      credentialRef,
      error: isNonEmptyString(source.error) ? source.error : null,
      routeId: {
        value: routeId,
        error: isNonEmptyString(errors.routeId) ? errors.routeId : null,
        credentialRef,
        disabled: profileDisabled,
      },
      displayName: {
        value: typeof draft.displayName === "string" ? draft.displayName : "",
        error: isNonEmptyString(errors.displayName) ? errors.displayName : null,
        disabled: profileDisabled,
      },
      baseUrl: {
        value: typeof draft.baseURL === "string" ? draft.baseURL : "",
        error: isNonEmptyString(errors.baseURL) ? errors.baseURL : null,
        placeholder: "https://api.example.com/v1",
        disabled: profileDisabled,
      },
      protocol: {
        value: typeof draft.api === "string" ? draft.api : "",
        error: isNonEmptyString(errors.api) ? errors.api : null,
        disabled: profileDisabled,
        options: protocols.map((choice) => ({ value: choice, label: choice })),
      },
      apiKey: {
        value: typeof draft.apiKey === "string" ? draft.apiKey : "",
        type: "password",
        autoComplete: "off",
        disabled,
        placeholder: "粘贴 API Key（可留空，沿用 provider 原生/环境凭据）",
      },
      models: rows.map((model, index) => {
        const selection = effortSelectionFor(model);
        const inputSelected = modelInputOf(model, defaultInput);
        return {
          index,
          position: index + 1,
          id: { value: typeof model.id === "string" ? model.id : "" },
          name: { value: typeof model.name === "string" ? model.name : "" },
          contextWindow: {
            value: typeof model.contextWindow === "number" ? formatCapacity(model.contextWindow) : "",
            placeholder: "继承适配器默认",
          },
          maxTokens: {
            value: typeof model.maxTokens === "number" ? formatCapacity(model.maxTokens) : "",
            placeholder: "继承适配器默认",
          },
          efforts: REASONING_EFFORTS.map((level) => ({ level, checked: selection[level] === true })),
          inputs: INPUT_MODALITIES.map((modality) => ({
            modality,
            checked: inputSelected.includes(modality),
            locked: inputSelected.length === 1 && inputSelected.includes(modality),
          })),
          advancedOpen: expanded.has(index),
        };
      }),
      modelsError: isNonEmptyString(errors.models) ? errors.models : null,
      actions: {
        // 提交后在 settings 阶段成功前仍可提交（用于重试凭据写入）；route 固定后依然满足。
        submit: disabled || routeId.length === 0 ? "disabled" : "enabled",
        cancel: saving ? "disabled" : "enabled",
        addModel: profileLocked ? "disabled" : (disabled ? "disabled" : "enabled"),
      },
    };
  }

  const api = Object.freeze({
    SYMBOL,
    REASONING_EFFORTS,
    REASONING_EFFORT_EMPTY,
    INPUT_MODALITIES,
    DEFAULT_INPUT_MODALITIES,
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
    modelDisplayNameOf,
    modelInputOf,
    modelDraftsOf,
    inputOverrideOf,
    emptyEffortSelection,
    effortSelectionFor,
    effortSelectionEqual,
    unknownEffortKeysOf,
    hasUnknownEffortKeys,
    selectedLevelsOf,
    reasoningDiffLines,
    applyEffortSelection,
    normalizeEffortsEntry,
    createModelRow,
    inputSelectionFor,
    patchModelDraft,
    setModelEffortSelection,
    setModelInputSelection,
    removeModelRow,
    appendModelRow,
    parseCapacity,
    formatCapacity,
    validateModelRows,
    normalizeModelRows,
    pathOps,
    hasOps,
    revisionConflictOf,
    createEditorBaseline,
    isOverridden,
    inheritedModelsOf,
    materializeOverrideOps,
    restoreDefaultOps,
    modelCatalogOps,
    providerSubtreeOps,
    importNamespace,
    catalogOpsFor,
    modelCardApply,
    providerListSections,
    apiKeyField,
    buildModelCardModel,
    createCardSession,
    modelEditableProfileOf,
    EDITABLE_PROFILE_FIELDS,
    buildSectionModel,
    ROUTE_ID_PATTERN,
    BASE_URL_FALLBACK_PATTERN,
    validateRouteId,
    validateBaseUrl,
    validateProtocol,
    validateCustomProviderDraft,
    createCustomProviderDraft,
    canCreateCustomProvider,
    buildCustomCardModel,
    modelOverrideDecision,
    modelChoicesOf,
    indexModelsById,
    adoptModels,
    joinProviderDirectory,
    providerEditable,
    providerRemovable,
    providerProfileOf,
    apiKeyEnvOf,
    credentialRefOf,
    protocolChoices,
    createSchemaAdapter,
    namespaceSchemaInfo,
    validateProfileDraft,
    rolesAffectedByChange,
    reasoningGuardMessage,
    removedLevelsOf,
    namespaceViewOf,
    roleDefaultsOf,
  });

  global[SYMBOL] = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
