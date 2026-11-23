/**
 * 会话删除收敛期的**清理步骤**（票据 03 · 规格决策 15/16）。
 *
 * ## 职责边界
 * 分支判定在 `session-delete-convergence`（只回答「该不该清理」），本模块只回答
 * 「清理哪些东西、哪一步失败了」。两者以**失败项码数组**对话：空数组 = 全部成功，
 * 非空 = 需要写残渣并保留收敛日志条目（决策 16 的第 3/4 步）。
 *
 * ## 清理内容（全部幂等、全部只作用于**目标会话 ID**）
 * 1. 工作区记账 `detachSession`：对所有工作区实体都尝试一次（成员关系不去猜，
 *    非成员调用必须是宿主侧的幂等 no-op）；
 * 2. 归档集合与置顶集合移除（`unarchiveSession` / `unpinSession`）；
 * 3. 派生缓存文件 `<DSH home>/storages/session_projcache/sessions/<会话 ID>.json`；
 * 4. DEG 数据：`session_overrides` / `session_override_meta` / `child_models` 按会话 ID
 *    整行删除（fan-out 的任务快照表已随 fan-out 整体移除，不再有跨会话引用要摘）。
 *
 * ## 绝不做的事
 * - **不遍历、不删除共享附件目录**：本模块拿不到附件根，也没有任何递归目录操作；唯一的
 *   文件操作是按确定文件名删一个投影缓存文件（票据 E3 边界）。
 * - **不触碰两张删除表**（收敛日志 / 残渣）：它们的生命周期只由收敛流程自己管理
 *   （票据 E6「不被清理动作波及」在结构上成立，而不是靠检查）。
 * - **不按前缀通配**：所有键都是完整会话 ID，删除目标逐条由调用方给出。
 *
 * ## 失败口径
 * 每一步独立 try/catch 且**互不短路**：一次收敛把能做的都做完，失败项汇总进残渣，
 * 下一次启动按同一份清单重试（每一步都幂等，重复执行没有额外副作用）。
 *
 * @module dsh-expert-group/host/session-delete-cleanup
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";

/**
 * 清理步骤的稳定失败项码（进入残渣表的 `failures` 数组，可展示、可断言）。
 *
 * 刻意使用「步骤名」而不是异常消息：残渣是给下一次启动重试用的恢复记录，
 * 不是错误日志；把路径/堆栈写进去只会把敏感信息落盘（残渣 schema 也限长 200 字符）。
 */
export const SESSION_DELETE_CLEANUP_FAILURES = Object.freeze({
  /** 工作区记账 detach 失败（注册表不可用、实体缺少写入口、写入抛错）。 */
  WORKSPACE_DETACH: "cleanup-workspace-detach",
  /** 归档集合移除失败。 */
  ARCHIVE_COLLECTION: "cleanup-archive-collection",
  /** 置顶集合移除失败。 */
  PIN_COLLECTION: "cleanup-pin-collection",
  /** 派生缓存文件删除失败（权限、占用等非 ENOENT 错误）。 */
  PROJECTION_CACHE: "cleanup-projection-cache",
  /** 派生缓存路径无法解析（DSH home 拿不到）：不猜路径，记失败。 */
  PROJECTION_CACHE_UNRESOLVED: "cleanup-projection-cache-unresolved",
  /** 会话模型覆盖表删除失败。 */
  SESSION_OVERRIDES: "cleanup-session-overrides",
  /** 覆盖代次表删除失败。 */
  SESSION_OVERRIDE_META: "cleanup-session-override-meta",
  /** 子会话模型表删除失败。 */
  CHILD_MODELS: "cleanup-child-models",
});

/**
 * 按会话 ID **整行删除**的 DEG 表（表名 → 失败项码）。
 *
 * 键就是会话 ID，因此身份永远取自键，绝不读记录体里的 ID 字段。三张表一次收敛各删一行，
 * 缺失即成功（幂等）。
 */
