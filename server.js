const SIGNALING_URL =
  "wss://presence-media-server-production.up.railway.app/ws";

let ws = null;
let pc = null;
let localStream = null;
let audioEnabled = false;

const joinBtn = document.getElementById("joinBtn");
const audioBtn = document.getElementById("audioBtn");
const remoteAudio = document.getElementById("remoteAudio");

joinBtn.addEventListener("click", join);
audioBtn.addEventListener("click", enableAudio);

async function join() {
  const code = document.getElementById("code").value.trim();
  if (!code) return;

  teardown();

  ws = new WebSocket(SIGNALING_URL);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", address: code }));
  };

  ws.onmessage = async (e) => {
    const msg = JSON.parse(e.data);

    switch (msg.type) {
      case "ready":
        await startWebRTC(msg.role === "initiator");
        audioBtn.disabled = false;
        break;

      case "webrtc_offer":
        await pc.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        ws.send(JSON.stringify({
          type: "webrtc_answer",
          sdp: answer.sdp,
          sdpType: answer.type,
        }));
        break;

      case "webrtc_answer":
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        break;

      case "webrtc_ice":
        if (msg.candidate) {
          await pc.addIceCandidate({
            candidate: msg.candidate,
            sdpMid: msg.sdpMid,
            sdpMLineIndex: msg.sdpMLineIndex,
          });
        }
        break;

      case "collapse":
        teardown();
        break;
    }
  };

  ws.onerror = teardown;
  ws.onclose = teardown;
}

async function startWebRTC(initiator) {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getAudioTracks().forEach(t => (t.enabled = false));

  pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.ontrack = (e) => {
    if (remoteAudio.srcObject !== e.streams[0]) {
      remoteAudio.srcObject = e.streams[0];
    }
  };

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: "webrtc_ice",
        candidate: e.candidate.candidate,
        sdpMid: e.candidate.sdpMid,
        sdpMLineIndex: e.candidate.sdpMLineIndex,
      }));
    }
  };

  if (initiator) {
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    ws.send(JSON.stringify({
      type: "webrtc_offer",
      sdp: offer.sdp,
      sdpType: offer.type,
    }));
  }
}

async function enableAudio() {
  if (audioEnabled || !localStream) return;
  audioEnabled = true;

  remoteAudio.muted = false;
  await remoteAudio.play().catch(() => {});

  localStream.getAudioTracks().forEach(t => (t.enabled = true));
}

function teardown() {
  audioBtn.disabled = true;
  audioEnabled = false;

  localStream?.getTracks().forEach(t => t.stop());
  pc?.close();
  ws?.close();

  localStream = null;
  pc = null;
  ws = null;
}
