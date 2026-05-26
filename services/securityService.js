/**
 * services/securityService.js - Modular Security Service
 * Manages active ransomware threat prevention, custom shield settings,
 * scheduled system backups, and backup storage retention policies.
 */
const db = require('../db');
const fm = require('../fileManager');

// Standard dangerous extensions
const DEFAULT_RANSOM_EXTS = [
  'locked', 'crypto', 'crypt', 'enc', 'encrypted', 'wannacry', 'wcry', 'wncry',
  'cerber', 'locky', 'petya', 'notpetya', 'ryuk', 'sodinokibi', 'revil', 'maze',
  'netwalker', 'darkside', 'blackcat', 'alphv', 'lockbit', 'conti', 'hive'
];

// In-memory sliding window cache: { username: [timestamp, ...] }
const _writeActivity = {};
let _schedulerIntervalId = null;

/**
 * Tracks and checks write operations against a sliding-window velocity threshold.
 */
function trackWrite(username, windowMs) {
  const now = Date.now();
  if (!_writeActivity[username]) _writeActivity[username] = [];
  _writeActivity[username].push(now);
  // Keep only timestamps within the sliding window
  _writeActivity[username] = _writeActivity[username].filter(t => now - t < windowMs);
  return _writeActivity[username].length;
}

/**
 * Active Threat Checker: Validates extensions and activity limits.
 * Rejects operations and quarantines the account if threats are detected.
 */
async function checkThreats(username, fileNames = []) {
  const shieldEnabled = await db.getSystemSetting('ransomwareShield', true);
  if (!shieldEnabled) return;

  // Retrieve customized limits from settings
  const rawExts = await db.getSystemSetting('ransomwareExts', DEFAULT_RANSOM_EXTS);
  const blockedExts = new Set(Array.isArray(rawExts) ? rawExts : DEFAULT_RANSOM_EXTS);

  const velocityLimit = parseInt(await db.getSystemSetting('ransomwareVelocity', 15)) || 15;
  const windowSecs = parseInt(await db.getSystemSetting('ransomwareWindow', 10)) || 10;
  const windowMs = windowSecs * 1000;

  // 1. Extension Verification
  for (const name of fileNames) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    if (blockedExts.has(ext)) {
      await db.updateUser(username, { status: 'suspended' });
      await db.unlockAllByUser(username); // Safety unlock
      await db.addLog({
        action: 'security_threat',
        username,
        reason: `Ransomware extension detected: .${ext}`,
        file: name,
        severity: 'CRITICAL',
      });
      throw new Error(`🛡️ RANSOMWARE SHIELD: Suspicious extension ".${ext}" detected. Account suspended.`);
    }
  }

  // 2. Velocity Verification
  const count = trackWrite(username, windowMs);
  if (count > velocityLimit) {
    await db.updateUser(username, { status: 'suspended' });
    await db.unlockAllByUser(username); // Safety unlock
    await db.addLog({
      action: 'security_threat',
      username,
      reason: `Abnormal write velocity: ${count} writes in ${windowSecs}s (limit: ${velocityLimit})`,
      severity: 'HIGH',
    });
    throw new Error(`🛡️ RANSOMWARE SHIELD: Rapid writes detected (${count} ops/${windowSecs}s). Account suspended.`);
  }
}

/**
 * Retention Policy Cleaner: Safely removes oldest system backups beyond the limit.
 */
async function cleanOldBackups() {
  try {
    const retentionLimit = parseInt(await db.getSystemSetting('backupRetentionCount', 5)) || 5;
    const backups = await fm.listBackups();
    if (backups.length <= retentionLimit) return;

    const toDelete = backups.slice(retentionLimit); // Get oldest backups beyond limit
    for (const bk of toDelete) {
      await fm.deleteBackup(bk.name);
      await db.addLog({
        action: 'backup_auto_prune',
        username: 'system',
        backup: bk.name,
        comment: `Pruned oldest backup automatically (retention limit: ${retentionLimit})`
      });
    }
  } catch (err) {
    console.error('Backup retention cleaning failed:', err);
  }
}

/**
 * Triggers a manual or scheduled backup with auto-pruning.
 */
async function triggerBackup() {
  try {
    const res = await fm.createBackup();
    await db.addLog({ action: 'backup_create_auto', username: 'system', backup: res.name });
    // Invoke clean retention
    await cleanOldBackups();
    return res;
  } catch (err) {
    console.error('Scheduled backup creation failed:', err);
    throw err;
  }
}

/**
 * Initializes/resets the scheduled auto-backup background runner loop.
 */
async function initScheduler() {
  // Clear any existing active schedule
  if (_schedulerIntervalId) {
    clearInterval(_schedulerIntervalId);
    _schedulerIntervalId = null;
  }

  const intervalHours = parseFloat(await db.getSystemSetting('backupIntervalHours', 0)) || 0;
  if (intervalHours <= 0) {
    console.log('🕒 NexDrop Scheduler: Auto-backups are disabled (interval = 0).');
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  console.log(`🕒 NexDrop Scheduler: Registered auto-backups every ${intervalHours} hours.`);

  _schedulerIntervalId = setInterval(async () => {
    console.log('🕒 NexDrop Scheduler: Triggering automated recurring backup...');
    try {
      await triggerBackup();
    } catch (_) {}
  }, intervalMs);
}

module.exports = {
  checkThreats,
  cleanOldBackups,
  triggerBackup,
  initScheduler,
  DEFAULT_RANSOM_EXTS
};
