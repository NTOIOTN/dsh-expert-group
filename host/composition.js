/**
 * Host 模块装配层（expand 阶段）。
 *
 * 只做依赖注入与生命周期注册：每个关注点模块由自己的工厂创建，装配层把它们
 * 冻结成一份可观察的装配记录，并按 Cordis 逆序语义提供幂等的 dispose。
 * 旧组合根（index.js apply）继续作为唯一外部 seam；未迁移逻辑留在 index.js，
 * 由任务 06 收缩。
 *
 * 生命周期契约（任务 06）：
 * - 已构造的模块实例可以直接注入同名槽位（判定：同时提供 describe 与 dispose），
 *   宿主自持的生命周期参与者（例如 recovery）因此不必被装配层二次构造。
 * - 槽位按依赖顺序构造；任何一步失败都按**逆序回滚已创建模块**，并保留首个构造错误
 *   （释放异常只记录在 error.rollback 里，绝不覆盖首错）。
 * - dispose 逆序串行释放：同步 dispose 在同一轮同步完成，异步 dispose 会被等待，
 *   且下一个模块必须等它 settle 之后才开始释放；单个模块的释放异常按模块名记录，
 *   不中断其它模块。重复调用返回同一个 promise，每个模块只释放一次。
 *
 * @module dsh-expert-group/host/composition
 */
import { createHandoffRegistryModule } from "./handoff.js";
import { createLineageModule } from "./lineage.js";
import { createNotificationModule } from "./notifications.js";
import { createRpcTransportModule } from "./rpc-transport.js";
import { createSettingsSourceModule } from "./settings-source.js";
import { createStorageBindingModule } from "./storage-binding.js";

/** 模块实例判定：描述面 + 释放面缺一不可，否则仍按配置对象交给对应工厂。 */
function isModule(value) {
  return value !== null && typeof value === "object"
    && typeof value.describe === "function"
    && typeof value.dispose === "function";
}

function isThenable(value) {
  return value !== null && typeof value === "object" && typeof value.then === "function";
}

/**
 * 构造中途失败时的逆序回滚。
 *
 * 只释放**已经创建成功**的模块；返回首个构造错误本身，调用方原样抛出。释放过程中
 * 的异常只记录在 error.rollback.errors 里，绝不覆盖构造首错。
 *
 * 构造过程是同步的，因此异步 dispose 无法在这里 await：它的结果登记在
 * error.rollback.settled 上，调用方可以等待它收敛而不产生未处理的 rejection。
 */
function rollbackCreatedModules(modules, error) {
  const released = [];
  const errors = [];
  const pending = [];
  for (let index = modules.length - 1; index >= 0; index -= 1) {
    const [name, module] = modules[index];
    released.push(name);
    try {
      const result = module.dispose();
      if (isThenable(result)) {
        pending.push(Promise.resolve(result).catch((disposeError) => { errors.push({ name, error: disposeError }); }));
      }
    } catch (disposeError) {
      errors.push({ name, error: disposeError });
    }
  }
  const rollback = {
    released: Object.freeze(released),
    // 迟到（异步）释放异常也写进同一个数组：记录对象被冻结，但数组内容仍可追加。
    errors,
    settled: Promise.all(pending).then(() => Object.freeze({ errors: Object.freeze([...errors]) })),
  };
  try {
    Object.defineProperty(error, "rollback", { value: Object.freeze(rollback), enumerable: false, configurable: true });
  } catch {
    // 冻结或不可扩展的构造错误：回滚已经完成，只是没有可观察的附加记录。
  }
  return error;
}

/**
 * @param {object} options - 每个关注点的工厂参数（见各模块）。
 *   已构造模块实例可直接注入同名槽位（rpc/settings/storage/lineage/notifications/handoff）；
 *   recovery 是可选槽位，注入时必须已经是模块实例（入口持有它的 limit/taskBindingLimit）。
 * @returns {object} 冻结的装配记录：模块 + describe()/dispose()。
 */
export function createHostComposition(options = {}) {
  if (options === null || typeof options !== "object") throw new TypeError("createHostComposition 需要配置对象");
  // 注入校验在任何模块创建之前完成：配置错误不得留下半初始化的模块。
  if (options.recovery !== undefined && !isModule(options.recovery)) {
    throw new TypeError("createHostComposition 的 recovery 必须是模块实例（带 describe/dispose）");
  }
  const slots = [
    ["rpc", () => createRpcTransportModule(options.rpc)],
    ["settings", () => createSettingsSourceModule(options.settings)],
    ["storage", () => createStorageBindingModule(options.storage)],
    ["lineage", () => createLineageModule(options.lineage)],
    // recovery 依赖 lineage 的 root 查询：晚于 lineage 构造，因此早于 lineage 释放；
    // 同时早于 notifications/handoff 释放，保证关闭之后不再有重建意图被消费。
    ["recovery", () => options.recovery],
    ["notifications", () => createNotificationModule(options.notifications)],
    ["handoff", () => createHandoffRegistryModule(options.handoff)],
  ];
  const modules = [];
  for (const [name, create] of slots) {
    // 未注入的 recovery 槽位整块跳过；其余槽位始终存在。
    if (name === "recovery" && options.recovery === undefined) continue;
    try {
      const provided = options[name];
      const module = isModule(provided) ? provided : create();
      if (!isModule(module)) throw new TypeError(name + " 模块必须提供 describe/dispose");
      modules.push([name, module]);
    } catch (error) {
      throw rollbackCreatedModules(modules, error);
    }
  }
  const byName = new Map(modules);
  const recovery = byName.get("recovery");
  let disposePromise;

  const composition = {
    rpc: byName.get("rpc"),
    settings: byName.get("settings"),
    storage: byName.get("storage"),
    lineage: byName.get("lineage"),
    notifications: byName.get("notifications"),
    handoff: byName.get("handoff"),
    // 未注入 recovery 时保持既有六模块键集：装配记录与冻结键都不得凭空多出槽位。
    ...(recovery === undefined ? {} : { recovery }),
    /** 装配记录：模块名 + 各自 describe() 快照。 */
    describe() {
      return Object.freeze({
        modules: Object.freeze(modules.map(([name]) => name)),
        records: Object.freeze(Object.fromEntries(modules.map(([name, module]) => [name, module.describe?.() ?? {}]))),
      });
    },
    module: (name) => byName.get(name),
    /** 逆序 dispose；重复调用返回同一个 promise，且只执行一次。 */
    dispose() {
      if (disposePromise !== undefined) return disposePromise;
      disposePromise = (async () => {
        const errors = [];
        for (let index = modules.length - 1; index >= 0; index -= 1) {
          const [name, module] = modules[index];
          try {
            const result = module.dispose();
            // 同步 dispose 不让出微任务：默认六个模块的卸载仍在同一轮同步完成。
            if (isThenable(result)) await result;
          } catch (error) {
            errors.push({ name, error });
          }
        }
        return Object.freeze({ errors: Object.freeze(errors) });
      })();
      return disposePromise;
    },
  };
  return Object.freeze(composition);
}
