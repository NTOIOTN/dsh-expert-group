/**
 * fan-out 限额解析（R3-13：从 fanout.js 的 manager 本体拆出）。
 *
 * ## 职责
 * role / provider / 默认并发上限与角色级超时的**唯一解析实现**：
 * - 三级来源模型：当前设置解析值（live）> 快照显式映射（restored*Overrides）> 安全默认值；
 * - 解析函数抛错/返回非法值一律降级并记录**一次性**结构化诊断，绝不让调度抛错；
 * - 诊断去重维度是 kind（concurrencyLimit / roleLimits / providerLimits），解析成功后清除。
 *
 * ## 状态所有权（C5）
 * 本模块独占 9 个限额配置绑定：defaultConcurrencyLimit、resolverSource、
 * lastResolvedDefaultConcurrencyLimit、roleLimits、providerLimits、restoredRoleLimitOverrides、
 * restoredProviderLimitOverrides、invalidLimitDiagnostics（Map）与 lastInvalidLimitKind。
 * 容器不出本模块：对外只有解析命令、只读诊断投影，以及 limitConfig 上的逐字段 getter/setter。
 *
 * @module dsh-expert-group/fanout/limits
 */
import { DEFAULT_CONCURRENCY_LIMIT, MAX_CONCURRENCY_LIMIT, normalizeTimeoutMs } from "./contracts.js";
import { validateConcurrencyLimit, validateProviderLimit } from "./validation.js";

