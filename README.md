# dsh-expert-group

[English](README.en.md) | **中文**

本项目是deepseek harness(后续简写为dsh) 类omo-slim的子代理插件。主代理负责拆解任务、委派专家、整合结果与验证；插件提供可配置模型的角色化专家(每个专家都可配置候补模型和峰时谷时模型)、任务侧栏、模型配置、任务通知及会话删除等功能。

## 安装

本插件发布到 npm 公共源，可直接用 npm 安装：

```shell
npm i dsh-expert-group
```

也可以在 DSH 的「添加插件」页面按包名安装：在输入框中填入 `dsh-expert-group`或索引，按需在右侧切换安装源，然后点击「安装」。

<p align="center"><a href="https://github.com/NTOIOTN/dsh-expert-group/blob/master/docs/assets/dsh-plugin-add-dialog.png"><img src="https://github.com/NTOIOTN/dsh-expert-group/raw/master/docs/assets/dsh-plugin-add-dialog.png" alt="DSH「添加插件」对话框截图：输入框中填写的是 dsh-expert-group，右侧可切换安装源"></a></p>

## 专家角色

| 角色          | 用途                             | 默认权限边界                     |
| ------------- | -------------------------------- | -------------------------------- |
| `explorer`  | 定位代码、梳理符号与现有模式     | 只读                             |
| `librarian` | 调研外部文档与库 API             | 只读                             |
| `oracle`    | 架构取舍、疑难问题与代码评审     | 只读                             |
| `designer`  | 实现用户可见的 UI/UX 工作        | 可写，按任务路径约束             |
| `fixer`     | 实现边界明确的多文件变更并补测试 | 可写，按任务路径约束             |
| `observer`  | 分析图片、截图、图表和 PDF       | 只读；视觉模型能力取决于宿主配置 |

## 插件设置

设置页总体功能如下图，主要包含模型配置、插件功能启用管理、专家子代理模型配置与管理三部分

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167391173.png" alt="1793167391173"></p>
<p align="center"><sub>DEG插件设置页总览</sub></p>

### 模型配置

与dsh的模型设置页功能一致，之前开发这个功能是为了方便设置自定义供应商的图像输入及思考深度，现在dsh模型设置也有这些功能了，在插件中设置与在dsh模型中设置效果一样，两边数据互通可以同步。

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167502011.png" alt="1793167502011"></p>
<p align="center"><sub>模型配置功能</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793169619722.png" alt="1793169619722"></p>
<p align="center"><sub>DEG插件思考档位与输入类型设置</sub></p>

### 插件功能启用管理

- **任务管理**：勾选后启用右侧边栏任务管理窗口，默认勾选
- **Auto**：勾选后启用右侧边栏子代理会话自动展开、自动回收功能，默认不勾选
- **左侧栏入口**：勾选后在dsh左侧边栏添加插件设置入口，默认勾选
- **通知弹窗**：勾选后触发通知事件会调用系统弹窗，默认勾选
- **通知音量**：设置通知音量，默认100
- **通知时间**：设置触发通知的事件，默认全选

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167576121.png" alt="1793167576121"></p>
<p align="center"><sub>插件功能管理</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167687070.png" alt="1793167687070"></p>
<p align="center"><sub>右侧边栏任务管理窗口</sub></p>

**侧边栏会话模型功能**：仅修改当前会话的模型配置。

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793170346274.png" alt="1793170346274"></p>
<p align="center"><sub>侧边栏会话模型页</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167858911.png" alt="1793167858911"></p>
<p align="center"><sub>左侧栏插件入口</sub></p>

### 专家子代理模型配置与管理

**统一供应商**：通过下拉框选择一个供应商后，下方列表所有专家的模型供应商均替换为该供应商。

**自动降级上限**：专家的主模型失效后会自动降级到候选模型(若未设置候选模型则不会降级)，达到降级上限后也不会继续降级，默认上限为2。例如：我给Fixer设置主模型为deepseek-v4.1-flash，候选1为glm-5.3-flash，候选2为minimax-m3.1-flash，候选3为gpt-6-luna，若降级上限为0，则deepseek-v4.1-flash失效即报错停止，若上限设置为2则会尝试到minimax-m3.1-flash才停止。

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168093919.png" alt="1793168093919"></p>
<p align="center"><sub>专家模型设置</sub></p>

- **峰谷模式**：点击进入峰谷模式设置页
  - **启用峰谷模式**：勾选后启用峰谷模式。
  - **峰时设置**：默认添加2段峰值时间，可以修改和删除，峰值时间外为谷值时间
  - **峰谷模型设置**：点击"峰时"按钮可以设置峰值模型及候选模型，点击"谷时"按钮设置谷时模型及候选模型

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168688030.png" alt="1793168688030"></p>
<p align="center"><sub>峰谷模式设置</sub></p>

**注意**：如下图所示，峰谷模式启用后DEG插件设置页的模型设置会同步为当前时间的模型配置，此时进行修改的是当前时间的峰谷模式模型

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168997228.png" alt="1793168997228"></p>
<p align="center"><sub>启用峰谷模式后的DEG插件设置页</sub></p>

- **observer优先**：默认不勾选，勾选后如果在主代理发送图片，会将图片转发给observer子代理，由observer子代理进行图片解析。适用于主代理模型无图片输入能力的情况。observer子代理的模型需要具备图片输入能力。
- **单个角色并发上限**：设置单个子代理同时并发数量
- **角色默认超时**：设置单个子代理会话最长运行时间

## 许可证与致谢

本项目以 [MIT License](https://github.com/NTOIOTN/dsh-expert-group/blob/master/LICENSE) 发布。对设计思路来源及第三方材料的说明见 [`THIRD_PARTY_NOTICES.md`](https://github.com/NTOIOTN/dsh-expert-group/blob/master/THIRD_PARTY_NOTICES.md)。

欢迎通过 GitHub Issues 讨论问题与改进；提交代码时请附上与改动对应的测试结果。
