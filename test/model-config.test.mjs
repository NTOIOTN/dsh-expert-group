/**
 * 「模型配置」区域的契约与行为回归。
 *
 * 断言跨公开 seam：client bundle 通过 DSH 的 `window.__ModuleLoader__.load({ id, factory })`
 * 描述符在 Node 中真实执行，纯函数从 bundle 导出的 `modelConfig` 面读取；UI 断言渲染真实
 * bundle 里注册的 `settings.section` 组件（react 替身复用 test-support/client-bundle.mjs）。
 *
 * 覆盖：纯函数、草稿与路径操作、reasoningEfforts 七档映射、模型目录继承/用户覆盖/恢复默认、
 * revision 冲突与 schema 拒绝、以及「角色默认正在使用的档位不得被悄悄删除」的角色联动。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Schema from "@deepseek-ai/schemastery";

import {
  createClientReactRuntime,
  createFakeDocumentEventTarget,
  createHostContextStub,
  installGlobals,
  loadClientBundle,
} from "../test-support/client-bundle.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * 装配期先于 descriptor 执行的两个浏览器安全 IIFE 模块：都不是 ESM（不能 import），
 * 因此按发布 bundle 的真实做法在最小 global 替身里执行一次，再取回它们的检查点。
 * 「bundle 真的先执行它们」由 test/client-shared-boundary.test.mjs 的真实 realm 用例证明。
 */
function evaluateSidecar(file, symbolKey) {
  const source = readFileSync(join(root, file), "utf8");
  const sandbox = {};
  const run = new Function("globalThis", source + "\nreturn globalThis;");
  return run(sandbox)[Symbol.for(symbolKey)];
}

const sidecars = {
  modelConfig: evaluateSidecar("client-model-config.js", "dsh-expert-group/client-model-config"),
  expertGroupModel: evaluateSidecar("client-expert-group-model.js", "dsh-expert-group/client-expert-group-model"),
};
const modelConfig = sidecars.modelConfig;

/**
 * 安装装配期侧车模块的检查点。
 *
 * `loadClientBundle()` 在工厂返回后立刻还原临时全局，而设置页的 `apply(ctx)` 与组件渲染
 * 发生在稍后（装配期侧车在真实 Host 上是**常驻** globalThis 的），因此这里保持安装到
 * 全部用例结束。
 */
const restoreModelConfig = installGlobals({ [Symbol.for("dsh-expert-group/client-model-config")]: modelConfig });
test.after(() => { restoreModelConfig(); });

const { client: bundle } = await loadClientBundle();

// 身份一致：client.js 导出的 modelConfig 必须就是本文件断言的同一份侧车实现。
assert.equal(bundle.modelConfig, modelConfig, "client.js 的 modelConfig 必须来自装配期侧车检查点");

/** 被渲染的子树里按条件查找第一个匹配节点（沿用设置页测试的遍历语义）。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof node.type !== "undefined" && predicate(node) === true) return node;
  const children = node.children ?? node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findNode(child, predicate);
      if (found !== null) return found;
    }
  } else if (children !== undefined && children !== node) {
    return findNode(children, predicate);
  }
  return null;
}

/** 收集子树里所有匹配节点。 */
function collectNodes(node, predicate, found = []) {
  if (node === null || node === undefined || typeof node !== "object") return found;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, predicate, found);
    return found;
  }
  if (typeof node.type !== "undefined" && predicate(node) === true) found.push(node);
  const children = node.children ?? node.props?.children;
  if (Array.isArray(children)) {
    for (const child of children) collectNodes(child, predicate, found);
  } else if (children !== undefined && children !== node) {
    collectNodes(children, predicate, found);
  }
  return found;
}

// ── 与 DSH 模型设置页同源的 schema 夹具 ─────────────────────────────────────

/** 与 pi-ai 的 `reasoningEfforts` 同形：可空文本字典，键受档位词表约束或宽松。 */
function effortsSchema(strictKeys) {
  // 严格变体额外要求档位值非空：这样"空字符串被拒绝"与"空字符串被接受"是同一条
  // schema 规则的两侧，而不是靠换一份不同的 schema。
  const inner = strictKeys === true
    ? Schema.union([Schema.string().min(1), Schema.const(null)])
    : Schema.union([Schema.string(), Schema.const(null)]);
  return strictKeys === true
    ? Schema.dict(inner, Schema.union(["off", "minimal", "low", "medium", "high", "xhigh", "max"]))
    : Schema.dict(inner);
}

/** 一个 provider profile 的模型条目 schema（与 DSH 侧同形但不含隐藏高级字段）。 */
function modelSchema(shape) {
  return Schema.object({
    id: Schema.string().required(),
    name: Schema.string(),
    contextWindow: Schema.number().step(1).min(1),
    maxTokens: Schema.number().step(1).min(1),
    input: Schema.array(Schema.union(["text", "image"])),
    // 与 DSH 一致：`false` 表示非推理模型，缺省表示继承目录能力。
    reasoningEfforts: Schema.union([Schema.const(false), effortsSchema(shape.strictEfforts)]),
  });
}

/**
 * 命名空间 schema 信封：`{ providers: { <route>: profile } }`，
 * 与 DSH 设置页拿到的 `SettingsNamespaceView.schema` 同一形状。
 */
function namespaceSchemaEnvelope(shape) {
  return Schema.object({
    providers: Schema.dict(Schema.object({
      apiKeyEnv: Schema.string().role("credential-ref"),
      displayName: Schema.string(),
      api: shape.protocols === undefined ? Schema.string() : Schema.union(shape.protocols),
      baseURL: Schema.string(),
      models: Schema.array(modelSchema(shape)),
    })).default({}),
  }).toJSON();
}

const EMPTY_NAMESPACE = "deg-test-empty";

/** 命名空间视图：`user` 是用户层，`base` 是组合层，`value` 是已解析生效值。 */
function namespaceView(ns, { schema, user = {}, base = {}, value, writable = true, revision = 0 } = {}) {
  const resolved = value ?? Object.assign({}, base, user);
  return {
    ns,
    schema,
    value: resolved,
    base,
    user,
    applies: "live",
    secrets: [],
    // revision 必须可显式注入：revision 栅栏与冲突语义只有在真实 revision 下才有意义。
    revision,
    writable,
  };
}

const PI_AI_SCHEMA = namespaceSchemaEnvelope({ protocols: ["anthropic-messages", "openai-chat"] });
const LOOSE_SCHEMA = namespaceSchemaEnvelope({});
const STRICT_SCHEMA = namespaceSchemaEnvelope({ strictEfforts: true, protocols: ["openai-chat"] });

/** 一个自带工作台的模型配置宿主替身：真实 settings 语义（revision + 拒绝原因）。 */
function createWorkspace(options = {}) {
  const store = new Map();
  for (const view of options.namespaces ?? []) store.set(view.ns, { ...view });
  const calls = { listProviders: 0, listConfigurable: 0, credentialDescribe: [], credentialSet: [], credentialUnset: [], discover: [], mutate: [], rpcCalls: 0 };
  const credentials = new Map(Object.entries(options.credentials ?? {}));
  const directory = options.directory ?? [];  const registered = options.registered ?? [];
  const writable = options.writable !== false;
  const remoteListeners = new Map();

  const viewsNow = () => ({
    namespaces: [...store.values()].map((view) => ({ ...view, writable })),
    writable,
    hasDocument: true,
  });

  const remote = {
    $on(event, listener) {
      const listeners = remoteListeners.get(event) ?? new Set();
      listeners.add(listener);
      remoteListeners.set(event, listeners);
      return () => listeners.delete(listener);
    },
    llm: {
      async listProviders() {
        calls.listProviders += 1;
        return { ok: true, value: registered };
      },
      async listConfigurableProviders() {
        calls.listConfigurable += 1;
        return { ok: true, value: directory };
      },
      async discoverModels(ns, request) {
        calls.discover.push({ ns, request });
        if (options.discoverRefusal !== undefined) return { ok: false, error: { message: options.discoverRefusal } };
        return { ok: true, value: options.discovered ?? [{ id: "discovered-model" }] };
      },
    },
    credentials: {
      async describe(refs) {
        calls.credentialDescribe.push([...refs]);
        const value = {};
        for (const ref of refs) value[ref] = credentials.get(ref) ?? { configured: false, writable: true };
        return { ok: true, value };
      },
      async set(ref, value) {
        calls.credentialSet.push([ref, value]);
        // 可控失败：用于验证"settings 已写成功、credentials 失败后只重试 credentials"。
        if (typeof options.credentialSetFailure === "function") {
          const refusal = options.credentialSetFailure({ ref, value, attempt: calls.credentialSet.length });
          if (refusal !== undefined) return { ok: false, error: { message: refusal } };
        }
        credentials.set(ref, { configured: true, writable: true });
        return { ok: true, value: { configured: true, writable: true } };
      },
      async unset(ref) {
        calls.credentialUnset.push(ref);
        credentials.delete(ref);
        return { ok: true, value: { configured: false, writable: true } };
      },
    },
    settings: {
      /** 只接受声明过的 op 形状，并按 schema 与 revision 给出真实的拒绝原因。 */
      async mutate(ns, ops, expectedRevision) {
        calls.mutate.push({ ns, ops, expectedRevision });
        const view = store.get(ns);
        if (view === undefined) return { ok: false, error: { code: "not-found", message: ns + " 未注册" } };
        if (Number.isSafeInteger(expectedRevision) && expectedRevision !== view.revision) {
          return { ok: false, error: { code: "settings/conflict", message: "revision 已变", details: { revision: view.revision } } };
        }
        const next = JSON.parse(JSON.stringify({ value: view.value, user: view.user, base: view.base }));
        let root = { value: next.value, user: next.user };
        for (const op of ops) {
          const into = op.path[0] === "value" ? "value" : "user";
          const path = op.path[0] === "value" || op.path[0] === "user" ? op.path.slice(1) : op.path;
          if (op.op === "set") root[into] = modelConfig.setPath(root[into] ?? {}, path, op.value);
          else root[into] = modelConfig.deletePath(root[into] ?? {}, path);
        }
        const merged = Object.assign({}, view.base, root.user);
        // 与正式 settings 服务同样的行为：在持久化边界上按命名空间自己的 schema 校验，
        // 拒绝的提交不落盘、不推进 revision，并把宿主诊断原样回传。
        const validator = modelConfig.createSchemaAdapter({ rehydrate: (serialized) => new Schema(serialized) });
        const failure = validator.validate(validator.rehydrate(view.schema), merged);
        if (failure !== undefined) return { ok: false, error: { code: "settings/invalid", message: failure } };
        const updated = { ...view, user: root.user, value: merged, revision: view.revision + 1 };
        store.set(ns, updated);
        return { ok: true, value: { ...updated, writable } };
      },
    },
  };

  return {
    remote,
    calls,
    credentials,
    store,
    viewsNow,
    nsView: (ns) => store.get(ns),
    emit(event) {
      for (const listener of [...(remoteListeners.get(event) ?? [])]) listener();
    },
    setRevision(ns, revision) {
      store.set(ns, { ...store.get(ns), revision });
    },
    /**
     * 直接改命名空间的用户层并推进 revision，用来模拟"另一个会话/页面写入了配置"。
     * 这里绕开 mutate 的 schema 校验，只构造视图变化。
     */
    setUser(ns, user) {
      const view = store.get(ns);
      const merged = Object.assign({}, view.base, user);
      store.set(ns, { ...view, user, value: merged, revision: view.revision + 1 });
    },
    /**
     * 让某个 route 出现在宿主 provider 目录里（模拟写入后宿主重新声明该 provider）。
     * 目录顺序保持稳定，重复调用只更新同一条。
     */
    setDirectory(ns, entry) {
      const index = directory.findIndex((row) => row.provider === entry.provider);
      const next = {
        provider: entry.provider,
        displayName: entry.displayName ?? entry.provider,
        settingsNs: ns,
        settingsPath: ["providers", entry.provider],
        active: true,
        ...(entry.extra ?? {}),
      };
      if (index === -1) directory.push(next);
      else directory[index] = next;
      return next;
    },
  };
}
/** 把工作台接进 plugin ctx 与 describe 面。 */
function createHarness(workspace, options = {}) {
  const host = createHostContextStub({
    ...options,
    describeView: workspace.viewsNow(),
    schemaService: {
      rehydrate: (serialized) => new Schema(serialized),
      validate: (schema, draft) => {
        try {
          schema(draft);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      },
      nodeAtPath: (root, path) => {
        let node = root;
        for (const key of path) {
          if (node === null || node === undefined) return undefined;
          if (node.type === "object") node = node.dict?.[key];
          else if (node.type === "dict" || node.type === "array") node = node.inner;
          else return undefined;
        }
        return node;
      },
    },
  });
  host.ctx.remote = { ...host.ctx.remote, ...workspace.remote };
  return host;
}

const READY_STATUS = { status: "ready", value: {}, base: undefined, user: undefined, revision: 0, writable: true, mode: "host" };

/**
 * 只读配置表单替身（DSH 0.1.7-alpha.2 `configForms.get(条目 id)` 的公开面）。
 *
 * 快照形状与真实 ConfigForm 一致；三个写入方法一律抛错，因为 DEG 只应读取与订阅
 * （角色配置保存走 DEG 自有提交端点，模型配置走宿主通用 settings API）。
 */
function createSettingsForm(snapshot = READY_STATUS) {
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    set() { throw new Error("DEG 不得调用配置表单的 set"); },
    unset() { throw new Error("DEG 不得调用配置表单的 unset"); },
    mutate() { throw new Error("DEG 不得调用配置表单的 mutate"); },
  };
}

/**
 * configForms 服务替身：`get(条目 id)` 给出本插件条目的只读表单，`describe()` 给出
 * 全局 describe face（与旧 binder describe 同形状）。**不提供 bind**：旧 binder 面已删除。
 */
function createConfigForms(harness, snapshot = READY_STATUS) {
  return {
    get: (entryId) => (entryId === "dsh-expert-group" ? createSettingsForm(snapshot) : null),
    describe: () => harness.describeFace,
  };
}

/**
 * 渲染设置页 section 并返回渲染会话（模型配置区域默认折叠）。
 *
 * `options.modelCatalog` 传函数时按描述符注入面解析出**真实目录 store**（用例据此观察
 * 目录刷新状态机）；缺省仍是固定 ready 的替身，既有用例不受影响。
 */
async function renderSettingsSection(harness, runtime, options = {}) {
  const section = harness.registrations.get("settings.section");
  assert.ok(section, "插件必须注册 settings.section");
  const settingsForm = options.settingsForm ?? createSettingsForm(options.settingsSnapshot);
  // 目录 store 默认是固定 ready 的替身；传函数时用描述符的注入面解析（真实 store）。
  const injectedFace = () => section.descriptor.inject();
  const modelCatalog = typeof options.modelCatalog === "function"
    ? options.modelCatalog(injectedFace())
    : (options.modelCatalog ?? {
      subscribe: () => () => {},
      getSnapshot: () => ({ groups: options.groups ?? [], status: "ready", error: null }),
      load: async () => {},
    });
  const handle = runtime.render(section.Component, {
    settingsForm,
    modelCatalog,
    modelConfigHost: options.modelConfigHost,
    ctx: harness.ctx,
    ...options.props,
  });
  await handle.settle();
  return { handle, settingsForm, modelCatalog };
}

/**
 * 从测试上下文构造模型配置宿主（与设置页在真实宿主上拿到的是同一实现）。
 *
 * 第二个参数是新契约的 `configForms` 服务（只有 `describe()` 参与模型配置的全局视图；
 * 表单本身不被读取）。传 null 表示宿主没有该服务 → describe 面缺失，区域降级为只读。
 */
function modelConfigHostOf(harness, configForms) {
  return bundle.createModelConfigHost(harness.ctx, configForms);
}

/**
 * 渲染宿主的公共准备：注册插件（用**同一个** react 替身，渲染器与组件必须共用一张
 * hook 表）→ 建 configForms 替身 → 渲染设置页 section，并默认按真实设置页的注入面传入模型配置宿主。
 */
async function openSettings(harness, runtime, options = {}) {
  const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
  client.apply(harness.ctx);
  const configForms = options.configForms ?? createConfigForms(harness, options.settingsSnapshot);
  const host = options.modelConfigHost === undefined ? modelConfigHostOf(harness, configForms) : options.modelConfigHost;
  // 与真实设置页一致：宿主面在首个渲染前读一次 describe 视图，之后由 mirror 事件推进。
  await host?.refreshSettingsView?.();
  const rendered = await renderSettingsSection(harness, runtime, {
    ...options,
    settingsForm: options.settingsForm ?? createSettingsForm(options.settingsSnapshot),
    modelConfigHost: host,
    props: {
      ...options.props,
    },
  });
  return { client, configForms, ...rendered };
}

/**
 * 把设置页渲染到模型配置区域可交互的层级。
 *
 * 设置页只挂载 ModelConfigSection，disclosure 是它渲染出的子组件；测试替身不递归渲染
 * 子组件，因此逐层 materialize 真实组件（沿用既有 model-config 用例的同一套做法）。
 * 返回的 `mount(node, props)` 可以继续向下渲染卡片或自定义创建卡片。
 */
async function openModelSection(harness, runtime, options = {}) {
  const { client, configForms, handle } = await openSettings(harness, runtime, options);
  const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
  const sectionElement = children.find((node) => node?.type?.name === "ModelConfigSection");
  assert.ok(sectionElement, "设置页必须挂载模型配置组件");
  const modelHandle = runtime.render(sectionElement.type, sectionElement.props);
  await modelHandle.settle();
  const disclosureElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
  assert.ok(disclosureElement, "模型配置必须渲染 disclosure 控件");
  const disclosureHandle = runtime.render(disclosureElement.type, disclosureElement.props);
  await disclosureHandle.settle();
  const toggle = findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body");
  assert.ok(toggle, "模型配置必须渲染折叠按钮");
  if (options.expand !== false) {
    toggle.props.onClick();
    await modelHandle.settle();
  }
  return {
    client,
    configForms,
    handle,
    modelHandle,
    disclosureHandle,
    /** 当前 disclosure 按钮（每次重新查找，避免引用已卸载的旧节点）。 */
    toggle() {
      return findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body");
    },
    /**
     * 区域当前是否展开。
     *
     * 方向必须读 ModelConfigSection 的**最新**渲染结果：disclosureHandle 是挂载时物化出来的
     * 独立渲染会话，它拿到的 section 快照停在那一刻，用它的 aria-expanded 判断方向会静默点不动。
     * 而真正可点的按钮实例只在 disclosureHandle 里（onToggle 是活闭包），因此两边各取所长。
     */
    isExpanded() {
      const disclosure = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
      return disclosure?.props?.section?.disclosure?.expanded === true;
    },
    /** 折叠区域（对物化出来的 disclosure 按钮发一次点击）。 */
    collapse() {
      if (this.isExpanded()) this.toggle()?.props.onClick();
    },
    /** 展开区域（对物化出来的 disclosure 按钮发一次点击）。 */
    expand() {
      if (!this.isExpanded()) this.toggle()?.props.onClick();
    },
    /** 继续向下渲染一个真实子组件（卡片、自定义创建卡片）。 */
    async mount(predicate, props = {}) {
      const element = findNode(modelHandle.output, predicate);
      assert.ok(element, "找不到目标子组件");
      const child = runtime.render(element.type, { ...element.props, ...props });
      await child.settle();
      return child;
    },
    /** 找到已配置 provider 的卡片元素。 */
    providerElement(provider) {
      return findNode(modelHandle.output, (node) => node?.type?.name === "ModelProviderCard"
        && node.props?.row?.provider === provider);
    },
    unmount() {
      disclosureHandle.unmount();
      modelHandle.unmount();
      handle.unmount();
    },
  };
}

// ── 纯函数：凭据引用、provider 目录、路径操作 ────────────────────────────────

test("模型配置：凭据引用与 DSH 内置模型设置页同一条推导规则", () => {
  assert.equal(modelConfig.deriveKeyRef("deepseek"), "DEEPSEEK_API_KEY");
  assert.equal(modelConfig.deriveKeyRef("minimax-cn"), "MINIMAX_CN_API_KEY");
  assert.equal(modelConfig.deriveKeyRef("a.b/c d"), "A_B_C_D_API_KEY");
  assert.equal(modelConfig.deriveKeyRef(""), "_API_KEY");
});

test("模型配置：provider 目录按声明顺序装配，活动状态来自已注册路由", () => {
  const rows = modelConfig.joinProviderDirectory(
    [{ id: "acme", name: "Acme" }, { id: "live-only", name: "Live only" }],
    [
      { provider: "acme", displayName: "Acme Labs", settingsNs: "llm-pi-ai", settingsPath: ["providers", "acme"], declared: true },
      { provider: "dormant", displayName: "Dormant", settingsNs: "llm-pi-ai", settingsPath: ["providers", "dormant"], error: "缺少密钥" },
    ],
  );
  assert.deepEqual(rows.map((row) => row.provider), ["acme", "dormant", "live-only"]);
  assert.equal(rows[0].active, true);
  assert.equal(rows[0].declared, true);
  assert.equal(rows[1].active, false);
  assert.equal(rows[1].error, "缺少密钥");
  assert.equal(rows[2].settingsNs, "");
  assert.equal(rows[2].active, true);
});

test("模型配置：路径操作是纯函数，只增删两侧观察到的键", () => {
  const before = { baseURL: "https://a", nested: { x: 1 } };
  const after = { baseURL: "https://b", added: true, nested: { x: 1 } };
  const snapshot = JSON.stringify(before);
  const ops = modelConfig.pathOps(["providers", "acme"], before, after);
  assert.deepEqual(ops, [
    { op: "set", path: ["providers", "acme", "baseURL"], value: "https://b" },
    { op: "set", path: ["providers", "acme", "added"], value: true },
  ]);
  assert.equal(JSON.stringify(before), snapshot, "pathOps 不得就地修改入参");
  assert.deepEqual(modelConfig.pathOps([], { a: 1 }, { a: 1 }), []);
  assert.deepEqual(modelConfig.pathOps([], { a: 1 }, {}), [{ op: "unset", path: ["a"] }]);
  assert.deepEqual(modelConfig.pathOps([], undefined, undefined), []);
});

test("模型配置：setPath/deletePath 保持不可变且保留容器类型", () => {
  const root = { a: { b: 1 }, list: [1, 2, 3] };
  const nested = modelConfig.setPath(root, ["a", "c"], 2);
  assert.deepEqual(nested.a, { b: 1, c: 2 });
  assert.equal(root.a.c, undefined, "setPath 不得就地修改入参");
  assert.deepEqual(modelConfig.deletePath(root, ["a", "b"]), { a: {}, list: [1, 2, 3] });
  assert.deepEqual(modelConfig.deletePath(root, ["list", "1"]), { a: { b: 1 }, list: [1, 3] });
  assert.equal(modelConfig.deletePath(root, ["missing"]), root, "不存在的路径必须原样返回");
  assert.throws(() => modelConfig.setPath({}, [], 1), /非空路径/);
});

// ── reasoningEfforts 七档映射 ───────────────────────────────────────────────

