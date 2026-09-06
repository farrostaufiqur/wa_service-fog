'use strict';
const { getQueuedMessages } = require('./db');
const { enqueue, isEnqueued } = require('./queue');
const { getSessions }       = require('./sessions');

// Dipanggil sekali 10 detik setelah service nyala (index.js) DAN setiap kali
// sebuah sesi WA jadi 'connected' (sessions.js) — bukan cuma sekali di awal.
// Sebelumnya recovery cuma jalan sekali; kalau saat itu belum ada sesi yang
// connected (masih reconnect/QR), baris 'queued' ditinggal selamanya sampai
// service di-restart lagi. isEnqueued() mencegah baris yang memang masih
// menunggu giliran di antrian memori ikut di-enqueue dobel di sini.
function recoverQueued() {
    const rows = getQueuedMessages().filter(r => !isEnqueued(r.id));
    if (rows.length === 0) return;

    const sessions = getSessions();
    const activeKeys = Object.keys(sessions).filter(k => sessions[k].status === 'connected');
    if (activeKeys.length === 0) {
        console.log(`[Recovery] ${rows.length} queued messages waiting — no active sessions yet`);
        return;
    }

    let idx = 0;
    for (const row of rows) {
        const key = activeKeys[idx % activeKeys.length];
        enqueue(key, { msgId: row.id, to: row.recipient, message: row.message });
        idx++;
    }
    console.log(`[Recovery] Re-enqueued ${rows.length} queued messages across ${activeKeys.length} sessions`);
}

module.exports = { recoverQueued };
