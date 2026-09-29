// Update this and the asset cache keys with: node scripts/set-version.js <version>
const WEB_CLIENT_VERSION = "2026.09.24.2";

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
  connectedPanel: document.getElementById("connected-panel"),
  panelCollapsedBar: document.getElementById("panel-collapsed-bar"),
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
const CONNECT_BUTTON_DEFAULT_TEXT = elements.connectBtn
  ? elements.connectBtn.textContent
  : "连接";
let trackIndex = 0; // Track index for display_id (0, 1, 2, ...)
const trackMap = new Map(); // Map<index, track> - stores tracks by their display_id index

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
  elements.audioToggleBtn.style.display = visible ? "inline-flex" : "none";
}

function updateAudioToggleState() {
  if (!elements.audioToggleBtn || !elements.audio) return;

  const hasAudio = !!elements.audio.srcObject;
  setAudioToggleVisible(hasAudio);
  if (!hasAudio) return;

  const isPlaying = !elements.audio.paused && !elements.audio.muted;
  elements.audioToggleBtn.classList.toggle("audio-is-playing", isPlaying);
  const actionLabel = isPlaying ? "静音" : "播放音频";
  elements.audioToggleBtn.setAttribute(
    "aria-label",
    actionLabel
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
  disconnect();
  setConnectionFeedback(message, "error");
}

function handleSignalingMessage(message) {
  if (!isPlainObject(message) || typeof message.type !== "string") {
    return;
  }

  // login, user_join_transmission, and offer may all carry a freshly issued
  // credential. Applying it here guarantees offer handling sees it first.
  applyDynamicTurnCredentials(message);

  switch (message.type) {
    case "session_ticket":
      if (["transmission_id", "host_id", "guest_id", "token"].every(key =>
          typeof message[key] === "string") && message.token.length === 64 &&
          message.guest_id === clientId) {
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
      handleOffer({ type: "offer", sdp: message.sdp });
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
      if (!pc) return;
      if (typeof message.candidate !== "string" || message.candidate.length === 0) {
        console.warn("Invalid ICE candidate message: missing candidate");
        break;
      }
      const candidateInit = {
        candidate: message.candidate,
      };
      if (typeof message.mid === "string" && message.mid.length > 0) {
        candidateInit.sdpMid = message.mid;
      }
      if (
        Number.isInteger(message.sdpMLineIndex) &&
        message.sdpMLineIndex >= 0
      ) {
        candidateInit.sdpMLineIndex = message.sdpMLineIndex;
      }
      if (
        typeof candidateInit.sdpMid !== "string" &&
        !Number.isInteger(candidateInit.sdpMLineIndex)
      ) {
        console.warn("Invalid ICE candidate message: missing mid and sdpMLineIndex");
        break;
      }
      pc.addIceCandidate(
        new RTCIceCandidate(candidateInit)
      ).catch((err) => console.error("Error adding ICE candidate", err));
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
  const peer = createPeerConnection();
  pc = peer;
  peer.setRemoteDescription(offer)
    .then(() => {
      if (!isConnectionSessionActive || peer !== pc) return;
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

  peer.addEventListener("iceconnectionstatechange", () => {
    if (peer !== pc) return;
    const state = peer.iceConnectionState;
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
    if (!isConnectionSessionActive || peer !== pc || !candidate) return;
    sendSignaling(
      {
        type: "new_candidate_mid",
        transmission_id: getTransmissionId(),
        user_id: clientId,
        remote_user_id: getTransmissionId(),
        candidate: candidate.candidate,
        mid: candidate.sdpMid,
      },
      {
        label: "new_candidate_mid",
        onFailure: () => {
          triggerReconnect("candidate_send_failed");
        },
      }
    );
  };

  peer.ontrack = ({ track, streams }) => {
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
    const channel = event.channel;
    control.setDataChannel(channel);
    bindDataChannel(channel);
  };

  return peer;
}

function bindDataChannel(channel) {
  channel.addEventListener("open", () => {
    enableDataChannelUi(true);
  });

  channel.addEventListener("close", () => {
    enableDataChannelUi(false);
    control.setDataChannel(null);
  });

  channel.addEventListener("message", (event) => {
    // Message received (no logging in production)
  });
}

async function sendAnswer(peer) {
  const answer = await peer.createAnswer();
  if (!isConnectionSessionActive || peer !== pc) return;
  await peer.setLocalDescription(answer);
  if (!isConnectionSessionActive || peer !== pc) return;

  // The desktop starts gathering after receiving our answer. Send it now;
  // onicecandidate trickles candidates as they arrive, even if a STUN/TURN
  // server is slow or unreachable. The overall connection timeout still applies.
  const sent = sendSignaling(
    {
      type: "answer",
      transmission_id: getTransmissionId(),
      user_id: clientId,
      remote_user_id: getTransmissionId(),
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
      transmission_id: getTransmissionId(),
    },
    {
      label: "user_leave_transmission",
      suppressWarning: true,
    }
  );
}

function connect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
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
    // Show panel initially when connecting
    if (elements.connectedPanel) {
      isPanelMinimized = false;
      panelAlignment = "left"; // Reset to left alignment
      minimizedPanelPosition = null;
      elements.connectedPanel.classList.remove("minimized");
      positionExpandedPanel();
      hideConnectedPanel(); // Start auto-hide timer
    }
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
  // Clear panel hide timer and reset panel state
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
  isPanelMinimized = false;
  isDragging = false;
  panelAlignment = "left"; // Reset to left alignment
  minimizedPanelPosition = null;
  if (elements.connectedPanel) {
    elements.connectedPanel.classList.remove("minimized");
    positionExpandedPanel();
  }

  if (!sendLeaveRequest()) {
    console.warn("[CrossDesk] Skip leave_transmission: signaling unavailable during disconnect");
  }
  teardownPeerConnection();
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
      if (frameCallbackId !== null) {
        elements.video.cancelVideoFrameCallback(frameCallbackId);
      }
    };
    frameCallbackId = elements.video.requestVideoFrameCallback(callback);
    return;
  }
  
  // Fallback: use loadeddata event (first frame decoded)
  const onFirstFrame = () => {
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

  setAudioToggleVisible(false);

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
  elements.disconnectConnected.addEventListener("click", disconnect);
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

// Panel minimize/maximize and drag functionality
let panelHideTimer = null;
const PANEL_HIDE_DELAY = 3000; // 3 seconds
let isPanelMinimized = false;
let isDragging = false;
let dragStartX = 0;
let dragStartY = 0;
let panelStartLeft = 0;
let panelStartTop = 0;
let panelAlignment = "left"; // "left" or "right" - tracks which edge the minimized panel is closer to
let minimizedPanelPosition = null;
const SNAP_THRESHOLD = 20; // Distance in pixels to trigger edge snapping

function positionExpandedPanel(left = 0, top = 0) {
  if (!elements.connectedPanel) return;
  const maxLeft = Math.max(0, window.innerWidth - elements.connectedPanel.offsetWidth);
  const maxTop = Math.max(0, window.innerHeight - elements.connectedPanel.offsetHeight);
  minimizedPanelPosition = {
    left: Math.max(0, Math.min(left, maxLeft)),
    top: Math.max(0, Math.min(top, maxTop)),
  };
  elements.connectedPanel.style.left = `${minimizedPanelPosition.left}px`;
  elements.connectedPanel.style.top = `${minimizedPanelPosition.top}px`;
  elements.connectedPanel.style.right = "auto";
  elements.connectedPanel.style.bottom = "auto";
}

function clampMinimizedPanelPosition(left, top) {
  const panelWidth = elements.connectedPanel?.offsetWidth || 48;
  const panelHeight = elements.connectedPanel?.offsetHeight || 48;
  return {
    left: Math.max(0, Math.min(left, window.innerWidth - panelWidth)),
    top: Math.max(0, Math.min(top, window.innerHeight - panelHeight)),
  };
}

function rememberMinimizedPanelPosition() {
  if (!elements.connectedPanel) return;
  const rect = elements.connectedPanel.getBoundingClientRect();
  minimizedPanelPosition = clampMinimizedPanelPosition(rect.left, rect.top);
}

function togglePanelMinimize() {
  if (!elements.connectedPanel) return;
  if (isPanelMinimized) {
    rememberMinimizedPanelPosition();
    isPanelMinimized = false;
    elements.connectedPanel.classList.remove("minimized");
    positionExpandedPanel(
      minimizedPanelPosition.left,
      minimizedPanelPosition.top
    );
  } else {
    minimizePanel();
  }
  
  // Clear hide timer when toggling
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
}

function minimizePanel() {
  if (!elements.connectedPanel || isPanelMinimized) return;

  const iconRect = elements.panelCollapsedBar.getBoundingClientRect();
  const targetPosition = minimizedPanelPosition || {
    left: iconRect.left,
    top: iconRect.top,
  };

  isPanelMinimized = true;
  elements.connectedPanel.classList.add("minimized");
  minimizedPanelPosition = clampMinimizedPanelPosition(
    targetPosition.left,
    targetPosition.top
  );

  elements.connectedPanel.style.left = `${minimizedPanelPosition.left}px`;
  elements.connectedPanel.style.top = `${minimizedPanelPosition.top}px`;
  elements.connectedPanel.style.right = "auto";
  elements.connectedPanel.style.bottom = "auto";

  elements.connectedPanel.offsetHeight;
  updatePanelAlignment();
}

function updatePanelAlignment() {
  if (!elements.connectedPanel) return;
  const rect = elements.connectedPanel.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const distanceFromLeft = rect.left;
  const distanceFromRight = viewportWidth - rect.right;
  
  // Determine which edge is closer
  if (distanceFromRight < distanceFromLeft) {
    panelAlignment = "right";
  } else {
    panelAlignment = "left";
  }
}

function applyPanelAlignment() {
  if (!elements.connectedPanel) return;
  
  // This function is no longer used for expanding from minimized state
  // The expansion logic is now handled in togglePanelMinimize and maximizePanel
  // Keep this for backward compatibility but it shouldn't reset position
  const rect = elements.connectedPanel.getBoundingClientRect();
  
  if (panelAlignment === "right") {
    elements.connectedPanel.style.right = "0";
    elements.connectedPanel.style.left = "auto";
  } else {
    elements.connectedPanel.style.left = "0";
    elements.connectedPanel.style.right = "auto";
  }
  // Don't reset top/bottom - keep current position
}

function showConnectedPanel() {
  if (!elements.connectedPanel || isPanelMinimized) return;

  // Clear existing hide timer
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
}

function hideConnectedPanel() {
  if (!elements.connectedPanel) return;
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
  }
  panelHideTimer = setTimeout(() => {
    panelHideTimer = null;
    if (elements.connectedPanel && !isPanelMinimized && !isDragging &&
        !elements.connectedPanel.classList.contains("pointer-lock-within")) {
      minimizePanel();
    }
  }, PANEL_HIDE_DELAY);
}

// Drag functionality for collapsed bar
function startDrag(e) {
  if (!elements.connectedPanel) return;
  isDragging = true;
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
  // Notify control manager to block mouse events during drag
  if (control && control.setDraggingPanel) {
    control.setDraggingPanel(true);
  }
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  dragStartX = clientX;
  dragStartY = clientY;
  
  const rect = elements.connectedPanel.getBoundingClientRect();
  panelStartLeft = rect.left;
  panelStartTop = rect.top;
  
  e.preventDefault();
  document.addEventListener("mousemove", onDrag);
  document.addEventListener("mouseup", stopDrag);
  document.addEventListener("touchmove", onDrag);
  document.addEventListener("touchend", stopDrag);
}

function onDrag(e) {
  if (!isDragging || !elements.connectedPanel) return;
  // Prevent event from propagating to other handlers
  e.preventDefault();
  e.stopPropagation();
  const clientX = e.touches ? e.touches[0].clientX : e.clientX;
  const clientY = e.touches ? e.touches[0].clientY : e.clientY;
  const deltaX = clientX - dragStartX;
  const deltaY = clientY - dragStartY;
  const newLeft = panelStartLeft + deltaX;
  const newTop = panelStartTop + deltaY;
  
  // Constrain to viewport
  const panelWidth = elements.connectedPanel.offsetWidth;
  const panelHeight = elements.connectedPanel.offsetHeight;
  const maxLeft = window.innerWidth - panelWidth;
  const maxTop = window.innerHeight - panelHeight;
  const constrainedLeft = Math.max(0, Math.min(newLeft, maxLeft));
  const constrainedTop = Math.max(0, Math.min(newTop, maxTop));
  
  elements.connectedPanel.style.left = `${constrainedLeft}px`;
  elements.connectedPanel.style.top = `${constrainedTop}px`;
  elements.connectedPanel.style.right = "auto";
  elements.connectedPanel.style.bottom = "auto";

  if (!isPanelMinimized) {
    minimizedPanelPosition = {
      left: constrainedLeft,
      top: constrainedTop,
    };
  }
  
  // Update alignment based on position
  const viewportWidth = window.innerWidth;
  const distanceFromLeft = constrainedLeft;
  const distanceFromRight = viewportWidth - constrainedLeft - panelWidth;
  
  // Determine which edge is closer (with a small threshold to avoid flickering)
  if (distanceFromRight < distanceFromLeft) {
    panelAlignment = "right";
  } else {
    panelAlignment = "left";
  }
}

function stopDrag() {
  isDragging = false;
  // Notify control manager to resume mouse events after drag
  if (control && control.setDraggingPanel) {
    control.setDraggingPanel(false);
  }
  document.removeEventListener("mousemove", onDrag);
  document.removeEventListener("mouseup", stopDrag);
  document.removeEventListener("touchmove", onDrag);
  document.removeEventListener("touchend", stopDrag);
  
  // Snap to nearest edge if close enough
  if (elements.connectedPanel && isPanelMinimized) {
    snapToEdge();
    updatePanelAlignment();
  }
}

function snapToEdge() {
  if (!elements.connectedPanel || !isPanelMinimized) return;
  
  const rect = elements.connectedPanel.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const panelWidth = rect.width;
  const panelHeight = rect.height;
  
  const distanceFromLeft = rect.left;
  const distanceFromRight = viewportWidth - rect.right;
  const distanceFromTop = rect.top;
  const distanceFromBottom = viewportHeight - rect.bottom;
  
  // Find the nearest edge
  const minHorizontal = Math.min(distanceFromLeft, distanceFromRight);
  const minVertical = Math.min(distanceFromTop, distanceFromBottom);
  
  // Snap to horizontal edge if close enough
  if (minHorizontal <= SNAP_THRESHOLD) {
    if (distanceFromLeft < distanceFromRight) {
      elements.connectedPanel.style.left = "0";
      elements.connectedPanel.style.right = "auto";
      panelAlignment = "left";
    } else {
      elements.connectedPanel.style.right = "0";
      elements.connectedPanel.style.left = "auto";
      panelAlignment = "right";
    }
  }
  
  // Snap to vertical edge if close enough
  if (minVertical <= SNAP_THRESHOLD) {
    if (distanceFromTop < distanceFromBottom) {
      elements.connectedPanel.style.top = "0";
      elements.connectedPanel.style.bottom = "auto";
    } else {
      elements.connectedPanel.style.bottom = "0";
      elements.connectedPanel.style.top = "auto";
    }
  }
}

// Show panel when mouse moves to top area or when interacting with panel
if (elements.connectedOverlay) {
  const topTriggerHeight = 80; // Height of top area that triggers panel show
  
  elements.connectedOverlay.addEventListener("mousemove", (e) => {
    if (e.clientY <= topTriggerHeight) {
      showConnectedPanel();
    } else if (
      !isDragging &&
      !elements.connectedPanel?.matches(":hover") &&
      !elements.connectedPanel?.classList.contains("pointer-lock-within") &&
      !isPanelMinimized
    ) {
      hideConnectedPanel();
    }
  });
  
  elements.connectedOverlay.addEventListener("mouseleave", () => {
    if (!isPanelMinimized && !isDragging) {
      hideConnectedPanel();
    }
  });
  
  // Keep panel visible when hovering over it
  if (elements.connectedPanel) {
    elements.connectedPanel.addEventListener("mouseenter", () => {
      if (!isPanelMinimized) {
        showConnectedPanel();
      }
    });
    
    elements.connectedPanel.addEventListener("mouseleave", () => {
      if (!isPanelMinimized && !isDragging) {
        hideConnectedPanel();
      }
    });
  }
  
  // Minimize on collapsed bar click (only when expanded)
  if (elements.panelCollapsedBar) {
    // Use a shared variable to track drag state across event handlers
    let panelDragStarted = false;
    let panelDragStartTime = 0;
    let panelDragStartPos = { x: 0, y: 0 };
    
    // Start drag on collapsed bar (prevent click when dragging)
    elements.panelCollapsedBar.addEventListener("mousedown", (e) => {
      // Immediately prevent event from being handled by control.js
      e.stopPropagation();
      e.preventDefault();
      // Immediately set dragging state to prevent mouse movement
      if (control && control.setDraggingPanel) {
        control.setDraggingPanel(true);
      }
      
      panelDragStarted = false;
      panelDragStartTime = Date.now();
      panelDragStartPos.x = e.clientX;
      panelDragStartPos.y = e.clientY;
      
      const onMouseMove = (moveEvent) => {
        moveEvent.stopPropagation();
        const deltaX = Math.abs(moveEvent.clientX - panelDragStartPos.x);
        const deltaY = Math.abs(moveEvent.clientY - panelDragStartPos.y);
        if (deltaX > 5 || deltaY > 5) {
          panelDragStarted = true;
          startDrag(moveEvent);
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
        }
      };
      
      const onMouseUp = (upEvent) => {
        upEvent.stopPropagation();
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        
        if (upEvent.crossdeskPointerCancelled) {
          panelDragStarted = false;
          control?.setDraggingPanel(false);
          return;
        }

        // If it was a quick click (not a drag), handle it immediately
        const clickDuration = Date.now() - panelDragStartTime;
        const deltaX = Math.abs(upEvent.clientX - panelDragStartPos.x);
        const deltaY = Math.abs(upEvent.clientY - panelDragStartPos.y);
        
        if (!panelDragStarted && clickDuration < 300 && deltaX <= 5 && deltaY <= 5) {
          // It was a click, not a drag
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
          // Handle click immediately
          if (!isPanelMinimized) {
            minimizePanel();
          } else {
            togglePanelMinimize();
          }
        } else if (panelDragStarted) {
          // It was a drag, reset dragging state
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
        } else {
          // Reset dragging state if it wasn't a click or drag
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
        }
        // Reset drag flag
        panelDragStarted = false;
      };
      
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });
    
    elements.panelCollapsedBar.addEventListener("touchstart", (e) => {
      // Immediately prevent event from being handled by control.js
      e.stopPropagation();
      e.preventDefault();
      // Immediately set dragging state to prevent mouse movement
      if (control && control.setDraggingPanel) {
        control.setDraggingPanel(true);
      }
      
      panelDragStarted = false;
      panelDragStartTime = Date.now();
      panelDragStartPos.x = e.touches[0].clientX;
      panelDragStartPos.y = e.touches[0].clientY;
      
      const onTouchMove = (moveEvent) => {
        moveEvent.stopPropagation();
        const deltaX = Math.abs(moveEvent.touches[0].clientX - panelDragStartPos.x);
        const deltaY = Math.abs(moveEvent.touches[0].clientY - panelDragStartPos.y);
        if (deltaX > 5 || deltaY > 5) {
          panelDragStarted = true;
          startDrag(moveEvent);
          document.removeEventListener("touchmove", onTouchMove);
          document.removeEventListener("touchend", onTouchEnd);
    }
      };
      
      const onTouchEnd = (endEvent) => {
        endEvent.stopPropagation();
        document.removeEventListener("touchmove", onTouchMove);
        document.removeEventListener("touchend", onTouchEnd);
        
        // If it was a quick tap (not a drag), handle it immediately
        const tapDuration = Date.now() - panelDragStartTime;
        const endX = endEvent.changedTouches && endEvent.changedTouches[0] ? endEvent.changedTouches[0].clientX : panelDragStartPos.x;
        const endY = endEvent.changedTouches && endEvent.changedTouches[0] ? endEvent.changedTouches[0].clientY : panelDragStartPos.y;
        const deltaX = Math.abs(endX - panelDragStartPos.x);
        const deltaY = Math.abs(endY - panelDragStartPos.y);
        
        if (!panelDragStarted && tapDuration < 300 && deltaX <= 5 && deltaY <= 5) {
          // It was a tap, not a drag
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
          // Handle tap immediately
          if (!isPanelMinimized) {
            minimizePanel();
          } else {
            togglePanelMinimize();
          }
        } else if (panelDragStarted) {
          // It was a drag, reset dragging state
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
        } else {
          // Reset dragging state if it wasn't a tap or drag
          if (control && control.setDraggingPanel) {
            control.setDraggingPanel(false);
          }
        }
        // Reset drag flag
        panelDragStarted = false;
      };
      
      document.addEventListener("touchmove", onTouchMove);
      document.addEventListener("touchend", onTouchEnd);
    }, { passive: false });
  }
  
  
  // Show panel when clicking on video (for touch devices)
  if (elements.video) {
    elements.video.addEventListener("click", (e) => {
      if (
        !isPanelMinimized &&
        (e.clientY <= topTriggerHeight || e.target === elements.video)
      ) {
        showConnectedPanel();
        hideConnectedPanel();
      }
    });
  }
}

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
  if (event.clipboardData) {
    event.clipboardData.setData("text/plain", "");
  }
  return false;
});

document.addEventListener("cut", (event) => {
  if (!shouldGuardInteraction(event)) return;
  event.preventDefault();
  if (event.clipboardData) {
    event.clipboardData.setData("text/plain", "");
  }
  return false;
});

document.addEventListener("paste", (event) => {
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
