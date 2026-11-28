'use strict';
const { createStore, PERSISTENT, norm, parentOf, baseName } = require('../lib/store');
const auth = require('../lib/auth');
const control = require('../lib/control');
const tg = require('../lib/telegram');
const zipx = require('../lib/zip');
const runner = require('../lib/runner');
const github = require('../lib/github');

// Versi Node yang diminta di panel. `ok` = benar-benar tersedia di Vercel (dicek Nov 2026).
const NODE_VERSIONS = [
  { v: '26', ok: true },
  { v: '24', ok: true },
  { v: '23', ok: false, why: 'Versi ganjil tidak disediakan Vercel' },
  { v: '22', ok: true },
  { v: '21', ok: false, why: 'Versi ganjil tidak disediakan Vercel' },
  { v: '20', ok: false, why: 'Node 20 sudah dinonaktifkan Vercel (1 Okt 2026)' },
];
const EDITOR_MAX = 2 * 1024 * 1024; // hanya batas editor teks di browser, BUKAN batas upload

// Kode region eksekusi Vercel (process.env.VERCEL_REGION) -> nama kota, untuk kartu "Server Details".
// Data asli dari Vercel sendiri, bukan tebakan — kalau kodenya tidak ada di daftar, tampilkan apa adanya.
const REGIONS = {
  sin1: 'Singapore', hnd1: 'Tokyo', icn1: 'Seoul', bom1: 'Mumbai', hkg1: 'Hong Kong', syd1: 'Sydney',
  iad1: 'Washington D.C., USA', sfo1: 'San Francisco, USA', pdx1: 'Portland, USA', cle1: 'Cleveland, USA',
  gru1: 'São Paulo', cdg1: 'Paris', dub1: 'Dublin', fra1: 'Frankfurt', arn1: 'Stockholm', lhr1: 'London',
  cpt1: 'Cape Town', dev1: 'lokal (dev)',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bad = (res, code, msg) => res.status(code).json({ ok: false, error: msg });
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

const BOT_TEMPLATE = `// bot.js — dijalankan setiap ada pesan masuk (mode webhook, aman untuk Vercel).
// Format: CommonJS. Context (ctx): text, command, args, from, chat, reply(), send(), api(), env, update
module.exports = async (ctx) => {
  const { text, command, args, from } = ctx;

  if (command === 'start') {
    return ctx.reply('Halo ' + (from && from.first_name ? from.first_name : 'kak') + '! Bot aktif 24 jam di Vercel 🚀\\nKetik /help untuk bantuan.');
  }
  if (command === 'help') {
    return ctx.reply('Perintah:\\n/start - mulai\\n/ping - cek bot\\n/id - lihat chat id\\n/echo <teks> - ulangi teks');
  }
  if (command === 'ping') {
    const t = Date.now();
    await ctx.reply('Pong! 🏓');
    return console.log('ping dibalas dalam', Date.now() - t, 'ms');
  }
  if (command === 'id') {
    return ctx.reply('Chat ID: ' + ctx.chat.id + '\\nUser ID: ' + (from && from.id));
  }
  if (command === 'echo') {
    return ctx.reply(args || 'Tulis teks setelah /echo');
  }
  if (text && !command) {
    return ctx.reply('Kamu bilang: ' + text);
  }
};
`;

async function detectEntry(store, cfgEntry) {
  const { fs } = store;
  const pkg = await fs.readBuffer('/package.json').catch(() => null);
  for (const c of runner.entryCandidates(cfgEntry, pkg ? pkg.toString() : '')) {
    const st = await fs.stat(c);
    if (st && st.t === 'f') return c;
  }
  return null;
}

async function seedIfEmpty(store) {
  const { fs, config } = store;
  const cfg = await config.get();
  if (cfg.seeded) return;
  if (!(await fs.list('/')).length) {
    await fs.writeText('/bot.js', BOT_TEMPLATE);
    await fs.writeText('/lib/README.txt', 'Taruh modul tambahan di sini, lalu require("./lib/nama.js") dari bot.js');
  }
  await config.set({ seeded: '1' });
}

/* ---------- unzip (di server, bertahap supaya tidak kena batas waktu) ---------- */
const ZC = (global.__ZIPC__ = global.__ZIPC__ || new Map());
async function getZip(store, path) {
  const { fs } = store;
  const st = await fs.stat(path);
  if (!st || st.t !== 'f') throw new Error('File ZIP tidak ditemukan');
  const cacheKey = `${store.ns}:${path}:${st.m}:${st.s}`;
  const cached = ZC.get(store.ns);
  if (cached && cached.key === cacheKey) return cached;
  const buf = await fs.readBuffer(path);
  const entries = zipx.parseZip(buf);
  const rec = { key: cacheKey, buf, entries };
  ZC.set(store.ns, rec);
  return rec;
}
const isHeavy = (n) => /(^|\/)(node_modules|__MACOSX|\.git)(\/|$)/.test(n) || /(^|\/)\.DS_Store$/.test(n);
function detectRoot(entries) {
  const roots = new Set();
  for (const e of entries) {
    if (/^__MACOSX\//.test(e.name)) continue;
    const parts = e.name.replace(/^\/+/, '').split('/').filter(Boolean);
    if (!parts.length) continue;
    if (parts.length === 1 && !e.dir) return null; // ada file di level paling atas -> tidak ada folder pembungkus
    roots.add(parts[0]);
  }
  return roots.size === 1 ? [...roots][0] : null;
}
function relPath(name, root) {
  let n = name.replace(/^\/+/, '');
  if (root) { if (n === root || n === root + '/') return ''; n = n.slice(root.length + 1); }
  return n.replace(/\/+$/, '');
}

async function unzipStep(store, { path, into, from, strip, skipHeavy }) {
  const { fs } = store;
  path = norm(path);
  const z = await getZip(store, path);
  const root = strip ? detectRoot(z.entries) : null;
  const base = norm(into || parentOf(path));
  const prefix = base === '/' ? '/' : base + '/';
  const deadline = Date.now() + 38000;
  let i = Math.max(0, Number(from) || 0), wrote = 0, skipped = 0;
  const failed = [];
  let bf = [], bd = [], bytes = 0;
  const flush = async () => {
    if (!bf.length && !bd.length) return;
    try { await fs.putMany(bf, bd); wrote += bf.length; }
    catch (e) {
      for (const f of bf) { try { await fs.putMany([f], []); wrote++; } catch (er) { failed.push({ name: f.path, error: er.message }); } }
      for (const d of bd) { try { await fs.putMany([], [d]); } catch (er) { failed.push({ name: d, error: er.message }); } }
    }
    bf = []; bd = []; bytes = 0;
  };
  for (; i < z.entries.length; i++) {
    if (Date.now() > deadline) break;
    const e = z.entries[i];
    const rel = relPath(e.name, root);
    if (!rel) { continue; }
    if (skipHeavy && isHeavy(e.name)) { skipped++; continue; }
    const target = norm(base + '/' + rel);
    if (!target.startsWith(prefix)) { failed.push({ name: e.name, error: 'path tidak aman (keluar dari folder tujuan)' }); continue; }
    if (e.dir) { bd.push(target); continue; }
    let data;
    try { data = zipx.extract(z.buf, e); } catch (er) { failed.push({ name: e.name, error: er.message }); continue; }
    bf.push({ path: target, buf: data }); bytes += data.length;
    if (bytes > 600000 || bf.length >= 60) await flush();
  }
  await flush();
  return { done: i >= z.entries.length, next: i, total: z.entries.length, wrote, skipped, failed };
}

/* ---------- Node version via Vercel API ---------- */
async function applyNodeVersion(store, version) {
  const { config, logs } = store;
  const item = NODE_VERSIONS.find((n) => n.v === String(version));
  if (!item) throw new Error('Versi tidak dikenal');
  if (!item.ok) throw new Error(`Node ${item.v} tidak bisa dipakai di Vercel: ${item.why}`);
  await config.set({ nodeVersion: item.v });
  const token = process.env.VERCEL_TOKEN;
  const project = process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_NAME;
  if (!token || !project) {
    return { saved: true, applied: false, note: `Pilihan disimpan. Untuk menerapkannya set VERCEL_TOKEN di Environment Variables, atau ubah manual: Vercel → Settings → Build and Deployment → Node.js Version = ${item.v}.x, lalu Redeploy.` };
  }
  const team = process.env.VERCEL_TEAM_ID ? `?teamId=${encodeURIComponent(process.env.VERCEL_TEAM_ID)}` : '';
  const r = await fetch(`https://api.vercel.com/v9/projects/${encodeURIComponent(project)}${team}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nodeVersion: item.v + '.x' }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('Vercel API: ' + ((j.error && j.error.message) || r.status));
  let redeployed = false;
  if (process.env.DEPLOY_HOOK_URL) {
    const h = await fetch(process.env.DEPLOY_HOOK_URL, { method: 'POST' }).catch(() => null);
    redeployed = Boolean(h && h.ok);
  }
  await logs.add(`[Pterodactyl Daemon]: Node.js diubah ke ${item.v}.x di project Vercel${redeployed ? ' — redeploy dipicu' : ' — silakan Redeploy'}`, 'daemon');
  return { saved: true, applied: true, redeployed, note: redeployed ? 'Redeploy dipicu otomatis. Tunggu ±1 menit.' : 'Node.js project diperbarui. Lakukan Redeploy agar berlaku (atau set DEPLOY_HOOK_URL agar otomatis).' };
}

async function runCommand(store, req, cmdline) {
  const { state, config, logs } = store;
  const [cmd, ...rest] = cmdline.trim().split(/\s+/);
  const args = rest.join(' ');
  const cfg = await config.get();
  await logs.add('container@pterodactyl~ ' + cmdline, 'host');
  switch ((cmd || '').toLowerCase()) {
    case 'help': return logs.add('Perintah: help, status, clear, info, ping, webhook, restart, kill, send <chat_id> <teks>', 'out');
    case 'clear': return logs.clear();
    case 'restart': { await control.stop(store); await control.start(store, req); return null; }
    case 'kill': { await control.kill(store); return null; }
    case 'status': { const st = await state.get(); return logs.add(`status=${st.status} requests=${st.requests} errors=${st.errors} restarts=${st.restarts} kills=${st.kills||0} node=${process.version}`, 'out'); }
    case 'info': {
      if (!cfg.botToken) return logs.add('BOT_TOKEN belum diisi.', 'err');
      const r = await tg.call(cfg.botToken, 'getMe');
      return logs.add(r.ok ? `Bot: @${r.result.username} (id ${r.result.id})` : 'getMe gagal: ' + r.description, r.ok ? 'out' : 'err');
    }
    case 'ping': return logs.add('pong — function aktif ' + new Date().toISOString(), 'ok');
    case 'webhook': {
      if (!cfg.botToken) return logs.add('BOT_TOKEN belum diisi.', 'err');
      const r = await tg.call(cfg.botToken, 'getWebhookInfo');
      return logs.add(r.ok ? JSON.stringify({ url: r.result.url, pending: r.result.pending_update_count, last_error: r.result.last_error_message || null }) : r.description, r.ok ? 'out' : 'err');
    }
    case 'send': {
      const m = args.match(/^(-?\d+)\s+([\s\S]+)$/);
      if (!m) return logs.add('Pemakaian: send <chat_id> <teks>', 'err');
      if (!cfg.botToken) return logs.add('BOT_TOKEN belum diisi.', 'err');
      const r = await tg.call(cfg.botToken, 'sendMessage', { chat_id: m[1], text: m[2] });
      return logs.add(r.ok ? 'Terkirim.' : 'Gagal: ' + r.description, r.ok ? 'ok' : 'err');
    }
    case '': return null;
    default: return logs.add(`Perintah tidak dikenal: ${cmd}. Ketik "help".`, 'err');
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const a = (req.query && req.query.a) || '';
  const q = req.query || {};
  const body = (typeof req.body === 'string' ? safeJson(req.body) : req.body) || {};
  try {
    if (a === 'setup') return res.json({ ok: true, configured: auth.configured(), admins: auth.adminCount(), persistent: PERSISTENT });
    if (a === 'login') {
      if (!auth.configured()) return bad(res, 503, 'ADMIN_PASSWORD belum di-set (min. 6 karakter) di Environment Variables Vercel.');
      const id = auth.checkPassword(body.password || '');
      if (!id) { await sleep(900); return bad(res, 401, 'Password salah'); }
      return res.json({ ok: true, token: auth.issueToken(id), admin: id });
    }
    const who = auth.isAuthed(req);
    if (!who) return bad(res, 401, 'Belum login');
    // Setiap admin punya server sendiri yang terisolasi total: file, console, config, token bot,
    // dan webhook-nya masing-masing tidak pernah bersinggungan dengan admin lain.
    const store = createStore(who);
    const { fs, state, config, logs } = store;

    switch (a) {
      case 'status': {
        const [st, cfg, usage] = await Promise.all([state.get(), config.get(), fs.usage()]);
        const running = st.status === 'running';
        return res.json({
          ok: true, status: st.status, uptime: running && st.startedAt ? Date.now() - st.startedAt : 0,
          address: (tg.baseUrl(req) || '').replace('https://', '') + (who !== '1' ? ` (server #${who})` : ''),
          cpu: st.lastCpu, memory: st.lastMem, disk: usage, netIn: st.bytesIn, netOut: st.bytesOut,
          requests: st.requests, errors: st.errors, lastMs: st.lastMs, lastRun: st.lastRun, restarts: st.restarts, kills: st.kills, lastAuto: st.lastAuto,
          nodeRuntime: process.version, nodeChosen: cfg.nodeVersion, persistent: PERSISTENT, hasToken: Boolean(cfg.botToken), botUsername: cfg.botUsername,
          admin: who, admins: auth.adminCount(), autoRestart: cfg.autoRestart, cpuLimit: cfg.cpuLimit,
          region: REGIONS[process.env.VERCEL_REGION] || process.env.VERCEL_REGION || 'tidak diketahui',
        });
      }
      case 'console': return res.json({ ok: true, lines: await logs.tail(250) });
      case 'power': {
        const act = body.action;
        if (act === 'start') return res.json({ ok: true, ...(await control.start(store, req)) });
        if (act === 'stop') { await control.stop(store); return res.json({ ok: true }); }
        if (act === 'restart') { await control.stop(store); return res.json({ ok: true, ...(await control.start(store, req)) }); }
        if (act === 'kill') { await control.kill(store); return res.json({ ok: true }); }
        return bad(res, 400, 'Aksi tidak dikenal');
      }
      case 'command': await runCommand(store, req, String(body.cmd || '').slice(0, 1000)); return res.json({ ok: true });

      /* ---- file manager ---- */
      case 'files': {
        await seedIfEmpty(store);
        return res.json({ ok: true, dir: norm(q.dir), items: await fs.list(q.dir) });
      }
      case 'read': {
        const p = norm(q.path);
        const st = await fs.stat(p);
        if (!st) return bad(res, 404, 'File tidak ditemukan');
        if (st.t === 'd') return bad(res, 400, 'Ini folder');
        if (st.s > EDITOR_MAX) return bad(res, 413, `File ${Math.round(st.s / 1024)} KB terlalu besar untuk editor teks — pakai menu Download.`);
        const buf = (await fs.readBuffer(p)) || Buffer.alloc(0);
        if (buf.subarray(0, 8000).includes(0)) return bad(res, 415, 'File biner — tidak bisa diedit. Pakai menu Download.');
        return res.json({ ok: true, path: p, content: buf.toString('utf8') });
      }
      case 'write': return res.json({ ok: true, ...(await fs.writeText(body.path, body.content)) });
      case 'fileChunk': {
        const i = Number(body.i), n = Number(body.n), size = Number(body.size);
        if (![i, n, size].every(Number.isInteger) || i < 0 || n < 0 || i >= Math.max(n, 1) || typeof (body.data || '') !== 'string') return bad(res, 400, 'Parameter chunk tidak valid');
        return res.json({ ok: true, ...(await fs.putChunk(body.path, i, n, size, body.data || '')) });
      }
      case 'stat': { const st = await fs.stat(q.path); if (!st) return bad(res, 404, 'Tidak ditemukan'); return res.json({ ok: true, size: st.s || 0, chunks: st.c || 0, type: st.t }); }
      case 'readChunk': return res.json({ ok: true, data: await fs.readChunk(q.path, Number(q.i) || 0) });
      case 'mkdir': return res.json({ ok: true, path: await fs.mkdir(body.path) });
      case 'delete': return res.json({ ok: true, removed: await fs.remove(Array.isArray(body.paths) ? body.paths : []) });
      case 'rename': return res.json({ ok: true, moved: await fs.rename(body.from, body.to) });
      case 'recount': return res.json({ ok: true, ...(await fs.recount()) });

      /* ---- unzip ---- */
      case 'unzipInfo': {
        const z = await getZip(store, norm(q.path));
        const entries = z.entries;
        return res.json({
          ok: true, count: entries.length, files: entries.filter((e) => !e.dir).length,
          totalSize: entries.reduce((s, e) => s + (e.usize || 0), 0),
          root: detectRoot(entries), heavy: entries.filter((e) => !e.dir && isHeavy(e.name)).length,
        });
      }
      case 'unzip': return res.json({ ok: true, ...(await unzipStep(store, body)) });

      /* ---- sinkronisasi dependencies ke GitHub ---- */
      case 'depsStatus': return res.json({ ok: true, configured: github.configured(), repo: process.env.GITHUB_REPO || '', hasHook: Boolean(process.env.DEPLOY_HOOK_URL) });
      case 'depsFromFile': {
        // baca dependencies dari sebuah package.json yang SUDAH ada di File Manager (hasil upload SC),
        // bandingkan dengan paket yang benar-benar resolvable di deployment yang sedang jalan.
        const p = norm(q.path || '/package.json');
        const buf = await fs.readBuffer(p);
        if (!buf) return bad(res, 404, `${p} tidak ditemukan di File Manager`);
        let pkg; try { pkg = JSON.parse(buf.toString('utf8')); } catch { return bad(res, 400, `${p} bukan JSON yang valid`); }
        const wanted = { ...(pkg.dependencies || {}) };
        const dep = runner.checkDeps({ '/package.json': JSON.stringify({ dependencies: wanted }) });
        return res.json({ ok: true, total: Object.keys(wanted).length, missing: dep.missing, wanted });
      }
      case 'depsSync': {
        const wanted = body.dependencies && typeof body.dependencies === 'object' ? body.dependencies : null;
        if (!wanted) return bad(res, 400, 'Tidak ada daftar dependencies yang dikirim');
        const r = await github.syncDependencies(wanted);
        if (r.changed) await logs.add(`[Pterodactyl Daemon]: Dependencies disinkronkan ke GitHub (${[...r.added, ...r.updated].join(', ') || '-'})${r.redeployed ? ' — redeploy dipicu' : ' — silakan Redeploy manual'}`, 'daemon');
        return res.json({ ok: true, ...r });
      }

      /* ---- startup / settings ---- */
      case 'config': {
        if (req.method === 'POST') {
          const upd = {};
          if (typeof body.botToken === 'string' && body.botToken.trim()) upd.botToken = body.botToken.trim();
          if (typeof body.entry === 'string') upd.entry = body.entry.trim() ? norm(body.entry.trim()).slice(1) : '';
          if (typeof body.envVars === 'string') upd.envVars = body.envVars.slice(0, 20000);
          if (typeof body.autoPing === 'boolean') upd.autoPing = body.autoPing ? '1' : '0';
          if (typeof body.autoRestart === 'boolean') upd.autoRestart = body.autoRestart ? '1' : '0';
          if (body.cpuLimit !== undefined) upd.cpuLimit = Math.min(100, Math.max(10, parseInt(body.cpuLimit, 10) || 90));
          if (body.cpuStreak !== undefined) upd.cpuStreak = Math.min(20, Math.max(1, parseInt(body.cpuStreak, 10) || 3));
          await config.set(upd);
        }
        const c = await config.get();
        const entryAuto = await detectEntry(store, c.entry);
        return res.json({
          ok: true, entry: c.entry, entryAuto: entryAuto ? entryAuto.slice(1) : '', tokenSource: c.tokenSource, envVars: c.envVars, autoPing: c.autoPing,
          autoRestart: c.autoRestart, cpuLimit: c.cpuLimit, cpuStreak: c.cpuStreak,
          hasToken: Boolean(c.botToken), tokenHint: c.botToken ? '••••' + c.botToken.slice(-4) : '',
          nodeChosen: c.nodeVersion, nodeRuntime: process.version, nodeVersions: NODE_VERSIONS,
          vercelApi: Boolean(process.env.VERCEL_TOKEN && (process.env.VERCEL_PROJECT_ID || process.env.VERCEL_PROJECT_NAME)),
        });
      }
      case 'nodeversion': return res.json({ ok: true, ...(await applyNodeVersion(store, body.version)) });
      case 'webhookinfo': {
        const c = await config.get();
        if (!c.botToken) return bad(res, 400, 'BOT_TOKEN belum diisi');
        const r = await tg.call(c.botToken, 'getWebhookInfo');
        return res.json({ ok: r.ok, info: r.result, expected: control.webhookUrl(req, who), error: r.description });
      }
      case 'info': return res.json({ ok: true, base: tg.baseUrl(req), cron: '0 0 * * *', webhookUrl: control.webhookUrl(req, who) });
      default: return bad(res, 404, 'Aksi tidak dikenal');
    }
  } catch (e) {
    return bad(res, 500, String((e && e.message) || e));
  }
};
void baseName;
