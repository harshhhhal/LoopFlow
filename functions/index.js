const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { logger } = require('firebase-functions');

initializeApp();

const db = getFirestore();
const bucket = getStorage().bucket();

exports.deleteExpiredRooms = onSchedule({
  schedule: 'every 5 minutes',
  timeZone: 'UTC',
  retryCount: 3
}, async () => {
  const expiredRooms = await db.collection('rooms')
    .where('expiresAt', '<=', Timestamp.now())
    .orderBy('expiresAt')
    .limit(100)
    .get();

  for (const room of expiredRooms.docs) {
    try {
      await bucket.deleteFiles({ prefix: `rooms/${room.id}/`, force: true });
      await db.recursiveDelete(room.ref);
      logger.info('Deleted expired LoopFlow room and its files.', { roomId: room.id });
    } catch (error) {
      logger.error('Could not fully delete expired LoopFlow room.', { roomId: room.id, error });
      throw error;
    }
  }
});
