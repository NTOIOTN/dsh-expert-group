/**
 * 入口 fan-out 模板持久化域（R4e · 票据 19）。
 *
 * 这一域只负责模板文档的**读-改-写串行链与持久化**：
 * - `runFanoutTemplateMutation(task)`：独立 Promise 链串行化"读改写"，避免两个并发
 *   保存都基于同一份旧文档、后者静默覆盖前者（丢更新）；链上一步失败不阻塞下一步。
 * - `readFanoutTemplateDocument()`：只读、不缓存；storage 未 ready 时明确返回
 *   `{ok:false}`，绝不返回空库冒充成功。
 * - `persistFanoutTemplateDocument(document)`：走组合根同一条 enqueueWrite 串行链
 *   （与 fan-out 快照/child 写入共享 storage generation 门控，卸载时同样被 drain）；
 *   代次失配以 `PERSISTENCE_GENERATION_STALE` 结构化失败，并同步进程内只读投影缓存。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册：本域没有 ctx 注册点。
 *
 * ## 状态唯一 owner
 * `fanoutTemplateMutationChain`（Promise 链）由本模块独占；storage 绑定与写串行链
 * 仍分别由 host/storage.js、storageBinding 与 settings/storage 域拥有，这里只调用命令。
 *
 * @module dsh-expert-group/host/index-template-store
 */

/**
 * 创建模板持久化能力面。
 *
 * @param {object} deps - 窄能力面（2 组）。
 * @param {object} deps.storage - storage 绑定读面（单一关注点：当前 domain 绑定与它的只读
 *   投影缓存）：`activeBinding()`、`tableEntries(table)`、`isCurrent(binding)`、
 *   `domainSnapshot()`、`setDomainSnapshot(next)`。
 * @param {object} deps.persistence - 持久化原语（同一写链关注点）：`enqueueWrite(task)`、
 *   `persistDomainEntry({table,key,value,isCurrent})`、`normalizeTemplateDocumentEntries(entries)`、
 *   `storeKey`。
 * @returns {object} 模板读/写/串行链命令面。
 */
export function createFanoutTemplateStore({ storage, persistence }) {
  /**
   * 模板文档的「读-改-写」串行链。
   *
   * enqueueWrite 只串行化写；模板保存是 read-modify-write：两个并发保存若都在写前读到
   * 同一份旧文档，后写者会静默覆盖先写者（丢更新）。这里用独立 Promise 链把整段
   * 读改写串起来；链上一步失败不阻塞下一步（每次都从实际 storage 重读最新文档）。
   */
  let fanoutTemplateMutationChain = Promise.resolve();
  function runFanoutTemplateMutation(task) {
    const run = fanoutTemplateMutationChain.then(task, () => task());
    fanoutTemplateMutationChain = run.then(() => undefined, () => undefined);
    return run;
  }

  /** 读取模板文档（只读、不缓存）：storage 未 ready 时明确不可用，绝不返回空库冒充成功。 */
  function readFanoutTemplateDocument() {
    const binding = storage.activeBinding();
    if (binding?.fanoutTemplateAuthoritative !== true || binding.fanoutTemplateTable === void 0) {
      return { ok: false };
    }
    const entries = storage.tableEntries(binding.fanoutTemplateTable);
    if (entries === void 0) return { ok: false };
    return { ok: true, document: persistence.normalizeTemplateDocumentEntries(entries) };
  }

  /**
   * 持久化模板文档。
   *
   * 写入必须走组合根同一条 enqueueWrite 串行链：模板保存与 fan-out 快照/child 写入
   * 共享 storage generation 门控，卸载时同样会被 drain，绝不旁路。
   */
  function persistFanoutTemplateDocument(document) {
    return persistence.enqueueWrite(async () => {
      const binding = storage.activeBinding();
      if (binding?.fanoutTemplateAuthoritative !== true || binding.fanoutTemplateTable === void 0) {
        throw new Error("storage domain is not ready for fan-out template write");
      }
      const result = await persistence.persistDomainEntry({
        table: binding.fanoutTemplateTable,
        key: persistence.storeKey,
        value: document,
        isCurrent: () => storage.isCurrent(binding),
      });
      if (result.detached === true) {
        const error = new Error("storage domain binding was replaced during fan-out template write");
        error.code = "PERSISTENCE_GENERATION_STALE";
        error.category = "generation-stale";
        throw error;
      }
      // 同步只读投影缓存：source()/readDomainSnapshot 的下一次读取仍以表为准，
      // 这里只让同一进程内已建立的快照缓存立即看到新文档（与 fanout 快照同策略）。
      const current = storage.domainSnapshot();
      if (current !== null && typeof current === "object") {
        storage.setDomainSnapshot({ ...current, fanoutTemplates: document });
      }
      return true;
    });
  }


  return {
    runFanoutTemplateMutation,
    readFanoutTemplateDocument,
    persistFanoutTemplateDocument,
  };
}
