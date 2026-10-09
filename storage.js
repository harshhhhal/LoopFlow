export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

import { db, storage, firebaseReady, ensureAnonymousUser } from './firebase.js';
import { addDoc, collection, doc, setDoc, serverTimestamp } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { ref, uploadBytesResumable, getDownloadURL } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-storage.js';
import { getMimeType } from './utils.js';

let isStorageWorking = null; // null = untracked, true = functional, false = unavailable

export function validateFile(file) {
  if (!file) return { valid: false, message: 'Choose a file first.' };
  if (file.size > MAX_FILE_SIZE) return { valid: false, message: 'Files must be smaller than 50 MB.' };
  return { valid: true };
}

function readFileAsDataURL(file, onProgress, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new DOMException('Upload cancelled', 'AbortError'));
    }
    const reader = new FileReader();
    const onAbort = () => {
      try { reader.abort(); } catch {}
      reject(new DOMException('Upload cancelled', 'AbortError'));
    };

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    reader.onprogress = event => {
      if (signal?.aborted) return;
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    reader.onload = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(new DOMException('Upload cancelled', 'AbortError'));
      onProgress(100);
      resolve(reader.result);
    };
    reader.onerror = error => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) {
        reject(new DOMException('Upload cancelled', 'AbortError'));
      } else {
        reject(error);
      }
    };
    reader.readAsDataURL(file);
  });
}

async function uploadInChunks(roomId, file, senderId, senderName, onProgress, signal, relativePath = file.name, clientCreatedAt = Date.now()) {
  const chunkSize = 250 * 1024; // 250 KB binary per chunk (333 KB Base64 data URL)
  const totalChunks = Math.ceil(file.size / chunkSize);
  const fileId = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `file-${Date.now()}`;
  const resolvedType = getMimeType(file.name, file.type);
  
  onProgress(5);
  
  let nextChunk = 0;
  let completedChunks = 0;
  const uploadWorker = async () => {
    while (nextChunk < totalChunks) {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      const index = nextChunk++;
      const start = index * chunkSize;
      const chunkBlob = file.slice(start, Math.min(file.size, start + chunkSize));
      const chunkData = await readFileAsDataURL(chunkBlob, () => {}, signal);
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      await setDoc(doc(db, 'rooms', roomId, 'files', fileId, 'chunks', String(index).padStart(6, '0')), { index, data: chunkData });
      completedChunks++;
      onProgress(Math.round(5 + (completedChunks / totalChunks) * 90));
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, totalChunks) }, uploadWorker));
  
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');

  const fileRecord = {
    id: fileId,
    roomId,
    fileName: file.name,
    filePath: relativePath,
    fileURL: `chunked:${fileId}:${totalChunks}`,
    fileSize: file.size,
    fileType: resolvedType,
    isChunked: true,
    chunkCount: totalChunks,
    uploadedAt: serverTimestamp(),
    clientCreatedAt,
    senderId
  };

  if (firebaseReady && db) {
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    await setDoc(doc(db, 'rooms', roomId, 'files', fileId), fileRecord);
    await addDoc(collection(db, 'rooms', roomId, 'messages'), {
      roomId,
      senderId,
      senderName,
      type: 'file',
      fileName: file.name,
      filePath: relativePath,
      fileURL: `chunked:${fileId}:${totalChunks}`,
      fileSize: file.size,
      fileType: resolvedType,
      isChunked: true,
      chunkCount: totalChunks,
      createdAt: serverTimestamp(),
      clientCreatedAt
    });
  }

  onProgress(100);
  return fileRecord;
}

