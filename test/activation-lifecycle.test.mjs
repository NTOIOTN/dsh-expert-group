/**
 * Agent 创建生命周期回归：模拟 DSH 的同步 agent/created 发布窗口。
 *
 * 这里使用严格 Context 替身：任何未声明属性都抛出 Cordis 同样的错误文本。
 * 这样测试同时覆盖“创建后仍留在 registry”和“旧 cwd 读取会同步回滚创建”两条路径，
 * 而不需要启动 DSH Web 或修改 DSH 核心。
 */
import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import { AUTO_RECOVERY_LIMIT } from "../shared.js";

const CWD_ERROR = 'cannot get property "cwd" without inject';
const AGENT_ERROR = 'cannot get property "agent" without inject';
function createStrictHost({ providerReady = false, startMode = "sync-before-resolve", domainReady = true, llmOverrides = {}, settingsUpdateGate, settingsOverride, goalsOverride, followupError, injectError, inboxRemoveBehavior, delayAgentCreatedSetup = false, strictChildContext = false, forbidResendApis = false, seedChildModels = {} } = {}) {
  const listeners = new Map();
  const cleanups = [];
  const roots = [];
  const registeredGuards = [];
  const rootToolGuards = [];
  const registeredTools = new Map();
  const childAgents = new Map();
  // 该测试开关模拟 DSH 在 agent/created 首个监听器执行时尚未完成 child setup；
  // 第二个监听器运行前再补齐 marker 与 scoped tools.guard，复现真实生命周期竞态。
  const pendingAgentCreatedSetups = new Map();
  const events = [];
  const pendingInboxMessages = new Map();
  const followupMessageIds = [];
  const settingsValue = {
    provider: "mock",
    defaults: { explorer: { provider: "mock", model: "mock" }, librarian: { provider: "mock", model: "mock" }, observer: { provider: "mock", model: "mock" } },
    // 本文件只验证激活/生命周期语义；关闭系统通知，避免完成通知 spawn 真实 PowerShell
    // 子进程（污染桌面，并把测试收尾拖慢上秒）。通知文案由专门用例覆盖。
    notificationEnabled: false,
    notificationVolume: 100,
  };
  let settingsRevision = 0;
  const settingsUpdates = [];
  const settingsPersisted = [];
  const settingsDocumentUpdates = [];
  const settingsWritePhases = [];
  const settingsPresentation = [];
  /**
   * describe().value 的形状：defaults resolved（缺字段回填九个可改字段的默认值）。
   * 读取面的归一仍按缺失字段回退默认值处理，因此这里补默认值不会改变语义，
   * 只是与真实宿主的投影形状一致。
   */
  const SETTINGS_FIELD_DEFAULTS = {
    provider: "",
    defaults: {},
    promptOverrides: {},
    notificationEnabled: true,
    notificationVolume: 100,
    roleConcurrencyLimit: 10,
    observerPreferred: false,
    taskManagementEnabled: true,
  };
  function settingsResolvedValue() {
    const value = { ...SETTINGS_FIELD_DEFAULTS };
    for (const [key, entry] of Object.entries(settingsValue)) {
      if (entry !== undefined) value[key] = structuredClone(entry);
    }
    return value;
  }
  // 非公开重发 API 的访问记录；配合 forbidResendApis 的访问守卫使用。
  const resendApiViolations = [];
  /**
   * root Agent 公开 steer 的调用记录（本票据新增的唯一观测 seam）。
   *
   * 收口结论的投递是 void 调用，只有记录才能观察「是否投递、投递了什么」。记录按 exact
   * Agent 过滤，多 root 用例互不干扰。
   */
  const agentSteers = [];
  let resolveSettingsUpdateStarted;
  const settingsUpdateStarted = new Promise((resolve) => { resolveSettingsUpdateStarted = resolve; });
  const sections = new Map();
  const routes = new Map();
  let childSequence = 0;
  let releaseStart;
  let resolveStartEntered;
  const startEntered = new Promise((resolve) => { resolveStartEntered = resolve; });
  const startGate = new Promise((resolve) => { releaseStart = resolve; });
  const startBarriers = [];
  let resolveAllStartBarriers;
  const allStartBarriers = new Promise((resolve) => { resolveAllStartBarriers = resolve; });
  let releaseDomain;
  const domainReadyGate = domainReady
    ? Promise.resolve()
    : new Promise((resolve) => { releaseDomain = resolve; });
  const domainTables = new Map([["child_models", new Map(Object.entries(seedChildModels))]]);
  const domain = {
    open: async () => {
      await domainReadyGate;
      return ({
      table(name) {
        if (!domainTables.has(name)) domainTables.set(name, new Map());
        const table = domainTables.get(name);
        return {
          entries: () => [...table.entries()],
          put: async (key, value) => table.set(key, value),
          delete: async (key) => table.delete(key),
        };
      },
      close: async () => {},
      });
    },
  };

  function on(event, callback) {
    const list = listeners.get(event) ?? [];
    list.push(callback);
    listeners.set(event, list);
    const dispose = () => {
      const current = listeners.get(event);
      if (current === undefined) return;
      const index = current.indexOf(callback);
      if (index !== -1) current.splice(index, 1);
    };
    cleanups.push(dispose);
    return dispose;
  }

  function effect(setup) {
    const cleanup = setup();
    if (typeof cleanup === "function") cleanups.push(cleanup);
    return () => {
      if (typeof cleanup === "function") cleanup();
    };
  }

  const tools = {
    register(definition) {
      registeredTools.set(definition.name, definition);
      return () => registeredTools.delete(definition.name);
    },
    get(name) {
      return registeredTools.get(name);
    },
    schemas() {
      return [...registeredTools.values()].map((definition) => ({ name: definition.name }));
    },
    guard(callback) {
      registeredGuards.push(callback);
      return () => {
        const index = registeredGuards.indexOf(callback);
        if (index !== -1) registeredGuards.splice(index, 1);
      };
    },
  };

  const settings = {
    // 0.1.7 契约：没有 register/get/watch，公开面是 configure/describe/mutate(+update/replace)。
    configure(presentation, owner) {
      settingsPresentation.push({ presentation, owner });
      return () => {};
    },
    describe: () => [{
      ns: "dsh-expert-group",
      revision: settingsRevision,
      autoGenerate: false,
      applies: "live",
      value: settingsResolvedValue(),
    }],
    /** 写入原语：顶层整值 set（DEG 的 defaults / promptOverrides 是整份映射语义）。 */
    async mutate(namespace, ops, expectedRevision) {
      const patch = {};
      for (const op of Array.isArray(ops) ? ops : []) {
        if (op?.op !== "set") continue;
        // 保留完整路径信息，供断言“只允许写 volatile 字段”与 fields 形状。
        patch[op.path[0]] = op.value;
      }
      const next = patch;
      if (expectedRevision !== undefined && expectedRevision !== settingsRevision) {
        const error = new Error(`settings namespace "${namespace}" changed since it was read`);
        error.code = "SETTINGS_CONFLICT";
        throw error;
      }
      // 提交端点已在自己的边界内完成语义校验；替身只记录并落盘。
      settingsWritePhases.push({ namespace, phase: "boundary" });
      resolveSettingsUpdateStarted?.();
      if (settingsUpdateGate !== undefined) await settingsUpdateGate;

      settingsWritePhases.push({ namespace, phase: "persist" });
      Object.assign(settingsValue, next);
      settingsPersisted.push({ namespace, value: structuredClone(settingsValue) });
      settingsUpdates.push({ namespace, next, expectedRevision });
      settingsRevision += 1;
      // 真实宿主只发 (ns, revision) 两个参数：没有 registration token。
      settingsDocumentUpdates.push({ namespace, revision: settingsRevision });
      emit("settings/document-updated", namespace, settingsRevision);
    },
  };

  const agentRegistry = {
    roots: () => [...roots],
    get: (id) => roots.find((agent) => agent.id === id),
    // rc.2 的真实宿主**一定**提供 agents.list()：等待的运行判定要用同一份完整 runtime
    // 快照交叉校验（缺它一律 fail-closed）。因此 strict host 也必须给出 root + 全部 child。
    list: () => [...roots, ...childAgents.values()],
  };

  const subagents = {
    getProvider: () => providerReady ? {
      capabilities: { depthLimit: true, toolFilter: true, persona: true },
      prepareContinuable: () => {},
    } : undefined,
    sendMessage: async (_parent, childId) => {
      if (followupError !== undefined) {
        const error = followupError instanceof Function ? followupError() : followupError;
        if (error !== undefined) throw error;
      }
      const messageId = `followup-${childId}-${followupMessageIds.length + 1}`;
      followupMessageIds.push(messageId);
      events.push({ type: "followup", childId, messageId });
      return messageId;
    },
    interrupt: () => {},
    // 权威后代 listing：真实 DSH 的 SubagentService 公开该方法，strict host 必须提供
    // 同一形状，否则 finalize / turn-stopping 的等待用例只能落到 waterfall——而
    // waterfall 是非专属扩展点，**不能证明静止**（见 README「等待判定」）。
    listDescendants,
    async startContinuable({ request }) {
      resolveStartEntered?.();
      let releaseCall;
      const callBarrier = new Promise((resolve) => { releaseCall = resolve; });
      const barrier = { role: request.agentOptions?.__degExpertRole, release: releaseCall, childId: void 0 };
      startBarriers.push(barrier);
      if (startBarriers.length === 2) resolveAllStartBarriers?.();
      if (startMode === "deferred") await startGate;
      const childId = `child-${++childSequence}`;
      const messageId = `message-${childSequence}`;
      barrier.childId = childId;
      events.push({ type: "startContinuable/call", childId, role: request.agentOptions?.__degExpertRole, task: request.prompt?.[0]?.text, persona: request.persona, deny: request.toolFilter?.deny ?? [] });
      const child = createChildAgent(childId, request.agentOptions);
      childAgents.set(childId, child);
      // DSH core 的真实顺序：AgentRegistry 注册并发布 agent/created，之后 Promise 才 resolve。
      events.push({ type: "agent/created", childId, messageId, role: request.agentOptions?.__degExpertRole, task: request.prompt?.[0]?.text, persona: request.persona, deny: request.toolFilter?.deny ?? [], pendingBeforeResolve: true });
      if (startMode === "per-call-deferred") await callBarrier;
      if (startMode === "throw") throw new Error("startContinuable failed");
      events.push({ type: "startContinuable/resolve", childId, messageId });
      return { childId, messageId };
    },
  };

  const systemPrompt = {
    section: (definition) => {
      sections.set(definition.name, definition);
      return () => {
        if (sections.get(definition.name) === definition) sections.delete(definition.name);
      };
    },
  };

  const webServer = {
    port: 3080,
    register: (route) => {
      routes.set(route.path, route);
      return () => {
        if (routes.get(route.path) === route) routes.delete(route.path);
      };
    },
  };

  const fiber = { state: 0 };
  const llm = {
    listProviders: async () => [{ id: "mock" }],
    listModels: async () => [{ id: "mock" }],
    resolveCallConfig: async (value) => value,
    ...llmOverrides,
  };
  const rawContext = {
    tools,
    subagents,
    systemPrompt,
    llm,
    agents: agentRegistry,
    settings: settingsOverride ?? settings,
    webServer,
    get: (name) => rawContext[name],
    goals: goalsOverride ?? {},
    fiber,
    logger: { warn: (message) => events.push({ type: "warn", message }) },
    on,
    effect,
    waterfall,
    inject: (names, callback) => {
      if (names.includes("storageDomain")) return callback({ storageDomain: domain });
      return callback(context);
    },
  };

  const context = new Proxy(rawContext, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
      throw new Error(CWD_ERROR);
    },
  });

  /**
   * 派发一次宿主事件。
   *
   * 返回值是各监听器回调结果的数组：`agent/turn-stopping` 是 serial 事件，真实宿主会
   * await 监听器返回的 Promise，用例必须拿到这些 Promise 才能断言「root turn 是否被保持
   * 打开」。既有只关心副作用的用例忽略返回值，语义不变。
   */
  function emit(event, ...payload) {
    const results = [];
    const callbacks = [...(listeners.get(event) ?? [])];
    for (let index = 0; index < callbacks.length; index++) {
      results.push(callbacks[index](...payload));
      if (event !== "agent/created" || index !== 0) continue;
      const agent = payload[0]?.agent;
      const pending = pendingAgentCreatedSetups.get(agent);
      if (pending === undefined) continue;
      // 早期 guard listener 已经观察到不完整状态；后续身份 listener 才能观察到
      // 完整 marker 与可用的 child tools.guard。
      Object.assign(agent.options, pending.options);
      agent.ctx.tools.guard = pending.guard;
      pendingAgentCreatedSetups.delete(agent);
    }
    return results;
  }

  /**
   * 受控的权威后代 listing（`subagents.listDescendants`）。
   *
   * 为什么 strict host 必须有它：`workspace/session-activity` waterfall 是**非专属**
   * 扩展点，任何 listener 都可能返回一个全新的空数组，因此它只能提供「确有 running
   * 后代」的正向证据，**不能证明静止**。finalize 与 turn-stopping 用例要表达的正是
   * 「专家真正结束后等待才收口」，所以这里按真实 DSH `SubagentService.listDescendants`
   * 的同一形状补上权威 seam。
   *
   * 行的形状必须与公开契约同形（`SubagentDescendantListEntry`）：child 行的必填字段是
   * `kind`、`id`、`mode`（`one-shot` | `continuable`）、`activity`（`running` |
   * `inactive`）、`hasChildren`、`parentId`、`depth`；`mode:"continuable"` 的行
   * 另有必填的 `label`。插件按契约 fail-closed 校验这些字段，缺字段的假数据会让等待
   * 永远收不口——那是夹具缺陷，不是插件行为。
   *
   * 字段的建模：`mode`/`label` 取 child 登记时写入的 creation marker
   * （`__degExpertContinuable` / `__degExpertRole`，真实实现由 parent catalog 的
   * `subagent/catalog` 事件折叠而来）；`activity` 表示 **session residency**，上游实现是
   * `sessions.get(entry.id) === undefined ? "inactive" : "running"` —— 本 host 里 child 的
   * 会话始终驻留（在 `childAgents` 里），因此恒报 `"running"`，**不**再按 turn 是否结束
   * 推导。运行判定由插件用 `agents.list()` 里的 `Agent.status` 交叉校验（见 child.status）。
   *
   * @param {string} rootSessionId - 起始 root 会话 id。
   * @returns {Promise<object[]>} 递归后代行。
   */
  function childTurnEnded(child) {
    const events = child?.session?.events;
    return Array.isArray(events) && events.length > 0 && events[events.length - 1]?.type === "turn/end";
  }

  async function listDescendants(rootSessionId) {
    const childrenOf = new Map();
    for (const child of childAgents.values()) {
      const parentId = child?.options?.__degExpertParent ?? child?.session?.header?.parentSession;
      if (typeof parentId !== "string" || parentId.length === 0) continue;
      const siblings = childrenOf.get(parentId) ?? [];
      siblings.push(child);
      childrenOf.set(parentId, siblings);
    }
    const rows = [];
    const visited = new Set([rootSessionId]);
    const stack = (childrenOf.get(rootSessionId) ?? [])
      .map((child) => ({ child, parentId: rootSessionId, depth: 1 }))
      .reverse();
    while (stack.length > 0) {
      const { child, parentId, depth } = stack.pop();
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const nestedChildren = childrenOf.get(child.id) ?? [];
      // 真实实现的 mode 来自 parent catalog；harness 用 child 登记时写入的 continuable
      // marker 作等价信号。continuable 行在公开契约里**必填** label，因此这里取角色
      // marker（真实实现取 catalog 的 durable creation label）。
      const continuable = child?.options?.__degExpertContinuable === true;
      const role = child?.options?.__degExpertRole;
      const label = typeof role === "string" && role.length > 0 ? role : void 0;
      rows.push({
        kind: "child",
        id: child.id,
        parentId,
        depth,
        mode: continuable ? "continuable" : "one-shot",
        ...(label === void 0 ? {} : { label }),
        // 会话仍驻留（child 在本 host 的注册表里）⇒ activity 恒为 running。
        activity: "running",
        hasChildren: nestedChildren.length > 0,
      });
      for (const nested of [...nestedChildren].reverse()) {
        stack.push({ child: nested, parentId: child.id, depth: depth + 1 });
      }
    }
    return rows;
  }

  // 仅供 request-error 回归测试驱动公开 waterfall；生产 DSH 由 Cordis 提供同等语义。
  async function waterfall(event, ...payload) {
    // root turn 等待的 root-scoped 后代查询：与真实宿主同一形状。这里返回空数组**不**
    // 构成静止证明——waterfall 是非专属扩展点，任意 listener 都能返回新的 `[]`，
    // 插件因此只把它当作「没有正向活动证据」。用例要证明静止必须走 listDescendants。
    if (event === "workspace/session-activity") return [];
    const callbacks = [...(listeners.get(event) ?? [])];
    let index = 0;
    const next = () => {
      const callback = callbacks[index++];
      return callback === undefined ? void 0 : callback(...payload, next);
    };
    return next();
  }

  let agentGuardCount = 0;
  const childGuardOwners = [];

  /**
   * 严格 seam 守卫：生产代码不得访问**非公开**的重发 API（Session.prompt、
   * Agent.whenIdle），child Agent 的 steer 同样禁止访问。
   *
   * rc.2 的公开契约里，**root** Agent 的 `Agent.steer(message)` 是插件在 root turn 的
   * serial 生命周期边界投递一次性收口结论的唯一通道（模型仍不得直接调用它，见提示词契约）。
   * 因此 root 上的 `steer` 由 allowSteer 换成可观察的记录函数：既证明插件确实走公开 API
   * 投递，也不会把「插件内部 steer」与「模型直接控制 agent」混为一谈；child 是叶子 worker，
   * 没有收口投递职责，仍然按非公开 API 禁止。
   */
  function installResendApiGuard(agent, { allowSteer = false } = {}) {
    const targets = [
      { owner: "Session", target: agent?.session, property: "prompt" },
      { owner: "Agent", target: agent, property: "whenIdle" },
      ...(allowSteer ? [] : [{ owner: "Agent", target: agent, property: "steer" }]),
    ];
    for (const { owner, target, property } of targets) {
      if (target === null || typeof target !== "object") continue;
      Object.defineProperty(target, property, {
        configurable: true,
        enumerable: false,
        get() {
          resendApiViolations.push(owner + "." + property);
          throw new Error("非公开重发 API 不得被访问: " + owner + "." + property);
        },
      });
    }
  }

  function createChildAgent(id, options) {
    const delayedSetup = delayAgentCreatedSetup
      && typeof options?.__degExpertRole === "string"
      && typeof options?.__degExpertParent === "string";
    const childOptions = { ...options };
    const installChildGuard = (callback) => {
      agentGuardCount += 1;
      const owner = { agent: child, callback };
      childGuardOwners.push(owner);
      return () => {
        const index = childGuardOwners.indexOf(owner);
        if (index !== -1) childGuardOwners.splice(index, 1);
      };
    };
    if (delayedSetup) {
      // 首个 agent/created listener 看到的 options 故意没有身份 marker；
      // 恢复 marker 后由后续 listener 负责建立专家身份。
      delete childOptions.__degExpertRole;
      delete childOptions.__degExpertParent;
    }
    const childContext = {
      effect: () => {},
      tools: {
        guard: delayedSetup ? void 0 : installChildGuard,
      },
      on: () => () => {},
    };
    if (!strictChildContext) childContext.agent = null;
    const childContextView = strictChildContext
      ? new Proxy(childContext, {
        get(target, property, receiver) {
          if (property === "agent") throw new Error(AGENT_ERROR);
          return Reflect.get(target, property, receiver);
        },
      })
      : childContext;
    const child = {
      id,
      options: childOptions,
      session: { id, header: { id, cwd: "C:/workspace", parentSession: "root-test" }, requestHeader: () => ({ config: { provider: "mock", model: "mock" } }) },
      ctx: childContextView,
      // rc.2 的 `Agent.status` 只有 `idle` / `running`：child 的 turn 一旦以 turn/end 收尾，
      // 它就不再执行（idle），否则视为 running。listing 的 `activity` 只表达 residency，
      // 与本字段无关；运行判定由插件用同一份 runtime 快照交叉校验。
      get status() { return childTurnEnded(child) ? "idle" : "running"; },
    };
    if (!strictChildContext) child.ctx.agent = child;
    if (delayedSetup) {
      pendingAgentCreatedSetups.set(child, {
        options: { __degExpertRole: options.__degExpertRole, __degExpertParent: options.__degExpertParent },
        guard: installChildGuard,
      });
    }
    const previousGet = agentRegistry.get;
    agentRegistry.get = (lookupId) => lookupId === id ? child : previousGet(lookupId);
    if (forbidResendApis) installResendApiGuard(child);
    emit("agent/created", { agent: child });
    return child;
  }

  function createAgent(id = "root-test") {
    const agentGuards = [];
    const agentCtxRaw = {
      agent: null,
      effect: (setup) => {
        const cleanup = setup();
        if (typeof cleanup === "function") agentGuards.push(cleanup);
        return () => {
          if (typeof cleanup === "function") cleanup();
        };
      },
      tools: {
        guard: (callback) => {
          agentGuardCount += 1;
          rootToolGuards.push(callback);
          const dispose = () => {
            const index = rootToolGuards.indexOf(callback);
            if (index !== -1) rootToolGuards.splice(index, 1);
          };
          agentGuards.push(dispose);
          return dispose;
        },
      },
      on: () => () => {},
    };
    const agentCtx = new Proxy(agentCtxRaw, {
      get(target, property, receiver) {
        if (Reflect.has(target, property)) return Reflect.get(target, property, receiver);
        throw new Error(CWD_ERROR);
      },
    });
    const agent = {
      id,
      options: { provider: "mock", model: "mock" },
      session: {
        id,
        header: { id, cwd: "C:/workspace", parentSession: undefined },
        requestHeader: () => ({ config: { provider: "mock", model: "mock" } }),
      },
      ctx: agentCtx,
      inbox: {
        remove(messageId) {
          if (inboxRemoveBehavior !== undefined) {
            // 模拟真实 Inbox.remove：非 true 返回值不能先把消息从 pending 容器删掉，
            // 否则会把生产中的同步撤回失败误测成已撤回。
            const result = inboxRemoveBehavior(messageId, pendingInboxMessages.has(messageId));
            const removed = result === true && pendingInboxMessages.delete(messageId);
            events.push({ type: "inbox/remove", messageId, removed, result });
            return result;
          }
          const removed = pendingInboxMessages.delete(messageId);
          events.push({ type: "inbox/remove", messageId, removed });
          return removed;
        },
      },
      inject(message) {
        if (injectError !== undefined) throw (injectError instanceof Function ? injectError() : injectError);
        events.push({ type: "inbox/inject", messageId: message?.id });
        pendingInboxMessages.set(message.id, message);
        emit("agent/inbox/inserted", { agent, message });
      },
      /**
       * rc.2 公开的 `Agent.steer(message): void`：同步提交到 next-step inbox。
       *
       * 夹具只记录调用（含 exact Agent、被投递消息与提交顺序），不产生任何其他副作用：
       * 真实宿主随后发布的 `agent/inbox/spliced`（next-step）与 `step/start` 仍由用例显式
       * 驱动，因此「插件 steer 之后 loop 会重读 inbox」的因果链在测试里可见而不被代替。
       */
      steer(message) {
        agentSteers.push({ agent, message });
      },
    };
    agentCtxRaw.agent = agent;
    roots.push(agent);
    if (forbidResendApis) installResendApiGuard(agent, { allowSteer: true });
    try {
      emit("agent/created", { agent });
    } catch (error) {
      roots.splice(roots.indexOf(agent), 1);
      throw error;
    }
    return agent;
  }

  function insertInbox(agent, message) {
    pendingInboxMessages.set(message.id, message);
    emit("agent/inbox/inserted", { agent, message });
  }

  // 模拟同一 childId 被 cold-resume/replacement 接管：registry 与 activation 都指向新
  // 对象，但旧 durable record 仍保存原 Agent/Session，供迟到 settlement 身份测试使用。
  function replaceChildActivation(id) {
    const current = childAgents.get(id);
    if (current === undefined) throw new Error(`unknown child ${id}`);
    // 真实 replacement 也可能没有可用的 childModels 快照；先删 fixture 的快照，
    // 使 agent/created 只更新当前 activation，而不会把旧 record 改写成新对象。
    for (const table of domainTables.values()) table.delete(id);
    const replacement = {
      ...current,
      options: { provider: "mock", model: "mock" },
      session: { ...current.session, header: { ...current.session.header } },
    };
    const previousGet = agentRegistry.get;
    agentRegistry.get = (lookupId) => lookupId === id ? replacement : previousGet(lookupId);
    childAgents.set(id, replacement);
    emit("agent/created", { agent: replacement });
    return replacement;
  }

  return {
    context,
    roots,
    registeredGuards,
    rootToolGuards,
    childGuardOwners,
    get agentGuardCount() { return agentGuardCount; },
    resendApiViolations,
    /** 某个 exact root Agent 收到的 steer 消息（收口结论投递的公开可观察面）。 */
    steerMessages: (agent) => agentSteers.filter((entry) => entry.agent === agent).map((entry) => entry.message),
    /** 全部 steer 调用（含 exact Agent），用于断言「一次也没有投递」。 */
    steers: () => agentSteers.map((entry) => ({ ...entry })),
    sections,
    routes,
    on,
    createAgent,
    createChildAgent,
    registeredTools,
    childAgents,
    settings,
    settingsValue,
    settingsUpdates,
    settingsPersisted,
    settingsDocumentUpdates,
    settingsWritePhases,
    settingsPresentation,
    get settingsRevision() { return settingsRevision; },
    events,
    pendingInboxMessages,
    followupMessageIds,
    emit,
    waterfall,
    insertInbox,
    replaceChildActivation,
    startEntered,
    settingsUpdateStarted,
    releaseStart: () => releaseStart?.(),
    releaseDomain: () => releaseDomain?.(),
    startBarriers,
    allStartBarriers,
    listenerCount: (event) => listeners.get(event)?.length ?? 0,
    dispose: () => {
      fiber.state = 5;
      for (const cleanup of [...cleanups].reverse()) cleanup();
    },
  };
}

