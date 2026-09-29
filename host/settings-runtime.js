/**
 * Host 关注点模块：settings 运行时状态（DSH 0.1.7-alpha.2 契约）。
 *
 * 持有三件事，全部服务于 **DEG 自有提交端点**（index.js 的 commitSettingsCandidate）：
 * - 模型目录 generation 计数与 settings document revision 去重（两参数事件规则）；
 * - 全局 settings 提交串行链（不等待可能永久 pending 的 domain 写入）；
 * - 写入前的最后一道代次复核：提交起始代次与当前代次不一致时拒绝写入。
 *
 * 保证边界（规格书已记录的降级）：
 * DEG **不承诺**在宿主通用 settings 写入路径上也保证模型目录有效。宿主没有 validate
 * 钩子，配置编辑是同步的，DEG 的锁无法协调由通用写入发起的 provider 配置改动；因此
 * 目录有效性只覆盖「DEG 自有提交端点在自己的写入前可检测到的变化」。
 *
 * 运行数据仍属于 storage domain；本模块只处理 settings 提交边界。
 *
 * @module dsh-expert-group/host/settings-runtime
 */

/** 写入前发现模型目录代次变化；RPC 层按 code 映射为可重试的保存失败。 */
export class SettingsDirectoryChangedError extends Error {
  constructor(message = "模型目录在保存期间发生变化，请刷新目录后重试") {
    super(message);
    this.name = "SettingsDirectoryChangedError";
    this.code = "MODEL_DIRECTORY_CHANGED";
  }
}

/**
 * 把一层提交 patch 转成宿主的路径寻址写入操作。
 *
 * 每个顶层字段一律用「整值 set」表达，**绝不**用宿主 `update` 的递归合并：
 * DEG 的 defaults / promptOverrides 是整份映射语义（空对象必须清空全部覆盖、
 * 提交的 defaults 必须整体替换而不是与旧值做键级并集）。宿主的
 * `mutate` + `{op:'set', path:[key]}` 在路径末段整体赋值，等价于旧契约里
 * `update` 在顶层键上的行为；同时宿主会校验该路径确实是 volatile 字段。
 *
 * patch 值必须是 JSON 可表达的数据；`undefined` 条目由调用方负责过滤，不会出现在这里。
 *
 * @param {Record<string, unknown>} patch - 已归一的提交 patch。
 * @returns {Array<{op:"set", path:string[], value:unknown}>} 有序写入操作。
 */
function settingsWriteOps(patch) {
  return Object.entries(patch ?? {}).map(([key, value]) => ({ op: "set", path: [key], value }));
}

/**
 * @param {object} options
 * @param {object} options.settings - 注入的 ctx.settings（需要 mutate）。
 * @param {string} options.namespace - 插件 settings namespace（= profile 条目 id）。
 */
