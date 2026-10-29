// Update this and the asset cache keys with: node scripts/set-version.js <version>
const WEB_CLIENT_VERSION = "2026.10.29.1";

const elements = {
  clientVersion: document.getElementById("client-version"),
  connectedClientVersion: document.getElementById("connected-client-version"),
  connectionForm: document.getElementById("connection-form"),
  transmissionIdInput: document.getElementById("transmission-id"),
  transmissionPwdInput: document.getElementById("transmission-pwd"),
  connectionFeedback: document.getElementById("connection-feedback"),
  displaySelect: document.getElementById("display-id"),
  connectBtn: document.getElementById("connect"),
  retrySignalingBtn: document.getElementById("retry-signaling"),
  disconnectBtn: document.getElementById("disconnect"),
  media: document.getElementById("media"),
  videoContainer: document.getElementById("video-container"),
  video: document.getElementById("video"),
  audio: document.getElementById("audio"),
  audioToggleBtn: document.getElementById("audio-toggle"),
  connectionOverlay: document.getElementById("connection-overlay"),
  connectedOverlay: document.getElementById("connected-overlay"),
  connectingOverlay: document.getElementById("connecting-overlay"),
  connectingMessageText: document.getElementById("connecting-message-text"),
  connectionStatusLed: document.getElementById("connection-status-led"),
  connectionStatusIndicator: document.getElementById("connection-status-indicator"),
  connectedStatusLed: document.getElementById("connected-status-led"),
  disconnectConnected: document.getElementById("disconnect-connected"),
};

for (const label of [elements.clientVersion, elements.connectedClientVersion]) {
  if (!label) continue;
  label.textContent = `version ${WEB_CLIENT_VERSION}`;
  label.hidden = false;
}

// Config section (can be overridden by setting window.CROSSDESK_CONFIG before this script runs)
const DEFAULT_CONFIG = {
  signalingUrl: "wss://api.crossdesk.cn:9099",
  iceServers: [
    { urls: ["stun:api.crossdesk.cn:3478"] },
  ],
  heartbeatIntervalMs: 3000,
  heartbeatTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  reconnectMaxDelayMs: 30000,
  reconnectMaxAttempts: 8,
  connectionTimeoutMs: 20000,
  iceDisconnectedTimeoutMs: 5000,
  interactionGuardEnabled: true,
  interactionGuardScope: "video", // "video" | "global" | "none"
  clientTag: "web",
};
const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.CROSSDESK_CONFIG || {});

const control = window.CrossDeskControl;
const turnCredentials = window.CrossDeskTurnCredentials;
let pc = null;
let dynamicTurnCredentials = null;
let clientId = "000000";
let isLoggedIn = false;
let websocket = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let loginIdentity = null;
let sessionTicket = null;

