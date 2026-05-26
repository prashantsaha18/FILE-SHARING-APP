/**
 * server.js - NexDrop Main Express Application Server
 * Features: JWT auth, file management, sharing, admin panel,
 *           rate limiting, security headers, real-time search,
 *           file locking, NFS/SMB virtual shares, ransomware shield, backups
 */
require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const multer     = require('multer');
const bcrypt     = require('bcryptjs');
const path       = require('path');
const os         = require('os');
const { v4: uuidv4 } = require('uuid');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');

const db  = require('./db');
const fm  = require('./fileManager');
const { generateToken, requireAuth, requireAdmin } = require('./auth');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── Security Middleware ─────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());

// WebDAV mount must be BEFORE body parsers to keep the upload streams intact
const webdavRouter = require('./webdav');
app.use('/webdav', webdavRouter);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limiting ───────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,  // 15-minute window
  max: 10,                    // max 10 attempts per window
  message: { error: 'Too many attempts. Please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Ransomware Shield (Modular Service Broker) ──────────────────────────────
async function ransomwareShield(req, res, next, fileNames = []) {
  try {
    const username = req.user?.username;
    if (!username) return next();

    const securityService = require('./services/securityService');
    await securityService.checkThreats(username, fileNames);
    next();
  } catch (err) {
    if (err.message.includes('RANSOMWARE SHIELD')) {
      const isVelocity = err.message.includes('Rapid writes');
      return res.status(isVelocity ? 429 : 403).json({ error: err.message });
    }
    next(); // Fail open to avoid breaking system on secondary errors
  }
}

// ─── File Upload (Memory Storage) ───────────────────────────────────────────
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

// ─── DB Auto-initialization Middleware (for Serverless/Vercel compatibility) ──
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized) {
    try {
      await db.init();
      await fm.ensureUserHome('admin');
      dbInitialized = true;
    } catch (err) {
      console.error('Database initialization failed:', err);
    }
  }
  next();
});

// ─── Auth Routes ─────────────────────────────────────────────────────────────

