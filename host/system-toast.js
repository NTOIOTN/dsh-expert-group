/**
 * Host 关注点模块：Windows 系统 Toast（系统通知是**唯一**通知界面）。
 *
 * 用户验收要求：即使 DSH 在后台、其它应用在前台，通知也必须出现在 Windows 桌面右下角。
 * renderer 的 Notification API 无法保证宿主身份与后台存活，因此投递发生在 Host 进程：
 * 用系统自带的 **Windows PowerShell 5.1** 调 WinRT
 * Windows.UI.Notifications.ToastNotificationManager，并通过与 process.execPath 匹配的
 * DSH 开始菜单快捷方式取得 AUMID。
 *
 * 严格边界（ADR 0005，逐条对应实现）：
 * - 不 import electron、不向 DSH 主进程发送 IPC、不改 DSH 任何文件；只 spawn powershell.exe；
 * - 不写注册表、不创建快捷方式、不安装 helper、不引入第三方依赖；
 * - AUMID 从**当前用户与所有用户的开始菜单**里 TargetPath 与 process.execPath 匹配的
 *   .lnk 读取（System.AppUserModel.ID），不把 AUMID 硬编码成唯一来源；两个根都不可读、
 *   无匹配、命中但无 AUMID、非 Windows 各自返回固定结构化 reason；
 * - 只启动 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 这个绝对路径，
 *   拿不到就结构化 `powershell-unavailable` 并且**不 spawn**（绝不回退 PATH 上的同名程序）；
 * - 脚本固定，标题与正文**只**经 stdin JSON 传递：命令行、日志、异常诊断里都不出现正文；
 * - shell:false + windowsHide:true，参数固定为
 *   -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand（不使用
 *   -ExecutionPolicy Bypass）；
 * - 有固定超时、并发与队列上限、退出码与 spawn error 映射、dispose 清理；
 *   任何失败都不抛出到 Host 主流程，也不回退成应用内卡片；
 * - 提示音：Toast XML 固定带 <audio silent="true"/>（单条 Toast 没有音量 API，且 DEG 借用
 *   DSH AUMID 无法可靠使用 ms-appx 自定义音频），系统默认音一律静音；自定义"咻~"短音由同一个
 *   固定脚本用 System.Windows.Media.MediaPlayer 播放包内 assets/notification-whoosh.wav，
 *   音量 = 插件音量 / 100（只缩放本条播放流，系统主音量仍由 Windows 音频栈自然应用）。
 *   音频路径**只**出现在 stdin JSON 里，绝不进入命令行、日志、诊断或脚本文本；音频任何失败都被
 *   脚本内部吞掉，不影响已经显示的 Toast，也不改变投递结果。
 *
 * 诊断面只暴露固定 token 与非负计数，不含正文、命令行、URL、AUMID 或任何绝对路径。
 *
 * @module dsh-expert-group/host/system-toast
 */
import { spawn as spawnChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir as readdirDirectory } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** 依赖平台：只有 Windows 有 WinRT Toast；其它平台一律结构化 unsupported。 */
export const SYSTEM_TOAST_PLATFORM = "win32";

/**
 * 固定结构化 reason 集合。
 *
 * 为什么是白名单：调用方（Host 主流程与诊断面）按 token 分支，任何自由文本都会把
 * 子进程输出、正文或路径带进日志与诊断。新增失败类别只能在这里加 token。
 */
export const SYSTEM_TOAST_REASONS = Object.freeze({
  ok: "ok",
  /** 非 Windows 平台。 */
  unsupported: "unsupported",
  /** 开始菜单读取失败（APPDATA 缺失、目录不可读、probe 脚本失败）。 */
  shortcutReadFailed: "shortcut-read-failed",
  /** 读到了快捷方式，但没有一条的 TargetPath 命中 process.execPath。 */
  noMatchingShortcut: "no-matching-shortcut",
  /** 命中了 TargetPath，但该快捷方式没有 System.AppUserModel.ID。 */
  shortcutMissingAumid: "shortcut-missing-aumid",
  /** 拿不到 Windows PowerShell 5.1 的绝对路径：不 spawn，也不回退 PATH。 */
  powershellUnavailable: "powershell-unavailable",
  /** spawn 本身失败（errno）。 */
  spawnError: "spawn-error",
  /** 子进程以非零退出码结束（含脚本异常）。 */
  processExit: "process-exit",
  /** 超时：已 kill 子进程，结果不再等待。 */
  timeout: "timeout",
  /** 队列已满：按上限丢弃本次投递（不做无界排队）。 */
  queueFull: "queue-full",
  /** 模块已释放。 */
  disposed: "disposed",
});

/** 默认有界超时：Windows PowerShell 冷启动 + WinRT 调用通常 < 2s，8s 足够且不悬挂。 */
export const DEFAULT_SYSTEM_TOAST_TIMEOUT_MS = 8000;
/** 默认并发与队列上限：Toast 是用户可见的串行提示，不允许多路并发刷屏。 */
export const DEFAULT_SYSTEM_TOAST_MAX_CONCURRENT = 1;
export const DEFAULT_SYSTEM_TOAST_MAX_QUEUE = 8;
/** AUMID 解析失败后的重试冷却：避免每次通知都递归扫描开始菜单。 */
export const DEFAULT_AUMID_RETRY_COOLDOWN_MS = 30000;
/** 开始菜单扫描上限：只用于有界遍历，避免异常目录结构造成无界 IO。 */
export const DEFAULT_SHORTCUT_SCAN_MAX_FILES = 512;
export const DEFAULT_SHORTCUT_SCAN_MAX_DEPTH = 8;
/** 标题/正文长度上限（字符）：Toast 展示面有界，同时限制 XML 体积。 */
export const TOAST_TITLE_MAX_LENGTH = 120;
export const TOAST_BODY_MAX_LENGTH = 400;
/**
 * 默认通知音量（0..100）：100 = 只受 Windows 主音量影响，插件不做任何衰减。
 * 缺失/非法/读取异常都回落到这个值，保证"用户没设过"与"设成 100"行为一致。
 */
