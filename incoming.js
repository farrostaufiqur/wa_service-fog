'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { DatabaseSync } = require('node:sqlite');
const { getDb } = require('./db'); // wa.db (blocklist)
const { remember: rememberSentMessage } = require('./messageStore');

// Sama seperti di queue.js: catat isi balasan supaya Baileys bisa menjawab
// permintaan retry WhatsApp saat HP penerima gagal dekripsi di percobaan
// pertama. Tanpa ini balasan bot juga akan macet di "Waiting for this
// message" di HP penerima.
async function _reply(sock, jid, text) {
    const sent = await sock.sendMessage(jid, { text });
    if (sent?.key?.id) rememberSentMessage(sent.key.id, { conversation: text });
}

const PD_DB_PATH         = process.env.PD_DB_PATH;
const RAPOR_DB_PATH      = process.env.RAPOR_DB_PATH;
const CMD_RATE_LIMIT     = parseInt(process.env.WA_CMD_RATE_LIMIT || '5', 10);
const CMD_RATE_WINDOW_MS = parseInt(process.env.WA_CMD_RATE_WINDOW_SEC || '600', 10) * 1000;

let _pdDb = null;
function getPdDb() {
    if (_pdDb) return _pdDb;
    if (!PD_DB_PATH) throw new Error('PD_DB_PATH not set in .env');
    _pdDb = new DatabaseSync(PD_DB_PATH, { readOnly: true });
    return _pdDb;
}

let _raporDb = null;
function getRaporDb() {
    if (_raporDb) return _raporDb;
    if (!RAPOR_DB_PATH) return null;
    _raporDb = new DatabaseSync(RAPOR_DB_PATH, { readOnly: true });
    return _raporDb;
}

// Kelas saat ini via rapor.db (rapor_status = source of truth pendaftaran per semester),
// jauh lebih lengkap daripada pd_siswa.rombel_saat_ini yang legacy/jarang terisi.
function _lookupKelasTerkini(pdSiswaId) {
    try {
        const db = getRaporDb();
        if (!db) return null;
        const rs = db.prepare('SELECT id FROM rapor_siswa WHERE pd_siswa_id = ? ORDER BY id DESC LIMIT 1').get(pdSiswaId);
        if (!rs) return null;
        const status = db.prepare(`
            SELECT rst.tingkatan, rst.semester_id
            FROM rapor_status rst JOIN rapor_semester rsem ON rst.semester_id = rsem.id
            WHERE rst.siswa_id = ? ORDER BY rsem.urutan DESC LIMIT 1
        `).get(rs.id);
        if (!status) return null;
        const kelas = db.prepare(`
            SELECT rk.nama_kelas FROM rapor_siswa_kelas rsk JOIN rapor_kelas rk ON rsk.kelas_id = rk.id
            WHERE rsk.siswa_id = ? AND rk.semester_id = ? LIMIT 1
        `).get(rs.id, status.semester_id);
        return kelas ? kelas.nama_kelas : null;
    } catch (err) {
        console.error('[WA] lookup kelas terkini error:', err.message);
        return null;
    }
}

function _ensureBlocklistTable() {
    try {
        const db = getDb();
        db.exec(`
            CREATE TABLE IF NOT EXISTS wa_blocked_number (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                nomor VARCHAR(20) NOT NULL UNIQUE,
                alasan VARCHAR(200),
                blocked_at DATETIME
            )
        `);
    } catch (err) {
        console.error('[WA] ensure blocklist table error:', err.message);
    }
}
_ensureBlocklistTable();

function _isBlocked(nomor) {
    try {
        const row = getDb().prepare('SELECT 1 FROM wa_blocked_number WHERE nomor=?').get(nomor);
        return !!row;
    } catch (err) {
        console.error('[WA] blocklist check error:', err.message);
        return false;
    }
}

function _blockNumber(nomor, alasan) {
    try {
        getDb().prepare(
            "INSERT OR IGNORE INTO wa_blocked_number (nomor, alasan, blocked_at) VALUES (?, ?, datetime('now'))"
        ).run(nomor, alasan);
        console.log(`[WA] Nomor ${nomor} diblokir: ${alasan}`);
    } catch (err) {
        console.error('[WA] block error:', err.message);
    }
}