function activate(host) {
  plugin.apply(host.context, { enableOrchestrator: true, enableObserver: true });
}

async function invokeJsonRoute(host, body) {
  const route = host.routes.get("/api/dsh-expert-group");
  assert.ok(route, "Host must register the settings RPC route");
  const listeners = new Map();
  const request = {
    method: "POST",
    headers: {
      origin: "http://127.0.0.1:3080",
      host: "127.0.0.1:3080",
      "content-type": "application/json",
    },
    setEncoding() {},
    on(event, callback) {
      const list = listeners.get(event) ?? [];
      list.push(callback);
      listeners.set(event, list);
      return request;
    },
    resume() {},
  };
  let statusCode;
  let responseBody = "";
  const response = {
    writeHead(status) { statusCode = status; },
    end(value = "") { responseBody += String(value); },
  };
  const emit = (event, ...args) => {
    for (const callback of [...(listeners.get(event) ?? [])]) callback(...args);
  };
  const pending = route.handler(request, response);
  emit("data", JSON.stringify(body));
  emit("end");
  await pending;
  return { statusCode, body: responseBody.length === 0 ? null : JSON.parse(responseBody) };
}

test("current plugin survives strict synchronous root-agent creation", () => {
  const host = createStrictHost();
  activate(host);

  const agent = host.createAgent();

  assert.equal(agent.id, "root-test");
  assert.equal(host.roots.length, 1);
  assert.equal(host.roots[0], agent);
  assert.ok(host.agentGuardCount >= 1);
  assert.ok(host.sections.has("dsh-expert-group:orchestrator"));
  assert.ok(host.routes.has("/api/dsh-expert-group"));
});

test("continuable child admission 不依赖未注入的 child ctx.agent", async () => {
  const host = createStrictHost({ providerReady: true, strictChildContext: true });
  activate(host);
  host.createAgent();

  const result = await executeRole(host, "explorer", "strict child context");

  assert.equal(result.kind, "continuable");
  assert.equal(result.accepted, true);
  assert.ok(host.events.some((event) => event.type === "startContinuable/resolve"));
  host.dispose();
});

