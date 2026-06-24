/* Files — minimal local-file stash PWA.
   Stores JPG/PDF blobs in IndexedDB and shows large thumbnails. */

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
const viewer     = document.getElementById('viewer');
const viewerBody = document.getElementById('viewer-body');
const viewerName = document.getElementById('viewer-name');
const viewerClose  = document.getElementById('viewer-close');
const viewerDelete = document.getElementById('viewer-delete');
const confirmEl  = document.getElementById('confirm');
const confirmMsg = document.getElementById('confirm-msg');
const confirmOk  = document.getElementById('confirm-ok');
const confirmCancel = document.getElementById('confirm-cancel');

// ─── State ───────────────────────────────────────────────
// files: ordered array of { id, name, type, blob, addedAt }
let files = [];
let currentViewerId = null;
let currentViewerObjectUrl = null;

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
  localStorage.setItem(ORDER_KEY, JSON.stringify(ids));
  const byId = new Map(files.map(f => [f.id, f]));
  files = ids.map(id => byId.get(id)).filter(Boolean);
}

// ─── Rendering ───────────────────────────────────────────
function render() {
  grid.innerHTML = '';
  if (files.length === 0) {
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  for (const f of files) {
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
  startOrientationTracking();
  applyViewerRotation(currentRotation, true);
}

function closeViewer() {
  stopOrientationTracking();
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

// ─── Viewer rotation (phone tilt) ────────────────────────
// Tracks the physical orientation of the device and rotates the viewer
// content to match — handy when the OS has rotation lock enabled, so the
// page itself stays portrait but the image/PDF still appears upright.
let currentRotation = 0;          // applied rotation in degrees (0/90/180/270)
let orientationHandler = null;
let orientationResizeHandler = null;

function startOrientationTracking() {
  if (!('DeviceOrientationEvent' in window)) return;
  if (orientationHandler) return;

  orientationHandler = (e) => {
    if (e.beta == null || e.gamma == null) return;
    const target = deviceAngleFromTilt(e.beta, e.gamma);
    if (target == null) return;
    const screenAngle = (screen.orientation && screen.orientation.angle) || 0;
    const rot = ((target - screenAngle) % 360 + 360) % 360;
    applyViewerRotation(rot);
  };
  window.addEventListener('deviceorientation', orientationHandler);

  // Re-apply on viewport changes so the rotator's pre-rotation box still
  // matches the viewer body's current dimensions.
  orientationResizeHandler = () => applyViewerRotation(currentRotation, true);
  window.addEventListener('resize', orientationResizeHandler);
  if (screen.orientation && screen.orientation.addEventListener) {
    screen.orientation.addEventListener('change', orientationResizeHandler);
  }
}

function stopOrientationTracking() {
  if (orientationHandler) {
    window.removeEventListener('deviceorientation', orientationHandler);
    orientationHandler = null;
  }
  if (orientationResizeHandler) {
    window.removeEventListener('resize', orientationResizeHandler);
    if (screen.orientation && screen.orientation.removeEventListener) {
      screen.orientation.removeEventListener('change', orientationResizeHandler);
    }
    orientationResizeHandler = null;
  }
}

// Map device tilt (beta = front/back, gamma = left/right) to a snapped
// 0/90/180/270 angle, with hysteresis so we don't flicker between
// orientations at the boundaries.
function deviceAngleFromTilt(beta, gamma) {
  const inBand = (v, target, half) => Math.abs(v - target) <= half;
  const current = currentRotation;
  // Use a wider band to stay in the current orientation, narrower to flip.
  const keep = 55, flip = 45;
  const candidates = [
    { angle:   0, ok: gamma >  -keep && gamma <  keep && beta >  20 },
    { angle:  90, ok: gamma >   flip },
    { angle: 270, ok: gamma <  -flip },
    { angle: 180, ok: gamma >  -keep && gamma <  keep && beta < -20 },
  ];
  // Prefer the current rotation if it's still valid.
  const sticky = candidates.find(c => c.angle === current && c.ok);
  if (sticky) return sticky.angle;
  const next = candidates.find(c => c.ok);
  return next ? next.angle : null;
}

function applyViewerRotation(deg, force = false) {
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

viewerClose.addEventListener('click', closeViewer);
viewerDelete.addEventListener('click', () => {
  if (!currentViewerId) return;
  const file = files.find(f => f.id === currentViewerId);
  if (!file) return;
  askConfirm(`Delete "${file.name}"?`, async () => {
    await dbDelete(file.id);
    files = files.filter(f => f.id !== file.id);
    saveOrder();
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

// ─── Boot ────────────────────────────────────────────────
(async function init() {
  try {
    files = await dbAll();
  } catch (err) {
    console.error('Failed to open database:', err);
    files = [];
  }
  loadOrder();
  render();
})();