export const SESSION_DATA_TABLES = Object.freeze({
  session_overrides: SESSION_DELETE_CLEANUP_FAILURES.SESSION_OVERRIDES,
  session_override_meta: SESSION_DELETE_CLEANUP_FAILURES.SESSION_OVERRIDE_META,
  child_models: SESSION_DELETE_CLEANUP_FAILURES.CHILD_MODELS,
});

/** 派生缓存在 DSH home 下的固定相对目录（宿主内部布局，ADR 0011 已记录该依赖）。 */
const PROJECTION_CACHE_DIRECTORIES = Object.freeze(["storages", "session_projcache", "sessions"]);

/**
 * 会话 ID 是否是**可作为路径段的合法身份**（键非法即该条 fail-closed 的判据）。
 *
 * 为什么不用白名单字符集：真实会话 ID 的字符集属于宿主内部约定，收紧到 `[A-Za-z0-9._-]`
 * 会把「宿主换了 ID 生成策略」变成「删除永远收敛不了」。这里只排除**会被路径解释**或
 * **必然无法落成文件名**的形态：
 * - 空串、`.`、`..`（路径穿越语义）；
 * - 含目录分隔符（`/`、`\\`）、Windows 保留字符（`:*?"<>|`）、NUL 与控制字符；
 * - 长度超过 200（加上 `.json` 后缀仍远小于常见文件名上限）；
 * - 以点或空格结尾（Windows 会把它们吃掉，导致路径与预期不符）。
 *
 * 判定失败的那一条**不做任何清理、不修改文件、保留记录并写诊断**，其余条目照常收敛
 * （决策 8 的 fail-closed 边界，测试 B9）。
 *
 * @param {unknown} value - 收敛日志的键。
 * @returns {boolean} 合法身份返回 true。
 */
export function isSafeSessionId(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) return false;
  if (value === "." || value === "..") return false;
  if (/[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(value)) return false;
  if (value.endsWith(".") || value.endsWith(" ")) return false;
  return true;
}

/**
 * 派生缓存文件路径：`<DSH home>/storages/session_projcache/sessions/<会话 ID>.json`。
 *
 * @param {string} homeDirectory - DSH home 绝对路径。
 * @param {string} sessionId - 会话 ID（调用方已用 {@link isSafeSessionId} 校验）。
 * @returns {string} 绝对路径。
 * @throws {Error} home 为空或会话 ID 不是合法身份（绝不拼出可疑路径）。
 */
export function projectionCacheFileOf(homeDirectory, sessionId) {
  if (typeof homeDirectory !== "string" || homeDirectory.length === 0) {
    throw new Error("dsh home is required to resolve the projection cache file");
  }
  if (isSafeSessionId(sessionId) !== true) {
    throw new Error("session id is not a safe path segment");
  }
  return join(homeDirectory, ...PROJECTION_CACHE_DIRECTORIES, sessionId + ".json");
}

/** 默认删文件实现：`force` 让「文件本来就不存在」也算成功（幂等）。 */
function removeFileQuietly(file) {
  return rm(file, { force: true });
}

/**
 * 执行一步清理：抛错或返回失败码数组都折算成失败项码（互不短路）。
 *
 * @param {string[]} failures - 失败项收集数组（就地追加）。
 * @param {string} fallbackCode - 该步骤自己的失败项码。
 * @param {Function} task - 步骤实现；可返回失败码数组。
 * @returns {Promise<void>} 永远 resolve。
 */
async function runStep(failures, fallbackCode, task) {
  let outcome;
  try {
    outcome = await task();
  } catch {
    // 只记步骤码，不把异常消息（可能含绝对路径）落盘：残渣是可重试记录，不是错误日志。
    failures.push(fallbackCode);
    return;
  }
  if (Array.isArray(outcome)) {
    for (const code of outcome) {
      if (typeof code === "string" && code.length > 0) failures.push(code);
    }
  }
}

