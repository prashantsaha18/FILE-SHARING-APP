/* ════════════════════════════════════════════════════════
   app.js – NexDrop SPA Controller
   ════════════════════════════════════════════════════════ */

'use strict';

// ─── State ──────────────────────────────────────────────
const state = {
  token:         localStorage.getItem('nd_token') || null,
  user:          null,
  currentPath:   '',
  files:         [],        // current directory listing
  filteredFiles: null,      // search results (null = not searching)
  shares:        [],
  viewMode:      'grid',    // 'grid' | 'list'
  sortBy:        'name',
  sortAsc:       true,
  lastSortBy:    'name',
  isSearching:   false,
  ctxTarget:     null,      // item currently in context menu
  renameTarget:  null,
  shareTarget:   null,
  moveTarget:    null,
  shareToken:    null,      // for public share page
  selectedDest:  '',        // destination path for move
  currentView:   'files',   // 'files' | 'shared' | 'trash' | 'analytics' | 'shares' | 'admin'
  currentOwner:  null,      // custom owner for collaboration workspace
  sharedWithMe:  [],        // files shared with me
  trash:         [],        // Recycle Bin list
};

const API = '/api';

// ─── Utility ────────────────────────────────────────────
function el(id) { return document.getElementById(id); }

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024, sizes = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function timeAgo(iso) {
  const d = new Date(iso), now = Date.now(), s = Math.floor((now - d) / 1000);
  if (s < 60)    return `${s}s ago`;
  if (s < 3600)  return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

// ─── Toast (supports types: success / error / warning / info) ──
function toast(msg, type = 'success', duration = 3000) {
  const t = el('toast');
  t.textContent = msg;
  t.className = `toast ${type}`;
  t.classList.remove('hidden');
  clearTimeout(t._to);
  t._to = setTimeout(() => t.classList.add('hidden'), duration);
}

async function apiFetch(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (state.token) headers['Authorization'] = `Bearer ${state.token}`;
  if (opts.body instanceof FormData) delete headers['Content-Type'];
  return fetch(API + path, { ...opts, headers });
}

// ─── File type icons ──────────────────────────────────────
function fileIcon(name, isDir) {
  if (isDir) return '📁';
  const ext = (name.split('.').pop() || '').toLowerCase();
  const map = {
    jpg:'🖼️', jpeg:'🖼️', png:'🖼️', gif:'🖼️', webp:'🖼️', svg:'🖼️', ico:'🖼️', bmp:'🖼️',
    mp4:'🎬', mkv:'🎬', avi:'🎬', mov:'🎬', webm:'🎬',
    mp3:'🎵', wav:'🎵', flac:'🎵', ogg:'🎵', m4a:'🎵',
    pdf:'📄', doc:'📝', docx:'📝', xls:'📊', xlsx:'📊', ppt:'📊', pptx:'📊',
    txt:'📃', md:'📃', csv:'📊',
    js:'⚙️', ts:'⚙️', py:'🐍', java:'☕', c:'⚙️', cpp:'⚙️',
    html:'🌐', css:'🎨', json:'🔧', xml:'🔧', yml:'🔧', yaml:'🔧',
    sh:'💻', bat:'💻', ps1:'💻', log:'📋',
    zip:'📦', rar:'📦', tar:'📦', gz:'📦', '7z':'📦',
    exe:'⚡', msi:'⚡', dmg:'⚡', iso:'💿',
  };
  return map[ext] || '📄';
}

// ─── Previewable extensions ──────────────────────────────
const PREVIEWABLE = new Set([
  'jpg','jpeg','png','gif','webp','svg','bmp',
  'mp4','webm','mov',
  'mp3','wav','flac','m4a','ogg',
  'txt','md','js','ts','py','html','css','json','xml',
  'csv','sh','bat','log','yaml','yml',
]);

function isPreviewable(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  return PREVIEWABLE.has(ext);
}

// ─── Get currently displayed file list ─────────────────
function getCurrentFiles() {
  return state.isSearching && state.filteredFiles ? state.filteredFiles : state.files;
}

// ─── Skeleton Loaders ───────────────────────────────────
function showSkeletons(count = 10) {
  const grid  = el('file-grid');
  const empty = el('empty-state');
  empty.classList.add('hidden');
  const isList = state.viewMode === 'list';
  grid.className = 'file-grid' + (isList ? ' list-view' : '');
  grid.innerHTML = Array.from({ length: count }, () => `
    <div class="skeleton-card${isList ? ' list-item' : ''}">
      <div class="skeleton-block skeleton-icon"></div>
      ${isList
        ? '<div style="flex:1;display:flex;flex-direction:column;gap:.4rem"><div class="skeleton-block skeleton-name"></div><div class="skeleton-block skeleton-meta"></div></div>'
        : '<div class="skeleton-block skeleton-name"></div><div class="skeleton-block skeleton-meta"></div>'
      }
    </div>
  `).join('');
}

// ─── Auth ────────────────────────────────────────────────
function switchAuthTab(tab) {
  el('tab-login').classList.toggle('active', tab === 'login');
  el('tab-register').classList.toggle('active', tab === 'register');
  el('login-form').classList.toggle('hidden', tab !== 'login');
  el('register-form').classList.toggle('hidden', tab !== 'register');
}

async function handleLogin(e) {
  e.preventDefault();
  const btn = el('login-btn');
  btn.disabled = true; btn.textContent = 'Signing in…';
  el('login-error').textContent = '';
  try {
    const res  = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: el('login-username').value, password: el('login-password').value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('nd_token', data.token);
    initApp();
  } catch (err) {
    el('login-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="log-in"></i> Sign In';
    lucide.createIcons();
  }
}

async function handleRegister(e) {
  e.preventDefault();
  const btn = el('reg-btn');
  btn.disabled = true; btn.textContent = 'Creating…';
  el('reg-error').textContent = '';
  try {
    const res  = await fetch('/api/auth/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: el('reg-username').value,
        email:    el('reg-email').value,
        password: el('reg-password').value,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Registration failed');
    state.token = data.token;
    state.user  = data.user;
    localStorage.setItem('nd_token', data.token);
    initApp();
  } catch (err) {
    el('reg-error').textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i data-lucide="user-plus"></i> Create Account';
    lucide.createIcons();
  }
}

function handleLogout() {
  state.token = null; state.user = null;
  localStorage.removeItem('nd_token');
  el('app').classList.add('hidden');
  el('auth-overlay').classList.remove('hidden');
  lucide.createIcons();
}

// ─── App Init ────────────────────────────────────────────
async function initApp() {
  // Public share page
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

  // Sidebar
  el('sidebar-username').textContent = state.user.username;
  el('sidebar-role').textContent     = state.user.role;
  el('user-avatar-letter').textContent = state.user.username[0].toUpperCase();
  updateStorageBar();

  // Dynamic WebDAV URL binding
  if (el('webdav-url-display')) {
    el('webdav-url-display').textContent = `${location.protocol}//${location.host}/webdav`;
  }

  // Admin nav
  if (state.user.role === 'admin') {
    document.querySelectorAll('.admin-only').forEach(e => e.classList.remove('hidden'));
  }

  // FAB visible on mobile
  el('fab-upload').classList.remove('hidden');

  setupDragDrop();
  loadFiles();
  lucide.createIcons();
}

function updateStorageBar() {
  const used  = state.user.usedSpace || 0;
  const quota = state.user.quota || 1073741824;
  const pct   = Math.min(100, (used / quota) * 100).toFixed(1);
  el('storage-fill').style.width = pct + '%';
  el('storage-text').textContent = `${formatBytes(used)} / ${formatBytes(quota)}`;
}

// ─── Mobile Sidebar Toggle ───────────────────────────────
function toggleSidebar() {
  el('sidebar').classList.toggle('open');
  el('sidebar-overlay').classList.toggle('visible');
}

// ─── View Switching ──────────────────────────────────────
function switchView(view, e) {
  if (e) e.preventDefault();
  // Close sidebar on mobile after navigation
  el('sidebar').classList.remove('open');
  el('sidebar-overlay').classList.remove('visible');

  document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const v   = el('view-' + view);
  v.classList.remove('hidden'); v.classList.add('active');
  const nav = el('nav-' + view);
  if (nav) nav.classList.add('active');

  state.currentView = view;

  if (view === 'files') {
    state.currentOwner = null;
    loadFiles('');
  }
  if (view === 'shares') loadShares();
  if (view === 'shared') loadSharedWithMe();
  if (view === 'trash')  loadTrash();
  if (view === 'analytics') refreshAnalytics();
  if (view === 'admin')  refreshAdmin();
  if (view === 'webdav') loadProtocolsView();
  if (view === 'backups') refreshBackupsView();
  lucide.createIcons();
}

// ─── File Explorer ───────────────────────────────────────
async function loadFiles(path = state.currentPath) {
  state.currentPath   = path;
  state.isSearching   = false;
  state.filteredFiles = null;
  if (el('search-input')) { el('search-input').value = ''; el('search-clear').classList.add('hidden'); }
  renderBreadcrumb(path);
  showSkeletons();

  try {
    const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
    const res  = await apiFetch(`/files/list?path=${encodeURIComponent(path)}${ownerQuery}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.files = data.items;
    applySortToCurrentList();
    renderFileGrid();
  } catch (err) {
    toast('Error loading files: ' + err.message, 'error');
  }
}

function renderBreadcrumb(path) {
  const bc    = el('breadcrumb');
  if (state.currentView === 'shared' || state.currentOwner) {
    bc.innerHTML = `<span class="breadcrumb-item current">${state.currentOwner ? `Shared Drive: ${state.currentOwner}` : 'Workspace'}</span>`;
    return;
  }
  const parts = path.split('/').filter(Boolean);
  let html = `<span class="breadcrumb-item ${path === '' ? 'current' : ''}" onclick="loadFiles('')">Home</span>`;
  let built = '';
  for (let i = 0; i < parts.length; i++) {
    built += (built ? '/' : '') + parts[i];
    const isCurrent = i === parts.length - 1;
    const p = built;
    html += `<span class="breadcrumb-sep">›</span>
      <span class="breadcrumb-item ${isCurrent ? 'current' : ''}" onclick="loadFiles('${p}')">${parts[i]}</span>`;
  }
  bc.innerHTML = html;
}

function renderFileCard(f, i, isSearch = false) {
  const pathHint = isSearch && f.path.includes('/') 
    ? `<div class="search-path-hint">📁 /${f.path.split('/').slice(0,-1).join('/')}/</div>` 
    : '';

  const lockBadge = f.lock
    ? `<span class="lock-badge"><i data-lucide="lock"></i> ${escapeHtml(f.lock.lockedBy)}</span>`
    : '';

  if (state.viewMode === 'grid') {
    return `
      <div class="file-card" data-idx="${i}"
        onclick="fileClick(${i})"
        oncontextmenu="showCtxMenu(event, ${i})">
        ${lockBadge}
        <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
        <span class="file-name">${escapeHtml(f.name)}</span>
        <span class="file-meta">${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
        ${pathHint}
      </div>`;
  } else {
    return `
      <div class="file-card list-item" data-idx="${i}"
        onclick="fileClick(${i})"
        oncontextmenu="showCtxMenu(event, ${i})">
        <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
        <div class="file-info">
          <div class="file-name">${escapeHtml(f.name)}${f.lock ? ` <span style="color:var(--amber);font-size:.75em;">🔒</span>` : ''}</div>
          <div class="file-meta">
            <span>${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
            ${f.modified ? `<span>${timeAgo(f.modified)}</span>` : ''}
            ${f.lock ? `<span style="color:var(--amber);">Locked by ${escapeHtml(f.lock.lockedBy)}</span>` : ''}
            ${isSearch && f.path.includes('/') ? `<span>📁 /${f.path.split('/').slice(0,-1).join('/')}/</span>` : ''}
          </div>
        </div>
      </div>`;
  }
}

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderFileGrid() {
  const grid  = el('file-grid');
  const empty = el('empty-state');
  const list  = getCurrentFiles();
  grid.className = 'file-grid' + (state.viewMode === 'list' ? ' list-view' : '');

  // File count
  const lbl = el('file-count-label');
  if (lbl) lbl.textContent = list.length ? `${list.length} item${list.length !== 1 ? 's' : ''}` : '';

  if (!list.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    if (state.isSearching) {
      empty.querySelector('p').textContent = 'No files match your search';
    } else {
      empty.querySelector('p').textContent = 'This folder is empty';
    }
    return;
  }
  empty.classList.add('hidden');
  grid.innerHTML = list.map((f, i) => renderFileCard(f, i, state.isSearching)).join('');
  lucide.createIcons();
}

function fileClick(idx) {
  let f;
  if (state.currentView === 'shared') {
    f = state.sharedWithMe[idx];
    if (f && f.isDirectory) {
      state.currentOwner = f.owner;
      state.currentView = 'files';
      loadFiles(f.path);
      return;
    }
  } else if (state.currentView === 'trash') {
    f = state.trash[idx];
    return;
  } else {
    f = getCurrentFiles()[idx];
  }
  if (!f) return;
  if (f.isDirectory) {
    loadFiles(f.path);
  } else if (isPreviewable(f.name)) {
    previewFile(f);
  } else {
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
  const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
  fetchDownload(path + ownerQuery); 
}

async function fetchDownload(path) {
  try {
    const res = await apiFetch(`/files/download?path=${encodeURIComponent(path)}`);
    if (!res.ok) { toast('Download failed', 'error'); return; }
    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = path.split('/').pop();
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch {
    toast('Download failed', 'error');
  }
}

// ─── Search ──────────────────────────────────────────────
let _searchTimer;
function handleSearch(e) {
  const q = e.target.value.trim();
  el('search-clear').classList.toggle('hidden', !q);
  clearTimeout(_searchTimer);

  if (!q) {
    state.isSearching   = false;
    state.filteredFiles = null;
    renderFileGrid();
    return;
  }

  state.isSearching = true;
  showSkeletons(5);

  _searchTimer = setTimeout(async () => {
    try {
      const res  = await apiFetch(`/files/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      state.filteredFiles = data;
      applySortToCurrentList();
      renderFileGrid();
    } catch (err) {
      toast('Search error: ' + err.message, 'error');
    }
  }, 350);
}

function clearSearch() {
  el('search-input').value = '';
  el('search-clear').classList.add('hidden');
  state.isSearching   = false;
  state.filteredFiles = null;
  renderFileGrid();
}

// ─── Sort ────────────────────────────────────────────────
function applySortToCurrentList() {
  const list = state.isSearching ? state.filteredFiles : state.files;
  if (!list) return;
  list.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    let av, bv;
    if      (state.sortBy === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
    else if (state.sortBy === 'size') { av = a.size || 0;          bv = b.size || 0; }
    else if (state.sortBy === 'date') { av = a.modified || '';      bv = b.modified || ''; }
    if (av < bv) return state.sortAsc ? -1 : 1;
    if (av > bv) return state.sortAsc ? 1 : -1;
    return 0;
  });
}

function sortFiles(by) {
  state.sortAsc   = state.lastSortBy === by ? !state.sortAsc : true;
  state.sortBy    = by;
  state.lastSortBy = by;

  document.querySelectorAll('.sort-btn').forEach(b => {
    const isActive = b.dataset.sort === by;
    b.classList.toggle('active', isActive);
    const icon = b.querySelector('svg');
    if (icon && isActive) {
      icon.setAttribute('data-lucide', state.sortAsc ? 'chevron-up' : 'chevron-down');
      lucide.createIcons();
    }
  });

  applySortToCurrentList();
  renderFileGrid();
}

// ─── File Preview ────────────────────────────────────────
let _editorTimer = null;
let _editorActiveFile = null;

function previewFile(file) {
  const ext = (file.ext || (file.name.split('.').pop() || '')).toLowerCase();
  el('preview-filename').textContent = file.name;
  
  const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
  el('preview-download-btn').onclick = () => fetchDownload(file.path + ownerQuery);

  const body = el('preview-body');
  body.innerHTML = '<div class="preview-loading"><i data-lucide="loader-2" class="spin-icon"></i> Loading preview…</div>';
  lucide.createIcons();

  // Reset editor status
  el('preview-edit-btn').style.display = 'none';
  el('preview-save-btn').style.display = 'none';
  el('editor-save-status').classList.add('hidden');
  _editorActiveFile = null;

  openModal('modal-preview');

  const isImage = ['jpg','jpeg','png','gif','webp','svg','bmp'].includes(ext);
  const isVideo = ['mp4','webm','mov'].includes(ext);
  const isAudio = ['mp3','wav','flac','m4a','ogg'].includes(ext);
  const isText  = ['txt','md','js','ts','py','html','css','json','xml','csv','sh','bat','log','yaml','yml'].includes(ext);

  if (isImage) {
    fetchPreviewBlob(file.path).then(url => {
      if (!url) return;
      body.innerHTML = '';
      const img = document.createElement('img');
      img.src = url; img.alt = file.name;
      body.appendChild(img);
    });
  } else if (isVideo) {
    fetchPreviewBlob(file.path).then(url => {
      if (!url) return;
      body.innerHTML = '';
      const vid = document.createElement('video');
      vid.controls = true; vid.src = url;
      body.appendChild(vid);
    });
  } else if (isAudio) {
    fetchPreviewBlob(file.path).then(url => {
      if (!url) return;
      body.innerHTML = '';
      const aud = document.createElement('audio');
      aud.controls = true; aud.src = url;
      body.appendChild(aud);
    });
  } else if (isText) {
    _editorActiveFile = file;
    
    // Check write permissions
    let canWrite = false;
    if (!state.currentOwner || state.currentOwner === state.user.username) {
      canWrite = true;
    } else if (state.currentView === 'shared' || state.currentOwner) {
      const matching = state.sharedWithMe.find(s => s.owner === state.currentOwner && s.path === file.path);
      if (matching && matching.accessLevel === 'write') canWrite = true;
    }
    
    if (canWrite) {
      el('preview-edit-btn').style.display = '';
      el('preview-edit-btn').onclick = () => startInlineEditing(file);
    }

    fetchPreviewText(file.path).then(text => {
      body.innerHTML = '';
      const pre = document.createElement('div');
      pre.id = 'editor-static-view';
      pre.className = 'preview-text-content';
      pre.textContent = text.length > 60000 ? text.slice(0, 60000) + '\n\n… (truncated for preview)' : text;
      body.appendChild(pre);
    });
  } else {
    body.innerHTML = `
      <div class="preview-unsupported">
        <span class="preview-big-icon">${fileIcon(file.name, false)}</span>
        <p style="font-size:1rem;font-weight:600;margin-bottom:.5rem">${escapeHtml(file.name)}</p>
        <p>Preview not available for .${ext} files</p>
        <button class="btn btn-primary" style="margin-top:1rem" onclick="fetchDownload('${file.path + ownerQuery}')">
          <i data-lucide="download"></i> Download Instead
        </button>
      </div>`;
    lucide.createIcons();
  }
}

function startInlineEditing(file) {
  const body = el('preview-body');
  const staticView = el('editor-static-view');
  if (!staticView) return;
  
  const text = staticView.textContent;
  body.innerHTML = `
    <textarea id="editor-textarea" class="editor-textarea" style="width:100%;height:100%;min-height:360px;background:rgba(0,0,0,0.25);color:#f1f5f9;border:1px solid var(--border-color);border-radius:6px;padding:.75rem;font-family:'Courier New', monospace;font-size:.9rem;resize:none;outline:none;" oninput="editorInputHandler()">${text}</textarea>
  `;
  
  el('preview-edit-btn').style.display = 'none';
  el('preview-save-btn').style.display = '';
  
  setTimeout(() => el('editor-textarea').focus(), 100);
}

function editorInputHandler() {
  const status = el('editor-save-status');
  status.textContent = 'Saving...';
  status.classList.remove('hidden');
  
  clearTimeout(_editorTimer);
  _editorTimer = setTimeout(() => {
    triggerFileSave(true);
  }, 1500);
}

async function triggerFileSave(isAutosave = false) {
  if (!_editorActiveFile) return;
  const ta = el('editor-textarea');
  if (!ta) return;
  
  const content = ta.value;
  const status = el('editor-save-status');
  status.textContent = 'Saving...';
  status.classList.remove('hidden');
  
  try {
    const res = await apiFetch('/files/save', {
      method: 'PUT',
      body: JSON.stringify({
        path: _editorActiveFile.path,
        content,
        owner: state.currentOwner || undefined
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    status.textContent = '✓ Saved';
    setTimeout(() => {
      if (status.textContent === '✓ Saved') status.classList.add('hidden');
    }, 2000);
    
    if (!isAutosave) {
      toast('✓ File saved successfully', 'success');
    }
  } catch (err) {
    status.textContent = '✗ Save failed';
    toast('Error saving file: ' + err.message, 'error');
  }
}

async function fetchPreviewBlob(path) {
  try {
    const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
    const res = await apiFetch(`/files/download?path=${encodeURIComponent(path)}${ownerQuery}`);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  } catch { return null; }
}

async function fetchPreviewText(path) {
  try {
    const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
    const res = await apiFetch(`/files/download?path=${encodeURIComponent(path)}${ownerQuery}`);
    if (!res.ok) return 'Failed to load file content.';
    return await res.text();
  } catch { return 'Error loading file.'; }
}

function closePreviewOnOverlay(e) {
  if (e.target === el('modal-preview')) closeModal('modal-preview');
}

// ─── Move File ───────────────────────────────────────────
function openMoveModal(file) {
  state.moveTarget   = file;
  state.selectedDest = '';
  el('move-file-label').textContent = `Moving: ${file.name}`;
  loadFolderPicker('');
  openModal('modal-move');
}

async function loadFolderPicker(path) {
  const picker = el('folder-picker');
  picker.innerHTML = '<div class="folder-picker-empty">Loading folders…</div>';

  try {
    const res  = await apiFetch(`/files/list?path=${encodeURIComponent(path)}`);
    const data = await res.json();
    const folders = (data.items || []).filter(f => f.isDirectory && f.path !== state.moveTarget?.path);

    const items = [];
    // Always offer root option
    items.push({ name: '🏠 Root (Home)', path: '', isRoot: true });
    folders.forEach(f => items.push(f));

    if (items.length === 1 && !folders.length) {
      picker.innerHTML = '<div class="folder-picker-empty">No subfolders available</div>';
    } else {
      picker.innerHTML = items.map(f => `
        <div class="folder-picker-item" data-path="${f.path}" onclick="selectMoveDest('${f.path}', this)">
          <span class="folder-icon">📁</span>
          <span>${escapeHtml(f.name)}</span>
        </div>`).join('');
    }
  } catch {
    picker.innerHTML = '<div class="folder-picker-empty">Error loading folders</div>';
  }
}

function selectMoveDest(path, elem) {
  document.querySelectorAll('.folder-picker-item').forEach(i => i.classList.remove('selected'));
  elem.classList.add('selected');
  state.selectedDest = path;
}

async function confirmMove() {
  if (!state.moveTarget) return;
  try {
    const res = await apiFetch('/files/move', {
      method: 'POST',
      body: JSON.stringify({ src: state.moveTarget.path, destDir: state.selectedDest }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeModal('modal-move');
    await loadFiles();
    toast(`✓ Moved "${state.moveTarget.name}"`, 'success');
  } catch (err) {
    toast('Move failed: ' + err.message, 'error');
  }
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

  files.forEach((f, i) => {
    const div = document.createElement('div');
    div.className = 'upload-item';
    div.id = `ui-${i}`;
    div.innerHTML = `
      <div class="upload-item-name">${escapeHtml(f.name)}</div>
      <div class="upload-progress-bar"><div class="upload-progress-fill" id="up-fill-${i}" style="width:0%"></div></div>
      <div class="upload-item-status" id="up-status-${i}">Waiting…</div>`;
    items.appendChild(div);
  });

  // Upload with concurrency = 3
  for (let i = 0; i < files.length; i += 3) {
    const batch = files.slice(i, i + 3);
    await Promise.all(batch.map((f, bi) => uploadSingleFile(f, i + bi)));
  }

  await loadFiles();
  const userRes = await apiFetch('/auth/me');
  if (userRes.ok) { state.user = await userRes.json(); updateStorageBar(); }
  toast(`✓ ${files.length} file${files.length !== 1 ? 's' : ''} uploaded`, 'success');
}

// Real upload progress via XHR
function uploadSingleFile(file, idx) {
  const fillEl   = el(`up-fill-${idx}`);
  const statusEl = el(`up-status-${idx}`);
  if (statusEl) statusEl.textContent = 'Uploading…';

  return new Promise(resolve => {
    const xhr      = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('files', file);
    formData.append('path', state.currentPath);

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable && fillEl)
        fillEl.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    });

    xhr.addEventListener('load', () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        if (fillEl)   fillEl.style.width = '100%';
        if (statusEl) { statusEl.textContent = '✓ Done'; statusEl.className = 'upload-item-status done'; }
      } else {
        let msg = 'Upload failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch {}
        if (statusEl) { statusEl.textContent = '✗ ' + msg; statusEl.className = 'upload-item-status error'; }
      }
      resolve();
    });

    xhr.addEventListener('error', () => {
      if (statusEl) { statusEl.textContent = '✗ Network error'; statusEl.className = 'upload-item-status error'; }
      resolve();
    });

    xhr.open('POST', '/api/files/upload');
    xhr.setRequestHeader('Authorization', `Bearer ${state.token}`);
    xhr.send(formData);
  });
}

// ─── Drag & Drop ─────────────────────────────────────────
function setupDragDrop() {
  const body = document.body;
  const dz   = el('drop-zone');
  let dragCounter = 0;

  body.addEventListener('dragenter', e => { e.preventDefault(); dragCounter++; dz.classList.add('drag-over'); });
  body.addEventListener('dragleave', () => { dragCounter--; if (dragCounter <= 0) { dragCounter = 0; dz.classList.remove('drag-over'); } });
  body.addEventListener('dragover', e => e.preventDefault());
  body.addEventListener('drop', e => {
    e.preventDefault(); dragCounter = 0; dz.classList.remove('drag-over');
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
    const res = await apiFetch('/files/create-folder', { method: 'POST', body: JSON.stringify({ path: folderPath }) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    closeModal('modal-new-folder');
    await loadFiles();
    toast('📁 Folder created', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ─── Context Menu ─────────────────────────────────────────
function showCtxMenu(e, idx) {
  e.preventDefault(); e.stopPropagation();
  let f;
  if (state.currentView === 'shared') {
    f = state.sharedWithMe[idx];
  } else if (state.currentView === 'trash') {
    f = state.trash[idx];
  } else {
    f = getCurrentFiles()[idx];
  }
  state.ctxTarget = f;

  // Remove previous active highlight
  document.querySelectorAll('.file-card.ctx-active').forEach(c => c.classList.remove('ctx-active'));
  e.currentTarget.classList.add('ctx-active');

  const menu = el('ctx-menu');
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth  - 190);
  const y = Math.min(e.clientY, window.innerHeight - 250);
  menu.style.left = x + 'px'; menu.style.top = y + 'px';

  const isFile = !f.isDirectory;

  if (state.currentView === 'trash') {
    el('ctx-preview').style.display  = 'none';
    el('ctx-download').style.display = 'none';
    el('ctx-share').style.display    = 'none';
    el('ctx-collaborate').style.display = 'none';
    el('ctx-div-1').style.display = 'none';
    el('ctx-rename').style.display   = 'none';
    el('ctx-move').style.display     = 'none';
    el('ctx-div-2').style.display = 'none';
    el('ctx-delete').style.display   = 'none';
    
    el('ctx-restore').style.display = '';
    el('ctx-purge').style.display   = '';
  } else if (state.currentView === 'shared') {
    el('ctx-preview').style.display  = isFile && isPreviewable(f.name) ? '' : 'none';
    el('ctx-download').style.display = isFile ? '' : 'none';
    el('ctx-share').style.display    = 'none';
    el('ctx-collaborate').style.display = 'none';
    el('ctx-div-1').style.display = 'none';
    el('ctx-rename').style.display   = 'none';
    el('ctx-move').style.display     = 'none';
    el('ctx-div-2').style.display = 'none';
    el('ctx-delete').style.display   = 'none';
    
    el('ctx-restore').style.display = 'none';
    el('ctx-purge').style.display   = 'none';
  } else {
    el('ctx-preview').style.display  = isFile && isPreviewable(f.name) ? '' : 'none';
    el('ctx-download').style.display = isFile ? '' : 'none';
    el('ctx-share').style.display    = isFile ? '' : 'none';
    el('ctx-collaborate').style.display = '';
    el('ctx-div-1').style.display = '';
    el('ctx-rename').style.display   = '';
    el('ctx-move').style.display     = '';
    el('ctx-div-2').style.display = '';
    el('ctx-delete').style.display   = '';

    // Lock / unlock items (files only, not shared view)
    if (el('ctx-lock')) {
      const isLocked = f.lock && f.lock.lockedBy === state.user?.username;
      const isLockedByOther = f.lock && f.lock.lockedBy !== state.user?.username;
      el('ctx-lock').style.display   = isFile && !f.lock ? '' : 'none';
      el('ctx-unlock').style.display = isFile && isLocked ? '' : 'none';
      el('ctx-div-lock').style.display = isFile ? '' : 'none';
    }
    
    el('ctx-restore').style.display = 'none';
    el('ctx-purge').style.display   = 'none';
  }

  lucide.createIcons();
}

document.addEventListener('click', () => {
  el('ctx-menu').classList.add('hidden');
  document.querySelectorAll('.file-card.ctx-active').forEach(c => c.classList.remove('ctx-active'));
});

function ctxPreview()  { if (state.ctxTarget) previewFile(state.ctxTarget); }
function ctxDownload() { 
  if (state.ctxTarget) {
    const ownerQuery = state.currentOwner ? `&owner=${encodeURIComponent(state.currentOwner)}` : '';
    fetchDownload(state.ctxTarget.path + ownerQuery);
  }
}
function ctxShare()    { if (state.ctxTarget) openShareModal(state.ctxTarget); }
function ctxMove()     { if (state.ctxTarget) openMoveModal(state.ctxTarget); }

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
  if (!confirm(`Move "${f.name}" to Recycle Bin?`)) return;
  try {
    const res  = await apiFetch('/files/trash', {
      method: 'POST',
      body: JSON.stringify({ path: f.path })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    const data = await res.json();
    state.user.usedSpace = data.usedSpace;
    updateStorageBar();
    await loadFiles();
    toast('🗑️ Moved to Recycle Bin', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

async function confirmRename() {
  const newName = el('rename-input').value.trim();
  if (!newName || !state.renameTarget) return;
  try {
    const res = await apiFetch('/files/rename', { method: 'POST', body: JSON.stringify({ path: state.renameTarget.path, newName }) });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    closeModal('modal-rename');
    await loadFiles();
    toast('✏️ Renamed successfully', 'success');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

// ─── Share ───────────────────────────────────────────────
function openShareModal(file) {
  state.shareTarget = file;
  el('share-file-label').textContent = `File: ${file.name}`;
  el('share-expires').value   = '';
  el('share-max-dl').value    = '';
  el('share-password').value  = '';
  openModal('modal-share');
}

async function createShareLink() {
  if (!state.shareTarget) return;
  const body = {
    path:         state.shareTarget.path,
    expiresIn:    el('share-expires').value    || undefined,
    maxDownloads: el('share-max-dl').value     || undefined,
    password:     el('share-password').value   || undefined,
  };
  try {
    const res  = await apiFetch('/share/create', { method: 'POST', body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    closeModal('modal-share');
    el('share-link-value').value = data.shareUrl;
    el('copy-confirm').classList.add('hidden');
    openModal('modal-share-result');
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

function copyShareLink() {
  const inp = el('share-link-value');
  inp.select();
  navigator.clipboard.writeText(inp.value).then(() => {
    el('copy-confirm').classList.remove('hidden');
    toast('✓ Link copied!', 'success');
  }).catch(() => { document.execCommand('copy'); });
}

// ─── Shares view ─────────────────────────────────────────
async function loadShares() {
  try {
    const res  = await apiFetch('/share/list');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.shares = data;
    renderShares();
  } catch (err) { toast('Error: ' + err.message, 'error'); }
}

function renderShares() {
  const list    = el('shares-list');
  const empty   = el('shares-empty');
  const shareBase = `${location.protocol}//${location.host}/share/`;

  if (!state.shares.length) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = state.shares.map(s => `
    <div class="share-row">
      <span class="share-row-icon">${fileIcon(s.fileName, false)}</span>
      <div class="share-row-info">
        <div class="share-row-name">${escapeHtml(s.fileName)}</div>
        <div class="share-row-meta">
          ${s.expiresAt ? `<span class="share-tag">⏰ Expires ${timeAgo(s.expiresAt)}</span>` : '<span class="share-tag">No expiry</span>'}
          ${s.maxDownloads ? `<span class="share-tag">⬇️ ${s.downloadCount}/${s.maxDownloads}</span>` : `<span class="share-tag">⬇️ ${s.downloadCount}</span>`}
          ${s.password ? '<span class="share-tag">🔒 Password</span>' : ''}
        </div>
        <div class="share-link-copy" onclick="navigator.clipboard.writeText('${shareBase + s.token}').then(()=>toast('✓ Copied', 'success'))">
          ${shareBase + s.token}
        </div>
      </div>
      <div class="share-row-actions">
        <button class="btn btn-ghost" onclick="navigator.clipboard.writeText('${shareBase + s.token}').then(()=>toast('✓ Copied', 'success'))">
          <i data-lucide="copy"></i>
        </button>
        <button class="btn btn-danger" onclick="deleteShare('${s.token}')">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>`).join('');
  lucide.createIcons();
}

async function deleteShare(token) {
  if (!confirm('Delete this share link?')) return;
  const res = await apiFetch(`/share/delete/${token}`, { method: 'DELETE' });
  if (res.ok) { toast('🗑️ Share removed', 'success'); loadShares(); }
  else toast('Error deleting share', 'error');
}

// ─── Public Share Page ────────────────────────────────────
async function loadSharePage(token) {
  el('public-share-page').classList.remove('hidden');
  lucide.createIcons();
  try {
    const res  = await fetch(`/api/share/info/${token}`);
    const data = await res.json();
    if (!res.ok) {
      el('share-dl-filename').textContent = 'Link Unavailable';
      el('share-dl-meta').textContent     = data.error || 'This link is no longer valid.';
      el('share-dl-btn').disabled = true;
      return;
    }
    el('share-dl-filename').textContent = data.fileName;
    const meta = [`Shared by ${data.owner}`];
    if (data.expiresAt)    meta.push(`Expires ${timeAgo(data.expiresAt)}`);
    if (data.maxDownloads) meta.push(`${data.downloadCount}/${data.maxDownloads} downloads`);
    el('share-dl-meta').textContent = meta.join(' · ');
    if (data.hasPassword) el('share-dl-password-area').classList.remove('hidden');
  } catch {
    el('share-dl-filename').textContent = 'Error';
    el('share-dl-meta').textContent     = 'Could not load file info.';
    el('share-dl-btn').disabled = true;
  }
  lucide.createIcons();
}

async function downloadSharedFile() {
  const token    = state.shareToken;
  const password = el('share-dl-password').value || undefined;
  el('share-dl-error').textContent = '';
  el('share-dl-btn').disabled      = true;
  el('share-dl-btn').textContent   = 'Downloading…';
  try {
    const res = await fetch(`/api/share/download/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) {
      const e = await res.json();
      el('share-dl-error').textContent = e.error;
      el('share-dl-btn').disabled = false;
      el('share-dl-btn').innerHTML = '<i data-lucide="download"></i> Download File';
      lucide.createIcons(); return;
    }
    const blob      = await res.blob();
    const cd        = res.headers.get('Content-Disposition') || '';
    const nameMatch = cd.match(/filename="?([^"]+)"?/);
    const fileName  = nameMatch ? decodeURIComponent(nameMatch[1]) : 'download';
    const url       = URL.createObjectURL(blob);
    const a         = document.createElement('a'); a.href = url; a.download = fileName; a.click();
    URL.revokeObjectURL(url);
  } catch (err) {
    el('share-dl-error').textContent = 'Download failed: ' + err.message;
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
    const logs  = await logsRes.json();

    el('stat-users').textContent   = `${stats.users.active} / ${stats.users.total}`;
    el('stat-shares').textContent  = stats.shares.total;
    const memPct = ((stats.memory.used / stats.memory.total) * 100).toFixed(0);
    el('stat-mem').textContent     = `${memPct}%`;
    el('stat-storage').textContent = formatBytes(stats.storage.used);

    el('users-tbody').innerHTML = users.map(u => `
      <tr>
        <td><strong>${escapeHtml(u.username)}</strong></td>
        <td><span class="role-badge ${u.role}">${u.role}</span></td>
        <td>
          <span class="status-badge ${u.status}">
            <span class="status-dot"></span>${u.status}
          </span>
        </td>
        <td>${formatBytes(u.usedSpace || 0)}</td>
        <td>${formatBytes(u.quota || 0)}</td>
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
      </tr>`).join('');

    const logConsole = el('log-console');
    const actionClass = a => {
      if (['delete','admin_delete_user'].includes(a)) return 'delete';
      if (['login','register'].includes(a))           return 'login';
      if (['upload'].includes(a))                     return 'upload';
      if (['share_create'].includes(a))               return 'share_create';
      return '';
    };
    logConsole.innerHTML = logs.map(l => `
      <div class="log-entry">
        <span class="log-time">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
        <span class="log-action ${actionClass(l.action)}">&nbsp;${l.action}&nbsp;</span>
        <span>${escapeHtml(l.username || l.by || '')}</span>
        ${l.file  ? `→ <span style="color:var(--text-secondary)">${escapeHtml(l.file)}</span>` : ''}
        ${l.ip    ? `<span style="color:var(--text-muted);font-size:.7rem"> from ${l.ip}</span>` : ''}
      </div>`).join('');

    lucide.createIcons();
  } catch (err) {
    toast('Admin error: ' + err.message, 'error');
  }
}

function openQuotaModal(username, currentQuota) {
  window._quotaTarget = username;
  el('quota-user-label').textContent = `Set quota for: ${username}`;
  const sel  = el('quota-select');
  const opts = Array.from(sel.options);
  const closest = opts.reduce((a, b) =>
    Math.abs(parseInt(b.value) - currentQuota) < Math.abs(parseInt(a.value) - currentQuota) ? b : a);
  sel.value = closest.value;
  openModal('modal-quota');
}

async function applyQuota() {
  const username = window._quotaTarget;
  const quota    = el('quota-select').value;
  const res      = await apiFetch(`/admin/users/${username}/quota`, { method: 'PUT', body: JSON.stringify({ quota }) });
  if (res.ok) { closeModal('modal-quota'); toast('✓ Quota updated', 'success'); refreshAdmin(); }
  else toast('Error updating quota', 'error');
}

async function toggleUserStatus(username, newStatus) {
  const res = await apiFetch(`/admin/users/${username}/status`, { method: 'PUT', body: JSON.stringify({ status: newStatus }) });
  if (res.ok) { toast(`✓ ${username} ${newStatus}`, 'success'); refreshAdmin(); }
  else toast('Error updating status', 'error');
}

async function deleteUser(username) {
  if (!confirm(`Permanently delete user "${username}"? All their files will be lost.`)) return;
  const res = await apiFetch(`/admin/users/${username}`, { method: 'DELETE' });
  if (res.ok) { toast('🗑️ User deleted', 'success'); refreshAdmin(); }
  else toast('Error deleting user', 'error');
}

// ─── Collaboration Workspace ─────────────────────────────
async function loadSharedWithMe() {
  showSkeletons();
  try {
    const res = await apiFetch('/share/shared-with-me');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.sharedWithMe = data;
    renderSharedGrid();
  } catch (err) {
    toast('Error loading shared files: ' + err.message, 'error');
  }
}

function renderSharedGrid() {
  const grid = el('shared-grid');
  const empty = el('shared-empty');
  grid.className = 'file-grid' + (state.viewMode === 'list' ? ' list-view' : '');
  
  if (!state.sharedWithMe.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  
  grid.innerHTML = state.sharedWithMe.map((f, i) => {
    const pathHint = `<div class="search-path-hint" style="color:var(--text-accent);">👤 Owned by ${f.owner} (${f.accessLevel === 'write' ? 'Editor' : 'Viewer'})</div>`;
    if (state.viewMode === 'grid') {
      return `
        <div class="file-card" data-idx="${i}" onclick="fileClick(${i})" oncontextmenu="showCtxMenu(event, ${i})">
          <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
          <span class="file-name">${escapeHtml(f.name)}</span>
          <span class="file-meta">${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
          ${pathHint}
        </div>`;
    } else {
      return `
        <div class="file-card list-item" data-idx="${i}" onclick="fileClick(${i})" oncontextmenu="showCtxMenu(event, ${i})">
          <span class="file-icon">${fileIcon(f.name, f.isDirectory)}</span>
          <div class="file-info">
            <div class="file-name">${escapeHtml(f.name)}</div>
            <div class="file-meta">
              <span>${f.isDirectory ? 'Folder' : formatBytes(f.size)}</span>
              <span>Owner: ${f.owner} (${f.accessLevel})</span>
            </div>
          </div>
        </div>`;
    }
  }).join('');
  lucide.createIcons();
}

function ctxCollaborate() {
  if (state.ctxTarget) openCollabModal(state.ctxTarget);
}

async function openCollabModal(file) {
  state.shareTarget = file;
  el('collab-file-label').textContent = `Sharing: ${file.name}`;
  el('collab-username').value = '';
  el('collab-access').value = 'read';
  
  el('collab-list-container').innerHTML = '<p style="font-size:.8rem;color:var(--text-muted);text-align:center;padding:1rem;">Loading accesses...</p>';
  openModal('modal-collaborate');
  
  await refreshCollabList();
}

async function refreshCollabList() {
  try {
    const res = await apiFetch(`/share/collaborators?path=${encodeURIComponent(state.shareTarget.path)}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    const container = el('collab-list-container');
    if (!data.length) {
      container.innerHTML = '<p style="font-size:.8rem;color:var(--text-muted);text-align:center;padding:.5rem;">No active collaborators yet.</p>';
      return;
    }
    
    container.innerHTML = data.map(c => `
      <div style="display:flex;align-items:center;justify-content:space-between;background:rgba(255,255,255,0.03);padding:.4rem .6rem;border-radius:4px;border:1px solid rgba(255,255,255,0.05);gap:.5rem;width:100%;">
        <span style="font-size:.85rem;color:var(--text-secondary);flex:1;">👤 <strong>${escapeHtml(c.collaborator)}</strong> (${c.accessLevel === 'write' ? 'Editor' : 'Viewer'})</span>
        <button class="btn btn-ghost" style="padding:.2rem .4rem;color:var(--text-danger);" onclick="revokeCollab('${c.collaborator}')" title="Revoke access">
          <i data-lucide="user-minus" style="width:14px;height:14px;"></i>
        </button>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    el('collab-list-container').innerHTML = `<p style="font-size:.8rem;color:var(--text-danger);text-align:center;padding:.5rem;">Error loading: ${escapeHtml(err.message)}</p>`;
  }
}

async function addCollabUser() {
  const collaborator = el('collab-username').value.trim();
  const accessLevel = el('collab-access').value;
  if (!collaborator) return;
  
  try {
    const res = await apiFetch('/share/collaborate', {
      method: 'POST',
      body: JSON.stringify({
        path: state.shareTarget.path,
        collaborator,
        accessLevel
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    toast(`✓ Shared with ${collaborator}`, 'success');
    el('collab-username').value = '';
    await refreshCollabList();
  } catch (err) {
    toast('Sharing failed: ' + err.message, 'error');
  }
}

async function revokeCollab(collaborator) {
  if (!confirm(`Revoke access for ${collaborator}?`)) return;
  try {
    const res = await apiFetch(`/share/collaborate`, {
      method: 'DELETE',
      body: JSON.stringify({
        path: state.shareTarget.path,
        collaborator
      })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    toast('✓ Access revoked', 'success');
    await refreshCollabList();
  } catch (err) {
    toast('Revoke failed: ' + err.message, 'error');
  }
}

// ─── Recycle Bin (Trash) ──────────────────────────────────
async function loadTrash() {
  showSkeletons();
  try {
    const res = await apiFetch('/files/trash');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    state.trash = data;
    renderTrashGrid();
  } catch (err) {
    toast('Error loading Recycle Bin: ' + err.message, 'error');
  }
}

function renderTrashGrid() {
  const grid = el('trash-grid');
  const empty = el('trash-empty');
  grid.className = 'file-grid' + (state.viewMode === 'list' ? ' list-view' : '');
  
  if (!state.trash.length) {
    grid.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  
  grid.innerHTML = state.trash.map((f, i) => {
    const filename = f.originalPath.split('/').pop();
    const pathHint = `<div class="search-path-hint" style="color:var(--text-muted);font-size:.7rem;">Deleted from: /${f.originalPath}</div>`;
    if (state.viewMode === 'grid') {
      return `
        <div class="file-card" data-idx="${i}" onclick="fileClick(${i})" oncontextmenu="showCtxMenu(event, ${i})">
          <span class="file-icon">🗑️</span>
          <span class="file-name">${escapeHtml(filename)}</span>
          <span class="file-meta">Deleted ${timeAgo(f.deletedAt)}</span>
          ${pathHint}
        </div>`;
    } else {
      return `
        <div class="file-card list-item" data-idx="${i}" onclick="fileClick(${i})" oncontextmenu="showCtxMenu(event, ${i})">
          <span class="file-icon">🗑️</span>
          <div class="file-info">
            <div class="file-name">${escapeHtml(filename)}</div>
            <div class="file-meta">
              <span>Deleted ${timeAgo(f.deletedAt)}</span>
              <span>Deleted from: /${f.originalPath}</span>
            </div>
          </div>
        </div>`;
    }
  }).join('');
  lucide.createIcons();
}

function ctxRestore() { if (state.ctxTarget) ctxRestoreTarget(state.ctxTarget); }
async function ctxRestoreTarget(target) {
  try {
    const res = await apiFetch('/files/trash/restore', {
      method: 'POST',
      body: JSON.stringify({ id: target.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    state.user.usedSpace = data.usedSpace;
    updateStorageBar();
    toast('✓ Item restored successfully', 'success');
    await loadTrash();
  } catch (err) { toast('Restore failed: ' + err.message, 'error'); }
}

function ctxPurge() { if (state.ctxTarget) ctxPurgeTarget(state.ctxTarget); }
async function ctxPurgeTarget(target) {
  const filename = target.originalPath.split('/').pop();
  if (!confirm(`Permanently delete "${filename}"? This action cannot be undone.`)) return;
  try {
    const res = await apiFetch(`/files/trash/delete`, {
      method: 'DELETE',
      body: JSON.stringify({ id: target.id })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    state.user.usedSpace = data.usedSpace;
    updateStorageBar();
    toast('🗑️ Permanently deleted', 'success');
    await loadTrash();
  } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
}

async function confirmEmptyTrash() {
  if (!confirm('Permanently delete all items in the Recycle Bin? This action cannot be undone.')) return;
  try {
    const res = await apiFetch('/files/trash/empty', { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    state.user.usedSpace = data.usedSpace;
    updateStorageBar();
    toast('🗑️ Recycle Bin emptied', 'success');
    await loadTrash();
  } catch (err) { toast('Error emptying trash: ' + err.message, 'error'); }
}

// ─── Analytics Summary ────────────────────────────────────
async function refreshAnalytics() {
  try {
    const res = await apiFetch('/analytics/summary');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    
    el('val-total-links').textContent = data.shares.totalLinks;
    el('val-total-downloads').textContent = data.shares.totalDownloads;
    el('val-collab-with-me').textContent = data.collaboration.sharedWithMe;
    el('val-collab-with-others').textContent = data.collaboration.sharedWithOthers;
    
    const pct = parseFloat(data.storage.pct);
    renderDonutChart('analytics-storage-chart-container', pct);
    el('analytics-storage-legend').textContent = `${formatBytes(data.storage.used)} used of ${formatBytes(data.storage.quota)}`;
    
    const logConsole = el('user-log-console');
    if (!data.logs.length) {
      logConsole.innerHTML = '<div style="font-size:.8rem;color:var(--text-muted);text-align:center;padding:1rem;">No recent activities logged.</div>';
      return;
    }
    
    const actionClass = a => {
      if (['delete','trash_move','trash_purge'].includes(a)) return 'delete';
      if (['login','register'].includes(a))           return 'login';
      if (['upload'].includes(a))                     return 'upload';
      if (['share_create','share_collaborate'].includes(a)) return 'share_create';
      return '';
    };
    
    logConsole.innerHTML = data.logs.map(l => `
      <div class="log-entry">
        <span class="log-time">[${new Date(l.timestamp).toLocaleTimeString()}]</span>
        <span class="log-action ${actionClass(l.action)}">&nbsp;${l.action}&nbsp;</span>
        <span>${escapeHtml(l.username || l.by || '')}</span>
        ${l.file ? `→ <span style="color:var(--text-secondary)">${escapeHtml(l.file)}</span>` : ''}
        ${l.target ? ` to user <span style="color:var(--text-secondary)">${escapeHtml(l.target)}</span>` : ''}
      </div>`).join('');
      
    lucide.createIcons();
  } catch (err) {
    toast('Analytics error: ' + err.message, 'error');
  }
}

function renderDonutChart(containerId, pct) {
  const container = el(containerId);
  if (!container) return;
  
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (pct / 100) * circumference;
  
  container.innerHTML = `
    <svg width="100%" height="100%" viewBox="0 0 100 100" style="transform: rotate(-90deg);">
      <circle cx="50" cy="50" r="${radius}" fill="transparent" stroke="rgba(255,255,255,0.06)" stroke-width="10" />
      <circle cx="50" cy="50" r="${radius}" fill="transparent" stroke="url(#donut-grad)" stroke-width="10" 
        stroke-dasharray="${circumference}" stroke-dashoffset="${strokeDashoffset}" stroke-linecap="round" />
      <defs>
        <linearGradient id="donut-grad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#6366f1" />
          <stop offset="100%" stop-color="#a855f7" />
        </linearGradient>
      </defs>
    </svg>
    <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);font-family:'Outfit';font-weight:700;font-size:1.1rem;color:var(--text-main);">${pct}%</div>
  `;
  container.style.position = 'relative';
}

// ─── Modal helpers ────────────────────────────────────────
function openModal(id) {
  el(id).classList.remove('hidden');
  lucide.createIcons();
}
function closeModal(id) {
  el(id).classList.add('hidden');
}

// Keyboard shortcuts
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(m => m.classList.add('hidden'));
    el('ctx-menu').classList.add('hidden');
    document.querySelectorAll('.file-card.ctx-active').forEach(c => c.classList.remove('ctx-active'));
  }
  if (e.key === 'Enter') {
    if (!el('modal-new-folder').classList.contains('hidden')) createNewFolder();
    if (!el('modal-rename').classList.contains('hidden'))     confirmRename();
  }
  if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    el('search-input')?.focus();
  }
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    if (!el('modal-preview').classList.contains('hidden') && el('editor-textarea')) {
      e.preventDefault();
      triggerFileSave();
    }
  }
});

// ─── WebDAV UI Handlers ───────────────────────────────────
function copyWebDAVUrl() {
  const display = el('webdav-url-display');
  if (!display) return;
  
  navigator.clipboard.writeText(display.textContent).then(() => {
    toast('✓ WebDAV URL copied to clipboard!', 'success');
  }).catch(() => {
    // Fallback if navigator.clipboard is not available
    const tempInput = document.createElement('input');
    tempInput.value = display.textContent;
    document.body.appendChild(tempInput);
    tempInput.select();
    document.execCommand('copy');
    document.body.removeChild(tempInput);
    toast('✓ WebDAV URL copied to clipboard!', 'success');
  });
}

function switchMountInstructions(os) {
  const winBtn = el('btn-mount-win');
  const macBtn = el('btn-mount-mac');
  const linuxBtn = el('btn-mount-linux');
  
  const winInst = el('instructions-win');
  const macInst = el('instructions-mac');
  const linuxInst = el('instructions-linux');
  
  if (winBtn) winBtn.classList.toggle('active', os === 'win');
  if (macBtn) macBtn.classList.toggle('active', os === 'mac');
  if (linuxBtn) linuxBtn.classList.toggle('active', os === 'linux');
  
  if (winInst) winInst.classList.toggle('hidden', os !== 'win');
  if (macInst) macInst.classList.toggle('hidden', os !== 'mac');
  if (linuxInst) linuxInst.classList.toggle('hidden', os !== 'linux');
}

// ─── Start ────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', initApp);

// ═══════════════════════════════════════════════════════════
// FILE LOCK CONTROLLERS
// ═══════════════════════════════════════════════════════════

async function ctxLockFile() {
  const f = state.ctxTarget;
  if (!f) return;
  try {
    const res = await apiFetch('/files/lock', { method: 'POST', body: JSON.stringify({ path: f.path }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`🔒 File locked: ${f.name}`, 'success');
    loadFiles(state.currentPath);
  } catch (err) {
    toast('Lock failed: ' + err.message, 'error');
  }
}

async function ctxUnlockFile() {
  const f = state.ctxTarget;
  if (!f) return;
  try {
    const res = await apiFetch('/files/unlock', { method: 'POST', body: JSON.stringify({ path: f.path }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`🔓 File unlocked: ${f.name}`, 'success');
    loadFiles(state.currentPath);
  } catch (err) {
    toast('Unlock failed: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// PROTOCOL TABS CONTROLLER
// ═══════════════════════════════════════════════════════════

async function loadProtocolsView() {
  // Refresh SMB and NFS data when switching to File Protocols view
  await Promise.all([loadSMBShares(), loadNFSExports(), loadHostConfigs()]);
}

function switchProtocolTab(tab) {
  ['webdav', 'smb', 'nfs'].forEach(t => {
    const btn = el(`ptab-${t}`);
    const panel = el(`proto-panel-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
    if (panel) panel.classList.toggle('hidden', t !== tab);
  });
  lucide.createIcons();
}

// ═══════════════════════════════════════════════════════════
// SMB SHARES CONTROLLER
// ═══════════════════════════════════════════════════════════

async function loadSMBShares() {
  try {
    const res = await apiFetch('/smb/shares');
    const shares = await res.json();
    renderSMBShares(shares);
  } catch (err) {
    console.error('SMB load error:', err);
  }
}

function renderSMBShares(shares) {
  const list = el('smb-list');
  if (!list) return;
  if (!shares.length) {
    list.innerHTML = `<div class="proto-list-empty"><i data-lucide="monitor"></i><p>No SMB shares configured yet</p></div>`;
    lucide.createIcons();
    return;
  }
  list.innerHTML = shares.map(s => `
    <div class="proto-item">
      <div class="proto-item-icon"><i data-lucide="monitor"></i></div>
      <div class="proto-item-info">
        <div class="proto-item-name">\\\\server\\${escapeHtml(s.shareName)}</div>
        <div class="proto-item-meta">
          <span>Path: <code>${escapeHtml(s.filePath)}</code></span>
          <span class="proto-badge ${s.accessLevel === 'rw' ? 'badge-green' : 'badge-blue'}">${s.accessLevel.toUpperCase()}</span>
          ${s.guestOk ? '<span class="proto-badge badge-amber">Guest OK</span>' : ''}
          ${s.comment ? `<span>${escapeHtml(s.comment)}</span>` : ''}
          <span class="proto-badge ${s.active ? 'badge-green' : 'badge-red'}">${s.active ? 'Active' : 'Disabled'}</span>
        </div>
      </div>
      <div class="proto-item-actions">
        <button class="btn-icon" title="${s.active ? 'Disable' : 'Enable'}" onclick="toggleSMBShare('${s.id}', ${!s.active})"
          style="color: ${s.active ? 'var(--green)' : 'var(--text-muted)'};">
          <i data-lucide="${s.active ? 'toggle-right' : 'toggle-left'}"></i>
        </button>
        <button class="btn-icon" title="Delete" onclick="deleteSMBShare('${s.id}')" style="color:var(--red);">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

async function createSMBShare() {
  const path = el('smb-path')?.value.trim();
  const name = el('smb-name')?.value.trim();
  const comment = el('smb-comment')?.value.trim();
  const access = el('smb-access')?.value;
  const guest = el('smb-guest')?.checked;

  if (!path || !name) { toast('Share name and path required', 'error'); return; }

  try {
    const res = await apiFetch('/smb/shares', {
      method: 'POST',
      body: JSON.stringify({ filePath: path, shareName: name, comment, accessLevel: access, guestOk: guest }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('✓ SMB share created', 'success');
    el('smb-path').value = ''; el('smb-name').value = ''; el('smb-comment').value = '';
    await loadSMBShares();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function toggleSMBShare(id, active) {
  try {
    const res = await apiFetch(`/smb/shares/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    if (!res.ok) throw new Error((await res.json()).error);
    await loadSMBShares();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function deleteSMBShare(id) {
  if (!confirm('Delete this SMB share?')) return;
  try {
    const res = await apiFetch(`/smb/shares/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    toast('SMB share deleted', 'success');
    await loadSMBShares();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// NFS EXPORTS CONTROLLER
// ═══════════════════════════════════════════════════════════

async function loadNFSExports() {
  try {
    const res = await apiFetch('/nfs/exports');
    const exports = await res.json();
    renderNFSExports(exports);
  } catch (err) {
    console.error('NFS load error:', err);
  }
}

function renderNFSExports(exports) {
  const list = el('nfs-list');
  const fileView = el('nfs-exports-file');
  const countBadge = el('nfs-export-count');

  if (countBadge) countBadge.textContent = `${exports.length} export${exports.length !== 1 ? 's' : ''}`;

  // Render /etc/exports-style file
  if (fileView) {
    if (!exports.length) {
      fileView.textContent = '# No exports configured';
    } else {
      fileView.textContent = exports.map(e =>
        `${escapeHtml(e.filePath)}   ${escapeHtml(e.allowedIPs)}(${e.accessLevel},${e.squash},no_subtree_check)`
      ).join('\n');
    }
  }

  if (!list) return;
  if (!exports.length) {
    list.innerHTML = `<div class="proto-list-empty"><i data-lucide="server"></i><p>No NFS exports configured yet</p></div>`;
    lucide.createIcons();
    return;
  }

  list.innerHTML = exports.map(e => `
    <div class="proto-item">
      <div class="proto-item-icon"><i data-lucide="server"></i></div>
      <div class="proto-item-info">
        <div class="proto-item-name"><code>${escapeHtml(e.filePath)}</code></div>
        <div class="proto-item-meta">
          <span>IPs: <code>${escapeHtml(e.allowedIPs)}</code></span>
          <span class="proto-badge ${e.accessLevel === 'rw' ? 'badge-green' : 'badge-blue'}">${e.accessLevel.toUpperCase()}</span>
          <span class="proto-badge badge-purple">${escapeHtml(e.squash)}</span>
          <span class="proto-badge ${e.active ? 'badge-green' : 'badge-red'}">${e.active ? 'Active' : 'Disabled'}</span>
        </div>
      </div>
      <div class="proto-item-actions">
        <button class="btn-icon" title="${e.active ? 'Disable' : 'Enable'}" onclick="toggleNFSExport('${e.id}', ${!e.active})"
          style="color: ${e.active ? 'var(--green)' : 'var(--text-muted)'};">
          <i data-lucide="${e.active ? 'toggle-right' : 'toggle-left'}"></i>
        </button>
        <button class="btn-icon" title="Delete" onclick="deleteNFSExport('${e.id}')" style="color:var(--red);">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();
}

async function createNFSExport() {
  const path = el('nfs-path')?.value.trim();
  const ips = el('nfs-ips')?.value.trim();
  const access = el('nfs-access')?.value;
  const squash = el('nfs-squash')?.value;

  if (!path) { toast('Export path required', 'error'); return; }

  try {
    const res = await apiFetch('/nfs/exports', {
      method: 'POST',
      body: JSON.stringify({ filePath: path, allowedIPs: ips || '*', accessLevel: access, squash }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast('✓ NFS export created', 'success');
    el('nfs-path').value = ''; el('nfs-ips').value = '';
    await loadNFSExports();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function toggleNFSExport(id, active) {
  try {
    const res = await apiFetch(`/nfs/exports/${id}`, { method: 'PUT', body: JSON.stringify({ active }) });
    if (!res.ok) throw new Error((await res.json()).error);
    await loadNFSExports();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function deleteNFSExport(id) {
  if (!confirm('Delete this NFS export?')) return;
  try {
    const res = await apiFetch(`/nfs/exports/${id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json()).error);
    toast('NFS export deleted', 'success');
    await loadNFSExports();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// BACKUPS & SECURITY DASHBOARD CONTROLLER
// ═══════════════════════════════════════════════════════════

function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h uptime`;
  if (h > 0) return `${h}h ${m}m uptime`;
  return `${m}m uptime`;
}

async function refreshBackupsView() {
  await Promise.all([loadSecurityAudit(), loadBackupsList()]);
}

async function loadSecurityAudit() {
  try {
    const res = await apiFetch('/admin/security/audit');
    if (!res.ok) return;
    const data = await res.json();

    // Fetch customized rules and backup settings to populate input fields
    try {
      const rRes = await apiFetch('/admin/security/rules');
      if (rRes.ok) {
        const rData = await rRes.json();
        const velInput = el('sec-rule-velocity');
        const winInput = el('sec-rule-window');
        const extsInput = el('sec-rule-exts');
        if (velInput) velInput.value = rData.velocity;
        if (winInput) winInput.value = rData.window;
        if (extsInput) extsInput.value = Array.isArray(rData.exts) ? rData.exts.join(', ') : rData.exts;
      }
      
      const bRes = await apiFetch('/admin/backups/settings');
      if (bRes.ok) {
        const bData = await bRes.json();
        const intInput = el('backup-auto-interval');
        const retInput = el('backup-auto-retention');
        if (intInput) intInput.value = bData.interval;
        if (retInput) retInput.value = bData.retention;
      }
    } catch (_) {}

    // Score ring animation
    const ring = el('score-ring-fill');
    const numEl = el('sec-score-number');
    const titleEl = el('sec-score-title');
    const descEl = el('sec-score-desc');
    const platformEl = el('sec-platform');
    const uptimeEl = el('sec-uptime');

    if (numEl) numEl.textContent = data.score;
    if (ring) {
      const circumference = 326.73;
      const offset = circumference - (data.score / 100) * circumference;
      ring.style.strokeDashoffset = offset;
      // Color the ring based on score
      ring.style.stroke = data.score >= 80 ? 'var(--green)' : data.score >= 50 ? 'var(--amber)' : 'var(--red)';
    }
    if (numEl) numEl.style.color = data.score >= 80 ? 'var(--green)' : data.score >= 50 ? 'var(--amber)' : 'var(--red)';
    if (titleEl) titleEl.textContent = data.score >= 80 ? '✅ Security Score' : data.score >= 50 ? '⚠️ Security Score' : '🚨 Security Score';
    if (descEl) descEl.textContent = data.score >= 80 ? 'Your server has a strong security posture.' : data.score >= 50 ? 'Some security improvements are recommended.' : 'Critical security issues detected. Immediate action required.';
    if (platformEl) platformEl.innerHTML = `<i data-lucide="server"></i> ${data.platform}`;
    if (uptimeEl) uptimeEl.innerHTML = `<i data-lucide="clock"></i> ${formatUptime(data.uptime)}`;

    // Security checklist
    const checklist = el('security-checklist');
    if (checklist) {
      checklist.innerHTML = data.checks.map(c => `
        <div class="audit-check">
          <span class="audit-icon ${c.pass ? 'pass' : 'fail'}">
            <i data-lucide="${c.pass ? 'check-circle' : 'x-circle'}"></i>
          </span>
          <span class="audit-label">${escapeHtml(c.label)}</span>
          <span class="audit-weight">+${c.weight}pts</span>
        </div>
      `).join('');
    }

    // Ransomware shield status
    const shieldToggle = el('shield-toggle');
    const shieldText = el('shield-status-text');
    const shieldWrap = el('shield-icon-wrap');
    if (shieldToggle) shieldToggle.checked = data.shieldEnabled;
    if (shieldText) shieldText.textContent = data.shieldEnabled ? '🛡️ ACTIVE — Monitoring in real-time' : '⚠️ DISABLED — Ransomware protection is off';
    if (shieldWrap) shieldWrap.classList.toggle('danger', !data.shieldEnabled);

    // Quarantine console
    const quarantineCount = el('quarantine-count');
    if (quarantineCount) quarantineCount.textContent = `${data.quarantined} quarantined`;

    const quarantineList = el('quarantine-list');
    if (quarantineList) {
      if (!data.quarantined) {
        quarantineList.innerHTML = `<div class="proto-list-empty" style="border-style:solid;"><i data-lucide="shield-check"></i><p>No quarantined accounts — all clear!</p></div>`;
      } else {
        // Fetch full user list to show quarantine details
        try {
          const uRes = await apiFetch('/admin/users');
          const uData = await uRes.json();
          const suspended = (uData.users || []).filter(u => u.status === 'suspended');
          quarantineList.innerHTML = suspended.map(u => `
            <div class="quarantine-row">
              <div class="user-avatar" style="flex-shrink:0;">${u.username[0].toUpperCase()}</div>
              <div class="quarantine-row-info">
                <div class="quarantine-row-name">${escapeHtml(u.username)}</div>
                <div class="quarantine-row-reason">Account suspended by Ransomware Shield</div>
              </div>
              <button class="btn btn-ghost" onclick="releaseQuarantine('${escapeHtml(u.username)}')">
                <i data-lucide="unlock"></i> Release
              </button>
            </div>
          `).join('');
        } catch (_) {}
      }
    }

    lucide.createIcons();
  } catch (err) {
    console.error('Security audit error:', err);
  }
}

async function toggleRansomwareShield(enabled) {
  try {
    const res = await apiFetch('/admin/security/settings', {
      method: 'POST',
      body: JSON.stringify({ ransomwareShield: enabled }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    toast(enabled ? '🛡️ Ransomware Shield ENABLED' : '⚠️ Ransomware Shield disabled', enabled ? 'success' : 'warning');
    await loadSecurityAudit();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

async function releaseQuarantine(username) {
  if (!confirm(`Release quarantine for "${username}"? Their account will be reactivated.`)) return;
  try {
    const res = await apiFetch(`/admin/security/release-quarantine/${encodeURIComponent(username)}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json()).error);
    toast(`✓ ${username} released from quarantine`, 'success');
    await loadSecurityAudit();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════
// BACKUP MANAGEMENT CONTROLLER
// ═══════════════════════════════════════════════════════════

async function loadBackupsList() {
  const list = el('backups-list');
  if (!list) return;
  try {
    const res = await apiFetch('/admin/backups');
    const backups = await res.json();
    if (!backups.length) {
      list.innerHTML = `<div class="proto-list-empty"><i data-lucide="hard-drive"></i><p>No backups yet. Create your first backup now.</p></div>`;
      lucide.createIcons();
      return;
    }
    list.innerHTML = backups.map(b => `
      <div class="backup-row">
        <div class="backup-icon"><i data-lucide="archive"></i></div>
        <div class="backup-info">
          <div class="backup-name">${escapeHtml(b.name)}</div>
          <div class="backup-meta">${formatBytes(b.size)} &bull; Created ${timeAgo(b.createdAt)}</div>
        </div>
        <div class="backup-actions">
          <a href="/api/admin/backups/download/${encodeURIComponent(b.name)}"
            class="btn btn-ghost" style="font-size:.8rem;padding:.4rem .8rem;"
            download title="Download backup">
            <i data-lucide="download"></i>
          </a>
          <button class="btn btn-danger" style="font-size:.8rem;padding:.4rem .8rem;"
            onclick="deleteSystemBackup('${escapeHtml(b.name)}')" title="Delete backup">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </div>
    `).join('');
    lucide.createIcons();
  } catch (err) {
    list.innerHTML = `<div class="proto-list-empty"><i data-lucide="alert-triangle"></i><p>Failed to load backups</p></div>`;
    lucide.createIcons();
  }
}

async function createSystemBackup() {
  const btn = el('create-backup-btn');
  if (btn) { btn.classList.add('loading'); btn.textContent = 'Creating backup…'; }
  try {
    const res = await apiFetch('/admin/backups/create', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    toast(`✓ Backup created: ${data.name} (${formatBytes(data.size)})`, 'success');
    await loadBackupsList();
    await loadSecurityAudit();
  } catch (err) {
    toast('Backup failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.classList.remove('loading'); btn.innerHTML = '<i data-lucide="download-cloud"></i> Create Backup Now'; lucide.createIcons(); }
  }
}

async function deleteSystemBackup(filename) {
  if (!confirm(`Delete backup "${filename}"? This cannot be undone.`)) return;
  try {
    const res = await apiFetch('/admin/backups/delete', {
      method: 'DELETE',
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) throw new Error((await res.json()).error);
    toast('Backup deleted', 'success');
    await loadBackupsList();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
  }
}
