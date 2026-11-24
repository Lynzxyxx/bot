'use strict';
/**
 * Penyimpanan panel (Redis Upstash lewat REST) — TANPA batas ukuran file buatan sendiri.
 * File dipecah jadi potongan 512 KB (base64) sehingga file sebesar apa pun bisa disimpan
 * (batasnya hanya kuota Upstash milikmu).
 *
 * Skema key:
 *   dir:<path>   hash  nama -> {"t":"d"} | {"t":"f","s":ukuran,"m":mtime,"c":jumlahChunk}
 *   f:<path>     hash  indeksChunk -> base64
 *   state / config (hash), logs (list), usage / codever (angka)
 *
 * Env (salah satu pasangan):
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL + KV_REST_API_TOKEN   (otomatis dari Vercel -> Upstash for Redis)
 * Tanpa itu dipakai memori sementara (HILANG saat cold start) — hanya untuk coba-coba.
 */

const URL_ = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '';
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const PERSISTENT = Boolean(URL_ && TOKEN);
const CHUNK = 512 * 1024; // ukuran potongan (bukan batas file)

/* ---------- backend memori (fallback) ---------- */
const mem = (global.__PANEL_MEM__ = global.__PANEL_MEM__ || { kv: new Map() });
function memExec(cmd) {
  const op = String(cmd[0]).toUpperCase();
  const key = String(cmd[1]);
  const a = cmd.slice(2).map(String);
  const kv = mem.kv;
  const sl = (l, s, e) => { s = +s; e = +e; return l.slice(s < 0 ? Math.max(l.length + s, 0) : s, e < 0 ? l.length + e + 1 : e + 1); };
  switch (op) {
    case 'GET': return kv.has(key) ? kv.get(key) : null;
    case 'SET': kv.set(key, a[0]); return 'OK';
    case 'INCR': { const v = (parseInt(kv.get(key) || '0', 10) || 0) + 1; kv.set(key, String(v)); return v; }
    case 'INCRBY': { const v = (parseInt(kv.get(key) || '0', 10) || 0) + parseInt(a[0], 10); kv.set(key, String(v)); return v; }
    case 'DEL': { let n = 0; for (const k of [key, ...a]) if (kv.delete(k)) n++; return n; }
    case 'RENAME': { if (!kv.has(key)) throw new Error('ERR no such key'); kv.set(a[0], kv.get(key)); kv.delete(key); return 'OK'; }
    case 'HSET': { const h = kv.get(key) || new Map(); kv.set(key, h); let n = 0; for (let i = 0; i < a.length; i += 2) { if (!h.has(a[i])) n++; h.set(a[i], a[i + 1]); } return n; }
    case 'HGET': { const h = kv.get(key); return h && h.has(a[0]) ? h.get(a[0]) : null; }
    case 'HDEL': { const h = kv.get(key); let n = 0; if (h) for (const f of a) if (h.delete(f)) n++; if (h && !h.size) kv.delete(key); return n; }
    case 'HLEN': { const h = kv.get(key); return h ? h.size : 0; }
    case 'HGETALL': { const h = kv.get(key); const out = []; if (h) for (const [k, v] of h) out.push(k, v); return out; }
    case 'HINCRBY': { const h = kv.get(key) || new Map(); kv.set(key, h); const v = (parseInt(h.get(a[0]) || '0', 10) || 0) + parseInt(a[1], 10); h.set(a[0], String(v)); return v; }
    case 'RPUSH': { const l = kv.get(key) || []; kv.set(key, l); for (const v of a) l.push(v); return l.length; }
    case 'LTRIM': { const l = kv.get(key); if (l) kv.set(key, sl(l, a[0], a[1])); return 'OK'; }
    case 'LRANGE': return sl(kv.get(key) || [], a[0], a[1]);
    default: throw new Error('Perintah memori tidak didukung: ' + op);
  }
}