test("真实 apply 监听 settings/document-updated 两参数事件，并拒绝过期 settings 候选", async () => {
  let releaseModels;
  let resolveModelsStarted;
  const modelsStarted = new Promise((resolve) => { resolveModelsStarted = resolve; });
  const modelsGate = new Promise((resolve) => { releaseModels = resolve; });
  const host = createStrictHost({
    llmOverrides: {
      listModels: async () => {
        resolveModelsStarted();
        await modelsGate;
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  // settings-source 与目录观察各订阅一次；0.1.7 只有两参数事件。
  assert.ok(host.listenerCount("settings/document-updated") >= 1);

  const request = invokeJsonRoute(host, {
    action: "settings-commit",
    expectedRevision: 0,
    settings: {
      provider: "mock",
      // 票据 20 之后只有**真正变化**的角色才会走真实目录解析；本用例需要一个异步校验
      // 窗口来观察"其它 namespace 的文档更新"，因此候选必须真的换一个模型。
      defaults: { explorer: { provider: "mock", model: "mock-next" } },
      notificationEnabled: true,
      notificationVolume: 100,
    },
  });
  await modelsStarted;
  // 其它 namespace 的文档更新发生在异步目录校验期间，必须推进同一提交代次。
  host.emit("settings/document-updated", "llm-mock", 1);
  releaseModels();

  const response = await request;
  assert.equal(response.statusCode, 400);
  assert.equal(response.body?.error?.code, "invalid-selection");
  assert.equal(host.settingsUpdates.length, 0);

  host.dispose();
  assert.equal(host.listenerCount("settings/document-updated"), 0);
});

test("真实 apply 在写入窗口完成 settings-commit 与 legacy defaults", async () => {
  const runCase = async (body, prepare) => {
    let releaseWrite;
    const settingsWriteGate = new Promise((resolve) => { releaseWrite = resolve; });
    const host = createStrictHost({
      settingsUpdateGate: settingsWriteGate,
      llmOverrides: { listModels: async () => [{ id: "mock" }, { id: "mock-next" }] },
    });
    activate(host);
    prepare?.(host);
    const request = invokeJsonRoute(host, body);
    await host.settingsUpdateStarted;
    // 提交端点已通过自己的语义校验与代次栅栏；此刻替身正卡在宿主写入。
    assert.deepEqual(host.settingsWritePhases.map((entry) => entry.phase), ["boundary"]);
    host.emit("settings/document-updated", "llm-mock", 7);
    releaseWrite();

    const response = await request;
    assert.equal(response.statusCode, 200);
    assert.equal(response.body?.ok, true);
    assert.deepEqual(host.settingsWritePhases.map((entry) => entry.phase), ["boundary", "persist"]);
    assert.equal(host.settingsPersisted.length, 1);
    assert.equal(host.settingsUpdates.length, 1);
    assert.equal(host.settingsRevision, 1);
    assert.equal(host.settingsDocumentUpdates.length, 1);
    host.dispose();
  };

  await runCase({
    action: "settings-commit",
    expectedRevision: 0,
    settings: {
      provider: "mock",
      defaults: { explorer: { provider: "mock", model: "mock-next" } },
      notificationEnabled: true,
      notificationVolume: 100,
    },
  });
  await runCase({
    action: "commit",
    sessionId: "root-test",
    scope: "defaults",
    changes: [{ role: "explorer", selection: { provider: "mock", model: "mock-next" } }],
  }, (host) => host.createAgent());
});

test("真实 apply 在新契约 Host（无 capability 字段）上仍可保存", async () => {
  const candidate = {
    provider: "mock",
    defaults: { explorer: { provider: "mock", model: "mock" } },
    notificationEnabled: true,
    notificationVolume: 100,
  };
  const host = createStrictHost();
  activate(host);
  const response = await invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 0, settings: candidate });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body?.ok, true);
  assert.equal(host.settingsUpdates.length, 1);
  assert.equal(host.settingsPersisted.length, 1);
  host.dispose();
});


test("真实 apply 在同一 token 内去重重复和乱序 revision", async () => {
  let releaseWrite;
  const settingsWriteGate = new Promise((resolve) => { releaseWrite = resolve; });
  let releaseSecondModels;
  let resolveSecondModelsStarted;
  const secondModelsStarted = new Promise((resolve) => { resolveSecondModelsStarted = resolve; });
  let modelCalls = 0;
  const host = createStrictHost({
    settingsUpdateGate: settingsWriteGate,
    llmOverrides: {
      listModels: async () => {
        modelCalls += 1;
        if (modelCalls === 2) {
          resolveSecondModelsStarted();
          await new Promise((resolve) => { releaseSecondModels = resolve; });
        }
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  /**
   * 票据 20 之后只有真正变化的角色才会走目录解析（未变更角色沿用已保存值），
   * 因此两条提交各自换一个模型：每条都会真的进入异步目录校验，本用例才有一个
   * "第二次解析期间到达重复事件"的窗口可以观察。
   */
  const candidateFor = (model) => ({
    provider: "mock",
    defaults: { explorer: { provider: "mock", model } },
    notificationEnabled: true,
    notificationVolume: 100,
  });
  const first = invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 0, settings: candidateFor("mock-next") });
  await host.settingsUpdateStarted;
  // 两参数契约：同 revision 重复事件必须去重；不同 revision 一律保守失效
  // （宿主只在文档真的变化时才发事件，因此任何不同 revision 都代表目录可能需要重读）。
  host.emit("settings/document-updated", "llm-other", 1);
  host.emit("settings/document-updated", "llm-other", 1);
  releaseWrite();
  const firstResponse = await first;
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(firstResponse.body?.ok, true);
  assert.equal(host.settingsUpdates.length, 1);

  const second = invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 1, settings: candidateFor("mock-next-2") });
  await secondModelsStarted;
  // 同 revision 与同 namespace 的重复事件不得再次推进目录代次。
  host.emit("settings/document-updated", "llm-other", 1);
  releaseSecondModels();
  const secondResponse = await second;
  assert.equal(secondResponse.statusCode, 200);
  assert.equal(secondResponse.body?.ok, true);
  assert.equal(host.settingsUpdates.length, 2);
  host.dispose();
});

test("真实 apply 对非法 revision 保守失效（新契约没有 registration token）", async () => {
  let releaseModels;
  let resolveModelsStarted;
  const modelsStarted = new Promise((resolve) => { resolveModelsStarted = resolve; });
  const modelsGate = new Promise((resolve) => { releaseModels = resolve; });
  const host = createStrictHost({
    llmOverrides: {
      listModels: async () => {
        resolveModelsStarted();
        await modelsGate;
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  // 先记录一个较高 revision 的目录快照；随后请求捕获其后的 generation。
  host.emit("settings/document-updated", "llm-mock", 9);
  const request = invokeJsonRoute(host, {
    action: "settings-commit",
    expectedRevision: 0,
    settings: {
      provider: "mock",
      // 票据 20：只有真正变化的角色才会进入异步目录校验，这里必须换一个模型。
      defaults: { explorer: { provider: "mock", model: "mock-next" } },
      notificationEnabled: true,
      notificationVolume: 100,
    },
  });
  await modelsStarted;
  // revision 非法（无法安全去重）必须保守失效。
  host.emit("settings/document-updated", "llm-mock", 1);
  releaseModels();
  const response = await request;
  assert.equal(response.statusCode, 400);
  assert.equal(response.body?.error?.code, "invalid-selection");
  assert.equal(host.settingsUpdates.length, 0);
  host.dispose();
});

test("真实 apply 对缺失 revision 与非法类型保守逐次失效", async () => {
  let activeGate;
  const host = createStrictHost({
    llmOverrides: {
      listModels: async () => {
        const gate = activeGate;
        gate.started();
        await gate.wait;
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  // 票据 20：只有真正变化的角色才会进入异步目录校验，因此候选换一个模型（两次尝试
  // 都不会落盘，已保存值保持不变，第二次仍然是一次真实变更）。
  const candidate = {
    provider: "mock",
    defaults: { explorer: { provider: "mock", model: "mock-next" } },
    notificationEnabled: true,
    notificationVolume: 100,
  };
  const rejectAfter = async (...eventArgs) => {
    let resolveStarted;
    let release;
    const gate = {
      started: () => resolveStarted(),
      wait: new Promise((resolve) => { release = resolve; }),
    };
    const started = new Promise((resolve) => { resolveStarted = resolve; });
    activeGate = gate;
    const request = invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 0, settings: candidate });
    await started;
    host.emit("settings/document-updated", ...eventArgs);
    release();
    const response = await request;
    assert.equal(response.statusCode, 400);
    assert.equal(response.body?.error?.code, "invalid-selection");
  };

  // 缺失 revision 与非法类型都无法安全去重：都必须保守失效。
  await rejectAfter("llm-mock");
  await rejectAfter("llm-mock", "not-a-revision");
  assert.equal(host.settingsUpdates.length, 0);
  host.dispose();
});

test("真实 apply 旧 defaults 使用 captured revision 返回 settings conflict", async () => {
  let releaseWrite;
  const settingsWriteGate = new Promise((resolve) => { releaseWrite = resolve; });
  const host = createStrictHost({ settingsUpdateGate: settingsWriteGate });
  activate(host);
  host.createAgent();
  const body = {
    action: "commit",
    sessionId: "root-test",
    scope: "defaults",
    changes: [{ role: "explorer", selection: { provider: "mock", model: "mock" } }],
  };
  const first = invokeJsonRoute(host, body);
  await host.settingsUpdateStarted;
  const second = invokeJsonRoute(host, body);
  // 确保第二个旧协议请求已进入队列并捕获 revision 0，随后才允许首个落盘。
  await Promise.resolve();
  releaseWrite();
  const [firstResponse, secondResponse] = await Promise.all([first, second]);
  assert.equal(firstResponse.statusCode, 200);
  assert.equal(secondResponse.statusCode, 409);
  assert.equal(secondResponse.body?.error?.code, "settings-conflict");
  assert.equal(host.settingsUpdates.length, 1);
  assert.equal(host.settingsUpdates[0].expectedRevision, 0);
  host.dispose();
});

test("真实 apply legacy defaults 提交只通过 settings 写入 defaults patch", async () => {
  // 语义来源：settings 命名空间只保存全局 defaults，插件运行数据不得整体写回。
  // 这里在公开 settings 写边界断言同一契约（而不是读取生产源码文本）：
  // 严格 Host 只暴露 configure/describe/mutate，任何整体写回路径都不存在，
  // 因此一次成功的 defaults 提交必须且只能表现为一次 defaults-only 的写入。
  const host = createStrictHost();
  activate(host);
  host.createAgent();
  const response = await invokeJsonRoute(host, {
    action: "commit",
    sessionId: "root-test",
    scope: "defaults",
    changes: [{ role: "explorer", selection: { provider: "mock", model: "mock" } }],
  });
  assert.equal(response.statusCode, 200);
  assert.equal(host.settingsUpdates.length, 1, "defaults 提交只允许一次 settings 写入");
  assert.deepEqual(Object.keys(host.settingsUpdates[0].next), ["defaults"], "只允许写入 defaults，不得携带插件运行数据");
  assert.deepEqual(host.settingsUpdates[0].next.defaults.explorer, { provider: "mock", model: "mock" }, "本次变更的角色选择必须写入");
  assert.deepEqual(host.settingsPersisted[0].value.defaults.explorer, { provider: "mock", model: "mock" });
  assert.equal(host.settingsPersisted.length, 1, "defaults 提交只允许落盘一次");
  host.dispose();
});

test("真实 apply 的 settings commit 失败后仍可串行处理后续提交", async () => {
  let modelCalls = 0;
  let resolveCalls = 0;
  const host = createStrictHost({
    llmOverrides: {
      listModels: async () => {
        modelCalls += 1;
        return [];
      },
      resolveCallConfig: async (config) => {
        resolveCalls += 1;
        if (resolveCalls === 1) throw new Error("first resolve failed");
        return config;
      },
    },
  });
  activate(host);
  // 票据 20：未变更的角色不再重新解析，因此候选必须真的换一个模型；第一次解析失败
  // 不会落盘，已保存值保持不变，第二次提交仍然是一次真实模型变更。
  const candidate = {
    provider: "mock",
    defaults: { explorer: { provider: "mock", model: "mock-next" } },
    notificationEnabled: true,
    notificationVolume: 100,
  };
  const first = invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 0, settings: candidate });
  const second = invokeJsonRoute(host, { action: "settings-commit", expectedRevision: 0, settings: candidate });
  const responses = await Promise.all([first, second]);
  assert.equal(responses[0].statusCode, 400);
  assert.equal(responses[0].body?.error?.code, "invalid-selection");
  assert.equal(responses[1].statusCode, 200);
  assert.equal(responses[1].body?.ok, true);
  assert.equal(modelCalls, 2);
  assert.equal(host.settingsUpdates.length, 1);
  assert.equal(host.settingsUpdates[0].expectedRevision, 0);
  host.dispose();
});

test("真实 apply 忽略自身 settings/document-updated，且独立 settings commit 不等 domain gate", async () => {
  let releaseModels;
  let resolveModelsStarted;
  const modelsStarted = new Promise((resolve) => { resolveModelsStarted = resolve; });
  const modelsGate = new Promise((resolve) => { releaseModels = resolve; });
  const host = createStrictHost({
    llmOverrides: {
      listModels: async () => {
        resolveModelsStarted();
        await modelsGate;
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  const request = invokeJsonRoute(host, {
    action: "settings-commit",
    expectedRevision: 0,
    settings: {
      provider: "mock",
      // 票据 20：只有真正变化的角色才会进入异步目录校验，这里必须换一个模型。
      defaults: { explorer: { provider: "mock", model: "mock-next" } },
      notificationEnabled: true,
      notificationVolume: 100,
    },
  });
  await modelsStarted;
  host.emit("settings/document-updated", "dsh-expert-group", 1);
  releaseModels();

  const response = await request;
  assert.equal(response.statusCode, 200);
  assert.equal(response.body?.ok, true);
  assert.equal(host.settingsUpdates.length, 1);

  host.dispose();
  assert.equal(host.listenerCount("settings/document-updated"), 0);

  const pendingDomainHost = createStrictHost({ providerReady: true, domainReady: false });
  activate(pendingDomainHost);
  pendingDomainHost.createAgent();
  const child = await executeRole(pendingDomainHost, "explorer", "create pending domain write");
  assert.equal(child.kind, "continuable");

  const settingsCommit = invokeJsonRoute(pendingDomainHost, {
    action: "settings-commit",
    expectedRevision: 0,
    settings: {
      provider: "mock",
      defaults: { explorer: { provider: "mock", model: "mock" } },
      notificationEnabled: true,
      notificationVolume: 100,
    },
  });
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("settings commit waited for pending storage domain")), 250);
  });
  let pendingResponse;
  try {
    pendingResponse = await Promise.race([settingsCommit, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
  assert.equal(pendingResponse.statusCode, 200);
  assert.equal(pendingDomainHost.settingsUpdates.length, 1);

  const legacyResponse = await invokeJsonRoute(pendingDomainHost, {
    action: "commit",
    sessionId: "root-test",
    scope: "defaults",
    changes: [{ role: "explorer", selection: { provider: "mock", model: "mock" } }],
  });
  assert.equal(legacyResponse.statusCode, 200);
  assert.equal(pendingDomainHost.settingsUpdates.length, 2);

  // 故意不释放 gate：这证明两个 settings 写入路径都不依赖 domain 最终 ready。
  pendingDomainHost.dispose();
});

async function executeRole(host, role, prompt, extra = {}) {
  return executeRoleWithExec(host, role, prompt, extra, { concludeTurn: () => {} });
}

async function executeRoleWithExec(host, role, prompt, extra = {}, execOverrides = {}) {
  const definition = host.registeredTools.get(role);
  assert.ok(definition, `${role} tool must be registered`);
  const root = host.roots[0];
  return definition.execute({
    description: `${role} regression`,
    prompt,
    ...extra,
  }, { agent: root, signal: new AbortController().signal, concludeTurn: () => {}, ...execOverrides });
}

async function executeFinalize(host, args, execOverrides = {}) {
  const definition = host.registeredTools.get("dsh_expert_group_finalize");
  assert.ok(definition, "finalize tool must be registered");
  const root = host.roots[0];
  return definition.execute(args, { agent: root, signal: new AbortController().signal, concludeTurn: () => {}, ...execOverrides });
}

/**
 * 启动一次 finalize 但**不 await**，只观察工具回执本身。
 *
 * 两阶段契约：finalize 只做校验与登记并立即返回非终态 waiting，因此这个 Promise 立刻
 * 收口（`handle.waiting` 就是 waiting 回执）；真正的等待与投递发生在 root turn 的
 * `agent/turn-stopping` serial 边界，见 startFinalizeLifecycle。
 *
 * @returns {{status:string, value:unknown, promise:Promise<unknown>, waiting:unknown}} 句柄。
 */
function startFinalize(host, args, execOverrides = {}) {
  const definition = host.registeredTools.get("dsh_expert_group_finalize");
  assert.ok(definition, "finalize tool must be registered");
  const root = host.roots[0];
  const handle = { status: "pending", value: undefined, promise: undefined, waiting: undefined };
  handle.promise = definition.execute(args, {
    agent: root,
    signal: new AbortController().signal,
    concludeTurn: () => {},
    ...execOverrides,
  }).then(
    (value) => { handle.status = "resolved"; handle.value = value; handle.waiting = value; return value; },
    (error) => { handle.status = "rejected"; handle.value = error; throw error; },
  );
  // 用例可能永远不 await 这个句柄；先挂 rejection 消费者，避免未处理 rejection 噪声。
  handle.promise.catch(() => {});
  return handle;
}

/**
 * 驱动一次 root turn 的 `agent/turn-stopping`（宿主会 await 监听器返回的 Promise）。
 *
 * @returns {{returned:number, pending:number, settled:Promise<string>}} 可断言句柄。
 */
function stopRootTurn(host, turn = 1, signal) {
  const results = host.emit("agent/turn-stopping", {
    agent: host.roots[0],
    turn,
    ...(signal === undefined ? {} : { signal }),
  });
  const waiting = results.filter((value) => value !== null && typeof value === "object" && typeof value.then === "function");
  return { returned: results.length, pending: waiting.length, settled: Promise.all(waiting).then(() => "settled") };
}

/**
 * 两阶段收口的统一测试入口（保留 startFinalize 的句柄形状）。
 *
 * ① 调用真实注册的 finalize：只做校验与登记，立即返回 waiting；
 * ② 立刻驱动一次 root turn 的 `agent/turn-stopping`：等待与一次性投递都发生在该 serial
 *    边界上，句柄在整个链路落地后才 resolved。
 *
 * resolve 值：
 * - `{kind:"finalized", admissionEpoch, acceptedCount, reason:"finalized"}`：等待释放，
 *   且插件确实为该批次投递了一次性收口消息（epoch / acceptedCount 取自被投递消息的公开
 *   正文，不读取任何插件私有状态）；
 * - `{kind:"cancelled"}`：等待被取消（root 退休 / 卸载 / payload.signal abort）。取消不是
 *   终态收口，因此绝不谎报 finalized；
 * - finalize 自身被拒绝时原样返回该回执（校验矩阵用例继续按既有 rejected 断言）。
 *
 * @returns {{status:string, value:unknown, promise:Promise<unknown>, waiting:unknown}} 句柄。
 */
function startFinalizeLifecycle(host, args, execOverrides = {}) {
  const root = host.roots[0];
  const deliveredBefore = host.steerMessages(root).length;
  const handle = { status: "pending", value: undefined, promise: undefined, waiting: undefined };
  handle.promise = (async () => {
    const receipt = await executeFinalize(host, args, execOverrides);
    handle.waiting = receipt;
    if (receipt.kind !== "waiting") return receipt;
    // finalize 只登记：继续等待与投递都在本次 root turn 的 serial 边界。
    const stop = stopRootTurn(host, 1);
    if (stop.pending === 0) return { kind: "cancelled", reason: "wait-not-engaged" };
    await stop.settled;
    const delivered = host.steerMessages(root).slice(deliveredBefore);
    if (delivered.length === 0) return { kind: "cancelled", reason: "wait-cancelled" };
    const text = delivered.map((message) => message.content.map((block) => block.text).join("")).join("\n");
    const accepted = /acceptedCount (\d+)/.exec(text);
    const epoch = /admissionEpoch (\d+)/.exec(text);
    return {
      kind: "finalized",
      admissionEpoch: Number(epoch?.[1] ?? args?.admissionEpoch ?? 0),
      acceptedCount: Number(accepted?.[1] ?? 0),
      reason: "finalized",
    };
  })().then(
    (value) => { handle.status = "resolved"; handle.value = value; return value; },
    (error) => { handle.status = "rejected"; handle.value = error; throw error; },
  );
  handle.promise.catch(() => {});
  return handle;
}

/**
 * 让 strict host 里的一个专家 child 真正结束：先发布 turn/end 边界，再投递精确关联的
 * 父 inbox settlement。
 *
 * 改造后这正是 root turn 等待的「精确完成通知」通道：finalize 登记的工作项只有在
 * turn/end + 精确 settlement 之后才会结算，随后 root-scoped 查询（本 host 恒返回
 * 「没有 running 后代」）才会让等待收口。
 *
 * @param {object} host - strict host。
 * @param {object} admission - role 工具返回的 admission（需要 subagentId）。
 * @param {{turn?:number,messageId?:string,feedbackId?:string}} [options] - turn/message 契约。
 */
async function completeChildAdmission(host, admission, options = {}) {
  const turn = Number.isSafeInteger(options.turn) ? options.turn : 1;
  const messageId = options.messageId ?? "message-1";
  const feedbackId = options.feedbackId ?? "feedback-1";
  const child = host.childAgents.get(admission.subagentId);
  assert.ok(child !== undefined, "admission 必须有对应的 child agent");
  const turnEnd = { type: "turn/end", data: { turn, reason: { kind: "completed" } } };
  child.session.events = [
    { type: "turn/start", data: { turn } },
    { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin:dsh-expert-group" } } },
    { type: "assistant/message", data: { turn, message: { content: [{ type: "text", text: "done" }] } } },
    turnEnd,
  ];
  host.emit("session/event", child.session, turnEnd);
  await flushAsyncWork();
  host.emit("agent/inbox/inserted", {
    agent: host.roots[0],
    message: { id: feedbackId, source: { kind: "subagent-settled", senderSessionId: child.id } },
  });
  await flushAsyncWork();
}

function createFakeTimerHarness() {
  const timers = [];
  const cleared = [];
  // 票据 11：等待账本自身有两类与恢复无关的 timer——退避重查（≤1000ms）与长等待
  // 提醒（默认 30 分钟，按当前时刻计算可能略小于 1800000ms）。本 harness 只统计/
  // 驱动「自动恢复退避」这一组 timer（固定序列 2000..32000ms），因此只收集
  // 2000..60000ms 的 delay；句柄仍原样返回，clearTimeout 也照常记录。
  const RECOVERY_TIMER_MIN_DELAY_MS = 2000;
  const RECOVERY_TIMER_MAX_DELAY_MS = 60000;
  return {
    timers,
    cleared,
    setTimeout(callback, delay) {
      const timer = { callback, delay };
      const normalizedDelay = Number(delay);
      if (normalizedDelay >= RECOVERY_TIMER_MIN_DELAY_MS && normalizedDelay <= RECOVERY_TIMER_MAX_DELAY_MS) {
        timers.push(timer);
      }
      return timer;
    },
    clearTimeout(timer) {
      if (!cleared.includes(timer)) cleared.push(timer);
    },
  };
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("自动恢复集成：失败延时投递、成功复位并避免重复 dispatch", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const scheduler = createFakeTimerHarness();
  let timersPatched = false;

  try {
    const result = await executeRole(host, "explorer", "timer integration", {
      continue_parent_turn: true,
      affectedPaths: ["timer/integration/"],
    });
    assert.equal(result.kind, "continuable");
    const child = host.childAgents.get(result.subagentId);
    assert.ok(child);
    const root = host.roots[0];
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "timer/integration/result.md" }, agent: root };
    assert.match(rootGuard(guardedRead), /overlaps active expert work/);

    globalThis.setTimeout = scheduler.setTimeout;
    globalThis.clearTimeout = scheduler.clearTimeout;
    timersPatched = true;

    const firstFailure = {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "error", error: { message: "upstream unavailable" } } },
    };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [{ type: "text", text: "timer integration" }], source: { kind: "plugin" } } },
      firstFailure,
    ];
    host.emit("session/event", child.session, firstFailure);
    await flushAsyncWork();

    assert.equal(scheduler.timers.length, 1, "失败只应安排一个自动恢复 timer");
    assert.equal(scheduler.timers[0].delay, 2000);
    assert.equal(host.events.filter((event) => event.type === "followup").length, 0, "2 秒到期前不得立即 followup");
    assert.match(rootGuard(guardedRead), /overlaps active expert work/, "可恢复失败必须继续保护原活动范围");

    scheduler.timers[0].callback();
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "followup").length, 1, "timer 到期后只投递一次 followup");
    scheduler.timers[0].callback();
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "followup").length, 1, "迟到 callback 不得重复投递");

    const recoverySuccess = {
      type: "turn/end",
      data: { turn: 2, reason: { kind: "completed" } },
    };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { id: "followup-child-1-1", role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "recovered" }] } } },
      recoverySuccess,
    ];
    host.emit("session/event", child.session, recoverySuccess);
    await flushAsyncWork();
    assert.equal(rootGuard(guardedRead), undefined, "恢复链成功终态才释放原活动范围");

    const nextFailure = {
      type: "turn/end",
      data: { turn: 3, reason: { kind: "error", error: { message: "second failure" } } },
    };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 3 } },
      { type: "user/message", data: { id: "message-3", role: "user", content: [], source: { kind: "plugin" } } },
      nextFailure,
    ];
    host.emit("session/event", child.session, nextFailure);
    await flushAsyncWork();

    assert.equal(scheduler.timers.length, 2, "成功后下一次失败应重新安排 timer");
    assert.equal(scheduler.timers[1].delay, 2000, "成功后退避计数必须从 2 秒重新开始");
  } finally {
    if (timersPatched) {
      try {
        // 插件卸载必须在 fake scheduler 仍生效时清理尚未触发的 timer。
        host.dispose();
      } finally {
        globalThis.setTimeout = originalSetTimeout;
        globalThis.clearTimeout = originalClearTimeout;
      }
    } else {
      host.dispose();
    }
  }
});


