import { createRoom, joinRoom, makeRoomCode, watchRoom, deleteRoom, leaveRoomPresence, clearRoomData } from './room.js';
import { db, firebaseReady, ensureAnonymousUser } from './firebase.js';
import { addDoc, collection, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { uploadRoomFile } from './storage.js';
import { lanMode, localBridgeAvailable, createLocalRoomWithExpiry, joinLocalRoom, deleteLocalRoom, clearLocalRoom, sendLocalMessage, uploadLocalFile, watchLocalRoom } from './lan.js';
import { getMimeType, isImageFile, dataUrlToBlob, formatBytes, formatMessageText } from './utils.js';
import { connectDirectRoom, closeDirectRoom } from './webrtc.js';

const modal = document.querySelector('#room-modal');
const modalContent = document.querySelector('#modal-content');
const toast = document.querySelector('#toast');
const landingView = document.querySelector('#landing-view');
const chatView = document.querySelector('#chat-view');
const isChatPage = document.body.classList.contains('chat-page');

let toastTimer;
let deletedRoomCountdownInterval;
let createRoomEnterTimer;
let stopMessages;
let stopFiles;
let stopRoomPresence;
let stopCreateRoomWatch;
let roomCountdownInterval;
let currentRoomCode = null;
let currentConnectionMode = lanMode ? 'lan' : 'firebase';
let isRoomHost = false;
let stopLocalRoom;
let currentSharedFiles = [];
let latestRoomFiles = [];
let isDownloadingAllFiles = false;
let directFileBuffer = null;
let directSharedMessages = [];
let latestRoomMessages = [];
let activeUploadMessage = null;
let activeUploadMessages = [];
let recentlyCompletedUploadPaths = new Set();
const activeDownloadProgress = new Map();
let modalResolve = null;
let qrScanStream = null;
let qrScanFrame = null;
function makeClientId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
function getSenderName() {
  return /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'PC';
}
window.loopFlowUserId ||= makeClientId();

function chatUrl(code, creator = false) {
  const isLocalOrHtml = location.protocol === 'file:' || location.pathname.endsWith('.html');
  const route = isLocalOrHtml ? 'chat.html' : '/chat';
  return `${route}?room=${encodeURIComponent(code)}${creator ? '&creator=1' : ''}`;
}

function homeUrl() {
  return location.protocol === 'file:' || location.pathname.endsWith('.html') ? 'index.html' : '/';
}

if (location.protocol === 'file:') {
  document.querySelectorAll('a[href="/"]').forEach(link => { link.href = homeUrl(); });
}

function firebaseErrorMessage(error, fallback) {
  if (error?.code === 'auth/configuration-not-found') return 'Enable Anonymous Authentication in Firebase Console.';
  if (error?.code === 'auth/unauthorized-domain') return 'Add this site to Firebase Authorized domains.';
  if (error?.code === 'permission-denied') return 'Firebase rules denied this room action.';
  if (error?.code === 'storage/unknown' || error?.code === 'storage/bucket-not-found') return 'Configure Storage CORS for the deployed site, then retry.';
  return error?.message || fallback;
}

// Initial Hero QR preview
if (window.QRCode && document.querySelector('#hero-qr')) {
  const qrContainer = document.querySelector('#hero-qr');
  qrContainer.innerHTML = '';
  new window.QRCode(qrContainer, { text: `${location.origin}${location.pathname}?room=824716`, width: 80, height: 80, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.H });
  addQrLogo(qrContainer);
}

function showToast(message) {
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2600);
}

function openModal(content) {
  if (!modal || !modalContent) return;
  if (content !== undefined) modalContent.innerHTML = content;
  modal.hidden = false;
  window.lucide?.createIcons();
  modalContent.querySelector('input')?.focus();
}

function closeModal() {
  stopQrScanner();
  stopCreateRoomWatch?.();
  stopCreateRoomWatch = null;
  clearTimeout(createRoomEnterTimer);
  createRoomEnterTimer = null;
  modal?.querySelector('.room-modal')?.classList.remove('room-create-flow');
  modal?.querySelector('.room-modal')?.classList.remove('room-closed-notice');
  if (modalContent) delete modalContent.dataset.createRoomState;
  modal.hidden = true;
  if (modalResolve) {
    const resolve = modalResolve;
    modalResolve = null;
    resolve(false);
  }
}

function confirmInModal({ title, message, confirmLabel = 'Confirm' }) {
  return new Promise(resolve => {
    modalResolve = resolve;
    openModal(`<div class="eyebrow">PLEASE CONFIRM</div><h2 class="modal-title">${escapeHtml(title)}</h2><p class="modal-copy">${escapeHtml(message)}</p><div class="modal-actions"><button class="button button-ghost" id="modal-cancel-action" type="button">Cancel</button><button class="button button-primary" id="modal-confirm-action" type="button">${escapeHtml(confirmLabel)}</button></div>`);
    modalContent.querySelector('#modal-cancel-action')?.addEventListener('click', closeModal);
    modalContent.querySelector('#modal-confirm-action')?.addEventListener('click', () => {
      modalResolve = null;
      modal.hidden = true;
      resolve(true);
    });
  });
}

function stopQrScanner() {
  if (qrScanFrame) cancelAnimationFrame(qrScanFrame);
  qrScanFrame = null;
  qrScanStream?.getTracks().forEach(track => track.stop());
  qrScanStream = null;
  const video = document.querySelector('#join-qr-video');
  if (video) {
    video.pause();
    video.srcObject = null;
  }
  const scanner = document.querySelector('#join-scanner');
  const scanButton = document.querySelector('#scan-room-btn');
  if (scanner) scanner.hidden = true;
  if (scanButton) scanButton.hidden = false;
}

function scannedRoomCode(value) {
  const rawValue = String(value || '').trim();
  try {
    const scannedUrl = new URL(rawValue);
    const urlCode = scannedUrl.searchParams.get('room')?.replace(/\D/g, '').slice(0, 6);
    if (urlCode?.length === 6) return urlCode;
  } catch {}
  const directCode = rawValue.replace(/\D/g, '');
  return directCode.length === 6 ? directCode : null;
}

async function startQrScanner() {
  const scanner = document.querySelector('#join-scanner');
  const video = document.querySelector('#join-qr-video');
  const status = document.querySelector('#join-scanner-status');
  const scanButton = document.querySelector('#scan-room-btn');
  if (!scanner || !video || !status || !scanButton) return;
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
    status.textContent = 'QR scanning is not supported here. Enter the six digits below.';
    scanner.hidden = false;
    scanButton.hidden = true;
    return;
  }

  stopQrScanner();
  scanner.hidden = false;
  scanButton.hidden = true;
  status.textContent = 'Allow camera access, then point it at the room QR.';
  try {
    qrScanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
    video.srcObject = qrScanStream;
    await video.play();
    const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
    const scan = async () => {
      if (!qrScanStream || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        qrScanFrame = requestAnimationFrame(scan);
        return;
      }
      try {
        const barcodes = await detector.detect(video);
        const code = barcodes.map(barcode => scannedRoomCode(barcode.rawValue)).find(Boolean);
        if (code) {
          stopQrScanner();
          openQrRoomConfirmation(code);
          return;
        }
      } catch {}
      qrScanFrame = requestAnimationFrame(scan);
    };
    qrScanFrame = requestAnimationFrame(scan);
  } catch (error) {
    stopQrScanner();
    scanner.hidden = false;
    scanButton.hidden = false;
    status.textContent = error?.name === 'NotAllowedError'
      ? 'Camera access was blocked. Enter the six digits below instead.'
      : 'Could not start the camera. Enter the six digits below instead.';
  }
}

function openQRModal() {
  const code = currentRoomCode || '824716';
  const formattedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
  const roomUrl = currentRoomCode
    ? (currentConnectionMode === 'lan'
      ? `${location.origin}/chat?room=${code}&mode=lan`
      : `${location.origin}${location.pathname.startsWith('/chat') ? '/chat' : location.pathname}?room=${code}`)
    : `${location.origin}${location.pathname}?room=824716`;

  openModal(`
    <div class="qr-modal-view" style="text-align:center; padding: 8px 4px;">
      <div class="eyebrow" style="letter-spacing: 0.1em; margin-bottom: 4px;">SCAN TO CONNECT</div>
      <h2 class="modal-title" style="margin-bottom: 4px; font-size: 24px;">Room ${escapeHtml(formattedCode)}</h2>
      <p class="modal-copy" style="margin-bottom: 20px;">Point your phone camera to scan the code</p>
      <div class="qr-large-card" id="modal-qr-container" style="width: 240px; height: 240px; margin: 0 auto 16px; padding: 12px; background: #ffffff; border-radius: 16px; border: 1px solid var(--line); display: grid; place-items: center; box-shadow: var(--shadow-md);">
      </div>
      <button class="button button-outline button-small" id="copy-qr-link-btn" type="button" style="margin-top: 4px;">
        <i data-lucide="copy"></i> <span>Copy Room Link</span>
      </button>
    </div>
  `);

  const container = document.querySelector('#modal-qr-container');
  if (container && window.QRCode) {
    new window.QRCode(container, {
      text: roomUrl,
      width: 216,
      height: 216,
      colorDark: '#0f172a',
      colorLight: '#ffffff',
      correctLevel: window.QRCode.CorrectLevel.H
    });
    const img = container.querySelector('img, canvas');
    if (img) {
      img.style.width = '100%';
      img.style.height = '100%';
    }
    addQrLogo(container);
  }

  document.querySelector('#copy-qr-link-btn')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard?.writeText(roomUrl);
      showToast('Room link copied');
    } catch {
      showToast('Could not copy link');
    }
  });
}

function addQrLogo(container) {
  container.style.position = 'relative';
  const logo = document.createElement('img');
  logo.className = 'qr-center-logo';
  logo.src = new URL('./favicon.svg', import.meta.url).href;
  logo.alt = 'LoopFlow';
  logo.setAttribute('aria-hidden', 'true');
  Object.assign(logo.style, {
    position: 'absolute', left: '50%', top: '50%', zIndex: '10',
    width: 'clamp(28px, 24%, 44px)', height: 'clamp(28px, 24%, 44px)',
    transform: 'translate(-50%, -50%)', display: 'block', objectFit: 'contain',
    border: '3px solid #fff', borderRadius: '50%', background: '#fff', padding: '5px',
    boxSizing: 'border-box', boxShadow: '0 1px 5px rgba(15, 23, 42, .25)', pointerEvents: 'none'
  });
  container.append(logo);
}

document.addEventListener('click', event => {
  if (event.target.closest('.qr-panel') || event.target.closest('.scan-label')) {
    openQRModal();
  }
});