test("模型配置：七档顺序固定为 off/minimal/low/medium/high/xhigh/max", () => {
  assert.deepEqual([...modelConfig.REASONING_EFFORTS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.deepEqual([...bundle.MODEL_REASONING_EFFORTS], [...modelConfig.REASONING_EFFORTS]);
});

test("模型配置：已有映射恢复勾选，新模型七档全部不勾选", () => {
  const restored = modelConfig.effortSelectionFor({ reasoningEfforts: { off: "", high: "high", xhigh: null } });
  assert.deepEqual(restored, {
    off: true, minimal: false, low: false, medium: false, high: true, xhigh: true, max: false,
  });
  assert.deepEqual(modelConfig.effortSelectionFor({ id: "new-model" }), modelConfig.emptyEffortSelection());
  assert.deepEqual(modelConfig.effortSelectionFor({ id: "non-reasoning", reasoningEfforts: false }), modelConfig.emptyEffortSelection());
  assert.deepEqual(modelConfig.effortSelectionFor(undefined), modelConfig.emptyEffortSelection());
  assert.deepEqual(modelConfig.effortSelectionFor({ reasoningEfforts: { high: false } }), modelConfig.emptyEffortSelection(),
    "值为 false 的档位不算勾选");
});

test("模型配置：off 写空字符串、其余档位写同名小写字符串", () => {
  assert.deepEqual(modelConfig.applyEffortSelection({ off: true, medium: true }, undefined), { off: "", medium: "medium" });
  assert.deepEqual(modelConfig.applyEffortSelection({ off: true, minimal: true, low: true, medium: true, high: true, xhigh: true, max: true }, undefined), {
    off: "", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max",
  });
  assert.equal(modelConfig.REASONING_EFFORT_EMPTY, "");
});

test("模型配置：只增删七个可见键并保留未展示的未知键", () => {
  const previous = { off: "none", high: "ultra", vendorFlag: "keep-me", retries: 2 };
  const kept = modelConfig.applyEffortSelection({ off: true, high: true }, previous);
  assert.deepEqual(kept, { vendorFlag: "keep-me", retries: 2, off: "", high: "high" });
  const dropped = modelConfig.applyEffortSelection({ max: true }, previous);
  assert.deepEqual(dropped, { vendorFlag: "keep-me", retries: 2, max: "max" });
  assert.deepEqual(modelConfig.unknownEffortKeysOf(previous), ["vendorFlag", "retries"]);
  assert.equal(modelConfig.hasUnknownEffortKeys(previous), true);
  assert.equal(modelConfig.hasUnknownEffortKeys({ off: "" }), false);
});

test("模型配置：七档全取消且无未知键时删除 reasoningEfforts，有未知键时保留", () => {
  assert.equal(modelConfig.applyEffortSelection(modelConfig.emptyEffortSelection(), { off: "", high: "high" }), undefined);
  assert.equal(modelConfig.applyEffortSelection(modelConfig.emptyEffortSelection(), undefined), undefined);
  assert.deepEqual(modelConfig.applyEffortSelection(modelConfig.emptyEffortSelection(), { vendor: "x" }), { vendor: "x" });
});

test("模型配置：整表设置档位时同一行的其它字段与未知键都不丢", () => {
  const rows = [{ id: "m1", name: "One", vendor: 1, reasoningEfforts: { keep: "k", high: "high" } }, { id: "m2" }];
  const next = modelConfig.setModelEffortSelection(rows, 0, { off: true, high: true, minimal: false, low: false, medium: false, xhigh: false, max: false });
  assert.deepEqual(next[0], { id: "m1", name: "One", vendor: 1, reasoningEfforts: { keep: "k", off: "", high: "high" } });
  assert.deepEqual(next[1], { id: "m2" }, "其它行必须原样保留");
  const cleared = modelConfig.setModelEffortSelection(rows, 0, modelConfig.emptyEffortSelection());
  assert.deepEqual(cleared[0], { id: "m1", name: "One", vendor: 1, reasoningEfforts: { keep: "k" } });
});

test("模型配置：输入类型与容量字段的读写保持同一套词表", () => {
  assert.deepEqual(modelConfig.INPUT_MODALITIES, ["text", "image"]);
  assert.deepEqual(modelConfig.modelInputOf({ input: ["image"] }, ["text"]), ["image"]);
  assert.deepEqual(modelConfig.modelInputOf({}, ["image"]), ["image"]);
  assert.deepEqual(modelConfig.modelInputOf({}, undefined), ["text"]);
  const withImage = modelConfig.setModelInputSelection([{ id: "m" }], 0, ["text", "image"]);
  assert.deepEqual(withImage[0].input, ["text", "image"]);
  assert.deepEqual(modelConfig.setModelInputSelection(withImage, 0, [])[0], { id: "m" });
  assert.equal(modelConfig.parseCapacity("256K"), 256000);
  assert.equal(modelConfig.parseCapacity("1M"), 1000000);
  assert.equal(modelConfig.parseCapacity("4096"), 4096);
  assert.equal(modelConfig.parseCapacity(""), undefined);
  assert.equal(Number.isNaN(modelConfig.parseCapacity("abc")), true);
  assert.equal(modelConfig.formatCapacity(256000), "256K");
  assert.equal(modelConfig.formatCapacity(1000000), "1M");
  assert.equal(modelConfig.formatCapacity(1500), "1500");
});

// ── 草稿：校验、清空语义、采纳候选 ──────────────────────────────────────────

test("模型配置：草稿校验拒绝空 ID、重复 ID 与非法容量", () => {
  assert.equal(modelConfig.validateModelRows([{ id: "a" }]).ok, true);
  assert.match(modelConfig.validateModelRows([{ id: "  " }]).error, /第 1 行/);
  assert.match(modelConfig.validateModelRows([{ id: "a" }, { id: " a " }]).error, /重复/);
  assert.match(modelConfig.validateModelRows([{ id: "a", contextWindow: 0 }]).error, /上下文窗口/);
  assert.match(modelConfig.validateModelRows([{ id: "a", maxTokens: 1.5 }]).error, /最大输出 token/);
  assert.match(modelConfig.validateModelRows([{ id: "a", name: "" }]).error, /显示名/);
  assert.match(modelConfig.validateModelRows([{ id: "a", reasoningEfforts: "high" }]).error, /思考档位/);
});

test("模型配置：patch 草稿时空值表示清空字段，其它字段与隐藏键都保留", () => {
  const patched = modelConfig.patchModelDraft(
    { id: "m", name: "Name", vendor: { x: 1 }, reasoningEfforts: { high: "high" } },
    { name: "", contextWindow: 8000, reasoningEfforts: undefined },
  );
  assert.deepEqual(patched, { id: "m", vendor: { x: 1 }, contextWindow: 8000 });
});

test("模型配置：采纳候选时已存在的行优先，未勾选的行不进入目录", () => {
  const rows = [{ id: "existing", contextWindow: 123 }];
  const adopted = modelConfig.adoptModels(rows, [
    { id: "existing", contextWindow: 999999 },
    { id: "fresh", name: "Fresh", contextWindow: 1000, maxTokens: 100, inputModalities: ["text", "image"] },
    { id: "" },
  ]);
  assert.deepEqual(adopted, [
    { id: "existing", contextWindow: 123 },
    { id: "fresh", name: "Fresh", contextWindow: 1000, maxTokens: 100, input: ["text", "image"] },
  ]);
});

test("模型配置：新采纳的模型七档全部不勾选", () => {
  const adopted = modelConfig.adoptModels([], [{ id: "fresh", name: "Fresh" }]);
  assert.deepEqual(modelConfig.effortSelectionFor(adopted[0]), modelConfig.emptyEffortSelection());
});

// ── 继承 / 用户覆盖 / 恢复默认 ──────────────────────────────────────────────

test("模型配置：无用户覆盖时显示适配器默认，首次编辑才 materialize 用户覆盖", () => {
  const baseline = modelConfig.createEditorBaseline({
    revision: 4,
    user: {},
    base: { providers: { acme: { models: [{ id: "inherited" }] } } },
    value: { providers: { acme: { models: [{ id: "inherited" }] } } },
  }, ["providers", "acme"]);
  assert.equal(modelConfig.isOverridden(baseline), false);
  const inherited = modelConfig.inheritedModelsOf(baseline);
  assert.deepEqual(inherited.models, [{ id: "inherited" }]);
  assert.deepEqual(
    modelConfig.modelCatalogOps({ profilePath: ["providers", "acme"], baseline, draft: { models: [{ id: "inherited" }, { id: "added", reasoningEfforts: { off: "" } }] } }),
    [{ op: "set", path: ["providers", "acme", "models"], value: [{ id: "inherited" }, { id: "added", reasoningEfforts: { off: "" } }] }],
  );
  assert.deepEqual(modelConfig.modelCatalogOps({ profilePath: ["providers", "acme"], baseline, draft: {} }), [],
    "未覆盖且草稿为空时不得 materialize 空目录");
});

test("模型配置：有用户覆盖时以覆盖为准，恢复默认删除用户覆盖", () => {
  const baseline = modelConfig.createEditorBaseline({
    revision: 4,
    user: { providers: { acme: { models: [{ id: "mine" }] } } },
    base: { providers: { acme: { models: [{ id: "inherited" }] } } },
    value: { providers: { acme: { models: [{ id: "mine" }] } } },
  }, ["providers", "acme"]);
  assert.equal(modelConfig.isOverridden(baseline), true);
  assert.deepEqual(modelConfig.inheritedModelsOf(baseline).models, [{ id: "mine" }]);
  assert.deepEqual(
    modelConfig.modelCatalogOps({ profilePath: ["providers", "acme"], baseline, draft: {} }),
    [{ op: "unset", path: ["providers", "acme", "models"] }],
    "清空覆盖必须表达为删除用户层字段，而不是写入空数组",
  );
  assert.deepEqual(modelConfig.restoreDefaultOps(["providers", "acme"]), [{ op: "unset", path: ["providers", "acme", "models"] }]);
  assert.deepEqual(modelConfig.materializeOverrideOps(["providers", "acme"], [{ id: "a" }]),
    [{ op: "set", path: ["providers", "acme", "models"], value: [{ id: "a" }] }]);
});

test("模型配置：覆盖决策把 materialize / 替换 / 恢复默认 / 空操作分开", () => {
  assert.equal(modelConfig.modelOverrideDecision({ overridden: false, dirty: true, models: [{ id: "a" }] }), "materialize");
  assert.equal(modelConfig.modelOverrideDecision({ overridden: true, dirty: true, models: [{ id: "a" }] }), "replace");
  assert.equal(modelConfig.modelOverrideDecision({ overridden: true, dirty: true, models: [] }), "reset");
  assert.equal(modelConfig.modelOverrideDecision({ overridden: false, dirty: false, models: [{ id: "a" }] }), "noop");
});

test("模型配置：整段即 profile 的 provider 用空路径表达用户层存在性", () => {
  const baseline = modelConfig.createEditorBaseline({ revision: 1, user: { models: [{ id: "a" }] }, base: {}, value: { models: [{ id: "a" }] } }, []);
  assert.equal(modelConfig.isOverridden(baseline), true);
  assert.deepEqual(modelConfig.modelCatalogOps({ profilePath: [], baseline, draft: {} }), [{ op: "unset", path: ["models"] }]);
});

test("模型配置：恢复默认后卡片显示继承目录，后续编辑不会写回旧覆盖", () => {
  const session = modelConfig.createCardSession({
    provider: "acme",
    settingsNs: "llm-pi-ai",
    profilePath: ["providers", "acme"],
    storedUser: { providers: { acme: { models: [{ id: "old-user-model" }] } } },
    base: { providers: { acme: { models: [{ id: "inherited-model" }] } } },
    value: { providers: { acme: { models: [{ id: "old-user-model" }] } } },
    revision: 4,
  });
  session.resetModels();
  assert.deepEqual(session.cardModel().models.map((model) => model.id.value), ["inherited-model"]);
  session.edit((draft) => draft);
  assert.deepEqual(session.plan().ops, [{ op: "unset", path: ["providers", "acme", "models"] }]);
});

// ── 冲突 / schema 拒绝 ─────────────────────────────────────────────────────

test("模型配置：revision 冲突判定覆盖缺失与非法 revision", () => {
  assert.equal(modelConfig.revisionConflictOf(3, 3), false);
  assert.equal(modelConfig.revisionConflictOf(3, 4), true);
  assert.equal(modelConfig.revisionConflictOf(undefined, 4), false, "没有基线时不冒充冲突");
  assert.equal(modelConfig.revisionConflictOf(3, undefined), true, "读不到当前 revision 时保守拒绝");
  assert.equal(modelConfig.revisionConflictOf(-1, 0), false);
});

test("模型配置：schema 拒绝时不落盘并原样回传宿主诊断", async () => {
  const adapter = modelConfig.createSchemaAdapter({ rehydrate: (serialized) => new Schema(serialized) });
  // 与 pi-ai 的 `z.union([z.string(), z.const(null)])` 同形：空字符串是合法的高档位拼写。
  const looseNode = adapter.rehydrate(LOOSE_SCHEMA);
  assert.equal(adapter.validate(looseNode, { providers: { acme: { models: [{ id: "m", reasoningEfforts: { off: "" } }] } } }), undefined);
  // 同一份草稿在严格 schema（档位值必须是非空文本）下必须被拒绝。
  const strictNode = adapter.rehydrate(STRICT_SCHEMA);
  const failure = adapter.validate(strictNode, { providers: { acme: { models: [{ id: "m", reasoningEfforts: { off: "" } }] } } });
  assert.equal(typeof failure, "string", "严格 schema 必须拒绝 off 的空字符串");

  const workspace = createWorkspace({ namespaces: [namespaceView("llm-pi-ai", { schema: LOOSE_SCHEMA })] });
  const accepted = await workspace.remote.settings.mutate("llm-pi-ai", [
    { op: "set", path: ["providers", "acme", "models"], value: [{ id: "m", reasoningEfforts: { off: "", high: "high" } }] },
  ], 0);
  assert.equal(accepted.ok, true, "同形 schema 必须接受 off 的空字符串");
  assert.equal(workspace.nsView("llm-pi-ai").revision, 1);
  assert.deepEqual(workspace.nsView("llm-pi-ai").user.providers.acme.models[0].reasoningEfforts, { off: "", high: "high" });

  // 真正被拒绝的草稿（容量为 0）必须不落盘、不推进 revision，并原样回传宿主诊断。
  const rejected = await workspace.remote.settings.mutate("llm-pi-ai", [
    { op: "set", path: ["providers", "acme", "models"], value: [{ id: "m", contextWindow: 0 }] },
  ], 1);
  assert.equal(rejected.ok, false, "非法容量必须被 schema 拒绝");
  assert.match(rejected.error.message, /contextWindow|>= 1|expected number/);
  assert.equal(workspace.nsView("llm-pi-ai").revision, 1, "被拒绝的提交不得推进 revision");
  assert.equal(workspace.nsView("llm-pi-ai").user.providers.acme.models[0].contextWindow, undefined, "被拒绝的草稿不得落盘");
});

test("模型配置：schema 适配器在没有公开服务时降级为不本地校验", () => {
  const adapter = modelConfig.createSchemaAdapter(null);
  assert.equal(adapter.available, false);
  assert.equal(adapter.rehydrate({ type: "object" }), undefined);
  assert.equal(adapter.validate(undefined, { anything: true }), undefined);
  assert.equal(adapter.nodeAtPath(undefined, ["a"]), undefined);
});

// ── 角色联动守卫 ───────────────────────────────────────────────────────────

test("模型配置：被角色默认使用的档位不得被删除，提示列出受影响角色", () => {
  const defaults = {
    fixer: { provider: "acme", model: "m", reasoningEffort: "high" },
    explorer: { provider: "acme", model: "m", reasoningEffort: "low" },
    oracle: { provider: "other", model: "m", reasoningEffort: "high" },
    librarian: { provider: "acme", model: "m" },
  };
  const affected = modelConfig.rolesAffectedByChange(defaults, { provider: "acme", removedLevels: ["high"] });
  assert.deepEqual(affected, [{ role: "fixer", reasoningEffort: "high" }]);
  const message = modelConfig.reasoningGuardMessage(["high"], affected, (role) => ({ fixer: "修复者" }[role] ?? role));
  assert.match(message, /修复者/);
  assert.match(message, /不会自动改写角色配置/);
  assert.deepEqual(modelConfig.rolesAffectedByChange(defaults, { provider: "acme", removedLevels: ["max"] }), []);
  assert.deepEqual(modelConfig.rolesAffectedByChange(defaults, { provider: "acme", removeProvider: true }).map((entry) => entry.role), ["fixer", "explorer"]);
});

test("模型配置：从两份目录算出被删除的档位，取消档位与删除整行都计入，新增行不误报", () => {
  const before = [
    { id: "a", reasoningEfforts: { off: "", high: "high" } },
    { id: "b", reasoningEfforts: { low: "low" } },
  ];
  const after = [
    { id: "a", reasoningEfforts: { off: "" } },
    { id: "b", reasoningEfforts: { low: "low", max: "max" } },
    { id: "c", reasoningEfforts: { medium: "medium" } },
  ];
  assert.deepEqual(modelConfig.removedLevelsOf(before, after), ["high"], "取消勾选的档位必须计入删除");
  // 票据 20：整行删除的档位随该行一起消失，因此同样计入删除集合（不再只在「恢复默认」时生效）。
  assert.deepEqual(modelConfig.removedLevelsOf(before, [{ id: "a", reasoningEfforts: { off: "", high: "high" } }]), ["low"],
    "被整行删除的模型，其档位必须计入删除集合");
  assert.deepEqual(modelConfig.removedLevelsOf(before, before), [], "没有任何变化时不得误报");
  assert.deepEqual(modelConfig.removedLevelsOf([...before, { id: "no-efforts" }], after), ["high"],
    "没有声明任何档位的行被删除不产生档位删除");
  assert.deepEqual(modelConfig.removedLevelsOf(before, [{ id: "c", reasoningEfforts: { medium: "medium" } }]).sort(), ["high", "low", "off"],
    "整份目录被替换（恢复默认/清空）时所有原有档位都算删除");
});

// ── 卡片渲染面与编辑会话：折叠、七档复选框、独立应用/取消、冲突与守卫 ────────

/**
 * 与 DSH 内置模型设置页同源的 provider 目录与命名空间：
 * acme 已有用户覆盖（m1），fresh 只有适配器默认。
 */
function cardFixtures() {
  const namespace = namespaceView("llm-pi-ai", {
    schema: PI_AI_SCHEMA,
    revision: 2,
    user: { providers: { acme: { models: [{ id: "m1", name: "One", reasoningEfforts: { off: "", high: "high" } }] } } },
    base: {},
    value: { providers: { acme: { models: [{ id: "m1", name: "One", reasoningEfforts: { off: "", high: "high" } }] } } },
  });
  return {
    namespace,
    row: { provider: "acme", displayName: "Acme", settingsNs: "llm-pi-ai", settingsPath: ["providers", "acme"], active: true },
    rowFresh: { provider: "fresh", displayName: "Fresh", settingsNs: "llm-pi-ai", settingsPath: ["providers", "fresh"], active: false },
  };
}

function sessionFor(fixtures, overrides = {}) {
  return modelConfig.createCardSession({
    provider: fixtures.row.provider,
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: fixtures.namespace.base,
    revision: fixtures.namespace.revision,
    roleDefaults: {},
    ...overrides,
  });
}

/** 渲染用的工作台：acme 已在用户层配置，fresh 只有目录条目。 */
function workspacesForRender(options = {}) {
  const fixtures = cardFixtures();
  return createWorkspace({
    directory: [fixtures.row, fixtures.rowFresh],
    registered: [{ id: "acme", name: "Acme" }],
    credentials: { ACME_API_KEY: { configured: true, writable: true } },
    namespaces: [fixtures.namespace],
    ...options,
  });
}

test("模型配置：provider 目录把「已配置」与「可添加」分开，不把默认当覆盖", () => {
  const fixtures = cardFixtures();
  const withDefault = namespaceView("llm-pi-ai", {
    schema: PI_AI_SCHEMA,
    user: {},
    base: { providers: { fresh: { models: [{ id: "inherited" }] } } },
    value: { providers: { fresh: { models: [{ id: "inherited" }] } } },
  });
  const sections = modelConfig.providerListSections([fixtures.row, fixtures.rowFresh], (ns) => (
    ns === "llm-pi-ai" ? fixtures.namespace : undefined
  ));
  assert.deepEqual(sections.configured.map((entry) => entry.row.provider), ["acme"]);
  assert.deepEqual(sections.addable.map((entry) => entry.row.provider), ["fresh"]);
  // 只有组合层默认（用户层没有该 profile）时不算"已配置"。
  const onlyBase = modelConfig.providerListSections([fixtures.rowFresh], () => withDefault);
  assert.deepEqual(onlyBase.configured, []);
  assert.deepEqual(onlyBase.addable.map((entry) => entry.row.provider), ["fresh"]);
});

test("模型配置：卡片模型给出七档复选框与恢复已有勾选、新模型全不勾选", () => {
  const fixtures = cardFixtures();
  const node = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: fixtures.namespace,
    draft: modelConfig.importNamespace(modelConfig.getPath(fixtures.namespace.value, fixtures.row.settingsPath)),
    credentialRef: "ACME_API_KEY",
    credential: { configured: true, writable: true },
    protocols: ["openai-chat", "anthropic-messages"],
  });
  assert.equal(node.displayName, "Acme");
  assert.deepEqual(node.protocol.options.map((option) => option.value), ["", "openai-chat", "anthropic-messages"]);
  assert.deepEqual(node.baseUrl, { value: "", placeholder: "留空表示使用适配器默认端点" });
  assert.equal(node.apiKey.type, "password");
  assert.equal(node.apiKey.autoComplete, "off");
  assert.equal(node.apiKey.ref, "ACME_API_KEY");
  assert.equal(node.apiKey.placeholder, "已配置（留空表示不修改）");
  assert.match(node.apiKey.hint, /不回显明文/);
  assert.equal(node.modelCatalog.overridden, true);
  assert.equal(node.modelCatalog.canReset, true);
  assert.deepEqual(node.models[0].efforts, [
    { level: "off", checked: true },
    { level: "minimal", checked: false },
    { level: "low", checked: false },
    { level: "medium", checked: false },
    { level: "high", checked: true },
    { level: "xhigh", checked: false },
    { level: "max", checked: false },
  ]);
  assert.deepEqual(node.models[0].inputs, [
    { modality: "text", checked: true, locked: true },
    { modality: "image", checked: false, locked: false },
  ]);

  // 新添加的空行：七档全不勾选，输入类型取回退值。
  const appended = [...modelConfig.modelDraftsOf(node.models.length === 0 ? [] : [{ id: "m1" }]), modelConfig.createModelRow()];
  const refreshed = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: fixtures.namespace,
    draft: { models: appended },
    credentialRef: "ACME_API_KEY",
    defaultInput: ["image"],
  });
  assert.deepEqual(refreshed.models[1].efforts.map((effort) => effort.checked), [false, false, false, false, false, false, false]);
  assert.deepEqual(refreshed.models[1].inputs, [
    { modality: "text", checked: false, locked: false },
    { modality: "image", checked: true, locked: true },
  ]);
  assert.equal(refreshed.models[1].id.value, "");
});

test("模型配置：卡片会话首次编辑才 materialize，未编辑时应用不产生任何操作", () => {
  const fixtures = cardFixtures();
  const pristine = modelConfig.createCardSession({
    provider: "fresh",
    settingsNs: "llm-pi-ai",
    profilePath: fixtures.rowFresh.settingsPath,
    storedUser: {},
    value: { providers: { fresh: { models: [{ id: "inherited" }] } } },
    base: { providers: { fresh: { models: [{ id: "inherited" }] } } },
    revision: 5,
  });
  assert.deepEqual(pristine.plan(), { ok: true, ops: [], expectedRevision: 5, keyValue: undefined },
    "没有编辑时应用不得凭空写一份空覆盖");
  assert.equal(pristine.cardModel().modelCatalog.overridden, false);
  assert.match(pristine.cardModel().modelCatalog.label, /适配器默认/);

  const edited = modelConfig.createCardSession({
    provider: "acme",
    settingsNs: "llm-pi-ai",
    profilePath: fixtures.row.settingsPath,
    storedUser: {},
    value: { providers: { acme: { models: [{ id: "inherited" }] } } },
    base: { providers: { acme: { models: [{ id: "inherited" }] } } },
    revision: 4,
  });
  edited.edit((draft) => ({ ...draft, models: [...draft.models, { id: "added" }] }));
  assert.equal(edited.cardModel().modelCatalog.overridden, true);
  assert.match(edited.cardModel().modelCatalog.label, /用户覆盖/);
  const plan = edited.plan();
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops, [{
    op: "set",
    path: ["providers", "acme", "models"],
    value: [{ id: "inherited" }, { id: "added" }],
  }], "首次编辑必须把继承行与新增行一起 materialize");
  assert.equal(plan.expectedRevision, 4);
});

test("模型配置：卡片会话取消丢弃草稿，恢复默认删除用户覆盖", () => {
  const fixtures = cardFixtures();
  const session = sessionFor(fixtures);
  session.edit((draft) => ({ ...draft, models: [{ id: "changed" }] }));
  session.typeKey("sk-secret");
  assert.deepEqual(session.plan().ops[0].value, [{ id: "changed" }]);
  session.cancel();
  assert.deepEqual(modelConfig.getPath(session.draft, ["models"]).map((model) => model.id), ["m1"],
    "取消必须回到进入编辑态时的已存储状态");
  assert.equal(session.plan().ops.length, 0, "取消后不应残留任何待提交操作");

  const reset = sessionFor(fixtures);
  reset.resetModels();
  assert.equal(reset.cardModel().modelCatalog.overridden, false, "清空目录即回到适配器默认视图");
  assert.match(reset.cardModel().modelCatalog.label, /适配器默认/);
  const plan = reset.plan();
  assert.deepEqual(plan.ops, [{ op: "unset", path: ["providers", "acme", "models"] }], "恢复默认必须表达为删除用户覆盖");
});

test("模型配置：恢复默认删除目录时仍阻止删除角色正在使用的档位", () => {
  const fixtures = cardFixtures();
  const session = modelConfig.createCardSession({
    provider: fixtures.row.provider,
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: fixtures.namespace.base,
    revision: fixtures.namespace.revision,
    roleDefaults: { fixer: { provider: "acme", model: "m1", reasoningEffort: "high" } },
  });
  session.resetModels();
  const plan = session.plan();
  assert.equal(plan.ok, false);
  assert.equal(plan.guard, true);
  assert.deepEqual(plan.removedLevels, ["off", "high"]);
  assert.deepEqual(plan.affectedRoles, [{ role: "fixer", reasoningEffort: "high" }]);
});
test("模型配置：卡片上的单行删除触发与删除 provider 相同的角色联动守卫", () => {
  const fixtures = cardFixtures();
  const session = modelConfig.createCardSession({
    provider: fixtures.row.provider,
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: fixtures.namespace.base,
    revision: fixtures.namespace.revision,
    roleDefaults: { fixer: { provider: "acme", model: "m1", reasoningEffort: "high" } },
  });
  // 与 UI 的「删除」按钮同一条路径（client.js 调用 config.removeModelRow）。
  session.edit((draft) => ({ ...draft, models: modelConfig.removeModelRow(session.modelRows, 0) }));
  assert.deepEqual(modelConfig.modelDraftsOf(session.draft.models), [], "夹具必须真的删掉了那一行");
  const plan = session.plan();
  assert.equal(plan.ok, false, "票据 20：删除被角色默认使用的模型行不得绕过角色联动守卫");
  assert.equal(plan.guard, true);
  assert.deepEqual(plan.removedLevels, ["off", "high"], "被删行的全部档位都算删除");
  assert.deepEqual(plan.affectedRoles, [{ role: "fixer", reasoningEffort: "high" }]);
  assert.match(plan.error, /无法保存/);
  assert.match(plan.error, /fixer/);
  assert.match(plan.error, /不会自动改写角色配置/);
  assert.equal(plan.ops, undefined, "被守卫拦下时不得产生任何待提交操作");

  // 反向边界：角色没有使用被删行的任何档位时，单行删除照常可以保存。
  const allowed = modelConfig.createCardSession({
    provider: fixtures.row.provider,
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: fixtures.namespace.base,
    revision: fixtures.namespace.revision,
    roleDefaults: { fixer: { provider: "acme", model: "m1", reasoningEffort: "max" } },
  });
  allowed.edit((draft) => ({ ...draft, models: modelConfig.removeModelRow(allowed.modelRows, 0) }));
  const allowedPlan = allowed.plan();
  assert.equal(allowedPlan.ok, true, "不受影响的角色不得拦住这次删除");
  assert.equal(allowedPlan.guard, undefined);
  assert.deepEqual(allowedPlan.ops, [{ op: "unset", path: ["providers", "acme", "models"] }],
    "清空目录仍表达为删除用户层覆盖");
});
test("模型配置：卡片会话在已有覆盖上只提交最小 diff，外部提交的字段不被误删", () => {
  const fixtures = cardFixtures();
  const session = sessionFor(fixtures);
  // 编辑期间另一个会话把同一 profile 的 baseURL 写进用户层。
  session.edit((draft) => ({ ...draft, models: [{ id: "m1", name: "One" }, { id: "m2" }] }));
  const plan = session.plan();
  assert.deepEqual(plan.ops, [{
    op: "set",
    path: ["providers", "acme", "models"],
    value: [{ id: "m1", name: "One" }, { id: "m2" }],
  }]);
  assert.equal(Object.prototype.hasOwnProperty.call(plan.ops[0].value[0], "baseURL"), false,
    "卡片没看到的字段不得被重建或删除");
});

test("模型配置：卡片会话拒绝非法草稿，且把 revision 冲突保护交给宿主结果", () => {
  const fixtures = cardFixtures();
  const session = sessionFor(fixtures);
  session.edit((draft) => ({ ...draft, models: [{ id: "m1" }, { id: "m1" }] }));
  const rejected = session.plan();
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /重复/);
  session.edit((draft) => ({ ...draft, models: [{ id: "m1", contextWindow: "big" }] }));
  const invalid = session.plan();
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /上下文窗口/);

  // 提交成功后接受权威视图：草稿与 revision 都前进到新基线，不再有待提交操作。
  const accepted = sessionFor(fixtures);
  accepted.edit((draft) => ({ ...draft, models: [{ id: "m1" }, { id: "m2" }] }));
  const view = {
    revision: 3,
    user: { providers: { acme: { models: [{ id: "m1" }, { id: "m2" }] } } },
    base: {},
    value: { providers: { acme: { models: [{ id: "m1" }, { id: "m2" }] } } },
  };
  accepted.accept(view);
  assert.equal(accepted.revision, 3);
  assert.deepEqual(accepted.plan().ops, [], "接受权威视图后不得再有待提交操作");

  // 冲突：卡片读到的 revision 与当前不符时，写路径必须被 revision 栅栏拦住。
  assert.equal(modelConfig.revisionConflictOf(accepted.revision, 7), true);
  assert.equal(modelConfig.revisionConflictOf(accepted.revision, 3), false);
});

test("模型配置：卡片草稿只包含自己有权编辑的字段，隐藏高级字段不被重建", () => {
  const session = modelConfig.createCardSession({
    provider: "acme",
    profilePath: ["providers", "acme"],
    storedUser: {},
    value: {
      providers: {
        acme: {
          baseURL: "https://api.example",
          transport: "websocket",
          retryPolicy: { attempts: 3 },
          models: [{ id: "m1" }],
        },
      },
    },
    base: {},
    revision: 1,
  });
  assert.deepEqual(modelConfig.modelEditableProfileOf(session.draft), {
    baseURL: "https://api.example",
    models: [{ id: "m1" }],
  }, "隐藏高级字段不得进入卡片草稿");
  // 首次编辑必须 materialize 一份完整覆盖：卡片能看到的字段都写进用户层，
  // 组合层/内置目录里的隐藏字段则完全不参与。
  session.edit((draft) => ({ ...draft, models: [{ id: "m1" }, { id: "m2" }] }));
  const plan = session.plan();
  assert.deepEqual(plan.ops, [
    { op: "set", path: ["providers", "acme", "baseURL"], value: "https://api.example" },
    { op: "set", path: ["providers", "acme", "models"], value: [{ id: "m1" }, { id: "m2" }] },
  ], "materialize 只写卡片可见字段");
  assert.equal(JSON.stringify(plan.ops).includes("websocket"), false, "隐藏字段绝不被重建");
  assert.equal(JSON.stringify(plan.ops).includes("retryPolicy"), false);

  // 第二次编辑：相对权威用户层只写真正变化的字段。
  session.accept({
    revision: 2,
    user: { providers: { acme: { baseURL: "https://api.example", models: [{ id: "m1" }, { id: "m2" }] } } },
    base: {},
    value: { providers: { acme: { baseURL: "https://api.example", models: [{ id: "m1" }, { id: "m2" }] } } },
  });
  session.edit((draft) => ({ ...draft, models: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }));
  assert.deepEqual(session.plan().ops, [{
    op: "set",
    path: ["providers", "acme", "models"],
    value: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
  }], "未改动的 baseURL 不再产生操作");
});

test("模型配置：只编辑可见 profile 字段时保留隐藏字段与继承模型目录", () => {
  const session = modelConfig.createCardSession({
    provider: "fresh",
    settingsNs: "llm-pi-ai",
    profilePath: ["providers", "fresh"],
    storedUser: { providers: { fresh: { transport: "websocket", baseURL: "https://old" } } },
    value: { providers: { fresh: { transport: "websocket", baseURL: "https://old", models: [{ id: "default" }] } } },
    base: { providers: { fresh: { transport: "websocket", models: [{ id: "default" }] } } },
    revision: 1,
  });
  session.edit((draft) => ({ ...draft, baseURL: "https://new" }));
  assert.deepEqual(session.plan().ops, [{
    op: "set",
    path: ["providers", "fresh", "baseURL"],
    value: "https://new",
  }]);
  assert.deepEqual(session.cardModel().models.map((row) => row.id.value), ["default"]);
});

test("模型配置：只写 API Key 的新 provider materialize 空 profile，不写空模型覆盖", () => {
  const session = modelConfig.createCardSession({
    provider: "fresh",
    settingsNs: "other-ns",
    profilePath: ["providers", "fresh"],
    storedUser: {},
    value: { providers: {} },
    base: { providers: { fresh: { models: [{ id: "default" }] } } },
    revision: 0,
  });
  session.typeKey("sk-fresh");
  assert.deepEqual(session.plan().ops, [{ op: "set", path: ["providers", "fresh"], value: {} }]);
});

test("模型配置：协议选项按 provider settingsPath 查询，而非硬编码 providers 路径", () => {
  const root = { type: "object", dict: { route: { type: "object", dict: {
    api: { type: "union", list: [{ value: "custom-protocol" }] },
  } } } };
  const adapter = { nodeAtPath: (value, path) => {
    let node = value;
    for (const key of path) node = node?.dict?.[key];
    return node;
  } };
  assert.deepEqual(modelConfig.protocolChoices(root, "fresh", adapter, ["route"]), ["custom-protocol"]);
});

test("模型配置：user 层存在空 provider profile 时归入已配置且可删除", () => {
  const row = { provider: "fresh", settingsNs: "llm-pi-ai", settingsPath: ["providers", "fresh"] };
  const namespace = namespaceView("llm-pi-ai", { user: { providers: { fresh: {} } }, value: { providers: { fresh: {} } } });
  const sections = modelConfig.providerListSections([row], () => namespace);
  assert.deepEqual(sections.configured.map((entry) => entry.row.provider), ["fresh"]);
  assert.equal(modelConfig.providerRemovable(row, namespace), true);
  assert.equal(modelConfig.hasPath({}, []), false);
  assert.equal(modelConfig.hasPath({ api: "openai-chat" }, []), true);
});

test("模型配置：根 settingsPath 的空 profile 不算已配置", () => {
  const row = { provider: "root-route", settingsNs: "llm-pi-ai", settingsPath: [] };
  const empty = namespaceView("llm-pi-ai", { user: {}, value: {} });
  const configured = namespaceView("llm-pi-ai", { user: { api: "openai-chat" }, value: { api: "openai-chat" } });
  assert.deepEqual(modelConfig.providerListSections([row], () => empty).configured, []);
  assert.deepEqual(modelConfig.providerListSections([row], () => configured).configured.map((entry) => entry.row.provider), ["root-route"]);
});
test("模型配置：卡片会话在角色默认使用将被取消的档位时阻止保存并列出角色", () => {
  const fixtures = cardFixtures();
  const session = modelConfig.createCardSession({
    provider: "acme",
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: {},
    revision: 2,
    roleDefaults: { fixer: { provider: "acme", model: "m1", reasoningEffort: "high" } },
  });
  session.edit((draft) => ({
    ...draft,
    models: [{ id: "m1", name: "One", reasoningEfforts: { off: "" } }],
  }));
  const blocked = session.plan();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.guard, true);
  assert.deepEqual(blocked.removedLevels, ["high"]);
  assert.deepEqual(blocked.affectedRoles, [{ role: "fixer", reasoningEffort: "high" }]);
  assert.match(blocked.error, /无法保存/);
  assert.match(blocked.error, /fixer/);
  assert.match(blocked.error, /不会自动改写角色配置/);
  assert.equal(blocked.ops, undefined, "被守卫拦下时不得产生任何待提交操作");
});

test("模型配置：API Key 输入只写不读，禁用条件与引用提示一起给出", () => {
  const writable = modelConfig.apiKeyField({ provider: "acme", credentialRef: "ACME_API_KEY", credential: { configured: false, writable: true } });
  assert.equal(writable.type, "password");
  assert.equal(writable.disabled, false);
  assert.equal(writable.placeholder, "粘贴 API Key 后点应用");
  const configured = modelConfig.apiKeyField({ provider: "acme", credentialRef: "ACME_API_KEY", credential: { configured: true, writable: true } });
  assert.equal(configured.placeholder, "已配置（留空表示不修改）");
  const locked = modelConfig.apiKeyField({ provider: "acme", credentialRef: "ACME_API_KEY", credential: { configured: true, writable: false } });
  assert.equal(locked.disabled, true);
  const readOnly = modelConfig.apiKeyField({ provider: "acme", credentialRef: "ACME_API_KEY", readOnly: true });
  assert.equal(readOnly.disabled, true);
  assert.match(modelConfig.apiKeyField({ credentialRef: "" }).hint, /未设置凭据引用/);
});

test("模型配置：llm-pi-ai 输入 API Key 时把派生引用写入 provider profile", () => {
  const fixtures = cardFixtures();
  const session = modelConfig.createCardSession({
    provider: fixtures.row.provider,
    settingsNs: "llm-pi-ai",
    profilePath: fixtures.row.settingsPath,
    storedUser: fixtures.namespace.user,
    value: fixtures.namespace.value,
    base: fixtures.namespace.base,
    revision: fixtures.namespace.revision,
  });
  session.typeKey("sk-example");
  const plan = session.plan();
  assert.equal(plan.ok, true);
  assert.deepEqual(plan.ops, [{
    op: "set",
    path: ["providers", "acme", "apiKeyEnv"],
    value: "ACME_API_KEY",
  }]);
  assert.equal(plan.keyValue, "sk-example");
});

test("模型配置：卡片的编辑会话用凭据引用推导规则，与内置页一致", () => {
  const fixtures = cardFixtures();
  const node = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: fixtures.namespace,
    draft: {},
  });
  assert.equal(node.apiKey.ref, "ACME_API_KEY");
  assert.equal(node.actions.apply, "enabled");
  assert.equal(node.actions.cancel, "enabled");
  const readOnly = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: fixtures.namespace,
    draft: {},
    readOnly: true,
  });
  assert.equal(readOnly.actions.apply, "disabled");
  assert.equal(readOnly.actions.fetchModels, "disabled");
  assert.equal(readOnly.actions.removeProvider, "disabled");
  assert.equal(readOnly.actions.edit, "enabled", "只读时仍可查看卡片");
});

test("模型配置：接受 settings 权威视图后仍保留待写入的 API Key", () => {
  const fixtures = cardFixtures();
  const session = sessionFor(fixtures);
  session.typeKey("sk-retry");
  session.accept({
    revision: 3,
    user: fixtures.namespace.user,
    base: fixtures.namespace.base,
    value: fixtures.namespace.value,
  });
  assert.equal(session.plan().keyValue, "sk-retry");
});
test("模型配置：API Key 输入的可见值由卡片状态保持", () => {
  const fixtures = cardFixtures();
  const node = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: fixtures.namespace,
    draft: {},
    credentialRef: "ACME_API_KEY",
    credential: { configured: false, writable: true },
    typed: "sk-visible",
  });
  assert.equal(node.apiKey.value, "sk-visible");
});
test("模型配置：折叠区默认折叠，展开后才读取 provider 目录，且折叠时不渲染卡片", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  try {
    const { handle } = await openSettings(harness, runtime);
    assert.equal(workspace.calls.listConfigurable, 0, "折叠时不得读取 provider 目录");
    assert.equal(findNode(handle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body"), null,
      "折叠区由设置页末尾挂载的内部组件渲染；其默认折叠/展开行为由 buildSectionModel 断言");
    handle.unmount();
  } finally {
    harness.dispose();
  }
});