test("问题4：可恢复异常先撤回 settlement，维持 handoff 和范围直到恢复", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push(["get"]); return undefined; },
      pause: () => { lifecycle.push(["pause"]); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push(["resume"]); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "recover gated feedback", {
      affectedPaths: ["file:docs/recovery-gated.md"],
    });
    assert.equal(result.kind, "continuable");
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "docs/recovery-gated.md" }, agent: root };
    const firstFailure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "transient" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      firstFailure,
    ];
    // 先处理 child turn/end，确认恢复链已经建立；DSH 随后 dispose child，最后才把
    // settlement 注入 parent。这个顺序对应真实 continuation 生命周期。
    host.emit("session/event", child.session, firstFailure);
    await flushAsyncWork();
    assert.equal(scheduler.timers.length, 1, "可恢复终态即使 handoff 未释放也必须安排 recovery");
    host.emit("agent/disposed", { agent: child });
    host.insertInbox(root, {
      id: "settlement-failure-1",
      source: { kind: "subagent-settled", senderSessionId: child.id },
    });
    assert.equal(host.pendingInboxMessages.has("settlement-failure-1"), false, "同步 inserted 边界必须撤回可恢复失败通知");
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.removed).length, 1);
    assert.match(rootGuard(guardedRead), /overlaps active expert work/, "恢复未决时范围不得提前放行");
    assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：feedback 先于 turn/end 也必须同步门控", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "feedback arrives first", {
      affectedPaths: ["file:docs/recovery-feedback-first.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const notice = { id: "feedback-first-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    assert.equal(host.pendingInboxMessages.has(notice.id), false, "无 turn/end 时 exact admission feedback 也必须同步撤回");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    const turnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "late failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      turnEnd,
    ];
    host.emit("session/event", child.session, turnEnd);
    await flushAsyncWork();
    assert.equal(scheduler.timers.length, 1, "turn/end 到达后仍应进入自动恢复");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("item2：recoverable failure 未完成时无 id settlement 不得进入可释放队列", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "idless recovery gate", {
      affectedPaths: ["file:docs/idless-recovery-gate.md"],
    });
    const root = host.roots[0];
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);

    // ① recoverable 失败尚不可知时到达的无 id settlement：无 id 无法撤回，只能先排队。
    const earlyIdless = { source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.emit("agent/inbox/inserted", { agent: root, message: earlyIdless });
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");

    // ② recoverable failure 的 turn/end **不是**终态边界：排队 marker 不得在此消费 token。
    const turnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "temporary failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      turnEnd,
    ];
    host.emit("session/event", child.session, turnEnd);
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.equal(scheduler.timers.length, 1, "必须进入自动恢复");

    // ③ gate 已打开后到达的**无 id** settlement：必须被拦截（无法撤回），不得 release。
    const lateIdless = { source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.emit("agent/inbox/inserted", { agent: root, message: lateIdless });
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.ok(
      host.events.some((event) => event.type === "warn" && /id-less recovery feedback/.test(String(event.message))),
      "无法撤回的无 id delivery 必须留下可诊断 warn",
    );

    // ③b legacy relay（另一 source 形态）：B 策略下同样 fail-closed，不得 release，
    // 并留下按 child 去重的 relay 诊断 warn。
    const lateRelay = { id: "idless-gate-relay", source: { kind: "subagent-report", senderSessionId: child.id } };
    host.insertInbox(root, lateRelay);
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.ok(
      host.events.some((event) => event.type === "warn" && /legacy subagent-report feedback/.test(String(event.message))),
      "relay fail-closed 必须留下可诊断 warn",
    );
    assert.equal(host.pendingInboxMessages.has(lateRelay.id), true, "relay 只作普通消息，不撤回");

    // ④ 恢复成功：gate 关闭，插件重新投递带 UUID 的最终通知 → 只按合法结算释放一次。
    scheduler.timers[0].callback();
    await flushAsyncWork();
    const recoveryMessageId = host.followupMessageIds[0];
    const successNotice = { id: "idless-gate-success-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    const recoverySuccess = { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { id: recoveryMessageId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "recovered" }] } } },
      recoverySuccess,
    ];
    host.insertInbox(root, successNotice);
    assert.equal(host.pendingInboxMessages.has(successNotice.id), false, "recovery 未完成时合法 settlement 也必须先撤回");
    host.emit("session/event", child.session, recoverySuccess);
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.equal(host.pendingInboxMessages.has(successNotice.id), true, "只交接当前合法 settlement");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：child dispose 后迟到 settlement 仍同步撤回并在预算耗尽后只交接一次", async () => {
  const lifecycle = [];
  let followupAttempts = 0;
  const host = createStrictHost({
    providerReady: true,
    followupError: () => {
      followupAttempts += 1;
      return new Error("temporary manager delivery failure");
    },
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "gate settlement after child dispose", {
      affectedPaths: ["file:docs/recovery-disposed-feedback.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const guardedRead = { name: "read", arguments: { file_path: "docs/recovery-disposed-feedback.md" }, agent: root };
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "model_not_allowed" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    // 真实 core 顺序：turn/end 发布后先排入插件 microtask，随后 child dispose，
    // 最后 microtask 才执行；测试必须保留这个窗口，不能先 flush 掩盖竞态。
    host.emit("session/event", child.session, failure);
    host.emit("agent/disposed", { agent: child });
    await flushAsyncWork();
    assert.equal(scheduler.timers.length, 1, "dispose 后的 recoverable turn/end 仍必须建立 recovery gate");
    const notice = { id: "disposed-child-settlement", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.messageId === notice.id && event.removed === true).length, 1, "dispose 后 settlement 仍必须同步调用 Inbox.remove 并得到 true");
    assert.equal(host.pendingInboxMessages.has(notice.id), false, "被撤回的迟到 settlement 不能留在父 inbox");
    assert.match(host.rootToolGuards[0](guardedRead), /overlaps active expert work/, "恢复预算未耗尽时 activity 范围必须继续保护");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    for (let attempt = 0; attempt < AUTO_RECOVERY_LIMIT; attempt += 1) {
      scheduler.timers[attempt].callback();
      await flushAsyncWork();
      if (attempt < AUTO_RECOVERY_LIMIT - 1) {
        assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "恢复预算未耗尽前不得交接最终反馈");
        assert.notEqual(host.rootToolGuards[0](guardedRead), undefined, "恢复预算未耗尽前范围不得释放");
      }
    }
    assert.equal(followupAttempts, AUTO_RECOVERY_LIMIT);
    assert.equal(host.events.filter((event) => event.type === "inbox/inject" && event.messageId === notice.id).length, 1, "预算耗尽后只交接一次已撤回 settlement");
    assert.equal(host.pendingInboxMessages.has(notice.id), true, "最终交接的 settlement 必须重新注入父 inbox");
    assert.equal(host.rootToolGuards[0](guardedRead), undefined, "最终交接后才释放活动范围");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：replacement activation 存在时旧 settlement 不得撤回或释放新任务 handoff", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "reject stale replacement settlement", {
      affectedPaths: ["file:docs/recovery-stale-replacement.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const oldChild = host.childAgents.get(result.subagentId);
    const guardedRead = { name: "read", arguments: { file_path: "docs/recovery-stale-replacement.md" }, agent: root };
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "old generation failed" } } } };
    oldChild.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    // event 已排入 microtask 后，child 立即 dispose 并由 replacement 占据当前 registry；
    // 旧 generation 的 event 不能在 microtask 中创建 recovery。
    host.emit("session/event", oldChild.session, failure);
    host.emit("agent/disposed", { agent: oldChild });
    const replacement = host.replaceChildActivation(oldChild.id);
    assert.notEqual(replacement, oldChild, "fixture 必须安装不同的当前 activation");
    await flushAsyncWork();
    assert.equal(scheduler.timers.length, 0, "replacement 已存在时旧 session/event 不得创建 recovery");
    const staleNotice = { id: "stale-replacement-settlement", source: { kind: "subagent-settled", senderSessionId: oldChild.id } };
    host.insertInbox(root, staleNotice);
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.messageId === staleNotice.id).length, 0, "replacement 不匹配时不得撤回可能属于新 generation 的通知");
    assert.equal(host.pendingInboxMessages.has(staleNotice.id), true, "旧 settlement 不得被 plugin 重投递或篡改");
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.match(host.rootToolGuards[0](guardedRead), /overlaps active expert work/, "旧 settlement 不得释放当前恢复链范围");
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0);
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
test("问题4：最终通知投递失败仍释放范围但不伪造 resume", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    followupError: Object.assign(new Error("manager followup unavailable"), { name: "AbortError" }),
    injectError: new Error("parent inbox closed"),
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "delivery failure", {
      affectedPaths: ["file:docs/recovery-delivery-failure.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const turnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "delivery failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      turnEnd,
    ];
    const notice = { id: "delivery-failure-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    host.emit("session/event", child.session, turnEnd);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    assert.equal(host.pendingInboxMessages.has(notice.id), false, "失败通知已撤回，不得因最终投递失败重新残留");
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0);
    const rootGuard = host.rootToolGuards[0];
    assert.equal(rootGuard({ name: "read", arguments: { file_path: "docs/recovery-delivery-failure.md" }, agent: root }), undefined, "投递失败也不能泄漏活动范围");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    host.insertInbox(root, notice);
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：Inbox.remove 非 true 时保持安全终态并阻止重复 resume", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    inboxRemoveBehavior: () => false,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "remove failure", {
      affectedPaths: ["file:docs/recovery-remove-failure.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "temporary" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    const notice = { id: "remove-failure-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.messageId === notice.id && event.result !== true).length, 1, "remove 非 true 必须被记录为失败");
    assert.equal(host.pendingInboxMessages.has(notice.id), true, "remove 返回 false 不能预先删除原消息");
    host.emit("session/event", child.session, failure);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    const recoveryId = host.followupMessageIds[0];
    const success = { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { id: recoveryId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "done" }] } } },
      success,
    ];
    host.emit("session/event", child.session, success);
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "remove 失败时不能伪造最终重投递");
    host.insertInbox(root, notice);
    await flushAsyncWork();
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：临时 followup 失败继续消耗预算而不提前交接", async () => {
  const lifecycle = [];
  let followupAttempts = 0;
  const host = createStrictHost({
    providerReady: true,
    followupError: () => {
      followupAttempts += 1;
      return followupAttempts === 1 ? new Error("temporary manager failure") : undefined;
    },
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "retry failed delivery", {
      affectedPaths: ["file:docs/recovery-followup-retry.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "first failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    const notice = { id: "followup-retry-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    host.emit("session/event", child.session, failure);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    assert.equal(followupAttempts, 1);
    assert.equal(scheduler.timers.length, 2, "临时投递失败必须用剩余预算安排下一次退避");
    assert.equal(scheduler.timers[1].delay, 4000);
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "预算未耗尽前不能交接最终反馈");
    assert.equal(host.pendingInboxMessages.has(notice.id), false);
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    scheduler.timers[1].callback();
    await flushAsyncWork();
    assert.equal(followupAttempts, 2);
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "后续 followup accepted 前仍不得交接");
    const recoveryId = host.followupMessageIds[0];
    const success = { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { id: recoveryId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "recovered" }] } } },
      success,
    ];
    const successNotice = { id: "followup-retry-success", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, successNotice);
    host.emit("session/event", child.session, success);
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 1);
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：临时 followup 连续失败在预算耗尽前不提前终结", async () => {
  const lifecycle = [];
  let followupAttempts = 0;
  const host = createStrictHost({
    providerReady: true,
    followupError: () => {
      followupAttempts += 1;
      return new Error("temporary manager failure");
    },
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "exhaust delivery retry budget", {
      affectedPaths: ["file:docs/recovery-followup-budget.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "initial failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    const notice = { id: "followup-budget-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    host.emit("session/event", child.session, failure);
    await flushAsyncWork();
    for (let attempt = 0; attempt < AUTO_RECOVERY_LIMIT; attempt += 1) {
      scheduler.timers[attempt].callback();
      await flushAsyncWork();
      if (attempt < AUTO_RECOVERY_LIMIT - 1) {
        assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "预算耗尽前不能最终交接");
        assert.notEqual(host.rootToolGuards[0]({ name: "read", arguments: { file_path: "docs/recovery-followup-budget.md" }, agent: root }), undefined, "预算耗尽前 activity 必须保留");
      }
    }
    assert.equal(followupAttempts, AUTO_RECOVERY_LIMIT);
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 1, "第六次失败后只交接一次最终通知");
    assert.equal(host.rootToolGuards[0]({ name: "read", arguments: { file_path: "docs/recovery-followup-budget.md" }, agent: root }), undefined);
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});
test("问题4/B：只有 legacy report 时不得交接（fail-closed），标准 notice 才交接一次", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "report fallback", {
      affectedPaths: ["file:docs/recovery-report-fallback.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const failure = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "temporary" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      failure,
    ];
    host.emit("session/event", child.session, failure);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    const recoveryId = host.followupMessageIds[0];
    const success = { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } };
    child.session.events = [
      ...child.session.events,
      { type: "turn/start", data: { turn: 2 } },
      { type: "user/message", data: { id: recoveryId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "done" }] } } },
      success,
    ];
    const report = { id: "report-only-final", source: { kind: "subagent-report", senderSessionId: child.id } };
    host.insertInbox(root, report);
    assert.equal(host.pendingInboxMessages.has(report.id), true, "legacy report 只作普通消息，不撤回（无 correlation id）");
    host.emit("session/event", child.session, success);
    await flushAsyncWork();
    // B：relay 没有 correlation id，不能作为最终交接；只有标准 notice 才交接。
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "只有 legacy report 时不得交接（fail-closed）");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.ok(
      host.events.some((event) => event.type === "warn" && /legacy subagent-report feedback/.test(String(event.message))),
      "relay fail-closed 必须留下可诊断 warn",
    );

    // 标准 notice（UUID）到达：正常消费并 resume 恰好一次（不是 relay 的 fallback）。
    const notice = { id: "report-only-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, notice);
    await flushAsyncWork();
    assert.equal(host.pendingInboxMessages.has(notice.id), true, "标准 notice 正常交接（不被撤回）");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4/B：turn/end 先到、重复 settlement 各自门控；legacy report fail-closed 不撤回", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "order feedback gate", {
      affectedPaths: ["file:docs/recovery-order.md"],
    });
    const root = host.roots[0];
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const turnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "ordered failure" } } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      turnEnd,
    ];
    host.emit("session/event", child.session, turnEnd);
    await flushAsyncWork();
    assert.equal(scheduler.timers.length, 1, "turn/end 先到时恢复必须先入队");
    const report = { id: "recovery-report-1", source: { kind: "subagent-report", senderSessionId: child.id } };
    const settlement = { id: "recovery-settlement-1", source: { kind: "subagent-settled", senderSessionId: child.id } };
    host.insertInbox(root, report);
    host.insertInbox(root, settlement);
    host.insertInbox(root, settlement);
    // B：legacy relay 没有 correlation id → 不得被当成可撤回结算，只作普通消息并留 warn。
    assert.equal(host.pendingInboxMessages.has(report.id), true, "legacy report 不得进入撤回/门控路径");
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.messageId === report.id).length, 0, "relay 不得被 remove");
    assert.ok(
      host.events.some((event) => event.type === "warn" && /legacy subagent-report feedback/.test(String(event.message))),
      "relay fail-closed 必须留下可诊断 warn",
    );
    assert.equal(host.pendingInboxMessages.has(settlement.id), false, "恢复未决时 settlement 不得进入 parent claim");
    assert.equal(host.events.filter((event) => event.type === "inbox/remove" && event.messageId === settlement.id).length, 2, "重复 inserted 必须各自撤回，不能让第二份残留");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：replacement child 只接管新 generation 的最终通知", async () => {
  const lifecycle = [];
  const replacementError = Object.assign(new Error("child cannot resume"), { code: "NOT_RESUMABLE" });
  const host = createStrictHost({
    providerReady: true,
    followupError: replacementError,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "rebuild recovery child", {
      affectedPaths: ["file:docs/recovery-replacement.md"],
    });
    const root = host.roots[0];
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const oldChild = host.childAgents.get(result.subagentId);
    const firstFailure = {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "error", error: { message: "old child failed" } } },
    };
    oldChild.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
      firstFailure,
    ];
    const oldNotice = { id: "old-child-failure", source: { kind: "subagent-settled", senderSessionId: oldChild.id } };
    host.insertInbox(root, oldNotice);
    host.emit("session/event", oldChild.session, firstFailure);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    const replacement = [...host.childAgents.values()].find((child) => child.id !== oldChild.id);
    assert.ok(replacement, "NOT_RESUMABLE 必须创建 replacement child");
    const replacementStart = host.events.find((event) => event.type === "startContinuable/call" && event.childId === replacement.id);
    assert.ok(replacementStart, "recovery rebuild 必须实际调用 startContinuable");
    assert.match(replacementStart.persona, /You are a leaf worker: never delegate or create other subagents/, "recovery rebuild 必须使用当前角色 persona");
    assert.match(replacementStart.persona, /deliver the result only in your final assistant output/, "recovery rebuild 必须保留最新最终输出纪律");
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 0, "旧 child notice 不得在 replacement 接管时交接");
    const replacementMessageId = "message-2";
    const replacementSuccess = {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    };
    replacement.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "user/message", data: { id: replacementMessageId, role: "user", content: [], source: { kind: "plugin" } } },
      { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "replacement recovered" }] } } },
      replacementSuccess,
    ];
    const replacementNotice = { id: "replacement-success", source: { kind: "subagent-settled", senderSessionId: replacement.id } };
    host.insertInbox(root, replacementNotice);
    assert.equal(host.pendingInboxMessages.has(replacementNotice.id), false, "replacement success 在 recovery op settle 前仍应门控");
    host.emit("session/event", replacement.session, replacementSuccess);
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 1);
    assert.equal(host.pendingInboxMessages.has(oldNotice.id), false, "旧 child notice 不得交给新任务");
    assert.equal(host.pendingInboxMessages.has(replacementNotice.id), true);
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：第六次失败才释放范围并交接唯一最终 settlement", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "exhaust recovery budget", {
      affectedPaths: ["file:docs/recovery-exhausted.md"],
    });
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "docs/recovery-exhausted.md" }, agent: root };
    const appendTurn = (turn, messageId) => {
      const end = { type: "turn/end", data: { turn, reason: { kind: "error", error: { message: "failure-" + turn } } } };
      child.session.events = [
        ...(Array.isArray(child.session.events) ? child.session.events : []),
        { type: "turn/start", data: { turn } },
        { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin" } } },
        end,
      ];
      return end;
    };
    for (let turn = 1; turn <= AUTO_RECOVERY_LIMIT + 1; turn += 1) {
      const messageId = turn === 1 ? "message-1" : host.followupMessageIds.at(-1);
      const turnEnd = appendTurn(turn, messageId);
      const notice = { id: "recovery-failure-notice-" + turn, source: { kind: "subagent-settled", senderSessionId: child.id } };
      host.insertInbox(root, notice);
      assert.equal(host.pendingInboxMessages.has(notice.id), false, "第 " + turn + " 次失败通知在结算前必须门控");
      host.emit("session/event", child.session, turnEnd);
      await flushAsyncWork();
      if (turn <= AUTO_RECOVERY_LIMIT) {
        assert.equal(scheduler.timers.length, turn, "前 " + AUTO_RECOVERY_LIMIT + " 次失败每次仅安排下一次恢复");
        assert.match(rootGuard(guardedRead), /overlaps active expert work/, "第 " + turn + " 次失败仍保护范围");
        scheduler.timers[turn - 1].callback();
        await flushAsyncWork();
      }
    }
    assert.equal(scheduler.timers.length, AUTO_RECOVERY_LIMIT, "第六次失败不得再安排 recovery timer");
    assert.equal(host.events.filter((event) => event.type === "followup").length, AUTO_RECOVERY_LIMIT);
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 1, "耗尽预算只重投递一次最终 settlement");
    assert.equal(rootGuard(guardedRead), undefined, "预算耗尽后必须先释放 exact activity");
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");
    assert.equal(host.pendingInboxMessages.has("recovery-failure-notice-6"), true);
    for (let turn = 1; turn <= AUTO_RECOVERY_LIMIT; turn += 1) {
      assert.equal(host.pendingInboxMessages.has("recovery-failure-notice-" + turn), false, "旧第 " + turn + " 次失败通知不得交接");
    }
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题4：恢复成功只交接成功通知并从零计数", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push("get"); return undefined; },
      pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "recover then succeed", {
      affectedPaths: ["file:docs/recovery-success.md"],
    });
    const root = host.roots[0];
    startFinalizeLifecycle(host, {
      admissionEpoch: result.admissionEpoch,
      admissionTokens: [result.admissionToken],
      summaryCompleted: true,
      outcomesChecked: true,
      safeParallelWork: false,
    }, { concludeTurn() {} });
    const child = host.childAgents.get(result.subagentId);
    const appendTurn = (turn, messageId, reason, text) => {
      const end = { type: "turn/end", data: { turn, reason } };
      child.session.events = [
        ...(Array.isArray(child.session.events) ? child.session.events : []),
        { type: "turn/start", data: { turn } },
        { type: "user/message", data: { id: messageId, role: "user", content: [], source: { kind: "plugin" } } },
        ...(text === undefined ? [] : [{ type: "assistant/message", data: { turn, message: { content: [{ type: "text", text }] } } }]),
        end,
      ];
      return end;
    };
    const failedNotice = { id: "recovery-failure-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    const firstFailure = appendTurn(1, "message-1", { kind: "error", error: { message: "temporary" } });
    host.insertInbox(root, failedNotice);
    assert.equal(host.pendingInboxMessages.has(failedNotice.id), false);
    host.emit("session/event", child.session, firstFailure);
    await flushAsyncWork();
    scheduler.timers[0].callback();
    await flushAsyncWork();
    const recoveryMessageId = host.followupMessageIds[0];
    const successNotice = { id: "recovery-success-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    const recoverySuccess = appendTurn(2, recoveryMessageId, { kind: "completed" }, "recovered");
    host.insertInbox(root, successNotice);
    assert.equal(host.pendingInboxMessages.has(successNotice.id), false, "恢复成功 notice 在 turn/end 结算前也必须先被门控");
    host.emit("session/event", child.session, recoverySuccess);
    await flushAsyncWork();
    assert.equal(host.pendingInboxMessages.has(failedNotice.id), false, "旧失败 notice 不得重新交接");
    assert.equal(host.pendingInboxMessages.has(successNotice.id), true, "只交接当前成功 settlement");
    assert.equal(host.events.filter((event) => event.type === "inbox/inject").length, 1);
    assert.deepEqual(lifecycle, [], "不得调用任何 goal API（等待由 root turn 保持实现）");

    const nextFailureNotice = { id: "recovery-next-failure-notice", source: { kind: "subagent-settled", senderSessionId: child.id } };
    const nextFailure = appendTurn(3, "message-3", { kind: "error", error: { message: "again" } });
    host.insertInbox(root, nextFailureNotice);
    assert.equal(host.pendingInboxMessages.has(nextFailureNotice.id), false, "成功后的新失败必须重新进入门控");
    host.emit("session/event", child.session, nextFailure);
    await flushAsyncWork();
    assert.equal(scheduler.timers.at(-1).delay, 2000, "成功后退避从 2 秒重新开始");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题3：成功 turn/end 在父 feedback 前释放活动范围，handoff 仍等 feedback 后 resume", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push(["get"]); return undefined; },
      pause: () => { lifecycle.push(["pause"]); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push(["resume"]); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const result = await executeRole(host, "explorer", "terminal scope before feedback", {
    affectedPaths: ["file:docs/terminal-scope.md"],
  });
  assert.equal(result.kind, "continuable");

  let concludeCalls = 0;
  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: result.admissionEpoch,
    admissionTokens: [result.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending", "专家未结束前 finalize 必须保持等待");
  assert.equal(concludeCalls, 0, "finalize 绝不主动 conclude root turn");
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");

  const child = host.childAgents.get(result.subagentId);
  const turnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
  child.session.events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { id: "message-1", role: "user", content: [], source: { kind: "plugin" } } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "done" }] } } },
    turnEnd,
  ];

  const rootGuard = host.rootToolGuards[0];
  const guardedRead = { name: "read", arguments: { file_path: "docs/terminal-scope.md" }, agent: root };
  assert.match(rootGuard(guardedRead), /overlaps active expert work/);
  host.emit("session/event", child.session, turnEnd);
  await flushAsyncWork();

  assert.equal(rootGuard(guardedRead), undefined, "正常终态必须在 report/feedback 注入前释放 exact activity");
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");

  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: "feedback-1", source: { kind: "subagent-settled", senderSessionId: child.id } },
  });
  await flushAsyncWork();
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  // 精确完成通知到达后，等待才收口；全程不调用 concludeTurn。
  assert.equal((await finalized.promise).kind, "finalized");
  assert.equal(concludeCalls, 0, "finalize 绝不调用 exec.concludeTurn()");
  host.dispose();
});

