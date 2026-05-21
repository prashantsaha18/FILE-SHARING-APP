/* ════════════════════════════════════════════════════════
   app.js – FileVault SPA Controller
   ════════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────
const state = {
  token: localStorage.getItem('fv_token') || null,
  user: null,
  currentPath: '',
  files: [],
  shares: [],
  viewMode: 'grid', // 'grid' | 'list'
  ctxTarget: null,  // file item currently in context menu
  renameTarget: null,
  shareTarget: null,
  shareToken: null, // for public share page
};

const API = '/api';

// ─── Utility ────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes)/Math.log(k));
  return (bytes/Math.pow(k,i)).toFixed(1)+' '+sizes[i];
}

function timeAgo(iso) {
  const d = new Date(iso), now = Date.now(), s = Math.floor((now - d)/1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

function toast(msg, duration=2800) {
  const t = el('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.add('hidden'), duration);
}

async function apiFetch(path, opts={}) {
  const headers = { 'Content-Type':'application/json', ...(opts.headers||{}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  if (opts.body instanceof FormData) delete headers['Content-Type'];
  const res = await fetch(API + path, { ...opts, headers });
  return res;
}

// ─── File type icons ──────────────────────────────────────
function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    // Images
    jpg:'🖼️',jpeg:'🖼️',png:'🖼️',gif:'🖼️',webp:'🖼️',svg:'🖼️',ico:'🖼️',bmp:'🖼️',
    // Video
    mp4:'🎬',mkv:'🎬',avi:'🎬',mov:'🎬',webm:'🎬',
    // Audio
    mp3:'🎵',wav:'🎵',flac:'🎵',ogg:'🎵',m4a:'🎵',
    // Documents
    pdf:'📄',doc:'📝',docx:'📝',xls:'📊',xlsx:'📊',ppt:'📊',pptx:'📊',
    txt:'📃',md:'📃',csv:'📊',
    // Code
    js:'⚙️',ts:'⚙️',py:'🐍',java:'☕',c:'⚙️',cpp:'⚙️',
    html:'🌐',css:'🎨',json:'🔧',xml:'🔧',yml:'🔧',yaml:'🔧',
    sh:'💻',bat:'💻',ps1:'💻',
    // Archives
    zip:'📦',rar:'📦',tar:'📦',gz:'📦','7z':'📦',
    // Misc
    exe:'⚡',msi:'⚡',dmg:'⚡',iso:'💿',
  };
  return map[ext] || '📄';
}

// ─── Auth ────────────────────────────────────────────────
function switchAuthTab(tab) {
  el('tab-login').classList.toggle('active', tab==='login');
  el('tab-register').classList.toggle('active', tab==='register');
  el('login-form').classList.toggle('hidden', tab!=='login');
  el('register-form').classList.toggle('hidden', tab!=='register');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = el('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  el('login-error').textContent = '';
  try {
    const res = await fetch('/api/auth/login', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ username: el('login-username').value, password: el('login-password').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('fv_token', data.token);
    initApp();
  } catch(err) {
    el('login-error').textContent = err.message;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i data-lucide="log-in"></i> Sign In'; lucide.createIcons();
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = el('reg-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  el('reg-error').textContent = '';
  try {
    const res = await fetch('/api/auth/register', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        username: el('reg-username').value,
        email: el('reg-email').value,
        password: el('reg-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem('fv_token', data.token);
    initApp();
  } catch(err) {
    el('reg-error').textContent = err.message;
  } finally {
    btn.disabled = false; btn.innerHTML = '<i data-lucide="user-plus"></i> Create Account'; lucide.createIcons();
  }
}

function handleLogout() {
  state.token = null; state.user = null;
  localStorage.removeItem('fv_token');
  el('app').classList.add('hidden');
  el('auth-overlay').classList.remove('hidden');
}

// ─── App Init ────────────────────────────────────────────
async function initApp() {
  // Check if this is a public share page
  const shareMatch = location.pathname.match(/^\/share\/([^/]+)$/);
  if (shareMatch) {
    state.shareToken = shareMatch[1];
    el('auth-overlay').classList.add('hidden');
    el('app').classList.add('hidden');
    await loadSharePage(state.shareToken);
    return;
  }

  if (!state.token) {
    el('auth-overlay').classList.remove('hidden');
    el('public-share-page').classList.add('hidden');
    lucide.createIcons();
    return;
  }

  try {
    const res = await apiFetch('/auth/me');
    if (!res.ok) throw new Error('Not authenticated');
    state.user = await res.json();
  } catch {
    handleLogout(); return;
  }

  el('auth-overlay').classList.add('hidden');
  el('app').classList.remove('hidden');
  el('public-share-page').classList.add('hidden');

  // Populate sidebar
  el('sidebar-username').textContent = state.user.username;
  el('sidebar-role').textContent = state.user.role;
  el('user-avatar-letter').textContent = state.user.username[0].toUpperCase();
  updateStorageBar();

  // Show admin nav if admin
  if (state.user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(e => e.classList.remove('hidden'));
  }

  setupDragDrop();
  loadFiles();
  lucide.createIcons();
}

function updateStorageBar() {
  const used = state.user.usedSpace || 0;
  const quota = state.user.quota || 1073741824;
  const pct = Math.min(100, (used/quota)*100).toFixed(1);
  el('storage-fill').style.width = pct+'%';
  el('storage-text').textContent = `${formatBytes(used)} / ${formatBytes(quota)}`;
}

// ─── View Switching ──────────────────────────────────────
function switchView(view, e) {
  if (e) e.preventDefault();
  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const v = el('view-'+view);
  v.classList.remove('hidden'); v.classList.add('active');
  const nav = el('nav-'+view);
  if (nav) nav.classList.add('active');

  if (view === 'shares') loadShares();
  if (view === 'admin') refreshAdmin();
  lucide.createIcons();
}

// ─── File Explorer ───────────────────────────────────────
async function loadFiles(path = state.currentPath) {
  state.currentPath = path;
  renderBreadcrumb(path);

  try {
    const res = await apiFetch(`/files/list?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.files = data.items;
    renderFileGrid();
  } catch(err) {
    toast('Error loading files: '+err.message);
  }
}

function renderBreadcrumb(path) {
  const bc = el('breadcrumb');
  const parts = path.split('/').filter(Boolean);
  let html = `<span class="breadcrumb-item ${path===''?'current':''}" onclick="loadFiles('')">Home</span>`;
  let built = '';
  for (let i = 0; i < parts.length; i++) {
    built += (built ? '/' : '') + parts[i];
    const isCurrent = i === parts.length - 1;
    const p = built;
    html += `<span class="breadcrumb-sep">›</span>
      <span class="breadcrumb-item ${isCurrent?'current':''}" onclick="loadFiles('${p}')">${parts[i]}</span>`;
  }
  bc.innerHTML = html;
}

function renderFileGrid() {
  const grid = el('file-grid');
  const empty = el('empty-state');
  grid.className = 'file-grid' + (state.viewMode === 'list' ? ' list-view' : '');

  if (state.files.length === 0) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  if (state.viewMode === 'grid') {
    grid.innerHTML = state.files.map((f, i) => `
      <div class="file-card" data-idx="${i}"
        onclick="fileClick(${i})"
        oncontextmenu="showCtxMenu(event, ${i})">
        <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
        <span class="file-name">${f.name}</span>
        <span class="file-meta">${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
      </div>
    `).join('');
  } else {
    grid.innerHTML = state.files.map((f, i) => `
      <div class="file-card list-item" data-idx="${i}"
        onclick="fileClick(${i})"
        oncontextmenu="showCtxMenu(event, ${i})">
        <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
        <div class="file-info">
          <div class="file-name">${f.name}</div>
          <div class="file-meta">
            <span>${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
            ${f.modified ? `<span>${timeAgo(f.modified)}</span>` : ''}
          </div>
        </div>
      </div>
    `).join('');
  }
  lucide.createIcons();
}

function fileClick(idx) {
  const f = state.files[idx];
  if (f.isDirectory) {
    loadFiles(f.path);
  } else {
    // Download on click
    downloadFile(f.path);
  }
}

function toggleViewMode() {
  state.viewMode = state.viewMode === 'grid' ? 'list' : 'grid';
  el('view-toggle-icon').setAttribute('data-lucide', state.viewMode === 'grid' ? 'layout-grid' : 'list');
  renderFileGrid();
  lucide.createIcons();
}

function downloadFile(path) {
  // Use fetch with Authorization header for authenticated download
  fetchDownload(path);
}

async function fetchDownload(path) {
  const res = await apiFetch(`/files/download?path=${encodeURIComponent(path)}`);
  if (!res.ok) { toast('Download failed'); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = path.split('/').pop();
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Upload ──────────────────────────────────────────────
function triggerUpload() { el('file-input').click(); }

function handleFileInputChange(e) {
  const files = Array.from(e.target.files);
  if (files.length) uploadFiles(files);
  e.target.value = '';
}

async function uploadFiles(files) {
  const panel = el('upload-panel');
  const items = el('upload-panel-items');
  panel.classList.remove('hidden');
  items.innerHTML = '';

  // Create upload items in UI
  const itemEls = files.map((f, i) => {
    const div = document.createElement('div');
    div.className = 'upload-item';
    div.id = `ui-${i}`;
    div.innerHTML = `
      <div class="upload-item-name">${f.name}</div>
      <div class="upload-progress-bar"><div class="upload-progress-fill" id="up-fill-${i}" style="width:0%"></div></div>
      <div class="upload-item-status" id="up-status-${i}">Waiting…</div>
    `;
    items.appendChild(div);
    return div;
  });

  lucide.createIcons();

  // Upload all concurrently (max 3 at a time)
  const concurrency = 3;
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency);
    await Promise.all(batch.map((f, bi) => uploadSingleFile(f, i+bi)));
  }

  await loadFiles();
  const usedRes = await apiFetch('/auth/me');
  if (usedRes.ok) {
    state.user = await usedRes.json();
    updateStorageBar();
  }
  toast(`✓ ${files.length} file(s) uploaded`);
}

async function uploadSingleFile(file, idx) {
  const fillEl = el(`up-fill-${idx}`);
  const statusEl = el(`up-status-${idx}`);
  statusEl.textContent = 'Uploading…';

  // Simulate incremental progress (XHR would give real progress)
  let prog = 0;
  const progInterval = setInterval(() => {
    prog = Math.min(prog + Math.random() * 15, 85);
    if (fillEl) fillEl.style.width = prog + '%';
  }, 200);

  try {
    const formData = new FormData();
    formData.append('files', file);
    formData.append('path', state.currentPath);
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      headers: { Authorization: `Bearer ${state.token}` },
      body: formData,
    });
    clearInterval(progInterval);
    if (!res.ok) {
      const e = await res.json();
      throw new Error(e.error);
    }
    if (fillEl) fillEl.style.width = '100%';
    if (statusEl) { statusEl.textContent = '✓ Done'; statusEl.className = 'upload-item-status done'; }
  } catch (err) {
    clearInterval(progInterval);
    if (statusEl) { statusEl.textContent = '✗ ' + err.message; statusEl.className = 'upload-item-status error'; }
  }
}

// ─── Drag & Drop ─────────────────────────────────────────
function setupDragDrop() {
  const body = document.body;
  const dz = el('drop-zone');
  let dragCounter = 0;

  body.addEventListener('dragenter', e => {
    e.preventDefault();
    dragCounter++;
    dz.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; dz.classList.remove('drag-over'); }
  });
  body.addEventListener('dragover', e => e.preventDefault());
  body.addEventListener('drop', e => {
    e.preventDefault();
    dragCounter = 0;
    dz.classList.remove('drag-over');
    const files = Array.from(e.dataTransfer.files);
    if (files.length) uploadFiles(files);
  });
}

// ─── Folder Creation ─────────────────────────────────────
function openNewFolderDialog() {
  el('new-folder-name').value = '';
  openModal('modal-new-folder');
  setTimeout(() => el('new-folder-name').focus(), 100);
}

async function createNewFolder() {
  const name = el('new-folder-name').value.trim();
  if (!name) return;
  const folderPath = state.currentPath ? `${state.currentPath}/${name}` : name;
  try {
    const res = await apiFetch('/files/create-folder', {
      method: 'POST', body: JSON.stringify({ path: folderPath }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    closeModal('modal-new-folder');
    await loadFiles();
    toast('📁 Folder created');
  } catch(err) { toast('Error: '+err.message); }
}

// ─── Context Menu ─────────────────────────────────────────
function showCtxMenu(e, idx) {
  e.preventDefault();
  e.stopPropagation();
  state.ctxTarget = state.files[idx];
  const menu = el('ctx-menu');
  menu.classList.remove('hidden');
  // Position
  const x = Math.min(e.clientX, window.innerWidth - 180);
  const y = Math.min(e.clientY, window.innerHeight - 160);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';

  // Hide download/share for folders
  const isFile = !state.ctxTarget.isDirectory;
  el('ctx-download').style.display = isFile ? '' : 'none';
  el('ctx-share').style.display = isFile ? '' : 'none';
}

document.addEventListener('click', () => el('ctx-menu').classList.add('hidden'));

function ctxDownload() {
  if (state.ctxTarget) fetchDownload(state.ctxTarget.path);
}
function ctxShare() {
  if (state.ctxTarget) openShareModal(state.ctxTarget);
}
function ctxRename() {
  if (!state.ctxTarget) return;
  state.renameTarget = state.ctxTarget;
  el('rename-input').value = state.ctxTarget.name;
  openModal('modal-rename');
  setTimeout(() => el('rename-input').select(), 100);
}
async function ctxDelete() {
  const f = state.ctxTarget;
  if (!f) return;
  if (!confirm(`Delete "${f.name}"? This cannot be undone.`)) return;
  try {
    const res = await apiFetch(`/files/delete?path=${encodeURIComponent(f.path)}`, { method:'DELETE' });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const data = await res.json();
    state.user.usedSpace = data.usedSpace;
    updateStorageBar();
    await loadFiles();
    toast('🗑️ Deleted');
  } catch(err) { toast('Error: '+err.message); }
}

async function confirmRename() {
  const newName = el('rename-input').value.trim();
  if (!newName || !state.renameTarget) return;
  try {
    const res = await apiFetch('/files/rename', {
      method:'POST',
      body: JSON.stringify({ path: state.renameTarget.path, newName }),
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    closeModal('modal-rename');
    await loadFiles();
    toast('✏️ Renamed');
  } catch(err) { toast('Error: '+err.message); }
}

// ─── Share ───────────────────────────────────────────────
function openShareModal(file) {
  state.shareTarget = file;
  el('share-file-label').textContent = `File: ${file.name}`;
  el('share-expires').value = '';
  el('share-max-dl').value = '';
  el('share-password').value = '';
  openModal('modal-share');
}

async function createShareLink() {
  if (!state.shareTarget) return;
  const body = {
    path: state.shareTarget.path,
    expiresIn: el('share-expires').value || undefined,
    maxDownloads: el('share-max-dl').value || undefined,
    password: el('share-password').value || undefined,
  };
  try {
    const res = await apiFetch('/share/create', { method:'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeModal('modal-share');
    el('share-link-value').value = data.shareUrl;
    el('copy-confirm').classList.add('hidden');
    openModal('modal-share-result');
  } catch(err) { toast('Error: '+err.message); }
}

function copyShareLink() {
  const inp = el('share-link-value');
  inp.select();
  navigator.clipboard.writeText(inp.value).then(() => {
    el('copy-confirm').classList.remove('hidden');
    toast('✓ Link copied!');
  }).catch(() => { document.execCommand('copy'); });
}

// ─── Shares view ─────────────────────────────────────────
async function loadShares() {
  try {
    const res = await apiFetch('/share/list');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.shares = data;
    renderShares();
  } catch(err) { toast('Error: '+err.message); }
}

function renderShares() {
  const list = el('shares-list');
  const empty = el('shares-empty');
  if (!state.shares.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  const shareBase = `${location.protocol}//${location.host}/share/`;
  list.innerHTML = state.shares.map(s => `
    <div class="share-row">
      <span class="share-row-icon">${fileIcon(s.fileName, false)}</span>
      <div class="share-row-info">
        <div class="share-row-name">${s.fileName}</div>
        <div class="share-row-meta">
          ${s.expiresAt ? `<span class="share-tag">⏰ Expires ${timeAgo(s.expiresAt)}</span>` : '<span class="share-tag">No expiry</span>'}
          ${s.maxDownloads ? `<span class="share-tag">⬇️ ${s.downloadCount}/${s.maxDownloads}</span>` : `<span class="share-tag">⬇️ ${s.downloadCount}</span>`}
          ${s.password ? '<span class="share-tag">🔒 Password</span>' : ''}
        </div>
        <div class="share-link-copy" onclick="navigator.clipboard.writeText('${shareBase+s.token}').then(()=>toast('✓ Copied'))">
          ${shareBase+s.token}
        </div>
      </div>
      <div class="share-row-actions">
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${shareBase+s.token}').then(()=>toast('✓ Copied'))">
          <i data-lucide="copy"></i>
        </button>
        <button class="btn btn-danger" onclick="deleteShare('${s.token}')">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

async function deleteShare(token) {
  if (!confirm('Delete this share link?')) return;
  const res = await apiFetch(`/share/delete/${token}`, { method:'DELETE' });
  if (res.ok) { toast('🗑️ Share removed'); loadShares(); }
  else toast('Error deleting share');
}

// ─── Public Share Page ────────────────────────────────────
async function loadSharePage(token) {
  el('public-share-page').classList.remove('hidden');
  lucide.createIcons();
  try {
    const res = await fetch(`/api/share/info/${token}`);
    const data = await res.json();
    if (!res.ok) {
      el('share-dl-filename').textContent = 'Link Unavailable';
      el('share-dl-meta').textContent = data.error || 'This link is no longer valid.';
      el('share-dl-btn').disabled = true;
      return;
    }
    el('share-dl-filename').textContent = data.fileName;
    const meta = [`Shared by ${data.owner}`];
    if (data.expiresAt) meta.push(`Expires ${timeAgo(data.expiresAt)}`);
    if (data.maxDownloads) meta.push(`${data.downloadCount}/${data.maxDownloads} downloads`);
    el('share-dl-meta').textContent = meta.join(' · ');
    if (data.hasPassword) {
      el('share-dl-password-area').classList.remove('hidden');
    }
  } catch {
    el('share-dl-filename').textContent = 'Error';
    el('share-dl-meta').textContent = 'Could not load file info.';
    el('share-dl-btn').disabled = true;
  }
  lucide.createIcons();
}

async function downloadSharedFile() {
  const token = state.shareToken;
  const password = el('share-dl-password').value || undefined;
  el('share-dl-error').textContent = '';
  el('share-dl-btn').disabled = true;
  el('share-dl-btn').textContent = 'Downloading…';
  try {
    const res = await fetch(`/api/share/download/${token}`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const e = await res.json();
      el('share-dl-error').textContent = e.error;
      el('share-dl-btn').disabled = false;
      el('share-dl-btn').innerHTML = '<i data-lucide="download"></i> Download File';
      lucide.createIcons();
      return;
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    const nameMatch = cd.match(/filename="?([^"]+)"?/);
    const fileName = nameMatch ? decodeURIComponent(nameMatch[1]) : 'download';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  } catch(err) {
    el('share-dl-error').textContent = 'Download failed: '+err.message;
  } finally {
    el('share-dl-btn').disabled = false;
    el('share-dl-btn').innerHTML = '<i data-lucide="download"></i> Download File';
    lucide.createIcons();
  }
}

// ─── Admin Panel ─────────────────────────────────────────
async function refreshAdmin() {
  try {
    const [statsRes, usersRes, logsRes] = await Promise.all([
      apiFetch('/admin/system-stats'),
      apiFetch('/admin/users'),
      apiFetch('/admin/logs?limit=80'),
    ]);
    const stats = await statsRes.json();
    const users = await usersRes.json();
    const logs = await logsRes.json();

    // Stats cards
    el('stat-users').textContent = `${stats.users.active} / ${stats.users.total}`;
    el('stat-shares').textContent = stats.shares.total;
    const memPct = ((stats.memory.used/stats.memory.total)*100).toFixed(0);
    el('stat-mem').textContent = `${memPct}%`;
    el('stat-storage').textContent = formatBytes(stats.storage.used);

    // Users table
    const tbody = el('users-tbody');
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${u.username}</strong></td>
        <td><span class="role-badge ${u.role}">${u.role}</span></td>
        <td>
          <span class="status-badge ${u.status}">
            <span class="status-dot"></span>${u.status}
          </span>
        </td>
        <td>${formatBytes(u.usedSpace||0)}</td>
        <td>${formatBytes(u.quota||0)}</td>
        <td>${u.createdAt ? timeAgo(u.createdAt) : '—'}</td>
        <td>
          <div style="display:flex;gap:.35rem;flex-wrap:wrap">
            <button class="btn btn-ghost" style="padding:.3rem .6rem;font-size:.75rem"
              onclick="openQuotaModal('${u.username}', ${u.quota})">
              <i data-lucide="database"></i> Quota
            </button>
            ${u.username !== 'admin' ? `
            <button class="btn btn-ghost" style="padding:.3rem .6rem;font-size:.75rem"
              onclick="toggleUserStatus('${u.username}', '${u.status === 'active' ? 'suspended' : 'active'}')">
              <i data-lucide="${u.status === 'active' ? 'user-x' : 'user-check'}"></i>
              ${u.status === 'active' ? 'Suspend' : 'Activate'}
            </button>
            <button class="btn btn-danger" style="padding:.3rem .6rem;font-size:.75rem"
              onclick="deleteUser('${u.username}')">
              <i data-lucide="trash-2"></i>
            </button>` : ''}
          </div>
        </td>
      </tr>
    `).join('');

    // Logs
    const logConsole = el('log-console');
    const actionClass = a => {
      if (['delete','admin_delete_user'].includes(a)) return 'delete';
      if (['login','register'].includes(a)) return 'login';
      if (['upload'].includes(a)) return 'upload';
      if (['share_create'].includes(a)) return 'share_create';
      return '';
    };
    logConsole.innerHTML = logs.map(l => `
      <div class="log-entry">
        <span class="log-time">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
        <span class="log-action ${actionClass(l.action)}">&nbsp;${l.action}&nbsp;</span>
        <span>${l.username||l.by||''}</span>
        ${l.file ? `→ <span style="color:var(--text-secondary)">${l.file}</span>` : ''}
        ${l.ip ? `<span style="color:var(--text-muted);font-size:.7rem"> from ${l.ip}</span>` : ''}
      </div>
    `).join('');

    lucide.createIcons();
  } catch(err) {
    toast('Admin error: '+err.message);
  }
}

function openQuotaModal(username, currentQuota) {
  window._quotaTarget = username;
  el('quota-user-label').textContent = `Set quota for: ${username}`;
  const sel = el('quota-select');
  // Select closest option
  const opts = Array.from(sel.options);
  const closest = opts.reduce((a,b) => Math.abs(parseInt(b.value)-currentQuota) < Math.abs(parseInt(a.value)-currentQuota) ? b : a);
  sel.value = closest.value;
  openModal('modal-quota');
}

async function applyQuota() {
  const username = window._quotaTarget;
  const quota = el('quota-select').value;
  const res = await apiFetch(`/admin/users/${username}/quota`, {
    method:'PUT', body: JSON.stringify({ quota }),
  });
  if (res.ok) { closeModal('modal-quota'); toast(`✓ Quota updated`); refreshAdmin(); }
  else toast('Error updating quota');
}

async function toggleUserStatus(username, newStatus) {
  const res = await apiFetch(`/admin/users/${username}/status`, {
    method:'PUT', body: JSON.stringify({ status: newStatus }),
  });
  if (res.ok) { toast(`✓ ${username} ${newStatus}`); refreshAdmin(); }
  else toast('Error updating status');
}

async function deleteUser(username) {
  if (!confirm(`Permanently delete user "${username}"?`)) return;
  const res = await apiFetch(`/admin/users/${username}`, { method:'DELETE' });
  if (res.ok) { toast(`🗑️ User deleted`); refreshAdmin(); }
  else toast('Error deleting user');
}

// ─── Modal helpers ────────────────────────────────────────
function openModal(id) {
  el(id).classList.remove('hidden');
  lucide.createIcons();
}
function closeModal(id) {
  el(id).classList.add('hidden');
}

// Enter key shortcuts in modals
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    el('ctx-menu').classList.add('hidden');
  }
  if (e.key === 'Enter') {
    if (!el('modal-new-folder').classList.contains('hidden')) createNewFolder();
    if (!el('modal-rename').classList.contains('hidden')) confirmRename();
  }
});

// ─── Start ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initApp);
