/**
 * fileManager.js - Secure file operations
 * All paths are resolved and validated to stay within the storage root.
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const archiver = require('archiver');

const STORAGE_ROOT = process.env.STORAGE_DIR || (process.env.VERCEL
  ? path.join('/tmp', 'storage', 'users')
  : path.join(__dirname, 'storage', 'users'));

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BACKUPS_DIR = path.join(__dirname, 'backups');

// Get user's home directory (creates if missing)
function getUserHome(username) {
  return path.join(STORAGE_ROOT, username);
}

// Safely resolve a user-supplied relative path within their home dir
function resolveSafe(username, relPath = '') {
  const home = getUserHome(username);
  // Normalize and resolve to absolute
  const resolved = path.resolve(home, relPath.replace(/\\/g, '/'));
  // Strictly enforce containment
  if (!resolved.startsWith(home + path.sep) && resolved !== home) {
    throw new Error('Access denied: path traversal detected');
  }
  return resolved;
}

// Ensure user home directory exists
async function ensureUserHome(username) {
  const home = getUserHome(username);
  await fs.mkdir(home, { recursive: true });
  return home;
}

// List contents of a directory (with file lock metadata injected)
async function listDirectory(username, relPath = '') {
  const db = require('./db');
  const dirPath = resolveSafe(username, relPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  // Pre-fetch locks for this user (to avoid N+1 DB calls)
  let locksMap = {};
  try {
    const locks = await db.getFileLocks(username);
    for (const lk of locks) locksMap[lk.filePath] = lk;
  } catch (_) {}

  const results = await Promise.all(
    entries
      .filter(entry => entry.name !== '.trash')
      .map(async (entry) => {
      const fullPath = path.join(dirPath, entry.name);
      let size = 0;
      let mtime = null;

      try {
        const stat = await fs.stat(fullPath);
        mtime = stat.mtime.toISOString();
        if (stat.isFile()) {
          size = stat.size;
        } else {
          size = await getDirSize(fullPath);
        }
      } catch (_) {/* ignore stat errors */}

      const itemRelPath = path.posix.join(relPath || '', entry.name);
      const lock = locksMap[itemRelPath] || null;

      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size,
        modified: mtime,
        ext: entry.isFile() ? path.extname(entry.name).toLowerCase().slice(1) : null,
        path: itemRelPath,
        lock: lock ? { lockedBy: lock.lockedBy, lockedAt: lock.lockedAt } : null,
      };
    })
  );

  // Directories first, then files; each group sorted by name
  return results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

// Recursively compute directory size
async function getDirSize(dirPath) {
  let total = 0;
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dirPath, e.name);
      if (e.isDirectory()) {
        total += await getDirSize(full);
      } else {
        const s = await fs.stat(full);
        total += s.size;
      }
    }
  } catch (_) {/* ignore */}
  return total;
}

// Compute total used space for a user
async function getUserUsedSpace(username) {
  const home = getUserHome(username);
  try {
    return await getDirSize(home);
  } catch {
    return 0;
  }
}

// Save an uploaded file
async function saveUploadedFile(username, relDir, file) {
  const targetDir = resolveSafe(username, relDir);
  await fs.mkdir(targetDir, { recursive: true });

  // Handle multer memoryStorage buffer or diskStorage temp file
  const destPath = path.join(targetDir, file.originalname);

  if (file.buffer) {
    await fs.writeFile(destPath, file.buffer);
  } else if (file.path) {
    await fs.rename(file.path, destPath);
  }

  const stat = await fs.stat(destPath);
  return {
    name: file.originalname,
    size: stat.size,
    path: path.posix.join(relDir || '', file.originalname),
  };
}

