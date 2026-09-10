/* ===========================================================
   PUZZLE BATTALION — net.js
   Serverless P2P via PeerJS public cloud (signaling only).
   Room code = 3-4 digit number used as the Peer ID suffix.
   Host runs the authoritative battle sim (from game.js) and
   broadcasts state; the client sends row-clear spawn events and
   renders whatever the host broadcasts. See plan section III.

   Also wires the home-menu screen (create / join / bot difficulty)
   and handles camera+mic acquisition with graceful fallbacks.

   NOTE on cross-network play (wifi <-> mobile data):
   STUN alone (stun.l.google.com) can only establish a *direct*
   P2P path. If either side sits behind a symmetric/strict NAT —
   very common on carrier-grade NAT used by mobile data networks —
   a direct path is impossible and the connection silently hangs.
   We add TURN servers (relay fallback) so the browsers can still
   talk to each other by relaying traffic through a third party
   when a direct hole-punch fails. The public openrelay.metered.ca
   credentials below are a free/shared test relay — fine for
   playtesting, but swap in your own TURN credentials (Twilio,
   Metered, Cloudflare Calls, etc.) before any real launch, since
   the shared one can be rate-limited or go down without notice.

   NOTE on camera/mic lifecycle:
   Camera and mic are now NEVER requested just from connecting to
   a room. Each device is only opened (getUserMedia) the instant
   the player presses its button, and is genuinely stopped
   (track.stop()) — not just muted — the instant they press it
   again. This means:
     - No permission prompt / camera light until the player asks.
     - Toggling off actually releases the hardware.
   Because the very first press can happen after the two players
   are already connected, we can't always rely on the initial
   call's SDP having a video/audio section ready to go. So a
   media call is only placed the first time either side turns
   something on, and any track added afterward is attached via
   RTCPeerConnection.addTrack + a small hand-rolled renegotiation
   (offer/answer exchanged over the existing reliable data
   channel) — turning a track back off/on again after that reuses
   the same sender via replaceTrack, which needs no renegotiation.
   =========================================================== */

