(function () {
  const ControlType = {
    mouse: 0,
    keyboard: 1,
    audio_capture: 2,
    host_infomation: 3,
    display_id: 4,
  };

  const MouseFlag = {
    move: 0,
    left_down: 1,
    left_up: 2,
    right_down: 3,
    right_up: 4,
    middle_down: 5,
    middle_up: 6,
    wheel_vertical: 7,
    wheel_horizontal: 8,
  };

  const TAP_MAX_DURATION = 300;
  const TAP_MOVE_TOLERANCE = 10;

  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const isTextInput = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  };

  const LOCAL_CONTROLS = "#connected-panel, #panel-collapsed-bar, #session-menu-shield, #virtual-mouse, #virtual-keyboard, .locked-select-menu";

  // Pointer Lock targets the video even when the page cursor is over local UI.
  // Route only status-panel gestures here, keeping their press/release ownership
  // separate from remote mouse buttons.
  class LockedPanelController {
    constructor(control) {
      this.control = control;
      this.press = null;
      this.hover = null;
      this.inside = false;
      this.menu = null;
      for (const type of ["mousedown", "mousemove", "mouseup", "click",
        "dblclick", "auxclick", "contextmenu"]) {
        document.addEventListener(type, (event) => {
          if (control.state.pointerLocked && event.target === control.elements.video) {
            event.preventDefault();
            event.stopImmediatePropagation();
          }
        }, { capture: true });
      }
    }

    target() {
      const pos = this.control.state.lockedPointerPos;
      if (!pos) return null;
      const hit = document.elementFromPoint?.(pos.x, pos.y);
      if (!hit?.closest(LOCAL_CONTROLS)) return null;
      const target = hit.closest("button, select, input, a, #panel-collapsed-bar, #keyboard-header");
      return target || hit;
    }

    emit(type, target, event = {}, cancelled = false) {
      const pos = this.control.state.lockedPointerPos || { x: 0, y: 0 };
      const mouse = new MouseEvent(type, {
        bubbles: !["mouseenter", "mouseleave"].includes(type),
        cancelable: true,
        clientX: pos.x, clientY: pos.y,
        button: event.button ?? 0, buttons: event.buttons ?? 0,
        ctrlKey: event.ctrlKey, shiftKey: event.shiftKey,
        altKey: event.altKey, metaKey: event.metaKey,
      });
      if (cancelled) mouse.crossdeskPointerCancelled = true;
      target.dispatchEvent(mouse);
    }

    setHover(target) {
      const inside = !!(target || this.menu || this.press);
      if (this.hover === target && this.inside === inside) return;
      if (this.hover !== target) {
        this.hover?.classList.remove("pointer-lock-hover");
        target?.classList.add("pointer-lock-hover");
        this.hover = target;
      }
      const panel = document.getElementById("connected-panel");
      panel?.classList.toggle("pointer-lock-within", inside);
      if (inside !== this.inside) {
        this.inside = inside;
        if (panel) this.emit(inside ? "mouseenter" : "mouseleave", panel);
        if (!inside && this.control.state.pointerLocked) {
          this.control.elements.video?.focus({ preventScroll: true });
        }
      }
    }

    down(event) {
      if (this.control.pressedMouseButtons.size) return false;
      if (this.press) return true;
      const target = this.target();
      if (this.menu && !this.menu.element.contains(target)) {
        this.closeMenu();
        event.preventDefault();
        return true;
      }
      if (!target) return false;
      event.preventDefault();
      if (event.button !== 0 || target.matches(":disabled")) return true;
      this.control.releaseKeyboardKeys();
      this.press = { target, ...this.control.state.lockedPointerPos, dragged: false };
      target.classList.add("pointer-lock-active");
      target.focus?.({ preventScroll: true });
      this.emit("mousedown", target, event);
      return true;
    }

    move(event) {
      if (this.control.pressedMouseButtons.size) {
        this.setHover(null);
        return false;
      }
      const target = this.target();
      this.setHover(target);
      if (this.press) {
        const pos = this.control.state.lockedPointerPos;
        this.press.dragged ||= Math.abs(pos.x - this.press.x) > 5 ||
          Math.abs(pos.y - this.press.y) > 5;
      }
      const recipient = this.press?.target || target;
      if (recipient) this.emit("mousemove", recipient, event);
      return !!(recipient || this.menu);
    }

    up(event) {
      if (!this.press) return false;
      // The browser can clear the lock before pointerlockchange is delivered.
      if (document.pointerLockElement !== this.control.elements.video) {
        this.reset();
        return true;
      }
      if (event.button !== 0) return true;
      event.preventDefault();
      const press = this.press;
      const target = this.target();
      this.press = null;
      press.target.classList.remove("pointer-lock-active");
      this.emit("mouseup", press.target, event);
      if (!press.dragged && press.target === target && target.isConnected) {
        if (target.tagName === "SELECT") this.openMenu(target);
        else this.emit("click", target, event);
      }
      this.setHover(this.control.state.pointerLocked ? this.target() : null);
      return true;
    }

    wheel(event) {
      const target = this.target();
      if (!target && !this.menu && !this.press) return false;
      event.preventDefault();
      if (this.menu && this.menu.element.contains(target)) {
        const scale = event.deltaMode === 1 ? 16 :
          event.deltaMode === 2 ? this.menu.element.clientHeight : 1;
        this.menu.element.scrollTop += event.deltaY * scale;
      } else {
        const scroll = target?.closest(".session-menu-body, .keyboard-layout");
        if (scroll) scroll.scrollTop += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1);
      }
      return true;
    }

    openMenu(select) {
      this.closeMenu();
      if (select.disabled) return;
      const menu = document.createElement("div");
      menu.className = "locked-select-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", select.labels?.[0]?.textContent || "选择");
      const buttons = [];
      for (const [index, option] of Array.from(select.options).entries()) {
        if (option.hidden) continue;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "locked-select-option";
        button.textContent = option.label;
        button.disabled = option.disabled || !!option.parentElement.disabled;
        button.setAttribute("role", "option");
        button.setAttribute("aria-selected", String(option.selected));
        button.addEventListener("click", () => {
          const changed = select.selectedIndex !== index;
          select.selectedIndex = index;
          this.closeMenu();
          if (changed) {
            select.dispatchEvent(new Event("input", { bubbles: true }));
            select.dispatchEvent(new Event("change", { bubbles: true }));
          }
        });
        menu.appendChild(button);
        if (!button.disabled) buttons.push(button);
      }
      menu.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.closeMenu();
        } else if (["ArrowDown", "ArrowUp", "Home", "End", "Tab"].includes(event.key)) {
          const step = event.key === "ArrowUp" || (event.key === "Tab" && event.shiftKey) ? -1 : 1;
          const current = buttons.indexOf(document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 :
            (current + step + buttons.length) % buttons.length;
          buttons[next]?.focus();
          buttons[next]?.scrollIntoView({ block: "nearest" });
        } else return;
        event.preventDefault();
      });
      document.body.appendChild(menu);
      this.menu = { element: menu, select };
      const rect = select.getBoundingClientRect();
      menu.style.minWidth = `${Math.min(Math.max(160, rect.width), window.innerWidth - 16)}px`;
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - bounds.width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - bounds.height - 8))}px`;
      const selected = buttons.find(button => button.getAttribute("aria-selected") === "true") || buttons[0];
      selected?.focus({ preventScroll: true });
      selected?.scrollIntoView({ block: "nearest" });
      this.setHover(select);
    }

    closeMenu() {
      if (!this.menu) return;
      this.menu.element.remove();
      this.menu = null;
      this.control.elements.video?.focus({ preventScroll: true });
    }

    reset() {
      if (this.press) {
        const target = this.press.target;
        this.press = null;
        target.classList.remove("pointer-lock-active");
        this.emit("mouseup", target, {}, true);
      }
      this.closeMenu();
      this.setHover(null);
    }
  }

  class ControlManager {
    constructor() {
      this.dataChannel = null;
      this.motionChannel = null;
      this.inputProtocol = false;
      this.inputEpoch = 0;
      this.inputSequence = 0;
      this.pendingMotion = null;
      this.motionTimer = null;
      this.lastMotionAt = 0;
      this.elements = {
        video: document.getElementById("video"),
        mediaContainer: document.getElementById("media"),
        videoContainer: document.getElementById("video-container"),
        virtualMouse: document.getElementById("virtual-mouse"),
        virtualLeftBtn: document.getElementById("virtual-left-btn"),
        virtualRightBtn: document.getElementById("virtual-right-btn"),
        virtualScrollUp: document.getElementById("virtual-scroll-up"),
        virtualScrollDown: document.getElementById("virtual-scroll-down"),
        virtualKeyboard: document.getElementById("virtual-keyboard"),
        keyboardClose: document.getElementById("keyboard-close"),
      };

      this.pressedMouseButtons = new Set();
      this.pressedKeyboardKeys = new Set();
      this.lockedCursor = null;

      this.virtualKeyTimers = new Map(); // Store timers for each key element
      this.virtualScrollTimers = new Map(); // Store timers for scroll buttons

      this.state = {
        pointerLocked: false,
        pointerLockFailed: false,
        lockedPointerPos: null,
        normalizedPos: { x: 0.5, y: 0.5 },
        lastPointerPos: null,
        lastWheelAt: 0,
        draggingPanel: false, // Track if status panel is being dragged
        pointerLockToastTimer: null,
        videoRect: null,
        gestureActive: false,
        gestureButton: null,
        gestureStart: null,
        isMobile: false,
        mobileControlMode: "relative", // "absolute" or "relative"
        touchGesture: null,
        touchLastPos: null,
        desktopPointerCalibrated: false,
        // Pinch zoom state
        pinchZoomActive: false,
        initialPinchDistance: 0,
        initialScale: 1.0,
        currentScale: 1.0,
        lastDoubleTapTime: 0,
        // Pan state (for dragging zoomed image)
        initialPinchCenter: null,
        initialTranslateX: 0,
        initialTranslateY: 0,
        currentTranslateX: 0,
        currentTranslateY: 0,
      };

      this.lockedPanel = new LockedPanelController(this);

      this.onPointerLockChange = this.onPointerLockChange.bind(this);
      this.onPointerLockError = this.onPointerLockError.bind(this);
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.onPointerCancel = this.onPointerCancel.bind(this);
      this.onWheel = this.onWheel.bind(this);

      this.onTouchStart = this.onTouchStart.bind(this);
      this.onTouchMove = this.onTouchMove.bind(this);
      this.onTouchEnd = this.onTouchEnd.bind(this);
      this.onVirtualLeftStart = this.onVirtualLeftStart.bind(this);
      this.onVirtualRightStart = this.onVirtualRightStart.bind(this);
      this.onVirtualButtonMove = this.onVirtualButtonMove.bind(this);
      this.onVirtualButtonEnd = this.onVirtualButtonEnd.bind(this);

      this.init();
    }

    init() {
      const { video } = this.elements;
      if (!video) {
        console.warn("CrossDeskControl: video element not found");
        return;
      }

      video.style.pointerEvents = "auto";
      video.tabIndex = 0;

      this.bindPointerLockEvents();
      this.bindPointerListeners();
      this.bindKeyboardListeners();
      this.setupVirtualMouse();
      this.setupVirtualKeyboard();
    }

    setDataChannel(channel) {
      if (channel !== this.dataChannel) {
        this.cancelLocalInput();
        this.lockedPanel.reset();
        if (!channel && this.state.pointerLocked) {
          document.exitPointerLock?.();
          this.resetLockedPointer();
        }
        this.state.pointerLockFailed = false;
        this.state.lastPointerPos = null;
        this.state.desktopPointerCalibrated = false;
        this.clearPendingMotion();
        this.motionChannel = null;
        this.inputProtocol = false;
        this.inputEpoch = 0;
        this.inputSequence = 0;
      }
      this.dataChannel = channel;
    }

    setMotionChannel(channel) {
      this.clearPendingMotion();
      this.motionChannel = channel;
      // Keep epochs on the reliable channel if motion temporarily closes.
      if (channel) this.inputProtocol = true;
    }

    clearPendingMotion() {
      if (this.motionTimer !== null) clearTimeout(this.motionTimer);
      this.motionTimer = null;
      this.pendingMotion = null;
    }

    sendMotion(action) {
      this.pendingMotion = action;
      if (this.motionTimer !== null) return;
      const flush = () => {
        this.motionTimer = null;
        const channel = this.motionChannel;
        if (!this.pendingMotion || channel?.readyState !== "open") return;
        if (channel.bufferedAmount > 512) {
          this.motionTimer = setTimeout(flush, 16);
          return;
        }
        const latest = this.pendingMotion;
        this.pendingMotion = null;
        try {
          channel.send(JSON.stringify({ ...latest,
            _input_epoch: this.inputEpoch, _input_seq: ++this.inputSequence }));
          this.lastMotionAt = Date.now();
        } catch (err) {
          // The next position supersedes a failed datagram; never queue old moves.
        }
      };
      const wait = Math.max(0, 16 - (Date.now() - this.lastMotionAt));
      if (wait) this.motionTimer = setTimeout(flush, wait);
      else flush();
    }

    isChannelOpen() {
      return this.dataChannel && this.dataChannel.readyState === "open";
    }

    send(action) {
      if (!this.isChannelOpen()) return false;
      try {
        // Button/key/display actions form barriers across the reliable and
        // motion streams. Their coordinates supersede pending older motion.
        if (this.inputProtocol) {
          this.clearPendingMotion();
          action = { ...action, _input_epoch: ++this.inputEpoch,
            _input_seq: ++this.inputSequence };
        }
        const payload = JSON.stringify(action);
        this.dataChannel.send(payload);
        return true;
      } catch (err) {
        console.error("CrossDeskControl: failed to send action", err);
        return false;
      }
    }

    sendMouseAction({ x, y, flag, scroll = 0 }) {
      // Don't send mouse events while dragging UI elements
      if (this.isDraggingAnyElement()) {
        return;
      }

      const numericFlag =
        typeof flag === "string"
          ? (MouseFlag[flag] ?? MouseFlag.move)
          : flag | 0;

      const action = {
        type: ControlType.mouse,
        mouse: {
          x: clamp01(x),
          y: clamp01(y),
          s: scroll | 0,
          flag: numericFlag,
        },
      };

      if (numericFlag === MouseFlag.move && this.motionChannel?.readyState === "open") {
        this.sendMotion(action);
      } else if (numericFlag !== MouseFlag.move ||
                 !(this.dataChannel?.bufferedAmount > 16384)) {
        this.send(action);
      }
    }

    sendKeyboardAction(keyValue, isDown) {
      const action = {
        type: ControlType.keyboard,
        keyboard: {
          key_value: keyValue | 0,
          flag: isDown ? 0 : 1,
        },
      };
      this.send(action);
    }

    sendAudioCapture(enabled) {
      const action = {
        type: ControlType.audio_capture,
        audio_capture: !!enabled,
      };
      this.send(action);
    }

    sendDisplayId(id) {
      // 确保 id 是有效数字
      const numericId =
        typeof id === "number" && Number.isFinite(id) ? id : parseInt(id, 10);
      if (isNaN(numericId) || !Number.isFinite(numericId)) {
        console.warn("sendDisplayId: Invalid display_id:", id);
        return;
      }
      const action = {
        type: ControlType.display_id,
        display_id: numericId | 0,
      };
      this.send(action);
    }

    sendRawMessage(raw) {
      if (!this.isChannelOpen()) return false;
      try {
        this.dataChannel.send(raw);
        return true;
      } catch (err) {
        console.error("CrossDeskControl: failed to send raw message", err);
        return false;
      }
    }

    bindPointerLockEvents() {
      document.addEventListener("pointerlockchange", this.onPointerLockChange);
      document.addEventListener("pointerlockerror", this.onPointerLockError);
      window.addEventListener?.("resize", () => {
        this.lockedPanel.closeMenu();
        if (this.state.pointerLocked) this.updateLockedPointer(0, 0);
      });
      window.addEventListener?.("blur", () => {
        this.releaseMouseButtons();
        this.releaseKeyboardKeys();
        this.lockedPanel.reset();
      });
      document.addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key === "Escape") {
          document.exitPointerLock?.();
        }
      });
    }

    onPointerLockChange() {
      this.state.pointerLocked =
        document.pointerLockElement === this.elements.video;
      if (this.state.pointerLocked) {
        this.state.pointerLockFailed = false;
        this.ensureVideoRect();
        this.updateLockedPointer(0, 0);
      } else {
        this.releaseMouseButtons();
        this.releaseKeyboardKeys();
        this.resetLockedPointer();
        this.state.videoRect = null;
        if (this.state.mobileControlMode === "relative") this.showPointerLockToast(
          "已退出鼠标锁定，点击远程画面重新锁定",
          3000,
        );
      }
    }

    resetLockedPointer() {
      this.lockedPanel.reset();
      this.state.pointerLocked = false;
      this.state.lockedPointerPos = null;
      if (this.lockedCursor) this.lockedCursor.style.display = "none";
    }

    getPointerPosition(event) {
      return this.state.pointerLocked && this.state.lockedPointerPos
        ? this.state.lockedPointerPos
        : { x: event.clientX, y: event.clientY };
    }

    updateLockedPointer(dx, dy) {
      this.ensureVideoRect();
      const rect = this.state.videoRect;
      if (!rect) return;
      const previous = this.state.lockedPointerPos || {
        x: rect.left + this.state.normalizedPos.x * rect.width,
        y: rect.top + this.state.normalizedPos.y * rect.height,
      };
      // Keep a viewport position independent of the remote desktop's bounds.
      // Pointer Lock's clientX/clientY remain frozen at the initial click.
      const pos = {
        x: Math.max(0, Math.min(
          window.innerWidth - 1,
          previous.x + (Number.isFinite(dx) ? dx : 0),
        )),
        y: Math.max(0, Math.min(
          window.innerHeight - 1,
          previous.y + (Number.isFinite(dy) ? dy : 0),
        )),
      };
      this.state.lockedPointerPos = pos;
      const showCursor = !!this.lockedPanel.press || !!this.lockedPanel.target() ||
        !this.isInsideVideo(pos.x, pos.y) || this.isInsidePanel(pos.x, pos.y);
      if (showCursor && !this.lockedCursor) {
        this.lockedCursor = document.createElement("div");
        this.lockedCursor.className = "locked-pointer-cursor";
        this.lockedCursor.setAttribute("aria-hidden", "true");
        document.body.appendChild(this.lockedCursor);
      }
      if (this.lockedCursor) {
        this.lockedCursor.style.display = showCursor ? "block" : "none";
        this.lockedCursor.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      }
    }

    releaseMouseButtons() {
      for (const button of this.pressedMouseButtons) {
        this.sendMouseAction({
          ...this.state.normalizedPos,
          flag: this.buttonToFlag(button, false),
        });
      }
      this.pressedMouseButtons.clear();
      this.state.lastPointerPos = null;
    }

    releaseKeyboardKeys() {
      for (const key of this.pressedKeyboardKeys) this.sendKeyboardAction(key, false);
      this.pressedKeyboardKeys.clear();
    }

    isLocalKeyboardTarget(target) {
      return isTextInput(target) ||
        !!target?.closest?.(LOCAL_CONTROLS) ||
        document.getElementById("panel-collapsed-bar")?.getAttribute?.("aria-expanded") === "true" ||
        (this.state.pointerLocked && !!(this.lockedPanel.press ||
          this.lockedPanel.menu || this.lockedPanel.target()));
    }

    onPointerLockError() {
      if (this.state.pointerLocked || !this.isChannelOpen()) return;
      if (!this.state.pointerLockFailed) {
        this.showPointerLockToast("鼠标锁定未成功，已切换普通鼠标控制", 2500);
      }
      this.state.pointerLockFailed = true;
    }

    bindPointerListeners() {
      const { video } = this.elements;
      if (!video) return;

      try {
        video.style.touchAction = "none";
      } catch (err) {}

      video.addEventListener("pointerdown", this.onPointerDown, {
        passive: false,
      });
      document.addEventListener("pointermove", this.onPointerMove, {
        passive: false,
      });
      document.addEventListener("pointerup", this.onPointerUp, {
        passive: false,
      });
      document.addEventListener("pointercancel", this.onPointerCancel);
      video.addEventListener("wheel", this.onWheel, { passive: false });

      // Use one touch stream for taps, pointer movement, and pinch zoom.
      // Pointer events from the same fingers are ignored to avoid duplicate clicks.
      video.addEventListener("touchstart", this.onTouchStart, {
        passive: false,
      });
      document.addEventListener("touchmove", this.onTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onTouchEnd, {
        passive: false,
      });
      document.addEventListener("touchcancel", this.onTouchEnd, {
        passive: false,
      });
    }

    onPointerDown(event) {
      if (event.pointerType === "touch" || !this.isChannelOpen()) return;

      const button = typeof event.button === "number" ? event.button : 0;
      if (button < 0 || button > 2) return;
      if (this.state.pointerLocked && this.lockedPanel.down(event)) return;
      const { x, y } = this.getPointerPosition(event);
      this.ensureVideoRect();
      if (this.state.draggingPanel || this.isInsidePanel(x, y) ||
          !this.isInsideVideo(x, y)) return;

      event.preventDefault?.();
      this.elements.video.focus?.({ preventScroll: true });
      this.updateNormalizedFromClient(x, y);
      if (!this.state.pointerLocked) {
        this.state.lastPointerPos = { x, y };
        // Save the real click before Pointer Lock freezes client coordinates.
        this.state.lockedPointerPos = { x, y };
        if (!this.state.desktopPointerCalibrated) {
          this.state.desktopPointerCalibrated = true;
          this.sendMouseAction({
            ...this.state.normalizedPos,
            flag: MouseFlag.move,
          });
        }
        if (this.state.mobileControlMode === "relative") this.requestPointerLock();
        if (event.pointerId != null) {
          try {
            this.elements.video.setPointerCapture(event.pointerId);
          } catch (err) {
            // The pointer may have been locked or cancelled in the meantime.
          }
        }
      }

      this.pressedMouseButtons.add(button);
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: this.buttonToFlag(button, true),
      });
    }

    onPointerMove(event) {
      if (event.pointerType === "touch") return;
      if (this.state.pointerLocked) {
        this.updateLockedPointer(event.movementX, event.movementY);
        if (this.lockedPanel.move(event)) return;
      }
      if (this.isDraggingAnyElement() || this.state.pinchZoomActive) return;
      if (!this.state.pointerLocked && !this.state.lastPointerPos &&
          !this.state.pointerLockFailed && this.state.mobileControlMode !== "absolute") return;

      const { x, y } = this.getPointerPosition(event);
      this.ensureVideoRect();
      if (!this.state.videoRect) return;
      // An existing remote drag can reach the edge and must still be released
      // outside the video. Hovering over letterboxing never controls the host.
      if (!this.pressedMouseButtons.size &&
          (this.isInsidePanel(x, y) || !this.isInsideVideo(x, y))) return;
      if (!this.state.pointerLocked) this.state.lastPointerPos = { x, y };
      this.updateNormalizedFromClient(x, y);
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: MouseFlag.move,
      });
    }

    onPointerUp(event) {
      if (event.pointerType === "touch") return;
      if (this.state.pointerLocked && this.lockedPanel.up(event)) return;
      const button = typeof event.button === "number" ? event.button : 0;
      // A press in the black border or local UI must not release/click remotely.
      if (!this.pressedMouseButtons.delete(button)) return;
      const { x, y } = this.getPointerPosition(event);
      this.ensureVideoRect();
      this.updateNormalizedFromClient(x, y);
      try {
        this.elements.video?.releasePointerCapture?.(event.pointerId ?? 0);
      } catch (err) {
        // Pointer Lock or cancellation may already have released capture.
      }
      this.state.lastPointerPos = null;
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: this.buttonToFlag(button, false),
      });
    }

    onPointerCancel(event) {
      if (event.pointerType === "touch") return;
      this.lockedPanel.reset();
      this.releaseMouseButtons();
    }

    onWheel(event) {
      if (this.state.pointerLocked && this.lockedPanel.wheel(event)) return;
      const now = Date.now();
      if (now - this.state.lastWheelAt < 50) return;
      this.state.lastWheelAt = now;
      const { x, y } = this.getPointerPosition(event);
      this.ensureVideoRect();
      if (this.isInsidePanel(x, y) || !this.isInsideVideo(x, y)) return;
      this.updateNormalizedFromClient(x, y);

      const isHorizontalWheel = event.deltaY === 0;
      const scrollDelta = isHorizontalWheel ? event.deltaX : -event.deltaY;
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: isHorizontalWheel
          ? MouseFlag.wheel_horizontal
          : MouseFlag.wheel_vertical,
        // Browser deltaY is positive when scrolling down; the host uses up.
        scroll: scrollDelta,
      });
      event.preventDefault();
    }

    onTouchStart(event) {
      if (!event.changedTouches?.length || this.isDraggingAnyElement()) return;
      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      const touches = Array.from(event.changedTouches);
      if (
        touches.some((touch) =>
          this.isInsidePanel(touch.clientX, touch.clientY) ||
          !this.isInsideVideo(touch.clientX, touch.clientY),
        )
      ) {
        if (this.state.touchGesture) this.state.touchGesture.cancelled = true;
        return;
      }

      event.preventDefault();
      if (!this.state.touchGesture) {
        this.state.touchGesture = {
          startedAt: Date.now(),
          points: new Map(),
          moved: false,
          cancelled: this.state.gestureActive,
        };
        const touch = touches[0];
        this.state.touchLastPos = { x: touch.clientX, y: touch.clientY };
        if (this.state.mobileControlMode === "absolute") {
          this.updateNormalizedFromClient(touch.clientX, touch.clientY);
          this.sendMouseAction({
            ...this.state.normalizedPos,
            flag: MouseFlag.move,
          });
        }
      }
      const gesture = this.state.touchGesture;
      for (const touch of touches) {
        gesture.points.set(touch.identifier, {
          x: touch.clientX,
          y: touch.clientY,
        });
      }
      if (
        gesture.points.size > 2 ||
        Array.from(event.touches).some((touch) => !gesture.points.has(touch.identifier))
      ) {
        gesture.cancelled = true;
      }

      if (gesture.points.size > 1) {
        this.state.touchLastPos = null;
        this.state.lastDoubleTapTime = 0;
        this.onPinchStart(event);
      }
    }

    updateTouchGesture(touches) {
      const gesture = this.state.touchGesture;
      if (!gesture) return;
      for (const touch of Array.from(touches)) {
        const start = gesture.points.get(touch.identifier);
        if (!start) {
          gesture.cancelled = true;
          continue;
        }
        if (
          Math.hypot(touch.clientX - start.x, touch.clientY - start.y) >
          TAP_MOVE_TOLERANCE
        ) {
          gesture.moved = true;
          gesture.cancelled = true;
        }
        if (
          this.isInsidePanel(touch.clientX, touch.clientY) ||
          !this.isInsideVideo(touch.clientX, touch.clientY)
        ) {
          gesture.cancelled = true;
        }
      }
      if (this.isDraggingAnyElement() || this.state.gestureActive) {
        gesture.cancelled = true;
      }
    }

    onTouchMove(event) {
      const gesture = this.state.touchGesture;
      if (!gesture) return;
      event.preventDefault();
      this.ensureVideoRect();
      if (!this.state.videoRect) return;
      this.updateTouchGesture(event.touches);

      // Do not resume single-finger movement until every finger has lifted.
      if (gesture.points.size > 1) {
        if (
          gesture.moved && event.touches.length === 2 &&
          Array.from(event.touches).every((touch) => gesture.points.has(touch.identifier))
        ) {
          this.onPinchMove(event);
        }
        return;
      }

      const touch = Array.from(event.touches).find((touch) =>
        gesture.points.has(touch.identifier),
      );
      if (
        !touch || this.isDraggingAnyElement() ||
        this.isInsidePanel(touch.clientX, touch.clientY)
      ) return;

      if (this.state.mobileControlMode === "absolute") {
        if (!this.isInsideVideo(touch.clientX, touch.clientY)) return;
        this.updateNormalizedFromClient(touch.clientX, touch.clientY);
      } else if (this.state.touchLastPos) {
        const deltaX = touch.clientX - this.state.touchLastPos.x;
        const deltaY = touch.clientY - this.state.touchLastPos.y;
        this.state.normalizedPos.x = clamp01(
          this.state.normalizedPos.x + deltaX / this.state.videoRect.width,
        );
        this.state.normalizedPos.y = clamp01(
          this.state.normalizedPos.y + deltaY / this.state.videoRect.height,
        );
      }
      this.state.touchLastPos = { x: touch.clientX, y: touch.clientY };
      this.sendMouseAction({ ...this.state.normalizedPos, flag: MouseFlag.move });
    }

    onTouchEnd(event) {
      const gesture = this.state.touchGesture;
      if (!gesture) return;
      this.ensureVideoRect();
      this.updateTouchGesture(event.changedTouches);
      if (!Array.from(event.changedTouches).some((touch) =>
        gesture.points.has(touch.identifier),
      )) return;

      event.preventDefault();
      this.updateTouchGesture(event.touches);
      if (event.type === "touchcancel") gesture.cancelled = true;
      this.onPinchEnd(event);
      if (Array.from(event.touches).some((touch) =>
        gesture.points.has(touch.identifier),
      )) return;

      this.state.touchGesture = null;
      this.state.touchLastPos = null;
      const now = Date.now();
      if (gesture.cancelled || now - gesture.startedAt > TAP_MAX_DURATION) {
        this.state.lastDoubleTapTime = 0;
        return;
      }

      // Wait for all fingers so a two-finger tap never sends a left click first.
      const button = gesture.points.size === 2 ? 2 : 0;
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: this.buttonToFlag(button, true),
      });
      this.sendMouseAction({
        ...this.state.normalizedPos,
        flag: this.buttonToFlag(button, false),
      });

      if (button === 0) {
        if (
          this.state.lastDoubleTapTime &&
          now - this.state.lastDoubleTapTime < 300
        ) {
          this.resetZoom();
          this.state.lastDoubleTapTime = 0;
        } else {
          this.state.lastDoubleTapTime = now;
        }
      }
    }

    buttonToFlag(button, isDown) {
      const mapping = {
        0: { down: MouseFlag.left_down, up: MouseFlag.left_up },
        1: { down: MouseFlag.middle_down, up: MouseFlag.middle_up },
        2: { down: MouseFlag.right_down, up: MouseFlag.right_up },
      };
      const record = mapping[button] || mapping[0];
      return isDown ? record.down : record.up;
    }

    requestPointerLock() {
      const video = this.elements.video;
      if (typeof video?.requestPointerLock !== "function") {
        this.onPointerLockError();
        return;
      }
      const channel = this.dataChannel;
      const onFailure = () => {
        if (this.dataChannel === channel) this.onPointerLockError();
      };
      try {
        // Older browsers return void; newer ones can reject asynchronously.
        video.requestPointerLock()?.catch?.(onFailure);
      } catch (err) {
        onFailure();
      }
    }

    ensureVideoRect() {
      const { video } = this.elements;
      if (!video) return;
      this.state.videoRect = this.getRenderedVideoContentRect(video);
    }

    getRenderedVideoContentRect(video) {
      const rect = video.getBoundingClientRect();
      const videoWidth = video.videoWidth || 0;
      const videoHeight = video.videoHeight || 0;
      if (!videoWidth || !videoHeight || !rect.width || !rect.height) {
        return rect;
      }

      const objectFit = window.getComputedStyle?.(video).objectFit || "fill";
      if (objectFit !== "contain" && objectFit !== "scale-down") {
        return rect;
      }

      // object-fit: contain can leave letterbox space inside the element.
      const containScale = Math.min(
        rect.width / videoWidth,
        rect.height / videoHeight,
      );
      const scale =
        objectFit === "scale-down" ? Math.min(1, containScale) : containScale;
      const width = videoWidth * scale;
      const height = videoHeight * scale;

      const left = rect.left + (rect.width - width) / 2;
      const top = rect.top + (rect.height - height) / 2;

      return {
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
      };
    }

    isInsideVideo(clientX, clientY) {
      const rect = this.state.videoRect;
      if (!rect) return false;
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    }

    isInsidePanel(clientX, clientY) {
      const hit = document.elementFromPoint?.(clientX, clientY);
      if (hit?.closest?.(LOCAL_CONTROLS)) return true;
      const panel = document.getElementById("connected-panel");
      if (!panel || panel.hidden) return false;
      const rect = panel.getBoundingClientRect();
      return clientX >= rect.left && clientX <= rect.right &&
        clientY >= rect.top && clientY <= rect.bottom;
    }

    updateNormalizedFromClient(clientX, clientY) {
      if (!this.state.videoRect) return;
      this.state.normalizedPos = {
        x: clamp01(
          (clientX - this.state.videoRect.left) / this.state.videoRect.width,
        ),
        y: clamp01(
          (clientY - this.state.videoRect.top) / this.state.videoRect.height,
        ),
      };
    }

    bindKeyboardListeners() {
      document.addEventListener(
        "keydown",
        (event) => {
          if (!this.isChannelOpen()) return;
          if (this.isLocalKeyboardTarget(event.target)) return;
          if (window.CrossDeskClipboard?.handleKeyDown(event)) return;

          if (event.cancelable) {
            event.preventDefault();
          }

          if (event.repeat) return;
          const key = event.keyCode ?? 0;
          this.pressedKeyboardKeys.add(key);
          this.sendKeyboardAction(key, true);
        },
        { capture: true },
      );

      document.addEventListener(
        "keyup",
        (event) => {
          if (!this.isChannelOpen()) return;
          const key = event.keyCode ?? 0;
          if (!this.pressedKeyboardKeys.delete(key)) return;

          if (event.cancelable) {
            event.preventDefault();
          }

          this.sendKeyboardAction(key, false);
        },
        { capture: true },
      );
    }

    setMouseMode(mode) {
      if (mode !== "absolute" && mode !== "relative") return;
      this.cancelLocalInput();
      this.state.mobileControlMode = mode;
      this.state.lastPointerPos = null;
      this.state.pointerLockFailed = false;
      if (mode === "absolute" && this.state.pointerLocked) document.exitPointerLock?.();
    }

    setupVirtualMouse() {
      const isDesktop = window.matchMedia(
        "(hover: hover) and (pointer: fine)",
      ).matches;

      this.state.isMobile = !isDesktop;

      this.elements.virtualLeftBtn?.addEventListener(
        "touchstart",
        this.onVirtualLeftStart,
        { passive: false },
      );
      this.elements.virtualRightBtn?.addEventListener(
        "touchstart",
        this.onVirtualRightStart,
        { passive: false },
      );
      document.addEventListener("touchmove", this.onVirtualButtonMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onVirtualButtonEnd, {
        passive: false,
      });
      document.addEventListener("touchcancel", this.onVirtualButtonEnd, {
        passive: false,
      });

      for (const [button, direction] of [[this.elements.virtualScrollUp, "up"],
        [this.elements.virtualScrollDown, "down"]]) {
        if (!button) continue;
        for (const type of ["mousedown", "touchstart", "mouseup", "mouseleave", "touchend", "touchcancel"]) {
          button.addEventListener(type, event => {
            event.preventDefault();
            this.handleVirtualScrollPress(button, direction,
              type === "mousedown" || type === "touchstart");
          }, { passive: false });
        }
      }

      // The session orb positions the mouse bar; its own header drags the keyboard.
      const mouseTouch = event => ({ touches: [{ clientX: event.clientX, clientY: event.clientY }],
        preventDefault: () => event.preventDefault() });
      for (const [button, start] of [[this.elements.virtualLeftBtn, this.onVirtualLeftStart],
        [this.elements.virtualRightBtn, this.onVirtualRightStart]]) {
        button?.addEventListener("mousedown", event => {
          if (event.button === 0) start(mouseTouch(event));
        });
      }
      document.addEventListener("mousemove", event => {
        if (this.state.gestureActive) this.onVirtualButtonMove(mouseTouch(event));
      });
      document.addEventListener("mouseup", event => {
        if (event.button === 0) this.onVirtualButtonEnd(event);
      });

    }

    setupVirtualKeyboard() {
      // Keyboard header buttons
      if (this.elements.keyboardClose) {
        this.elements.keyboardClose.addEventListener("click", () => {
          this.hideVirtualKeyboard();
        });
      }

      // Bind keyboard key events
      const keyboardKeys = document.querySelectorAll(".keyboard-key");
      keyboardKeys.forEach((key) => {
        const handleKeyDown = (e) => {
          e.preventDefault();
          this.handleVirtualKeyPress(key, true);
        };
        const handleKeyUp = (e) => {
          e.preventDefault();
          this.handleVirtualKeyPress(key, false);
          // Remove focus after a short delay to ensure it happens after all event handlers
          setTimeout(() => {
            if (document.activeElement === key) {
              key.blur();
            }
            // Force remove any inline styles that might persist
            key.style.backgroundColor = "";
            key.style.transform = "";
            key.style.boxShadow = "";
          }, 0);
        };

        key.addEventListener("mousedown", handleKeyDown);
        key.addEventListener("mouseup", handleKeyUp);
        key.addEventListener("mouseleave", handleKeyUp);
        key.addEventListener("touchstart", handleKeyDown, { passive: false });
        key.addEventListener("touchend", handleKeyUp, { passive: false });
        key.addEventListener("touchcancel", handleKeyUp, { passive: false });

        // Store key element reference for cleanup
        key._keyboardKeyRef = key;
      });
    }

    toggleVirtualKeyboard() {
      if (!this.elements.virtualKeyboard) return;
      const isVisible = this.elements.virtualKeyboard.style.display !== "none";
      if (isVisible) {
        this.hideVirtualKeyboard();
      } else {
        this.showVirtualKeyboard();
      }
    }

    showVirtualKeyboard() {
      if (!this.elements.virtualKeyboard) return;
      this.elements.virtualKeyboard.style.display = "block";
    }

    hideVirtualKeyboard() {
      this.releaseVirtualKeys();
      if (!this.elements.virtualKeyboard) return;
      this.elements.virtualKeyboard.style.display = "none";
    }

    handleVirtualKeyPress(keyElement, isDown) {
      if (isDown && !this.isChannelOpen()) return;
      const keyCode = parseInt(keyElement.getAttribute("data-keycode"), 10);
      if (isNaN(keyCode)) return;

      if (isDown) {
        // Clear any existing timer for this key
        this.stopRepeat(this.virtualKeyTimers, keyElement);

        // Send initial keydown
        this.sendKeyboardAction(keyCode, true);

        // Visual feedback - pressed state
        keyElement.style.backgroundColor = "rgba(180, 180, 180, 0.95)";
        keyElement.style.transform = "scale(0.92)";
        keyElement.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.3)";

        // Store timer info for this key
        const timerInfo = {
          longPressTimer: null,
          repeatTimer: null,
        };

        // Set up long press detection
        timerInfo.longPressTimer = setTimeout(() => {
          // After 300ms, start repeating
          timerInfo.repeatTimer = setInterval(() => {
            if (this.isChannelOpen()) {
              this.sendKeyboardAction(keyCode, true);
              // Send keyup immediately after keydown for repeat
              setTimeout(() => {
                this.sendKeyboardAction(keyCode, false);
              }, 30);
            }
          }, 100); // Repeat every 100ms
        }, 300); // Long press threshold: 300ms

        this.virtualKeyTimers.set(keyElement, timerInfo);
      } else {
        if (!this.virtualKeyTimers.has(keyElement)) return;
        // Stop repeating
        this.stopRepeat(this.virtualKeyTimers, keyElement);

        // Send keyup
        this.sendKeyboardAction(keyCode, false);

        // Visual feedback - released state - clear inline styles to restore CSS
        // Use setTimeout to ensure this happens after browser default styles are applied
        setTimeout(() => {
          // Remove focus to prevent browser default focus styles
          if (document.activeElement === keyElement) {
            keyElement.blur();
          }
          // Force clear all inline styles
          keyElement.style.backgroundColor = "";
          keyElement.style.transform = "";
          keyElement.style.boxShadow = "";
          keyElement.style.outline = "";
        }, 0);
      }
    }

    releaseVirtualKeys() {
      for (const key of [...this.virtualKeyTimers.keys()]) this.handleVirtualKeyPress(key, false);
    }

    cancelLocalInput() {
      window.CrossDeskClipboard?.cancelPaste();
      this.onVirtualButtonEnd({});
      this.releaseMouseButtons();
      this.releaseKeyboardKeys();
      this.releaseVirtualKeys();
      for (const button of [...this.virtualScrollTimers.keys()]) this.handleVirtualScrollPress(button, "up", false);
      this.clearPendingMotion();
      if (this.state.touchGesture) this.state.touchGesture.cancelled = true;
    }

    stopRepeat(timers, element) {
      const timer = timers.get(element);
      if (!timer) return;
      clearTimeout(timer.longPressTimer);
      clearInterval(timer.repeatTimer);
      timers.delete(element);
    }

    emitVirtualWheel(direction = "up") {
      // direction: "up" or "down"
      // The remote mouse protocol uses positive values for scrolling up.
      const scrollValue = direction === "up" ? 1 : -1;
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.wheel_vertical,
        scroll: scrollValue,
      });
    }

    handleVirtualScrollPress(buttonElement, direction, isDown) {
      if (isDown && !this.isChannelOpen()) return;

      if (isDown) {
        // Clear any existing timer for this button
        this.stopRepeat(this.virtualScrollTimers, buttonElement);

        // Send initial scroll
        this.emitVirtualWheel(direction);

        // Visual feedback - pressed state
        buttonElement.style.backgroundColor = "rgba(180, 180, 180, 0.95)";
        buttonElement.style.transform = "scale(0.92)";
        buttonElement.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.3)";

        // Store timer info for this button
        const timerInfo = {
          longPressTimer: null,
          repeatTimer: null,
        };

        // Set up long press detection
        timerInfo.longPressTimer = setTimeout(() => {
          // After 300ms, start repeating
          timerInfo.repeatTimer = setInterval(() => {
            if (this.isChannelOpen()) {
              this.emitVirtualWheel(direction);
            }
          }, 100); // Repeat every 100ms
        }, 300); // Long press threshold: 300ms

        this.virtualScrollTimers.set(buttonElement, timerInfo);
      } else {
        // Stop repeating
        this.stopRepeat(this.virtualScrollTimers, buttonElement);

        // Visual feedback - released state - clear inline styles to restore CSS
        setTimeout(() => {
          // Remove focus to prevent browser default focus styles
          if (document.activeElement === buttonElement) {
            buttonElement.blur();
          }
          // Force clear all inline styles
          buttonElement.style.backgroundColor = "";
          buttonElement.style.transform = "";
          buttonElement.style.boxShadow = "";
          buttonElement.style.outline = "";
        }, 0);
      }
    }

    onVirtualLeftStart(event) {
      this.onVirtualButtonStart(event, this.elements.virtualLeftBtn, MouseFlag.left_down, MouseFlag.left_up);
    }

    onVirtualRightStart(event) {
      this.onVirtualButtonStart(event, this.elements.virtualRightBtn, MouseFlag.right_down, MouseFlag.right_up);
    }

    onVirtualButtonStart(event, button, down, up) {
      const touch = event.changedTouches?.[0] || event.touches?.[0];
      if (!touch || !this.isChannelOpen() || this.state.gestureActive) return;
      event.preventDefault();
      this.ensureVideoRect();
      this.state.gestureActive = true;
      this.state.gestureButton = { down, up };
      this.state.gestureStart = {
        touchId: touch.identifier,
        x: touch.clientX,
        y: touch.clientY,
        normalizedX: this.state.normalizedPos.x,
        normalizedY: this.state.normalizedPos.y,
      };
      if (button) {
        button.style.backgroundColor = "var(--primary-color)";
        button.style.color = "#fff";
      }
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: down,
      });
    }

    onVirtualButtonMove(event) {
      if (!this.state.gestureActive || !this.state.gestureStart) return;
      const touchId = this.state.gestureStart.touchId;
      const touch = touchId === undefined ? event.touches?.[0] :
        Array.from(event.touches || []).find(t => t.identifier === touchId);
      if (!touch) return;
      event.preventDefault();
      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      const sensitivity = 2;
      const deltaX = touch.clientX - this.state.gestureStart.x;
      const deltaY = touch.clientY - this.state.gestureStart.y;
      const newX =
        this.state.gestureStart.normalizedX +
        (deltaX / this.state.videoRect.width) * sensitivity;
      const newY =
        this.state.gestureStart.normalizedY +
        (deltaY / this.state.videoRect.height) * sensitivity;

      this.state.normalizedPos = { x: clamp01(newX), y: clamp01(newY) };
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.move,
      });
    }

    onVirtualButtonEnd(event) {
      if (!this.state.gestureActive) return;
      const touchId = this.state.gestureStart?.touchId;
      if (touchId !== undefined && event.changedTouches &&
          !Array.from(event.changedTouches).some(t => t.identifier === touchId)) return;
      event.preventDefault?.();
      const upFlag = this.state.gestureButton?.up ?? MouseFlag.left_up;
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: upFlag,
      });

      // 释放时恢复为原始颜色 - 清除内联样式让CSS生效
      if (upFlag === MouseFlag.left_up && this.elements.virtualLeftBtn) {
        this.elements.virtualLeftBtn.style.backgroundColor = "";
        this.elements.virtualLeftBtn.style.color = "";
        if (document.activeElement === this.elements.virtualLeftBtn) {
          this.elements.virtualLeftBtn.blur();
        }
      } else if (
        upFlag === MouseFlag.right_up &&
        this.elements.virtualRightBtn
      ) {
        this.elements.virtualRightBtn.style.backgroundColor = "";
        this.elements.virtualRightBtn.style.color = "";
        if (document.activeElement === this.elements.virtualRightBtn) {
          this.elements.virtualRightBtn.blur();
        }
      }

      this.state.gestureActive = false;
      this.state.gestureButton = null;
      this.state.gestureStart = null;
    }

    showPointerLockToast(text, duration = 2500) {
      let toast = document.getElementById("pointerlock-toast");
      if (!toast) {
        toast = document.createElement("div");
        toast.id = "pointerlock-toast";
        Object.assign(toast.style, {
          position: "fixed",
          left: "50%",
          bottom: "24px",
          transform: "translateX(-50%)",
          background: "rgba(0,0,0,0.75)",
          color: "#fff",
          padding: "8px 12px",
          borderRadius: "6px",
          fontSize: "13px",
          zIndex: "9999",
          pointerEvents: "none",
          opacity: "1",
          transition: "opacity 0.2s",
        });
        document.body.appendChild(toast);
      }
      toast.textContent = text;
      toast.style.opacity = "1";
      if (this.state.pointerLockToastTimer) {
        clearTimeout(this.state.pointerLockToastTimer);
      }
      this.state.pointerLockToastTimer = setTimeout(() => {
        toast.style.opacity = "0";
        this.state.pointerLockToastTimer = null;
      }, duration);
    }

    handleExternalMouseEvent(event) {
      if (!event || !event.type) return;
      // Don't handle mouse events while dragging UI elements
      if (this.isDraggingAnyElement()) {
        return;
      }
      switch (event.type) {
        case "mousedown":
          this.onPointerDown(event);
          break;
        case "mouseup":
          this.onPointerUp(event);
          break;
        case "mousemove":
          this.onPointerMove(event);
          break;
        case "wheel":
          this.onWheel(event);
          break;
        default:
          break;
      }
    }

    isDraggingAnyElement() {
      return this.state.draggingPanel;
    }

    setDraggingPanel(isDragging) {
      this.state.draggingPanel = isDragging;
    }

    // Calculate distance between two touch points
    getTouchDistance(touch1, touch2) {
      const dx = touch2.clientX - touch1.clientX;
      const dy = touch2.clientY - touch1.clientY;
      return Math.sqrt(dx * dx + dy * dy);
    }

    // Get center point between two touches
    getTouchCenter(touch1, touch2) {
      return {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    }

    // Pinch zoom handlers
    onPinchStart(event) {
      // Only handle on video element
      if (
        event.target !== this.elements.video &&
        !this.elements.video?.contains(event.target)
      ) {
        return;
      }

      if (event.touches.length === 2) {
        event.preventDefault();
        event.stopPropagation();
        this.state.pinchZoomActive = true;
        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        this.state.initialPinchDistance = this.getTouchDistance(touch1, touch2);
        this.state.initialScale = this.state.currentScale;
        // Record initial center point and translate for panning
        this.state.initialPinchCenter = this.getTouchCenter(touch1, touch2);
        this.state.initialTranslateX = this.state.currentTranslateX;
        this.state.initialTranslateY = this.state.currentTranslateY;
      }
    }

    onPinchMove(event) {
      // Check for two touches first, even if pinchZoomActive is false (might have started with one touch)
      if (event.touches.length === 2) {
        if (!this.state.pinchZoomActive) {
          // Start pinch zoom if not already active
          this.state.pinchZoomActive = true;
          const touch1 = event.touches[0];
          const touch2 = event.touches[1];
          this.state.initialPinchDistance = this.getTouchDistance(
            touch1,
            touch2,
          );
          this.state.initialScale = this.state.currentScale;
          this.state.initialPinchCenter = this.getTouchCenter(touch1, touch2);
          this.state.initialTranslateX = this.state.currentTranslateX;
          this.state.initialTranslateY = this.state.currentTranslateY;
        }

        event.preventDefault();
        event.stopPropagation();

        const touch1 = event.touches[0];
        const touch2 = event.touches[1];
        const currentDistance = this.getTouchDistance(touch1, touch2);
        const currentCenter = this.getTouchCenter(touch1, touch2);

        // Calculate scale factor
        const scaleFactor = currentDistance / this.state.initialPinchDistance;
        const newScale = this.state.initialScale * scaleFactor;

        // Limit scale between 1.0x (initial size) and 3x
        const clampedScale = Math.max(1.0, Math.min(3.0, newScale));
        this.state.currentScale = clampedScale;

        // Calculate pan (translation) based on center point movement
        if (this.state.initialPinchCenter) {
          const deltaX = currentCenter.x - this.state.initialPinchCenter.x;
          const deltaY = currentCenter.y - this.state.initialPinchCenter.y;

          // Calculate new translate values based on initial translate + delta
          let newTranslateX = this.state.initialTranslateX + deltaX;
          let newTranslateY = this.state.initialTranslateY + deltaY;

          // Constrain translation to keep image within bounds
          if (this.elements.video && this.elements.videoContainer) {
            this.ensureVideoRect();
            if (this.state.videoRect) {
              const videoWidth = this.state.videoRect.width;
              const videoHeight = this.state.videoRect.height;

              // Calculate maximum allowed translation
              // When scaled, the image is larger, so we can move it more
              const scaledWidth = videoWidth * clampedScale;
              const scaledHeight = videoHeight * clampedScale;
              const maxTranslateX = Math.max(0, (scaledWidth - videoWidth) / 2);
              const maxTranslateY = Math.max(
                0,
                (scaledHeight - videoHeight) / 2,
              );

              // Clamp translation values
              newTranslateX = Math.max(
                -maxTranslateX,
                Math.min(maxTranslateX, newTranslateX),
              );
              newTranslateY = Math.max(
                -maxTranslateY,
                Math.min(maxTranslateY, newTranslateY),
              );
            }
          }

          this.state.currentTranslateX = newTranslateX;
          this.state.currentTranslateY = newTranslateY;
        }

        // Apply combined transform (scale + translate) to video element
        if (this.elements.video) {
          this.elements.video.style.transform = `scale(${clampedScale}) translate(${this.state.currentTranslateX}px, ${this.state.currentTranslateY}px)`;
          this.elements.video.style.transformOrigin = "center center";
        }
      } else if (this.state.pinchZoomActive && event.touches.length < 2) {
        // Pinch ended
        this.state.pinchZoomActive = false;
        this.state.initialPinchDistance = 0;
        this.state.initialPinchCenter = null;
      }
    }

    onPinchEnd(event) {
      if (this.state.pinchZoomActive && event.touches.length < 2) {
        this.state.pinchZoomActive = false;
        this.state.initialPinchDistance = 0;
        this.state.initialPinchCenter = null;
        // The touch gesture remains tracked until the last finger lifts.
      }
    }

    resetZoom() {
      this.state.currentScale = 1.0;
      this.state.initialScale = 1.0;
      this.state.currentTranslateX = 0;
      this.state.currentTranslateY = 0;
      this.state.initialTranslateX = 0;
      this.state.initialTranslateY = 0;
      if (this.elements.video) {
        this.elements.video.style.transform = "scale(1) translate(0, 0)";
        this.elements.video.style.transformOrigin = "center center";
      }
    }
  }

  const control = new ControlManager();

  window.CrossDeskControl = control;
  window.sendRemoteActionAt = (x, y, flag, scroll) =>
    control.sendMouseAction({ x, y, flag, scroll });
  window.sendMouseEvent = (event) => control.handleExternalMouseEvent(event);
})();