function renderMessages(messages) {
  const list = document.querySelector('#room-messages');
  if (!list) return;
  if (list.dataset.uploadCancelHandlerBound !== 'true') {
    list.addEventListener('click', event => {
      const cancelButton = event.target.closest('#timeline-cancel-upload-btn');
      if (!cancelButton) return;

      event.preventDefault();
      event.stopPropagation();

      const controller = currentUploadController;
      if (!controller || uploadCancelled) return;

      uploadCancelled = true;
      markActiveUploadCancelled();

      try {
        controller.abort();
      } catch {}

      currentUploadController = null;
    });
    list.dataset.uploadCancelHandlerBound = 'true';
  }
  latestRoomMessages = Array.isArray(messages) ? messages : [];
  // Canceled upload records are persisted as room messages, so reconstruct the
  // local render state whenever the room snapshot is refreshed.
  const persistedCancelledUploads = latestRoomMessages.filter(message =>
    (message.type === 'uploading-folder' || message.type === 'uploading') && message.status === 'cancelled'
  );
  cancelledUploadMessages = [
    ...persistedCancelledUploads,
    ...cancelledUploadMessages.filter(local =>
      !persistedCancelledUploads.some(saved => saved.cancelId && saved.cancelId === local.cancelId)
    )
  ];
  renderFiles(latestRoomFiles);
  const wasNearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  const folderMessages = new Map();
  const timelineMessages = [];
  const getMessageTime = message => {
    if (message.createdAt?.toMillis) return message.createdAt.toMillis();
    if (message.createdAt?.seconds) return Number(message.createdAt.seconds) * 1000;
    if (typeof message.createdAt === 'number') return message.createdAt;
    if (typeof message.clientCreatedAt === 'number') return message.clientCreatedAt;
    return 0;
  };
  [...latestRoomMessages, ...directSharedMessages].forEach(message => {
    if ((message.type === 'uploading-folder' || message.type === 'uploading') && message.status === 'cancelled') return;
    const path = String(message.filePath || '');
    if (message.type === 'file' && activeUploadMessages.some(upload =>
      upload.status === 'completed' &&
      (message.senderId === window.loopFlowUserId || !message.senderId) &&
      path === upload.fileName
    )) return;
    if (activeUploadMessage?.type === 'uploading-folder' &&
        path.startsWith(`${activeUploadMessage.folderName}/`) &&
        (!message.senderId || message.senderId === window.loopFlowUserId)) return;
    const belongsToCancelledBatch = cancelledUploadMessages.some(upload =>
      upload.type === 'uploading-folder' &&
      upload.status === 'cancelled' &&
      (!message.senderId || !upload.senderId || message.senderId === upload.senderId) &&
      upload.completedUploadPaths?.includes(path) &&
      Number(message.clientCreatedAt || getMessageTime(message)) <=
        Number(upload.cancelledAt || getMessageTime(upload))
    );
    if (belongsToCancelledBatch) return;
    const separator = message.type === 'file' ? path.indexOf('/') : -1;
    if (separator > 0) {
      const folderName = path.slice(0, separator);
      if (!folderMessages.has(folderName)) {
        folderMessages.set(folderName, { ...message, type: 'folder', folderName, folderFiles: [], createdAt: message.createdAt });
      }
      const folder = folderMessages.get(folderName);
      folder.folderFiles.push(message);
      if (getMessageTime(message) < getMessageTime(folder)) {
        folder.createdAt = message.createdAt;
        folder.clientCreatedAt = message.clientCreatedAt;
      }
    } else {
      timelineMessages.push(message);
    }
  });
  const liveUploadMessages = activeUploadMessages.length
    ? activeUploadMessages
    : (activeUploadMessage ? [activeUploadMessage] : []);
  liveUploadMessages.forEach(upload => {
    // Completed queue bubbles temporarily stand in for their persisted file
    // messages until the whole selection finishes.
    const uploadAlreadyInTimeline = timelineMessages.some(message =>
      message.type === 'file' &&
      (message.senderId === window.loopFlowUserId || !message.senderId) &&
      (message.filePath || message.fileName) === (upload.fileName || upload.currentFilePath)
    );
    if (upload.status !== 'completed' && !uploadAlreadyInTimeline) timelineMessages.push(upload);
    if (upload.status === 'completed') timelineMessages.push(upload);
  });
  timelineMessages.push(...cancelledUploadMessages);
  timelineMessages.push(...folderMessages.values());
  timelineMessages.sort((first, second) => getMessageTime(first) - getMessageTime(second));
  const senderNames = new Map();
  timelineMessages.forEach(message => {
    if (!message.senderId || !message.senderName || message.senderName === 'Device') return;
    if (!senderNames.has(message.senderId)) senderNames.set(message.senderId, message.senderName);
  });
  const displaySenderName = message => senderNames.get(message.senderId) || message.senderName || 'Device';
  const renderedMessages = timelineMessages.length ? timelineMessages.map(message => {
    const isOwn = message.senderId === window.loopFlowUserId;
    const filePath = String(message.filePath || '');
    const fileSettleClass = message.type === 'file' && recentlyCompletedUploadPaths.has(filePath) ? ' upload-file-settle' : '';
    const timestamp = message.createdAt?.toDate
      ? message.createdAt.toDate()
      : typeof message.createdAt === 'number'
        ? new Date(message.createdAt)
        : typeof message.clientCreatedAt === 'number'
          ? new Date(message.clientCreatedAt)
          : null;
    const timeStr = timestamp ? timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'now';
    if (message.type === 'folder') {
      const totalSize = message.folderFiles.reduce((total, file) => total + Number(file.fileSize || 0), 0);
      return `<div class="room-message ${isOwn ? 'room-message-own' : ''}" data-message-id="${message.id || ''}">
        ${!isOwn ? `<div class="message-sender-meta"><span class="message-sender">${escapeHtml(displaySenderName(message))}</span></div>` : ''}
        <div class="message-bubble-row">
          <div class="message-bubble message-bubble-file message-bubble-folder">
            <button class="shared-file-card shared-folder-card" type="button" data-folder-name="${escapeHtml(message.folderName)}" data-download-key="timeline-folder:${escapeHtml(message.folderName)}" aria-label="Download ${escapeHtml(message.folderName)} as ZIP">
              <span class="file-chip folder-chip"><i data-lucide="folder-open"></i></span>
              <div class="file-info-group">
                <b class="file-card-title" title="${escapeHtml(message.folderName)}">${escapeHtml(message.folderName)}</b>
                <small class="file-card-sub">${message.folderFiles.length} file${message.folderFiles.length === 1 ? '' : 's'} · ${formatBytes(totalSize)}</small>
              </div>
              <span class="file-action-icon" aria-label="Download ZIP"><i data-lucide="download"></i></span>
            </button>
            <div class="message-footer"><time>${timeStr}</time></div>
          </div>
        </div>
      </div>`;
    }
    if (message.type === 'uploading-folder' && message.status === 'cancelled') {
      return `<div class="room-message room-message-own" data-message-id="cancelled-upload" data-cancel-id="${escapeHtml(message.cancelId || message.id || '')}">
        <div class="message-bubble message-bubble-file upload-timeline-bubble upload-cancelled">
          <div class="upload-bubble-header">
            <div class="upload-bubble-icon"><i data-lucide="circle-x"></i></div>
            <div class="upload-bubble-info">
              <span class="upload-bubble-name" title="${escapeHtml(message.folderName)}">${escapeHtml(message.folderName)}</span>
              <span class="upload-bubble-size">${message.completedFiles || 0} of ${message.totalFiles || 0} files · Canceled</span>
            </div>
          </div>
        </div>
      </div>`;
    }
    if (message.type === 'uploading-folder') {
      const uploadProgress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      return `<div class="room-message room-message-own" data-message-id="active-upload" data-upload-id="${escapeHtml(message.uploadId || 'active')}">
        <div class="message-bubble message-bubble-file upload-timeline-bubble">
          <div class="upload-bubble-header">
            <div class="upload-bubble-icon"><i data-lucide="folder-open"></i></div>
            <div class="upload-bubble-info">
              <span class="upload-bubble-name" title="${escapeHtml(message.folderName)}">${escapeHtml(message.folderName)}</span>
              <span class="upload-bubble-size">${message.completedFiles || 0} of ${message.totalFiles} files · Uploading…</span>
            </div>
            ${message.status === 'completed' ? '' : '<button type="button" class="upload-bubble-cancel" id="timeline-cancel-upload-btn" title="Cancel folder upload" aria-label="Cancel folder upload"><i data-lucide="x"></i></button>'}
          </div>
          <div class="upload-bubble-progress-row">
            <div class="upload-bubble-progress" role="progressbar" aria-label="Folder upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${uploadProgress}">
              <span class="upload-bubble-progress-fill" data-upload-progress="${escapeHtml(message.uploadId || 'active')}" style="width: ${uploadProgress}%"></span>
            </div>
            <span class="upload-bubble-percent" data-upload-percent="${escapeHtml(message.uploadId || 'active')}">${message.status === 'queued' ? 'Waiting' : message.status === 'completed' ? 'Done' : `${uploadProgress}%`}</span>
          </div>
        </div>
      </div>`;
    }
    if (message.type === 'uploading' && message.status === 'cancelled') {
      return `<div class="room-message room-message-own" data-message-id="cancelled-upload">
        <div class="message-bubble message-bubble-file upload-timeline-bubble upload-cancelled">
          <div class="upload-bubble-header">
            <div class="upload-bubble-icon"><i data-lucide="circle-x"></i></div>
            <div class="upload-bubble-info">
              <span class="upload-bubble-name" title="${escapeHtml(message.fileName)}">${escapeHtml(message.fileName)}</span>
              <span class="upload-bubble-size">Canceled</span>
            </div>
          </div>
        </div>
      </div>`;
    }
    if (message.type === 'uploading') {
      const uploadProgress = Math.max(0, Math.min(100, Number(message.progress) || 0));
      return `<div class="room-message room-message-own" data-message-id="active-upload" data-upload-id="${escapeHtml(message.uploadId || 'active')}">
        <div class="message-bubble message-bubble-file upload-timeline-bubble">
          <div class="upload-bubble-header">
            <div class="upload-bubble-icon">
              <i data-lucide="${escapeHtml(message.icon || 'upload-cloud')}"></i>
            </div>
            <div class="upload-bubble-info">
              <span class="upload-bubble-name" title="${escapeHtml(message.fileName)}">${escapeHtml(message.fileName)}</span>
              <span class="upload-bubble-size">${message.status === 'queued' ? 'Waiting to upload' : message.status === 'completed' ? 'Uploaded' : 'Uploading…'}</span>
            </div>
            ${message.status === 'completed' ? '' : '<button type="button" class="upload-bubble-cancel" id="timeline-cancel-upload-btn" title="Cancel uploads" aria-label="Cancel uploads"><i data-lucide="x"></i></button>'}
          </div>
          <div class="upload-bubble-progress-row">
            <div class="upload-bubble-progress" role="progressbar" aria-label="File upload progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${uploadProgress}">
              <span class="upload-bubble-progress-fill" data-upload-progress="${escapeHtml(message.uploadId || 'active')}" style="width: ${uploadProgress}%"></span>
            </div>
            <span class="upload-bubble-percent" data-upload-percent="${escapeHtml(message.uploadId || 'active')}">${message.status === 'queued' ? 'Waiting' : message.status === 'completed' ? 'Done' : `${uploadProgress}%`}</span>
          </div>
        </div>
      </div>`;
    }
    if (message.type === 'file') {
      const ext = (message.fileName?.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
      const isImg = isImageFile(message.fileName, message.fileType) && !message.fileURL?.startsWith('chunked:');
      
      if (isImg) {
        return `<div class="room-message ${isOwn ? 'room-message-own' : ''}${fileSettleClass}" data-message-id="${message.id || ''}">
          ${!isOwn ? `<div class="message-sender-meta"><span class="message-sender">${escapeHtml(displaySenderName(message))}</span></div>` : ''}
          <div class="message-bubble-row">
            <div class="message-bubble message-bubble-file message-bubble-image">
              <a class="file-image-card shared-file-card" href="${message.fileURL}" data-filename="${escapeHtml(message.fileName)}" data-filetype="${escapeHtml(message.fileType || '')}" data-filesize="${Number(message.fileSize || 0)}" data-download-key="message:${escapeHtml(message.id || message.fileName)}" target="_blank" rel="noopener" download="${escapeHtml(message.fileName)}">
                <div class="image-preview-wrap">
                  <img class="file-preview-img" src="${message.fileURL}" alt="${escapeHtml(message.fileName)}" loading="lazy" onload="this.classList.add('is-loaded')">
                  <div class="image-preview-overlay">
                    <span class="image-download-badge"><i data-lucide="download"></i> Download</span>
                  </div>
                </div>
                <div class="file-image-caption">
                  <div class="file-image-details">
                    <span class="file-image-name" title="${escapeHtml(message.fileName)}">${escapeHtml(message.fileName)}</span>
                    <span class="file-image-size">${formatBytes(message.fileSize)}</span>
                  </div>
                  <div class="message-footer"><time>${timeStr}</time></div>
                </div>
              </a>
            </div>
          </div>
        </div>`;
      }

      return `<div class="room-message ${isOwn ? 'room-message-own' : ''}${fileSettleClass}" data-message-id="${message.id || ''}">
        ${!isOwn ? `<div class="message-sender-meta"><span class="message-sender">${escapeHtml(displaySenderName(message))}</span></div>` : ''}
        <div class="message-bubble-row">
          <div class="message-bubble message-bubble-file">
            <a class="shared-file-card" href="${message.fileURL}" data-filename="${escapeHtml(message.fileName)}" data-filetype="${escapeHtml(message.fileType || '')}" data-filesize="${Number(message.fileSize || 0)}" data-download-key="message:${escapeHtml(message.id || message.fileName)}" target="_blank" rel="noopener" download="${escapeHtml(message.fileName)}">
              <span class="file-chip">${ext}</span>
              <div class="file-info-group">
                <b class="file-card-title" title="${escapeHtml(message.fileName)}">${escapeHtml(message.fileName)}</b>
                <small class="file-card-sub">${formatBytes(message.fileSize)}</small>
              </div>
              <span class="file-action-icon" aria-label="Download file"><i data-lucide="download"></i></span>
            </a>
            <div class="message-footer"><time>${timeStr}</time></div>
          </div>
        </div>
      </div>`;
    }
    return `<div class="room-message ${isOwn ? 'room-message-own' : ''}">
      ${!isOwn ? `<div class="message-sender-meta"><span class="message-sender">${escapeHtml(message.senderName || 'Device')}</span></div>` : ''}
      <div class="message-bubble-row">
        <div class="message-bubble message-copy-target" role="button" tabindex="0" data-copy="${escapeHtml(message.content)}" aria-label="Copy message">
          <span class="message-copy-feedback" aria-hidden="true">Copied</span>
          ${renderMessageBody(message.content)}
          <div class="message-footer"><time>${timeStr}</time></div>
        </div>
      </div>
    </div>`;
  }).join('') : '<div class="room-empty"><i data-lucide="sparkles" class="room-empty-icon"></i><b>This room is ready</b><p>Messages and shared files will appear here.</p></div>';
  timelineMessages.forEach(message => {
    if (message.type === 'file') recentlyCompletedUploadPaths.delete(String(message.filePath || ''));
  });
  const messagesChanged = list.dataset.renderedMarkup !== renderedMessages;
  if (messagesChanged) {
    list.innerHTML = renderedMessages;
    list.dataset.renderedMarkup = renderedMessages;
    window.lucide?.createIcons();
    restoreDownloadProgress(list);
  }
  if (activeUploadMessage && !uploadCancelled) updateUploadProgressUI(activeUploadMessage.progress || 0);
  if (wasNearBottom) list.scrollTop = list.scrollHeight;
  if (messagesChanged) {
    list.querySelectorAll('.message-copy-target').forEach(messageBubble => {
      messageBubble.addEventListener('click', event => {
        if (event.target.closest('.message-copy-button')) return;
        copyText(messageBubble.dataset.copy, messageBubble);
      });
      messageBubble.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        copyText(messageBubble.dataset.copy, messageBubble);
      });
    });
    list.querySelectorAll('.message-copy-button').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      copyText(button.dataset.copy, button);
    }));
    list.querySelectorAll('.shared-file-card').forEach(link => {
      link.addEventListener('click', event => {
        if (link.dataset.folderName) {
          event.preventDefault();
          downloadFolderSharedFiles(link.dataset.folderName, link);
          return;
        }
        const fileName = link.dataset.filename || link.getAttribute('download') || '';
        const fileType = link.dataset.filetype || '';
        handleFileCardClick(event, link, fileName, fileType);
      });
    });
  }
}

