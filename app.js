/* Files — minimal local-file stash PWA.
   Stores JPG/PDF blobs in IndexedDB and shows large thumbnails. */

import * as sync from './sync.js';

// PDF.js is loaded as a module from the CDN in index.html.
// We pull it in lazily via a dynamic import so the app still works
// (with PDF fallbacks) if the CDN is blocked.
let pdfjsLib = null;
async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;
  try {
    const mod = await import('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.0.379/pdf.worker.min.mjs';
    pdfjsLib = mod;
  } catch (err) {
    console.warn('PDF.js unavailable — PDFs will use fallback thumbnails.', err);
    pdfjsLib = null;
  }
  return pdfjsLib;
}

// JSZip for backup/restore. Loaded lazily so backups work even though the
// app remains fully offline-capable for normal browsing.
let jsZipLib = null;
async function getJsZip() {
  if (jsZipLib) return jsZipLib;
  if (typeof window.JSZip !== 'undefined') {
    jsZipLib = window.JSZip;
    return jsZipLib;
  }
  await new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Failed to load JSZip'));
    document.head.appendChild(s);
  });
  jsZipLib = window.JSZip;
  return jsZipLib;
}

// ─── IndexedDB wrapper ───────────────────────────────────
const DB_NAME = 'files-app';
const STORE   = 'files';
const ORDER_KEY = 'files.order';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function dbAll() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror   = () => reject(req.error);
  });
}

async function dbPut(record) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function dbDelete(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ─── DOM refs ────────────────────────────────────────────
const grid       = document.getElementById('grid');
const empty      = document.getElementById('empty');
const addBtn     = document.getElementById('add');
const picker     = document.getElementById('picker');
const backupBtn  = document.getElementById('backup');
const restoreBtn = document.getElementById('restore');
const restorePicker = document.getElementById('restore-picker');
const storageBanner = document.getElementById('storage-banner');
const storageBannerAction = document.getElementById('storage-banner-action');
const storageBannerDismiss = document.getElementById('storage-banner-dismiss');
// Sync UI
const syncStatusBtn = document.getElementById('sync-status');
const syncDot = document.getElementById('sync-dot');
const syncSheet = document.getElementById('sync-sheet');
const syncCloseBtn = document.getElementById('sync-close');
const syncStatusLine = document.getElementById('sync-status-line');
const syncSetupSection = document.getElementById('sync-setup');
const syncAuthSection = document.getElementById('sync-auth');
const syncActiveSection = document.getElementById('sync-active');
const syncConfigInput = document.getElementById('sync-config');
const syncSaveConfigBtn = document.getElementById('sync-save-config');
const syncVaultKeyInput = document.getElementById('sync-vault-key');
const syncVaultCopyBtn = document.getElementById('sync-vault-copy');
const syncVaultRegenBtn = document.getElementById('sync-vault-regen');
const syncVaultSaveBtn = document.getElementById('sync-vault-save');
const syncActiveKeyInput = document.getElementById('sync-active-key');
const syncActiveCopyBtn = document.getElementById('sync-active-copy');
const syncAuthError = document.getElementById('sync-auth-error');
const syncClearConfigBtn = document.getElementById('sync-clear-config');
const syncClearConfigBtn2 = document.getElementById('sync-clear-config-2');
const syncSignoutBtn = document.getElementById('sync-signout');
// Trash UI
const trashBtn = document.getElementById('trash');
const trashSheet = document.getElementById('trash-sheet');
const trashCloseBtn = document.getElementById('trash-close');
const trashList = document.getElementById('trash-list');
const trashEmptyMsg = document.getElementById('trash-empty-msg');
const trashEmptyBtn = document.getElementById('trash-empty');
const viewer     = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
const viewerName = document.getElementById('viewer-name');
const viewerClose  = document.getElementById('viewer-close');
const viewerDelete = document.getElementById('viewer-delete');
const viewerRotateCcw = document.getElementById('viewer-rotate-ccw');
const viewerRotateCw  = document.getElementById('viewer-rotate-cw');
const confirmEl  = document.getElementById('confirm');
const confirmMsg = document.getElementById('confirm-msg');
const confirmOk  = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');

// ─── State ───────────────────────────────────────────────
// files: ordered array of {
//   id, name, type, blob,
//   addedAt, updatedAt,
//   deletedAt: number|null,
//   syncState: 'clean'|'pending-upload'|'remote-only',
// }
// remote-only means we know about a remote file but haven't downloaded
// its blob yet — rendered as a loading placeholder.
let files = [];
let currentViewerId = null;
let currentViewerObjectUrl = null;
let suppressRemoteEcho = false; // when true, ignore one inbound remote event we ourselves caused

// ─── Order persistence ───────────────────────────────────
function loadOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(ORDER_KEY) || 'null');
    if (!Array.isArray(saved)) return;
    const byId = new Map(files.map(f => [f.id, f]));
    const reordered = [];
    for (const id of saved) if (byId.has(id)) reordered.push(byId.get(id));
    for (const f of files) if (!saved.includes(f.id)) reordered.push(f);
    files = reordered;
  } catch { /* ignore */ }
}

