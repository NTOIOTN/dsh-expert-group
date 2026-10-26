/**
 * dsh-expert-group 组合根（票据 21b / R4-21：装配段外移）。
 *
 * 本文件只保留三样东西：
 * 1. 插件对象形状（name / Config / inject / apply）；
 * 2. **注册 adapter 表**：各装配模块按迁移前源码顺序返回「注册描述数组」，入口逐项登记
 *    `ctx.on` / `ctx.effect` / `ctx.inject` / `tools.register`——注册点的数量、事件名、
 *    label、`{prepend:true}` 与相对顺序因此逐项不变（票据 21b 铁律 1）；
 * 3. 跨段状态容器与具名能力面的构造（`createAssemblyState` / `createAssemblyCapabilities`），
 *    它们把迁移前 apply 内的词法作用域与 ctx 依赖显式化。
 *
 * 域构造（各 `createXxxDomain({ ... })` 的实参对象）、薄 adapter 函数体与注册表本体都在
 * `host/index-assembly-*.js`；装配模块不 import 本文件（C2），也绝不接收 ctx 本体。
 */
import { name } from "./host/plugin-identity.js";
import { Config, SETTINGS_NAMESPACE } from "./host/settings-schema.js";
import { defaultSettingsEntry } from "./host/index-settings-storage.js";
import { installSettingsSection } from "./host/runtime-diagnostics.js";
import { createAbortError } from "./host/rpc-request-lifecycle.js";
import {
  assemblePrelude,
  assembleRootWait,
  assembleHandoffAndFinalize,
  assembleSettingsStorage,
  assembleRoleToolSync,
  assembleStorageDomainBinding,
  assembleUsage,
} from "./host/index-assembly-bootstrap.js";
import {
  assembleGuards,
  assembleRecovery,
  assembleAutoRecovery,
} from "./host/index-assembly-guards.js";
import {
  assembleModelRoute,
  assembleAgentHandlers,
} from "./host/index-assembly-agents.js";
import {
  assembleExpertTools,
  assembleExpertGroupRuntime,
  assembleSnapshotInvalidation,
  assembleRoleTools,
  assembleToolSurface,
} from "./host/index-assembly-tools.js";
import { assembleRpcSurface } from "./host/index-assembly-rpc.js";
import {
  assembleRpcActions,
  assembleDiagnosticsAndRoute,
} from "./host/index-assembly-wire.js";

export {
  buildTerminationNotificationText,
  buildUserWaitNotificationText,
  buildTestNotificationText,
  buildRootWaitNotificationText,
} from "./host/notification-text.js";
export { createRpcRequestLifecycle } from "./host/rpc-request-lifecycle.js";
export { buildExpertTaskPrompt } from "./host/expert-task-prompt.js";
export {
  resolveExpertReportIdentity,
  shouldBlockExpertReport,
  shouldBlockExpertSendMessage,
  resolveRecoveryPersona,
} from "./host/expert-guards.js";
export {
  installExpertChildComposition,
  shouldBlockGlobalExpertSendMessage,
  createRootGenerationRegistry,
} from "./host/expert-child-composition.js";
export {
  DOMAIN_ROLE_SELECTION,
  DOMAIN_SESSION_OVERRIDES,
  DOMAIN_SESSION_OVERRIDE_META,
  DOMAIN_CHILD_MODEL_RECORD,
} from "./host/storage-domain-schema.js";

/**
 * RPC 层 400 映射与图片/路由请求共用的校验错误类型（组合根单例类身份）。
 *
 * RPC action 核心域、图片 wire 校验与上传归一派生都按**构造器**注入它，因此
 * `instanceof` 判定仍命中同一个类；任何模块内都不得新建第二个同名类。
 */
class ValidationError extends Error {}

/**
 * 跨段装配状态容器（票据 21b）：替代迁移前 `apply` 内的 const/let 词法作用域。
 *
 * - 域句柄、晚绑定槽位（fanoutHost / expertCore / roleTools…）与共享取值函数都挂在同一个
 *   per-apply 对象上；
 * - 一个进程会并发装配多个插件实例（测试 Host 并行），因此**不能用模块级 let**：那会让
 *   实例之间互相污染；
 * - 装配模块只接收这个显式状态对象与具名能力面，绝不接收 ctx。
 *
 * clock（票据 03）是**只读时钟能力面**：派发路径每次派发只取一次 now()，同一个时间戳
 * 既用于判定峰谷时段、又写入快照的 decidedAt，因此不允许在其它点二次取时。宿主提供
 * ctx.clock.now 时优先使用它（可注入假时钟的宿主），否则回落到 Date.now——回退分支
 * 不修改任何全局状态，测试也不得 monkey-patch 全局 Date。
 */
