// Native display identity and acknowledgement semantics, shared by Web sessions.
(function () {
  const encoder = new TextEncoder();
  const validMode = value => value && Number.isInteger(value.width) && Number.isInteger(value.height) &&
    value.width > 0 && value.width <= 32768 && value.height > 0 && value.height <= 32768;
  const validKey = key => typeof key === "string" && key.length > 0 && key.length <= 1024 &&
    !key.includes("\0") && encoder.encode(key).length <= 1024;
  const sameMode = (a, b) => a.width === b.width && a.height === b.height;
  const preference = value => ({ display_key: value.display_key, width: value.width, height: value.height });
  // The existing Web input router accepts 4 KiB numeric actions. Reserve room
  // for host information and input-epoch fields; retain the newest selections.
  const MAX_PREFERENCES_BYTES = 3500;
  const bytes = value => encoder.encode(JSON.stringify(value)).length;

  function readDisplays(values) {
    if (!Array.isArray(values) || values.length > 32) return null;
    const ids = new Set(), keys = new Set(), result = [];
    for (const value of values) {
      if (!validMode(value) || !Number.isInteger(value.display_id) || value.display_id < 0 ||
          value.display_id >= 32 || ids.has(value.display_id) || !validKey(value.display_key) ||
          keys.has(value.display_key) || !Array.isArray(value.modes) || value.modes.length > 256 ||
          !value.modes.every(validMode)) return null;
      ids.add(value.display_id); keys.add(value.display_key);
      result.push({ ...preference(value), display_id: value.display_id,
        modes: value.modes.map(mode => ({ width: mode.width, height: mode.height })) });
    }
    return result;
  }

  class ResolutionStore {
    constructor(server, remoteId) {
      this.key = "";
      try {
        const url = new URL(server);
        if (["ws:", "wss:"].includes(url.protocol) && remoteId)
          this.key = "crossdesk.remoteDisplayResolutions.v1:" + JSON.stringify([url.origin, url.pathname, remoteId]);
      } catch (_) {}
    }
    load() {
      try {
        if (!this.key) return [];
        const text = window.localStorage.getItem(this.key) || "[]";
        if (text.length > MAX_PREFERENCES_BYTES || encoder.encode(text).length > MAX_PREFERENCES_BYTES) return [];
        const values = JSON.parse(text), keys = new Set();
        if (!Array.isArray(values) || values.length > 32) return [];
        for (const value of values) {
          if (!validMode(value) || !validKey(value.display_key) || keys.has(value.display_key)) return [];
          keys.add(value.display_key);
        }
        return values.map(preference);
      } catch (_) { return []; }
    }
    remember(value) {
      try {
        if (!this.key) return false;
        const values = this.load().filter(saved => saved.display_key !== value.display_key);
        values.push(preference(value));
        while (values.length > 32 || bytes(values) > MAX_PREFERENCES_BYTES) values.shift();
        if (!values.length) return false;
        window.localStorage.setItem(this.key, JSON.stringify(values));
        return true;
      } catch (_) { return false; }
    }
  }

  class DisplayResolutionSession {
    constructor({ server, remoteId, isCurrent, send, onchange }) {
      this.isCurrent = isCurrent;
      this.send = send;
      this.onchange = onchange;
      this.store = new ResolutionStore(server, remoteId);
      this.channel = null;
      this.closed = false;
      this.advertised = false;
      this.timer = null;
      this.requestId = 0;
      this.state = { status: "waiting", displays: [], requested: null, storageFailed: false };
    }
    current(channel = this.channel) {
      return !this.closed && channel === this.channel && this.isCurrent(channel);
    }
    get ready() { return this.current() && this.channel?.readyState === "open"; }
    get pending() { return this.state.status === "pending"; }
    display(id) { return this.state.displays.find(display => display.display_id === id); }
    notify() { this.onchange(this); }
    bind(channel) {
      this.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.addEventListener("message", event => void this.receive(event.data, channel));
      channel.addEventListener("open", () => this.advertise());
      channel.addEventListener("close", () => { if (this.current(channel)) this.close(); });
      if (this.ready) this.advertise();
      this.notify();
    }
    advertise() {
      if (!this.ready || this.advertised) return;
      // Send before other host-info advertisements: the host consumes startup
      // preferences once and applies them before allowing screen capture.
      this.advertised = this.send({ type: 3, host_info: {
        host_name: "Web 浏览器", display_num: 0, displays: [], platform: "unknown",
        preferred_display_resolutions: this.store.load(),
      } });
    }
    clearTimer() {
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    }
    remember(value) { this.state.storageFailed = !this.store.remember(value); }
    request(displayId, displayKey, mode) {
      const display = this.display(displayId);
      if (!this.ready || this.pending || !display || display.display_key !== displayKey ||
          !validMode(mode) || !display.modes.some(value => sameMode(value, mode))) return false;
      this.state.storageFailed = false;
      if (sameMode(display, mode)) {
        this.state.requested = null;
        this.state.status = "applied";
        this.remember(display); this.notify();
        return true;
      }
      this.requestId = ((this.requestId + 1) >>> 0) || 1;
      const request = { display_id: displayId, display_key: displayKey,
        width: mode.width, height: mode.height, request_id: this.requestId, accepted: false };
      this.clearTimer();
      this.state.requested = request;
      this.state.status = "pending";
      const action = { type: 15, display_resolution: request };
      // Leave room for reliable input sequence fields added by control.send.
      if (bytes(action) > 4000 || !this.send(action)) {
        this.state.requested = null;
        this.state.status = "failed";
        this.notify();
        return false;
      }
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.current() && this.state.requested === request && this.pending) {
          this.state.status = "timeout"; this.notify();
        }
      }, 10000);
      this.notify();
      return true;
    }
    async receive(data, channel) {
      if (!this.current(channel)) return;
      try {
        if (data instanceof ArrayBuffer) {
          if (data.byteLength > 1048576) return;
          data = new TextDecoder().decode(data);
        } else if (typeof data?.text === "function") {
          if (data.size > 1048576) return;
          data = await data.text();
        }
        if (!this.current(channel) || typeof data !== "string" || data.length > 1048576 ||
            encoder.encode(data).length > 1048576) return;
        const message = JSON.parse(data);
        if (message?.type === 3 && message.host_info && typeof message.host_info === "object" && !Array.isArray(message.host_info)) {
          const values = message.host_info.display_resolutions;
          const displays = readDisplays(values === undefined ? [] : values);
          if (!displays) return;
          this.state.displays = displays;
          const request = this.state.requested, display = request && this.display(request.display_id);
          if (request && (!display || display.display_key !== request.display_key ||
              !display.modes.some(mode => sameMode(mode, request)))) {
            this.clearTimer();
            this.state.requested = null;
            this.state.status = "failed";
          } else if (["waiting", "unsupported"].includes(this.state.status)) {
            this.state.status = displays.length ? "ready" : "unsupported";
          }
          this.advertise();
          this.notify();
        } else if (message?.type === 16) {
          const request = this.state.requested, response = message.display_resolution;
          if (!request || !response || typeof response.accepted !== "boolean" ||
              !["display_id", "display_key", "width", "height", "request_id"].every(key => response[key] === request[key])) return;
          const displays = readDisplays(message.display_resolutions);
          if (!displays) return;
          this.clearTimer();
          this.state.displays = displays;
          const display = this.display(request.display_id);
          const success = response.accepted && display?.display_key === request.display_key && sameMode(display, request);
          this.state.status = success ? "applied" : "failed";
          // A late matching ACK is valid until a newer selection supersedes it.
          if (success) this.remember(request);
          this.notify();
        }
      } catch (_) { /* Ignore unrelated or malformed control messages. */ }
    }
    close() {
      this.closed = true;
      this.clearTimer();
      this.state = { status: "closed", displays: [], requested: null, storageFailed: false };
      this.notify();
    }
  }
  window.CrossDeskDisplayResolutionSession = DisplayResolutionSession;
})();
