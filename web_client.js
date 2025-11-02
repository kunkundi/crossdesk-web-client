const iceConnectionLog = document.getElementById('ice-connection-state'),
  iceGatheringLog = document.getElementById('ice-gathering-state'),
  signalingLog = document.getElementById('signaling-state'),
  dataChannelLog = document.getElementById('data-channel');

clientId = "000000";
transmissionId = "475319798"
transmissionPwd = "111111"
const websocket = new WebSocket('wss://api.crossdesk.cn:9090');

websocket.onopen = () => {
  document.getElementById('start').disabled = false;
  sendLogin();
}

websocket.onmessage = async (evt) => {
  if (typeof evt.data !== 'string') {
    return;
  }
  const message = JSON.parse(evt.data);
  if (message.type == "login") {
    clientId = message.user_id.split("@")[0];
    console.log("logged in as " + clientId);

  } else if (message.type == "offer") {
    document.getElementById('offer-sdp').textContent = message.sdp;
    await handleOffer(message)
  }
}

let pc = null;
let dc = null;

function createPeerConnection() {
  const config = {
    bundlePolicy: "max-bundle",
  };

  if (document.getElementById('use-stun').checked) {
    config.iceServers = [{ urls: ['stun:api.crossdesk.cn:3478'] }];
  }

  let pc = new RTCPeerConnection(config);

  // Register some listeners to help debugging
  pc.addEventListener('iceconnectionstatechange', () =>
    iceConnectionLog.textContent += ' -> ' + pc.iceConnectionState);
  iceConnectionLog.textContent = pc.iceConnectionState;

  pc.addEventListener('icegatheringstatechange', () =>
    iceGatheringLog.textContent += ' -> ' + pc.iceGatheringState);
  iceGatheringLog.textContent = pc.iceGatheringState;

  pc.addEventListener('signalingstatechange', () =>
    signalingLog.textContent += ' -> ' + pc.signalingState);
  signalingLog.textContent = pc.signalingState;

  // Receive audio/video track
  // Receive audio/video track — 更健壮的处理
  pc.ontrack = (evt) => {
    console.log('ontrack event:', evt);
    const video = document.getElementById('video');

    // 只处理 video track
    if (evt.track.kind !== 'video') return;

    // 如果已有流，就别再重新设置 srcObject
    if (!video.srcObject) {
      const stream = evt.streams && evt.streams[0]
        ? evt.streams[0]
        : new MediaStream([evt.track]);

      video.srcObject = stream;
      video.muted = true;
      video.playsInline = true;

      // 延迟一点再播放，避免 srcObject 切换导致 AbortError
      setTimeout(() => {
        video.play().catch(err => {
          console.warn('video.play() failed:', err);
        });
      }, 200);

      console.log('attached new video stream:', stream.id);
    } else {
      // 如果已有流，则只添加 track
      video.srcObject.addTrack(evt.track);
      console.log('added track to existing stream:', evt.track.id);
    }
  };

  // Receive data channel
  pc.ondatachannel = (evt) => {
    dc = evt.channel;

    dc.onopen = () => {
      dataChannelLog.textContent += '- open\n';
      dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
    };

    let dcTimeout = null;
    dc.onmessage = (evt) => {
      if (typeof evt.data !== 'string') {
        return;
      }

      dataChannelLog.textContent += '< ' + evt.data + '\n';
      dataChannelLog.scrollTop = dataChannelLog.scrollHeight;

      dcTimeout = setTimeout(() => {
        if (!dc) {
          return;
        }
        const message = `Pong ${currentTimestamp()}`;
        dataChannelLog.textContent += '> ' + message + '\n';
        dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
        dc.send(message);
      }, 1000);
    }

    dc.onclose = () => {
      clearTimeout(dcTimeout);
      dcTimeout = null;
      dataChannelLog.textContent += '- close\n';
      dataChannelLog.scrollTop = dataChannelLog.scrollHeight;
    };
  }

  return pc;
}

async function waitGatheringComplete() {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve();
    } else {
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') {
          resolve();
        }
      });
    }
  });
}

async function sendAnswer(pc) {
  await pc.setLocalDescription(await pc.createAnswer());
  await waitGatheringComplete();

  const answer = pc.localDescription;
  document.getElementById('answer-sdp').textContent = answer.sdp;

  msg = JSON.stringify({
    type: "answer",
    transmission_id: transmissionId,
    user_id: clientId,
    remote_user_id: transmissionId,
    sdp: answer.sdp,
  });
  console.log("send answer: " + msg);

  websocket.send(msg);
}

async function handleOffer(offer) {
  pc = createPeerConnection();
  await pc.setRemoteDescription(offer);
  await sendAnswer(pc);
}

function sendLogin() {
  websocket.send(JSON.stringify({
    type: "login",
    user_id: "",
  }));
  console.log("send login");
}

function sendRequest() {
  websocket.send(JSON.stringify({
    type: "join_transmission",
    user_id: clientId,
    transmission_id: transmissionId + '@' + transmissionPwd,
  }));
}

function start() {
  document.getElementById('start').style.display = 'none';
  document.getElementById('stop').style.display = 'inline-block';
  document.getElementById('media').style.display = 'block';
  sendRequest();
}

function stop() {
  document.getElementById('stop').style.display = 'none';
  document.getElementById('media').style.display = 'none';
  document.getElementById('start').style.display = 'inline-block';

  // close data channel
  if (dc) {
    dc.close();
    dc = null;
  }

  // close transceivers
  if (pc.getTransceivers) {
    pc.getTransceivers().forEach((transceiver) => {
      if (transceiver.stop) {
        transceiver.stop();
      }
    });
  }

  // close local audio/video
  pc.getSenders().forEach((sender) => {
    const track = sender.track;
    if (track !== null) {
      sender.track.stop();
    }
  });

  // close peer connection
  pc.close();
  pc = null;
}


// Helper function to generate a timestamp
let startTime = null;
function currentTimestamp() {
  if (startTime === null) {
    startTime = Date.now();
    return 0;
  } else {
    return Date.now() - startTime;
  }
}

