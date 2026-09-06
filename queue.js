'use strict';
const { updateMessageStatus } = require('./db');

// Jeda antar pesan keluar (anti-spam / anti-lockout WA). Jeda aktual per pesan =
// WA_SEND_DELAY_MS + acak(0 .. WA_SEND_JITTER_MS), dihitung SETELAH pesan
// sebelumnya selesai terkirim. Atur lewat .env.
const DELAY_MS  = parseInt(process.env.WA_SEND_DELAY_MS  || '30000', 10); // minimal 30 dtk
const JITTER_MS = parseInt(process.env.WA_SEND_JITTER_MS || '60000', 10); // + acak s/d 60 dtk -> 30..90 dtk
const MAX_RETRY = 3;

function _nextDelay() {
    return DELAY_MS + Math.floor(Math.random() * (JITTER_MS + 1));
}

// Per-session queues: key → { items: [...], timer, active }
const _queues = {};

// msg_id yang lagi ada di salah satu antrian memori (belum sent/failed final).
// Dipakai recovery.js supaya tidak enqueue dobel saat re-cek pesan 'queued'
// tiap kali ada sesi yang connect — tanpa ini, pesan yang memang masih
// menunggu giliran (belum sempat diproses) bisa ke-enqueue dua kali dan
// terkirim dobel.
const _enqueuedIds = new Set();

function _getOrCreate(key) {
    if (!_queues[key]) {
        _queues[key] = { items: [], timer: null, active: false, _running: false, _sock: null };
    }
    return _queues[key];
}

function enqueue(key, item) {
    // item: { msgId, to, message, retries }
    const q = _getOrCreate(key);
    q.items.push({ retries: 0, ...item });
    _enqueuedIds.add(item.msgId);
}

function isEnqueued(msgId) {
    return _enqueuedIds.has(msgId);
}

function startQueue(key, sock) {
    const q = _getOrCreate(key);
    q.active = true;
    q._sock = sock;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
    _tick(key); // kirim item pertama segera, lalu jadwalkan sisanya dgn jeda acak
}

function pauseQueue(key) {
    const q = _queues[key];
    if (!q) return;
    q.active = false;
    if (q.timer) { clearTimeout(q.timer); q.timer = null; }
}

// Loop yang menjadwalkan dirinya sendiri: proses 1 pesan, lalu setTimeout jeda
// baru (acak) sebelum tick berikutnya. Menggantikan setInterval tetap 30 dtk
// supaya jeda antar pesan lebih panjang + bervariasi (tidak seragam seperti bot).
async function _tick(key) {
    const q = _queues[key];
    if (!q || !q.active || q._running) return; // cegah loop dobel saat reconnect
    q._running = true;
    q.timer = null;
    try {
        if (q.items.length > 0) {
            await _processNext(key, q._sock);
        }
    } finally {
        q._running = false;
        if (q.active && !q.timer) {
            q.timer = setTimeout(() => _tick(key), _nextDelay());
        }
    }
}

async function _processNext(key, sock) {
    const q = _queues[key];
    if (!q || !q.active || q.items.length === 0) return;

    const item = q.items.shift();
    try {
        // item.to is either a bare phone number (personal chat) or a full JID
        // (e.g. '1203xxxx@g.us' for a group) — only bare numbers need the suffix.
        const jid = item.to.includes('@') ? item.to : item.to + '@s.whatsapp.net';
        await sock.sendMessage(jid, { text: item.message });
        updateMessageStatus(item.msgId, 'sent');
        _enqueuedIds.delete(item.msgId);
        console.log(`[WA] Sent to ${item.to} (msg ${item.msgId})`);
    } catch (err) {
        item.retries = (item.retries || 0) + 1;
        if (item.retries < MAX_RETRY) {
            q.items.unshift(item); // retry: put back at front (masih di _enqueuedIds)
            console.warn(`[WA] Retry ${item.retries}/${MAX_RETRY} for msg ${item.msgId}: ${err.message}`);
        } else {
            updateMessageStatus(item.msgId, 'failed', err.message);
            _enqueuedIds.delete(item.msgId);
            console.error(`[WA] Failed after ${MAX_RETRY} retries (msg ${item.msgId}): ${err.message}`);
        }
    }
}

function getQueueStatus() {
    const result = {};
    for (const [key, q] of Object.entries(_queues)) {
        result[key] = { pending: q.items.length, active: q.active };
    }
    return result;
}

function getQueue(key) { return _queues[key] || null; }

module.exports = { enqueue, startQueue, pauseQueue, getQueue, getQueueStatus, isEnqueued };
