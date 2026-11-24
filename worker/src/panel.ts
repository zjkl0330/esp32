// panel.ts —— 控制面板（Worker 直出的单页，零外部依赖）。
//
// 为什么不用前端框架：这个页面要通过 Worker 直接吐给手机浏览器，多一个构建产物
// 就多一个"忘了重新构建导致线上是旧版"的坑。全部内联，改完 deploy 即生效。
//
// 信息架构的取舍（2026-10-25 重做）：
//   上一版是「运维仪表盘」——首屏四个 KPI 全是 heap / RSSI / 成功率。
//   但打开这个页面的人（就是我自己，通常一只手拿着手机）真正想知道的是三件事：
//     1. 现在能不能用       → 一句话结论，大字，颜色即状态
//     2. 帮我干件事         → 三个大按钮，不用先选 tool 再填 host/path
//     3. 最近干了什么       → 用人话说，不是 https_fetch 200 12345
//   技术指标不删，但收进「技术细节」折叠区——排障时才有用，日常占地方。
//
// 设计约束（与现有 console/ 保持同一套视觉语言）：
//   · 只用 400 / 500 两档字重，字号阶梯 11/12/13/15/22/28
//   · 间距走 4 的倍数；圆角 10 / 14
//   · 深浅色靠 prefers-color-scheme 切变量，不提供手动开关（少一个状态就少一处不一致）
//   · 所有图形自己画 SVG，不引外链（*.vercel.app 一类在这台机器上直接裂图）

export function adminPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f6f7f9">
<title>住宅出口</title>
<style>
:root{
  --bg:#f6f7f9; --panel:#ffffff; --line:#e5e7eb; --line2:#eef0f3;
  --tx:#15181d; --tx2:#5a616d; --tx3:#8b929e;
  --ok:#0f7a55; --okbg:#e8f6ef; --warn:#a46a00; --warnbg:#fdf3e2;
  --err:#b93a34; --errbg:#fbebea; --accent:#2b6ce0; --accentbg:#eaf1fd;
  --mono:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,monospace;
}
@media (prefers-color-scheme:dark){
  :root{
    --bg:#0e1014; --panel:#16191f; --line:#252a33; --line2:#1e222a;
    --tx:#e7eaee; --tx2:#9aa2b0; --tx3:#6a727f;
    --ok:#3ddc97; --okbg:#12281f; --warn:#e8b04b; --warnbg:#2a2213;
    --err:#ff7b72; --errbg:#2c1719; --accent:#6f9dff; --accentbg:#16233c;
  }
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--bg);color:var(--tx);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
  font-size:13px;line-height:1.6;-webkit-font-smoothing:antialiased;
  overflow-x:hidden}
.wrap{max-width:860px;width:100%;margin:0 auto;padding:18px 16px 48px}

header{display:flex;align-items:center;justify-content:space-between;gap:12px;
  flex-wrap:wrap;margin-bottom:14px}
.brand{display:flex;align-items:center;gap:8px;color:var(--tx2);font-size:12px}
.pulse{width:7px;height:7px;border-radius:50%;background:var(--tx3);flex:none;
  transition:background .3s}
.pulse.on{background:var(--ok);box-shadow:0 0 0 3px var(--okbg)}
.hdr-right{display:flex;align-items:center;gap:8px;color:var(--tx3);font-size:11px}
.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
button{font:inherit;color:var(--tx);background:var(--panel);border:1px solid var(--line);
  border-radius:8px;padding:6px 12px;cursor:pointer;transition:border-color .15s,background .15s}
button:hover{border-color:var(--tx3)}
button:active{transform:translateY(.5px)}
button:disabled{opacity:.5;cursor:default}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:500}
button.primary:hover{filter:brightness(1.06)}
label.sw{display:flex;align-items:center;gap:5px;cursor:pointer;user-select:none}

/* ── 一句话结论：整页最重要的一块 */
.verdict{border-radius:14px;padding:16px 18px;margin-bottom:14px;
  border:1px solid var(--line);background:var(--panel);min-width:0}
.verdict .big{font-size:clamp(19px,4.6vw,25px);font-weight:500;line-height:1.35;
  letter-spacing:-.2px;display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.verdict .sub{font-size:12px;color:var(--tx2);margin-top:3px;line-height:1.6}
.verdict.good{border-color:transparent;background:var(--okbg)}
.verdict.good .big{color:var(--ok)}
.verdict.warn{border-color:transparent;background:var(--warnbg)}
.verdict.warn .big{color:var(--warn)}
.verdict.bad{border-color:transparent;background:var(--errbg)}
.verdict.bad .big{color:var(--err)}

/* ── 三个大动作 */
.acts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin-bottom:14px}
@media(max-width:560px){.acts{gap:8px}}
.act{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;
  padding:15px 8px;border-radius:12px;border:1px solid var(--line);background:var(--panel);
  cursor:pointer;font-size:13px;font-weight:500;transition:border-color .15s,transform .1s;
  min-width:0;text-align:center}
.act:hover{border-color:var(--accent)}
.act:active{transform:scale(.985)}
.act svg{width:22px;height:22px;stroke:var(--accent);fill:none;stroke-width:1.6;
  stroke-linecap:round;stroke-linejoin:round;flex:none}
.act small{font-weight:400;font-size:10px;color:var(--tx3);line-height:1.3}

/* ── 卡片 */
.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:14px 15px;margin-bottom:12px;min-width:0}
.card-hd{display:flex;align-items:baseline;justify-content:space-between;gap:10px;
  margin-bottom:10px;flex-wrap:wrap}
.card-hd h2{font-size:13px;font-weight:500;margin:0}
.hint{font-size:11px;color:var(--tx3);min-width:0}

.ok{color:var(--ok)}.bad{color:var(--err)}.pend{color:var(--tx3)}

/* ── 今日一行 */
.today{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:12px;color:var(--tx2);
  align-items:baseline}
.today b{font-weight:500;color:var(--tx);font-family:var(--mono);
  font-variant-numeric:tabular-nums;font-size:15px}

