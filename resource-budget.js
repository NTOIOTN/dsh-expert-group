/**
 * fan-out 数据资源预算：体积测量、冻结预算常量与结构化违规描述。
 *
 * 设计目标（任务书 11）：
 * - 只做"测量 + 判定 + 结构化描述"，不持有调度状态、不写 storage、不读时钟；
 * - 所有字节预算都必须有可复现的固定 fixture 测量依据（见 RESOURCE_BUDGET_BASELINE），
 *   不允许在别处手写未经测量的"批准常量"；
 * - 违规一律表达为结构化对象（code/resource/limit/receivedBytes/complete/recoverable），
 *   可直接进入事件、快照与 RPC 响应，调用方按 code 分支而不解析文案。
 *
 * 测量口径统一为 UTF-8 字节（不是 UTF-16 字符数）：中文与 emoji 的字符数会严重
 * 低估真实传输/落盘体积，而 storage、RPC body 与 JSON 快照都按字节计量。
 *
 * @module dsh-expert-group/resource-budget
 */

/** 预算违规的统一 code；RPC/工具层据此映射为显式拒绝。 */
export const BUDGET_EXCEEDED_CODE = "BUDGET_EXCEEDED";


/**
 * 预算常量（冻结）。
 *
 * 每个字节预算都取自 RESOURCE_BUDGET_BASELINE 的同名测量值，并保留 >= 2x 的代表样本
 * 余量；测量 fixture 与重测命令见 test/resource-budget.test.mjs。
 */
export const FANOUT_BUDGET = Object.freeze({
  /** 单个父任务的公共目标 + 单个 shard 正文合计上限。 */
  maxTaskInputBytes: 512 * 1024,
  /** 单次 attempt 的 result 上限（超出必须显式失败，不得静默截断）。 */
  maxAttemptResultBytes: 1024 * 1024,
  /** 单次 attempt 的 error 上限（结构化错误必须保持可序列化）。 */
  maxAttemptErrorBytes: 64 * 1024,
  /** 单条事件上限；超出时只发布不含原始负载的诊断事件。 */
  maxEventBytes: 256 * 1024,
  /** 单份可持久化快照上限；超出时不得调用 persistence.save。 */
  maxSnapshotBytes: 4 * 1024 * 1024,
  /** 事件历史的字节预算（条数预算见 maxEventHistory，两者同时生效）。 */
  maxEventHistoryBytes: 2 * 1024 * 1024,
  /** 事件历史条数上限：保留既有 1000 条契约不变。 */
  maxEventHistory: 1000,
  /** 单个 manager 内并发登记的父任务数上限。 */
  maxTasks: 64,
  /** 单个父任务的 shard 数上限。 */
  maxShardsPerTask: 64,
  /** 单 shard 的 attempt 数上限；retry 超限返回结构化失败且不新建 attempt。 */
  maxAttemptsPerShard: 8,
  /** 聚合反馈注入文本上限（既有 120000 字符契约的字节化表达）。 */
  maxFeedbackBytes: 256 * 1024,
});


/**
 * 代表样本的测量值（UTF-8 字节）。
 *
 * 口径：固定 fixture，不含随机数与机器相关信息；值为 JSON 序列化后的字节数
 * （与 storage / RPC / 快照一致）。重测方式：
 *   node --test test/resource-budget.test.mjs
 * 其中"测量依据可复现"用例会用同一 fixture 重新测量并逐字节比对。
 */