export const DEFAULT_NOTIFICATION_VOLUME = 100;
/** 包内自定义提示音：相对本模块文件定位，开发目录与实际安装目录都指向同一文件。 */
export const NOTIFICATION_AUDIO_RELATIVE_PATH = "../assets/notification-whoosh.wav";

/** 开始菜单 Programs 目录相对 %APPDATA% 的固定位置。 */
const START_MENU_PROGRAMS_SEGMENTS = Object.freeze(["Microsoft", "Windows", "Start Menu", "Programs"]);

/**
 * 固定文案：终态通知只按**固定 reason 类别**取状态文案；任务名称单独作为第二行。
 *
 * 为什么状态文案不是动态文案：终止原因来自 DSH turn/end 的 reason.kind，异常与工具输出
 * 一律不得进入通知正文（既避免泄露，也保证状态信息可预期）。任务名称仅使用 DSH 已发布的
 * session/title，并在 XML 构造边界做控制字符清洗、长度限制和实体转义。
 */
const TERMINATION_TOAST_TEXT = Object.freeze({
  completed: Object.freeze({ title: "Expert Group", body: "任务已完成。" }),
  blocked: Object.freeze({ title: "Expert Group", body: "任务被阻塞，需要你处理。" }),
  error: Object.freeze({ title: "Expert Group", body: "任务因错误终止。" }),
  aborted: Object.freeze({ title: "Expert Group", body: "任务已中止。" }),
  interrupted: Object.freeze({ title: "Expert Group", body: "任务被中断。" }),
  "max-tokens": Object.freeze({ title: "Expert Group", body: "任务达到 token 上限。" }),
  unknown: Object.freeze({ title: "Expert Group", body: "任务已终止。" }),
});

/** 固定文案：用户等待（DSH 等待用户回答/确认）只认两种工具名。 */
const USER_WAIT_TOAST_TEXT = Object.freeze({
  ask_user_question: Object.freeze({ title: "Expert Group", body: "需要你操作" }),
  exit_plan_mode: Object.freeze({ title: "Expert Group", body: "需要你操作" }),
});

/**
 * 以独立字段附加任务名称，避免把任务名称和状态信息拼成不可读的一行。
 * 缺少权威 session/title 时保留旧的安全结构，只显示固定标题与状态。
 */
function withTaskName(text, taskName) {
  const label = typeof taskName === "string" ? taskName.trim() : "";
  return label.length > 0 ? { ...text, taskName: label } : text;
}

/** 终态文案：未知 kind 一律落到通用文案，绝不复用 completed。 */
export function terminationToastText(reason, taskName) {
  const key = typeof reason === "string" ? reason.trim() : "";
  return withTaskName(TERMINATION_TOAST_TEXT[key] ?? TERMINATION_TOAST_TEXT.unknown, taskName);
}

/** 用户等待文案：caller 传入未知工具名时返回 null（宁可不提示，也不编造提示）。 */
export function userWaitToastText(tool, taskName) {
  const key = typeof tool === "string" ? tool.trim() : "";
  const text = USER_WAIT_TOAST_TEXT[key];
  return text === undefined ? null : withTaskName(text, taskName);
}

/**
 * XML 文本节点转义。
 *
 * 正文来自 Host 已知状态，但仍然是**外部输入**（模型/工具可影响 reason 之外的字段），
 * 因此所有文本都当成不可信内容处理：五个实体全部转义，杜绝标签/属性注入。
 */
