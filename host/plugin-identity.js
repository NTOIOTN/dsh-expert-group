/**
 * 组合根顶层的第 S4 段（R1 票据 06）：自 index.js 第 425–485 行整段搬移。
 *
 * 只做搬移：逻辑行、常量值与导出语义均未改动；import 按本模块实际使用面重建，
 * 不继承 index.js 的组合根 import 头（那段是装配清单，不是本模块的内容）。
 */

/**
 * Host 半：dsh-expert-group 专家子代理工具，加按父会话 + 角色保存的
 * 模型覆盖，以及一个同源、仅 POST JSON 的私有 RPC 路由，供 Web 右侧侧边栏读写当前会话配置。
 * 本插件不修改 DSH 核心源码；只通过现有 Host 服务注册能力。
 * @module dsh-expert-group
 */

export const name = "dsh-expert-group";
/**
 * DEG 注入会话消息时使用的生产者自有 source kind。
 *
 * 会话格式 V4 拒绝精确的 `kind: "plugin"`（旧插件包装语法），要求消息来源属于
 * 生产者自有 kind 集合。0.1.7 对未知插件的规范形式是 `plugin:<插件名>`，因此这里
 * 复用同一派生规则，而不是冒用 `subagent-*` 等第一方身份。集中定义以便源码契约
 * 测试锁定该形状，避免回归到被拒的旧写法。
 */
export const PRODUCER_SOURCE_KIND = "plugin:" + name;
// RPC_ENDPOINT 只用于独立 Connection channel；旧 HTTP 路径仍由 RPC_PATH 保持兼容。

// Cordis FiberState 的稳定数值镜像。插件不导入 settings helper，避免 optional peer
// 缺失时模块加载失败；仍需区分 settings provider 脱离和插件自身卸载。
const FIBER_DISPOSED = 4;
const FIBER_UNLOADING = 5;

function isSettingsConsumerUnloading(ctx) {
  try {
    const state = ctx.fiber?.state;
    return state === FIBER_DISPOSED || state === FIBER_UNLOADING;
  } catch {
    return false;
  }
}

// ── root turn 等待：后代查询的 sentinel ─────────────────────────────────────
/**
 * `workspace/session-activity` waterfall 的**无 provider sentinel**。
 *
 * 为什么必须有它（P0）：Cordis 的 `waterfall` 实现在**没有任何 listener** 时是
 * `(cbs.shift() ?? inner)(...args)`——即直接调用调用方传入的最内层回调。而宿主的
 * subagent provider 在「没有 running 后代」时是 `return rest`（**原样透传**最内层
 * 返回值）。因此若最内层返回 `[]`，「topic 没有 provider」与「provider 明确报告空」
 * 的返回值完全同形，会被误判成「可证明没有 running 后代」。
 *
 * 语义（模块唯一、对象身份相等才算命中）：
 * - 结果 **=== 本 sentinel** ⟹ 没有任何 listener 产出新数组 ⟹ 链路没有贡献任何事实
 *   （没有 provider，或 provider 原样透传）⟹ **无法证明**静止 ⟹ `known:false`；
 * - 结果 **不是** sentinel 的数组 ⟹ 至少有一个 listener 产出了新数组（provider 只有
 *   在真的贡献自己的族时才 `[own, ...rest]`）⟹ 链路确实跑过，可以按族解析。
 *
 * **sentinel 不足以覆盖的第二个洞（P1）**：`workspace/session-activity` 是**非专属**
 * 扩展点，任何第三方 listener 都可以返回一个**新的空数组**（既不 spread 最内层值，也
 * 不检查 subagent 血缘）。这种结果与「provider 明确报告没有 running 后代」在返回值上
 * 依旧同形，而 sentinel 只能识别「链路完全没有贡献」，识别不了「贡献者是谁」。因此
 * 判定层**不得**把任何空数组当作静止证明：waterfall 只能提供**正向**证据（确有
 * `kind === "subagent"` 的 running 条目），静止证明只来自权威 listing。
 *
 * 冻结空数组既保证 spread 安全（`[own, ...sentinel]` 不会抛错、也不会引入假条目），
 * 又保证身份唯一（`Object.freeze` 后的模块级单例不可能被外部复制）。
 */
export const SESSION_ACTIVITY_NO_PROVIDER = Object.freeze([]);

