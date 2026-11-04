/**
 * Host 关注点模块：settings 源绑定（DSH 0.1.7-alpha.2 契约）。
 *
 * 接线方式：
 * - 引导期通过 `ctx.settings.configure({ auto: false }, ctx.fiber)` 关闭宿主的自动
 *   生成配置页（DEG 有自己的设置页）。owner 必须是**插件自己的 fiber**：宿主按
 *   fiber 记录页面策略，省略 owner 会把策略记到 settings 服务自身并立刻因重复注册
 *   抛错。返回的 disposer 挂到插件 effect 上，随生命周期释放。
 * - 本条目当前值从 **describe()** 读取（找 ns === 本条目 id 的项取 value），不再使用
 *   已删除的 `settings.register` / `scope.get()` / `scope.watch()`。
 * - 运行期变更观察有三个观察点，全部收敛到同一个 `observeConfiguration()` 入口：
 *   1. `loader/volatile-update`（**主**）：loader 把 volatile-only 变更提交进运行中的
 *      fiber 之后派发；这是设置页保存与外部编辑生效最及时的信号。
 *   2. `app-boot/config-reload`（**兜底**）：profile patch 归并完成、生命周期 settle
 *      后无条件派发，覆盖只走重载路径的写入（程序化更新、HMR 关闭时的外部编辑）。
 *   3. `settings/document-updated(ns, revision)`：本条目文档自身变化，保留兼容。
 *
 * 观察点注册位置是**契约要求**，不是风格选择：
 * `loader/volatile-update` 由 loader 以 `fiber.ctx.emit(self, event, paths)` 派发，
 * 其中 `self[Context.filter] = (owner) => owner.fiber === <条目 fiber>`。只有注册在
 * 插件**顶层 ctx**（其 `hook.ctx.fiber` 正是条目 fiber）上的监听器能收到；
 * `ctx.inject` 回调拿到的子 ctx 拥有**独立 fiber**，注册在那里永远收不到该事件。
 * 因此三个观察点都注册在注入回调**之外**的顶层 ctx 上：既满足 fiber 过滤，也保证
 * settings 服务替换时不会累积重复监听器。
 *
 * 严格边界：
 * - 宿主新契约**没有** validate 钩子（`settings.register` 已删除），因此本模块不
 *   接收、不安装任何 validate；语义校验由 DEG 自有提交端点承担
 *   （见 index.js 的 commitSettingsCandidate）。
 * - describe() 返回的 value 是 defaults resolved 后的结果，与旧 `scope.get()` 的
 *   “已注册 schema 解析值”语义一致：读取归一仍按缺失字段回退默认值处理。
 *
 * @module dsh-expert-group/host/settings-source
 */

/**
 * 运行期配置观察事件（按优先级排列）。
 *
 * - `loader/volatile-update`：条目本地事件，**带 fiber 过滤** → 必须注册在插件顶层 ctx。
 * - `app-boot/config-reload`：无过滤的全局事件，作为兜底。
 */
const CONFIG_OBSERVATION_EVENTS = Object.freeze([
  "loader/volatile-update",
  "app-boot/config-reload",
]);

/**
 * 宿主子代理配置行的 profile 条目 id 与名额字段名。
 *
 * 宿主把「同时存活的 continuable 子代理数」声明成语义为 volatile 的
 * `maxActiveSubagents`（默认 8）。DEG 无法直接读宿主的 Config，`describe()` 是唯一
 * 公开读面；字段名与条目 id 都是宿主契约，改动必须同步宿主版本核对。
 */
export const HOST_SUBAGENT_NAMESPACE = "subagent";
export const HOST_SUBAGENT_CAPACITY_FIELD = "maxActiveSubagents";

/*
 * 本模块**只读**宿主名额，不提供任何运行期写入口：默认值 64 由 bundle 补丁
 * （cordis.patch.yml 里的 `- id: subagent` 覆盖项）在安装时声明，profile patch /
 * home patch / CLI overlay 仍按「后者覆盖前者」的常规层序改写它。读取面服务于两件事：
 * ① 派发 resolver 的封顶（effectiveRoleConcurrencyLimitWithHostCap）；② meta 投影。
 */

/**
 * 读取 describe() 的全量描述符。
 *
 * 读取失败（服务不存在、describe 抛错、返回值不是数组）统一折算成 undefined：
 * 这只代表「当前不可读」，调用方必须回落到各自的安全默认，绝不能因此让插件加载失败。
 */