/**
 * 创建收敛期的清理能力面。
 *
 * 全部外部事实以端口注入（本模块不读 ctx、不 import 组合根、不做宿主服务探测）：
 * - `tables`：DEG 表写入口（`remove` 整行删除），实现方负责串行化与代次判定
 *   （fan-out 任务快照的读改写清理已随 fan-out 移除，不再需要 `update` 端口）；
 * - `bookkeeping`：工作区记账写入口；
 * - `collections`：归档 / 置顶集合写入口；
 * - `homeDirectory`：DSH home 解析（派生缓存路径的唯一来源）。
 *
 * @param {object} deps - 窄能力面。
 * @param {() => (string|undefined)} deps.homeDirectory - DSH home 读取器（拿不到返回 undefined）。
 * @param {object} deps.tables - `{remove(tableName, key)}`。
 * @param {object} deps.bookkeeping - `{detach(sessionId)}`。
 * @param {object} deps.collections - `{unarchive(sessionId), unpin(sessionId)}`。
 * @param {Function} [deps.removeFile] - 删文件端口（测试注入失败/计数用）。
 * @param {object} [deps.hooks] - 崩溃注入钩子（生产装配不提供）。
 * @returns {{run: (sessionId: string) => Promise<string[]>}} 清理能力面；返回失败项码数组。
 */
export function installSessionDeleteCleanup({
  homeDirectory,
  tables,
  bookkeeping,
  collections,
  removeFile = removeFileQuietly,
  hooks,
}) {
  /** 崩溃注入：把进程按死在某一步之后（钩子抛错原样上抛，由收敛流程按「中断」处理）。 */
  function afterStep(step, sessionId) {
    const hook = hooks?.afterStep;
    if (typeof hook !== "function") return;
    hook({ step, sessionId });
  }

  /** 删派生缓存文件：路径解析失败与删除失败要分开报（后者可重试，前者不会自愈）。 */
  async function removeProjectionCache(sessionId, failures) {
    let home;
    try {
      home = homeDirectory?.();
    } catch {
      home = undefined;
    }
    if (typeof home !== "string" || home.length === 0) {
      failures.push(SESSION_DELETE_CLEANUP_FAILURES.PROJECTION_CACHE_UNRESOLVED);
      return;
    }
    let file;
    try {
      file = projectionCacheFileOf(home, sessionId);
    } catch {
      failures.push(SESSION_DELETE_CLEANUP_FAILURES.PROJECTION_CACHE_UNRESOLVED);
      return;
    }
    try {
      await removeFile(file);
    } catch {
      failures.push(SESSION_DELETE_CLEANUP_FAILURES.PROJECTION_CACHE);
    }
  }

  /** 三张按会话 ID 整行删除的表（每一步独立计失败）。 */
  async function removeSessionData(sessionId, failures) {
    for (const [table, code] of Object.entries(SESSION_DATA_TABLES)) {
      await runStep(failures, code, () => tables.remove(table, sessionId));
    }
  }

  return Object.freeze({
    /**
     * 执行目标会话的全部清理步骤（**不短路**，失败项汇总返回）。
     *
     * @param {string} sessionId - 目标会话 ID（调用方已校验为合法身份）。
     * @returns {Promise<string[]>} 失败项码数组；空数组表示全部成功。
     */
    async run(sessionId) {
      const failures = [];
      await runStep(failures, SESSION_DELETE_CLEANUP_FAILURES.WORKSPACE_DETACH,
        () => bookkeeping.detach(sessionId));
      afterStep("workspace-detach", sessionId);
      await runStep(failures, SESSION_DELETE_CLEANUP_FAILURES.ARCHIVE_COLLECTION,
        () => collections.unarchive(sessionId));
      afterStep("archive-collection", sessionId);
      await runStep(failures, SESSION_DELETE_CLEANUP_FAILURES.PIN_COLLECTION,
        () => collections.unpin(sessionId));
      afterStep("pin-collection", sessionId);
      await removeProjectionCache(sessionId, failures);
      afterStep("projection-cache", sessionId);
      await removeSessionData(sessionId, failures);
      afterStep("deg-data", sessionId);
      return failures;
    },
  });
}
