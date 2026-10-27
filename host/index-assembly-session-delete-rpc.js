/**
 * 入口装配段（票据 04）：把候选查询与删除执行的 RPC 命令面挂到 `state.sessionDeleteRpc`。
 *
 * ## 为什么单独成段
 * 「谁装了什么」保持一对一：票据 01 段是实例锁 + 探测 + 收敛，票据 02 段是删除作业；本段只
 * 组合这两个能力 + 宿主公开服务，产出一个按 action 调用的命令面。它追加在既有段之后，
 * 既有段的注册顺序一字未改（AGENTS.md 的注册顺序红线）。
 *
 * ## 只做适配，不做业务
 * 候选的判定与删除的编排分别在 `host/session-delete-candidates` 与 `host/session-delete-rpc`；
 * 这里从组合根已有的东西里凑出窄能力面：
 * - **成员**：`ctx.get('workspaceRegistry').get(workspaceId)` 的公开 getter `sessionIds`
 *   （归档不改变成员关系；已脱离注册表的会话属于**未分组范围**，由下面这条读面提供）；
 * - **未分组成员**：`sessionPersistence.list()` 里 origin !== "subagent" 的会话 −
 *   `workspaceRegistry.list()` 全部实体的 `sessionIds` 并集（见 {@link buildUngroupedMembersPort}）；
 * - **清单**：`sessionPersistence.list()`（一次读取，本段不缓存第二份真相）；
 * - **DEG 子会话**：`state.readSnapshot().childModels`（补 header 已消失的子会话，与作业同一来源）。
 *   注意本段的端口是**授权口径**：读不到就抛错（授权路径因此 503），绝不降级成「没有记录」；
 *   作业装配段另有一个从宽端口（见 {@link buildDegChildrenPort} 与下方的 fail-closed 口径）；
 * - **会话事实**：`ctx.get('sessions').get(id)`（宿主 SessionStore 的公开方法）一次给出
 *   「是否仍被占用」与 header 标题；
 * - **作业**：`state.sessionDeleteJob.run`（票据 02，晚绑定：effect 激活后才存在）。
 *
 * ## fail-closed 口径
 * - 注册表/清单/会话表不可用 → 候选查询返回 `delete-candidates-unavailable`（入口置为不可用）；
 * - 判活读不通 → 同样整体失败，绝不把「读不通」当成「没被占用」；
 * - 工作区不存在 → `workspace-not-found`（404 语义），不返回「看起来像空工作区」的假成功；
 * - 作业未装配/被卸载 → `delete-unavailable`（503），不静默成功；
 * - 删除目标不属于该工作区（既非成员、也非成员后代）→ `delete-targets-outside-workspace`
 *   （400）并整批拒绝；成员/清单读不出来 → `delete-unavailable`（503），绝不猜；
 * - DEG 快照读面缺失 / 抛错 / `childModels` 形状非法 → 删除授权 `delete-unavailable`（503）：
 *   DEG 记录是 header 血缘之外的唯一证据，读不到就证明不了闭包里没有工作区成员。候选查询
 *   不受影响——它按自己的口径把 DEG 读失败降级成空关系（那是候选模块的既有行为）；
 * - 作业期口径不同：作业装配段的 DEG 端口读失败等价于「没有记录」（header 血缘仍然生效，
 *   最多导致少删/跳过）。**授权从严、执行从宽**是刻意的安全方向；
 * - 未分组范围：注册表 `list()` 或持久化清单读不出来 → 候选查询 `delete-candidates-unavailable`、
 *   删除 `delete-unavailable`（都是 503）。**绝不**返回空候选列表或放行删除——「读不通」
 *   与「没有未分组会话」是两件事。
 *
 * @module dsh-expert-group/host/index-assembly-session-delete-rpc
 */
import { installSessionDeleteCandidates } from "./session-delete-candidates.js";
import { SESSION_DELETE_RPC_CODES, installSessionDeleteRpc, sessionDeleteRpcError } from "./session-delete-rpc.js";

/** 宿主服务读取失败等价于「没有该服务」。 */
function readServiceOf(readHostService, serviceName) {
  try {
    return readHostService?.(serviceName);
  } catch {
    return undefined;
  }
}

/** 候选查询的整批不可用（读面缺失/形状非法）：错误码与文案都来自 RPC 命令面。 */
function candidatesUnavailable(cause) {
  return sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CANDIDATES_UNAVAILABLE, undefined, { cause });
}

