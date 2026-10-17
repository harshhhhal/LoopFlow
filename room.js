import { firebaseReady, db, storage, firebaseConfig, ensureAnonymousUser } from './firebase.js';
import { doc, getDoc, getDocs, collection, onSnapshot, setDoc, deleteDoc, serverTimestamp, Timestamp, runTransaction } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { refFromURL, deleteObject } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-storage.js';

const ROOM_LIFETIME_MS = 30 * 60 * 1000;

export function roomLifetimeMs(minutes = 30) {
  const value = Number(minutes);
  return (Number.isFinite(value) && value > 0 ? value : 30) * 60 * 1000;
}

export function makeRoomCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export async function createRoom(roomId, lifetimeMinutes = 30) {
  if (!firebaseReady) return { roomId, mode: 'demo' };
  try {
    const user = await ensureAnonymousUser();
    if (!user) throw new Error('Could not sign in to Firebase. Please try again.');
    const expiresAt = Timestamp.fromMillis(Date.now() + roomLifetimeMs(lifetimeMinutes));
    await setDoc(doc(db, 'rooms', roomId), {
      roomId,
      createdAt: serverTimestamp(),
      expiresAt,
      activeUsers: 1,
      members: [user.uid],
      status: 'active',
      lifetimeMinutes: Number(lifetimeMinutes) || 30,
      ownerId: user?.uid || 'host'
    });
    return { roomId, db, mode: 'firebase', expiresAt };
  } catch (err) {
    console.warn('Firebase room creation failed:', err);
    throw err;
  }
}

export async function joinRoom(roomId) {
  if (!firebaseReady) return { roomId, mode: 'demo' };
  try {
    const user = await ensureAnonymousUser();
    if (!user) throw new Error('Could not sign in to Firebase. Please try again.');
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

      const currentMembers = Array.isArray(room.members)
        ? room.members
        : (room.ownerId ? [room.ownerId] : []);
      if (!Array.isArray(room.members) && Number(room.activeUsers) >= 2 && user.uid !== room.ownerId) {
        throw new Error('Room is full. A maximum of 2 devices are allowed at a time.');
      }
      const isAlreadyMember = currentMembers.includes(user.uid);
      if (!isAlreadyMember && currentMembers.length >= 2) {
        throw new Error('Room is full. A maximum of 2 devices are allowed at a time.');
      }

      const updatedMembers = isAlreadyMember ? currentMembers : [...currentMembers, user.uid];
      if (!isAlreadyMember) {
        transaction.update(roomRef, {
          members: updatedMembers,
          activeUsers: updatedMembers.length
        });
      }
      joinedRoom = { ...room, members: updatedMembers, activeUsers: updatedMembers.length };
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
    const user = await ensureAnonymousUser();
    if (!user) return;
    const roomRef = doc(db, 'rooms', roomId);
    await runTransaction(db, async transaction => {
      const roomSnapshot = await transaction.get(roomRef);
      if (!roomSnapshot.exists()) return;
      const room = roomSnapshot.data();
      if (room.ownerId === user.uid) return;
      const members = (Array.isArray(room.members) ? room.members : []).filter(id => id !== user.uid);
      if (members.length !== room.members?.length) {
        transaction.update(roomRef, { members, activeUsers: members.length });
      }
    });
  } catch {}
}

export async function deleteRoom(roomId) {
  if (!firebaseReady || !db) return;
  try {
    const roomRef = doc(db, 'rooms', roomId);
    const user = await ensureAnonymousUser();
    if (!user) return;
    const roomSnapshot = await getDoc(roomRef);
    if (!roomSnapshot.exists() || roomSnapshot.data().ownerId !== user.uid) return;
    await clearRoomData(roomId);
    await deleteDoc(roomRef);
  } catch (err) {
    console.warn('Could not delete room:', err);
  }
}

export async function clearRoomData(roomId) {
  if (!firebaseReady || !db) return;
  const user = await ensureAnonymousUser();
  if (!user) return;
  const roomSnapshot = await getDoc(doc(db, 'rooms', roomId));
  if (!roomSnapshot.exists() || roomSnapshot.data().ownerId !== user.uid) {
    throw new Error('Only the room owner can clear its contents.');
  }

  const [messagesSnapshot, filesSnapshot, signalsSnapshot] = await Promise.all([
    getDocs(collection(db, 'rooms', roomId, 'messages')),
    getDocs(collection(db, 'rooms', roomId, 'files')),
    getDocs(collection(db, 'rooms', roomId, 'webrtc'))
  ]);

  const chunkSnapshots = await Promise.all(filesSnapshot.docs.map(file =>
    getDocs(collection(db, 'rooms', roomId, 'files', file.id, 'chunks'))
  ));
  const storageRefs = filesSnapshot.docs
    .map(file => file.data().fileURL)
    .filter(url => {
      if (typeof url !== 'string') return false;
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:'
          && parsed.hostname === 'firebasestorage.googleapis.com'
          && decodeURIComponent(parsed.pathname).includes(`/b/${firebaseConfig.storageBucket}/o/rooms/${roomId}/`);
      } catch {
        return false;
      }
    });
  await Promise.all(storageRefs.map(async url => {
    try {
      await deleteObject(refFromURL(storage, url));
    } catch (error) {
      if (error?.code !== 'storage/object-not-found') throw error;
    }
  }));

  const refsToDelete = [
    ...messagesSnapshot.docs.map(item => item.ref),
    ...filesSnapshot.docs.map(item => item.ref),
    ...signalsSnapshot.docs.map(item => item.ref),
    ...chunkSnapshots.flatMap(snapshot => snapshot.docs.map(item => item.ref))
  ];
  for (let index = 0; index < refsToDelete.length; index += 100) {
    await Promise.all(refsToDelete.slice(index, index + 100).map(ref => deleteDoc(ref)));
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
