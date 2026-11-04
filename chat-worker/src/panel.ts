export function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>chat2api 控制台</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
       background:linear-gradient(135deg,#a5b4fc 0%,#818cf8 35%,#c084fc 100%);color:#1f2937}
  .wrap{max-width:1100px;margin:0 auto;padding:28px 18px 60px}
  .card{background:#fff;border-radius:14px;box-shadow:0 18px 50px rgba(30,27,75,.18);padding:22px}
  .hero{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;margin-bottom:18px}
  h1{font-size:26px;margin:0;color:#312e81}
  .sub{color:#6b7280;font-size:13px;margin-top:4px}
  .pill{display:inline-block;padding:3px 10px;border-radius:999px;background:#eef2ff;color:#4338ca;font-size:12px;font-weight:600}
  .btn{border:0;border-radius:9px;padding:9px 14px;background:#6366f1;color:#fff;font-weight:600;cursor:pointer}
  .btn:hover{background:#4f46e5}.btn.gray{background:#e5e7eb;color:#374151}.btn.gray:hover{background:#d1d5db}
  .btn.danger{background:#ef4444}.btn.danger:hover{background:#dc2626}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin-bottom:18px}
  .metric{background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:14px}
  .metric .n{font-size:22px;font-weight:700;color:#312e81}.metric .l{font-size:12px;color:#6b7280}
  .tabs{display:flex;gap:8px;margin:18px 0 12px;flex-wrap:wrap}
  .tab{padding:8px 14px;border-radius:999px;background:#eef2ff;color:#4338ca;cursor:pointer;font-weight:600;font-size:13px;border:0}
  .tab.active{background:#4f46e5;color:#fff}
  .panel{display:none}.panel.active{display:block}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:10px;border-bottom:1px solid #eef0f4;vertical-align:middle}
  th{color:#6b7280;font-weight:600;font-size:12px}
  input,select,textarea{width:100%;border:1px solid #d1d5db;border-radius:9px;padding:9px 11px;font:inherit;background:#f9fafb}
  input:focus,select:focus,textarea:focus{outline:none;border-color:#6366f1;background:#fff;box-shadow:0 0 0 3px #e0e7ff}
  textarea{min-height:74px;resize:vertical}
  .row{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:10px 0}
  .msg{margin-top:10px;padding:10px 12px;border-radius:9px;background:#f3f4f6;color:#374151;font-size:13px;white-space:pre-wrap;word-break:break-all}
  .msg.ok{background:#ecfdf5;color:#065f46}.msg.err{background:#fef2f2;color:#991b1b}
  .login{position:fixed;inset:0;background:rgba(15,23,42,.55);display:flex;align-items:center;justify-content:center;padding:18px;z-index:20}
  .login .card{width:420px;max-width:100%}
  .login h2{margin:0 0 6px;color:#312e81}
  .login p{color:#6b7280;font-size:13px;margin:0 0 14px}
  .hidden{display:none!important}
  .muted{color:#6b7280;font-size:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#ecfdf5;color:#047857;font-size:12px}
  .badge.off{background:#fef2f2;color:#b91c1c}
  code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12px;background:#f3f4f6;padding:2px 5px;border-radius:5px}
</style>
</head>
<body>
<div id="login" class="login">
  <div class="card">
    <h2>chat2api 控制台</h2>
    <p>输入 ADMIN_TOKEN。口令只存本机 localStorage，不写进 URL。</p>
    <input id="adminToken" type="password" placeholder="ADMIN_TOKEN" autocomplete="off">
    <div style="height:12px"></div>
    <button class="btn" style="width:100%" onclick="doLogin()">进入</button>
    <div id="loginMsg" class="msg hidden"></div>
  </div>
</div>

<div class="wrap">
  <div class="hero">
    <div>
      <h1>chat2api 控制台</h1>
      <div class="sub">Kilo 免费池 · 千问 · DeepSeek · 豆包 · OpenAI 兼容</div>
    </div>
    <div>
      <span id="storagePill" class="pill">storage</span>
      <button class="btn gray" onclick="logout()">退出</button>
    </div>
  </div>

  <div class="card">
    <div class="grid">
      <div class="metric"><div class="n" id="mKeys">-</div><div class="l">API Keys</div></div>
      <div class="metric"><div class="n" id="mAccounts">-</div><div class="l">网页账号</div></div>
      <div class="metric"><div class="n" id="mChannels">-</div><div class="l">已启用通道</div></div>
      <div class="metric"><div class="n" id="mDay">-</div><div class="l">北京时间日界</div></div>
    </div>
    <div class="muted" id="statusLine">加载中…</div>
  </div>

  <div class="tabs">
    <button class="tab active" data-panel="keys" onclick="showTab('keys')">API Keys</button>
    <button class="tab" data-panel="accounts" onclick="showTab('accounts')">网页账号</button>
    <button class="tab" data-panel="login" onclick="showTab('login')">客户端登录</button>
  </div>

  <div id="panel-keys" class="panel active">
    <div class="card">
      <h3 style="margin:0 0 8px">新建下游 Key</h3>
      <div class="row">
        <input id="kName" placeholder="name，例如 app">
        <input id="kCalls" placeholder="每日次数，可空">
        <input id="kBytes" placeholder="每日字节，可空">
        <button class="btn" onclick="createKey()">创建</button>
      </div>
      <div id="keyMsg" class="msg hidden"></div>
      <div style="overflow:auto"><table><thead><tr><th>名称</th><th>前缀</th><th>日次数</th><th>日字节</th><th>操作</th></tr></thead><tbody id="keysBody"></tbody></table></div>
    </div>
  </div>

  <div id="panel-accounts" class="panel">
    <div class="card">
      <h3 style="margin:0 0 8px">导入网页账号</h3>
      <p class="muted">千问/GLM/DeepSeek 填 <code>{"token":"..."}</code>；豆包填 <code>{"sessionid":"..."}</code>。加密存 D1。</p>
      <div class="row">
        <select id="aProvider"><option value="qwen">qwen</option><option value="deepseek">deepseek</option><option value="doubao">doubao</option><option value="glm">glm</option></select>
        <input id="aLabel" placeholder="label，例如 qwen-main">
      </div>
      <textarea id="aCreds" placeholder='{"token":"..."} 或 {"sessionid":"..."}'></textarea>
      <div style="height:10px"></div>
      <button class="btn" onclick="addAccount()">保存账号</button>
      <div id="accountMsg" class="msg hidden"></div>
      <div style="overflow:auto"><table><thead><tr><th>Provider</th><th>Label</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead><tbody id="accountsBody"></tbody></table></div>
    </div>
  </div>

  <div id="panel-login" class="panel">
    <div class="card">
      <h3 style="margin:0 0 8px">DeepSeek 短信验证码登录</h3>
      <p class="muted">走客户端自己的 <code>create_sms_verification_code</code> → <code>login_by_mobile_sms</code>。验证码发送若要求 captcha，请把浏览器拿到的字段填入高级选项。</p>
      <div class="row">
        <input id="dsMobile" placeholder="手机号，例如 13800000000">
        <input id="dsArea" placeholder="区号，默认 +86">
        <button class="btn" onclick="sendDeepSeekSms()">发送验证码</button>
      </div>
      <div class="row">
        <input id="dsCode" placeholder="短信验证码">
        <input id="dsDevice" placeholder="deviceId（发送后自动填入）">
        <button class="btn" onclick="verifyDeepSeekSms()">校验并保存</button>
      </div>
      <textarea id="dsCaptcha" placeholder='可选 captcha JSON：{"shumei_verification":{...}} 或 {"turnstile_token":"..."}'></textarea>
      <div id="loginMsg2" class="msg hidden"></div>
    </div>
    <div class="card" style="margin-top:14px">
      <h3 style="margin:0 0 8px">千问 / 豆包</h3>
      <p class="muted">聊天通道已接入；扫码/短信登录接口还在逐家逆向。现在可先在“网页账号”页导入 token / sessionid，登录后立即生效。</p>
    </div>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
let token = localStorage.getItem('chat2api_admin') || '';

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function show(id, text, ok) {
  const el = $(id); el.classList.remove('hidden');
  el.className = 'msg ' + (ok ? 'ok' : 'err'); el.textContent = text;
}
function hide(id) { $(id).classList.add('hidden'); }

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, { authorization: 'Bearer ' + token });
  if (options.body && typeof options.body !== 'string') {
    headers['content-type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  const res = await fetch(path, Object.assign({}, options, { headers }));
  const text = await res.text();
  let body = text;
  try { body = JSON.parse(text); } catch (e) {}
  if (!res.ok) throw new Error((body && body.error && body.error.message) || body || ('HTTP ' + res.status));
  return body;
}

async function doLogin() {
  token = $('adminToken').value.trim();
  if (!token) return;
  try {
    await api('/admin/api/status');
    localStorage.setItem('chat2api_admin', token);
    $('login').classList.add('hidden');
    hide('loginMsg');
    refresh();
  } catch (e) {
    show('loginMsg', e.message, false);
  }
}
function logout() {
  localStorage.removeItem('chat2api_admin');
  token = '';
  location.reload();
}
function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.panel === name));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
}

async function refresh() {
  try {
    const status = await api('/admin/api/status');
    $('storagePill').textContent = status.storage;
    $('mKeys').textContent = status.keys;
    $('mDay').textContent = status.day;
    const accounts = await api('/admin/api/accounts');
    const providerSet = new Set(accounts.data.map((a) => a.provider));
    $('mChannels').textContent = 1 + providerSet.size + (status.opencode !== 'off' ? 1 : 0);
    $('statusLine').textContent = 'kilo=' + status.kiloBase + ' · 网页出口=' + (status.egress || 'direct') + ' · 网页账号通道=' + ([...providerSet].join(',') || '无') + ' · opencode=' + status.opencode;
    $('mAccounts').textContent = accounts.data.length;
    renderKeys(await api('/admin/api/keys'));
    renderAccounts(accounts.data);
  } catch (e) {
    if (String(e.message).includes('401') || String(e.message).includes('authorized') || String(e.message).includes('admin token rejected')) {
      $('login').classList.remove('hidden');
    }
  }
}

function renderKeys(data) {
  $('keysBody').innerHTML = data.data.map((k) =>
    '<tr><td>' + esc(k.name) + '</td><td><code>' + esc(k.prefix) + '</code></td><td>' +
    esc(k.dayCalls ?? '不限') + '</td><td>' + esc(k.dayBytes ?? '不限') +
    '</td><td><button class="btn danger" onclick="revokeKey(\\'' + esc(k.name) + '\\')">吊销</button></td></tr>'
  ).join('') || '<tr><td colspan="5" class="muted">还没有 key</td></tr>';
}

function renderAccounts(data) {
  $('accountsBody').innerHTML = data.map((a) =>
    '<tr><td><span class="pill">' + esc(a.provider) + '</span></td><td>' + esc(a.label) +
    '</td><td><span class="badge">' + esc(a.status) + '</span></td><td class="muted">' +
    new Date(a.createdAt).toLocaleString() +
    '</td><td><button class="btn danger" onclick="removeAccount(\\'' + esc(a.id) + '\\')">删除</button></td></tr>'
  ).join('') || '<tr><td colspan="5" class="muted">还没有网页账号</td></tr>';
}

async function createKey() {
  try {
    const body = { name: $('kName').value.trim() };
    if ($('kCalls').value) body.dayCalls = Number($('kCalls').value);
    if ($('kBytes').value) body.dayBytes = Number($('kBytes').value);
    const result = await api('/admin/api/keys', { method: 'POST', body });
    show('keyMsg', '已创建：' + result.key + '（只显示一次）', true);
    refresh();
  } catch (e) { show('keyMsg', e.message, false); }
}
async function revokeKey(name) {
  if (!confirm('吊销 ' + name + ' ?')) return;
  try { await api('/admin/api/keys/' + encodeURIComponent(name), { method: 'DELETE' }); refresh(); }
  catch (e) { show('keyMsg', e.message, false); }
}
async function addAccount() {
  try {
    const provider = $('aProvider').value;
    const label = $('aLabel').value.trim();
    const credentials = JSON.parse($('aCreds').value || '{}');
    if (!label) throw new Error('label 必填');
    const result = await api('/admin/api/accounts', { method: 'POST', body: { provider, label, credentials } });
    show('accountMsg', '已保存：' + result.account.provider + ' / ' + result.account.label, true);
    refresh();
  } catch (e) { show('accountMsg', e.message, false); }
}
async function removeAccount(id) {
  if (!confirm('删除这个账号？')) return;
  try { await api('/admin/api/accounts/' + encodeURIComponent(id), { method: 'DELETE' }); refresh(); }
  catch (e) { show('accountMsg', e.message, false); }
}

async function sendDeepSeekSms() {
  try {
    const body = { mobile: $('dsMobile').value.trim() };
    if ($('dsArea').value.trim()) body.areaCode = $('dsArea').value.trim();
    if ($('dsCaptcha').value.trim()) body.captcha = JSON.parse($('dsCaptcha').value);
    const result = await api('/v1/auth/deepseek/sms/send', { method: 'POST', body });
    $('dsDevice').value = result.deviceId;
    show('loginMsg2', '验证码已发送，deviceId=' + result.deviceId + '，窗口 ' + result.sendWindowSecs + 's', true);
  } catch (e) { show('loginMsg2', e.message, false); }
}
async function verifyDeepSeekSms() {
  try {
    const body = {
      mobile: $('dsMobile').value.trim(),
      code: $('dsCode').value.trim(),
      deviceId: $('dsDevice').value.trim(),
    };
    if ($('dsArea').value.trim()) body.areaCode = $('dsArea').value.trim();
    const result = await api('/v1/auth/deepseek/sms/verify', { method: 'POST', body });
    show('loginMsg2', '登录成功，账号已加密保存：' + result.account.label, true);
    refresh();
  } catch (e) { show('loginMsg2', e.message, false); }
}

if (!token) {
  $('login').classList.remove('hidden');
} else {
  $('login').classList.add('hidden');
  refresh();
}
</script>
</body>
</html>`;
}