export const RESOURCE_BUDGET_BASELINE = Object.freeze({
  /** 典型父任务目标（3 行中文，329B）+ 典型 shard 正文（127B）。 */
  maxTaskInputBytes: 329 + 127,
  /** 典型 5 行专家最终报告（265B）。 */
  sampleResultBytes: 265,
  maxAttemptResultBytes: 265,
  /** 带 25 帧 stack 的错误（1898B）。 */
  maxAttemptErrorBytes: 1898,
  /** 单条带 result 的 shard_status_changed 事件（554B）。 */
  maxEventBytes: 554,
  /** 1 个 4-shard 任务 + 40 条事件的快照（26385B）。 */
  maxSnapshotBytes: 26385,
  /** 1000 条代表性事件（平均 555B/条）的字节量。 */
  maxEventHistoryBytes: 555 * 1000,
  /**
   * 多任务满额 fixture（maxTasks 个已完成任务 × 4 shard × 代表性 result
   * + 恰好 1000 条代表性事件）的固定测量值。它是"业务满载"下的上界依据：
   * 4 MiB 预算相对它有 5.2x 余量，因此常量保持 4 MiB 不变。
   */
  multiTaskSnapshotBytes: 799745,
  /**
   * 满额事件历史 fixture（1 个 4-shard 任务 + 恰好 1000 条代表性事件的完整快照）
   * 的固定测量值。它是 maxSnapshotBytes 的真正下界依据：恢复时必须能装下整个
   * 允许保留的事件历史，否则"合法的满额历史"永远无法落盘。
   */
  fullEventHistorySnapshotBytes: 569074,
  /** 该 fixture 使用的固定文本（测试用同一份重建快照并逐字节比对）。 */
  sampleBasePrompt: [
    "实现任务书第 11「建立 fan-out 与 RPC 数据资源预算」。",
    "范围：resource-budget.js（可新增）、fanout.js、fanout-host.js、index.js、package.json。",
    "要求：先测量再冻结常量；prompt 超限必须结构化拒绝；result/error/snapshot 超限必须显式失败或返回 complete=false 元数据。",
  ].join("\n"),
  sampleShardPrompt: "只处理 shard a1：读取 host/fanout-runtime.js 中 restore() 的 ownership 释放分支，给出修复方案并补测试。",
  sampleResultText: [
    "任务结果：已修复。",
    "关键修改：restore 保持 ownership；终态释放。",
    "变更文件：host/fanout-runtime.js、test/host-fanout-runtime.test.mjs。",
    "验证：node --test 76/76，pnpm test 598/598。",
    "残余风险：无。",
  ].join("\n"),
});


/** 单个资源名的可读标签，用于诊断文案。 */
const RESOURCE_LABELS = Object.freeze({
  task_input: "任务输入（basePrompt + shard prompt）",
  attempt_result: "shard attempt 结果",
  attempt_error: "shard attempt 错误",
  event: "单条 fan-out 事件",
  snapshot: "fan-out 快照",
  event_history: "事件历史",
  tasks: "父任务数量",
  shards: "父任务 shard 数量",
  attempts: "shard attempt 数量",
  feedback: "父会话聚合反馈",
});


/**
 * 测量任意值的 UTF-8 字节数。
 *
 * - string：按 UTF-8 计字节（中文 3 字节/字符、emoji 4 字节/字符）；
 * - undefined：0（与 cloneJson 语义一致，该字段不会出现在 JSON 中）；
 * - 其它值：按 JSON 序列化计字节；循环引用等不可序列化值返回 null 表示"无法测量"。
 *
 * @param {*} value
 * @returns {number|null} 字节数；null 表示无法测量。
 */
export function measureUtf8Bytes(value) {
  if (value === undefined) return 0;
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  return measureJsonBytes(value);
}

/**
 * 测量 JSON 序列化后的 UTF-8 字节数。
 * @param {*} value
 * @returns {number|null} 字节数；null 表示不可序列化（如循环引用）。
 */
export function measureJsonBytes(value) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    return null;
  }
  if (serialized === undefined) return 0;
  return Buffer.byteLength(serialized, "utf8");
}

/**
 * 数量/字节是否超限。
 *
 * 数值：严格大于上限才算超限（等于上限是允许的）。
 * null：表示"无法测量"（JSON.stringify 抛错，如循环引用/BigInt/抛错 getter）。
 * 这类值绝不能当作"未知体积所以放过"——它们会在 persistence / cloneJson /
 * RPC 序列化路径上抛出未处理异常，必须显式拒绝。
 */
function exceedsBudget(receivedBytes, limit) {
  if (receivedBytes === null) return true;
  return Number.isSafeInteger(receivedBytes) && receivedBytes > limit;
}


