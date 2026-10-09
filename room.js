import { firebaseReady, db, ensureAnonymousUser } from './firebase.js';
import { doc, getDoc, getDocs, collection, onSnapshot, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';

const ROOM_LIFETIME_MS = 30 * 60 * 1000;

export function roomLifetimeMs(minutes = 30) {
  const value = Number(minutes);
  return (Number.isFinite(value) && value > 0 ? value : 30) * 60 * 1000;
}

export function getClientDeviceId() {
  let id = localStorage.getItem('loopflow_device_id');
  if (!id) {
    id = 'dev_' + Math.random().toString(36).slice(2, 11) + Date.now().toString(36);
    localStorage.setItem('loopflow_device_id', id);
  }
  return id;
}

export function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createRoom(roomId, lifetimeMinutes = 30) {
  const deviceId = getClientDeviceId();
  if (!firebaseReady) return { roomId, mode: 'demo' };
  try {
    const user = await ensureAnonymousUser();
    const expiresAt = Timestamp.fromMillis(Date.now() + roomLifetimeMs(lifetimeMinutes));
    await setDoc(doc(db, 'rooms', roomId), {
      roomId,
      createdAt: serverTimestamp(),
      expiresAt,
      activeUsers: 1,
      devices: [deviceId],
      ownerDeviceId: deviceId,
      status: 'active',
      lifetimeMinutes: Number(lifetimeMinutes) || 30,
      ownerId: user?.uid || 'host'
    });
    return { roomId, db, mode: 'firebase', expiresAt };
  } catch (err) {
    console.warn('Firebase room creation fallback:', err);
    return { roomId, mode: 'demo' };
  }
}

export async function joinRoom(roomId) {
  if (!firebaseReady) return { roomId, mode: 'demo' };
  const deviceId = getClientDeviceId();
  try {
    await ensureAnonymousUser();
    const roomRef = doc(db, 'rooms', roomId);
    let joinedRoom;
    await runTransaction(db, async transaction => {
      const roomSnapshot = await transaction.get(roomRef);
      if (!roomSnapshot.exists()) {
        throw new Error('Room not found. Please check the 6-digit code.');
      }
      const room = roomSnapshot.data();
      if (room.status !== 'active' || (room.expiresAt?.toMillis && room.expiresAt.toMillis() <= Date.now())) {
        throw new Error('This room has expired or been closed.');
      }

      const currentDevices = Array.isArray(room.devices) ? room.devices : [];
      const isAlreadyMember = currentDevices.includes(deviceId) || room.ownerDeviceId === deviceId;
      if (!isAlreadyMember && currentDevices.length >= 2) {
        throw new Error('Room is full. A maximum of 2 devices are allowed at a time.');
      }

      const updatedDevices = isAlreadyMember ? currentDevices : [...currentDevices, deviceId];
      transaction.update(roomRef, {
        devices: updatedDevices,
        activeUsers: updatedDevices.length
      });
      joinedRoom = { ...room, devices: updatedDevices, activeUsers: updatedDevices.length };
    });

    return { roomId, db, mode: 'firebase', room: joinedRoom };
  } catch (err) {
    if (err.message?.includes('expired') || err.message?.includes('closed') || err.message?.includes('full') || err.message?.includes('not found')) {
      throw err;
    }
    console.warn('Firebase joinRoom failed:', err);
    throw err;
  }
}

export async function leaveRoomPresence(roomId) {
  if (!firebaseReady || !db) return;
  try {
    const deviceId = getClientDeviceId();
    const roomRef = doc(db, 'rooms', roomId);
    const roomSnapshot = await getDoc(roomRef);
    if (roomSnapshot.exists()) {
      const room = roomSnapshot.data();
      const currentDevices = (Array.isArray(room.devices) ? room.devices : []).filter(d => d !== deviceId);
      await updateDoc(roomRef, {
        devices: currentDevices,
        activeUsers: Math.max(0, currentDevices.length)
      }).catch(() => {});
    }
  } catch {}
}

export async function deleteRoom(roomId) {
  if (!firebaseReady || !db) return;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    await setDoc(roomRef, { status: 'deleted', activeUsers: 0 }, { merge: true }).catch(() => {});
    await deleteDoc(roomRef).catch(() => {});
  } catch (err) {
    console.warn('Could not delete room:', err);
  }
}

export async function clearRoomData(roomId) {
  if (!firebaseReady || !db) return;
  const user = await ensureAnonymousUser();
  if (!user) return;
  for (const child of ['messages', 'files']) {
    const snapshot = await getDocs(collection(db, 'rooms', roomId, child));
    await Promise.all(snapshot.docs.map(item => deleteDoc(item.ref)));
  }
}

export function watchRoom(roomId, onRoom, onError) {
  if (!firebaseReady) return () => {};
  return onSnapshot(doc(db, 'rooms', roomId), snapshot => {
    if (snapshot.exists()) {
      onRoom({ roomId, ...snapshot.data() });
    } else {
      // A deleted document is the final room state. Consumers must receive it
      // so joined devices can leave instead of staying on a stale workspace.
      onRoom(null);
    }
  }, onError);
}