/**
 * 工作区成员端口：只读注册表的公开 getter。
 *
 * `get(workspaceId)` 返回 undefined 表示工作区不存在（这是**明确的否定**，不是读失败）；
 * 注册表本身缺失、没有 `get`、或 `sessionIds` 不是数组，都属于读面不可用。
 *
 * @param {Function} readHostService - 宿主服务读取器（组合根注入）。
 * @returns {(workspaceId: string) => (string[]|undefined)} 成员读取。
 */
function buildWorkspaceMembersPort(readHostService) {
  return (workspaceId) => {
    const registry = readServiceOf(readHostService, "workspaceRegistry");
    if (registry === null || typeof registry !== "object" || typeof registry.get !== "function") {
      throw candidatesUnavailable();
    }
    let entity;
    try {
      entity = registry.get(workspaceId);
    } catch (error) {
      throw candidatesUnavailable(error);
    }
    if (entity === undefined || entity === null) return undefined;
    // 成员集合只认公开 getter：宿主会按 header/live 索引过滤，插件不复刻这套过滤规则。
    const memberIds = entity.sessionIds;
    if (!Array.isArray(memberIds)) throw candidatesUnavailable();
    return memberIds;
  };
}

/** subagent 会话的 origin 标记（宿主 header 契约里子会话的来源标识）。 */
const SUBAGENT_ORIGIN = "subagent";

/**
 * 读一条持久化清单条目的身份：兼容「后端直接返回 header」与「`{ header }` 包装」两种形状。
 *
 * 这里刻意读**原始条目**而不是 {@link normalizeSessionHeaders} 的返回值：归一后的 header 只保留
 * id/cwd/parentSession/title，没有 origin；改归一层会波及其它调用方与既有断言，因此 origin
 * 只在未分组成员枚举这一处按原始形状判定。
 *
 * @param {unknown} entry - `sessionPersistence.list()` 的一条返回值。
 * @returns {{id: (string|undefined), origin: (string|undefined)}} 会话 ID 与 origin（都可能是 undefined）。
 */
function readEntryIdentity(entry) {
  const raw = entry !== null && typeof entry === "object" && entry.header !== undefined ? entry.header : entry;
  const id = typeof raw?.id === "string" && raw.id.length > 0 ? raw.id : undefined;
  const origin = typeof raw?.origin === "string" ? raw.origin : undefined;
  return { id, origin };
}

/**
 * 全部工作区成员的并集（W）：`workspaceRegistry.list()` 每个实体的 `sessionIds`。
 *
 * 为什么用 `list()` 的并集而不是逐 `get()`：未分组范围要判「某会话是否属于**任何**工作区」，
 * 而插件无法枚举工作区 ID；`list()` 一次给出全部实体，且与漂移探测第三项检查用的是同一个读面。
 * 实体缺失 `sessionIds` 数组时按读面非法处理（fail-closed）：漏掉一个工作区就可能把它的成员
 * 当成未分组会话放行删除。
 *
 * @param {Function} readHostService - 宿主服务读取器（组合根注入）。
 * @returns {string[]} 成员并集（保持 list() 与各实体 sessionIds 的顺序，去重）。
 */
function readWorkspaceMemberIds(readHostService) {
  const registry = readServiceOf(readHostService, "workspaceRegistry");
  if (registry === null || typeof registry !== "object" || typeof registry.list !== "function") {
    throw candidatesUnavailable();
  }
  let entities;
  try {
    entities = registry.list();
  } catch (error) {
    throw candidatesUnavailable(error);
  }
  if (!Array.isArray(entities)) throw candidatesUnavailable();
  const ids = [];
  const seen = new Set();
  for (const entity of entities) {
    if (entity === null || typeof entity !== "object") throw candidatesUnavailable();
    const memberIds = entity.sessionIds;
    if (!Array.isArray(memberIds)) throw candidatesUnavailable();
    for (const entry of memberIds) {
      if (typeof entry !== "string" || entry.length === 0) continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      ids.push(entry);
    }
  }
  return ids;
}

