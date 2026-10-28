# dsh-expert-group

[中文](README.md) | **English**

This project is a subagent plugin for DeepSeek Harness (dsh), in the spirit of omo-slim. The parent agent decomposes tasks, delegates to experts, merges the results, and verifies them; the plugin provides role-based experts with configurable models (every expert can have fallback models and peak/off-peak models), a task sidebar, model configuration, task notifications, and session deletion.

> This English edition is a translation of [README.md](README.md); if the two versions ever disagree, the Chinese version is authoritative.

## Installation

The plugin is published on the public npm registry and can be installed directly:

```shell
npm i dsh-expert-group
```

You can also install it by package name from DSH's "Add plugin" page: enter `dsh-expert-group` (or an index) in the input box, switch the installation source on the right as needed, and click "Install".

<p align="center"><a href="https://github.com/NTOIOTN/dsh-expert-group/blob/master/docs/assets/dsh-plugin-add-dialog.png"><img src="https://github.com/NTOIOTN/dsh-expert-group/raw/master/docs/assets/dsh-plugin-add-dialog.png" alt="DSH Add plugin dialog: dsh-expert-group entered as the package name, with the installation source switch on the right"></a></p>

## Expert roles

| Role        | Purpose                                                        | Default permission boundary                    |
| ----------- | -------------------------------------------------------------- | ---------------------------------------------- |
| `explorer`  | Locate code, map symbols and existing patterns                 | Read-only                                      |
| `librarian` | Research external documentation and library APIs               | Read-only                                      |
| `oracle`    | Architecture trade-offs, hard problems, and code review        | Read-only                                      |
| `designer`  | Implement user-visible UI/UX work                              | Writable, constrained by task paths            |
| `fixer`     | Implement well-scoped multi-file changes and add tests         | Writable, constrained by task paths            |
| `observer`  | Analyze images, screenshots, charts, and PDFs                  | Read-only; vision support depends on the host  |

## Plugin settings

The settings page covers three areas: model configuration, plugin feature toggles, and expert subagent model configuration and management.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167391173.png" alt="1793167391173"></p>
<p align="center"><sub>DEG plugin settings overview</sub></p>

### Model configuration

Same capabilities as DSH's built-in model settings page. This was originally built to configure image input and reasoning effort for custom providers; DSH's model settings now offer the same features, so configuring here has the same effect, and the data is shared and synced in both directions.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167502011.png" alt="1793167502011"></p>
<p align="center"><sub>Model configuration</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793169619722.png" alt="1793169619722"></p>
<p align="center"><sub>DEG plugin reasoning-effort and input-type settings</sub></p>

### Plugin feature toggles

- **Task management**: enables the right-sidebar task management panel; on by default.
- **Auto**: enables automatic expansion and reclaim of subagent sessions in the right sidebar; off by default.
- **Sidebar entry**: adds a plugin settings entry to DSH's left sidebar; on by default.
- **Notification pop-ups**: calls system notifications when notification events fire; on by default.
- **Notification volume**: sets the notification volume; 100 by default.
- **Notification events**: selects which events trigger notifications; all selected by default.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167576121.png" alt="1793167576121"></p>
<p align="center"><sub>Plugin feature management</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167687070.png" alt="1793167687070"></p>
<p align="center"><sub>Right-sidebar task management panel</sub></p>

**Sidebar session model**: changes only the current session's model configuration.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793170346274.png" alt="1793170346274"></p>
<p align="center"><sub>Sidebar session model page</sub></p>

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793167858911.png" alt="1793167858911"></p>
<p align="center"><sub>Left-sidebar plugin entry</sub></p>

### Expert subagent model configuration and management

**Unified provider**: after selecting a provider from the dropdown, every expert in the list below is switched to that provider.

**Automatic fallback limit**: when an expert's primary model fails, it automatically falls back to the candidate models (no fallback happens if no candidates are configured), and it stops once the fallback limit is reached; the default limit is 2. For example, set Fixer's primary model to deepseek-v4.1-flash, candidate 1 to glm-5.3-flash, candidate 2 to minimax-m3.1-flash, and candidate 3 to gpt-6-luna. With a limit of 0, the request fails as soon as deepseek-v4.1-flash fails; with a limit of 2, it tries up to minimax-m3.1-flash and then stops.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168093919.png" alt="1793168093919"></p>
<p align="center"><sub>Expert model settings</sub></p>

- **Peak/off-peak mode**: opens the peak/off-peak settings page.
  - **Enable peak/off-peak mode**: turns the mode on.
  - **Peak periods**: two peak periods are added by default; they can be edited or deleted. Time outside the peak periods is off-peak.
  - **Peak/off-peak models**: click "Peak" to configure the peak models and candidates, and "Off-peak" to configure the off-peak models and candidates.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168688030.png" alt="1793168688030"></p>
<p align="center"><sub>Peak/off-peak mode settings</sub></p>

**Note**: as shown below, once peak/off-peak mode is enabled, the model settings on the DEG plugin settings page follow the current period's configuration; editing them edits the current period's peak/off-peak models.

<p align="center"><img src="https://raw.githubusercontent.com/NTOIOTN/dsh-expert-group/master/docs/assets/readme/1793168997228.png" alt="1793168997228"></p>
<p align="center"><sub>DEG plugin settings with peak/off-peak mode enabled</sub></p>

- **Observer priority**: off by default. When enabled, images sent by the parent agent are forwarded to the observer subagent for image analysis, which is useful when the parent agent's model cannot accept image input. The observer subagent's model must support image input.
- **Per-role concurrency limit**: maximum number of concurrent runs for a single role.
- **Default role timeout**: maximum runtime of a single subagent session.

## License and acknowledgements

Released under the [MIT License](https://github.com/NTOIOTN/dsh-expert-group/blob/master/LICENSE). See [`THIRD_PARTY_NOTICES.md`](https://github.com/NTOIOTN/dsh-expert-group/blob/master/THIRD_PARTY_NOTICES.md) for the design inspirations and third-party materials.

Feel free to discuss problems and improvements via GitHub Issues; when submitting code, please include the test results for your change.