const Net = (() => {

  const PEER_PREFIX = 'puzzlebattalion-';
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // TURN relay fallback — required for many wifi<->mobile-data pairings
      {
        urls: 'turn:openrelay.metered.ca:80',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      },
      {
        urls: 'turn:openrelay.metered.ca:443?transport=tcp',
        username: 'openrelayproject',
        credential: 'openrelayproject'
      }
    ]
  };
  const STATE_HZ = 15; // host -> client broadcast rate
  const BOT_DIFFICULTY_LABEL = { easy: 'DỄ', medium: 'THƯỜNG', hard: 'KHÓ' };
  // if we haven't reached "online" this long after opening the data
  // connection attempt, the most likely cause is strict NAT on one side
  // and no usable relay path yet — surface that instead of looking frozen
  const SLOW_CONN_WARN_MS = 9000;

  let peer = null;
  let conn = null;          // PeerJS DataConnection
  let role = 'solo';        // 'solo' | 'host' | 'client'
  let broadcastTimer = null;
  let currentRoomCode = null; // room code the client is connecting to (used to place the media call once connected)
  let slowConnTimer = null;

  // ---------- media state ----------
  // micStream / camStream: each either null (device off, hardware fully
  // released) or a live MediaStream holding exactly that one track.
  let micStream = null;
  let camStream = null;
  let mediaCall = null;          // PeerJS MediaConnection, created lazily on first toggle
  let audioSender = null;        // RTCRtpSender once a mic track has been added at least once
  let videoSender = null;        // RTCRtpSender once a cam track has been added at least once
  let remotePeerId = null;       // learned from the client's 'hello' — lets the host place a call too
  // The remote <video>'s srcObject is one MediaStream we own and mutate,
  // rather than whatever transient MediaStream object a given 'stream'
  // event/renegotiation hands back. This is what actually fixes "camera
  // không hiện": the old code did `remoteVideo.srcObject = evt stream`
  // every time a track arrived, and every addTrack() renegotiation call
  // wraps its track in a brand-new anonymous MediaStream — so a camera
  // turned on *after* the initial call (the common case) would replace
  // srcObject with a stream some browsers never got around to (re)playing,
  // and/or one that silently dropped the *other* already-working track.
  let remoteMediaStream = null;

  const els = {};

  function cacheEls(){
    els.homeScreen   = document.getElementById('homeScreen');
    els.app          = document.getElementById('app');
    els.homeStatus   = document.getElementById('homeStatus');
    els.menuHost     = document.getElementById('menuHost');
    els.menuJoinToggle = document.getElementById('menuJoinToggle');
    els.joinPanel    = document.getElementById('joinPanel');
    els.homeRoomInput = document.getElementById('homeRoomInput');
    els.menuJoinConfirm = document.getElementById('menuJoinConfirm');
    els.menuBotToggle = document.getElementById('menuBotToggle');
    els.botPanel     = document.getElementById('botPanel');

    els.menuLanToggle = document.getElementById('menuLanToggle');
    els.lanPanel      = document.getElementById('lanPanel');
    els.lanHostBtn    = document.getElementById('lanHostBtn');
    els.lanJoinBtn    = document.getElementById('lanJoinBtn');
    els.lanHostFlow   = document.getElementById('lanHostFlow');
    els.lanJoinFlow   = document.getElementById('lanJoinFlow');
    els.lanCreateOfferBtn = document.getElementById('lanCreateOfferBtn');
    els.lanOfferOut   = document.getElementById('lanOfferOut');
    els.lanCopyOfferBtn = document.getElementById('lanCopyOfferBtn');
    els.lanAnswerIn   = document.getElementById('lanAnswerIn');
    els.lanConnectHostBtn = document.getElementById('lanConnectHostBtn');
    els.lanOfferIn    = document.getElementById('lanOfferIn');
    els.lanCreateAnswerBtn = document.getElementById('lanCreateAnswerBtn');
    els.lanAnswerOut  = document.getElementById('lanAnswerOut');
    els.lanCopyAnswerBtn = document.getElementById('lanCopyAnswerBtn');

    els.btnHome   = document.getElementById('btnHome');
    els.connDot   = document.getElementById('connState');
    els.roomLabel = document.getElementById('roomLabel');
    els.btnMic    = document.getElementById('btnMic');
    els.btnCam    = document.getElementById('btnCam');
    els.localVideo  = document.getElementById('localVideo');
    els.remoteVideo = document.getElementById('remoteVideo');
    els.chatForm  = document.getElementById('chatForm');
    els.chatInput = document.getElementById('chatInput');
    els.danmakuLayer = document.getElementById('danmakuLayer');
  }

  function setConnState(state){
    els.connDot.className = 'conn-dot ' + state; // offline | connecting | online
  }

  function setHomeStatus(text){
    els.homeStatus.textContent = text || '';
  }

  function randomRoomCode(){
    return String(Math.floor(1000 + Math.random() * 9000)); // 4 digits
  }

  function showGameScreen(){
    els.homeScreen.classList.add('hidden');
    els.app.classList.remove('hidden');
  }

  // ---------- slow-connection watchdog ----------
  function armSlowConnWarning(){
    clearSlowConnWarning();
    slowConnTimer = setTimeout(() => {
      if (els.roomLabel) {
        els.roomLabel.textContent =
          'Kết nối đang chậm — có thể do mạng của một bên (đặc biệt là 4G/5G) chặn kết nối trực tiếp. Đang thử qua máy chủ trung gian, vui lòng đợi thêm hoặc thử lại bằng wifi khác.';
      }
    }, SLOW_CONN_WARN_MS);
  }
  function clearSlowConnWarning(){
    if (slowConnTimer) clearTimeout(slowConnTimer);
    slowConnTimer = null;
  }

  // ---------- media: buttons ----------
  function syncMediaButtons(){
    els.btnMic.disabled = false;
    els.btnMic.dataset.on = micStream ? '1' : '0';
    els.btnMic.textContent = 'MIC: ' + (micStream ? 'BẬT' : 'TẮT');

    els.btnCam.disabled = false;
    els.btnCam.dataset.on = camStream ? '1' : '0';
    els.btnCam.textContent = 'CAM: ' + (camStream ? 'BẬT' : 'TẮT');
  }

  function wireMediaButtons(){
    els.btnMic.addEventListener('click', toggleMic);
    els.btnCam.addEventListener('click', toggleCam);
  }

  // combined MediaStream of whatever is currently ON — used whenever we
  // need to hand a stream to peer.call()/call.answer()/addTrack().
  function getActiveStream(){
    const s = new MediaStream();
    if (micStream) micStream.getAudioTracks().forEach(t => s.addTrack(t));
    if (camStream) camStream.getVideoTracks().forEach(t => s.addTrack(t));
    return s;
  }

  // Adds an incoming remote track (audio or video, from the very first
  // call OR a later renegotiation) into our own persistent MediaStream
  // instead of swapping the remote <video>'s srcObject to whatever
  // one-off stream object happened to carry it in. Called straight off
  // RTCPeerConnection's 'track' event (see wireMediaCall) rather than
  // PeerJS's higher-level 'stream' re-wrap, which is one more layer that
  // can end up dropping a track a browser/PeerJS version doesn't re-emit
  // consistently.
  function attachRemoteTrack(track){
    if (!remoteMediaStream) remoteMediaStream = new MediaStream();
    if (!remoteMediaStream.getTracks().some(t => t.id === track.id)) {
      remoteMediaStream.addTrack(track);
    }
    if (els.remoteVideo.srcObject !== remoteMediaStream) {
      els.remoteVideo.srcObject = remoteMediaStream;
    }
    playRemoteVideo();
    track.addEventListener('ended', () => {
      if (remoteMediaStream && remoteMediaStream.getTracks().includes(track)) {
        remoteMediaStream.removeTrack(track);
      }
    });
  }

  // Browsers can silently refuse to autoplay a <video> that carries audio
  // unless playback was started from a direct user gesture — and a track
  // arriving over WebRTC never counts as one. When that happens the
  // element just sits there black/frozen with no error the player can
  // see, which reads exactly like "camera không hiện". Retry muted (video
  // is always allowed to autoplay muted) so the picture shows up either
  // way; the player still has full audio from the mic if that's on too,
  // since muting here only affects this <video> element's own playback.
  function playRemoteVideo(){
    const p = els.remoteVideo.play();
    if (p && p.catch) {
      p.catch(() => {
        els.remoteVideo.muted = true;
        els.remoteVideo.play().catch((e) => console.warn('Không thể phát video đối thủ:', e));
      });
    }
  }

  function resetRemoteVideo(){
    remoteMediaStream = null;
    els.remoteVideo.srcObject = null;
    els.remoteVideo.muted = false;
  }

  async function toggleMic(){
    if (micStream) {
      // TẮT THẬT SỰ: dừng hẳn track phần cứng, không chỉ ẩn/mute
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
      if (audioSender) { try { await audioSender.replaceTrack(null); } catch (e) { console.warn(e); } }
      syncMediaButtons();
      return;
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.warn('Không thể bật mic:', err.name);
      return;
    }
    syncMediaButtons();
    await onLocalTrackChanged();
  }

  async function toggleCam(){
    if (camStream) {
      // TẮT THẬT SỰ: dừng hẳn track phần cứng (đèn camera tắt), không chỉ
      // ẩn khung hình đi trong khi camera vẫn chạy ngầm.
      camStream.getTracks().forEach(t => t.stop());
      camStream = null;
      els.localVideo.srcObject = null;
      if (videoSender) { try { await videoSender.replaceTrack(null); } catch (e) { console.warn(e); } }
      syncMediaButtons();
      return;
    }
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: true });
    } catch (err) {
      console.warn('Không thể bật camera:', err.name);
      return;
    }
    els.localVideo.srcObject = camStream;
    syncMediaButtons();
    await onLocalTrackChanged();
  }

  // Called right after a track turns on. If no media call exists yet,
  // establish one now (lazily — this is the first time there's anything
  // to send). If a call already exists, just attach/replace the track on it.
  async function onLocalTrackChanged(){
    if (!conn || !conn.open) return; // not connected to an opponent yet — just keep local preview updated
    if (!mediaCall) {
      const stream = getActiveStream();
      if (stream.getTracks().length === 0) return;
      if (role === 'client') {
        wireMediaCall(peer.call(PEER_PREFIX + currentRoomCode, stream));
      } else if (remotePeerId) {
        wireMediaCall(peer.call(remotePeerId, stream));
      } else {
        // Host turned something on first but doesn't know the client's
        // peer id yet (it only shows up in the 'hello' message) — ask the
        // client to be the one placing the call instead.
        send({ type: 'want-call' });
      }
    } else {
      await syncSendersToCurrentTracks();
    }
  }

  function wireMediaCall(call){
    mediaCall = call;
    call.on('close', () => { mediaCall = null; audioSender = null; videoSender = null; resetRemoteVideo(); });
    call.on('error', (e) => console.warn('Media call error:', e));
    // Track-level listening survives renegotiation (new tracks added later
    // via addTrack still fire 'track' here) and never depends on whichever
    // one-off MediaStream wrapper a given track happened to arrive in.
    if (call.peerConnection) {
      call.peerConnection.addEventListener('track', (evt) => attachRemoteTrack(evt.track));
    }
    captureExistingSenders();
  }

  // If the call was just created with tracks already in its initial stream
  // (e.g. answering with a mic that was turned on before the call existed),
  // those senders exist from the start — grab references so later toggles
  // can use replaceTrack instead of addTrack.
  function captureExistingSenders(){
    if (!mediaCall || !mediaCall.peerConnection) return;
    const senders = mediaCall.peerConnection.getSenders();
    audioSender = senders.find(s => s.track && s.track.kind === 'audio') || audioSender;
    videoSender = senders.find(s => s.track && s.track.kind === 'video') || videoSender;
  }

  // Adds/replaces/mutes senders on the existing media call to match
  // whatever mic/cam is currently on. Adding a brand-new sender (first time
  // that device turns on after the call already exists) requires a manual
  // renegotiation over the data channel; swapping an existing sender's
  // track (turning something back on/off afterward) does not.
  async function syncSendersToCurrentTracks(){
    if (!mediaCall || !mediaCall.peerConnection) return;
    const pc = mediaCall.peerConnection;
    let needsRenegotiation = false;

    const audioTrack = micStream ? micStream.getAudioTracks()[0] : null;
    if (audioTrack) {
      if (audioSender) { try { await audioSender.replaceTrack(audioTrack); } catch (e) { console.warn(e); } }
      else { audioSender = pc.addTrack(audioTrack, getActiveStream()); needsRenegotiation = true; }
    } else if (audioSender) {
      try { await audioSender.replaceTrack(null); } catch (e) { console.warn(e); }
    }

    const videoTrack = camStream ? camStream.getVideoTracks()[0] : null;
    if (videoTrack) {
      if (videoSender) { try { await videoSender.replaceTrack(videoTrack); } catch (e) { console.warn(e); } }
      else { videoSender = pc.addTrack(videoTrack, getActiveStream()); needsRenegotiation = true; }
    } else if (videoSender) {
      try { await videoSender.replaceTrack(null); } catch (e) { console.warn(e); }
    }

    if (needsRenegotiation) await sendRenegotiationOffer();
  }

  async function sendRenegotiationOffer(){
    if (!mediaCall || !mediaCall.peerConnection || !conn || !conn.open) return;
    try {
      const pc = mediaCall.peerConnection;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      send({ type: 'renegotiate-offer', sdp: pc.localDescription });
    } catch (e) {
      console.warn('Renegotiate (offer) lỗi:', e);
    }
  }

  async function handleRenegotiateOffer(sdp){
    if (!mediaCall || !mediaCall.peerConnection) return;
    try {
      const pc = mediaCall.peerConnection;
      await pc.setRemoteDescription(sdp);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ type: 'renegotiate-answer', sdp: pc.localDescription });
      captureExistingSenders();
    } catch (e) {
      console.warn('Renegotiate (answer) lỗi:', e);
    }
  }

  async function handleRenegotiateAnswer(sdp){
    if (!mediaCall || !mediaCall.peerConnection) return;
    try {
      await mediaCall.peerConnection.setRemoteDescription(sdp);
    } catch (e) {
      console.warn('Renegotiate (áp dụng answer) lỗi:', e);
    }
  }

  // ---------- data channel protocol ----------
  function onData(msg){
    switch (msg.type) {
      case 'spawnRow':
        // only the host acts on spawn requests, coming from the client (side B)
        if (role === 'host') msg.unitTypes.forEach(t => Game.onRemoteSpawn(msg.side, t));
        break;
      case 'state':
        if (role === 'client') {
          const wasStale = performance.now() - lastStateAt > STATE_STALE_MS;
          lastStateAt = performance.now();
          if (wasStale) {
            setConnState('online');
            if (els.roomLabel) els.roomLabel.textContent = 'ĐÃ KẾT NỐI';
          }
          Game.applyRemoteState(msg.state);
        }
        break;
      case 'chat':
        spawnDanmaku(msg.text, 'theirs');
        break;
      case 'hello':
        // sent once by the client right after connecting, so the host can
        // place a media call later too (host has no other way to learn
        // the client's peer id, since the client's id is random).
        remotePeerId = msg.peerId;
        break;
      case 'want-call':
        // the host turned mic/cam on first and doesn't have a call yet —
        // only the client can dial the host's fixed room-code id, so the
        // client places the call on the host's behalf.
        if (!mediaCall) wireMediaCall(peer.call(PEER_PREFIX + currentRoomCode, getActiveStream()));
        break;
      case 'renegotiate-offer':
        handleRenegotiateOffer(msg.sdp);
        break;
      case 'renegotiate-answer':
        handleRenegotiateAnswer(msg.sdp);
        break;
    }
  }

  function send(msg){
    if (conn && conn.open) conn.send(msg);
  }

  // if the client hasn't received a 'state' broadcast in this long while
  // nominally online, the connection is alive but too weak/lossy to carry
  // the battle sync — surface that plainly instead of just quietly
  // stuttering (which is what used to read as "units are out of sync").
  const STATE_STALE_MS = 2500;
  let lastStateAt = 0;
  let staleWatchTimer = null;

  function armStaleWatch(){
    clearStaleWatch();
    if (role !== 'client') return;
    staleWatchTimer = setInterval(() => {
      if (!conn || !conn.open) return;
      if (performance.now() - lastStateAt > STATE_STALE_MS) {
        setConnState('connecting');
        if (els.roomLabel) els.roomLabel.textContent = 'MẠNG YẾU — đang cố đồng bộ lại trận đấu...';
      }
    }, 800);
  }
  function clearStaleWatch(){
    if (staleWatchTimer) clearInterval(staleWatchTimer);
    staleWatchTimer = null;
  }

  function attachConnHandlers(c){
    conn = c;
    armSlowConnWarning();

    // Extra diagnostics: watch the underlying RTCPeerConnection's ICE
    // state so we can tell "still negotiating" apart from "actually
    // stuck" — useful specifically for the wifi<->mobile-data case where
    // ICE has to fall through to a relay (TURN) candidate. 'disconnected'
    // is usually transient (a missed keepalive on flaky wifi) and often
    // self-heals within a few seconds, so it gets its own, less alarming
    // message than the genuinely-dead 'failed' state.
    if (c.peerConnection) {
      c.peerConnection.oniceconnectionstatechange = () => {
        const state = c.peerConnection.iceConnectionState;
        console.log('ICE state:', state);
        if (state === 'failed' && els.roomLabel) {
          setConnState('offline');
          els.roomLabel.textContent =
            'Không thể kết nối trực tiếp lẫn qua máy chủ trung gian. Hãy kiểm tra mạng (thử đổi sang wifi) rồi thử lại.';
        } else if (state === 'disconnected' && els.roomLabel) {
          setConnState('connecting');
          els.roomLabel.textContent = 'MẠNG CHẬP CHỜN — đang thử kết nối lại...';
        } else if ((state === 'connected' || state === 'completed') && conn && conn.open) {
          setConnState('online');
          els.roomLabel.textContent = 'ĐÃ KẾT NỐI';
        }
      };
    }

    conn.on('open', () => {
      clearSlowConnWarning();
      setConnState('online');
      els.roomLabel.textContent = 'ĐÃ KẾT NỐI';
      syncMediaButtons(); // both OFF by default — camera/mic are never auto-started

      if (role === 'client') {
        send({ type: 'hello', peerId: peer.id });
        lastStateAt = performance.now();
        armStaleWatch();
      }

      // the puzzle grid / battle sim only actually starts running once the
      // opponent has joined — fixes "tạo phòng là chơi luôn" (room used to
      // start playing immediately instead of waiting for the other player)
      Game.start();

      // Host runs the authoritative sim and must actually broadcast it, or
      // the client's battlefield never updates (units/base HP stay frozen
      // on their screen even though the host's own sim is progressing) —
      // this was missing entirely before, which is why both players' units
      // never looked in sync with each other.
      if (role === 'host') startBroadcasting();
    });
    conn.on('data', onData);
    conn.on('close', () => {
      clearSlowConnWarning();
      clearStaleWatch();
      setConnState('offline');
      els.roomLabel.textContent = 'MẤT KẾT NỐI';
      stopBroadcasting();
    });
    conn.on('error', (e) => {
      console.warn('Data connection error:', e);
      clearSlowConnWarning();
    });
  }

  function startBroadcasting(){
    stopBroadcasting();
    broadcastTimer = setInterval(() => {
      send({ type: 'state', state: Game.getSnapshot() });
    }, 1000 / STATE_HZ);
  }
  function stopBroadcasting(){
    if (broadcastTimer) clearInterval(broadcastTimer);
    broadcastTimer = null;
  }

  function peerJsAvailable(){
    return typeof Peer !== 'undefined';
  }

  // ---------- LAN pairing (no internet, no signaling server at all) ----------
  // Same-network play works even with a weak or completely absent internet
  // connection: two devices on the same wifi/hotspot can reach each other
  // directly over local IP addresses, which needs no STUN/TURN and no
  // PeerJS cloud broker — only a way to exchange one SDP offer and one SDP
  // answer between the two devices, which we do manually (copy/paste the
  // short text code by any means at hand: Bluetooth share, a chat app,
  // reading it out loud). iceServers is deliberately empty: a STUN/TURN
  // lookup would itself require internet, and isn't needed when both
  // sides can already see each other's local address.
  let lanPc = null;

  function waitIceGatheringComplete(pc){
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const check = () => {
        if (pc.iceGatheringState === 'complete') {
          pc.removeEventListener('icegatheringstatechange', check);
          resolve();
        }
      };
      pc.addEventListener('icegatheringstatechange', check);
      // safety net — some networks never cleanly report "complete"
      setTimeout(resolve, 3000);
    });
  }

  function encodeSdp(desc){
    return btoa(JSON.stringify({ type: desc.type, sdp: desc.sdp }));
  }
  function decodeSdp(code){
    return JSON.parse(atob(code.trim()));
  }

  // Wraps a raw RTCDataChannel so it exposes the same {send, on, open,
  // peerConnection, close} shape attachConnHandlers() already expects from
  // a PeerJS DataConnection — every bit of existing game/chat/media
  // protocol logic keeps working untouched on top of a LAN connection.
  function wireLanConnection(pc, dc){
    const shim = {
      peerConnection: pc,
      open: false,
      send(msg){ if (dc.readyState === 'open') dc.send(JSON.stringify(msg)); },
      on(event, cb){
        if (event === 'open') dc.addEventListener('open', () => { shim.open = true; cb(); });
        else if (event === 'data') dc.addEventListener('message', (e) => {
          try { cb(JSON.parse(e.data)); } catch (err) { console.warn('Dữ liệu LAN không hợp lệ:', err); }
        });
        else if (event === 'close') dc.addEventListener('close', cb);
        else if (event === 'error') dc.addEventListener('error', cb);
      },
      close(){ try { dc.close(); } catch (e) {} }
    };
    attachConnHandlers(shim);
    // No separate "call" concept here like PeerJS has — camera/mic just
    // ride the same RTCPeerConnection, added/renegotiated over this same
    // data channel via the existing sync/renegotiate-offer/answer protocol.
    mediaCall = { peerConnection: pc, close(){} };
    pc.addEventListener('track', (evt) => attachRemoteTrack(evt.track));
    captureExistingSenders();
  }

  function lanSetHomeCode(el, code){
    if (el) el.value = code;
  }

  async function lanCreateOffer(outEl){
    role = 'host';
    Game.setRole('host', 'A');
    Game.setBotMode(false);
    showGameScreen();
    Game.prepare();
    setConnState('connecting');
    els.roomLabel.textContent = 'LAN: đang tạo mã ghép nối...';

    lanPc = new RTCPeerConnection({ iceServers: [] });
    const dc = lanPc.createDataChannel('game', { ordered: true });
    wireLanConnection(lanPc, dc);

    try {
      const offer = await lanPc.createOffer();
      await lanPc.setLocalDescription(offer);
      await waitIceGatheringComplete(lanPc);
      lanSetHomeCode(outEl, encodeSdp(lanPc.localDescription));
      els.roomLabel.textContent = 'LAN: gửi mã trên cho máy kia, rồi dán mã PHẢN HỒI của họ vào đây.';
    } catch (err) {
      els.roomLabel.textContent = 'LỖI TẠO MÃ LAN: ' + err.message;
    }
  }

  async function lanApplyAnswer(code){
    if (!lanPc) { setHomeStatus('Hãy bấm TẠO MÃ trước.'); return; }
    if (!code || !code.trim()) { setHomeStatus('Dán mã phản hồi từ máy kia vào trước đã.'); return; }
    try {
      await lanPc.setRemoteDescription(decodeSdp(code));
    } catch (err) {
      setHomeStatus('Mã phản hồi không hợp lệ.');
    }
  }

  async function lanCreateAnswer(offerCode, outEl){
    if (!offerCode || !offerCode.trim()) { setHomeStatus('Dán mã của máy TẠO vào trước đã.'); return; }

    role = 'client';
    Game.setRole('client', 'B');
    Game.setBotMode(false);
    showGameScreen();
    Game.prepare();
    setConnState('connecting');
    els.roomLabel.textContent = 'LAN: đang tạo mã phản hồi...';

    try {
      lanPc = new RTCPeerConnection({ iceServers: [] });
      lanPc.ondatachannel = (e) => wireLanConnection(lanPc, e.channel);

      await lanPc.setRemoteDescription(decodeSdp(offerCode));
      const answer = await lanPc.createAnswer();
      await lanPc.setLocalDescription(answer);
      await waitIceGatheringComplete(lanPc);
      lanSetHomeCode(outEl, encodeSdp(lanPc.localDescription));
      els.roomLabel.textContent = 'LAN: gửi mã phản hồi trên lại cho máy kia để hoàn tất kết nối.';
    } catch (err) {
      els.roomLabel.textContent = 'LỖI GHÉP LAN: ' + err.message;
    }
  }

  // ---------- host / join / bot flows ----------
  async function hostGame(){
    if (!peerJsAvailable()) {
      setHomeStatus('Không tải được thư viện PeerJS — kiểm tra kết nối mạng rồi thử lại.');
      return;
    }
    role = 'host';
    Game.setRole('host', 'A');
    Game.setBotMode(false);
    showGameScreen();
    Game.prepare(); // idle board — waits for an opponent before anything falls/fights
    setConnState('connecting');

    const code = randomRoomCode();
    els.roomLabel.textContent = 'ĐANG MỞ PHÒNG ' + code + '...';

    try {
      peer = new Peer(PEER_PREFIX + code, { config: ICE_CONFIG });
    } catch (err) {
      els.roomLabel.textContent = 'LỖI KHỞI TẠO PEER: ' + err.message;
      return;
    }

    peer.on('open', () => {
      els.roomLabel.textContent = 'MÃ PHÒNG: ' + code + ' — đang chờ đối thủ (chơi được xuyên mạng khác nhau)...';
    });
    peer.on('connection', (c) => attachConnHandlers(c));
    peer.on('call', (call) => {
      // trả lời bằng bất cứ track nào đang BẬT tại thời điểm này (có thể
      // rỗng nếu chưa ai bật mic/cam) — không bao giờ tự xin quyền camera/mic
      call.answer(getActiveStream());
      wireMediaCall(call);
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      clearSlowConnWarning();
      setConnState('offline');
      els.roomLabel.textContent = e.type === 'unavailable-id'
        ? 'Mã phòng đang được dùng, hãy về trang chủ và tạo lại.'
        : 'LỖI KẾT NỐI: ' + e.type;
    });
  }

  async function joinGame(code){
    if (!peerJsAvailable()) {
      setHomeStatus('Không tải được thư viện PeerJS — kiểm tra kết nối mạng rồi thử lại.');
      return;
    }
    if (!/^\d{3,4}$/.test(code)) {
      setHomeStatus('Nhập mã phòng 3-4 số.');
      return;
    }

    role = 'client';
    currentRoomCode = code;
    Game.setRole('client', 'B');
    Game.setBotMode(false);
    showGameScreen();
    Game.prepare(); // idle board until the connection to the host is actually open
    setConnState('connecting');
    els.roomLabel.textContent = 'ĐANG VÀO PHÒNG ' + code + '...';

    try {
      peer = new Peer({ config: ICE_CONFIG });
    } catch (err) {
      els.roomLabel.textContent = 'LỖI KHỞI TẠO PEER: ' + err.message;
      return;
    }

    peer.on('open', () => {
      const c = peer.connect(PEER_PREFIX + code, { reliable: true });
      attachConnHandlers(c);
    });
    peer.on('call', (call) => {
      call.answer(getActiveStream());
      wireMediaCall(call);
    });
    peer.on('error', (e) => {
      console.warn('Peer error:', e);
      clearSlowConnWarning();
      setConnState('offline');
      els.roomLabel.textContent = e.type === 'peer-unavailable'
        ? 'Không tìm thấy phòng với mã này.'
        : 'LỖI KẾT NỐI: ' + e.type;
    });
  }

  function startBotGame(difficulty){
    role = 'solo';
    Game.setRole('solo', 'A');
    Game.setBotMode(true, difficulty);
    showGameScreen();
    Game.start(); // no opponent to wait for — the match begins right away
    setConnState('offline');
    const label = BOT_DIFFICULTY_LABEL[difficulty] || 'THƯỜNG';
    els.roomLabel.textContent = 'CHẾ ĐỘ CHƠI VỚI MÁY — ' + label;
    syncMediaButtons();
    // camera/mic are optional here (there's no remote peer to send them to)
    // so they're only requested if the player presses CAM/MIC themselves.
  }

  function teardown(){
    clearSlowConnWarning();
    clearStaleWatch();
    stopBroadcasting();
    if (micStream) micStream.getTracks().forEach(t => t.stop());
    if (camStream) camStream.getTracks().forEach(t => t.stop());
    micStream = null; camStream = null;
    audioSender = null; videoSender = null;
    remotePeerId = null;
    if (conn) { try { conn.close(); } catch (e) {} }
    if (mediaCall) { try { mediaCall.close(); } catch (e) {} }
    mediaCall = null;
    resetRemoteVideo();
    if (lanPc) { try { lanPc.close(); } catch (e) {} }
    lanPc = null;
    if (peer) { try { peer.destroy(); } catch (e) {} }
  }

  // ---------- bullet chat (danmaku) ----------
  function spawnDanmaku(text, who){
    const item = document.createElement('div');
    item.className = 'danmaku-item ' + (who === 'mine' ? 'mine' : 'theirs');
    item.textContent = (who === 'mine' ? '► ' : '◄ ') + text;
    const layerH = els.danmakuLayer.clientHeight || 26;
    item.style.top = Math.max(2, Math.random() * (layerH - 16)) + 'px';
    item.style.left = els.danmakuLayer.clientWidth + 'px';
    els.danmakuLayer.appendChild(item);

    requestAnimationFrame(() => {
      const distance = els.danmakuLayer.clientWidth + item.offsetWidth + 20;
      const duration = 4500 + Math.random() * 1500;
      const anim = item.animate(
        [{ transform: 'translateX(0)' }, { transform: `translateX(-${distance}px)` }],
        { duration, easing: 'linear', fill: 'forwards' }
      );
      anim.onfinish = () => item.remove();
    });
  }

  function wireChatForm(){
    els.chatForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = els.chatInput.value.trim();
      if (!text) return;
      spawnDanmaku(text, 'mine');
      send({ type: 'chat', text });
      els.chatInput.value = '';
    });
  }

  // ---------- puzzle -> battle bridge ----------
  function wireGameHooks(){
    // rowTypes: mảng loại lính (mỗi ô một loại) của hàng vừa nổ — một hàng
    // có thể triệu hồi nhiều loại lính khác nhau cùng lúc.
    Game.hooks.onLocalRowCleared = (rowTypes) => {
      const side = Game.getMySide();
      if (role === 'client') {
        send({ type: 'spawnRow', side, unitTypes: rowTypes });
      } else {
        // solo sandbox, vs-bot, or host: spawn directly into the authoritative sim
        rowTypes.forEach(t => Game.spawnUnit(side, t));
      }
    };
    Game.hooks.onGameOver = () => { stopBroadcasting(); };
  }

  // ---------- home menu wiring ----------
  function wireHomeMenu(){
    els.menuHost.addEventListener('click', () => { setHomeStatus(''); hostGame(); });

    els.menuJoinToggle.addEventListener('click', () => {
      els.botPanel.classList.add('hidden');
      els.lanPanel.classList.add('hidden');
      els.joinPanel.classList.toggle('hidden');
      if (!els.joinPanel.classList.contains('hidden')) els.homeRoomInput.focus();
    });

    els.menuJoinConfirm.addEventListener('click', () => {
      setHomeStatus('');
      joinGame((els.homeRoomInput.value || '').trim());
    });
    els.homeRoomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') els.menuJoinConfirm.click();
    });

    els.menuBotToggle.addEventListener('click', () => {
      els.joinPanel.classList.add('hidden');
      els.lanPanel.classList.add('hidden');
      els.botPanel.classList.toggle('hidden');
    });
    els.botPanel.querySelectorAll('.bot-diff').forEach((btn) => {
      btn.addEventListener('click', () => {
        setHomeStatus('');
        startBotGame(btn.dataset.diff);
      });
    });

    // ---- LAN pairing (no internet needed) ----
    els.menuLanToggle.addEventListener('click', () => {
      els.joinPanel.classList.add('hidden');
      els.botPanel.classList.add('hidden');
      els.lanPanel.classList.toggle('hidden');
    });
    els.lanHostBtn.addEventListener('click', () => {
      els.lanJoinFlow.classList.add('hidden');
      els.lanHostFlow.classList.remove('hidden');
    });
    els.lanJoinBtn.addEventListener('click', () => {
      els.lanHostFlow.classList.add('hidden');
      els.lanJoinFlow.classList.remove('hidden');
    });
    els.lanCreateOfferBtn.addEventListener('click', () => {
      setHomeStatus('');
      lanCreateOffer(els.lanOfferOut);
    });
    els.lanCopyOfferBtn.addEventListener('click', () => copyLanCode(els.lanOfferOut));
    els.lanConnectHostBtn.addEventListener('click', () => {
      setHomeStatus('');
      lanApplyAnswer(els.lanAnswerIn.value);
    });
    els.lanCreateAnswerBtn.addEventListener('click', () => {
      setHomeStatus('');
      lanCreateAnswer(els.lanOfferIn.value, els.lanAnswerOut);
    });
    els.lanCopyAnswerBtn.addEventListener('click', () => copyLanCode(els.lanAnswerOut));

    els.btnHome.addEventListener('click', () => {
      teardown();
      location.reload();
    });
  }

  function copyLanCode(el){
    if (!el || !el.value) return;
    el.select();
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(el.value).catch(() => document.execCommand('copy'));
    } else {
      document.execCommand('copy');
    }
  }

  function init(){
    cacheEls();
    syncMediaButtons(); // TẮT/TẮT ngay từ đầu — chưa nối ai thì chưa xin quyền gì cả
    wireMediaButtons();
    wireChatForm();
    wireGameHooks();
    wireHomeMenu();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => Net.init());