/**
 * 结构化违规描述：可直接进入事件、快照与 RPC 响应。
 *
 * @param {object} input
 * @param {string} input.resource - 资源名（见 RESOURCE_LABELS）。
 * @param {number} input.limit - 上限（字节或数量）。
 * @param {number} [input.receivedBytes] - 实测体积/数量；未知记 null。
 * @param {boolean} [input.complete] - 数据是否完整（违规一律 false）。
 * @param {boolean} [input.recoverable] - 完整内容是否仍可从其它权威来源获取。
 * @param {string} [input.subject] - 违规主体（如 shardId / parentTaskId）。
 * @param {string} [input.hint] - 可执行的后续动作提示。
 * @returns {object} 冻结的违规描述（JSON 可往返）。
 */
export function describeBudgetViolation({ resource, limit, receivedBytes, measured, complete = false, recoverable = false, subject, hint } = {}) {
  const label = RESOURCE_LABELS[resource] ?? String(resource ?? "resource");
  const size = Number.isSafeInteger(receivedBytes) ? receivedBytes : null;
  // measured=false 且 size=null：体积无法测量（不可 JSON 序列化），语义与"超限"不同，
  // 必须让调用方与用户都能区分。
  const unmeasurable = measured === false || (measured !== true && size === null);
  const message = unmeasurable
    ? "超出预算: " + label + " 无法测量（不可 JSON 序列化）> 上限 " + String(limit) + "（resource=" + String(resource) + "）"
    : "超出预算: " + label + " 实测 " + (size === null ? "未知" : String(size))
      + " > 上限 " + String(limit) + "（resource=" + String(resource) + "）";
  return Object.freeze({
    code: BUDGET_EXCEEDED_CODE,
    resource: String(resource ?? "resource"),
    label,
    limit,
    maxBytes: limit,
    receivedBytes: size,
    ...(unmeasurable ? { unmeasurable: true } : {}),
    complete: complete === true,
    recoverable: recoverable === true,
    subject: subject === undefined || subject === null ? null : String(subject),
    message,
    ...(typeof hint === "string" && hint.length > 0 ? { hint } : {}),
  });
}


/**
 * 预算拒绝错误。字段与 describeBudgetViolation 一致，violation 保留完整描述，
 * 便于把同一份元数据同时放进错误、事件与快照。
 */
export class BudgetExceededError extends Error {
  constructor(options = {}) {
    const violation = describeBudgetViolation(options);
    super(violation.message);
    this.name = "BudgetExceededError";
    this.code = violation.code;
    this.resource = violation.resource;
    this.limit = violation.limit;
    this.maxBytes = violation.maxBytes;
    this.receivedBytes = violation.receivedBytes;
    this.complete = violation.complete;
    this.recoverable = violation.recoverable;
    this.subject = violation.subject;
    if (violation.hint !== undefined) this.hint = violation.hint;
    this.violation = violation;
  }
}

/**
 * 判定一次测量是否超限，返回统一判定结果（ok=false 时带 violation）。
 *
 * @param {{resource:string, limit:number, receivedBytes:number|null, complete?:boolean,
 *   recoverable?:boolean, subject?:string, hint?:string}} input
 * @returns {{ok:boolean, violation?:object}}
 */
export function checkBudget(input = {}) {
  const { resource, limit, receivedBytes } = input;
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new TypeError("checkBudget 需要正整数的 limit");
  }
  if (!exceedsBudget(receivedBytes, limit)) return { ok: true };
  return {
    ok: false,
    violation: describeBudgetViolation({
      ...input,
      complete: false,
      // 保留"不可测量而非超限"的判定依据（measured:false 覆盖 receivedBytes 推断）。
      ...(receivedBytes === null ? { measured: false } : {}),
    }),
  };
}


/**
 * 校验任务输入（basePrompt + 单个 shard prompt）是否在预算内。
 * 输入超限必须显式拒绝：不能截断后继续执行，否则专家会基于不完整的目标工作。
 *
 * @param {object} input - { basePrompt, shardPrompt, subject }
 * @returns {{ok:boolean, receivedBytes:number|null, violation?:object}}
 */