test("模型配置：折叠区默认折叠、标题与动作可用性由同一份判定给出", () => {
  const collapsed = modelConfig.buildSectionModel({ open: false, status: "ready", addable: [{ provider: "fresh" }], writable: true });
  assert.equal(collapsed.title, "模型配置");
  assert.equal(collapsed.open, false, "区域默认必须折叠");
  assert.equal(collapsed.disclosure.expanded, false);
  assert.equal(collapsed.disclosure.bodyId, "deg-model-config-body");
  assert.equal(collapsed.actions.addProvider, "enabled");
  assert.equal(collapsed.actions.reload, "enabled");
  assert.equal(collapsed.actions.toggle, "enabled");
  assert.match(collapsed.hint, /DSH 内置模型设置页/);

  const expanded = modelConfig.buildSectionModel({ open: true, status: "loading", addable: [], writable: true });
  assert.equal(expanded.open, true);
  assert.equal(expanded.disclosure.expanded, true);
  assert.equal(expanded.disclosure.label, "收起");
  assert.equal(expanded.actions.reload, "disabled", "读取中不得重复触发目录读取");
  assert.equal(expanded.actions.addProvider, "disabled", "没有可添加的 provider 时按钮必须禁用");

  const readOnly = modelConfig.buildSectionModel({ open: true, status: "ready", addable: [{ provider: "fresh" }], writable: false });
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.actions.addProvider, "disabled");
  assert.equal(modelConfig.buildSectionModel({ open: true, status: "error", error: "目录读取失败" }).error, "目录读取失败");
});

// ── 与既有设置页共存 ───────────────────────────────────────────────────────

test("模型配置：共享实现未装载时设置页保持既有角色配置不变", async () => {
  const runtime = createClientReactRuntime();
  const harness = createHostContextStub();
  const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
  try {
    client.apply(harness.ctx);
    const { handle } = await renderSettingsSection(harness, runtime, { props: { modelConfigHost: null } });
    assert.equal(findNode(handle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body"), null);
    assert.ok(findNode(handle.output, (node) => node.props?.["data-deg-prompt-role"] === "fixer"), "角色配置必须照旧渲染");
    assert.ok(findNode(handle.output, (node) => node.type === "button" && node.props?.children === "保存"));
    handle.unmount();
  } finally {
    harness.dispose();
  }
});

// ── 真实宿主 inject 门控回归（本次线上故障） ─────────────────────────────────

/**
 * 在真实 Cordis 里，`ctx.remote.llm` / `ctx.remote.credentials` / `ctx.remote.settings`
 * 不是 `ctx.remote` 对象上的普通属性，而是 gateway 以 `remote.<namespace>` 名称注册的
 * **独立 Cordis 服务**。经属性访问读取一个未在 `inject` 声明的命名空间，会命中
 * traceable 代理的门控并抛 `cannot get property "remote.llm" without inject`，
 * 使整个客户端 fiber FAILED（启动页显示 “dsh-expert-group: failed”，入口未激活）。
 *
 * 因此 `createModelConfigHost` 必须走 `ctx.get(name)`（无 inject 门控的公开读取入口），
 * 而不是属性链。这条用例把该约束钉死：门控代理会在属性访问时抛错，`apply` 仍必须成功。
 */
function installCordisInjectGate(host) {
  const namespaces = {
    "remote.llm": host.ctx.remote.llm,
    "remote.credentials": host.ctx.remote.credentials,
    "remote.settings": host.ctx.remote.settings,
  };
  // 未声明为 inject 的命名空间：属性访问一律抛 Cordis 的真实错误文本。
  const undeclared = new Set(["llm", "credentials", "settings"]);
  host.ctx.remote = new Proxy(host.ctx.remote, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && undeclared.has(prop)) {
        throw new Error('cannot get property "remote.' + prop + '" without inject');
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const originalGet = host.ctx.get;
  // 宿主公开读取入口：不带 inject 门控，真实 gateway 的命名空间服务经它取回。
  host.ctx.get = (name) => {
    if (Object.prototype.hasOwnProperty.call(namespaces, name)) return namespaces[name];
    return originalGet(name);
  };
}

test("模型配置：严格 inject 门控下必须经 ctx.get 解析 remote 命名空间，apply 不得失败", async () => {
  const runtime = createClientReactRuntime();
  const workspace = createWorkspace({
    namespaces: [namespaceView("llm-pi-ai", { schema: PI_AI_SCHEMA })],
    directory: [{ provider: "llm-pi-ai", displayName: "pi-ai", settingsNs: "llm-pi-ai", settingsPath: [] }],
    registered: [{ id: "llm-pi-ai", name: "pi-ai" }],
  });
  const harness = createHarness(workspace);
  installCordisInjectGate(harness);
  try {
    // 先证明门控确实生效：属性链访问必须抛错（否则本用例无法锁住回归）。
    assert.throws(
      () => harness.ctx.remote.llm,
      /cannot get property "remote\.llm" without inject/,
      "门控模拟必须真实：未声明的 remote 命名空间属性访问必须抛错",
    );

    const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
    assert.ok(client.inject.includes("remote.llm"));
    assert.ok(client.inject.includes("remote.credentials"));
    assert.ok(client.inject.includes("remote.settings"));
    // 本次线上故障的精确复现点：apply 期构造模型配置宿主时不得因 inject 门控抛错。
    assert.doesNotThrow(() => client.apply(harness.ctx), "apply 不得因 remote 命名空间门控而失败");

    const modelConfigHost = modelConfigHostOf(harness, createConfigForms(harness));
    assert.ok(modelConfigHost, "命名空间可经 ctx.get 解析时模型配置宿主必须建立");

    // 行为证据：provider 目录读取必须真正打到 remote.llm 命名空间上。
    const rows = await modelConfigHost.operations.listProviderDirectory();
    assert.equal(workspace.calls.listProviders, 1, "listProviders 必须经 ctx.get 解析到的 remote.llm 调用");
    assert.equal(workspace.calls.listConfigurable, 1);
    assert.deepEqual(rows.map((row) => row.provider), ["llm-pi-ai"]);
  } finally {
    harness.dispose();
  }
});

test("模型配置：命名空间整体缺失时降级为只读提示，apply 与其余功能不受影响", async () => {
  const runtime = createClientReactRuntime();
  const harness = createHostContextStub();
  // 旧宿主/能力缺失：三个命名空间都取不到。
  harness.ctx.get = (name) => (name.startsWith("remote.") ? null : undefined);
  try {
    const { client } = await loadClientBundle({ react: runtime.react, primitives: {} });
    assert.doesNotThrow(() => client.apply(harness.ctx), "命名空间缺失必须降级而不是失败");

    const modelConfigHost = modelConfigHostOf(harness, createConfigForms(harness));
    assert.ok(modelConfigHost, "共享实现仍在时宿主照常建立");
    await assert.rejects(
      () => modelConfigHost.operations.listProviderDirectory(),
      /provider 配置目录接口/,
      "缺少 remote.llm 时必须给出可读的拒绝原因，而不是静默成功",
    );
  } finally {
    harness.dispose();
  }
});

test("模型配置：describe 面唯一来自 configForms.describe()，旧 binder/bound scope 双回退已移除", async () => {
  const workspace = workspacesForRender();
  const harness = createHarness(workspace);
  // 历史回退链的两端都摆上「会抛错的假 describe」：插件一旦回退到它们就立刻失败。
  const bogusBoundScope = {
    subscribe: () => () => {},
    getSnapshot: () => READY_STATUS,
    set() { throw new Error("不得调用表单 set"); },
    unset() { throw new Error("不得调用表单 unset"); },
    mutate() { throw new Error("不得调用表单 mutate"); },
    describe() { throw new Error("bound scope 的 describe 回退必须已删除"); },
  };
  harness.ctx.settingsScope = { describe() { throw new Error("settingsScope binder 回退必须已删除"); } };
  try {
    const host = modelConfigHostOf(harness, createConfigForms(harness));
    assert.ok(host);
    await host.refreshSettingsView();
    const namespace = host.namespaceView("llm-pi-ai");
    assert.equal(namespace?.ns, "llm-pi-ai", "命名空间视图必须来自 configForms.describe()");
    assert.deepEqual(namespace?.value?.providers?.acme?.models, [{ id: "m1", name: "One", reasoningEfforts: { off: "", high: "high" } }]);

    // configForms 缺失（宿主没有该服务）时 describe 面为 null：区域降级为只读，而不是崩溃。
    const withoutDescribe = modelConfigHostOf(harness, null);
    assert.ok(withoutDescribe, "共享实现仍在时宿主照常建立");
    await withoutDescribe.refreshSettingsView();
    assert.equal(withoutDescribe.readView().writable, false, "describe 缺失时必须按只读呈现");
    assert.deepEqual(withoutDescribe.readView().namespaces, []);
    assert.equal(bogusBoundScope.getSnapshot() !== undefined, true);
  } finally {
    harness.dispose();
  }
});

test("模型配置：设置页把模型区域放在角色配置表之前", async () => {
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspacesForRender());
  try {
    const { handle } = await openSettings(harness, runtime);
    const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
    const modelIndex = children.findIndex((node) => node?.type?.name === "ModelConfigSection");
    const roleTableIndex = children.findIndex((node) => node?.props?.className === "deg_settings_table_wrap");
    assert.ok(modelIndex >= 0, "设置页必须渲染模型配置区域");
    assert.ok(roleTableIndex >= 0, "设置页必须渲染角色配置表");
    assert.ok(modelIndex < roleTableIndex, "模型配置必须位于角色配置表之前");
    handle.unmount();
  } finally {
    harness.dispose();
  }
});

test("模型配置：provider 卡片打开时自动读取 adapter 模型目录", async () => {
  const profile = { apiKeyEnv: "ACME_API_KEY" };
  const workspace = createWorkspace({
    directory: [{ provider: "acme", displayName: "Acme", settingsNs: "llm-pi-ai", settingsPath: ["providers", "acme"], declared: false }],
    registered: [{ id: "acme", name: "Acme" }],
    discovered: [{ id: "auto-model", name: "Auto model", inputModalities: ["text"] }],
    namespaces: [namespaceView("llm-pi-ai", {
      schema: PI_AI_SCHEMA,
      user: { providers: { acme: profile } },
      base: { providers: { acme: {} } },
      value: { providers: { acme: profile } },
    })],
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let modelHandle = null;
  let disclosureHandle = null;
  let cardHandle = null;
  try {
    const { handle } = await openSettings(harness, runtime);
    const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
    const modelElement = children.find((node) => node?.type?.name === "ModelConfigSection");
    modelHandle = runtime.render(modelElement.type, modelElement.props);
    const disclosureElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
    disclosureHandle = runtime.render(disclosureElement.type, disclosureElement.props);
    findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body").props.onClick();
    await modelHandle.settle();
    const providerElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelProviderCard");
    cardHandle = runtime.render(providerElement.type, providerElement.props);
    findNode(cardHandle.output, (node) => node.type === "button" && node.props?.children === "编辑").props.onClick();
    await cardHandle.settle();
    const modelId = findNode(cardHandle.output, (node) => node.type === "input" && node.props?.["aria-label"] === "模型 ID 1");
    assert.equal(modelId?.props?.value, "auto-model");
    assert.equal(workspace.calls.discover.length, 1, "打开 provider 卡片必须自动询问 adapter 目录");
  } finally {
    cardHandle?.unmount();
    disclosureHandle?.unmount();
    modelHandle?.unmount();
    harness.dispose();
  }
});

test("模型配置：settings mirror 事件让已展开设置页重新读取 namespace", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let modelHandle = null;
  let disclosureHandle = null;
  try {
    const { handle } = await openSettings(harness, runtime);
    const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
    const modelElement = children.find((node) => node?.type?.name === "ModelConfigSection");
    modelHandle = runtime.render(modelElement.type, modelElement.props);
    const disclosureElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
    disclosureHandle = runtime.render(disclosureElement.type, disclosureElement.props);
    findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body").props.onClick();
    await modelHandle.settle();
    const current = workspace.nsView("llm-pi-ai");
    const nextProfile = { models: [{ id: "updated-from-other-page" }] };
    workspace.store.set("llm-pi-ai", {
      ...current,
      user: { providers: { acme: nextProfile } },
      value: { providers: { acme: nextProfile } },
      revision: current.revision + 1,
    });
    harness.setDescribeView(workspace.viewsNow());
    workspace.emit("settings/document-updated");
    await modelHandle.settle();
    const providerElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "acme");
    assert.deepEqual(providerElement.props.namespace.value.providers.acme.models, [{ id: "updated-from-other-page" }]);
    assert.ok(workspace.calls.listProviders >= 2, "settings mirror 事件必须触发 provider 目录重读");
  } finally {
    disclosureHandle?.unmount();
    modelHandle?.unmount();
    harness.dispose();
  }
});

test("模型配置：点击添加模型后立即出现可编辑的空模型行", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let modelHandle = null;
  let disclosureHandle = null;
  let cardHandle = null;
  try {
    const { handle } = await openSettings(harness, runtime);
    const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
    const modelElement = children.find((node) => node?.type?.name === "ModelConfigSection");
    assert.ok(modelElement, "设置页必须挂载模型配置组件");
    modelHandle = runtime.render(modelElement.type, modelElement.props);
    const disclosureElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
    assert.ok(disclosureElement, "模型配置必须渲染 disclosure 控件");
    disclosureHandle = runtime.render(disclosureElement.type, disclosureElement.props);
    const toggle = findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body");
    assert.ok(toggle);
    toggle.props.onClick();
    await modelHandle.settle();
    const providerElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "acme");
    assert.ok(providerElement, "已配置 provider 必须出现在模型配置列表");
    cardHandle = runtime.render(providerElement.type, providerElement.props);
    const edit = findNode(cardHandle.output, (node) => node.type === "button" && node.props?.children === "编辑");
    assert.ok(edit);
    edit.props.onClick();
    await cardHandle.settle();
    assert.ok(findNode(cardHandle.output, (node) => node.props?.["data-deg-base-url"] === "acme"), "Base URL 必须在 provider 编辑卡常显");
    assert.ok(findNode(cardHandle.output, (node) => node.props?.["data-deg-protocol"] === "acme"), "协议必须在 provider 编辑卡常显");
    const add = findNode(cardHandle.output, (node) => node.props?.["data-deg-add-model"] === "acme");
    assert.ok(add);
    assert.equal(add.props.disabled, false);
    add.props.onClick();
    await cardHandle.settle();
    const emptyRow = findNode(cardHandle.output, (node) => node.type === "input"
      && node.props?.["aria-label"] === "模型 ID 2" && node.props?.value === "");
    assert.ok(emptyRow, "新增模型必须在同一张卡片中显示为空的可编辑行");
    emptyRow.props.onChange({ target: { value: "new-ui-model" } });
    await cardHandle.settle();
    const apply = findNode(cardHandle.output, (node) => node.props?.["data-deg-apply"] === "acme");
    assert.ok(apply, "模型卡片必须提供应用动作");
    apply.props.onClick();
    await cardHandle.settle();
    const savedModels = workspace.calls.mutate
      .flatMap((call) => call.ops ?? [])
      .find((op) => op.path?.at(-1) === "models");
    assert.deepEqual(savedModels?.value?.map((model) => model.id), ["m1", "new-ui-model"]);
    cardHandle.unmount();
    disclosureHandle.unmount();
    modelHandle.unmount();
    handle.unmount();
  } finally {
    cardHandle?.unmount();
    disclosureHandle?.unmount();
    modelHandle?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：namespace 条目没有 writable 时仍沿用 settings describe 的整页可写性", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let modelHandle = null;
  let disclosureHandle = null;
  let cardHandle = null;
  try {
    const described = workspace.viewsNow();
    harness.setDescribeView({
      ...described,
      namespaces: described.namespaces.map(({ writable: _writable, ...namespace }) => namespace),
    });
    const { handle } = await openSettings(harness, runtime);
    const children = Array.isArray(handle.output?.props?.children) ? handle.output.props.children : [];
    const modelElement = children.find((node) => node?.type?.name === "ModelConfigSection");
    modelHandle = runtime.render(modelElement.type, modelElement.props);
    const disclosureElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelConfigDisclosure");
    disclosureHandle = runtime.render(disclosureElement.type, disclosureElement.props);
    findNode(disclosureHandle.output, (node) => node.props?.["aria-controls"] === "deg-model-config-body").props.onClick();
    await modelHandle.settle();
    const providerElement = findNode(modelHandle.output, (node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "acme");
    cardHandle = runtime.render(providerElement.type, providerElement.props);
    findNode(cardHandle.output, (node) => node.type === "button" && node.props?.children === "编辑").props.onClick();
    await cardHandle.settle();
    const baseUrl = findNode(cardHandle.output, (node) => node.props?.["data-deg-base-url"] === "acme");
    const apply = findNode(cardHandle.output, (node) => node.props?.["data-deg-apply"] === "acme");
    assert.equal(baseUrl?.props?.disabled, false, "namespace 未携带 writable 时 Base URL 仍必须可编辑");
    assert.equal(apply?.props?.disabled, false, "namespace 未携带 writable 时应用按钮仍必须可用");
  } finally {
    cardHandle?.unmount();
    disclosureHandle?.unmount();
    modelHandle?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：模型区域提供原生的添加提供方与添加自定义提供方入口", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    assert.ok(findNode(mounted.modelHandle.output, (node) => node.type === "button" && node.props?.children === "添加提供方"),
      "模型区域必须提供添加提供方入口");
    assert.ok(findNode(mounted.modelHandle.output, (node) => node.type === "button" && node.props?.children === "添加自定义提供方"),
      "模型区域必须提供添加自定义提供方入口");
    const entries = findNode(mounted.modelHandle.output, (node) => node.props?.className === "deg_mc_entries");
    assert.ok(entries, "两个入口必须放在同一个横向入口容器中");
    assert.equal(Array.isArray(entries.props.children), true);
    assert.equal(entries.props.children.length, 2, "横向入口容器必须同时包含两个 provider 按钮");
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：可用 provider 显示绿色状态点且删除按钮使用错误色", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "acme");
    const dot = findNode(card.output, (node) => node.props?.className === "deg_mc_dot");
    assert.equal(dot?.props?.["data-state"], "available", "已配置 API Key 的 provider 必须标记为可用");
    assert.match(dot?.props?.style?.background ?? "", /state-success-primary|#22c55e/);
    const remove = findNode(card.output, (node) => node.props?.["aria-label"] === "acme 删除");
    assert.equal(remove?.props?.className, "deg_btn deg_mc_delete_btn", "删除按钮必须使用错误色样式类");
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});



test("模型配置：provider 卡片写入权限继承整页 writable，namespace 条目只需 schema/user/revision", () => {
  const fixtures = cardFixtures();
  // 真实宿主形状：namespace 条目没有 writable，写入能力只在 describe 的 view 上。
  const namespaceWithoutWritable = { ...fixtures.namespace };
  Reflect.deleteProperty(namespaceWithoutWritable, "writable");
  const writableCard = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: namespaceWithoutWritable,
    draft: modelConfig.importNamespace(modelConfig.getPath(fixtures.namespace.value, fixtures.row.settingsPath)),
    credentialRef: "ACME_API_KEY",
    credential: { configured: true, writable: true },
    readOnly: false,
  });
  assert.equal(writableCard.readOnly, false);
  assert.equal(writableCard.actions.apply, "enabled");
  assert.equal(writableCard.actions.fetchModels, "enabled");
  assert.equal(writableCard.actions.addModel, "enabled");
  assert.equal(writableCard.actions.removeProvider, "enabled");
  assert.equal(writableCard.baseUrl.value, "");
  assert.equal(writableCard.apiKey.disabled, false);

  // 整页只读：仍可查看，但写入动作全部禁用。
  const readOnlyCard = modelConfig.buildModelCardModel({
    row: fixtures.row,
    namespace: namespaceWithoutWritable,
    draft: {},
    credentialRef: "ACME_API_KEY",
    credential: { configured: true, writable: true },
    readOnly: true,
  });
  assert.equal(readOnlyCard.readOnly, true);
  assert.equal(readOnlyCard.actions.apply, "disabled");
  assert.equal(readOnlyCard.actions.fetchModels, "disabled");
  assert.equal(readOnlyCard.actions.addModel, "disabled");
  assert.equal(readOnlyCard.actions.removeProvider, "disabled");
  assert.equal(readOnlyCard.actions.edit, "enabled", "只读时仍必须能查看卡片");
  assert.equal(readOnlyCard.apiKey.disabled, true);
});

test("模型配置回归：整页只读时 namespace 条目缺少 writable 也必须禁用写入", async () => {
  const workspace = workspacesForRender({ writable: false });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    const element = mounted.providerElement("acme");
    assert.ok(element, "整页只读时已配置 provider 仍必须可查看");
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard" && node.props?.row?.provider === "acme");
    findNode(card.output, (node) => node.type === "button" && node.props?.children === "编辑").props.onClick();
    await card.settle();
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme").props.disabled, true);
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme").props.disabled, true);
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-add-model"] === "acme").props.disabled, true);
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-api-key"] === "acme").props.disabled, true);
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：整页可写时字段与应用按钮可用，保存走最小 path operations", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard" && node.props?.row?.provider === "acme");
    findNode(card.output, (node) => node.type === "button" && node.props?.children === "编辑").props.onClick();
    await card.settle();
    const baseUrl = findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme");
    assert.equal(baseUrl.props.disabled, false, "可写整页时 Base URL 必须可编辑");
    baseUrl.props.onChange({ target: { value: "https://api.example.com/v1" } });
    await card.settle();
    const apply = findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme");
    assert.equal(apply.props.disabled, false, "可写整页时应用按钮必须可用");
    apply.props.onClick();
    await card.settle(24);
    const ops = workspace.calls.mutate.flatMap((call) => call.ops ?? []);
    assert.deepEqual(ops, [{
      op: "set",
      path: ["providers", "acme", "baseURL"],
      value: "https://api.example.com/v1",
    }], "只提交真正变化的字段");
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

// ── issue 02：已知 provider 添加入口 ────────────────────────────────────────

test("模型配置：添加提供方只列出用户层未配置的 provider，组合层默认不算已配置", () => {
  const fixtures = cardFixtures();
  const sections = modelConfig.providerListSections([fixtures.row, fixtures.rowFresh], (ns) => (
    ns === "llm-pi-ai" ? fixtures.namespace : undefined
  ));
  assert.deepEqual(sections.addable.map((entry) => entry.row.provider), ["fresh"]);
  assert.deepEqual(sections.configured.map((entry) => entry.row.provider), ["acme"]);

  // 用户层只有组合层默认时仍属于可添加项。
  const baseOnly = namespaceView("llm-pi-ai", {
    schema: PI_AI_SCHEMA,
    user: {},
    base: { providers: { fresh: { models: [{ id: "default" }] } } },
    value: { providers: { fresh: { models: [{ id: "default" }] } } },
  });
  const overBase = modelConfig.providerListSections([fixtures.rowFresh], () => baseOnly);
  assert.deepEqual(overBase.addable.map((entry) => entry.row.provider), ["fresh"]);
  assert.deepEqual(overBase.configured, []);
});

test("模型配置：没有可添加 provider 或目录未就绪时，添加提供方禁用而自定义入口独立判定", () => {
  const noAddable = modelConfig.buildSectionModel({
    open: true,
    status: "ready",
    addable: [],
    protocols: ["openai-chat"],
    canCreateCustom: true,
    writable: true,
  });
  assert.equal(noAddable.actions.addProvider, "disabled", "没有候选 provider 时必须禁用");
  assert.equal(noAddable.actions.addCustom, "enabled", "自定义入口按自己的条件独立判定");
  assert.equal(noAddable.entries.addProvider.label, "添加提供方");
  assert.equal(noAddable.entries.addCustom.label, "添加自定义提供方");

  const loading = modelConfig.buildSectionModel({
    open: true,
    status: "loading",
    addable: [{ provider: "fresh" }],
    protocols: ["openai-chat"],
    canCreateCustom: true,
    writable: true,
  });
  assert.equal(loading.actions.addProvider, "disabled", "目录未就绪时不得打开可能为空的表单");
  assert.equal(loading.actions.addCustom, "disabled");

  const readOnly = modelConfig.buildSectionModel({
    open: true,
    status: "ready",
    addable: [{ provider: "fresh" }],
    protocols: ["openai-chat"],
    canCreateCustom: false,
    writable: false,
  });
  assert.equal(readOnly.actions.addProvider, "disabled");
  assert.equal(readOnly.actions.addCustom, "disabled");
});

test("模型配置：自定义创建入口需要 llm-pi-ai namespace、协议与整页可写", () => {
  const namespace = namespaceView("llm-pi-ai", { schema: PI_AI_SCHEMA });
  assert.equal(modelConfig.canCreateCustomProvider({ namespace, protocols: ["openai-chat"], writable: true }), true);
  assert.equal(modelConfig.canCreateCustomProvider({ namespace, protocols: [], writable: true }), false,
    "没有协议时不得打开无法提交的创建卡片");
  assert.equal(modelConfig.canCreateCustomProvider({ namespace: undefined, protocols: ["openai-chat"], writable: true }), false);
  assert.equal(modelConfig.canCreateCustomProvider({ namespace, protocols: ["openai-chat"], writable: false }), false,
    "整页只读时必须禁用");
});

test("模型配置回归：选择候选 provider 后写入空 profile 并归入已配置列表", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    const addButton = findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-provider"] === "true");
    assert.equal(addButton.props.disabled, false, "有可添加 provider 时入口必须可用");
    addButton.props.onClick();
    await mounted.modelHandle.settle();
    const select = findNode(mounted.modelHandle.output, (node) => node.props?.["aria-label"] === "选择要添加的 provider");
    assert.ok(select, "选择候选后必须出现 provider 选择器");
    assert.deepEqual(collectNodes(select, (node) => node.type === "option").map((node) => node.props.value),
      ["", "fresh"], "候选列表只包含未配置的 provider");
    select.props.onChange({ target: { value: "fresh" } });
    await mounted.modelHandle.settle();
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-confirm-add-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle(24);
    assert.deepEqual(workspace.calls.mutate.map((call) => call.ops), [[
      { op: "set", path: ["providers", "fresh"], value: {} },
    ]], "添加已知 provider 只写入空 profile");
    assert.ok(workspace.calls.listConfigurable >= 2, "写入成功后必须重新读取 provider 目录");
    assert.equal(workspace.nsView("llm-pi-ai").user.providers.fresh !== undefined, true, "用户层必须出现该 profile");
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：切换入口不会丢掉另一个入口已提交的 provider", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    const addEntry = findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-provider"] === "true");
    assert.ok(addEntry, "展开后必须能看到添加提供方入口");
    addEntry.props.onClick();
    await mounted.modelHandle.settle();
    assert.ok(findNode(mounted.modelHandle.output, (node) => node.props?.["aria-label"] === "选择要添加的 provider"));
    findNode(mounted.modelHandle.output, (node) => node.props?.["aria-label"] === "选择要添加的 provider").props.onChange({ target: { value: "fresh" } });
    await mounted.modelHandle.settle();
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-confirm-add-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle(24);
    assert.deepEqual(workspace.calls.mutate.map((call) => call.ops), [[
      { op: "set", path: ["providers", "fresh"], value: {} },
    ]], "已知 provider 只写入空 profile");
    // 切到自定义入口：选择流程关闭、创建卡片打开，已写入的 profile 不受影响。
    const customEntry = findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true");
    assert.ok(customEntry, "切换前必须能看到自定义入口");
    assert.equal(customEntry.props.disabled, false, "有协议且整页可写时自定义入口必须可用");
    customEntry.props.onClick();
    await mounted.modelHandle.settle();
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["aria-label"] === "选择要添加的 provider"), null,
      "打开自定义入口时关闭已知 provider 选择流程");
    // 创建卡片是与设置页同层的真实组件；替身渲染器不递归渲染子组件，因此这里用
    // "卡片是否作为元素出现"来断言入口确实打开了创建流程（卡片自身的行为由下面的
    // 自定义创建用例逐项覆盖）。
    assert.ok(findNode(mounted.modelHandle.output, (node) => node?.type?.name === "CustomProviderCard"),
      "必须打开自定义创建卡片");
    assert.equal(workspace.calls.mutate.length, 1, "切换入口不得产生额外写入");
    assert.equal(workspace.nsView("llm-pi-ai").user.providers.fresh !== undefined, true, "已提交的 provider 必须留在用户层");
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

// ── issue 03：自定义 provider 创建闭环 ──────────────────────────────────────

const CUSTOM_PROTOCOLS = ["openai-chat", "anthropic-messages"];

function customDraftFor(overrides = {}) {
  return modelConfig.createCustomProviderDraft({
    settingsNs: "llm-pi-ai",
    profileBasePath: ["providers"],
    revision: 3,
    protocols: CUSTOM_PROTOCOLS,
    takenRoutes: ["acme", "fresh"],
    models: [],
    ...overrides,
  });
}

const VALID_CUSTOM = Object.freeze({
  routeId: "my-gateway",
  displayName: "My Gateway",
  baseURL: "https://gateway.example.com/v1",
  api: "openai-chat",
  apiKey: "sk-gateway",
  models: [{ id: "gw-small", name: "Small" }],
});

test("模型配置：自定义 provider route id 采用原生兼容的字母/数字/连字符规则", () => {
  assert.equal(modelConfig.validateRouteId("my-gateway", []), null);
  assert.equal(modelConfig.validateRouteId("gw2", []), null);
  assert.equal(modelConfig.validateRouteId("a1-b2-c3", []), null);
  assert.match(modelConfig.validateRouteId(""), /请填写/);
  assert.match(modelConfig.validateRouteId("   "), /请填写/);
  assert.match(modelConfig.validateRouteId("A"), /至少 2 个字符|只允许/);
  assert.match(modelConfig.validateRouteId("has_underscore"), /只允许/);
  assert.match(modelConfig.validateRouteId("-leading"), /只允许/);
  assert.match(modelConfig.validateRouteId("trailing-"), /只允许/);
  assert.match(modelConfig.validateRouteId("has space"), /只允许/);
  assert.match(modelConfig.validateRouteId("a".repeat(65)), /最多 64/);
  assert.match(modelConfig.validateRouteId("acme", ["acme"]), /已存在/);
});

test("模型配置回归：route id 拒绝点号，且不同 route 折叠到同一凭据引用时必须拒绝", () => {
  // 点号会被 deriveKeyRef 折叠成连字符，`a.b` 与 `a-b` 会指向同一条凭据。
  assert.match(modelConfig.validateRouteId("a.b", []), /只允许/);
  assert.match(modelConfig.validateRouteId("api.example.com", []), /只允许/);
  assert.equal(modelConfig.deriveKeyRef("a.b"), modelConfig.deriveKeyRef("a-b"),
    "前提：这两个 route 确实折叠到同一个引用");
  assert.match(modelConfig.validateRouteId("a.b", ["a-b"]), /只允许/);

  // 已经占用的 route 若折叠出同一个引用，新 route 必须被拒绝（否则会复用别人的 API Key）。
  // 这条检查按引用比较，因此对不受新字符集约束的历史 route 同样生效。
  assert.match(modelConfig.validateRouteId("x-y", ["x.y"]), /同一个凭据引用/);
  assert.equal(modelConfig.deriveKeyRef("x-y"), modelConfig.deriveKeyRef("x.y"));
  assert.equal(modelConfig.validateRouteId("x-z", ["x.y"]), null, "不同引用不得互相拦");
  assert.equal(modelConfig.validateRouteId("ab", ["a-b"]), null, "连字符不会被折叠，不构成冲突");
  assert.equal(modelConfig.validateRouteId("my-gateway", ["other"]), null);
});