/**
 * 未分组成员读面（`U − W`，服务端权威口径）。
 *
 * - **U** = `sessionPersistence.list()` 里 **origin !== "subagent"** 的会话 ID；
 * - **W** = 全部工作区实体的 `sessionIds` 并集；
 * - 未分组成员 = U − W。
 *
 * 为什么排除 subagent：专家子会话只作为父会话闭包的成员存在，删除它们必须沿父目标走闭包；
 * 单独列成「未分组」条目会让用户看到一个删了就断链的会话，也会让闭包授权失去边界。
 * 为什么不并入 live-only 会话：未持久化的会话是当前 blank 新会话（没有日志），侧栏可见但
 * 删除没有意义；持久化清单已覆盖所有有日志的可见会话。
 *
 * 读面缺失/抛错/形状非法一律抛错（候选查询与删除授权都按 503 fail-closed）：绝不返回空列表
 * 冒充「没有未分组会话」。
 *
 * @param {Function} readHostService - 宿主服务读取器（组合根注入）。
 * @returns {() => Promise<{ungroupedIds: string[], workspaceIds: string[]}>} 成员读取（含 W，
 *   供删除授权判断「目标的闭包里有没有工作区成员」）。
 */
function buildUngroupedMembersPort(readHostService) {
  return async () => {
    const workspaceIds = readWorkspaceMemberIds(readHostService);
    const workspaceSet = new Set(workspaceIds);
    const persistence = readServiceOf(readHostService, "sessionPersistence");
    const list = persistence !== null && typeof persistence === "object" ? persistence.list : undefined;
    if (typeof list !== "function") throw candidatesUnavailable();
    let entries;
    try {
      entries = await list.call(persistence);
    } catch (error) {
      throw candidatesUnavailable(error);
    }
    if (!Array.isArray(entries)) throw candidatesUnavailable();
    const ungroupedIds = [];
    const seen = new Set();
    for (const entry of entries) {
      const { id, origin } = readEntryIdentity(entry);
      // 同一 id 只保留第一条：与 normalizeSessionHeaders 的去重口径一致。
      if (id === undefined || seen.has(id)) continue;
      seen.add(id);
      if (origin === SUBAGENT_ORIGIN) continue;
      if (workspaceSet.has(id)) continue;
      ungroupedIds.push(id);
    }
    return { ungroupedIds, workspaceIds };
  };
}

/** 持久化清单端口：宿主公开 seam（缺失即抛错 → 候选查询整体不可用，绝不猜）。 */
function buildHeadersPort(readHostService) {
  return () => {
    const persistence = readServiceOf(readHostService, "sessionPersistence");
    const list = persistence !== null && typeof persistence === "object" ? persistence.list : undefined;
    if (typeof list !== "function") throw candidatesUnavailable();
    return list.call(persistence);
  };
}

/**
 * DEG 子会话端口（**授权口径**：读不到就抛错，绝不降级成「没有记录」）。
 *
 * 这份读面同时被候选查询与目标授权使用，但两条消费路径对失败的处理**刻意不同**：
 * - **授权路径**（`session-delete-rpc` 的严格读面）拿到抛错后直接 503 `delete-unavailable`：
 *   DEG 记录是 header 血缘之外的唯一证据，读不到就证明不了「闭包里没有工作区成员」；
 * - **候选查询**（`session-delete-candidates` 的 `degChildrenOf`）自带 try/catch，仍把它降级成
 *   `[]`——header 血缘已足够支撑 live 后代判定，候选只是少一层补充。那条降级属于候选模块，
 *   不在本段，也不因本端口变严而改变。
 *
 * 因此本端口只负责**如实报告读不到**：`state.readSnapshot` 不可调用、调用抛错、或返回的
 * `childModels` 不是对象（null / 数组 / 原始值），一律抛「候选查询不可用」错误（授权路径会把它
 * 翻译成 503）。`childModels` 是空对象时返回 `[]`——那是**合法的空集合**，不是读故障。
 *
 * 与作业装配段的 DEG 端口**刻意不同**：作业侧（`index-assembly-session-delete-job`）仍把读失败
 * 当成「没有记录」（header 血缘仍然生效，最多导致少删/跳过）。授权从严、执行从宽才是安全方向。
 *
 * @param {object} state - 装配状态容器（读 `readSnapshot`，它由 bootstrap 段从 settings/storage 域展开）。
 * @returns {() => Array<{childId: string, parentId: unknown}>} DEG 子会话连线读取。
 */
function buildDegChildrenPort(state) {
  return () => {
    const read = state.readSnapshot;
    if (typeof read !== "function") {
      // 快照读面未装配：无法证明「闭包里没有工作区成员」，绝不能当成「没有记录」。
      throw candidatesUnavailable();
    }
    let snapshot;
    try {
      snapshot = read.call(state);
    } catch (error) {
      throw candidatesUnavailable(error);
    }
    const models = snapshot?.childModels;
    // null / 数组 / 原始值都不是「子会话映射」：形状非法同样按读不到处理。
    if (models === null || typeof models !== "object" || Array.isArray(models)) {
      throw candidatesUnavailable();
    }
    return Object.entries(models).map(([childId, record]) => ({ childId, parentId: record?.parentId }));
  };
}

