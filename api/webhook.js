'use strict';
const { state, config } = require('../lib/store');
const auth = require('../lib/auth');
const { runUpdate } = require('../lib/runner');

// Endpoint yang dipanggil Telegram. Selalu balas 200 supaya Telegram tidak mengulang-ulang update.
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(200).send('Pterodactyl webhook OK');
  try {
    const [cfg, st] = await Promise.all([config.get(), state.get()]);
    const sent = req.headers['x-telegram-bot-api-secret-token'];
    if (!cfg.botToken || !cfg.whSecret || !auth.safeEqual(sent, cfg.whSecret)) return res.status(401).send('forbidden');
    if (st.status !== 'running') return res.status(200).send('server offline');
    const update = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    if (!update || typeof update.update_id !== 'number') return res.status(200).send('ignored');
    await runUpdate(update, req, cfg, st); // harus di-await: function serverless dibekukan setelah respons dikirim
  } catch (e) {
    console.error('webhook error', e);
  }
  return res.status(200).send('ok');
};