function readSettingsDescriptors(service) {
  if (service === null || typeof service?.describe !== "function") return undefined;
  try {
    const descriptors = service.describe();
    return Array.isArray(descriptors) ? descriptors : undefined;
  } catch {
    return undefined;
  }
}

/** 从全量描述符里取指定条目；value 不是对象时同样视为不可用（与历史读面一致）。 */
function descriptorOf(descriptors, namespace) {
  if (descriptors === undefined) return undefined;
  const descriptor = descriptors.find((candidate) => candidate?.ns === namespace);
  if (descriptor === undefined) return undefined;
  if (descriptor.value === null || typeof descriptor.value !== "object") return undefined;
  return descriptor;
}

/**
 * 从 describe() 结果里读取本条目描述符。
 *
 * 宿主只会把「声明了 volatile 字段的条目」放进 describe()；条目 id 被用户重命名
 * 时这里读不到，调用方必须回落到插件默认 entry（不崩溃、不伪造值）。describe()
 * 在配置编辑器尚未就绪等边界上可能抛错：读取失败只代表“当前不可读”。
 *
 * @param {object} service - 注入的 ctx.settings。
 * @param {string} namespace - profile 条目 id（本插件为 dsh-expert-group）。
 * @returns {object|undefined} 该条目的描述符；不可读时 undefined。
 */
export function findSettingsDescriptor(service, namespace) {
  return descriptorOf(readSettingsDescriptors(service), namespace);
}

/**
 * 从 describe() 的全量描述符里取宿主子代理名额（纯函数，便于单测）。
 *
 * 语义边界：
 * - 只认 `ns === "subagent"` 那一行的 `value.maxActiveSubagents`；
 * - 值必须是正整数，缺失/0/负数/非整数/NaN 一律 undefined（不是「名额为 0」）；
 * - 宿主把该行从 profile 移除时这里自然读不到，调用方据此视为「不封顶」。
 *
 * @param {Array<object>|undefined} descriptors - `ctx.settings.describe()` 的返回值。
 * @returns {number|undefined} 宿主名额；不可读/非法时 undefined。
 */
export function hostSubagentCapacityOf(descriptors) {
  const value = descriptorOf(descriptors, HOST_SUBAGENT_NAMESPACE)?.value;
  if (value === undefined) return undefined;
  const capacity = value[HOST_SUBAGENT_CAPACITY_FIELD];
  return Number.isSafeInteger(capacity) && capacity > 0 ? capacity : undefined;
}

/**
 * 从 settings 服务读一次宿主子代理名额。
 *
 * **只允许在刷新时机调用**（安装期、三个配置观察点、subagent 行自身的文档事件）：
 * 派发与 meta 投影热路径一律读 {@link createSettingsSourceModule} 缓存的同一份值，
 * 绝不在每次派发时再跑一遍 describe()（真实宿主会线性遍历全部活动条目）。
 *
 * @param {object} service - 注入的 ctx.settings。
 * @returns {number|undefined} 宿主名额；读不到时 undefined（调用方不封顶）。
 */
export function readHostSubagentCapacity(service) {
  return hostSubagentCapacityOf(readSettingsDescriptors(service));
}

/**
 * @param {object} options
 * @param {number[]} [options.unloadingStates] - 覆盖卸载态数值（测试用）。
 */
