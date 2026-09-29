/**
 * Host 关注点模块：Expert Group JSON 投影。
 *
 * 把「一个根会话 + 它的普通专家子代理 + 它的 fan-out 父任务」这套运行时对象，
 * 归一成一份**只读的 JSON 树**（schemaVersion:1），供右侧栏/客户端直接渲染。
 *
 * 设计边界：
 *
 * 1. 单向投影：本模块只读输入，绝不修改调用方对象（数组一律复制后处理，禁止原地排序）。
 * 2. 不重算状态：fan-out manager 已经给出 task/shard 明确状态时原样采用；只有在
 *    manager 没给 shard 状态时才回退到「最新 attempt」的状态。客户端不得再重算。
 * 3. 不猜内容：读不到的字段统一归一为 null，状态词表外的值统一归一为 "unknown"；
 *    缺失 taskName/content/contentSource 时不会用 id、prompt 或时间戳去拼凑。
 * 4. 幂等：同一份输入重复投影得到深度相等的输出，便于 RPC 缓存与差异比较。
 *
 * @module dsh-expert-group/host/expert-group-snapshot
 */

/** 投影 schema 版本；客户端只接受该版本的负载。 */
export const EXPERT_GROUP_SNAPSHOT_SCHEMA_VERSION = 1;

/**
 * 统一状态词表（Host 投影出口的唯一状态集合）。
 *
 * - queued/waiting：已登记但尚未真正执行；
 * - running：正在执行；
 * - succeeded/failed/cancelled/timed_out/interrupted：终态（interrupted 表示运行时
 *   句柄丢失，只能由重启后的 restore 判定）；
 * - idle/ready：DSH 的空闲语义（idle=已加载但当前无任务，ready=仅存在于存储中、可续接）；
 * - unknown：状态缺失或词表外的值，投影不猜测。
 */
export const EXPERT_GROUP_STATUSES = Object.freeze([
  "queued",
  "waiting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "idle",
  "ready",
  "unknown",
]);

const STATUS_SET = new Set(EXPERT_GROUP_STATUSES);

/**
 * 同义状态别名表：只收敛**拼写差异**（大小写、连字符、空格、常见同义词），
 * 不做语义推断。例如 "completed" 与 "succeeded" 在 fan-out 与 DSH 中含义一致，
 * 因此可安全归一；而 "paused"/"blocked" 之类没有对应词表项，一律落回 "unknown"。
 */
const STATUS_ALIASES = new Map([
  ["canceled", "cancelled"],
  ["timeout", "timed_out"],
  ["timedout", "timed_out"],
  ["timed-out", "timed_out"],
  ["success", "succeeded"],
  ["successful", "succeeded"],
  ["complete", "succeeded"],
  ["completed", "succeeded"],
  ["done", "succeeded"],
  ["error", "failed"],
  ["errored", "failed"],
  ["active", "running"],
  ["in_progress", "running"],
  ["in-progress", "running"],
  ["working", "running"],
  ["pending", "queued"],
  ["scheduled", "queued"],
  ["wait", "waiting"],
]);

/** 文本字段归一：只有非空字符串才算「有值」，其余（含数字/对象）统一为 null。 */
function textOrNull(value) {
  if (typeof value !== "string") return null;
  return value.length === 0 ? null : value;
}

/**
 * 分片任务名称归一：只有"去掉首尾空白后仍非空"的字符串才算有值。
 *
 * 与 textOrNull 的差别：纯空白名称在这里按缺失处理（回退分片代号），因为它是给用户
 * 看的任务名——一个只有空格的名称在侧栏上等价于空标签，还会多出一个悬空分隔符。
 * 名称内部的大小写与标点一律保留，返回值已 trim。
 */