function createAssemblyState({ config, goals, services, logger, clock }) {
  const state = {
    config,
    goals,
    logger,
    services,
    // 只读时钟：默认落在系统时间函数上，绝不写回 ctx 或全局。
    clock: clock ?? { now: () => Date.now() },
    // 服务面同时平铺一份，装配段可直接解构（= 迁移前 apply 顶部的 const 别名）。
    ...services,
    // 晚绑定槽位（= 迁移前 apply 内的 let）：所有调用点都在运行期，装配顺序保证
    // 「先用后赋值」的调用点在赋值之后才被执行。
    fanoutHost: void 0,
    expertCore: void 0,
    fanoutWaits: void 0,
    fanoutCaches: void 0,
    roleTools: void 0,
    attachmentStore: void 0,
    expertGroupSessionQuery: void 0,
    // 工具面装配完成标记：settings 注入回调可能早于 apply 末尾的工具挂载。
    roleToolsReady: false,
  };
  /**
   * settings/storage 读面的稳定别名（= 迁移前的 `settingsSource()` / `source()`）。
   *
   * 只交出取值函数，绝不捕获函数值：owner 的绑定点被 installSettingsSection 的 setSource
   * 重新绑定后，全部调用点自动看到新值。提前定义是因为通知通道等**更早**的装配段就要取值。
   */
  state.settingsSource = () => state.settingsStorage.readSettingsSource();
  state.source = () => state.settingsStorage.readSnapshot();
  return state;
}

/**
 * 读取宿主时钟能力面（票据 03）。
 *
 * 返回值恒为 {now: () => number}：宿主没有 clock 服务、clock 不是对象、或 now 不可调用时
 * 退回系统时间函数。探针只读、无副作用；任何异常都按「宿主没有该能力」处理，绝不把
 * 一个诊断探针变成装配失败。
 *
 * @param {object} ctx - 严格 Cordis Context。
 * @returns {{now: () => number}} 只读时钟。
 */
function readHostClock(ctx) {
  try {
    const hostClock = ctx.clock;
    if (hostClock !== null && typeof hostClock === "object" && typeof hostClock.now === "function") {
      return { now: () => hostClock.now() };
    }
  } catch {
    // 宿主没有 clock 服务：回落系统时间函数（与迁移前的 Date.now 取值语义一致）。
  }
  return { now: () => Date.now() };
}

/**
 * 入口具名能力面（票据 21b 铁律 3）：装配模块需要的宿主能力只以具名回调交出，共 8 项
 * （票据 35 校正：此前注释写 7 项，实测 createAssemblyCapabilities 返回 8 项）。
 *
 * 这里的每个箭头都是**入口内唯一的调用点**：
 * - `effect` / `subscribe` / `registerTool` 承接「嵌套在回调里的动态注册」（域构造期的
 *   活动监听、inject 回调里的 effect、角色工具挂载）；
 * - `effectValue` 是迁移前原样传给 Connection 通道的 `ctx.effect` 值；
 * - `readCtxLocale` / `hasWaterfall` 是严格 Cordis Context 的 fail-closed 探针。
 * ctx 本体绝不出入口。
 */
function createAssemblyCapabilities(ctx, tools) {
  return {
    readCtxLocale: () => { try { return ctx.locale; } catch { return void 0; } },
    hasWaterfall: () => { try { return typeof ctx.waterfall === "function"; } catch { return false; } },
    invokeWaterfall: (payload, inner) => ctx.waterfall.call(ctx, "workspace/session-activity", payload, inner),
    effect: (factory, label) => ctx.effect(factory, label),
    effectValue: ctx.effect,
    subscribe: (event, handler, options) => (options === void 0 ? ctx.on(event, handler) : ctx.on(event, handler, options)),
    registerTool: (definition, label) => ctx.effect(() => tools.register(definition), label),
    /**
     * root 等待域的**三条全局活动监听**：域自己决定安装时机（首次查询前、只装一次），
     * 因此这里只能交出注册 adapter，不能预先登记。但 ctx.effect + 三个 ctx.on 与逆序
     * disposer 仍然全部写在入口：created → status → disposed 按序注册、逆序释放，
     * 最后复位「已安装」标记（与迁移前逐字一致）。
     */
    registerRootWaitActivityListeners: ({ onActivity, onDispose }) => {
      ctx.effect(() => {
        const stopCreated = ctx.on("agent/created", ({ agent }) => {
          onActivity(agent);
        });
        const stopStatus = ctx.on("agent/status", ({ agent }) => {
          onActivity(agent);
        });
        const stopDisposed = ctx.on("agent/disposed", ({ agent }) => {
          onActivity(agent);
        });
        return () => {
          onDispose();
          stopDisposed?.();
          stopStatus?.();
          stopCreated?.();
        };
      }, "dsh-expert-group: root turn wait activity listeners");
    },
  };
}

/**
 * 按表逐项登记（票据 21b 铁律 1）。
 *
 * 入参是装配模块按**迁移前源码顺序**返回的注册描述数组。四种注册点（ctx.on / ctx.effect /
 * ctx.inject / tools.register）的调用位置只在本函数里；每装配完一段就调用一次，因此段内与
 * 段间的相对顺序都与迁移前逐项一致。
 *
 * 描述形状：
 * - `{ kind: "effect", label, factory }` → `ctx.effect(factory, label)`；
 * - `{ kind: "tool", definition, label }` → `ctx.effect(() => tools.register(definition), label)`；
 * - `{ kind: "on", event, handler, options? }` → `ctx.on(event, handler, options?)`；
 * - `{ kind: "inject", deps, callback, optional? }` → `ctx.inject(deps, callback)`；
 *   `optional: true` 保留迁移前的「宿主提供 ctx.inject 才登记」守卫。
 */