/* ---------- backend Redis REST (dengan retry) ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function rest(path, body) {
  let last;
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(URL_.replace(/\/$/, '') + path, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => null);
      if (r.status >= 500 || r.status === 429) { last = new Error('Redis HTTP ' + r.status); await sleep(300 * (i + 1)); continue; }
      if (!r.ok) throw new Error('Redis: ' + ((j && j.error) || r.status));
      return j;
    } catch (e) {
      last = e;
      if (/^Redis: /.test(e.message)) throw e;
      await sleep(300 * (i + 1));
    }
  }
  throw last || new Error('Redis tidak merespons');
}
async function restExec(cmd) {
  const j = await rest('', cmd);
  if (j.error) throw new Error('Redis: ' + j.error);
  return j.result;
}
const cmdSize = (c) => { let n = 8; for (const x of c) n += String(x).length + 4; return n; };
async function restPipe(cmds) {
  const out = [];
  let cur = [], size = 0;
  const flush = async () => {
    if (!cur.length) return;
    const j = await rest('/pipeline', cur);
    if (!Array.isArray(j)) throw new Error('Redis pipeline gagal');
    for (const it of j) { if (it.error) throw new Error('Redis: ' + it.error); out.push(it.result); }
    cur = []; size = 0;
  };
  for (const c of cmds) {
    const s = cmdSize(c);
    if (cur.length && (size + s > 850000 || cur.length >= 400)) await flush();
    cur.push(c.map(String)); size += s;
  }
  await flush();
  return out;
}

const exec = (cmd) => (PERSISTENT ? restExec(cmd.map(String)) : Promise.resolve(memExec(cmd)));
const pipe = (cmds) => (cmds.length ? (PERSISTENT ? restPipe(cmds) : Promise.resolve(cmds.map(memExec))) : Promise.resolve([]));
const toObj = (flat) => { const o = {}; for (let i = 0; i < (flat || []).length; i += 2) o[flat[i]] = flat[i + 1]; return o; };
const parseJ = (s) => { try { return JSON.parse(s); } catch { return null; } };

/* ---------- path helper ---------- */
function norm(p) {
  p = String(p == null ? '/' : p).replace(/\\/g, '/');
  const out = [];
  for (const s of p.split('/')) {
    if (!s || s === '.') continue;
    if (s === '..') { out.pop(); continue; }
    out.push(s);
  }
  return '/' + out.join('/');
}
const parentOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const baseName = (p) => p.slice(p.lastIndexOf('/') + 1);
const join = (d, n) => (d === '/' ? '' : d) + '/' + n;
const dkey = (d) => 'dir:' + d;
const fkey = (p) => 'f:' + p;
const DIR_META = JSON.stringify({ t: 'd' });

/** perintah HSET agar semua folder induk dari `path` tercatat di folder di atasnya */
function ancestorCmds(path, seen) {
  const cmds = [];
  let d = parentOf(path);
  while (d !== '/') {
    const par = parentOf(d);
    const key = par + '|' + baseName(d);
    if (!(seen && seen.has(key))) {
      cmds.push(['HSET', dkey(par), baseName(d), DIR_META]);
      if (seen) seen.add(key);
    }
    d = par;
  }
  return cmds;
}

function splitBuf(buf) {
  const out = [];
  for (let i = 0; i < buf.length; i += CHUNK) out.push(buf.subarray(i, Math.min(i + CHUNK, buf.length)));
  return out;
}

