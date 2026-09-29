'use strict';
const path = require('path');
const fs   = require('fs');
const {
    makeWASocket,
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    fetchLatestWaWebVersion,
    Browsers,
} = require('@whiskeysockets/baileys');
const pino   = require('pino');
const QRCode = require('qrcode');
const { getQueue, startQueue, pauseQueue } = require('./queue');
const { handleIncomingMessages } = require('./incoming');
const { get: getStoredMessage } = require('./messageStore');

const SESSIONS_DIR = path.join(__dirname, 'sessions');
const MAX_RECONNECT_ATTEMPTS = 5;   // berturut-turut gagal sebelum berhenti auto-retry
const RECONNECT_BASE_MS      = 5_000;   // jeda percobaan pertama
const RECONNECT_MAX_MS       = 300_000; // batas atas jeda (5 menit)
const STABLE_AFTER_MS        = 60_000;  // koneksi dianggap "benar-benar stabil" setelah ini

// In-memory registry: key → { socket, status, phone, qrBase64, label }
const _sessions = {};
// Hitungan gagal-connect berturut-turut per key — terpisah dari _sessions
// karena _reconnect() menghapus & membuat ulang entri _sessions setiap retry.
const _reconnectAttempts = {};
// Timer "koneksi sudah stabil" per key (lihat _scheduleStableReset).
const _stableTimers = {};

// Jeda reconnect naik bertahap: 5s, 10s, 20s, 40s, 80s (+jitter acak).
// Dulu jedanya tetap 5 detik tanpa batas — saat WhatsApp balas 503 (gangguan
// sementara di sisi mereka), service menghantam server ratusan kali sampai
// WhatsApp menaikkan penolakan jadi 405 (blokir klien) yang bertahan lama.
function _reconnectDelay(attempt) {
    const backoff = Math.min(RECONNECT_BASE_MS * 2 ** (attempt - 1), RECONNECT_MAX_MS);
    return backoff + Math.floor(Math.random() * 1_000);
}

// Penghitung gagal hanya di-reset kalau koneksi bertahan cukup lama. Kalau
// sesi cuma "kedip" (open lalu close beberapa detik kemudian), penghitung
// dibiarkan naik supaya backoff makin panjang dan cap tetap tercapai —
// persis pola connect→503→connect→503 yang memicu blokir pagi ini.
function _scheduleStableReset(key) {
    if (_stableTimers[key]) clearTimeout(_stableTimers[key]);
    _stableTimers[key] = setTimeout(() => {
        _reconnectAttempts[key] = 0;
        delete _stableTimers[key];
    }, STABLE_AFTER_MS);
}

function _cancelStableReset(key) {
    if (_stableTimers[key]) {
        clearTimeout(_stableTimers[key]);
        delete _stableTimers[key];
    }
}

// Nomor versi klien yang diklaim ke server WhatsApp.
//
// WAJIB diambil dari web.whatsapp.com (client_revision di sw.js), BUKAN dari
// fetchLatestBaileysVersion() yang membaca repo GitHub Baileys — angka di repo
// itu di-update manual oleh maintainer dan bisa tertinggal jauh. Insiden
// 2026-07-29: WhatsApp menaikkan versi minimum semalam; repo Baileys masih
// 1035194821 sementara WA Web asli sudah 1044017588, dan semua koneksi ditolak
// "Connection Failure reason 405" — termasuk pairing baru, sehingga QR pun tak
// pernah muncul. Terbukti: versi asli → QR keluar, versi repo → 405.
// Versi terakhir yang TERBUKTI berhasil connect, disimpan ke disk. Dipakai
// sebagai cadangan bila web.whatsapp.com tidak bisa dibaca — jauh lebih aman
// daripada langsung jatuh ke repo Baileys yang bisa basi berbulan-bulan.
const LAST_GOOD_VERSION_FILE = path.join(__dirname, 'last-good-version.json');

function _readLastGoodVersion() {
    try {
        const d = JSON.parse(fs.readFileSync(LAST_GOOD_VERSION_FILE, 'utf8'));
        if (Array.isArray(d.version) && d.version.length === 3) return d;
    } catch (_) {}
    return null;
}

function _saveLastGoodVersion(version) {
    const prev = _readLastGoodVersion();
    if (prev && prev.version.join('.') === version.join('.')) return; // tidak berubah
    try {
        fs.writeFileSync(LAST_GOOD_VERSION_FILE,
            JSON.stringify({ version, tercatat: new Date().toISOString() }, null, 2));
        console.log(`[WA] Versi klien ${version.join('.')} tercatat sebagai versi terakhir yang berhasil.`);
    } catch (err) {
        console.warn('[WA] Gagal menyimpan last-good-version:', err.message);
    }
}