function saveOrder() {
  const ids = [...grid.querySelectorAll('.tile')].map(t => t.dataset.id);
  // Preserve any deleted/hidden files at the end of the in-memory array.
  const byId = new Map(files.map(f => [f.id, f]));
  const hidden = files.filter(f => !ids.includes(f.id));
  files = ids.map(id => byId.get(id)).filter(Boolean).concat(hidden);
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  // Push to cloud (best-effort; ignored if sync not signed in).
  sync.pushOrder(ids).catch(() => {});
}

// ─── Rendering ───────────────────────────────────────────
function visibleFiles() {
  return files.filter(f => !f.deletedAt);
}
function deletedFiles() {
  return files.filter(f => !!f.deletedAt)
    .sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
}

function render() {
  grid.innerHTML = '';
  const visible = visibleFiles();
  if (visible.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const f of visible) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    tile.dataset.id = f.id;
    tile.setAttribute('role', 'button');
    tile.tabIndex = 0;
    tile.setAttribute('aria-label', `Open ${f.name}`);

    const thumb = document.createElement('div');
    thumb.className = 'tile-thumb loading';
    thumb.textContent = 'Loading…';
    tile.appendChild(thumb);

    const kind = document.createElement('span');
    kind.className = 'tile-kind';
    kind.textContent =
      f.type === 'application/pdf' ? 'PDF' :
      f.type === 'image/png'      ? 'PNG' : 'JPG';
    tile.appendChild(kind);

    const name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = f.name;
    tile.appendChild(name);

    tile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openViewer(f.id);
      }
    });

    attachTileHandlers(tile, f.id);
    grid.appendChild(tile);
    renderThumb(thumb, f);
  }
}

async function renderThumb(thumb, file) {
  // If the blob hasn't been downloaded yet (remote-only placeholder), show a loader.
  if (!file.blob) {
    thumb.textContent = 'Syncing…';
    thumb.classList.add('loading');
    return;
  }
  thumb.textContent = '';
  thumb.classList.remove('loading');

  if (file.type === 'application/pdf') {
    const lib = await getPdfjs();
    if (!lib) return showPdfFallback(thumb);
    try {
      const buf = await file.blob.arrayBuffer();
      const pdf = await lib.getDocument({ data: buf }).promise;
      const page = await pdf.getPage(1);
      const baseViewport = page.getViewport({ scale: 1 });
      // Target ~400px wide for crisp display.
      const scale = 400 / baseViewport.width;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      thumb.appendChild(canvas);
    } catch (err) {
      console.warn('PDF thumbnail failed:', err);
      showPdfFallback(thumb);
    }
    return;
  }

  // Image
  const url = URL.createObjectURL(file.blob);
  const img = document.createElement('img');
  img.alt = '';
  img.src = url;
  img.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
  img.addEventListener('error', () => URL.revokeObjectURL(url), { once: true });
  thumb.appendChild(img);
}

function showPdfFallback(thumb) {
  thumb.classList.add('pdf-fallback');
  thumb.innerHTML = `
    <svg viewBox="0 0 24 24" width="56" height="56" aria-hidden="true">
      <path fill="currentColor" d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8zM6 20V4h7v5h5v11z"/>
    </svg>
    <span class="pdf-badge">PDF</span>
  `;
}

// ─── Viewer ──────────────────────────────────────────────
function openViewer(id) {
  const file = files.find(f => f.id === id);
  if (!file) return;
  currentViewerId = id;
  viewerBody.innerHTML = '';
  releaseViewerUrl();

  currentViewerObjectUrl = URL.createObjectURL(file.blob);

  const rotator = document.createElement('div');
  rotator.className = 'viewer-rotator';
  viewerBody.appendChild(rotator);

  if (file.type === 'application/pdf') {
    // <embed> works on desktop & most mobile browsers; iOS Safari handles it
    // via the built-in PDF viewer. If the browser can't render, the fallback
    // <a download> link still works.
    const wrap = document.createElement('div');
    wrap.style.width = '100%';
    wrap.style.height = '100%';
    wrap.style.position = 'relative';

    const embed = document.createElement('embed');
    embed.type = 'application/pdf';
    embed.src = currentViewerObjectUrl;
    wrap.appendChild(embed);

    // Fallback link in case <embed> shows nothing.
    const fb = document.createElement('div');
    fb.className = 'pdf-fallback';
    fb.style.position = 'absolute';
    fb.style.inset = '0';
    fb.style.display = 'none';
    fb.innerHTML = `
      <div>This browser can't display PDFs inline.</div>
      <a href="${currentViewerObjectUrl}" download="${escapeAttr(file.name)}">Open / Download</a>
    `;
    wrap.appendChild(fb);

    // Heuristic: if embed has zero size after a moment, show fallback.
    setTimeout(() => {
      if (!embed.clientHeight) fb.style.display = 'flex';
    }, 800);

    rotator.appendChild(wrap);
  } else {
    const img = document.createElement('img');
    img.alt = file.name;
    img.src = currentViewerObjectUrl;
    rotator.appendChild(img);
  }

  viewerName.textContent = file.name;
  viewer.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  currentRotation = 0;
  applyViewerRotation(0, true);
}

