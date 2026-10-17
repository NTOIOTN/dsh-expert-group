#!/usr/bin/env node
/**
 * 同步 @deepseek-ai/dsh-* peerDependencies 到目标版本。
 *
 * 边界与并发说明：
 * - 仓库根从模块自身位置（import.meta.url）解析，不再依赖调用者的工作目录。这样 `pnpm release`
 *   串联调用、从仓库外目录调用、或由其它脚本以任意 cwd spawn 时都作用于同一份 package.json；
 *   反之若按工作目录解析，从别处调用会写坏调用方目录里的同名文件。
 * - lockfile 只读检查、绝不自动改写：pnpm-lock.yaml 的 importer 段由包管理器重建，手工替换
 *   文本会与 integrity/版本映射不一致，属于比"提示"更坏的静默损坏。
 * - 脚本是单次运行的短生命周期进程，不做文件锁；同一时刻只允许一次版本同步（发布流程本身就是
 *   串行门槛），并发调用同一 package.json 会互相覆盖，属于使用错误而非本脚本需要兜底的场景。
 * - 目标版本取「命令行位置参数 → DSH_VERSION 环境变量 → 内置默认」三档，因此默认值只需要
 *   在这一处维护：`package.json` 的 release 脚本不再硬编码任何 DSH 版本（避免宿主升级后
 *   发布链把 peer range 钉回旧 minor）。
 */
import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

/**
 * 默认目标 DSH 版本（本插件唯一支持的宿主版本线）。
 * 宿主升级时只改这一处；发布链与 peer 基线都随它走。
 */
const DEFAULT_DSH_VERSION = '0.2.1-rc.2';

/** 仓库根：scripts/ 的父目录；与调用者 cwd 无关。 */
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgPath = join(repoRoot, 'package.json');
const lockfilePath = join(repoRoot, 'pnpm-lock.yaml');

// 位置参数优先，其次 DSH_VERSION 环境变量，最后回退内置默认值（三者都能覆盖）。
// 空白参数按「未提供」处理：`pnpm release ""` 不应把空的 peer range 写进 package.json。
const firstArgument = typeof process.argv[2] === 'string' ? process.argv[2].trim() : '';
const envVersion = typeof process.env.DSH_VERSION === 'string' ? process.env.DSH_VERSION.trim() : '';
const targetVersion = firstArgument || envVersion || DEFAULT_DSH_VERSION;

// 显式给出的版本必须是形如 semver 的宿主版本线；默认值由本文件维护，同样受此校验保护。
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
  console.error(`目标版本不是合法 semver: ${targetVersion}`);
  console.error('Usage: node scripts/sync-dsh-version.mjs [version]');
  console.error(`Example: node scripts/sync-dsh-version.mjs ${DEFAULT_DSH_VERSION}`);
  console.error(`仓库根（由脚本自身位置定位）: ${repoRoot}`);
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));

// 更新所有@deepseek-ai/dsh-*包
let count = 0;
const dshPackages = [];
for (const key in pkg.peerDependencies) {
  if (key.startsWith('@deepseek-ai/dsh-')) {
    const oldVersion = pkg.peerDependencies[key];
    pkg.peerDependencies[key] = `^${targetVersion}`;
    dshPackages.push({ name: key, old: oldVersion, new: `^${targetVersion}` });
    count++;
  }
}

writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

console.log(`✅ 已更新 ${count} 个包到 ^${targetVersion}`);
console.log('\n变更清单:');
dshPackages.forEach(({ name, old, new: newVer }) => {
  console.log(`  ${name}: ${old} → ${newVer}`);
});

/**
 * 判断 pnpm-lock.yaml 是否仍引用旧的 @deepseek-ai/dsh-* 版本。
 * 文本匹配足以覆盖本门禁场景：命中任一「@deepseek-ai/dsh-*: ^<targetVersion>」即视为已同步，
 * 因此结果偏保守（宁可提示重建，也不误报"已同步"）。
 * @returns {boolean} true 表示 lockfile 仍引用旧版本、需要重建
 */
function lockfileStale() {
  let text;
  try {
    text = readFileSync(lockfilePath, 'utf-8');
  } catch {
    // lockfile 缺失或不可读时无法判定，按"需要重建"处理，避免静默放过。
    return true;
  }
  // 转义目标版本里的正则元字符（semver 可能含 '-'、'+' 等），避免误匹配。
  // 目标版本出现在 lockfile 的 `specifier` 行；匹配从包名到 `^<version>` 的整段形状，
  // 版本尾部不得再跟标识符字符（否则 ^0.9.9 会误匹配 ^0.9.9-other）。YAML 允许
  // 包名与版本两侧带引号，因此引号按可选处理。
  const escaped = targetVersion.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const dshEntry = new RegExp(`@deepseek-ai/dsh-[\\w.-]+['"]?\\s*:[\\s\\S]{0,40}?['"]?\\^${escaped}(?![\\w.-])`);
  return !dshEntry.test(text);
}

/**
 * lockfile 一致性只读检查：同步 peerDependencies 后 lockfile 里的 specifier 会滞后于
 * package.json，此时必须显式提示由维护者运行 pnpm install 让包管理器重建 importer 段。
 */
if (lockfileStale()) {
  console.log('\n下一步: pnpm-lock.yaml 中的 @deepseek-ai/dsh-* specifier 仍是旧版本，');
  console.log('      请运行 `pnpm install --lockfile-only` 重建 lockfile 后再提交。');
  console.log('      （lockfile 由包管理器重建，本脚本不会自动改写它。）');
} else {
  console.log(`\nlockfile 检查: pnpm-lock.yaml 中未发现需要更新的 @deepseek-ai/dsh-* specifier（${count} 项已同步）。`);
}
console.log('\n下一步: 运行 pnpm install 重新安装依赖');
