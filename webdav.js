/**
 * webdav.js - Native, zero-dependency WebDAV server implementation
 * Complies with RFC 4918. Exposes NexDrop files natively as a network drive.
 */
const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');

const db = require('./db');
const fm = require('./fileManager');
const securityService = require('./services/securityService');

// Helper to check WebDAV write locks
async function checkWebDAVLock(username, relPath) {
  try {
    const lock = await db.getFileLock(username, relPath);
    if (lock && lock.lockedBy !== username) {
      return lock; // locked by someone else
    }
  } catch (_) {}
  return null;
}

// ─── HTTP Basic Authentication Middleware ────────────────────────────────────
async function webdavAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Basic ')) {
    res.setHeader('WWW-Authenticate', 'Basic realm="NexDrop WebDAV Server"');
    return res.status(401).send('Authentication Required');
  }

  try {
    const credentials = Buffer.from(authHeader.substring(6), 'base64').toString('utf-8');
    const [username, password] = credentials.split(':');
    if (!username || !password) {
      res.setHeader('WWW-Authenticate', 'Basic realm="NexDrop WebDAV Server"');
      return res.status(401).send('Authentication Required');
    }

    const user = await db.getUserByUsername(username);
    if (!user || user.status === 'suspended') {
      res.setHeader('WWW-Authenticate', 'Basic realm="NexDrop WebDAV Server"');
      return res.status(401).send('Invalid credentials or account suspended');
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      res.setHeader('WWW-Authenticate', 'Basic realm="NexDrop WebDAV Server"');
      return res.status(401).send('Invalid credentials');
    }

    // Auth succeeded! Attach authenticated user to request context
    req.user = user;
    next();
  } catch (err) {
    console.error('WebDAV Authentication Error:', err);
    res.status(500).send('Internal Server Error');
  }
}

router.use(webdavAuth);

// ─── Security Filter: Block Recycle Bin access ────────────────────────────────
router.use((req, res, next) => {
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);
  const parts = relPath.split('/');
  if (parts.some(p => p.startsWith('.trash'))) {
    return res.status(404).send('Not Found');
  }
  next();
});

// ─── XML Generation Helpers ──────────────────────────────────────────────────
function escapeXML(str) {
  return str.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
}

function renderResponse(req, relPath, name, isDirectory, size, mtime, ctime) {
  // Build standard WebDAV URL href path (keeping leading/trailing slashes correctly)
  const hrefPath = '/webdav/' + relPath.split('/').map(encodeURIComponent).join('/');
  let formattedHref = hrefPath.replace(/\/+/g, '/'); // Normalize slashes
  if (isDirectory && !formattedHref.endsWith('/')) {
    formattedHref += '/';
  }

  const mtimeGMT = mtime ? new Date(mtime).toUTCString() : new Date().toUTCString();
  const ctimeISO = ctime ? new Date(ctime).toISOString() : new Date().toISOString();

  let propHtml = '';
  if (isDirectory) {
    propHtml = `
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:getcontentlength>0</d:getcontentlength>
    `;
  } else {
    propHtml = `
        <d:resourcetype/>
        <d:getcontentlength>${size}</d:getcontentlength>
    `;
  }

  return `
  <d:response>
    <d:href>${escapeXML(formattedHref)}</d:href>
    <d:propstat>
      <d:prop>
        <d:displayname>${escapeXML(name)}</d:displayname>
        ${propHtml}
        <d:getlastmodified>${mtimeGMT}</d:getlastmodified>
        <d:creationdate>${ctimeISO}</d:creationdate>
        <d:supportedlock>
          <d:lockentry>
            <d:lockscope><d:exclusive/></d:lockscope>
            <d:locktype><d:write/></d:locktype>
          </d:lockentry>
        </d:supportedlock>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>`;
}

// Helper to recursively copy directories
async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

// ─── OPTIONS Method ──────────────────────────────────────────────────────────
router.options('*', (req, res) => {
  res.setHeader('DAV', '1, 2');
  res.setHeader('Allow', 'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, MKCOL, MOVE, COPY, PROPPATCH, LOCK, UNLOCK');
  res.setHeader('MS-Author-Via', 'DAV');
  res.status(200).send();
});