// Download (stream) a file to a response object
function streamFile(username, relPath, res) {
  const filePath = resolveSafe(username, relPath);
  const name = path.basename(filePath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  const stream = fsSync.createReadStream(filePath);
  stream.on('error', () => res.status(404).json({ error: 'File not found' }));
  stream.pipe(res);
}

// Stream a shared file by absolute path
function streamSharedFile(absolutePath, res) {
  const name = path.basename(absolutePath);
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  const stream = fsSync.createReadStream(absolutePath);
  stream.on('error', () => res.status(404).json({ error: 'File not found' }));
  stream.pipe(res);
}

// Delete a file or directory (with lock check)
async function deleteItem(username, relPath) {
  const db = require('./db');
  const lock = await db.getFileLock(username, relPath);
  if (lock && lock.lockedBy !== username) {
    throw new Error(`File is locked by ${lock.lockedBy}. Unlock it first.`);
  }
  const target = resolveSafe(username, relPath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.unlink(target);
  }
  // Release lock if this user had it locked
  if (lock) await db.unlockFile(username, relPath);
}

// Rename or move a file/folder (with lock check)
async function renameItem(username, relOldPath, newName) {
  const db = require('./db');
  const lock = await db.getFileLock(username, relOldPath);
  if (lock && lock.lockedBy !== username) {
    throw new Error(`File is locked by ${lock.lockedBy}. Unlock it first.`);
  }
  const oldPath = resolveSafe(username, relOldPath);
  const parentDir = path.dirname(oldPath);
  const newPath = path.join(parentDir, newName);
  // Validate new path is still in home
  const home = getUserHome(username);
  if (!newPath.startsWith(home)) throw new Error('Invalid rename target');
  await fs.rename(oldPath, newPath);
  // Release old lock since path changed
  if (lock) await db.unlockFile(username, relOldPath);
}

// Create a new directory
async function createDirectory(username, relPath) {
  const dirPath = resolveSafe(username, relPath);
  await fs.mkdir(dirPath, { recursive: true });
}

// Resolve absolute path for sharing (for stream access without username context)
function getAbsolutePath(username, relPath) {
  return resolveSafe(username, relPath);
}

// Check if path exists and is a file
async function isFile(username, relPath) {
  try {
    const p = resolveSafe(username, relPath);
    const s = await fs.stat(p);
    return s.isFile();
  } catch {
    return false;
  }
}

// Move a file or folder to a new directory (with lock check)
async function moveItem(username, relSrc, relDestDir) {
  const db = require('./db');
  const lock = await db.getFileLock(username, relSrc);
  if (lock && lock.lockedBy !== username) {
    throw new Error(`File is locked by ${lock.lockedBy}. Unlock it first.`);
  }
  const srcPath = resolveSafe(username, relSrc);
  const destDirPath = resolveSafe(username, relDestDir === undefined ? '' : relDestDir);
  const fileName = path.basename(srcPath);
  const destPath = path.join(destDirPath, fileName);
  if (destPath === srcPath) throw new Error('Source and destination are the same');
  await fs.mkdir(destDirPath, { recursive: true });
  await fs.rename(srcPath, destPath);
  // Release lock (path is now different)
  if (lock) await db.unlockFile(username, relSrc);
}

// Recursively search files/folders by name (max 100 results)
async function searchFiles(username, query, relPath = '', results = []) {
  if (results.length >= 100) return results;
  const dirPath = resolveSafe(username, relPath);
  let entries;
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch (_) { return results; }
  for (const entry of entries) {
    if (results.length >= 100) break;
    const entryRelPath = relPath ? `${relPath}/${entry.name}` : entry.name;
    if (entry.name.toLowerCase().includes(query.toLowerCase())) {
      let size = 0, mtime = null;
      try {
        const fullP = path.join(dirPath, entry.name);
        const stat = await fs.stat(fullP);
        mtime = stat.mtime.toISOString();
        size = stat.isFile() ? stat.size : await getDirSize(fullP);
      } catch (_) {}
      results.push({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size,
        modified: mtime,
        ext: entry.isFile() ? path.extname(entry.name).toLowerCase().slice(1) : null,
        path: entryRelPath,
      });
    }
    if (entry.isDirectory()) {
      await searchFiles(username, query, entryRelPath, results);
    }
  }
  return results;
}

// Get detailed metadata for a file or folder
async function getFileInfo(username, relPath) {
  const filePath = resolveSafe(username, relPath);
  const stat = await fs.stat(filePath);
  return {
    name: path.basename(filePath),
    path: relPath,
    size: stat.isFile() ? stat.size : await getDirSize(filePath),
    isDirectory: stat.isDirectory(),
    modified: stat.mtime.toISOString(),
    created: stat.birthtime.toISOString(),
    ext: stat.isFile() ? path.extname(filePath).toLowerCase().slice(1) : null,
  };
}

// Move an item to trash
async function moveToTrash(username, relPath) {
  const db = require('./db');
  const { v4: uuidv4 } = require('uuid');
  const srcPath = resolveSafe(username, relPath);
  const trashRoot = path.join(getUserHome(username), '.trash');
  await fs.mkdir(trashRoot, { recursive: true });
  
  const uuid = uuidv4();
  const trashPath = path.join(trashRoot, uuid);
  await fs.rename(srcPath, trashPath);
  
  await db.addTrashEntry(uuid, username, relPath, path.posix.join('.trash', uuid));
}

// Restore an item from trash
async function restoreFromTrash(username, id) {
  const db = require('./db');
  const entry = await db.getTrashEntryById(username, id);
  if (!entry) throw new Error('Trash entry not found');
  
  const srcPath = resolveSafe(username, entry.trashPath);
  const destPath = resolveSafe(username, entry.originalPath);
  
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.rename(srcPath, destPath);
  
  await db.deleteTrashEntry(username, id);
}

// Empty the recycle bin recursively
async function emptyTrash(username) {
  const db = require('./db');
  const trashRoot = path.join(getUserHome(username), '.trash');
  try {
    await fs.rm(trashRoot, { recursive: true, force: true });
  } catch (_) {}
  
  const entries = await db.getTrashEntries(username);
  for (const entry of entries) {
    await db.deleteTrashEntry(username, entry.id);
  }
}

// Save/update text content of a file securely (with lock check)
async function updateFileContent(username, relPath, content) {
  const db = require('./db');
  const lock = await db.getFileLock(username, relPath);
  if (lock && lock.lockedBy !== username) {
    throw new Error(`File is locked by ${lock.lockedBy}. Unlock it first.`);
  }
  const filePath = resolveSafe(username, relPath);
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) throw new Error('Target is not a file');
  await fs.writeFile(filePath, content, 'utf-8');
}