export function createSettingsRuntimeModule({ settings, namespace } = {}) {
  if (settings === null || typeof settings !== "object" || typeof settings.mutate !== "function") {
    throw new TypeError("createSettingsRuntimeModule 需要 settings 服务（含 mutate）");
  }
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new TypeError("createSettingsRuntimeModule 需要 namespace");
  }
  let generation = 0;
  let writeChain = Promise.resolve();
  let pendingWrites = 0;
  let disposed = false;
  const documentRevisions = new Map();

  return Object.freeze({
    get generation() { return generation; },
    /** 目录/凭据变化推进代际，使进行中的提交过期。 */
    bumpGeneration() {
      generation += 1;
      return generation;
    },
    isCurrentGeneration(value) {
      return value === generation;
    },
    /**
     * settings document 事件：按 namespace + revision 去重。
     *
     * DSH 0.1.7-alpha.2 只发送 `(ns, revision)` 两个参数（注册世代事件与
     * registration token 都已从宿主删除），因此去重基线只有 revision：
     * - 缺失/非法 revision：清除基线并保守失效（无法安全去重）；
     * - 同 namespace 同 revision：忽略（同一份文档，没有新变化）；
     * - 更高 revision：记录新基线并推进代际；
     * - 更低 revision：只可能来自被替换的 settings 服务（新实例从 0 计数），
     *   因此清除基线并保守失效，绝不把“新世代的低 revision”当成旧文档忽略。
     * 去重基线在失效后会被清空，下一次同 revision 事件会重新失效——宁可多推进一次
     * 代际，也不能因为 revision 回绕而错过一次目录变化。
     * @returns {"ignored"|"invalidated"}
     */
    noteDocumentUpdate(namespaceName, revision) {
      if (typeof namespaceName !== "string" || namespaceName.length === 0 || namespaceName === namespace) return "ignored";
      if (!Number.isSafeInteger(revision) || revision < 0) {
        documentRevisions.delete(namespaceName);
        generation += 1;
        return "invalidated";
      }
      const previous = documentRevisions.get(namespaceName);
      if (previous !== undefined && revision === previous.revision) return "ignored";
      documentRevisions.set(namespaceName, { revision });
      generation += 1;
      return "invalidated";
    },
    /**
     * 全局 settings 提交串行链：失败不阻断后续提交，且不等待任何 domain 写入。
     *
     * 串行化是 revision 冲突语义的前提：并发提交按调用顺序排队，后一条看到前一条
     * 落盘后的 revision，因此携带陈旧 expectedRevision 的提交会被宿主明确拒绝，而
     * 不是互相覆盖。
     * @param {Function} operation
     */
    enqueueCommit(operation) {
      if (typeof operation !== "function") throw new TypeError("enqueueCommit 需要函数");
      if (disposed) {
        const error = new Error("settings runtime 已关闭");
        error.code = "SETTINGS_RUNTIME_DISPOSED";
        return Promise.reject(error);
      }
      pendingWrites += 1;
      const run = writeChain.catch(() => {}).then(operation);
      writeChain = run.catch(() => {});
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pendingWrites = Math.max(0, pendingWrites - 1);
      };
      run.then(settle, settle);
      return run;
    },
    /**
     * 在目录代次栅栏内写入 settings（DEG 自有提交端点的实际写入边界）。
     *
     * 调用方（commitSettingsCandidate）在串行链内先做语义校验与目录解析，再调本方法；
     * 本方法在真正调用宿主写入**之前**复核代次：`generationAtStart` 与当前代次不一致
     * 说明校验期间模型目录已变化，提交必须过期（抛 SettingsDirectoryChangedError）。
     *
     * 这是「提交前可检测的变化」这一降级保证的落点：它只覆盖 DEG 自己这条路径，
     * 且只覆盖到宿主写入调用之前；不承诺拦截宿主通用写入路径，也不承诺封住宿主
     * 异步落盘期间的竞态。
     *
     * 写入原语是 `mutate` + 顶层 `set`，而不是 `update`（理由见 settingsWriteOps）。
     */
    async updateAtGeneration(patch, expectedRevision, generationAtStart) {
      if (disposed) {
        const error = new Error("settings runtime 已关闭");
        error.code = "SETTINGS_RUNTIME_DISPOSED";
        throw error;
      }
      // 写入前的最后一道代次栅栏：校验完成到写入之间目录变化则不写。
      if (generationAtStart !== generation) throw new SettingsDirectoryChangedError();
      return settings.mutate(namespace, settingsWriteOps(patch), expectedRevision);
    },
    describe: () => ({
      generation,
      trackedNamespaces: documentRevisions.size,
      pendingWrites,
    }),
    /**
     * 幂等清理：监听器由 ctx 生命周期释放，本模块清空内部状态。
     * 已登记的提交继续沿原串行链 drain；不重置 writeChain 或 pendingWrites，
     * 由各自的幂等 settle 在迟到完成后准确收敛计数。
     */
    dispose() {
      if (disposed) return;
      disposed = true;
      generation = 0;
      documentRevisions.clear();
    },
  });
}
