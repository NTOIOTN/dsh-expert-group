/**
 * 兼容门面：DEG 共享模块的唯一对外入口（154 个导出名保持不变）。
 *
 * R1（票据 05）把原 4,465 行的实现按领域拆到 `shared/` 下的 19 个叶子模块；本文件
 * 只做 `export { ... } from`，不包含任何实现体。依赖方向是「叶子 → 叶子」，门面不
 * import 叶子；生产代码应直接依赖叶子模块，测试与 `test-support/plugin-host.mjs`
 * 可以继续走本门面作为兼容面。
 *
 * @module dsh-expert-group/shared
 */

export {
  RPC_PATH,
  RPC_CHANNEL,
  RPC_ENDPOINT,
  ROLES,
  OPTIONAL_ROLES,
  EXPERT_DELEGATION_DENY,
  ROOT_ONLY_TOOL_DENY,
  READONLY_DENY,
  expertDenyCandidates,
  roleLabelsOf,
  roleStatusLabelsOf,
  roleDescriptionsOf,
  isReadonlyDynamicMcpName,
  readonlyDenyCandidates,
  restrictableDenyNames,
} from "./shared/protocol.js";

export {
  subagentFeedbackChildId,
} from "./shared/feedback-identity.js";

export {
  createAdmissionBatchCoordinator,
  createHandoffAdmissionCohort,
} from "./shared/delegation-cohort.js";

export {
  createSessionGenerationState,
  createHandoffFailureRegistry,
} from "./shared/session-generation.js";

export {
  sameDurableSessionId,
  structuredToolTarget,
  rootStructuredPathGuard,
  delegationTaskKey,
  delegationScopeKey,
} from "./shared/structured-path.js";

export {
  normalizeAffectedPaths,
  normalizeWorkspacePath,
  normalizeAffectedPathsForWorkspace,
  affectedPathEntriesOverlap,
  findAffectedPathOverlaps,
} from "./shared/affected-paths.js";

export {
  takePendingCreation,
  rollbackCreatedChildAcceptance,
  TASK_TTL_DEFAULT_MS,
} from "./shared/pending-creation.js";

export {
  createDelegationTracker,
} from "./shared/delegation-tracker.js";

export {
  SUBAGENT_CAPACITY_ERROR_CODES,
  SUBAGENT_CAPACITY_MESSAGE,
  isSubagentCapacityError,
  describeSubagentCapacityFailure,
  createSubagentCapacityError,
  interruptFailureCanFallback,
} from "./shared/capacity-errors.js";

export {
  AUTO_RECOVERY_LIMIT,
  appendRecoveryRetryCount,
  TASK_BINDING_LIMIT,
  CLAIMED_LIMIT,
  FEEDBACK_DELIVERY_LIMIT,
  createFeedbackIdentityLedger,
  evictOldestEntries,
} from "./shared/recovery-ledger.js";

export {
  turnTextBlocks,
  turnHasNonEmptyText,
  messageIdsOfTurn,
  messageIdsOfTurnWithClaimed,
  messageTextOf,
  rememberClaimedPlaceholder,
  rebindPendingTaskByClaimed,
  shouldForgetTask,
  taskKeysForTurn,
  applyTurnToTasks,
  supersedeTaskBindings,
  hasExplicitParentOrUserCancellation,
  PERMANENT_TURN_ERROR_CODES,
  isPermanentTurnError,
  classifyTurnOutcome,
  shouldRebuildRecoveryChild,
  shouldInstallRebuiltChild,
  recoveryRebuildCanCommit,
  shouldAutoRecover,
} from "./shared/turn-settlement.js";