// sender -> [timestamps ms] percobaan command dalam window berjalan
const _attempts = new Map();

function _checkRateLimit(nomor) {
    const now  = Date.now();
    const list = (_attempts.get(nomor) || []).filter(t => now - t < CMD_RATE_WINDOW_MS);
    list.push(now);
    _attempts.set(nomor, list);
    if (list.length > CMD_RATE_LIMIT) {
        const menit = Math.round(CMD_RATE_WINDOW_MS / 60000);
        _blockNumber(nomor, `Mengirim ${list.length} command dalam ${menit} menit`);
        return false;
    }
    return true;
}

function _fmtDateIndo(isoStr) {
    if (!isoStr) return '-';
    const parts = isoStr.split('-');
    if (parts.length !== 3) return isoStr;
    const [y, mo, d] = parts;
    return `${d}/${mo}/${y}`;
}

function _lookupSiswa(nisn, tanggalLahirIso) {
    const db = getPdDb();
    return db.prepare(
        'SELECT id, nama, nisn, jk, tempat_lahir, tanggal_lahir, rombel_saat_ini, ayah_nama, ibu_nama, hp ' +
        'FROM pd_siswa WHERE nisn = ? AND tanggal_lahir = ?'
    ).get(nisn, tanggalLahirIso) || null;
}

const CMD_RE  = /^pd\b/i;
const FULL_RE = /^pd\s+(\S+)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/i;

async function handleIncomingMessages(sock, upsert) {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages) {
        if (!msg.message || msg.key.fromMe) continue;

        const jid = msg.key.remoteJid || '';
        if (!jid.endsWith('@s.whatsapp.net')) continue; // hanya chat pribadi, bukan grup

        const text = (msg.message.conversation
            || (msg.message.extendedTextMessage && msg.message.extendedTextMessage.text)
            || '').trim();
        if (!text || !CMD_RE.test(text)) continue; // hanya proses pesan berawalan "pd"

        const nomor = jid.split('@')[0];

        if (_isBlocked(nomor)) continue; // diam total — tidak balas apapun

        if (!_checkRateLimit(nomor)) {
            await _reply(sock, jid,
                'Nomor Anda diblokir sementara karena mengirim perintah terlalu sering. ' +
                'Hubungi admin sekolah bila ini keliru.');
            continue;
        }

        const match = text.match(FULL_RE);
        if (!match) {
            await _reply(sock, jid,
                'Format tidak dikenali.\nContoh: pd 1234567890 15/03/2010\n(NISN lalu tanggal lahir dd/mm/yyyy)');
            continue;
        }

        const nisn = match[1];
        const dd = match[2], mo = match[3], yyyy = match[4];
        const tanggalIso = `${yyyy}-${mo.padStart(2, '0')}-${dd.padStart(2, '0')}`;

        let siswa;
        try {
            siswa = _lookupSiswa(nisn, tanggalIso);
        } catch (err) {
            console.error('[WA] lookup siswa error:', err.message);
            await _reply(sock, jid, 'Terjadi kesalahan saat mencari data. Coba lagi nanti.');
            continue;
        }

        if (!siswa) {
            await _reply(sock, jid, 'Data tidak ditemukan. Pastikan NISN dan tanggal lahir (dd/mm/yyyy) sudah benar.');
            continue;
        }

        const kelas = _lookupKelasTerkini(siswa.id) || siswa.rombel_saat_ini || '-';
        const jkLabel = siswa.jk === 'L' ? 'Laki-laki' : (siswa.jk === 'P' ? 'Perempuan' : '-');
        const reply =
            'Data Siswa:\n' +
            `Nama: ${siswa.nama || '-'}\n` +
            `NISN: ${siswa.nisn || '-'}\n` +
            `Kelas: ${kelas}\n` +
            `JK: ${jkLabel}\n` +
            `Tempat, Tgl Lahir: ${siswa.tempat_lahir || '-'}, ${_fmtDateIndo(siswa.tanggal_lahir)}\n` +
            `Nama Ayah: ${siswa.ayah_nama || '-'}\n` +
            `Nama Ibu: ${siswa.ibu_nama || '-'}`;

        await _reply(sock, jid, reply);
    }
}

module.exports = { handleIncomingMessages };