export function escapeXmlText(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * 文本归一：去掉 XML 1.0 非法的 C0 控制字符（保留制表/换行/回车），折叠到有界长度。
 */
export function clampToastText(value, maxLength = TOAST_BODY_MAX_LENGTH) {
  const limit = Number.isSafeInteger(maxLength) && maxLength > 0 ? maxLength : TOAST_BODY_MAX_LENGTH;
  const text = String(value ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim();
  return text.length > limit ? text.slice(0, limit) : text;
}

/**
 * 构造 Toast XML（固定模板 + 转义后的文本）。
 *
 * 只使用 ToastGeneric 模板：它在 Windows 10/11 桌面右下角以标准横幅展示，且不依赖
 * 任何应用内 UI。标题为空时回落到固定标题；任务名称与状态正文分别占一行，空字段不生成
 * 空文本节点。
 *
 * 音频节点固定为 <audio silent="true"/>，且必须是 <visual> 之后的合法顺序（schema 顺序为
 * visual → audio → actions）：
 * - 单条 Toast 没有音量 API，无法让系统默认音按插件音量播放；
 * - DEG 借用 DSH 的 AUMID 投递，不能用 ms-appx: 等相对协议可靠引用包内自定义音频；
 * 因此系统音一律静音，自定义"咻~"由 TOAST_SHOW_SCRIPT 里的 MediaPlayer 播放，
 * 避免两段声音叠加。
 */
export function buildToastXml({ title, taskName, body } = {}) {
  const safeTitle = clampToastText(title, TOAST_TITLE_MAX_LENGTH) || "Expert Group";
  const safeTaskName = clampToastText(taskName, TOAST_TITLE_MAX_LENGTH);
  const safeBody = clampToastText(body, TOAST_BODY_MAX_LENGTH);
  const nodes = ['<text>' + escapeXmlText(safeTitle) + '</text>'];
  if (safeTaskName.length > 0) nodes.push('<text>' + escapeXmlText(safeTaskName) + '</text>');
  if (safeBody.length > 0) nodes.push('<text>' + escapeXmlText(safeBody) + '</text>');
  return '<toast><visual><binding template="ToastGeneric">' + nodes.join("") + '</binding></visual>'
    + '<audio silent="true"/></toast>';
}

/**
 * 默认提示音路径：以本模块文件位置解析包内 assets/notification-whoosh.wav。
 *
 * 用 import.meta.url 而不是 __dirname/cwd：模块被 web-install.ps1 复制到
 * profiles\packages\dsh-expert-group 后依然指向同一份随包发布的资源。
 * 返回值只用于 stdin JSON，绝不进入命令行、日志、诊断或脚本文本。
 */
export function defaultNotificationAudioPath() {
  return fileURLToPath(new URL(NOTIFICATION_AUDIO_RELATIVE_PATH, import.meta.url));
}

/**
 * 音量归一：合法安全整数 0..100 原样返回；缺失、非法（小数/越界/字符串/NaN）一律回落到
 * DEFAULT_NOTIFICATION_VOLUME（100）。归一在 Node 侧完成，脚本只负责除以 100。
 */
export function normalizeToastVolume(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_NOTIFICATION_VOLUME;
}

/**
 * 规范化快捷方式目标路径用于比较：去引号、统一分隔符、去尾部斜杠、统一大小写。
 *
 * 只做文本归一（不做 realpath/短路径展开）：目标是"同一条 DSH 可执行文件在快捷方式里
 * 怎么写就怎么比"，任何磁盘访问都会让探测更脆弱。
 */
export function normalizeShortcutPath(value) {
  if (typeof value !== "string") return "";
  let text = value.trim();
  if (text.length === 0) return "";
  if (text.length > 1 && text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  text = text.replace(/\//g, "\\").replace(/\\+$/, "");
  return text.toLowerCase();
}

/**
 * 纯匹配：从快捷方式元数据里挑出 TargetPath 命中 execPath 且带 AUMID 的那一条。
 *
 * @param {object} input
 * @param {Array<{targetPath?: string, aumid?: string}>} [input.shortcuts] - 快捷方式元数据。
 * @param {string} [input.execPath] - 当前 DSH 可执行文件（process.execPath）。
 * @returns {{aumid: string|null, reason: string}} aumid 为空时 reason 是固定失败 token。
 */
export function matchShortcutAumid({ shortcuts, execPath } = {}) {
  const wanted = normalizeShortcutPath(execPath);
  const entries = Array.isArray(shortcuts) ? shortcuts : [];
  if (wanted.length === 0) return { aumid: null, reason: SYSTEM_TOAST_REASONS.noMatchingShortcut };
  let matchedWithoutAumid = false;
  for (const entry of entries) {
    if (normalizeShortcutPath(entry?.targetPath) !== wanted) continue;
    const aumid = typeof entry?.aumid === "string" ? entry.aumid.trim() : "";
    if (aumid.length === 0) {
      matchedWithoutAumid = true;
      continue;
    }
    return { aumid, reason: SYSTEM_TOAST_REASONS.ok };
  }
  return {
    aumid: null,
    reason: matchedWithoutAumid ? SYSTEM_TOAST_REASONS.shortcutMissingAumid : SYSTEM_TOAST_REASONS.noMatchingShortcut,
  };
}

/** 按规范化路径去重（大小写/分隔符/尾斜杠判等），保持首次出现顺序；纯函数。 */
function uniqueDirectories(values) {
  const seen = new Set();
  const roots = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed.length === 0) continue;
    const key = normalizeShortcutPath(trimmed);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    roots.push(trimmed);
  }
  return roots;
}

/**
 * 需要扫描的开始菜单 Programs 根目录（按顺序、去重）。
 *
 * 为什么是两个根：DSH 可能由当前用户安装（%APPDATA%），也可能由管理员为所有用户安装
 * （%ProgramData%）。只扫其中一个会把"存在带 AUMID 的快捷方式"变成假阴性，而 AUMID
 * 是 Windows 展示 Toast 的身份前提。环境变量缺失的根直接跳过，聚合规则见
 * collectShortcutPaths：只要还有一个根可读，就不算读取失败。
 */
export function startMenuProgramsDirs(env = {}) {
  const roots = [];
  for (const variable of ["APPDATA", "ProgramData"]) {
    const base = typeof env?.[variable] === "string" ? env[variable].trim() : "";
    if (base.length === 0) continue;
    roots.push(join(base, ...START_MENU_PROGRAMS_SEGMENTS));
  }
  return uniqueDirectories(roots);
}

/** 当前用户的开始菜单 Programs 目录（第一个根）；两个环境变量都缺失时返回 null。 */
export function startMenuProgramsDir(env = {}) {
  return startMenuProgramsDirs(env)[0] ?? null;
}

/**
 * 有界递归收集 .lnk 路径（可一次扫描多个开始菜单根）。
 *
 * 聚合语义（每个根独立遍历，全部不抛错）：
 * - 至少一个根目录可列出 => `readable:true`，可读根的条目照常汇总；单个根缺失/不可读
 *   只跳过它，绝不让另一个有效根一起失败；
 * - **所有**根都不可用/不可读 => `readable:false`（调用方给出 shortcut-read-failed）；
 * - 全部根都读到了但没有 .lnk => `readable:true` + 空 paths："没有快捷方式"与"读不到"
 *   是两种必须区分的结构化结论。
 * 路径按规范化路径去重（两个根可能被重定向到同一目录），文件总数与递归深度都有上界。
 *
 * readdir 是可注入 seam（契约：readdir(directory) => Promise<Array<{name, kind}>>，
 * kind 为 "file" | "directory" | "other"）；默认实现只包装 node:fs 的 Dirent，
 * 不触碰注册表。
 *
 * @param {object} [options]
 * @param {string} [options.dir] - 单个根目录（兼容旧调用）。
 * @param {string[]} [options.dirs] - 多个根目录；与 dir 合并后去重。
 * @returns {Promise<{paths: string[], readable: boolean, truncated: boolean}>}
 */
export async function collectShortcutPaths({
  dir,
  dirs,
  readdir,
  maxFiles = DEFAULT_SHORTCUT_SCAN_MAX_FILES,
  maxDepth = DEFAULT_SHORTCUT_SCAN_MAX_DEPTH,
} = {}) {
  const listDirectory = typeof readdir === "function" ? readdir : defaultReadDirectory;
  const fileLimit = Number.isSafeInteger(maxFiles) && maxFiles > 0 ? maxFiles : DEFAULT_SHORTCUT_SCAN_MAX_FILES;
  const depthLimit = Number.isSafeInteger(maxDepth) && maxDepth > 0 ? maxDepth : DEFAULT_SHORTCUT_SCAN_MAX_DEPTH;
  const roots = uniqueDirectories([...(Array.isArray(dirs) ? dirs : []), dir]);
  if (roots.length === 0) return { paths: [], readable: false, truncated: false };
  const paths = [];
  const seenPaths = new Set();
  let truncated = false;
  let readableRoots = 0;
  for (let rootIndex = 0; rootIndex < roots.length; rootIndex += 1) {
    const root = roots[rootIndex];
    const queue = [{ directory: root, depth: 0 }];
    while (queue.length > 0) {
      const current = queue.shift();
      let entries;
      try {
        entries = await listDirectory(current.directory);
      } catch {
        // 根本身不可读：只影响这个根（全部根都不可读时最终 readable:false）；
        // 子目录不可读：跳过该子树，仍然可以命中别的快捷方式。
        continue;
      }
      if (current.depth === 0) readableRoots += 1;
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry === null || typeof entry !== "object") continue;
        const name = typeof entry.name === "string" ? entry.name : "";
        if (name.length === 0) continue;
        const kind = entry.kind === "directory" || entry.kind === "file" ? entry.kind : "other";
        if (kind === "directory") {
          if (current.depth + 1 > depthLimit) { truncated = true; continue; }
          queue.push({ directory: join(current.directory, name), depth: current.depth + 1 });
          continue;
        }
        if (kind !== "file" || name.toLowerCase().endsWith(".lnk") !== true) continue;
        if (paths.length >= fileLimit) { truncated = true; break; }
        const candidate = join(current.directory, name);
        const key = normalizeShortcutPath(candidate);
        if (seenPaths.has(key)) continue;
        seenPaths.add(key);
        paths.push(candidate);
      }
      if (paths.length >= fileLimit) {
        // 到达上限后不再继续遍历（IO 有界）。若还有未访问的目录或未扫描的根，
        // 就明确标记 truncated：不能把"没看完"报成"看完了"。
        if (queue.length > 0 || rootIndex < roots.length - 1) truncated = true;
        break;
      }
    }
    if (paths.length >= fileLimit) break;
  }
  // 所有根都不可读才算读取失败；只要有一个根可列出就按"可读"汇总。
  if (readableRoots === 0) return { paths: [], readable: false, truncated };
  return { paths, readable: true, truncated };
}

