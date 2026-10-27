/**
 * 入口装配段（票据 02）：把删除作业挂到 `state.sessionDeleteJob`。
 *
 * ## 为什么单独成段而不是塞进票据 01 的段文件
 * 票据 01 创建的 `index-assembly-session-delete.js` 是「实例锁 + 启动探测」的登记文件，
 * 票据 03 还要在同一文件里追加收敛 effect。本票据按约定**不改**那个文件：作业是纯按需调用
 * 的能力（没有启动期副作用），单独一段既不动既有注册顺序，也让「谁装了什么」保持一对一。
 * 新段追加在票据 01 段**之后**，既有段的相对顺序一字未改（AGENTS.md 的注册顺序红线）。
 *
 * ## 这一段只做适配，不做业务
 * 作业本身（流水线、五态、守恒）在 `host/session-delete-job` 里，只接收窄能力面；这里负责
 * 从组合根已有的东西里把能力面凑出来：
 * - **会话清单**：`sessionPersistence.list()`（宿主公开 seam，缺失即失败）；
 * - **DEG 子会话**：`state.readSnapshot().childModels`（键=子会话 ID，值里的 `parentId` 是父会话）；
 * - **live 会话**：`ctx.get('sessions')` 的 `get/list`（宿主 SessionStore 的公开方法）；
 * - **日志定位**：复用票据 01 段已建好的 `state.sessionDelete.resolveSessionLog`；
 * - **隔离区**：票据 01 的隔离区适配器（路径解析、原子改名、竞态回位、空目录复原）。
 *
 * ## fail-closed 口径
 * - 没有 `sessions` 服务（旧宿主）→ 判活一律按 live 处理：不能证明未被占用的会话绝不删；
 * - 清单/子会话读失败 → 作业返回 `accepted:false`（快照不可用），不猜闭包；
 * - 隔离根不可解析 → 改名端口抛错，作业按 `failed` 处理（日志原地不动）；
 * - 作业开始前复核实例锁失败（锁已被另一个实例接管）→ 作业 fail-closed 拒绝，并把删除能力
 *   置为不可用（启动探测的 `markUnavailable`），此后不再重试。
 *
 * ## 会话移除事件（票据 08）
 * 作业结束后对 `deleted` / `absent` 的目标逐个发布宿主已白名单化的 `api-session/removed`
 * 事件，其余三态一律不发。判定与发布原语在 `host/session-delete-events`（纯函数），这里只
 * 负责**在作业收尾处**包一层：纯作业模块仍然不读 ctx、不发事件（端口注入约定不变），而所有
 * 调用方（RPC 命令面、测试、将来的其它入口）都自动得到同一条事件口径。
 * 发布器缺失（宿主没有事件通道）时**不包装**：作业行为与装配前逐字节一致。
 *
 * @module dsh-expert-group/host/index-assembly-session-delete-job
 */
import {
  removeEmptySessionQuarantineDirectory,
  renameSessionLogIntoQuarantine,
  restoreSessionLogFromQuarantine,
  sessionQuarantineDirectory,
} from "./session-delete-quarantine.js";
import { emitRemovedSessions } from "./session-delete-events.js";
import { STARTUP_PROBE_REASONS } from "./session-delete-probe.js";
import { installSessionDeleteJob } from "./session-delete-job.js";

/** 宿主服务读取失败等价于「没有该服务」。 */
function readServiceOf(readHostService, serviceName) {
  try {
    return readHostService?.(serviceName);
  } catch {
    return undefined;
  }
}

/**
 * 会话事实端口：闭包冻结与执行期判活都从这里取事实。
 *
 * @param {object} state - 装配状态容器（只读 `readSnapshot` 与 `sessionDelete`）。
 * @param {Function} readHostService - 宿主服务读取器（组合根注入）。
 * @returns {object} `{readHeaders, readDegChildren, readLiveSessionIds, isLive, resolveLog}`。
 */
function buildSessionsPort(state, readHostService) {
  return {
    /** 持久化清单：宿主没有该服务或没有 list 时**抛错**（快照不可用，不猜闭包）。 */
    readHeaders() {
      const persistence = readServiceOf(readHostService, "sessionPersistence");
      const list = persistence !== null && typeof persistence === "object" ? persistence.list : undefined;
      if (typeof list !== "function") throw new Error("session persistence list is unavailable");
      return list.call(persistence);
    },
    /** DEG 子会话记录：只读投影，读失败等价于「没有记录」（header 血缘仍然生效）。 */
    readDegChildren() {
      let snapshot;
      try {
        snapshot = state.readSnapshot?.();
      } catch {
        return [];
      }
      const models = snapshot?.childModels;
      if (models === null || typeof models !== "object") return [];
      return Object.entries(models).map(([childId, record]) => ({ childId, parentId: record?.parentId }));
    },
    /** 确认时刻的 live 会话 ID 快照（没有该服务时为空——执行期判活会逐条 fail-closed）。 */
    readLiveSessionIds() {
      const sessions = readServiceOf(readHostService, "sessions");
      const list = sessions !== null && typeof sessions === "object" ? sessions.list : undefined;
      if (typeof list !== "function") return [];
      const live = list.call(sessions);
      return Array.isArray(live) ? live.map((session) => session?.id) : [];
    },
    /** 执行期判活：拿不到宿主会话表就按 live 处理（不可证明未占用 → 不删）。 */
    isLive(sessionId) {
      const sessions = readServiceOf(readHostService, "sessions");
      const get = sessions !== null && typeof sessions === "object" ? sessions.get : undefined;
      if (typeof get !== "function") return true;
      const session = get.call(sessions, sessionId);
      return session !== undefined && session !== null;
    },
    /** 日志定位复用票据 01 段的能力面（locate 优先 + 编码复刻）。 */
    resolveLog(header) {
      const resolve = state.sessionDelete?.resolveSessionLog;
      if (typeof resolve !== "function") throw new Error("session log resolver is unavailable");
      return resolve(header);
    },
  };
}