/* ---------- filesystem virtual ---------- */
const fs = {
  CHUNK,

  async list(dir) {
    dir = norm(dir);
    const o = toObj(await exec(['HGETALL', dkey(dir)]));
    const items = [];
    for (const [name, v] of Object.entries(o)) {
      const m = parseJ(v) || { t: 'f', s: 0, m: 0 };
      items.push({ name, type: m.t === 'd' ? 'dir' : 'file', size: m.s || 0, mtime: m.m || 0 });
    }
    return items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  },

  async stat(path) {
    path = norm(path);
    if (path === '/') return { t: 'd' };
    return parseJ(await exec(['HGET', dkey(parentOf(path)), baseName(path)]));
  },

  /** simpan satu potongan dari upload browser; potongan terakhir memverifikasi lalu commit */
  async putChunk(path, i, n, size, b64) {
    path = norm(path);
    if (path === '/') throw new Error('Path tidak valid');
    const st = await fs.stat(path);
    if (st && st.t === 'd') throw new Error('Sudah ada folder dengan nama itu');
    if (n === 0) { await exec(['DEL', fkey(path)]); await fs.commit(path, 0, 0, st); return { complete: true }; }
    if (i === 0) await pipe([['DEL', fkey(path)], ['HSET', fkey(path), '0', b64]]);
    else await exec(['HSET', fkey(path), String(i), b64]);
    if (i === n - 1) {
      const have = Number(await exec(['HLEN', fkey(path)]));
      if (have !== n) return { complete: false, have };
      await fs.commit(path, size, n, st);
      return { complete: true };
    }
    return { complete: false };
  },

  async commit(path, size, n, oldMeta) {
    const old = oldMeta === undefined ? await fs.stat(path) : oldMeta;
    const delta = size - (old && old.t === 'f' ? old.s : 0);
    await pipe([
      ...ancestorCmds(path),
      ['HSET', dkey(parentOf(path)), baseName(path), JSON.stringify({ t: 'f', s: size, m: Date.now(), c: n })],
      ['INCRBY', 'usage', delta],
      ['INCR', 'codever'],
    ]);
  },

  async writeBuffer(path, buf) {
    path = norm(path);
    if (path === '/') throw new Error('Path tidak valid');
    const st = await fs.stat(path);
    if (st && st.t === 'd') throw new Error('Sudah ada folder dengan nama itu');
    const parts = splitBuf(buf);
    const cmds = [['DEL', fkey(path)]];
    parts.forEach((p, i) => cmds.push(['HSET', fkey(path), String(i), p.toString('base64')]));
    await pipe(cmds);
    await fs.commit(path, buf.length, parts.length, st);
    return { path, size: buf.length };
  },
  writeText: (path, text) => fs.writeBuffer(path, Buffer.from(String(text == null ? '' : text), 'utf8')),

  /** tulis banyak file+folder sekaligus (dipakai unzip) — hemat jumlah request */
  async putMany(files, dirs = []) {
    const seen = new Set();
    const cmds = [];
    const olds = await pipe(files.map((f) => ['HGET', dkey(parentOf(f.path)), baseName(f.path)]));
    let delta = 0;
    files.forEach((f, idx) => {
      const old = parseJ(olds[idx]);
      if (old && old.t === 'd') throw new Error(`'${f.path}' bentrok dengan folder`);
      delta += f.buf.length - (old && old.t === 'f' ? old.s : 0);
      const parts = splitBuf(f.buf);
      cmds.push(['DEL', fkey(f.path)]);
      parts.forEach((p, i) => cmds.push(['HSET', fkey(f.path), String(i), p.toString('base64')]));
      cmds.push(...ancestorCmds(f.path, seen));
      cmds.push(['HSET', dkey(parentOf(f.path)), baseName(f.path), JSON.stringify({ t: 'f', s: f.buf.length, m: Date.now(), c: parts.length })]);
    });
    for (const d of dirs) {
      const p = norm(d);
      if (p === '/') continue;
      cmds.push(...ancestorCmds(p, seen));
      const key = parentOf(p) + '|' + baseName(p);
      if (!seen.has(key)) { cmds.push(['HSET', dkey(parentOf(p)), baseName(p), DIR_META]); seen.add(key); }
    }
    cmds.push(['INCRBY', 'usage', delta], ['INCR', 'codever']);
    await pipe(cmds);
  },

  async mkdir(path) {
    path = norm(path);
    if (path === '/') return path;
    const st = await fs.stat(path);
    if (st && st.t === 'f') throw new Error('Sudah ada file dengan nama itu');
    await pipe([...ancestorCmds(path), ['HSET', dkey(parentOf(path)), baseName(path), DIR_META]]);
    return path;
  },

  async readChunk(path, i) {
    const v = await exec(['HGET', fkey(norm(path)), String(i)]);
    return v == null ? '' : v;
  },

  async readBuffer(path) {
    path = norm(path);
    const st = await fs.stat(path);
    if (!st) return null;
    if (st.t === 'd') throw new Error('Ini folder, bukan file');
    const bufs = [];
    for (let i = 0; i < st.c; i += 3) {
      const idx = [];
      for (let k = i; k < Math.min(i + 3, st.c); k++) idx.push(k);
      const parts = await pipe(idx.map((k) => ['HGET', fkey(path), String(k)]));
      for (const p of parts) bufs.push(Buffer.from(p || '', 'base64'));
    }
    return Buffer.concat(bufs);
  },

  /** telusuri pohon folder per level (pipeline). skip = nama folder yang dilewati */
  async walk(root, { skip = [] } = {}) {
    root = norm(root);
    const dirs = [], files = [];
    let level = [root];
    while (level.length) {
      const res = await pipe(level.map((d) => ['HGETALL', dkey(d)]));
      const next = [];
      level.forEach((d, i) => {
        const o = toObj(res[i]);
        dirs.push({ path: d, nonEmpty: Object.keys(o).length > 0 });
        for (const [n, v] of Object.entries(o)) {
          const m = parseJ(v) || { t: 'f', s: 0, c: 0 };
          const p = join(d, n);
          if (m.t === 'd') { if (!skip.includes(n)) next.push(p); } else files.push({ path: p, meta: m });
        }
      });
      level = next;
    }
    return { dirs, files };
  },

  async remove(paths) {
    const cmds = [];
    let freed = 0, count = 0;
    for (let p of paths) {
      p = norm(p);
      if (p === '/') continue;
      const st = await fs.stat(p);
      if (!st) continue;
      if (st.t === 'f') { cmds.push(['DEL', fkey(p)]); freed += st.s || 0; count++; }
      else {
        const { dirs, files } = await fs.walk(p);
        for (const d of dirs) cmds.push(['DEL', dkey(d.path)]);
        for (const f of files) { cmds.push(['DEL', fkey(f.path)]); freed += f.meta.s || 0; count++; }
        count++;
      }
      cmds.push(['HDEL', dkey(parentOf(p)), baseName(p)]);
    }
    if (cmds.length) { cmds.push(['INCRBY', 'usage', -freed], ['INCR', 'codever']); await pipe(cmds); }
    return count;
  },

  async rename(from, to) {
    from = norm(from); to = norm(to);
    if (from === '/' || to === '/') throw new Error('Path tidak valid');
    if (from === to) return 0;
    if (to.startsWith(from + '/')) throw new Error('Tidak bisa memindahkan folder ke dalam dirinya sendiri');
    const st = await fs.stat(from);
    if (!st) throw new Error('Sumber tidak ditemukan');
    if (await fs.stat(to)) throw new Error('Tujuan sudah ada');
    const cmds = [];
    let count = 1;
    if (st.t === 'f') {
      if (st.c > 0) cmds.push(['RENAME', fkey(from), fkey(to)]);
    } else {
      const { dirs, files } = await fs.walk(from);
      const map = (p) => to + p.slice(from.length);
      for (const d of dirs) if (d.nonEmpty) cmds.push(['RENAME', dkey(d.path), dkey(map(d.path))]);
      for (const f of files) { count++; if (f.meta.c > 0) cmds.push(['RENAME', fkey(f.path), fkey(map(f.path))]); }
    }
    cmds.push(...ancestorCmds(to));
    cmds.push(['HSET', dkey(parentOf(to)), baseName(to), JSON.stringify(st)]);
    cmds.push(['HDEL', dkey(parentOf(from)), baseName(from)], ['INCR', 'codever']);
    await pipe(cmds);
    return count;
  },

  async usage() { return Math.max(0, Number(await exec(['GET', 'usage'])) || 0); },
  async recount() {
    const { files } = await fs.walk('/');
    const total = files.reduce((s, f) => s + (f.meta.s || 0), 0);
    await exec(['SET', 'usage', String(total)]);
    return { total, files: files.length };
  },
  async codeVersion() { return String((await exec(['GET', 'codever'])) || '0'); },
  bumpCode: () => exec(['INCR', 'codever']),
};

