'use strict';
process.env.FORCE_COLOR = process.env.FORCE_COLOR || '1'; // agar chalk dll tetap berwarna di console panel
const nodeModule = require('module');
const { fs, state, config, logs, norm } = require('./store');
const { toCjs } = require('./esm');
const tg = require('./telegram');

if (!global.__PANEL_GUARD__) {
  global.__PANEL_GUARD__ = true;
  process.on('unhandledRejection', (e) => { console.error('[panel] unhandledRejection:', e && e.message ? e.message : e); });
}

const BUILTINS = new Set(nodeModule.builtinModules);
const CODE_EXT = /(\.(c|m)?js|\.json)$|(^|\/)\.env$/i;
const MAX_CODE = 5 * 1024 * 1024; // file kode >5MB tidak dimuat ke runner (bukan batas upload)
const TOKEN_RE = /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/;
const ENTRY_CANDS = ['index.js', 'main.js', 'bot.js', 'app.js', 'start.js', 'src/index.js', 'src/main.js', 'server.js', 'index.mjs', 'main.mjs'];

/* ---------- kode & entry ---------- */
async function loadCode() {
  const ver = await fs.codeVersion();
  const c = global.__PANEL_CODE__;
  if (c && c.ver === ver) return c.files;
  const { files } = await fs.walk('/', { skip: ['node_modules', '.git'] });
  const wanted = files.filter((f) => CODE_EXT.test(f.path) && (f.meta.s || 0) <= MAX_CODE);
  const out = {};
  let i = 0;
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (i < wanted.length) {
      const f = wanted[i++];
      const b = await fs.readBuffer(f.path);
      out[f.path] = b ? b.toString('utf8') : '';
    }
  }));
  global.__PANEL_CODE__ = { ver, files: out };
  return out;
}

function entryCandidates(cfgEntry, pkgText) {
  const list = [];
  if (cfgEntry) list.push(cfgEntry);
  try {
    const pkg = JSON.parse(pkgText || '{}');
    if (pkg.main) list.push(pkg.main);
    const s = (pkg.scripts && (pkg.scripts.start || pkg.scripts.dev || '')) || '';
    const m = s.match(/node(?:mon)?\s+(?:--?[\w=.-]+\s+)*([\w./@-]+\.(?:c|m)?js)/);
    if (m) list.push(m[1]);
  } catch { /* package.json rusak -> abaikan */ }
  list.push(...ENTRY_CANDS);
  return [...new Set(list.map((p) => norm(p)))];
}
const pickEntry = (cfgEntry, exists, pkgText) => entryCandidates(cfgEntry, pkgText).find(exists) || null;