function reportSession() {
  if (!sessionTicket || !isLoggedIn) return;
  // Let ICE finish or recover from a brief interruption before deciding.
  // Explicit disconnect and terminal failures set the session inactive first.
  if (isConnectionSessionActive && pc &&
      !["connected", "completed", "failed", "closed"].includes(pc.iceConnectionState)) return;
  const alive = isConnectionSessionActive && pc &&
    (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed");
  sendSignaling({...sessionTicket, type: "session_report", alive: Boolean(alive)},
    {label: "session_report", suppressWarning: true});
}
let lastPongAt = Date.now();
let connectHintTimer = null;
let connectionTimeoutTimer = null;
let iceDisconnectedTimer = null;
let isConnectionSessionActive = false;
let connectionSession = null;
let connectionAttempt = 0;
const MAX_PENDING_ICE_CANDIDATES = 256;
const ICE_CANDIDATE_TTL_MS = 30000;
const CONNECT_BUTTON_DEFAULT_TEXT = elements.connectBtn
  ? elements.connectBtn.textContent
  : "连接";
let trackIndex = 0; // Track index for display_id (0, 1, 2, ...)
const trackMap = new Map(); // Map<index, track> - stores tracks by their display_id index

// Pin routing to the connection attempt, not to editable form fields. Older
// signaling servers may omit routing fields; validate every field they supply.
function isCurrentSessionMessage(message) {
  const session = connectionSession;
  return isConnectionSessionActive && session &&
    (message.transmission_id === undefined || message.transmission_id === session.transmissionId) &&
    (message.remote_user_id === undefined || message.remote_user_id === session.transmissionId);
}

function iceUfrags(sdp) {
  return new Set(Array.from((sdp || "").matchAll(/^a=ice-ufrag:([^\s]+)\s*$/gm), match => match[1]));
}

function parseRemoteIceCandidate(message) {
  if (typeof message.candidate !== "string" || message.candidate.length > 4096 ||
      /[\r\n\0]/.test(message.candidate)) return null;
  const candidate = message.candidate.replace(/^a=/, "").trim();
  if (candidate && !candidate.startsWith("candidate:")) return null;
  const init = { candidate };
  if (message.mid !== undefined && message.mid !== null) {
    if (typeof message.mid !== "string" || !message.mid || message.mid.length > 256 ||
        /[\s\0]/.test(message.mid)) return null;
    init.sdpMid = message.mid;
  }
  if (message.sdpMLineIndex !== undefined && message.sdpMLineIndex !== null) {
    if (!Number.isInteger(message.sdpMLineIndex) || message.sdpMLineIndex < 0 ||
        message.sdpMLineIndex > 65535) return null;
    init.sdpMLineIndex = message.sdpMLineIndex;
  }
  if (candidate && init.sdpMid === undefined && init.sdpMLineIndex === undefined) return null;
  const embedded = candidate.match(/(?:^|\s)ufrag\s+(\S+)(?:\s|$)/)?.[1];
  for (const ufrag of [message.ufrag, message.usernameFragment, embedded]) {
    if (ufrag === undefined || ufrag === null) continue;
    if (typeof ufrag !== "string" || !ufrag || ufrag.length > 256 || /[\s\0]/.test(ufrag) ||
        (init.usernameFragment && init.usernameFragment !== ufrag)) return null;
    init.usernameFragment = ufrag;
  }
  return init;
}

function receiveRemoteIceCandidate(message) {
  if (!isCurrentSessionMessage(message)) return;
  const session = connectionSession;
  const init = parseRemoteIceCandidate(message);
  if (!init) {
    session.rejectedCandidates++;
    return;
  }
  if (session.retiredUfrags.has(init.usernameFragment)) {
    session.rejectedCandidates++;
    return;
  }
  const now = Date.now();
  session.pendingCandidates = session.pendingCandidates.filter(entry => now - entry.at < ICE_CANDIDATE_TTL_MS);
  const key = JSON.stringify(init);
  if (session.pendingCandidates.some(entry => entry.key === key) ||
      pc?.crossdeskCandidateKeys?.has(key)) return;
  if (session.pendingCandidates.length + (pc?.crossdeskPendingCandidateAdds || 0) >= MAX_PENDING_ICE_CANDIDATES) {
    session.rejectedCandidates++;
    return;
  }
  session.pendingCandidates.push({ init, key, at: now });
  if (pc?.crossdeskRemoteDescriptionReady) flushRemoteIceCandidates(pc);
}

function flushRemoteIceCandidates(peer) {
  const session = peer.crossdeskSession;
  if (peer !== pc || session !== connectionSession || !isConnectionSessionActive ||
      !peer.crossdeskRemoteDescriptionReady) return;
  const pending = session.pendingCandidates;
  session.pendingCandidates = [];
  for (const entry of pending) {
    const ufrag = entry.init.usernameFragment;
    if (Date.now() - entry.at >= ICE_CANDIDATE_TTL_MS || session.retiredUfrags.has(ufrag)) continue;
    if (ufrag && !peer.crossdeskRemoteUfrags.has(ufrag)) {
      // A candidate for the next offer can arrive before that offer. Keep it
      // bounded and separate from the current ICE generation.
      session.pendingCandidates.push(entry);
      continue;
    }
    if (peer.crossdeskCandidateKeys.has(entry.key)) continue;
    if (peer.crossdeskCandidateKeys.size >= 512)
      peer.crossdeskCandidateKeys.delete(peer.crossdeskCandidateKeys.values().next().value);
    peer.crossdeskCandidateKeys.add(entry.key);
    peer.crossdeskPendingCandidateAdds++;
    peer.crossdeskCandidateChain = peer.crossdeskCandidateChain.then(async () => {
      try {
        if (!isConnectionSessionActive || peer !== pc || connectionSession !== session) return;
        await peer.addIceCandidate(entry.init);
        if (peer === pc) peer.crossdeskIceDiagnostics.candidate("remote", entry.init.candidate);
      } catch (err) {
        if (peer !== pc) return;
        session.rejectedCandidates++;
        peer.crossdeskIceDiagnostics.event("candidate_error", { name: err.name });
        console.warn("[CrossDesk] Could not add ICE candidate", err.name);
      } finally {
        peer.crossdeskPendingCandidateAdds--;
      }
    });
  }
}

// Keep diagnostics useful before media arrives and after failure, without
// recording SDP, ICE/TURN credentials, device IDs, or candidate IP addresses.
function describeIceCandidate(candidate) {
  const fields = typeof candidate === "string" ? candidate.replace(/^a=/, "").split(/\s+/) : null;
  const address = fields ? fields[4] : candidate?.address;
  const type = fields ? fields[7] : candidate?.candidateType;
  const protocol = (fields ? fields[2] : candidate?.protocol)?.toLowerCase();
  return {
    type: ["host", "srflx", "prflx", "relay"].includes(type) ? type : "unknown",
    protocol: ["udp", "tcp"].includes(protocol) ? protocol : "unknown",
    family: !address ? "unknown" : address.endsWith(".local") ? "mdns" : address.includes(":") ? "ipv6" : "ipv4",
    relay_protocol: candidate?.relayProtocol,
  };
}

function selectedIcePair(stats) {
  let pair = null;
  stats.forEach(report => {
    if (report.type === "transport" && report.selectedCandidatePairId)
      pair = stats.get(report.selectedCandidatePairId) || pair;
  });
  if (!pair) stats.forEach(report => {
    if (report.type === "candidate-pair" && report.state === "succeeded" &&
        (report.nominated || report.selected)) pair = report;
  });
  return pair;
}

class BrowserIceDiagnostics {
  constructor(peer) {
    this.peer = peer;
    this.session = peer.crossdeskSession;
    this.startedAt = Date.now();
    this.state = {
      version: 1, attempt: this.session.id, generation: this.session.generation,
      started_at: new Date(this.startedAt).toISOString(), elapsed_ms: 0,
      route: "unknown", first_route: null, route_at_30s: null,
      local_candidates: [], remote_candidates: [], candidate_pairs: [], events: [],
    };
    window.CrossDeskIceDiagnostics = this.state;
    this.event("created");
    for (const event of ["icegatheringstatechange", "signalingstatechange", "connectionstatechange"]) {
      peer.addEventListener(event, () => {
        if (peer === pc) this.event(event);
      });
    }
    peer.addEventListener("icecandidateerror", event => {
      if (peer !== pc) return;
      this.event("server_error", { code: event.errorCode,
        scheme: /^(stuns?|turns?):/.exec(event.url || "")?.[1] });
    });
  }

  event(type, detail = {}) {
    this.state.elapsed_ms = Date.now() - this.startedAt;
    this.state.ice_state = this.peer.iceConnectionState;
    this.state.gathering_state = this.peer.iceGatheringState;
    this.state.connection_state = this.peer.connectionState;
    this.state.signaling_state = this.peer.signalingState;
    this.state.pending_candidates = this.session.pendingCandidates.length;
    this.state.rejected_candidates = this.session.rejectedCandidates;
    this.state.events.push({ at_ms: this.state.elapsed_ms, type, ...detail,
      ice_state: this.state.ice_state, gathering_state: this.state.gathering_state });
    if (this.state.events.length > 128) this.state.events.shift();
  }

  candidate(side, candidate) {
    if (!candidate) return this.event(`${side}_gathering_complete`);
    const summary = { at_ms: Date.now() - this.startedAt, ...describeIceCandidate(candidate) };
    const list = this.state[`${side}_candidates`];
    if (list.length < 128) list.push(summary);
    const key = `first_${side}_${summary.type}_ms`;
    if (this.state[key] === undefined) this.state[key] = summary.at_ms;
  }

  sample(stats) {
    const pair = selectedIcePair(stats);
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    const route = local?.candidateType === "relay" || remote?.candidateType === "relay"
      ? "relay" : local && remote ? "direct" : "unknown";
    this.state.elapsed_ms = Date.now() - this.startedAt;
    this.state.pending_candidates = this.session.pendingCandidates.length;
    this.state.rejected_candidates = this.session.rejectedCandidates;
    if (this.state.route !== route) {
      this.state.route = route;
      this.event("route", { route });
    }
    if (route !== "unknown" && !this.state.first_route) {
      this.state.first_route = route;
      this.state.first_route_ms = this.state.elapsed_ms;
    }
    if (this.state.elapsed_ms >= 30000 && this.state.route_at_30s === null)
      this.state.route_at_30s = route;
    const pairs = [];
    stats.forEach(report => {
      if (report.type !== "candidate-pair" || pairs.length >= 128) return;
      pairs.push({ state: report.state, nominated: report.nominated, selected: report === pair,
        local: describeIceCandidate(stats.get(report.localCandidateId)),
        remote: describeIceCandidate(stats.get(report.remoteCandidateId)),
        requests_sent: report.requestsSent, responses_received: report.responsesReceived,
        rtt_ms: Number.isFinite(report.currentRoundTripTime) ? Math.round(report.currentRoundTripTime * 1000) : undefined });
    });
    this.state.candidate_pairs = pairs;
  }
}

// The desktop/mobile wire format: quality 0/1/2, preference 0/1/2.
// Match mobile choices, with quality priority and 30 fps as Web defaults.
const DEFAULT_VIDEO_SETTINGS = Object.freeze({ quality: 2, frame_rate: 30, preference: 1 });
class BrowserVideoSettings {
  constructor(peer) {
    this.peer = peer;
    this.channel = null;
    this.timer = null;
    this.closed = false;
    this.attempted = false;
    this.requestId = 0;
    this.requests = new Map();
    this.state = { status: "waiting", supported: false,
      selection: { ...DEFAULT_VIDEO_SETTINGS }, requested: null, applied: null };
  }

  notify() { window.CrossDeskSessionControls?.renderSettings(this.state); }

  bind(channel) {
    this.channel = channel;
    window.CrossDeskVideoSettings = this.state;
    this.notify();
    channel.binaryType = "arraybuffer";
    channel.addEventListener("message", (event) => void this.receive(event.data, channel));
    channel.addEventListener("open", () => this.requestDefault());
    channel.addEventListener("close", () => {
      if (this.channel === channel) this.close();
    });
  }

  current(channel = this.channel) {
    return !this.closed && this.peer === pc && channel === this.channel &&
      control.dataChannel === channel;
  }

  requestDefault() {
    if (!this.attempted) this.request(DEFAULT_VIDEO_SETTINGS);
  }

  request(values = DEFAULT_VIDEO_SETTINGS) {
    if (!this.current() || !this.state.supported || this.channel.readyState !== "open" || !values ||
        !Number.isInteger(values.quality) || values.quality < 0 || values.quality > 2 ||
        ![30, 60].includes(values.frame_rate) || !Number.isInteger(values.preference) ||
        values.preference < 0 || values.preference > 2) return false;
    this.attempted = true;
    this.requestId = (this.requestId + 1) >>> 0;
    const requested = { quality: values.quality, frame_rate: values.frame_rate,
      preference: values.preference, request_id: this.requestId };
    this.state.requested = requested;
    this.state.selection = { ...requested };
    this.state.status = "pending";
    this.clearTimer();
    this.requests.set(requested.request_id, requested);
    // Bound history while still accepting delayed acknowledgements of superseded requests.
    if (this.requests.size > 64) this.requests.delete(this.requests.keys().next().value);
    // Preserve the reliable input epoch barrier used by the native protocol.
    if (!control.send({ type: 11, video_settings: requested })) {
      this.requests.delete(requested.request_id);
      this.rollback("failed");
      return false;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.current() && this.requestId === requested.request_id &&
          this.state.status === "pending") this.rollback("timeout");
    }, 5000);
    this.notify();
    return true;
  }

  clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  rollback(status) {
    this.state.status = status;
    this.state.selection = { ...(this.state.applied || DEFAULT_VIDEO_SETTINGS) };
    this.notify();
  }

  async receive(data, channel) {
    if (!this.current(channel)) return;
    try {
      if (data instanceof ArrayBuffer) data = new TextDecoder().decode(data);
      else if (typeof data !== "string" && typeof data?.text === "function") data = await data.text();
      if (!this.current(channel) || typeof data !== "string" || data.length > 65536) return;
      const message = JSON.parse(data);
      if (message?.type === 3) {
        this.state.supported = message.host_info?.supports_video_settings === true;
        if (!this.state.supported) {
          this.clearTimer();
          this.requests.clear();
          this.attempted = false;
          this.rollback("unsupported");
        } else {
          this.requestDefault();
          this.notify();
        }
      } else if (message?.type === 12 && this.state.supported) {
        const settings = message.video_settings;
        const requested = this.requests.get(settings?.request_id);
        if (!requested || typeof settings.accepted !== "boolean" ||
            !Object.entries(requested).every(([key, value]) => settings[key] === value)) return;
        this.requests.delete(settings.request_id);
        // Signed subtraction matches the native UInt32 sequence wrap rules.
        if (settings.accepted && (!this.state.applied ||
            ((settings.request_id - this.state.applied.request_id) | 0) >= 0)) {
          this.state.applied = { ...settings };
        }
        if (settings.request_id === this.requestId) {
          this.clearTimer();
          this.rollback(settings.accepted ? "applied" : "rejected");
        } else if (this.state.status !== "pending") {
          this.rollback(this.state.status);
        }
      }
    } catch (err) {
      // Unrelated or malformed control data cannot change negotiated settings.
    }
  }

  close() {
    this.closed = true;
    this.clearTimer();
    this.requests.clear();
    if (window.CrossDeskVideoSettings === this.state) {
      window.CrossDeskVideoSettings = null;
      window.CrossDeskSessionControls?.renderSettings(null);
    }
  }
}