/** 默认 readdir 适配：只把 Dirent 归一成 {name, kind}，不读文件内容。 */
async function defaultReadDirectory(directory) {
  const entries = await readdirDirectory(directory, { withFileTypes: true });
  return entries.map((entry) => ({
    name: entry.name,
    kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
  }));
}

/**
 * 固定脚本 1：读取给定 .lnk 的 TargetPath 与 System.AppUserModel.ID。
 *
 * 输入经 stdin JSON（{paths:[...]}）传入：命令行里不出现任何用户目录路径。
 * 输出是单行 JSON 数组（ConvertTo-Json -Compress），Node 侧再按纯函数匹配 AUMID。
 * 只使用系统自带 COM 解析器，不写注册表、不创建快捷方式。
 */
export const SHORTCUT_PROBE_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  // 输出编码固定为 UTF-8：否则含中文的安装路径会按控制台代码页输出，Node 侧读成乱码，
  // 与 process.execPath 的精确匹配会假失败。
  "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
  "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "$shell = New-Object -ComObject Shell.Application",
  "$entries = New-Object System.Collections.ArrayList",
  "foreach ($path in @($payload.paths)) {",
  // 单条快捷方式损坏（解析抛错）只跳过这一条：不能让一条坏 .lnk 让整台机器再也收不到通知。
  "  try {",
  "    $directory = [System.IO.Path]::GetDirectoryName($path)",
  "    $leaf = [System.IO.Path]::GetFileName($path)",
  "    $folder = $shell.Namespace($directory)",
  "    if ($null -eq $folder) { continue }",
  "    $item = $folder.ParseName($leaf)",
  "    if ($null -eq $item) { continue }",
  "    $target = [string]$item.ExtendedProperty('System.Link.TargetParsingPath')",
  "    if ([string]::IsNullOrEmpty($target)) { $target = [string]$item.ExtendedProperty('System.Link.TargetPath') }",
  "    $aumid = [string]$item.ExtendedProperty('System.AppUserModel.ID')",
  "    [void]$entries.Add([pscustomobject]@{ targetPath = $target; aumid = $aumid })",
  "  } catch {",
  "    continue",
  "  }",
  "}",
  "ConvertTo-Json -InputObject @($entries) -Compress -Depth 3",
].join("\n");

/**
 * 固定脚本 2：按 stdin JSON（{aumid, xml, audioPath, volume}）显示 Toast 并尽力播放提示音。
 *
 * XML 由 Node 侧构造并转义（buildToastXml），脚本只负责解析与投递，因此正文永远不会
 * 出现在命令行、PowerShell 脚本文本或异常消息里。
 */
