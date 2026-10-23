/**
 * 原生状态文本重写器。
 *
 * 替换原生状态行里的第一处运行中前缀，并在需要时恢复原文。
 * 本文件由原 `shared.js` 的 3610–3709 区段拆出（R1 票据 05）；
 * 保持无副作用，跨模块依赖只通过叶子模块之间的 ESM import 表达。
 *
 * @module dsh-expert-group/shared/native-text
 */
import { NATIVE_RUNNING_STATUS_PREFIXES } from "./i18n.js";

/**
 * 只替换原生运行前缀的纯函数（fail-closed）。
 *
 * 边界语义：
 * - 原文里没有任何候选前缀时返回 null：调用方必须保持宿主原文案，绝不猜测或整行重建；
 * - 只替换**第一处**出现（中英文候选混排时取原文中最靠前的那个；同位置优先更长的候选），
 *   其余内容逐字节保留（分隔逗号、用时、末尾省略号、空白与大小写）；
 * - 原文或替换文案不是非空字符串时返回 null。
 * @param {unknown} currentText - 宿主当前渲染的原生文案。
 * @param {unknown} replacementText - 角色文案（例如 "Explorer running"，不带省略号）。
 * @returns {string|null} 替换后的完整文案；没有可替换前缀时返回 null。
 */
export function replaceNativeStatusPrefix(currentText, replacementText) {
  if (typeof currentText !== "string" || currentText.length === 0) return null;
  if (typeof replacementText !== "string" || replacementText.length === 0) return null;
  let match = null;
  for (const prefix of NATIVE_RUNNING_STATUS_PREFIXES) {
    const at = currentText.indexOf(prefix);
    if (at === -1) continue;
    if (match === null || at < match.at || (at === match.at && prefix.length > match.prefix.length)) {
      match = { at, prefix };
    }
  }
  if (match === null) return null;
  return currentText.slice(0, match.at) + replacementText + currentText.slice(match.at + match.prefix.length);
}

/**
 * 创建只操作一个原生文本节点的前缀重写器。
 *
 * DOM 适配、MutationObserver 与 React 生命周期由 client.js 持有；本函数只处理
 * 「原生前缀 → 角色文案」的保存/替换/恢复，因此可在无 DOM 的 node:test 中用最小 mock 验证。
 * 它永远不触碰 class/style、兄弟计时器、aria 属性或其它节点，也不重建整行。
 *
 * 原文跟进规则（同一个 Text 节点上的内容随时可能被宿主改写）：
 * - 角色变化：只换前缀，逗号/用时/末尾省略号继续沿用宿主最新原文；
 * - 宿主重渲染、locale 切换或用时刷新：当前值不再是本插件写入的那一份时，把宿主最新值
 *   认定为原文，清理时恢复它——绝不把旧语言或旧用时写回去；
 * - 原文没有原生前缀（例如英文 locale 的 "Deep diving..."）时不做任何写入。
 *
 * 可选 decorate/undecorate 钩子仅用于调用方管理附加生命周期；当前原生状态桥不传入
 * 任何装饰钩子，因此不会向宿主节点添加 marker、样式或动画。rewriter 仍保证换目标和
 * 清理时先处理旧目标，避免调用方留下 stale 状态。
 * @param {object} options - findNode/getText/setText/isConnected/decorate/undecorate 适配函数。
 * @returns {{apply:(text:string|null)=>void, restore:()=>void}}
 */
export function createNativeTextRewriter(options = {}) {
  const findNode = typeof options.findNode === "function" ? options.findNode : () => void 0;
  const getText = typeof options.getText === "function" ? options.getText : (node) => node?.nodeValue;
  const setText = typeof options.setText === "function" ? options.setText : (node, value) => { node.nodeValue = value; };
  const isConnected = typeof options.isConnected === "function" ? options.isConnected : (node) => node?.isConnected !== false;
  const decorate = typeof options.decorate === "function" ? options.decorate : () => {};
  const undecorate = typeof options.undecorate === "function" ? options.undecorate : () => {};
  let activeNode;
  let originalText;
  let rewrittenText;

  function restore() {
    // 只在"当前值仍是我们写入的那一份"时回写：宿主已自行改写内容时保持宿主最新值，
    // 避免把旧语言、旧用时或旧角色文案盖回去。
    if (activeNode !== void 0 && isConnected(activeNode) && getText(activeNode) === rewrittenText) {
      setText(activeNode, originalText);
    }
    activeNode = void 0;
    originalText = void 0;
    rewrittenText = void 0;
    undecorate();
  }

  function apply(text) {
    if (typeof text !== "string" || text.length === 0) {
      restore();
      return;
    }
    const candidate = findNode();
    if (candidate === null || candidate === void 0) {
      restore();
      return;
    }
    const currentText = getText(candidate);
    if (activeNode !== candidate) {
      restore();
      activeNode = candidate;
      originalText = currentText;
    } else if (currentText !== rewrittenText) {
      // DSH 在同一 Text 节点上更新原文（locale 切换、用时刷新、React 重写）；
      // 跟进外部值，清理时恢复的必须是最新原文。
      originalText = currentText;
    }
    const next = replaceNativeStatusPrefix(originalText, text);
    // 没有可替换的原生前缀（英文 locale、宿主已换成完成文案等）时保持原文，不做任何写入。
    rewrittenText = next === null ? currentText : next;
    if (next !== null && currentText !== next) setText(activeNode, next);
    // 装饰放在文本写入之后：无论首次接管、节点替换还是重复通知，装饰都针对当前目标。
    decorate(activeNode);
  }

  return { apply, restore };
}