class BrowserQosSession {
  constructor(peer) {
    this.peer = peer;
    this.channel = null;
    this.timer = null;
    this.closed = false;
    this.busy = false;
    this.previous = new Map();
    this.sequence = 0;
    this.sender = null;
  }

  start() {
    if (this.closed || this.timer !== null || typeof this.peer.getStats !== "function") return;
    this.previous.clear();
    this.timer = setInterval(() => void this.sample(), 500);
    void this.sample();
  }

  attach(channel) {
    if (this.closed) return;
    this.channel = channel;
    const start = () => this.start();
    channel.addEventListener("open", start);
    channel.addEventListener("close", () => {
      if (this.channel === channel) {
        this.channel = null;
        this.sender = null;
      }
    });
    channel.addEventListener("message", ({ data }) => {
      if (this.closed || this.channel !== channel) return;
      if (typeof data !== "string" || data.length > 4096) return;
      try {
        const report = JSON.parse(data);
        if (report.type === "web_qos_status" && report.version === 1) this.sender = report;
      } catch (err) {}
    });
    if (channel.readyState === "open") start();
  }

  async sample() {
    if (this.busy || this.closed || this.peer !== pc) return;
    this.busy = true;
    try {
      const stats = await this.peer.getStats();
      if (this.closed || this.peer !== pc) return;
      this.peer.crossdeskIceDiagnostics?.sample(stats);
      const next = new Map();
      let packets = 0, lost = 0, jitterMs = 0, decodeMs = 0, fps = 0;
      let frozen = false, sampled = false, rttMs = 0, pair = null;
      let receivedBps = 0;
      let width = 0, height = 0;
      const displayedTrack = elements.video?.srcObject?.getVideoTracks?.()[0]?.id;
      stats.forEach((report) => {
        if (report.type === "transport" && report.selectedCandidatePairId)
          pair = stats.get(report.selectedCandidatePairId) || pair;
        if (report.type !== "inbound-rtp" ||
            (report.kind || report.mediaType) !== "video") return;
        const previous = this.previous.get(report.id);
        const current = { report, lastDecoded: previous?.lastDecoded ?? report.timestamp };
        next.set(report.id, current);
        if (!previous) return;
        const prev = previous.report;
        const elapsed = (report.timestamp - prev.timestamp) / 1000;
        const delta = (key) => Number.isFinite(report[key]) && Number.isFinite(prev[key]) &&
          report[key] >= prev[key] ? report[key] - prev[key] : 0;
        // Counters reset on a new SSRC/decoder; never mix across epochs.
        if (!(elapsed > 0 && elapsed <= 5) ||
            report.packetsReceived < prev.packetsReceived ||
            report.framesDecoded < prev.framesDecoded) {
          current.lastDecoded = report.timestamp;
          return;
        }
        sampled = true;
        const received = delta("packetsReceived"), missing = delta("packetsLost");
        packets += received + missing;
        lost += missing;
        receivedBps += delta("bytesReceived") * 8 / elapsed;
        // All tracks consume bandwidth, but an unselected display may not be
        // decoded by the browser. It must not be mistaken for a frozen screen.
        if (displayedTrack && report.trackIdentifier &&
            report.trackIdentifier !== displayedTrack) return;
        width = report.frameWidth || width;
        height = report.frameHeight || height;
        const frames = delta("framesDecoded");
        if (frames) current.lastDecoded = report.timestamp;
        // freezeCount can increment after playback has already recovered.
        // Only report an ongoing stall while new media is actually arriving;
        // idle sources and paused/background reception are not decoder load.
        if (received > 0 &&
            report.timestamp - current.lastDecoded >= 1500) frozen = true;
        const emitted = delta("jitterBufferEmittedCount");
        if (emitted) jitterMs = Math.max(jitterMs, delta("jitterBufferDelay") * 1000 / emitted);
        if (frames) decodeMs = Math.max(decodeMs, delta("totalDecodeTime") * 1000 / frames);
        fps = Math.max(fps, frames / elapsed);
      });
      this.previous = next;
      if (!pair) stats.forEach((report) => {
        if (report.type === "candidate-pair" && report.state === "succeeded" &&
            (report.nominated || report.selected)) pair = report;
      });
      if (Number.isFinite(pair?.currentRoundTripTime)) rttMs = Math.round(pair.currentRoundTripTime * 1000);
      const channel = this.channel;
      if (!sampled) return;
      const remote = pair ? stats.get(pair.remoteCandidateId) : null;
      const local = pair ? stats.get(pair.localCandidateId) : null;
      const relay = remote?.candidateType === "relay" || local?.candidateType === "relay";
      const route = relay ? "relay" : local && remote ? "direct" : "unknown";
      // ICE's candidate protocol can be UDP even when TURN uses TCP/TLS.
      // Only the local relay candidate exposes that browser-to-TURN transport.
      const relayProtocol = local?.candidateType === "relay" ? local.relayProtocol : undefined;
      const report = { type: "web_qos", version: 1, sequence: ++this.sequence,
        packets, lost, rtt_ms: rttMs, jitter_ms: jitterMs,
        received_bps: Math.round(receivedBps),
        decode_ms: decodeMs, fps, frozen, width, height,
        route, relay_protocol: relayProtocol || "unknown" };
      // Local network diagnostics also work with hosts without the QoS extension.
      if (channel?.readyState === "open" && channel.bufferedAmount <= 4096) {
        try { channel.send(JSON.stringify(report)); } catch (err) {}
      }
      const diagnostics = { ...report,
        protocol: relayProtocol || local?.protocol,
        local_candidate_type: local?.candidateType, remote_candidate_type: remote?.candidateType,
        sender: this.sender, video_settings: this.peer.crossdeskVideoSettings?.state };
      window.CrossDeskStats = diagnostics;
      const label = document.getElementById("connection-quality");
      if (label) {
        label.hidden = false;
        const routeLabel = route === "relay"
          ? `中继${relayProtocol ? "/" + relayProtocol.toUpperCase() : ""}`
          : route === "direct" ? "直连" : "路径待确认";
        label.textContent = `${width && height ? `${width}×${height} · ` : ""}${Math.round(fps)} fps · ${rttMs} ms · ${routeLabel}`;
        label.title = `画面缓冲 ${Math.round(jitterMs)} ms，解码 ${Math.round(decodeMs)} ms，` +
          `接收 ${(receivedBps / 1000000).toFixed(2)} Mbps，丢包 ${(packets ? lost / packets * 100 : 0).toFixed(1)}%`;
      }
      window.CrossDeskSessionControls?.renderNetwork(diagnostics);
    } catch (err) {
      // Missing stats or a closing channel must not interrupt remote control.
    } finally {
      this.busy = false;
    }
  }