/* ── 任务流 */
.tasks{display:flex;flex-direction:column;gap:1px;max-height:340px;overflow-y:auto}
.task{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:center;
  padding:8px 2px;border-bottom:1px solid var(--line2);font-size:12px;min-width:0}
.task:last-child{border-bottom:0}
.task .m{overflow:hidden;min-width:0}
.task .m .w{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.task .m .w em{font-style:normal;color:var(--tx2)}
.task .m .s{display:block;font-size:10px;color:var(--tx3);margin-top:1px}
.task .r{font-family:var(--mono);font-size:11px;text-align:right;
  font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--tx2)}
.task .r .bad{color:var(--err)}
.task .r .ok{color:var(--ok)}
.dotx{display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:5px;
  vertical-align:middle}

/* ── 额度 */
.keys{display:flex;flex-direction:column;gap:9px}
.key{font-size:12px;min-width:0}
.key .row{display:flex;justify-content:space-between;gap:10px;align-items:baseline;
  margin-bottom:4px}
.key .nm{font-family:var(--mono);font-size:11px;color:var(--tx2);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.key .num{font-family:var(--mono);font-size:11px;color:var(--tx3);
  font-variant-numeric:tabular-nums;white-space:nowrap}
.bar{height:5px;border-radius:3px;background:var(--line2);overflow:hidden}
.bar i{display:block;height:100%;border-radius:3px;background:var(--accent);transition:width .4s}
.bar i.hi{background:var(--warn)}
.bar i.full{background:var(--err)}

/* ── 接出密钥：显示、复制、吊销、新增 */
button.mini{font-size:11px;padding:3px 10px;border-radius:7px;line-height:1.6}
button.mini.ghost{color:var(--tx2)}
button.mini.danger{color:var(--err);border-color:var(--errbg)}
button.mini.danger:hover{border-color:var(--err)}
.key .sec{font-family:var(--mono);font-size:11px;word-break:break-all;color:var(--tx3);
  margin-top:6px;padding:5px 8px;background:var(--bg);border:1px solid var(--line2);border-radius:7px}
.key .sec.revealed{color:var(--tx)}
.key .hosts{font-size:10px;color:var(--tx3);margin-top:4px}
.key .ops{display:flex;gap:6px;margin-top:6px}
.keyadd{border:1px dashed var(--line);border-radius:10px;padding:11px;margin-top:11px}
.keyadd .ka-hd{font-size:11px;color:var(--tx3);margin-bottom:8px}
.keyadd .ka-row{display:flex;gap:6px;margin-bottom:6px;flex-wrap:wrap}
.keyadd input{flex:1 1 120px;min-width:0;font:inherit;font-size:12px;padding:7px 9px;
  border-radius:7px;border:1px solid var(--line);background:var(--bg);color:var(--tx)}
.keyadd input:focus{outline:2px solid var(--accentbg);outline-offset:0;border-color:var(--accent)}
.keyadd .ka-foot{display:flex;gap:6px;margin-top:3px}
.keybar{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}
.note{font-size:10px;color:var(--tx3);line-height:1.7;margin-top:9px}

/* ── 输入行 */
.inline{display:none;gap:7px;margin-top:11px;flex-wrap:wrap}
.inline.show{display:flex}
.inline input{flex:1 1 200px;min-width:0;font:inherit;font-size:12px;padding:8px 10px;
  border-radius:8px;border:1px solid var(--line);background:var(--bg);color:var(--tx)}
.inline input:focus{outline:2px solid var(--accentbg);outline-offset:1px;border-color:var(--accent)}
.inline button{flex:none}

/* ── 结果 */
.out{margin:11px 0 0;padding:11px;border-radius:10px;background:var(--bg);
  border:1px solid var(--line2);font-family:var(--mono);font-size:11px;line-height:1.6;
  max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-all;color:var(--tx2);
  display:none}
.out.show{display:block}
.out b{color:var(--tx);font-weight:500}

/* ── 人话结果卡片 */
.facts{display:flex;flex-wrap:wrap;gap:8px 22px;margin-top:10px;font-size:12px}
.facts div{display:flex;flex-direction:column;gap:1px;min-width:0}
.facts span{color:var(--tx3);font-size:10px}
.facts b{font-weight:500;font-family:var(--mono);font-size:13px;
  font-variant-numeric:tabular-nums}

/* ── 技术细节折叠 */
details.tech{background:var(--panel);border:1px solid var(--line);border-radius:14px;
  padding:12px 15px;margin-bottom:12px}
details.tech summary{font-size:12px;color:var(--tx2);cursor:pointer;list-style:none;
  display:flex;align-items:center;gap:6px;user-select:none}
details.tech summary::-webkit-details-marker{display:none}
/* 用 CSS 三角形而不是字符 ▸：中文字体里那个字符在部分设备上会掉成方块，
   三角形不受字体影响，任何环境都长一样 */
details.tech summary::before{content:"";width:0;height:0;
  border-left:5px solid var(--tx3);border-top:4px solid transparent;
  border-bottom:4px solid transparent;display:inline-block;
  transition:transform .15s;margin-right:3px;flex:none}
details.tech[open] summary::before{transform:rotate(90deg)}
details.tech .body{margin-top:12px;padding-top:12px;border-top:1px solid var(--line2)}
.node{border:1px solid var(--line2);border-radius:10px;padding:11px 12px;margin-bottom:8px}
.node:last-child{margin-bottom:0}
.node-top{display:flex;align-items:center;gap:8px;min-width:0}
.dot{width:7px;height:7px;border-radius:50%;flex:none}
.dot.on{background:var(--ok)}
.dot.off{background:var(--tx3)}
.node-name{font-weight:500;font-size:12px;font-family:var(--mono)}
.node-sub{margin-left:auto;flex:none}
.meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:7px;font-size:11px;color:var(--tx2)}
.meta b{font-weight:500;color:var(--tx);font-family:var(--mono);
  font-variant-numeric:tabular-nums}
.spark{width:100%;height:24px;display:block;margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:8px}
.chip{font-size:10px;font-family:var(--mono);padding:1px 7px;border-radius:20px;
  border:1px solid var(--line);color:var(--tx2);background:var(--line2)}