export function checkTaskInputBudget({ basePrompt, shardPrompt, subject } = {}) {
  const baseBytes = measureUtf8Bytes(basePrompt);
  const shardBytes = measureUtf8Bytes(shardPrompt);
  const receivedBytes = baseBytes === null || shardBytes === null ? null : baseBytes + shardBytes;
  const verdict = checkBudget({
    resource: "task_input",
    limit: FANOUT_BUDGET.maxTaskInputBytes,
    receivedBytes,
    recoverable: true,
    subject,
    hint: "缩小 basePrompt / shard prompt，或把大段材料放进专家可自行读取的文件",
  });
  return { ...verdict, receivedBytes };
}

/**
 * 校验单次 attempt 的 result / error 体积。
 *
 * 两者都必须显式判定：超限时调用方把 shard 收敛为 failed 终态并携带本描述
 * （complete=false + receivedBytes/maxBytes），不得写入被截断的"完整结果"。
 * 不可 JSON 序列化的 result/error（循环引用、BigInt、抛错 getter）返回
 * receivedBytes=null 且同样判为违规：它们会在 cloneJson/persistence 路径抛异常。
 *
 * @param {object} input - { result, error, subject }
 * @returns {{ok:boolean, resultBytes:number|null, errorBytes:number|null, violation?:object}}
 */
export function checkAttemptPayloadBudget({ result, error, subject } = {}) {
  const resultBytes = result === undefined ? 0 : measureJsonBytes(result);
  const errorBytes = error === undefined ? 0 : measureJsonBytes(error);
  const resultVerdict = checkBudget({
    resource: "attempt_result",
    limit: FANOUT_BUDGET.maxAttemptResultBytes,
    receivedBytes: resultBytes,
    subject,
    // 结果超限是"可恢复"的：完整输出仍留在 child 会话历史里，主代理可自行读取。
    recoverable: true,
    hint: "结果过大时请让专家把完整内容写入文件，只在最终报告里给出路径与摘要",
  });
  if (!resultVerdict.ok) return { ...resultVerdict, resultBytes, errorBytes };
  const errorVerdict = checkBudget({
    resource: "attempt_error",
    limit: FANOUT_BUDGET.maxAttemptErrorBytes,
    receivedBytes: errorBytes,
    subject,
  });
  return { ...errorVerdict, resultBytes, errorBytes };
}

/**
 * 校验单条事件的体积（不含 sequence/at 之前的原始负载）。
 * @param {object} event
 * @param {{subject?:string}} [options]
 */
export function checkEventBudget(event, { subject } = {}) {
  return checkBudget({
    resource: "event",
    limit: FANOUT_BUDGET.maxEventBytes,
    receivedBytes: measureJsonBytes(event),
    subject,
  });
}

/**
 * 校验可持久化快照的体积。
 * @param {object} snapshot
 * @param {{maxBytes?:number}} [limits] - 上限覆盖（组合根/测试可收紧）。
 */
export function checkSnapshotBudget(snapshot, limits = {}) {
  return checkBudget({
    resource: "snapshot",
    limit: Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0
      ? limits.maxBytes
      : FANOUT_BUDGET.maxSnapshotBytes,
    receivedBytes: measureJsonBytes(snapshot),
    recoverable: false,
    hint: "快照过大时先让未终态 work 收敛，或清理已结算的历史任务",
  });
}


/**
 * 恢复预算：对来自持久化的外部快照做整体判定。
 *
 * 恢复输入不受本进程控制（磁盘/其它版本/被篡改），因此必须在**任何状态修改与大
 * 规模 clone 之前**判定：结构规模（task/shard/attempt 数）、总字节、事件历史条数与
 * 字节。任何一项超限都返回 ok=false，由调用方原子失败（不写入 tasks/eventHistory）。
 *
 * 与 checkEventHistoryBudget 的区别：后者用于运行时"裁剪最旧事件"，本函数用于
 * "恢复输入是否可接受"——超限即拒绝，不静默丢弃历史。
 *
 * @param {object} snapshot - 待恢复快照。
 * @param {{existingTasks?:number, maxBytes?:number}} [options]
 *   existingTasks：merge 恢复时已有的 task 数（计入总量上限）。
 * @returns {{ok:boolean, tasks:number, shards:number, attempts:number, events:number,
 *   eventBytes:number, snapshotBytes:number|null, violation?:object}}
 */