export function createSettingsSourceModule({ unloadingStates = [4, 5] } = {}) {
  const states = Array.isArray(unloadingStates) ? unloadingStates.slice() : [4, 5];
  /**
   * 当前绑定与观察状态；`dispose()` 置空。
   *
   * 单一对象同时承载「读源绑定」与「观察计数」，避免出现半释放的不一致：只要它为
   * null，所有迟到事件与读取都变成 no-op。
   */
  let state = null;

  function isUnloading(ctx) {
    try {
      const stateValue = ctx?.fiber?.state;
      return states.includes(stateValue);
    } catch {
      return false;
    }
  }

  /**
   * 运行期统一观察入口：**先重读**宿主 describe()，再按 revision **幂等**通知。
   *
   * - **重读总是发生**：读取面在事件到达后立刻看到宿主权威值，不存在旧快照缓存，
   *   因此「设置保存后运行期立即跟随」不依赖任何记忆化假设。
   * - **通知按 revision 去重**：一次用户保存通常先后触发 `loader/volatile-update`、
   *   `app-boot/config-reload`，有时还叠加 `settings/document-updated`，它们描述的是
   *   同一次变更；去重后 hooks.onChange() 只触发一次，不放大成刷新风暴。
   * - revision 不可用时**不去重**：宁可多通知一次，也不能因为宿主/替身不提供版本号
   *   而漏掉真实变更。
   * - 未安装、已释放、卸载中、服务未就绪：不重读也不通知。
   *
   * @returns {boolean} 本次是否真的通知了变更。
   */
  function observeConfiguration() {
    const active = state;
    if (active === null || active.mode !== "inject") return false;
    if (isUnloading(active.ctx)) return false;
    if (active.refresh === null) return false;
    // 重入保护：真实宿主的 describe() 自身会在 revision 变化时派发
    // `settings/document-updated`，因此「本条目文档事件 → 重读 describe()」可能递归回到
    // 本函数。重入的那一层直接返回，让最外层完成读取与通知，避免递归放大。
    if (active.observing) return false;
    active.observing = true;
    let descriptor;
    try {
      descriptor = active.refresh();
    } finally {
      active.observing = false;
    }
    const revision = descriptor === undefined ? undefined : descriptor.revision;
    if (revision !== undefined && active.known && revision === active.revision) {
      active.suppressed += 1;
      return false;
    }
    active.known = revision !== undefined;
    active.revision = revision;
    active.notifications += 1;
    active.hooks.onChange();
    return true;
  }

  return Object.freeze({
    /**
     * 按 0.1.7-alpha.2 契约接线：只通过注入的 ctx.settings 交互。
     * @param {object} ctx - 插件 ctx（**顶层**；观察点必须注册在它上面）。
     * @param {object} options
     * @param {string} options.namespace - profile 条目 id。
     * @param {object} [options.schema] - 旧签名的 schema 参数；宿主现在自行从条目
     *   Config 投影，这里只保留参数形状，不再参与注册。
     * @param {object} options.entry - describe() 不可读时的默认值（插件默认配置）。
     * @param {{setSource:Function, onChange:Function}} options.hooks
     */
    install(ctx, { namespace, schema: _schema, entry, hooks } = {}) {
      if (ctx === null || typeof ctx !== "object") throw new TypeError("settings source install 需要 ctx");
      if (typeof namespace !== "string" || namespace.length === 0) throw new TypeError("settings source install 需要 namespace");
      if (typeof hooks?.setSource !== "function" || typeof hooks?.onChange !== "function") {
        throw new TypeError("settings source install 需要 setSource/onChange hooks");
      }
      if (typeof ctx.inject !== "function") {
        // 旧/测试 Host 没有 inject：保持 entry 作为 source，不抛错。
        hooks.setSource(() => entry);
        hooks.onChange();
        // entry 模式没有注入 settings：宿主名额同样不可读（不封顶），但在共享模块状态里
        // 显式保留该字段，读取面因此不需要区分「没有字段」与「读不到」。
        state = { namespace, mode: "entry", notifications: 0, suppressed: 0, hostConcurrencyCap: undefined };
        return { namespace, mode: "entry" };
      }

      // 观察状态：服务未就绪时 refresh 为 null，事件一律 no-op（读取面仍是 entry）。
      state = {
        namespace,
        mode: "inject",
        ctx,
        hooks,
        refresh: null,
        // 只刷新宿主名额（不动 DEG 条目读源、不通知 onChange）：subagent 行的变更与
        // DEG 自己的配置无关，不该把设置页整轮刷新当成副作用。
        refreshHostCapacity: null,
        observing: false,
        known: false,
        revision: undefined,
        // 宿主子代理名额缓存：undefined = 当前不可读（调用方据此**不封顶**）。
        hostConcurrencyCap: undefined,
        notifications: 0,
        suppressed: 0,
      };

      // 顶层观察点：只注册一次（不在注入回调里，避免服务替换时累积重复监听器）。
      if (typeof ctx.on === "function") {
        for (const event of CONFIG_OBSERVATION_EVENTS) {
          ctx.on(event, () => { observeConfiguration(); });
        }
        // 本条目文档自身变化：与 loader 事件共用同一幂等入口。DEG 自己的提交也会走到
        // 这里，因此读取面在提交完成后立即收敛到宿主权威值（不再依赖 registration token）。
        ctx.on("settings/document-updated", (updatedNamespace) => {
          if (updatedNamespace === namespace) {
            observeConfiguration();
            return;
          }
          // 宿主子代理行（subagent）的 maxActiveSubagents 变化只刷新名额缓存：DEG 的
          // 配置一个字都没改，不应该触发 onChange（那会让设置页与角色工具整轮重挂）。
          if (updatedNamespace === HOST_SUBAGENT_NAMESPACE) {
            const active = state;
            if (active !== null && typeof active.refreshHostCapacity === "function") active.refreshHostCapacity();
          }
        });
      }

      ctx.inject(["settings"], (settingsCtx) => {
        const service = settingsCtx.settings;
        const active = state;
        if (active === null) return;
        // 最新一次 describe() 读到的本条目值；undefined 表示当前不可读，读取面回落到 entry。
        let current;

        /**
         * 重新读取宿主 describe()：**一次**调用同时刷新本条目值与宿主子代理名额。
         *
         * 为什么合并成一次：describe() 在真实宿主里会线性遍历全部活动条目并按 revision
         * 派发文档事件，调用两次没有收益；更重要的是「名额与条目值永远来自同一份
         * 权威快照」，不会出现读到旧名额配新条目的错位。
         *
         * 条目消失时把 current 复位成 undefined（回落 entry）；名额读不到时缓存
         * undefined（调用方不封顶），绝不沿用上一次的旧名额。
         */
        const refresh = () => {
          const descriptors = readSettingsDescriptors(service);
          const descriptor = descriptorOf(descriptors, namespace);
          current = descriptor === undefined ? undefined : descriptor.value;
          active.hostConcurrencyCap = hostSubagentCapacityOf(descriptors);
          return descriptor;
        };
        /**
         * 只刷新宿主名额：供 subagent 行（maxActiveSubagents）的文档事件使用。
         *
         * 该行由 bundle 补丁声明默认值、也可被用户的 profile / home patch / CLI overlay
         * 改写，因此运行期仍必须跟随外部编辑；但它在 DEG 的配置面之外，刷新时不通知
         * onChange。
         */
        const refreshHostCapacity = () => {
          active.hostConcurrencyCap = hostSubagentCapacityOf(readSettingsDescriptors(service));
        };
        active.refresh = refresh;
        active.refreshHostCapacity = refreshHostCapacity;
        // 服务世代切换：describe() 的 revision 从新实例重新计数，旧去重基线必须作废，
        // 否则新世代的首个变更会被误判成「同一份文档」而漏通知。
        active.known = false;
        active.revision = undefined;

        const bindEffect = typeof settingsCtx?.effect === "function" ? settingsCtx.effect.bind(settingsCtx) : ctx.effect.bind(ctx);

        // 关闭宿主自动生成配置页（DEG 有自己的设置页）。owner 必须是插件自己的 fiber，
        // 否则宿主会把策略记到 settings 服务自身并在重复注册时抛错。
        bindEffect(() => {
          if (typeof service?.configure !== "function") return () => {};
          return service.configure({ auto: false }, ctx.fiber);
        }, "dsh-expert-group: settings presentation policy");

        // 首次读取并建立去重基线：安装期的 hooks.onChange() 自己会通知，不占用观察通道。
        const descriptor = refresh();
        active.known = descriptor !== undefined && Number.isSafeInteger(descriptor.revision);
        active.revision = active.known ? descriptor.revision : undefined;

        hooks.setSource(() => (current === undefined ? entry : current));
        bindEffect(() => () => {
          if (isUnloading(ctx)) return;
          hooks.setSource(() => entry);
          hooks.onChange();
        }, "dsh-expert-group: settings source binding");
        hooks.onChange();
      });
      return { namespace, mode: "inject" };
    },
    /**
     * 只读装配记录（含运行期观察计数）。
     *
     * `observations` 供回归用例断言幂等与释放语义：
     * - notifications：真正触发 hooks.onChange() 的次数；
     * - suppressed：被 revision 去重抑制的事件次数。
     */
    describe: () => (state === null
      ? { installed: false }
      : {
        installed: true,
        namespace: state.namespace,
        mode: state.mode,
        observations: { notifications: state.notifications, suppressed: state.suppressed },
        // 宿主名额缓存快照：null = 当前不可读（派发面因此不封顶）。
        hostConcurrencyCap: state.hostConcurrencyCap === undefined ? null : state.hostConcurrencyCap,
      }),
    /**
     * 宿主子代理并发名额（缓存值，**同步**读取）。
     *
     * 派发 resolver 与 meta 投影都在热路径上调用它：这里只读模块状态，绝不再调用
     * describe()。未安装/已释放/读不到时返回 undefined，调用方据此不封顶。
     *
     * @returns {number|undefined}
     */
    hostConcurrencyCap: () => (state === null ? undefined : state.hostConcurrencyCap),
    dispose() {
      // 释放后观察通道失效：所有迟到事件（loader 已提交 volatile 值、事件仍在队列里）
      // 都变成 no-op，插件卸载后不得再刷新任何读源。
      state = null;
    },
  });
}
