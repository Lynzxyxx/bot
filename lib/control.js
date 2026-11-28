'use strict';
const tg = require('./telegram');
const auth = require('./auth');

const D = '[Pterodactyl Daemon]:';
const ALLOWED = ['message', 'edited_message', 'callback_query', 'inline_query', 'channel_post', 'my_chat_member', 'chat_member'];

// Webhook admin '1' (legacy/default) TIDAK membawa query ?s=, supaya URL yang sudah
// terpasang di Telegram sebelum fitur multi-server ini tetap valid tanpa perlu Start ulang.
// Admin lain mendapat URL webhook sendiri: /api/webhook?s=<id> — jadi Telegram tahu
// update itu untuk server admin mana, dan tiap admin punya bot token berbeda.
function webhookUrl(req, ns) {
  const base = tg.baseUrl(req) + '/api/webhook';
  return ns && ns !== '1' ? `${base}?s=${encodeURIComponent(ns)}` : base;
}

async function start(store, req, opts = {}) {
  const runner = require('./runner');
  const { state, config, logs } = store;
  const cfg = await config.get();
  await logs.addMany([
    { k: 'daemon', m: `${D} Updating process configuration files...` },
    { k: 'daemon', m: `${D} Ensuring file permissions are set correctly, this could take a few seconds...` },
    { k: 'host', m: 'container@pterodactyl~ Server marked as starting...' },
  ]);
  await state.set({ status: 'starting' });

  // 1) jalankan script bot (intro/banner/log-nya tampil di console) dan cari token dari dalam script
  let boot;
  try { boot = await runner.startApp(store, cfg); }
  catch (e) {
    const lines = [{ k: 'out', m: `> node ${e.entry ? e.entry.slice(1) : '(file utama tidak ketemu)'}` }];
    String(e.stack || e.message).split('\n').slice(0, 9).forEach((l) => lines.push({ k: 'err', m: l || ' ' }));
    lines.push({ k: 'host', m: 'container@pterodactyl~ Server marked as offline...' });
    await logs.addMany(lines);
    await state.set({ status: 'offline', startedAt: 0 });
    throw new Error('Script gagal dijalankan: ' + e.message);
  }
  const dep = runner.checkDeps(boot.files);
  const out = [{ k: 'out', m: `v${process.versions.node}` }, { k: 'out', m: `> node ${boot.entry.slice(1)}` }, ...boot.output];
  if (dep.missing.length) {
    const snippet = dep.missing.map((m) => `"${m}": "${dep.versions[m]}"`).join(', ');
    out.push({ k: 'warn', m: `${D} ⚠ Paket belum terpasang di deployment: ${dep.missing.join(', ')}` });
    out.push({ k: 'warn', m: `Tambahkan ke "dependencies" di package.json repo GitHub (${snippet}) lalu Redeploy — Vercel tidak bisa npm install saat runtime. Atau pakai tombol "Sinkronkan ke GitHub" di Files.` });
  }
  await logs.addMany(out);

  // 2) token: dari script (constructor bot / file config / .env) — bukan diisi dari panel
  const token = boot.token || cfg.botToken;
  if (!token) {
    await logs.addMany([
      { k: 'err', m: 'Token bot tidak ditemukan di script. Pastikan config script (mis. config.js / .env / new Telegraf(token)) berisi token dari @BotFather.' },
      { k: 'host', m: 'container@pterodactyl~ Server marked as offline...' },
    ]);
    await state.set({ status: 'offline', startedAt: 0 });
    throw new Error('Token bot tidak ditemukan di dalam script (config.js / .env / new Telegraf(token)).');
  }
  if (boot.token) await config.set({ botToken: boot.token, tokenSource: boot.source });

  const url = webhookUrl(req, store.ns);
  const me = await tg.call(token, 'getMe');
  if (!me.ok) {
    await state.set({ status: 'offline' });
    await logs.addMany([{ k: 'err', m: `${D} Token ditolak Telegram: ${me.description}` }, { k: 'host', m: 'container@pterodactyl~ Server marked as offline...' }]);
    throw new Error('Token di script ditolak Telegram: ' + me.description);
  }
  const secret = auth.newSecret();
  const wh = await tg.call(token, 'setWebhook', { url, secret_token: secret, allowed_updates: ALLOWED, max_connections: 40, drop_pending_updates: Boolean(opts.dropPending) });
  if (!wh.ok) {
    await state.set({ status: 'offline' });
    await logs.add(`${D} setWebhook gagal: ${wh.description}`, 'err');
    throw new Error('setWebhook gagal: ' + wh.description);
  }
  await config.set({ whSecret: secret, botUsername: me.result.username });
  await state.set({ status: 'running', startedAt: Date.now(), hotStreak: 0, errStreak: 0 });
  await logs.addMany([
    { k: 'daemon', m: `${D} Webhook terpasang -> ${url}` },
    { k: 'ok', m: `Bot @${me.result.username} (${me.result.first_name}) ONLINE · token dari ${boot.source || 'config'}. Telegram mengirim update ke server ini 24 jam.` },
  ]);
  return { username: me.result.username, url, source: boot.source };
}

