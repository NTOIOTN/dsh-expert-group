/**
 * 「模型配置」宿主面适配（describe 面 + remote.llm/credentials/settings 接线）（R8 票据 26）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-model-config-host")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientModelConfigHost(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-model-config-host");

    // ── 「模型配置」区域：默认折叠，provider 卡片按需展开且独立应用/取消 ───────────
    /** 装配期侧车模块的检查点键（与相邻 IIFE 模块的 Symbol 约定一致）。 */
    const MODEL_CONFIG_GLOBAL_KEY = "dsh-expert-group/client-model-config";

    /**
     * 自定义 provider 的 settings 命名空间与 profile 基路径。
     *
     * `llm-pi-ai` 是 DSH 中唯一支持手写 route 的 adapter family（它的 schema 也是唯一
     * 暴露协议联合类型的），因此自定义 provider 只能落在它下面。
     */
    const CUSTOM_PROVIDER_NS = "llm-pi-ai";
    const CUSTOM_PROFILE_BASE_PATH = Object.freeze(["providers"]);
    /**
     * 读取协议词表用的探针 route。
     *
     * `api` 字段是 `providers` 字典里的固定形状，因此任何 route 名都能走到同一个 union 节点；
     * 用下划线前缀声明一个不可能与真实 route 冲突、也不符合 route 词表的探针名。
     */
    const CUSTOM_ROUTE_PROBE = "_probe";

    /**
     * 解析「模型配置」的唯一纯数据流实现。
     *
     * 正常路径从 `globalThis` 的检查点取回（装配期先于本 descriptor 执行的 IIFE 已写入）；
     * 测试替身/宿主注入路径允许把同一份实现作为可选客户端服务传入，两条路径取到的是
     * 同一个对象，不存在第二份实现。
     *
     * 注意：这里的宿主上下文只能来自参数——绝不能闭包引用 apply 作用域里的 `ctx`，
     * 否则会命中暂时性死区并让整个区域静默消失。
     */
    function resolveModelConfig(hostCtx, sidecar) {
      if (sidecar !== null && sidecar !== undefined) return sidecar;
      try {
        const fromCtx = typeof hostCtx?.get === "function" ? hostCtx.get(MODEL_CONFIG_GLOBAL_KEY) : null;
        if (fromCtx !== null && fromCtx !== undefined) return fromCtx;
      } catch { /* 服务未安装或代理拒答。 */ }
      try {
        return globalThis[Symbol.for(MODEL_CONFIG_GLOBAL_KEY)];
      } catch {
        return undefined;
      }
    }

    /**
     * 模型配置的数据流与宿主面适配层。
     *
     * 唯一纯函数实现在 client-model-config.js（装配期先于本 descriptor 执行的 IIFE）；
     * 这里只负责把它接到公开 API 上：`remote.llm`（provider 目录与"获取模型"）、
     * `remote.credentials`（API Key 只写不读明文）、`remote.settings`（按 namespace revision
     * 提交路径操作）与 `configForms.describe()`（命名空间视图与 schema，与旧 binder describe 同形状）。
     *
     * 直接调用 `remote.settings.mutate` 而不是配置表单的 `mutate`：后者不返回结果，
     * 无法把 schema 拒绝与 revision 冲突如实报给用户，而需求要求"拒绝时显示错误且不落盘"。
     */
    function createModelConfigHost(hostCtx, describeSource, sidecar) {
      const config = resolveModelConfig(hostCtx, sidecar);
      if (config === undefined) return null;
      /**
       * 读取一个宿主服务或 Remote 命名空间。
       *
       * 两条路径缺一不可：
       * 1. `ctx.get(name)` —— 真实宿主的正确入口。gateway 把每个命名空间注册成**独立的
       *    Cordis 服务** `remote.<namespace>`，而 `ctx.get` 不带 inject 门控。直接写
       *    `ctx.remote.llm` 会命中 traceable 代理的 inject 校验并抛
       *    `cannot get property "remote.llm" without inject`，让整个客户端 fiber FAILED
       *    （真实宿主表现为启动页 “dsh-expert-group: failed”，入口未能激活）。
       * 2. 逐段属性回退 —— 兼容把命名空间挂在其父服务对象上的旧宿主与测试替身
       *    （`ctx.remote.llm` 是普通属性，不存在 traceable 门控）。
       *
       * 任何一层缺失或代理拒答都返回 null：模型配置是可选能力，缺失时只降级为只读提示，
       * 绝不让整条客户端入口失败。
       */
      const readService = (name) => {
        if (typeof hostCtx?.get === "function") {
          try {
            const value = hostCtx.get(name);
            if (value !== undefined && value !== null) return value;
          } catch { /* 服务未安装或代理拒答，继续尝试属性回退。 */ }
        }
        let current = hostCtx;
        for (const segment of String(name).split(".")) {
          if (segment.length === 0) continue;
          if (current === undefined || current === null) return null;
          try {
            current = current[segment];
          } catch {
            return null;
          }
        }
        return current === undefined ? null : current;
      };
      const readMethod = (target, name) => {
        try {
          const value = target?.[name];
          return typeof value === "function" ? value : null;
        } catch {
          return null;
        }
      };
      // 统一经 readService 解析：缺失时整段模型配置降级为只读提示，不影响角色配置与侧边栏。
      const llm = readService("remote.llm");
      const credentials = readService("remote.credentials");
      const settingsRemote = readService("remote.settings");
      // describe 面唯一来源是 `configForms.describe()`（0.1.7-alpha.2 的 settings 服务公开面，
      // 与旧 binder describe 同形状：getSnapshot/subscribe/ensure/acceptView）。
      // 已删除的 settingsScope binder 与 bound scope 双回退链一并移除：宿主没有这个面时
      // 模型配置的区域视图降级为 null（不崩溃、不影响角色配置与侧边栏）。
      const describeFace = (() => {
        try {
          return typeof describeSource?.describe === "function" ? describeSource.describe() : null;
        } catch {
          return null;
        }
      })();
      // 每个 schema 信封只 rehydrate 一次：React 每次渲染都会读同一份视图，
      // 按信封对象缓存既避免重复构造，也让派生值保持稳定引用。
      const schemaCache = new WeakMap();
      const adapter = (() => {
        const schemaService = readService("settingsSchema");
        return config.createSchemaAdapter({
          rehydrate: (() => {
            const rehydrate = readMethod(schemaService, "rehydrate");
            if (rehydrate === null) return null;
            return (serialized) => {
              // 每个 schema 信封只 rehydrate 一次：React 每次渲染都会读同一份视图，
              // 按信封对象缓存既避免重复构造，也让派生值保持稳定引用。
              if (serialized !== null && typeof serialized === "object") {
                const cached = schemaCache.get(serialized);
                if (cached !== undefined) return cached;
                const node = rehydrate(serialized);
                schemaCache.set(serialized, node);
                return node;
              }
              return rehydrate(serialized);
            };
          })(),
          validate: (() => {
            const validate = readMethod(schemaService, "validate");
            return validate === null ? null : (schema, draft) => validate(schema, draft);
          })(),
          nodeAtPath: (() => {
            const nodeAtPath = readMethod(schemaService, "nodeAtPath");
            return nodeAtPath === null ? null : (root, path) => nodeAtPath(root, path);
          })(),
        });
      })();
      let views = [];
      let writable = false;
      let credentialStates = {};
      let describeError = null;
      // 宿主视图版本与"外部失效"版本必须分开，否则会形成无限刷新环。
      //
      // 宿主对象自身不触发渲染，所以这里维护两个单调递增计数：
      // - `hostRevision`：**任何**视图前进都递增（包括本组件自己 load 触发的重读）。它只用于
      //   memo 依赖，让卡片在重读后拿到新的 user 层与 revision。
      // - `hostInvalidation`：只有**外部**事件（settings mirror、连接重置）才递增。区域的加载
      //   effect 只依赖它，因此"load -> refresh -> notify -> load"不会自激；一次外部失效
      //   恰好触发一次重新加载。
      let hostRevision = 0;
      let hostInvalidation = 0;
      const hostListeners = new Set();
      const notifyHostChange = (external) => {
        hostRevision += 1;
        if (external === true) hostInvalidation += 1;
        for (const listener of [...hostListeners]) {
          try {
            listener();
          } catch { /* 单个订阅者抛错不得影响其它订阅者与 settings 视图。 */ }
        }
      };
      const subscribeHost = (listener) => {
        if (typeof listener !== "function") return () => {};
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      };

      const operations = {
        listProviderDirectory: async () => {
          const listProviders = readMethod(llm, "listProviders");
          const listConfigurable = readMethod(llm, "listConfigurableProviders");
          if (listConfigurable === null) throw new Error("当前宿主没有提供 provider 配置目录接口");
          const [registered, declared] = await Promise.all([
            listProviders === null ? Promise.resolve({ ok: true, value: [] }) : listProviders.call(llm),
            listConfigurable.call(llm),
          ]);
          if (declared?.ok !== true) throw new Error(declared?.error?.message ?? "provider 目录读取失败");
          if (registered !== null && registered?.ok !== true) throw new Error(registered?.error?.message ?? "provider 列表读取失败");
          return config.joinProviderDirectory(
            registered === null ? [] : registered.value,
            Array.isArray(declared.value) ? declared.value : [],
          );
        },
        describeCredentials: async (refs) => {
          const describe = readMethod(credentials, "describe");
          const wanted = [...new Set((Array.isArray(refs) ? refs : []).filter((ref) => typeof ref === "string" && ref.length > 0))];
          if (describe === null || wanted.length === 0) {
            credentialStates = {};
            return {};
          }
          const response = await describe.call(credentials, wanted);
          credentialStates = response?.ok === true && response.value !== null && typeof response.value === "object" ? response.value : {};
          return credentialStates;
        },
        credentialState: (ref) => (typeof ref === "string" ? credentialStates[ref] : undefined),
        /** API Key 只走 credentials 服务：明文既不进入 settings，也不进入客户端状态快照。 */
        storeKey: async (ref, value) => {
          const set = readMethod(credentials, "set");
          if (set === null) return "当前宿主没有提供凭据写入接口";
          try {
            const response = await set.call(credentials, ref, value);
            return response?.ok === true ? null : (response?.error?.message ?? "API Key 保存失败");
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        removeKey: async (ref) => {
          const unset = readMethod(credentials, "unset");
          if (unset === null) return "当前宿主没有提供凭据写入接口";
          try {
            const response = await unset.call(credentials, ref);
            return response?.ok === true ? null : (response?.error?.message ?? "API Key 删除失败");
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }
        },
        discoverModels: async (namespace, request) => {
          const discover = readMethod(llm, "discoverModels");
          if (discover === null) return { kind: "refused", message: "当前宿主没有提供「获取模型」接口" };
          try {
            const response = await discover.call(llm, namespace, request);
            if (response?.ok !== true) return { kind: "refused", message: response?.error?.message ?? "获取模型失败" };
            return { kind: "found", models: Array.isArray(response.value) ? response.value : [] };
          } catch (error) {
            return { kind: "refused", message: error instanceof Error ? error.message : String(error) };
          }
        },
      };

      const refreshSettingsView = async () => {
        describeError = null;
        if (describeFace === null) {
          describeError = "当前宿主没有提供 settings namespace 视图";
          views = [];
          writable = false;
          return;
        }
        try {
          await describeFace.ensure();
        } catch { /* 读取失败由下面的一致性检查报错。 */ }
        const snapshot = describeFace.getSnapshot?.() ?? {};
        const view = snapshot.view;
        if (view === undefined) {
          describeError = snapshot.error ?? "settings 命名空间不可用";
          views = [];
          // 视图缺失时必须显式落回只读：否则一次成功的读取会把 writable 留在 true，
          // 后续读取失败时写入按钮仍然可点，最终只会在宿主边界失败。
          writable = false;
          return;
        }
        views = Array.isArray(view.namespaces) ? view.namespaces : [];
        // 写入权限是**整页**事实：DSH 的 settings describe 只在 view 上给出 writable，
        // namespace 条目本身不保证重复携带该字段。缺失时绝不能让可写页面降级为只读。
        writable = view.writable !== false;
        // 主动重读也通知一次（外部失效=false）：memo 依赖据此前进，但加载 effect 不受影响。
        notifyHostChange(false);
      };
      const invalidationStops = [];
      const remote = readService("remote");
      const remoteOn = readMethod(remote, "$on");
      if (remoteOn !== null) {
        for (const event of ["llm/adapters-updated", "settings/document-updated", "credentials/reference-updated"]) {
          try {
            invalidationStops.push(remoteOn.call(remote, event, () => notifyHostChange(true)));
          } catch { /* 旧宿主不支持该事件时保持设置页可用。 */ }
        }
      }
      const hostOn = readMethod(hostCtx, "on");
      if (hostOn !== null) {
        try {
          invalidationStops.push(hostOn.call(hostCtx, "connection/reset", () => notifyHostChange(true)));
        } catch { /* 旧宿主没有连接事件面时无需额外刷新。 */ }
      }
      if (typeof hostCtx?.effect === "function") {
        hostCtx.effect(() => () => {
          for (const stop of invalidationStops) if (typeof stop === "function") stop();
          hostListeners.clear();
        }, "dsh-expert-group: model config settings mirror events");
      }

      const namespaceView = (ns) => {
        if (describeFace !== null) return config.namespaceViewOf({ namespaces: views }, ns);
        return undefined;
      };
      const settingsSchemaInfo = (ns) => {
        const view = namespaceView(ns);
        return config.namespaceSchemaInfo(view ?? {}, adapter);
      };
      /**
       * 一次原子提交：本地 schema 先拦，正式 settings API 再拦。
       *
       * 任一拒绝都不写盘，并把宿主诊断原样回传；冲突只按 revision 语义判定，
       * 绝不把 schema 拒绝伪装成冲突（那样会让用户以为重新加载就能解决）。
       */
      const writeNamespace = async ({ ns, ops, expectedRevision }) => {
        const mutate = readMethod(settingsRemote, "mutate");
        if (mutate === null) return { ok: false, conflict: false, message: "当前宿主没有提供 settings 写入接口" };
        if (!config.hasOps(ops)) return { ok: true, view: namespaceView(ns) };
        const current = namespaceView(ns)?.revision;
        if (config.revisionConflictOf(expectedRevision, current)) {
          return { ok: false, conflict: true, message: "配置已被其它会话或页面修改，本卡片的修改未提交；请重新打开该 provider 卡片后再试。" };
        }
        let response;
        try {
          response = await mutate.call(settingsRemote, ns, ops, expectedRevision);
        } catch (error) {
          return { ok: false, conflict: false, message: error instanceof Error ? error.message : String(error) };
        }
        if (response?.ok === true) {
          const view = response.value;
          // 提交边界已经落到宿主权威视图上：把它折叠回共享镜像，界面无需额外读取。
          try {
            describeFace?.acceptView?.(view);
          } catch { /* 镜像折叠失败不影响本次提交结果。 */ }
          views = Array.isArray(view?.namespaces)
            ? view.namespaces
            : views.map((entry) => (entry?.ns === ns ? view : entry));
          return { ok: true, view };
        }
        const code = response?.error?.code;
        const message = response?.error?.message ?? "保存失败";
        if (code === "settings/conflict" || code === "settings-conflict") {
          return { ok: false, conflict: true, message: `配置已被其它会话或页面修改：${message}。请重新打开该 provider 卡片后再试。` };
        }
        return { ok: false, conflict: false, message };
      };

      return {
        config,
        adapter,
        operations,
        refreshSettingsView,
        namespaceView,
        settingsSchemaInfo,
        writeNamespace,
        subscribe: subscribeHost,
        getSnapshot: () => hostRevision,
        /** 外部失效计数：只有 mirror 事件与连接重置会推进它（主动重读不会）。 */
        getInvalidation: () => hostInvalidation,
        describeError: () => describeError,
        readView: () => ({ namespaces: views, writable }),
      };
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    CUSTOM_PROFILE_BASE_PATH, CUSTOM_PROVIDER_NS, CUSTOM_ROUTE_PROBE, createModelConfigHost,
  });
})(globalThis);
