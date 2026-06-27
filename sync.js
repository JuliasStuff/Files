/* Firebase sync module — no-auth "vault key" model.
 *
 * Why no auth?  This app is single-user; sign-in screens are friction the
 * user explicitly rejected.  Instead, every device shares the same random
 * "vault key" (a 32-char URL-safe secret).  All data lives under
 * `vaults/{vaultKey}/...` in Firestore and Storage, and rules permit access
 * to any path whose vault segment is long enough — so the key itself acts
 * as the credential.
 *
 * Data model:
 *   Firestore  vaults/{vaultKey}/files/{id}    { name, type, addedAt, updatedAt, deletedAt|null, sizeBytes, storagePath }
 *   Firestore  vaults/{vaultKey}/meta/order    { ids: [...], updatedAt }
 *   Storage    vaults/{vaultKey}/files/{id}    raw blob
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getFirestore, doc, setDoc, deleteDoc, collection, onSnapshot,
  enableIndexedDbPersistence,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import {
  getStorage, ref as storageRef, uploadBytes, getBlob, deleteObject,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-storage.js";

const CONFIG_KEY = 'files.firebase-config';
const VAULT_KEY  = 'files.vault-key';

// ─── Public state ────────────────────────────────────────
export const state = {
  configured: false,   // Firebase config saved
  linked: false,       // configured AND vault key set AND subscriptions active
  vaultKey: null,
  status: 'idle',      // 'idle' | 'syncing' | 'error' | 'offline'
  lastError: null,
};

// Hooks the app fills in.
export const hooks = {
  onRemoteUpsert: async (_meta) => {},
  onRemoteDelete: async (_id, _hard) => {},
  onRemoteOrder: async (_ids) => {},
  onInitialSyncComplete: async () => {},
  onStatusChange: () => {},
};

let app, db, storage;
let unsubFiles = null, unsubOrder = null;
let pendingInitialSync = false;

// ─── Config persistence ──────────────────────────────────
export function loadConfig() {
  try { return JSON.parse(localStorage.getItem(CONFIG_KEY) || 'null'); }
  catch { return null; }
}
export function saveConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}
export function clearAll() {
  localStorage.removeItem(CONFIG_KEY);
  localStorage.removeItem(VAULT_KEY);
}

export function loadVaultKey() {
  return localStorage.getItem(VAULT_KEY) || null;
}
export function saveVaultKey(key) {
  localStorage.setItem(VAULT_KEY, key);
  state.vaultKey = key;
}
export function generateVaultKey() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  // URL-safe base64 → 32 chars.
  let s = btoa(String.fromCharCode(...bytes));
  s = s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return s;
}
export function isValidVaultKey(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_-]{24,}$/.test(s.trim());
}

// Accepts a JSON object, a JS literal ("apiKey: '...'"), or pure JSON.
export function parseConfigInput(text) {
  if (!text) throw new Error('Empty config.');
  let s = String(text).trim();
  s = s.replace(/^\s*(const|let|var)\s+\w+\s*=\s*/, '').replace(/;\s*$/, '');
  let obj;
  try {
    obj = JSON.parse(s);
  } catch {
    try {
      obj = new Function(`"use strict"; return (${s});`)();
    } catch {
      throw new Error('Could not parse config. Paste the JSON object from Firebase Console.');
    }
  }
  if (!obj || typeof obj !== 'object') throw new Error('Config must be an object.');
  for (const k of ['apiKey', 'projectId', 'storageBucket', 'appId']) {
    if (!obj[k]) throw new Error(`Missing "${k}" in Firebase config.`);
  }
  return obj;
}

// ─── Init ────────────────────────────────────────────────
export async function init() {
  const cfg = loadConfig();
  if (!cfg) { state.configured = false; emitStatus(); return false; }

  try {
    app = initializeApp(cfg);
    db = getFirestore(app);
    storage = getStorage(app);
    state.configured = true;
    enableIndexedDbPersistence(db).catch(() => {});
  } catch (err) {
    state.configured = false;
    emitStatus('error', err && err.message || String(err));
    return false;
  }

  const key = loadVaultKey();
  if (key && isValidVaultKey(key)) {
    state.vaultKey = key;
    startSubscriptions();
  }
  emitStatus();
  return true;
}

export function link(key) {
  if (!state.configured) throw new Error('Save Firebase config first.');
  if (!isValidVaultKey(key)) throw new Error('Vault key must be at least 24 URL-safe characters.');
  saveVaultKey(key.trim());
  startSubscriptions();
  emitStatus();
}

export function unlink() {
  stopSubscriptions();
  localStorage.removeItem(VAULT_KEY);
  state.vaultKey = null;
  state.linked = false;
  emitStatus();
}