// ─── GET / HEAD Methods ──────────────────────────────────────────────────────
router.get('*', async (req, res) => {
  const username = req.user.username;
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);

  try {
    const absPath = fm.getAbsolutePath(username, relPath);
    const stat = await fs.stat(absPath);
    if (stat.isDirectory()) {
      return res.status(400).send('Cannot download a directory directly');
    }
    
    // Express sendFile handles range headers, chunking, and MIME types automatically
    res.sendFile(absPath);
  } catch (err) {
    res.status(404).send('File not found');
  }
});

// ─── PUT Method (Upload/Overwrite) ───────────────────────────────────────────
router.put('*', async (req, res) => {
  const username = req.user.username;
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);

  try {
    // Check if file is locked by another user
    const lock = await checkWebDAVLock(username, relPath);
    if (lock) {
      return res.status(423).send(`Locked: File is locked by ${lock.lockedBy}`);
    }

// Ransomware threat detection
try {
  await securityService.checkThreats(username, [relPath]);
} catch (err) {
  return res.status(403).send(err.message);
}

const absPath = fm.getAbsolutePath(username, relPath);
    
    // Ensure the parent directory exists
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    // Open write stream and pipe request body raw bytes directly to disk
    const writeStream = fsSync.createWriteStream(absPath);
    req.pipe(writeStream);

    writeStream.on('finish', async () => {
      try {
        const usedSpace = await fm.getUserUsedSpace(username);
        const user = await db.getUserByUsername(username);

        // Check if user exceeded storage quota
        if (usedSpace > user.quota) {
          // Exceeded quota! Rollback by deleting the partially written file
          await fs.unlink(absPath);
          return res.status(507).send('Storage quota exceeded');
        }

        // Update database user statistics and log activity
        await db.updateUser(username, { usedSpace });
        await db.addLog({ action: 'webdav_upload', username, file: relPath });
        res.status(201).send('Created');
      } catch (err) {
        res.status(500).send(err.message);
      }
    });

    writeStream.on('error', (err) => {
      console.error('WebDAV upload stream error:', err);
      res.status(500).send(err.message);
    });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// ─── MKCOL Method (Create Directory) ─────────────────────────────────────────
router.mkcol('*', async (req, res) => {
  const username = req.user.username;
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);

  try {
    await fm.createDirectory(username, relPath);
    await db.addLog({ action: 'webdav_mkdir', username, file: relPath });
    res.status(201).send('Created');
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// ─── DELETE Method ───────────────────────────────────────────────────────────
router.delete('*', async (req, res) => {
  const username = req.user.username;
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);

  try {
    // Check if file is locked by another user
    const lock = await checkWebDAVLock(username, relPath);
    if (lock) {
      return res.status(423).send(`Locked: File is locked by ${lock.lockedBy}`);
    }

    await fm.deleteItem(username, relPath);
    const usedSpace = await fm.getUserUsedSpace(username);
    await db.updateUser(username, { usedSpace });
    await db.addLog({ action: 'webdav_delete', username, file: relPath });
    res.status(204).send();
  } catch (err) {
    res.status(400).send(err.message);
  }
});

// ─── PROPFIND & LOCK & MOVE & COPY Router Handler ───────────────────────────
router.all('*', async (req, res, next) => {
  const method = req.method.toUpperCase();
  const username = req.user.username;
  let relPath = decodeURIComponent(req.path);
  if (relPath.startsWith('/')) relPath = relPath.substring(1);

  // 1. PROPFIND - Property discovery (Core WebDAV function)
  if (method === 'PROPFIND') {
    try {
      const absPath = fm.getAbsolutePath(username, relPath);
      try {
        await fs.access(absPath);
      } catch {
        return res.status(404).send('Not Found');
      }

      const stat = await fs.stat(absPath);
      const name = relPath === '' ? 'webdav' : path.basename(absPath);
      
      let xmlResponses = renderResponse(
        req,
        relPath,
        name,
        stat.isDirectory(),
        stat.isDirectory() ? 0 : stat.size,
        stat.mtime,
        stat.birthtime
      );

      // Depth: 1 requests child items as well
      if (stat.isDirectory() && req.headers.depth !== '0') {
        const items = await fm.listDirectory(username, relPath);
        for (const item of items) {
          const itemAbs = fm.getAbsolutePath(username, item.path);
          const itemStat = await fs.stat(itemAbs);
          xmlResponses += renderResponse(
            req,
            item.path,
            item.name,
            item.isDirectory,
            item.isDirectory ? 0 : item.size,
            itemStat.mtime,
            itemStat.birthtime
          );
        }
      }

      const xml = `<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  ${xmlResponses}
</d:multistatus>`;

      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      return res.status(207).send(xml);
    } catch (err) {
      console.error('PROPFIND error:', err);
      return res.status(500).send(err.message);
    }
  }

  // 2. MOVE & COPY
  if (method === 'MOVE' || method === 'COPY') {
    try {
      const destHeader = req.headers.destination;
      if (!destHeader) return res.status(400).send('Destination header required');

      const parsedDest = new URL(destHeader, `${req.protocol}://${req.get('host')}`);
      let destPath = decodeURIComponent(parsedDest.pathname);

      // Extract path within storage relative root (strip /webdav prefix)
      if (destPath.startsWith('/webdav')) {
        destPath = destPath.substring(7);
      }
      if (destPath.startsWith('/')) destPath = destPath.substring(1);

      // Check if source is locked by another user
      const lock = await checkWebDAVLock(username, relPath);
      if (lock) {
        return res.status(423).send(`Locked: File is locked by ${lock.lockedBy}`);
      }

      const srcAbs = fm.getAbsolutePath(username, relPath);
      const destAbs = fm.getAbsolutePath(username, destPath);

      // Create target parent directory structure if missing
      await fs.mkdir(path.dirname(destAbs), { recursive: true });

      if (method === 'MOVE') {
        await fs.rename(srcAbs, destAbs);
        await db.addLog({ action: 'webdav_move', username, from: relPath, to: destPath });
        return res.status(201).send('Created');
      } else {
        // COPY method
        const srcStat = await fs.stat(srcAbs);
        if (srcStat.isDirectory()) {
          await copyDir(srcAbs, destAbs);
        } else {
          await fs.copyFile(srcAbs, destAbs);
        }
        
        const usedSpace = await fm.getUserUsedSpace(username);
        await db.updateUser(username, { usedSpace });
        await db.addLog({ action: 'webdav_copy', username, from: relPath, to: destPath });
        return res.status(201).send('Created');
      }
    } catch (err) {
      console.error(`${method} error:`, err);
      return res.status(400).send(err.message);
    }
  }

  // 3. LOCK - satisfy concurrent editing client requests (Microsoft Word, etc.)
  if (method === 'LOCK') {
    const lockToken = 'opaquelocktoken:' + uuidv4();
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Lock-Token', `<${lockToken}>`);
    return res.status(200).send(`<?xml version="1.0" encoding="utf-8" ?>
<d:prop xmlns:d="DAV:">
  <d:lockdiscovery>
    <d:activelock>
      <d:locktype><d:write/></d:locktype>
      <d:lockscope><d:exclusive/></d:lockscope>
      <d:depth>Infinity</d:depth>
      <d:owner>
        <d:href>http://localhost:3000/</d:href>
      </d:owner>
      <d:timeout>Second-3600</d:timeout>
      <d:locktoken>
        <d:href>${lockToken}</d:href>
      </d:locktoken>
      <d:lockroot>
        <d:href>${escapeXML(req.originalUrl)}</d:href>
      </d:lockroot>
    </d:activelock>
  </d:lockdiscovery>
</d:prop>`);
  }

  // 4. UNLOCK - release lock
  if (method === 'UNLOCK') {
    return res.status(204).send();
  }

  // 5. PROPPATCH - mock metadata update success response to keep Windows explorer happy
  if (method === 'PROPPATCH') {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    return res.status(207).send(`<?xml version="1.0" encoding="utf-8" ?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>${escapeXML(req.originalUrl)}</d:href>
    <d:propstat>
      <d:prop>
        <d:status>HTTP/1.1 200 OK</d:status>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>`);
  }

  // Method not handled in WebDAV protocol
  next();
});

module.exports = router;