test("问题3：mixed handoff 与 continue admission 都在各自 turn/end 后释放范围", async () => {
  const lifecycle = [];
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
      get: () => { lifecycle.push(["get"]); return undefined; },
      pause: () => { lifecycle.push(["pause"]); throw new Error("goals.pause must never be called"); },
      resume: () => { lifecycle.push(["resume"]); throw new Error("goals.resume must never be called"); },
    },
  });
  activate(host);
  const root = host.createAgent();
  const handoff = await executeRole(host, "explorer", "mixed handoff admission", {
    affectedPaths: ["file:docs/mixed-handoff.md"],
  });
  assert.equal(handoff.kind, "continuable");
  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: handoff.admissionEpoch,
    admissionTokens: [handoff.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => {} });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending", "handoff admission 未结束前必须保持等待");
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");

  const continued = await executeRole(host, "explorer", "mixed continue admission", {
    continue_parent_turn: true,
    affectedPaths: ["file:docs/mixed-continue.md"],
  });
  assert.equal(continued.kind, "continuable");
  assert.equal(continued.accepted, true);
  const child = host.childAgents.get(handoff.subagentId);
  const startEvent = host.events.findLast((event) => event.type === "agent/created" && event.childId === child.id);
  assert.ok(startEvent?.messageId, "handoff admission 必须有独立稳定 messageId");
  // 多 child 语义：不同 prompt 的 continue admission 是**独立 child**，不是对既有 child 的
  // steer；因此它有自己的一条 agent/created，且全程不得出现 followup（steer）事件。
  const continueChildId = continued.subagentId;
  assert.notEqual(continueChildId, handoff.subagentId, "不同 prompt 必须新建独立 child");
  const continueChild = host.childAgents.get(continueChildId);
  const continueEvent = host.events.findLast((event) => event.type === "agent/created" && event.childId === continueChild.id);
  assert.ok(continueEvent?.messageId, "continue admission 必须有独立稳定 messageId");
  assert.equal(host.events.filter((event) => event.type === "followup").length, 0, "独立任务不得 steer 既有 child");

  const handoffTurnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
  const continueTurnEnd = { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } };
  child.session.events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "user/message", data: { id: startEvent.messageId, role: "user", content: [], source: { kind: "plugin" } } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "handoff done" }] } } },
    handoffTurnEnd,
  ];
  continueChild.session.events = [
    { type: "turn/start", data: { turn: 2 } },
    { type: "user/message", data: { id: continueEvent.messageId, role: "user", content: [], source: { kind: "plugin" } } },
    { type: "assistant/message", data: { turn: 2, message: { content: [{ type: "text", text: "continue done" }] } } },
    continueTurnEnd,
  ];

  const rootGuard = host.rootToolGuards[0];
  const handoffRead = { name: "read", arguments: { file_path: "docs/mixed-handoff.md" }, agent: root };
  const continueRead = { name: "read", arguments: { file_path: "docs/mixed-continue.md" }, agent: root };
  assert.match(rootGuard(handoffRead), /overlaps active expert work/);
  assert.match(rootGuard(continueRead), /overlaps active expert work/);

  host.emit("session/event", child.session, handoffTurnEnd);
  await flushAsyncWork();
  assert.equal(rootGuard(handoffRead), undefined, "handoff admission 的正常终态应先释放自身范围");
  assert.match(rootGuard(continueRead), /overlaps active expert work/, "continue admission 不得被其他 handoff token 的延迟遮蔽");
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");

  host.emit("session/event", continueChild.session, continueTurnEnd);
  await flushAsyncWork();
  assert.equal(rootGuard(continueRead), undefined, "mixed admission 的 continue turn 也应在 feedback 前释放范围");
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");

  // 只有 handoff admission 会登记 goal 等待原因（continue_parent_turn 的 admission
  // handoffExpected=false，root 继续本 turn，不暂停 goal），因此 handoff 这一侧的
  // settlement 到达后必须恰好 resume 一次。
  host.emit("agent/inbox/inserted", {
    agent: root,
    message: { id: "mixed-feedback", source: { kind: "subagent-settled", senderSessionId: child.id } },
  });
  await flushAsyncWork();
  assert.deepEqual(lifecycle.map(([kind]) => kind), [], "不得调用任何 goal API（等待由 root turn 保持实现）");
  // handoff 这一侧的精确结算到达后等待收口；continue_parent_turn 的 child 不登记等待工作，
  // 因此它不会阻塞（它的运行由 agent/turn-stopping 兜底路径负责）。
  assert.equal((await finalized.promise).kind, "finalized");
  host.dispose();
});

test("回归：身份监听器建立专家身份后必须补装 child tools.guard", async () => {
  const host = createStrictHost({ providerReady: true, delayAgentCreatedSetup: true });
  activate(host);
  host.createAgent();

  const result = await executeRole(host, "explorer", "agent created setup race");
  assert.equal(result.kind, "continuable");
  const child = host.childAgents.get(result.subagentId);
  assert.ok(child);
  assert.equal(child.options.__degExpertRole, "explorer", "后续身份监听器必须看到恢复后的 marker");
  assert.equal(host.childGuardOwners.length, 1, "专家身份建立后必须安装 scoped child guard");
  assert.equal(host.childGuardOwners[0].agent, child);
  assert.match(host.childGuardOwners[0].callback({ name: "send_message" }), /插件专家 child 禁止调用工具 send_message/);

  host.dispose();
});

test("A：单个 role 的同步 agent/created acceptance 返回有效 childId/messageId", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  const result = await executeRole(host, "explorer", "single child");
  assert.equal(result.kind, "continuable");
  assert.match(result.subagentId, /^child-\d+$/);
  assert.equal(host.childAgents.size, 1);
  assert.ok(host.agentGuardCount >= 2, "agent/created 必须把 report guard 安装到 child scoped tools");
  assert.equal(host.childGuardOwners.length, 1, "child guard 必须绑定到该 child 的 scoped tools");
  assert.equal(host.childGuardOwners[0].agent, host.childAgents.get(result.subagentId));
  assert.equal(host.registeredGuards.length, 1, "apply 必须只安装一个全局交付 guard");
  const globalGuard = host.registeredGuards[0];
  const child = host.childAgents.get(result.subagentId);
  const globalSendMessageDenial = globalGuard({ name: "send_message", agent: child });
  assert.equal(typeof globalSendMessageDenial, "string", "global guard 必须拒绝插件 child send_message");
  assert.match(globalSendMessageDenial, /subagent-settled/);
  assert.match(globalGuard({ name: "send_message", agent: child, nested: true }), /最终 assistant/);
  assert.equal(globalGuard({ name: "send_message", agent: host.roots[0] }), undefined, "root agent 必须放行");
  assert.equal(globalGuard({ name: "send_message", agent: { options: {}, session: { header: { parentSession: "root-test" } } } }), undefined, "非插件 child 必须放行");
  assert.equal(globalGuard({
    name: "send_message",
    agent: { options: { __degExpertRole: "fixer", __degExpertParent: "root-test", __degExpertContinuable: true }, session: { header: { parentSession: "root-test", origin: "subagent" } } },
  }), undefined, "未登记但 metadata 完整的普通 subagent 必须放行");
  assert.equal(globalGuard({
    name: "send_message",
    agent: { options: { __degExpertRole: "fixer", __degExpertParent: "root-test", __degExpertContinuable: true }, session: { header: { parentSession: "root-test" } } },
  }), undefined, "未登记且 origin 缺失的普通 child 必须放行");
  assert.equal(globalGuard({
    name: "send_message",
    agent: { options: { __degExpertRole: "fixer", __degExpertParent: "other-root", __degExpertContinuable: true }, session: { header: { parentSession: "root-test" } } },
  }), undefined, "lineage 不匹配必须放行");
  const childGuard = host.childGuardOwners[0].callback;
  const sendMessageDenial = childGuard({ name: "send_message" });
  assert.equal(typeof sendMessageDenial, "string", "实际 child guard 必须拒绝 send_message");
  assert.match(sendMessageDenial, /插件专家 child 禁止调用工具 send_message/);
  assert.equal(childGuard({ name: "read" }), undefined, "实际 child guard 不得阻止正常工具");
  assert.match(childGuard({ name: "report" }), /report/);
  const lifecycle = host.events.filter((item) => item.childId === "child-1");
  assert.deepEqual(lifecycle.map((item) => item.type), ["startContinuable/call", "agent/created", "startContinuable/resolve"]);
  assert.equal(lifecycle[1].pendingBeforeResolve, true);
  assert.equal(lifecycle[0].task.split("\n", 1)[0], "你是 explorer 子代理。");
  assert.equal(lifecycle[0].task.split("\n").length, 2);
  assert.match(lifecycle[0].task, /任务内容：single child/);
  assert.doesNotMatch(lifecycle[0].task, /请使用中文|禁止调用 send_message|不得通过 run_code 间接调用 send_message|叶子子代理/);
  assert.equal(typeof lifecycle[0].persona, "string", "真实 startContinuable request 必须携带 child persona");
  assert.match(lifecycle[0].persona, /You are a leaf worker: never delegate or create other subagents/);
  assert.match(lifecycle[0].persona, /Never call send_message directly, and never reach it indirectly through run_code/);
  assert.match(lifecycle[0].persona, /do not proactively message your parent/);
  assert.match(lifecycle[0].persona, /deliver the result only in your final assistant output/);
  assert.doesNotMatch(lifecycle[0].task, /You are the Explorer|You are a leaf worker/,
    "persona 不得被拼进 legacy 任务消息");
  assert.ok(lifecycle[0].deny.includes("send_message"), "专家 child filter 必须显式隐藏 send_message");
  assert.equal(typeof lifecycle[1].messageId, "string");
  const hostServiceMessageId = await host.context.subagents.sendMessage(host.roots[0], child.id, "host service continuation");
  assert.match(hostServiceMessageId, /^followup-child-\d+-\d+$/);
  host.emit("agent/disposed", { agent: child });
  assert.equal(host.childGuardOwners.length, 0, "agent/disposed 必须精确释放 child guard");
  host.dispose();
  assert.equal(host.registeredGuards.length, 0, "插件 dispose 必须清理全局交付 guard");
});

