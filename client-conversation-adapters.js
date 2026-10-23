/**
 * conversation 表面适配（图片提交路由 + system-prompt 节点）（R8 票据 27）。
 *
 * 从 client.js 的 descriptor 工厂作用域机械外移：正文逐行保留，只有包装、依赖解构与导出面
 * 是本票据新增的。检查点：globalThis[Symbol.for("dsh-expert-group/client-conversation-adapters")]。
 * 装配顺序见 scripts/client-source-manifest.mjs（恒在唯一 descriptor 之前）。
 */
(function installClientConversationAdapters(global) {
  "use strict";

  const SYMBOL = Symbol.for("dsh-expert-group/client-conversation-adapters");
  // descriptor 注入的运行期依赖：本模块先于 descriptor 执行，取值只发生在运行期调用时。
  let react = null;
  let primitives = null;
  let RPC_PATH = "";
  let RPC_CHANNEL = "";
  let RPC_ENDPOINT = "";
  function bindClientRuntime(host) {
    react = host.react ?? null;
    primitives = host.primitives ?? null;
    RPC_PATH = host.RPC_PATH ?? "";
    RPC_CHANNEL = host.RPC_CHANNEL ?? "";
    RPC_ENDPOINT = host.RPC_ENDPOINT ?? "";
  }

    /**
     * 浏览器 FileReader 的等价字节编码：File.arrayBuffer() 取得原始字节，btoa()
     * 生成与 DSH 原生 serializer 相同的无换行 canonical base64。此处不依赖
     * ConversationController 的 private 方法，也不改变 File 的 MIME/name 元数据。
     */
    async function encodeImageFileForRoute(file) {
      const mediaType = file?.type;
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mediaType)) {
        throw new Error("conversation.sendSession: unsupported image media type");
      }
      if (typeof file?.arrayBuffer !== "function") {
        throw new Error("conversation.sendSession: image File.arrayBuffer is unavailable");
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      // 分块避免大图片展开参数超过浏览器调用栈限制；字节顺序仍与 FileReader 完全一致。
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      const encode = globalThis?.btoa;
      if (typeof encode !== "function") throw new Error("conversation.sendSession: btoa is unavailable");
      return {
        type: "image",
        mediaType,
        data: encode(binary),
        ...(typeof file.name === "string" && file.name !== "" ? { name: file.name } : {}),
      };
    }

    async function encodeImagesForRoute(attachments) {
      return Promise.all(attachments.map((attachment) => encodeImageFileForRoute(attachment.file)));
    }

    /** Host 返回值也必须经过 PNG MIME、canonical base64 与签名校验，才可进入 prompt。 */
    function isPngRouteImage(image) {
      if (!image || typeof image !== "object" || image.mediaType !== "image/png" || typeof image.data !== "string") return false;
      if (image.name !== undefined && typeof image.name !== "string") return false;
      try {
        const decode = globalThis?.atob;
        const encode = globalThis?.btoa;
        if (typeof decode !== "function" || typeof encode !== "function") return false;
        const binary = decode(image.data);
        if (encode(binary) !== image.data || binary.length < 8) return false;
        return [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => binary.charCodeAt(index) === byte);
      } catch {
        return false;
      }
    }

    /**
     * 安全读取运行时方法。DSH 的 traceable Proxy 可能在读取某个兼容 API 时抛错；
     * 单独隔离每次读取，才能让新 API 的 getter 异常继续回退到其他候选方法。
     */
    function readRuntimeMethod(runtime, name) {
      if (runtime === null || runtime === void 0) return undefined;
      try {
        const method = runtime[name];
        return typeof method === "function" ? method : undefined;
      } catch {
        return undefined;
      }
    }

    /**
     * 按有序 id 数组解析草稿附件：先查新 API，再查旧 API；同一顺序同时覆盖
     * sendSession 的 this 与注入的 conversation。返回实际运行时与解析结果，供退休回调
     * 使用同一接收者释放草稿；方法使用 call 保留真实接收者，实际方法抛出的业务异常
     * 不会被误判成能力缺失而再次调用其他 API。
     */
    function resolveDraftAttachmentsCompat(primaryRuntime, fallbackRuntime, ids) {
      const candidates = [
        [primaryRuntime, "resolveDraftAttachments"],
        [fallbackRuntime, "resolveDraftAttachments"],
        [primaryRuntime, "draftImages"],
        [fallbackRuntime, "draftImages"],
      ];
      for (const [runtime, name] of candidates) {
        const method = readRuntimeMethod(runtime, name);
        if (method !== undefined) return { runtime, attachments: method.call(runtime, ids) };
      }
      throw new Error(
        "dsh-expert-group: 当前 DSH 运行时未暴露草稿附件解析 API（resolveDraftAttachments / draftImages），无法提交图片草稿",
      );
    }

    function releaseObservedDraftImages(runtime, attachments, settlement) {
      if (settlement?.reason !== "observed") return;
      if (runtime === null || runtime === void 0) return;
      // 只调用 ConversationController 的公开释放面，且严格按各自契约传参，绝不混用参数形态：
      // - 批量方法（新 releaseDraftAttachments / 旧 releaseDraftImages）接收附件描述符数组；
      // - 单项方法（新 releaseDraftAttachment / 旧 releaseDraftImage）接收单个草稿 id。
      // 释放优先级固定为新批量、新单项、旧批量、旧单项；四种释放面都缺失时静默跳过，
      // 因为此处位于 retirement 回调内，抛出只会在提交结果之后制造二次失败。
      const releaseDraftAttachments = readRuntimeMethod(runtime, "releaseDraftAttachments");
      if (releaseDraftAttachments !== undefined) {
        releaseDraftAttachments.call(runtime, attachments);
        return;
      }
      const releaseDraftAttachment = readRuntimeMethod(runtime, "releaseDraftAttachment");
      if (releaseDraftAttachment !== undefined) {
        attachments.forEach((attachment) => releaseDraftAttachment.call(runtime, attachment.id));
        return;
      }
      const releaseDraftImages = readRuntimeMethod(runtime, "releaseDraftImages");
      if (releaseDraftImages !== undefined) {
        releaseDraftImages.call(runtime, attachments);
        return;
      }
      const releaseDraftImage = readRuntimeMethod(runtime, "releaseDraftImage");
      if (releaseDraftImage !== undefined) {
        attachments.forEach((attachment) => releaseDraftImage.call(runtime, attachment.id));
      }
    }

    function waitForImageSubmissionPaint() {
      return new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => setTimeout(resolve, 0));
        } else {
          setTimeout(resolve, 0);
        }
      });
    }

    // Cordis traceable Proxy 每次读取方法都可能产生新的函数代理；生命周期状态因此放在
    // 跨 HMR 的全局 WeakMap 中，cleanup 只比较自己的 state，不读取 sendSession 做身份判断。
    const IMAGE_ROUTE_STATES_KEY = Symbol.for("dsh-expert-group.image-submission-route-states");
    function imageSubmissionRouteStates() {
      const root = globalThis;
      const existing = root[IMAGE_ROUTE_STATES_KEY];
      if (existing instanceof WeakMap) return existing;
      const states = new WeakMap();
      Object.defineProperty(root, IMAGE_ROUTE_STATES_KEY, {
        value: states,
        configurable: false,
        enumerable: false,
        writable: false,
      });
      return states;
    }

    /**
     * 原生 Composer 没有公开 submit hook，因此在 concrete ConversationController
     * 的 sendSession 边界做幂等包装。只拦截根会话图片；child 仍使用原生路径。
     * Host 先返回真实 PNG encoded image 或完成 Observer 投递，再通过公开
     * Session.beginSubmission/prompt 维护 request id、回显、模式和退休生命周期。
     */
    function installImageSubmissionRoute(ctx) {
      let conversation;
      try { conversation = ctx.get("conversation"); } catch { return () => {}; }
      if (!conversation || typeof conversation.sendSession !== "function") return () => {};
      const states = imageSubmissionRouteStates();
      const existing = states.get(conversation);
      if (existing !== void 0) return existing.cleanup;
      // 只保存一次原生引用；后续 cleanup 不读取 traceable Proxy 的方法身份。
      const original = conversation.sendSession;
      // helper 内联于 route 安装函数，旧测试/旧 Host 即使只提取该函数也能工作。
      const rpcRequest = async (request, init = {}) => {
        const rpc = ctx.connection?.rpc;
        if (typeof rpc?.call === "function") {
          const result = await rpc.call(RPC_CHANNEL, RPC_ENDPOINT, request, init.signal);
          return {
            ok: result?.ok === true,
            status: result?.ok === true ? 200 : 500,
            async json() { return result?.ok === true ? result.value : { ok: false, error: result?.error }; },
          };
        }
        return fetch(RPC_PATH, {
          ...init,
          method: init.method ?? "POST",
          credentials: "same-origin",
          headers: {
            "content-type": "application/json",
            ...(init.headers ?? {}),
            "x-dsh-expert-group-image": "1",
          },
          body: JSON.stringify(request),
        });
      };
      const state = { original, cleanup: void 0, active: true, observerFinalizers: new Set() };
      const wrapped = async function sendSessionWithImageRoute(session, text, imageIds, mode, signal) {
        const sessionSnapshot = session?.getSnapshot?.();
        if (!Array.isArray(imageIds) || imageIds.length === 0 || sessionSnapshot === undefined || sessionSnapshot.subagent != null) {
          return original.call(this, session, text, imageIds, mode, signal);
        }
        // 先在 this 与注入服务中寻找新 API，再寻找旧 API；helper 会保留实际方法接收者，
        // 两者都不具备时给出插件自身的明确错误。
        const resolved = resolveDraftAttachmentsCompat(this, conversation, imageIds);
        const runtime = resolved.runtime;
        const attachments = resolved.attachments;
        if (!Array.isArray(attachments) || attachments.length !== imageIds.length) {
          throw new Error("conversation.sendSession: one or more draft images are no longer available");
        }
        let finishRetirement;
        const retirement = new Promise((resolve) => { finishRetirement = resolve; });
        // DSH 的回显协议使用 mode + attachments；每个图片附件必须包在 type/value
        // 中。这里不能沿用旧的 images 平铺字段，否则非法回显会在聊天槽位读取
        // submission.attachments.map 时让当前会话渲染退化为空白。
        const submission = session.beginSubmission({
          mode,
          text,
          attachments: attachments.map((attachment) => ({
            type: "image",
            value: {
              previewUrl: attachment.previewUrl,
              ...(typeof attachment.file?.name === "string" && attachment.file.name !== "" ? { name: attachment.file.name } : {}),
              ...(attachment.width === undefined ? {} : { width: attachment.width }),
              ...(attachment.height === undefined ? {} : { height: attachment.height }),
            },
          })),
          onRetire: (settlement) => {
            try {
              releaseObservedDraftImages(runtime, attachments, settlement);
            } finally {
              finishRetirement?.(settlement);
            }
          },
        });
        // Observer commit 成功后 Host 会随响应给出一次性 cleanupToken（绑定 session +
        // childId + exact root generation）。这里在 try 之外声明状态与收尾函数，保证
        // prompt 失败返回、抛错、取消以及插件卸载的 catch/cleanup 路径都能看到它。
        let observerCleanup;
        /**
         * 消费 Host 侧的 Observer cleanup token。
         *
         * cancel：失败/取消路径，让 Host 中断刚创建的 child；
         * release：成功 observed 路径，只释放凭据（Host 绝不 interrupt），否则 token 会一直
         * 占到 TTL，连续成功提交 64 次后新的 Observer commit 会被容量拒绝。
         *
         * 两种请求都不复用调用方可能已 aborted 的 signal，且都是尽力而为：失败不改变已经
         * 成功或已经失败的 prompt 结果。
         * @param {string} action - image-route-observer-cancel 或 ...-release。
         */
        const finishObserverChild = (action) => {
          if (observerCleanup === undefined) return;
          const pending = observerCleanup;
          observerCleanup = undefined;
          state.observerFinalizers.delete(pending.finalizer);
          void rpcRequest({
            action,
            sessionId: pending.sessionId,
            childId: pending.childId,
            cleanupToken: pending.cleanupToken,
          }, {}).catch(() => {});
        };
        const cancelObserverChild = () => finishObserverChild("image-route-observer-cancel");
        const releaseObserverChild = () => finishObserverChild("image-route-observer-release");
        try {
          await waitForImageSubmissionPaint();
          const encoded = await encodeImagesForRoute(attachments);
          const response = await rpcRequest({
            action: "image-route", sessionId: session.sessionId, text, images: encoded,
          }, { signal });
          let payload;
          try { payload = await response.json(); } catch { payload = null; }
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error?.message ?? ("图片路由失败（HTTP " + response.status + "）"));
          }
          // TOCTOU 复核：Host 判定能力后我们才 session.prompt，期间用户可能再次切换模型，
          // 导致"能力判定模型"与"实际 prompt 模型"不一致。Host 回传一个不泄露 provider/model
          // 的不透明 routeClaim；任何复核/提交失败都必须 abandon 本次提交（绝不 session.prompt）。
          //
          // main 路径：旧宿主没有 routeClaim 字段时保持既有提交行为（不发校验请求，也不静默
          // 假设"校验通过"）；有 claim 时先校验一次（Host 对 main 的成功校验会消费 claim）。
          //
          // observer 路径是**两阶段**：Host 在 image-route 阶段只签发 claim + 暂存 durable refs，
          // 不会启动 child。客户端必须先 validate（只验证不消费），再 observer-commit
          // （Host 复核当前路由后才真正 admission 并消费 claim）。因此旧宿主（没有 claim 的
          // observer 响应）无法安全提交，必须 fail-closed 而不是退回旧行为。
          const routeClaim = typeof payload.routeClaim === "string" ? payload.routeClaim : "";
          /** 调用一次 Host 的 claim 复核；失败时抛出可诊断错误（不返回成功）。 */
          const assertRouteClaim = async (action) => {
            const checked = await rpcRequest({
              action, sessionId: session.sessionId, routeClaim,
            }, { signal });
            let body;
            try { body = await checked.json(); } catch { body = null; }
            if (!checked.ok || body?.ok !== true) {
              throw new Error(body?.error?.message
                ?? "模型路由在图片提交期间发生变化，已放弃本次图片提交；请重新发送");
            }
          };
          // Observer commit 成功但后续 root prompt 失败/取消时的补偿：commit 响应里的
          // childId/cleanupToken 已在上面登记，这里只需要构造 content。
          let content;
          if (payload.target === "main") {
            if (routeClaim.length > 0) await assertRouteClaim("image-route-validate");
            const images = Array.isArray(payload.images) ? payload.images : [];
            if (images.length !== encoded.length || !images.every(isPngRouteImage)) {
              throw new Error("Host 必须返回与提交数量一致的真实 PNG 图片");
            }
            content = [
              ...images.map((image) => ({ type: "image", mediaType: image.mediaType, data: image.data, name: image.name })),
              ...(text === "" ? [] : [{ type: "text", text }]),
            ];
          } else if (payload.target === "observer") {
            if (routeClaim.length === 0) {
              // 旧 Host 的 observer 响应没有 claim：它会立刻启动 Observer，因此无法保证
              // "能力判定模型 == 实际 prompt 模型"，也无法在提交失败时避免孤儿 child。
              throw new Error("Host 不支持安全的 Observer 图片提交，请升级插件/Host 后重试");
            }
            await assertRouteClaim("image-route-validate");
            // 第二阶段：Host 复核当前路由 → Observer admission → 一次性消费 claim。
            // 失败（路由变化/claim 失效/重复提交/取消）时 Host 不会启动 child，或尽力中断它。
            const committed = await rpcRequest({
              action: "image-route-observer-commit", sessionId: session.sessionId, routeClaim,
            }, { signal });
            let commitBody;
            try { commitBody = await committed.json(); } catch { commitBody = null; }
            if (!committed.ok || commitBody?.ok !== true) {
              throw new Error(commitBody?.error?.message
                ?? "Observer 图片提交未完成，已放弃本次提交；请重新发送");
            }
            // commit 成功即存在真实 child：登记清理 finalizer（成功 observed 时会撤销）。
            const childId = typeof commitBody.childId === "string" ? commitBody.childId : "";
            const cleanupToken = typeof commitBody.cleanupToken === "string" ? commitBody.cleanupToken : "";
            if (childId.length > 0 && cleanupToken.length > 0) {
              const finalizer = () => cancelObserverChild();
              observerCleanup = { sessionId: session.sessionId, childId, cleanupToken, finalizer };
              state.observerFinalizers.add(finalizer);
            }
            // Observer 只收到图片本身并只做视觉分析（自动入口不传用户文字）；根会话提交文字
            // 通知，让原生 retirement 释放浏览器草稿，同时明确告诉主代理：原始用户任务仍在
            // 自己手里，视觉报告会作为上下文反馈回来（由 DSH 的 child 反馈通道送达），不要
            // 把这次提交当成任务已完成。
            const notice = "用户图片已交由 Observer 做纯视觉分析（仅描述图片内容、可见文字、布局、状态与异常；未向 Observer 传递任何用户文字）。Observer 的视觉报告会作为主代理上下文反馈回本会话；请保留用户的原始任务并继续处理，收到视觉报告后再综合，不要把本次提交当作任务已完成。";
            content = [{ type: "text", text: text === "" ? notice : text + "\n" + notice }];
          } else {
            throw new Error("Host 返回了未知的图片路由目标");
          }
          const result = await session.prompt(content, mode, signal, submission.requestId);
          if (!result?.ok) {
            // prompt 未被接受：尽力中断刚创建的 Observer child，避免孤儿反馈。
            cancelObserverChild();
            return { kind: "error" };
          }
          if ((await retirement).reason !== "observed") {
            cancelObserverChild();
            return { kind: "error" };
          }
          // 成功 observed：Observer child 已由 DSH 正常收口，撤销 finalizer 并**释放**
          // Host 侧 cleanup token（release 只释放凭据、绝不 interrupt）。不释放会让 token
          // 一直占到 TTL，连续成功提交填满容量后新的 Observer commit 会被拒绝。
          releaseObserverChild();
          return { kind: "success" };
        } catch (error) {
          // 抛错/取消路径同样尽力中断 Observer child，但保留原始错误语义。
          try { cancelObserverChild(); } catch { /* 尽力而为 */ }
          submission.abandon();
          throw error;
        }
      };
      const cleanup = () => {
        if (!state.active) return;
        state.active = false;
        // 卸载时先尽力中断仍在等待 root prompt 的 Observer child，再恢复原生 sendSession。
        for (const finalizer of [...state.observerFinalizers]) {
          state.observerFinalizers.delete(finalizer);
          try { finalizer(); } catch { /* 尽力而为 */ }
        }
        if (states.get(conversation) !== state) return;
        states.delete(conversation);
        // state 是本次安装的稳定所有权标记；恢复时不比较每次读取都会变化的代理函数。
        conversation.sendSession = original;
      };
      state.cleanup = cleanup;
      states.set(conversation, state);
      conversation.sendSession = wrapped;
      return cleanup;
    }



    /**
     * keyed conversation renderer 只接管 system-prompt，并将原始文本作为 React children 保持完整显示。
     */
    function FullSystemPromptNode(props) {
      const [open, setOpen] = react.useState(false);
      const text = props?.node?.data?.text;
      if (typeof text !== "string") return null;
      return react.createElement(
        primitives.DisclosureRow,
        {
          // 0.1.7-alpha.2 起图标后缀编码的是描边粗细（Regular=1px），渲染尺寸只由 size prop 承载，
          // 因此旧 `*16` 后缀名一律改为 `*Regular`，并保持原有的显式 size。
          icon: react.createElement(primitives.IconBrowseOutlineRegular, { size: 14 }),
          title: "系统提示词",
          open,
          expandable: true,
          expandOnRowClick: true,
          onToggle: () => setOpen((value) => !value),
          className: "deg_full_system_prompt_root",
          chevronClassName: "deg_full_system_prompt_chevron",
        },
        react.createElement(
          "div",
          { className: "deg_full_system_prompt_body" },
          react.createElement("pre", { className: "deg_full_system_prompt" }, text),
        ),
      );
    }


  // 只暴露被后续装配段实际消费的符号（无全量外挂）。
  global[SYMBOL] = Object.freeze({
    installImageSubmissionRoute, FullSystemPromptNode, bindClientRuntime,
  });
})(globalThis);
