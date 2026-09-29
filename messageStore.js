'use strict';
// Simpan isi pesan yang baru saja dikirim, dipakai untuk menjawab permintaan
// "retry" dari WhatsApp saat HP penerima gagal dekripsi pesan di percobaan
// pertama (hal yang lumrah terjadi, bukan cuma saat error). Tanpa callback
// getMessage yang bisa mengembalikan isi aslinya, Baileys tidak sanggup
// mengirim ulang plaintext-nya, sehingga penerima terus melihat
// "Waiting for this message. This may take a while." tanpa pernah selesai.
const MAX_AGE_MS = 10 * 60 * 1000; // retry WA biasanya datang dalam hitungan detik-menit

const _store = new Map(); // waMessageId -> { content, ts }

function remember(id, content) {
    if (!id) return;
    _store.set(id, { content, ts: Date.now() });
    _cleanup();
}

function get(id) {
    const entry = _store.get(id);
    return entry ? entry.content : null;
}

function _cleanup() {
    const cutoff = Date.now() - MAX_AGE_MS;
    for (const [id, entry] of _store) {
        if (entry.ts < cutoff) _store.delete(id);
    }
}

module.exports = { remember, get };
