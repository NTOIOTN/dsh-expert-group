# dsh-expert-group

**English** | [中文](README.md)

This English edition is a translation of [README.md](README.md); if the two versions ever disagree, the Chinese version is authoritative.

> The `dsh-expert-group` settings namespace stores the global providers, `defaults`, and notification preferences; session overrides and subagent snapshots belong to the plugin's own `dsh_expert_group` storage domain.

An external **dual-face Cordis bundle** that can be installed into DSH (DeepSeek Harness). Its expert division of labour, per-role model and reasoning-depth routing, and background parallel delegation discipline are borrowed from the open-source **oh-my-opencode-slim** project
(https://github.com/alvinunreal/oh-my-opencode-slim , MIT).
It brings "per-role model and reasoning depth" expert subagents into DSH, and maintains the global models, reasoning depths, and notification preferences on the "dsh-expert-group" settings page in the Web UI.
It also ports oh-my-opencode-slim's parent-agent orchestrator design: the root session breaks down, delegates, integrates, and verifies, while expert subagents keep their leaf-worker constraints.

## Capabilities

- 5 expert subagent tools (enabled by default):
  - `explorer` — read-only codebase reconnaissance (file location, symbol/pattern mapping)
  - `librarian` — read-only research into external documentation / library APIs
  - `oracle` — read-only architecture decisions / hard debugging / code review
  - `designer` — UI/UX and visual implementation (can write)
  - `fixer` — implementation of already-decided plans, repetitive edits, migrations, and filling in tests, including large amounts of work in a single file (can write)
- **Visual agent** `observer`: a read-only visual-analysis expert that interprets the real durable image attachments provided by the Host, including screenshots, UI mockups, charts, and PDF pages already rendered as images; it does not accept arbitrary local paths. Off by default in a bare Config; the current `cordis.patch.yml` explicitly turns the bundle override on. Image routing hands the Host-created `image/png` durable attachment ContentBlock directly to the Observer; the automatic image entry point only dispatches bounded, purely visual tasks, and the user's original task is still held by the parent agent, which synthesizes the visual report.
- Plugin tools use short, conflict-free role tool names (`explorer`, `librarian`, and so on) registered on the current DSH's `ctx.tools`;
  the parent agent must not treat the Harness-level `subagent_<role>`, PTC's `run_code`, or the generic subagent entry point as a substitute for plugin delegation.
- Every expert delegation is always a continuable subagent: by default it runs in the background and immediately returns the subagent id;
  `run_in_background: false` is accepted for compatibility only — like omitting it or passing `true`, it uses non-blocking admission and does not wait for the final result (errors / empty returns are still handled as "automatic recovery").
- **No built-in default models**: after a fresh install every role is empty, so you must choose and save models from those already configured in DSH on the "dsh-expert-group" settings page; a role without a model reports a clear message when it is invoked.
- Models and reasoning depths are validated through `llm.listProviders/listModels` + `resolveCallConfig`, and only models that have been added in settings are accepted.
- **Dynamic settings write capability**: the plugin does not import `@deepseek-ai/dsh-settings` at module-load time (the package declares a `>=0.2.1-rc.1` peer, so the host should provide a compatible version and the plugin does not additionally load that package). The target runtimes are `0.2.1-rc.1` / `0.2.1-rc.2` (that is, the RC2 contract host line above `>0.2.1-rc.1`); the plugin reads and writes profile entries through the describe/update/mutate surface of the host settings service, and DEG's own settings-commit endpoint performs semantic validation and revision conflict detection (the host no longer provides an owner validate hook).
- The subagent's `reasoningEffort` is injected through the subagent `agent/request` waterfall, bypassing the limitation that `dsh-tool-subagent`'s
  `AgentOptions` does not expose that field yet.

## Installation

The plugin is published to the public npm registry and can be installed directly with npm:

```bash
npm i dsh-expert-group
```

You can also install it by package name on DSH's "Add plugin" page: enter `dsh-expert-group` in the input box, switch the install source on the right if needed, then click "Install".

![Screenshot of the DSH "Add plugin" dialog: the input box contains dsh-expert-group and the install source can be switched on the right](docs/assets/dsh-plugin-add-dialog.png)

> This screenshot lives under the repository's `docs/assets/`. The npm package is published per the `files` allowlist in `package.json` and **does not include `docs/`**, so the image does not show up in a copy installed from npm; reading it in the repository works normally.

Prerequisites: DSH version ≥ `0.2.1-rc.1`, a working DSH Web (`dsh web`), Node.js ≥ 22, and `pnpm` on PATH. Restart `dsh web` after installation for the plugin to take effect.

The plugin ships no built-in default models per role: first configure models under DSH "Settings → Models", then choose models for each role and save them under "Settings → dsh-expert-group".

## Interface Overview

DEG has exactly three visible surfaces in the DSH Web UI, independent of one another and non-overlapping:

| Surface | Location | What it does | Details |
| --- | --- | --- | --- |
| **dsh-expert-group settings page** | Settings → `dsh-expert-group` | Maintains global providers, the default models and reasoning depths of the six expert roles, plus notification preferences, `Observer优先`(Observer priority), `任务管理`(Task management), `Auto`, the per-role concurrency limit, and the per-role default timeout | [Settings page in detail](#settings-page-dsh-expert-group) |
| **Expert Group task sidebar** | Right sidebar (the native right pane, or a standalone page when better-sidebar is installed) | Shows the task tree and run state of the current root session; use `>>` / `<<` to open or close a subagent session in the right sidebar; cancel / retry fan-out tasks; use the toolbar "会话模型" (session model) button to override expert models temporarily for the current session | [Expert Group task sidebar](#expert-group-task-sidebar) |
| **Run status line and system notifications** | Bottom-left of the main view / bottom-right of the Windows desktop | While running it shows run words such as `Orchestrator running` and `Explorer running`; when a task reaches a terminal state a Windows Toast notifies you | Web status hints |

DEG has no model-callable notification tool. Global expert configuration is still maintained only on the settings page; the right sidebar offers no global model-configuration entry point and only carries a **per-session temporary override** ("会话模型", session model) in its toolbar, while in-session main-model overrides are still managed by the DSH Host itself.

> The UI screenshots below were taken from the DSH desktop app and live under the repository's `docs/assets/`. The npm package is published per the `files` allowlist in `package.json` and **does not include `docs/`**, so these image links do not resolve in a copy installed from npm; reading them in the repository works normally.

## Settings Page (dsh-expert-group)

The settings page is a standalone section that DEG registers through `settings.section` (label `dsh-expert-group`), and it calls `ctx.settings.configure({ auto: false })` to turn off the configuration page the host would otherwise generate — **every control that appears on the page is rendered by DEG itself**.

The page as a whole uses **deferred saving**: every dropdown, checkbox, and number field only edits a draft, and nothing is persisted until you click "Save" in the footer; the only exception is the provider cards inside the "Model configuration" section, each of which holds its own draft with its own "Apply / Cancel". When the settings namespace is not writable the whole page stays read-only.

The features below are described in top-to-bottom render order; implementation details and boundaries (data flow, revision fence, the seven-effort write rules, and so on) are covered in the "[Model Configuration](#model-configuration)" section later on.

> To make public release possible, every UI screenshot in this document is redacted: provider route names, model names, Base URLs, and credential reference names appear as grey bars.

### 1. Page Header and Description

![Settings page title and description](docs/assets/settings/01-page-header.png)

- The title is `dsh-expert-group`, and the subtitle reads verbatim `专家模型使用 DSH 当前已配置的 provider 和模型目录。`("Expert models use the providers and model catalog already configured in DSH.")
- That sentence is the most important constraint on this page: **candidate providers and models come only from what has already been added under DSH "Settings → Models"**. DEG ships no built-in model catalog and will not accept models outside it.

### 2. The "Model Configuration" Section (Collapsed on the Settings Page, Expanded in the Full-Page View)

![Model configuration section](docs/assets/settings/02-model-config-header.png)

- The only collapsible area on the page: it is **expanded by default** in the full-page settings view opened from the left sidebar entry, while on the DSH settings page ("Settings → dsh-expert-group") it is still **collapsed by default**. While collapsed it does not read the provider catalog, and only expanding it issues the request.
- The collapsed state is not persisted: after a refresh it returns to the default of the entry it was opened from (expanded in the full-page view, collapsed on the DSH settings page).
- The section's description text reads verbatim `与 DSH 内置模型设置页同一份数据流：provider 目录、凭据状态与模型目录都来自宿主公开接口，保存走正式 settings API 与 schema 校验。`("Same data flow as the DSH built-in model settings page: the provider catalog, credential status, and model catalog all come from public host interfaces, and saving goes through the official settings API and schema validation.")
- The section **has no save button of its own**: each provider card has its own "Apply / Cancel", independent of saving the role table above.
- When the host provides no model-configuration capability (no settings namespace view or remote service), the whole section is not rendered, and the rest of the page's controls keep working normally.

### 3. Provider Cards (Collapsed)

![Provider card list](docs/assets/settings/03-provider-cards.png)

- Each card is one row: on the left is the provider display name (the route id is shown as well when it differs from the display name), followed by a green dot meaning the API Key is configured (both `title` and `aria-label` are `API Key 已配置`(API Key configured)); on the right are `删除`(Delete) and `编辑`(Edit).
- `编辑` expands the card; `删除` deletes that provider and its configuration. This is the **only operation on the whole page with a confirmation step**; the confirmation text is `确定删除 provider「<显示名>」及其配置吗？`(Delete provider "<display name>" and its configuration?), and cancelling writes nothing.
- Before deleting there is a role-linkage guard: if the deletion would make a default reasoning effort that some role is currently using disappear, the deletion is blocked and the affected roles are listed (see section 6).

### 4. Expanded Provider: API Key, Base URL, Protocol

![Expanded provider](docs/assets/settings/04-provider-fields.png)

- **API Key**: `type=password`, write-only with no read-back, and no plaintext echo after saving. The input box has three placeholder states: `已配置（留空表示不修改）`(configured — leave blank to keep), `粘贴 API Key 后点应用`(paste an API Key, then click Apply), and `当前凭据只读`(the current credential is read-only).
- **Credential reference**: shown as `凭据引用：<REF>（API Key 只写入 credentials 服务，保存后不回显明文）`(Credential reference: <REF> — the API Key is only written to the credentials service and is not echoed in plaintext after saving); when there is no reference it shows `未设置凭据引用`(no credential reference set). REF is derived from the provider route id — uppercased, non-alphanumeric characters replaced with `_`, and `_API_KEY` appended, so the route `my-gateway` yields `MY_GATEWAY_API_KEY`; when the profile explicitly sets `apiKeyEnv`, that value wins.
- **Base URL**: placeholder `留空表示使用适配器默认端点`(leave blank to use the adapter's default endpoint); leaving it blank deletes the field and falls back to the adapter's default endpoint. Inside the card only empty / non-empty is checked, with no format validation (strict format validation happens in the "Add custom provider" card).
- **Protocol**: the first dropdown entry is always `适配器默认`(adapter default), and selecting it deletes the `api` field; the remaining options are read dynamically from the union type of `providers.<route>.api` in the **host namespace schema** — which protocols exist is decided by the current DSH version, and the plugin does not hardcode a vocabulary.

### 5. Model Catalog: Adapter Default / User Override / Restore Default / Fetch Models

![Model catalog header](docs/assets/settings/05-model-catalog.png)

- The label to the right of the `模型`(Models) heading has two states: `适配器默认（首次编辑时写入用户覆盖）`(adapter default — the first edit writes a user override) and `已按用户覆盖`(overridden by the user). Without a user override the adapter default catalog is shown read-only; only the first real edit writes a user override.
- `恢复默认`(Restore default): submits `unset` for the user-layer `models`, that is, **deletes the user override** rather than writing an empty array.
- `获取模型`(Fetch models): uses the draft (not yet saved) Base URL, protocol, and API Key to pull candidate models from the endpoint; on an empty result it reports `该端点没有返回任何模型`(the endpoint returned no models). The candidate list supports select all / deselect all, and when you click `采纳所选`(take the selection), **existing rows are not overwritten**.
- When the model catalog is empty it reports `没有模型：留空表示沿用适配器内置目录`(no models — leaving this empty keeps the adapter's built-in catalog).

### 6. Model Entries

![Model entries](docs/assets/settings/06-model-entry.png)

Each model contains two rows of fields:

- **Model ID** and **Display name**: two text boxes whose placeholders are `模型 ID`(Model ID) and `显示名`(Display name). The ID is required and must be unique (validation messages `模型 ID 不能为空`(Model ID cannot be empty) / `模型 ID 重复（<id>）`(duplicate Model ID <id>)); a completely blank row is not written into the user override.
- **Context window** and **Max output tokens**: placeholder `继承适配器默认`(inherit the adapter default), accepting forms such as `500K` / `128K` (K = 1000, M = 1000000); leaving them blank inherits. Non-positive integers are rejected (`上下文窗口必须是正整数`(context window must be a positive integer) / `最大输出 token 必须是正整数`(max output tokens must be a positive integer)).
- **Reasoning efforts (multi-select)**: the fixed seven effort levels `off / minimal / low / medium / high / xhigh / max`, in the same order as DSH's pi-ai effort vocabulary, and **always shown regardless of whether the current catalog declares support**. On write, `off` is stored as an empty string and the other levels as the same lowercase string; when none of the seven is checked and there are no unknown keys, the `reasoningEfforts` field is deleted. Existing models restore their checks from `reasoningEfforts`; newly added models start with all seven unchecked.
- **Input types**: the `text` and `image` checkboxes, of which **at least one must remain** — once only one is checked it is locked and can no longer be unchecked.

This row also carries two cross-section constraints:

- The seven effort levels on the card are **model capabilities** (which effort levels this model offers), whereas `defaults.<role>.reasoningEffort` is a **single choice per role**. If one save would delete or uncheck a level that a role currently uses as its default, the save is blocked and the affected roles are listed, with the message reading verbatim `无法保存：将删除的思考档位 <档位> 正被以下专家角色使用：<角色（档位）>。请先在这些角色的配置中改用其它档位，本页不会自动改写角色配置。`("Cannot save: the reasoning effort <effort> being deleted is currently used by the following expert roles: <role (effort)>. Please switch those roles to another effort level in their configuration first; this page will not rewrite role configuration automatically.")
- The plugin **writes only the fields visible on the card** (`displayName`, `apiKeyEnv`, `baseURL`, `api`, `models`); hidden advanced fields such as `transport`, `retryPolicy`, and `compat` are neither displayed nor rebuilt nor deleted.

### 7. Model Actions: Add Model / Remove Model / Cancel / Apply

![Model action buttons](docs/assets/settings/07-model-actions.png)

- `添加模型`(Add model): appends an empty model row (all seven levels unchecked, no input types).
- **Remove model**: the `✕` button on the right of each row, whose accessible name is `删除模型 N`(Remove model N); **there is no confirmation step**.
- `取消`(Cancel): discards this card's draft and returns to the saved state.
- `应用`(Apply) (showing `应用中…`(Applying…) while in progress): local schema validation first → write the settings namespace → write the API Key only after that succeeds → re-read the provider catalog and credential status (the available efforts in the role table above refresh accordingly). A validation failure reports `设置校验未通过，已拒绝写入：<原因>`(settings validation did not pass, the write was rejected: <reason>).
- **Revision conflict**: if the configuration is changed by another session or page after the card was opened, the submission is rejected and the card shows `配置冲突：本卡片的修改未提交。`(Configuration conflict: this card's changes were not submitted.) together with `重新打开（加载最新配置）`(Reopen and load the latest configuration); both the local re-check and the host rejection paths carry explicit text, so other people's changes are never silently overwritten.

### 8. Provider Actions: Add Provider / Add Custom Provider / Reload Provider Catalog

![Provider actions](docs/assets/settings/08-provider-actions.png)

- `添加提供方`(Add provider): picks one route from the adapters the host already has and adds it to the profile; the button is disabled when there is nothing to add.
- `添加自定义提供方`(Add custom provider): opens the custom card, with fields in the order route ID → display name → Base URL → protocol → API Key → models.
  - The route ID has its own validation: it must look like `/^[a-z][a-z0-9-]{0,62}[a-z0-9]$/`, and it rejects a name that duplicates an existing provider or collides with the same credential reference.
  - The Base URL must be http / https with a valid hostname; verbatim errors include `Base URL 只支持 http:// 或 https://`(the Base URL only supports http:// or https://) and `Base URL 必须包含主机名`(the Base URL must contain a hostname).
  - Submission has two phases: write the settings profile first, then write the API Key separately; if the latter fails it shows `provider 配置已保存，但 API Key 写入失败：<原因>`(the provider configuration has been saved, but writing the API Key failed: <reason>), and only the credential write can be retried.
- `重新读取 provider 目录`(Reload provider catalog) (showing `读取中…`(Loading…) while in progress): re-fetches the provider catalog, credential status, and model catalog; this is the manual recovery entry point after a catalog anomaly or an external change.
- When there is no configurable provider at all it shows the empty state `当前宿主没有可配置的 provider。`(this host has no configurable providers).

### 9. Notifications

![Notification settings](docs/assets/settings/09-notifications.png)

| Control | Default | Values | Stored field |
| --- | --- | --- | --- |
| `通知弹窗`(Notification popup) (checkbox) | On | On / Off | `dsh-expert-group.notificationEnabled` |
| `通知事件`(Notification events) (checkbox group) | All on | Task completed / Waiting for you / Task failed | `dsh-expert-group.notificationEvents.{completed,waiting,failed}` |
| `通知音量`(Notification volume) (slider + number box) | `100` | `0 – 100`, step `1` | `dsh-expert-group.notificationVolume` |

- Once `通知弹窗` is turned off, the Host **sends no notifications at all** and does not backfill them either; it only affects delivery and does not affect task snapshots, root-turn waiting, or recovery semantics.
- `通知事件`(Notification events) are filtered by the Host **before delivery**: `completed` covers a normally finished task; `waiting` covers waiting for the user (`ask_user_question` / `exit_plan_mode`); `failed` covers every non-completed termination (`blocked` / `error` / `max-tokens` / `aborted` / `interrupted` / unknown kinds). Turning one category off changes neither task snapshots, waiting, nor recovery semantics, and never backfills historical conclusions.
- A volume of `100` means no attenuation at all, with only the Windows master volume applying; the slider and the number box are two-way bound to the same value.
- Notification fields use deferred saving: after changing them you must click "Save" in the footer; invalid values fall back to the defaults (volume → `100`). The legacy `notificationHoldMs` field in old configuration is ignored at the read boundary (no migration, no error).

### 10. Unified Provider

![Unified provider](docs/assets/settings/10-unified-provider.png)

- The displayed value is "the provider shared by the currently visible roles"; when it is mixed or nothing is selected it shows `无`(None), and the first entry `无` means "not unified".
- Choosing a concrete provider: switches every visible role's provider to it in one step, and migrates models with the same name by **model display name**; models that cannot be matched are cleared, leaving that role with "a provider selected but no model selected".
- The parent agent (the first `Orchestrator` row) follows as well: when it is already configured (`settings.orchestrator.defaults` has both a provider and a model) it migrates with the same display-name rule, keeping the new provider with an empty model when the target provider has no model with the same name; when it is not configured it stays "do not touch the parent agent's model" and is **never** created implicitly. On a candidate page only that layer's Orchestrator candidate is synced, never the primary selection.
- Choosing `无`: only clears the top-level unified selection; it **does not** delete the provider any role already has.
- It only rewrites the draft: the role table below refreshes in step before you click Save, and is given up if you do not; after that, manually changing the provider on any row makes the "unified" state fall back to mixed (showing `无` again).

### 11. Role Table

![Role table](docs/assets/settings/11-role-table.png)

Six rows in a fixed order: **Explorer, Librarian, Oracle, Designer, Fixer, Observer**. The four columns mean:

| Column | Where the available values come from | Placeholder when nothing is selected |
| --- | --- | --- |
| Expert | A role label button; clicking it opens that role's detail page, which maintains only that role's prompt | — |
| Provider | Providers from the DSH model catalog | `未选择供应商`(No provider selected) |
| Model | Models filtered by the selected provider | `先选择供应商`(Select a provider first) / `未选择模型`(No model selected) |
| Reasoning depth | `模型默认`(Model default) plus the efforts declared by the selected model, based on that model's reasoning capability | `先选择模型`(Select a model first) / `模型无思考深度`(Model has no reasoning depth) |

- When the current provider / model is no longer in the catalog, it stays visible as a disabled entry `<provider>（不可用）` / `<model>（不可用）`(unavailable), which makes stale configuration easy to spot.
- Selecting a model automatically applies the `defaultEffort` declared by the catalog; selecting `模型默认` (an empty value) for reasoning depth deletes that role's `reasoningEffort` field.
- The Observer row follows the host's meta projection: when the visual agent is not enabled the row is still in the table, but its three dropdowns are disabled.
- Stored field paths: `dsh-expert-group.defaults.<role>.provider / .model / .reasoningEffort`.
- Writes from the role table go through DEG's own commit endpoint (semantic validation + revision conflict detection) and do not reuse the configuration form's set / unset / mutate.

### 12. Bottom Management Options

![Bottom management options](docs/assets/settings/12-role-options.png)

| Control | Default | Stored field | Description |
| --- | --- | --- | --- |
| `Observer优先`(Observer priority) | Off | `observerPreferred` | When enabled, image submission switches to the Observer-first route and requires the Observer model to explicitly support image, otherwise it reports `已开启 Observer优先，但 Observer 模型未明确支持 image；原始输入已保留。`(Observer priority is on, but the Observer model does not explicitly support image; the original input has been preserved.); the parent-agent prompt also switches to the Observer-first paragraph |
| `任务管理`(Task management) | On | `taskManagementEnabled` | Controls whether DEG registers Expert Group in the sidebar: after turning it off and saving, it calls the disposer returned by the current install to release the registration (the native right pane and better-sidebar's default sidebar stay unchanged), and after turning it back on and saving it registers again; a missing field or a failed read is always treated as on |
| `左侧栏入口`(Sidebar entry) | On | `sidebarEntryEnabled` | Controls whether the left sidebar shows the DEG entry: after turning it off and saving, the entry is hidden, and after turning it back on and saving it is shown again; a missing field, a failed read or a non-boolean value is always treated as on (the same lenient semantics as `任务管理`, so older documents and older clients keep the entry visible); invalid values are rejected by the Host (`设置 sidebarEntryEnabled 无效`, i.e. "setting sidebarEntryEnabled is invalid") |
| `Auto` | Off | `autoOpenSubagentSidebar` | When enabled, it automatically opens the subagent's session page in the right pane while the subagent runs, and automatically retracts it once the subagent finishes and resources go idle; it only closes tabs that Auto itself opened during this run, and tabs the user opened manually are never auto-closed. When disabled you can open or close them manually with `>>` / `<<` |
| `单个角色并发上限`(Per-role concurrency limit) | `20` | `roleConcurrencyLimit` | An integer in the range `1–64`, defaulting to `20` (hover the input to see the range hint). When upgrading from an older version, a saved default of `10` is shown and applied as the new default `20` first, and is persisted **on the first save**; you can still change it back to `10` manually afterwards (it will not be rewritten again). **It does not take effect immediately** and only applies after you click Save; invalid values are rejected by the Host (`设置 roleConcurrencyLimit 无效`, i.e. "setting roleConcurrencyLimit is invalid") |
| `角色默认超时 (s)`(Per-role default timeout) | `36000` (10 hours) | `roleTimeoutMs` | The settings page takes seconds; the default is 10 hours, `0` explicitly disables it, and enabled values are integers from `1–86400` seconds (1-second precision), converted to the Host's millisecond field `roleTimeoutMs` (`1000–86400000`, a multiple of `1000`) on save. **It does not take effect immediately**: it only affects attempts created after saving and never rewrites running shards; a shard-level `timeoutMs` and the task-level `timeoutMs` take precedence over it. A timeout settles the latest attempt as `timed_out`, which can be retried by hand but is never retried automatically; invalid values are rejected by the Host (`设置 roleTimeoutMs 无效`, i.e. "setting roleTimeoutMs is invalid") |

- Turning `Auto` from off to on counts as a fresh authorization: it clears the manual-close ownership suppressions of the **current session (current root)**, so still-running subagents that were previously closed by hand can be reopened automatically; suppressions belonging to other sessions are left untouched.
- Manual ownership has two hand-back moments depending on where it came from: marks created by **the DEG row arrow / keyboard** are handed back to `Auto` immediately according to the run phase (reopening while running, or opening while idle and then resuming, both count as normal); marks created from **other entry points** (e.g. a subagent link in the chat) or by closing a running subagent are handed back only at the **next idle→running transition**. **Within the same run manual intent always wins** (Auto never claims or retracts a tab opened by an external writer); handing back at a cross-run idle→running boundary is intentional. `manual-open` (DEG row arrow / keyboard) is unaffected by a full page reload: it is still handed back to `Auto` immediately by the phase rule — there is no guarantee that "every manual mark survives a reload".

### 13. Footer and Saving

- The footer status line has only three values: `有未保存的修改`(Unsaved changes), `已保存`(Saved), and empty.
- Buttons: `保存`(Save) (showing `保存中…`(Saving…) while saving) and `放弃修改`(Discard changes). Save errors are displayed as text above the footer, with no separate dialog.
- Saving requires the settings namespace to be writable and the catalog to be ready; when it is read-only or not ready, saving is unavailable.

### Differences from the DSH Built-in "Models" Settings Page

| Aspect | DSH built-in models page | DEG "Model configuration" section |
| --- | --- | --- |
| Visible fields | Includes hidden advanced YAML fields (`transport`, `retryPolicy`, `compat`, etc.) | Only the fields visible on the card; hidden fields are not displayed, rebuilt, or deleted |
| Save granularity | Whole-page submission | Each provider card has its own "Apply / Cancel", and the section has no save button |
| Write path | The host's generic settings write surface | Also goes through the host's `settings.mutate`; the model-catalog layer does not run DEG semantic validation |
| Role configuration | — | Written through DEG's own settings-commit endpoint, with semantic validation and revision conflict detection |

## Parent Agent Configuration

- `enableOrchestrator` is enabled by default: the root session receives the upstream orchestrator's workflow manager prompt and is responsible for breaking down tasks, choosing experts, integrating results, and verifying; subagents do not inherit that parent-agent section.
- To turn it off: set `enableOrchestrator` to `false` in `cordis.patch.yml` and restart DSH; this only disables the parent-agent prompt and does not affect the plugin's role tools themselves.
- This port does not override the root agent's `provider` / `model`; the main model and the UI model override continue to be managed by the DSH Host.

## Model Configuration

> For the user-facing, control-by-control description with screenshots, see "[Settings page in detail](#settings-page-dsh-expert-group)" above; this section only records implementation details and boundaries.

- **Global expert configuration is maintained only on the "dsh-expert-group" settings page**: providers, each expert's default model / reasoning depth, the notification toggle and volume, `Observer优先`, **Task management**, and **Auto** are all persisted to the plugin settings namespace.
- The plugin no longer offers a right-side **global model configuration** panel, a better-sidebar "Expert models" tab, or a session title-bar entry point; global model selection is still maintained only on the settings page. The sidebar toolbar's "会话模型" entry writes **per-session temporary overrides only** (`session-override-set` / `session-override-clear`); it never modifies global settings and is not a global model-configuration panel. Task state is shown by the Expert Group sidebar described below.
- Each expert's **model candidates and fallback order** are maintained on the settings page with tabs: `Primary`, `Candidate 1` … `Candidate 3`, each tab holding a full six-role table. Tab order is the fallback priority (the first tab is always "Primary" and tabs can be dragged to reorder); `+` creates a candidate tab copied from the primary tab, and candidate tabs can be deleted as a whole layer. Candidates come only from DSH's current model catalog (the models already added under "Settings → Models"), and they are validated twice by the client and the Host before saving; each role allows at most 3 candidates. The global **automatic fallback limit** (`0–4`, default `2`) caps how many fallbacks may happen.
- **Fallback also happens at runtime**: request failures (rate limit, `5xx`, timeout, stream interruption, empty response) consume a per-model budget of 5 retries; once exhausted DEG switches to the next candidate and continues **inside the same subagent session** (context and completed tool calls are preserved). Deterministic errors such as a missing model, authentication failure, context-window overflow, or quota / balance exhaustion (`QUOTA` / `ACCOUNT_QUOTA`) switch immediately — retrying an exhausted route can only reproduce the same failure, and the host adapter does not retry it either. Any other non-retryable error (provider-private code, unknown code) also switches immediately whenever a candidate exists — error codes are defined by each provider / adapter and cannot be enumerated, so DEG never gives up on a fallback just because it does not recognise a code; without a candidate chain the existing retry / terminal semantics are preserved. DEG reports an error only after the whole candidate chain is exhausted; cancellation and user interrupts never trigger a fallback. The sidebar task row and the usage ledger show the active candidate.
- **The "Model configuration" section (collapsed by default on the DSH settings page, expanded by default in the left-sidebar full-page view)**: at the bottom of the settings page there is another collapsible section whose initial state depends on the entry point (see the section above), and it mirrors the visible capabilities of DSH's built-in model settings page — provider catalog, API Key (through the credentials service, write-only with no plaintext read-back), Base URL, protocol, adding / removing providers, fetching models, adding / removing models, model ID / display name, context window, max output tokens, input types, and the model catalog's "adapter default / user override / restore default". Its scope **excludes** the built-in page's hidden advanced YAML fields (`transport`, `retryPolicy`, `compat`, etc.): the card only writes the fields it can see, and those fields are neither displayed nor rebuilt.
- **Saved separately from role configuration**: each provider card holds its own draft with its own "Apply / Cancel", and the section itself has no save button; the save button and behaviour of the role table above are completely unchanged. A submission is fenced by the namespace revision read when the card was opened: if the revision has already moved on outside (another session or page), the overwrite is refused, and the card shows a conflict notice together with a "Reopen" entry point.
- **Seven reasoning efforts (multi-select)**: the advanced settings of every model entry contain seven checkboxes `off / minimal / low / medium / high / xhigh / max`, in the same order as DSH's pi-ai effort vocabulary, and they are always shown regardless of whether the current catalog declares support. Existing models restore their checks from `reasoningEfforts`; new models start with all seven unchecked. On save, `off` writes an empty string value and the other levels write the same lowercase string; only these seven visible keys are added or removed, while unknown keys that are not displayed are preserved; when none of the seven is checked and there are no unknown keys, the `reasoningEfforts` field is deleted.

### Parent Agent (Orchestrator) Model

The parent-agent model only affects the **root session** (the layer that breaks down tasks, chooses experts, integrates results, and verifies); subagents and experts keep using the models in their own role table.

**Three configuration entry points, all reading and writing the same configuration**:

- **The fixed first row of the "Model configuration" section on the settings page** (row name `Orchestrator`): maintains the global parent-agent model and candidate order with exactly the same row structure as expert roles (primary / candidate tabs, reasoning depth, automatic fallback limit).
- **The same table inside the peak/valley configuration**: peak and valley each own a parent-agent configuration, sharing the same rows and candidate tabs as the global one, and saving one never overwrites the other.
- **The fixed first row of the sidebar "会话模型"(Session models) dialog**: writes **per-session overrides only** (`session-override-set`) and never touches global settings; this is also where you can see which parent-agent model the current session is actually using.

**Precedence (highest first)**: session override > current period > global configuration > no intervention. When none of the four layers is configured the plugin **does nothing** and never picks a default model for you; with peak/valley disabled the "current period" layer does not exist, and resolution falls straight through to the global configuration.

**Peak/valley coupling**: while a session is under automatic management, a peak/valley switch re-applies the new period's configuration once; sessions that were manually taken over are never rewritten by a period switch.

**Candidates and preflight switching**: before applying to a new session the plugin runs one model-catalog preflight; if the primary model is unavailable it walks the candidate tabs in order and takes the first usable one, and the dialog marks "degraded to candidate N". When every candidate is unavailable the **configuration is kept and the status quo is preserved** — this feature has no runtime fallback and never swaps models because a request failed; switching only happens in the preflight before applying.

**States of the dialog's first row**:

- **Effective: provider / model (session override / current period / global config)**: the parent-agent model this session is using, plus the layer it came from;
- **Not configured**: none of the four layers is configured, so the plugin leaves this session's parent-agent model untouched;
- **degraded to candidate N**: the primary model failed preflight, so candidate N is what is actually in effect;
- **manually locked in this session**: you changed the model manually in this session, so neither period switches nor automatic application will rewrite it anymore;
- **host not ready**: the current DSH host does not provide the session-model service, so the plugin only displays the configuration and never writes.

**Two explicit limits**:

1. **Existing sessions and restored historical sessions are never applied to**: after saving the configuration or restarting DSH, historical sessions keep their models; only a root session that was newly created in this run and has never issued a request is applied once at creation.
2. **Manual changes only affect the current session**: switching models in "Session models" writes a per-session override only — it does not change global settings and does not affect other sessions; clearing that override returns to the "period > global" resolution result.

## Expert Group Task Sidebar

Expert Group is the task view that DEG registers in the right sidebar: it draws the complete task tree of **the root session the current session belongs to** — the parent agent is the root node, and ordinary experts, fan-out shards, and live run state all hang below it. It is a read-only view, and the only operations that write state are cancelling and retrying fan-out tasks.

![Expert Group sidebar overview](docs/assets/sidebar/01-overview.png)

How it is registered depends on the host: without `dsh-better-sidebar` installed it registers a native DSH right-pane page and auto-opens it for each root session the first time; with it installed it registers only a standalone `expert-group` page with `ctx.betterSidebar`. If the user disables that page in better-sidebar, DEG neither opens it automatically nor falls back to registering the other kind of page.

### The Four Node Types

| Node | First-line title | When it appears |
| --- | --- | --- |
| Parent agent (root node) | The fixed Chinese text `主代理`(Parent agent) | Always present; the root's taskName / session id are not shown |
| Ordinary expert | The short description of the latest dispatch | One node is created per expert delegation |
| fan-out aggregate branch | `<角色> · <N> shards · running｜ready` (`<角色>` is the role name) | One fan-out submission creates a parent node, and its shards are its child nodes |
| Idle subagent group | `空闲子代理（N）`(Idle subagents (N)) | Appears when a ready ordinary expert or a settled fan-out parent task exists; collapsible |

### Two-Line Structure of a Task Row

Except for fan-out shards, every agent node has a fixed two lines, and their content does not depend on the collapsed state:

![Parent agent root node](docs/assets/sidebar/02-root-row.png)

> Note: the sidebar screenshots in this document were taken with the previous three-line layout. The third status-summary line has since been removed at the user's request; the images have not been regenerated in this round.

1. **Task name**: the root node always shows `主代理`; expert nodes show the latest dispatch description; fan-out shard rows show `分片代号  任务名称`(shard code, then task name) (shard rows wrap by content instead of being ellipsized onto a single line). The full text doubles as the tooltip and the accessible label.
2. **Model metadata**: `角色 · provider · model · 思考深度`(role · provider · model · reasoning depth) (provider and model names in this document's screenshots are redacted). Missing values use the stable placeholders `未知供应商`(Unknown provider) / `未知模型`(Unknown model) / `默认`(Default).

- Run state is expressed only by the leading state dot: DSH's native `primitives.StateDot` (`running` / `ready`), which degrades to a static dot when the official component is missing.
- The continuation mode and the authoritative session title no longer occupy a separate line, and they do not appear in the task name or the metadata either.
- The **usage glance** next to the task name always follows the same order: `用时1h5m · 208tok/s · 109M tok · 命中97% · context 32%` (duration, output speed, total tokens, cache-hit rate, and context occupancy). The **duration** comes from the host-projected `turnDurationMs` first — the accumulated wall clock of every turn in that session (each turn from `turn/start` to its `turn/end`, with the last, still-open turn counted up to snapshot time; idle gaps between turns are excluded and the value is not reset when a turn ends; the tooltip label is `累计轮次用时` → "accumulated per-turn time" and also shows model time and tool-call time). Only for an old host, or before that projection has loaded, does it fall back to `sessionStats.llmMs` (model time), and then to the node's start/end timestamp difference. The other four segments come **from DSH's authoritative session projections** — `decodeTokens / decodeMs` → tok/s, the four `tokenUsage` fields → tok and cache-hit rate, and `contextPressure` → context; only when those projections are missing (old host / not loaded yet) does it fall back to the DEG usage ledger and session timestamps. `sessionStats` is an on-demand client projection: DSH's sessions list snapshot carries only the list-projection subset, so the panel calls the public `sessions.refreshProjections(sessionId)` once for every child session in the tree that has not loaded it yet (one request per session, no retry on failure). The first frame may therefore briefly show DEG fallback values; once loading completes the sessions subscription re-renders the row with DSH authoritative values. Segments whose data cannot be proven are handled **per situation**: (1) a row that has **not started running** yet, for which the host has already projected session stats (an all-zero projection counts) or a definite 0-token fact exists, still shows all five segments with the value 0, for example `用时0s · 0tok/s · 0 tok · 命中0% · context 0%`; (2) while a row **is running but DSH's projections have not loaded yet** (say the first seconds of a run), the missing segments are zero-filled the same way (`用时6s · 0tok/s · 0 tok · 命中0% · context 0%`) and are replaced by the real values once `sessionStats` / `tokenUsage` / `contextPressure` arrive — the five segments never collapse to "用时 · tok" during a run and never jump around, and zero-filled segments carry no made-up tooltip; (3) rows from an old DEG snapshot that carry none of these fields still render no summary bar at all (unknown is never written as 0). A duration below one minute is shown in whole seconds, rounded **down** (`52.8s` → `52s`, `1.2s` → `1s`); below one second the existing `<1s` contract is unchanged, and at one minute or more the `1m` / `28m27s` / `1h` / `1h2m` forms are unchanged too. Context is read from a single session only, so a fan-out parent task does not show it. Start time, retry count and last activity no longer appear in the summary bar, and the old `用量 —`(usage unknown) badge is replaced by the `tok` segment; the `多次重试`(many retries) warning and the bounded failure summary remain.

### Interaction

- Clicking the **task name**: the main view switches to that subagent session; when the host provides no workspace navigation capability the whole row stops being clickable, so no dead button is left behind.
- Clicking the **chevron**: only collapses / expands that node (`aria-expanded`; titles `折叠`(Collapse) / `展开`(Expand)) without navigating.
- Clicking **`>>` / `<<`**: affects only the right sidebar; see the next section.
- Clicking **"会话模型"** (session model) in the toolbar: opens a per-session override dialog; inside is the same four-column table as the settings page (Expert / Provider / Model / Reasoning effort), where you can save, clear a row, or re-read. Fields and gates are described in "[Session Models (per-session overrides)](#session-models-per-session-overrides)" below.
- A fan-out branch offers `取消父任务（未完成 N 个分片）`(Cancel parent task (N shards unfinished)) while active shards remain; a shard row offers `取消分片`(Cancel shard) in the active state and `重试分片`(Retry shard) in the retryable state. Destructive operations ask the host for confirmation first (for example `确认取消父任务？未完成 N 个分片。`(Cancel the parent task? N shards are unfinished.)); when the plugin cannot obtain confirmation capability the whole operation is not executed — it never runs silently.

### Session Models (per-session overrides)

The **"会话模型"** (session model) button, placed after the state filter in the toolbar, temporarily overrides expert models for **the current root session**. It is the only model entry point in the right sidebar, and it writes session-level overrides only.

- **Dialog and table**: clicking opens a dialog (native dialog element; ESC, a backdrop click, or the close button all close it). Inside is the same four-column table as the settings page: `Expert | Provider | Model | Reasoning effort`; one row per enabled role, with three selects for provider, model, and reasoning effort. Changing the provider recomputes the available models; changing the model applies the reasoning default declared by that model (if any).
- **Save**: the footer "保存" (Save) submits only the roles that changed, one `session-override-set` at a time in display order; each request carries the revision returned by the previous response (the first uses the revision read when the dialog opened). On success the local baseline is refreshed from the authoritative Host response. The button is disabled when there is nothing to submit, or when an edited row is missing a provider or model (a validation hint is shown).
- **Clear**: a role that currently has a session override shows an "×" inside its role pill; clicking it immediately sends `session-override-clear` and returns the role to the global default.
- **Write surface**: neither path **modifies global settings**, the candidate list, or the fallback order, and ending the session does not clear the override automatically.
- **Conflicts**: when another page has already advanced the revision, later submissions stop, the **unsaved edits are kept**, and the current revision is reported; nothing is auto-retried or silently overwritten.
- **Read-only state**: when the session is not live (`live:false`) the dialog still opens and shows existing overrides, but the selects and save / clear are disabled; when the current view is a subagent session (only the root's overrides are drawn), when the host does not declare `meta.capabilities.sessionOverride`, or when the read failed, a read-only hint is shown and "重新读取" (re-read) is offered after a failure.
- **Capability probe**: when the `meta` read fails and the capability flag is unknown, the dialog does not stay on "reading" forever; it probes once with `session-override-get` — on success it works as usual, and when an old host answers `bad-request` for the unknown action it degrades to "unsupported by this host".

### State, Collapse, and Refresh

- Expanded by default: running, waiting, failed, timed-out, and interrupted tasks; collapsed by default: idle, ready, successful, or cancelled tasks.
- Manual collapse / expand choices are stored per **root session** in `sessionStorage`, and later state changes do not override the user's choice.
- When idle it refreshes by bounded polling (about once every 2.5s); it does not re-render when the whole tree is unchanged, and real changes are never swallowed.
- Only one root session is drawn: the cache is isolated per root, so switching sessions never shows the previous root's content on the new root.
- The panel title is `Expert Group`; if the snapshot fails to load, the title bar shows `快照读取失败`(Snapshot load failed) and a `重试`(Retry) button; the first screen shows a skeleton when there is no cache, and an empty tree shows `暂无 Expert Group 任务`(No Expert Group tasks).

### fan-out Aggregate Branch

![fan-out aggregate branch and shards](docs/assets/sidebar/03-fanout-group.png)

![fan-out shard row](docs/assets/sidebar/04-shard-row.png)

- The parent node's title is `<角色> · <N> shards · running｜ready`, and its dot takes its colour from the canonical run state of the whole fan-out.
- The parent task no longer shows an aggregated attempt timeline; expanding a shard shows that shard's own attempt history (index, status, duration, time, usage/cost, and structured result).
- The first line of a shard row is `分片代号  任务名称`, followed by the same model metadata.
- A shard whose latest attempt succeeded is displayed as successful (even if earlier attempts failed); cancel and retry always act on the **latest attempt's childId**.
- While a cancel / retry request is in flight the button is disabled and marked `aria-busy`, so repeated clicks do not send a second request.

### Idle Subagent Group

![Idle subagent group](docs/assets/sidebar/05-idle-group.png)

Running experts and unsettled fan-outs stay in the main list; idle (ready) ordinary experts and fan-out parent tasks whose shards have all settled are collected into the collapsible group `空闲子代理（N）`, so that long task trees are not drowned by historical nodes. A settled fan-out keeps its shard tree and task operations after moving into the group. The group header is a container rather than an agent, so its dot is always ready; members inside the group each take their colour from their own actual state.

### `>>` and `<<`: Opening and Closing Subagent Sessions in the Right Sidebar

After every task name there is a 30×20px arrow button, and **the same button has two forms**:

| Form | Meaning | Colour | Accessibility |
| --- | --- | --- | --- |
| `>>` | **Opens** this row's subagent session in the right sidebar | Amber (`state-warning-primary`, or `#f59e0b` when the token is missing) | `title` / `aria-label` is `在侧边栏打开 <任务名>`(Open <task name> in the sidebar); with toggle capability, `aria-pressed=false` and `data-open=false` |
| `<<` | **Closes** this row's session, which is already open in the right sidebar | Cyan (`state-business-primary`, or `#22d3ee` when the token is missing) | `aria-label` is `在侧边栏关闭 <任务名>`(Close <task name> in the sidebar); `aria-pressed=true`, `data-open=true` |


**`>>` (Open)**

- None of the render conditions may be missing: the host provides `sidebarRight.openResource`, this row's address resolves to a subagent session address, and the named arrow icon is available. If any one of them fails, **the button is not rendered** — an empty button, or a warning icon posing as an arrow, is misleading.
- Clicking only opens the subagent session page in the right sidebar and **never switches the main view**; `preventDefault + stopPropagation` block both mouse bubbling and keyboard Enter / Space, so clicking the arrow does not also navigate to that subagent session.
- The first open prefers DSH's public `split()` and uses the returned `paneId` to place the resource explicitly; only hosts without `split()` fall back to `preferNewPane: true`. When a subagent pane already exists it passes `paneId` explicitly and turns `preferNewPane` off, so multiple subagents never wrongly share the left pane with Expert Group.
- If the host temporarily cannot open that address (the seat has not been minted yet), the thrown error is swallowed by the plugin: it affects neither the main view nor the other buttons on the same row.

**`<<` (Close)**

- It turns into `<<` only when all three capabilities are present — "`close` is available", "either `active()` or the public `openTabs` inventory can provide evidence that it is open", and "the named left-arrow icon is available" — and when this row's exact `tabId` **has already been recorded from evidence**; if any one of them is missing it falls back to a static `>>`, and it never shows a fake toggle that will not close anything when clicked.
- Clicking closes only the one tab belonging to this row; it does not switch the main view, does not affect other rows, and performs no fuzzy matching.
- When `<<` initiates the close, the plugin immediately runs one more sync after the host close request resolves: the first authoritative absence resets the arrow to `>>`, while the record / Auto ownership are still settled by the verification chain after two samples; idle sessions do not have to wait for the next poll.
- When the user closes that tab in the right sidebar themselves, the plugin prefers the host's public `openTabs` inventory: when the inventory is readable and the address no longer has a committed tab (and this plugin is not closing that tab itself), **one authoritative observation** resets the arrow to `>>` (manual and Auto-opened records alike) without waiting for polling. Hosts without a readable inventory keep the DOM fallback of two consecutive confirmations. Collapsing the right sidebar is not a close (the tab is still in the inventory, so the arrow stays `<<`). Indeterminate states such as panel switching, focus changes, or unreadable DOM are never guessed as "closed" nor as "still open".

**Right sidebar width**

- When splitting for the first time from a single pane holding only Expert Group, the open transaction first temporarily widens the right sidebar to about 50%, and once the target tab is confirmed to have landed in the returned pane it keeps the 50% adjustable mode; if the split fails it restores the original 20% locked width.
- Day-to-day opening / closing of tabs inside an existing subagent pane does not change the width.
- After the first two panes form: Expert Group takes 40% of the right sidebar (about 20% of the viewport) and the subagent pane takes 60% of the right sidebar (about 30% of the viewport); once the last tracked pane closes, the default width of about 20% is restored.

## Session Deletion

DEG adds permanent deletion to the DSH session list: the session, its logs, and DEG's derived data are removed together — not merely hidden from the list.

- **Two entry points, one confirmation**: the hover button at the end of a session row (trash icon, ordered after archive and pin) and the last row of the session "⋯" menu ("Delete session") share one destructive confirmation — focus defaults to Cancel, Esc / backdrop click / Cancel all dismiss it, "This cannot be undone." is always shown, and the confirm button is disabled with "Deleting…" while the request is in flight.
- **Multi-select deletion**: "Select sessions" in the same "⋯" menu enters multi-select mode. A checkbox appears at the start of each row and clicking anywhere in the row toggles it (in-row buttons, workspace headers, and the search box are not intercepted); the action bar shows "N selected" and "K in use" live, and "Select all" only selects currently actionable sessions — the same range regardless of the active filter. Esc closes the confirmation first and exits multi-select second.
- **Only unoccupied sessions are deleted**: a session still in use by DSH (running itself, or with a running sub-session) is not deleted; the row explains why — "In use by DSH; restart DSH to delete." When the previous deletion's cleanup has not converged yet, the row also asks for a restart.
- **Rows disappear immediately**: the session list refreshes as soon as settlement lands — no manual page switch or panel reopen. Skipped sessions stay untouched, and a session reopened during a race is reported as "not deleted (reopened, kept)".
- **Derived data converges on the next start**: only the targeted sessions' DEG-side data (usage ledger, archive / pin registrations, local expansion state and ownership ledger) is cleared; quarantined old logs and leftover entries are handled by the convergence pass on the next DSH start. Corrupt or incomplete records are kept fail-closed with diagnostics, other sessions are never touched, and shared attachments are never deleted.
- **Occupied sessions need a restart first**: "in use" is judged from DSH's runtime state; after a DSH restart the occupancy is released and the same deletion can be retried.

## Runtime Protection, Reclaim, and Waiting

- **Affected-path protection**: after an expert task declares `affectedPaths`, the guard is released only by an authoritative child stop signal (turn/end, disposal, or an admission that provably created no child), verifiable write fencing, or the process-restart boundary. Root teardown, generation replacement, and manual actions never release it early; tasks whose stop is not confirmed stay pending and do not send completion notifications.
- **`dsh_expert_group_release_scope` is now diagnostic-only**: it no longer removes protection. It returns `scope-release-refused` with a summary of the active entries; the normal lifecycle releases them after the child has actually stopped.
- **Explicit reclaim**: a root can call the `fanout-reclaim` RPC (`sessionId` + `parentTaskIds`) to reclaim parent tasks that are settled, have no active attempt, and are not referenced by the wait ledger. Reclaim persists first and only then removes the tasks from memory and the sidebar; if persistence fails, state is unchanged. No tombstone is kept: reusing the same `requestId` afterwards creates a new task, while queries for the old id return `task_not_found`. Capacity rejections include `current`, `reclaimable`, and an actionable `hint`; requestId idempotency is checked before capacity.
- **Manual escape**: `dsh_expert_group_abandon_wait` (root-only, `reason` required) closes the current wait batch only when the authoritative descendant query explicitly says there are no running descendants. It does not cancel children, release affected-path protection, or change fan-out state. Query failure, degradation, or unknown state is rejected with a stable reason code. Root-turn waiting itself never auto-times-out.
- **Observability**: `meta.diagnostics.rootTurnWait` exposes the outstanding count, oldest wait duration, descendant-query capability level, the latest finalization delivery result, and the manual-abandon count. Only a failed finalization delivery produces a one-shot system notification (still subject to the notification switch); long waits and degraded descendant queries are kept as diagnostics only (`capabilityLevel` / `reminderCount`) and no longer raise system notifications.
