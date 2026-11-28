'use strict';
const { createStore } = require('../lib/store');
const auth = require('../lib/auth');
const { ensureWebhook } = require('../lib/control');

// Endpoint "pembangun": dipanggil Vercel Cron / UptimeRobot / cron-job.org / tab panel yang terbuka.
// Tidak butuh login — memeriksa & memasang ulang webhook SETIAP server/admin yang sedang running.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const ids = auth.adminIds();
    const results = {};
    for (const id of ids) {
      const store = createStore(id);
      const st = await store.state.get();
      results[id] = { status: st.status, webhook: await ensureWebhook(store, req) };
    }
    const anyRunning = Object.values(results).some((r) => r.status === 'running');
    return res.status(200).json({ ok: true, time: new Date().toISOString(), servers: results, status: anyRunning ? 'running' : 'offline' });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