test("B：同一 role 的连续调用保持串行并安全复用", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  const first = await executeRole(host, "explorer", "first child");
  const second = await executeRole(host, "explorer", "first child");
  assert.ok(first.subagentId);
  assert.ok(second.subagentId);
  assert.equal(second.reused, true);
  assert.equal(second.subagentId, first.subagentId);
  assert.equal(host.childAgents.size, 1);
  assert.equal(host.events.filter((item) => item.type === "agent/created").length, 1);
  assert.equal(host.events.filter((item) => item.type === "steer").length, 0);
  assert.doesNotMatch(host.events.filter((item) => item.type === "warn").map((item) => String(item.message)).join("\n"), /Cannot set properties of undefined/);
});

test("C：不同 role 与相同 role 的并发创建均不丢失 acceptance", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  const results = await Promise.all([
    executeRole(host, "explorer", "parallel explorer", { affectedPaths: ["packages/explorer/"] }),
    executeRole(host, "observer", "parallel observer", { affectedPaths: ["packages/observer/"] }),
    executeRole(host, "explorer", "parallel explorer second", { affectedPaths: ["packages/explorer-2/"] }),
  ]);
  assert.equal(results.length, 3);
  for (const result of results) {
    assert.equal(result.kind, "continuable");
    assert.match(result.subagentId, /^child-\d+$/);
  }
  // 多 child 语义：explorer 的两次不同 prompt 各自新建独立 child（不再 steer 到第一个），
  // observer 是另一个 role，因此并发创建共 3 个 child，且没有任何 followup（steer）事件。
  assert.equal(host.childAgents.size, 3);
  const accepted = host.events.filter((item) => item.type === "agent/created");
  assert.equal(accepted.length, 3);
  assert.ok(accepted.every((item) => /^child-\d+$/.test(item.childId) && /^message-\d+$/.test(item.messageId)));
  assert.equal(new Set(accepted.map((item) => item.childId)).size, 3, "每个独立任务必须有自己的 childId");
  const followups = host.events.filter((item) => item.type === "followup");
  assert.deepEqual(followups, [], "不同 prompt 不得被投递到既有 child");
  assert.doesNotMatch(host.events.filter((item) => item.type === "warn").map((item) => String(item.message)).join("\n"), /Cannot set properties of undefined/);
});

test("C1：不同 role 的 acceptance 各自等待独立 barrier 并绑定正确 child", async () => {
  const host = createStrictHost({ providerReady: true, startMode: "per-call-deferred" });
  activate(host);
  host.createAgent();
  const explorerPromise = executeRole(host, "explorer", "交错 explorer", { affectedPaths: ["scope/explorer/"] });
  const observerPromise = executeRole(host, "observer", "交错 observer", { affectedPaths: ["scope/observer/"] });
  await host.allStartBarriers;
  assert.equal(host.startBarriers.length, 2);
  assert.equal(host.startBarriers.every((barrier) => typeof barrier.childId === "string"), true);
  assert.equal(host.events.filter((item) => item.type === "agent/created").length, 2);
  let explorerDone = false;
  let observerDone = false;
  explorerPromise.then(() => { explorerDone = true; });
  observerPromise.then(() => { observerDone = true; });
  const explorerBarrier = host.startBarriers.find((barrier) => barrier.role === "explorer");
  const observerBarrier = host.startBarriers.find((barrier) => barrier.role === "observer");
  assert.ok(explorerBarrier);
  assert.ok(observerBarrier);
  explorerBarrier.release();
  const explorer = await explorerPromise;
  explorerDone = true;
  assert.equal(explorerDone, true);
  assert.equal(observerDone, false);
  observerBarrier.release();
  const observer = await observerPromise;
  observerDone = true;
  assert.equal(explorer.kind, "continuable");
  assert.equal(observer.kind, "continuable");
  assert.equal(explorer.subagentId, explorerBarrier.childId);
  assert.equal(observer.subagentId, observerBarrier.childId);
  assert.notEqual(explorer.subagentId, observer.subagentId);
  const accepted = host.events.filter((item) => item.type === "agent/created");
  assert.deepEqual(accepted.map((item) => [item.role, item.task.includes(`任务内容：交错 ${item.role}`)]).sort(), [["explorer", true], ["observer", true]].sort());
  const acceptedByRole = new Map(accepted.map((item) => [item.role, item]));
  assert.equal(acceptedByRole.get("explorer")?.childId, explorer.subagentId);
  assert.match(acceptedByRole.get("explorer")?.messageId ?? "", /^message-\d+$/);
  assert.equal(acceptedByRole.get("observer")?.childId, observer.subagentId);
  assert.match(acceptedByRole.get("observer")?.messageId ?? "", /^message-\d+$/);
  assert.notEqual(acceptedByRole.get("explorer")?.messageId, acceptedByRole.get("observer")?.messageId);
  assert.equal(host.childAgents.size, 2);
  assert.doesNotMatch(host.events.filter((item) => item.type === "warn").map((item) => String(item.message)).join("\n"), /Cannot set properties of undefined/);
});

test("C2：范围冲突在 child 启动前返回 advisory，独立 role 才能并行", async () => {
  const host = createStrictHost({ providerReady: true, startMode: "deferred" });
  activate(host);
  host.createAgent();
  const firstPromise = executeRole(host, "explorer", "active scope", { affectedPaths: ["dir:src/shared"] });
  await host.startEntered;
  const conflict = await executeRole(host, "observer", "overlapping scope", { affectedPaths: ["file:src/shared/item.js"] });
  assert.equal(conflict.kind, "advisory");
  assert.match(conflict.warning, /Affected-path conflict advisory/);
  assert.equal(host.childAgents.size, 0);
  host.releaseStart();
  const first = await firstPromise;
  assert.equal(first.kind, "continuable");
  assert.equal(host.childAgents.size, 1);
});

