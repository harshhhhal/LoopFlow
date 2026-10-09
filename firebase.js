import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-app.js';
import { getAuth, signInAnonymously } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-firestore.js';
import { getStorage } from 'https://www.gstatic.com/firebasejs/11.3.0/firebase-storage.js';

// Paste the Firebase Web App values from Project settings here.
export const firebaseConfig = {
  apiKey: 'AIzaSyADgsIngChGY8SrqIVUMdXz-EvqZGrCCzI',
  authDomain: 'loopflow-37120.firebaseapp.com',
  projectId: 'loopflow-37120',
  storageBucket: 'loopflow-37120.firebasestorage.app',
  messagingSenderId: '155647179390',
  appId: '1:155647179390:web:ce3a08ddeb2e1045c9762f'
};

export const firebaseReady = Object.values(firebaseConfig).every(Boolean);
const app = firebaseReady ? initializeApp(firebaseConfig) : null;
export const auth = app ? getAuth(app) : null;
export const db = app ? getFirestore(app) : null;
export const storage = app ? getStorage(app) : null;

let anonymousUserPromise = null;

export function ensureAnonymousUser() {
  if (!firebaseReady || !auth) return Promise.resolve(null);
  if (!anonymousUserPromise) {
    anonymousUserPromise = signInAnonymously(auth)
      .then(({ user }) => user)
      .catch(err => {
        anonymousUserPromise = null;
        console.warn('Firebase anonymous authentication failed:', err);
        return null;
      });
  }
  return anonymousUserPromise;
}