function handleDirectMessage(message) {
  if (message.type === 'file-start') {
    directFileBuffer = { name: message.name, mime: message.mime || 'application/octet-stream', size: message.size, chunks: [], received: 0 };
    return;
  }
  if (message.type === 'file-chunk' && directFileBuffer) {
    directFileBuffer.chunks.push(message.data);
    directFileBuffer.received += message.data.byteLength || 0;
    return;
  }
  if (message.type === 'file-end' && directFileBuffer) {
    const file = directFileBuffer;
    directFileBuffer = null;
    const url = URL.createObjectURL(new Blob(file.chunks, { type: file.mime }));
    addDirectFileMessage(file.name, file.mime, file.size, url, 'remote-direct', file.senderName);
  }
}

function addDirectFileMessage(fileName, fileType, fileSize, fileURL, senderId, senderName) {
  directSharedMessages.push({
    id: `direct-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    fileName: fileName || 'loopflow-file',
    fileType: fileType || 'application/octet-stream',
    fileSize: Number(fileSize || 0),
    fileURL,
    senderId,
    senderName: senderName || (senderId === window.loopFlowUserId ? 'You' : 'Device'),
    type: 'file',
    createdAt: Date.now()
  });
  renderMessages(latestRoomMessages);
}

function clearDirectFileMessages() {
  directSharedMessages.forEach(message => {
    if (message.fileURL?.startsWith('blob:')) URL.revokeObjectURL(message.fileURL);
  });
  directSharedMessages = [];
}

async function handleFileCardClick(event, link, fileName = '', fileType = '') {
  const rawHref = link.getAttribute('href');
  if (!rawHref || rawHref === '#') return;
  event.preventDefault();
  if (link.classList.contains('is-downloading') || activeDownloadProgress.has(link.dataset.downloadKey)) return;
  link.classList.add('is-downloading');
  const downloadName = link.getAttribute('download') || fileName || 'download';
  updateDownloadProgress(link, null, 'Downloading…');
  const resolvedMime = getMimeType(fileName, fileType);
  try {
    let blob;
    if (rawHref.startsWith('chunked:')) {
      const parts = rawHref.split(':');
      const fileId = parts[1];
      blob = await downloadChunkedFile(currentRoomCode, fileId, resolvedMime, downloadName,
        (loaded, total) => updateDownloadProgress(link, total ? loaded / total * 100 : null, 'Downloading…'));
    } else {
      blob = await getFileBlob({ fileURL: rawHref, fileName, fileType, fileSize: Number(link.dataset.filesize || 0) },
        (loaded, total) => updateDownloadProgress(link, total ? loaded / total * 100 : null, 'Downloading…'));
    }
    const blobUrl = URL.createObjectURL(blob);
    triggerBlobDownload(blobUrl, downloadName);
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    finishDownloadProgress(link, 'Downloaded');
  } catch (error) {
    console.error('File download error:', error);
    finishDownloadProgress(link, 'Download failed');
  }
}

function triggerBlobDownload(blobUrl, fileName) {
  const tempA = document.createElement('a');
  tempA.href = blobUrl;
  tempA.download = fileName;
  document.body.appendChild(tempA);
  tempA.click();
  tempA.remove();
}

function dataUrlToUint8Array(dataUrl) {
  const base64 = dataUrl.split(',')[1] || dataUrl;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function downloadProgressNodes(key) {
  if (!key) return [];
  return [...document.querySelectorAll('[data-download-key]')].filter(node => node.dataset.downloadKey === key);
}

function updateDownloadProgress(element, percent, status) {
  const key = element?.dataset.downloadKey;
  if (!element || !key) return;
  const state = { percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null, status };
  activeDownloadProgress.set(key, state);
  const nodes = downloadProgressNodes(key);
  if (!nodes.includes(element)) nodes.push(element);
  nodes.forEach(node => {
    node.classList.toggle('is-downloading', status !== 'Downloaded' && status !== 'Download failed');
    const host = node.closest('.message-bubble-file') || node;
    let progress = host.querySelector(':scope > .download-progress');
    if (!progress) {
      progress = document.createElement('div');
      progress.className = 'download-progress';
      progress.innerHTML = '<div class="download-progress-row"><span class="download-progress-status"></span><span class="download-progress-percent"></span></div><div class="download-progress-track"><div class="download-progress-fill"></div></div>';
      host.append(progress);
    }
    progress.querySelector('.download-progress-status').textContent = state.status;
    const percentLabel = progress.querySelector('.download-progress-percent');
    percentLabel.textContent = state.percent === null ? '' : `${Math.round(state.percent)}%`;
    percentLabel.hidden = state.percent === null;
    progress.querySelector('.download-progress-fill').style.width = `${state.percent ?? 0}%`;
    progress.querySelector('.download-progress-track').hidden = state.percent === null;
  });
}

function restoreDownloadProgress(container) {
  if (!container) return;
  for (const [key, state] of activeDownloadProgress) {
    const nodes = [...container.querySelectorAll('[data-download-key]')].filter(node => node.dataset.downloadKey === key);
    nodes.forEach(node => updateDownloadProgress(node, state.percent, state.status));
  }
}

function finishDownloadProgress(element, status) {
  const key = element?.dataset.downloadKey;
  if (!element || !key) return;
  const previous = activeDownloadProgress.get(key);
  updateDownloadProgress(element, status === 'Downloaded' ? 100 : previous?.percent ?? null, status);
  const state = activeDownloadProgress.get(key);
  downloadProgressNodes(key).forEach(node => node.classList.remove('is-downloading'));
  setTimeout(() => {
    if (activeDownloadProgress.get(key) !== state) return;
    downloadProgressNodes(key).forEach(node => {
      const host = node.closest('.message-bubble-file') || node;
      host.querySelector(':scope > .download-progress')?.remove();
    });
    activeDownloadProgress.delete(key);
  }, 1400);
}

async function downloadChunkedFile(roomId, fileId, mimeType = 'application/octet-stream', fileName = 'download', onProgress = null) {
  const fileSnapshot = await getDoc(doc(db, 'rooms', roomId, 'files', fileId));
  if (!fileSnapshot.exists()) throw new Error('File metadata is missing.');
  const metadata = fileSnapshot.data();
  const chunkCount = Number(metadata.chunkCount || 0);
  const totalBytes = Number(metadata.fileSize || 0);
  if (!Number.isSafeInteger(chunkCount) || chunkCount < 0) throw new Error('File chunk metadata is invalid.');
  const byteArrays = [];
  let loadedBytes = 0;
  for (let index = 0; index < chunkCount; index++) {
    const chunkId = String(index).padStart(6, '0');
    const chunkSnapshot = await getDoc(doc(db, 'rooms', roomId, 'files', fileId, 'chunks', chunkId));
    if (!chunkSnapshot.exists()) throw new Error(`Missing file part ${index + 1}`);
    const bytes = dataUrlToUint8Array(String(chunkSnapshot.data().data || ''));
    byteArrays.push(bytes);
    loadedBytes += bytes.byteLength;
    onProgress?.(loadedBytes, totalBytes);
  }
  return new Blob(byteArrays, { type: mimeType || 'application/octet-stream' });
}

function looksLikeCode(content) {
  const text = String(content).trim();
  return /^(?:public\s+(?:class|static)|class\s+\w+|def\s+\w+|import\s+\w+|from\s+\w+\s+import|<\/?[a-z][\s\S]*>|[.#][\w-]+\s*\{)[\s\S]*/i.test(text)
    || (/\{[\s\S]*\}/.test(text) && /(?:;|=>|\breturn\b|\bconst\b|\blet\b|\bvar\b)/.test(text));
}

function codeBlock(code, language = '') {
  const label = language ? language.toUpperCase() : 'CODE';
  return `<div class="message-code"><div class="message-code-head"><span>${escapeHtml(label)}</span></div><pre><code>${escapeHtml(code)}</code></pre></div>`;
}

function renderMessageBody(content) {
  const text = String(content || '');
  const fenced = /```([\w+-]+)?\s*\n([\s\S]*?)```/g;
  if (fenced.test(text)) {
    fenced.lastIndex = 0;
    let cursor = 0;
    let match;
    let html = '<div class="message-rich-text">';
    while ((match = fenced.exec(text))) {
      if (match.index > cursor) html += `<p>${formatMessageText(text.slice(cursor, match.index)).replace(/\n/g, '<br>')}</p>`;
      html += codeBlock(match[2].replace(/\n$/, ''), match[1]);
      cursor = fenced.lastIndex;
    }
    if (cursor < text.length) html += `<p>${formatMessageText(text.slice(cursor)).replace(/\n/g, '<br>')}</p>`;
    return `${html}</div>`;
  }
  if (looksLikeCode(text)) return codeBlock(text);
  return `<p>${formatMessageText(text).replace(/\n/g, '<br>')}</p>`;
}

async function copyText(value, button) {
  try {
    await navigator.clipboard?.writeText(value || '');
    const label = button?.querySelector('span');
    const previous = label?.textContent;
    const feedback = button?.querySelector('.message-copy-feedback');
    button?.classList.add('is-loading', 'is-copied');
    if (label) label.textContent = 'Copied';
    if (feedback) feedback.textContent = 'Copied';
    setTimeout(() => { button?.classList.remove('is-loading', 'is-copied'); if (label) label.textContent = previous; }, 1200);
    if (!button?.classList.contains('message-copy-target')) showToast('Copied to clipboard');
  } catch { showToast('Clipboard access was not available'); }
}

function renderFiles(files) {
  const list = document.querySelector('#room-files');
  const countBadge = document.querySelector('#sidebar-files-count');
  const downloadAllButton = document.querySelector('#download-all-files-btn');
  latestRoomFiles = Array.isArray(files) ? files : [];
  const getFileTime = file => {
    const value = file.clientCreatedAt ?? file.uploadedAt ?? file.createdAt;
    if (value?.toMillis) return value.toMillis();
    if (value?.seconds) return Number(value.seconds) * 1000;
    return Number(value) || 0;
  };
  currentSharedFiles = latestRoomFiles.filter(file => {
    const path = String(file.filePath || '');
    return !cancelledUploadMessages.some(upload =>
      upload.type === 'uploading-folder' &&
      upload.status === 'cancelled' &&
      (!file.senderId || !upload.senderId || file.senderId === upload.senderId) &&
      upload.completedUploadPaths?.includes(path) &&
      getFileTime(file) <= Number(upload.cancelledAt || upload.clientCreatedAt || 0)
    );
  });
  if (countBadge) countBadge.textContent = currentSharedFiles.length;
  if (downloadAllButton && !isDownloadingAllFiles) {
    downloadAllButton.disabled = !currentSharedFiles.length;
    const hasFolderPaths = currentSharedFiles.some(file => String(file.filePath || '').includes('/'));
    downloadAllButton.querySelector('span').textContent = hasFolderPaths ? 'Download folder as ZIP' : 'Download all as ZIP';
    downloadAllButton.classList.remove('is-downloading');
    downloadAllButton.removeAttribute('aria-busy');
  }
  if (!list) return;
  const folderGroups = new Map();
  const standaloneFiles = [];
  currentSharedFiles.forEach(file => {
    const path = String(file.filePath || '');
    const separator = path.indexOf('/');
    if (separator > 0) {
      const folderName = path.slice(0, separator);
      if (!folderGroups.has(folderName)) folderGroups.set(folderName, []);
      folderGroups.get(folderName).push(file);
    } else {
      standaloneFiles.push(file);
    }
  });
  const folderCards = [...folderGroups.entries()].map(([folderName, folderFiles]) => {
    const totalSize = folderFiles.reduce((total, file) => total + Number(file.fileSize || 0), 0);
    return `<button class="shared-file-card shared-folder-card" type="button" data-folder-name="${escapeHtml(folderName)}" data-download-key="sidebar-folder:${escapeHtml(folderName)}" aria-label="Download ${escapeHtml(folderName)} as ZIP"><span class="file-chip folder-chip"><i data-lucide="folder-open"></i></span><div><b>${escapeHtml(folderName)}</b><small>${folderFiles.length} file${folderFiles.length === 1 ? '' : 's'} · ${formatBytes(totalSize)}</small></div><i class="folder-download-icon" data-lucide="download"></i></button>`;
  });
  const fileCards = standaloneFiles.map(file => {
    const isImg = isImageFile(file.fileName, file.fileType) && !file.fileURL?.startsWith('chunked:');
    const ext = (file.fileName?.split('.').pop() || 'FILE').slice(0, 4).toUpperCase();
    const preview = isImg
      ? `<img class="file-preview" src="${file.fileURL}" alt="" loading="lazy" onload="this.classList.add('is-loaded')">`
      : file.fileType?.startsWith('video/') && file.fileURL && !file.fileURL.startsWith('chunked:')
        ? `<video class="file-preview" src="${file.fileURL}" muted preload="metadata"></video>`
        : file.fileType?.startsWith('audio/')
          ? '<span class="file-chip"><i data-lucide="music"></i></span>'
          : `<span class="file-chip">${ext}</span>`;
    return `<a class="shared-file-card" href="${file.fileURL || '#'}" data-filename="${escapeHtml(file.fileName)}" data-filetype="${escapeHtml(file.fileType || '')}" data-filesize="${Number(file.fileSize || 0)}" data-download-key="sidebar-file:${escapeHtml(file.id || file.fileName)}" target="_blank" rel="noopener" download="${escapeHtml(file.fileName)}">${preview}<div><b>${escapeHtml(file.fileName)}</b><small>${formatBytes(file.fileSize)}</small></div><i data-lucide="download"></i></a>`;
  });
  list.innerHTML = folderCards.concat(fileCards).join('') || '<div class="files-empty"><small>No files shared yet</small></div>';
  window.lucide?.createIcons();
  restoreDownloadProgress(list);
  list.querySelectorAll('.shared-file-card').forEach(link => {
    link.addEventListener('click', event => {
      const folderName = link.dataset.folderName;
      if (folderName) {
          event.preventDefault();
          downloadFolderSharedFiles(folderName, link);
        return;
      }
      const fileName = link.dataset.filename || link.getAttribute('download') || '';
      const fileType = link.dataset.filetype || '';
      handleFileCardClick(event, link, fileName, fileType);
    });
  });
}

async function downloadFolderSharedFiles(folderName, downloadButton = null) {
  const files = currentSharedFiles.filter(file => String(file.filePath || '').startsWith(`${folderName}/`));
  if (!files.length) {
    downloadButton?.classList.remove('is-downloading');
    return;
  }
  if (downloadButton?.classList.contains('is-downloading') || activeDownloadProgress.has(downloadButton?.dataset.downloadKey)) return;
  downloadButton?.classList.add('is-downloading');
  updateDownloadProgress(downloadButton, null, 'Preparing download…');
  try {
    const usedNames = new Set();
    const entries = [];
    const totalBytes = files.reduce((total, file) => total + Number(file.fileSize || 0), 0);
    const hasAllSizes = files.every(file => Number(file.fileSize) > 0);
    let completedBytes = 0;
    for (const file of files) {
      const relativeName = String(file.filePath).slice(folderName.length + 1);
      const fileSize = Number(file.fileSize || 0);
      const blob = await getFileBlob(file, (loaded, total) => {
        const actualTotal = total || fileSize;
        const progress = hasAllSizes && totalBytes && actualTotal ? (completedBytes + Math.min(loaded, actualTotal)) / totalBytes * 100 : null;
        updateDownloadProgress(downloadButton, progress, 'Preparing download…');
      });
      entries.push({ name: uniqueZipName(relativeName || file.fileName, usedNames), bytes: new Uint8Array(await blob.arrayBuffer()) });
      completedBytes += fileSize || blob.size;
      updateDownloadProgress(downloadButton, hasAllSizes && totalBytes ? completedBytes / totalBytes * 100 : null, 'Preparing download…');
    }
    updateDownloadProgress(downloadButton, null, 'Creating ZIP…');
    const zipUrl = URL.createObjectURL(createZipBlob(entries));
    triggerBlobDownload(zipUrl, `${folderName}.zip`);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    finishDownloadProgress(downloadButton, 'Downloaded');
  } catch (error) {
    console.error('Folder download error:', error);
    finishDownloadProgress(downloadButton, 'Download failed');
  } finally {
    downloadButton?.classList.remove('is-downloading');
  }
}

function uniqueZipName(fileName, usedNames) {
  const safeName = String(fileName || 'download')
    .replace(/\\/g, '/')
    .split('/')
    .filter(part => part && part !== '.' && part !== '..')
    .map(part => part.replace(/[*?:"<>|]/g, '_'))
    .join('/') || 'download';
  if (!usedNames.has(safeName)) {
    usedNames.add(safeName);
    return safeName;
  }
  const slashIndex = safeName.lastIndexOf('/');
  const directory = slashIndex >= 0 ? safeName.slice(0, slashIndex + 1) : '';
  const baseName = slashIndex >= 0 ? safeName.slice(slashIndex + 1) : safeName;
  const dotIndex = baseName.lastIndexOf('.');
  const stem = directory + (dotIndex > 0 ? baseName.slice(0, dotIndex) : baseName);
  const extension = dotIndex > 0 ? baseName.slice(dotIndex) : '';
  let number = 2;
  let candidate = `${stem} (${number})${extension}`;
  while (usedNames.has(candidate)) candidate = `${stem} (${++number})${extension}`;
  usedNames.add(candidate);
  return candidate;
}

async function getFileBlob(file, onProgress = null) {
  const fileUrl = file.fileURL || '';
  const mimeType = getMimeType(file.fileName, file.fileType);
  if (fileUrl.startsWith('chunked:')) {
    const [, fileId] = fileUrl.split(':');
    return downloadChunkedFile(currentRoomCode, fileId, mimeType, file.fileName,
      (loaded, total) => onProgress?.(loaded, total || Number(file.fileSize || 0)));
  }
  if (fileUrl.startsWith('data:')) {
    const blob = dataUrlToBlob(fileUrl, mimeType);
    onProgress?.(blob.size, blob.size);
    return blob;
  }
  if (fileUrl.startsWith('http://') || fileUrl.startsWith('https://')) {
    const response = await fetch(fileUrl);
    if (!response.ok) throw new Error(`Could not retrieve ${file.fileName || 'file'}`);
    const contentLength = Number(response.headers.get('content-length') || file.fileSize || 0);
    if (!response.body) {
      const blob = await response.blob();
      onProgress?.(blob.size, contentLength || blob.size);
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, contentLength);
    }
    return new Blob(chunks, { type: response.headers.get('content-type') || mimeType });
  }
  throw new Error(`Unsupported file source for ${file.fileName || 'file'}`);
}

function crc32(bytes) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function uint16(value) { return new Uint8Array([value & 255, (value >>> 8) & 255]); }
function uint32(value) { return new Uint8Array([value & 255, (value >>> 8) & 255, (value >>> 16) & 255, (value >>> 24) & 255]); }

function createZipBlob(entries) {
  const encoder = new TextEncoder();
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, bytes } of entries) {
    const nameBytes = encoder.encode(name);
    const crc = crc32(bytes);
    const localHeader = new Uint8Array([
      ...uint32(0x04034b50), ...uint16(20), ...uint16(0x0800), ...uint16(0),
      ...uint16(0), ...uint16(0), ...uint32(crc), ...uint32(bytes.length), ...uint32(bytes.length),
      ...uint16(nameBytes.length), ...uint16(0), ...nameBytes
    ]);
    localParts.push(localHeader, bytes);
    const centralHeader = new Uint8Array([
      ...uint32(0x02014b50), ...uint16(20), ...uint16(20), ...uint16(0x0800), ...uint16(0),
      ...uint16(0), ...uint16(0), ...uint32(crc), ...uint32(bytes.length), ...uint32(bytes.length),
      ...uint16(nameBytes.length), ...uint16(0), ...uint16(0), ...uint16(0), ...uint16(0),
      ...uint32(0), ...uint32(offset), ...nameBytes
    ]);
    centralParts.push(centralHeader);
    offset += localHeader.length + bytes.length;
  }
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
  const endRecord = new Uint8Array([
    ...uint32(0x06054b50), ...uint16(0), ...uint16(0), ...uint16(entries.length), ...uint16(entries.length),
    ...uint32(centralSize), ...uint32(offset), ...uint16(0)
  ]);
  return new Blob([...localParts, ...centralParts, endRecord], { type: 'application/zip' });
}

async function downloadAllSharedFiles() {
  const button = document.querySelector('#download-all-files-btn');
  const files = [...currentSharedFiles];
  if (!files.length || !button || button.classList.contains('is-downloading')) return;
  isDownloadingAllFiles = true;
  button.disabled = true;
  button.classList.add('is-downloading');
  button.setAttribute('aria-busy', 'true');
  updateDownloadProgress(button, null, 'Preparing download…');
  const label = button.querySelector('span');
  const usedNames = new Set();
  try {
    const entries = [];
    const totalBytes = files.reduce((total, file) => total + Number(file.fileSize || 0), 0);
    const hasAllSizes = files.every(file => Number(file.fileSize) > 0);
    let completedBytes = 0;
    for (let index = 0; index < files.length; index++) {
      label.textContent = `Preparing ${index + 1} of ${files.length}`;
      const fileSize = Number(files[index].fileSize || 0);
      const blob = await getFileBlob(files[index], (loaded, total) => {
        const actualTotal = total || fileSize;
        const progress = hasAllSizes && totalBytes && actualTotal ? (completedBytes + Math.min(loaded, actualTotal)) / totalBytes * 100 : null;
        updateDownloadProgress(button, progress, `Preparing ${index + 1} of ${files.length}`);
      });
      entries.push({ name: uniqueZipName(files[index].filePath || files[index].fileName, usedNames), bytes: new Uint8Array(await blob.arrayBuffer()) });
      completedBytes += fileSize || blob.size;
      updateDownloadProgress(button, hasAllSizes && totalBytes ? completedBytes / totalBytes * 100 : null, `Preparing ${index + 1} of ${files.length}`);
    }
    label.textContent = 'Creating ZIP…';
    updateDownloadProgress(button, null, 'Creating ZIP…');
    const zipUrl = URL.createObjectURL(createZipBlob(entries));
    triggerBlobDownload(zipUrl, `loopflow-room-${currentRoomCode || 'files'}.zip`);
    setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
    finishDownloadProgress(button, 'Downloaded');
  } catch (error) {
    console.error('Download all files error:', error);
    finishDownloadProgress(button, 'Download failed');
  } finally {
    isDownloadingAllFiles = false;
    button.disabled = !currentSharedFiles.length;
    button.classList.remove('is-downloading');
    button.removeAttribute('aria-busy');
    label.textContent = currentSharedFiles.some(file => String(file.filePath || '').includes('/')) ? 'Download folder as ZIP' : 'Download all as ZIP';
  }
}



function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
}

async function openCreateRoom(event) {
  const renderCreateRoomState = (state, content) => {
    modalContent.dataset.createRoomState = state;
    modalContent.innerHTML = content;
    window.lucide?.createIcons();
  };

  renderCreateRoomState('duration-selection', `<div class="room-create-start-screen"><div class="room-create-start-heading"><div class="eyebrow">CREATE A ROOM</div><h2 class="modal-title" id="modal-title">Choose how long it stays open.</h2><p class="modal-copy">Room and files are deleted when time ends.</p></div><div class="room-create-start-controls"><span class="room-setting-label">Room duration</span><div class="room-duration-chips" role="group" aria-label="Room duration"><span class="chips-slider" aria-hidden="true"></span><button type="button" data-duration="10">10 minutes</button><button type="button" class="is-selected" data-duration="30">30 minutes</button><button type="button" data-duration="60">1 hour</button><button type="button" data-duration="120">2 hours</button></div><div class="modal-actions"><button class="button button-primary" id="create-room-confirm" type="button"><i data-lucide="plus"></i><span>Create room</span></button></div></div></div>`);
  modal?.querySelector('.room-modal')?.classList.add('room-create-flow');
  openModal();
  let lifetimeMinutes = 30;

  const moveSlider = (chip) => {
    const slider = document.querySelector('.room-duration-chips .chips-slider');
    if (!slider || !chip) return;
    slider.style.width  = chip.offsetWidth  + 'px';
    slider.style.height = chip.offsetHeight + 'px';
    slider.style.transform = `translate(${chip.offsetLeft}px, ${chip.offsetTop}px)`;
  };

  // position slider on the default selected chip immediately (no transition on first paint)
  requestAnimationFrame(() => {
    const defaultChip = document.querySelector('.room-duration-chips .is-selected');
    const slider = document.querySelector('.room-duration-chips .chips-slider');
    if (slider) slider.style.transition = 'none';
    moveSlider(defaultChip);
    requestAnimationFrame(() => {
      if (slider) slider.style.transition = '';
    });
  });

  document.querySelector('.room-duration-chips')?.addEventListener('click', event => {
    const option = event.target.closest('[data-duration]');
    if (!option) return;
    lifetimeMinutes = Number(option.dataset.duration);
    document.querySelectorAll('.room-duration-chips button').forEach(chip => chip.classList.toggle('is-selected', chip === option));
    moveSlider(option);
  });
  document.querySelector('#create-room-confirm')?.addEventListener('click', async buttonEvent => {
    const button = buttonEvent.currentTarget;
    button.disabled = true;
    button.classList.add('is-loading');
    button.innerHTML = '<span class="button-spinner"></span><span>Creating room</span>';
    try {
      const code = makeRoomCode();
      if (await localBridgeAvailable().catch(() => false)) {
        const localRoom = await createLocalRoomWithExpiry(lifetimeMinutes);
        const localUrl = `http://${localRoom.address}:${localRoom.port}/chat?room=${localRoom.roomId}&mode=lan&creator=1`;
        location.assign(localUrl);
        return;
      }
      const createdRoom = await createRoom(code, lifetimeMinutes);
      const roomUrl = `${location.origin}${location.pathname.startsWith('/chat') ? '/chat' : location.pathname}?room=${code}`;
      const formattedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
      renderCreateRoomState('room-created', `<div class="room-create-screen-enter"><div class="room-share-header"><div class="eyebrow">ROOM CREATED</div><h2 class="modal-title" id="modal-title">Share your room.</h2><p class="modal-copy">Scan to join.</p></div><div class="room-share-layout"><div class="room-share-qr-column"><div class="qr-large-card create-room-qr" id="create-room-qr"></div></div><div class="room-share-details"><p class="create-room-code">Room <span class="room-code-digits">${escapeHtml(formattedCode)}</span></p><div class="create-room-waiting" role="status" aria-live="polite"><span class="create-room-pulse" aria-hidden="true"></span><span id="create-room-waiting">Ready to connect</span></div><div class="modal-actions"><button class="button button-primary" id="enter-created-room" type="button">Enter room now</button></div></div></div></div>`);
      const qr = document.querySelector('#create-room-qr');
      if (qr && window.QRCode) {
        new window.QRCode(qr, { text: roomUrl, width: 208, height: 208, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.H });
        const image = qr.querySelector('img, canvas');
        if (image) { image.style.width = '100%'; image.style.height = '100%'; }
        addQrLogo(qr);
      }
      const enterCreatedRoom = (participantJoined = false) => {
        if (modal.hidden || createRoomEnterTimer) return;
        stopCreateRoomWatch?.();
        stopCreateRoomWatch = null;
        const screen = modalContent.querySelector('.room-create-screen-enter');
        const status = document.querySelector('#create-room-waiting');
        const enterButton = document.querySelector('#enter-created-room');
        if (status) status.textContent = participantJoined ? 'Someone joined. Taking you to the room…' : 'Opening your room…';
        status?.closest('.create-room-waiting')?.classList.add('is-connected');
        if (enterButton) {
          enterButton.disabled = true;
          enterButton.innerHTML = '<span class="button-spinner"></span><span>Opening room</span>';
        }
        screen?.classList.add('is-connecting');
        createRoomEnterTimer = window.setTimeout(() => {
          createRoomEnterTimer = null;
          if (modal.hidden) return;
          openChat(code, { creator: true });
          requestAnimationFrame(() => closeModal());
        }, participantJoined ? 1100 : 700);
      };
      document.querySelector('#enter-created-room')?.addEventListener('click', () => enterCreatedRoom(false));
      if (createdRoom.mode === 'firebase') {
        stopCreateRoomWatch = watchRoom(code, room => {
          if (room?.status === 'active' && (Number(room.activeUsers) > 1 || (room.devices?.length || 0) > 1)) {
            enterCreatedRoom(true);
          }
        }, error => console.warn('Room join watcher failed:', error));
      } else {
        const waiting = document.querySelector('#create-room-waiting');
        if (waiting) waiting.textContent = 'Share the code, then enter the room when you are ready.';
      }
      window.lucide?.createIcons();
    } catch (error) {
      console.error('Create room error:', error);
      showToast(firebaseErrorMessage(error, 'Could not create room'));
      button.disabled = false;
      button.classList.remove('is-loading');
      button.innerHTML = '<i data-lucide="plus"></i><span>Create room</span>';
      window.lucide?.createIcons();
    }
  });
}

