/**
 * db.js - Async JSON file-based database
 * Handles users, shares, and server logs with atomic writes.
 */
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = process.env.VERCEL
  ? path.join('/tmp', 'data')
  : path.join(__dirname, 'data');

const FILES = {
  users: path.join(DATA_DIR, 'users.json'),
  shares: path.join(DATA_DIR, 'shares.json'),
  logs: path.join(DATA_DIR, 'logs.json'),
};

const SRC_DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory and files exist
async function init() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  for (const [key, filePath] of Object.entries(FILES)) {
    try {
      await fs.access(filePath);
    } catch {
      let copied = false;
      if (process.env.VERCEL) {
        try {
          const srcFilePath = path.join(SRC_DATA_DIR, `${key}.json`);
          await fs.access(srcFilePath);
          const data = await fs.readFile(srcFilePath, 'utf-8');
          await fs.writeFile(filePath, data, 'utf-8');
          copied = true;
        } catch (_) {}
      }

      if (!copied) {
        let defaultData;
        if (key === 'users') {
          // Create default admin user (password: admin123)
          const bcrypt = require('bcryptjs');
          const hash = await bcrypt.hash('admin123', 10);
          defaultData = [
            {
              username: 'admin',
              password: hash,
              role: 'admin',
              email: 'admin@fileshare.local',
              createdAt: new Date().toISOString(),
              quota: 10737418240, // 10 GB
              usedSpace: 0,
              status: 'active',
            },
          ];
        } else {
          defaultData = [];
        }
        await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), 'utf-8');
      }
    }
  }
}

// Safely read a JSON file
async function read(key) {
  const filePath = FILES[key];
  const raw = await fs.readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

// Atomically write to a JSON file
async function write(key, data) {
  const filePath = FILES[key];
  const tmp = filePath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmp, filePath);
}

// ─── Users ──────────────────────────────────────────────────────────────────

async function getUsers() {
  return read('users');
}

async function getUserByUsername(username) {
  const users = await getUsers();
  return users.find((u) => u.username === username) || null;
}

async function createUser(userData) {
  const users = await getUsers();
  users.push(userData);
  await write('users', users);
}

async function updateUser(username, updates) {
  const users = await getUsers();
  const idx = users.findIndex((u) => u.username === username);
  if (idx === -1) throw new Error('User not found');
  users[idx] = { ...users[idx], ...updates };
  await write('users', users);
  return users[idx];
}

async function deleteUser(username) {
  const users = await getUsers();
  const filtered = users.filter((u) => u.username !== username);
  await write('users', filtered);
}

// ─── Shares ─────────────────────────────────────────────────────────────────

async function getShares() {
  return read('shares');
}

async function getShareByToken(token) {
  const shares = await getShares();
  return shares.find((s) => s.token === token) || null;
}

async function createShare(shareData) {
  const shares = await getShares();
  shares.push(shareData);
  await write('shares', shares);
}

async function updateShare(token, updates) {
  const shares = await getShares();
  const idx = shares.findIndex((s) => s.token === token);
  if (idx === -1) throw new Error('Share not found');
  shares[idx] = { ...shares[idx], ...updates };
  await write('shares', shares);
  return shares[idx];
}

async function deleteShare(token) {
  const shares = await getShares();
  await write('shares', shares.filter((s) => s.token !== token));
}

async function getSharesByUser(username) {
  const shares = await getShares();
  return shares.filter((s) => s.owner === username);
}

// ─── Logs ────────────────────────────────────────────────────────────────────

async function addLog(entry) {
  const logs = await read('logs');
  logs.unshift({ ...entry, timestamp: new Date().toISOString() });
  // Keep only the last 500 log entries
  if (logs.length > 500) logs.splice(500);
  await write('logs', logs);
}

async function getLogs(limit = 100) {
  const logs = await read('logs');
  return logs.slice(0, limit);
}

// Get logs filtered by a specific user
async function getLogsByUser(username, limit = 50) {
  const logs = await read('logs');
  return logs.filter(l => l.username === username || l.by === username).slice(0, limit);
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
};
