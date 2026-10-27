// sync.js — 暗号化済みの vault を、自分のプライベートリポジトリに 1 ファイルとして置いて端末間で共有する
// GitHub に送るのは暗号文だけ。トークンはこの端末に暗号化して保存する。

const API = 'https://api.github.com';

export class SyncError extends Error {
  constructor(kind, status) { super(kind); this.kind = kind; this.status = status; }
}

const enc = s => s.split('/').map(encodeURIComponent).join('/');
const fileURL = c => `${API}/repos/${enc(c.owner)}/${enc(c.repo)}/contents/${enc(c.path)}`;

async function gh(c, url, opt = {}) {
  let r;
  try {
    r = await fetch(url, {
      ...opt,
      cache: 'no-store',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${c.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(opt.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
  } catch { throw new SyncError('offline'); }
  return r;
}

// 接続の確認：リポジトリが見えて、非公開で、書き込めること
export async function check(c) {
  const r = await gh(c, `${API}/repos/${enc(c.owner)}/${enc(c.repo)}`);
  if (r.status === 401) throw new SyncError('auth', 401);
  if (r.status === 403 || r.status === 404) throw new SyncError('norepo', r.status);
  if (!r.ok) throw new SyncError('http', r.status);
  const j = await r.json();
  if (!j.private) throw new SyncError('public');
  if (j.permissions && !j.permissions.push) throw new SyncError('readonly');
  return true;
}

// → { sha, vault } / ファイルがなければ null
export async function get(c) {
  const r = await gh(c, fileURL(c));
  if (r.status === 404) return null;
  if (r.status === 401) throw new SyncError('auth', 401);
  if (r.status === 403) throw new SyncError('norepo', 403);
  if (!r.ok) throw new SyncError('http', r.status);
  const j = await r.json();
  let vault;
  try { vault = JSON.parse(atob(String(j.content || '').replace(/\s/g, ''))); } catch { throw new SyncError('broken'); }
  if (!vault || vault.format !== 'cashflow-vault') throw new SyncError('broken');
  return { sha: j.sha, vault };
}

// sha が手元のものと違えば（別の端末が先に保存していれば）conflict
export async function put(c, vault, sha, { keepalive = false } = {}) {
  const body = { message: 'キャッシュフローのデータを更新', content: btoa(JSON.stringify(vault)) };
  if (sha) body.sha = sha;
  const r = await gh(c, fileURL(c), { method: 'PUT', body: JSON.stringify(body), keepalive });
  if (r.status === 409 || r.status === 422) throw new SyncError('conflict', r.status);
  if (r.status === 401) throw new SyncError('auth', 401);
  if (r.status === 403 || r.status === 404) throw new SyncError('readonly', r.status);
  if (!r.ok) throw new SyncError('http', r.status);
  return (await r.json()).content.sha;
}

export const message = e => ({
  offline: 'GitHub につながりません。この端末には保存してあり、つながったら同期します。',
  auth: 'トークンが無効か期限切れです。「設定 → 端末間の同期」で新しいトークンを入れてください。',
  norepo: 'リポジトリが見つからないか、トークンにそのリポジトリの権限がありません。',
  public: 'このリポジトリは公開されています。同期には非公開（Private）のリポジトリを使ってください。',
  readonly: 'トークンに書き込みの権限がありません。Contents を「Read and write」にしてください。',
  broken: '同期先のファイルがこのアプリのデータではありません。',
  conflict: '別の端末が先に保存しました。',
  http: 'GitHub でエラーが起きました。しばらくしてからもう一度試してください。',
}[e?.kind] || '同期に失敗しました。');