export function checkRestoreBudget(snapshot, options = {}) {
  const tasks = Array.isArray(snapshot?.tasks) ? snapshot.tasks : [];
  const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
  const existingTasks = Number.isSafeInteger(options.existingTasks) && options.existingTasks > 0
    ? options.existingTasks
    : 0;
  const snapshotBytes = measureJsonBytes(snapshot);
  const eventBytes = events.reduce((total, event) => total + (measureJsonBytes(event) ?? 0), 0);
  let shardCount = 0;
  let attemptCount = 0;
  for (const task of tasks) {
    const shards = Array.isArray(task?.shards) ? task.shards : [];
    shardCount += shards.length;
    for (const shard of shards) {
      attemptCount += Array.isArray(shard?.attempts) ? shard.attempts.length : 0;
    }
  }
  const summary = {
    ok: true,
    tasks: tasks.length,
    shards: shardCount,
    attempts: attemptCount,
    events: events.length,
    eventBytes,
    snapshotBytes,
  };

  // 快照整体字节（含所有事件与任务负载）。null = 不可序列化，必须拒绝。
  const sizeVerdict = checkBudget({
    resource: "snapshot",
    limit: Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : FANOUT_BUDGET.maxSnapshotBytes,
    receivedBytes: snapshotBytes,
    recoverable: false,
    subject: "restore",
    hint: "快照过大时先让未终态 work 收敛，或清理已结算的历史任务",
  });
  if (!sizeVerdict.ok) return { ...summary, ok: false, violation: sizeVerdict.violation };

  // task 数：默认（非 merge）恢复会整体替换，因此按快照自身计数；merge 时累加现有量。
  const taskVerdict = checkBudget({
    resource: "tasks",
    limit: FANOUT_BUDGET.maxTasks,
    receivedBytes: tasks.length + existingTasks,
    recoverable: false,
    subject: "restore",
    hint: "快照中的父任务数超过上限，请清理已结算的历史任务",
  });
  if (!taskVerdict.ok) return { ...summary, ok: false, violation: taskVerdict.violation };

  for (const task of tasks) {
    const shards = Array.isArray(task?.shards) ? task.shards : [];
    const shardVerdict = checkBudget({
      resource: "shards",
      limit: FANOUT_BUDGET.maxShardsPerTask,
      receivedBytes: shards.length,
      recoverable: false,
      subject: task?.parentTaskId,
      hint: "单个父任务的 shard 数超过上限",
    });
    if (!shardVerdict.ok) return { ...summary, ok: false, violation: shardVerdict.violation };
    for (const shard of shards) {
      const attempts = Array.isArray(shard?.attempts) ? shard.attempts : [];
      const attemptVerdict = checkBudget({
        resource: "attempts",
        limit: FANOUT_BUDGET.maxAttemptsPerShard,
        receivedBytes: attempts.length,
        recoverable: false,
        subject: (task?.parentTaskId ?? "") + "/" + (shard?.shardId ?? ""),
        hint: "快照中的 attempt 数超过上限",
      });
      if (!attemptVerdict.ok) return { ...summary, ok: false, violation: attemptVerdict.violation };
    }
  }

  // 事件历史：条数与字节都必须可恢复。超限即拒绝，不做静默丢弃。
  const eventVerdict = checkBudget({
    resource: "event_history",
    limit: FANOUT_BUDGET.maxEventHistoryBytes,
    receivedBytes: eventBytes,
    recoverable: false,
    subject: "restore",
    hint: "快照中的事件历史超出字节预算",
  });
  if (!eventVerdict.ok) return { ...summary, ok: false, violation: eventVerdict.violation };
  const eventCountVerdict = checkBudget({
    resource: "event_history",
    limit: FANOUT_BUDGET.maxEventHistory,
    receivedBytes: events.length,
    recoverable: false,
    subject: "restore",
    hint: "快照中的事件条数超出上限",
  });
  if (!eventCountVerdict.ok) return { ...summary, ok: false, violation: eventCountVerdict.violation };

  return summary;
}

