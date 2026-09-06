'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { DatabaseSync } = require('node:sqlite');

let _db = null;

function getDb() {
    if (_db) return _db;
    const dbPath = process.env.WA_DB_PATH;
    if (!dbPath) throw new Error('WA_DB_PATH not set in .env');
    _db = new DatabaseSync(dbPath);
    _db.exec('PRAGMA journal_mode = WAL');
    // Tanpa ini, default busy_timeout SQLite di node:sqlite adalah 0 — begitu
    // Flask (Python, busy_timeout=30000) sedang menulis ke wa.db di saat yang
    // sama, tulisan Node langsung ditolak "database is locked" alih-alih
    // menunggu. updateMessageStatus() menelan error itu diam-diam, sehingga
    // pesan yang SUDAH terkirim ke WhatsApp tetap tercatat 'queued' selamanya
    // di /wa/log/. Samakan dengan sisi Python.
    _db.exec('PRAGMA busy_timeout = 30000');
    return _db;
}

function updateMessageStatus(msgId, status, errorMsg) {
    try {
        const db = getDb();
        if (status === 'sent') {
            db.prepare(
                "UPDATE wa_message SET status='sent', sent_at=datetime('now') WHERE id=?"
            ).run(msgId);
        } else if (status === 'failed') {
            db.prepare(
                "UPDATE wa_message SET status='failed', error_msg=? WHERE id=?"
            ).run(errorMsg || 'Unknown error', msgId);
        }
    } catch (err) {
        console.error('[DB] updateMessageStatus error:', err.message);
    }
}

function getQueuedMessages() {
    try {
        const db = getDb();
        return db.prepare(
            "SELECT id, recipient, message FROM wa_message WHERE status='queued' ORDER BY queued_at"
        ).all();
    } catch (err) {
        console.error('[DB] getQueuedMessages error:', err.message);
        return [];
    }
}

module.exports = { getDb, updateMessageStatus, getQueuedMessages };
