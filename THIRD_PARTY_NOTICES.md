# 第三方声明

## 上游项目

- 项目名：**oh-my-opencode-slim**
- 仓库：https://github.com/alvinunreal/oh-my-opencode-slim
- 许可证：**MIT**
- 上游 LICENSE 原文署名（未写具体持有人）：`Copyright (c) 2025`

本包的设计思路（按职责划分专家子代理、只读/可写权限分层、按角色路由模型与思考深度、
后台并行委派纪律、主代理 orchestrator 的编排位置）来自该项目；在 DSH 上的实现为独立重写。
按 MIT「保留版权声明与许可声明」的要求，其许可条款原文见本仓库 `LICENSE` 末尾附录。

## 复用边界

- 复用其**设计思路与角色定位**；未复制其 TypeScript 源码、OpenCode SDK 集成、Bun 构建产物
  或桌面 Companion 实现，所有代码均针对 DSH 的 Cordis Service / Event / Slot 接口独立编写。
- 本包与上游项目、其作者及 OpenCode 项目均无隶属或背书关系。

## 角色名与职责映射

| 角色 | 职责（对齐上游多代理专家设计） |
|---|---|
| explorer | 快速低成本代码库侦察 |
| librarian | 外部知识检索 |
| oracle | 最强高推理模型：架构 / 调试 / 代码审查 |
| designer | 视觉打磨 |
| fixer | 快速实现专家 |
| observer | 视觉解读（默认禁用） |

## 其它第三方组件

- 本包不修改 `@deepseek-ai/dsh` 的任何核心源码，也不修改 shipped agent preset；
  所列 DSH 包仅作为 `peerDependencies` 由宿主提供。
- `sharp` 为可选依赖（`optionalDependencies`），未安装时仅禁用图片增强能力。