function openQrRoomConfirmation(code) {
  const formattedCode = code.slice(0, 3) + ' ' + code.slice(3);
  openModal('<div class="qr-room-found"><span class="qr-room-found-mark"><i data-lucide="scan-line"></i></span><div class="eyebrow">QR SCANNED</div><h2 class="modal-title" id="modal-title">Room found</h2><p class="modal-copy">Room <strong>' + escapeHtml(formattedCode) + '</strong> is ready. Would you like to join?</p><div class="modal-actions"><button class="button button-ghost" id="qr-room-cancel" type="button">Cancel</button><button class="button button-primary" id="qr-room-join" type="button">Join room</button></div></div>');
  modalContent.querySelector('#qr-room-cancel')?.addEventListener('click', () => openJoinRoom(code));
  modalContent.querySelector('#qr-room-join')?.addEventListener('click', event => {
    connectToRoom(code, event.currentTarget, 'Join room');
  });
  modalContent.querySelector('#qr-room-join')?.focus();
}

async function connectToRoom(code, button, idleLabel) {
  if (code.length !== 6) { showToast('Scan QR or enter room code to join'); return; }
  button.disabled = true;
  button.classList.add('is-loading');
  button.innerHTML = '<span class="button-spinner"></span><span>Connecting...</span>';
  try {
    let mode = 'firebase';
    if (await localBridgeAvailable().catch(() => false)) {
      try {
        await joinLocalRoom(code);
        mode = 'lan';
      } catch (localError) {
        // A Firebase room can still be joined from a device that also has a
        // LAN server available, so only surface an error after that fallback.
        await joinRoom(code);
      }
    } else {
      await joinRoom(code);
    }
    closeModal();
    openChat(code, { mode });
  } catch (error) {
    button.disabled = false;
    button.classList.remove('is-loading');
    button.textContent = idleLabel;
    showToast(firebaseErrorMessage(error, 'Could not join room'));
  }
}