// ─── Backup & Recovery Manager ──────────────────────────────────────────────

// Create a full zip backup of data/ and storage/users/
async function createBackup() {
  await fs.mkdir(BACKUPS_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupName = `nexdrop-backup-${timestamp}.zip`;
  const backupPath = path.join(BACKUPS_DIR, backupName);

  return new Promise((resolve, reject) => {
    const output = fsSync.createWriteStream(backupPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => resolve({ name: backupName, size: archive.pointer(), path: backupPath }));
    archive.on('error', reject);
    archive.pipe(output);

    // Include data directory (JSON databases)
    if (fsSync.existsSync(DATA_DIR)) {
      archive.directory(DATA_DIR, 'data');
    }

    // Include user storage (excluding trash contents to save space)
    if (fsSync.existsSync(STORAGE_ROOT)) {
      archive.directory(STORAGE_ROOT, 'storage/users');
    }

    archive.finalize();
  });
}

// List all available backups
async function listBackups() {
  try {
    await fs.mkdir(BACKUPS_DIR, { recursive: true });
    const files = await fs.readdir(BACKUPS_DIR);
    const backups = [];
    for (const f of files) {
      if (!f.endsWith('.zip')) continue;
      const fullPath = path.join(BACKUPS_DIR, f);
      const stat = await fs.stat(fullPath);
      backups.push({
        name: f,
        size: stat.size,
        createdAt: stat.mtime.toISOString(),
      });
    }
    return backups.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } catch (_) {
    return [];
  }
}

// Delete a backup file
async function deleteBackup(filename) {
  // Strictly sanitize filename to prevent path traversal
  const safeName = path.basename(filename);
  if (!safeName.endsWith('.zip') || !safeName.startsWith('nexdrop-backup-')) {
    throw new Error('Invalid backup filename');
  }
  const fullPath = path.join(BACKUPS_DIR, safeName);
  await fs.unlink(fullPath);
}

module.exports = {
  ensureUserHome,
  listDirectory,
  getUserUsedSpace,
  saveUploadedFile,
  streamFile,
  streamSharedFile,
  deleteItem,
  renameItem,
  createDirectory,
  getAbsolutePath,
  isFile,
  getDirSize,
  moveItem,
  searchFiles,
  getFileInfo,
  
  // Recycle Bin & Text Editor
  moveToTrash,
  restoreFromTrash,
  emptyTrash,
  updateFileContent,

  // Backup & Recovery
  createBackup,
  listBackups,
  deleteBackup,
  BACKUPS_DIR,
  DATA_DIR,
  STORAGE_ROOT,
};
