/**
 * 入口手动派发与模板计划的纯规划域（R4e · 票据 19）。
 *
 * 设计边界（与规格书 §6 一致）：
 * - 只服务 **RPC 入口**，不复制任何派发逻辑：单专家 / fan-out / 模板派发最终都走
 *   与 fanout 工具完全相同的 submitFanoutTask → manager.submit 路径，因此 admission、
 *   affectedPaths 冲突、角色/provider 并发、wait ledger 与目标交接天然同源；
 * - 校验与预算阈值**零复制**：结构/预算/超时/并发全部委托 manager 的
 *   validateSubmitInput，outputSchema 用与 submitFanoutTask 同一个
 *   normalizeOutputSchemaDeclaration 预校验；
 * - 模板只保存派发参数，不保存模型凭据/密钥/临时绝对路径；模板内容是**不可信输入**，
 *   每次派发都重新做结构与权限校验（角色可能已被删除/禁用）。
 *
 * 本模块只做**纯规划与扫描**：没有 I/O、没有注册、没有可变模块状态。
 * 实际提交在 host/index-manual-dispatch.js，模板持久化在 host/index-template-store.js。
 *
 * ## 铁律（票据 19）
 * 不接收 ctx、不注册、不持容器；失败回执形状（status/code/message/details）与
 * 迁移前逐字段一致，调用方按同一 code 词表处理。
 *
 * @module dsh-expert-group/host/index-template-plan
 */
import { utf8ByteLength, OUTPUT_SCHEMA_ERROR_CODES } from "../shared/structured.js";
import { FANOUT_BUDGET } from "../resource-budget.js";

/**
 * 创建手动派发/模板规划能力面。
 *
 * @param {object} deps - 窄能力面（3 组）。
 * @param {object} deps.roles - 角色目录面：`isActiveRole(role)`（只允许已启用角色）。
 * @param {object} deps.core - 专家核心域：`normalizeOutputSchemaDeclaration(schema, label)`。
 * @param {object} deps.submission - fan-out 提交校验：`validateSubmitInput(input)`。
 * @returns {object} 规划/失败构造/摘要投影能力面。
 */
