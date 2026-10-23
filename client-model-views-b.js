/**
 * 模型视图 B：候选弹窗、选择纯函数与共享的模型行编辑器（R8 票据 27 / 票据 40）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-model-views-b")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 *
 * 为什么模型行编辑器在这里而不是 client-model-section.js：model-section 依赖 views-a
 * （ModelProviderCard / ModelConfigDisclosure）与 provider-card，把共享渲染放到那里会让
 * views-a / provider-card 反向依赖 model-section，在 IIFE 依赖图里成环，且装配顺序上
 * model-section 晚于两者、安装期取不到检查点。views-b 是两个调用点**都已依赖且最先执行**
 * 的模块，因此共享实现放在这里：不新增文件，也不新增依赖边。
 */
(function installClientModelViewsB(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-model-views-b");
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  function bindClientRuntime(host) {
    react = host.react ?? null;
  }

    /**
     * 弹窗标题 id 的自增序号。
     *
     * 同一个设置页可以同时挂载多个候选弹窗（例如两张 provider 卡片各自探测），
     * 每个实例的 `aria-labelledby` 必须指向**自己**的标题；共用一个字面量 id 会让
     * 后挂载的弹窗把无障碍名称解析到别人的标题上。
     *
     * 用模块级计数器 + 组件内惰性初始化，而不是 `react.useId`：本插件的 react 面
     * 在嵌入宿主与测试替身里都可能缺少 `useId`，计数器只依赖 useState/useRef 这类
     * 一直存在的 API。
     */
    let modelDiscoveryTitleSeq = 0;


    /**
     * 弹窗焦点环的候选控件：只保留真正可聚焦（启用且可见）的对话框控件。
     *
     * 判定只用声明式属性，不做布局测量（offsetParent 之类在嵌入宿主里不可靠）：
     * - `disabled` / `aria-disabled="true"` 的控件浏览器会忽略 focus 调用；
     * - `hidden` / `aria-hidden="true"` 的控件不参与 Tab 顺序。
     * 两者都必须从焦点环里剔除——否则 handler 先 preventDefault 再 focus 一个被忽略的
     * 元素，焦点会原地卡死或漏到背景页面。
     *
     * @param {unknown} scope 弹窗根节点（任何提供 querySelectorAll 的元素）
     * @returns {Array<{focus?: Function}>} 按 DOM 顺序排列的可聚焦控件
     */
    function focusableDialogControls(scope) {
      const nodes = Array.from(scope?.querySelectorAll?.("[data-deg-dialog-action]") ?? []);
      return nodes.filter((node) => {
        if (node === null || typeof node !== "object") return false;
        if (node.disabled === true) return false;
        if (node.hidden === true) return false;
        if (typeof node.getAttribute !== "function") return true;
        if (node.getAttribute("aria-disabled") === "true") return false;
        if (node.getAttribute("aria-hidden") === "true") return false;
        return true;
      });
    }

    /**
     * 单条模型行的编辑器（票据 40 的跨组件去重）。
     *
     * provider 编辑卡片（ModelProviderCard）与自定义创建卡片（CustomProviderCard）的模型行
     * 在渲染树上逐节点同形；差异只有三处，全部显式传入：数据属性（编辑卡片用
     * data-deg-model-index，创建卡片另加 data-deg-create-model-id）、禁用来源（disabled /
     * profileDisabled）与动作绑定（改卡片草稿 / 改创建草稿）。因此这里只保留一份实现，
     * 两个调用点各自把动作适配成同一组回调，避免同一段 JSX 维护两遍后发生漂移。
     *
     * 高级设置（上下文窗口 / 最大输出 token / 七档 / 输入类型）也在这里：七档始终按
     * REASONING_EFFORTS 的顺序渲染，与模型目录是否声明支持无关；勾选状态由
     * buildModelCardModel 算好，本函数只负责画。
     *
     * @param {object} model 单行视图模型（buildModelCardModel 的 models[i]）。
     * @param {object} options 行级差异与动作绑定。
     * @param {string} options.key React key。
     * @param {object} options.attributes 行容器的数据属性。
     * @param {object} [options.idAttributes] 模型 ID 输入的额外数据属性。
     * @param {boolean} options.disabled 是否禁用整行。
     * @param {string} options.idLabel 模型 ID 输入的无障碍名称前缀。
     * @param {string} options.nameLabel 模型显示名输入的无障碍名称前缀。
     * @param {Function} options.parseCapacity 容量文本 → 数值的纯函数。
     * @param {Function} options.onChange (index, patch) => void。
     * @param {Function} options.onToggleAdvanced (index) => void。
     * @param {Function} options.onRemove (index) => void。
     * @param {Function} options.onEffort (index, level) => void。
     * @param {Function} options.onInput (index, modality) => void。
     * @returns {object} 单行元素。
     */
    function renderModelRow(model, options) {
      const {
        key, attributes, idAttributes = {}, disabled, idLabel, nameLabel, parseCapacity,
        onChange, onToggleAdvanced, onRemove, onEffort, onInput,
      } = options;
      const advanced = model.advancedOpen
        ? react.createElement("div", { className: "deg_mc_model_advanced" },
          react.createElement("label", { className: "deg_mc_field" },
            react.createElement("span", { className: "deg_mc_field_label" }, "上下文窗口"),
            react.createElement("input", {
              className: "deg_mc_input",
              type: "text",
              inputMode: "numeric",
              value: model.contextWindow.value,
              placeholder: model.contextWindow.placeholder,
              "aria-label": "上下文窗口 " + String(model.position),
              disabled,
              onChange: (event) => onChange(model.index, { contextWindow: parseCapacity(event.target.value) }),
            })),
          react.createElement("label", { className: "deg_mc_field" },
            react.createElement("span", { className: "deg_mc_field_label" }, "最大输出 token"),
            react.createElement("input", {
              className: "deg_mc_input",
              type: "text",
              inputMode: "numeric",
              value: model.maxTokens.value,
              placeholder: model.maxTokens.placeholder,
              "aria-label": "最大输出 token " + String(model.position),
              disabled,
              onChange: (event) => onChange(model.index, { maxTokens: parseCapacity(event.target.value) }),
            })),
          react.createElement("fieldset", { className: "deg_mc_efforts" },
            react.createElement("legend", { className: "deg_mc_efforts_label" }, "思考档位（可多选）"),
            react.createElement("div", { className: "deg_mc_efforts_row" },
              model.efforts.map((effort) => react.createElement("label", {
                key: effort.level,
                className: "deg_mc_effort",
              }, react.createElement("input", {
                type: "checkbox",
                checked: effort.checked,
                disabled,
                "data-deg-effort": effort.level,
                "data-deg-model-index": model.index,
                "aria-label": "模型 " + String(model.position) + " 思考档位 " + effort.level,
                onChange: () => onEffort(model.index, effort.level),
              }), react.createElement("span", null, effort.level))))),
          react.createElement("fieldset", { className: "deg_mc_efforts" },
            react.createElement("legend", { className: "deg_mc_efforts_label" }, "输入类型"),
            react.createElement("div", { className: "deg_mc_input_types" },
              model.inputs.map((input) => react.createElement("label", {
                key: input.modality,
                className: "deg_mc_effort",
              }, react.createElement("input", {
                type: "checkbox",
                checked: input.checked,
                disabled: disabled || input.locked === true,
                "data-deg-input": input.modality,
                "data-deg-model-index": model.index,
                "aria-label": "模型 " + String(model.position) + " 输入类型 " + input.modality,
                onChange: () => onInput(model.index, input.modality),
              }), react.createElement("span", null, input.modality))))))
        : null;
      return react.createElement("div", {
          key,
          className: "deg_mc_model",
          ...attributes,
        }, react.createElement("div", { className: "deg_mc_model_main" },
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            value: model.id.value,
            placeholder: "模型 ID",
            "aria-label": idLabel + String(model.position),
            disabled,
            onChange: (event) => onChange(model.index, { id: event.target.value }),
            ...idAttributes,
          }),
          react.createElement("input", {
            className: "deg_mc_input",
            type: "text",
            value: model.name.value,
            placeholder: "显示名",
            "aria-label": nameLabel + String(model.position),
            disabled,
            onChange: (event) => onChange(model.index, { name: event.target.value }),
          }),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_mc_icon_btn",
            "aria-label": "模型高级设置 " + String(model.position),
            "aria-expanded": model.advancedOpen,
            onClick: () => onToggleAdvanced(model.index),
          }, model.advancedOpen ? "▾" : "▸"),
          react.createElement("button", {
            type: "button",
            className: "deg_btn deg_mc_icon_btn",
            "aria-label": "删除模型 " + String(model.position),
            disabled,
            onClick: () => onRemove(model.index),
          }, "✕")),
        advanced);
    }

    /**
     * 候选弹窗「全选/取消全选」的纯函数语义（与 DSH 模型页的可见项切换一致）。
     *
     * 关键边界（不是"只动可见项"那么简单）：
     * - 当前可见候选**已全部勾选**时，切换等价于清空**全部**选择（含被搜索隐藏的候选）；
     * - 否则只把当前可见候选**追加**为已选，隐藏候选保留原有选择。
     *
     * 弹窗按钮文案与父卡片的实际改写都取自这一个判定，避免两处各自推断出不同语义。
     *
     * @param {Array<{id?: unknown, picked?: unknown}>} candidates 全部候选
     * @param {Set<unknown>} visibleIds 当前可见候选 id
     * @returns {boolean} true 表示"清空全部选择"，false 表示"只追加可见项"
     */
    function clearsAllCandidateSelection(candidates, visibleIds) {
      const list = Array.isArray(candidates) ? candidates : [];
      const wanted = visibleIds instanceof Set ? visibleIds : new Set();
      const visible = list.filter((candidate) => wanted.has(candidate?.id));
      return visible.length > 0 && visible.every((candidate) => candidate.picked === true);
    }

    /**
     * 自定义 provider 的可用模型选择弹窗：候选只进入当前草稿，不在探测成功时自动写 settings。
     *
     * 交互与 DSH 原生模型页保持一致：搜索当前候选、当前结果全选/取消全选、逐项勾选，
     * 最后由“添加所选”调用父卡片的 adoptModels 合并。弹窗关闭不会丢弃卡片里已有模型。
     *
     * 模态契约（与 DSH 内置 picker 的 Modal/useModalLayer 对齐）：
     * - 关闭按钮、点击遮罩、Escape 三条路径都只**关闭**弹窗（走 onClose），不改草稿、不采纳；
     * - 弹窗内 Tab / Shift+Tab 只在**真正可聚焦**（启用且可见）的控件之间循环，不把焦点
     *   漏到背景页面，也不会把焦点交给 disabled 的「添加所选」或空结果时的「全选」；
     * - 关闭（卸载）后把焦点还给打开弹窗前的那个元素；
     * - 标题 id 每个实例唯一，多个弹窗同时挂载时各自指向自己的标题。
     *
     * 焦点相关调用全部做能力探测：嵌入宿主（或测试替身）没有 document/focus 时静默跳过，
     * 绝不因为焦点不可用而让弹窗不可关闭。
     */
    function ModelDiscoveryDialog({ candidates, query, onQueryChange, onToggle, onToggleVisible, onClose, onAdopt }) {
      const source = Array.isArray(candidates) ? candidates : [];
      // 标题 id 每个实例唯一（惰性初始化只在首次渲染执行一次），dialog 的 aria-labelledby
      // 因此始终指向本实例自己的 h3。
      const [titleId] = react.useState(() => {
        modelDiscoveryTitleSeq += 1;
        return "deg-model-discovery-title-" + String(modelDiscoveryTitleSeq);
      });
      const dialogRef = react.useRef(null);
      // 打开前的焦点归属：只在挂载时读一次，卸载时原样还回去。
      const restoreTargetRef = react.useRef(typeof document === "undefined" ? null : document.activeElement ?? null);
      react.useEffect(() => () => {
        // 关闭（卸载）时恢复先前焦点；元素可能已从页面移除，因此 focus 缺失时直接跳过。
        const target = restoreTargetRef.current;
        try {
          if (target !== null && typeof target?.focus === "function") target.focus();
        } catch { /* 焦点不可用时保持弹窗关闭语义，不抛出。 */ }
      }, []);
      const normalizedQuery = typeof query === "string" ? query.trim().toLowerCase() : "";
      const visible = normalizedQuery.length === 0
        ? source
        : source.filter((candidate) => {
          const id = typeof candidate?.id === "string" ? candidate.id : "";
          const name = typeof candidate?.name === "string" ? candidate.name : "";
          return id.toLowerCase().includes(normalizedQuery) || name.toLowerCase().includes(normalizedQuery);
        });
      const visibleIds = new Set(visible.map((candidate) => candidate?.id));
      // 按钮文案与父卡片的改写必须同源：这里只用纯函数判定"这次切换是否清空全部选择"。
      const clearsAll = clearsAllCandidateSelection(source, visibleIds);
      const pickedCount = source.filter((candidate) => candidate.picked === true).length;
      const handleKeyDown = (event) => {
        if (event?.key === "Escape") {
          // 关闭是模态层的独占语义：阻止默认行为并停止冒泡，避免外层再处理同一个 Escape。
          event.preventDefault?.();
          event.stopPropagation?.();
          onClose();
          return;
        }
        if (event?.key !== "Tab") return;
        // 焦点环：与提示词弹窗同一套 data 标记与循环算法（首尾相接，Shift+Tab 反向），
        // 但候选集只取**真正可聚焦**的控件：disabled 的「添加所选」与无结果时的「全选」
        // 必须跳过，否则 preventDefault 之后 focus 一个被浏览器忽略的元素会让焦点卡死。
        const controls = focusableDialogControls(dialogRef.current);
        // 没有任何可聚焦控件时不拦截 Tab：宁可让焦点按浏览器默认行为走，也不把焦点锁死。
        if (controls.length === 0) return;
        const current = controls.indexOf(typeof document === "undefined" ? null : document.activeElement);
        const nextIndex = event.shiftKey
          ? (current <= 0 ? controls.length - 1 : current - 1)
          : (current >= controls.length - 1 ? 0 : current + 1);
        event.preventDefault?.();
        try { controls[nextIndex]?.focus?.(); } catch { /* 无 DOM 焦点时保持可点击控件。 */ }
      };
      const list = visible.length === 0
        ? react.createElement("p", { className: "deg_mc_candidate_empty", role: "status" }, "没有匹配的模型")
        : react.createElement("ul", { className: "deg_mc_candidate_list" }, visible.map((candidate) => (
          react.createElement("li", { key: candidate.id, className: "deg_mc_candidate_item" },
            react.createElement("label", { className: "deg_mc_candidate_label" },
              react.createElement("input", {
                type: "checkbox",
                checked: candidate.picked === true,
                "data-deg-create-candidate": candidate.id,
                "data-deg-dialog-action": "candidate",
                "aria-label": "选择模型 " + candidate.id,
                onChange: () => onToggle(candidate.id),
              }),
              react.createElement("span", { className: "deg_mc_candidate_id" }, candidate.id))))));
      return react.createElement("div", {
        className: "deg_mc_modal_backdrop",
        // 点遮罩只关闭：候选状态与草稿都不受影响（采纳只能由“添加所选”触发）。
        onClick: () => onClose(),
      },
        react.createElement("div", {
          className: "deg_mc_modal",
          role: "dialog",
          "aria-modal": "true",
          "aria-labelledby": titleId,
          ref: dialogRef,
          onKeyDown: handleKeyDown,
          // 点弹窗内部不应冒泡到遮罩，避免误关。
          onClick: (event) => event?.stopPropagation?.(),
        },
          react.createElement("div", { className: "deg_mc_modal_header" },
            react.createElement("h3", { className: "deg_mc_modal_title", id: titleId }, "选择要添加的模型"),
            react.createElement("button", {
              type: "button",
              className: "deg_mc_modal_close",
              "aria-label": "关闭",
              "data-deg-dialog-action": "close",
              autoFocus: true,
              onClick: onClose,
            }, "×")),
          react.createElement("p", { className: "deg_mc_modal_description" }, "以下是模型提供方的可用模型，勾选要添加的模型。"),
          react.createElement("div", { className: "deg_mc_candidate_toolbar" },
            react.createElement("input", {
              className: "deg_mc_input deg_mc_candidate_search",
              type: "search",
              value: query,
              placeholder: "搜索模型",
              "aria-label": "搜索模型",
              "data-deg-dialog-action": "search",
              onChange: (event) => onQueryChange(event.target.value),
            }),
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              disabled: visible.length === 0,
              "data-deg-dialog-action": "toggle-visible",
              onClick: () => onToggleVisible(visible.map((candidate) => candidate.id)),
            }, clearsAll ? "取消全选" : "全选")),
          list,
          react.createElement("div", { className: "deg_mc_modal_footer" },
            react.createElement("button", {
              type: "button",
              className: "deg_btn",
              "data-deg-dialog-action": "cancel",
              onClick: onClose,
            }, "取消"),
            react.createElement("button", {
              type: "button",
              className: "deg_btn deg_btn_primary",
              disabled: pickedCount === 0,
              "data-deg-dialog-action": "adopt",
              onClick: onAdopt,
            }, "添加所选"))));
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    ModelDiscoveryDialog, clearsAllCandidateSelection, focusableDialogControls, renderModelRow, bindClientRuntime,
  });
})(globalThis);