async function _waVersion() {
    try {
        const r = await fetchLatestWaWebVersion({});
        if (r?.version && !r.error) return { version: r.version, sumber: 'web.whatsapp.com' };
        if (r?.error) {
            console.warn(`[WA] PERINGATAN: gagal baca client_revision dari web.whatsapp.com (${r.error.message}). Format sw.js mungkin berubah.`);
        }
    } catch (err) {
        console.warn(`[WA] PERINGATAN: gagal menghubungi web.whatsapp.com untuk cek versi (${err.message}).`);
    }

    const lastGood = _readLastGoodVersion();
    if (lastGood) {
        console.warn(`[WA] Memakai versi terakhir yang berhasil: ${lastGood.version.join('.')} (tercatat ${lastGood.tercatat}).`);
        return { version: lastGood.version, sumber: 'versi terakhir yang berhasil' };
    }

    const fallback = await fetchLatestBaileysVersion();
    console.warn(`[WA] PERINGATAN: jatuh ke versi repo Baileys ${fallback.version.join('.')} — angka ini sering tertinggal dari WhatsApp Web dan bisa memicu penolakan 405.`);
    return { version: fallback.version, sumber: 'repo Baileys (BASI, rawan 405)' };
}

function getSessions() { return _sessions; }

function getSession(key) { return _sessions[key] || null; }

function _logger() {
    return pino({ level: 'silent' });
}

async function createSession(key, label) {
    if (_sessions[key]) return _sessions[key];

    const authDir = path.join(SESSIONS_DIR, key);
    fs.mkdirSync(authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    const { version, sumber } = await _waVersion();
    console.log(`[WA] Session "${key}" pakai versi klien ${version.join('.')} (${sumber})`);

    const sock = makeWASocket({
        version,
        auth: state,
        logger: _logger(),
        printQRInTerminal: false,
        // Fingerprint kustom sebelumnya ('SMA Al Bayan', 'Chrome', '1.0.0') tidak
        // dikenali server WA (bukan platform resmi) — diduga penyebab penolakan
        // close-code 405 yang terjadi bahkan pada sesi baru/belum terdaftar.
        browser: Browsers.ubuntu('Chrome'),
        connectTimeoutMs: 30_000,
        defaultQueryTimeoutMs: 30_000,
        markOnlineOnConnect: false,
        // Tanpa ini, WhatsApp penerima yang gagal dekripsi pertama kali akan
        // minta kirim-ulang plaintext — dan tanpa jawaban, pesan itu terus
        // tampil "Waiting for this message" di HP penerima selamanya.
        getMessage: async (key) => getStoredMessage(key.id) || undefined,
    });

    _sessions[key] = {
        socket:   sock,
        status:   'connecting',
        phone:    null,
        qrBase64: null,
        label:    label || key,
        version:  version.join('.'),
        versionSumber: sumber,
    };

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('messages.upsert', (upsert) => {
        handleIncomingMessages(sock, upsert).catch((err) => {
            console.error('[WA] handleIncomingMessages error:', err.message);
        });
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        const sess = _sessions[key];
        if (!sess) return;

        if (qr) {
            try {
                sess.qrBase64 = await QRCode.toDataURL(qr);
            } catch (_) {}
            sess.status = 'qr_needed';
            _reconnectAttempts[key] = 0;
        }

        if (connection === 'open') {
            sess.status   = 'connected';
            sess.qrBase64 = null;
            sess.phone    = sock.user?.id?.split(':')[0] || null;
            _scheduleStableReset(key);
            _saveLastGoodVersion(version); // versi ini terbukti diterima server
            startQueue(key, sock);
            // require() ditunda ke sini (bukan top-level) karena recovery.js
            // require('./sessions') balik — lingkaran ini aman karena baru
            // dieksekusi setelah kedua modul selesai dimuat.
            require('./recovery').recoverQueued();
            console.log(`[WA] Session "${key}" connected (${sess.phone})`);
        }

        if (connection === 'close') {
            const err = lastDisconnect?.error;
            const code = err?.output?.statusCode;
            const loggedOut = code === DisconnectReason.loggedOut;
            pauseQueue(key);
            _cancelStableReset(key);

            // Selalu catat alasan mentah dari server. Logger Baileys sengaja
            // 'silent', jadi tanpa baris ini penyebab asli tidak pernah terlihat
            // di log — persis yang bikin insiden 405 (2026-07-29) sulit dilacak.
            if (err?.data || err?.message) {
                console.log(`[WA] Session "${key}" alasan: ${err.message || '-'} | data=${JSON.stringify(err.data)}`);
            }

            // 405 hampir selalu berarti versi klien yang kita klaim sudah ditolak.
            // Bandingkan langsung dengan versi WhatsApp Web saat ini supaya
            // diagnosisnya langsung terbaca di log, tanpa perlu investigasi manual.
            if (code === 405) {
                fetchLatestWaWebVersion({}).then((r) => {
                    const kini = r?.version?.join('.');
                    if (kini && kini !== sess.version) {
                        console.warn(`[WA] DIAGNOSA: ditolak 405. Versi yang dipakai ${sess.version} (${sess.versionSumber}), sedangkan WhatsApp Web sekarang ${kini}. Versi klien sudah basi — restart service agar mengambil versi terbaru.`);
                    } else {
                        console.warn(`[WA] DIAGNOSA: ditolak 405 padahal versi klien ${sess.version} sudah sama dengan WhatsApp Web. Penyebabnya kemungkinan bukan versi.`);
                    }
                }).catch(() => {});
            }

            if (!loggedOut && sess.status !== 'deleted') {
                _reconnectAttempts[key] = (_reconnectAttempts[key] || 0) + 1;
                const attempt = _reconnectAttempts[key];

                if (attempt >= MAX_RECONNECT_ATTEMPTS) {
                    // Berhenti auto-retry: menghantam terus hanya membuat WhatsApp
                    // menaikkan penolakan (503 → 405 blokir klien). Butuh reset
                    // manual lewat resetSession() / tombol "Minta QR Lagi".
                    sess.status = 'disconnected';
                    console.log(`[WA] Session "${key}" closed (code=${code}), attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS} — berhenti auto-retry, perlu reset manual.`);
                } else {
                    const delay = _reconnectDelay(attempt);
                    sess.status = 'connecting';
                    console.log(`[WA] Session "${key}" closed (code=${code}), attempt ${attempt}/${MAX_RECONNECT_ATTEMPTS}, reconnect dalam ${Math.round(delay / 1000)}s`);
                    setTimeout(() => _reconnect(key, label), delay);
                }
            } else {
                sess.status = 'disconnected';
                _reconnectAttempts[key] = 0;
                console.log(`[WA] Session "${key}" closed (code=${code}, loggedOut=${loggedOut})`);
            }
        }
    });

    return _sessions[key];
}

async function _reconnect(key, label) {
    const s = _sessions[key];
    if (!s || s.status === 'deleted') return;
    delete _sessions[key];
    await createSession(key, label);
}

async function deleteSession(key) {
    const s = _sessions[key];
    if (s) {
        s.status = 'deleted';
        pauseQueue(key);
        try { await s.socket.logout(); } catch (_) {}
        try { s.socket.ws.close(); } catch (_) {}
        delete _sessions[key];
    }
    _cancelStableReset(key);
    delete _reconnectAttempts[key];
    const authDir = path.join(SESSIONS_DIR, key);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }
}