  close() {
    this.closed = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.channel = null;
    this.previous.clear();
    window.CrossDeskStats = null;
    window.CrossDeskSessionControls?.renderNetwork(null);
    const label = document.getElementById("connection-quality");
    if (label) label.hidden = true;
  }
}

const SignalingConnectionState = Object.freeze({
  connecting: "connecting",
  connected: "connected",
  reconnecting: "reconnecting",
  disconnected: "disconnected",
});
let signalingConnectionState = SignalingConnectionState.disconnected;
const RECONNECT_BASE_DELAY_MS = Math.max(
  500,
  Number(CONFIG.reconnectDelayMs) || 1000
);
const RECONNECT_MAX_DELAY_MS = Math.max(
  RECONNECT_BASE_DELAY_MS,
  Number(CONFIG.reconnectMaxDelayMs) || 30000
);
const RECONNECT_MAX_ATTEMPTS = Number.isFinite(Number(CONFIG.reconnectMaxAttempts))
  ? Math.max(1, Number(CONFIG.reconnectMaxAttempts))
  : 8;
const CONNECTION_TIMEOUT_MS = Math.max(
  1000,
  Number(CONFIG.connectionTimeoutMs) || 20000
);
const ICE_DISCONNECTED_TIMEOUT_MS = Math.max(
  1000,
  Number(CONFIG.iceDisconnectedTimeoutMs) || 5000
);

function setAudioToggleVisible(visible) {
  if (!elements.audioToggleBtn) return;
  elements.audioToggleBtn.disabled = !visible;
}

function updateAudioToggleState() {
  if (!elements.audioToggleBtn || !elements.audio) return;

  const hasAudio = !!elements.audio.srcObject;
  setAudioToggleVisible(hasAudio);
  if (!hasAudio) return;

  const isPlaying = !elements.audio.paused && !elements.audio.muted;
  elements.audioToggleBtn.classList.toggle("audio-is-playing", isPlaying);
  const actionLabel = isPlaying ? "声音" : "静音";
  const label = document.getElementById("audio-toggle-label");
  if (label) label.textContent = actionLabel;
  elements.audioToggleBtn.setAttribute(
    "aria-label",
    isPlaying ? "静音" : "播放音频"
  );
  elements.audioToggleBtn.setAttribute(
    "aria-pressed",
    isPlaying ? "false" : "true"
  );
}

async function tryPlayRemoteAudio() {
  if (!elements.audio?.srcObject) return false;

  elements.audio.muted = false;
  try {
    await elements.audio.play();
    updateAudioToggleState();
    return true;
  } catch (err) {
    updateAudioToggleState();
    console.warn("Remote audio playback requires user interaction:", err);
    return false;
  }
}

async function toggleRemoteAudio() {
  if (!elements.audio?.srcObject) return;

  const isPlaying = !elements.audio.paused && !elements.audio.muted;
  if (isPlaying) {
    elements.audio.muted = true;
    updateAudioToggleState();
    return;
  }

  await tryPlayRemoteAudio();
}

function isSignalingOpen() {
  return !!websocket && websocket.readyState === WebSocket.OPEN;
}

function sendSignaling(payload, options = {}) {
  const {
    label = "signaling",
    onFailure = null,
    suppressWarning = false,
  } = options;

  if (!isSignalingOpen()) {
    if (!suppressWarning) {
      console.warn(`[CrossDesk] Skip signaling send (${label}): socket not open`);
    }
    if (typeof onFailure === "function") {
      try {
        onFailure("not_open");
      } catch (callbackErr) {
        console.error("sendSignaling onFailure callback failed", callbackErr);
      }
    }
    return false;
  }
  try {
    websocket.send(
      typeof payload === "string" ? payload : JSON.stringify(payload)
    );
    return true;
  } catch (err) {
    console.error(`[CrossDesk] Failed signaling send (${label})`, err);
    if (typeof onFailure === "function") {
      try {
        onFailure("send_error", err);
      } catch (callbackErr) {
        console.error("sendSignaling onFailure callback failed", callbackErr);
      }
    }
    return false;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getIceServers() {
  // A negotiated list is authoritative, including an intentionally empty list.
  // Its freshness is checked before creating the peer, not during an active call.
  if (connectionSession?.iceConfig) return connectionSession.iceConfig.iceServers;
  const configuredServers = Array.isArray(CONFIG.iceServers)
    ? CONFIG.iceServers.slice()
    : [];

  if (!dynamicTurnCredentials) return configuredServers;
  if (dynamicTurnCredentials.expiresAt <= Math.floor(Date.now() / 1000)) {
    dynamicTurnCredentials = null;
    return configuredServers;
  }

  configuredServers.push(dynamicTurnCredentials.iceServer);
  return configuredServers;
}

function applyDynamicTurnCredentials(message) {
  if (!Object.prototype.hasOwnProperty.call(message, "turn")) return false;
  if (!turnCredentials?.parseTurnCredentials) {
    console.error("[CrossDesk] TURN credential helper is unavailable");
    return false;
  }

  const parsed = turnCredentials.parseTurnCredentials(message.turn);
  if (!parsed) {
    console.warn("[CrossDesk] Ignore malformed or expired dynamic TURN credentials");
    return false;
  }

  dynamicTurnCredentials = parsed;

  // setConfiguration only affects subsequent candidate gathering/ICE restarts;
  // it does not interrupt an already established relay allocation.
  if (pc && pc.signalingState !== "closed") {
    try {
      pc.setConfiguration({ iceServers: getIceServers() });
    } catch (err) {
      console.warn("[CrossDesk] Failed to update active peer TURN configuration", err);
    }
  }

  return true;
}

function parseSignalingMessage(rawData) {
  let message;
  try {
    message = JSON.parse(rawData);
  } catch (err) {
    console.warn("Invalid signaling message JSON", err);
    return null;
  }

  if (!isPlainObject(message)) {
    console.warn("Invalid signaling message payload type");
    return null;
  }

  if (typeof message.type !== "string" || message.type.length === 0) {
    console.warn("Invalid signaling message type");
    return null;
  }

  return message;
}

function setConnectionFeedback(message = "", tone = "") {
  if (!elements.connectionFeedback) return;
  elements.connectionFeedback.textContent = message;
  if (tone) {
    elements.connectionFeedback.dataset.tone = tone;
  } else {
    delete elements.connectionFeedback.dataset.tone;
  }
}

function getNormalizedTransmissionId() {
  return elements.transmissionIdInput?.value.replace(/\s+/g, "") || "";
}

function getNormalizedTransmissionPwd() {
  return elements.transmissionPwdInput?.value.trim().slice(0, 6) || "";
}

function isConnectionFormValid() {
  return (
    getNormalizedTransmissionId().length > 0 &&
    getNormalizedTransmissionPwd().length === 6
  );
}

function validateConnectionForm(showFeedback = true) {
  const hasTransmissionId = getNormalizedTransmissionId().length > 0;
  const hasValidPassword = getNormalizedTransmissionPwd().length === 6;

  elements.transmissionIdInput?.setAttribute(
    "aria-invalid",
    hasTransmissionId ? "false" : "true"
  );
  elements.transmissionPwdInput?.setAttribute(
    "aria-invalid",
    hasValidPassword ? "false" : "true"
  );

  if (showFeedback) {
    if (!hasTransmissionId) {
      setConnectionFeedback("请输入远程设备 ID", "error");
    } else if (!hasValidPassword) {
      setConnectionFeedback("请输入 6 位密码", "error");
    }
  }

  return hasTransmissionId && hasValidPassword;
}

function clearConnectionFieldErrors() {
  elements.transmissionIdInput?.setAttribute("aria-invalid", "false");
  elements.transmissionPwdInput?.setAttribute("aria-invalid", "false");
}

function updateConnectAvailability() {
  const canConnect =
    signalingConnectionState === SignalingConnectionState.connected &&
    isLoggedIn &&
    isConnectionFormValid();
  enableConnectButton(canConnect);
  if (elements.connectBtn && !connectHintTimer) {
    elements.connectBtn.textContent = CONNECT_BUTTON_DEFAULT_TEXT;
  }
}

function showConnectInitializingHint() {
  if (!elements.connectBtn) return;
  if (connectHintTimer) {
    clearTimeout(connectHintTimer);
  }
  elements.connectBtn.textContent = "初始化中...";
  elements.connectBtn.disabled = true;
  connectHintTimer = setTimeout(() => {
    connectHintTimer = null;
    updateConnectAvailability();
  }, 1500);
}

function setSignalingConnectionState(nextState) {
  signalingConnectionState = nextState;

  updateConnectAvailability();

  if (nextState === SignalingConnectionState.connecting) {
    setConnectionFeedback("正在连接服务器...", "info");
  } else if (nextState === SignalingConnectionState.reconnecting) {
    setConnectionFeedback("服务器连接中断，正在重连...", "info");
  } else if (nextState === SignalingConnectionState.disconnected) {
    setConnectionFeedback("无法连接服务器，请重试", "error");
  } else if (!isLoggedIn) {
    setConnectionFeedback("正在初始化连接...", "info");
  }

  if (elements.retrySignalingBtn) {
    const showRetry =
      nextState === SignalingConnectionState.reconnecting ||
      nextState === SignalingConnectionState.disconnected;
    elements.retrySignalingBtn.style.display = showRetry ? "inline-block" : "none";
    elements.retrySignalingBtn.disabled = false;
  }
}

function connectSignaling(isReconnect = false) {
  stopHeartbeat();
  isLoggedIn = false;
  clientId = "000000";
  dynamicTurnCredentials = null;
  if (connectHintTimer) {
    clearTimeout(connectHintTimer);
    connectHintTimer = null;
  }

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  const previousSocket = websocket;
  if (previousSocket) {
    websocket = null;
    try {
      previousSocket.close();
    } catch (err) {}
  }

  setSignalingConnectionState(
    isReconnect
      ? SignalingConnectionState.reconnecting
      : SignalingConnectionState.connecting
  );

  let socket;
  try {
    socket = new WebSocket(CONFIG.signalingUrl);
  } catch (err) {
    console.error("Failed to create signaling websocket", err);
    scheduleReconnect("socket_create_failed");
    return;
  }

  websocket = socket;

  socket.addEventListener("message", (event) => {
    if (socket !== websocket) return;
    if (typeof event.data !== "string") return;

    const message = parseSignalingMessage(event.data);
    if (!message) return;

    if (message.type === "pong") {
      lastPongAt = Date.now();
      return;
    }

    handleSignalingMessage(message);
  });

  socket.addEventListener("open", () => {
    if (socket !== websocket) return;
    reconnectAttempt = 0;
    setSignalingConnectionState(SignalingConnectionState.connected);
    sendLogin();
    startHeartbeat();
  });

  socket.addEventListener("close", () => {
    if (socket !== websocket) return;
    websocket = null;
    stopHeartbeat();
    scheduleReconnect("socket_closed");
  });

  socket.addEventListener("error", () => {
    if (socket !== websocket) return;
    scheduleReconnect("socket_error");
  });
}

function getNextReconnectDelayMs(nextAttempt) {
  return Math.min(
    RECONNECT_MAX_DELAY_MS,
    RECONNECT_BASE_DELAY_MS * Math.pow(2, Math.max(0, nextAttempt - 1))
  );
}

function scheduleReconnect(reason = "unknown") {
  if (reconnectTimer) return;

  stopHeartbeat();

  if (reconnectAttempt >= RECONNECT_MAX_ATTEMPTS) {
    setSignalingConnectionState(SignalingConnectionState.disconnected);
    return;
  }

  const nextAttempt = reconnectAttempt + 1;
  const delayMs = getNextReconnectDelayMs(nextAttempt);
  setSignalingConnectionState(SignalingConnectionState.reconnecting);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempt = nextAttempt;
    connectSignaling(true);
  }, delayMs);
}