export const TOAST_SHOW_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$payload = [Console]::In.ReadToEnd() | ConvertFrom-Json",
  "[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.UI.Notifications.ToastNotification, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$document = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$document.LoadXml([string]$payload.xml)",
  "$toast = [Windows.UI.Notifications.ToastNotification]::new($document)",
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier([string]$payload.aumid).Show($toast)",
  "# ── 自定义提示音（尽力而为，完全独立于上面的 Toast 投递） ────────────────────",
  "# Toast XML 已用静音 audio 节点关掉系统默认音，这里只播 DEG 自己的短音（约 1.46s）。",
  "# 顺序：先 Show 已经完成，再打开音频；本块任何异常都只被吞掉，绝不改变投递结果。",
  "try {",
  "  $level = 0",
  "  if ($null -ne $payload.volume) { $level = [int]$payload.volume }",
  "  $sound = [string]$payload.audioPath",
  "  # volume=0（或没有音频路径）时完全不加载音频栈：静音就是什么都不放。",
  "  if ($level -gt 0 -and -not [string]::IsNullOrWhiteSpace($sound)) {",
  "    Add-Type -AssemblyName presentationCore",
  "    $player = New-Object System.Windows.Media.MediaPlayer",
  "    $frame = New-Object System.Windows.Threading.DispatcherFrame",
  "    $timer = New-Object System.Windows.Threading.DispatcherTimer",
  "    $audioState = @{ frame = $frame; timer = $timer; opened = $false; failed = $false }",
  "    $timer.Interval = [TimeSpan]::FromSeconds(3)",
  "    $timer.Add_Tick({ $audioState.timer.Stop(); $audioState.frame.Continue = $false })",
  "    $player.add_MediaOpened({ $audioState.opened = $true; $audioState.timer.Stop(); $audioState.frame.Continue = $false })",
  "    $player.add_MediaFailed({ $audioState.failed = $true; $audioState.timer.Stop(); $audioState.frame.Continue = $false })",
  "    try {",
  "      $player.Open((New-Object System.Uri($sound)))",
  "      $timer.Start()",
  "      # WPF 媒体事件依赖 STA Dispatcher；显式泵事件，最多等待 3 秒，不用固定 Sleep 猜是否已打开。",
  "      [System.Windows.Threading.Dispatcher]::PushFrame($frame)",
  "      if ($audioState.opened -and -not $audioState.failed) {",
  "        # 插件音量只缩放本条播放流：MediaPlayer.Volume 是 0..1，系统主音量仍由 Windows 音频栈应用。",
  "        $player.Volume = [Math]::Min(1.0, [Math]::Max(0.0, ($level / 100.0)))",
  "        $playFrame = New-Object System.Windows.Threading.DispatcherFrame",
  "        $playTimer = New-Object System.Windows.Threading.DispatcherTimer",
  "        $playState = @{ frame = $playFrame; timer = $playTimer; ended = $false; failed = $false }",
  "        $playTimer.Interval = [TimeSpan]::FromSeconds(2)",
  "        $playTimer.Add_Tick({ $playState.timer.Stop(); $playState.frame.Continue = $false })",
  "        $player.add_MediaEnded({ $playState.ended = $true; $playState.timer.Stop(); $playState.frame.Continue = $false })",
  "        $player.add_MediaFailed({ $playState.failed = $true; $playState.timer.Stop(); $playState.frame.Continue = $false })",
  "        $player.Play()",
  "        $playTimer.Start()",
  "        # 持续泵 STA Dispatcher 直到 MediaEnded 或 2 秒超时，避免播放期间阻塞 WPF 事件线程。",
  "        [System.Windows.Threading.Dispatcher]::PushFrame($playFrame)",
  "        $playTimer.Stop()",
  "      }",
  "    } finally {",
  "      $timer.Stop()",
  "      if ($null -ne $playTimer) { $playTimer.Stop() }",
  "      $player.Stop()",
  "      $player.Close()",
  "    }",
  "  }",
  "} catch {",
  "  # 音频不可用（缺文件、无音频设备、WPF 不可用）时静默忽略：通知已经显示过了。",
  "}",
].join("\n");

/**
 * 把 stdin 载荷编码成**纯 ASCII** 的 JSON。
 *
 * 为什么必须这样：Windows PowerShell 5.1 的 `[Console]::In` 按**控制台代码页**解码
 * 重定向的 stdin，而不是 UTF-8。中文通知正文或含中文的快捷方式路径若按 UTF-8 写入，
 * 会被按 GBK 之类的代码页误读，`ConvertFrom-Json` 直接报"无法识别的转义序列"——
 * 也就是所有通知都投递失败。把非 ASCII 字符转成 \uXXXX 转义后载荷只剩 ASCII 字节，
 * ASCII 在所有代码页下解码一致，因此与代码页无关。
 */