// Reset kredensial sesi (mis. setelah auto-retry berhenti karena terus ditolak
// server WA) supaya memulai pairing dari awal & memunculkan QR baru, TANPA
// menghapus row WaSession di database Flask — beda dari deleteSession().
async function resetSession(key) {
    const s = _sessions[key];
    const label = s ? s.label : key;
    if (s) {
        s.status = 'deleted'; // cegah handler 'close' lama menjadwalkan reconnect
        pauseQueue(key);
        try { s.socket.end(new Error('reset')); } catch (_) {}
        try { s.socket.ws.close(); } catch (_) {}
        delete _sessions[key];
    }
    _cancelStableReset(key);
    delete _reconnectAttempts[key];

    const authDir = path.join(SESSIONS_DIR, key);
    if (fs.existsSync(authDir)) {
        fs.rmSync(authDir, { recursive: true, force: true });
    }

    return createSession(key, label);
}

async function fetchGroups(key) {
    const s = _sessions[key];
    if (!s || s.status !== 'connected') return null;
    const groups = await s.socket.groupFetchAllParticipating();
    return Object.values(groups).map(g => ({ id: g.id, subject: g.subject }));
}

async function loadExistingSessions() {
    if (!fs.existsSync(SESSIONS_DIR)) return;
    const keys = fs.readdirSync(SESSIONS_DIR).filter(
        f => fs.statSync(path.join(SESSIONS_DIR, f)).isDirectory()
    );
    for (const key of keys) {
        console.log(`[WA] Loading existing session: ${key}`);
        await createSession(key, key);
    }
}

module.exports = { getSessions, getSession, createSession, deleteSession, resetSession, loadExistingSessions, fetchGroups };