/* ---------- state / config / log ---------- */
const N = (v, d = 0) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const state = {
  async get() {
    const s = toObj(await exec(['HGETALL', 'state']));
    return {
      status: s.status || 'offline', startedAt: N(s.startedAt), requests: N(s.requests), errors: N(s.errors),
      bytesIn: N(s.bytesIn), bytesOut: N(s.bytesOut), lastCpu: N(s.lastCpu), lastMem: N(s.lastMem), lastMs: N(s.lastMs),
      lastRun: N(s.lastRun), lastRepair: N(s.lastRepair), hotStreak: N(s.hotStreak), errStreak: N(s.errStreak),
      lastAuto: N(s.lastAuto), restarts: N(s.restarts),
    };
  },
  async set(obj) {
    const args = [];
    for (const [k, v] of Object.entries(obj)) args.push(k, String(v));
    if (args.length) await exec(['HSET', 'state', ...args]);
  },
  incr: (field, n = 1) => exec(['HINCRBY', 'state', field, n]),
};

const config = {
  async get() {
    const c = toObj(await exec(['HGETALL', 'config']));
    return {
      botToken: c.botToken || process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN || '',
      entry: c.entry || '', tokenSource: c.tokenSource || '', nodeVersion: c.nodeVersion || '', envVars: c.envVars || '',
      autoPing: c.autoPing === '1', seeded: c.seeded === '1', whSecret: c.whSecret || '',
      autoRestart: c.autoRestart !== '0', cpuLimit: N(c.cpuLimit, 90), cpuStreak: N(c.cpuStreak, 3),
    };
  },
  async set(obj) {
    const args = [];
    for (const [k, v] of Object.entries(obj)) args.push(k, String(v));
    if (args.length) await exec(['HSET', 'config', ...args]);
  },
};

const logs = {
  async add(msg, kind = 'out') { await logs.addMany([{ k: kind, m: msg }]); },
  async addMany(items) {
    if (!items.length) return;
    const cmds = items.map((i) => ['RPUSH', 'logs', JSON.stringify({ t: Date.now(), k: i.k || 'out', m: String(i.m).slice(0, 2000) })]);
    cmds.push(['LTRIM', 'logs', -300, -1]);
    await pipe(cmds);
  },
  async tail(n = 200) {
    const r = await exec(['LRANGE', 'logs', -n, -1]);
    return (r || []).map((x) => parseJ(x) || { t: 0, k: 'out', m: String(x) });
  },
  clear: () => exec(['DEL', 'logs']),
};

module.exports = { fs, state, config, logs, norm, parentOf, baseName, PERSISTENT, CHUNK };
