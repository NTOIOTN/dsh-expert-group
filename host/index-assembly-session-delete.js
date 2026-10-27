/**
 * 入口装配段（票据 01）：会话删除的实例锁、启动探测，以及票据 03 追加的收敛 effect。
 *
 * ## 为什么单独成段
 * 这三件事都是**启动期 effect**（获取实例锁 → 探测五项 → 收敛一次），而后续票据要在同一
 * 段文件里追加能力，因此本段是它们共享的登记文件 owner：票据 01 创建它并在有序装配清单里
 * 登记一次，其它票据只在本文件内**追加**，不改既有装配段的顺序。
 *
 * ## 注册顺序（追加只发生在末尾）
 * 1. **实例锁**：先获取，启动探测紧接着读它的状态，因此两个 effect 的先后是语义要求。
 *    清理时**先排空在途删除作业、排空成功才释放锁**（超时/无法判定则保留残锁，下次启动按
 *    「锁存在即不可用」处理并提示用户删除）；宿主按逆序清理 effect，因此作业面可能已被清空，
 *    排空会退回作业模块的登记表；
 * 2. **启动探测**：等 storage binding 就绪后跑（storage domain 的注入是异步的），
 *    失败只把删除能力置为不可用，绝不让整个插件装配失败；它绝不占用写串行链；
 * 3. **收敛（票据 03）**：同样等 binding 就绪后**执行一次**，判据是「日志是否存在」，
 *    不做 live 检查、不等任何就绪信号（规格决策 13）。它排在探测之后，因为探测的
 *    「收敛文档可解析」结论决定本轮是否整体暂停；两者各自读文档，互不依赖。
 *
 * ## 与既有段的关系
 * 本段只消费 `state.storageBinding` / `state.settingsStorage`（第 3 段已就绪）与宿主服务读取器，
 * 不改变任何既有段的注册顺序与内容。
 *
 * @module dsh-expert-group/host/index-assembly-session-delete
 */
import { installInstanceLock } from "./session-delete-lock.js";
import { installSessionDeleteStore } from "./session-delete-store.js";
import { installStartupProbe, STARTUP_PROBE_REASONS } from "./session-delete-probe.js";
import { installDeletionGate } from "./session-delete-gate.js";
import {
  discardSessionQuarantineDirectory,
  quarantineRootPath,
  sessionQuarantineExists,
} from "./session-delete-quarantine.js";
import { resolveSessionLogLocation } from "./session-delete-paths.js";
import { installSessionDeleteCleanup } from "./session-delete-cleanup.js";
import { installSessionDeleteConvergence } from "./session-delete-convergence.js";
import { releaseLockAfterDrain } from "./session-delete-job.js";
import { persistDomainEntry, removeDomainEntry } from "../storage.js";

/**
 * 等待 storage binding 就绪的最长墙钟窗口（毫秒）。
 *
 * 超过这个窗口仍然没有 ready binding，就按「收敛文档不可解析」处理：删除能力不可用，
 * 本轮收敛整体暂停（fail-closed）。30 秒足以覆盖大文档的解析与磁盘 IO。
 */
const PROBE_READY_TIMEOUT_MS = 30000;

/** 首次就绪等待轮次用 setImmediate（宿主通常在同一轮 I/O 内就绪），之后退化为定时器。 */
const PROBE_READY_IMMEDIATE_ROUNDS = 4;

/** 退化后的重试间隔（毫秒）。定时器一律 unref：探测等待不得阻止进程退出。 */
const PROBE_READY_INTERVAL_MS = 15;