function trimmedNameOrNull(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** 时间字段归一：只接受有限数值（epoch 毫秒），其余统一为 null。 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 从候选字段里取第一个非空字符串，全部缺失时返回 null（不拼接、不猜测）。 */
function firstText(...values) {
  for (const value of values) {
    const text = textOrNull(value);
    if (text !== null) return text;
  }
  return null;
}

/**
 * 状态归一。入参为空 → "unknown"；词表内原样通过；别名表命中则归一；
 * 其余值（包括任意自由文本）一律落回 "unknown"，绝不猜测。
 */
function normalizeStatus(value) {
  const text = textOrNull(value);
  if (text === null) return "unknown";
  const key = text.trim().toLowerCase().replace(/\s+/g, "_");
  if (STATUS_SET.has(key)) return key;
  return STATUS_ALIASES.get(key) ?? "unknown";
}

/**
 * running 布尔语义：
 * - 输入显式给了布尔 running 时以它为准（DSH 会话状态字段）；
 * - 否则由**已知**状态推导（running ⟺ true，其余已知状态 ⟺ false）；
 * - 状态缺失或未知时返回 null，而不是假的 false——「没写」与「明确没跑」不同。
 */
function runningOf(record, status) {
  if (typeof record?.running === "boolean") return record.running;
  if (status === "unknown") return null;
  return status === "running";
}

/** runSummary 是 Host 已派生的只读活动信息，未知值保持 unknown/null，不伪造空闲。 */
function projectRunSummary(value) {
  const source = asRecord(value);
  if (source === undefined) return null;
  const mode = source.mode === "continuable" || source.mode === "one-shot" ? source.mode : "unknown";
  const activity = source.activity === "running" || source.activity === "idle" ? source.activity : "unknown";
  return {
    command: textOrNull(source.command),
    mode,
    activity,
  };
}

/** 身份 id 归一：id → sessionId → childId，全部缺失时返回 null。 */
function identityOf(record) {
  return firstText(record?.id, record?.sessionId, record?.childId);
}

/** 参数校验：sessionId 必须是 Expert Group 的根会话键，否则拒绝投影。 */
function assertSessionId(sessionId) {
  if (!isNonEmpty(sessionId)) {
    throw new TypeError("buildExpertGroupSnapshot 需要非空字符串 sessionId");
  }
  return sessionId;
}

function isNonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 取记录的会话身份。非对象输入（字符串/数字/null）视为「没有记录」，
 * 而不是「用这个值当 id」——投影不允许从负载形状反推身份。
 */
function asRecord(value) {
  return value !== null && typeof value === "object" ? value : undefined;
}

/**
 * root/expert 节点共用的字段归一。
 *
 * 字段来源固定为「已声明的同名词」，别名只收敛 DSH 侧真实存在的等价字段：
 * - taskName：taskName/task/title/displayTitle/label/name（与 client.js 的目录读取一致）；
 * - content：content/prompt（CONTEXT.md：专家任务内容使用派发 prompt）；
 * - effort：reasoningEffort/effort；
 * - contentSource **只认显式字段**：投影不推断内容来自 goal、用户请求还是 prompt。
 */
function projectSessionNode(record, { kind, id, sessionId }) {
  const source = asRecord(record);
  const status = normalizeStatus(source?.status);
  return {
    id,
    kind,
    sessionId,
    taskName: firstText(
      source?.taskName,
      source?.task,
      source?.title,
      source?.displayTitle,
      source?.label,
      source?.name,
    ),
    content: firstText(source?.content, source?.prompt),
    contentSource: textOrNull(source?.contentSource),
    role: textOrNull(source?.role),
    provider: textOrNull(source?.provider),
    model: textOrNull(source?.model),
    effort: firstText(source?.reasoningEffort, source?.effort),
    status,
    running: runningOf(source, status),
    runSummary: projectRunSummary(source?.runSummary),
    continuable: typeof source?.continuable === "boolean" ? source.continuable : null,
    createdAt: numberOrNull(source?.createdAt),
  };
}

/** 单个普通专家节点：id/sessionId 都取会话身份（DSH 中 child agent id 即会话 id）。 */
function projectExpertNode(record) {
  const source = asRecord(record);
  const identity = identityOf(source);
  return {
    ...projectSessionNode(source, { kind: "expert", id: identity, sessionId: identity }),
    // 专家是叶子 worker，本切片不再向下展开子节点。
    children: [],
  };
}

/** 非数组输入降级为空集合：调用方给了半截数据时投影仍然可用，但不猜内容。 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/** 普通专家子节点投影。 */
function projectExpertChildren(experts) {
  return asArray(experts).map((record) => projectExpertNode(record));
}

// ── fan-out 分支投影 ────────────────────────────────────────────────────────

/** counts 的固定键集合，与 fanout.js 的 SHARD_STATUS_KEYS + pending 完全一致。 */
const COUNT_KEYS = Object.freeze([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "interrupted",
  "pending",
]);

/**
 * fan-out manager 的**父任务**状态枚举到统一词表的显式映射。
 *
 * 这是 manager 自己的状态字（fanout.js FANOUT_TASK_STATUSES），不是客户端推断：
 * - pending（仍有未终态 shard）→ running（任务已派发且未收敛）；
 * - completed → succeeded；
 * - completed_with_errors → failed（部分成功在统一词表里没有独立项，原始字保留在
 *   taskStatus，消费方需要区分时读它）；
 * - cancelled → cancelled。
 */
const FANOUT_TASK_STATUS_MAP = new Map([
  ["pending", "running"],
  ["completed", "succeeded"],
  ["completed_with_errors", "failed"],
  ["cancelled", "cancelled"],
]);

/** 父任务状态归一：先走 manager 枚举表，再退回通用状态词表。 */
function normalizeTaskStatus(value) {
  const text = textOrNull(value);
  if (text === null) return "unknown";
  const mapped = FANOUT_TASK_STATUS_MAP.get(text.trim().toLowerCase());
  return mapped ?? normalizeStatus(text);
}

/**
 * 单次 attempt 投影（attempt 身份 = attempt 序号 + childId）。
 * 只保留导航与状态：result/error 可能很大，且已有独立读取通道，投影不搬运它们。
 */
function projectAttemptNode(attempt) {
  const source = asRecord(attempt);
  return {
    attempt: numberOrNull(source?.attempt),
    status: normalizeStatus(source?.status),
    childId: textOrNull(source?.childId),
    startedAt: numberOrNull(source?.startedAt),
    finishedAt: numberOrNull(source?.finishedAt),
  };
}

/**
 * 单 shard 投影。
 *
 * 状态优先级：manager 的明确 shard.status 优先；manager 没给（部分输入/旧快照）时，
 * 才取**最新一次 attempt**（输入数组最后一项，manager 保证追加顺序）的状态。
 * 因此「历史 attempt 失败、最新 attempt 成功」必须投影为 succeeded，反之亦然——
 * 历史 attempt 不覆盖当前有效结果，只作为审计信息保留在 attempts 里。
 * childId 同理只取最新 attempt 的，作为唯一导航键。
 */
function projectShardNode(shard, inherited = {}) {
  const source = asRecord(shard);
  const defaults = asRecord(inherited);
  const attempts = asArray(source?.attempts).map((attempt) => projectAttemptNode(attempt));
  const latestAttempt = attempts.length === 0 ? null : attempts[attempts.length - 1];
  const shardId = textOrNull(source?.shardId);
  const managerStatus = textOrNull(source?.status);
  const status = managerStatus === null
    ? latestAttempt?.status ?? "unknown"
    : normalizeStatus(managerStatus);
  return {
    shardId,
    // 主代理提供的分片任务名称优先（投影出的任务行第一行文本）；旧数据没有该字段或
    // 名称是空白串时回退分片代号，保持既有「分片标识即任务名称」的展示语义不变。
    taskName: trimmedNameOrNull(source?.name) ?? shardId,
    prompt: textOrNull(source?.prompt),
    // fan-out 一次提交使用同一专家角色；provider/model/effort 则由 runtime 按
    // 最新 attempt child 补齐。旧快照没有分片级字段时再继承父任务元数据。
    role: firstText(source?.role, defaults?.role),
    provider: firstText(source?.provider, defaults?.provider),
    model: firstText(source?.model, defaults?.model),
    effort: firstText(source?.reasoningEffort, source?.effort, defaults?.reasoningEffort, defaults?.effort),
    status,
    running: runningOf(source, status),
    runSummary: projectRunSummary(source?.runSummary),
    continuable: typeof source?.continuable === "boolean" ? source.continuable : null,
    childId: latestAttempt?.childId ?? null,
    createdAt: numberOrNull(source?.createdAt),
    attempts,
  };
}

/** counts 归一：manager 没给 counts 就保持 null（投影不按 shards 重算）；给了则逐键取值，缺失键为 null。 */
function projectCounts(counts) {
  const source = asRecord(counts);
  if (source === undefined) return null;
  const projected = {};
  for (const key of COUNT_KEYS) projected[key] = numberOrNull(source[key]);
  return projected;
}

/**
 * fan-out 父任务节点投影。
 *
 * taskStatus 保留 manager 的原始字（便于区分 completed / completed_with_errors），
 * status 是统一词表出口。父任务状态**不做 shard 聚合**：manager 没给就是 unknown。
 */
function projectFanoutNode(task) {
  const source = asRecord(task);
  const parentTaskId = textOrNull(source?.parentTaskId);
  const taskStatus = textOrNull(source?.status);
  const status = normalizeTaskStatus(taskStatus);
  return {
    // 父任务 id 本身就是稳定身份，可直接作为节点 id（kind 区分它与专家会话 id）。
    id: parentTaskId,
    kind: "fanout",
    parentTaskId,
    basePrompt: textOrNull(source?.basePrompt),
    role: textOrNull(source?.role),
    status,
    taskStatus,
    running: runningOf(source, status),
    createdAt: numberOrNull(source?.createdAt),
    counts: projectCounts(source?.counts),
    shards: asArray(source?.shards).map((shard) => projectShardNode(shard, {
      role: source?.role,
      provider: source?.provider,
      model: source?.model,
      reasoningEffort: source?.reasoningEffort,
      effort: source?.effort,
    })),
  };
}

/**
 * 收集所有 fan-out attempt 的 childId。
 *
 * 这些会话已经在 fan-out 分支里以「分片 + attempt」的形式出现，属于同一个 Expert
 * Group 节点的另一种视图；如果同时再作为普通 expert 子节点输出，客户端会看到重复
 * 任务。注意是**任意** attempt（含历史失败 attempt），不只是最新那次。
 */
function collectAttemptChildIds(fanoutTasks) {
  const childIds = new Set();
  for (const task of asArray(fanoutTasks)) {
    for (const shard of asArray(asRecord(task)?.shards)) {
      for (const attempt of asArray(asRecord(shard)?.attempts)) {
        const childId = textOrNull(asRecord(attempt)?.childId);
        if (childId !== null) childIds.add(childId);
      }
    }
  }
  return childIds;
}

/**
 * 合并排序：普通专家与 fan-out 分支统一按 createdAt 升序。
 *
 * 缺失 createdAt 的节点表示「时间未知」，统一排在有序节点之后，并在它们之间保持
 * 输入顺序；相同时间戳也用输入下标兜底，结果不依赖引擎排序实现的稳定性。
 * fan-out 内部的 shards/attempts 不参与该排序，始终保留 manager 顺序。
 */
function sortByCreatedAt(nodes) {
  return nodes
    .map((node, index) => ({ node, index }))
    .sort((left, right) => {
      const leftKey = left.node.createdAt === null ? Number.POSITIVE_INFINITY : left.node.createdAt;
      const rightKey = right.node.createdAt === null ? Number.POSITIVE_INFINITY : right.node.createdAt;
      if (leftKey !== rightKey) return leftKey - rightKey;
      return left.index - right.index;
    })
    .map((entry) => entry.node);
}

/**
 * root.children = 普通专家子节点 + fan-out 分支节点。
 * 先按 attempt.childId 去重，再按 createdAt 升序合并。
 */
function projectChildren(experts, fanoutTasks) {
  const fanoutChildIds = collectAttemptChildIds(fanoutTasks);
  const expertNodes = projectExpertChildren(experts)
    // 身份缺失的专家无法判定是否与 attempt 重复，保留原样而不是误删。
    .filter((node) => node.sessionId === null || !fanoutChildIds.has(node.sessionId));
  const fanoutNodes = asArray(fanoutTasks).map((task) => projectFanoutNode(task));
  return sortByCreatedAt([...expertNodes, ...fanoutNodes]);
}

/**
 * 构建 Expert Group 快照。
 *
 * @param {object} input
 * @param {string} input.sessionId - Expert Group 的根会话 id（必填，非法即抛 TypeError）。
 * @param {object} [input.root] - 根会话/根 Agent 记录；声明的会话 id 必须与 sessionId 一致。
 * @param {Array} [input.experts] - 普通专家记录（自身状态由 DSH 给出）。
 * @param {Array} [input.fanoutTasks] - fan-out manager 的父任务快照。
 * @param {number} [input.generatedAt] - 投影生成时间（epoch 毫秒）。
 * @returns {object} schemaVersion:1 的只读 JSON 树。
 */
export function buildExpertGroupSnapshot({ sessionId, root, experts, fanoutTasks, generatedAt } = {}) {
  const rootSessionId = assertSessionId(sessionId);
  const declaredRootId = identityOf(root);
  if (declaredRootId !== null && declaredRootId !== rootSessionId) {
    throw new TypeError(
      "buildExpertGroupSnapshot 的 root 会话 id " + declaredRootId + " 与 sessionId " + rootSessionId + " 不一致",
    );
  }
  return {
    schemaVersion: EXPERT_GROUP_SNAPSHOT_SCHEMA_VERSION,
    sessionId: rootSessionId,
    rootSessionId,
    generatedAt: numberOrNull(generatedAt),
    root: {
      ...projectSessionNode(root, {
        kind: "root",
        id: declaredRootId ?? rootSessionId,
        sessionId: rootSessionId,
      }),
      children: projectChildren(experts, fanoutTasks),
    },
  };
}
