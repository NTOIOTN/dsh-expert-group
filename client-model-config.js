/**
 * 「模型配置」区域的公开门面与 install/自定义 provider 创建面（R8 票据 28）。
 *
 * 票据 28 之后本文件只保留三件事：
 * 1. **公开检查点**：仍以 `dsh-expert-group/client-model-config` 发布与改造前**完全相同**的
 *    导出面（键集合与顺序逐项不变），client.js / client-model-config-host.js / provider 卡片 /
 *    区域模型因此都不需要改读取方式；
 * 2. **install/facade 族**：区域折叠区渲染面（`buildSectionModel`）与自定义 provider 创建族
 *    （route id / Base URL / 协议 / 草稿校验与两阶段提交）——它们直接面向界面，是票据里
 *    "install/facade 部分"；
 * 3. **组合**：从 paths / rows 的检查点取回实现，按原字面量顺序拼成同一份冻结 api。
 *
 * 依赖方向单一：paths ← rows ← 本文件。本文件只读两个子模块检查点，二者都不得反向读取本文件。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在 paths、rows 之后，唯一 descriptor 之前）。
 */
(function installModelConfig(global) {
  "use strict";

  /** classic 片段发布本模块导出面用的 globalThis Symbol 键（与相邻侧车模块约定一致）。 */
  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config");

  // ── 子模块检查点：同一次装配里由 paths、rows 先写入（顺序由 manifest 保证）──────────
  const pathsSymbol = Symbol.for("dsh-expert-group/client-model-config-paths");
  const rowsSymbol = Symbol.for("dsh-expert-group/client-model-config-rows");
  const paths = global[pathsSymbol] || {};
  const rows = global[rowsSymbol] || {};
  // 门面按原字面量顺序重组 api：paths 侧 18 个原语（含只有安装面使用的 isBlankDraftValue），
  // rows 侧 5 个常量与全部模型行族函数。
  const {
    isBlankDraftValue, isPlainObject, isSchemaNode, isNonEmptyString, jsonEqual, deepClone,
    getPath, hasPath, setPath, deletePath, getSubtree, deriveKeyRef, pathOps, hasOps,
    revisionConflictOf, createEditorBaseline, restoreDefaultOps, providerSubtreeOps,
  } = paths;
  const {
    REASONING_EFFORTS, REASONING_EFFORT_EMPTY, INPUT_MODALITIES, DEFAULT_INPUT_MODALITIES,
    EDITABLE_PROFILE_FIELDS, modelDisplayNameOf, modelInputOf, modelDraftsOf, inputOverrideOf,
    emptyEffortSelection, effortSelectionFor, effortSelectionEqual, unknownEffortKeysOf,
    hasUnknownEffortKeys, reasoningDiffLines, selectedLevelsOf, applyEffortSelection,
    normalizeEffortsEntry, createModelRow, inputSelectionFor, patchModelDraft,
    setModelEffortSelection, setModelInputSelection, removeModelRow, appendModelRow,
    parseCapacity, formatCapacity, validateModelRows, normalizeModelRows, modelCatalogOverridden,
    isOverridden, inheritedModelsOf, fallbackModelsOf, materializeOverrideOps, modelCatalogOps,
    modelEditableProfileOf, importNamespace, catalogOpsFor, modelOverrideDecision,
    modelChoicesOf, indexModelsById, adoptModels, joinProviderDirectory, providerEditable,
    providerRemovable, providerProfileOf, apiKeyEnvOf, credentialRefOf, protocolChoices,
    createSchemaAdapter, namespaceSchemaInfo, validateProfileDraft, rolesAffectedByChange,
    reasoningGuardMessage, removedLevelsOf, namespaceViewOf, roleDefaultsOf, modelCardApply,
    providerListSections, apiKeyField, buildModelCardModel, createCardSession,
  } = rows;

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