/**
 * 按 UTF-8 字节预算截断聚合反馈文本。
 *
 * 既有契约（120000 字符上限 + "完整结果可按 parentTaskId 查询"）必须保留，但字符数
 * 不等于字节数：中文/emoji 会显著超出字节预算。因此这里以字节为准截断，并在结果里
 * 明确给出 complete=false 与可定位的元数据；hint 里始终保留 parentTaskId，
 * 保证主代理仍能查到完整快照。
 *
 * @param {{parentTaskId?:string, text:string}} input
 * @param {{maxBytes?:number}} [limits]
 * @returns {{text:string, bytes:number, receivedBytes:number, maxBytes:number,
 *   complete:boolean, recoverable:boolean, truncated:boolean}}
 */
export function truncateFeedbackText({ parentTaskId, text } = {}, limits = {}) {
  const maxBytes = Number.isSafeInteger(limits.maxBytes) && limits.maxBytes > 0
    ? limits.maxBytes
    : FANOUT_BUDGET.maxFeedbackBytes;
  const source = typeof text === "string" ? text : "";
  const receivedBytes = Buffer.byteLength(source, "utf8");
  const hint = "\n[结果已截断，请按 parentTaskId 查询完整快照]" + (typeof parentTaskId === "string" && parentTaskId.length > 0 ? "：" + parentTaskId : "：");
  if (receivedBytes + Buffer.byteLength(hint, "utf8") <= maxBytes) {
    return {
      text: source + (receivedBytes === 0 ? "" : ""),
      bytes: receivedBytes,
      receivedBytes,
      maxBytes,
      complete: true,
      recoverable: true,
      truncated: false,
    };
  }
  const hintBytes = Buffer.byteLength(hint, "utf8");
  const budget = Math.max(maxBytes - hintBytes, 0);
  // 用 Buffer 解码保证落在字符边界上（不会把一个多字节字符切成半个）。
  const truncatedText = Buffer.from(source, "utf8").subarray(0, budget).toString("utf8").replace(/\uFFFD+$/u, "");
  return {
    text: truncatedText + hint,
    bytes: Buffer.byteLength(truncatedText + hint, "utf8"),
    receivedBytes,
    maxBytes,
    complete: false,
    recoverable: true,
    truncated: true,
  };
}

/**
 * 校验事件历史（条数 + 字节）并给出需要丢弃的最旧事件数。
 *
 * @param {object[]} events
 * @param {{maxCount?:number, maxBytes?:number}} [limits]
 * @returns {{count:number, bytes:number, droppedCount:number, droppedBytes:number, violation:object|null}}
 */
export function checkEventHistoryBudget(events, limits = {}) {
  const list = Array.isArray(events) ? events : [];
  const maxCount = Number.isSafeInteger(limits.maxCount) ? limits.maxCount : FANOUT_BUDGET.maxEventHistory;
  const maxBytes = Number.isSafeInteger(limits.maxBytes) ? limits.maxBytes : FANOUT_BUDGET.maxEventHistoryBytes;
  const sizes = list.map((event) => measureJsonBytes(event) ?? 0);
  const bytes = sizes.reduce((total, size) => total + size, 0);
  let keep = list.length;
  let droppedCount = 0;
  let droppedBytes = 0;
  // 先按条数裁剪，再按字节裁剪；两条预算同时生效。
  while (keep > maxCount) {
    keep -= 1;
    droppedBytes += sizes[droppedCount];
    droppedCount += 1;
  }
  let remainingBytes = bytes - droppedBytes;
  let cursor = droppedCount;
  while (remainingBytes > maxBytes && cursor < list.length) {
    remainingBytes -= sizes[cursor];
    droppedBytes += sizes[cursor];
    cursor += 1;
    keep -= 1;
  }
  const trimmed = droppedCount > 0;
  const violation = trimmed
    ? describeBudgetViolation({
      resource: "event_history",
      limit: maxBytes,
      receivedBytes: bytes,
      recoverable: false,
      subject: "event_history",
      hint: "事件历史已按条数/字节预算裁剪最旧记录",
    })
    : null;
  return { count: Math.max(keep, 0), bytes, droppedCount, droppedBytes, violation };
}