.chip.hi{border-color:transparent;background:var(--accentbg);color:var(--accent)}
.sec{display:flex;flex-direction:column;gap:5px;margin-top:12px;font-size:11px}
.sec .li{display:flex;align-items:center;gap:7px;color:var(--tx2)}
.sec .li i{font-style:normal;font-size:10px;padding:0 6px;border-radius:5px;flex:none}
.sec .li i.y{background:var(--okbg);color:var(--ok)}
.sec .li i.n{background:var(--errbg);color:var(--err)}

.empty{padding:20px 6px;text-align:center;color:var(--tx3);font-size:12px;line-height:1.8}
.empty b{display:block;color:var(--tx2);font-weight:500;margin-bottom:2px}
.tag{font-size:10px;padding:1px 6px;border-radius:5px;font-weight:500;letter-spacing:.2px}
.tag.ok{background:var(--okbg);color:var(--ok)}
.tag.warn{background:var(--warnbg);color:var(--warn)}
.tag.err{background:var(--errbg);color:var(--err)}

.toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%) translateY(14px);
  background:var(--tx);color:var(--bg);font-size:12px;padding:9px 16px;border-radius:20px;
  opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:9;
  max-width:88vw;text-align:center}
.toast.show{opacity:.94;transform:translateX(-50%) translateY(0)}

footer{margin-top:16px;color:var(--tx3);font-size:11px;display:flex;
  justify-content:space-between;flex-wrap:wrap;gap:8px}
</style>
</head>
<body>
<div class="wrap">

<header>
  <div class="brand">
    <span class="pulse" id="pulse"></span>
    <span>住宅出口</span>
  </div>
  <div class="hdr-right">
    <span class="mono" id="stamp">—</span>
    <button id="refresh">刷新</button>
    <label class="sw"><input type="checkbox" id="auto" checked> 自动</label>
  </div>
</header>

<section class="verdict" id="verdict">
  <div class="big" id="vBig">正在连…</div>
  <div class="sub" id="vSub">从控制面读取状态</div>
</section>

<section class="acts">
  <div class="act" id="actFetch">
    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18"/></svg>
    抓个网页
    <small>用家里的网去取</small>
  </div>
  <div class="act" id="actWol">
    <svg viewBox="0 0 24 24"><path d="M12 3v9"/><path d="M6.5 6.5a8 8 0 1 0 11 0"/></svg>
    唤醒电脑
    <small>发魔术包</small>
  </div>
  <div class="act" id="actNet">
    <svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0"/><path d="M5 12a10 10 0 0 1 14 0"/><path d="M8.5 15.5a5 5 0 0 1 7 0"/><circle cx="12" cy="19" r="1"/></svg>
    看看网络
    <small>信号 / 内存</small>
  </div>
</section>

<div class="inline" id="fetchForm">
  <input id="fUrl" placeholder="要抓的网址，如 https://v.douyin.com/xxx" autocomplete="off">
  <button class="primary" id="fGo">抓</button>
</div>

<pre class="out" id="out"></pre>
<div class="facts" id="facts"></div>

<section class="card">
  <div class="card-hd"><h2>今天</h2><span class="hint" id="todayHint">—</span></div>
  <div class="today" id="today"></div>
</section>

<section class="card">
  <div class="card-hd"><h2>最近干了什么</h2><span class="hint">最新的在上面</span></div>
  <div id="tasks" class="tasks"></div>
</section>

<section class="card" id="fwCard">
  <div class="card-hd">
    <h2>固件</h2>
    <span class="hint">升级走这条链路，不用插数据线</span>
  </div>
  <div id="fws"></div>
  <div class="keybar">
    <button id="otaBtn" class="mini">检查更新</button>
    <span class="hint" id="otaHint">设备自己每 6 小时也会查一次</span>
  </div>
</section>

<section class="card" id="keysCard" style="display:none">
  <div class="card-hd">
    <h2>接出密钥</h2>
    <span class="hint">给别的项目用的钥匙，出了事只撤一把</span>
  </div>
  <div class="keybar">
    <button id="keyReveal" class="mini">显示密钥</button>
    <button id="keyAddBtn" class="mini ghost">+ 新增一把</button>
  </div>
  <div class="keys" id="keys"></div>
  <div class="keyadd" id="keyAdd" style="display:none">
    <div class="ka-hd">新增一把</div>
    <div class="ka-row">
      <input id="kaName" placeholder="名称，比如 news" maxlength="32">
      <input id="kaCalls" placeholder="每日次数" type="number" min="0" style="max-width:104px">
      <input id="kaBytes" placeholder="每日 KB" type="number" min="0" style="max-width:104px">
    </div>
    <input id="kaHosts" placeholder="域名白名单，留空 = 不限（支持 *.example.com）" style="width:100%">
    <div class="ka-foot">
      <button id="kaCreate" class="mini primary">创建</button>
      <button id="kaCancel" class="mini ghost">取消</button>
    </div>
  </div>
  <div class="note" id="keyNote"></div>
</section>

<section class="card" id="secCard">
  <div class="card-hd">
    <h2>面板设置</h2>
    <span class="hint">改完密码要用新密码重新登录</span>
  </div>
  <div class="keybar">
    <button id="pwBtn" class="mini">修改面板密码</button>
  </div>
</section>

<details class="tech" id="tech">
  <summary>技术细节（排障时才需要）</summary>
  <div class="body">
    <div id="nodes"></div>
    <div class="sec" id="sec"></div>
  </div>
</details>

<footer>
  <span id="footL">—</span>
  <span class="mono" id="footR">—</span>
</footer>

</div>

<div class="toast" id="toast"></div>

<script>
var T = { snap: null, timer: null, busy: false, seq: 0, reveal: false, keyList: [] };