/**
 * 等 storage binding 就绪后执行一次任务（探测与收敛共用的等待器）。
 *
 * ## 为什么不用 `settingsStorage.enqueueWrite` 排队
 * 写串行链是**写**的顺序契约：把一个读探测排在链路最前面，会让紧随其后的 child/模板写入
 * 至少晚一拍落盘，把「派发返回时 child 记录已持久化」这类既有可观察行为变成竞态。等待器只需要
 * 「binding 就绪」这一个事实，因此这里只等它，绝不占用写链。
 *
 * ## 为什么是等待而不是订阅
 * 组合根只把 binding 暴露成命令式读面（`active()`），没有就绪 Promise/事件；这是启动期
 * 一次性任务，用一个**有界**的短轮询换取零侵入是这里刻意的取舍：前四轮 setImmediate 覆盖
 * 「同一轮 I/O 内就绪」，之后 15ms 间隔、全部 unref，最多等 PROBE_READY_TIMEOUT_MS。
 *
 * @param {object} state - 装配状态容器（读 storageBinding）。
 * @param {object} tasks - `{onReady, onTimeout}` 两个回调（都必须是同步入口，返回 Promise 会被兜住）。
 * @returns {Function} 卸载函数：取消等待、清定时器。
 */
function scheduleWhenStorageReady(state, { onReady, onTimeout }) {
  let cancelled = false;
  let handle;
  let handleKind;
  let immediateRounds = 0;
  const startedAt = Date.now();

  /** 任务自身永不 reject 的兜底：任何抛出都折算成「不可用」结论。 */
  const runSafely = (task) => {
    Promise.resolve()
      .then(() => task?.())
      .catch(() => onTimeout?.());
  };

  const tick = () => {
    if (cancelled) return;
    let ready = false;
    try {
      ready = state.storageBinding.active() !== undefined;
    } catch {
      ready = false;
    }
    if (ready === true) {
      runSafely(onReady);
      return;
    }
    if (Date.now() - startedAt >= PROBE_READY_TIMEOUT_MS) {
      onTimeout?.();
      return;
    }
    if (immediateRounds < PROBE_READY_IMMEDIATE_ROUNDS) {
      immediateRounds += 1;
      handle = setImmediate(tick);
      handleKind = "immediate";
      return;
    }
    handle = setTimeout(tick, PROBE_READY_INTERVAL_MS);
    // 定时器不保持事件循环：等待只是启动期的尽力而为，不能拖住宿主退出。
    handle?.unref?.();
    handleKind = "timeout";
  };

  tick();

  return () => {
    cancelled = true;
    if (handleKind === "immediate") clearImmediate(handle);
    else if (handleKind === "timeout") clearTimeout(handle);
    handle = undefined;
  };
}

/**
 * 等 storage binding 就绪后执行一次启动探测。
 *
 * @param {object} state - 装配状态容器（读 storageBinding）。
 * @param {object} probe - 启动探测能力面。
 * @returns {Function} 卸载函数：取消等待、清定时器并释放探测。
 */
function scheduleProbeWhenStorageReady(state, probe) {
  /** 登记一次「不可用」结论（等待超时或 storage 初始化失败的统一出口）。 */
  const markStorageUnavailable = () => probe.markUnavailable(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE);
  const cancel = scheduleWhenStorageReady(state, {
    onReady: () => probe.run(),
    onTimeout: markStorageUnavailable,
  });
  return () => {
    cancel();
    probe.dispose();
  };
}

/**
 * 卸载期诊断：只记原因码（不含路径/堆栈），且**绝不因为日志失败影响清理结论**。
 *
 * @param {{info?: Function}} [logger] - 宿主日志出口。
 * @param {string} reason - 稳定原因码（见 `SESSION_DELETE_UNLOAD_REASONS`）。
 */
function logUnloadDiagnostic(logger, reason) {
  try {
    logger?.info?.("dsh-expert-group: session delete unload [" + reason + "]");
  } catch {
    // 诊断失败不影响卸载：清理已经按 fail-closed 结论完成。
  }
}

/** 宿主服务读取失败等价于「没有该服务」。 */
function readServiceOf(readHostService, serviceName) {
  try {
    return readHostService?.(serviceName);
  } catch {
    return undefined;
  }
}

/** 取 `dshHomePath` 服务：它可能晚提供/被替换，因此每次调用都重新读取。 */
function readHomePathService(readHostService) {
  const service = readServiceOf(readHostService, "dshHomePath");
  return typeof service === "function" ? service : undefined;
}

