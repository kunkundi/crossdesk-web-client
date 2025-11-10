const elements = {
  iceState: document.getElementById("ice-connection-state"),
  signalingState: document.getElementById("signaling-state"),
  dataChannelState: document.getElementById("datachannel-state"),
  displaySelect: document.getElementById("display-id"),
  connectBtn: document.getElementById("connect"),
  disconnectBtn: document.getElementById("disconnect"),
  media: document.getElementById("media"),
  video: document.getElementById("video"),
  audio: document.getElementById("audio"),
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

// Config section (can be overridden by setting window.CROSSDESK_CONFIG before this script runs)
const DEFAULT_CONFIG = {
  signalingUrl: "wss://api.crossdesk.cn:9090",
  iceServers: [
    { urls: ["stun:api.crossdesk.cn:3478"] },
    { urls: ["turn:api.crossdesk.cn:3478"], username: "crossdesk", credential: "crossdeskpw" },
  ],
  heartbeatIntervalMs: 3000,
  heartbeatTimeoutMs: 10000,
  reconnectDelayMs: 2000,
  clientTag: "web",
};
const CONFIG = Object.assign({}, DEFAULT_CONFIG, window.CROSSDESK_CONFIG || {});

const control = window.CrossDeskControl;
let pc = null;
let clientId = "000000";
let heartbeatTimer = null;
let lastPongAt = Date.now();
let trackIndex = 0; // Track index for display_id (0, 1, 2, ...)
const trackMap = new Map(); // Map<index, track> - stores tracks by their display_id index

const websocket = new WebSocket(CONFIG.signalingUrl);

websocket.addEventListener("message", (event) => {
  if (typeof event.data !== "string") return;
  const message = JSON.parse(event.data);

  if (message.type === "pong") {
    lastPongAt = Date.now();
    return;
  }

  handleSignalingMessage(message);
});

websocket.addEventListener("open", () => {
  enableConnectButton(true);
  sendLogin();
  startHeartbeat();
});

websocket.addEventListener("close", () => {
  stopHeartbeat();
  enableConnectButton(false);
});

websocket.addEventListener("error", () => {
  stopHeartbeat();
  scheduleReconnect();
});

function handleSignalingMessage(message) {
  switch (message.type) {
    case "login":
      clientId = message.user_id.split("@")[0];
      break;
    case "user_join_transmission":
      // Handle join transmission response
      if (message.status === "failed") {
        let errorMessage = "";
        if (message.reason === "No such transmission id") {
          errorMessage = "没有该设备";
        } else if (message.reason === "Incorrect password") {
          errorMessage = "密码错误";
        }
        
        if (errorMessage && elements.connectingOverlay && elements.connectingMessageText) {
          // Show error message
          elements.connectingMessageText.textContent = errorMessage;
          elements.connectingOverlay.style.display = "flex";
          
          // Reset connection state after showing error for 3 seconds
          setTimeout(() => {
            // Hide connecting overlay first
            if (elements.connectingOverlay) {
              elements.connectingOverlay.style.display = "none";
            }
            // Then disconnect to reset UI
            disconnect();
          }, 3000);
        }
      }
      break;
    case "offer":
      handleOffer(message);
      break;
    case "new_candidate_mid":
      if (!pc) return;
      pc.addIceCandidate(
        new RTCIceCandidate({
          sdpMid: message.mid,
          candidate: message.candidate,
        })
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
    if (websocket.readyState === WebSocket.OPEN) {
      websocket.send(JSON.stringify({ type: "ping", ts: Date.now() }));
    }
    if (Date.now() - lastPongAt > CONFIG.heartbeatTimeoutMs) {
      scheduleReconnect();
    }
  }, CONFIG.heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (!heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect() {
  try {
    websocket.close();
  } catch (err) {}
  setTimeout(() => window.location.reload(), CONFIG.reconnectDelayMs);
}

function sendLogin() {
  websocket.send(JSON.stringify({ type: "login", user_id: CONFIG.clientTag }));
}

function handleOffer(offer) {
  pc = createPeerConnection();
  pc.setRemoteDescription(offer)
    .then(() => sendAnswer(pc))
    .catch((err) => console.error("Failed to handle offer", err));
}

function createPeerConnection() {
  const config = {
    iceServers: CONFIG.iceServers,
    iceTransportPolicy: "all",
  };

  const peer = new RTCPeerConnection(config);

  peer.addEventListener("iceconnectionstatechange", () => {
    const state = peer.iceConnectionState;
    updateStatus(elements.iceState, state);
    // Update status LED: connected when ICE state is "connected"
    const isConnected = state === "connected";
    updateStatusLed(elements.connectionStatusLed, isConnected, true);
    updateStatusLed(elements.connectedStatusLed, isConnected, false);
    
    // Show connection status overlay for disconnected or failed states
    if (state === "disconnected" || state === "failed") {
      if (elements.connectingOverlay && elements.connectingMessageText) {
        // Update message text based on state
        if (state === "disconnected") {
          elements.connectingMessageText.textContent = "连接已断开...";
        } else if (state === "failed") {
          elements.connectingMessageText.textContent = "连接失败...";
        }
        elements.connectingOverlay.style.display = "flex";
      }
    } else if (state === "connected" || state === "checking" || state === "completed") {
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
  updateStatus(elements.iceState, peer.iceConnectionState);
  const isConnected = peer.iceConnectionState === "connected";
  updateStatusLed(elements.connectionStatusLed, isConnected, true);
  updateStatusLed(elements.connectedStatusLed, isConnected, false);

  peer.addEventListener("signalingstatechange", () => {
    updateStatus(elements.signalingState, peer.signalingState);
  });
  updateStatus(elements.signalingState, peer.signalingState);

  peer.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    websocket.send(
      JSON.stringify({
        type: "new_candidate_mid",
        transmission_id: getTransmissionId(),
        user_id: clientId,
        remote_user_id: getTransmissionId(),
        candidate: candidate.candidate,
        mid: candidate.sdpMid,
      })
    );
  };

  peer.ontrack = ({ track, streams }) => {
    // Handle audio tracks
    if (track.kind === "audio" && elements.audio) {
      if (!elements.audio.srcObject) {
        // First audio track: create new stream
        const audioStream = streams && streams[0] ? streams[0] : new MediaStream([track]);
        elements.audio.srcObject = audioStream;
        elements.audio.autoplay = true;
        // Try to play audio (may require user interaction)
        elements.audio.play().catch(err => {
          console.log("Audio autoplay prevented:", err);
        });
      } else {
        // Additional audio track: add to existing stream
        elements.audio.srcObject.addTrack(track);
      }
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
    updateStatus(elements.dataChannelState, "open");
    enableDataChannelUi(true);
  });

  channel.addEventListener("close", () => {
    updateStatus(elements.dataChannelState, "closed");
    enableDataChannelUi(false);
    control.setDataChannel(null);
  });

  channel.addEventListener("message", (event) => {
    // Message received (no logging in production)
  });
}

async function sendAnswer(peer) {
  await peer.setLocalDescription(await peer.createAnswer());
  await waitIceGathering(peer);
  websocket.send(
    JSON.stringify({
      type: "answer",
      transmission_id: getTransmissionId(),
      user_id: clientId,
      remote_user_id: getTransmissionId(),
      sdp: peer.localDescription.sdp,
    })
  );
}

function waitIceGathering(peer) {
  if (peer.iceGatheringState === "complete") {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    peer.addEventListener("icegatheringstatechange", () => {
      if (peer.iceGatheringState === "complete") resolve();
    });
  });
}

function getTransmissionId() {
  return document.getElementById("transmission-id").value.trim();
}

function getTransmissionPwd() {
  return document.getElementById("transmission-pwd").value.trim();
}

function sendJoinRequest() {
  websocket.send(
    JSON.stringify({
      type: "join_transmission",
      user_id: clientId,
      transmission_id: `${getTransmissionId()}@${getTransmissionPwd()}`,
    })
  );
}

function sendLeaveRequest() {
  websocket.send(
    JSON.stringify({
      type: "leave_transmission",
      user_id: clientId,
      transmission_id: getTransmissionId(),
    })
  );
}

function connect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
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
      elements.connectedPanel.classList.remove("minimized");
      elements.connectedPanel.style.left = "0";
      elements.connectedPanel.style.right = "auto";
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
  sendJoinRequest();
}

function disconnect() {
  if (!elements.connectBtn || !elements.disconnectBtn || !elements.media) return;
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
  if (elements.connectedPanel) {
    elements.connectedPanel.classList.remove("minimized");
    elements.connectedPanel.style.left = "0";
    elements.connectedPanel.style.right = "auto";
  }

  sendLeaveRequest();
  teardownPeerConnection();
  enableDataChannelUi(false);
  updateStatus(elements.iceState, "");
  updateStatus(elements.signalingState, "");
  updateStatus(elements.dataChannelState, "closed");
  // Reset track index and clear display select options
  trackIndex = 0;
  trackMap.clear();
  if (elements.displaySelect) {
    elements.displaySelect.innerHTML = '<option value="" selected>候选画面 ID...</option>';
  }
  // Reset status LEDs and hide indicator
  updateStatusLed(elements.connectionStatusLed, false, true);
  updateStatusLed(elements.connectedStatusLed, false, false);
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

function updateStatus(element, value) {
  if (!element) return;
  element.textContent = value || "";
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


if (elements.connectBtn) {
  elements.connectBtn.addEventListener("click", connect);
}

if (elements.disconnectBtn) {
  elements.disconnectBtn.addEventListener("click", disconnect);
}

if (elements.disconnectConnected) {
  elements.disconnectConnected.addEventListener("click", disconnect);
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
let panelCorner = "top-left"; // "top-left", "top-right", "bottom-left", "bottom-right" - tracks which corner the button is at when expanded
const SNAP_THRESHOLD = 20; // Distance in pixels to trigger edge snapping

function calculateExpandPosition(buttonLeft, buttonTop, buttonWidth, buttonHeight) {
  // Estimated panel dimensions (will be updated after layout)
  const estimatedPanelWidth = 400;
  const estimatedPanelHeight = 100;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  
  // Try top-left first (button as top-left corner)
  let expandLeft = buttonLeft;
  let expandTop = buttonTop;
  let expandRight = "auto";
  let expandBottom = "auto";
  let horizontalAlign = "left";
  let verticalAlign = "top";
  
  // Check if panel would overflow right
  if (buttonLeft + estimatedPanelWidth > viewportWidth) {
    // Try top-right (button as top-right corner)
    if (buttonLeft - estimatedPanelWidth >= 0) {
      expandLeft = buttonLeft - estimatedPanelWidth + buttonWidth;
      expandRight = "auto";
      horizontalAlign = "right";
    } else {
      // Panel too wide, align to viewport edge
      expandLeft = "0";
      expandRight = "auto";
      horizontalAlign = "left";
    }
  }
  
  // Check if panel would overflow bottom
  if (buttonTop + estimatedPanelHeight > viewportHeight) {
    // Try bottom-left or bottom-right
    if (buttonTop - estimatedPanelHeight >= 0) {
      expandTop = buttonTop - estimatedPanelHeight + buttonHeight;
      expandBottom = "auto";
      verticalAlign = "bottom";
    } else {
      // Panel too tall, align to viewport edge
      expandTop = "auto";
      expandBottom = "0";
      verticalAlign = "bottom";
    }
  }
  
  return {
    left: expandLeft,
    top: expandTop,
    right: expandRight,
    bottom: expandBottom,
    horizontalAlign,
    verticalAlign
  };
}

function togglePanelMinimize() {
  if (!elements.connectedPanel) return;
  isPanelMinimized = !isPanelMinimized;
  
  if (isPanelMinimized) {
    // Minimizing: keep icon at its current position
    // Get the current icon position BEFORE clearing right/bottom
    // This is critical: getBoundingClientRect() returns the actual rendered position
    // regardless of how the panel is positioned (left/right, top/bottom)
    const iconRect = elements.panelCollapsedBar.getBoundingClientRect();
    let iconLeft = iconRect.left;
    let iconTop = iconRect.top;
    
    // Ensure position is within viewport bounds (handle edge cases like 0, 0)
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const buttonSize = 48; // Size of minimized button
    
    // Clamp to viewport bounds
    iconLeft = Math.max(0, Math.min(iconLeft, viewportWidth - buttonSize));
    iconTop = Math.max(0, Math.min(iconTop, viewportHeight - buttonSize));
    
    elements.connectedPanel.classList.add("minimized");
    // Set left/top and clear right/bottom in a single operation to prevent position jump
    // Place panel at icon's current position (icon is at top-left of panel, so panel position = icon position)
    elements.connectedPanel.style.left = `${iconLeft}px`;
    elements.connectedPanel.style.top = `${iconTop}px`;
    elements.connectedPanel.style.right = "auto";
    elements.connectedPanel.style.bottom = "auto";
    
    // Force a reflow to ensure the position is applied
    elements.connectedPanel.offsetHeight;
  } else {
    // Expanding: calculate position based on button location
    const rect = elements.connectedPanel.getBoundingClientRect();
    const buttonLeft = rect.left;
    const buttonTop = rect.top;
    const buttonWidth = rect.width;
    const buttonHeight = rect.height;
    
    elements.connectedPanel.classList.remove("minimized");
    
    // Calculate optimal expand position
    const pos = calculateExpandPosition(buttonLeft, buttonTop, buttonWidth, buttonHeight);
    
    // Apply position after layout update
    requestAnimationFrame(() => {
      const actualPanelWidth = elements.connectedPanel.offsetWidth;
      const actualPanelHeight = elements.connectedPanel.offsetHeight;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      
      // Always expand with button as top-left corner
      let finalLeft = buttonLeft;
      let finalTop = buttonTop;
      let finalRight = "auto";
      let finalBottom = "auto";
      let corner = "top-left"; // Always use top-left corner
      
      // Check horizontal overflow - ensure panel is fully visible
      if (buttonLeft + actualPanelWidth > viewportWidth) {
        // Panel too wide, align to right edge (right: 0) to ensure it's fully visible
        // Button remains at top-left, but panel right edge touches viewport right edge
        finalLeft = "auto";
        finalRight = 0;
      }
      
      // Check vertical overflow - ensure panel is fully visible
      if (buttonTop + actualPanelHeight > viewportHeight) {
        // Panel too tall, align to bottom edge (bottom: 0) to ensure it's fully visible
        // Button remains at top-left, but panel bottom edge touches viewport bottom edge
        finalTop = "auto";
        finalBottom = 0;
      }
      
      // Final constraint check - ensure panel is completely within viewport
      // Only apply constraints if using left/top positioning
      if (finalLeft !== "auto") {
        finalLeft = Math.max(0, Math.min(finalLeft, viewportWidth - actualPanelWidth));
      }
      if (finalTop !== "auto") {
        finalTop = Math.max(0, Math.min(finalTop, viewportHeight - actualPanelHeight));
      }
      
      // Record the corner position (always top-left)
      panelCorner = corner;
      
      elements.connectedPanel.style.left = typeof finalLeft === "number" ? `${finalLeft}px` : finalLeft;
      elements.connectedPanel.style.top = typeof finalTop === "number" ? `${finalTop}px` : finalTop;
      elements.connectedPanel.style.right = finalRight;
      elements.connectedPanel.style.bottom = finalBottom;
      
      // Update alignment for future reference
      updatePanelAlignment();
    });
  }
  
  // Clear hide timer when toggling
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
}

function minimizePanel() {
  if (!elements.connectedPanel || isPanelMinimized) return;
  
  // Get the current icon position BEFORE clearing right/bottom
  // This is critical: getBoundingClientRect() returns the actual rendered position
  // regardless of how the panel is positioned (left/right, top/bottom)
  const iconRect = elements.panelCollapsedBar.getBoundingClientRect();
  let iconLeft = iconRect.left;
  let iconTop = iconRect.top;
  
  // Ensure position is within viewport bounds (handle edge cases like 0, 0)
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const buttonSize = 48; // Size of minimized button
  
  // Clamp to viewport bounds
  iconLeft = Math.max(0, Math.min(iconLeft, viewportWidth - buttonSize));
  iconTop = Math.max(0, Math.min(iconTop, viewportHeight - buttonSize));
  
  isPanelMinimized = true;
  elements.connectedPanel.classList.add("minimized");
  
  // Set left/top and clear right/bottom in a single operation to prevent position jump
  // Place panel at icon's current position (icon is at top-left of panel, so panel position = icon position)
  elements.connectedPanel.style.left = `${iconLeft}px`;
  elements.connectedPanel.style.top = `${iconTop}px`;
  elements.connectedPanel.style.right = "auto";
  elements.connectedPanel.style.bottom = "auto";
  
  // Force a reflow to ensure the position is applied before any other operations
  elements.connectedPanel.offsetHeight;
  
  // Update alignment based on final button position
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

function maximizePanel() {
  if (!elements.connectedPanel || !isPanelMinimized) return;
  
  // Save current button position before maximizing
  const rect = elements.connectedPanel.getBoundingClientRect();
  const buttonLeft = rect.left;
  const buttonTop = rect.top;
  const buttonWidth = rect.width;
  const buttonHeight = rect.height;
  
  isPanelMinimized = false;
  elements.connectedPanel.classList.remove("minimized");
  
  // Use requestAnimationFrame to ensure layout is updated before setting position
  requestAnimationFrame(() => {
    const actualPanelWidth = elements.connectedPanel.offsetWidth;
    const actualPanelHeight = elements.connectedPanel.offsetHeight;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
      // Always expand with button as top-left corner
      let finalLeft = buttonLeft;
      let finalTop = buttonTop;
      let finalRight = "auto";
      let finalBottom = "auto";
      let corner = "top-left"; // Always use top-left corner
      
      // Check horizontal overflow - ensure panel is fully visible
      if (buttonLeft + actualPanelWidth > viewportWidth) {
        // Panel too wide, align to right edge (right: 0) to ensure it's fully visible
        // Button remains at top-left, but panel right edge touches viewport right edge
        finalLeft = "auto";
        finalRight = 0;
      }
      
      // Check vertical overflow - ensure panel is fully visible
      if (buttonTop + actualPanelHeight > viewportHeight) {
        // Panel too tall, align to bottom edge (bottom: 0) to ensure it's fully visible
        // Button remains at top-left, but panel bottom edge touches viewport bottom edge
        finalTop = "auto";
        finalBottom = 0;
      }
      
      // Final constraint check - ensure panel is completely within viewport
      // Only apply constraints if using left/top positioning
      if (finalLeft !== "auto") {
        finalLeft = Math.max(0, Math.min(finalLeft, viewportWidth - actualPanelWidth));
      }
      if (finalTop !== "auto") {
        finalTop = Math.max(0, Math.min(finalTop, viewportHeight - actualPanelHeight));
      }
      
      // Record the corner position (always top-left)
      panelCorner = corner;
      
      elements.connectedPanel.style.left = typeof finalLeft === "number" ? `${finalLeft}px` : finalLeft;
      elements.connectedPanel.style.top = typeof finalTop === "number" ? `${finalTop}px` : finalTop;
      elements.connectedPanel.style.right = finalRight;
      elements.connectedPanel.style.bottom = finalBottom;
      
      // Update alignment for future reference
      updatePanelAlignment();
  });
}

function showConnectedPanel() {
  if (!elements.connectedPanel) return;
  maximizePanel();
  
  // Clear existing hide timer
  if (panelHideTimer) {
    clearTimeout(panelHideTimer);
    panelHideTimer = null;
  }
}

function hideConnectedPanel() {
  if (!elements.connectedPanel) return;
  panelHideTimer = setTimeout(() => {
    if (elements.connectedPanel && !isPanelMinimized) {
      minimizePanel();
    }
  }, PANEL_HIDE_DELAY);
}

// Drag functionality for collapsed bar
function startDrag(e) {
  if (!elements.connectedPanel) return;
  isDragging = true;
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
    } else if (!elements.connectedPanel?.matches(":hover") && !isPanelMinimized) {
      hideConnectedPanel();
    }
  });
  
  elements.connectedOverlay.addEventListener("mouseleave", () => {
    if (!isPanelMinimized) {
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
      if (!isPanelMinimized) {
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
      if (e.clientY <= topTriggerHeight || e.target === elements.video) {
        if (isPanelMinimized) {
          togglePanelMinimize();
        } else {
          showConnectedPanel();
          hideConnectedPanel();
        }
    }
  });
  }
}

window.connect = connect;
window.disconnect = disconnect;
window.setDisplayId = setDisplayId;

// 禁止复制、剪切、粘贴等操作
document.addEventListener("copy", (event) => {
  event.preventDefault();
  event.clipboardData.setData("text/plain", "");
  return false;
});

document.addEventListener("cut", (event) => {
  event.preventDefault();
  event.clipboardData.setData("text/plain", "");
  return false;
});

document.addEventListener("paste", (event) => {
  // 允许在输入框中粘贴
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
    return; // 允许输入框粘贴
  }
  event.preventDefault();
  return false;
});

// 阻止右键菜单（可选，但保留以增强保护）
document.addEventListener("contextmenu", (event) => {
  // 允许在输入框上显示右键菜单
  const target = event.target;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) {
    return; // 允许输入框右键菜单
  }
  event.preventDefault();
  return false;
});

// 阻止选择文本（通过鼠标拖拽）
document.addEventListener("selectstart", (event) => {
  const target = event.target;
  // 允许输入框和文本区域选择
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) {
    return;
  }
  event.preventDefault();
  return false;
});

// 阻止拖拽
document.addEventListener("dragstart", (event) => {
  event.preventDefault();
  return false;
});

