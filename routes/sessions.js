'use strict';
const express = require('express');
const router  = express.Router();
const { getSessions, getSession, createSession, deleteSession, resetSession, fetchGroups } = require('../sessions');

// GET /sessions — list all
router.get('/', (req, res) => {
    const sessions = getSessions();
    const result = Object.entries(sessions).map(([key, s]) => ({
        key,
        label:    s.label,
        status:   s.status,
        phone:    s.phone,
        has_qr:   !!s.qrBase64,
        version:  s.version || null,
        version_sumber: s.versionSumber || null,
    }));
    res.json(result);
});

// GET /sessions/:key/qr — QR code base64
router.get('/:key/qr', (req, res) => {
    const s = getSession(req.params.key);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (!s.qrBase64) return res.status(204).send(); // no QR available
    res.json({ qr: s.qrBase64, status: s.status });
});

// GET /sessions/:key/status — single session status
router.get('/:key/status', (req, res) => {
    const s = getSession(req.params.key);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    res.json({ key: req.params.key, status: s.status, phone: s.phone, label: s.label });
});

// GET /sessions/:key/groups — list WhatsApp groups this session participates in
router.get('/:key/groups', async (req, res) => {
    const s = getSession(req.params.key);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    if (s.status !== 'connected') return res.status(503).json({ error: 'Session not connected' });
    try {
        const groups = await fetchGroups(req.params.key);
        res.json(groups || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /sessions — create session {key, label}
router.post('/', async (req, res) => {
    const { key, label } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) return res.status(400).json({ error: 'key must be alphanumeric/dash/underscore' });
    try {
        const s = await createSession(key, label || key);
        res.json({ key, label: s.label, status: s.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /sessions/:key — logout + remove
router.delete('/:key', async (req, res) => {
    try {
        await deleteSession(req.params.key);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /sessions/:key/reset — hapus kredensial lokal & mulai pairing baru (QR baru),
// tanpa perlu membuat ulang session key/label dari nol
router.post('/:key/reset', async (req, res) => {
    const s = getSession(req.params.key);
    if (!s) return res.status(404).json({ error: 'Session not found' });
    try {
        const fresh = await resetSession(req.params.key);
        res.json({ ok: true, key: req.params.key, status: fresh.status });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