function closeViewer() {
  viewer.classList.add('hidden');
  viewerBody.innerHTML = '';
  releaseViewerUrl();
  currentViewerId = null;
  currentRotation = 0;
  document.body.style.overflow = '';
}

function releaseViewerUrl() {
  if (currentViewerObjectUrl) {
    URL.revokeObjectURL(currentViewerObjectUrl);
    currentViewerObjectUrl = null;
  }
}

// ─── Viewer rotation (manual buttons) ────────────────────
// Two toolbar buttons rotate the displayed content by 90° in either
// direction. Predictable on any device regardless of rotation-lock state.
let currentRotation = 0;          // applied rotation in degrees (0/90/180/270)

function applyViewerRotation(deg, force = false) {
  deg = ((deg % 360) + 360) % 360;
  if (!force && deg === currentRotation) return;
  const rotator = viewerBody.querySelector('.viewer-rotator');
  if (!rotator) { currentRotation = deg; return; }
  currentRotation = deg;

  const w = viewerBody.clientWidth;
  const h = viewerBody.clientHeight;
  const quarter = deg === 90 || deg === 270;
  rotator.style.width  = (quarter ? h : w) + 'px';
  rotator.style.height = (quarter ? w : h) + 'px';
  rotator.style.transform = `translate(-50%, -50%) rotate(${deg}deg)`;
}

viewerRotateCcw.addEventListener('click', () => {
  applyViewerRotation(currentRotation - 90);
});
viewerRotateCw.addEventListener('click', () => {
  applyViewerRotation(currentRotation + 90);
});

window.addEventListener('resize', () => {
  if (!viewer.classList.contains('hidden')) {
    applyViewerRotation(currentRotation, true);
  }
});

viewerClose.addEventListener('click', closeViewer);
viewerDelete.addEventListener('click', () => {
  if (!currentViewerId) return;
  const file = files.find(f => f.id === currentViewerId);
  if (!file) return;
  askConfirm(`Move "${file.name}" to trash?`, async () => {
    // Soft-delete: keep blob locally so restore is instant. Sync deletes remotely.
    file.deletedAt = Date.now();
    file.updatedAt = file.deletedAt;
    await dbPut(file);
    sync.pushSoftDelete(file.id).catch(err => console.warn('Cloud delete failed:', err));
    closeViewer();
    render();
  });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!confirmEl.classList.contains('hidden')) hideConfirm();
    else if (!viewer.classList.contains('hidden')) closeViewer();
  }
});

// ─── Confirm dialog ──────────────────────────────────────
let pendingConfirm = null;
function askConfirm(msg, onOk) {
  confirmMsg.textContent = msg;
  pendingConfirm = onOk;
  confirmOk.textContent = 'Delete';
  confirmOk.classList.add('danger');
  confirmCancel.classList.remove('hidden');
  confirmEl.classList.remove('hidden');
}
function hideConfirm() {
  confirmEl.classList.add('hidden');
  pendingConfirm = null;
}
confirmCancel.addEventListener('click', hideConfirm);
confirmOk.addEventListener('click', async () => {
  const fn = pendingConfirm;
  hideConfirm();
  if (fn) await fn();
});
confirmEl.addEventListener('click', (e) => {
  if (e.target === confirmEl) hideConfirm();
});

// ─── Add files ───────────────────────────────────────────
addBtn.addEventListener('click', () => picker.click());
picker.addEventListener('change', async () => {
  const chosen = [...picker.files];
  picker.value = ''; // allow re-picking the same file later
  for (const file of chosen) {
    if (!isAllowed(file)) continue;
    const record = {
      id: cryptoId(),
      name: file.name,
      type:
        file.type === 'application/pdf' ? 'application/pdf' :
        file.type === 'image/png'      ? 'image/png' :
                                          'image/jpeg',
      blob: file,
      addedAt: Date.now(),
    };
    await dbPut(record);
    files.push(record);
  }
  saveOrder();
  render();
});

