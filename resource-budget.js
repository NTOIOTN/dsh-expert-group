/**
 * 资源预算模块（fan-out 退役后保留的空模块）。
 *
 * 历史职责：本模块曾集中定义 fan-out 任务的字节/数量预算（`FANOUT_BUDGET`）、预算测量
 * （`measureUtf8Bytes` / `measureJsonBytes`）、结构化违规描述（`describeBudgetViolation`）、
 * 各类 `check*Budget` 判定、聚合反馈截断（`truncateFeedbackText`）与事件历史记账
 * （`createEventHistoryAccounting`）。这些导出只服务于 fan-out 父任务/分片/attempt 的
 * 输入、结果、事件与快照上限。
 *
 * 为什么现在是空的：fan-out 已整体物理删除，上述导出的**全部消费方**（`fanout/`、
 * `host/fanout-*`、`host/index-expert-tools-fanout.js`、`host/index-template-plan.js`）
 * 都已随本批次删除；普通专家角色派发、root turn 等待账本、handoff 与共享 storage 写链
 * 均不依赖本模块。留着旧函数只会成为无人调用的 fan-out 专属死代码。
 *
 * 为什么保留文件而不是删掉：`package.json` 的 `exports["./resource-budget"]` 与 `files`
 * 仍登记本路径，本轮范围明确不修改 `exports`，因此保留一个零导出的空模块以满足包入口
 * 解析；是否整文件删除应由后续单独批次连同 `exports` / `files` 一起决定。
 *
 * @module dsh-expert-group/resource-budget
 */
