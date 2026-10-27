/**
 * Host 关注点模块：storage binding / 初始化代际 / 快照缓存。
 *
 * 接管原先散落在 apply 里的 binding 生成器实例、active binding 投影与
 * domain/fan-out 快照缓存；写入串行链与 storage domain 的 open/close 时序仍留在
 * index.js（源码契约测试锁定），任务 06 再收缩。
 *
 * @module dsh-expert-group/host/storage-binding
 */
import { createBindingController } from "../storage.js";

/**
 * @param {object} [options]
 * @param {object} [options.bindingController] - 注入既有控制器（测试用）。
 */
export function createStorageBindingModule({ bindingController = createBindingController() } = {}) {
  if (bindingController === null || typeof bindingController !== "object"
    || typeof bindingController.begin !== "function" || typeof bindingController.install !== "function") {
    throw new TypeError("createStorageBindingModule 需要 bindingController");
  }
  let domainSnapshot = {};
  let fanoutSnapshot;

  return Object.freeze({
    /**
     * 开始新 generation：旧 binding 立即失效，且清空快照缓存，
     * 避免新 generation 复用上一代的 domain/fan-out 数据。
     */
    begin() {
      const binding = bindingController.begin();
      domainSnapshot = {};
      fanoutSnapshot = undefined;
      return binding;
    },
    /** 安装 ready binding；迟到/被替换的 binding 返回 false。 */
    install: (binding, value) => bindingController.install(binding, value),
    /**
     * 使 binding 失效：脱离 current、清空快照缓存并取消未完成的初始化。
     * 旧 generation 因此无法再回写新 binding。
     *
     * 快照缓存的重置是无条件的：domainSnapshot 恒为普通对象（只能被 begin()/setDomainSnapshot()
     * 赋成对象或 {}），因此这里不存在「未初始化就跳过」的情形，无需再判断它是否为 undefined。
     */
    invalidate(binding) {
      if (binding === undefined || binding === null) return false;
      bindingController.invalidate(binding);
      domainSnapshot = {};
      try {
        binding.cancelInitialization?.();
      } catch {
        // 取消回调是宿主注入的可选能力；异常不能影响失效本身。
      }
      return true;
    },
    isCurrent: (binding) => bindingController.isCurrent(binding),
    current: () => bindingController.current(),
    /** 只返回 ready binding；opening/fallback 都视为不可用。 */
    active() {
      const binding = bindingController.current();
      return binding?.status === "ready" ? binding : void 0;
    },
    setDomainSnapshot(value) {
      domainSnapshot = value !== null && typeof value === "object" ? value : {};
      return domainSnapshot;
    },
    setFanoutSnapshot(value) {
      fanoutSnapshot = value;
      return fanoutSnapshot;
    },
    domainSnapshot: () => domainSnapshot,
    fanoutSnapshot: () => fanoutSnapshot,
    /** readStorageSnapshot 使用的合并投影（settings 字段由调用方补）。 */
    snapshots: () => ({ ...domainSnapshot }),
    describe() {
      const binding = bindingController.current();
      return {
        hasBinding: binding !== undefined,
        status: binding?.status,
        generation: binding?.generation,
        // 表清单是诊断面：session_override_meta（票据 21 的覆盖代次表）同样是
        // 运行期硬依赖，缺失时写路径会显式拒绝，诊断必须如实列出。
        tableNames: binding === undefined
          ? []
          // 票据 28：模板表与运行数据同域、独立表。诊断只投影“有哪些表”，
          // 不暴露表内容；旧 binding 缺该表时如实少一项（= 写路径会显式拒绝）。
          : ["session_overrides", "session_override_meta", "child_models", "fanout_tasks", "fanout_templates", "orchestrator_state"]
            .filter((name) => binding[tableKeyOf(name)] !== undefined),
      };
    },
    dispose() {
      domainSnapshot = {};
      fanoutSnapshot = undefined;
    },
  });
}

function tableKeyOf(tableName) {
  if (tableName === "session_overrides") return "sessionTable";
  if (tableName === "session_override_meta") return "sessionOverrideMetaTable";
  if (tableName === "child_models") return "childTable";
  if (tableName === "fanout_templates") return "fanoutTemplateTable";
  // 主代理功能启用切点（B3）：与运行数据同域的独立表，诊断面同样如实列出。
  if (tableName === "orchestrator_state") return "orchestratorStateTable";
  return "fanoutTable";
}