test("模型配置：自定义 provider Base URL 只接受 HTTP/HTTPS 且有主机名", () => {
  assert.equal(modelConfig.validateBaseUrl("https://api.example.com/v1"), null);
  assert.equal(modelConfig.validateBaseUrl("http://localhost:8080"), null);
  assert.equal(modelConfig.validateBaseUrl("https://[::1]:8443/v1"), null);
  assert.match(modelConfig.validateBaseUrl(""), /请填写/);
  assert.match(modelConfig.validateBaseUrl("api.example.com"), /不是合法的 URL/);
  assert.match(modelConfig.validateBaseUrl("ftp://api.example.com"), /http/);
  assert.match(modelConfig.validateBaseUrl("https://"), /不是合法的 URL/);
});

test("模型配置回归：Base URL 用 URL 解析器拒绝非法端口、未闭合 IPv6 与缺失主机", () => {
  assert.match(modelConfig.validateBaseUrl("https://host:99999"), /不是合法的 URL|端口/);
  assert.match(modelConfig.validateBaseUrl("https://host:abc"), /不是合法的 URL/);
  assert.match(modelConfig.validateBaseUrl("https://[::1"), /不是合法的 URL/);
  assert.match(modelConfig.validateBaseUrl("https://[zzzz]"), /不是合法的 URL/);
  assert.match(modelConfig.validateBaseUrl("http://:8080"), /不是合法的 URL|主机名/);
  assert.match(modelConfig.validateBaseUrl("https://user@:8443"), /不是合法的 URL|主机名/);
  assert.equal(modelConfig.validateBaseUrl("https://api.example.com:65535"), null);
  assert.equal(modelConfig.validateBaseUrl("http://127.0.0.1:1"), null);
});

test("模型配置：自定义 provider 协议必须来自宿主 schema 词表", () => {  assert.equal(modelConfig.validateProtocol("openai-chat", CUSTOM_PROTOCOLS), null);
  assert.match(modelConfig.validateProtocol("", CUSTOM_PROTOCOLS), /请选择协议/);
  assert.match(modelConfig.validateProtocol("made-up", CUSTOM_PROTOCOLS), /不在宿主支持/);
  assert.match(modelConfig.validateProtocol("openai-chat", []), /没有提供可用的协议/);
});

test("模型配置：自定义 provider 草稿校验必须给出逐字段错误且不生成可提交 profile", () => {
  const empty = modelConfig.validateCustomProviderDraft({
    routeId: "", displayName: "", baseURL: "", api: "", models: [],
    protocols: CUSTOM_PROTOCOLS, takenRoutes: [],
  });
  assert.equal(empty.ok, false);
  assert.deepEqual(Object.keys(empty.errors).sort(), ["api", "baseURL", "models", "routeId"]);
  assert.deepEqual(empty.profile, {}, "校验失败时不得生成 profile");

  const badUrl = modelConfig.validateCustomProviderDraft({
    ...VALID_CUSTOM, baseURL: "not-a-url",
  });
  assert.equal(badUrl.ok, false);
  assert.match(badUrl.errors.baseURL, /不是合法的 URL/);

  const duplicateModels = modelConfig.validateCustomProviderDraft({
    ...VALID_CUSTOM, models: [{ id: "dup" }, { id: "dup" }],
  });
  assert.equal(duplicateModels.ok, false);
  assert.match(duplicateModels.errors.models, /重复/);

  const badCapacity = modelConfig.validateCustomProviderDraft({
    ...VALID_CUSTOM, models: [{ id: "m", contextWindow: 0 }],
  });
  assert.equal(badCapacity.ok, false);
  assert.match(badCapacity.errors.models, /上下文窗口/);

  const noModels = modelConfig.validateCustomProviderDraft({ ...VALID_CUSTOM, models: [] });
  assert.equal(noModels.ok, false);
  assert.match(noModels.errors.models, /至少配置一个模型/);

  const valid = modelConfig.validateCustomProviderDraft({
    ...VALID_CUSTOM, protocols: CUSTOM_PROTOCOLS, takenRoutes: ["acme"],
  });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.profile, {
    apiKeyEnv: "MY_GATEWAY_API_KEY",
    displayName: "My Gateway",
    baseURL: "https://gateway.example.com/v1",
    api: "openai-chat",
    models: [{ id: "gw-small", name: "Small" }],
  });
  assert.equal(JSON.stringify(valid.profile).includes("sk-gateway"), false, "API Key 明文绝不进入 profile");
  assert.equal(valid.profile.apiKeyEnv, "MY_GATEWAY_API_KEY", "填了 API Key 才写凭据引用");
});

test("模型配置：自定义 provider 状态机把 settings 与 credentials 分成两个阶段", () => {
  const draft = customDraftFor();
  const empty = draft.plan();
  assert.equal(empty.ok, false);
  assert.match(empty.error, /请填写/);
  draft.edit(VALID_CUSTOM);
  const planned = draft.plan();
  assert.equal(planned.ok, true);
  assert.equal(planned.phase, "settings");
  assert.equal(planned.expectedRevision, 3, "提交必须携带打开时读到的 revision");
  assert.deepEqual(planned.ops, [{
    op: "set",
    path: ["providers", "my-gateway"],
    value: {
      apiKeyEnv: "MY_GATEWAY_API_KEY",
      displayName: "My Gateway",
      baseURL: "https://gateway.example.com/v1",
      api: "openai-chat",
      models: [{ id: "gw-small", name: "Small" }],
    },
  }]);
  assert.equal(planned.credentialRef, "MY_GATEWAY_API_KEY");
  assert.equal(planned.keyValue, "sk-gateway");

  // settings 成功后：只重试 credentials，绝不重复 settings mutate。
  draft.acceptSettings({
    revision: 4,
    user: { providers: { "my-gateway": planned.ops[0].value } },
    value: { providers: { "my-gateway": planned.ops[0].value } },
  });
  const retry = draft.plan();
  assert.equal(retry.ok, true);
  assert.equal(retry.ops, undefined, "重试阶段不得再产生 settings 操作");
  assert.equal(retry.credentialRef, "MY_GATEWAY_API_KEY");
  // 明文在 settings 成功后仍然保留：这是"只重试凭据写入"的前提。
  assert.equal(retry.keyValue, "sk-gateway");
  assert.equal(retry.expectedRevision, undefined, "重试阶段不带 revision 栅栏");
  assert.equal(draft.revision, 4, "接受权威视图后 revision 前进");
  // 重复 plan() 仍然是同一个"只写凭据"的结论。
  assert.deepEqual(draft.plan(), retry);
  draft.acceptCredential();
  const done = draft.plan();
  assert.equal(done.phase, "done");
  assert.equal(done.ops, undefined);
  assert.equal(done.keyValue, undefined, "凭据写入成功后必须丢掉明文");
});

test("模型配置：自定义 provider 没有 API Key 时不需要 credentials 阶段", () => {
  const draft = customDraftFor();
  draft.edit({ ...VALID_CUSTOM, apiKey: "" });
  const planned = draft.plan();
  assert.equal(planned.phase, "settings");
  assert.equal(planned.keyValue, undefined);
  draft.acceptSettings({ revision: 4 });
  assert.equal(draft.plan().phase, "done");
});

test("模型配置：自定义创建卡片渲染面对应原生字段顺序与禁用语义", () => {
  const draft = customDraftFor();
  draft.edit({ routeId: "My_Gateway", baseURL: "nope", models: [] });
  const validation = draft.validate();
  const card = modelConfig.buildCustomCardModel({
    draft: draft.draft,
    protocols: CUSTOM_PROTOCOLS,
    errors: validation.errors,
    error: validation.error,
  });
  assert.equal(card.title, "添加自定义提供方");
  assert.equal(card.routeId.value, "My_Gateway");
  assert.match(card.routeId.error, /只允许/);
  assert.match(card.baseUrl.error, /不是合法的 URL/);
  assert.match(card.modelsError, /至少配置一个模型/);
  assert.equal(card.protocol.options.length, 2);
  assert.equal(card.apiKey.type, "password");
  assert.equal(card.apiKey.autoComplete, "off");
  assert.equal(card.models.length, 0);

  const readOnly = modelConfig.buildCustomCardModel({ draft: VALID_CUSTOM, protocols: CUSTOM_PROTOCOLS, readOnly: true });
  assert.equal(readOnly.readOnly, true);
  assert.equal(readOnly.actions.submit, "disabled");
  assert.equal(readOnly.actions.addModel, "disabled");
  assert.equal(readOnly.apiKey.disabled, true);
  // 只读时仍展示已填字段（可查看）。
  assert.equal(readOnly.routeId.value, "my-gateway");
  assert.equal(readOnly.baseUrl.value, "https://gateway.example.com/v1");
});

test("模型配置回归：自定义 provider 全部字段为空或非法时绝不调用 settings mutate", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    assert.deepEqual(workspace.calls.mutate, [], "空草稿不得触发 settings 写入");
    assert.deepEqual(workspace.calls.credentialSet, [], "空草稿不得触发 credentials 写入");
    assert.ok(findNode(create.output, (node) => node.props?.["data-deg-create-error"] === "routeId"));

    // 非法 Base URL：仍然不得写入。每步都重新查找字段（草稿变化会让旧引用失效）。
    findNode(create.output, (node) => node.props?.["data-deg-create-route"] === "true").props.onChange({ target: { value: "my-gateway" } });
    await create.settle();
    findNode(create.output, (node) => node.props?.["data-deg-create-base-url"] === "true").props.onChange({ target: { value: "ftp://x" } });
    await create.settle();
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    assert.deepEqual(workspace.calls.mutate, [], "非法 Base URL 不得触发 settings 写入");
    assert.ok(findNode(create.output, (node) => node.props?.["data-deg-create-error"] === "baseUrl"),
      "非法 Base URL 必须在该字段旁给出错误：" + JSON.stringify(
        collectNodes(create.output, (node) => node.props?.["data-deg-create-error"] !== undefined)
          .map((node) => node.props["data-deg-create-error"]),
      ));
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

/**
 * 在创建卡片上填写一个完整合法的自定义 provider。
 * @param {object} create - 已渲染的 CustomProviderCard 句柄
 */
async function fillCustomProvider(create, overrides = {}) {
  const values = { ...VALID_CUSTOM, ...overrides };
  const setField = async (key, value) => {
    const input = findNode(create.output, (node) => node.props?.[key] === "true");
    assert.ok(input, "找不到字段 " + key);
    input.props.onChange({ target: { value } });
    await create.settle();
  };
  await setField("data-deg-create-route", values.routeId);
  await setField("data-deg-create-name", values.displayName);
  await setField("data-deg-create-base-url", values.baseURL);
  await setField("data-deg-create-api-key", values.apiKey);
  const protocol = findNode(create.output, (node) => node.props?.["data-deg-create-protocol"] === "true");
  protocol.props.onChange({ target: { value: values.api } });
  await create.settle();
  for (const [index, model] of values.models.entries()) {
    if (findNode(create.output, (node) => node.props?.["data-deg-create-model-id"] === index) === null) {
      findNode(create.output, (node) => node.props?.["data-deg-create-add-model"] === "true").props.onClick();
      await create.settle();
    }
    findNode(create.output, (node) => node.props?.["data-deg-create-model-id"] === index)
      .props.onChange({ target: { value: model.id } });
    await create.settle();
    if (typeof model.name === "string" && model.name.length > 0) {
      findNode(create.output, (node) => node.props?.["aria-label"] === "自定义 provider 模型显示名 " + String(index + 1))
        .props.onChange({ target: { value: model.name } });
      await create.settle();
    }
  }
}

test("模型配置回归：自定义 provider 从当前表单探测模型并通过原生选择弹窗采纳勾选项", async () => {
  const workspace = workspacesForRender({
    discovered: [
      { id: "deepseek-v4.1-flash", name: "Flash" },
      { id: "glm-5.3" },
      { id: "glm-5.3-flash" },
    ],
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create, { models: [] });

    const fetchButton = findNode(create.output, (node) => node.props?.["data-deg-create-fetch-models"] === "true");
    assert.ok(fetchButton, "自定义 provider 必须提供获取可用模型按钮");
    assert.equal(fetchButton.props.disabled, false, "填写合法 Base URL 后探测按钮必须可用");
    fetchButton.props.onClick();
    await create.settle(24);

    assert.deepEqual(workspace.calls.discover, [{
      ns: "llm-pi-ai",
      request: {
        baseURL: "https://gateway.example.com/v1",
        api: "openai-chat",
        apiKey: "sk-gateway",
      },
    }], "探测必须使用当前表单的端点、协议和未保存 API Key");
    const dialogElement = findNode(create.output, (node) => node?.type?.name === "ModelDiscoveryDialog");
    assert.ok(dialogElement, "探测成功后必须打开模型选择弹窗");
    const dialogHandle = runtime.render(dialogElement.type, dialogElement.props);
    await dialogHandle.settle();
    assert.ok(findNode(dialogHandle.output, (node) => node.type === "h3" && node.props?.children === "选择要添加的模型"));
    assert.ok(findNode(dialogHandle.output, (node) => node.type === "p"
      && node.props?.children === "以下是模型提供方的可用模型，勾选要添加的模型。"));

    const candidateInputs = () => collectNodes(dialogHandle.output, (node) => node.props?.["data-deg-create-candidate"] !== undefined);
    assert.equal(candidateInputs().length, 3);
    assert.equal(candidateInputs().every((node) => node.props.checked === true), true,
      "尚未配置的探测模型默认全部勾选");

    // 无搜索时全部候选都可见：可见项已全选，因此「取消全选」等价于清空全部选择。
    const deselectAll = findNode(dialogHandle.output, (node) => node.type === "button" && node.props?.children === "取消全选");
    assert.ok(deselectAll);
    deselectAll.props.onClick();
    await create.settle();
    let currentDialog = findNode(create.output, (node) => node?.type?.name === "ModelDiscoveryDialog");
    assert.deepEqual(currentDialog.props.candidates.map((candidate) => [candidate.id, candidate.picked]),
      [["deepseek-v4.1-flash", false], ["glm-5.3", false], ["glm-5.3-flash", false]],
      "取消全选必须清空全部候选的选择");

    currentDialog.props.onToggle(currentDialog.props.candidates[0].id);
    await create.settle();
    currentDialog = findNode(create.output, (node) => node?.type?.name === "ModelDiscoveryDialog");
    assert.deepEqual(currentDialog.props.candidates.filter((candidate) => candidate.picked === true).map((candidate) => candidate.id), ["deepseek-v4.1-flash"]);
    currentDialog.props.onAdopt();
    await create.settle();

    assert.equal(findNode(create.output, (node) => node?.type?.name === "ModelDiscoveryDialog"), null, "采纳后弹窗必须关闭");
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-model-id"] === 0).props.value, "deepseek-v4.1-flash",
      "只应把用户勾选的候选加入模型草稿");
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-model-id"] === 1), null,
      "未勾选候选不得自动加入模型草稿");
    assert.deepEqual(workspace.calls.mutate, [], "探测和采纳候选不得绕过创建按钮直接写 settings");
    dialogHandle.unmount();
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});


test("模型配置回归：自定义 provider 创建成功写入 profile 与凭据并刷新为已配置 provider", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    assert.equal(workspace.calls.mutate.length, 1, "profile 只写一次");
    const [call] = workspace.calls.mutate;
    assert.equal(call.ns, "llm-pi-ai");
    assert.equal(call.expectedRevision, 2, "创建必须带打开时的 revision");
    assert.deepEqual(call.ops, [{
      op: "set",
      path: ["providers", "my-gateway"],
      value: {
        apiKeyEnv: "MY_GATEWAY_API_KEY",
        displayName: "My Gateway",
        baseURL: "https://gateway.example.com/v1",
        api: "openai-chat",
        models: [{ id: "gw-small", name: "Small" }],
      },
    }]);
    assert.deepEqual(workspace.calls.credentialSet, [["MY_GATEWAY_API_KEY", "sk-gateway"]], "API Key 单独写 credentials");
    assert.equal(JSON.stringify(workspace.nsView("llm-pi-ai").user).includes("sk-gateway"), false,
      "API Key 明文绝不进入 settings");
    assert.deepEqual(workspace.nsView("llm-pi-ai").user.providers["my-gateway"].models.map((model) => model.id), ["gw-small"]);
    assert.ok(workspace.calls.listConfigurable >= 2, "创建成功后必须重新读取 provider 目录");
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-custom-provider"] === "true"), null,
      "创建成功后必须关闭创建卡片");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：自定义 provider 二阶段 credentials 失败后重试只重试凭据写入", async () => {
  const workspace = workspacesForRender({
    credentialSetFailure: ({ attempt }) => (attempt === 1 ? "credentials 服务暂时不可用" : undefined),
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    const retryButton = () => findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true");
    retryButton().props.onClick();
    await create.settle(24);

    assert.equal(workspace.calls.mutate.length, 1, "settings 阶段成功");
    assert.equal(workspace.calls.credentialSet.length, 1, "credentials 阶段失败一次");
    const failure = findNode(create.output, (node) => node.props?.["data-deg-create-card-error"] === "true");
    assert.ok(failure, "credentials 失败必须显示可行动错误");
    assert.match(failure.props.children, /API Key/);
    assert.match(retryButton().props.children, /重试/, "按钮必须表达可以只重试凭据写入");
    // 重试：settings 阶段必须被跳过，只重试 credentials。
    retryButton().props.onClick();
    await create.settle(24);
    assert.equal(workspace.calls.mutate.length, 1, "重试不得重复 settings mutate");
    assert.equal(workspace.calls.credentialSet.length, 2, "重试只重试 credentials");
    assert.deepEqual(workspace.calls.credentialSet[1], ["MY_GATEWAY_API_KEY", "sk-gateway"]);
    assert.equal(workspace.credentials.get("MY_GATEWAY_API_KEY").configured, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-card-error"] === "true"), null,
      "重试成功后必须清除错误");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：自定义 provider revision 冲突时不写凭据也不覆盖已有 profile", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    // 打开卡片后外部（另一个会话/页面）推进了同一个命名空间的 revision。
    workspace.setRevision("llm-pi-ai", 9);
    harness.setDescribeView(workspace.viewsNow());
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);

    assert.equal(workspace.calls.mutate.length, 1, "提交仍然发出，但宿主必须拒绝");
    assert.equal(workspace.calls.mutate[0].expectedRevision, 2);
    assert.deepEqual(workspace.calls.credentialSet, [], "冲突时不得写入凭据");
    const failure = findNode(create.output, (node) => node.props?.["data-deg-create-card-error"] === "true");
    assert.ok(failure, "冲突必须显示错误");
    assert.match(failure.props.children, /revision|冲突/);
    assert.equal(workspace.nsView("llm-pi-ai").user.providers?.["my-gateway"], undefined, "冲突不得覆盖已有 profile");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：取消自定义创建丢弃全部草稿且不产生任何写入", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    findNode(create.output, (node) => node.props?.["data-deg-create-cancel"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-custom-provider"] === "true"), null,
      "取消必须关闭创建卡片");
    assert.deepEqual(workspace.calls.mutate, []);
    assert.deepEqual(workspace.calls.credentialSet, []);
    // 再次打开必须是全新草稿（不残留上一次输入）。
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    const reopened = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    assert.equal(findNode(reopened.output, (node) => node.props?.["data-deg-create-route"] === "true").props.value, "");
    reopened.unmount();
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：自定义创建卡片复用七档档位、容量与输入类型语义", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    findNode(create.output, (node) => node.props?.["data-deg-create-add-model"] === "true").props.onClick();
    await create.settle();
    findNode(create.output, (node) => node.props?.["aria-label"] === "模型高级设置 1").props.onClick();
    await create.settle();
    const efforts = collectNodes(create.output, (node) => node.props?.["data-deg-effort"] !== undefined);
    assert.deepEqual(efforts.map((node) => node.props["data-deg-effort"]),
      ["off", "minimal", "low", "medium", "high", "xhigh", "max"], "自定义卡片必须复用七档词表与顺序");
    assert.deepEqual(efforts.map((node) => node.props.checked), [false, false, false, false, false, false, false],
      "新模型七档必须全部不勾选");
    assert.deepEqual(collectNodes(create.output, (node) => node.props?.["data-deg-input"] !== undefined)
      .map((node) => node.props["data-deg-input"]), ["text", "image"]);
    assert.ok(findNode(create.output, (node) => node.props?.["aria-label"] === "上下文窗口 1"));
    assert.ok(findNode(create.output, (node) => node.props?.["aria-label"] === "最大输出 token 1"));
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：自定义 provider 缺少 llm-pi-ai namespace 或协议时入口禁用", async () => {
  const noNamespace = workspacesForRender({ namespaces: [namespaceView(EMPTY_NAMESPACE, { schema: PI_AI_SCHEMA })] });
  const noProtocols = workspacesForRender({
    namespaces: [namespaceView("llm-pi-ai", { schema: LOOSE_SCHEMA })],
  });
  const runtime = createClientReactRuntime();
  for (const [label, workspace] of [["缺少 namespace", noNamespace], ["缺少协议词表", noProtocols]]) {
    const harness = createHarness(workspace);
    let mounted = null;
    try {
      mounted = await openModelSection(harness, runtime);
      const entry = findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true");
      assert.ok(entry, label + "：入口仍必须显示（可发现性）");
      assert.equal(entry.props.disabled, true, label + "：入口必须禁用，不能打开无法提交的卡片");
      entry.props.onClick();
      await mounted.modelHandle.settle();
      assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-custom-provider"] === "true"), null,
        label + "：禁用入口不得打开创建卡片");
    } finally {
      mounted?.unmount();
      harness.dispose();
    }
  }
});

test("模型配置：目录读取失败时显示错误与重试入口，且自定义入口不可提交", async () => {
  const workspace = workspacesForRender();
  workspace.remote.llm.listConfigurableProviders = async () => ({ ok: false, error: { message: "provider 目录不可用" } });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    assert.ok(findNode(mounted.modelHandle.output, (node) => node.props?.children === "provider 目录不可用"),
      "目录失败必须显示明确错误");
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-provider"] === "true").props.disabled, true);
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.disabled, true);
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-reload-providers"] === "true").props.disabled, false,
      "必须提供重试入口");
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

// ── 运行时缺陷回归：刷新环、栅栏漂移、凭据错配、空密钥、取消可见性 ─────────────

test("模型配置回归：展开后主动重读不得自激成刷新环", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    // 展开只读取一轮目录；内部 refreshSettingsView 推进视图版本，但绝不能再触发同一
    // 加载 effect（否则 load -> refresh -> notify -> load 会无限循环）。
    assert.equal(workspace.calls.listConfigurable, 1, "展开一次只加载一轮目录");
    await mounted.modelHandle.settle(32);
    assert.equal(workspace.calls.listConfigurable, 1, "settle 过程中不得出现额外的目录读取");
    assert.equal(workspace.calls.credentialDescribe.length, 1, "凭据状态同样只读一次");
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：外部 mirror 事件触发且只触发一次重新加载", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    assert.equal(workspace.calls.listConfigurable, 1);
    workspace.emit("settings/document-updated");
    await mounted.modelHandle.settle(32);
    assert.equal(workspace.calls.listConfigurable, 2, "一次外部失效恰好触发一次重新加载");
    assert.equal(workspace.calls.credentialDescribe.length, 2);
    // 再来一次外部失效，仍然是"一次事件、一次加载"。
    workspace.emit("credentials/reference-updated");
    await mounted.modelHandle.settle(32);
    assert.equal(workspace.calls.listConfigurable, 3);
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：折叠状态下收到外部事件不得读取目录", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let handle = null;
  try {
    const opened = await openSettings(harness, runtime);
    handle = opened.handle;
    const modelElement = (opened.handle.output?.props?.children ?? []).find((node) => node?.type?.name === "ModelConfigSection");
    const modelHandle = runtime.render(modelElement.type, modelElement.props);
    await modelHandle.settle();
    assert.equal(workspace.calls.listConfigurable, 0, "默认折叠时不得读取 provider 目录");
    workspace.emit("settings/document-updated");
    await modelHandle.settle(32);
    assert.equal(workspace.calls.listConfigurable, 0, "折叠时外部事件不得触发目录读取");
    modelHandle.unmount();
  } finally {
    handle?.unmount();
    harness.dispose();
  }
});

test("模型配置：settings 视图缺失时整页回退为只读", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  try {
    mounted = await openModelSection(harness, runtime);
    const host = modelConfigHostOf(harness, mounted.configForms);
    await host.refreshSettingsView();
    assert.equal(host.readView().writable, true);
    // 视图消失（连接抖动、命名空间暂不可用）：必须显式落回只读，不能把过期可写状态留下。
    harness.setDescribeView(undefined);
    await host.refreshSettingsView();
    assert.equal(host.readView().writable, false, "读不到视图时必须按只读处理");
    assert.deepEqual(host.readView().namespaces, []);
  } finally {
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：创建卡片的 revision 栅栏在写盘前可纠正、写盘后冻结", () => {
  const draft = customDraftFor();
  draft.edit(VALID_CUSTOM);
  assert.equal(draft.revision, 3);
  // 写盘之前：允许用最新 revision 纠正（覆盖"打开卡片时 Describe 视图还没更新"）。
  draft.rebase({ revision: 9 });
  assert.equal(draft.revision, 9, "写盘前的纠正必须生效");
  assert.equal(draft.plan().expectedRevision, 9);
  // 写盘之后：一切都冻结，只允许重试凭据；后续 rebase 不得改写 revision。
  const planned = draft.plan();
  draft.acceptSettings({ revision: 10 }, planned.credentialRef);
  assert.equal(draft.revision, 10);
  draft.rebase({ revision: 99 });
  assert.equal(draft.revision, 10, "写盘后 revision 不得再变");
  assert.equal(draft.plan().expectedRevision, undefined, "凭据阶段不带栅栏");
  // 显式 frozen：一旦定稿（首次提交过），rebase 不再纠正 revision。
  const frozen = customDraftFor();
  frozen.edit(VALID_CUSTOM);
  frozen.rebase({ revision: 7, frozen: true });
  assert.equal(frozen.revision, 7, "定稿时贴上的 revision 生效");
  frozen.rebase({ revision: 42 });
  assert.equal(frozen.revision, 7, "已定稿的栅栏不得被覆盖");
  // 首次 namespace 还没就绪：允许从 undefined 初始化。
  const late = modelConfig.createCustomProviderDraft({
    settingsNs: "llm-pi-ai", profileBasePath: ["providers"], protocols: CUSTOM_PROTOCOLS, models: [],
  });
  assert.equal(late.revision, undefined);
  late.rebase({ revision: 2 });
  assert.equal(late.revision, 2, "首次初始化允许");
  // takenRoutes 任何时候都同步：同步进来的 route 必须参与去重判定。
  late.edit({ routeId: "aa", baseURL: "https://x.example.com/v1", api: "openai-chat", models: [{ id: "m" }] });
  assert.equal(late.validate().errors.routeId, undefined, "未占用的 route 通过");
  late.rebase({ revision: 7, takenRoutes: ["aa", "bb"] });
  assert.match(late.validate().errors.routeId, /已存在/, "同步进来的 route 必须参与去重");
  late.edit({ routeId: "cc" });
  assert.equal(late.validate().errors.routeId, undefined);
});

test("模型配置回归：外部推进 revision 后创建提交仍用固定栅栏并被宿主拒绝", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    // 另一个会话写入后推进 revision，并让 mirror 事件到达本页面。
    workspace.setUser("llm-pi-ai", { providers: { acme: { models: [{ id: "m1" }] }, other: {} } });
    harness.setDescribeView(workspace.viewsNow());
    workspace.emit("settings/document-updated");
    // 外部失效必须先被区域观察到，否则卡片无从判断这次 revision 变化是并发还是自己打开得太早。
    await mounted.modelHandle.settle(24);
    assert.ok(workspace.calls.listConfigurable >= 2, "外部事件必须触发一次重新加载");
    await create.settle(24);
    const fenceState = findNode(mounted.modelHandle.output, (node) => node?.type?.name === "CustomProviderCard")?.props?.fenceState;
    assert.equal(fenceState?.external, true, "区域必须把这次外部失效告诉卡片");

    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    // 卡片打开时的栅栏是 2，外部写入把它推进到 3：本地 CAS 前置检查就必须拒绝，
    // 因此这一次提交不会发到宿主（发出也只会被宿主的 revision 语义拒绝）。
    assert.equal(workspace.calls.mutate.length, 0, "陈旧栅栏必须在本地前置检查就被拒绝");
    assert.deepEqual(workspace.calls.credentialSet, [], "冲突时不得写入凭据");
    assert.equal(workspace.nsView("llm-pi-ai").user.providers["my-gateway"], undefined, "冲突不得覆盖别人的写入");
    assert.match(
      findNode(create.output, (node) => node.props?.["data-deg-create-card-error"] === "true")?.props?.children ?? "",
      /重新打开/,
      "必须提示用户重新打开卡片",
    );
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：custom provider 打开时锁定当前 namespace revision", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    workspace.setRevision("llm-pi-ai", 5);
    harness.setDescribeView(workspace.viewsNow());
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    assert.equal(workspace.calls.mutate.length, 1, "提交必须发出：" + String(
      findNode(create.output, (node) => node.props?.["data-deg-create-card-error"] === "true")?.props?.children,
    ));
    assert.equal(workspace.calls.mutate[0].expectedRevision, 5,
      "打开入口时会主动重读 namespace，栅栏必须是那一刻的 revision");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：API Key 留空时创建不写凭据引用也不调用 credentials", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create, { apiKey: "" });
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);

    assert.equal(workspace.calls.mutate.length, 1);
    const profile = workspace.calls.mutate[0].ops[0].value;
    assert.equal("apiKeyEnv" in profile, false, "留空时不得写入 apiKeyEnv");
    assert.deepEqual(workspace.calls.credentialSet, [], "留空时不得调用 credentials.set");
    assert.deepEqual(workspace.nsView("llm-pi-ai").user.providers["my-gateway"], profile);
    assert.ok(workspace.calls.listConfigurable >= 2, "创建成功后仍然要刷新目录");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：settings 已提交但凭据失败后，profile 字段锁定且重试固定原 route", async () => {
  const workspace = workspacesForRender({
    credentialSetFailure: ({ attempt }) => (attempt === 1 ? "credentials 服务暂时不可用" : undefined),
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);

    // profile 已经落盘、凭据失败：route 与凭据引用必须锁定，防止"旧 profile + 新 route 凭据"错配。
    const route = findNode(create.output, (node) => node.props?.["data-deg-create-route"] === "true");
    assert.equal(route.props.disabled, true, "已提交后 route 不可再编辑");
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-base-url"] === "true").props.disabled, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-name"] === "true").props.disabled, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-protocol"] === "true").props.disabled, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-add-model"] === "true").props.disabled, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-model-id"] === 0).props.disabled, true);
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-api-key"] === "true").props.disabled, false,
      "API Key 必须仍然可以重试");
    assert.equal(findNode(create.output, (node) => node.props?.["data-deg-create-cancel"] === "true").props.disabled, false);

    // 已提交的引用必须固定：即使拿到状态机再改 route，也不会换引用。
    const cardDraft = create.props?.draft
      ?? findNode(mounted.modelHandle.output, (node) => node?.type?.name === "CustomProviderCard")?.props?.draft;
    assert.ok(cardDraft, "必须能从创建卡片拿到状态机");
    cardDraft.edit({ routeId: "someone-else" });
    assert.equal(cardDraft.credentialRef, "MY_GATEWAY_API_KEY", "已提交的引用必须固定");
    await create.settle();
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    assert.equal(workspace.calls.mutate.length, 1, "重试不得重复 settings mutate");
    assert.deepEqual(workspace.calls.credentialSet.map(([ref]) => ref),
      ["MY_GATEWAY_API_KEY", "MY_GATEWAY_API_KEY"], "两次凭据写入必须用同一个引用");
    assert.equal(workspace.credentials.get("SOMEONE_ELSE_API_KEY"), undefined, "不得写到别的引用上");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：state machine 在 settingsCommitted 后拒绝除 API Key 之外的编辑", () => {
  const draft = customDraftFor();
  draft.edit(VALID_CUSTOM);
  const planned = draft.plan();
  draft.acceptSettings({ revision: 4 }, planned.credentialRef);
  assert.equal(draft.credentialRef, "MY_GATEWAY_API_KEY");
  assert.equal(draft.draft.routeId, "my-gateway");
  draft.edit({ routeId: "other-route", baseURL: "https://evil.example.com", models: [{ id: "x" }] });
  assert.equal(draft.draft.routeId, "my-gateway", "已提交的 route 必须冻结");
  assert.equal(draft.draft.baseURL, "https://gateway.example.com/v1");
  assert.deepEqual(draft.draft.models.map((model) => model.id), ["gw-small"]);
  draft.edit({ apiKey: "sk-rotated" });
  assert.equal(draft.draft.apiKey, "sk-rotated", "API Key 是唯一允许继续修改的字段");
  const retry = draft.plan();
  assert.equal(retry.phase, "credentials");
  assert.equal(retry.credentialRef, "MY_GATEWAY_API_KEY", "重试阶段引用必须固定");
  assert.equal(retry.ops, undefined);
  // 显式传入的引用优先：调用方可以用它把提交时的引用固定下来。
  const other = customDraftFor();
  other.edit(VALID_CUSTOM);
  other.acceptSettings({ revision: 4 }, "FROZEN_REF");
  assert.equal(other.credentialRef, "FROZEN_REF");
  assert.equal(other.plan().credentialRef, "FROZEN_REF");
});