function openJoinRoom(prefilledCode) {
  if (typeof prefilledCode !== 'string') prefilledCode = '';
  openModal(`<div class="eyebrow">JOIN A ROOM</div><h2 class="modal-title" id="modal-title">Meet your other device.</h2><p class="modal-copy">Scan the QR or enter the six-digit code shown on the device that created the room.</p><button class="button button-ghost button-small join-scan-trigger" id="scan-room-btn" type="button"><i data-lucide="scan-line"></i><span>Scan QR code</span></button><div class="join-scanner" id="join-scanner" hidden><div class="join-video-frame"><video id="join-qr-video" playsinline muted aria-label="QR code camera preview"></video><span class="join-scan-corner join-scan-corner-top-left"></span><span class="join-scan-corner join-scan-corner-top-right"></span><span class="join-scan-corner join-scan-corner-bottom-left"></span><span class="join-scan-corner join-scan-corner-bottom-right"></span></div><p class="join-scanner-status" id="join-scanner-status" role="status"></p><button class="button button-ghost button-small" id="stop-scan-btn" type="button">Stop camera</button></div><label class="join-code-label" for="join-code">Room code</label><input class="join-input" id="join-code" maxlength="6" inputmode="numeric" placeholder="000 000" aria-label="Six digit room code"><div class="modal-actions" style="margin-top:22px"><button class="button button-primary" id="connect-room"><span>Connect to room</span> <span>\u2192</span></button></div>`);
  const input = document.querySelector('#join-code');
  input.value = prefilledCode;
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); });
  document.querySelector('#scan-room-btn')?.addEventListener('click', startQrScanner);
  document.querySelector('#stop-scan-btn')?.addEventListener('click', stopQrScanner);
  document.querySelector('#connect-room').addEventListener('click', event => {
    connectToRoom(input.value, event.currentTarget, 'Connect to room');
  });
}
function openChat(code, { creator = false, mode = lanMode ? 'lan' : 'firebase' } = {}) {
  const isCreatorParam = new URLSearchParams(location.search).get('creator') === '1';
  isRoomHost = Boolean(creator || isCreatorParam);

  if (landingView && chatView) {
    landingView.hidden = true;
    chatView.hidden = false;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    try {
      history.pushState({ room: code }, '', mode === 'lan' ? `/chat?room=${code}&mode=lan${isRoomHost ? '&creator=1' : ''}` : chatUrl(code, isRoomHost));
    } catch {}
  } else if (!isChatPage) {
    location.assign(mode === 'lan' ? `${location.origin}/chat?room=${code}&mode=lan${isRoomHost ? '&creator=1' : ''}` : chatUrl(code, isRoomHost));
    return;
  }
  currentRoomCode = code;
  currentConnectionMode = mode;
  const clearRoomButton = document.querySelector('#clear-room-btn');
  if (clearRoomButton) clearRoomButton.hidden = !isRoomHost;
  if (mode === 'firebase') {
    connectDirectRoom(code, isRoomHost, {
      onStatus: ({ label }) => {
        const statusText = document.querySelector('#chat-status-text');
        if (statusText) statusText.textContent = label;
      },
      onMessage: handleDirectMessage
    }).catch(() => {});
  }
  stopLocalRoom?.();
  stopMessages?.();
  stopFiles?.();
  stopRoomPresence?.();
  clearInterval(roomCountdownInterval);

  document.body.classList.add('in-chat');
  if (landingView) landingView.hidden = true;
  if (chatView) chatView.hidden = false;
  window.scrollTo({ top: 0, behavior: 'smooth' });

  // Reset mobile tabs to Messages
  document.querySelectorAll('.chat-mobile-tabs .tab-btn').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-tab') === 'chat');
  });
  document.querySelectorAll('.chat-workspace').forEach(w => w.setAttribute('data-active-tab', 'chat'));
  document.querySelectorAll('.chat-workspace .tab-content').forEach(content => {
    content.classList.toggle('active', content.getAttribute('data-tab-content') === 'chat');
  });

  // Update URL state
  history.replaceState({ room: code }, '', mode === 'lan' ? `/chat?room=${code}&mode=lan${isRoomHost ? '&creator=1' : ''}` : chatUrl(code, isRoomHost));

  // Format code display
  const formattedCode = `${code.slice(0, 3)} ${code.slice(3)}`;
  document.querySelector('#chat-room-code-text').innerHTML = `<span class="room-code-digits">${formattedCode}</span>`;
  document.querySelector('#chat-sidebar-code').innerHTML = `<span class="room-code-digits">${formattedCode}</span>`;

  // Setup Sidebar QR
  const qrContainer = document.querySelector('#chat-qr-container');
  if (qrContainer && window.QRCode) {
    qrContainer.innerHTML = '';
    new window.QRCode(qrContainer, { text: `${location.origin}/chat?room=${code}${mode === 'lan' ? '&mode=lan' : ''}`, width: 104, height: 104, colorDark: '#0f172a', colorLight: '#ffffff', correctLevel: window.QRCode.CorrectLevel.H });
    addQrLogo(qrContainer);
  } else if (qrContainer) {
    qrContainer.innerHTML = '<span class="qr-unavailable">QR unavailable</span>';
  }

  // Setup Initial Loading States
  const messagesList = document.querySelector('#room-messages');
  if (messagesList) {
    messagesList.innerHTML = '<div class="message-skeletons"><span></span><span></span><span></span></div>';
  }

  const filesList = document.querySelector('#room-files');
  if (filesList) {
    filesList.innerHTML = '<div class="files-loading" role="status" aria-label="Loading shared files"><span class="button-spinner"></span></div>';
  }

  // Timer countdown
  let roomExpiresAt = Date.now() + 30 * 60 * 1000;
  const timerElements = [document.querySelector('#chat-timer'), document.querySelector('#sidebar-timer')];
  function updateTimerDisplay() {
    const roomTimeLeft = Math.max(0, Math.ceil((roomExpiresAt - Date.now()) / 1000));
    const mins = String(Math.floor(roomTimeLeft / 60)).padStart(2, '0');
    const secs = String(roomTimeLeft % 60).padStart(2, '0');
    timerElements.forEach(el => { if (el) el.textContent = `${mins}:${secs}`; });
    return roomTimeLeft;
  }
  function setRoomExpiry(value) {
    const timestamp = value?.toMillis ? value.toMillis() : Number(value);
    if (Number.isFinite(timestamp) && timestamp > Date.now()) roomExpiresAt = timestamp;
    updateTimerDisplay();
  }
  updateTimerDisplay();
  roomCountdownInterval = setInterval(() => {
    if (updateTimerDisplay() === 0) {
      clearInterval(roomCountdownInterval);
      showToast('Room has expired');
      leaveRoom();
    }
  }, 1000);

  let previousDeviceCount = null;
  function notifyDeviceCount(count) {
    if (previousDeviceCount !== null && count > previousDeviceCount) {
      showToast('Someone joined the room');
    } else if (previousDeviceCount !== null && count < previousDeviceCount) {
      showToast('Someone left the room');
    }
    previousDeviceCount = count;
  }

  // Real-time Firestore Listeners
  if (mode === 'lan') {
    const updateLocalRoom = room => {
      if (!room || room.status === 'deleted') {
        if (!isRoomHost) {
          showRoomDeletedNotice();
        }
        return;
      }
      setRoomExpiry(room.expiresAt);
      renderMessages(room.messages || []);
      renderFiles(room.files || []);
      const count = room.activeUsers || 1;
      notifyDeviceCount(count);
      const devicesCount = document.querySelector('#chat-devices-count');
      if (devicesCount) devicesCount.textContent = `${count} device${count > 1 ? 's' : ''} connected`;
      const sidebarDeviceCount = document.querySelector('#sidebar-device-count');
      if (sidebarDeviceCount) sidebarDeviceCount.textContent = `${count} connected`;
      const isHotspot = location.hostname.startsWith('192.168.137.');
      const localStatusText = document.querySelector('#chat-status-text');
      if (localStatusText) localStatusText.textContent = count > 1 ? (isHotspot ? 'Connected via PC Hotspot' : 'Connected via Local Network') : 'Waiting for local device';
    };
    joinLocalRoom(code, !isRoomHost).then(updateLocalRoom).catch(error => showToast(error.message));
    stopLocalRoom = watchLocalRoom(code, updateLocalRoom, () => {
      if (!isRoomHost) showToast('Local room connection lost.');
    });
  } else if (firebaseReady && db) {
    ensureAnonymousUser().then(user => {
      window.loopFlowUserId = user?.uid;
      stopMessages = onSnapshot(query(collection(db, 'rooms', code, 'messages'), orderBy('createdAt')), snapshot => {
        renderMessages(snapshot.docs.map(item => ({ id: item.id, ...item.data({ serverTimestamps: 'estimate' }) })));
      }, error => showToast(firebaseErrorMessage(error, 'Messages error')));

      stopFiles = onSnapshot(query(collection(db, 'rooms', code, 'files'), orderBy('uploadedAt', 'desc')), snapshot => {
        renderFiles(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
      }, error => showToast(firebaseErrorMessage(error, 'Files error')));

      stopRoomPresence = watchRoom(code, room => {
        const countEl = document.querySelector('#chat-devices-count');
        const statusText = document.querySelector('#chat-status-text');
        if (!room) {
          if (!isRoomHost && currentRoomCode === code) {
            showRoomDeletedNotice();
          }
          return;
        }
        if (room.status === 'deleted') {
          if (!isRoomHost && currentRoomCode === code) {
            showRoomDeletedNotice();
          }
          return;
        }
        if (room.ownerId && user?.uid && room.ownerId === user.uid) {
          isRoomHost = true;
        }
        const clearRoomButton = document.querySelector('#clear-room-btn');
        if (clearRoomButton) clearRoomButton.hidden = !isRoomHost;
        if (room) {
          setRoomExpiry(room.expiresAt);
          const count = room.activeUsers || 1;
          notifyDeviceCount(count);
          if (countEl) countEl.textContent = `${count} device${count > 1 ? 's' : ''} connected`;
          const sideCount = document.querySelector('#sidebar-device-count');
          if (sideCount) sideCount.textContent = `${count} connected`;
          if (statusText) statusText.textContent = count > 1 ? 'Connected via Internet' : 'Waiting for device';
        }
      });
    }).catch(error => showToast(firebaseErrorMessage(error, 'Auth error')));
  } else {
    renderMessages([]);
    renderFiles([]);
  }

  // Focus message composer input
  document.querySelector('#room-message')?.focus();
  window.lucide?.createIcons();
}

