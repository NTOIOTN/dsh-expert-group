/**
 * 客户端侧栏 · Panel 实例级状态（第二段，R6 / sidebar-panel-state-b）
 *
 * ## 职责边界（R6 票据 22）
 * 「会话模型」编辑区的**实例级状态机械**：角色草稿的下一版计算、权威基线、可提交改动、
 * 本地校验、写成功后的草稿删除、冲突/失败回执的收口描述、写入前置条件。
 *
 * ## 为什么这些必须是实例级
 * 草稿只在**当前这个已挂载 Panel** 上有意义：卸载即弃、重挂载从权威读面重新开始。
 * 因此本文件不持有任何容器，只提供「上一版 → 下一版」的纯转移函数；ref/state 与 setState
 * 一律留在 Panel（Hook 的调用顺序与相对位置因此一字不动）。
 *
 * ## 边界（不得放宽）
 * - 草稿的 base 只在**用户改过的角色**上算：未改过的行始终跟随权威覆盖或全局默认；
 * - 换 provider 时模型候选只属于具体 provider；换 model 时思考深度跟随该模型的 defaultEffort；
 * - 只有成功路径才删除草稿：失败/冲突必须保留用户输入（冲突只推进基线，不清输入）；
 * - 可提交改动只算「确有草稿、provider/model 都非空、且与权威基线不同」的角色。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-panel-state-b")]
 * 装配：只从 globalThis 检查点取回 pure 依赖，本文件不修改任何外部模块的实现。
 */