function triggerReconnect(reason) {
  scheduleReconnect(reason);
  const socket = websocket;
  if (!socket) return;
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    try {
      socket.close();
    } catch (err) {}
  }
}

function retrySignalingNow() {
  reconnectAttempt = 0;
  connectSignaling(true);
}

function clearConnectionTimeout() {
  if (!connectionTimeoutTimer) return;
  clearTimeout(connectionTimeoutTimer);
  connectionTimeoutTimer = null;
}

function startConnectionTimeout() {
  clearConnectionTimeout();
  connectionTimeoutTimer = setTimeout(() => {
    connectionTimeoutTimer = null;
    failConnection("连接超时，请检查远程设备状态后重试");
  }, CONNECTION_TIMEOUT_MS);
}

function clearIceDisconnectedTimeout() {
  if (!iceDisconnectedTimer) return;
  clearTimeout(iceDisconnectedTimer);
  iceDisconnectedTimer = null;
}

function startIceDisconnectedTimeout(peer) {
  clearIceDisconnectedTimeout();
  iceDisconnectedTimer = setTimeout(() => {
    iceDisconnectedTimer = null;
    if (
      isConnectionSessionActive &&
      pc === peer &&
      peer.iceConnectionState === "disconnected"
    ) {
      failConnection("连接已断开，请检查网络后重试");
    }
  }, ICE_DISCONNECTED_TIMEOUT_MS);
}

function failConnection(message) {
  if (!isConnectionSessionActive) return;
  pc?.crossdeskIceDiagnostics?.event("failure");
  disconnect();
  setConnectionFeedback(message, "error");
}

