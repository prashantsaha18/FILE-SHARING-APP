/**
 * services/protocolService.js - Modular Network Protocol Configuration Service
 * Exports dynamic, host-compliant configuration maps for Samba (SMB) and NFS,
 * alongside admin deployment synchronization script bundles.
 */
const db = require('../db');
const fm = require('../fileManager');
const path = require('path');

/**
 * Formats a standard NFS exports config block based on virtual database mappings.
 */
async function generateNFSExports() {
  const exports = await db.getAllNFSExports();
  const activeExports = exports.filter(e => e.active !== false);

  if (!activeExports.length) {
    return "# NexDrop Virtual NFS Export Map\n# No active NFS exports configured in dashboard.\n";
  }

  let lines = [
    "# ─── NexDrop Dynamic NFS exports ──────────────────────────────────────────",
    "# Generated automatically by NexDrop file server configuration manager.",
    "# Copy this contents to /etc/exports on your Linux host machine.",
    ""
  ];

  for (const exp of activeExports) {
    try {
      const absPath = fm.getAbsolutePath(exp.owner, exp.filePath).replace(/\\/g, '/');
      const ips = exp.allowedIPs || '*';
      const mode = exp.accessLevel === 'rw' ? 'rw' : 'ro';
      const squash = exp.squash || 'root_squash';

      lines.push(`"${absPath}" ${ips}(${mode},${squash},sync,no_subtree_check,crossmnt)`);
    } catch (_) {
      // Skip path resolution errors
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * Formats a fully valid Samba (smb.conf) config file matching dashboards shares.
 */
async function generateSMBConfig() {
  const shares = await db.getAllSMBShares();
  const activeShares = shares.filter(s => s.active !== false);

  let output = [
    "# ===========================================================================",
    "# NexDrop Samba (SMB/CIFS) Dynamic Configurations Mapping",
    "# Automatically compiled by NexDrop Service Exporter.",
    "# Copy these definitions directly into your host machine's /etc/samba/smb.conf",
    "# ===========================================================================",
    "",
    "[global]",
    "   workgroup = WORKGROUP",
    "   server string = NexDrop Secure Storage Share Host",
    "   security = user",
    "   map to guest = Bad User",
    "   log file = /var/log/samba/log.%m",
    "   max log size = 1000",
    "   client min protocol = SMB2",
    "   server min protocol = SMB2",
    "   load printers = no",
    "   printing = bsd",
    ""
  ];

  for (const sh of activeShares) {
    try {
      const absPath = fm.getAbsolutePath(sh.owner, sh.filePath).replace(/\\/g, '/');
      const readOnly = sh.accessLevel === 'rw' ? 'no' : 'yes';
      const guestOk = sh.guestOk ? 'yes' : 'no';

      output.push(`[${sh.shareName}]`);
      output.push(`   comment = ${sh.comment || 'NexDrop Virtual Share Mapping'}`);
      output.push(`   path = ${absPath}`);
      output.push(`   read only = ${readOnly}`);
      output.push(`   guest ok = ${guestOk}`);
      output.push(`   browseable = yes`);
      output.push(`   create mask = 0664`);
      output.push(`   directory mask = 0775`);
      output.push(`   force group = staff`);
      output.push("");
    } catch (_) {
      // Skip path resolution errors
    }
  }

  return output.join('\n');
}

/**
 * Compiles a production-grade Bash deployment script to sync configs on a host Linux server.
 */
async function generateSyncScript() {
  return `#!/usr/bin/env bash
# ==============================================================================
# nexdrop-sync-protocols.sh - NexDrop Protocols Auto-Synchronization Script
# Installs and updates host Samba and NFS parameters to align with database exports.
# Runs dynamically under root sudo contexts.
# ==============================================================================

# Strictly enforce running as root
if [ "$EUID" -ne 0 ]; then
  echo "❌ Error: This script must be run as root (sudo)."
  exit 1
fi

echo "🔄 Initiating NexDrop Host Protocol Synchronization..."

# --- Setup Directories & Backups ---
TIMESTAMP=$(date +%Y%m%d%H%M%S)
BACKUP_DIR="/etc/nexdrop/backups/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"
echo "📂 Created backup logs directory: $BACKUP_DIR"

# --- 1. Sync NFS Exports ---
if [ -f "/etc/exports" ]; then
  cp /etc/exports "$BACKUP_DIR/exports.bak"
  echo "🛡️ Backed up active NFS /etc/exports"
fi

# Fetch exports block directly from the local server instance
# (Overridden locally during file writing scripts)
cat << 'EOF' > /etc/exports.new
# --- NexDrop Configs Start ---
${await generateNFSExports()}
# --- NexDrop Configs End ---
EOF

# Merge or write cleanly
mv /etc/exports.new /etc/exports
chmod 644 /etc/exports

# Reload NFS system daemons
if command -v exportfs &> /dev/null; then
  exportfs -ra
  echo "✅ Synchronized host NFS exports (/etc/exports) and reloaded mappings."
else
  echo "⚠️ Warning: exportfs command not found. Install nfs-kernel-server package."
fi

# --- 2. Sync Samba Configuration ---
if [ -f "/etc/samba/smb.conf" ]; then
  cp /etc/samba/smb.conf "$BACKUP_DIR/smb.conf.bak"
  echo "🛡️ Backed up active Samba /etc/samba/smb.conf"
fi

cat << 'EOF' > /etc/samba/smb.conf.new
${await generateSMBConfig()}
EOF

mv /etc/samba/smb.conf.new /etc/samba/smb.conf
chmod 644 /etc/samba/smb.conf

# Reload Samba Configurations safely
if command -v smbcontrol &> /dev/null; then
  smbcontrol all reload-config &> /dev/null
  echo "✅ Synchronized Samba SMB Shares and updated live daemon blocks."
elif command -v systemctl &> /dev/null; then
  systemctl restart smbd &> /dev/null
  echo "✅ Restarted Samba smbd daemon services."
else
  echo "⚠️ Warning: Samba service controllers not found. Install standard samba package."
fi

echo "🎉 Protocol synchronization complete! Mappings align with NexDrop configurations."
`;
}

module.exports = {
  generateNFSExports,
  generateSMBConfig,
  generateSyncScript
};