async function leaveRoom() {
  const roomToLeave = currentRoomCode;
  const wasHost = isRoomHost;

  stopMessages?.();
  stopFiles?.();
  stopRoomPresence?.();
  stopLocalRoom?.();
  clearInterval(roomCountdownInterval);
  currentRoomCode = null;
  isRoomHost = false;
  closeDirectRoom();

  if (roomToLeave) {
    if (wasHost) {
      if (currentConnectionMode === 'lan') {
        deleteLocalRoom(roomToLeave).catch(() => {});
      } else {
        deleteRoom(roomToLeave).catch(() => {});
      }
      showToast('Room deleted by host');
    } else {
      if (currentConnectionMode === 'firebase') {
        leaveRoomPresence(roomToLeave).catch(() => {});
      }
      showToast('Left room');
    }
  }

  leaveRoomCleanup();
}

async function requestLeaveRoom() {
  if (!currentRoomCode) return;
  const confirmed = await confirmInModal({
    title: isRoomHost ? 'Leave and close this room?' : 'Leave this room?',
    message: isRoomHost
      ? 'Leaving will close the room for everyone and remove its shared content.'
      : 'You can rejoin later with the room code while the room is still open.',
    confirmLabel: isRoomHost ? 'Close room' : 'Leave room'
  });
  if (confirmed) await leaveRoom();
}

function leaveRoomWithoutDelete() {
  stopMessages?.();
  stopFiles?.();
  stopRoomPresence?.();
  stopLocalRoom?.();
  clearInterval(roomCountdownInterval);
  currentRoomCode = null;
  isRoomHost = false;
  closeDirectRoom();
  leaveRoomCleanup();
}

function showRoomDeletedNotice() {
  if (currentRoomCode === null) return;
  stopMessages?.();
  stopFiles?.();
  stopRoomPresence?.();
  stopLocalRoom?.();
  clearInterval(roomCountdownInterval);
  currentRoomCode = null;
  isRoomHost = false;
  closeDirectRoom();
  clearInterval(deletedRoomCountdownInterval);
  openModal('<div class="eyebrow">ROOM CLOSED</div><h2 class="modal-title">This room was deleted.</h2><p class="modal-copy" id="deleted-room-countdown"></p><div class="modal-actions"><button class="button button-primary" id="deleted-room-home" type="button">Go to home</button></div>');
  modal?.querySelector('.room-modal')?.classList.add('room-closed-notice');
  let secondsRemaining = 10;
  const updateCountdown = () => {
    const label = document.querySelector('#deleted-room-countdown');
    if (label) label.textContent = `You will be redirected to home in ${secondsRemaining}…`;
  };
  updateCountdown();
  const goHome = () => {
    clearInterval(deletedRoomCountdownInterval);
    closeModal();
    leaveRoomCleanup();
  };
  document.querySelector('#deleted-room-home')?.addEventListener('click', goHome);
  deletedRoomCountdownInterval = window.setInterval(() => {
    secondsRemaining -= 1;
    if (secondsRemaining <= 0) {
      goHome();
      return;
    }
    updateCountdown();
  }, 1000);
}

function leaveRoomCleanup() {
  activeUploadMessage = null;
  activeUploadMessages = [];
  cancelledUploadMessage = null;
  cancelledUploadMessages = [];
  clearDirectFileMessages();
  document.body.classList.remove('in-chat');
  if (isChatPage) {
    location.assign(homeUrl());
  } else {
    if (chatView) chatView.hidden = true;
    if (landingView) landingView.hidden = false;
    history.pushState({}, '', location.pathname);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

// Automatically handle room deletion / presence leave when closing tab or navigating away
window.addEventListener('pagehide', () => {
  if (currentRoomCode) {
    if (isRoomHost) {
      if (currentConnectionMode === 'lan') {
        deleteLocalRoom(currentRoomCode).catch(() => {});
      } else {
        deleteRoom(currentRoomCode).catch(() => {});
      }
    } else {
      if (currentConnectionMode === 'firebase') {
        leaveRoomPresence(currentRoomCode).catch(() => {});
      }
    }
  }
});

// Copy Code Button Handlers
document.querySelector('#chat-room-badge')?.addEventListener('click', async () => {
  if (currentRoomCode) {
    await navigator.clipboard?.writeText(currentRoomCode);
    showToast('Room code copied');
  }
});

document.querySelector('#copy-sidebar-code')?.addEventListener('click', async () => {
  if (currentRoomCode) {
    await navigator.clipboard?.writeText(currentRoomCode);
    showToast('Room code copied');
  }
});

// Leave Room Buttons (both in header and sidebar)
document.querySelectorAll('#leave-room-btn, #chat-header-leave-btn').forEach(btn => {
  btn.addEventListener('click', requestLeaveRoom);
});

document.querySelector('#download-all-files-btn')?.addEventListener('click', downloadAllSharedFiles);

document.querySelector('#send-clipboard-btn')?.addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text.trim()) return showToast('Clipboard is empty');
    const input = document.querySelector('#room-message');
    if (input) { input.value = text; input.dispatchEvent(new Event('input')); input.focus(); }
    showToast('Clipboard text added');
  } catch { showToast('Clipboard permission was not available'); }
});