function handleSignalingMessage(message) {
  if (!isPlainObject(message) || typeof message.type !== "string") {
    return;
  }
  if (["offer", "new_candidate_mid", "user_join_transmission"].includes(message.type) &&
      !isCurrentSessionMessage(message)) return;

  // login, user_join_transmission, and offer may all carry a freshly issued
  // credential. Applying it here guarantees offer handling sees it first.
  applyDynamicTurnCredentials(message);

  switch (message.type) {
    case "session_ticket":
      if (["transmission_id", "host_id", "guest_id", "token"].every(key =>
          typeof message[key] === "string") && message.token.length === 64 &&
          message.guest_id === clientId && connectionSession &&
          message.transmission_id === connectionSession.transmissionId) {
        sessionTicket = message;
      }
      break;
    case "session_resumed":
      break;
    case "login":
      if (typeof message.user_id === "string" && message.user_id.trim().length > 0) {
        const nextClientId = message.user_id.trim().split("@")[0];
        if (!nextClientId) {
          console.warn("Invalid login message user_id");
          break;
        }
        clientId = nextClientId;
        if (message.user_id.includes("@")) loginIdentity = message.user_id.trim();
        isLoggedIn = true;
        reportSession();
        if (connectHintTimer) {
          clearTimeout(connectHintTimer);
          connectHintTimer = null;
        }
        updateConnectAvailability();
        setConnectionFeedback();
      } else {
        console.warn("Invalid login message: missing user_id");
      }
      break;
    case "user_join_transmission":
      // Handle join transmission response
      if (message.status === "failed") {
        let errorMessage = "连接失败，请稍后重试";
        if (message.reason === "No such transmission id") {
          errorMessage = "没有该设备";
        } else if (message.reason === "Incorrect password") {
          errorMessage = "密码错误";
        }
        failConnection(errorMessage);
      }
      break;
    case "offer":
      if (!isConnectionSessionActive) return;
      if (typeof message.sdp !== "string" || message.sdp.length === 0) {
        console.warn("Invalid offer message: missing sdp");
        failConnection("连接失败，请稍后重试");
        break;
      }
      connectionSession.iceConfig = null;
      if (Object.prototype.hasOwnProperty.call(message, "ice")) {
        const config = turnCredentials?.parseIceConfiguration?.(message.ice);
        if (!config) {
          failConnection("连接配置无效或已过期，请重试");
          break;
        }
        connectionSession.iceConfig = config;
      }
      try {
        handleOffer({ type: "offer", sdp: message.sdp });
      } catch (err) {
        console.error("Failed to create peer connection", err.name);
        failConnection("连接失败，请检查连接配置后重试");
      }
      break;
    case "turn_credentials":
      if (message.status !== "success") {
        console.warn(
          "[CrossDesk] Failed to refresh dynamic TURN credentials:",
          message.reason || "Unknown error"
        );
      }
      break;
    case "new_candidate_mid":
      receiveRemoteIceCandidate(message);
      break;
    default:
      break;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  lastPongAt = Date.now();
  heartbeatTimer = setInterval(() => {
    sendSignaling(
      { type: "ping", ts: Date.now() },
      {
        label: "ping",
        suppressWarning: true,
        onFailure: () => {
          triggerReconnect("ping_send_failed");
        },
      }
    );
    if (Date.now() - lastPongAt > CONFIG.heartbeatTimeoutMs) {
      triggerReconnect("heartbeat_timeout");
    }
  }, CONFIG.heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function sendLogin() {
  sendSignaling(
    { type: "login", user_id: loginIdentity || CONFIG.clientTag, session_resume_version: 1 },
    {
      label: "login",
      onFailure: () => {
        triggerReconnect("login_send_failed");
      },
    }
  );
}

connectSignaling(false);

function handleOffer(offer) {
  const remoteUfrags = iceUfrags(offer.sdp);
  if (pc) {
    for (const ufrag of pc.crossdeskRemoteUfrags) {
      if (!remoteUfrags.has(ufrag)) connectionSession.retiredUfrags.add(ufrag);
    }
    while (connectionSession.retiredUfrags.size > 64)
      connectionSession.retiredUfrags.delete(connectionSession.retiredUfrags.values().next().value);
    // Untagged candidates from a previous peer cannot safely cross generations.
    connectionSession.pendingCandidates = connectionSession.pendingCandidates.filter(entry =>
      entry.init.usernameFragment && !connectionSession.retiredUfrags.has(entry.init.usernameFragment));
    teardownPeerConnection();
    trackIndex = 0;
    trackMap.clear();
    if (elements.displaySelect) {
      elements.displaySelect.innerHTML = '<option value="" selected>候选画面 ID...</option>';
    }
  }
  const peer = createPeerConnection();
  pc = peer;
  peer.crossdeskRemoteUfrags = remoteUfrags;
  peer.crossdeskQos.start();
  peer.setRemoteDescription(offer)
    .then(() => {
      if (!isConnectionSessionActive || peer !== pc) return;
      peer.crossdeskRemoteDescriptionReady = true;
      peer.crossdeskIceDiagnostics.event("remote_description");
      flushRemoteIceCandidates(peer);
      return sendAnswer(peer);
    })
    .catch((err) => {
      if (!isConnectionSessionActive || peer !== pc) return;
      console.error("Failed to handle offer", err);
      failConnection("连接失败，请稍后重试");
    });
}

function createPeerConnection() {
  const config = {
    iceServers: getIceServers(),
    iceTransportPolicy: "all",
  };

  const peer = new RTCPeerConnection(config);
  peer.crossdeskSession = connectionSession;
  connectionSession.generation++;
  peer.crossdeskRemoteUfrags = new Set();
  peer.crossdeskCandidateKeys = new Set();
  peer.crossdeskCandidateChain = Promise.resolve();
  peer.crossdeskPendingCandidateAdds = 0;
  peer.crossdeskRemoteDescriptionReady = false;
  peer.crossdeskIceDiagnostics = new BrowserIceDiagnostics(peer);
  peer.crossdeskVideoSettings = new BrowserVideoSettings(peer);
  peer.crossdeskFiles = window.CrossDeskFileTransferSession
    ? new window.CrossDeskFileTransferSession(peer) : null;
  peer.crossdeskClipboard = window.CrossDeskClipboardSession
    ? new window.CrossDeskClipboardSession(peer) : null;
  const qos = new BrowserQosSession(peer);
  peer.crossdeskQos = qos;

  peer.addEventListener("iceconnectionstatechange", () => {
    if (peer !== pc) return;
    const state = peer.iceConnectionState;
    peer.crossdeskIceDiagnostics.event("iceconnectionstatechange");
    void qos.sample();
    // Update status LED: connected when ICE state is "connected"
    const isConnected = state === "connected" || state === "completed";
    updateStatusLed(elements.connectionStatusLed, isConnected, true);
    updateStatusLed(elements.connectedStatusLed, isConnected, false);
    
    if (state === "failed") {
      failConnection("连接失败，请检查网络后重试");
      return;
    }

    // Give transient disconnections a short recovery window.
    if (state === "disconnected") {
      if (elements.connectingOverlay && elements.connectingMessageText) {
        elements.connectingMessageText.textContent = "连接已断开，正在恢复...";
        elements.connectingOverlay.style.display = "flex";
      }
      startIceDisconnectedTimeout(peer);
    } else if (state === "connected" || state === "checking" || state === "completed") {
      if (state === "connected" || state === "completed") {
        clearConnectionTimeout();
        clearIceDisconnectedTimeout();
        reportSession();
      }
      // Hide overlay when connected or checking
      if (elements.connectingOverlay) {
        // Only hide if we're not in the initial connecting phase
        // (initial connecting is handled by hideConnectingOverlayOnFirstFrame)
        if (state === "connected" || state === "completed") {
          elements.connectingOverlay.style.display = "none";
        }
      }
    }
  });
  const isConnected = peer.iceConnectionState === "connected";
  updateStatusLed(elements.connectionStatusLed, isConnected, true);
  updateStatusLed(elements.connectedStatusLed, isConnected, false);

  peer.onicecandidate = ({ candidate }) => {
    if (!isConnectionSessionActive || peer !== pc) return;
    peer.crossdeskIceDiagnostics.candidate("local", candidate?.candidate);
    // An empty candidate marks the end of a generation and is forwarded;
    // null only signals that all transports have finished gathering.
    if (!candidate) return;
    const session = peer.crossdeskSession;
    const ufrag = candidate.usernameFragment || iceUfrags(peer.localDescription?.sdp).values().next().value;
    sendSignaling(
      {
        type: "new_candidate_mid",
        transmission_id: session.transmissionId,
        user_id: session.userId,
        remote_user_id: session.transmissionId,
        candidate: candidate.candidate,
        mid: candidate.sdpMid,
        ...(Number.isInteger(candidate.sdpMLineIndex) ? { sdpMLineIndex: candidate.sdpMLineIndex } : {}),
        ...(ufrag ? { ufrag } : {}),
      },
      {
        label: "new_candidate_mid",
        onFailure: () => {
          triggerReconnect("candidate_send_failed");
        },
      }
    );
  };

  peer.ontrack = ({ track, streams, receiver }) => {
    if (peer !== pc) return;
    if (track.kind === "video" && receiver && "jitterBufferTarget" in receiver) {
      try { receiver.jitterBufferTarget = 20; } catch (err) {}
    }
    // Handle audio tracks
    if (track.kind === "audio" && elements.audio) {
      if (!elements.audio.srcObject) {
        // Keep the audio element audio-only even when the remote stream also
        // contains video tracks.
        elements.audio.srcObject = new MediaStream([track]);
        elements.audio.autoplay = true;
      } else {
        // Additional audio track: add to existing stream
        const hasTrack = elements.audio.srcObject
          .getAudioTracks()
          .some((audioTrack) => audioTrack.id === track.id);
        if (!hasTrack) {
          elements.audio.srcObject.addTrack(track);
        }
      }
      updateAudioToggleState();
      void tryPlayRemoteAudio();
      return;
    }
    
    // Handle video tracks
    if (track.kind !== "video" || !elements.video) return;
    
    // Use track index as display_id (0, 1, 2, ...)
    const currentIndex = trackIndex;
    trackIndex++;
    
    // Store track in map
    trackMap.set(currentIndex, track);
    
    if (!elements.video.srcObject) {
      // First track: create new stream
      const stream = streams && streams[0] ? streams[0] : new MediaStream([track]);
      elements.video.srcObject = stream;
      elements.video.muted = true;
      elements.video.setAttribute("playsinline", "true");
      elements.video.setAttribute("webkit-playsinline", "true");
      elements.video.setAttribute("x5-video-player-type", "h5");
      elements.video.setAttribute("x5-video-player-fullscreen", "true");
      elements.video.autoplay = true;
      
      // Wait for first frame to be decoded before hiding connecting overlay
      hideConnectingOverlayOnFirstFrame();
    } else {
      // Additional track: add to existing stream
      elements.video.srcObject.addTrack(track);
    }

    if (!elements.displaySelect) return;
    
    // Remove placeholder option "候选画面 ID..." when first track arrives
    if (currentIndex === 0) {
      const placeholderOption = Array.from(elements.displaySelect.options).find(
        (opt) => opt.value === ""
      );
      if (placeholderOption) {
        placeholderOption.remove();
      }
    }
    
    // Check if option with this index already exists
    const existingOption = Array.from(elements.displaySelect.options).find(
      (opt) => opt.value === String(currentIndex)
    );
    if (!existingOption) {
      const option = document.createElement("option");
      option.value = String(currentIndex);
      option.textContent = track.id || `Display ${currentIndex}`;
      elements.displaySelect.appendChild(option);
    }
    // Only set default value for the first track (index 0)
    // Don't auto-switch when additional tracks arrive
    if (currentIndex === 0 && !elements.displaySelect.value) {
      elements.displaySelect.value = String(currentIndex);
    }
  };

  peer.ondatachannel = (event) => {
    if (peer !== pc) return;
    const channel = event.channel;
    if (peer.crossdeskFiles?.attach(channel)) return;
    if (peer.crossdeskClipboard?.attach(channel)) return;
    if (channel.label === "crossdesk-qos-v1") {
      qos.attach(channel);
      return;
    }
    if (channel.label === "crossdesk-input-v1") {
      const attach = () => {
        if (peer === pc) control.setMotionChannel?.(channel);
      };
      channel.addEventListener("open", attach);
      channel.addEventListener("close", () => {
        if (peer === pc && control.motionChannel === channel) control.setMotionChannel?.(null);
      });
      if (channel.readyState === "open") attach();
      return;
    }
    if (channel.label !== "ping-pong" && channel.label !== "data-stream") return;
    control.setDataChannel(channel);
    bindDataChannel(channel, peer);
  };

  return peer;
}

function bindDataChannel(channel, peer) {
  if (peer.crossdeskVideoSettings.channel && peer.crossdeskVideoSettings.channel !== channel) {
    peer.crossdeskVideoSettings.close();
    peer.crossdeskVideoSettings = new BrowserVideoSettings(peer);
  }
  peer.crossdeskVideoSettings.bind(channel);
  let advertised = false;
  const opened = () => {
    if (peer !== pc || control.dataChannel !== channel) return;
    enableDataChannelUi(true);
    peer.crossdeskQos.start();
    // File support is determined by the registered channels, independently of QoS.
    peer.crossdeskFiles?.probe();
    peer.crossdeskClipboard?.probe();
    // Only probe hosts that advertise support in the channel's DCEP metadata.
    // Legacy hosts parse control messages as numeric action types and would
    // log an error for an unsolicited web_qos_hello.
    if (!advertised && channel.protocol === "crossdesk-control-v1") {
      try {
        channel.send(JSON.stringify({ type: "web_qos_hello", version: 1 }));
        advertised = true;
      } catch (err) {}
    }
  };
  channel.addEventListener("open", opened);
  if (channel.readyState === "open") opened();

  channel.addEventListener("close", () => {
    if (peer !== pc || control.dataChannel !== channel) return;
    enableDataChannelUi(false);
    control.setDataChannel(null);
  });

}

async function sendAnswer(peer) {
  const answer = await peer.createAnswer();
  if (!isConnectionSessionActive || peer !== pc) return;
  await peer.setLocalDescription(answer);
  if (!isConnectionSessionActive || peer !== pc) return;

  // Older desktops start gathering after receiving our answer. Send it now;
  // onicecandidate trickles candidates as they arrive, even if a STUN/TURN
  // server is slow or unreachable. The overall connection timeout still applies.
  const sent = sendSignaling(
    {
      type: "answer",
      transmission_id: peer.crossdeskSession.transmissionId,
      user_id: peer.crossdeskSession.userId,
      remote_user_id: peer.crossdeskSession.transmissionId,
      sdp: peer.localDescription.sdp,
    },
    {
      label: "answer",
      onFailure: () => {
        triggerReconnect("answer_send_failed");
      },
    }
  );
  if (!sent) {
    throw new Error("Failed to send answer");
  }
  peer.crossdeskIceDiagnostics.event("answer_sent");
}

function getTransmissionId() {
  const normalizedId = getNormalizedTransmissionId();
  if (elements.transmissionIdInput) {
    elements.transmissionIdInput.value = normalizedId;
  }
  return normalizedId;
}

function getTransmissionPwd() {
  return getNormalizedTransmissionPwd();
}

function sendJoinRequest() {
  return sendSignaling(
    {
      type: "join_transmission",
      user_id: clientId,
      transmission_id: `${getTransmissionId()}@${getTransmissionPwd()}`,
    },
    { label: "join_transmission" }
  );
}

function sendLeaveRequest() {
  return sendSignaling(
    {
      type: "user_leave_transmission",
      user_id: clientId,
      transmission_id: connectionSession?.transmissionId || getTransmissionId(),
    },
    {
      label: "user_leave_transmission",
      suppressWarning: true,
    }
  );
}

function connect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
  if (isConnectionSessionActive) return;
  if (!validateConnectionForm()) {
    updateConnectAvailability();
    return;
  }
  if (!isSignalingOpen()) {
    showConnectInitializingHint();
    triggerReconnect("connect_without_signaling");
    return;
  }
  if (!isLoggedIn) {
    showConnectInitializingHint();
    return;
  }
  clearConnectionFieldErrors();
  setConnectionFeedback();
  connectionSession = {
    id: ++connectionAttempt, transmissionId: getTransmissionId(), userId: clientId,
    generation: 0, pendingCandidates: [], retiredUfrags: new Set(), rejectedCandidates: 0,
  };
  window.CrossDeskIceDiagnostics = null;
  isConnectionSessionActive = true;
  elements.connectBtn.style.display = "none";
  elements.disconnectBtn.style.display = "inline-block";
  elements.media.style.display = "flex";
  // Hide connection overlay, show connected overlay
  if (elements.connectionOverlay) {
    elements.connectionOverlay.style.display = "none";
  }
  if (elements.connectedOverlay) {
    elements.connectedOverlay.style.display = "block";
    window.CrossDeskSessionControls?.start();
  }
  // Show connecting overlay
  if (elements.connectingOverlay) {
    elements.connectingOverlay.style.display = "flex";
  }
  // Reset connecting message text
  if (elements.connectingMessageText) {
    elements.connectingMessageText.textContent = "连接中...";
  }
  if (!sendJoinRequest()) {
    triggerReconnect("join_send_failed");
    failConnection("服务器连接中断，请稍后重试");
    return;
  }
  startConnectionTimeout();
}

function disconnect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
  control?.setDataChannel(null);
  isConnectionSessionActive = false;
  reportSession();
  sessionTicket = null;
  clearConnectionTimeout();
  clearIceDisconnectedTimeout();
  setConnectionFeedback();
  elements.disconnectBtn.style.display = "none";
  elements.connectBtn.style.display = "inline-block";
  elements.media.style.display = "none";
  // Show connection overlay, hide connected overlay
  if (elements.connectionOverlay) {
    elements.connectionOverlay.style.display = "flex";
  }
  if (elements.connectedOverlay) {
    elements.connectedOverlay.style.display = "none";
  }
  // Hide connecting overlay
  if (elements.connectingOverlay) {
    elements.connectingOverlay.style.display = "none";
  }
  window.CrossDeskSessionControls?.stop();

  if (!sendLeaveRequest()) {
    console.warn("[CrossDesk] Skip leave_transmission: signaling unavailable during disconnect");
  }
  teardownPeerConnection();
  connectionSession = null;
  enableDataChannelUi(false);
  // Reset track index and clear display select options
  trackIndex = 0;
  trackMap.clear();
  if (elements.displaySelect) {
    elements.displaySelect.innerHTML = '<option value="" selected>候选画面 ID...</option>';
  }
  // Reset status LEDs and hide indicator
  updateStatusLed(elements.connectionStatusLed, false, true);
  updateStatusLed(elements.connectedStatusLed, false, false);
  updateConnectAvailability();
}

function hideConnectingOverlayOnFirstFrame() {
  if (!elements.video || !elements.connectingOverlay) return;
  
  // Use requestVideoFrameCallback if available (most accurate)
  if (elements.video.requestVideoFrameCallback) {
    let frameCallbackId = null;
    const callback = () => {
      if (elements.connectingOverlay) {
        elements.connectingOverlay.style.display = "none";
      }
      window.CrossDeskSessionControls?.setVideoReady();
      if (frameCallbackId !== null) {
        elements.video.cancelVideoFrameCallback(frameCallbackId);
      }
    };
    frameCallbackId = elements.video.requestVideoFrameCallback(callback);
    return;
  }
  
  // Fallback: use loadeddata event (first frame decoded)
  const onFirstFrame = () => {
    window.CrossDeskSessionControls?.setVideoReady();
    if (elements.connectingOverlay) {
      elements.connectingOverlay.style.display = "none";
    }
    elements.video.removeEventListener("loadeddata", onFirstFrame);
    elements.video.removeEventListener("canplay", onFirstFrame);
  };
  
  // Try loadeddata first (more accurate - first frame decoded)
  if (elements.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    // Already has data, hide immediately
    onFirstFrame();
  } else {
    elements.video.addEventListener("loadeddata", onFirstFrame, { once: true });
    // Fallback to canplay if loadeddata doesn't fire
    elements.video.addEventListener("canplay", onFirstFrame, { once: true });
  }
}

function teardownPeerConnection() {
  if (!pc) return;

  pc.crossdeskIceDiagnostics?.event("closed");
  setAudioToggleVisible(false);
  pc.crossdeskQos?.close();
  pc.crossdeskVideoSettings?.close();
  pc.crossdeskFiles?.close();
  pc.crossdeskClipboard?.close();
  control.setDataChannel(null);

  try {
    pc.getSenders().forEach((sender) => sender.track?.stop?.());
  } catch (err) {}

  pc.close();
  pc = null;

  if (elements.video?.srcObject) {
    elements.video.srcObject.getTracks().forEach((track) => track.stop());
    elements.video.srcObject = null;
  }
  
  if (elements.audio?.srcObject) {
    elements.audio.srcObject.getTracks().forEach((track) => track.stop());
    elements.audio.srcObject = null;
  }
}

// Update status LED indicator
function updateStatusLed(ledElement, isConnected, showIndicator = true) {
  if (!ledElement) return;
  if (isConnected) {
    ledElement.classList.remove("status-led-off");
    ledElement.classList.add("status-led-on");
    // 显示指示灯容器
    if (showIndicator && elements.connectionStatusIndicator) {
      elements.connectionStatusIndicator.style.display = "flex";
    }
  } else {
    ledElement.classList.remove("status-led-on");
    ledElement.classList.add("status-led-off");
    // 隐藏指示灯容器（未连接时）
    if (showIndicator && elements.connectionStatusIndicator) {
      elements.connectionStatusIndicator.style.display = "none";
    }
  }
}


function enableConnectButton(enabled) {
  if (!elements.connectBtn) return;
  elements.connectBtn.disabled = !enabled;
}

function enableDataChannelUi(enabled) {
  window.CrossDeskSessionControls?.setConnected(enabled);
  if (elements.displaySelect) {
    elements.displaySelect.disabled = !enabled;
  }
}

function setDisplayId() {
  if (!elements.displaySelect) return;
  const raw = elements.displaySelect.value.trim();
  if (!raw) {
    // 如果值为空，不发送（保持原有行为）
    return;
  }
  const parsed = parseInt(raw, 10);
  // 检查解析结果：如果解析失败（NaN）或者不是有效数字，不发送
  if (isNaN(parsed) || !Number.isFinite(parsed)) {
    console.warn("setDisplayId: Invalid display_id value:", raw);
    return;
  }
  
  // Switch video track to the selected display_id
  const selectedTrack = trackMap.get(parsed);
  if (selectedTrack && elements.video) {
    // Don't stop tracks - just replace the stream
    // Stopping tracks makes them unusable
    const newStream = new MediaStream([selectedTrack]);
    elements.video.srcObject = newStream;
    elements.video.muted = true;
    elements.video.setAttribute("playsinline", "true");
    elements.video.setAttribute("webkit-playsinline", "true");
    elements.video.setAttribute("x5-video-player-type", "h5");
    elements.video.setAttribute("x5-video-player-fullscreen", "true");
    elements.video.autoplay = true;
  }
  
  control.sendDisplayId(parsed);
}


if (elements.connectionForm) {
  elements.connectionForm.addEventListener("submit", (event) => {
    event.preventDefault();
    connect();
  });
  elements.connectionForm.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing) return;
    event.preventDefault();
    connect();
  });
}

