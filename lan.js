import { getMimeType } from './utils.js';

const DEFAULT_LAN_PORT = 3847;
const roomParams = new URLSearchParams(location.search);
const isLocalBridgePage = /^https?:$/.test(location.protocol) && location.port === String(DEFAULT_LAN_PORT);

export const lanMode = roomParams.get('mode') === 'lan';
// A device that opens the LAN server directly (for example, by typing its
// address instead of scanning its QR code) must keep talking to that server,
// not to its own localhost.
export const lanOrigin = (lanMode || isLocalBridgePage) ? location.origin : `http://127.0.0.1:${DEFAULT_LAN_PORT}`;

async function request(path, options = {}) {
  const { signal, ...restOptions } = options;
  const response = await fetch(`${lanOrigin}${path}`, {
    ...restOptions,
    signal,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Local connection failed.');
  }
  return response.json();
}

export async function localBridgeAvailable() {
  if (lanMode) return true;
  try {
    const response = await fetch(`${lanOrigin}/api/health`, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch { return false; }
}

export function createLocalRoomWithExpiry(minutes = 30) { return request('/api/rooms', { method: 'POST', body: JSON.stringify({ lifetimeMinutes: minutes }) }); }
export function joinLocalRoom(roomId, joinsRoom = true) { return request(`/api/rooms/${roomId}${joinsRoom ? '?join=1' : ''}`, { method: 'GET' }); }
export function deleteLocalRoom(roomId) { return request(`/api/rooms/${roomId}`, { method: 'DELETE' }); }
export function clearLocalRoom(roomId) { return request(`/api/rooms/${roomId}/clear`, { method: 'POST', body: '{}' }); }
export function sendLocalMessage(roomId, content, senderName, senderId, message = null) { return request(`/api/rooms/${roomId}/messages`, { method: 'POST', body: JSON.stringify({ content, senderName, senderId, message }) }); }
export function uploadLocalFile(roomId, file, senderId, senderName, onProgress = () => {}, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
    const reader = new FileReader();
    let isAborted = false;

    const onAbort = () => {
      isAborted = true;
      try { reader.abort(); } catch {}
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    reader.onprogress = event => {
      if (isAborted || signal?.aborted) return;
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    };
    reader.onload = async () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (isAborted || signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
      try {
        onProgress(100);
        const resolvedType = getMimeType(file.name, file.type);
        const res = await request(`/api/rooms/${roomId}/files`, {
          method: 'POST',
          body: JSON.stringify({ name: file.name, path: file.webkitRelativePath || file.name, type: resolvedType, size: file.size, data: reader.result, senderId, senderName }),
          signal
        });
        if (isAborted || signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
        resolve(res);
      } catch (error) {
        if (isAborted || signal?.aborted || error.name === 'AbortError') {
          reject(new DOMException('Upload cancelled', 'AbortError'));
        } else {
          reject(error);
        }
      }
    };
    reader.onerror = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (isAborted || signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
      } else {
        reject(new Error('Could not read this file.'));
      }
    };
    reader.readAsDataURL(file);
  });
}

export function watchLocalRoom(roomId, onUpdate, onError) {
  const stream = new EventSource(`${lanOrigin}/api/rooms/${roomId}/events`);
  stream.addEventListener('room', event => onUpdate(JSON.parse(event.data)));
  stream.addEventListener('expired', event => onUpdate(JSON.parse(event.data)));
  stream.onerror = () => onError?.(new Error('Local room connection lost.'));
  return () => stream.close();
}
