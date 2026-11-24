'use strict';
const { state, config, logs } = require('./store');
const tg = require('./telegram');
const auth = require('./auth');

const D = '[Pterodactyl Daemon]:';
const ALLOWED = ['message', 'edited_message', 'callback_query', 'inline_query', 'channel_post', 'my_chat_member', 'chat_member'];

async function start(req, opts = {}) {
  const runner = require('./runner');
  const cfg = await config.get();
  await logs.addMany([
    { k: 'daemon', m: `${D} Updating process configuration files...` },
    { k: 'daemon', m: `${D} Ensuring file permissions are set correctly, this could take a few seconds...` },
    { k: 'host', m: 'container@pterodactyl~ Server marked as starting...' },
  ]);
  await state.set({ status: 'starting' });

  // 1) jalankan script bot (intro/banner/log-nya tampil di console) dan cari token dari dalam script
  let boot;
  try { boot = await runner.startApp(cfg); }
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
    out.push({ k: 'warn', m: `Tambahkan ke "dependencies" di package.json repo GitHub (${snippet}) lalu Redeploy — Vercel tidak bisa npm install saat runtime.` });
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

  const url = tg.baseUrl(req) + '/api/webhook';
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
  await config.set({ whSecret: secret });
  await state.set({ status: 'running', startedAt: Date.now(), hotStreak: 0, errStreak: 0 });
  await logs.addMany([
    { k: 'daemon', m: `${D} Webhook terpasang -> ${url}` },
    { k: 'ok', m: `Bot @${me.result.username} (${me.result.first_name}) ONLINE · token dari ${boot.source || 'config'}. Telegram mengirim update ke server ini 24 jam.` },
  ]);
  return { username: me.result.username, url, source: boot.source };
}

async function stop() {
  const cfg = await config.get();
  await logs.add('container@pterodactyl~ Server marked as stopping...', 'host');
  if (cfg.botToken) {
    const r = await tg.call(cfg.botToken, 'deleteWebhook', { drop_pending_updates: false });
    if (!r.ok) await logs.add(`${D} deleteWebhook: ${r.description}`, 'err');
  }
  await state.set({ status: 'offline', startedAt: 0 });
  await logs.add('container@pterodactyl~ Server marked as offline...', 'host');
}

/** Restart otomatis (watchdog): pasang ulang webhook, reset cache kode & penghitung. Ada cooldown 5 menit. */
async function autoRestart(req, reason) {
  const st = await state.get();
  if (Date.now() - st.lastAuto < 300000) return false;
  await state.set({ lastAuto: Date.now() });
  await state.incr('restarts', 1);
  await logs.add(`${D} ⚠ ${reason} — restart otomatis dijalankan untuk memulihkan server...`, 'warn');
  global.__PANEL_CODE__ = null;
  try { await stop(); await start(req); await logs.add(`${D} Restart otomatis selesai. Server pulih.`, 'ok'); return true; }
  catch (e) { await logs.add(`${D} Restart otomatis gagal: ${e.message}`, 'err'); return false; }
}

/** Dipanggil keepalive: pastikan webhook masih terpasang (self-healing). */
async function ensureWebhook(req) {
  const st = await state.get();
  if (st.status !== 'running') return { skipped: 'offline' };
  if (Date.now() - st.lastRepair < 55000) return { skipped: 'baru dicek' };
  const cfg = await config.get();
  if (!cfg.botToken || !cfg.whSecret) return { skipped: 'belum siap' };
  await state.set({ lastRepair: Date.now() });
  const want = tg.baseUrl(req) + '/api/webhook';
  const info = await tg.call(cfg.botToken, 'getWebhookInfo');
  if (info.ok && info.result.url === want) return { ok: true, pending: info.result.pending_update_count, repaired: false };
  const r = await tg.call(cfg.botToken, 'setWebhook', { url: want, secret_token: cfg.whSecret, allowed_updates: ALLOWED });
  await logs.add(`${D} Webhook hilang/berubah — dipasang ulang otomatis (${r.ok ? 'berhasil' : r.description})`, r.ok ? 'daemon' : 'err');
  return { ok: r.ok, repaired: true };
}

module.exports = { start, stop, autoRestart, ensureWebhook };