export function encodeJsonPayload(value) {
  return JSON.stringify(value ?? {}).replace(/[\u007F-\uFFFF]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0"));
}

/** -EncodedCommand 要求 UTF-16LE + Base64：脚本固定，命令行走固定参数列表。 */
export function encodePowerShellCommand(script) {
  return Buffer.from(String(script), "utf16le").toString("base64");
}

/**
 * 固定 PowerShell 参数：WPF MediaPlayer 需要 STA；不使用 -ExecutionPolicy Bypass（编码命令本身不落盘，
 * 但策略绕过会改变安全语义），也不把标题/正文放进参数。
 */
export function powershellArgumentsFor(script) {
  return ["-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden", "-EncodedCommand", encodePowerShellCommand(script)];
}

/**
 * 解析 Windows PowerShell 5.1 的可执行文件路径；拿不到就返回 **null**。
 *
 * 为什么只接受 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` 这个绝对路径：
 * 1. 必须是 Windows PowerShell 5.1（pwsh 7 解析不了部分 WinRT 类型），System32 下的
 *    固定安装位置是唯一能证明这一点的证据；
 * 2. 裸 "powershell.exe" 会走 PATH 解析：任何能在 PATH 前置同名程序的环境（第三方工具、
 *    被篡改的用户环境变量）都能劫持 Host 启动的解释器——而它跑的是会弹用户可见通知的
 *    固定脚本。因此 SystemRoot 缺失、探测抛错或文件不存在时一律返回 null，
 *    由调用方给出固定结构化 reason，绝不回退 PATH。
 *
 * @param {object} [options]
 * @param {object} [options.env] - 环境变量（只读 SystemRoot）。
 * @param {(candidate: string) => boolean} [options.fileExists] - 存在性探测 seam。
 * @returns {string|null} 绝对路径，或 null（不可用）。
 */
export function resolvePowerShellPath({ env = {}, fileExists = existsSync } = {}) {
  const systemRoot = typeof env?.SystemRoot === "string" ? env.SystemRoot.trim() : "";
  if (systemRoot.length === 0) return null;
  const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  try {
    return typeof fileExists === "function" && fileExists(candidate) === true ? candidate : null;
  } catch {
    // 探测本身失败同样按"不可用"处理：宁可结构化失败，也不猜一个可执行文件。
    return null;
  }
}

/** 结构化结果构造：只有固定 token，绝不携带正文/命令行/路径。 */
function toastResult(shown, reason, detail) {
  const payload = { shown: shown === true, reason };
  if (detail !== void 0 && detail !== null) payload.detail = detail;
  return payload;
}

/** 把外部 reason 归一到白名单 token：未知/非字符串一律回落。 */
function normalizeReasonToken(value, fallback) {
  if (typeof value !== "string") return fallback;
  const tokens = Object.values(SYSTEM_TOAST_REASONS);
  return tokens.includes(value) ? value : fallback;
}

/**
 * 创建 Windows 系统 Toast 适配器。
 *
 * @param {object} [options]
 * @param {string} [options.platform] - 依赖平台，默认 process.platform（非 win32 => unsupported）。
 * @param {object} [options.env] - 环境变量（APPDATA/SystemRoot），默认 process.env。
 * @param {string} [options.execPath] - 需要匹配的可执行文件，默认 process.execPath。
 * @param {Function} [options.spawn] - 子进程工厂 seam（契约同 node:child_process.spawn）。
 * @param {Function} [options.readdir] - 目录读取 seam（契约同 collectShortcutPaths）。
 * @param {Function} [options.fileExists] - PowerShell 绝对路径存在性探测 seam（默认 node:fs）。
 * @param {Function} [options.listShortcuts] - 快捷方式读取 seam：
 *   () => Promise<{entries: Array<{targetPath, aumid}>, reason: string|null}>；默认实现
 *   递归扫描开始菜单并调用固定 probe 脚本。
 * @param {string} [options.audioPath] - 自定义提示音文件路径（测试 seam）。默认解析包内
 *   assets/notification-whoosh.wav；传空串表示不放音效。该路径只进 stdin JSON。
 * @param {number} [options.timeoutMs] - 单次子进程超时。
 * @param {number} [options.maxConcurrent] - 并发上限。
 * @param {number} [options.maxQueue] - 队列上限（超限按 queue-full 丢弃）。
 * @param {number} [options.aumidCooldownMs] - AUMID 解析失败后的重试冷却。
 * @param {() => number} [options.now] - 可注入时钟（冷却判定）。
 * @param {{warn?: Function}} [options.logger] - 只接收固定 token 的 warn 出口。
 */
export function createSystemToastModule(options = {}) {
  const platform = typeof options.platform === "string" ? options.platform : process.platform;
  const env = options.env !== undefined && options.env !== null ? options.env : process.env;
  const execPath = typeof options.execPath === "string" ? options.execPath : process.execPath;
  const spawnProcess = typeof options.spawn === "function" ? options.spawn : spawnChildProcess;
  const readdir = typeof options.readdir === "function" ? options.readdir : defaultReadDirectory;
  const fileExists = typeof options.fileExists === "function" ? options.fileExists : existsSync;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_SYSTEM_TOAST_TIMEOUT_MS;
  const maxConcurrent = Number.isSafeInteger(options.maxConcurrent) && options.maxConcurrent > 0
    ? options.maxConcurrent
    : DEFAULT_SYSTEM_TOAST_MAX_CONCURRENT;
  const maxQueue = Number.isSafeInteger(options.maxQueue) && options.maxQueue >= 0
    ? options.maxQueue
    : DEFAULT_SYSTEM_TOAST_MAX_QUEUE;
  const aumidCooldownMs = Number.isSafeInteger(options.aumidCooldownMs) && options.aumidCooldownMs >= 0
    ? options.aumidCooldownMs
    : DEFAULT_AUMID_RETRY_COOLDOWN_MS;
  const now = typeof options.now === "function" ? options.now : () => Date.now();
  const logger = options.logger ?? null;
  const listShortcuts = typeof options.listShortcuts === "function" ? options.listShortcuts : defaultListShortcuts;
  // 音频路径同样只在这里解析一次：它绝不参与命令行拼装，只作为 stdin 载荷字段下发。
  const audioPath = typeof options.audioPath === "string" ? options.audioPath.trim() : defaultNotificationAudioPath();

  const stats = { sent: 0, failed: 0, dropped: 0, lastReason: null };
  const aumidState = { aumid: null, reason: null, attemptAt: null };
  /**
   * 在途子进程 -> 收口函数：dispose 时先把本次投递归口成 disposed，再 kill 子进程，
   * 因此释放后不会再有 Toast 弹出来，调用方也不会等一个已经无意义的退出码。
   */
  const inFlight = new Map();
  const queue = [];
  let inflight = 0;
  let disposed = false;

  function note(reason) {
    stats.lastReason = reason;
    if (reason !== SYSTEM_TOAST_REASONS.ok) stats.failed += 1;
  }

  function warn(token) {
    if (logger === null || typeof logger.warn !== "function") return;
    try {
      logger.warn("dsh-expert-group: system toast " + token);
    } catch {
      // 日志出口失败绝不影响投递结果。
    }
  }

  /**
   * 单次子进程调用：stdin 写 JSON、可选读取 stdout、超时 kill。
   *
   * 返回值只有固定 reason 与有界 detail（退出码/信号），绝不携带 stderr 文本。
   */
  function runPowerShell({ script, payload, captureStdout = false }) {
    return new Promise((resolve) => {
      let settled = false;
      let cancelled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        if (child !== null) inFlight.delete(child);
        resolve(value);
      };
      let timer = null;
      let child = null;
      // 先解析解释器：拿不到绝对路径就立刻收口，绝不 spawn（不回退 PATH、不猜别的解释器）。
      const executable = resolvePowerShellPath({ env, fileExists });
      if (executable === null) {
        finish(toastResult(false, SYSTEM_TOAST_REASONS.powershellUnavailable));
        return;
      }
      try {
        child = spawnProcess(executable, powershellArgumentsFor(script), {
          shell: false,
          windowsHide: true,
          stdio: captureStdout === true ? ["pipe", "pipe", "ignore"] : ["pipe", "ignore", "ignore"],
        });
      } catch {
        finish(toastResult(false, SYSTEM_TOAST_REASONS.spawnError));
        return;
      }
      if (child === null || typeof child !== "object") {
        finish(toastResult(false, SYSTEM_TOAST_REASONS.spawnError));
        return;
      }
      // dispose 的收口入口：先判定 disposed（断言不再等待退出码），再 kill 子进程。
      inFlight.set(child, () => {
        cancelled = true;
        finish(toastResult(false, SYSTEM_TOAST_REASONS.disposed));
      });
      let stdout = "";
      if (captureStdout === true && child.stdout !== null && typeof child.stdout?.on === "function") {
        try {
          child.stdout.setEncoding("utf8");
        } catch {
          // 替身/裁剪环境没有 setEncoding：仍然收数据。
        }
        child.stdout.on("data", (chunk) => {
          // stdout 上界：probe 输出是受控 JSON，超出即视为损坏，避免无界缓冲。
          if (stdout.length < 262144) stdout += String(chunk);
        });
      }
      try {
        child.stdin?.on?.("error", () => {});
      } catch {
        // stdin 替身没有事件面：忽略。
      }
      try {
        child.stdin?.end?.(encodeJsonPayload(payload));
      } catch {
        // 写入失败（子进程已退出/管道关闭）：由 close/error 事件给出结论。
      }
      try {
        child.once?.("error", () => { finish(toastResult(false, SYSTEM_TOAST_REASONS.spawnError)); });
        child.once?.("close", (code, signal) => {
          if (cancelled) {
            finish(toastResult(false, SYSTEM_TOAST_REASONS.disposed));
            return;
          }
          if (code === 0) {
            finish({ ok: true, stdout });
            return;
          }
          finish(toastResult(false, SYSTEM_TOAST_REASONS.processExit, {
            exitCode: Number.isSafeInteger(code) ? code : null,
            signal: typeof signal === "string" ? signal : null,
          }));
        });
      } catch {
        finish(toastResult(false, SYSTEM_TOAST_REASONS.spawnError));
        return;
      }
      timer = setTimeout(() => {
        cancelled = true;
        try {
          child.kill?.();
        } catch {
          // kill 失败不影响结论：本次投递已经按超时收口。
        }
        finish(toastResult(false, SYSTEM_TOAST_REASONS.timeout));
      }, timeoutMs);
      // dispose 与在途调用竞争：已经释放时立即收口并 kill。
      if (disposed) {
        cancelled = true;
        try {
          child.kill?.();
        } catch {
          // 同上。
        }
        finish(toastResult(false, SYSTEM_TOAST_REASONS.disposed));
      }
    });
  }

  /**
   * 默认快捷方式读取：有界扫描**当前用户 + 所有用户**开始菜单 + 一次固定 probe 脚本调用。
   *
   * 只有两个根都不可用/不可读才是 shortcut-read-failed；单个根缺失只跳过它，
   * 另一个根里的快捷方式照常参与 AUMID 匹配。
   */
  async function defaultListShortcuts() {
    const directories = startMenuProgramsDirs(env);
    if (directories.length === 0) return { entries: [], reason: SYSTEM_TOAST_REASONS.shortcutReadFailed };
    const walk = await collectShortcutPaths({ dirs: directories, readdir });
    if (walk.readable !== true) return { entries: [], reason: SYSTEM_TOAST_REASONS.shortcutReadFailed };
    if (walk.paths.length === 0) return { entries: [], reason: null };
    const probe = await runPowerShell({ script: SHORTCUT_PROBE_SCRIPT, payload: { paths: walk.paths }, captureStdout: true });
    if (probe.ok !== true) return { entries: [], reason: probe.reason };
    let parsed;
    try {
      parsed = JSON.parse(probe.stdout.trim());
    } catch {
      return { entries: [], reason: SYSTEM_TOAST_REASONS.shortcutReadFailed };
    }
    // ConvertTo-Json 对单元素数组可能退化成对象：两种形状都接受。
    const raw = Array.isArray(parsed) ? parsed : (parsed !== null && typeof parsed === "object" ? [parsed] : []);
    const entries = [];
    for (const entry of raw) {
      if (entry === null || typeof entry !== "object") continue;
      entries.push({ targetPath: entry.targetPath, aumid: entry.aumid });
    }
    return { entries, reason: null };
  }

  /**
   * 解析（并缓存）AUMID：成功缓存引用；失败按冷却窗口重试，
   * 避免每次通知都递归扫描开始菜单。
   */
  async function ensureAumid() {
    if (aumidState.aumid !== null) return { aumid: aumidState.aumid, reason: SYSTEM_TOAST_REASONS.ok };
    const timestamp = Number(now());
    if (aumidState.attemptAt !== null && Number.isFinite(timestamp)
      && timestamp - aumidState.attemptAt < aumidCooldownMs) {
      return { aumid: null, reason: aumidState.reason ?? SYSTEM_TOAST_REASONS.noMatchingShortcut };
    }
    aumidState.attemptAt = Number.isFinite(timestamp) ? timestamp : null;
    let loaded;
    try {
      loaded = await listShortcuts();
    } catch {
      loaded = { entries: [], reason: SYSTEM_TOAST_REASONS.shortcutReadFailed };
    }
    const reported = loaded?.reason ?? null;
    if (reported !== null && reported !== void 0) {
      const reason = normalizeReasonToken(reported, SYSTEM_TOAST_REASONS.shortcutReadFailed);
      aumidState.aumid = null;
      aumidState.reason = reason;
      return { aumid: null, reason };
    }
    const matched = matchShortcutAumid({ shortcuts: loaded?.entries, execPath });
    aumidState.aumid = matched.aumid;
    aumidState.reason = matched.reason;
    return matched;
  }

  /** 真正投递一次：AUMID → XML → 子进程；任何失败都返回结构化结果。 */
  async function deliver({ title, taskName, body, volume }) {
    const resolved = await ensureAumid();
    if (resolved.aumid === null) {
      note(resolved.reason);
      warn(resolved.reason);
      return toastResult(false, resolved.reason);
    }
    const xml = buildToastXml({ title, taskName, body });
    // 载荷字段：正文只经 xml、音量与音频路径都是扁平字段（脚本据此决定是否播放）。
    const outcome = await runPowerShell({
      script: TOAST_SHOW_SCRIPT,
      payload: { aumid: resolved.aumid, xml, audioPath, volume },
    });
    if (outcome.ok !== true) {
      note(outcome.reason);
      warn(outcome.reason);
      return outcome;
    }
    stats.sent += 1;
    stats.lastReason = SYSTEM_TOAST_REASONS.ok;
    return toastResult(true, SYSTEM_TOAST_REASONS.ok);
  }

  /** 队列排空：串行投递，队列长度有界。 */
  function drain() {
    while (disposed !== true && inflight < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      void runJob(job);
    }
  }

  async function runJob(job) {
    inflight += 1;
    let result;
    try {
      result = await deliver(job.request);
    } catch {
      // 适配器对上层绝不抛出：兜底收口成固定 token。
      note(SYSTEM_TOAST_REASONS.spawnError);
      result = toastResult(false, SYSTEM_TOAST_REASONS.spawnError);
    } finally {
      inflight -= 1;
    }
    job.resolve(result);
    drain();
  }

  return Object.freeze({
    /**
     * 显示一条系统 Toast。
     *
     * @param {{title?: string, taskName?: string, body?: string, volume?: number}} [request]
     *   volume：0..100 的插件音量；缺失或非法按 100。只缩放 DEG 自己的提示音播放流，
     *   不影响系统主音量，也不影响 Toast 文案与投递语义。
     * @returns {Promise<{shown: boolean, reason: string, detail?: object}>} 永不 reject。
     */
    show(request) {
      if (disposed) return Promise.resolve(toastResult(false, SYSTEM_TOAST_REASONS.disposed));
      if (platform !== SYSTEM_TOAST_PLATFORM) {
        // 非 Windows 不 spawn 任何子进程：直接结构化 unsupported。
        note(SYSTEM_TOAST_REASONS.unsupported);
        return Promise.resolve(toastResult(false, SYSTEM_TOAST_REASONS.unsupported));
      }
      const normalized = {
        title: typeof request?.title === "string" ? request.title : "",
        taskName: typeof request?.taskName === "string" ? request.taskName : "",
        body: typeof request?.body === "string" ? request.body : "",
        // 音量在归一化时就固定下来：排队期间设置变更不影响已经入队的这一条。
        volume: normalizeToastVolume(request?.volume),
      };
      if (inflight >= maxConcurrent) {
        if (queue.length >= maxQueue) {
          stats.dropped += 1;
          note(SYSTEM_TOAST_REASONS.queueFull);
          warn(SYSTEM_TOAST_REASONS.queueFull);
          return Promise.resolve(toastResult(false, SYSTEM_TOAST_REASONS.queueFull));
        }
        return new Promise((resolve) => {
          queue.push({ request: normalized, resolve });
        });
      }
      return new Promise((resolve) => {
        void runJob({ request: normalized, resolve });
      });
    },
    /** 只读诊断：固定 token 与非负计数，不含正文/命令行/路径/AUMID。 */
    describe() {
      return Object.freeze({
        version: 1,
        platform: platform === SYSTEM_TOAST_PLATFORM ? "windows" : "unsupported",
        aumidResolved: aumidState.aumid !== null,
        aumidReason: aumidState.reason,
        inflight,
        queued: queue.length,
        sent: stats.sent,
        failed: stats.failed,
        dropped: stats.dropped,
        lastReason: stats.lastReason,
      });
    },
    /** 释放：清空队列、kill 在途子进程；幂等且不抛出。 */
    dispose() {
      if (disposed) return Promise.resolve();
      disposed = true;
      for (const job of queue.splice(0)) job.resolve(toastResult(false, SYSTEM_TOAST_REASONS.disposed));
      for (const [child, cancelInFlight] of [...inFlight]) {
        inFlight.delete(child);
        try {
          cancelInFlight();
        } catch {
          // 收口失败不影响后续 kill；调用方仍会拿到 disposed。
        }
        try {
          child.kill?.();
        } catch {
          // 释放路径不抛出。
        }
      }
      return Promise.resolve();
    },
  });
}
