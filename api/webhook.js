'use strict';
const { createStore } = require('../lib/store');
const auth = require('../lib/auth');
const { runUpdate } = require('../lib/runner');

// Endpoint yang dipanggil Telegram. Selalu balas 200 supaya Telegram tidak mengulang-ulang update.
// ?s=<id> menentukan server/admin mana yang dituju (tiap admin punya bot & token sendiri);
// tanpa ?s= berarti admin 1 (default/legacy, supaya webhook yang sudah terpasang sebelum
// fitur multi-server ini tetap valid).
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Pterodactyl webhook OK');
  try {
    const ns = String((req.query && req.query.s) || '1');
    if (!auth.isKnownAdmin(ns)) return res.status(404).send('server tidak dikenal');
    const store = createStore(ns);
    const [cfg, st] = await Promise.all([store.config.get(), store.state.get()]);
    const sent = req.headers['x-telegram-bot-api-secret-token'];
    if (!cfg.botToken || !cfg.whSecret || !auth.safeEqual(sent, cfg.whSecret)) return res.status(401).send('forbidden');
    if (st.status !== 'running') return res.status(200).send('server offline');
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!update || typeof update.update_id !== 'number') return res.status(200).send('ignored');
    await runUpdate(store, update, req, cfg, st); // harus di-await: function serverless dibekukan setelah respons dikirim
  } catch (e) {
    console.error('webhook error', e);
  }
  return res.status(200).send('ok');
};