async function clearRoomContent() {
  if (!isRoomHost || !currentRoomCode) return;
  try {
    if (currentConnectionMode === 'lan') await clearLocalRoom(currentRoomCode);
    else await clearRoomData(currentRoomCode);
    latestRoomMessages = [];
    cancelledUploadMessage = null;
    cancelledUploadMessages = [];
    renderFiles([]);
    activeUploadMessages = [];
    renderMessages([]);
    showToast('Room content cleared');
  } catch { showToast('Could not clear room content'); }
}

document.querySelector('#clear-room-btn')?.addEventListener('click', async () => {
  if (!isRoomHost || !currentRoomCode) return;
  const confirmed = await confirmInModal({
    title: 'Clear this room?',
    message: 'All messages and shared files will be removed from this room.',
    confirmLabel: 'Clear room'
  });
  if (confirmed) await clearRoomContent();
});

// Sidebar Toggle Button
document.querySelectorAll('#sidebar-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chat-workspace').forEach(w => w.classList.toggle('sidebar-collapsed'));
  });
});

// Multiline Textarea Ergonomics (Enter to send, Shift+Enter for newline)
const composerMessageInput = document.querySelector('#room-message');
if (composerMessageInput) {
  const roomViewport = window.visualViewport;
  const syncRoomViewport = () => {
    if (!document.body.classList.contains('simple-room-page') || !roomViewport || !window.matchMedia('(max-width: 700px)').matches) return;
    document.documentElement.style.setProperty('--chat-visual-height', `${roomViewport.height}px`);
    document.documentElement.style.setProperty('--chat-visual-top', `${roomViewport.offsetTop}px`);
    document.body.classList.toggle('keyboard-open', document.activeElement === composerMessageInput && roomViewport.height < window.innerHeight - 100);
  };
  roomViewport?.addEventListener('resize', syncRoomViewport);
  roomViewport?.addEventListener('scroll', syncRoomViewport);
  composerMessageInput.addEventListener('focus', () => requestAnimationFrame(syncRoomViewport));
  composerMessageInput.addEventListener('blur', () => {
    document.body.classList.remove('keyboard-open');
    window.setTimeout(syncRoomViewport, 150);
  });
  composerMessageInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      document.querySelector('#room-composer')?.requestSubmit();
    }
  });
  composerMessageInput.addEventListener('input', () => {
    composerMessageInput.style.height = 'auto';
    composerMessageInput.style.height = `${Math.min(composerMessageInput.scrollHeight, 120)}px`;
  });
}

// Message Submit Handler
document.querySelector('#room-composer')?.addEventListener('submit', async event => {
  event.preventDefault();
  const messageInput = document.querySelector('#room-message');
  const sendBtn = document.querySelector('#send-msg-btn');
  const content = messageInput.value.trim();
  if (!content || !currentRoomCode) return;
  const clientCreatedAt = Date.now();

  if (sendBtn) {
    sendBtn.disabled = true;
    sendBtn.classList.add('is-loading');
  }
  messageInput.value = '';
  messageInput.style.height = 'auto';

  try {
    if (currentConnectionMode === 'lan') {
      await sendLocalMessage(currentRoomCode, content, getSenderName(), window.loopFlowUserId);
    } else {
      const user = await ensureAnonymousUser();
      if (firebaseReady && db && user) {
      await addDoc(collection(db, 'rooms', currentRoomCode, 'messages'), {
        roomId: currentRoomCode,
        senderId: user.uid,
        senderName: getSenderName(),
        type: 'text',
        content,
        createdAt: serverTimestamp(),
        clientCreatedAt
      });
      } else {
        renderMessages([...latestRoomMessages, {
          id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          senderId: window.loopFlowUserId,
          senderName: 'You',
          content,
          createdAt: clientCreatedAt,
          clientCreatedAt
        }]);
      }
    }
  } catch (error) {
    if (!messageInput.value) {
      messageInput.value = content;
      messageInput.style.height = 'auto';
    }
    showToast(firebaseErrorMessage(error, 'Message could not be sent'));
  } finally {
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove('is-loading');
    }
    messageInput.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      const messagesList = document.querySelector('#room-messages');
      if (messagesList) messagesList.scrollTop = messagesList.scrollHeight;
    });
  }
});

// File Upload Handler
const uploadMenuToggle = document.querySelector('#upload-menu-toggle');
const uploadPickerMenu = document.querySelector('#upload-picker-menu');
uploadMenuToggle?.addEventListener('click', event => {
  event.stopPropagation();
  const isOpen = !uploadPickerMenu.hidden;
  uploadPickerMenu.hidden = isOpen;
  uploadMenuToggle.setAttribute('aria-expanded', String(!isOpen));
});

uploadPickerMenu?.addEventListener('click', event => {
  const choice = event.target.closest('[data-upload-choice]')?.dataset.uploadChoice;
  if (!choice) return;
  uploadPickerMenu.hidden = true;
  uploadMenuToggle?.setAttribute('aria-expanded', 'false');
  document.querySelector(choice === 'folder' ? '#room-folder' : '#room-file')?.click();
});

document.addEventListener('click', event => {
  if (!event.target.closest('.upload-picker')) {
    if (uploadPickerMenu) uploadPickerMenu.hidden = true;
    uploadMenuToggle?.setAttribute('aria-expanded', 'false');
  }
});

document.querySelector('#room-file')?.addEventListener('change', async event => {
  await uploadFiles(event.target.files);
  event.target.value = '';
});

document.querySelector('#room-folder')?.addEventListener('change', async event => {
  const files = Array.from(event.target.files || []);
  if (!files.length) {
    event.target.value = '';
    return;
  }
  await uploadFiles(files);
  event.target.value = '';
});

let awaitingUploadChoice = false;
let uploadShortcutTimer = null;
document.addEventListener('keydown', event => {
  const target = event.target;
  const key = event.key.toLowerCase();
  const isEditing = target instanceof HTMLElement && (
    target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)
  );
  if (currentRoomCode && !(modal && !modal.hidden) && event.ctrlKey && !event.altKey && !event.metaKey) {
    if (key === 'd') {
      event.preventDefault();
      event.stopImmediatePropagation();
      clearRoomContent();
      return;
    }
    if (key === 'l') {
      event.preventDefault();
      event.stopImmediatePropagation();
      leaveRoom();
      return;
    }
  }
  if (!currentRoomCode || modal && !modal.hidden) return;
  if (awaitingUploadChoice && !['control', 'meta', 'shift', 'alt'].includes(key)) {
    clearTimeout(uploadShortcutTimer);
    awaitingUploadChoice = false;
    event.preventDefault();
    event.stopImmediatePropagation();
    document.querySelector(key === 'f' ? '#room-folder' : '#room-file')?.click();
    return;
  }
  if (event.ctrlKey && !event.altKey && !event.metaKey && key === 'u') {
    event.preventDefault();
    event.stopImmediatePropagation();
    awaitingUploadChoice = true;
    clearTimeout(uploadShortcutTimer);
    uploadShortcutTimer = setTimeout(() => {
      if (!awaitingUploadChoice || !currentRoomCode) return;
      awaitingUploadChoice = false;
      document.querySelector('#room-file')?.click();
    }, 650);
    return;
  }
  if (isEditing || modal && !modal.hidden || !currentRoomCode) return;
});

let currentUploadController = null;
let uploadCancelled = false;
let uploadSessionId = 0;
let cancelledUploadMessage = null;
let cancelledUploadMessages = [];