test("C3：accepted 必须等待同 root batch 的 delayed scope-conflict outcome", async () => {
  let listModelsCalls = 0;
  let releaseDelayedSelection;
  const delayedSelection = new Promise((resolve) => { releaseDelayedSelection = resolve; });
  const host = createStrictHost({
    providerReady: true,
    goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  },
    llmOverrides: {
      listModels: async () => {
        listModelsCalls += 1;
        if (listModelsCalls === 2) await delayedSelection;
        return [{ id: "mock" }];
      },
    },
  });
  activate(host);
  host.createAgent();
  let concludeCalls = 0;
  const firstPromise = executeRoleWithExec(host, "explorer", "accepted scope", {
    affectedPaths: ["dir:src/shared"],
  }, { concludeTurn: () => { concludeCalls += 1; } });
  const conflictPromise = executeRoleWithExec(host, "observer", "rejected scope", {
    affectedPaths: ["file:src/shared/item.js"],
  });

  await flushAsyncWork();
  assert.equal(listModelsCalls, 2);
  const firstBeforeRelease = await firstPromise;
  const early = await executeFinalize(host, {
    admissionEpoch: firstBeforeRelease.admissionEpoch,
    admissionTokens: [firstBeforeRelease.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  // 票据 10：收口集合由服务端枚举，token 只做诊断；此刻第二个 admission 还没有 settle
  // （delayed selection），因此真正的拒绝原因是结果未返回，而不是「token 集不完整」。
  assert.equal(early.kind, "rejected");
  assert.equal(early.reason, "admission-outcome-pending");
  assert.ok(early.message.length > 0, "拒绝必须带可执行 message");
  assert.equal(concludeCalls, 0, "仍有未返回结果的 admission 时不得 pause/conclude");

  releaseDelayedSelection();
  const conflict = await conflictPromise;
  assert.deepEqual(
    { started: conflict.started, accepted: conflict.accepted, reason: conflict.reason, code: conflict.code },
    { started: false, accepted: false, reason: "scope-conflict", code: "SCOPE_CONFLICT" },
  );
  const first = firstBeforeRelease;
  assert.equal(first.started, true);
  assert.equal(first.accepted, true);
  assert.equal(concludeCalls, 0, "role execute 只返回结果，不得自动 conclude");
  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: first.admissionEpoch,
    admissionTokens: [first.admissionToken, conflict.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending", "专家未结束前 finalize 必须保持等待");
  assert.equal(concludeCalls, 0, "finalize 绝不主动 conclude root turn");

  await completeChildAdmission(host, first);
  const settled = await finalized.promise;
  assert.equal(settled.kind, "finalized");
  assert.equal(settled.acceptedCount, 1);
  assert.equal("paused" in settled, false, "回执不得再带 paused");
  assert.equal("concluded" in settled, false, "回执不得再带 concluded");
  assert.equal(concludeCalls, 0, "finalize 绝不调用 exec.concludeTurn()");
  assert.equal(host.childAgents.size, 1);
  host.dispose();
});

test("C4：全部 scope-conflict rejected 不会 pause/conclude，continue=true 也不收口", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const accepted = await executeRoleWithExec(host, "explorer", "active scope for rejection", {
    affectedPaths: ["dir:src/shared"],
  });
  assert.equal(accepted.accepted, true);

  let concludeCalls = 0;
  const rejected = await Promise.all([
    executeRoleWithExec(host, "observer", "rejected observer scope", {
      affectedPaths: ["file:src/shared/observer.js"],
    }, { concludeTurn: () => { concludeCalls += 1; } }),
    executeRoleWithExec(host, "librarian", "rejected librarian scope", {
      affectedPaths: ["file:src/shared/librarian.js"],
    }, { concludeTurn: () => { concludeCalls += 1; } }),
  ]);
  assert.equal(rejected.every((item) => item.started === false && item.accepted === false && item.code === "SCOPE_CONFLICT"), true);
  assert.equal(concludeCalls, 0, "全部 rejected 只返回 advisory，不应 conclude");
  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken, ...rejected.map((item) => item.admissionToken)],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending");
  await completeChildAdmission(host, accepted);
  const settled = await finalized.promise;
  assert.equal(settled.kind, "finalized", settled.reason);
  assert.equal(settled.acceptedCount, 1, "rejected admission 计入 token 集但不计入 acceptedCount");
  assert.equal(concludeCalls, 0);

  const independent = await executeRoleWithExec(host, "librarian", "explicit independent task", {
    continue_parent_turn: true,
    affectedPaths: ["docs/independent.md"],
  }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(independent.started, true);
  assert.equal(independent.accepted, true);
  assert.equal(concludeCalls, 0, "continue_parent_turn=true 也不得触发收口");
  host.dispose();
});

test("C5：多个 accepted 由 root finalize 一次性登记等待，重复 finalize 在收口中拒绝", async () => {
  const lifecycle = [];
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => { lifecycle.push("get"); return undefined; },
    pause: () => { lifecycle.push("pause"); throw new Error("goals.pause must never be called"); },
    resume: () => { lifecycle.push("resume"); throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const [first, second] = await Promise.all([
    executeRole(host, "explorer", "multi accepted explorer", { affectedPaths: ["docs/first.md"] }),
    executeRole(host, "observer", "multi accepted observer", { affectedPaths: ["docs/second.md"] }),
  ]);
  assert.equal(first.accepted, true);
  assert.equal(second.accepted, true);
  assert.equal(first.admissionEpoch, second.admissionEpoch);
  let concludeCalls = 0;
  const finalizationArgs = {
    admissionEpoch: first.admissionEpoch,
    admissionTokens: [first.admissionToken, second.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  };
  const unsafe = await executeFinalize(host, { ...finalizationArgs, safeParallelWork: true }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(unsafe.kind, "rejected");
  assert.equal(unsafe.reason, "safe-parallel-work-remains");
  const unchecked = await executeFinalize(host, { ...finalizationArgs, outcomesChecked: false }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(unchecked.kind, "rejected");
  assert.equal(unchecked.reason, "summary-or-outcome-check-required");
  assert.equal(concludeCalls, 0);
  const finalized = startFinalizeLifecycle(host, finalizationArgs, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending", "两个 accepted 都未结束时必须保持等待");
  assert.equal(concludeCalls, 0);
  // 同一批次的重复**合法** finalize：返回稳定的 waiting（不重复登记、不关闭、不投递），
  // 绝不允许把「已登记等待」误当成可重试的失败。
  const duplicate = await executeFinalize(host, finalizationArgs, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(duplicate.kind, "waiting");
  assert.equal(duplicate.reason, "experts-running");
  assert.equal(duplicate.acceptedCount, 2, "重复回执必须与首次一致");
  assert.equal(host.steerMessages(host.roots[0]).length, 0, "重复调用不得提前投递终态结论");
  // waiting 回执的模型可见文案必须写明「纯文本回复会关闭 turn」，否则模型会把等待
  // 当成收尾信号；渲染通过公开工具定义的 output.render 读取，不新造内部导出。
  const waitingRendered = host.registeredTools.get("dsh_expert_group_finalize").output.render(null, duplicate)
    .map((block) => block.text).join("\n");
  assert.match(waitingRendered, /a reply without a tool call closes it/);

  // 第一个 child 的精确结算 → 逐 child 进度放行：本次 turn-stopping 的等待收口
  // （宿主会在同一 turn 的下一个 step 消费该 settlement），但不投递结论、批次不关闭。
  await completeChildAdmission(host, first, { messageId: "message-1", feedbackId: "feedback-1" });
  assert.equal(finalized.status, "resolved", "第一个 child 的精确结算必须逐 child 进度放行");
  assert.notEqual(finalized.value.kind, "finalized", "只完成一个 child 时不得投递终态结论");
  assert.equal(host.steerMessages(host.roots[0]).length, 0, "进度放行绝不投递结论");

  // 同一 turn 下一个 step 之后的 turn 边界：第二个 child 仍未结束 → 继续等待。
  const remaining = stopRootTurn(host, 2);
  assert.equal(remaining.pending, 1, "剩余 child 必须让新边界继续等待");
  let remainingResolved = false;
  remaining.settled.then(() => { remainingResolved = true; });
  await flushAsyncWork();
  assert.equal(remainingResolved, false, "第二个 child 仍未结束：不得放行");

  await completeChildAdmission(host, second, { messageId: "message-2", feedbackId: "feedback-2" });
  await remaining.settled;
  assert.equal(remainingResolved, true, "整批静止后必须放行");
  // 收口结论必须要求模型继续调用工具：纯文本回复会直接结束 root turn。
  const conclusionMessages = host.steerMessages(host.roots[0]);
  assert.equal(conclusionMessages.length, 1, "收口后必须一次性投递终态结论");
  const conclusionText = conclusionMessages[0].content.map((block) => block.text).join("");
  assert.match(conclusionText, /acceptedCount 2/, "收口结论必须表达整批 acceptedCount");
  assert.match(conclusionText, new RegExp("admissionEpoch " + first.admissionEpoch));
  assert.match(conclusionText, /Continue the task from here now by calling the next tool/);
  assert.match(conclusionText, /a reply without a tool call ends the turn/);
  assert.equal(concludeCalls, 0, "finalize 绝不调用 exec.concludeTurn()");
  assert.deepEqual(lifecycle, [], "finalize 绝不调用任何 goal API");
  host.dispose();
});

test("C6：finalize 只允许当前 live root agent 调用（root-only 回执，不抛异常）", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  const root = host.createAgent();
  const definition = host.registeredTools.get("dsh_expert_group_finalize");
  assert.ok(definition);
  const receipt = await definition.execute({
    admissionEpoch: 0,
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { agent: { id: "child-finalizer", session: { header: { parentSession: root.id } } } });
  // 票据 10：错误 root 拿到结构化 rejected 回执（稳定 reason + 可执行 message），
  // 不再以异常文本收场，调用方可以按 reason 恢复。
  assert.equal(receipt.kind, "rejected");
  assert.equal(receipt.reason, "root-only");
  assert.ok(receipt.message.length > 0, "root-only 拒绝必须带可执行 message");
  host.dispose();
});

test("C7：admission failure 返回 token 且清理 scope，后续同范围不会变成冲突", async () => {
  const host = createStrictHost({ providerReady: true, startMode: "throw" });
  activate(host);
  host.createAgent();
  const failed = await executeRole(host, "explorer", "failed start cleanup", { affectedPaths: ["file:cleanup.js"] });
  assert.equal(failed.kind, "failure");
  assert.equal(failed.started, false);
  assert.equal(failed.accepted, false);
  assert.equal(failed.code, "START_FAILED");
  assert.equal(typeof failed.admissionToken, "string");
  const retried = await executeRole(host, "observer", "retry after failed start", { affectedPaths: ["file:cleanup.js"] });
  assert.equal(retried.kind, "failure");
  assert.notEqual(retried.code, "SCOPE_CONFLICT");
  assert.notEqual(retried.reason, "scope-conflict");
  host.dispose();
});

test("C8：finalize 关闭旧 epoch 后，迟到 admission 创建新 epoch 且旧 token 被拒绝", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const first = await executeRole(host, "explorer", "first epoch task", { affectedPaths: ["docs/epoch-first.md"] });
  let concludeCalls = 0;
  const firstArgs = {
    admissionEpoch: first.admissionEpoch,
    admissionTokens: [first.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  };
  const firstFinalized = startFinalizeLifecycle(host, firstArgs, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(firstFinalized.status, "pending");
  await completeChildAdmission(host, first, { messageId: "message-1", feedbackId: "feedback-1" });
  assert.equal((await firstFinalized.promise).kind, "finalized");
  const late = await executeRole(host, "observer", "new epoch task", { affectedPaths: ["docs/epoch-second.md"] });
  assert.equal(late.accepted, true);
  assert.ok(late.admissionEpoch > first.admissionEpoch);
  const stale = await executeFinalize(host, firstArgs, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(stale.kind, "rejected");
  assert.equal(stale.reason, "admission-epoch-mismatch");
  assert.equal(concludeCalls, 0);
  const secondFinalized = startFinalizeLifecycle(host, {
    admissionEpoch: late.admissionEpoch,
    admissionTokens: [late.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  await completeChildAdmission(host, late, { messageId: "message-2", feedbackId: "feedback-2" });
  assert.equal((await secondFinalized.promise).kind, "finalized");
  assert.equal(concludeCalls, 0);
  host.dispose();
});

test("C10：continue_parent_turn admission 阻止纯 continue 批次 finalize，但不阻塞后续普通收口", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const continued = await executeRole(host, "explorer", "continue mode must remain open", {
    continue_parent_turn: true,
    affectedPaths: ["docs/continue-open.md"],
  });
  assert.equal(continued.accepted, true);
  let concludeCalls = 0;
  const blocked = await executeFinalize(host, {
    admissionEpoch: continued.admissionEpoch,
    admissionTokens: [continued.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(blocked.kind, "rejected");
  assert.equal(blocked.reason, "continue-parent-turn");
  assert.equal(concludeCalls, 0);

  const accepted = await executeRole(host, "observer", "close after parallel work", {
    affectedPaths: ["docs/continue-close.md"],
  });
  assert.equal(accepted.accepted, true);
  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [continued.admissionToken, accepted.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending", "后台运行的 continue_parent_turn child 同样让 root 保持打开");
  // 纯 continue_parent_turn 的 child 是**后台运行**的后代：权威 listing 会如实把它报告为
  // running，因此它也让 root 保持打开（与 root-turn-wait 的 turn-stopping 兜底用例同一语义）。
  // 只有它自己的 turn 也结束后静止才成立——这一点以前被 strict host 的假 waterfall 掩盖。
  const continuedChild = host.childAgents.get(continued.subagentId);
  assert.ok(continuedChild, "continue admission 必须有对应的 child agent");
  const continuedTurnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
  continuedChild.session.events = [
    { type: "turn/start", data: { turn: 1 } },
    { type: "assistant/message", data: { turn: 1, message: { content: [{ type: "text", text: "continue done" }] } } },
    continuedTurnEnd,
  ];
  host.emit("session/event", continuedChild.session, continuedTurnEnd);
  await flushAsyncWork();
  await completeChildAdmission(host, accepted, { messageId: "message-2", feedbackId: "feedback-2" });
  const settled = await finalized.promise;
  assert.equal(settled.kind, "finalized");
  assert.equal(settled.acceptedCount, 1, "continue_parent_turn 计入 token 集但不计入 acceptedCount");
  assert.equal(concludeCalls, 0);
  host.dispose();
});

test("C9：独立 rejected admission 批次 finalize 为 no-op 且不改变已收口次数", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  let concludeCalls = 0;
  // 批次里只有 failure 结果（fixer 未配置模型）：没有任何 accepted admission 需要等待，
  // 因此 finalize 必须立刻以 no-accepted-admission 收口，既不等待也不 conclude。
  const rejected = await Promise.all([
    executeRole(host, "fixer", "all rejected fixer"),
    executeRole(host, "designer", "all rejected designer"),
  ]);
  assert.equal(rejected.every((item) => item.kind === "failure" && item.accepted === false), true);
  assert.equal(rejected.every((item) => typeof item.admissionToken === "string"), true);
  const noOp = await executeFinalize(host, {
    admissionEpoch: rejected[0].admissionEpoch,
    admissionTokens: rejected.map((item) => item.admissionToken),
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(noOp.kind, "noop", noOp.reason + " / " + String(noOp.message));
  assert.equal(noOp.reason, "no-accepted-admission");
  assert.equal(concludeCalls, 0);
  host.dispose();
});

test("acceptance ordering contract：dependent 已安排但必须等待 prerequisite settle/report", async () => {
  const host = createStrictHost({ providerReady: true, startMode: "deferred" });
  activate(host);
  host.createAgent();
  let dependentScheduled = false;
  let dependentStarted = false;
  let prerequisiteReportReturned = false;
  const prerequisite = executeRole(host, "explorer", "prerequisite task", { affectedPaths: ["docs/prerequisite.md"] });
  const prerequisiteReport = (async () => {
    const result = await prerequisite;
    assert.equal(result.kind, "continuable");
    prerequisiteReportReturned = true;
    return { status: "settled", result };
  })();
  const dependent = (async () => {
    dependentScheduled = true;
    const report = await prerequisiteReport;
    assert.equal(report.status, "settled");
    dependentStarted = true;
    return executeRole(host, "observer", "dependent task", { affectedPaths: ["docs/dependent.md"] });
  })();
  await host.startEntered;
  // 测试 seam 先安排 dependent；实际插件没有独立依赖图 API，因此这里只验证 acceptance ordering contract。
  assert.equal(dependentScheduled, true);
  assert.equal(dependentStarted, false);
  assert.equal(prerequisiteReportReturned, false);
  assert.equal(host.events.some((item) => item.type === "agent/created"), false);
  host.releaseStart();
  const report = await prerequisiteReport;
  assert.equal(report.status, "settled");
  assert.equal(prerequisiteReportReturned, true);
  assert.equal(dependentStarted, true);
  const dependentResult = await dependent;
  assert.equal(dependentResult.kind, "continuable");
  assert.equal(host.childAgents.size, 2);
});

test("strict lifecycle harness rejects the legacy cwd access and rolls back", () => {
  const host = createStrictHost();
  activate(host);

  // 这就是旧版 workspaceRootForStructuredGuard 的危险读取；若 harness 不在
  // agent/created 的同步回滚接缝执行，这个负向探针会错误地变绿。
  host.on("agent/created", () => host.context.cwd);

  assert.throws(() => host.createAgent("legacy-cwd"), (error) => {
    assert.match(String(error), /cannot get property \"cwd\" without inject/);
    return true;
  });
  assert.equal(host.roots.length, 0);
});

test("agent/request-error：root 与专家 child 只对结构化瞬态错误重试并有界去重", async () => {
  // forbidResendApis：本次用例的 root/child 都禁止访问非公开重发 API，
  // 一旦插件改用 Session.prompt / Agent.steer，下面的行为断言就会真实失败。
  const host = createStrictHost({ providerReady: true, forbidResendApis: true });
  activate(host);
  const hostRetryCounts = new Map();
  const hostRetryListenerDispose = host.on("agent/request-error", (payload) => {
    const policy = payload?.retryPolicy;
    const code = payload?.failure?.code;
    const ownsCode = policy?.mode === "always"
      || (policy?.mode === "normal" && Array.isArray(policy?.retryableCodes) && policy.retryableCodes.includes(code));
    if (!ownsCode) return void 0;
    const maxRetries = Number.isSafeInteger(policy?.maxRetries) && policy.maxRetries >= 0 ? policy.maxRetries : AUTO_RECOVERY_LIMIT;
    const key = [payload?.agent?.id, payload?.turn, payload?.step].join(":");
    const count = hostRetryCounts.get(key) ?? 0;
    if (count >= maxRetries) return void 0;
    hostRetryCounts.set(key, count + 1);
    return { kind: "retry" };
  });
  const root = host.createAgent();
  const signal = new AbortController().signal;
  const normalPolicy = { mode: "normal", maxRetries: AUTO_RECOVERY_LIMIT, retryableCodes: ["SERVER", "RATE_LIMIT", "TIMEOUT", "TRANSPORT", "EMPTY_RESPONSE"] };
  const upstreamPolicy = { mode: "normal", maxRetries: AUTO_RECOVERY_LIMIT, retryableCodes: ["upstream_unavailable"] };
  const fakeClock = {
    timers: [],
    schedule(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      this.timers.push(timer);
      return timer;
    },
    clear(timer) {
      if (timer) timer.cancelled = true;
    },
    fireNext() {
      let timer;
      while (this.timers.length > 0) {
        timer = this.timers.shift();
        if (timer.cancelled) continue;
        timer.callback();
        return timer;
      }
      return timer;
    },
  };
  const request = (agent, turn, step, failure, retryPolicy = normalPolicy) => ({
    agent,
    turn,
    step,
    provider: "mock",
    failure,
    retryPolicy,
    signal,
  });
  const originalRequestSetTimeout = globalThis.setTimeout;
  const originalRequestClearTimeout = globalThis.clearTimeout;
  try {
    globalThis.setTimeout = (callback, delay) => fakeClock.schedule(callback, delay);
    globalThis.clearTimeout = (timer) => fakeClock.clear(timer);

  const firstRoot = request(root, 1, 1, { code: "SERVER", message: "temporary" });
  assert.deepEqual(await host.waterfall("agent/request-error", firstRoot), { kind: "retry" }, "root 瞬态错误返回 retry");
  assert.equal(await host.waterfall("agent/request-error", firstRoot), undefined, "同一 payload 不得重复 retry");

  host.emit("session/event", root.session, { type: "step/end", data: { turn: 1, step: 1 } });
  await flushAsyncWork();
  assert.deepEqual(await host.waterfall("agent/request-error", request(root, 1, 1, { code: "SERVER" })), { kind: "retry" }, "成功 step/end 后请求计数清理");

  assert.deepEqual(
    await host.waterfall("agent/request-error", request(root, 6, 1, {
      code: "SERVER",
      message: "host-managed",
    }),),
    { kind: "retry" },
    "Host llm-retry 已返回 retry 时插件只复用一个 action",
  );

  const smallHostPolicy = { mode: "normal", maxRetries: 2, retryableCodes: ["SERVER"] };
  assert.deepEqual(await host.waterfall("agent/request-error", request(root, 7, 1, { code: "SERVER", attempt: 1 }, smallHostPolicy)), { kind: "retry" }, "Host 小上限第 1 次 retry");
  assert.deepEqual(await host.waterfall("agent/request-error", request(root, 7, 1, { code: "SERVER", attempt: 2 }, smallHostPolicy)), { kind: "retry" }, "Host 小上限第 2 次 retry");
  assert.equal(await host.waterfall("agent/request-error", request(root, 7, 1, { code: "SERVER", attempt: 3 }, smallHostPolicy)), undefined, "Host maxRetries 耗尽后插件不得补 retry");

  for (let retry = 0; retry < AUTO_RECOVERY_LIMIT; retry += 1) {
    assert.deepEqual(
      await host.waterfall("agent/request-error", request(root, 2, 1, { code: "RATE_LIMIT", status: 429 })),
      { kind: "retry" },
      "未达到 5 次上限前继续重试",
    );
  }
  assert.equal(
    await host.waterfall("agent/request-error", request(root, 2, 1, { code: "RATE_LIMIT", status: 429 })),
    undefined,
    "达到 5 次请求级重试上限后结束 turn",
  );

  assert.deepEqual(
    await host.waterfall("agent/request-error", request(root, 4, 1, { code: "upstream_unavailable", message: "provider unavailable" }, upstreamPolicy)),
    { kind: "retry" },
    "仅结构化 upstream_unavailable code 命中",
  );
  const structuredRetryCodes = ["AUTH", "UNAUTHORIZED", "FORBIDDEN", "INVALID_REQUEST", "BAD_REQUEST", "NO_PROVIDER", "NO_ADAPTER", "UNKNOWN_MODEL", "MODEL_NOT_FOUND"];
  for (let index = 0; index < structuredRetryCodes.length; index += 1) {
    const payload = request(root, 20 + index, 1, { code: structuredRetryCodes[index], message: "structured transient" }, { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] });
    const retryPromise = host.waterfall("agent/request-error", payload);
    await flushAsyncWork();
    assert.equal(fakeClock.timers.some((timer) => !timer.cancelled), true, "结构化错误应安排可控退避: " + structuredRetryCodes[index]);
    fakeClock.fireNext();
    assert.deepEqual(await retryPromise, { kind: "retry" }, "结构化错误应在退避后 retry: " + structuredRetryCodes[index]);
  }
  const structuredLimitPolicy = { mode: "normal", maxRetries: 1, retryableCodes: ["AUTH"] };
  assert.deepEqual(await host.waterfall("agent/request-error", request(root, 50, 1, { code: "AUTH" }, structuredLimitPolicy)), { kind: "retry" }, "Host 覆盖结构化错误时复用 retry");
  assert.equal(await host.waterfall("agent/request-error", request(root, 50, 1, { code: "AUTH" }, structuredLimitPolicy)), undefined, "Host maxRetries 耗尽后结构化错误不得补 retry");
  assert.equal(
    await host.waterfall("agent/request-error", request(root, 5, 1, { code: "OTHER", message: "upstream_unavailable" })),
    undefined,
    "仅错误文本包含 upstream_unavailable 不得猜测重试",
  );
  const fallbackController = new AbortController();
  const fallbackPayload = request(root, 8, 1, { code: "PI_AI_ERROR", message: "upstream_stream_incomplete: Upstream response ended before completion", providerRetryAfterMs: 7000 }, { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] });
  fallbackPayload.signal = fallbackController.signal;
  const fallbackPromise = host.waterfall("agent/request-error", fallbackPayload);
  await flushAsyncWork();
  assert.equal(fakeClock.timers[0]?.delay, 2000, "provider retry-after 不能超过现有第 1 次退避预算");
  assert.equal(await Promise.race([fallbackPromise, Promise.resolve("pending")]), "pending", "fallback 必须等待退避而非立即 retry");
  fakeClock.fireNext();
  assert.deepEqual(await fallbackPromise, { kind: "retry" }, "PI_AI_ERROR 瞬态流中断在退避后 retry");

  const abortController = new AbortController();
  const abortPayload = request(root, 9, 1, { code: "PI_AI_ERROR", message: "network error" }, { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] });
  abortPayload.signal = abortController.signal;
  const abortPromise = host.waterfall("agent/request-error", abortPayload);
  await flushAsyncWork();
  abortController.abort();
  assert.equal(await abortPromise, undefined, "AbortSignal 取消 fallback 不得伪造 retry");

  const transientMessages = [
    "upstream_stream_incomplete: Upstream response ended before completion",
    "upstream_unavailable: provider unavailable",
    "stream ended before completion",
    "network error",
    "ECONNRESET",
    "other side closed",
    "HTTP2 request did not get a response",
    "WebSocket closed unexpectedly",
    "terminated",
    "premature close",
  ];
  for (let index = 0; index < transientMessages.length; index += 1) {
    const message = transientMessages[index];
    const payload = request(root, 10 + index, 1, { code: "PI_AI_ERROR", message }, { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] });
    const promise = host.waterfall("agent/request-error", payload);
    await flushAsyncWork();
    fakeClock.fireNext();
    assert.deepEqual(await promise, { kind: "retry" }, "PI_AI_ERROR 瞬态消息应 retry: " + message);
  }
  const permanentMessages = ["pending", "deferred", "401 unauthorized", "403 forbidden", "400 invalid request", "413 payload too large", "quota exceeded", "model_not_allowed"];
  for (let index = 0; index < permanentMessages.length; index += 1) {
    const message = permanentMessages[index];
    const result = await host.waterfall("agent/request-error", request(root, 30 + index, 1, { code: "PI_AI_ERROR", message }, { mode: "normal", maxRetries: 5, retryableCodes: ["SERVER"] }));
    assert.equal(result, undefined, "PI_AI_ERROR 永久消息不得 retry: " + message);
  }

  } finally {
    globalThis.setTimeout = originalRequestSetTimeout;
    globalThis.clearTimeout = originalRequestClearTimeout;
  }
  const childOutcome = await executeRole(host, "explorer", "request retry child");
  const child = host.childAgents.get(childOutcome.subagentId);
  assert.ok(child, "专家 child 已创建");
  const firstChild = request(child, 1, 1, { code: "TRANSPORT" });
  assert.deepEqual(await host.waterfall("agent/request-error", firstChild), { kind: "retry" }, "child 瞬态错误返回 retry");
  assert.equal(await host.waterfall("agent/request-error", firstChild), undefined, "child 同一事件不重复 retry");

  for (let retry = 0; retry < AUTO_RECOVERY_LIMIT; retry += 1) {
    assert.deepEqual(
      await host.waterfall("agent/request-error", request(child, 2, 1, { code: "TIMEOUT" })),
      { kind: "retry" },
      "child 未达到上限前继续重试",
    );
  }
  assert.equal(
    await host.waterfall("agent/request-error", request(child, 2, 1, { code: "TIMEOUT" })),
    undefined,
    "child 达到请求级上限后停止",
  );

  child.session.events = [
    { type: "turn/start", data: { turn: 2 } },
    { type: "turn/end", data: { turn: 2, reason: { kind: "error", error: { code: "SERVER" } } } },
  ];
  const followupsBeforeTerminal = host.events.filter((event) => event.type === "followup").length;
  host.emit("session/event", child.session, child.session.events[1]);
  await flushAsyncWork();
  assert.equal(
    host.events.filter((event) => event.type === "followup").length,
    followupsBeforeTerminal,
    "请求级预算耗尽后 child turn/end 不得再启动 continuation",
  );

  assert.deepEqual(host.resendApiViolations, [], "请求级恢复不得访问 Session.prompt/Agent.steer 等非公开重发 API");
  hostRetryListenerDispose();
  host.dispose();
});

test("agent/request-error：cold-resume 专家快照保留 continuable 身份", async () => {
  const coldChildId = "cold-resume-expert";
  const host = createStrictHost({
    providerReady: true,
    seedChildModels: {
      [coldChildId]: {
        provider: "mock",
        model: "mock",
        role: "explorer",
        parentId: "root-test",
        continuable: true,
      },
    },
  });
  activate(host);
  const hostRetryDispose = host.on("agent/request-error", (payload) => {
    if (payload?.retryPolicy?.retryableCodes?.includes(payload?.failure?.code)) return { kind: "retry" };
    return void 0;
  });
  host.createAgent();
  await flushAsyncWork();
  const coldChild = host.createChildAgent(coldChildId, { provider: "mock", model: "mock" });
  assert.equal(coldChild.options.__degExpertRole, undefined, "cold-resume child 没有伪造 creation marker");
  assert.deepEqual(
    await host.waterfall("agent/request-error", {
      agent: coldChild,
      session: coldChild.session,
      turn: 1,
      step: 1,
      provider: "mock",
      failure: { code: "TIMEOUT" },
      retryPolicy: { mode: "normal", maxRetries: 2, retryableCodes: ["TIMEOUT"] },
      signal: new AbortController().signal,
    }),
    { kind: "retry" },
    "cold-resume 快照 child 仍能参与 request-error",
  );
  hostRetryDispose();
  host.dispose();
});

test("child turn/end：结构化重试错误进入 continuation", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  const outcome = await executeRole(host, "explorer", "structured retry child");
  const child = host.childAgents.get(outcome.subagentId);
  assert.ok(child, "专家 child 已创建");
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const fakeClock = {
    timers: [],
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      this.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    fireNext() {
      let timer;
      while (this.timers.length > 0) {
        timer = this.timers.shift();
        if (timer.cancelled) continue;
        timer.callback();
        return timer;
      }
      return timer;
    },
  };
  try {
    globalThis.setTimeout = fakeClock.setTimeout.bind(fakeClock);
    globalThis.clearTimeout = fakeClock.clearTimeout.bind(fakeClock);
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "MODEL_NOT_FOUND", message: "structured retry" } } } },
    ];
    const followupsBefore = host.events.filter((event) => event.type === "followup").length;
    host.emit("session/event", child.session, child.session.events[1]);
    await flushAsyncWork();
    assert.equal(fakeClock.timers.some((timer) => !timer.cancelled), true, "结构化 child 错误应安排 continuation 退避");
    fakeClock.fireNext();
    await flushAsyncWork();
    assert.equal(host.events.filter((event) => event.type === "followup").length, followupsBefore + 1, "结构化 child 错误应投递 continuation");
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    host.dispose();
  }
});

/** 安装一次性假时钟，用于手动触发自动恢复的退避 timer。 */
function installFakeClock() {
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  const fakeClock = {
    timers: [],
    setTimeout(callback, delay) {
      const timer = { callback, delay, cancelled: false };
      this.timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cancelled = true;
    },
    fireNext() {
      let timer;
      while (this.timers.length > 0) {
        timer = this.timers.shift();
        if (timer.cancelled) continue;
        timer.callback();
        return timer;
      }
      return timer;
    },
  };
  globalThis.setTimeout = fakeClock.setTimeout.bind(fakeClock);
  globalThis.clearTimeout = fakeClock.clearTimeout.bind(fakeClock);
  return {
    fakeClock,
    restore() {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    },
  };
}

test("多 child：较早 child 的可恢复失败仍投递给它自己，不重建也不误投另一个 child", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();
  // 同一 role 的两个不同任务：多 child 语义下必须各自独立。
  const first = await executeRole(host, "explorer", "first lane task", { affectedPaths: ["file:src/first.js"] });
  const second = await executeRole(host, "explorer", "second lane task", { affectedPaths: ["file:src/second.js"] });
  assert.notEqual(first.subagentId, second.subagentId, "不同 prompt 必须各自独立 child");
  assert.equal(host.childAgents.size, 2);
  const firstChild = host.childAgents.get(first.subagentId);
  assert.ok(firstChild, "第一个任务的 child 必须存在");
  const { fakeClock, restore } = installFakeClock();
  try {
    firstChild.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      { type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "MODEL_NOT_FOUND", message: "structured retry" } } } },
    ];
    const followupsBefore = host.events.filter((event) => event.type === "followup").length;
    host.emit("session/event", firstChild.session, firstChild.session.events[1]);
    await flushAsyncWork();
    assert.equal(fakeClock.timers.some((timer) => !timer.cancelled), true, "较早 child 的可恢复失败应安排 continuation 退避");
    fakeClock.fireNext();
    await flushAsyncWork();
    const followups = host.events.filter((event) => event.type === "followup");
    assert.equal(followups.length, followupsBefore + 1, "必须投递恰好一次 continuation");
    // scope.current 指向的是另一个独立 child（child-2），但同 route 的它**不是** route
    // 变更：恢复必须回到失败的那个 child，不能重建，也不能投给另一个 child。
    assert.equal(followups.at(-1).childId, first.subagentId, "恢复必须投递给失败的那个 child");
    assert.equal(host.childAgents.size, 2, "同 route 的另一个独立 child 不得被当作 route 变更而重建");
  } finally {
    restore();
    host.dispose();
  }
});

/**
 * 问题 3 回归：生产 DSH 的 'user/message' 事件 payload 就是 UserMessage 本身
 * —— id/role/content/source 平铺在 event.data 上（dsh-session 的
 * SessionEventMap['user/message'] = UserMessage）。插件此前按
 * event.data.message.id 读取，真实日志里永远收集不到消息 id，turn/end 无法把
 * 活动 affectedPaths 关联到本次 turn，rootStructuredPathGuard 会永久阻塞与已
 * 结束专家任务重叠的 root 结构化文件操作。
 * 下面的用例用真实 payload 形状驱动完整释放路径
 * （session/event → handleChildTurnEnd → delegationTracker.completeActiveTasksForTurn
 * → rootToolGuards），而不是只断言纯函数返回值；最后一条额外锁定旧嵌套形状的
 * 兼容回退仍然生效。
 */

/** 构造生产形状的 user/message 事件（消息对象平铺在 data 上）。 */
function realUserMessageEvent(id, text) {
  return {
    type: "user/message",
    data: {
      id,
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "plugin" },
    },
  };
}

/** 取本 child 首次 admission 的稳定 messageId（活动任务登记绑定的就是它）。 */
function admissionMessageIdOf(host, childId) {
  const created = host.events.findLast((event) => event.type === "agent/created" && event.childId === childId);
  assert.ok(created?.messageId, "agent/created 必须带 admission messageId");
  return created.messageId;
}

test("问题3：真实 user/message payload 下成功终态 turn/end 释放 root 结构化路径保护", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  const root = host.createAgent();
  try {
    const result = await executeRole(host, "explorer", "real payload success", {
      affectedPaths: ["file:docs/real-payload-success.md"],
    });
    assert.equal(result.kind, "continuable");
    const child = host.childAgents.get(result.subagentId);
    assert.ok(child, "专家 child 已创建");
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "docs/real-payload-success.md" }, agent: root };
    assert.match(rootGuard(guardedRead), /overlaps active expert work/, "活动专家任务期间必须保护 affectedPaths");

    const messageId = admissionMessageIdOf(host, child.id);
    const successTurnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      realUserMessageEvent(messageId, "real payload success"),
      { type: "assistant/message", data: { turn: 1, step: 0, message: { content: [{ type: "text", text: "完成" }] } } },
      successTurnEnd,
    ];
    host.emit("session/event", child.session, successTurnEnd);
    await flushAsyncWork();

    assert.equal(rootGuard(guardedRead), undefined, "成功终态后必须释放对应 affectedPaths（真实 payload 必须能解析出消息 id）");
  } finally {
    host.dispose();
  }
});

