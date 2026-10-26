/**
 * 「模型配置」区域的模型行 / effort / input / 容量与校验族（R8 票据 28）。
 *
 * 从 client-model-config.js 机械外移：正文逐行保留，只有 wrapper、常量归属、导出面与文件头
 * 是本票新增的。依赖方向单一：本模块只读 client-model-config-paths.js 的检查点（纯值变换原语），
 * **不读** client-model-config.js（那是读取本模块检查点的一方）。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-model-config-rows")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在 paths 之后、client-model-config.js 之前）。
 */
(function installClientModelConfigRows(global) {
  "use strict";

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（与相邻侧车模块约定一致）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config-rows");
  /** 纯 draft/path 原语族的检查点（同一次装配里由 client-model-config-paths.js 先写入）。 */
  const pathsSymbol = Symbol.for("dsh-expert-group/client-model-config-paths");
  const paths = global[pathsSymbol] || {};
  // 只解构本模块正文真正引用的原语（13 个）；多取会让"谁读谁"的清单失去审计意义。
  const {
    isPlainObject, isNonEmptyString, jsonEqual, isBlankDraftValue, createEditorBaseline,
    deepClone, deletePath, pathOps, hasPath, getSubtree, deriveKeyRef, isSchemaNode, getPath,
  } = paths;

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
   * 模型行的「容量字段」共享段：provider 卡片与自定义 provider 卡片此前**逐字**重复这一块。
   *
   * 为什么等价：两处调用点都把这一段展开在 name 之后，字段顺序（contextWindow → maxTokens）、
   * 取值判据（只有 `typeof … === "number"` 才 formatCapacity）、空串回退与占位文案完全相同；
   * 每次调用都新建字面量对象，因此与内联写法一样**不共享引用**（每行、每次调用各一份）。
   */
  function modelLimitFieldsOf(model) {
    // 两个容量字段的取值判据完全相同（数字才格式化、其余回退空串），这里只保留一处口径。
    const capOf = (raw) => typeof raw === "number" ? formatCapacity(raw) : "";
    return {
      contextWindow: { value: capOf(model.contextWindow), placeholder: "继承适配器默认" },
      maxTokens: { value: capOf(model.maxTokens), placeholder: "继承适配器默认" },
    };
  }

  /**
   * 模型行的「推理档位 + 输入类型 + 展开态」共享段（与 modelLimitFieldsOf 同源去重）。
   *
   * 为什么等价：档位选择 / 输入类型的推导（`effortSelectionFor` / `modelInputOf`）与三个字段
   * 的构造逐字相同；参数只是把调用点自己的 index / defaultInput / expanded 传进来，取值口径
   * 不变。返回**新的**字面量对象（efforts / inputs 数组与每个数组项都是新建），引用语义与内联
   * 写法一致。调用点负责把结果展开在原来的位置（provider 卡片在 reasoningDefaults 之后、自定义
   * 卡片紧随 maxTokens），因此上层字段顺序不变。
   */
  function modelReasoningFieldsOf(model, index, defaultInput, expanded) {
    const levels = effortSelectionFor(model);
    const picked = modelInputOf(model, defaultInput);
    return {
      efforts: REASONING_EFFORTS.map((level) => ({ level, checked: levels[level] === true })),
      inputs: INPUT_MODALITIES.map((modality) => ({
        modality,
        checked: picked.includes(modality),
        // 至少保留一个输入类型：只剩一个已勾选项时该项不可再取消。
        locked: picked.length === 1 && picked.includes(modality),
      })),
      advancedOpen: expanded.has(index),
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
      models: models.map((model, index) => ({
        index,
        position: index + 1,
        id: { value: nameOf("id", model), editable: true },
        name: { value: nameOf("name", model), editable: true },
        ...modelLimitFieldsOf(model),
        reasoningDefaults: { value: "模型默认", editable: false },
        ...modelReasoningFieldsOf(model, index, defaultInput, expanded),
      })),
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
   * provider 卡片有权编辑的 profile 字段。
   *
   * 只命名卡片看到的字段是刻意的：settings.yaml 里的隐藏高级字段（transport、retryPolicy、
   * compat…）不进入草稿，因此既不会被显示，也不会在提交时被重建或删除（与 DSH 内置模型
   * 设置页"卡片只写自己的字段"同一条原则）。
   */
  const EDITABLE_PROFILE_FIELDS = Object.freeze(["displayName", "apiKeyEnv", "baseURL", "api", "models"]);

  // 导出面覆盖模型行族 + 覆盖/catalog/目录/schema 族；`modelRowOf` 只在本模块内部使用，
  // 因此不发布（原模块也从未导出它）。常量顺序沿用 client-model-config.js 的原始字面量顺序。
  global[SYMBOL] = Object.freeze({
    REASONING_EFFORTS,
    REASONING_EFFORT_EMPTY,
    INPUT_MODALITIES,
    DEFAULT_INPUT_MODALITIES,
    EDITABLE_PROFILE_FIELDS,
    modelDisplayNameOf,
    modelInputOf,
    modelDraftsOf,
    inputOverrideOf,
    emptyEffortSelection,
    effortSelectionFor,
    effortSelectionEqual,
    unknownEffortKeysOf,
    hasUnknownEffortKeys,
    reasoningDiffLines,
    selectedLevelsOf,
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
    isOverridden,
    inheritedModelsOf,
    materializeOverrideOps,
    modelCatalogOps,
    modelEditableProfileOf,
    importNamespace,
    catalogOpsFor,
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
    modelCardApply,
    providerListSections,
    apiKeyField,
    buildModelCardModel,
    // 两张卡片共用的模型行字段段（去重时不新增依赖边：读取方 model-config 已读本检查点）。
    modelLimitFieldsOf,
    modelReasoningFieldsOf,
    createCardSession,
  });
})(globalThis);
