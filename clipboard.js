// Wire format: CrossDesk libs/wire/include/web_clipboard_protocol.h.
(function () {
  "use strict";
  const HEADER = 16, CHUNK = 16 * 1024, LIMIT = 128 * 1024;
  const TEXT = 1, APPLIED = 2, REJECTED = 3, BUFFER_LIMIT = 256 * 1024;
  const HELLO = 4, READY = 5, VERSION = 1;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const focused = () => !document.hidden && document.hasFocus();

  class ClipboardSession {
    constructor(peer) {
      this.peer = peer;
      this.channel = null;
      this.closed = false;
      this.state = "waiting";
      this.automatic = true;
      this.readGranted = false;
      this.writeGranted = false;
      this.remoteText = "";
      this.lastLocal = "";
      this.status = "";
      this.feedbackTimer = null;
      this.nextId = 0;
      this.revision = 0;
      this.pasteToken = 0;
      this.pending = null;
      this.incoming = null;
      this.reading = false;
      this.writing = false;
      this.permissionListeners = [];
      this.onBlur = () => { this.revision++; this.cancelPaste(); };
      this.onFocus = () => void this.syncLocal();
      this.onVisibility = () => document.hidden ? this.onBlur() : this.onFocus();
      this.onPointer = () => this.cancelPaste();
      window.addEventListener("blur", this.onBlur);
      window.addEventListener("focus", this.onFocus);
      document.addEventListener("visibilitychange", this.onVisibility);
      document.addEventListener("pointerdown", this.onPointer, true);
      this.notify();
      void this.permissions();
    }

    get ready() { return !this.closed && this.state === "ready" && this.channel?.readyState === "open"; }
    get apiAvailable() { return window.isSecureContext && !!navigator.clipboard; }
    notify() {
      if (this.closed && window.CrossDeskClipboard !== this) return;
      window.CrossDeskClipboard = this;
      window.CrossDeskSessionControls?.renderClipboard(this);
    }
    feedback(message, { manualField, transient = false } = {}) {
      if (this.closed) return;
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
      this.status = message;
      if (transient && message) {
        const timer = setTimeout(() => {
          if (this.closed || this.feedbackTimer !== timer) return;
          this.feedbackTimer = null;
          this.status = "";
          this.notify();
        }, 2000);
        this.feedbackTimer = timer;
      }
      this.notify();
      if (manualField) window.CrossDeskSessionControls?.showClipboardManual?.(manualField);
    }

    async permissions() {
      const generation = this.permissionGeneration = (this.permissionGeneration || 0) + 1;
      for (const [permission, update] of this.permissionListeners) permission.removeEventListener("change", update);
      this.permissionListeners = [];
      // Only persistent grants permit polling. Safari/Firefox may not expose
      // these permissions; their native paste event and explicit buttons work.
      for (const [name, field] of [["clipboard-read", "readGranted"], ["clipboard-write", "writeGranted"]]) {
        try {
          const permission = await navigator.permissions.query({ name });
          if (this.closed || generation !== this.permissionGeneration) return;
          const update = () => { this[field] = permission.state === "granted"; this.notify(); };
          update();
          permission.addEventListener("change", update);
          this.permissionListeners.push([permission, update]);
        } catch (_) {}
      }
    }

    probe() {
      if (this.closed || this.ready || this.probeTimer) return;
      this.probeTimer = setTimeout(() => {
        if (!this.closed && !this.ready) {
          clearInterval(this.helloTimer);
          this.helloTimer = null;
          this.state = "unsupported";
          this.notify();
        }
      }, 8000);
    }

    attach(channel) {
      if (channel.label !== "web-clipboard") return false;
      if (this.closed || this.channel ||
          !channel.ordered || channel.maxRetransmits != null || channel.maxPacketLifeTime != null) {
        channel.close();
        return true;
      }
      this.channel = channel;
      channel.binaryType = "arraybuffer";
      const opened = () => {
        if (this.closed || channel.readyState !== "open" || this.ready || this.helloTimer) return;
        // Transport readiness can precede host authorization. Retry the
        // application handshake until the host accepts clipboard requests.
        clearTimeout(this.probeTimer);
        this.probeTimer = null;
        this.state = "waiting";
        const hello = () => {
          const frame = new Uint8Array(HEADER);
          const view = new DataView(frame.buffer);
          view.setUint32(0, HELLO, true);
          view.setUint32(8, VERSION, true);
          try { channel.send(frame); } catch (_) {}
        };
        this.helloTimer = setInterval(hello, 500);
        this.probe();
        hello();
        this.notify();
      };
      channel.addEventListener("open", opened);
      channel.addEventListener("message", event => this.receive(event.data));
      channel.addEventListener("close", () => this.close());
      channel.addEventListener("error", () => this.close());
      if (channel.readyState === "open") opened();
      return true;
    }

    receive(data) {
      if (this.closed || this.channel?.readyState !== "open" || !(data instanceof ArrayBuffer)) return;
      if (data.byteLength < HEADER || data.byteLength > HEADER + CHUNK) { this.incoming = null; return; }
      const view = new DataView(data);
      const kind = view.getUint32(0, true), id = view.getUint32(4, true);
      const total = view.getUint32(8, true), offset = view.getUint32(12, true);
      if (kind === READY && !id && total === VERSION && !offset && data.byteLength === HEADER) {
        clearTimeout(this.probeTimer);
        clearInterval(this.helloTimer);
        this.helloTimer = null;
        this.state = "ready";
        if (!this.timer) this.timer = setInterval(() => void this.syncLocal(), 500);
        this.notify();
        return;
      }
      if (!this.ready) return;
      if ((kind === APPLIED || kind === REJECTED) && data.byteLength === HEADER && !total && !offset) {
        if (this.pending?.id !== id) return;
        const pending = this.pending;
        this.pending = null;
        clearTimeout(pending.timer);
        if (kind === APPLIED) pending.resolve();
        else pending.reject(new Error("远端未能写入剪贴板，请重试。"));
        this.notify();
        return;
      }
      const bytes = new Uint8Array(data, HEADER);
      if (kind !== TEXT || id !== 0 || !total || total > LIMIT || !bytes.length ||
          offset > total || bytes.length > total - offset || bytes.includes(0)) {
        this.incoming = null; return;
      }
      if (offset === 0) this.incoming = { bytes: new Uint8Array(total), offset: 0 };
      const incoming = this.incoming;
      if (!incoming || incoming.bytes.length !== total || incoming.offset !== offset) {
        this.incoming = null; return;
      }
      incoming.bytes.set(bytes, offset);
      incoming.offset += bytes.length;
      if (incoming.offset !== total) return;
      this.incoming = null;
      try { this.remoteText = decoder.decode(incoming.bytes); } catch (_) { return; }
      this.revision++;
      this.feedback("远端文本已就绪", { transient: true });
      if (this.automatic && this.writeGranted && focused()) void this.writeRemote(false);
    }

    async sendText(text) {
      if (!this.ready) throw new Error("剪贴板尚未连接，请更新被控端后重新连接。");
      if (this.pending) throw new Error("正在同步剪贴板，请稍后重试。");
      const bytes = encoder.encode(text);
      if (!bytes.length) throw new Error("剪贴板中没有文本。");
      if (bytes.length > LIMIT) throw new Error("剪贴板文本超过 128 KiB。");
      if (bytes.includes(0)) throw new Error("文本包含不支持的空字符。");
      if (this.channel.bufferedAmount > BUFFER_LIMIT) throw new Error("网络繁忙，请稍后重试。");
      const maximum = this.peer.sctp?.maxMessageSize;
      const chunk = Math.min(CHUNK, maximum > 0 ? maximum - HEADER : CHUNK);
      if (chunk <= 0) throw new Error("当前连接无法发送剪贴板。");
      const id = this.nextId = (this.nextId + 1) >>> 0 || 1;
      const acknowledgement = new Promise((resolve, reject) => {
        this.pending = { id, resolve, reject, timer: setTimeout(() => {
          if (this.pending?.id !== id) return;
          this.pending = null;
          reject(new Error("等待远端写入剪贴板超时，请重试。"));
          this.notify();
        }, 5000) };
      });
      this.pending.promise = acknowledgement;
      try {
        for (let offset = 0; offset < bytes.length; offset += chunk) {
          const part = bytes.subarray(offset, offset + chunk);
          const frame = new Uint8Array(HEADER + part.length), view = new DataView(frame.buffer);
          [TEXT, id, bytes.length, offset].forEach((value, i) => view.setUint32(i * 4, value, true));
          frame.set(part, HEADER);
          this.channel.send(frame);
        }
      } catch (_) {
        clearTimeout(this.pending?.timer);
        this.pending?.reject(new Error("剪贴板发送失败，请重新连接后重试。"));
        this.pending = null;
      }
      this.notify();
      await acknowledgement;
    }

    async sendLocal() {
      if (!this.apiAvailable) { this.feedback("请在手动输入框中粘贴文本", { manualField: "send" }); return; }
      const revision = this.revision;
      try {
        const text = await navigator.clipboard.readText();
        if (!this.ready || revision !== this.revision || !focused()) return;
        await this.sendText(text);
        if (!this.closed && revision === this.revision) this.lastLocal = text;
        this.feedback("已发送到远端", { transient: true });
      } catch (error) { this.feedback(error.name === "NotAllowedError"
        ? "无法读取剪贴板，请手动粘贴文本" : error.message,
        { manualField: error.name === "NotAllowedError" ? "send" : undefined }); }
    }

    async toggleAutomatic() {
      if (this.automatic) { this.automatic = false; this.revision++; this.notify(); return; }
      if (!this.apiAvailable) { this.feedback("自动同步需要 HTTPS 或 localhost 以及浏览器剪贴板权限。"); return; }
      this.automatic = true;
      this.notify();
      await this.sendLocal(); // The permission request starts in the click gesture.
      if (!this.closed) {
        // Query again for browsers that grant permission on the first read.
        await this.permissions();
        this.notify();
      }
    }

    async syncLocal() {
      if (!this.ready || !this.automatic || !this.readGranted || !focused() ||
          this.reading || this.writing || this.pending) return;
      this.reading = true;
      const revision = this.revision;
      try {
        const text = await navigator.clipboard.readText();
        if (!this.ready || !this.automatic || !focused() || revision !== this.revision || this.writing) return;
        if (text && text !== this.lastLocal) {
          await this.sendText(text);
          if (!this.closed && revision === this.revision) this.lastLocal = text;
          this.feedback("已同步本机文本到远端。", { transient: true });
        }
      } catch (error) {
        this.automatic = false;
        this.feedback(error.name === "NotAllowedError" ? "自动同步已暂停，请使用手动发送或复制。" : error.message);
      } finally { this.reading = false; }
    }

    async writeRemote(manual = true) {
      if (!this.ready || !this.remoteText || this.writing || !focused()) return;
      if (!this.apiAvailable) { this.feedback("请选中远端文本后复制", { manualField: "receive" }); return; }
      this.writing = true;
      let text;
      try {
        do {
          text = this.remoteText;
          await navigator.clipboard.writeText(text);
          if (this.closed) return;
          this.lastLocal = text;
        } while (this.remoteText !== text && this.automatic && this.writeGranted && focused());
        this.feedback("已复制到本机", { transient: true });
      } catch (_) {
        if (!manual) this.writeGranted = false;
        this.feedback("无法写入剪贴板，请选中文本后复制", { manualField: manual ? "receive" : undefined });
      } finally { this.writing = false; }
    }

    cancelPaste() { this.pasteToken++; this.pasteKeys = null; }

    handleKeyDown(event) {
      if (!this.ready) return false;
      const key = event.keyCode || event.which;
      const paste = (key === 86 && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) ||
        (key === 45 && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey);
      if (!paste) {
        this.cancelPaste();
        if (this.releasedForPaste) {
          const control = window.CrossDeskControl;
          // Releasing the remote modifiers while waiting must not break the
          // next shortcut when the user is still physically holding Ctrl/Cmd.
          for (const [modifier, held] of [[17, event.ctrlKey], [91, event.metaKey], [16, event.shiftKey], [18, event.altKey]]) {
            if (held && key !== modifier && !control.pressedKeyboardKeys.has(modifier)) {
              control.pressedKeyboardKeys.add(modifier);
              control.sendKeyboardAction(modifier, true);
            }
          }
          this.releasedForPaste = false;
        }
        return false;
      }
      if (event.repeat) { event.preventDefault(); return true; }
      this.pasteKeys = key === 45 ? [16, 45] : [event.metaKey ? 91 : 17, 86];
      this.releasedForPaste = true;
      window.CrossDeskControl.releaseKeyboardKeys();
      if (this.apiAvailable && this.readGranted) {
        event.preventDefault();
        const keys = this.pasteKeys, token = ++this.pasteToken;
        void navigator.clipboard.readText().then(text => this.pasteText(text, keys, token))
          .catch(() => this.feedback("无法读取本机剪贴板，请使用剪贴板菜单发送文本。"));
      }
      // Otherwise allow the trusted browser paste event to supply the text.
      return true;
    }

    handlePaste(event) {
      const control = window.CrossDeskControl;
      if (!this.ready || !control.isChannelOpen() || control.isLocalKeyboardTarget(event.target)) return false;
      event.preventDefault();
      const keys = this.pasteKeys || [17, 86];
      const token = ++this.pasteToken;
      control.releaseKeyboardKeys();
      void this.pasteText(event.clipboardData?.getData("text/plain") || "", keys, token);
      return true;
    }

    async pasteText(text, keys, token) {
      if (!this.ready || token !== this.pasteToken || !focused()) return;
      const revision = this.revision;
      try {
        if (this.pending) await this.pending.promise;
        if (!this.ready || token !== this.pasteToken || !focused()) return;
        await this.sendText(text);
        if (!this.closed && revision === this.revision) this.lastLocal = text;
        const control = window.CrossDeskControl;
        if (!this.ready || token !== this.pasteToken || !focused() ||
            !control.isChannelOpen() || control.isLocalKeyboardTarget(document.activeElement)) return;
        control.releaseKeyboardKeys();
        for (const key of keys) control.sendKeyboardAction(key, true);
        for (const key of [...keys].reverse()) control.sendKeyboardAction(key, false);
        this.feedback("已发送并粘贴到远端。", { transient: true });
      } catch (error) { this.feedback(error.message); }
    }

    close() {
      if (this.closed) return;
      this.closed = true;
      this.state = "closed";
      this.automatic = false;
      this.revision++;
      this.cancelPaste();
      clearInterval(this.timer);
      clearInterval(this.helloTimer);
      clearTimeout(this.probeTimer);
      clearTimeout(this.feedbackTimer);
      this.feedbackTimer = null;
      clearTimeout(this.pending?.timer);
      this.pending?.reject(new Error("剪贴板连接已断开。"));
      this.pending = this.incoming = null;
      this.remoteText = this.lastLocal = this.status = "";
      window.removeEventListener("blur", this.onBlur);
      window.removeEventListener("focus", this.onFocus);
      document.removeEventListener("visibilitychange", this.onVisibility);
      document.removeEventListener("pointerdown", this.onPointer, true);
      for (const [permission, update] of this.permissionListeners) permission.removeEventListener("change", update);
      this.permissionListeners = [];
      this.notify();
    }
  }
  window.CrossDeskClipboardSession = ClipboardSession;
})();
