'use strict';
const crypto = require('crypto');

/**
 * Multi-admin: ADMIN_PASSWORD, ADMIN_PASSWORD2, ADMIN_PASSWORD3, ... (berapa pun).
 * Setiap password min. 6 karakter. Menambah/menghapus admin = tambah/hapus env lalu Redeploy.
 */
function admins() {
  const out = [];
  for (const [k, v] of Object.entries(process.env)) {
    const m = k.match(/^ADMIN_PASSWORD(\d*)$/);
    if (m && v && String(v).length >= 6) out.push({ id: m[1] || '1', num: Number(m[1] || 1), pass: String(v) });
  }
  return out.sort((a, b) => a.num - b.num);
}
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();
const key = () => process.env.SESSION_SECRET || 'ptero-panel-session';
const sign = (data) => crypto.createHmac('sha256', key()).update(data).digest('hex');

const configured = () => admins().length > 0;
const adminCount = () => admins().length;

/** mengembalikan id admin bila password cocok, selain itu null */
function checkPassword(input) {
  let found = null;
  const h = sha(input);
  for (const a of admins()) if (crypto.timingSafeEqual(h, sha(a.pass)) && !found) found = a.id;
  return found;
}

function issueToken(id) {
  const a = admins().find((x) => x.id === id);
  if (!a) throw new Error('Admin tidak ditemukan');
  const exp = String(Date.now() + 7 * 24 * 3600 * 1000);
  return [exp, id, sign(`sess:${exp}:${id}:${sha(a.pass).toString('hex')}`)].join('.');
}

/** mengembalikan id admin bila token sah (dan password admin itu belum diganti/dihapus) */
function verifyToken(tok) {
  if (typeof tok !== 'string') return null;
  const [exp, id, sig] = tok.split('.');
  if (!exp || !id || !sig || Number(exp) < Date.now()) return null;
  const a = admins().find((x) => x.id === id);
  if (!a) return null;
  const good = sign(`sess:${exp}:${id}:${sha(a.pass).toString('hex')}`);
  if (sig.length !== good.length) return null;
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good)) ? id : null;
}

function isAuthed(req) {
  const h = req.headers['authorization'] || '';
  return verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
}

function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length || !a) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
const newSecret = () => crypto.randomBytes(24).toString('hex');

module.exports = { configured, adminCount, checkPassword, issueToken, verifyToken, isAuthed, safeEqual, newSecret };