function el(id){ return document.getElementById(id); }
function esc(s){
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function fmtDur(s){
  if (s === null || s === undefined) return '—';
  if (s < 60) return Math.max(1, Math.round(s)) + ' 秒';
  if (s < 3600) return Math.floor(s/60) + ' 分钟';
  var h = Math.floor(s/3600), m = Math.floor((s%3600)/60);
  if (h < 24) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  return Math.floor(h/24) + ' 天' + (h%24 ? ' ' + (h%24) + ' 小时' : '');
}
function fmtBytes(n){
  if (n === null || n === undefined) return '—';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n/1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  return (n/1048576).toFixed(1) + ' MB';
}
function fmtAgo(ts){
  if (!ts) return '—';
  var s = (Date.now() - ts) / 1000;
  if (s < 10) return '刚刚';
  if (s < 60) return Math.round(s) + ' 秒前';
  if (s < 3600) return Math.floor(s/60) + ' 分钟前';
  if (s < 86400) return Math.floor(s/3600) + ' 小时前';
  return Math.floor(s/86400) + ' 天前';
}
function fmtClock(ts){
  var d = new Date(ts);
  var p = function(x){ return (x<10?'0':'') + x; };
  return p(d.getHours()) + ':' + p(d.getMinutes());
}

/* 工具名 → 人话。面板上不该出现 https_fetch 这种词，
   那是固件和 Worker 之间的契约，不是给人看的。 */
var VERB = {
  https_fetch: '抓网页',
  http_get: '抓网页',
  net_info: '查网络',
  dns_lookup: '查域名',
  tcp_probe: '探端口',
  wol: '唤醒电脑',
  ota_apply: '升级固件'
};
function verb(tool){ return VERB[tool] || tool; }

function toast(msg){
  var t = el('toast');
  t.textContent = msg;
  t.className = 'toast show';
  clearTimeout(t._h);
  t._h = setTimeout(function(){ t.className = 'toast'; }, 2600);
}

function spark(vals, color){
  if (!vals || vals.length < 2) return '';
  var w = 200, h = 24;
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  var span = (max - min) || 1;
  var step = w / (vals.length - 1);
  var pts = [];
  for (var i = 0; i < vals.length; i++){
    var x = i * step;
    var y = h - ((vals[i] - min) / span) * (h - 3) - 1.5;
    pts.push(x.toFixed(1) + ',' + y.toFixed(1));
  }
  return '<svg class="spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
    '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + color +
    '" stroke-width="1.5" vector-effect="non-scaling-stroke" stroke-linejoin="round"/></svg>';
}

/* ── 一句话结论 */
function renderVerdict(d){
  var st = d.stats, nodes = d.nodes;
  var online = nodes.filter(function(n){ return n.online; });
  var box = el('verdict'), big = el('vBig'), sub = el('vSub');

  if (!nodes.length){
    box.className = 'verdict warn';
    big.textContent = '还没有设备连进来';
    sub.textContent = '板子上电后会自动连上并自报家门，通常十几秒内出现。';
    el('pulse').className = 'pulse';
    return;
  }
  if (!online.length){
    var newest = nodes.slice().sort(function(a,b){ return a.silentFor - b.silentFor; })[0];
    box.className = 'verdict bad';
    big.textContent = '连不上了';
    sub.textContent = '最后一次收到消息是 ' + fmtDur(newest.silentFor) + '前。' +
      '可能是断电、断网，或者路由器把它踢了。';
    el('pulse').className = 'pulse';
    return;
  }

  var n = online[0];
  box.className = 'verdict good';
  big.textContent = '在线，随时能干活';
  var bits = [];
  bits.push(nodes.length > 1 ? (online.length + ' 台在线') : (n.model || '设备'));
  bits.push(fmtDur(n.silentFor) + '前还有消息');
  if (st.lastOkAt) bits.push('上次干活 ' + fmtAgo(st.lastOkAt) + '，用了 ' + (st.lastOkMs || 0) + ' 毫秒');
  sub.textContent = bits.join(' · ');
  el('pulse').className = 'pulse on';
}

/* ── 今天一行 */
function renderToday(d){
  var st = d.stats;
  el('todayHint').textContent = st.todayCalls ? '' : '还没有记录';
  if (!st.todayCalls){
    el('today').innerHTML = '<span style="color:var(--tx3)">今天还没干过活。点上面的按钮试试。</span>';
    return;
  }
  var html = '';
  html += '<span>干了 <b>' + st.todayCalls + '</b> 件</span>';
  if (st.successRate !== null){
    html += '<span>成功 <b>' + st.todayOk + '</b>' +
      (st.todayErr ? ' · 失败 <b class="' + (st.todayErr ? 'bad' : '') + '">' + st.todayErr + '</b>' : '') +
      '</span>';
    html += '<span>成功率 <b>' + st.successRate + '%</b></span>';
  }
  if (st.avgMs) html += '<span>平均 <b>' + st.avgMs + '</b> 毫秒</span>';
  el('today').innerHTML = html;
}

/* ── 任务流：说人话 */
function renderTasks(d){
  var list = d.tasks || [];
  if (!list.length){
    el('tasks').innerHTML = '<div class="empty"><b>还没有任何记录</b>' +
      '每抓一个网页、每唤醒一次电脑，都会出现在这里。</div>';
    return;
  }
  el('tasks').innerHTML = list.map(function(t){
    var ok = t.ok === true;
    var pend = t.ok === null;
    var color = pend ? 'var(--tx3)' : (ok ? 'var(--ok)' : 'var(--err)');
    var right = '';
    if (pend){
      right = '<span class="r">进行中…</span>';
    } else {
      var parts = [];
      if (t.bytes) parts.push(fmtBytes(t.bytes));
      if (t.ms) parts.push(t.ms + 'ms');
      right = '<span class="r ' + (ok ? 'ok' : 'bad') + '">' + (ok ? '✓' : '✕') +
        (parts.length ? ' ' + parts.join(' · ') : '') + '</span>';
    }
    var sub = [];
    sub.push(fmtAgo(t.startedAt));
    if (t.via) sub.push('via ' + t.via);
    if (t.nodeId) sub.push(t.nodeId);
    if (!ok && !pend && t.err) sub.push(t.err);
    return '<div class="task">' +
      '<div class="m">' +
        '<span class="w"><span class="dotx" style="background:' + color + '"></span>' +
        verb(t.tool) + (t.brief && t.brief !== t.tool
          ? ' <em>' + esc(t.brief) + '</em>' : '') + '</span>' +
        '<span class="s">' + esc(sub.join(' · ')) + '</span>' +
      '</div>' + right +
    '</div>';
  }).join('');
}

/* ── 接出密钥：用量 + 明文 + 复制 + 吊销 */
function maskKey(k){
  if (!k) return '';
  if (k.length <= 16) return k.slice(0, 4) + '…' + k.slice(-2);
  return k.slice(0, 12) + '…' + k.slice(-4);
}
function renderKeys(d, kl){
  var usage = d.keys || [];
  var list = kl || [];
  T.keyList = list;
  if (!usage.length && !list.length){ el('keysCard').style.display = 'none'; return; }
  el('keysCard').style.display = '';
  el('keyNote').textContent = '这些钥匙就是别的项目调用这个出口的凭证，面板里能看到明文 —— ' +
    '所以面板口令千万别外泄，也别把 ADMIN_TOKEN 写进任何第三方项目。';

  var um = {};
  usage.forEach(function(k){ um[k.name] = k; });

  // 名字取并集：有用量的 + 刚建还没用过的
  var names = [], seen = {};
  usage.forEach(function(k){ names.push(k.name); seen[k.name] = 1; });
  list.forEach(function(k){ if (!seen[k.name]){ names.push(k.name); seen[k.name] = 1; } });

  el('keys').innerHTML = names.map(function(name){
    var k = um[name];
    var meta = null, mi = -1;
    for (var i = 0; i < list.length; i++) if (list[i].name === name) { meta = list[i]; mi = i; }

    var num = [], cls = '', w = 0;
    if (k) {
      var callPct = k.dayCalls ? (k.calls / k.dayCalls) * 100 : null;
      var bytePct = k.dayBytes ? (k.bytes / k.dayBytes) * 100 : null;
      var raw = Math.max(callPct || 0, bytePct || 0);
      cls = raw >= 95 ? 'full' : (raw >= 70 ? 'hi' : '');
      /* 用量 > 0 时给 1.2% 的下限，让"用了一点点"看得见；
       完全没有用时必须是 0 —— 否则每个 key 都顶着一条小蓝条，
       看着像都用过，反而看不懂。 */
      w = raw > 0 ? Math.max(raw, 1.2) : 0;
      num.push(k.dayCalls ? (k.calls + ' / ' + k.dayCalls + ' 次') : (k.calls + ' 次'));
      if (k.dayBytes) num.push(fmtBytes(k.bytes) + ' / ' + fmtBytes(k.dayBytes));
      else if (k.bytes) num.push(fmtBytes(k.bytes));
    } else {
      num.push('还没用过');
    }

    var sec = meta
      ? '<div class="sec' + (T.reveal ? ' revealed' : '') + '">' +
        esc(T.reveal ? meta.key : maskKey(meta.key)) + '</div>'
      : '';
    var hosts = (meta && meta.hosts && meta.hosts.length)
      ? '<div class="hosts">只能访问：' + esc(meta.hosts.join('、')) + '</div>'
      : '';
    var ops = meta
      ? '<div class="ops">' +
        '<button class="mini ghost" data-edit="' + esc(name) + '">编辑</button>' +
        '<button class="mini ghost" data-copy="' + mi + '">复制</button>' +
        '<button class="mini danger" data-del="' + esc(name) + '">吊销</button>' +
        '</div>'
      : '';

    return '<div class="key">' +
      '<div class="row"><span class="nm">' + esc(name) + '</span>' +
      '<span class="num">' + esc(num.join(' · ')) + '</span></div>' +
      (k ? '<div class="bar"><i class="' + cls + '" style="width:' + w.toFixed(2) + '%"></i></div>' : '') +
      sec + hosts + ops +
    '</div>';
  }).join('');
}

/* ── 技术细节 */
function renderTech(d){
  var nodes = d.nodes || [];
  if (!nodes.length){
    el('nodes').innerHTML = '<div class="empty" style="padding:10px 0;text-align:left">' +
      '没有设备记录。</div>';
  } else {
    el('nodes').innerHTML = nodes.map(function(n){
      var state = n.online
        ? '<i class="tag ok">在线</i>'
        : '<i class="tag err">离线 ' + fmtDur(n.silentFor) + '</i>';
      var chips = (n.tools || []).map(function(t){
        return '<span class="chip hi">' + esc(t) + '</span>';
      }).join('') || '<span class="chip">未上报工具表</span>';
      return '<div class="node">' +
        '<div class="node-top">' +
          '<span class="dot ' + (n.online ? 'on' : 'off') + '"></span>' +
          '<span class="node-name">' + esc(n.nodeId) + '</span>' +
          '<span class="node-sub">' + state + '</span>' +
        '</div>' +
        '<div class="meta">' +
          '<span>' + esc(n.model || '未知型号') + '</span>' +
          '<span>固件 <b>' + esc(n.fw || '?') + '</b></span>' +
          '<span>内存 <b>' + (n.heap ? Math.round(n.heap/1024) + 'KB' : '—') + '</b></span>' +
          '<span>信号 <b>' + (n.rssi === null || n.rssi === undefined ? '—' : n.rssi + 'dBm') + '</b></span>' +
          '<span>已运行 <b>' + fmtDur(n.uptime) + '</b></span>' +
          '<span>干活 <b>' + n.totalCalls + '</b> 次</span>' +
          (n.ip ? '<span>内网 <b>' + esc(n.ip) + '</b></span>' : '') +
        '</div>' +
        spark(n.heapSeries, 'var(--accent)') +
        '<div class="chips">' + chips + '</div>' +
      '</div>';
    }).join('');
  }

  var s = d.security || {};
  var items = [
    ['面板口令 ADMIN_TOKEN', s.adminTokenSet],
    ['设备密钥 TUNNEL_TOKEN', s.tunnelTokenSet],
    ['对外密钥 CLIENT_KEYS', (s.clientKeys || 0) > 0]
  ];
  el('sec').innerHTML = items.map(function(it){
    return '<div class="li"><i class="' + (it[1] ? 'y' : 'n') + '">' +
      (it[1] ? '已启用' : '未配置') + '</i><span>' + esc(it[0]) + '</span></div>';
  }).join('') +
    '<div class="li" style="color:var(--tx3);margin-top:2px">' +
    '未配置的项按 fail-closed 拒绝请求，不会放开。</div>';

  el('footL').textContent = '心跳超时 ' + Math.round((d.heartbeatTtlMs || 50000)/1000) + ' 秒后判离线';
  el('footR').textContent = '每 5 秒自动刷新';
}

function render(d, kl){
  T.snap = d;
  renderVerdict(d);
  renderToday(d);
  renderTasks(d);
  renderFw(d);
  renderKeys(d, kl);
  renderTech(d);
  el('stamp').textContent = fmtClock(d.now);
}

/* 固件卡片。
   能不能远程升级，只看设备有没有上报 fw_info 这个工具 —— 那正是
   2.2.0 起才编进去的东西，比让人去记型号靠谱。 */
function renderFw(d){
  var nodes = d.nodes || [];
  if (!nodes.length){
    el('fws').innerHTML = '<div class="empty" style="padding:10px 0;text-align:left">没有设备记录。</div>';
    return;
  }
  el('fws').innerHTML = nodes.map(function(n){
    var canOta = (n.tools || []).indexOf('fw_info') >= 0;
    return '<div class="li">' +
      '<i class="' + (n.online ? 'y' : 'n') + '">' + (n.online ? '在线' : '离线') + '</i>' +
      '<span>' + esc(n.nodeId) + ' · ' + esc(n.model || '未知型号') +
      ' · 固件 <b>' + esc(n.fw || '?') + '</b> · ' +
      (canOta ? '可远程升级' : '只能插线刷') + '</span>' +
      '</div>';
  }).join('');
}

function otaNow(){
  var btn = el('otaBtn');
  btn.disabled = true;
  el('otaHint').textContent = '通知设备…';
  fetch('/admin/api/ota', {
    method: 'POST',
    headers: { 'accept': 'application/json', 'content-type': 'application/json' },
    body: '{}'
  })
    .then(function(r){ return r.json(); })
    .then(function(j){
      var okList = (j.results || []).filter(function(x){ return x.ok; });
      if (j.ok){
        el('otaHint').textContent = '已通知 ' + okList.length + ' 台去检查，稍后刷新看版本';
        toast('设备开始检查固件');
      } else {
        el('otaHint').textContent = j.error || '通知失败';
        toast('通知失败：' + (j.error || '没有在线设备'));
      }
    })
    .catch(function(){
      el('otaHint').textContent = '通知失败';
    })
    .then(function(){
      setTimeout(function(){ btn.disabled = false; }, 3000);
    });
}

function pull(){
  // 快照和密钥表一起拉：密钥表带明文，配额在快照里，两边要拼起来看
  Promise.all([
    fetch('/admin/api/snapshot', { headers: { 'accept': 'application/json' } })
      .then(function(r){
        if (r.status === 401){ location.reload(); throw new Error('unauth'); }
        return r.json();
      }),
    fetch('/admin/api/keys', { headers: { 'accept': 'application/json' } })
      .then(function(r){ return r.ok ? r.json() : { keys: [] }; })
      .catch(function(){ return { keys: [] }; })
  ])
    .then(function(res){ render(res[0], res[1].keys || []); })
    .catch(function(){ /* 网络抖动不打断自动刷新 */ });
}

/* ── 动作 */
function showOut(text){
  var o = el('out');
  o.textContent = text;
  o.className = 'out show';
}
function hideOut(){
  el('out').className = 'out';
  el('facts').innerHTML = '';
}

function callTool(tool, args){
  if (T.busy) { toast('上一个还在跑，稍等'); return Promise.resolve(null); }
  T.busy = true;
  return fetch('/admin/api/call', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool: tool, args: args, timeoutMs: 25000 })
  })
    .then(function(r){ return r.json(); })
    .then(function(d){ T.busy = false; setTimeout(pull, 600); return d; })
    .catch(function(e){ T.busy = false; return { ok: false, err: '请求失败：' + e.message }; });
}