export function createFanoutTemplatePlanner({ roles, core, submission }) {
  /** 单专家派发在 manager 内的固定分片 id（内部实现细节，不是用户输入）。 */
  const MANUAL_DISPATCH_SINGLE_SHARD_ID = "single";
  /**
   * 单专家派发的分片执行说明。
   *
   * manager 要求每个分片都有非空 prompt；单专家模式下用户目标放在 basePrompt，
   * 分片本身只需要一条固定的执行说明。这样回执/侧栏仍显示“一个分片”，且不会
   * 把同一段目标重复两遍（重复只会浪费 task_input 预算）。
   */
  const MANUAL_DISPATCH_SINGLE_SHARD_PROMPT = "按公共目标完成本次任务，并返回完整最终结果。";
  /** 模板库整份文档的序列化上限（UTF-8 字节）：32 个模板的合理上界。 */
  const FANOUT_TEMPLATE_MAX_BYTES = 1024 * 1024;
  /** 模板名称上限：120 个码点且 ≤512 UTF-8 字节（与分片名称同一个“短标签”口径）。 */
  const FANOUT_TEMPLATE_NAME_MAX_CHARS = 120;
  const FANOUT_TEMPLATE_NAME_MAX_BYTES = 512;
  /** 列表摘要里 prompt 预览的码点上限：摘要有界，不返回模板正文全文。 */
  const FANOUT_TEMPLATE_PREVIEW_CHARS = 160;
  /**
   * 模板内容里的“明显凭据”模式。
   *
   * 这是**保守拒绝**而不是完备的密钥扫描：模板是会被反复重放的持久化输入，宁可
   * 误拒一个正常文本，也不要把 sk-/Bearer/私钥/显式 password= 之类写进 domain。
   * 错误回执只给字段名与固定类别，绝不回显命中的原文。
   */
  const FANOUT_TEMPLATE_CREDENTIAL_PATTERNS = Object.freeze([
    { kind: "private_key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i },
    { kind: "bearer_token", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
    { kind: "sk_token", pattern: /\bsk-[A-Za-z0-9_-]{8,}/ },
    { kind: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
    {
      kind: "credential_assignment",
      pattern: /\b(?:api[_-]?key|access[_-]?key|secret(?:[_-]?key)?|password|passwd|auth[_-]?token|access[_-]?token)\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{8,}/i,
    },
  ]);

  /**
   * 构造一个手动派发/模板 RPC 的结构化失败结果。
   *
   * 与 fanout 工具的抛错路径分开是刻意的：RPC 的失败必须带稳定 code/status，
   * 客户端据此区分“参数错 / 角色不可用 / 模板不存在 / 存储失败”，而不是解析文案。
   */
  function manualDispatchFailure(status, code, message, details) {
    return {
      ok: false,
      status,
      code,
      message,
      ...(details === undefined ? {} : { details }),
    };
  }

  /** 把 manager / validateSubmitInput 的判定结果翻译成 RPC 失败（复用同一 code 词表）。 */
  function manualDispatchVerdictFailure(verdict) {
    return manualDispatchFailure(
      400,
      typeof verdict?.code === "string" && verdict.code.length > 0 ? verdict.code : "INVALID_FANOUT",
      typeof verdict?.message === "string" && verdict.message.length > 0 ? verdict.message : "fan-out 参数不合法",
      {
        ...(typeof verdict?.field === "string" ? { field: verdict.field } : {}),
        ...(verdict?.violation !== undefined ? { violation: verdict.violation } : {}),
        ...(verdict?.conflict !== undefined ? { conflict: verdict.conflict } : {}),
      },
    );
  }

  /** 结构化声明的失败（schema 非法/超限/provider 不支持）：只回传稳定 code 与有界元数据。 */
  function manualDispatchSchemaFailure(error) {
    return manualDispatchFailure(
      400,
      typeof error?.code === "string" && error.code.length > 0 ? error.code : OUTPUT_SCHEMA_ERROR_CODES.INVALID,
      typeof error?.message === "string" ? error.message : "outputSchema 不合法",
      error?.details !== null && typeof error?.details === "object" && !Array.isArray(error.details)
        ? { ...error.details }
        : undefined,
    );
  }

  /**
   * 校验并归一一次手动派发的入参（不产生任何副作用）。
   *
   * 结构/预算/超时/并发全部委托给 manager 的 validateSubmitInput：这是与工具派发
   * 同一份校验实现，绝不在 RPC 层复制一套阈值。outputSchema 不归 manager 管，
   * 因此这里用与 submitFanoutTask 同一个 normalizeOutputSchemaDeclaration 预校验，
   * 避免“模型预检跑完才发现 schema 非法”。
   *
   * @param {object} input - RPC body 或模板重建出的派发入参。
   * @returns {object} 成功时 {ok:true, mode, role, args}；失败时 manualDispatchFailure 形状。
   */
  function buildManualDispatchPlan(input) {
    const raw = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
    const mode = raw.mode === "single" || raw.mode === "fanout" ? raw.mode : "";
    if (mode.length === 0) {
      return manualDispatchFailure(400, "invalid-mode", "mode 必须是 single 或 fanout", { field: "mode" });
    }
    const role = typeof raw.role === "string" ? raw.role.trim() : "";
    if (role.length === 0) return manualDispatchFailure(400, "invalid-role", "缺少 role", { field: "role" });
    // 角色必须当前启用（内置 + 显式启用的可选角色）：手动派发不得
    // 绕过角色目录，也不能给未启用的角色创建 child。
    if (!roles.isActiveRole(role)) {
      return manualDispatchFailure(400, "invalid-role", "未启用的角色: " + role, { field: "role" });
    }

    let basePrompt;
    let rawShards;
    if (mode === "single") {
      // single 的对外语义就是“恰好一个分片”：shards 属于 fanout 形态的参数，
      // 混用会让“用户以为传了两片、实际只跑一片”成为静默丢输入，因此显式拒绝。
      if (Array.isArray(raw.shards) && raw.shards.length > 0) {
        return manualDispatchFailure(
          400,
          "INVALID_SHARDS",
          "single 模式必须恰好一个分片：请用 prompt 提供任务，不要传 shards",
          { field: "shards" },
        );
      }
      const prompt = typeof raw.prompt === "string" ? raw.prompt : "";
      if (prompt.trim().length === 0) {
        return manualDispatchFailure(400, "INVALID_PROMPT", "single 模式需要非空 prompt", { field: "prompt" });
      }
      basePrompt = prompt;
      rawShards = [{ shardId: MANUAL_DISPATCH_SINGLE_SHARD_ID, prompt: MANUAL_DISPATCH_SINGLE_SHARD_PROMPT }];
    } else {
      basePrompt = typeof raw.basePrompt === "string" ? raw.basePrompt : "";
      if (basePrompt.trim().length === 0) {
        return manualDispatchFailure(400, "INVALID_BASE_PROMPT", "fanout 模式需要非空 basePrompt", { field: "basePrompt" });
      }
      if (!Array.isArray(raw.shards) || raw.shards.length === 0) {
        return manualDispatchFailure(400, "INVALID_SHARDS", "fanout 模式需要非空 shards", { field: "shards" });
      }
      rawShards = raw.shards;
    }

    const verdict = submission.validateSubmitInput({
      role,
      basePrompt,
      shards: rawShards,
      allowOverlap: raw.allowOverlap,
      timeoutMs: raw.timeoutMs,
      concurrencyLimit: raw.concurrencyLimit,
      requestId: raw.requestId,
    });
    if (!verdict.ok) return manualDispatchVerdictFailure(verdict);

    const schemas = new Map();
    try {
      for (let index = 0; index < verdict.shards.length; index += 1) {
        const declaration = core.normalizeOutputSchemaDeclaration(
          rawShards[index]?.outputSchema,
          "分片 " + verdict.shards[index].shardId,
        );
        if (declaration !== undefined) schemas.set(verdict.shards[index].shardId, declaration.schema);
      }
    } catch (error) {
      if (error?.name === "OutputSchemaError") return manualDispatchSchemaFailure(error);
      throw error;
    }

    // manager 的 validateSubmitInput 会丢弃未知字段（含 outputSchema）；这里把已校验
    // 的 schema 合并回归一后的分片，submitFanoutTask 才能在提交时看到完整声明。
    const shards = verdict.shards.map((shard) => (
      schemas.has(shard.shardId) ? { ...shard, outputSchema: schemas.get(shard.shardId) } : shard
    ));
    const args = { role, basePrompt, shards, allowOverlap: verdict.allowOverlap === true };
    if (verdict.timeoutMs !== undefined) args.timeoutMs = verdict.timeoutMs;
    if (verdict.concurrencyLimit !== undefined) args.concurrencyLimit = verdict.concurrencyLimit;
    if (verdict.requestId !== undefined) args.requestId = verdict.requestId;
    return { ok: true, mode, role, basePrompt, args };
  }

  /**
   * 扫描模板文本里的明显凭据。
   *
   * @param {string} text - 待检查文本。
   * @param {string} field - 出错时的字段路径（不含原文）。
   * @param {object[]} findings - 收集结果（按扫描顺序，取第一条回执）。
   */
  function scanTemplateCredentialText(text, field, findings) {
    if (typeof text !== "string" || text.length === 0) return;
    for (const entry of FANOUT_TEMPLATE_CREDENTIAL_PATTERNS) {
      if (entry.pattern.test(text)) {
        findings.push({ field, kind: entry.kind });
        return;
      }
    }
  }

  /** 判断一个 affectedPath 是否是明显的临时绝对路径（模板不得固化这类路径）。 */
  function isEphemeralTemplatePath(value) {
    if (typeof value !== "string" || value.length === 0) return false;
    if (/%(?:TEMP|TMP)%/i.test(value)) return true;
    const absolute = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/u.test(value);
    if (!absolute) return false;
    return /(?:^|[\\/])(?:Temp|tmp|var[\\/]folders)(?:[\\/]|$)/i.test(value);
  }

  /**
   * 校验一段“模板保存/模板派发”输入并归一成可持久化模板。
   *
   * 两种模板形态与规格书 §6 的字段一致：
   * - 单专家模板：只保存 prompt（prompt 或 basePrompt 二选一），派发时转成单分片；
   * - fan-out 模板：保存 basePrompt + shards（每个分片可有名称/影响范围/超时/schema）。
   *
   * 保存与派发共用本函数：模板内容不可信，派发时必须按**当前**角色目录与预算重算。
   *
   * @param {object} input - name/role/prompt|basePrompt/shards/...。
   * @returns {object} {ok:true, template, plan} 或 manualDispatchFailure。
   */
  function buildFanoutTemplatePlan(input) {
    const raw = input !== null && typeof input === "object" && !Array.isArray(input) ? input : {};
    const name = typeof raw.name === "string" ? raw.name.trim() : "";
    if (name.length === 0) {
      return manualDispatchFailure(400, "invalid-template", "模板 name 必须是非空字符串", { field: "name" });
    }
    if ([...name].length > FANOUT_TEMPLATE_NAME_MAX_CHARS || utf8ByteLength(name) > FANOUT_TEMPLATE_NAME_MAX_BYTES) {
      return manualDispatchFailure(
        400,
        "invalid-template",
        "模板 name 超出上限（最多 " + FANOUT_TEMPLATE_NAME_MAX_CHARS + " 个字符 / " + FANOUT_TEMPLATE_NAME_MAX_BYTES + " 字节）",
        { field: "name" },
      );
    }
    // 控制字符会破坏侧栏/日志的单行展示，保存前直接拒绝而不是静默清洗。
    if (/[\u0000-\u001f\u007f]/u.test(name)) {
      return manualDispatchFailure(400, "invalid-template", "模板 name 不能包含控制字符", { field: "name" });
    }
    const role = typeof raw.role === "string" ? raw.role.trim() : "";
    if (role.length === 0) {
      return manualDispatchFailure(400, "invalid-role", "模板缺少 role", { field: "role" });
    }
    if (!roles.isActiveRole(role)) {
      return manualDispatchFailure(400, "invalid-role", "未启用的角色: " + role, { field: "role" });
    }

    const hasShards = Array.isArray(raw.shards) && raw.shards.length > 0;
    if (Array.isArray(raw.shards) && raw.shards.length === 0) {
      return manualDispatchFailure(400, "invalid-template", "模板 shards 不能是空数组", { field: "shards" });
    }
    const hasPrompt = typeof raw.prompt === "string" && raw.prompt.trim().length > 0;
    const hasBasePrompt = typeof raw.basePrompt === "string" && raw.basePrompt.trim().length > 0;

    // 规格书的字段写作「basePrompt 或 prompt」：两者都是公共目标的同义输入。
    // - fan-out 模板：公共目标 + shards，统一存为 basePrompt；
    // - 单专家模板：只有公共目标，统一存为 prompt。
    // 同时给出两个名字视为歧义（无法判断用户想保留哪个），显式拒绝而不是猜。
    if (hasPrompt && hasBasePrompt) {
      return manualDispatchFailure(
        400,
        "invalid-template",
        "模板的 prompt 与 basePrompt 只能提供一个",
        { field: "prompt" },
      );
    }
    let mode;
    let singlePrompt;
    let basePrompt;
    let dispatchShards;
    if (hasShards) {
      mode = "fanout";
      basePrompt = hasBasePrompt ? raw.basePrompt : raw.prompt;
      if (typeof basePrompt !== "string" || basePrompt.trim().length === 0) {
        return manualDispatchFailure(400, "invalid-template", "fan-out 模板需要非空 basePrompt 或 prompt", { field: "basePrompt" });
      }
      dispatchShards = raw.shards;
    } else {
      singlePrompt = hasPrompt ? raw.prompt : (hasBasePrompt ? raw.basePrompt : "");
      if (typeof singlePrompt !== "string" || singlePrompt.trim().length === 0) {
        return manualDispatchFailure(400, "invalid-template", "单专家模板需要非空 prompt", { field: "prompt" });
      }
      mode = "single";
    }

    // 结构/预算/超时/并发/ schema 全部复用与真实派发同一个 plan builder。
    const plan = buildManualDispatchPlan({
      mode,
      role,
      ...(mode === "single" ? { prompt: singlePrompt } : { basePrompt, shards: dispatchShards }),
      allowOverlap: raw.allowOverlap,
      timeoutMs: raw.timeoutMs,
      concurrencyLimit: raw.concurrencyLimit,
    });
    if (plan.ok !== true) return plan;

    // 凭据/临时路径扫描：只回传字段名与固定类别，绝不回显命中的原文。
    const findings = [];
    scanTemplateCredentialText(name, "name", findings);
    if (mode === "single") {
      scanTemplateCredentialText(singlePrompt, "prompt", findings);
    } else {
      scanTemplateCredentialText(basePrompt, "basePrompt", findings);
      for (let index = 0; index < plan.args.shards.length; index += 1) {
        const shard = plan.args.shards[index];
        scanTemplateCredentialText(shard.prompt, "shards[" + index + "].prompt", findings);
        scanTemplateCredentialText(shard.name, "shards[" + index + "].name", findings);
        for (let pathIndex = 0; pathIndex < (shard.affectedPaths?.length ?? 0); pathIndex += 1) {
          const path = shard.affectedPaths[pathIndex];
          scanTemplateCredentialText(path, "shards[" + index + "].affectedPaths[" + pathIndex + "]", findings);
          if (findings.length === 0 && isEphemeralTemplatePath(path)) {
            return manualDispatchFailure(
              400,
              "ephemeral-path-rejected",
              "模板不能保存临时绝对路径：shards[" + index + "].affectedPaths[" + pathIndex + "]",
              { field: "shards[" + index + "].affectedPaths[" + pathIndex + "]" },
            );
          }
        }
      }
    }
    if (findings.length > 0) {
      return manualDispatchFailure(
        400,
        "credential-rejected",
        "模板包含疑似凭据或密钥（" + findings[0].field + "），已拒绝保存",
        { field: findings[0].field, kind: findings[0].kind },
      );
    }

    const template = {
      name,
      role,
      ...(mode === "single"
        ? { prompt: singlePrompt }
        : { basePrompt, shards: plan.args.shards }),
      allowOverlap: plan.args.allowOverlap === true,
      ...(plan.args.concurrencyLimit === undefined ? {} : { concurrencyLimit: plan.args.concurrencyLimit }),
      ...(plan.args.timeoutMs === undefined ? {} : { timeoutMs: plan.args.timeoutMs }),
    };
    return { ok: true, mode, template, plan };
  }

  /**
   * 模板列表摘要：有界、无 schema 原文、无凭据/绝对路径全文。
   *
   * prompt 只给有界预览与字节数；分片给 shardId/名称/影响范围/超时与“是否声明 schema”
   * 布尔。客户端需要完整内容时必须显式发起模板派发，而不是靠列表把整库读进内存。
   */
  function summarizeFanoutTemplate(template) {
    const record = template !== null && typeof template === "object" && !Array.isArray(template) ? template : {};
    const shards = Array.isArray(record.shards) ? record.shards.slice(0, FANOUT_BUDGET.maxShardsPerTask) : [];
    const mode = shards.length > 0 ? "fanout" : "single";
    const promptText = mode === "single"
      ? (typeof record.prompt === "string" ? record.prompt : "")
      : (typeof record.basePrompt === "string" ? record.basePrompt : "");
    return {
      id: typeof record.id === "string" ? record.id : null,
      name: typeof record.name === "string" ? record.name : "",
      role: typeof record.role === "string" ? record.role : "",
      mode,
      promptBytes: utf8ByteLength(promptText),
      // 预览按码点切分：不会把多字节字符切成半个，也不会让列表随模板正文增长。
      preview: [...promptText].slice(0, FANOUT_TEMPLATE_PREVIEW_CHARS).join(""),
      shards: shards.map((shard) => {
        const entry = shard !== null && typeof shard === "object" && !Array.isArray(shard) ? shard : {};
        return {
          shardId: typeof entry.shardId === "string" ? entry.shardId : "",
          ...(typeof entry.name === "string" && entry.name.length > 0 ? { name: entry.name } : {}),
          promptBytes: utf8ByteLength(typeof entry.prompt === "string" ? entry.prompt : ""),
          affectedPaths: Array.isArray(entry.affectedPaths)
            ? entry.affectedPaths.slice(0, 64).map((path) => String(path).slice(0, 512))
            : [],
          ...(Number.isSafeInteger(entry.timeoutMs) ? { timeoutMs: entry.timeoutMs } : {}),
          hasOutputSchema: entry.outputSchema !== undefined,
        };
      }),
      allowOverlap: record.allowOverlap === true,
      ...(Number.isSafeInteger(record.concurrencyLimit) ? { concurrencyLimit: record.concurrencyLimit } : {}),
      ...(Number.isSafeInteger(record.timeoutMs) ? { timeoutMs: record.timeoutMs } : {}),
      createdAt: Number.isSafeInteger(record.createdAt) ? record.createdAt : null,
      updatedAt: Number.isSafeInteger(record.updatedAt) ? record.updatedAt : null,
    };
  }

  return {
    // 模板库整份文档的序列化上限也属于本域预算，dispatcher 保存模板时复用同一常量。
    FANOUT_TEMPLATE_MAX_BYTES,
    manualDispatchFailure,
    manualDispatchVerdictFailure,
    manualDispatchSchemaFailure,
    buildManualDispatchPlan,
    buildFanoutTemplatePlan,
    summarizeFanoutTemplate,
  };
}