export function createLimitResolver({ config, events }) {
  const {
    concurrencyLimit: rawConcurrencyLimit,
    hasLiveConcurrencyResolver,
    initialDefaultConcurrencyLimit,
    initialRoleLimits,
    initialProviderLimits,
    roleTimeoutSource: rawRoleTimeoutMs,
    staticRoleTimeoutMs,
  } = config;
  const { emit } = events;
  // ── 本模块独占的 9 个可变绑定（唯一 owner） ──
  let defaultConcurrencyLimit = initialDefaultConcurrencyLimit;
  let resolverSource = hasLiveConcurrencyResolver ? "live" : "snapshot";
  let lastResolvedDefaultConcurrencyLimit = initialDefaultConcurrencyLimit;
  let roleLimits = initialRoleLimits;
  let providerLimits = initialProviderLimits;
  let restoredRoleLimitOverrides = Object.freeze({});
  let restoredProviderLimitOverrides = Object.freeze({});
  const invalidLimitDiagnostics = new Map();
  let lastInvalidLimitKind = null;

  /**
   * 记录一次动态上限的非法返回：只读诊断 + 一次性结构化事件。
   *
   * 事件必须"一次性而不是每次派发都刷"：解析发生在调度热路径上，同一个坏设置会在每个
   * drain 被反复读到。去重维度是 kind——只有从"没有该 kind 的诊断"进入非法状态时才发布，
   * 解析成功后 clearInvalidDynamicLimit 清空，下一次再坏会重新发布（新的故障窗口）。
   *
   * 事件负载只含 kind / 来源 / 回退值：不含设置原文、原始返回值或任何会话数据，避免
   * 把 journald/事件历史变成敏感信息泄露面。
   *
   * @param {"concurrencyLimit"|"roleLimits"|"providerLimits"} kind - 非法值的解析路径。
   * @param {unknown} value - 原始返回值（只取类型，不落盘）。
   * @param {string} [message] - 覆盖默认诊断文案（按 kind 或"含非法条目"区分）。
   */
  function noteInvalidDynamicLimit(kind, value, message) {
    const firstObservation = !invalidLimitDiagnostics.has(kind);
    invalidLimitDiagnostics.set(kind, {
      kind,
      valueType: value === null ? "null" : typeof value,
      message: message ?? (kind === "concurrencyLimit"
        ? "settings 解析出的并发上限不是 1~" + MAX_CONCURRENCY_LIMIT + " 的整数，已回退默认值 " + DEFAULT_CONCURRENCY_LIMIT
        : kind === "providerLimits"
          ? "settings 解析出的 providerLimits 不是 provider -> limit 映射，已忽略全部 provider 级覆盖"
          : "settings 解析出的 roleLimits 不是 role -> limit 映射，已忽略全部角色级覆盖"),
    });
    lastInvalidLimitKind = kind;
    if (!firstObservation) return;
    emit({
      type: "concurrency_limit_fallback",
      kind,
      source: "fallback",
      // 回退目标必须与真实调度行为一致：默认上限回退数值，role 映射回退默认值，
      // provider 映射回退"不限制"（0 语义），否则诊断会撒谎。
      fallback: kind === "concurrencyLimit"
        ? DEFAULT_CONCURRENCY_LIMIT
        : (kind === "providerLimits" ? "provider-unlimited" : "role-default"),
    });
  }

  /** 解析成功后清除对应 kind 的非法诊断；下次再出现非法值会重新发布一次性事件。 */
  function clearInvalidDynamicLimit(kind) {
    if (!invalidLimitDiagnostics.delete(kind)) return;
    if (lastInvalidLimitKind !== kind) return;
    const kinds = [...invalidLimitDiagnostics.keys()];
    lastInvalidLimitKind = kinds.length === 0 ? null : kinds[kinds.length - 1];
  }

  /** 对外只读投影：最近一次非法诊断的拷贝（不暴露内部 Map）。 */
  function invalidLimitSnapshot() {
    if (lastInvalidLimitKind === null) return null;
    const diagnostic = invalidLimitDiagnostics.get(lastInvalidLimitKind);
    return diagnostic === undefined ? null : Object.freeze({ ...diagnostic });
  }

  /**
   * 解析默认并发上限，并返回**这一次**解析的来源。
   *
   * source 取值：
   * - live：注入的解析函数给出了合法值（当前设置权威）；
   * - snapshot：没有 live resolver，使用冻结值（快照或构造期静态值）；
   * - fallback：解析函数抛错或返回非法值，本次已回退安全默认值。诊断必须如实暴露
   *   fallback，否则用户看到设置页=3、实际并发=20 却无从解释。
   *
   * @returns {{value:number, source:"live"|"snapshot"|"fallback"}}
   */
  function resolveDefaultConcurrencyLimitState() {
    if (resolverSource !== "live" || typeof rawConcurrencyLimit !== "function") {
      lastResolvedDefaultConcurrencyLimit = defaultConcurrencyLimit;
      return { value: defaultConcurrencyLimit, source: "snapshot" };
    }
    let raw;
    try {
      raw = rawConcurrencyLimit();
    } catch {
      // 解析函数读的是外部设置状态：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("concurrencyLimit", undefined);
      lastResolvedDefaultConcurrencyLimit = DEFAULT_CONCURRENCY_LIMIT;
      return { value: DEFAULT_CONCURRENCY_LIMIT, source: "fallback" };
    }
    const check = validateConcurrencyLimit(raw);
    if (check.ok) {
      clearInvalidDynamicLimit("concurrencyLimit");
      lastResolvedDefaultConcurrencyLimit = check.value;
      return { value: check.value, source: "live" };
    }
    noteInvalidDynamicLimit("concurrencyLimit", raw);
    lastResolvedDefaultConcurrencyLimit = DEFAULT_CONCURRENCY_LIMIT;
    return { value: DEFAULT_CONCURRENCY_LIMIT, source: "fallback" };
  }

  /** 只取数值的便捷形式（调度热路径与角色池解析使用）。 */
  function resolveDefaultConcurrencyLimit() {
    return resolveDefaultConcurrencyLimitState().value;
  }

  /**
   * 解析 role 级覆盖，按票据 03 的三级优先级：
   * 当前 settings 解析值（live resolver）> 快照中的显式角色级映射 > 安全默认值。
   *
   * 静态映射在构造/restore 时已完成校验（非法配置直接抛错），不需要第三层回退；
   * 函数形式读取的是"当前设置"，因此：
   * - 每次调用都读一次最新值——设置可能在两次提交之间变化，缓存会把新设置吞掉；
   * - 调度热路径对每个父任务每轮只解析一次，任务级显式限制则完全不走这里；
   * - 返回结构非法时整体忽略 live 角色级覆盖，回退到快照映射/默认值；
   * - 单个角色的非法值只让该 role 回退（live 未给出时由快照映射补位）。
   */
  function resolveRoleLimits() {
    if (typeof roleLimits !== "function") return roleLimits;
    let raw;
    let liveUnavailable = false;
    try {
      raw = roleLimits();
    } catch {
      // 解析函数读的是外部设置状态：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("roleLimits", undefined);
      liveUnavailable = true;
      raw = undefined;
    }
    const normalized = {};
    if (!liveUnavailable) {
      if (raw === undefined || raw === null) {
        // 没有 live 覆盖不是"非法值"：清除诊断，由快照映射/默认值兜底。
        clearInvalidDynamicLimit("roleLimits");
      } else if (typeof raw !== "object" || Array.isArray(raw)) {
        noteInvalidDynamicLimit("roleLimits", raw);
      } else {
        let invalidEntry = false;
        for (const [role, limit] of Object.entries(raw)) {
          const check = validateConcurrencyLimit(limit);
          if (check.ok) normalized[role] = check.value;
          else invalidEntry = true;
        }
        if (invalidEntry) {
          noteInvalidDynamicLimit(
            "roleLimits",
            raw,
            "settings 解析出的 roleLimits 含非法条目，已忽略这些角色级覆盖",
          );
        } else {
          clearInvalidDynamicLimit("roleLimits");
        }
      }
    }
    // 第二层：恢复出来的显式角色级映射。只在 live 没有给出合法值时补位，
    // 因此 live 的合法值永远优先；live 整体不可用时这里给出稳定的快照回退。
    for (const [role, limit] of Object.entries(restoredRoleLimitOverrides)) {
      if (typeof normalized[role] === "number") continue;
      const check = validateConcurrencyLimit(limit);
      if (check.ok) normalized[role] = check.value;
    }
    return Object.freeze(normalized);
  }

  /**
   * 解析 provider 级覆盖（票据 26）：与 resolveRoleLimits 同一套来源模型。
   *
   * - live 解析函数每次调用都重新读取当前设置（设置保存后立即约束后续派发）；
   * - 结构非法时整体忽略 live 覆盖并记录一次性诊断；
   * - 单个 provider 的非法值只让该 provider 回退到快照映射/不限制；
   * - 合法的 0 必须原样保留：它表示「显式不限制」，不能与「未配置」混淆——
   *   虽然两者调度上等价，但诊断必须如实投影用户写了什么。
   *
   * @returns {Readonly<Record<string, number>>} provider -> 0..64 的冻结映射。
   */
  function resolveProviderLimits() {
    if (typeof providerLimits !== "function") return providerLimits;
    let raw;
    let liveUnavailable = false;
    try {
      raw = providerLimits();
    } catch {
      // 解析函数读的是外部 settings：异常只允许降级，不能让调度抛错。
      noteInvalidDynamicLimit("providerLimits", undefined);
      liveUnavailable = true;
      raw = undefined;
    }
    const normalized = {};
    if (!liveUnavailable) {
      if (raw === undefined || raw === null) {
        // 没有 live 覆盖不是"非法值"：清除诊断，由快照映射/不限制兜底。
        clearInvalidDynamicLimit("providerLimits");
      } else if (typeof raw !== "object" || Array.isArray(raw)) {
        noteInvalidDynamicLimit("providerLimits", raw);
      } else {
        let invalidEntry = false;
        for (const [provider, limit] of Object.entries(raw)) {
          const check = validateProviderLimit(limit);
          if (check.ok && provider.trim().length > 0) normalized[provider] = check.value;
          else invalidEntry = true;
        }
        if (invalidEntry) {
          noteInvalidDynamicLimit(
            "providerLimits",
            raw,
            "settings 解析出的 providerLimits 含非法条目，已忽略这些 provider 级覆盖",
          );
        } else {
          clearInvalidDynamicLimit("providerLimits");
        }
      }
    }
    // 第二层：恢复出来的显式 provider 级映射，只在 live 没有给出合法值时补位。
    for (const [provider, limit] of Object.entries(restoredProviderLimitOverrides)) {
      if (typeof normalized[provider] === "number") continue;
      const check = validateProviderLimit(limit);
      if (check.ok) normalized[provider] = check.value;
    }
    return Object.freeze(normalized);
  }

  /**
   * 某个任务生效的 provider 名额上限；undefined 表示不受 provider 限流约束。
   *
   * 语义（票据 26）：
   * - 任务没有 provider 归属（角色未配置主模型）→ undefined（不限制）；
   * - provider 未配置、显式 0 → undefined（不限制）；
   * - 1..64 → 该 provider 的并发名额。
   *
   * 接收**已解析**的 provider 映射而不是自己再读一次设置：调度热路径一轮只解析一次，
   * 避免每个候选分片都重复遍历设置对象。
   *
   * @param {object} task - 父任务。
   * @param {Readonly<Record<string, number>>} resolved - 本轮解析出的 provider -> limit。
   * @returns {number|undefined}
   */
  function providerLimitOf(task, resolved) {
    const provider = typeof task?.provider === "string" ? task.provider : "";
    if (provider.length === 0) return undefined;
    const configured = resolved[provider];
    if (typeof configured !== "number" || configured <= 0) return undefined;
    return configured;
  }

  /**
   * 快照里对外暴露的单个任务"有效并发上限"，仅供展示与契约稳定使用。
   *
   * 三级优先级：任务级显式 concurrencyLimit（submit 入参，或快照恢复出来的任务级值）
   * > 角色级设置（roleLimits，即该角色的共享并发池，按当前设置解析，可增可减）
   * > 动态/静态默认值。恢复任务在 restore 时会带上快照里的任务级限制，因此重启不会改变
   * 显式限制的语义；角色级这一层由 resolveRoleLimits 按"live 解析值 > 快照显式映射 >
   * 安全默认值"解析，不会被快照冻结（票据 03）。
   *
   * 注意：调度判定**不能**直接使用本函数。它给出的单值只适用于"某 role 只有一个父任务"
   * 的场景；多父任务并存时任务级上限与 role 共享池必须分别判定（见 rolePoolLimitFor /
   * taskLimitFor 与 dispatchAvailable），否则低上限任务会被别人的 role 占用饿死。
   */
  function roleLimitFor(task) {
    if (typeof task.concurrencyLimit === "number") return task.concurrencyLimit;
    const configured = resolveRoleLimits()[task.role];
    if (typeof configured === "number") return configured;
    return resolveDefaultConcurrencyLimit();
  }

  /**
   * role 共享池上限：该 role 下**所有**父任务合计允许的 running 分片数。
   *
   * 只看 role 级设置与默认值，**不读 task.concurrencyLimit**——任务级显式上限是"这个
   * 父任务最多跑几个"的独立约束，不能把它当成整个 role 的池子大小，否则一个任务级 64
   * 的任务会把同一 role 里别的父任务挤出去。
   */
  function rolePoolLimitFor(task) {
    const configured = resolveRoleLimits()[task.role];
    if (typeof configured === "number") return configured;
    return resolveDefaultConcurrencyLimit();
  }

  /**
   * 任务级上限：显式 concurrencyLimit 才有值；未显式给出时返回 undefined。
   *
   * 返回 undefined 而不是回退默认值，是因为"未设置任务级上限"的语义是**这一层不设限**，
   * 由 role 共享池单独兜底；若这里回退成默认值，一个未设限的任务在同一 role 里就再也
   * 拿不到超过 10 个槽位（即便 role 池允许更多），与工具描述不符。
   */
  function taskLimitFor(task) {
    return typeof task.concurrencyLimit === "number" ? task.concurrencyLimit : undefined;
  }

  /**
   * 只读并发视图：当前有效默认值、各 role 覆盖、来源与最近一次非法值诊断。
   *
   * source 是**本次解析**的来源（live / snapshot / fallback），不是构造期的静态标记：
   * 设置解析函数抛错或返回非法值时，用户必须能看到"这次回退到了安全默认值"。roles 的
   * 解析同样可能刷新非法诊断，因此 invalid 在 roles 之后再取。
   *
   * 不暴露任务负载；invalid.message 只含插件自身固定文案，不含设置原文或原始返回值。
   */
  function concurrencyLimits() {
    // 局部别名：本次解析结果。**不能**叫 state，否则会遮蔽唯一状态 owner 的 state。
    const limitState = resolveDefaultConcurrencyLimitState();
    const roles = resolveRoleLimits();
    // provider 级映射（票据 26）与 role 级同源同点解析：诊断必须与调度读到同一份值。
    const providers = resolveProviderLimits();
    // invalid 必须在两次解析之后取：任一解析路径都可能刷新最近一次非法诊断。
    const invalid = invalidLimitSnapshot();
    return Object.freeze({
      default: limitState.value,
      roles: Object.freeze({ ...roles }),
      providers: Object.freeze({ ...providers }),
      source: limitState.source,
      ...(invalid === null ? {} : { invalid }),
    });
  }

  /**
   * 解析角色级默认超时（票据 06 的第三级来源）。
   *
   * 这里只读、不缓存：设置页保存后，之后创建的 attempt 立即使用新值，
   * 而已经在运行的 attempt 不会被改写（它们的超时在创建时已写进 attempt.timeoutMs）。
   *
   * 解析函数抛错或返回非法值一律按「未启用」处理：配置错误不能让派发失败。
   *
   * @returns {number|undefined} 0 表示角色级显式禁用；undefined 表示角色级未配置。
   */
  function resolveRoleTimeoutMs() {
    if (typeof rawRoleTimeoutMs !== "function") return staticRoleTimeoutMs;
    let raw;
    try {
      raw = rawRoleTimeoutMs();
    } catch {
      // 解析函数读的是外部 settings：异常只允许降级，不能让派发抛错。
      return undefined;
    }
    return normalizeTimeoutMs(raw);
  }

  /**
   * 单个 attempt 的超时解析（优先级的唯一实现，票据 06）：
   * shard 显式（含 0）> 父任务默认（含 0）> 角色默认（含 0）> 未启用。
   *
   * 只在**创建 attempt 时**调用一次，结果写入 attempt.timeoutMs：
   * 运行中的超时因此不会因后续设置/父任务默认变化而改变。
   *
   * @param {number|undefined} taskDefaultTimeoutMs - task.timeoutMs（只含显式值）。
   * @param {number|undefined} shardTimeoutMs - shard.timeoutMs（只含显式值）。
   * @returns {number|undefined}
   */
  function resolveAttemptTimeoutMs(taskDefaultTimeoutMs, shardTimeoutMs) {
    if (typeof shardTimeoutMs === "number") return shardTimeoutMs;
    if (typeof taskDefaultTimeoutMs === "number") return taskDefaultTimeoutMs;
    return resolveRoleTimeoutMs();
  }

  return Object.freeze({
    noteInvalidDynamicLimit,
    clearInvalidDynamicLimit,
    invalidLimitSnapshot,
    resolveDefaultConcurrencyLimitState,
    resolveDefaultConcurrencyLimit,
    resolveRoleLimits,
    resolveProviderLimits,
    providerLimitOf,
    roleLimitFor,
    rolePoolLimitFor,
    taskLimitFor,
    concurrencyLimits,
    resolveRoleTimeoutMs,
    resolveAttemptTimeoutMs,
    // 逐字段 getter/setter 门面（窄能力面：一次只读写一个标量，不暴露任何容器）
    limitConfig: Object.freeze({
      get defaultConcurrencyLimit() { return defaultConcurrencyLimit; },
      set defaultConcurrencyLimit(value) { defaultConcurrencyLimit = value; },
      get resolverSource() { return resolverSource; },
      set resolverSource(value) { resolverSource = value; },
      get lastResolvedDefaultConcurrencyLimit() { return lastResolvedDefaultConcurrencyLimit; },
      set lastResolvedDefaultConcurrencyLimit(value) { lastResolvedDefaultConcurrencyLimit = value; },
      get roleLimits() { return roleLimits; },
      set roleLimits(value) { roleLimits = value; },
      get providerLimits() { return providerLimits; },
      set providerLimits(value) { providerLimits = value; },
      get restoredRoleLimitOverrides() { return restoredRoleLimitOverrides; },
      set restoredRoleLimitOverrides(value) { restoredRoleLimitOverrides = value; },
      get restoredProviderLimitOverrides() { return restoredProviderLimitOverrides; },
      set restoredProviderLimitOverrides(value) { restoredProviderLimitOverrides = value; },
    }),
  });
}