function b64Text(b64){
  try {
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  } catch (e){ return ''; }
}

/* 抓个网页 */
el('actFetch').addEventListener('click', function(){
  var f = el('fetchForm');
  f.className = f.className.indexOf('show') >= 0 ? 'inline' : 'inline show';
  if (f.className.indexOf('show') >= 0) el('fUrl').focus();
});
el('fGo').addEventListener('click', function(){
  var u = el('fUrl').value.trim();
  if (!u){ toast('先填个网址'); return; }
  if (u.indexOf('http') !== 0) u = 'https://' + u;
  showOut('正在让家里的网去取…');
  el('facts').innerHTML = '';
  callTool('https_fetch', { url: u, maxBytes: 65536 }).then(function(d){
    if (!d) return;
    if (!d.ok){
      showOut('没取到。\\n' + (d.err || d.error || '未知原因'));
      return;
    }
    var txt = d.data ? b64Text(d.data) : '';
    var head = '取到了 ' + fmtBytes(d.meta && d.meta.bytes) + '，' +
      (d.meta && d.meta.ms ? d.meta.ms + ' 毫秒' : '') +
      (d.meta && d.meta.status ? '，HTTP ' + d.meta.status : '');
    showOut(head + '\\n\\n' + txt.slice(0, 1200) + (txt.length > 1200 ? '\\n…（后面省略）' : ''));
  });
});
el('fUrl').addEventListener('keydown', function(e){
  if (e.key === 'Enter') el('fGo').click();
});