function isAllowed(file) {
  if (file.type === 'application/pdf') return true;
  if (file.type === 'image/jpeg' || file.type === 'image/jpg') return true;
  if (file.type === 'image/png') return true;
  // Some browsers leave type blank — fall back to extension.
  return /\.(jpe?g|png|pdf)$/i.test(file.name);
}

function cryptoId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'f_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// ─── Persistent storage ──────────────────────────────────
// Without this, browsers (especially mobile Chrome) may evict IndexedDB
// data under storage pressure or after long periods of inactivity.
// Installing the site as a PWA usually causes Chrome to auto-grant it.
const DISMISS_KEY = 'files.storage-banner-dismissed';

async function ensurePersistence() {
  if (!navigator.storage || !navigator.storage.persist) {
    updateStorageBanner(false, true /* unsupported */);
    return false;
  }
  let persisted = false;
  try {
    persisted = await navigator.storage.persisted();
    if (!persisted) persisted = await navigator.storage.persist();
  } catch (err) {
    console.warn('Storage persistence check failed:', err);
  }
  updateStorageBanner(persisted, false);
  return persisted;
}

function updateStorageBanner(persisted, unsupported) {
  if (!storageBanner) return;
  if (persisted) {
    storageBanner.classList.add('hidden');
    return;
  }
  if (localStorage.getItem(DISMISS_KEY) === '1') {
    storageBanner.classList.add('hidden');
    return;
  }
  if (unsupported) {
    storageBannerAction.classList.add('hidden');
    storageBanner.querySelector('.storage-banner-text').textContent =
      'This browser may clear stored files. Back up regularly with the ⬇ button.';
  }
  storageBanner.classList.remove('hidden');
}

if (storageBannerAction) {
  storageBannerAction.addEventListener('click', async () => {
    const ok = await ensurePersistence();
    if (!ok) {
      // Common on Android Chrome unless the site is installed as a PWA.
      // Surface the actionable hint instead of silently failing.
      storageBanner.querySelector('.storage-banner-text').textContent =
        'Browser declined. Install this app (browser menu → "Add to Home screen"), then try again.';
      storageBannerAction.textContent = 'Try again';
    }
  });
}
if (storageBannerDismiss) {
  storageBannerDismiss.addEventListener('click', () => {
    localStorage.setItem(DISMISS_KEY, '1');
    storageBanner.classList.add('hidden');
  });
}

// Re-request persistence on the first real user gesture — some browsers
// only grant it after engagement.
let gestureRetryDone = false;
function gestureRetryPersistence() {
  if (gestureRetryDone) return;
  gestureRetryDone = true;
  ensurePersistence();
}
window.addEventListener('pointerdown', gestureRetryPersistence, { once: true });
window.addEventListener('keydown', gestureRetryPersistence, { once: true });

// ─── Backup / Restore ────────────────────────────────────
function timestampForFilename() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function safeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '_').slice(0, 180) || 'file';
}

