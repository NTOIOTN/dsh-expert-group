/**
 * Session generation 级瞬时状态与失败 tombstone。
 *
 * 用 Session 对象身份隔离 cold resume 前后的 transient 状态，并保存失败 admission 的 exact tombstone。
 * 本文件由原 `shared.js` 的 573–710 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/session-generation
 */

/**
 * 为每个 Session generation 保存 transient turn/claimed 状态。cold resume 会创建
 * 新的 Session 对象但保留 durable id；对象作为 WeakMap key 可以让新 generation
 * 从空状态开始，同时不影响 recovery record 中持久的 task/op/activity。
 */
export function createSessionGenerationState() {
  const states = new WeakMap();
  const validSession = (session) => session !== null
    && (typeof session === "object" || typeof session === "function");
  const get = (session) => {
    if (!validSession(session)) return void 0;
    let state = states.get(session);
    if (state === void 0) {
      state = { handledTurnEnds: new Set(), claimed: new Map() };
      states.set(session, state);
    }
    return state;
  };
  const reset = (session) => validSession(session) ? states.delete(session) : false;
  const claimTurn = (session, turn) => {
    if (!Number.isSafeInteger(turn)) return false;
    const state = get(session);
    if (state === void 0 || state.handledTurnEnds.has(turn)) return false;
    state.handledTurnEnds.add(turn);
    return true;
  };
  return { get, reset, claimTurn };
}

/**
 * 保存失败 admission 的 exact terminal tombstone。tombstone 不依赖 cohort entry
 * 的存活；迟到 turn/end 可按 child、durable Session、messageId/turn 反查并消费。
 * 没有可反查的 messageId/turn 时不保存，避免产生无期限 generic fallback。
 */
export function createHandoffFailureRegistry() {
  const failures = new Map();
  const validObject = (value) => value !== null
    && (typeof value === "object" || typeof value === "function");
  const validString = (value) => typeof value === "string" && value.length > 0;
  const sessionIdOf = (session) => validString(session?.id) ? session.id : void 0;
  const descriptorOf = (admission, context = {}) => {
    const session = admission?.session ?? context.session;
    const sessionId = admission?.sessionId ?? context.sessionId ?? sessionIdOf(session);
    const messageId = admission?.messageId ?? context.messageId;
    const turn = Number.isSafeInteger(admission?.turn) ? admission.turn
      : Number.isSafeInteger(context.turn) ? context.turn : void 0;
    return {
      token: admission?.token,
      childId: admission?.childId ?? context.childId,
      session,
      sessionId,
      messageId: validString(messageId) ? messageId : void 0,
      turn,
    };
  };
  const get = (parent) => failures.get(parent);
  const remember = (parent, admissions, context = {}) => {
    if (!validObject(parent) || !Array.isArray(admissions)) return 0;
    let records = failures.get(parent);
    let count = 0;
    for (const admission of admissions) {
      const descriptor = descriptorOf(admission, context);
      if (!validString(descriptor.token) || !validString(descriptor.childId)
        || (!validString(descriptor.messageId) && !Number.isSafeInteger(descriptor.turn))) continue;
      if (records === void 0) { records = new Map(); failures.set(parent, records); }
      records.set(descriptor.token, descriptor);
      count += 1;
    }
    return count;
  };
  const sessionMatches = (record, query) => {
    if (record.session !== void 0 && query.session !== void 0 && record.session === query.session) return true;
    const querySessionId = query.sessionId ?? sessionIdOf(query.session);
    return validString(record.sessionId) && validString(querySessionId) && record.sessionId === querySessionId;
  };
  const messageMatches = (record, query) => {
    if (!validString(record.messageId)) return false;
    if (record.messageId === query.messageId) return true;
    return query.messageIds instanceof Set && query.messageIds.has(record.messageId);
  };
  const matches = (record, childId, query = {}) => {
    if (record.childId !== childId) return false;
    // 已知 token 仍校验 caller 提供的 Session/turn/message metadata；token 只是
    // 缩小候选，不得让旧 generation 或错误 turn 越过 exact terminal 边界。
    if (validString(query.token) && record.token !== query.token) return false;
    if (!sessionMatches(record, query)) return false;
    if (Number.isSafeInteger(record.turn) && record.turn !== query.turn) return false;
    return messageMatches(record, query) || (Number.isSafeInteger(record.turn) && record.turn === query.turn);
  };
  const lookup = (parent, childId, query = {}) => {
    const records = failures.get(parent);
    if (!(records instanceof Map) || !validString(childId)) return void 0;
    for (const record of records.values()) {
      if (matches(record, childId, query)) return record;
    }
    return void 0;
  };
  const consume = (parent, childId, query = {}) => {
    const records = failures.get(parent);
    if (!(records instanceof Map)) return false;
    const record = lookup(parent, childId, query);
    if (record === void 0) return false;
    records.delete(record.token);
    if (records.size === 0) failures.delete(parent);
    return true;
  };
  const clearChild = (parent, childId) => {
    const records = failures.get(parent);
    if (!(records instanceof Map) || !validString(childId)) return 0;
    let count = 0;
    for (const [token, record] of records) {
      if (record.childId !== childId) continue;
      records.delete(token);
      count += 1;
    }
    if (records.size === 0) failures.delete(parent);
    return count;
  };
  const pruneUnmatchable = (parent) => {
    const records = failures.get(parent);
    if (!(records instanceof Map)) return 0;
    let count = 0;
    for (const [token, record] of records) {
      if (validString(record.messageId) || Number.isSafeInteger(record.turn)) continue;
      records.delete(token);
      count += 1;
    }
    if (records.size === 0) failures.delete(parent);
    return count;
  };
  return {
    get, remember, lookup, consume, clearChild, pruneUnmatchable,
    delete: (parent) => failures.delete(parent),
    has: (parent) => failures.has(parent),
    clear: () => failures.clear(),
  };
}