/* 唤醒电脑 */
el('actWol').addEventListener('click', function(){
  showOut('正在发魔术包…');
  el('facts').innerHTML = '';
  callTool('wol', {}).then(function(d){
    if (!d) return;
    if (d.ok){
      showOut('魔术包已发出。\\n如果电脑本来就在睡眠，通常 5~15 秒内会醒；' +
        '关机状态下收不到（笔记本 S5 网卡通常断电）。');
      toast('已发魔术包');
    } else {
      showOut('没发出去。\\n' + (d.err || d.error || '未知原因'));
    }
  });
});

/* 看看网络 */
el('actNet').addEventListener('click', function(){
  showOut('正在问设备…');
  el('facts').innerHTML = '';
  callTool('net_info', {}).then(function(d){
    if (!d) return;
    if (!d.ok){
      showOut('没问到。\\n' + (d.err || d.error || '未知原因'));
      return;
    }
    var info = {};
    try { info = JSON.parse(b64Text(d.data)); } catch (e){}
    var rssi = info.rssi;
    var quality = rssi === undefined ? '—'
      : rssi > -55 ? '很好'
      : rssi > -67 ? '不错'
      : rssi > -75 ? '一般'
      : '偏弱';
    var heapKb = info.heap ? Math.round(info.heap/1024) : null;
    showOut('设备回答如下：');
    el('facts').innerHTML =
      '<div><span>信号</span><b>' + (rssi === undefined ? '—' : rssi + ' dBm') +
        ' <span style="color:var(--tx3)">' + quality + '</span></b></div>' +
      '<div><span>剩余内存</span><b>' + (heapKb === null ? '—' : heapKb + ' KB') + '</b></div>' +
      '<div><span>内网地址</span><b>' + esc(info.ip || '—') + '</b></div>' +
      '<div><span>已连续工作</span><b>' + fmtDur(info.up) + '</b></div>' +
      '<div><span>DNS</span><b>' + esc(info.dns || '—') + '</b></div>' +
      '<div><span>累计干活</span><b>' + (info.calls === undefined ? '—' : info.calls + ' 次') + '</b></div>';
  });
});