export async function uploadRoomFile(roomId, file, onProgress = () => {}, signal = null, customSenderId = null, customSenderName = null, clientCreatedAt = Date.now()) {
  if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
  const validation = validateFile(file);
  if (!validation.valid) throw new Error(validation.message);
  
  const user = await ensureAnonymousUser();
  const senderId = customSenderId || user?.uid || 'anon';
  const defaultSenderName = /Android|iPhone|iPad/i.test(navigator.userAgent) ? 'Phone' : 'PC';
  const senderName = customSenderName || defaultSenderName;
  const resolvedType = getMimeType(file.name, file.type);
  const relativePath = file.webkitRelativePath || file.name;
  
  // 1. Direct base64 for files <= 300 KB (safely within Firestore 1MB doc limit)
  if (file.size <= 300 * 1024) {
    const fileURL = await readFileAsDataURL(file, onProgress, signal);
    if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
    const fileRecord = {
      roomId,
      fileName: file.name,
      filePath: relativePath,
      fileURL,
      fileSize: file.size,
      fileType: resolvedType,
      uploadedAt: serverTimestamp(),
      clientCreatedAt,
      senderId
    };

    if (firebaseReady && db) {
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
      await addDoc(collection(db, 'rooms', roomId, 'files'), fileRecord);
      await addDoc(collection(db, 'rooms', roomId, 'messages'), {
        roomId,
        senderId,
        senderName,
        type: 'file',
        fileName: file.name,
        filePath: relativePath,
        fileURL,
        fileSize: file.size,
        fileType: resolvedType,
        createdAt: serverTimestamp(),
        clientCreatedAt
      });
    }

    return { ...fileRecord, mode: 'realtime' };
  }

  // 2. Try Firebase Storage with 2.5s progress timeout guard; fallback to Firestore chunking
  if (firebaseReady && storage && isStorageWorking !== false) {
    let progressTimer = null;
    let fallbackToChunks = false;
    let uploadTask = null;
    try {
      const cleanFileName = file.name.replace(/[^a-zA-Z0-9_.-]/g, '_');
      const storageRef = ref(storage, `rooms/${roomId}/${Date.now()}_${cleanFileName}`);
      const safeFileName = file.name.replace(/[\r\n"]/g, '_');
      const encodedFileName = encodeURIComponent(file.name);
      uploadTask = uploadBytesResumable(storageRef, file, {
        contentType: resolvedType,
        contentDisposition: `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodedFileName}`
      });
      
      await new Promise((resolve, reject) => {
        let hasMadeProgress = false;

        const onAbort = () => {
          clearTimeout(progressTimer);
          try { uploadTask.cancel(); } catch {}
          reject(new DOMException('Upload cancelled', 'AbortError'));
        };

        if (signal) {
          if (signal.aborted) return onAbort();
          signal.addEventListener('abort', onAbort, { once: true });
        }

        // Guard: If Storage makes no progress within 2.5s (e.g. 404 bucket or blocked), fall back to chunking
        progressTimer = setTimeout(() => {
          if (!hasMadeProgress) {
            fallbackToChunks = true;
            isStorageWorking = false;
            try { uploadTask.cancel(); } catch {}
            reject(new Error('Firebase Storage timeout: no progress within 2.5s'));
          }
        }, 2500);

        uploadTask.on(
          'state_changed',
          snapshot => {
            if (snapshot.bytesTransferred > 0) {
              hasMadeProgress = true;
              isStorageWorking = true;
              clearTimeout(progressTimer);
            }
            const progress = snapshot.totalBytes > 0
              ? Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100)
              : 0;
            onProgress(progress);
          },
          error => {
            clearTimeout(progressTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
              reject(new DOMException('Upload cancelled', 'AbortError'));
            } else if (fallbackToChunks) {
              reject(new Error('Fallback to chunking'));
            } else {
              fallbackToChunks = true;
              isStorageWorking = false;
              reject(error);
            }
          },
          () => {
            clearTimeout(progressTimer);
            if (signal) signal.removeEventListener('abort', onAbort);
            if (signal?.aborted) {
              reject(new DOMException('Upload cancelled', 'AbortError'));
            } else {
              resolve();
            }
          }
        );
      });
      
      if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');

      const fileURL = await getDownloadURL(uploadTask.snapshot.ref);
      const fileRecord = {
        roomId,
        fileName: file.name,
        filePath: relativePath,
        fileURL,
        fileSize: file.size,
        fileType: resolvedType,
        uploadedAt: serverTimestamp(),
        clientCreatedAt,
        senderId
      };

      if (firebaseReady && db) {
        if (signal?.aborted) throw new DOMException('Upload cancelled', 'AbortError');
        await addDoc(collection(db, 'rooms', roomId, 'files'), fileRecord);
        await addDoc(collection(db, 'rooms', roomId, 'messages'), {
          roomId,
          senderId,
          senderName,
          type: 'file',
          fileName: file.name,
          filePath: relativePath,
          fileURL,
          fileSize: file.size,
          fileType: resolvedType,
          createdAt: serverTimestamp(),
          clientCreatedAt
        });
      }

      return { ...fileRecord, mode: 'cloud' };
    } catch (storageErr) {
      if (signal?.aborted || (!fallbackToChunks && (storageErr.name === 'AbortError' || (storageErr.code === 'storage/canceled' && signal?.aborted)))) {
        throw new DOMException('Upload cancelled', 'AbortError');
      }
      isStorageWorking = false;
      console.warn('Firebase Storage upload unavailable or timed out, switching to Firestore chunking fallback:', storageErr);
      return uploadInChunks(roomId, file, senderId, senderName, onProgress, signal, relativePath, clientCreatedAt);
    }
  }

  // 3. Fallback to Firestore chunking for all file formats (.exe, .mp3, .mp4, .zip, etc.)
  return uploadInChunks(roomId, file, senderId, senderName, onProgress, signal, relativePath, clientCreatedAt);
}
