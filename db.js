/**
 * db.js - Polymorphic Database Layer
 * Seamlessly switches between Neon PostgreSQL and an Atomic, transaction-safe JSON file database.
 */
const { Pool } = require('pg');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const isPG = !!(process.env.DATABASE_URL && process.env.DATABASE_URL.trim() !== '');

let pool = null;
if (isPG) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false
    }
  });
  console.log('⚡ NexDrop DB Mode: Neon PostgreSQL');
} else {
  console.log('📂 NexDrop DB Mode: Atomic local JSON database');
}

const DATA_DIR = path.join(__dirname, 'data');
const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  shares: path.join(DATA_DIR, 'shares.json'),
  logs: path.join(DATA_DIR, 'logs.json'),
  collaborators: path.join(DATA_DIR, 'collaborators.json'),
  trash: path.join(DATA_DIR, 'trash_index.json'),
};

// ─── Atomic JSON helpers ────────────────────────────────────────────────────

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function readJSON(filePath, defaultData = []) {
  try {
    await ensureDataDir();
    const data = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    return defaultData;
  }
}

async function writeJSON(filePath, data) {
  await ensureDataDir();
  const tempPath = filePath + '.tmp';
  await fs.writeFile(tempPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tempPath, filePath);
}

// ─── Migrations & Initialization ─────────────────────────────────────────────

async function migrate() {
  if (!isPG) return;

  // 1. Users Migration
  try {
    const usersCountRes = await pool.query('SELECT COUNT(*) FROM users');
    const usersCount = parseInt(usersCountRes.rows[0].count, 10);
    if (usersCount === 0) {
      console.log('PostgreSQL users table is empty. Migrating local JSON data...');
      const usersData = await readJSON(FILES.users);
      for (const u of usersData) {
        await createUser(u);
      }
      console.log(`Migrated ${usersData.length} users.`);
    }
  } catch (err) {
    console.error('Error migrating users:', err);
  }

  // 2. Shares Migration
  try {
    const sharesCountRes = await pool.query('SELECT COUNT(*) FROM shares');
    const sharesCount = parseInt(sharesCountRes.rows[0].count, 10);
    if (sharesCount === 0) {
      console.log('PostgreSQL shares table is empty. Migrating local JSON data...');
      const sharesData = await readJSON(FILES.shares);
      for (const s of sharesData) {
        const ownerExists = await getUserByUsername(s.owner);
        if (ownerExists) {
          await createShare(s);
        }
      }
      console.log(`Migrated ${sharesData.length} shares.`);
    }
  } catch (err) {
    console.error('Error migrating shares:', err);
  }

  // 3. Logs Migration
  try {
    const logsCountRes = await pool.query('SELECT COUNT(*) FROM logs');
    const logsCount = parseInt(logsCountRes.rows[0].count, 10);
    if (logsCount === 0) {
      console.log('PostgreSQL logs table is empty. Migrating local JSON data...');
      const logsData = await readJSON(FILES.logs);
      const reversedLogs = [...logsData].reverse();
      for (const log of reversedLogs) {
        await pool.query('INSERT INTO logs (details) VALUES ($1)', [JSON.stringify(log)]);
      }
      console.log(`Migrated ${reversedLogs.length} logs.`);
    }
  } catch (err) {
    console.error('Error migrating logs:', err);
  }
}