test("模型配置回归：settings 已提交后取消，父区域主动重读让半完成 provider 立即可见", async () => {
  const workspace = workspacesForRender({
    credentialSetFailure: ({ attempt }) => (attempt === 1 ? "credentials 服务暂时不可用" : undefined),
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    findNode(create.output, (node) => node.props?.["data-deg-create-submit"] === "true").props.onClick();
    await create.settle(24);
    const loadsBeforeCancel = workspace.calls.listConfigurable;

    // 让新 provider 出现在目录里（真实宿主在写入后就会这样）。
    workspace.setDirectory("llm-pi-ai", { provider: "my-gateway", displayName: "My Gateway" });
    findNode(create.output, (node) => node.props?.["data-deg-create-cancel"] === "true").props.onClick();
    await mounted.modelHandle.settle(24);
    assert.ok(workspace.calls.listConfigurable > loadsBeforeCancel,
      "已提交的草稿取消时必须主动重读目录");
    assert.equal(findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-custom-provider"] === "true"), null,
      "取消必须关闭创建卡片");
    assert.equal(workspace.nsView("llm-pi-ai").user.providers["my-gateway"] !== undefined, true,
      "已写入的 profile 必须保留");
    assert.ok(findNode(mounted.modelHandle.output, (node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "my-gateway"),
    "半完成的 provider 必须立刻出现在已配置列表里");
    assert.ok(workspace.calls.credentialDescribe.at(-1).includes("MY_GATEWAY_API_KEY"),
      "刷新后的卡片必须按 provider 推导凭据引用：" + JSON.stringify(workspace.calls.credentialDescribe.at(-1)));
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：未提交的草稿取消不写入，也不额外重读目录", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create);
    const loadsBeforeCancel = workspace.calls.listConfigurable;
    findNode(create.output, (node) => node.props?.["data-deg-create-cancel"] === "true").props.onClick();
    await mounted.modelHandle.settle(24);
    assert.deepEqual(workspace.calls.mutate, [], "未提交草稿取消不得写入");
    assert.deepEqual(workspace.calls.credentialSet, []);
    assert.equal(workspace.calls.listConfigurable, loadsBeforeCancel, "未提交草稿取消不必重读目录");
  } finally {
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

// ── 卡片折叠/编辑入口、候选弹窗与自动发现竞态 ────────────────────────────────

/** 把已挂载的 provider 卡片从折叠态点开（复用真实「编辑」按钮，不触碰组件内部状态）。 */
async function expandProviderCard(card) {
  const edit = findNode(card.output, (node) => node.type === "button" && node.props?.children === "编辑");
  assert.ok(edit, "折叠态必须提供编辑入口");
  edit.props.onClick();
  await card.settle();
}

/** 渲染一张已配置 provider 的卡片并进入编辑态（沿用 openModelSection 的 mount seam）。 */
async function openProviderCard(mounted, provider) {
  const card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard"
    && node.props?.row?.provider === provider);
  await expandProviderCard(card);
  return card;
}

/** 卡片当前草稿里的模型行 id（按渲染顺序读「模型 ID N」输入框）。 */
function modelIdsOf(card) {
  return collectNodes(card.output, (node) => node.type === "input"
    && typeof node.props?.["aria-label"] === "string"
    && node.props["aria-label"].startsWith("模型 ID "))
    .map((node) => node.props.value);
}

/** 卡片渲染出的候选弹窗元素（每次重新查找：草稿变化会让旧节点引用失效）。 */
function discoveryDialogOf(card) {
  return findNode(card.output, (node) => node?.type?.name === "ModelDiscoveryDialog");
}

/** materialize 候选弹窗（渲染替身只渲染一层，子组件需要显式渲染）。 */
async function mountDiscoveryDialog(runtime, card) {
  const element = discoveryDialogOf(card);
  assert.ok(element, "获取模型成功后必须渲染候选弹窗");
  const handle = runtime.render(element.type, element.props);
  await handle.settle();
  return handle;
}

/** 弹窗里当前可见的候选复选框（按渲染顺序）。 */
function candidateBoxesOf(dialog) {
  return collectNodes(dialog.output, (node) => node.props?.["data-deg-create-candidate"] !== undefined);
}

test("模型配置：折叠态 provider 卡片的编辑按钮排在删除按钮之前", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard" && node.props?.row?.provider === "acme");
    // 折叠态只渲染头部动作：破坏性的「删除」必须排在「编辑」之后。
    const actions = collectNodes(card.output, (node) => node.type === "button");
    assert.deepEqual(actions.map((node) => node.props.children), ["编辑", "删除"],
      "折叠态必须同时给出编辑与删除，且编辑在前");
    assert.deepEqual(actions.map((node) => node.props["aria-label"]), ["acme 编辑", "acme 删除"],
      "两个动作必须各自带上可读标签");
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme"), null,
      "折叠态不得渲染编辑卡内容");
    // 顺序断言不能靠隐藏或禁用换取：这个「编辑」必须真的能打开卡片。
    actions[0].props.onClick();
    await card.settle();
    assert.ok(findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme"), "点编辑必须打开卡片");
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：展开态不渲染删除/收起，页脚取消折叠且不写入任何配置", async () => {
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    const expandedHeader = findNode(card.output, (node) => node.props?.className === "deg_mc_card_head");
    assert.ok(expandedHeader, "展开态必须渲染 provider 卡片头部");
    assert.deepEqual(collectNodes(expandedHeader, (node) => node.type === "button"), [],
      "展开态头部不得渲染删除或收起按钮");
    const typeBaseUrl = async (value) => {
      findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme").props.onChange({ target: { value } });
      await card.settle();
    };
    const collapsed = () => findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme") === null;

    // 页脚「取消」：折叠回折叠态，且草稿一律不写入。
    await typeBaseUrl("https://api.example.com/v1");
    findNode(card.output, (node) => node.type === "button" && node.props?.children === "取消").props.onClick();
    await card.settle();
    assert.equal(collapsed(), true, "页脚取消必须折叠卡片");
    assert.ok(findNode(card.output, (node) => node.type === "button" && node.props?.children === "编辑"),
      "折叠后必须重新给出编辑入口");
    assert.deepEqual(workspace.calls.mutate, [], "页脚取消不得写入 settings");
    assert.deepEqual(workspace.calls.credentialSet, [], "页脚取消不得写入凭据");

    // 折叠后重新打开：草稿回到已存储状态，没有任何残留输入。
    await expandProviderCard(card);
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme").props.value, "",
      "取消必须丢弃 Base URL 草稿");
    assert.deepEqual(modelIdsOf(card), ["m1"], "取消必须丢弃模型行草稿");
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：已有 provider 的获取模型弹窗默认勾选新候选、已有行不勾选", async () => {
  const workspace = workspacesForRender({
    discovered: [{ id: "m1", name: "One" }, { id: "glm-5" }, { id: "glm-5-flash" }],
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    const fetchButton = findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme");
    assert.equal(fetchButton.props.disabled, false, "已配置 provider 必须能获取模型");
    fetchButton.props.onClick();
    await card.settle(24);
    assert.deepEqual(workspace.calls.discover.at(-1), { ns: "llm-pi-ai", request: { provider: "acme" } },
      "已有 provider 的手动探测只带 provider 标识");
    dialog = await mountDiscoveryDialog(runtime, card);
    assert.ok(findNode(dialog.output, (node) => node.type === "h3" && node.props?.children === "选择要添加的模型"));
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => [node.props["data-deg-create-candidate"], node.props.checked]),
      [["m1", false], ["glm-5", true], ["glm-5-flash", true]],
      "已有行默认不勾选，新候选默认勾选");
    assert.deepEqual(workspace.calls.mutate, [], "探测与候选展示不得写入 settings");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：候选弹窗搜索后的取消全选清空全部候选，全选只追加可见项，采纳只加入勾选项且不覆盖已有行", async () => {
  const workspace = workspacesForRender({
    discovered: [{ id: "m1", name: "候选里的新名字" }, { id: "glm-5" }, { id: "glm-5-flash" }, { id: "kimi-k3" }],
  });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    // 每次状态变化后重新 materialize：渲染替身只渲染一层，旧句柄的 props 会失效。
    const remount = async () => {
      dialog.unmount();
      dialog = await mountDiscoveryDialog(runtime, card);
    };
    const search = (value) => findNode(dialog.output, (node) => node.props?.["aria-label"] === "搜索模型");
    const toggleVisible = () => findNode(dialog.output, (node) => node.type === "button"
      && (node.props?.children === "全选" || node.props?.children === "取消全选"));

    // 搜索：只保留匹配当前查询的候选。
    search().props.onChange({ target: { value: "glm" } });
    await card.settle();
    await remount();
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => node.props["data-deg-create-candidate"]),
      ["glm-5", "glm-5-flash"], "搜索只显示匹配的候选");

    // 可见项已全选时的切换：清空**全部**选择，被搜索隐藏的候选同样被清掉（DSH 模型页语义）。
    assert.equal(toggleVisible().props.children, "取消全选", "可见项全部勾选时按钮显示取消全选");
    toggleVisible().props.onClick();
    await card.settle();
    await remount();
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => node.props.checked), [false, false], "取消全选清空可见项");
    assert.equal(toggleVisible().props.children, "全选");
    assert.deepEqual(discoveryDialogOf(card).props.candidates.filter((candidate) => candidate.picked === true)
      .map((candidate) => candidate.id), [], "搜索后点取消全选必须清空全部候选选择（含被隐藏的 kimi-k3）");

    // 反向路径：可见项未全选时，「全选」只追加可见项，隐藏候选保留原选择。
    // 先在搜索态里恢复 kimi-k3 的选择（它当前不可见，只能通过取消搜索后再勾选）。
    search().props.onChange({ target: { value: "" } });
    await card.settle();
    await remount();
    candidateBoxesOf(dialog).find((node) => node.props["data-deg-create-candidate"] === "kimi-k3").props.onChange();
    await card.settle();
    await remount();
    search().props.onChange({ target: { value: "glm" } });
    await card.settle();
    await remount();
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => node.props.checked), [false, false],
      "重新搜索后可见项仍未勾选");
    toggleVisible().props.onClick();
    await card.settle();
    await remount();
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => node.props.checked), [true, true], "全选勾选可见项");
    assert.deepEqual(discoveryDialogOf(card).props.candidates.filter((candidate) => candidate.picked === true)
      .map((candidate) => candidate.id), ["glm-5", "glm-5-flash", "kimi-k3"],
      "全选只追加可见项，隐藏候选保留原有选择");

    // 清空搜索后把选择收敛到只勾选 glm-5-flash，采纳时只加入它。
    search().props.onChange({ target: { value: "" } });
    await card.settle();
    await remount();
    const boxOf = (id) => candidateBoxesOf(dialog).find((node) => node.props["data-deg-create-candidate"] === id);
    // 依次取消勾选 glm-5、glm-5-flash、kimi-k3，只留待会儿要勾选的 glm-5-flash。
    for (const id of ["glm-5", "glm-5-flash", "kimi-k3"]) {
      boxOf(id).props.onChange();
      await card.settle();
      await remount();
    }
    boxOf("glm-5-flash").props.onChange();
    await card.settle();
    await remount();
    assert.deepEqual(discoveryDialogOf(card).props.candidates.filter((candidate) => candidate.picked === true)
      .map((candidate) => candidate.id), ["glm-5-flash"]);
    findNode(dialog.output, (node) => node.type === "button" && node.props?.children === "添加所选").props.onClick();
    await card.settle();
    assert.equal(discoveryDialogOf(card), null, "采纳后弹窗必须关闭");
    assert.deepEqual(modelIdsOf(card), ["m1", "glm-5-flash"], "只加入勾选的候选，已有行保持原样");
    assert.equal(findNode(card.output, (node) => node.props?.["aria-label"] === "模型显示名 1").props.value, "One",
      "已有行不得被候选覆盖");
    assert.deepEqual(workspace.calls.mutate, [], "采纳候选只进草稿，不得直接写 settings");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：候选弹窗取消不写入且保留卡片已有草稿", async () => {
  const workspace = workspacesForRender({ discovered: [{ id: "m1" }, { id: "new-a" }] });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme")
      .props.onChange({ target: { value: "https://api.example.com/v1" } });
    await card.settle();
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    // 先在弹窗里改候选选择，再取消弹窗：取消必须整体丢弃候选状态。
    candidateBoxesOf(dialog).find((node) => node.props["data-deg-create-candidate"] === "new-a").props.onChange();
    await card.settle();
    dialog.unmount();
    dialog = await mountDiscoveryDialog(runtime, card);
    findNode(dialog.output, (node) => node.type === "button" && node.props?.children === "取消").props.onClick();
    await card.settle();
    assert.equal(discoveryDialogOf(card), null, "取消必须关闭弹窗");
    assert.deepEqual(workspace.calls.mutate, [], "取消弹窗不得写入 settings");
    assert.deepEqual(workspace.calls.credentialSet, [], "取消弹窗不得写入凭据");
    assert.equal(findNode(card.output, (node) => node.props?.["data-deg-base-url"] === "acme").props.value,
      "https://api.example.com/v1", "取消弹窗必须保留卡片已有草稿");
    assert.deepEqual(modelIdsOf(card), ["m1"], "取消弹窗不得把候选写进草稿");
    assert.ok(findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme"), "取消弹窗不等于收起卡片");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

/**
 * 受控焦点替身：只实现弹窗契约真正用到的 focus()/disabled 读面。
 * 用例据此断言"关闭后恢复先前焦点"与"Tab 焦点环循环"，不依赖任何真实 DOM。
 */
function createFakeFocusTarget(label, disabled = false) {
  return {
    label,
    disabled,
    focused: 0,
    isConnected: true,
    focus() { this.focused += 1; },
  };
}

/** 弹窗焦点环的受控查询面：返回按 DOM 顺序排列的可聚焦控件替身。 */
function createFakeFocusScope(controls) {
  return { querySelectorAll: () => controls };
}

/**
 * 按渲染结果构造焦点环替身：`disabled` 直接取自渲染出的 props。
 *
 * 这样替身与生产标记同源——生产若漏标 disabled（或焦点环不过滤），
 * "disabled 项必须被跳过"的断言就会失败，而不是被替身自己掩盖。
 */
function focusRingOf(dialog) {
  return collectNodes(dialog.output, (node) => typeof node.props?.["data-deg-dialog-action"] === "string")
    .map((node) => {
      const action = node.props["data-deg-dialog-action"];
      const candidateId = node.props["data-deg-create-candidate"];
      const label = typeof candidateId === "string" ? action + ":" + candidateId : action;
      return createFakeFocusTarget(label, node.props.disabled === true);
    });
}

test("模型配置：候选弹窗的关闭控件、遮罩点击与 Escape 都只关闭弹窗，并在关闭后恢复先前焦点", async () => {
  const workspace = workspacesForRender({ discovered: [{ id: "m1" }, { id: "new-a" }] });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  const originalDocument = globalThis.document;
  const fakeDocument = { activeElement: null };
  const restoreDocument = installGlobals({ document: fakeDocument });
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);

    // 打开弹窗前页面焦点落在「获取模型」按钮上：弹窗关闭后必须还给它。
    const opener = createFakeFocusTarget("获取模型");
    fakeDocument.activeElement = opener;
    dialog = await mountDiscoveryDialog(runtime, card);
    const dialogNode = findNode(dialog.output, (node) => node.props?.role === "dialog");
    assert.ok(dialogNode, "弹窗必须渲染 role=dialog 的模态容器");

    // 头部关闭按钮：只关闭，不采纳、不写 settings。
    const closeButton = findNode(dialog.output, (node) => node.props?.["aria-label"] === "关闭");
    assert.equal(closeButton.props.autoFocus, true, "打开弹窗时焦点必须落在弹窗内的控件上");
    closeButton.props.onClick();
    await card.settle();
    assert.equal(discoveryDialogOf(card), null, "关闭按钮必须关闭弹窗");
    assert.deepEqual(workspace.calls.mutate, [], "关闭弹窗不得写入 settings");
    assert.deepEqual(modelIdsOf(card), ["m1"], "关闭弹窗不得把候选写进草稿");

    // 重新打开：关闭按钮只关闭弹窗，重新打开必须再走一次「获取模型」（候选不会留在卡片里）。
    dialog.unmount();
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    fakeDocument.activeElement = opener;
    dialog = await mountDiscoveryDialog(runtime, card);
    findNode(dialog.output, (node) => node.props?.className === "deg_mc_modal_backdrop").props.onClick();
    await card.settle();
    assert.equal(discoveryDialogOf(card), null, "点击遮罩必须关闭弹窗");
    assert.equal(opener.focused, 1, "关闭后必须把焦点还给打开弹窗前的元素");

    // 重新打开：弹窗内部的点击不得冒泡到遮罩（否则点输入框就会误关弹窗）。
    dialog.unmount();
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    const innerClick = findNode(dialog.output, (node) => node.props?.role === "dialog");
    let stopped = 0;
    innerClick.props.onClick({ stopPropagation() { stopped += 1; } });
    await card.settle();
    assert.equal(stopped, 1, "弹窗内部的点击必须阻止冒泡到遮罩");
    assert.ok(discoveryDialogOf(card), "点击弹窗内部不得关闭弹窗");

    // Escape 关闭（并阻止默认行为）。
    dialog.unmount();
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    fakeDocument.activeElement = opener;
    dialog = await mountDiscoveryDialog(runtime, card);
    const escapeDialog = findNode(dialog.output, (node) => node.props?.role === "dialog");
    // 前一轮的卸载已经还过一次焦点，因此这里只断言"这次关闭又还了一次"。
    const focusedBeforeEscape = opener.focused;
    let prevented = 0;
    let stoppedEscape = 0;
    escapeDialog.props.onKeyDown({
      key: "Escape",
      shiftKey: false,
      preventDefault() { prevented += 1; },
      stopPropagation() { stoppedEscape += 1; },
    });
    await card.settle();
    assert.equal(prevented, 1, "Escape 必须阻止默认行为");
    assert.equal(stoppedEscape, 1, "Escape 不得继续冒泡给外层");
    assert.equal(discoveryDialogOf(card), null, "Escape 必须关闭弹窗");
    // 真实 React 里 onClose 会让父级不再渲染弹窗（等价于卸载），焦点恢复发生在卸载清理里。
    dialog.unmount();
    assert.equal(opener.focused, focusedBeforeEscape + 1, "Escape 关闭后同样要恢复先前焦点");
    assert.deepEqual(workspace.calls.mutate, [], "Escape 关闭不得写入 settings");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
    restoreDocument();
    assert.equal(globalThis.document, originalDocument, "用例必须还原 document 替身");
  }
});

test("模型配置：候选弹窗的 Tab 焦点环在自身控件间循环且不泄漏到背景", async () => {
  const workspace = workspacesForRender({ discovered: [{ id: "m1" }, { id: "new-a" }] });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  const originalDocument = globalThis.document;
  const fakeDocument = { activeElement: null };
  const restoreDocument = installGlobals({ document: fakeDocument });
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    const dialogNode = findNode(dialog.output, (node) => node.props?.role === "dialog");

    // 弹窗内的全部控件（与生产实现同一套 data 标记）；本用例里没有一个被禁用。
    const controls = focusRingOf(dialog);
    assert.deepEqual(controls.map((control) => control.label),
      ["close", "search", "toggle-visible", "candidate:m1", "candidate:new-a", "cancel", "adopt"],
      "焦点环必须按 DOM 顺序覆盖弹窗内的全部可聚焦控件（含候选复选框）");
    assert.equal(controls.every((control) => control.disabled === false), true,
      "两个候选默认勾选时全部控件都应可用");
    dialogNode.props.ref.current = createFakeFocusScope(controls);
    const last = controls.length - 1;

    const pressTab = (shiftKey) => {
      let prevented = 0;
      dialogNode.props.onKeyDown({
        key: "Tab",
        shiftKey,
        preventDefault() { prevented += 1; },
        stopPropagation() {},
      });
      return prevented;
    };

    // 焦点在最后一个控件（添加所选）时 Tab 回到第一个控件，而不是漏到背景页面。
    fakeDocument.activeElement = controls[last];
    assert.equal(pressTab(false), 1, "Tab 必须阻止浏览器默认的焦点移动");
    assert.deepEqual(controls.map((control) => control.focused), [1, 0, 0, 0, 0, 0, 0]);

    // 焦点在第一个控件时 Shift+Tab 反向回到最后一个控件。
    fakeDocument.activeElement = controls[0];
    assert.equal(pressTab(true), 1, "Shift+Tab 必须阻止浏览器默认的焦点移动");
    assert.deepEqual(controls.map((control) => control.focused), [1, 0, 0, 0, 0, 0, 1]);

    // 中间的普通 Tab 前进一格。
    fakeDocument.activeElement = controls[1];
    pressTab(false);
    assert.deepEqual(controls.map((control) => control.focused), [1, 0, 1, 0, 0, 0, 1]);
    assert.equal(discoveryDialogOf(card) === null, false, "Tab 不得关闭弹窗");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
    restoreDocument();
    assert.equal(globalThis.document, originalDocument, "用例必须还原 document 替身");
  }
});

test("模型配置：候选弹窗的 Tab 焦点环跳过 disabled 控件，绝不聚焦无结果的全选与未勾选的添加所选", async () => {
  const workspace = workspacesForRender({ discovered: [{ id: "m1" }, { id: "new-a" }] });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  const originalDocument = globalThis.document;
  const fakeDocument = { activeElement: null };
  const restoreDocument = installGlobals({ document: fakeDocument });
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    const dialogNode = () => findNode(dialog.output, (node) => node.props?.role === "dialog");
    const search = () => findNode(dialog.output, (node) => node.props?.["aria-label"] === "搜索模型");
    const remount = async () => {
      dialog.unmount();
      dialog = await mountDiscoveryDialog(runtime, card);
    };

    // 取消勾选唯一的已选候选 new-a：pickedCount 归零，「添加所选」必须变成 disabled。
    findNode(dialog.output, (node) => node.props?.["data-deg-create-candidate"] === "new-a").props.onChange();
    await card.settle();
    await remount();
    // 搜索一个没有命中的查询：可见项为空，列表变成空态，「全选」必须变成 disabled。
    search().props.onChange({ target: { value: "no-such-model" } });
    await card.settle();
    await remount();

    const renderedDisabled = Object.fromEntries(
      collectNodes(dialog.output, (node) => typeof node.props?.["data-deg-dialog-action"] === "string")
        .map((node) => [node.props["data-deg-dialog-action"], node.props.disabled === true]),
    );
    assert.deepEqual(renderedDisabled, {
      close: false, search: false, "toggle-visible": true, cancel: false, adopt: true,
    }, "空结果时全选禁用、未勾选时添加所选禁用");

    // 焦点环替身与渲染同源：disabled 项必须被排除在循环之外。
    const controls = focusRingOf(dialog);
    assert.deepEqual(controls.map((control) => control.label),
      ["close", "search", "toggle-visible", "cancel", "adopt"],
      "焦点环替身必须覆盖渲染出的全部带标记控件");
    const enabled = controls.filter((control) => control.disabled !== true);
    assert.deepEqual(enabled.map((control) => control.label), ["close", "search", "cancel"],
      "只有启用且可见的控件参与循环");
    dialogNode().props.ref.current = createFakeFocusScope(controls);

    const pressTab = (shiftKey) => {
      let prevented = 0;
      dialogNode().props.onKeyDown({
        key: "Tab",
        shiftKey,
        preventDefault() { prevented += 1; },
        stopPropagation() {},
      });
      return prevented;
    };

    // 焦点在最后一个可聚焦控件（取消）时 Tab 回到第一个可聚焦控件，
    // 而不是落到 disabled 的「添加所选」上（那样 preventDefault 会把焦点卡死）。
    fakeDocument.activeElement = enabled[2];
    assert.equal(pressTab(false), 1, "存在可聚焦控件时必须接管 Tab");
    assert.deepEqual(controls.map((control) => control.focused), [1, 0, 0, 0, 0],
      "Tab 必须从 disabled 的添加所选跳过，回到关闭按钮");

    // Shift+Tab 从第一个可聚焦控件反向回到最后一个可聚焦控件，同样跳过 disabled 项。
    fakeDocument.activeElement = enabled[0];
    pressTab(true);
    assert.deepEqual(controls.map((control) => control.focused), [1, 0, 0, 1, 0],
      "Shift+Tab 必须跳过 disabled 的全选与添加所选，落到取消按钮");

    // 连续 Tab 走两整圈：每一步都把 activeElement 移到刚刚获得焦点的控件上
    // （等价于浏览器真的移动了焦点），disabled 的两项全程都不得被聚焦。
    const before = controls.map((control) => control.focused);
    fakeDocument.activeElement = enabled[0];
    for (let step = 0; step < 6; step += 1) {
      const snapshot = controls.map((control) => control.focused);
      pressTab(false);
      const next = controls.find((control, index) => control.focused > snapshot[index]);
      assert.ok(next, "每次 Tab 都必须把焦点交给某个控件");
      fakeDocument.activeElement = next;
    }
    assert.deepEqual(controls.map((control, index) => control.focused - before[index]),
      [2, 2, 0, 2, 0],
      "连续 Tab 只在启用控件之间循环，disabled 的全选与添加所选始终拿不到焦点");
    assert.ok(discoveryDialogOf(card), "Tab 不得关闭弹窗");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
    restoreDocument();
    assert.equal(globalThis.document, originalDocument, "用例必须还原 document 替身");
  }
});

