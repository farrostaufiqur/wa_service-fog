'use strict';
const express = require('express');
const router  = express.Router();
const { getSessions, getSession } = require('../sessions');
const { enqueue }                 = require('../queue');
const { getDb }                   = require('../db');

function _pickSession(preferred) {
    const sessions = getSessions();
    if (preferred) {
        const s = sessions[preferred];
        if (s && s.status === 'connected') return preferred;
    }
    // Round-robin across connected sessions
    const active = Object.keys(sessions).filter(k => sessions[k].status === 'connected');
    if (active.length === 0) return null;
    // Use a simple counter stored on module
    _pick._rr = ((_pick._rr || 0) + 1) % active.length;
    return active[_pick._rr];
}
function _pick() {}

function _insertMessage(sessionKey, to, message, ruleId, scheduleId) {
    try {
        const db = getDb();
        // Lookup session id from wa_session table
        const sess = db.prepare('SELECT id FROM wa_session WHERE session_key=?').get(sessionKey);
        const sessId = sess ? sess.id : null;
        const stmt = db.prepare(`
            INSERT INTO wa_message (session_id, recipient, message, status, queued_at, rule_id, schedule_id)
            VALUES (?, ?, ?, 'queued', datetime('now'), ?, ?)
        `);
        const result = stmt.run(sessId, to, message, ruleId || null, scheduleId || null);
        return result.lastInsertRowid;
    } catch (err) {
        console.error('[DB] insertMessage error:', err.message);
        return null;
    }
}

// POST /send — single message {to, message, session_key?, msg_id?, rule_id?, schedule_id?}
router.post('/', (req, res) => {
    const { to, message, session_key, msg_id, rule_id, schedule_id } = req.body;
    if (!to || !message) return res.status(400).json({ error: 'to and message required' });

    const key = _pickSession(session_key);
    if (!key) return res.status(503).json({ error: 'No active WA session' });

    // If msg_id provided (already in DB), use it. Otherwise insert new record.
    const msgId = msg_id || _insertMessage(key, to, message, rule_id, schedule_id);
    enqueue(key, { msgId, to, message });
    res.json({ ok: true, msg_id: msgId, session: key });
});

// POST /send-bulk — {messages:[{to,message,msg_id?,rule_id?,schedule_id?}], session_key?}
router.post('/bulk', (req, res) => {
    const { messages, session_key } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
        return res.status(400).json({ error: 'messages array required' });
    }

    const sessions = getSessions();
    const active = session_key
        ? (sessions[session_key]?.status === 'connected' ? [session_key] : [])
        : Object.keys(sessions).filter(k => sessions[k].status === 'connected');

    if (active.length === 0) return res.status(503).json({ error: 'No active WA session' });

    const results = [];
    for (let i = 0; i < messages.length; i++) {
        const { to, message, msg_id, rule_id, schedule_id } = messages[i];
        if (!to || !message) { results.push({ error: 'missing to or message' }); continue; }
        const key = active[i % active.length];
        const msgId = msg_id || _insertMessage(key, to, message, rule_id, schedule_id);
        enqueue(key, { msgId, to, message });
        results.push({ ok: true, msg_id: msgId, session: key });
    }
    res.json({ ok: true, count: results.length, results });
});

module.exports = router;