if (elements.transmissionIdInput && elements.transmissionPwdInput) {
  const onConnectionInput = () => {
    clearConnectionFieldErrors();
    if (
      signalingConnectionState === SignalingConnectionState.connected &&
      isLoggedIn
    ) {
      setConnectionFeedback();
    }
    updateConnectAvailability();
  };
  elements.transmissionIdInput.addEventListener("input", onConnectionInput);
  elements.transmissionPwdInput.addEventListener("input", onConnectionInput);
  elements.transmissionIdInput.addEventListener("blur", () => {
    if (getNormalizedTransmissionId()) return;
    elements.transmissionIdInput.setAttribute("aria-invalid", "true");
    setConnectionFeedback("请输入远程设备 ID", "error");
  });
  elements.transmissionPwdInput.addEventListener("blur", () => {
    if (getNormalizedTransmissionPwd().length === 6) return;
    elements.transmissionPwdInput.setAttribute("aria-invalid", "true");
    setConnectionFeedback("请输入 6 位密码", "error");
  });
}

if (elements.disconnectBtn) {
  elements.disconnectBtn.addEventListener("click", disconnect);
}

if (elements.disconnectConnected) {
  elements.disconnectConnected.addEventListener("click", () =>
    window.CrossDeskSessionControls?.showPage("disconnect"));
}

