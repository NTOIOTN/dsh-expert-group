/**
 * 设置域纯函数与数据流（草稿归一、提示词投影、候选页、目录 store、提交）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-settings-normalize")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientSettingsNormalize(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-settings-normalize");
  const clientNativeStatusSymbol = Symbol.for("dsh-expert-group/client-native-status");
  const clientNativeStatus = global[clientNativeStatusSymbol] || {};
  const {
    STATUS_ROLE_IDS, STATUS_ROLE_LABELS,
  } = clientNativeStatus;
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  let requireFreshnessSurface = null;
  let requestPluginRpc = null;
  let createClientFreshnessBoundary = null;
  let RPC_TARGET = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
    requireFreshnessSurface = host.requireFreshnessSurface ?? null;
    requestPluginRpc = host.requestPluginRpc ?? null;
    createClientFreshnessBoundary = host.createClientFreshnessBoundary ?? null;
    RPC_TARGET = host.RPC_TARGET ?? null;
  }

    /**
     * 设置页使用当前 Host 目录；每行 provider 独立决定模型和思考深度。
     * 角色清单与标签复用上面的同一份浏览器投影，不再维护第二份重复清单；
     * 实际展示的角色仍以 RPC meta 的 activeRoles 为准（Observer 关闭时隐藏）。
     */
    const SETTINGS_ROLE_IDS = STATUS_ROLE_IDS;
    const SETTINGS_ROLE_LABELS = STATUS_ROLE_LABELS;
    /**
     * 主代理（Orchestrator）在设置文档里的**保留键**（与 Host 的 ORCHESTRATOR_SELECTION_KEY 同值）。
     *
     * 它不是一个专家角色：绝不进入 defaults/candidates 这两张角色映射，也不参与 meta.roles /
     * activeRoles；模型表把它当成「一份独立的 profile」来读写（settings.orchestrator）。
     */
    const ORCHESTRATOR_ID = "orchestrator";
    // meta 尚未返回时的初始行：只含默认角色，可选角色（observer）由 meta 决定是否展示。
    const SETTINGS_REQUIRED_ROLE_IDS = SETTINGS_ROLE_IDS.filter((role) => role !== "observer");


    // 提示词入口始终使用完整角色表，与模型配置的 activeRoles 读取路径刻意分离；
    // 因此 Observer 未启用时仍可配置提示词，但不会参与统一 provider 选择。
    const PROMPT_ROLE_IDS = SETTINGS_ROLE_IDS;
    const DEFAULT_PROMPT_MAX_GRAPHEMES = 32000;
    const PROMPT_WARNING_RATIO = 0.9;

    /**
     * grapheme 分段器按「locale + granularity」缓存。
     *
     * 计数位于提示词编辑器的实时校验路径上（每次按键都会重新校验草稿），而 Intl.Segmenter
     * 的构造成本远高于一次遍历，因此在工厂作用域里复用实例。缓存键包含构造参数：切分语义
     * 由 locale 与 granularity 共同决定，不同参数不能共用一个实例，所以是「按参数缓存」
     * 而不是全局唯一单例。
     * 构造失败（嵌入式 WebView 的残缺 Intl、polyfill 装到一半）不做负缓存：保持与旧实现
     * 一致的「每次调用重试构造」，失败时由调用方回退到代理项级计数。
     */
    const GRAPHEME_SEGMENTER_CACHE = new Map();
    function graphemeSegmenterOf(locale, granularity) {
      const key = (locale === undefined ? "" : String(locale)) + "\u0000" + String(granularity);
      const cached = GRAPHEME_SEGMENTER_CACHE.get(key);
      if (cached !== undefined) return cached;
      try {
        const Segmenter = globalThis?.Intl?.Segmenter;
        if (typeof Segmenter !== "function") return null;
        const segmenter = new Segmenter(locale, { granularity });
        GRAPHEME_SEGMENTER_CACHE.set(key, segmenter);
        return segmenter;
      } catch {
        return null;
      }
    }

    /**
     * 按 Unicode grapheme 统计文本长度。Intl.Segmenter 是浏览器与 Node 的标准实现，
     * 退回 Array.from 只用于极旧运行时，至少仍能把代理项当作一个字符而不截断原文。
     */
    function countUnicodeGraphemes(value) {
      if (typeof value !== "string" || value.length === 0) return 0;
      const segmenter = graphemeSegmenterOf(undefined, "grapheme");
      if (segmenter !== null) {
        try {
          let count = 0;
          for (const unused of segmenter.segment(value)) {
            void unused;
            count += 1;
          }
          return count;
        } catch {
          // 某些嵌入式 WebView 暴露了不完整的 Intl：segment() 本身也可能抛错，
          // 回退计数不能阻断编辑器（异常处理范围与旧实现完全一致）。
        }
      }
      return Array.from(value).length;
    }

    /**
     * 校验提示词草稿但不修改原文：空白只影响非空判断，首尾空格和换行仍按原样保存。
     */
    function validatePromptText(value, maxGraphemes = DEFAULT_PROMPT_MAX_GRAPHEMES) {
      const text = typeof value === "string" ? value : "";
      const max = Number.isSafeInteger(maxGraphemes) && maxGraphemes > 0
        ? maxGraphemes
        : DEFAULT_PROMPT_MAX_GRAPHEMES;
      const count = countUnicodeGraphemes(text);
      if (text.trim().length === 0) {
        return { ok: false, code: "prompt-empty", message: "提示词不能为空", count, maxGraphemes: max };
      }
      if (count > max) {
        return { ok: false, code: "prompt-too-long", message: "提示词不能超过 " + max + " 个字符", count, maxGraphemes: max };
      }
      return { ok: true, code: null, message: null, count, maxGraphemes: max };
    }

    /**
     * 只从 settings 快照保留已知角色的字符串覆盖，避免脏 wire 数据进入编辑器。
     *
     * 角色集合可由调用方显式传入（Host rolePrompts.roles，只应是内置角色）；
     * 缺省仍是内置六角色，纯函数调用与旧 Host 语义不变。
     */
    function normalizePromptOverrides(value, maxGraphemes = DEFAULT_PROMPT_MAX_GRAPHEMES, roleIds = PROMPT_ROLE_IDS) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
      const normalized = {};
      const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : PROMPT_ROLE_IDS;
      for (const role of roles) {
        const text = value[role];
        if (typeof text !== "string") continue;
        if (!validatePromptText(text, maxGraphemes).ok) continue;
        normalized[role] = text;
      }
      return normalized;
    }

    function promptOverridesEqual(left, right) {
      const leftValue = left && typeof left === "object" ? left : {};
      const rightValue = right && typeof right === "object" ? right : {};
      const roles = [...new Set([...Object.keys(leftValue), ...Object.keys(rightValue)])].sort();
      return roles.every((role) => leftValue[role] === rightValue[role]);
    }

    /**
     * 将 Host rolePrompts 投影归一为固定六角色顺序。投影未完整到达时返回 null，
     * 编辑页据此显示加载而不是先用空文本冒充一个可保存的提示词。
     */
    function normalizeRolePromptProjection(projection, settingsValue, snapshotOverridesAuthoritative = false, roleIds = PROMPT_ROLE_IDS) {
      if (projection === null || typeof projection !== "object" || Array.isArray(projection)
        || !Array.isArray(projection.entries)) return null;
      // 角色集合以 Host 投影自己声明的 roles 为准（只应是内置角色）；缺省仍是
      // 内置六角色，因此旧 Host 与纯函数调用的行为完全不变。
      const roles = Array.isArray(roleIds) && roleIds.length > 0 ? roleIds : PROMPT_ROLE_IDS;
      const fallbackOverrides = normalizePromptOverrides(settingsValue?.promptOverrides, projection.maxGraphemes, roles);
      const settingsHasOverrides = settingsValue !== null && typeof settingsValue === "object"
        && Object.prototype.hasOwnProperty.call(settingsValue, "promptOverrides");
      // 纯函数两参数调用保留旧 Host 投影语义；只有设置组件在接收到完整 snapshot
      // 后显式启用该开关，才让空映射表达“覆盖已被删除”，以抵抗滞后的 meta 响应。
      const byRole = new Map(projection.entries
        .filter((entry) => entry && typeof entry.role === "string")
        .map((entry) => [entry.role, entry]));
      const entries = [];
      for (const role of roles) {
        const source = byRole.get(role);
        if (typeof source?.defaultPersona !== "string") return null;
        // settings snapshot 到达后比一次 meta 更权威：meta 可能仍是组件首次读取的旧投影，
        // 不能把已删除的覆盖重新渲染回来。旧 Host 没有该字段时才回退 meta 自身状态。
        const snapshotControlsOverride = snapshotOverridesAuthoritative && settingsHasOverrides;
        const settingsHasRoleOverride = snapshotControlsOverride && Object.prototype.hasOwnProperty.call(fallbackOverrides, role);
        const override = snapshotControlsOverride
          ? fallbackOverrides[role]
          : (typeof source.override === "string" ? source.override : fallbackOverrides[role]);
        const customized = snapshotControlsOverride
          ? settingsHasRoleOverride
          : source.customized === true;
        entries.push({
          role,
          defaultPersona: source.defaultPersona,
          ...(customized && typeof override === "string" ? { override } : {}),
          customized,
          effective: customized && typeof override === "string" ? override : source.defaultPersona,
        });
      }
      const maxGraphemes = Number.isSafeInteger(projection.maxGraphemes) && projection.maxGraphemes > 0
        ? projection.maxGraphemes
        : DEFAULT_PROMPT_MAX_GRAPHEMES;
      return {
        roles,
        maxGraphemes,
        customizable: projection.customizable === true,
        entries,
      };
    }

    function promptEntryOf(projection, role) {
      return projection?.entries?.find((entry) => entry.role === role) ?? null;
    }

    /** 保存成功后只更新本地只读投影，已自定义圆点不会跟随临时草稿变化。 */
    function updateRolePromptProjection(projection, role, text) {
      if (projection === null || typeof projection !== "object") return projection;
      return {
        ...projection,
        entries: projection.entries.map((entry) => {
          if (entry.role !== role) return entry;
          const customized = text !== entry.defaultPersona;
          const next = { ...entry, customized, effective: text };
          if (customized) next.override = text;
          else delete next.override;
          return next;
        }),
      };
    }

    /**
     * 统一供应商只观察设置页实际展示的角色；Observer 未启用时，其旧配置不能污染选择器。
     * 未传角色列表时沿用旧版五个必选专家，供纯函数调用和旧 Host 兼容。
     *
     * 角色集合不在这里二次过滤——meta.activeRoles 是运行期目录的唯一读取面，
     * Host 已只投影内置角色。
     */
    function settingsRolesForProvider(roles) {
      const candidates = Array.isArray(roles) ? roles : SETTINGS_REQUIRED_ROLE_IDS;
      return [...new Set(candidates.filter((role) => typeof role === "string" && role.length > 0))];
    }

    /**
     * 返回当前展示角色的共同 provider。空字符串同时表示没有可统一的 provider 和混合状态；
     * 只有完全没有行内 provider 时才回退到旧的全局 provider，保持历史 settings 可见且可迁移。
     */
    function unifiedProviderOf(defaults, roles, legacyProvider = "") {
      const activeRoles = settingsRolesForProvider(roles);
      if (activeRoles.length === 0) return "";
      const providers = activeRoles.map((role) => {
        const provider = defaults?.[role]?.provider;
        return typeof provider === "string" && provider.length > 0 ? provider : "";
      });
      const configured = providers.filter((provider) => provider.length > 0);
      if (configured.length === 0) return typeof legacyProvider === "string" ? legacyProvider : "";
      if (configured.length !== activeRoles.length) return "";
      const first = configured[0];
      return configured.every((provider) => provider === first) ? first : "";
    }

    /**
     * 通知事件类型（票据 14）：设置页与 Host 使用同一组稳定 id。
     * 标签只用于展示，不属于持久化字段。
     */
    const NOTIFICATION_EVENT_TYPES = Object.freeze(["completed", "waiting", "failed"]);
    // 事件标签已迁到消息表（settings.notificationEvent.*，见渲染层 t(...)）。

    /**
     * 通知事件开关归一：缺失/非法一律按开启，只有显式 false 才关闭。
     *
     * 与 Host 读取面同一语义：旧配置没有该字段时保持历史行为（全部投递），
     * 读到一个坏值也不会静默关掉通知；写入面的严格校验在 Host 提交端点。
     */
    function normalizeNotificationEvents(value) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const normalized = {};
      for (const type of NOTIFICATION_EVENT_TYPES) normalized[type] = source[type] !== false;
      return normalized;
    }

    function clampNotificationVolume(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.min(100, Math.max(0, Math.round(number))) : 100;
    }

    /** 旧默认并发上限、新默认值与迁移标记版本：与 Host（index.js）保持同一语义。 */
    const DEFAULT_ROLE_CONCURRENCY_LIMIT = 20;
    const LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT = 10;
    const CONFIG_MIGRATION_VERSION = 1;

    /**
     * 共享每个 role 的 running shard 上限：只接受 1~64 的整数，旧配置或非法值回退到默认 20。
     * 与 Host 的 DEFAULT_ROLE_CONCURRENCY_LIMIT、设置页 title 文案保持同一数值。
     */
    function normalizeRoleConcurrencyLimit(value) {
      return Number.isSafeInteger(value) && value >= 1 && value <= 64
        ? value
        : DEFAULT_ROLE_CONCURRENCY_LIMIT;
    }

    /**
     * 读取面别名（与 Host 的 normalizeRoleConcurrencyLimitForRead 同一规则）。
     *
     * 默认值从 10 调整为 20 后，旧 profile 里显式保存的 10 在迁移标记落盘前按 20
     * 展示；首次保存由 Host 写入标记，之后用户手动改回 10 时原样保留。
     * 只影响读取展示，不改变用户输入的其它合法值。
     *
     * @param {object|undefined} source - settings 快照。
     * @returns {number} 1~64 的生效并发上限。
     */
    function effectiveRoleConcurrencyLimit(source) {
      const limit = normalizeRoleConcurrencyLimit(source?.roleConcurrencyLimit);
      const rawVersion = source?.configMigrationVersion;
      const version = Number.isSafeInteger(rawVersion) && rawVersion >= 0 ? rawVersion : 0;
      return version < CONFIG_MIGRATION_VERSION && limit === LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT
        ? DEFAULT_ROLE_CONCURRENCY_LIMIT
        : limit;
    }

    // 与 Host 的默认值保持一致：10 小时；显式 0 仍表示禁用，不被默认值覆盖。
    const DEFAULT_ROLE_TIMEOUT_MS = 36000000;

    /**
     * 角色默认超时（毫秒，票据 06）只接受 0（不启用）或
     * 1000~86,400,000 的整秒毫秒数；缺失或非法值回退默认 10 小时。
     *
     * 客户端只做读取/草稿归一，权威拒绝仍在 Host 的 settings-commit
     * （与 fanout.js validateTimeoutMs 同一语义）：这里不能把越界值渲染成“已保存”。
     *
     * @param {unknown} value - settings 中的超时值。
     * @returns {number} 0 或合法启用值。
     */
    function normalizeRoleTimeoutMs(value) {
      if (value === 0) return 0;
      return Number.isSafeInteger(value) && value >= 1000 && value <= 86400000 && value % 1000 === 0
        ? value
        : DEFAULT_ROLE_TIMEOUT_MS;
    }

    // ── 票据 24：候选模型与降级上限的归一、校验（设置页草稿与提交共用）──────────
    //
    // 候选上限 3 与「主模型 + 3 个候选页」的页签上限一一对应，降级上限 4（默认 2）。
    // 这些常量只用于客户端预校验与 UI 限制，权威拒绝仍在 Host 的 settings-commit。
    const MAX_MODEL_CANDIDATES_PER_ROLE = 3;
    const MAX_MODEL_FALLBACK_LIMIT = 4;
    const DEFAULT_MODEL_FALLBACK_LIMIT = 2;
    /** 页签页数上限：主模型页 + 最多 3 个候选页 = 4 页。 */
    const MAX_MODEL_PAGES = MAX_MODEL_CANDIDATES_PER_ROLE + 1;

    /** 降级上限只接受 0..4 的安全整数；缺失/非法按默认 2 归一（与 Host 读取面一致）。 */
    function normalizeModelFallbackLimitDraft(value) {
      return Number.isSafeInteger(value) && value >= 0 && value <= MAX_MODEL_FALLBACK_LIMIT ? value : DEFAULT_MODEL_FALLBACK_LIMIT;
    }
    /**
     * 单条候选归一：只保留 provider/model 字符串与可选非空 effort。
     *
     * 与 defaults 的读取归一不同，这里**不丢弃空串**：页签里的候选层在用户填写前
     * 就是 {provider:"", model:""}，读取归一若丢掉它，草稿与源看起来相同（页数会塌陷，
     * 保存按钮也会错误地保持禁用）。空行 = 未配置，提交前由 compactModelCandidatesDraft 裁掉。
     */
    function normalizeModelCandidateSelection(entry) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
      if (typeof entry.provider !== "string" || typeof entry.model !== "string") return null;
      const reasoningEffort = typeof entry.reasoningEffort === "string" ? entry.reasoningEffort : "";
      return { provider: entry.provider, model: entry.model, ...(reasoningEffort.length > 0 ? { reasoningEffort } : {}) };
    }
    /**
     * 主代理配置归一：`{ defaults: selection|null, candidates: selection[], fallbackLimit }`。
     *
     * 旧文档缺字段 / 坏值一律收敛成「未配置」而不是抛错：设置页必须能打开并把坏值改回来。
     * 候选**保留空行**（与角色候选同一口径）：页签里的候选层在填写前就是 {provider:"",model:""}，
     * 读取归一若丢掉它页数就会塌陷、保存按钮也会错误保持禁用；提交前由 compactOrchestratorDraft 裁掉。
     */
    function normalizeOrchestratorDraft(value) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const defaults = normalizeModelCandidateSelection(source.defaults);
      return {
        // defaults 必须具备 provider 与 model 才是「已配置」；半填行按未配置处理（提交前不写入）。
        defaults: defaults !== null && defaults.provider.length > 0 && defaults.model.length > 0 ? defaults : null,
        // 候选逐条归一与上限同角色候选；这里不能复用 normalizeModelCandidatesDraft——它按角色白名单
        // 过滤键，会把保留键 orchestRATOR 整个丢掉。
        candidates: (Array.isArray(source.candidates) ? source.candidates : [])
          .slice(0, MAX_MODEL_CANDIDATES_PER_ROLE)
          .map(normalizeModelCandidateSelection)
          .filter((entry) => entry !== null),
        fallbackLimit: normalizeModelFallbackLimitDraft(source.fallbackLimit),
      };
    }
    /**
     * 主代理的**提交候选**：与角色候选同一套裁剪口径（全空行不写入），字段形状与 Host 契约一致。
     */
    function compactOrchestratorDraft(value) {
      const profile = normalizeOrchestratorDraft(value);
      return {
        ...profile,
        // 「全空行不写入」复用角色候选的裁剪口径，主代理不另写一份。
        candidates: compactModelCandidatesDraft({ [ORCHESTRATOR_ID]: profile.candidates })[ORCHESTRATOR_ID] ?? [],
      };
    }
    /**
     * 角色 -> 有序候选映射归一；只保留内置角色键，每角色最多 3 条（与页签上限一致）。
     *
     * 旧文档里可能残留已删除的自定义角色键；Host 的 settings-commit 对未知角色键严格
     * 拒绝（整次 400），因此读取面就先丢弃，保证升级后保存旧候选不会把设置写坏。
     */
    function normalizeModelCandidatesDraft(value) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      const candidates = {};
      for (const [role, list] of Object.entries(source)) {
        if (typeof role !== "string" || role.length === 0 || !Array.isArray(list)) continue;
        // 未知角色键（旧自定义角色）在读取面丢弃：Host 写面只接受内置角色。
        if (!SETTINGS_ROLE_IDS.includes(role)) continue;
        const normalized = [];
        for (const entry of list.slice(0, MAX_MODEL_CANDIDATES_PER_ROLE)) {
          const selection = normalizeModelCandidateSelection(entry);
          if (selection !== null) normalized.push(selection);
        }
        if (normalized.length > 0) candidates[role] = normalized;
      }
      return candidates;
    }
    /** 候选去重键：provider + model + 规范化 effort（空 effort 与缺省等价）。 */
    function modelCandidateKeyOf(selection) {
      return (selection?.provider ?? "") + "\u0000" + (selection?.model ?? "") + "\u0000" + (typeof selection?.reasoningEffort === "string" ? selection.reasoningEffort : "");
    }
    /**
     * 模型页签的「页 → 层」映射（票据 24 重排的唯一数据语义）。
     *
     * - 页 0 = defaults[role]；页 i（i >= 1）= candidates[role][i - 1]；
     * - 页数完全由草稿推导（不落盘、不额外存 UI 状态），删除/裁剪候选后页签自动收敛；
     * - 页签名称只由位置推导，拖动重排改变的是「整层」的顺序，不是某一行的数据。
     */
    function modelPageCountOf(draft) {
      // 主代理也是一行：它的候选层同样决定页数，否则第 2..N 页会漏掉这一行。
      const orchestratorCandidates = draft?.orchestrator?.candidates;
      let longest = Array.isArray(orchestratorCandidates) ? orchestratorCandidates.length : 0;
      for (const role of SETTINGS_ROLE_IDS) {
        const list = draft?.candidates?.[role];
        if (Array.isArray(list)) longest = Math.max(longest, list.length);
      }
      return Math.min(MAX_MODEL_PAGES, Math.max(1, 1 + longest));
    }
    /**
     * 参与层重排的角色集合：内置六角色 + 草稿里已经存在的其它键。
     *
     * 内置角色必须在列，否则「拖动重排」会漏掉当前没有任何配置的角色，导致层的边界错位；
     * 历史文档里的未知角色键一并保留，重排不得顺手丢掉用户已有的数据。
     */
    function modelLayerRolesOf(draft) {
      const roles = [...SETTINGS_ROLE_IDS];
      for (const source of [draft?.defaults, draft?.candidates]) {
        if (source === null || source === void 0 || typeof source !== "object") continue;
        for (const role of Object.keys(source)) if (!roles.includes(role)) roles.push(role);
      }
      return roles;
    }
    /**
     * 参与层重排/建页的**行集合**：角色映射里的角色 + 主代理。
     *
     * 主代理单独存放（settings.orchestrator），但层语义与角色完全一致：拖动页签必须把它
     * 一起搬走，否则「候选页」的层顺序只对专家成立、主代理会停在旧层上。
     */
    function modelLayerRowKeysOf(draft) {
      return [...modelLayerRolesOf(draft), ORCHESTRATOR_ID];
    }
    /** 读某一层某行的选择：页 0 读 defaults，页 i 读 candidates[i - 1]；未配置返回 null。 */
    function modelLayerSelectionOf(draft, role, page) {
      if (!Number.isSafeInteger(page) || page < 0) return null;
      let source;
      if (role === ORCHESTRATOR_ID) {
        const profile = draft?.orchestrator;
        source = page === 0
          ? profile?.defaults
          : (Array.isArray(profile?.candidates) ? profile.candidates[page - 1] : void 0);
      } else {
        source = page === 0
          ? draft?.defaults?.[role]
          : (Array.isArray(draft?.candidates?.[role]) ? draft.candidates[role][page - 1] : void 0);
      }
      return source !== null && source !== void 0 && typeof source === "object" && !Array.isArray(source) ? source : null;
    }
    /**
     * 写某一层某角色的选择：页 0 写 defaults（空值 = 删掉该行），页 i 写 candidates[i - 1]。
     *
     * 候选层必须把数组补到目标索引（中间层用空行占位），否则读写会落在不同的页上；
     * 空行只是**草稿**占位，提交前由 compactModelCandidatesDraft 按「未配置不写入」裁掉，
     * 因此 Host 永远不会收到空 selection（Host 的写面会整次拒绝空条目）。
     */
    function setModelLayerSelection(draft, role, page, selection) {
      if (!Number.isSafeInteger(page) || page < 0) return draft;
      const normalized = selection !== null && typeof selection === "object" && !Array.isArray(selection) ? selection : null;
      if (role === ORCHESTRATOR_ID) {
        // 主代理：空值 = 显式清空主选择（defaults: null =「不干预主代理模型」），不删掉整份配置。
        const profile = normalizeOrchestratorDraft(draft?.orchestrator);
        if (page === 0) return { ...draft, orchestrator: { ...profile, defaults: normalized } };
        const list = profile.candidates.slice();
        while (list.length < page - 1) list.push({ provider: "", model: "" });
        list[page - 1] = normalized === null ? { provider: "", model: "" } : normalized;
        return { ...draft, orchestrator: { ...profile, candidates: list } };
      }
      if (page === 0) {
        const defaults = { ...(draft?.defaults ?? {}) };
        if (normalized === null) delete defaults[role];
        else defaults[role] = normalized;
        return { ...draft, defaults };
      }
      const candidates = { ...(draft?.candidates ?? {}) };
      const list = Array.isArray(candidates[role]) ? candidates[role].slice() : [];
      while (list.length < page - 1) list.push({ provider: "", model: "" });
      list[page - 1] = normalized === null ? { provider: "", model: "" } : normalized;
      candidates[role] = list;
      return { ...draft, candidates };
    }
    /** 当前层的「角色 → 选择」映射：统一供应商与整层重排都基于它计算。 */
    function modelLayerMapOf(draft, page) {
      const map = {};
      for (const role of modelLayerRowKeysOf(draft)) {
        const selection = modelLayerSelectionOf(draft, role, page);
        if (selection !== null) map[role] = selection;
      }
      return map;
    }
    /**
     * 按「层数组」整体写回草稿（拖动排序的唯一写入口）。
     *
     * 第 0 层写 defaults；候选层保持页与索引一一对应：最后一个有内容的层决定数组长度，
     * 中间缺口用空行占位（提交前再裁剪）。写入的都是深拷贝，避免新旧层共享同一个对象。
     */
    function writeModelLayers(draft, layers) {
      // 逐行逐层经 setModelLayerSelection 写回：角色映射与主代理 profile 只有同一份搬家逻辑。
      let next = { ...draft, defaults: {}, candidates: {} };
      for (const role of modelLayerRowKeysOf(draft)) {
        for (let page = 0; page < layers.length; page += 1) {
          const selection = layers[page]?.[role];
          if (selection !== null && selection !== void 0) {
            next = setModelLayerSelection(next, role, page, { ...selection });
          }
        }
      }
      return next;
    }
    /** 拖动页签：把 from 层整层移动到 to 位置，其余层顺移（主模型页也可以移动）。 */
    function reorderModelLayers(draft, from, to) {
      const count = modelPageCountOf(draft);
      if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) return draft;
      if (from < 0 || from >= count || to < 0 || to >= count || from === to) return draft;
      const layers = [];
      for (let page = 0; page < count; page += 1) layers.push(modelLayerMapOf(draft, page));
      const [moved] = layers.splice(from, 1);
      layers.splice(to, 0, moved);
      return writeModelLayers(draft, layers);
    }
    /**
     * 「+」新建候选页：深拷贝主模型页六个角色的选择（provider/model/reasoningEffort）。
     *
     * 达到 MAX_MODEL_PAGES 后不再新增（按钮同时禁用）；拷贝是深拷贝，新页与主模型页
     * 互不影响。主模型页空着的角色写空行占位，保证新页在草稿里立刻出现（保存时按未配置裁掉）。
     */
    function addModelCandidatePage(draft) {
      const count = modelPageCountOf(draft);
      if (count >= MAX_MODEL_PAGES) return draft;
      // 逐行经 setModelLayerSelection 写入：主代理与角色共用同一套「页 → 层」语义，
      // 不必为独立 profile 再写一份建页逻辑。
      let next = draft;
      for (const role of modelLayerRowKeysOf(draft)) {
        const primary = modelLayerSelectionOf(draft, role, 0);
        next = setModelLayerSelection(next, role, count, primary === null ? null : { ...primary });
      }
      return next;
    }
    /**
     * 删除一个候选页：所有角色同步删掉该索引项（页与层始终一一对应）。
     *
     * 主模型页不可删除（页签上没有 ×），由调用方保证 page >= 1；某角色在该层没有配置时跳过。
     */
    function removeModelCandidatePage(draft, page) {
      if (!Number.isSafeInteger(page) || page < 1) return draft;
      const candidates = { ...(draft?.candidates ?? {}) };
      for (const [role, value] of Object.entries(candidates)) {
        if (!Array.isArray(value)) continue;
        const list = value.slice();
        if (list.length >= page) list.splice(page - 1, 1);
        if (list.length > 0) candidates[role] = list;
        else delete candidates[role];
      }
      // 主代理候选同步删除该索引项（页与层始终一一对应）。
      const profile = draft?.orchestrator;
      if (profile === null || typeof profile !== "object") return { ...draft, candidates };
      const orchestratorList = Array.isArray(profile.candidates) ? profile.candidates.slice() : [];
      if (orchestratorList.length >= page) orchestratorList.splice(page - 1, 1);
      return { ...draft, candidates, orchestrator: { ...profile, candidates: orchestratorList } };
    }
    /**
     * 提交前裁剪候选：provider 与 model 皆空的行 = 该层该角色未配置，整行不写入。
     *
     * 为什么必须裁掉而不是留给 Host：Host 的 settings-commit 会对变更角色的每一条候选做
     * 目录解析，空 selection 会被整次拒绝（400）；「空行允许保存」因此只能在客户端表达成
     * 「不写这一条」。行序保持稳定，剩下的都是真正的配置。
     */
    function compactModelCandidatesDraft(candidates) {
      const source = candidates !== null && typeof candidates === "object" && !Array.isArray(candidates) ? candidates : {};
      const compacted = {};
      for (const [role, list] of Object.entries(source)) {
        if (!Array.isArray(list)) continue;
        const rows = [];
        for (const entry of list) {
          const selection = normalizeModelCandidateSelection(entry);
          if (selection === null) continue;
          // 全空行 = 未配置：该层该角色不写入。
          if (selection.provider.length === 0 && selection.model.length === 0) continue;
          rows.push(selection);
        }
        if (rows.length > 0) compacted[role] = rows;
      }
      return compacted;
    }
    /**
     * 候选草稿的保存前校验（fail-closed，绝不静默丢弃用户输入）。
     *
     * - 全空行 = 未配置：允许保存（提交前会被裁掉，该层该角色不写入）；
     * - 半填行（只有 provider 或只有 model）仍然报错：写进 Host 只会换来一次整保存失败，
     *   这里提前给出可读原因；
     * - 同一角色内已配置的候选不得重复；角色级最多 MAX_MODEL_CANDIDATES_PER_ROLE 条。
     */
    function validateModelCandidateRows(candidates) {
      const source = candidates !== null && typeof candidates === "object" ? candidates : {};
      for (const [role, list] of Object.entries(source)) {
        if (!Array.isArray(list)) continue;
        if (list.length > MAX_MODEL_CANDIDATES_PER_ROLE) return { ok: false, code: "limit", role, index: 0 };
        const seen = new Set();
        for (let index = 0; index < list.length; index += 1) {
          const selection = normalizeModelCandidateSelection(list[index]);
          if (selection === null) return { ok: false, code: "incomplete", role, index: index + 1 };
          if (selection.provider.length === 0 && selection.model.length === 0) continue;
          if (selection.provider.length === 0 || selection.model.length === 0) return { ok: false, code: "incomplete", role, index: index + 1 };
          const key = modelCandidateKeyOf(selection);
          if (seen.has(key)) return { ok: false, code: "duplicate", role, index: index + 1 };
          seen.add(key);
        }
      }
      return { ok: true, code: null, role: null, index: 0 };
    }
    /** 候选校验结果 -> 可读中文原因（角色显示名优先，索引从 1 开始）。 */
    function modelCandidatesErrorMessage(t, roleLabelOf, validation) {
      if (validation.code === "limit") return t("settings.modelCandidates.limit");
      return (typeof roleLabelOf === "function" ? roleLabelOf(validation.role) : validation.role) + "：" + t("settings.modelCandidates.error." + (validation.code ?? "incomplete"), { index: validation.index });
    }

    /**
     * 峰谷时段的**编辑器默认值**（唯一权威常量，客户端草稿与测试共用）。
     *
     * 语义取舍（主代理裁决，客户端侧）：未启用峰谷且时段为空时，编辑器一律显示这两条默认
     * 峰段；一旦启用，时段完全以保存值为准（0 段 = 全天谷时），绝不回填。Host 的读取/写入
     * 归一保持原样——默认值只活在客户端草稿里，保存时仍按既有 peakValleyCandidateOf 写回。
     */
    const DEFAULT_PEAK_VALLEY_PERIODS = Object.freeze([
      Object.freeze({ start: "08:00", end: "12:00" }),
      Object.freeze({ start: "14:00", end: "18:00" }),
    ]);
    /**
     * 「添加峰段」追加的第三段默认值：必须与 DEFAULT_PEAK_VALLEY_PERIODS 不重叠
     * （旧值 08:00–10:00 会落在默认峰段内部，保存前校验会直接判成非法时段）。
     */
    const NEXT_PEAK_VALLEY_PERIOD = Object.freeze({ start: "19:00", end: "22:00" });

    /**
     * 峰谷草稿（票据 07）：enabled / initialized / periods / peak / valley 的独立副本。
     *
     * 只做结构拷贝、**不做时段归一**：非法时段必须原样留在草稿里，由保存前校验拦下；
     * 在这里静默丢弃坏时段会让用户以为改动已生效。initialized 是 Host 派生字段，
     * 拷贝只用于显示，客户端不修改它、也不把它放进提交候选。
     * JSON 深拷贝同时切断了草稿与快照之间的对象引用，编辑不会污染权威配置。
     *
     * @param {unknown} value - settings.peakValley（读取面状态）。
     * @param {boolean} [seedPeriods] - 是否允许播种默认峰段；**只有读取面 → 草稿的入口**传 true。
     * @returns {object} 草稿状态（缺省字段收敛为固定形状）。
     */
    function normalizePeakValleyDraft(value, seedPeriods = false) {
      const source = value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
      // 读取面的 fail-closed 信号只读携带：设置页据它显示修复提示、并禁止把归一后的
      // 缺省值写回；它**不进提交候选**（peakValleyCandidateOf 只取五个可写字段）。
      const invalidCode = typeof source.invalidCode === "string" && source.invalidCode.length > 0
        ? source.invalidCode
        : void 0;
      const periods = Array.isArray(source.periods) ? source.periods : [];
      /**
       * 「编辑器默认值」播种（见 DEFAULT_PEAK_VALLEY_PERIODS 的语义取舍）。
       *
       * 为什么必须由调用方显式开关：本函数同时用于**重新归一正在编辑的草稿**（每帧的脏判定、
       * 合成草稿与保存候选）。若无条件按「空数组就播种」，用户把峰段删到 0 条后下一帧就会被
       * 填回默认两条——「0 段 = 全天谷时」与既有 B2（删到 0 段仍可保存且提交 [])立刻失效。
       * 因此播种只发生在草稿建立/重置入口，渲染期重复归一绝不回填。
       *
       * 三条内容判据：损坏配置（invalidCode）必须原样保留，不能凭空造默认值；
       * 已启用的峰谷以保存值为准；时段非空时尊重用户已保存的时段。
       */
      const seedDefaults = seedPeriods === true
        && invalidCode === void 0
        && source.enabled !== true
        && periods.length === 0;
      return JSON.parse(JSON.stringify({
        enabled: source.enabled === true,
        initialized: source.initialized === true,
        // 常量本身是冻结的；这里与其他字段走同一趟 JSON 往返，落进草稿的必然是全新副本，
        // 多个草稿之间绝不共享同一份时段对象。
        periods: seedDefaults ? DEFAULT_PEAK_VALLEY_PERIODS : periods,
        peak: source.peak !== null && typeof source.peak === "object" ? source.peak : {},
        valley: source.valley !== null && typeof source.valley === "object" ? source.valley : {},
        ...(invalidCode === void 0 ? {} : { invalidCode }),
      }));
    }

    /**
     * @param {unknown} value - 权威或草稿 settings 值。
     * @param {Array} roles - 角色表。
     * @param {boolean} [allowLegacyProviderFallback] - 旧文档顶层 provider 回退。
     * @param {boolean} [seedPeakValleyPeriods] - 是否播种默认峰段（只有读取面 → 草稿的入口传 true；
     *   渲染期重复归一一律 false，否则「删到 0 段」会被当场的归一重新填回默认值）。
     */
    function normalizeSettingsDraft(value, roles, allowLegacyProviderFallback = true, seedPeakValleyPeriods = false) {
      const source = value && typeof value === "object" ? value : {};
      const configuredProvider = typeof source.provider === "string" ? source.provider : "";
      const activeRoles = settingsRolesForProvider(roles);
      const entries = [];
      for (const [role, selection] of Object.entries(source.defaults ?? {})) {
        if (!selection || typeof selection !== "object"
          || typeof selection.model !== "string" || selection.model.length === 0) continue;
        const provider = typeof selection.provider === "string" && selection.provider.length > 0
          ? selection.provider
          : "";
        entries.push({ role, selection, provider });
      }
      const hasVisibleRowProvider = entries.some(({ role, provider }) => activeRoles.includes(role) && provider.length > 0);
      const defaults = {};
      for (const { role, selection, provider: explicitProvider } of entries) {
        const provider = explicitProvider.length > 0
          ? explicitProvider
          : (allowLegacyProviderFallback && !hasVisibleRowProvider && activeRoles.includes(role)
            ? configuredProvider
            : "");
        if (provider.length === 0) continue;
        defaults[role] = { provider, model: selection.model };
        if (typeof selection.reasoningEffort === "string") defaults[role].reasoningEffort = selection.reasoningEffort;
      }
      const visibleProviders = activeRoles
        .map((role) => defaults[role]?.provider)
        .filter((provider) => typeof provider === "string" && provider.length > 0);
      const inferredProvider = visibleProviders.length > 0
        && visibleProviders.length === activeRoles.length
        && visibleProviders.every((provider) => provider === visibleProviders[0])
        ? visibleProviders[0]
        : "";
      return {
        // 行级 provider 一旦存在就拥有优先权；只有可见行完全没有 provider 时才保留旧顶层值。
        provider: hasVisibleRowProvider
          ? inferredProvider
          : (allowLegacyProviderFallback ? configuredProvider : ""),
        defaults,
        notificationEnabled: source.notificationEnabled !== false,
        notificationVolume: clampNotificationVolume(source.notificationVolume),
        notificationEvents: normalizeNotificationEvents(source.notificationEvents),
        // 读取别名：旧默认值 10 + 标记缺失 => 显示/保存为 20；标记落盘后 10 原样保留。
        roleConcurrencyLimit: effectiveRoleConcurrencyLimit(source),
        // 角色默认超时缺失或非法时使用默认 10 小时；显式 0 保留为不启用。
        roleTimeoutMs: normalizeRoleTimeoutMs(source.roleTimeoutMs),
        // 旧客户端/Host 缺少字段时保持关闭，避免升级后改变图片路由。
        observerPreferred: source.observerPreferred === true,
        // 任务管理缺字段时保持开启：默认必须维持 Expert Group 注册到侧边栏的历史行为。
        taskManagementEnabled: source.taskManagementEnabled !== false,
        // 自动打开缺字段/非法值时一律按关闭归一：默认不做任何自动 open/close。
        autoOpenSubagentSidebar: source.autoOpenSubagentSidebar === true,
        // 左侧栏入口与任务管理同款宽松语义：只有显式 false 才隐藏入口；缺字段/非法值按开启归一。
        sidebarEntryEnabled: source.sidebarEntryEnabled !== false,
        // 票据 24：候选与降级上限**只在源文档显式存在时**进入草稿/提交形状。
        // 缺字段 = 旧客户端/旧文档：不凭空写回默认值，Host 因此可以保持已有配置。
        ...(Object.prototype.hasOwnProperty.call(source, "candidates")
          ? { candidates: normalizeModelCandidatesDraft(source.candidates) }
          : {}),
        ...(Object.prototype.hasOwnProperty.call(source, "fallbackLimit")
          ? { fallbackLimit: normalizeModelFallbackLimitDraft(source.fallbackLimit) }
          : {}),
        // 主代理（保留键）：恒在草稿里，旧文档缺字段时归一为「未配置」（null / [] / 默认上限），
        // 因此模型表第一行永远有确定的空态，不需要在渲染期再补一次兜底。
        orchestrator: normalizeOrchestratorDraft(source.orchestrator),
        // 峰谷（票据 07）：只在源文档显式存在时进入草稿，旧文档/旧客户端形状逐字不变。
        ...(Object.prototype.hasOwnProperty.call(source, "peakValley")
          ? { peakValley: normalizePeakValleyDraft(source.peakValley, seedPeakValleyPeriods) }
          : {}),
      };
    }

    function settingsDraftEqual(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    /**
     * 详情页保存时参与"本地差异"合并的顶层字段（票据 24 重排 / 审查修复）。
     *
     * 与 normalizeSettingsDraft 的输出保持一一对应（promptOverrides 不在此列：提示词有
     * 独立的覆盖/恢复默认合并逻辑，不能按整份映射覆盖）。新增字段时必须同步这里，
     * 否则该字段的本地修改会在详情页保存时被当作"未修改"而丢失。
     */
    const SETTINGS_DRAFT_MERGE_FIELDS = Object.freeze([
      "provider",
      "defaults",
      "notificationEnabled",
      "notificationVolume",
      "notificationEvents",
      "roleConcurrencyLimit",
      "roleTimeoutMs",
      "observerPreferred",
      "taskManagementEnabled",
      "autoOpenSubagentSidebar",
      "sidebarEntryEnabled",
      "candidates",
      "fallbackLimit",
      // 主代理（保留键）：详情页保存同样按「本地相对基线的差异」合并，否则这一行的改动会丢。
      "orchestrator",
      // 峰谷（票据 07）：详情页保存时同样按「本地相对基线的差异」合并，不整份覆盖。
      "peakValley",
    ]);

    /**
     * 详情页保存的合成草稿：**最新 source + 本地相对编辑基线的差异**。
     *
     * source 是 Host 当前权威配置，local 是当前草稿的归一结果，baseline 是进入编辑器
     * （或上次成功保存）时的归一快照。只有 local 与 baseline 不同的字段才覆盖到 source：
     * - 外部提交推进 revision 后，未修改的字段一律沿用 source，绝不重放旧值；
     * - 本地真实修改（提示词以外的候选、降级上限、通知、模型等）全部保留；
     * - 本地"整段删除"（local 缺字段而 baseline 有）同样表达为删除；
     * - 只改提示词时合成结果与 source 相同，冲突重试仍以最新完整配置为基底。
     */
    function mergeSettingsDraftOverSource(source, local, baseline) {
      const merged = { ...source };
      for (const field of SETTINGS_DRAFT_MERGE_FIELDS) {
        const hasLocal = Object.prototype.hasOwnProperty.call(local, field);
        const hasBaseline = Object.prototype.hasOwnProperty.call(baseline, field);
        if (hasLocal !== hasBaseline) {
          // 字段是本次新出现的（例如旧文档没有 candidates）或被整段删除。
          if (hasLocal) merged[field] = local[field];
          else delete merged[field];
          continue;
        }
        if (!hasLocal) continue;
        if (settingsDraftEqual(local[field], baseline[field])) continue;
        merged[field] = local[field];
      }
      return merged;
    }

    /**
     * 解析设置页使用的配置表单（票据 39 从 client.js 的 descriptor factory 外移）。
     *
     * descriptor 里原本用一个内联 IIFE 做同样的降级：configForms 缺失或条目不可用时返回一个
     * 永远 "unavailable"（getSnapshot 固定、subscribe 空订阅）的替身。IIFE 里的 7 个单行箭头
     * 会把 factory 的「单闭包内函数数」推过 40，因此这段纯降级逻辑与 createSettingsModelCatalog
     * 一起放在这里：两者都是 descriptor 的装配期 bootstrap，且都不依赖 React 与运行期状态。
     *
     * @param {object|null} configForms 宿主配置表单服务（可能为空）。
     * @param {string} entryId 本插件的设置条目 id。
     * @param {object} unavailableSnapshot 表单不可用时的冻结快照常量。
     * @returns {object} 可用的 form 或结构完全一致的降级替身。
     */
    function resolveSettingsForm(configForms, entryId, unavailableSnapshot) {
      const fallback = {
        getSnapshot: () => unavailableSnapshot,
        subscribe: () => () => {},
      };
      if (configForms === null || typeof configForms.get !== "function") return fallback;
      try {
        const form = configForms.get(entryId);
        if (form !== null && form !== undefined
          && typeof form.getSnapshot === "function" && typeof form.subscribe === "function") return form;
      } catch { /* 服务代理拒答或条目读取失败：按不可用降级。 */ }
      return fallback;
    }

    function createSettingsModelCatalog(ctx) {
      let state = { groups: [], status: "idle", error: null };
      // 目录刷新协调：同一时刻最多一个在途请求（单飞），在途期间到达的刷新事件只记账
      // 一个尾随刷新（queued），由在途请求收尾时启动。这样一串宿主事件（新增 provider 后
      // 立即删除会同时触发目录、文档与凭据事件）只会合并成"一个在途 + 一个最新"两次请求，
      // 而不是每个事件各发一次、互相把对方判成过期。
      let inflight = null;
      let queued = false;
      // 销毁标记：cleanup 第一步就置位，之后任何入口都不得再发起远端目录调用。
      // 只依赖 freshness.dispose() 不够：在途请求的收尾路径（.finally）按 promise 身份
      // 判断"收尾责任"，销毁时若仍持有 inflight / queued 账本，它会把排队中的尾随刷新
      // 真的发出去——插件已经销毁，却仍触发一次远端目录 RPC。
      let disposed = false;
      const freshness = createClientFreshnessBoundary();
      const listeners = new Set();
      const publish = (next) => {
        state = next;
        for (const listener of listeners) listener();
      };
      /**
       * 启动一次目录请求。只有"当前没有在途请求"时才会被调用（load / refresh / 尾随刷新），
       * 因此这里不需要再做并发判断。
       */
      const startRequest = () => {
        // 销毁后绝不发起远端调用（也不改写状态）：正常路径由 cleanup 清账本拦住尾随刷新，
        // 这里再兜一层，覆盖 connection/reset 处理器等销毁后才到达的迟到入口。
        if (disposed) return Promise.resolve();
        const requestToken = freshness.beginRequest("catalog", "settings");
        // 保留上一次已知目录：加载中只换状态，不清空下拉已经能用的选项。
        publish({ ...state, status: "loading", error: null });
        const promise = Promise.resolve().then(() => ctx.remote.session.modelCatalog()).then((response) => {
          const catalog = response?.ok === true ? response.value : response;
          if (!catalog || !Array.isArray(catalog.groups)) throw new Error("模型目录不可用");
          const normalizedGroups = normalizeSettingsModelGroups(catalog.groups);
          const accepted = freshness.acceptCatalogResponse({
            generation: requestToken.sequence,
            groups: normalizedGroups,
            requestToken,
          });
          // 过期响应（期间又来了刷新事件）由 freshness 拒绝：旧目录绝不覆盖新目录，
          // 也绝不把角色下拉提前解锁。
          if (accepted.accepted) publish({ groups: normalizedGroups, status: "ready", error: null });
        }).catch((cause) => {
          if (freshness.isCurrent(requestToken)) {
            publish({ ...state, status: "error", error: cause instanceof Error ? cause.message : String(cause) });
          }
        }).finally(() => {
          // 用 promise 身份而不是 freshness 令牌判断收尾责任：在途期间到达的刷新事件会
          // 刻意作废本请求的令牌（见 refresh），那时令牌已不再"当前"，但释放 inflight 与
          // 启动尾随刷新的责任仍然在本请求，否则 store 会永久停在 loading。
          if (inflight !== promise) return;
          inflight = null;
          if (!queued) return;
          queued = false;
          startRequest();
        });
        inflight = promise;
        return promise;
      };
      /**
       * 幂等读取：已有在途请求时复用它，不再并发第二次。
       * 销毁后返回一个已完成的 Promise：调用方（设置页挂载 effect）不会被悬挂的等待卡住，
       * 但 store 不会因此向远端发请求。
       */
      const load = () => {
        if (disposed) return Promise.resolve();
        if (inflight !== null) return inflight;
        return startRequest();
      };
      const refresh = (clear) => {
        // 销毁后刷新事件没有任何意义（监听已摘除）；迟到的 connection/reset 也必须被丢弃，
        // 否则会在插件销毁后启动一次远端目录调用。
        if (disposed) return;
        // connection/reset 的 clear 语义：在途请求属于旧连接，它的结算与响应都不可再用，
        // 因此放弃它（收尾里的身份检查会让它的 finally 变成空操作，startRequest 的新令牌
        // 也会让它的迟到响应被拒绝）并立刻重新读取——绝不等待一个可能永远不会结算的旧请求。
        if (clear) {
          inflight = null;
          queued = false;
          publish({ groups: [], status: "idle", error: null });
          startRequest();
          return;
        }
        if (inflight !== null) {
          // 单飞：在途期间的刷新事件合并为一个尾随刷新，并立刻作废在途请求的令牌：
          // 它的响应属于旧目录，必须由 client-freshness 拒绝，不能覆盖即将到来的最新目录。
          if (!queued) freshness.beginRequest("catalog", "settings");
          queued = true;
          return;
        }
        startRequest();
      };
      const subscribe = (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const getSnapshot = () => state;
      const eventStops = [];
      for (const event of ["llm/adapters-updated", "settings/document-updated", "credentials/reference-updated"]) {
        eventStops.push(ctx.remote.$on(event, () => refresh(false)));
      }
      ctx.on("connection/reset", () => refresh(true));
      ctx.effect(() => () => {
        // 顺序是语义的一部分：
        // ① 先置销毁标记，封锁所有入口（load / refresh / startRequest / 尾随刷新）；
        disposed = true;
        // ② 清掉逻辑账本：在途请求的 .finally 用 promise 身份判断收尾责任，账本清空后
        //    它只会直接返回，不会再把 queued 的尾随刷新发出去；
        inflight = null;
        queued = false;
        // ③ 最后才摘监听并 dispose freshness：在途请求的迟到响应仍会被 freshness
        //    拒绝（dispose 后 isCurrent 恒为 false），绝不覆盖目录或把角色下拉解锁。
        for (const stop of eventStops) if (typeof stop === "function") stop();
        freshness.dispose();
      }, "dsh-expert-group: settings catalog events");
      return { load, subscribe, getSnapshot };
    }

    // 将 Host 目录归一化为设置页可安全消费的 provider / model / effort 结构。
    function normalizeSettingsModelGroups(groups) {
      return (Array.isArray(groups) ? groups : []).flatMap((group) => {
        if (!group || typeof group.id !== "string" || group.id.length === 0) return [];
        const models = (Array.isArray(group.models) ? group.models : [])
          .filter((model) => model && typeof model === "object" && typeof model.id === "string" && model.id.length > 0)
          .map((model) => {
            const normalized = {
              ...model,
              name: typeof model.name === "string" && model.name.trim().length > 0 ? model.name : model.id,
            };
            const reasoning = model.reasoning;
            if (!reasoning || typeof reasoning !== "object" || Array.isArray(reasoning)) {
              delete normalized.reasoning;
              return normalized;
            }
            const efforts = (Array.isArray(reasoning.efforts) ? reasoning.efforts : [])
              .flatMap((effort) => {
                if (!effort || typeof effort !== "object" || typeof effort.id !== "string" || effort.id.length === 0) return [];
                return [{
                  ...effort,
                  name: typeof effort.name === "string" && effort.name.trim().length > 0 ? effort.name : effort.id,
                }];
              });
            const defaultEffort = typeof reasoning.defaultEffort === "string"
              && reasoning.defaultEffort.trim().length > 0
              && efforts.some((effort) => effort.id === reasoning.defaultEffort)
              ? reasoning.defaultEffort
              : void 0;
            normalized.reasoning = {
              efforts,
              ...(defaultEffort === void 0 ? {} : { defaultEffort }),
            };
            return normalized;
          });
        return [{
          ...group,
          name: typeof group.name === "string" && group.name.trim().length > 0 ? group.name : group.id,
          models,
        }];
      });
    }

    /** 从模型目录条目读取用户可见的显示名称；缺失时沿用模型 ID 作为归一后的回退名称。 */
    function modelDisplayNameOf(model) {
      if (!model || typeof model !== "object") return "";
      if (typeof model.name === "string" && model.name.trim().length > 0) return model.name;
      return typeof model.id === "string" && model.id.length > 0 ? model.id : "";
    }

    /** 按目标 provider 的显示名称迁移一项选择；不兼容时返回 null，调用方负责清理。 */
    function migrateSettingsSelection(selection, provider, groups) {
      if (typeof provider !== "string" || provider.length === 0) return null;
      const providerGroups = Array.isArray(groups) ? groups : [];
      const providerGroup = providerGroups.find((group) => group?.id === provider);
      if (!providerGroup) return null;
      if (!selection || typeof selection !== "object"
        || typeof selection.model !== "string" || selection.model.length === 0) return null;

      // 必须先从源 provider 解析显示名称：目标 provider 的模型 ID 可能完全不同，
      // 只有用户自定义的 name（或目录归一后的 ID 回退名称）一致时才视为同一选择。
      const sourceGroup = typeof selection.provider === "string" && selection.provider.length > 0
        ? providerGroups.find((group) => group?.id === selection.provider)
        : void 0;
      const sourceModel = Array.isArray(sourceGroup?.models)
        ? sourceGroup.models.find((candidate) => candidate?.id === selection.model)
        : void 0;
      const sourceDisplayName = modelDisplayNameOf(sourceModel);
      if (sourceDisplayName.length === 0) return null;

      const model = Array.isArray(providerGroup.models)
        ? providerGroup.models.find((candidate) => modelDisplayNameOf(candidate) === sourceDisplayName)
        : void 0;
      if (!model) return null;
      const next = { provider: providerGroup.id, model: model.id };
      const reasoning = model.reasoning;
      if (typeof selection.reasoningEffort === "string"
        && Array.isArray(reasoning?.efforts)
        && reasoning.efforts.some((effort) => effort?.id === selection.reasoningEffort)) {
        next.reasoningEffort = selection.reasoningEffort;
      }
      return next;
    }

    /** 按目标 provider 的同名模型迁移 defaults；不兼容的角色沿用清理语义丢弃。 */
    function migrateSettingsDefaults(defaults, provider, groups) {
      if (typeof provider !== "string" || provider.length === 0) return {};
      const providerGroup = (Array.isArray(groups) ? groups : []).find((group) => group?.id === provider);
      if (!providerGroup) return {};
      const migrated = {};
      for (const [role, selection] of Object.entries(defaults ?? {})) {
        const next = migrateSettingsSelection(selection, provider, groups);
        if (next !== null) migrated[role] = next;
      }
      return migrated;
    }

    /**
     * 只同步设置页当前可见角色。没有已有模型时暂存 provider + 空 model，
     * 让用户仍能先选 provider 再选模型；保存前 normalizeSettingsDraft 会丢弃空 model。
     */
    function syncSettingsDefaultsProvider(defaults, provider, groups, roles) {
      const next = { ...(defaults && typeof defaults === "object" ? defaults : {}) };
      if (typeof provider !== "string" || provider.length === 0) return next;
      for (const role of settingsRolesForProvider(roles)) {
        const migrated = migrateSettingsSelection(next[role], provider, groups);
        next[role] = migrated ?? { provider, model: "" };
      }
      return next;
    }

    /**
     * 提交响应归一：保留已有 settings 草稿形状，同时仅在 wire 明确携带时保留提示词覆盖。
     * 这样旧 Host/旧测试的返回结构不凭空新增 promptOverrides，新 Host 则不会丢失覆盖。
     */
    function normalizeSettingsCommitDraft(value, roles) {
      const normalized = normalizeSettingsDraft(value, roles);
      if (value !== null && typeof value === "object"
        && Object.prototype.hasOwnProperty.call(value, "promptOverrides")) {
        normalized.promptOverrides = normalizePromptOverrides(value.promptOverrides);
      }
      return normalized;
    }

    /**
     * 通过 Host 动态校验并提交完整 settings 候选，失败时不改变本地 dirty 草稿。
     * 唯一实现位于 client-freshness.js（本文件只注入 RPC 路由常量与草稿归一函数）；
     * 响应解析（含 code/status/currentRevision 结构化错误）同样由共享实现负责，
     * 这里不再保留第二份提交/解析逻辑。
     *
     * 票据 20：新客户端还要随请求上报变更集 `changed`（哪些字段真的变了）。共享实现的
     * 请求体是固定的历史形状（action/settings/expectedRevision），因此只在**提供了变更集**
     * 时用同一份共享原语（requestPluginRpc + readSettingsCommitOutcome，错误归一与
     * currentRevision 解析完全一致）组一条带 `changed` 的请求；未提供变更集的调用
     * （旧调用形状、其它使用方）逐字节保持原样。候选仍是完整值，replace 语义不变。
     */
    async function commitSettingsCandidate(settings, revision, request = globalThis.fetch, connection, roles, changed) {
      const surface = requireFreshnessSurface();
      if (changed === void 0) {
        return surface.commitSettingsCandidate(settings, revision, {
          request,
          connection,
          normalizeSettingsDraft: normalizeSettingsCommitDraft,
          roles,
          rpcTarget: RPC_TARGET,
        });
      }
      const body = {
        action: "settings-commit",
        settings,
        expectedRevision: revision,
        // 变更集只描述「哪些字段变了」，不是 patch 协议：settings 仍提交完整候选。
        changed,
      };
      const response = await requestPluginRpc(connection, body, {}, request);
      return surface.readSettingsCommitOutcome(response, normalizeSettingsCommitDraft, roles);
    }

    /**
     * 宿主 meta 只读读取（生命周期一次 + 用户显式刷新）。
     *
     * 角色表、提示词投影与运行诊断共用同一次请求：因此**不新增任何
     * RPC、定时器或轮询**，也不会因为打开设置页而触碰通知权限或专家任务。
     * body: JSON.stringify({ action: "meta" }) is retained as the legacy HTTP payload contract.
     */
    function useHostMeta(ctx) {
      const [meta, setMeta] = react.useState(null);
      const [error, setError] = react.useState(null);
      const [version, setVersion] = react.useState(0);
      react.useEffect(() => {
        let cancelled = false;
        setError(null);
        void requestPluginRpc(ctx?.connection, { action: "meta" }).then((response) => (
          response.ok === true ? response.json() : null
        )).then((json) => {
          if (cancelled) return;
          if (json !== null && json?.ok === true) {
            setMeta(json);
            setError(null);
          } else {
            setMeta(null);
            setError("提示词配置读取失败");
          }
        }).catch((cause) => {
          if (cancelled) return;
          setMeta(null);
          setError(cause instanceof Error ? cause.message : "提示词配置读取失败");
        });
        return () => { cancelled = true; };
      }, [ctx, version]);
      return [meta, () => setVersion((value) => value + 1), error];
    }

    /**
     * 从 meta 投影出启用角色；meta 缺失/不可用时沿用历史默认角色表。
     *
     * 角色集合仍以 Host 的 meta.activeRoles/roles 为准，但客户端只接受内置角色表里的 id：
     * Host 已不再支持自定义角色，旧文档/旧 meta 里的未知 id 必须在读取面就被过滤掉。
     */
    function useEnabledSettingsRoles(hostMeta) {
      return react.useMemo(() => {
        const configuredRoles = Array.isArray(hostMeta?.activeRoles) ? hostMeta.activeRoles : hostMeta?.roles;
        if (!Array.isArray(configuredRoles)) return SETTINGS_REQUIRED_ROLE_IDS;
        const enabled = configuredRoles.filter((role) => typeof role === "string" && role.length > 0
          && SETTINGS_ROLE_IDS.includes(role));
        if (hostMeta?.enableObserver === true && !enabled.includes("observer")) enabled.push("observer");
        return enabled.filter((role, index) => enabled.indexOf(role) === index);
      }, [hostMeta]);
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    DEFAULT_MODEL_FALLBACK_LIMIT, DEFAULT_PEAK_VALLEY_PERIODS, DEFAULT_PROMPT_MAX_GRAPHEMES, MAX_MODEL_CANDIDATES_PER_ROLE, MAX_MODEL_FALLBACK_LIMIT, MAX_MODEL_PAGES,
    NEXT_PEAK_VALLEY_PERIOD,
    NOTIFICATION_EVENT_TYPES, ORCHESTRATOR_ID, PROMPT_ROLE_IDS, PROMPT_WARNING_RATIO, SETTINGS_ROLE_LABELS, addModelCandidatePage,
    bindClientRuntime, clampNotificationVolume, commitSettingsCandidate, compactModelCandidatesDraft, compactOrchestratorDraft, countUnicodeGraphemes,
    createSettingsModelCatalog, mergeSettingsDraftOverSource, migrateSettingsDefaults, migrateSettingsSelection, modelCandidatesErrorMessage,
    resolveSettingsForm,
    modelLayerMapOf, modelLayerSelectionOf, modelPageCountOf, normalizeModelCandidatesDraft, normalizeModelFallbackLimitDraft, normalizeOrchestratorDraft,
    normalizePeakValleyDraft, normalizePromptOverrides, normalizeRolePromptProjection, normalizeSettingsCommitDraft, normalizeSettingsDraft, normalizeSettingsModelGroups,
    promptEntryOf, promptOverridesEqual, removeModelCandidatePage, reorderModelLayers, setModelLayerSelection,
    settingsDraftEqual, settingsRolesForProvider, syncSettingsDefaultsProvider, unifiedProviderOf, updateRolePromptProjection,
    useEnabledSettingsRoles, useHostMeta, validateModelCandidateRows, validatePromptText,
  });
})(globalThis);
