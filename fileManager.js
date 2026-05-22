/**
 * fileManager.js - Secure file operations
 * All paths are resolved and validated to stay within the storage root.
 */
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const STORAGE_ROOT = process.env.VERCEL
  ? path.join('/tmp', 'storage', 'users')
  : path.join(__dirname, 'storage', 'users');

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

// List contents of a directory
async function listDirectory(username, relPath = '') {
  const dirPath = resolveSafe(username, relPath);
  const entries = await fs.readdir(dirPath, { withFileTypes: true });

  const results = await Promise.all(
    entries.map(async (entry) => {
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

      return {
        name: entry.name,
        isDirectory: entry.isDirectory(),
        size,
        modified: mtime,
        ext: entry.isFile() ? path.extname(entry.name).toLowerCase().slice(1) : null,
        path: path.posix.join(relPath || '', entry.name),
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

// Delete a file or directory
async function deleteItem(username, relPath) {
  const target = resolveSafe(username, relPath);
  const stat = await fs.stat(target);
  if (stat.isDirectory()) {
    await fs.rm(target, { recursive: true, force: true });
  } else {
    await fs.unlink(target);
  }
}

// Rename or move a file/folder
async function renameItem(username, relOldPath, newName) {
  const oldPath = resolveSafe(username, relOldPath);
  const parentDir = path.dirname(oldPath);
  const newPath = path.join(parentDir, newName);
  // Validate new path is still in home
  const home = getUserHome(username);
  if (!newPath.startsWith(home)) throw new Error('Invalid rename target');
  await fs.rename(oldPath, newPath);
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

// Move a file or folder to a new directory
async function moveItem(username, relSrc, relDestDir) {
  const srcPath = resolveSafe(username, relSrc);
  const destDirPath = resolveSafe(username, relDestDir === undefined ? '' : relDestDir);
  const fileName = path.basename(srcPath);
  const destPath = path.join(destDirPath, fileName);
  if (destPath === srcPath) throw new Error('Source and destination are the same');
  await fs.mkdir(destDirPath, { recursive: true });
  await fs.rename(srcPath, destPath);
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
};