/** 解析 DSH home 绝对路径（服务缺失/抛错/返回空串都返回 undefined）。 */
function readHomeDirectoryOf(readHostService) {
  const service = readHomePathService(readHostService);
  if (service === undefined) return undefined;
  try {
    const home = service();
    return typeof home === "string" && home.length > 0 ? home : undefined;
  } catch {
    return undefined;
  }
}

/** 读工作区注册表并校验读面可用；不可用就抛错（调用方按清理失败处理）。 */
function readWorkspaceEntities(readHostService) {
  const registry = readServiceOf(readHostService, "workspaceRegistry");
  if (registry === null || typeof registry !== "object" || typeof registry.list !== "function") {
    throw new Error("workspace registry is unavailable");
  }
  const entities = registry.list();
  if (!Array.isArray(entities)) throw new Error("workspace registry list is unavailable");
  return { registry, entities };
}

/**
 * 取某个工作区的**可写实体**。
 *
 * 规格给的入口是 `ctx.get('workspaceRegistry').get(workspaceId)`：列表项可能只是只读投影，
 * 真正的写入口在 `get()` 解析出的实体上。因此优先用实体自带的 id 再 get 一次；
 * get 不可用/抛错/返回非对象时退回列表项本身（两者表达同一个工作区）。
 */
function resolveWorkspaceWriter(registry, entity) {
  const id = typeof entity?.id === "string" && entity.id.length > 0
    ? entity.id
    : (typeof entity?.workspaceId === "string" && entity.workspaceId.length > 0 ? entity.workspaceId : undefined);
  if (id !== undefined && typeof registry.get === "function") {
    try {
      const resolved = registry.get(id);
      if (resolved !== null && typeof resolved === "object") return resolved;
    } catch {
      // 退回列表项：一次 get 失败不该让记账清理永远失败。
    }
  }
  return entity !== null && typeof entity === "object" ? entity : undefined;
}

/**
 * 读一个实体的成员集合（`sessionIds`）的**并集**：可写实体与列表项都算。
 *
 * 两侧表达同一个工作区，但 `registry.get(id)` 解析出的可写实体不保证重新暴露成员 getter，
 * 也不保证与列表项完全同步。取并集是刻意的 fail-closed：**只要任一侧**还引用着目标会话，
 * 就必须按「成员关系残留」处理；只有两侧给出的数组都不含目标（或其中一侧根本没有成员
 * getter、另一侧可读且不含）时，才能证明无需清理。
 *
 * @returns {Set<string>|undefined} 成员集合；两侧都没有数组时 undefined（= 无法证明）。
 */