/** 取宿主 SessionStore 的公开 `get`；缺失时返回 undefined（调用方按不可用处理）。 */
function readSessionsGet(readHostService) {
  const sessions = readServiceOf(readHostService, "sessions");
  const get = sessions !== null && typeof sessions === "object" ? sessions.get : undefined;
  return typeof get === "function" ? { sessions, get } : undefined;
}

/**
 * 会话事实端口：一次 `sessions.get(id)` 同时给出「是否仍被占用」与 header 标题。
 *
 * 服务缺失/读取抛错时**抛错**（候选查询整体失败）。这与作业期的口径刻意不同：作业期
 * 「判不了就当 live」是为了不删掉不能证明空闲的会话；候选查询「判不了就整体失败」是为了
 * 不让界面把占用会话显示成可勾选。
 *
 * 标题只用于展示：宿主 header 契约目前没有 `title`（所以通常是 undefined），纯组合层会回退
 * 到 null，绝不伪造会话名。
 */
function buildSessionFactsPort(readHostService) {
  return (sessionId) => {
    const access = readSessionsGet(readHostService);
    if (access === undefined) throw candidatesUnavailable();
    const session = access.get.call(access.sessions, sessionId);
    const live = session !== undefined && session !== null;
    const rawTitle = session?.header?.title;
    return {
      live,
      ...(typeof rawTitle === "string" && rawTitle.length > 0 ? { title: rawTitle } : {}),
    };
  };
}

/** 作业端口：晚绑定 `state.sessionDeleteJob`（effect 激活后才存在，卸载后消失）。 */
function buildJobPort(state) {
  return {
    run(request) {
      const job = state.sessionDeleteJob;
      if (job === undefined || job === null || typeof job.run !== "function") {
        throw sessionDeleteRpcError(SESSION_DELETE_RPC_CODES.CAPABILITY_UNAVAILABLE);
      }
      return job.run(request);
    },
  };
}

/**
 * 装配会话删除的 RPC 命令面。
 *
 * @param {object} state - 装配状态容器（本段写入 `state.sessionDeleteRpc`）。
 * @param {object} hostServices - 组合根交出的宿主服务读取器 `{readHostService}`。
 * @returns {Array<object>} 有序注册描述（一个 effect）。
 */
export function assembleSessionDeleteRpc(state, hostServices) {
  const readHostService = hostServices?.readHostService;
  const sessionDelete = state.sessionDelete;
  if (sessionDelete === undefined || sessionDelete === null) {
    // 上一段没装配（理论上不可能：段序固定）。显式失败而不是装一个缺依赖的命令面。
    throw new Error("session delete rpc requires the session delete assembly segment");
  }
  // 四份读面在候选查询与目标归属校验之间共享同一份实现：两者对「谁是成员 / 谁在未分组 /
  // 谁的父是谁」必须给出同一个答案，否则会出现「候选里没有、删除却放行」这类两个结论打架的现场。
  const readMembers = buildWorkspaceMembersPort(readHostService);
  const readHeaders = buildHeadersPort(readHostService);
  const readDegChildren = buildDegChildrenPort(state);
  // 未分组范围的成员来源（U − W）：候选查询与删除授权共用，不各自再算一份。
  const readUngroupedMembers = buildUngroupedMembersPort(readHostService);
  const commands = installSessionDeleteRpc({
    candidates: installSessionDeleteCandidates({
      gate: sessionDelete.gate,
      readMembers,
      readHeaders,
      readDegChildren,
      readSession: buildSessionFactsPort(readHostService),
      readUngroupedMembers,
    }),
    job: buildJobPort(state),
    // 删除目标的归属校验（服务端信任边界）：工作区读面抛错 → 503，返回 undefined → 404；
    // 未分组范围还要用 readHeaders 展开后代闭包（closure ∩ W = ∅ 的判据）。
    workspaceTargets: { readMembers, readHeaders, readDegChildren, readUngroupedMembers },
  });
  return [
    {
      kind: "effect",
      label: "dsh-expert-group: session delete rpc",
      factory: () => {
        state.sessionDeleteRpc = commands;
        return () => {
          // 只有仍指向本实例时才清空：重复装配/卸载不会误删后来者的命令面。
          if (state.sessionDeleteRpc === commands) state.sessionDeleteRpc = undefined;
        };
      },
    },
  ];
}
