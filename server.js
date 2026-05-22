/**
 * server.js - Main Express application server
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const path = require('path');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const fm = require('./fileManager');
const { generateToken, requireAuth, requireAdmin } = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Multer: memory storage for cross-platform safety
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB per file
});

// ─── Helper ──────────────────────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

// ─── Auth Routes ─────────────────────────────────────────────────────────────

// POST /api/auth/register
app.post('/api/auth/register', async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters' });
    }
    if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      username,
      password: hash,
      email: email || '',
      role: 'user',
      createdAt: new Date().toISOString(),
      quota: 1073741824, // 1 GB default
      usedSpace: 0,
      status: 'active',
    };
    await db.createUser(user);
    await fm.ensureUserHome(username);
    await db.addLog({ action: 'register', username, ip: req.ip });

    const token = generateToken(user);
    res.status(201).json({ token, user: { username, email: user.email, role: user.role, quota: user.quota } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(401).json({ error: 'Invalid credentials' });

    await db.addLog({ action: 'login', username, ip: req.ip });
    const usedSpace = await fm.getUserUsedSpace(username);
    await db.updateUser(username, { usedSpace });

    const token = generateToken(user);
    res.json({
      token,
      user: { username, email: user.email, role: user.role, quota: user.quota, usedSpace },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// GET /api/auth/me
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const usedSpace = await fm.getUserUsedSpace(req.user.username);
  await db.updateUser(req.user.username, { usedSpace });
  const { password: _, ...safeUser } = req.user;
  res.json({ ...safeUser, usedSpace });
});

// ─── File Routes ─────────────────────────────────────────────────────────────

// GET /api/files/list?path=...
app.get('/api/files/list', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const items = await fm.listDirectory(req.user.username, relPath);
    res.json({ path: relPath, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/upload
app.post('/api/files/upload', requireAuth, upload.array('files', 50), async (req, res) => {
  try {
    const relDir = req.body.path || '';
    const results = [];

    for (const file of req.files) {
      const saved = await fm.saveUploadedFile(req.user.username, relDir, file);
      results.push(saved);
    }

    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'upload', username: req.user.username, files: results.map(f => f.name), path: relDir });

    res.json({ uploaded: results, usedSpace });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/download?path=...
app.get('/api/files/download', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || '';
    await db.addLog({ action: 'download', username: req.user.username, file: relPath });
    fm.streamFile(req.user.username, relPath, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/create-folder
app.post('/api/files/create-folder', requireAuth, async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    await fm.createDirectory(req.user.username, relPath);
    res.json({ success: true, path: relPath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/rename
app.post('/api/files/rename', requireAuth, async (req, res) => {
  try {
    const { path: relPath, newName } = req.body;
    if (!relPath || !newName) return res.status(400).json({ error: 'Path and newName required' });
    await fm.renameItem(req.user.username, relPath, newName);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/files/delete
app.delete('/api/files/delete', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || req.body.path;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    await fm.deleteItem(req.user.username, relPath);
    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'delete', username: req.user.username, file: relPath });
    res.json({ success: true, usedSpace });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Share Routes ─────────────────────────────────────────────────────────────

// POST /api/share/create
app.post('/api/share/create', requireAuth, async (req, res) => {
  try {
    const { path: relPath, expiresIn, maxDownloads, password } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });

    const isFilePath = await fm.isFile(req.user.username, relPath);
    if (!isFilePath) return res.status(400).json({ error: 'Only files can be shared' });

    const token = uuidv4();
    const absolutePath = fm.getAbsolutePath(req.user.username, relPath);
    const fileName = path.basename(relPath);

    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date(Date.now() + parseInt(expiresIn) * 1000).toISOString();
    }

    let hashedPassword = null;
    if (password) {
      hashedPassword = await bcrypt.hash(password, 10);
    }

    const share = {
      token,
      owner: req.user.username,
      filePath: relPath,
      absolutePath,
      fileName,
      createdAt: new Date().toISOString(),
      expiresAt,
      maxDownloads: maxDownloads ? parseInt(maxDownloads) : null,
      downloadCount: 0,
      password: hashedPassword,
    };
    await db.createShare(share);
    await db.addLog({ action: 'share_create', username: req.user.username, file: relPath, token });

    const shareUrl = `${req.protocol}://${req.get('host')}/share/${token}`;
    res.json({ token, shareUrl, expiresAt, fileName });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/share/list
app.get('/api/share/list', requireAuth, async (req, res) => {
  try {
    const shares = await db.getSharesByUser(req.user.username);
    const safe = shares.map(({ password: _, absolutePath: __, ...s }) => s);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/share/delete/:token
app.delete('/api/share/delete/:token', requireAuth, async (req, res) => {
  try {
    const share = await db.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (share.owner !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Access denied' });
    }
    await db.deleteShare(req.params.token);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/share/info/:token
app.get('/api/share/info/:token', async (req, res) => {
  try {
    const share = await db.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Share link has expired' });
    }
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
      return res.status(410).json({ error: 'Download limit reached' });
    }
    res.json({
      fileName: share.fileName,
      owner: share.owner,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads,
      downloadCount: share.downloadCount,
      hasPassword: !!share.password,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/share/download/:token
app.post('/api/share/download/:token', async (req, res) => {
  try {
    const share = await db.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (share.expiresAt && new Date(share.expiresAt) < new Date()) {
      return res.status(410).json({ error: 'Share link has expired' });
    }
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads) {
      return res.status(410).json({ error: 'Download limit reached' });
    }
    if (share.password) {
      const { password } = req.body;
      if (!password) return res.status(401).json({ error: 'Password required' });
      const valid = await bcrypt.compare(password, share.password);
      if (!valid) return res.status(401).json({ error: 'Incorrect password' });
    }
    await db.updateShare(share.token, { downloadCount: share.downloadCount + 1 });
    await db.addLog({ action: 'share_download', file: share.fileName, token: share.token, ip: req.ip });
    fm.streamSharedFile(share.absolutePath, res);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Routes ─────────────────────────────────────────────────────────────

// GET /api/admin/users
app.get('/api/admin/users', requireAdmin, async (req, res) => {
  try {
    const users = await db.getUsers();
    const safe = users.map(({ password: _, ...u }) => u);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:username/quota
app.put('/api/admin/users/:username/quota', requireAdmin, async (req, res) => {
  try {
    const { quota } = req.body;
    const user = await db.updateUser(req.params.username, { quota: parseInt(quota) });
    await db.addLog({ action: 'admin_quota_change', by: req.user.username, target: req.params.username, quota });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/admin/users/:username/status
app.put('/api/admin/users/:username/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid status' });
    await db.updateUser(req.params.username, { status });
    await db.addLog({ action: 'admin_status_change', by: req.user.username, target: req.params.username, status });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:username
app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    if (req.params.username === 'admin') return res.status(400).json({ error: 'Cannot delete admin' });
    await db.deleteUser(req.params.username);
    await db.addLog({ action: 'admin_delete_user', by: req.user.username, target: req.params.username });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/admin/system-stats
app.get('/api/admin/system-stats', requireAdmin, async (req, res) => {
  try {
    const users = await db.getUsers();
    const shares = await db.getShares();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const cpus = os.cpus();
    const platform = os.platform();
    const uptime = os.uptime();
    const totalStorage = users.reduce((sum, u) => sum + (u.usedSpace || 0), 0);
    const totalQuota = users.reduce((sum, u) => sum + (u.quota || 0), 0);

    res.json({
      users: { total: users.length, active: users.filter(u => u.status === 'active').length },
      shares: { total: shares.length },
      memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
      cpu: { cores: cpus.length, model: cpus[0]?.model || 'Unknown' },
      storage: { used: totalStorage, quota: totalQuota },
      platform,
      uptime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/logs
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = await db.getLogs(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Share Page (Frontend catch-all) ──────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Catch-all SPA ────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ───────────────────────────────────────────────────────────────────
async function start() {
  await db.init();
  // Ensure admin home
  await fm.ensureUserHome('admin');

  app.listen(PORT, () => {
    console.log(`\n┌─────────────────────────────────────────┐`);
    console.log(`│  🚀 NexDrop running on port ${PORT}        │`);
    console.log(`│  📂 Open: http://localhost:${PORT}          │`);
    console.log(`│  👤 Default admin: admin / admin123    │`);
    console.log(`└─────────────────────────────────────────┘\n`);
  });
}

start().catch(console.error);
