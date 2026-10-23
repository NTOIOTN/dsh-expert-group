/**
 * 客户端侧栏 · Panel 快照缓存（R6 / sidebar-panel-cache）
 *
 * ## 这一层为什么是**工厂级**而不是实例级
 * 本模块持有侧栏唯一一份「最近一次成功的 normalized 快照」LRU 缓存。它的生命周期由
 * \`createExpertGroupPanel(deps)\` 这次调用决定：**跨 Panel 实例共享**，Panel 卸载后再次挂载
 * 仍然命中同一份缓存（既有契约见 test/expert-group-panel.test.mjs 的「卸载后重挂载首帧命中缓存」）。
 *
 * 三种生命周期各有唯一 owner（规格书 §状态所有权(3)）：
 * 1. **工厂级**（本文件）：\`snapshotCache\` / \`SNAPSHOT_CACHE_LIMIT\`，随 createExpertGroupPanel 存在；
 * 2. **实例级**（client-sidebar-panel-state-a/b）：mounted/request/context 等 ref、定时器、草稿、展开状态；
 * 3. **跨安装/跨 bundle 重新执行**（client-sidebar-auto-ledger）：共享 Auto 账本与归属记忆。
 *
 * 因此本模块**绝不**接受任何 Panel 实例状态（ref / setState / sessionId），只按 rootSessionId 记账；
 * 一旦把缓存移入实例级，卸载即丢缓存，「重挂载首帧直接显示任务树」的契约会立刻回归灰色 skeleton。
 *
 * ## 两条访问通道（渲染纯性的边界）
 * - \`peek\`：**纯读**，命中返回 \`{ snapshot, updatedAt }\`、未命中返回 null，绝不改动 Map 迭代顺序。
 *   渲染期（懒初始化 / 切换 root 的视图回退分支）只允许走这条通道；
 * - \`write\`：唯一会**改动**缓存的入口（delete+set 重排 LRU、超限淘汰），只允许在事件路径
 *   （RPC 成功回调）调用。旧实现每次渲染都做「命中即重排」，StrictMode 双渲染会把每次渲染
 *   变成两次额外 LRU 重排。
 *
 * 只缓存 normalized 成功快照（真正上屏的那一份）：失败、被取消或过期 root 的响应都不进缓存。
 * 条目带 \`updatedAt\`：重挂载时标题栏的「更新于」必须与首屏快照同源。
 *
 * 检查点：globalThis[Symbol.for("dsh-expert-group/client-sidebar-panel-cache")]
 * 装配：本文件不依赖任何兄弟 IIFE（纯 Map + 数字），也不修改任何外部模块的实现。
 */
(function installClientSidebarPanelCache(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-sidebar-panel-cache");

  /** LRU 上限：上限内每个 root 至多一份快照；超出后从最久未成功拉取的 root 开始淘汰。 */
  const SNAPSHOT_CACHE_LIMIT = 32;

  /**
   * 创建一份工厂级快照缓存。
   *
   * @param {{ limit?: number }} [options] limit 只用于测试注入更小的容量；生产恒为 32。
   * @returns {Readonly<{
   *   limit: number,
   *   peek: (rootSessionId: string) => { snapshot: any, updatedAt: number } | null,
   *   write: (rootSessionId: string, next: any, updatedAt?: number) => void,
   *   initialStateFor: (rootSessionId: string) => { rootSessionId: string, snapshot: any, updatedAt: number | null, loading: boolean, error: null },
   *   size: () => number,
   * }>}
   */
  function createPanelSnapshotCache(options) {
    const limit = Number.isSafeInteger(options?.limit) && options.limit > 0 ? options.limit : SNAPSHOT_CACHE_LIMIT;
    /** rootSessionId → { snapshot, updatedAt }；Map 的迭代顺序即 LRU 顺序（末尾最新）。 */
    const snapshotCache = new Map();

    /** 纯读缓存：命中返回 { snapshot, updatedAt }，未命中返回 null；绝不重排 LRU、绝不写入。 */
    const peek = (rootSessionId) => {
      if (rootSessionId === "" || snapshotCache.has(rootSessionId) !== true) return null;
      return snapshotCache.get(rootSessionId) ?? null;
    };

    /**
     * 写缓存并做有限 LRU 淘汰：同一 root 覆盖旧值并移到最新；超过上限时从最久未使用的 root 开始
     * 删除，保证长时间反复切换会话也不会无界增长。
     *
     * updatedAt 由调用方给出（成功响应的到达时间）；非有限值时退回当前时刻。
     */
    const write = (rootSessionId, next, updatedAt) => {
      if (rootSessionId === "" || next === null || next === undefined) return;
      snapshotCache.delete(rootSessionId);
      snapshotCache.set(rootSessionId, { snapshot: next, updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now() });
      while (snapshotCache.size > limit) {
        const oldest = snapshotCache.keys().next();
        if (oldest.done === true) break;
        snapshotCache.delete(oldest.value);
      }
    };

    /**
     * 某个 root 的初始展示状态：命中缓存就是「已有快照、已加载、有更新时间」，未命中仍是 skeleton。
     * 错误信息不缓存——上一次失败不该污染新实例的首屏（真正的失败会在本次刷新里重新得到）。
     * 只做纯读 peek：命中不改变 LRU 顺序，因此调用它（挂载帧 / 视图回退分支，含 StrictMode
     * 双渲染）不会产生任何缓存副作用。
     */
    const initialStateFor = (rootSessionId) => {
      const cached = peek(rootSessionId);
      return {
        rootSessionId,
        snapshot: cached === null ? null : cached.snapshot,
        updatedAt: cached === null ? null : cached.updatedAt,
        loading: cached === null,
        error: null,
      };
    };

    /** 只读投影：当前缓存条目数（诊断与测试用，不暴露 Map 本身）。 */
    const size = () => snapshotCache.size;

    return Object.freeze({ limit, peek, write, initialStateFor, size });
  }

  // 只暴露主 IIFE 实际消费的符号：上限通过 factory 的 limit 投影，常量本身不外挂。
  global[SYMBOL] = Object.freeze({ createPanelSnapshotCache });
})(globalThis);
