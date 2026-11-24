'use strict';
// Pembaca ZIP minimal tanpa dependensi (mendukung stored + deflate, ZIP64, nama UTF-8).
const zlib = require('zlib');

function parseZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Bukan file ZIP yang valid (atau file ZIP-nya rusak/terpotong)');
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOff = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) {
    const loc = eocd - 20;
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      if (buf.readUInt32LE(z64) === 0x06064b50) {
        total = Number(buf.readBigUInt64LE(z64 + 32));
        cdSize = Number(buf.readBigUInt64LE(z64 + 40));
        cdOff = Number(buf.readBigUInt64LE(z64 + 48));
      }
    }
  }
  void cdSize;
  const entries = [];
  let p = cdOff;
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Daftar isi ZIP rusak');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20);
    let usize = buf.readUInt32LE(p + 24);
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32);
    let off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl).replace(/\\/g, '/');
    let q = p + 46 + nl;
    const end = q + el;
    while (q + 4 <= end) {
      const id = buf.readUInt16LE(q), sz = buf.readUInt16LE(q + 2);
      if (id === 1) {
        let r = q + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(r)); r += 8; }
        if (off === 0xffffffff) { off = Number(buf.readBigUInt64LE(r)); r += 8; }
      }
      q += 4 + sz;
    }
    entries.push({ name, flags, method, csize, usize, off, dir: name.endsWith('/') });
    p += 46 + nl + el + cl;
  }
  return entries;
}

function extract(buf, e) {
  if (e.flags & 1) throw new Error('entri dienkripsi (pakai password) — tidak didukung');
  const lh = e.off;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) throw new Error('header lokal rusak');
  const nl = buf.readUInt16LE(lh + 26), el = buf.readUInt16LE(lh + 28);
  const start = lh + 30 + nl + el;
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return zlib.inflateRawSync(data);
  throw new Error('metode kompresi ' + e.method + ' tidak didukung');
}

module.exports = { parseZip, extract };
