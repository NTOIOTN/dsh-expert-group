/* 此文件由 scripts/assemble-client.mjs 生成，请勿手工编辑。 */
/* source: client-expert-group-model-normalize.js */
(function installExpertGroupModelNormalize(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-model-normalize");
const SCHEMA_VERSION=1;
const STATUSES=new Set([
"queued","waiting","running","succeeded","failed","cancelled",
"timed_out","interrupted","idle","ready","unknown",
]);
const STATUS_ALIASES=Object.freeze({
canceled:"cancelled",timeout:"timed_out",timedout:"timed_out","timed-out":"timed_out",
success:"succeeded",successful:"succeeded",complete:"succeeded",completed:"succeeded",done:"succeeded",
error:"failed",errored:"failed",active:"running",in_progress:"running","in-progress":"running",
working:"running",pending:"queued",scheduled:"queued",wait:"waiting",
});
const CAPABILITY_ACTIONS=Object.freeze(["read","cancel","retry","continue"]);
const SHARD_CAPABILITY_ACTIONS=Object.freeze(["cancel","retry"]);
const CAPABILITY_REASON_MAX_LENGTH=64;
const ROUTE_PERIOD_VALUES=Object.freeze(["peak","valley","none"]);
const ROUTE_TIER_VALUES=Object.freeze(["peak","valley","normal-override","normal-fallback"]);
const ROUTE_TEXT_MAX_LENGTH=64;
const COUNT_FIELDS=Object.freeze([
"queued","waiting","running","succeeded","failed","cancelled","timed_out","interrupted","pending",
]);
const FAILURE_CODE_MAX_LENGTH=64;
const FAILURE_MESSAGE_MAX_LENGTH=160;
const MAX_NESTED_EXPERT_DEPTH=16;
const ACTIVE_STATUS_SET=new Set(["queued","waiting","running"]);
const RECOVERY_CODE_PATTERN=/^[A-Z][A-Z0-9_]{0,63}$/;
const RECOVERY_MESSAGE_MAX_LENGTH=200;
const RUNTIME_STATUSES=Object.freeze(["running","ready"]);
const UNKNOWN_RUNTIME_STATUS="unknown";
const USAGE_TOKEN_FIELDS=Object.freeze([
"inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens","reasoningTokens",
]);
const USAGE_COUNT_FIELDS=Object.freeze(["requests","retries","fallbacks"]);
const USAGE_TEXT_MAX_LENGTH=128;
const STRUCTURED_FALLBACK_REASONS=Object.freeze({
missing_structured:"未收到结构化结果，已回退文本总结",
result_unavailable:"结构化结果不可用，已回退文本总结",
result_too_large:"结构化结果超过 64 KiB 上限，已回退文本总结",
schema_not_restored:"冷恢复未恢复输出声明，本轮无法校验结构化结果",
});
const STRUCTURED_FALLBACK_REASON_SET=new Set(Object.keys(STRUCTURED_FALLBACK_REASONS));
const ROLE_LABEL_MAX_ENTRIES=64;
function isObject(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function text(value){
if(typeof value!=="string")return null;
const valueText=value.trim();
return valueText.length===0?null:valueText;
}
function firstText(){
for(const value of arguments){
const result=text(value);
if(result!==null)return result;
}
return null;
}
function numberOrNull(value){
return typeof value==="number"&&Number.isFinite(value)?value:null;
}
function durationBetween(startedAt,finishedAt){
if(startedAt===null||finishedAt===null)return null;
return Math.max(0,finishedAt-startedAt);
}
const QUOTED_WINDOWS_PATH_PATTERN=/(["'])[A-Za-z]:[\\/][^"'\r\n]*\1/g;
const QUOTED_POSIX_PATH_PATTERN=/(["'])\/[^"'\r\n]*\1/g;
const WINDOWS_ABSOLUTE_PATH_PATTERN=/(^|[^A-Za-z0-9])[A-Za-z]:[\\/][^\s"'\x60,;!?)\]}]*/g;
const UNC_ABSOLUTE_PATH_PATTERN=/\\\\[^\s"'\x60,;!?)\]}]+/g;
const POSIX_ABSOLUTE_PATH_PATTERN=/(^|[\s("'\x60=\[\]])\/(?:[^\s"'\x60/]+\/)+[^\s"'\x60,;!?)\]}]*/g;
function redactFailurePaths(value){
return value
.replace(QUOTED_WINDOWS_PATH_PATTERN,"$1<path>$1")
.replace(QUOTED_POSIX_PATH_PATTERN,"$1<path>$1")
.replace(WINDOWS_ABSOLUTE_PATH_PATTERN,"$1<path>")
.replace(UNC_ABSOLUTE_PATH_PATTERN,"<path>")
.replace(POSIX_ABSOLUTE_PATH_PATTERN,"$1<path>");
}
function collapseFailureMessage(value){
const raw=text(value);
if(raw===null)return null;
const firstLine=raw.split(/\r?\n/,1)[0]??"";
const collapsed=firstLine
.replace(/[\u0000-\u001f\u007f-\u009f]+/g," ")
.replace(/\s+/g," ")
.trim();
if(collapsed.length===0)return null;
const truncated=collapsed.length>FAILURE_MESSAGE_MAX_LENGTH
?collapsed.slice(0,FAILURE_MESSAGE_MAX_LENGTH)
:collapsed;
const redacted=redactFailurePaths(truncated).trim();
return redacted.length===0?null:redacted;
}
function normalizeFailure(value){
if(!isObject(value))return null;
const rawCode=text(value.code);
const cleanedCode=rawCode===null?"":rawCode.replace(/[\u0000-\u001f\u007f-\u009f]+/g,"").trim();
const code=cleanedCode.length===0?"error":cleanedCode.slice(0,FAILURE_CODE_MAX_LENGTH);
return{code,message:collapseFailureMessage(value.message)};
}
function normalizeStatus(value){
const source=text(value);
if(source===null)return"unknown";
const key=source.toLowerCase().replace(/\s+/g,"_");
if(STATUSES.has(key))return key;
return STATUS_ALIASES[key]||"unknown";
}
function statusFromTask(value){
const source=text(value);
if(source==="pending")return"running";
if(source==="completed"||source==="complete")return"succeeded";
if(source==="completed_with_errors")return"failed";
return normalizeStatus(source);
}
function runningOf(status,explicit){
if(typeof explicit==="boolean")return explicit;
if(status==="unknown")return null;
return status==="running"||status==="waiting";
}
function activitySignalOf(node,entry){
const source=isObject(node)?node:{};
const catalog=isObject(entry)?entry:{};
const activity=text(catalog.activity);
if(activity==="running")return"running";
if(activity==="inactive")return"inactive";
const catalogStatus=text(catalog.status);
if(catalogStatus==="running")return"running";
if(catalogStatus==="idle")return"inactive";
if(typeof source.running==="boolean")return source.running?"running":"inactive";
const protocolStatus=normalizeStatus(source.status);
if(protocolStatus==="running")return"running";
if(protocolStatus!=="unknown")return"inactive";
return null;
}
function runtimeStatusOf(node,entry,options){
const signal=activitySignalOf(node,entry);
if(signal==="running")return"running";
if(isObject(options)&&options.partial===true&&signal===null)return UNKNOWN_RUNTIME_STATUS;
return"ready";
}
function normalizeRunSummary(value){
if(!isObject(value))return null;
const mode=value.mode==="continuable"||value.mode==="one-shot"?value.mode:"unknown";
const activity=value.activity==="running"||value.activity==="idle"?value.activity:"unknown";
return{command:text(value.command),mode,activity};
}
function normalizeRecovery(value){
if(!isObject(value))return null;
const status=value.status==="failed"||value.status==="ok"?value.status:"none";
const rawCode=text(value.code);
const code=status==="failed"
?(rawCode!==null&&RECOVERY_CODE_PATTERN.test(rawCode)?rawCode:"RESTORE_FAILED")
:null;
const rawMessage=text(value.message);
const message=status==="failed"&&rawMessage!==null
?rawMessage.replace(/[\u0000-\u001f\u007f-\u009f]+/g," ").replace(/\s+/g," ").trim().slice(0,RECOVERY_MESSAGE_MAX_LENGTH)||null
:null;
return{
status,
code,
message,
at:numberOrNull(value.at),
retryable:status==="failed"&&value.retryable===true,
persistenceBlocked:value.persistenceBlocked===true,
};
}
function countOrNull(value){
return typeof value==="number"&&Number.isSafeInteger(value)&&value>=0?value:null;
}
function boundedText(value,maxLength){
if(typeof value!=="string")return null;
const trimmed=value.trim();
if(trimmed.length===0)return null;
return trimmed.slice(0,maxLength);
}
function normalizeUsage(value){
if(!isObject(value))return null;
const usage={};
for(const field of USAGE_TOKEN_FIELDS){
const count=countOrNull(value[field]);
if(count!==null)usage[field]=count;
}
if(countOrNull(usage.inputTokens)!==null){
usage.billedInputTokens=usage.inputTokens
+(countOrNull(usage.cacheReadTokens)??0)
+(countOrNull(usage.cacheWriteTokens)??0);
if(countOrNull(usage.outputTokens)!==null){
usage.totalTokens=usage.billedInputTokens+usage.outputTokens;
}
}else{
const billed=countOrNull(value.billedInputTokens);
if(billed!==null)usage.billedInputTokens=billed;
const total=countOrNull(value.totalTokens);
if(total!==null)usage.totalTokens=total;
}
for(const field of USAGE_COUNT_FIELDS){
const count=countOrNull(value[field]);
if(count!==null&&count>0)usage[field]=count;
}
for(const field of["provider","model","role","roleLabel"]){
const textValue=boundedText(value[field],USAGE_TEXT_MAX_LENGTH);
if(textValue!==null)usage[field]=textValue;
}
const runMs=countOrNull(value.runMs);
if(runMs!==null)usage.runMs=runMs;
const hasMetric=USAGE_TOKEN_FIELDS.concat(USAGE_COUNT_FIELDS)
.some((field)=>countOrNull(usage[field])!==null&&(usage[field]>0||field.endsWith("Tokens")===true));
if(hasMetric!==true)return null;
return usage;
}
function normalizeStructured(value){
if(!isObject(value))return null;
const structured={};
let fallback=value.fallback===true;
let reason=STRUCTURED_FALLBACK_REASON_SET.has(value.reason)?value.reason:null;
if(Object.prototype.hasOwnProperty.call(value,"value")){
let serialized;
try{serialized=JSON.stringify(value.value);}catch{serialized=undefined;}
if(serialized===undefined){
fallback=true;
reason=reason??"result_unavailable";
}else{
try{structured.value=JSON.parse(serialized);}catch{fallback=true;reason=reason??"result_unavailable";}
structured.bytes=serialized.length;
}
}
const bytes=countOrNull(value.bytes);
if(bytes!==null)structured.bytes=bytes;
const receivedAt=countOrNull(value.receivedAt);
if(receivedAt!==null)structured.receivedAt=receivedAt;
if(fallback===true)structured.fallback=true;
if(reason!==null)structured.reason=reason;
return Object.keys(structured).length===0?null:structured;
}
function usageFields(source){
const usage=normalizeUsage(isObject(source)?source.usage:null);
return usage===null?{}:{usage};
}
function structuredFields(source){
if(!isObject(source))return{};
const structured=normalizeStructured(source.structured);
const requested=typeof source.outputSchemaRequested==="boolean"?source.outputSchemaRequested:null;
return{
...(structured===null?{}:{structured}),
...(requested===null?{}:{outputSchemaRequested:requested}),
};
}
function normalizeRoleLabels(value){
if(!isObject(value))return null;
const labels={};
let count=0;
for(const key of Object.keys(value)){
if(count>=ROLE_LABEL_MAX_ENTRIES)break;
const roleId=boundedText(key,64);
const label=boundedText(value[key],USAGE_TEXT_MAX_LENGTH);
if(roleId===null||label===null)continue;
labels[roleId]=label;
count+=1;
}
return count===0?null:labels;
}
function roleLabelFrom(role,labels){
const roleId=text(role);
if(roleId===null||!isObject(labels))return null;
return boundedText(labels[roleId],USAGE_TEXT_MAX_LENGTH);
}
function roleLabelOf(role,labels){
return roleLabelFrom(role,labels)??text(role);
}
function findModelPrice(prices,provider,model){
if(!Array.isArray(prices))return null;
const wantProvider=boundedText(provider,USAGE_TEXT_MAX_LENGTH);
const wantModel=boundedText(model,USAGE_TEXT_MAX_LENGTH);
if(wantProvider===null||wantModel===null)return null;
for(const entry of prices){
if(!isObject(entry))continue;
const entryProvider=boundedText(entry.provider,USAGE_TEXT_MAX_LENGTH);
const entryModel=boundedText(entry.model,USAGE_TEXT_MAX_LENGTH);
if(entryProvider===null||entryModel===null)continue;
if(entryProvider.toLowerCase()===wantProvider.toLowerCase()
&&entryModel.toLowerCase()===wantModel.toLowerCase())return entry;
}
return null;
}
function estimateUsageCost(usage,price){
const projected=normalizeUsage(usage);
if(projected===null||!isObject(price))return null;
const billedInput=countOrNull(projected.billedInputTokens)??countOrNull(projected.inputTokens);
const output=countOrNull(projected.outputTokens);
const inputRate=numberOrNull(price.inputPerMillion);
const outputRate=numberOrNull(price.outputPerMillion);
if(billedInput===null||output===null)return null;
if(inputRate===null||outputRate===null||inputRate<0||outputRate<0)return null;
const inputCost=(billedInput/1000000)*inputRate;
const outputCost=(output/1000000)*outputRate;
return Object.freeze({
currency:boundedText(price.currency,8)??"USD",
inputCost,
outputCost,
totalCost:inputCost+outputCost,
});
}
function normalizeCapabilityEntry(value){
if(!isObject(value)||typeof value.allowed!=="boolean")return null;
if(value.allowed===true)return{allowed:true};
const reason=text(value.reason);
return{
allowed:false,
reason:reason===null?"not_supported":reason.slice(0,CAPABILITY_REASON_MAX_LENGTH),
};
}
function normalizeCapabilities(value,actions){
if(!isObject(value))return null;
const normalized={};
let any=false;
for(const action of actions){
const entry=normalizeCapabilityEntry(value[action]);
if(entry===null)continue;
normalized[action]=entry;
any=true;
}
return any?normalized:null;
}
function normalizeTimelineFields(source,fallback){
const defaults=isObject(fallback)?fallback:{};
const startedAt=numberOrNull(source.startedAt)??numberOrNull(defaults.startedAt);
const stillActive=ACTIVE_STATUS_SET.has(normalizeStatus(source.status));
const finishedAt=stillActive?null:numberOrNull(source.finishedAt);
const attemptCount=numberOrNull(source.attemptCount)??(numberOrNull(defaults.attemptCount)??0);
return{
startedAt,
finishedAt,
durationMs:stillActive?null:(numberOrNull(source.durationMs)??durationBetween(startedAt,finishedAt)),
lastActivityAt:numberOrNull(source.lastActivityAt)??numberOrNull(defaults.lastActivityAt),
attemptCount,
retryCount:numberOrNull(source.retryCount)??(numberOrNull(defaults.retryCount)??Math.max(0,attemptCount-1)),
failure:normalizeFailure(source.failure),
};
}
function normalizeRouteFallback(value){
if(!isObject(value))return null;
if(value.fromTier!=="peak"&&value.fromTier!=="valley")return null;
if(value.toTier!=="normal-fallback")return null;
const reasonCode=boundedText(value.reasonCode,ROUTE_TEXT_MAX_LENGTH);
if(reasonCode===null)return null;
const role=boundedText(value.role,ROUTE_TEXT_MAX_LENGTH);
return{
fromTier:value.fromTier,
toTier:"normal-fallback",
reasonCode,
...(role===null?{}:{role}),
};
}
function routeFields(value){
const source=isObject(value)?value:{};
const fallback=normalizeRouteFallback(source.ordinaryFallback);
return{
...(ROUTE_PERIOD_VALUES.includes(source.routePeriod)?{routePeriod:source.routePeriod}:{}),
...(ROUTE_TIER_VALUES.includes(source.routeTier)?{routeTier:source.routeTier}:{}),
...(fallback===null?{}:{ordinaryFallback:fallback}),
};
}
function normalizeAttempt(value){
const source=isObject(value)?value:{};
const startedAt=numberOrNull(source.startedAt);
const stillActive=ACTIVE_STATUS_SET.has(normalizeStatus(source.status));
const finishedAt=stillActive?null:numberOrNull(source.finishedAt);
return{
attempt:numberOrNull(source.attempt),
status:normalizeStatus(source.status),
childId:text(source.childId),
roleLabel:text(source.roleLabel),
...routeFields(source),
...usageFields(source),
...structuredFields(source),
startedAt,
finishedAt,
durationMs:stillActive?null:(numberOrNull(source.durationMs)??durationBetween(startedAt,finishedAt)),
failure:normalizeFailure(source.failure),
};
}
function normalizeShard(value,inherited){
const source=isObject(value)?value:{};
const defaults=isObject(inherited)?inherited:{};
const attempts=Array.isArray(source.attempts)?source.attempts.map(normalizeAttempt):[];
const latest=attempts.length===0?null:attempts[attempts.length-1];
const managerStatus=source.status===undefined?"unknown":normalizeStatus(source.status);
const status=managerStatus!=="unknown"?managerStatus:(latest?.status??"unknown");
return{
shardId:text(source.shardId),
taskName:firstText(source.taskName,source.shardId),
prompt:firstText(source.prompt,source.content),
role:firstText(source.role,defaults.role),
roleLabel:firstText(source.roleLabel,defaults.roleLabel),
provider:firstText(source.provider,defaults.provider),
model:firstText(source.model,defaults.model),
effort:firstText(source.effort,source.reasoningEffort,defaults.effort,defaults.reasoningEffort),
...routeFields(source),
status,
...usageFields(source),
...structuredFields(source),
running:runningOf(status,source.running),
runSummary:normalizeRunSummary(source.runSummary),
turnDurationMs:numberOrNull(source.turnDurationMs),
turnOpenSince:numberOrNull(source.turnOpenSince),
continuable:typeof source.continuable==="boolean"?source.continuable:null,
...(()=>{
const capabilities=normalizeCapabilities(source.capabilities,SHARD_CAPABILITY_ACTIONS);
return capabilities===null?{}:{capabilities};
})(),
childId:latest?.childId??text(source.childId),
createdAt:numberOrNull(source.createdAt),
attempts,
...normalizeTimelineFields(source,{
startedAt:numberOrNull(source.createdAt),
attemptCount:attempts.length,
}),
};
}
function normalizeCounts(value){
if(!isObject(value))return null;
const result={};
for(const field of COUNT_FIELDS)result[field]=numberOrNull(value[field]);
return result;
}
function normalizeFanout(value){
const source=isObject(value)?value:{};
const parentTaskId=text(source.parentTaskId);
const taskStatus=text(source.taskStatus)||text(source.status);
const status=taskStatus===null?"unknown":statusFromTask(taskStatus);
const rawShards=Array.isArray(source.shards)?source.shards:[];
const shards=rawShards.map((shard)=>normalizeShard(shard,source));
let shardAttemptCount=0;
let shardRetryCount=0;
for(const shard of shards){
shardAttemptCount+=numberOrNull(shard.attemptCount)??0;
shardRetryCount+=numberOrNull(shard.retryCount)??0;
}
return{
id:parentTaskId,
kind:"fanout",
parentTaskId,
taskName:firstText(source.taskName,source.title),
content:firstText(source.content),
basePrompt:firstText(source.basePrompt,source.content),
contentSource:text(source.contentSource),
role:text(source.role),
roleLabel:text(source.roleLabel),
provider:text(source.provider),
model:text(source.model),
effort:firstText(source.effort,source.reasoningEffort),
...routeFields(source),
taskStatus,
status,
running:runningOf(status,source.running),
createdAt:numberOrNull(source.createdAt),
counts:normalizeCounts(source.counts),
...usageFields(source),
...(()=>{
if(!Array.isArray(source.structured))return{};
const entries=[];
for(const entry of source.structured){
if(!isObject(entry))continue;
const inner=normalizeStructured(entry.structured);
if(inner===null)continue;
const shardId=boundedText(entry.shardId,USAGE_TEXT_MAX_LENGTH);
const childId=boundedText(entry.childId,USAGE_TEXT_MAX_LENGTH);
const attempt=countOrNull(entry.attempt);
entries.push({
...(shardId===null?{}:{shardId}),
...(attempt===null?{}:{attempt}),
...(childId===null?{}:{childId}),
structured:inner,
});
}
return entries.length===0?{}:{structured:entries};
})(),
...(()=>{
const capabilities=normalizeCapabilities(source.capabilities,CAPABILITY_ACTIONS);
return capabilities===null?{}:{capabilities};
})(),
shards,
...normalizeTimelineFields(source,{
startedAt:numberOrNull(source.createdAt),
attemptCount:shardAttemptCount,
retryCount:shardRetryCount,
}),
};
}
function normalizeSessionNode(value,kind,fallbackId,depth){
const source=isObject(value)?value:{};
const id=firstText(source.id,source.sessionId,fallbackId);
const status=normalizeStatus(source.status);
const nestedDepth=numberOrNull(depth)??0;
const createdAt=numberOrNull(source.createdAt);
const startedAt=numberOrNull(source.startedAt)??createdAt;
const finishedAt=numberOrNull(source.finishedAt);
const rawChildren=kind==="expert"&&nestedDepth<MAX_NESTED_EXPERT_DEPTH&&Array.isArray(source.children)
?source.children
:[];
return{
id,
kind,
sessionId:firstText(source.sessionId,source.id,fallbackId),
taskName:firstText(source.taskName,source.task,source.title,source.displayTitle,source.label,source.name),
content:firstText(source.content,source.prompt),
contentSource:text(source.contentSource),
role:text(source.role),
roleLabel:text(source.roleLabel),
provider:text(source.provider),
model:text(source.model),
effort:firstText(source.effort,source.reasoningEffort),
...routeFields(source),
status,
running:runningOf(status,source.running),
runSummary:normalizeRunSummary(source.runSummary),
...usageFields(source),
...structuredFields(source),
continuable:typeof source.continuable==="boolean"?source.continuable:null,
...(()=>{
const capabilities=normalizeCapabilities(source.capabilities,CAPABILITY_ACTIONS);
return capabilities===null?{}:{capabilities};
})(),
createdAt,
startedAt,
lastActivityAt:numberOrNull(source.lastActivityAt)??startedAt,
finishedAt,
durationMs:numberOrNull(source.durationMs)??durationBetween(startedAt,finishedAt),
turnDurationMs:numberOrNull(source.turnDurationMs),
turnOpenSince:numberOrNull(source.turnOpenSince),
children:rawChildren.map((child)=>normalizeSessionNode(child,"expert",null,nestedDepth+1)),
};
}
function attemptChildIds(nodes){
const ids=new Set();
for(const node of nodes){
if(node.kind!=="fanout")continue;
for(const shard of node.shards)for(const attempt of shard.attempts){
if(attempt.childId!==null)ids.add(attempt.childId);
}
}
return ids;
}
function childSourceList(raw,root){
if(Array.isArray(root?.children))return root.children;
const expertChildren=Array.isArray(raw?.experts)?raw.experts:[];
const fanoutChildren=Array.isArray(raw?.fanoutTasks)
?raw.fanoutTasks
:(Array.isArray(raw?.tasks)?raw.tasks:[]);
return[...expertChildren,...fanoutChildren];
}
function normalizeExpertGroupSnapshot(raw){
if(!isObject(raw)||raw.schemaVersion!==SCHEMA_VERSION)return null;
const sourceRoot=isObject(raw.root)?raw.root:{};
const rootSessionId=firstText(raw.rootSessionId,raw.sessionId,sourceRoot.sessionId,sourceRoot.id);
if(rootSessionId===null)return null;
const root=normalizeSessionNode(sourceRoot,"root",rootSessionId);
root.sessionId=rootSessionId;
root.id=rootSessionId;
const rawChildren=childSourceList(raw,sourceRoot);
const children=rawChildren.map((child)=>{
const kind=isObject(child)&&child.kind==="fanout"?"fanout":"expert";
return kind==="fanout"?normalizeFanout(child):normalizeSessionNode(child,"expert");
});
const fanoutIds=attemptChildIds(children);
root.children=children.filter((child)=>child.kind!=="expert"||child.sessionId===null||!fanoutIds.has(child.sessionId));
return{
schemaVersion:SCHEMA_VERSION,
sessionId:rootSessionId,
rootSessionId,
generatedAt:numberOrNull(raw.generatedAt),
revision:text(raw.revision),
partial:raw.partial===true,
recovery:normalizeRecovery(raw.recovery),
roleLabels:normalizeRoleLabels(raw.roleLabels),
root,
};
}
global[SYMBOL]=Object.freeze({
SCHEMA_VERSION,
RUNTIME_STATUSES,
UNKNOWN_RUNTIME_STATUS,
STRUCTURED_FALLBACK_REASONS,
STRUCTURED_FALLBACK_REASON_SET,
MAX_NESTED_EXPERT_DEPTH,
normalizeExpertGroupSnapshot,
normalizeCapabilities,
normalizeStatus,
normalizeFailure,
normalizeUsage,
normalizeStructured,
roleLabelFrom,
roleLabelOf,
findModelPrice,
estimateUsageCost,
runtimeStatusOf,
isObject,
text,
firstText,
numberOrNull,
countOrNull,
redactFailurePaths,
normalizeAttempt,
});
})(globalThis);
/* source: client-expert-group-model-format.js */
(function installExpertGroupModelFormat(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-model-format");
const{
SCHEMA_VERSION,
MAX_NESTED_EXPERT_DEPTH,
STRUCTURED_FALLBACK_REASONS,
STRUCTURED_FALLBACK_REASON_SET,
isObject,
text,
firstText,
numberOrNull,
countOrNull,
redactFailurePaths,
normalizeStatus,
normalizeFailure,
normalizeUsage,
normalizeStructured,
normalizeAttempt,
roleLabelFrom,
}=global[Symbol.for("dsh-expert-group/client-expert-group-model-normalize")];
const FAILURE_MESSAGE_DISPLAY_MAX_LENGTH=120;
const RETRY_WARNING_THRESHOLD=3;
const ATTEMPT_TIMELINE_LIMIT=5;
const FAILURE_STATUSES=Object.freeze(["failed","timed_out","interrupted"]);
const STATUS_FILTER_GROUPS=Object.freeze({
running:Object.freeze(["queued","waiting","running"]),
incomplete:Object.freeze(["failed","timed_out","interrupted","cancelled","idle","ready","unknown"]),
completed:Object.freeze(["succeeded"]),
});
const DEFAULT_COLLAPSED_STATUSES=new Set(["idle","ready","succeeded","cancelled"]);
const FANOUT_SETTLED_STATUSES=new Set(["succeeded","failed","cancelled"]);
const STRUCTURED_PREVIEW_MAX_CHARS=400;
const SUPPORTED_LOCALES=Object.freeze(["zh","en"]);
const DEFAULT_LOCALE="zh";
const MISSING_MESSAGE_TEXT="—";
const MESSAGE_CATALOG=Object.freeze({
"sidebar.title":{zh:"Expert Group",en:"Expert Group"},
"sidebar.empty":{zh:"暂无 Expert Group 任务",en:"No Expert Group tasks yet"},
"sidebar.error.snapshot":{zh:"快照读取失败",en:"Snapshot read failed"},
"sidebar.error.action":{zh:"操作失败",en:"Action failed"},
"sidebar.error.rpc":{zh:"请求失败",en:"Request failed"},
"sidebar.refresh":{zh:"刷新",en:"Refresh"},
"sidebar.retry":{zh:"重试",en:"Retry"},
"sidebar.idleGroup":{zh:"空闲子代理（{count}）",en:"Idle subagents ({count})"},
"sidebar.idleGroup.name":{zh:"空闲子代理",en:"Idle subagents"},
"sidebar.search.label":{zh:"任务过滤",en:"Filter tasks"},
"sidebar.search.aria":{zh:"搜索任务",en:"Search tasks"},
"sidebar.search.placeholder":{zh:"搜索任务名 / 角色 / 模型",en:"Search task name / role / model"},
"sidebar.filter.role":{zh:"按角色筛选",en:"Filter by role"},
"sidebar.filter.status":{zh:"按状态筛选",en:"Filter by status"},
"sidebar.filter.allRoles":{zh:"全部角色",en:"All roles"},
"sidebar.filter.allStatuses":{zh:"全部状态",en:"All statuses"},
"sidebar.filter.empty":{zh:"没有匹配的任务",en:"No matching tasks"},
"sidebar.collapse":{zh:"收起",en:"Collapse"},
"sidebar.expand":{zh:"展开",en:"Expand"},
"sidebar.recovery.retry":{zh:"重试恢复",en:"Retry recovery"},
"sidebar.recovery.retrying":{zh:"重试中…",en:"Retrying…"},
"sidebar.sessionModel.open":{zh:"会话模型",en:"Session models"},
"sidebar.sessionModel.title":{zh:"会话模型",en:"Session models"},
"sidebar.sessionModel.hint":{
zh:"只影响本会话的专家派发，不改变全局默认；清除后恢复跟随当前默认。",
en:"Affects expert dispatch in this session only; global defaults are unchanged. Clear an override to follow the current default again.",
},
"sidebar.sessionModel.openTitle":{
zh:"按会话修改专家模型，不影响全局默认",
en:"Change expert models for this session; global defaults are unchanged",
},
"sidebar.sessionModel.close":{zh:"关闭",en:"Close"},
"sidebar.sessionModel.restore":{zh:"恢复默认",en:"Restore defaults"},
"sidebar.sessionModel.noSession":{
zh:"未打开会话：打开一个会话后可在此临时覆盖角色模型。",
en:"No open session: open a session to temporarily override role models here.",
},
"sidebar.sessionModel.child":{
zh:"当前是子代理会话，会话级模型覆盖只读。",
en:"This is a subagent session; session model overrides are read-only.",
},
"sidebar.sessionModel.loading":{zh:"正在读取本会话覆盖…",en:"Loading session overrides…"},
"sidebar.sessionModel.unavailable":{
zh:"本会话覆盖读取失败，请稍后重试。",
en:"Failed to read session overrides; please retry later.",
},
"sidebar.sessionModel.unsupported":{
zh:"当前宿主版本不支持会话级模型覆盖。",
en:"This host version does not support session model overrides.",
},
"sidebar.sessionModel.offline":{
zh:"会话未运行：会话级覆盖只读。",
en:"The session is not running; session overrides are read-only.",
},
"sidebar.sessionModel.revision":{zh:"代次 {revision}",en:"Revision {revision}"},
"sidebar.sessionModel.provider":{zh:"供应商",en:"Provider"},
"sidebar.sessionModel.effort":{zh:"思考深度",en:"Reasoning effort"},
"sidebar.sessionModel.effortDefault":{zh:"模型默认",en:"Model default"},
"sidebar.sessionModel.save":{zh:"保存覆盖",en:"Save override"},
"sidebar.sessionModel.clear":{zh:"清除",en:"Clear"},
"sidebar.sessionModel.saved":{zh:"已保存本会话覆盖",en:"Session override saved"},
"sidebar.sessionModel.cleared":{zh:"已清除，恢复全局默认",en:"Cleared; global default restored"},
"sidebar.sessionModel.conflict":{
zh:"其他页面已修改本会话覆盖（当前代次 {revision}）；你的输入已保留，请确认后重试。",
en:"Another page changed this session's overrides (current revision {revision}); your input was kept, please review and retry.",
},
"sidebar.sessionModel.failed":{zh:"保存失败：{message}",en:"Save failed: {message}"},
"sidebar.sessionModel.retry":{zh:"重新读取",en:"Reload"},
"sidebar.sessionModel.emptyRoles":{zh:"没有可配置的专家角色。",en:"No configurable expert roles."},
"sidebar.sessionModel.columnRole":{zh:"专家",en:"Expert"},
"sidebar.sessionModel.columnModel":{zh:"模型选择",en:"Model"},
"sidebar.sessionModel.tableLabel":{zh:"会话模型覆盖",en:"Session model overrides"},
"sidebar.sessionModel.saveChanges":{zh:"保存",en:"Save"},
"sidebar.sessionModel.invalidDraft":{
zh:"请为已修改的角色选择供应商和模型。",
en:"Choose a provider and model for every edited role.",
},
"sidebar.sessionModel.clearRole":{
zh:"清除{role}的本会话覆盖",
en:"Clear the session override for {role}",
},
"sidebar.sessionModel.orchestrator.applied":{
zh:"实际生效：{value}（{source}）",
en:"Applied: {value} ({source})",
},
"sidebar.sessionModel.orchestrator.pending":{
zh:"正在应用：{value}（{source}）",
en:"Applying: {value} ({source})",
},
"sidebar.sessionModel.orchestrator.unapplied":{
zh:"配置未生效：{value}（{source}）",
en:"Not applied: {value} ({source})",
},
"sidebar.sessionModel.orchestrator.manual":{zh:"本会话已手动接管",en:"Manually taken over in this session"},
"sidebar.sessionModel.orchestrator.none":{zh:"不干预",en:"Not configured"},
"sidebar.sessionModel.orchestrator.host-not-ready":{zh:"宿主未就绪",en:"Host not ready"},
"sidebar.sessionModel.orchestrator.degraded":{zh:"已降级到候选 {index}",en:"Degraded to candidate {index}"},
"sidebar.sessionModel.orchestrator.saved":{
zh:"已保存，主代理模型下一轮生效",
en:"Saved; the orchestrator model applies from the next turn",
},
"sidebar.sessionModel.orchestrator.source.override":{zh:"会话覆盖",en:"Session override"},
"sidebar.sessionModel.orchestrator.source.period":{zh:"当前时段",en:"Current period"},
"sidebar.sessionModel.orchestrator.source.global":{zh:"全局配置",en:"Global config"},
"sidebar.sessionModel.orchestrator.source.none":{zh:"不干预",en:"Not configured"},
"settings.orchestrator.empty":{
zh:"未配置（不干预主代理模型）",
en:"Not configured (orchestrator model untouched)",
},
"settings.title":{zh:"dsh-expert-group",en:"dsh-expert-group"},
"settings.hint":{
zh:"专家模型使用 DSH 当前已配置的 provider 和模型目录。",
en:"Expert models use the providers and model catalog configured in DSH.",
},
"settings.taskManagement":{zh:"任务管理",en:"Task management"},
"settings.auto":{zh:"Auto",en:"Auto"},
"settings.autoTitle":{
zh:"自动打开运行中的子代理侧栏会话",
en:"Automatically open running subagent sidebar sessions",
},
"settings.sidebarEntry":{zh:"左侧栏入口",en:"Sidebar entry"},
"settings.notifications":{zh:"通知弹窗",en:"Notifications"},
"settings.notificationVolume":{zh:"通知音量",en:"Notification volume"},
"settings.notificationEvents":{zh:"通知事件",en:"Notification events"},
"settings.notificationVolume.range":{zh:"通知音量滑块",en:"Notification volume slider"},
"settings.notificationVolume.number":{zh:"通知音量数值",en:"Notification volume value"},
"settings.notificationEvent.completed":{zh:"任务完成",en:"Task completed"},
"settings.roleTimeout.aria":{zh:"角色默认超时",en:"Default role timeout"},
"settings.notificationEvent.completed.aria":{zh:"通知任务完成",en:"Notify on task completed"},
"settings.notificationEvent.waiting.aria":{zh:"通知等待用户",en:"Notify on waiting for user"},
"settings.notificationEvent.failed.aria":{zh:"通知任务失败",en:"Notify on task failed"},
"settings.notificationEvent.waiting":{zh:"等待用户",en:"Waiting for user"},
"settings.notificationEvent.failed":{zh:"任务失败",en:"Task failed"},
"settings.unifiedProvider":{zh:"统一供应商",en:"Unified provider"},
"settings.noProvider":{zh:"无",en:"None"},
"settings.observerPreferred":{zh:"Observer优先",en:"Prefer Observer"},
"settings.concurrencyLimit":{zh:"单个角色并发上限",en:"Per-role concurrency limit"},
"settings.concurrencyLimit.title":{
zh:"取值范围 1–64 的整数；默认 20；保存后生效",
en:"An integer from 1–64; defaults to 20; takes effect after saving",
},
"settings.roleTimeout":{zh:"角色默认超时 (s)",en:"Default role timeout (s)"},
"settings.roleTimeout.title":{
zh:"默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
en:"Defaults to 10 hours (36000 s); 0 disables it; enabled values are 1–86400 s (integer, 1 s precision). Applies only to attempts created after saving; running shards are unchanged.",
},
"settings.save":{zh:"保存",en:"Save"},
"settings.saving":{zh:"保存中…",en:"Saving…"},
"settings.discard":{zh:"放弃修改",en:"Discard changes"},
"settings.saved":{zh:"已保存",en:"Saved"},
"settings.unsaved":{zh:"有未保存的修改",en:"Unsaved changes"},
"announce.start":{zh:"任务开始：{name}",en:"Task started: {name}"},
"announce.finish":{zh:"任务完成：{name}",en:"Task finished: {name}"},
"announce.fail":{zh:"任务失败：{name}",en:"Task failed: {name}"},
"announce.cancel":{zh:"任务取消：{name}",en:"Task cancelled: {name}"},
"announce.more":{zh:"等 {count} 项",en:"and {count} more"},
"notify.termination.title":{zh:"Expert Group",en:"Expert Group"},
"notify.termination.completed":{zh:"任务已完成。",en:"Task completed."},
"notify.termination.blocked":{zh:"任务被阻塞，需要你处理。",en:"Task blocked; your input is needed."},
"notify.termination.error":{zh:"任务因错误终止。",en:"Task terminated with an error."},
"notify.termination.aborted":{zh:"任务已中止。",en:"Task aborted."},
"notify.termination.interrupted":{zh:"任务被中断。",en:"Task interrupted."},
"notify.termination.max-tokens":{zh:"任务达到 token 上限。",en:"Task reached the token limit."},
"notify.termination.unknown":{zh:"任务已终止。",en:"Task terminated."},
"notify.test.title":{zh:"Expert Group",en:"Expert Group"},
"notify.wait.title":{zh:"Expert Group",en:"Expert Group"},
"notify.wait.body":{zh:"需要你操作",en:"Your action is required"},
"notify.test.body":{
zh:"测试通知：系统通知通道可用。",
en:"Test notification: the system notification channel is available.",
},
"notify.waitDeliveryFailed.body":{
zh:"专家批次已静止，但收口结论投递失败；批次保持待收口，插件会在后续 root turn 重试。",
en:"The expert batch is quiescent but delivering the finalization result failed; the batch remains pending and the plugin retries on later root turns.",
},
"sidebar.sessionDelete.row.aria":{zh:"删除「{title}」",en:"Delete \"{title}\""},
"sidebar.sessionDelete.menu":{zh:"删除会话",en:"Delete session"},
"sidebar.sessionDelete.multi":{zh:"删除多选会话",en:"Delete multiple sessions"},
"sidebar.sessionDelete.bar.selectAll":{zh:"全选",en:"Select all"},
"sidebar.sessionDelete.bar.deselectAll":{zh:"取消全选",en:"Deselect all"},
"sidebar.sessionDelete.bar.selected":{zh:"已选 {count}",en:"{count} selected"},
"sidebar.sessionDelete.bar.blocked":{zh:"{count} 个被占用",en:"{count} in use"},
"sidebar.sessionDelete.checkbox.aria":{zh:"选择「{title}」",en:"Select \"{title}\""},
"sidebar.sessionDelete.dialog.cancel":{zh:"取消",en:"Cancel"},
"sidebar.sessionDelete.dialog.confirm":{zh:"删除",en:"Delete"},
"sidebar.sessionDelete.dialog.running":{zh:"删除中…",en:"Deleting…"},
"sidebar.sessionDelete.dialog.title":{zh:"删除会话",en:"Delete session"},
"sidebar.sessionDelete.dialog.single":{zh:"确定删除「{title}」？",en:"Delete \"{title}\"?"},
"sidebar.sessionDelete.dialog.batch":{zh:"将处理 {count} 个会话。",en:"Processes {count} sessions."},
"sidebar.sessionDelete.dialog.absent":{zh:"其中 {count} 个仅清理残留配置。",en:"{count} are leftover-only."},
"sidebar.sessionDelete.dialog.blocked":{zh:"另有 {count} 个被占用，不会删除。",en:"{count} are in use and skipped."},
"sidebar.sessionDelete.dialog.first":{zh:"前 {count} 个：{titles}",en:"First {count}: {titles}"},
"sidebar.sessionDelete.dialog.irreversible":{zh:"此操作不可恢复。",en:"This cannot be undone."},
"sidebar.sessionDelete.blocked.title":{zh:"不可删除",en:"Cannot delete"},
"sidebar.sessionDelete.blocked.live":{zh:"该会话仍被 DSH 占用，重启 DSH 后可删除。",en:"In use by DSH; restart DSH to delete."},
"sidebar.sessionDelete.blocked.liveDescendant":{zh:"子会话「{title}」仍被占用，重启 DSH 后可删除。",en:"Sub-session \"{title}\" is in use; restart DSH."},
"sidebar.sessionDelete.blocked.pending":{zh:"上次删除的清理未完成，重启 DSH 后再试。",en:"Previous cleanup unfinished; restart DSH."},
"sidebar.sessionDelete.blocked.missing":{zh:"该会话不在本工作区可删除范围内。",en:"Not in this workspace's deletable set."},
"sidebar.sessionDelete.reason.skipped":{zh:"仍被占用",en:"still in use"},
"sidebar.sessionDelete.reason.failed":{zh:"删除失败",en:"delete failed"},
"sidebar.sessionDelete.reason.raced":{zh:"未完成（会话被重新打开，内容已保留）",en:"not deleted (reopened, kept)"},
"sidebar.sessionDelete.outcome.deleted":{zh:"已删除 {count} 个",en:"{count} deleted"},
"sidebar.sessionDelete.outcome.absent":{zh:"清理残留 {count} 个",en:"{count} leftover cleaned"},
"sidebar.sessionDelete.outcome.kept":{zh:"{count} 个未删除：{reasons}",en:"{count} not deleted: {reasons}"},
"sidebar.sessionDelete.outcome.join":{zh:"，",en:", "},
"sidebar.sessionDelete.outcome.reasonJoin":{zh:"、",en:", "},
"sidebar.sessionDelete.error.candidates":{zh:"读取可删除会话失败：{message}",en:"Cannot list deletable sessions: {message}"},
"sidebar.sessionDelete.error.delete":{zh:"删除失败：{message}",en:"Delete failed: {message}"},
});
function pad2(value){
return value<10?"0"+value:String(value);
}
function formatDuration(value){
const ms=numberOrNull(value);
if(ms===null)return null;
const clamped=Math.max(0,ms);
if(clamped<1000)return"<1s";
if(clamped<60000){
const seconds=(clamped/1000).toFixed(1);
return(seconds.endsWith(".0")?seconds.slice(0,-2):seconds)+"s";
}
if(clamped<3600000){
const minutes=Math.floor(clamped/60000);
const seconds=Math.floor((clamped%60000)/1000);
return minutes+"m "+seconds+"s";
}
const hours=Math.floor(clamped/3600000);
const minutes=Math.floor((clamped%3600000)/60000);
return minutes===0?hours+"h":hours+"h "+minutes+"m";
}
function formatClockTime(value){
const timestamp=numberOrNull(value);
if(timestamp===null)return null;
const date=new Date(timestamp);
if(Number.isNaN(date.getTime()))return null;
return pad2(date.getHours())+":"+pad2(date.getMinutes())+":"+pad2(date.getSeconds());
}
function formatIsoTime(value){
const timestamp=numberOrNull(value);
if(timestamp===null)return null;
const date=new Date(timestamp);
if(Number.isNaN(date.getTime()))return null;
return date.toISOString();
}
function formatFailureSummary(value){
const failure=normalizeFailure(value);
if(failure===null)return null;
const message=failure.message===null||failure.message.length<=FAILURE_MESSAGE_DISPLAY_MAX_LENGTH
?failure.message
:failure.message.slice(0,FAILURE_MESSAGE_DISPLAY_MAX_LENGTH-1)+"…";
return{code:failure.code,message};
}
function isFailureStatus(value){
return FAILURE_STATUSES.indexOf(normalizeStatus(value))!==-1;
}
function structuredFallbackText(reason){
return STRUCTURED_FALLBACK_REASON_SET.has(reason)
?STRUCTURED_FALLBACK_REASONS[reason]
:STRUCTURED_FALLBACK_REASONS.result_unavailable;
}
function structuredPreviewOf(value,options){
const structured=normalizeStructured(value);
if(structured===null)return null;
const optionSource=isObject(options)?options:{};
const rawLimit=numberOrNull(optionSource.maxChars);
const limit=rawLimit!==null&&rawLimit>0?Math.floor(rawLimit):STRUCTURED_PREVIEW_MAX_CHARS;
if(structured.value!==undefined){
let serialized="";
try{serialized=JSON.stringify(structured.value);}catch{serialized="";}
if(serialized.length===0){
return{text:null,truncated:false,fallback:true,reason:structured.reason??"result_unavailable"};
}
const truncated=serialized.length>limit;
return{
text:truncated?serialized.slice(0,limit):serialized,
truncated,
fallback:structured.fallback===true,
reason:structured.reason??null,
};
}
if(structured.fallback===true||typeof structured.reason==="string"){
return{text:null,truncated:false,fallback:true,reason:structured.reason??"missing_structured"};
}
return null;
}
function formatTokenCount(value){
const count=countOrNull(value);
if(count===null)return null;
if(count<1000)return String(count);
if(count<1000000){
const thousands=count/1000;
return(thousands<10?thousands.toFixed(1):String(Math.round(thousands)))+"k";
}
const millions=count/1000000;
return(millions<10?millions.toFixed(1):String(Math.round(millions)))+"M";
}
function formatDurationCompact(value){
const ms=numberOrNull(value);
if(ms===null)return null;
const clamped=Math.max(0,ms);
if(clamped<1000)return"<1s";
if(clamped<60000){
return Math.floor(clamped/1000)+"s";
}
if(clamped<3600000){
const minutes=Math.floor(clamped/60000);
const seconds=Math.floor((clamped%60000)/1000);
return seconds===0?minutes+"m":minutes+"m"+seconds+"s";
}
const hours=Math.floor(clamped/3600000);
const minutes=Math.floor((clamped%3600000)/60000);
return minutes===0?hours+"h":hours+"h"+minutes+"m";
}
function formatThroughputText(value){
const rounded=value>=10?String(Math.round(value)):value.toFixed(1);
return(rounded.endsWith(".0")?rounded.slice(0,-2):rounded)+"tok/s";
}
const ZERO_USAGE_TEXTS=Object.freeze({
durationText:"0s",
throughputText:"0tok/s",
totalTokensText:"0 tok",
cacheHitText:"命中0%",
contextText:"context 0%",
});
function summarizeUsageMetrics(usage,options){
const source=isObject(usage)?usage:{};
const settings=isObject(options)?options:{};
const durationMs=countOrNull(settings.durationMs);
const durationText=formatDurationCompact(durationMs);
const outputTokens=countOrNull(source.outputTokens);
const billedInput=countOrNull(source.billedInputTokens);
let totalTokens=countOrNull(source.totalTokens);
if(totalTokens===null&&billedInput!==null&&outputTokens!==null){
totalTokens=billedInput+outputTokens;
}
const totalTokensText=totalTokens===null?null:(formatTokenCount(totalTokens)??null)+" tok";
let tokensPerSecond=null;
let throughputText=null;
const measured=numberOrNull(settings.measuredTokensPerSecond);
if(measured!==null&&measured>=0.1){
tokensPerSecond=measured;
throughputText=formatThroughputText(measured);
}else if(durationMs!==null&&durationMs>=1000&&outputTokens!==null&&outputTokens>0){
const value=outputTokens/(durationMs/1000);
if(Number.isFinite(value)&&value>=0.1){
tokensPerSecond=value;
throughputText=formatThroughputText(value);
}
}
const cacheRead=countOrNull(source.cacheReadTokens);
let cacheHitPercent=null;
if(cacheRead!==null&&billedInput!==null&&billedInput>0){
cacheHitPercent=Math.min(100,Math.round((cacheRead/billedInput)*100));
}
const cacheHitText=cacheHitPercent===null?null:"命中"+cacheHitPercent+"%";
const pressure=isObject(settings.contextPressure)?settings.contextPressure:{};
const contextUsedTokens=countOrNull(pressure.projectedTokens)??countOrNull(pressure.pressureTokens);
const contextWindow=countOrNull(pressure.contextWindow);
let contextPercent=null;
if(contextUsedTokens!==null&&contextWindow!==null&&contextWindow>0){
contextPercent=Math.min(100,Math.round((contextUsedTokens/contextWindow)*100));
}
const contextText=contextPercent===null?null:"context "+contextPercent+"%";
return{
durationMs,
durationText,
tokensPerSecond,
throughputText,
totalTokens,
totalTokensText,
cacheHitPercent,
cacheHitText,
contextPercent,
contextText,
contextUsedTokens,
contextWindow,
};
}
function isEmptyUsageMetrics(summary){
if(!isObject(summary))return false;
if(summary.durationText!==null)return false;
if(summary.throughputText!==null)return false;
if(summary.totalTokens!==null&&summary.totalTokens!==0)return false;
if(summary.cacheHitText!==null)return false;
if(summary.contextPercent!==null&&summary.contextPercent!==0)return false;
return true;
}
function zeroFilledUsageMetrics(summary,options){
const source=isObject(summary)?summary:{};
const settings=isObject(options)?options:{};
const metrics={...source};
const filled={
durationText:false,
throughputText:false,
totalTokensText:false,
cacheHitText:false,
contextText:false,
};
for(const key of["durationText","throughputText","totalTokensText","cacheHitText","contextText"]){
if(key==="contextText"&&settings.skipContext===true){
if(typeof source[key]!=="string")metrics[key]=null;
continue;
}
if(typeof source[key]==="string")continue;
metrics[key]=ZERO_USAGE_TEXTS[key];
filled[key]=true;
}
return{metrics,filled};
}
function redactDisplayText(value,maxLength){
const raw=typeof value==="string"?value:(value instanceof Error?value.message:"");
const collapsed=raw
.replace(/[\u0000-\u001f\u007f-\u009f]+/g," ")
.replace(/\s+/g," ")
.trim();
if(collapsed.length===0)return"";
const limit=numberOrNull(maxLength)!==null&&maxLength>0?Math.floor(maxLength):160;
return redactFailurePaths(collapsed).slice(0,limit);
}
function titleCaseRole(value,fallback){
const source=text(value);
if(source===null)return fallback;
return source
.split(/[\s_-]+/)
.filter(Boolean)
.map((part)=>part.charAt(0).toUpperCase()+part.slice(1).toLowerCase())
.join(" ")||fallback;
}
function formatExpertMetadata(node,options){
const source=isObject(node)?node:{};
const optionSource=isObject(options)?options:{};
const explicitLabel=text(source.roleLabel)??roleLabelFrom(source.role,optionSource.roleLabels);
const role=explicitLabel??titleCaseRole(source.role,source.kind==="root"?"Orchestrator":"Expert");
const provider=text(source.provider)||"未知供应商";
const model=text(source.model)||"未知模型";
const rawEffort=firstText(source.effort,source.reasoningEffort);
const effort=rawEffort===null?"默认":rawEffort.charAt(0).toUpperCase()+rawEffort.slice(1);
return[role,provider,model,effort].join(" · ");
}
function attemptTimelineOf(value,options){
const source=isObject(value)?value:{};
const optionSource=isObject(options)?options:{};
const limit=numberOrNull(optionSource.limit)!==null&&optionSource.limit>0
?Math.floor(optionSource.limit)
:ATTEMPT_TIMELINE_LIMIT;
const expanded=optionSource.expanded===true;
const entries=[];
const appendAttempts=(attempts,shard)=>{
if(!Array.isArray(attempts))return;
for(const attempt of attempts){
const normalized=normalizeAttempt(attempt);
entries.push({
...normalized,
position:entries.length+1,
shardId:shard===null?null:text(shard.shardId),
shardTaskName:shard===null?null:firstText(shard.taskName,shard.shardId),
});
}
};
const shards=Array.isArray(source.shards)?source.shards:[];
if(shards.length>0){
for(const shard of shards){
const shardSource=isObject(shard)?shard:{};
appendAttempts(shardSource.attempts,shardSource);
}
}else{
appendAttempts(source.attempts,null);
}
const keyed=entries.map((entry,index)=>({
entry,
index,
at:numberOrNull(entry.finishedAt)??numberOrNull(entry.startedAt)??Number.NEGATIVE_INFINITY,
}));
keyed.sort((left,right)=>{
if(left.at===right.at)return left.index-right.index;
return left.at<right.at?-1:1;
});
const ordered=keyed.map((item)=>item.entry);
const total=ordered.length;
return{
total,
limit,
expanded,
hasMore:total>limit,
entries:expanded?ordered:ordered.slice(Math.max(0,total-limit)),
};
}
function normalizeFilterKey(value){
const source=text(value);
return source===null?null:source.toLowerCase();
}
function statusGroupOf(value){
const key=normalizeFilterKey(value);
if(key===null)return null;
return Object.prototype.hasOwnProperty.call(STATUS_FILTER_GROUPS,key)?key:null;
}
function filterHaystackOf(value){
const source=isObject(value)?value:{};
return[source.taskName,source.role,source.model,source.provider,source.status,source.shardId]
.filter((item)=>typeof item==="string"&&item.trim()!=="")
.join(" ")
.toLowerCase();
}
function createTaskFilter(input){
const source=isObject(input)?input:{};
const query=normalizeFilterKey(source.query);
const role=normalizeFilterKey(source.role);
const statusGroup=statusGroupOf(source.status);
const statuses=statusGroup===null?null:new Set(STATUS_FILTER_GROUPS[statusGroup]);
const active=query!==null||role!==null||statuses!==null;
const matches=(value)=>{
if(active!==true)return true;
const node=isObject(value)?value:{};
if(role!==null&&normalizeFilterKey(node.role)!==role)return false;
if(statuses!==null&&statuses.has(normalizeStatus(node.status))!==true)return false;
if(query!==null&&filterHaystackOf(node).indexOf(query)===-1)return false;
return true;
};
const visible=(value,depth)=>{
if(matches(value)===true)return true;
if(depth>=MAX_NESTED_EXPERT_DEPTH)return false;
const node=isObject(value)?value:{};
if(Array.isArray(node.children)&&node.children.some((child)=>visible(child,depth+1)===true))return true;
if(Array.isArray(node.shards)&&node.shards.some((shard)=>visible(shard,depth+1)===true))return true;
return false;
};
return Object.freeze({
query,
role,
status:statusGroup,
active,
matches,
isVisible:(value)=>visible(value,0),
shardsFor:(value)=>{
const node=isObject(value)?value:{};
const shards=Array.isArray(node.shards)?node.shards:[];
if(active!==true)return shards;
return shards.filter((shard)=>visible(shard,1)===true);
},
});
}
function filterSnapshot(snapshot,input){
if(!isObject(snapshot)||!isObject(snapshot.root))return snapshot??null;
const filter=createTaskFilter(input);
if(filter.active!==true)return snapshot;
const filterNode=(value)=>{
if(filter.isVisible(value)!==true)return null;
const node=isObject(value)?value:{};
if(node.kind==="fanout")return{...node,shards:filter.shardsFor(node)};
if(Array.isArray(node.children)&&node.children.length>0){
return{...node,children:node.children.map(filterNode).filter((child)=>child!==null)};
}
return node;
};
const children=(Array.isArray(snapshot.root.children)?snapshot.root.children:[])
.map(filterNode)
.filter((node)=>node!==null);
return{...snapshot,root:{...snapshot.root,children}};
}
function sanitizeExportFilePart(value){
const cleaned=String(value).replace(/[^A-Za-z0-9._-]+/g,"-").replace(/^-+|-+$/g,"");
return cleaned.slice(0,48)||"snapshot";
}
function markdownTextOf(value,fallback){
const source=text(value);
if(source===null)return fallback;
return source.replace(/[\r\n]+/g," ").trim()||fallback;
}
function markdownAttemptLines(attempts){
const lines=[];
const list=Array.isArray(attempts)?attempts:[];
list.forEach((value,index)=>{
const attempt=normalizeAttempt(value);
const number=attempt.attempt===null?index+1:attempt.attempt;
const parts=["#"+number,attempt.status];
const duration=formatDuration(attempt.durationMs);
if(duration!==null)parts.push(duration);
const started=formatIsoTime(attempt.startedAt);
const finished=formatIsoTime(attempt.finishedAt);
if(started!==null)parts.push("started "+started);
if(finished!==null)parts.push("finished "+finished);
const attemptUsage=normalizeUsage(attempt.usage);
if(attemptUsage!==null){
const tokens=countOrNull(attemptUsage.totalTokens)??countOrNull(attemptUsage.inputTokens);
if(tokens!==null)parts.push("tokens "+tokens);
if(countOrNull(attemptUsage.requests)!==null)parts.push("requests "+attemptUsage.requests);
}
const attemptStructured=structuredPreviewOf(attempt.structured);
if(attemptStructured!==null){
parts.push(attemptStructured.text===null
?"structured fallback "+(attemptStructured.reason??"result_unavailable")
:"structured "+attemptStructured.text+(attemptStructured.truncated?" …":""));
}
if(attempt.failure!==null){
parts.push("failure "+attempt.failure.code+(attempt.failure.message===null?"":" · "+attempt.failure.message));
}
lines.push("  - "+parts.join(" · "));
});
return lines;
}
function markdownTimelineBullets(source){
const lines=[];
const parts=[];
const started=formatIsoTime(source.startedAt);
const finished=formatIsoTime(source.finishedAt);
const duration=formatDuration(source.durationMs);
const lastActivity=formatIsoTime(source.lastActivityAt);
if(started!==null)parts.push("开始 "+started);
if(finished!==null)parts.push("完成 "+finished);
if(duration!==null)parts.push("耗时 "+duration);
if(lastActivity!==null)parts.push("最近活动 "+lastActivity);
if(parts.length>0)lines.push("- "+parts.join(" · "));
const attempts=numberOrNull(source.attemptCount);
const retries=numberOrNull(source.retryCount);
if(attempts!==null||retries!==null){
const counts=[];
if(attempts!==null)counts.push("尝试 "+attempts+" 次");
if(retries!==null)counts.push("重试 "+retries+" 次");
lines.push("- "+counts.join(" · "));
}
return lines;
}
function usageMarkdownText(value){
const usage=normalizeUsage(value);
if(usage===null)return"—";
const parts=[];
const labels=[["inputTokens","输入"],["outputTokens","输出"],["cacheReadTokens","缓存读"],["cacheWriteTokens","缓存写"],["reasoningTokens","推理"]];
for(const[field,label]of labels){
if(countOrNull(usage[field])!==null)parts.push(label+" "+usage[field]);
}
const counts=[["requests","请求"],["retries","重试"],["fallbacks","降级"]];
for(const[field,label]of counts){
if(countOrNull(usage[field])!==null)parts.push(label+" "+usage[field]);
}
const duration=formatDuration(usage.runMs);
if(duration!==null)parts.push("运行时长 "+duration);
return parts.length===0?"—":parts.join(" · ");
}
function structuredMarkdownText(value){
const preview=structuredPreviewOf(value);
if(preview===null)return"—";
if(preview.text!==null)return preview.text+(preview.truncated?"…（已截断）":"");
return structuredFallbackText(preview.reason)+"（"+(preview.reason??"result_unavailable")+"）";
}
function markdownNodeLines(node,level){
const source=isObject(node)?node:{};
const lines=[];
const kind=source.kind==="fanout"
?"fanout"
:(source.kind==="root"?"root":(source.kind==="shard"?"shard":"expert"));
const name=markdownTextOf(firstText(source.taskName,source.shardId,source.sessionId,source.parentTaskId),"未命名任务");
const heading="#".repeat(Math.min(6,Math.max(1,level)));
if(kind==="root")lines.push(heading+" 主代理");
else if(kind==="fanout")lines.push(heading+" Fan-out 任务："+name);
else if(kind==="shard")lines.push(heading+" 分片："+name);
else lines.push(heading+" 专家："+name);
const meta=[];
const role=text(source.role);
const roleLabel=text(source.roleLabel);
if(role!==null)meta.push("角色："+(roleLabel===null?role:roleLabel+"（"+role+"）"));
const provider=text(source.provider);
if(provider!==null)meta.push("provider："+provider);
const model=text(source.model);
if(model!==null)meta.push("模型："+model);
const effort=firstText(source.effort,source.reasoningEffort);
if(effort!==null)meta.push("effort："+effort);
if(meta.length>0)lines.push("- "+meta.join(" · "));
const statusParts=["状态："+normalizeStatus(source.status)];
if(kind==="fanout"&&text(source.taskStatus)!==null&&source.taskStatus!==source.status){
statusParts.push("原始状态："+text(source.taskStatus));
}
lines.push("- "+statusParts.join(" · "));
lines.push("- 用量："+usageMarkdownText(source.usage));
const structuredPreview=structuredPreviewOf(source.structured);
if(structuredPreview!==null||source.outputSchemaRequested===true){
lines.push("- 结构化结果："+(structuredPreview===null?"尚未返回":structuredMarkdownText(source.structured)));
}
lines.push(...markdownTimelineBullets(source));
const failure=normalizeFailure(source.failure);
if(failure!==null&&isFailureStatus(source.status)===true){
lines.push("- 失败："+failure.code+(failure.message===null?"":" · "+failure.message));
}
const shards=Array.isArray(source.shards)?source.shards:[];
const attempts=Array.isArray(source.attempts)?source.attempts:[];
if(attempts.length>0){
lines.push("- 尝试时间线（"+attempts.length+" 条）：");
lines.push(...markdownAttemptLines(attempts));
}
return{lines,shards,children:Array.isArray(source.children)?source.children:[]};
}
function renderMarkdownSnapshot(snapshot){
const source=isObject(snapshot)?snapshot:{};
const lines=[];
lines.push("# Expert Group 任务树","");
lines.push("- 根会话："+markdownTextOf(firstText(source.rootSessionId,source.sessionId),"未命名会话"));
const generated=formatIsoTime(source.generatedAt);
lines.push("- 快照生成时间："+(generated===null?"未知":generated));
lines.push("- 快照完整性："+(source.partial===true?"轻量（partial）":"完整"));
const revision=text(source.revision);
if(revision!==null)lines.push("- 内容摘要："+revision);
lines.push("- 导出范围：任务树元数据与时间线（不含提示词正文）","");
const emit=(value,level)=>{
const parsed=markdownNodeLines(value,level);
lines.push(...parsed.lines,"");
for(const shard of parsed.shards){
const shardSource=isObject(shard)?shard:{};
emit({
...shardSource,
kind:"shard",
taskName:firstText(shardSource.taskName,shardSource.shardId),
},level+1);
}
for(const child of parsed.children)emit(child,level+1);
};
emit(source.root,1);
return lines.join("\n").replace(/\n{3,}/g,"\n\n").trimEnd()+"\n";
}
function serializeSnapshot(snapshot,options){
if(!isObject(snapshot))return null;
const optionSource=isObject(options)?options:{};
const format=optionSource.format==="json"?"json":"markdown";
const now=numberOrNull(optionSource.now)??Date.now();
const rootPart=sanitizeExportFilePart(firstText(snapshot.rootSessionId,snapshot.sessionId)??"snapshot");
const filename="expert-group-"+rootPart+"-"+Math.floor(Math.max(0,now))+(format==="json"?".json":".md");
return Object.freeze({
format,
filename,
mimeType:format==="json"?"application/json;charset=utf-8":"text/markdown;charset=utf-8",
content:format==="json"?JSON.stringify(snapshot,null,2):renderMarkdownSnapshot(snapshot),
});
}
function defaultExpanded(node){
if(isObject(node)&&node.kind==="root")return true;
if(isObject(node)&&node.kind==="idle-group")return true;
const status=normalizeStatus(isObject(node)?(node.status??node.taskStatus):undefined);
if(isObject(node)&&node.kind==="fanout")return!FANOUT_SETTLED_STATUSES.has(status);
return!DEFAULT_COLLAPSED_STATUSES.has(status);
}
function taskIdOf(value){
if(typeof value==="string")return text(value)||"unknown";
const source=isObject(value)?value:{};
return firstText(source.taskId,source.id,source.parentTaskId,source.sessionId,source.shardId)||"unknown";
}
function safeStorage(storage){
if(storage&&typeof storage.getItem==="function"&&typeof storage.setItem==="function")return storage;
try{
const candidate=global.sessionStorage;
if(candidate&&typeof candidate.getItem==="function"&&typeof candidate.setItem==="function")return candidate;
}catch{/* 某些浏览器隐私模式访问 sessionStorage 会同步抛错，按无持久化降级。 */}
return null;
}
function createExpansionStore(options){
const config=isObject(options)?options:{};
const storage=safeStorage(config.storage);
const rootSessionId=text(config.rootSessionId)||"unknown";
const keyFor=(value)=>"dsh-expert-group:expansion:v"+SCHEMA_VERSION+":"+encodeURIComponent(rootSessionId)+":"+encodeURIComponent(taskIdOf(value));
const readOverride=(key)=>{
if(storage===null)return undefined;
try{
const raw=storage.getItem(key);
if(raw===null||raw===undefined)return undefined;
if(raw==="true")return true;
if(raw==="false")return false;
const parsed=JSON.parse(raw);
if(typeof parsed==="boolean")return parsed;
if(isObject(parsed)&&typeof parsed.expanded==="boolean"
&&(parsed.schemaVersion===undefined||parsed.schemaVersion===SCHEMA_VERSION))return parsed.expanded;
}catch{/* 损坏内容和存储读错误都只表示没有手动 override。 */}
return undefined;
};
const isExpanded=(value)=>{
const override=readOverride(keyFor(value));
return override===undefined?defaultExpanded(value):override;
};
const setExpanded=(value,expanded)=>{
const next=expanded===true;
if(storage!==null){
try{
storage.setItem(keyFor(value),JSON.stringify({schemaVersion:SCHEMA_VERSION,rootSessionId,taskId:taskIdOf(value),expanded:next}));
}catch{/* 配额或隐私策略拒绝写入时仍保留本次渲染的默认行为。 */}
}
return next;
};
const toggle=(value)=>setExpanded(value,!isExpanded(value));
const clear=(value)=>{
if(storage===null||typeof storage.removeItem!=="function")return;
try{storage.removeItem(keyFor(value));}catch{/* 清理失败不影响页面。 */}
};
return Object.freeze({
rootSessionId,keyFor,isExpanded,get:isExpanded,
setExpanded,set:setExpanded,toggle,clear,
});
}
function normalizeLocale(value){
if(typeof value!=="string")return null;
const primary=value.trim().toLowerCase().split(/[-_]/)[0];
if(primary==="zh")return"zh";
if(primary==="en")return"en";
return null;
}
function resolveLocale(candidates){
for(const candidate of Array.isArray(candidates)?candidates:[]){
const normalized=normalizeLocale(candidate);
if(normalized!==null)return normalized;
}
return DEFAULT_LOCALE;
}
function resolveClientLocale(sources={}){
const source=isObject(sources)?sources:{};
const tabInfo=isObject(source.tabInfo)?source.tabInfo:{};
const documentLang=typeof source.documentLang==="string"?source.documentLang:null;
const navigatorLanguage=typeof source.navigatorLanguage==="string"?source.navigatorLanguage:null;
return resolveLocale([
source.ctxLocale,
source.i18nLocale,
tabInfo.locale,
tabInfo.tab?.locale,
documentLang,
navigatorLanguage,
]);
}
function translateMessage(locale,key,vars={}){
const normalized=normalizeLocale(locale)??DEFAULT_LOCALE;
const entry=MESSAGE_CATALOG[key];
if(entry===undefined||entry===null)return MISSING_MESSAGE_TEXT;
const template=typeof entry[normalized]==="string"&&entry[normalized].length>0
?entry[normalized]
:(typeof entry[DEFAULT_LOCALE]==="string"?entry[DEFAULT_LOCALE]:"");
if(template.length===0)return MISSING_MESSAGE_TEXT;
const values=isObject(vars)?vars:{};
return template.replace(/\{([a-z][a-z0-9_]*)\}/gi,(match,name)=>{
const value=values[name];
return value===undefined||value===null?match:String(value);
});
}
global[SYMBOL]=Object.freeze({
FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
RETRY_WARNING_THRESHOLD,
STATUS_FILTER_GROUPS,
STRUCTURED_PREVIEW_MAX_CHARS,
formatFailureSummary,
isFailureStatus,
formatDuration,
formatClockTime,
formatIsoTime,
attemptTimelineOf,
structuredFallbackText,
structuredPreviewOf,
formatTokenCount,
redactDisplayText,
createTaskFilter,
filterSnapshot,
serializeSnapshot,
formatDurationCompact,
summarizeUsageMetrics,
isEmptyUsageMetrics,
zeroFilledUsageMetrics,
formatExpertMetadata,
defaultExpanded,
createExpansionStore,
SUPPORTED_LOCALES,
DEFAULT_LOCALE,
MISSING_MESSAGE_TEXT,
MESSAGE_CATALOG,
normalizeLocale,
resolveClientLocale,
translateMessage,
});
})(globalThis);
/* source: client-expert-group-model.js */
(function installExpertGroupModel(global){
"use strict";
const normalizeSymbol=Symbol.for("dsh-expert-group/client-expert-group-model-normalize");
const formatSymbol=Symbol.for("dsh-expert-group/client-expert-group-model-format");
const normalize=global[normalizeSymbol];
const format=global[formatSymbol];
if(!normalize||!format){
throw new Error("专家组客户端模型子模块未装载：normalize / format 检查点缺失（装配顺序见 client-source-manifest.mjs）");
}
const{
RUNTIME_STATUSES,
UNKNOWN_RUNTIME_STATUS,
normalizeExpertGroupSnapshot,
normalizeCapabilities,
normalizeFailure,
normalizeUsage,
normalizeStructured,
roleLabelFrom,
roleLabelOf,
findModelPrice,
estimateUsageCost,
runtimeStatusOf,
}=normalize;
const{
FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
RETRY_WARNING_THRESHOLD,
STATUS_FILTER_GROUPS,
STRUCTURED_PREVIEW_MAX_CHARS,
formatFailureSummary,
isFailureStatus,
formatDuration,
formatClockTime,
formatIsoTime,
attemptTimelineOf,
structuredFallbackText,
structuredPreviewOf,
formatTokenCount,
redactDisplayText,
createTaskFilter,
filterSnapshot,
serializeSnapshot,
formatDurationCompact,
summarizeUsageMetrics,
isEmptyUsageMetrics,
zeroFilledUsageMetrics,
formatExpertMetadata,
defaultExpanded,
createExpansionStore,
SUPPORTED_LOCALES,
DEFAULT_LOCALE,
MISSING_MESSAGE_TEXT,
MESSAGE_CATALOG,
normalizeLocale,
resolveClientLocale,
translateMessage,
}=format;
const SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-model");
global[SYMBOL]=Object.freeze({
RUNTIME_STATUSES,
UNKNOWN_RUNTIME_STATUS,
FAILURE_MESSAGE_DISPLAY_MAX_LENGTH,
RETRY_WARNING_THRESHOLD,
STATUS_FILTER_GROUPS,
normalizeExpertGroupSnapshot,
normalizeCapabilities,
normalizeFailure,
formatFailureSummary,
isFailureStatus,
formatDuration,
formatClockTime,
formatIsoTime,
attemptTimelineOf,
STRUCTURED_PREVIEW_MAX_CHARS,
normalizeUsage,
normalizeStructured,
structuredFallbackText,
structuredPreviewOf,
roleLabelFrom,
roleLabelOf,
findModelPrice,
estimateUsageCost,
formatTokenCount,
redactDisplayText,
createTaskFilter,
filterSnapshot,
serializeSnapshot,
runtimeStatusOf,
formatDurationCompact,
summarizeUsageMetrics,
isEmptyUsageMetrics,
zeroFilledUsageMetrics,
formatExpertMetadata,
defaultExpanded,
createExpansionStore,
SUPPORTED_LOCALES,
DEFAULT_LOCALE,
MISSING_MESSAGE_TEXT,
MESSAGE_CATALOG,
normalizeLocale,
resolveClientLocale,
translateMessage,
});
})(globalThis);
/* source: client-sidebar-auto-ledger.js */
(function installClientSidebarAutoLedger(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const SIDEBAR_SHARED_AUTO_LEDGER_KEY=Symbol.for("dsh-expert-group/sidebar#shared-auto-ledger");
const SIDEBAR_SHARED_AUTO_LEDGER_VERSION=1;
const SIDEBAR_AUTO_OWNERSHIP_KEY="dsh-expert-group:auto-ownership:v1";
const SIDEBAR_AUTO_OWNERSHIP_LIMIT=128;
const SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT=4*SIDEBAR_AUTO_OWNERSHIP_LIMIT;
const SIDEBAR_AUTO_OWNERSHIP_TTL_MS=7*24*60*60*1000;
const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO="auto";
const SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL="manual";
const SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY=Symbol.for("dsh-expert-group/sidebar#auto-ownership-memory");
const SIDEBAR_AUTO_DIAG_KEY="dsh-expert-group:auto-diag:v1";
const SIDEBAR_AUTO_DIAG_LIMIT=60;
const SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS=360;
const SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS=96;
const SIDEBAR_SHARED_AUTO_LEDGER_FIELDS=[
"origin","suppressed","closeAttempts","closeAttemptOwners",
"closeVerifications","closeCooldowns","tabMisses","tabCloseInFlight",
];
const sidebarRealmHost=()=>{
try{
return typeof globalThis==="object"&&globalThis!==null?globalThis:null;
}catch{
return null;
}
};
const sidebarLocalStorage=()=>{
try{
const host=sidebarRealmHost();
const storage=host===null?null:host.localStorage;
if(storage===null||storage===undefined)return null;
if(typeof storage.getItem!=="function"||typeof storage.setItem!=="function")return null;
return storage;
}catch{
return null;
}
};
const sidebarBoundedText=(value)=>{
if(value===null||value===undefined)return undefined;
const text=typeof value==="string"?value:String(value);
if(text.length===0)return undefined;
return text.length>SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS?text.slice(0,SIDEBAR_AUTO_DIAG_TEXT_MAX_CHARS):text;
};
const sidebarAutoKeyDigest=(key)=>{
const source=typeof key==="string"?key:String(key);
let hash=0x811c9dc5;
for(let index=0;index<source.length;index+=1){
hash^=source.charCodeAt(index);
hash=Math.imul(hash,0x01000193)>>>0;
}
return"k"+hash.toString(36);
};
const sidebarAutoScopedKey=(sessionId,rootId,address)=>String(sessionId)+"|"+String(rootId)+"|"+String(address);
const sidebarAutoOriginEntry=(sessionId,rootId,address,tabId)=>({
sessionId,
rootSessionId:rootId,
address,
tabId:typeof tabId==="string"&&tabId.length>0?tabId:null,
writtenAt:Date.now(),
});
const sidebarAutoOriginTabIdOf=(entry)=>{
if(entry===null||entry===undefined||typeof entry!=="object")return null;
return typeof entry.tabId==="string"&&entry.tabId.length>0?entry.tabId:null;
};
const sidebarAutoOriginWrittenAtOf=(entry)=>{
if(entry===null||entry===undefined||typeof entry!=="object")return 0;
const value=Number(entry.writtenAt);
return Number.isFinite(value)?value:0;
};
const recordSidebarAutoDiag=(entry)=>{
try{
const storage=sidebarLocalStorage();
if(storage===null)return;
const source=entry!==null&&typeof entry==="object"?entry:{};
const normalized={t:Date.now()};
for(const field of["kind","event","action","verdict","reason","key","origin"]){
const value=sidebarBoundedText(source[field]);
if(value!==undefined)normalized[field]=value;
}
if(source.reused===true)normalized.reused=true;
if(source.degraded===true)normalized.degraded=true;
if(source.sizes!==null&&typeof source.sizes==="object"){
const sizes={};
for(const name of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS){
const value=Number(source.sizes[name]);
if(Number.isFinite(value)===true)sizes[name]=Math.max(0,Math.trunc(value));
}
normalized.sizes=sizes;
}
let serialized=JSON.stringify(normalized);
if(serialized.length>SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS){
delete normalized.sizes;
serialized=JSON.stringify(normalized);
}
if(serialized.length>SIDEBAR_AUTO_DIAG_ENTRY_MAX_CHARS)return;
let list=[];
const raw=storage.getItem(SIDEBAR_AUTO_DIAG_KEY);
if(typeof raw==="string"&&raw.length>0){
const parsed=JSON.parse(raw);
if(Array.isArray(parsed)===true)list=parsed.slice(-SIDEBAR_AUTO_DIAG_LIMIT);
}
list.push(JSON.parse(serialized));
storage.setItem(SIDEBAR_AUTO_DIAG_KEY,JSON.stringify(list.slice(-SIDEBAR_AUTO_DIAG_LIMIT)));
}catch{
}
};
const createSidebarSharedAutoLedger=()=>{
const ledger={version:SIDEBAR_SHARED_AUTO_LEDGER_VERSION,createdAt:Date.now()};
for(const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS)ledger[field]=new Map();
return ledger;
};
const isSidebarSharedAutoLedger=(value)=>{
if(value===null||typeof value!=="object")return false;
if(value.version!==SIDEBAR_SHARED_AUTO_LEDGER_VERSION)return false;
for(const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS){
const map=value[field];
if(map===null||typeof map!=="object"||typeof map.get!=="function"||typeof map.set!=="function")return false;
}
return true;
};
const sidebarSharedAutoLedgerSizes=(ledger)=>{
const sizes={};
for(const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS){
const map=ledger===null||ledger===undefined?null:ledger[field];
sizes[field]=map!==null&&typeof map==="object"&&Number.isFinite(Number(map.size))?Number(map.size):0;
}
return sizes;
};
const sidebarSharedAutoLedgerTotal=(ledger)=>{
const sizes=sidebarSharedAutoLedgerSizes(ledger);
let total=0;
for(const field of SIDEBAR_SHARED_AUTO_LEDGER_FIELDS)total+=sizes[field];
return total;
};
const resolveSidebarSharedAutoLedger=()=>{
const host=sidebarRealmHost();
let existing=null;
if(host!==null){
try{existing=host[SIDEBAR_SHARED_AUTO_LEDGER_KEY];}catch{existing=null;}
}
if(isSidebarSharedAutoLedger(existing)===true){
return{ledger:existing,reused:true,degraded:false};
}
const created=createSidebarSharedAutoLedger();
let degraded=host===null;
if(host!==null){
try{
Object.defineProperty(host,SIDEBAR_SHARED_AUTO_LEDGER_KEY,{value:created,configurable:true,writable:true});
}catch{
degraded=true;
}
}
return{ledger:created,reused:false,degraded};
};
const sidebarOwnershipMemory=()=>{
const host=sidebarRealmHost();
if(host===null)return null;
try{
const existing=host[SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY];
if(existing?.entries instanceof Map)return existing;
}catch{return null;}
try{
const created={entries:new Map(),loaded:false,unpersisted:new Set()};
Object.defineProperty(host,SIDEBAR_AUTO_OWNERSHIP_MEMORY_KEY,{value:created,configurable:true,writable:true});
return created;
}catch{
return null;
}
};
const normalizeSidebarOwnershipEntries=(raw,now)=>{
const entries=new Map();
if(Array.isArray(raw)!==true)return entries;
for(const item of raw){
if(item===null||typeof item!=="object")continue;
if(typeof item.key!=="string")continue;
const key=item.key;
const updatedAt=Number(item.updatedAt);
if(!Number.isFinite(updatedAt)||now-updatedAt>SIDEBAR_AUTO_OWNERSHIP_TTL_MS)continue;
const origin=item.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
?SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
:SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
if(entries.get(key)?.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL)continue;
entries.delete(key);
entries.set(key,{
key,
origin,
updatedAt,
reason:sidebarBoundedText(item.reason),
tabId:sidebarBoundedText(item.tabId),
});
}
return entries;
};
const loadSidebarOwnershipEntries=()=>{
const storage=sidebarLocalStorage();
if(storage===null)return null;
try{
const raw=storage.getItem(SIDEBAR_AUTO_OWNERSHIP_KEY);
if(!raw)return new Map();
const parsed=JSON.parse(raw);
return Array.isArray(parsed)===true?normalizeSidebarOwnershipEntries(parsed,Date.now()):null;
}catch{
return null;
}
};
const sidebarOwnershipEntries=()=>{
const memory=sidebarOwnershipMemory();
if(memory===null)return loadSidebarOwnershipEntries();
if(memory.loaded!==true){
memory.loaded=true;
memory.entries=loadSidebarOwnershipEntries()??new Map();
}
return memory.entries;
};
const persistSidebarOwnership=(entries)=>{
try{
const storage=sidebarLocalStorage();
if(storage===null)throw new Error("storage-unavailable");
const list=[];
for(const entry of entries.values())list.push({...entry});
storage.setItem(SIDEBAR_AUTO_OWNERSHIP_KEY,JSON.stringify(list));
sidebarOwnershipMemory()?.unpersisted?.clear();
return true;
}catch{
recordSidebarAutoDiag({kind:"ownership",event:"persist-failed",reason:"write-rejected"});
return false;
}
};
const readSidebarAutoOwnershipEntry=(sessionId,rootId,address,options)=>{
try{
const key=sidebarAutoScopedKey(sessionId,rootId,address);
const entries=sidebarOwnershipEntries();
let entry=entries.get(key);
const authoritative=options?.authoritative===true;
if(entry!==undefined&&(authoritative===true||entry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL)
&&sidebarOwnershipMemory()?.unpersisted?.has(key)!==true){
const persisted=loadSidebarOwnershipEntries();
if(persisted!==null){
entry=persisted.get(key);
entries.delete(key);
if(entry===undefined)recordSidebarAutoDiag({kind:"ownership",event:"delete",reason:"stale-memory",key:sidebarAutoKeyDigest(key)});
else entries.set(key,entry);
}else if(authoritative===true&&sidebarLocalStorage()!==null){
return void 0;
}
}
const origin=entry===undefined?null:entry.origin;
if(options?.quiet!==true){
recordSidebarAutoDiag({kind:"ownership",event:"hit",origin,key:sidebarAutoKeyDigest(key)});
}
if(entry===undefined)return null;
return{
origin,
tabId:typeof entry.tabId==="string"&&entry.tabId.length>0?entry.tabId:null,
reason:entry.reason??null,
};
}catch{
return null;
}
};
const planSidebarOwnershipAutoWrite=(entries,prefix,key)=>{
let scopeAuto=0;
let totalAuto=0;
const others=[];
for(const[entryKey,entry]of entries){
if(entry.origin!==SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO)continue;
totalAuto+=1;
if(entryKey.startsWith(prefix))scopeAuto+=1;
else others.push([entryKey,entry.updatedAt]);
}
const existingIsAuto=entries.get(key)?.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO?1:0;
if(scopeAuto-existingIsAuto+1>SIDEBAR_AUTO_OWNERSHIP_LIMIT)return null;
const overflow=totalAuto-existingIsAuto+1-SIDEBAR_AUTO_OWNERSHIP_GLOBAL_LIMIT;
if(overflow<=0)return[];
if(overflow>64)return null;
others.sort((left,right)=>left[1]-right[1]);
return others.length<overflow?null:others.slice(0,overflow).map(([entryKey])=>entryKey);
};
const sidebarOwnershipAcceptsNewAuto=(sessionId,rootId,address)=>{
try{
return planSidebarOwnershipAutoWrite(sidebarOwnershipEntries(),sidebarAutoScopedKey(sessionId,rootId,""),sidebarAutoScopedKey(sessionId,rootId,address))!==null;
}catch{
return true;
}
};
const writeSidebarAutoOwnership=(sessionId,rootId,address,origin,reason,tabId)=>{
try{
const normalizedOrigin=origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
?SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
:SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO;
const entries=sidebarOwnershipEntries();
const key=sidebarAutoScopedKey(sessionId,rootId,address);
const plan=normalizedOrigin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
?planSidebarOwnershipAutoWrite(entries,sidebarAutoScopedKey(sessionId,rootId,""),key)
:[];
if(plan===null){
recordSidebarAutoDiag({kind:"ownership",event:"reject",origin:normalizedOrigin,reason:"capacity",key:sidebarAutoKeyDigest(key)});
return false;
}
for(const evictedKey of plan)entries.delete(evictedKey);
entries.delete(key);
entries.set(key,{
key,
origin:normalizedOrigin,
updatedAt:Date.now(),
reason:sidebarBoundedText(reason),
tabId:sidebarBoundedText(tabId),
});
if(persistSidebarOwnership(entries)!==true&&normalizedOrigin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL){
const memory=sidebarOwnershipMemory();
if(memory!==null)(memory.unpersisted??=new Set()).add(key);
}
recordSidebarAutoDiag({kind:"ownership",event:"write",origin:normalizedOrigin,reason,key:sidebarAutoKeyDigest(key),degraded:plan.length>0});
return true;
}catch{
return false;
}
};
const deleteSidebarAutoOwnership=(sessionId,rootId,address,reason,options)=>{
try{
const entries=sidebarOwnershipEntries();
const key=sidebarAutoScopedKey(sessionId,rootId,address);
const entry=entries.get(key);
if(entry===undefined){
recordSidebarAutoDiag({kind:"ownership",event:"delete-miss",reason,key:sidebarAutoKeyDigest(key)});
return false;
}
if(entry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL&&options?.manual!==true){
recordSidebarAutoDiag({kind:"ownership",event:"keep",origin:SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,reason,key:sidebarAutoKeyDigest(key)});
return false;
}
entries.delete(key);
persistSidebarOwnership(entries);
sidebarOwnershipMemory()?.unpersisted?.delete(key);
recordSidebarAutoDiag({kind:"ownership",event:"delete",reason,key:sidebarAutoKeyDigest(key)});
return true;
}catch{
return false;
}
};
const clearSidebarAutoManualSuppressions=(sessionId,rootId)=>{
try{
const entries=sidebarOwnershipEntries();
const prefix=sidebarAutoScopedKey(sessionId,rootId,"");
const keys=[...entries]
.filter(([key,entry])=>entry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL&&key.startsWith(prefix))
.map(([key])=>key);
for(const key of keys){
entries.delete(key);
sidebarOwnershipMemory()?.unpersisted?.delete(key);
}
if(keys.length>0)persistSidebarOwnership(entries);
return keys.length;
}catch{
return 0;
}
};
const purgeSidebarAutoOwnershipForSessions=(sessionIds)=>{
try{
const ids=new Set();
for(const entry of Array.isArray(sessionIds)?sessionIds:[]){
if(typeof entry==="string"&&entry.length>0)ids.add(entry);
}
if(ids.size===0)return{ok:true,removed:0};
const entries=sidebarOwnershipEntries();
if(entries===null)return{ok:false,removed:0};
const keys=[];
for(const key of entries.keys()){
if(typeof key!=="string")continue;
for(const id of ids){
if(key.startsWith(id+"|")||key.includes("|"+id+"|")===true){
keys.push(key);
break;
}
}
}
for(const key of keys){
entries.delete(key);
sidebarOwnershipMemory()?.unpersisted?.delete(key);
}
if(keys.length>0)persistSidebarOwnership(entries);
return{ok:true,removed:keys.length};
}catch{
return{ok:false,removed:0};
}
};
const recordSidebarAutoDecision=(event,candidate,verdict,reason)=>{
recordSidebarAutoDiag({
kind:"decision",
event,
action:candidate?.kind,
verdict,
reason,
key:candidate==null?undefined:sidebarAutoKeyDigest(candidate.key),
});
};
global[SYMBOL]=Object.freeze({
SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,clearSidebarAutoManualSuppressions,
deleteSidebarAutoOwnership,purgeSidebarAutoOwnershipForSessions,readSidebarAutoOwnershipEntry,
recordSidebarAutoDecision,recordSidebarAutoDiag,resolveSidebarSharedAutoLedger,sidebarAutoKeyDigest,
sidebarAutoOriginEntry,sidebarAutoOriginTabIdOf,sidebarAutoOriginWrittenAtOf,sidebarBoundedText,
sidebarLocalStorage,sidebarOwnershipAcceptsNewAuto,sidebarSharedAutoLedgerSizes,sidebarSharedAutoLedgerTotal,
writeSidebarAutoOwnership,
});
})(globalThis);
/* source: client-sidebar-pure.js */
(function installClientSidebarPure(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const AUTO_LEDGER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const AUTO_LEDGER=global[AUTO_LEDGER_SYMBOL]||{};
const{
sidebarLocalStorage,
}=AUTO_LEDGER;
const MODEL_SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-model");
const MODEL=global[MODEL_SYMBOL]||{};
const modelApi=()=>global[MODEL_SYMBOL]||MODEL;
const RUNTIME_STATUS_LABELS=Object.freeze({running:"running",ready:"ready",unknown:"unknown"});
const RUNTIME_STATE_DOT=Object.freeze({running:"ongoing",ready:"done",unknown:"idle"});
const TIMELINE_EXPANDED_KEY_LIMIT=256;
const ATTEMPT_STATUS_LABELS=Object.freeze({
queued:"排队",waiting:"等待",running:"运行中",succeeded:"成功",failed:"失败",
cancelled:"已取消",timed_out:"超时",interrupted:"已中断",idle:"空闲",ready:"就绪",unknown:"未知",
});
const STATUS_FILTER_OPTIONS=Object.freeze([
Object.freeze({value:"running",label:"运行中"}),
Object.freeze({value:"incomplete",label:"未完成"}),
Object.freeze({value:"completed",label:"已完成"}),
]);
const ACTIVE_STATUSES=new Set(["queued","waiting","running"]);
const RETRY_STATUSES=new Set(["failed","timed_out","interrupted"]);
const FANOUT_SETTLED_STATUSES=new Set(["succeeded","failed","cancelled"]);
const STYLE_ID="dsh-expert-group/expert-group-sidebar";
const RIGHTBAR_WIDTH_RATIO=0.2;
const OTHER_RIGHTBAR_WIDTH_RATIO=0.5;
const RIGHTBAR_WIDTH_RATIO_MIN=0.15;
const RIGHTBAR_WIDTH_RATIO_MAX=0.5;
const RIGHTBAR_WIDTH_PREFERENCE_KEY="dsh-expert-group/rightbar-width-ratio:v1";
function clampRightbarWidthRatio(value){
const numeric=typeof value==="number"?value:Number(value);
if(Number.isFinite(numeric)!==true)return null;
if(numeric<RIGHTBAR_WIDTH_RATIO_MIN)return RIGHTBAR_WIDTH_RATIO_MIN;
if(numeric>RIGHTBAR_WIDTH_RATIO_MAX)return RIGHTBAR_WIDTH_RATIO_MAX;
return numeric;
}
function readStoredRightbarWidthRatio(){
const storage=sidebarLocalStorage();
if(storage===null)return RIGHTBAR_WIDTH_RATIO;
let raw=null;
try{raw=storage.getItem(RIGHTBAR_WIDTH_PREFERENCE_KEY);}catch{raw=null;}
if(typeof raw!=="string"||raw.trim()==="")return RIGHTBAR_WIDTH_RATIO;
const clamped=clampRightbarWidthRatio(Number(raw.trim()));
return clamped===null?RIGHTBAR_WIDTH_RATIO:clamped;
}
function storeRightbarWidthRatio(value){
const clamped=clampRightbarWidthRatio(value);
if(clamped===null)return null;
const storage=sidebarLocalStorage();
if(storage===null)return clamped;
try{storage.setItem(RIGHTBAR_WIDTH_PREFERENCE_KEY,String(clamped));}catch{/* 见上：本次仍生效。 */}
return clamped;
}
const resolveExpertRightbarWidthRatio=()=>readStoredRightbarWidthRatio();
const RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX=1;
const RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS=2;
const BRAND_ICON_PATHS=Object.freeze([
"M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
"M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
"M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
"M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
]);
const RIGHTBAR_PANEL_SELECTOR="[data-sidebar-right-panel]";
const RIGHTBAR_PANEL_SESSION_ATTRIBUTE="data-sidebar-right-session";
const RIGHTBAR_TAB_SELECTOR="[data-dockkit-tab]";
const RIGHTBAR_TAB_ID_ATTRIBUTE="data-dockkit-tab";
const RIGHTBAR_PANE_SELECTOR="[data-dockkit-pane]";
const RIGHTBAR_PANE_ID_ATTRIBUTE="data-dockkit-pane";
const RIGHTBAR_PANE_COLUMN_ATTRIBUTE="data-dockkit-column";
const RIGHTBAR_SPLIT_SELECTOR="[data-dockkit-split]";
const RIGHTBAR_SPLIT_ATTRIBUTE="data-dockkit-split";
const RIGHTBAR_DOCK_HOST_ATTRIBUTE="data-dockkit-host";
const RIGHTBAR_DOCK_HOST_VALUE="dock";
const RIGHTBAR_STRIP_TABS_SELECTOR="[data-dockkit-strip-tabs]";
const RIGHTBAR_STRIP_TABS_ATTRIBUTE="data-dockkit-strip-tabs";
const SIDEBAR_SPLIT_EXPERT_TRACK="0.4";
const SIDEBAR_SPLIT_OTHER_TRACK="0.6";
const SIDEBAR_SPLIT_GAP_TRACK="0px";
const SIDEBAR_SPLIT_TRACK_PROPERTY="grid-template-columns";
const EXPERT_GROUP_TAB_IDS=new Set(["dsh-expert-group","expert-group"]);
function isGeneratedExpertGroupTabId(value){
return typeof value==="string"&&/^(?:dsh-)?expert-group\d+$/.test(value);
}
const RIGHTBAR_FLOAT_SELECTOR="[data-dockkit-float]";
const RIGHTBAR_FLOAT_TITLE_SELECTOR="[data-dockkit-float-title]";
const SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS=2;
const SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS=15000;
const SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS=SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS;
const SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS=4*SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS;
const SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS=15000;
const SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS=250;
const SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS=400;
const SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS=4;
const SIDEBAR_TAB_KEY_SEPARATOR="\u0000";
const SIDEBAR_TAB_ORIGIN_AUTO="auto";
const SIDEBAR_TAB_ORIGIN_MANUAL="manual";
const SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS=3;
const SIDEBAR_AUTO_KEY_LIMIT=128;
const SIDEBAR_TAB_CLOSE_WATCHDOG_MS=10000;
const SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS=10000;
const SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS=3000;
const SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS=60000;
const SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS=900000;
const SIDEBAR_TAB_CLOSE_SETTLE_REASONS=new Set(["closed","recycled","failed","timeout"]);
function closeSettleReason(outcome){
if(SIDEBAR_TAB_CLOSE_SETTLE_REASONS.has(outcome)===true)return outcome;
return outcome===true?"closed":"failed";
}
function object(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
}
function text(value,fallback){
if(typeof value!=="string"||value.trim()==="")return fallback;
return value.trim();
}
const HOST_META_ROLE_LIMIT=32;
function normalizeHostMeta(value){
const source=object(value);
const roles=[];
const rawRoles=Array.isArray(source.activeRoles)?source.activeRoles:(Array.isArray(source.roles)?source.roles:[]);
for(const entry of rawRoles){
if(roles.length>=HOST_META_ROLE_LIMIT)break;
const role=text(entry,null);
if(role!==null&&roles.indexOf(role)===-1)roles.push(role);
}
const diagnostics=object(source.diagnostics);
const fanout=object(diagnostics.fanout);
const concurrency=object(fanout.concurrency);
return{
roles,
roleLabels:object(source.roleLabels),
roleDefaults:object(source.roleDefaults),
orchestrator:object(source.orchestrator),
modelPrices:Array.isArray(source.modelPrices)?source.modelPrices:[],
usage:object(source.usage),
throttle:Object.keys(concurrency.throttle===undefined?{}:object(concurrency.throttle)).length===0
?null
:object(concurrency.throttle),
capabilities:object(source.capabilities),
};
}
const ORCHESTRATOR_ROW_KEY="orchestrator";
const SESSION_MODEL_ROLE_FALLBACK=Object.freeze(["explorer","librarian","oracle","designer","fixer","observer"]);
function normalizeSessionModelSelection(selection){
if(selection===null||typeof selection!=="object"||Array.isArray(selection))return null;
if(typeof selection.provider!=="string"||selection.provider.length===0)return null;
if(typeof selection.model!=="string"||selection.model.length===0)return null;
const effort=typeof selection.reasoningEffort==="string"?selection.reasoningEffort:"";
return{
provider:selection.provider,
model:selection.model,
...(effort.length>0?{reasoningEffort:effort}:{}),
};
}
function normalizeSessionModelOverrides(raw,roles){
const overrides={};
const source=raw!==null&&typeof raw==="object"&&Array.isArray(raw)!==true?raw:{};
for(const role of Array.isArray(roles)?roles:[]){
const selection=normalizeSessionModelSelection(source[role]);
if(selection!==null)overrides[role]=selection;
}
return overrides;
}
function normalizeSessionModelView(body,roles){
const source=object(body);
if(source.ok!==true)return null;
if(Number.isSafeInteger(source.revision)!==true||source.revision<0)return null;
return{
overrides:normalizeSessionModelOverrides(source.overrides,roles),
revision:source.revision,
live:source.live===true,
};
}
const ORCHESTRATOR_APPLY_STATES=["applied","pending","unapplied","manual","none","host-not-ready"];
function sessionModelOrchestratorOf(statusValue,metaValue){
const status=object(statusValue);
const raw=text(status.applyState,null);
const state=ORCHESTRATOR_APPLY_STATES.includes(raw)===true
?raw
:(status.hostReady===false?"host-not-ready":"none");
const applied=normalizeSessionModelSelection(status.applied);
const expected=normalizeSessionModelSelection(status.effective)
??normalizeSessionModelSelection(object(object(metaValue).orchestrator).defaults);
return{
state,
selection:(state==="applied"||state==="manual"?applied:null)??expected,
};
}
function sessionModelSelectionOfDraft(draft){
const provider=typeof draft?.provider==="string"?draft.provider:"";
const model=typeof draft?.model==="string"?draft.model:"";
const effort=typeof draft?.reasoningEffort==="string"?draft.reasoningEffort:"";
return{provider,model,...(effort.length>0?{reasoningEffort:effort}:{})};
}
function sessionModelSelectionEquals(left,right){
return(left?.provider??"")===(right?.provider??"")
&&(left?.model??"")===(right?.model??"")
&&(left?.reasoningEffort??"")===(right?.reasoningEffort??"");
}
function sessionModelModelOptions(provider,groups){
const source=Array.isArray(groups)?groups:[];
const group=source.find((entry)=>text(object(entry).id,null)===provider);
const models=[];
const pool=group===undefined
?source.flatMap((entry)=>(Array.isArray(object(entry).models)?object(entry).models:[]))
:(Array.isArray(object(group).models)?object(group).models:[]);
for(const entry of pool){
const item=object(entry);
const id=text(item.id,null);
if(id===null||models.some((existing)=>existing.id===id))continue;
models.push(item);
}
return models;
}
function sessionModelRowKeysOf(metaValue){
return[ORCHESTRATOR_ROW_KEY,...sessionModelRolesOf(metaValue)];
}
function sessionModelRolesOf(metaValue){
const source=metaValue===null||metaValue===undefined?{}:object(metaValue);
const roles=[];
for(const entry of Array.isArray(source.roles)?source.roles:[]){
const role=text(entry,null);
if(role!==null&&roles.indexOf(role)===-1)roles.push(role);
}
return roles.length===0?SESSION_MODEL_ROLE_FALLBACK.slice():roles;
}
function snapshotHasUsageFact(value,depth=0){
if(depth>8||value===null||typeof value!=="object")return false;
const source=object(value);
const usage=object(source.usage);
for(const field of["inputTokens","outputTokens","totalTokens","billedInputTokens","requests"]){
if(typeof usage[field]==="number"&&Number.isFinite(usage[field]))return true;
}
if(snapshotHasUsageFact(source.root,depth+1))return true;
for(const child of Array.isArray(source.children)?source.children:[]){
if(snapshotHasUsageFact(child,depth+1))return true;
}
for(const shard of Array.isArray(source.shards)?source.shards:[]){
if(snapshotHasUsageFact(shard,depth+1))return true;
for(const attempt of Array.isArray(object(shard).attempts)?object(shard).attempts:[]){
if(snapshotHasUsageFact(attempt,depth+1))return true;
}
}
return false;
}
function latestShardChildIdOf(shard){
const source=object(shard);
const attempts=Array.isArray(source.attempts)?source.attempts:[];
const latest=attempts.length===0?null:object(attempts[attempts.length-1]);
return text(latest?.childId,text(source.childId,null));
}
function collectSnapshotSessionIds(snapshot){
const ids=[];
const seen=new Set();
let visited=0;
const push=(value)=>{
const id=text(value,null);
if(id===null||seen.has(id))return;
seen.add(id);
ids.push(id);
};
const visit=(node,depth)=>{
if(depth>12||visited>=4096)return;
const source=object(node);
if(Object.keys(source).length===0)return;
visited+=1;
push(source.sessionId);
for(const shard of Array.isArray(source.shards)?source.shards:[])push(latestShardChildIdOf(shard));
for(const child of Array.isArray(source.children)?source.children:[])visit(child,depth+1);
};
visit(object(snapshot).root,0);
return ids;
}
function statusOf(node){
const value=text(object(node).status,"unknown");
return value||"unknown";
}
const ANNOUNCEMENT_ACTIVE_STATUSES=new Set(["queued","waiting","running"]);
const ANNOUNCEMENT_FINISHED_STATUSES=new Set(["succeeded","success","completed","complete","done","ready"]);
const ANNOUNCEMENT_FAILED_STATUSES=new Set(["failed","error","timed_out","timeout","interrupted"]);
const ANNOUNCEMENT_CANCELLED_STATUSES=new Set(["cancelled","canceled"]);
const ANNOUNCEMENT_MAX_ITEMS=5;
function collectAnnouncementTasks(snapshot){
const result=new Map();
const root=object(object(snapshot).root);
if(Object.keys(root).length===0)return result;
const visit=(node,fallbackName)=>{
const source=object(node);
const id=text(source.id,text(source.sessionId,text(source.parentTaskId,null)));
if(id===null)return;
const isRoot=source.kind==="root";
const name=isRoot
?"主代理"
:text(source.taskName,text(source.sessionId,fallbackName));
result.set(id,{name:text(name,id),status:statusOf(source)});
for(const child of Array.isArray(source.children)?source.children:[])visit(child,id);
for(const shard of Array.isArray(source.shards)?source.shards:[]){
const shardId=text(shard.shardId,null);
if(shardId===null)continue;
const shardName=text(shard.taskName,shardId);
result.set(id+":"+shardId,{name:shardName,status:statusOf(shard)});
}
};
visit(root,"主代理");
return result;
}
function announcementKindOf(previousStatus,nextStatus){
if(previousStatus===nextStatus)return null;
if(previousStatus==="unknown"||nextStatus==="unknown")return null;
if(ANNOUNCEMENT_CANCELLED_STATUSES.has(nextStatus))return"cancel";
if(ANNOUNCEMENT_FAILED_STATUSES.has(nextStatus))return"fail";
if(ANNOUNCEMENT_FINISHED_STATUSES.has(nextStatus)){
return ANNOUNCEMENT_ACTIVE_STATUSES.has(previousStatus)||previousStatus==="idle"?"finish":null;
}
if(ANNOUNCEMENT_ACTIVE_STATUSES.has(nextStatus)&&ANNOUNCEMENT_ACTIVE_STATUSES.has(previousStatus)!==true)return"start";
return null;
}
function announcementEventsOf(previousTasks,nextTasks){
const events=[];
for(const[id,next]of nextTasks){
const previous=previousTasks.get(id);
const kind=previous===undefined
?(ANNOUNCEMENT_ACTIVE_STATUSES.has(next.status)?"start":null)
:announcementKindOf(previous.status,next.status);
if(kind===null)continue;
events.push({kind,name:next.name});
}
return events;
}
function safeNormalize(raw){
const model=modelApi();
if(typeof model.normalizeExpertGroupSnapshot!=="function")return null;
try{return model.normalizeExpertGroupSnapshot(raw);}catch{return null;}
}
const modelFunction=(name)=>{
const api=modelApi();
return api!==null&&api!==undefined&&typeof api[name]==="function"?api[name]:null;
};
const finiteNumber=(value)=>(typeof value==="number"&&Number.isFinite(value)?value:null);
const formatDurationText=(value)=>{
const fn=modelFunction("formatDuration");
return fn===null?null:fn(value);
};
const formatCompactDuration=(value)=>{
const fn=modelFunction("formatDurationCompact");
return fn===null?null:fn(value);
};
const formatClockText=(value)=>{
const fn=modelFunction("formatClockTime");
return fn===null?null:fn(value);
};
const formatIsoText=(value)=>{
const fn=modelFunction("formatIsoTime");
return fn===null?null:fn(value);
};
const failureSummaryText=(value)=>{
const fn=modelFunction("formatFailureSummary");
return fn===null?null:fn(value);
};
const isFailureStatusOf=(status)=>{
const fn=modelFunction("isFailureStatus");
return fn===null?["failed","timed_out","interrupted"].includes(status):fn(status)===true;
};
const retryWarningThreshold=()=>{
const value=modelApi()?.RETRY_WARNING_THRESHOLD;
return typeof value==="number"&&Number.isFinite(value)&&value>0?value:3;
};
const mergedRoleLabelsOf=(snapshot,meta)=>{
const sources=[
snapshot===null||snapshot===undefined?null:object(snapshot.roleLabels),
meta===null?null:object(meta.roleLabels),
];
const merged={};
let any=false;
for(const source of sources){
if(source===null)continue;
for(const key of Object.keys(source)){
if(merged[key]!==undefined)continue;
const label=text(source[key],null);
if(label===null)continue;
merged[key]=label;
any=true;
}
}
return any?merged:null;
};
const roleLabelFromMap=(role,labels)=>{
const api=modelApi();
return typeof api?.roleLabelFrom==="function"?api.roleLabelFrom(role,labels):null;
};
const roleLabelFor=(role,nodeLabel,labels)=>text(nodeLabel,null)
??roleLabelFromMap(role,labels)
??text(role,null);
global[SYMBOL]=Object.freeze({
ACTIVE_STATUSES,ANNOUNCEMENT_MAX_ITEMS,ATTEMPT_STATUS_LABELS,BRAND_ICON_PATHS,
EXPERT_GROUP_TAB_IDS,FANOUT_SETTLED_STATUSES,OTHER_RIGHTBAR_WIDTH_RATIO,RETRY_STATUSES,
RIGHTBAR_DOCK_HOST_ATTRIBUTE,RIGHTBAR_DOCK_HOST_VALUE,RIGHTBAR_FLOAT_SELECTOR,RIGHTBAR_FLOAT_TITLE_SELECTOR,
RIGHTBAR_PANEL_SELECTOR,RIGHTBAR_PANEL_SESSION_ATTRIBUTE,RIGHTBAR_PANE_COLUMN_ATTRIBUTE,RIGHTBAR_PANE_ID_ATTRIBUTE,
RIGHTBAR_PANE_SELECTOR,RIGHTBAR_SPLIT_ATTRIBUTE,RIGHTBAR_SPLIT_SELECTOR,RIGHTBAR_STRIP_TABS_ATTRIBUTE,
RIGHTBAR_STRIP_TABS_SELECTOR,RIGHTBAR_TAB_ID_ATTRIBUTE,RIGHTBAR_TAB_SELECTOR,RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
RIGHTBAR_WIDTH_RATIO,RIGHTBAR_WIDTH_RATIO_MAX,RIGHTBAR_WIDTH_RATIO_MIN,RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS,
RUNTIME_STATE_DOT,RUNTIME_STATUS_LABELS,SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS,SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS,
SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS,SIDEBAR_AUTO_KEY_LIMIT,SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS,SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS,
SIDEBAR_SPLIT_EXPERT_TRACK,SIDEBAR_SPLIT_GAP_TRACK,SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS,SIDEBAR_SPLIT_OTHER_TRACK,
SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS,SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS,SIDEBAR_SPLIT_TRACK_PROPERTY,SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS,
SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS,SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS,SIDEBAR_TAB_CLOSE_WATCHDOG_MS,SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS,
SIDEBAR_TAB_KEY_SEPARATOR,SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,SIDEBAR_TAB_ORIGIN_AUTO,SIDEBAR_TAB_ORIGIN_MANUAL,
STATUS_FILTER_OPTIONS,STYLE_ID,TIMELINE_EXPANDED_KEY_LIMIT,announcementEventsOf,
clampRightbarWidthRatio,closeSettleReason,collectAnnouncementTasks,collectSnapshotSessionIds,
failureSummaryText,finiteNumber,formatClockText,formatCompactDuration,
formatDurationText,formatIsoText,isFailureStatusOf,isGeneratedExpertGroupTabId,
latestShardChildIdOf,mergedRoleLabelsOf,modelApi,modelFunction,
normalizeHostMeta,normalizeSessionModelOverrides,normalizeSessionModelSelection,normalizeSessionModelView,
object,resolveExpertRightbarWidthRatio,retryWarningThreshold,roleLabelFor,
safeNormalize,sessionModelModelOptions,sessionModelOrchestratorOf,sessionModelRolesOf,sessionModelRowKeysOf,sessionModelSelectionEquals,
sessionModelSelectionOfDraft,snapshotHasUsageFact,statusOf,storeRightbarWidthRatio,
text,
});
})(globalThis);
/* source: client-sidebar-dom.js */
(function installClientSidebarDom(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
BRAND_ICON_PATHS,EXPERT_GROUP_TAB_IDS,RIGHTBAR_DOCK_HOST_ATTRIBUTE,RIGHTBAR_DOCK_HOST_VALUE,RIGHTBAR_PANEL_SELECTOR,RIGHTBAR_PANEL_SESSION_ATTRIBUTE,RIGHTBAR_PANE_COLUMN_ATTRIBUTE,RIGHTBAR_PANE_SELECTOR,RIGHTBAR_SPLIT_ATTRIBUTE,RIGHTBAR_SPLIT_SELECTOR,RIGHTBAR_STRIP_TABS_ATTRIBUTE,RIGHTBAR_STRIP_TABS_SELECTOR,RIGHTBAR_TAB_ID_ATTRIBUTE,RIGHTBAR_TAB_SELECTOR,RUNTIME_STATE_DOT,RUNTIME_STATUS_LABELS,SIDEBAR_TAB_KEY_SEPARATOR,STYLE_ID,modelApi,object,text,
}=PURE;
function viewportWidthOf(){
let value=null;
try{value=globalThis.window?.innerWidth??globalThis.innerWidth;}catch{value=null;}
const width=Number(value);
return Number.isFinite(width)&&width>0?width:null;
}
const ELEMENT_QUERY_MISSING="missing";
const ELEMENT_QUERY_UNIQUE="unique";
const ELEMENT_QUERY_AMBIGUOUS="ambiguous";
function elementQueryOf(doc,selector){
let nodes=null;
try{
if(doc===null||doc===undefined||typeof doc.querySelectorAll!=="function"){
return{status:ELEMENT_QUERY_AMBIGUOUS,element:null};
}
nodes=Array.from(doc.querySelectorAll(selector));
}catch{
return{status:ELEMENT_QUERY_AMBIGUOUS,element:null};
}
if(nodes.length===0)return{status:ELEMENT_QUERY_MISSING,element:null};
if(nodes.length>1)return{status:ELEMENT_QUERY_AMBIGUOUS,element:null};
return{status:ELEMENT_QUERY_UNIQUE,element:nodes[0]};
}
function appFrameElementOf(doc){
const candidates=[];
const push=(element)=>{
if(element===null||element===undefined||element.nodeType!==1)return;
if(candidates.includes(element)===false)candidates.push(element);
};
const overlay=elementQueryOf(doc,"[data-shell-overlay]");
if(overlay.status===ELEMENT_QUERY_AMBIGUOUS)return null;
if(overlay.status===ELEMENT_QUERY_UNIQUE){
let parent=null;
try{parent=overlay.element.parentElement??null;}catch{parent=null;}
push(parent);
}
for(const selector of["[data-rightbar-collapsed]","[data-rightbar-instant]"]){
const state=elementQueryOf(doc,selector);
if(state.status===ELEMENT_QUERY_AMBIGUOUS)return null;
if(state.status===ELEMENT_QUERY_UNIQUE)push(state.element);
}
return candidates.length===1?candidates[0]:null;
}
function hostAppFrameWidthOf(){
try{
const doc=globalThis.document;
const frame=appFrameElementOf(doc);
if(frame===null)return null;
if(frame===doc?.body||frame===doc?.documentElement)return null;
const rect=typeof frame.getBoundingClientRect==="function"?frame.getBoundingClientRect():null;
if(rect===null||typeof rect!=="object")return null;
const width=Number(rect.width);
return Number.isFinite(width)&&width>0?width:null;
}catch{return null;}
}
function methodOf(target,name){
if(target===null||target===undefined)return null;
try{
const candidate=target[name];
return typeof candidate==="function"?candidate:null;
}catch{return null;}
}
function resolveClientService(candidates,name){
for(const candidate of candidates){
if(candidate===null||candidate===undefined)continue;
try{
if(typeof candidate.get==="function"){
const value=candidate.get(name);
if(value!==null&&value!==undefined)return value;
}
}catch{/* 未声明服务读取即抛错：按「该候选没有它」处理。 */}
try{
const value=candidate[name];
if(value!==null&&value!==undefined)return value;
}catch{/* 同上。 */}
}
return null;
}
const SUBAGENT_CHAT_ADDRESS_PREFIX="dsh-resource://subagentchat/session/";
const SUBAGENT_CHAT_KIND="subagentchat";
const SUBAGENT_MODES=new Set(["one-shot","continuable","unknown"]);
function normalizeSubagentAddress(value){
const source=object(value);
const parentSessionId=text(source.parentSessionId,text(source.parentId,null));
const childSessionId=text(source.childSessionId,text(source.id,text(source.sessionId,null)));
const mode=text(source.mode,null);
if(parentSessionId===null||childSessionId===null||mode===null)return null;
if(SUBAGENT_MODES.has(mode)!==true)return null;
return{parentSessionId,childSessionId,mode};
}
function subagentChatAddress(value){
const address=normalizeSubagentAddress(value);
if(address===null)return null;
const query=typeof global.URLSearchParams==="function"
?new global.URLSearchParams({parent:address.parentSessionId,mode:address.mode}).toString()
:"parent="+encodeAddressPart(address.parentSessionId)+"&mode="+encodeAddressPart(address.mode);
return SUBAGENT_CHAT_ADDRESS_PREFIX
+encodeAddressPart(address.childSessionId)
+"?"+query;
}
function encodeAddressPart(value){
const raw=String(value);
return typeof encodeURIComponent==="function"?encodeURIComponent(raw):raw;
}
function sidebarTabKey(sessionId,rootSessionId,resourceAddress){
return String(sessionId)+SIDEBAR_TAB_KEY_SEPARATOR
+String(rootSessionId)+SIDEBAR_TAB_KEY_SEPARATOR+String(resourceAddress);
}
function sidebarTabCloseKey(sessionId,rootSessionId,tabId){
return String(sessionId)+SIDEBAR_TAB_KEY_SEPARATOR
+String(rootSessionId)+SIDEBAR_TAB_KEY_SEPARATOR+String(tabId);
}
function sessionEntries(value){
if(value==null)return[];
if(Array.isArray(value)){
if(value.every((entry)=>Array.isArray(entry)&&entry.length>=2))return value;
return value.map((entry,index)=>[String(index),entry]);
}
if(typeof value.entries==="function"){
try{return Array.from(value.entries());}catch{return[];}
}
if(typeof value==="object")return Object.entries(value);
return[];
}
function sessionIdOf(value,fallback){
const source=object(value);
return text(source.sessionId,text(source.id,text(fallback,null)));
}
function currentSessionIdOf(snapshot){
const source=object(snapshot);
const explicit=text(source.current,null);
if(explicit!==null)return explicit;
const currentObject=sessionIdOf(source.current,null);
if(currentObject!==null)return currentObject;
if(source.current===null)return null;
const named=text(source.currentSessionId,text(source.activeSessionId,null));
if(named!==null)return named;
for(const[fallback,value]of sessionEntries(source.byId??source.sessions)){
const summary=object(value);
const retainedBy=object(summary.retainedBy);
const mainView=retainedBy.mainView;
if((typeof mainView==="number"&&mainView>0)||mainView===true){
return sessionIdOf(summary,fallback);
}
}
return null;
}
function listSnapshot(deps,ctx){
const sessions=deps.sessions||ctx?.sessions;
const list=sessions?.list;
if(typeof list?.getSnapshot==="function"){
try{return list.getSnapshot()||{};}catch{return{};}
}
if(typeof sessions?.getSnapshot==="function"){
try{return sessions.getSnapshot()||{};}catch{return{};}
}
return sessions?.snapshot||{};
}
function subscribeSessions(deps,ctx,listener){
const sessions=deps.sessions||ctx?.sessions;
const list=sessions?.list;
if(typeof list?.subscribe==="function"){
try{return list.subscribe(listener);}catch{return()=>{};}
}
if(typeof sessions?.subscribe==="function"){
try{return sessions.subscribe(listener);}catch{return()=>{};}
}
return()=>{};
}
function getOpenSession(deps,ctx){
const workspace=resolveClientService([deps,ctx,deps?.ctx],"uiWorkspace");
const openWorkspaceSession=methodOf(workspace,"openSession");
if(openWorkspaceSession!==null){
return{
open:(target)=>openWorkspaceSession.call(workspace,target),
acceptsAddress:true,
available:true,
};
}
return{open:()=>{},acceptsAddress:false,available:false};
}
function capabilityAllowed(node,action){
const capabilities=object(object(node).capabilities);
const entry=object(capabilities[action]);
return typeof entry.allowed==="boolean"?entry.allowed:null;
}
function runtimeStatusOf(node,entry,options){
const model=modelApi();
if(typeof model.runtimeStatusOf==="function")return model.runtimeStatusOf(node,entry,options);
if(options?.partial===true&&object(node).running!==true)return"unknown";
return object(node).running===true?"running":"ready";
}
function createCatalogLookup(snapshot){
const tables=new Map();
const tableFor=(parentId)=>{
const cached=tables.get(parentId);
if(cached!==undefined)return cached;
const table=new Map();
const projection=object(object(object(snapshot).projectionsBySession)[parentId]);
const values=object(projection.values);
const entries=Array.isArray(values.subagentCatalog)?values.subagentCatalog:[];
for(const entry of entries){
const source=object(entry);
if(source.kind==="diagnostic")continue;
const id=text(source.id,text(source.sessionId,null));
if(id!==null&&!table.has(id))table.set(id,withSessionActivity(source,snapshot,id));
}
tables.set(parentId,table);
return table;
};
return(parentId,childId)=>{
if(parentId===null||childId===null)return null;
const table=tableFor(parentId);
return table.has(childId)?table.get(childId):null;
};
}
const CATALOG_ACTIVITIES=new Set(["running","inactive"]);
function withSessionActivity(entry,snapshot,sessionId){
if(CATALOG_ACTIVITIES.has(text(entry.activity,null))===true)return entry;
const running=sessionRunningOf(snapshot,sessionId);
if(running===null)return entry;
return{...entry,activity:running?"running":"inactive"};
}
function sessionRunningOf(snapshot,sessionId){
if(sessionId===null)return null;
const summary=object(object(object(snapshot).byId)[sessionId]);
return typeof summary.running==="boolean"?summary.running:null;
}
function metadataOf(node,roleLabels){
const model=modelApi();
if(typeof model.formatExpertMetadata==="function")return model.formatExpertMetadata(node,{roleLabels});
const source=object(node);
return[text(source.role,source.kind==="root"?"Orchestrator":"Expert"),text(source.provider,"未知供应商"),text(source.model,"未知模型"),text(source.effort,"默认")].join(" · ");
}
function titleOf(node){
const source=object(node);
if(source.kind==="fanout"){
const role=text(source.role,"Expert");
const count=Array.isArray(source.shards)?source.shards.length:0;
return role.charAt(0).toUpperCase()+role.slice(1)+" · "+count+" shards · "+RUNTIME_STATUS_LABELS[runtimeStatusOf(source,null)];
}
if(source.kind==="root")return"主代理";
return text(source.taskName,"未命名任务");
}
function makeIcon(primitives,name,props){
const Icon=primitives?.[name]||primitives?.IconWarningOutlineRegular;
return typeof Icon==="function"?Icon(props||{size:14}):null;
}
function createBrandIcon(react,primitives){
if(typeof primitives?.IconUsersOutlineRegular==="function")return primitives.IconUsersOutlineRegular;
if(typeof react?.createElement!=="function")return null;
return function DegBrandIcon(props){
const size=props?.size??16;
return react.createElement("svg",{
width:size,
height:size,
viewBox:"0 0 16 16",
fill:"none",
className:props?.className,
"aria-hidden":"true",
strokeWidth:1,
xmlns:"http://www.w3.org/2000/svg",
},...BRAND_ICON_PATHS.map((d)=>react.createElement("path",{
key:d,
d,
stroke:"currentColor",
fill:"none",
})));
};
}
function stateDotOf(react,primitives,status){
const StateDot=primitives?.StateDot;
if(typeof StateDot==="function"){
return react.createElement(StateDot,{state:RUNTIME_STATE_DOT[status]||RUNTIME_STATE_DOT.ready});
}
return react.createElement("span",{
className:"deg_expert_group_state_dot",
"data-state":status,
"aria-hidden":"true",
});
}
function statusIcon(react,primitives,status){
const label=RUNTIME_STATUS_LABELS[status]||RUNTIME_STATUS_LABELS.ready;
return react.createElement("span",{
className:"deg_expert_group_status_icon",
role:"img",
"aria-label":label,
title:label,
"data-status":status,
},stateDotOf(react,primitives,status));
}
const PANEL_CSS_SHELL=[
".deg_expert_group{position:relative;display:flex;flex-direction:column;min-width:0;height:100%;overflow:auto;padding:8px 10px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1,transparent);font-size:12px;line-height:16px}",
".deg_expert_group_header{display:flex;flex-wrap:wrap;align-items:center;min-height:28px;gap:12px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600}",
".deg_expert_group_header_title{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".deg_expert_group_header_action,.deg_expert_group_chevron,.deg_expert_group_action,.deg_expert_group_sidebar_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;border:0;border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}",
".deg_expert_group_header_action{width:24px;height:24px;margin-left:auto}",
".deg_expert_group_header_auto{display:inline-flex;align-items:center;gap:4px;flex:0 0 auto;font-weight:400;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap}",
".deg_expert_group_header_auto_input{margin:0;cursor:pointer}",
".deg_expert_group_header_auto_input:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_header_auto_label{font-size:12px;line-height:16px}",
".deg_expert_group_header_peak_valley{flex:0 0 auto;padding:1px 6px;border-radius:6px;font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
".deg_expert_group_recovery{display:flex;flex-wrap:wrap;align-items:center;gap:4px 8px;margin:6px 0 0;padding:6px 8px;border:1px solid var(--dsw-alias-state-error-primary,var(--dsw-alias-state-warning-primary,#f59e0b));border-radius:6px;background:var(--dsw-alias-bg-layer-2,transparent);color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-primary));font-weight:600}",
".deg_expert_group_recovery_text{flex:1 1 140px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".deg_expert_group_recovery_retry_error{flex:1 1 100%;min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-weight:400}",
".deg_expert_group_recovery_retry{flex:0 0 auto;box-sizing:border-box;height:24px;padding:0 8px;border:0;border-radius:5px;background:transparent;color:inherit;font-weight:600;cursor:pointer}",
".deg_expert_group_recovery_retry:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}",
".deg_expert_group_recovery_retry:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_recovery_retry:disabled{cursor:default;opacity:.7}",
".deg_expert_group_header_action:hover,.deg_expert_group_chevron:hover,.deg_expert_group_action:hover:not(:disabled),.deg_expert_group_sidebar_action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
".deg_expert_group_header_action:focus-visible,.deg_expert_group_chevron:focus-visible,.deg_expert_group_action:focus-visible,.deg_expert_group_sidebar_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_tree{min-width:0;padding-top:5px}",
".deg_expert_group_tree_items{min-width:0}",
".deg_expert_group_announcer{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}",
".deg_expert_group_task:focus-visible,.deg_expert_group_fanout_title>.deg_expert_group_task:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:2px;border-radius:3px}",
".deg_expert_group_resizer{position:absolute;top:0;left:0;bottom:0;width:6px;cursor:col-resize;touch-action:none;background:transparent;z-index:2}",
".deg_expert_group_resizer:hover,.deg_expert_group_resizer[data-dragging=true]{background:var(--dsw-alias-interactive-bg-hover)}",
".deg_expert_group_resizer:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:-2px}",
".deg_expert_group_node{position:relative;min-width:0;padding-left:16px}",
".deg_expert_group_node_root{padding-left:0}",
".deg_expert_group_row{box-sizing:border-box;display:grid;grid-template-columns:20px 20px minmax(0,1fr);min-width:0;min-height:44px;padding:4px 0}",
".deg_expert_group_row_main{display:grid;grid-template-columns:minmax(0,1fr);grid-template-rows:auto 16px;min-width:0}",
".deg_expert_group_task_line{grid-area:1 / 1;display:flex;align-items:center;min-width:0;gap:2px}",
".deg_expert_group_meta{grid-area:2 / 1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px}",
".deg_expert_group_sidebar_action{flex:0 0 30px;width:30px;height:20px;margin:-2px 0;padding:0;color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
".deg_expert_group_sidebar_action:hover{color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
".deg_expert_group_sidebar_action[data-open=true]{color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
".deg_expert_group_sidebar_action[data-open=true]:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
".deg_expert_group_double_arrow{display:inline-flex;align-items:center;justify-content:center;width:30px;height:20px;line-height:0}",
".deg_expert_group_double_arrow>*+*{margin-left:-10px}",
".deg_expert_group_double_arrow_icon path{stroke:currentColor;stroke-width:1.5;stroke-linejoin:round}",
".deg_expert_group_line{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".deg_expert_group_task{min-width:0;flex:0 1 auto;font-weight:600;cursor:pointer}",
".deg_expert_group_shard_task{overflow:visible;text-overflow:clip;white-space:normal;overflow-wrap:anywhere}",
".deg_expert_group_task:hover{text-decoration:underline}",
".deg_expert_group_chevron{width:20px;height:20px;padding:0;align-self:start}",
".deg_expert_group_fanout_header>.deg_expert_group_chevron{align-self:center}",
".deg_expert_group_chevron_placeholder{display:inline-block;width:20px;height:20px}",
".deg_expert_group_status_icon{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;color:var(--dsw-alias-label-secondary)}",
".deg_expert_group_state_dot{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor}",
".deg_expert_group_state_dot[data-state=running]{color:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary))}",
".deg_expert_group_state_dot[data-state=ready]{color:var(--dsw-alias-state-success-primary)}",
".deg_expert_group_state_dot[data-state=unknown]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
".deg_expert_group_trailing{display:flex;flex:0 0 30px;align-items:center;justify-content:center;width:30px;height:20px;min-width:30px}",
".deg_expert_group_task_line_trailing{justify-content:flex-start}",
".deg_expert_group_idle_title_line{display:flex;align-items:center;min-width:0;gap:2px}",
".deg_expert_group_idle_title_line>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
".deg_expert_group_sidebar_batch_action{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;flex:0 0 30px;width:30px;height:20px;margin:0;padding:0;border:0;border-radius:5px;background:transparent;cursor:pointer;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
".deg_expert_group_sidebar_batch_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-business-primary,var(--dsw-alias-button-info-fill,#22d3ee))}",
".deg_expert_group_sidebar_batch_action:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_sidebar_batch_action:disabled{opacity:.45;cursor:wait}",
".deg_expert_group_sidebar_batch_zero{display:inline-block;width:12px;height:12px;border-radius:50%;background:var(--dsw-static-deepseek-450,var(--dsw-alias-state-business-primary,#22d3ee))}",
".deg_expert_group_children{position:relative;min-width:0;margin:0;padding:0;--deg-parent-row-height:44px}",
".deg_expert_group_children>.deg_expert_group_node,.deg_expert_group_children>.deg_expert_group_fanout,.deg_expert_group_children>.deg_expert_group_idle_group{--deg-tree-anchor:14px;position:relative}",
".deg_expert_group_children>.deg_expert_group_fanout{--deg-tree-anchor:14px}",
".deg_expert_group_children>:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
".deg_expert_group_children>:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
".deg_expert_group_node>.deg_expert_group_row,.deg_expert_group_fanout_header,.deg_expert_group_idle_group>.deg_expert_group_row{position:relative}",
".deg_expert_group_node:not(.deg_expert_group_node_root)>.deg_expert_group_row:before,.deg_expert_group_fanout_header:before,.deg_expert_group_idle_group>.deg_expert_group_row:before{position:absolute;top:var(--deg-tree-anchor,14px);left:-6px;width:16px;border-top:1px solid var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
".deg_expert_group_row>*,.deg_expert_group_fanout_header>*{position:relative;z-index:1}",
".deg_expert_group_idle_group{position:relative;min-width:0;padding-left:16px;--deg-tree-anchor:14px}",
".deg_expert_group_idle_group>.deg_expert_group_children{margin:0;padding:0;--deg-parent-row-height:28px}",
".deg_expert_group_idle_group>.deg_expert_group_row.deg_expert_group_idle_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr);align-items:center;height:28px;min-height:28px;padding:4px 0}",
".deg_expert_group_idle_group>.deg_expert_group_row{margin:0}",
".deg_expert_group_fanout{position:relative;margin-top:0;padding-left:16px}",
".deg_expert_group_fanout_header{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;align-items:center;min-width:0;min-height:28px;gap:4px}",
".deg_expert_group_fanout_shards{position:relative;min-width:0;--deg-parent-row-height:28px}",
".deg_expert_group_fanout_shards>.deg_expert_group_shard{--deg-tree-anchor:13px;position:relative}",
".deg_expert_group_fanout_shards>.deg_expert_group_shard:first-child:before{position:absolute;top:calc(var(--deg-tree-anchor) - var(--deg-parent-row-height));bottom:calc(100% - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
".deg_expert_group_fanout_shards>.deg_expert_group_shard:not(:last-child):after{position:absolute;top:var(--deg-tree-anchor);bottom:calc(0px - var(--deg-tree-anchor));left:10px;width:1px;background:var(--dsw-alias-border-l2);content:\"\";pointer-events:none}",
".deg_expert_group_shard{display:grid;grid-template-columns:20px 20px minmax(0,1fr) auto;min-width:0;min-height:48px;padding:3px 0;gap:0 3px}",
".deg_expert_group_shard[data-expanded=false]{min-height:24px}",
".deg_expert_group_actions{display:flex;align-items:flex-start;gap:2px}",
".deg_expert_group_action{width:24px;height:24px;padding:0}",
".deg_expert_group_action:disabled{opacity:.45;cursor:wait}",
".deg_expert_group_empty{padding:16px 2px;color:var(--dsw-alias-label-secondary)}",
".deg_expert_group_error_empty{display:flex;flex-direction:column;gap:2px;padding:16px 2px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}",
".deg_expert_group_error_empty_title{font-weight:600}",
".deg_expert_group_error_empty_detail{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary);font-size:11px}",
".deg_expert_group_skeleton{height:52px;margin:4px 0;border-radius:5px;background:var(--dsw-alias-bg-layer-2,var(--dsw-alias-interactive-bg-hover));opacity:.65}",
".deg_expert_group_error{display:flex;align-items:center;gap:4px;padding:6px 0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:11px}",
".deg_expert_group_count{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}",
".deg_expert_group_cell{display:flex;flex-direction:column;min-width:0}",
".deg_expert_group_metrics{display:flex;flex-wrap:wrap;align-items:center;gap:2px 0;min-width:0;padding:2px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
".deg_expert_group_metrics_part{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
".deg_expert_group_metrics_separator{flex:0 0 auto;white-space:pre;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
".deg_expert_group_metrics_part+.deg_expert_group_retry_warning{margin-left:6px}",
".deg_expert_group_retry_warning{flex:0 0 auto;box-sizing:border-box;padding:0 4px;border:1px solid var(--dsw-alias-state-warning-primary,#f59e0b);border-radius:4px;color:var(--dsw-alias-state-warning-primary,#f59e0b);font-weight:600;line-height:14px}",
".deg_expert_group_failure{flex:1 1 100%;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-error,#f87171))}",
".deg_expert_group_attempts{display:flex;flex-direction:column;gap:0;min-width:0;margin:2px 0;padding:0 0 0 6px;border-inline-start:1px solid var(--dsw-alias-border-l2)}",
".deg_expert_group_attempt{display:flex;flex-direction:column;align-items:stretch;gap:0;min-width:0;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px}",
".deg_expert_group_attempt_row{display:flex;align-items:center;gap:6px;min-width:0}",
".deg_expert_group_attempt_usage{display:flex;flex-wrap:wrap;gap:0 6px;min-width:0;padding-left:2px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px}",
".deg_expert_group_attempt_usage_tokens{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
".deg_expert_group_attempt_cost{min-width:0;overflow-wrap:anywhere}",
".deg_expert_group_attempt_cost[data-cost-configured=false]{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}",
".deg_expert_group_structured{min-width:0;margin:2px 0 0;padding:2px 4px;border-inline-start:2px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:15px;overflow-wrap:anywhere;max-height:84px;overflow:auto}",
".deg_expert_group_structured[data-fallback=true]{border-inline-start-color:var(--dsw-alias-state-warning-primary,#f59e0b);color:var(--dsw-alias-state-warning-primary,#f59e0b)}",
".deg_expert_group_shard_extra{display:flex;flex-direction:column;min-width:0}",
].join("");
const PANEL_CSS_SESSION_MODEL=[
".deg_expert_group_session_model_dialog{position:fixed;inset:0;margin:auto;box-sizing:border-box;width:min(920px,calc(100vw - 32px));max-width:calc(100vw - 32px);max-height:calc(100vh - 48px);padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:0 18px 48px rgba(0,0,0,.28);overflow:hidden}",
".deg_expert_group_session_model_dialog[open]{display:flex;flex-direction:column}",
".deg_expert_group_session_model_dialog::backdrop{background:rgba(0,0,0,.42)}",
".deg_expert_group_session_model_header{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:0 0 auto;padding:12px 14px 6px;font-weight:600}",
".deg_expert_group_session_model_heading{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;overflow:hidden}",
".deg_expert_group_session_model_title{flex:0 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".deg_expert_group_session_model_body{flex:1 1 auto;min-height:0;overflow:auto;padding:0 14px 8px}",
".deg_expert_group_session_model_hint{margin:0 0 8px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;overflow-wrap:anywhere}",
".deg_expert_group_session_model_notice{margin:0 0 8px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}",
".deg_expert_group_session_model_notice_error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}",
".deg_expert_group_session_model_scroll{overflow-x:auto}",
".deg_expert_group_session_model_table{display:grid;grid-template-columns:minmax(84px,.6fr) minmax(132px,.82fr) minmax(210px,1.5fr) minmax(96px,.62fr);min-width:540px;align-items:center}",
".deg_expert_group_session_model_row{display:contents}",
".deg_expert_group_session_model_orchestrator{grid-column:1/-1;padding:0 6px 6px;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:16px;overflow-wrap:anywhere}",
".deg_expert_group_session_model_head_cell{min-width:0;padding:8px 6px 6px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;font-weight:600}",
".deg_expert_group_session_model_cell{display:flex;align-items:center;min-width:0;padding:8px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
".deg_expert_group_session_model_cell select{width:100%;min-width:0;box-sizing:border-box;padding:5px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2,transparent);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}",
".deg_expert_group_session_model_cell select:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_session_model_cell select:disabled{opacity:.5;cursor:not-allowed}",
".deg_expert_group_session_model_pill{display:flex;align-items:center;justify-content:space-between;gap:4px;flex:0 0 74px;width:74px;height:28px;min-height:28px;padding:2px 4px 2px 6px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}",
".deg_expert_group_session_model_pill_label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
".deg_expert_group_session_model_clear{display:inline-flex;align-items:center;justify-content:center;flex:0 0 16px;width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;cursor:pointer}",
".deg_expert_group_session_model_clear:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
".deg_expert_group_session_model_clear:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_session_model_clear:disabled{opacity:.4;cursor:not-allowed}",
".deg_expert_group_session_model_footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:0 0 auto;padding:10px 14px;border-top:1px solid var(--dsw-alias-border-l2)}",
".deg_expert_group_session_model_revision{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums;font-size:12px}",
".deg_expert_group_session_model_invalid{flex:1 1 160px;min-width:0;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));font-size:12px;line-height:18px;overflow-wrap:anywhere}",
".deg_expert_group_session_model_spacer{flex:1 1 auto}",
".deg_expert_group_session_model_primary{box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-radius:6px;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));color:var(--dsw-alias-bg-layer-1,#fff);font:inherit;font-size:12px;font-weight:600;cursor:pointer}",
".deg_expert_group_session_model_primary:disabled,.deg_expert_group_session_model_secondary:disabled{opacity:.45;cursor:not-allowed}",
".deg_expert_group_session_model_secondary{box-sizing:border-box;height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}",
".deg_expert_group_session_model_secondary:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
".deg_expert_group_session_model_secondary:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
].join("");
const PANEL_CSS_TIMELINE=[
".deg_expert_group_attempt_index{flex:0 0 auto;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-variant-numeric:tabular-nums}",
".deg_expert_group_attempt_status{flex:0 0 auto;font-weight:600}",
".deg_expert_group_attempt[data-status=failed] .deg_expert_group_attempt_status,.deg_expert_group_attempt[data-status=timed_out] .deg_expert_group_attempt_status,.deg_expert_group_attempt[data-status=interrupted] .deg_expert_group_attempt_status{color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-error,#f87171))}",
".deg_expert_group_attempt_duration{flex:0 0 auto;font-variant-numeric:tabular-nums}",
".deg_expert_group_attempt_time{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
".deg_expert_group_attempts_toggle{flex:0 0 auto;align-self:flex-start;box-sizing:border-box;height:20px;margin:1px 0 0;padding:0 4px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
".deg_expert_group_attempts_toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
".deg_expert_group_attempts_toggle:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_fanout_title{display:flex;flex-direction:column;min-width:0}",
".deg_expert_group_fanout_title>.deg_expert_group_task{flex:0 1 auto;min-width:0}",
".deg_expert_group_toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:4px;padding:5px 0 2px;border-bottom:1px solid var(--dsw-alias-border-l2)}",
".deg_expert_group_search{flex:1 1 120px;min-width:0;box-sizing:border-box;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px}",
".deg_expert_group_filter{flex:0 1 auto;min-width:0;box-sizing:border-box;height:24px;padding:0 2px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-primary);font-size:11px;color-scheme:light}",
"body[data-ds-dark-theme] .deg_expert_group_filter{color-scheme:dark}",
".deg_expert_group_filter option{background-color:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText)}",
".deg_expert_group_search:focus-visible,.deg_expert_group_filter:focus-visible,.deg_expert_group_export_button:focus-visible{outline:2px solid var(--dsw-alias-interactive-border-focus,var(--dsw-alias-label-primary));outline-offset:1px}",
".deg_expert_group_export_button{box-sizing:border-box;height:24px;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:11px;cursor:pointer}",
".deg_expert_group_export_button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}",
".deg_expert_group_filter_empty{padding:8px 2px;color:var(--dsw-alias-label-secondary);font-size:11px}",
].join("");
const PANEL_CSS_TEXT=PANEL_CSS_SHELL+PANEL_CSS_SESSION_MODEL+PANEL_CSS_TIMELINE;
function styleTag(){
if(typeof document==="undefined"||typeof document.createElement!=="function")return;
if(document.querySelector?.("style[data-plugin-css=\""+STYLE_ID+"\"]")!==null)return;
const tag=document.createElement("style");
tag.dataset.plugin="dsh-expert-group";
tag.dataset.pluginCss=STYLE_ID;
tag.textContent=PANEL_CSS_TEXT;
document.head?.appendChild(tag);
}
const RIGHTBAR_DRAG_HANDLE_SELECTOR="[data-side=rightbar]";
function attributeOf(node,name){
try{
if(node===null||node===undefined||typeof node.getAttribute!=="function")return null;
const raw=node.getAttribute(name);
return typeof raw==="string"?raw:null;
}catch{return null;}
}
function withinSameDockScope(node,root,boundaries){
let parent=null;
try{parent=node?.parentNode??null;}catch{return null;}
let guard=0;
while(parent!==null&&parent!==undefined&&parent!==root){
guard+=1;
if(guard>512)return null;
if(typeof parent.getAttribute!=="function")return null;
for(const name of boundaries){
if(attributeOf(parent,name)!==null)return false;
}
try{parent=parent.parentNode??null;}catch{return null;}
}
return parent===root;
}
function hostHiddenStateOf(host){
try{
const value=host?.hidden;
return typeof value==="boolean"?value:null;
}catch{return null;}
}
function cellStripNodesOf(column){
const hosts=column?.hosts??null;
if(!Array.isArray(hosts)||hosts.length===0)return null;
let activeStrip=null;
let activeCount=0;
for(const host of hosts){
if(host===null||host===undefined||typeof host.querySelectorAll!=="function")return null;
const hidden=hostHiddenStateOf(host);
if(hidden===null)return null;
let nodes=null;
try{nodes=Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR));}catch{return null;}
const owned=[];
for(const node of nodes){
const scoped=withinSameDockScope(node,host,[RIGHTBAR_DOCK_HOST_ATTRIBUTE,RIGHTBAR_SPLIT_ATTRIBUTE]);
if(scoped===null)return null;
if(scoped===true)owned.push(node);
}
if(hidden===true){
if(owned.length!==0)return null;
continue;
}
if(owned.length!==1)return null;
activeCount+=1;
if(activeCount>1)return null;
activeStrip=owned[0];
}
if(activeCount!==1||activeStrip===null)return null;
return[activeStrip];
}
function cellTabIdsOf(column){
const ids=new Set();
const strips=cellStripNodesOf(column);
if(strips===null||strips.length!==1)return{ids,readable:false};
const strip=strips[0];
if(typeof strip.querySelectorAll!=="function")return{ids,readable:false};
let tabNodes=null;
try{tabNodes=Array.from(strip.querySelectorAll(RIGHTBAR_TAB_SELECTOR));}catch{return{ids,readable:false};}
for(const node of tabNodes){
const scoped=withinSameDockScope(node,strip,[RIGHTBAR_STRIP_TABS_ATTRIBUTE]);
if(scoped===null)return{ids,readable:false};
if(scoped!==true)continue;
const tabId=text(attributeOf(node,RIGHTBAR_TAB_ID_ATTRIBUTE),null);
if(tabId===null)return{ids,readable:false};
if(ids.has(tabId))return{ids,readable:false};
ids.add(tabId);
}
if(ids.size===0)return{ids,readable:false};
return{ids,readable:true};
}
function expertGroupTabIdsOf(inventory,sessionId){
const expertTabIds=new Set(EXPERT_GROUP_TAB_IDS);
if(!Array.isArray(inventory)||typeof sessionId!=="string"||sessionId==="")return expertTabIds;
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
if(!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind,null)))continue;
const tabId=text(candidate.tabId,null);
if(tabId!==null)expertTabIds.add(tabId);
}catch{
}
}
return expertTabIds;
}
function paneNodesOf(panel){
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return null;
try{return Array.from(panel.querySelectorAll(RIGHTBAR_PANE_SELECTOR));}catch{return null;}
}
function tabKindsForSession(inventory,sessionId){
if(!Array.isArray(inventory)||typeof sessionId!=="string"||sessionId==="")return null;
const tabKinds=new Map();
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
const tabId=text(candidate.tabId,null);
const kind=text(candidate.kind,text(candidate.type,null));
if(tabId===null||kind===null)continue;
const previous=tabKinds.get(tabId);
if(previous!==undefined&&previous!==kind)return null;
tabKinds.set(tabId,kind);
}catch{
}
}
return tabKinds;
}
function sidebarTabSetsForSession(inventory,sessionId){
const tabKinds=tabKindsForSession(inventory,sessionId);
if(tabKinds===null)return null;
const expert=new Set(EXPERT_GROUP_TAB_IDS);
const known=new Set(EXPERT_GROUP_TAB_IDS);
for(const[tabId,kind]of tabKinds){
known.add(tabId);
if(EXPERT_GROUP_TAB_IDS.has(kind))expert.add(tabId);
}
return{expert,known};
}
function rightbarPanelForSession(doc,sessionId){
if(doc===null||doc===undefined||typeof doc.querySelectorAll!=="function")return null;
if(typeof sessionId!=="string"||sessionId==="")return null;
let nodes=null;
try{nodes=Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR));}catch{return null;}
let matched=null;
for(const node of nodes){
if(attributeOf(node,RIGHTBAR_PANEL_SESSION_ATTRIBUTE)!==sessionId)continue;
if(matched!==null)return null;
matched=node;
}
return matched;
}
function rightbarPanelForSessionCompat(doc,sessionId){
const panel=rightbarPanelForSession(doc,sessionId);
if(panel!==null)return panel;
if(doc===null||doc===undefined||typeof doc.querySelectorAll!=="function")return null;
let nodes=null;
try{nodes=Array.from(doc.querySelectorAll(RIGHTBAR_PANEL_SELECTOR));}catch{return null;}
if(nodes.length>1)return null;
for(const node of nodes){
if(attributeOf(node,RIGHTBAR_PANEL_SESSION_ATTRIBUTE)!==null)return null;
}
if(nodes.length===1)return nodes[0];
if(typeof doc.querySelector!=="function")return null;
let single=null;
try{single=doc.querySelector(RIGHTBAR_PANEL_SELECTOR)??null;}catch{return null;}
if(single===null||single===undefined)return null;
if(attributeOf(single,RIGHTBAR_PANEL_SESSION_ATTRIBUTE)!==null)return null;
return single;
}
function dockCellsOf(split){
const cells=[];
let children=null;
try{children=split?.children??null;}catch{children=null;}
if(children===null||children===undefined)return{cells,readable:false};
const byColumn=new Map();
for(const child of Array.from(children)){
if(child===null||typeof child.getAttribute!=="function")return{cells,readable:false};
if(attributeOf(child,RIGHTBAR_DOCK_HOST_ATTRIBUTE)!==RIGHTBAR_DOCK_HOST_VALUE)continue;
const column=text(attributeOf(child,RIGHTBAR_PANE_COLUMN_ATTRIBUTE),null);
if(column===null)return{cells,readable:false};
const merged=byColumn.get(column);
if(merged===undefined)byColumn.set(column,{column,hosts:[child]});
else merged.hosts.push(child);
}
for(const entry of byColumn.values())cells.push(entry);
return{cells,readable:true};
}
function splitOwnsExpertPair(split,tabSets){
if(tabSets===null||tabSets===undefined||typeof tabSets!=="object")return false;
const breakdown=dockCellsOf(split);
if(breakdown.readable!==true||breakdown.cells.length!==2)return false;
const byColumn=new Map(breakdown.cells.map((entry)=>[entry.column,entry]));
if(!byColumn.has("0")||!byColumn.has("1"))return false;
const expertTabs=cellTabIdsOf(byColumn.get("0"));
const otherTabs=cellTabIdsOf(byColumn.get("1"));
if(expertTabs.readable!==true||otherTabs.readable!==true)return false;
let expertCount=0;
for(const tabId of expertTabs.ids){
if(otherTabs.ids.has(tabId))return false;
if(tabSets.known.has(tabId)!==true)return false;
if(tabSets.expert.has(tabId)!==true)return false;
expertCount+=1;
}
if(expertCount===0)return false;
for(const tabId of otherTabs.ids){
if(tabSets.known.has(tabId)!==true)return false;
if(tabSets.expert.has(tabId)===true)return false;
}
return true;
}
function cellPendingStateOf(column){
const hosts=column?.hosts??null;
if(!Array.isArray(hosts)||hosts.length===0)return"foreign";
let activeStrip=null;
let activeCount=0;
for(const host of hosts){
if(host===null||host===undefined||typeof host.querySelectorAll!=="function")return"foreign";
const hidden=hostHiddenStateOf(host);
if(hidden===null)return"foreign";
let nodes=null;
try{nodes=Array.from(host.querySelectorAll(RIGHTBAR_STRIP_TABS_SELECTOR));}catch{return"foreign";}
const owned=[];
for(const node of nodes){
const scoped=withinSameDockScope(node,host,[RIGHTBAR_DOCK_HOST_ATTRIBUTE,RIGHTBAR_SPLIT_ATTRIBUTE]);
if(scoped===null)return"foreign";
if(scoped===true)owned.push(node);
}
if(hidden===true){
if(owned.length!==0)return"foreign";
continue;
}
if(owned.length!==1)return"foreign";
activeCount+=1;
if(activeCount>1)return"foreign";
activeStrip=owned[0];
}
if(activeCount!==1||activeStrip===null)return"unavailable";
return cellTabIdsOf(column).readable===true?"readable":"foreign";
}
function splitPairPendingOf(split,tabSets){
if(tabSets===null||tabSets===undefined||typeof tabSets!=="object")return"foreign";
const breakdown=dockCellsOf(split);
if(breakdown.readable!==true||breakdown.cells.length!==2)return"foreign";
const byColumn=new Map(breakdown.cells.map((entry)=>[entry.column,entry]));
if(!byColumn.has("0")||!byColumn.has("1"))return"foreign";
const expertTabs=cellTabIdsOf(byColumn.get("0"));
if(expertTabs.readable!==true||expertTabs.ids.size===0)return"foreign";
for(const tabId of expertTabs.ids){
if(tabSets.known.has(tabId)!==true)return"foreign";
if(tabSets.expert.has(tabId)!==true)return"foreign";
}
return cellPendingStateOf(byColumn.get("1"))==="unavailable"?"unavailable":"foreign";
}
function uniqueSplitBy(panel,matches){
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return[];
let nodes=null;
try{nodes=Array.from(panel.querySelectorAll(RIGHTBAR_SPLIT_SELECTOR));}catch{return[];}
const resolved=[];
for(const node of nodes){
if(matches(node)!==true)continue;
resolved.push(node);
if(resolved.length>1)break;
}
return resolved;
}
function resolveSplitContainer(panel,tabSets){
const resolved=uniqueSplitBy(panel,(node)=>splitOwnsExpertPair(node,tabSets)===true);
return resolved.length===1?resolved[0]:null;
}
function splitPairPendingContainers(panel,tabSets){
return uniqueSplitBy(panel,(node)=>splitPairPendingOf(node,tabSets)==="unavailable");
}
function parseSplitTracks(raw){
const value=typeof raw==="string"?raw.trim():"";
if(value==="")return null;
const tracks=[];
let depth=0;
let current="";
for(const character of value){
if(character==="(")depth+=1;
else if(character===")")depth-=1;
if(depth<0)return null;
if(depth===0&&/\s/.test(character)){
if(current!==""){tracks.push(current);current="";}
continue;
}
current+=character;
}
if(depth!==0||current==="")return null;
tracks.push(current);
if(tracks.length!==3)return null;
const first=splitEndTrackFr(tracks[0]);
const last=splitEndTrackFr(tracks[2]);
if(first===null||last===null)return null;
return{first,last,middle:tracks[1]};
}
function splitEndTrackFr(track){
const match=/^minmax\(\s*0(?:px)?\s*,\s*(\d+(?:\.\d+)?)fr\s*\)$/.exec(track);
if(match===null)return null;
const value=Number(match[1]);
return Number.isFinite(value)?value:null;
}
global[SYMBOL]=Object.freeze({
RIGHTBAR_DRAG_HANDLE_SELECTOR,SUBAGENT_CHAT_KIND,capabilityAllowed,createBrandIcon,
createCatalogLookup,currentSessionIdOf,expertGroupTabIdsOf,getOpenSession,
hostAppFrameWidthOf,listSnapshot,makeIcon,metadataOf,
methodOf,normalizeSubagentAddress,paneNodesOf,parseSplitTracks,
resolveClientService,resolveSplitContainer,rightbarPanelForSession,rightbarPanelForSessionCompat,
runtimeStatusOf,sidebarTabCloseKey,sidebarTabKey,sidebarTabSetsForSession,
splitPairPendingContainers,statusIcon,styleTag,subagentChatAddress,
subscribeSessions,titleOf,viewportWidthOf,
});
})(globalThis);
/* source: client-sidebar-poll.js */
(function installClientSidebarPoll(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-poll");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
modelApi,object,text,
}=PURE;
function snapshotContentEquals(left,right){
if(Object.is(left,right))return true;
if(left===null||right===null||typeof left!=="object"||typeof right!=="object")return false;
if(Array.isArray(left)||Array.isArray(right)){
if(Array.isArray(left)!==Array.isArray(right)||left.length!==right.length)return false;
for(let index=0;index<left.length;index+=1){
if(snapshotContentEquals(left[index],right[index])!==true)return false;
}
return true;
}
const leftKeys=Object.keys(left);
const rightKeys=Object.keys(right);
if(leftKeys.length!==rightKeys.length)return false;
for(const key of leftKeys){
if(Object.prototype.hasOwnProperty.call(right,key)!==true)return false;
if(snapshotContentEquals(left[key],right[key])!==true)return false;
}
return true;
}
function samePanelSnapshot(left,right){
if(left===right)return true;
if(left===null||left===undefined||right===null||right===undefined)return false;
return left.schemaVersion===right.schemaVersion
&&left.sessionId===right.sessionId
&&left.rootSessionId===right.rootSessionId
&&(left.partial===true)===(right.partial===true)
&&snapshotContentEquals(left.recovery??null,right.recovery??null)
&&snapshotContentEquals(left.root,right.root);
}
const PANEL_POLL_TIMINGS=Object.freeze({
activeMs:2500,
idleStepsMs:Object.freeze([2500,5000,10000,20000,30000]),
failureBaseMs:1000,
failureMaxMs:30000,
});
function panelFailureDelayMs(failureCount){
const count=Number.isSafeInteger(failureCount)&&failureCount>0?failureCount:0;
if(count===0)return 0;
const exponential=PANEL_POLL_TIMINGS.failureBaseMs*Math.pow(2,Math.min(count-1,16));
return Math.min(exponential,PANEL_POLL_TIMINGS.failureMaxMs);
}
function panelIdleDelayMs(idleLevel){
const steps=PANEL_POLL_TIMINGS.idleStepsMs;
const level=Number.isSafeInteger(idleLevel)&&idleLevel>0?idleLevel:0;
return steps[Math.min(level,steps.length-1)];
}
function panelNextPollDelayMs(state){
const source=object(state);
const failureDelay=panelFailureDelayMs(source.failureCount);
if(failureDelay>0)return failureDelay;
if(source.running!==false)return PANEL_POLL_TIMINGS.activeMs;
return panelIdleDelayMs(source.idleLevel);
}
function readFanoutEventBatch(raw){
const source=object(raw);
const events=Array.isArray(source.events)?source.events:null;
const cursor=Number.isSafeInteger(source.cursor)&&source.cursor>=0?source.cursor:null;
const earliestSequence=Number.isSafeInteger(source.earliestSequence)&&source.earliestSequence>0
?source.earliestSequence
:null;
return{
events,
cursor,
earliestSequence,
gap:source.gap===true,
dropped:Number.isSafeInteger(source.dropped)&&source.dropped>0?source.dropped:0,
conclusive:events!==null,
};
}
function fanoutBatchIsStale(batch,cursor){
if(batch===null||batch===undefined)return false;
if(batch.gap===true)return true;
if(batch.earliestSequence===null||batch.earliestSequence===undefined)return false;
const after=Number.isSafeInteger(cursor)&&cursor>=0?cursor:0;
return batch.earliestSequence>1&&after<batch.earliestSequence;
}
function snapshotHasRunningWork(snapshot){
if(snapshot===null||typeof snapshot!=="object")return false;
if(snapshot.partial===true)return true;
const model=modelApi();
const runtimeStatusOf=typeof model.runtimeStatusOf==="function"?model.runtimeStatusOf:null;
if(runtimeStatusOf===null)return false;
const pending=[snapshot.root];
let visited=0;
while(pending.length>0&&visited<4096){
const node=pending.pop();
visited+=1;
if(node===null||typeof node!=="object")continue;
let status;
try{status=runtimeStatusOf(node,undefined,{});}catch{status="unknown";}
if(status==="running")return true;
if(Array.isArray(node.children))for(const child of node.children)pending.push(child);
if(Array.isArray(node.shards))for(const shard of node.shards)pending.push(shard);
}
return false;
}
function readPanelTabActivity(deps,props,tabInfo){
const injected=deps?.isTabActive;
if(typeof injected==="function"){
try{
const value=injected();
if(value===true||value===false)return value;
}catch{/* 注入读面抛错：按未知处理，退回文档可见性。 */}
}
for(const candidate of[tabInfo,tabInfo?.tab]){
const source=object(candidate);
if(source.active===true||source.active===false)return source.active;
if(source.isActive===true||source.isActive===false)return source.isActive;
}
return null;
}
function applyPanelPollCycle(scheduler,cycle,latestSnapshot){
if(scheduler===null||scheduler===undefined)return;
if(cycle===null||cycle===undefined||typeof cycle!=="object")return;
const id=Number.isSafeInteger(cycle.id)?cycle.id:null;
if(id!==null){
if(id<=scheduler.lastCycleId)return;
scheduler.lastCycleId=id;
}
if(cycle.cancelled===true)return;
if(cycle.ok===true){
scheduler.failureCount=0;
const effective=cycle.snapshot===null||cycle.snapshot===undefined?latestSnapshot:cycle.snapshot;
if(snapshotHasRunningWork(effective)){
scheduler.running=true;
scheduler.idleLevel=0;
}else{
scheduler.running=false;
scheduler.idleLevel=Math.min(
scheduler.idleLevel+1,
PANEL_POLL_TIMINGS.idleStepsMs.length-1,
);
}
}else{
scheduler.failureCount=Math.min(scheduler.failureCount+1,16);
}
scheduler.delay=panelNextPollDelayMs(scheduler);
}
const PANEL_ERROR_SOURCES=Object.freeze({
snapshot:"snapshot",
action:"action",
rpc:"rpc",
});
const RPC_FAILURE_KIND=Symbol.for("dsh-expert-group/rpc-failure-kind");
const RPC_FAILURE_TRANSPORT="rpc";
function markRpcTransportFailure(error){
const failure=error!==null&&typeof error==="object"
?error
:new Error(error===undefined||error===null?"RPC 请求失败":String(error));
try{
Object.defineProperty(failure,RPC_FAILURE_KIND,{
value:RPC_FAILURE_TRANSPORT,
configurable:true,
enumerable:false,
writable:false,
});
}catch{/* 冻结对象：保留原错误，分类按 action 处理。 */}
return failure;
}
function rpcFailureKindOf(error){
if(error===null||typeof error!=="object")return null;
try{
return error[RPC_FAILURE_KIND]===RPC_FAILURE_TRANSPORT?RPC_FAILURE_TRANSPORT:null;
}catch{return null;}
}
function rpcBusinessError(errorBlock){
const block=object(errorBlock);
const error=new Error(text(block.message,"RPC 请求失败"));
try{
Object.defineProperty(error,"code",{
value:text(block.code,null),
configurable:true,
enumerable:false,
writable:false,
});
Object.defineProperty(error,"details",{
value:block.details,
configurable:true,
enumerable:false,
writable:false,
});
}catch{/* 冻结/不可扩展错误对象：保留 message 即可。 */}
return error;
}
const RPC_ADAPTER_PROTOCOL_FIELD="rpcAdapterProtocol";
const RPC_ADAPTER_PROTOCOLS=Object.freeze({
object:"object",
"connection-first":"connection-first",
"request-first":"request-first",
});
function rpcAdapterProtocolOf(deps){
const declared=deps?.[RPC_ADAPTER_PROTOCOL_FIELD];
if(declared===undefined||declared===null||declared==="")return RPC_ADAPTER_PROTOCOLS["connection-first"];
if(typeof declared!=="string")throw new TypeError("RPC adapter 协议标识必须是字符串");
const protocol=declared.trim();
if(protocol==="")return RPC_ADAPTER_PROTOCOLS["connection-first"];
if(protocol===RPC_ADAPTER_PROTOCOLS.object
||protocol===RPC_ADAPTER_PROTOCOLS["connection-first"]
||protocol===RPC_ADAPTER_PROTOCOLS["request-first"])return protocol;
throw new Error("未知的 RPC adapter 协议："+protocol);
}
function rpcAdapterArguments(protocol,ctx,request,init){
const connection=ctx?.connection;
if(protocol===RPC_ADAPTER_PROTOCOLS.object)return[{connection,request,init}];
if(protocol===RPC_ADAPTER_PROTOCOLS["request-first"])return[request,connection,init];
return[connection,request,init];
}
async function callRpc(deps,ctx,request,init={},select){
const fn=deps.requestPluginRpc;
if(typeof fn!=="function")throw markRpcTransportFailure(new Error("当前 DSH 未提供插件 RPC"));
let protocol;
try{
protocol=rpcAdapterProtocolOf(deps);
}catch(error){
throw markRpcTransportFailure(error);
}
let response;
try{
response=await fn(...rpcAdapterArguments(protocol,ctx,request,init));
}catch(error){
throw markRpcTransportFailure(error);
}
if(typeof response?.json==="function"){
let payload;
try{
payload=await response.json();
}catch(error){
throw markRpcTransportFailure(error);
}
if(payload?.ok===false)throw rpcBusinessError(payload.error);
const body=payload?.value??payload;
return typeof select==="function"?select(body):(body?.snapshot??body);
}
if(response?.ok===false)throw rpcBusinessError(response.error);
if(response?.value!==undefined){
if(typeof select==="function")return select(response.value);
return response.value?.snapshot??response.value;
}
return typeof select==="function"?select(response):(response?.snapshot??response);
}
global[SYMBOL]=Object.freeze({
PANEL_ERROR_SOURCES,PANEL_POLL_TIMINGS,RPC_FAILURE_TRANSPORT,applyPanelPollCycle,
callRpc,fanoutBatchIsStale,panelNextPollDelayMs,
readFanoutEventBatch,readPanelTabActivity,rpcFailureKindOf,samePanelSnapshot,
snapshotHasRunningWork,
});
})(globalThis);
/* source: client-sidebar-layout.js */
(function installClientSidebarLayout(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-layout");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_SPLIT_EXPERT_TRACK,SIDEBAR_SPLIT_GAP_TRACK,SIDEBAR_SPLIT_OTHER_TRACK,SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS,SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS,SIDEBAR_SPLIT_TRACK_PROPERTY,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
RIGHTBAR_DRAG_HANDLE_SELECTOR,parseSplitTracks,
}=DOM;
function createRightbarDragLock(){
const HANDLE_STYLE_WRITES=Object.freeze([
{name:"pointer-events",value:"none"},
{name:"cursor",value:"default"},
]);
let locked=false;
let element=null;
let previous=null;
const readHandle=()=>{
try{
const doc=globalThis.document;
if(!doc||typeof doc.querySelector!=="function")return null;
return doc.querySelector(RIGHTBAR_DRAG_HANDLE_SELECTOR)??null;
}catch{return null;}
};
const readStyle=(style,name)=>{
try{return typeof style.getPropertyValue==="function"?style.getPropertyValue(name):"";}catch{return"";}
};
const readPriority=(style,name)=>{
try{return typeof style.getPropertyPriority==="function"?style.getPropertyPriority(name):"";}catch{return"";}
};
const restore=()=>{
const target=element;
const saved=previous;
element=null;
previous=null;
if(target===null||saved===null)return;
let style=null;
try{style=target.style||null;}catch{style=null;}
if(style===null)return;
for(const entry of saved){
try{
if(readStyle(style,entry.name)!==entry.written)continue;
if(readPriority(style,entry.name)!==entry.writtenPriority)continue;
if(entry.value===""||entry.value===null||entry.value===undefined)style.removeProperty?.(entry.name);
else style.setProperty(entry.name,entry.value,entry.priority||"");
}catch{/* 单条属性还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */}
}
};
const apply=()=>{
if(locked!==true)return false;
const candidate=readHandle();
if(candidate===null)return false;
if(candidate!==element){
element=candidate;
previous=null;
}
let style=null;
try{style=candidate.style||null;}catch{style=null;}
if(style===null||typeof style.setProperty!=="function")return false;
if(previous===null){
previous=HANDLE_STYLE_WRITES.map(({name})=>({
name,
value:readStyle(style,name),
priority:readPriority(style,name),
written:null,
writtenPriority:null,
}));
}
HANDLE_STYLE_WRITES.forEach(({name,value},index)=>{
if(readStyle(style,name)===value)return;
try{
style.setProperty(name,value,"important");
previous[index].written=readStyle(style,name);
previous[index].writtenPriority=readPriority(style,name);
}catch{/* 写入失败：保留已经写上的那几条，绝不影响页面其它行为。 */}
});
return true;
};
return{
setLocked(next){
const target=next===true;
if(target===locked){
if(target)apply();
return locked;
}
locked=target;
if(target)apply();
else restore();
return locked;
},
isLocked:()=>locked,
dispose(){
locked=false;
restore();
},
};
}
function createSplitTrackRatio(){
let applied=null;
let hostCapture=null;
let disposed=false;
let pending=null;
let pendingRetryTimer=null;
let lastReader=null;
const readInline=(style,name,readerName)=>{
try{
if(style===null||style===undefined)return null;
const reader=style[readerName];
if(typeof reader!=="function")return null;
const value=reader.call(style,name);
return value===null||value===undefined?"":String(value);
}catch{return null;}
};
const readValue=(style,name)=>readInline(style,name,"getPropertyValue");
const readPriority=(style,name)=>readInline(style,name,"getPropertyPriority");
const styleOf=(container)=>{
try{
const style=container?.style??null;
if(style===null||typeof style.setProperty!=="function")return null;
return style;
}catch{return null;}
};
const composeDesired=(parsed)=>
"minmax(0,"+SIDEBAR_SPLIT_EXPERT_TRACK+"fr) "
+(parsed===null?SIDEBAR_SPLIT_GAP_TRACK:parsed.middle)
+" minmax(0,"+SIDEBAR_SPLIT_OTHER_TRACK+"fr)";
const captureHostStyle=(container)=>{
if(hostCapture!==null&&hostCapture.container===container)return true;
const style=styleOf(container);
if(style===null)return false;
const value=readValue(style,SIDEBAR_SPLIT_TRACK_PROPERTY);
const priority=readPriority(style,SIDEBAR_SPLIT_TRACK_PROPERTY);
if(value===null||priority===null)return false;
hostCapture={container,value,priority};
return true;
};
const shouldApply=(container,parsed,current)=>{
if(hostCapture===null||hostCapture.container!==container)return true;
if(current==="")return true;
if(hostCapture.value===current)return true;
return parsed!==null&&parsed.first===parsed.last;
};
const applyRatio=(container)=>{
const style=styleOf(container);
if(style===null)return false;
const current=readValue(style,SIDEBAR_SPLIT_TRACK_PROPERTY);
const currentPriority=readPriority(style,SIDEBAR_SPLIT_TRACK_PROPERTY);
if(current===null||currentPriority===null)return false;
const parsed=parseSplitTracks(current);
if(current!==""&&parsed===null)return false;
const desired=composeDesired(parsed);
if(current===desired)return true;
if(applied!==null&&applied.container===container
&&current===applied.written&&currentPriority===applied.writtenPriority)return true;
if(shouldApply(container,parsed,current)!==true)return false;
if(captureHostStyle(container)!==true)return false;
try{style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY,desired,currentPriority);}catch{return false;}
applied={
container,
written:readValue(style,SIDEBAR_SPLIT_TRACK_PROPERTY),
writtenPriority:readPriority(style,SIDEBAR_SPLIT_TRACK_PROPERTY),
};
return true;
};
const restore=()=>{
const entry=applied;
applied=null;
if(entry===null)return;
const style=styleOf(entry.container);
if(style===null)return;
if(readValue(style,SIDEBAR_SPLIT_TRACK_PROPERTY)!==entry.written)return;
if(readPriority(style,SIDEBAR_SPLIT_TRACK_PROPERTY)!==entry.writtenPriority)return;
if(hostCapture===null||hostCapture.container!==entry.container)return;
try{
if(hostCapture.value==="")style.removeProperty(SIDEBAR_SPLIT_TRACK_PROPERTY);
else style.setProperty(SIDEBAR_SPLIT_TRACK_PROPERTY,hostCapture.value,hostCapture.priority);
}catch{/* 还原失败只影响外观，后续同步仍按同一规则重试。 */}
};
const cancelPendingRetry=()=>{
if(pendingRetryTimer===null)return;
const timer=pendingRetryTimer;
pendingRetryTimer=null;
try{
globalThis.clearTimeout?.(timer);
}catch{/* 取消失败不能阻止其它所有权释放。 */}
};
const clearPending=()=>{
pending=null;
cancelPendingRetry();
};
const schedulePendingRetry=(container)=>{
if(disposed||pendingRetryTimer!==null)return;
try{
pendingRetryTimer=globalThis.setTimeout(()=>{
pendingRetryTimer=null;
if(disposed)return;
if(pending===null||pending.container!==container)return;
const entry=pending;
if(typeof lastReader!=="function")return;
pending={container,attempts:entry.attempts+1};
sync(lastReader);
if(pending!==null&&pending.container===container
&&pendingRetryTimer===null
&&pending.attempts<SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS){
schedulePendingRetry(container);
}
},SIDEBAR_SPLIT_PENDING_RETRY_DELAY_MS);
}catch{
pendingRetryTimer=null;
}
};
const sync=(readTarget)=>{
if(disposed)return false;
if(typeof readTarget==="function")lastReader=readTarget;
let doc=null;
try{doc=globalThis.document??null;}catch{doc=null;}
if(doc===null||typeof doc.querySelector!=="function")return applied!==null;
let target=null;
try{target=typeof readTarget==="function"?readTarget(doc):null;}catch{target=null;}
if(target===null||target.container===null||target.container===undefined){
clearPending();
restore();
return false;
}
if(pending!==null&&pending.container!==target.container)clearPending();
if(applied!==null&&applied.container!==target.container)restore();
if(target.status==="pending"&&applied!==null&&applied.container===target.container){
const attempts=pending!==null&&pending.container===target.container?pending.attempts:0;
if(attempts<SIDEBAR_SPLIT_PENDING_MAX_ATTEMPTS){
applyRatio(target.container);
if(pending===null)pending={container:target.container,attempts:0};
schedulePendingRetry(target.container);
return true;
}
clearPending();
restore();
return false;
}
clearPending();
if(target.status==="pending")return false;
return applyRatio(target.container);
};
return{
sync,
dispose(){
disposed=true;
clearPending();
restore();
},
};
}
global[SYMBOL]=Object.freeze({
createRightbarDragLock,createSplitTrackRatio,
});
})(globalThis);
/* source: client-sidebar-panel-cache.js */
(function installClientSidebarPanelCache(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-cache");
const SNAPSHOT_CACHE_LIMIT=32;
function createPanelSnapshotCache(options){
const limit=Number.isSafeInteger(options?.limit)&&options.limit>0?options.limit:SNAPSHOT_CACHE_LIMIT;
const snapshotCache=new Map();
const peek=(rootSessionId)=>{
if(rootSessionId===""||snapshotCache.has(rootSessionId)!==true)return null;
return snapshotCache.get(rootSessionId)??null;
};
const write=(rootSessionId,next,updatedAt)=>{
if(rootSessionId===""||next===null||next===undefined)return;
snapshotCache.delete(rootSessionId);
snapshotCache.set(rootSessionId,{snapshot:next,updatedAt:Number.isFinite(updatedAt)?updatedAt:Date.now()});
while(snapshotCache.size>limit){
const oldest=snapshotCache.keys().next();
if(oldest.done===true)break;
snapshotCache.delete(oldest.value);
}
};
const initialStateFor=(rootSessionId)=>{
const cached=peek(rootSessionId);
return{
rootSessionId,
snapshot:cached===null?null:cached.snapshot,
updatedAt:cached===null?null:cached.updatedAt,
loading:cached===null,
error:null,
};
};
const size=()=>snapshotCache.size;
return Object.freeze({limit,peek,write,initialStateFor,size});
}
global[SYMBOL]=Object.freeze({createPanelSnapshotCache});
})(globalThis);
/* source: client-sidebar-split-sync.js */
(function installClientSidebarSplitSync(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-split-sync");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
RIGHTBAR_TAB_SELECTOR,RIGHTBAR_PANE_COLUMN_ATTRIBUTE,RIGHTBAR_PANE_ID_ATTRIBUTE,
SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS,
isGeneratedExpertGroupTabId,object,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
SUBAGENT_CHAT_KIND,expertGroupTabIdsOf,paneNodesOf,rightbarPanelForSessionCompat,
}=DOM;
function presentSidebarTabIds(doc,sidebarSessionId){
if(!doc||typeof doc.querySelector!=="function")return null;
const panel=rightbarPanelForSessionCompat(doc,sidebarSessionId);
if(panel===null||panel===undefined)return null;
if(typeof panel.querySelectorAll!=="function")return null;
let nodes=null;
try{nodes=panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR);}catch{return null;}
if(nodes===null||nodes===undefined)return null;
let entries=[];
try{entries=Array.from(nodes);}catch{return null;}
const ids=new Set();
for(const node of entries){
let raw=null;
try{raw=typeof node?.getAttribute==="function"?node.getAttribute("data-dockkit-tab"):null;}catch{raw=null;}
const id=text(raw,null);
if(id!==null)ids.add(id);
}
return ids;
}
function paneIdsContainingTabs(panel,tabIds,extraMatcher=null){
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return new Set();
let nodes;
try{nodes=Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR));}catch{return new Set();}
const paneIds=new Set();
for(const node of nodes){
let rawTabId=null;
try{rawTabId=typeof node?.getAttribute==="function"?node.getAttribute("data-dockkit-tab"):null;}catch{rawTabId=null;}
const tabId=text(rawTabId,null);
const matched=tabIds.has(tabId)||(typeof extraMatcher==="function"&&extraMatcher(tabId));
if(!matched)continue;
const visited=new Set();
let parent=null;
try{parent=node?.parentElement??node?.parentNode??null;}catch{parent=null;}
while(parent!==null&&parent!==undefined&&!visited.has(parent)){
visited.add(parent);
let rawPaneId=null;
try{
rawPaneId=typeof parent.getAttribute==="function"
?parent.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
:null;
}catch{rawPaneId=null;}
const paneId=text(rawPaneId,null);
if(paneId!==null){
paneIds.add(paneId);
break;
}
try{parent=parent.parentElement??parent.parentNode??null;}catch{parent=null;}
}
}
return paneIds;
}
function paneIdContainingTab(doc,sidebarSessionId,tabId){
if(doc===null||doc===undefined||typeof doc.querySelector!=="function")return null;
const panel=rightbarPanelForSessionCompat(doc,sidebarSessionId);
if(panel===null||panel===undefined)return null;
const paneIds=paneIdsContainingTabs(panel,new Set([tabId]));
return paneIds.size===1?[...paneIds][0]:null;
}
function sidebarSplitTargetEvidence(options){
const inventory=options?.inventory??null;
const sidebarSessionId=text(options?.sidebarSessionId,null);
const resourceAddress=text(options?.resourceAddress,null);
const expectedPaneId=options?.expectedPaneId===undefined||options?.expectedPaneId===null
?null
:text(options.expectedPaneId,null);
if(!Array.isArray(inventory)||sidebarSessionId===null||resourceAddress===null)return null;
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sidebarSessionId)continue;
if(text(candidate.kind,null)!==SUBAGENT_CHAT_KIND)continue;
if(text(candidate.contentId,null)!==resourceAddress)continue;
const tabId=text(candidate.tabId,null);
if(tabId===null)continue;
const paneId=paneIdContainingTab(options.doc??null,sidebarSessionId,tabId);
if(paneId===null)continue;
if(expectedPaneId!==null&&paneId!==expectedPaneId)continue;
return{tabId,paneId};
}catch{
}
}
return null;
}
function expertGroupPaneIds(panel,inventory,sidebarSessionId){
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return new Set();
return paneIdsContainingTabs(
panel,
expertGroupTabIdsOf(inventory,sidebarSessionId),
isGeneratedExpertGroupTabId,
);
}
function existingSubagentPaneId(doc,sidebarSessionId,inventory){
if(!doc||typeof doc.querySelector!=="function")return null;
const panel=rightbarPanelForSessionCompat(doc,sidebarSessionId);
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return null;
const expertPaneIds=expertGroupPaneIds(panel,inventory,sidebarSessionId);
if(expertPaneIds.size===0)return null;
const panes=paneNodesOf(panel);
if(panes===null)return null;
const candidates=[];
for(let index=0;index<panes.length;index+=1){
const pane=panes[index];
let rawPaneId=null;
try{
rawPaneId=typeof pane?.getAttribute==="function"
?pane.getAttribute(RIGHTBAR_PANE_ID_ATTRIBUTE)
:null;
}catch{rawPaneId=null;}
const paneId=text(rawPaneId,null);
if(paneId===null||expertPaneIds.has(paneId))continue;
let rawColumn=null;
try{
rawColumn=typeof pane?.getAttribute==="function"
?pane.getAttribute(RIGHTBAR_PANE_COLUMN_ATTRIBUTE)
:null;
}catch{rawColumn=null;}
const columnText=text(rawColumn,null);
const column=columnText===null?null:Number(columnText);
candidates.push({paneId,column:Number.isFinite(column)?column:null,index});
}
candidates.sort((left,right)=>{
if(left.column!==null&&right.column!==null&&left.column!==right.column){
return right.column-left.column;
}
if(left.column!==null&&right.column===null)return-1;
if(left.column===null&&right.column!==null)return 1;
return right.index-left.index;
});
return candidates[0]?.paneId??null;
}
function seededGuideTabId(beforeTabs,sessionId,afterTabs){
const expectedSessionId=text(sessionId,null);
if(expectedSessionId===null||!Array.isArray(beforeTabs))return null;
const beforeIds=new Set();
for(const tab of beforeTabs){
try{
const candidate=object(tab);
if(text(candidate.sessionId,null)!==expectedSessionId)continue;
const tabId=text(candidate.tabId,null);
if(tabId!==null)beforeIds.add(tabId);
}catch{/* 损坏的 inventory 记录不影响其它 tab。 */}
}
if(!Array.isArray(afterTabs))return null;
const newGuideTabIds=[];
for(const tab of afterTabs){
try{
const candidate=object(tab);
if(text(candidate.sessionId,null)!==expectedSessionId
||text(candidate.kind,null)!=="guide")continue;
const tabId=text(candidate.tabId,null);
if(tabId!==null&&!beforeIds.has(tabId))newGuideTabIds.push(tabId);
}catch{/* 损坏的 inventory 记录不影响其它 tab。 */}
}
return newGuideTabIds.length===1?newGuideTabIds[0]:null;
}
function waitForSidebarSplitLayoutCommit(){
return new Promise((resolve)=>{
let settled=false;
let fallbackTimer=null;
const clearFallback=()=>{
if(fallbackTimer===null)return;
try{globalThis.clearTimeout?.(fallbackTimer);}catch{/* 清理失败时 callback 仍会由 settled 防重。 */}
fallbackTimer=null;
};
const settle=()=>{
if(settled)return;
settled=true;
clearFallback();
resolve();
};
const scheduleFallback=(delay)=>{
try{
const setTimeout=globalThis.setTimeout;
if(typeof setTimeout!=="function"||settled)return false;
fallbackTimer=setTimeout(settle,delay);
return true;
}catch{
return false;
}
};
try{
const requestAnimationFrame=globalThis.requestAnimationFrame;
if(typeof requestAnimationFrame==="function"){
requestAnimationFrame(()=>settle());
if(scheduleFallback(SIDEBAR_SPLIT_LAYOUT_WAIT_FALLBACK_MS))return;
}
}catch{/* 继续尝试不依赖视觉帧的宿主调度器。 */}
if(scheduleFallback(0))return;
try{
const queueMicrotask=globalThis.queueMicrotask;
if(typeof queueMicrotask==="function"){
queueMicrotask(settle);
return;
}
}catch{/* 最后的同步收口保证 Promise 不会永久悬挂。 */}
settle();
});
}
global[SYMBOL]=Object.freeze({
existingSubagentPaneId,
presentSidebarTabIds,
seededGuideTabId,
sidebarSplitTargetEvidence,
waitForSidebarSplitLayoutCommit,
});
})(globalThis);
/* source: client-sidebar-tab-state.js */
(function installClientSidebarTabState(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-tab-state");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
FANOUT_SETTLED_STATUSES,RIGHTBAR_FLOAT_SELECTOR,RIGHTBAR_FLOAT_TITLE_SELECTOR,
SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS,SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS,
SIDEBAR_AUTO_KEY_LIMIT,SIDEBAR_TAB_KEY_SEPARATOR,
object,statusOf,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{SUBAGENT_CHAT_KIND,subagentChatAddress}=DOM;
function presentFloatingSubagentTitles(doc){
if(!doc||typeof doc.querySelectorAll!=="function")return null;
let floats=null;
try{floats=Array.from(doc.querySelectorAll(RIGHTBAR_FLOAT_SELECTOR));}catch{return null;}
const titles=new Set();
for(const float of floats){
if(typeof float?.querySelector!=="function")return null;
let chat=null;
let titleNode=null;
try{
chat=float.querySelector("[data-sidebar-chat]");
titleNode=float.querySelector(RIGHTBAR_FLOAT_TITLE_SELECTOR);
}catch{return null;}
if(chat===null||titleNode===null)continue;
const title=text(titleNode.textContent,null);
if(title!==null)titles.add(title);
}
return titles;
}
function knownSidebarResourceAddresses(snapshot,rootSessionId,addressOf){
const addresses=new Set();
const add=(node,parentId)=>{
const source=object(node);
if(source.kind==="fanout"){
const shards=Array.isArray(source.shards)?source.shards:[];
for(const shard of shards){
const shardSource=object(shard);
const childId=text(shardSource.childId,null);
if(childId===null)continue;
const address=subagentChatAddress(addressOf(childId,parentId,{
...shardSource,
kind:"expert",
}));
if(address!==null)addresses.add(address);
}
}else{
const childId=text(source.sessionId,text(source.childId,null));
if(childId!==null){
const address=subagentChatAddress(addressOf(childId,parentId,source));
if(address!==null)addresses.add(address);
}
}
if(Array.isArray(source.children)){
for(const child of source.children)add(child,parentId);
}
};
const children=Array.isArray(snapshot?.root?.children)?snapshot.root.children:[];
for(const child of children)add(child,rootSessionId);
return addresses;
}
function sidebarExpertResourceAddresses(node,parentId,addresses,deps){
const addressOf=deps.addressOf;
const statusOfNode=deps.statusOf;
const source=object(node);
const kind=text(source.kind,null);
if(kind==="fanout"){
const shards=Array.isArray(source.shards)?source.shards:[];
for(const shard of shards){
const shardSource=object(shard);
const childId=text(shardSource.childId,null);
if(childId===null)continue;
if(statusOfNode(shardSource,parentId,childId)!=="running")continue;
const address=subagentChatAddress(addressOf(childId,parentId,{
...shardSource,
kind:"expert",
}));
if(address!==null)addresses.add(address);
}
return;
}
if(kind!=="expert")return;
const childId=text(source.sessionId,text(source.childId,null));
if(childId!==null&&statusOfNode(source,parentId,childId)==="running"){
const address=subagentChatAddress(addressOf(childId,parentId,source));
if(address!==null)addresses.add(address);
}
if(Array.isArray(source.children)){
for(const child of source.children)sidebarExpertResourceAddresses(child,childId,addresses,deps);
}
}
function sidebarNodeIsIdleReady(node,parentId,childId,deps){
return deps.statusOf(node,parentId,childId,{partial:deps.partial})==="ready";
}
function sidebarNodeIsIdleMembership(node,parentId,childId,deps){
const status=deps.statusOf(node,parentId,childId,{partial:deps.partial});
if(status==="ready")return true;
return deps.partial===true&&status===deps.neutralStatus;
}
function sidebarIdleChildren(children,rootSessionId,deps){
return(Array.isArray(children)?children:[])
.filter((node)=>{
if(node.kind==="fanout")return FANOUT_SETTLED_STATUSES.has(statusOf(node));
return node.kind==="expert"
&&sidebarNodeIsIdleMembership(node,rootSessionId,text(node.sessionId,null),deps);
});
}
function runningSidebarResourceAddresses(children,rootSessionId,deps){
const addresses=new Set();
for(const child of Array.isArray(children)?children:[]){
sidebarExpertResourceAddresses(child,rootSessionId,addresses,deps);
}
return addresses;
}
function idleSidebarResourceAddresses(nodes,rootSessionId,deps){
const addresses=new Set();
for(const node of Array.isArray(nodes)?nodes:[]){
const source=object(node);
if(source.kind==="fanout"){
for(const shard of Array.isArray(source.shards)?source.shards:[]){
const shardSource=object(shard);
const shardChildId=text(shardSource.childId,null);
if(shardChildId===null||sidebarNodeIsIdleReady(shardSource,rootSessionId,shardChildId,deps)!==true)continue;
const shardAddress=subagentChatAddress(deps.addressOf(shardChildId,rootSessionId,{
...shardSource,
kind:"expert",
}));
if(shardAddress!==null)addresses.add(shardAddress);
}
continue;
}
const childId=text(source.sessionId,text(source.childId,null));
if(childId===null)continue;
if(sidebarNodeIsIdleReady(source,rootSessionId,text(source.sessionId,null),deps)!==true)continue;
const address=subagentChatAddress(deps.addressOf(childId,rootSessionId,source));
if(address!==null)addresses.add(address);
}
return addresses;
}
function sidebarResourceTabStateOf(inventory,sidebarSessionId,resourceAddress){
if(inventory===null||inventory===undefined)return{readable:false,tabId:null};
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sidebarSessionId)continue;
if(text(candidate.kind,null)!==SUBAGENT_CHAT_KIND)continue;
if(text(candidate.contentId,null)!==resourceAddress)continue;
return{readable:true,tabId:text(candidate.tabId,null)};
}catch{continue;}
}
return{readable:true,tabId:null};
}
function sidebarAdoptionEvidenceAvailable(inventory,sidebarSessionId,resourceAddress){
const state=sidebarResourceTabStateOf(inventory,sidebarSessionId,resourceAddress);
if(state.readable!==true)return true;
return state.tabId!==null;
}
function sidebarTabKeyAddress(key){
if(typeof key!=="string")return null;
const cut=key.lastIndexOf(SIDEBAR_TAB_KEY_SEPARATOR);
if(cut<=0||key.indexOf(SIDEBAR_TAB_KEY_SEPARATOR)===cut)return null;
return key.slice(cut+1)||null;
}
function sidebarTabVisible(record){
return record!==undefined&&!record.absent;
}
function sidebarTabVerdictOf(inventory,sidebarSessionId,present,floatingTitles,activeTabId,key,record){
const tabId=text(record.tabId,null);
if(present?.has(tabId)||(tabId!==null&&tabId===activeTabId))return"present";
if(floatingTitles?.has(text(record.title,null)))return"present";
const address=sidebarTabKeyAddress(key);
if(address!==null){
const state=sidebarResourceTabStateOf(inventory,text(sidebarSessionId,null),address);
if(state.readable)return state.tabId===null?"absent":"present";
}
return present===null||floatingTitles===null?"undecidable":"missing";
}
function sidebarActiveResourceMatches(activeTab,resourceAddress){
if(activeTab===null||activeTab===undefined)return false;
const tab=object(activeTab);
if(text(tab.kind,null)!==SUBAGENT_CHAT_KIND)return false;
return text(tab.contentId,null)===resourceAddress;
}
function sidebarManualIntentOf(manualIntentMap,key,sidebarSessionId,rootSessionId){
const entry=manualIntentMap.get(key);
if(entry===undefined)return undefined;
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)return undefined;
return entry;
}
function sidebarBatchCandidates(addresses,inventory,sidebarSessionId){
const seen=new Set();
const candidates=[];
for(const entry of Array.isArray(inventory)?inventory:[]){
let candidate=null;
try{
candidate=object(entry);
if(text(candidate.sessionId,null)!==sidebarSessionId)continue;
if(text(candidate.kind,null)!==SUBAGENT_CHAT_KIND)continue;
const tabId=text(candidate.tabId,null);
if(tabId===null)continue;
const contentId=text(candidate.contentId,null);
if(contentId===null||addresses.has(contentId)!==true)continue;
if(seen.has(tabId)===true)continue;
seen.add(tabId);
candidates.push({tabId,address:contentId});
}catch{continue;}
}
return candidates;
}
function sidebarBatchStateFor(addresses,options){
const inventory=options?.inventory??null;
if(inventory===null||inventory===undefined)return{kind:"none",candidates:[]};
const candidates=sidebarBatchCandidates(addresses,inventory,options?.sidebarSessionId??null);
if(candidates.length===0)return{kind:"zero",candidates:[]};
if(options?.closeAvailable!==true)return{kind:"none",candidates:[]};
return{kind:"close",candidates};
}
function sidebarBatchSignatureOf(runningState,idleState){
const part=(state)=>(state.kind==="close"
?"close:"+state.candidates
.map((candidate)=>candidate.tabId+SIDEBAR_TAB_KEY_SEPARATOR+candidate.address)
.join(",")
:state.kind);
return part(runningState)+"|"+part(idleState);
}
function trimAutoKeyMap(map,options){
const limit=Number.isSafeInteger(options?.limit)?options.limit:SIDEBAR_AUTO_KEY_LIMIT;
const activeAware=options?.activeAware===true;
const isActive=typeof options?.isActive==="function"?options.isActive:null;
while(map.size>limit){
let victim=null;
for(const candidate of map.keys()){
if(activeAware!==true||isActive===null||isActive(candidate)!==true){
victim=candidate;
break;
}
}
if(victim===null)break;
map.delete(victim);
}
}
function clearAutoCloseAttempt(ledger,key){
ledger.closeAttempts.delete(key);
ledger.owners.delete(key);
ledger.tabMisses.delete(key);
}
function clearAutoCloseBudget(ledger,key){
clearAutoCloseAttempt(ledger,key);
ledger.closeCooldowns.delete(key);
}
function enterAutoCloseCooldown(ledger,key,isActive){
const cooldowns=ledger.closeCooldowns;
const previous=cooldowns.get(key);
const step=previous===undefined?0:Math.min(previous.step+1,4);
const delay=Math.min(SIDEBAR_AUTO_CLOSE_COOLDOWN_BASE_MS*(2**step),SIDEBAR_AUTO_CLOSE_COOLDOWN_MAX_MS);
cooldowns.set(key,{step,until:Date.now()+delay});
trimAutoKeyMap(cooldowns,{limit:ledger.limit,activeAware:true,isActive});
}
function autoCloseCooldownActive(ledger,key){
const entry=ledger.closeCooldowns.get(key);
return entry!==undefined&&entry.until>Date.now();
}
function releaseExpiredAutoCloseCooldown(ledger,key){
const cooldowns=ledger.closeCooldowns;
const entry=cooldowns.get(key);
if(entry===undefined||entry.until>Date.now())return;
clearAutoCloseAttempt(ledger,key);
}
function autoTabMissesOf(ledger,key,tabId){
const entry=ledger.tabMisses.get(key);
if(entry===undefined||entry.tabId!==tabId)return 0;
return Number.isFinite(entry.misses)?entry.misses:0;
}
function sampleAutoTabMisses(ledger,key,options){
const map=ledger.tabMisses;
const previousMisses=autoTabMissesOf(ledger,key,options?.tabId??null);
map.delete(key);
if(options?.missing!==true)return 0;
const misses=previousMisses+1;
map.set(key,{
sessionId:options?.sidebarSessionId??null,
rootSessionId:options?.rootSessionId??null,
tabId:options?.tabId??null,
misses,
});
const limit=Number.isSafeInteger(ledger.limit)?ledger.limit:SIDEBAR_AUTO_KEY_LIMIT;
while(map.size>limit){
const oldest=map.keys().next();
if(oldest.done===true)break;
map.delete(oldest.value);
}
return misses;
}
function settleAutoCloseAttempt(ledger,key,context){
if(context!==null&&context!==undefined){
const owners=ledger.owners;
if(context.kind==="close"){
if(owners.get(key)!==context.attemptToken)return;
}else if(owners.has(key)===true){
return;
}
}
clearAutoCloseAttempt(ledger,key);
}
global[SYMBOL]=Object.freeze({
autoCloseCooldownActive,
autoTabMissesOf,
clearAutoCloseAttempt,
clearAutoCloseBudget,
enterAutoCloseCooldown,
idleSidebarResourceAddresses,
knownSidebarResourceAddresses,
presentFloatingSubagentTitles,
releaseExpiredAutoCloseCooldown,
runningSidebarResourceAddresses,
sampleAutoTabMisses,
settleAutoCloseAttempt,
sidebarActiveResourceMatches,
sidebarAdoptionEvidenceAvailable,
sidebarBatchCandidates,
sidebarBatchSignatureOf,
sidebarBatchStateFor,
sidebarExpertResourceAddresses,
sidebarIdleChildren,
sidebarManualIntentOf,
sidebarNodeIsIdleMembership,
sidebarNodeIsIdleReady,
sidebarResourceTabStateOf,
sidebarTabVerdictOf,
sidebarTabVisible,
trimAutoKeyMap,
});
})(globalThis);
/* source: client-sidebar-panel-state-a.js */
(function installClientSidebarPanelStateA(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
ANNOUNCEMENT_MAX_ITEMS,RIGHTBAR_WIDTH_RATIO,RIGHTBAR_WIDTH_RATIO_MAX,RIGHTBAR_WIDTH_RATIO_MIN,
announcementEventsOf,clampRightbarWidthRatio,modelFunction,
}=PURE;
const EMPTY_TASK_FILTER=Object.freeze({rootSessionId:null,query:"",role:"",status:""});
const WIDTH_RATIO_KEY_STEP=0.02;
function resolvePanelLocale(model,ctx,tabInfo){
const sources={
ctxLocale:(()=>{try{return ctx?.locale;}catch{return undefined;}})(),
i18nLocale:(()=>{try{return ctx?.i18n?.locale;}catch{return undefined;}})(),
tabInfo,
documentLang:(()=>{
try{return globalThis.document?.documentElement?.lang;}catch{return undefined;}
})(),
navigatorLanguage:(()=>{
try{return globalThis.navigator?.language;}catch{return undefined;}
})(),
};
if(typeof model?.resolveClientLocale==="function")return model.resolveClientLocale(sources);
const candidates=[sources.ctxLocale,sources.i18nLocale,sources.tabInfo?.locale,sources.documentLang,sources.navigatorLanguage];
return candidates.some((value)=>typeof value==="string"&&value.trim().toLowerCase().startsWith("en"))?"en":"zh";
}
function createPanelTranslator(model,locale){
return function translate(key,vars){
if(typeof model?.translateMessage==="function")return model.translateMessage(locale,key,vars);
return"—";
};
}
function errorLabelOf(t,source){
return t("sidebar.error."+(source==="snapshot"||source==="rpc"?source:"action"));
}
function selectTaskFilter(model,filterState,rootSessionId,emptyFilter=EMPTY_TASK_FILTER){
const filterSource=filterState.rootSessionId===rootSessionId?filterState:emptyFilter;
const filterFactory=modelFunction("createTaskFilter");
let taskFilter=null;
if(filterFactory!==null){
try{taskFilter=filterFactory(filterSource);}catch{taskFilter=null;}
}
const filterActive=taskFilter!==null&&taskFilter.active===true;
const passesFilter=(node)=>(filterActive!==true||taskFilter.isVisible(node)===true);
return{filterSource,taskFilter,filterActive,passesFilter};
}
function nextFilterPatch(filterSource,patch,rootSessionId){
return{...filterSource,...patch,rootSessionId};
}
function nextWidthRatioFromDrag(options){
const startX=Number(options?.startX);
const clientX=Number(options?.clientX);
const viewport=Number(options?.viewport);
const startRatio=Number(options?.startRatio);
if(Number.isFinite(startX)!==true||Number.isFinite(clientX)!==true)return null;
if(Number.isFinite(viewport)!==true||viewport<=0)return null;
if(Number.isFinite(startRatio)!==true)return null;
return clampRightbarWidthRatio(startRatio+(startX-clientX)/viewport);
}
function nextWidthRatioFromKey(key,current){
const base=clampRightbarWidthRatio(current)??RIGHTBAR_WIDTH_RATIO;
if(key==="Home")return RIGHTBAR_WIDTH_RATIO_MIN;
if(key==="End")return RIGHTBAR_WIDTH_RATIO_MAX;
if(key==="ArrowLeft")return base-WIDTH_RATIO_KEY_STEP;
if(key==="ArrowRight")return base+WIDTH_RATIO_KEY_STEP;
return null;
}
function normalizeFanoutCursor(cursor,rootSessionId){
if(cursor!==null&&cursor!==undefined&&cursor.rootSessionId===rootSessionId)return cursor;
return{rootSessionId,cursor:0};
}
function adoptFanoutCursor(cursor,requestRoot,envelope){
const next=Number.isSafeInteger(envelope?.cursor)&&envelope.cursor>=0?envelope.cursor:null;
if(next===null)return null;
if(cursor.rootSessionId!==requestRoot)return null;
return{rootSessionId:requestRoot,cursor:Math.max(cursor.cursor,next)};
}
function advanceFanoutCursor(cursor,rootSessionId,nextCursor){
if(!Number.isSafeInteger(nextCursor)||nextCursor<0)return null;
if(cursor.rootSessionId!==rootSessionId)return null;
if(nextCursor<=cursor.cursor)return null;
return{rootSessionId,cursor:nextCursor};
}
function deriveSurfaceToken(scope,token,rootSessionId,sidebarSessionId){
if(scope===null||scope===undefined
||scope.rootSessionId!==rootSessionId
||scope.sidebarSessionId!==sidebarSessionId){
return{
scope:{rootSessionId,sidebarSessionId},
token:{rootSessionId,sidebarSessionId},
};
}
return{scope,token};
}
function nextAnnouncementBaseline(previous,rootSessionId,tasks){
const baseline={rootSessionId,tasks};
if(previous===null||previous===undefined||previous.rootSessionId!==rootSessionId){
return{baseline,events:[]};
}
return{baseline,events:announcementEventsOf(previous.tasks,tasks)};
}
function announcementTextOf(options){
const events=Array.isArray(options?.events)?options.events:[];
const t=options?.t;
const maxItems=Number.isSafeInteger(options?.maxItems)?options.maxItems:ANNOUNCEMENT_MAX_ITEMS;
if(events.length===0||typeof t!=="function")return"";
const visible=events.slice(0,maxItems).map((event)=>t("announce."+event.kind,{name:event.name}));
if(events.length>maxItems)visible.push(t("announce.more",{count:events.length}));
return visible.join(options?.locale==="en"?"; ":"；");
}
global[SYMBOL]=Object.freeze({
EMPTY_TASK_FILTER,
adoptFanoutCursor,
advanceFanoutCursor,
announcementTextOf,
createPanelTranslator,
deriveSurfaceToken,
errorLabelOf,
nextAnnouncementBaseline,
nextFilterPatch,
nextWidthRatioFromDrag,
nextWidthRatioFromKey,
normalizeFanoutCursor,
resolvePanelLocale,
selectTaskFilter,
});
})(globalThis);
/* source: client-sidebar-panel-state-b.js */
(function installClientSidebarPanelStateB(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-b");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
normalizeSessionModelOverrides,normalizeSessionModelSelection,object,
sessionModelModelOptions,sessionModelRowKeysOf,sessionModelSelectionEquals,
sessionModelSelectionOfDraft,text,
}=PURE;
function draftBaseOf(previous,role,baseline){
if(Object.prototype.hasOwnProperty.call(previous,role))return previous[role];
return{
provider:baseline?.provider??"",
model:baseline?.model??"",
reasoningEffort:baseline?.reasoningEffort??"",
};
}
function nextSessionModelDrafts(options){
const previous=object(options?.previous);
const role=options?.role;
const field=options?.field;
const value=options?.value;
const groups=options?.groups;
const base=draftBaseOf(previous,role,options?.baseline);
const next={...base,[field]:value};
if(field==="provider"){
const models=value===""?[]:sessionModelModelOptions(value,groups);
const stillAvailable=next.model!==""
&&models.some((candidate)=>text(object(candidate).id,null)===next.model);
if(stillAvailable!==true){
next.model="";
next.reasoningEffort="";
}
}else if(field==="model"){
const entry=sessionModelModelOptions(next.provider,groups)
.find((candidate)=>text(object(candidate).id,null)===value);
const defaultEffort=text(object(entry?.reasoning).defaultEffort,null);
next.reasoningEffort=defaultEffort===null?"":defaultEffort;
const efforts=Array.isArray(entry?.reasoning?.efforts)?entry.reasoning.efforts:[];
if(next.reasoningEffort!==""
&&efforts.every((effort)=>text(object(effort).id,null)!==next.reasoningEffort)){
next.reasoningEffort="";
}
}
return{...previous,[role]:next};
}
function sessionModelBaselineOf(overrides,roleDefaults,role,orchestrator){
return overrides?.[role]
??(role==="orchestrator"?orchestrator??null:normalizeSessionModelSelection(object(roleDefaults)[role]));
}
function sessionModelPendingChangesOf(options){
const drafts=object(options?.drafts);
const baselineOf=options?.baselineOf;
const changes=[];
for(const role of sessionModelRowKeysOf(options?.meta)){
if(Object.prototype.hasOwnProperty.call(drafts,role)!==true)continue;
const selection=sessionModelSelectionOfDraft(drafts[role]);
if(selection.provider.length===0||selection.model.length===0)continue;
if(sessionModelSelectionEquals(selection,baselineOf(role)))continue;
changes.push({role,selection});
}
return changes;
}
function sessionModelHasInvalidDraftOf(options){
const drafts=object(options?.drafts);
for(const role of sessionModelRowKeysOf(options?.meta)){
if(Object.prototype.hasOwnProperty.call(drafts,role)!==true)continue;
const selection=sessionModelSelectionOfDraft(drafts[role]);
if(selection.provider.length===0||selection.model.length===0)return true;
}
return false;
}
function withoutRoleDraft(drafts,role){
const previous=object(drafts);
if(Object.prototype.hasOwnProperty.call(previous,role)!==true)return previous;
const next={...previous};
delete next[role];
return next;
}
function sessionModelWriteReadyOf(options){
const state=object(options?.state);
return options?.mounted===true
&&state.status==="ready"
&&state.live===true
&&options?.saving!==true
&&options?.rootSessionId!==""
&&options?.sidebarSessionId===options?.rootSessionId;
}
function describeSessionModelFailure(options){
const error=options?.error;
const role=options?.role;
const roles=Array.isArray(options?.roles)?options.roles:sessionModelRowKeysOf(options?.meta);
const t=options?.t;
const code=text(object(error).code,null);
const details=object(object(error).details);
if(code==="session-override-conflict"){
const currentRevision=Number.isSafeInteger(details.currentRevision)&&details.currentRevision>=0
?details.currentRevision
:null;
const overrides=details.overrides===undefined
?null
:normalizeSessionModelOverrides(details.overrides,roles);
return{
statePatch:{revision:currentRevision,overrides},
notice:{
kind:"conflict",
role,
text:t("sidebar.sessionModel.conflict",{
revision:currentRevision===null?"?":currentRevision,
}),
},
};
}
const message=text(object(error).message,null);
return{
statePatch:null,
notice:{
kind:"error",
role,
text:message===null
?t("sidebar.sessionModel.unavailable")
:t("sidebar.sessionModel.failed",{message}),
},
};
}
global[SYMBOL]=Object.freeze({
describeSessionModelFailure,
nextSessionModelDrafts,
sessionModelBaselineOf,
sessionModelHasInvalidDraftOf,
sessionModelPendingChangesOf,
sessionModelWriteReadyOf,
withoutRoleDraft,
});
})(globalThis);
/* source: client-sidebar-views-a.js */
(function installClientSidebarViewsA(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-a");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
ATTEMPT_STATUS_LABELS,failureSummaryText,finiteNumber,formatClockText,formatDurationText,
formatIsoText,mergedRoleLabelsOf,modelApi,modelFunction,object,roleLabelFor:roleLabelForBase,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
makeIcon,sidebarTabKey,subagentChatAddress,
}=DOM;
const finiteToken=(value)=>finiteNumber(value);
const usageOf=(node)=>{
const api=modelApi();
if(typeof api?.normalizeUsage!=="function")return null;
return api.normalizeUsage(object(node).usage);
};
const findPriceOf=(ctx,provider,modelId)=>{
const{meta}=ctx;
const api=modelApi();
if(meta===null||typeof api?.findModelPrice!=="function")return null;
return api.findModelPrice(meta.modelPrices,provider,modelId);
};
const estimateCostOf=(ctx,usage,provider,modelId)=>{
const api=modelApi();
if(typeof api?.estimateUsageCost!=="function")return null;
return api.estimateUsageCost(usage,findPriceOf(ctx,provider,modelId));
};
const formatCost=(value)=>{
const amount=finiteNumber(value);
if(amount===null)return null;
if(amount===0)return"0";
if(amount<0.000001)return amount.toExponential(2);
return amount>=0.01?amount.toFixed(4):amount.toFixed(6);
};
const usageTitleOf=(usage)=>{
const source=usage;
if(source===null)return"用量：—";
const parts=[];
const tokens=[["inputTokens","输入"],["outputTokens","输出"],["cacheReadTokens","缓存读"],["cacheWriteTokens","缓存写"],["reasoningTokens","推理"]];
for(const[field,label]of tokens){
const value=finiteToken(source[field]);
if(value!==null)parts.push(label+" "+value);
}
for(const[field,label]of[["requests","请求"],["retries","重试"],["fallbacks","降级"]]){
const value=finiteToken(source[field]);
if(value!==null)parts.push(label+" "+value);
}
const duration=formatDurationText(source.runMs);
if(duration!==null)parts.push("运行时长 "+duration);
return parts.length===0?"用量：—":"用量："+parts.join(" · ");
};
const renderChevron=(ctx,node,open)=>{
const{react,primitives,t,toggle}=ctx;
const label=open?t("sidebar.collapse"):t("sidebar.expand");
return react.createElement("button",{
type:"button",className:"deg_expert_group_chevron",title:label,
"aria-label":label,"aria-expanded":open,onClick:(event)=>{event?.stopPropagation?.();toggle(node);},
},makeIcon(primitives,open?"IconChevronDownOutlineRegular":"IconChevronRightOutlineRegular",{size:14}));
};
const renderAction=(ctx,label,Icon,onClick,pending)=>{
const{react,primitives}=ctx;
return react.createElement("button",{
type:"button",className:"deg_expert_group_action",title:pending?label+"（处理中）":label,
"aria-label":pending?label+"（处理中）":label,"aria-busy":pending||undefined,disabled:pending,onClick,
},makeIcon(primitives,Icon,{size:14}));
};
const renderSidebarBatchSlot=(ctx,addresses,label)=>{
const{react,primitives,sidebarBatchStateFor,sidebarSessionId,rootSessionId,handleSidebarBatchClose,isBatchPending}=ctx;
const state=sidebarBatchStateFor(addresses);
if(state.kind==="none")return null;
if(state.kind==="zero"){
if(typeof primitives?.IconChevronLeftOutlineRegular!=="function")return null;
return react.createElement("div",{className:"deg_expert_group_trailing"},
react.createElement("span",{
className:"deg_expert_group_sidebar_batch_zero",
"data-zero":"true",
"aria-hidden":"true",
}));
}
if(typeof primitives?.IconChevronLeftOutlineRegular!=="function")return null;
const count=state.candidates.length;
const accessibleName="在侧边栏关闭 "+count+" 个"+label;
const pending=isBatchPending()===true;
return react.createElement("div",{className:"deg_expert_group_trailing"},
react.createElement("button",{
type:"button",
className:"deg_expert_group_sidebar_batch_action",
title:accessibleName,
"aria-label":accessibleName,
"aria-busy":pending||undefined,
disabled:pending,
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
return handleSidebarBatchClose(state.candidates);
},
onKeyDown:(event)=>{event?.stopPropagation?.();},
},react.createElement("span",{
className:"deg_expert_group_double_arrow",
"data-direction":"close",
"aria-hidden":"true",
},
makeIcon(primitives,"IconChevronLeftOutlineRegular",{size:20,className:"deg_expert_group_double_arrow_icon","aria-hidden":true}),
makeIcon(primitives,"IconChevronLeftOutlineRegular",{size:20,className:"deg_expert_group_double_arrow_icon","aria-hidden":true}))));
};
const renderSidebarOpenAction=(ctx,address,label)=>{
const{react,primitives,sidebarSessionId,rootSessionId,openSidebarResource,closeSidebarResource,readActiveSidebarResource,sidebarOpenTabsAvailable,handleSidebarAction,isTabOpen}=ctx;
if(openSidebarResource===null)return null;
const resourceAddress=subagentChatAddress(address);
if(resourceAddress===null)return null;
if(typeof primitives?.IconChevronRightOutlineRegular!=="function")return null;
const toggleCapable=closeSidebarResource!==null
&&(readActiveSidebarResource!==null||sidebarOpenTabsAvailable===true)
&&typeof primitives?.IconChevronLeftOutlineRegular==="function";
const key=sidebarTabKey(sidebarSessionId,rootSessionId,resourceAddress);
const isOpen=toggleCapable===true&&isTabOpen(key)===true;
const accessibleName=(isOpen?"在侧边栏关闭 ":"在侧边栏打开 ")+label;
const buttonProps={
type:"button",
className:"deg_expert_group_sidebar_action",
title:accessibleName,
"aria-label":accessibleName,
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
return handleSidebarAction(key,resourceAddress);
},
onKeyDown:(event)=>{event?.stopPropagation?.();},
};
if(toggleCapable===true){
buttonProps["aria-pressed"]=isOpen;
buttonProps["data-open"]=isOpen?"true":"false";
}
const arrowIcon=isOpen?"IconChevronLeftOutlineRegular":"IconChevronRightOutlineRegular";
return react.createElement("button",buttonProps,react.createElement("span",{
className:"deg_expert_group_double_arrow",
"data-direction":isOpen?"close":"open",
"aria-hidden":"true",
},
makeIcon(primitives,arrowIcon,{size:20,className:"deg_expert_group_double_arrow_icon","aria-hidden":true}),
makeIcon(primitives,arrowIcon,{size:20,className:"deg_expert_group_double_arrow_icon","aria-hidden":true})));
};
const renderAttemptUsage=(ctx,entry,options)=>{
const{react}=ctx;
const source=object(entry);
const usage=usageOf(source);
const fallbackProvider=text(object(options).provider,null);
const fallbackModel=text(object(options).model,null);
const value=(field)=>(usage===null?null:finiteToken(usage[field]));
const pairs=[
["输入",value("inputTokens")],
["输出",value("outputTokens")],
["缓存读",value("cacheReadTokens")],
["缓存写",value("cacheWriteTokens")],
["推理",value("reasoningTokens")],
].map(([label,raw])=>label+" "+(raw===null?"—":String(raw)));
pairs.push("请求 "+(value("requests")===null?"—":String(value("requests"))));
pairs.push("重试 "+(value("retries")===null?"—":String(value("retries"))));
pairs.push("降级 "+(value("fallbacks")===null?"—":String(value("fallbacks"))));
pairs.push("运行时长 "+(formatDurationText(value("runMs"))??"—"));
const provider=(usage===null?null:text(usage.provider,null))??fallbackProvider;
const modelId=(usage===null?null:text(usage.model,null))??fallbackModel;
const price=findPriceOf(ctx,provider,modelId);
let costText="估算成本：未配置单价，不估算";
let currency=null;
const cost=usage===null?null:estimateCostOf(ctx,usage,provider,modelId);
if(price!==null&&cost!==null){
currency=cost.currency;
costText="估算成本 ≈ "+(formatCost(cost.totalCost)??"—")+" "+cost.currency+"（按每百万 token 单价估算）";
}else if(price!==null){
costText="估算成本：—（缺少计费 token）";
}
return react.createElement("div",{
className:"deg_expert_group_attempt_usage",
"data-cost-currency":currency===undefined?undefined:currency,
title:(usage===null?"用量：—":usageTitleOf(usage))+" · "+costText,
},
react.createElement("span",{className:"deg_expert_group_attempt_usage_tokens"},pairs.join(" · ")),
react.createElement("span",{className:"deg_expert_group_attempt_cost","data-cost-configured":price===null?"false":"true"},costText));
};
const renderStructuredBlock=(ctx,value,requested,options)=>{
const{react}=ctx;
const api=modelApi();
const preview=typeof api?.structuredPreviewOf==="function"?api.structuredPreviewOf(value):null;
const asked=requested===true;
if(preview===null&&asked!==true)return null;
const kind=text(object(options).kind,"expert");
let textValue="结构化结果：尚未返回（已请求输出契约）";
let fallback=false;
let truncated=false;
let reason=null;
if(preview!==null){
if(preview.text!==null){
textValue="结构化结果："+preview.text+(preview.truncated===true?" …（预览已截断）":"");
truncated=preview.truncated===true;
}else{
fallback=true;
reason=text(preview.reason,"result_unavailable");
const reasonText=typeof api?.structuredFallbackText==="function"
?api.structuredFallbackText(reason)
:"结构化结果不可用";
textValue="结构化结果回退："+reasonText+"（"+reason+"）";
}
}
return react.createElement("div",{
className:"deg_expert_group_structured",
"data-kind":kind,
"data-fallback":fallback?"true":undefined,
"data-reason":reason===null?undefined:reason,
"data-truncated":truncated?"true":undefined,
role:"status",
title:textValue.length>400?textValue.slice(0,400)+"…":textValue,
},textValue);
};
const renderFailureSummary=(ctx,failure)=>{
const{react}=ctx;
const summary=failureSummaryText(failure);
if(summary===null)return null;
const content=summary.message===null?summary.code:summary.code+" · "+summary.message;
return react.createElement("span",{
key:"failure",
className:"deg_expert_group_failure",
"data-failure-code":summary.code,
role:"status",
title:content,
},content);
};
const renderAttemptTimeline=(ctx,node,options={})=>{
const{react,isTimelineExpanded,toggleTimelineExpanded}=ctx;
const timelineOf=modelFunction("attemptTimelineOf");
if(timelineOf===null)return null;
const key=text(options.key,null);
if(key===null)return null;
const expanded=isTimelineExpanded(key)===true;
let timeline=null;
try{timeline=timelineOf(node,{expanded});}catch{return null;}
if(timeline===null||!Array.isArray(timeline.entries))return null;
const timelineProvider=text(object(node).provider,null);
const timelineModel=text(object(node).model,null);
const rows=timeline.entries.map((entry,index)=>{
const attemptStatus=text(entry.status,"unknown");
const attemptNumber=finiteNumber(entry.attempt)??finiteNumber(entry.position)??index+1;
const duration=formatDurationText(entry.durationMs);
const timestamp=finiteNumber(entry.finishedAt)??finiteNumber(entry.startedAt);
const clock=formatClockText(timestamp);
const durationLabel=duration===null?(clock??"—"):duration;
const cells=[
react.createElement("span",{key:"index",className:"deg_expert_group_attempt_index"},"#"+attemptNumber),
react.createElement("span",{
key:"status",
className:"deg_expert_group_attempt_status",
"data-status":attemptStatus,
},ATTEMPT_STATUS_LABELS[attemptStatus]??attemptStatus),
react.createElement("span",{
key:"duration",
className:"deg_expert_group_attempt_duration",
title:durationLabel,
},durationLabel),
];
if(duration!==null&&clock!==null){
cells.push(react.createElement("span",{
key:"time",
className:"deg_expert_group_attempt_time",
title:formatIsoText(timestamp)??clock,
},clock));
}
return react.createElement("div",{
key:key+":"+attemptNumber+":"+index,
className:"deg_expert_group_attempt",
role:"listitem",
"data-status":attemptStatus,
"data-attempt":String(attemptNumber),
},
react.createElement("div",{className:"deg_expert_group_attempt_row"},...cells),
renderAttemptUsage(ctx,entry,{
provider:text(entry.provider,null)??timelineProvider,
model:text(entry.model,null)??timelineModel,
}),
renderStructuredBlock(ctx,entry.structured,entry.outputSchemaRequested,{kind:"attempt"}));
});
const toggle=timeline.total>timeline.limit
?react.createElement("button",{
key:"toggle",
type:"button",
className:"deg_expert_group_attempts_toggle",
"aria-expanded":expanded,
"aria-label":expanded?"收起尝试时间线":"查看全部尝试时间线",
title:expanded?"只显示最近 "+timeline.limit+" 条":"查看全部 "+timeline.total+" 条",
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
toggleTimelineExpanded(key);
},
},expanded?"收起":"查看全部")
:null;
return react.createElement("div",{
className:"deg_expert_group_attempts",
role:"list",
"aria-label":"尝试时间线",
"data-total":String(timeline.total),
"data-expanded":expanded,
},...rows,toggle);
};
function createSidebarViewsA(ctx){
const deps=ctx;
const mergedRoleLabels=mergedRoleLabelsOf(deps.snapshot,deps.meta);
const roleLabelFor=(role,nodeLabel)=>roleLabelForBase(role,nodeLabel,mergedRoleLabels);
return Object.freeze({
mergedRoleLabels,
roleLabelFor,
finiteToken,
usageOf,
usageTitleOf,
renderChevron:(node,open)=>renderChevron(deps,node,open),
renderAction:(label,Icon,onClick,pending)=>renderAction(deps,label,Icon,onClick,pending),
renderSidebarBatchSlot:(addresses,label)=>renderSidebarBatchSlot(deps,addresses,label),
renderSidebarOpenAction:(address,label)=>renderSidebarOpenAction(deps,address,label),
renderAttemptUsage:(entry,options)=>renderAttemptUsage(deps,entry,options),
renderStructuredBlock:(value,requested,options)=>renderStructuredBlock(deps,value,requested,options),
renderFailureSummary:(failure)=>renderFailureSummary(deps,failure),
renderAttemptTimeline:(node,options)=>renderAttemptTimeline(deps,node,options),
});
}
global[SYMBOL]=Object.freeze({createSidebarViewsA});
})(globalThis);
/* source: client-sidebar-views-b.js */
(function installClientSidebarViewsB(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-b");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
finiteNumber,formatCompactDuration,isFailureStatusOf,latestShardChildIdOf,modelApi,
object,retryWarningThreshold,statusOf,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{metadataOf,titleOf}=DOM;
const sessionSummaryOf=(ctx,sessionId)=>{
const{sessionsSnapshot}=ctx;
if(sessionId===null)return null;
const summary=object(object(sessionsSnapshot.byId)[sessionId]);
return Object.keys(summary).length===0?null:summary;
};
const projectionValueOf=(ctx,sessionId,key)=>{
const{sessionsSnapshot,config}=ctx;
if(sessionId===null||key===null)return null;
const summary=object(sessionSummaryOf(ctx,sessionId));
const fromSummary=object(summary.projectionValues)[key];
if(fromSummary!==undefined&&fromSummary!==null)return fromSummary;
const projection=object(object(object(sessionsSnapshot.projectionsBySession)[sessionId]).values);
const fromProjection=projection[key];
if(fromProjection!==undefined&&fromProjection!==null)return fromProjection;
const readProjection=config.sessions?.projectionValues;
if(typeof readProjection!=="function")return null;
try{
const value=readProjection.call(config.sessions,sessionId);
const container=object(value);
if(container[key]!==undefined&&container[key]!==null)return container[key];
return value===undefined?null:value;
}catch{
return null;
}
};
const contextPressureOfValue=(value)=>{
const source=object(value);
for(const field of["projectedTokens","pressureTokens","contextWindow"]){
if(finiteNumber(source[field])!==null)return source;
}
return null;
};
const contextPressureOf=(ctx,sessionId)=>contextPressureOfValue(projectionValueOf(ctx,sessionId,"contextPressure"));
const projectionNumber=(value)=>(typeof value==="number"&&Number.isFinite(value)&&value>=0?value:null);
const LIVE_TURN_EXTRAPOLATION_MAX_AGE_MS=120000;
const DSH_STATS_FIELDS=Object.freeze(["llmMs","toolMs","decodeMs","decodeTokens"]);
const DSH_TOKEN_FIELDS=Object.freeze([
"uncachedInputTokens","cacheReadTokens","cacheWriteTokens","outputTokens",
]);
const dshMetricsOf=(ctx,sessionIds)=>{
const ids=Array.isArray(sessionIds)?sessionIds:[];
const stats={};
const tokens={};
let contributors=0;
for(const rawId of ids){
const sessionId=text(rawId,null);
if(sessionId===null)continue;
const statsValue=object(projectionValueOf(ctx,sessionId,"sessionStats"));
const tokensValue=object(projectionValueOf(ctx,sessionId,"tokenUsage"));
let touched=false;
for(const field of DSH_STATS_FIELDS){
const value=projectionNumber(statsValue[field]);
if(value===null)continue;
stats[field]=(stats[field]??0)+value;
touched=true;
}
for(const field of DSH_TOKEN_FIELDS){
const value=projectionNumber(tokensValue[field]);
if(value===null)continue;
tokens[field]=(tokens[field]??0)+value;
touched=true;
}
if(touched)contributors+=1;
}
if(contributors===0)return null;
const valueOf=(bag,field)=>(bag[field]===undefined?null:bag[field]);
return{
sessionCount:contributors,
llmMs:valueOf(stats,"llmMs"),
toolMs:valueOf(stats,"toolMs"),
decodeMs:valueOf(stats,"decodeMs"),
decodeTokens:valueOf(stats,"decodeTokens"),
uncachedInputTokens:valueOf(tokens,"uncachedInputTokens"),
cacheReadTokens:valueOf(tokens,"cacheReadTokens"),
cacheWriteTokens:valueOf(tokens,"cacheWriteTokens"),
outputTokens:valueOf(tokens,"outputTokens"),
};
};
const dshUsageOf=(metrics)=>{
if(metrics===null)return null;
const{uncachedInputTokens,cacheReadTokens,cacheWriteTokens,outputTokens}=metrics;
if(uncachedInputTokens===null&&cacheReadTokens===null&&cacheWriteTokens===null&&outputTokens===null){
return null;
}
const complete=uncachedInputTokens!==null&&cacheReadTokens!==null&&cacheWriteTokens!==null;
const billedInputTokens=complete?uncachedInputTokens+cacheReadTokens+cacheWriteTokens:null;
return{
inputTokens:uncachedInputTokens,
cacheReadTokens,
cacheWriteTokens,
outputTokens,
billedInputTokens,
totalTokens:billedInputTokens!==null&&outputTokens!==null?billedInputTokens+outputTokens:null,
};
};
const dshThroughputOf=(metrics)=>{
if(metrics===null||metrics.decodeMs===null||metrics.decodeTokens===null)return null;
if(metrics.decodeMs<=0||metrics.decodeTokens<=0)return null;
return metrics.decodeTokens/(metrics.decodeMs/1000);
};
const fanoutSessionIdsOf=(task)=>{
const ids=[];
const seen=new Set();
const source=object(task);
for(const shard of Array.isArray(source.shards)?source.shards:[]){
const childId=latestShardChildIdOf(shard);
if(childId===null||seen.has(childId))continue;
seen.add(childId);
ids.push(childId);
}
return ids;
};
const sessionStatsPresentOf=(ctx,sessionId)=>{
const value=object(projectionValueOf(ctx,sessionId,"sessionStats"));
for(const field of DSH_STATS_FIELDS){
if(projectionNumber(value[field])!==null)return true;
}
return false;
};
const durationOfNode=(ctx,source,runtimeStatus,sessionId)=>{
const{snapshot,sessionsSnapshot}=ctx;
const direct=finiteNumber(source.durationMs);
if(direct!==null)return direct;
const usage=ctx.a.usageOf(source);
const runMs=finiteNumber(usage===null?null:usage.runMs);
if(runMs!==null)return runMs;
const summary=object(sessionSummaryOf(ctx,sessionId));
const startedAt=finiteNumber(source.startedAt)??finiteNumber(summary.createdAt);
if(startedAt===null)return null;
const endedAt=runtimeStatus==="running"
?(finiteNumber(object(snapshot).generatedAt)??finiteNumber(sessionsSnapshot.generatedAt))
:(finiteNumber(summary.updatedAt)??finiteNumber(source.lastActivityAt));
if(endedAt===null)return null;
const elapsed=endedAt-startedAt;
return elapsed>0?elapsed:null;
};
const renderMetrics=(ctx,node,options={})=>{
const{react}=ctx;
const source=object(node);
const status=statusOf(source);
const kind=text(options.kind,text(source.kind,"expert"));
const runtimeStatus=text(options.runtimeStatus,null);
const sessionId=text(options.sessionId,null);
const sessionIds=Array.isArray(options.sessionIds)
?options.sessionIds
:(sessionId===null?[]:[sessionId]);
const api=modelApi();
const dsh=dshMetricsOf(ctx,sessionIds);
const dshUsage=dshUsageOf(dsh);
const usage=dshUsage!==null?dshUsage:ctx.a.usageOf(source);
const measuredTps=dshThroughputOf(dsh);
const dshLlmMs=dsh===null?null:dsh.llmMs;
const dshDuration=dshLlmMs!==null&&dshLlmMs>0?dshLlmMs:null;
const turnDurationMs=finiteNumber(source.turnDurationMs);
const turnOpenSince=finiteNumber(source.turnOpenSince);
const openSnapshot=object(ctx.snapshot);
const generatedAt=finiteNumber(openSnapshot.generatedAt);
const liveAge=generatedAt!==null&&runtimeStatus==="running"&&turnDurationMs!==null
&&turnOpenSince!==null&&openSnapshot.partial!==true?Date.now()-generatedAt:-1;
const extrapolationMs=liveAge>=0&&liveAge<=LIVE_TURN_EXTRAPOLATION_MAX_AGE_MS?liveAge:0;
const durationMs=turnDurationMs!==null
?turnDurationMs+extrapolationMs
:(dshDuration!==null?dshDuration:durationOfNode(ctx,source,runtimeStatus,sessionId));
let summary=typeof api?.summarizeUsageMetrics==="function"
?api.summarizeUsageMetrics(usage,{
durationMs,
contextPressure:contextPressureOf(ctx,sessionId),
measuredTokensPerSecond:measuredTps,
})
:null;
const idlePlaceholder=typeof api?.isEmptyUsageMetrics==="function"
&&summary!==null
&&(dsh!==null||summary.totalTokens===0)
&&api.isEmptyUsageMetrics(summary);
const zeroFill=summary!==null&&(idlePlaceholder
||(summary.durationText!==null
&&(runtimeStatus==="running"||dsh!==null||usage!==null||summary.totalTokens!==null)));
const fill=zeroFill&&typeof api?.zeroFilledUsageMetrics==="function"
?api.zeroFilledUsageMetrics(summary,{skipContext:kind==="fanout"})
:null;
if(fill!==null)summary=fill.metrics;
const segments=[];
const pushSegment=(key,textValue,titleValue)=>{
if(typeof textValue!=="string"||textValue.length===0)return;
if(segments.length>0){
segments.push(react.createElement("span",{
key:key+"-separator",
className:"deg_expert_group_metrics_separator",
"aria-hidden":"true",
}," · "));
}
segments.push(react.createElement("span",{
key,
className:"deg_expert_group_metrics_part",
title:typeof titleValue==="string"?titleValue:textValue,
},textValue));
};
const segmentTitle=(key,value)=>(fill!==null&&fill.filled[key]===true?null:value);
if(summary!==null){
const toolDurationText=dsh===null||dsh.toolMs===null?null:formatCompactDuration(dsh.toolMs);
const modelDurationText=dshDuration===null?null:formatCompactDuration(dshDuration);
const durationTitle=summary.durationText===null?null
:turnDurationMs!==null
?"累计轮次用时 "+summary.durationText
+(modelDurationText===null?"":" · 模型用时 "+modelDurationText)
+(toolDurationText===null?"":" · 工具调用用时 "+toolDurationText)
:dshDuration!==null
?"模型用时 "+summary.durationText+(toolDurationText===null?"":" · 工具调用用时 "+toolDurationText)
:"运行时间 "+summary.durationText;
pushSegment("duration",summary.durationText===null?null:"用时"+summary.durationText,
segmentTitle("durationText",durationTitle));
pushSegment("throughput",summary.throughputText,
segmentTitle("throughputText",summary.throughputText===null?null
:(measuredTps===null?"平均吞吐 ":"输出速度 ")+summary.throughputText));
const usageTitle=usage===null?null:ctx.a.usageTitleOf(usage);
pushSegment("tokens",summary.totalTokensText,
segmentTitle("totalTokensText",usageTitle===null?summary.totalTokensText:usageTitle.slice(0,400)));
pushSegment("cache-hit",summary.cacheHitText,
segmentTitle("cacheHitText",summary.cacheHitPercent===null?null
:"缓存命中率 "+summary.cacheHitPercent+"%（缓存读 ÷ 计费输入）"));
const contextDetailReady=Number.isFinite(summary.contextPercent)
&&Number.isFinite(summary.contextUsedTokens)
&&Number.isFinite(summary.contextWindow);
pushSegment("context",summary.contextText,
segmentTitle("contextText",contextDetailReady
?"上下文占用 "+summary.contextPercent+"%（已用 "+summary.contextUsedTokens+" / 窗口 "+summary.contextWindow+"）"
:null));
}
const retryCount=finiteNumber(source.retryCount);
const retryWarning=retryCount!==null&&retryCount>=retryWarningThreshold()
?react.createElement("span",{
key:"retry-warning",
className:"deg_expert_group_retry_warning",
"data-retry-warning":"true",
role:"status",
title:"已重试 "+retryCount+" 次",
},"多次重试")
:null;
const failure=isFailureStatusOf(status)?ctx.a.renderFailureSummary(source.failure):null;
if(segments.length===0&&retryWarning===null&&failure===null)return null;
return react.createElement("div",{
className:"deg_expert_group_metrics",
"data-metrics-kind":kind,
role:"group",
"aria-label":"任务用量摘要",
},...segments,retryWarning,failure);
};
const renderRowMain=(ctx,node,options={})=>{
const{react,subagentAddressOfChild,handleOpen,navigation}=ctx;
const source=object(node);
const fullName=titleOf(source);
const oneLine=options.oneLine!==false;
const parentId=text(options.parentId,null);
const clickableId=text(options.sessionId,text(source.sessionId,text(source.childId,null)));
const address=subagentAddressOfChild(clickableId,parentId,source);
const navigable=navigation.available===true&&clickableId!==null;
const onNavigate=navigable?()=>handleOpen(clickableId,address):undefined;
const onKeyDown=onNavigate===undefined?undefined:(event)=>{
if(event?.key!=="Enter"&&event?.key!==" ")return;
event.preventDefault?.();
event.stopPropagation?.();
onNavigate();
};
const taskLabel="打开任务会话："+fullName;
const navigateProps=onNavigate===undefined?{}:{
role:"button",
tabIndex:0,
"aria-label":taskLabel,
onKeyDown,
};
const metadata=metadataOf(source,ctx.a.mergedRoleLabels);
const taskClassName="deg_expert_group_line deg_expert_group_task"
+(oneLine?"":" deg_expert_group_shard_task");
const trailing=options.trailing===undefined?null:options.trailing;
const taskChildren=[
react.createElement("div",{className:taskClassName,title:fullName,onClick:onNavigate,...navigateProps},fullName),
ctx.a.renderSidebarOpenAction(address,fullName),
];
if(trailing!==null)taskChildren.push(trailing);
const taskLine=react.createElement("div",{
className:"deg_expert_group_task_line"+(trailing===null?"":" deg_expert_group_task_line_trailing"),
},...taskChildren);
const rowMain=react.createElement("div",{className:"deg_expert_group_row_main","data-kind":source.kind||"expert","data-expanded":true},
taskLine,
react.createElement("div",{className:"deg_expert_group_meta",title:metadata},metadata));
const extras=[];
if(options.metrics!==undefined&&options.metrics!==null)extras.push(options.metrics);
if(options.footer!==undefined&&options.footer!==null)extras.push(options.footer);
if(extras.length===0)return rowMain;
return react.createElement("div",{className:"deg_expert_group_cell"},rowMain,...extras);
};
function createSidebarViewsB(ctx,viewsA){
const deps={...ctx,a:viewsA};
return Object.freeze({
sessionStatsPresentOf:(sessionId)=>sessionStatsPresentOf(deps,sessionId),
durationOfNode:(source,runtimeStatus,sessionId)=>durationOfNode(deps,source,runtimeStatus,sessionId),
fanoutSessionIdsOf:(task)=>fanoutSessionIdsOf(task),
renderMetrics:(node,options)=>renderMetrics(deps,node,options),
renderRowMain:(node,options)=>renderRowMain(deps,node,options),
});
}
global[SYMBOL]=Object.freeze({createSidebarViewsB});
})(globalThis);
/* source: client-sidebar-views-c.js */
(function installClientSidebarViewsC(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-c");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
ACTIVE_STATUSES,RETRY_STATUSES,RUNTIME_STATUS_LABELS,STATUS_FILTER_OPTIONS,
normalizeSessionModelSelection,object,sessionModelModelOptions,sessionModelOrchestratorOf,sessionModelRolesOf,statusOf,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{capabilityAllowed,runtimeStatusOf,statusIcon}=DOM;
const renderExpert=(ctx,node,index,parentId,treeMeta)=>{
const{react,primitives,passesFilter,partialSnapshot,expand}=ctx;
if(passesFilter(node)!==true)return null;
const runtimeStatus=ctx.runtimeStatusOfNode(node,parentId,undefined,{partial:partialSnapshot});
const children=Array.isArray(node.children)?node.children:[];
const hasChildren=children.length>0;
const expertOpen=hasChildren?expand(node):true;
const chevron=hasChildren
?ctx.a.renderChevron(node,expertOpen)
:react.createElement("span",{className:"deg_expert_group_chevron_placeholder","aria-hidden":"true"});
const meta=treeMeta!==undefined&&treeMeta!==null
?treeMeta
:{level:2,posinset:index+1,setsize:index+1};
const visibleChildNodes=children.filter((child)=>passesFilter(child)===true);
return react.createElement("div",{key:node.id||node.sessionId||"expert-"+index,className:"deg_expert_group_node",role:"none"},
react.createElement("div",{
className:"deg_expert_group_row",
role:"treeitem",
"aria-level":meta.level,
"aria-posinset":meta.posinset,
"aria-setsize":meta.setsize,
...(hasChildren?{"aria-expanded":expertOpen}:{}),
"data-status":runtimeStatus,
"data-expanded":expertOpen,
},
statusIcon(react,primitives,runtimeStatus),
chevron,
react.createElement("div",null,ctx.b.renderRowMain(node,{
sessionId:node.sessionId,
parentId,
metrics:ctx.b.renderMetrics(node,{kind:node.kind||"expert",runtimeStatus,sessionId:node.sessionId,sessionIds:[node.sessionId]}),
footer:ctx.a.renderStructuredBlock(node.structured,node.outputSchemaRequested,{kind:node.kind||"expert"}),
}))),
hasChildren&&expertOpen
?react.createElement("div",{className:"deg_expert_group_children",role:"group"},visibleChildNodes.map((child,childIndex)=>renderExpert(ctx,child,childIndex,parentId,{
level:meta.level+1,
posinset:childIndex+1,
setsize:visibleChildNodes.length,
})))
:null);
};
const renderIdleGroup=(ctx,nodes,trailing,treeMeta)=>{
const{react,primitives,t,rootSessionId,expand,partialSnapshot,neutralRuntimeStatus}=ctx;
const members=Array.isArray(nodes)?nodes:[];
const group={kind:"idle-group",id:rootSessionId+"__idle__",taskName:t("sidebar.idleGroup.name"),status:"idle",children:members};
const open=expand(group);
const idleTitleChildren=[
react.createElement("div",{className:"deg_expert_group_line deg_expert_group_task"},t("sidebar.idleGroup",{count:members.length})),
];
if(trailing!==undefined&&trailing!==null)idleTitleChildren.push(trailing);
const idleGroupStatus=partialSnapshot===true?neutralRuntimeStatus:"ready";
const meta=treeMeta!==undefined&&treeMeta!==null
?treeMeta
:{level:2,posinset:1,setsize:1};
return react.createElement("div",{className:"deg_expert_group_idle_group","data-expanded":open,role:"none"},
react.createElement("div",{
className:"deg_expert_group_row deg_expert_group_idle_header",
role:"treeitem",
"aria-level":meta.level,
"aria-posinset":meta.posinset,
"aria-setsize":meta.setsize,
"aria-expanded":open,
"data-status":idleGroupStatus,
"data-expanded":open,
},
statusIcon(react,primitives,idleGroupStatus),
ctx.a.renderChevron(group,open),
react.createElement("div",{className:"deg_expert_group_idle_title_line"},...idleTitleChildren)),
open?react.createElement("div",{className:"deg_expert_group_children deg_expert_group_idle_children",role:"group"},members.map((node,index)=>node.kind==="fanout"?renderFanout(ctx,node,index,{level:meta.level+1,posinset:index+1,setsize:members.length}):renderExpert(ctx,node,index,rootSessionId,{level:meta.level+1,posinset:index+1,setsize:members.length}))):null);
};
const renderShard=(ctx,task,shard,index,treeMeta)=>{
const{react,primitives,rootSessionId,runAction,isActionPending}=ctx;
const shardKey=text(shard.shardId,"shard-"+index);
const latestChildId=text(shard.childId,null);
const status=statusOf(shard);
const shardTaskName=text(shard.taskName,null);
const shardNode={
...shard,
id:task.parentTaskId+":"+shardKey,
kind:"expert",
taskName:shardTaskName===null||shardTaskName===shardKey?shardKey:shardKey+"  "+shardTaskName,
content:text(shard.prompt,""),
};
const cancelKey="cancel:"+task.parentTaskId+":"+shardKey;
const retryKey="retry:"+task.parentTaskId+":"+shardKey;
const actions=[];
const cancelCapability=capabilityAllowed(shard,"cancel");
const retryCapability=capabilityAllowed(shard,"retry");
const showCancel=cancelCapability===null?ACTIVE_STATUSES.has(status):cancelCapability===true;
const showRetry=retryCapability===null?RETRY_STATUSES.has(status):retryCapability===true;
if(showCancel)actions.push(ctx.a.renderAction("取消分片 "+shardKey,"IconStopFillRegular",()=>runAction({action:"fanout-cancel-shard",parentTaskId:task.parentTaskId,shardId:shardKey},cancelKey,true,"确认取消分片 "+shardKey+"？"),isActionPending(cancelKey)));
if(showRetry)actions.push(ctx.a.renderAction("重试分片 "+shardKey,"IconRefreshOutlineRegular",()=>runAction({action:"fanout-retry-shard",parentTaskId:task.parentTaskId,shardId:shardKey},retryKey,false,""),isActionPending(retryKey)));
const runtimeStatus=ctx.runtimeStatusOfNode(shardNode,rootSessionId,latestChildId);
const shardStructured=ctx.a.renderStructuredBlock(shard.structured,shard.outputSchemaRequested,{kind:"shard"});
const shardFooter=shardStructured===null
?null
:react.createElement("div",{className:"deg_expert_group_shard_extra"},shardStructured);
const meta=treeMeta!==undefined&&treeMeta!==null
?treeMeta
:{level:3,posinset:index+1,setsize:index+1};
return react.createElement("div",{
key:shardKey,
className:"deg_expert_group_shard",
role:"treeitem",
"aria-level":meta.level,
"aria-posinset":meta.posinset,
"aria-setsize":meta.setsize,
"data-shard-id":shardKey,
"data-status":runtimeStatus,
"data-expanded":true,
},
statusIcon(react,primitives,runtimeStatus),
react.createElement("span",{className:"deg_expert_group_chevron_placeholder","aria-hidden":"true"}),
ctx.b.renderRowMain(shardNode,{
sessionId:latestChildId,
parentId:rootSessionId,
oneLine:false,
metrics:ctx.b.renderMetrics(shard,{kind:"shard",runtimeStatus,sessionId:latestChildId,sessionIds:[latestChildId]}),
footer:shardFooter,
}),
react.createElement("div",{className:"deg_expert_group_actions"},actions));
};
const renderFanout=(ctx,task,index,treeMeta)=>{
const{react,primitives,expand,handleOpen,navigation,passesFilter,filterActive,taskFilter,runAction,isActionPending}=ctx;
if(passesFilter(task)!==true)return null;
const shards=Array.isArray(task.shards)?task.shards:[];
const visibleShards=filterActive===true&&taskFilter!==null?taskFilter.shardsFor(task):shards;
const open=expand(task);
const incomplete=shards.filter((shard)=>ACTIVE_STATUSES.has(statusOf(shard))).length;
const parentKey="cancel-parent:"+task.parentTaskId;
const cancelCapability=capabilityAllowed(task,"cancel");
const showCancel=cancelCapability===null
?(ACTIVE_STATUSES.has(statusOf(task))||incomplete>0)
:cancelCapability===true;
const actions=showCancel
?[ctx.a.renderAction("取消父任务（未完成 "+incomplete+" 个分片）","IconStopFillRegular",()=>runAction({action:"fanout-cancel-parent",parentTaskId:task.parentTaskId},parentKey,true,"确认取消父任务？未完成 "+incomplete+" 个分片。"),isActionPending(parentKey))]
:[];
const runtimeStatus=runtimeStatusOf(task,null);
const meta=treeMeta!==undefined&&treeMeta!==null
?treeMeta
:{level:2,posinset:index+1,setsize:index+1};
const fanoutRole=ctx.a.roleLabelFor(task.role,task.roleLabel)??"Expert";
const fanoutTitle=fanoutRole.charAt(0).toUpperCase()+fanoutRole.slice(1)
+" · "+shards.length+" shards · "+RUNTIME_STATUS_LABELS[runtimeStatusOf(task,null)];
const fanoutNavigationId=(()=>{
const explicit=text(task.sessionId,null);
if(explicit!==null)return explicit;
let fallback=null;
for(const shard of visibleShards){
const childId=text(object(shard).childId,null);
if(childId===null)continue;
if(ACTIVE_STATUSES.has(statusOf(shard)))return childId;
if(fallback===null)fallback=childId;
}
return fallback;
})();
const fanoutNavigable=navigation.available===true&&fanoutNavigationId!==null;
const onFanoutKeyDown=fanoutNavigable
?(event)=>{
if(event?.key!=="Enter"&&event?.key!==" ")return;
event.preventDefault?.();
event.stopPropagation?.();
handleOpen(fanoutNavigationId);
}
:undefined;
return react.createElement("div",{key:task.parentTaskId||"fanout-"+index,className:"deg_expert_group_fanout",role:"none","data-status":runtimeStatus,"data-task-status":statusOf(task)},
react.createElement("div",{
className:"deg_expert_group_fanout_header",
role:"treeitem",
"aria-level":meta.level,
"aria-posinset":meta.posinset,
"aria-setsize":meta.setsize,
"aria-expanded":open,
},
statusIcon(react,primitives,runtimeStatus),
ctx.a.renderChevron(task,open),
react.createElement("div",{className:"deg_expert_group_fanout_title"},
react.createElement("div",{
className:"deg_expert_group_line deg_expert_group_task",
title:fanoutTitle,
...(fanoutNavigable?{role:"button",tabIndex:0,"aria-label":"打开任务会话："+fanoutTitle,onKeyDown:onFanoutKeyDown}:{}),
onClick:fanoutNavigable?()=>handleOpen(fanoutNavigationId):undefined,
},fanoutTitle),
ctx.b.renderMetrics(task,{kind:"fanout",runtimeStatus,sessionIds:ctx.b.fanoutSessionIdsOf(task)})),
react.createElement("div",{className:"deg_expert_group_actions"},actions)),
open?react.createElement("div",{className:"deg_expert_group_fanout_shards deg_expert_group_tree_children",role:"group"},visibleShards.map((shard,shardIndex)=>renderShard(ctx,task,shard,shardIndex,{
level:meta.level+1,
posinset:shardIndex+1,
setsize:visibleShards.length,
}))):null);
};
const sessionModelOptionOf=(ctx,value,label,disabled)=>{
const{react}=ctx;
return react.createElement("option",{
key:"opt:"+(disabled===true?"disabled:":"")+value,
value,
...(disabled===true?{disabled:true}:{}),
},label);
};
const sessionModelOrchestratorViewOf=(ctx)=>{
const{t}=ctx;
const status=object(ctx.sessionModelState?.orchestrator);
const{state,selection}=sessionModelOrchestratorOf(status,ctx.meta);
const degraded=Number.isSafeInteger(status.degradedCandidate)&&status.degradedCandidate>0
?status.degradedCandidate
:0;
const source=["override","period","global"].includes(status.source)?status.source:"none";
const line=t("sidebar.sessionModel.orchestrator."+state,{
value:selection===null
?""
:selection.provider+" / "+selection.model+(selection.reasoningEffort?" · "+selection.reasoningEffort:""),
source:t("sidebar.sessionModel.orchestrator.source."+source),
});
return{
selection,
hostReady:state!=="host-not-ready",
text:degraded>0&&state==="applied"
?line+" · "+t("sidebar.sessionModel.orchestrator.degraded",{index:degraded})
:line,
state,
};
};
const sessionModelRowOf=(ctx,role,groups,fallback,label)=>{
const{t,meta,sessionModelState,sessionModelDrafts}=ctx;
const current=sessionModelState.overrides[role]??null;
const globalDefault=fallback!==void 0
?fallback
:normalizeSessionModelSelection(object(meta?.roleDefaults)[role]);
const hasDraft=Object.prototype.hasOwnProperty.call(sessionModelDrafts,role);
const baseline=current??globalDefault;
const editable=hasDraft
?sessionModelDrafts[role]
:{
provider:baseline?.provider??"",
model:baseline?.model??"",
reasoningEffort:baseline?.reasoningEffort??"",
};
const providerValue=typeof editable.provider==="string"?editable.provider:"";
const modelValue=typeof editable.model==="string"?editable.model:"";
const effortValue=typeof editable.reasoningEffort==="string"?editable.reasoningEffort:"";
const roleLabel=label??ctx.a.roleLabelFor(role,null)??role;
const providerGroup=groups.find((group)=>text(object(group).id,null)===providerValue);
const models=sessionModelModelOptions(providerValue,groups);
const modelEntry=models.find((candidate)=>text(object(candidate).id,null)===modelValue);
const reasoningRaw=modelEntry?.reasoning;
const reasoning=reasoningRaw!==null&&typeof reasoningRaw==="object"&&Array.isArray(reasoningRaw)!==true
?reasoningRaw
:null;
const efforts=Array.isArray(reasoning?.efforts)?reasoning.efforts:[];
const providerOptions=[sessionModelOptionOf(ctx,"","未选择供应商")];
if(providerValue!==""&&providerGroup===undefined){
providerOptions.push(sessionModelOptionOf(ctx,providerValue,providerValue+"（不可用）",true));
}
for(const group of groups){
const id=text(object(group).id,null);
if(id===null||id==="")continue;
providerOptions.push(sessionModelOptionOf(ctx,id,text(object(group).name,null)??id));
}
const modelOptions=[];
if(providerValue===""){
modelOptions.push(sessionModelOptionOf(ctx,"","先选择供应商",true));
}else{
modelOptions.push(sessionModelOptionOf(ctx,"","未选择模型"));
if(modelValue!==""&&modelEntry===undefined){
modelOptions.push(sessionModelOptionOf(ctx,modelValue,modelValue+"（不可用）",true));
}
for(const candidate of models){
const id=text(object(candidate).id,null);
if(id===null||id==="")continue;
modelOptions.push(sessionModelOptionOf(ctx,id,text(object(candidate).name,null)??id));
}
}
const effortOptions=[];
if(reasoning===null){
effortOptions.push(sessionModelOptionOf(ctx,"",providerValue===""?"先选择模型":"模型无思考深度",true));
}else{
effortOptions.push(sessionModelOptionOf(ctx,"",t("sidebar.sessionModel.effortDefault")));
for(const effort of efforts){
const id=text(object(effort).id,null);
if(id===null||id==="")continue;
effortOptions.push(sessionModelOptionOf(ctx,id,text(object(effort).name,null)??id));
}
if(effortValue!==""
&&efforts.every((effort)=>text(object(effort).id,null)!==effortValue)){
effortOptions.push(sessionModelOptionOf(ctx,effortValue,effortValue+"（不可用）",true));
}
}
return{
current,roleLabel,providerValue,modelValue,effortValue,
providerOptions,modelOptions,effortOptions,reasoning,providerGroup,
};
};
const renderSessionModelRow=(ctx,role,options)=>{
const{react,t,updateSessionModelDraft,clearSessionModelRole}=ctx;
const writable=options.writable;
const orchestrator=options.orchestrator===true;
const row=sessionModelRowOf(ctx,role,options.groups,options.fallback,options.label);
const{
current,roleLabel,providerValue,modelValue,effortValue,
providerOptions,modelOptions,effortOptions,reasoning,providerGroup,
}=row;
const pillChildren=[
react.createElement("span",{
key:"label",
className:"deg_expert_group_session_model_pill_label",
title:roleLabel,
},roleLabel),
];
if(current!==null){
pillChildren.push(react.createElement("button",{
key:"clear",
type:"button",
className:"deg_expert_group_session_model_clear",
"data-deg-session-model-clear":role,
"aria-label":t("sidebar.sessionModel.clearRole",{role:roleLabel}),
title:t("sidebar.sessionModel.clearRole",{role:roleLabel}),
disabled:writable!==true,
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
void clearSessionModelRole(role);
},
},"×"));
}
return(react.createElement("div",{
key:role,
className:"deg_expert_group_session_model_row",
role:"row",
"data-deg-session-model-role":role,
"data-deg-session-model-state":current!==null?"override":"follow",
},[
react.createElement("div",{
key:"role",
role:"cell",
className:"deg_expert_group_session_model_cell",
},react.createElement("span",{className:"deg_expert_group_session_model_pill"},pillChildren)),
react.createElement("div",{
key:"provider",
role:"cell",
className:"deg_expert_group_session_model_cell",
},react.createElement("select",{
className:"deg_expert_group_session_model_select",
"aria-label":roleLabel+" "+t("sidebar.sessionModel.provider"),
"data-deg-session-model-field":"provider",
value:providerValue,
disabled:writable!==true,
onChange:(event)=>updateSessionModelDraft(role,"provider",event?.target?.value??""),
},providerOptions)),
react.createElement("div",{
key:"model",
role:"cell",
className:"deg_expert_group_session_model_cell",
},react.createElement("select",{
className:"deg_expert_group_session_model_select",
"aria-label":roleLabel+" "+t("sidebar.sessionModel.columnModel"),
"data-deg-session-model-field":"model",
value:modelValue,
disabled:writable!==true||providerValue===""||providerGroup===undefined,
onChange:(event)=>updateSessionModelDraft(role,"model",event?.target?.value??""),
},modelOptions)),
react.createElement("div",{
key:"effort",
role:"cell",
className:"deg_expert_group_session_model_cell",
},react.createElement("select",{
className:"deg_expert_group_session_model_select",
"aria-label":roleLabel+" "+t("sidebar.sessionModel.effort"),
"data-deg-session-model-field":"effort",
value:effortValue,
disabled:writable!==true||reasoning===null||modelValue==="",
onChange:(event)=>updateSessionModelDraft(role,"reasoningEffort",event?.target?.value??""),
},effortOptions)),
].concat(orchestrator&&options.status?[react.createElement("div",{
className:"deg_expert_group_session_model_orchestrator",
"data-deg-session-model-orchestrator":options.status.state,
},options.status.text)]:[])));
};
const renderSessionModelFooter=(ctx,options)=>{
const{react,t,sessionModelState,commitSessionModelChanges,restoreSessionModelDefaults}=ctx;
const{canSave,canRestore,invalidDraft,closeDialog}=options;
const footer=react.createElement("footer",{
key:"footer",
className:"deg_expert_group_session_model_footer",
},[
react.createElement("span",{
key:"revision",
className:"deg_expert_group_session_model_revision",
"data-deg-session-model-revision":sessionModelState.revision,
},t("sidebar.sessionModel.revision",{revision:sessionModelState.revision})),
invalidDraft===true
?react.createElement("span",{
key:"invalid",
className:"deg_expert_group_session_model_invalid",
role:"status",
"data-deg-session-model-invalid":"true",
},t("sidebar.sessionModel.invalidDraft"))
:null,
react.createElement("span",{key:"spacer",className:"deg_expert_group_session_model_spacer"}),
react.createElement("button",{
key:"restore",
type:"button",
className:"deg_expert_group_session_model_secondary",
"data-deg-session-model-restore":"true",
"aria-label":t("sidebar.sessionModel.restore"),
disabled:canRestore!==true,
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
void restoreSessionModelDefaults();
},
},t("sidebar.sessionModel.restore")),
react.createElement("button",{
key:"close",
type:"button",
className:"deg_expert_group_session_model_secondary",
"data-deg-session-model-close":"footer",
onClick:closeDialog,
},t("sidebar.sessionModel.close")),
react.createElement("button",{
key:"save",
type:"button",
className:"deg_expert_group_session_model_primary",
"data-deg-session-model-save":"true",
"aria-label":t("sidebar.sessionModel.saveChanges"),
disabled:canSave!==true,
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
void commitSessionModelChanges();
},
},t("sidebar.sessionModel.saveChanges")),
]);
return footer;
};
const renderSessionModelDialog=(ctx)=>{
const{
react,t,meta,sessionModelOpen,sessionModelState,sessionModelCatalog,sessionModelSaving,
sessionModelNotice,sessionModelHasInvalidDraft,sessionModelPendingChanges,
closeSessionModelDialog,retrySessionModelLoad,sessionModelDialogRef,
}=ctx;
if(sessionModelOpen!==true)return null;
const status=sessionModelState.status;
const roles=sessionModelRolesOf(meta);
const groups=Array.isArray(sessionModelCatalog.groups)?sessionModelCatalog.groups:[];
const writable=status==="ready"&&sessionModelState.live===true&&sessionModelSaving!==true;
const readOnlyReasons={
"no-session":t("sidebar.sessionModel.noSession"),
child:t("sidebar.sessionModel.child"),
loading:t("sidebar.sessionModel.loading"),
unsupported:t("sidebar.sessionModel.unsupported"),
error:t("sidebar.sessionModel.unavailable"),
unavailable:t("sidebar.sessionModel.unavailable"),
};
const readOnlyHint=status==="ready"
?(sessionModelState.live===true?null:t("sidebar.sessionModel.offline"))
:(readOnlyReasons[status]??null);
const noticeText=sessionModelNotice===null
?null
:sessionModelNotice.kind==="saved"
?(sessionModelNotice.text??t("sidebar.sessionModel.saved"))
:sessionModelNotice.kind==="cleared"
?t("sidebar.sessionModel.cleared")
:sessionModelNotice.text;
const noticeError=sessionModelNotice?.kind==="error"||sessionModelNotice?.kind==="conflict";
const changes=status==="ready"?sessionModelPendingChanges():[];
const invalidDraft=status==="ready"&&sessionModelHasInvalidDraft();
const canSave=writable===true&&changes.length>0&&invalidDraft!==true;
const canRestore=writable===true&&Object.keys(sessionModelState.overrides).length>0;
const closeDialog=(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
closeSessionModelDialog();
};
const headRow=react.createElement("div",{
key:"__head",
className:"deg_expert_group_session_model_row",
role:"row",
"data-deg-session-model-head":"true",
},[
react.createElement("span",{
key:"role",
role:"columnheader",
className:"deg_expert_group_session_model_head_cell",
},t("sidebar.sessionModel.columnRole")),
react.createElement("span",{
key:"provider",
role:"columnheader",
className:"deg_expert_group_session_model_head_cell",
},t("sidebar.sessionModel.provider")),
react.createElement("span",{
key:"model",
role:"columnheader",
className:"deg_expert_group_session_model_head_cell",
},t("sidebar.sessionModel.columnModel")),
react.createElement("span",{
key:"effort",
role:"columnheader",
className:"deg_expert_group_session_model_head_cell",
},t("sidebar.sessionModel.effort")),
]);
const rows=[];
if(status==="ready"){
const orchestratorView=sessionModelOrchestratorViewOf(ctx);
rows.push(renderSessionModelRow(ctx,"orchestrator",{
writable:writable===true&&orchestratorView.hostReady===true,
groups,
fallback:orchestratorView.selection,
label:"Orchestrator",
status:orchestratorView,
orchestrator:true,
}));
for(const role of roles){
rows.push(renderSessionModelRow(ctx,role,{writable,groups}));
}
}
const bodyChildren=[
react.createElement("p",{key:"hint",className:"deg_expert_group_session_model_hint"},
t("sidebar.sessionModel.hint")),
];
if(readOnlyHint!==null){
bodyChildren.push(react.createElement("div",{
key:"readonly",
className:"deg_expert_group_session_model_hint",
"data-deg-session-model-readonly":status,
},readOnlyHint));
}
if(status==="error"){
bodyChildren.push(react.createElement("button",{
key:"retry",
type:"button",
className:"deg_expert_group_export_button",
"data-deg-session-model-retry":"true",
"aria-label":t("sidebar.sessionModel.retry"),
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
retrySessionModelLoad();
},
},t("sidebar.sessionModel.retry")));
}
if(noticeText!==null){
bodyChildren.push(react.createElement("div",{
key:"notice",
className:noticeError
?"deg_expert_group_session_model_notice deg_expert_group_session_model_notice_error"
:"deg_expert_group_session_model_notice",
role:"status",
"data-deg-session-model-notice":sessionModelNotice?.kind??"none",
},noticeText));
}
if(roles.length===0){
bodyChildren.push(react.createElement("div",{
key:"empty",
className:"deg_expert_group_session_model_hint",
},t("sidebar.sessionModel.emptyRoles")));
}
if(status==="ready"){
bodyChildren.push(react.createElement("div",{
key:"table",
className:"deg_expert_group_session_model_scroll",
},react.createElement("div",{
role:"table",
"aria-label":t("sidebar.sessionModel.tableLabel"),
className:"deg_expert_group_session_model_table",
},[headRow,...rows])));
}
const footer=renderSessionModelFooter(ctx,{canSave,canRestore,invalidDraft,closeDialog});
const peakValleyMarker=typeof ctx.getPeakValleyMarker==="function"?ctx.getPeakValleyMarker():null;
const peakValleyLabel=typeof ctx.peakValleyLabelOf==="function"?ctx.peakValleyLabelOf(peakValleyMarker):null;
const peakValleyBadge=peakValleyLabel===null?null:react.createElement("span",{
key:"peakValley",
className:"deg_expert_group_header_peak_valley",
"data-peak-valley":peakValleyMarker?.period==="peak"?"peak":"valley",
},peakValleyLabel);
return react.createElement("dialog",{
id:"deg-session-model-dialog",
className:"deg_expert_group_session_model_dialog",
"aria-labelledby":"deg-session-model-title",
"data-deg-session-model":"dialog",
"data-deg-session-model-state":status,
ref:sessionModelDialogRef,
onCancel:closeDialog,
onClose:()=>{closeSessionModelDialog();},
onClick:(event)=>{
if(sessionModelDialogRef.current!==null
&&event?.target===sessionModelDialogRef.current){
closeSessionModelDialog();
}
},
},
react.createElement("header",{className:"deg_expert_group_session_model_header"},
react.createElement("div",{className:"deg_expert_group_session_model_heading"},[
react.createElement("h2",{
key:"title",
id:"deg-session-model-title",
className:"deg_expert_group_session_model_title",
},t("sidebar.sessionModel.title")),
peakValleyBadge,
]),
react.createElement("button",{
type:"button",
className:"deg_expert_group_export_button",
"data-deg-session-model-close":"true",
"aria-label":t("sidebar.sessionModel.close"),
onClick:closeDialog,
},"×")),
react.createElement("div",{
className:"deg_expert_group_session_model_body",
},bodyChildren),
footer);
};
const renderToolbar=(ctx)=>{
const{react,t,snapshot,root,filterSource,updateFilter,sessionModelOpen,sessionModelEntryRef,toggleSessionModelDialog}=ctx;
if(snapshot===null)return null;
const roles=[];
const addRole=(value)=>{
const role=text(value,null);
if(role!==null&&roles.indexOf(role)===-1)roles.push(role);
};
const collectRoles=(nodes)=>{
for(const node of Array.isArray(nodes)?nodes:[]){
addRole(node.role);
collectRoles(node.children);
for(const shard of Array.isArray(node.shards)?node.shards:[])addRole(shard.role);
}
};
collectRoles(root?.children);
roles.sort();
return react.createElement("div",{className:"deg_expert_group_toolbar",role:"search","aria-label":t("sidebar.search.label")},
react.createElement("input",{
type:"search",
className:"deg_expert_group_search",
"aria-label":t("sidebar.search.aria"),
placeholder:t("sidebar.search.placeholder"),
value:filterSource.query,
onChange:(event)=>{updateFilter({query:event?.target?.value??""});},
}),
react.createElement("select",{
className:"deg_expert_group_filter",
"aria-label":t("sidebar.filter.role"),
value:filterSource.role,
onChange:(event)=>{updateFilter({role:event?.target?.value??""});},
},[
react.createElement("option",{key:"__all_roles",value:""},t("sidebar.filter.allRoles")),
...roles.map((role)=>react.createElement("option",{key:role,value:role},ctx.a.roleLabelFor(role,null)??role)),
]),
react.createElement("select",{
className:"deg_expert_group_filter",
"aria-label":t("sidebar.filter.status"),
value:filterSource.status,
onChange:(event)=>{updateFilter({status:event?.target?.value??""});},
},[
react.createElement("option",{key:"__all_statuses",value:""},t("sidebar.filter.allStatuses")),
...STATUS_FILTER_OPTIONS.map((option)=>react.createElement("option",{key:option.value,value:option.value},option.label)),
]),
react.createElement("button",{
type:"button",
className:"deg_expert_group_export_button",
"aria-label":t("sidebar.sessionModel.open"),
"aria-expanded":sessionModelOpen,
"aria-haspopup":"dialog",
"aria-controls":"deg-session-model-dialog",
ref:sessionModelEntryRef,
title:t("sidebar.sessionModel.openTitle"),
onClick:(event)=>{
event?.preventDefault?.();
event?.stopPropagation?.();
toggleSessionModelDialog();
},
},t("sidebar.sessionModel.open")));
};
function createSidebarViewsC(ctx,viewsA,viewsB){
const deps={...ctx,a:viewsA,b:viewsB};
return Object.freeze({
renderExpert:(node,index,parentId,treeMeta)=>renderExpert(deps,node,index,parentId,treeMeta),
renderIdleGroup:(nodes,trailing,treeMeta)=>renderIdleGroup(deps,nodes,trailing,treeMeta),
renderShard:(task,shard,index,treeMeta)=>renderShard(deps,task,shard,index,treeMeta),
renderFanout:(task,index,treeMeta)=>renderFanout(deps,task,index,treeMeta),
renderToolbar:()=>renderToolbar(deps),
renderSessionModelDialog:()=>renderSessionModelDialog(deps),
});
}
global[SYMBOL]=Object.freeze({createSidebarViewsC});
})(globalThis);
/* source: client-sidebar-auto-controller.js */
(function installSidebarAutoController(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-controller");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS,SIDEBAR_AUTO_KEY_LIMIT,SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS,
SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS,SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS,SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS,
SIDEBAR_TAB_CLOSE_WATCHDOG_MS,SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS,SIDEBAR_TAB_ORIGIN_AUTO,
closeSettleReason,object,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
SUBAGENT_CHAT_KIND,sidebarTabCloseKey,sidebarTabKey,
}=DOM;
const LEDGER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const LEDGER=global[LEDGER_SYMBOL]||{};
const{
SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,deleteSidebarAutoOwnership,
readSidebarAutoOwnershipEntry,sidebarAutoOriginEntry,
recordSidebarAutoDecision,recordSidebarAutoDiag,sidebarAutoKeyDigest,
sidebarAutoOriginTabIdOf,sidebarAutoOriginWrittenAtOf,sidebarOwnershipAcceptsNewAuto,
writeSidebarAutoOwnership,
}=LEDGER;
function createSidebarTabClosePort(scope){
const{
closeSidebarResource,readSidebarOpenTabs,rootSessionId,
sharedSidebarTabCloseInFlight,sidebarRight,sidebarSessionId,
}=scope;
function sidebarTabCloseKeyOf(tabId){
return sidebarTabCloseKey(sidebarSessionId,rootSessionId,tabId);
}
function sidebarTabCloseLeaseOf(tabId){
return sharedSidebarTabCloseInFlight.get(sidebarTabCloseKeyOf(tabId))??null;
}
function sidebarTabCloseInFlight(tabId){
return sidebarTabCloseLeaseOf(tabId)!==null;
}
function acquireSidebarTabClose(tabId){
const key=sidebarTabCloseKeyOf(tabId);
if(sharedSidebarTabCloseInFlight.has(key))return null;
let settleWaiters=null;
const settled=new Promise((resolve)=>{settleWaiters=resolve;});
const token={
key,
result:null,
ok:null,
settled:false,
state:"in-flight",
holdUntil:0,
wait:()=>settled,
release:null,
};
sharedSidebarTabCloseInFlight.set(key,token);
let released=false;
const release=(outcome)=>{
if(released)return;
released=true;
const reason=closeSettleReason(outcome);
token.result=reason;
token.ok=reason==="closed";
token.settled=true;
const resolve=settleWaiters;
settleWaiters=null;
if(resolve!==null)resolve(reason);
if(sharedSidebarTabCloseInFlight.get(key)===token)sharedSidebarTabCloseInFlight.delete(key);
};
token.release=release;
return{
token,
hold(state,holdUntil){
if(released)return;
token.state=state;
token.holdUntil=holdUntil;
},
release,
};
}
function sidebarTabPresenceInInventory(tabId,expectedAddress=null){
const inventory=readSidebarOpenTabs();
if(inventory===null)return"unreadable";
const expected=text(expectedAddress,null);
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sidebarSessionId)continue;
if(text(candidate.kind,null)!==SUBAGENT_CHAT_KIND)continue;
if(text(candidate.tabId,null)!==tabId)continue;
if(expected===null)return"present";
const contentId=text(candidate.contentId,null);
if(contentId===null)return"present";
return contentId===expected?"present":"recycled";
}catch{continue;}
}
return"absent";
}
function requestSidebarTabClose(tabId){
return new Promise((resolve)=>{
let settled=false;
let timer=null;
const finish=(outcome)=>{
if(settled)return;
settled=true;
if(timer!==null){
try{globalThis.clearTimeout?.(timer);}catch{/* 清理失败不影响结果。 */}
}
resolve(outcome);
};
try{
timer=typeof globalThis.setTimeout==="function"
?globalThis.setTimeout(()=>finish("timeout"),SIDEBAR_TAB_CLOSE_WATCHDOG_MS)
:null;
}catch{timer=null;}
let result=null;
try{
result=closeSidebarResource.call(sidebarRight,tabId);
}catch{
finish("rejected");
return;
}
Promise.resolve(result).then(()=>finish("resolved"),()=>finish("rejected"));
});
}
function waitForSidebarCloseLease(leaseToken,timeoutMs){
return new Promise((resolve)=>{
let done=false;
let timer=null;
const finish=(value)=>{
if(done)return;
done=true;
if(timer!==null){
try{globalThis.clearTimeout?.(timer);}catch{/* 同上。 */}
}
resolve(value);
};
try{
timer=typeof globalThis.setTimeout==="function"?globalThis.setTimeout(()=>finish(false),timeoutMs):null;
}catch{timer=null;}
Promise.resolve(leaseToken.wait()).then(()=>finish(true),()=>finish(true));
});
}
return Object.freeze({
sidebarTabCloseKeyOf,sidebarTabCloseLeaseOf,sidebarTabCloseInFlight,acquireSidebarTabClose,sidebarTabPresenceInInventory,requestSidebarTabClose,waitForSidebarCloseLease,
});
}
function createSidebarAutoBookkeeping(scope){
const{
clearAutoCloseBudget,idleSidebarResourceAddresses,rootSessionId,runningSidebarResourceAddresses,
sidebarAutoCloseCooldownsRef,sidebarAutoCloseVerificationsRef,sidebarAutoOriginRef,sidebarAutoReservationRef,
sidebarAutoSuppressedRef,sidebarIdleChildren,sidebarResourceTabStateOf,sidebarSessionId,
sidebarTabOpeningRef,sidebarTabPendingRef,sidebarTabRecordsRef,trimAutoKeyMap,
}=scope;
function sidebarAutoCloseKeyIsActive(key){
if(sidebarTabPendingRef.current.has(key))return true;
if(sidebarTabOpeningRef.current.has(key))return true;
if(sidebarAutoReservationRef.current.has(key))return true;
if(sidebarAutoCloseVerificationsRef.current.has(key))return true;
if(sidebarAutoCloseCooldownsRef.current.has(key))return true;
const record=sidebarTabRecordsRef.current.get(key);
return record!==undefined
&&record.sessionId===sidebarSessionId
&&record.rootSessionId===rootSessionId;
}
function autoSidebarOwnershipHasCapacity(key,address){
const origin=sidebarAutoOriginRef.current;
let scopedCount=0;
for(const[entryKey,entry]of origin){
if(entryKey===key)continue;
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)continue;
scopedCount+=1;
}
if(scopedCount>=SIDEBAR_AUTO_KEY_LIMIT)return false;
return sidebarOwnershipAcceptsNewAuto(sidebarSessionId,rootSessionId,address);
}
function cleanupAutoSidebarKeys(known,actingKey){
for(const map of[sidebarAutoOriginRef.current,sidebarAutoSuppressedRef.current]){
for(const[key,entry]of map){
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)continue;
if(key===actingKey)continue;
if(known.has(entry.address))continue;
if(sidebarAutoCloseKeyIsActive(key))continue;
map.delete(key);
clearAutoCloseBudget(key);
}
}
for(const[key,entry]of sidebarAutoReservationRef.current){
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)continue;
if(key===actingKey)continue;
if(known.has(entry.address))continue;
if(sidebarTabPendingRef.current.has(key))continue;
sidebarAutoReservationRef.current.delete(key);
}
}
function sweepAutoOpenPlaceholders(running){
const originMap=sidebarAutoOriginRef.current;
if(originMap.size===0)return;
const now=Date.now();
for(const[key,entry]of[...originMap]){
if(sidebarAutoOriginTabIdOf(entry)!==null)continue;
const age=now-sidebarAutoOriginWrittenAtOf(entry);
const scoped=entry.sessionId===sidebarSessionId&&entry.rootSessionId===rootSessionId;
if(scoped!==true){
if(age<SIDEBAR_AUTO_OPEN_PLACEHOLDER_FOREIGN_TTL_MS)continue;
originMap.delete(key);
recordSidebarAutoDiag({kind:"ownership",event:"delete",reason:"placeholder-foreign-expired",key:sidebarAutoKeyDigest(key)});
continue;
}
if(age<SIDEBAR_AUTO_OPEN_PLACEHOLDER_TTL_MS)continue;
if(sidebarTabPendingRef.current.has(key))continue;
if(sidebarTabOpeningRef.current.has(key))continue;
const state=sidebarResourceTabStateOf(entry.address);
if(state.readable!==true){
recordSidebarAutoDiag({kind:"ownership",event:"keep",reason:"placeholder-unreadable",key:sidebarAutoKeyDigest(key)});
continue;
}
originMap.delete(key);
recordSidebarAutoDiag({
kind:"ownership",
event:"delete",
reason:state.tabId===null
?(running?.has(entry.address)
?"placeholder-retry"
:"placeholder-released")
:"placeholder-superseded",
key:sidebarAutoKeyDigest(key),
});
}
}
function clearManualSuppressionOfIdleResources(){
const suppressed=sidebarAutoSuppressedRef.current;
for(const[idle,addresses]of[[0,runningSidebarResourceAddresses()],[1,idleSidebarResourceAddresses(sidebarIdleChildren())]]){
for(const address of addresses){
const key=sidebarTabKey(sidebarSessionId,rootSessionId,address);
const persisted=readSidebarAutoOwnershipEntry(sidebarSessionId,rootSessionId,address,{quiet:true});
const manual=persisted?.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL;
if(idle===1?(!manual&&!suppressed.has(key)):!manual)continue;
const state=sidebarResourceTabStateOf(address);
if(!state.readable)continue;
const idleMark=suppressed.get(key)?.idle;
if(idle===1){
if(state.tabId!==null){
if(manual)suppressed.set(key,{sessionId:sidebarSessionId,rootSessionId,address,idle:state.tabId});
continue;
}
suppressed.delete(key);
if(manual)deleteSidebarAutoOwnership(sidebarSessionId,rootSessionId,address,"new-run",{manual:true});
continue;
}
if(state.tabId===null){
if(idleMark!==undefined)delete suppressed.get(key).idle;
continue;
}
const wasIdle=idleMark===state.tabId;
const reason=persisted.reason;
if(!(reason==="manual-open"||(wasIdle&&(reason==="manual-takeover"||reason==="manual-close"))))continue;
if(writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO,"auto-rearm",state.tabId)!==true)continue;
suppressed.delete(key);
sidebarAutoOriginRef.current.set(key,sidebarAutoOriginEntry(sidebarSessionId,rootSessionId,address,state.tabId));
const record=sidebarTabRecordsRef.current.get(key);
if(record?.tabId===state.tabId)record.origin=SIDEBAR_TAB_ORIGIN_AUTO;
}
}
trimAutoKeyMap(suppressed);
}
return Object.freeze({
sidebarAutoCloseKeyIsActive,autoSidebarOwnershipHasCapacity,cleanupAutoSidebarKeys,sweepAutoOpenPlaceholders,clearManualSuppressionOfIdleResources,
});
}
function createSidebarCloseVerification(scope,tabClosePort){
const{
bump,cancelPendingSidebarSplitOfClose,clearAutoCloseAttempt,
closeSidebarResource,rootSessionId,settleAutoCloseAttempt,
sharedSidebarTabCloseInFlight,sidebarAutoCloseCooldownsRef,sidebarAutoCloseVerificationsRef,
sidebarAutoFailedKeysRef,sidebarAutoOriginRef,sidebarAutoSuppressedRef,
sidebarSessionId,sidebarSurfaceStillCurrent,sidebarTabRecordsRef,
trimAutoKeyMap,
}=scope;
const{acquireSidebarTabClose,requestSidebarTabClose,sidebarTabCloseLeaseOf,sidebarTabPresenceInInventory}=tabClosePort;
const{waitForSidebarCloseLease}=tabClosePort;
function beginSidebarCloseVerification(lease,tabId,verify){
const entry={
sessionId:sidebarSessionId,
rootSessionId,
tabId,
address:verify?.address??null,
attemptToken:verify?.attemptToken??null,
manual:verify?.manual===true,
splitIntentToken:verify?.splitIntentToken??null,
misses:0,
deadline:Date.now()+SIDEBAR_TAB_CLOSE_VERIFY_TIMEOUT_MS,
lease,
};
sidebarAutoCloseVerificationsRef.current.set(verify.key,entry);
trimAutoKeyMap(sidebarAutoCloseVerificationsRef.current,true);
lease.hold("verifying",entry.deadline);
return entry;
}
function finishVerifiedSidebarClose(key,entry,reason){
const records=sidebarTabRecordsRef.current;
const record=records.get(key);
const scopedRecord=record!==undefined
&&record.sessionId===sidebarSessionId
&&record.rootSessionId===rootSessionId
?record
:undefined;
const sameTab=scopedRecord!==undefined&&scopedRecord.tabId===entry.tabId;
cancelPendingSidebarSplitOfClose(key,entry.splitIntentToken);
if(sameTab){
records.delete(key);
if(entry.attemptToken===null||entry.attemptToken===undefined)clearAutoCloseAttempt(key);
else settleAutoCloseAttempt(key,{kind:"close",attemptToken:entry.attemptToken});
sidebarAutoCloseCooldownsRef.current.delete(key);
sidebarAutoOriginRef.current.delete(key);
if(entry.manual&&entry.address!=null){
sidebarAutoSuppressedRef.current.set(key,{sessionId:sidebarSessionId,rootSessionId,address:entry.address});
trimAutoKeyMap(sidebarAutoSuppressedRef.current);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
}else if(entry.address!=null){
deleteSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,"verified-closed");
}
}else if(entry.attemptToken!=null){
settleAutoCloseAttempt(key,{kind:"close",attemptToken:entry.attemptToken});
}
sidebarAutoCloseVerificationsRef.current.delete(key);
entry.lease?.release?.(reason==="recycled"?"recycled":"closed");
bump((value)=>value+1);
}
function verifyPendingSidebarCloses(){
const now=Date.now();
for(const[,token]of sharedSidebarTabCloseInFlight){
if(token.state!=="quarantined")continue;
if(token.holdUntil>now)continue;
token.release?.("timeout");
}
const verifications=sidebarAutoCloseVerificationsRef.current;
for(const[key,entry]of[...verifications]){
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)continue;
const presence=sidebarTabPresenceInInventory(entry.tabId,entry.address);
if(presence==="present")entry.misses=0;
else if(presence!=="unreadable")entry.misses+=1;
if(presence!=="present"&&presence!=="unreadable"
&&entry.misses>=SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS){
finishVerifiedSidebarClose(key,entry,presence==="recycled"?"recycled":"closed");
continue;
}
if(now>=entry.deadline){
verifications.delete(key);
entry.lease?.release?.("timeout");
sidebarAutoFailedKeysRef.current.add(key);
}
}
}
async function closeSidebarTabWithLease(tabId,options){
if(closeSidebarResource===null)return{status:"unavailable",closed:false};
const waitForCompeting=options?.waitForCompeting===true;
const verify=options?.verify??null;
let lease=acquireSidebarTabClose(tabId);
if(lease===null){
if(waitForCompeting!==true)return{status:"contended",closed:false};
const competing=sidebarTabCloseLeaseOf(tabId);
if(competing===null)return{status:"contended",closed:false};
const settledInTime=await waitForSidebarCloseLease(competing,SIDEBAR_TAB_CLOSE_WATCHDOG_MS);
if(settledInTime!==true)return{status:"contended-timeout",closed:false};
if(sidebarSurfaceStillCurrent()!==true)return{status:"stale",closed:false};
const settledReason=competing.result;
if(settledReason==="recycled"
&&(verify?.address===null||verify?.address===undefined)){
return{status:"recycled-unverifiable",closed:false};
}
const presence=sidebarTabPresenceInInventory(tabId,verify?.address??null);
if(presence==="unreadable")return{status:"unreadable",closed:false};
if(presence==="recycled")return{status:"verified-recycled",closed:false};
if(presence!=="present")return{status:"verified-closed",closed:true};
lease=acquireSidebarTabClose(tabId);
if(lease===null)return{status:"contended",closed:false};
}
const preflight=sidebarTabPresenceInInventory(tabId,verify?.address??null);
const manualWithoutEvidence=preflight==="unreadable"&&verify?.manual===true;
if(preflight==="unreadable"&&manualWithoutEvidence!==true){
lease.release("failed");
return{status:"unreadable",closed:false};
}
if(preflight==="absent"){
lease.release("closed");
return{status:"verified-closed",closed:true};
}
if(preflight==="recycled"){
lease.release("recycled");
return{status:"verified-recycled",closed:false};
}
const outcome=await requestSidebarTabClose(tabId);
if(outcome==="rejected"){
lease.release("failed");
return{status:"failed",closed:false};
}
if(outcome==="timeout"){
lease.hold("quarantined",Date.now()+SIDEBAR_TAB_CLOSE_LATE_QUARANTINE_MS);
return{status:"timeout",closed:false};
}
if(manualWithoutEvidence){
lease.release("closed");
return{status:"closed",closed:true};
}
if(verify===null||verify.key===null||verify.key===undefined){
lease.release("failed");
}else{
beginSidebarCloseVerification(lease,tabId,verify);
}
return{status:"request-resolved-unverified",closed:false};
}
return Object.freeze({
beginSidebarCloseVerification,finishVerifiedSidebarClose,verifyPendingSidebarCloses,closeSidebarTabWithLease,
});
}
function createSidebarAutoCandidates(scope,tabClosePort,bookkeeping){
const{
autoCloseCooldownActive,bump,clearAutoCloseAttempt,
clearAutoCloseBudget,closeSidebarResource,enterAutoCloseCooldown,
openSidebarResource,primitives,readActiveSidebarResource,
releaseExpiredAutoCloseCooldown,rootSessionId,sampleAutoTabMisses,
sidebarActiveResourceMatches,sidebarAutoCloseAttemptOwnersRef,sidebarAutoCloseAttemptsRef,
sidebarAutoCloseCooldownsRef,sidebarAutoCloseVerificationsRef,sidebarAutoEpochRef,
sidebarAutoFailedKeysRef,sidebarAutoOriginRef,sidebarAutoReservationRef,
sidebarAutoSuppressedRef,sidebarManualIntentOf,sidebarOpenTabsAvailable,
sidebarResourceTabStateOf,sidebarSessionId,sidebarTabOpeningRef,
sidebarTabPendingRef,sidebarTabRecordsRef,trimAutoKeyMap,
}=scope;
const{sidebarTabCloseInFlight,sidebarTabPresenceInInventory}=tabClosePort;
const{autoSidebarOwnershipHasCapacity}=bookkeeping;
function sidebarAutoOpenCapable(){
return openSidebarResource!==null
&&closeSidebarResource!==null
&&(readActiveSidebarResource!==null||sidebarOpenTabsAvailable)
&&typeof primitives?.IconChevronLeftOutlineRegular==="function";
}
function autoCloseCandidate(running){
const origin=sidebarAutoOriginRef.current;
const records=sidebarTabRecordsRef.current;
const openings=sidebarTabOpeningRef.current;
const attempts=sidebarAutoCloseAttemptsRef.current;
for(const[key,entry]of origin){
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId)continue;
const runningNow=running.has(entry.address);
let scopedRecord=records.get(key);
if(scopedRecord===undefined
||scopedRecord.sessionId!==sidebarSessionId||scopedRecord.rootSessionId!==rootSessionId)scopedRecord=undefined;
if(scopedRecord===undefined){
if(openings.has(key)||sidebarTabPendingRef.current.has(key)){
if(!runningNow)continue;
}else{
const persisted=readSidebarAutoOwnershipEntry(sidebarSessionId,rootSessionId,entry.address,{quiet:true,authoritative:true});
const boundTabId=sidebarAutoOriginTabIdOf(entry);
const presence=persisted===undefined?"unreadable":sidebarTabPresenceInInventory(boundTabId,entry.address);
if(persisted?.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL
||(presence!=="unreadable"&&presence!=="present"&&!runningNow)){
origin.delete(key);
clearAutoCloseBudget(key);
continue;
}
if(presence==="present"&&sidebarResourceTabStateOf(entry.address).tabId===boundTabId){
records.set(key,scopedRecord={sessionId:sidebarSessionId,rootSessionId,tabId:boundTabId,title:null,misses:0,origin:SIDEBAR_TAB_ORIGIN_AUTO});
}else if(!runningNow){
continue;
}
}
}
if(runningNow){
if(attempts.has(key)
||sidebarAutoCloseCooldownsRef.current.has(key)
||sidebarAutoCloseVerificationsRef.current.has(key)){
deleteSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,"resource-running");
}
clearAutoCloseBudget(key);
continue;
}
if(scopedRecord.origin!==SIDEBAR_TAB_ORIGIN_AUTO){
origin.delete(key);
clearAutoCloseAttempt(key);
continue;
}
const boundAutoTabId=sidebarAutoOriginTabIdOf(entry);
if(boundAutoTabId!==null&&boundAutoTabId!==scopedRecord.tabId){
origin.delete(key);
clearAutoCloseAttempt(key);
continue;
}
if(sidebarTabCloseInFlight(scopedRecord.tabId))continue;
const recordPresence=sidebarTabPresenceInInventory(scopedRecord.tabId,entry.address);
const recordMissing=recordPresence==="absent"||recordPresence==="recycled";
if(recordMissing){
if(sampleAutoTabMisses(key,scopedRecord.tabId,true)<SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS)continue;
}else if(recordPresence==="present"){
sampleAutoTabMisses(key,scopedRecord.tabId,false);
}
if(recordPresence==="absent"){
records.delete(key);
origin.delete(key);
clearAutoCloseAttempt(key);
deleteSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,"inventory-absent");
bump((value)=>value+1);
continue;
}
if(recordPresence==="recycled"){
records.delete(key);
origin.delete(key);
clearAutoCloseBudget(key);
deleteSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,"tab-recycled");
bump((value)=>value+1);
continue;
}
if(closeSidebarResource===null){
origin.delete(key);
clearAutoCloseAttempt(key);
continue;
}
if(sidebarTabPendingRef.current.has(key))continue;
if(sidebarAutoFailedKeysRef.current.has(key))continue;
if(sidebarManualIntentOf(key)!==undefined)continue;
if(sidebarAutoCloseVerificationsRef.current.has(key))continue;
if(autoCloseCooldownActive(key))continue;
releaseExpiredAutoCloseCooldown(key);
const used=attempts.get(key)??0;
if(used>=SIDEBAR_AUTO_CLOSE_MAX_ATTEMPTS){
enterAutoCloseCooldown(key);
continue;
}
const attemptToken={key,attemptsBefore:used};
attempts.set(key,used+1);
sidebarAutoCloseAttemptOwnersRef.current.set(key,attemptToken);
trimAutoKeyMap(attempts,true);
trimAutoKeyMap(sidebarAutoCloseAttemptOwnersRef.current,true);
return{key,address:entry.address,kind:"close",attemptsBefore:used,attemptToken};
}
return null;
}
function autoOpenCandidate(running){
if(sidebarAutoOpenCapable()!==true)return null;
const origin=sidebarAutoOriginRef.current;
const suppressed=sidebarAutoSuppressedRef.current;
const reservations=sidebarAutoReservationRef.current;
const records=sidebarTabRecordsRef.current;
const openings=sidebarTabOpeningRef.current;
for(const address of running){
const key=sidebarTabKey(sidebarSessionId,rootSessionId,address);
if(sidebarAutoFailedKeysRef.current.has(key))continue;
if(suppressed.has(key))continue;
const persistedForOpen=readSidebarAutoOwnershipEntry(sidebarSessionId,rootSessionId,address,{quiet:true});
if(persistedForOpen!==null&&persistedForOpen.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL){
recordSidebarAutoDecision("open",{key,kind:"open"},"skip","persisted-manual");
continue;
}
if(origin.has(key))continue;
if(autoSidebarOwnershipHasCapacity(key,address)!==true){
recordSidebarAutoDecision("open",{key,kind:"open"},"skip","owner-capacity");
continue;
}
if(reservations.has(key))continue;
if(sidebarTabPendingRef.current.has(key))continue;
if(sidebarManualIntentOf(key)!==undefined)continue;
const record=records.get(key);
if(record!==undefined&&record.sessionId===sidebarSessionId&&record.rootSessionId===rootSessionId)continue;
const opening=openings.get(key);
if(opening!==undefined&&opening.sessionId===sidebarSessionId&&opening.rootSessionId===rootSessionId)continue;
const state=sidebarResourceTabStateOf(address);
if(state.readable!==true)continue;
if(state.tabId!==null)continue;
if(sidebarActiveResourceMatches(address))continue;
const epoch=sidebarAutoEpochRef.current;
reservations.set(key,{sessionId:sidebarSessionId,rootSessionId,address,epoch});
trimAutoKeyMap(reservations);
return{key,address,kind:"open",epoch};
}
return null;
}
return Object.freeze({
sidebarAutoOpenCapable,autoCloseCandidate,autoOpenCandidate,
});
}
function createSidebarAutoController(scope){
const tabClosePort=createSidebarTabClosePort(scope);
const bookkeeping=createSidebarAutoBookkeeping(scope);
const verification=createSidebarCloseVerification(scope,tabClosePort);
const candidates=createSidebarAutoCandidates(scope,tabClosePort,bookkeeping);
return Object.freeze({
...candidates,
...verification,
...bookkeeping,
...tabClosePort,
});
}
global[SYMBOL]=Object.freeze({createSidebarAutoController});
})(globalThis);
/* source: client-sidebar-actions.js */
(function installSidebarActions(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-actions");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_TAB_ORIGIN_AUTO,SIDEBAR_TAB_ORIGIN_MANUAL,text,
}=PURE;
const LEDGER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const LEDGER=global[LEDGER_SYMBOL]||{};
const{
SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,recordSidebarAutoDecision,sidebarBoundedText,
writeSidebarAutoOwnership,
}=LEDGER;
function createSidebarActions(scope){
const{
autoCloseCandidate,autoOpenCandidate,autoOpenEnabled,
bump,cancelPendingSidebarSplit,cleanupAutoSidebarKeys,
clearAutoCloseAttempt,clearManualSuppressionOfIdleResources,currentRootRef,
currentSidebarSessionRef,handleSidebarAction,
knownSidebarResourceAddresses,mountedRef,rootSessionId,
runningSidebarResourceAddresses,setAutoOpenDraft,sidebarAutoBusyRef,
sidebarAutoCascadeRef,sidebarAutoCloseAttemptOwnersRef,sidebarAutoCloseAttemptsRef,
sidebarAutoEpochRef,sidebarAutoFailedKeysRef,sidebarAutoOriginRef,
sidebarAutoReservationRef,sidebarAutoSignatureRef,sidebarAutoSuppressedRef,
sidebarManualIntentOf,sidebarManualIntentRef,
sidebarSessionId,sidebarSplitIntentRef,sidebarSurfaceStillCurrent,
sidebarTabOpeningRef,sidebarTabPendingRef,sidebarTabRecordsRef,
sidebarTabSyncRef,snapshot,sweepAutoOpenPlaceholders,
syncSidebarTabRecords,trimAutoKeyMap,verifyPendingSidebarCloses,
}=scope;
function launchAutoSidebarAction(candidate){
sidebarAutoBusyRef.current=true;
recordSidebarAutoDecision("launch",candidate,"candidate");
void Promise.resolve()
.then(()=>handleSidebarAction(candidate.key,candidate.address,SIDEBAR_TAB_ORIGIN_AUTO,candidate))
.then(
()=>{recordSidebarAutoDecision("settle",candidate,"ok");},
(error)=>{
recordSidebarAutoDecision("settle",candidate,"failed",sidebarBoundedText(error===null||error===undefined?undefined:error.message));
},
)
.then(()=>{
sidebarAutoBusyRef.current=false;
if(sidebarSurfaceStillCurrent()!==true)return;
sidebarAutoCascadeRef.current=true;
try{
sidebarTabSyncRef.current?.();
}finally{
sidebarAutoCascadeRef.current=false;
}
});
}
function syncAutoSidebarTabs(){
const source=snapshot;
if(source===null||source===undefined)return;
if(text(source.rootSessionId,null)!==rootSessionId)return;
const known=knownSidebarResourceAddresses();
const running=runningSidebarResourceAddresses();
const enabled=autoOpenEnabled();
sweepAutoOpenPlaceholders(running);
let candidate=null;
if(enabled===true&&sidebarAutoBusyRef.current!==true){
candidate=autoCloseCandidate(running)??autoOpenCandidate(running);
}
cleanupAutoSidebarKeys(known,candidate===null?null:candidate.key);
if(candidate===null)return;
launchAutoSidebarAction(candidate);
}
function autoActionStillValid(context){
if(context===null||context===undefined)return false;
if(autoOpenEnabled()!==true)return false;
if(sidebarAutoEpochRef.current!==context.epoch)return false;
return mountedRef.current===true
&&currentRootRef.current===rootSessionId
&&currentSidebarSessionRef.current===sidebarSessionId;
}
function abandonAutoSidebarAction(key,context){
if(sidebarSplitIntentRef.current?.key===key)cancelPendingSidebarSplit("auto-abandoned");
sidebarTabOpeningRef.current.delete(key);
sidebarAutoReservationRef.current.delete(key);
releaseAutoCloseAttempt(key,context);
}
function releaseAutoCloseAttempt(key,context){
if(context===null||context===undefined||context.kind!=="close")return;
const owners=sidebarAutoCloseAttemptOwnersRef.current;
const token=context.attemptToken;
if(token===null||token===undefined||owners.get(key)!==token)return;
const attempts=sidebarAutoCloseAttemptsRef.current;
if(attempts.has(key)!==true){
owners.delete(key);
return;
}
if(context.attemptsBefore===0)attempts.delete(key);
else{
attempts.set(key,context.attemptsBefore);
trimAutoKeyMap(attempts);
}
owners.delete(key);
}
function autoTakeoverStateOf(key){
const intent=sidebarManualIntentOf(key);
if(intent===undefined)return null;
return intent.intent==="close"?"close":"open";
}
function recordSidebarManualIntent(key,resourceAddress){
const record=sidebarTabRecordsRef.current.get(key);
const scoped=record!==undefined
&&record.sessionId===sidebarSessionId&&record.rootSessionId===rootSessionId;
sidebarManualIntentRef.current.set(key,{
sessionId:sidebarSessionId,
rootSessionId,
address:resourceAddress,
intent:scoped?"close":"open",
});
}
function applyPendingManualIntent(key){
const entry=sidebarManualIntentOf(key);
if(entry===undefined)return;
if(sidebarTabPendingRef.current.has(key)===true)return;
const opening=sidebarTabOpeningRef.current.get(key);
const openingScoped=opening!==undefined
&&opening.sessionId===sidebarSessionId&&opening.rootSessionId===rootSessionId;
const record=sidebarTabRecordsRef.current.get(key);
const recordScoped=record!==undefined
&&record.sessionId===sidebarSessionId&&record.rootSessionId===rootSessionId;
if(entry.intent==="open"){
if(openingScoped){
opening.origin=SIDEBAR_TAB_ORIGIN_MANUAL;
sidebarManualIntentRef.current.delete(key);
return;
}
if(recordScoped){
record.origin=SIDEBAR_TAB_ORIGIN_MANUAL;
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-open");
sidebarAutoSuppressedRef.current.delete(key);
sidebarAutoOriginRef.current.delete(key);
clearAutoCloseAttempt(key);
sidebarManualIntentRef.current.delete(key);
return;
}
sidebarManualIntentRef.current.delete(key);
void handleSidebarAction(key,entry.address,SIDEBAR_TAB_ORIGIN_MANUAL);
return;
}
if(recordScoped){
sidebarManualIntentRef.current.delete(key);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
void handleSidebarAction(key,entry.address,SIDEBAR_TAB_ORIGIN_MANUAL);
return;
}
if(openingScoped){
sidebarAutoSuppressedRef.current.set(key,{sessionId:sidebarSessionId,rootSessionId,address:entry.address});
trimAutoKeyMap(sidebarAutoSuppressedRef.current);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
return;
}
sidebarManualIntentRef.current.delete(key);
sidebarAutoSuppressedRef.current.set(key,{sessionId:sidebarSessionId,rootSessionId,address:entry.address});
trimAutoKeyMap(sidebarAutoSuppressedRef.current);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,entry.address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
sidebarAutoOriginRef.current.delete(key);
clearAutoCloseAttempt(key);
}
function syncSidebarTabs(){
if(sidebarAutoCascadeRef.current!==true)sidebarAutoFailedKeysRef.current.clear();
clearManualSuppressionOfIdleResources();
syncSidebarTabRecords();
verifyPendingSidebarCloses();
const autoNow=autoOpenEnabled();
if(sidebarAutoSignatureRef.current!==autoNow){
sidebarAutoSignatureRef.current=autoNow;
sidebarAutoEpochRef.current+=1;
setAutoOpenDraft(null);
bump((value)=>value+1);
}
syncAutoSidebarTabs();
}
return Object.freeze({
abandonAutoSidebarAction,
applyPendingManualIntent,
autoActionStillValid,
autoTakeoverStateOf,
launchAutoSidebarAction,
recordSidebarManualIntent,
releaseAutoCloseAttempt,
syncAutoSidebarTabs,
syncSidebarTabs,
});
}
global[SYMBOL]=Object.freeze({createSidebarActions});
})(globalThis);
/* source: client-sidebar-overlay.js */
(function installClientSidebarOverlay(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-overlay");
const RIGHTBAR_CONTINUITY_OVERLAY_ID="dsh-expert-group-rightbar-continuity-overlay";
const RIGHTBAR_CONTINUITY_FALLBACK_MS=500;
function createNativeRightbarContinuityOverlay(){
let host=null;
let observer=null;
let timer=null;
let originalPanel=null;
const removeHost=(element)=>{
if(element===null||element===undefined)return;
try{
if(typeof element.remove==="function")element.remove();
else element.parentNode?.removeChild?.(element);
}catch{/* 移除失败也不能留下引用 */}
};
const release=()=>{
if(timer!==null){
try{globalThis.clearTimeout?.(timer);}catch{/* 可选 API */}
timer=null;
}
if(observer!==null){
try{observer.disconnect?.();}catch{/* 可选 API */}
observer=null;
}
const current=host;
host=null;
originalPanel=null;
removeHost(current);
return true;
};
const hasOpenedPanel=()=>{
const doc=globalThis.document;
if(!doc||typeof doc.querySelectorAll!=="function")return false;
let panels=[];
try{panels=Array.from(doc.querySelectorAll("[data-sidebar-right-panel]")??[]);}catch{return false;}
for(const candidate of panels){
if(candidate===null||candidate===undefined||candidate===originalPanel)continue;
if(isOwnOverlayNode(candidate)===true)continue;// 遮罩内部的克隆不算新 panel
try{
if(typeof candidate.hasAttribute!=="function"||candidate.hasAttribute("data-sidebar-right-open")!==true)continue;
if(typeof candidate.getAttribute==="function"&&candidate.getAttribute("aria-hidden")==="true")continue;
return true;
}catch{/* 单个候选读取失败继续看其它 */}
}
return false;
};
const isOwnOverlayNode=(node)=>{
if(host===null||node===null||node===undefined)return false;
try{
let current=node;
for(let depth=0;depth<8&&current!==null&&current!==undefined;depth+=1){
if(current===host)return true;
current=current.parentNode??null;
}
}catch{return false;}
return false;
};
const scrubClone=(node,depth=0)=>{
if(node===null||node===undefined||depth>12)return;
try{node.removeAttribute?.("id");}catch{/* 单个节点失败继续 */}
try{node.removeAttribute?.("data-sidebar-right-panel");}catch{/* 同上 */}
try{
const tag=typeof node.tagName==="string"?node.tagName.toUpperCase():"";
if(tag==="INPUT"||tag==="TEXTAREA"||tag==="SELECT"){
node.value="";
node.textContent="";
}
}catch{/* 同上 */}
let children=[];
try{children=Array.from(node.childNodes??node.children??[]);}catch{children=[];}
for(const child of children)scrubClone(child,depth+1);
};
const observeBody=()=>{
const doc=globalThis.document;
const Observer=globalThis.MutationObserver??doc?.defaultView?.MutationObserver;
const body=doc?.body??null;
if(typeof Observer!=="function"||body===null||typeof body!=="object")return;
try{
observer=new Observer(()=>{if(hasOpenedPanel()===true)release();});
observer.observe(body,{
childList:true,
subtree:true,
attributes:true,
attributeFilter:["data-sidebar-right-open","aria-hidden"],
});
}catch{
try{observer?.disconnect?.();}catch{/* 忽略 */}
observer=null;
}
};
const startFallback=()=>{
try{
timer=globalThis.setTimeout(()=>{timer=null;release();},RIGHTBAR_CONTINUITY_FALLBACK_MS);
}catch{timer=null;/* 没有可用调度器：最坏情况由调用方 release */}
};
const capture=()=>{
release();// 每次只允许一个遮罩
const doc=globalThis.document;
if(!doc||typeof doc.createElement!=="function"||doc.body===null||doc.body===undefined)return null;
let panel=null;
try{panel=typeof doc.querySelector==="function"?doc.querySelector("[data-sidebar-right-panel]"):null;}catch{panel=null;}
if(panel===null||panel===undefined)return null;
let rect=null;
try{rect=typeof panel.getBoundingClientRect==="function"?panel.getBoundingClientRect():null;}catch{rect=null;}
if(rect===null||typeof rect!=="object")return null;
const left=Number(rect.left);
const top=Number(rect.top);
const width=Number(rect.width);
const height=Number(rect.height);
if([left,top,width,height].every((value)=>Number.isFinite(value))!==true)return null;
let clone=null;
try{clone=typeof panel.cloneNode==="function"?panel.cloneNode(true):null;}catch{clone=null;}
if(clone===null||clone===undefined)return null;
let created=null;
try{
scrubClone(clone);
try{
if(clone.style!==undefined&&clone.style!==null)clone.style.pointerEvents="none";
}catch{/* host 本身已经 pointer-events:none */}
removeHost(typeof doc.getElementById==="function"?doc.getElementById(RIGHTBAR_CONTINUITY_OVERLAY_ID):null);
created=doc.createElement("div");
created.id=RIGHTBAR_CONTINUITY_OVERLAY_ID;
created.setAttribute("aria-hidden","true");
created.setAttribute("style",
"position:fixed;z-index:2147482999;pointer-events:none;overflow:hidden;background:inherit;"
+"left:"+left+"px;top:"+top+"px;width:"+width+"px;height:"+height+"px;");
created.appendChild(clone);
doc.body.appendChild(created);
}catch{
removeHost(created);
return null;
}
host=created;
originalPanel=panel;
if(hasOpenedPanel()===true){
release();
return release;
}
observeBody();
startFallback();
return release;
};
return Object.freeze({capture,release});
}
global[SYMBOL]=Object.freeze({createNativeRightbarContinuityOverlay});
})(globalThis);
/* source: client-sidebar-install-layout.js */
(function installSidebarInstallLayout(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-layout");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{object,text}=PURE;
const LAYOUT_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-layout");
const LAYOUT=global[LAYOUT_SYMBOL]||{};
const{createRightbarDragLock,createSplitTrackRatio}=LAYOUT;
const OVERLAY_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-overlay");
const OVERLAY=global[OVERLAY_SYMBOL]||{};
const{createNativeRightbarContinuityOverlay}=OVERLAY;
const RIGHTBAR_TARGET_MARKERS=[
"data-sidebar-right-panel",// 右栏面板本体
"data-sidebar-right-open",// 面板展开状态（动画开始）
"data-shell-overlay",// 覆盖层：其父元素即 AppFrame
"data-rightbar-collapsed",// AppFrame 折叠状态
"data-rightbar-instant",// AppFrame 瞬时展开状态
"data-dsh-better-sidebar",
];
const RIGHTBAR_TRANSITION_VAR="--ds-transition-duration-slow";
const RIGHTBAR_INSTANT_FALLBACK_MS=250;
const rightbarTransitionTargets=()=>{
const targets=[];
const byElement=new Map();// element → targets 下标：同一元素只保留一次
const push=(element,kind)=>{
if(!element)return;
const index=byElement.get(element);
if(index!==undefined){
if(kind==="panel")targets[index].kind="panel";
return;
}
byElement.set(element,targets.length);
targets.push({element,kind});
};
try{
const doc=globalThis.document;
if(!doc||typeof doc.querySelector!=="function")return targets;
push(doc.querySelector("[data-sidebar-right-panel]"),"panel");
const overlay=doc.querySelector("[data-shell-overlay]");
if(overlay?.parentElement)push(overlay.parentElement,"frame");
push(doc.querySelector("[data-rightbar-collapsed]"),"frame");
push(doc.querySelector("[data-rightbar-instant]"),"frame");
push(doc.querySelector("[data-dsh-better-sidebar] > [class*='panel']:not([class*='bottomPanel'])"),"panel");
push(doc.querySelector("#root"),"frame");
}catch{/* 探测失败：返回已收集到的部分，其余按「无法抑制」处理。 */}
return targets;
}
const frameRightbarCollapsed=()=>{
try{
const doc=globalThis.document;
if(!doc||typeof doc.querySelector!=="function")return false;
return doc.querySelector("[data-rightbar-collapsed]")!==null;
}catch{return false;}
}
const suppressRightbarTransition=()=>{
const handled=new Set();
const restores=[];
const applyToElement=(element,pinPanel)=>{
let style=null;
try{style=element.style||null;}catch{style=null;}
if(style===null||typeof style.setProperty!=="function")return;
const readValue=(name)=>{
try{return typeof style.getPropertyValue==="function"?style.getPropertyValue(name):"";}catch{return"";}
};
const readPriority=(name)=>{
try{return typeof style.getPropertyPriority==="function"?style.getPropertyPriority(name):"";}catch{return"";}
};
const writes=[
{name:RIGHTBAR_TRANSITION_VAR,value:"0ms"},
{name:"transition",value:"none"},
];
if(pinPanel===true){
writes.push({name:"transform",value:"none"},{name:"visibility",value:"visible"});
}
const previous=new Map();
for(const{name}of writes)previous.set(name,{value:readValue(name),priority:readPriority(name)});
const restoreIfUnchanged=(name,written,writtenPriority,prev)=>{
try{
if(typeof style.getPropertyValue==="function"&&style.getPropertyValue(name)!==written)return false;
if(typeof style.getPropertyPriority==="function"&&style.getPropertyPriority(name)!==writtenPriority)return false;
if(prev.value===""||prev.value===null||prev.value===undefined)style.removeProperty?.(name);
else style.setProperty(name,prev.value,prev.priority||"");
return true;
}catch{return false;/* 单个还原失败不能阻断其它属性，最坏情况是宿主多留一条内联样式。 */}
};
try{
for(const{name,value}of writes)style.setProperty(name,value,"important");
}catch{
for(const{name,value}of writes){
restoreIfUnchanged(name,value,readPriority(name),previous.get(name));
}
return;
}
const written=[...writes].reverse().map(({name,value})=>({
name,
value,
priority:readPriority(name),
prev:previous.get(name),
}));
restores.push(()=>{
for(const entry of written){
restoreIfUnchanged(entry.name,entry.value,entry.priority,entry.prev);
}
});
};
const applyTargets=()=>{
const collapsed=frameRightbarCollapsed();
for(const target of rightbarTransitionTargets()){
if(handled.has(target.element))continue;
handled.add(target.element);
applyToElement(target.element,target.kind==="panel"&&collapsed!==true);
}
};
applyTargets();
let observer=null;
try{
const doc=globalThis.document;
const Observer=globalThis.MutationObserver??doc?.defaultView?.MutationObserver;
const root=doc?.documentElement??doc?.body??null;
if(typeof Observer==="function"&&root!==null&&typeof root==="object"){
observer=new Observer(()=>{applyTargets();});
try{
observer.observe(root,{
childList:true,
subtree:true,
attributes:true,
attributeFilter:[...RIGHTBAR_TARGET_MARKERS],
});
}catch{
try{observer.disconnect();}catch{/* 断开失败也不能阻断后续恢复。 */}
observer=null;
}
}
}catch{observer=null;}
if(restores.length===0&&observer===null)return null;
return()=>{
const current=observer;
observer=null;
if(current!==null){
try{current.disconnect();}catch{/* 断开失败不能阻断样式还原。 */}
}
for(const restore of restores){
try{restore();}catch{/* 单个目标还原失败不能阻断其它目标。 */}
}
};
}
function createInstantRestoreScheduler(){
let pendingInstantRestore=null;// { restore, cancel }
const flushInstantRestore=()=>{
const pending=pendingInstantRestore;
if(pending===null)return;
pendingInstantRestore=null;
try{pending.cancel();}catch{/* 取消失败不影响立即还原。 */}
try{pending.restore();}catch{/* 还原失败不能影响宿主布局。 */}
};
const scheduleInstantRestore=(restore)=>{
flushInstantRestore();
let settled=false;
let firstFrame=null;
let secondFrame=null;
let fallbackTimer=null;
const cancelPending=()=>{
try{if(firstFrame!==null)globalThis.cancelAnimationFrame?.(firstFrame);}catch{/* 可选 API。 */}
try{if(secondFrame!==null)globalThis.cancelAnimationFrame?.(secondFrame);}catch{/* 可选 API。 */}
try{if(fallbackTimer!==null)globalThis.clearTimeout?.(fallbackTimer);}catch{/* 可选 API。 */}
};
const settle=()=>{
if(settled)return;
settled=true;
cancelPending();
if(pendingInstantRestore!==null&&pendingInstantRestore.restore===restore)pendingInstantRestore=null;
try{restore();}catch{/* 见上：只影响这次打开有没有动画。 */}
};
const cancel=()=>{settled=true;cancelPending();};
try{
fallbackTimer=globalThis.setTimeout(settle,RIGHTBAR_INSTANT_FALLBACK_MS);
}catch{fallbackTimer=null;}
let rafScheduled=false;
try{
const raf=globalThis.requestAnimationFrame;
if(typeof raf==="function"){
firstFrame=raf(()=>{secondFrame=raf(settle);});
rafScheduled=true;
}
}catch{/* RAF 不可用：完全依赖上面的 fallback timer。 */}
if(fallbackTimer===null&&rafScheduled!==true){
settle();
return;
}
pendingInstantRestore={restore,cancel};
};
return Object.freeze({flushInstantRestore,scheduleInstantRestore});
}
function createSidebarInstallLayout(frame){
const rightbarDragLock=createRightbarDragLock();
const splitTrackRatio=createSplitTrackRatio();
let splitTrackReader=null;
const requestSplitTrackSync=()=>{
if(splitTrackReader===null||frame.disposed)return false;
return splitTrackRatio.sync(splitTrackReader.readTarget);
};
let rightbarDragSyncImpl=null;
const requestRightbarDragSync=()=>{
if(rightbarDragSyncImpl===null||frame.disposed)return;
try{rightbarDragSyncImpl();}catch{/* 手柄锁只是体验优化，绝不影响面板渲染。 */}
};
const releaseRightbarDragLock=()=>{
if(frame.disposed)return;
try{rightbarDragLock.setLocked(false);}catch{/* 同上。 */}
try{requestSplitTrackSync();}catch{/* 配比只是布局微调，绝不影响卸载。 */}
};
const surfaceRecords=new Map();
const surfaceRecordOf=(sessionId)=>{
let record=surfaceRecords.get(sessionId);
if(record===undefined){
record={
visitEpoch:0,
openAttempts:0,
openRetries:0,
openFailures:0,
openState:"idle",
expandDone:false,
readinessRetries:0,
commitState:"unknown",
transitionRestore:null,
continuityRelease:null,
};
surfaceRecords.set(sessionId,record);
}
return record;
};
const releaseContinuityOverlayOf=(record)=>{
if(record===undefined||record===null)return false;
const release=record.continuityRelease??null;
record.continuityRelease=null;
if(typeof release!=="function")return false;
try{release();}catch{/* 释放失败不能阻断其它收尾动作。 */}
return true;
};
const releaseTransitionRestore=(record,options={})=>{
if(record===undefined||record===null)return false;
if(options.keepContinuity!==true)releaseContinuityOverlayOf(record);
const restore=record.transitionRestore??null;
record.transitionRestore=null;
if(typeof restore!=="function")return false;
try{restore();}catch{/* 恢复失败不能阻断其它收尾动作。 */}
return true;
};
const beginVisitFor=(sessionId,epoch)=>{
const record=surfaceRecordOf(sessionId);
if(record.visitEpoch===epoch)return record;
releaseTransitionRestore(record,{keepContinuity:true});
record.visitEpoch=epoch;
record.openAttempts=0;
record.openRetries=0;
record.openFailures=0;
record.openState="idle";
record.expandDone=false;
record.readinessRetries=0;
record.commitState="unknown";
return record;
};
let currentVisitKey=null;
let currentVisitEpoch=0;
let currentVisitSessionId=null;
const beginVisit=(current,hostSessionId)=>{
const key=String(current)+"|"+String(hostSessionId)+"|"+String(frame.target.remountSerial());
if(key===currentVisitKey)return currentVisitEpoch;
currentVisitKey=key;
currentVisitEpoch+=1;
if(currentVisitSessionId!==null){
frame.expand.cancelSurfaceOpenTimer(currentVisitSessionId);
frame.expand.cancelRightbarExpand(currentVisitSessionId);
releaseTransitionRestore(surfaceRecords.get(currentVisitSessionId),{
keepContinuity:currentVisitSessionId===current&&hostSessionId!==null,
});
}
currentVisitSessionId=current;
return currentVisitEpoch;
};
const readHostActiveSurface=()=>{
const better=frame.better;
let readSnapshot;
try{
const candidate=better?.getSnapshot;
if(typeof candidate!=="function")return{available:false,sessionId:null};
readSnapshot=candidate;
}catch{return{available:false,sessionId:null};}
try{
return{available:true,sessionId:text(object(readSnapshot.call(better)).sessionId,null)};
}catch{return{available:false,sessionId:null};}
};
const instantRestore=createInstantRestoreScheduler();
const continuityOverlay=createNativeRightbarContinuityOverlay();
const rightbarWidths=new Map();
const rightbarWidthViewports=new Map();
const rightbarWidthModes=new Map();
const rightbarWidthPreparedSessions=new Set();
const rightbarWidthActiveSessions=new Set();
const rightbarWidthRecoveries=new Map();
const rightbarSplitTransactions=new Map();
const widthState={
widths:rightbarWidths,
viewports:rightbarWidthViewports,
modes:rightbarWidthModes,
prepared:rightbarWidthPreparedSessions,
active:rightbarWidthActiveSessions,
recoveries:rightbarWidthRecoveries,
splitTransactions:rightbarSplitTransactions,
};
const clearWidthState=()=>{
rightbarWidths.clear();
rightbarWidthViewports.clear();
rightbarWidthModes.clear();
rightbarWidthPreparedSessions.clear();
rightbarWidthActiveSessions.clear();
rightbarWidthRecoveries.clear();
};
return Object.freeze({
beginVisit,
beginVisitFor,
clearWidthState,
continuityOverlay,
currentVisitEpoch:()=>currentVisitEpoch,
flushInstantRestore:instantRestore.flushInstantRestore,
readHostActiveSurface,
releaseRightbarDragLock,
releaseTransitionRestore,
requestRightbarDragSync,
requestSplitTrackSync,
rightbarDragLock,
scheduleInstantRestore:instantRestore.scheduleInstantRestore,
setDragSyncImpl:(impl)=>{rightbarDragSyncImpl=impl;},
setSplitTrackReader:(reader)=>{splitTrackReader=reader;},
suppressRightbarTransition,
splitTrackRatio,
surfaceRecordOf,
surfaceRecords,
widthState,
});
}
global[SYMBOL]=Object.freeze({createSidebarInstallLayout});
})(globalThis);
/* source: client-sidebar-install-width.js */
(function installSidebarInstallWidth(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-width");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
OTHER_RIGHTBAR_WIDTH_RATIO,RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS,
clampRightbarWidthRatio,resolveExpertRightbarWidthRatio,storeRightbarWidthRatio,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
hostAppFrameWidthOf,methodOf,rightbarPanelForSession,viewportWidthOf,
}=DOM;
function createWidthBookkeeping(frame){
const state=frame.layout.widthState;
const rightbarWidths=state.widths;
const rightbarWidthModes=state.modes;
const rightbarWidthPreparedSessions=state.prepared;
const rightbarWidthActiveSessions=state.active;
const rightbarWidthRecoveries=state.recoveries;
const rightbarSplitTransactions=state.splitTransactions;
let rightbarWidthSurfaceSessionId=null;
const clearRightbarWidthRecovery=(sessionId)=>{
if(sessionId===null||sessionId===undefined)return;
rightbarWidthRecoveries.delete(sessionId);
};
const allowRightbarRecoveryWrite=(sessionId,target,actualWidth)=>{
if(sessionId===null||sessionId===undefined)return false;
if(typeof target!=="number"||Number.isFinite(target)!==true)return false;
if(typeof actualWidth!=="number"||Number.isFinite(actualWidth)!==true)return false;
const recorded=rightbarWidthRecoveries.get(sessionId);
const sameEvent=recorded!==undefined
&&recorded.target===target
&&Math.abs(recorded.actualWidth-actualWidth)<=RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX;
if(sameEvent!==true){
rightbarWidthRecoveries.set(sessionId,{target,actualWidth,attempts:1});
return true;
}
if(recorded.attempts>=RIGHTBAR_WIDTH_RECOVERY_MAX_ATTEMPTS)return false;
recorded.attempts+=1;
return true;
};
const widthModeOf=(sessionId)=>(sessionId===null||sessionId===undefined
?null
:rightbarWidthModes.get(sessionId)??null);
const setWidthMode=(sessionId,mode)=>{
if(sessionId===null||sessionId===undefined)return;
const previous=rightbarWidthModes.get(sessionId)??null;
const next=mode===null||mode===undefined?null:mode;
if(next===null)rightbarWidthModes.delete(sessionId);
else rightbarWidthModes.set(sessionId,next);
if(previous!==null&&previous!==next)clearRightbarWidthRecovery(sessionId);
};
const isWidthPrepared=(sessionId)=>sessionId!==null&&sessionId!==undefined
&&rightbarWidthPreparedSessions.has(sessionId);
const setWidthPrepared=(sessionId,value)=>{
if(sessionId===null||sessionId===undefined)return;
if(value===true)rightbarWidthPreparedSessions.add(sessionId);
else rightbarWidthPreparedSessions.delete(sessionId);
};
const isWidthActive=(sessionId)=>sessionId!==null&&sessionId!==undefined
&&rightbarWidthActiveSessions.has(sessionId);
const setWidthActive=(sessionId,value)=>{
if(sessionId===null||sessionId===undefined)return;
if(value===true)rightbarWidthActiveSessions.add(sessionId);
else rightbarWidthActiveSessions.delete(sessionId);
};
const clearRightbarWidthMarks=(sessionId)=>{
setWidthMode(sessionId,null);
setWidthPrepared(sessionId,false);
setWidthActive(sessionId,false);
clearRightbarWidthRecovery(sessionId);
};
const claimRightbarWidthOwnership=(sessionId)=>{
if(sessionId===null||sessionId===undefined)return;
const previous=rightbarWidthSurfaceSessionId;
if(previous!==null&&previous!==sessionId)clearRightbarWidthMarks(previous);
rightbarWidthSurfaceSessionId=sessionId;
};
const transactionOf=(token)=>{
if(token===null||token===undefined)return null;
for(const transaction of rightbarSplitTransactions.values()){
if(transaction.token===token)return transaction;
}
return null;
};
const releaseSidebarSplitTransaction=(transaction)=>{
if(rightbarSplitTransactions.get(transaction.sessionId)===transaction){
rightbarSplitTransactions.delete(transaction.sessionId);
}
};
const cancelAllSidebarSplits=(reason)=>{
for(const transaction of[...rightbarSplitTransactions.values()]){
try{frame.target.cancelSidebarSplit(transaction.token,{reason});}catch{/* 单条收口失败不能阻断其余事务与 disposer。 */}
}
};
const clearSidebarSplitDeadline=(transaction)=>{
if(transaction===null||transaction===undefined)return;
const timer=transaction.deadlineTimer;
transaction.deadlineTimer=null;
if(timer===null||timer===undefined)return;
try{globalThis.clearTimeout?.(timer);}catch{/* 收口路径必须继续执行。 */}
};
return Object.freeze({
allowRightbarRecoveryWrite,
cancelAllSidebarSplits,
hasSplitTransaction:(sessionId)=>rightbarSplitTransactions.has(sessionId),
hasWidthTarget:(sessionId)=>rightbarWidths.has(sessionId),
splitTransactions:rightbarSplitTransactions,
splitTransactionsList:()=>[...rightbarSplitTransactions],
surfaceSessionId:()=>rightbarWidthSurfaceSessionId,
claimRightbarWidthOwnership,
clearRightbarWidthMarks,
clearRightbarWidthRecovery,
clearSidebarSplitDeadline,
isWidthActive,
isWidthPrepared,
releaseSidebarSplitTransaction,
setWidthActive,
setWidthMode,
setWidthPrepared,
transactionOf,
widthModeOf,
});
}
function createRightbarWidthWriter(frame){
const config=frame.config;
const state=frame.layout.widthState;
const rightbarWidths=state.widths;
const rightbarWidthViewports=state.viewports;
const applyRightbarWidth=(sessionId,ratio=resolveExpertRightbarWidthRatio(),force=false)=>{
if(sessionId===null||sessionId===undefined)return false;
const viewportWidth=viewportWidthOf();
if(viewportWidth===null)return false;
const normalizedRatio=Number(ratio);
if(!Number.isFinite(normalizedRatio)||normalizedRatio<=0)return false;
const target=Math.round(viewportWidth*normalizedRatio);
if(force!==true&&rightbarWidths.get(sessionId)===target)return false;
const layout=config.layout||frame.optionalService("layout");
let panels=null;
try{panels=layout?.panels??null;}catch{panels=null;}
const setRightbar=methodOf(panels,"setRightbar");
if(setRightbar===null)return false;
const setViewportWidth=methodOf(panels,"setViewportWidth");
const appFrameWidth=hostAppFrameWidthOf();
if(appFrameWidth!==null){
try{setViewportWidth?.call(panels,appFrameWidth);}catch{/* 校准不是展示侧栏的前置条件，失败时保留原有写入兼容路径。 */}
}
try{
setRightbar.call(panels,target);
}catch{
return false;
}
rightbarWidths.set(sessionId,target);
rightbarWidthViewports.set(sessionId,viewportWidth);
frame.width.claimRightbarWidthOwnership(sessionId);
return true;
};
const rightbarWidthViewportChanged=(sessionId)=>{
if(sessionId===null||sessionId===undefined)return false;
const recorded=rightbarWidthViewports.get(sessionId);
if(recorded===undefined)return false;
const viewportWidth=viewportWidthOf();
if(viewportWidth===null)return false;
return recorded!==viewportWidth;
};
const readRightbarPanelWidth=(sessionId)=>{
if(typeof sessionId!=="string"||sessionId==="")return null;
let panel=null;
try{panel=rightbarPanelForSession(globalThis.document,sessionId);}catch{return null;}
if(panel===null||panel===undefined)return null;
let rect=null;
try{
rect=typeof panel.getBoundingClientRect==="function"?panel.getBoundingClientRect():null;
}catch{return null;}
if(rect===null||typeof rect!=="object")return null;
let width=null;
try{width=Number(rect.width);}catch{return null;}
if(Number.isFinite(width)!==true||width<=0)return null;
return width;
};
const rightbarOwnershipOf=(sessionId)=>{
const target=rightbarWidths.get(sessionId);
if(typeof target!=="number"||Number.isFinite(target)!==true)return null;
const actualWidth=readRightbarPanelWidth(sessionId);
if(actualWidth===null)return null;
const delta=Math.abs(actualWidth-target);
return{
target,
actualWidth,
matches:delta<=RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
differs:delta>RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX,
};
};
const hostWidthMatchesPluginTarget=(sessionId)=>{
const ownership=rightbarOwnershipOf(sessionId);
return ownership!==null&&ownership.matches===true;
};
const settleRightbarRecovery=(sessionId,ownership)=>{
if(ownership!==null&&ownership.matches===true)frame.width.clearRightbarWidthRecovery(sessionId);
};
const recoverRightbarWidth=(sessionId,ratio,ownership)=>{
if(sessionId===null||sessionId===undefined)return false;
if(ownership===null||ownership===undefined)return false;
const viewportWidth=viewportWidthOf();
if(viewportWidth===null)return false;
const expectedTarget=Math.round(viewportWidth*ratio);
if(Math.abs(ownership.actualWidth-expectedTarget)<=RIGHTBAR_WIDTH_OWNERSHIP_TOLERANCE_PX){
return applyRightbarWidth(sessionId,ratio,true)===true;
}
if(frame.width.allowRightbarRecoveryWrite(sessionId,expectedTarget,ownership.actualWidth)!==true)return false;
return applyRightbarWidth(sessionId,ratio,true)===true;
};
const recomputeOwnedWidth=(sessionId)=>{
if(sessionId===null||sessionId===undefined)return false;
const viewportChanged=rightbarWidthViewportChanged(sessionId)===true;
const ownership=rightbarOwnershipOf(sessionId);
settleRightbarRecovery(sessionId,ownership);
const hostReclaimed=ownership!==null&&ownership.differs===true;
if(viewportChanged!==true&&hostReclaimed!==true)return false;
const mode=frame.width.widthModeOf(sessionId);
let ratio=null;
if(mode==="expert"){
ratio=resolveExpertRightbarWidthRatio();
}else if(mode==="other"){
if(viewportChanged!==true)return false;
if(ownership===null||ownership.matches!==true)return false;
ratio=OTHER_RIGHTBAR_WIDTH_RATIO;
}else if(mode===null&&(frame.width.isWidthPrepared(sessionId)||frame.width.isWidthActive(sessionId))){
ratio=resolveExpertRightbarWidthRatio();
}
if(ratio===null)return false;
return recoverRightbarWidth(sessionId,ratio,ownership)===true;
};
const applyRightbarWidthRatio=(ratio,options={})=>{
const clamped=clampRightbarWidthRatio(ratio);
if(clamped===null)return null;
if(options.persist===true)storeRightbarWidthRatio(clamped);
const sessionId=frame.target.currentSurfaceSessionId();
if(sessionId===null)return clamped;
if(frame.width.hasSplitTransaction(sessionId))return clamped;
if(applyRightbarWidth(sessionId,clamped,true)!==true)return clamped;
setWidthPrepared(sessionId,false);
setWidthActive(sessionId,true);
setWidthMode(sessionId,"expert");
return clamped;
};
return Object.freeze({
applyRightbarWidth,
applyRightbarWidthRatio,
hostWidthMatchesPluginTarget,
readRightbarPanelWidth,
recomputeOwnedWidth,
recoverRightbarWidth,
rightbarOwnershipOf,
rightbarWidthViewportChanged,
settleRightbarRecovery,
});
}
global[SYMBOL]=Object.freeze({createRightbarWidthWriter,createWidthBookkeeping});
})(globalThis);
/* source: client-sidebar-install-expand.js */
(function installSidebarInstallExpand(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-expand");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
EXPERT_GROUP_TAB_IDS,RIGHTBAR_PANEL_SELECTOR,RIGHTBAR_TAB_SELECTOR,
isGeneratedExpertGroupTabId,object,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{methodOf,rightbarPanelForSession}=DOM;
const RIGHTBAR_EXPAND_DELAY_MS=0;// 至少一个宏任务：排到宿主本次提交（surface/seat）之后
const RIGHTBAR_EXPAND_RETRY_MS=250;// 调用抛错后的短重试间隔
const RIGHTBAR_EXPAND_MAX_ATTEMPTS=3;// 每个 surface 的调用尝试上限（含自动重试）
const MAX_SURFACE_OPEN_ATTEMPTS=3;
const MAX_SURFACE_OPEN_RETRIES=1;
const SURFACE_OPEN_DELAY_MS=0;
const SURFACE_OPEN_RETRY_MS=250;
const MAX_READINESS_RETRIES=3;
const HOST_COMMIT_RETRY_MS=250;
const RIGHTBAR_PRESENTED_KEY="dsh-expert-group:rightbar-presented:v1";
const readPersistedRightbarPresented=()=>{
try{
const storage=globalThis.localStorage;
if(!storage||typeof storage.getItem!=="function")return false;
return storage.getItem(RIGHTBAR_PRESENTED_KEY)==="1";
}catch{return false;}
}
const persistRightbarPresented=()=>{
try{
const storage=globalThis.localStorage;
if(!storage||typeof storage.setItem!=="function")return false;
storage.setItem(RIGHTBAR_PRESENTED_KEY,"1");
return true;
}catch{return false;}
}
function createRightbarExpand(frame){
const config=frame.config;
const layout=frame.layout;
const{
readHostActiveSurface,releaseTransitionRestore,scheduleInstantRestore,suppressRightbarTransition,
surfaceRecordOf,surfaceRecords,
}=layout;
const currentSurfaceSessionIdOf=()=>frame.target.currentSurfaceSessionId();
const rightbarExpandTimers=new Map();
const rightbarExpandFailures=new Map();
let rightbarPresented=false;
let rightbarPresentedPersisted=readPersistedRightbarPresented();
const cancelRightbarExpand=(sessionId)=>{
const timer=rightbarExpandTimers.get(sessionId);
if(timer===undefined)return;
rightbarExpandTimers.delete(sessionId);
try{
globalThis.clearTimeout?.(timer);
}catch{/* 取消失败不能阻止其它所有权释放。 */}
};
const cancelAllRightbarExpands=()=>{
for(const sessionId of[...rightbarExpandTimers.keys()])cancelRightbarExpand(sessionId);
};
const callOpenRightbar=(preparedRestore=null)=>{
const releasePrepared=()=>{
if(typeof preparedRestore!=="function")return;
try{preparedRestore();}catch{/* 恢复失败不能阻断其它收尾。 */}
};
const layout=config.layout||frame.optionalService("layout");
let openRightbar=null;
try{
const candidate=layout?.openRightbar;
if(typeof candidate==="function")openRightbar=candidate;
}catch{
releasePrepared();
return"unavailable";
}
if(openRightbar===null){
releasePrepared();
return"unavailable";
}
const restoreTransition=typeof preparedRestore==="function"
?preparedRestore
:(rightbarPresentedPersisted?suppressRightbarTransition():null);
let result="ok";
try{
openRightbar.call(layout,true,false);
}catch{
result="failed";
}
if(restoreTransition!==null)scheduleInstantRestore(restoreTransition);
return result;
};
const scheduleRightbarExpand=(sessionId,epoch,delay)=>{
if(frame.disposed||sessionId===null)return false;
if(rightbarPresented)return false;
const record=surfaceRecordOf(sessionId);
if(record.visitEpoch!==epoch)return false;
if(record.expandDone)return false;
if(rightbarExpandTimers.has(sessionId))return false;
let timer;
try{
timer=globalThis.setTimeout(()=>{
rightbarExpandTimers.delete(sessionId);
runRightbarExpand(sessionId,epoch);
},delay);
}catch{
return false;
}
rightbarExpandTimers.set(sessionId,timer);
return true;
};
const runRightbarExpand=(sessionId,epoch)=>{
if(frame.disposed)return;
const record=surfaceRecordOf(sessionId);
if(rightbarPresented){
releaseTransitionRestore(record);
return;
}
if(record.visitEpoch!==epoch)return;
if(record.expandDone)return;
if((rightbarExpandFailures.get(sessionId)||0)>=RIGHTBAR_EXPAND_MAX_ATTEMPTS){
releaseTransitionRestore(record);
return;
}
if(currentSurfaceSessionIdOf()!==sessionId){
releaseTransitionRestore(record);
return;
}
const host=readHostActiveSurface();
if(host.available&&host.sessionId!==sessionId){
releaseTransitionRestore(record);
return;
}
if(record.openState!=="opened"){
releaseTransitionRestore(record);
return;
}
const preparedRestore=typeof record.transitionRestore==="function"?record.transitionRestore:null;
record.transitionRestore=null;
const result=callOpenRightbar(preparedRestore);
if(result==="ok"){
record.expandDone=true;
rightbarPresented=true;
rightbarPresentedPersisted=true;
persistRightbarPresented();
rightbarExpandFailures.delete(sessionId);
return;
}
if(result==="unavailable")return;
const failures=(rightbarExpandFailures.get(sessionId)||0)+1;
rightbarExpandFailures.set(sessionId,failures);
if(failures>=RIGHTBAR_EXPAND_MAX_ATTEMPTS
||scheduleRightbarExpand(sessionId,epoch,RIGHTBAR_EXPAND_RETRY_MS)!==true){
releaseTransitionRestore(record);
}
};
const scheduleCurrentSurfaceExpand=()=>{
const current=currentSurfaceSessionIdOf();
const record=current===null?undefined:surfaceRecords.get(current);
if(rightbarPresented){
const preparedRestore=typeof record?.transitionRestore==="function"?record.transitionRestore:null;
if(preparedRestore===null)return;
record.transitionRestore=null;
scheduleInstantRestore(preparedRestore);
return;
}
if(current===null)return;
if(record===undefined)return;
if(record.visitEpoch!==frame.layout.currentVisitEpoch())return;
if(record.openState!=="opened")return;
if(record.expandDone)return;
if(scheduleRightbarExpand(current,record.visitEpoch,RIGHTBAR_EXPAND_DELAY_MS)!==true){
releaseTransitionRestore(record);
}
};
const armSuppression=(record)=>{
if(rightbarPresentedPersisted&&typeof record.transitionRestore!=="function"){
record.transitionRestore=suppressRightbarTransition();
}
};
return Object.freeze({
armSuppression,
cancelAllRightbarExpands,
cancelRightbarExpand,
isPersisted:()=>rightbarPresentedPersisted,
isPresented:()=>rightbarPresented,
endPresentation:(sessionId)=>{
rightbarPresented=false;
cancelRightbarExpand(sessionId);
rightbarExpandFailures.clear();
},
scheduleCurrentSurfaceExpand,
scheduleRightbarExpand,
});
}
function createRightbarComposition(frame){
const config=frame.config;
const sessions=frame.sessions;
const nativeSidebar=frame.nativeSidebar;
const{readHostActiveSurface}=frame.layout;
const nativeSidebarFor=(target)=>{
if(typeof config.sidebarRightForSession==="function"){
try{return config.sidebarRightForSession(target,frame.ctx);}catch{return null;}
}
try{
const scoped=typeof sessions?.scope==="function"?sessions.scope(target):null;
return scoped?.get?.("sidebarRight")||scoped?.sidebarRight||null;
}catch{return null;}
};
const readSurfaceOpenTabs=()=>{
let inventory=null;
try{inventory=nativeSidebar?.openTabs??null;}catch{return null;}
const getSnapshot=methodOf(inventory,"getSnapshot");
if(getSnapshot===null)return null;
try{
const snapshot=getSnapshot.call(inventory);
return Array.isArray(snapshot)?snapshot:null;
}catch{return null;}
};
const readRightbarDomComposition=(sessionId=null)=>{
const doc=globalThis.document;
if(!doc||typeof doc.querySelector!=="function")return null;
let panel=null;
if(typeof sessionId==="string"&&sessionId!==""){
panel=rightbarPanelForSession(doc,sessionId);
if(panel===null)return null;
}else{
try{panel=doc.querySelector(RIGHTBAR_PANEL_SELECTOR);}catch{return null;}
}
if(panel===null||panel===undefined||typeof panel.querySelectorAll!=="function")return null;
let nodes;
try{nodes=Array.from(panel.querySelectorAll(RIGHTBAR_TAB_SELECTOR));}catch{return null;}
const inventory=readSurfaceOpenTabs();
const kindByTabId=new Map();
if(inventory!==null&&sessionId!==null&&sessionId!==undefined){
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
const tabId=text(candidate.tabId,null);
const kind=text(candidate.kind,text(candidate.type,null));
if(tabId!==null&&kind!==null)kindByTabId.set(tabId,kind);
}catch{
}
}
}
let hasOther=false;
let hasUnknown=false;
for(const node of nodes){
let tabId=null;
try{tabId=text(node?.getAttribute?.("data-dockkit-tab"),null);}catch{tabId=null;}
if(tabId===null){hasUnknown=true;continue;}
if(EXPERT_GROUP_TAB_IDS.has(tabId)||isGeneratedExpertGroupTabId(tabId))continue;
if(!kindByTabId.has(tabId)){hasUnknown=true;continue;}
const kind=kindByTabId.get(tabId);
if(EXPERT_GROUP_TAB_IDS.has(kind))continue;
hasOther=true;
}
if(hasOther)return"other";
if(hasUnknown)return"unknown";
return"expert-only";
};
const hasOtherRightbarPage=(sessionId)=>{
const inventory=readSurfaceOpenTabs();
if(inventory!==null){
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
const kind=text(candidate.kind,text(candidate.type,null));
if(kind!==null&&!EXPERT_GROUP_TAB_IDS.has(kind))return true;
}catch{
}
}
}
return readRightbarDomComposition(sessionId)==="other";
};
const hasExistingExpertGroupTab=(sessionId)=>{
if(sessionId===null)return false;
const inventory=readSurfaceOpenTabs();
if(inventory===null)return false;
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
if(!EXPERT_GROUP_TAB_IDS.has(text(candidate.kind,null)))continue;
return true;
}catch{
continue;
}
}
return false;
};
const activeTabEvidenceOf=(sessionId)=>{
const host=readHostActiveSurface();
if(host.available&&host.sessionId!==sessionId)return"unknown";
let reader=null;
let owner=null;
try{
const scoped=nativeSidebarFor(sessionId);
if(typeof scoped?.active==="function"){reader=scoped.active;owner=scoped;}
}catch{/* 服务代理读取即抛错：按「没有读面」处理。 */}
if(reader===null){
try{
if(typeof nativeSidebar?.active==="function"){reader=nativeSidebar.active;owner=nativeSidebar;}
}catch{/* 同上。 */}
}
if(reader===null)return"unknown";
try{
const tab=reader.call(owner);
const kind=text(object(tab).kind,text(object(tab).type,null));
if(kind===null)return"missing";
return EXPERT_GROUP_TAB_IDS.has(kind)?"confirmed":"other";
}catch{
return"unknown";
}
};
const rightbarCompositionEvidenceOf=(sessionId,activeEvidence)=>{
const inventory=readSurfaceOpenTabs();
if(inventory!==null){
for(const entry of inventory){
try{
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sessionId)continue;
const kind=text(candidate.kind,text(candidate.type,null));
if(kind!==null&&!EXPERT_GROUP_TAB_IDS.has(kind))return"other";
}catch{
}
}
}
const domComposition=readRightbarDomComposition(sessionId);
if(domComposition==="other")return"other";
if(domComposition==="unknown")return"unknown";
if(inventory===null&&domComposition===null&&activeEvidence==="confirmed")return"unknown";
return activeEvidence;
};
const compositionReadFacesUnavailable=()=>{
let inventoryUnavailable=false;
let domUnavailable=false;
try{inventoryUnavailable=readSurfaceOpenTabs()===null;}catch{inventoryUnavailable=true;}
try{domUnavailable=readRightbarDomComposition()===null;}catch{domUnavailable=true;}
return inventoryUnavailable&&domUnavailable;
};
return Object.freeze({
activeTabEvidenceOf,
compositionReadFacesUnavailable,
hasExistingExpertGroupTab,
hasOtherRightbarPage,
nativeSidebarFor,
readRightbarDomComposition,
readSurfaceOpenTabs,
rightbarCompositionEvidenceOf,
});
}
function createSurfaceOpen(frame){
const better=frame.better;
const layout=frame.layout;
const{readHostActiveSurface,releaseTransitionRestore,surfaceRecordOf}=layout;
const activeTabEvidenceOf=(sessionId)=>frame.expand.activeTabEvidenceOf(sessionId);
const armSuppression=(record)=>frame.expand.armSuppression(record);
const hasExistingExpertGroupTab=(sessionId)=>frame.expand.hasExistingExpertGroupTab(sessionId);
const scheduleCurrentSurfaceExpand=(...args)=>frame.expand.scheduleCurrentSurfaceExpand(...args);
const openNativeTab=(target)=>frame.target.openNativeTab(target);
const currentSurfaceSessionIdOf=()=>frame.target.currentSurfaceSessionId();
const openSurfaceTab=(target)=>{
if(better){
if(typeof better.openTab!=="function")return false;
try{
better.openTab({type:"expert-group",target:"right"},{sessionId:target});
return true;
}catch{return false;}
}
try{
return openNativeTab(target)===true;
}catch{return false;}
};
const surfaceOpenTimers=new Map();
const cancelSurfaceOpenTimer=(sessionId)=>{
const timer=surfaceOpenTimers.get(sessionId);
if(timer===undefined)return;
surfaceOpenTimers.delete(sessionId);
try{
globalThis.clearTimeout?.(timer);
}catch{/* 取消失败不能阻止其它所有权释放。 */}
};
const cancelAllSurfaceOpens=()=>{
for(const sessionId of[...surfaceOpenTimers.keys()])cancelSurfaceOpenTimer(sessionId);
};
const scheduleSurfaceOpen=(sessionId,epoch,delay)=>{
if(frame.disposed||sessionId===null)return false;
const record=surfaceRecordOf(sessionId);
if(record.visitEpoch!==epoch)return false;
if(record.openState==="opened")return false;
if(record.openAttempts>=frame.layout.maxSurfaceOpenAttempts)return false;
if(surfaceOpenTimers.has(sessionId))return false;
let timer;
try{
timer=globalThis.setTimeout(()=>{
surfaceOpenTimers.delete(sessionId);
runSurfaceOpen(sessionId,epoch);
},delay);
}catch{
return false;
}
surfaceOpenTimers.set(sessionId,timer);
return true;
};
const runSurfaceOpen=(sessionId,epoch)=>{
if(frame.disposed)return;
const layout=frame.layout;
const record=layout.surfaceRecordOf(sessionId);
if(record.visitEpoch!==epoch)return;
if(record.openState==="opened")return;
if(currentSurfaceSessionIdOf()!==sessionId)return;
const host=readHostActiveSurface();
if(host.available&&host.sessionId!==sessionId){
if(record.readinessRetries<MAX_READINESS_RETRIES
&&scheduleSurfaceOpen(sessionId,epoch,HOST_COMMIT_RETRY_MS)===true){
record.readinessRetries+=1;
}else{
releaseTransitionRestore(record);
}
return;
}
if(record.openAttempts>=MAX_SURFACE_OPEN_ATTEMPTS){
releaseTransitionRestore(record);
return;
}
if(hasExistingExpertGroupTab(sessionId)){
record.openState="opened";
record.openFailures=0;
cancelSurfaceOpenTimer(sessionId);
scheduleCurrentSurfaceExpand();
return;
}
record.openAttempts+=1;
armSuppression(record);
const opened=openSurfaceTab(sessionId);
const evidence=opened?activeTabEvidenceOf(sessionId):"unknown";
if(opened&&(evidence==="confirmed"||evidence==="unknown")){
record.openState="opened";
record.commitState=evidence==="confirmed"?"confirmed":"unknown";
record.openFailures=0;
cancelSurfaceOpenTimer(sessionId);
scheduleCurrentSurfaceExpand();
return;
}
if(evidence==="missing")record.commitState="missing";
else if(evidence==="other")record.commitState="other";
record.openFailures+=1;
if(record.openRetries<MAX_SURFACE_OPEN_RETRIES
&&record.openAttempts<MAX_SURFACE_OPEN_ATTEMPTS
&&scheduleSurfaceOpen(sessionId,epoch,SURFACE_OPEN_RETRY_MS)===true){
record.openRetries+=1;
}else{
releaseTransitionRestore(record);
}
};
return Object.freeze({
cancelAllSurfaceOpens,
cancelSurfaceOpenTimer,
openSurfaceTab,
surfaceOpenDelayMs:SURFACE_OPEN_DELAY_MS,
scheduleSurfaceOpen,
surfaceOpenTimers,
});
}
global[SYMBOL]=Object.freeze({createRightbarComposition,createRightbarExpand,createSurfaceOpen});
})(globalThis);
/* source: client-sidebar-install-target.js */
(function installSidebarInstallTarget(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-target");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
OTHER_RIGHTBAR_WIDTH_RATIO,SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS,
resolveExpertRightbarWidthRatio,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{currentSessionIdOf,listSnapshot}=DOM;
function createSidebarInstallTarget(frame){
const config=frame.config;
const ctx=frame.ctx;
const sessions=frame.sessions;
const better=frame.better;
const nativeSidebar=frame.nativeSidebar;
const layout=frame.layout;
const width=frame.width;
const expand=frame.expand;
const{
beginVisit,beginVisitFor,continuityOverlay,flushInstantRestore,readHostActiveSurface,
requestRightbarDragSync,requestSplitTrackSync,rightbarDragLock,surfaceRecords,
}=layout;
const{
activeTabEvidenceOf,compositionReadFacesUnavailable,hasOtherRightbarPage,
nativeSidebarFor,rightbarCompositionEvidenceOf,scheduleCurrentSurfaceExpand,scheduleSurfaceOpen,
}=expand;
const{
applyRightbarWidth,cancelAllSidebarSplits,claimRightbarWidthOwnership,clearRightbarWidthMarks,hostWidthMatchesPluginTarget,
isWidthActive,isWidthPrepared,recomputeOwnedWidth,recoverRightbarWidth,rightbarOwnershipOf,
rightbarWidthViewportChanged,setWidthActive,setWidthMode,setWidthPrepared,settleRightbarRecovery,
widthModeOf,
}=width;
const rightbarSplitTransactions=width.splitTransactions;
const SURFACE_OPEN_DELAY_MS=expand.surfaceOpenDelayMs;
const widthSurfaceSessionId=()=>width.surfaceSessionId();
let currentRemountSerial=0;
const openTargets=()=>{
if(frame.disposed)return;
const current=currentSurfaceSessionId();
const targets=current===null?[]:[current];
if(targets.length===0){
beginVisit(null,null);
flushInstantRestore();
requestRightbarDragSync();
return;
}
if(better){
let enabled=true;
try{enabled=typeof better.isTabEnabled!=="function"||better.isTabEnabled("expert-group")!==false;}catch{enabled=false;}
if(!enabled||typeof better.openTab!=="function"){
beginVisit(current,null);
flushInstantRestore();
requestRightbarDragSync();
return;
}
}
const otherPagePresent=hasOtherRightbarPage(current);
const splitPending=rightbarSplitTransactions.has(current);
const expertPageCanOwnWidth=splitPending!==true
&&widthModeOf(current)!=="other"&&otherPagePresent!==true;
const rightbarWidthSurfaceSessionId=widthSurfaceSessionId();
const widthSurfaceChanged=rightbarWidthSurfaceSessionId!==current;
const shouldPrepareWidth=expertPageCanOwnWidth&&(widthSurfaceChanged
||isWidthActive(current)
||!width.hasWidthTarget(current));
if(shouldPrepareWidth&&applyRightbarWidth(current,resolveExpertRightbarWidthRatio(),widthSurfaceChanged)){
setWidthPrepared(current,true);
}
const host=readHostActiveSurface();
const observedActive=host.available?host.sessionId:current;
if(current!==null){
const previousRecord=surfaceRecords.get(current);
if(previousRecord!==undefined
&&previousRecord.commitState==="confirmed"
&&activeTabEvidenceOf(current)==="missing"){
currentRemountSerial+=1;
expand.endPresentation(current);
}
}
const epoch=beginVisit(current,observedActive);
if(current!==null){
const record=beginVisitFor(current,epoch);
if(expand.isPresented()===true&&expand.isPersisted()===true
&&typeof record.continuityRelease!=="function"){
record.continuityRelease=continuityOverlay.capture();
}
scheduleSurfaceOpen(current,epoch,SURFACE_OPEN_DELAY_MS);
}
scheduleCurrentSurfaceExpand();
requestRightbarDragSync();
};
const rightbarDragSyncImpl=()=>{
try{requestSplitTrackSync();}catch{/* 配比只是布局微调，绝不影响宽度与手柄的判定。 */}
const current=currentSurfaceSessionId();
if(current===null){
cancelAllSidebarSplits("session-missing");
clearRightbarWidthMarks(widthSurfaceSessionId());
rightbarDragLock.setLocked(false);
return;
}
for(const[sessionId,transaction]of width.splitTransactionsList()){
if(sessionId===current)continue;
try{frame.target.cancelSidebarSplit(transaction.token,{reason:"session-switched"});}catch{/* 后续同步仍会重估。 */}
}
if(rightbarSplitTransactions.has(current)){
rightbarDragLock.setLocked(true);
return;
}
const activeEvidence=activeTabEvidenceOf(current);
let evidence=rightbarCompositionEvidenceOf(current,activeEvidence);
if(evidence==="unknown"&&activeEvidence==="confirmed"&&compositionReadFacesUnavailable()){
evidence="confirmed";
}
if(evidence==="unknown"){
recomputeOwnedWidth(current);
return;
}
if(evidence==="confirmed"){
const prepared=isWidthPrepared(current);
const alreadyActive=isWidthActive(current);
let widthReady=prepared||alreadyActive;
if(!widthReady){
widthReady=applyRightbarWidth(current,resolveExpertRightbarWidthRatio(),true);
}else{
const viewportChanged=rightbarWidthViewportChanged(current)===true;
const ownership=rightbarOwnershipOf(current);
settleRightbarRecovery(current,ownership);
const hostReclaimed=ownership!==null&&ownership.differs===true;
if(viewportChanged||hostReclaimed){
recoverRightbarWidth(current,resolveExpertRightbarWidthRatio(),ownership);
}
}
setWidthPrepared(current,false);
setWidthActive(current,widthReady);
setWidthMode(current,widthReady?"expert":null);
rightbarDragLock.setLocked(false);
return;
}
if(evidence==="missing"){
clearRightbarWidthMarks(current);
rightbarDragLock.setLocked(false);
return;
}
const otherModeMissing=widthModeOf(current)!=="other";
const otherNeedsRecompute=otherModeMissing
||(rightbarWidthViewportChanged(current)&&hostWidthMatchesPluginTarget(current));
if(otherNeedsRecompute){
if(applyRightbarWidth(current,OTHER_RIGHTBAR_WIDTH_RATIO,true)){
setWidthMode(current,"other");
}else if(otherModeMissing){
setWidthMode(current,null);
}
}
setWidthPrepared(current,false);
setWidthActive(current,false);
rightbarDragLock.setLocked(false);
};
const currentSurfaceSessionId=()=>currentSessionIdOf(listSnapshot({...config,sessions},ctx));
const openNativeTab=(target)=>{
const scopedSidebar=nativeSidebarFor(target);
if(typeof scopedSidebar?.openTab==="function"){
scopedSidebar.openTab("expert-group",{revealIfOpened:true});
return true;
}
if(target===currentSurfaceSessionId()&&typeof nativeSidebar?.openTab==="function"){
nativeSidebar.openTab("expert-group",{revealIfOpened:true});
return true;
}
if(typeof nativeSidebar?.openTabIn==="function"){
nativeSidebar.openTabIn(target,"expert-group",{revealIfOpened:true});
return true;
}
return false;
};
layout.setDragSyncImpl(rightbarDragSyncImpl);
return Object.freeze({
currentSurfaceSessionId,
openNativeTab,
resetRemountSerial:()=>{currentRemountSerial=0;},
remountSerial:()=>currentRemountSerial,
openTargets,
rightbarDragSyncImpl,
});
}
function createSidebarSplitTransactions(frame){
const layout=frame.layout;
const width=frame.width;
const expand=frame.expand;
const{rightbarDragLock}=layout;
const{
applyRightbarWidth,claimRightbarWidthOwnership,clearRightbarWidthMarks,clearSidebarSplitDeadline,
isWidthActive,releaseSidebarSplitTransaction,setWidthActive,setWidthMode,setWidthPrepared,
transactionOf,widthModeOf,
}=width;
const{activeTabEvidenceOf,compositionReadFacesUnavailable,rightbarCompositionEvidenceOf}=expand;
const rightbarSplitTransactions=width.splitTransactions;
const currentSurfaceSessionIdOf=()=>frame.target.currentSurfaceSessionId();
const isActiveOnlySplitCompatible=(sessionId,activeEvidence)=>{
if(activeEvidence!=="confirmed")return false;
try{if(currentSurfaceSessionIdOf()!==sessionId)return false;}catch{return false;}
return compositionReadFacesUnavailable();
};
const beginSidebarSplit=(details)=>{
if(frame.disposed)return{busy:true};
const input=details!==null&&typeof details==="object"?details:{};
const sessionId=text(input.sessionId,null);
if(sessionId===null||currentSurfaceSessionIdOf()!==sessionId)return null;
if(rightbarSplitTransactions.has(sessionId))return{busy:true};
let activeEvidence="unknown";
try{activeEvidence=activeTabEvidenceOf(sessionId);}catch{activeEvidence="unknown";}
let composition="unknown";
try{composition=rightbarCompositionEvidenceOf(sessionId,activeEvidence);}catch{composition="unknown";}
if(composition!=="confirmed"
&&frame.target.isActiveOnlySplitCompatible(sessionId,activeEvidence)!==true)return null;
const prepared=applyRightbarWidth(sessionId,OTHER_RIGHTBAR_WIDTH_RATIO,true);
if(prepared!==true)return null;
const token={};
const transaction={
token,
sessionId,
rootSessionId:text(input.rootSessionId,null),
key:text(input.key,null),
resourceAddress:text(input.resourceAddress,null),
paneId:null,
resourceIssued:false,
previousMode:widthModeOf(sessionId),
previousActive:isWidthActive(sessionId),
deadlineTimer:null,
};
rightbarSplitTransactions.set(sessionId,transaction);
clearRightbarWidthMarks(sessionId);
setWidthMode(sessionId,"split-pending");
try{rightbarDragLock.setLocked(true);}catch{/* 锁定失败不阻断公开 split；同步会继续重估。 */}
try{
transaction.deadlineTimer=globalThis.setTimeout(()=>{
if(transactionOf(token)!==null){
try{frame.target.cancelSidebarSplit(token,{reason:"deadline"});}catch{/* deadline 仍须保持有界。 */}
}
},SIDEBAR_SPLIT_TRANSACTION_TIMEOUT_MS);
}catch{
frame.target.cancelSidebarSplit(token,{reason:"deadline-unavailable"});
return null;
}
return{token};
};
const markSidebarSplitPane=(token,paneId)=>{
const transaction=transactionOf(token);
if(transaction===null||typeof paneId!=="string"||paneId.trim()==="")return false;
transaction.paneId=paneId;
return true;
};
const markSidebarSplitOpen=(token)=>{
const transaction=transactionOf(token);
if(transaction===null||transaction.paneId===null)return false;
transaction.resourceIssued=true;
return true;
};
const commitSidebarSplit=(token,evidence)=>{
const transaction=transactionOf(token);
const observed=evidence!==null&&typeof evidence==="object"?evidence:{};
if(transaction===null
||transaction.resourceIssued!==true
||transaction.paneId===null
||text(observed.paneId,null)!==transaction.paneId
||text(observed.tabId,null)===null)return false;
clearSidebarSplitDeadline(transaction);
releaseSidebarSplitTransaction(transaction);
let current=null;
try{current=currentSurfaceSessionIdOf();}catch{current=null;}
if(current!==transaction.sessionId){
clearRightbarWidthMarks(transaction.sessionId);
return true;
}
claimRightbarWidthOwnership(transaction.sessionId);
clearRightbarWidthMarks(transaction.sessionId);
setWidthMode(transaction.sessionId,"other");
try{rightbarDragLock.setLocked(false);}catch{/* 提交后的手柄必须可调，失败由后续同步重试。 */}
return true;
};
function cancelSidebarSplit(token,details){
const transaction=transactionOf(token);
if(transaction===null)return false;
clearSidebarSplitDeadline(transaction);
releaseSidebarSplitTransaction(transaction);
const current=currentSurfaceSessionIdOf();
if(current!==transaction.sessionId){
if(current===null){
const restored=applyRightbarWidth(transaction.sessionId,resolveExpertRightbarWidthRatio(),true);
claimRightbarWidthOwnership(transaction.sessionId);
setWidthPrepared(transaction.sessionId,restored===true);
setWidthActive(transaction.sessionId,restored===true);
setWidthMode(transaction.sessionId,restored===true?"expert":null);
try{rightbarDragLock.setLocked(false);}catch{/* 后续同步重估。 */}
return true;
}
clearRightbarWidthMarks(transaction.sessionId);
return true;
}
let activeEvidence="unknown";
try{activeEvidence=activeTabEvidenceOf(transaction.sessionId);}catch{activeEvidence="unknown";}
let composition="unknown";
try{composition=rightbarCompositionEvidenceOf(transaction.sessionId,activeEvidence);}catch{composition="unknown";}
if(composition==="other"){
claimRightbarWidthOwnership(transaction.sessionId);
clearRightbarWidthMarks(transaction.sessionId);
setWidthMode(transaction.sessionId,"other");
try{rightbarDragLock.setLocked(false);}catch{/* 后续同步仍会重估。 */}
return true;
}
const shouldRestoreExpert=transaction.previousMode==="expert"||composition==="confirmed";
if(shouldRestoreExpert){
const restored=applyRightbarWidth(transaction.sessionId,resolveExpertRightbarWidthRatio(),true);
setWidthPrepared(transaction.sessionId,restored===true);
setWidthActive(transaction.sessionId,restored===true);
setWidthMode(transaction.sessionId,restored===true?"expert":null);
try{rightbarDragLock.setLocked(false);}catch{/* 后续同步重估。 */}
}else{
setWidthPrepared(transaction.sessionId,false);
setWidthActive(transaction.sessionId,transaction.previousActive===true);
setWidthMode(transaction.sessionId,transaction.previousMode==="other"?"other":null);
try{rightbarDragLock.setLocked(false);}catch{/* 后续同步重估。 */}
}
return true;
}
return Object.freeze({
beginSidebarSplit,
cancelSidebarSplit,
isActiveOnlySplitCompatible,
commitSidebarSplit,
markSidebarSplitOpen,
markSidebarSplitPane,
});
}
global[SYMBOL]=Object.freeze({createSidebarInstallTarget,createSidebarSplitTransactions});
})(globalThis);
/* source: client-sidebar-install-resources.js */
(function installSidebarInstallResources(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-resources");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{object,resolveExpertRightbarWidthRatio}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{createBrandIcon,viewportWidthOf}=DOM;
const LAYOUT_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-layout");
const INSTALL_LAYOUT=global[LAYOUT_SYMBOL]||{};
const{createSidebarInstallLayout}=INSTALL_LAYOUT;
const WIDTH_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-width");
const INSTALL_WIDTH=global[WIDTH_SYMBOL]||{};
const{createRightbarWidthWriter,createWidthBookkeeping}=INSTALL_WIDTH;
const EXPAND_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-expand");
const INSTALL_EXPAND=global[EXPAND_SYMBOL]||{};
const{createRightbarComposition,createRightbarExpand,createSurfaceOpen}=INSTALL_EXPAND;
const TARGET_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-target");
const INSTALL_TARGET=global[TARGET_SYMBOL]||{};
const{createSidebarInstallTarget,createSidebarSplitTransactions}=INSTALL_TARGET;
function createSidebarInstallCoordinator(ctx,deps,host){
const config={...object(deps),ctx};
if(config.taskManagementEnabled===false)return()=>{};
const optionalService=(name)=>{
try{
const value=typeof ctx?.get==="function"?ctx.get(name):null;
if(value)return value;
}catch{/* 服务未安装。 */}
try{return ctx?.[name]||null;}catch{return null;}
};
const brandReact=typeof config.react?.createElement==="function"?config.react:null;
const brandIcon=createBrandIcon(brandReact,object(config.primitives));
const frame={
better:config.betterSidebar||optionalService("betterSidebar"),
brandIcon,
brandReact,
config,
ctx,
disposed:false,
nativeSidebar:config.sidebarRight||optionalService("sidebarRight"),
optionalService,
sessions:config.sessions||optionalService("sessions"),
slots:config.slots||optionalService("slots"),
tabs:config.sidebarRightTabs||optionalService("sidebarRightTabs"),
};
const disposers=[];
frame.layout=createSidebarInstallLayout(frame);
frame.width={...createWidthBookkeeping(frame),...createRightbarWidthWriter(frame)};
frame.expand={
...createRightbarExpand(frame),
...createRightbarComposition(frame),
...createSurfaceOpen(frame),
};
frame.target={...createSidebarInstallTarget(frame),...createSidebarSplitTransactions(frame)};
const{
cancelAllRightbarExpands,cancelAllSurfaceOpens,
}=frame.expand;
const{
cancelAllSidebarSplits,applyRightbarWidthRatio,
}=frame.width;
const{
beginSidebarSplit,cancelSidebarSplit,commitSidebarSplit,markSidebarSplitOpen,markSidebarSplitPane,
}=frame.target;
const{
continuityOverlay,flushInstantRestore,releaseRightbarDragLock,releaseTransitionRestore,
requestRightbarDragSync,rightbarDragLock,splitTrackRatio,surfaceRecords,
}=frame.layout;
const panel=host.createExpertGroupPanel({
...config,
syncRightbarDragLock:requestRightbarDragSync,
releaseRightbarDragLock,
beginSidebarSplit,
markSidebarSplitPane,
markSidebarSplitOpen,
commitSidebarSplit,
cancelSidebarSplit,
readRightbarWidthRatio:resolveExpertRightbarWidthRatio,
applyRightbarWidthRatio,
});
const unsubscribe=frame.sessions===null||frame.sessions===undefined
?null
:DOM.subscribeSessions({...config,sessions:frame.sessions},ctx,frame.target.openTargets);
disposers.push(typeof unsubscribe==="function"?unsubscribe:()=>{});
if(frame.better){
if(typeof frame.better.registerTab==="function"){
const release=frame.better.registerTab({
id:"expert-group",
title:"expert group",
single:true,
component:panel,
...(brandIcon===null?{}:{icon:(size)=>brandReact.createElement(brandIcon,{size})}),
});
if(typeof release==="function")disposers.push(release);
}
if(typeof frame.better.subscribeState==="function"){
try{
const unsubscribeState=frame.better.subscribeState(frame.target.openTargets);
if(typeof unsubscribeState==="function")disposers.push(unsubscribeState);
}catch{/* 旧版 Better Sidebar 没有设置订阅时仍可初次打开。 */}
}
frame.target.openTargets();
}else{
if(typeof frame.tabs?.register==="function"){
const release=frame.tabs.register({
id:"dsh-expert-group",
kind:"expert-group",
keepMounted:true,
title:()=>"expert group",
guide:[{
order:40,
title:()=>"expert group",
description:()=>"查看当前会话的专家任务树",
...(brandIcon===null?{}:{icon:brandIcon}),
}],
});
if(typeof release==="function")disposers.push(release);
}
if(typeof frame.slots?.register==="function"){
const release=frame.slots.register({name:"sidebar.right.pane.tab",key:"dsh-expert-group"},panel);
if(typeof release==="function")disposers.push(release);
}
frame.target.openTargets();
}
let lastObservedViewportWidth=viewportWidthOf();
const onViewportResize=()=>{
if(frame.disposed)return;
const viewportWidth=viewportWidthOf();
if(viewportWidth===null)return;
if(lastObservedViewportWidth===viewportWidth)return;
lastObservedViewportWidth=viewportWidth;
requestRightbarDragSync();
};
try{
const viewportTarget=globalThis.window??null;
if(typeof viewportTarget?.addEventListener==="function"
&&typeof viewportTarget?.removeEventListener==="function"){
viewportTarget.addEventListener("resize",onViewportResize);
disposers.push(()=>{
try{viewportTarget.removeEventListener("resize",onViewportResize);}catch{/* 注销抛错的宿主只能放弃这条监听。 */}
});
}
}catch{/* 没有 window 或代理读取抛错：只靠既有 observer 与 2.5 秒轮询兜底。 */}
frame.layout.setSplitTrackReader({
readTarget(doc){
let sessionId=null;
try{sessionId=frame.target.currentSurfaceSessionId();}catch{sessionId=null;}
if(typeof sessionId!=="string"||sessionId==="")return null;
const tabSets=DOM.sidebarTabSetsForSession(frame.expand.readSurfaceOpenTabs(),sessionId);
if(tabSets===null)return null;
const panel=DOM.rightbarPanelForSession(doc,sessionId);
if(panel===null)return null;
const container=DOM.resolveSplitContainer(panel,tabSets);
if(container!==null)return{status:"target",container};
const candidates=DOM.splitPairPendingContainers(panel,tabSets);
if(candidates.length===1)return{status:"pending",container:candidates[0]};
return null;
},
});
try{frame.layout.requestSplitTrackSync();}catch{/* 配比只是布局微调，绝不影响 install。 */}
const disposeAll=()=>{
if(frame.disposed)return;
frame.disposed=true;
cancelAllSidebarSplits("dispose");
cancelAllRightbarExpands();
cancelAllSurfaceOpens();
flushInstantRestore();
for(const record of surfaceRecords.values())releaseTransitionRestore(record);
continuityOverlay.release();
rightbarDragLock.dispose();
splitTrackRatio.dispose();
frame.layout.clearWidthState();
for(let index=disposers.length-1;index>=0;index-=1){
try{disposers[index]();}catch{/* 一个 disposer 失败不能阻止其它所有权释放。 */}
}
};
return disposeAll;
}
global[SYMBOL]=Object.freeze({createSidebarInstallCoordinator});
})(globalThis);
/* source: client-sidebar-panel-hooks-state.js */
(function installSidebarPanelHooksState(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-state");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
RIGHTBAR_WIDTH_RATIO,RIGHTBAR_WIDTH_RATIO_MAX,RIGHTBAR_WIDTH_RATIO_MIN,clampRightbarWidthRatio,normalizeHostMeta,normalizeSessionModelView,
object,sessionModelOrchestratorOf,sessionModelRowKeysOf,snapshotHasUsageFact,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
getOpenSession,methodOf,viewportWidthOf,
}=DOM;
const POLL_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-poll");
const POLL=global[POLL_SYMBOL]||{};
const{
callRpc,
}=POLL;
const SPLIT_SYNC_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-split-sync");
const SPLIT_SYNC=global[SPLIT_SYNC_SYMBOL]||{};
const PANEL_STATE_A_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
const PANEL_STATE_A=global[PANEL_STATE_A_SYMBOL]||{};
const PANEL_STATE_B_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-b");
const PANEL_STATE_B=global[PANEL_STATE_B_SYMBOL]||{};
function useSidebarPanelStateCore(frame){
const{
initialStateFor,react,rootSessionId,
}=frame;
const statePair=typeof react.useState==="function"
?react.useState(()=>initialStateFor(rootSessionId))
:[initialStateFor(rootSessionId),()=>{}];
const state=statePair[0];
const setState=statePair[1];
const viewState=state.rootSessionId===rootSessionId?state:initialStateFor(rootSessionId);
const versionPair=typeof react.useState==="function"?react.useState(0):[0,()=>{}];
const version=versionPair[0];
const bump=versionPair[1];
const autoOpenDraftPair=typeof react.useState==="function"?react.useState(null):[null,()=>{}];
const autoOpenDraft=autoOpenDraftPair[0];
const setAutoOpenDraft=autoOpenDraftPair[1];
const emptyFilter=PANEL_STATE_A.EMPTY_TASK_FILTER;
const filterPair=typeof react.useState==="function"
?react.useState(emptyFilter)
:[emptyFilter,()=>{}];
const filterState=filterPair[0]!==null&&typeof filterPair[0]==="object"?filterPair[0]:emptyFilter;
const setFilterState=filterPair[1];
const timelineExpandedRef=typeof react.useRef==="function"?react.useRef(new Set()):{current:new Set()};
const metaPair=typeof react.useState==="function"?react.useState(null):[null,()=>{}];
const meta=metaPair[0];
const setMeta=metaPair[1];
const metaStateRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
metaStateRef.current=meta;
const sessionModelOpenPair=typeof react.useState==="function"?react.useState(false):[false,()=>{}];
const sessionModelOpen=sessionModelOpenPair[0];
const setSessionModelOpen=sessionModelOpenPair[1];
const sessionModelStatePair=typeof react.useState==="function"
?react.useState({status:"idle",overrides:{},revision:0,live:false})
:[{status:"idle",overrides:{},revision:0,live:false},()=>{}];
const sessionModelState=sessionModelStatePair[0];
const setSessionModelState=sessionModelStatePair[1];
const sessionModelDraftsPair=typeof react.useState==="function"?react.useState({}):[{},()=>{}];
const sessionModelDrafts=sessionModelDraftsPair[0];
const setSessionModelDrafts=sessionModelDraftsPair[1];
const sessionModelSavingPair=typeof react.useState==="function"?react.useState(false):[false,()=>{}];
const sessionModelSaving=sessionModelSavingPair[0];
const setSessionModelSaving=sessionModelSavingPair[1];
const sessionModelNoticePair=typeof react.useState==="function"?react.useState(null):[null,()=>{}];
const sessionModelNotice=sessionModelNoticePair[0];
const setSessionModelNotice=sessionModelNoticePair[1];
const sessionModelReloadPair=typeof react.useState==="function"?react.useState(0):[0,()=>{}];
const sessionModelReloadToken=sessionModelReloadPair[0];
const setSessionModelReloadToken=sessionModelReloadPair[1];
const sessionModelRequestSerialRef=typeof react.useRef==="function"?react.useRef(0):{current:0};
const sessionModelLoadedRootRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sessionModelCatalogPair=typeof react.useState==="function"
?react.useState({groups:[],status:"idle"})
:[{groups:[],status:"idle"},()=>{}];
const sessionModelCatalog=sessionModelCatalogPair[0];
const setSessionModelCatalog=sessionModelCatalogPair[1];
const sessionModelEntryRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sessionModelWasOpenRef=typeof react.useRef==="function"?react.useRef(false):{current:false};
const sessionModelDialogRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sessionModelSurfaceRef=typeof react.useRef==="function"
?react.useRef({rootSessionId:null,sidebarSessionId:null})
:{current:{rootSessionId:null,sidebarSessionId:null}};
const announcerRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const announcementPair=typeof react.useState==="function"?react.useState(""):["",()=>{}];
const announcement=announcementPair[0];
const setAnnouncement=announcementPair[1];
Object.assign(frame,{
announcement,announcerRef,autoOpenDraft,bump,
emptyFilter,filterState,meta,metaStateRef,
sessionModelCatalog,sessionModelDialogRef,sessionModelDrafts,sessionModelEntryRef,
sessionModelLoadedRootRef,sessionModelNotice,sessionModelOpen,
sessionModelReloadToken,sessionModelRequestSerialRef,sessionModelSaving,sessionModelState,
sessionModelSurfaceRef,sessionModelWasOpenRef,setAnnouncement,setAutoOpenDraft,setFilterState,setMeta,
setSessionModelCatalog,setSessionModelDrafts,setSessionModelNotice,setSessionModelOpen,
setSessionModelReloadToken,setSessionModelSaving,
setSessionModelState,setState,state,timelineExpandedRef,version,
viewState,
});
}
function useSidebarPanelWidth(frame){
const{
config,react,
}=frame;
const readWidthRatio=typeof config.readRightbarWidthRatio==="function"?config.readRightbarWidthRatio:null;
const applyWidthRatio=typeof config.applyRightbarWidthRatio==="function"?config.applyRightbarWidthRatio:null;
const widthRatioPair=typeof react.useState==="function"
?react.useState(()=>{
const stored=readWidthRatio===null?null:clampRightbarWidthRatio(readWidthRatio());
return stored===null?RIGHTBAR_WIDTH_RATIO:stored;
})
:[RIGHTBAR_WIDTH_RATIO,()=>{}];
const widthRatio=widthRatioPair[0];
const setWidthRatio=widthRatioPair[1];
const widthDragRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const commitWidthRatio=(value,options={})=>{
const clamped=clampRightbarWidthRatio(value);
if(clamped===null)return null;
setWidthRatio(clamped);
if(applyWidthRatio!==null){
try{applyWidthRatio(clamped,{persist:options.persist===true});}catch{/* 见上。 */}
}
return clamped;
};
const widthDragHost=()=>{
try{return globalThis.window??globalThis;}catch{return null;}
};
const detachWidthDrag=(drag)=>{
const host=widthDragHost();
if(host===null||drag===null)return;
try{
host.removeEventListener?.("pointermove",drag.onMove);
host.removeEventListener?.("pointerup",drag.onEnd);
host.removeEventListener?.("pointercancel",drag.onEnd);
host.removeEventListener?.("mousemove",drag.onMove);
host.removeEventListener?.("mouseup",drag.onEnd);
}catch{/* 移除失败不阻断松手收口。 */}
};
const endWidthDrag=()=>{
const drag=widthDragRef.current;
if(drag===null)return;
widthDragRef.current=null;
detachWidthDrag(drag);
commitWidthRatio(drag.lastRatio,{persist:true});
};
const onWidthDragMove=(event)=>{
const drag=widthDragRef.current;
if(drag===null)return;
const clientX=Number(event?.clientX);
if(Number.isFinite(clientX)!==true)return;
event?.preventDefault?.();
const next=PANEL_STATE_A.nextWidthRatioFromDrag({
startX:drag.startX,
startRatio:drag.startRatio,
clientX,
viewport:viewportWidthOf(),
});
if(next===null)return;
drag.lastRatio=next;
commitWidthRatio(next,{persist:false});
};
const onWidthDragStart=(event)=>{
if(applyWidthRatio===null)return;
event?.preventDefault?.();
event?.stopPropagation?.();
const clientX=Number(event?.clientX);
if(Number.isFinite(clientX)!==true)return;
endWidthDrag();
const startRatio=clampRightbarWidthRatio(widthRatio)??RIGHTBAR_WIDTH_RATIO;
const drag={
startX:clientX,
startRatio,
lastRatio:startRatio,
onMove:null,
onEnd:null,
};
drag.onMove=(moveEvent)=>onWidthDragMove(moveEvent);
drag.onEnd=()=>endWidthDrag();
const host=widthDragHost();
try{
host?.addEventListener?.("pointermove",drag.onMove);
host?.addEventListener?.("pointerup",drag.onEnd);
host?.addEventListener?.("pointercancel",drag.onEnd);
host?.addEventListener?.("mousemove",drag.onMove);
host?.addEventListener?.("mouseup",drag.onEnd);
}catch{/* 监听装不上时手柄仍可用键盘调整。 */}
widthDragRef.current=drag;
};
const onWidthResizerKeyDown=(event)=>{
const key=event?.key;
if(key!=="ArrowLeft"&&key!=="ArrowRight"&&key!=="Home"&&key!=="End")return;
event?.preventDefault?.();
event?.stopPropagation?.();
const next=PANEL_STATE_A.nextWidthRatioFromKey(key,widthRatio);
if(next===null)return;
commitWidthRatio(next,{persist:true});
};
const widthResizer=applyWidthRatio===null
?null
:react.createElement("div",{
className:"deg_expert_group_resizer",
role:"separator",
"aria-orientation":"vertical",
"aria-label":"调整右栏宽度",
"aria-valuemin":Math.round(RIGHTBAR_WIDTH_RATIO_MIN*100),
"aria-valuemax":Math.round(RIGHTBAR_WIDTH_RATIO_MAX*100),
"aria-valuenow":Math.round(widthRatio*100),
"data-dragging":widthDragRef.current!==null?"true":undefined,
tabIndex:0,
onPointerDown:onWidthDragStart,
onMouseDown:onWidthDragStart,
onKeyDown:onWidthResizerKeyDown,
});
Object.assign(frame,{widthResizer});
}
function useSidebarPanelStoreAndMeta(frame){
const{
config,ctx,model,react,rootSessionId,setMeta,
sidebarSessionId,
}=frame;
const createStore=()=>typeof model.createExpansionStore==="function"
?model.createExpansionStore({storage:config.storage,rootSessionId})
:null;
const store=typeof react.useMemo==="function"
?react.useMemo(createStore,[config.storage,rootSessionId])
:createStore();
const mountedRef=typeof react.useRef==="function"?react.useRef(true):{current:true};
const requestSequenceRef=typeof react.useRef==="function"?react.useRef(0):{current:0};
const contextRef=typeof react.useRef==="function"?react.useRef(ctx):{current:ctx};
contextRef.current=ctx;
const currentRootRef=typeof react.useRef==="function"?react.useRef(rootSessionId):{current:rootSessionId};
currentRootRef.current=rootSessionId;
const currentSidebarSessionRef=typeof react.useRef==="function"?react.useRef(sidebarSessionId):{current:sidebarSessionId};
currentSidebarSessionRef.current=sidebarSessionId;
const metaRequestRef=typeof react.useRef==="function"?react.useRef({inFlight:false,promise:null}):{current:{inFlight:false,promise:null}};
const metaAutoAttemptRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const metaRefreshRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const loadMeta=async()=>{
if(mountedRef.current!==true)return null;
const request=metaRequestRef.current;
if(request.inFlight===true){
return typeof request.promise?.then==="function"?request.promise:null;
}
request.inFlight=true;
const pending=(async()=>{
try{
const body=await callRpc(config,contextRef.current,{action:"meta"},{},(value)=>object(value));
if(mountedRef.current!==true)return null;
const normalized=normalizeHostMeta(body);
setMeta(normalized);
return normalized;
}catch{
return null;
}finally{
request.inFlight=false;
request.promise=null;
}
})();
request.promise=pending;
return pending;
};
metaRefreshRef.current=loadMeta;
Object.assign(frame,{
contextRef,currentRootRef,currentSidebarSessionRef,loadMeta,metaAutoAttemptRef,
metaRefreshRef,mountedRef,requestSequenceRef,store,
});
}
async function restoreSessionModelDefaultsOf(deps){
const{
applySessionModelView,config,contextRef,metaStateRef,rootSessionId,sessionModelState,
sessionModelWriteReady,setSessionModelDrafts,setSessionModelNotice,setSessionModelSaving,
settleSessionModelFailure,sidebarSurfaceStillCurrent,t,
}=deps;
if(sessionModelWriteReady()!==true)return;
const rolesToClear=Object.keys(object(sessionModelState.overrides));
if(rolesToClear.length===0){
setSessionModelDrafts({});
return;
}
const targetSessionId=rootSessionId;
const roles=sessionModelRowKeysOf(metaStateRef.current);
setSessionModelSaving(true);
setSessionModelNotice(null);
let revision=sessionModelState.revision;
try{
for(const role of rolesToClear){
const body=await callRpc(
config,
contextRef.current,
{action:"session-override-clear",sessionId:targetSessionId,role,expectedRevision:revision},
{},
(value)=>object(value),
);
if(sidebarSurfaceStillCurrent()!==true)return;
const view=normalizeSessionModelView(body,roles);
if(view===null){
setSessionModelNotice({kind:"error",role,text:t("sidebar.sessionModel.unavailable")});
return;
}
revision=view.revision;
applySessionModelView(view,role);
}
if(sidebarSurfaceStillCurrent()!==true)return;
setSessionModelDrafts({});
setSessionModelNotice({kind:"cleared",revision});
}catch(error){
if(sidebarSurfaceStillCurrent()!==true)return;
settleSessionModelFailure(error,null);
}finally{
if(sidebarSurfaceStillCurrent()===true)setSessionModelSaving(false);
}
}
function sessionModelBaselineOfFrame(sessionModelState,meta,role){
return PANEL_STATE_B.sessionModelBaselineOf(sessionModelState.overrides,meta?.roleDefaults,role,
sessionModelOrchestratorOf(sessionModelState.orchestrator,meta).selection);
}
function useSidebarPanelSessionModel(frame){
const{
config,contextRef,metaStateRef,mountedRef,rootSessionId,sessionModelCatalog,
sessionModelDrafts,sessionModelSaving,sessionModelState,setSessionModelDrafts,setSessionModelNotice,
setSessionModelReloadToken,setSessionModelSaving,setSessionModelState,sidebarSessionId,t,
}=frame;
const sidebarSurfaceStillCurrent=(...args)=>frame.late.sidebarSurfaceStillCurrent(...args);
const updateSessionModelDraft=(role,field,value)=>{
setSessionModelDrafts((previous)=>PANEL_STATE_B.nextSessionModelDrafts({
previous,
role,
field,
value,
baseline:sessionModelBaselineOfFrame(sessionModelState,metaStateRef.current,role),
groups:sessionModelCatalog.groups,
}));
setSessionModelNotice(null);
};
const sessionModelPendingChanges=()=>PANEL_STATE_B.sessionModelPendingChangesOf({
drafts:sessionModelDrafts,
meta:metaStateRef.current,
baselineOf:(role)=>sessionModelBaselineOfFrame(sessionModelState,metaStateRef.current,role),
});
const sessionModelHasInvalidDraft=()=>PANEL_STATE_B.sessionModelHasInvalidDraftOf({
drafts:sessionModelDrafts,
meta:metaStateRef.current,
});
const applySessionModelView=(view,role)=>{
setSessionModelState((previous)=>({...previous,status:"ready",overrides:view.overrides,revision:view.revision,live:view.live}));
setSessionModelDrafts((previous)=>PANEL_STATE_B.withoutRoleDraft(previous,role));
if(role==="orchestrator")setTimeout(()=>setSessionModelReloadToken((value)=>value+1),800);
};
const settleSessionModelFailure=(error,role)=>{
const roles=sessionModelRowKeysOf(metaStateRef.current);
const outcome=PANEL_STATE_B.describeSessionModelFailure({error,role,roles,t});
if(outcome.statePatch!==null){
const patch=outcome.statePatch;
setSessionModelState((previous)=>({
...previous,
status:"ready",
revision:patch.revision===null?previous.revision:patch.revision,
overrides:patch.overrides===null?previous.overrides:patch.overrides,
}));
}
setSessionModelNotice(outcome.notice);
};
const sessionModelWriteReady=()=>PANEL_STATE_B.sessionModelWriteReadyOf({
mounted:mountedRef.current,
state:sessionModelState,
saving:sessionModelSaving,
rootSessionId,
sidebarSessionId,
});
const commitSessionModelChanges=async()=>{
if(sessionModelWriteReady()!==true)return;
if(sessionModelHasInvalidDraft())return;
const changes=sessionModelPendingChanges();
if(changes.length===0)return;
const targetSessionId=rootSessionId;
const roles=sessionModelRowKeysOf(metaStateRef.current);
setSessionModelSaving(true);
setSessionModelNotice(null);
let revision=sessionModelState.revision;
try{
for(const change of changes){
const body=await callRpc(
config,
contextRef.current,
{
action:"session-override-set",
sessionId:targetSessionId,
role:change.role,
expectedRevision:revision,
selection:change.selection,
},
{},
(value)=>object(value),
);
if(sidebarSurfaceStillCurrent()!==true)return;
const view=normalizeSessionModelView(body,roles);
if(view===null){
setSessionModelNotice({kind:"error",role:change.role,text:t("sidebar.sessionModel.unavailable")});
return;
}
revision=view.revision;
applySessionModelView(view,change.role);
}
if(sidebarSurfaceStillCurrent()!==true)return;
setSessionModelNotice({
kind:"saved",
...(changes.some((change)=>change.role==="orchestrator")
?{text:t("sidebar.sessionModel.orchestrator.saved")}
:{}),
revision,
});
}catch(error){
if(sidebarSurfaceStillCurrent()!==true)return;
settleSessionModelFailure(error,changes[changes.length-1]?.role??null);
}finally{
if(sidebarSurfaceStillCurrent()===true)setSessionModelSaving(false);
}
};
const clearSessionModelRole=async(role)=>{
if(sessionModelWriteReady()!==true)return;
if(sessionModelState.overrides[role]===undefined)return;
const targetSessionId=rootSessionId;
const roles=sessionModelRowKeysOf(metaStateRef.current);
setSessionModelSaving(true);
setSessionModelNotice(null);
try{
const body=await callRpc(
config,
contextRef.current,
{
action:"session-override-clear",
sessionId:targetSessionId,
role,
expectedRevision:sessionModelState.revision,
},
{},
(value)=>object(value),
);
if(sidebarSurfaceStillCurrent()!==true)return;
const view=normalizeSessionModelView(body,roles);
if(view===null){
setSessionModelNotice({kind:"error",role,text:t("sidebar.sessionModel.unavailable")});
return;
}
applySessionModelView(view,role);
setSessionModelNotice({kind:"cleared",role,revision:view.revision});
}catch(error){
if(sidebarSurfaceStillCurrent()!==true)return;
settleSessionModelFailure(error,role);
}finally{
if(sidebarSurfaceStillCurrent()===true)setSessionModelSaving(false);
}
};
const restoreSessionModelDefaults=()=>restoreSessionModelDefaultsOf({
applySessionModelView,config,contextRef,metaStateRef,rootSessionId,sessionModelState,
sessionModelWriteReady,setSessionModelDrafts,setSessionModelNotice,setSessionModelSaving,
settleSessionModelFailure,sidebarSurfaceStillCurrent,t,
});
Object.assign(frame,{
clearSessionModelRole,commitSessionModelChanges,restoreSessionModelDefaults,
sessionModelHasInvalidDraft,sessionModelPendingChanges,updateSessionModelDraft,
});
}
function useSidebarPanelSessionModelPart2(frame){
const{
currentRootRef,currentSidebarSessionRef,mountedRef,react,rootSessionId,sidebarSessionId,
}=frame;
const surfaceTokenScopeRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const surfaceTokenRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const derivedSurfaceToken=PANEL_STATE_A.deriveSurfaceToken(
surfaceTokenScopeRef.current,
surfaceTokenRef.current,
rootSessionId,
sidebarSessionId,
);
surfaceTokenScopeRef.current=derivedSurfaceToken.scope;
surfaceTokenRef.current=derivedSurfaceToken.token;
const surfaceToken=surfaceTokenRef.current;
const sidebarSurfaceStillCurrent=()=>mountedRef.current===true
&&currentRootRef.current===rootSessionId
&&currentSidebarSessionRef.current===sidebarSessionId
&&surfaceTokenRef.current===surfaceToken;
frame.late.sidebarSurfaceStillCurrent=sidebarSurfaceStillCurrent;
Object.assign(frame,{sidebarSurfaceStillCurrent});
}
function useSidebarPanelHostServices(frame){
const{
clearSidebarAutoManualSuppressions,config,contextRef,rootSessionId,sessionId,
setAutoOpenDraft,sidebarRight,sidebarSessionId,
}=frame;
const navigation=getOpenSession(config,contextRef.current);
const readAutoOpenSetting=typeof config.getAutoOpenSubagentSidebar==="function"
?config.getAutoOpenSubagentSidebar
:null;
const writeAutoOpenSetting=typeof config.setAutoOpenSubagentSidebar==="function"
?config.setAutoOpenSubagentSidebar
:null;
const autoOpenEnabled=()=>{
if(readAutoOpenSetting===null)return false;
try{return readAutoOpenSetting()===true;}catch{return false;}
};
const toggleAutoOpen=(next)=>{
const value=next===true;
if(writeAutoOpenSetting===null)return;
setAutoOpenDraft(value);
void Promise.resolve()
.then(()=>writeAutoOpenSetting(value))
.then(
(accepted)=>{
if(accepted!==true){
setAutoOpenDraft(null);
return;
}
if(value===true){
if(typeof clearSidebarAutoManualSuppressions==="function"){
try{clearSidebarAutoManualSuppressions(sidebarSessionId,rootSessionId);}catch{}
}
frame.late.clearSidebarAutoSuppressionsOfScope?.();
}
},
()=>{setAutoOpenDraft(null);},
);
};
const splitSidebarPane=methodOf(sidebarRight,"split");
const closeSidebarResource=methodOf(sidebarRight,"close");
const readActiveSidebarResource=methodOf(sidebarRight,"active");
const readSidebarOpenTabs=()=>{
let inventory=null;
try{inventory=sidebarRight?.openTabs??null;}catch{return null;}
const getSnapshot=methodOf(inventory,"getSnapshot");
if(getSnapshot===null)return null;
try{
const snapshot=getSnapshot.call(inventory);
return Array.isArray(snapshot)?snapshot:null;
}catch{return null;}
};
const presentSidebarTabIds=()=>SPLIT_SYNC.presentSidebarTabIds(globalThis.document,sidebarSessionId);
const existingSubagentPaneId=()=>SPLIT_SYNC.existingSubagentPaneId(
globalThis.document,
sidebarSessionId,
readSidebarOpenTabs(),
);
const sidebarSplitTargetEvidence=(resourceAddress,expectedPaneId=null)=>SPLIT_SYNC.sidebarSplitTargetEvidence({
doc:globalThis.document,
sidebarSessionId,
inventory:readSidebarOpenTabs(),
resourceAddress,
expectedPaneId,
});
const seededGuideTabId=(beforeTabs,sessionId)=>SPLIT_SYNC.seededGuideTabId(
beforeTabs,
sessionId,
readSidebarOpenTabs(),
);
const waitForSidebarSplitLayoutCommit=SPLIT_SYNC.waitForSidebarSplitLayoutCommit;
Object.assign(frame,{
autoOpenEnabled,closeSidebarResource,existingSubagentPaneId,navigation,presentSidebarTabIds,readActiveSidebarResource,
readSidebarOpenTabs,seededGuideTabId,sidebarSplitTargetEvidence,splitSidebarPane,toggleAutoOpen,
waitForSidebarSplitLayoutCommit,writeAutoOpenSetting,
});
}
function useSidebarPanelSnapshotDerived(frame){
const{
readSidebarOpenTabs,viewState,
}=frame;
const sidebarOpenTabsAvailable=readSidebarOpenTabs()!==null;
const snapshot=viewState.snapshot;
const partialSnapshot=snapshot?.partial===true;
const usageFactPresent=snapshot===null?false:snapshotHasUsageFact(snapshot);
Object.assign(frame,{
partialSnapshot,sidebarOpenTabsAvailable,snapshot,usageFactPresent,
});
}
const PV_MARKER_MS=60000;
const PV_DISABLED=Object.freeze({enabled:false,period:"valley"});
function readPvMarker(config){
let settings=null;
try{settings=config?.getPeakValleySettings?.()??null;}catch{return PV_DISABLED;}
if(settings?.enabled!==true)return PV_DISABLED;
const at=config?.peakValleyTime;
return{
enabled:true,
period:typeof at?.peakValleyAtDate==="function"&&at.peakValleyAtDate(settings.periods,new Date())==="peak"?"peak":"valley",
};
}
function useSidebarPanelPeakValleyMarker(frame){
const{config,react}=frame;
const pair=typeof react.useState==="function"
?react.useState(()=>readPvMarker(config))
:[readPvMarker(config),null];
const marker=pair[0];
const setMarker=pair[1];
const subscribe=config?.subscribePeakValleySettings??null;
const shown=subscribe===null||setMarker===null?readPvMarker(config):marker;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
const refresh=()=>setMarker((previous)=>{
const next=readPvMarker(config);
return previous.enabled===next.enabled&&previous.period===next.period?previous:next;
});
let release=null;
try{release=subscribe===null?null:subscribe(refresh);}catch{}
const timer=shown.enabled===true?globalThis.setInterval(refresh,PV_MARKER_MS):null;
return()=>{
if(typeof release==="function")release();
if(timer!==null)globalThis.clearInterval(timer);
};
},[subscribe,shown.enabled,config]);
}
Object.assign(frame,{peakValleyMarker:shown});
}
global[SYMBOL]=Object.freeze({
useSidebarPanelHostServices,useSidebarPanelPeakValleyMarker,useSidebarPanelSessionModel,useSidebarPanelSessionModelPart2,
useSidebarPanelSnapshotDerived,useSidebarPanelStateCore,useSidebarPanelStoreAndMeta,
useSidebarPanelWidth,
});
})(globalThis);
/* source: client-sidebar-panel-hooks-effects.js */
(function installSidebarPanelHooksEffects(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-effects");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
ANNOUNCEMENT_MAX_ITEMS,collectAnnouncementTasks,collectSnapshotSessionIds,normalizeSessionModelView,object,safeNormalize,
sessionModelRowKeysOf,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
methodOf,subscribeSessions,
}=DOM;
const POLL_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-poll");
const POLL=global[POLL_SYMBOL]||{};
const{
PANEL_ERROR_SOURCES,PANEL_POLL_TIMINGS,applyPanelPollCycle,callRpc,fanoutBatchIsStale,panelNextPollDelayMs,
readFanoutEventBatch,samePanelSnapshot,snapshotHasRunningWork,
}=POLL;
const PANEL_STATE_A_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
const PANEL_STATE_A=global[PANEL_STATE_A_SYMBOL]||{};
function useSidebarPanelAnnouncementEffect(frame){
const{
announcerRef,panelLocale,react,rootSessionId,setAnnouncement,state,
t,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(state.snapshot===null)return;
const tasks=collectAnnouncementTasks(state.snapshot);
const update=PANEL_STATE_A.nextAnnouncementBaseline(announcerRef.current,rootSessionId,tasks);
announcerRef.current=update.baseline;
if(update.events.length===0)return;
setAnnouncement(PANEL_STATE_A.announcementTextOf({
events:update.events,
t,
locale:panelLocale,
maxItems:ANNOUNCEMENT_MAX_ITEMS,
}));
},[state.snapshot,rootSessionId]);
}
}
async function readOrchestratorStatusOf(config,contextRef,sessionId){
try{
const body=await callRpc(config,contextRef.current,{action:"get",sessionId},{},(value)=>object(value));
const status=object(object(body).orchestrator);
return Object.keys(status).length===0?null:status;
}catch{
return null;
}
}
function useSidebarPanelSessionModelEffects(frame){
const{
config,contextRef,loadMeta,metaStateRef,mountedRef,react,
rootSessionId,sessionModelDialogRef,sessionModelEntryRef,sessionModelLoadedRootRef,sessionModelOpen,sessionModelReloadToken,
sessionModelRequestSerialRef,sessionModelSurfaceRef,sessionModelWasOpenRef,setSessionModelCatalog,setSessionModelDrafts,setSessionModelNotice,
setSessionModelSaving,setSessionModelState,sidebarSessionId,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(sessionModelOpen!==true)return()=>{};
const targetSessionId=rootSessionId;
const previousSurface=sessionModelSurfaceRef.current;
const surfaceChanged=previousSurface.rootSessionId!==rootSessionId
||previousSurface.sidebarSessionId!==sidebarSessionId;
sessionModelSurfaceRef.current={rootSessionId,sidebarSessionId};
if(surfaceChanged===true)setSessionModelSaving(false);
if(sessionModelLoadedRootRef.current!==targetSessionId)setSessionModelNotice(null);
if(targetSessionId===""||sidebarSessionId!==targetSessionId){
sessionModelRequestSerialRef.current+=1;
sessionModelLoadedRootRef.current=null;
setSessionModelDrafts({});
setSessionModelNotice(null);
setSessionModelSaving(false);
setSessionModelState({
status:targetSessionId===""?"no-session":"child",
overrides:{},
revision:0,
live:false,
});
return()=>{};
}
let cancelled=false;
sessionModelRequestSerialRef.current+=1;
const serial=sessionModelRequestSerialRef.current;
setSessionModelState((previous)=>(previous.status==="ready"
?{...previous,status:"loading"}
:{status:"loading",overrides:{},revision:0,live:false}));
void(async()=>{
try{
const pending=config.modelCatalog?.load?.();
if(pending!==null&&pending!==undefined&&typeof pending.catch==="function")pending.catch(()=>{});
}catch{/* 目录加载失败不阻塞覆盖读取：输入框仍可手填。 */}
const loaded=await loadMeta();
if(cancelled===true||serial!==sessionModelRequestSerialRef.current)return;
const effectiveMeta=loaded!==null?loaded:metaStateRef.current;
if(effectiveMeta!==null&&effectiveMeta.capabilities.sessionOverride!==true){
setSessionModelState({status:"unsupported",overrides:{},revision:0,live:false});
return;
}
let body;
try{
body=await callRpc(
config,
contextRef.current,
{action:"session-override-get",sessionId:targetSessionId},
{},
(value)=>object(value),
);
}catch(error){
if(cancelled===true||serial!==sessionModelRequestSerialRef.current)return;
const code=text(object(error).code,null);
setSessionModelState({
status:code==="bad-request"&&effectiveMeta===null?"unsupported":"error",
overrides:{},
revision:0,
live:false,
});
return;
}
if(cancelled===true||serial!==sessionModelRequestSerialRef.current)return;
const roles=sessionModelRowKeysOf(effectiveMeta);
const view=normalizeSessionModelView(body,roles);
if(view===null){
setSessionModelState({status:"error",overrides:{},revision:0,live:false});
return;
}
if(sessionModelLoadedRootRef.current!==targetSessionId)setSessionModelDrafts({});
sessionModelLoadedRootRef.current=targetSessionId;
setSessionModelState({status:"ready",overrides:view.overrides,revision:view.revision,live:view.live});
const orchestratorStatus=await readOrchestratorStatusOf(config,contextRef,targetSessionId);
if(cancelled===true||serial!==sessionModelRequestSerialRef.current)return;
setSessionModelState((previous)=>({...previous,orchestrator:orchestratorStatus}));
})();
return()=>{cancelled=true;};
},[sessionModelOpen,rootSessionId,sidebarSessionId,sessionModelReloadToken,config]);
}
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(sessionModelOpen!==true)return()=>{};
const catalog=config.modelCatalog;
if(catalog===null||catalog===undefined||typeof catalog!=="object")return()=>{};
const read=()=>{
if(mountedRef.current!==true)return;
try{
const snapshot=typeof catalog.getSnapshot==="function"?catalog.getSnapshot():null;
const source=object(snapshot);
setSessionModelCatalog({
groups:Array.isArray(source.groups)?source.groups:[],
status:text(source.status,"idle"),
});
}catch{
setSessionModelCatalog({groups:[],status:"error"});
}
};
read();
let unsubscribe=null;
try{
if(typeof catalog.subscribe==="function")unsubscribe=catalog.subscribe(read);
}catch{unsubscribe=null;}
return()=>{if(typeof unsubscribe==="function")unsubscribe();};
},[sessionModelOpen,config]);
}
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(sessionModelOpen!==true)return;
const node=sessionModelDialogRef.current;
if(node===null||node===undefined)return;
if(node.open===true)return;
try{
if(typeof node.showModal==="function")node.showModal();
}catch{/* 宿主拒绝 showModal（已打开/非活动文档）时保持当前可见性。 */}
},[sessionModelOpen]);
}
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
const wasOpen=sessionModelWasOpenRef.current===true;
sessionModelWasOpenRef.current=sessionModelOpen===true;
if(wasOpen!==true||sessionModelOpen===true)return;
const entry=sessionModelEntryRef.current;
try{
if(entry!==null&&entry!==undefined&&typeof entry.focus==="function")entry.focus();
}catch{/* 宿主拒绝聚焦时忽略：关闭已经生效，焦点位置不是阻断条件。 */}
},[sessionModelOpen]);
}
}
function useSidebarPanelSnapshotRefs(frame){
const{
react,rootSessionId,state,
}=frame;
const refreshStateRef=typeof react.useRef==="function"
?react.useRef({rootSessionId:null,inFlight:null,pending:false})
:{current:{rootSessionId:null,inFlight:null,pending:false}};
const fanoutCursorRef=typeof react.useRef==="function"
?react.useRef({rootSessionId,cursor:0})
:{current:{rootSessionId,cursor:0}};
fanoutCursorRef.current=PANEL_STATE_A.normalizeFanoutCursor(fanoutCursorRef.current,rootSessionId);
const latestSnapshotRef=typeof react.useRef==="function"
?react.useRef(state.snapshot)
:{current:state.snapshot};
latestSnapshotRef.current=state.snapshot;
const latestPanelErrorRef=typeof react.useRef==="function"
?react.useRef(state.error)
:{current:state.error};
latestPanelErrorRef.current=state.error;
const pollSyncStateRef=typeof react.useRef==="function"
?react.useRef({rootSessionId:null,inFlight:null,pending:false})
:{current:{rootSessionId:null,inFlight:null,pending:false}};
const pollCycleSequenceRef=typeof react.useRef==="function"?react.useRef(0):{current:0};
const adoptFanoutCursorFromSnapshot=(requestRoot,envelope)=>{
const next=PANEL_STATE_A.adoptFanoutCursor(fanoutCursorRef.current,requestRoot,envelope);
if(next===null)return false;
fanoutCursorRef.current=next;
return true;
};
Object.assign(frame,{
adoptFanoutCursorFromSnapshot,fanoutCursorRef,latestPanelErrorRef,latestSnapshotRef,pollCycleSequenceRef,pollSyncStateRef,
refreshStateRef,
});
}
function createPanelRefreshAction(deps){
const{
adoptFanoutCursorFromSnapshot,config,contextRef,mountedRef,peekCachedSnapshot,
refreshStateRef,requestSequenceRef,rootSessionId,setState,writeCachedSnapshot,
}=deps;
return function refresh(refreshOptions){
const commitManualTimestamp=refreshOptions?.manual===true;
const refreshState=refreshStateRef.current;
if(refreshState.rootSessionId!==rootSessionId){
refreshState.inFlight?.controller?.abort?.();
refreshState.inFlight=null;
refreshState.pending=false;
refreshState.rootSessionId=rootSessionId;
}
if(refreshState.inFlight!==null){
refreshState.pending=true;
return refreshState.inFlight.promise.then((outcome)=>(typeof outcome==="object"&&outcome!==null
?{...outcome,merged:true}
:{ok:false,snapshot:null,merged:true}));
}
const requestSequence=++requestSequenceRef.current;
if(rootSessionId===""){
setState({rootSessionId,snapshot:null,updatedAt:null,loading:false,error:null});
return Promise.resolve({ok:true,snapshot:null,skipped:true});
}
const controller=typeof globalThis.AbortController==="function"?new globalThis.AbortController():null;
const request={rootSessionId,requestSequence,controller,promise:null};
refreshState.inFlight=request;
const cachedBaseline=peekCachedSnapshot(rootSessionId);
setState((previous)=>{
if(previous.rootSessionId===rootSessionId){
const nextLoading=previous.snapshot===null;
const keptError=previous.error!==null&&previous.error.source===PANEL_ERROR_SOURCES.action
?previous.error
:null;
if(previous.error===keptError&&previous.loading===nextLoading)return previous;
return{
rootSessionId,
snapshot:previous.snapshot,
updatedAt:previous.updatedAt,
loading:nextLoading,
error:keptError,
};
}
return{
rootSessionId,
snapshot:cachedBaseline===null?null:cachedBaseline.snapshot,
updatedAt:cachedBaseline===null?null:cachedBaseline.updatedAt,
loading:cachedBaseline===null,
error:null,
};
});
const promise=fetchPanelSnapshot({
adoptFanoutCursorFromSnapshot,cachedBaseline,commitManualTimestamp,config,contextRef,controller,
mountedRef,outcomeReason:text(refreshOptions?.reason,"refresh"),refresh,refreshState,request,
requestSequence,requestSequenceRef,rootSessionId,setState,writeCachedSnapshot,
});
request.promise=promise;
return promise;
};
}
async function fetchPanelSnapshot(ctx){
const{
adoptFanoutCursorFromSnapshot,cachedBaseline,commitManualTimestamp,config,contextRef,controller,
mountedRef,outcomeReason,refresh,refreshState,request,requestSequence,requestSequenceRef,
rootSessionId,setState,writeCachedSnapshot,
}=ctx;
let outcome={ok:false,snapshot:null,reason:outcomeReason};
try{
const envelope=await callRpc(
config,
contextRef.current,
{action:"expert-group-snapshot",sessionId:rootSessionId},
controller===null?{}:{signal:controller.signal},
(body)=>object(body),
);
const raw=envelope.snapshot===undefined||envelope.snapshot===null?envelope:envelope.snapshot;
const next=safeNormalize(raw);
if(next===null)throw new Error("快照格式无效");
const current=mountedRef.current===true
&&refreshState.inFlight===request
&&requestSequence===requestSequenceRef.current
&&rootSessionId===request.rootSessionId;
outcome={ok:true,snapshot:next,stale:current!==true,reason:outcome.reason};
if(current){
const updatedAt=Date.now();
writeCachedSnapshot(rootSessionId,next,updatedAt);
adoptFanoutCursorFromSnapshot(rootSessionId,envelope);
setState((previous)=>{
const keptError=previous.error!==null&&previous.error.source===PANEL_ERROR_SOURCES.action
?previous.error
:null;
const sameRevision=typeof previous.snapshot?.revision==="string"
&&typeof next.revision==="string"
&&previous.snapshot.revision.length>0
&&previous.snapshot.revision===next.revision;
if(previous.rootSessionId===rootSessionId
&&previous.loading===false
&&previous.error===keptError
&&(sameRevision||samePanelSnapshot(previous.snapshot,next))
&&(commitManualTimestamp!==true||previous.updatedAt===updatedAt))return previous;
return{rootSessionId,snapshot:next,updatedAt,loading:false,error:keptError};
});
}
}catch(error){
const aborted=controller?.signal?.aborted===true||error?.name==="AbortError";
const current=mountedRef.current===true
&&refreshState.inFlight===request
&&requestSequence===requestSequenceRef.current
&&rootSessionId===request.rootSessionId;
outcome={ok:false,snapshot:null,aborted,stale:current!==true,reason:outcome.reason};
if(!aborted&&current){
const failedAt=Date.now();
setState((previous)=>{
const sameRoot=previous.rootSessionId===rootSessionId;
const baseline=sameRoot
?previous.snapshot
:(cachedBaseline===null?null:cachedBaseline.snapshot);
const message=error instanceof Error?error.message:String(error);
if(sameRoot
&&previous.error!==null
&&previous.error.source===PANEL_ERROR_SOURCES.snapshot
&&previous.error.message===message
&&previous.loading===false
&&previous.snapshot===baseline)return previous;
return{
rootSessionId,
snapshot:baseline,
updatedAt:sameRoot?previous.updatedAt:(cachedBaseline===null?null:cachedBaseline.updatedAt),
loading:false,
error:{source:PANEL_ERROR_SOURCES.snapshot,message,at:failedAt},
};
});
}
}
if(refreshState.inFlight===request){
refreshState.inFlight=null;
if(refreshState.pending&&mountedRef.current===true&&refreshState.rootSessionId===rootSessionId){
refreshState.pending=false;
void refresh();
}else{
refreshState.pending=false;
}
}
return outcome;
}
function createPanelPollCycle(deps){
const{
advanceFanoutCursor,config,contextRef,fanoutCursorRef,latestPanelErrorRef,latestSnapshotRef,
pollCycleSequenceRef,pollSyncStateRef,pollSurfaceStillCurrent,refresh,rootSessionId,
}=deps;
const pollOnce=async(request)=>{
const nextId=()=>{
pollCycleSequenceRef.current+=1;
return pollCycleSequenceRef.current;
};
const cancelledCycle=(outcome)=>({id:nextId(),outcome,ok:false,cancelled:true,snapshot:null});
const partialBaseline=latestSnapshotRef.current!==null&&latestSnapshotRef.current?.partial===true;
const lastSnapshotError=latestPanelErrorRef.current;
const retryAfterFailure=lastSnapshotError!==null
&&lastSnapshotError!==undefined
&&lastSnapshotError.source===PANEL_ERROR_SOURCES.snapshot;
if(partialBaseline||retryAfterFailure){
const full=(await refresh({reason:partialBaseline?"partial":"retry"}))??{};
return{
id:nextId(),
outcome:partialBaseline?"partial":"retry",
ok:full.ok===true,
cancelled:full.aborted===true||full.stale===true,
snapshot:full.snapshot??null,
};
}
const cursorBefore=fanoutCursorRef.current.rootSessionId===rootSessionId?fanoutCursorRef.current.cursor:0;
let batch=null;
try{
const response=await callRpc(
config,
contextRef.current,
{action:"fanout-events",sessionId:rootSessionId,after:cursorBefore},
request.controller===null?{}:{signal:request.controller.signal},
);
batch=readFanoutEventBatch(response);
}catch(error){
const aborted=request.controller?.signal?.aborted===true||error?.name==="AbortError";
if(aborted)return cancelledCycle("cancelled");
batch=null;
}
if(!pollSurfaceStillCurrent())return cancelledCycle("stale");
if(batch!==null&&batch.conclusive){
if(fanoutBatchIsStale(batch,cursorBefore)){
const full=(await refresh({reason:"gap"}))??{};
if(full.ok===true&&full.stale!==true&&full.merged!==true)advanceFanoutCursor(batch.cursor);
return{
id:nextId(),
outcome:"gap",
ok:full.ok===true,
cancelled:full.aborted===true||full.stale===true,
snapshot:full.snapshot??null,
};
}
if(batch.events.length>0){
const full=(await refresh({reason:"events"}))??{};
if(full.ok===true&&full.stale!==true&&full.merged!==true)advanceFanoutCursor(batch.cursor);
return{
id:nextId(),
outcome:"events",
ok:full.ok===true,
cancelled:full.aborted===true||full.stale===true,
snapshot:full.snapshot??null,
};
}
advanceFanoutCursor(batch.cursor);
if(snapshotHasRunningWork(latestSnapshotRef.current)){
const full=(await refresh({reason:"running"}))??{};
return{
id:nextId(),
outcome:"running",
ok:full.ok===true,
cancelled:full.aborted===true||full.stale===true,
snapshot:full.snapshot??null,
};
}
return{id:nextId(),outcome:"none",ok:true,cancelled:false,snapshot:null};
}
const fallback=(await refresh({reason:"events-unavailable"}))??{};
return{
id:nextId(),
outcome:"fallback",
ok:fallback.ok===true,
cancelled:fallback.aborted===true||fallback.stale===true,
snapshot:fallback.snapshot??null,
};
};
const runPollCycle=()=>{
const state=pollSyncStateRef.current;
if(state.rootSessionId!==rootSessionId){
state.inFlight?.controller?.abort?.();
state.inFlight=null;
state.pending=false;
state.rootSessionId=rootSessionId;
}
if(state.inFlight!==null){
state.pending=true;
return state.inFlight.promise;
}
const request={
rootSessionId,
controller:typeof globalThis.AbortController==="function"?new globalThis.AbortController():null,
promise:null,
};
state.inFlight=request;
const promise=(async()=>{
let cycle=null;
try{
cycle=await pollOnce(request);
while(state.pending&&state.inFlight===request&&pollSurfaceStillCurrent()){
state.pending=false;
cycle=await pollOnce(request);
}
}catch{
pollCycleSequenceRef.current+=1;
cycle={id:pollCycleSequenceRef.current,outcome:"error",ok:false,cancelled:false,snapshot:null};
}finally{
if(state.inFlight===request)state.inFlight=null;
state.pending=false;
}
return cycle;
})();
request.promise=promise;
return promise;
};
return{pollOnce,runPollCycle};
}
function useSidebarPanelPolling(frame){
const{
adoptFanoutCursorFromSnapshot,config,contextRef,fanoutCursorRef,latestPanelErrorRef,latestSnapshotRef,
mountedRef,peekCachedSnapshot,pollCycleSequenceRef,pollSyncStateRef,react,refreshStateRef,
requestSequenceRef,rootSessionId,setState,sidebarSurfaceStillCurrent,state,writeCachedSnapshot,
}=frame;
const advanceFanoutCursor=(nextCursor)=>{
const next=PANEL_STATE_A.advanceFanoutCursor(fanoutCursorRef.current,rootSessionId,nextCursor);
if(next===null)return false;
fanoutCursorRef.current=next;
return true;
};
const refresh=createPanelRefreshAction({
adoptFanoutCursorFromSnapshot,config,contextRef,mountedRef,peekCachedSnapshot,refreshStateRef,
requestSequenceRef,rootSessionId,setState,writeCachedSnapshot,
});
const refreshRef=typeof react.useRef==="function"?react.useRef(refresh):{current:refresh};
refreshRef.current=refresh;
const panelSchedulerRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const pollSurfaceStillCurrent=()=>sidebarSurfaceStillCurrent();
const{pollOnce,runPollCycle}=createPanelPollCycle({
advanceFanoutCursor,config,contextRef,fanoutCursorRef,latestPanelErrorRef,latestSnapshotRef,
pollCycleSequenceRef,pollSyncStateRef,pollSurfaceStillCurrent,refresh,rootSessionId,
});
Object.assign(frame,{
advanceFanoutCursor,panelSchedulerRef,pollOnce,pollSurfaceStillCurrent,refresh,refreshRef,
runPollCycle,
});
}
function useSidebarPanelMountEffects(frame){
const{
bump,cancelSidebarSplit,config,contextRef,latestSnapshotRef,mountedRef,
panelSchedulerRef,pollSyncStateRef,react,refresh,refreshStateRef,releaseRightbarDragLock,
requestSequenceRef,rootSessionId,runPollCycle,sidebarRight,sidebarSessionId,sidebarSplitIntentRef,
sidebarTabSyncRef,tabActivityKey,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>runPanelMountEffect({
bump,cancelSidebarSplit,config,contextRef,latestSnapshotRef,mountedRef,panelSchedulerRef,
pollSyncStateRef,refresh,refreshStateRef,releaseRightbarDragLock,requestSequenceRef,rootSessionId,
runPollCycle,sidebarRight,sidebarSessionId,sidebarSplitIntentRef,sidebarTabSyncRef,tabActivityKey,
}),[rootSessionId,sidebarSessionId]);
}
}
function runPanelMountEffect(deps){
const{
bump,cancelSidebarSplit,config,contextRef,latestSnapshotRef,mountedRef,panelSchedulerRef,
pollSyncStateRef,refresh,refreshStateRef,releaseRightbarDragLock,requestSequenceRef,rootSessionId,
runPollCycle,sidebarRight,sidebarSessionId,sidebarSplitIntentRef,sidebarTabSyncRef,tabActivityKey,
}=deps;
mountedRef.current=true;
const refreshState=refreshStateRef.current;
refreshState.rootSessionId=rootSessionId;
refreshState.pending=false;
void refresh();
const unsubscribe=subscribeSessions(config,contextRef.current,()=>{
bump((value)=>value+1);
void refresh();
});
const documentRef=globalThis.document;
const{
scheduler,armScheduler,clearSchedulerTimer,onVisibilityChange,pauseScheduler,pollSurfaceBlocked,resumeScheduler,
}=createPanelPollScheduler({
documentRef,latestSnapshotRef,panelSchedulerRef,refresh,runPollCycle,sidebarTabSyncRef,tabActivityKey,
});
panelSchedulerRef.current=scheduler;
if(pollSurfaceBlocked()!==null)pauseScheduler();
else armScheduler();
try{documentRef?.addEventListener?.("visibilitychange",onVisibilityChange);}catch{/* 可选 API。 */}
sidebarTabSyncRef.current?.();
let unsubscribeOpenTabs=null;
try{
const inventory=sidebarRight?.openTabs??null;
const subscribe=methodOf(inventory,"subscribe");
if(subscribe!==null){
const cleanup=subscribe.call(inventory,()=>{sidebarTabSyncRef.current?.();});
if(typeof cleanup==="function")unsubscribeOpenTabs=cleanup;
}
}catch{/* 旧宿主没有公开 inventory 或订阅失败时继续靠 observer/轮询。 */}
let tabObserver=null;
try{
const doc=globalThis.document;
const Observer=globalThis.MutationObserver??doc?.defaultView?.MutationObserver;
const target=doc?.body??null;
if(typeof Observer==="function"&&target!==null&&target!==undefined){
tabObserver=new Observer(()=>{sidebarTabSyncRef.current?.();});
tabObserver.observe(target,{childList:true,subtree:true});
}
}catch{
try{tabObserver?.disconnect?.();}catch{/* 可选 API。 */}
tabObserver=null;
}
return()=>{
mountedRef.current=false;
try{releaseRightbarDragLock?.();}catch{/* 同上。 */}
const splitIntent=sidebarSplitIntentRef.current;
sidebarSplitIntentRef.current=null;
if(splitIntent!==null&&cancelSidebarSplit!==null){
try{cancelSidebarSplit.call(config,splitIntent.token,{reason:"unmount"});}catch{/* 事务收口失败不能阻断卸载。 */}
}
requestSequenceRef.current+=1;
scheduler.detached=true;
clearSchedulerTimer();
if(panelSchedulerRef.current===scheduler)panelSchedulerRef.current=null;
const pollState=pollSyncStateRef.current;
pollState.pending=false;
pollState.inFlight?.controller?.abort?.();
pollState.inFlight=null;
refreshState.pending=false;
refreshState.inFlight?.controller?.abort?.();
refreshState.inFlight=null;
if(typeof unsubscribe==="function")unsubscribe();
if(typeof unsubscribeOpenTabs==="function")unsubscribeOpenTabs();
try{documentRef?.removeEventListener?.("visibilitychange",onVisibilityChange);}catch{/* 可选 API。 */}
try{tabObserver?.disconnect?.();}catch{/* 可选 API。 */}
};
}
function createPanelPollScheduler(deps){
const{documentRef,latestSnapshotRef,panelSchedulerRef,refresh,runPollCycle,sidebarTabSyncRef,tabActivityKey}=deps;
const scheduler={
timer:null,
delay:PANEL_POLL_TIMINGS.activeMs,
paused:false,
detached:false,
failureCount:0,
idleLevel:0,
running:true,
lastCycleId:0,
activityKey:tabActivityKey,
};
const readDocumentHidden=()=>{
try{return documentRef?.hidden===true;}catch{return false;}
};
const clearSchedulerTimer=()=>{
if(scheduler.timer===null)return;
if(typeof globalThis.clearInterval==="function"){
try{globalThis.clearInterval(scheduler.timer);}catch{/* 清理失败不影响渲染。 */}
}
scheduler.timer=null;
};
const armScheduler=()=>{
clearSchedulerTimer();
if(scheduler.detached===true||scheduler.paused===true)return;
if(typeof globalThis.setInterval!=="function")return;
try{scheduler.timer=globalThis.setInterval(runScheduledPoll,scheduler.delay);}catch{scheduler.timer=null;}
};
const pauseScheduler=()=>{
if(scheduler.paused===true){clearSchedulerTimer();return;}
scheduler.paused=true;
clearSchedulerTimer();
};
const resumeScheduler=(refreshImmediately)=>{
if(scheduler.detached===true)return;
scheduler.paused=false;
scheduler.failureCount=0;
scheduler.idleLevel=0;
scheduler.delay=panelNextPollDelayMs(scheduler);
if(readDocumentHidden()){clearSchedulerTimer();return;}
armScheduler();
if(refreshImmediately===true)void refresh();
};
scheduler.pause=pauseScheduler;
scheduler.resume=resumeScheduler;
const pollSurfaceBlocked=()=>{
if(readDocumentHidden())return"hidden";
if(scheduler.activityKey==="inactive")return"inactive";
return null;
};
const runScheduledPoll=()=>{
sidebarTabSyncRef.current?.();
if(pollSurfaceBlocked()!==null){
pauseScheduler();
return;
}
void runPollCycle().then((cycle)=>{
if(scheduler.detached===true||panelSchedulerRef.current!==scheduler)return;
applyPanelPollCycle(scheduler,cycle,latestSnapshotRef.current);
armScheduler();
});
};
const onVisibilityChange=()=>{
try{
if(documentRef?.hidden!==true){
resumeScheduler(true);
sidebarTabSyncRef.current?.();
}else{
pauseScheduler();
}
}catch{/* 可见性通知只是加速恢复，读取失败不影响轮询。 */}
};
return{
armScheduler,clearSchedulerTimer,onVisibilityChange,pauseScheduler,pollSurfaceBlocked,resumeScheduler,scheduler,
};
}
function useSidebarPanelActivityEffect(frame){
const{
panelSchedulerRef,react,tabActivityKey,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
const scheduler=panelSchedulerRef.current;
if(scheduler===null||scheduler.detached===true)return;
if(scheduler.activityKey===tabActivityKey)return;
scheduler.activityKey=tabActivityKey;
if(tabActivityKey==="inactive"){
scheduler.pause?.();
return;
}
scheduler.resume?.(tabActivityKey==="active");
},[tabActivityKey]);
}
}
const LIVE_TICK_INTERVAL_MS=1000;
function snapshotHasLiveOpenTurn(snapshot){
const pending=[object(snapshot).root];
while(pending.length>0){
const node=pending.pop();
if(node===null||typeof node!=="object")continue;
if(Number.isFinite(node.turnOpenSince)&&(node.running===true||node.status==="running"))return true;
if(Array.isArray(node.children))pending.push(...node.children);
if(Array.isArray(node.shards))pending.push(...node.shards);
}
return false;
}
function useSidebarPanelLiveTick(frame){
const{react,snapshot}=frame;
const tickPair=typeof react.useState==="function"?react.useState(0):[0,()=>{}];
const setTick=tickPair[1];
const liveOpenTurn=snapshotHasLiveOpenTurn(snapshot);
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(liveOpenTurn!==true)return()=>{};
const timer=globalThis.setInterval(()=>setTick((value)=>value+1),LIVE_TICK_INTERVAL_MS);
return()=>globalThis.clearInterval(timer);
},[liveOpenTurn]);
}
}
function useSidebarPanelMetaEffect(frame){
const{
loadMeta,metaAutoAttemptRef,metaStateRef,react,rootSessionId,usageFactPresent,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(usageFactPresent!==true)return;
if(metaStateRef.current!==null)return;
if(metaAutoAttemptRef.current===rootSessionId)return;
metaAutoAttemptRef.current=rootSessionId;
void loadMeta();
},[usageFactPresent,rootSessionId]);
}
}
function useSidebarPanelSnapshotSyncEffect(frame){
const{
react,rootSessionId,sidebarSessionId,sidebarSnapshotSyncRef,sidebarTabSyncRef,snapshot,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
const previous=sidebarSnapshotSyncRef.current;
sidebarSnapshotSyncRef.current={rootSessionId,sidebarSessionId,snapshot};
if(previous.rootSessionId===rootSessionId
&&previous.sidebarSessionId===sidebarSessionId
&&previous.snapshot!==snapshot)sidebarTabSyncRef.current?.();
},[rootSessionId,sidebarSessionId,snapshot]);
}
}
function useSidebarPanelProjectionEffect(frame){
const{
config,ctx,projectionRefreshRequestedRef,react,rootSessionId,sessionId,
sessionStatsPresentOf,snapshot,
}=frame;
if(typeof react.useEffect==="function"){
react.useEffect(()=>{
if(snapshot===null||snapshot===undefined)return;
let service=null;
let refreshProjections=null;
try{
service=config.sessions??ctx?.sessions??null;
refreshProjections=service===null||service===undefined?null:service.refreshProjections;
}catch{
service=null;
refreshProjections=null;
}
if(typeof refreshProjections!=="function")return;
const requested=projectionRefreshRequestedRef.current;
for(const sessionId of collectSnapshotSessionIds(snapshot)){
if(requested.has(sessionId))continue;
if(sessionStatsPresentOf(sessionId)===true)continue;
requested.add(sessionId);
try{
const pending=refreshProjections.call(service,sessionId);
if(pending!==null&&typeof pending==="object"&&typeof pending.catch==="function"){
pending.catch(()=>{});
}
}catch{
}
}
},[snapshot,rootSessionId]);
}
}
global[SYMBOL]=Object.freeze({
useSidebarPanelActivityEffect,useSidebarPanelAnnouncementEffect,useSidebarPanelLiveTick,
useSidebarPanelMetaEffect,useSidebarPanelMountEffects,useSidebarPanelPolling,useSidebarPanelProjectionEffect,
useSidebarPanelSessionModelEffects,useSidebarPanelSnapshotRefs,useSidebarPanelSnapshotSyncEffect,
});
})(globalThis);
/* source: client-sidebar-panel-hooks-tabs.js */
(function installSidebarPanelHooksTabs(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-tabs");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_AUTO_KEY_LIMIT,SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS,SIDEBAR_TAB_KEY_SEPARATOR,SIDEBAR_TAB_ORIGIN_AUTO,object,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
methodOf,normalizeSubagentAddress,sidebarTabCloseKey,sidebarTabKey,
}=DOM;
const TAB_STATE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-tab-state");
const TAB_STATE=global[TAB_STATE_SYMBOL]||{};
const AUTO_CONTROLLER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-controller");
const AUTO_CONTROLLER=global[AUTO_CONTROLLER_SYMBOL]||{};
const SIDEBAR_ACTIONS_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-actions");
const SIDEBAR_ACTIONS=global[SIDEBAR_ACTIONS_SYMBOL]||{};
function clearAutoSuppressionsOfScope(suppressed,sessionId,rootSessionId){
let removed=0;
for(const[key,entry]of suppressed){
if(entry.sessionId!==sessionId||entry.rootSessionId!==rootSessionId)continue;
suppressed.delete(key);
removed+=1;
}
return removed;
}
function useSidebarPanelAutoRefs(frame){
const{
react,sessionId,sharedSidebarAutoCloseAttemptOwners,sharedSidebarAutoCloseAttempts,sharedSidebarAutoCloseCooldowns,sharedSidebarAutoCloseVerifications,
sharedSidebarAutoOrigin,sharedSidebarAutoSuppressed,sharedSidebarAutoTabMisses,
}=frame;
const sidebarTabRecordsRef=typeof react.useRef==="function"?react.useRef(new Map()):{current:new Map()};
const sidebarTabOpeningRef=typeof react.useRef==="function"?react.useRef(new Map()):{current:new Map()};
const sidebarAutoOriginRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoOrigin):{current:sharedSidebarAutoOrigin};
const sidebarAutoSuppressedRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoSuppressed):{current:sharedSidebarAutoSuppressed};
const sidebarAutoCloseAttemptsRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoCloseAttempts):{current:sharedSidebarAutoCloseAttempts};
const sidebarAutoCloseAttemptOwnersRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoCloseAttemptOwners):{current:sharedSidebarAutoCloseAttemptOwners};
const sidebarAutoCloseVerificationsRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoCloseVerifications):{current:sharedSidebarAutoCloseVerifications};
const sidebarAutoCloseCooldownsRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoCloseCooldowns):{current:sharedSidebarAutoCloseCooldowns};
const sidebarAutoTabMissesRef=typeof react.useRef==="function"?react.useRef(sharedSidebarAutoTabMisses):{current:sharedSidebarAutoTabMisses};
const sidebarAutoReservationRef=typeof react.useRef==="function"?react.useRef(new Map()):{current:new Map()};
const sidebarAutoCascadeRef=typeof react.useRef==="function"?react.useRef(false):{current:false};
const sidebarAutoFailedKeysRef=typeof react.useRef==="function"?react.useRef(new Set()):{current:new Set()};
const sidebarAutoEpochRef=typeof react.useRef==="function"?react.useRef(0):{current:0};
const sidebarManualIntentRef=typeof react.useRef==="function"?react.useRef(new Map()):{current:new Map()};
const sidebarAutoBusyRef=typeof react.useRef==="function"?react.useRef(false):{current:false};
const sidebarAutoSignatureRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sidebarSplitIntentRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sidebarTabPendingRef=typeof react.useRef==="function"?react.useRef(new Set()):{current:new Set()};
const sidebarBatchPendingRef=typeof react.useRef==="function"?react.useRef(new Set()):{current:new Set()};
const sidebarBatchScopeKey=(sessionId,rootId)=>String(sessionId)+SIDEBAR_TAB_KEY_SEPARATOR+String(rootId);
const sidebarBatchSignatureRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
const sidebarTabSyncRef=typeof react.useRef==="function"?react.useRef(null):{current:null};
Object.assign(frame,{
sidebarAutoBusyRef,sidebarAutoCascadeRef,sidebarAutoCloseAttemptOwnersRef,sidebarAutoCloseAttemptsRef,sidebarAutoCloseCooldownsRef,sidebarAutoCloseVerificationsRef,
sidebarAutoEpochRef,sidebarAutoFailedKeysRef,sidebarAutoOriginRef,sidebarAutoReservationRef,sidebarAutoSignatureRef,sidebarAutoSuppressedRef,
sidebarAutoTabMissesRef,sidebarBatchPendingRef,sidebarBatchScopeKey,sidebarBatchSignatureRef,sidebarManualIntentRef,sidebarSplitIntentRef,
sidebarTabOpeningRef,sidebarTabPendingRef,sidebarTabRecordsRef,sidebarTabSyncRef,
});
}
function useSidebarPanelTabPrimitives(frame){
const{
model,react,rootSessionId,sidebarSessionId,snapshot,
}=frame;
const neutralRuntimeStatus=typeof model.UNKNOWN_RUNTIME_STATUS==="string"&&model.UNKNOWN_RUNTIME_STATUS.length>0
?model.UNKNOWN_RUNTIME_STATUS
:"unknown";
const sidebarSnapshotSyncRef=typeof react.useRef==="function"
?react.useRef({rootSessionId,sidebarSessionId,snapshot})
:{current:{rootSessionId,sidebarSessionId,snapshot}};
Object.assign(frame,{
neutralRuntimeStatus,sidebarSnapshotSyncRef,
});
}
function useSidebarPanelTabWiring(frame){
const{
bump,catalogEntryOf,model,navigation,readActiveSidebarResource,refresh,
rootSessionId,sessionsService,setState,sidebarRight,store,
}=frame;
const retry=()=>{
setState((previous)=>(previous.rootSessionId===rootSessionId&&previous.error!==null
?{...previous,error:null}
:previous));
void refresh({manual:true});
};
const expand=(node)=>store?store.isExpanded(node):(node?.kind==="root"||(typeof model.defaultExpanded==="function"&&model.defaultExpanded(node)));
const toggle=(node)=>{
if(store)store.toggle(node);
bump((value)=>value+1);
};
const handleOpen=(id,address)=>{
if(navigation.available!==true)return;
if(typeof id!=="string"||id.length===0)return;
navigation.open(address===null||address===undefined||navigation.acceptsAddress!==true?id:address);
};
const subagentAddressOfChild=(childId,parentId,node)=>{
const id=text(childId,null);
if(id===null)return null;
const lookup=methodOf(sessionsService,"subagentAddress");
if(lookup!==null){
let addressed;
try{addressed=lookup.call(sessionsService,id);}catch{addressed=null;}
const normalized=normalizeSubagentAddress(addressed);
if(normalized!==null)return normalized;
if(addressed!==undefined&&addressed!==null)return null;
}
const parent=text(parentId,null);
const entry=catalogEntryOf(parent,id);
const entrySource=object(entry);
const entryHasMode=Object.prototype.hasOwnProperty.call(entrySource,"mode");
const entryMode=text(entrySource.mode,null);
const mode=entryHasMode
?entryMode
:(object(node).continuable===true?"continuable":null);
return normalizeSubagentAddress({
parentSessionId:parent,
childSessionId:id,
mode,
});
};
const activeSidebarTabId=()=>{
if(readActiveSidebarResource===null)return null;
try{return text(object(readActiveSidebarResource.call(sidebarRight)).id,null);}catch{return null;}
};
Object.assign(frame,{
activeSidebarTabId,expand,handleOpen,retry,subagentAddressOfChild,toggle,
});
}
function useSidebarPanelTabWiringPart2(frame){
const{
cancelSidebarSplit,closeSidebarResource,config,neutralRuntimeStatus,partialSnapshot,readActiveSidebarResource,
readSidebarOpenTabs,rootSessionId,sidebarAutoCloseAttemptOwnersRef,sidebarAutoCloseAttemptsRef,sidebarAutoCloseCooldownsRef,sidebarAutoTabMissesRef,
sidebarManualIntentRef,sidebarRight,sidebarSessionId,sidebarSplitIntentRef,sidebarTabOpeningRef,snapshot,
subagentAddressOfChild,
}=frame;
const runtimeStatusOfNode=(...args)=>frame.late.runtimeStatusOfNode(...args);
const sidebarAutoCloseKeyIsActive=(...args)=>frame.late.sidebarAutoCloseKeyIsActive(...args);
const tabTreeDeps=()=>({
addressOf:subagentAddressOfChild,
statusOf:runtimeStatusOfNode,
partial:partialSnapshot,
neutralStatus:neutralRuntimeStatus,
});
const autoCloseLedger=()=>({
closeAttempts:sidebarAutoCloseAttemptsRef.current,
owners:sidebarAutoCloseAttemptOwnersRef.current,
closeCooldowns:sidebarAutoCloseCooldownsRef.current,
tabMisses:sidebarAutoTabMissesRef.current,
limit:SIDEBAR_AUTO_KEY_LIMIT,
});
const presentFloatingSubagentTitles=()=>TAB_STATE.presentFloatingSubagentTitles(globalThis.document);
const knownSidebarResourceAddresses=()=>TAB_STATE.knownSidebarResourceAddresses(
snapshot,
rootSessionId,
subagentAddressOfChild,
);
const sidebarExpertResourceAddresses=(node,parentId,addresses)=>TAB_STATE.sidebarExpertResourceAddresses(
node,
parentId,
addresses,
tabTreeDeps(),
);
const sidebarNodeIsIdleReady=(node,parentId,childId)=>TAB_STATE.sidebarNodeIsIdleReady(
node,
parentId,
childId,
tabTreeDeps(),
);
const sidebarNodeIsIdleMembership=(node,parentId,childId)=>TAB_STATE.sidebarNodeIsIdleMembership(
node,
parentId,
childId,
tabTreeDeps(),
);
const sidebarIdleChildren=()=>TAB_STATE.sidebarIdleChildren(sidebarRootChildren(),rootSessionId,tabTreeDeps());
const runningSidebarResourceAddresses=()=>TAB_STATE.runningSidebarResourceAddresses(
sidebarRootChildren(),
rootSessionId,
tabTreeDeps(),
);
const idleSidebarResourceAddresses=(nodes)=>TAB_STATE.idleSidebarResourceAddresses(
nodes,
rootSessionId,
tabTreeDeps(),
);
const sidebarBatchCandidates=(addresses,inventory)=>TAB_STATE.sidebarBatchCandidates(
addresses,
inventory,
sidebarSessionId,
);
const sidebarBatchStateFor=(addresses,inventoryNow)=>TAB_STATE.sidebarBatchStateFor(addresses,{
inventory:inventoryNow??readSidebarOpenTabs(),
sidebarSessionId,
closeAvailable:closeSidebarResource!==null,
});
const sidebarBatchSignatureOf=TAB_STATE.sidebarBatchSignatureOf;
const sidebarResourceTabStateOf=(resourceAddress)=>TAB_STATE.sidebarResourceTabStateOf(
readSidebarOpenTabs(),
sidebarSessionId,
resourceAddress,
);
const sidebarAdoptionEvidenceAvailable=(resourceAddress)=>TAB_STATE.sidebarAdoptionEvidenceAvailable(
readSidebarOpenTabs(),
sidebarSessionId,
resourceAddress,
);
const sidebarActiveResourceMatches=(resourceAddress)=>{
if(readActiveSidebarResource===null)return false;
let tab=null;
try{tab=object(readActiveSidebarResource.call(sidebarRight));}catch{return false;}
return TAB_STATE.sidebarActiveResourceMatches(tab,resourceAddress);
};
const sidebarManualIntentOf=(key)=>TAB_STATE.sidebarManualIntentOf(
sidebarManualIntentRef.current,
key,
sidebarSessionId,
rootSessionId,
);
const trimAutoKeyMap=(map,activeAware)=>TAB_STATE.trimAutoKeyMap(map,{
limit:SIDEBAR_AUTO_KEY_LIMIT,
activeAware,
isActive:sidebarAutoCloseKeyIsActive,
});
const clearAutoCloseAttempt=(key)=>TAB_STATE.clearAutoCloseAttempt(autoCloseLedger(),key);
const clearAutoCloseBudget=(key)=>TAB_STATE.clearAutoCloseBudget(autoCloseLedger(),key);
const enterAutoCloseCooldown=(key)=>TAB_STATE.enterAutoCloseCooldown(
autoCloseLedger(),
key,
sidebarAutoCloseKeyIsActive,
);
const autoCloseCooldownActive=(key)=>TAB_STATE.autoCloseCooldownActive(autoCloseLedger(),key);
const releaseExpiredAutoCloseCooldown=(key)=>TAB_STATE.releaseExpiredAutoCloseCooldown(autoCloseLedger(),key);
const autoTabMissesOf=(key,tabId)=>TAB_STATE.autoTabMissesOf(autoCloseLedger(),key,tabId);
const sampleAutoTabMisses=(key,tabId,missing)=>TAB_STATE.sampleAutoTabMisses(
autoCloseLedger(),
key,
{sidebarSessionId,rootSessionId,tabId,missing},
);
const settleAutoCloseAttempt=(key,context)=>TAB_STATE.settleAutoCloseAttempt(autoCloseLedger(),key,context);
const sidebarRootChildren=()=>(Array.isArray(snapshot?.root?.children)?snapshot.root.children:[]);
const cancelPendingSidebarSplit=(reason,expectedIntentToken)=>{
const intent=sidebarSplitIntentRef.current;
if(intent===null)return;
if(expectedIntentToken!==undefined&&intent.token!==expectedIntentToken)return;
sidebarSplitIntentRef.current=null;
sidebarTabOpeningRef.current.delete(intent.key);
if(cancelSidebarSplit===null)return;
try{cancelSidebarSplit.call(config,intent.token,{reason});}catch{/* 收口失败不能阻断面板同步。 */}
};
const cancelPendingSidebarSplitOfClose=(key,splitIntentToken)=>{
const intent=sidebarSplitIntentRef.current;
if(intent===null||intent.key!==key)return;
if(splitIntentToken===null||splitIntentToken===undefined)return;
if(intent.token!==splitIntentToken)return;
cancelPendingSidebarSplit("close",splitIntentToken);
};
Object.assign(frame,{
autoCloseCooldownActive,autoTabMissesOf,cancelPendingSidebarSplit,cancelPendingSidebarSplitOfClose,clearAutoCloseAttempt,
clearAutoCloseBudget,enterAutoCloseCooldown,idleSidebarResourceAddresses,knownSidebarResourceAddresses,presentFloatingSubagentTitles,releaseExpiredAutoCloseCooldown,
runningSidebarResourceAddresses,sampleAutoTabMisses,settleAutoCloseAttempt,sidebarActiveResourceMatches,sidebarAdoptionEvidenceAvailable,sidebarBatchCandidates,
sidebarBatchSignatureOf,sidebarBatchStateFor,sidebarExpertResourceAddresses,sidebarIdleChildren,sidebarManualIntentOf,sidebarNodeIsIdleMembership,
sidebarNodeIsIdleReady,sidebarResourceTabStateOf,trimAutoKeyMap,
});
}
function useSidebarPanelTabWiringPart3(frame){
const{
commitSidebarSplit,config,sidebarSplitIntentRef,sidebarSplitTargetEvidence,
}=frame;
const tryCommitSidebarSplit=()=>{
const intent=sidebarSplitIntentRef.current;
if(intent===null||intent.resourceIssued!==true||commitSidebarSplit===null)return;
const evidence=sidebarSplitTargetEvidence(intent.resourceAddress,intent.paneId);
if(evidence===null)return;
try{
if(commitSidebarSplit.call(config,intent.token,evidence)===true){
sidebarSplitIntentRef.current=null;
}
}catch{
}
};
Object.assign(frame,{
sidebarTabVisible:TAB_STATE.sidebarTabVisible,tryCommitSidebarSplit,
});
}
function useSidebarPanelTabSync(frame){
const{
activeSidebarTabId,bump,cancelPendingSidebarSplit,idleSidebarResourceAddresses,knownSidebarResourceAddresses,presentFloatingSubagentTitles,
presentSidebarTabIds,readSidebarOpenTabs,requestRightbarDragSync,rootSessionId,runningSidebarResourceAddresses,sharedSidebarTabCloseInFlight,
sidebarAdoptionEvidenceAvailable,sidebarBatchSignatureOf,sidebarBatchSignatureRef,sidebarBatchStateFor,sidebarIdleChildren,sidebarManualIntentRef,
sidebarSessionId,sidebarSplitIntentRef,sidebarTabOpeningRef,sidebarTabRecordsRef,tryCommitSidebarSplit,
}=frame;
const applyPendingManualIntent=(...args)=>frame.late.applyPendingManualIntent(...args);
const recordSidebarTab=(...args)=>frame.late.recordSidebarTab(...args);
const syncSidebarTabRecords=()=>{
try{requestRightbarDragSync?.();}catch{/* 手柄锁只是体验优化，绝不影响面板。 */}
const inventory=readSidebarOpenTabs();
const batchSignatureNow=sidebarBatchSignatureOf(
sidebarBatchStateFor(runningSidebarResourceAddresses(),inventory),
sidebarBatchStateFor(idleSidebarResourceAddresses(sidebarIdleChildren()),inventory),
);
if(sidebarBatchSignatureRef.current!==batchSignatureNow){
sidebarBatchSignatureRef.current=batchSignatureNow;
bump((value)=>value+1);
}
const records=sidebarTabRecordsRef.current;
const openings=sidebarTabOpeningRef.current;
const now=Date.now();
const openingResolved=[];
let scopedRecordExists=false;
for(const record of records.values()){
if(record.sessionId===sidebarSessionId&&record.rootSessionId===rootSessionId){
scopedRecordExists=true;
break;
}
}
if(scopedRecordExists!==true){
for(const resourceAddress of knownSidebarResourceAddresses()){
if(sidebarAdoptionEvidenceAvailable(resourceAddress)!==true)continue;
const key=sidebarTabKey(sidebarSessionId,rootSessionId,resourceAddress);
if(recordSidebarTab(key,resourceAddress))openings.delete(key);
}
}
for(const[key,opening]of openings){
if(now>=opening.expiresAt){
if(sidebarSplitIntentRef.current?.key===key)cancelPendingSidebarSplit("timeout");
openingResolved.push(key);
continue;
}
if(opening.sessionId!==sidebarSessionId||opening.rootSessionId!==rootSessionId)continue;
if(recordSidebarTab(key,opening.resourceAddress))openingResolved.push(key);
}
for(const key of openingResolved){
openings.delete(key);
}
tryCommitSidebarSplit();
for(const key of[...sidebarManualIntentRef.current.keys()]){
const entry=sidebarManualIntentRef.current.get(key);
if(entry===undefined)continue;
if(entry.sessionId!==sidebarSessionId||entry.rootSessionId!==rootSessionId){
sidebarManualIntentRef.current.delete(key);
continue;
}
applyPendingManualIntent(key);
}
if(records.size===0)return;
const present=presentSidebarTabIds();
const floatingTitles=presentFloatingSubagentTitles();
const activeTabId=activeSidebarTabId();
let changed=0;
for(const[key,record]of records){
if(record.sessionId!==sidebarSessionId||record.rootSessionId!==rootSessionId)continue;
const leased=sharedSidebarTabCloseInFlight?.has(sidebarTabCloseKey(sidebarSessionId,rootSessionId,record.tabId));
const verdict=TAB_STATE.sidebarTabVerdictOf(inventory,sidebarSessionId,present,floatingTitles,activeTabId,key,record);
if(verdict==="undecidable")continue;
if(verdict==="present"){
record.misses=0;
if(record.absent){
record.absent=false;
changed+=1;
}
continue;
}
if(verdict==="absent"){
if(!leased&&record.origin!==SIDEBAR_TAB_ORIGIN_AUTO){
records.delete(key);
changed+=1;
continue;
}
if(!record.absent){
record.absent=true;
changed+=1;
}
continue;
}
if(leased||present===null||floatingTitles===null)continue;
record.misses+=1;
if(record.misses>=SIDEBAR_TAB_DISAPPEAR_CONFIRMATIONS){
records.delete(key);
changed+=1;
}
}
if(changed===0)return;
bump((value)=>value+1);
};
Object.assign(frame,{
syncSidebarTabRecords,
});
}
function useSidebarPanelAutoOrchestration(frame){
const{
autoCloseCooldownActive,autoOpenEnabled,bump,cancelPendingSidebarSplit,cancelPendingSidebarSplitOfClose,clearAutoCloseAttempt,
clearAutoCloseBudget,closeSidebarResource,currentRootRef,currentSidebarSessionRef,enterAutoCloseCooldown,idleSidebarResourceAddresses,
knownSidebarResourceAddresses,mountedRef,openSidebarResource,primitives,readActiveSidebarResource,readSidebarOpenTabs,
releaseExpiredAutoCloseCooldown,rootSessionId,runningSidebarResourceAddresses,sampleAutoTabMisses,setAutoOpenDraft,settleAutoCloseAttempt,
sharedSidebarTabCloseInFlight,sidebarActiveResourceMatches,sidebarAutoBusyRef,sidebarAutoCascadeRef,sidebarAutoCloseAttemptOwnersRef,sidebarAutoCloseAttemptsRef,
sidebarAutoCloseCooldownsRef,sidebarAutoCloseVerificationsRef,sidebarAutoEpochRef,sidebarAutoFailedKeysRef,sidebarAutoOriginRef,sidebarAutoReservationRef,
sidebarAutoSignatureRef,sidebarAutoSuppressedRef,sidebarIdleChildren,sidebarManualIntentOf,sidebarManualIntentRef,sidebarOpenTabsAvailable,
sidebarResourceTabStateOf,sidebarRight,sidebarSessionId,sidebarSplitIntentRef,sidebarSurfaceStillCurrent,sidebarTabOpeningRef,
sidebarTabPendingRef,sidebarTabRecordsRef,sidebarTabSyncRef,snapshot,syncSidebarTabRecords,trimAutoKeyMap,
}=frame;
const cleanupAutoSidebarKeys=(...args)=>frame.late.cleanupAutoSidebarKeys(...args);
const clearManualSuppressionOfIdleResources=(...args)=>frame.late.clearManualSuppressionOfIdleResources(...args);
const handleSidebarAction=(...args)=>frame.late.handleSidebarAction(...args);
const sweepAutoOpenPlaceholders=(...args)=>frame.late.sweepAutoOpenPlaceholders(...args);
let sidebarAutoFrameCache=null;
const sidebarAutoFrame=()=>{
if(sidebarAutoFrameCache===null){
sidebarAutoFrameCache={
autoCloseCandidate,
autoCloseCooldownActive,
autoOpenCandidate,
autoOpenEnabled,
bump,
cancelPendingSidebarSplit,
cancelPendingSidebarSplitOfClose,
cleanupAutoSidebarKeys,
clearAutoCloseAttempt,
clearAutoCloseBudget,
clearManualSuppressionOfIdleResources,
closeSidebarResource,
currentRootRef,
currentSidebarSessionRef,
enterAutoCloseCooldown,
handleSidebarAction,
idleSidebarResourceAddresses,
knownSidebarResourceAddresses,
mountedRef,
openSidebarResource,
primitives,
readActiveSidebarResource,
readSidebarOpenTabs,
releaseExpiredAutoCloseCooldown,
rootSessionId,
runningSidebarResourceAddresses,
sampleAutoTabMisses,
setAutoOpenDraft,
settleAutoCloseAttempt,
sharedSidebarTabCloseInFlight,
sidebarActiveResourceMatches,
sidebarAutoBusyRef,
sidebarAutoCascadeRef,
sidebarAutoCloseAttemptOwnersRef,
sidebarAutoCloseAttemptsRef,
sidebarAutoCloseCooldownsRef,
sidebarAutoCloseVerificationsRef,
sidebarAutoEpochRef,
sidebarAutoFailedKeysRef,
sidebarAutoOriginRef,
sidebarAutoReservationRef,
sidebarAutoSignatureRef,
sidebarAutoSuppressedRef,
sidebarIdleChildren,
sidebarManualIntentOf,
sidebarManualIntentRef,
sidebarOpenTabsAvailable,
sidebarResourceTabStateOf,
sidebarRight,
sidebarSessionId,
sidebarSplitIntentRef,
sidebarSurfaceStillCurrent,
sidebarTabOpeningRef,
sidebarTabPendingRef,
sidebarTabRecordsRef,
sidebarTabSyncRef,
snapshot,
sweepAutoOpenPlaceholders,
syncSidebarTabRecords,
trimAutoKeyMap,
verifyPendingSidebarCloses,
};
}
return sidebarAutoFrameCache;
};
let sidebarAutoControllerCache=null;
const autoController=()=>{
if(sidebarAutoControllerCache===null){
sidebarAutoControllerCache=AUTO_CONTROLLER.createSidebarAutoController(sidebarAutoFrame());
}
return sidebarAutoControllerCache;
};
let sidebarActionsCache=null;
const sidebarActions=()=>{
if(sidebarActionsCache===null){
sidebarActionsCache=SIDEBAR_ACTIONS.createSidebarActions(sidebarAutoFrame());
}
return sidebarActionsCache;
};
const sidebarAutoOpenCapable=()=>autoController().sidebarAutoOpenCapable();
const autoCloseCandidate=(running)=>autoController().autoCloseCandidate(running);
const autoOpenCandidate=(running)=>autoController().autoOpenCandidate(running);
const sidebarAutoCloseKeyIsActive=(key)=>autoController().sidebarAutoCloseKeyIsActive(key);
const autoSidebarOwnershipHasCapacity=(key,address)=>autoController().autoSidebarOwnershipHasCapacity(key,address);
const sidebarTabCloseInFlight=(tabId)=>autoController().sidebarTabCloseInFlight(tabId);
const acquireSidebarTabClose=(tabId)=>autoController().acquireSidebarTabClose(tabId);
const sidebarTabPresenceInInventory=(tabId,expectedAddress=null)=>autoController().sidebarTabPresenceInInventory(tabId,expectedAddress);
const requestSidebarTabClose=(tabId)=>autoController().requestSidebarTabClose(tabId);
const waitForSidebarCloseLease=(leaseToken,timeoutMs)=>autoController().waitForSidebarCloseLease(leaseToken,timeoutMs);
const beginSidebarCloseVerification=(lease,tabId,verify)=>autoController().beginSidebarCloseVerification(lease,tabId,verify);
const finishVerifiedSidebarClose=(key,entry,reason)=>autoController().finishVerifiedSidebarClose(key,entry,reason);
const verifyPendingSidebarCloses=()=>autoController().verifyPendingSidebarCloses();
frame.late.clearSidebarAutoSuppressionsOfScope=()=>clearAutoSuppressionsOfScope(sidebarAutoSuppressedRef.current,sidebarSessionId,rootSessionId);
frame.late.sidebarAutoCloseKeyIsActive=sidebarAutoCloseKeyIsActive;
Object.assign(frame,{
acquireSidebarTabClose,autoCloseCandidate,autoController,autoOpenCandidate,autoSidebarOwnershipHasCapacity,beginSidebarCloseVerification,
finishVerifiedSidebarClose,requestSidebarTabClose,sidebarActions,sidebarAutoCloseKeyIsActive,
sidebarAutoOpenCapable,sidebarTabCloseInFlight,
sidebarTabPresenceInInventory,verifyPendingSidebarCloses,waitForSidebarCloseLease,
});
}
function useSidebarPanelAutoOrchestrationPart2(frame){
const{
autoController,sidebarActions,sidebarTabSyncRef,
}=frame;
const closeSidebarTabWithLease=(tabId,options)=>autoController().closeSidebarTabWithLease(tabId,options);
const cleanupAutoSidebarKeys=(known,actingKey)=>autoController().cleanupAutoSidebarKeys(known,actingKey);
const sweepAutoOpenPlaceholders=(running)=>autoController().sweepAutoOpenPlaceholders(running);
const launchAutoSidebarAction=(candidate)=>sidebarActions().launchAutoSidebarAction(candidate);
const clearManualSuppressionOfIdleResources=(idle)=>autoController().clearManualSuppressionOfIdleResources(idle);
const syncAutoSidebarTabs=()=>sidebarActions().syncAutoSidebarTabs();
const autoActionStillValid=(context)=>sidebarActions().autoActionStillValid(context);
const abandonAutoSidebarAction=(key,context)=>sidebarActions().abandonAutoSidebarAction(key,context);
const releaseAutoCloseAttempt=(key,context)=>sidebarActions().releaseAutoCloseAttempt(key,context);
const autoTakeoverStateOf=(key)=>sidebarActions().autoTakeoverStateOf(key);
const recordSidebarManualIntent=(key,resourceAddress)=>sidebarActions().recordSidebarManualIntent(key,resourceAddress);
const applyPendingManualIntent=(key)=>sidebarActions().applyPendingManualIntent(key);
const syncSidebarTabs=()=>sidebarActions().syncSidebarTabs();
sidebarTabSyncRef.current=syncSidebarTabs;
frame.late.applyPendingManualIntent=applyPendingManualIntent;
frame.late.cleanupAutoSidebarKeys=cleanupAutoSidebarKeys;
frame.late.clearManualSuppressionOfIdleResources=clearManualSuppressionOfIdleResources;
frame.late.sweepAutoOpenPlaceholders=sweepAutoOpenPlaceholders;
Object.assign(frame,{
abandonAutoSidebarAction,applyPendingManualIntent,autoActionStillValid,autoTakeoverStateOf,cleanupAutoSidebarKeys,clearManualSuppressionOfIdleResources,
closeSidebarTabWithLease,launchAutoSidebarAction,recordSidebarManualIntent,releaseAutoCloseAttempt,sweepAutoOpenPlaceholders,syncAutoSidebarTabs,
syncSidebarTabs,
});
}
global[SYMBOL]=Object.freeze({
useSidebarPanelAutoOrchestration,useSidebarPanelAutoOrchestrationPart2,useSidebarPanelAutoRefs,
useSidebarPanelTabPrimitives,useSidebarPanelTabSync,useSidebarPanelTabWiring,
useSidebarPanelTabWiringPart2,useSidebarPanelTabWiringPart3,
});
})(globalThis);
/* source: client-sidebar-panel-hooks-actions.js */
(function installSidebarPanelHooksActions(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-actions");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,SIDEBAR_TAB_ORIGIN_AUTO,SIDEBAR_TAB_ORIGIN_MANUAL,modelFunction,object,text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
SUBAGENT_CHAT_KIND,runtimeStatusOf,
}=DOM;
const POLL_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-poll");
const POLL=global[POLL_SYMBOL]||{};
const{
PANEL_ERROR_SOURCES,RPC_FAILURE_TRANSPORT,callRpc,rpcFailureKindOf,
}=POLL;
const AUTO_LEDGER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const AUTO_LEDGER=global[AUTO_LEDGER_SYMBOL]||{};
const{
SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,readSidebarAutoOwnershipEntry,recordSidebarAutoDecision,sidebarAutoOriginEntry,sidebarAutoOriginTabIdOf,
writeSidebarAutoOwnership,
}=AUTO_LEDGER;
function useSidebarPanelTabRecorder(frame){
const{
}=frame;
}
function readSidebarTabEvidence(deps){
const{readActiveSidebarResource,readSidebarOpenTabs,resourceAddress,sidebarRight,sidebarSessionId}=deps;
let tab=null;
const inventory=readSidebarOpenTabs();
if(inventory!==null){
for(const entry of inventory){
const candidate=object(entry);
if(text(candidate.sessionId,null)!==sidebarSessionId)continue;
if(text(candidate.kind,null)!==SUBAGENT_CHAT_KIND)continue;
if(text(candidate.contentId,null)!==resourceAddress)continue;
const candidateId=text(candidate.tabId,null);
if(candidateId!==null){
tab={id:candidateId,kind:candidate.kind,contentId:candidate.contentId,title:null};
break;
}
}
}
if(tab!==null&&readActiveSidebarResource!==null){
try{
const activeSource=object(readActiveSidebarResource.call(sidebarRight));
if(text(activeSource.id,null)===tab.id)tab={...tab,title:text(activeSource.title,null)};
}catch{/* inventory 已足够确认 tabId，标题读取失败不阻塞 toggle。 */}
}
if(tab===null){
try{tab=readActiveSidebarResource.call(sidebarRight);}catch{return null;}
}
const source=object(tab);
const tabId=text(source.id,null);
const tabTitle=text(source.title,null);
if(tabId===null)return null;
if(text(source.kind,null)!==SUBAGENT_CHAT_KIND)return null;
if(text(source.contentId,null)!==resourceAddress)return null;
return{tabId,tabTitle};
}
function resolveSidebarTabOrigin(deps){
const{
actionOrigin,actionProof,key,openings,readPersistedEntry,records,resourceAddress,rootSessionId,
sharedOrigins,sidebarManualIntentOf,sidebarSessionId,tabId,
}=deps;
const declaredOrigin=actionOrigin===SIDEBAR_TAB_ORIGIN_AUTO||actionOrigin===SIDEBAR_TAB_ORIGIN_MANUAL
?actionOrigin
:null;
const declaredAutoProven=actionProof!==null&&actionProof!==undefined
&&actionProof.autoProven===true;
const previous=records.get(key);
const opening=openings.get(key);
const previousScoped=previous!==undefined
&&previous.sessionId===sidebarSessionId&&previous.rootSessionId===rootSessionId
?previous
:undefined;
const openingScoped=opening!==undefined
&&opening.sessionId===sidebarSessionId&&opening.rootSessionId===rootSessionId
?opening
:undefined;
if(openingScoped!==undefined
&&(openingScoped.causalIssuedAt===null||openingScoped.causalIssuedAt===undefined)){
openingScoped.foreignWriter=true;
}
const manualTakeover=sidebarManualIntentOf(key);
const sharedOrigin=sharedOrigins.get(key);
const sharedOriginScoped=sharedOrigin!==undefined
&&sharedOrigin.sessionId===sidebarSessionId&&sharedOrigin.rootSessionId===rootSessionId
?sharedOrigin
:undefined;
const sharedOriginTabId=sidebarAutoOriginTabIdOf(sharedOriginScoped);
const sharedOriginBound=sharedOriginTabId!==null&&sharedOriginTabId===tabId;
const sharedOriginStale=sharedOriginScoped!==undefined&&sharedOriginBound!==true;
const persistedEntry=readPersistedEntry(sidebarSessionId,rootSessionId,resourceAddress);
const persistedManual=persistedEntry!==null&&persistedEntry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL;
const persistedAutoBound=persistedEntry!==null
&&persistedEntry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
&&persistedEntry.tabId!==null
&&persistedEntry.tabId===tabId;
const persistedStaleAuto=persistedEntry!==null
&&persistedEntry.origin===SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO
&&persistedAutoBound!==true;
const previousUsableAuto=previousScoped!==undefined
&&previousScoped.origin===SIDEBAR_TAB_ORIGIN_AUTO
&&previousScoped.tabId===tabId;
const openingUsableAuto=openingScoped!==undefined
&&openingScoped.origin===SIDEBAR_TAB_ORIGIN_AUTO
&&openingScoped.causalProof==="proven"
&&openingScoped.causalIssuedAt!==null&&openingScoped.causalIssuedAt!==undefined
&&openingScoped.foreignWriter!==true;
const declaredUsable=declaredOrigin===SIDEBAR_TAB_ORIGIN_AUTO
?(declaredAutoProven===true?SIDEBAR_TAB_ORIGIN_AUTO:SIDEBAR_TAB_ORIGIN_MANUAL)
:declaredOrigin;
const manualIntentOpen=manualTakeover!==undefined&&manualTakeover.intent==="open";
const origin=manualIntentOpen||persistedManual
?SIDEBAR_TAB_ORIGIN_MANUAL
:(declaredUsable
??(previousUsableAuto===true
?SIDEBAR_TAB_ORIGIN_AUTO
:(openingUsableAuto===true
?SIDEBAR_TAB_ORIGIN_AUTO
:(sharedOriginBound===true
?SIDEBAR_TAB_ORIGIN_AUTO
:(persistedAutoBound===true?SIDEBAR_TAB_ORIGIN_AUTO:SIDEBAR_TAB_ORIGIN_MANUAL)))));
const recordOrigin=origin===SIDEBAR_TAB_ORIGIN_AUTO?SIDEBAR_TAB_ORIGIN_AUTO:SIDEBAR_TAB_ORIGIN_MANUAL;
return{
declaredAutoProven,declaredOrigin,manualIntentOpen,openingScoped,openingUsableAuto,persistedManual,
persistedStaleAuto,previous,previousUsableAuto,recordOrigin,sharedOriginScoped,sharedOriginStale,
};
}
function useSidebarPanelTabRecorderPart2(frame){
const{
bump,closeSidebarResource,primitives,readActiveSidebarResource,readSidebarOpenTabs,rootSessionId,
sidebarAutoOriginRef,sidebarManualIntentOf,sidebarRight,sidebarSessionId,sidebarTabOpeningRef,sidebarTabRecordsRef,
}=frame;
const recordSidebarTab=(key,resourceAddress,actionOrigin,actionProof)=>{
if(closeSidebarResource===null)return false;
if(readActiveSidebarResource===null&&readSidebarOpenTabs()===null)return false;
if(typeof primitives?.IconChevronLeftOutlineRegular!=="function")return false;
const evidence=readSidebarTabEvidence({
readActiveSidebarResource,readSidebarOpenTabs,resourceAddress,sidebarRight,sidebarSessionId,
});
if(evidence===null)return false;
const{tabId,tabTitle}=evidence;
const resolution=resolveSidebarTabOrigin({
actionOrigin,actionProof,key,openings:sidebarTabOpeningRef.current,readPersistedEntry:readSidebarAutoOwnershipEntry,
records:sidebarTabRecordsRef.current,resourceAddress,rootSessionId,
sharedOrigins:sidebarAutoOriginRef.current,sidebarManualIntentOf,sidebarSessionId,tabId:evidence.tabId,
});
const{
declaredAutoProven,declaredOrigin,manualIntentOpen,openingScoped,openingUsableAuto,persistedManual,
persistedStaleAuto,previous,previousUsableAuto,recordOrigin,sharedOriginScoped,sharedOriginStale,
}=resolution;
if(sharedOriginStale===true
||(persistedManual===true&&sharedOriginScoped!==undefined)){
sidebarAutoOriginRef.current.delete(key);
}
if(recordOrigin===SIDEBAR_TAB_ORIGIN_AUTO){
sidebarAutoOriginRef.current.set(
key,
sidebarAutoOriginEntry(sidebarSessionId,rootSessionId,resourceAddress,tabId),
);
}
writeSidebarAutoOwnership(
sidebarSessionId,
rootSessionId,
resourceAddress,
recordOrigin===SIDEBAR_TAB_ORIGIN_AUTO?SIDEBAR_AUTO_OWNERSHIP_ORIGIN_AUTO:SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
recordOrigin===SIDEBAR_TAB_ORIGIN_AUTO
?(declaredOrigin===SIDEBAR_TAB_ORIGIN_AUTO?"auto-open":"auto-adopt")
:(manualIntentOpen===true||declaredOrigin===SIDEBAR_TAB_ORIGIN_MANUAL
?"manual-open"
:(persistedStaleAuto===true
?"manual-stale-auto"
:(sharedOriginStale===true
?"manual-stale-origin"
:(declaredOrigin===SIDEBAR_TAB_ORIGIN_AUTO&&declaredAutoProven!==true
?"manual-unproven-open"
:(openingScoped!==undefined&&openingScoped.origin===SIDEBAR_TAB_ORIGIN_AUTO
&&openingUsableAuto!==true&&previousUsableAuto!==true
?"manual-unproven-open"
:"manual-takeover"))))),
tabId,
);
if(previous!==undefined&&previous.sessionId===sidebarSessionId
&&previous.rootSessionId===rootSessionId&&previous.tabId===tabId){
previous.title=tabTitle??previous.title;
previous.misses=0;
previous.origin=recordOrigin;previous.absent=false;// 落地证据齐备：清掉权威缺席标记
return true;
}
sidebarTabRecordsRef.current.set(key,{sessionId:sidebarSessionId,rootSessionId,tabId,title:tabTitle,misses:0,origin:recordOrigin});
bump((value)=>value+1);
return true;
};
frame.late.recordSidebarTab=recordSidebarTab;
Object.assign(frame,{
recordSidebarTab,
});
}
function useSidebarPanelActionHandlers(frame){
const{
}=frame;
}
function createSidebarActionContext(deps,key,resourceAddress,actionOrigin,autoAction){
const{
releaseAutoCloseAttempt,rootSessionId,sidebarAutoEpochRef,sidebarAutoReservationRef,
sidebarSessionId,sidebarSurfaceStillCurrent,sidebarTabRecordsRef,
}=deps;
const origin=actionOrigin===SIDEBAR_TAB_ORIGIN_AUTO?SIDEBAR_TAB_ORIGIN_AUTO:SIDEBAR_TAB_ORIGIN_MANUAL;
if(origin===SIDEBAR_TAB_ORIGIN_MANUAL){
const manualRecord=sidebarTabRecordsRef.current.get(key);
writeSidebarAutoOwnership(
sidebarSessionId,
rootSessionId,
resourceAddress,
SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,
deps.sidebarTabVisible(manualRecord)?"manual-close":"manual-open",
);
}
const autoContext=origin===SIDEBAR_TAB_ORIGIN_AUTO&&autoAction!==null&&typeof autoAction==="object"
?{
kind:autoAction.kind==="close"?"close":"open",
epoch:Number.isFinite(Number(autoAction.epoch))?Number(autoAction.epoch):sidebarAutoEpochRef.current,
attemptsBefore:Number.isFinite(Number(autoAction.attemptsBefore))?Number(autoAction.attemptsBefore):0,
attemptToken:autoAction.attemptToken!==null&&autoAction.attemptToken!==undefined
&&typeof autoAction.attemptToken==="object"
?autoAction.attemptToken
:null,
}
:null;
if(sidebarSurfaceStillCurrent()!==true){
if(autoContext!==null){
sidebarAutoReservationRef.current.delete(key);
releaseAutoCloseAttempt(key,autoContext);
}
return null;
}
return{
autoContext,canTrackOpen:false,effectiveOrigin:origin,key,openIssued:false,openProof:null,origin,
resourceAddress,
};
}
async function closeSidebarActionWithLease(action,deps,record){
const{
closeSidebarTabWithLease,releaseAutoCloseAttempt,sidebarAutoFailedKeysRef,sidebarAutoReservationRef,
sidebarSplitIntentRef,sidebarSurfaceStillCurrent,
}=deps;
const{autoContext,key,origin,resourceAddress}=action;
const splitIntentAtClose=sidebarSplitIntentRef.current;
const closeSplitIntentToken=splitIntentAtClose!==null&&splitIntentAtClose.key===key
?splitIntentAtClose.token
:null;
const closeOutcome=await closeSidebarTabWithLease(record.tabId,{
waitForCompeting:origin===SIDEBAR_TAB_ORIGIN_MANUAL,
verify:{
key,
address:resourceAddress,
attemptToken:autoContext===null?null:autoContext.attemptToken,
manual:origin===SIDEBAR_TAB_ORIGIN_MANUAL,
splitIntentToken:closeSplitIntentToken,
},
});
if(sidebarSurfaceStillCurrent()!==true){
return;
}
if(closeOutcome.status==="contended"||closeOutcome.status==="contended-timeout"){
if(autoContext!==null){
sidebarAutoReservationRef.current.delete(key);
releaseAutoCloseAttempt(key,autoContext);
sidebarAutoFailedKeysRef.current.add(key);
}
return;
}
if(closeOutcome.status==="unreadable"){
if(autoContext!==null){
sidebarAutoReservationRef.current.delete(key);
releaseAutoCloseAttempt(key,autoContext);
sidebarAutoFailedKeysRef.current.add(key);
}
return;
}
if(closeOutcome.status==="stale"){
if(autoContext!==null){
sidebarAutoReservationRef.current.delete(key);
releaseAutoCloseAttempt(key,autoContext);
}
return;
}
if(closeOutcome.status==="failed"||closeOutcome.status==="timeout"){
sidebarAutoFailedKeysRef.current.add(key);
return;
}
if(closeOutcome.status==="request-resolved-unverified"){
deps.syncSidebarTabs();
return;
}
settleVerifiedSidebarClose(action,deps,record,closeOutcome,closeSplitIntentToken);
}
function settleVerifiedSidebarClose(action,deps,record,closeOutcome,closeSplitIntentToken){
const{
bump,cancelPendingSidebarSplitOfClose,rootSessionId,settleAutoCloseAttempt,sidebarAutoCloseCooldownsRef,
sidebarAutoOriginRef,sidebarAutoSuppressedRef,sidebarSessionId,sidebarTabRecordsRef,syncSidebarTabs,
trimAutoKeyMap,
}=deps;
const{autoContext,key,origin,resourceAddress}=action;
if(closeOutcome.status==="verified-closed"||closeOutcome.status==="closed"
||closeOutcome.status==="verified-recycled"){
const currentRecord=sidebarTabRecordsRef.current.get(key);
const recordStillSame=currentRecord!==undefined&&currentRecord.tabId===record.tabId;
cancelPendingSidebarSplitOfClose(key,closeSplitIntentToken);
if(recordStillSame===true){
sidebarTabRecordsRef.current.delete(key);
}
settleAutoCloseAttempt(key,autoContext);
if(recordStillSame===true&&closeOutcome.status==="verified-recycled"){
sidebarAutoCloseCooldownsRef.current.delete(key);
}
if(recordStillSame===true){
sidebarAutoOriginRef.current.delete(key);
if(origin===SIDEBAR_TAB_ORIGIN_MANUAL){
sidebarAutoSuppressedRef.current.set(key,{sessionId:sidebarSessionId,rootSessionId,address:resourceAddress});
trimAutoKeyMap(sidebarAutoSuppressedRef.current);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,resourceAddress,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
}
}
bump((value)=>value+1);
syncSidebarTabs();
}
}
function reviewAutoSideEffect(action,deps){
const{autoActionStillValid,autoTakeoverStateOf}=deps;
const{autoContext,key}=action;
if(autoContext===null)return"proceed";
if(autoActionStillValid(autoContext)!==true)return"abort";
const takeover=autoTakeoverStateOf(key);
if(takeover==="close")return"abort";
if(takeover==="open")return"manual";
return"proceed";
}
function settleAbortedAutoSideEffect(action,deps){
const{
abandonAutoSidebarAction:abandon,autoTakeoverStateOf,rootSessionId,
sidebarAutoSuppressedRef:suppressed,sidebarSessionId,trimAutoKeyMap,
}=deps;
const{autoContext,key,resourceAddress:address}=action;
abandon(key,autoContext);
if(autoTakeoverStateOf(key)==="close"){
suppressed.current.set(key,{sessionId:sidebarSessionId,rootSessionId,address});
trimAutoKeyMap(suppressed.current);
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,address,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
}
}
function runSidebarOpenAction(action,deps){
const{
clearAutoCloseAttempt,closeSidebarResource,existingSubagentPaneId,primitives,readActiveSidebarResource,
rootSessionId,sidebarAutoOriginRef,sidebarAutoSuppressedRef,sidebarOpenTabsAvailable,sidebarSessionId,
sidebarTabOpeningRef,splitSidebarPane,
}=deps;
const{key,origin,resourceAddress}=action;
action.effectiveOrigin=origin;
action.canTrackOpen=closeSidebarResource!==null
&&(readActiveSidebarResource!==null||sidebarOpenTabsAvailable===true)
&&typeof primitives?.IconChevronLeftOutlineRegular==="function";
const canObserveOpenCommit=action.canTrackOpen
&&globalThis.document!==null&&globalThis.document!==undefined;
if(canObserveOpenCommit){
sidebarTabOpeningRef.current.set(key,{
sessionId:sidebarSessionId,
rootSessionId,
resourceAddress,
expiresAt:Date.now()+SIDEBAR_TAB_OPEN_CONFIRMATION_TIMEOUT_MS,
origin,
causalProof:"pending",
causalIssuedAt:null,
foreignWriter:false,
});
}
if(origin===SIDEBAR_TAB_ORIGIN_MANUAL){
sidebarAutoSuppressedRef.current.delete(key);
sidebarAutoOriginRef.current.delete(key);
clearAutoCloseAttempt(key);
}
const targetPaneId=existingSubagentPaneId();
let plan;
if(targetPaneId!==null){
plan={openOptions:{kind:SUBAGENT_CHAT_KIND,paneId:targetPaneId,preferNewPane:false},splitToken:null};
}else if(splitSidebarPane===null){
plan={openOptions:{kind:SUBAGENT_CHAT_KIND,preferNewPane:true},splitToken:null};
}else{
const splitState=beginSidebarSplitPreparation(action,deps);
if(splitState===null)return;
if(splitState.waitForLayout===true){
return completeSidebarSplitPreparation(action,deps,splitState).then((splitPlan)=>{
if(splitPlan===null)return;
if(issueSidebarResourceOpen(action,deps,splitPlan)!==true)return;
finishSidebarResourceOpen(action,deps,splitPlan);
});
}
plan=finishSidebarSplitPreparation(action,deps,splitState);
}
if(plan===null)return;
if(issueSidebarResourceOpen(action,deps,plan)!==true)return;
finishSidebarResourceOpen(action,deps,plan);
}
function beginSidebarSplitPreparation(action,deps){
const{
beginSidebarSplit,config,readSidebarOpenTabs,rootSessionId,sidebarSessionId,sidebarSplitIntentRef,
sidebarTabOpeningRef,
}=deps;
const{key,resourceAddress}=action;
const tabsBeforeSplit=readSidebarOpenTabs();
let splitToken=null;
if(beginSidebarSplit===null)return{splitToken,tabsBeforeSplit,waitForLayout:false};
let preparation=null;
try{
preparation=beginSidebarSplit.call(config,{
sessionId:sidebarSessionId,
rootSessionId,
key,
resourceAddress,
});
}catch{
preparation=null;
}
if(preparation?.busy===true){
sidebarTabOpeningRef.current.delete(key);
return;
}
if(preparation===null||typeof preparation!=="object"
||preparation.token===null||preparation.token===undefined){
sidebarTabOpeningRef.current.delete(key);
return;
}
splitToken=preparation.token;
if(splitToken!==null){
sidebarSplitIntentRef.current={
token:splitToken,
key,
resourceAddress,
paneId:null,
resourceIssued:false,
};
}
return{splitToken,tabsBeforeSplit,waitForLayout:true};
}
async function completeSidebarSplitPreparation(action,deps,state){
const{
cancelPendingSidebarSplit,sidebarSplitIntentRef,sidebarSurfaceStillCurrent,
sidebarTabOpeningRef,waitForSidebarSplitLayoutCommit,
}=deps;
const{key}=action;
const{splitToken}=state;
await waitForSidebarSplitLayoutCommit();
const splitStillCurrent=sidebarSurfaceStillCurrent()===true
&&sidebarSplitIntentRef.current?.token===splitToken;
if(!splitStillCurrent){
if(sidebarSplitIntentRef.current?.token===splitToken)cancelPendingSidebarSplit("split-stale");
sidebarTabOpeningRef.current.delete(key);
return null;
}
const afterLayoutReview=reviewAutoSideEffect(action,deps);
if(afterLayoutReview==="abort"){
settleAbortedAutoSideEffect(action,deps);// 放弃 + 关闭意图登记，与 open 前的复核点共用同一段
return null;
}
if(afterLayoutReview==="manual")action.effectiveOrigin=SIDEBAR_TAB_ORIGIN_MANUAL;
return finishSidebarSplitPreparation(action,deps,state);
}
function finishSidebarSplitPreparation(action,deps,state){
const{
cancelPendingSidebarSplit,config,markSidebarSplitPane,seededGuideTabId,sidebarRight,sidebarSessionId,
sidebarSplitIntentRef,sidebarTabOpeningRef,splitSidebarPane,
}=deps;
const{key}=action;
const{splitToken,tabsBeforeSplit}=state;
let paneId=null;
try{paneId=splitSidebarPane.call(sidebarRight);}catch{paneId=null;}
if(typeof paneId!=="string"||paneId.trim()===""){
if(splitToken!==null)cancelPendingSidebarSplit("split-failed");
sidebarTabOpeningRef.current.delete(key);
return null;
}
if(splitToken!==null){
let accepted=true;
if(markSidebarSplitPane!==null){
try{accepted=markSidebarSplitPane.call(config,splitToken,paneId)!==false;}catch{accepted=false;}
}
if(!accepted){
cancelPendingSidebarSplit("pane-rejected");
sidebarTabOpeningRef.current.delete(key);
return null;
}
if(sidebarSplitIntentRef.current?.token===splitToken){
sidebarSplitIntentRef.current.paneId=paneId;
}
}
const guideTabId=seededGuideTabId(tabsBeforeSplit,sidebarSessionId);
const openOptions={kind:SUBAGENT_CHAT_KIND,paneId,preferNewPane:false};
if(guideTabId!==null)openOptions.replaceTab=guideTabId;
return{openOptions,splitToken};
}
function issueSidebarResourceOpen(action,deps,plan){
const{
openSidebarResource,rootSessionId,sidebarAutoOriginRef,sidebarResourceTabStateOf,
sidebarSessionId,sidebarTabOpeningRef,sidebarRight,
}=deps;
const{autoContext,key,resourceAddress}=action;
const{openOptions}=plan;
const beforeOpenReview=reviewAutoSideEffect(action,deps);
if(beforeOpenReview==="abort"){
settleAbortedAutoSideEffect(action,deps);// 同上：同一段收口，登记到同一个 ref / Map
return false;
}
if(beforeOpenReview==="manual")action.effectiveOrigin=SIDEBAR_TAB_ORIGIN_MANUAL;
let openProof=null;
if(autoContext!==null){
const openWitness=sidebarResourceTabStateOf(resourceAddress);
const autoProven=openWitness.readable===true&&openWitness.tabId===null;
openProof={autoProven};
if(autoProven!==true){
recordSidebarAutoDecision("open",{key,kind:"open"},"downgrade","causal-unproven");
}
const pendingOpening=sidebarTabOpeningRef.current.get(key);
if(pendingOpening!==undefined
&&pendingOpening.sessionId===sidebarSessionId&&pendingOpening.rootSessionId===rootSessionId){
pendingOpening.causalProof=autoProven===true?"proven":"failed";
}
}
const issuedOpening=autoContext===null?undefined:sidebarTabOpeningRef.current.get(key);
const issuedOpeningScoped=issuedOpening!==undefined
&&issuedOpening.sessionId===sidebarSessionId&&issuedOpening.rootSessionId===rootSessionId
?issuedOpening
:undefined;
const issuedAtBefore=issuedOpeningScoped===undefined
||issuedOpeningScoped.causalIssuedAt===null||issuedOpeningScoped.causalIssuedAt===undefined
?null
:issuedOpeningScoped.causalIssuedAt;
if(issuedOpeningScoped!==undefined)issuedOpeningScoped.causalIssuedAt=Date.now();
try{
openSidebarResource.call(sidebarRight,resourceAddress,openOptions);
}catch(error){
if(issuedOpeningScoped!==undefined)issuedOpeningScoped.causalIssuedAt=issuedAtBefore;
throw error;
}
action.openIssued=true;
action.openProof=openProof;
if(action.effectiveOrigin===SIDEBAR_TAB_ORIGIN_AUTO&&action.canTrackOpen===true
&&openProof!==null&&openProof.autoProven===true){
const landedOriginEntry=sidebarAutoOriginRef.current.get(key);
if(sidebarAutoOriginTabIdOf(landedOriginEntry)===null){
sidebarAutoOriginRef.current.set(
key,
sidebarAutoOriginEntry(sidebarSessionId,rootSessionId,resourceAddress,null),
);
}
}
return true;
}
function finishSidebarResourceOpen(action,deps,plan){
const{
cancelPendingSidebarSplit,config,markSidebarSplitOpen,recordSidebarTab,sidebarSplitIntentRef,
sidebarSurfaceStillCurrent,sidebarTabOpeningRef,syncSidebarTabs,
}=deps;
const{effectiveOrigin,key,openProof,resourceAddress}=action;
const{splitToken}=plan;
if(splitToken!==null){
let acknowledged=true;
if(markSidebarSplitOpen!==null){
try{acknowledged=markSidebarSplitOpen.call(config,splitToken)!==false;}catch{acknowledged=false;}
}
if(!acknowledged){
cancelPendingSidebarSplit("resource-not-acknowledged");
}else if(sidebarSplitIntentRef.current?.token===splitToken){
sidebarSplitIntentRef.current.resourceIssued=true;
}
}
const opened=recordSidebarTab(key,resourceAddress,effectiveOrigin,openProof);
if(opened)sidebarTabOpeningRef.current.delete(key);
if(sidebarSurfaceStillCurrent()===true)syncSidebarTabs();
}
function useSidebarPanelActionHandlersPart2(frame){
const{
abandonAutoSidebarAction,autoActionStillValid,cancelPendingSidebarSplit,closeSidebarResource,openSidebarResource,
recordSidebarManualIntent,sidebarSplitIntentRef,sidebarTabOpeningRef,sidebarTabPendingRef,sidebarTabVisible,sidebarTabRecordsRef,
}=frame;
const handleSidebarAction=async(key,resourceAddress,actionOrigin,autoAction)=>{
const action=createSidebarActionContext(frame,key,resourceAddress,actionOrigin,autoAction);
if(action===null)return;
const pending=sidebarTabPendingRef.current;
if(pending.has(key)){
if(action.origin===SIDEBAR_TAB_ORIGIN_MANUAL)recordSidebarManualIntent(key,resourceAddress);
return;
}
pending.add(key);
try{
if(action.autoContext!==null&&autoActionStillValid(action.autoContext)!==true){
abandonAutoSidebarAction(key,action.autoContext);
return;
}
const record=sidebarTabRecordsRef.current.get(key);
if(record===undefined&&sidebarTabOpeningRef.current.has(key)){
if(action.origin===SIDEBAR_TAB_ORIGIN_MANUAL)recordSidebarManualIntent(key,resourceAddress);
return;
}
if(record!==undefined&&closeSidebarResource!==null&&(sidebarTabVisible(record)||action.autoContext!==null)){
await closeSidebarActionWithLease(action,frame,record);
return;
}
if(openSidebarResource===null)return;
const openResult=runSidebarOpenAction(action,frame);
if(openResult!==null&&openResult!==undefined&&typeof openResult.then==="function"){
await openResult;
}
}catch{
if(sidebarSplitIntentRef.current?.key===key)cancelPendingSidebarSplit("resource-failed");
sidebarTabOpeningRef.current.delete(key);
}finally{
finishSidebarAction(action,frame);
}
};
frame.late.handleSidebarAction=handleSidebarAction;
Object.assign(frame,{
handleSidebarAction,
});
}
function finishSidebarAction(action,deps){
const{
applyPendingManualIntent,sidebarAutoFailedKeysRef,sidebarAutoOriginRef,sidebarAutoReservationRef,
sidebarSurfaceStillCurrent,sidebarTabPendingRef,
}=deps;
const{autoContext,key,openIssued}=action;
sidebarTabPendingRef.current.delete(key);
const surfaceCurrent=sidebarSurfaceStillCurrent()===true;
if(autoContext!==null){
sidebarAutoReservationRef.current.delete(key);
if(surfaceCurrent===true&&autoContext.kind==="open"&&openIssued!==true){
sidebarAutoOriginRef.current.delete(key);
sidebarAutoFailedKeysRef.current.add(key);
}
if(surfaceCurrent===true&&openIssued===true)sidebarAutoFailedKeysRef.current.delete(key);
}
if(surfaceCurrent===true)applyPendingManualIntent(key);
}
function useSidebarPanelBatchClose(frame){
const{
bump,closeSidebarResource,closeSidebarTabWithLease,rootSessionId,sidebarBatchPendingRef,sidebarBatchScopeKey,
sidebarSessionId,sidebarSurfaceStillCurrent,sidebarTabPresenceInInventory,syncSidebarTabs,
}=frame;
const handleSidebarBatchClose=async(candidates)=>{
if(sidebarSurfaceStillCurrent()!==true)return;
if(closeSidebarResource===null)return;
if(Array.isArray(candidates)!==true||candidates.length===0)return;
const scopeKey=sidebarBatchScopeKey(sidebarSessionId,rootSessionId);
const pendingScopes=sidebarBatchPendingRef.current;
if(pendingScopes.has(scopeKey)===true)return;
pendingScopes.add(scopeKey);
bump((value)=>value+1);
try{
for(const candidate of candidates){
if(sidebarSurfaceStillCurrent()!==true)return;
const tabId=text(object(candidate).tabId,null);
const candidateAddress=text(object(candidate).address,null);
if(tabId===null||candidateAddress===null)continue;
if(sidebarTabPresenceInInventory(tabId,candidateAddress)!=="present")continue;
writeSidebarAutoOwnership(sidebarSessionId,rootSessionId,candidateAddress,SIDEBAR_AUTO_OWNERSHIP_ORIGIN_MANUAL,"manual-close");
await closeSidebarTabWithLease(tabId,{
waitForCompeting:true,
verify:{key:null,address:candidateAddress,attemptToken:null,manual:true},
});
if(sidebarSurfaceStillCurrent()!==true)return;
}
}finally{
pendingScopes.delete(scopeKey);
if(sidebarSurfaceStillCurrent()===true){
bump((value)=>value+1);
syncSidebarTabs();
}
}
};
Object.assign(frame,{
handleSidebarBatchClose,
});
}
function useSidebarPanelRunAction(frame){
const{
bump,catalogEntryOf,config,contextRef,currentRootRef,metaRefreshRef,metaStateRef,mountedRef,react,
refreshRef,setState,
}=frame;
const runtimeStatusOfNode=(node,parentId,childId,options)=>runtimeStatusOf(
node,
catalogEntryOf(parentId,childId??text(object(node).sessionId,null)),
options,
);
const pendingSet=typeof react.useRef==="function"?react.useRef(new Set()):{current:new Set()};
const recoveryRetryRef=typeof react.useRef==="function"
?react.useRef({rootSessionId:null,inFlight:false,error:null})
:{current:{rootSessionId:null,inFlight:false,error:null}};
const runAction=async(request,key,requiresConfirm,message,options)=>{
const actionOptions=object(options);
if(mountedRef.current!==true)return null;
if(pendingSet.current.has(key))return null;
pendingSet.current.add(key);
bump((value)=>value+1);
setState((previous)=>{
const current=previous.error;
if(current===null||(current.source!==PANEL_ERROR_SOURCES.action&&current.source!==PANEL_ERROR_SOURCES.rpc)){
return previous;
}
return{...previous,error:null};
});
try{
if(requiresConfirm){
if(typeof config.confirm!=="function")return null;
let accepted=false;
try{accepted=await config.confirm(message);}catch{accepted=false;}
if(accepted!==true)return null;
if(mountedRef.current!==true)return null;
}
const targetSessionId=typeof currentRootRef.current==="string"?currentRootRef.current:"";
if(targetSessionId==="")return null;
const result=await callRpc(config,contextRef.current,{...request,sessionId:targetSessionId});
if(mountedRef.current!==true)return null;
await refreshRef.current();
if(metaStateRef.current!==null&&actionOptions.refreshMeta!==false){
const refreshMeta=metaRefreshRef.current;
if(typeof refreshMeta==="function")void refreshMeta();
}
return result;
}catch(error){
if(mountedRef.current!==true)return null;
let message=error instanceof Error?error.message:String(error);
if(actionOptions.safeMessage===true){
const redact=modelFunction("redactDisplayText");
const clean=redact===null?message:redact(message,200);
message=clean===""?message:clean;
}
const code=actionOptions.includeErrorCode===true?text(object(error).code,null):null;
if(code!==null)message=code+" · "+message;
const source=rpcFailureKindOf(error)===RPC_FAILURE_TRANSPORT
?PANEL_ERROR_SOURCES.rpc
:PANEL_ERROR_SOURCES.action;
const at=Date.now();
setState((previous)=>({...previous,error:{source,message,at}}));
return null;
}finally{
pendingSet.current.delete(key);
if(mountedRef.current===true)bump((value)=>value+1);
}
};
frame.late.runtimeStatusOfNode=runtimeStatusOfNode;
Object.assign(frame,{
pendingSet,recoveryRetryRef,runAction,runtimeStatusOfNode,
});
}
function useSidebarPanelRunActionPart2(frame){
const{
bump,config,contextRef,currentRootRef,mountedRef,recoveryRetryRef,refreshRef,
}=frame;
const retryRecovery=async()=>{
if(mountedRef.current!==true)return;
const targetSessionId=typeof currentRootRef.current==="string"?currentRootRef.current:"";
if(targetSessionId==="")return;
const previous=recoveryRetryRef.current;
if(previous.rootSessionId===targetSessionId&&previous.inFlight===true)return;
recoveryRetryRef.current={rootSessionId:targetSessionId,inFlight:true,error:null};
bump((value)=>value+1);
let failure=null;
try{
const result=await callRpc(config,contextRef.current,{
action:"fanout-restore-retry",
sessionId:targetSessionId,
});
if(result?.restored!==true){
const error=object(result?.error);
const code=text(error.code,null);
failure=code===null
?{code:"NO_RESTORABLE_SNAPSHOT",message:"当前没有可恢复的持久化任务"}
:{code,message:text(error.message,"")};
}
}catch(error){
failure={
code:"RETRY_FAILED",
message:error instanceof Error?error.message:String(error),
};
}
const stillCurrent=mountedRef.current===true&&currentRootRef.current===targetSessionId;
recoveryRetryRef.current={rootSessionId:targetSessionId,inFlight:false,error:stillCurrent?failure:null};
if(stillCurrent!==true)return;
bump((value)=>value+1);
await refreshRef.current();
};
Object.assign(frame,{
retryRecovery,
});
}
global[SYMBOL]=Object.freeze({
useSidebarPanelActionHandlers,useSidebarPanelActionHandlersPart2,useSidebarPanelBatchClose,
useSidebarPanelRunAction,useSidebarPanelRunActionPart2,useSidebarPanelTabRecorder,
useSidebarPanelTabRecorderPart2,
});
})(globalThis);
/* source: client-sidebar-panel.js */
(function installSidebarPanel(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
SIDEBAR_AUTO_KEY_LIMIT,TIMELINE_EXPANDED_KEY_LIMIT,modelApi,object,
text,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
createCatalogLookup,currentSessionIdOf,listSnapshot,makeIcon,
methodOf,resolveClientService,runtimeStatusOf,statusIcon,
styleTag,
}=DOM;
const POLL_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-poll");
const POLL=global[POLL_SYMBOL]||{};
const{
readPanelTabActivity,
}=POLL;
const AUTO_LEDGER_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-auto-ledger");
const AUTO_LEDGER=global[AUTO_LEDGER_SYMBOL]||{};
const{
clearSidebarAutoManualSuppressions,recordSidebarAutoDiag,resolveSidebarSharedAutoLedger,
sidebarSharedAutoLedgerSizes,sidebarSharedAutoLedgerTotal,
}=AUTO_LEDGER;
const PANEL_CACHE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-cache");
const PANEL_CACHE=global[PANEL_CACHE_SYMBOL]||{};
const{
createPanelSnapshotCache,
}=PANEL_CACHE;
const PANEL_STATE_A_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-state-a");
const PANEL_STATE_A=global[PANEL_STATE_A_SYMBOL]||{};
const VIEWS_A_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-a");
const VIEWS_A=global[VIEWS_A_SYMBOL]||{};
const VIEWS_B_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-b");
const VIEWS_B=global[VIEWS_B_SYMBOL]||{};
const VIEWS_C_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-views-c");
const VIEWS_C=global[VIEWS_C_SYMBOL]||{};
const HOOKS_STATE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-state");
const HOOKS_STATE=global[HOOKS_STATE_SYMBOL]||{};
const{
useSidebarPanelHostServices,useSidebarPanelPeakValleyMarker,useSidebarPanelSessionModel,useSidebarPanelSessionModelPart2,
useSidebarPanelSnapshotDerived,useSidebarPanelStateCore,useSidebarPanelStoreAndMeta,
useSidebarPanelWidth,
}=HOOKS_STATE;
const HOOKS_EFFECTS_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-effects");
const HOOKS_EFFECTS=global[HOOKS_EFFECTS_SYMBOL]||{};
const{
useSidebarPanelActivityEffect,useSidebarPanelAnnouncementEffect,useSidebarPanelLiveTick,
useSidebarPanelMetaEffect,useSidebarPanelMountEffects,useSidebarPanelPolling,useSidebarPanelProjectionEffect,
useSidebarPanelSessionModelEffects,useSidebarPanelSnapshotRefs,useSidebarPanelSnapshotSyncEffect,
}=HOOKS_EFFECTS;
const HOOKS_TABS_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-tabs");
const HOOKS_TABS=global[HOOKS_TABS_SYMBOL]||{};
const{
useSidebarPanelAutoOrchestration,useSidebarPanelAutoOrchestrationPart2,useSidebarPanelAutoRefs,
useSidebarPanelTabPrimitives,useSidebarPanelTabSync,useSidebarPanelTabWiring,
useSidebarPanelTabWiringPart2,useSidebarPanelTabWiringPart3,
}=HOOKS_TABS;
const HOOKS_ACTIONS_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel-hooks-actions");
const HOOKS_ACTIONS=global[HOOKS_ACTIONS_SYMBOL]||{};
const{
useSidebarPanelActionHandlers,useSidebarPanelActionHandlersPart2,useSidebarPanelBatchClose,
useSidebarPanelRunAction,useSidebarPanelRunActionPart2,useSidebarPanelTabRecorder,
useSidebarPanelTabRecorderPart2,
}=HOOKS_ACTIONS;
function createSidebarPanelShared(deps){
const{config,react,primitives}=deps;
styleTag();
const panelSnapshotCache=createPanelSnapshotCache();
const peekCachedSnapshot=panelSnapshotCache.peek;
const writeCachedSnapshot=panelSnapshotCache.write;
const initialStateFor=panelSnapshotCache.initialStateFor;
const sharedAutoLedgerState=resolveSidebarSharedAutoLedger();
const sharedAutoLedger=sharedAutoLedgerState.ledger;
recordSidebarAutoDiag({
kind:"install",
reused:sharedAutoLedgerState.reused,
degraded:sharedAutoLedgerState.degraded,
sizes:sidebarSharedAutoLedgerSizes(sharedAutoLedger),
});
if(sharedAutoLedgerState.reused===true&&sharedAutoLedgerState.degraded!==true
&&sidebarSharedAutoLedgerTotal(sharedAutoLedger)>0){
try{
console.info("[dsh-expert-group] 本 realm 已有共享 Auto 账本：本次装载复用既有的归属 / 预算 / 确认计数（bundle 重新执行或 HMR）");
}catch{/* 控制台不可用不影响功能。 */}
}
const sharedSidebarAutoOrigin=sharedAutoLedger.origin;
const sharedSidebarAutoSuppressed=sharedAutoLedger.suppressed;
const sharedSidebarAutoCloseAttempts=sharedAutoLedger.closeAttempts;
const sharedSidebarAutoCloseAttemptOwners=sharedAutoLedger.closeAttemptOwners;
const sharedSidebarAutoCloseVerifications=sharedAutoLedger.closeVerifications;
const sharedSidebarAutoCloseCooldowns=sharedAutoLedger.closeCooldowns;
const sharedSidebarAutoTabMisses=sharedAutoLedger.tabMisses;
const trimSharedSidebarAutoTabMisses=()=>{
while(sharedSidebarAutoTabMisses.size>SIDEBAR_AUTO_KEY_LIMIT){
const oldest=sharedSidebarAutoTabMisses.keys().next();
if(oldest.done===true)break;
sharedSidebarAutoTabMisses.delete(oldest.value);
}
};
const sharedSidebarTabCloseInFlight=sharedAutoLedger.tabCloseInFlight;
return{
config,react,primitives,
panelSnapshotCache,peekCachedSnapshot,writeCachedSnapshot,initialStateFor,
sharedAutoLedgerState,sharedAutoLedger,
sharedSidebarAutoOrigin,sharedSidebarAutoSuppressed,sharedSidebarAutoCloseAttempts,
sharedSidebarAutoCloseAttemptOwners,sharedSidebarAutoCloseVerifications,sharedSidebarAutoCloseCooldowns,
sharedSidebarAutoTabMisses,trimSharedSidebarAutoTabMisses,sharedSidebarTabCloseInFlight,
};
}
function createSidebarPanelFrame(props,shared){
const{config}=shared;
const frame=Object.assign(Object.create(null),shared);
frame.props=props;
frame.late=Object.create(null);
const ctx=props?.ctx||config.ctx;
let tabInfo=null;
if(typeof props?.useTabInfo==="function"){
try{tabInfo=props.useTabInfo();}catch{tabInfo=null;}
}
const tabParams=object(tabInfo?.tab?.navigation?.params);
const sessionsSnapshot=listSnapshot(config,ctx);
const catalogEntryOf=createCatalogLookup(sessionsSnapshot);
const fallbackCurrent=currentSessionIdOf(sessionsSnapshot);
const scopedId=typeof config.sessions?.scopeOf==="function"?config.sessions.scopeOf(ctx):undefined;
const scope=props?.scope||props?.tab?.scope||tabInfo?.scope||{};
const sessionId=text(scope.sessionId,text(props?.sessionId,text(props?.rootSessionId,text(tabParams.rootSessionId,text(scopedId,fallbackCurrent)))));
let resolvedRoot=sessionId;
if(typeof config.resolveRootSessionId==="function"&&sessionId!==null){
try{resolvedRoot=text(config.resolveRootSessionId(sessionId,undefined,listSnapshot(config,ctx)),sessionId);}catch{resolvedRoot=sessionId;}
}
const rootSessionId=resolvedRoot||"";
const sidebarSessionId=sessionId||rootSessionId;
const tabActivity=readPanelTabActivity(config,props,tabInfo);
const tabActivityKey=tabActivity===true?"active":(tabActivity===false?"inactive":"unknown");
const model=modelApi();
const panelLocale=PANEL_STATE_A.resolvePanelLocale(model,ctx,tabInfo);
const t=PANEL_STATE_A.createPanelTranslator(model,panelLocale);
const errorLabelOf=(source)=>PANEL_STATE_A.errorLabelOf(t,source);
const serviceCandidates=[config,ctx,config.ctx];
const sessionsService=resolveClientService(serviceCandidates,"sessions");
const sidebarRight=resolveClientService(serviceCandidates,"sidebarRight");
const requestRightbarDragSync=typeof config.syncRightbarDragLock==="function"?config.syncRightbarDragLock:null;
const releaseRightbarDragLock=typeof config.releaseRightbarDragLock==="function"?config.releaseRightbarDragLock:null;
const beginSidebarSplit=typeof config.beginSidebarSplit==="function"?config.beginSidebarSplit:null;
const markSidebarSplitPane=typeof config.markSidebarSplitPane==="function"?config.markSidebarSplitPane:null;
const markSidebarSplitOpen=typeof config.markSidebarSplitOpen==="function"?config.markSidebarSplitOpen:null;
const commitSidebarSplit=typeof config.commitSidebarSplit==="function"?config.commitSidebarSplit:null;
const cancelSidebarSplit=typeof config.cancelSidebarSplit==="function"?config.cancelSidebarSplit:null;
const openSidebarResource=methodOf(sidebarRight,"openResource");
Object.assign(frame,{
ctx,tabInfo,sessionsSnapshot,catalogEntryOf,scope,
clearSidebarAutoManualSuppressions,
sessionId,rootSessionId,sidebarSessionId,tabActivityKey,
model,panelLocale,t,errorLabelOf,
sessionsService,sidebarRight,requestRightbarDragSync,releaseRightbarDragLock,
beginSidebarSplit,markSidebarSplitPane,markSidebarSplitOpen,commitSidebarSplit,cancelSidebarSplit,
openSidebarResource,
});
return frame;
}
function peakValleyLabelTextOf(config,panelLocale,marker){
const extra=config?.settingsExtraText;
if(typeof extra!=="function"||marker?.enabled!==true)return null;
return extra(panelLocale,"settings.pv.entry")+" "+extra(panelLocale,
marker.period==="peak"?"settings.pv.peak":"settings.pv.valley");
}
function useSidebarPanelViews(frame){
const{
bump,catalogEntryOf,clearSessionModelRole,closeSidebarResource,commitSessionModelChanges,config,
expand,handleOpen,handleSidebarAction,handleSidebarBatchClose,meta,model,
navigation,neutralRuntimeStatus,openSidebarResource,partialSnapshot,primitives,react,
readActiveSidebarResource,restoreSessionModelDefaults,rootSessionId,sessionId,sessionModelCatalog,sessionModelDialogRef,sessionModelDrafts,
sessionModelHasInvalidDraft,sessionModelNotice,sessionModelOpen,sessionModelPendingChanges,
sessionModelSaving,sessionModelState,
sessionsSnapshot,sidebarBatchPendingRef,sidebarBatchScopeKey,sidebarBatchStateFor,sidebarOpenTabsAvailable,sidebarSessionId,
sidebarTabVisible,sidebarTabRecordsRef,snapshot,subagentAddressOfChild,t,timelineExpandedRef,toggle,
updateSessionModelDraft,
}=frame;
const isTimelineExpanded=(key)=>timelineExpandedRef.current.has(key)===true;
const toggleTimelineExpanded=(key)=>{
const expandedKeys=timelineExpandedRef.current;
if(expandedKeys.has(key))expandedKeys.delete(key);
else{
expandedKeys.add(key);
while(expandedKeys.size>TIMELINE_EXPANDED_KEY_LIMIT){
const oldest=expandedKeys.values().next();
if(oldest.done===true)break;
expandedKeys.delete(oldest.value);
}
}
bump((value)=>value+1);
};
const isBatchPending=()=>sidebarBatchPendingRef.current.has(
sidebarBatchScopeKey(sidebarSessionId,rootSessionId),
)===true;
const isTabOpen=(key)=>sidebarTabVisible(sidebarTabRecordsRef.current.get(key));
const getPeakValleyMarker=()=>frame.peakValleyMarker??null;
const peakValleyLabelOf=(marker)=>peakValleyLabelTextOf(config,frame.panelLocale,marker);
const viewCtx={
react,primitives,t,model,meta,snapshot,sessionsSnapshot,config,
sessionId,sidebarSessionId,rootSessionId,catalogEntryOf,
handleSidebarAction,handleSidebarBatchClose,
openSidebarResource,closeSidebarResource,readActiveSidebarResource,sidebarOpenTabsAvailable,
sidebarBatchStateFor,toggle,expand,handleOpen,subagentAddressOfChild,navigation,
isBatchPending,isTabOpen,isTimelineExpanded,toggleTimelineExpanded,
partialSnapshot,neutralRuntimeStatus,
sessionModelOpen,sessionModelState,sessionModelCatalog,sessionModelSaving,sessionModelNotice,
sessionModelDrafts,sessionModelHasInvalidDraft,sessionModelPendingChanges,sessionModelDialogRef,
updateSessionModelDraft,clearSessionModelRole,commitSessionModelChanges,restoreSessionModelDefaults,
getPeakValleyMarker,peakValleyLabelOf,
};
const viewsA=VIEWS_A.createSidebarViewsA(viewCtx);
const{renderChevron,renderSidebarBatchSlot}=viewsA;
const viewsB=VIEWS_B.createSidebarViewsB(viewCtx,viewsA);
const{sessionStatsPresentOf,renderMetrics,renderRowMain}=viewsB;
Object.assign(frame,{
isBatchPending,isTabOpen,isTimelineExpanded,renderChevron,renderMetrics,renderRowMain,
renderSidebarBatchSlot,sessionStatsPresentOf,toggleTimelineExpanded,viewCtx,viewsA,viewsB,
});
}
function useSidebarPanelProjectionRef(frame){
const{
react,
}=frame;
const projectionRefreshRequestedRef=typeof react.useRef==="function"
?react.useRef(new Set())
:{current:new Set()};
Object.assign(frame,{
projectionRefreshRequestedRef,
});
}
function assembleSidebarPanelBody(frame){
const{
emptyFilter,errorLabelOf,expand,filterState,idleSidebarResourceAddresses,model,
partialSnapshot,pendingSet,react,recoveryRetryRef,renderSidebarBatchSlot,retryRecovery,
rootSessionId,runAction,runningSidebarResourceAddresses,runtimeStatusOfNode,sessionModelEntryRef,setFilterState,
setSessionModelOpen,setSessionModelReloadToken,sidebarIdleChildren,snapshot,t,viewCtx,
viewsA,viewsB,
}=frame;
const children=Array.isArray(snapshot?.root?.children)?snapshot.root.children:[];
const{filterSource,taskFilter,filterActive,passesFilter}=PANEL_STATE_A.selectTaskFilter(
model,
filterState,
rootSessionId,
emptyFilter,
);
const updateFilter=(patch)=>{
setFilterState(PANEL_STATE_A.nextFilterPatch(filterSource,patch,rootSessionId));
};
const idleChildren=sidebarIdleChildren();
const visibleChildren=children.filter((node)=>!idleChildren.includes(node)).filter((node)=>passesFilter(node));
const visibleIdleChildren=filterActive===true?idleChildren.filter((node)=>passesFilter(node)):idleChildren;
const rootBatchSlot=filterActive===true?null:renderSidebarBatchSlot(runningSidebarResourceAddresses(),"运行中的子代理");
const idleBatchSlot=filterActive===true?null:renderSidebarBatchSlot(idleSidebarResourceAddresses(idleChildren),t("sidebar.idleGroup.name"));
const root=snapshot?.root;
const isActionPending=(key)=>pendingSet.current.has(key)===true;
const toggleSessionModelDialog=()=>setSessionModelOpen((previous)=>previous!==true);
const closeSessionModelDialog=()=>setSessionModelOpen(false);
const retrySessionModelLoad=()=>setSessionModelReloadToken((value)=>value+1);
const viewsC=VIEWS_C.createSidebarViewsC({
...viewCtx,
root,filterSource,updateFilter,passesFilter,filterActive,taskFilter,
runAction,isActionPending,runtimeStatusOfNode,sessionModelEntryRef,
closeSessionModelDialog,toggleSessionModelDialog,retrySessionModelLoad,
},viewsA,viewsB);
const{renderExpert,renderIdleGroup,renderFanout,renderToolbar,renderSessionModelDialog}=viewsC;
const rootOpen=root===null?true:expand(root);
const idleGroupVisible=!(filterActive===true&&visibleIdleChildren.length===0);
const rootSiblingCount=visibleChildren.length+(idleGroupVisible?1:0);
const rootStatus=runtimeStatusOf(root,null,{partial:partialSnapshot});
const recovery=snapshot?.recovery??null;
const recoveryFailed=recovery!==null&&recovery.status==="failed";
const recoveryRetry=recoveryRetryRef.current;
const recoveryRetryPending=recoveryRetry.inFlight===true&&recoveryRetry.rootSessionId===rootSessionId;
const recoveryCode=recovery===null?null:text(recovery.code,"RESTORE_FAILED");
const recoveryRetryError=recoveryFailed===true
&&recoveryRetry.rootSessionId===rootSessionId
&&recoveryRetry.error!==null
&&(recoveryRetry.error.code===recoveryCode
||recoveryRetry.error.code==="RETRY_FAILED"
||recoveryRetry.error.code==="NO_RESTORABLE_SNAPSHOT")
?recoveryRetry.error
:null;
const recoveryMessage=recovery===null?null:text(recovery.message,null);
const recoveryBanner=recoveryFailed!==true
?null
:react.createElement("div",{
className:"deg_expert_group_recovery",
role:"alert",
"data-recovery-status":"failed",
"data-recovery-code":recoveryCode,
title:recoveryMessage===null?"恢复失败（"+recoveryCode+"）":recoveryMessage,
},
react.createElement("span",{className:"deg_expert_group_recovery_text"},
"任务恢复失败（"+recoveryCode+"）"+(recoveryMessage===null?"":"："+recoveryMessage)),
recoveryRetryError===null
?null
:react.createElement("span",{className:"deg_expert_group_recovery_retry_error",role:"status"},
"重试未恢复（"+text(recoveryRetryError.code,"RETRY_FAILED")+"）"
+(text(recoveryRetryError.message,"")===""?"":"："+text(recoveryRetryError.message,""))),
react.createElement("button",{
type:"button",
className:"deg_expert_group_recovery_retry",
title:recovery.retryable===false
?"该原因通常需要修复持久化快照后才能恢复；点击会重新读取当前持久化快照"
:"重新读取当前持久化快照并重跑恢复",
"aria-label":t("sidebar.recovery.retry"),
"aria-busy":recoveryRetryPending||undefined,
disabled:recoveryRetryPending,
onClick:retryRecovery,
},recoveryRetryPending?t("sidebar.recovery.retrying"):t("sidebar.recovery.retry")));
const errorEmptyState=(panelError)=>react.createElement("div",{
className:"deg_expert_group_empty deg_expert_group_error_empty",
role:"alert",
"data-error-source":panelError.source,
title:panelError.message,
},
react.createElement("div",{className:"deg_expert_group_error_empty_title"},
errorLabelOf(panelError.source)),
react.createElement("div",{className:"deg_expert_group_error_empty_detail"},panelError.message));
Object.assign(frame,{
children,closeSessionModelDialog,errorEmptyState,filterActive,filterSource,idleBatchSlot,
idleChildren,idleGroupVisible,isActionPending,passesFilter,recovery,recoveryBanner,
renderExpert,renderFanout,renderIdleGroup,renderSessionModelDialog,renderToolbar,retrySessionModelLoad,
root,rootBatchSlot,rootOpen,rootSiblingCount,rootStatus,taskFilter,
toggleSessionModelDialog,updateFilter,visibleChildren,visibleIdleChildren,
});
}
function assembleSidebarPanelBodyPart2(frame){
const{
errorEmptyState,filterActive,idleBatchSlot,idleChildren,idleGroupVisible,primitives,
react,renderChevron,renderExpert,renderFanout,renderIdleGroup,renderMetrics,
renderRowMain,renderToolbar,root,rootBatchSlot,rootOpen,rootSessionId,
rootSiblingCount,rootStatus,snapshot,t,taskFilter,viewState,
visibleChildren,visibleIdleChildren,
}=frame;
const body=viewState.loading&&snapshot===null
?react.createElement("div",{className:"deg_expert_group_tree","aria-busy":"true"},react.createElement("div",{className:"deg_expert_group_skeleton"}),react.createElement("div",{className:"deg_expert_group_skeleton"}))
:snapshot===null&&viewState.error!==null
?errorEmptyState(viewState.error)
:snapshot===null
?react.createElement("div",{className:"deg_expert_group_empty"},t("sidebar.empty"))
:react.createElement("div",{className:"deg_expert_group_tree"},
renderToolbar(),
react.createElement("div",{className:"deg_expert_group_tree_items",role:"tree","aria-label":"专家任务树"},
react.createElement("div",{className:"deg_expert_group_node deg_expert_group_node_root",role:"none","data-root":"true"},
react.createElement("div",{
className:"deg_expert_group_row",
role:"treeitem",
"aria-level":1,
"aria-posinset":1,
"aria-setsize":1,
"aria-expanded":rootOpen,
"data-status":rootStatus,
"data-expanded":rootOpen,
},statusIcon(react,primitives,rootStatus),renderChevron(root,rootOpen),react.createElement("div",null,renderRowMain(root,{
sessionId:root.sessionId,
parentId:null,
expanded:true,
trailing:rootBatchSlot,
metrics:renderMetrics(root,{kind:"root",runtimeStatus:rootStatus,sessionId:root.sessionId,sessionIds:[root.sessionId]}),
}))),
rootOpen?react.createElement("div",{className:"deg_expert_group_children",role:"group"},[
...visibleChildren.map((node,index)=>node.kind==="fanout"
?renderFanout(node,index,{level:2,posinset:index+1,setsize:rootSiblingCount})
:renderExpert(node,index,rootSessionId,{level:2,posinset:index+1,setsize:rootSiblingCount})),
idleGroupVisible
?renderIdleGroup(filterActive===true?visibleIdleChildren:idleChildren,idleBatchSlot,{level:2,posinset:visibleChildren.length+1,setsize:rootSiblingCount})
:null,
filterActive===true&&visibleChildren.length===0&&visibleIdleChildren.length===0
&&taskFilter!==null&&taskFilter.matches(root)!==true
?react.createElement("div",{className:"deg_expert_group_filter_empty",role:"status"},t("sidebar.filter.empty"))
:null,
].filter((node)=>node!==null&&node!==undefined)):null)));
Object.assign(frame,{
body,
});
}
function renderSidebarPanelSection(frame){
const{
announcement,autoOpenDraft,autoOpenEnabled,body,config,errorLabelOf,
panelLocale,peakValleyMarker,primitives,react,recoveryBanner,renderSessionModelDialog,
retry,t,toggleAutoOpen,version,viewState,widthResizer,writeAutoOpenSetting,
}=frame;
const autoOpenChecked=autoOpenDraft===null?autoOpenEnabled():autoOpenDraft===true;
const autoOpenToggle=react.createElement("label",{
className:"deg_expert_group_header_auto",
title:"自动打开运行中的子代理侧栏会话",
},
react.createElement("input",{
type:"checkbox",
className:"deg_expert_group_header_auto_input",
"aria-label":"Auto",
checked:autoOpenChecked,
disabled:writeAutoOpenSetting===null,
onChange:(event)=>toggleAutoOpen(event?.target?.checked===true),
}),
react.createElement("span",{className:"deg_expert_group_header_auto_label"},"Auto"));
const panelError=viewState.error;
const panelErrorLabel=panelError===null
?null
:errorLabelOf(panelError.source);
const refreshLabel=panelError===null?t("sidebar.refresh"):t("sidebar.retry");
const refreshButton=react.createElement("button",{
type:"button",
className:"deg_expert_group_header_action",
title:refreshLabel,
"aria-label":refreshLabel,
onClick:retry,
},makeIcon(primitives,"IconRefreshOutlineRegular",{size:14}));
const peakValleyOn=peakValleyMarker?.enabled===true;
const enabledLabel=peakValleyLabelTextOf(config,panelLocale,peakValleyMarker);
const peakValleyExtra=config?.settingsExtraText;
const peakValleyText=enabledLabel!==null
?enabledLabel
:typeof peakValleyExtra==="function"?peakValleyExtra(panelLocale,"settings.pv.disabled"):null;
return react.createElement("section",{className:"deg_expert_group","data-version":version,"aria-label":"Expert Group"},
widthResizer,
react.createElement("div",{
className:"deg_expert_group_announcer",
role:"status",
"aria-live":"polite",
"aria-atomic":"true",
"data-announcement":announcement===""?undefined:announcement,
},announcement),
react.createElement("header",{className:"deg_expert_group_header"},
react.createElement("span",{className:"deg_expert_group_header_title"},t("sidebar.title")),
autoOpenToggle,
peakValleyText===null?null:react.createElement("span",{
className:"deg_expert_group_header_peak_valley",
"data-peak-valley":peakValleyOn?peakValleyMarker.period:"disabled",
},peakValleyText),
panelError===null
?null
:react.createElement("span",{
className:"deg_expert_group_error",
"data-error-source":panelError.source,
title:panelError.message,
},panelErrorLabel),
refreshButton),recoveryBanner,body,
renderSessionModelDialog());
}
function createSidebarPanel(deps){
const config=object(deps);
const react=config.react;
const primitives=config.primitives||{};
if(!react||typeof react.createElement!=="function"){
return function MissingReactPanel(){return null;};
}
const shared=createSidebarPanelShared({config,react,primitives});
function Panel(props){
const frame=createSidebarPanelFrame(props,shared);
useSidebarPanelStateCore(frame);
useSidebarPanelAnnouncementEffect(frame);
useSidebarPanelWidth(frame);
useSidebarPanelStoreAndMeta(frame);
useSidebarPanelSessionModelEffects(frame);
useSidebarPanelSessionModel(frame);
useSidebarPanelSessionModelPart2(frame);
useSidebarPanelSnapshotRefs(frame);
useSidebarPanelPolling(frame);
useSidebarPanelAutoRefs(frame);
useSidebarPanelMountEffects(frame);
useSidebarPanelActivityEffect(frame);
useSidebarPanelHostServices(frame);
useSidebarPanelSnapshotDerived(frame);
useSidebarPanelLiveTick(frame);
useSidebarPanelMetaEffect(frame);
useSidebarPanelTabPrimitives(frame);
useSidebarPanelSnapshotSyncEffect(frame);
useSidebarPanelTabWiring(frame);
useSidebarPanelTabWiringPart2(frame);
useSidebarPanelTabWiringPart3(frame);
useSidebarPanelTabSync(frame);
useSidebarPanelAutoOrchestration(frame);
useSidebarPanelAutoOrchestrationPart2(frame);
useSidebarPanelTabRecorder(frame);
useSidebarPanelTabRecorderPart2(frame);
useSidebarPanelActionHandlers(frame);
useSidebarPanelActionHandlersPart2(frame);
useSidebarPanelBatchClose(frame);
useSidebarPanelViews(frame);
useSidebarPanelProjectionRef(frame);
useSidebarPanelProjectionEffect(frame);
useSidebarPanelRunAction(frame);
useSidebarPanelRunActionPart2(frame);
useSidebarPanelPeakValleyMarker(frame);
assembleSidebarPanelBody(frame);
assembleSidebarPanelBodyPart2(frame);
return renderSidebarPanelSection(frame);
}
Panel.displayName="ExpertGroupPanel";
return Panel;
}
global[SYMBOL]=Object.freeze({createSidebarPanel});
})(globalThis);
/* source: client-expert-group-sidebar.js */
(function installExpertGroupSidebar(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-sidebar");
const PURE_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-pure");
const PURE=global[PURE_SYMBOL]||{};
const{
BRAND_ICON_PATHS,
}=PURE;
const DOM_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-dom");
const DOM=global[DOM_SYMBOL]||{};
const{
createBrandIcon,
}=DOM;
const PANEL_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-panel");
const PANEL=global[PANEL_SYMBOL]||{};
const{createSidebarPanel}=PANEL;
const INSTALL_RESOURCES_SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-install-resources");
const INSTALL_RESOURCES=global[INSTALL_RESOURCES_SYMBOL]||{};
const{createSidebarInstallCoordinator}=INSTALL_RESOURCES;
function createExpertGroupPanel(deps){
return createSidebarPanel(deps);
}
function installExpertGroupSidebar(ctx,deps){
return createSidebarInstallCoordinator(ctx,deps,{createExpertGroupPanel});
}
global[SYMBOL]=Object.freeze({
createExpertGroupPanel,
installExpertGroupSidebar,
BRAND_ICON_PATHS,
createBrandIcon,
});
})(globalThis);
/* source: client-notifications.js */
(function installClientNotifications(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-notifications");
const existing=global[SYMBOL];
if(existing!==undefined&&existing!==null)return;
global[SYMBOL]=Object.freeze({
delivery:"host-system-toast",
canDeliver:false,
removedCapabilities:Object.freeze([
"in-page-popup",
"browser-notification",
"notification-snapshot-polling",
]),
});
})(globalThis);
/* source: client-model-config-paths.js */
(function installClientModelConfigPaths(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-config-paths");
function isBlankDraftValue(value){
return value===undefined||value===null||value==="";
}
function isPlainObject(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function isSchemaNode(value){
return isPlainObject(value)||typeof value==="function";
}
function isNonEmptyString(value){
return typeof value==="string"&&value.trim().length>0;
}
function jsonEqual(left,right){
if(Object.is(left,right))return true;
if(left===undefined||right===undefined)return left===right;
if(typeof left!==typeof right)return false;
if(left===null||right===null)return false;
if(typeof left!=="object")return false;
try{
return JSON.stringify(left)===JSON.stringify(right);
}catch{
return false;
}
}
function deepClone(value){
if(value===null||typeof value!=="object")return value;
if(Array.isArray(value))return value.map((item)=>deepClone(item));
const clone={};
for(const[key,item]of Object.entries(value))clone[key]=deepClone(item);
return clone;
}
function getPath(value,path){
let current=value;
for(const key of Array.isArray(path)?path:[]){
if(Array.isArray(current)){
current=current[Number(key)];
continue;
}
if(current===null||typeof current!=="object")return undefined;
current=current[key];
}
return current;
}
function hasPath(value,path){
const segments=Array.isArray(path)?path:[];
if(segments.length===0){
return isPlainObject(value)&&Object.keys(value).length>0;
}
const parent=getPath(value,segments.slice(0,-1));
const key=segments[segments.length-1];
if(Array.isArray(parent))return Number.isSafeInteger(Number(key))&&Number(key)>=0&&Number(key)<parent.length;
if(parent===null||typeof parent!=="object")return false;
return Object.prototype.hasOwnProperty.call(parent,key);
}
function setPath(root,path,value){
const segments=Array.isArray(path)?path:[];
if(segments.length===0)throw new Error("setPath 需要非空路径");
if(Array.isArray(root)){
const next=[...root];
next[Number(segments[0])]=segments.length===1?value:setPath(next[Number(segments[0])],segments.slice(1),value);
return next;
}
const source=isPlainObject(root)?root:{};
const next={...source};
const[head,...rest]=segments;
next[head]=rest.length===0?value:setPath(source[head],rest,value);
return next;
}
function deletePath(root,path){
const segments=Array.isArray(path)?path:[];
if(segments.length===0)return isPlainObject(root)?{}:root;
if(!hasPath(root,segments))return root;
if(Array.isArray(root)){
const next=[...root];
const[head,...rest]=segments;
if(rest.length===0)next.splice(Number(head),1);
else next[Number(head)]=deletePath(next[Number(head)],rest);
return next;
}
const next={...root};
const[head,...rest]=segments;
if(rest.length===0)Reflect.deleteProperty(next,head);
else next[head]=deletePath(next[head],rest);
return next;
}
function getSubtree(root,path){
const value=getPath(root,path);
return isPlainObject(value)?value:{};
}
function deriveKeyRef(provider){
const text=isNonEmptyString(provider)?provider:"";
return text.toUpperCase().replace(/[^A-Z0-9]+/g,"_")+"_API_KEY";
}
function pathOps(base,before,after,allowedKeys){
const prefix=Array.isArray(base)?base:[];
const previous=isPlainObject(before)?before:{};
const next=isPlainObject(after)?after:{};
const allowed=Array.isArray(allowedKeys)?new Set(allowedKeys):null;
const ops=[];
for(const[key,value]of Object.entries(next)){
if(allowed!==null&&!allowed.has(key))continue;
if(jsonEqual(previous[key],value))continue;
ops.push({op:"set",path:[...prefix,key],value:deepClone(value)});
}
for(const key of Object.keys(previous)){
if(allowed!==null&&!allowed.has(key))continue;
if(Object.prototype.hasOwnProperty.call(next,key))continue;
ops.push({op:"unset",path:[...prefix,key]});
}
return ops;
}
function hasOps(ops){
return Array.isArray(ops)&&ops.length>0;
}
function revisionConflictOf(expectedRevision,currentRevision){
if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return false;
if(!Number.isSafeInteger(currentRevision)||currentRevision<0)return true;
return expectedRevision!==currentRevision;
}
function createEditorBaseline(snapshot,path){
const source=isPlainObject(snapshot)?snapshot:{};
const revision=Number.isSafeInteger(source.revision)&&source.revision>=0?source.revision:null;
const user=source.user;
const pinned=getPath(source.base,path);
return{
revision,
userSubtree:getSubtree(user,path),
effectiveSubtree:getSubtree(source.value,path),
inherited:isPlainObject(pinned)?deepClone(pinned):{},
};
}
function restoreDefaultOps(path){
return[{op:"unset",path:[...(Array.isArray(path)?path:[]),"models"]}];
}
function providerSubtreeOps(stored,draft){
return pathOps([],stored,draft);
}
global[SYMBOL]=Object.freeze({
isBlankDraftValue,
isPlainObject,
isSchemaNode,
isNonEmptyString,
jsonEqual,
deepClone,
getPath,
hasPath,
setPath,
deletePath,
getSubtree,
deriveKeyRef,
pathOps,
hasOps,
revisionConflictOf,
createEditorBaseline,
restoreDefaultOps,
providerSubtreeOps,
});
})(globalThis);
/* source: client-model-config-rows.js */
(function installClientModelConfigRows(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-config-rows");
const pathsSymbol=Symbol.for("dsh-expert-group/client-model-config-paths");
const paths=global[pathsSymbol]||{};
const{
isPlainObject,isNonEmptyString,jsonEqual,isBlankDraftValue,createEditorBaseline,
deepClone,deletePath,pathOps,hasPath,getSubtree,deriveKeyRef,isSchemaNode,getPath,
}=paths;
const REASONING_EFFORTS=Object.freeze([
"off","minimal","low","medium","high","xhigh","max",
]);
const REASONING_EFFORT_EMPTY="";
const INPUT_MODALITIES=Object.freeze(["text","image"]);
const DEFAULT_INPUT_MODALITIES=Object.freeze(["text"]);
const CAPACITY_PATTERN=/^(\d+(?:\.\d+)?)([km])?$/i;
const CAPACITY_SCALE=Object.freeze({k:1000,m:1000000});
function modelDisplayNameOf(model){
if(!isPlainObject(model))return"";
if(isNonEmptyString(model.name))return model.name;
return typeof model.id==="string"?model.id:"";
}
function modelInputOf(model,fallback){
const declared=isPlainObject(model)?model.input:undefined;
if(Array.isArray(declared)&&declared.length>0){
return declared.filter((value)=>typeof value==="string");
}
if(Array.isArray(fallback)&&fallback.length>0)return[...fallback];
return[...DEFAULT_INPUT_MODALITIES];
}
function modelRowOf(value){
return isPlainObject(value)?{...value}:{};
}
function modelDraftsOf(value){
return Array.isArray(value)?value.map((entry)=>modelRowOf(entry)):[];
}
function inputOverrideOf(model){
const declared=isPlainObject(model)?model.input:undefined;
return Array.isArray(declared)&&declared.length>0;
}
function emptyEffortSelection(){
const selection={};
for(const level of REASONING_EFFORTS)selection[level]=false;
return selection;
}
function effortSelectionFor(model){
const selection=emptyEffortSelection();
if(!isPlainObject(model))return selection;
const declared=model.reasoningEfforts;
if(declared===false||!isPlainObject(declared))return selection;
for(const level of REASONING_EFFORTS){
if(!Object.prototype.hasOwnProperty.call(declared,level))continue;
selection[level]=declared[level]!==false;
}
return selection;
}
function effortSelectionEqual(left,right){
const a=isPlainObject(left)?left:{};
const b=isPlainObject(right)?right:{};
return REASONING_EFFORTS.every((level)=>(a[level]===true)===(b[level]===true));
}
function unknownEffortKeysOf(declared){
if(!isPlainObject(declared))return[];
return Object.keys(declared).filter((key)=>!REASONING_EFFORTS.includes(key));
}
function hasUnknownEffortKeys(declared){
return unknownEffortKeysOf(declared).length>0;
}
function reasoningDiffLines(before,after){
const lines=[];
const beforePaths=new Map();
const afterPaths=new Map();
const collect=(map,rows)=>{
(Array.isArray(rows)?rows:[]).forEach((row,index)=>{
if(!isPlainObject(row)||!isNonEmptyString(row.id))return;
map.set(row.id.trim(),{index,efforts:jsonEqual(row.reasoningEfforts,undefined)?undefined:row.reasoningEfforts});
});
};
collect(beforePaths,before);
collect(afterPaths,after);
const ids=[...new Set([...beforePaths.keys(),...afterPaths.keys()])];
for(const id of ids){
const previous=beforePaths.get(id);
const next=afterPaths.get(id);
if(previous===undefined){
lines.push({id,kind:"added",levels:selectedLevelsOf(next?.efforts)});
continue;
}
if(next===undefined){
lines.push({id,kind:"removed",levels:selectedLevelsOf(previous.efforts)});
continue;
}
const beforeLevels=selectedLevelsOf(previous.efforts);
const afterLevels=selectedLevelsOf(next.efforts);
const added=afterLevels.filter((level)=>!beforeLevels.includes(level));
const removed=beforeLevels.filter((level)=>!afterLevels.includes(level));
if(added.length>0||removed.length>0)lines.push({id,kind:"changed",added,removed});
}
return lines;
}
function selectedLevelsOf(declared){
if(!isPlainObject(declared))return[];
return REASONING_EFFORTS.filter((level)=>Object.prototype.hasOwnProperty.call(declared,level)&&declared[level]!==false);
}
function applyEffortSelection(selection,previous){
const source=isPlainObject(selection)?selection:{};
const next=isPlainObject(previous)?{...previous}:{};
for(const level of REASONING_EFFORTS){
if(source[level]===true)next[level]=level==="off"?REASONING_EFFORT_EMPTY:level;
else Reflect.deleteProperty(next,level);
}
if(Object.keys(next).length===0)return undefined;
return next;
}
function normalizeEffortsEntry(model){
const row=modelRowOf(model);
const declared=row.reasoningEfforts;
if(!isPlainObject(declared)){
if(declared===false)Reflect.deleteProperty(row,"reasoningEfforts");
return row;
}
const selection={};
for(const level of REASONING_EFFORTS){
selection[level]=Object.prototype.hasOwnProperty.call(declared,level)&&declared[level]!==false;
}
const next=applyEffortSelection(selection,declared);
if(next===undefined)Reflect.deleteProperty(row,"reasoningEfforts");
else row.reasoningEfforts=next;
return row;
}
function createModelRow(id){
return{id:typeof id==="string"?id:""};
}
function inputSelectionFor(model,fallback){
return modelInputOf(model,fallback);
}
function patchModelDraft(model,patch){
const row=modelRowOf(model);
const next={...row};
for(const[key,value]of Object.entries(isPlainObject(patch)?patch:{})){
if(isBlankDraftValue(value))Reflect.deleteProperty(next,key);
else next[key]=value;
}
return normalizeEffortsEntry(next);
}
function setModelEffortSelection(models,index,selection){
const rows=modelDraftsOf(models);
return rows.map((row,at)=>{
if(at!==index)return row;
const next={...row};
const efforts=applyEffortSelection(selection,row.reasoningEfforts);
if(efforts===undefined)Reflect.deleteProperty(next,"reasoningEfforts");
else next.reasoningEfforts=efforts;
return next;
});
}
function setModelInputSelection(models,index,modalities){
const rows=modelDraftsOf(models);
return rows.map((row,at)=>{
if(at!==index)return row;
const next={...row};
const declared=Array.isArray(modalities)
?modalities.filter((value)=>INPUT_MODALITIES.includes(value))
:[];
if(declared.length===0)Reflect.deleteProperty(next,"input");
else next.input=declared;
return next;
});
}
function removeModelRow(models,index){
return modelDraftsOf(models).filter((_row,at)=>at!==index);
}
function appendModelRow(models,id){
return[...modelDraftsOf(models),createModelRow(id)];
}
function parseCapacity(text){
const trimmed=typeof text==="string"?text.trim():"";
if(trimmed.length===0)return undefined;
const match=CAPACITY_PATTERN.exec(trimmed);
if(match===null)return Number.NaN;
const suffix=match[2]===undefined?undefined:match[2].toLowerCase();
const scale=suffix===undefined?1:CAPACITY_SCALE[suffix];
const scaled=Number(match[1])*scale;
const rounded=Math.round(scaled);
return Math.abs(scaled-rounded)<1e-6?rounded:scaled;
}
function formatCapacity(value){
if(typeof value!=="number"||!Number.isFinite(value))return"";
if(!Number.isInteger(value)||value<=0)return String(value);
if(value%CAPACITY_SCALE.m===0)return String(value/CAPACITY_SCALE.m)+"M";
if(value%CAPACITY_SCALE.k===0)return String(value/CAPACITY_SCALE.k)+"K";
return String(value);
}
function validateModelRows(value){
const rows=modelDraftsOf(value);
const seen=new Set();
for(const[index,row]of rows.entries()){
const position=index+1;
const id=typeof row.id==="string"?row.id.trim():"";
if(id.length===0)return{ok:false,rows,error:"第 "+position+" 行：模型 ID 不能为空"};
if(seen.has(id))return{ok:false,rows,error:"第 "+position+" 行：模型 ID 重复（"+id+"）"};
seen.add(id);
if(row.name!==undefined&&(typeof row.name!=="string"||row.name.length===0)){
return{ok:false,rows,error:"第 "+position+" 行：显示名必须是非空文本"};
}
for(const field of["contextWindow","maxTokens"]){
const raw=row[field];
if(raw===undefined)continue;
if(typeof raw!=="number"||!Number.isInteger(raw)||raw<=0){
return{
ok:false,
rows,
error:"第 "+position+" 行："+(field==="contextWindow"?"上下文窗口":"最大输出 token")+"必须是正整数",
};
}
}
const declared=row.reasoningEfforts;
if(declared!==undefined&&declared!==false&&!isPlainObject(declared)){
return{ok:false,rows,error:"第 "+position+" 行：思考档位映射必须是对象（或 false）"};
}
}
return{ok:true,rows,error:null};
}
function normalizeModelRows(value){
return modelDraftsOf(value)
.map((row)=>{
const next={...row};
if(typeof next.id==="string")next.id=next.id.trim();
if(typeof next.name==="string"){
const trimmed=next.name.trim();
if(trimmed.length===0)Reflect.deleteProperty(next,"name");
else next.name=trimmed;
}
return normalizeEffortsEntry(next);
})
.filter((row)=>{
const onlyIdentity=Object.keys(row).length<=1;
return!(onlyIdentity&&(row.id===undefined||row.id===""));
});
}
function modelCatalogOverridden(baseline){
if(!isPlainObject(baseline)||!isPlainObject(baseline.userSubtree))return false;
return Object.prototype.hasOwnProperty.call(baseline.userSubtree,"models")
&&Array.isArray(baseline.userSubtree.models);
}
function isOverridden(baseline){
if(!isPlainObject(baseline))return false;
return Object.keys(baseline.userSubtree??{}).length>0;
}
function inheritedModelsOf(baseline){
const source=isPlainObject(baseline)?baseline:{};
const overridden=modelCatalogOverridden(source);
if(overridden){
return{overridden:true,models:modelDraftsOf(source.userSubtree?.models),inherited:[]};
}
const baseRows=Array.isArray(source.inherited?.models)?source.inherited.models:undefined;
const effectiveRows=Array.isArray(source.effectiveSubtree?.models)?source.effectiveSubtree.models:[];
return{overridden:false,models:modelDraftsOf(baseRows??effectiveRows),inherited:modelDraftsOf(baseRows??effectiveRows)};
}
function fallbackModelsOf(baseline){
const source=isPlainObject(baseline)?baseline:{};
const baseRows=Array.isArray(source.inherited?.models)?source.inherited.models:undefined;
if(baseRows!==undefined)return modelDraftsOf(baseRows);
if(modelCatalogOverridden(source))return[];
return modelDraftsOf(source.effectiveSubtree?.models);
}
function materializeOverrideOps(path,models){
return[{
op:"set",
path:[...(Array.isArray(path)?path:[]),"models"],
value:modelDraftsOf(models),
}];
}
function modelCatalogOps({profilePath,baseline,draft,catalogTouched}){
const overridden=isOverridden(baseline);
const rawDraft=isPlainObject(draft)?draft:{};
const includeModels=catalogTouched!==false;
const sourceNext=includeModels
?rawDraft
:(isPlainObject(baseline?.userSubtree)&&Object.prototype.hasOwnProperty.call(baseline.userSubtree,"models")
?{...rawDraft,models:deepClone(baseline.userSubtree.models)}
:deletePath(rawDraft,["models"]));
const next=Array.isArray(sourceNext.models)&&sourceNext.models.length===0&&includeModels
?deletePath(sourceNext,["models"])
:sourceNext;
if(!overridden&&Object.keys(next).length===0)return[];
return pathOps(profilePath,overridden?baseline.userSubtree:undefined,next,EDITABLE_PROFILE_FIELDS);
}
function modelEditableProfileOf(source){
if(!isPlainObject(source))return{};
const next={};
for(const field of EDITABLE_PROFILE_FIELDS){
if(!Object.prototype.hasOwnProperty.call(source,field))continue;
const value=source[field];
if(value===undefined||value===null)continue;
if(field==="models"&&!Array.isArray(value))continue;
next[field]=deepClone(value);
}
return next;
}
function importNamespace(source){
return modelEditableProfileOf(source);
}
function catalogOpsFor(modelsPath,models){
const path=Array.isArray(modelsPath)?modelsPath:[];
const rows=modelDraftsOf(models);
if(rows.length===0)return[{op:"unset",path:[...path]}];
return[{op:"set",path:[...path],value:rows}];
}
function modelOverrideDecision({overridden,dirty,models}){
if(!dirty)return"noop";
const empty=modelDraftsOf(models).length===0;
if(overridden&&empty)return"reset";
if(!overridden)return"materialize";
return"replace";
}
function modelChoicesOf(rows){
return modelDraftsOf(rows)
.filter((row)=>isNonEmptyString(row.id))
.map((row)=>({id:row.id.trim(),name:modelDisplayNameOf(row)}));
}
function indexModelsById(rows){
const index=new Map();
for(const row of modelDraftsOf(rows)){
if(isNonEmptyString(row.id))index.set(row.id.trim(),row);
}
return index;
}
function adoptModels(rows,candidates){
const index=indexModelsById(rows);
const next=modelDraftsOf(rows).map((row)=>{
const id=isNonEmptyString(row.id)?row.id.trim():"";
return id.length===0?row:index.get(id);
});
for(const candidate of Array.isArray(candidates)?candidates:[]){
if(!isPlainObject(candidate)||!isNonEmptyString(candidate.id))continue;
const id=candidate.id.trim();
if(index.has(id))continue;
const row={id};
if(isNonEmptyString(candidate.name))row.name=candidate.name;
if(typeof candidate.contextWindow==="number")row.contextWindow=candidate.contextWindow;
if(typeof candidate.maxTokens==="number")row.maxTokens=candidate.maxTokens;
if(Array.isArray(candidate.inputModalities)&&candidate.inputModalities.length>0){
row.input=candidate.inputModalities.filter((value)=>typeof value==="string");
}
index.set(id,row);
next.push(row);
}
return next;
}
function joinProviderDirectory(registered,directory){
const active=new Set();
for(const provider of Array.isArray(registered)?registered:[]){
if(isPlainObject(provider)&&isNonEmptyString(provider.id))active.add(provider.id);
}
const declared=new Set();
const rows=[];
for(const entry of Array.isArray(directory)?directory:[]){
if(!isPlainObject(entry)||!isNonEmptyString(entry.provider))continue;
declared.add(entry.provider);
rows.push({
provider:entry.provider,
displayName:isNonEmptyString(entry.displayName)?entry.displayName:entry.provider,
settingsNs:typeof entry.settingsNs==="string"?entry.settingsNs:"",
settingsPath:Array.isArray(entry.settingsPath)?[...entry.settingsPath]:[],
active:active.has(entry.provider),
declared:entry.declared===true,
error:typeof entry.error==="string"&&entry.error.length>0?entry.error:undefined,
});
}
for(const provider of Array.isArray(registered)?registered:[]){
if(!isPlainObject(provider)||!isNonEmptyString(provider.id)||declared.has(provider.id))continue;
rows.push({
provider:provider.id,
displayName:isNonEmptyString(provider.name)?provider.name:provider.id,
settingsNs:"",
settingsPath:[],
active:true,
declared:false,
error:undefined,
});
}
return rows;
}
function providerEditable(row,namespace){
return isPlainObject(row)&&isNonEmptyString(row.settingsNs)&&isPlainObject(namespace);
}
function providerRemovable(row,namespace){
if(!isPlainObject(row)||!isPlainObject(namespace))return false;
if(row.settingsPath.length===0&&row.settingsNs!==""){
return hasPath(namespace.user,row.settingsPath);
}
return hasPath(namespace.user,row.settingsPath);
}
function providerProfileOf(row,namespace){
if(!isPlainObject(row)||!isPlainObject(namespace))return{};
return getSubtree(namespace.value,row.settingsPath);
}
function apiKeyEnvOf(row,namespace){
const profile=providerProfileOf(row,namespace);
return isNonEmptyString(profile.apiKeyEnv)?profile.apiKeyEnv:"";
}
function credentialRefOf(row,namespace){
const named=apiKeyEnvOf(row,namespace);
return named.length>0?named:deriveKeyRef(isPlainObject(row)?row.provider:"");
}
function protocolChoices(root,provider,operations,settingsPath){
if(!isPlainObject(operations)||typeof operations.nodeAtPath!=="function")return[];
if(!isNonEmptyString(provider))return[];
const profilePath=Array.isArray(settingsPath)&&settingsPath.length>0
?settingsPath
:["providers",provider];
let node;
try{
node=operations.nodeAtPath(root,[...profilePath,"api"]);
}catch{
return[];
}
if(!isSchemaNode(node)||node.type!=="union"||!Array.isArray(node.list))return[];
return node.list
.map((entry)=>(isSchemaNode(entry)?entry.value:undefined))
.filter((value)=>typeof value==="string"&&value.length>0);
}
function createSchemaAdapter(operations,fallback){
const ops=isPlainObject(operations)?operations:{};
const schemaConstructor=isPlainObject(fallback)&&typeof fallback.Schema==="function"?fallback.Schema:null;
const rehydrate=typeof ops.rehydrate==="function"?ops.rehydrate:null;
const validate=typeof ops.validate==="function"?ops.validate:null;
const nodeAtPath=typeof ops.nodeAtPath==="function"?ops.nodeAtPath:null;
const structural={
rehydrate(serialized){
if(schemaConstructor===null)return undefined;
try{
return new schemaConstructor(serialized);
}catch{
return undefined;
}
},
validateNode(schema,draft){
if(schema===undefined||schema===null||typeof schema!=="function")return undefined;
try{
schema(draft);
return undefined;
}catch(error){
return error instanceof Error?error.message:String(error);
}
},
nodeAtPath(root,path){
let node=root;
for(const key of Array.isArray(path)?path:[]){
if(node===null||node===undefined||typeof node!=="object")return undefined;
if(node.type==="object")node=isPlainObject(node.dict)?node.dict[key]:undefined;
else if(node.type==="dict"||node.type==="array")node=node.inner;
else return undefined;
}
return node;
},
};
return{
available:rehydrate!==null||schemaConstructor!==null,
rehydrate(serialized){
if(rehydrate!==null){
try{
return rehydrate(serialized);
}catch{
return undefined;
}
}
return structural.rehydrate(serialized);
},
validate(schema,draft){
if(schema===undefined||schema===null)return undefined;
if(validate!==null){
try{
const outcome=validate(schema,draft);
if(outcome!==undefined&&outcome!==null)return String(outcome);
return structural.validateNode(schema,draft);
}catch(error){
return error instanceof Error?error.message:String(error);
}
}
return structural.validateNode(schema,draft);
},
nodeAtPath(root,path){
if(root===undefined||root===null)return undefined;
if(nodeAtPath!==null){
try{
return nodeAtPath(root,path);
}catch{
return undefined;
}
}
return structural.nodeAtPath(root,path);
},
};
}
function namespaceSchemaInfo(namespace,adapter){
const view=isPlainObject(namespace)?namespace:{};
const root=adapter===undefined?undefined:adapter.rehydrate(view.schema);
return{
root,
modelsNode:adapter===undefined?undefined:adapter.nodeAtPath(root,["models"]),
defaultInput:(()=>{
const node=adapter===undefined?undefined:adapter.nodeAtPath(root,["defaultInput"]);
const value=isSchemaNode(node)?node.meta?.default:undefined;
return Array.isArray(value)?value.filter((entry)=>typeof entry==="string"):undefined;
})(),
};
}
function validateProfileDraft(draft){
if(!isPlainObject(draft))return null;
for(const field of["displayName","baseURL","api","apiKeyEnv"]){
const value=draft[field];
if(value===undefined||value===null)continue;
if(typeof value!=="string")return field+" 必须是文本";
}
if(draft.models!==undefined){
const checked=validateModelRows(draft.models);
if(!checked.ok)return checked.error;
}
return null;
}
function rolesAffectedByChange(defaults,change){
const source=isPlainObject(defaults)?defaults:{};
const provider=isNonEmptyString(change?.provider)?change.provider:"";
if(provider.length===0)return[];
const removed=new Set(
(Array.isArray(change?.removedLevels)?change.removedLevels:[])
.filter((level)=>typeof level==="string"&&level.length>0),
);
const removeProvider=change?.removeProvider===true;
const affected=[];
for(const[role,selection]of Object.entries(source)){
if(!isPlainObject(selection))continue;
if(selection.provider!==provider)continue;
const effort=selection.reasoningEffort;
if(typeof effort!=="string"||effort.length===0)continue;
if(removeProvider||removed.has(effort))affected.push({role,reasoningEffort:effort});
}
return affected;
}
function reasoningGuardMessage(levels,affected,labelOf){
const label=typeof labelOf==="function"?labelOf:(role)=>role;
const parts=affected.map((entry)=>label(entry.role)+"（"+entry.reasoningEffort+"）");
return"无法保存：将删除的思考档位 "+levels.join("、")+" 正被以下专家角色使用："+parts.join("、")
+"。请先在这些角色的配置中改用其它档位，本页不会自动改写角色配置。";
}
function removedLevelsOf(before,after){
const levels=new Set();
const afterIndex=indexModelsById(after);
for(const row of modelDraftsOf(before)){
if(!isNonEmptyString(row.id))continue;
const id=row.id.trim();
const nextRow=afterIndex.get(id);
const previousLevels=selectedLevelsOf(row.reasoningEfforts);
if(nextRow===undefined){
for(const level of previousLevels)levels.add(level);
continue;
}
const nextLevels=selectedLevelsOf(nextRow.reasoningEfforts);
for(const level of previousLevels)if(!nextLevels.includes(level))levels.add(level);
}
return[...levels];
}
function namespaceViewOf(view,ns){
const namespaces=isPlainObject(view)&&Array.isArray(view.namespaces)?view.namespaces:[];
return namespaces.find((entry)=>isPlainObject(entry)&&entry.ns===ns);
}
function roleDefaultsOf(settingsValue){
const defaults=isPlainObject(settingsValue)?settingsValue.defaults:undefined;
return isPlainObject(defaults)?defaults:{};
}
function modelCardApply(input){
const source=isPlainObject(input)?input:{};
const catalogTouched=source.catalogTouched===true;
const profilePath=Array.isArray(source.profilePath)?source.profilePath:[];
const draft=isPlainObject(source.draft)?source.draft:{};
const storedUser=source.storedUser;
const baseline={userSubtree:getSubtree(storedUser,profilePath)};
const ops=modelCatalogOps({profilePath,baseline,draft,catalogTouched});
const rows=catalogTouched
?(Array.isArray(draft.models)?draft.models:[])
:[];
const removedLevels=catalogTouched
?removedLevelsOf(source.inheritedModels,rows)
:[];
const affectedRoles=removedLevels.length===0
?[]
:rolesAffectedByChange(source.roleDefaults,{provider:source.provider,removedLevels});
return{ops,removedLevels,affectedRoles,rows};
}
function providerListSections(rows,namespaceOf){
const lookup=typeof namespaceOf==="function"?namespaceOf:()=>undefined;
const sections=[];
for(const row of Array.isArray(rows)?rows:[]){
if(!isPlainObject(row))continue;
const namespace=lookup(row.settingsNs);
if(!isPlainObject(namespace))continue;
sections.push({
row,
namespace,
configured:hasPath(namespace.user,row.settingsPath),
});
}
return{
configured:sections.filter((entry)=>entry.configured),
addable:sections.filter((entry)=>!entry.configured),
};
}
function apiKeyField(input){
const source=isPlainObject(input)?input:{};
const configured=isPlainObject(source.credential)&&source.credential.configured===true;
const writable=!isPlainObject(source.credential)||source.credential.writable!==false;
const ref=isNonEmptyString(source.credentialRef)?source.credentialRef:"";
return{
ref,
value:typeof source.typed==="string"?source.typed:"",
type:"password",
autoComplete:"off",
disabled:source.readOnly===true||!writable,
placeholder:writable?(configured?"已配置（留空表示不修改）":"粘贴 API Key 后点应用"):"当前凭据只读",
hint:ref.length===0?"未设置凭据引用":"凭据引用："+ref+"（API Key 只写入 credentials 服务，保存后不回显明文）",
};
}
function modelLimitFieldsOf(model){
const capOf=(raw)=>typeof raw==="number"?formatCapacity(raw):"";
return{
contextWindow:{value:capOf(model.contextWindow),placeholder:"继承适配器默认"},
maxTokens:{value:capOf(model.maxTokens),placeholder:"继承适配器默认"},
};
}
function modelReasoningFieldsOf(model,index,defaultInput,expanded){
const levels=effortSelectionFor(model);
const picked=modelInputOf(model,defaultInput);
return{
efforts:REASONING_EFFORTS.map((level)=>({level,checked:levels[level]===true})),
inputs:INPUT_MODALITIES.map((modality)=>({
modality,
checked:picked.includes(modality),
locked:picked.length===1&&picked.includes(modality),
})),
advancedOpen:expanded.has(index),
};
}
function buildModelCardModel(input){
const source=isPlainObject(input)?input:{};
const row=isPlainObject(source.row)?source.row:{};
const profilePath=Array.isArray(row.settingsPath)?row.settingsPath:[];
const draft=isPlainObject(source.draft)?source.draft:{};
const inherited=modelDraftsOf(source.fallbackModels);
const models=Array.isArray(draft.models)?modelDraftsOf(draft.models):inherited;
const overridden=typeof source.catalogOverridden==="boolean"
?source.catalogOverridden
:Array.isArray(draft.models)&&draft.models.length>0;
const expanded=new Set(
source.expandedRows instanceof Set
?[...source.expandedRows]
:(Array.isArray(source.expandedRows)?source.expandedRows:[]),
);
const defaultInput=Array.isArray(source.defaultInput)?source.defaultInput:undefined;
const credential=isPlainObject(source.credential)?source.credential:undefined;
const apiKey=apiKeyField({
provider:row.provider,
credentialRef:source.credentialRef??credentialRefOf(row,source.namespace),
credential,
typed:typeof source.typed==="string"?source.typed:"",
readOnly:source.readOnly===true,
});
const nameOf=(field,model)=>{
if(field==="id")return typeof model.id==="string"?model.id:"";
return typeof model.name==="string"?model.name:"";
};
return{
provider:row.provider,
displayName:isNonEmptyString(row.displayName)?row.displayName:row.provider,
profilePath,
readOnly:source.readOnly===true,
apiKey,
baseUrl:{
value:typeof draft.baseURL==="string"?draft.baseURL:"",
placeholder:"留空表示使用适配器默认端点",
},
protocol:{
value:typeof draft.api==="string"?draft.api:"",
options:[{
value:"",
label:"适配器默认",
},...(Array.isArray(source.protocols)?source.protocols:[])
.filter((choice)=>typeof choice==="string"&&choice.length>0)
.map((choice)=>({value:choice,label:choice}))],
},
models:models.map((model,index)=>({
index,
position:index+1,
id:{value:nameOf("id",model),editable:true},
name:{value:nameOf("name",model),editable:true},
...modelLimitFieldsOf(model),
reasoningDefaults:{value:"模型默认",editable:false},
...modelReasoningFieldsOf(model,index,defaultInput,expanded),
})),
modelCatalog:{
overridden,
label:overridden?"已按用户覆盖":"适配器默认（首次编辑时写入用户覆盖）",
emptyHint:"没有模型：留空表示沿用适配器内置目录",
canReset:overridden,
},
actions:{
apply:source.readOnly===true?"disabled":"enabled",
cancel:"enabled",
fetchModels:source.readOnly===true?"disabled":"enabled",
addModel:source.readOnly===true?"disabled":"enabled",
addProvider:source.readOnly===true?"disabled":"enabled",
removeProvider:source.readOnly===true?"disabled":"enabled",
edit:"enabled",
},
};
}
function createCardSession(input){
const source=isPlainObject(input)?input:{};
const provider=isNonEmptyString(source.provider)?source.provider:"";
const settingsNs=typeof source.settingsNs==="string"?source.settingsNs:"";
const profilePath=Array.isArray(source.profilePath)?source.profilePath:[];
const startingUser=isPlainObject(source.storedUser)?source.storedUser:{};
let appliedUser=deepClone(startingUser);
let currentEffective=source.value;
let baseline=createEditorBaseline({
revision:source.revision,
user:appliedUser,
base:source.base,
value:currentEffective,
},profilePath);
let fallbackModels=fallbackModelsOf(baseline);
let draft=importNamespace(
!isPlainObject(currentEffective)||profilePath.length===0
?currentEffective
:getPath(currentEffective,profilePath),
);
let catalogTouched=false;
let catalogReset=false;
let keyDraft="";
let closed=false;
return{
provider,
settingsNs,
profilePath,
get draft(){return draft;},
get revision(){return baseline.revision;},
get closed(){return closed;},
get overridden(){
return catalogTouched
?Array.isArray(draft.models)&&draft.models.length>0
:modelCatalogOverridden(baseline);
},
get modelRows(){
return Array.isArray(draft.models)?modelDraftsOf(draft.models):modelDraftsOf(fallbackModels);
},
cardModel(extra={}){
return buildModelCardModel({
row:{provider,settingsPath:profilePath},
draft,
fallbackModels:fallbackModels,
catalogOverridden:catalogTouched
?Array.isArray(draft.models)&&draft.models.length>0
:modelCatalogOverridden(baseline),
...extra,
});
},
edit(update){
if(closed)return draft;
const imported=catalogReset||Array.isArray(draft.models)||fallbackModels.length===0
?draft
:{...draft,models:deepClone(fallbackModels)};
const beforeModels=isPlainObject(imported)&&Object.prototype.hasOwnProperty.call(imported,"models")
?imported.models
:undefined;
const next=update(imported);
const afterModels=isPlainObject(next)&&Object.prototype.hasOwnProperty.call(next,"models")
?next.models
:undefined;
if(!jsonEqual(beforeModels,afterModels))catalogTouched=true;
draft=next;
return draft;
},
resetModels(){
catalogTouched=true;
catalogReset=true;
draft=deletePath(draft,["models"]);
return draft;
},
setFallbackModels(models){
fallbackModels=modelDraftsOf(models);
return fallbackModels;
},
typeKey(value){
keyDraft=typeof value==="string"?value:"";
return keyDraft;
},
get keyValue(){return keyDraft.trim();},
cancel(){
draft=importNamespace(
!isPlainObject(currentEffective)||profilePath.length===0
?currentEffective
:getPath(currentEffective,profilePath),
);
catalogTouched=false;
catalogReset=false;
keyDraft="";
return draft;
},
plan(){
const key=keyDraft.trim();
const draftForSave=key.length>0&&settingsNs==="llm-pi-ai"
&&!isNonEmptyString(draft.apiKeyEnv)
?{...draft,apiKeyEnv:deriveKeyRef(provider)}
:draft;
const validation=validateProfileDraft(draftForSave);
if(validation!==null)return{ok:false,error:validation};
if(Array.isArray(draftForSave.models)){
const rows=validateModelRows(draftForSave.models);
if(!rows.ok)return{ok:false,error:rows.error};
}
const result=modelCardApply({
provider,
profilePath,
storedUser:appliedUser,
draft:draftForSave,
inheritedModels:inheritedModelsOf(baseline).models,
roleDefaults:source.roleDefaults,
catalogTouched,
catalogReset,
});
if(result.affectedRoles.length>0){
return{
ok:false,
guard:true,
removedLevels:result.removedLevels,
affectedRoles:result.affectedRoles,
error:reasoningGuardMessage(result.removedLevels,result.affectedRoles),
};
}
const settingsDraft=deletePath(draftForSave,["models"]);
const ops=result.ops.length===0&&key.length>0&&!hasPath(appliedUser,profilePath)
&&Object.keys(settingsDraft).length===0
?[{op:"set",path:[...profilePath],value:{}}]
:result.ops;
return{
ok:true,
ops,
expectedRevision:baseline.revision,
keyValue:key.length===0?undefined:key,
};
},
accept(view){
if(isPlainObject(view)){
appliedUser=isPlainObject(view.user)?deepClone(view.user):{};
currentEffective=view.value;
baseline=createEditorBaseline({
revision:view.revision,
user:appliedUser,
base:view.base,
value:view.value,
},profilePath);
fallbackModels=fallbackModelsOf(baseline);
draft=importNamespace(
!isPlainObject(view.value)||profilePath.length===0
?view.value
:getPath(view.value,profilePath),
);
}
catalogTouched=false;
catalogReset=false;
return draft;
},
close(){
closed=true;
return draft;
},
};
}
const EDITABLE_PROFILE_FIELDS=Object.freeze(["displayName","apiKeyEnv","baseURL","api","models"]);
global[SYMBOL]=Object.freeze({
REASONING_EFFORTS,
REASONING_EFFORT_EMPTY,
INPUT_MODALITIES,
DEFAULT_INPUT_MODALITIES,
EDITABLE_PROFILE_FIELDS,
modelDisplayNameOf,
modelInputOf,
modelDraftsOf,
inputOverrideOf,
emptyEffortSelection,
effortSelectionFor,
effortSelectionEqual,
unknownEffortKeysOf,
hasUnknownEffortKeys,
reasoningDiffLines,
selectedLevelsOf,
applyEffortSelection,
normalizeEffortsEntry,
createModelRow,
inputSelectionFor,
patchModelDraft,
setModelEffortSelection,
setModelInputSelection,
removeModelRow,
appendModelRow,
parseCapacity,
formatCapacity,
validateModelRows,
normalizeModelRows,
isOverridden,
inheritedModelsOf,
materializeOverrideOps,
modelCatalogOps,
modelEditableProfileOf,
importNamespace,
catalogOpsFor,
modelOverrideDecision,
modelChoicesOf,
indexModelsById,
adoptModels,
joinProviderDirectory,
providerEditable,
providerRemovable,
providerProfileOf,
apiKeyEnvOf,
credentialRefOf,
protocolChoices,
createSchemaAdapter,
namespaceSchemaInfo,
validateProfileDraft,
rolesAffectedByChange,
reasoningGuardMessage,
removedLevelsOf,
namespaceViewOf,
roleDefaultsOf,
modelCardApply,
providerListSections,
apiKeyField,
buildModelCardModel,
modelLimitFieldsOf,
modelReasoningFieldsOf,
createCardSession,
});
})(globalThis);
/* source: client-model-config.js */
(function installModelConfig(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-config");
const pathsSymbol=Symbol.for("dsh-expert-group/client-model-config-paths");
const rowsSymbol=Symbol.for("dsh-expert-group/client-model-config-rows");
const paths=global[pathsSymbol]||{};
const rows=global[rowsSymbol]||{};
const{
isBlankDraftValue,isPlainObject,isSchemaNode,isNonEmptyString,jsonEqual,deepClone,
getPath,hasPath,setPath,deletePath,getSubtree,deriveKeyRef,pathOps,hasOps,
revisionConflictOf,createEditorBaseline,restoreDefaultOps,providerSubtreeOps,
}=paths;
const{
REASONING_EFFORTS,REASONING_EFFORT_EMPTY,INPUT_MODALITIES,DEFAULT_INPUT_MODALITIES,
EDITABLE_PROFILE_FIELDS,modelDisplayNameOf,modelInputOf,modelDraftsOf,inputOverrideOf,
emptyEffortSelection,effortSelectionFor,effortSelectionEqual,unknownEffortKeysOf,
hasUnknownEffortKeys,reasoningDiffLines,selectedLevelsOf,applyEffortSelection,
normalizeEffortsEntry,createModelRow,inputSelectionFor,patchModelDraft,
setModelEffortSelection,setModelInputSelection,removeModelRow,appendModelRow,
parseCapacity,formatCapacity,validateModelRows,normalizeModelRows,
isOverridden,inheritedModelsOf,materializeOverrideOps,modelCatalogOps,
modelEditableProfileOf,importNamespace,catalogOpsFor,modelOverrideDecision,
modelChoicesOf,indexModelsById,adoptModels,joinProviderDirectory,providerEditable,
providerRemovable,providerProfileOf,apiKeyEnvOf,credentialRefOf,protocolChoices,
createSchemaAdapter,namespaceSchemaInfo,validateProfileDraft,rolesAffectedByChange,
reasoningGuardMessage,removedLevelsOf,namespaceViewOf,roleDefaultsOf,modelCardApply,
providerListSections,apiKeyField,buildModelCardModel,createCardSession,
modelLimitFieldsOf,modelReasoningFieldsOf,
}=rows;
function buildSectionModel(input){
const source=isPlainObject(input)?input:{};
const open=source.open===true;
const status=typeof source.status==="string"?source.status:"idle";
const readOnly=source.writable===false;
const addableCount=Array.isArray(source.addable)?source.addable.length:0;
const customAllowed=source.canCreateCustom===true;
return{
title:"模型配置",
open,
disclosure:{expanded:open,bodyId:"deg-model-config-body",label:open?"收起":"展开"},
status,
loading:status==="loading",
error:typeof source.error==="string"&&source.error.length>0?source.error:null,
readOnly,
configuredCount:Array.isArray(source.configured)?source.configured.length:0,
addableCount,
entries:{
addProvider:{label:"添加提供方"},
addCustom:{label:"添加自定义提供方",protocols:Array.isArray(source.protocols)?source.protocols.length:0},
},
actions:{
toggle:"enabled",
addProvider:readOnly||status!=="ready"||addableCount===0?"disabled":"enabled",
addCustom:readOnly||status!=="ready"||!customAllowed?"disabled":"enabled",
reload:status==="loading"?"disabled":"enabled",
},
hint:"与 DSH 内置模型设置页同一份数据流：provider 目录、凭据状态与模型目录都来自宿主公开接口，保存走正式 settings API 与 schema 校验。",
};
}
const ROUTE_ID_PATTERN=/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/;
const BASE_URL_FALLBACK_PATTERN=/^https?:\/\/[^\s/?#]+[^\s]*$/i;
function validateBaseUrl(value){
if(typeof value!=="string"||value.trim().length===0)return"请填写 Base URL（HTTP 或 HTTPS）";
const trimmed=value.trim();
const UrlConstructor=typeof URL==="function"?URL:undefined;
if(UrlConstructor===undefined){
return BASE_URL_FALLBACK_PATTERN.test(trimmed)?null:"Base URL 必须以 http:// 或 https:// 开头，并包含主机名";
}
let parsed;
try{
parsed=new UrlConstructor(trimmed);
}catch{
return"Base URL 不是合法的 URL（请检查协议、主机、端口与括号）";
}
if(parsed.protocol!=="http:"&&parsed.protocol!=="https:"){
return"Base URL 只支持 http:// 或 https://";
}
if(typeof parsed.hostname!=="string"||parsed.hostname.length===0){
return"Base URL 必须包含主机名";
}
if(parsed.port!==""){
const port=Number(parsed.port);
if(!Number.isSafeInteger(port)||port<1||port>65535)return"Base URL 的端口必须在 1-65535 之间";
}
return null;
}
function validateRouteId(value,taken){
if(typeof value!=="string")return"请填写 provider 路由 ID";
const trimmed=value.trim();
if(trimmed.length===0)return"请填写 provider 路由 ID";
if(trimmed.length<2)return"provider 路由 ID 至少 2 个字符";
if(trimmed.length>64)return"provider 路由 ID 最多 64 个字符";
if(!ROUTE_ID_PATTERN.test(trimmed)){
return"provider 路由 ID 只允许小写字母、数字与连字符，且必须以字母开头、字母或数字结尾";
}
const existing=(Array.isArray(taken)?taken:[]).filter((id)=>isNonEmptyString(id));
if(existing.includes(trimmed))return"provider「"+trimmed+"」已存在，请改用其它路由 ID";
const wantedRef=deriveKeyRef(trimmed);
const collided=existing.find((id)=>id!==trimmed&&deriveKeyRef(id)===wantedRef);
if(collided!==undefined){
return"provider「"+trimmed+"」与「"+collided+"」会使用同一个凭据引用（"
+wantedRef+"），请改用其它路由 ID";
}
return null;
}
function validateProtocol(value,protocols){
const allowed=(Array.isArray(protocols)?protocols:[]).filter((entry)=>isNonEmptyString(entry));
if(allowed.length===0)return"当前宿主没有提供可用的协议选项";
if(!isNonEmptyString(value))return"请选择协议";
return allowed.includes(value)?null:"协议「"+value+"」不在宿主支持的协议列表中";
}
function validateCustomProviderDraft(input){
const source=isPlainObject(input)?input:{};
const errors={};
const routeId=typeof source.routeId==="string"?source.routeId.trim():"";
const displayName=typeof source.displayName==="string"?source.displayName.trim():"";
const baseURL=typeof source.baseURL==="string"?source.baseURL.trim():"";
const apiKey=typeof source.apiKey==="string"?source.apiKey.trim():"";
const protocols=(Array.isArray(source.protocols)?source.protocols:[])
.filter((entry)=>isNonEmptyString(entry));
const routeFailure=validateRouteId(routeId,source.takenRoutes);
if(routeFailure!==null)errors.routeId=routeFailure;
const urlFailure=validateBaseUrl(baseURL);
if(urlFailure!==null)errors.baseURL=urlFailure;
const protocolFailure=validateProtocol(source.api,protocols);
if(protocolFailure!==null)errors.api=protocolFailure;
if(displayName.length>0&&displayName.length>200)errors.displayName="显示名最多 200 个字符";
const rows=normalizeModelRows(source.models);
if(rows.length===0)errors.models="至少配置一个模型";
else{
const checked=validateModelRows(rows);
if(!checked.ok)errors.models=checked.error;
}
const profile={};
if(routeFailure===null&&urlFailure===null&&protocolFailure===null&&Object.keys(errors).length===0){
if(apiKey.length>0)profile.apiKeyEnv=deriveKeyRef(routeId);
if(displayName.length>0)profile.displayName=displayName;
profile.baseURL=baseURL;
profile.api=source.api;
profile.models=rows;
}
const firstError=Object.keys(errors).length===0?null:errors[Object.keys(errors)[0]];
return{
ok:Object.keys(errors).length===0,
errors,
error:firstError,
routeId,
profile,
models:rows,
apiKey,
};
}
function createCustomProviderDraft(input){
const source=isPlainObject(input)?input:{};
const settingsNs=typeof source.settingsNs==="string"?source.settingsNs:"";
const profileBasePath=Array.isArray(source.profileBasePath)?source.profileBasePath:[];
const protocols=(Array.isArray(source.protocols)?source.protocols:[])
.filter((entry)=>isNonEmptyString(entry));
let takenRoutes=(Array.isArray(source.takenRoutes)?source.takenRoutes:[])
.filter((entry)=>isNonEmptyString(entry));
let fenceFrozen=false;
let draft={
routeId:"",
displayName:typeof source.displayName==="string"?source.displayName:"",
baseURL:"",
api:protocols.length===1?protocols[0]:"",
apiKey:"",
models:modelDraftsOf(source.models??[createModelRow()]),
};
let settingsCommitted=false;
let committedRevision=null;
let committedProfilePath=null;
let committedCredentialRef=null;
let expectedRevision=Number.isSafeInteger(source.revision)?source.revision:undefined;
const committedRef=()=>(
committedCredentialRef!==null
?committedCredentialRef
:deriveKeyRef(typeof draft.routeId==="string"?draft.routeId.trim():"")
);
return{
settingsNs,
get draft(){return draft;},
get settingsCommitted(){return settingsCommitted;},
get committedProfilePath(){return committedProfilePath;},
get credentialRef(){return committedRef();},
get revision(){return committedRevision===null?expectedRevision:committedRevision;},
rebase(next){
if(settingsCommitted)return draft;
const snapshot=isPlainObject(next)?next:{};
if(!fenceFrozen&&Number.isSafeInteger(snapshot.revision)){
expectedRevision=snapshot.revision;
}
if(snapshot.frozen===true)fenceFrozen=true;
if(Array.isArray(snapshot.takenRoutes)){
takenRoutes=snapshot.takenRoutes.filter((entry)=>isNonEmptyString(entry));
}
return draft;
},
edit(patch){
const next={...draft};
for(const[key,value]of Object.entries(isPlainObject(patch)?patch:{})){
if(settingsCommitted&&key!=="apiKey")continue;
if(key==="models")next.models=modelDraftsOf(value);
else if(isBlankDraftValue(value))next[key]="";
else next[key]=value;
}
draft=next;
return draft;
},
validate(){
return validateCustomProviderDraft({
routeId:draft.routeId,
displayName:draft.displayName,
baseURL:draft.baseURL,
api:draft.api,
apiKey:draft.apiKey,
models:draft.models,
takenRoutes,
protocols,
});
},
profilePath(){
const routeId=typeof draft.routeId==="string"?draft.routeId.trim():"";
return routeId.length===0?null:[...profileBasePath,routeId];
},
plan(){
const keyValue=typeof draft.apiKey==="string"?draft.apiKey.trim():"";
if(settingsCommitted){
const credentialRef=committedRef();
return keyValue.length===0
?{ok:true,phase:"done",credentialRef,keyValue:undefined}
:{ok:true,phase:"credentials",credentialRef,keyValue};
}
const routeId=typeof draft.routeId==="string"?draft.routeId.trim():"";
const credentialRef=routeId.length===0?"":deriveKeyRef(routeId);
const checked=this.validate();
if(!checked.ok){
return{ok:false,error:checked.error,errors:checked.errors};
}
const profilePath=this.profilePath();
return{
ok:true,
phase:"settings",
credentialRef,
keyValue:keyValue.length===0?undefined:keyValue,
expectedRevision,
ops:[{op:"set",path:profilePath,value:deepClone(checked.profile)}],
};
},
acceptSettings(view,credentialRef){
const routeId=typeof draft.routeId==="string"?draft.routeId.trim():"";
settingsCommitted=true;
committedProfilePath=[...profileBasePath,routeId];
committedCredentialRef=isNonEmptyString(credentialRef)?credentialRef:deriveKeyRef(routeId);
if(isPlainObject(view)&&Number.isSafeInteger(view.revision))committedRevision=view.revision;
return draft;
},
acceptCredential(){
draft={...draft,apiKey:""};
return draft;
},
};
}
function canCreateCustomProvider({namespace,protocols,writable}={}){
if(!isPlainObject(namespace))return false;
if(writable===false)return false;
return(Array.isArray(protocols)?protocols:[]).some((entry)=>isNonEmptyString(entry));
}
function buildCustomCardModel(input){
const source=isPlainObject(input)?input:{};
const draft=isPlainObject(source.draft)?source.draft:{};
const errors=isPlainObject(source.errors)?source.errors:{};
const readOnly=source.readOnly===true;
const saving=source.saving===true;
const submitted=source.submitted===true;
const expanded=new Set(
source.expandedRows instanceof Set
?[...source.expandedRows]
:(Array.isArray(source.expandedRows)?source.expandedRows:[]),
);
const defaultInput=Array.isArray(source.defaultInput)?source.defaultInput:undefined;
const rows=modelDraftsOf(draft.models);
const routeId=typeof draft.routeId==="string"?draft.routeId.trim():"";
const protocols=(Array.isArray(source.protocols)?source.protocols:[])
.filter((entry)=>isNonEmptyString(entry));
const disabled=readOnly||saving;
const profileLocked=submitted||readOnly;
const profileDisabled=profileLocked||saving;
const credentialRef=isNonEmptyString(source.credentialRef)
?source.credentialRef
:(routeId.length===0?"":deriveKeyRef(routeId));
return{
title:"添加自定义提供方",
readOnly,
saving,
submitted,
profileLocked,
credentialRef,
error:isNonEmptyString(source.error)?source.error:null,
routeId:{
value:routeId,
error:isNonEmptyString(errors.routeId)?errors.routeId:null,
credentialRef,
disabled:profileDisabled,
},
displayName:{
value:typeof draft.displayName==="string"?draft.displayName:"",
error:isNonEmptyString(errors.displayName)?errors.displayName:null,
disabled:profileDisabled,
},
baseUrl:{
value:typeof draft.baseURL==="string"?draft.baseURL:"",
error:isNonEmptyString(errors.baseURL)?errors.baseURL:null,
placeholder:"https://api.example.com/v1",
disabled:profileDisabled,
},
protocol:{
value:typeof draft.api==="string"?draft.api:"",
error:isNonEmptyString(errors.api)?errors.api:null,
disabled:profileDisabled,
options:protocols.map((choice)=>({value:choice,label:choice})),
},
apiKey:{
value:typeof draft.apiKey==="string"?draft.apiKey:"",
type:"password",
autoComplete:"off",
disabled,
placeholder:"粘贴 API Key（可留空，沿用 provider 原生/环境凭据）",
},
models:rows.map((model,index)=>({
index,
position:index+1,
id:{value:typeof model.id==="string"?model.id:""},
name:{value:typeof model.name==="string"?model.name:""},
...modelLimitFieldsOf(model),
...modelReasoningFieldsOf(model,index,defaultInput,expanded),
})),
modelsError:isNonEmptyString(errors.models)?errors.models:null,
actions:{
submit:disabled||routeId.length===0?"disabled":"enabled",
cancel:saving?"disabled":"enabled",
addModel:profileLocked?"disabled":(disabled?"disabled":"enabled"),
},
};
}
const api=Object.freeze({
SYMBOL,
REASONING_EFFORTS,
REASONING_EFFORT_EMPTY,
INPUT_MODALITIES,
DEFAULT_INPUT_MODALITIES,
isPlainObject,
isSchemaNode,
isNonEmptyString,
jsonEqual,
deepClone,
getPath,
hasPath,
setPath,
deletePath,
getSubtree,
deriveKeyRef,
modelDisplayNameOf,
modelInputOf,
modelDraftsOf,
inputOverrideOf,
emptyEffortSelection,
effortSelectionFor,
effortSelectionEqual,
unknownEffortKeysOf,
hasUnknownEffortKeys,
selectedLevelsOf,
reasoningDiffLines,
applyEffortSelection,
normalizeEffortsEntry,
createModelRow,
inputSelectionFor,
patchModelDraft,
setModelEffortSelection,
setModelInputSelection,
removeModelRow,
appendModelRow,
parseCapacity,
formatCapacity,
validateModelRows,
normalizeModelRows,
pathOps,
hasOps,
revisionConflictOf,
createEditorBaseline,
isOverridden,
inheritedModelsOf,
materializeOverrideOps,
restoreDefaultOps,
modelCatalogOps,
providerSubtreeOps,
importNamespace,
catalogOpsFor,
modelCardApply,
providerListSections,
apiKeyField,
buildModelCardModel,
createCardSession,
modelEditableProfileOf,
EDITABLE_PROFILE_FIELDS,
buildSectionModel,
validateRouteId,
validateBaseUrl,
validateProtocol,
validateCustomProviderDraft,
createCustomProviderDraft,
canCreateCustomProvider,
buildCustomCardModel,
modelOverrideDecision,
modelChoicesOf,
indexModelsById,
adoptModels,
joinProviderDirectory,
providerEditable,
providerRemovable,
providerProfileOf,
apiKeyEnvOf,
credentialRefOf,
protocolChoices,
createSchemaAdapter,
namespaceSchemaInfo,
validateProfileDraft,
rolesAffectedByChange,
reasoningGuardMessage,
removedLevelsOf,
namespaceViewOf,
roleDefaultsOf,
});
global[SYMBOL]=api;
})(typeof globalThis!=="undefined"?globalThis:this);
/* source: client-text.js */
(function installClientText(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-text");
const clientExpertGroupModelSymbol=Symbol.for("dsh-expert-group/client-expert-group-model");
const expertGroupModel=global[clientExpertGroupModelSymbol];
const localeModelApi=()=>globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")]??expertGroupModel;
function resolveSettingsLocale(ctx){
const model=localeModelApi();
const sources={
ctxLocale:(()=>{try{return ctx?.locale;}catch{return undefined;}})(),
i18nLocale:(()=>{try{return ctx?.i18n?.locale;}catch{return undefined;}})(),
documentLang:(()=>{try{return globalThis.document?.documentElement?.lang;}catch{return undefined;}})(),
navigatorLanguage:(()=>{try{return globalThis.navigator?.language;}catch{return undefined;}})(),
};
if(typeof model?.resolveClientLocale==="function")return model.resolveClientLocale(sources);
const candidates=[sources.ctxLocale,sources.i18nLocale,sources.documentLang,sources.navigatorLanguage];
return candidates.some((value)=>typeof value==="string"&&value.trim().toLowerCase().startsWith("en"))?"en":"zh";
}
const SETTINGS_ZH_FALLBACK=Object.freeze({
"settings.title":"dsh-expert-group",
"settings.hint":"专家模型使用 DSH 当前已配置的 provider 和模型目录。",
"settings.taskManagement":"任务管理",
"settings.auto":"Auto",
"settings.autoTitle":"自动打开运行中的子代理侧栏会话",
"settings.sidebarEntry":"左侧栏入口",
"settings.notifications":"通知弹窗",
"settings.notificationVolume":"通知音量",
"settings.notificationEvents":"通知事件",
"settings.notificationVolume.range":"通知音量滑块",
"settings.notificationVolume.number":"通知音量数值",
"settings.notificationEvent.completed":"任务完成",
"settings.roleTimeout.aria":"角色默认超时",
"settings.notificationEvent.completed.aria":"通知任务完成",
"settings.notificationEvent.waiting.aria":"通知等待用户",
"settings.notificationEvent.failed.aria":"通知任务失败",
"settings.notificationEvent.waiting":"等待用户",
"settings.notificationEvent.failed":"任务失败",
"settings.unifiedProvider":"统一供应商",
"settings.noProvider":"无",
"settings.observerPreferred":"Observer优先",
"settings.orchestrator.empty":"未配置（不干预主代理模型）",
"settings.concurrencyLimit":"单个角色并发上限",
"settings.concurrencyLimit.title":"取值范围 1–64 的整数；默认 20；保存后生效",
"settings.roleTimeout":"角色默认超时 (s)",
"settings.roleTimeout.title":"默认 10 小时（36000 秒）；0 = 不启用；启用值为 1–86400 秒（整数，精度 1 秒）。只影响保存之后创建的尝试，不改变运行中分片。",
"settings.save":"保存",
"settings.saving":"保存中…",
"settings.discard":"放弃修改",
"settings.saved":"已保存",
"settings.unsaved":"有未保存的修改",
});
function interpolateSettingsTemplate(template,vars){
const values=vars!==null&&typeof vars==="object"?vars:{};
return template.replace(/\{([a-z][a-z0-9_]*)\}/gi,(match,name)=>{
const value=values[name];
return value===void 0||value===null?match:String(value);
});
}
function settingsText(locale,key,vars){
const model=localeModelApi();
if(typeof model?.translateMessage==="function")return model.translateMessage(locale,key,vars);
const template=SETTINGS_ZH_FALLBACK[key];
if(template===undefined)return"—";
return interpolateSettingsTemplate(template,vars);
}
const SETTINGS_EXTRA_MESSAGES=Object.freeze({
"settings.modelCandidates.fallbackLimit":{zh:"自动降级上限"},
"settings.modelCandidates.fallbackLimit.title":{zh:"0 = 不降级；默认 2；最多 4。只影响保存之后创建的尝试。"},
"settings.modelTabs.primary":{zh:"主模型"},
"settings.modelTabs.candidate":{zh:"候选{index}"},
"settings.modelTabs.add":{zh:"添加候选页"},
"settings.modelTabs.add.title":{zh:"把主模型页六个角色的选择复制到新的候选页"},
"settings.modelTabs.limit":{zh:"最多 3 个候选页（共 4 页）"},
"settings.modelTabs.remove":{zh:"删除这个候选页"},
"settings.modelTabs.remove.title":{zh:"删除候选页"},
"settings.modelTabs.remove.message":{zh:"删除「候选{index}」会同时删除六个专家在该层的模型配置；保存后生效。"},
"settings.modelCandidates.limit":{zh:"每个角色最多 3 个候选"},
"settings.modelCandidates.error.incomplete":{zh:"候选第 {index} 行需要同时填写供应商和模型"},
"settings.modelCandidates.error.duplicate":{zh:"候选第 {index} 行与前面的候选重复"},
"settings.pv.entry":{zh:"峰谷模式"},
"settings.pv.enable":{zh:"启用峰谷模式"},
"settings.pv.uninit":{zh:"首次启用会从普通配置复制峰、谷两套模型"},
"settings.pv.back":{zh:"返回"},
"settings.pv.peak":{zh:"峰时"},
"settings.pv.valley":{zh:"谷时"},
"settings.pv.disabled":{zh:"峰谷：未启用"},
"settings.pv.add":{zh:"添加峰段"},
"settings.pv.remove":{zh:"删除"},
"settings.pv.remove.aria":{zh:"删除峰段"},
"settings.pv.start":{zh:"开始"},
"settings.pv.end":{zh:"结束"},
"settings.pv.noValley":{zh:"当前没有谷时"},
"settings.pv.invalid":{zh:"峰谷时段不合法：{reason}"},
"settings.pv.broken":{zh:"峰谷配置损坏，请到峰谷设置页修复"},
"settings.pv.repairHint":{zh:"峰谷配置已损坏，请修复后保存"},
"settings.pv.repair":{zh:"修复并保存"},
"settings.pv.mainScope":{zh:"本页正在编辑{period}模型（打开页面时锁定）"},
"settings.pv.boundary":{zh:"当前已进入{current}，本页仍在编辑{editing}模型"},
});
function settingsExtraText(locale,key,vars){
const entry=SETTINGS_EXTRA_MESSAGES[key];
if(entry===void 0)return settingsText(locale,key,vars);
const template=typeof entry[locale]==="string"&&entry[locale].length>0?entry[locale]:entry.zh;
return interpolateSettingsTemplate(template,vars);
}
global[SYMBOL]=Object.freeze({
SETTINGS_EXTRA_MESSAGES,SETTINGS_ZH_FALLBACK,resolveSettingsLocale,settingsExtraText,settingsText,
});
})(globalThis);
/* source: client-styles.js */
(function installClientStyles(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-styles");
const css=".deg_settings{display:flex;flex-direction:column;gap:18px;max-width:760px;color:var(--dsw-alias-label-primary)}"+
".deg_main_page{height:100%;overflow:auto;padding:32px;box-sizing:border-box}.deg_main_page>.deg_settings{max-width:760px;margin:0 auto}"+
"[data-platform=darwin] .deg_main_page{padding-top:calc(32px + var(--dsh-frame-top-clearance,0px))}.deg_settings_title{font-size:20px;font-weight:600;line-height:28px;margin:0}.deg_settings_hint{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0}.deg_settings_row{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,280px);align-items:center;gap:20px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}"+
".deg_settings_task_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:28px;row-gap:12px;min-height:29px}.deg_settings_task_row>.deg_settings_checkbox{flex:0 0 auto;white-space:nowrap;height:29px;box-sizing:border-box}"+
".deg_settings_unified_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:32px;row-gap:12px;min-width:0}.deg_settings_provider_group,.deg_settings_fallback_group{display:flex;align-items:center;gap:10px;min-width:0;flex:0 1 auto}.deg_settings_provider_group>.deg_settings_label,.deg_settings_fallback_group>.deg_settings_label{flex:0 0 auto;white-space:nowrap}.deg_settings_provider_group>.deg_settings_control{flex:0 1 auto;min-width:0}.deg_settings_provider_group select.deg_settings_provider_select{flex:0 1 176px;width:176px;min-width:0;max-width:200px}"+
"@media (max-width:520px){.deg_settings_unified_row{column-gap:20px;row-gap:12px}.deg_settings_provider_group{flex:1 1 100%}}"+
".deg_settings_management_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:32px;row-gap:12px;min-width:0}.deg_settings_management_row>.deg_settings_checkbox{flex:0 0 auto;white-space:nowrap;height:29px;box-sizing:border-box}"+
".deg_settings_management_row>.deg_settings_control{flex:0 0 auto;min-width:max-content;white-space:nowrap;height:29px;box-sizing:border-box}"+
"@media (max-width:520px){.deg_settings_management_row{column-gap:20px;row-gap:12px}}.deg_settings_label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}.deg_settings_control{display:flex;align-items:center;gap:10px;min-width:0}.deg_settings_control input[type=range]{width:100%;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}.deg_settings_control input[type=number]{width:72px;box-sizing:border-box;padding:6px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}.deg_settings_control select{width:100%;min-width:0;box-sizing:border-box;padding:7px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}.deg_settings_control select:disabled,.deg_settings_control input:disabled{opacity:.5;cursor:not-allowed}.deg_settings_checkbox{display:flex;align-items:center;gap:8px;cursor:pointer}.deg_settings_checkbox input{width:16px;height:16px;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}.deg_settings_table_wrap{width:100%;min-width:0;overflow-x:auto;overflow-y:hidden;-webkit-overflow-scrolling:touch}"+
".deg_settings_table{display:grid;min-width:540px;grid-template-columns:minmax(84px,.6fr) minmax(132px,.82fr) minmax(210px,1.5fr) minmax(96px,.62fr);border-top:1px solid var(--dsw-alias-border-l2)}.deg_settings_table_head,.deg_settings_table_cell{min-width:0;padding:10px 6px;border-bottom:1px solid var(--dsw-alias-border-l2)}.deg_settings_table_head{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);font-weight:600}.deg_settings_table_cell{display:flex;align-items:center;font-size:13px;line-height:20px}.deg_settings_table_cell select{width:100%;min-width:0;box-sizing:border-box;padding:6px 6px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px}.deg_settings_table_cell select.deg_settings_provider_select{max-width:170px}.deg_settings_table_cell select.deg_settings_model_select{max-width:260px}.deg_settings_table_cell select.deg_settings_effort_select{max-width:112px}.deg_settings_table_cell select:disabled{opacity:.5;cursor:not-allowed}.deg_settings_role_cell{padding:0;align-items:center}.deg_settings_role_button{display:flex;align-items:center;justify-content:center;gap:7px;flex:0 0 74px;width:74px;height:28px;min-height:28px;padding:4px 6px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;line-height:20px;cursor:pointer;text-align:center}.deg_settings_role_button:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-label-secondary)}.deg_settings_role_button:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}.deg_settings_role_button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-secondary,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}.deg_settings_role_button:disabled{opacity:.45;cursor:not-allowed}.deg_settings_prompt_customized_dot{display:inline-block;width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}.deg_settings_prompt_editor{display:flex;flex-direction:column;gap:14px;min-width:0}.deg_prompt_header{display:flex;align-items:center;justify-content:center;min-width:0}.deg_prompt_header .deg_settings_title{margin:0;overflow-wrap:anywhere;text-align:center}.deg_prompt_back{flex:0 0 auto}.deg_prompt_label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);font-weight:600}.deg_prompt_textarea{display:block;width:100%;min-height:320px;max-height:60vh;box-sizing:border-box;resize:vertical;overflow:auto;padding:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:13px/20px var(--ds-font-family-code,var(--ds-font-family-sans));white-space:pre-wrap}.deg_prompt_textarea:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}.deg_prompt_textarea:disabled{opacity:.55;cursor:not-allowed}.deg_prompt_counter{display:flex;justify-content:flex-end;margin-top:-8px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.deg_prompt_counter_warning{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}.deg_prompt_counter_error{color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}.deg_prompt_status{min-height:18px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.deg_prompt_footer{display:flex;align-items:center;gap:8px;padding-top:4px}.deg_prompt_footer .deg_btn{flex:0 0 auto;min-width:88px}.deg_prompt_footer .deg_prompt_status{margin-right:auto}.deg_btn_primary{color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}.deg_btn_primary:hover:not(:disabled){filter:brightness(1.08)}.deg_settings_table_cell .deg_settings_role_button + *{min-width:0}.deg_settings_footer{display:flex;justify-content:flex-end;align-items:center;gap:8px;padding-top:4px}.deg_settings_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin-right:auto}.deg_settings_error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));white-space:pre-wrap}.deg_btn{flex:1;box-sizing:border-box;min-height:32px;padding:6px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;cursor:pointer}.deg_btn:hover:not(:disabled):not(.deg_btn_primary){background:var(--dsw-alias-interactive-bg-hover)}"+
".deg_btn:disabled{opacity:.45;cursor:not-allowed}.deg_btn.deg_btn_primary{color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}.deg_prompt_dialog_backdrop{position:fixed;inset:0;z-index:30;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.45)}.deg_prompt_dialog{width:min(100%,440px);box-sizing:border-box;padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;box-shadow:0 12px 28px rgba(0,0,0,.28)}.deg_prompt_dialog h3{margin:0 0 8px;font-size:16px;line-height:24px;color:var(--dsw-alias-label-primary)}.deg_prompt_dialog p{margin:0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px}.deg_prompt_dialog_actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:8px;margin-top:18px}"+
".deg_settings_notification_row{display:flex;align-items:center;flex-wrap:wrap;column-gap:24px;row-gap:12px;min-width:0;white-space:nowrap}.deg_settings_notification_row>.deg_settings_checkbox{flex:0 0 auto}.deg_settings_notification_row>.deg_settings_control{flex:1 1 220px;min-width:160px}.deg_settings_notification_row>.deg_settings_control .deg_settings_label{flex:0 0 auto;white-space:nowrap}.deg_settings_notification_row>.deg_settings_control input[type=range]{flex:1 1 auto;min-width:48px}.deg_settings_notification_row>.deg_settings_control input[type=number]{flex:0 0 72px;width:72px}"+
".deg_settings_events_dropdown{position:relative;flex:0 0 auto;min-width:0}.deg_settings_events_trigger{display:inline-flex;align-items:center;gap:6px;height:29px;box-sizing:border-box;padding:0 10px;color:var(--dsw-alias-label-primary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}.deg_settings_events_trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.deg_settings_events_trigger:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}.deg_settings_events_trigger:disabled{opacity:.45;cursor:not-allowed}.deg_settings_events_count{color:var(--dsw-alias-label-secondary)}.deg_settings_events_caret{display:inline-block;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;transform:translateY(1px)}"+
".deg_settings_events_panel{position:absolute;top:calc(100% + 6px);right:0;z-index:20;display:flex;flex-direction:column;gap:8px;min-width:180px;box-sizing:border-box;padding:10px 12px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;box-shadow:0 8px 20px rgba(0,0,0,.16)}.deg_settings_events_panel .deg_settings_checkbox{height:20px}"+
"@media (max-width:520px){.deg_settings_notification_row{flex-wrap:wrap;row-gap:12px}.deg_settings_notification_row>.deg_settings_control{flex-basis:100%}.deg_settings_events_dropdown{flex:1 1 100%}.deg_settings_events_panel{left:0;right:auto}}.deg_subagent_metadata{display:block;box-sizing:border-box;min-width:0;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,var(--dsw-alias-label-primary));font-size:11px;line-height:16px}.deg_full_system_prompt_root[data-open]{padding-bottom:4px}.deg_full_system_prompt_chevron{color:var(--dsw-alias-label-secondary)}.deg_full_system_prompt_body{box-sizing:border-box;width:calc(100% - 22px - var(--dsh-content-font-delta, 0px));margin:4px 0 0 calc(22px + var(--dsh-content-font-delta, 0px));max-height:141px;overflow:auto;padding:10px 16px 12px 12px;border:none;border-radius:8px;background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-tertiary);font:400 11px/16px var(--ds-font-family-code)}.deg_full_system_prompt{box-sizing:border-box;margin:0;white-space:pre-wrap;overflow-wrap:anywhere}"+
".deg_mc_section{display:flex;flex-direction:column;gap:10px;padding:14px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.deg_mc_header{display:flex;align-items:center;gap:8px;min-width:0}.deg_mc_toggle{display:flex;align-items:center;gap:8px;flex:1 1 auto;min-width:0;padding:0;color:var(--dsw-alias-label-primary);background:transparent;border:none;font:inherit;font-size:13px;line-height:20px;font-weight:600;text-align:left;cursor:pointer}.deg_mc_toggle:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}.deg_mc_chevron{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}.deg_mc_body{display:flex;flex-direction:column;gap:10px;min-width:0}.deg_mc_cards{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}.deg_mc_card{display:flex;flex-direction:column;gap:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.deg_mc_card_head{display:flex;align-items:center;gap:8px;min-width:0;flex-wrap:wrap}.deg_mc_card_name{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}.deg_mc_card_route{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);font-family:var(--ds-font-family-code,inherit)}.deg_mc_card_actions{display:flex;align-items:center;gap:8px;margin-left:auto}.deg_mc_card_actions .deg_btn{flex:0 0 auto;min-width:64px}.deg_mc_card_actions .deg_mc_delete_btn{color:var(--dsw-alias-state-error-primary,#ef4444)}.deg_mc_dot[data-state=available]{background:var(--dsw-alias-state-success-primary,#22c55e)}.deg_mc_dot{display:inline-block;width:6px;height:6px;flex:0 0 6px;border-radius:50%;background:var(--dsw-alias-label-secondary)}.deg_mc_field{display:grid;grid-template-columns:minmax(0,1fr) minmax(150px,240px);align-items:center;gap:12px}.deg_mc_field_label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary)}.deg_mc_input,.deg_mc_select{box-sizing:border-box;width:100%;min-width:0;padding:6px 8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:12px;line-height:18px}.deg_mc_input:disabled,.deg_mc_select:disabled{opacity:.5;cursor:not-allowed}.deg_mc_input:focus-visible,.deg_mc_select:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}.deg_mc_models{display:flex;flex-direction:column;gap:8px;min-width:0;padding-top:4px;border-top:1px solid var(--dsw-alias-border-l2)}.deg_mc_models_head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}.deg_mc_models_title{font-size:12px;line-height:18px;font-weight:600;color:var(--dsw-alias-label-primary)}.deg_mc_models_meta{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.deg_mc_models_head .deg_btn{margin-left:auto;flex:0 0 auto;min-width:auto}.deg_mc_model{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1)}.deg_mc_model_main{display:flex;align-items:center;gap:6px;min-width:0}.deg_mc_model_main .deg_mc_input{flex:1 1 0;min-width:0}.deg_mc_icon_btn{flex:0 0 auto;min-width:auto;width:26px;height:26px;padding:0;line-height:1}.deg_mc_model_advanced{display:grid;grid-template-columns:max-content minmax(64px,1fr) max-content minmax(64px,1fr);column-gap:8px;row-gap:8px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2)}.deg_mc_model_advanced>.deg_mc_field{display:contents}.deg_mc_model_advanced>.deg_mc_field .deg_mc_field_label{align-self:center;min-width:0}.deg_mc_model_advanced>.deg_mc_field .deg_mc_input{min-width:0;text-align:center}.deg_mc_model_advanced>.deg_mc_efforts{grid-column:1 / -1}@media (max-width:640px){.deg_mc_model_advanced{grid-template-columns:max-content minmax(64px,1fr)}.deg_mc_model_advanced>.deg_mc_efforts{grid-column:1 / -1}}.deg_mc_efforts{margin:0;padding:0;border:none;min-width:0}.deg_mc_efforts_label{padding:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}.deg_mc_efforts_row{display:flex;flex-wrap:wrap;gap:10px;margin-top:4px}.deg_mc_effort{display:inline-flex;align-items:center;gap:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer}.deg_mc_effort input{width:14px;height:14px;accent-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}.deg_mc_input_types{display:flex;flex-wrap:wrap;gap:10px}.deg_mc_hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}"+
".deg_mc_error,.deg_remove_confirm_error{font-size:12px;line-height:18px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171));white-space:pre-wrap}.deg_mc_card_footer{display:flex;align-items:center;gap:8px;padding-top:2px}.deg_mc_card_footer .deg_mc_status{margin-right:auto}.deg_mc_card_footer .deg_btn{flex:0 0 auto;min-width:76px}.deg_mc_conflict{display:flex;flex-direction:column;gap:6px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.deg_mc_conflict_actions{display:flex;gap:8px}.deg_mc_conflict_actions .deg_btn{flex:0 0 auto;min-width:96px}.deg_mc_add{display:flex;align-items:center;gap:8px;flex-wrap:wrap;width:100%}.deg_mc_add .deg_mc_select{width:auto;min-width:160px;flex:0 1 auto}"+
".deg_mc_entries{display:flex;align-items:center;gap:8px;flex:1 1 100%;width:100%;min-width:0}.deg_mc_entries>.deg_btn{flex:1 1 0;min-width:0;border-style:dashed}.deg_mc_entries>.deg_btn::before{content:\"+\";display:inline-block;margin-right:4px;font-size:16px;line-height:1}.deg_mc_create{display:flex;flex-direction:column;gap:10px;padding:12px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-2)}.deg_mc_create_head{display:flex;align-items:center;gap:8px;min-width:0}.deg_mc_create_title{font-size:13px;line-height:20px;font-weight:600;color:var(--dsw-alias-label-primary)}.deg_mc_field_error{border-color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}.deg_mc_field_row{display:flex;flex-direction:column;gap:4px;min-width:0}.deg_mc_field_message{font-size:11px;line-height:16px;color:var(--dsw-alias-label-error,var(--dsw-alias-state-error-primary,#f87171))}.deg_mc_create_footer{display:flex;align-items:center;gap:8px;padding-top:2px}.deg_mc_create_footer .deg_mc_status{margin-right:auto}.deg_mc_create_footer .deg_btn{flex:0 0 auto;min-width:88px}.deg_mc_modal_backdrop{position:fixed;inset:0;z-index:40;display:flex;align-items:center;justify-content:center;padding:20px;background:rgba(0,0,0,.45)}.deg_mc_modal{display:flex;flex-direction:column;gap:12px;width:min(100%,380px);max-height:min(80vh,420px);box-sizing:border-box;padding:18px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:0 12px 28px rgba(0,0,0,.28)}.deg_mc_modal_header{display:flex;align-items:center;gap:8px;min-width:0}.deg_mc_modal_title{flex:1 1 auto;min-width:0;margin:0;font-size:15px;line-height:22px;color:var(--dsw-alias-label-primary)}.deg_mc_modal_close{flex:0 0 auto;width:28px;height:28px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font-size:20px;line-height:28px;cursor:pointer}.deg_mc_modal_close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.deg_mc_modal_description{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}.deg_mc_candidate_toolbar{display:flex;align-items:center;gap:8px;min-width:0}.deg_mc_candidate_search{flex:1 1 auto;min-width:0}.deg_mc_candidate_toolbar .deg_btn{flex:0 0 auto;min-width:auto;white-space:nowrap}.deg_mc_candidate_list{display:flex;flex-direction:column;gap:2px;max-height:240px;margin:0;overflow:auto;padding:0;list-style:none}.deg_mc_candidate_item{border-radius:6px}.deg_mc_candidate_label{display:flex;align-items:center;gap:8px;padding:6px 8px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px;cursor:pointer}.deg_mc_candidate_id{flex:1 1 auto;min-width:0;overflow-wrap:anywhere;font-family:var(--ds-font-family-code,inherit)}.deg_mc_candidate_empty{margin:18px 0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;text-align:center}.deg_mc_modal_footer{display:flex;justify-content:flex-end;gap:8px;padding-top:2px}.deg_mc_modal_footer .deg_btn{flex:0 0 auto;min-width:76px}"+
"[data-deg-settings-nav-native]{display:none}[data-deg-settings-nav-icon]{flex:none}"+
".deg_pd{display:flex;flex-direction:column;gap:12px;width:min(100%,760px);min-width:0;box-sizing:border-box;color:var(--dsw-alias-label-primary)}.deg_pd_title{font-size:14px;line-height:22px;font-weight:600;margin:0}.deg_pd_roles{display:flex;flex-direction:column;gap:0;list-style:none;margin:0;padding:0}.deg_pd_roles_header{display:grid;grid-template-columns:minmax(84px,.7fr) minmax(0,1.6fr) auto;gap:10px;padding:6px 0 2px;border-top:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}.deg_pd_roles_header span{min-width:0}.deg_pd_roles_header span:last-child{text-align:right}.deg_pd_role{display:grid;grid-template-columns:minmax(84px,.7fr) minmax(0,1.6fr) auto;align-items:center;gap:10px;min-height:30px;padding:5px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}.deg_pd_role:last-child{border-bottom:0}.deg_pd_role_name{min-width:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}.deg_pd_role_value{min-width:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.deg_pd_role_value[title]{cursor:help}.deg_pd_role_state{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));white-space:nowrap;text-align:right}.deg_pd_role[data-deg-role-state=configured] .deg_pd_role_state{color:var(--dsw-alias-state-success-primary,var(--dsw-alias-label-secondary))}.deg_pd_role[data-deg-role-state=disabled] .deg_pd_role_name,.deg_pd_role[data-deg-role-state=disabled] .deg_pd_role_value{color:var(--dsw-alias-label-secondary)}"+
".deg_pd_role[data-deg-role-state=incomplete] .deg_pd_role_state{color:var(--dsw-alias-state-warning-primary,var(--dsw-alias-label-secondary))}.deg_pd_providers{display:flex;align-items:flex-start;gap:10px;min-width:0;flex-wrap:wrap}.deg_pd_label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);flex:0 0 auto}.deg_pd_providers_list{display:flex;align-items:flex-start;gap:6px;flex:1 1 auto;flex-wrap:wrap;min-width:0;max-width:100%}.deg_pd_tag{max-width:100%;box-sizing:border-box;font-size:11px;line-height:16px;padding:1px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}.deg_pd_tag[data-deg-provider-known=false]{border-style:dashed;color:var(--dsw-alias-label-secondary)}.deg_pd_empty{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}.deg_pd_status{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);margin:0;overflow-wrap:anywhere}.deg_pd_actions{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;padding-top:2px}.deg_pd_actions .deg_pd_open{flex:0 0 auto;min-width:auto}.deg_pd_actions .deg_pd_open:hover:not(:disabled),.deg_pd_actions .deg_pd_open:focus-visible:not(:disabled){color:var(--dsw-alias-label-on-primary,var(--dsw-alias-bg-layer-1));background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));filter:brightness(1.08)}.deg_pd_actions .deg_pd_open:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:2px}.deg_pd_actions .deg_pd_open:disabled{opacity:1;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));background:transparent;border-color:var(--dsw-alias-border-l2)}.deg_pd_note{min-width:0;flex:1 1 220px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}"+
"@media (max-width:480px){.deg_pd_roles_header,.deg_pd_role{grid-template-columns:minmax(72px,auto) minmax(0,1fr);column-gap:8px}.deg_pd_roles_header{padding-top:5px}.deg_pd_roles_header span:last-child{grid-column:2;text-align:left}.deg_pd_role{align-items:start;row-gap:2px;padding:7px 0}.deg_pd_role_name{grid-row:1 / span 2;align-self:start}.deg_pd_role_value{white-space:normal;overflow-wrap:anywhere;text-overflow:clip}.deg_pd_role_state{grid-column:2;justify-self:start;text-align:left}}"+
".deg_settings_model_tabs{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;padding:0 0 8px;border-bottom:1px solid var(--dsw-alias-border-l2)}"+
".deg_settings_model_tab{display:inline-flex;align-items:center;gap:6px;height:28px;box-sizing:border-box;padding:0 10px;color:var(--dsw-alias-label-secondary);background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;font:inherit;font-size:13px;line-height:20px;cursor:pointer;user-select:none;touch-action:none}.deg_settings_model_tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.deg_settings_model_tab:focus-visible{outline:2px solid var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary));outline-offset:1px}.deg_settings_model_tab[aria-selected=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-secondary,var(--dsw-alias-bg-layer-2));border-color:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-secondary))}"+
".deg_settings_model_tab[data-dragging=true]{opacity:.55;cursor:grabbing}.deg_settings_model_tab_remove{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:14px;line-height:1;cursor:pointer}.deg_settings_model_tab_remove:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.deg_settings_model_tab_remove:disabled{opacity:.45;cursor:not-allowed}.deg_settings_model_tab_add{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;padding:0;border:1px dashed var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;line-height:1;cursor:pointer}.deg_settings_model_tab_add:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.deg_settings_model_tab_add:disabled{opacity:.45;cursor:not-allowed}"+
".deg_settings_model_tab_drop{flex:0 0 2px;align-self:stretch;min-height:24px;border-radius:1px;background:var(--dsw-alias-interactive-bg-primary,var(--dsw-alias-label-primary))}@media (max-width:520px){.deg_settings_model_tabs{gap:4px}}"+
".deg_settings_model_tablist{display:flex;align-items:center;flex-wrap:wrap;gap:6px;min-width:0;flex:1 1 auto}.deg_settings_peak_valley_entry{margin-left:auto;white-space:nowrap}.deg_settings_peak_valley_entry_active,.deg_expert_group_header_peak_valley:not([data-peak-valley=disabled]){border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}"+
".deg_settings_peak_valley_state{margin-left:auto;padding:1px 8px;border-radius:6px;border:1px solid var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:18px;white-space:nowrap}"+
".deg_settings_pv_period_toggle{display:flex;align-items:center;gap:6px;margin-left:auto;flex:0 0 auto;min-width:0}.deg_settings_pv_period_toggle .deg_btn{flex:0 0 auto;height:28px;min-height:28px;padding:0 10px;font-size:13px;line-height:20px;white-space:nowrap}"+
".deg_settings_peak_valley_periods,.deg_settings_peak_valley_period_list{display:flex;flex-direction:column;gap:10px;min-width:0}"+
".deg_settings_peak_valley_period_list .deg_btn{flex:0 0 auto;margin-left:auto}"+
".deg_settings_pv_footer{flex-wrap:wrap;row-gap:8px}.deg_settings_pv_footer .deg_btn{flex:0 0 20%}.deg_settings_pv_footer .deg_settings_status{flex:1 1 auto;min-width:0;overflow-wrap:anywhere}@media (max-width:520px){.deg_settings_pv_footer{row-gap:6px}}"+
".deg_sd_row_action{display:inline-flex;align-items:center;justify-content:center;flex:none;width:20px;height:20px;padding:0;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-state-error-primary,#ef4444);cursor:pointer}.deg_sd_row_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.deg_sd_row_action:disabled{opacity:.45;cursor:not-allowed}.deg_sd_icon{display:block;width:16px;height:16px}"+
".deg_sd_menu_item{display:flex;align-items:center;gap:6px;width:100%;box-sizing:border-box;padding:6px 10px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}.deg_sd_menu_item.deg_sd_danger{color:var(--dsw-alias-state-error-primary,#ef4444)}"+
".deg_sd_check{flex:none;width:14px;height:14px;margin:0;cursor:pointer;accent-color:var(--dsw-alias-state-error-primary,#ef4444)}"+
"body.deg_sd_selecting{--deg-sd-reserve:48px}body.deg_sd_selecting [class*=regionArea]{padding-bottom:var(--deg-sd-reserve)}"+
".deg_sd_bar{display:flex;align-items:center;flex-wrap:wrap;gap:4px;box-sizing:border-box;max-height:min(30vh,152px);overflow:auto;padding:3px 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 -4px 16px rgba(0,0,0,.16);color:var(--dsw-alias-label-primary);font-size:12px;line-height:18px}"+
".deg_sd_btn{display:inline-flex;align-items:center;justify-content:center;flex:none;height:22px;padding:0 5px;border:0;border-radius:4px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;cursor:pointer}.deg_sd_btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.deg_sd_btn:disabled,.deg_sd_check:disabled{opacity:.45;cursor:not-allowed}.deg_sd_danger{color:var(--dsw-alias-state-error-primary,#ef4444)}"+
".deg_sd_selectall{width:22px;height:22px;padding:0;margin-left:auto;border:1px dashed var(--dsw-alias-border-l2);border-radius:4px}.deg_sd_selectall .deg_sd_icon{width:13px;height:13px}"+
".deg_sd_selectall:hover:not(:disabled){border-style:solid;border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}.deg_sd_selectall:active:not(:disabled){transform:scale(.9)}"+
".deg_sd_selectall[data-deg-session-delete-selectall-state=all]{border-style:solid;border-color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"+
".deg_sd_selectall:disabled{border-style:dashed;border-color:var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary)}"+
".deg_sd_count{flex:0 0 auto;white-space:nowrap}.deg_sd_blocked{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}"+
".deg_sd_dialog_line{white-space:pre-wrap}";
const cssTagId="dsh-expert-group/settings.module.css";
const cssInjectedDocuments=typeof WeakSet==="function"?new WeakSet():null;
function ensurePluginStylesheet(){
const doc=typeof document!=="undefined"?document:null;
if(doc===null||typeof doc!=="object")return false;
if(cssInjectedDocuments?.has(doc)===true)return true;
const selector="style[data-plugin-css="+JSON.stringify(cssTagId)+"]";
if(typeof doc.querySelector==="function"&&doc.querySelector(selector)!==null){
cssInjectedDocuments?.add(doc);
return true;
}
if(typeof doc.createElement!=="function"||typeof doc.head?.appendChild!=="function")return false;
const tag=doc.createElement("style");
tag.dataset.plugin="dsh-expert-group";
tag.dataset.pluginCss=cssTagId;
tag.textContent=css;
doc.head.appendChild(tag);
cssInjectedDocuments?.add(doc);
return true;
}
ensurePluginStylesheet();
global[SYMBOL]=Object.freeze({
ensurePluginStylesheet,
});
})(globalThis);
/* source: client-fanout-normalize.js */
(function installClientFanoutNormalize(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-fanout-normalize");
const FANOUT_SHARD_STATUS_KEYS=["queued","running","succeeded","failed","cancelled","timed_out","interrupted"];
const FANOUT_TERMINAL_SHARD_STATUSES=new Set(["succeeded","failed","cancelled","timed_out","interrupted"]);
const FANOUT_RETRYABLE_SHARD_STATUSES=new Set(["failed","timed_out","cancelled","interrupted"]);
const FANOUT_STATUS_LABELS={
queued:"排队中",
running:"运行中",
succeeded:"成功",
failed:"失败",
cancelled:"已取消",
timed_out:"已超时",
interrupted:"已中断",
pending:"等待中",
completed:"已完成",
completed_with_errors:"部分失败",
};
function fanoutIsObject(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function cloneFanoutValue(value,seen=new WeakMap()){
if(value===null||typeof value!=="object")return value;
if(seen.has(value))return seen.get(value);
if(Array.isArray(value)){
const clone=[];
seen.set(value,clone);
for(const item of value)clone.push(cloneFanoutValue(item,seen));
return clone;
}
const clone={};
seen.set(value,clone);
for(const key of Object.keys(value))clone[key]=cloneFanoutValue(value[key],seen);
return clone;
}
function fanoutString(value,fallback=void 0){
if(typeof value!=="string")return fallback;
const text=value.trim();
return text.length>0?text:fallback;
}
function fanoutStatusOf(value,fallback){
return fanoutString(value,fallback)??fallback;
}
function fanoutTimestampOf(value){
return typeof value==="number"&&Number.isFinite(value)?value:null;
}
function fanoutCountOf(value,fallback=0){
return Number.isFinite(value)&&value>=0?Math.floor(value):fallback;
}
function normalizeFanoutAttempt(rawAttempt,index,fallbackStatus){
const source=fanoutIsObject(rawAttempt)?rawAttempt:{};
const attempt=Number.isSafeInteger(source.attempt)&&source.attempt>0
?source.attempt
:index+1;
const normalized={
attempt,
status:fanoutStatusOf(source.status,fallbackStatus),
};
for(const field of["error","result","childId","messageId"]){
if(!Object.prototype.hasOwnProperty.call(source,field)||source[field]===void 0)continue;
normalized[field]=cloneFanoutValue(source[field]);
}
return normalized;
}
function normalizeFanoutShard(rawShard){
if(!fanoutIsObject(rawShard))return null;
const shardId=fanoutString(rawShard.shardId);
if(shardId===void 0)return null;
const status=fanoutStatusOf(rawShard.status,"queued");
const attempts=Array.isArray(rawShard.attempts)
?rawShard.attempts.map((attempt,index)=>normalizeFanoutAttempt(attempt,index,status))
:[];
return{
shardId,
prompt:typeof rawShard.prompt==="string"?rawShard.prompt:"",
status,
attempts,
};
}
function deriveFanoutCounts(shards){
const counts={};
for(const key of FANOUT_SHARD_STATUS_KEYS)counts[key]=0;
for(const shard of Array.isArray(shards)?shards:[]){
if(Object.prototype.hasOwnProperty.call(counts,shard?.status))counts[shard.status]+=1;
}
counts.pending=counts.queued+counts.running;
return counts;
}
function normalizeFanoutCounts(rawCounts,shards){
const derived=deriveFanoutCounts(shards);
const source=fanoutIsObject(rawCounts)?rawCounts:{};
const counts={};
for(const key of FANOUT_SHARD_STATUS_KEYS)counts[key]=fanoutCountOf(source[key],derived[key]);
counts.pending=fanoutCountOf(source.pending,counts.queued+counts.running);
return counts;
}
function normalizeFanoutTask(rawTask){
if(!fanoutIsObject(rawTask))return null;
const parentTaskId=fanoutString(rawTask.parentTaskId);
if(parentTaskId===void 0)return null;
const shards=(Array.isArray(rawTask.shards)?rawTask.shards:[])
.map(normalizeFanoutShard)
.filter((shard)=>shard!==null);
return{
parentTaskId,
role:fanoutString(rawTask.role,"unknown"),
basePrompt:typeof rawTask.basePrompt==="string"?rawTask.basePrompt:"",
status:fanoutStatusOf(rawTask.status,"pending"),
createdAt:fanoutTimestampOf(rawTask.createdAt),
updatedAt:fanoutTimestampOf(rawTask.updatedAt),
settledAt:fanoutTimestampOf(rawTask.settledAt),
counts:normalizeFanoutCounts(rawTask.counts,shards),
shards,
};
}
function fanoutTaskLabel(task){
const role=fanoutString(task?.role,"unknown");
const parentTaskId=fanoutString(task?.parentTaskId,"unknown");
return role+" · "+parentTaskId;
}
function fanoutStatusLabel(status){
return FANOUT_STATUS_LABELS[status]??fanoutString(status,"未知状态");
}
function fanoutCanCancelShard(shard){
const status=typeof shard==="string"?shard:shard?.status;
return!FANOUT_TERMINAL_SHARD_STATUSES.has(status);
}
function fanoutCanRetryShard(shard){
const status=typeof shard==="string"?shard:shard?.status;
return FANOUT_RETRYABLE_SHARD_STATUSES.has(status);
}
function fanoutCanCancelParent(task){
return(Array.isArray(task?.shards)?task.shards:[]).some(fanoutCanCancelShard);
}
function normalizeFanoutListResponse(payload,previousState={tasks:[],cursor:0,loaded:false}){
const previous=fanoutIsObject(previousState)
?previousState
:{tasks:[],cursor:0,loaded:false};
if(payload?.ok!==true||!Array.isArray(payload.tasks))return previous;
const tasks=payload.tasks.map(normalizeFanoutTask).filter((task)=>task!==null);
const cursor=Number.isSafeInteger(payload.cursor)&&payload.cursor>=0
?payload.cursor
:fanoutCountOf(previous.cursor,0);
return{...previous,tasks,cursor,loaded:true};
}
function mergeFanoutEvent(task,event){
const current=normalizeFanoutTask(task);
if(current===null||!fanoutIsObject(event)||event.parentTaskId!==current.parentTaskId)return current;
const updates=Array.isArray(event.shards)
?event.shards.filter((shard)=>fanoutString(shard?.shardId)!==void 0)
:fanoutString(event.shardId)===void 0?[]:[event];
const updateByShardId=new Map(updates.map((shard)=>[fanoutString(shard.shardId),shard]));
const shards=current.shards.map((shard)=>{
const update=updateByShardId.get(shard.shardId);
if(!fanoutIsObject(update))return shard;
const nextStatus=fanoutStatusOf(update.status,shard.status);
const attempts=shard.attempts.map((attempt)=>({...attempt}));
const eventAttempt=Number.isSafeInteger(update.attempt)&&update.attempt>0?update.attempt:void 0;
const declaredAttempts=Number.isSafeInteger(update.attempts)&&update.attempts>=0?update.attempts:0;
if(eventAttempt!==void 0){
while(attempts.length<eventAttempt){
attempts.push({attempt:attempts.length+1,status:"queued"});
}
const attemptIndex=attempts.findIndex((attempt)=>attempt.attempt===eventAttempt);
const baseAttempt=attemptIndex>=0?attempts[attemptIndex]:{attempt:eventAttempt,status:nextStatus};
const mergedAttempt=normalizeFanoutAttempt({...baseAttempt,...update,attempt:eventAttempt,status:nextStatus},attemptIndex>=0?attemptIndex:attempts.length,nextStatus);
if(attemptIndex>=0)attempts[attemptIndex]=mergedAttempt;
else attempts.push(mergedAttempt);
}
while(attempts.length<declaredAttempts){
attempts.push({attempt:attempts.length+1,status:nextStatus});
}
return{...shard,status:nextStatus,attempts};
});
const next={
...current,
shards,
counts:normalizeFanoutCounts(event.counts,shards),
updatedAt:fanoutTimestampOf(event.at)??current.updatedAt,
};
if(event.type==="task_settled"){
next.status=fanoutStatusOf(event.status,current.status);
next.settledAt=fanoutTimestampOf(event.at)??current.settledAt;
}else if(updates.some((update)=>update.status==="queued"||update.status==="running")){
next.status="pending";
next.settledAt=null;
}
return normalizeFanoutTask(next);
}
global[SYMBOL]=Object.freeze({
fanoutCanCancelParent,fanoutCanCancelShard,fanoutCanRetryShard,fanoutStatusLabel,fanoutTaskLabel,
mergeFanoutEvent,normalizeFanoutListResponse,normalizeFanoutTask,
});
})(globalThis);
/* source: client-native-status.js */
(function installClientNativeStatus(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-native-status");
const STATUS_ROLE_IDS=["explorer","librarian","oracle","designer","fixer","observer"];
const STATUS_ROLE_LABELS={
explorer:"Explorer",
librarian:"Librarian",
oracle:"Oracle",
designer:"Designer",
fixer:"Fixer",
observer:"Observer",
};
const STATUS_ROLE_MARKER="__degExpertRole";
function normalizeStatusRole(role){
if(typeof role!=="string")return void 0;
const normalized=role.trim().toLowerCase();
return STATUS_ROLE_IDS.includes(normalized)?normalized:void 0;
}
function isPluginChildSession(session){
return session!==null
&&typeof session==="object"
&&((typeof session.parentId==="string"&&session.parentId.length>0)
||(typeof session.parentSessionId==="string"&&session.parentSessionId.length>0)
||session.origin==="subagent"
||(session.subagent!==null&&typeof session.subagent==="object"));
}
function resolveStatusIdentity({sessionId,responseSessionId,response}={}){
if(typeof sessionId!=="string"||sessionId.length===0)return null;
const reportedSessionId=response?.sessionId??responseSessionId;
if(reportedSessionId!==sessionId)return null;
if(response?.ok===false)return{sessionId,kind:"unknown",role:void 0};
if(response?.kind==="child"){
return{sessionId,kind:"child",role:normalizeStatusRole(response?.child?.role)};
}
if(response?.kind==="root")return{sessionId,kind:"root",role:void 0};
return{sessionId,kind:"unknown",role:void 0};
}
function resolveRunningStatusText({sessionId,currentSessionId,running,session,kind,role}={}){
if(sessionId===void 0||sessionId===null||sessionId!==currentSessionId||running!==true)return null;
const markedChild=isPluginChildSession(session);
const normalizedRole=normalizeStatusRole(role);
const roleText=normalizedRole===void 0?null:STATUS_ROLE_LABELS[normalizedRole]+" running";
if(kind==="pending")return markedChild?roleText:null;
if(kind==="unknown")return markedChild?roleText:null;
if(kind==="child")return roleText;
if(kind==="root")return markedChild?null:"Orchestrator running";
if(kind!==void 0&&kind!==null)return null;
if(markedChild)return roleText;
return"Orchestrator running";
}
const NATIVE_SESSION_ATTRIBUTES=[
"data-session-id",
"data-conversation-session-id",
"data-conversation-session",
"data-session",
];
function nativeStatusSessionValues(node,boundary){
const values=[];
let current=node;
while(current!==null&&current!==void 0){
if(typeof current.getAttribute==="function"){
for(const name of NATIVE_SESSION_ATTRIBUTES){
const value=current.getAttribute(name);
if(typeof value==="string"&&value.length>0)values.push(value);
}
}
if(boundary!==void 0&&current===boundary)break;
current=current.parentNode;
}
return values;
}
function nativeStatusNodeMatchesSession(node,sessionId,boundary,requireEvidence){
if(sessionId===void 0||sessionId===null||String(sessionId).length===0)return false;
const values=nativeStatusSessionValues(node,boundary);
const expected=String(sessionId);
return(!requireEvidence||values.length>0)&&values.every((value)=>value===expected);
}
function nativeScopeExactSelection(scopes,sessionId){
return sessionId===void 0||sessionId===null
?[]
:scopes.filter((scope)=>nativeStatusScopeIds(scope).includes(String(sessionId)));
}
function selectNativeScopeCandidate(scopes,sessionId){
const exact=nativeScopeExactSelection(scopes,sessionId);
const tagged=scopes.filter((scope)=>nativeStatusScopeIds(scope).length>0);
const isVisible=(scope)=>typeof scope?.getClientRects==="function"&&scope.getClientRects().length>0;
if(exact.length===1)return exact[0];
if(exact.length>1){
const visible=exact.filter(isVisible);
return visible.length===1?visible[0]:void 0;
}
if(tagged.length>0)return void 0;
if(scopes.length===1)return scopes[0];
const visible=scopes.filter(isVisible);
return visible.length===1?visible[0]:void 0;
}
function findNativeConversationScope(root,sessionId,anchor){
const anchoredScope=anchor?.closest?.("[data-conversation-scroll]");
if(anchoredScope!==null&&anchoredScope!==void 0)return anchoredScope;
const scopes=collectNativeConversationScopes(root);
if(scopes.length===0){
return root;
}
return selectNativeScopeCandidate(scopes,sessionId);
}
const localClassTokenPatterns=new Map();
function hasLocalClassToken(className,localName){
if(typeof className!=="string")return false;
let patterns=localClassTokenPatterns.get(localName);
if(patterns===void 0){
patterns=[new RegExp("(?:^|_)"+localName+"$"),new RegExp("^_"+localName+"(?:_|$)")];
localClassTokenPatterns.set(localName,patterns);
}
return className.split(/\s+/).some((token)=>patterns[0].test(token)||patterns[1].test(token));
}
function isHiddenStatusCandidate(node){
if(node===null||node===void 0||typeof node?.getAttribute!=="function")return false;
if(node.getAttribute("aria-atomic")==="true")return true;
if(node.getAttribute("aria-hidden")==="true")return true;
const hidden=node.getAttribute("hidden");
if(hidden!==null&&hidden!==void 0)return true;
return hasLocalClassToken(node.getAttribute("class"),"visuallyHidden");
}
function singleNativeStatusTextNode(node){
const childNodes=Array.from(node?.childNodes??[]);
const textNodes=childNodes.filter((child)=>child?.nodeType===3);
const accessoryNodes=childNodes.filter((child)=>child?.nodeType!==3);
const hasOnlyAriaHiddenAccessories=accessoryNodes.every((child)=>
child?.nodeType===1&&typeof child?.getAttribute==="function"&&child.getAttribute("aria-hidden")==="true"
);
if(textNodes.length!==1||typeof textNodes[0].nodeValue!=="string"||textNodes[0].nodeValue.trim().length===0||!hasOnlyAriaHiddenAccessories)return void 0;
return textNodes[0];
}
function collectDescendantElements(node,out=[]){
for(const child of Array.from(node?.childNodes??[])){
if(child?.nodeType!==1)continue;
out.push(child);
collectDescendantElements(child,out);
}
return out;
}
function isSpanStatusLabelElement(element){
return typeof element?.tagName==="string"&&element.tagName.toLowerCase()==="span";
}
function sessionValuesOf(node){
const values=[];
if(typeof node?.getAttribute==="function"){
for(const name of NATIVE_SESSION_ATTRIBUTES){
const value=node.getAttribute(name);
if(typeof value==="string"&&value.length>0)values.push(value);
}
}
return values;
}
function nativeConversationEvidenceOwner(scope){
let content;
let current=scope;
while(current!==null&&current!==void 0){
if(typeof current.getAttribute==="function"&&current.getAttribute("data-conversation-content")!==null){
content=current;
break;
}
current=current.parentNode;
}
if(content===void 0)return void 0;
let node=content;
while(node!==null&&node!==void 0){
if(typeof node.getAttribute==="function"&&sessionValuesOf(node).length>0)return node;
node=node.parentNode;
}
return content;
}
function nativeStatusScopeIds(scope){
return[...sessionValuesOf(scope),...sessionValuesOf(nativeConversationEvidenceOwner(scope))];
}
function nativeStatusSessionBoundary(scope){
return nativeConversationEvidenceOwner(scope)??scope;
}
function isDecorativeNativeStatusNode(node){
if(node===null||node===void 0||typeof node?.getAttribute!=="function")return false;
if(node.getAttribute("aria-hidden")==="true")return true;
const hidden=node.getAttribute("hidden");
if(hidden!==null&&hidden!==void 0)return true;
const inert=node.getAttribute("inert");
if(inert!==null&&inert!==void 0)return true;
return hasLocalClassToken(node.getAttribute("class"),"visuallyHidden");
}
function collectVisibleStatusTextNodes(node,out=[],hidden=false){
const hiddenHere=hidden||isDecorativeNativeStatusNode(node);
for(const child of Array.from(node?.childNodes??[])){
if(child?.nodeType===3){
if(!hiddenHere&&typeof child.nodeValue==="string"&&child.nodeValue.trim().length>0)out.push(child);
continue;
}
if(child?.nodeType!==1)continue;
collectVisibleStatusTextNodes(child,out,hiddenHere);
}
return out;
}
function findNativeRunningRowParts(scope,sessionId,requireSessionEvidence=false,sessionBoundary=void 0){
if(scope==null)return void 0;
const rows=[];
if(scope?.matches?.("[data-chat-running]"))rows.push(scope);
for(const row of Array.from(scope?.querySelectorAll?.("[data-chat-running]")??[])){
if(!rows.includes(row))rows.push(row);
}
if(rows.length!==1)return void 0;
const row=rows[0];
if(!nativeStatusNodeMatchesSession(row,sessionId,sessionBoundary,requireSessionEvidence))return void 0;
const shimmers=collectDescendantElements(row).filter((element)=>element?.getAttribute?.("data-shimmer")==="true");
if(shimmers.length!==1)return void 0;
const visibleTexts=collectVisibleStatusTextNodes(shimmers[0]);
if(visibleTexts.length!==1)return void 0;
const visibleText=visibleTexts[0];
if(!nativeStatusNodeMatchesSession(visibleText,sessionId,sessionBoundary,requireSessionEvidence))return void 0;
const shimmerTextNodes=collectDescendantElements(row).filter((element)=>{
const value=element?.getAttribute?.("data-shimmer-text");
return value!==null&&value!==void 0;
});
if(shimmerTextNodes.some((node)=>!nativeStatusNodeMatchesSession(node,sessionId,sessionBoundary,requireSessionEvidence)))return void 0;
const announcementTexts=[];
for(const element of collectDescendantElements(row)){
if(element?.getAttribute?.("role")!=="status")continue;
if(element?.getAttribute?.("aria-live")!=="polite")continue;
if(element?.getAttribute?.("aria-atomic")!=="true")continue;
const textNode=singleNativeStatusTextNode(element);
if(textNode!==void 0)announcementTexts.push(textNode);
}
if(announcementTexts.some((node)=>!nativeStatusNodeMatchesSession(node,sessionId,sessionBoundary,requireSessionEvidence)))return void 0;
return{visibleText,shimmerTextNodes,announcementTexts};
}
function findNativeTurnProcessLabelTextNode(scope,sessionId,requireSessionEvidence=false,sessionBoundary=void 0){
if(scope==null)return void 0;
const matches=[];
for(const button of Array.from(scope?.querySelectorAll?.("button[data-turn-process]")??[])){
if(button?.getAttribute?.("data-turn-process")===null||button?.getAttribute?.("data-turn-process")===void 0)continue;
if(isHiddenStatusCandidate(button))continue;
for(const candidate of collectDescendantElements(button)){
if(!isSpanStatusLabelElement(candidate))continue;
if(!hasLocalClassToken(candidate?.getAttribute?.("class"),"label"))continue;
if(isHiddenStatusCandidate(candidate))continue;
const textNode=singleNativeStatusTextNode(candidate);
if(textNode===void 0)continue;
if((requireSessionEvidence||sessionBoundary!==void 0)
&&!nativeStatusNodeMatchesSession(textNode,sessionId,sessionBoundary,requireSessionEvidence))continue;
matches.push(textNode);
}
}
return matches.length===1?matches[0]:void 0;
}
function findNativeTurnStatusTextNode(scope,sessionId,requireSessionEvidence=false,sessionBoundary=void 0){
if(scope==null)return void 0;
const labelNode=findNativeTurnProcessLabelTextNode(scope,sessionId,requireSessionEvidence,sessionBoundary);
if(labelNode!==void 0)return labelNode;
const statuses=[];
if(scope?.matches?.('[role="status"]'))statuses.push(scope);
for(const status of Array.from(scope?.querySelectorAll?.('[role="status"]')??[])){
if(!statuses.includes(status))statuses.push(status);
}
let match;
for(const status of statuses){
if(status?.getAttribute?.("role")!=="status"||status?.getAttribute?.("aria-live")!=="polite")continue;
if(isHiddenStatusCandidate(status))continue;
if(!hasLocalClassToken(status?.getAttribute?.("class"),"turnStatus"))continue;
const textNode=singleNativeStatusTextNode(status);
if(textNode===void 0)continue;
if((requireSessionEvidence||sessionBoundary!==void 0)
&&!nativeStatusNodeMatchesSession(textNode,sessionId,sessionBoundary,requireSessionEvidence))continue;
if(match!==void 0)return void 0;
match=textNode;
}
return match;
}
function collectNativeConversationScopes(root){
const scopes=[];
if(root?.matches?.("[data-conversation-scroll]"))scopes.push(root);
for(const scope of Array.from(root?.querySelectorAll?.("[data-conversation-scroll]")??[])){
if(!scopes.includes(scope))scopes.push(scope);
}
return scopes;
}
function nativeScopeSessionId(scope){
const values=new Set(nativeStatusScopeIds(scope));
if(values.size!==1)return void 0;
for(const value of values)return value;
return void 0;
}
function nativeStatusNodeSessionId(node){
const values=new Set(nativeStatusSessionValues(node,void 0));
if(values.size!==1)return void 0;
for(const value of values)return value;
return void 0;
}
function collectNativeStatusSessionIds(root){
const ids=new Set();
const scopes=collectNativeConversationScopes(root);
if(scopes.length>0){
for(const scope of scopes){
const sessionId=nativeScopeSessionId(scope);
if(sessionId!==void 0)ids.add(sessionId);
}
return ids;
}
const statuses=[];
if(root?.matches?.('[role="status"]'))statuses.push(root);
for(const status of Array.from(root?.querySelectorAll?.('[role="status"]')??[])){
if(!statuses.includes(status))statuses.push(status);
}
for(const status of statuses){
if(status?.getAttribute?.("aria-live")!=="polite")continue;
const sessionId=nativeStatusNodeSessionId(status);
if(sessionId!==void 0)ids.add(sessionId);
}
for(const button of Array.from(root?.querySelectorAll?.("button[data-turn-process]")??[])){
const sessionId=nativeStatusNodeSessionId(button);
if(sessionId!==void 0)ids.add(sessionId);
}
return ids;
}
function resolveNativeStatusScopeTargets(scope,sessionId){
const requireSessionEvidence=nativeStatusScopeIds(scope).includes(String(sessionId));
const sessionBoundary=nativeStatusSessionBoundary(scope);
const parts=findNativeRunningRowParts(scope,sessionId,requireSessionEvidence,sessionBoundary);
if(parts!==void 0){
return{
visibleText:parts.visibleText,
shimmerAttributes:parts.shimmerTextNodes,
announcements:parts.announcementTexts,
};
}
const textNode=findNativeTurnStatusTextNode(scope,sessionId,requireSessionEvidence,sessionBoundary);
return textNode===void 0?void 0:{visibleText:textNode,shimmerAttributes:[],announcements:[]};
}
function resolveNativeStatusTargets(root,sessionId,includeSameSessionScopes=false){
const scopes=collectNativeConversationScopes(root);
if(scopes.length===0){
const textNode=findNativeTurnStatusTextNode(root,sessionId,true);
return textNode===void 0?void 0:{visibleText:textNode,shimmerAttributes:[],announcements:[]};
}
const exact=nativeScopeExactSelection(scopes,sessionId);
if(includeSameSessionScopes&&exact.length>1){
const resolved=exact
.filter((scope)=>nativeScopeSessionId(scope)===String(sessionId))
.map((scope)=>resolveNativeStatusScopeTargets(scope,sessionId))
.filter((targets)=>targets!==void 0);
if(resolved.length===0)return void 0;
return{
visibleTexts:resolved.map((targets)=>targets.visibleText).filter((node)=>node!=null),
shimmerAttributes:resolved.flatMap((targets)=>targets.shimmerAttributes),
announcements:resolved.flatMap((targets)=>targets.announcements),
};
}
const candidate=selectNativeScopeCandidate(scopes,sessionId);
if(candidate===void 0)return void 0;
return resolveNativeStatusScopeTargets(candidate,sessionId);
}
function findNativeStatusTextNode(root,sessionId){
return resolveNativeStatusTargets(root,sessionId)?.visibleText;
}
const NATIVE_RUNNING_STATUS_PREFIXES=Object.freeze([
"深度求索中",
"Deep diving",
"Deep thinking",
"Thinking",
]);
const NATIVE_RUNNING_STATUS_PREFIX=NATIVE_RUNNING_STATUS_PREFIXES[0];
function replaceNativeStatusPrefix(currentText,replacementText){
if(typeof currentText!=="string"||currentText.length===0)return null;
if(typeof replacementText!=="string"||replacementText.length===0)return null;
let match=null;
for(const prefix of NATIVE_RUNNING_STATUS_PREFIXES){
const at=currentText.indexOf(prefix);
if(at===-1)continue;
if(match===null||at<match.at||(at===match.at&&prefix.length>match.prefix.length)){
match={at,prefix};
}
}
if(match===null)return null;
return currentText.slice(0,match.at)+replacementText+currentText.slice(match.at+match.prefix.length);
}
function createNativeTextRewriter(options={}){
const findNode=typeof options.findNode==="function"?options.findNode:()=>void 0;
const getText=typeof options.getText==="function"?options.getText:(node)=>node?.nodeValue;
const setText=typeof options.setText==="function"?options.setText:(node,value)=>{node.nodeValue=value;};
const isConnected=typeof options.isConnected==="function"?options.isConnected:(node)=>node?.isConnected!==false;
const decorate=typeof options.decorate==="function"?options.decorate:()=>{};
const undecorate=typeof options.undecorate==="function"?options.undecorate:()=>{};
let activeNode;
let originalText;
let rewrittenText;
function restore(){
if(activeNode!==void 0&&isConnected(activeNode)&&getText(activeNode)===rewrittenText){
setText(activeNode,originalText);
}
activeNode=void 0;
originalText=void 0;
rewrittenText=void 0;
undecorate();
}
function apply(text){
if(typeof text!=="string"||text.length===0){
restore();
return;
}
const candidate=findNode();
if(candidate===null||candidate===void 0){
restore();
return;
}
const currentText=getText(candidate);
if(activeNode!==candidate){
restore();
activeNode=candidate;
originalText=currentText;
}else if(currentText!==rewrittenText){
originalText=currentText;
}
const next=replaceNativeStatusPrefix(originalText,text);
rewrittenText=next===null?currentText:next;
if(next!==null&&currentText!==next)setText(activeNode,next);
decorate(activeNode);
}
return{apply,restore};
}
function nativeStatusFieldDescriptors(targets){
const fields=[];
if(targets?.visibleText!=null)fields.push({node:targets.visibleText,attribute:void 0});
for(const node of targets?.visibleTexts??[]){
if(node!=null)fields.push({node,attribute:void 0});
}
for(const node of targets?.shimmerAttributes??[]){
if(node!=null)fields.push({node,attribute:"data-shimmer-text"});
}
for(const node of targets?.announcements??[]){
if(node!=null)fields.push({node,attribute:void 0});
}
return fields.filter((field,index)=>fields.findIndex(
(other)=>other.node===field.node&&other.attribute===field.attribute,
)===index);
}
function createNativeStatusRowRewriter(options={}){
const resolveTargets=typeof options.resolveTargets==="function"?options.resolveTargets:()=>void 0;
let entries=[];
const createFieldRewriter=(node,attribute)=>{
const read=()=>(attribute===void 0?node?.nodeValue:node?.getAttribute?.(attribute));
const write=(value)=>{
if(attribute===void 0){
node.nodeValue=value;
return;
}
node?.setAttribute?.(attribute,value);
};
return createNativeTextRewriter({
findNode:()=>node,
getText:()=>read(),
setText:(_candidate,value)=>write(value),
isConnected:()=>node?.isConnected!==false,
});
};
const restoreEntries=(list)=>{
for(const entry of list)entry.rewriter.restore();
};
function restore(){
restoreEntries(entries);
entries=[];
}
function apply(text){
const targets=typeof text==="string"&&text.length>0?resolveTargets():void 0;
const fields=targets===void 0?[]:nativeStatusFieldDescriptors(targets);
if(fields.length===0){
restore();
return;
}
const next=[];
for(const field of fields){
let entry=entries.find((candidate)=>candidate.node===field.node&&candidate.attribute===field.attribute);
if(entry===void 0){
entry={node:field.node,attribute:field.attribute,rewriter:createFieldRewriter(field.node,field.attribute)};
}
entry.rewriter.apply(text);
next.push(entry);
}
restoreEntries(entries.filter((entry)=>!next.includes(entry)));
entries=next;
}
return{apply,restore};
}
global[SYMBOL]=Object.freeze({
NATIVE_RUNNING_STATUS_PREFIX,NATIVE_RUNNING_STATUS_PREFIXES,STATUS_ROLE_IDS,STATUS_ROLE_LABELS,STATUS_ROLE_MARKER,
collectNativeStatusSessionIds,createNativeStatusRowRewriter,createNativeTextRewriter,findNativeConversationScope,findNativeStatusTextNode,
isPluginChildSession,normalizeStatusRole,replaceNativeStatusPrefix,resolveNativeStatusTargets,resolveRunningStatusText,
resolveStatusIdentity,
});
})(globalThis);
/* source: client-settings-normalize.js */
(function installClientSettingsNormalize(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-settings-normalize");
const clientNativeStatusSymbol=Symbol.for("dsh-expert-group/client-native-status");
const clientNativeStatus=global[clientNativeStatusSymbol]||{};
const{
STATUS_ROLE_IDS,STATUS_ROLE_LABELS,
}=clientNativeStatus;
let react=null;
let requireFreshnessSurface=null;
let requestPluginRpc=null;
let createClientFreshnessBoundary=null;
let RPC_TARGET=null;
function bindClientRuntime(host){
react=host.react??null;
requireFreshnessSurface=host.requireFreshnessSurface??null;
requestPluginRpc=host.requestPluginRpc??null;
createClientFreshnessBoundary=host.createClientFreshnessBoundary??null;
RPC_TARGET=host.RPC_TARGET??null;
}
const SETTINGS_ROLE_IDS=STATUS_ROLE_IDS;
const SETTINGS_ROLE_LABELS=STATUS_ROLE_LABELS;
const ORCHESTRATOR_ID="orchestrator";
const SETTINGS_REQUIRED_ROLE_IDS=SETTINGS_ROLE_IDS.filter((role)=>role!=="observer");
const PROMPT_ROLE_IDS=SETTINGS_ROLE_IDS;
const DEFAULT_PROMPT_MAX_GRAPHEMES=32000;
const PROMPT_WARNING_RATIO=0.9;
const GRAPHEME_SEGMENTER_CACHE=new Map();
function graphemeSegmenterOf(locale,granularity){
const key=(locale===undefined?"":String(locale))+"\u0000"+String(granularity);
const cached=GRAPHEME_SEGMENTER_CACHE.get(key);
if(cached!==undefined)return cached;
try{
const Segmenter=globalThis?.Intl?.Segmenter;
if(typeof Segmenter!=="function")return null;
const segmenter=new Segmenter(locale,{granularity});
GRAPHEME_SEGMENTER_CACHE.set(key,segmenter);
return segmenter;
}catch{
return null;
}
}
function countUnicodeGraphemes(value){
if(typeof value!=="string"||value.length===0)return 0;
const segmenter=graphemeSegmenterOf(undefined,"grapheme");
if(segmenter!==null){
try{
let count=0;
for(const unused of segmenter.segment(value)){
void unused;
count+=1;
}
return count;
}catch{
}
}
return Array.from(value).length;
}
function validatePromptText(value,maxGraphemes=DEFAULT_PROMPT_MAX_GRAPHEMES){
const text=typeof value==="string"?value:"";
const max=Number.isSafeInteger(maxGraphemes)&&maxGraphemes>0
?maxGraphemes
:DEFAULT_PROMPT_MAX_GRAPHEMES;
const count=countUnicodeGraphemes(text);
if(text.trim().length===0){
return{ok:false,code:"prompt-empty",message:"提示词不能为空",count,maxGraphemes:max};
}
if(count>max){
return{ok:false,code:"prompt-too-long",message:"提示词不能超过 "+max+" 个字符",count,maxGraphemes:max};
}
return{ok:true,code:null,message:null,count,maxGraphemes:max};
}
function normalizePromptOverrides(value,maxGraphemes=DEFAULT_PROMPT_MAX_GRAPHEMES,roleIds=PROMPT_ROLE_IDS){
if(value===null||typeof value!=="object"||Array.isArray(value))return{};
const normalized={};
const roles=Array.isArray(roleIds)&&roleIds.length>0?roleIds:PROMPT_ROLE_IDS;
for(const role of roles){
const text=value[role];
if(typeof text!=="string")continue;
if(!validatePromptText(text,maxGraphemes).ok)continue;
normalized[role]=text;
}
return normalized;
}
function promptOverridesEqual(left,right){
const leftValue=left&&typeof left==="object"?left:{};
const rightValue=right&&typeof right==="object"?right:{};
const roles=[...new Set([...Object.keys(leftValue),...Object.keys(rightValue)])].sort();
return roles.every((role)=>leftValue[role]===rightValue[role]);
}
function normalizeRolePromptProjection(projection,settingsValue,snapshotOverridesAuthoritative=false,roleIds=PROMPT_ROLE_IDS){
if(projection===null||typeof projection!=="object"||Array.isArray(projection)
||!Array.isArray(projection.entries))return null;
const roles=Array.isArray(roleIds)&&roleIds.length>0?roleIds:PROMPT_ROLE_IDS;
const fallbackOverrides=normalizePromptOverrides(settingsValue?.promptOverrides,projection.maxGraphemes,roles);
const settingsHasOverrides=settingsValue!==null&&typeof settingsValue==="object"
&&Object.prototype.hasOwnProperty.call(settingsValue,"promptOverrides");
const byRole=new Map(projection.entries
.filter((entry)=>entry&&typeof entry.role==="string")
.map((entry)=>[entry.role,entry]));
const entries=[];
for(const role of roles){
const source=byRole.get(role);
if(typeof source?.defaultPersona!=="string")return null;
const snapshotControlsOverride=snapshotOverridesAuthoritative&&settingsHasOverrides;
const settingsHasRoleOverride=snapshotControlsOverride&&Object.prototype.hasOwnProperty.call(fallbackOverrides,role);
const override=snapshotControlsOverride
?fallbackOverrides[role]
:(typeof source.override==="string"?source.override:fallbackOverrides[role]);
const customized=snapshotControlsOverride
?settingsHasRoleOverride
:source.customized===true;
entries.push({
role,
defaultPersona:source.defaultPersona,
...(customized&&typeof override==="string"?{override}:{}),
customized,
effective:customized&&typeof override==="string"?override:source.defaultPersona,
});
}
const maxGraphemes=Number.isSafeInteger(projection.maxGraphemes)&&projection.maxGraphemes>0
?projection.maxGraphemes
:DEFAULT_PROMPT_MAX_GRAPHEMES;
return{
roles,
maxGraphemes,
customizable:projection.customizable===true,
entries,
};
}
function promptEntryOf(projection,role){
return projection?.entries?.find((entry)=>entry.role===role)??null;
}
function updateRolePromptProjection(projection,role,text){
if(projection===null||typeof projection!=="object")return projection;
return{
...projection,
entries:projection.entries.map((entry)=>{
if(entry.role!==role)return entry;
const customized=text!==entry.defaultPersona;
const next={...entry,customized,effective:text};
if(customized)next.override=text;
else delete next.override;
return next;
}),
};
}
function settingsRolesForProvider(roles){
const candidates=Array.isArray(roles)?roles:SETTINGS_REQUIRED_ROLE_IDS;
return[...new Set(candidates.filter((role)=>typeof role==="string"&&role.length>0))];
}
function unifiedProviderOf(defaults,roles,legacyProvider=""){
const activeRoles=settingsRolesForProvider(roles);
if(activeRoles.length===0)return"";
const providers=activeRoles.map((role)=>{
const provider=defaults?.[role]?.provider;
return typeof provider==="string"&&provider.length>0?provider:"";
});
const configured=providers.filter((provider)=>provider.length>0);
if(configured.length===0)return typeof legacyProvider==="string"?legacyProvider:"";
if(configured.length!==activeRoles.length)return"";
const first=configured[0];
return configured.every((provider)=>provider===first)?first:"";
}
const NOTIFICATION_EVENT_TYPES=Object.freeze(["completed","waiting","failed"]);
function normalizeNotificationEvents(value){
const source=value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
const normalized={};
for(const type of NOTIFICATION_EVENT_TYPES)normalized[type]=source[type]!==false;
return normalized;
}
function clampNotificationVolume(value){
const number=Number(value);
return Number.isFinite(number)?Math.min(100,Math.max(0,Math.round(number))):100;
}
const DEFAULT_ROLE_CONCURRENCY_LIMIT=20;
const LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT=10;
const CONFIG_MIGRATION_VERSION=1;
function normalizeRoleConcurrencyLimit(value){
return Number.isSafeInteger(value)&&value>=1&&value<=64
?value
:DEFAULT_ROLE_CONCURRENCY_LIMIT;
}
function effectiveRoleConcurrencyLimit(source){
const limit=normalizeRoleConcurrencyLimit(source?.roleConcurrencyLimit);
const rawVersion=source?.configMigrationVersion;
const version=Number.isSafeInteger(rawVersion)&&rawVersion>=0?rawVersion:0;
return version<CONFIG_MIGRATION_VERSION&&limit===LEGACY_DEFAULT_ROLE_CONCURRENCY_LIMIT
?DEFAULT_ROLE_CONCURRENCY_LIMIT
:limit;
}
const DEFAULT_ROLE_TIMEOUT_MS=36000000;
function normalizeRoleTimeoutMs(value){
if(value===0)return 0;
return Number.isSafeInteger(value)&&value>=1000&&value<=86400000&&value%1000===0
?value
:DEFAULT_ROLE_TIMEOUT_MS;
}
const MAX_MODEL_CANDIDATES_PER_ROLE=3;
const MAX_MODEL_FALLBACK_LIMIT=4;
const DEFAULT_MODEL_FALLBACK_LIMIT=2;
const MAX_MODEL_PAGES=MAX_MODEL_CANDIDATES_PER_ROLE+1;
function normalizeModelFallbackLimitDraft(value){
return Number.isSafeInteger(value)&&value>=0&&value<=MAX_MODEL_FALLBACK_LIMIT?value:DEFAULT_MODEL_FALLBACK_LIMIT;
}
function normalizeModelCandidateSelection(entry){
if(entry===null||typeof entry!=="object"||Array.isArray(entry))return null;
if(typeof entry.provider!=="string"||typeof entry.model!=="string")return null;
const reasoningEffort=typeof entry.reasoningEffort==="string"?entry.reasoningEffort:"";
return{provider:entry.provider,model:entry.model,...(reasoningEffort.length>0?{reasoningEffort}:{})};
}
function normalizeOrchestratorDraft(value){
const source=value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
const defaults=normalizeModelCandidateSelection(source.defaults);
return{
defaults:defaults!==null&&defaults.provider.length>0&&defaults.model.length>0?defaults:null,
candidates:(Array.isArray(source.candidates)?source.candidates:[])
.slice(0,MAX_MODEL_CANDIDATES_PER_ROLE)
.map(normalizeModelCandidateSelection)
.filter((entry)=>entry!==null),
fallbackLimit:normalizeModelFallbackLimitDraft(source.fallbackLimit),
};
}
function compactOrchestratorDraft(value){
const profile=normalizeOrchestratorDraft(value);
return{
...profile,
candidates:compactModelCandidatesDraft({[ORCHESTRATOR_ID]:profile.candidates})[ORCHESTRATOR_ID]??[],
};
}
function normalizeModelCandidatesDraft(value){
const source=value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
const candidates={};
for(const[role,list]of Object.entries(source)){
if(typeof role!=="string"||role.length===0||!Array.isArray(list))continue;
if(!SETTINGS_ROLE_IDS.includes(role))continue;
const normalized=[];
for(const entry of list.slice(0,MAX_MODEL_CANDIDATES_PER_ROLE)){
const selection=normalizeModelCandidateSelection(entry);
if(selection!==null)normalized.push(selection);
}
if(normalized.length>0)candidates[role]=normalized;
}
return candidates;
}
function modelCandidateKeyOf(selection){
return(selection?.provider??"")+"\u0000"+(selection?.model??"")+"\u0000"+(typeof selection?.reasoningEffort==="string"?selection.reasoningEffort:"");
}
function modelPageCountOf(draft){
const orchestratorCandidates=draft?.orchestrator?.candidates;
let longest=Array.isArray(orchestratorCandidates)?orchestratorCandidates.length:0;
for(const role of SETTINGS_ROLE_IDS){
const list=draft?.candidates?.[role];
if(Array.isArray(list))longest=Math.max(longest,list.length);
}
return Math.min(MAX_MODEL_PAGES,Math.max(1,1+longest));
}
function modelLayerRolesOf(draft){
const roles=[...SETTINGS_ROLE_IDS];
for(const source of[draft?.defaults,draft?.candidates]){
if(source===null||source===void 0||typeof source!=="object")continue;
for(const role of Object.keys(source))if(!roles.includes(role))roles.push(role);
}
return roles;
}
function modelLayerRowKeysOf(draft){
return[...modelLayerRolesOf(draft),ORCHESTRATOR_ID];
}
function modelLayerSelectionOf(draft,role,page){
if(!Number.isSafeInteger(page)||page<0)return null;
let source;
if(role===ORCHESTRATOR_ID){
const profile=draft?.orchestrator;
source=page===0
?profile?.defaults
:(Array.isArray(profile?.candidates)?profile.candidates[page-1]:void 0);
}else{
source=page===0
?draft?.defaults?.[role]
:(Array.isArray(draft?.candidates?.[role])?draft.candidates[role][page-1]:void 0);
}
return source!==null&&source!==void 0&&typeof source==="object"&&!Array.isArray(source)?source:null;
}
function setModelLayerSelection(draft,role,page,selection){
if(!Number.isSafeInteger(page)||page<0)return draft;
const normalized=selection!==null&&typeof selection==="object"&&!Array.isArray(selection)?selection:null;
if(role===ORCHESTRATOR_ID){
const profile=normalizeOrchestratorDraft(draft?.orchestrator);
if(page===0)return{...draft,orchestrator:{...profile,defaults:normalized}};
const list=profile.candidates.slice();
while(list.length<page-1)list.push({provider:"",model:""});
list[page-1]=normalized===null?{provider:"",model:""}:normalized;
return{...draft,orchestrator:{...profile,candidates:list}};
}
if(page===0){
const defaults={...(draft?.defaults??{})};
if(normalized===null)delete defaults[role];
else defaults[role]=normalized;
return{...draft,defaults};
}
const candidates={...(draft?.candidates??{})};
const list=Array.isArray(candidates[role])?candidates[role].slice():[];
while(list.length<page-1)list.push({provider:"",model:""});
list[page-1]=normalized===null?{provider:"",model:""}:normalized;
candidates[role]=list;
return{...draft,candidates};
}
function modelLayerMapOf(draft,page){
const map={};
for(const role of modelLayerRowKeysOf(draft)){
const selection=modelLayerSelectionOf(draft,role,page);
if(selection!==null)map[role]=selection;
}
return map;
}
function writeModelLayers(draft,layers){
let next={...draft,defaults:{},candidates:{}};
for(const role of modelLayerRowKeysOf(draft)){
for(let page=0;page<layers.length;page+=1){
const selection=layers[page]?.[role];
if(selection!==null&&selection!==void 0){
next=setModelLayerSelection(next,role,page,{...selection});
}
}
}
return next;
}
function reorderModelLayers(draft,from,to){
const count=modelPageCountOf(draft);
if(!Number.isSafeInteger(from)||!Number.isSafeInteger(to))return draft;
if(from<0||from>=count||to<0||to>=count||from===to)return draft;
const layers=[];
for(let page=0;page<count;page+=1)layers.push(modelLayerMapOf(draft,page));
const[moved]=layers.splice(from,1);
layers.splice(to,0,moved);
return writeModelLayers(draft,layers);
}
function addModelCandidatePage(draft){
const count=modelPageCountOf(draft);
if(count>=MAX_MODEL_PAGES)return draft;
let next=draft;
for(const role of modelLayerRowKeysOf(draft)){
const primary=modelLayerSelectionOf(draft,role,0);
next=setModelLayerSelection(next,role,count,primary===null?null:{...primary});
}
return next;
}
function removeModelCandidatePage(draft,page){
if(!Number.isSafeInteger(page)||page<1)return draft;
const candidates={...(draft?.candidates??{})};
for(const[role,value]of Object.entries(candidates)){
if(!Array.isArray(value))continue;
const list=value.slice();
if(list.length>=page)list.splice(page-1,1);
if(list.length>0)candidates[role]=list;
else delete candidates[role];
}
const profile=draft?.orchestrator;
if(profile===null||typeof profile!=="object")return{...draft,candidates};
const orchestratorList=Array.isArray(profile.candidates)?profile.candidates.slice():[];
if(orchestratorList.length>=page)orchestratorList.splice(page-1,1);
return{...draft,candidates,orchestrator:{...profile,candidates:orchestratorList}};
}
function compactModelCandidatesDraft(candidates){
const source=candidates!==null&&typeof candidates==="object"&&!Array.isArray(candidates)?candidates:{};
const compacted={};
for(const[role,list]of Object.entries(source)){
if(!Array.isArray(list))continue;
const rows=[];
for(const entry of list){
const selection=normalizeModelCandidateSelection(entry);
if(selection===null)continue;
if(selection.provider.length===0&&selection.model.length===0)continue;
rows.push(selection);
}
if(rows.length>0)compacted[role]=rows;
}
return compacted;
}
function validateModelCandidateRows(candidates){
const source=candidates!==null&&typeof candidates==="object"?candidates:{};
for(const[role,list]of Object.entries(source)){
if(!Array.isArray(list))continue;
if(list.length>MAX_MODEL_CANDIDATES_PER_ROLE)return{ok:false,code:"limit",role,index:0};
const seen=new Set();
for(let index=0;index<list.length;index+=1){
const selection=normalizeModelCandidateSelection(list[index]);
if(selection===null)return{ok:false,code:"incomplete",role,index:index+1};
if(selection.provider.length===0&&selection.model.length===0)continue;
if(selection.provider.length===0||selection.model.length===0)return{ok:false,code:"incomplete",role,index:index+1};
const key=modelCandidateKeyOf(selection);
if(seen.has(key))return{ok:false,code:"duplicate",role,index:index+1};
seen.add(key);
}
}
return{ok:true,code:null,role:null,index:0};
}
function modelCandidatesErrorMessage(t,roleLabelOf,validation){
if(validation.code==="limit")return t("settings.modelCandidates.limit");
return(typeof roleLabelOf==="function"?roleLabelOf(validation.role):validation.role)+"："+t("settings.modelCandidates.error."+(validation.code??"incomplete"),{index:validation.index});
}
const DEFAULT_PEAK_VALLEY_PERIODS=Object.freeze([
Object.freeze({start:"08:00",end:"12:00"}),
Object.freeze({start:"14:00",end:"18:00"}),
]);
const NEXT_PEAK_VALLEY_PERIOD=Object.freeze({start:"19:00",end:"22:00"});
function normalizePeakValleyDraft(value,seedPeriods=false){
const source=value!==null&&typeof value==="object"&&!Array.isArray(value)?value:{};
const invalidCode=typeof source.invalidCode==="string"&&source.invalidCode.length>0
?source.invalidCode
:void 0;
const periods=Array.isArray(source.periods)?source.periods:[];
const seedDefaults=seedPeriods===true
&&invalidCode===void 0
&&source.enabled!==true
&&periods.length===0;
return JSON.parse(JSON.stringify({
enabled:source.enabled===true,
initialized:source.initialized===true,
periods:seedDefaults?DEFAULT_PEAK_VALLEY_PERIODS:periods,
peak:source.peak!==null&&typeof source.peak==="object"?source.peak:{},
valley:source.valley!==null&&typeof source.valley==="object"?source.valley:{},
...(invalidCode===void 0?{}:{invalidCode}),
}));
}
function normalizeSettingsDraft(value,roles,allowLegacyProviderFallback=true,seedPeakValleyPeriods=false){
const source=value&&typeof value==="object"?value:{};
const configuredProvider=typeof source.provider==="string"?source.provider:"";
const activeRoles=settingsRolesForProvider(roles);
const entries=[];
for(const[role,selection]of Object.entries(source.defaults??{})){
if(!selection||typeof selection!=="object"
||typeof selection.model!=="string"||selection.model.length===0)continue;
const provider=typeof selection.provider==="string"&&selection.provider.length>0
?selection.provider
:"";
entries.push({role,selection,provider});
}
const hasVisibleRowProvider=entries.some(({role,provider})=>activeRoles.includes(role)&&provider.length>0);
const defaults={};
for(const{role,selection,provider:explicitProvider}of entries){
const provider=explicitProvider.length>0
?explicitProvider
:(allowLegacyProviderFallback&&!hasVisibleRowProvider&&activeRoles.includes(role)
?configuredProvider
:"");
if(provider.length===0)continue;
defaults[role]={provider,model:selection.model};
if(typeof selection.reasoningEffort==="string")defaults[role].reasoningEffort=selection.reasoningEffort;
}
const visibleProviders=activeRoles
.map((role)=>defaults[role]?.provider)
.filter((provider)=>typeof provider==="string"&&provider.length>0);
const inferredProvider=visibleProviders.length>0
&&visibleProviders.length===activeRoles.length
&&visibleProviders.every((provider)=>provider===visibleProviders[0])
?visibleProviders[0]
:"";
return{
provider:hasVisibleRowProvider
?inferredProvider
:(allowLegacyProviderFallback?configuredProvider:""),
defaults,
notificationEnabled:source.notificationEnabled!==false,
notificationVolume:clampNotificationVolume(source.notificationVolume),
notificationEvents:normalizeNotificationEvents(source.notificationEvents),
roleConcurrencyLimit:effectiveRoleConcurrencyLimit(source),
roleTimeoutMs:normalizeRoleTimeoutMs(source.roleTimeoutMs),
observerPreferred:source.observerPreferred===true,
taskManagementEnabled:source.taskManagementEnabled!==false,
autoOpenSubagentSidebar:source.autoOpenSubagentSidebar===true,
sidebarEntryEnabled:source.sidebarEntryEnabled!==false,
...(Object.prototype.hasOwnProperty.call(source,"candidates")
?{candidates:normalizeModelCandidatesDraft(source.candidates)}
:{}),
...(Object.prototype.hasOwnProperty.call(source,"fallbackLimit")
?{fallbackLimit:normalizeModelFallbackLimitDraft(source.fallbackLimit)}
:{}),
orchestrator:normalizeOrchestratorDraft(source.orchestrator),
...(Object.prototype.hasOwnProperty.call(source,"peakValley")
?{peakValley:normalizePeakValleyDraft(source.peakValley,seedPeakValleyPeriods)}
:{}),
};
}
function settingsDraftEqual(left,right){
return JSON.stringify(left)===JSON.stringify(right);
}
const SETTINGS_DRAFT_MERGE_FIELDS=Object.freeze([
"provider",
"defaults",
"notificationEnabled",
"notificationVolume",
"notificationEvents",
"roleConcurrencyLimit",
"roleTimeoutMs",
"observerPreferred",
"taskManagementEnabled",
"autoOpenSubagentSidebar",
"sidebarEntryEnabled",
"candidates",
"fallbackLimit",
"orchestrator",
"peakValley",
]);
function mergeSettingsDraftOverSource(source,local,baseline){
const merged={...source};
for(const field of SETTINGS_DRAFT_MERGE_FIELDS){
const hasLocal=Object.prototype.hasOwnProperty.call(local,field);
const hasBaseline=Object.prototype.hasOwnProperty.call(baseline,field);
if(hasLocal!==hasBaseline){
if(hasLocal)merged[field]=local[field];
else delete merged[field];
continue;
}
if(!hasLocal)continue;
if(settingsDraftEqual(local[field],baseline[field]))continue;
merged[field]=local[field];
}
return merged;
}
function resolveSettingsForm(configForms,entryId,unavailableSnapshot){
const fallback={
getSnapshot:()=>unavailableSnapshot,
subscribe:()=>()=>{},
};
if(configForms===null||typeof configForms.get!=="function")return fallback;
try{
const form=configForms.get(entryId);
if(form!==null&&form!==undefined
&&typeof form.getSnapshot==="function"&&typeof form.subscribe==="function")return form;
}catch{/* 服务代理拒答或条目读取失败：按不可用降级。 */}
return fallback;
}
function createSettingsModelCatalog(ctx){
let state={groups:[],status:"idle",error:null};
let inflight=null;
let queued=false;
let disposed=false;
const freshness=createClientFreshnessBoundary();
const listeners=new Set();
const publish=(next)=>{
state=next;
for(const listener of listeners)listener();
};
const startRequest=()=>{
if(disposed)return Promise.resolve();
const requestToken=freshness.beginRequest("catalog","settings");
publish({...state,status:"loading",error:null});
const promise=Promise.resolve().then(()=>ctx.remote.session.modelCatalog()).then((response)=>{
const catalog=response?.ok===true?response.value:response;
if(!catalog||!Array.isArray(catalog.groups))throw new Error("模型目录不可用");
const normalizedGroups=normalizeSettingsModelGroups(catalog.groups);
const accepted=freshness.acceptCatalogResponse({
generation:requestToken.sequence,
groups:normalizedGroups,
requestToken,
});
if(accepted.accepted)publish({groups:normalizedGroups,status:"ready",error:null});
}).catch((cause)=>{
if(freshness.isCurrent(requestToken)){
publish({...state,status:"error",error:cause instanceof Error?cause.message:String(cause)});
}
}).finally(()=>{
if(inflight!==promise)return;
inflight=null;
if(!queued)return;
queued=false;
startRequest();
});
inflight=promise;
return promise;
};
const load=()=>{
if(disposed)return Promise.resolve();
if(inflight!==null)return inflight;
return startRequest();
};
const refresh=(clear)=>{
if(disposed)return;
if(clear){
inflight=null;
queued=false;
publish({groups:[],status:"idle",error:null});
startRequest();
return;
}
if(inflight!==null){
if(!queued)freshness.beginRequest("catalog","settings");
queued=true;
return;
}
startRequest();
};
const subscribe=(listener)=>{
listeners.add(listener);
return()=>listeners.delete(listener);
};
const getSnapshot=()=>state;
const eventStops=[];
for(const event of["llm/adapters-updated","settings/document-updated","credentials/reference-updated"]){
eventStops.push(ctx.remote.$on(event,()=>refresh(false)));
}
ctx.on("connection/reset",()=>refresh(true));
ctx.effect(()=>()=>{
disposed=true;
inflight=null;
queued=false;
for(const stop of eventStops)if(typeof stop==="function")stop();
freshness.dispose();
},"dsh-expert-group: settings catalog events");
return{load,subscribe,getSnapshot};
}
function normalizeSettingsModelGroups(groups){
return(Array.isArray(groups)?groups:[]).flatMap((group)=>{
if(!group||typeof group.id!=="string"||group.id.length===0)return[];
const models=(Array.isArray(group.models)?group.models:[])
.filter((model)=>model&&typeof model==="object"&&typeof model.id==="string"&&model.id.length>0)
.map((model)=>{
const normalized={
...model,
name:typeof model.name==="string"&&model.name.trim().length>0?model.name:model.id,
};
const reasoning=model.reasoning;
if(!reasoning||typeof reasoning!=="object"||Array.isArray(reasoning)){
delete normalized.reasoning;
return normalized;
}
const efforts=(Array.isArray(reasoning.efforts)?reasoning.efforts:[])
.flatMap((effort)=>{
if(!effort||typeof effort!=="object"||typeof effort.id!=="string"||effort.id.length===0)return[];
return[{
...effort,
name:typeof effort.name==="string"&&effort.name.trim().length>0?effort.name:effort.id,
}];
});
const defaultEffort=typeof reasoning.defaultEffort==="string"
&&reasoning.defaultEffort.trim().length>0
&&efforts.some((effort)=>effort.id===reasoning.defaultEffort)
?reasoning.defaultEffort
:void 0;
normalized.reasoning={
efforts,
...(defaultEffort===void 0?{}:{defaultEffort}),
};
return normalized;
});
return[{
...group,
name:typeof group.name==="string"&&group.name.trim().length>0?group.name:group.id,
models,
}];
});
}
function modelDisplayNameOf(model){
if(!model||typeof model!=="object")return"";
if(typeof model.name==="string"&&model.name.trim().length>0)return model.name;
return typeof model.id==="string"&&model.id.length>0?model.id:"";
}
function migrateSettingsSelection(selection,provider,groups){
if(typeof provider!=="string"||provider.length===0)return null;
const providerGroups=Array.isArray(groups)?groups:[];
const providerGroup=providerGroups.find((group)=>group?.id===provider);
if(!providerGroup)return null;
if(!selection||typeof selection!=="object"
||typeof selection.model!=="string"||selection.model.length===0)return null;
const sourceGroup=typeof selection.provider==="string"&&selection.provider.length>0
?providerGroups.find((group)=>group?.id===selection.provider)
:void 0;
const sourceModel=Array.isArray(sourceGroup?.models)
?sourceGroup.models.find((candidate)=>candidate?.id===selection.model)
:void 0;
const sourceDisplayName=modelDisplayNameOf(sourceModel);
if(sourceDisplayName.length===0)return null;
const model=Array.isArray(providerGroup.models)
?providerGroup.models.find((candidate)=>modelDisplayNameOf(candidate)===sourceDisplayName)
:void 0;
if(!model)return null;
const next={provider:providerGroup.id,model:model.id};
const reasoning=model.reasoning;
if(typeof selection.reasoningEffort==="string"
&&Array.isArray(reasoning?.efforts)
&&reasoning.efforts.some((effort)=>effort?.id===selection.reasoningEffort)){
next.reasoningEffort=selection.reasoningEffort;
}
return next;
}
function migrateSettingsDefaults(defaults,provider,groups){
if(typeof provider!=="string"||provider.length===0)return{};
const providerGroup=(Array.isArray(groups)?groups:[]).find((group)=>group?.id===provider);
if(!providerGroup)return{};
const migrated={};
for(const[role,selection]of Object.entries(defaults??{})){
const next=migrateSettingsSelection(selection,provider,groups);
if(next!==null)migrated[role]=next;
}
return migrated;
}
function syncSettingsDefaultsProvider(defaults,provider,groups,roles){
const next={...(defaults&&typeof defaults==="object"?defaults:{})};
if(typeof provider!=="string"||provider.length===0)return next;
for(const role of settingsRolesForProvider(roles)){
const migrated=migrateSettingsSelection(next[role],provider,groups);
next[role]=migrated??{provider,model:""};
}
return next;
}
function normalizeSettingsCommitDraft(value,roles){
const normalized=normalizeSettingsDraft(value,roles);
if(value!==null&&typeof value==="object"
&&Object.prototype.hasOwnProperty.call(value,"promptOverrides")){
normalized.promptOverrides=normalizePromptOverrides(value.promptOverrides);
}
return normalized;
}
async function commitSettingsCandidate(settings,revision,request=globalThis.fetch,connection,roles,changed){
const surface=requireFreshnessSurface();
if(changed===void 0){
return surface.commitSettingsCandidate(settings,revision,{
request,
connection,
normalizeSettingsDraft:normalizeSettingsCommitDraft,
roles,
rpcTarget:RPC_TARGET,
});
}
const body={
action:"settings-commit",
settings,
expectedRevision:revision,
changed,
};
const response=await requestPluginRpc(connection,body,{},request);
return surface.readSettingsCommitOutcome(response,normalizeSettingsCommitDraft,roles);
}
function useHostMeta(ctx){
const[meta,setMeta]=react.useState(null);
const[error,setError]=react.useState(null);
const[version,setVersion]=react.useState(0);
react.useEffect(()=>{
let cancelled=false;
setError(null);
void requestPluginRpc(ctx?.connection,{action:"meta"}).then((response)=>(
response.ok===true?response.json():null
)).then((json)=>{
if(cancelled)return;
if(json!==null&&json?.ok===true){
setMeta(json);
setError(null);
}else{
setMeta(null);
setError("提示词配置读取失败");
}
}).catch((cause)=>{
if(cancelled)return;
setMeta(null);
setError(cause instanceof Error?cause.message:"提示词配置读取失败");
});
return()=>{cancelled=true;};
},[ctx,version]);
return[meta,()=>setVersion((value)=>value+1),error];
}
function useEnabledSettingsRoles(hostMeta){
return react.useMemo(()=>{
const configuredRoles=Array.isArray(hostMeta?.activeRoles)?hostMeta.activeRoles:hostMeta?.roles;
if(!Array.isArray(configuredRoles))return SETTINGS_REQUIRED_ROLE_IDS;
const enabled=configuredRoles.filter((role)=>typeof role==="string"&&role.length>0
&&SETTINGS_ROLE_IDS.includes(role));
if(hostMeta?.enableObserver===true&&!enabled.includes("observer"))enabled.push("observer");
return enabled.filter((role,index)=>enabled.indexOf(role)===index);
},[hostMeta]);
}
global[SYMBOL]=Object.freeze({
DEFAULT_MODEL_FALLBACK_LIMIT,DEFAULT_PEAK_VALLEY_PERIODS,DEFAULT_PROMPT_MAX_GRAPHEMES,MAX_MODEL_CANDIDATES_PER_ROLE,MAX_MODEL_FALLBACK_LIMIT,MAX_MODEL_PAGES,
NEXT_PEAK_VALLEY_PERIOD,
NOTIFICATION_EVENT_TYPES,ORCHESTRATOR_ID,PROMPT_ROLE_IDS,PROMPT_WARNING_RATIO,SETTINGS_ROLE_LABELS,addModelCandidatePage,
bindClientRuntime,clampNotificationVolume,commitSettingsCandidate,compactModelCandidatesDraft,compactOrchestratorDraft,countUnicodeGraphemes,
createSettingsModelCatalog,mergeSettingsDraftOverSource,migrateSettingsDefaults,migrateSettingsSelection,modelCandidatesErrorMessage,
resolveSettingsForm,
modelLayerMapOf,modelLayerSelectionOf,modelPageCountOf,normalizeModelCandidatesDraft,normalizeModelFallbackLimitDraft,normalizeOrchestratorDraft,
normalizePeakValleyDraft,normalizePromptOverrides,normalizeRolePromptProjection,normalizeSettingsCommitDraft,normalizeSettingsDraft,normalizeSettingsModelGroups,
promptEntryOf,promptOverridesEqual,removeModelCandidatePage,reorderModelLayers,setModelLayerSelection,
settingsDraftEqual,settingsRolesForProvider,syncSettingsDefaultsProvider,unifiedProviderOf,updateRolePromptProjection,
useEnabledSettingsRoles,useHostMeta,validateModelCandidateRows,validatePromptText,
});
})(globalThis);
/* source: client-model-config-host.js */
(function installClientModelConfigHost(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-config-host");
const MODEL_CONFIG_GLOBAL_KEY="dsh-expert-group/client-model-config";
const CUSTOM_PROVIDER_NS="llm-pi-ai";
const CUSTOM_PROFILE_BASE_PATH=Object.freeze(["providers"]);
const CUSTOM_ROUTE_PROBE="_probe";
function resolveModelConfig(hostCtx,sidecar){
if(sidecar!==null&&sidecar!==undefined)return sidecar;
try{
const fromCtx=typeof hostCtx?.get==="function"?hostCtx.get(MODEL_CONFIG_GLOBAL_KEY):null;
if(fromCtx!==null&&fromCtx!==undefined)return fromCtx;
}catch{/* 服务未安装或代理拒答。 */}
try{
return globalThis[Symbol.for(MODEL_CONFIG_GLOBAL_KEY)];
}catch{
return undefined;
}
}
function createModelConfigHost(hostCtx,describeSource,sidecar){
const config=resolveModelConfig(hostCtx,sidecar);
if(config===undefined)return null;
const readService=(name)=>{
if(typeof hostCtx?.get==="function"){
try{
const value=hostCtx.get(name);
if(value!==undefined&&value!==null)return value;
}catch{/* 服务未安装或代理拒答，继续尝试属性回退。 */}
}
let current=hostCtx;
for(const segment of String(name).split(".")){
if(segment.length===0)continue;
if(current===undefined||current===null)return null;
try{
current=current[segment];
}catch{
return null;
}
}
return current===undefined?null:current;
};
const readMethod=(target,name)=>{
try{
const value=target?.[name];
return typeof value==="function"?value:null;
}catch{
return null;
}
};
const llm=readService("remote.llm");
const credentials=readService("remote.credentials");
const settingsRemote=readService("remote.settings");
const describeFace=(()=>{
try{
return typeof describeSource?.describe==="function"?describeSource.describe():null;
}catch{
return null;
}
})();
const schemaCache=new WeakMap();
const adapter=(()=>{
const schemaService=readService("settingsSchema");
return config.createSchemaAdapter({
rehydrate:(()=>{
const rehydrate=readMethod(schemaService,"rehydrate");
if(rehydrate===null)return null;
return(serialized)=>{
if(serialized!==null&&typeof serialized==="object"){
const cached=schemaCache.get(serialized);
if(cached!==undefined)return cached;
const node=rehydrate(serialized);
schemaCache.set(serialized,node);
return node;
}
return rehydrate(serialized);
};
})(),
validate:(()=>{
const validate=readMethod(schemaService,"validate");
return validate===null?null:(schema,draft)=>validate(schema,draft);
})(),
nodeAtPath:(()=>{
const nodeAtPath=readMethod(schemaService,"nodeAtPath");
return nodeAtPath===null?null:(root,path)=>nodeAtPath(root,path);
})(),
});
})();
let views=[];
let writable=false;
let credentialStates={};
let describeError=null;
let hostRevision=0;
let hostInvalidation=0;
const hostListeners=new Set();
const notifyHostChange=(external)=>{
hostRevision+=1;
if(external===true)hostInvalidation+=1;
for(const listener of[...hostListeners]){
try{
listener();
}catch{/* 单个订阅者抛错不得影响其它订阅者与 settings 视图。 */}
}
};
const subscribeHost=(listener)=>{
if(typeof listener!=="function")return()=>{};
hostListeners.add(listener);
return()=>hostListeners.delete(listener);
};
const operations={
listProviderDirectory:async()=>{
const listProviders=readMethod(llm,"listProviders");
const listConfigurable=readMethod(llm,"listConfigurableProviders");
if(listConfigurable===null)throw new Error("当前宿主没有提供 provider 配置目录接口");
const[registered,declared]=await Promise.all([
listProviders===null?Promise.resolve({ok:true,value:[]}):listProviders.call(llm),
listConfigurable.call(llm),
]);
if(declared?.ok!==true)throw new Error(declared?.error?.message??"provider 目录读取失败");
if(registered!==null&&registered?.ok!==true)throw new Error(registered?.error?.message??"provider 列表读取失败");
return config.joinProviderDirectory(
registered===null?[]:registered.value,
Array.isArray(declared.value)?declared.value:[],
);
},
describeCredentials:async(refs)=>{
const describe=readMethod(credentials,"describe");
const wanted=[...new Set((Array.isArray(refs)?refs:[]).filter((ref)=>typeof ref==="string"&&ref.length>0))];
if(describe===null||wanted.length===0){
credentialStates={};
return{};
}
const response=await describe.call(credentials,wanted);
credentialStates=response?.ok===true&&response.value!==null&&typeof response.value==="object"?response.value:{};
return credentialStates;
},
credentialState:(ref)=>(typeof ref==="string"?credentialStates[ref]:undefined),
storeKey:async(ref,value)=>{
const set=readMethod(credentials,"set");
if(set===null)return"当前宿主没有提供凭据写入接口";
try{
const response=await set.call(credentials,ref,value);
return response?.ok===true?null:(response?.error?.message??"API Key 保存失败");
}catch(error){
return error instanceof Error?error.message:String(error);
}
},
removeKey:async(ref)=>{
const unset=readMethod(credentials,"unset");
if(unset===null)return"当前宿主没有提供凭据写入接口";
try{
const response=await unset.call(credentials,ref);
return response?.ok===true?null:(response?.error?.message??"API Key 删除失败");
}catch(error){
return error instanceof Error?error.message:String(error);
}
},
discoverModels:async(namespace,request)=>{
const discover=readMethod(llm,"discoverModels");
if(discover===null)return{kind:"refused",message:"当前宿主没有提供「获取模型」接口"};
try{
const response=await discover.call(llm,namespace,request);
if(response?.ok!==true)return{kind:"refused",message:response?.error?.message??"获取模型失败"};
return{kind:"found",models:Array.isArray(response.value)?response.value:[]};
}catch(error){
return{kind:"refused",message:error instanceof Error?error.message:String(error)};
}
},
};
const refreshSettingsView=async()=>{
describeError=null;
if(describeFace===null){
describeError="当前宿主没有提供 settings namespace 视图";
views=[];
writable=false;
return;
}
try{
await describeFace.ensure();
}catch{/* 读取失败由下面的一致性检查报错。 */}
const snapshot=describeFace.getSnapshot?.()??{};
const view=snapshot.view;
if(view===undefined){
describeError=snapshot.error??"settings 命名空间不可用";
views=[];
writable=false;
return;
}
views=Array.isArray(view.namespaces)?view.namespaces:[];
writable=view.writable!==false;
notifyHostChange(false);
};
const invalidationStops=[];
const remote=readService("remote");
const remoteOn=readMethod(remote,"$on");
if(remoteOn!==null){
for(const event of["llm/adapters-updated","settings/document-updated","credentials/reference-updated"]){
try{
invalidationStops.push(remoteOn.call(remote,event,()=>notifyHostChange(true)));
}catch{/* 旧宿主不支持该事件时保持设置页可用。 */}
}
}
const hostOn=readMethod(hostCtx,"on");
if(hostOn!==null){
try{
invalidationStops.push(hostOn.call(hostCtx,"connection/reset",()=>notifyHostChange(true)));
}catch{/* 旧宿主没有连接事件面时无需额外刷新。 */}
}
if(typeof hostCtx?.effect==="function"){
hostCtx.effect(()=>()=>{
for(const stop of invalidationStops)if(typeof stop==="function")stop();
hostListeners.clear();
},"dsh-expert-group: model config settings mirror events");
}
const namespaceView=(ns)=>{
if(describeFace!==null)return config.namespaceViewOf({namespaces:views},ns);
return undefined;
};
const settingsSchemaInfo=(ns)=>{
const view=namespaceView(ns);
return config.namespaceSchemaInfo(view??{},adapter);
};
const writeNamespace=async({ns,ops,expectedRevision})=>{
const mutate=readMethod(settingsRemote,"mutate");
if(mutate===null)return{ok:false,conflict:false,message:"当前宿主没有提供 settings 写入接口"};
if(!config.hasOps(ops))return{ok:true,view:namespaceView(ns)};
const current=namespaceView(ns)?.revision;
if(config.revisionConflictOf(expectedRevision,current)){
return{ok:false,conflict:true,message:"配置已被其它会话或页面修改，本卡片的修改未提交；请重新打开该 provider 卡片后再试。"};
}
let response;
try{
response=await mutate.call(settingsRemote,ns,ops,expectedRevision);
}catch(error){
return{ok:false,conflict:false,message:error instanceof Error?error.message:String(error)};
}
if(response?.ok===true){
const view=response.value;
try{
describeFace?.acceptView?.(view);
}catch{/* 镜像折叠失败不影响本次提交结果。 */}
views=Array.isArray(view?.namespaces)
?view.namespaces
:views.map((entry)=>(entry?.ns===ns?view:entry));
return{ok:true,view};
}
const code=response?.error?.code;
const message=response?.error?.message??"保存失败";
if(code==="settings/conflict"||code==="settings-conflict"){
return{ok:false,conflict:true,message:`配置已被其它会话或页面修改：${message}。请重新打开该 provider 卡片后再试。`};
}
return{ok:false,conflict:false,message};
};
return{
config,
adapter,
operations,
refreshSettingsView,
namespaceView,
settingsSchemaInfo,
writeNamespace,
subscribe:subscribeHost,
getSnapshot:()=>hostRevision,
getInvalidation:()=>hostInvalidation,
describeError:()=>describeError,
readView:()=>({namespaces:views,writable}),
};
}
global[SYMBOL]=Object.freeze({
CUSTOM_PROFILE_BASE_PATH,CUSTOM_PROVIDER_NS,CUSTOM_ROUTE_PROBE,createModelConfigHost,
});
})(globalThis);
/* source: client-subagent-metadata.js */
(function installClientSubagentMetadata(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-subagent-metadata");
const clientNativeStatusSymbol=Symbol.for("dsh-expert-group/client-native-status");
const clientNativeStatus=global[clientNativeStatusSymbol]||{};
const{
STATUS_ROLE_LABELS,STATUS_ROLE_MARKER,collectNativeStatusSessionIds,createNativeStatusRowRewriter,isPluginChildSession,normalizeStatusRole,
resolveNativeStatusTargets,resolveRunningStatusText,resolveStatusIdentity,
}=clientNativeStatus;
let react=null;
let requestPluginRpc=null;
let RPC_PATH=null;
let RPC_CHANNEL=null;
let RPC_ENDPOINT=null;
function bindClientRuntime(host){
react=host.react??null;
requestPluginRpc=host.requestPluginRpc??null;
RPC_PATH=host.RPC_PATH??null;
RPC_CHANNEL=host.RPC_CHANNEL??null;
RPC_ENDPOINT=host.RPC_ENDPOINT??null;
}
function useSessionList(ctx,useSessions){
if(typeof useSessions==="function")return useSessions((snapshot)=>snapshot);
return react.useSyncExternalStore(ctx.sessions.list.subscribe,ctx.sessions.list.getSnapshot);
}
function readEntries(value){
if(value==null)return[];
if(Array.isArray(value)){
if(value.every((entry)=>Array.isArray(entry)&&entry.length===2))return value;
return value.map((entry,index)=>[String(index),entry]);
}
if(typeof value.entries==="function"){
try{return Array.from(value.entries());}catch{return[];}
}
if(typeof value==="object")return Object.entries(value);
return[];
}
function sessionIdOf(session,fallbackId){
const id=session?.sessionId??session?.id??fallbackId;
return typeof id==="string"&&id.length>0?id:void 0;
}
function currentSessionIdOf(sessionList){
const legacyCurrent=metadataString(sessionList?.current);
if(legacyCurrent!==void 0)return legacyCurrent;
for(const[fallbackId,session]of readEntries(sessionList?.byId)){
if(!(Number(session?.retainedBy?.mainView)>0))continue;
const currentId=sessionIdOf(session,fallbackId);
if(currentId!==void 0)return currentId;
}
return void 0;
}
function sessionEntryOf(sessionList,sessionId){
if(typeof sessionId!=="string"||sessionId.length===0)return void 0;
for(const[fallbackId,session]of readEntries(sessionList?.byId)){
if(sessionIdOf(session,fallbackId)===sessionId)return session;
}
return void 0;
}
function rootSessionIdOf(sessionEntries,currentSessionId){
if(typeof currentSessionId!=="string"||currentSessionId.length===0)return void 0;
const sessions=new Map();
for(const[fallbackId,session]of sessionEntries){
const sessionId=sessionIdOf(session,fallbackId);
if(sessionId!==void 0)sessions.set(sessionId,session);
}
if(!sessions.has(currentSessionId))return void 0;
let rootSessionId=currentSessionId;
let candidate=currentSessionId;
const visited=new Set();
while(!visited.has(candidate)){
visited.add(candidate);
const parentId=sessions.get(candidate)?.parentId??sessions.get(candidate)?.parentSessionId;
if(typeof parentId!=="string"||parentId.length===0||parentId===candidate)break;
rootSessionId=parentId;
if(!sessions.has(parentId))break;
candidate=parentId;
}
return rootSessionId;
}
function expertGroupRootSessionIdOf(sessionId,_session,snapshot){
const entries=readEntries(snapshot?.byId??snapshot?.sessions??snapshot);
return rootSessionIdOf(entries,sessionId)??sessionId;
}
function sessionRoleOf(session){
return normalizeStatusRole(
session?.[STATUS_ROLE_MARKER]
??session?.metadata?.[STATUS_ROLE_MARKER]
??session?.role
??session?.metadata?.role
??session?.child?.role,
);
}
const SUBAGENT_METADATA_MARKER="data-deg-subagent-metadata";
const SUBAGENT_METADATA_CLASS="deg_subagent_metadata";
function metadataString(value){
if(typeof value!=="string")return void 0;
const text=value.trim();
return text.length>0?text:void 0;
}
function readSubagentMetadataField(value,field){
const sources=[value,value?.child,value?.metadata];
for(const source of sources){
const text=metadataString(source?.[field]);
if(text!==void 0)return text;
}
return void 0;
}
function normalizeSubagentMetadata(value){
const source=value&&typeof value==="object"?value:{};
const normalized={};
const role=sessionRoleOf(source)??normalizeStatusRole(readSubagentMetadataField(source,"role"));
if(role!==void 0)normalized.role=role;
for(const field of["provider","model","reasoningEffort"]){
const text=readSubagentMetadataField(source,field);
if(text!==void 0)normalized[field]=text;
}
return normalized;
}
function formatSubagentMetadata(value){
const metadata=normalizeSubagentMetadata(value);
const label=metadata.role===void 0?void 0:STATUS_ROLE_LABELS[metadata.role];
if(label===void 0||metadata.provider===void 0||metadata.model===void 0||metadata.reasoningEffort===void 0)return null;
return[label,metadata.model,metadata.reasoningEffort].join(" · ");
}
function subagentTaskNameOf(value){
const sources=[value,value?.child,value?.metadata];
for(const field of["taskName","task","title","displayTitle","label","name"]){
for(const source of sources){
const text=metadataString(source?.[field]);
if(text!==void 0)return text;
}
}
return void 0;
}
function subagentParentIdOf(session){
const direct=metadataString(session?.parentId)??metadataString(session?.parentSessionId);
if(direct!==void 0)return direct;
const origin=session?.origin;
if(origin&&typeof origin==="object"){
return metadataString(origin.parentId)
??metadataString(origin.parentSessionId)
??sessionIdOf(origin);
}
return origin!=="subagent"?metadataString(origin):void 0;
}
function subagentCatalogEntries(value){
return Array.isArray(value)?value:[];
}
function readSubagentCatalogRelations(projectionsBySession){
const relations=[];
for(const[fallbackParentId,projection]of readEntries(projectionsBySession)){
const parentId=metadataString(fallbackParentId)??sessionIdOf(fallbackParentId);
if(parentId===void 0)continue;
const snapshot=projection&&typeof projection==="object"?projection:{};
for(const rawEntry of subagentCatalogEntries(snapshot.values?.subagentCatalog)){
const entry=rawEntry&&typeof rawEntry==="object"?rawEntry:{};
const childId=sessionIdOf(entry);
if(childId===void 0)continue;
relations.push({
parentId,
childId,
child:entry,
taskName:metadataString(entry.label),
});
}
}
return relations;
}
function resolveSubagentRootSessionId(sessionEntries,currentSessionId,projectionsBySession){
if(typeof currentSessionId!=="string"||currentSessionId.length===0)return void 0;
const fromSessions=rootSessionIdOf(sessionEntries,currentSessionId);
if(fromSessions!==void 0)return fromSessions;
const parents=new Map();
for(const relation of readSubagentCatalogRelations(projectionsBySession)){
if(!parents.has(relation.childId))parents.set(relation.childId,relation.parentId);
}
let candidate=currentSessionId;
const visited=new Set();
while(!visited.has(candidate)){
visited.add(candidate);
const parentId=parents.get(candidate);
if(parentId===void 0||parentId===candidate)break;
candidate=parentId;
}
return candidate;
}
function collectSubagentCatalog(sessionList,currentRootSessionId){
const sessionEntries=readEntries(sessionList?.byId);
const sessions=new Map();
for(const[fallbackId,session]of sessionEntries){
const sessionId=sessionIdOf(session,fallbackId);
if(sessionId!==void 0)sessions.set(sessionId,session);
}
const childrenByParent=new Map();
const addChild=(parentId,childId,child,taskName)=>{
if(typeof parentId!=="string"||typeof childId!=="string"||parentId===childId)return;
if(!childrenByParent.has(parentId))childrenByParent.set(parentId,[]);
const children=childrenByParent.get(parentId);
if(children.some((entry)=>entry.childId===childId))return;
children.push({childId,child,taskName:metadataString(taskName)});
if(!sessions.has(childId)&&child&&typeof child==="object")sessions.set(childId,child);
};
for(const relation of readSubagentCatalogRelations(sessionList?.projectionsBySession)){
addChild(relation.parentId,relation.childId,relation.child,relation.taskName);
}
for(const[sessionId,session]of sessions){
const parentId=subagentParentIdOf(session);
if(parentId!==void 0)addChild(parentId,sessionId,session,void 0);
}
if(typeof currentRootSessionId!=="string"||currentRootSessionId.length===0)return[];
const result=[];
const visited=new Set([currentRootSessionId]);
const visit=(parentId)=>{
for(const{childId,child,taskName:catalogTaskName}of childrenByParent.get(parentId)??[]){
if(visited.has(childId))continue;
visited.add(childId);
const session=sessions.get(childId)??child;
const metadata=normalizeSubagentMetadata(session);
result.push({
sessionId:childId,
taskName:catalogTaskName??subagentTaskNameOf(session),
...metadata,
metadata,
});
visit(childId);
}
};
visit(currentRootSessionId);
return result;
}
async function requestSubagentMetadata(sessionId,request=globalThis?.fetch,signal,connection){
if(typeof sessionId!=="string"||sessionId.length===0)return null;
if(typeof request!=="function"&&typeof connection?.rpc?.call!=="function")return null;
try{
const rpc=connection?.rpc;
const response=typeof rpc?.call==="function"
?await rpc.call(RPC_CHANNEL,RPC_ENDPOINT,{action:"get",sessionId,childHint:true},signal)
:await request(RPC_PATH,{
method:"POST",
credentials:"same-origin",
headers:{"content-type":"application/json"},
...(signal===void 0?{}:{signal}),
body:JSON.stringify({action:"get",sessionId,childHint:true}),
});
if(response?.ok!==true)return null;
const payload=typeof response?.json==="function"?await response.json():response?.value;
if(payload?.ok!==true||payload?.kind!=="child")return null;
return normalizeSubagentMetadata(payload.child);
}catch{
return null;
}
}
function nativeElementChildren(node){
return Array.from(node?.childNodes??[]).filter((child)=>child?.nodeType===1);
}
function nativeElements(root){
if(root==null)return[];
const elements=root?.nodeType===1?[root]:[];
try{
for(const element of Array.from(root.querySelectorAll?.("*")??[])){
if(!elements.includes(element))elements.push(element);
}
}catch{}
return elements;
}
function nativeRowElements(root){
if(root==null)return[];
const elements=root?.nodeType===1?[root]:[];
const visit=(node)=>{
for(const child of Array.from(node?.childNodes??[])){
if(child?.nodeType!==1||hasNativeRole(child,"treeitem"))continue;
elements.push(child);
visit(child);
}
};
visit(root);
return elements;
}
function hasNativeRole(node,role){
return node?.getAttribute?.("role")===role;
}
function hasLocalClass(node,localName){
const className=node?.getAttribute?.("class");
if(typeof className!=="string")return false;
return className.split(/\s+/).some((token)=>{
if(token.startsWith("not-"+localName)||token.startsWith("not_"+localName))return false;
return token===localName
||token.startsWith(localName+"_")
||token.startsWith(localName+"-")
||token.endsWith("_"+localName)
||token.includes("_"+localName+"_");
});
}
function findNativeTrees(root){
const trees=[];
if(hasNativeRole(root,"tree"))trees.push(root);
try{
for(const tree of Array.from(root?.querySelectorAll?.('[role="tree"]')??[])){
if(!trees.includes(tree))trees.push(tree);
}
}catch{}
return trees;
}
function findTreeItems(tree){
const items=[];
if(hasNativeRole(tree,"treeitem"))items.push(tree);
try{
for(const item of Array.from(tree?.querySelectorAll?.('[role="treeitem"]')??[])){
if(!items.includes(item))items.push(item);
}
}catch{}
return items;
}
function isSubagentTreeAriaLabel(value){
const label=metadataString(value);
return label!==void 0&&/(subagent|child[ -]?agent|子代理)/i.test(label);
}
function nativeTreeHasCatalogTask(tree,taskNames){
return findTreeItems(tree).some((item)=>{
const parts=findNativeSubagentRowParts(item);
return taskNames.has(metadataString(parts.label?.textContent));
});
}
function findNativeSubagentTrees(root,catalog){
const trees=findNativeTrees(root);
if(!Array.isArray(catalog)||trees.length===0)return[];
const ariaTrees=trees.filter((tree)=>isSubagentTreeAriaLabel(tree?.getAttribute?.("aria-label")));
if(ariaTrees.length>1)return[];
if(ariaTrees.length===1)return ariaTrees;
const taskNames=new Set(catalog
.map((record)=>metadataString(record?.taskName))
.filter((taskName)=>taskName!==void 0));
if(taskNames.size===0)return[];
const matchingTrees=trees.filter((tree)=>nativeTreeHasCatalogTask(tree,taskNames));
return matchingTrees.length===1?matchingTrees:[];
}
function findNativeSubagentTreeItems(root,catalog){
const items=[];
for(const tree of findNativeSubagentTrees(root,catalog)){
for(const item of findTreeItems(tree)){
if(!items.includes(item))items.push(item);
}
}
return items;
}
function nativeContains(parent,child){
if(parent===child)return true;
if(typeof parent?.contains==="function")return parent.contains(child);
let current=child?.parentNode;
while(current!=null){
if(current===parent)return true;
current=current.parentNode;
}
return false;
}
function findNativeSubagentRowParts(item){
const elements=nativeRowElements(item).filter((element)=>!isSubagentMetadataNode(element));
const labelNodes=elements.filter((element)=>hasLocalClass(element,"label"));
const summaryNodes=elements.filter((element)=>hasLocalClass(element,"summary"));
let label=labelNodes.length===1?labelNodes[0]:void 0;
let summary=summaryNodes.length===1?summaryNodes[0]:void 0;
const contentNodes=elements.filter((element)=>hasLocalClass(element,"content"));
if(contentNodes.length>1||labelNodes.length>1||summaryNodes.length>1){
return{label:void 0,summary:void 0};
}
const content=contentNodes.length===1?contentNodes[0]:void 0;
const containers=[];
for(const container of content!==void 0?[content]:contentNodes.length===0?[item]:[]){
if(container!=null&&!containers.includes(container))containers.push(container);
}
for(const container of containers){
const children=nativeElementChildren(container).filter((element)=>!isSubagentMetadataNode(element));
if(children.length!==2)continue;
if(label===void 0&&labelNodes.length===0)label=children[0];
if(summary===void 0&&summaryNodes.length===0)summary=children.find((element)=>element!==label);
if(label!==void 0&&summary!==void 0)break;
}
if(label===summary)return{label:void 0,summary:void 0};
return{label,summary};
}
function isSubagentMetadataNode(node){
return typeof node?.getAttribute==="function"&&node.getAttribute(SUBAGENT_METADATA_MARKER)!==null;
}
function findSubagentMetadataNodes(root){
return(root?.getAttribute?.("role")==="treeitem"?nativeRowElements(root):nativeElements(root))
.filter(isSubagentMetadataNode);
}
function removeSubagentMetadataNode(node){
try{
if(typeof node?.remove==="function")node.remove();
else node?.parentNode?.removeChild?.(node);
}catch{}
}
function removeSubagentMetadata(root){
const nodes=findSubagentMetadataNodes(root);
for(const node of nodes)removeSubagentMetadataNode(node);
return nodes.length;
}
function rpcMetadataFor(rpcMetadata,sessionId){
if(rpcMetadata instanceof Map)return rpcMetadata.get(sessionId);
return rpcMetadata?.[sessionId];
}
function metadataForSubagentRecord(record,rpcMetadata){
const rpc=rpcMetadataFor(rpcMetadata,record?.sessionId);
return normalizeSubagentMetadata({...(record?.metadata??{}),...record,...(rpc??{})});
}
function nativeSubagentSessionIdOf(item){
for(const name of["data-session-id","data-subagent-id","data-id"]){
const value=metadataString(item?.getAttribute?.(name));
if(value!==void 0)return value;
}
return void 0;
}
function applySubagentMetadata(root,catalog,rpcMetadata){
const records=Array.isArray(catalog)?catalog:[];
const items=findNativeSubagentTreeItems(root,records);
const recordsByTask=new Map();
const recordsBySession=new Map();
for(const record of records){
const taskName=metadataString(record?.taskName);
if(taskName===void 0||typeof record?.sessionId!=="string")continue;
if(!recordsByTask.has(taskName))recordsByTask.set(taskName,[]);
recordsByTask.get(taskName).push(record);
if(recordsBySession.has(record.sessionId))recordsBySession.set(record.sessionId,null);
else recordsBySession.set(record.sessionId,record);
}
const rowLabelCounts=new Map();
const rowParts=new Map();
for(const item of items){
const parts=findNativeSubagentRowParts(item);
rowParts.set(item,parts);
const taskName=metadataString(parts.label?.textContent);
if(taskName!==void 0)rowLabelCounts.set(taskName,(rowLabelCounts.get(taskName)??0)+1);
}
for(const item of items){
const parts=rowParts.get(item)??{label:void 0,summary:void 0};
const existing=findSubagentMetadataNodes(item);
const taskName=metadataString(parts.label?.textContent);
const candidates=taskName===void 0?[]:recordsByTask.get(taskName)??[];
const rowSessionId=nativeSubagentSessionIdOf(item);
let record;
if(rowSessionId!==void 0){
const candidate=recordsBySession.get(rowSessionId);
if(candidate!==null&&candidate?.taskName===taskName)record=candidate;
}else if(taskName!==void 0&&rowLabelCounts.get(taskName)===1&&candidates.length===1){
record=candidates[0];
}
const text=parts.summary==null||record===void 0
?null
:formatSubagentMetadata(metadataForSubagentRecord(record,rpcMetadata));
if(text===null||parts.summary?.parentNode==null){
for(const node of existing)removeSubagentMetadataNode(node);
continue;
}
const node=existing[0]??parts.summary.ownerDocument?.createElement?.("span")??parts.summary.parentNode?.ownerDocument?.createElement?.("span");
if(node==null)continue;
if(existing.length>1){
for(const duplicate of existing.slice(1))removeSubagentMetadataNode(duplicate);
}
if(!isSubagentMetadataNode(node)){
node.setAttribute?.(SUBAGENT_METADATA_MARKER,"");
node.className=SUBAGENT_METADATA_CLASS;
}
if(node.textContent!==text)node.textContent=text;
if(node.parentNode!==parts.summary.parentNode||node.nextSibling!==parts.summary){
parts.summary.parentNode.insertBefore(node,parts.summary);
}
}
for(const node of findSubagentMetadataNodes(root)){
if(!items.some((item)=>nativeContains(item,node)))removeSubagentMetadataNode(node);
}
return findSubagentMetadataNodes(root).length;
}
function installNativeStatusBridge(ctx){
const doc=typeof document!=="undefined"?document:null;
const root=doc?.body??doc?.documentElement;
const sessionStore=ctx?.sessions?.list;
if(root==null||typeof sessionStore?.getSnapshot!=="function"||typeof sessionStore?.subscribe!=="function")return()=>{};
let disposed=false;
let sessionList={};
let observer=null;
const lanes=new Map();
const createLane=(sessionId)=>({
sessionId,
rewriter:createNativeStatusRowRewriter({
resolveTargets:()=>resolveNativeStatusTargets(root,sessionId,true),
}),
identityKey:null,
rpcState:{sessionId:void 0,kind:"pending",role:void 0},
requestSerial:0,
controller:null,
});
const currentEntryOf=(sessionId)=>sessionEntryOf(sessionList,sessionId);
const renderLane=(lane,entry)=>{
if(disposed)return;
const statusText=resolveRunningStatusText({
sessionId:lane.sessionId,
currentSessionId:lane.sessionId,
running:entry?.running,
session:entry,
kind:lane.rpcState.sessionId===lane.sessionId?lane.rpcState.kind:"pending",
role:lane.rpcState.sessionId===lane.sessionId?lane.rpcState.role:void 0,
});
lane.rewriter.apply(statusText);
};
const refreshLane=(lane,entry)=>{
const markedRole=normalizeStatusRole(entry?.[STATUS_ROLE_MARKER]??entry?.metadata?.[STATUS_ROLE_MARKER]);
const childSession=isPluginChildSession(entry);
const nextKey=[lane.sessionId,childSession?"child":"root",markedRole??"",entry?.running===true?"running":"idle"].join("\u0000");
if(nextKey===lane.identityKey){
renderLane(lane,entry);
return;
}
lane.identityKey=nextKey;
lane.requestSerial+=1;
lane.controller?.abort();
lane.controller=null;
lane.rpcState={sessionId:lane.sessionId,kind:markedRole!==void 0?"child":"pending",role:markedRole};
renderLane(lane,entry);
if(entry?.running!==true)return;
const requestToken=lane.requestSerial;
lane.controller=typeof AbortController==="function"?new AbortController():null;
(async()=>{
try{
const response=await requestPluginRpc(ctx.connection,{
action:"get",sessionId:lane.sessionId,childHint:childSession,
},lane.controller===null?{}:{signal:lane.controller.signal});
if(disposed||requestToken!==lane.requestSerial||lanes.get(lane.sessionId)!==lane)return;
if(!response?.ok){
lane.rpcState={sessionId:lane.sessionId,kind:markedRole!==void 0?"child":"unknown",role:markedRole};
renderLane(lane,currentEntryOf(lane.sessionId));
return;
}
const json=await response.json();
if(disposed||requestToken!==lane.requestSerial||lanes.get(lane.sessionId)!==lane)return;
const identity=resolveStatusIdentity({sessionId:lane.sessionId,responseSessionId:lane.sessionId,response:json});
if(identity===null)return;
const markerFallbackKind=markedRole!==void 0&&identity.kind==="unknown"?"child":identity.kind;
lane.rpcState={sessionId:lane.sessionId,kind:markerFallbackKind,role:identity.role??markedRole};
renderLane(lane,currentEntryOf(lane.sessionId));
}catch(error){
if(disposed||requestToken!==lane.requestSerial||lanes.get(lane.sessionId)!==lane||error?.name==="AbortError")return;
lane.rpcState={sessionId:lane.sessionId,kind:markedRole!==void 0?"child":"unknown",role:markedRole};
renderLane(lane,currentEntryOf(lane.sessionId));
}
})();
};
const dropLane=(lane)=>{
lane.requestSerial+=1;
lane.controller?.abort();
lane.controller=null;
lane.rewriter.restore();
lanes.delete(lane.sessionId);
};
const sync=()=>{
if(disposed)return;
try{
sessionList=sessionStore.getSnapshot()??{};
}catch{
sessionList={};
}
const candidates=collectNativeStatusSessionIds(root);
const candidateIds=new Set(candidates);
for(const sessionId of candidates){
const entry=currentEntryOf(sessionId);
if(entry===void 0)continue;
const lane=lanes.get(sessionId)??createLane(sessionId);
lanes.set(sessionId,lane);
refreshLane(lane,entry);
}
for(const lane of[...lanes.values()]){
if(currentEntryOf(lane.sessionId)===void 0||!candidateIds.has(lane.sessionId)){
dropLane(lane);
}
}
};
let unsubscribe=()=>{};
try{
const cleanup=sessionStore.subscribe(sync);
if(typeof cleanup==="function")unsubscribe=cleanup;
}catch{
}
sync();
const Observer=doc?.defaultView?.MutationObserver
??(typeof globalThis!=="undefined"?globalThis.MutationObserver:void 0);
if(typeof Observer==="function"){
try{
observer=new Observer(()=>sync());
observer.observe(root,{childList:true,subtree:true,characterData:true});
}catch{
observer=null;
}
}
return()=>{
if(disposed)return;
disposed=true;
try{unsubscribe();}catch{}
try{observer?.disconnect();}catch{}
observer=null;
for(const lane of[...lanes.values()])dropLane(lane);
};
}
function SubagentMetadataBridge({ctx,useSessions}){
const sessionList=useSessionList(ctx,useSessions)??{};
const sessionEntries=react.useMemo(()=>readEntries(sessionList.byId),[sessionList]);
const currentSessionId=currentSessionIdOf(sessionList);
const projectionsBySession=sessionList.projectionsBySession;
const currentRootSessionId=react.useMemo(
()=>resolveSubagentRootSessionId(sessionEntries,currentSessionId,projectionsBySession),
[currentSessionId,sessionEntries,projectionsBySession],
);
const catalog=react.useMemo(
()=>collectSubagentCatalog({byId:sessionEntries,projectionsBySession},currentRootSessionId),
[currentRootSessionId,sessionEntries,projectionsBySession],
);
const catalogRef=react.useRef(catalog);
catalogRef.current=catalog;
const catalogKey=JSON.stringify({
root:currentRootSessionId??null,
records:catalog.map((record)=>({
sessionId:record.sessionId,
taskName:record.taskName,
role:record.role,
provider:record.provider,
model:record.model,
reasoningEffort:record.reasoningEffort,
})),
});
const[rpcState,setRpcState]=react.useState(()=>({catalogKey:"",values:new Map()}));
const rpcMetadata=rpcState.catalogKey===catalogKey?rpcState.values:null;
react.useEffect(()=>{
let cancelled=false;
const controller=typeof AbortController==="function"?new AbortController():null;
setRpcState({catalogKey,values:new Map()});
const unresolved=catalogRef.current.filter((record)=>formatSubagentMetadata(record)===null);
if(unresolved.length>0){
void Promise.all(unresolved.map(async(record)=>[
record.sessionId,
await requestSubagentMetadata(record.sessionId,globalThis?.fetch,controller?.signal,ctx.connection),
])).then((results)=>{
if(cancelled)return;
const values=new Map();
for(const[sessionId,metadata]of results){
if(typeof sessionId==="string"&&metadata!==null)values.set(sessionId,metadata);
}
setRpcState((previous)=>previous.catalogKey===catalogKey
?{catalogKey,values}
:previous);
}).catch(()=>{});
}
return()=>{
cancelled=true;
controller?.abort();
};
},[catalogKey]);
react.useEffect(()=>{
const doc=typeof document!=="undefined"?document:null;
const root=doc?.body??doc?.documentElement;
let disposed=false;
if(root==null)return()=>{};
const render=()=>{
if(!disposed)applySubagentMetadata(root,catalogRef.current,rpcMetadata);
};
render();
const Observer=doc?.defaultView?.MutationObserver
??(typeof globalThis!=="undefined"?globalThis.MutationObserver:void 0);
if(typeof Observer!=="function")return()=>{
disposed=true;
removeSubagentMetadata(root);
};
const observer=new Observer(()=>{
render();
});
observer.observe(root,{childList:true,subtree:true,characterData:true});
return()=>{
disposed=true;
observer.disconnect();
removeSubagentMetadata(root);
};
},[catalogKey,rpcMetadata]);
return null;
}
global[SYMBOL]=Object.freeze({
SubagentMetadataBridge,applySubagentMetadata,bindClientRuntime,collectSubagentCatalog,expertGroupRootSessionIdOf,
findNativeSubagentRowParts,findNativeSubagentTreeItems,findNativeSubagentTrees,formatSubagentMetadata,installNativeStatusBridge,
normalizeSubagentMetadata,removeSubagentMetadata,requestSubagentMetadata,
});
})(globalThis);
/* source: client-settings-main-b.js */
(function installClientSettingsMainB(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-settings-main-b");
const clientSettingsNormalizeSymbol=Symbol.for("dsh-expert-group/client-settings-normalize");
const clientSettingsNormalize=global[clientSettingsNormalizeSymbol]||{};
const{
DEFAULT_MODEL_FALLBACK_LIMIT,MAX_MODEL_CANDIDATES_PER_ROLE,MAX_MODEL_FALLBACK_LIMIT,MAX_MODEL_PAGES,NEXT_PEAK_VALLEY_PERIOD,
NOTIFICATION_EVENT_TYPES,ORCHESTRATOR_ID,PROMPT_WARNING_RATIO,
clampNotificationVolume,migrateSettingsSelection,modelLayerSelectionOf,normalizeRolePromptProjection,normalizeSettingsDraft,promptEntryOf,
setModelLayerSelection,settingsRolesForProvider,syncSettingsDefaultsProvider,validatePromptText,
}=clientSettingsNormalize;
let react=null;
let ModelConfigSection=null;
const ORCHESTRATOR_ROW_LABEL="Orchestrator";
let peakValleyTime=null;
function bindClientRuntime(host){
react=host.react??null;
ModelConfigSection=host.ModelConfigSection??null;
peakValleyTime=host.peakValleyTime??null;
}
function renderSettingsTail(view){
const{closePrompt,selectedPromptRole,settingsSnapshot}=view;
const actions=createSettingsTailActions(view);
if(settingsSnapshot.status==="loading"){
return react.createElement("div",{className:"deg_settings"},
selectedPromptRole===null?null:react.createElement("button",{
type:"button",
className:"deg_btn deg_prompt_back",
"aria-label":"返回专家列表",
onClick:closePrompt,
},"返回专家列表"),
react.createElement("p",{className:"deg_settings_status",role:"status","aria-live":"polite"},"正在读取设置…"));
}
if(settingsSnapshot.status==="unavailable"){
return react.createElement("div",{className:"deg_settings"},
selectedPromptRole===null?null:react.createElement("button",{
type:"button",
className:"deg_btn deg_prompt_back",
"aria-label":"返回专家列表",
onClick:closePrompt,
},"返回专家列表"),
react.createElement("p",{className:"deg_settings_error",role:"status"},"设置 namespace 不可用"));
}
const promptEditor=renderSettingsPromptEditor(view,actions);
const leaveDialog=renderSettingsLeaveDialog(view,actions);
if(selectedPromptRole!==null)return react.createElement(react.Fragment,null,promptEditor,leaveDialog);
if(view.peakValleyOpen===true&&typeof view.peakValleyViewOf==="function"){
return renderPeakValleySettings(view.peakValleyViewOf(view));
}
return renderSettingsBody(view,actions);
}
function createSettingsTailActions(view){
const{
authorityValue,baselineProjection,committedAuthorityRef,committedSnapshotLagging,editPromptText,hostMeta,
leaveTriggerRef,promptDirty,promptProjection,promptRoleIds,roles,save,
saving,selectedPromptRole,setCandidatesError,setDirty,setDraft,setEditorBaseline,
setError,setExternalSettingsChanged,setLeaveIntent,setLocalPromptProjection,setPromptDrafts,setPromptError,
setPromptTouched,setSaved,setSettingsConflict,settingsConflict,settingsForm,settingsReadOnly,
settingsSnapshot,
}=view;
const discard=()=>{
const snapshot=settingsForm.getSnapshot();
const refreshedProjection=normalizeRolePromptProjection(hostMeta?.rolePrompts,authorityValue,true,promptRoleIds)??promptProjection;
setDraft(normalizeSettingsDraft(authorityValue,roles,true,true));
setCandidatesError(null);
setPromptDrafts({});
setPromptTouched({});
if(selectedPromptRole!==null&&refreshedProjection!==null){
setEditorBaseline({
role:selectedPromptRole,
value:authorityValue,
revision:Number.isSafeInteger(committedAuthorityRef.current?.revision)&&committedSnapshotLagging
?committedAuthorityRef.current.revision
:(Number.isSafeInteger(snapshot.revision)?snapshot.revision:null),
projection:refreshedProjection,
});
}
setDirty(false);
setSaved(false);
setError(null);
setPromptError(null);
setSettingsConflict(null);
setExternalSettingsChanged(false);
};
const loadLatestPromptSettings=()=>{
const snapshot=settingsForm.getSnapshot();
if(settingsConflict?.revision!==undefined
&&(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<settingsConflict.revision)){
setPromptError("最新配置尚未到达，请稍后再加载");
return;
}
const projection=normalizeRolePromptProjection(hostMeta?.rolePrompts,snapshot.value,true,promptRoleIds)??promptProjection;
if(selectedPromptRole===null||projection===null){
setPromptError("最新提示词配置不可用，请稍后重试");
return;
}
setLocalPromptProjection(null);
setDraft(normalizeSettingsDraft(snapshot.value,roles,true,true));
setPromptDrafts({});
setPromptTouched({});
setEditorBaseline({role:selectedPromptRole,value:snapshot.value,revision:snapshot.revision,projection});
setDirty(false);
setSaved(false);
setError(null);
setPromptError(null);
setSettingsConflict(null);
setExternalSettingsChanged(false);
};
const retryPromptSave=async()=>{
if(settingsConflict?.revision!==undefined
&&(!Number.isSafeInteger(settingsSnapshot.revision)||settingsSnapshot.revision<settingsConflict.revision)){
setPromptError("最新配置尚未到达，请先加载最新配置");
return false;
}
return save({retry:true});
};
const restorePromptDefault=()=>{
const role=selectedPromptRole;
const entry=promptEntryOf(baselineProjection,role);
if(role===null||entry===null||settingsReadOnly||saving||baselineProjection?.customizable!==true)return;
if(promptDirty){
leaveTriggerRef.current=typeof document==="undefined"?null:document.activeElement;
setLeaveIntent({kind:"restore-default",role});
return;
}
editPromptText(role,entry.defaultPersona);
};
return{discard,loadLatestPromptSettings,restorePromptDefault,retryPromptSave};
}
function renderSettingsPromptEditor(view,actions){
const{
baselineProjection,closePrompt,editPromptText,error,externalSettingsChanged,hasUnsavedChanges,
hostMetaError,promptError,promptLoading,promptMaxGraphemes,promptProjection,promptTextOf,
refreshHostMeta,roleLabelOf,save,saved,saving,selectedPromptRole,
settingsConflict,settingsReadOnly,
}=view;
const selectedPromptEntry=promptEntryOf(promptProjection,selectedPromptRole);
const selectedPromptText=selectedPromptRole===null?"":promptTextOf(selectedPromptRole);
const promptValidation=validatePromptText(selectedPromptText,promptMaxGraphemes);
const promptCounterClass=promptValidation.count>promptMaxGraphemes
?" deg_prompt_counter_error"
:promptValidation.count>=promptMaxGraphemes*PROMPT_WARNING_RATIO
?" deg_prompt_counter_warning"
:"";
const promptMetaMessage=hostMetaError
??(promptProjection===null&&!promptLoading?"提示词配置不可用，请刷新后重试":null);
const promptStatusMessage=promptMetaMessage
??(settingsReadOnly?"当前设置为只读，可查看提示词但不能编辑或保存。":null);
const promptValidationMessage=selectedPromptRole!==null&&!promptValidation.ok?promptValidation.message:null;
const promptErrorMessage=promptError??promptValidationMessage??error??promptMetaMessage;
const promptLabel=selectedPromptRole===null
?"专家"
:roleLabelOf(selectedPromptRole);
const promptEditor=selectedPromptRole===null?null:react.createElement("div",{className:"deg_settings deg_settings_prompt_editor"},
react.createElement("div",{className:"deg_prompt_header"},
react.createElement("h2",{className:"deg_settings_title"},promptLabel)),
react.createElement("label",{className:"deg_prompt_label",htmlFor:"deg-prompt-textarea-"+selectedPromptRole},"提示词"),
promptProjection===null
?react.createElement(react.Fragment,null,
react.createElement("p",{className:"deg_prompt_status",role:"status","aria-live":"polite"},promptStatusMessage??"提示词配置加载中…"),
promptLoading?null:react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:saving,
onClick:refreshHostMeta,
},"重试加载提示词配置"))
:react.createElement(react.Fragment,null,
react.createElement("textarea",{
id:"deg-prompt-textarea-"+selectedPromptRole,
className:"deg_prompt_textarea",
"data-deg-prompt-role":selectedPromptRole,
"aria-label":promptLabel+"提示词",
"aria-describedby":"deg-prompt-counter-"+selectedPromptRole
+(promptErrorMessage===null?"":" deg-prompt-error-"+selectedPromptRole),
"aria-invalid":!promptValidation.ok||promptErrorMessage!==null,
value:selectedPromptText,
disabled:settingsReadOnly||saving||promptProjection.customizable!==true,
onChange:(event)=>{
const text=typeof event?.target?.value==="string"?event.target.value:"";
editPromptText(selectedPromptRole,text);
},
}),
react.createElement("div",{
id:"deg-prompt-counter-"+selectedPromptRole,
className:"deg_prompt_counter"+promptCounterClass,
role:"status",
"aria-live":"polite",
},String(promptValidation.count)+" / "+String(promptMaxGraphemes)),
promptStatusMessage===null?null:react.createElement("p",{className:"deg_prompt_status",role:"status"},promptStatusMessage)),
promptErrorMessage===null?null:react.createElement("p",{
id:"deg-prompt-error-"+selectedPromptRole,
className:"deg_settings_error",
role:"alert",
"aria-live":"assertive",
},promptErrorMessage),
externalSettingsChanged?react.createElement("p",{
className:"deg_prompt_status",
role:"status",
"aria-live":"polite",
},"配置已发生外部变化"):null,
settingsConflict===null?null:react.createElement("div",{className:"deg_prompt_conflict",role:"alert"},
react.createElement("p",{className:"deg_settings_error"},"保存遇到配置冲突，请选择下一步。"),
react.createElement("div",{className:"deg_prompt_dialog_actions"},
react.createElement("button",{type:"button",className:"deg_btn",disabled:saving,onClick:actions.loadLatestPromptSettings},"加载最新配置"),
react.createElement("button",{type:"button",className:"deg_btn deg_btn_primary",disabled:saving,onClick:actions.retryPromptSave},"继续使用当前修改重试"))),
react.createElement("div",{className:"deg_prompt_footer"},
react.createElement("button",{
type:"button",
className:"deg_btn deg_prompt_back",
"aria-label":"返回专家列表",
disabled:saving,
onClick:closePrompt,
},"返回专家列表"),
react.createElement("span",{className:"deg_prompt_status",role:"status","aria-live":"polite"},saved?"已保存":hasUnsavedChanges?"有未保存的修改":""),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
disabled:!hasUnsavedChanges||!promptValidation.ok||saving
||settingsReadOnly||promptLoading||baselineProjection?.customizable!==true,
onClick:save,
},saving?"保存中…":"保存"),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:saving||settingsReadOnly||promptLoading||promptProjection?.customizable!==true
||selectedPromptEntry===null||selectedPromptText===selectedPromptEntry.defaultPersona,
onClick:actions.restorePromptDefault,
},"恢复默认")));
return promptEditor;
}
function trapDialogTabFocus(event){
const controls=Array.from(event.currentTarget?.querySelectorAll?.("[data-deg-dialog-action]")??[]);
if(controls.length===0)return;
const current=controls.indexOf(typeof document==="undefined"?null:document.activeElement);
const nextIndex=event.shiftKey
?(current<=0?controls.length-1:current-1)
:(current>=controls.length-1?0:current+1);
event.preventDefault?.();
try{controls[nextIndex]?.focus?.();}catch{/* 无 DOM 焦点时保持可点击按钮。 */}
}
function showTimePickerOf(event){
const input=event?.currentTarget;
if(input?.disabled===true||typeof input?.showPicker!=="function")return;
try{input.showPicker();}catch{/* 原生选择器已打开或该宿主不允许：保持原生行为。 */}
}
function renderSettingsLeaveDialog(view,actions){
const{
applyPromptNavigation,baselineProjection,dismissLeaveDialog,editPromptText,leaveCancelRef,leaveIntent,
save,saving,
}=view;
const leaveDialog=leaveIntent===null?null:react.createElement("div",{className:"deg_prompt_dialog_backdrop"},
react.createElement("div",{
className:"deg_prompt_dialog",
role:"dialog",
"aria-modal":"true",
"aria-label":"未保存的修改",
onKeyDown:(event)=>{
if(event.key==="Escape"){
event.preventDefault?.();
dismissLeaveDialog();
return;
}
if(event.key!=="Tab")return;
trapDialogTabFocus(event);
},
},
react.createElement("h3",null,"未保存的修改"),
react.createElement("p",null,"离开前请选择如何处理当前草稿。"),
react.createElement("div",{className:"deg_prompt_dialog_actions"},
leaveIntent.kind==="restore-default"
?react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-dialog-action":"restore",
disabled:saving,
onClick:()=>{
const role=leaveIntent.role;
const entry=promptEntryOf(baselineProjection,role);
dismissLeaveDialog();
if(entry!==null)editPromptText(role,entry.defaultPersona);
},
},"恢复默认")
:react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-dialog-action":"save",
disabled:saving,
onClick:async()=>{
const savedNow=await save();
if(savedNow!==true)return;
const intent=leaveIntent;
dismissLeaveDialog();
applyPromptNavigation(intent?.role??null);
},
},saving?"保存中…":"保存并离开"),
leaveIntent.kind==="restore-default"?null:react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"actions.discard",
disabled:saving,
onClick:()=>{
const intent=leaveIntent;
actions.discard();
dismissLeaveDialog();
applyPromptNavigation(intent?.role??null);
},
},"放弃修改"),
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"cancel",
autoFocus:true,
ref:leaveCancelRef,
onClick:dismissLeaveDialog,
},"取消"))));
return leaveDialog;
}
function renderSettingsRoleTable(view){
const{
catalogAvailable,currentModelPage,draft,editDraft,error,modelRowRoles,
openPrompt,promptProjection,promptRoleIds,providerGroups,roleLabelOf,roles,
saving,selectedPromptRole,tExtra,
}=view;
const header=react.createElement(react.Fragment,null,
react.createElement("span",{className:"deg_settings_table_head"},"专家"),
react.createElement("span",{className:"deg_settings_table_head"},"供应商"),
react.createElement("span",{className:"deg_settings_table_head"},"模型选择"),
react.createElement("span",{className:"deg_settings_table_head"},"思考深度"));
const rows=modelRowRoles.map((role)=>{
const isOrchestrator=role===ORCHESTRATOR_ID;
const roleLabel=isOrchestrator?ORCHESTRATOR_ROW_LABEL:roleLabelOf(role);
const roleEnabled=isOrchestrator||roles.includes(role);
const selection=modelLayerSelectionOf(draft,role,currentModelPage);
const rowProvider=typeof selection?.provider==="string"?selection.provider:"";
const rowProviderGroup=providerGroups.find((group)=>group.id===rowProvider);
const rowModels=rowProviderGroup?.models??[];
const currentModel=rowModels.find((model)=>model.id===selection?.model);
const providerOptions=[
react.createElement("option",{key:"__empty-provider",value:""},
isOrchestrator?tExtra("settings.orchestrator.empty"):"未选择供应商"),
...(rowProvider&&rowProviderGroup===undefined
?[react.createElement("option",{key:"__unavailable-provider",value:rowProvider,disabled:true},rowProvider+"（不可用）")]
:[]),
...providerGroups.map((group)=>react.createElement("option",{key:group.id,value:group.id},group.name??group.id)),
];
const modelOptions=[];
if(!rowProvider){
modelOptions.push(react.createElement("option",{key:"__provider",value:""},"先选择供应商"));
}else{
modelOptions.push(react.createElement("option",{key:"__empty",value:""},"未选择模型"));
if(selection?.model&&currentModel===undefined){
modelOptions.push(react.createElement("option",{key:"__unavailable",value:selection.model,disabled:true},selection.model+"（不可用）"));
}
for(const model of rowModels){
modelOptions.push(react.createElement("option",{key:model.id,value:model.id},model.name??model.id));
}
}
const reasoning=currentModel?.reasoning;
const effortOptions=[];
if(reasoning){
effortOptions.push(react.createElement("option",{key:"__default",value:""},"模型默认"));
for(const effort of reasoning.efforts??[]){
effortOptions.push(react.createElement("option",{key:effort.id,value:effort.id},effort.name??effort.id));
}
}else{
effortOptions.push(react.createElement("option",{key:"__unsupported",value:""},rowProvider?"模型无思考深度":"先选择模型"));
}
const updateProvider=(event)=>{
const provider=event.target.value;
editDraft((previous)=>{
const current=modelLayerSelectionOf(previous,role,currentModelPage);
const currentProvider=typeof current?.provider==="string"?current.provider:"";
if(provider===currentProvider)return previous;
if(currentModelPage===0){
const next=!provider
?null
:(migrateSettingsSelection(current,provider,providerGroups)??{provider,model:""});
const written=setModelLayerSelection(previous,role,0,next);
return isOrchestrator?written:{...written,provider:""};
}
const next=!provider
?{provider:"",model:""}
:(migrateSettingsSelection(current,provider,providerGroups)??{provider,model:""});
return setModelLayerSelection(previous,role,currentModelPage,next);
});
};
const updateModel=(event)=>{
const modelId=event.target.value;
editDraft((previous)=>{
const current=modelLayerSelectionOf(previous,role,currentModelPage);
const provider=typeof current?.provider==="string"?current.provider:"";
if(!provider)return previous;
if(!modelId){
if(typeof current?.model==="string"&&current.model.length===0)return previous;
return setModelLayerSelection(previous,role,currentModelPage,{provider,model:""});
}
const model=providerGroups.find((group)=>group.id===provider)?.models?.find((candidate)=>candidate.id===modelId);
if(!model)return previous;
const selected={provider,model:model.id};
if(typeof model.reasoning?.defaultEffort==="string")selected.reasoningEffort=model.reasoning.defaultEffort;
return setModelLayerSelection(previous,role,currentModelPage,selected);
});
};
const updateReasoning=(event)=>{
const effort=event.target.value;
editDraft((previous)=>{
const current=modelLayerSelectionOf(previous,role,currentModelPage);
if(current===null||typeof current.model!=="string"||current.model.length===0)return previous;
const next={...current};
if(effort)next.reasoningEffort=effort;
else delete next.reasoningEffort;
if(next.reasoningEffort===current.reasoningEffort)return previous;
return setModelLayerSelection(previous,role,currentModelPage,next);
});
};
const promptEntryAvailable=promptRoleIds.includes(role);
return react.createElement(react.Fragment,{key:role},
react.createElement("div",{className:"deg_settings_table_cell deg_settings_role_cell"},
promptEntryAvailable
?react.createElement("button",{
type:"button",
className:"deg_settings_role_button",
"data-deg-prompt-role":role,
"aria-label":roleLabel+"提示词"
+(promptEntryOf(promptProjection,role)?.customized===true?"（已自定义提示词）":""),
"aria-pressed":selectedPromptRole===role,
disabled:saving,
onClick:(event)=>openPrompt(role,event),
},
react.createElement("span",null,roleLabel),
promptEntryOf(promptProjection,role)?.customized===true
?react.createElement("span",{
className:"deg_settings_prompt_customized_dot",
"aria-hidden":"true",
})
:null)
:react.createElement("span",{className:"deg_settings_label","data-deg-role-label":role},roleLabel),
),
react.createElement("div",{className:"deg_settings_table_cell"},
react.createElement("select",{
className:"deg_settings_provider_select",
"aria-label":roleLabel+" 供应商",
value:rowProvider,
disabled:saving||!catalogAvailable||!roleEnabled,
onChange:updateProvider,
},providerOptions)),
react.createElement("div",{className:"deg_settings_table_cell"},
react.createElement("select",{
className:"deg_settings_model_select",
"aria-label":roleLabel+" 模型选择",
value:selection?.model??"",
disabled:saving||!catalogAvailable||!roleEnabled||!rowProvider||rowProviderGroup===undefined,
onChange:updateModel,
},modelOptions)),
react.createElement("div",{className:"deg_settings_table_cell"},
react.createElement("select",{
className:"deg_settings_effort_select",
"aria-label":roleLabel+" 思考深度",
value:selection?.reasoningEffort??"",
disabled:saving||!catalogAvailable||!roleEnabled||reasoning===undefined||!selection?.model,
onChange:updateReasoning,
},effortOptions)));
});
return react.createElement("div",{className:"deg_settings_table_wrap"},
react.createElement("div",{className:"deg_settings_table"},header,rows));
}
function renderPeakValleyPeriodToggle(view){
const{
peakValleyPeriod,saving,setPeakValleyPeriod,tExtra,
}=view;
const toggleButtons=["peak","valley"].map((period)=>react.createElement("button",{
key:period,
type:"button",
className:"deg_btn deg_settings_peak_valley_period"+(period===peakValleyPeriod?" deg_btn_primary":""),
"data-deg-peak-valley-period":period,
"aria-pressed":period===peakValleyPeriod,
disabled:saving,
onClick:()=>setPeakValleyPeriod(period),
},tExtra(period==="peak"?"settings.pv.peak":"settings.pv.valley")));
return react.createElement("div",{
className:"deg_settings_pv_period_toggle",
"data-deg-peak-valley-periods-toggle":"true",
},toggleButtons);
}
function renderSettingsModelTabs(view){
const{
addModelPage,beginModelTabDrag,currentModelPage,draft,modelPageCount,modelPageLabelOf,modelTabDrag,
modelTabRefs,openPeakValley,peakValleyEntry,requestModelPageDelete,saving,selectModelPage,
settingsReadOnly,tExtra,
}=view;
const modelTabChildren=[];
for(let page=0;page<modelPageCount;page+=1){
if(modelTabDrag?.active===true&&modelTabDrag.dropIndex===page){
modelTabChildren.push(react.createElement("span",{
key:"drop-"+page,
className:"deg_settings_model_tab_drop",
"data-deg-model-tab-drop":String(page),
"aria-hidden":"true",
}));
}
const label=modelPageLabelOf(page);
const selected=page===currentModelPage;
const dragging=modelTabDrag?.active===true&&modelTabDrag.page===page;
modelTabChildren.push(react.createElement("div",{
key:"page-"+page,
ref:(node)=>{modelTabRefs.current[page]=node;},
className:"deg_settings_model_tab",
role:"tab",
tabIndex:selected?0:-1,
"aria-selected":selected,
"data-deg-model-tab":page,
"data-dragging":dragging?"true":void 0,
title:label,
onPointerDown:(event)=>beginModelTabDrag(page,event),
onClick:()=>selectModelPage(page),
onKeyDown:(event)=>{
if(event?.key!=="Enter"&&event?.key!==" ")return;
event.preventDefault?.();
selectModelPage(page);
},
},
react.createElement("span",{className:"deg_settings_model_tab_label"},label),
page===0?null:react.createElement("button",{
type:"button",
className:"deg_settings_model_tab_remove",
"data-deg-model-tab-remove":page,
"aria-label":label+" "+tExtra("settings.modelTabs.remove"),
disabled:saving||settingsReadOnly,
onPointerDown:(event)=>event?.stopPropagation?.(),
onClick:(event)=>{
event?.stopPropagation?.();
requestModelPageDelete(page);
},
},"×")));
}
if(modelTabDrag?.active===true&&modelTabDrag.dropIndex===modelPageCount){
modelTabChildren.push(react.createElement("span",{
key:"drop-end",
className:"deg_settings_model_tab_drop",
"data-deg-model-tab-drop":String(modelPageCount),
"aria-hidden":"true",
}));
}
modelTabChildren.push(react.createElement("button",{
key:"add-page",
type:"button",
className:"deg_settings_model_tab_add",
"data-deg-model-tab-add":"true",
"aria-label":tExtra("settings.modelTabs.add"),
title:modelPageCount>=MAX_MODEL_PAGES?tExtra("settings.modelTabs.limit"):tExtra("settings.modelTabs.add.title"),
disabled:saving||settingsReadOnly||modelPageCount>=MAX_MODEL_PAGES,
onClick:()=>addModelPage(),
},"+"));
const peakValleyState=view.peakValleyState??draft?.peakValley??{};
const peakValleyEnabled=peakValleyState.enabled===true;
const shownPeriod=view.livePeriod??view.mainPeriod;
const peakValleySuffix=peakValleyEnabled
?" "+tExtra(shownPeriod==="peak"?"settings.pv.peak":"settings.pv.valley")
:"";
const peakValleyEntryButton=peakValleyEntry===false?null:react.createElement("button",{
type:"button",
className:"deg_settings_model_tab deg_settings_peak_valley_entry"+(peakValleyEnabled?" deg_settings_peak_valley_entry_active":""),
"data-deg-peak-valley-entry":"true",
"data-enabled":peakValleyEnabled?"true":"false",
disabled:saving,
onClick:()=>openPeakValley(),
},tExtra("settings.pv.entry")+peakValleySuffix);
const periodToggleSlot=view.peakValleyOpen===true?renderPeakValleyPeriodToggle(view):null;
const modelTabRow=react.createElement("div",{
className:"deg_settings_model_tabs",
"data-deg-model-tabs":"true",
},
react.createElement("div",{
className:"deg_settings_model_tablist",
role:"tablist",
"aria-label":tExtra("settings.modelTabs.primary")+" / "+tExtra("settings.modelTabs.candidate",{index:MAX_MODEL_CANDIDATES_PER_ROLE}),
},modelTabChildren),
peakValleyEntryButton,
periodToggleSlot);
return modelTabRow;
}
function renderSettingsModelDeleteDialog(view){
const{
cancelModelPageDelete,confirmModelPageDelete,modelPageDeleteCancelRef,modelPageDeleteIntent,saving,tExtra,
}=view;
const modelPageDeleteDialog=modelPageDeleteIntent===null?null:react.createElement("div",{
className:"deg_prompt_dialog_backdrop",
onClick:()=>cancelModelPageDelete(),
},
react.createElement("div",{
className:"deg_prompt_dialog",
role:"dialog",
"aria-modal":"true",
"aria-label":tExtra("settings.modelTabs.remove.title"),
onClick:(event)=>event?.stopPropagation?.(),
onKeyDown:(event)=>{
if(event?.key==="Escape"){
event.preventDefault?.();
event.stopPropagation?.();
cancelModelPageDelete();
return;
}
if(event?.key!=="Tab")return;
trapDialogTabFocus(event);
},
},
react.createElement("h3",null,tExtra("settings.modelTabs.remove.title")),
react.createElement("p",null,tExtra("settings.modelTabs.remove.message",{index:modelPageDeleteIntent.page})),
react.createElement("div",{className:"deg_prompt_dialog_actions"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"cancel",
"data-deg-model-tab-delete-cancel":"true",
autoFocus:true,
ref:modelPageDeleteCancelRef,
disabled:saving,
onClick:()=>cancelModelPageDelete(),
},"取消"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-dialog-action":"confirm",
"data-deg-model-tab-delete-confirm":"true",
disabled:saving,
onClick:()=>confirmModelPageDelete(),
},"删除"))));
return modelPageDeleteDialog;
}
function renderPeakValleySettings(view){
const{
editPeakValley,error,hasUnsavedChanges,saved,saving,
setPeakValleyOpen,settingsReadOnly,t,tExtra,
}=view;
const state=view.peakValleyState??{};
const periods=Array.isArray(state.periods)?state.periods:[];
const broken=typeof state.invalidCode==="string";
const maxPeriods=peakValleyTime?.MAX_PEAK_VALLEY_PERIODS??3;
const check=peakValleyTime?.normalizePeakValleyPeriods?.(periods)??{ok:true};
const invalidMessage=check.ok!==true
?tExtra("settings.pv.invalid",{reason:check.reason})
:broken?tExtra("settings.pv.repairHint"):null;
const noValley=periods.length===0||peakValleyTime?.peakValleyPeriodsCoverFullDay?.(periods)===true;
const editPeriod=(index,field,value)=>editPeakValley((previous)=>({
...previous,
periods:previous.periods.map((entry,position)=>(position===index?{...entry,[field]:value}:entry)),
}));
const periodRows=periods.map((entry,index)=>react.createElement("div",{
key:"period-"+index,
className:"deg_settings_task_row",
"data-deg-peak-valley-period-row":String(index),
},
react.createElement("span",{className:"deg_settings_label"},String(index+1)+". "+tExtra("settings.pv.start")),
react.createElement("input",{
type:"time",
"aria-label":tExtra("settings.pv.start")+(index+1),
value:typeof entry?.start==="string"?entry.start:"",
disabled:saving||settingsReadOnly,
onClick:showTimePickerOf,
onChange:(event)=>editPeriod(index,"start",String(event?.target?.value??"")),
}),
react.createElement("span",{className:"deg_settings_label"},tExtra("settings.pv.end")),
react.createElement("input",{
type:"time",
"aria-label":tExtra("settings.pv.end")+(index+1),
value:typeof entry?.end==="string"?entry.end:"",
disabled:saving||settingsReadOnly,
onClick:showTimePickerOf,
onChange:(event)=>editPeriod(index,"end",String(event?.target?.value??"")),
}),
react.createElement("button",{
type:"button",
className:"deg_btn",
"aria-label":tExtra("settings.pv.remove.aria")+(index+1),
disabled:saving||settingsReadOnly,
onClick:()=>editPeakValley((previous)=>({
...previous,
periods:previous.periods.filter((unused,position)=>position!==index),
})),
},tExtra("settings.pv.remove"))));
const enabled=state.enabled===true;
const statePeriod=view.livePeriod??view.mainPeriod??view.peakValleyPeriod;
const stateBadge=enabled
?react.createElement("span",{
className:"deg_settings_peak_valley_state",
"data-deg-peak-valley-state":statePeriod==="valley"?"valley":"peak",
},tExtra(statePeriod==="valley"?"settings.pv.valley":"settings.pv.peak"))
:null;
return react.createElement("div",{className:"deg_settings","data-deg-peak-valley":"true"},
react.createElement("div",{className:"deg_prompt_footer"},
react.createElement("button",{
type:"button",
className:"deg_btn deg_prompt_back",
"aria-label":"返回模型设置",
disabled:saving,
onClick:()=>setPeakValleyOpen(false),
},"← "+tExtra("settings.pv.back")),
react.createElement("h2",{className:"deg_settings_title"},tExtra("settings.pv.entry")),
stateBadge),
state.initialized===true?null:react.createElement("p",{
className:"deg_settings_hint",
"data-deg-peak-valley-uninit":"true",
},tExtra("settings.pv.uninit")),
react.createElement("div",{className:"deg_settings_task_row"},
react.createElement("label",{className:"deg_settings_checkbox"},
react.createElement("input",{
type:"checkbox",
"aria-label":tExtra("settings.pv.enable"),
checked:enabled,
disabled:saving||settingsReadOnly,
onChange:(event)=>editPeakValley((previous)=>({...previous,enabled:event.target.checked===true})),
}),
react.createElement("span",{className:"deg_settings_label"},tExtra("settings.pv.enable")))),
react.createElement("div",{className:"deg_settings_peak_valley_periods","data-deg-peak-valley-periods":"true"},
react.createElement("div",{className:"deg_settings_task_row"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-peak-valley-add":"true",
disabled:saving||settingsReadOnly||periods.length>=maxPeriods,
onClick:()=>editPeakValley((previous)=>({
...previous,
periods:previous.periods.length>=maxPeriods
?previous.periods
:[...previous.periods,{...NEXT_PEAK_VALLEY_PERIOD}],
})),
},tExtra("settings.pv.add")),
noValley?react.createElement("p",{className:"deg_settings_hint",role:"status"},tExtra("settings.pv.noValley")):null),
react.createElement("div",{className:"deg_settings_peak_valley_period_list"},periodRows)),
renderSettingsUnifiedRow(view),
renderSettingsModelTabs(view),
renderSettingsRoleTable(view),
invalidMessage===null?null:react.createElement("p",{className:"deg_settings_error",role:"alert"},invalidMessage),
error?react.createElement("p",{className:"deg_settings_error",role:"status"},error):null,
renderSettingsModelDeleteDialog(view),
react.createElement("div",{className:"deg_settings_footer deg_settings_pv_footer"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-peak-valley-back":"true",
"aria-label":"返回模型设置",
disabled:saving,
onClick:()=>setPeakValleyOpen(false),
},tExtra("settings.pv.back")),
react.createElement("span",{className:"deg_settings_status",role:"status"},saved?t("settings.saved"):hasUnsavedChanges?t("settings.unsaved"):""),
broken
?react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-peak-valley-repair":"true",
disabled:saving||settingsReadOnly||check.ok!==true,
onClick:view.saveRepair,
},tExtra("settings.pv.repair"))
:null,
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-peak-valley-save":"true",
disabled:!hasUnsavedChanges||saving||settingsReadOnly||check.ok!==true||broken,
onClick:view.save,
},saving?t("settings.saving"):t("settings.save"))));
}
function renderSettingsTaskRow(view){
const{
draft,editDraft,saving,t,
}=view;
const taskRow=(
react.createElement("div",{className:"deg_settings_row deg_settings_task_row"},
react.createElement("label",{className:"deg_settings_checkbox"},
react.createElement("input",{
type:"checkbox",
"aria-label":t("settings.taskManagement"),
checked:draft.taskManagementEnabled,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,taskManagementEnabled:event.target.checked})),
}),
react.createElement("span",{className:"deg_settings_label"},t("settings.taskManagement"))),
react.createElement("label",{className:"deg_settings_checkbox",title:t("settings.autoTitle")},
react.createElement("input",{
type:"checkbox",
"aria-label":t("settings.auto"),
checked:draft.autoOpenSubagentSidebar,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,autoOpenSubagentSidebar:event.target.checked===true})),
}),
react.createElement("span",{className:"deg_settings_label"},t("settings.auto"))),
react.createElement("label",{className:"deg_settings_checkbox"},
react.createElement("input",{
type:"checkbox",
"aria-label":t("settings.sidebarEntry"),
checked:draft.sidebarEntryEnabled,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,sidebarEntryEnabled:event.target.checked})),
}),
react.createElement("span",{className:"deg_settings_label"},t("settings.sidebarEntry"))))
);
return taskRow;
}
function renderSettingsNotificationRow(view){
const{
draft,editDraft,notificationEventsOpen,notificationEventsPanelRef,notificationEventsRootRef,notificationEventsTriggerRef,
saving,setNotificationEventsOpen,t,
}=view;
const notificationEventsEnabledCount=NOTIFICATION_EVENT_TYPES.filter(
(type)=>draft.notificationEvents[type]===true,
).length;
const notificationEventsTriggerLabel=t("settings.notificationEvents")+" ("+notificationEventsEnabledCount+")";
const notificationRow=(
react.createElement("div",{className:"deg_settings_row deg_settings_notification_row"},
react.createElement("label",{className:"deg_settings_checkbox"},
react.createElement("input",{
type:"checkbox",
checked:draft.notificationEnabled,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,notificationEnabled:event.target.checked})),
}),
react.createElement("span",{className:"deg_settings_label"},t("settings.notifications"))),
react.createElement("div",{className:"deg_settings_control"},
react.createElement("span",{className:"deg_settings_label"},t("settings.notificationVolume")),
react.createElement("input",{
id:"deg-settings-notification-volume-range",
type:"range",min:0,max:100,step:1,
"aria-label":t("settings.notificationVolume.range"),
value:draft.notificationVolume,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,notificationVolume:clampNotificationVolume(event.target.value)})),
}),
react.createElement("input",{
id:"deg-settings-notification-volume-number",
type:"number",min:0,max:100,step:1,
"aria-label":t("settings.notificationVolume.number"),
value:draft.notificationVolume,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({...previous,notificationVolume:clampNotificationVolume(event.target.value)})),
})),
react.createElement("div",{className:"deg_settings_events_dropdown",ref:notificationEventsRootRef},
react.createElement("button",{
type:"button",
className:"deg_settings_events_trigger",
id:"deg-settings-notification-events-trigger",
ref:notificationEventsTriggerRef,
"aria-label":notificationEventsTriggerLabel,
"aria-haspopup":"true",
"aria-expanded":notificationEventsOpen?"true":"false",
"aria-controls":"deg-settings-notification-events-panel",
disabled:saving,
onClick:()=>setNotificationEventsOpen((previous)=>!previous),
},
react.createElement("span",{className:"deg_settings_events_label"},t("settings.notificationEvents")),
react.createElement("span",{className:"deg_settings_events_count","aria-hidden":"true"},"("+notificationEventsEnabledCount+")"),
react.createElement("span",{className:"deg_settings_events_caret","aria-hidden":"true"},"▾")),
notificationEventsOpen
?react.createElement("div",{
className:"deg_settings_events_panel",
id:"deg-settings-notification-events-panel",
ref:notificationEventsPanelRef,
role:"group",
"aria-label":t("settings.notificationEvents"),
},NOTIFICATION_EVENT_TYPES.map((type)=>react.createElement("label",{key:type,className:"deg_settings_checkbox"},
react.createElement("input",{
type:"checkbox",
"aria-label":t("settings.notificationEvent."+type+".aria"),
checked:draft.notificationEvents[type]===true,
disabled:saving,
onChange:(event)=>editDraft((previous)=>({
...previous,
notificationEvents:{...previous.notificationEvents,[type]:event.target.checked===true},
})),
}),
react.createElement("span",{className:"deg_settings_label"},t("settings.notificationEvent."+type)))))
:null))
);
return notificationRow;
}
function renderSettingsUnifiedRow(view){
const{
catalogAvailable,currentModelPage,draft,editDraft,providerGroups,roles,
saving,settingsReadOnly,t,tExtra,unifiedProvider,
}=view;
const fallbackLimitDraft=Number.isSafeInteger(draft.fallbackLimit)?draft.fallbackLimit:DEFAULT_MODEL_FALLBACK_LIMIT;
const unifiedRow=(
react.createElement("div",{className:"deg_settings_row deg_settings_unified_row"},
react.createElement("div",{className:"deg_settings_provider_group"},
react.createElement("label",{className:"deg_settings_label",htmlFor:"deg-settings-provider"},t("settings.unifiedProvider")),
react.createElement("div",{className:"deg_settings_control"},
react.createElement("select",{
id:"deg-settings-provider",
className:"deg_settings_provider_select",
value:unifiedProvider,
disabled:saving||!catalogAvailable,
onChange:(event)=>editDraft((previous)=>{
const provider=event.target.value;
if(currentModelPage!==0){
if(!provider)return previous;
let next=previous;
for(const role of settingsRolesForProvider(roles)){
const current=modelLayerSelectionOf(next,role,currentModelPage);
const migrated=migrateSettingsSelection(current,provider,providerGroups)??{provider,model:""};
next=setModelLayerSelection(next,role,currentModelPage,migrated);
}
return next;
}
if(!provider){
const hasVisibleProvider=settingsRolesForProvider(roles).some((role)=>{
const value=previous.defaults?.[role]?.provider;
return typeof value==="string"&&value.length>0;
});
return hasVisibleProvider?{...previous,provider:""}:previous;
}
return{
...previous,
provider,
defaults:syncSettingsDefaultsProvider(previous.defaults,provider,providerGroups,roles),
};
}),
},
react.createElement("option",{value:""},t("settings.noProvider")),
providerGroups.map((group)=>react.createElement("option",{key:group.id,value:group.id},group.name??group.id))))),
react.createElement("div",{className:"deg_settings_fallback_group"},
react.createElement("label",{className:"deg_settings_label",htmlFor:"deg-settings-model-fallback-limit"},tExtra("settings.modelCandidates.fallbackLimit")),
react.createElement("div",{className:"deg_settings_control"},
react.createElement("input",{
id:"deg-settings-model-fallback-limit",
type:"number",min:0,max:MAX_MODEL_FALLBACK_LIMIT,step:1,inputMode:"numeric",
"aria-label":tExtra("settings.modelCandidates.fallbackLimit"),
title:tExtra("settings.modelCandidates.fallbackLimit.title"),
value:draft.fallbackLimit===void 0?fallbackLimitDraft:draft.fallbackLimit,
disabled:saving||settingsReadOnly,
onChange:(event)=>{
const raw=event.target.value;
const number=raw===""?null:Number(raw);
editDraft((previous)=>({...previous,fallbackLimit:raw===""?"":Number.isFinite(number)?Math.round(number):previous.fallbackLimit}));
},
}))))
);
return unifiedRow;
}
function renderSettingsManagementRow(view){
const{
draft,editDraft,saving,t,
}=view;
const managementRow=(
react.createElement("div",{className:"deg_settings_row deg_settings_management_row"},
react.createElement("label",{className:"deg_settings_checkbox"},
react.createElement("input",{type:"checkbox","aria-label":t("settings.observerPreferred"),checked:draft.observerPreferred,disabled:saving,onChange:(event)=>editDraft((previous)=>({...previous,observerPreferred:event.target.checked}))}),
react.createElement("span",{className:"deg_settings_label"},t("settings.observerPreferred"))),
react.createElement("label",{className:"deg_settings_control",htmlFor:"deg-settings-role-concurrency-limit"},
react.createElement("span",{className:"deg_settings_label"},t("settings.concurrencyLimit")),
react.createElement("input",{
id:"deg-settings-role-concurrency-limit",
type:"number",
"aria-label":t("settings.concurrencyLimit"),
title:t("settings.concurrencyLimit.title"),
min:1,
max:64,
step:1,
inputMode:"numeric",
value:draft.roleConcurrencyLimit,
disabled:saving,
onChange:(event)=>{
const raw=event.target.value;
const number=raw===""?null:Number(raw);
editDraft((previous)=>({
...previous,
roleConcurrencyLimit:raw===""
?""
:Number.isFinite(number)?number:previous.roleConcurrencyLimit,
}));
},
})),
react.createElement("label",{className:"deg_settings_control",htmlFor:"deg-settings-role-timeout-ms"},
react.createElement("span",{className:"deg_settings_label"},t("settings.roleTimeout")),
react.createElement("input",{
id:"deg-settings-role-timeout-ms",
type:"number",
"aria-label":t("settings.roleTimeout.aria"),
title:t("settings.roleTimeout.title"),
min:0,
max:86400,
step:1,
inputMode:"numeric",
value:draft.roleTimeoutMs===""?"":draft.roleTimeoutMs/1000,
disabled:saving,
onChange:(event)=>{
const raw=event.target.value;
const seconds=raw===""?null:Number(raw);
editDraft((previous)=>({
...previous,
roleTimeoutMs:raw===""
?""
:Number.isFinite(seconds)?Math.round(seconds)*1000:previous.roleTimeoutMs,
}));
},
})))
);
return managementRow;
}
function periodLabelOf(view,period){
return view.tExtra(period==="peak"?"settings.pv.peak":"settings.pv.valley");
}
function mainPeriodScopeOf(view,mainPeriod){
if(mainPeriod===null||mainPeriod===void 0)return null;
return" "+view.tExtra("settings.pv.mainScope",{period:periodLabelOf(view,mainPeriod)});
}
function renderMainPeriodHint(view,mainPeriod){
const{livePeriod}=view;
if(mainPeriod===null||mainPeriod===void 0)return null;
if(livePeriod===null||livePeriod===void 0||livePeriod===mainPeriod)return null;
return react.createElement("p",{
className:"deg_settings_hint",
role:"status",
"data-deg-main-period-hint":"true",
},view.tExtra("settings.pv.boundary",{
current:periodLabelOf(view,livePeriod),
editing:periodLabelOf(view,mainPeriod),
}));
}
function renderSettingsBody(view,actions){
const{
candidatesError,catalogAvailable,directoryState,draft,error,hasUnsavedChanges,modelConfigHost,modelFieldsChanged,
roleLabelOf,roles,save,saved,saving,settingsSnapshot,t,
}=view;
const modelConfigSection=typeof modelConfigHost==="undefined"||modelConfigHost===null
?null
:react.createElement(ModelConfigSection,{
host:modelConfigHost,
roleDefaults:normalizeSettingsDraft(settingsSnapshot.value,roles).defaults,
roleLabelOf,
defaultOpen:view.modelConfigDefaultOpen===true,
});
const lockedPeriod=view.mainPeriod===void 0?null:view.mainPeriod;
const mainPeriod=lockedPeriod!==null&&draft?.peakValley?.enabled===true?lockedPeriod:null;
const modelView=mainPeriod===null
?view
:view.peakValleyViewOf({...view,peakValleyPeriod:mainPeriod,peakValleyEntry:true});
const modelTabRow=renderSettingsModelTabs(modelView);
const modelPageDeleteDialog=renderSettingsModelDeleteDialog(modelView);
return react.createElement("div",{className:"deg_settings"},
react.createElement("h2",{className:"deg_settings_title"},t("settings.title")),
react.createElement("p",{
className:"deg_settings_hint",
...(mainPeriod===null?{}:{"data-deg-main-period":mainPeriod}),
},t("settings.hint"),mainPeriodScopeOf(view,mainPeriod)),
renderMainPeriodHint(view,mainPeriod),
view.peakValleyBroken
?react.createElement("p",{className:"deg_settings_error"},view.tExtra("settings.pv.broken"))
:null,
mainPeriod===null?modelConfigSection:null,
renderSettingsTaskRow(view),
renderSettingsNotificationRow(view),
renderSettingsUnifiedRow(modelView),
modelTabRow,
renderSettingsRoleTable(modelView),
renderSettingsManagementRow(view),
candidatesError===null||candidatesError===void 0?null:react.createElement("p",{
className:"deg_settings_error",
role:"alert",
"data-deg-model-candidates-error":"true",
},candidatesError),
directoryState.error?react.createElement("p",{className:"deg_settings_error",role:"status"},directoryState.error):null,
error?react.createElement("p",{className:"deg_settings_error",role:"status"},error):null,
modelPageDeleteDialog,
react.createElement("div",{className:"deg_settings_footer"},
react.createElement("span",{className:"deg_settings_status",role:"status"},saved?t("settings.saved"):hasUnsavedChanges?t("settings.unsaved"):""),
react.createElement("button",{type:"button",className:"deg_btn",disabled:!hasUnsavedChanges||saving,onClick:actions.discard},t("settings.discard")),
react.createElement("button",{type:"button",className:"deg_btn",disabled:!hasUnsavedChanges||saving||(modelFieldsChanged&&!catalogAvailable)||settingsSnapshot.writable!==true,onClick:save},saving?t("settings.saving"):t("settings.save"))));
}
global[SYMBOL]=Object.freeze({
bindClientRuntime,renderSettingsTail,
});
})(globalThis);
/* source: client-settings-main-a.js */
(function installClientSettingsMainA(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-settings-main-a");
const clientTextSymbol=Symbol.for("dsh-expert-group/client-text");
const clientText=global[clientTextSymbol]||{};
const clientSettingsNormalizeSymbol=Symbol.for("dsh-expert-group/client-settings-normalize");
const clientSettingsNormalize=global[clientSettingsNormalizeSymbol]||{};
const clientSettingsMainBSymbol=Symbol.for("dsh-expert-group/client-settings-main-b");
const clientSettingsMainB=global[clientSettingsMainBSymbol]||{};
const{
resolveSettingsLocale,settingsExtraText,settingsText,
}=clientText;
const{
DEFAULT_MODEL_FALLBACK_LIMIT,DEFAULT_PEAK_VALLEY_PERIODS,DEFAULT_PROMPT_MAX_GRAPHEMES,MAX_MODEL_PAGES,ORCHESTRATOR_ID,PROMPT_ROLE_IDS,SETTINGS_ROLE_LABELS,addModelCandidatePage,
commitSettingsCandidate,compactModelCandidatesDraft,compactOrchestratorDraft,mergeSettingsDraftOverSource,modelCandidatesErrorMessage,modelLayerMapOf,modelPageCountOf,
normalizeModelCandidatesDraft,normalizePeakValleyDraft,normalizePromptOverrides,normalizeRolePromptProjection,normalizeSettingsCommitDraft,normalizeSettingsDraft,promptEntryOf,
promptOverridesEqual,removeModelCandidatePage,reorderModelLayers,settingsDraftEqual,unifiedProviderOf,updateRolePromptProjection,
useEnabledSettingsRoles,useHostMeta,validateModelCandidateRows,validatePromptText,
}=clientSettingsNormalize;
const{
renderSettingsTail,
}=clientSettingsMainB;
let react=null;
let peakValleyTime=null;
function bindClientRuntime(host){
react=host.react??null;
peakValleyTime=host.peakValleyTime??null;
}
function useSettingsLeaveFocus(view){
react.useEffect(()=>{
if(view.leaveIntent===null)return;
try{view.leaveCancelRef.current?.focus?.();}catch{}
},[view.leaveIntent]);
}
function emptyPeakValleyDraft(){
return{
enabled:false,
initialized:false,
periods:JSON.parse(JSON.stringify(DEFAULT_PEAK_VALLEY_PERIODS)),
peak:{provider:"",defaults:{},candidates:{},fallbackLimit:DEFAULT_MODEL_FALLBACK_LIMIT},
valley:{provider:"",defaults:{},candidates:{},fallbackLimit:DEFAULT_MODEL_FALLBACK_LIMIT},
};
}
function peakValleyViewOf(view){
const{draft,editDraft,peakValleyPages,peakValleyPeriod,roles,setPeakValleyPages}=view;
const state=draft.peakValley??emptyPeakValleyDraft();
const profile=state[peakValleyPeriod]??emptyPeakValleyDraft()[peakValleyPeriod];
const modelPageCount=modelPageCountOf(profile);
const pages=peakValleyPages??{};
const sub={
...view,
currentModelPage:Math.min(pages[peakValleyPeriod]??0,modelPageCount-1),
draft:profile,
modelPageCount,
peakValleyEntry:view.peakValleyEntry===true,
peakValleyState:state,
unifiedProvider:unifiedProviderOf(profile.defaults,roles,profile.provider),
};
sub.editDraft=(update)=>editDraft((previous)=>{
const previousState=previous.peakValley??emptyPeakValleyDraft();
const previousProfile=previousState[peakValleyPeriod]??emptyPeakValleyDraft()[peakValleyPeriod];
const nextProfile=update(previousProfile);
return nextProfile===previousProfile
?previous
:{...previous,peakValley:{...previousState,[peakValleyPeriod]:nextProfile}};
});
sub.editPeakValley=(update)=>editDraft((previous)=>({
...previous,
peakValley:update(previous.peakValley??emptyPeakValleyDraft()),
}));
sub.setSelectedModelPage=(next)=>setPeakValleyPages((previous)=>({
...previous,
[peakValleyPeriod]:typeof next==="function"?next(previous?.[peakValleyPeriod]??0):next,
}));
Object.assign(sub,createModelPageActions(sub),createModelTabDragController(sub));
return sub;
}
function openPeakValleyActionOf(view){
return()=>{
const state=view.draft?.peakValley;
const period=state?.enabled===true
?samplePeakValleyPeriod(Array.isArray(state.periods)?state.periods:[])
:"peak";
view.setPeakValleyPeriod(period);
view.setPeakValleyOpen(true);
};
}
function mainEditingPeriodOf(value){
const state=value?.peakValley;
if(state?.enabled!==true)return null;
return samplePeakValleyPeriod(Array.isArray(state.periods)?state.periods:[]);
}
function samplePeakValleyPeriod(periods){
return peakValleyTime?.peakValleyAtDate?.(periods,new Date())==="peak"?"peak":"valley";
}
function startPeriodSampler(periodsRef,setLivePeriod){
return globalThis.setInterval?.(()=>setLivePeriod(samplePeakValleyPeriod(periodsRef.current)),60000);
}
function stopPeriodSampler(timer){
return()=>{if(timer!==void 0)globalThis.clearInterval?.(timer);};
}
function peakValleyCandidateOf(state,repair){
const profileOf=(profile)=>{
const value=profile!==null&&typeof profile==="object"?profile:{};
return{
provider:typeof value.provider==="string"?value.provider:"",
defaults:value.defaults??{},
candidates:compactModelCandidatesDraft(value.candidates),
fallbackLimit:value.fallbackLimit===void 0?DEFAULT_MODEL_FALLBACK_LIMIT:value.fallbackLimit,
orchestrator:compactOrchestratorDraft(value.orchestrator),
};
};
return{
enabled:state?.enabled===true,
periods:Array.isArray(state?.periods)?state.periods:[],
peak:profileOf(state?.peak),
valley:profileOf(state?.valley),
...(repair===true?{repair}:{}),
};
}
function repairSaveActionOf(view){
return()=>view.save({repair:true});
}
function createSettingsSaveAction(view){
return async({retry=false,repair=false}={})=>{
const plan=deriveSettingsSavePlan(view,retry,repair);
if(plan===null)return false;
return commitSettingsSavePlan(view,plan);
};
}
function pushScalarChangeOps(ops,candidate,source,promptChanged,candidatePromptOverrides){
if(candidate.notificationEnabled!==source.notificationEnabled){
ops.push({op:"set",path:["notificationEnabled"],value:candidate.notificationEnabled});
}
if(candidate.notificationVolume!==source.notificationVolume){
ops.push({op:"set",path:["notificationVolume"],value:candidate.notificationVolume});
}
if(!settingsDraftEqual(candidate.notificationEvents,source.notificationEvents)){
ops.push({op:"set",path:["notificationEvents"],value:candidate.notificationEvents});
}
if(candidate.observerPreferred!==source.observerPreferred){
ops.push({op:"set",path:["observerPreferred"],value:candidate.observerPreferred});
}
if(candidate.roleConcurrencyLimit!==source.roleConcurrencyLimit){
ops.push({op:"set",path:["roleConcurrencyLimit"],value:candidate.roleConcurrencyLimit});
}
if(candidate.roleTimeoutMs!==source.roleTimeoutMs){
ops.push({op:"set",path:["roleTimeoutMs"],value:candidate.roleTimeoutMs});
}
if(candidate.taskManagementEnabled!==source.taskManagementEnabled){
ops.push({op:"set",path:["taskManagementEnabled"],value:candidate.taskManagementEnabled});
}
if(candidate.autoOpenSubagentSidebar!==source.autoOpenSubagentSidebar){
ops.push({op:"set",path:["autoOpenSubagentSidebar"],value:candidate.autoOpenSubagentSidebar});
}
if(candidate.sidebarEntryEnabled!==source.sidebarEntryEnabled){
ops.push({op:"set",path:["sidebarEntryEnabled"],value:candidate.sidebarEntryEnabled});
}
if(promptChanged){
ops.push({op:"set",path:["promptOverrides"],value:candidatePromptOverrides});
}
}
function orchestratorSaveChangeOf(authorityValue,normalizedDraft,tExtra,roleLabelOf,setCandidatesError){
const source=compactOrchestratorDraft(authorityValue?.orchestrator);
const candidate=compactOrchestratorDraft(normalizedDraft.orchestrator);
if(settingsDraftEqual(candidate,source))return{candidate,changed:false,source};
const validation=validateModelCandidateRows({Orchestrator:candidate.candidates});
if(validation.ok!==true){
setCandidatesError(modelCandidatesErrorMessage(tExtra,roleLabelOf,validation));
return null;
}
return{candidate,changed:true,source};
}
function peakValleySaveChangeOf(normalizedDraft,source,peakValleyBroken,repairing,tExtra,setError){
const candidate=normalizedDraft.peakValley===void 0||(peakValleyBroken&&!repairing)
?void 0
:peakValleyCandidateOf(normalizedDraft.peakValley,repairing);
if(candidate===void 0)return{candidate,changed:repairing};
if(repairing!==true
&&settingsDraftEqual(candidate,peakValleyCandidateOf(normalizePeakValleyDraft(source.peakValley)))){
return{candidate,changed:false};
}
const periods=peakValleyTime?.normalizePeakValleyPeriods?.(candidate.periods);
if(periods?.ok!==true){
setError(tExtra("settings.pv.invalid",{reason:periods?.reason??""}));
return null;
}
return{candidate,changed:true};
}
function deriveSettingsSavePlan(view,retry,repair){
const{
addModelPage,applyPromptNavigation,authorityValue,baselineProjection,beginModelTabDrag,cancelModelPageDelete,ctx,
candidatesError,catalogAvailable,closePrompt,committedAuthorityRef,committedSnapshotLagging,confirmModelPageDelete,
currentModelPage,directoryState,dismissLeaveDialog,draft,editDraft,editPromptText,
error,externalSettingsChanged,hasUnsavedChanges,hostMeta,hostMetaError,leaveCancelRef,
leaveIntent,leaveTriggerRef,modelConfigHost,modelFieldsChanged,modelPageCount,modelPageDeleteCancelRef,
modelPageDeleteIntent,modelPageLabelOf,modelRowRoles,modelTabDrag,modelTabRefs,notificationEventsOpen,
notificationEventsPanelRef,notificationEventsRootRef,notificationEventsTriggerRef,openPrompt,promptDirty,promptError,
promptLoading,promptMaxGraphemes,promptProjection,promptRoleIds,promptTextOf,providerGroups,
refreshHostMeta,requestModelPageDelete,roleLabelOf,roles,save,saved,
saving,selectModelPage,selectedPromptRole,setCandidatesError,setDirty,setDraft,
setEditorBaseline,setError,setExternalSettingsChanged,setLeaveIntent,setLocalPromptProjection,setNotificationEventsOpen,
setPromptDrafts,setPromptError,setPromptTouched,setSaved,setSettingsConflict,settingsConflict,
settingsForm,settingsReadOnly,settingsSnapshot,sourceDraftForSave,sourcePromptOverrides,t,tExtra,unifiedProvider,
effectiveDraft,editorBaseline,promptTouchedRoles,setSaving,
}=view;
const peakValleyBroken=typeof authorityValue?.peakValley?.invalidCode==="string";
const repairing=repair===true&&peakValleyBroken;
if((!hasUnsavedChanges&&!repairing)||saving||settingsSnapshot.writable!==true)return null;
if(modelFieldsChanged&&!catalogAvailable)return null;
const source=sourceDraftForSave;
const normalizedDraft=effectiveDraft;
const sourceProvider=unifiedProviderOf(source.defaults,roles,source.provider);
const draftProviderIntent=typeof effectiveDraft.provider==="string"?effectiveDraft.provider:"";
const draftProvider=unifiedProviderOf(normalizedDraft.defaults,roles,draftProviderIntent);
const modelChanged=modelFieldsChanged&&catalogAvailable;
const candidatePromptOverrides={...sourcePromptOverrides};
if(promptTouchedRoles.length>0){
if(promptProjection===null){
setPromptError(hostMetaError??"提示词配置加载中，请稍后重试");
return null;
}
if(promptProjection.customizable!==true){
setPromptError("当前提示词设置为只读");
return null;
}
for(const role of promptTouchedRoles){
const entry=promptEntryOf(baselineProjection,role);
const text=promptTextOf(role);
const validation=validatePromptText(text,promptMaxGraphemes);
if(!validation.ok){
setPromptError(roleLabelOf(role)+"："+validation.message);
return null;
}
if(entry===null||typeof entry.defaultPersona!=="string"){
setPromptError("提示词默认配置不可用，请刷新后重试");
return null;
}
if(text===entry.defaultPersona)delete candidatePromptOverrides[role];
else candidatePromptOverrides[role]=text;
}
}
const sourceHasPromptOverrides=authorityValue!==null&&authorityValue!==void 0
&&typeof authorityValue==="object"
&&Object.prototype.hasOwnProperty.call(authorityValue,"promptOverrides");
const promptChanged=!promptOverridesEqual(candidatePromptOverrides,sourcePromptOverrides);
const includePromptOverrides=sourceHasPromptOverrides||promptTouchedRoles.length>0;
const sourceCandidates=normalizeModelCandidatesDraft(authorityValue?.candidates);
const candidateCandidates=compactModelCandidatesDraft(normalizeModelCandidatesDraft(normalizedDraft.candidates));
const candidatesChanged=!settingsDraftEqual(candidateCandidates,sourceCandidates);
if(candidatesChanged){
const validation=validateModelCandidateRows(candidateCandidates);
if(validation.ok!==true){setCandidatesError(modelCandidatesErrorMessage(tExtra,roleLabelOf,validation));return null;}
}
const sourceFallbackLimit=source.fallbackLimit;
const candidateFallbackLimit=normalizedDraft.fallbackLimit;
const fallbackLimitChanged=candidateFallbackLimit!==void 0&&candidateFallbackLimit!==sourceFallbackLimit;
const orchestratorChange=orchestratorSaveChangeOf(authorityValue,normalizedDraft,tExtra,roleLabelOf,setCandidatesError);
if(orchestratorChange===null)return null;
const{candidate:candidateOrchestrator,changed:orchestratorChanged,source:sourceOrchestrator}=orchestratorChange;
const peakValleyChange=peakValleySaveChangeOf(normalizedDraft,source,peakValleyBroken,repairing,tExtra,setError);
if(peakValleyChange===null)return null;
const{candidate:candidatePeakValley,changed:peakValleyChanged}=peakValleyChange;
const candidate={
...normalizedDraft,
provider:modelChanged?draftProvider:sourceProvider,
...(modelChanged?{}:{defaults:source.defaults}),
...(includePromptOverrides?{promptOverrides:candidatePromptOverrides}:{}),
...(candidatesChanged?{candidates:candidateCandidates}:{}),
...(fallbackLimitChanged
?{fallbackLimit:typeof candidateFallbackLimit==="number"?candidateFallbackLimit:DEFAULT_MODEL_FALLBACK_LIMIT}
:{}),
...(orchestratorChanged?{orchestrator:candidateOrchestrator}:{}),
...(peakValleyChanged?{peakValley:candidatePeakValley}:{}),
};
if(!candidatesChanged)delete candidate.candidates;
if(!fallbackLimitChanged)delete candidate.fallbackLimit;
if(!orchestratorChanged)delete candidate.orchestrator;
if(!peakValleyChanged)delete candidate.peakValley;
const ops=[];
if(modelChanged){
ops.push({op:"set",path:["provider"],value:candidate.provider});
ops.push({op:"set",path:["defaults"],value:candidate.defaults});
}
pushScalarChangeOps(ops,candidate,source,promptChanged,candidatePromptOverrides);
const changed=[];
if(modelChanged){
if(candidate.provider!==sourceProvider)changed.push("provider");
for(const role of Object.keys(candidate.defaults)){
if(!settingsDraftEqual(candidate.defaults[role],source.defaults[role]))changed.push("defaults."+role);
}
for(const role of Object.keys(source.defaults)){
if(!Object.prototype.hasOwnProperty.call(candidate.defaults,role))changed.push("defaults."+role);
}
}
for(const op of ops){
const field=op.path[0];
if(field==="defaults"||field==="provider")continue;
changed.push(field);
}
if(candidatesChanged){
changed.push("candidates");
for(const role of new Set([...Object.keys(candidateCandidates),...Object.keys(sourceCandidates)])){
if(!settingsDraftEqual(candidateCandidates[role]??null,sourceCandidates[role]??null))changed.push("candidates."+role);
}
}
if(fallbackLimitChanged)changed.push("fallbackLimit");
if(orchestratorChanged)changed.push("orchestrator");
if(peakValleyChanged)changed.push("peakValley","peakValley.enabled","peakValley.periods");
if(peakValleyBroken&&!repairing&&ops.length===0
&&!candidatesChanged&&!fallbackLimitChanged&&!orchestratorChanged){
setError(tExtra("settings.pv.broken"));
return null;
}
const expectedRevision=retry===true||selectedPromptRole===null||!Number.isSafeInteger(editorBaseline?.revision)
?settingsSnapshot.revision
:editorBaseline.revision;
return{
candidate,candidateCandidates,candidateFallbackLimit,candidateOrchestrator,candidatePromptOverrides,
candidatesChanged,changed,expectedRevision,fallbackLimitChanged,ops,orchestratorChanged,
peakValleyChanged,source,sourceCandidates,sourceFallbackLimit,sourceOrchestrator,
};
}
async function commitSettingsSavePlan(view,plan){
const{
addModelPage,applyPromptNavigation,authorityValue,baselineProjection,beginModelTabDrag,cancelModelPageDelete,
candidatesError,catalogAvailable,closePrompt,committedAuthorityRef,committedSnapshotLagging,confirmModelPageDelete,
currentModelPage,directoryState,dismissLeaveDialog,draft,editDraft,editPromptText,
error,externalSettingsChanged,hasUnsavedChanges,hostMeta,hostMetaError,leaveCancelRef,
leaveIntent,leaveTriggerRef,modelConfigHost,modelFieldsChanged,modelPageCount,modelPageDeleteCancelRef,
modelPageDeleteIntent,modelPageLabelOf,modelRowRoles,modelTabDrag,modelTabRefs,notificationEventsOpen,
notificationEventsPanelRef,notificationEventsRootRef,notificationEventsTriggerRef,openPrompt,promptDirty,promptError,
promptLoading,promptMaxGraphemes,promptProjection,promptRoleIds,promptTextOf,providerGroups,
refreshHostMeta,requestModelPageDelete,roleLabelOf,roles,save,saved,
saving,selectModelPage,selectedPromptRole,setCandidatesError,setDirty,setDraft,
setEditorBaseline,setError,setExternalSettingsChanged,setLeaveIntent,setLocalPromptProjection,setNotificationEventsOpen,
setPromptDrafts,setPromptError,setPromptTouched,setSaved,setSettingsConflict,settingsConflict,
settingsForm,settingsReadOnly,settingsSnapshot,sourceDraftForSave,sourcePromptOverrides,t,tExtra,unifiedProvider,
ctx,effectiveDraft,editorBaseline,promptTouchedRoles,setSaving,
}=view;
const{
candidate,candidateCandidates,candidateFallbackLimit,candidateOrchestrator,candidatePromptOverrides,
candidatesChanged,changed,expectedRevision,fallbackLimitChanged,ops,orchestratorChanged,
peakValleyChanged,source,sourceCandidates,sourceFallbackLimit,sourceOrchestrator,
}=plan;
setSaving(true);
setSaved(false);
setError(null);
setPromptError(null);
try{
let accepted;
let committed=null;
if(ops.length>0||candidatesChanged||fallbackLimitChanged||peakValleyChanged||orchestratorChanged){
committed=await commitSettingsCandidate(candidate,expectedRevision,globalThis.fetch,ctx?.connection,roles,changed);
accepted=committed.settings;
}else{
accepted=normalizeSettingsCommitDraft(settingsForm.getSnapshot().value,roles);
}
const acceptedPromptOverrides=normalizePromptOverrides(
Object.prototype.hasOwnProperty.call(accepted??{},"promptOverrides")
?{...candidatePromptOverrides,...accepted.promptOverrides}
:candidatePromptOverrides,
promptMaxGraphemes,
promptRoleIds,
);
const acceptedDraft=accepted!==null&&typeof accepted==="object"?{...accepted}:accepted;
if(acceptedDraft!==null&&typeof acceptedDraft==="object"){
const keepNewField=(field,hadField,value)=>{
if(Object.prototype.hasOwnProperty.call(acceptedDraft,field))return;
if(hadField!==true)return;
acceptedDraft[field]=value;
};
keepNewField("candidates",
candidatesChanged||Object.prototype.hasOwnProperty.call(source,"candidates"),
candidatesChanged?candidateCandidates:sourceCandidates);
keepNewField("fallbackLimit",
fallbackLimitChanged||Object.prototype.hasOwnProperty.call(source,"fallbackLimit"),
fallbackLimitChanged
?(typeof candidateFallbackLimit==="number"?candidateFallbackLimit:DEFAULT_MODEL_FALLBACK_LIMIT)
:sourceFallbackLimit);
keepNewField("orchestrator",
orchestratorChanged||Object.prototype.hasOwnProperty.call(source,"orchestrator"),
orchestratorChanged?candidateOrchestrator:sourceOrchestrator);
keepNewField("peakValley",Object.prototype.hasOwnProperty.call(source,"peakValley"),source.peakValley);
}
setDraft(acceptedDraft);
setPromptDrafts({});
setPromptTouched({});
setCandidatesError(null);
const committedRevision=Number.isSafeInteger(committed?.revision)
?committed.revision
:settingsSnapshot.revision;
committedAuthorityRef.current={revision:committedRevision,value:acceptedDraft};
const responseProjection=normalizeRolePromptProjection(committed?.rolePrompts,accepted,true,promptRoleIds);
let acceptedProjection=responseProjection??promptProjection;
if(acceptedProjection!==null){
for(const role of promptTouchedRoles){
const entry=promptEntryOf(acceptedProjection,role);
const text=Object.prototype.hasOwnProperty.call(acceptedPromptOverrides,role)
?acceptedPromptOverrides[role]
:entry?.defaultPersona??promptTextOf(role);
acceptedProjection=updateRolePromptProjection(acceptedProjection,role,text);
}
setLocalPromptProjection({revision:committedRevision,projection:acceptedProjection});
}
if(selectedPromptRole!==null){
setEditorBaseline({
role:selectedPromptRole,
value:acceptedDraft,
revision:committedRevision,
projection:acceptedProjection??editorBaseline?.projection??null,
});
}
setSettingsConflict(null);
setExternalSettingsChanged(false);
setDirty(false);
setSaved(true);
return true;
}catch(cause){
const message=cause instanceof Error?cause.message:String(cause);
setError(message);
if(cause?.code==="settings-conflict"){
setSettingsConflict({revision:cause.currentRevision,message});
}
if(promptTouchedRoles.length>0)setPromptError(message);
return false;
}finally{
setSaving(false);
}
}
function createModelPageActions(view){
const{
editDraft,MAX_MODEL_PAGES,modelPageCount,modelPageDeleteIntent,modelTabSuppressClickRef,saving,
setModelPageDeleteIntent,setSelectedModelPage,settingsReadOnly,
}=view;
const selectModelPage=(page)=>{
if(modelTabSuppressClickRef.current===true)return;
if(!Number.isSafeInteger(page)||page<0||page>=modelPageCount)return;
setSelectedModelPage(page);
};
const addModelPage=()=>{
if(saving||settingsReadOnly||modelPageCount>=MAX_MODEL_PAGES)return;
const nextIndex=modelPageCount;
editDraft((previous)=>addModelCandidatePage(previous));
setSelectedModelPage(nextIndex);
};
const requestModelPageDelete=(page)=>{
if(saving||settingsReadOnly||!Number.isSafeInteger(page)||page<1)return;
setModelPageDeleteIntent({page});
};
const cancelModelPageDelete=()=>{
setModelPageDeleteIntent(null);
};
const confirmModelPageDelete=()=>{
const intent=modelPageDeleteIntent;
if(intent===null)return;
setModelPageDeleteIntent(null);
editDraft((previous)=>removeModelCandidatePage(previous,intent.page));
setSelectedModelPage((previous)=>(previous===intent.page
?0
:previous>intent.page?previous-1:previous));
};
return{
addModelPage,cancelModelPageDelete,confirmModelPageDelete,requestModelPageDelete,selectModelPage,
};
}
function createModelTabDragController(view){
const{
editDraft,modelPageCount,modelTabDragRef,modelTabRefs,modelTabSuppressClickRef,saving,
setModelTabDrag,setSelectedModelPage,settingsReadOnly,
}=view;
const MODEL_TAB_DRAG_THRESHOLD=4;
const modelTabDropIndexOf=(clientX)=>{
const refs=modelTabRefs.current??{};
for(let page=0;page<modelPageCount;page+=1){
const element=refs[page];
const rect=typeof element?.getBoundingClientRect==="function"?element.getBoundingClientRect():null;
if(rect===null||rect===void 0)continue;
const left=Number(rect.left);
const width=Number(rect.width);
if(!Number.isFinite(left)||!Number.isFinite(width)||width<=0)continue;
if(Number(clientX)<left+width/2)return page;
}
return modelPageCount;
};
const beginModelTabDrag=(page,event)=>{
if(saving||settingsReadOnly)return;
if(event===null||typeof event!=="object")return;
if(typeof event.button==="number"&&event.button!==0)return;
const doc=typeof document==="undefined"?null:document;
if(doc===null||typeof doc.addEventListener!=="function")return;
const startX=Number(event.clientX);
const startY=Number(event.clientY);
if(!Number.isFinite(startX)||!Number.isFinite(startY))return;
const session={page,startX,startY,active:false,dropIndex:page,detach:null};
const onMove=(moveEvent)=>{
const current=modelTabDragRef.current;
if(current===null)return;
const x=Number(moveEvent?.clientX);
const y=Number(moveEvent?.clientY);
if(!Number.isFinite(x)||!Number.isFinite(y))return;
if(current.active!==true){
if(Math.abs(x-current.startX)+Math.abs(y-current.startY)<MODEL_TAB_DRAG_THRESHOLD)return;
current.active=true;
modelTabSuppressClickRef.current=true;
}
moveEvent?.preventDefault?.();
current.dropIndex=modelTabDropIndexOf(x);
setModelTabDrag({page:current.page,dropIndex:current.dropIndex,active:true});
};
const onEnd=(endEvent)=>{
const current=modelTabDragRef.current;
modelTabDragRef.current=null;
try{
doc.removeEventListener("pointermove",onMove);
doc.removeEventListener("pointerup",onEnd);
doc.removeEventListener("pointercancel",onEnd);
}catch{/* 监听清理失败不影响后续手势。 */}
setModelTabDrag(null);
if(current===null||current.active!==true){
modelTabSuppressClickRef.current=false;
return;
}
endEvent?.preventDefault?.();
const from=current.page;
const target=endEvent?.type==="pointercancel"
?from
:(current.dropIndex>from?current.dropIndex-1:current.dropIndex);
if(target!==from){
editDraft((previous)=>reorderModelLayers(previous,from,target));
setSelectedModelPage(target);
}
if(typeof globalThis?.setTimeout==="function")globalThis.setTimeout(()=>{modelTabSuppressClickRef.current=false;},0);
else modelTabSuppressClickRef.current=false;
};
doc.addEventListener("pointermove",onMove);
doc.addEventListener("pointerup",onEnd);
doc.addEventListener("pointercancel",onEnd);
session.detach=()=>{
doc.removeEventListener("pointermove",onMove);
doc.removeEventListener("pointerup",onEnd);
doc.removeEventListener("pointercancel",onEnd);
};
modelTabDragRef.current=session;
};
return{beginModelTabDrag};
}
function bindSettingsText(locale){
return(key,vars)=>settingsText(locale,key,vars);
}
function bindSettingsExtraText(locale){
return(key,vars)=>settingsExtraText(locale,key,vars);
}
function bindRoleLabelOf(roleLabels){
return(role)=>{
const label=roleLabels?.[role];
return typeof label==="string"&&label.length>0?label:(SETTINGS_ROLE_LABELS[role]??role);
};
}
function bindPromptTextOf(promptDrafts,baselineProjection){
return(role)=>{
if(Object.prototype.hasOwnProperty.call(promptDrafts,role))return promptDrafts[role];
return promptEntryOf(baselineProjection,role)?.effective??"";
};
}
function bindModelPageLabelOf(tExtra){
return(page)=>(page===0
?tExtra("settings.modelTabs.primary")
:tExtra("settings.modelTabs.candidate",{index:page}));
}
function bindNotificationEventsDismiss({isOpen,rootRef,triggerRef,setOpen}){
if(!isOpen)return undefined;
const restoreTriggerFocus=()=>{
try{triggerRef.current?.focus?.();}catch{/* 无 DOM 的宿主忽略 */}
};
const closeAndRestoreFocus=()=>{
setOpen(false);
restoreTriggerFocus();
};
const onPointerDown=(event)=>{
const root=rootRef.current;
const target=event?.target;
if(root!==null&&root!==void 0&&typeof root.contains==="function"
&&target!==null&&target!==void 0&&root.contains(target))return;
closeAndRestoreFocus();
};
const onKeyDown=(event)=>{
if(event?.key!=="Escape")return;
event.preventDefault?.();
closeAndRestoreFocus();
};
const doc=typeof document==="undefined"?null:document;
if(doc===null||typeof doc.addEventListener!=="function")return undefined;
doc.addEventListener("mousedown",onPointerDown);
doc.addEventListener("keydown",onKeyDown);
return()=>{
doc.removeEventListener?.("mousedown",onPointerDown);
doc.removeEventListener?.("keydown",onKeyDown);
};
}
function DshExpertGroupSettings({settingsForm,modelCatalog,modelConfigHost,ctx,modelConfigDefaultOpen}){
const subscribe=react.useMemo(()=>settingsForm.subscribe.bind(settingsForm),[settingsForm]);
const getSnapshot=react.useMemo(()=>settingsForm.getSnapshot.bind(settingsForm),[settingsForm]);
const settingsSnapshot=react.useSyncExternalStore(subscribe,getSnapshot);
const catalogSubscribe=react.useMemo(()=>modelCatalog.subscribe.bind(modelCatalog),[modelCatalog]);
const catalogGetSnapshot=react.useMemo(()=>modelCatalog.getSnapshot.bind(modelCatalog),[modelCatalog]);
const directoryState=react.useSyncExternalStore(catalogSubscribe,catalogGetSnapshot);
const[hostMeta,refreshHostMeta,hostMetaError]=useHostMeta(ctx);
const roles=useEnabledSettingsRoles(hostMeta);
const uiLocale=resolveSettingsLocale(ctx);
const t=bindSettingsText(uiLocale);
const tExtra=bindSettingsExtraText(uiLocale);
const roleLabelOf=bindRoleLabelOf(hostMeta?.roleLabels);
const promptRoleIds=react.useMemo(()=>{
const declared=hostMeta?.rolePrompts?.roles;
if(!Array.isArray(declared))return PROMPT_ROLE_IDS;
const roles=declared.filter((role)=>typeof role==="string"&&role.length>0);
return roles.length>0?roles:PROMPT_ROLE_IDS;
},[hostMeta]);
const hostPromptProjection=react.useMemo(
()=>normalizeRolePromptProjection(hostMeta?.rolePrompts,settingsSnapshot.value,true,promptRoleIds),
[hostMeta,settingsSnapshot.value,promptRoleIds],
);
react.useEffect(()=>{
void modelCatalog.load();
},[modelCatalog]);
const[draft,setDraft]=react.useState(()=>normalizeSettingsDraft(settingsSnapshot.value,roles,true,true));
const[candidatesError,setCandidatesError]=react.useState(null);
const[selectedModelPage,setSelectedModelPage]=react.useState(0);
const[modelTabDrag,setModelTabDrag]=react.useState(null);
const[modelPageDeleteIntent,setModelPageDeleteIntent]=react.useState(null);
const modelTabRefs=react.useRef({});
const modelTabDragRef=react.useRef(null);
const modelTabSuppressClickRef=react.useRef(false);
const modelPageDeleteCancelRef=react.useRef(null);
const[peakValleyOpen,setPeakValleyOpen]=react.useState(false);
const[peakValleyPeriod,setPeakValleyPeriod]=react.useState("peak");
const[peakValleyPages,setPeakValleyPages]=react.useState({});
const mainPeriodRef=react.useRef(null);
if(mainPeriodRef.current===null)mainPeriodRef.current=mainEditingPeriodOf(settingsSnapshot.value);
const mainPeriod=mainPeriodRef.current;
const[livePeriod,setLivePeriod]=react.useState(mainPeriod);
const peakValleyPeriodsRef=react.useRef(null);
peakValleyPeriodsRef.current=draft.peakValley?.periods??[];
const peakValleyEnabledDraft=draft.peakValley?.enabled===true;
react.useEffect(()=>{
if(!peakValleyEnabledDraft)return void 0;
if(mainPeriod===null)setLivePeriod(samplePeakValleyPeriod(peakValleyPeriodsRef.current));
return stopPeriodSampler(startPeriodSampler(peakValleyPeriodsRef,setLivePeriod));
},[mainPeriod,peakValleyEnabledDraft]);
const[dirty,setDirty]=react.useState(false);
const[saving,setSaving]=react.useState(false);
const[error,setError]=react.useState(null);
const[saved,setSaved]=react.useState(false);
const[selectedPromptRole,setSelectedPromptRole]=react.useState(null);
const[promptDrafts,setPromptDrafts]=react.useState(()=>({}));
const[promptTouched,setPromptTouched]=react.useState({});
const[promptError,setPromptError]=react.useState(null);
const[localPromptProjection,setLocalPromptProjection]=react.useState(null);
const[editorBaseline,setEditorBaseline]=react.useState(null);
const[settingsConflict,setSettingsConflict]=react.useState(null);
const[externalSettingsChanged,setExternalSettingsChanged]=react.useState(false);
const[leaveIntent,setLeaveIntent]=react.useState(null);
const leaveTriggerRef=react.useRef(null);
const leaveCancelRef=react.useRef(null);
const[notificationEventsOpen,setNotificationEventsOpen]=react.useState(false);
const notificationEventsRootRef=react.useRef(null);
const notificationEventsTriggerRef=react.useRef(null);
const notificationEventsPanelRef=react.useRef(null);
const promptProjection=localPromptProjection!==null
&&Number.isSafeInteger(localPromptProjection.revision)
&&localPromptProjection.revision>settingsSnapshot.revision
?localPromptProjection.projection
:hostPromptProjection;
const baselineProjection=editorBaseline?.role===selectedPromptRole
?editorBaseline.projection
:promptProjection;
const promptMaxGraphemes=baselineProjection?.maxGraphemes??DEFAULT_PROMPT_MAX_GRAPHEMES;
const settingsReadOnly=settingsSnapshot.writable!==true;
const promptLoading=hostMeta===null&&hostMetaError===null;
const promptTextOf=bindPromptTextOf(promptDrafts,baselineProjection);
const promptTouchedRoles=Object.keys(promptTouched).filter((role)=>promptRoleIds.includes(role));
const promptDirty=baselineProjection!==null&&promptRoleIds.some((role)=>{
if(!Object.prototype.hasOwnProperty.call(promptTouched,role))return false;
const entry=promptEntryOf(baselineProjection,role);
return entry!==null&&promptTextOf(role)!==entry.effective;
});
const committedAuthorityRef=react.useRef(null);
const committedSnapshotLagging=committedAuthorityRef.current!==null
&&Number.isSafeInteger(committedAuthorityRef.current.revision)
&&(!Number.isSafeInteger(settingsSnapshot.revision)
||settingsSnapshot.revision<committedAuthorityRef.current.revision);
const authorityValue=committedSnapshotLagging?committedAuthorityRef.current.value:settingsSnapshot.value;
const sourcePromptOverrides=normalizePromptOverrides(authorityValue?.promptOverrides,promptMaxGraphemes,promptRoleIds);
const localDraft=normalizeSettingsDraft(draft,roles,false);
const sourceDraftForDirty=normalizeSettingsDraft(authorityValue,roles,false,true);
const settingsDirty=!settingsDraftEqual(localDraft,sourceDraftForDirty);
const hasUnsavedChanges=settingsDirty||promptDirty;
const editorHasUnsavedChanges=hasUnsavedChanges;
const sourceDraftForSave=normalizeSettingsDraft(authorityValue,roles,true,true);
const editorEntryValue=selectedPromptRole!==null&&editorBaseline?.role===selectedPromptRole
?editorBaseline.value
:authorityValue;
const editorEntryDraft=normalizeSettingsDraft(editorEntryValue,roles,false,true);
const effectiveDraft=selectedPromptRole!==null
?mergeSettingsDraftOverSource(sourceDraftForSave,localDraft,editorEntryDraft)
:localDraft;
const modelFieldsChanged=react.useMemo(()=>{
if(!settingsDraftEqual(effectiveDraft.defaults,sourceDraftForSave.defaults))return true;
if(!settingsDraftEqual(effectiveDraft.orchestrator,sourceDraftForSave.orchestrator))return true;
return unifiedProviderOf(effectiveDraft.defaults,roles,effectiveDraft.provider)
!==unifiedProviderOf(sourceDraftForSave.defaults,roles,sourceDraftForSave.provider);
},[effectiveDraft,sourceDraftForSave,roles]);
react.useEffect(()=>{
if(dirty)return;
if(committedSnapshotLagging)return;
setDraft(normalizeSettingsDraft(authorityValue,roles,true,true));
setPromptDrafts({});
setPromptTouched({});
setPromptError(null);
setCandidatesError(null);
},[dirty,settingsSnapshot.value,settingsSnapshot.revision,roles,promptMaxGraphemes,committedSnapshotLagging,authorityValue]);
react.useEffect(()=>{
if(selectedPromptRole===null||editorBaseline?.role!==selectedPromptRole)return;
if(editorBaseline.projection===null&&hostPromptProjection!==null){
setEditorBaseline((previous)=>previous?.role===selectedPromptRole&&previous.projection===null
?{...previous,projection:hostPromptProjection}
:previous);
return;
}
if(Number.isSafeInteger(localPromptProjection?.revision)
&&localPromptProjection.revision>settingsSnapshot.revision)return;
if(!Number.isSafeInteger(settingsSnapshot.revision))return;
if(settingsSnapshot.revision===editorBaseline.revision)return;
if(Number.isSafeInteger(editorBaseline.revision)&&settingsSnapshot.revision<editorBaseline.revision)return;
if(hasUnsavedChanges||dirty){
setExternalSettingsChanged(true);
return;
}
const refreshedProjection=hostPromptProjection;
if(refreshedProjection===null){
setExternalSettingsChanged(true);
return;
}
setLocalPromptProjection(null);
setEditorBaseline({
role:selectedPromptRole,
value:settingsSnapshot.value,
revision:settingsSnapshot.revision,
projection:refreshedProjection,
});
setDraft(normalizeSettingsDraft(settingsSnapshot.value,roles,true,true));
setPromptDrafts({});
setPromptTouched({});
setDirty(false);
setSaved(false);
setError(null);
setPromptError(null);
setSettingsConflict(null);
setExternalSettingsChanged(false);
},[selectedPromptRole,editorBaseline,localPromptProjection,settingsSnapshot.revision,settingsSnapshot.value,hostPromptProjection,hasUnsavedChanges,dirty,roles]);
react.useEffect(()=>{
if(selectedPromptRole===null||!editorHasUnsavedChanges)return;
const target=typeof globalThis?.addEventListener==="function"
?globalThis
:(typeof globalThis?.window?.addEventListener==="function"?globalThis.window:null);
if(target===null)return;
const onBeforeUnload=(event)=>{
event.preventDefault?.();
event.returnValue="";
return"";
};
target.addEventListener("beforeunload",onBeforeUnload);
return()=>target.removeEventListener?.("beforeunload",onBeforeUnload);
},[selectedPromptRole,editorHasUnsavedChanges]);
react.useEffect(()=>bindNotificationEventsDismiss({
isOpen:notificationEventsOpen,
rootRef:notificationEventsRootRef,
triggerRef:notificationEventsTriggerRef,
setOpen:setNotificationEventsOpen,
}),[notificationEventsOpen]);
react.useEffect(()=>{
if(!notificationEventsOpen)return;
const panel=notificationEventsPanelRef.current;
if(panel===null||panel===void 0||typeof panel.querySelector!=="function")return;
try{panel.querySelector("input[type=checkbox]")?.focus?.();}catch{/* 忽略不可聚焦的宿主 */}
},[notificationEventsOpen]);
const editDraft=(update)=>{
setDirty(true);
setSaved(false);
setError(null);
setPromptError(null);
setDraft((previous)=>update(previous));
};
const captureEditorBaseline=(role)=>{
if(role===null)return null;
return{
role,
value:settingsSnapshot.value,
revision:Number.isSafeInteger(settingsSnapshot.revision)&&settingsSnapshot.revision>=0
?settingsSnapshot.revision
:null,
projection:promptProjection,
};
};
const applyPromptNavigation=(role)=>{
setSelectedPromptRole(role);
setEditorBaseline(captureEditorBaseline(role));
setPromptDrafts({});
setPromptTouched({});
setDirty(false);
setSaved(false);
setError(null);
setPromptError(null);
};
const requestPromptNavigation=(role,trigger)=>{
if(editorHasUnsavedChanges){
leaveTriggerRef.current=trigger?.currentTarget??(typeof document==="undefined"?null:document.activeElement);
setLeaveIntent({kind:"navigate",role});
return;
}
applyPromptNavigation(role);
};
const openPrompt=(role,event)=>{
if(!promptRoleIds.includes(role))return;
if(selectedPromptRole!==null&&selectedPromptRole!==role){
requestPromptNavigation(role,event);
return;
}
setSelectedPromptRole(role);
setEditorBaseline(captureEditorBaseline(role));
setPromptError(null);
setError(null);
};
const closePrompt=(event)=>requestPromptNavigation(null,event);
const dismissLeaveDialog=()=>{
setLeaveIntent(null);
const trigger=leaveTriggerRef.current;
leaveTriggerRef.current=null;
try{trigger?.focus?.();}catch{/* 焦点恢复失败不应阻断编辑器。 */}
};
const editPromptText=(role,text)=>{
const nextPromptDirty=baselineProjection!==null&&promptRoleIds.some((candidate)=>{
const entry=promptEntryOf(baselineProjection,candidate);
if(entry===null)return false;
return(candidate===role?text:promptTextOf(candidate))!==entry.effective;
});
setPromptDrafts((previous)=>({...previous,[role]:text}));
setPromptTouched((previous)=>({...previous,[role]:true}));
setDirty(settingsDirty||nextPromptDirty);
setSaved(false);
setError(null);
setPromptError(null);
};
const groups=Array.isArray(directoryState.groups)?directoryState.groups:[];
const providerGroups=groups.filter((group)=>group&&typeof group.id==="string");
const modelRowRoles=react.useMemo(()=>{
const next=[ORCHESTRATOR_ID,...PROMPT_ROLE_IDS];
for(const role of roles)if(!next.includes(role))next.push(role);
return next;
},[roles]);
const catalogAvailable=directoryState.status==="ready"||groups.length>0;
const modelPageCount=modelPageCountOf(draft);
const currentModelPage=Math.min(selectedModelPage,modelPageCount-1);
const currentModelLayer=modelLayerMapOf(draft,currentModelPage);
const unifiedProvider=unifiedProviderOf(currentModelLayer,roles,currentModelPage===0?draft.provider:"");
const modelPageLabelOf=bindModelPageLabelOf(tExtra);
react.useEffect(()=>()=>{
const session=modelTabDragRef.current;
modelTabDragRef.current=null;
try{session?.detach?.();}catch{/* 卸载路径不抛错。 */}
},[]);
react.useEffect(()=>{
if(modelPageDeleteIntent===null)return;
try{modelPageDeleteCancelRef.current?.focus?.();}catch{/* 不支持 focus 的嵌入宿主仍可键盘点击。 */}
},[modelPageDeleteIntent]);
const view={
applyPromptNavigation,authorityValue,baselineProjection,
candidatesError,catalogAvailable,closePrompt,committedAuthorityRef,committedSnapshotLagging,
currentModelPage,directoryState,dismissLeaveDialog,draft,editDraft,editPromptText,effectiveDraft,
error,externalSettingsChanged,hasUnsavedChanges,hostMeta,hostMetaError,leaveCancelRef,
leaveIntent,leaveTriggerRef,livePeriod,mainPeriod,modelConfigHost,modelConfigDefaultOpen,modelFieldsChanged,modelPageCount,modelPageDeleteCancelRef,
modelPageDeleteIntent,modelPageLabelOf,modelRowRoles,modelTabDrag,modelTabDragRef,modelTabRefs,modelTabSuppressClickRef,notificationEventsOpen,
notificationEventsPanelRef,notificationEventsRootRef,notificationEventsTriggerRef,openPrompt,peakValleyOpen,
peakValleyPages,peakValleyPeriod,peakValleyViewOf,promptDirty,promptError,
promptLoading,promptMaxGraphemes,promptProjection,promptRoleIds,promptTextOf,promptTouchedRoles,providerGroups,
refreshHostMeta,roleLabelOf,roles,saved,
saving,selectedPromptRole,setCandidatesError,setDirty,setDraft,
setEditorBaseline,setError,setExternalSettingsChanged,setLeaveIntent,setLocalPromptProjection,setModelPageDeleteIntent,
setModelTabDrag,setNotificationEventsOpen,setPeakValleyOpen,setPeakValleyPages,setPeakValleyPeriod,setSelectedModelPage,
setPromptDrafts,setPromptError,setPromptTouched,setSaved,setSettingsConflict,settingsConflict,
settingsForm,settingsReadOnly,settingsSnapshot,sourceDraftForSave,sourcePromptOverrides,t,tExtra,unifiedProvider,
ctx,editorBaseline,setSaving,
};
Object.assign(view,createModelPageActions(view),createModelTabDragController(view));
view.openPeakValley=openPeakValleyActionOf(view);
useSettingsLeaveFocus(view);
view.save=createSettingsSaveAction(view);
view.saveRepair=repairSaveActionOf(view);
view.peakValleyBroken=typeof authorityValue?.peakValley?.invalidCode==="string";
return renderSettingsTail(view);
}
global[SYMBOL]=Object.freeze({
DshExpertGroupSettings,bindClientRuntime,
});
})(globalThis);
/* source: client-model-views-b.js */
(function installClientModelViewsB(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-views-b");
let react=null;
function bindClientRuntime(host){
react=host.react??null;
}
let modelDiscoveryTitleSeq=0;
function focusableDialogControls(scope){
const nodes=Array.from(scope?.querySelectorAll?.("[data-deg-dialog-action]")??[]);
return nodes.filter((node)=>{
if(node===null||typeof node!=="object")return false;
if(node.disabled===true)return false;
if(node.hidden===true)return false;
if(typeof node.getAttribute!=="function")return true;
if(node.getAttribute("aria-disabled")==="true")return false;
if(node.getAttribute("aria-hidden")==="true")return false;
return true;
});
}
function renderModelRow(model,options){
const{
key,attributes,idAttributes={},disabled,idLabel,nameLabel,parseCapacity,
onChange,onToggleAdvanced,onRemove,onEffort,onInput,
}=options;
const advanced=model.advancedOpen
?react.createElement("div",{className:"deg_mc_model_advanced"},
react.createElement("label",{className:"deg_mc_field"},
react.createElement("span",{className:"deg_mc_field_label"},"上下文窗口"),
react.createElement("input",{
className:"deg_mc_input",
type:"text",
inputMode:"numeric",
value:model.contextWindow.value,
placeholder:model.contextWindow.placeholder,
"aria-label":"上下文窗口 "+String(model.position),
disabled,
onChange:(event)=>onChange(model.index,{contextWindow:parseCapacity(event.target.value)}),
})),
react.createElement("label",{className:"deg_mc_field"},
react.createElement("span",{className:"deg_mc_field_label"},"最大输出 token"),
react.createElement("input",{
className:"deg_mc_input",
type:"text",
inputMode:"numeric",
value:model.maxTokens.value,
placeholder:model.maxTokens.placeholder,
"aria-label":"最大输出 token "+String(model.position),
disabled,
onChange:(event)=>onChange(model.index,{maxTokens:parseCapacity(event.target.value)}),
})),
react.createElement("fieldset",{className:"deg_mc_efforts"},
react.createElement("legend",{className:"deg_mc_efforts_label"},"思考档位（可多选）"),
react.createElement("div",{className:"deg_mc_efforts_row"},
model.efforts.map((effort)=>react.createElement("label",{
key:effort.level,
className:"deg_mc_effort",
},react.createElement("input",{
type:"checkbox",
checked:effort.checked,
disabled,
"data-deg-effort":effort.level,
"data-deg-model-index":model.index,
"aria-label":"模型 "+String(model.position)+" 思考档位 "+effort.level,
onChange:()=>onEffort(model.index,effort.level),
}),react.createElement("span",null,effort.level))))),
react.createElement("fieldset",{className:"deg_mc_efforts"},
react.createElement("legend",{className:"deg_mc_efforts_label"},"输入类型"),
react.createElement("div",{className:"deg_mc_input_types"},
model.inputs.map((input)=>react.createElement("label",{
key:input.modality,
className:"deg_mc_effort",
},react.createElement("input",{
type:"checkbox",
checked:input.checked,
disabled:disabled||input.locked===true,
"data-deg-input":input.modality,
"data-deg-model-index":model.index,
"aria-label":"模型 "+String(model.position)+" 输入类型 "+input.modality,
onChange:()=>onInput(model.index,input.modality),
}),react.createElement("span",null,input.modality))))))
:null;
return react.createElement("div",{
key,
className:"deg_mc_model",
...attributes,
},react.createElement("div",{className:"deg_mc_model_main"},
react.createElement("input",{
className:"deg_mc_input",
type:"text",
value:model.id.value,
placeholder:"模型 ID",
"aria-label":idLabel+String(model.position),
disabled,
onChange:(event)=>onChange(model.index,{id:event.target.value}),
...idAttributes,
}),
react.createElement("input",{
className:"deg_mc_input",
type:"text",
value:model.name.value,
placeholder:"显示名",
"aria-label":nameLabel+String(model.position),
disabled,
onChange:(event)=>onChange(model.index,{name:event.target.value}),
}),
react.createElement("button",{
type:"button",
className:"deg_btn deg_mc_icon_btn",
"aria-label":"模型高级设置 "+String(model.position),
"aria-expanded":model.advancedOpen,
onClick:()=>onToggleAdvanced(model.index),
},model.advancedOpen?"▾":"▸"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_mc_icon_btn",
"aria-label":"删除模型 "+String(model.position),
disabled,
onClick:()=>onRemove(model.index),
},"✕")),
advanced);
}
function clearsAllCandidateSelection(candidates,visibleIds){
const list=Array.isArray(candidates)?candidates:[];
const wanted=visibleIds instanceof Set?visibleIds:new Set();
const visible=list.filter((candidate)=>wanted.has(candidate?.id));
return visible.length>0&&visible.every((candidate)=>candidate.picked===true);
}
function toggleCandidateOf(state,id){
if(state===null||!Array.isArray(state.candidates))return state;
return{
...state,
candidates:state.candidates.map((candidate)=>candidate.id===id
?{...candidate,picked:candidate.picked!==true}
:candidate),
};
}
function toggleVisibleCandidatesOf(state,ids){
const wanted=new Set(Array.isArray(ids)?ids:[]);
if(state===null||!Array.isArray(state.candidates))return state;
if(clearsAllCandidateSelection(state.candidates,wanted)){
return{...state,candidates:state.candidates.map((candidate)=>({...candidate,picked:false}))};
}
return{
...state,
candidates:state.candidates.map((candidate)=>wanted.has(candidate.id)
?{...candidate,picked:true}
:candidate),
};
}
function toggleIndexInSet(previous,index){
const next=new Set(previous);
if(!next.delete(index))next.add(index);
return next;
}
function ModelDiscoveryDialog({candidates,query,onQueryChange,onToggle,onToggleVisible,onClose,onAdopt}){
const source=Array.isArray(candidates)?candidates:[];
const[titleId]=react.useState(()=>{
modelDiscoveryTitleSeq+=1;
return"deg-model-discovery-title-"+String(modelDiscoveryTitleSeq);
});
const dialogRef=react.useRef(null);
const restoreTargetRef=react.useRef(typeof document==="undefined"?null:document.activeElement??null);
react.useEffect(()=>()=>{
const target=restoreTargetRef.current;
try{
if(target!==null&&typeof target?.focus==="function")target.focus();
}catch{/* 焦点不可用时保持弹窗关闭语义，不抛出。 */}
},[]);
const normalizedQuery=typeof query==="string"?query.trim().toLowerCase():"";
const visible=normalizedQuery.length===0
?source
:source.filter((candidate)=>{
const id=typeof candidate?.id==="string"?candidate.id:"";
const name=typeof candidate?.name==="string"?candidate.name:"";
return id.toLowerCase().includes(normalizedQuery)||name.toLowerCase().includes(normalizedQuery);
});
const visibleIds=new Set(visible.map((candidate)=>candidate?.id));
const clearsAll=clearsAllCandidateSelection(source,visibleIds);
const pickedCount=source.filter((candidate)=>candidate.picked===true).length;
const handleKeyDown=(event)=>{
if(event?.key==="Escape"){
event.preventDefault?.();
event.stopPropagation?.();
onClose();
return;
}
if(event?.key!=="Tab")return;
const controls=focusableDialogControls(dialogRef.current);
if(controls.length===0)return;
const current=controls.indexOf(typeof document==="undefined"?null:document.activeElement);
const nextIndex=event.shiftKey
?(current<=0?controls.length-1:current-1)
:(current>=controls.length-1?0:current+1);
event.preventDefault?.();
try{controls[nextIndex]?.focus?.();}catch{/* 无 DOM 焦点时保持可点击控件。 */}
};
const list=visible.length===0
?react.createElement("p",{className:"deg_mc_candidate_empty",role:"status"},"没有匹配的模型")
:react.createElement("ul",{className:"deg_mc_candidate_list"},visible.map((candidate)=>(
react.createElement("li",{key:candidate.id,className:"deg_mc_candidate_item"},
react.createElement("label",{className:"deg_mc_candidate_label"},
react.createElement("input",{
type:"checkbox",
checked:candidate.picked===true,
"data-deg-create-candidate":candidate.id,
"data-deg-dialog-action":"candidate",
"aria-label":"选择模型 "+candidate.id,
onChange:()=>onToggle(candidate.id),
}),
react.createElement("span",{className:"deg_mc_candidate_id"},candidate.id))))));
return react.createElement("div",{
className:"deg_mc_modal_backdrop",
onClick:()=>onClose(),
},
react.createElement("div",{
className:"deg_mc_modal",
role:"dialog",
"aria-modal":"true",
"aria-labelledby":titleId,
ref:dialogRef,
onKeyDown:handleKeyDown,
onClick:(event)=>event?.stopPropagation?.(),
},
react.createElement("div",{className:"deg_mc_modal_header"},
react.createElement("h3",{className:"deg_mc_modal_title",id:titleId},"选择要添加的模型"),
react.createElement("button",{
type:"button",
className:"deg_mc_modal_close",
"aria-label":"关闭",
"data-deg-dialog-action":"close",
autoFocus:true,
onClick:onClose,
},"×")),
react.createElement("p",{className:"deg_mc_modal_description"},"以下是模型提供方的可用模型，勾选要添加的模型。"),
react.createElement("div",{className:"deg_mc_candidate_toolbar"},
react.createElement("input",{
className:"deg_mc_input deg_mc_candidate_search",
type:"search",
value:query,
placeholder:"搜索模型",
"aria-label":"搜索模型",
"data-deg-dialog-action":"search",
onChange:(event)=>onQueryChange(event.target.value),
}),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:visible.length===0,
"data-deg-dialog-action":"toggle-visible",
onClick:()=>onToggleVisible(visible.map((candidate)=>candidate.id)),
},clearsAll?"取消全选":"全选")),
list,
react.createElement("div",{className:"deg_mc_modal_footer"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"cancel",
onClick:onClose,
},"取消"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
disabled:pickedCount===0,
"data-deg-dialog-action":"adopt",
onClick:onAdopt,
},"添加所选"))));
}
global[SYMBOL]=Object.freeze({
ModelDiscoveryDialog,clearsAllCandidateSelection,focusableDialogControls,renderModelRow,bindClientRuntime,
toggleCandidateOf,toggleVisibleCandidatesOf,toggleIndexInSet,
});
})(globalThis);
/* source: client-model-views-a.js */
(function installClientModelViewsA(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-views-a");
const clientModelViewsBSymbol=Symbol.for("dsh-expert-group/client-model-views-b");
const clientModelViewsB=global[clientModelViewsBSymbol]||{};
const{
ModelDiscoveryDialog,renderModelRow,toggleCandidateOf,toggleIndexInSet,toggleVisibleCandidatesOf,
}=clientModelViewsB;
let react=null;
function bindClientRuntime(host){
react=host.react??null;
}
function renderProviderModelRows(card,handlers){
const{disabled,edit,patchRow,toggleRow,toggleEffort,toggleInput,config,session}=handlers;
return card.models.map((model)=>renderModelRow(model,{
key:"model-"+String(model.index),
attributes:{"data-deg-model-index":model.index},
disabled,
idLabel:"模型 ID ",
nameLabel:"模型显示名 ",
parseCapacity:config.parseCapacity,
onChange:patchRow,
onToggleAdvanced:toggleRow,
onRemove:(index)=>edit((draft)=>({...draft,models:config.removeModelRow(session.modelRows,index)})),
onEffort:toggleEffort,
onInput:toggleInput,
}));
}
function ModelConfigDisclosure({section,onToggle,extra}){
return react.createElement("div",{className:"deg_mc_header"},
react.createElement("button",{
type:"button",
className:"deg_mc_toggle",
"aria-expanded":section.disclosure.expanded,
"aria-controls":section.disclosure.bodyId,
"data-deg-model-config-toggle":"true",
onClick:onToggle,
},
react.createElement("span",{className:"deg_mc_chevron","aria-hidden":"true"},section.disclosure.expanded?"▾":"▸"),
react.createElement("span",null,section.title)),
extra);
}
function buildCandidateControls({setFetchState,setCandidateQuery}){
const toggleCandidate=(id)=>setFetchState((previous)=>toggleCandidateOf(previous,id));
const toggleVisibleCandidates=(ids)=>setFetchState((previous)=>toggleVisibleCandidatesOf(previous,ids));
const closeModelPicker=()=>{
setFetchState(null);
setCandidateQuery("");
};
return{toggleCandidate,toggleVisibleCandidates,closeModelPicker};
}
function renderProviderCardCollapsed(context){
const{card,row,removable,saving,onRemove,setOpen,setError,setSaved,setConflict}=context;
const removeAction=removable&&typeof onRemove==="function"
?react.createElement("button",{
type:"button",
className:"deg_btn deg_mc_delete_btn",
disabled:saving||card.readOnly,
"aria-label":card.displayName+" 删除",
onClick:(event)=>{void onRemove(event);},
},"删除")
:null;
return react.createElement("li",{className:"deg_mc_card"},
react.createElement("div",{className:"deg_mc_card_head"},
react.createElement("span",{className:"deg_mc_card_name"},card.displayName),
card.provider===card.displayName?null:react.createElement("span",{className:"deg_mc_card_route"},card.provider),
card.apiKey.placeholder==="已配置（留空表示不修改）"
?react.createElement("span",{
className:"deg_mc_dot",
role:"img",
"aria-label":"API Key 已配置",
title:"API Key 已配置",
"data-state":"available",
style:{background:"var(--dsw-alias-state-success-primary,#22c55e)"},
})
:null,
react.createElement("span",{className:"deg_mc_card_actions"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"aria-label":card.displayName+" 编辑",
onClick:()=>{setOpen(true);setError(null);setSaved(false);setConflict(false);},
},"编辑"),removeAction)),
row.error===undefined?null:react.createElement("p",{className:"deg_mc_error",role:"alert"},row.error));
}
function renderProviderCardExpanded(context){
const{
card,row,config,session,host,disabled,saving,saved,error,conflict,keyDraft,
fetchState,candidateQuery,modelRows,setKeyDraft,setOpen,setSaved,setError,setConflict,
setExpandedRows,setFetchState,setDraftRevision,setCandidateQuery,
edit,apply,cancel,fetchModels,toggleCandidate,toggleVisibleCandidates,closeModelPicker,adoptPicked,
}=context;
return react.createElement("li",{className:"deg_mc_card","data-deg-provider":row.provider},
react.createElement("div",{className:"deg_mc_card_head"},
react.createElement("span",{className:"deg_mc_card_name"},card.displayName),
card.provider===card.displayName?null:react.createElement("span",{className:"deg_mc_card_route"},card.provider)),
row.error===undefined?null:react.createElement("p",{className:"deg_mc_error",role:"alert"},row.error),
react.createElement("label",{className:"deg_mc_field"},
react.createElement("span",{className:"deg_mc_field_label"},"API Key"),
react.createElement("input",{
className:"deg_mc_input",
type:card.apiKey.type,
autoComplete:card.apiKey.autoComplete,
value:keyDraft,
disabled:disabled||card.apiKey.disabled,
"data-deg-api-key":row.provider,
"aria-label":card.displayName+" API Key",
placeholder:card.apiKey.placeholder,
onChange:(event)=>{setKeyDraft(event.target.value);session.typeKey(event.target.value);},
})),
react.createElement("p",{className:"deg_mc_hint"},card.apiKey.hint),
react.createElement("label",{className:"deg_mc_field"},
react.createElement("span",{className:"deg_mc_field_label"},"Base URL"),
react.createElement("input",{
className:"deg_mc_input",
type:"text",
value:card.baseUrl.value,
disabled,
placeholder:card.baseUrl.placeholder,
"data-deg-base-url":row.provider,
"aria-label":card.displayName+" Base URL",
onChange:(event)=>{
const value=event.target.value;
edit((draft)=>{
const next={...draft};
if(value.trim().length===0)Reflect.deleteProperty(next,"baseURL");
else next.baseURL=value;
return next;
});
},
})),
react.createElement("label",{className:"deg_mc_field"},
react.createElement("span",{className:"deg_mc_field_label"},"协议"),
react.createElement("select",{
className:"deg_mc_select",
value:card.protocol.value,
disabled,
"data-deg-protocol":row.provider,
"aria-label":card.displayName+" 协议",
onChange:(event)=>{
const value=event.target.value;
edit((draft)=>{
const next={...draft};
if(value.length===0)Reflect.deleteProperty(next,"api");
else next.api=value;
return next;
});
},
},card.protocol.options.map((option)=>react.createElement("option",{key:option.value,value:option.value},option.label)))),
react.createElement("div",{className:"deg_mc_models"},
react.createElement("div",{className:"deg_mc_models_head"},
react.createElement("span",{className:"deg_mc_models_title"},"模型"),
react.createElement("span",{className:"deg_mc_models_meta"},card.modelCatalog.label),
card.modelCatalog.canReset
?react.createElement("button",{
type:"button",
className:"deg_btn",
disabled,
"data-deg-reset-models":row.provider,
onClick:()=>{
session.resetModels();
setDraftRevision((value)=>value+1);
setExpandedRows(new Set());
setFetchState(null);
setSaved(false);
setError(null);
},
},"恢复默认")
:null,
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:disabled||card.actions.fetchModels==="disabled",
"data-deg-fetch-models":row.provider,
onClick:()=>{void fetchModels();},
},"获取模型")),
card.models.length===0
?react.createElement("p",{className:"deg_mc_hint"},card.modelCatalog.emptyHint)
:react.createElement("div",{className:"deg_mc_model"},modelRows),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled,
"data-deg-add-model":row.provider,
onClick:()=>edit((draft)=>({...draft,models:config.appendModelRow(session.modelRows)})),
},"添加模型"),
fetchState?.error===null||fetchState?.error===undefined
?null
:react.createElement("p",{className:"deg_mc_error",role:"alert"},fetchState.error)
),
error===null?null:react.createElement("p",{className:"deg_mc_error",role:"alert","data-deg-card-error":row.provider},error),
conflict
?react.createElement("div",{className:"deg_mc_conflict"},
react.createElement("p",{className:"deg_mc_error"},"配置冲突：本卡片的修改未提交。"),
react.createElement("div",{className:"deg_mc_conflict_actions"},
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:saving,
onClick:async()=>{
await host.refreshSettingsView();
cancel();
},
},"重新打开（加载最新配置）")))
:null,
react.createElement("div",{className:"deg_mc_card_footer"},
react.createElement("span",{className:"deg_mc_status deg_settings_status",role:"status"},saved?"已保存":""),
react.createElement("button",{type:"button",className:"deg_btn",disabled:saving,onClick:()=>{setOpen(false);cancel();}},"取消"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
disabled,
"data-deg-apply":row.provider,
onClick:()=>{void apply();},
},saving?"应用中…":"应用")),
fetchState!==null&&Array.isArray(fetchState.candidates)
?react.createElement(ModelDiscoveryDialog,{
candidates:fetchState.candidates,
query:candidateQuery,
onQueryChange:setCandidateQuery,
onToggle:toggleCandidate,
onToggleVisible:toggleVisibleCandidates,
onClose:closeModelPicker,
onAdopt:adoptPicked,
})
:null);
}
function ModelProviderCard({row,namespace,host,roleLabels,onSaved,onRemove}){
const config=host.config;
const profilePath=Array.isArray(row.settingsPath)?row.settingsPath:[];
const[open,setOpen]=react.useState(false);
const[saving,setSaving]=react.useState(false);
const[error,setError]=react.useState(null);
const[saved,setSaved]=react.useState(false);
const[conflict,setConflict]=react.useState(false);
const[expandedRows,setExpandedRows]=react.useState(()=>new Set());
const[fetchState,setFetchState]=react.useState(null);
const[candidateQuery,setCandidateQuery]=react.useState("");
const[keyDraft,setKeyDraft]=react.useState("");
const[,setDraftRevision]=react.useState(0);
const[session]=react.useState(()=>config.createCardSession({
provider:row.provider,
settingsNs:namespace?.ns,
profilePath,
storedUser:namespace?.user,
base:namespace?.base,
value:namespace?.value,
revision:namespace?.revision,
roleDefaults:roleLabels.defaults,
}));
const schemaInfo=react.useMemo(()=>{
const info=host.settingsSchemaInfo(namespace?.ns);
return{
...info,
protocols:config.protocolChoices(info.root,row.provider,host.adapter,profilePath),
};
},[host,namespace,row.provider,profilePath,config]);
const credentialRef=config.credentialRefOf(row,namespace);
const pageWritable=host.readView().writable===true;
const card=session.cardModel({
protocols:schemaInfo.protocols,
defaultInput:schemaInfo.defaultInput,
credentialRef,
credential:host.operations.credentialState(credentialRef),
typed:keyDraft,
readOnly:!pageWritable,
expandedRows,
draft:session.draft,
});
const disabled=card.readOnly||saving;
const removable=config.providerRemovable(row,namespace);
const edit=(update)=>{
session.edit(update);
setDraftRevision((value)=>value+1);
setSaved(false);
setError(null);
};
const patchRow=(index,patch)=>{
edit((draft)=>({
...draft,
models:session.modelRows.map((model,at)=>(
at===index?config.patchModelDraft(model,patch):model
)),
}));
};
const toggleEffort=(index,level)=>{
edit((draft)=>{
const rows=session.modelRows;
const selection=config.effortSelectionFor(rows[index]);
return{...draft,models:config.setModelEffortSelection(rows,index,{...selection,[level]:selection[level]!==true})};
});
};
const toggleInput=(index,modality)=>{
edit((draft)=>{
const rows=session.modelRows;
const selected=config.modelInputOf(rows[index],schemaInfo.defaultInput);
const next=selected.includes(modality)?selected.filter((value)=>value!==modality):[...selected,modality];
return{...draft,models:config.setModelInputSelection(rows,index,next)};
});
};
const toggleRow=(index)=>setExpandedRows((previous)=>toggleIndexInSet(previous,index));
const cancel=()=>{
session.cancel();
setExpandedRows(new Set());
setFetchState(null);
setCandidateQuery("");
setError(null);
setSaved(false);
setConflict(false);
setKeyDraft("");
};
const apply=async()=>{
if(disabled)return false;
setSaving(true);
setError(null);
setSaved(false);
setConflict(false);
try{
const plan=session.plan();
if(plan.ok!==true){
setError(plan.error);
return false;
}
if(config.hasOps(plan.ops)){
const schemaNode=profilePath.length===0
?host.adapter.rehydrate(namespace?.schema)
:host.adapter.nodeAtPath(host.adapter.rehydrate(namespace?.schema),profilePath);
if(schemaNode!==undefined){
const failure=host.adapter.validate(schemaNode,session.draft);
if(failure!==undefined){
setError("设置校验未通过，已拒绝写入："+failure);
return false;
}
}
const written=await host.writeNamespace({
ns:namespace.ns,
ops:plan.ops,
expectedRevision:plan.expectedRevision,
});
if(!written.ok){
setConflict(written.conflict===true);
setError(written.message);
return false;
}
if(written.view!==undefined)session.accept(written.view);
}
if(plan.keyValue!==undefined){
const stored=await host.operations.storeKey(credentialRef,plan.keyValue);
if(stored!==null){
setError(stored);
return false;
}
session.typeKey("");
setKeyDraft("");
}
await host.refreshSettingsView();
setSaved(true);
onSaved();
return true;
}catch(cause){
setError(cause instanceof Error?cause.message:String(cause));
return false;
}finally{
setSaving(false);
}
};
const fetchModels=async()=>{
discoveryIntent.manualIntent=true;
setSaving(true);
setError(null);
setFetchState(null);
setCandidateQuery("");
try{
const draft=session.draft;
const baseURL=typeof draft.baseURL==="string"&&draft.baseURL.length>0?draft.baseURL:undefined;
const api=typeof draft.api==="string"&&draft.api.length>0?draft.api:undefined;
const typed=session.keyValue;
const answer=await host.operations.discoverModels(namespace.ns,{
provider:row.provider,
...(baseURL===undefined?{}:{baseURL}),
...(api===undefined?{}:{api}),
...(typed.length===0?{}:{apiKey:typed}),
});
if(answer.kind==="refused"){
setFetchState({error:answer.message,candidates:null});
return;
}
if(answer.models.length===0){
setFetchState({error:"该端点没有返回任何模型",candidates:null});
return;
}
const pruned=pruneUneditedAutoFallbackRows();
if(pruned!==null){
session.edit((draft)=>({...draft,models:pruned}));
setDraftRevision((value)=>value+1);
setSaved(false);
}
const known=new Set(session.modelRows
.map((model)=>(typeof model.id==="string"?model.id.trim():""))
.filter((id)=>id.length>0));
setFetchState({
error:null,
candidates:answer.models.map((model)=>({
...model,
picked:typeof model.id==="string"&&model.id.trim().length>0
&&!known.has(model.id.trim()),
})),
});
}finally{
setSaving(false);
}
};
const discoveryIntent=react.useMemo(()=>({manualIntent:false,autoFallback:null}),[session]);
const noteAutoFallback=(models)=>{
if(discoveryIntent.autoFallback!==null)return;
discoveryIntent.autoFallback=Array.isArray(models)?models.map((model)=>({...model})):[];
};
const isUneditedAutoFallbackRow=(row)=>{
const snapshot=discoveryIntent.autoFallback;
if(!Array.isArray(snapshot)||!config.isPlainObject(row))return false;
const id=typeof row.id==="string"?row.id.trim():"";
if(id.length===0)return false;
return snapshot.some((entry)=>{
if(!config.isPlainObject(entry))return false;
const entryId=typeof entry.id==="string"?entry.id.trim():"";
return entryId===id&&config.jsonEqual(entry,row);
});
};
const pruneUneditedAutoFallbackRows=()=>{
const snapshot=discoveryIntent.autoFallback;
if(!Array.isArray(snapshot)||snapshot.length===0)return null;
const rows=session.modelRows;
const kept=rows.filter((row)=>!isUneditedAutoFallbackRow(row));
return kept.length===rows.length?null:kept;
};
react.useEffect(()=>{
if(!open||row.declared===true||namespace?.ns==="llm-deepseek")return undefined;
let active=true;
discoveryIntent.autoFallback=null;
discoveryIntent.manualIntent=false;
void host.operations.discoverModels(namespace.ns,{provider:row.provider}).then((answer)=>{
if(discoveryIntent.manualIntent)return;
if(!active||answer.kind!=="found"||answer.models.length===0||session.modelRows.length>0)return;
session.setFallbackModels(answer.models);
noteAutoFallback(session.modelRows);
setDraftRevision((value)=>value+1);
}).catch(()=>{
});
return()=>{active=false;};
},[host,namespace?.ns,open,row.declared,row.provider,session]);
const{toggleCandidate,toggleVisibleCandidates,closeModelPicker}=buildCandidateControls({setFetchState,setCandidateQuery});
const adoptPicked=()=>{
const picked=(fetchState?.candidates??[]).filter((candidate)=>candidate.picked===true);
if(picked.length===0)return;
edit((draft)=>({
...draft,
models:config.adoptModels(session.modelRows,picked),
}));
closeModelPicker();
};
if(!config.providerEditable(row,namespace))return null;
if(!open){
return renderProviderCardCollapsed({card,row,removable,saving,onRemove,setOpen,setError,setSaved,setConflict});
}
const modelRows=renderProviderModelRows(card,{
disabled,edit,patchRow,toggleRow,toggleEffort,toggleInput,config,session,
});
return renderProviderCardExpanded({
card,row,config,session,host,disabled,saving,saved,error,conflict,keyDraft,
fetchState,candidateQuery,modelRows,setKeyDraft,setOpen,setSaved,setError,setConflict,
setExpandedRows,setFetchState,setDraftRevision,setCandidateQuery,
edit,apply,cancel,fetchModels,toggleCandidate,toggleVisibleCandidates,closeModelPicker,adoptPicked,
});
}
global[SYMBOL]=Object.freeze({
ModelConfigDisclosure,ModelProviderCard,bindClientRuntime,
});
})(globalThis);
/* source: client-provider-card.js */
(function installClientProviderCard(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-provider-card");
const clientModelConfigHostSymbol=Symbol.for("dsh-expert-group/client-model-config-host");
const clientModelConfigHost=global[clientModelConfigHostSymbol]||{};
const clientModelViewsBSymbol=Symbol.for("dsh-expert-group/client-model-views-b");
const clientModelViewsB=global[clientModelViewsBSymbol]||{};
const{
ModelDiscoveryDialog,renderModelRow,toggleCandidateOf,toggleIndexInSet,toggleVisibleCandidatesOf,
}=clientModelViewsB;
const{CUSTOM_ROUTE_PROBE}=clientModelConfigHost;
let react=null;
function bindClientRuntime(host){
react=host.react??null;
}
function renderCustomProviderModelSection(context){
const{
card,config,schemaInfo,modelRows,profileDisabled,fetching,canFetchModels,
fetchModels,patchRow,toggleRow,setModels,fetchState,
}=context;
return react.createElement("div",{className:"deg_mc_models"},
react.createElement("div",{className:"deg_mc_models_head"},
react.createElement("span",{className:"deg_mc_models_title"},"模型"),
react.createElement("span",{className:"deg_mc_models_meta"},"至少配置一个模型"),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:!canFetchModels||fetching,
"data-deg-create-fetch-models":"true",
onClick:()=>{void fetchModels();},
},fetching?"获取中…":"获取可用模型")),
card.models.length===0
?react.createElement("p",{className:"deg_mc_hint"},"还没有模型。")
:react.createElement("div",{className:"deg_mc_model"},card.models.map((model)=>renderModelRow(model,{
key:"create-model-"+String(model.index),
attributes:{"data-deg-create-model-index":model.index},
idAttributes:{"data-deg-create-model-id":model.index},
disabled:profileDisabled,
idLabel:"自定义 provider 模型 ID ",
nameLabel:"自定义 provider 模型显示名 ",
parseCapacity:config.parseCapacity,
onChange:patchRow,
onToggleAdvanced:toggleRow,
onRemove:(index)=>setModels(config.removeModelRow(modelRows,index)),
onEffort:(index,level)=>{
const selection=config.effortSelectionFor(modelRows[index]);
setModels(config.setModelEffortSelection(modelRows,index,{...selection,[level]:selection[level]!==true}));
},
onInput:(index,modality)=>{
const selected=config.modelInputOf(modelRows[index],schemaInfo.defaultInput);
const next=selected.includes(modality)?selected.filter((value)=>value!==modality):[...selected,modality];
setModels(config.setModelInputSelection(modelRows,index,next));
},
}))),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:profileDisabled,
"data-deg-create-add-model":"true",
onClick:()=>setModels(config.appendModelRow(modelRows)),
},"添加模型"),
config.isNonEmptyString(card.modelsError)
?react.createElement("p",{className:"deg_mc_error",role:"alert","data-deg-create-error":"models"},card.modelsError)
:null);
}
function renderCustomProviderCard(context){
const{
card,config,schemaInfo,draft,profileDisabled,disabled,saving,fetching,canFetchModels,
fetchModels,edit,patchRow,toggleRow,setModels,modelRows,fetchState,candidateQuery,
setCandidateQuery,toggleCandidate,toggleVisibleCandidates,closeModelPicker,adoptFetchedModels,
onClose,submit,
}=context;
return react.createElement("div",{className:"deg_mc_create","data-deg-custom-provider":"true"},
react.createElement("div",{className:"deg_mc_create_head"},
react.createElement("span",{className:"deg_mc_create_title"},card.title)),
react.createElement("label",{className:"deg_mc_field_row"},
react.createElement("span",{className:"deg_mc_field_label"},"路由 ID"),
react.createElement("input",{
className:"deg_mc_input"+(card.routeId.error===null?"":" deg_mc_field_error"),
type:"text",
value:card.routeId.value,
disabled:profileDisabled,
placeholder:"例如 my-gateway",
"data-deg-create-route":"true",
"aria-label":"自定义 provider 路由 ID",
onChange:(event)=>edit({routeId:event.target.value}),
}),
card.routeId.credentialRef.length===0
?null
:react.createElement("span",{className:"deg_mc_hint"},"凭据引用："+card.routeId.credentialRef),
renderFieldMessage(config,card,"routeId")),
react.createElement("label",{className:"deg_mc_field_row"},
react.createElement("span",{className:"deg_mc_field_label"},"显示名"),
react.createElement("input",{
className:"deg_mc_input"+(card.displayName.error===null?"":" deg_mc_field_error"),
type:"text",
value:card.displayName.value,
disabled:profileDisabled,
placeholder:"留空则使用路由 ID",
"data-deg-create-name":"true",
"aria-label":"自定义 provider 显示名",
onChange:(event)=>edit({displayName:event.target.value}),
}),
renderFieldMessage(config,card,"displayName")),
react.createElement("label",{className:"deg_mc_field_row"},
react.createElement("span",{className:"deg_mc_field_label"},"Base URL"),
react.createElement("input",{
className:"deg_mc_input"+(card.baseUrl.error===null?"":" deg_mc_field_error"),
type:"text",
value:card.baseUrl.value,
disabled:profileDisabled,
placeholder:card.baseUrl.placeholder,
"data-deg-create-base-url":"true",
"aria-label":"自定义 provider Base URL",
onChange:(event)=>edit({baseURL:event.target.value}),
}),
renderFieldMessage(config,card,"baseUrl")),
react.createElement("label",{className:"deg_mc_field_row"},
react.createElement("span",{className:"deg_mc_field_label"},"协议"),
react.createElement("select",{
className:"deg_mc_select"+(card.protocol.error===null?"":" deg_mc_field_error"),
value:card.protocol.value,
disabled:profileDisabled,
"data-deg-create-protocol":"true",
"aria-label":"自定义 provider 协议",
onChange:(event)=>edit({api:event.target.value}),
},
react.createElement("option",{value:""},"选择协议"),
card.protocol.options.map((option)=>react.createElement("option",{key:option.value,value:option.value},option.label))),
renderFieldMessage(config,card,"api")),
react.createElement("label",{className:"deg_mc_field_row"},
react.createElement("span",{className:"deg_mc_field_label"},"API Key"),
react.createElement("input",{
className:"deg_mc_input",
type:card.apiKey.type,
autoComplete:card.apiKey.autoComplete,
value:card.apiKey.value,
disabled:disabled||card.apiKey.disabled,
placeholder:card.apiKey.placeholder,
"data-deg-create-api-key":"true",
"aria-label":"自定义 provider API Key",
onChange:(event)=>edit({apiKey:event.target.value}),
}),
react.createElement("span",{className:"deg_mc_hint"},"API Key 只写入 credentials 服务，不进入 settings 快照，保存后不回显明文。")),
renderCustomProviderModelSection(context),
config.isNonEmptyString(fetchState?.error)
?react.createElement("p",{className:"deg_mc_error",role:"alert","data-deg-create-fetch-error":"true"},fetchState.error)
:null,
card.error===null||card.modelsError===card.error
?null
:react.createElement("p",{className:"deg_mc_error",role:"alert","data-deg-create-card-error":"true"},card.error),
react.createElement("div",{className:"deg_mc_create_footer"},
react.createElement("span",{className:"deg_mc_status deg_settings_status",role:"status"},
card.submitted?"配置已保存":""),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:saving||fetching,
"data-deg-create-cancel":"true",
onClick:()=>{onClose(draft.settingsCommitted);},
},"取消"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
disabled,
"data-deg-create-submit":"true",
onClick:()=>{void submit();},
},saving?"创建中…":(card.submitted?"重试保存 API Key":"创建")),
fetchState!==null&&Array.isArray(fetchState.candidates)
?react.createElement(ModelDiscoveryDialog,{
candidates:fetchState.candidates,
query:candidateQuery,
onQueryChange:setCandidateQuery,
onToggle:toggleCandidate,
onToggleVisible:toggleVisibleCandidates,
onClose:closeModelPicker,
onAdopt:adoptFetchedModels,
})
:null));
}
function renderFieldMessage(config,card,key){
return config.isNonEmptyString(card[key]?.error)?react.createElement(
"span",
{className:"deg_mc_field_message",role:"alert","data-deg-create-error":key},
card[key].error,
):null;
}
function CustomProviderCard({draft,protocols,host,onClose,onCreated,pageWritable,profileBasePath,directoryRows,liveRevision,fenceState}){
const[fetching,setFetching]=react.useState(false);
const config=host.config;
const[expandedRows,setExpandedRows]=react.useState(()=>new Set());
const[,setDraftRevision]=react.useState(0);
const[saving,setSaving]=react.useState(false);
const[error,setError]=react.useState(null);
const[errors,setErrors]=react.useState({});
const[fetchState,setFetchState]=react.useState(null);
const[candidateQuery,setCandidateQuery]=react.useState("");
const schemaInfo=react.useMemo(()=>{
const info=host.settingsSchemaInfo("llm-pi-ai");
return{
...info,
protocols:config.protocolChoices(info.root,CUSTOM_ROUTE_PROBE,host.adapter,[]),
};
},[host,config]);
const card=config.buildCustomCardModel({
draft:draft.draft,
protocols:Array.isArray(protocols)&&protocols.length>0?protocols:schemaInfo.protocols,
errors,
error,
readOnly:pageWritable!==true,
saving,
submitted:draft.settingsCommitted,
credentialRef:draft.credentialRef,
defaultInput:schemaInfo.defaultInput,
expandedRows,
});
const disabled=card.readOnly||saving;
const profileDisabled=card.profileLocked||saving||fetching;
react.useEffect(()=>{
draft.rebase({
takenRoutes:(Array.isArray(directoryRows)?directoryRows:[])
.map((row)=>row.provider)
.filter((id)=>typeof id==="string"),
});
},[draft,directoryRows]);
const fence=fenceState??{settled:true,external:true,epoch:0};
const edit=(patch)=>{
draft.edit(patch);
setDraftRevision((value)=>value+1);
setErrors({});
setError(null);
};
const modelRows=config.modelDraftsOf(draft.draft.models);
const setModels=(models)=>edit({models});
const customBaseURL=typeof draft.draft.baseURL==="string"?draft.draft.baseURL.trim():"";
const canFetchModels=!card.readOnly&&!profileDisabled&&config.validateBaseUrl(customBaseURL)===null;
const patchRow=(index,patch)=>setModels(modelRows.map((model,at)=>(
at===index?config.patchModelDraft(model,patch):model
)));
const toggleRow=(index)=>setExpandedRows((previous)=>toggleIndexInSet(previous,index));
const closeModelPicker=()=>{
setFetchState(null);
setCandidateQuery("");
};
const fetchModels=async()=>{
if(card.readOnly||profileDisabled)return;
const current=draft.draft;
const baseURL=typeof current.baseURL==="string"?current.baseURL.trim():"";
if(config.validateBaseUrl(baseURL)!==null){
setFetchState({error:"请先填写有效的 Base URL",candidates:null});
return;
}
setFetching(true);
setFetchState(null);
setCandidateQuery("");
try{
const api=typeof current.api==="string"&&current.api.length>0?current.api:undefined;
const apiKey=typeof current.apiKey==="string"?current.apiKey.trim():"";
const answer=await host.operations.discoverModels(draft.settingsNs,{
baseURL,
...(api===undefined?{}:{api}),
...(apiKey.length===0?{}:{apiKey}),
});
if(answer.kind==="refused"){
setFetchState({error:answer.message,candidates:null});
return;
}
if(answer.models.length===0){
setFetchState({error:"该端点没有返回任何模型",candidates:null});
return;
}
const known=new Set(config.modelDraftsOf(draft.draft.models)
.map((model)=>(typeof model.id==="string"?model.id.trim():""))
.filter((id)=>id.length>0));
setFetchState({
error:null,
candidates:answer.models.map((model)=>({
...model,
picked:typeof model.id==="string"&&model.id.length>0&&!known.has(model.id),
})),
});
}finally{
setFetching(false);
}
};
const toggleCandidate=(id)=>setFetchState((previous)=>toggleCandidateOf(previous,id));
const toggleVisibleCandidates=(ids)=>setFetchState((previous)=>toggleVisibleCandidatesOf(previous,ids));
const adoptFetchedModels=()=>{
const candidates=fetchState?.candidates;
const picked=(Array.isArray(candidates)?candidates:[]).filter((candidate)=>candidate.picked===true);
edit({models:config.adoptModels(config.modelDraftsOf(draft.draft.models),picked)});
closeModelPicker();
};
const submit=async()=>{
if(disabled)return false;
setSaving(true);
setError(null);
setErrors({});
try{
if(fence.external!==true&&!draft.settingsCommitted&&Number.isSafeInteger(liveRevision)){
draft.rebase({revision:liveRevision});
}
draft.rebase({frozen:true});
fence.settled=true;
const plan=draft.plan();
if(plan.ok!==true){
setErrors(plan.errors??{});
setError(plan.error);
return false;
}
if(plan.phase==="settings"){
const op=Array.isArray(plan.ops)?plan.ops[0]:undefined;
if(op!==undefined){
const sectionCandidate=config.setPath({},profileBasePath,{
[op.path[op.path.length-1]]:op.value,
});
const failure=host.adapter.validate(schemaInfo.root,sectionCandidate);
if(failure!==undefined){
setError("设置校验未通过，已拒绝写入："+failure);
return false;
}
}
const written=await host.writeNamespace({
ns:draft.settingsNs,
ops:plan.ops,
expectedRevision:plan.expectedRevision,
});
if(!written.ok){
setError(written.message);
return false;
}
draft.acceptSettings(written.view,plan.credentialRef);
setDraftRevision((value)=>value+1);
}
if(plan.keyValue!==undefined&&plan.phase!=="done"){
const stored=await host.operations.storeKey(plan.credentialRef,plan.keyValue);
if(stored!==null){
setError("provider 配置已保存，但 API Key 写入失败："+stored);
return false;
}
draft.acceptCredential();
setDraftRevision((value)=>value+1);
}
await host.refreshSettingsView();
onCreated();
return true;
}catch(cause){
setError(cause instanceof Error?cause.message:String(cause));
return false;
}finally{
setSaving(false);
}
};
return renderCustomProviderCard({
card,config,schemaInfo,draft,profileDisabled,disabled,saving,fetching,canFetchModels,
fetchModels,edit,patchRow,toggleRow,setModels,modelRows,fetchState,candidateQuery,
setCandidateQuery,toggleCandidate,toggleVisibleCandidates,closeModelPicker,adoptFetchedModels,
onClose,submit,
});
}
global[SYMBOL]=Object.freeze({
CustomProviderCard,bindClientRuntime,
});
})(globalThis);
/* source: client-focus-return.js */
(function installClientFocusReturn(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-focus-return");
const REMOVE_FOCUS_TARGET_SELECTORS=Object.freeze([
'[data-deg-add-provider="true"]',
'[data-deg-model-config-toggle="true"]',
]);
function removeFocusDocument(){
return typeof document==="undefined"?null:(document??null);
}
function readFocusedElement(documentStub){
if(documentStub===null||documentStub===undefined)return{ok:false,element:null};
try{
if(!("activeElement"in documentStub))return{ok:false,element:null};
const element=documentStub.activeElement;
if(element===undefined)return{ok:false,element:null};
return{ok:true,element};
}catch{
return{ok:false,element:null};
}
}
function closestRemoveFocusScope(trigger){
if(trigger===null||typeof trigger.closest!=="function")return null;
try{
return trigger.closest(".deg_mc_section")??null;
}catch{
return null;
}
}
function isLaidOutRemoveFocusTarget(element){
if(typeof element.checkVisibility==="function"){
try{
if(element.checkVisibility({visibilityProperty:true})===false)return false;
}catch{/* 读面抛错：交给下一个读面，不做无根据的判定。 */}
}
if(typeof element.getClientRects==="function"){
try{
const rects=element.getClientRects();
if(rects!==null&&rects!==undefined&&typeof rects.length==="number"&&rects.length===0)return false;
}catch{/* 同上。 */}
}
return true;
}
function isUsableRemoveFocusTarget(element){
if(element===null||typeof element!=="object")return false;
if(typeof element.focus!=="function")return false;
if(element.isConnected!==true)return false;
if(element.hidden===true)return false;
if(element.disabled===true)return false;
const ariaDisabled=typeof element.getAttribute==="function"
?element.getAttribute("aria-disabled")
:element["aria-disabled"];
if(ariaDisabled==="true"||ariaDisabled===true)return false;
if(!isLaidOutRemoveFocusTarget(element))return false;
return true;
}
function pickRemoveFocusTarget(scope){
if(scope===null||typeof scope.querySelector!=="function")return null;
for(const selector of REMOVE_FOCUS_TARGET_SELECTORS){
let candidate=null;
try{
candidate=scope.querySelector(selector);
}catch{
candidate=null;
}
if(isUsableRemoveFocusTarget(candidate))return candidate;
}
return null;
}
function observeRemoveFocusIntent(documentStub){
const events=["pointerdown","keydown","focusin"];
const registered=[];
let abandoned=false;
let disposed=false;
const markAbandoned=()=>{abandoned=true;};
if(documentStub!==null&&typeof documentStub.addEventListener==="function"){
for(const type of events){
try{
documentStub.addEventListener(type,markAbandoned,true);
registered.push(type);
}catch{/* 登记失败：少观察一类事件，不影响删除语义。 */}
}
}
return{
isAbandoned:()=>abandoned,
dispose(){
if(disposed)return;
disposed=true;
if(documentStub===null||typeof documentStub.removeEventListener!=="function")return;
for(const type of registered){
try{
documentStub.removeEventListener(type,markAbandoned,true);
}catch{/* 摘监听失败：监听随页面销毁一起消失，不影响删除结果。 */}
}
registered.length=0;
},
};
}
function createRemoveFocusObservationLedger(){
const observations=new Set();
let closed=false;
return{
add(observation){
if(observation===null||observation===undefined)return;
if(closed){
observation.dispose();
return;
}
observations.add(observation);
},
delete(observation){
observations.delete(observation);
},
close(){
if(closed)return;
closed=true;
for(const observation of observations)observation.dispose();
observations.clear();
},
};
}
function restoreRemoveFocus({documentStub,trigger,scope,observation}){
try{
if(documentStub===null||trigger===null||scope===null)return;
if(observation?.isAbandoned?.()===true)return;
if(scope.isConnected!==true)return;
const focusRead=readFocusedElement(documentStub);
if(focusRead.ok!==true)return;
const active=focusRead.element;
const body=documentStub.body??null;
if(active!==null&&active!==trigger&&active!==body)return;
const target=pickRemoveFocusTarget(scope);
if(target===null)return;
target.focus();
}catch{/* 焦点不可用时保持删除结果不变。 */}
}
global[SYMBOL]=Object.freeze({
removeFocusDocument,readFocusedElement,closestRemoveFocusScope,isUsableRemoveFocusTarget,pickRemoveFocusTarget,observeRemoveFocusIntent,createRemoveFocusObservationLedger,restoreRemoveFocus,
});
})(globalThis);
/* source: client-model-section.js */
(function installClientModelSection(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-model-section");
const clientModelViewsASymbol=Symbol.for("dsh-expert-group/client-model-views-a");
const clientModelViewsA=global[clientModelViewsASymbol]||{};
const clientModelViewsBSymbol=Symbol.for("dsh-expert-group/client-model-views-b");
const clientModelViewsB=global[clientModelViewsBSymbol]||{};
const clientProviderCardSymbol=Symbol.for("dsh-expert-group/client-provider-card");
const clientProviderCard=global[clientProviderCardSymbol]||{};
const clientFocusReturnSymbol=Symbol.for("dsh-expert-group/client-focus-return");
const clientFocusReturn=global[clientFocusReturnSymbol]||{};
const clientModelConfigHostSymbol=Symbol.for("dsh-expert-group/client-model-config-host");
const clientModelConfigHost=global[clientModelConfigHostSymbol]||{};
const{ModelConfigDisclosure,ModelProviderCard}=clientModelViewsA;
const{focusableDialogControls}=clientModelViewsB;
const{CustomProviderCard}=clientProviderCard;
const{
removeFocusDocument,readFocusedElement,closestRemoveFocusScope,isUsableRemoveFocusTarget,
pickRemoveFocusTarget,observeRemoveFocusIntent,createRemoveFocusObservationLedger,restoreRemoveFocus,
}=clientFocusReturn;
const{CUSTOM_PROFILE_BASE_PATH,CUSTOM_PROVIDER_NS,CUSTOM_ROUTE_PROBE}=clientModelConfigHost;
let react=null;
function bindClientRuntime(host){
react=host.react??null;
}
let removeConfirmSeq=0;
function renderRemoveConfirmDialog(removeIntent,handlers){
const{dialogRef,onCancel,onConfirm}=handlers;
if(removeIntent===null)return null;
return react.createElement("div",{
className:"deg_prompt_dialog_backdrop",
onClick:()=>onCancel(),
},
react.createElement("div",{
className:"deg_prompt_dialog",
role:"dialog",
"aria-modal":"true",
"aria-label":"删除 provider 确认",
ref:dialogRef,
onClick:(event)=>event?.stopPropagation?.(),
onKeyDown:(event)=>{
if(removeIntent.phase==="running")return;
if(event?.key==="Escape"){
event.preventDefault?.();
event.stopPropagation?.();
onCancel();
return;
}
if(event?.key!=="Tab")return;
const controls=focusableDialogControls(dialogRef.current??event?.currentTarget??null);
if(controls.length===0)return;
const current=controls.indexOf(typeof document==="undefined"?null:document.activeElement);
const nextIndex=event.shiftKey
?(current<=0?controls.length-1:current-1)
:(current>=controls.length-1?0:current+1);
event.preventDefault?.();
try{controls[nextIndex]?.focus?.();}catch{/* 无 DOM 焦点时保持可点击按钮。 */}
},
},
react.createElement("h3",null,"删除 provider"),
react.createElement("p",null,"确定删除 provider「"+removeIntent.label+"」及其配置吗？"),
removeIntent.error===null?null:react.createElement("p",{
className:"deg_remove_confirm_error",
role:"alert",
"aria-live":"assertive",
},removeIntent.error),
react.createElement("div",{className:"deg_prompt_dialog_actions"},
react.createElement("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"cancel",
"data-deg-remove-cancel":"true",
autoFocus:true,
disabled:removeIntent.phase==="running",
onClick:()=>onCancel(),
},"取消"),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-dialog-action":"confirm",
"data-deg-remove-confirm":"true",
disabled:removeIntent.phase==="running",
onClick:()=>{void onConfirm();},
},removeIntent.phase==="running"?"删除中…":"删除"))));
}
function renderModelConfigBody(context){
const{
section,directory,settingsError,editableRows,viewRevision,configured,host,
roleDefaults,roleLabelOf,load,openRemoveConfirm,adding,addChoice,addable,
setSettingsError,setAdding,setAddChoice,customOpen,customDraft,customProtocols,
pageWritable,customNamespace,customFence,setCustomOpen,setCustomDraft,openCustomProvider,
}=context;
return section.open?react.createElement("div",{className:"deg_mc_body",id:section.disclosure.bodyId},
react.createElement("p",{className:"deg_settings_hint"},section.hint),
directory.status==="error"?react.createElement("p",{className:"deg_mc_error",role:"alert"},directory.error):null,
settingsError===null?null:react.createElement("p",{className:"deg_mc_error",role:"alert"},settingsError),
directory.status==="ready"&&editableRows.length===0
?react.createElement("p",{className:"deg_mc_hint"},"当前宿主没有可配置的 provider。")
:null,
react.createElement("ul",{className:"deg_mc_cards","data-deg-view-revision":viewRevision},
configured.map((row)=>react.createElement(ModelProviderCard,{
key:row.provider+"#"+String(viewRevision),
row,
namespace:host.namespaceView(row.settingsNs),
host,
roleLabels:{defaults:roleDefaults,labelOf:roleLabelOf},
onSaved:()=>{void load();},
onRemove:(event)=>openRemoveConfirm(row,event),
}))),
react.createElement("div",{className:"deg_mc_add"},
adding
?react.createElement(react.Fragment,null,
react.createElement("select",{
className:"deg_mc_select",
value:addChoice,
"aria-label":"选择要添加的 provider",
disabled:directory.status!=="ready",
onChange:(event)=>setAddChoice(event.target.value),
},
react.createElement("option",{value:""},"选择 provider"),
addable.map((row)=>react.createElement("option",{key:row.provider,value:row.provider},row.displayName))),
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary",
disabled:addChoice===""||directory.status!=="ready",
"data-deg-confirm-add-provider":"true",
onClick:async()=>{
const row=addable.find((candidate)=>candidate.provider===addChoice);
if(row===undefined)return;
const written=await host.writeNamespace({
ns:row.settingsNs,
ops:[{op:"set",path:[...row.settingsPath],value:{}}],
expectedRevision:host.namespaceView(row.settingsNs)?.revision,
});
if(!written.ok){
setSettingsError(written.message);
return;
}
setAdding(false);
setAddChoice("");
await load();
},
},"添加"),
react.createElement("button",{
type:"button",
className:"deg_btn",
onClick:()=>{setAdding(false);setAddChoice("");},
},"取消"))
:react.createElement("div",{className:"deg_mc_entries"},
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:section.actions.addProvider==="disabled",
"data-deg-add-provider":"true",
onClick:()=>{setAdding(true);setCustomOpen(false);},
},section.entries.addProvider.label),
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:section.actions.addCustom==="disabled",
"data-deg-add-custom-provider":"true",
onClick:openCustomProvider,
},section.entries.addCustom.label))),
customOpen&&customDraft!==null
?react.createElement(CustomProviderCard,{
draft:customDraft,
protocols:customProtocols,
host,
pageWritable,
profileBasePath:[...CUSTOM_PROFILE_BASE_PATH],
directoryRows:directory.rows,
liveRevision:customNamespace?.revision,
fenceState:customFence.current,
onClose:(committed)=>{
setCustomOpen(false);
setCustomDraft(null);
if(committed===true)void load();
},
onCreated:()=>{
setCustomOpen(false);
setCustomDraft(null);
void load();
},
})
:null,
react.createElement("button",{
type:"button",
className:"deg_btn",
disabled:section.actions.reload==="disabled",
"data-deg-reload-providers":"true",
onClick:()=>{void load();},
},directory.status==="loading"?"读取中…":"重新读取 provider 目录"))
:null;
}
function renderModelConfigSection(context){
const{section,body,open,removeConfirmDialog,setOpen}=context;
return react.createElement("div",{className:"deg_mc_section"},
react.createElement(ModelConfigDisclosure,{section,onToggle:()=>setOpen((value)=>!value)}),
body,
open?removeConfirmDialog:null);
}
function ModelConfigSection({host,roleDefaults,roleLabelOf,defaultOpen}){
const config=host.config;
const[open,setOpen]=react.useState(defaultOpen===true);
const[directory,setDirectory]=react.useState({status:"idle",rows:[],error:null});
const[adding,setAdding]=react.useState(false);
const[addChoice,setAddChoice]=react.useState("");
const[settingsError,setSettingsError]=react.useState(null);
const[removeIntent,setRemoveIntent]=react.useState(null);
const[viewRevision,setViewRevision]=react.useState(0);
const[hostRevision,setHostRevision]=react.useState(()=>(
typeof host.getSnapshot==="function"?host.getSnapshot():0
));
const[hostInvalidation,setHostInvalidation]=react.useState(()=>(
typeof host.getInvalidation==="function"?host.getInvalidation():0
));
react.useEffect(()=>{
if(typeof host.subscribe!=="function")return undefined;
return host.subscribe(()=>{
setHostRevision((previous)=>(
typeof host.getSnapshot==="function"?host.getSnapshot():previous+1
));
setHostInvalidation((previous)=>(
typeof host.getInvalidation==="function"?host.getInvalidation():previous+1
));
});
},[host]);
const providerSections=react.useMemo(()=>config.providerListSections(
directory.rows,
(ns)=>host.namespaceView(ns),
),[config,host,directory.rows,viewRevision,hostRevision]);
const customNamespace=host.namespaceView(CUSTOM_PROVIDER_NS);
const customSchemaInfo=react.useMemo(
()=>host.settingsSchemaInfo(CUSTOM_PROVIDER_NS),
[host,hostRevision],
);
const customProtocols=react.useMemo(
()=>(config.isPlainObject(customNamespace)
?config.protocolChoices(customSchemaInfo.root,CUSTOM_ROUTE_PROBE,host.adapter,[])
:[]),
[config,customSchemaInfo,host.adapter,customNamespace],
);
const pageWritable=host.readView().writable===true;
const[customOpen,setCustomOpen]=react.useState(false);
const[customDraft,setCustomDraft]=react.useState(null);
const customFence=react.useRef({settled:false,external:false,epoch:0,openedAt:0});
const openCustomProvider=()=>{
customFence.current={
settled:false,
external:false,
epoch:0,
openedAt:typeof host.getInvalidation==="function"?host.getInvalidation():0,
};
if(typeof host.refreshSettingsView==="function")void host.refreshSettingsView();
const namespace=host.namespaceView(CUSTOM_PROVIDER_NS);
if(!config.isPlainObject(namespace)||!pageWritable)return;
setAdding(false);
setAddChoice("");
setCustomDraft(config.createCustomProviderDraft({
settingsNs:CUSTOM_PROVIDER_NS,
profileBasePath:[...CUSTOM_PROFILE_BASE_PATH],
revision:namespace.revision,
protocols:config.protocolChoices(
host.settingsSchemaInfo(CUSTOM_PROVIDER_NS).root,
CUSTOM_ROUTE_PROBE,
host.adapter,
),
takenRoutes:directory.rows.map((row)=>row.provider).filter((id)=>typeof id==="string"),
models:[],
}));
setCustomOpen(true);
};
react.useEffect(()=>{
if(!customOpen||customDraft===null)return;
if(hostInvalidation<=customFence.current.openedAt)return;
customFence.current.external=true;
customFence.current.epoch+=1;
},[customOpen,customDraft,hostInvalidation]);
react.useEffect(()=>{
if(!customOpen||customDraft===null)return;
if(typeof customDraft.revision==="number")return;
const namespace=host.namespaceView(CUSTOM_PROVIDER_NS);
if(config.isPlainObject(namespace))customDraft.rebase({revision:namespace.revision});
},[config,customOpen,customDraft,customNamespace,hostRevision]);
const section=config.buildSectionModel({
open,
status:directory.status,
error:settingsError??directory.error,
writable:pageWritable,
configured:providerSections.configured,
addable:providerSections.addable,
protocols:customProtocols,
canCreateCustom:config.canCreateCustomProvider({
namespace:customNamespace,
protocols:customProtocols,
writable:pageWritable,
}),
});
const loadStateRef=react.useRef({running:false,again:false,promise:null});
const runLoad=react.useCallback(async()=>{
setDirectory((previous)=>({...previous,status:"loading",error:null}));
setSettingsError(null);
try{
const rows=await host.operations.listProviderDirectory();
await host.refreshSettingsView();
const refs=rows
.filter((row)=>config.providerEditable(row,host.namespaceView(row.settingsNs)))
.map((row)=>config.credentialRefOf(row,host.namespaceView(row.settingsNs)));
await host.operations.describeCredentials(refs);
setDirectory({status:"ready",rows,error:null});
setSettingsError(host.describeError());
}catch(error){
setDirectory({status:"error",rows:[],error:error instanceof Error?error.message:String(error)});
}finally{
setViewRevision((value)=>value+1);
}
},[config,host]);
const load=react.useCallback(()=>{
const state=loadStateRef.current;
if(state.running){
state.again=true;
return state.promise;
}
state.running=true;
const transaction=(async()=>{
try{
do{
state.again=false;
await runLoad();
}while(state.again);
}finally{
state.running=false;
state.again=false;
state.promise=null;
}
})();
state.promise=transaction;
return transaction;
},[runLoad]);
react.useEffect(()=>{
if(!open)return;
void load();
},[open,load,hostInvalidation]);
const removeFocusObservations=react.useRef(null);
if(removeFocusObservations.current===null){
removeFocusObservations.current=createRemoveFocusObservationLedger();
}
const removeDialogRef=react.useRef(null);
react.useEffect(()=>()=>{
removeFocusObservations.current?.close();
},[]);
react.useEffect(()=>{
if(open)return;
setRemoveIntent((previous)=>(previous!==null&&previous.phase==="confirming"?null:previous));
},[open]);
const editableRows=directory.rows.filter((row)=>config.providerEditable(row,host.namespaceView(row.settingsNs)));
const configured=providerSections.configured.map((entry)=>entry.row);
const addable=providerSections.addable.map((entry)=>entry.row);
const openRemoveConfirm=(row,event)=>{
const label=typeof row.displayName==="string"&&row.displayName.length>0?row.displayName:row.provider;
const trigger=event?.currentTarget??null;
const documentStub=removeFocusDocument();
const triggerFocusRead=readFocusedElement(documentStub);
const ownsFocus=trigger!==null
&&triggerFocusRead.ok===true
&&triggerFocusRead.element===trigger;
const scope=ownsFocus?closestRemoveFocusScope(trigger):null;
removeConfirmSeq+=1;
setRemoveIntent({token:removeConfirmSeq,row,label,trigger,scope,ownsFocus,phase:"confirming",error:null});
};
const cancelRemoveConfirm=()=>{
const intent=removeIntent;
if(intent!==null&&intent.phase==="running")return;
setRemoveIntent(null);
if(intent===null||intent.ownsFocus!==true)return;
try{
if(isUsableRemoveFocusTarget(intent.trigger)){
intent.trigger.focus();
return;
}
if(intent.scope!==null&&intent.scope.isConnected===true){
const target=pickRemoveFocusTarget(intent.scope);
if(target!==null)target.focus();
}
}catch{/* 焦点不可用不影响"取消"语义：弹窗已经关掉。 */}
};
const confirmRemoveProvider=async()=>{
const intent=removeIntent;
if(intent===null||intent.phase!=="confirming")return;
const{row,trigger,scope,ownsFocus}=intent;
setRemoveIntent((previous)=>(previous!==null&&previous.token===intent.token
?{...previous,phase:"running",error:null}
:previous));
const documentStub=removeFocusDocument();
const observation=ownsFocus&&scope!==null?observeRemoveFocusIntent(documentStub):null;
if(observation!==null)removeFocusObservations.current?.add(observation);
const fail=(message)=>{
setSettingsError(message);
setRemoveIntent((previous)=>(previous!==null&&previous.token===intent.token
?{...previous,phase:"confirming",error:message}
:previous));
};
try{
const affected=config.rolesAffectedByChange(roleDefaults,{provider:row.provider,removeProvider:true});
if(affected.length>0){
fail(config.reasoningGuardMessage(["（整个 provider）"],affected,roleLabelOf));
return;
}
const namespace=host.namespaceView(row.settingsNs);
const credentialRef=config.credentialRefOf(row,namespace);
if(host.operations.credentialState(credentialRef)?.configured===true){
const removed=await host.operations.removeKey(credentialRef);
if(removed!==null){
fail(removed);
return;
}
}
const written=await host.writeNamespace({
ns:row.settingsNs,
ops:[{op:"unset",path:[...row.settingsPath]}],
expectedRevision:namespace?.revision,
});
if(!written.ok){
fail(written.message);
return;
}
await load();
observation?.dispose();
setRemoveIntent((previous)=>(previous!==null&&previous.token===intent.token?null:previous));
restoreRemoveFocus({documentStub,trigger,scope,observation});
}catch(cause){
fail(cause instanceof Error?cause.message:String(cause));
}finally{
observation?.dispose();
removeFocusObservations.current?.delete(observation);
}
};
const body=renderModelConfigBody({
section,directory,settingsError,editableRows,viewRevision,configured,host,
roleDefaults,roleLabelOf,load,openRemoveConfirm,adding,addChoice,addable,
setSettingsError,setAdding,setAddChoice,customOpen,customDraft,customProtocols,
pageWritable,customNamespace,customFence,setCustomOpen,setCustomDraft,openCustomProvider,
});
const removeConfirmDialog=renderRemoveConfirmDialog(removeIntent,{
dialogRef:removeDialogRef,onCancel:cancelRemoveConfirm,onConfirm:confirmRemoveProvider,
});
return renderModelConfigSection({section,body,open,removeConfirmDialog,setOpen});
}
global[SYMBOL]=Object.freeze({
ModelConfigSection,bindClientRuntime,
});
})(globalThis);
/* source: client-conversation-adapters.js */
(function installClientConversationAdapters(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-conversation-adapters");
let react=null;
let primitives=null;
let RPC_PATH="";
let RPC_CHANNEL="";
let RPC_ENDPOINT="";
function bindClientRuntime(host){
react=host.react??null;
primitives=host.primitives??null;
RPC_PATH=host.RPC_PATH??"";
RPC_CHANNEL=host.RPC_CHANNEL??"";
RPC_ENDPOINT=host.RPC_ENDPOINT??"";
}
async function encodeImageFileForRoute(file){
const mediaType=file?.type;
if(!["image/png","image/jpeg","image/webp","image/gif"].includes(mediaType)){
throw new Error("conversation.sendSession: unsupported image media type");
}
if(typeof file?.arrayBuffer!=="function"){
throw new Error("conversation.sendSession: image File.arrayBuffer is unavailable");
}
const bytes=new Uint8Array(await file.arrayBuffer());
let binary="";
for(let offset=0;offset<bytes.length;offset+=0x8000){
binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
}
const encode=globalThis?.btoa;
if(typeof encode!=="function")throw new Error("conversation.sendSession: btoa is unavailable");
return{
type:"image",
mediaType,
data:encode(binary),
...(typeof file.name==="string"&&file.name!==""?{name:file.name}:{}),
};
}
async function encodeImagesForRoute(attachments){
return Promise.all(attachments.map((attachment)=>encodeImageFileForRoute(attachment.file)));
}
function isPngRouteImage(image){
if(!image||typeof image!=="object"||image.mediaType!=="image/png"||typeof image.data!=="string")return false;
if(image.name!==undefined&&typeof image.name!=="string")return false;
try{
const decode=globalThis?.atob;
const encode=globalThis?.btoa;
if(typeof decode!=="function"||typeof encode!=="function")return false;
const binary=decode(image.data);
if(encode(binary)!==image.data||binary.length<8)return false;
return[137,80,78,71,13,10,26,10].every((byte,index)=>binary.charCodeAt(index)===byte);
}catch{
return false;
}
}
function readRuntimeMethod(runtime,name){
if(runtime===null||runtime===void 0)return undefined;
try{
const method=runtime[name];
return typeof method==="function"?method:undefined;
}catch{
return undefined;
}
}
function resolveDraftAttachmentsCompat(primaryRuntime,fallbackRuntime,ids){
const candidates=[
[primaryRuntime,"resolveDraftAttachments"],
[fallbackRuntime,"resolveDraftAttachments"],
[primaryRuntime,"draftImages"],
[fallbackRuntime,"draftImages"],
];
for(const[runtime,name]of candidates){
const method=readRuntimeMethod(runtime,name);
if(method!==undefined)return{runtime,attachments:method.call(runtime,ids)};
}
throw new Error(
"dsh-expert-group: 当前 DSH 运行时未暴露草稿附件解析 API（resolveDraftAttachments / draftImages），无法提交图片草稿",
);
}
function releaseObservedDraftImages(runtime,attachments,settlement){
if(settlement?.reason!=="observed")return;
if(runtime===null||runtime===void 0)return;
const releaseDraftAttachments=readRuntimeMethod(runtime,"releaseDraftAttachments");
if(releaseDraftAttachments!==undefined){
releaseDraftAttachments.call(runtime,attachments);
return;
}
const releaseDraftAttachment=readRuntimeMethod(runtime,"releaseDraftAttachment");
if(releaseDraftAttachment!==undefined){
attachments.forEach((attachment)=>releaseDraftAttachment.call(runtime,attachment.id));
return;
}
const releaseDraftImages=readRuntimeMethod(runtime,"releaseDraftImages");
if(releaseDraftImages!==undefined){
releaseDraftImages.call(runtime,attachments);
return;
}
const releaseDraftImage=readRuntimeMethod(runtime,"releaseDraftImage");
if(releaseDraftImage!==undefined){
attachments.forEach((attachment)=>releaseDraftImage.call(runtime,attachment.id));
}
}
function waitForImageSubmissionPaint(){
return new Promise((resolve)=>{
if(typeof requestAnimationFrame==="function"){
requestAnimationFrame(()=>setTimeout(resolve,0));
}else{
setTimeout(resolve,0);
}
});
}
const IMAGE_ROUTE_STATES_KEY=Symbol.for("dsh-expert-group.image-submission-route-states");
function imageSubmissionRouteStates(){
const root=globalThis;
const existing=root[IMAGE_ROUTE_STATES_KEY];
if(existing instanceof WeakMap)return existing;
const states=new WeakMap();
Object.defineProperty(root,IMAGE_ROUTE_STATES_KEY,{
value:states,
configurable:false,
enumerable:false,
writable:false,
});
return states;
}
function installImageSubmissionRoute(ctx){
let conversation;
try{conversation=ctx.get("conversation");}catch{return()=>{};}
if(!conversation||typeof conversation.sendSession!=="function")return()=>{};
const states=imageSubmissionRouteStates();
const existing=states.get(conversation);
if(existing!==void 0)return existing.cleanup;
const original=conversation.sendSession;
const rpcRequest=async(request,init={})=>{
const rpc=ctx.connection?.rpc;
if(typeof rpc?.call==="function"){
const result=await rpc.call(RPC_CHANNEL,RPC_ENDPOINT,request,init.signal);
return{
ok:result?.ok===true,
status:result?.ok===true?200:500,
async json(){return result?.ok===true?result.value:{ok:false,error:result?.error};},
};
}
return fetch(RPC_PATH,{
...init,
method:init.method??"POST",
credentials:"same-origin",
headers:{
"content-type":"application/json",
...(init.headers??{}),
"x-dsh-expert-group-image":"1",
},
body:JSON.stringify(request),
});
};
const state={original,cleanup:void 0,active:true,observerFinalizers:new Set()};
const wrapped=async function(session,text,imageIds,mode,signal){
const sessionSnapshot=session?.getSnapshot?.();
if(!Array.isArray(imageIds)||imageIds.length===0||sessionSnapshot===undefined||sessionSnapshot.subagent!=null){
return original.call(this,session,text,imageIds,mode,signal);
}
const resolved=resolveDraftAttachmentsCompat(this,conversation,imageIds);
const runtime=resolved.runtime;
const attachments=resolved.attachments;
if(!Array.isArray(attachments)||attachments.length!==imageIds.length){
throw new Error("conversation.sendSession: one or more draft images are no longer available");
}
let finishRetirement;
const retirement=new Promise((resolve)=>{finishRetirement=resolve;});
const submission=session.beginSubmission({
mode,
text,
attachments:attachments.map((attachment)=>({
type:"image",
value:{
previewUrl:attachment.previewUrl,
...(typeof attachment.file?.name==="string"&&attachment.file.name!==""?{name:attachment.file.name}:{}),
...(attachment.width===undefined?{}:{width:attachment.width}),
...(attachment.height===undefined?{}:{height:attachment.height}),
},
})),
onRetire:(settlement)=>{
try{
releaseObservedDraftImages(runtime,attachments,settlement);
}finally{
finishRetirement?.(settlement);
}
},
});
let observerCleanup;
const finishObserverChild=(action)=>{
if(observerCleanup===undefined)return;
const pending=observerCleanup;
observerCleanup=undefined;
state.observerFinalizers.delete(pending.finalizer);
void rpcRequest({
action,
sessionId:pending.sessionId,
childId:pending.childId,
cleanupToken:pending.cleanupToken,
},{}).catch(()=>{});
};
const cancelObserverChild=()=>finishObserverChild("image-route-observer-cancel");
const releaseObserverChild=()=>finishObserverChild("image-route-observer-release");
try{
await waitForImageSubmissionPaint();
const encoded=await encodeImagesForRoute(attachments);
const response=await rpcRequest({
action:"image-route",sessionId:session.sessionId,text,images:encoded,
},{signal});
let payload;
try{payload=await response.json();}catch{payload=null;}
if(!response.ok||payload?.ok!==true){
throw new Error(payload?.error?.message??("图片路由失败（HTTP "+response.status+"）"));
}
const routeClaim=typeof payload.routeClaim==="string"?payload.routeClaim:"";
const assertRouteClaim=async(action)=>{
const checked=await rpcRequest({
action,sessionId:session.sessionId,routeClaim,
},{signal});
let body;
try{body=await checked.json();}catch{body=null;}
if(!checked.ok||body?.ok!==true){
throw new Error(body?.error?.message
??"模型路由在图片提交期间发生变化，已放弃本次图片提交；请重新发送");
}
};
let content;
if(payload.target==="main"){
if(routeClaim.length>0)await assertRouteClaim("image-route-validate");
const images=Array.isArray(payload.images)?payload.images:[];
if(images.length!==encoded.length||!images.every(isPngRouteImage)){
throw new Error("Host 必须返回与提交数量一致的真实 PNG 图片");
}
content=[
...images.map((image)=>({type:"image",mediaType:image.mediaType,data:image.data,name:image.name})),
...(text===""?[]:[{type:"text",text}]),
];
}else if(payload.target==="observer"){
if(routeClaim.length===0){
throw new Error("Host 不支持安全的 Observer 图片提交，请升级插件/Host 后重试");
}
await assertRouteClaim("image-route-validate");
const committed=await rpcRequest({
action:"image-route-observer-commit",sessionId:session.sessionId,routeClaim,
},{signal});
let commitBody;
try{commitBody=await committed.json();}catch{commitBody=null;}
if(!committed.ok||commitBody?.ok!==true){
throw new Error(commitBody?.error?.message
??"Observer 图片提交未完成，已放弃本次提交；请重新发送");
}
const childId=typeof commitBody.childId==="string"?commitBody.childId:"";
const cleanupToken=typeof commitBody.cleanupToken==="string"?commitBody.cleanupToken:"";
if(childId.length>0&&cleanupToken.length>0){
const finalizer=()=>cancelObserverChild();
observerCleanup={sessionId:session.sessionId,childId,cleanupToken,finalizer};
state.observerFinalizers.add(finalizer);
}
const notice="用户图片已交由 Observer 做纯视觉分析（仅描述图片内容、可见文字、布局、状态与异常；未向 Observer 传递任何用户文字）。Observer 的视觉报告会作为主代理上下文反馈回本会话；请保留用户的原始任务并继续处理，收到视觉报告后再综合，不要把本次提交当作任务已完成。";
content=[{type:"text",text:text===""?notice:text+"\n"+notice}];
}else{
throw new Error("Host 返回了未知的图片路由目标");
}
const result=await session.prompt(content,mode,signal,submission.requestId);
if(!result?.ok){
cancelObserverChild();
return{kind:"error"};
}
if((await retirement).reason!=="observed"){
cancelObserverChild();
return{kind:"error"};
}
releaseObserverChild();
return{kind:"success"};
}catch(error){
try{cancelObserverChild();}catch{/* 尽力而为 */}
submission.abandon();
throw error;
}
};
const cleanup=()=>{
if(!state.active)return;
state.active=false;
for(const finalizer of[...state.observerFinalizers]){
state.observerFinalizers.delete(finalizer);
try{finalizer();}catch{/* 尽力而为 */}
}
if(states.get(conversation)!==state)return;
states.delete(conversation);
conversation.sendSession=original;
};
state.cleanup=cleanup;
states.set(conversation,state);
conversation.sendSession=wrapped;
return cleanup;
}
function FullSystemPromptNode(props){
const[open,setOpen]=react.useState(false);
const text=props?.node?.data?.text;
if(typeof text!=="string")return null;
return react.createElement(
primitives.DisclosureRow,
{
icon:react.createElement(primitives.IconBrowseOutlineRegular,{size:14}),
title:"系统提示词",
open,
expandable:true,
expandOnRowClick:true,
onToggle:()=>setOpen((value)=>!value),
className:"deg_full_system_prompt_root",
chevronClassName:"deg_full_system_prompt_chevron",
},
react.createElement(
"div",
{className:"deg_full_system_prompt_body"},
react.createElement("pre",{className:"deg_full_system_prompt"},text),
),
);
}
global[SYMBOL]=Object.freeze({
installImageSubmissionRoute,FullSystemPromptNode,bindClientRuntime,
});
})(globalThis);
/* source: client-nav-icon.js */
(function installClientNavIcon(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-nav-icon");
const clientExpertGroupSidebarSymbol=Symbol.for("dsh-expert-group/client-expert-group-sidebar");
const expertGroupSidebar=global[clientExpertGroupSidebarSymbol]||{};
const DEG_SETTINGS_SECTION_ID="dsh-expert-group";
const DEG_SETTINGS_NAV_ATTR="data-deg-settings-nav";
const DEG_SETTINGS_NAV_NATIVE_ATTR="data-deg-settings-nav-native";
const DEG_SETTINGS_NAV_ICON_ATTR="data-deg-settings-nav-icon";
const DEG_SETTINGS_NAV_STROKE_FALLBACK="1.3";
const DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS=Object.freeze([
"M6 8.25C7.51878 8.25 8.75 7.01878 8.75 5.5C8.75 3.98122 7.51878 2.75 6 2.75C4.48122 2.75 3.25 3.98122 3.25 5.5C3.25 7.01878 4.48122 8.25 6 8.25Z",
"M1 14.5C1 11.5 3.5 10.25 6 10.25C8.5 10.25 11 11.5 11 14.5",
"M10.5 2.9C11.65 3.35 12.45 4.35 12.45 5.5C12.45 6.65 11.65 7.65 10.5 8.1",
"M12.4 10.6C13.9 11.3 15 12.6 15 14.5",
]);
const DEG_SETTINGS_NAV_ICON_PATHS=(()=>{
const shared=expertGroupSidebar?.BRAND_ICON_PATHS;
if(Array.isArray(shared)&&shared.length>0&&shared.every((item)=>typeof item==="string"))return shared;
return DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
})();
function isDegSettingsNavRow(element){
if(element===null||typeof element!=="object")return false;
try{
if(typeof element.textContent!=="string"||element.textContent.trim()!==DEG_SETTINGS_SECTION_ID)return false;
if(typeof element.querySelector!=="function")return false;
const native=element.querySelector("svg");
return native!==null&&native!==void 0;
}catch{
return false;
}
}
function createDegSettingsNavIcon(doc,strokeWidth){
const svg=doc.createElementNS("http://www.w3.org/2000/svg","svg");
svg.setAttribute(DEG_SETTINGS_NAV_ICON_ATTR,"");
svg.setAttribute("width","16");
svg.setAttribute("height","16");
svg.setAttribute("viewBox","0 0 16 16");
svg.setAttribute("fill","none");
svg.setAttribute("stroke","currentColor");
svg.setAttribute("stroke-width",strokeWidth);
svg.setAttribute("aria-hidden","true");
for(const d of DEG_SETTINGS_NAV_ICON_PATHS){
const path=doc.createElementNS("http://www.w3.org/2000/svg","path");
path.setAttribute("d",d);
path.setAttribute("stroke","currentColor");
path.setAttribute("fill","none");
svg.appendChild(path);
}
return svg;
}
function installDegSettingsNavIcon(){
const doc=typeof document!=="undefined"?document:null;
const root=doc?.body??doc?.documentElement??null;
if(doc===null||root===null||typeof doc.querySelectorAll!=="function")return()=>{};
let observer=null;
let disposed=false;
const syncRow=(row)=>{
if(typeof row.querySelectorAll!=="function"||typeof row.setAttribute!=="function")return;
const nativeSvgs=[];
let ownIcon=null;
for(const svg of row.querySelectorAll("svg")){
if(typeof svg.getAttribute!=="function")continue;
if(svg.getAttribute(DEG_SETTINGS_NAV_ICON_ATTR)!==null)ownIcon=svg;
else nativeSvgs.push(svg);
}
if(ownIcon===null){
if(typeof doc.createElementNS!=="function"||typeof row.insertBefore!=="function")return;
const native=nativeSvgs[0];
const inherited=native===undefined?null:native.getAttribute("stroke-width");
const strokeWidth=typeof inherited==="string"&&inherited.trim()!==""
?inherited
:DEG_SETTINGS_NAV_STROKE_FALLBACK;
ownIcon=createDegSettingsNavIcon(doc,strokeWidth);
row.insertBefore(ownIcon,row.firstChild??null);
}
for(const svg of nativeSvgs)svg.setAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR,"");
row.setAttribute(DEG_SETTINGS_NAV_ATTR,"");
};
const sync=()=>{
if(disposed)return;
try{
for(const dialog of doc.querySelectorAll('[role="dialog"]')){
if(typeof dialog?.querySelectorAll!=="function")continue;
for(const row of dialog.querySelectorAll("button")){
if(isDegSettingsNavRow(row)!==true)continue;
syncRow(row);
}
}
}catch{
}
};
const cleanup=()=>{
try{
for(const node of doc.querySelectorAll("["+DEG_SETTINGS_NAV_ATTR+"]"))node.removeAttribute(DEG_SETTINGS_NAV_ATTR);
for(const node of doc.querySelectorAll("["+DEG_SETTINGS_NAV_NATIVE_ATTR+"]"))node.removeAttribute(DEG_SETTINGS_NAV_NATIVE_ATTR);
for(const node of doc.querySelectorAll("["+DEG_SETTINGS_NAV_ICON_ATTR+"]")){
if(typeof node.remove==="function")node.remove();
}
}catch{
}
};
sync();
const Observer=doc?.defaultView?.MutationObserver
??(typeof globalThis!=="undefined"?globalThis.MutationObserver:void 0);
if(typeof Observer==="function"){
try{
observer=new Observer(()=>{sync();});
observer.observe(root,{childList:true,subtree:true});
}catch{
observer=null;
}
}
return()=>{
if(disposed)return;
disposed=true;
try{
observer?.disconnect();
}catch{
}
observer=null;
cleanup();
};
}
global[SYMBOL]=Object.freeze({
DEG_SETTINGS_SECTION_ID,DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS,DEG_SETTINGS_NAV_ICON_PATHS,isDegSettingsNavRow,installDegSettingsNavIcon,
});
})(globalThis);
/* source: client-plugin-detail.js */
(function installClientPluginDetail(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-plugin-detail");
const clientNativeStatusSymbol=Symbol.for("dsh-expert-group/client-native-status");
const clientNativeStatus=global[clientNativeStatusSymbol]||{};
const clientSettingsNormalizeSymbol=Symbol.for("dsh-expert-group/client-settings-normalize");
const clientSettingsNormalize=global[clientSettingsNormalizeSymbol]||{};
const clientNavIconSymbol=Symbol.for("dsh-expert-group/client-nav-icon");
const clientNavIcon=global[clientNavIconSymbol]||{};
const{STATUS_ROLE_IDS,STATUS_ROLE_LABELS}=clientNativeStatus;
const{useHostMeta}=clientSettingsNormalize;
const{DEG_SETTINGS_SECTION_ID}=clientNavIcon;
let react=null;
function bindClientRuntime(host){
react=host.react??null;
}
const DEG_PLUGIN_DETAIL_SLOT_NAME="plugins.bundle.config";
const DEG_PLUGIN_DETAIL_ENTRY_KEY=DEG_SETTINGS_SECTION_ID;
const DEG_SETTINGS_SIDEBAR_SLOT_NAME="sidebar.settings";
const DEG_SETTINGS_SECTION_SLOT_NAME="settings.section";
const DEG_SETTINGS_OPEN_FAILURE_TEXT=Object.freeze({
"slots-unavailable":"宿主未提供 slot 账本读取面，暂时无法跳转到 DEG 设置",
"sidebar-entry-missing":"未找到设置侧栏入口，暂时无法跳转到 DEG 设置",
"sidebar-entry-ambiguous":"设置侧栏入口不唯一，已停用跳转",
"store-missing":"设置侧栏入口缺少顶层导航 store，已停用跳转",
"open-section-missing":"设置侧栏入口缺少 openSection 动作，已停用跳转",
"section-missing":"DEG 设置分区尚未注册，暂时无法跳转",
"section-ambiguous":"DEG 设置分区注册重复，已停用跳转",
"ledger-unreadable":"Slot 账本读取异常，已停用跳转",
"open-failed":"打开 DEG 设置失败，请手动打开设置页",
});
function readSlotLedger(slots,name){
try{
if(slots===null||typeof slots!=="object"||typeof slots.entries!=="function")return null;
const entries=slots.entries(name);
return Array.isArray(entries)?entries:[];
}catch{
return null;
}
}
function resolveSettingsShellOpenSection(store){
if(store===null||typeof store!=="object")return null;
const direct=store.actions;
if(direct!==null&&typeof direct==="object"&&typeof direct.openSection==="function"){
return direct.openSection.bind(direct);
}
if(typeof store.create!=="function")return null;
let instance=null;
try{
instance=store.create();
}catch{
return null;
}
const actions=instance?.actions;
if(actions===null||typeof actions!=="object"||typeof actions.openSection!=="function")return null;
return actions.openSection.bind(actions);
}
function resolveDegSettingsSectionOpener(ctx){
const unavailable=(reason)=>({
available:false,
reason,
message:DEG_SETTINGS_OPEN_FAILURE_TEXT[reason],
openSection:null,
});
let slots=null;
try{
slots=ctx?.slots??null;
}catch{
slots=null;
}
const sectionEntries=readSlotLedger(slots,DEG_SETTINGS_SECTION_SLOT_NAME);
const sidebarEntries=readSlotLedger(slots,DEG_SETTINGS_SIDEBAR_SLOT_NAME);
if(sectionEntries===null||sidebarEntries===null)return unavailable("slots-unavailable");
let ownSectionCount=0;
let sidebarLength=0;
try{
ownSectionCount=sectionEntries.filter((entry)=>entry?.options?.id===DEG_SETTINGS_SECTION_ID).length;
sidebarLength=sidebarEntries.length;
}catch{
return unavailable("ledger-unreadable");
}
if(ownSectionCount===0)return unavailable("section-missing");
if(ownSectionCount>1)return unavailable("section-ambiguous");
if(sidebarLength===0)return unavailable("sidebar-entry-missing");
if(sidebarLength>1)return unavailable("sidebar-entry-ambiguous");
let store=null;
let openSection=null;
try{
store=sidebarEntries[0]?.store;
if(store!==null&&store!==undefined&&typeof store==="object"){
openSection=resolveSettingsShellOpenSection(store);
}
}catch{
return unavailable("ledger-unreadable");
}
if(store===null||store===undefined||typeof store!=="object")return unavailable("store-missing");
if(openSection===null)return unavailable("open-section-missing");
return{available:true,reason:null,message:null,openSection};
}
function resolvePluginDetailRoleStatus(hostMeta,hostMetaError){
if(hostMeta===null&&hostMetaError===null)return{status:"loading",roles:null};
const configured=hostMeta!==null&&typeof hostMeta==="object"
?(Array.isArray(hostMeta.activeRoles)?hostMeta.activeRoles:(Array.isArray(hostMeta.roles)?hostMeta.roles:null))
:null;
if(configured===null)return{status:"unavailable",roles:null};
const enabled=configured.filter((role)=>STATUS_ROLE_IDS.includes(role));
if(hostMeta.enableObserver===true&&!enabled.includes("observer"))enabled.push("observer");
return{status:"ready",roles:enabled.filter((role,index)=>enabled.indexOf(role)===index)};
}
function describeDegPluginDetailSummary(input={}){
const settingsStatus=typeof input.settingsStatus==="string"?input.settingsStatus:"loading";
const settingsValue=input.settingsValue;
const catalogReady=input.catalogStatus==="ready";
const catalogGroups=catalogReady&&Array.isArray(input.catalogGroups)?input.catalogGroups:[];
const enabledRoles=Array.isArray(input.enabledRoles)?input.enabledRoles:null;
const requestedRoleStatus=input.roleStatus==="ready"||input.roleStatus==="unavailable"||input.roleStatus==="loading"
?input.roleStatus
:(enabledRoles===null?"loading":"ready");
const roleStatus=requestedRoleStatus==="ready"&&enabledRoles===null?"unavailable":requestedRoleStatus;
const settingsPending=settingsStatus!=="ready";
const defaults=settingsValue!==null&&typeof settingsValue==="object"?settingsValue.defaults:null;
const providerInfoOf=(providerId)=>{
if(providerId.length===0)return{label:"",known:false};
const group=catalogGroups.find((candidate)=>candidate?.id===providerId);
const name=typeof group?.name==="string"&&group.name.trim().length>0?group.name:"";
return name.length>0?{label:name,known:true}:{label:providerId,known:false};
};
const roles=[];
const activeProviders=[];
const seenProviders=new Set();
for(const role of STATUS_ROLE_IDS){
const selection=defaults!==null&&typeof defaults==="object"?defaults[role]:null;
const provider=typeof selection?.provider==="string"&&selection.provider.length>0?selection.provider:"";
const model=typeof selection?.model==="string"?selection.model:"";
const{label:providerLabel,known:providerKnown}=providerInfoOf(provider);
const enabledKnown=roleStatus==="ready";
const enabled=enabledKnown&&enabledRoles.includes(role)===true;
let state;
if(settingsPending||roleStatus==="loading")state="loading";
else if(roleStatus==="unavailable")state="unknown";
else if(enabled!==true)state="disabled";
else if(provider.length===0)state="unconfigured";
else if(model.length===0)state="incomplete";
else state="configured";
let stateText;
if(state==="loading")stateText=settingsStatus==="unavailable"?"配置不可用":"读取中";
else if(state==="unknown")stateText="角色状态未知";
else if(state==="disabled")stateText="未启用";
else if(state==="unconfigured")stateText="未配置";
else if(state==="incomplete")stateText="待选模型";
else stateText="已配置";
if(state==="configured"&&seenProviders.has(provider)!==true){
seenProviders.add(provider);
activeProviders.push({id:provider,label:providerLabel,known:providerKnown});
}
roles.push({
role,
label:STATUS_ROLE_LABELS[role]??role,
enabled,
state,
stateText,
provider,
providerLabel,
providerKnown,
model,
valueText:provider.length===0?"":(model.length>0?providerLabel+" / "+model:providerLabel),
});
}
const statusText=settingsStatus==="unavailable"
?"配置表单不可用，无法读取角色配置。"
:(settingsStatus!=="ready"
?"配置读取中…"
:(roleStatus==="loading"
?"角色状态读取中…"
:(roleStatus==="unavailable"?"角色状态不可用，已停用活跃角色判定。":null)));
const providerIds=activeProviders.map((provider)=>provider.id);
return{
settingsStatus,
roleStatus,
statusText,
roles,
activeProviders,
providerIds,
activeProviderText:activeProviders.length===0
?"无"
:activeProviders.map((provider)=>provider.label).join("、"),
};
}
function DegPluginDetailSummary({settingsForm,modelCatalog,ctx}){
const subscribeSettings=react.useMemo(
()=>(typeof settingsForm?.subscribe==="function"?settingsForm.subscribe.bind(settingsForm):()=>()=>{}),
[settingsForm],
);
const readSettings=react.useMemo(
()=>(typeof settingsForm?.getSnapshot==="function"?settingsForm.getSnapshot.bind(settingsForm):()=>void 0),
[settingsForm],
);
const settingsSnapshot=react.useSyncExternalStore(subscribeSettings,readSettings);
const subscribeCatalog=react.useMemo(
()=>(typeof modelCatalog?.subscribe==="function"?modelCatalog.subscribe.bind(modelCatalog):()=>()=>{}),
[modelCatalog],
);
const readCatalog=react.useMemo(
()=>(typeof modelCatalog?.getSnapshot==="function"?modelCatalog.getSnapshot.bind(modelCatalog):()=>void 0),
[modelCatalog],
);
const catalogState=react.useSyncExternalStore(subscribeCatalog,readCatalog);
const[hostMeta,,hostMetaError]=useHostMeta(ctx);
const roleStatus=react.useMemo(
()=>resolvePluginDetailRoleStatus(hostMeta,hostMetaError),
[hostMeta,hostMetaError],
);
const[failure,setFailure]=react.useState(null);
react.useEffect(()=>{
try{
void modelCatalog?.load?.();
}catch{
}
},[modelCatalog]);
const model=describeDegPluginDetailSummary({
settingsStatus:typeof settingsSnapshot?.status==="string"?settingsSnapshot.status:"loading",
settingsValue:settingsSnapshot?.value,
catalogStatus:typeof catalogState?.status==="string"?catalogState.status:"idle",
catalogGroups:catalogState?.groups,
roleStatus:roleStatus.status,
enabledRoles:roleStatus.roles,
});
const capability=resolveDegSettingsSectionOpener(ctx);
const noteText=failure?.message??(capability.available===true?null:capability.message);
const noteReason=failure?.reason??(capability.available===true?null:capability.reason);
const openSettings=()=>{
const current=resolveDegSettingsSectionOpener(ctx);
if(current.available!==true){
setFailure({reason:current.reason,message:current.message});
return;
}
const failClosed=()=>{
setFailure({reason:"open-failed",message:DEG_SETTINGS_OPEN_FAILURE_TEXT["open-failed"]});
};
let result;
try{
result=current.openSection(DEG_SETTINGS_SECTION_ID);
}catch{
failClosed();
return;
}
setFailure(null);
if(result===null||(typeof result!=="object"&&typeof result!=="function"))return;
let then=null;
try{
then=result.then;
}catch{
failClosed();
return;
}
if(typeof then!=="function")return;
try{
then.call(result,undefined,failClosed);
}catch{
failClosed();
}
};
return react.createElement(
"section",
{className:"deg_pd","data-deg-plugin-summary":"true","aria-label":"DEG 配置摘要"},
react.createElement("h4",{className:"deg_pd_title"},"DEG 配置摘要"),
react.createElement(
"div",
{className:"deg_pd_providers"},
react.createElement("span",{className:"deg_pd_label"},"活跃角色使用的 Provider"),
react.createElement("span",{
className:"deg_pd_providers_list",
"data-deg-active-providers":model.providerIds.join("|"),
},model.activeProviders.length===0
?react.createElement("span",{className:"deg_pd_empty"},model.activeProviderText)
:model.activeProviders.map((provider)=>react.createElement("span",{
key:provider.id,
className:"deg_pd_tag",
"data-deg-active-provider":provider.id,
"data-deg-provider-known":provider.known?"true":"false",
title:provider.known?undefined:"模型目录未提供该 provider 的显示名，显示原始 id",
"aria-label":provider.known?undefined:provider.label+"（未知 Provider）",
},provider.label))),
),
react.createElement("div",{
className:"deg_pd_roles_header",
"aria-hidden":"true",
},
react.createElement("span",null,"角色"),
react.createElement("span",null,"Provider / 模型"),
react.createElement("span",null,"状态"),
),
react.createElement("ul",{
className:"deg_pd_roles",
"aria-label":"六个角色的 Provider、模型和配置状态",
"data-deg-roles":model.roles.map((role)=>role.role).join(","),
},model.roles.map((role)=>react.createElement(
"li",
{
key:role.role,
className:"deg_pd_role",
"data-deg-role":role.role,
"data-deg-role-state":role.state,
"data-deg-role-provider":role.provider,
"data-deg-role-model":role.model,
},
react.createElement("span",{className:"deg_pd_role_name"},role.label),
react.createElement("span",{className:"deg_pd_role_value",title:role.valueText||undefined},role.valueText),
react.createElement("span",{className:"deg_pd_role_state"},role.stateText),
))),
model.statusText===null?null:react.createElement("p",{
className:"deg_pd_status",
role:"status",
"data-deg-role-status":model.roleStatus,
},model.statusText),
react.createElement(
"div",
{className:"deg_pd_actions"},
react.createElement("button",{
type:"button",
className:"deg_btn deg_btn_primary deg_pd_open",
"data-deg-open-settings":"true",
disabled:capability.available!==true||failure!==null,
"aria-describedby":noteText===null?undefined:"deg-pd-open-note",
onClick:openSettings,
},"打开 DEG 设置"),
noteText===null?null:react.createElement("span",{
id:"deg-pd-open-note",
className:"deg_pd_note",
role:"status",
"data-deg-open-note":noteReason,
},noteText),
),
);
}
global[SYMBOL]=Object.freeze({
DEG_PLUGIN_DETAIL_SLOT_NAME,DEG_PLUGIN_DETAIL_ENTRY_KEY,DEG_SETTINGS_SECTION_SLOT_NAME,describeDegPluginDetailSummary,resolveDegSettingsSectionOpener,DegPluginDetailSummary,bindClientRuntime,
});
})(globalThis);
/* source: client-sidebar-entry.js */
(function installClientSidebarEntryModule(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-sidebar-entry");
const DEG_MAIN_SLOT_NAME="main";
const DEG_SIDEBAR_PANELLIST_SLOT_NAME="sidebar.panellist";
const DEG_SIDEBAR_ENTRY_ORDER=5;
const DEG_MAIN_PAGE_CLASS="deg_main_page";
const DEG_MAIN_PAGE_ATTR="data-deg-panel-page";
const DEG_PANEL_ICON_SIZE=16;
const DEG_PANEL_ICON_STROKE="1.3";
const noop=()=>{};
function installDegSidebarEntry(ctx,deps){
const react=deps?.react;
if(react===null||react===undefined||typeof react.createElement!=="function")return noop;
const slots=ctx?.slots;
if(slots===null||slots===undefined
||typeof slots.inject!=="function"||typeof slots.register!=="function")return noop;
if(typeof ctx.effect!=="function")return noop;
const id=deps.id;
const iconPaths=Array.isArray(deps.iconPaths)
?deps.iconPaths.filter((path)=>typeof path==="string")
:[];
const{settingsComponent,settingsForm,modelCatalog,modelConfigHost}=deps;
function DegPanelIcon(props){
const size=props?.size??DEG_PANEL_ICON_SIZE;
return react.createElement("svg",{
width:size,
height:size,
viewBox:"0 0 16 16",
fill:"none",
stroke:"currentColor",
strokeWidth:DEG_PANEL_ICON_STROKE,
"aria-hidden":"true",
},iconPaths.map((path)=>react.createElement("path",{
key:path,
d:path,
stroke:"currentColor",
fill:"none",
})));
}
function DegSettingsPage(props){
return react.createElement("div",{
className:DEG_MAIN_PAGE_CLASS,
[DEG_MAIN_PAGE_ATTR]:"true",
},react.createElement(props.settingsComponent,{
settingsForm:props.settingsForm,
modelCatalog:props.modelCatalog,
modelConfigHost:props.modelConfigHost,
ctx:props.ctx,
modelConfigDefaultOpen:true,
}));
}
function readSidebarEntryEnabled(){
try{
const snapshot=typeof settingsForm?.getSnapshot==="function"?settingsForm.getSnapshot():void 0;
return snapshot?.value?.sidebarEntryEnabled!==false;
}catch{
return true;
}
}
let mainReady=false;
let notifyMainReady=noop;
try{
slots.inject(DEG_MAIN_SLOT_NAME,()=>ctx.effect(()=>{
const release=slots.register({
name:DEG_MAIN_SLOT_NAME,
key:id,
inject:()=>({settingsComponent,settingsForm,modelCatalog,modelConfigHost,ctx}),
},DegSettingsPage);
mainReady=true;
notifyMainReady();
return()=>{
mainReady=false;
notifyMainReady();
if(typeof release==="function")release();
};
},"dsh-expert-group: settings panel"));
}catch{
}
try{
slots.inject(DEG_SIDEBAR_PANELLIST_SLOT_NAME,()=>ctx.effect(()=>{
let releaseRow=null;
const installRow=()=>{
if(releaseRow!==null)return;
const release=slots.register({
name:DEG_SIDEBAR_PANELLIST_SLOT_NAME,
id,
order:DEG_SIDEBAR_ENTRY_ORDER,
label:()=>id,
},DegPanelIcon);
releaseRow=typeof release==="function"?release:noop;
};
const uninstallRow=()=>{
const release=releaseRow;
releaseRow=null;
if(release===null)return;
try{
release();
}catch{
}
};
const sync=()=>{
if(mainReady&&readSidebarEntryEnabled())installRow();
else uninstallRow();
};
notifyMainReady=sync;
sync();
let unsubscribe=noop;
if(typeof settingsForm?.subscribe==="function"){
try{
const release=settingsForm.subscribe(()=>{
try{
sync();
}catch{
}
});
if(typeof release==="function")unsubscribe=release;
}catch{
}
}
return()=>{
if(notifyMainReady===sync)notifyMainReady=noop;
try{
unsubscribe();
}catch{
}
unsubscribe=noop;
uninstallRow();
};
},"dsh-expert-group: sidebar entry"));
}catch{
}
return noop;
}
global[SYMBOL]=Object.freeze({
installDegSidebarEntry,
});
})(globalThis);
/* source: client-session-delete-selection.js */
(function installClientSessionDeleteSelection(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-session-delete-selection");
const ACTION_CANDIDATES="session-delete-candidates";
const ACTION_REMOVE="session-delete";
const UNGROUPED_SCOPE="ungrouped";
const TARGETS_LIMIT=200;
const RESULT_STATES=Object.freeze(["deleted","raced","failed","skipped","absent"]);
const RESULT_STATE_ALIASES=Object.freeze({deletedWithWarnings:"deleted"});
const ERROR_KINDS=Object.freeze({
"workspace-not-found":"not-found",
"delete-job-busy":"busy",
"delete-candidates-unavailable":"unavailable",
"delete-unavailable":"unavailable",
"delete-targets-invalid":"invalid",
"delete-targets-outside-ungrouped":"invalid",
"bad-request":"invalid",
});
const ERROR_MESSAGES=Object.freeze({
"not-found":"工作区不存在或已移除",
busy:"已有删除作业正在执行，请稍后再试",
unavailable:"会话删除能力暂不可用，请重启 DSH 后再试",
invalid:"请求无效，本次没有删除任何会话",
transport:"请求失败，请检查连接后重试",
unknown:"会话删除失败",
});
function isObject(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function readId(value){
return typeof value==="string"&&value.length>0?value:null;
}
function readTitle(value){
if(typeof value!=="string")return null;
const title=value.trim();
return title.length>0?title:null;
}
function scopeRequestFields(scopeKey){
return scopeKey===UNGROUPED_SCOPE?{scope:UNGROUPED_SCOPE}:{workspaceId:scopeKey};
}
function readSnapshotScopeKey(snapshot){
if(!isObject(snapshot))return null;
const stamped=readId(snapshot.scopeKey);
if(stamped!==null)return stamped;
if(snapshot.scope===UNGROUPED_SCOPE)return UNGROUPED_SCOPE;
return readId(snapshot.workspaceId);
}
function normalizeBlockedBy(raw){
if(!isObject(raw))return null;
return{
kind:typeof raw.kind==="string"&&raw.kind.length>0?raw.kind:"live",
sessionId:readId(raw.sessionId),
title:readTitle(raw.title),
};
}
function normalizeCandidate(raw){
if(!isObject(raw))return null;
const sessionId=readId(raw.sessionId);
if(sessionId===null)return null;
return{
sessionId,
title:readTitle(raw.title),
actionable:raw.actionable===true,
absent:raw.absent===true,
blockedBy:normalizeBlockedBy(raw.blockedBy),
};
}
function groupCandidates(snapshot){
const items=[];
const seen=new Set();
const raw=isObject(snapshot)&&Array.isArray(snapshot.candidates)?snapshot.candidates:[];
for(const entry of raw){
const candidate=normalizeCandidate(entry);
if(candidate===null||seen.has(candidate.sessionId))continue;
seen.add(candidate.sessionId);
items.push(candidate);
}
const actionable=[];
const blocked=[];
const absent=[];
for(const candidate of items){
if(candidate.actionable!==true){
blocked.push(candidate);
continue;
}
actionable.push(candidate);
if(candidate.absent===true)absent.push(candidate);
}
return{items,actionable,blocked,absent};
}
function findCandidate(list,sessionId){
if(!Array.isArray(list)||sessionId===null)return null;
for(const candidate of list){
if(candidate.sessionId===sessionId)return candidate;
}
return null;
}
function initialSelectionState(){
return{
open:false,
workspaceId:null,
candidates:{items:[],actionable:[],blocked:[],absent:[]},
selected:[],
settling:false,
result:null,
};
}
function enterSelection(snapshot,preselectSessionId){
const scopeKey=readSnapshotScopeKey(snapshot);
if(scopeKey===null)return initialSelectionState();
const candidates=groupCandidates(snapshot);
const preselect=readId(preselectSessionId);
const selected=preselect!==null&&findCandidate(candidates.actionable,preselect)!==null
?[preselect]
:[];
return{open:true,workspaceId:scopeKey,candidates,selected,settling:false,result:null};
}
function exitSelection(){
return initialSelectionState();
}
function toggleSelection(state,sessionId){
if(!isObject(state)||state.open!==true||state.settling===true)return state;
const id=readId(sessionId);
if(id===null||findCandidate(state.candidates?.actionable,id)===null)return state;
const selected=state.selected.includes(id)
?state.selected.filter((entry)=>entry!==id)
:[...state.selected,id];
return{...state,selected};
}
function selectAllActionable(state){
if(!isObject(state)||state.open!==true||state.settling===true)return state;
return{...state,selected:(state.candidates?.actionable??[]).map((candidate)=>candidate.sessionId)};
}
function toggleSelectAllActionable(state){
if(!isObject(state)||state.open!==true||state.settling===true)return state;
if(selectionCounts(state).allSelected===true)return{...state,selected:[]};
return selectAllActionable(state);
}
function markSettling(state,settling){
if(!isObject(state)||state.open!==true)return state;
const next=settling===true;
return state.settling===next?state:{...state,settling:next};
}
function refreshSelectionCandidates(state,snapshot){
if(!isObject(state)||state.open!==true)return state;
if(readSnapshotScopeKey(snapshot)!==state.workspaceId)return state;
const candidates=groupCandidates(snapshot);
const selected=state.selected.filter((sessionId)=>findCandidate(candidates.actionable,sessionId)!==null);
return{...state,candidates,selected};
}
function selectionTargets(state){
if(!isObject(state)||state.open!==true)return[];
const targets=[];
for(const candidate of state.candidates?.actionable??[]){
if(state.selected.includes(candidate.sessionId))targets.push(candidate);
}
return targets;
}
function selectionCounts(state){
const targets=selectionTargets(state);
const candidates=isObject(state)?state.candidates:null;
const blocked=Array.isArray(candidates?.blocked)?candidates.blocked.length:0;
const actionable=Array.isArray(candidates?.actionable)?candidates.actionable.length:0;
const absent=Array.isArray(candidates?.absent)?candidates.absent.length:0;
return{
selected:Array.isArray(state?.selected)?state.selected.length:0,
targets:targets.length,
actionable,
blocked,
absent,
total:Array.isArray(candidates?.items)?candidates.items.length:actionable+blocked,
deletable:targets.length>0&&isObject(state)&&state.settling!==true,
allSelected:actionable>0&&targets.length===actionable,
};
}
function isSelectionOpen(state){
return isObject(state)&&state.open===true;
}
function isSessionSelected(state,sessionId){
const id=readId(sessionId);
return id!==null&&isObject(state)&&Array.isArray(state.selected)&&state.selected.includes(id);
}
function isSessionActionable(state,sessionId){
return findCandidate(isObject(state)?state.candidates?.actionable:null,readId(sessionId))!==null;
}
function selectionCandidateOf(state,sessionId){
return findCandidate(isObject(state)?state.candidates?.items:null,readId(sessionId));
}
function escapeAction(state,input){
if(isObject(input)&&input.confirmOpen===true)return"close-confirm";
return isSelectionOpen(state)?"exit-selection":"none";
}
function zeroCounts(){
const counts={};
for(const state of RESULT_STATES)counts[state]=0;
return counts;
}
function normalizeResultState(value){
const alias=typeof value==="string"?RESULT_STATE_ALIASES[value]:undefined;
const state=alias===undefined?value:alias;
return typeof state==="string"&&RESULT_STATES.includes(state)?state:null;
}
function normalizeSettlement(summary){
const source=isObject(summary)?summary:{};
const counts=zeroCounts();
const results=[];
const unknown=[];
for(const entry of Array.isArray(source.results)?source.results:[]){
const raw=isObject(entry)?entry:{};
const state=normalizeResultState(raw.state);
if(state===null)unknown.push(readId(raw.sessionId)??"<unknown>");
else counts[state]+=1;
results.push(state===null?raw:{...raw,state});
}
const total=RESULT_STATES.reduce((sum,state)=>sum+counts[state],0);
const targetCount=Number.isSafeInteger(source.targetCount)&&source.targetCount>=0
?source.targetCount
:total;
const note=isObject(source.note)?source.note:{};
const batches=Number.isSafeInteger(source.batches)&&source.batches>0?source.batches:1;
return{
counts,
total,
targetCount,
conserved:total===targetCount&&unknown.length===0,
results,
unknown,
blocked:Array.isArray(source.blocked)?source.blocked:[],
collateral:Array.isArray(source.collateral)?source.collateral:[],
diagnostics:Array.isArray(source.diagnostics)?source.diagnostics:[],
note:{
newDescendants:Number.isSafeInteger(note.newDescendants)?note.newDescendants:0,
...(note.degraded===true?{degraded:true}:{}),
},
batches,
};
}
function mergeDeleteSettlements(settlements){
const counts=zeroCounts();
const merged={
counts,
total:0,
targetCount:0,
conserved:true,
results:[],
unknown:[],
blocked:[],
collateral:[],
diagnostics:[],
note:{newDescendants:0},
batches:0,
};
for(const entry of Array.isArray(settlements)?settlements:[]){
const batch=normalizeSettlement(entry);
for(const state of RESULT_STATES)counts[state]+=batch.counts[state];
merged.total+=batch.total;
merged.targetCount+=batch.targetCount;
merged.conserved=merged.conserved&&batch.conserved;
merged.batches+=batch.batches;
merged.results.push(...batch.results);
merged.unknown.push(...batch.unknown);
merged.blocked.push(...batch.blocked);
merged.collateral.push(...batch.collateral);
merged.diagnostics.push(...batch.diagnostics);
merged.note.newDescendants+=batch.note.newDescendants;
if(batch.note.degraded===true)merged.note.degraded=true;
}
merged.conserved=merged.conserved&&merged.total===merged.targetCount&&merged.unknown.length===0;
return merged;
}
function applySettlement(state,settlement){
if(!isObject(state)||state.open!==true)return state;
if(!isObject(settlement))return state;
const merged=mergeDeleteSettlements([settlement]);
const submitted=selectionTargets(state).length;
const retained=[];
for(const result of merged.results){
if(normalizeResultState(result?.state)!=="failed")continue;
const sessionId=readId(result?.sessionId);
if(sessionId===null||retained.includes(sessionId))continue;
if(findCandidate(state.candidates?.actionable,sessionId)===null)continue;
retained.push(sessionId);
}
const settledEveryTarget=merged.total>0
&&merged.total===submitted
&&merged.counts.deleted+merged.counts.absent===merged.total;
if(settledEveryTarget)return initialSelectionState();
return{...state,selected:retained,settling:false,result:merged};
}
function chunkDeleteTargets(targets,limit){
const size=Number.isSafeInteger(limit)&&limit>0?limit:TARGETS_LIMIT;
const list=Array.isArray(targets)?targets.filter((entry)=>readId(entry)!==null):[];
const chunks=[];
for(let index=0;index<list.length;index+=size)chunks.push(list.slice(index,index+size));
return chunks;
}
function deleteFailure(kind,code,message){
return{code:code??null,kind,message:message??ERROR_MESSAGES[kind]??ERROR_MESSAGES.unknown};
}
function emptyTargetsFailure(){
return deleteFailure("invalid",null,"没有可处理的目标");
}
function normalizeDeleteFailure(error){
const code=isObject(error)&&typeof error.code==="string"&&error.code.length>0?error.code:null;
const message=isObject(error)&&typeof error.message==="string"&&error.message.length>0
?error.message
:undefined;
if(code===null)return deleteFailure("transport",null,message);
if(Object.prototype.hasOwnProperty.call(ERROR_KINDS,code))return deleteFailure(ERROR_KINDS[code],code,message);
return deleteFailure("unknown",code,message);
}
function readPort(port){
if(isObject(port)&&typeof port.call==="function")return port;
if(typeof port==="function")return{call:port};
return null;
}
async function callAction(port,request){
const rpc=readPort(port);
if(rpc===null)return{ok:false,error:deleteFailure("transport",null,"当前 DSH 未提供插件 RPC")};
try{
return{ok:true,value:await rpc.call(request)};
}catch(error){
return{ok:false,error:normalizeDeleteFailure(error)};
}
}
async function requestDeleteCandidates(port,workspaceId){
const scopeKey=readId(workspaceId);
if(scopeKey===null)return{ok:false,error:deleteFailure("invalid","bad-request")};
const scopeFields=scopeRequestFields(scopeKey);
const outcome=await callAction(port,{action:ACTION_CANDIDATES,...scopeFields});
if(outcome.ok!==true)return outcome;
const snapshot=outcome.value;
if(!isObject(snapshot)||!Array.isArray(snapshot.candidates)){
return{ok:false,error:deleteFailure("unknown",null)};
}
return{ok:true,snapshot:{...snapshot,...scopeFields,scopeKey}};
}
function titlesOfCandidates(targets){
const titles=Object.create(null);
let count=0;
for(const candidate of targets){
if(candidate.title===null)continue;
titles[candidate.sessionId]=candidate.title;
count+=1;
}
return count>0?titles:null;
}
async function requestDeleteBatch(port,options){
const scopeKey=readId(isObject(options)?options.workspaceId:null);
const targets=Array.isArray(options?.targets)
?options.targets.filter((entry)=>readId(entry)!==null)
:[];
if(scopeKey===null||targets.length===0){
return{ok:false,error:deleteFailure("invalid","delete-targets-invalid")};
}
const request={action:ACTION_REMOVE,...scopeRequestFields(scopeKey),targets};
if(isObject(options?.titles))request.titles=options.titles;
const outcome=await callAction(port,request);
if(outcome.ok!==true)return outcome;
const summary=outcome.value;
if(!isObject(summary)||!Array.isArray(summary.results)){
return{ok:false,error:deleteFailure("unknown",null)};
}
return{ok:true,settlement:normalizeSettlement(summary)};
}
async function requestDeleteAll(port,options){
const scopeKey=readId(isObject(options)?options.workspaceId:null);
const targets=Array.isArray(options?.targets)
?options.targets.filter((entry)=>readId(entry)!==null)
:[];
if(scopeKey===null||targets.length===0){
return{ok:false,error:deleteFailure("invalid","delete-targets-invalid"),settlement:null,batches:0,total:targets.length};
}
const chunks=chunkDeleteTargets(targets,options?.limit);
const settlements=[];
for(const chunk of chunks){
const outcome=await requestDeleteBatch(port,{workspaceId:scopeKey,targets:chunk,titles:options?.titles});
if(outcome.ok!==true){
return{
ok:false,
error:outcome.error,
settlement:settlements.length===0?null:mergeDeleteSettlements(settlements),
batches:settlements.length,
total:targets.length,
};
}
settlements.push(outcome.settlement);
}
return{
ok:true,
error:null,
settlement:mergeDeleteSettlements(settlements),
batches:settlements.length,
total:targets.length,
};
}
async function runSelectionRound(port,state,options){
const targets=selectionTargets(state);
if(targets.length===0)return{ok:false,state,settlement:null,error:emptyTargetsFailure()};
const outcome=await requestDeleteAll(port,{
workspaceId:state.workspaceId,
targets:targets.map((candidate)=>candidate.sessionId),
titles:titlesOfCandidates(targets),
limit:options?.limit,
});
const settlement=outcome.settlement;
let next=settlement===null?markSettling(state,false):applySettlement(state,settlement);
if(outcome.ok!==true)return{ok:false,state:next,settlement,error:outcome.error};
if(isSelectionOpen(next)!==true)return{ok:true,state:next,settlement,error:null,refreshError:null};
const refreshed=await requestDeleteCandidates(port,next.workspaceId);
if(refreshed.ok===true)next=refreshSelectionCandidates(next,refreshed.snapshot);
return{ok:true,state:next,settlement,error:null,refreshError:refreshed.ok===true?null:refreshed.error};
}
async function openSelection(port,scopeKey,preselectSessionId){
const loaded=await requestDeleteCandidates(port,scopeKey);
if(loaded.ok!==true)return{ok:false,state:initialSelectionState(),error:loaded.error};
return{ok:true,state:enterSelection(loaded.snapshot,preselectSessionId),error:null};
}
async function submitSelection(port,state,options){
if(!isSelectionOpen(state))return{ok:false,state,settlement:null,error:emptyTargetsFailure()};
return await runSelectionRound(port,state,options);
}
async function retrySelection(port,state,options){
if(!isSelectionOpen(state))return{ok:false,state,settlement:null,error:emptyTargetsFailure()};
const refreshed=await requestDeleteCandidates(port,state.workspaceId);
if(refreshed.ok!==true)return{ok:false,state,settlement:null,error:refreshed.error};
const next=refreshSelectionCandidates(state,refreshed.snapshot);
if(selectionTargets(next).length===0){
return{ok:false,state:markSettling(next,false),settlement:null,error:emptyTargetsFailure()};
}
return await runSelectionRound(port,next,options);
}
global[SYMBOL]=Object.freeze({
SESSION_DELETE_TARGETS_LIMIT:TARGETS_LIMIT,
ACTION_CANDIDATES,
ACTION_REMOVE,
UNGROUPED_SCOPE,
ERROR_KINDS,
RESULT_STATES,
applySettlement,
chunkDeleteTargets,
enterSelection,
escapeAction,
exitSelection,
initialSelectionState,
isSelectionOpen,
isSessionActionable,
isSessionSelected,
markSettling,
mergeDeleteSettlements,
normalizeDeleteFailure,
openSelection,
refreshSelectionCandidates,
requestDeleteAll,
requestDeleteBatch,
requestDeleteCandidates,
retrySelection,
selectAllActionable,
selectionCandidateOf,
selectionCounts,
selectionTargets,
submitSelection,
toggleSelectAllActionable,
toggleSelection,
});
})(globalThis);
/* source: client-session-delete-local-keys.js */
(function installClientSessionDeleteLocalKeys(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-session-delete-local-keys");
const LEDGER=global[Symbol.for("dsh-expert-group/client-sidebar-auto-ledger")]??{};
const STATES=Object.freeze(["deleted","absent"]);
const EXPANSION_KEY_PREFIX="dsh-expert-group:expansion:v";
const PENDING_CLEANUP_KEY="dsh-expert-group:session-delete-cleanup:v1";
const LIMIT=16;
const IDS_LIMIT=200;
const TTL_MS=7*24*60*60*1000;
function isObject(value){
return value!==null&&typeof value==="object"&&!Array.isArray(value);
}
function readId(value){
return typeof value==="string"&&value.length>0?value:null;
}
function storageOf(name){
try{
const storage=name==="sessionStorage"?global.sessionStorage:global.localStorage;
if(storage===null||storage===undefined)return null;
return typeof storage.getItem==="function"&&typeof storage.removeItem==="function"?storage:null;
}catch{
return null;
}
}
function idsOf(value){
const ids=[];
for(const entry of Array.isArray(value)?value:[]){
const id=readId(entry);
if(id===null||ids.includes(id))continue;
ids.push(id);
if(ids.length>=IDS_LIMIT)break;
}
return ids;
}
function processedSessionIds(settlement){
const ids=[];
const results=Array.isArray(settlement?.results)?settlement.results:[];
for(const result of results){
const raw=typeof result?.state==="string"?result.state:"";
const state=raw==="deletedWithWarnings"?"deleted":raw;
const sessionId=readId(result?.sessionId);
if(sessionId===null||STATES.includes(state)!==true||ids.includes(sessionId))continue;
ids.push(sessionId);
}
return ids;
}
function expansionRootOf(key){
if(typeof key!=="string"||key.startsWith(EXPANSION_KEY_PREFIX)!==true)return null;
const rest=key.slice(EXPANSION_KEY_PREFIX.length);
const versionEnd=rest.indexOf(":");
if(versionEnd<=0||/^[0-9]+$/.test(rest.slice(0,versionEnd))!==true)return null;
const afterVersion=rest.slice(versionEnd+1);
const taskEnd=afterVersion.indexOf(":");
return taskEnd>0?afterVersion.slice(0,taskEnd):null;
}
function cleanExpansionKeys(sessionIds){
const ids=idsOf(sessionIds);
const storage=ids.length===0?null:storageOf("sessionStorage");
if(storage===null)return{ok:true,removed:0};
let removed=0;
try{
const roots=ids.map(encodeURIComponent);
const total=Number(storage.length);
if(Number.isFinite(total)!==true||typeof storage.key!=="function")return{ok:false,removed:0};
const keys=[];
for(let index=0;index<total;index+=1){
const key=storage.key(index);
const root=expansionRootOf(key);
if(root!==null&&roots.includes(root))keys.push(key);
}
for(const key of keys){
storage.removeItem(key);
removed+=1;
}
return{ok:true,removed};
}catch{
return{ok:false,removed};
}
}
function cleanOwnershipLedger(sessionIds){
const ids=idsOf(sessionIds);
const purge=LEDGER.purgeSidebarAutoOwnershipForSessions;
if(ids.length===0)return{ok:true,removed:0};
if(typeof purge!=="function")return{ok:false,removed:0};
try{
const outcome=purge(ids);
const removed=Number(outcome?.removed);
return{ok:outcome?.ok===true,removed:Number.isFinite(removed)?removed:0};
}catch{
return{ok:false,removed:0};
}
}
function readPendingMarkers(storage,now){
const markers=[];
try{
const raw=storage.getItem(PENDING_CLEANUP_KEY);
const parsed=typeof raw==="string"&&raw.length>0?JSON.parse(raw):[];
if(Array.isArray(parsed)!==true)return markers;
for(const entry of parsed.slice(-LIMIT)){
const ids=isObject(entry)?idsOf(entry.ids):[];
const at=Number(entry?.at);
if(ids.length===0||Number.isFinite(at)!==true||now-at>TTL_MS)continue;
markers.push({ids,at});
}
}catch{
}
return markers;
}
function writePendingMarkers(storage,markers){
if(markers.length===0)storage.removeItem(PENDING_CLEANUP_KEY);
else storage.setItem(PENDING_CLEANUP_KEY,JSON.stringify(markers.slice(-LIMIT)));
}
function addPendingCleanup(sessionIds,options){
const ids=idsOf(sessionIds);
const storage=storageOf("localStorage");
if(ids.length===0)return{ok:true,written:false};
if(storage===null)return{ok:false,written:false};
const now=Number.isFinite(Number(options?.now))?Number(options.now):Date.now();
try{
const markers=readPendingMarkers(storage,now);
markers.push({ids,at:now});
writePendingMarkers(storage,markers);
return{ok:true,written:true};
}catch{
return{ok:false,written:false};
}
}
function sweepPendingLocalKeys(options){
const storage=storageOf("localStorage");
const report={ok:true,batches:0,expansionKeys:0,ownershipEntries:0,failed:0};
if(storage===null)return{...report,ok:false};
const now=Number.isFinite(Number(options?.now))?Number(options.now):Date.now();
try{
const markers=readPendingMarkers(storage,now);
if(markers.length===0)return report;
const remaining=[];
for(const marker of markers){
const expansion=cleanExpansionKeys(marker.ids);
const ownership=cleanOwnershipLedger(marker.ids);
report.expansionKeys+=expansion.removed;
report.ownershipEntries+=ownership.removed;
if(expansion.ok===true&&ownership.ok===true){
report.batches+=1;
continue;
}
remaining.push(marker);
report.failed+=1;
}
writePendingMarkers(storage,remaining);
return{...report,ok:report.failed===0};
}catch{
return{...report,ok:false};
}
}
function readSessionRefresh(ctx){
try{
const sessions=ctx?.sessions;
if(sessions===null||sessions===undefined)return null;
return typeof sessions.refresh==="function"?sessions:null;
}catch{
return null;
}
}
async function convergeAfterSettlement(ctx,settlement,options){
const now=Number.isFinite(Number(options?.now))?Number(options.now):Date.now();
const ids=processedSessionIds(settlement);
if(ids.length===0){
return{applied:false,ids,marked:false,refreshed:false,refreshError:null,batches:0,expansionKeys:0,ownershipEntries:0};
}
const marked=addPendingCleanup(ids,{now});
const sessions=readSessionRefresh(ctx);
let refreshed=false;
let refreshError=null;
if(sessions===null){
refreshError="sessions-unavailable";
}else{
try{
await sessions.refresh();
refreshed=true;
}catch(error){
refreshError=error instanceof Error&&error.message.length>0?error.message:"refresh-failed";
}
}
const swept=sweepPendingLocalKeys({now});
return{
applied:true,ids,marked:marked.written===true,refreshed,refreshError,
batches:swept.batches,expansionKeys:swept.expansionKeys,ownershipEntries:swept.ownershipEntries,
};
}
global[SYMBOL]=Object.freeze({
EXPANSION_KEY_PREFIX,
PENDING_CLEANUP_KEY,
PROCESSED_STATES:STATES,
addPendingCleanup,
cleanExpansionKeys,
cleanOwnershipLedger,
convergeAfterSettlement,
expansionRootOf,
processedSessionIds,
readPendingMarkers,
sweepPendingLocalKeys,
});
})(globalThis);
/* source: client-session-delete-view.js */
(function installSessionDeleteView(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-session-delete-view");
const MODEL_SYMBOL=Symbol.for("dsh-expert-group/client-expert-group-model");
const FOCUS_SYMBOL=Symbol.for("dsh-expert-group/client-model-views-b");
const DIALOG_TITLE_ID="deg_session_delete_dialog_title";
const BLOCK_KEYS=Object.freeze({
live:"sidebar.sessionDelete.blocked.live",
"live-descendant":"sidebar.sessionDelete.blocked.liveDescendant",
"pending-cleanup":"sidebar.sessionDelete.blocked.pending",
missing:"sidebar.sessionDelete.blocked.missing",
});
const ROW_REASON_KEYS=Object.freeze({
skipped:"sidebar.sessionDelete.reason.skipped",
failed:"sidebar.sessionDelete.reason.failed",
raced:"sidebar.sessionDelete.reason.raced",
});
function modelApi(){
return global[MODEL_SYMBOL]??{};
}
function focusApi(){
return global[FOCUS_SYMBOL]??{};
}
function resolveLocale(ctx){
const model=modelApi();
const sources={
ctxLocale:(()=>{try{return ctx?.locale;}catch{return undefined;}})(),
i18nLocale:(()=>{try{return ctx?.i18n?.locale;}catch{return undefined;}})(),
documentLang:(()=>{try{return globalThis.document?.documentElement?.lang;}catch{return undefined;}})(),
navigatorLanguage:(()=>{try{return globalThis.navigator?.language;}catch{return undefined;}})(),
};
if(typeof model.resolveClientLocale==="function")return model.resolveClientLocale(sources);
return"zh";
}
function deleteTranslator(ctx){
return function translate(key,vars){
const model=modelApi();
if(typeof model.translateMessage!=="function")return"—";
return model.translateMessage(resolveLocale(ctx),key,vars);
};
}
function blockedReasonText(t,blockedBy){
const kind=typeof blockedBy?.kind==="string"?blockedBy.kind:"missing";
const key=BLOCK_KEYS[kind]??BLOCK_KEYS.missing;
if(kind==="live-descendant"){
const name=typeof blockedBy?.title==="string"&&blockedBy.title.length>0
?blockedBy.title
:(typeof blockedBy?.sessionId==="string"?blockedBy.sessionId:"");
return t(key,{title:name.length>0?name:"—"});
}
return t(key);
}
function outcomeSentence(t,counts){
const parts=[];
const deleted=Number.isFinite(counts?.deleted)?counts.deleted:0;
const absent=Number.isFinite(counts?.absent)?counts.absent:0;
const reasons=[];
let kept=0;
for(const stateName of["skipped","failed","raced"]){
const count=Number.isFinite(counts?.[stateName])?counts[stateName]:0;
if(count<=0)continue;
kept+=count;
reasons.push(t(ROW_REASON_KEYS[stateName]));
}
if(deleted>0)parts.push(t("sidebar.sessionDelete.outcome.deleted",{count:deleted}));
if(absent>0)parts.push(t("sidebar.sessionDelete.outcome.absent",{count:absent}));
if(kept>0){
parts.push(t("sidebar.sessionDelete.outcome.kept",{
count:kept,
reasons:reasons.join(t("sidebar.sessionDelete.outcome.reasonJoin")),
}));
}
return parts.join(t("sidebar.sessionDelete.outcome.join"));
}
function trashIcon(create,primitives){
const Icon=primitives?.IconTrashOutlineRegular;
return typeof Icon==="function"?create(Icon,{className:"deg_sd_icon"}):null;
}
function selectAllIcon(create){
return create("svg",{
className:"deg_sd_icon",viewBox:"0 0 16 16","aria-hidden":"true",focusable:"false",
fill:"none",stroke:"currentColor",strokeWidth:1.5,strokeLinecap:"round",strokeLinejoin:"round",
},
create("path",{d:"M2.6 8.4 6.2 12 13.4 3.6"}));
}
function selectAllActiveIcon(create){
return create("svg",{
className:"deg_sd_icon",viewBox:"0 0 16 16","aria-hidden":"true",focusable:"false",
fill:"none",
},
create("rect",{x:2.2,y:2.2,width:11.6,height:11.6,rx:2.4,fill:"currentColor"}),
create("path",{
d:"M5 8.2 7 10.2 11 5.8",fill:"none",
stroke:"var(--dsw-alias-bg-layer-1)",strokeWidth:1.7,strokeLinecap:"round",strokeLinejoin:"round",
}));
}
function closeIcon(create,primitives){
const Icon=primitives?.IconCloseOutlineRegular;
return typeof Icon==="function"?create(Icon,{className:"deg_sd_icon"}):create("span",{"aria-hidden":"true"},"\u2715");
}
function renderRowActionButton(create,primitives,t,options){
const label=t("sidebar.sessionDelete.row.aria",{title:options.title});
return create("button",{
type:"button",
className:"deg_sd_row_action",
title:label,
"aria-label":label,
disabled:options.disabled===true,
"data-deg-session-delete-row":"true",
onClick:options.onClick,
},trashIcon(create,primitives));
}
function renderMenuItem(create,primitives,t,options){
const MenuItemButton=primitives?.MenuItemButton;
if(typeof MenuItemButton==="function"){
return create(MenuItemButton,{
...(options.danger===true?{danger:true,icon:trashIcon(create,primitives)}:{}),
disabled:options.disabled===true,
onSelect:options.onSelect,
},options.label);
}
return create("button",{
type:"button",
role:"menuitem",
className:options.danger===true?"deg_sd_menu_item deg_sd_danger":"deg_sd_menu_item",
disabled:options.disabled===true,
[options.attribute]:"true",
onClick:options.onSelect,
},options.danger===true?trashIcon(create,primitives):null,options.label);
}
function renderLeadingCheckbox(create,t,options){
const label=t("sidebar.sessionDelete.checkbox.aria",{title:options.title??"—"});
return create("input",{
type:"checkbox",
className:"deg_sd_check",
checked:options.checked===true,
disabled:options.disabled===true,
"aria-label":label,
title:label,
"data-deg-session-delete-check":"true",
onClick:(event)=>{event?.stopPropagation?.();},
onKeyDown:(event)=>{event?.stopPropagation?.();},
onChange:options.onToggle,
});
}
function renderBar(create,primitives,t,view){
const counts=view.counts??{};
const blocked=Number.isFinite(counts.blocked)?counts.blocked:0;
const busy=view.busy===true;
const allSelected=counts.allSelected===true;
const selectAllLabel=t(allSelected
?"sidebar.sessionDelete.bar.deselectAll"
:"sidebar.sessionDelete.bar.selectAll");
const deleteLabel=t("sidebar.sessionDelete.menu");
const exitLabel=t("sidebar.sessionModel.close");
return create("div",{
className:"deg_sd_bar",
role:"toolbar",
"aria-label":t("sidebar.sessionDelete.menu"),
"data-deg-session-delete-bar":"true",
style:view.style,
},
create("span",{
className:"deg_sd_count","aria-live":"polite","data-deg-session-delete-count":"true",
},t("sidebar.sessionDelete.bar.selected",{count:Number.isFinite(counts.selected)?counts.selected:0})),
blocked>0?create("span",{
className:"deg_sd_blocked",
"data-deg-session-delete-blocked":"true",
},t("sidebar.sessionDelete.bar.blocked",{count:blocked})):null,
create("button",{
type:"button",
className:"deg_sd_btn deg_sd_selectall",
title:selectAllLabel,
"aria-label":selectAllLabel,
"data-deg-session-delete-selectall":"true",
"data-deg-session-delete-selectall-state":allSelected?"all":"idle",
disabled:busy||!(counts.actionable>0),
onClick:view.onSelectAll,
},allSelected?selectAllActiveIcon(create):selectAllIcon(create)),
create("button",{
type:"button",className:"deg_sd_btn deg_sd_danger","aria-label":deleteLabel,
"data-deg-session-delete-delete":"true",
disabled:busy||counts.deletable!==true,
onClick:view.onDelete,
},trashIcon(create,primitives)),
create("button",{
type:"button",className:"deg_sd_btn","aria-label":exitLabel,
"data-deg-session-delete-exit":"true",
onClick:view.onExit,
},closeIcon(create,primitives)));
}
function renderDialog(create,t,view,handlers){
if(view===null)return null;
const running=view.running===true;
const onCancel=()=>{if(running!==true)handlers.onCancel();};
return create("div",{
className:"deg_prompt_dialog_backdrop",
onClick:onCancel,
},
create("div",{
className:"deg_prompt_dialog",
role:"dialog",
"aria-modal":"true",
"aria-labelledby":DIALOG_TITLE_ID,
"data-deg-session-delete-dialog":view.kind,
ref:handlers.dialogRef,
onClick:(event)=>event?.stopPropagation?.(),
onKeyDown:(event)=>handleDialogKeyDown(event,view,handlers),
},
create("h3",{id:DIALOG_TITLE_ID},view.title),
create("p",{className:"deg_sd_dialog_line"},view.lines.join("\n")),
view.error===null||view.error===undefined?null:create("p",{
className:"deg_remove_confirm_error",role:"alert","aria-live":"assertive",
},view.error),
create("div",{className:"deg_prompt_dialog_actions"},
create("button",{
type:"button",
className:"deg_btn",
"data-deg-dialog-action":"cancel",
"data-deg-session-delete-cancel":"true",
autoFocus:true,
disabled:running,
onClick:onCancel,
},view.kind==="confirm"?t("sidebar.sessionDelete.dialog.cancel"):t("sidebar.sessionModel.close")),
view.kind==="confirm"?create("button",{
type:"button",
className:"deg_btn deg_btn_primary",
"data-deg-dialog-action":"confirm",
"data-deg-session-delete-confirm":"true",
disabled:running,
onClick:()=>{void handlers.onConfirm();},
},running?t("sidebar.sessionDelete.dialog.running"):t("sidebar.sessionDelete.dialog.confirm")):null)));
}
function handleDialogKeyDown(event,view,handlers){
if(view.running===true)return;
if(event?.key==="Escape"){
event.preventDefault?.();
event.stopPropagation?.();
handlers.onCancel();
return;
}
if(event?.key!=="Tab")return;
const focusable=focusApi().focusableDialogControls;
const controls=typeof focusable==="function"
?focusable(handlers.dialogRef?.current??event?.currentTarget??null)
:[];
if(!Array.isArray(controls)||controls.length===0)return;
const active=typeof document==="undefined"?null:document.activeElement;
const current=controls.indexOf(active);
const nextIndex=event.shiftKey
?(current<=0?controls.length-1:current-1)
:(current>=controls.length-1?0:current+1);
event.preventDefault?.();
try{controls[nextIndex]?.focus?.();}catch{/* 无 DOM 焦点时保持可点击按钮。 */}
}
global[SYMBOL]=Object.freeze({
DIALOG_TITLE_ID,
blockedReasonText,
deleteTranslator,
outcomeSentence,
renderBar,
renderDialog,
renderLeadingCheckbox,
renderMenuItem,
renderRowActionButton,
});
})(globalThis);
/* source: client-session-delete-ui.js */
(function installSessionDeleteUiModule(global){
"use strict";
const SYMBOL=Symbol.for("dsh-expert-group/client-session-delete-ui");
const SELECTION=global[Symbol.for("dsh-expert-group/client-session-delete-selection")]??{};
const VIEW=global[Symbol.for("dsh-expert-group/client-session-delete-view")]??{};
const POLL=global[Symbol.for("dsh-expert-group/client-sidebar-poll")]??{};
const LOCAL_KEYS=global[Symbol.for("dsh-expert-group/client-session-delete-local-keys")]??{};
const{
escapeAction,exitSelection,initialSelectionState,isSelectionOpen,isSessionActionable,
isSessionSelected,markSettling,openSelection,
requestDeleteAll,requestDeleteCandidates,selectionCandidateOf,selectionCounts,
selectionTargets,submitSelection,toggleSelectAllActionable,toggleSelection,
UNGROUPED_SCOPE,
}=SELECTION;
const NOOP=function noop(){};
const ROW_KEY_PREFIX="session:";
const DOCK_GAP=8;
const RESERVE_CLASS="deg_sd_selecting";
const RPC_DIAGNOSTIC_KEY="dsh-expert-group:session-delete:last-rpc-error";
const RPC_DIAGNOSTIC_MESSAGE_LIMIT=300;
const CONTROL_SELECTOR='button,a,input,select,textarea,[role="menuitem"],[role="checkbox"],[contenteditable="true"]';
function readId(value){
return typeof value==="string"&&value.length>0?value:null;
}
function scopeKeyOf(items,sessionId){
if(!Array.isArray(items)||readId(sessionId)===null)return"";
for(const item of items){
const sessionIds=Array.isArray(item)?null:item?.sessionIds;
if(!Array.isArray(sessionIds))return"";
if(sessionIds.includes(sessionId)!==true)continue;
return readId(item.workspaceId)??"";
}
return typeof UNGROUPED_SCOPE==="string"?UNGROUPED_SCOPE:"";
}
async function convergeSettlement(ctx,settlement){
const converge=LOCAL_KEYS.convergeAfterSettlement;
if(typeof converge!=="function"||settlement===null||settlement===undefined)return;
try{
await converge(ctx,settlement);
}catch{
}
}
function sweepStartupLocalKeys(){
const sweep=LOCAL_KEYS.sweepPendingLocalKeys;
if(typeof sweep!=="function")return;
try{
sweep();
}catch{
}
}
function resolveConnection(ctx){
try{
if(ctx?.connection)return ctx.connection;
}catch{
}
try{
return typeof ctx?.get==="function"?ctx.get("connection"):undefined;
}catch{
return undefined;
}
}
function missingConnectionError(){
return new Error("当前 DSH 未提供 Connection");
}
function recordRpcFailure(error,request,connectionMissing){
try{
const storage=global.localStorage;
if(storage===null||storage===undefined||typeof storage.setItem!=="function")return;
const message=typeof error?.message==="string"
?error.message
:(error===undefined||error===null?"":String(error));
const stack=typeof error?.stack==="string"?error.stack.split("\n"):[];
storage.setItem(RPC_DIAGNOSTIC_KEY,JSON.stringify({
at:Date.now(),
action:request?.action??null,
connection:connectionMissing?"missing":"resolved",
requestKeys:Object.keys(request!==null&&typeof request==="object"?request:{}),
errorName:error?.name??null,
errorCode:error?.code??null,
errorMessage:message.slice(0,RPC_DIAGNOSTIC_MESSAGE_LIMIT),
errorStack:stack.length===0?null:stack.slice(0,2).join("\n"),
}));
}catch{
}
}
function makePort(ctx,deps){
const requestPluginRpc=deps?.requestPluginRpc;
const callRpc=POLL.callRpc;
const connection=resolveConnection(ctx);
const connectionMissing=connection===undefined||connection===null;
return{
call:async(request)=>{
try{
if(typeof callRpc!=="function")throw new Error("当前 DSH 未提供插件 RPC");
if(connectionMissing)throw missingConnectionError();
return await callRpc({requestPluginRpc},{connection},request);
}catch(error){
recordRpcFailure(error,request,connectionMissing);
throw error;
}
},
};
}
function outcomeDialogOf(counts,message){
return{kind:"outcome",counts:counts??null,message:message??null};
}
function keptCountOf(counts){
if(counts===null||typeof counts!=="object")return 0;
return(Number(counts.failed)||0)+(Number(counts.skipped)||0)+(Number(counts.raced)||0);
}
function candidatesFailureText(t,error){
return t("sidebar.sessionDelete.error.candidates",{
message:error===null||error===undefined?"":error.message,
});
}
function deleteFailureText(t,error){
return t("sidebar.sessionDelete.error.delete",{
message:error===null||error===undefined?"":error.message,
});
}
function outcomeDialogOfSettlement(t,outcome){
const failed=outcome?.ok!==true;
const settlement=outcome?.settlement??null;
const counts=settlement===null?null:settlement.counts;
if(failed!==true&&keptCountOf(counts)===0)return null;
return outcomeDialogOf(counts,failed===true?deleteFailureText(t,outcome?.error):null);
}
function makeDeleteUiStore(deps){
const port=deps.port;
const t=deps.t;
const ctx=deps.ctx;
const listeners=new Set();
let state={
selection:initialSelectionState(),
busy:false,
dialog:null,
anchor:null,
};
function emit(next){
state=next;
for(const listener of Array.from(listeners)){
try{listener();}catch{/* 订阅者异常与状态推进无关 */}
}
}
function patch(next){
emit({...state,...next});
}
function getSnapshot(){
return state;
}
function subscribe(listener){
if(typeof listener!=="function")return NOOP;
listeners.add(listener);
return listeners.delete.bind(listeners,listener);
}
const handle={port,t,get:getSnapshot,patch};
async function dispatch(action,payload){
if(action==="toggle"){
const next=toggleSelection(state.selection,payload?.sessionId);
if(next!==state.selection)patch({selection:next});
return;
}
if(action==="select-all"){
const next=toggleSelectAllActionable(state.selection);
if(next!==state.selection)patch({selection:next});
return;
}
if(action==="cancel"){
if(state.dialog!==null&&state.dialog.phase!=="running")patch({dialog:null});
return;
}
if(action==="exit"){
patch({selection:exitSelection(),dialog:null});
return;
}
if(action==="anchor"){
const next=payload??null;
if(next===null)return;
const current=state.anchor;
if(current!==null&&current.left===next.left&&current.bottom===next.bottom&&current.width===next.width)return;
patch({anchor:next});
return;
}
if(action==="open-single"){
await openSingleAction(handle,payload);
return;
}
if(action==="open-multi"){
const scopeKey=readId(payload?.workspaceId);
if(scopeKey===null)return;
if(state.busy===true)return;
patch({busy:true});
const opened=await openSelection(port,scopeKey,readId(payload?.sessionId));
if(opened.ok!==true){
patch({busy:false,dialog:outcomeDialogOf(null,candidatesFailureText(t,opened.error))});
return;
}
patch({busy:false,selection:opened.state});
return;
}
if(action==="delete-selected"){
await startBatchAction(handle);
return;
}
if(action==="confirm"){
const dialog=state.dialog;
if(dialog===null||dialog.kind!=="confirm"||dialog.phase==="running")return;
patch({dialog:{...dialog,phase:"running",error:null}});
if(dialog.scope==="single"){
const outcome=await requestDeleteAll(port,{
workspaceId:dialog.workspaceId,
targets:[dialog.targets[0].sessionId],
});
patch({dialog:outcomeDialogOfSettlement(t,outcome)});
await convergeSettlement(ctx,outcome.settlement);
return;
}
const settled=await submitSelection(port,markSettling(state.selection,true));
patch({dialog:outcomeDialogOfSettlement(t,settled),selection:exitSelection()});
await convergeSettlement(ctx,settled.settlement);
}
}
return Object.freeze({dispatch,getSnapshot,subscribe});
}
async function startBatchAction(handle){
const state=handle.get();
if(isSelectionOpen(state.selection)!==true||state.busy===true)return;
const selection=state.selection;
const targets=selectionTargets(selection);
if(targets.length===0)return;
const counts=selectionCounts(selection);
let absent=0;
for(const target of targets)if(target.absent===true)absent+=1;
handle.patch({
dialog:{
kind:"confirm",
scope:"batch",
workspaceId:selection.workspaceId,
targets,
absent,
blocked:counts.blocked,
phase:"idle",
error:null,
},
});
}
async function openSingleAction(handle,payload){
const scopeKey=readId(payload?.workspaceId);
const sessionId=readId(payload?.sessionId);
const state=handle.get();
if(scopeKey===null||sessionId===null)return;
if(state.busy===true||isSelectionOpen(state.selection)===true)return;
handle.patch({busy:true});
const loaded=await requestDeleteCandidates(handle.port,scopeKey);
if(loaded.ok!==true){
handle.patch({busy:false,dialog:outcomeDialogOf(null,candidatesFailureText(handle.t,loaded.error))});
return;
}
let candidate=null;
for(const entry of Array.isArray(loaded.snapshot?.candidates)?loaded.snapshot.candidates:[]){
if(entry?.sessionId===sessionId){candidate=entry;break;}
}
if(candidate===null||candidate.actionable!==true){
handle.patch({busy:false,dialog:{kind:"blocked",blockedBy:candidate===null?null:candidate.blockedBy}});
return;
}
const title=readId(payload?.title)??candidate.title;
handle.patch({
busy:false,
dialog:{kind:"confirm",scope:"single",workspaceId:scopeKey,targets:[{...candidate,title}],absent:0,blocked:0,phase:"idle",error:null},
});
}
function handleRowClickEvent(event,dispatch){
const target=event?.target;
if(target===null||target===undefined||typeof target.closest!=="function")return;
const row=target.closest('[data-row-key^="session:"]');
if(row===null||row===undefined||typeof row.getAttribute!=="function")return;
const control=target.closest(CONTROL_SELECTOR);
if(control!==null&&control!==undefined)return;
const key=row.getAttribute("data-row-key");
if(typeof key!=="string"||key.length<=ROW_KEY_PREFIX.length)return;
event.preventDefault?.();
event.stopPropagation?.();
void dispatch("toggle",{sessionId:key.slice(ROW_KEY_PREFIX.length)});
}
function handleDocumentKeyDown(event,ui){
if(event?.key!=="Escape")return;
const state=ui.getSnapshot();
const next=escapeAction(state.selection,{confirmOpen:state.dialog!==null});
if(next==="none")return;
event.preventDefault?.();
event.stopPropagation?.();
void ui.dispatch(next==="close-confirm"?"cancel":"exit");
}
function anchorStyle(){
let anchor=null;
try{
const doc=globalThis.document;
const row=typeof doc?.querySelector==="function"?doc.querySelector('[data-row-key^="session:"]'):null;
const tree=typeof row?.closest==="function"?row.closest('[role="tree"]'):null;
const rect=typeof tree?.getBoundingClientRect==="function"?tree.getBoundingClientRect():null;
const width=Number(rect?.width);
if(Number.isFinite(width)&&width>0){
const region=typeof tree?.closest==="function"?tree.closest('[class*="regionArea"]'):null;
const regionRect=typeof region?.getBoundingClientRect==="function"?region.getBoundingClientRect():null;
const regionBottom=Number(regionRect?.bottom);
const dock=Number.isFinite(regionBottom)?regionBottom:Number(rect?.bottom);
if(Number.isFinite(dock)){
const viewportHeight=Number(globalThis.innerHeight);
const base=Number.isFinite(viewportHeight)?viewportHeight:dock;
anchor={
left:Math.round(Number(rect.left)),
bottom:Math.max(DOCK_GAP,Math.round(base-dock+DOCK_GAP)),
width:Math.round(width),
};
}
}
}catch{
anchor=null;
}
const box=anchor??{left:8,bottom:DOCK_GAP+4,width:264};
return{position:"fixed",left:box.left+"px",bottom:box.bottom+"px",width:box.width+"px"};
}
function useReserveClass(react,state){
const visible=isSelectionOpen(state.selection)===true;
react.useEffect(()=>{
const list=globalThis.document?.body?.classList;
if(typeof list?.add!=="function"||typeof list.remove!=="function")return undefined;
if(visible===true)list.add(RESERVE_CLASS);else list.remove(RESERVE_CLASS);
return()=>{list.remove(RESERVE_CLASS);};
},[visible]);
}
function dialogViewOf(ui,state){
const dialog=state.dialog;
if(dialog===null)return null;
const t=ui.text;
if(dialog.kind==="outcome"){
const lines=[];
const sentence=VIEW.outcomeSentence(t,dialog.counts);
if(sentence.length>0)lines.push(sentence);
if(typeof dialog.message==="string"&&dialog.message.length>0)lines.push(dialog.message);
return{
kind:"outcome",
title:t("sidebar.sessionDelete.dialog.title"),
lines,
error:null,
running:false,
};
}
if(dialog.kind==="blocked"){
return{
kind:"blocked",
title:t("sidebar.sessionDelete.blocked.title"),
lines:[VIEW.blockedReasonText(t,dialog.blockedBy)],
error:null,
running:false,
};
}
const targets=Array.isArray(dialog.targets)?dialog.targets:[];
const lines=[];
if(dialog.scope==="single"){
lines.push(t("sidebar.sessionDelete.dialog.single",{title:targets.length>0?(targets[0].title??""):""}));
}else{
lines.push(t("sidebar.sessionDelete.dialog.batch",{count:targets.length}));
if(dialog.absent>0)lines.push(t("sidebar.sessionDelete.dialog.absent",{count:dialog.absent}));
if(dialog.blocked>0)lines.push(t("sidebar.sessionDelete.dialog.blocked",{count:dialog.blocked}));
const first=[];
for(let index=0;index<targets.length&&index<5;index+=1){
first.push(targets[index].title??targets[index].sessionId);
}
lines.push(t("sidebar.sessionDelete.dialog.first",{count:first.length,titles:first.join(", ")}));
}
lines.push(t("sidebar.sessionDelete.dialog.irreversible"));
return{
kind:"confirm",
title:t("sidebar.sessionDelete.dialog.title"),
lines,
error:dialog.error,
running:dialog.phase==="running",
};
}
function useSessionScope(props,sessionId){
const selector=props?.useWorkspaces;
if(typeof selector!=="function")return"";
const value=selector((snapshot)=>scopeKeyOf(snapshot?.items,sessionId));
return typeof value==="string"?value:"";
}
function useDocumentWiring(react,props,state){
const open=isSelectionOpen(state.selection);
const visible=open===true||state.dialog!==null;
react.useEffect(()=>{
const doc=globalThis.document;
if(visible!==true||typeof doc?.addEventListener!=="function")return undefined;
const ui=props.ui;
const sync=()=>{void ui.dispatch("anchor",anchorStyle());};
const onClick=(event)=>{if(open===true)handleRowClickEvent(event,ui.dispatch);};
const onKeyDown=(event)=>handleDocumentKeyDown(event,ui);
doc.addEventListener("click",onClick,true);
doc.addEventListener("keydown",onKeyDown,true);
sync();
const view=globalThis.window;
if(typeof view?.addEventListener==="function")view.addEventListener("resize",sync);
return()=>{
try{doc.removeEventListener("click",onClick,true);}catch{/* 摘不掉就放弃这条监听 */}
try{doc.removeEventListener("keydown",onKeyDown,true);}catch{/* 同上 */}
if(typeof view?.removeEventListener==="function"){
try{view.removeEventListener("resize",sync);}catch{/* 同上 */}
}
};
},[open,visible]);
}
function SessionDeleteRowAction(props){
const react=props.react;
const state=react.useSyncExternalStore(props.ui.subscribe,props.ui.getSnapshot);
const scopeKey=useSessionScope(props,props.sessionId);
const title=typeof props.displayTitle==="string"?props.displayTitle.trim():"";
if(title==="")return null;
const locked=scopeKey===""||state.busy===true;
return VIEW.renderRowActionButton(react.createElement,props.primitives,props.ui.text,{
title,
disabled:locked,
onClick:props.ui.dispatch.bind(null,"open-single",{workspaceId:scopeKey,sessionId:props.sessionId,title}),
});
}
function SessionDeleteMenuDelete(props){
const react=props.react;
const state=react.useSyncExternalStore(props.ui.subscribe,props.ui.getSnapshot);
const scopeKey=useSessionScope(props,props.sessionId);
const menu=typeof props.useMenuOpenState==="function"?props.useMenuOpenState():null;
const closeMenu=typeof menu?.[1]==="function"?menu[1]:NOOP;
const title=typeof props.displayTitle==="string"?props.displayTitle.trim():"";
if(title==="")return null;
const locked=scopeKey===""||state.busy===true;
const run=props.ui.dispatch.bind(null,"open-single",{workspaceId:scopeKey,sessionId:props.sessionId,title});
return VIEW.renderMenuItem(react.createElement,props.primitives,props.ui.text,{
label:props.ui.text("sidebar.sessionDelete.menu"),
danger:true,
attribute:"data-deg-session-delete-menu",
disabled:locked,
onSelect:()=>{closeMenu(false);void run();},
});
}
function SessionDeleteMenuMulti(props){
const react=props.react;
const state=react.useSyncExternalStore(props.ui.subscribe,props.ui.getSnapshot);
const scopeKey=useSessionScope(props,props.sessionId);
const menu=typeof props.useMenuOpenState==="function"?props.useMenuOpenState():null;
const closeMenu=typeof menu?.[1]==="function"?menu[1]:NOOP;
if(scopeKey==="")return null;
const locked=state.busy===true||isSelectionOpen(state.selection)===true;
const run=props.ui.dispatch.bind(null,"open-multi",{workspaceId:scopeKey,sessionId:props.sessionId});
return VIEW.renderMenuItem(react.createElement,props.primitives,props.ui.text,{
label:props.ui.text("sidebar.sessionDelete.multi"),
danger:true,
attribute:"data-deg-session-delete-multi",
disabled:locked,
onSelect:()=>{closeMenu(false);void run();},
});
}
function SessionDeleteLeadingCheck(props){
const react=props.react;
const state=react.useSyncExternalStore(props.ui.subscribe,props.ui.getSnapshot);
if(isSelectionOpen(state.selection)!==true)return null;
if(isSessionActionable(state.selection,props.sessionId)!==true)return null;
const candidate=selectionCandidateOf?.(state.selection,props.sessionId)??null;
return VIEW.renderLeadingCheckbox(react.createElement,props.ui.text,{
title:candidate===null?null:candidate.title,
checked:isSessionSelected(state.selection,props.sessionId)===true,
disabled:state.busy===true||state.selection.settling===true,
onToggle:props.ui.dispatch.bind(null,"toggle",{sessionId:props.sessionId}),
});
}
function SessionDeleteOverlay(props){
const react=props.react;
const ui=props.ui;
const state=react.useSyncExternalStore(ui.subscribe,ui.getSnapshot);
const dialogRef=react.useRef(null);
useDocumentWiring(react,props,state);
useReserveClass(react,state);
const t=ui.text;
const bar=isSelectionOpen(state.selection)===true
?VIEW.renderBar(react.createElement,props.primitives,t,{
counts:selectionCounts(state.selection),
busy:state.busy===true||state.selection.settling===true,
style:state.anchor??undefined,
onSelectAll:ui.dispatch.bind(null,"select-all"),
onDelete:ui.dispatch.bind(null,"delete-selected"),
onExit:ui.dispatch.bind(null,"exit"),
})
:null;
return react.createElement(react.Fragment,null,
bar,
VIEW.renderDialog(react.createElement,t,dialogViewOf(ui,state),{
dialogRef,
onCancel:ui.dispatch.bind(null,"cancel"),
onConfirm:ui.dispatch.bind(null,"confirm"),
}));
}
function installSessionDeleteUi(ctx,deps){
sweepStartupLocalKeys();
const slots=ctx?.slots;
const react=deps?.react;
if(slots===null||slots===undefined||typeof slots.inject!=="function"||typeof slots.register!=="function")return NOOP;
if(react===null||react===undefined||typeof react.createElement!=="function")return NOOP;
const t=VIEW.deleteTranslator(ctx);
const ui=Object.freeze({...makeDeleteUiStore({port:makePort(ctx,deps),t,ctx}),text:t});
const primitives=deps?.primitives??{};
const injected=()=>({ui,react,primitives});
slots.inject("sidebar.workspaces.session.row.action",()=>slots.register({
name:"sidebar.workspaces.session.row.action",
id:"dsh-expert-group-session-delete",
order:300,
inject:injected,
},SessionDeleteRowAction));
slots.inject("sidebar.workspaces.session.menu.item",()=>slots.register({
name:"sidebar.workspaces.session.menu.item",
id:"dsh-expert-group-session-delete",
order:460,
inject:injected,
},SessionDeleteMenuDelete));
slots.inject("sidebar.workspaces.session.menu.item",()=>slots.register({
name:"sidebar.workspaces.session.menu.item",
id:"dsh-expert-group-session-delete-multi",
order:470,
inject:injected,
},SessionDeleteMenuMulti));
slots.inject("sidebar.session.row.leading",()=>slots.register({
name:"sidebar.session.row.leading",
id:"dsh-expert-group-session-delete",
inject:injected,
},SessionDeleteLeadingCheck));
slots.inject("shell.overlay",()=>slots.register({
name:"shell.overlay",
id:"dsh-expert-group-session-delete",
order:10,
inject:injected,
},SessionDeleteOverlay));
return NOOP;
}
global[SYMBOL]=Object.freeze({
ROW_KEY_PREFIX,
RESERVE_CLASS,
anchorStyle,
convergeSettlement,
sweepStartupLocalKeys,
handleDocumentKeyDown,
handleRowClickEvent,
installSessionDeleteUi,
makeDeleteUiStore,
SessionDeleteLeadingCheck,
SessionDeleteMenuDelete,
SessionDeleteMenuMulti,
SessionDeleteOverlay,
SessionDeleteRowAction,
scopeKeyOf,
});
})(globalThis);
/* source: shared/peak-valley-time.js */
/* classic 投影：来自 shared/peak-valley-time.js 的机械导出改写，权威实现仍是该 ESM 文件。 */
(function installProjectedSource_shared_peak_valley_time_js(){
"use strict";
const MINUTES_PER_DAY=1440;
const MAX_PEAK_VALLEY_PERIODS=3;
const PEAK_VALLEY_PERIODS_INVALID="PEAK_VALLEY_PERIODS_INVALID";
const HHMM_PATTERN=/^([01]\d|2[0-3]):[0-5]\d$/;
function invalidPeriods(reason){
return{ok:false,code:PEAK_VALLEY_PERIODS_INVALID,reason};
}
function parseClockMinutes(value){
if(typeof value!=="string"||!HHMM_PATTERN.test(value))return null;
return Number(value.slice(0,2))*60+Number(value.slice(3,5));
}
function normalizePeakValleyPeriods(raw){
if(raw===void 0||raw===null)return{ok:true,periods:[]};
if(!Array.isArray(raw))return invalidPeriods("峰谷时段必须是 {start,end} 数组");
if(raw.length>MAX_PEAK_VALLEY_PERIODS){
return invalidPeriods("峰谷时段最多 "+MAX_PEAK_VALLEY_PERIODS+" 条，收到 "+raw.length+" 条");
}
const periods=[];
for(let index=0;index<raw.length;index+=1){
const position="第 "+(index+1)+" 项";
const item=raw[index];
if(item===null||typeof item!=="object"||Array.isArray(item)){
return invalidPeriods(position+"不是 {start,end} 对象");
}
const start=item.start;
const end=item.end;
if(typeof start!=="string"||typeof end!=="string"){
return invalidPeriods(position+"缺少 start/end 字符串字段");
}
if(parseClockMinutes(start)===null){
return invalidPeriods(position+"的 start 必须是 00:00–23:59 的 HH:mm");
}
if(parseClockMinutes(end)===null){
return invalidPeriods(position+"的 end 必须是 00:00–23:59 的 HH:mm");
}
if(start===end){
return invalidPeriods(position+"的 start 与 end 不能相同（空区间非法）");
}
periods.push({start,end});
}
return{ok:true,periods};
}
function peakValleyAtMinutes(periods,minutes){
if(!Number.isInteger(minutes)||minutes<0||minutes>=MINUTES_PER_DAY)return"valley";
if(!Array.isArray(periods))return"valley";
for(const period of periods){
if(period===null||typeof period!=="object")continue;
const start=parseClockMinutes(period.start);
const end=parseClockMinutes(period.end);
if(start===null||end===null||start===end)continue;
const hit=start<end
?minutes>=start&&minutes<end
:minutes>=start||minutes<end;
if(hit)return"peak";
}
return"valley";
}
function localWallClockMinutes(date){
try{
if(date===null||typeof date!=="object")return null;
if(typeof date.getTime!=="function"||typeof date.getHours!=="function"||typeof date.getMinutes!=="function"){
return null;
}
if(Number.isNaN(date.getTime()))return null;
const hours=date.getHours();
const minutes=date.getMinutes();
if(!Number.isInteger(hours)||hours<0||hours>23)return null;
if(!Number.isInteger(minutes)||minutes<0||minutes>59)return null;
return hours*60+minutes;
}catch{
return null;
}
}
function notifyInvalidDate(options,date){
if(options===null||typeof options!=="object")return;
const callback=options.onInvalidDate;
if(typeof callback!=="function")return;
try{
callback(date);
}catch{
}
}
function peakValleyAtDate(periods,date,options){
const minutes=localWallClockMinutes(date);
if(minutes===null){
notifyInvalidDate(options,date);
return"valley";
}
return peakValleyAtMinutes(periods,minutes);
}
function peakSpansOf(periods){
const spans=[];
if(!Array.isArray(periods))return spans;
for(const period of periods){
if(period===null||typeof period!=="object")continue;
const start=parseClockMinutes(period.start);
const end=parseClockMinutes(period.end);
if(start===null||end===null||start===end)continue;
if(start<end){
spans.push([start,end]);
}else{
spans.push([start,MINUTES_PER_DAY]);
spans.push([0,end]);
}
}
return spans;
}
function peakValleyPeriodsCoverFullDay(periods){
const spans=peakSpansOf(periods);
spans.sort((left,right)=>left[0]-right[0]);
let coveredUntil=0;
for(const span of spans){
if(span[0]>coveredUntil)return false;// 出现空档：0..coveredUntil 之后断开
if(span[1]>coveredUntil)coveredUntil=span[1];
if(coveredUntil>=MINUTES_PER_DAY)return true;
}
return coveredUntil>=MINUTES_PER_DAY;
}
/** 投影尾部（构建期生成）：公开检查点（与 ESM 导出面同形）。 */
globalThis[Symbol.for("dsh-expert-group/peak-valley-time")]=Object.freeze({MAX_PEAK_VALLEY_PERIODS,PEAK_VALLEY_PERIODS_INVALID,normalizePeakValleyPeriods,peakValleyAtMinutes,peakValleyAtDate,peakValleyPeriodsCoverFullDay});
})();
/* source: client-freshness.js */
/* classic 投影：来自源文件的机械导出改写，权威实现仍是 client-freshness.js。 */
(function installClientFreshness(global){
"use strict";
const CLIENT_FRESHNESS_MODULE_ID="dsh-expert-group/client-freshness";
const CLIENT_FRESHNESS_GLOBAL_KEY="dsh-expert-group/client-freshness";
function rpcErrorStatus(error){
const code=error?.code;
if(code==="settings-conflict")return 409;
if(code==="not-found"||code==="session-not-found")return 404;
if(code==="forbidden"||code==="connection-required")return 403;
if(code==="gateway/cancelled")return 499;
if(code==="bad-request")return 400;
return 500;
}
function normalizePluginRpcResult(result){
const ok=result?.ok===true;
const payload=ok?result.value:{ok:false,error:result?.error};
const status=ok?200:(Number.isSafeInteger(result?.status)&&result.status>0?result.status:rpcErrorStatus(result?.error));
return{
ok,
status,
async json(){return payload;},
};
}
async function requestPluginRpc(connection,request,init={},fetchImpl=globalThis.fetch,rpcTarget){
const rpc=connection?.rpc;
if(typeof rpc?.call==="function"){
const result=await rpc.call(rpcTarget.channel,rpcTarget.endpoint,request,init.signal);
return normalizePluginRpcResult(result);
}
if(typeof fetchImpl!=="function")throw new Error("当前 DSH 不支持插件 RPC");
return fetchImpl(rpcTarget.path,{
...init,
method:init.method??"POST",
credentials:init.credentials??"same-origin",
headers:{"content-type":"application/json",...(init.headers??{})},
body:init.body??JSON.stringify(request),
});
}
function createClientFreshnessBoundary({sessionId="",onUpdate}={}){
let disposed=false;
let currentSessionId=typeof sessionId==="string"?sessionId:"";
let sessionEpoch=0;
let sequence=0;
let notify=typeof onUpdate==="function"?onUpdate:null;
const latestRequests=new Map();
let settings={revision:-1,value:undefined};
let catalog={generation:-1,value:undefined};
let fanout={sessionId:currentSessionId,generation:-1,cursor:0,snapshot:undefined};
const requestKey=(kind,key="")=>String(kind)+"\u0000"+String(key??"");
const isObject=(value)=>value!==null&&typeof value==="object";
const safeRevision=(value)=>Number.isSafeInteger(value)&&value>=0;
const result=(accepted,reason,state)=>({accepted,reason,...(state===undefined?{}:{state})});
const emit=(kind,state)=>{
if(disposed||notify===null)return;
try{notify({kind,state});}catch{/* UI 订阅者异常不能破坏响应判定。 */}
};
const tokenIsCurrent=(token)=>{
if(disposed)return false;
if(token===undefined)return true;
if(!isObject(token))return false;
if(token.epoch!==sessionEpoch||token.sessionId!==currentSessionId)return false;
return latestRequests.get(token.key)===token.sequence;
};
const api={
beginSession(nextSessionId=""){
if(disposed)return Object.freeze({accepted:false,reason:"disposed",sessionId:currentSessionId,epoch:sessionEpoch});
currentSessionId=typeof nextSessionId==="string"?nextSessionId:"";
sessionEpoch+=1;
sequence+=1;
latestRequests.clear();
fanout={sessionId:currentSessionId,generation:-1,cursor:0,snapshot:undefined};
return Object.freeze({accepted:true,sessionId:currentSessionId,epoch:sessionEpoch,sequence});
},
beginRequest(kind,key=""){
if(disposed)return Object.freeze({accepted:false,reason:"disposed",kind,key,sessionId:currentSessionId,epoch:sessionEpoch,sequence});
const normalizedKey=requestKey(kind,key);
const token={accepted:true,kind,key:normalizedKey,sessionId:currentSessionId,epoch:sessionEpoch,sequence:++sequence};
latestRequests.set(normalizedKey,token.sequence);
return Object.freeze(token);
},
isCurrent(token){
return tokenIsCurrent(token);
},
isSessionCurrent(token){
return!disposed&&isObject(token)&&token.epoch===sessionEpoch&&token.sessionId===currentSessionId;
},
acceptSettingsSnapshot({revision,value,requestToken}={}){
if(!tokenIsCurrent(requestToken))return result(false,"stale-request",settings);
if(!safeRevision(revision))return result(false,"invalid-revision",settings);
if(revision<settings.revision)return result(false,"stale-revision",settings);
if(revision===settings.revision&&settings.value!==undefined)return result(false,"duplicate",settings);
settings={revision,value};
emit("settings",settings);
return result(true,undefined,settings);
},
acceptCatalogResponse({generation,groups,value,requestToken}={}){
if(!tokenIsCurrent(requestToken))return result(false,"stale-request",catalog);
if(!safeRevision(generation))return result(false,"invalid-generation",catalog);
if(generation<catalog.generation)return result(false,"stale-generation",catalog);
if(generation===catalog.generation&&catalog.value!==undefined)return result(false,"duplicate",catalog);
catalog={generation,value:value===undefined?groups:value};
emit("catalog",catalog);
return result(true,undefined,catalog);
},
acceptFanoutSnapshot({sessionId:incomingSessionId,generation,cursor,snapshot,requestToken}={}){
if(incomingSessionId!==currentSessionId)return result(false,"stale-session",fanout);
if(!tokenIsCurrent(requestToken))return result(false,"stale-request",fanout);
if(!safeRevision(generation))return result(false,"invalid-generation",fanout);
if(!safeRevision(cursor))return result(false,"invalid-cursor",fanout);
if(generation<fanout.generation)return result(false,"stale-generation",fanout);
if(cursor<fanout.cursor)return result(false,"stale-cursor",fanout);
if(generation===fanout.generation&&cursor===fanout.cursor&&fanout.snapshot!==undefined)return result(false,"duplicate",fanout);
fanout={sessionId:currentSessionId,generation,cursor,snapshot};
emit("fanout",fanout);
return result(true,undefined,fanout);
},
acceptFanoutEvents({sessionId:incomingSessionId,generation,cursor,events,snapshot,requestToken}={}){
return api.acceptFanoutSnapshot({
sessionId:incomingSessionId,
generation,
cursor,
snapshot:snapshot===undefined?events:snapshot,
requestToken,
});
},
acceptFanoutAction({sessionId:incomingSessionId,generation,requestToken}={}){
if(incomingSessionId!==currentSessionId)return result(false,"stale-session");
if(!tokenIsCurrent(requestToken))return result(false,"stale-request");
if(generation!==undefined&&(!safeRevision(generation)||generation<fanout.generation))return result(false,"stale-generation");
return result(true,undefined,fanout);
},
snapshot(){
return{
disposed,
sessionId:currentSessionId,
epoch:sessionEpoch,
settings,
catalog,
fanout,
};
},
dispose(){
if(disposed)return false;
disposed=true;
latestRequests.clear();
notify=null;
settings={revision:-1,value:undefined};
catalog={generation:-1,value:undefined};
fanout={sessionId:currentSessionId,generation:-1,cursor:0,snapshot:undefined};
return true;
},
};
return Object.freeze(api);
}
async function commitSettingsCandidate(settings,revision,{request=globalThis.fetch,connection,normalizeSettingsDraft,roles,rpcTarget}={}){
const body={action:"settings-commit",settings,expectedRevision:revision};
const response=typeof connection?.rpc?.call==="function"
?await requestPluginRpc(connection,body,{},globalThis.fetch,rpcTarget)
:await request(rpcTarget.path,{
method:"POST",
credentials:"same-origin",
headers:{"content-type":"application/json"},
body:JSON.stringify(body),
});
return readSettingsCommitOutcome(response,normalizeSettingsDraft,roles);
}
async function readSettingsCommitOutcome(response,normalizeDraft,roles){
let payload;
try{
payload=await response.json();
}catch{
throw new Error("设置保存响应无效");
}
if(!response.ok||payload?.ok!==true){
const issue=payload?.error&&typeof payload.error==="object"?payload.error:{};
const message=issue.message??payload?.message;
const error=new Error(typeof message==="string"?message:"设置保存失败");
if(typeof issue.code==="string")error.code=issue.code;
if(Number.isSafeInteger(response.status)&&response.status>0)error.status=response.status;
const currentRevision=issue.details?.revision??issue.details?.currentRevision??payload?.revision;
if(Number.isSafeInteger(currentRevision)&&currentRevision>=0)error.currentRevision=currentRevision;
throw error;
}
if(!payload.settings||typeof payload.settings!=="object"||Array.isArray(payload.settings)
||!Number.isSafeInteger(payload.revision)||payload.revision<0){
throw new Error("设置保存响应无效");
}
const rolePrompts=payload.rolePrompts!==null&&typeof payload.rolePrompts==="object"
&&!Array.isArray(payload.rolePrompts)
?payload.rolePrompts
:void 0;
return{
settings:normalizeDraft(payload.settings,roles),
revision:payload.revision,
...(rolePrompts===void 0?{}:{rolePrompts}),
};
}
const __DEG_CLIENT_FRESHNESS_DESCRIPTOR__=Object.freeze({
id:CLIENT_FRESHNESS_MODULE_ID,
factory:()=>Object.freeze({
createClientFreshnessBoundary,
rpcErrorStatus,
normalizePluginRpcResult,
requestPluginRpc,
commitSettingsCandidate,
readSettingsCommitOutcome,
registerClientFreshnessModule,
}),
});
const REGISTERED_LOADERS_KEY=Symbol.for("dsh-expert-group/client-freshness#registered-loaders");
function registeredLoaderSet(host){
const existing=host?.[REGISTERED_LOADERS_KEY];
if(existing!==null&&typeof existing==="object"
&&typeof existing.has==="function"&&typeof existing.add==="function"&&typeof existing.delete==="function"){
return existing;
}
try{
const created=new WeakSet();
Object.defineProperty(host,REGISTERED_LOADERS_KEY,{value:created,configurable:true,writable:true});
return created;
}catch{
return null;
}
}
function registerClientFreshnessModule(loader=globalThis.__ModuleLoader__){
if(loader===null||typeof loader!=="object"||typeof loader.load!=="function")return false;
const registered=registeredLoaderSet(globalThis);
if(registered!==null&&registered.has(loader))return false;
if(registered!==null)registered.add(loader);
try{
loader.load(__DEG_CLIENT_FRESHNESS_DESCRIPTOR__);
}catch(error){
if(registered!==null)registered.delete(loader);
throw error;
}
return true;
}
/** 投影尾部（构建期生成）：公开检查点 + ModuleLoader 登记。 */
global[Symbol.for(CLIENT_FRESHNESS_GLOBAL_KEY)]=__DEG_CLIENT_FRESHNESS_DESCRIPTOR__.factory();
registerClientFreshnessModule(global.__ModuleLoader__);
})(globalThis);
/* source: client-entry.js */
window.__ModuleLoader__.load({
id:"dsh-expert-group",
factory:(require)=>{
const FRESHNESS_MODULE_ID="dsh-expert-group/client-freshness";
const freshnessModule=(()=>{
if(typeof require!=="function")return void 0;
for(const specifier of[FRESHNESS_MODULE_ID,"./"+FRESHNESS_MODULE_ID,"./client-freshness.js"]){
try{
const loaded=require(specifier);
if(loaded!==null&&typeof loaded==="object")return loaded;
}catch{/* 未登记，尝试下一个 specifier 形式。 */}
}
return void 0;
})();
if(typeof freshnessModule?.registerClientFreshnessModule==="function"
&&typeof globalThis!=="undefined"&&globalThis.__ModuleLoader__!==void 0){
freshnessModule.registerClientFreshnessModule(globalThis.__ModuleLoader__);
}
var module={exports:{}};
var exports=module.exports;
Object.defineProperty(exports,Symbol.toStringTag,{value:"Module"});
const react=require("react");
const primitives=require("@deepseek-ai/dsh-client-ui-primitives");
const expertGroupModel=globalThis[Symbol.for("dsh-expert-group/client-expert-group-model")];
const expertGroupSidebar=globalThis[Symbol.for("dsh-expert-group/client-expert-group-sidebar")];
const clientTextLayer=globalThis[Symbol.for("dsh-expert-group/client-text")]||{};
const{
SETTINGS_EXTRA_MESSAGES,SETTINGS_ZH_FALLBACK,settingsExtraText,
}=clientTextLayer;
const clientStylesModule=globalThis[Symbol.for("dsh-expert-group/client-styles")]||{};
const{
ensurePluginStylesheet,
}=clientStylesModule;
const clientModelConfigHostModule=globalThis[Symbol.for("dsh-expert-group/client-model-config-host")]||{};
const{
createModelConfigHost,
}=clientModelConfigHostModule;
const clientFanoutModule=globalThis[Symbol.for("dsh-expert-group/client-fanout-normalize")]||{};
const{
fanoutCanCancelParent,fanoutCanCancelShard,fanoutCanRetryShard,fanoutStatusLabel,fanoutTaskLabel,mergeFanoutEvent,
normalizeFanoutListResponse,normalizeFanoutTask,
}=clientFanoutModule;
const clientNativeStatusModule=globalThis[Symbol.for("dsh-expert-group/client-native-status")]||{};
const{
NATIVE_RUNNING_STATUS_PREFIX,NATIVE_RUNNING_STATUS_PREFIXES,createNativeTextRewriter,findNativeConversationScope,
findNativeStatusTextNode,replaceNativeStatusPrefix,resolveRunningStatusText,
}=clientNativeStatusModule;
const clientSettingsNormalizeModule=globalThis[Symbol.for("dsh-expert-group/client-settings-normalize")]||{};
const{
PROMPT_ROLE_IDS,addModelCandidatePage,commitSettingsCandidate,compactModelCandidatesDraft,countUnicodeGraphemes,createSettingsModelCatalog,
migrateSettingsDefaults,migrateSettingsSelection,modelLayerSelectionOf,modelPageCountOf,normalizeModelCandidatesDraft,normalizeModelFallbackLimitDraft,
normalizePromptOverrides,normalizeRolePromptProjection,normalizeSettingsDraft,normalizeSettingsModelGroups,removeModelCandidatePage,reorderModelLayers,
resolveSettingsForm,setModelLayerSelection,syncSettingsDefaultsProvider,unifiedProviderOf,validateModelCandidateRows,validatePromptText,
}=clientSettingsNormalizeModule;
const clientSubagentModule=globalThis[Symbol.for("dsh-expert-group/client-subagent-metadata")]||{};
const{
SubagentMetadataBridge,applySubagentMetadata,collectSubagentCatalog,expertGroupRootSessionIdOf,findNativeSubagentRowParts,findNativeSubagentTreeItems,
findNativeSubagentTrees,formatSubagentMetadata,installNativeStatusBridge,normalizeSubagentMetadata,removeSubagentMetadata,requestSubagentMetadata,
}=clientSubagentModule;
const clientSettingsMainBModule=globalThis[Symbol.for("dsh-expert-group/client-settings-main-b")]||{};
const clientSettingsMainAModule=globalThis[Symbol.for("dsh-expert-group/client-settings-main-a")]||{};
const{
DshExpertGroupSettings,
}=clientSettingsMainAModule;
const clientModelViewsAModule=globalThis[Symbol.for("dsh-expert-group/client-model-views-a")]||{};
const clientModelViewsBModule=globalThis[Symbol.for("dsh-expert-group/client-model-views-b")]||{};
const clientProviderCardModule=globalThis[Symbol.for("dsh-expert-group/client-provider-card")]||{};
const clientModelSectionModule=globalThis[Symbol.for("dsh-expert-group/client-model-section")]||{};
const{
ModelConfigSection,
}=clientModelSectionModule;
const clientConversationAdaptersModule=globalThis[Symbol.for("dsh-expert-group/client-conversation-adapters")]||{};
const{
FullSystemPromptNode,installImageSubmissionRoute,
}=clientConversationAdaptersModule;
const clientNavIconModule=globalThis[Symbol.for("dsh-expert-group/client-nav-icon")]||{};
const{
DEG_SETTINGS_SECTION_ID,DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS,DEG_SETTINGS_NAV_ICON_PATHS,
installDegSettingsNavIcon,isDegSettingsNavRow,
}=clientNavIconModule;
const clientPluginDetailModule=globalThis[Symbol.for("dsh-expert-group/client-plugin-detail")]||{};
const{
DEG_PLUGIN_DETAIL_ENTRY_KEY,DEG_PLUGIN_DETAIL_SLOT_NAME,DEG_SETTINGS_SECTION_SLOT_NAME,
DegPluginDetailSummary,describeDegPluginDetailSummary,resolveDegSettingsSectionOpener,
}=clientPluginDetailModule;
const clientSidebarEntryModule=globalThis[Symbol.for("dsh-expert-group/client-sidebar-entry")]||{};
const{
installDegSidebarEntry,
}=clientSidebarEntryModule;
const clientSessionDeleteUiModule=globalThis[Symbol.for("dsh-expert-group/client-session-delete-ui")]||{};
const{
installSessionDeleteUi,
}=clientSessionDeleteUiModule;
const peakValleyTime=globalThis[Symbol.for("dsh-expert-group/peak-valley-time")];
ensurePluginStylesheet();
const RPC_PATH="/api/dsh-expert-group";
const RPC_CHANNEL="/dsh-expert-group";
const RPC_ENDPOINT="rpc";
const RPC_TARGET=Object.freeze({path:RPC_PATH,channel:RPC_CHANNEL,endpoint:RPC_ENDPOINT});
function resolveFreshnessSurface(){
if(typeof require==="function"){
for(const specifier of[FRESHNESS_MODULE_ID,"./"+FRESHNESS_MODULE_ID,"./client-freshness.js"]){
try{
const loaded=require(specifier);
if(loaded!==null&&typeof loaded==="object")return loaded;
}catch{/* 未登记，尝试下一个 specifier 形式。 */}
}
}
return freshnessModule;
}
function requireFreshnessSurface(){
const surface=resolveFreshnessSurface();
if(surface===void 0){
throw new Error("dsh-expert-group: freshness 共享模块未装载（发布 bundle 缺少 client-freshness 投影片段）");
}
return surface;
}
function normalizePluginRpcResult(result){
return requireFreshnessSurface().normalizePluginRpcResult(result);
}
async function requestPluginRpc(connection,request,init={},fetchImpl=globalThis.fetch){
return requireFreshnessSurface().requestPluginRpc(connection,request,init,fetchImpl,RPC_TARGET);
}
function createClientFreshnessBoundary(options={}){
return requireFreshnessSurface().createClientFreshnessBoundary(options);
}
const clientRuntimeHost=Object.freeze({
react,primitives,requestPluginRpc,requireFreshnessSurface,createClientFreshnessBoundary,
RPC_PATH,RPC_CHANNEL,RPC_ENDPOINT,RPC_TARGET,ModelConfigSection,
peakValleyTime,
});
clientSettingsNormalizeModule.bindClientRuntime?.(clientRuntimeHost);
clientSubagentModule.bindClientRuntime?.(clientRuntimeHost);
clientSettingsMainBModule.bindClientRuntime?.(clientRuntimeHost);
clientSettingsMainAModule.bindClientRuntime?.(clientRuntimeHost);
clientModelViewsAModule.bindClientRuntime?.(clientRuntimeHost);
clientModelViewsBModule.bindClientRuntime?.(clientRuntimeHost);
clientProviderCardModule.bindClientRuntime?.(clientRuntimeHost);
clientModelSectionModule.bindClientRuntime?.(clientRuntimeHost);
clientConversationAdaptersModule.bindClientRuntime?.(clientRuntimeHost);
clientPluginDetailModule.bindClientRuntime?.(clientRuntimeHost);
function apply(ctx){
ctx.effect(()=>installImageSubmissionRoute(ctx),"dsh-expert-group: image submission route");
ctx.effect(()=>installDegSettingsNavIcon(),"dsh-expert-group: settings nav brand icon");
ctx.effect(()=>installNativeStatusBridge(ctx),"dsh-expert-group: native status bridge");
const slots=ctx.slots;
slots.inject("conversation.chat.node",()=>slots.register({
name:"conversation.chat.node",
key:"system-prompt",
priority:-1,
},FullSystemPromptNode));
const resolveConfigForms=()=>{
try{
const service=typeof ctx?.get==="function"?ctx.get("configForms"):ctx?.configForms;
return service!==undefined&&service!==null?service:null;
}catch{
return null;
}
};
const configForms=resolveConfigForms();
const SETTINGS_ENTRY_ID=DEG_SETTINGS_SECTION_ID;
const UNAVAILABLE_SETTINGS_SNAPSHOT=Object.freeze({
status:"unavailable",
value:undefined,
base:undefined,
user:undefined,
revision:undefined,
writable:false,
mode:"memory",
});
const settingsForm=resolveSettingsForm(configForms,SETTINGS_ENTRY_ID,UNAVAILABLE_SETTINGS_SNAPSHOT);
const modelCatalog=createSettingsModelCatalog(ctx);
const modelConfigHost=createModelConfigHost(ctx,configForms);
slots.inject(DEG_SETTINGS_SECTION_SLOT_NAME,()=>slots.register({
name:DEG_SETTINGS_SECTION_SLOT_NAME,
id:SETTINGS_ENTRY_ID,
order:25,
label:()=>SETTINGS_ENTRY_ID,
inject:()=>({settingsForm,modelCatalog,modelConfigHost,ctx}),
},DshExpertGroupSettings));
if(typeof installDegSidebarEntry==="function"){
installDegSidebarEntry(ctx,{
react,
id:DEG_SETTINGS_SECTION_ID,
iconPaths:DEG_SETTINGS_NAV_ICON_PATHS,
settingsComponent:DshExpertGroupSettings,
settingsForm,
modelCatalog,
modelConfigHost,
});
}
slots.inject(DEG_PLUGIN_DETAIL_SLOT_NAME,()=>slots.register({
name:DEG_PLUGIN_DETAIL_SLOT_NAME,
key:DEG_PLUGIN_DETAIL_ENTRY_KEY,
inject:()=>({settingsForm,modelCatalog,ctx}),
},DegPluginDetailSummary));
slots.inject("shell.overlay",()=>slots.register({
name:"shell.overlay",
id:"dsh-expert-group-overlay",
order:0,
},(props)=>react.createElement(
react.Fragment,
null,
react.createElement(SubagentMetadataBridge,{...props,ctx}),
)));
installSettingsBoundSidebar(ctx,{settingsForm,modelCatalog});
if(typeof installSessionDeleteUi==="function"){
installSessionDeleteUi(ctx,{react,primitives,requestPluginRpc});
}
}
function installSettingsBoundSidebar(ctx,{settingsForm,modelCatalog}){
if(typeof expertGroupSidebar?.installExpertGroupSidebar!=="function")return;
const sidebarDeps={
react,
primitives,
requestPluginRpc,
resolveRootSessionId:expertGroupRootSessionIdOf,
sessions:ctx.sessions,
slots:ctx.slots,
modelCatalog,
confirm:(message)=>typeof globalThis.confirm==="function"&&globalThis.confirm(message)===true,
getAutoOpenSubagentSidebar:()=>readAutoOpenSubagentSidebar(),
setAutoOpenSubagentSidebar:(next)=>commitAutoOpenSubagentSidebar(next),
getPeakValleySettings:readPeakValleySettings,
subscribePeakValleySettings:typeof settingsForm?.subscribe==="function"?subscribePeakValleySettings:null,
peakValleyTime,
settingsExtraText,
};
const readAutoOpenSubagentSidebar=()=>{
try{
const snapshot=typeof settingsForm?.getSnapshot==="function"?settingsForm.getSnapshot():void 0;
return snapshot?.value?.autoOpenSubagentSidebar===true;
}catch{
return false;
}
};
const commitAutoOpenSubagentSidebar=async(next)=>{
try{
const snapshot=typeof settingsForm?.getSnapshot==="function"?settingsForm.getSnapshot():void 0;
if(snapshot?.writable!==true)return false;
const value=snapshot.value;
if(value===null||typeof value!=="object")return false;
await commitSettingsCandidate(
{...value,autoOpenSubagentSidebar:next===true},
snapshot.revision,
globalThis.fetch,
ctx?.connection,
PROMPT_ROLE_IDS,
);
return true;
}catch{
return false;
}
};
const readTaskManagementEnabled=()=>{
try{
const snapshot=typeof settingsForm?.getSnapshot==="function"?settingsForm.getSnapshot():void 0;
return snapshot?.value?.taskManagementEnabled!==false;
}catch{
return true;
}
};
function readPeakValleySettings(){
try{
return settingsForm?.getSnapshot?.().value?.peakValley??null;
}catch{
return null;
}
}
function subscribePeakValleySettings(listener){
return settingsForm?.subscribe?.(listener)??null;
}
ctx.effect(()=>{
let disposer=null;
const install=()=>{
if(disposer!==null)return;
if(readTaskManagementEnabled()!==true)return;
const release=expertGroupSidebar.installExpertGroupSidebar(ctx,{
...sidebarDeps,
taskManagementEnabled:true,
});
disposer=typeof release==="function"?release:null;
};
const uninstall=()=>{
const release=disposer;
disposer=null;
if(release===null)return;
try{
release();
}catch{
}
};
const sync=()=>{
if(readTaskManagementEnabled())install();
else uninstall();
};
sync();
let unsubscribe=()=>{};
if(typeof settingsForm?.subscribe==="function"){
try{
const release=settingsForm.subscribe(()=>{
try{
sync();
}catch{
}
});
if(typeof release==="function")unsubscribe=release;
}catch{
}
}
return()=>{
try{
unsubscribe();
}catch{
}
unsubscribe=()=>{};
uninstall();
};
},"dsh-expert-group-sidebar");
}
exports.normalizeSettingsModelGroups=normalizeSettingsModelGroups;
exports.normalizeSettingsDraft=normalizeSettingsDraft;
exports.normalizeModelCandidatesDraft=normalizeModelCandidatesDraft;
exports.normalizeModelFallbackLimitDraft=normalizeModelFallbackLimitDraft;
exports.validateModelCandidateRows=validateModelCandidateRows;
exports.modelPageCountOf=modelPageCountOf;
exports.modelLayerSelectionOf=modelLayerSelectionOf;
exports.setModelLayerSelection=setModelLayerSelection;
exports.reorderModelLayers=reorderModelLayers;
exports.addModelCandidatePage=addModelCandidatePage;
exports.removeModelCandidatePage=removeModelCandidatePage;
exports.compactModelCandidatesDraft=compactModelCandidatesDraft;
exports.SETTINGS_EXTRA_MESSAGES=SETTINGS_EXTRA_MESSAGES;
exports.settingsExtraText=settingsExtraText;
exports.countUnicodeGraphemes=countUnicodeGraphemes;
exports.validatePromptText=validatePromptText;
exports.normalizePromptOverrides=normalizePromptOverrides;
exports.normalizeRolePromptProjection=normalizeRolePromptProjection;
exports.unifiedProviderOf=unifiedProviderOf;
exports.migrateSettingsSelection=migrateSettingsSelection;
exports.syncSettingsDefaultsProvider=syncSettingsDefaultsProvider;
exports.migrateSettingsDefaults=migrateSettingsDefaults;
exports.commitSettingsCandidate=commitSettingsCandidate;
exports.formatSubagentMetadata=formatSubagentMetadata;
exports.normalizeSubagentMetadata=normalizeSubagentMetadata;
exports.collectSubagentCatalog=collectSubagentCatalog;
exports.requestSubagentMetadata=requestSubagentMetadata;
exports.findNativeSubagentTrees=findNativeSubagentTrees;
exports.findNativeSubagentTreeItems=findNativeSubagentTreeItems;
exports.findNativeSubagentRowParts=findNativeSubagentRowParts;
exports.applySubagentMetadata=applySubagentMetadata;
exports.removeSubagentMetadata=removeSubagentMetadata;
exports.findNativeConversationScope=findNativeConversationScope;
exports.SETTINGS_ZH_FALLBACK=SETTINGS_ZH_FALLBACK;
exports.NATIVE_RUNNING_STATUS_PREFIXES=NATIVE_RUNNING_STATUS_PREFIXES;
exports.NATIVE_RUNNING_STATUS_PREFIX=NATIVE_RUNNING_STATUS_PREFIX;
exports.replaceNativeStatusPrefix=replaceNativeStatusPrefix;
exports.resolveRunningStatusText=resolveRunningStatusText;
exports.createNativeTextRewriter=createNativeTextRewriter;
exports.findNativeStatusTextNode=findNativeStatusTextNode;
exports.installNativeStatusBridge=installNativeStatusBridge;
exports.normalizeFanoutTask=normalizeFanoutTask;
exports.mergeFanoutEvent=mergeFanoutEvent;
exports.fanoutTaskLabel=fanoutTaskLabel;
exports.fanoutStatusLabel=fanoutStatusLabel;
exports.fanoutCanCancelShard=fanoutCanCancelShard;
exports.fanoutCanRetryShard=fanoutCanRetryShard;
exports.fanoutCanCancelParent=fanoutCanCancelParent;
exports.normalizeFanoutListResponse=normalizeFanoutListResponse;
exports.createClientFreshnessBoundary=createClientFreshnessBoundary;
exports.normalizePluginRpcResult=normalizePluginRpcResult;
exports.requestPluginRpc=requestPluginRpc;
exports.expertGroupModel=expertGroupModel;
exports.expertGroupSidebar=expertGroupSidebar;
exports.modelConfig=globalThis[Symbol.for("dsh-expert-group/client-model-config")];
exports.createModelConfigHost=createModelConfigHost;
exports.peakValleyTime=peakValleyTime;
exports.MODEL_REASONING_EFFORTS=Object.freeze([
"off","minimal","low","medium","high","xhigh","max",
]);
exports.describeDegPluginDetailSummary=describeDegPluginDetailSummary;
exports.resolveDegSettingsSectionOpener=resolveDegSettingsSectionOpener;
exports.DEG_PLUGIN_DETAIL_SLOT_NAME=DEG_PLUGIN_DETAIL_SLOT_NAME;
exports.DEG_PLUGIN_DETAIL_ENTRY_KEY=DEG_PLUGIN_DETAIL_ENTRY_KEY;
exports.DEG_SETTINGS_NAV_ICON_PATHS=DEG_SETTINGS_NAV_ICON_PATHS;
exports.DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS=DEG_SETTINGS_NAV_ICON_FALLBACK_PATHS;
exports.isDegSettingsNavRow=isDegSettingsNavRow;
exports.installDegSettingsNavIcon=installDegSettingsNavIcon;
exports.apply=apply;
exports.inject=[
"slots","sessions","configForms","remote","remote.session","remote.llm","remote.credentials","remote.settings","conversation","connection",
"settingsSchema",
];
return module.exports;
}
});
