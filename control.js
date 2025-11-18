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

  const clamp01 = (value) => Math.max(0, Math.min(1, value));
  const isTextInput = (el) => {
    if (!el || !el.tagName) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === "textarea") return true;
    if (tag !== "input") return false;
    const type = (el.getAttribute("type") || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset"].includes(type);
  };

  class ControlManager {
    constructor() {
      this.dataChannel = null;
      this.elements = {
        video: document.getElementById("video"),
        mediaContainer: document.getElementById("media"),
        videoContainer: document.getElementById("video-container"),
        virtualMouse: document.getElementById("virtual-mouse"),
        virtualMouseHeader: document.getElementById("virtual-mouse-header"),
        virtualLeftBtn: document.getElementById("virtual-left-btn"),
        virtualRightBtn: document.getElementById("virtual-right-btn"),
        virtualScrollUp: document.getElementById("virtual-scroll-up"),
        virtualScrollDown: document.getElementById("virtual-scroll-down"),
        virtualTouchpad: null,
        virtualDragHandle: document.getElementById("virtual-mouse-drag-handle"),
        mobileModeSelector: document.getElementById("mobile-mode-selector"),
        mouseControlMode: document.getElementById("mouse-control-mode"),
        virtualKeyboard: document.getElementById("virtual-keyboard"),
        keyboardHeader: document.getElementById("keyboard-header"),
        keyboardToggleMouse: document.getElementById("keyboard-toggle-mouse"),
        keyboardToggle: document.getElementById("keyboard-toggle"),
        keyboardClose: document.getElementById("keyboard-close"),
        virtualMouseMinimize: document.getElementById("virtual-mouse-minimize"),
        virtualMouseRestore: document.getElementById("virtual-mouse-restore"),
      };

      this.virtualKeyTimers = new Map(); // Store timers for each key element
      this.virtualScrollTimers = new Map(); // Store timers for scroll buttons

      this.state = {
        pointerLocked: false,
        normalizedPos: { x: 0.5, y: 0.5 },
        lastPointerPos: null,
        lastWheelAt: 0,
        touchpadStart: null,
        draggingVirtualMouse: false,
        dragOffset: { x: 0, y: 0 },
        draggingVirtualKeyboard: false,
        keyboardDragOffset: { x: 0, y: 0 },
        draggingPanel: false, // Track if status panel is being dragged
        pointerLockToastTimer: null,
        videoRect: null,
        gestureActive: false,
        gestureButton: null,
        gestureStart: null,
        isMobile: false,
        mobileControlMode: "absolute", // "absolute" or "relative"
        touchActive: false,
        touchStartPos: null,
        touchLastPos: null,
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
        virtualMouseMinimized: false,
      };

      this.onPointerLockChange = this.onPointerLockChange.bind(this);
      this.onPointerLockError = this.onPointerLockError.bind(this);
      this.onPointerDown = this.onPointerDown.bind(this);
      this.onPointerMove = this.onPointerMove.bind(this);
      this.onPointerUp = this.onPointerUp.bind(this);
      this.onPointerCancel = this.onPointerCancel.bind(this);
      this.onWheel = this.onWheel.bind(this);

      this.onTouchStartFallback = this.onTouchStartFallback.bind(this);
      this.onTouchMoveFallback = this.onTouchMoveFallback.bind(this);
      this.onTouchEndFallback = this.onTouchEndFallback.bind(this);
      this.onVirtualLeftStart = this.onVirtualLeftStart.bind(this);
      this.onVirtualRightStart = this.onVirtualRightStart.bind(this);
      this.onVirtualButtonMove = this.onVirtualButtonMove.bind(this);
      this.onVirtualButtonEnd = this.onVirtualButtonEnd.bind(this);

      this.onDragHandleTouchStart = this.onDragHandleTouchStart.bind(this);
      this.onDragHandleTouchMove = this.onDragHandleTouchMove.bind(this);
      this.onDragHandleTouchEnd = this.onDragHandleTouchEnd.bind(this);
      this.onDragHandleClick = this.onDragHandleClick.bind(this);

      this.onKeyboardDragHandleTouchStart = this.onKeyboardDragHandleTouchStart.bind(this);
      this.onKeyboardDragHandleTouchMove = this.onKeyboardDragHandleTouchMove.bind(this);
      this.onKeyboardDragHandleTouchEnd = this.onKeyboardDragHandleTouchEnd.bind(this);

      this.onPinchStart = this.onPinchStart.bind(this);
      this.onPinchMove = this.onPinchMove.bind(this);
      this.onPinchEnd = this.onPinchEnd.bind(this);

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
      this.dataChannel = channel;
    }

    isChannelOpen() {
      return this.dataChannel && this.dataChannel.readyState === "open";
    }

    send(action) {
      if (!this.isChannelOpen()) return false;
      try {
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
        typeof flag === "string" ? MouseFlag[flag] ?? MouseFlag.move : flag | 0;

      const action = {
        type: ControlType.mouse,
        mouse: {
          x: clamp01(x),
          y: clamp01(y),
          s: scroll | 0,
          flag: numericFlag,
        },
      };

      this.send(action);
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
      const numericId = typeof id === "number" && Number.isFinite(id) ? id : parseInt(id, 10);
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
      document.addEventListener("keydown", (event) => {
        if (event.ctrlKey && event.key === "Escape") {
          document.exitPointerLock?.();
        }
      });
    }

    onPointerLockChange() {
      this.state.pointerLocked = document.pointerLockElement === this.elements.video;
      if (this.state.pointerLocked) {
        this.state.videoRect = this.elements.video?.getBoundingClientRect() ?? null;
      } else {
        this.state.videoRect = null;
        this.showPointerLockToast(
          "已退出鼠标锁定，按 Esc 或点击视频重新锁定（释放可按 Ctrl+Esc）",
          3000
        );
      }
    }

    onPointerLockError() {
      this.showPointerLockToast("鼠标锁定失败", 2500);
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

      if (!window.PointerEvent) {
        video.addEventListener("touchstart", this.onTouchStartFallback, {
          passive: false,
        });
        document.addEventListener("touchmove", this.onTouchMoveFallback, {
          passive: false,
        });
        document.addEventListener("touchend", this.onTouchEndFallback, {
          passive: false,
        });
        document.addEventListener("touchcancel", this.onTouchEndFallback, {
          passive: false,
        });
      }

      // Pinch zoom will be set up in setupVirtualMouse() after isMobile is determined
    }

    onPointerDown(event) {
      const button = typeof event.button === "number" ? event.button : 0;
      if (button < 0) return;
      
      // Skip if touching panel elements
      const target = event.target;
      if (target && (target.closest("#panel-collapsed-bar") || target.closest("#connected-panel"))) {
        return;
      }
      
      // Skip if clicking inside panel area
      if (this.isInsidePanel(event.clientX, event.clientY)) {
        return;
      }
      
      // Skip if dragging panel
      if (this.state.draggingPanel) {
        return;
      }
      
      // 移动端模式下，触摸视频区域不触发点击事件，只移动鼠标位置
      // Skip if pinch zoom is active
      if (this.state.isMobile && event.pointerType === "touch" && !this.state.pinchZoomActive) {
        event.preventDefault?.();
        this.ensureVideoRect();
        if (this.state.videoRect && this.isInsideVideo(event.clientX, event.clientY)) {
          // 模式1：指哪打哪 - 直接设置鼠标位置
          if (this.state.mobileControlMode === "absolute") {
            this.updateNormalizedFromClient(event.clientX, event.clientY);
            this.sendMouseAction({
              x: this.state.normalizedPos.x,
              y: this.state.normalizedPos.y,
              flag: MouseFlag.move,
            });
          } else {
            // 模式2：增量模式 - 记录起始位置
            this.state.touchActive = true;
            this.state.touchStartPos = { x: event.clientX, y: event.clientY };
            this.state.touchLastPos = { x: event.clientX, y: event.clientY };
          }
        }
        // Try to capture pointer, but handle errors gracefully
        if (this.elements.video && event.pointerId !== undefined && event.pointerId !== null) {
          try {
            this.elements.video.setPointerCapture(event.pointerId);
          } catch (err) {
            // Ignore errors (e.g., element not in document, pointer already captured, etc.)
            // console.warn("setPointerCapture failed:", err);
          }
        }
        return;
      }

      event.preventDefault?.();
      this.state.lastPointerPos = { x: event.clientX, y: event.clientY };
      this.ensureVideoRect();
      if (this.state.videoRect && this.isInsideVideo(event.clientX, event.clientY)) {
        // this.updateNormalizedFromClient(event.clientX, event.clientY);
        this.requestPointerLock();
      }

      // Try to capture pointer, but handle errors gracefully
      if (this.elements.video && event.pointerId !== undefined && event.pointerId !== null) {
        try {
          this.elements.video.setPointerCapture(event.pointerId);
        } catch (err) {
          // Ignore errors (e.g., element not in document, pointer already captured, etc.)
          // console.warn("setPointerCapture failed:", err);
        }
      }
      
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: this.buttonToFlag(button, true),
      });
    }

    onPointerMove(event) {
      // Skip if touching panel elements
      const target = event.target;
      if (target && (target.closest("#panel-collapsed-bar") || target.closest("#connected-panel"))) {
        return;
      }
      
      // Skip if moving inside panel area
      if (this.isInsidePanel(event.clientX, event.clientY)) {
        return;
      }
      
      // Skip if dragging panel
      if (this.state.draggingPanel) {
        return;
      }
      
      // Skip if pinch zoom is active
      if (this.state.pinchZoomActive) {
        return;
      }
      
      // 移动端增量模式处理
      if (this.state.isMobile && event.pointerType === "touch" && this.state.touchActive && this.state.mobileControlMode === "relative") {
        event.preventDefault?.();
        this.ensureVideoRect();
        if (!this.state.videoRect || !this.state.touchLastPos) return;

        const deltaX = event.clientX - this.state.touchLastPos.x;
        const deltaY = event.clientY - this.state.touchLastPos.y;

        // 计算增量（相对于视频尺寸）
        const deltaXNormalized = deltaX / this.state.videoRect.width;
        const deltaYNormalized = deltaY / this.state.videoRect.height;

        // 更新鼠标位置（增量模式）
        this.state.normalizedPos.x = clamp01(this.state.normalizedPos.x + deltaXNormalized);
        this.state.normalizedPos.y = clamp01(this.state.normalizedPos.y + deltaYNormalized);

        this.sendMouseAction({
          x: this.state.normalizedPos.x,
          y: this.state.normalizedPos.y,
          flag: MouseFlag.move,
        });

        this.state.touchLastPos = { x: event.clientX, y: event.clientY };
        return;
      }

      // 移动端指哪打哪模式处理
      if (this.state.isMobile && event.pointerType === "touch" && this.state.mobileControlMode === "absolute") {
        event.preventDefault?.();
        this.ensureVideoRect();
        if (!this.state.videoRect || !this.isInsideVideo(event.clientX, event.clientY)) return;

        this.updateNormalizedFromClient(event.clientX, event.clientY);
        this.sendMouseAction({
          x: this.state.normalizedPos.x,
          y: this.state.normalizedPos.y,
          flag: MouseFlag.move,
        });
        return;
      }

      // 桌面端处理
      if (!this.state.pointerLocked && !this.state.lastPointerPos) return;

      const movementX = this.state.pointerLocked
        ? event.movementX
        : event.clientX - (this.state.lastPointerPos?.x ?? event.clientX);
      const movementY = this.state.pointerLocked
        ? event.movementY
        : event.clientY - (this.state.lastPointerPos?.y ?? event.clientY);

      if (!this.state.pointerLocked) {
        this.state.lastPointerPos = { x: event.clientX, y: event.clientY };
      }

      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      if (this.state.pointerLocked) {
        this.state.normalizedPos.x = clamp01(
          this.state.normalizedPos.x + movementX / this.state.videoRect.width
        );
        this.state.normalizedPos.y = clamp01(
          this.state.normalizedPos.y + movementY / this.state.videoRect.height
        );
        this.sendMouseAction({
          x: this.state.normalizedPos.x,
          y: this.state.normalizedPos.y,
          flag: MouseFlag.move,
        });
        return;
      }

      if (!this.isInsideVideo(event.clientX, event.clientY)) return;
      const x = (event.clientX - this.state.videoRect.left) /
        this.state.videoRect.width;
      const y = (event.clientY - this.state.videoRect.top) /
        this.state.videoRect.height;
      this.state.normalizedPos = { x: clamp01(x), y: clamp01(y) };
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.move,
      });
    }

    onPointerUp(event) {
      // Skip if releasing inside panel area
      if (this.isInsidePanel(event.clientX, event.clientY)) {
        this.elements.video?.releasePointerCapture?.(event.pointerId ?? 0);
        return;
      }
      
      // 移动端模式下，触摸结束不触发点击事件
      if (this.state.isMobile && event.pointerType === "touch") {
        this.elements.video?.releasePointerCapture?.(event.pointerId ?? 0);
        this.state.touchActive = false;
        this.state.touchStartPos = null;
        this.state.touchLastPos = null;
        return;
      }

      const button = typeof event.button === "number" ? event.button : 0;
      this.elements.video?.releasePointerCapture?.(event.pointerId ?? 0);
      this.state.lastPointerPos = null;
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: this.buttonToFlag(button, false),
      });
    }

    onPointerCancel() {
      this.state.lastPointerPos = null;
      // 清理移动端触摸状态
      if (this.state.isMobile) {
        this.state.touchActive = false;
        this.state.touchStartPos = null;
        this.state.touchLastPos = null;
      }
    }

    onWheel(event) {
      const now = Date.now();
      if (now - this.state.lastWheelAt < 50) return;
      this.state.lastWheelAt = now;

      // Skip if wheeling inside panel area
      if (this.isInsidePanel(event.clientX, event.clientY)) {
        return;
      }

      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      let coords = this.state.normalizedPos;
      if (!this.state.pointerLocked) {
        if (!this.isInsideVideo(event.clientX, event.clientY)) return;
        coords = {
          x: (event.clientX - this.state.videoRect.left) /
            this.state.videoRect.width,
          y: (event.clientY - this.state.videoRect.top) /
            this.state.videoRect.height,
        };
      }

      this.sendMouseAction({
        x: coords.x,
        y: coords.y,
        flag: event.deltaY === 0 ? MouseFlag.wheel_horizontal : MouseFlag.wheel_vertical,
        scroll: event.deltaY || event.deltaX,
      });
      event.preventDefault();
    }

    onTouchStartFallback(event) {
      if (!event.touches?.length) return;
      
      // Skip if touching panel elements
      const target = event.target;
      if (target && (target.closest("#panel-collapsed-bar") || target.closest("#connected-panel"))) {
        return;
      }
      
      const touch = event.touches[0];
      
      // Skip if touching inside panel area
      if (this.isInsidePanel(touch.clientX, touch.clientY)) {
        return;
      }
      
      // Skip if pinch zoom is active, dragging panel, or if two touches (pinch gesture)
      if (this.state.pinchZoomActive || this.state.draggingPanel || event.touches.length === 2) {
        return;
      }
      
      event.preventDefault();
      
      // 移动端模式下，触摸视频区域不触发点击事件
      this.ensureVideoRect();
      if (this.state.videoRect && this.isInsideVideo(touch.clientX, touch.clientY)) {
        if (this.state.mobileControlMode === "absolute") {
          // 模式1：指哪打哪
          this.updateNormalizedFromClient(touch.clientX, touch.clientY);
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.move,
          });
        } else {
          // 模式2：增量模式
          this.state.touchActive = true;
          this.state.touchStartPos = { x: touch.clientX, y: touch.clientY };
          this.state.touchLastPos = { x: touch.clientX, y: touch.clientY };
        }
      }
    }

    onTouchMoveFallback(event) {
      if (!event.touches?.length) return;
      
      // Skip if touching panel elements
      const target = event.target;
      if (target && (target.closest("#panel-collapsed-bar") || target.closest("#connected-panel"))) {
        return;
      }
      
      const touch = event.touches[0];
      
      // Skip if moving inside panel area
      if (this.isInsidePanel(touch.clientX, touch.clientY)) {
        return;
      }
      
      // Skip if pinch zoom is active, dragging panel, or if two touches (pinch gesture)
      if (this.state.pinchZoomActive || this.state.draggingPanel || event.touches.length === 2) {
        return;
      }
      
      event.preventDefault();
      
      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      if (this.state.mobileControlMode === "absolute") {
        // 模式1：指哪打哪
        if (this.isInsideVideo(touch.clientX, touch.clientY)) {
          this.updateNormalizedFromClient(touch.clientX, touch.clientY);
          this.sendMouseAction({
            x: this.state.normalizedPos.x,
            y: this.state.normalizedPos.y,
            flag: MouseFlag.move,
          });
        }
      } else if (this.state.touchActive && this.state.touchLastPos) {
        // 模式2：增量模式
        const deltaX = touch.clientX - this.state.touchLastPos.x;
        const deltaY = touch.clientY - this.state.touchLastPos.y;

        const deltaXNormalized = deltaX / this.state.videoRect.width;
        const deltaYNormalized = deltaY / this.state.videoRect.height;

        this.state.normalizedPos.x = clamp01(this.state.normalizedPos.x + deltaXNormalized);
        this.state.normalizedPos.y = clamp01(this.state.normalizedPos.y + deltaYNormalized);

        this.sendMouseAction({
          x: this.state.normalizedPos.x,
          y: this.state.normalizedPos.y,
          flag: MouseFlag.move,
        });

        this.state.touchLastPos = { x: touch.clientX, y: touch.clientY };
      }
    }

    onTouchEndFallback(event) {
      // 移动端模式下，触摸结束不触发点击事件
      this.state.touchActive = false;
      this.state.touchStartPos = null;
      this.state.touchLastPos = null;
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
      try {
        this.elements.video?.requestPointerLock?.();
      } catch (err) {
        console.warn("CrossDeskControl: requestPointerLock failed", err);
      }
    }

    ensureVideoRect() {
      const { video } = this.elements;
      if (!video) return;
      this.state.videoRect = video.getBoundingClientRect();
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
      const panel = document.getElementById("connected-panel");
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return (
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom
      );
    }

    updateNormalizedFromClient(clientX, clientY) {
      if (!this.state.videoRect) return;
      this.state.normalizedPos = {
        x: clamp01((clientX - this.state.videoRect.left) / this.state.videoRect.width),
        y: clamp01((clientY - this.state.videoRect.top) / this.state.videoRect.height),
      };
    }

    bindKeyboardListeners() {
      document.addEventListener("keydown", (event) => {
        if (!this.isChannelOpen()) return;
        if (event.repeat) return;
        if (isTextInput(event.target)) return;
        this.sendKeyboardAction(event.keyCode ?? 0, true);
      });

      document.addEventListener("keyup", (event) => {
        if (!this.isChannelOpen()) return;
        if (isTextInput(event.target)) return;
        this.sendKeyboardAction(event.keyCode ?? 0, false);
      });
    }

    setupVirtualMouse() {
      const isDesktop = window.matchMedia(
        "(hover: hover) and (pointer: fine)"
      ).matches;

      this.state.isMobile = !isDesktop;

      if (isDesktop) {
        if (this.elements.virtualMouse) {
          this.elements.virtualMouse.style.pointerEvents = "none";
        }
        if (this.elements.mobileModeSelector) {
          this.elements.mobileModeSelector.style.display = "none";
        }
        // Hide minimize button on desktop
        if (this.elements.virtualMouseMinimize) {
          this.elements.virtualMouseMinimize.style.display = "none";
        }
        return;
      }
      
      // Show minimize button on mobile
      if (this.elements.virtualMouseMinimize) {
        this.elements.virtualMouseMinimize.style.display = "flex";
      }

      // 显示移动端模式选择器
      if (this.elements.mobileModeSelector) {
        this.elements.mobileModeSelector.style.display = "flex";
      }

      // 绑定模式切换事件
      if (this.elements.mouseControlMode) {
        this.elements.mouseControlMode.addEventListener("change", (event) => {
          this.state.mobileControlMode = event.target.value;
        });
        this.state.mobileControlMode = this.elements.mouseControlMode.value;
      }

      this.elements.virtualLeftBtn?.addEventListener("touchstart", this.onVirtualLeftStart, { passive: false });
      this.elements.virtualRightBtn?.addEventListener("touchstart", this.onVirtualRightStart, { passive: false });
      document.addEventListener("touchmove", this.onVirtualButtonMove, { passive: false });
      document.addEventListener("touchend", this.onVirtualButtonEnd, { passive: false });
      document.addEventListener("touchcancel", this.onVirtualButtonEnd, { passive: false });

      // Scroll up button with long-press support
      if (this.elements.virtualScrollUp) {
        const handleScrollUpDown = (e) => {
          e.preventDefault();
          this.handleVirtualScrollPress(this.elements.virtualScrollUp, "up", true);
        };
        const handleScrollUpUp = (e) => {
          e.preventDefault();
          this.handleVirtualScrollPress(this.elements.virtualScrollUp, "up", false);
        };
        
        this.elements.virtualScrollUp.addEventListener("mousedown", handleScrollUpDown, { passive: false });
        this.elements.virtualScrollUp.addEventListener("mouseup", handleScrollUpUp, { passive: false });
        this.elements.virtualScrollUp.addEventListener("mouseleave", handleScrollUpUp, { passive: false });
        this.elements.virtualScrollUp.addEventListener("touchstart", handleScrollUpDown, { passive: false });
        this.elements.virtualScrollUp.addEventListener("touchend", handleScrollUpUp, { passive: false });
        this.elements.virtualScrollUp.addEventListener("touchcancel", handleScrollUpUp, { passive: false });
      }
      
      // Scroll down button with long-press support
      if (this.elements.virtualScrollDown) {
        const handleScrollDownDown = (e) => {
          e.preventDefault();
          this.handleVirtualScrollPress(this.elements.virtualScrollDown, "down", true);
        };
        const handleScrollDownUp = (e) => {
          e.preventDefault();
          this.handleVirtualScrollPress(this.elements.virtualScrollDown, "down", false);
        };
        
        this.elements.virtualScrollDown.addEventListener("mousedown", handleScrollDownDown, { passive: false });
        this.elements.virtualScrollDown.addEventListener("mouseup", handleScrollDownUp, { passive: false });
        this.elements.virtualScrollDown.addEventListener("mouseleave", handleScrollDownUp, { passive: false });
        this.elements.virtualScrollDown.addEventListener("touchstart", handleScrollDownDown, { passive: false });
        this.elements.virtualScrollDown.addEventListener("touchend", handleScrollDownUp, { passive: false });
        this.elements.virtualScrollDown.addEventListener("touchcancel", handleScrollDownUp, { passive: false });
      }

      this.bindVirtualMouseDragging();
      this.bindVirtualKeyboardDragging();
      
      // Bind minimize/restore buttons
      if (this.elements.virtualMouseMinimize) {
        this.elements.virtualMouseMinimize.addEventListener("click", (e) => {
          e.stopPropagation();
          this.minimizeVirtualMouse();
        });
      }
      
      if (this.elements.virtualMouseRestore) {
        this.elements.virtualMouseRestore.addEventListener("click", (e) => {
          e.stopPropagation();
          this.restoreVirtualMouse();
        });
      }

      // Add pinch zoom support for mobile devices (after isMobile is set)
      if (this.state.isMobile && this.elements.video) {
        const video = this.elements.video;
        video.addEventListener("touchstart", this.onPinchStart, {
          passive: false,
        });
        document.addEventListener("touchmove", this.onPinchMove, {
          passive: false,
        });
        document.addEventListener("touchend", this.onPinchEnd, {
          passive: false,
        });
        document.addEventListener("touchcancel", this.onPinchEnd, {
          passive: false,
        });
      }
    }

    setupVirtualKeyboard() {
      const isDesktop = window.matchMedia(
        "(hover: hover) and (pointer: fine)"
      ).matches;

      // Only show virtual keyboard on mobile devices
      if (isDesktop) {
        if (this.elements.virtualKeyboard) {
          this.elements.virtualKeyboard.style.display = "none";
        }
        // Keep keyboard toggle button visible in panel even on desktop
        // Don't hide it, and don't return early so button setup continues
      }

      // Show keyboard toggle button on virtual mouse (always visible in panel)
      if (this.elements.keyboardToggleMouse) {
        this.elements.keyboardToggleMouse.style.display = "block";
        this.elements.keyboardToggleMouse.addEventListener("click", () => {
          this.toggleVirtualKeyboard();
        });
      }

      // Keyboard header buttons
      if (this.elements.keyboardToggle) {
        this.elements.keyboardToggle.addEventListener("click", () => {
          this.toggleVirtualKeyboard();
        });
      }

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
      if (!this.elements.virtualKeyboard) return;
      this.elements.virtualKeyboard.style.display = "none";
    }

    handleVirtualKeyPress(keyElement, isDown) {
      if (!this.isChannelOpen()) return;
      const keyCode = parseInt(keyElement.getAttribute("data-keycode"), 10);
      if (isNaN(keyCode)) return;

      if (isDown) {
        // Clear any existing timer for this key
        this.stopVirtualKeyRepeat(keyElement);
        
        // Send initial keydown
        this.sendKeyboardAction(keyCode, true);
        
        // Visual feedback - pressed state
        keyElement.style.backgroundColor = "rgba(180, 180, 180, 0.95)";
        keyElement.style.transform = "scale(0.92)";
        keyElement.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.3)";
        
        // Store timer info for this key
        const timerInfo = {
          longPressTimer: null,
          repeatTimer: null
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
        // Stop repeating
        this.stopVirtualKeyRepeat(keyElement);
        
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

    stopVirtualKeyRepeat(keyElement) {
      const timerInfo = this.virtualKeyTimers.get(keyElement);
      if (timerInfo) {
        if (timerInfo.longPressTimer) {
          clearTimeout(timerInfo.longPressTimer);
        }
        if (timerInfo.repeatTimer) {
          clearInterval(timerInfo.repeatTimer);
        }
        this.virtualKeyTimers.delete(keyElement);
      }
    }

    emitVirtualWheel(direction = "up") {
      // direction: "up" or "down"
      // Up scroll: negative value (scroll up)
      // Down scroll: positive value (scroll down)
      const scrollValue = direction === "up" ? -1 : 1;
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.wheel_vertical,
        scroll: scrollValue,
      });
    }

    handleVirtualScrollPress(buttonElement, direction, isDown) {
      if (!this.isChannelOpen()) return;
      
      if (isDown) {
        // Clear any existing timer for this button
        this.stopVirtualScrollRepeat(buttonElement);
        
        // Send initial scroll
        this.emitVirtualWheel(direction);
        
        // Visual feedback - pressed state
        buttonElement.style.backgroundColor = "rgba(180, 180, 180, 0.95)";
        buttonElement.style.transform = "scale(0.92)";
        buttonElement.style.boxShadow = "0 1px 2px rgba(0, 0, 0, 0.3)";
        
        // Store timer info for this button
        const timerInfo = {
          longPressTimer: null,
          repeatTimer: null
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
        this.stopVirtualScrollRepeat(buttonElement);
        
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

    stopVirtualScrollRepeat(buttonElement) {
      const timerInfo = this.virtualScrollTimers.get(buttonElement);
      if (timerInfo) {
        if (timerInfo.longPressTimer) {
          clearTimeout(timerInfo.longPressTimer);
        }
        if (timerInfo.repeatTimer) {
          clearInterval(timerInfo.repeatTimer);
        }
        this.virtualScrollTimers.delete(buttonElement);
      }
    }

    onVirtualLeftStart(event) {
      const touch = event.touches?.[0];
      if (!touch) return;
      event.preventDefault();
      this.ensureVideoRect();
      this.state.gestureActive = true;
      this.state.gestureButton = { down: MouseFlag.left_down, up: MouseFlag.left_up };
      this.state.gestureStart = {
        x: touch.clientX,
        y: touch.clientY,
        normalizedX: this.state.normalizedPos.x,
        normalizedY: this.state.normalizedPos.y,
      };
      // 按下时设置为蓝色
      if (this.elements.virtualLeftBtn) {
        this.elements.virtualLeftBtn.style.backgroundColor = "var(--primary-color)";
        this.elements.virtualLeftBtn.style.color = "#fff";
      }
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.left_down,
      });
    }

    onVirtualRightStart(event) {
      const touch = event.touches?.[0];
      if (!touch) return;
      event.preventDefault();
      this.ensureVideoRect();
      this.state.gestureActive = true;
      this.state.gestureButton = { down: MouseFlag.right_down, up: MouseFlag.right_up };
      this.state.gestureStart = {
        x: touch.clientX,
        y: touch.clientY,
        normalizedX: this.state.normalizedPos.x,
        normalizedY: this.state.normalizedPos.y,
      };
      // 按下时设置为蓝色
      if (this.elements.virtualRightBtn) {
        this.elements.virtualRightBtn.style.backgroundColor = "var(--primary-color)";
        this.elements.virtualRightBtn.style.color = "#fff";
      }
      this.sendMouseAction({
        x: this.state.normalizedPos.x,
        y: this.state.normalizedPos.y,
        flag: MouseFlag.right_down,
      });
    }

    onVirtualButtonMove(event) {
      if (!this.state.gestureActive || !this.state.gestureStart) return;
      const touch = event.touches?.[0];
      if (!touch) return;
      event.preventDefault();
      this.ensureVideoRect();
      if (!this.state.videoRect) return;

      const sensitivity = 2;
      const deltaX = touch.clientX - this.state.gestureStart.x;
      const deltaY = touch.clientY - this.state.gestureStart.y;
      const newX = this.state.gestureStart.normalizedX + (deltaX / this.state.videoRect.width) * sensitivity;
      const newY = this.state.gestureStart.normalizedY + (deltaY / this.state.videoRect.height) * sensitivity;

      this.state.normalizedPos = { x: clamp01(newX), y: clamp01(newY) };
      this.sendMouseAction({ x: this.state.normalizedPos.x, y: this.state.normalizedPos.y, flag: MouseFlag.move });
    }

    onVirtualButtonEnd(event) {
      if (!this.state.gestureActive) return;
      event.preventDefault?.();
      const upFlag = this.state.gestureButton?.up ?? MouseFlag.left_up;
      this.sendMouseAction({ x: this.state.normalizedPos.x, y: this.state.normalizedPos.y, flag: upFlag });
      
      // 释放时恢复为原始颜色 - 清除内联样式让CSS生效
      if (upFlag === MouseFlag.left_up && this.elements.virtualLeftBtn) {
        this.elements.virtualLeftBtn.style.backgroundColor = "";
        this.elements.virtualLeftBtn.style.color = "";
        if (document.activeElement === this.elements.virtualLeftBtn) {
          this.elements.virtualLeftBtn.blur();
        }
      } else if (upFlag === MouseFlag.right_up && this.elements.virtualRightBtn) {
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

    bindVirtualMouseDragging() {
      const { virtualMouse, virtualMouseHeader, videoContainer } = this.elements;
      if (!virtualMouse || !virtualMouseHeader || !videoContainer) return;

      virtualMouseHeader.addEventListener("touchstart", this.onDragHandleTouchStart, {
        passive: false,
      });
      document.addEventListener("touchmove", this.onDragHandleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onDragHandleTouchEnd, {
        passive: false,
      });
      document.addEventListener("touchcancel", this.onDragHandleTouchEnd, {
        passive: false,
      });

      // 确保键盘切换按钮点击时不会触发拖动
      const keyboardToggleMouse = document.getElementById("keyboard-toggle-mouse");
      if (keyboardToggleMouse) {
        keyboardToggleMouse.addEventListener("touchstart", (e) => {
          e.stopPropagation();
        }, { passive: true });
        keyboardToggleMouse.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      }
      
      // 确保缩小按钮点击时不会触发拖动
      if (this.elements.virtualMouseMinimize) {
        this.elements.virtualMouseMinimize.addEventListener("touchstart", (e) => {
          e.stopPropagation();
        }, { passive: true });
        this.elements.virtualMouseMinimize.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      }
    }

    bindVirtualKeyboardDragging() {
      const { virtualKeyboard, keyboardHeader, keyboardClose, videoContainer } = this.elements;
      if (!virtualKeyboard || !keyboardHeader || !videoContainer) return;

      keyboardHeader.addEventListener("touchstart", this.onKeyboardDragHandleTouchStart, {
        passive: false,
      });
      document.addEventListener("touchmove", this.onKeyboardDragHandleTouchMove, {
        passive: false,
      });
      document.addEventListener("touchend", this.onKeyboardDragHandleTouchEnd, {
        passive: false,
      });
      document.addEventListener("touchcancel", this.onKeyboardDragHandleTouchEnd, {
        passive: false,
      });

      // 确保关闭按钮点击时不会触发拖动
      if (keyboardClose) {
        keyboardClose.addEventListener("touchstart", (e) => {
          e.stopPropagation();
        }, { passive: true });
        keyboardClose.addEventListener("click", (e) => {
          e.stopPropagation();
        });
      }
    }

    onDragHandleTouchStart(event) {
      const touch = event.touches?.[0];
      if (!touch || !this.elements.virtualMouse) return;
      
      // 检查是否点击在按钮上
      const target = event.target;
      if (target && (
        target.id === "keyboard-toggle-mouse" || 
        target.closest("#keyboard-toggle-mouse") ||
        target.id === "virtual-mouse-minimize" ||
        target.closest("#virtual-mouse-minimize")
      )) {
        return; // 不触发拖动
      }
      
      event.preventDefault();
      const rect = this.elements.virtualMouse.getBoundingClientRect();
      this.state.draggingVirtualMouse = true;
      // 添加dragging类以禁用transition
      this.elements.virtualMouse.classList.add("dragging");
      this.state.dragOffset = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    }

    onDragHandleTouchMove(event) {
      if (!this.state.draggingVirtualMouse) return;
      const touch = event.touches?.[0];
      if (!touch || !this.elements.videoContainer || !this.elements.virtualMouse)
        return;
      event.preventDefault();

      const containerRect = this.elements.videoContainer.getBoundingClientRect();
      // 直接使用触摸位置，减去偏移量
      let newX = touch.clientX - this.state.dragOffset.x - containerRect.left;
      let newY = touch.clientY - this.state.dragOffset.y - containerRect.top;

      const maxX = Math.max(
        0,
        containerRect.width - this.elements.virtualMouse.offsetWidth
      );
      const maxY = Math.max(
        0,
        containerRect.height - this.elements.virtualMouse.offsetHeight
      );

      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      // 直接更新位置，不使用requestAnimationFrame以保持跟手
      this.elements.virtualMouse.style.left = `${newX}px`;
      this.elements.virtualMouse.style.top = `${newY}px`;
      this.elements.virtualMouse.style.bottom = "auto";
      this.elements.virtualMouse.style.transform = "none";
    }

    onDragHandleTouchEnd() {
      this.state.draggingVirtualMouse = false;
      // 移除dragging类以恢复transition
      if (this.elements.virtualMouse) {
        this.elements.virtualMouse.classList.remove("dragging");
      }
    }

    onDragHandleClick(event) {
      event.stopPropagation();
      this.elements.virtualMouse?.classList.toggle("minimized");
    }

    onKeyboardDragHandleTouchStart(event) {
      const touch = event.touches?.[0];
      if (!touch || !this.elements.virtualKeyboard) return;
      
      // 检查是否点击在关闭按钮上
      const target = event.target;
      if (target && (target.id === "keyboard-close" || target.closest("#keyboard-close"))) {
        return; // 不触发拖动
      }
      
      event.preventDefault();
      const rect = this.elements.virtualKeyboard.getBoundingClientRect();
      this.state.draggingVirtualKeyboard = true;
      // 添加dragging类以禁用transition
      this.elements.virtualKeyboard.classList.add("dragging");
      this.state.keyboardDragOffset = {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
      };
    }

    onKeyboardDragHandleTouchMove(event) {
      if (!this.state.draggingVirtualKeyboard) return;
      const touch = event.touches?.[0];
      if (!touch || !this.elements.videoContainer || !this.elements.virtualKeyboard)
        return;
      event.preventDefault();

      const containerRect = this.elements.videoContainer.getBoundingClientRect();
      // 直接使用触摸位置，减去偏移量
      let newX = touch.clientX - this.state.keyboardDragOffset.x - containerRect.left;
      let newY = touch.clientY - this.state.keyboardDragOffset.y - containerRect.top;

      const maxX = Math.max(
        0,
        containerRect.width - this.elements.virtualKeyboard.offsetWidth
      );
      const maxY = Math.max(
        0,
        containerRect.height - this.elements.virtualKeyboard.offsetHeight
      );

      newX = Math.max(0, Math.min(newX, maxX));
      newY = Math.max(0, Math.min(newY, maxY));

      // 直接更新位置，不使用requestAnimationFrame以保持跟手
      this.elements.virtualKeyboard.style.left = `${newX}px`;
      this.elements.virtualKeyboard.style.top = `${newY}px`;
      this.elements.virtualKeyboard.style.bottom = "auto";
      this.elements.virtualKeyboard.style.transform = "none";
    }

    onKeyboardDragHandleTouchEnd() {
      this.state.draggingVirtualKeyboard = false;
      // 移除dragging类以恢复transition
      if (this.elements.virtualKeyboard) {
        this.elements.virtualKeyboard.classList.remove("dragging");
      }
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
      return (
        this.state.draggingVirtualMouse ||
        this.state.draggingVirtualKeyboard ||
        this.state.draggingPanel
      );
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
      if (event.target !== this.elements.video && !this.elements.video?.contains(event.target)) {
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
        // Clear single touch state to prevent mouse events
        this.state.touchActive = false;
        this.state.touchStartPos = null;
        this.state.touchLastPos = null;
      } else if (event.touches.length === 1 && !this.state.pinchZoomActive) {
        // Single touch - check for double tap to reset zoom
        const now = Date.now();
        if (now - this.state.lastDoubleTapTime < 300) {
          // Double tap detected - reset zoom
          event.preventDefault();
          this.resetZoom();
          this.state.lastDoubleTapTime = 0;
        } else {
          this.state.lastDoubleTapTime = now;
        }
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
          this.state.initialPinchDistance = this.getTouchDistance(touch1, touch2);
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
              const maxTranslateY = Math.max(0, (scaledHeight - videoHeight) / 2);
              
              // Clamp translation values
              newTranslateX = Math.max(-maxTranslateX, Math.min(maxTranslateX, newTranslateX));
              newTranslateY = Math.max(-maxTranslateY, Math.min(maxTranslateY, newTranslateY));
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
        // Don't prevent default for single touch after pinch ends
        // This allows normal touch handling to resume
      }
    }

    minimizeVirtualMouse() {
      if (!this.elements.virtualMouse || this.state.virtualMouseMinimized) return;
      
      this.state.virtualMouseMinimized = true;
      this.elements.virtualMouse.classList.add("minimized-to-statusbar");
      this.elements.virtualMouse.style.display = "none";
      
      // Show restore button in status bar
      if (this.elements.virtualMouseRestore) {
        this.elements.virtualMouseRestore.style.display = "inline-flex";
        // Position relative to connection status group
        const statusGroup = document.querySelector(".connection-status-group");
        if (statusGroup && this.elements.virtualMouseRestore.parentElement) {
          const statusGroupRect = statusGroup.getBoundingClientRect();
          const parentRect = this.elements.virtualMouseRestore.parentElement.getBoundingClientRect();
          const leftOffset = statusGroupRect.left - parentRect.left - 48; // 36px button + 12px gap
          this.elements.virtualMouseRestore.style.left = `${leftOffset}px`;
          this.elements.virtualMouseRestore.style.right = "auto";
          this.elements.virtualMouseRestore.style.top = "0";
          this.elements.virtualMouseRestore.style.transform = "none";
        }
      }
    }
    
    restoreVirtualMouse() {
      if (!this.elements.virtualMouse || !this.state.virtualMouseMinimized) return;
      
      this.state.virtualMouseMinimized = false;
      this.elements.virtualMouse.classList.remove("minimized-to-statusbar");
      this.elements.virtualMouse.style.display = "flex";
      
      // Hide restore button in status bar
      if (this.elements.virtualMouseRestore) {
        this.elements.virtualMouseRestore.style.display = "none";
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