async function init() {
  if (isPG) {
    // 1. Users table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        username VARCHAR(50) PRIMARY KEY,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'user',
        email VARCHAR(255) DEFAULT '',
        "createdAt" VARCHAR(100) NOT NULL,
        quota BIGINT NOT NULL DEFAULT 1073741824,
        "usedSpace" BIGINT NOT NULL DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'active'
      );
    `);

    // 2. Shares table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shares (
        token VARCHAR(100) PRIMARY KEY,
        owner VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        "filePath" TEXT NOT NULL,
        "absolutePath" TEXT NOT NULL,
        "fileName" VARCHAR(255) NOT NULL,
        "createdAt" VARCHAR(100) NOT NULL,
        "expiresAt" VARCHAR(100),
        "maxDownloads" INTEGER,
        "downloadCount" INTEGER NOT NULL DEFAULT 0,
        password VARCHAR(255)
      );
    `);

    // 3. Logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS logs (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        details JSONB NOT NULL
      );
    `);

    // 4. Collaborators table (WorkDrive sharing)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS collaborators (
        id VARCHAR(100) PRIMARY KEY,
        owner VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        "filePath" TEXT NOT NULL,
        collaborator VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        "accessLevel" VARCHAR(20) NOT NULL DEFAULT 'read',
        CONSTRAINT unique_collab UNIQUE(owner, "filePath", collaborator)
      );
    `);

    // 5. Trash Index table (Recycle Bin)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS trash_index (
        id VARCHAR(100) PRIMARY KEY,
        username VARCHAR(50) NOT NULL REFERENCES users(username) ON DELETE CASCADE,
        "originalPath" TEXT NOT NULL,
        "trashPath" TEXT NOT NULL,
        "deletedAt" VARCHAR(100) NOT NULL
      );
    `);

    console.log('PostgreSQL database schemas configured.');
    await migrate();
  } else {
    // Zero-config atomic JSON setup
    await ensureDataDir();
    
    // Ensure all local files have base structure
    for (const key of Object.keys(FILES)) {
      try {
        await fs.access(FILES[key]);
      } catch {
        await writeJSON(FILES[key], []);
      }
    }

    // Default admin user check
    const users = await readJSON(FILES.users);
    const adminExists = users.some(u => u.username === 'admin');
    if (!adminExists) {
      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash('admin123', 10);
      users.push({
        username: 'admin',
        password: hash,
        role: 'admin',
        email: 'admin@fileshare.local',
        createdAt: new Date().toISOString(),
        quota: 10737418240, // 10 GB
        usedSpace: 0,
        status: 'active',
      });
      await writeJSON(FILES.users, users);
      console.log('Initialized default admin user: admin / admin123');
    }
  }
}

// ─── Users API ──────────────────────────────────────────────────────────────

async function getUsers() {
  if (isPG) {
    const res = await pool.query('SELECT * FROM users');
    return res.rows;
  } else {
    return await readJSON(FILES.users);
  }
}

async function getUserByUsername(username) {
  if (isPG) {
    const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    return res.rows[0] || null;
  } else {
    const users = await readJSON(FILES.users);
    return users.find(u => u.username === username) || null;
  }
}

async function createUser(userData) {
  if (isPG) {
    await pool.query(
      `INSERT INTO users (username, password, role, email, "createdAt", quota, "usedSpace", status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        userData.username,
        userData.password,
        userData.role || 'user',
        userData.email || '',
        userData.createdAt || new Date().toISOString(),
        userData.quota !== undefined ? userData.quota : 1073741824,
        userData.usedSpace !== undefined ? userData.usedSpace : 0,
        userData.status || 'active'
      ]
    );
  } else {
    const users = await readJSON(FILES.users);
    users.push(userData);
    await writeJSON(FILES.users, users);
  }
}

async function updateUser(username, updates) {
  if (isPG) {
    const fields = Object.keys(updates);
    if (fields.length === 0) {
      const res = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
      return res.rows[0];
    }
    const setClause = fields.map((field, idx) => `"${field}" = $${idx + 2}`).join(', ');
    const values = fields.map(field => updates[field]);
    const query = `UPDATE users SET ${setClause} WHERE username = $1 RETURNING *`;
    const res = await pool.query(query, [username, ...values]);
    if (res.rowCount === 0) throw new Error('User not found');
    return res.rows[0];
  } else {
    const users = await readJSON(FILES.users);
    const idx = users.findIndex(u => u.username === username);
    if (idx === -1) throw new Error('User not found');
    users[idx] = { ...users[idx], ...updates };
    await writeJSON(FILES.users, users);
    return users[idx];
  }
}

async function deleteUser(username) {
  if (isPG) {
    await pool.query('DELETE FROM users WHERE username = $1', [username]);
  } else {
    const users = await readJSON(FILES.users);
    const filtered = users.filter(u => u.username !== username);
    await writeJSON(FILES.users, filtered);
  }
}

// ─── Shares API ─────────────────────────────────────────────────────────────

async function getShares() {
  if (isPG) {
    const res = await pool.query('SELECT * FROM shares');
    return res.rows;
  } else {
    return await readJSON(FILES.shares);
  }
}

