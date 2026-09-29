/**
 * Host 关注点模块：pending handoff admission 注册表。
 *
 * 接管原先 index.js 里的 pendingHandoffAdmissions 数组与其增删查操作；
 * admission 的编排（cohort/token/暂停/释放）仍留在 index.js，任务 06 再收缩。
 *
 * @module dsh-expert-group/host/handoff
 */
export function createHandoffRegistryModule() {
  const entries = [];
  let disposed = false;

  return Object.freeze({
    /**
     * 登记一个 admission entry（调用方负责构造 entry 字段）。
     *
     * 已销毁后静默丢弃并返回 undefined，不再抛错：注册路径可能落在迟到的 promise
     * 回调里（admission 的 await 期间插件被卸载，微任务/后续 await 恢复后才回到
     * 这里），此时抛出的异常没有任何调用方接收，只会变成 unhandled rejection。
     * 与 host/recovery.js 的 queueRebuild 保持同一迟到语义：先判销毁、再做形状校验，
     * 因此销毁后的畸形 entry 也一并丢弃，而不是半途抛错。
     *
     * 参数形状校验仍然保留：未销毁时的调用方缺陷（null/非对象）照旧抛 TypeError，
     * 只有"已销毁"这一竞态态才降级为丢弃。
     *
     * @param {unknown} entry - 待登记的 admission entry。
     * @returns {object|undefined} 登记成功时返回原 entry；已销毁时返回 undefined（丢弃指示）。
     */
    add(entry) {
      if (disposed) return void 0;
      if (entry === null || typeof entry !== "object") throw new TypeError("handoff admission 必须是对象");
      entries.push(entry);
      return entry;
    },
    contains: (entry) => entry !== undefined && entries.includes(entry),
    remove(entry) {
      if (entry === undefined) return false;
      const index = entries.indexOf(entry);
      if (index === -1) return false;
      entries.splice(index, 1);
      return true;
    },
    /** 只读快照；调用方不得依赖其身份。 */
    entries: () => [...entries],
    find(predicate) {
      if (typeof predicate !== "function") throw new TypeError("find 需要谓词");
      return entries.find(predicate);
    },
    filter(predicate) {
      if (typeof predicate !== "function") throw new TypeError("filter 需要谓词");
      return entries.filter(predicate);
    },
    some(predicate) {
      if (typeof predicate !== "function") throw new TypeError("some 需要谓词");
      return entries.some(predicate);
    },
    /** 按父 Agent 清理；返回被移除的 entry 数。 */
    removeForParent(parent) {
      let removed = 0;
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.parent === parent) {
          entries.splice(index, 1);
          removed += 1;
        }
      }
      return removed;
    },
    clear() {
      const removed = entries.length;
      entries.length = 0;
      return removed;
    },
    get size() { return entries.length; },
    describe: () => ({ pending: entries.length, disposed }),
    dispose() {
      disposed = true;
      entries.length = 0;
    },
  });
}
