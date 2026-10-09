import { collection, addDoc, onSnapshot, query, where } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { db, firebaseReady, ensureAnonymousUser } from './firebase.js';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];
let activeConnection = null;
let directConnectionCleanup = () => {};

function encode(value) {
  return JSON.stringify(value);
}

function waitForChannel(channel, timeout = 5000) {
  return new Promise(resolve => {
    if (channel.readyState === 'open') return resolve(true);
    const timer = setTimeout(() => resolve(false), timeout);
    channel.addEventListener('open', () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
}

export async function connectDirectRoom(roomId, isHost, { onStatus = () => {}, onMessage = () => {} } = {}) {
  closeDirectRoom();
  if (!firebaseReady || !db || !globalThis.RTCPeerConnection) {
    onStatus({ state: 'unavailable', label: 'Fallback transport' });
    return null;
  }

  const user = await ensureAnonymousUser();
  const clientId = user?.uid || `${Date.now()}-${Math.random()}`;
  const signalRef = collection(db, 'rooms', roomId, 'webrtc');
  const peer = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const pendingCandidates = [];
  let remoteDescriptionSet = false;
  let channel = null;
  let stopSignals = () => {};
  let retryCount = 0;

  const publish = payload => addDoc(signalRef, { ...payload, sender: clientId, createdAt: Date.now() }).catch(() => {});
  const attachChannel = dataChannel => {
    channel = dataChannel;
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => onStatus({ state: 'connected', label: 'Direct peer connection' });
    channel.onclose = () => onStatus({ state: 'fallback', label: 'Direct link closed; fallback active' });
    channel.onerror = () => onStatus({ state: 'fallback', label: 'Direct link failed; fallback active' });
    channel.onmessage = event => {
      if (typeof event.data === 'string') {
        try { onMessage(JSON.parse(event.data)); } catch {}
      } else {
        onMessage({ type: 'file-chunk', data: event.data });
      }
    };
  };

  peer.onicecandidate = event => {
    if (event.candidate) publish({ type: 'candidate', payload: event.candidate.toJSON() });
  };
  peer.onconnectionstatechange = () => {
    const state = peer.connectionState;
    if (state === 'connecting') onStatus({ state, label: 'Negotiating direct link' });
    if (state === 'connected') {
      retryCount = 0;
      onStatus({ state: 'connected', label: 'Direct peer connection' });
    }
    if (['failed', 'disconnected'].includes(state) && retryCount < 2) {
      retryCount += 1;
      onStatus({ state: 'reconnecting', label: 'Retrying direct link' });
      setTimeout(() => {
        try { peer.restartIce?.(); } catch {}
      }, 700 * retryCount);
    }
    if (state === 'closed') {
      onStatus({ state: 'fallback', label: 'Fallback transport active' });
    }
  };
  if (isHost) attachChannel(peer.createDataChannel('loopflow'));
  else peer.ondatachannel = event => attachChannel(event.channel);

  stopSignals = onSnapshot(query(signalRef, where('sender', '!=', clientId)), async snapshot => {
    for (const item of snapshot.docChanges()) {
      if (item.type !== 'added') continue;
      const signal = item.doc.data();
      try {
        if (signal.type === 'offer' && !isHost && !remoteDescriptionSet) {
          await peer.setRemoteDescription(signal.payload);
          remoteDescriptionSet = true;
          const answer = await peer.createAnswer();
          await peer.setLocalDescription(answer);
          await publish({ type: 'answer', payload: answer });
        } else if (signal.type === 'answer' && isHost && !remoteDescriptionSet) {
          await peer.setRemoteDescription(signal.payload);
          remoteDescriptionSet = true;
        } else if (signal.type === 'candidate') {
          if (remoteDescriptionSet) await peer.addIceCandidate(signal.payload);
          else pendingCandidates.push(signal.payload);
        }
        if (remoteDescriptionSet && pendingCandidates.length) {
          await Promise.all(pendingCandidates.splice(0).map(candidate => peer.addIceCandidate(candidate)));
        }
      } catch (error) {
        console.warn('WebRTC signaling error:', error);
      }
    }
  });

  directConnectionCleanup = stopSignals;
  activeConnection = {
    peer,
    sendText(content) {
      if (channel?.readyState !== 'open') return false;
      channel.send(encode({ type: 'text', content }));
      return true;
    },
    async sendFile(file, onProgress = () => {}, senderName = 'Device') {
      if (channel?.readyState !== 'open') await waitForChannel(channel);
      if (channel?.readyState !== 'open') return false;
      const chunkSize = 64 * 1024;
      channel.send(encode({ type: 'file-start', name: file.name, size: file.size, mime: file.type, senderName }));
      for (let offset = 0; offset < file.size; offset += chunkSize) {
        channel.send(await file.slice(offset, offset + chunkSize).arrayBuffer());
        onProgress(Math.round(Math.min(1, (offset + chunkSize) / file.size) * 100));
        await new Promise(resolve => setTimeout(resolve, 0));
      }
      channel.send(encode({ type: 'file-end' }));
      return true;
    },
    waitForChannel: () => waitForChannel(channel)
  };

  if (isHost) {
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    await publish({ type: 'offer', payload: offer });
  }
  onStatus({ state: 'connecting', label: 'Negotiating direct link' });
  return activeConnection;
}

export function sendDirectText(content) {
  return activeConnection?.sendText(content) || false;
}

export async function sendDirectFile(file, onProgress, senderName) {
  return activeConnection?.sendFile(file, onProgress, senderName) || false;
}

export function closeDirectRoom() {
  directConnectionCleanup();
  activeConnection?.peer?.close();
  activeConnection = null;
  directConnectionCleanup = () => {};
}
