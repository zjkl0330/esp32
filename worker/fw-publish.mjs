// 把编好的固件发布到 KV，并生成设备要读的 manifest.json。
//
//   node tunnel/fw-publish.mjs --c6 build-c6/ESP32_C6_Exit.ino.bin \
//                              [--d0wd build-d0wd/ESP32_C6_Exit.ino.bin]
//
// 为什么走 KV 而不是让 Worker 自己带二进制：Worker 脚本体积有上限，
// 而固件是 1.2MB 量级，塞进去会让每次部署都变慢；KV 单值上限 25MB，正好。
//
// 版本号从 .ino 里的 FW_VERSION 读，避免「代码是 2.2.0、manifest 写着 2.1.0」
// 这种能让设备一直重刷同一版的事故。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CRED_FILE = 'F:/skills/个人密钥.txt';
const NS_TITLE = 'exit-fw';

function creds() {
  const t = fs.readFileSync(CRED_FILE, 'utf8');
  const seg = t.slice(t.indexOf('cloudflare小号'));
  const token = (seg.match(/cfat_[A-Za-z0-9]+/) || [])[0];
  const acct = (seg.match(/\b[0-9a-f]{32}\b/) || [])[0];
  if (!token || !acct) throw new Error('凭据解析失败');
  return { token, acct };
}

const { token, acct } = creds();

async function api(p, init = {}) {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}${p}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const j = await r.json();
  if (!j.success) throw new Error(JSON.stringify(j.errors).slice(0, 300));
  return j.result;
}

async function ensureNamespace() {
  const list = await api('/storage/kv/namespaces');
  const hit = list.find((k) => k.title === NS_TITLE);
  if (hit) return hit.id;
  const created = await api('/storage/kv/namespaces', {
    method: 'POST',
    body: JSON.stringify({ title: NS_TITLE }),
  });
  return created.id;
}

const args = process.argv.slice(2);
function argOf(flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
}

const bins = { c6: argOf('--c6'), d0wd: argOf('--d0wd'), s3: argOf('--s3') };
const provided = Object.entries(bins).filter(([, v]) => v);
if (!provided.length) {
  console.error('用法: node tunnel/fw-publish.mjs --c6 <bin> [--d0wd <bin>]');
  process.exit(1);
}

const ino = fs.readFileSync('F:/esp32/arduino/ESP32_C6_Exit/ESP32_C6_Exit.ino', 'utf8');
const ver = (ino.match(/#define\s+FW_VERSION\s+"([^"]+)"/) || [])[1];
if (!ver) {
  console.error('从 .ino 里读不到 FW_VERSION');
  process.exit(1);
}

const nsId = await ensureNamespace();
console.log('KV 命名空间', NS_TITLE, '=', nsId);

// 合并已有 manifest，只更新本次提供的机型
let manifest = {};
try {
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${nsId}/values/manifest.json`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (r.ok) manifest = await r.json();
} catch {
  /* 没有就用空的 */
}

for (const [chip, file] of provided) {
  if (!fs.existsSync(file)) {
    console.error('文件不存在:', file);
    process.exit(1);
  }
  const buf = fs.readFileSync(file);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const key = `${chip}.bin`;
  const up = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${nsId}/values/${key}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
      body: buf,
    }
  );
  if (!up.ok) throw new Error(`上传 ${key} 失败: ${up.status} ${await up.text()}`);
  manifest[chip] = { ver, size: buf.length, sha256: sha, url: `/fw/${key}`, at: new Date().toISOString() };
  console.log(`${key}  ${ver}  ${(buf.length / 1024).toFixed(1)} KB  sha256=${sha.slice(0, 16)}…`);
}

const mUp = await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${acct}/storage/kv/namespaces/${nsId}/values/manifest.json`,
  {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(manifest),
  }
);
if (!mUp.ok) throw new Error(`上传 manifest 失败: ${mUp.status}`);
console.log('manifest.json 已更新:', Object.keys(manifest).join(', '));
console.log('\n把下面这行加进 worker/wrangler.exit.toml（如果还没有）：');
console.log(`[[kv_namespaces]]\nbinding = "FW_KV"\nid = "${nsId}"`);