/* ── 接出密钥：显示 / 复制 / 吊销 / 新增 */
el('keyReveal').addEventListener('click', function(){
  T.reveal = !T.reveal;
  el('keyReveal').textContent = T.reveal ? '隐藏密钥' : '显示密钥';
  if (T.snap) render(T.snap, T.keyList || []);
});

el('keys').addEventListener('click', function(e){
  var t = e.target && e.target.closest ? e.target.closest('button') : null;
  if (!t) return;
  var ed = t.getAttribute('data-edit');
  if (ed !== null && ed !== false) {
    var meta = null;
    (T.keyList || []).forEach(function(x){ if (x.name === ed) meta = x; });
    var c = prompt('「' + ed + '」每日调用上限（次，0 = 不限）', meta && meta.dayCalls ? meta.dayCalls : 0);
    if (c === null) return;
    var b = prompt('每日流量上限（MB，0 = 不限）', meta && meta.dayBytes ? Math.round(meta.dayBytes / 1048576) : 0);
    if (b === null) return;
    var body = { name: ed };
    var cn = parseInt(c, 10);
    if (cn > 0) body.dayCalls = cn;
    var bn = parseInt(b, 10);
    if (bn > 0) body.dayBytes = bn * 1048576;
    fetch('/admin/api/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function(r){ return r.json(); })
      .then(function(d){ toast(d && d.ok ? '已更新「' + ed + '」' : '更新失败'); pull(); })
      .catch(function(){ toast('操作失败'); });
    return;
  }
  var cp = t.getAttribute('data-copy');
  if (cp !== null && cp !== false) {
    var k = (T.keyList || [])[parseInt(cp, 10)];
    if (!k) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(k.key).then(
        function(){ toast('已复制到剪贴板'); },
        function(){ toast('复制失败，请手动选中'); });
    } else {
      toast('浏览器不支持自动复制，请手动选中');
    }
    return;
  }
  var del = t.getAttribute('data-del');
  if (del) {
    if (!confirm('吊销「' + del + '」？用这把钥匙的项目会立刻开始 401。')) return;
    fetch('/admin/api/keys/' + encodeURIComponent(del), { method: 'DELETE' })
      .then(function(r){ return r.json(); })
      .then(function(d){
        toast(d.ok ? '已吊销「' + del + '」' : '没找到这把钥匙');
        pull();
      })
      .catch(function(){ toast('操作失败'); });
  }
});

function openAdd(){
  el('keyAdd').style.display = 'block';
  el('kaName').focus();
}
function closeAdd(){
  el('keyAdd').style.display = 'none';
  el('kaName').value = '';
  el('kaCalls').value = '';
  el('kaBytes').value = '';
  el('kaHosts').value = '';
}
el('keyAddBtn').addEventListener('click', openAdd);
el('kaCancel').addEventListener('click', closeAdd);

el('pwBtn').addEventListener('click', function(){
  var old = prompt('当前面板密码');
  if (old === null) return;
  var n1 = prompt('新密码（至少 8 位）');
  if (n1 === null) return;
  if (n1.length < 8) { toast('新密码至少 8 位'); return; }
  var n2 = prompt('再输一次新密码');
  if (n2 !== n1) { toast('两次输入不一致'); return; }
  fetch('/admin/api/password', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ old: old, new: n1 })
  })
    .then(function(r){ return r.json().then(function(d){ return { s: r.status, d: d }; }); })
    .then(function(o){
      if (o.d && o.d.ok) { alert('密码已修改，请用新密码重新登录'); location.href = '/admin'; }
      else if (o.d && o.d.error === 'bad_old') toast('当前密码不对');
      else if (o.d && o.d.error === 'weak') toast('新密码太短（至少 8 位）');
      else toast('修改失败：' + ((o.d && o.d.error) || o.s));
    })
    .catch(function(){ toast('请求失败'); });
});