/**
 * 隔离区端口：路径解析与文件操作全部在票据 01 的适配器里，作业只拿会话 ID 与路径结果。
 *
 * @param {object} state - 装配状态容器。
 * @returns {object} `{directoryOf, renameIntoQuarantine, restore, removeEmptyDirectory}`。
 */
function buildQuarantinePort(state) {
  const readRoot = () => {
    try {
      return state.sessionDelete?.readQuarantineRoot?.();
    } catch {
      return undefined;
    }
  };
  return {
    directoryOf(sessionId) {
      const root = readRoot();
      // 隔离根不可解析时**抛错**：作业按 failed 处理，绝不把日志搬到一个猜出来的位置。
      if (typeof root !== "string" || root.length === 0) throw new Error("session delete quarantine root is unavailable");
      return sessionQuarantineDirectory(root, sessionId);
    },
    renameIntoQuarantine: (params) => renameSessionLogIntoQuarantine(params),
    restore: (params) => restoreSessionLogFromQuarantine(params),
    removeEmptyDirectory(sessionId) {
      const root = readRoot();
      if (typeof root !== "string" || root.length === 0) return { removed: false, skipped: "path-unresolved" };
      return removeEmptySessionQuarantineDirectory(root, sessionId);
    },
  };
}

/**
 * 给作业包上「收尾处发布会话移除事件」这一层（票据 08）。
 *
 * 只包 `run`：`snapshot` 原样转发（在途查询不经过事件层，也没有任何副作用）。包装后的作业
 * 仍然是 `{run, snapshot}` 的同形窄面，RPC 命令面与测试替身都不需要感知这一层。
 *
 * 发布器缺失/不是函数时**返回原作业**（不包空壳）：宿主没有事件通道的旧环境里，作业行为与
 * 装配前逐字节一致，绝不因为"多包装一层"改变返回对象身份或调用次数。
 *
 * @param {{run: Function, snapshot: Function}} job - 票据 02 的作业能力面。
 * @param {Function} [publish] - 事件发布器 `(event, sessionId) => void`。
 * @returns {{run: Function, snapshot: Function}} 带事件收尾的作业面。
 */
function withRemovalEvents(job, publish) {
  if (typeof publish !== "function") return job;
  return Object.freeze({
    snapshot: () => job.snapshot(),
    run: async (request) => {
      const summary = await job.run(request);
      // 只按逐目标结果态发布（deleted / absent）；发布器故障在这里已被吞掉，绝不上抛。
      emitRemovedSessions(summary, publish);
      return summary;
    },
  });
}

/**
 * 装配删除作业。
 *
 * @param {object} state - 装配状态容器（本段写入 `state.sessionDeleteJob`）。
 * @param {object} hostServices - 组合根交出的宿主能力面：
 *   `{readHostService, publishSessionRemoved?}`（后者是会话移除事件的发布器）。
 * @returns {Array<object>} 有序注册描述（一个 effect）。
 */
export function assembleSessionDeleteJob(state, hostServices) {
  const readHostService = hostServices?.readHostService;
  const sessionDelete = state.sessionDelete;
  if (sessionDelete === undefined || sessionDelete === null) {
    // 上一段没装配（理论上不可能：段序固定）。显式失败而不是装一个缺依赖的作业。
    throw new Error("session delete job requires the session delete assembly segment");
  }
  const buildJob = () => installSessionDeleteJob({
    store: sessionDelete.store,
    gate: sessionDelete.gate,
    sessions: buildSessionsPort(state, readHostService),
    // 标题解析属于候选查询（票据 04）：它才知道每个会话的展示名。装配段给一个空解析器，
    // 作业的 run({titleOf}) 可按次覆盖；缺失时 blockedBy 只有会话 ID，绝不伪造标题。
    titleOf: () => undefined,
    quarantine: buildQuarantinePort(state),
    clock: state.clock,
    // 作业开始前复核实例锁仍属于本进程（锁被接管 = 另有实例在删同一批日志）。
    lock: sessionDelete.lock,
    // 锁丢失时把删除能力整体置为不可用：探测快照是闸门与诊断投影的唯一权威读面。
    // 锁模块的结论里带 lockPath，这里一并透传，用户才知道「请删除哪个文件后重启 DSH」。
    reportUnavailable: () => {
      try {
        sessionDelete.probe?.markUnavailable?.(STARTUP_PROBE_REASONS.INSTANCE_LOCK_LOST, {
          lockPath: sessionDelete.lock?.snapshot?.()?.lockPath,
        });
      } catch {
        // 上报失败不得改变作业的拒绝结论（作业侧已经 fail-closed）。
      }
    },
  });
  return [
    {
      kind: "effect",
      label: "dsh-expert-group: session delete job",
      factory: () => {
        const job = withRemovalEvents(buildJob(), hostServices?.publishSessionRemoved);
        state.sessionDeleteJob = job;
        return () => {
          if (state.sessionDeleteJob === job) state.sessionDeleteJob = undefined;
        };
      },
    },
  ];
}
