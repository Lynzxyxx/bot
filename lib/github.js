'use strict';
// Sinkronisasi dependencies otomatis ke package.json di GitHub, lewat GitHub Contents API.
// Butuh env: GITHUB_TOKEN (Personal Access Token, scope "repo" atau "Contents: Read & Write"
// untuk fine-grained token) dan GITHUB_REPO (format "pemilik/nama-repo"). GITHUB_BRANCH opsional (default "main").
// Token HANYA dibaca dari Environment Variable Vercel — panel tidak pernah menyimpannya di Redis
// maupun menerimanya lewat input UI, supaya tidak ada token tertempel di tempat yang kurang aman.

function configured() { return Boolean(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO); }

function headers() {
  return {
    Authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'pterodactyl-vercel-panel',
  };
}
function apiBase() {
  const repo = process.env.GITHUB_REPO;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('GITHUB_REPO tidak valid. Format: "namaAkun/namaRepo".');
  return `https://api.github.com/repos/${repo}`;
}
const branch = () => process.env.GITHUB_BRANCH || 'main';

async function getFile(path) {
  const r = await fetch(`${apiBase()}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch())}`, { headers: headers() });
  if (r.status === 404) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub API (get ${path}): ${j.message || r.status}`);
  return { content: Buffer.from(j.content, 'base64').toString('utf8'), sha: j.sha };
}

async function putFile(path, content, sha, message) {
  const body = { message, content: Buffer.from(content, 'utf8').toString('base64'), branch: branch() };
  if (sha) body.sha = sha;
  const r = await fetch(`${apiBase()}/contents/${encodeURIComponent(path)}`, { method: 'PUT', headers: headers(), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub API (put ${path}): ${j.message || r.status}`);
  return j;
}

/**
 * Gabungkan `wanted` (dependencies dari package.json SC yang di-upload) ke package.json repo GitHub.
 * Hanya MENAMBAH/memperbarui versi paket yang belum ada atau beda — tidak pernah menghapus
 * dependency lain yang sudah ada di repo (termasuk punya panel sendiri).
 * Mengembalikan { changed:false } kalau tidak ada yang perlu diubah (tidak membuat commit kosong).
 */
async function syncDependencies(wanted, { dryRun = false } = {}) {
  if (!configured()) throw new Error('Sinkronisasi butuh env GITHUB_TOKEN dan GITHUB_REPO (lihat Settings).');
  const entries = Object.entries(wanted || {}).filter(([k]) => k && !/^(telegraf|grammy|node-telegram-bot-api)$/.test(k) || true);
  const file = await getFile('package.json');
  if (!file) throw new Error('package.json tidak ditemukan di repo GitHub. Pastikan GITHUB_REPO benar dan file ada di root.');
  let pkg;
  try { pkg = JSON.parse(file.content); } catch { throw new Error('package.json di repo GitHub rusak (bukan JSON valid).'); }
  pkg.dependencies = pkg.dependencies || {};
  const added = [], updated = [];
  for (const [name, version] of entries) {
    if (!name || typeof version !== 'string') continue;
    if (!(name in pkg.dependencies)) { pkg.dependencies[name] = version; added.push(name); }
    else if (pkg.dependencies[name] !== version && /^[\^~]?\d/.test(version)) { updated.push(`${name} (${pkg.dependencies[name]} → ${version})`); pkg.dependencies[name] = version; }
  }
  if (!added.length && !updated.length) return { changed: false, added, updated };
  if (dryRun) return { changed: true, added, updated, preview: true };
  const newContent = JSON.stringify(pkg, null, 2) + '\n';
  await putFile('package.json', newContent, file.sha, `panel: sinkronkan dependencies (${[...added, ...updated].join(', ')})`);
  let redeployed = false;
  if (process.env.DEPLOY_HOOK_URL) { const h = await fetch(process.env.DEPLOY_HOOK_URL, { method: 'POST' }).catch(() => null); redeployed = Boolean(h && h.ok); }
  return { changed: true, added, updated, redeployed };
}

module.exports = { configured, getFile, putFile, syncDependencies };
