const CACHE_NAME = 'loopflow-shell-v4';
const SHELL = ['/', '/index.html', '/chat.html', '/styles.css', '/app.js', '/room.js', '/lan.js', '/storage.js', '/utils.js', '/firebase.js', '/webrtc.js', '/manifest.json', '/favicon.svg'];
const DOWNLOAD_PREFIX = '/__loopflow-download__/';
const pendingDownloads = new Map();

self.addEventListener('message', event => {
  const data = event.data || {};
  const port = event.ports[0];
  if (data.type === 'loopflow-download-support' && port) {
    port.postMessage({ type: 'loopflow-download-supported' });
    port.close();
    return;
  }
  if (data.type !== 'loopflow-prepare-download' || !port || !data.downloadId) return;

  let completeStream;
  const streamState = {
    port,
    controller: null,
    queuedChunks: [],
    ended: false,
    done: new Promise(resolve => { completeStream = resolve; }),
    completeStream: () => completeStream()
  };
  pendingDownloads.set(data.downloadId, streamState);
  port.onmessage = messageEvent => {
    const message = messageEvent.data || {};
    if (!streamState.controller) {
      if (message.type === 'download-chunk') streamState.queuedChunks.push(message.chunk);
      else if (message.type === 'download-complete') streamState.ended = true;
      else if (message.type === 'download-error') streamState.error = message.message || 'Download failed';
      return;
    }

    if (message.type === 'download-chunk') {
      streamState.controller.enqueue(new Uint8Array(message.chunk));
    } else if (message.type === 'download-complete') {
      streamState.controller.close();
      pendingDownloads.delete(data.downloadId);
      port.postMessage({ type: 'download-finished' });
      streamState.completeStream();
      port.close();
    } else if (message.type === 'download-error') {
      streamState.controller.error(new Error(message.message || 'Download failed'));
      pendingDownloads.delete(data.downloadId);
      port.postMessage({ type: 'download-failed', message: message.message || 'Download failed' });
      streamState.completeStream();
      port.close();
    }
  };
  port.start();
  port.postMessage({ type: 'download-prepared' });
  event.waitUntil(streamState.done);
});

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))));
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== location.origin) return;
  const requestUrl = new URL(event.request.url);
  if (requestUrl.pathname.startsWith(DOWNLOAD_PREFIX)) {
    const downloadId = decodeURIComponent(requestUrl.pathname.slice(DOWNLOAD_PREFIX.length));
    const state = pendingDownloads.get(downloadId);
    if (!state) {
      event.respondWith(new Response('Download stream is unavailable.', { status: 404 }));
      return;
    }

    const filename = String(requestUrl.searchParams.get('name') || 'download').replace(/[\r\n"]/g, '_');
    const mimeType = requestUrl.searchParams.get('type') || 'application/octet-stream';
    const body = new ReadableStream({
      start(controller) {
        state.controller = controller;
        for (const chunk of state.queuedChunks) controller.enqueue(new Uint8Array(chunk));
        state.queuedChunks = [];
        if (state.error) {
          controller.error(new Error(state.error));
          state.port.postMessage({ type: 'download-failed', message: state.error });
          state.completeStream();
          state.port.close();
        } else if (state.ended) {
          controller.close();
          state.port.postMessage({ type: 'download-finished' });
          state.completeStream();
          state.port.close();
        }
        else state.port.postMessage({ type: 'download-stream-ready' });
      },
      cancel() {
        pendingDownloads.delete(downloadId);
        state.port.postMessage({ type: 'download-cancelled' });
        state.completeStream();
        state.port.close();
      }
    });
    event.respondWith(new Response(body, {
      headers: {
        'Content-Type': /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mimeType) ? mimeType : 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store'
      }
    }));
    return;
  }

  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
    }
    return response;
  }).catch(() => caches.match(event.request).then(cached => cached || caches.match('/index.html'))));
});