async function markActiveUploadCancelled() {
  if (!activeUploadMessage) return;

  const cancelledMessage = {
    ...activeUploadMessage,
    status: 'cancelled',
    progress: activeUploadMessage.progress || 0,
    completedFiles: activeUploadMessage.completedFiles || 0,
    completedUploadFiles: [...(activeUploadMessage.completedUploadFiles || [])].map(file => ({
      filePath: file.filePath,
      ...(file.clientCreatedAt != null ? { clientCreatedAt: file.clientCreatedAt } : {}),
      ...(file.id != null ? { id: file.id } : {}),
      ...(file.createdAt != null ? { createdAt: file.createdAt } : {})
    })),
    completedUploadPaths: [...new Set([
      ...(activeUploadMessage.completedUploadFiles || []).map(file => file?.filePath),
      activeUploadMessage.currentFilePath
    ].filter(Boolean))],
    cancelledAt: Date.now(),
    cancelId: `cancel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    senderId: window.loopFlowUserId,
    senderName: getSenderName()
  };

  cancelledUploadMessage = cancelledMessage;
  cancelledUploadMessages.push(cancelledMessage);
  activeUploadMessage = null;

  // Store the cancellation record in the room timeline. Uploaded file objects
  // remain untouched; the path list only controls chat rendering.
  try {
    if (currentConnectionMode === 'lan') {
      await sendLocalMessage(currentRoomCode, '', cancelledMessage.senderName, cancelledMessage.senderId, cancelledMessage);
    } else if (firebaseReady && db && currentRoomCode) {
      const user = await ensureAnonymousUser();
      if (user) {
        const { id, ...record } = cancelledMessage;
        await addDoc(collection(db, 'rooms', currentRoomCode, 'messages'), {
          ...record,
          senderId: user.uid,
          roomId: currentRoomCode,
          createdAt: serverTimestamp(),
          clientCreatedAt: cancelledMessage.clientCreatedAt || Date.now()
        });
      }
    }
  } catch (error) {
    showToast(firebaseErrorMessage(error, 'Canceled upload could not be saved'));
  }

  const list = document.querySelector('#room-messages');
  const bubble = list?.querySelector(`[data-upload-id="${activeUploadMessage.uploadId || 'active'}"]`) || list?.querySelector('[data-message-id="active-upload"]');

  if (bubble) {
    bubble.dataset.messageId = 'cancelled-upload';
    bubble.classList.add('upload-cancelled');

    const cancelButton = bubble.querySelector('#timeline-cancel-upload-btn');
    cancelButton?.remove();

    const statusText = bubble.querySelector('.upload-bubble-size');
    if (statusText) {
      statusText.textContent = cancelledMessage.type === 'uploading-folder'
        ? `${cancelledMessage.completedFiles || 0} of ${cancelledMessage.totalFiles || 0} files · Canceled`
        : 'Canceled';
    }

    const iconContainer = bubble.querySelector('.upload-bubble-icon');
    if (iconContainer) {
      iconContainer.innerHTML = '<i data-lucide="circle-x"></i>';
      window.lucide?.createIcons({ attrs: { 'stroke-width': 1.8 } });
    }

    const progressBar = bubble.querySelector('#timeline-upload-progress');
    if (progressBar) progressBar.style.width = '0%';

    const progressContainer = bubble.querySelector('.upload-bubble-progress');
    progressContainer?.classList.add('upload-progress-cancelled');

    const percentage = bubble.querySelector('#timeline-upload-percent');
    if (percentage) {
      percentage.textContent = 'Canceled';
      percentage.classList.add('upload-bubble-cancelled-label');
    }

    bubble.querySelector('.upload-timeline-bubble')?.classList.add('upload-cancelled');
  }

  uploadSessionId++;
}

function updateUploadProgressUI(progress) {
  if (uploadCancelled || !activeUploadMessage) return;

  const uploadId = activeUploadMessage.uploadId || 'active';
  const bubble = document.querySelector(`[data-upload-id="${uploadId}"]`);
  const timelinePercent = bubble?.querySelector(`[data-upload-percent="${uploadId}"]`);
  const timelineBar = bubble?.querySelector(`[data-upload-progress="${uploadId}"]`);
  if (!timelinePercent || !timelineBar) return;

  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));

  timelinePercent.textContent = `${safeProgress}%`;
  timelineBar.style.width = `${safeProgress}%`;
  timelineBar.parentElement?.setAttribute('aria-valuenow', String(safeProgress));
}

function getFileIcon(fileName = '', fileType = '') {
  const mime = getMimeType(fileName, fileType);
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'music';
  if (mime.includes('zip') || mime.includes('rar') || mime.includes('tar') || mime.includes('7z') || mime.includes('compressed')) return 'archive';
  if (mime.includes('pdf') || mime.includes('word') || mime.includes('document') || mime.includes('text')) return 'file-text';
  return 'file';
}

async function uploadFiles(files) {
  if (!currentRoomCode || !files || files.length === 0) return;
  if (currentUploadController) return;

  const uploadFilesList = Array.from(files);
  const firstRelativePath = uploadFilesList.find(file => file.webkitRelativePath)?.webkitRelativePath || '';
  const folderName = firstRelativePath.split('/')[0] || '';
  const folderBatch = Boolean(folderName) && uploadFilesList.every(file => file.webkitRelativePath?.startsWith(`${folderName}/`));
  const totalBytes = uploadFilesList.reduce((total, file) => total + Number(file.size || 0), 0);

  const controller = new AbortController();
  currentUploadController = controller;
  const signal = controller.signal;
  uploadCancelled = false;
  const sessionId = ++uploadSessionId;

  let completedBytes = 0;
  let completedFiles = 0;

  const firstFile = uploadFilesList[0];
  const createdAt = Date.now();
  activeUploadMessage = folderBatch
    ? { type: 'uploading-folder', folderName, progress: 0, completedFiles: 0, totalFiles: uploadFilesList.length, completedUploadFiles: [], createdAt, clientCreatedAt: createdAt }
    : { type: 'uploading', fileName: firstFile.webkitRelativePath || firstFile.name, icon: getFileIcon(firstFile.name, firstFile.type), progress: 0, createdAt, clientCreatedAt: createdAt };
  activeUploadMessages = folderBatch
    ? [activeUploadMessage]
    : uploadFilesList.map((file, index) => ({
        type: 'uploading',
        fileName: file.webkitRelativePath || file.name,
        icon: getFileIcon(file.name, file.type),
        progress: 0,
        status: index === 0 ? 'uploading' : 'queued',
        uploadId: `upload-${sessionId}-${index}`,
        createdAt: createdAt + index,
        clientCreatedAt: createdAt + index
      }));
  if (!folderBatch) activeUploadMessage = activeUploadMessages[0];
  renderMessages(latestRoomMessages);

  try {
    for (let fileIndex = 0; fileIndex < uploadFilesList.length; fileIndex++) {
      const file = uploadFilesList[fileIndex];
      if (signal.aborted || uploadCancelled || sessionId !== uploadSessionId) break;

      const clientCreatedAt = Date.now();
      if (folderBatch && activeUploadMessage) {
        activeUploadMessage.currentFilePath = file.webkitRelativePath || file.name;
      } else if (!folderBatch) {
        activeUploadMessage = activeUploadMessages[fileIndex];
        activeUploadMessage.status = 'uploading';
        renderMessages(latestRoomMessages);
      }
      const onProgress = progress => {
        if (signal.aborted || uploadCancelled || sessionId !== uploadSessionId || !activeUploadMessage) return;

        const fileProgress = Math.max(0, Math.min(100, Number(progress) || 0));
        const overallProgress = folderBatch
          ? (totalBytes
              ? Math.round(((completedBytes + Number(file.size || 0) * fileProgress / 100) / totalBytes) * 100)
              : Math.round(((completedFiles + fileProgress / 100) / uploadFilesList.length) * 100))
          : fileProgress;

        activeUploadMessage.progress = overallProgress;
        if (folderBatch) activeUploadMessage.completedFiles = completedFiles;
        updateUploadProgressUI(overallProgress);
      };

      const upload = currentConnectionMode === 'lan'
        ? uploadLocalFile(currentRoomCode, file, window.loopFlowUserId, getSenderName(), onProgress, signal)
        : uploadRoomFile(currentRoomCode, file, onProgress, signal, window.loopFlowUserId, getSenderName(), clientCreatedAt);

      let uploadResult;
      try {
        uploadResult = await upload;
      } catch (error) {
        if (error?.name === 'AbortError' || signal.aborted || uploadCancelled) break;
        throw error;
      }

      if (signal.aborted || uploadCancelled || sessionId !== uploadSessionId) break;

      completedBytes += Number(file.size || 0);
      completedFiles++;
      if (!folderBatch && activeUploadMessage) {
        activeUploadMessage.status = 'completed';
        activeUploadMessage.progress = 100;
        renderMessages(latestRoomMessages);
      }
      if (folderBatch) {
        const uploadedMessage = currentConnectionMode === 'lan'
          ? uploadResult?.messages?.find(message => message.type === 'file' && message.filePath === (file.webkitRelativePath || file.name))
          : null;
        activeUploadMessage.completedUploadFiles.push({
          filePath: file.webkitRelativePath || file.name,
          clientCreatedAt,
          id: uploadedMessage?.id,
          createdAt: uploadedMessage?.createdAt
        });
        activeUploadMessage.completedFiles = completedFiles;
        activeUploadMessage.progress = totalBytes
          ? Math.round((completedBytes / totalBytes) * 100)
          : Math.round((completedFiles / uploadFilesList.length) * 100);
        updateUploadProgressUI(activeUploadMessage.progress);
      }

    }

    if (uploadCancelled || signal.aborted || sessionId !== uploadSessionId) {
      return;
    }
  } catch (error) {
    if (error?.name !== 'AbortError' && !signal.aborted && !uploadCancelled) {
      showToast(firebaseErrorMessage(error, 'File upload failed'));
    }
    activeUploadMessage = null;
  } finally {
    if (sessionId === uploadSessionId) {
      const completedPaths = activeUploadMessages
        .filter(message => message.status === 'completed')
        .map(message => message.fileName)
        .filter(Boolean);
      if (completedPaths.length && !uploadCancelled) recentlyCompletedUploadPaths = new Set(completedPaths);
      currentUploadController = null;
      activeUploadMessage = null;
      activeUploadMessages = [];
      uploadCancelled = false;
      renderMessages(latestRoomMessages);
    }
  }
}

let dragCounter = 0;

function isFileDragEvent(event) {
  if (!event.dataTransfer?.types) return false;
  return Array.from(event.dataTransfer.types).includes('Files');
}

function showDropOverlay() {
  const overlay = document.querySelector('#drop-overlay');
  if (overlay) {
    overlay.hidden = false;
    overlay.classList.add('is-active');
  }
}

function hideDropOverlay() {
  dragCounter = 0;
  const overlay = document.querySelector('#drop-overlay');
  if (overlay) {
    overlay.classList.remove('is-active');
    overlay.hidden = true;
  }
}

document.addEventListener('dragenter', event => {
  if (!currentRoomCode || (chatView && chatView.hidden)) return;
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  dragCounter++;
  if (dragCounter === 1) {
    showDropOverlay();
  }
});

document.addEventListener('dragover', event => {
  if (!currentRoomCode || (chatView && chatView.hidden)) return;
  if (!isFileDragEvent(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
});

document.addEventListener('dragleave', event => {
  if (!currentRoomCode) return;
  event.preventDefault();
  dragCounter = Math.max(0, dragCounter - 1);
  if (dragCounter === 0) {
    hideDropOverlay();
  }
});

document.addEventListener('drop', async event => {
  if (!currentRoomCode) return;
  event.preventDefault();
  hideDropOverlay();

  if (event.dataTransfer?.items?.length) {
    const droppedFiles = await collectDroppedFiles(event.dataTransfer.items);
    if (droppedFiles.length) await uploadFiles(droppedFiles);
  } else if (event.dataTransfer?.files?.length) {
    await uploadFiles(event.dataTransfer.files);
  }
});

function readDirectoryEntries(directoryReader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => directoryReader.readEntries(batch => {
      if (!batch.length) return resolve(entries);
      entries.push(...batch);
      readBatch();
    }, reject);
    readBatch();
  });
}

function readDroppedFile(fileEntry, relativePath) {
  return new Promise((resolve, reject) => fileEntry.file(file => {
    Object.defineProperty(file, 'webkitRelativePath', { value: relativePath, configurable: true });
    resolve(file);
  }, reject));
}

async function walkDroppedEntry(entry, parentPath = '') {
  const currentPath = parentPath ? `${parentPath}/${entry.name}` : entry.name;
  if (entry.isFile) return [await readDroppedFile(entry, currentPath)];
  if (!entry.isDirectory) return [];
  const children = await readDirectoryEntries(entry.createReader());
  const files = [];
  for (const child of children) files.push(...await walkDroppedEntry(child, currentPath));
  return files;
}

async function collectDroppedFiles(items) {
  const entries = Array.from(items).map(item => item.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Array.from(items).map(item => item.getAsFile?.()).filter(Boolean);
  const files = [];
  for (const entry of entries) files.push(...await walkDroppedEntry(entry));
  return files;
}

// Mobile Navigation Toggle
document.querySelector('#mobile-menu-toggle')?.addEventListener('click', () => {
  const navLinks = document.querySelector('#nav-links');
  navLinks?.classList.toggle('is-open');
});

// Mobile Tabs Switcher in Chat View
document.querySelectorAll('.chat-mobile-tabs .tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const targetTab = btn.getAttribute('data-tab');
    document.querySelectorAll('.chat-mobile-tabs .tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    const workspace = btn.closest('#chat-view')?.querySelector('.chat-workspace') || document.querySelector('.chat-workspace');
    if (workspace) {
      workspace.setAttribute('data-active-tab', targetTab);
    }

    document.querySelectorAll('.chat-workspace .tab-content').forEach(content => {
      if (content.getAttribute('data-tab-content') === targetTab) {
        content.classList.add('active');
      } else {
        content.classList.remove('active');
      }
    });
  });
});

// Event Listeners
const heroJoinInput = document.querySelector('#hero-join-code');
if (heroJoinInput) {
  heroJoinInput.addEventListener('input', () => { heroJoinInput.value = heroJoinInput.value.replace(/\D/g, '').slice(0, 6); });
  heroJoinInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && heroJoinInput.value.length === 6) {
      openChat(heroJoinInput.value);
    }
  });
}
document.querySelectorAll('[data-action="create"]').forEach(button => button.addEventListener('click', openCreateRoom));
document.querySelectorAll('[data-action="join"]').forEach(button => button.addEventListener('click', openJoinRoom));
document.querySelector('#modal-close')?.addEventListener('click', closeModal);
modal?.addEventListener('click', event => { if (event.target === modal) closeModal(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

// Theme toggle
const savedTheme = localStorage.getItem('loopflow_theme');
if (savedTheme === 'dark') document.documentElement.classList.add('dark');

document.querySelectorAll('#theme-toggle, #chat-theme-toggle').forEach(btn => {
  btn?.addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('loopflow_theme', isDark ? 'dark' : 'light');
  });
});

// Direct link join room via URL query
const roomParams = new URLSearchParams(location.search);
const directRoomCode = roomParams.get('room')?.replace(/\D/g, '').slice(0, 6);
if (directRoomCode?.length === 6) {
  const isCreator = roomParams.get('creator') === '1';
  if (isChatPage && lanMode) {
    openChat(directRoomCode, { creator: isCreator, mode: 'lan' });
  } else if (isChatPage && isCreator) {
    openChat(directRoomCode, { creator: true });
  } else if (isChatPage) {
    joinRoom(directRoomCode)
      .then(() => openChat(directRoomCode))
      .catch(error => {
        const errorMsg = firebaseErrorMessage(error, 'Could not join room');
        showToast(errorMsg);
        const statusText = document.querySelector('#chat-status-text');
        if (statusText) statusText.textContent = errorMsg;
        const messagesList = document.querySelector('#room-messages');
        if (messagesList) {
          messagesList.innerHTML = `
            <div class="room-empty">
              <i data-lucide="shield-alert" class="room-empty-icon" style="color: var(--danger, #ef4444); width: 36px; height: 36px;"></i>
              <b style="color: var(--danger, #ef4444);">${escapeHtml(errorMsg)}</b>
              <p>LoopFlow rooms support up to 2 devices at a time.</p>
              <a href="/" class="button button-outline button-small" style="margin-top: 14px;">Return to Home</a>
            </div>
          `;
          window.lucide?.createIcons();
        }
        setTimeout(() => location.replace('/'), 4000);
      });
  } else {
    location.replace(chatUrl(directRoomCode));
  }
}