el('kaCreate').addEventListener('click', function(){
  var name = el('kaName').value.trim();
  if (!name){ toast('先给它起个名字'); return; }
  var body = { name: name };
  var c = parseInt(el('kaCalls').value, 10);
  if (c > 0) body.dayCalls = c;
  var b = parseInt(el('kaBytes').value, 10);
  if (b > 0) body.dayBytes = b * 1024;   // 面板上填 KB，存字节
  var hosts = el('kaHosts').value.split(/[,\s]+/).filter(Boolean);
  if (hosts.length) body.hosts = hosts;

  fetch('/admin/api/keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
    .then(function(r){
      return r.json().then(function(d){ return { s: r.status, d: d }; });
    })
    .then(function(o){
      if (o.d && o.d.ok){ toast('已创建「' + o.d.key.name + '」'); closeAdd(); pull(); }
      else { toast('创建失败：' + ((o.d && o.d.error) || o.s)); }
    })
    .catch(function(){ toast('请求失败'); });
});

el('otaBtn').addEventListener('click', otaNow);
el('refresh').addEventListener('click', function(){ hideOut(); pull(); });
el('auto').addEventListener('change', function(){
  if (this.checked){ T.timer = setInterval(pull, 5000); }
  else { clearInterval(T.timer); T.timer = null; }
});

pull();
T.timer = setInterval(pull, 5000);
</script>
</body>
</html>`;
}

/**
 * 服务端侧转义。页面脚本里那个 esc() 是跑在浏览器里的前端函数，
 * 服务端渲染模板时用不上，所以这里单独来一份 TS 版的。
 */
function escHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function loginPage(hint?: string, user?: string): string {
  // 口令走 POST body，绝不进 URL —— 进了 URL 就会留在 CF 边缘日志、
  // 浏览器历史和密码管理器里。提交后 Worker 换成一个 HMAC 派生的会话 Cookie。
  const err = hint
    ? `<div class="err">${escHtml(hint)}</div>`
    : '';
  const uname = escHtml(user || '');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>住宅出口 · 登录</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#e5e7eb;--tx:#15181d;--tx2:#5a616d;--tx3:#8b929e;--accent:#2b6ce0}
@media (prefers-color-scheme:dark){
  :root{--bg:#0e1014;--panel:#16191f;--line:#252a33;--tx:#e7eaee;--tx2:#9aa2b0;--tx3:#6a727f;--accent:#6f9dff}
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--tx);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;
  padding:16px}
form{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;
  width:min(330px,100%)}
h1{font-size:15px;font-weight:500;margin:0 0 4px}
p{color:var(--tx3);font-size:11px;margin:0 0 16px;line-height:1.7}
code{font-family:ui-monospace,Consolas,monospace;font-size:10px;
  background:var(--bg);padding:1px 4px;border-radius:4px}
input{width:100%;font:inherit;padding:9px 11px;border-radius:8px;border:1px solid var(--line);
  background:var(--bg);color:var(--tx);margin-bottom:10px}
input:focus{outline:2px solid var(--accent);outline-offset:0;border-color:transparent}
button{width:100%;font:inherit;font-weight:500;padding:10px;border-radius:8px;border:0;
  background:var(--accent);color:#fff;cursor:pointer}
.err{background:#fdecec;color:#b3261e;font-size:11px;padding:7px 9px;border-radius:7px;
  margin-bottom:10px;line-height:1.6}
@media (prefers-color-scheme:dark){.err{background:#2c1618;color:#f2a19c}}
</style>
</head>
<body>
<form method="post" action="/admin/login">
  <h1>住宅出口</h1>
  <p>需要面板账号。口令通过 <code>ADMIN_TOKEN</code> 注入，不写在代码里。</p>
  ${err}
  <input name="user" type="text" placeholder="用户名" value="${uname}" autocomplete="username">
  <input name="token" type="password" placeholder="口令" autofocus autocomplete="current-password">
  <button type="submit">进入</button>
</form>
</body>
</html>`;
}

/**
 * 没配置密钥时给的说明页。
 *
 * 为什么要有这个页面而不是直接回 403：fail-closed 的安全策略是对的，但如果只回一句
 * "unauthorized"，下次自己部署完打开面板会一头雾水——分不清是口令错了还是压根没配。
 * 这里明确说出「缺哪一项、用什么命令补」，把失败变成可操作的提示。
 */
export function setupPage(missing: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>住宅出口 · 还没配置</title>
<style>
:root{--bg:#f6f7f9;--panel:#fff;--line:#e5e7eb;--tx:#15181d;--tx2:#5a616d;--tx3:#8b929e;
  --warn:#a46a00;--warnbg:#fdf3e2;--mono:ui-monospace,Consolas,monospace}
@media (prefers-color-scheme:dark){
  :root{--bg:#0e1014;--panel:#16191f;--line:#252a33;--tx:#e7eaee;--tx2:#9aa2b0;--tx3:#6a727f;
    --warn:#e8b04b;--warnbg:#2a2213}
}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--tx);
  font-family:system-ui,-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;font-size:13px;
  padding:16px;line-height:1.7}
.box{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px;
  width:min(440px,100%)}
h1{font-size:15px;font-weight:500;margin:0 0 10px}
.tagd{display:inline-block;background:var(--warnbg);color:var(--warn);font-size:11px;
  padding:2px 8px;border-radius:6px;margin-bottom:12px}
p{color:var(--tx2);font-size:12px;margin:0 0 12px}
pre{background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px;
  font-family:var(--mono);font-size:11px;overflow-x:auto;margin:0 0 12px;color:var(--tx)}
.note{color:var(--tx3);font-size:11px}
</style>
</head>
<body>
<div class="box">
  <div class="tagd">服务未就绪</div>
  <h1>缺少 <code>${missing}</code></h1>
  <p>这个服务按 <b>fail-closed</b> 策略运行：密钥没配就拒绝服务，而不是放开访问。
     宁可自己打不开，也不要让任何人能拿你家的网络当出口。</p>
  <pre>npx wrangler secret put TUNNEL_TOKEN   # 设备与 Worker 的共享密钥
npx wrangler secret put ADMIN_TOKEN    # 就是这个面板的口令
npx wrangler secret put CLIENT_KEYS    # 给其他项目用的 key，JSON 数组</pre>
  <p class="note">配完重新部署即生效。生成密钥可以用
    <code>openssl rand -hex 24</code> 或任何 32 字节以上的随机串。</p>
</div>
</body>
</html>`;
}