test("问题3：真实 user/message payload 下异常终态 turn/end 释放 root 结构化路径保护", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  const root = host.createAgent();
  const scheduler = createFakeTimerHarness();
  const originalSetTimeout = globalThis.setTimeout;
  const originalClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = scheduler.setTimeout;
  globalThis.clearTimeout = scheduler.clearTimeout;
  try {
    const result = await executeRole(host, "explorer", "real payload terminal failure", {
      affectedPaths: ["file:docs/real-payload-terminal.md"],
    });
    assert.equal(result.kind, "continuable");
    const child = host.childAgents.get(result.subagentId);
    assert.ok(child, "专家 child 已创建");
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "docs/real-payload-terminal.md" }, agent: root };
    assert.match(rootGuard(guardedRead), /overlaps active expert work/, "活动专家任务期间必须保护 affectedPaths");

    const messageId = admissionMessageIdOf(host, child.id);
    // 已知永久错误 → terminal 终态：不进入恢复链，必须直接释放活动范围。
    const terminalEnd = {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "error", error: { code: "PERMISSION_DENIED", message: "denied" } } },
    };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      realUserMessageEvent(messageId, "real payload terminal failure"),
      terminalEnd,
    ];
    host.emit("session/event", child.session, terminalEnd);
    await flushAsyncWork();

    assert.equal(scheduler.timers.length, 0, "永久错误不得安排自动恢复");
    assert.equal(rootGuard(guardedRead), undefined, "异常终态后必须释放对应 affectedPaths（真实 payload 必须能解析出消息 id）");
  } finally {
    host.dispose();
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
});

test("问题3：旧嵌套 data.message.id 日志仍能释放 root 结构化路径保护（兼容回退）", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  const root = host.createAgent();
  try {
    const result = await executeRole(host, "explorer", "legacy nested payload", {
      affectedPaths: ["file:docs/legacy-nested-payload.md"],
    });
    assert.equal(result.kind, "continuable");
    const child = host.childAgents.get(result.subagentId);
    assert.ok(child, "专家 child 已创建");
    const rootGuard = host.rootToolGuards[0];
    const guardedRead = { name: "read", arguments: { file_path: "docs/legacy-nested-payload.md" }, agent: root };
    assert.match(rootGuard(guardedRead), /overlaps active expert work/, "活动专家任务期间必须保护 affectedPaths");

    const messageId = admissionMessageIdOf(host, child.id);
    const successTurnEnd = { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } };
    child.session.events = [
      { type: "turn/start", data: { turn: 1 } },
      // 历史日志/旧夹具形状：消息包在 data.message 里；兼容回退必须仍能解析出 id。
      { type: "user/message", data: { message: { id: messageId } } },
      { type: "assistant/message", data: { turn: 1, step: 0, message: { content: [{ type: "text", text: "完成" }] } } },
      successTurnEnd,
    ];
    host.emit("session/event", child.session, successTurnEnd);
    await flushAsyncWork();

    assert.equal(rootGuard(guardedRead), undefined, "旧嵌套形状仍必须释放对应 affectedPaths");
  } finally {
    host.dispose();
  }
});

// ── finalize 回执自诊断（审核修复轮 修复 5）─────────────────────────────────
// reason 始终是稳定机器码；message 只补充「当前真实状态是什么」，让模型不必靠猜去补齐
// admissionTokens / admissionEpoch。schema 未新增字段，因此这里只断言回执值与渲染文本。

test("修复 5：accepted + reused 混合批次不再要求完整 token 集，诊断回报缺失且收口集合不变", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const accepted = await executeRole(host, "explorer", "mixed batch accepted", {
    affectedPaths: ["docs/mixed-accepted.md"],
  });
  assert.equal(accepted.kind, "continuable");
  assert.equal(accepted.reused, undefined);
  // 完全相同任务 → 复用既有 child：仍是同一开放批次里的独立 admission token。
  const reused = await executeRole(host, "explorer", "mixed batch accepted", {
    affectedPaths: ["docs/mixed-accepted.md"],
  });
  assert.equal(reused.reused, true);
  assert.equal(reused.admissionEpoch, accepted.admissionEpoch, "reused 属于同一开放 epoch");
  assert.notEqual(reused.admissionToken, accepted.admissionToken, "reused 仍有独立 token");

  let concludeCalls = 0;
  // 票据 10：少传 reused 的 token 不再拒绝——批次由服务端枚举整批有效 admission，
  // token 只是可选诊断；缺失项如实回报，但收口集合与 acceptedCount 都不受影响。
  const partial = await executeFinalize(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(partial.kind, "waiting");
  assert.equal(partial.acceptedCount, 1, "reused 计入有效集合但不计入 acceptedCount");
  assert.equal(partial.tokenDiagnostics.expected, 2, "expected 由服务端枚举整批有效 admission");
  assert.deepEqual(partial.tokenDiagnostics.missing, [reused.admissionToken], "缺失 token 只在诊断里回报");
  assert.equal(concludeCalls, 0, "登记 waiting 不得 conclude");

  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken, reused.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending");
  await completeChildAdmission(host, accepted, { messageId: "message-1", feedbackId: "feedback-1" });
  const settled = await finalized.promise;
  assert.equal(settled.kind, "finalized");
  assert.equal(settled.acceptedCount, 1, "reused 计入 token 集但不计入 acceptedCount");
  assert.equal(settled.message, undefined, "成功收口不带 message");
  assert.equal(concludeCalls, 0);
  host.dispose();
});

test("修复 5：accepted + failure 混合批次不再要求完整 token 集，诊断回报 failure token 缺失", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const accepted = await executeRole(host, "explorer", "mixed batch with failure", {
    affectedPaths: ["docs/mixed-failure.md"],
  });
  assert.equal(accepted.kind, "continuable");
  // fixer 未配置模型 → 该角色 admission 走 failure 分支，但仍必须返回凭据进入批次。
  const failed = await executeRole(host, "fixer", "mixed batch failing role");
  assert.equal(failed.kind, "failure");
  assert.equal(failed.admissionEpoch, accepted.admissionEpoch);
  assert.notEqual(failed.admissionToken, accepted.admissionToken);

  let concludeCalls = 0;
  // 票据 10：failure 结果仍属于有效 admission 集合，但少传它的 token 只体现在诊断里，
  // 不再把整批收口挡成 incomplete。
  const partial = await executeFinalize(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(partial.kind, "waiting");
  assert.equal(partial.acceptedCount, 1);
  assert.equal(partial.tokenDiagnostics.expected, 2);
  assert.deepEqual(partial.tokenDiagnostics.missing, [failed.admissionToken]);
  assert.equal(concludeCalls, 0);

  const finalized = startFinalizeLifecycle(host, {
    admissionEpoch: accepted.admissionEpoch,
    admissionTokens: [accepted.admissionToken, failed.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  }, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  assert.equal(finalized.status, "pending");
  await completeChildAdmission(host, accepted, { messageId: "message-1", feedbackId: "feedback-1" });
  const settled = await finalized.promise;
  assert.equal(settled.kind, "finalized", settled.message);
  assert.equal(settled.acceptedCount, 1, "failure 计入 token 集但不计入 acceptedCount");
  assert.equal(concludeCalls, 0);
  host.dispose();
});

test("修复 5：epoch 不匹配回执的 message 回显当前开放 epoch，render 必须带上 message", async () => {
  const host = createStrictHost({ providerReady: true, goalsOverride: {
    get: () => undefined,
    pause: () => { throw new Error("goals.pause must never be called"); },
    resume: () => { throw new Error("goals.resume must never be called"); },
  } });
  activate(host);
  host.createAgent();
  const first = await executeRole(host, "explorer", "epoch echo first", { affectedPaths: ["docs/epoch-echo-1.md"] });
  const firstArgs = {
    admissionEpoch: first.admissionEpoch,
    admissionTokens: [first.admissionToken],
    summaryCompleted: true,
    outcomesChecked: true,
    safeParallelWork: false,
  };
  let concludeCalls = 0;
  const firstFinalized = startFinalizeLifecycle(host, firstArgs, { concludeTurn: () => { concludeCalls += 1; } });
  await flushAsyncWork();
  await completeChildAdmission(host, first, { messageId: "message-1", feedbackId: "feedback-1" });
  const firstSettled = await firstFinalized.promise;
  assert.equal(firstSettled.kind, "finalized");

  // 收口后迟到的 admission 打开新 epoch：旧 epoch 的 finalize 必须能自诊断出当前 epoch。
  const late = await executeRole(host, "observer", "epoch echo late", { affectedPaths: ["docs/epoch-echo-2.md"] });
  assert.ok(late.admissionEpoch > first.admissionEpoch);
  const stale = await executeFinalize(host, firstArgs, { concludeTurn: () => { concludeCalls += 1; } });
  assert.equal(stale.kind, "rejected");
  assert.equal(stale.reason, "admission-epoch-mismatch", "reason 仍是稳定机器码");
  assert.equal(stale.message, `当前打开的 admissionEpoch 是 ${late.admissionEpoch}；请用该值重试。`);
  assert.equal(concludeCalls, 0, "被拒绝的 finalize 不得 conclude");

  // render 必须把 message 带进模型可见文本，否则自诊断文案在工具输出里被丢弃。
  const definition = host.registeredTools.get("dsh_expert_group_finalize");
  assert.ok(definition, "finalize 工具必须已注册");
  const rendered = definition.output.render(null, stale).map((block) => block.text).join("\n");
  assert.equal(
    rendered,
    `root finalization: admission-epoch-mismatch — 当前打开的 admissionEpoch 是 ${late.admissionEpoch}；请用该值重试。`,
  );
  // 无 message 时不得留下悬空分隔符。
  const renderedFinalized = definition.output.render(null, firstSettled).map((block) => block.text).join("\n");
  assert.equal(renderedFinalized, "root finalization: finalized");
  host.dispose();
});


// ── 上下文继承（票据 29）：legacy 宿主必须显式失败，绝不静默丢上下文 ─────────

test("上下文继承：legacy provider 宿主没有 fork 能力时显式失败，不回退 spawn", async () => {
  const host = createStrictHost({ providerReady: true });
  activate(host);
  host.createAgent();

  const candidate = {
    provider: "",
    defaults: { fixer: { provider: "mock", model: "mock" } },
    notificationEnabled: false,
    notificationVolume: 100,
    inheritContext: { fixer: true },
  };
  const committed = await invokeJsonRoute(host, {
    action: "settings-commit",
    expectedRevision: host.settingsRevision,
    settings: candidate,
  });
  assert.equal(committed.statusCode, 200, JSON.stringify(committed.body));
  assert.equal(committed.body.ok, true, JSON.stringify(committed.body.error ?? {}));

  const result = await executeRole(host, "fixer", "legacy 继承上下文");
  assert.equal(result.kind, "failure", JSON.stringify(result));
  assert.equal(result.code, "CONTEXT_INHERITANCE_UNAVAILABLE", "legacy 宿主必须报告继承不可用");
  assert.match(result.message, /重新派发/);
  assert.equal(host.events.filter((event) => event.type === "startContinuable/call").length, 0,
    "不得回退 legacy startContinuable 并把继承降级成 fresh");
  host.dispose();
});