async function backupAll() {
  if (!files.length) {
    askInfo('Nothing to back up yet.');
    return;
  }
  let JSZip;
  try {
    JSZip = await getJsZip();
  } catch (err) {
    console.error(err);
    askInfo('Could not load the backup library. Check your connection and try again.');
    return;
  }

  const original = backupBtn.innerHTML;
  backupBtn.disabled = true;
  backupBtn.classList.add('busy');

  try {
    const zip = new JSZip();
    const manifest = { version: 1, exportedAt: new Date().toISOString(), files: [] };
    const usedNames = new Set();

    for (const f of files) {
      // Ensure unique filename inside the zip.
      let base = safeFilename(f.name);
      let candidate = base;
      let i = 1;
      while (usedNames.has(candidate)) {
        const dot = base.lastIndexOf('.');
        candidate = dot > 0
          ? `${base.slice(0, dot)} (${i})${base.slice(dot)}`
          : `${base} (${i})`;
        i++;
      }
      usedNames.add(candidate);

      zip.file(candidate, f.blob);
      manifest.files.push({
        id: f.id,
        name: f.name,
        type: f.type,
        addedAt: f.addedAt,
        storedAs: candidate,
      });
    }

    zip.file('manifest.json', JSON.stringify(manifest, null, 2));
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `files-backup-${timestampForFilename()}.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (err) {
    console.error('Backup failed:', err);
    askInfo('Backup failed: ' + (err && err.message || err));
  } finally {
    backupBtn.disabled = false;
    backupBtn.classList.remove('busy');
    backupBtn.innerHTML = original;
  }
}

async function restoreFromZip(file) {
  let JSZip;
  try {
    JSZip = await getJsZip();
  } catch (err) {
    askInfo('Could not load the restore library. Check your connection and try again.');
    return;
  }

  let zip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch (err) {
    askInfo('That file does not look like a valid backup zip.');
    return;
  }

  let manifest = null;
  const manifestEntry = zip.file('manifest.json');
  if (manifestEntry) {
    try {
      manifest = JSON.parse(await manifestEntry.async('string'));
    } catch { manifest = null; }
  }

  const existingIds = new Set(files.map(f => f.id));
  const toImport = [];

  if (manifest && Array.isArray(manifest.files)) {
    for (const m of manifest.files) {
      const entry = zip.file(m.storedAs || m.name);
      if (!entry) continue;
      if (existingIds.has(m.id)) continue; // skip exact duplicates
      const blob = await entry.async('blob');
      const now = Date.now();
      toImport.push({
        id: m.id || cryptoId(),
        name: m.name || 'file',
        type: m.type || guessType(m.name) || blob.type || 'application/octet-stream',
        blob: new Blob([blob], { type: m.type || blob.type || 'application/octet-stream' }),
        addedAt: m.addedAt || now,
        updatedAt: now,
        deletedAt: null,
        syncState: 'pending-upload',
      });
    }
  } else {
    // No manifest — accept all supported files in the zip.
    const entries = [];
    zip.forEach((path, entry) => { if (!entry.dir) entries.push(entry); });
    for (const entry of entries) {
      const guessed = guessType(entry.name);
      if (!guessed) continue;
      const blob = await entry.async('blob');
      const now = Date.now();
      toImport.push({
        id: cryptoId(),
        name: entry.name.split('/').pop(),
        type: guessed,
        blob: new Blob([blob], { type: guessed }),
        addedAt: now,
        updatedAt: now,
        deletedAt: null,
        syncState: 'pending-upload',
      });
    }
  }

  if (!toImport.length) {
    askInfo('Nothing new to restore — files already present or zip empty.');
    return;
  }

  for (const rec of toImport) {
    await dbPut(rec);
    files.push(rec);
    sync.pushUpload(rec).then(async () => {
      rec.syncState = 'clean';
      await dbPut(rec);
    }).catch(err => console.warn('Cloud upload failed:', err));
  }
  saveOrder();
  render();
  askInfo(`Restored ${toImport.length} file${toImport.length === 1 ? '' : 's'}.`);
}

function guessType(name) {
  if (!name) return null;
  if (/\.pdf$/i.test(name)) return 'application/pdf';
  if (/\.png$/i.test(name)) return 'image/png';
  if (/\.jpe?g$/i.test(name)) return 'image/jpeg';
  return null;
}

if (backupBtn) backupBtn.addEventListener('click', backupAll);
if (restoreBtn) restoreBtn.addEventListener('click', () => restorePicker.click());
if (restorePicker) {
  restorePicker.addEventListener('change', async () => {
    const f = restorePicker.files && restorePicker.files[0];
    restorePicker.value = '';
    if (f) await restoreFromZip(f);
  });
}

// Lightweight info dialog reusing the confirm UI (single OK button).
function askInfo(msg) {
  confirmMsg.textContent = msg;
  pendingConfirm = null;
  confirmOk.textContent = 'OK';
  confirmOk.classList.remove('danger');
  confirmCancel.classList.add('hidden');
  confirmEl.classList.remove('hidden');
}

// ─── Drag-to-reorder (long-press) ────────────────────────
const LONG_PRESS_MS = 350;
const MOVE_THRESHOLD_PX = 8;

function attachTileHandlers(tile, id) {
  let pressTimer = null;
  let dragging = false;
  let pointerId = null;
  let startX = 0, startY = 0;
  let originalRect = null;
  let placeholder = null;
  let moved = false;

  function cancelPress() {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
  }

  function beginDrag(clientY) {
    dragging = true;
    originalRect = tile.getBoundingClientRect();

    placeholder = document.createElement('div');
    placeholder.className = 'tile-placeholder';
    placeholder.style.height = originalRect.height + 'px';
    tile.parentNode.insertBefore(placeholder, tile.nextSibling);

    tile.style.position = 'fixed';
    tile.style.left = originalRect.left + 'px';
    tile.style.top = originalRect.top + 'px';
    tile.style.width = originalRect.width + 'px';
    tile.style.height = originalRect.height + 'px';
    tile.style.margin = '0';
    tile.classList.add('dragging');
    startY = clientY;
  }

  tile.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    moved = false;
    cancelPress();
    pressTimer = setTimeout(() => {
      pressTimer = null;
      tile.setPointerCapture(pointerId);
      beginDrag(startY);
    }, LONG_PRESS_MS);
  });

  tile.addEventListener('pointermove', (e) => {
    if (e.pointerId !== pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.hypot(dx, dy) > MOVE_THRESHOLD_PX) {
        moved = true;
        cancelPress();
      }
      return;
    }
    e.preventDefault();
    tile.style.transform = `translate(${e.clientX - originalRect.left - originalRect.width / 2}px, ${dy}px)`;

    // Find drop target.
    const siblings = [...grid.querySelectorAll('.tile:not(.dragging)')];
    let best = null;
    let bestDist = Infinity;
    for (const other of siblings) {
      const rect = other.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dist = Math.hypot(e.clientX - cx, e.clientY - cy);
      if (dist < bestDist) { bestDist = dist; best = { other, rect, cx, cy }; }
    }
    if (best) {
      const before = e.clientY < best.cy
        || (Math.abs(e.clientY - best.cy) < best.rect.height / 2 && e.clientX < best.cx);
      if (before) grid.insertBefore(placeholder, best.other);
      else        grid.insertBefore(placeholder, best.other.nextSibling);
    }
  });

  function endPointer(e) {
    if (e.pointerId !== pointerId) return;
    cancelPress();
    if (dragging) {
      tile.style.position = '';
      tile.style.left = '';
      tile.style.top = '';
      tile.style.width = '';
      tile.style.height = '';
      tile.style.margin = '';
      tile.style.transform = '';
      tile.classList.remove('dragging');
      if (placeholder) {
        grid.insertBefore(tile, placeholder);
        placeholder.remove();
        placeholder = null;
      }
      saveOrder();
      dragging = false;
    } else if (!moved && e.type === 'pointerup') {
      openViewer(id);
    }
    pointerId = null;
    moved = false;
  }

  tile.addEventListener('pointerup', endPointer);
  tile.addEventListener('pointercancel', endPointer);
}

// ─── Sync wiring ─────────────────────────────────────────
// Tracks blob downloads in flight so concurrent remote upserts don't double-fetch.
const inFlightDownloads = new Map();

async function fetchBlobForRecord(rec) {
  if (rec.blob) return;
  if (inFlightDownloads.has(rec.id)) return inFlightDownloads.get(rec.id);
  const p = (async () => {
    try {
      const blob = await sync.downloadBlob(rec.id);
      rec.blob = blob;
      rec.syncState = 'clean';
      await dbPut(rec);
      // Re-render the tile if it's visible.
      const tile = grid.querySelector(`.tile[data-id="${cssEscape(rec.id)}"]`);
      if (tile) {
        const thumb = tile.querySelector('.tile-thumb');
        if (thumb) {
          thumb.classList.remove('loading');
          thumb.textContent = '';
          renderThumb(thumb, rec);
        }
      }
    } catch (err) {
      console.warn('Blob download failed for', rec.id, err);
    } finally {
      inFlightDownloads.delete(rec.id);
    }
  })();
  inFlightDownloads.set(rec.id, p);
  return p;
}

function cssEscape(s) {
  return (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/"/g, '\\"');
}

sync.hooks.onRemoteUpsert = async (meta) => {
  const existing = files.find(f => f.id === meta.id);
  if (existing) {
    // Update metadata only; keep existing blob.
    let changed = false;
    if (existing.name !== meta.name) { existing.name = meta.name; changed = true; }
    if (existing.type !== meta.type) { existing.type = meta.type; changed = true; }
    if (existing.deletedAt) {
      // Remote says it's alive again — clear local soft-delete (cross-device restore).
      existing.deletedAt = null;
      changed = true;
    }
    existing.updatedAt = meta.updatedAt;
    if (changed) {
      await dbPut(existing);
      render();
    }
    if (!existing.blob) fetchBlobForRecord(existing);
    return;
  }
  // New remote file: placeholder + background download.
  const rec = {
    id: meta.id,
    name: meta.name,
    type: meta.type,
    blob: null,
    addedAt: meta.addedAt,
    updatedAt: meta.updatedAt,
    deletedAt: null,
    syncState: 'remote-only',
  };
  await dbPut(rec);
  files.push(rec);
  render();
  fetchBlobForRecord(rec);
};

sync.hooks.onRemoteDelete = async (id, hard) => {
  const existing = files.find(f => f.id === id);
  if (!existing) return;
  if (hard) {
    files = files.filter(f => f.id !== id);
    await dbDelete(id);
  } else {
    existing.deletedAt = Date.now();
    existing.updatedAt = existing.deletedAt;
    await dbPut(existing);
  }
  render();
  renderTrashIfOpen();
};

sync.hooks.onRemoteOrder = async (ids) => {
  // Re-sort visible files to match remote order; unknown ids stay at end.
  const visibleIds = new Set(visibleFiles().map(f => f.id));
  const knownInRemoteOrder = ids.filter(id => visibleIds.has(id));
  const trailing = visibleFiles().filter(f => !ids.includes(f.id)).map(f => f.id);
  const newOrder = [...knownInRemoteOrder, ...trailing];
  const byId = new Map(files.map(f => [f.id, f]));
  const visibleSorted = newOrder.map(id => byId.get(id)).filter(Boolean);
  const deleted = files.filter(f => f.deletedAt);
  files = [...visibleSorted, ...deleted];
  localStorage.setItem(ORDER_KEY, JSON.stringify(newOrder));
  render();
};

sync.hooks.onInitialSyncComplete = async () => {
  // Reconcile: push anything local that hasn't been uploaded yet.
  for (const f of files) {
    if (!f.blob) continue; // remote-only placeholder
    if (f.syncState === 'clean') continue;
    if (f.deletedAt) {
      sync.pushSoftDelete(f.id).catch(() => {});
    } else {
      try {
        await sync.pushUpload(f);
        f.syncState = 'clean';
        await dbPut(f);
      } catch (err) {
        console.warn('Reconcile upload failed:', f.id, err);
      }
    }
  }
};

sync.hooks.onStatusChange = (s) => {
  updateSyncIndicator(s);
  updateSyncSheetUI();
};

// ─── Sync indicator ──────────────────────────────────────
function updateSyncIndicator(s) {
  if (!syncDot) return;
  syncDot.classList.remove('ok', 'syncing', 'warn', 'error');
  if (!s.configured) {
    syncDot.classList.add('warn'); // amber: needs setup
  } else if (!s.linked) {
    syncDot.classList.add('warn');
  } else if (s.status === 'error') {
    syncDot.classList.add('error');
  } else if (s.status === 'syncing') {
    syncDot.classList.add('syncing');
  } else {
    syncDot.classList.add('ok');
  }
}

// ─── Sync settings sheet ─────────────────────────────────
function openSyncSheet() {
  updateSyncSheetUI();
  syncSheet.classList.remove('hidden');
}
function closeSyncSheet() {
  syncSheet.classList.add('hidden');
  syncAuthError.classList.add('hidden');
}

function updateSyncSheetUI() {
  if (!syncSheet || syncSheet.classList.contains('hidden')) {
    // Still update the status line caption when sheet closed (cheap).
  }
  const s = sync.state;
  // Status line
  if (!s.configured) syncStatusLine.textContent = 'Not configured';
  else if (!s.linked) syncStatusLine.textContent = 'Configured — paste or generate a vault key';
  else if (s.status === 'error') syncStatusLine.textContent = 'Error: ' + (s.lastError || 'unknown');
  else if (s.status === 'syncing') syncStatusLine.textContent = 'Syncing…';
  else syncStatusLine.textContent = 'Synced';

  // Section visibility
  syncSetupSection.classList.toggle('hidden', s.configured);
  syncAuthSection.classList.toggle('hidden', !s.configured || s.linked);
  syncActiveSection.classList.toggle('hidden', !s.linked);

  if (s.configured && !s.linked) {
    // Pre-fill vault key with a freshly-generated one (or the last-typed value).
    if (!syncVaultKeyInput.value) syncVaultKeyInput.value = sync.generateVaultKey();
  }
  if (s.linked) {
    syncActiveKeyInput.value = s.vaultKey || '';
  }
}

if (syncStatusBtn) syncStatusBtn.addEventListener('click', openSyncSheet);
if (syncCloseBtn) syncCloseBtn.addEventListener('click', closeSyncSheet);
if (syncSheet) syncSheet.addEventListener('click', (e) => {
  if (e.target === syncSheet) closeSyncSheet();
});

if (syncSaveConfigBtn) {
  syncSaveConfigBtn.addEventListener('click', async () => {
    syncAuthError.classList.add('hidden');
    try {
      const cfg = sync.parseConfigInput(syncConfigInput.value);
      sync.saveConfig(cfg);
      askInfo('Config saved. Reloading…');
      setTimeout(() => location.reload(), 600);
    } catch (err) {
      syncAuthError.textContent = err.message || String(err);
      syncAuthError.classList.remove('hidden');
    }
  });
}

if (syncVaultCopyBtn) {
  syncVaultCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(syncVaultKeyInput.value);
      syncVaultCopyBtn.textContent = 'Copied!';
      setTimeout(() => syncVaultCopyBtn.textContent = 'Copy', 1200);
    } catch {
      syncVaultKeyInput.select();
    }
  });
}
if (syncVaultRegenBtn) {
  syncVaultRegenBtn.addEventListener('click', () => {
    syncVaultKeyInput.value = sync.generateVaultKey();
  });
}
if (syncVaultSaveBtn) {
  syncVaultSaveBtn.addEventListener('click', () => {
    syncAuthError.classList.add('hidden');
    try {
      sync.link(syncVaultKeyInput.value);
      updateSyncSheetUI();
    } catch (err) {
      syncAuthError.textContent = err.message || String(err);
      syncAuthError.classList.remove('hidden');
    }
  });
}
if (syncActiveCopyBtn) {
  syncActiveCopyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(syncActiveKeyInput.value);
      syncActiveCopyBtn.textContent = 'Copied!';
      setTimeout(() => syncActiveCopyBtn.textContent = 'Copy key', 1200);
    } catch {
      syncActiveKeyInput.select();
    }
  });
}

if (syncSignoutBtn) {
  syncSignoutBtn.addEventListener('click', () => {
    askConfirm('Unlink this device? Your local files stay, but new changes here will not sync until you re-enter the vault key.', () => {
      sync.unlink();
      updateSyncSheetUI();
    });
  });
}

function clearConfigAndReload() {
  askConfirm('Forget Firebase config on this device? Local files stay; cloud sync will be disabled.', () => {
    sync.clearAll();
    location.reload();
  });
}
if (syncClearConfigBtn) syncClearConfigBtn.addEventListener('click', clearConfigAndReload);
if (syncClearConfigBtn2) syncClearConfigBtn2.addEventListener('click', clearConfigAndReload);

// ─── Trash sheet ─────────────────────────────────────────
function openTrashSheet() {
  renderTrashIfOpen(/* force */ true);
  trashSheet.classList.remove('hidden');
}
function closeTrashSheet() {
  trashSheet.classList.add('hidden');
}

function renderTrashIfOpen(force = false) {
  if (!trashSheet) return;
  if (!force && trashSheet.classList.contains('hidden')) return;
  trashList.innerHTML = '';
  const deleted = deletedFiles();
  if (deleted.length === 0) {
    trashEmptyMsg.classList.remove('hidden');
    trashEmptyBtn.disabled = true;
    return;
  }
  trashEmptyMsg.classList.add('hidden');
  trashEmptyBtn.disabled = false;

  for (const f of deleted) {
    const row = document.createElement('div');
    row.className = 'trash-row';
    row.innerHTML = `
      <div class="trash-row-info">
        <div class="trash-row-name"></div>
        <div class="trash-row-meta"></div>
      </div>
      <button class="btn trash-restore">Restore</button>
      <button class="btn danger trash-purge">Delete</button>
    `;
    row.querySelector('.trash-row-name').textContent = f.name;
    const when = f.deletedAt ? new Date(f.deletedAt).toLocaleString() : '';
    row.querySelector('.trash-row-meta').textContent =
      `${(f.type || '').split('/').pop().toUpperCase()} • deleted ${when}`;

    row.querySelector('.trash-restore').addEventListener('click', async () => {
      f.deletedAt = null;
      f.updatedAt = Date.now();
      await dbPut(f);
      sync.pushRestore(f.id).catch(() => {});
      renderTrashIfOpen(true);
      render();
    });
    row.querySelector('.trash-purge').addEventListener('click', () => {
      askConfirm(`Permanently delete "${f.name}"? This removes it from every device.`, async () => {
        files = files.filter(x => x.id !== f.id);
        await dbDelete(f.id);
        sync.pushPurge(f.id).catch(err => console.warn('Cloud purge failed:', err));
        renderTrashIfOpen(true);
      });
    });
    trashList.appendChild(row);
  }
}

if (trashBtn) trashBtn.addEventListener('click', openTrashSheet);
if (trashCloseBtn) trashCloseBtn.addEventListener('click', closeTrashSheet);
if (trashSheet) trashSheet.addEventListener('click', (e) => {
  if (e.target === trashSheet) closeTrashSheet();
});
if (trashEmptyBtn) trashEmptyBtn.addEventListener('click', () => {
  const deleted = deletedFiles();
  if (!deleted.length) return;
  askConfirm(`Permanently delete ${deleted.length} file${deleted.length === 1 ? '' : 's'} from every device?`, async () => {
    for (const f of deleted) {
      files = files.filter(x => x.id !== f.id);
      await dbDelete(f.id);
      sync.pushPurge(f.id).catch(() => {});
    }
    renderTrashIfOpen(true);
  });
});

// Normalize legacy records loaded from IndexedDB (pre-sync schema).
function normalizeLoadedRecords() {
  for (const f of files) {
    if (typeof f.updatedAt !== 'number') f.updatedAt = f.addedAt || Date.now();
    if (typeof f.deletedAt === 'undefined') f.deletedAt = null;
    if (!f.syncState) f.syncState = 'pending-upload';
  }
}

// ─── Boot ────────────────────────────────────────────────
(async function init() {
  try {
    files = await dbAll();
  } catch (err) {
    console.error('Failed to open database:', err);
    files = [];
  }
  normalizeLoadedRecords();
  loadOrder();
  render();
  ensurePersistence();

  // Initialize sync last so initial render is instant.
  await sync.init();
  updateSyncIndicator(sync.state);
  updateSyncSheetUI();
})();