function parseEnv(text) {
  const env = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#')) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}
function scanToken(files) {
  const order = Object.keys(files).sort((a, b) => (/\.env$|config|setting|token/i.test(b) ? 1 : 0) - (/\.env$|config|setting|token/i.test(a) ? 1 : 0));
  for (const p of order) { const m = String(files[p]).match(TOKEN_RE); if (m) return { token: m[0], file: p }; }
  return null;
}

/* ---------- console & process tiruan ---------- */
function emit(app, kind, text) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const items = lines.map((l) => ({ k: kind, m: l === '' ? ' ' : l }));
  if (app.sinks.size) for (const s of app.sinks) s.push(...items);
  else { app.buf.push(...items); if (app.buf.length > 300) app.buf.splice(0, app.buf.length - 300); }
}
function makeConsole(app) {
  const fmt = (a) => a.map((x) => {
    if (typeof x === 'string') return x;
    if (x instanceof Error) return x.stack || x.message;
    try { return typeof x === 'object' ? JSON.stringify(x) : String(x); } catch { return String(x); }
  }).join(' ');
  const mk = (k) => (...a) => emit(app, k, fmt(a));
  const c = { log: mk('out'), info: mk('out'), debug: mk('out'), warn: mk('warn'), error: mk('err'), trace: mk('dim') };
  c.table = (d) => emit(app, 'out', fmt([d])); c.dir = (...a) => emit(app, 'out', fmt(a));
  c.group = c.groupEnd = c.time = c.timeEnd = c.assert = () => {};
  return c;
}
function makeProcess(app) {
  const out = (k) => ({ write(s) { emit(app, k, s); return true; }, isTTY: false, columns: 100, on() {}, once() {}, end() {} });
  const so = out('out'), se = out('err');
  const noop = () => proc;
  const proc = new Proxy(process, {
    get(t, k) {
      if (k === 'exit') return (c) => { throw new Error(`process.exit(${c === undefined ? 0 : c}) dipanggil oleh script — diabaikan`); };
      if (['on', 'once', 'addListener', 'off', 'removeListener', 'removeAllListeners', 'prependListener'].includes(k)) return noop;
      if (k === 'stdout') return so;
      if (k === 'stderr') return se;
      const v = Reflect.get(t, k);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  return proc;
}

/* ---------- pembungkus library Telegram: matikan polling, tangkap instance + token ---------- */
function wrapLibs(app) {
  const reg = (kind, inst, token) => { app.instances.push({ kind, inst, token: typeof token === 'string' ? token : '' }); };
  const note = (m) => emit(app, 'dim', `[panel] ${m}`);
  return {
    telegraf(mod) {
      const Real = mod.Telegraf || mod.default;
      if (typeof Real !== 'function') return mod;
      class P extends Real {
        constructor(...a) { super(...a); reg('telegraf', this, a[0]); }
        launch() { note('bot.launch() dialihkan ke mode webhook (tidak memakai polling)'); return Promise.resolve(); }
      }
      return new Proxy(mod, { get: (t, k) => ((k === 'Telegraf' || (k === 'default' && t.default === Real)) ? P : Reflect.get(t, k)) });
    },
    grammy(mod) {
      const Real = mod.Bot;
      if (typeof Real !== 'function') return mod;
      class P extends Real {
        constructor(...a) { super(...a); reg('grammy', this, a[0]); }
        start() { note('bot.start() dialihkan ke mode webhook (tidak memakai polling)'); return Promise.resolve(); }
      }
      return new Proxy(mod, { get: (t, k) => (k === 'Bot' ? P : Reflect.get(t, k)) });
    },
    ntba(mod) {
      const Real = typeof mod === 'function' ? mod : mod && mod.default;
      if (typeof Real !== 'function') return mod;
      const track = (fn) => (...a) => { const r = fn(...a); if (r && typeof r.then === 'function') { const p = Promise.resolve(r).catch((e) => emit(app, 'err', 'Error handler: ' + (e && e.message))); app.pending.push(p); } return r; };
      class P extends Real {
        constructor(token, opts = {}) { super(token, { ...opts, polling: false, webHook: false }); reg('ntba', this, token); }
        startPolling() { note('polling dimatikan — memakai mode webhook'); return Promise.resolve(); }
        stopPolling() { return Promise.resolve(); }
        on(ev, fn) { return super.on(ev, typeof fn === 'function' ? track(fn) : fn); }
        once(ev, fn) { return super.once(ev, typeof fn === 'function' ? track(fn) : fn); }
        onText(re, fn) { return super.onText(re, typeof fn === 'function' ? track(fn) : fn); }
        _request(...a) { const p = super._request(...a); app.pending.push(Promise.resolve(p).catch(() => {})); return p; }
      }
      return P;
    },
  };
}

/* ---------- loader modul virtual ---------- */
function makeLoader(app, cons, proc) {
  const modules = new Map();
  const wrapped = new Map();
  const libs = wrapLibs(app);
  const files = app.files;
  const find = (full) => [full, full + '.js', full + '.cjs', full + '.mjs', full + '.json', full + '/index.js'].find((c) => Object.prototype.hasOwnProperty.call(files, c));
  const applyDotenv = (p = '/.env') => {
    const parsed = parseEnv(files[norm(p)] || files['/.env'] || '');
    const set = (global.__PANEL_ENVKEYS__ = global.__PANEL_ENVKEYS__ || new Set());
    for (const [k, v] of Object.entries(parsed)) if (process.env[k] === undefined) { process.env[k] = v; set.add(k); }
    return parsed;
  };
  function load(path) {
    if (modules.has(path)) return modules.get(path).exports;
    const code = files[path];
    const mod = { exports: {} };
    modules.set(path, mod);
    if (/\.json$/i.test(path)) { mod.exports = JSON.parse(code); return mod.exports; }
    const req = (name) => {
      if (name.startsWith('./') || name.startsWith('../') || name.startsWith('/')) {
        const full = find(name.startsWith('/') ? norm(name) : norm(path + '/../' + name));
        if (!full) throw new Error(`Module '${name}' tidak ditemukan (diminta dari ${path})`);
        return load(full);
      }
      const bare = name.replace(/^node:/, '');
      if (BUILTINS.has(bare)) return require('node:' + bare);
      if (name === 'dotenv') return { config: (o) => ({ parsed: applyDotenv(o && o.path) }), parse: parseEnv };
      if (name === 'dotenv/config') { applyDotenv(); return {}; }
      if (wrapped.has(name)) return wrapped.get(name);
      let real;
      try { real = require(name); } catch (e) {
        throw new Error(`Package '${name}' tidak terpasang di deployment ini. Tambahkan ke "dependencies" di package.json repo GitHub lalu Redeploy (Vercel tidak bisa npm install saat runtime).`);
      }
      const key = name === 'telegraf' ? 'telegraf' : name === 'grammy' ? 'grammy' : name === 'node-telegram-bot-api' ? 'ntba' : null;
      const out = key ? libs[key](real) : real;
      wrapped.set(name, out);
      return out;
    };
    const dyn = (n) => Promise.resolve().then(() => { const m = req(n); return m && m.__esModule ? m : Object.assign({ default: m }, m); });
    const wrapper = new Function('exports', 'require', 'module', '__filename', '__dirname', 'console', 'process', '__dynImport',
      `${toCjs(code)}\n//# sourceURL=panel:${path}`);
    wrapper.call(mod.exports, mod.exports, req, mod, path, path.replace(/\/[^/]*$/, '') || '/', cons, proc, dyn);
    return mod.exports;
  }
  return { load, applyDotenv };
}

/* ---------- aplikasi (script bot yang sedang "berjalan") ---------- */
async function loadApp(cfg) {
  const files = await loadCode();
  const entry = pickEntry(cfg.entry, (p) => p in files, files['/package.json']);
  if (!entry) throw new Error('File utama script tidak ditemukan. Upload script bot (index.js / main.js / bot.js) atau isi "File utama" di tab Startup.');
  // buang variabel yang sebelumnya dimasukkan dari .env (supaya perubahan/penghapusan .env berlaku)
  for (const k of global.__PANEL_ENVKEYS__ || []) delete process.env[k];
  global.__PANEL_ENVKEYS__ = new Set();
  const app = { entry, files, instances: [], handler: null, buf: [], sinks: new Set(), pending: [], init: new Set() };
  const cons = makeConsole(app), proc = makeProcess(app);
  const { load, applyDotenv } = makeLoader(app, cons, proc);
  app.env = applyDotenv();
  const mod = load(entry);
  const h = typeof mod === 'function' ? mod : mod && (mod.handler || mod.default);
  if (!app.instances.length) {
    if (mod && typeof mod.handleUpdate === 'function') app.instances.push({ kind: 'telegraf', inst: mod, token: '' });
    else if (typeof h === 'function') app.handler = h;
  }
  return app;
}
async function getApp(cfg, fresh = false) {
  const key = (await fs.codeVersion()) + '|' + (cfg.entry || '');
  const c = global.__PANEL_APP__;
  if (!fresh && c && c.key === key) return c.promise;
  const promise = loadApp(cfg);
  global.__PANEL_APP__ = { key, promise };
  promise.catch(() => { if (global.__PANEL_APP__ && global.__PANEL_APP__.promise === promise) global.__PANEL_APP__ = null; });
  return promise;
}

/** Dipanggil saat tombol Start: jalankan script (intro/banner tertangkap), cari token dari dalam script. */
async function startApp(cfg) {
  global.__PANEL_APP__ = null;
  const files = await loadCode();
  let app;
  try { app = await getApp(cfg, true); }
  catch (e) { const err = new Error(e && e.message ? e.message : String(e)); err.stack = e && e.stack; err.entry = pickEntry(cfg.entry, (p) => p in files, files['/package.json']); throw err; }
  const output = app.buf.splice(0);
  let token = '', source = '';
  const inst = app.instances.find((i) => TOKEN_RE.test(i.token || ''));
  if (inst) { token = inst.token; source = `script (${inst.kind === 'ntba' ? 'node-telegram-bot-api' : inst.kind})`; }
  if (!token) { const s = scanToken(files); if (s) { token = s.token; source = 'file ' + s.file; } }
  if (!token) { const e = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN; if (e && TOKEN_RE.test(e)) { token = e; source = 'env BOT_TOKEN'; } }
  return { app, entry: app.entry, output, token, source, kind: app.instances[0] ? app.instances[0].kind : app.handler ? 'handler' : 'unknown', files };
}

function checkDeps(files) {
  let pkg = {};
  try { pkg = JSON.parse(files['/package.json'] || '{}'); } catch { return { missing: [], total: 0 }; }
  const deps = Object.keys({ ...(pkg.dependencies || {}), ...(pkg.optionalDependencies || {}) });
  const missing = deps.filter((d) => { try { require.resolve(d + '/package.json'); return false; } catch { try { require.resolve(d); return false; } catch { return true; } } });
  return { missing, total: deps.length, versions: Object.fromEntries(missing.map((m) => [m, (pkg.dependencies || {})[m] || 'latest'])) };
}

/* ---------- proses satu update ---------- */
function buildCtx(update, token, env, buf) {
  const m = update.message || update.edited_message || update.channel_post || update.edited_channel_post
    || (update.callback_query && update.callback_query.message) || null;
  const src = update.message || update.edited_message || update.callback_query || update.inline_query || update.channel_post || {};
  const text = (update.message && (update.message.text || update.message.caption)) || (update.callback_query && update.callback_query.data) || '';
  const cm = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  const api = async (method, params = {}) => {
    const r = await tg.call(token, method, params);
    buf.__out = (buf.__out || 0) + (r.__bytes || 0);
    if (!r.ok) throw new Error(`Telegram ${method}: ${r.description || 'gagal'}`);
    return r.result;
  };
  const chat = m && m.chat;
  return {
    update, message: m, chat, from: src.from || null, text, command: cm ? cm[1].toLowerCase() : null, args: cm && cm[2] ? cm[2].trim() : '', api, env,
    send: (chatId, t, extra = {}) => api('sendMessage', { chat_id: chatId, text: t, ...extra }),
    reply: (t, extra = {}) => { if (!chat) throw new Error('Update ini tidak punya chat untuk dibalas'); return api('sendMessage', { chat_id: chat.id, text: t, ...extra }); },
    answerCallback: (t, extra = {}) => api('answerCallbackQuery', { callback_query_id: update.callback_query.id, text: t, ...extra }),
  };
}

async function dispatch(app, update, cfg, buf) {
  if (app.instances.length) {
    for (const it of app.instances) {
      if (it.kind === 'ntba') {
        it.inst.processUpdate(update);
        for (let n = 0; n < 50 && app.pending.length; n++) await Promise.allSettled(app.pending.splice(0));
      } else {
        if (it.kind === 'grammy' && !app.init.has(it)) { await it.inst.init(); app.init.add(it); }
        await it.inst.handleUpdate(update);
      }
    }
    return;
  }
  if (app.handler) return app.handler(buildCtx(update, cfg.botToken, { ...app.env, BOT_TOKEN: cfg.botToken }, buf));
  throw new Error('Script tidak mengekspor handler. Pakai Telegraf/grammY/node-telegram-bot-api, atau: module.exports = async (ctx) => { ... }');
}

async function runUpdate(update, req, cfgIn, stIn) {
  const cfg = cfgIn || (await config.get());
  const st = stIn || (await state.get());
  const buf = [];
  const t0 = Date.now();
  const cpu0 = process.cpuUsage();
  let ok = true, who = '-';
  try {
    if (!cfg.botToken) throw new Error('Token bot belum terdeteksi — tekan Start di Console.');
    const app = await getApp(cfg);
    const sink = [];
    app.sinks.add(sink);
    let timer;
    try {
      const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('Timeout 25 detik')), 25000); });
      await Promise.race([dispatch(app, update, cfg, buf), timeout]);
    } finally { clearTimeout(timer); app.sinks.delete(sink); buf.push(...sink); }
    const src = update.message || update.edited_message || update.callback_query || update.inline_query || update.channel_post || {};
    const f = src.from; if (f) who = f.username ? '@' + f.username : f.first_name;
    const text = (update.message && update.message.text) || '';
    buf.unshift({ k: 'out', m: `update #${update.update_id} dari ${who}${text ? ': ' + text.slice(0, 80) : ''}` });
  } catch (e) {
    ok = false;
    buf.push({ k: 'err', m: `Error: ${e && e.message ? e.message : e}` });
  }
  const ms = Date.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  const cpuPct = ms > 0 ? Math.min(100, ((cpu.user + cpu.system) / 1000 / ms) * 100) : 0;
  buf.push({ k: ok ? 'dim' : 'err', m: `selesai ${ms}ms · CPU ${cpuPct.toFixed(1)}%` });

  const hot = cpuPct >= cfg.cpuLimit && ms >= 400;
  const hotStreak = hot ? st.hotStreak + 1 : 0;
  const errStreak = ok ? 0 : st.errStreak + 1;
  let reason = '';
  if (cfg.autoRestart) {
    if (hotStreak >= cfg.cpuStreak) reason = `CPU ${cpuPct.toFixed(0)}% (≥${cfg.cpuLimit}%) selama ${hotStreak} proses berturut-turut`;
    else if (errStreak >= 5) reason = `${errStreak} error berturut-turut`;
  }
  const out = buf.__out || 0;
  await Promise.all([
    logs.addMany(buf),
    state.set({ lastCpu: cpuPct.toFixed(2), lastMem: process.memoryUsage().rss, lastMs: ms, lastRun: Date.now(), hotStreak, errStreak }),
    state.incr('requests', 1),
    state.incr('bytesIn', Buffer.byteLength(JSON.stringify(update))),
    out ? state.incr('bytesOut', out) : null,
    ok ? null : state.incr('errors', 1),
  ].filter(Boolean)).catch(() => {});
  if (reason) await require('./control').autoRestart(req, reason).catch(() => {});
  return ok;
}

module.exports = { runUpdate, startApp, checkDeps, loadCode, parseEnv, pickEntry, entryCandidates, TOKEN_RE };
