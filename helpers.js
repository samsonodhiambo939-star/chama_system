// Shared helpers: audit logging, notifications, and maker-checker approval rights.
// Required explicitly by server.js and routes/* (do NOT rely on globals).
const db = require('./db');

async function auditLog(user, action, entityType, entityId, details) {
  try {
    await db.prepare(
      "INSERT INTO audit_logs (user_id, username, action, entity_type, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(user && user.id, user && user.username, action, entityType, entityId || null, details || null);
  } catch (e) {
    console.error('auditLog error:', e.message);
  }
}

async function notify(memberId, title, message, type, link) {
  try {
    await db.prepare(
      "INSERT INTO notifications (member_id, title, message, type, link) VALUES (?, ?, ?, ?, ?)"
    ).run(memberId, title, message, type || 'info', link || null);
  } catch (e) {
    console.error('notify error:', e.message);
  }
}

// Cross-approval helper (chairman/treasurer must not approve their own transaction).
// Returns { ok: true } or { ok: false, reason: '...' }
function checkApprovalRight(user, record) {
  if (!user || user.role !== 'admin') return { ok: false, reason: 'Only an admin can approve this.' };
  if (!record) return { ok: false, reason: 'Record not found.' };
  if (!record.created_by) return { ok: true }; // legacy record with no creator: allow
  if (Number(record.created_by) === Number(user.id)) return { ok: false, reason: 'You cannot approve a transaction you entered yourself. Ask the other signatory to approve it.' };
  // Super-admin without a specific admin_role keeps full approval rights (prevents deadlock).
  if (!user.admin_role) return { ok: true };
  if (record.created_by_role === 'chairman' && user.admin_role !== 'treasurer') return { ok: false, reason: 'This transaction was entered by the chairman. Only the treasurer may approve it.' };
  if (record.created_by_role === 'treasurer' && user.admin_role !== 'chairman') return { ok: false, reason: 'This transaction was entered by the treasurer. Only the chairman may approve it.' };
  return { ok: true };
}

module.exports = { auditLog, notify, checkApprovalRight };