test("模型配置：同时挂载的两个候选弹窗各自拥有唯一的标题 id 与 aria-labelledby", async () => {
  const workspace = workspacesForRender({ discovered: [{ id: "m1" }, { id: "new-a" }] });
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  let first = null;
  let second = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle(24);
    const element = discoveryDialogOf(card);
    assert.ok(element, "获取模型成功后必须渲染候选弹窗");

    // 两个实例同时挂载（真实场景里就是两张 provider 卡片各自打开了选择弹窗）。
    first = runtime.render(element.type, element.props);
    second = runtime.render(element.type, element.props);
    await first.settle();
    await second.settle();

    const labelledByOf = (handle) => findNode(handle.output, (node) => node.props?.role === "dialog").props["aria-labelledby"];
    const titleIdOf = (handle) => findNode(handle.output,
      (node) => node.type === "h3" && node.props?.children === "选择要添加的模型").props.id;
    const firstId = labelledByOf(first);
    const secondId = labelledByOf(second);

    assert.equal(typeof firstId, "string");
    assert.notEqual(firstId, secondId, "两个同时挂载的弹窗标题 id 必须唯一");
    assert.equal(firstId, titleIdOf(first), "第一个弹窗的 aria-labelledby 必须指向自己的标题");
    assert.equal(secondId, titleIdOf(second), "第二个弹窗的 aria-labelledby 必须指向自己的标题");
    // 同一实例重渲染后 id 必须保持稳定，否则 aria-labelledby 会指向一个不存在的标题。
    first.rerender({});
    assert.equal(labelledByOf(first), firstId, "重渲染不得更换标题 id");
    assert.equal(titleIdOf(first), firstId, "重渲染后标题元素仍使用同一个 id");
  } finally {
    first?.unmount();
    second?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置：自定义 provider 发现请求在途时锁定 profile 编辑与取消，候选返回后解锁", async () => {
  const workspace = workspacesForRender();
  // 受控探测：由用例决定完成时机，不依赖任何计时。
  const pending = [];
  workspace.remote.llm.discoverModels = (ns, request) => {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    pending.push({ ns, request, settle });
    return promise;
  };
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let create = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-custom-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    create = await mounted.mount((node) => node?.type?.name === "CustomProviderCard");
    await fillCustomProvider(create, { models: [] });

    const fieldOf = (key) => findNode(create.output, (node) => node.props?.[key] === "true");
    const cancelButton = () => findNode(create.output, (node) => node.props?.["data-deg-create-cancel"] === "true");
    const fetchButton = () => findNode(create.output, (node) => node.props?.["data-deg-create-fetch-models"] === "true");
    // profile 字段：route / 显示名 / Base URL / 协议（模型行另有自己的禁用断言）。
    const profileFields = ["data-deg-create-route", "data-deg-create-name", "data-deg-create-base-url", "data-deg-create-protocol"];
    const profileLocked = () => profileFields.map((key) => [key, fieldOf(key).props.disabled]);

    // 探测前：profile 可编辑、取消可用。
    assert.deepEqual(profileLocked(), profileFields.map((key) => [key, false]), "探测前 profile 必须可编辑");
    assert.equal(cancelButton().props.disabled, false, "探测前取消必须可用");

    fetchButton().props.onClick();
    await create.settle();
    assert.equal(pending.length, 1, "点击获取可用模型必须发出一次发现请求");
    assert.deepEqual(pending[0].request, {
      baseURL: "https://gateway.example.com/v1",
      api: "openai-chat",
      apiKey: "sk-gateway",
    }, "发现请求使用点击那一刻的表单参数");

    // 在途：profile 与取消全部锁定——否则改完 endpoint 再让旧参数候选落进新配置。
    assert.deepEqual(profileLocked(), profileFields.map((key) => [key, true]), "在途必须锁定 profile 编辑");
    assert.equal(cancelButton().props.disabled, true, "在途必须禁止取消（取消会丢弃草稿并收起卡片）");
    assert.equal(fetchButton().props.disabled, true, "在途不得重复发起发现请求");
    assert.equal(fieldOf("data-deg-create-model-id") === null, true, "本用例的草稿没有模型行，锁定只需看字段本身");
    // 边界：API Key 走 credentials 而不是 profile，在途仍可编辑（与 profileDisabled 的语义一致）。
    assert.equal(fieldOf("data-deg-create-api-key").props.disabled, false, "API Key 不属于 profile，保持可编辑");

    // 候选到达：解锁，并按当前草稿预置勾选。
    pending[0].settle({ ok: true, value: [{ id: "gw-new" }, { id: "gw-small" }] });
    await create.settle(24);
    assert.deepEqual(profileLocked(), profileFields.map((key) => [key, false]), "候选到达后必须解锁 profile");
    assert.equal(cancelButton().props.disabled, false, "候选到达后取消必须恢复可用");
    dialog = await mountDiscoveryDialog(runtime, create);
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => [node.props["data-deg-create-candidate"], node.props.checked]),
      [["gw-new", true], ["gw-small", true]], "解锁后候选按新候选默认勾选");
    assert.deepEqual(workspace.calls.mutate, [], "发现请求与候选展示不得写入 settings");
    assert.deepEqual(workspace.calls.credentialSet, [], "发现请求不得写入凭据");
  } finally {
    dialog?.unmount();
    create?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

test("模型配置回归：手动获取模型开始后完成的自动探测不得绕过手动候选选择", async () => {
  // acme 在用户层有 profile 但没有模型：自动 fallback 探测因此会真正试图写入目录。
  const namespace = namespaceView("llm-pi-ai", {
    schema: PI_AI_SCHEMA,
    revision: 2,
    user: { providers: { acme: { apiKeyEnv: "ACME_API_KEY" } } },
    base: {},
    value: { providers: { acme: { apiKeyEnv: "ACME_API_KEY" } } },
  });
  const workspace = workspacesForRender({ namespaces: [namespace] });
  // 受控探测：自动与手动各拿一个 deferred，由用例决定完成顺序，不依赖任何计时。
  const pending = [];
  workspace.remote.llm.discoverModels = (ns, request) => {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    pending.push({ ns, request, settle });
    return promise;
  };
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  let dialog = null;
  try {
    mounted = await openModelSection(harness, runtime);
    card = await openProviderCard(mounted, "acme");
    assert.equal(pending.length, 1, "打开卡片必须发出一次自动 fallback 探测");

    // 时序：手动「获取模型」先开始，自动探测随后才完成。
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle();
    assert.equal(pending.length, 2, "手动获取必须发出第二次探测");

    pending[0].settle({ ok: true, value: [{ id: "shared-model" }, { id: "auto-only" }] });
    await card.settle(24);
    assert.equal(findNode(card.output, (node) => node.props?.["aria-label"] === "模型 ID 1"), null,
      "手动获取开始后完成的自动探测不得把目录写进草稿");

    // 手动候选到达：草稿里没有模型，因此两个候选都是新候选、默认勾选。
    pending[1].settle({ ok: true, value: [{ id: "shared-model" }, { id: "manual-only" }] });
    await card.settle(24);
    dialog = await mountDiscoveryDialog(runtime, card);
    assert.deepEqual(candidateBoxesOf(dialog).map((node) => [node.props["data-deg-create-candidate"], node.props.checked]),
      [["shared-model", true], ["manual-only", true]],
      "自动探测结果不得把手动候选预置成未勾选");

    // 只勾选 shared-model 并采纳：自动结果里的 auto-only 绝不能跟着进草稿。
    candidateBoxesOf(dialog).find((node) => node.props["data-deg-create-candidate"] === "manual-only").props.onChange();
    await card.settle();
    dialog.unmount();
    dialog = await mountDiscoveryDialog(runtime, card);
    findNode(dialog.output, (node) => node.type === "button" && node.props?.children === "添加所选").props.onClick();
    await card.settle();
    assert.deepEqual(modelIdsOf(card), ["shared-model"], "未勾选的候选与自动 fallback 行都不得进入草稿");

    // 应用只写入勾选的那一行。
    findNode(card.output, (node) => node.props?.["data-deg-apply"] === "acme").props.onClick();
    await card.settle(24);
    const savedModels = workspace.calls.mutate
      .flatMap((call) => call.ops ?? [])
      .find((op) => op.path?.at(-1) === "models");
    assert.deepEqual(savedModels?.value?.map((model) => model.id), ["shared-model"], "应用不得写入未勾选的模型");
  } finally {
    dialog?.unmount();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});


test("模型配置回归：手动获取模型后收起再展开必须重新发起自动目录探测", async () => {
  // acme 在用户层只有 profile、没有模型：受控结果用于验证空目录的自动 fallback。
  // 用例只断言公开 seam：adapter 自动与手动目录探测次数，以及卡片渲染出的
  // 模型行，不读取任何 React 私有状态（manualIntent / discoveryIntent 都不被直接断言）。
  const namespace = namespaceView("llm-pi-ai", {
    schema: PI_AI_SCHEMA,
    revision: 2,
    user: { providers: { acme: { apiKeyEnv: "ACME_API_KEY" } } },
    base: {},
    value: { providers: { acme: { apiKeyEnv: "ACME_API_KEY" } } },
  });
  const workspace = workspacesForRender({ namespaces: [namespace] });
  // 受控探测：每次调用都记账并给出 deferred，由用例决定完成时机，不依赖任何计时。
  const pending = [];
  workspace.remote.llm.discoverModels = (ns, request) => {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    pending.push({ ns, request, settle });
    return promise;
  };
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  try {
    mounted = await openModelSection(harness, runtime);
    // 首次展开 provider 卡片必须自动探测；空响应后仍保持空目录。
    card = await openProviderCard(mounted, "acme");
    assert.equal(pending.length, 1, "首次展开 provider 卡片必须发起一次自动目录探测");
    assert.deepEqual(pending[0].request, { provider: "acme" }, "自动探测只带 provider 标识");
    pending[0].settle({ ok: true, value: [] });
    await card.settle(24);
    assert.deepEqual(modelIdsOf(card), [], "空的自动发现结果不得生成模型行");

    // 用户点「获取模型」：手动探测保持未完成（用户正在等待候选），卡片目录此刻仍然是空的。
    findNode(card.output, (node) => node.props?.["data-deg-fetch-models"] === "acme").props.onClick();
    await card.settle();
    assert.equal(pending.length, 2, "手动获取必须发起第二次探测");

    // 页脚取消再展开：上一轮的手动意图只屏蔽它自己的打开周期，不得永久屏蔽自动目录探测。
    // 目录此刻为空，因此这一轮自动探测的结果是公开可见的卡片模型行。
    findNode(card.output, (node) => node.type === "button" && node.props?.children === "取消").props.onClick();
    await card.settle();
    findNode(card.output, (node) => node.type === "button" && node.props?.children === "编辑").props.onClick();
    await card.settle(24);
    assert.equal(pending.length, 3, "收起再展开必须重新发起一轮自动目录探测");
    assert.deepEqual(pending[2].request, { provider: "acme" }, "重新展开后的探测仍是自动目录探测");

    // 给这一轮自动探测一个全新的 id：只有这一轮的回调真的落地，卡片才会显示它；
    // 手动意图若跨打开周期残留，回调会放弃写目录，卡片将保持空目录。
    pending[2].settle({ ok: true, value: [{ id: "auto-model-v2" }] });
    await card.settle(24);
    assert.deepEqual(modelIdsOf(card), ["auto-model-v2"],
      "重新展开后的自动目录必须重新生效：手动意图不得跨打开周期残留");

    // 手动候选最后才到达：它清掉未编辑的自动填充行，且不得影响已经落地的写入语义。
    pending[1].settle({ ok: true, value: [{ id: "manual-only" }] });
    await card.settle(24);
    assert.deepEqual(modelIdsOf(card), [], "手动候选到达后未编辑的自动填充行必须被清掉");
    assert.equal(pending.length, 3, "整个流程只有一次自动探测、一次手动探测与一次重新展开探测");
    assert.deepEqual(workspace.calls.mutate, [], "自动探测与手动候选都只进草稿，不得写 settings");
    assert.deepEqual(workspace.calls.credentialSet, [], "探测不得写入凭据");
  } finally {
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

/**
 * 目录刷新协调（真实 settings 描述符注入的 modelCatalog store）。
 *
 * 用户可见症状：在设置页新增 provider 后立即删除，随后角色的 provider / 模型选择 / 思考深度
 * 三个下拉一直不可操作（store 停在 ready 之外的状态）。这里用真实 store 复现同一时序：
 * - 目录响应是 deferred（由用例决定完成顺序），因此可以固定"旧响应在删除落定之后才回来"；
 * - 宿主事件用 `workspace.emit(...)` 驱动，与真实 Host 的目录/文档/凭据事件同名；
 * - 新增与删除走真实 UI 回调（删除因此产生真实的 `unset` 操作）；
 * - 断言只看用户可见状态（三个下拉的 disabled、目录选项、可见错误文案）与请求并发上限，
 *   不读取 store 的任何私有字段。
 */
test("模型配置回归：新增后删除 provider 的刷新突发合并为尾随请求，角色下拉收敛回可用", async () => {
  // explorer 默认使用 acme：删除的新 provider fresh 不被任何角色使用，三个下拉在目录 ready 时都可用，
  // 删除后目录刷新期间仍必须沿用缓存目录，不能把它们整体锁上。
  const settingsSnapshot = {
    status: "ready",
    value: { defaults: { explorer: { provider: "acme", model: "acme-m1" } } },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: "host",
  };
  const workspace = workspacesForRender();
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  let mounted = null;
  let card = null;
  /** 每次 `ctx.remote.session.modelCatalog()` 调用一个 deferred；用例决定完成顺序。 */
  const responses = [];
  /** 目录响应：provider 各带一个带 reasoning 能力的模型，因此思考深度下拉可用。 */
  const directory = (providerIds) => ({
    ok: true,
    value: {
      groups: providerIds.map((id) => ({
        id,
        name: id,
        models: [{
          id: id + "-m1",
          name: id + "-M1",
          reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
        }],
      })),
    },
  });
  harness.ctx.remote = {
    ...harness.ctx.remote,
    session: {
      modelCatalog: () => {
        let settle;
        const promise = new Promise((resolve) => { settle = resolve; });
        responses.push({ settle });
        return promise;
      },
    },
  };
  /** 真实 store：设置页拿到的就是 client.js 在 apply 期创建的那一个。 */
  const storeOf = () => harness.registrations.get("settings.section").descriptor.inject().modelCatalog;
  const roleSelect = (suffix) => findNode(mounted.handle.output,
    (node) => node.type === "select" && node.props?.["aria-label"] === "Explorer " + suffix);
  /** 用户可见的三档可用性：供应商 / 模型选择 / 思考深度。 */
  const disabledStates = () => ["供应商", "模型选择", "思考深度"].map((suffix) => roleSelect(suffix)?.props.disabled);
  const providerOptions = () => collectNodes(roleSelect("供应商"), (node) => node.type === "option")
    .map((node) => node.props.value);
  /** 模型下拉当前渲染出的选项值：验证"选中 provider 后目录选项真实反映"这一交互结果。 */
  const modelOptionValues = () => collectNodes(roleSelect("模型选择"), (node) => node.type === "option")
    .map((node) => node.props.value);
  const saveButton = () => findNode(mounted.handle.output,
    (node) => node.type === "button" && node.props?.children === "保存");
  // 替身的 `ctx.on` 每个事件只保留最后一个监听器（真实 Cordis 允许注册多个），而目录
  // store 与模型配置宿主都会订阅 `connection/reset`，因此这里自己收集注册面：apply 期
  // 先创建的目录 store 是第 0 个，用例据此直接驱动它的 reset 处理器。
  const connectionResets = [];
  const originalCtxOn = harness.ctx.on;
  harness.ctx.on = (event, callback) => {
    const stop = originalCtxOn.call(harness.ctx, event, callback);
    if (event === "connection/reset") connectionResets.push(callback);
    return stop;
  };
  const originalConfirm = globalThis.confirm;
  // 同步原生 confirm 的探针：删除确认现在由 DEG 自己渲染，这个探针必须一次都不被调用
  // （旧实现正是在这里阻塞事件循环，导致删除后设置页与会话输入框一起停摆）。用例结束前恢复。
  const confirmCalls = [];
  globalThis.confirm = (message) => {
    confirmCalls.push(message);
    return true;
  };
  try {
    mounted = await openModelSection(harness, runtime, {
      settingsSnapshot,
      // 目录 store 取描述符注入面里的真实实现，而不是固定 ready 的替身。
      modelCatalog: (injected) => injected.modelCatalog,
    });
    assert.equal(responses.length, 1, "挂载必须发起一次目录请求");
    // 首次挂载：还没有任何一次成功目录（groups 为空、status 为 loading），三个下拉与保存按钮
    // 都必须禁用。缓存可用性只对"已经成功读到过目录"的会话生效，首次空目录绝不放行。
    assert.equal(storeOf().getSnapshot().status, "loading", "用例前提：首轮目录仍在途");
    assert.deepEqual(disabledStates(), [true, true, true], "首次尚无成功目录时角色三个下拉必须禁用");
    assert.equal(saveButton().props.disabled, true, "首次尚无成功目录时保存按钮必须禁用");
    responses[0].settle(directory(["acme", "fresh"]));
    await mounted.handle.settle(32);
    assert.deepEqual(disabledStates(), [false, false, false], "目录就绪后角色三个下拉都必须可用");
    assert.deepEqual(providerOptions(), ["", "acme", "fresh"], "provider 选项来自当前目录");

    // 真实新增：添加提供方 → 选择 fresh → 添加（只写入空 profile）。
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-add-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle();
    findNode(mounted.modelHandle.output, (node) => node.props?.["aria-label"] === "选择要添加的 provider")
      .props.onChange({ target: { value: "fresh" } });
    await mounted.modelHandle.settle();
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-confirm-add-provider"] === "true").props.onClick();
    await mounted.modelHandle.settle(32);
    assert.deepEqual(workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "set", path: ["providers", "fresh"], value: {} }]], "新增必须写入空 provider profile");

    // 新增落定后立即触发宿主事件突发（真实 Host 会为这次写入广播目录与文档事件）。
    workspace.emit("settings/document-updated");
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.deepEqual(disabledStates(), [false, false, false], "已有成功目录时刷新不得锁死角色下拉");

    // 立即删除（用户报告的就是这个时序）：卡片删除按钮 → DEG 确认弹窗 → 真实 unset 写入。
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard" && node.props?.row?.provider === "fresh");
    findNode(card.output, (node) => node.props?.["aria-label"] === "fresh 删除").props.onClick();
    await card.settle(32);
    // 用户可见的删除确认现在由 DEG 自己渲染（绝不再调用同步原生 confirm —— 正是它阻塞了
    // 事件循环，让设置页与 DSH 会话输入框在弹窗存续期间一起停摆）。
    await mounted.modelHandle.settle(32);
    assert.equal(confirmCalls.length, 0, "删除链路绝不能再调用同步原生 confirm");
    findNode(mounted.modelHandle.output, (node) => node.props?.["data-deg-remove-confirm"] === "true").props.onClick();
    await card.settle(32);
    await mounted.modelHandle.settle(32);
    await mounted.handle.settle(32);
    assert.deepEqual(workspace.calls.mutate.map((call) => call.ops), [
      [{ op: "set", path: ["providers", "fresh"], value: {} }],
      [{ op: "unset", path: ["providers", "fresh"] }],
    ], "删除必须真实执行 provider profile 的 unset");
    workspace.emit("settings/document-updated");
    workspace.emit("llm/adapters-updated");
    workspace.emit("credentials/reference-updated");
    await mounted.handle.settle(32);
    assert.deepEqual(disabledStates(), [false, false, false], "已有成功目录时刷新不得锁死角色下拉");

    // ① 旧响应（新增期目录）最后才回来：必须由 client-freshness 拒绝 —— 不覆盖目录，
    //    更不能提前把角色下拉变回可用。
    responses[1].settle(directory(["acme", "fresh"]));
    await mounted.handle.settle(32);
    assert.deepEqual(disabledStates(), [false, false, false], "旧响应落定后仍应沿用缓存目录保持可用");
    assert.equal(providerOptions().includes("gamma"), false, "旧响应不得把旧目录写进下拉");

    // ② 尾随请求（事件合并出的唯一最新请求）落定：下拉必须重新可用，并使用最新目录。
    responses[2].settle(directory(["acme", "gamma"]));
    await mounted.handle.settle(32);
    assert.equal(storeOf().getSnapshot().status, "ready", "最新响应成功后 store 必须收敛到 ready");
    assert.deepEqual(disabledStates(), [false, false, false], "最新响应落定后三个下拉必须重新可用");
    assert.deepEqual(providerOptions(), ["", "acme", "gamma"], "角色下拉必须使用最新目录");

    // ③ 并发收口：整段突发只允许"一个在途 + 一个尾随"两次请求，多余事件全部合并。
    assert.equal(responses.length, 3, "多条刷新事件必须合并为一个尾随请求，不得并发失控");

    // ④ 在途请求失败同样不能把 store 永久留在 loading：尾随请求仍必须被启动并收敛。
    workspace.emit("settings/document-updated");
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.equal(responses.length, 4, "事件必须启动新的目录请求");
    responses[3].settle({ ok: false, error: { message: "目录读取失败" } });
    await mounted.handle.settle(32);
    assert.equal(responses.length, 5, "在途请求失败后仍必须启动排队的尾随请求");
    responses[4].settle(directory(["acme", "fresh"]));
    await mounted.handle.settle(32);
    assert.equal(storeOf().getSnapshot().status, "ready", "尾随请求成功后必须收敛回 ready");
    assert.deepEqual(disabledStates(), [false, false, false], "尾随请求成功后下拉必须恢复可用");

    // ⑤ 最新请求失败必须收敛到可见 error（而不是永久 loading），但已有缓存目录仍可操作。
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.equal(responses.length, 6, "事件必须启动新的目录请求");
    responses[5].settle({ ok: false, error: { message: "目录读取失败" } });
    await mounted.handle.settle(32);
    assert.equal(storeOf().getSnapshot().status, "error", "最新请求失败必须收敛到 error 状态");
    assert.deepEqual(disabledStates(), [false, false, false], "已有缓存目录时读取失败不得锁死下拉");
    assert.equal(findNode(mounted.handle.output, (node) => node.props?.className === "deg_settings_error")?.props?.children,
      "模型目录不可用", "失败必须给出可见错误文案");

    // ⑥ connection/reset 的 clear 语义保留：立刻清空已知目录、立刻重新读取，并放弃旧连接上的
    //    在途请求（绝不等待一个可能永远不会结算的旧请求）。
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.equal(responses.length, 7, "事件必须启动目录请求");
    assert.equal(connectionResets.length >= 1, true, "目录 store 必须订阅 connection/reset");
    connectionResets[0]();
    await mounted.handle.settle(32);
    // 目录被清空后，角色行仍指向的 provider 只剩「不可用」占位项——这正是清空的可见结果。
    assert.deepEqual(storeOf().getSnapshot().groups, [], "reset 必须立刻清空已知目录");
    assert.deepEqual(disabledStates(), [true, true, true], "reset 后角色下拉保持不可操作");
    assert.equal(responses.length, 8, "reset 必须立刻重新读取，不等旧请求结算");
    // 旧请求晚到的响应不得污染新连接上的目录。
    responses[6].settle(directory(["stale-only"]));
    await mounted.handle.settle(32);
    assert.deepEqual(storeOf().getSnapshot().groups, [], "旧连接上的响应必须被拒绝");
    responses[7].settle(directory(["acme", "fresh"]));
    await mounted.handle.settle(32);
    assert.deepEqual(providerOptions(), ["", "acme", "fresh"], "reset 收敛后必须使用新目录");
    assert.deepEqual(disabledStates(), [false, false, false], "reset 收敛后下拉必须重新可用");
    assert.equal(storeOf().getSnapshot().status, "ready");

    // ⑦ 销毁之后不得再启动任何远端目录调用。时序与前面同源：先有一个在途请求，再有一个
    //    刷新事件把这次在途记为"尾随刷新（queued）"，然后插件销毁，最后才让在途请求结算。
    //    历史缺陷：cleanup 只摘掉事件监听并 dispose freshness，逻辑 inflight / queued 账本
    //    仍留在 store 里；在途请求的 finally 因此认为"收尾责任仍在自己身上"，结算后照旧
    //    启动尾随刷新——插件已经销毁，却仍向远端发起一次目录 RPC。
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.equal(responses.length, 9, "事件必须启动新的目录请求");
    workspace.emit("llm/adapters-updated");
    await mounted.handle.settle(32);
    assert.equal(responses.length, 9, "在途期间的第二个事件必须合并为尾随刷新，不得并发");

    // ⑧ 交互 seam：此刻正是"刷新在途"的事故窗口（status=loading，缓存目录仍在）。真实调用角色
    //    「供应商」下拉的 onChange，验证"能选"确实落进草稿、"能存"也确实没被 status 门控锁死——
    //    旧实现按 status 硬门控时，用户在缓存目录里看得见选项却既选不了也保存不了。
    assert.equal(storeOf().getSnapshot().status, "loading", "用例前提：此刻目录刷新在途");
    roleSelect("供应商").props.onChange({ target: { value: "fresh" } });
    await mounted.handle.settle(32);
    assert.equal(roleSelect("供应商").props.value, "fresh", "刷新在途时选择 provider 必须真实写进草稿");
    assert.deepEqual(modelOptionValues(), ["", "fresh-m1"], "模型下拉必须沿用缓存目录给出可用选项");
    assert.equal(roleSelect("模型选择").props.disabled, false, "选中 provider 后模型下拉必须可用");
    assert.equal(roleSelect("思考深度").props.disabled, true, "尚未选模型时思考深度保持禁用（业务禁用条件不变）");
    assert.equal(saveButton().props.disabled, false, "刷新在途时选中 provider 后必须能保存");
    harness.dispose();
    // 销毁瞬间的可见状态（此时在途请求已把 store 置为 loading，目录仍是上一次已知值）。
    const afterDispose = storeOf().getSnapshot();
    // 在途请求的响应在销毁之后才到达：它既不得改写目录，也绝不允许拉起尾随刷新。
    responses[8].settle(directory(["stale-after-dispose"]));
    await mounted.handle.settle(32);
    assert.equal(responses.length, 9, "插件销毁后不得再启动远端目录请求");
    assert.equal(storeOf().getSnapshot(), afterDispose, "销毁后的迟到响应不得改写目录状态");
  } finally {
    globalThis.confirm = originalConfirm;
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  }
});

// ── 删除 provider 之后的「区域内」焦点归还 ─────────────────────────────────────
//
// 用户报告：在设置页删除一张 provider 卡片后，键盘焦点落回页面根，DSH 主输入框的光标
// 也随之消失。修复的边界是**只把焦点还给 DEG 区域内的稳定控件**：绝不访问、也绝不 focus
// 宿主输入框。这组用例用受控 DOM 复现四个必要条件（点击那一刻焦点在删除按钮上、接受
// confirm、写入成功、刷新完成）与两个否决条件（异步期间意图被移走、区域已卸载），并且
// 全部经**真实组件树**（设置页 → ModelConfigSection → ModelProviderCard 的真实删除按钮
// 事件）驱动，不测任何独立 helper。
//
// 明确的验证限制：受控 DOM 只固定契约，**不能**代替真实浏览器的原生 confirm 与真实宿主
// 输入框的验收；那两项必须人工在 DSH 页面上确认。

/**
 * 受控 DOM 元素替身：只实现焦点归还真正读取的读面；focus() 只记账，不触碰真实焦点。
 *
 * 布局读面（`checkVisibility` / `getClientRects`）**只在用例显式给出时装上**：
 * 真实浏览器里两者都在原型上恒存在，而"读不到布局读面"是一个必须与"读到了但不可见"
 * 区分开的独立分支（无布局引擎的替身/宿主不得被当成不可见而整体误杀）。
 *
 * `visibilityHidden: true` 用来模拟**被 CSS 藏起来**（visibility:hidden）的元素：这类元素
 * 仍然参与排版、`getClientRects()` 非空，只有带着 `{ visibilityProperty: true }` 调用的
 * `checkVisibility()` 才看得见它。替身因此必须记录 `checkVisibility` 收到的 options。
 */
function createFakeFocusElement(label, options = {}) {
  const settings = options ?? {};
  const element = {
    label,
    disabled: settings.disabled === true,
    hidden: settings.hidden === true,
    isConnected: settings.connected !== false,
    focused: 0,
    getAttribute(name) {
      return name === "aria-disabled" && settings.ariaDisabled === true ? "true" : null;
    },
    // focus() 只记账，不触碰真实焦点；可选 onFocused 钩子由用例接上 activeElement，
    // 复现真实浏览器里"聚焦会同时改写 document.activeElement"这一步。
    focus() { this.focused += 1; this.onFocused?.(this); },
  };
  // 传函数即按函数调用（用于"读面抛错"这一分支），传数组/布尔即固定返回值。
  if (settings.clientRects !== undefined) {
    element.getClientRects = typeof settings.clientRects === "function"
      ? () => settings.clientRects()
      : () => settings.clientRects;
  }
  // checkVisibility 这个读面**必须记录每次收到的 options**：不复现这一点就无法区分
  // 「实现有没有把 visibilityProperty 交给读面」。
  element.checkVisibilityCalls = [];
  // 读面在两种情况下装上：用例显式注入判定结果，或用 visibilityHidden 模拟被 CSS 藏起来的
  // 元素。两种都按"和浏览器一样保守"处理——传了 { visibilityProperty: true } 时才额外看
  // CSS visibility，没传就只按渲染结果判定。真实浏览器正是这个形状，因此替身能在不改写
  // 既有用例语义的前提下，暴露"漏传 options 就把 visibility:hidden 目标误判为可见"的回归。
  // 读面的返回值只在**确实要看 CSS visibility** 时才成立：`visibilityHidden` 元素仍然参与排版，
  // 因此漏传 options 的 `checkVisibility()` 必须照实返回 true（真实浏览器就是这样把
  // `visibility: hidden` 的元素报成可见的）；`checkVisibility: false` 的用例则只在传了 options
  // 时读到 false。两者都不需要预先求值，传函数/传固定值都保持原样。
  if (settings.checkVisibility !== undefined || settings.visibilityHidden === true || settings.checkVisibilityThrow === true) {
    element.checkVisibility = (options) => {
      element.checkVisibilityCalls.push(options);
      if (settings.checkVisibilityThrow === true) throw new Error("布局读面不可用");
      if (options?.visibilityProperty !== true) return true;
      if (settings.visibilityHidden === true) return false;
      return typeof settings.checkVisibility === "function"
        ? settings.checkVisibility() === true
        : settings.checkVisibility === true;
    };
  }
  return element;
}

/**
 * 受控 DEG 区域替身：`closest` 只认 `.deg_mc_section`，`querySelector` 只认两个公开标记。
 *
 * 作用域与目标都必须经这个替身拿到，因此生产一旦退化成 document 全局查询（或换了选择器），
 * 用例立刻表现为"作用域/目标缺失 → 不恢复焦点"，而不是被替身掩盖。
 */
function createFakeDegSection(targets = {}) {
  const section = {
    isConnected: true,
    closest: (selector) => (selector === ".deg_mc_section" ? section : null),
    querySelector: (selector) => {
      if (selector === '[data-deg-add-provider="true"]') return targets.addProvider ?? null;
      if (selector === '[data-deg-model-config-toggle="true"]') return targets.toggle ?? null;
      return null;
    },
  };
  return section;
}

/** 删除按钮替身：挂在给定区域下（生产用 `closest(".deg_mc_section")` 捕获作用域）。 */
function createFakeDeleteTrigger(section, options = {}) {
  const trigger = createFakeFocusElement("acme 删除", options);
  trigger.closest = (selector) => (selector === ".deg_mc_section" ? section : null);
  return trigger;
}

/**
 * 受控 document：在既有事件面替身上补出焦点读面（activeElement / body），并记录任何对
 * document 的全局控件查询——那是"绝不查询宿主输入框"这条边界的事故现场。
 *
 * activeElement 用访问器而不是数据属性，并且**四种状态各有一个独立驱动面**——读面契约
 * 要求把它们分开表达，替身因此必须能分别驱动，而不是靠一个开关近似：
 * - 读到真实元素 / 读到**显式 null**（已知的空焦点）：直接给 activeElement 赋值；
 * - 宿主读面存在但**返回 undefined**：setActiveElementUndefined(true)；
 * - **读面属性整体不存在**（裁剪过的宿主替身）：removeActiveElementProperty()；
 * - **读面抛错**：setActiveElementReadable(false)。
 *
 * `activeElementOnPrototype` 复现真实 DOM 的形状：浏览器里 activeElement 是
 * Document.prototype 上的**继承**访问器，own-property 探测（hasOwnProperty）会把真实
 * document 判成"没有焦点读面"；用例据此守住"读面必须走原型链"。
 */
function createFakeFocusDocument(options = {}) {
  const documentStub = createFakeDocumentEventTarget();
  let activeElement = null;
  let activeElementReadable = true;
  let activeElementUndefined = false;
  const activeElementAccessor = {
    configurable: true,
    enumerable: true,
    get() {
      if (!activeElementReadable) throw new Error("activeElement 读面不可用");
      // 读面存在但给出 undefined：宿主没有回答问题，与"抛错"同属"未知"。
      if (activeElementUndefined) return undefined;
      return activeElement;
    },
    set(value) { activeElement = value; },
  };
  // 读面宿主：默认挂在 document 替身自身；显式要求时挂到原型上（真实 document 的形状）。
  const activeElementOwner = options.activeElementOnPrototype === true ? {} : documentStub;
  Object.defineProperty(activeElementOwner, "activeElement", activeElementAccessor);
  if (activeElementOwner !== documentStub) Object.setPrototypeOf(documentStub, activeElementOwner);
  /** 关闭/恢复 activeElement 的读取能力（读面抛错路径的唯一驱动面）。 */
  documentStub.setActiveElementReadable = (next) => { activeElementReadable = next !== false; };
  /** 宿主读面存在但返回 undefined（"未知"路径，区别于读到显式 null 的"已知空焦点"）。 */
  documentStub.setActiveElementUndefined = (next) => { activeElementUndefined = next === true; };
  /** 读面属性整体不存在（"未知"路径的另一种来源：宿主压根没有这个读面）。 */
  documentStub.removeActiveElementProperty = () => { delete activeElementOwner.activeElement; };
  documentStub.body = createFakeFocusElement("body");
  documentStub.globalQueries = [];
  // 全局查询一律返回宿主输入框替身：生产若真的这么查，用例会看到它被 focus，而不是静默通过。
  documentStub.querySelector = (selector) => {
    documentStub.globalQueries.push(selector);
    return documentStub.dshInput ?? null;
  };
  return documentStub;
}

/**
 * 打开「模型配置」区域并挂上一张真实 acme 卡片的受控 DOM 环境。
 *
 * 真实部分：设置页 → ModelConfigSection → ModelProviderCard 由真实 bundle 渲染，删除走
 * 真实的 openRemoveConfirm（DEG 自渲染确认弹窗）→ confirmRemoveProvider（守卫 → 凭据 →
 * `remote.settings.mutate` → 目录刷新）；只有 DOM 读面是替身。
 * 调用方必须把 `cleanup()` 放在 finally 里（document / confirm 探针的还原也在其中）。
 *
 * 明确的验证限制：受控替身**没有真实浏览器 DOM**——删除按钮、弹窗按钮都是渲染出来的
 * React 元素描述符，DOM 侧的 focus()/querySelectorAll 由替身显式给出；因此本组用例固定的是
 * "组件在什么条件下渲染什么、调用哪个回调、把焦点交给哪个已捕获目标"这一层契约，
 * 真实浏览器的原生焦点环与滚动/遮罩渲染仍需人工在 DSH 页面上验收。
 */
async function openDeleteScenario(options = {}) {
  const workspace = workspacesForRender(options.workspaceOptions);
  /**
   * 目录读取闸门：`listConfigurableProviders` 是删除流程要等的长尾异步之一。
   * 每次调用登记一个 gate，用例按顺序决定每一轮目录响应的结算时机，因此可以精确地
   * 构造"当前轮还没结算、尾随轮还没启动"这一刻。
   */
  const directoryGates = [];
  if (options.gateDirectory === true) {
    const originalListConfigurable = workspace.remote.llm.listConfigurableProviders;
    workspace.remote.llm.listConfigurableProviders = () => {
      let release = null;
      const gate = new Promise((resolve) => { release = resolve; });
      directoryGates.push({ release });
      // 释放时可以注入一个替代响应（例如 { ok: false }）：用例据此驱动"某一轮目录读取失败"，
      // 验证失败的轮次同样会让加载事务结算，而不是把账本永久卡在 running 上。
      return gate.then((response) => (
        response === undefined ? originalListConfigurable.call(workspace.remote.llm) : response
      ));
    };
  }
  let releaseWrite = null;
  if (options.gateWrite === true) {
    // 受控写入闸门：删除流程停在 settings 写入上，用例因此可以精确地在"异步窗口内"操作。
    const gate = new Promise((resolve) => { releaseWrite = resolve; });
    const originalMutate = workspace.remote.settings.mutate;
    workspace.remote.settings.mutate = async (ns, ops, revision) => {
      await gate;
      return originalMutate(ns, ops, revision);
    };
  } else if (typeof options.writeRefusal === "string") {
    // 宿主拒绝写入：不落盘、不推进 revision，与真实 settings 的失败语义一致。
    workspace.remote.settings.mutate = async () => ({
      ok: false,
      error: { code: "settings/denied", message: options.writeRefusal },
    });
  }
  const runtime = createClientReactRuntime();
  const harness = createHarness(workspace);
  // 渲染前的宿主补丁位：用例据此接入真实目录 store（settings.section 描述符注入的那一份），
  // 其余场景都不需要。
  if (typeof options.patchHarness === "function") options.patchHarness(harness, workspace);
  // documentOptions 透传给读面替身：只有"activeElement 挂在原型上（真实 document 的
  // 形状）"这一条需要整体流程配合，其余状态都能在流程中途直接切换。
  const fakeDocument = createFakeFocusDocument(options.documentOptions);
  const restoreDocument = installGlobals({ document: fakeDocument });
  // 同步原生 confirm 的探针：删除链路**绝不允许**再调用它（旧实现正是在这里阻塞了浏览器
  // 事件循环，导致设置页与 DSH 会话输入框在弹窗存续期间全部停摆）。探针照旧记录调用并
  // 默认返回 true，好让"仍然调用 confirm 的旧实现"继续往下走，从而在断言处明确失败
  // （弹窗不存在 / 已经发生写入 / 已经删了凭据），而不是提前静默退出把回归掩盖过去。
  const originalConfirm = globalThis.confirm;
  const confirmCalls = [];
  globalThis.confirm = (message) => {
    confirmCalls.push(message);
    return true;
  };
  const addProvider = options.addProvider === null
    ? null
    : createFakeFocusElement("添加提供方", options.addProvider);
  const toggle = options.toggle === null
    ? null
    : createFakeFocusElement("模型配置折叠", options.toggle);
  const dshInput = createFakeFocusElement("DSH 输入框");
  fakeDocument.dshInput = dshInput;
  // 真实浏览器里 focus() 会同时改写 document.activeElement，受控替身必须复现这一步：
  // 否则"重叠的第二次删除是否还会再抢一次焦点"就没有区分度（替身的 activeElement 会一直
  // 停在删除按钮上）。DSH 输入框**不接**这个钩子：DEG 绝不允许聚焦它，它只用于记账。
  for (const element of [addProvider, toggle]) {
    if (element !== null) element.onFocused = (self) => { fakeDocument.activeElement = self; };
  }
  const section = createFakeDegSection({ addProvider, toggle });
  // 删除按钮本身也可以按用例注入布局读面：真实浏览器里它可能仍然挂着但已被 CSS 藏起，
  // 这种情况下恢复动作必须整体跳过（焦点不能交给一个不可见的控件）。
  const trigger = createFakeDeleteTrigger(section, options.trigger);
  let mounted = null;
  let card = null;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    globalThis.confirm = originalConfirm;
    restoreDocument();
    card?.unmount();
    mounted?.unmount();
    harness.dispose();
  };
  try {
    mounted = await openModelSection(harness, runtime, options.section ?? {});
    if (options.gateDirectory === true) {
      // 展开期的首轮目录读取必须先结算：卡片只有拿到目录之后才会渲染出来。
      assert.equal(directoryGates.length, 1, "展开时必须发起一次目录读取");
      directoryGates[0].release();
      await mounted.modelHandle.settle(32);
    }
    // 折叠态才渲染删除按钮：展开态只有应用/取消（与既有用例同一前提）。
    card = await mounted.mount((node) => node?.type?.name === "ModelProviderCard"
      && node.props?.row?.provider === "acme");
  } catch (error) {
    cleanup();
    throw error;
  }
  /** 确认弹窗的根节点（role=dialog）；弹窗关闭时返回 null。 */
  const dialogNode = () => findNode(mounted.modelHandle.output,
    (node) => node.props?.role === "dialog" && node.props?.["aria-label"] === "删除 provider 确认");
  /** 弹窗内的操作按钮（按公开 data 标记查找，每次重新查找：渲染会重建节点）。 */
  const dialogButton = (kind) => {
    const node = findNode(mounted.modelHandle.output,
      (candidate) => candidate.props?.["data-deg-remove-" + kind] === "true");
    assert.ok(node, "确认弹窗必须渲染「" + (kind === "confirm" ? "删除" : "取消") + "」按钮");
    return node;
  };
  /** 弹窗内的操作按钮替身（按渲染出的 disabled 取值，与生产标记同源）。 */
  const dialogFocusRing = () => collectNodes(mounted.modelHandle.output,
    (node) => typeof node.props?.["data-deg-dialog-action"] === "string")
    .map((node) => createFakeFocusTarget(node.props["data-deg-dialog-action"], node.props.disabled === true));
  /** 让弹窗渲染出来（组件 setState 之后必须 settle 一次才会产出新树）。 */
  const settleDialog = async (rounds = 24) => {
    await mounted.modelHandle.settle(rounds);
    await mounted.handle.settle(rounds);
  };
  /**
   * 真实删除按钮的 onClick：**只**打开 DEG 确认弹窗（同步返回）。
   * 因此用例可以在"用户已经点了删除、但还没确认"这一刻断言零远端副作用。
   */
  const openDeleteConfirm = ({ currentTarget = trigger, focusFirst = true } = {}) => {
    const button = findNode(card.output, (node) => node.props?.["aria-label"] === "acme 删除");
    assert.ok(button, "折叠态卡片必须渲染删除按钮");
    // 真实浏览器在 click 之前已经把焦点移到按钮上（mousedown 的默认行为）。
    if (focusFirst) fakeDocument.activeElement = currentTarget;
    button.props.onClick({ currentTarget });
  };
  /** 点击弹窗「删除」：从这里才开始守卫 / 凭据 / settings / 目录刷新。 */
  const confirmDelete = async (rounds = 24) => {
    await settleDialog(rounds);
    dialogButton("confirm").props.onClick();
  };
  /** 点击弹窗「取消」：只取消，不产生任何远端副作用。 */
  const cancelDelete = async (rounds = 24) => {
    await settleDialog(rounds);
    dialogButton("cancel").props.onClick();
  };
  /** 旧用例的完整用户手势：打开弹窗 → 点击「删除」。 */
  const clickDelete = async (options = {}) => {
    openDeleteConfirm(options);
    await confirmDelete();
  };

  return {
    workspace,
    mounted,
    card,
    fakeDocument,
    section,
    trigger,
    addProvider,
    toggle,
    dshInput,
    confirmCalls,
    cleanup,
    releaseWrite: () => { if (releaseWrite !== null) releaseWrite(); },
    /** 已经发出的目录读取轮数（含尚未结算的在途轮次）。 */
    directoryRequests: () => directoryGates.length,
    /**
     * 结算第 index 轮目录读取（0 基）；未发出的轮次直接断言失败，避免静默跳过。
     * 传 `response` 时用替代响应结算（例如失败的 { ok: false }），不传则走真实目录。
     */
    releaseDirectory(index = 0, response) {
      const entry = directoryGates[index];
      assert.ok(entry, "第 " + String(index + 1) + " 轮目录读取必须已经发出");
      entry.release(response);
    },
    listenerTotal: () => fakeDocument.totalListeners(),
    dialogNode,
    dialogButton,
    dialogFocusRing,
    settleDialog,
    openDeleteConfirm,
    confirmDelete,
    cancelDelete,
    clickDelete,
    async settle(rounds = 24) {
      await card.settle(rounds);
      await mounted.modelHandle.settle(rounds);
      await mounted.handle.settle(rounds);
    },
  };
}

test("模型配置回归：删除 provider 成功后把焦点还给区域内的「添加提供方」入口，绝不触碰宿主输入框", async () => {
  const scenario = await openDeleteScenario();
  try {
    assert.equal(scenario.listenerTotal(), 0, "删除之前页面替身上不应有捕获监听");
    // 删除之前的全局查询只可能来自插件装载期的样式注入；删除流程本身一次都不许有。
    const queriesBeforeDelete = scenario.fakeDocument.globalQueries.length;
    await scenario.clickDelete();
    // 异步窗口（凭据 → settings → 刷新）内三类捕获监听必须都已登记。
    assert.equal(scenario.fakeDocument.listenerCount("pointerdown"), 1, "删除期间必须观察 pointerdown");
    assert.equal(scenario.fakeDocument.listenerCount("keydown"), 1, "删除期间必须观察 keydown");
    assert.equal(scenario.fakeDocument.listenerCount("focusin"), 1, "删除期间必须观察 focusin");
    await scenario.settle();
    // 确认走的是 DEG 自己的弹窗：删除链路绝不调用同步原生 confirm。
    assert.equal(scenario.confirmCalls.length, 0, "删除链路绝不能再调用同步原生 confirm");
    assert.equal(scenario.dialogNode(), null, "删除成功后必须关掉确认弹窗");
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "删除必须真实写入 provider profile 的 unset");
    assert.equal(scenario.addProvider.focused, 1, "删除成功后必须把焦点还给「添加提供方」入口");
    assert.equal(scenario.toggle.focused, 0, "有可用目标时不得回退到折叠标题");
    assert.equal(scenario.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.deepEqual(scenario.fakeDocument.globalQueries.slice(queriesBeforeDelete), [],
      "删除期间绝不 document 全局查询控件（那样会命中宿主输入框）");
    assert.equal(scenario.listenerTotal(), 0, "成功收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：区域内入口不可用时焦点回退到折叠标题，两个目标都不可用则整体跳过", async () => {
  const cases = [
    ["add-provider 禁用", { addProvider: { disabled: true }, expectedToggle: 1 }],
    ["add-provider aria-disabled", { addProvider: { ariaDisabled: true }, expectedToggle: 1 }],
    ["add-provider 已断开", { addProvider: { connected: false }, expectedToggle: 1 }],
    ["add-provider 隐藏", { addProvider: { hidden: true }, expectedToggle: 1 }],
    ["add-provider 不存在", { addProvider: null, expectedToggle: 1 }],
    ["两个目标都不可用", { addProvider: { disabled: true }, toggle: { disabled: true }, expectedToggle: 0 }],
  ];
  for (const [name, options] of cases) {
    const scenario = await openDeleteScenario(options);
    try {
      await scenario.clickDelete();
      await scenario.settle();
      assert.equal(scenario.addProvider?.focused ?? 0, 0, name + "：不可用的入口不得被聚焦");
      assert.equal(scenario.toggle?.focused ?? 0, options.expectedToggle,
        name + "：回退行为必须与目标可用性一致");
      assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
        [[{ op: "unset", path: ["providers", "acme"] }]], name + "：焦点回退不得影响删除写入");
    } finally {
      scenario.cleanup();
    }
  }
});

test("模型配置回归：删除异步期间用户把焦点移回 DSH 输入框后，DEG 不再抢焦点", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    await scenario.clickDelete();
    assert.equal(scenario.fakeDocument.listenerCount("focusin"), 1, "异步窗口必须先登记观察器");
    // 写入还没结算时用户点回宿主输入框：浏览器会派发 focusin，activeElement 也随之改变。
    scenario.fakeDocument.activeElement = scenario.dshInput;
    scenario.fakeDocument.dispatch("focusin", { type: "focusin", target: scenario.dshInput });
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 0, "意图已被移走时不得把焦点抢回添加入口");
    assert.equal(scenario.toggle.focused, 0, "意图已被移走时也不得回退聚焦折叠标题");
    assert.equal(scenario.dshInput.focused, 0, "用户自己移到宿主输入框时 DEG 更不能去动它");
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "放弃焦点恢复不得影响删除写入");
    assert.equal(scenario.listenerTotal(), 0, "收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：删除异步期间只要出现一次用户操作就放弃焦点恢复（activeElement 仍停在删除按钮上）", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    await scenario.clickDelete();
    // 真实下载入顺序：pointerdown 先于焦点转移，因此这一支必须独立于 activeElement 生效。
    scenario.fakeDocument.dispatch("pointerdown", { type: "pointerdown" });
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.fakeDocument.activeElement, scenario.trigger, "用例前提：焦点仍停在删除按钮替身上");
    assert.equal(scenario.addProvider.focused, 0, "已经出现用户操作时必须放弃恢复");
    assert.equal(scenario.toggle.focused, 0, "已经出现用户操作时也不得回退聚焦折叠标题");
    assert.equal(scenario.listenerTotal(), 0, "收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：取消确认与 settings 写入失败都不恢复焦点，也不留下监听", async () => {
  // ① 弹窗「取消」：不删凭据、不写入、不刷目录、不登记观察器、不恢复焦点（既有语义不变）。
  const cancelled = await openDeleteScenario();
  try {
    const directoryBefore = cancelled.workspace.calls.listConfigurable;
    cancelled.openDeleteConfirm();
    await cancelled.settleDialog();
    await cancelled.cancelDelete();
    await cancelled.settle();
    assert.equal(cancelled.dialogNode(), null, "取消必须关闭弹窗");
    assert.deepEqual(cancelled.workspace.calls.credentialUnset, [], "取消确认不得删除凭据");
    assert.deepEqual(cancelled.workspace.calls.mutate, [], "取消确认不得写入");
    assert.equal(cancelled.workspace.calls.listConfigurable, directoryBefore, "取消确认不得刷新目录");
    assert.equal(cancelled.listenerTotal(), 0, "取消确认不得登记捕获监听");
    assert.equal(cancelled.dshInput.focused, 0, "取消确认绝不触碰宿主输入框");
    assert.equal(cancelled.addProvider.focused, 0, "取消确认不得把焦点交给区域入口");
    assert.equal(cancelled.toggle.focused, 0, "取消确认也不得回退聚焦折叠标题");
    assert.equal(cancelled.trigger.focused, 1, "取消后焦点必须回到打开弹窗的删除按钮");
  } finally {
    cancelled.cleanup();
  }

  // ② 写入被宿主拒绝：显示可见诊断，焦点留在原处，且失败路径必须摘掉监听。
  const refused = await openDeleteScenario({ writeRefusal: "写入被拒绝" });
  try {
    await refused.clickDelete();
    assert.equal(refused.listenerTotal(), 3, "写入开始前必须已登记三类捕获监听");
    await refused.settleDialog();
    assert.equal(findNode(refused.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_mc_error")?.props?.children, "写入被拒绝",
    "写入失败必须给出可见诊断");
    assert.equal(findNode(refused.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children, "写入被拒绝",
    "失败原因必须同时留在弹窗内（role=alert），用户才知道该取消还是重试");
    assert.ok(refused.dialogNode(), "写入失败必须保留弹窗");
    assert.equal(refused.dialogButton("confirm").props.disabled, false, "失败后必须允许重试");
    assert.equal(refused.addProvider.focused, 0, "写入失败不得恢复焦点");
    assert.equal(refused.toggle.focused, 0, "写入失败不得回退聚焦折叠标题");
    assert.equal(refused.dshInput.focused, 0, "写入失败绝不触碰宿主输入框");
    await refused.cancelDelete();
    await refused.settle();
    assert.equal(refused.dialogNode(), null, "失败后取消必须能关掉弹窗");
    assert.equal(refused.trigger.focused, 1, "失败后取消同样把焦点还给删除按钮");
    assert.equal(refused.listenerTotal(), 0, "失败路径必须摘掉全部捕获监听");
  } finally {
    refused.cleanup();
  }
});

// ── DEG 自渲染的删除确认弹窗（取代同步原生 confirm） ────────────────────────────
//
// 用户报告：在设置页新增任意 provider、再删除这个未被任何角色使用的 provider 之后，设置页
// 下拉与 DSH 会话输入框随后都不可用，重启才恢复。根因是删除链路调用同步 `globalThis.confirm()`：
// 它阻塞浏览器事件循环，弹窗存续期间页面脚本、遮罩与宿主输入框的输入处理全部停摆。
// 下面的用例固定替换后的契约：DEG 自己渲染非阻塞确认层，确认之前零远端副作用。

test("模型配置回归：点击删除只打开 DEG 自渲染的确认弹窗，确认前零远端副作用且不再调用同步原生 confirm", async () => {
  const scenario = await openDeleteScenario();
  try {
    const directoryBefore = scenario.workspace.calls.listConfigurable;
    scenario.openDeleteConfirm();
    // 同步原生 confirm 会阻塞事件循环：删除链路必须彻底不再碰它。
    assert.equal(scenario.confirmCalls.length, 0, "删除链路绝不能再调用同步原生 confirm");
    // 点击这一刻只有弹窗状态变化：不删凭据、不写 settings、不刷目录、不登记观察器。
    assert.deepEqual(scenario.workspace.calls.credentialUnset, [], "确认前不得删除凭据");
    assert.deepEqual(scenario.workspace.calls.mutate, [], "确认前不得写入 settings");
    assert.equal(scenario.workspace.calls.listConfigurable, directoryBefore, "确认前不得刷新目录");
    assert.equal(scenario.listenerTotal(), 0, "确认前不得登记焦点观察监听");

    await scenario.settleDialog();
    const dialog = scenario.dialogNode();
    assert.ok(dialog, "点击删除必须渲染 DEG 自己的确认弹窗，而不是阻塞式原生 confirm");
    assert.equal(dialog.props["aria-modal"], "true", "确认弹窗必须是模态语义");
    const text = collectNodes(dialog, (node) => node.type === "p").map((node) => node.props?.children).join(" ");
    assert.match(text, /Acme/, "弹窗必须说明要删除的是哪个 provider");
    // 打开弹窗后焦点落在「取消」：破坏性动作绝不能是默认焦点。
    assert.equal(scenario.dialogButton("cancel").props.autoFocus, true, "打开弹窗后焦点必须落在「取消」上");
    assert.equal(scenario.dialogButton("confirm").props.autoFocus, undefined, "破坏性按钮不得抢默认焦点");
    assert.deepEqual(scenario.dialogFocusRing().map((control) => control.label), ["cancel", "confirm"],
      "弹窗只包含「取消」与「删除」两个操作");

    // 取消之后一切照旧：这才是"确认前零副作用"的完整闭环。
    await scenario.cancelDelete();
    await scenario.settle();
    assert.equal(scenario.dialogNode(), null, "取消必须关掉弹窗");
    assert.deepEqual(scenario.workspace.calls.mutate, [], "取消后仍然不得写入 settings");
    assert.equal(scenario.listenerTotal(), 0, "取消后仍然不得留下捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：取消、Escape 与遮罩点击都只取消，焦点只回到 DEG 删除按钮或区域内安全回退", async () => {
  const cases = [
    ["弹窗「取消」按钮", async (scenario) => { await scenario.cancelDelete(); }],
    ["Escape", async (scenario) => {
      let prevented = 0;
      let stopped = 0;
      scenario.dialogNode().props.onKeyDown({
        key: "Escape",
        shiftKey: false,
        preventDefault() { prevented += 1; },
        stopPropagation() { stopped += 1; },
      });
      assert.equal(prevented, 1, "Escape 必须阻止默认行为");
      assert.equal(stopped, 1, "Escape 不得继续冒泡给外层");
    }],
    ["点击遮罩本身", async (scenario) => {
      const overlay = findNode(scenario.mounted.modelHandle.output,
        (node) => node.props?.className === "deg_prompt_dialog_backdrop");
      assert.ok(overlay, "确认弹窗必须渲染遮罩层");
      overlay.props.onClick();
    }],
  ];
  for (const [name, cancel] of cases) {
    const scenario = await openDeleteScenario();
    try {
      const directoryBefore = scenario.workspace.calls.listConfigurable;
      scenario.openDeleteConfirm();
      await scenario.settleDialog();
      assert.ok(scenario.dialogNode(), name + "：用例前提：确认弹窗已经打开");
      // 宿主输入框成为 activeElement 之后再取消：它绝不允许被当成恢复目标。
      scenario.fakeDocument.activeElement = scenario.dshInput;
      await cancel(scenario);
      await scenario.settle();
      assert.equal(scenario.dialogNode(), null, name + "：必须关掉弹窗");
      assert.equal(scenario.trigger.focused, 1, name + "：焦点必须回到打开弹窗的那个 DEG 删除按钮");
      assert.equal(scenario.dshInput.focused, 0, name + "：绝不能聚焦宿主输入框");
      assert.deepEqual(scenario.workspace.calls.credentialUnset, [], name + "：不得删除凭据");
      assert.deepEqual(scenario.workspace.calls.mutate, [], name + "：不得写入 settings");
      assert.equal(scenario.workspace.calls.listConfigurable, directoryBefore, name + "：不得刷新目录");
      assert.equal(scenario.listenerTotal(), 0, name + "：不得登记焦点观察监听");
    } finally {
      scenario.cleanup();
    }
  }

  // 删除按钮在弹窗存续期间被摘除（真实刷新会换掉卡片 key）：只能在点击时捕获的 DEG 区域内回退。
  const detached = await openDeleteScenario();
  try {
    detached.openDeleteConfirm();
    await detached.settleDialog();
    detached.trigger.isConnected = false;
    detached.fakeDocument.activeElement = detached.dshInput;
    await detached.cancelDelete();
    await detached.settle();
    assert.equal(detached.trigger.focused, 0, "已断开的删除按钮不得被聚焦");
    assert.equal(detached.addProvider.focused, 1, "取消必须回退到 DEG 区域内的「添加提供方」入口");
    assert.equal(detached.dshInput.focused, 0, "回退路径同样绝不能聚焦宿主输入框");
  } finally {
    detached.cleanup();
  }

  // 点击弹窗内部不得冒泡到遮罩（否则点一下说明文字就会误取消）。
  const inner = await openDeleteScenario();
  try {
    inner.openDeleteConfirm();
    await inner.settleDialog();
    let stopped = 0;
    inner.dialogNode().props.onClick({ stopPropagation() { stopped += 1; } });
    await inner.settle();
    assert.equal(stopped, 1, "弹窗内部的点击必须阻止冒泡到遮罩");
    assert.ok(inner.dialogNode(), "点击弹窗内部不得关闭确认弹窗");
  } finally {
    inner.cleanup();
  }
});

test("模型配置回归：确认弹窗的 Tab 焦点环只在本弹窗控件间循环，删除进行中按钮禁用且不再受理取消", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    scenario.openDeleteConfirm();
    await scenario.settleDialog();
    const controls = scenario.dialogFocusRing();
    assert.deepEqual(controls.map((control) => control.label), ["cancel", "confirm"],
      "焦点环只包含弹窗自己的两个操作");
    assert.equal(controls.some((control) => control.disabled), false, "待确认时两个按钮都可用");
    // 与候选弹窗同一套查询面：生产用弹窗根节点查 data-deg-dialog-action，替身给出同样的 seam。
    scenario.dialogNode().props.ref.current = createFakeFocusScope(controls);
    const pressTab = (shiftKey) => {
      let prevented = 0;
      scenario.dialogNode().props.onKeyDown({
        key: "Tab",
        shiftKey,
        preventDefault() { prevented += 1; },
        stopPropagation() {},
      });
      return prevented;
    };
    // 打开弹窗时 autoFocus 落在「取消」，从这里继续前进。
    scenario.fakeDocument.activeElement = controls[0];
    assert.equal(pressTab(false), 1, "Tab 必须阻止浏览器默认的焦点移动");
    assert.deepEqual(controls.map((control) => control.focused), [0, 1], "Tab 从「取消」前进到「删除」");
    scenario.fakeDocument.activeElement = controls[1];
    assert.equal(pressTab(false), 1);
    assert.deepEqual(controls.map((control) => control.focused), [1, 1], "末位 Tab 回到首位（不泄漏到背景页面）");
    scenario.fakeDocument.activeElement = controls[0];
    assert.equal(pressTab(true), 1);
    assert.deepEqual(controls.map((control) => control.focused), [1, 2], "首位 Shift+Tab 反向回到末位");

    // 确认删除：settings 写入被闸门挡住，弹窗进入"删除进行中"。
    await scenario.confirmDelete();
    await scenario.settleDialog();
    const running = scenario.dialogFocusRing();
    assert.deepEqual(running.map((control) => control.disabled), [true, true],
      "删除进行中两个按钮都必须禁用（防止重复提交）");
    assert.equal(scenario.dialogButton("confirm").props.children, "删除中…", "进行中必须给出可见的进行态");
    scenario.dialogNode().props.ref.current = createFakeFocusScope(running);
    let preventedRunning = 0;
    scenario.dialogNode().props.onKeyDown({
      key: "Tab",
      shiftKey: false,
      preventDefault() { preventedRunning += 1; },
      stopPropagation() {},
    });
    assert.equal(preventedRunning, 0, "没有可聚焦控件时不得拦截 Tab（宁可按浏览器默认走，也不锁死焦点）");
    assert.deepEqual(running.map((control) => control.focused), [0, 0], "禁用控件不得被聚焦");
    // 进行中 Escape 不得取消：此刻写盘可能已经发生，关掉弹窗只会掩盖真实结果。
    scenario.dialogNode().props.onKeyDown({
      key: "Escape",
      shiftKey: false,
      preventDefault() {},
      stopPropagation() {},
    });
    await scenario.settleDialog();
    assert.ok(scenario.dialogNode(), "删除进行中不得关闭弹窗");
    assert.equal(scenario.dialogButton("confirm").props.disabled, true, "进行中必须保持禁用");

    // 重复提交必须被挡住：进行中再次点击「删除」不得再发一次写入。
    scenario.dialogButton("confirm").props.onClick();
    await scenario.settleDialog();

    // 结算写入：成功路径自动关掉弹窗，并真实写入一次 unset。
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.dialogNode(), null, "删除成功后必须关掉弹窗");
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "确认后必须真实写入 provider profile 的 unset");
    assert.equal(scenario.workspace.calls.mutate.length, 1, "进行中的重复提交不得再写一次");
    assert.equal(scenario.listenerTotal(), 0, "成功收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

// ── 运行态（phase === "running"）的弹窗存续边界 ────────────────────────────────
//
// 删除进入进行中之后，取消在语义上已经不成立（凭据与 settings 可能已经写盘）。此时任何
// 一条"关闭弹窗"的路径都必须被拒绝：关掉它只会把**进行中 / 失败 / 重试**的可见入口一起
// 卸载，而异步删除仍在继续——用户再也看不到这次删除落到哪一步。

test("模型配置回归：删除进行中点击遮罩不得关闭确认弹窗，失败后错误与重试入口必须仍然可见", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    // 闸门释放后仍以失败收场：复现"进行中 → 写入被宿主拒绝"的真实时序。
    const gatedMutate = scenario.workspace.remote.settings.mutate;
    scenario.workspace.remote.settings.mutate = async (ns, ops, expectedRevision) => {
      await gatedMutate(ns, ops, expectedRevision);
      return { ok: false, error: { code: "settings/denied", message: "写入被拒绝" } };
    };
    await scenario.clickDelete();
    await scenario.settleDialog();
    assert.equal(scenario.dialogButton("confirm").props.disabled, true,
      "用例前提：写入被闸门挡住，删除处于进行中");

    const overlay = () => findNode(scenario.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_prompt_dialog_backdrop");
    assert.ok(overlay(), "确认弹窗必须渲染遮罩层");
    overlay().props.onClick();
    await scenario.settle();
    assert.ok(scenario.dialogNode(), "删除进行中点击遮罩不得关闭确认弹窗");
    assert.equal(scenario.dialogButton("confirm").props.disabled, true, "进行中仍必须保持按钮禁用");

    // 结算为失败：错误与重试入口必须仍然可见、可用。
    scenario.releaseWrite();
    await scenario.settle();
    assert.ok(scenario.dialogNode(), "写入失败后弹窗必须保留");
    assert.equal(findNode(scenario.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children, "写入被拒绝",
    "失败原因必须在弹窗内仍然可见");
    assert.equal(scenario.dialogButton("confirm").props.disabled, false, "失败后必须仍可重试");

    // 重试：再次确认必须真的再走一遍删除链路，且仍停在可重试状态。
    await scenario.settleDialog();
    scenario.dialogButton("confirm").props.onClick();
    await scenario.settle();
    assert.equal(scenario.workspace.calls.mutate.length, 2, "重试必须真的再发起一次写入");
    assert.ok(scenario.dialogNode(), "重试失败后弹窗仍必须保留");
    assert.equal(findNode(scenario.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children, "写入被拒绝",
    "重试失败的原因同样必须可见");

    // 确认态下取消必须照常工作：运行中的守卫不能把正常取消一起挡掉。
    await scenario.cancelDelete();
    await scenario.settle();
    assert.equal(scenario.dialogNode(), null, "确认态下必须能正常取消");
    assert.equal(scenario.workspace.calls.mutate.length, 2, "取消不得再发起写入");
    assert.equal(scenario.listenerTotal(), 0, "取消后不得留下捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：删除进行中折叠区域不得清掉进行中的确认状态，展开后错误与重试入口仍在", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    const gatedMutate = scenario.workspace.remote.settings.mutate;
    scenario.workspace.remote.settings.mutate = async (ns, ops, expectedRevision) => {
      await gatedMutate(ns, ops, expectedRevision);
      return { ok: false, error: { code: "settings/denied", message: "写入被拒绝" } };
    };
    await scenario.clickDelete();
    await scenario.settleDialog();
    assert.equal(scenario.dialogButton("confirm").props.disabled, true, "用例前提：删除处于进行中");

    // 折叠：弹窗随区域内容一起从页面上消失，但**进行中**的状态绝不能被清掉。
    scenario.mounted.collapse();
    await scenario.settle();
    assert.equal(scenario.dialogNode(), null, "折叠后区域内容（含确认弹窗）不再渲染");

    scenario.releaseWrite();
    await scenario.settle();
    scenario.mounted.expand();
    await scenario.settleDialog();
    assert.ok(scenario.dialogNode(), "展开后必须仍能看到这次删除的确认状态");
    assert.equal(findNode(scenario.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children, "写入被拒绝",
    "展开后失败原因必须可见");
    assert.equal(scenario.dialogButton("confirm").props.disabled, false, "展开后必须仍能重试");
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "折叠不得改变已经发生的写入");
    assert.equal(scenario.listenerTotal(), 0, "失败收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：确认后按守卫 → 凭据删除 → settings unset 的顺序执行，前三步的失败都挡在写入之前", async () => {
  // ① 角色正在使用这个 provider：守卫必须拦在最前面，凭据与 settings 一个都不许动。
  const guarded = await openDeleteScenario({
    section: {
      settingsSnapshot: {
        status: "ready",
        // 守卫只对"仍指向该 provider 的**思考档位**"生效，因此这里必须给出档位。
        value: { defaults: { explorer: { provider: "acme", model: "m1", reasoningEffort: "high" } } },
        base: undefined,
        user: undefined,
        revision: 0,
        writable: true,
        mode: "host",
      },
    },
  });
  try {
    const directoryBefore = guarded.workspace.calls.listConfigurable;
    await guarded.clickDelete();
    await guarded.settle();
    assert.deepEqual(guarded.workspace.calls.credentialUnset, [], "守卫拦截时不得删除凭据");
    assert.deepEqual(guarded.workspace.calls.mutate, [], "守卫拦截时不得写入 settings");
    assert.equal(guarded.workspace.calls.listConfigurable, directoryBefore, "守卫拦截时不得刷新目录");
    assert.ok(guarded.dialogNode(), "守卫拦截必须保留弹窗，用户可以取消");
    assert.equal(guarded.dialogButton("confirm").props.disabled, false,
      "守卫拦截后仍允许重试（角色改完之后可以再删）");
    assert.match(String(findNode(guarded.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children), /Explorer/,
    "弹窗内必须说明拦截原因");
    assert.equal(guarded.listenerTotal(), 0, "守卫拦截不得登记焦点观察监听");
  } finally {
    guarded.cleanup();
  }

  // ② 凭据删除失败：必须挡在 settings 写入之前，且弹窗保留可取消/重试。
  const credentialFailure = await openDeleteScenario();
  try {
    // 覆盖宿主凭据写面：失败也必须照实记账，否则"凭据失败挡在写入之前"就没有观察面了。
    credentialFailure.workspace.remote.credentials.unset = async (ref) => {
      credentialFailure.workspace.calls.credentialUnset.push(ref);
      return { ok: false, error: { message: "凭据删除失败" } };
    };
    await credentialFailure.clickDelete();
    await credentialFailure.settle();
    assert.deepEqual(credentialFailure.workspace.calls.credentialUnset, ["ACME_API_KEY"],
      "删除必须先尝试删除已配置的凭据");
    assert.deepEqual(credentialFailure.workspace.calls.mutate, [], "凭据失败必须挡在 settings 写入之前");
    assert.equal(findNode(credentialFailure.mounted.modelHandle.output,
      (node) => node.props?.className === "deg_remove_confirm_error")?.props?.children, "凭据删除失败",
    "凭据失败原因必须在弹窗内可见");
    assert.ok(credentialFailure.dialogNode(), "凭据失败必须保留弹窗");
  } finally {
    credentialFailure.cleanup();
  }

  // ③ 正常路径的顺序：凭据删除 → settings unset → 目录刷新。
  const success = await openDeleteScenario();
  try {
    const directoryBefore = success.workspace.calls.listConfigurable;
    await success.clickDelete();
    await success.settle();
    assert.deepEqual(success.workspace.calls.credentialUnset, ["ACME_API_KEY"], "必须先删除凭据");
    assert.deepEqual(success.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "随后必须写入 provider profile 的 unset");
    assert.equal(success.workspace.calls.listConfigurable, directoryBefore + 1,
      "最后必须按完整 load 事务刷新目录");
    assert.equal(success.addProvider.focused, 1, "成功收尾仍沿用区域内焦点恢复策略");
    assert.equal(success.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
  } finally {
    success.cleanup();
  }
});

test("模型配置回归：删除后目录不再包含该 provider 时，角色下拉可用性与「改供应商恢复」不回归", async () => {
  // 真实目录 store（settings 描述符注入的那一份）+ 真实删除流程：目录响应由用例控制，
  // 因此可以精确构造"删除后刷新回来的目录里没有行内引用的 provider"这一刻。
  const settingsSnapshot = {
    status: "ready",
    value: { defaults: { explorer: { provider: "fresh", model: "fresh-m1" } } },
    base: undefined,
    user: undefined,
    revision: 0,
    writable: true,
    mode: "host",
  };
  const directory = (ids) => ({
    ok: true,
    value: {
      groups: ids.map((id) => ({
        id,
        name: id,
        models: [{
          id: id + "-m1",
          name: id + "-M1",
          reasoning: { efforts: [{ id: "high", name: "High" }], defaultEffort: "high" },
        }],
      })),
    },
  });
  const pending = [];
  const scenario = await openDeleteScenario({
    gateDirectory: true,
    section: {
      settingsSnapshot,
      modelCatalog: (injected) => injected.modelCatalog,
    },
    patchHarness: (harness) => {
      harness.ctx.remote = {
        ...harness.ctx.remote,
        session: {
          modelCatalog: () => {
            let settle = null;
            const promise = new Promise((resolve) => { settle = resolve; });
            pending.push({ settle });
            return promise;
          },
        },
      };
    },
  });
  try {
    const roleSelect = (suffix) => findNode(scenario.mounted.handle.output,
      (node) => node.type === "select" && node.props?.["aria-label"] === "Explorer " + suffix);
    const disabledStates = () => ["供应商", "模型选择", "思考深度"].map((suffix) => roleSelect(suffix)?.props.disabled);
    const optionValues = (suffix) => collectNodes(roleSelect(suffix), (node) => node.type === "option")
      .map((node) => node.props.value);

    // 初始目录含 fresh：角色行引用得到，三个下拉都可用。
    assert.equal(pending.length, 1, "挂载必须发起一次目录请求");
    pending[0].settle(directory(["acme", "fresh"]));
    await scenario.settle();
    assert.deepEqual(disabledStates(), [false, false, false], "目录就绪时三个下拉都必须可用");
    assert.deepEqual(optionValues("供应商"), ["", "acme", "fresh"], "provider 选项来自当前目录");

    // 删除未被任何角色使用的 acme：真实写入 + 真实目录刷新。
    await scenario.clickDelete();
    await scenario.settle();
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "删除必须真实写入 provider profile 的 unset");
    scenario.releaseDirectory(1);
    await scenario.settle();

    // 刷新回来的目录里不再有 acme，连行内引用的 fresh 也消失了：行仍可用、且给出不可用占位，
    // 但模型/思考深度按既有语义禁用（它们没有可选的目录项）。
    scenario.workspace.emit("settings/document-updated");
    await scenario.settle();
    assert.equal(pending.length, 2, "宿主事件必须触发一次目录刷新");
    pending[1].settle(directory(["gamma"]));
    await scenario.settle();
    assert.deepEqual(optionValues("供应商"), ["", "fresh", "gamma"],
      "目录刷新后 provider 选项必须来自最新目录，并保留行内 provider 的不可用占位");
    assert.equal(optionValues("供应商").includes("acme"), false, "已删除的 provider 不得再出现在下拉里");
    assert.deepEqual(disabledStates(), [false, true, true],
      "行内 provider 不在目录中时模型/思考深度按既有语义禁用，但供应商下拉仍可操作");

    // 改供应商恢复：换到目录里的 gamma 后模型下拉立刻可用，选完模型后思考深度也可用。
    roleSelect("供应商").props.onChange({ target: { value: "gamma" } });
    await scenario.settle();
    assert.equal(roleSelect("供应商").props.value, "gamma", "改供应商必须真实写进草稿");
    assert.deepEqual(optionValues("模型选择"), ["", "gamma-m1"], "模型下拉必须反映新 provider 的目录");
    assert.deepEqual(disabledStates(), [false, false, true], "选中 provider 后模型下拉必须可用");
    roleSelect("模型选择").props.onChange({ target: { value: "gamma-m1" } });
    await scenario.settle();
    assert.equal(roleSelect("思考深度").props.value, "high", "模型目录给出的默认档位必须被采用");
    assert.equal(roleSelect("思考深度").props.disabled, false, "选中目录内模型后思考深度必须可用");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：删除期间登记的焦点意图监听在区域卸载时立即摘除，且卸载后不再恢复焦点", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    const baseline = scenario.listenerTotal();
    await scenario.clickDelete();
    assert.equal(scenario.listenerTotal(), baseline + 3, "删除期间必须登记三类捕获监听");
    // 设置页切走 / 区域被替换：ModelConfigSection 卸载。
    scenario.mounted.modelHandle.unmount();
    assert.equal(scenario.listenerTotal(), baseline, "区域卸载必须立刻摘掉全部捕获监听");
    // 真实 DOM 里卸载会把整个区域从文档摘除；替身显式复现这一点。
    scenario.section.isConnected = false;
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 0, "区域已卸载时不得把焦点还给任何控件");
    assert.equal(scenario.toggle.focused, 0, "区域已卸载时也不得回退聚焦折叠标题");
    assert.equal(scenario.workspace.calls.mutate.length, 1, "卸载不得改变已经发生的删除写入");
    assert.equal(scenario.listenerTotal(), baseline, "收尾后监听仍必须为零");
  } finally {
    scenario.cleanup();
  }
});

// ── 目录加载事务与焦点恢复的边界（Oracle P2） ─────────────────────────────────
//
// 用户可见症状：删除成功后焦点"先"回到区域内的入口，随后目录刷新的尾随轮次才渲染完成，
// 页面又把焦点打回根节点（DSH 主输入框光标随之消失）。
//
// 根因：`load()` 在"已有一轮在跑"时只置 again 标记并**立刻**返回一个已结算的 Promise，
// 删除流程因此在自己那一轮（以及它的尾随重跑）还没结束时就走完了收尾。
// 契约：并发调用拿到的必须是同一个覆盖「当前轮 + 所有 again 尾随重跑」的 Promise。

test("模型配置回归：删除流程必须等到目录加载事务（含尾随重跑）结算后才恢复焦点", async () => {
  const scenario = await openDeleteScenario({ gateDirectory: true });
  try {
    const baseline = scenario.listenerTotal();
    // 展开期的首轮读取已在 openDeleteScenario 内结算（卡片可见），此后由用例控制时序。
    assert.equal(scenario.directoryRequests(), 1, "展开时必须发起一次目录读取");
    assert.equal(scenario.addProvider.focused, 0, "删除之前不得有任何焦点恢复");

    // ① 外部失效启动一轮**在途**目录读取：这一轮迟迟不结算。
    scenario.workspace.emit("settings/document-updated");
    await scenario.settle();
    assert.equal(scenario.directoryRequests(), 2, "外部失效必须启动新一轮目录读取");
    assert.equal(scenario.addProvider.focused, 0, "在途读取期间不得恢复焦点");

    // ② 第一次删除：点击那一刻焦点确实在真实删除按钮上（clickDelete 会先设置 activeElement）。
    //    写入完成后它的 load 加入当前事务，而不是自己再开一轮。
    await scenario.clickDelete();
    await scenario.settle();
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "删除必须真实写入 provider profile");
    assert.equal(scenario.directoryRequests(), 2,
      "删除流程的 load 必须加入当前事务，不得并发发起新的目录读取");
    assert.equal(scenario.addProvider.focused, 0,
      "当前轮与尾随轮都没结算时，焦点计数必须仍为 0（旧实现会在这一刻抢回焦点）");

    // ③ 第二次删除（两个删除流程重叠）：它写完之后同样只能登记同一个尾随轮次——
    //    并发调用一旦各自开跑，这里就会多出第三轮目录请求。
    await scenario.clickDelete();
    await scenario.settle();
    assert.equal(scenario.workspace.calls.mutate.length, 2, "重叠的第二次删除同样真实写入");
    assert.equal(scenario.directoryRequests(), 2,
      "多个并发 load 只允许登记一个尾随轮次，绝不允许并发读取");
    assert.equal(scenario.listenerTotal(), baseline + 6, "重叠的两次删除各自独立登记三类捕获监听");
    assert.equal(scenario.addProvider.focused, 0, "事务未结算前焦点计数必须始终为 0");
    assert.equal(scenario.toggle.focused, 0, "事务未结算时也不得回退聚焦折叠标题");

    // ④ 结算在途轮次：只允许启动**一个**尾随轮次。
    scenario.releaseDirectory(1);
    await scenario.settle();
    assert.equal(scenario.directoryRequests(), 3, "并发的多次 load 合并成一个尾随重跑（coalescing 不变）");
    assert.equal(scenario.addProvider.focused, 0, "尾随轮次没结算前不得恢复焦点");
    assert.equal(scenario.listenerTotal(), baseline + 6, "尾随轮次期间观察器仍必须挂在账本上");

    // ⑤ 结算尾随轮次：事务结束，焦点恰好恢复一次（第二次流程发现焦点已经移走，自动放弃）。
    scenario.releaseDirectory(2);
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 1, "全部轮次结算后焦点必须恰好恢复一次");
    assert.equal(scenario.toggle.focused, 0, "有可用目标时不得回退到折叠标题");
    assert.equal(scenario.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.equal(scenario.directoryRequests(), 3, "事务结算后不得再发起新的目录读取");
    assert.equal(scenario.listenerTotal(), baseline, "收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：失败的目录轮次同样让加载事务结算，删除流程不会永久挂起", async () => {
  const scenario = await openDeleteScenario({ gateDirectory: true });
  try {
    // 在途轮次（外部失效触发）+ 删除流程登记的尾随轮次，两个都在事务里。
    scenario.workspace.emit("settings/document-updated");
    await scenario.settle();
    assert.equal(scenario.directoryRequests(), 2, "外部失效必须启动新一轮目录读取");
    await scenario.clickDelete();
    await scenario.settle();
    assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "删除必须真实写入 provider profile");
    assert.equal(scenario.addProvider.focused, 0, "事务未结算时不得恢复焦点");

    // 在途轮次以失败响应结算：runLoad 内部已收敛为 error 状态，事务必须继续推进到
    // 尾随轮次，绝不能把 running / promise 账本卡住（那样删除流程会永久挂起）。
    scenario.releaseDirectory(1, { ok: false, error: { message: "目录读取失败" } });
    await scenario.settle();
    assert.equal(scenario.directoryRequests(), 3, "失败的轮次之后仍必须启动尾随重跑");
    assert.equal(scenario.addProvider.focused, 0, "尾随轮次未结算前不得恢复焦点");

    scenario.releaseDirectory(2);
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 1, "事务结算后焦点必须恰好恢复一次");
    assert.equal(scenario.toggle.focused, 0, "有可用目标时不得回退到折叠标题");
    assert.equal(scenario.directoryRequests(), 3, "事务结算后不得再发起新的目录读取");
    assert.equal(scenario.listenerTotal(), 0, "失败轮次收尾后也必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：焦点读面失败时既不登记恢复意图，也不把未知当成安全空焦点", async () => {
  // ① 点击那一刻读不到 activeElement：无法证明"焦点确实在这个删除按钮上"→ 不得 arm。
  const unreadable = await openDeleteScenario();
  try {
    const baseline = unreadable.listenerTotal();
    unreadable.fakeDocument.setActiveElementReadable(false);
    await unreadable.clickDelete();
    assert.equal(unreadable.listenerTotal(), baseline, "焦点读面失败时不得登记任何捕获监听");
    await unreadable.settle();
    assert.deepEqual(unreadable.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "焦点读面失败不得影响删除写入");
    assert.equal(unreadable.addProvider.focused, 0, "无法证明焦点归属时绝不恢复焦点");
    assert.equal(unreadable.toggle.focused, 0, "无法证明焦点归属时也不得回退聚焦折叠标题");
    assert.equal(unreadable.listenerTotal(), baseline, "收尾后监听仍必须为零");
  } finally {
    unreadable.cleanup();
  }

  // ② 点击时可读（焦点确实在按钮上），异步窗口内读面变成失败：收尾必须安全跳过，
  //    绝不能把"读不到"当成"焦点停在安全的空处"而把焦点抢回来。
  const lateFailure = await openDeleteScenario({ gateWrite: true });
  try {
    const baseline = lateFailure.listenerTotal();
    await lateFailure.clickDelete();
    assert.equal(lateFailure.listenerTotal(), baseline + 3, "点击时可读时必须正常登记三类捕获监听");
    lateFailure.fakeDocument.setActiveElementReadable(false);
    lateFailure.releaseWrite();
    await lateFailure.settle();
    assert.equal(lateFailure.addProvider.focused, 0, "收尾读面失败必须安全跳过恢复");
    assert.equal(lateFailure.toggle.focused, 0, "收尾读面失败也不得回退聚焦折叠标题");
    assert.equal(lateFailure.listenerTotal(), baseline, "失败路径仍必须摘掉全部捕获监听");
  } finally {
    lateFailure.cleanup();
  }
});

// ── 焦点读面的三态区分：显式 null vs undefined/抛错 ──────────────────────────────
//
// 三个状态必须分开表达，只有中间那一种是"成功"：
// - `activeElement` 明确返回 **null**（没有焦点 / 焦点落在 body、页面根）= **已知的空焦点**，
//   收尾允许按"焦点仍停在原处"恢复；
// - **属性不存在** 或 getter 返回 **undefined** = 读面没有给出答案，**未知**，收尾必须跳过；
// - getter **抛错** = 同样是未知（既有用例已覆盖）。
// 把后两种折叠成 null（旧实现的 `activeElement ?? null`）会让收尾把"读不到"当成"焦点停在
// 安全的空处"：同一次删除里点击那一刻读到真实删除按钮、收尾读面退化成 undefined 的非标准
// 宿主，因此会把未知当已知，把焦点从宿主手里抢回 DEG 区域。

test("模型配置回归：收尾读面给出 undefined 或属性整体缺失时必须按未知处理，绝不恢复焦点", async () => {
  const cases = [
    ["getter 返回 undefined", (documentStub) => documentStub.setActiveElementUndefined(true)],
    ["activeElement 属性不存在", (documentStub) => documentStub.removeActiveElementProperty()],
  ];
  for (const [name, degradeReadFace] of cases) {
    // 目录读取加闸：删除写入结算后流程停在"等待目录刷新"，用例可以精确地在这个窗口里
    // 把读面切换成"没有答案"，从而复现非标准宿主的真实时序。
    const scenario = await openDeleteScenario({ gateDirectory: true });
    try {
      const baseline = scenario.listenerTotal();
      // 点击那一刻读面真实可用、焦点确实在删除按钮上：恢复意图必须正常登记。
      await scenario.clickDelete();
      await scenario.settle();
      assert.equal(scenario.listenerTotal(), baseline + 3,
        name + "：点击时可读时必须登记三类捕获监听");
      assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
        [[{ op: "unset", path: ["providers", "acme"] }]], name + "：删除必须真实写入");
      assert.equal(scenario.directoryRequests(), 2,
        name + "：删除成功后必须有一轮尚未结算的目录刷新（用例前提）");
      assert.equal(scenario.addProvider.focused, 0, name + "：目录刷新未结算前不得恢复焦点");

      // 删除已经成功、目录刷新仍在途：宿主读面退化成"没有答案"。
      degradeReadFace(scenario.fakeDocument);
      scenario.releaseDirectory(1);
      await scenario.settle();
      assert.equal(scenario.addProvider.focused, 0, name + "：读面没有给出答案时绝不恢复焦点");
      assert.equal(scenario.toggle.focused, 0, name + "：读面没有给出答案时也不得回退聚焦折叠标题");
      assert.equal(scenario.dshInput.focused, 0, name + "：更不得碰宿主输入框");
      assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
        [[{ op: "unset", path: ["providers", "acme"] }]], name + "：读面退化不得改变已经完成的删除写入");
      assert.equal(scenario.listenerTotal(), baseline, name + "：收尾仍必须摘掉全部捕获监听");
    } finally {
      scenario.cleanup();
    }
  }
});

test("模型配置回归：收尾读到显式 null（已知空焦点）时仍必须恢复焦点，不得把 null 一起否掉", async () => {
  // 真实浏览器里删除按钮被摘除后焦点会落到 body / 页面根，document.activeElement 就是
  // null。这是**已知的空焦点**：收紧 undefined 绝不能把这条合法恢复路径一起掐掉。
  const scenario = await openDeleteScenario({ gateDirectory: true });
  try {
    await scenario.clickDelete();
    await scenario.settle();
    assert.equal(scenario.directoryRequests(), 2, "用例前提：删除成功后有一轮在途目录刷新");
    assert.equal(scenario.addProvider.focused, 0, "用例前提：目录刷新结算前不得恢复焦点");
    scenario.fakeDocument.activeElement = null;
    scenario.releaseDirectory(1);
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 1, "显式 null 是已知的空焦点，收尾必须恢复焦点");
    assert.equal(scenario.toggle.focused, 0, "有可用目标时不得回退到折叠标题");
    assert.equal(scenario.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.equal(scenario.listenerTotal(), 0, "收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：activeElement 定义在原型上（真实 document 的形状）时读面必须照常工作", async () => {
  // 真实 document 的 activeElement 是 Document.prototype 上的继承访问器：任何形式
  // own-property 限定（hasOwnProperty / 只认数据属性）都会把真实 DOM 判成"没有焦点读面"，
  // 让整条恢复路径静默失效。替身把读面挂到原型上，守住"读面必须走原型链"。
  const scenario = await openDeleteScenario({
    gateDirectory: true,
    documentOptions: { activeElementOnPrototype: true },
  });
  try {
    const baseline = scenario.listenerTotal();
    await scenario.clickDelete();
    await scenario.settle();
    assert.equal(scenario.listenerTotal(), baseline + 3,
      "继承的 activeElement 读面必须照常参与「焦点归属」判定并登记恢复意图");
    scenario.fakeDocument.activeElement = null;
    scenario.releaseDirectory(1);
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 1, "继承的 activeElement 读面必须照常驱动焦点恢复");
    assert.equal(scenario.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.equal(scenario.listenerTotal(), baseline, "收尾必须摘掉全部捕获监听");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：恢复目标的可见性按 checkVisibility/getClientRects 判定，零矩形与不可见候选跳到下一个", async () => {
  // 真实浏览器里 `offsetParent` 定义在 HTMLElement.prototype 上：用 own property 探测
  // 它等于这条判定从未生效（旧实现），而 fixed 定位元素的 offsetParent 本来就是 null。
  const FIXED_RECT = [{ x: 0, y: 0, width: 120, height: 32 }];
  const cases = [
    ["fixed 定位且有渲染矩形", { clientRects: FIXED_RECT }, 1, 0],
    ["零渲染矩形（未排版 / display:none）", { clientRects: [] }, 0, 1],
    ["checkVisibility 判定不可见", { checkVisibility: false, clientRects: FIXED_RECT }, 0, 1],
    ["两个读面都判定可见", { checkVisibility: true, clientRects: FIXED_RECT }, 1, 0],
    ["布局读面抛错时不做无根据的判定", { clientRects: () => { throw new Error("布局读面不可用"); } }, 1, 0],
  ];
  for (const [name, addProviderOptions, expectedAdd, expectedToggle] of cases) {
    const scenario = await openDeleteScenario({ addProvider: addProviderOptions });
    try {
      await scenario.clickDelete();
      await scenario.settle();
      assert.equal(scenario.addProvider.focused, expectedAdd,
        name + "：「添加提供方」的聚焦结果必须与可见性判定一致");
      assert.equal(scenario.toggle.focused, expectedToggle,
        name + "：不可见的目标必须被跳过并继续尝试下一个候选");
      assert.deepEqual(scenario.workspace.calls.mutate.map((call) => call.ops),
        [[{ op: "unset", path: ["providers", "acme"] }]], name + "：可见性判定不得影响删除写入");
    } finally {
      scenario.cleanup();
    }
  }

  // 两个候选都不可见时整体跳过：一个控件都不聚焦，更不碰宿主输入框。
  const nothingVisible = await openDeleteScenario({
    addProvider: { clientRects: [] },
    toggle: { checkVisibility: false },
  });
  try {
    await nothingVisible.clickDelete();
    await nothingVisible.settle();
    assert.equal(nothingVisible.addProvider.focused, 0, "零渲染矩形的候选不得被聚焦");
    assert.equal(nothingVisible.toggle.focused, 0, "不可见的回退候选也不得被聚焦");
    assert.equal(nothingVisible.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.equal(nothingVisible.listenerTotal(), 0, "整体跳过也必须摘掉全部捕获监听");
  } finally {
    nothingVisible.cleanup();
  }
});
test("模型配置回归：visibility:hidden 的恢复目标必须靠 checkVisibility({ visibilityProperty: true }) 识破，检查异常不得影响删除", async () => {
  // 回归现场：`Element.checkVisibility()` 的默认语义**只**看元素是否渲染。一个被 CSS
  // `visibility: hidden` 藏起来的控件仍然参与排版、`getClientRects()` 也非空，所以不带
  // options 调用时它会伪装成可用目标，DEG 随后把键盘焦点交给一个看不见的控件。只有
  // `checkVisibility({ visibilityProperty: true })` 才覆盖 visibility 属性；用例里的固定
  // 矩形就是"这个元素有盒子但不可见"的真实形状，替身同时记录每次调用收到的 options，
  // 因此"漏传 options"与"传了 options"在断言上无法互相冒充。
  const RENDERED_RECT = [{ x: 0, y: 0, width: 120, height: 32 }];

  // ① 隐藏的「添加提供方」必须被跳过，焦点继续落到折叠标题，且删除写入不受影响。
  const hiddenAddProvider = await openDeleteScenario({
    addProvider: { visibilityHidden: true, clientRects: RENDERED_RECT },
  });
  try {
    await hiddenAddProvider.clickDelete();
    await hiddenAddProvider.settle();
    assert.equal(hiddenAddProvider.addProvider.focused, 0,
      "visibility:hidden 的目标不得被聚焦：默认 checkVisibility 看不见它");
    assert.equal(hiddenAddProvider.toggle.focused, 1, "跳过隐藏目标后必须继续尝试下一个候选");
    assert.deepEqual(hiddenAddProvider.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "可见性判定不得影响删除写入");
    const addProviderCalls = hiddenAddProvider.addProvider.checkVisibilityCalls;
    assert.equal(addProviderCalls.length, 1, "候选可用性必须经 checkVisibility 读面判定，且每次判定只读一次");
    assert.equal(addProviderCalls.every((options) => options?.visibilityProperty === true), true,
      "每次 checkVisibility 调用都必须显式带上 visibilityProperty:true，否则 visibility:hidden 会被误判为可见");
    assert.equal(hiddenAddProvider.toggle.checkVisibilityCalls.length, 0,
      "仍可见的折叠标题不应被布局读面波及");
    assert.equal(hiddenAddProvider.listenerTotal(), 0, "成功收尾必须摘掉全部捕获监听");
  } finally {
    hiddenAddProvider.cleanup();
  }

  // ② 两个候选都只可能被 visibilityProperty 识破：一个控件都不聚焦，更不碰宿主输入框。
  const bothHidden = await openDeleteScenario({
    addProvider: { visibilityHidden: true, clientRects: RENDERED_RECT },
    toggle: { visibilityHidden: true, clientRects: RENDERED_RECT },
  });
  try {
    await bothHidden.clickDelete();
    await bothHidden.settle();
    assert.equal(bothHidden.addProvider.focused, 0, "隐藏的入口不得被聚焦");
    assert.equal(bothHidden.toggle.focused, 0, "隐藏的回退候选也不得被聚焦");
    assert.equal(bothHidden.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.equal(bothHidden.toggle.checkVisibilityCalls.every(
      (options) => options?.visibilityProperty === true), true,
    "回退候选的判定同样必须带 visibilityProperty:true");
    assert.deepEqual(bothHidden.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "两个候选都不可见时删除仍必须写盘");
    assert.equal(bothHidden.listenerTotal(), 0, "整体跳过也必须摘掉全部捕获监听");
  } finally {
    bothHidden.cleanup();
  }

  // ③ 宿主实现对 options 抛错（不认识 visibilityProperty 的实现变体）：异常必须被当作
  //    "这个读面读不到"，退到 getClientRects 继续判定，而不是连累删除结果。
  const throwingOptions = await openDeleteScenario({
    addProvider: { checkVisibilityThrow: true, clientRects: RENDERED_RECT },
  });
  try {
    await throwingOptions.clickDelete();
    await throwingOptions.settle();
    assert.equal(throwingOptions.addProvider.focused, 1,
      "options 抛错时必须回退到 getClientRects 判定并保留恢复能力");
    assert.equal(throwingOptions.toggle.focused, 0, "有可用目标时不得回退到折叠标题");
    assert.deepEqual(throwingOptions.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "检查抛错绝不允许影响 provider 删除");
    assert.equal(throwingOptions.addProvider.checkVisibilityCalls.every(
      (options) => options?.visibilityProperty === true), true,
    "抛错路径同样说明实现传的是 visibilityProperty:true");
    assert.equal(throwingOptions.listenerTotal(), 0, "失败路径仍必须摘掉全部捕获监听");
  } finally {
    throwingOptions.cleanup();
  }

  // ④ 首选候选检查抛错且零渲染矩形（两个读面都判它不可用）、回退候选被 CSS 藏起来：
  //    焦点整体跳过，删除写入照旧——"检查异常不走运也不得影响删除"这条边界的收口。
  const allRejected = await openDeleteScenario({
    addProvider: { checkVisibilityThrow: true, clientRects: [] },
    toggle: { visibilityHidden: true, clientRects: RENDERED_RECT },
  });
  try {
    await allRejected.clickDelete();
    await allRejected.settle();
    assert.equal(allRejected.addProvider.focused, 0, "检查抛错且没有渲染矩形的候选不得被聚焦");
    assert.equal(allRejected.toggle.focused, 0, "不可见的回退候选也不得被聚焦");
    assert.equal(allRejected.dshInput.focused, 0, "DEG 绝不聚焦宿主输入框");
    assert.deepEqual(allRejected.workspace.calls.mutate.map((call) => call.ops),
      [[{ op: "unset", path: ["providers", "acme"] }]], "候选全部被拒时删除仍必须写盘");
    assert.equal(allRejected.listenerTotal(), 0, "整体跳过也必须摘掉全部捕获监听");
  } finally {
    allRejected.cleanup();
  }
});

test("模型配置回归：焦点观察器账本随首个渲染建立、卸载即关闭，关闭后到达的登记当场自我清理", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    const baseline = scenario.listenerTotal();
    // 重叠的两次删除：账本是集合，两条观察器各自归各自的流程所有。
    await scenario.clickDelete();
    await scenario.clickDelete();
    assert.equal(scenario.listenerTotal(), baseline + 6, "重叠的两次删除各自登记三类捕获监听");
    scenario.openDeleteConfirm();
    await scenario.settleDialog();
    assert.ok(scenario.dialogNode(), "用例前提：第三次删除的确认弹窗已经打开");
    scenario.mounted.modelHandle.unmount();
    assert.equal(scenario.listenerTotal(), baseline, "卸载必须摘除全部观察器，而不是只摘最后一个");
    scenario.section.isConnected = false;
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.listenerTotal(), baseline, "两个在途流程收尾后监听仍必须为零");

    // 区域已经卸载（设置页切走），但测试替身里卸载前留下的事件处理仍然存活。这里显式制造
    // 一次"账本关闭之后才到达的登记"：它必须当场自我清理，绝不允许在页面上留下无人认领的
    // 捕获监听。真实 React 的 useRef 初始化与 passive effect 之间同样存在这段时序差
    // （effect 还没跑到的登记会落进旧实现的 null 而永远没人清理），这条断言锁定的是
    // 「集合随首个渲染建立、卸载即关闭」这一契约本身。
    // 第三次删除的弹窗必须在**卸载之前**打开：卸载后 setRemoveIntent 与 React 的 setState
    // 一样不生效，只有卸载前已经渲染出来的弹窗按钮才点得动。
    await scenario.confirmDelete();
    assert.equal(scenario.listenerTotal(), baseline, "账本关闭后的登记必须当场自我清理");
    await scenario.settle();
    assert.equal(scenario.workspace.calls.mutate.length, 3, "迟到的删除流程必须确实走到了写入点");
    assert.equal(scenario.listenerTotal(), baseline, "迟到流程收尾后监听仍必须为零");
    assert.equal(scenario.addProvider.focused, 0, "区域已卸载时不得把焦点还给任何控件");
    assert.equal(scenario.toggle.focused, 0, "区域已卸载时也不得回退聚焦折叠标题");
  } finally {
    scenario.cleanup();
  }
});

test("模型配置回归：双击删除让两个流程重叠时，卸载仍摘除全部焦点意图监听", async () => {
  const scenario = await openDeleteScenario({ gateWrite: true });
  try {
    const baseline = scenario.listenerTotal();
    await scenario.clickDelete();
    await scenario.clickDelete();
    assert.equal(scenario.listenerTotal(), baseline + 6, "重叠的两次删除各自登记三类捕获监听");
    // 单槽账本只会摘掉最后一次登记的观察器：这里的 +6 就是那条回归线。
    scenario.mounted.modelHandle.unmount();
    assert.equal(scenario.listenerTotal(), baseline, "卸载必须摘除全部观察器，而不是只摘最后一个");
    scenario.section.isConnected = false;
    scenario.releaseWrite();
    await scenario.settle();
    assert.equal(scenario.addProvider.focused, 0, "区域已卸载时不得恢复焦点");
    assert.equal(scenario.toggle.focused, 0, "区域已卸载时也不得回退聚焦折叠标题");
    assert.equal(scenario.listenerTotal(), baseline, "收尾后监听仍必须为零");
  } finally {
    scenario.cleanup();
  }
});
