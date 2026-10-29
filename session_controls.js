// Floating controls follow the shared Android/iOS session interaction.
(function () {
  const control = window.CrossDeskControl;
  const session = window.CrossDeskSession;
  const byId = (id) => document.getElementById(id);
  const orb = byId("panel-collapsed-bar");
  const panel = byId("connected-panel");
  const shield = byId("session-menu-shield");
  if (!orb || !panel || !shield || !control || !session) return;
  const clamp = (n, min, max) => Math.max(min, Math.min(n, Math.max(min, max)));
  const pageTitles = { main: "远程控制", video: "画面设置", network: "网络状态",
    display: "显示器", files: "文件传输", clipboard: "剪贴板", disconnect: "断开连接" };
  const preferenceDetails = [
    "优先保持画面流畅，带宽或编码压力较大时会更积极地降低分辨率。",
    "优先保持较高分辨率，带宽不足时先降低帧率，保持画面清晰。",
    "兼顾清晰度和流畅度，在持续压力下逐步降低分辨率。",
  ];

  class SessionControls {
    constructor() {
      this.active = false;
      this.connected = false;
      this.videoReady = false;
      this.page = "main";
      this.orbPosition = null;
      this.keyboardPosition = null;
      this.mouseVisible = false;
      this.drag = null;
      this.suppressClick = false;
      this.fileRows = new Map();
      this.bindEvents();
      this.renderSettings(null);
      this.setConnected(false);
      this.renderFiles(window.CrossDeskFiles);
      this.renderClipboard(window.CrossDeskClipboard);
    }

    // Fixed overlays use the visual viewport so browser chrome, zoom and safe
    // areas cannot leave their close buttons outside the usable screen.
    bounds() {
      const viewport = window.visualViewport;
      const style = getComputedStyle(byId("connected-overlay"));
      const inset = (side) => parseFloat(style.getPropertyValue(`--safe-${side}`)) || 0;
      const left = (viewport?.offsetLeft || 0) + inset("left") + 8;
      const top = (viewport?.offsetTop || 0) + inset("top") + 8;
      return { left, top,
        right: (viewport?.offsetLeft || 0) + (viewport?.width || innerWidth) - inset("right") - 8,
        bottom: (viewport?.offsetTop || 0) + (viewport?.height || innerHeight) - inset("bottom") - 8 };
    }

    place(element, x, y, bounds = this.bounds()) {
      const position = { x: clamp(x, bounds.left, bounds.right - element.offsetWidth),
        y: clamp(y, bounds.top, bounds.bottom - element.offsetHeight) };
      Object.assign(element.style, { left: `${position.x}px`, top: `${position.y}px`,
        right: "auto", bottom: "auto", transform: "none" });
      return position;
    }

    layout() {
      if (!this.active) return;
      const b = this.bounds(), width = b.right - b.left, height = b.bottom - b.top;
      const pos = this.orbPosition || { x: b.right - 58, y: b.top + 9 };
      this.orbPosition = this.place(orb, pos.x, pos.y, b);
      const rect = orb.getBoundingClientRect();
      const landscape = height < 400 && width >= 400;
      panel.classList.toggle("session-landscape", landscape);
      panel.style.width = `${Math.min(width, landscape ? 380 : Math.max(280, Math.min(340, width - 144)))}px`;
      panel.style.maxHeight = `${height}px`;
      if (!panel.hidden) {
        const leftSide = rect.left + rect.width / 2 > (b.left + b.right) / 2;
        this.place(panel, leftSide ? rect.left - panel.offsetWidth - 12 : rect.right + 12,
          rect.top + rect.height / 2 - panel.offsetHeight / 2, b);
      }
      const mouse = byId("virtual-mouse");
      if (mouse.style.display !== "none") {
        let x = rect.left - mouse.offsetWidth - 6, y = rect.top + 3;
        if (x < b.left) x = rect.right + 6;
        if (x + mouse.offsetWidth > b.right) {
          x = rect.left;
          y = rect.bottom + 6 + mouse.offsetHeight <= b.bottom
            ? rect.bottom + 6 : rect.top - mouse.offsetHeight - 6;
        }
        this.place(mouse, x, y, b);
      }
      const keyboard = byId("virtual-keyboard");
      keyboard.style.width = `${Math.min(800, width)}px`;
      keyboard.style.maxHeight = `${height}px`;
      keyboard.style.setProperty("--keyboard-height", `${height}px`);
      if (keyboard.style.display !== "none") {
        const kp = this.keyboardPosition || { x: b.left + (width - keyboard.offsetWidth) / 2,
          y: b.bottom - keyboard.offsetHeight };
        this.keyboardPosition = this.place(keyboard, kp.x, kp.y, b);
      }
    }

    start() {
      this.active = true;
      this.videoReady = false;
      this.mouseVisible = false;
      this.orbPosition = null;
      this.keyboardPosition = null;
      control.setMouseMode("relative");
      control.hideVirtualKeyboard();
      this.close();
    }

    stop() {
      this.endDrag(null, true);
      this.close();
      this.active = false;
      this.videoReady = false;
      this.mouseVisible = false;
      this.setConnected(false);
      control.hideVirtualKeyboard();
      control.cancelLocalInput();
      this.updateMouse();
    }

    setConnected(connected) {
      this.connected = connected;
      panel.querySelectorAll("[data-needs-connection]").forEach(button => button.disabled = !connected);
      if (!connected) {
        control.cancelLocalInput();
        control.hideVirtualKeyboard();
      }
      this.updateMouse();
    }

    setVideoReady() {
      if (!this.active) return;
      this.videoReady = true;
      this.updateMouse();
    }

    showPage(page) {
      if (!pageTitles[page]) return;
      control.cancelLocalInput();
      control.lockedPanel.closeMenu();
      this.page = page;
      panel.hidden = false;
      shield.hidden = false;
      orb.setAttribute("aria-expanded", "true");
      byId("session-menu-title").textContent = pageTitles[page];
      byId("session-menu-back").hidden = page === "main";
      byId("disconnect-connected").hidden = page === "disconnect" || page === "clipboard";
      panel.querySelectorAll("[data-session-page]").forEach(el => el.hidden = el.dataset.sessionPage !== page);
      if (page === "disconnect") control.hideVirtualKeyboard();
      if (page === "files" || page === "clipboard") {
        // Native pickers and editable text need the browser's regular pointer.
        if (document.pointerLockElement) document.exitPointerLock?.();
        if (page === "files") orb.classList.remove("has-file-updates");
      }
      this.updateMouse();
      this.renderSettings(window.CrossDeskVideoSettings);
      this.renderNetwork(window.CrossDeskStats);
      this.renderFiles(window.CrossDeskFiles);
      this.renderClipboard(window.CrossDeskClipboard);
      (page === "disconnect" ? byId("session-disconnect-cancel") : byId("session-menu-close")).focus({ preventScroll: true });
    }

    close() {
      control.lockedPanel.closeMenu();
      panel.hidden = true;
      shield.hidden = true;
      orb.setAttribute("aria-expanded", "false");
      this.page = "main";
      this.updateMouse();
      if (panel.contains(document.activeElement)) orb.focus({ preventScroll: true });
    }

    updateMouse() {
      const visible = this.active && this.connected && this.videoReady && this.mouseVisible && panel.hidden;
      byId("virtual-mouse").style.display = visible ? "flex" : "none";
      byId("session-mouse-label").textContent = this.mouseVisible ? "收起鼠标" : "虚拟鼠标";
      byId("session-mouse").setAttribute("aria-pressed", String(this.mouseVisible));
      byId("session-mouse-mode-label").textContent = control.state.mobileControlMode === "relative" ? "相对鼠标" : "绝对鼠标";
      this.layout();
    }

    renderClipboard(clipboard) {
      const ready = clipboard?.ready;
      const state = byId("clipboard-state");
      state.hidden = !!ready;
      state.textContent = ready ? "" : clipboard?.state === "unsupported"
        ? "被控端不支持剪贴板同步，仍可正常远控" : clipboard?.closed ? "连接已断开" : "正在连接…";
      byId("clipboard-automatic").disabled = !ready;
      byId("clipboard-automatic").setAttribute("aria-checked", String(!!ready && !!clipboard?.automatic));
      byId("clipboard-permissions").hidden = !ready;
      byId("clipboard-permissions").textContent = !ready ? "" : clipboard?.automatic
        ? (!clipboard.readGranted || !clipboard.writeGranted)
          ? "权限受限，可手动发送或复制" : "在此页面自动同步复制的文本"
        : "开启后，在此页面同步复制的文本";
      byId("clipboard-send-local").disabled = !ready || !!clipboard.pending;
      byId("clipboard-send-text").disabled = !ready || !!clipboard.pending;
      byId("clipboard-copy-remote").disabled = !ready || !clipboard.remoteText;
      const remote = byId("clipboard-remote"), text = clipboard?.remoteText || "";
      if (remote.value !== text) remote.value = text;
      if (clipboard?.closed || this.clipboardSession !== clipboard) {
        byId("clipboard-local").value = "";
        byId("clipboard-manual").open = false;
      }
      this.clipboardSession = clipboard;
      byId("clipboard-feedback").textContent = clipboard?.status || "";
      if (this.page === "clipboard") this.layout();
    }

    showClipboardManual(field) {
      byId("clipboard-manual").open = true;
      this.layout();
      if (this.page === "clipboard" && !panel.hidden)
        byId(field === "receive" ? "clipboard-remote" : "clipboard-local").focus();
    }

    renderSettings(state) {
      const selection = state?.selection || session.defaultVideoSettings;
      panel.querySelectorAll("[data-setting]").forEach(button => {
        button.disabled = !state?.supported;
        button.setAttribute("aria-pressed", String(selection[button.dataset.setting] === Number(button.dataset.value)));
      });
      byId("video-preference-detail").textContent = preferenceDetails[selection.preference];
      const failed = ["failed", "rejected", "timeout"].includes(state?.status);
      byId("video-settings-feedback").textContent = !state?.supported
        ? "连接建立后可调整，需被控端支持。"
        : failed ? "调整失败，请重试。" : state.status === "pending" ? "正在应用…" : "";
      byId("video-settings-retry").hidden = !failed || !state?.supported;
      this.layout();
    }

    renderNetwork(stats) {
      if (panel.hidden || this.page !== "network") return;
      const finite = (value, suffix) => Number.isFinite(value) ? `${Math.round(value)}${suffix}` : "—";
      const values = {
        resolution: stats?.width && stats.height ? `${stats.width} × ${stats.height}` : "—",
        fps: finite(stats?.fps, " fps"),
        bitrate: Number.isFinite(stats?.received_bps) ? `${(stats.received_bps / 1000000).toFixed(2)} Mbps` : "—",
        loss: stats?.packets > 0 ? `${(stats.lost / stats.packets * 100).toFixed(1)}%` : "—",
        rtt: finite(stats?.rtt_ms, " ms"), buffer: finite(stats?.jitter_ms, " ms"),
        decode: finite(stats?.decode_ms, " ms"),
        route: stats?.route === "relay" ? `中继${stats.protocol ? " / " + stats.protocol.toUpperCase() : ""}`
          : stats?.route === "direct" ? "直连" : "—",
      };
      for (const [key, value] of Object.entries(values)) byId(`network-${key}`).textContent = value;
      this.layout();
    }

    renderFiles(files) {
      const format = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
        ? `${(bytes / 1024).toFixed(1)} KiB` : bytes < 1024 * 1024 * 1024
        ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
      const labels = { queued: "排队中", sending: "发送中", receiving: "接收中", saving: "正在保存",
        completed: "已完成", cancelled: "已取消", failed: "失败" };
      const items = files?.items || [], list = byId("file-transfer-list");
      if (!items.length) orb.classList.remove("has-file-updates");
      const busy = items.filter(item => ["queued", "sending", "receiving", "saving"].includes(item.status)).length;
      byId("session-files-label").textContent = busy ? `文件传输 (${busy})` : "文件传输";
      byId("file-transfer-select").disabled = !files?.ready;
      byId("file-transfer-storage").textContent = !files || files.canWriteFiles
        ? "接收文件边传输边保存到浏览器下载目录。保存位置沿用浏览器设置。"
        : "当前页面无法流式接收，请使用支持 Service Worker 的浏览器，通过 HTTPS 或 localhost 打开；仍可发送文件。";
      byId("file-transfer-status").hidden = !!files?.ready;
      byId("file-transfer-status").textContent = files?.ready ? ""
        : files?.state === "unsupported" ? "被控端暂不支持与 Web 控制端传输文件，请升级被控端客户端。"
        : files?.state === "closed" ? "文件通道已断开，请重新连接。" : "等待文件通道连接…";
      byId("file-transfer-feedback").textContent = files?.error || "";
      byId("file-transfer-empty").hidden = items.length > 0;
      for (const [item, row] of this.fileRows) if (!items.includes(item)) {
        row.element.remove();
        this.fileRows.delete(item);
      }
      for (const item of items) {
        let row = this.fileRows.get(item);
        if (!row) {
          const element = document.createElement("li");
          element.className = "file-transfer-item";
          const header = document.createElement("div");
          header.className = "file-transfer-header";
          const name = document.createElement("strong"), detail = document.createElement("p");
          name.textContent = item.name;
          name.title = item.name;
          const progress = document.createElement("progress");
          progress.max = 1;
          progress.setAttribute("aria-label", `${item.name} 传输进度`);
          const actions = document.createElement("div");
          actions.className = "file-transfer-actions";
          const cancel = document.createElement("button"), remove = document.createElement("button");
          cancel.type = remove.type = "button";
          cancel.textContent = "取消";
          remove.className = "file-transfer-remove";
          remove.textContent = "×";
          remove.setAttribute("aria-label", "移除");
          remove.title = "移除";
          cancel.addEventListener("click", () => files.cancel(item));
          remove.addEventListener("click", () => files.remove(item));
          header.append(name, remove);
          actions.append(cancel);
          element.append(header, detail, progress, actions);
          list.append(element);
          row = { element, detail, progress, actions, cancel, remove, status: null };
          this.fileRows.set(item, row);
        }
        if (item.direction === "receive" && row.status !== item.status &&
            (panel.hidden || this.page !== "files") && ["receiving", "completed"].includes(item.status))
          orb.classList.add("has-file-updates");
        row.status = item.status;
        const running = ["queued", "sending", "receiving", "saving"].includes(item.status);
        row.detail.textContent = `${item.direction === "send" ? "发送" : "接收"} · ${labels[item.status]} · ${format(item.bytes)} / ${format(item.total)}${item.detail ? " · " + item.detail : ""}`;
        row.progress.value = item.status === "completed" ? 1 : item.total ? item.bytes / item.total : 0;
        row.actions.hidden = !running;
        row.cancel.hidden = !running;
        row.remove.hidden = running;
      }
      orb.setAttribute("aria-label", orb.classList.contains("has-file-updates")
        ? "远程控制菜单，有新接收文件" : "远程控制菜单");
      this.layout();
    }

    beginDrag(event, target) {
      if (event.target.closest("#keyboard-close") || (event.button !== undefined && event.button !== 0) || this.drag) return;
      const touch = event.touches?.[0];
      if (event.touches && event.touches.length !== 1) return;
      const point = touch || event, rect = target.getBoundingClientRect();
      if (touch) event.preventDefault();
      control.cancelLocalInput();
      this.drag = { target, touchId: touch?.identifier, x: point.clientX, y: point.clientY,
        left: rect.left, top: rect.top, moved: false };
      this.suppressClick = false;
    }

    moveDrag(event) {
      const drag = this.drag;
      if (!drag) return;
      const point = drag.touchId === undefined ? event : Array.from(event.touches || []).find(t => t.identifier === drag.touchId);
      if (!point || !Number.isFinite(point.clientX)) return;
      const dx = point.clientX - drag.x, dy = point.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      event.preventDefault();
      drag.moved = true;
      control.setDraggingPanel(true);
      if (drag.target === orb) this.close();
      const position = this.place(drag.target, drag.left + dx, drag.top + dy);
      if (drag.target === orb) this.orbPosition = position;
      else this.keyboardPosition = position;
      this.layout();
    }

    endDrag(event, cancelled = false) {
      const drag = this.drag;
      if (!drag) return;
      if (event?.changedTouches && !Array.from(event.changedTouches).some(t => t.identifier === drag.touchId)) return;
      this.drag = null;
      control.setDraggingPanel(false);
      this.suppressClick = drag.moved || cancelled;
      if (drag.touchId !== undefined && !drag.moved && !cancelled && drag.target === orb) {
        this.toggle();
        this.suppressClick = true;
      }
    }

    toggle() {
      if (panel.hidden) this.showPage("main");
      else this.close();
    }

    bindEvents() {
      orb.addEventListener("click", () => {
        if (this.suppressClick) { this.suppressClick = false; return; }
        this.toggle();
      });
      for (const target of [orb, byId("keyboard-header")]) {
        const draggable = target === orb ? orb : byId("virtual-keyboard");
        target.addEventListener("mousedown", event => this.beginDrag(event, draggable));
        target.addEventListener("touchstart", event => this.beginDrag(event, draggable), { passive: false });
      }
      document.addEventListener("mousemove", event => this.moveDrag(event));
      document.addEventListener("touchmove", event => this.moveDrag(event), { passive: false });
      document.addEventListener("mouseup", event => this.endDrag(event, event.crossdeskPointerCancelled));
      document.addEventListener("touchend", event => this.endDrag(event));
      document.addEventListener("touchcancel", event => this.endDrag(event, true));
      window.addEventListener("blur", () => { this.endDrag(null, true); control.cancelLocalInput(); });
      document.addEventListener("visibilitychange", () => {
        if (document.hidden) { this.endDrag(null, true); control.cancelLocalInput(); }
      });
      window.addEventListener("resize", () => this.layout());
      window.visualViewport?.addEventListener("resize", () => this.layout());
      window.visualViewport?.addEventListener("scroll", () => this.layout());
      shield.addEventListener("click", () => this.close());
      byId("session-menu-close").addEventListener("click", () => this.close());
      byId("session-menu-back").addEventListener("click", () => this.showPage("main"));
      byId("clipboard-manual").addEventListener("toggle", () => this.layout());
      byId("clipboard-automatic").addEventListener("click", () => void window.CrossDeskClipboard?.toggleAutomatic());
      byId("clipboard-send-local").addEventListener("click", () => void window.CrossDeskClipboard?.sendLocal());
      byId("clipboard-copy-remote").addEventListener("click", () => void window.CrossDeskClipboard?.writeRemote());
      byId("clipboard-send-text").addEventListener("click", async () => {
        const clipboard = window.CrossDeskClipboard;
        if (!clipboard?.ready) return;
        try {
          await clipboard.sendText(byId("clipboard-local").value);
          clipboard.feedback("已发送到远端", { transient: true });
        } catch (error) { clipboard.feedback(error.message); }
      });
      byId("file-transfer-select").addEventListener("click", () => {
        if (!window.CrossDeskFiles?.ready) return;
        control.cancelLocalInput();
        this.filePickerSession = window.CrossDeskFiles;
        byId("file-transfer-input").click();
      });
      byId("file-transfer-input").addEventListener("change", event => {
        // A picker can outlive a disconnect or a connection to another host.
        if (this.filePickerSession === window.CrossDeskFiles)
          this.filePickerSession?.enqueue(Array.from(event.target.files || []));
        this.filePickerSession = null;
        event.target.value = "";
      });
      panel.querySelectorAll("[data-page]").forEach(button => button.addEventListener("click", () => this.showPage(button.dataset.page)));
      panel.querySelectorAll("[data-setting]").forEach(button => button.addEventListener("click", () => {
        const settings = window.CrossDeskVideoSettings;
        if (!settings?.supported) return;
        session.requestVideoSettings({ ...settings.selection, [button.dataset.setting]: Number(button.dataset.value) });
      }));
      byId("video-settings-retry").addEventListener("click", () => {
        const values = window.CrossDeskVideoSettings?.requested;
        if (values) session.requestVideoSettings(values);
      });
      byId("session-keyboard").addEventListener("click", () => {
        this.close(); control.toggleVirtualKeyboard(); this.layout();
      });
      byId("session-mouse").addEventListener("click", () => {
        control.cancelLocalInput(); this.mouseVisible = !this.mouseVisible; this.close();
      });
      byId("session-mouse-mode").addEventListener("click", () => {
        const mode = control.state.mobileControlMode === "relative" ? "absolute" : "relative";
        control.setMouseMode(mode);
        this.updateMouse();
      });
      byId("session-disconnect-cancel").addEventListener("click", () => this.showPage("main"));
      byId("session-disconnect-confirm").addEventListener("click", () => session.disconnect());
      document.addEventListener("keydown", event => {
        if (panel.hidden || !this.active) return;
        if (event.key === "Escape") {
          event.preventDefault();
          this.page === "main" ? this.close() : this.showPage("main");
        } else if (event.key === "Tab") {
          const buttons = [...panel.querySelectorAll("button:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, a[href]")]
            .filter(el => el.getClientRects().length && (el.tagName === "SUMMARY" || !el.closest("details:not([open])")));
          const i = buttons.indexOf(document.activeElement), next = (i + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
          event.preventDefault(); buttons[next]?.focus();
        }
      });
    }
  }
  window.CrossDeskSessionControls = new SessionControls();
})();