function readMemberIdsOf(writer, entity) {
  const sources = [writer?.sessionIds, entity?.sessionIds].filter((value) => Array.isArray(value));
  if (sources.length === 0) return undefined;
  const ids = new Set();
  for (const source of sources) {
    for (const id of source) {
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return ids;
}

/**
 * 工作区记账端口（detach）。
 *
 * 成员关系不去猜：对**所有**工作区实体都尝试一次 `detachSession`，非成员调用必须是宿主侧
 * 的幂等 no-op。
 *
 * ## 缺写入口时的取舍（宁可留下待重试记录，也不静默丢掉恢复记录）
 * 旧宿主可能只有部分实体提供写面，因此「没有 `detachSession`」本身不算失败。但**不能**因此
 * 直接跳过：如果该实体的成员集合里仍然包含目标会话，跳过就等于「成员关系残留，而清理流程
 * 记成功、收敛条目被删除」——那个会话再也没有任何恢复记录，用户也永远看不到它需要清理。
 * 因此：
 * - 成员集合可读且**不含**目标 → 已证明这个实体无需清理，跳过；
 * - 成员集合可读且**含**目标 → 抛错（收敛期记为 `cleanup-workspace-detach` 失败并保留条目，
 *   下次启动重试；修好宿主/换版本后自然会成功）；
 * - 成员集合**读不出来**（两侧都没有 `sessionIds` 数组）→ 同样抛错：无法证明 ≠ 无需清理。
 *
 * 取舍的理由：失败项只是一条可重试的恢复记录，而静默成功会永久丢掉它。
 */
function buildBookkeepingPort(readHostService) {
  return {
    async detach(sessionId) {
      const { registry, entities } = readWorkspaceEntities(readHostService);
      for (const entity of entities) {
        const writer = resolveWorkspaceWriter(registry, entity);
        const detach = writer?.detachSession;
        if (typeof detach === "function") {
          await detach.call(writer, sessionId);
          continue;
        }
        const memberIds = readMemberIdsOf(writer, entity);
        if (memberIds === undefined) {
          throw new Error("workspace bookkeeping cannot prove the session is detached");
        }
        if (memberIds.has(sessionId)) {
          // 成员关系一定会残留：抛错让收敛期记失败并保留条目，而不是静默当成清理成功。
          throw new Error("workspace entity still references the session but exposes no detachSession");
        }
      }
    },
  };
}

/**
 * 归档 / 置顶集合端口。
 *
 * 两代宿主形态都要覆盖：新宿主的写入口挂在注册表上，旧宿主挂在工作区实体上。注册表级方法
 * 存在时只用它（一次调用就够）；否则逐个实体调用，并且**一个写入口都没有时显式失败**
 * （宁可进残渣重试，也不假装已经清掉集合里的成员）。
 */
function buildCollectionsPort(readHostService) {
  function invoke(methodName, sessionId) {
    const { registry, entities } = readWorkspaceEntities(readHostService);
    const registryWriter = registry[methodName];
    if (typeof registryWriter === "function") {
      const outcome = registryWriter.call(registry, sessionId);
      return outcome !== null && typeof outcome === "object" && typeof outcome.then === "function"
        ? outcome
        : undefined;
    }
    const pending = [];
    for (const entity of entities) {
      const writer = resolveWorkspaceWriter(registry, entity);
      const method = writer?.[methodName];
      if (typeof method !== "function") continue;
      pending.push(method.call(writer, sessionId));
    }
    if (pending.length === 0) throw new Error("workspace registry does not expose " + methodName);
    return Promise.all(pending);
  }
  return {
    unarchive: (sessionId) => invoke("unarchiveSession", sessionId),
    unpin: (sessionId) => invoke("unpinSession", sessionId),
  };
}

/**
 * DEG 数据表端口（收敛期清理 DEG 数据用）。
 *
 * 只暴露两件事：按会话 ID **整行删除**、以及「读一行 → 变换 → 写回」（fan-out 任务树摘引用）。
 * 两者都走宿主的写串行链与代次判定：绕过它们会破坏「单条记录原子、写入互不覆盖」的契约。
 */
function buildDomainTablePort(state) {
  /** 取当前 ready binding 的某张表；不可用就抛错（调用方按清理失败处理）。 */
  function requireTable(tableName) {
    const binding = state.storageBinding.active();
    const domain = binding !== null && typeof binding === "object" ? binding.domain : undefined;
    if (domain === null || typeof domain !== "object" || typeof domain.table !== "function") {
      throw new Error("storage domain is unavailable");
    }
    return { binding, table: domain.table(tableName) };
  }

  /** 走宿主写串行链；链不可用时显式失败（绝不旁路写盘）。 */
  function enqueueWrite(task) {
    const enqueue = state.settingsStorage?.enqueueWrite;
    if (typeof enqueue !== "function") {
      return Promise.reject(new Error("session delete convergence: storage write chain is unavailable"));
    }
    return enqueue(task);
  }

  return {
    async remove(tableName, key) {
      await enqueueWrite(async () => {
        const { binding, table } = requireTable(tableName);
        const result = await removeDomainEntry({
          table,
          key,
          isCurrent: () => state.storageBinding.isCurrent(binding) === true,
        });
        if (result.detached === true) throw new Error("storage domain binding was replaced");
      });
    },
    /**
     * 读一行 → 交给 `transform` → 只有返回新值时才写回。
     *
     * transform 返回 undefined 表示「没有任何引用需要清理」：不写盘，因此重复收敛不会
     * 制造无谓写入（幂等）。
     */
    async update(tableName, key, transform) {
      await enqueueWrite(async () => {
        const { binding, table } = requireTable(tableName);
        let current;
        for (const [entryKey, value] of table.entries()) {
          if (entryKey === key) {
            current = value;
            break;
          }
        }
        const next = transform(current);
        if (next === undefined) return;
        const result = await persistDomainEntry({
          table,
          key,
          value: next,
          isCurrent: () => state.storageBinding.isCurrent(binding) === true,
        });
        if (result.detached === true) throw new Error("storage domain binding was replaced");
      });
    },
  };
}

/**
 * 装配会话删除 host 基础设施（实例锁、启动探测、收敛）。
 *
 * @param {object} state - 装配状态容器（本段写入 `state.sessionDelete`）。
 * @param {object} hostServices - 组合根交出的宿主服务读取器 `{ readHostService }`。
 * @returns {Array<object>} 有序注册描述（三个 effect，顺序见模块头注释）。
 */
export function assembleSessionDelete(state, hostServices) {
  const readHostService = hostServices?.readHostService;
  const logger = state.logger;

  const readQuarantineRoot = () => {
    const home = readHomeDirectoryOf(readHostService);
    if (home === undefined) return undefined;
    try {
      return quarantineRootPath(home);
    } catch {
      return undefined;
    }
  };

  const readSessionsRoot = () => {
    const service = readHomePathService(readHostService);
    if (service === undefined) return undefined;
    try {
      const root = service("sessions");
      return typeof root === "string" && root.length > 0 ? root : undefined;
    } catch {
      return undefined;
    }
  };

  const lock = installInstanceLock({
    homeDirectory: () => readHomeDirectoryOf(readHostService),
  });

  const store = installSessionDeleteStore({
    getBinding: () => state.storageBinding.active(),
    isCurrent: (binding) => state.storageBinding.isCurrent(binding),
    enqueueWrite: (task) => {
      if (typeof state.settingsStorage?.enqueueWrite === "function") {
        return state.settingsStorage.enqueueWrite(task);
      }
      // 理论上第 3 段之后一定存在写入口。缺失时**显式失败**：绕过写串行链落盘会破坏
      // 「单条记录原子、写入互不覆盖」的契约，宁可让本次写入失败（调用方按失败处理）。
      return Promise.reject(new Error("session delete store: storage write chain is unavailable"));
    },
  });

  const probe = installStartupProbe({ readHostService, lock, store, clock: state.clock, logger });

  const gate = installDeletionGate({
    store,
    readAvailability: () => probe.snapshot(),
    // 缓存不可用时按需重算一次：启动期晚就绪的宿主服务（如 workspaceRegistry）可自愈；
    // 真正的故障重算后仍不可用，判定与 fail-closed 语义不变。
    refreshAvailability: () => probe.refresh(),
    sessionQuarantineExists: (sessionId) => {
      const root = readQuarantineRoot();
      // home 解析不出来时无法证明隔离目录已收尾：保守按「存在」处理（闸门因此阻塞）。
      if (root === undefined) return { exists: true, degraded: true };
      return sessionQuarantineExists(root, sessionId);
    },
  });

  /**
   * 闸门门面 + **只读的删除能力快照**。
   *
   * 判定契约一字不动（仍是 `check / checkMany / evaluate`），只是把闸门已经在用的那份探测
   * 快照额外暴露出来：候选查询与删除动作据此把「残锁路径 + 操作步骤」拼进用户可见的错误消息
   * （消息由 `session-delete-candidates` 组装，闸门模块本身不产出文案）。
   */
  const removableGate = Object.freeze({
    ...gate,
    readAvailability: () => probe.snapshot(),
  });

  /**
   * 解析会话日志位置（优先 locate，缺失回退复刻）。
   *
   * locate 属于 jsonl 后端的私有扩展，因此每次调用都从当前 sessionPersistence 现取，
   * 不缓存服务对象（宿主可能重建服务）。
   */
  const resolveSessionLog = (header) => {
    const persistence = readServiceOf(readHostService, "sessionPersistence");
    const locate = persistence !== null && typeof persistence === "object" ? persistence.locate : undefined;
    return resolveSessionLogLocation({
      locate: typeof locate === "function" ? (value) => locate.call(persistence, value) : undefined,
      header,
      sessionsRoot: readSessionsRoot(),
    });
  };

  /**
   * 收敛期的会话事实端口：
   * - `readHeaders()` 读持久化清单（宿主公开 seam，缺失即抛错 → 本轮整体暂停）；
   * - `resolve(header)` 复用上面那套日志定位（locate 优先 + 编码复刻）。
   */
  const logs = {
    readHeaders() {
      const persistence = readServiceOf(readHostService, "sessionPersistence");
      const list = persistence !== null && typeof persistence === "object" ? persistence.list : undefined;
      if (typeof list !== "function") throw new Error("session persistence list is unavailable");
      return list.call(persistence);
    },
    resolve(header) {
      return resolveSessionLog(header);
    },
  };

  /**
   * 收敛（票据 03）：**只在启动时执行一次**，判据是「日志是否存在」，不做 live 检查。
   *
   * 隔离区收尾是删除该会话整个隔离目录；隔离根解析不出来时按失败处理（残渣 + 保留条目），
   * 绝不把日志搬到一个猜出来的位置。
   */
  const convergence = installSessionDeleteConvergence({
    store,
    logs,
    cleanup: installSessionDeleteCleanup({
      homeDirectory: () => readHomeDirectoryOf(readHostService),
      tables: buildDomainTablePort(state),
      bookkeeping: buildBookkeepingPort(readHostService),
      collections: buildCollectionsPort(readHostService),
    }),
    quarantine: {
      settle(sessionId) {
        const root = readQuarantineRoot();
        if (root === undefined) return { settled: false, reason: "path-unresolved" };
        return discardSessionQuarantineDirectory(root, sessionId);
      },
    },
    clock: state.clock,
    logger,
  });

  state.sessionDelete = Object.freeze({
    lock,
    store,
    probe,
    gate: removableGate,
    convergence,
    readSessionsRoot,
    readQuarantineRoot,
    resolveSessionLog,
  });

  return [
    {
      kind: "effect",
      label: "dsh-expert-group: session delete instance lock",
      factory: () => {
        // 锁获取失败只记录结论（诊断里可读），绝不阻断插件装配。
        lock.acquire();
        return async () => {
          // **清理顺序是安全要求**：先排空在途删除作业，排空成功才释放锁。
          // 反过来（先放锁）会让另一个实例在作业还没跑完时取得锁并开工——两个实例并发删除。
          // 宿主按逆序清理 effect，此刻 `state.sessionDeleteJob` 可能已被置空；helper 会退回
          // 作业模块的登记表排空（两个入口都覆盖）。
          await releaseLockAfterDrain({
            job: state.sessionDeleteJob,
            lock,
            report: (reason) => logUnloadDiagnostic(logger, reason),
          });
        };
      },
    },
    {
      kind: "effect",
      label: "dsh-expert-group: session delete startup probe",
      factory: () => scheduleProbeWhenStorageReady(state, probe),
    },
    {
      // 票据 03：收敛 effect **追加**在探测之后（既有两个 effect 的相对顺序一字未改）。
      kind: "effect",
      label: "dsh-expert-group: session delete convergence",
      factory: () => scheduleWhenStorageReady(state, {
        onReady: () => convergence.run(),
        // 等不到 binding 等于「收敛文档不可解析」：本轮整体暂停并留下可读结论。
        onTimeout: () => convergence.markPaused(STARTUP_PROBE_REASONS.QUEUE_UNREADABLE),
      }),
    },
  ];
}