// POST /api/auth/register  (rate limited)
app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, password, email } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Username and password required' });
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username))
      return res.status(400).json({ error: 'Username must be 3-20 alphanumeric characters' });
    if (password.length < 6)
      return res.status(400).json({ error: 'Password must be at least 6 characters' });

    const existing = await db.getUserByUsername(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const hash = await bcrypt.hash(password, 10);
    const user = {
      username,
      password: hash,
      email: email || '',
      role: 'user',
      createdAt: new Date().toISOString(),
      quota: 1073741824,  // 1 GB default
      usedSpace: 0,
      status: 'active',
    };
    await db.createUser(user);
    await fm.ensureUserHome(username);
    await db.addLog({ action: 'register', username, ip: req.ip });

    const token = generateToken(user);
    res.status(201).json({
      token,
      user: { username, email: user.email, role: user.role, quota: user.quota },
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /api/auth/login  (rate limited)
app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.getUserByUsername(username);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.status === 'suspended')
      return res.status(403).json({ error: 'Account suspended. Contact admin.' });

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

// GET /api/analytics/summary
app.get('/api/analytics/summary', requireAuth, async (req, res) => {
  try {
    const username = req.user.username;
    
    // Link sharing stats
    const shares = await db.getSharesByUser(username);
    const totalShares = shares.length;
    const totalDownloads = shares.reduce((sum, s) => sum + (s.downloadCount || 0), 0);
    
    // Collaboration stats
    const sharedWithMe = await db.getSharedWithMe(username);
    const mySharedCollabs = await db.getCollaborators(username);
    
    // Recent activity logs
    const recentLogs = await db.getLogsByUser(username, 15);
    
    // Storage
    const usedSpace = await fm.getUserUsedSpace(username);
    
    res.json({
      storage: {
        used: usedSpace,
        quota: req.user.quota,
        pct: ((usedSpace / req.user.quota) * 100).toFixed(1)
      },
      shares: {
        totalLinks: totalShares,
        totalDownloads: totalDownloads
      },
      collaboration: {
        sharedWithMe: sharedWithMe.length,
        sharedWithOthers: mySharedCollabs.length
      },
      logs: recentLogs
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Routes ─────────────────────────────────────────────────────────────

// GET /api/files/list?path=...
app.get('/api/files/list', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const owner = req.query.owner || req.user.username;
    
    let hasReadPermission = false;
    if (owner === req.user.username) {
      hasReadPermission = true;
    } else {
      const colls = await db.getCollaborators(owner, relPath);
      const matching = colls.find(c => c.collaborator === req.user.username);
      if (matching) hasReadPermission = true;
    }
    
    if (!hasReadPermission) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    const items = await fm.listDirectory(owner, relPath);
    res.json({ path: relPath, owner, items });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/files/search?q=...
app.get('/api/files/search', requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const results = await fm.searchFiles(req.user.username, q);
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/files/info?path=...
app.get('/api/files/info', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const info = await fm.getFileInfo(req.user.username, relPath);
    res.json(info);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/upload
app.post('/api/files/upload', requireAuth, upload.array('files', 50), async (req, res) => {
  try {
    const relDir  = req.body.path || '';
    const results = [];
    const fileNames = req.files.map(f => f.originalname);

    // Ransomware shield check
    await new Promise((resolve, reject) => {
      ransomwareShield(req, res, (err) => err ? reject(err) : resolve(), fileNames);
    });

    for (const file of req.files) {
      const saved = await fm.saveUploadedFile(req.user.username, relDir, file);
      results.push(saved);
    }

    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({
      action: 'upload',
      username: req.user.username,
      files: results.map(f => f.name),
      path: relDir,
    });

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
    const owner = req.query.owner || req.user.username;
    
    let hasReadPermission = false;
    if (owner === req.user.username) {
      hasReadPermission = true;
    } else {
      const colls = await db.getCollaborators(owner, relPath);
      const matching = colls.find(c => c.collaborator === req.user.username);
      if (matching) hasReadPermission = true;
    }
    
    if (!hasReadPermission) {
      return res.status(403).json({ error: 'Access denied' });
    }
    
    await db.addLog({ action: 'download', username: req.user.username, file: relPath, owner });
    fm.streamFile(owner, relPath, res);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/files/save
app.put('/api/files/save', requireAuth, async (req, res) => {
  try {
    const { path: relPath, content, owner } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    if (content === undefined) return res.status(400).json({ error: 'Content required' });
    
    const targetOwner = owner || req.user.username;
    
    let hasWritePermission = false;
    if (targetOwner === req.user.username) {
      hasWritePermission = true;
    } else {
      const colls = await db.getCollaborators(targetOwner, relPath);
      const matching = colls.find(c => c.collaborator === req.user.username && c.accessLevel === 'write');
      if (matching) hasWritePermission = true;
    }
    
    if (!hasWritePermission) {
      return res.status(403).json({ error: 'Access denied: write permission required' });
    }
    
    await fm.updateFileContent(targetOwner, relPath, content);
    
    const usedSpace = await fm.getUserUsedSpace(targetOwner);
    await db.updateUser(targetOwner, { usedSpace });
    
    await db.addLog({ action: 'file_edit', username: req.user.username, owner: targetOwner, file: relPath });
    res.json({ success: true, usedSpace });
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
    if (!relPath || !newName)
      return res.status(400).json({ error: 'Path and newName required' });
    await fm.renameItem(req.user.username, relPath, newName);
    await db.addLog({ action: 'rename', username: req.user.username, from: relPath, to: newName });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/files/move
app.post('/api/files/move', requireAuth, async (req, res) => {
  try {
    const { src, destDir } = req.body;
    if (!src || destDir === undefined)
      return res.status(400).json({ error: 'src and destDir required' });
    await fm.moveItem(req.user.username, src, destDir);
    await db.addLog({ action: 'move', username: req.user.username, src, dest: destDir });
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

// POST /api/files/trash
app.post('/api/files/trash', requireAuth, async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    
    await fm.moveToTrash(req.user.username, relPath);
    
    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'trash_move', username: req.user.username, file: relPath });
    
    res.json({ success: true, usedSpace });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/files/trash
app.get('/api/files/trash', requireAuth, async (req, res) => {
  try {
    const entries = await db.getTrashEntries(req.user.username);
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/trash/restore
app.post('/api/files/trash/restore', requireAuth, async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'ID required' });
    
    await fm.restoreFromTrash(req.user.username, id);
    
    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'trash_restore', username: req.user.username, id });
    
    res.json({ success: true, usedSpace });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/files/trash/empty
app.delete('/api/files/trash/empty', requireAuth, async (req, res) => {
  try {
    await fm.emptyTrash(req.user.username);
    
    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'trash_empty', username: req.user.username });
    
    res.json({ success: true, usedSpace });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/files/trash/delete
app.delete('/api/files/trash/delete', requireAuth, async (req, res) => {
  try {
    const { id } = req.body || req.query;
    if (!id) return res.status(400).json({ error: 'ID required' });
    
    const entry = await db.getTrashEntryById(req.user.username, id);
    if (!entry) return res.status(404).json({ error: 'Trash entry not found' });
    
    await fm.deleteItem(req.user.username, entry.trashPath);
    await db.deleteTrashEntry(req.user.username, id);
    
    const usedSpace = await fm.getUserUsedSpace(req.user.username);
    await db.updateUser(req.user.username, { usedSpace });
    await db.addLog({ action: 'trash_purge', username: req.user.username, id });
    
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

    const token        = uuidv4();
    const absolutePath = fm.getAbsolutePath(req.user.username, relPath);
    const fileName     = path.basename(relPath);

    let expiresAt = null;
    if (expiresIn) {
      expiresAt = new Date(Date.now() + parseInt(expiresIn) * 1000).toISOString();
    }

    let hashedPassword = null;
    if (password) hashedPassword = await bcrypt.hash(password, 10);

    const share = {
      token, owner: req.user.username, filePath: relPath,
      absolutePath, fileName,
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
    const safe   = shares.map(({ password: _, absolutePath: __, ...s }) => s);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/share/collaborate
app.post('/api/share/collaborate', requireAuth, async (req, res) => {
  try {
    const { path: relPath, collaborator, accessLevel } = req.body;
    if (!relPath || !collaborator)
      return res.status(400).json({ error: 'Path and collaborator required' });
    
    if (collaborator === req.user.username)
      return res.status(400).json({ error: 'Cannot share with yourself' });
    
    const collabUser = await db.getUserByUsername(collaborator);
    if (!collabUser)
      return res.status(404).json({ error: 'Collaborator user not found' });
    
    const cleanAccess = ['read', 'write'].includes(accessLevel) ? accessLevel : 'read';
    
    await db.addCollaborator(req.user.username, relPath, collaborator, cleanAccess);
    await db.addLog({
      action: 'share_collaborate',
      username: req.user.username,
      target: collaborator,
      file: relPath,
      accessLevel: cleanAccess
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/share/collaborators
app.get('/api/share/collaborators', requireAuth, async (req, res) => {
  try {
    const relPath = req.query.path || '';
    const colls = await db.getCollaborators(req.user.username, relPath);
    res.json(colls);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/share/collaborate
app.delete('/api/share/collaborate', requireAuth, async (req, res) => {
  try {
    const { path: relPath, collaborator } = req.body || req.query;
    if (!relPath || !collaborator)
      return res.status(400).json({ error: 'Path and collaborator required' });
    
    await db.removeCollaborator(req.user.username, relPath, collaborator);
    await db.addLog({
      action: 'share_collaborate_revoke',
      username: req.user.username,
      target: collaborator,
      file: relPath
    });
    
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/share/shared-with-me
app.get('/api/share/shared-with-me', requireAuth, async (req, res) => {
  try {
    const shared = await db.getSharedWithMe(req.user.username);
    const items = [];
    for (const s of shared) {
      try {
        const info = await fm.getFileInfo(s.owner, s.filePath);
        items.push({
          id: s.id,
          owner: s.owner,
          path: s.filePath,
          name: info.name,
          size: info.size,
          modified: info.modified,
          isDirectory: info.isDirectory,
          accessLevel: s.accessLevel,
        });
      } catch (_) {
        // Skip deleted files
      }
    }
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/share/delete/:token
app.delete('/api/share/delete/:token', requireAuth, async (req, res) => {
  try {
    const share = await db.getShareByToken(req.params.token);
    if (!share) return res.status(404).json({ error: 'Share not found' });
    if (share.owner !== req.user.username && req.user.role !== 'admin')
      return res.status(403).json({ error: 'Access denied' });
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
    if (share.expiresAt && new Date(share.expiresAt) < new Date())
      return res.status(410).json({ error: 'Share link has expired' });
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads)
      return res.status(410).json({ error: 'Download limit reached' });
    res.json({
      fileName: share.fileName, owner: share.owner,
      createdAt: share.createdAt, expiresAt: share.expiresAt,
      maxDownloads: share.maxDownloads, downloadCount: share.downloadCount,
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
    if (share.expiresAt && new Date(share.expiresAt) < new Date())
      return res.status(410).json({ error: 'Share link has expired' });
    if (share.maxDownloads && share.downloadCount >= share.maxDownloads)
      return res.status(410).json({ error: 'Download limit reached' });
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
    const safe  = users.map(({ password: _, ...u }) => u);
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/admin/users/:username/quota
app.put('/api/admin/users/:username/quota', requireAdmin, async (req, res) => {
  try {
    const { quota } = req.body;
    await db.updateUser(req.params.username, { quota: parseInt(quota) });
    await db.addLog({
      action: 'admin_quota_change',
      by: req.user.username,
      target: req.params.username,
      quota,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/admin/users/:username/status
app.put('/api/admin/users/:username/status', requireAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'suspended'].includes(status))
      return res.status(400).json({ error: 'Invalid status' });
    await db.updateUser(req.params.username, { status });
    await db.addLog({
      action: 'admin_status_change',
      by: req.user.username,
      target: req.params.username,
      status,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/admin/users/:username
app.delete('/api/admin/users/:username', requireAdmin, async (req, res) => {
  try {
    if (req.params.username === 'admin')
      return res.status(400).json({ error: 'Cannot delete the admin account' });
    await db.deleteUser(req.params.username);
    await db.addLog({
      action: 'admin_delete_user',
      by: req.user.username,
      target: req.params.username,
    });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/admin/system-stats
app.get('/api/admin/system-stats', requireAdmin, async (req, res) => {
  try {
    const users     = await db.getUsers();
    const shares    = await db.getShares();
    const totalMem  = os.totalmem();
    const freeMem   = os.freemem();
    const cpus      = os.cpus();
    const platform  = os.platform();
    const uptime    = os.uptime();
    const totalStorage = users.reduce((s, u) => s + (u.usedSpace || 0), 0);
    const totalQuota   = users.reduce((s, u) => s + (u.quota    || 0), 0);

    res.json({
      users: { total: users.length, active: users.filter(u => u.status === 'active').length },
      shares: { total: shares.length },
      memory: { total: totalMem, free: freeMem, used: totalMem - freeMem },
      cpu:    { cores: cpus.length, model: cpus[0]?.model || 'Unknown' },
      storage: { used: totalStorage, quota: totalQuota },
      platform, uptime,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/logs
app.get('/api/admin/logs', requireAdmin, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs  = await db.getLogs(limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── File Lock Routes ─────────────────────────────────────────────────────────

// POST /api/files/lock
app.post('/api/files/lock', requireAuth, async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    const existing = await db.getFileLock(req.user.username, relPath);
    if (existing && existing.lockedBy !== req.user.username) {
      return res.status(423).json({ error: `File is already locked by ${existing.lockedBy}` });
    }
    await db.lockFile(req.user.username, relPath, req.user.username);
    await db.addLog({ action: 'file_lock', username: req.user.username, file: relPath });
    res.json({ success: true, lockedBy: req.user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/files/unlock
app.post('/api/files/unlock', requireAuth, async (req, res) => {
  try {
    const { path: relPath } = req.body;
    if (!relPath) return res.status(400).json({ error: 'Path required' });
    const lock = await db.getFileLock(req.user.username, relPath);
    if (!lock) return res.status(404).json({ error: 'File is not locked' });
    if (lock.lockedBy !== req.user.username && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot unlock a file locked by another user' });
    }
    await db.unlockFile(req.user.username, relPath);
    await db.addLog({ action: 'file_unlock', username: req.user.username, file: relPath });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NFS Export Routes ────────────────────────────────────────────────────────

// GET /api/nfs/exports
app.get('/api/nfs/exports', requireAuth, async (req, res) => {
  try {
    const exports = await db.getNFSExports(req.user.username);
    res.json(exports);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/nfs/exports
app.post('/api/nfs/exports', requireAuth, async (req, res) => {
  try {
    const { filePath, allowedIPs, accessLevel, squash } = req.body;
    if (!filePath) return res.status(400).json({ error: 'filePath required' });
    const entry = await db.createNFSExport({
      owner: req.user.username,
      filePath,
      allowedIPs: allowedIPs || '*',
      accessLevel: ['ro', 'rw'].includes(accessLevel) ? accessLevel : 'ro',
      squash: squash || 'root_squash',
      active: true,
    });
    await db.addLog({ action: 'nfs_export_create', username: req.user.username, filePath });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/nfs/exports/:id
app.put('/api/nfs/exports/:id', requireAuth, async (req, res) => {
  try {
    const { allowedIPs, accessLevel, squash, active } = req.body;
    const updates = {};
    if (allowedIPs !== undefined) updates.allowedIPs = allowedIPs;
    if (accessLevel !== undefined) updates.accessLevel = accessLevel;
    if (squash !== undefined) updates.squash = squash;
    if (active !== undefined) updates.active = active;
    await db.updateNFSExport(req.params.id, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/nfs/exports/:id
app.delete('/api/nfs/exports/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteNFSExport(req.params.id);
    await db.addLog({ action: 'nfs_export_delete', username: req.user.username, id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── SMB Share Routes ─────────────────────────────────────────────────────────

// GET /api/smb/shares
app.get('/api/smb/shares', requireAuth, async (req, res) => {
  try {
    const shares = await db.getSMBShares(req.user.username);
    res.json(shares);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/smb/shares
app.post('/api/smb/shares', requireAuth, async (req, res) => {
  try {
    const { shareName, filePath, comment, guestOk, accessLevel } = req.body;
    if (!shareName || !filePath) return res.status(400).json({ error: 'shareName and filePath required' });
    // Validate shareName (alphanumeric + underscores, max 40 chars)
    if (!/^[a-zA-Z0-9_\-]{1,40}$/.test(shareName)) {
      return res.status(400).json({ error: 'Share name must be 1-40 alphanumeric characters' });
    }
    const entry = await db.createSMBShare({
      owner: req.user.username,
      shareName,
      filePath,
      comment: comment || '',
      guestOk: guestOk === true,
      accessLevel: ['ro', 'rw'].includes(accessLevel) ? accessLevel : 'ro',
      active: true,
    });
    await db.addLog({ action: 'smb_share_create', username: req.user.username, shareName, filePath });
    res.status(201).json(entry);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/smb/shares/:id
app.put('/api/smb/shares/:id', requireAuth, async (req, res) => {
  try {
    const { comment, guestOk, accessLevel, active } = req.body;
    const updates = {};
    if (comment !== undefined) updates.comment = comment;
    if (guestOk !== undefined) updates.guestOk = guestOk;
    if (accessLevel !== undefined) updates.accessLevel = accessLevel;
    if (active !== undefined) updates.active = active;
    await db.updateSMBShare(req.params.id, updates);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/smb/shares/:id
app.delete('/api/smb/shares/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteSMBShare(req.params.id);
    await db.addLog({ action: 'smb_share_delete', username: req.user.username, id: req.params.id });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Admin Backup Routes ──────────────────────────────────────────────────────

// GET /api/admin/backups
app.get('/api/admin/backups', requireAdmin, async (req, res) => {
  try {
    const backups = await fm.listBackups();
    res.json(backups);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backups/create
app.post('/api/admin/backups/create', requireAdmin, async (req, res) => {
  try {
    const result = await fm.createBackup();
    await db.addLog({ action: 'backup_create', username: req.user.username, backup: result.name });
    res.json(result);
  } catch (err) {
    console.error('Backup error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backups/download/:filename
app.get('/api/admin/backups/download/:filename', requireAdmin, async (req, res) => {
  try {
    const safeName = path.basename(req.params.filename);
    if (!safeName.endsWith('.zip') || !safeName.startsWith('nexdrop-backup-')) {
      return res.status(400).json({ error: 'Invalid backup filename' });
    }
    const fullPath = path.join(fm.BACKUPS_DIR, safeName);
    await db.addLog({ action: 'backup_download', username: req.user.username, backup: safeName });
    res.download(fullPath, safeName);
  } catch (err) {
    res.status(404).json({ error: 'Backup not found' });
  }
});

// DELETE /api/admin/backups/delete
app.delete('/api/admin/backups/delete', requireAdmin, async (req, res) => {
  try {
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    await fm.deleteBackup(filename);
    await db.addLog({ action: 'backup_delete', username: req.user.username, backup: filename });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Security Audit & Settings Routes ────────────────────────────────────────

// GET /api/admin/security/audit
app.get('/api/admin/security/audit', requireAdmin, async (req, res) => {
  try {
    const jwtSecret = process.env.JWT_SECRET || '';
    const users = await db.getUsers();
    const quarantined = users.filter(u => u.status === 'suspended').length;
    const shieldEnabled = await db.getSystemSetting('ransomwareShield', true);
    const backups = await fm.listBackups();
    const lastBackup = backups.length ? backups[0].createdAt : null;

    // Calculate security score (0-100)
    let score = 0;
    const checks = [
      { id: 'helmet',        label: 'Security Headers (Helmet.js)',       pass: true,                           weight: 15 },
      { id: 'rateLimit',     label: 'Rate Limiting Enabled',              pass: true,                           weight: 15 },
      { id: 'jwtStrength',   label: 'JWT Secret Strength (≥32 chars)',    pass: jwtSecret.length >= 32,         weight: 20 },
      { id: 'shield',        label: 'Ransomware Shield Active',           pass: !!shieldEnabled,                weight: 20 },
      { id: 'backup',        label: 'Recent Backup (<7 days)',            pass: lastBackup && (Date.now() - new Date(lastBackup)) < 7 * 86400000, weight: 15 },
      { id: 'quarantine',    label: 'No Quarantined Accounts',           pass: quarantined === 0,              weight: 15 },
    ];

    for (const c of checks) {
      if (c.pass) score += c.weight;
    }

    res.json({
      score,
      checks: checks.map(c => ({ id: c.id, label: c.label, pass: c.pass, weight: c.weight })),
      quarantined,
      shieldEnabled,
      lastBackup,
      totalBackups: backups.length,
      platform: os.platform(),
      uptime: os.uptime(),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/security/settings
app.get('/api/admin/security/settings', requireAdmin, async (req, res) => {
  try {
    const shieldEnabled = await db.getSystemSetting('ransomwareShield', true);
    res.json({ ransomwareShield: shieldEnabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/security/settings
app.post('/api/admin/security/settings', requireAdmin, async (req, res) => {
  try {
    const { ransomwareShield } = req.body;
    if (ransomwareShield !== undefined) {
      await db.updateSystemSetting('ransomwareShield', !!ransomwareShield);
    }
    await db.addLog({ action: 'security_settings_update', username: req.user.username, ransomwareShield });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/security/rules
app.get('/api/admin/security/rules', requireAdmin, async (req, res) => {
  try {
    const securityService = require('./services/securityService');
    const velocity = await db.getSystemSetting('ransomwareVelocity', 15);
    const window = await db.getSystemSetting('ransomwareWindow', 10);
    const exts = await db.getSystemSetting('ransomwareExts', securityService.DEFAULT_RANSOM_EXTS);
    res.json({ velocity, window, exts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/security/rules
app.post('/api/admin/security/rules', requireAdmin, async (req, res) => {
  try {
    const { velocity, window, exts } = req.body;
    if (velocity !== undefined) await db.updateSystemSetting('ransomwareVelocity', parseInt(velocity));
    if (window !== undefined) await db.updateSystemSetting('ransomwareWindow', parseInt(window));
    if (exts !== undefined) {
      const parsedExts = Array.isArray(exts) ? exts : exts.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      await db.updateSystemSetting('ransomwareExts', parsedExts);
    }
    await db.addLog({ action: 'security_rules_update', username: req.user.username });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/backups/settings
app.get('/api/admin/backups/settings', requireAdmin, async (req, res) => {
  try {
    const interval = await db.getSystemSetting('backupIntervalHours', 0);
    const retention = await db.getSystemSetting('backupRetentionCount', 5);
    res.json({ interval, retention });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/backups/settings
app.post('/api/admin/backups/settings', requireAdmin, async (req, res) => {
  try {
    const { interval, retention } = req.body;
    const securityService = require('./services/securityService');
    if (interval !== undefined) {
      await db.updateSystemSetting('backupIntervalHours', parseFloat(interval));
      await securityService.initScheduler(); // Reload scheduler
    }
    if (retention !== undefined) {
      await db.updateSystemSetting('backupRetentionCount', parseInt(retention));
    }
    await db.addLog({ action: 'backup_settings_update', username: req.user.username, interval, retention });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/protocols/deploy-configs
app.get('/api/admin/protocols/deploy-configs', requireAdmin, async (req, res) => {
  try {
    const protocolService = require('./services/protocolService');
    const nfs = await protocolService.generateNFSExports();
    const smb = await protocolService.generateSMBConfig();
    const script = await protocolService.generateSyncScript();
    res.json({ nfs, smb, script });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/security/release-quarantine/:username
app.post('/api/admin/security/release-quarantine/:username', requireAdmin, async (req, res) => {
  try {
    await db.updateUser(req.params.username, { status: 'active' });
    await db.unlockAllByUser(req.params.username);
    await db.addLog({ action: 'quarantine_release', by: req.user.username, target: req.params.username });
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Share Page & SPA catch-all ───────────────────────────────────────────────
app.get('/share/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start Server ─────────────────────────────────────────────────────────────
async function start() {
  await db.init();
  await fm.ensureUserHome('admin');

  // Initialize scheduled backups runner daemon
  try {
    const securityService = require('./services/securityService');
    await securityService.initScheduler();
  } catch (err) {
    console.error('Failed to initialize backups scheduler:', err);
  }

  app.listen(PORT, () => {
    console.log(`\n┌─────────────────────────────────────────┐`);
    console.log(`│  🚀 NexDrop running on port ${PORT}        │`);
    console.log(`│  📂 Open: http://localhost:${PORT}          │`);
    console.log(`│  👤 Default admin: admin / admin123    │`);
    console.log(`│  🔒 Rate limiting & helmet enabled     │`);
    console.log(`└─────────────────────────────────────────┘\n`);
  });
}

if (require.main === module) {
  start().catch(console.error);
}

module.exports = app;