// ─── Subscriptions ───────────────────────────────────────
function vaultColRef(...path) {
  return collection(db, 'vaults', state.vaultKey, ...path);
}
function vaultDocRef(...path) {
  return doc(db, 'vaults', state.vaultKey, ...path);
}
function vaultStorageRef(...parts) {
  return storageRef(storage, ['vaults', state.vaultKey, ...parts].join('/'));
}

function startSubscriptions() {
  if (unsubFiles) return;
  state.linked = true;
  pendingInitialSync = true;
  emitStatus('syncing');

  unsubFiles = onSnapshot(
    vaultColRef('files'),
    async (snap) => {
      try {
        for (const change of snap.docChanges()) {
          const data = change.doc.data();
          if (change.type === 'removed') {
            await hooks.onRemoteDelete(change.doc.id, /* hard */ true);
            continue;
          }
          if (data && data.deletedAt) {
            await hooks.onRemoteDelete(change.doc.id, /* hard */ false);
          } else if (data) {
            await hooks.onRemoteUpsert({
              id: change.doc.id,
              name: data.name,
              type: data.type,
              addedAt: data.addedAt || Date.now(),
              updatedAt: data.updatedAt || data.addedAt || Date.now(),
              deletedAt: null,
              sizeBytes: data.sizeBytes || 0,
              storagePath: data.storagePath || null,
            });
          }
        }
        if (pendingInitialSync && !snap.metadata.fromCache) {
          pendingInitialSync = false;
          try { await hooks.onInitialSyncComplete(); } catch (e) { console.warn(e); }
        }
        emitStatus('idle');
      } catch (err) {
        console.error('Files snapshot handling failed:', err);
        emitStatus('error', err && err.message || String(err));
      }
    },
    (err) => {
      console.error('Files subscription error:', err);
      emitStatus('error', err && err.message || String(err));
    }
  );

  unsubOrder = onSnapshot(
    vaultDocRef('meta', 'order'),
    (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (Array.isArray(data.ids)) hooks.onRemoteOrder(data.ids);
      }
    },
    () => {}
  );
}

function stopSubscriptions() {
  if (unsubFiles) { unsubFiles(); unsubFiles = null; }
  if (unsubOrder) { unsubOrder(); unsubOrder = null; }
}

// ─── Pushes ──────────────────────────────────────────────
export async function pushUpload(record) {
  if (!state.linked) return;
  emitStatus('syncing');
  try {
    const path = `vaults/${state.vaultKey}/files/${record.id}`;
    await uploadBytes(vaultStorageRef('files', record.id), record.blob, {
      contentType: record.type,
    });
    await setDoc(vaultDocRef('files', record.id), {
      name: record.name,
      type: record.type,
      addedAt: record.addedAt,
      updatedAt: record.updatedAt || record.addedAt || Date.now(),
      deletedAt: null,
      sizeBytes: record.blob.size,
      storagePath: path,
    });
    emitStatus('idle');
  } catch (err) {
    emitStatus('error', err && err.message || String(err));
    throw err;
  }
}

export async function pushSoftDelete(id) {
  if (!state.linked) return;
  emitStatus('syncing');
  try {
    await setDoc(vaultDocRef('files', id), {
      deletedAt: Date.now(),
      updatedAt: Date.now(),
    }, { merge: true });
    emitStatus('idle');
  } catch (err) {
    emitStatus('error', err && err.message || String(err));
    throw err;
  }
}

export async function pushRestore(id) {
  if (!state.linked) return;
  emitStatus('syncing');
  try {
    await setDoc(vaultDocRef('files', id), {
      deletedAt: null,
      updatedAt: Date.now(),
    }, { merge: true });
    emitStatus('idle');
  } catch (err) {
    emitStatus('error', err && err.message || String(err));
    throw err;
  }
}

export async function pushPurge(id) {
  if (!state.linked) return;
  emitStatus('syncing');
  try {
    await deleteObject(vaultStorageRef('files', id)).catch(() => {});
    await deleteDoc(vaultDocRef('files', id));
    emitStatus('idle');
  } catch (err) {
    emitStatus('error', err && err.message || String(err));
    throw err;
  }
}

export async function pushOrder(ids) {
  if (!state.linked) return;
  try {
    await setDoc(vaultDocRef('meta', 'order'), {
      ids,
      updatedAt: Date.now(),
    });
  } catch (err) {
    console.warn('Order push failed:', err);
  }
}

export async function downloadBlob(id) {
  if (!state.linked) throw new Error('Sync not linked.');
  return await getBlob(vaultStorageRef('files', id));
}

// ─── Status plumbing ─────────────────────────────────────
function emitStatus(s, err = null) {
  if (s) state.status = s;
  if (err !== null) state.lastError = err;
  try { hooks.onStatusChange(state); } catch {}
}
