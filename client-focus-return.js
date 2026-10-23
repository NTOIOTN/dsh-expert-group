/**
 * 删除 provider 之后的区域内焦点归还（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-focus-return")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientFocusReturn(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-focus-return");

    /** 恢复目标优先级：「添加提供方」入口优先，回退到稳定的折叠区标题。 */
    const REMOVE_FOCUS_TARGET_SELECTORS = Object.freeze([
      '[data-deg-add-provider="true"]',
      '[data-deg-model-config-toggle="true"]',
    ]);

    /** 运行期 document；没有 DOM（Node、裁剪过的宿主替身）时返回 null。 */
    function removeFocusDocument() {
      return typeof document === "undefined" ? null : (document ?? null);
    }

    /**
     * 读取当前持有焦点的元素。
     *
     * 读面的**三个状态必须分开表达**，只有中间那一种是"成功"：
     * - `activeElement` 明确返回 **null**：这是**已知的空焦点**（浏览器在没有焦点、或焦点
     *   落到 body / 页面根时给出的就是 null）。`ok === true`，收尾按"焦点仍停在原处"继续；
     * - 属性**不存在**，或 getter 返回 **undefined**：读面没有给出答案，是**未知**，
     *   `ok === false`。这**不是**空焦点：宿主替身 / 被裁剪的宿主压根没有这个读面时，
     *   `undefined` 只说明"读不到"；
     * - getter **抛错**：同样是未知，`ok === false`。
     *
     * 后两种曾被 `documentStub.activeElement ?? null` 折叠成"成功读到 null"：同一次删除流程
     * 里点击那一刻读到真实删除按钮、收尾时读面退化成 undefined 的非标准宿主，因此会在收尾
     * 把**未知**当成**已知的空焦点**，把焦点抢回 DEG 区域——正是"插件越过自己边界动焦点"
     * 那类事故。所以这里不能再做 nullish 合并，只有显式 null 才允许收尾继续。
     * 同一次删除里点击那一刻的读取失败也必须阻止 arm，否则一条无法证明归属的流程会在收尾
     * 时把焦点搬走。因此这里返回读结果对象，失败用 `ok === false` 显式表达，调用方各自决定跳过。
     */
    function readFocusedElement(documentStub) {
      if (documentStub === null || documentStub === undefined) return { ok: false, element: null };
      try {
        // 用 `in` 走**原型链**探测"这个宿主到底有没有焦点读面"：真实 document 的
        // activeElement 是 Document.prototype 上的继承访问器，任何 own-property 限定
        // （hasOwnProperty / 只认数据属性）都会把真实 DOM 判成"没有读面"，让整条恢复路径
        // 静默失效。Proxy / 被裁剪的宿主连 `in` 都可能抛错：那属于"读面归属未知"，
        // 与"读面存在但没有答案"同样按失败处理（宁可不恢复，也不猜）。
        if (!("activeElement" in documentStub)) return { ok: false, element: null };
        const element = documentStub.activeElement;
        // 读面给出 undefined = 没有答案（未知），绝不能当作空焦点。
        if (element === undefined) return { ok: false, element: null };
        return { ok: true, element };
      } catch {
        return { ok: false, element: null };
      }
    }

    /**
     * 捕获作用域：删除按钮所在的 DEG 区域。
     *
     * 必须在**点击时**捕获而不是收尾时再算：删除成功的刷新会给所有卡片换 key，原按钮
     * 届时已从页面摘除，它的祖先链随之断开，事后再 closest 只会得到 null。
     */
    function closestRemoveFocusScope(trigger) {
      if (trigger === null || typeof trigger.closest !== "function") return null;
      try {
        return trigger.closest(".deg_mc_section") ?? null;
      } catch {
        return null;
      }
    }

    /**
     * 布局可见性的保守判定：读得到就读，读不到就不猜。
     *
     * 这里**不能**再用 `hasOwnProperty("offsetParent")`：真实浏览器里 offsetParent 定义在
     * `HTMLElement.prototype` 上，own property 探测恒为 false——这条判定在真实 DOM 上从未
     * 生效过；而换成 `offsetParent !== null` 又会把 fixed 定位元素（offsetParent 本来就是
     * null）误杀。两个真实可用的读面都按"有读面才判定"处理：
     * - `checkVisibility({ visibilityProperty: true })`：一次覆盖 display:none、visibility 与
     *   content-visibility。options 必须显式给出：`checkVisibility()` 的默认语义**只**看元素
     *   是否渲染，被 CSS `visibility: hidden` 藏起来的控件仍然参与排版、仍然会被判为可见，
     *   恢复焦点就会交给一个用户看不见的控件。宿主实现若不认识 options 而抛错，异常会被
     *   下面的 catch 吞掉并退到 getClientRects，不会连累删除结果；
     * - `getClientRects()`：零渲染矩形（未排版 / display:none）说明元素没有盒子，
     *   而 fixed 定位元素同样有渲染矩形，因此合法目标不会被误杀。
     * 无布局引擎的替身/宿主两个读面都读不到时保持"不做无根据的判定"，避免整体误杀恢复能力。
     */
    function isLaidOutRemoveFocusTarget(element) {
      if (typeof element.checkVisibility === "function") {
        try {
          // 必须带 options：默认调用不看 CSS visibility 属性（见上方边界说明）。
          if (element.checkVisibility({ visibilityProperty: true }) === false) return false;
        } catch { /* 读面抛错：交给下一个读面，不做无根据的判定。 */ }
      }
      if (typeof element.getClientRects === "function") {
        try {
          const rects = element.getClientRects();
          // DOMRectList 与数组都有 length；读面给出非列表值时同样不做无根据的判定。
          if (rects !== null && rects !== undefined && typeof rects.length === "number" && rects.length === 0) return false;
        } catch { /* 同上。 */ }
      }
      return true;
    }

    /**
     * 目标可用性的保守判定：断开、隐藏、disabled、aria-disabled 或没有渲染矩形一律不可用。
     */
    function isUsableRemoveFocusTarget(element) {
      if (element === null || typeof element !== "object") return false;
      // focus() 缺失（裁剪过的元素替身）时不尝试：恢复焦点绝不允许抛错。
      if (typeof element.focus !== "function") return false;
      // isConnected 在真实 DOM 上恒为布尔；读面缺失时按"不可用"处理，宁可不恢复也不猜。
      if (element.isConnected !== true) return false;
      if (element.hidden === true) return false;
      if (element.disabled === true) return false;
      const ariaDisabled = typeof element.getAttribute === "function"
        ? element.getAttribute("aria-disabled")
        : element["aria-disabled"];
      if (ariaDisabled === "true" || ariaDisabled === true) return false;
      if (!isLaidOutRemoveFocusTarget(element)) return false;
      return true;
    }

    /** 在作用域内按优先级挑一个恢复目标；一个都不可用时返回 null。 */
    function pickRemoveFocusTarget(scope) {
      if (scope === null || typeof scope.querySelector !== "function") return null;
      for (const selector of REMOVE_FOCUS_TARGET_SELECTORS) {
        let candidate = null;
        try {
          candidate = scope.querySelector(selector);
        } catch {
          candidate = null;
        }
        if (isUsableRemoveFocusTarget(candidate)) return candidate;
      }
      return null;
    }

    /**
     * 一次删除期间的"焦点意图"观察器。
     *
     * document 捕获阶段的 pointerdown / keydown / focusin 任一命中即把本次恢复标记为
     * abandoned（用户或宿主已经把意图移到别处）。`dispose()` 幂等：调用方必须在提前返回、
     * 异常与成功路径上都调用它，ModelConfigSection 卸载时还会再兜一次——删除流程里有多个
     * await，远端 Promise 可能长时间不结算，全局监听绝不能留在页面上。
     */
    function observeRemoveFocusIntent(documentStub) {
      const events = ["pointerdown", "keydown", "focusin"];
      const registered = [];
      let abandoned = false;
      let disposed = false;
      const markAbandoned = () => { abandoned = true; };
      if (documentStub !== null && typeof documentStub.addEventListener === "function") {
        for (const type of events) {
          try {
            // capture=true：即使宿主在冒泡阶段 stopPropagation，也必须看到这次操作。
            documentStub.addEventListener(type, markAbandoned, true);
            registered.push(type);
          } catch { /* 登记失败：少观察一类事件，不影响删除语义。 */ }
        }
      }
      return {
        isAbandoned: () => abandoned,
        dispose() {
          if (disposed) return;
          disposed = true;
          if (documentStub === null || typeof documentStub.removeEventListener !== "function") return;
          for (const type of registered) {
            try {
              documentStub.removeEventListener(type, markAbandoned, true);
            } catch { /* 摘监听失败：监听随页面销毁一起消失，不影响删除结果。 */ }
          }
          registered.length = 0;
        },
      };
    }

    /**
     * 在途焦点意图观察器的账本（每个删除流程各拥有自己那一条）。
     *
     * 为什么必须由组件持有而不是各流程自己记：删除流程里有多个 await，远端 Promise 可能
     * 长时间不结算，捕获监听绝不能留在页面上，所以卸载时必须有一个统一的兜底口。
     *
     * 三条不变量：
     * ① 集合在**首个渲染期**（useRef 初始化）就建立，绝不等到 passive effect 才赋值——
     *    真实 React 的 passive effect 在提交之后异步执行，删除流程完全可能在它之前就登记，
     *    那样的登记会落进 null 而永远无人清理（等价于把捕获监听永久留在 document 上）；
     * ② 重叠的删除各自只移除自己那一条（`delete` 按对象身份，与顺序无关），单槽位账本
     *    会在双击删除时漏掉先发起的那条；
     * ③ 卸载即 `close()`：关闭后到达的登记**当场自我清理**，绝不允许再出现无人认领的监听。
     *    因此 `delete`/`close` 与 `dispose` 一样必须幂等。
     */
    function createRemoveFocusObservationLedger() {
      const observations = new Set();
      let closed = false;
      return {
        add(observation) {
          if (observation === null || observation === undefined) return;
          if (closed) {
            // 账本已随卸载关闭：这条登记没有任何人去摘它，只能当场清理。
            observation.dispose();
            return;
          }
          observations.add(observation);
        },
        /** 某次流程自己认领的观察器收尾：与卸载兜底摘的是同一条，dispose 幂等。 */
        delete(observation) {
          observations.delete(observation);
        },
        close() {
          if (closed) return;
          closed = true;
          for (const observation of observations) observation.dispose();
          observations.clear();
        },
      };
    }

    /**
     * 成功路径的收尾：先摘观察器，再按优先级还一次焦点。
     *
     * 前置条件缺一不可——作用域仍在页面上、意图没被移走、焦点仍停在原处（原按钮 / body /
     * 空）。任何读面缺失或 focus() 抛错都只让这次恢复静默跳过：删除已经写盘，焦点问题
     * 绝不允许改变删除结果。
     */
    function restoreRemoveFocus({ documentStub, trigger, scope, observation }) {
      // 整段包在 try 里：焦点读面/写面（activeElement、getAttribute、focus）在任何宿主
      // 实现上都可能抛错，而删除已经写盘——焦点问题绝不允许改变删除结果。
      try {
        if (documentStub === null || trigger === null || scope === null) return;
        if (observation?.isAbandoned?.() === true) return;
        // 区域必须仍挂在页面上：整块设置页被卸载或替换时不再恢复任何焦点。
        if (scope.isConnected !== true) return;
        // 收尾这一次读取失败 = 当前焦点归属**未知**：安全跳过，绝不猜测。
        const focusRead = readFocusedElement(documentStub);
        if (focusRead.ok !== true) return;
        const active = focusRead.element;
        const body = documentStub.body ?? null;
        // 只有焦点仍"停在原处"（原按钮 / body / 已知的空焦点）才恢复：用户已经点/切到
        // 别处（例如 DSH 输入框）时绝不抢回来。
        if (active !== null && active !== trigger && active !== body) return;
        const target = pickRemoveFocusTarget(scope);
        if (target === null) return;
        target.focus();
      } catch { /* 焦点不可用时保持删除结果不变。 */ }
    }

    /**
     * 折叠的「模型配置」区域。
     *
     * 默认折叠时不读取 provider 目录；展开后读取 provider 目录、凭据状态与 settings 命名空间；
     * 卡片各自独立应用/取消，区域本身不提供任何保存按钮，角色配置的保存按钮与既有行为不变。
     * 组件由设置页标题后立即挂载，模型配置先于下方角色表显示。
     */

  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    removeFocusDocument, readFocusedElement, closestRemoveFocusScope, isUsableRemoveFocusTarget, pickRemoveFocusTarget, observeRemoveFocusIntent, createRemoveFocusObservationLedger, restoreRemoveFocus,
  });
})(globalThis);