if (elements.audioToggleBtn) {
  elements.audioToggleBtn.addEventListener("click", () => {
    void toggleRemoteAudio();
  });
}

if (elements.retrySignalingBtn) {
  elements.retrySignalingBtn.addEventListener("click", retrySignalingNow);
}

if (elements.displaySelect) {
  elements.displaySelect.addEventListener("change", setDisplayId);
}

// Session controls own the mobile-style floating orb and menu.
window.CrossDeskSession = {
  defaultVideoSettings: DEFAULT_VIDEO_SETTINGS,
  requestVideoSettings(values) { return pc?.crossdeskVideoSettings?.request(values) || false; },
  disconnect,
};

window.connect = connect;
window.disconnect = disconnect;
window.setDisplayId = setDisplayId;

function isEditableTarget(target) {
  if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }
  return !!target.closest(
    "input, textarea, select, [contenteditable='true'], [contenteditable='']"
  );
}

function shouldGuardInteraction(event) {
  if (!CONFIG.interactionGuardEnabled) return false;
  const scope = String(CONFIG.interactionGuardScope || "video").toLowerCase();
  if (scope === "none") return false;

  const target = event?.target;
  if (!target || typeof Element === "undefined" || !(target instanceof Element)) {
    return false;
  }

  // Always keep editable fields usable for accessibility/password manager flows.
  if (isEditableTarget(target)) return false;

  if (scope === "global") return true;
  if (scope !== "video") return false;

  // Default: only guard interactions inside the remote video interaction area.
  if (elements.videoContainer && elements.videoContainer.contains(target)) {
    return true;
  }
  if (elements.video && elements.video.contains(target)) {
    return true;
  }
  return false;
}

document.addEventListener("copy", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});

document.addEventListener("cut", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});

document.addEventListener("paste", (event) => {
  if (pc?.crossdeskClipboard?.handlePaste(event)) return;
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});

document.addEventListener("contextmenu", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});

document.addEventListener("selectstart", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});

document.addEventListener("dragstart", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  return false;
});
