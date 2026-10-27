// crypto.js — パスワードから鍵を作り、データを AES-GCM で暗号化する
// パスワード自体はどこにも保存しない。復号できたことが「ログイン成功」になる。

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode('cashflow-vault-v1');
export const ITERATIONS = 600000; // PBKDF2-HMAC-SHA256（OWASP 推奨値）

function toB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(s);
}
const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false, // 鍵は取り出せない
    ['encrypt', 'decrypt'],
  );
}

// 新しいパスワードで鍵を作る（ソルトは毎回ランダム）
export async function create(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const kdf = { name: 'PBKDF2-SHA256', iter: ITERATIONS, salt: toB64(salt) };
  return { key: await deriveKey(password, salt, ITERATIONS), kdf };
}

// 保存ごとに新しい IV で暗号化
export async function seal(key, kdf, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, enc.encode(JSON.stringify(data)));
  return { format: 'cashflow-vault', v: 1, kdf, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) };
}

// パスワードが違う・改ざんされている場合は例外になる
export async function open(vault, password) {
  if (!vault || vault.format !== 'cashflow-vault' || !vault.kdf) throw new Error('format');
  const key = await deriveKey(password, fromB64(vault.kdf.salt), vault.kdf.iter);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(vault.iv), additionalData: AAD }, key, fromB64(vault.ct));
  return { key, kdf: vault.kdf, data: JSON.parse(dec.decode(pt)) };
}