function applyAssemblyRegistrations(ctx, tools, entries) {
  for (const entry of entries) {
    if (entry.kind === "effect") {
      ctx.effect(entry.factory, entry.label);
      continue;
    }
    if (entry.kind === "tool") {
      ctx.effect(() => tools.register(entry.definition), entry.label);
      continue;
    }
    if (entry.kind === "inject") {
      if (entry.optional === true && typeof ctx.inject !== "function") continue;
      ctx.inject(entry.deps, entry.callback);
      continue;
    }
    if (entry.kind === "on") {
      if (entry.options === void 0) ctx.on(entry.event, entry.handler);
      else ctx.on(entry.event, entry.handler, entry.options);
    }
  }
}

export default {
  name,
  Config,
  inject: ["tools", "subagents", "systemPrompt", "llm", "agents", "settings", "webServer"],
  apply(ctx, config) {
    const tools = ctx.tools;
    const subagents = ctx.subagents;
    const systemPrompt = ctx.systemPrompt;
    const llm = ctx.llm;
    const agents = ctx.agents;
    const settings = ctx.settings;
    const webServer = ctx.webServer;
    // 注意：本插件**不再调用 goals.pause / goals.resume**（旧 goal handoff 已整体删除）。
    // root 等待语义完全由「保持当前 turn 打开」实现（见 host/turn-wait.js）。
    // 这里读取的 goals 服务只用于**只读**快照投影：Expert Group 侧边栏展示每个 root 的
    // 目标阶段（host/expert-group-runtime.js 的 goals.get 读取）。它不参与任何等待、
    // 收口或状态变更，缺失时投影为空，绝不影响派发与等待语义。
    const goals = ctx.get("goals");

    const state = createAssemblyState({
      config,
      goals,
      logger: ctx.logger,
      services: { tools, subagents, systemPrompt, llm, agents, settings, webServer },
      // 宿主时钟探针（票据 03）：严格 Context 对未声明属性抛错，因此必须 try/catch。
      // 只有宿主**提供了可调用的 now** 才使用它；否则退回系统时间函数。这里不缓存时间值，
      // 也不在装配期读时钟——判定只在派发时发生一次。
      clock: readHostClock(ctx),
    });
    state.ValidationError = ValidationError;
    // 请求取消错误构造器：上传归一与手动派发的 abort 能力面共用同一实现。
    state.createAbortError = createAbortError;
    const caps = createAssemblyCapabilities(ctx, tools);
    const register = (entries) => applyAssemblyRegistrations(ctx, tools, entries);

    // 装配顺序 = 迁移前 apply 的语句顺序。每段装配完成后立即登记该段的注册描述，
    // 因此「域构造」与「注册点」的交替次序也与迁移前一致。
    // ── 1. 装配前言 + 通知 + root 等待 + handoff/finalize（票据 15）──────────
    register(assemblePrelude(state, caps));
    register(assembleRootWait(state, caps));
    register(assembleHandoffAndFinalize(state));
    // ── 2. root/child scoped guard 安装（F6）与恢复记录域（票据 17）──────────
    register(assembleGuards(state, caps));
    register(assembleRecovery(state));
    // ── 3. settings 读源 + storage 域（票据 16）────────────────────────────
    register(assembleSettingsStorage(state, caps));
    // role 工具同步命令必须在 installSettingsSection 之前就绪（onChange 直接取用）。
    assembleRoleToolSync(state);
    installSettingsSection(state.host.settings, ctx, SETTINGS_NAMESPACE, Config, defaultSettingsEntry(), {
      setSource(next) {
        // 建立归一读源：activeRoles()/defaults 归一都基于最新快照（owner 在 settings/storage 域）。
        state.settingsStorage.bindSettingsSource(next);
      },
      onChange() {
        // 三个观察点收敛到同一入口（host/settings-source）：工具面已装配时保持
        // 角色工具/fanout/提示词与设置一致（幂等）。
        state.syncRoleTools();
      },
    });
    register(assembleStorageDomainBinding(state, caps));
    // ── 4. 用量归属 + 模型路由 + 推理深度/agent 事件接线（票据 16/17/19）──────
    register(assembleUsage(state));
    assembleModelRoute(state);
    register(assembleAgentHandlers(state));
    // ── 5. 自动恢复执行（票据 17）──────────────────────────────────────────
    register(assembleAutoRecovery(state));
    // ── 6. 专家委派工具域 + 工具面挂载（票据 18）──────────────────────────
    register(assembleExpertTools(state));
    assembleExpertGroupRuntime(state);
    register(assembleSnapshotInvalidation(state));
    assembleRoleTools(state);
    register(assembleToolSurface(state, caps));
    // ── 7. RPC 传输 / 图片路由 / 模板 / 手动派发（票据 19/20）────────────────
    register(assembleRpcSurface(state));
    register(assembleRpcActions(state, caps));
    register(assembleDiagnosticsAndRoute(state, caps));
  },
};