async function getShareByToken(token) {
  if (isPG) {
    const res = await pool.query('SELECT * FROM shares WHERE token = $1', [token]);
    return res.rows[0] || null;
  } else {
    const shares = await readJSON(FILES.shares);
    return shares.find(s => s.token === token) || null;
  }
}

async function createShare(shareData) {
  if (isPG) {
    await pool.query(
      `INSERT INTO shares (token, owner, "filePath", "absolutePath", "fileName", "createdAt", "expiresAt", "maxDownloads", "downloadCount", password)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        shareData.token,
        shareData.owner,
        shareData.filePath,
        shareData.absolutePath,
        shareData.fileName,
        shareData.createdAt || new Date().toISOString(),
        shareData.expiresAt,
        shareData.maxDownloads,
        shareData.downloadCount !== undefined ? shareData.downloadCount : 0,
        shareData.password
      ]
    );
  } else {
    const shares = await readJSON(FILES.shares);
    shares.push(shareData);
    await writeJSON(FILES.shares, shares);
  }
}

async function updateShare(token, updates) {
  if (isPG) {
    const fields = Object.keys(updates);
    if (fields.length === 0) {
      const res = await pool.query('SELECT * FROM shares WHERE token = $1', [token]);
      return res.rows[0];
    }
    const setClause = fields.map((field, idx) => `"${field}" = $${idx + 2}`).join(', ');
    const values = fields.map(field => updates[field]);
    const query = `UPDATE shares SET ${setClause} WHERE token = $1 RETURNING *`;
    const res = await pool.query(query, [token, ...values]);
    if (res.rowCount === 0) throw new Error('Share not found');
    return res.rows[0];
  } else {
    const shares = await readJSON(FILES.shares);
    const idx = shares.findIndex(s => s.token === token);
    if (idx === -1) throw new Error('Share not found');
    shares[idx] = { ...shares[idx], ...updates };
    await writeJSON(FILES.shares, shares);
    return shares[idx];
  }
}

async function deleteShare(token) {
  if (isPG) {
    await pool.query('DELETE FROM shares WHERE token = $1', [token]);
  } else {
    const shares = await readJSON(FILES.shares);
    const filtered = shares.filter(s => s.token !== token);
    await writeJSON(FILES.shares, filtered);
  }
}

async function getSharesByUser(username) {
  if (isPG) {
    const res = await pool.query('SELECT * FROM shares WHERE owner = $1', [username]);
    return res.rows;
  } else {
    const shares = await readJSON(FILES.shares);
    return shares.filter(s => s.owner === username);
  }
}

// ─── Logs API ───────────────────────────────────────────────────────────────

async function addLog(entry) {
  const details = { ...entry, timestamp: new Date().toISOString() };
  if (isPG) {
    await pool.query('INSERT INTO logs (details) VALUES ($1)', [JSON.stringify(details)]);
  } else {
    const logs = await readJSON(FILES.logs);
    logs.unshift(details);
    if (logs.length > 500) logs.pop(); // Cap logs to prevent sizing bloat
    await writeJSON(FILES.logs, logs);
  }
}

async function getLogs(limit = 100) {
  if (isPG) {
    const res = await pool.query('SELECT details FROM logs ORDER BY id DESC LIMIT $1', [limit]);
    return res.rows.map(r => r.details);
  } else {
    const logs = await readJSON(FILES.logs);
    return logs.slice(0, limit);
  }
}

async function getLogsByUser(username, limit = 50) {
  if (isPG) {
    const res = await pool.query(
      `SELECT details FROM logs
       WHERE details->>'username' = $1 OR details->>'by' = $1
       ORDER BY id DESC LIMIT $2`,
      [username, limit]
    );
    return res.rows.map(r => r.details);
  } else {
    const logs = await readJSON(FILES.logs);
    const filtered = logs.filter(l => l.username === username || l.by === username || l.target === username);
    return filtered.slice(0, limit);
  }
}

// ─── WorkDrive Collaborators API (Workspace Sharing) ─────────────────────────

async function addCollaborator(owner, filePath, collaborator, accessLevel) {
  const id = uuidv4();
  if (isPG) {
    await pool.query(
      `INSERT INTO collaborators (id, owner, "filePath", collaborator, "accessLevel")
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (owner, "filePath", collaborator)
       DO UPDATE SET "accessLevel" = EXCLUDED."accessLevel"`,
      [id, owner, filePath, collaborator, accessLevel]
    );
  } else {
    const colls = await readJSON(FILES.collaborators);
    const idx = colls.findIndex(c => c.owner === owner && c.filePath === filePath && c.collaborator === collaborator);
    if (idx !== -1) {
      colls[idx].accessLevel = accessLevel;
    } else {
      colls.push({ id, owner, filePath, collaborator, accessLevel });
    }
    await writeJSON(FILES.collaborators, colls);
  }
}

async function getCollaborators(owner, filePath) {
  if (isPG) {
    if (filePath) {
      const res = await pool.query(
        'SELECT * FROM collaborators WHERE owner = $1 AND "filePath" = $2',
        [owner, filePath]
      );
      return res.rows;
    } else {
      const res = await pool.query(
        'SELECT * FROM collaborators WHERE owner = $1',
        [owner]
      );
      return res.rows;
    }
  } else {
    const colls = await readJSON(FILES.collaborators);
    return colls.filter(c => c.owner === owner && (!filePath || c.filePath === filePath));
  }
}

async function removeCollaborator(owner, filePath, collaborator) {
  if (isPG) {
    await pool.query(
      'DELETE FROM collaborators WHERE owner = $1 AND "filePath" = $2 AND collaborator = $3',
      [owner, filePath, collaborator]
    );
  } else {
    const colls = await readJSON(FILES.collaborators);
    const filtered = colls.filter(c => !(c.owner === owner && c.filePath === filePath && c.collaborator === collaborator));
    await writeJSON(FILES.collaborators, filtered);
  }
}

async function getSharedWithMe(username) {
  if (isPG) {
    const res = await pool.query(
      'SELECT * FROM collaborators WHERE collaborator = $1',
      [username]
    );
    return res.rows;
  } else {
    const colls = await readJSON(FILES.collaborators);
    return colls.filter(c => c.collaborator === username);
  }
}

// ─── Recycle Bin (Trash Index) API ──────────────────────────────────────────

async function addTrashEntry(id, username, originalPath, trashPath) {
  const deletedAt = new Date().toISOString();
  if (isPG) {
    await pool.query(
      `INSERT INTO trash_index (id, username, "originalPath", "trashPath", "deletedAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [id, username, originalPath, trashPath, deletedAt]
    );
  } else {
    const trash = await readJSON(FILES.trash);
    trash.push({ id, username, originalPath, trashPath, deletedAt });
    await writeJSON(FILES.trash, trash);
  }
}

async function getTrashEntries(username) {
  if (isPG) {
    const res = await pool.query(
      'SELECT * FROM trash_index WHERE username = $1 ORDER BY "deletedAt" DESC',
      [username]
    );
    return res.rows;
  } else {
    const trash = await readJSON(FILES.trash);
    const filtered = trash.filter(t => t.username === username);
    return filtered.sort((a, b) => new Date(b.deletedAt) - new Date(a.deletedAt));
  }
}

async function getTrashEntryById(username, id) {
  if (isPG) {
    const res = await pool.query(
      'SELECT * FROM trash_index WHERE username = $1 AND id = $2',
      [username, id]
    );
    return res.rows[0] || null;
  } else {
    const trash = await readJSON(FILES.trash);
    return trash.find(t => t.username === username && t.id === id) || null;
  }
}

async function deleteTrashEntry(username, id) {
  if (isPG) {
    await pool.query(
      'DELETE FROM trash_index WHERE username = $1 AND id = $2',
      [username, id]
    );
  } else {
    const trash = await readJSON(FILES.trash);
    const filtered = trash.filter(t => !(t.username === username && t.id === id));
    await writeJSON(FILES.trash, filtered);
  }
}

module.exports = {
  init,
  getUsers,
  getUserByUsername,
  createUser,
  updateUser,
  deleteUser,
  getShares,
  getShareByToken,
  createShare,
  updateShare,
  deleteShare,
  getSharesByUser,
  addLog,
  getLogs,
  getLogsByUser,

  // Collaboration
  addCollaborator,
  getCollaborators,
  removeCollaborator,
  getSharedWithMe,

  // Recycle Bin
  addTrashEntry,
  getTrashEntries,
  getTrashEntryById,
  deleteTrashEntry,
};

