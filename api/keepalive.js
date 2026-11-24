'use strict';
const { state } = require('../lib/store');
const { ensureWebhook } = require('../lib/control');

// Endpoint "pembangun": dipanggil Vercel Cron / UptimeRobot / cron-job.org / tab panel yang terbuka.
// Tidak butuh login — hanya memastikan webhook tetap terpasang dan mengembalikan status.
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const st = await state.get();
    const r = await ensureWebhook(req);
    return res.status(200).json({ ok: true, status: st.status, time: new Date().toISOString(), webhook: r });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String(e.message || e) });
  }
};