(function installClientSidebarPanelStateB(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-state-b");
  const PURE_SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-pure");
  const PURE = global[PURE_SYMBOL] || {};
  const {
    normalizeSessionModelOverrides, normalizeSessionModelSelection, object,
    sessionModelModelOptions, sessionModelRowKeysOf, sessionModelSelectionEquals,
    sessionModelSelectionOfDraft, text,
  } = PURE;

  /**
   * 某个角色草稿的 base：已有草稿优先；否则用调用方算好的**权威基线**归一成三个字段。
   *
   * 基线必须由调用方按「本会话覆盖 ?? 显示值 ?? 全局默认」算好再交进来：主代理的显示值
   * 来自读面（applyState 语义），不在 roleDefaults 里，本层无法自行拼出两层来源。
   * 只记录用户实际改过的字段，未改过的行始终跟随权威值。
   */
  function draftBaseOf(previous, role, baseline) {
    if (Object.prototype.hasOwnProperty.call(previous, role)) return previous[role];
    return {
      provider: baseline?.provider ?? "",
      model: baseline?.model ?? "",
      reasoningEffort: baseline?.reasoningEffort ?? "",
    };
  }

  /**
   * 用户改一个字段后的下一版草稿表（纯函数：不写 state、不读 meta ref）。
   *
   * 两条联动规则（与设置页同源）：
   * - 换 provider：旧模型仍存在于新 provider 目录下就保留，否则 model/effort 一起清空；
   * - 换 model：思考深度跟随新模型的 defaultEffort；没有声明或不在 efforts 里就回到「模型默认」。
   *
   * @returns {any} 新的 drafts 对象（未改动时也返回新对象：调用方只关心「下一版」）
   */
  function nextSessionModelDrafts(options) {
    const previous = object(options?.previous);
    const role = options?.role;
    const field = options?.field;
    const value = options?.value;
    const groups = options?.groups;
    const base = draftBaseOf(previous, role, options?.baseline);
    const next = { ...base, [field]: value };
    if (field === "provider") {
      const models = value === "" ? [] : sessionModelModelOptions(value, groups);
      const stillAvailable = next.model !== ""
        && models.some((candidate) => text(object(candidate).id, null) === next.model);
      if (stillAvailable !== true) {
        next.model = "";
        next.reasoningEffort = "";
      }
    } else if (field === "model") {
      const entry = sessionModelModelOptions(next.provider, groups)
        .find((candidate) => text(object(candidate).id, null) === value);
      const defaultEffort = text(object(entry?.reasoning).defaultEffort, null);
      next.reasoningEffort = defaultEffort === null ? "" : defaultEffort;
      const efforts = Array.isArray(entry?.reasoning?.efforts) ? entry.reasoning.efforts : [];
      if (next.reasoningEffort !== ""
        && efforts.every((effort) => text(object(effort).id, null) !== next.reasoningEffort)) {
        next.reasoningEffort = "";
      }
    }
    return { ...previous, [role]: next };
  }

  /**
   * 某个角色的「权威基线」：本会话覆盖优先，否则它的显示默认值（都没有则空选择）。
   *
   * 主代理是覆盖表里的保留键（与 Host 的 ORCHESTRATOR_SELECTION_KEY 同值），它不在
   * meta.roleDefaults 里：显示值由调用方按读面 applyState 语义取好后作为 orchestrator
   * 传入，因此「只改思考深度」这类部分字段编辑能保存（E3）。
   */
  function sessionModelBaselineOf(overrides, roleDefaults, role, orchestrator) {
    return overrides?.[role]
      ?? (role === "orchestrator" ? orchestrator ?? null : normalizeSessionModelSelection(object(roleDefaults)[role]));
  }

  /**
   * 当前可提交的改动（按角色展示顺序，串行提交）。
   *
   * 只把「确有草稿、provider/model 都非空、且与权威基线不同」的角色算作改动：
   * 用户点开过下拉但最终选回原值的行不产生请求。
   */
  function sessionModelPendingChangesOf(options) {
    const drafts = object(options?.drafts);
    const baselineOf = options?.baselineOf;
    const changes = [];
    for (const role of sessionModelRowKeysOf(options?.meta)) {
      if (Object.prototype.hasOwnProperty.call(drafts, role) !== true) continue;
      const selection = sessionModelSelectionOfDraft(drafts[role]);
      if (selection.provider.length === 0 || selection.model.length === 0) continue;
      if (sessionModelSelectionEquals(selection, baselineOf(role))) continue;
      changes.push({ role, selection });
    }
    return changes;
  }

  /** 本地校验：任一草稿缺 provider/model 就不允许保存（按钮禁用 + 底部提示）。 */
  function sessionModelHasInvalidDraftOf(options) {
    const drafts = object(options?.drafts);
    for (const role of sessionModelRowKeysOf(options?.meta)) {
      if (Object.prototype.hasOwnProperty.call(drafts, role) !== true) continue;
      const selection = sessionModelSelectionOfDraft(drafts[role]);
      if (selection.provider.length === 0 || selection.model.length === 0) return true;
    }
    return false;
  }

  /** 写成功后的草稿收口：只删除该角色（不存在时原样返回，绝不制造新对象）。 */
  function withoutRoleDraft(drafts, role) {
    const previous = object(drafts);
    if (Object.prototype.hasOwnProperty.call(previous, role) !== true) return previous;
    const next = { ...previous };
    delete next[role];
    return next;
  }

  /** 保存/清除的公共前置条件：可写、会话在运行、没有别的写入在途、且当前就是 root 视图。 */
  function sessionModelWriteReadyOf(options) {
    const state = object(options?.state);
    return options?.mounted === true
      && state.status === "ready"
      && state.live === true
      && options?.saving !== true
      && options?.rootSessionId !== ""
      && options?.sidebarSessionId === options?.rootSessionId;
  }

  /**
   * 冲突/失败回执的收口**描述**（保存与清除共用，调用方已过 surface 闸门）。
   *
   * 冲突语义（与设置页一致）：Host 的 revision CAS 失败时返回 session-override-conflict
   * 与 details.currentRevision/overrides。此时**保留未提交草稿**，只把本地基线推进到权威值
   * 并显示带当前代次的提示；其它错误同样只提示、绝不清空输入。
   *
   * @returns {{ statePatch: { revision: number | null, overrides: any | null } | null, notice: any }}
   */
  function describeSessionModelFailure(options) {
    const error = options?.error;
    const role = options?.role;
    const roles = Array.isArray(options?.roles) ? options.roles : sessionModelRowKeysOf(options?.meta);
    const t = options?.t;
    const code = text(object(error).code, null);
    const details = object(object(error).details);
    if (code === "session-override-conflict") {
      const currentRevision = Number.isSafeInteger(details.currentRevision) && details.currentRevision >= 0
        ? details.currentRevision
        : null;
      const overrides = details.overrides === undefined
        ? null
        : normalizeSessionModelOverrides(details.overrides, roles);
      return {
        statePatch: { revision: currentRevision, overrides },
        notice: {
          kind: "conflict",
          role,
          text: t("sidebar.sessionModel.conflict", {
            revision: currentRevision === null ? "?" : currentRevision,
          }),
        },
      };
    }
    const message = text(object(error).message, null);
    return {
      statePatch: null,
      notice: {
        kind: "error",
        role,
        text: message === null
          ? t("sidebar.sessionModel.unavailable")
          : t("sidebar.sessionModel.failed", { message }),
      },
    };
  }

  // 只暴露主 IIFE 实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    describeSessionModelFailure,
    nextSessionModelDrafts,
    sessionModelBaselineOf,
    sessionModelHasInvalidDraftOf,
    sessionModelPendingChangesOf,
    sessionModelWriteReadyOf,
    withoutRoleDraft,
  });
})(globalThis);
