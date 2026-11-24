'use strict';

async function call(token, method, params = {}) {
  const body = JSON.stringify(params);
  const r = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const j = await r.json().catch(() => ({ ok: false, description: 'Respons bukan JSON (HTTP ' + r.status + ')' }));
  j.__bytes = Buffer.byteLength(body);
  return j;
}

// URL publik tempat webhook dipasang
function baseUrl(req) {
  let host = process.env.PUBLIC_URL || process.env.VERCEL_PROJECT_PRODUCTION_URL || '';
  if (!host && req) host = req.headers['x-forwarded-host'] || req.headers.host || '';
  host = host.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return 'https://' + host;
}

module.exports = { call, baseUrl };