async function stop(store) {
  const { state, config, logs } = store;
  const cfg = await config.get();
  await logs.add('container@pterodactyl~ Server marked as stopping...', 'host');
  if (cfg.botToken) {
    const r = await tg.call(cfg.botToken, 'deleteWebhook', { drop_pending_updates: false });
    if (!r.ok) await logs.add(`${D} deleteWebhook: ${r.description}`, 'err');
  }
  await state.set({ status: 'offline', startedAt: 0 });
  await logs.add('container@pterodactyl~ Server marked as offline...', 'host');
}

/**
 * Kill (paksa): beda dari Stop biasa — langsung putus webhook SAMBIL membuang semua
 * update Telegram yang masih antre (drop_pending_updates), mengosongkan console, dan
 * mereset cache kode & penghitung statistik. Dipakai saat server "nyangkut"/boros CPU
 * dan Stop biasa dirasa kurang (mirip tombol Kill di Pterodactyl asli).
 */
async function kill(store) {
  const { state, config, logs } = store;
  const cfg = await config.get();
  await logs.add('container@pterodactyl~ Server dipaksa berhenti (Kill)...', 'host');
  if (cfg.botToken) await tg.call(cfg.botToken, 'deleteWebhook', { drop_pending_updates: true }).catch(() => {});
  if (global.__PANEL_CODE__) global.__PANEL_CODE__.delete(store.ns);
  if (global.__PANEL_APP__) global.__PANEL_APP__.delete(store.ns);
  await logs.clear();
  await state.set({ status: 'offline', startedAt: 0, hotStreak: 0, errStreak: 0, requests: 0, errors: 0, bytesIn: 0, bytesOut: 0 });
  await state.incr('kills', 1);
  await logs.add('container@pterodactyl~ Server offline (dipaksa). Cache & statistik direset.', 'host');
}

/** Restart otomatis (watchdog): pasang ulang webhook, reset cache kode & penghitung. Ada cooldown 5 menit. */
async function autoRestart(store, req, reason) {
  const { state, logs } = store;
  const st = await state.get();
  if (Date.now() - st.lastAuto < 300000) return false;
  await state.set({ lastAuto: Date.now() });
  await state.incr('restarts', 1);
  await logs.add(`${D} ⚠ ${reason} — restart otomatis dijalankan untuk memulihkan server...`, 'warn');
  if (global.__PANEL_CODE__) global.__PANEL_CODE__.delete(store.ns);
  if (global.__PANEL_APP__) global.__PANEL_APP__.delete(store.ns);
  try { await stop(store); await start(store, req); await logs.add(`${D} Restart otomatis selesai. Server pulih.`, 'ok'); return true; }
  catch (e) { await logs.add(`${D} Restart otomatis gagal: ${e.message}`, 'err'); return false; }
}

/** Dipanggil keepalive: pastikan webhook masih terpasang (self-healing). */
async function ensureWebhook(store, req) {
  const { state, config, logs } = store;
  const st = await state.get();
  if (st.status !== 'running') return { skipped: 'offline' };
  if (Date.now() - st.lastRepair < 55000) return { skipped: 'baru dicek' };
  const cfg = await config.get();
  if (!cfg.botToken || !cfg.whSecret) return { skipped: 'belum siap' };
  await state.set({ lastRepair: Date.now() });
  const want = webhookUrl(req, store.ns);
  const info = await tg.call(cfg.botToken, 'getWebhookInfo');
  if (info.ok && info.result.url === want) return { ok: true, pending: info.result.pending_update_count, repaired: false };
  const r = await tg.call(cfg.botToken, 'setWebhook', { url: want, secret_token: cfg.whSecret, allowed_updates: ALLOWED });
  await logs.add(`${D} Webhook hilang/berubah — dipasang ulang otomatis (${r.ok ? 'berhasil' : r.description})`, r.ok ? 'daemon' : 'err');
  return { ok: r.ok, repaired: true };
}

module.exports = { start, stop, kill, autoRestart, ensureWebhook, webhookUrl };