export {
  RECOVERY_BACKOFF_DELAYS,
  recoveryDelayForCount,
  REQUEST_RETRYABLE_FAILURE_CODES,
  isPermanentPiAiMessage,
  isTransientPiAiFailure,
  isPermanentPiAiFailure,
  isTransientRequestFailure,
  requestRetryPolicyCoversFailure,
  createRequestRetryState,
  resetRequestRetryState,
  markRequestRetryEvent,
  clearRecoveryOpTimer,
  scheduleRecoveryOpTimer,
  createRecoveryOp,
  recoveryOpIsAccepted,
  recoveryOpCanBeSuperseded,
  findRecoveryOpByMessage,
  recoveryOpPendingForTurn,
  recoveryOpIsPending,
  recoveryDispatchCanStart,
  recoveryReasonText,
  buildRecoveryMessage,
  lastTurnErrorMessage,
} from "./shared/retry-policy.js";

export {
  STATUS_ROLE_IDS,
  PROMPT_OVERRIDES_SETTINGS_KEY,
  PROMPT_OVERRIDE_MAX_GRAPHEMES,
  PROMPT_OVERRIDE_INVALID_CODE,
  PROMPT_OVERRIDE_UNKNOWN_ROLE_CODE,
  countPromptGraphemes,
  normalizePromptOverrides,
  promptOverrideFor,
  STATUS_ROLE_LABELS,
  normalizeStatusRole,
  isPluginChildSession,
  resolveStatusIdentity,
} from "./shared/prompts.js";

export {
  findNativeStatusTextNode,
  resolveRunningStatusText,
} from "./shared/status-dom.js";

export {
  SUPPORTED_LOCALES,
  DEFAULT_LOCALE,
  MISSING_MESSAGE_TEXT,
  MESSAGE_CATALOG,
  normalizeLocale,
  resolveLocale,
  translateMessage,
  resolveHostLocale,
  NATIVE_RUNNING_STATUS_PREFIXES,
  NATIVE_RUNNING_STATUS_PREFIX,
} from "./shared/i18n.js";

export {
  replaceNativeStatusPrefix,
  createNativeTextRewriter,
} from "./shared/native-text.js";

export {
  collectRuntimeRootDescendants,
  evaluateRunningRootDescendants,
  snapshotRunningRootDescendants,
} from "./shared/root-descendants.js";

export {
  DEFAULT_MODEL_FALLBACK_LIMIT,
  MAX_MODEL_FALLBACK_LIMIT,
  MAX_MODEL_CANDIDATES_PER_ROLE,
  MODEL_CANDIDATES_EXHAUSTED,
  MODEL_ROUTE_OK,
  MODEL_ROUTE_NOT_CONFIGURED,
  MODEL_ROUTE_ERROR_CODES,
  DETERMINISTIC_MODEL_FAILURE_CODES,
  isDeterministicModelFailure,
  NON_DEGRADABLE_MODEL_FAILURE_CODES,
  isNonDegradableModelFailure,
  EXPERT_ROUTE_MARKER,
  EXPERT_SUBAGENT_PROVIDER_MARKER,
  EXPERT_INHERIT_CONTEXT_MARKER,
  CONTEXT_INHERITANCE_ERROR_CODES,
  CONTEXT_INHERITANCE_ROLE_IDS,
  normalizeModelFallbackLimit,
  normalizeModelSelection,
  modelSelectionKeyOf,
  modelRouteKeyOf,
  normalizeModelRouteErrorCode,
  classifyModelRouteError,
  modelRouteErrorCodeOf,
  isPrecheckModelRouteFailure,
  isModelRouteErrorCode,
  modelRouteErrorMessage,
  buildModelRoutePlan,
  projectModelRouteFields,
  normalizeModelRouteMarker,
  persistedModelRouteIsAuthoritative,
  modelRouteFieldsFromRecord,
} from "./shared/model-route.js";

export {
  OUTPUT_SCHEMA_MAX_BYTES,
  OUTPUT_SCHEMA_ERROR_CODES,
  OUTPUT_SCHEMA_REQUESTED_MARKER,
  STRUCTURED_RESULT_FALLBACK_REASONS,
  utf8ByteLength,
  projectStructuredResult,
  structuredProjectionFields,
} from "./shared/structured.js";
