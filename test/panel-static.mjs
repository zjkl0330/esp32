/**
 * 面板静态检查 —— 在部署前把「模板字符串里的 JS 错误」挡住
 *
 * 为什么需要这个：
 *   面板是一整个 HTML 模板字符串，里面内嵌一大段 JS。
 *   tsc 只检查 TypeScript 部分，**模板里那段 JS 一个字都不查** ——
 *   写错了照样能编译、照样能部署，只是页面上所有按钮都点了没反应。
 *
 *   实际踩过：在模板字符串里写了 '\n'，被当成真实换行，
 *   把 JS 的单引号字符串从中间截断 → 整段脚本语法错误 → 事件全没绑上。
 *
 * 这个测试把模板渲染出来，抽出 <script> 用 new Function 试解析，
 * 顺便检查 JS 引用的元素 id 在 HTML 里是否都存在。
 *
 * 跑：node test/panel-static.mjs
 */
import { adminPage, loginPage, setupPage } from '../worker/src/panel.ts';

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${detail ? '  ' + detail : ''}`);
  }
}

console.log('面板静态检查');

/** 把模板里的 <script> 抽出来做语法检查。没有脚本块的页面是正常的（纯表单页） */
function checkScript(label, html) {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) {
    ok(`${label}：无脚本块（纯表单页，跳过语法检查）`, true);
    return;
  }
  try {
    new Function(m[1]);
    ok(`${label}：脚本语法正确`, true, `${m[1].length} 字符`);
  } catch (e) {
    ok(`${label}：脚本语法正确`, false, e.message);
    // 把出错行附近打出来，省得再二分一次
    const lines = m[1].split('\n');
    let prev = null;
    for (let i = 1; i <= lines.length; i++) {
      try {
        new Function(lines.slice(0, i).join('\n'));
        prev = null;
      } catch (err) {
        if (String(err.message).includes('Invalid or unexpected token') && prev === null) prev = i;
      }
    }
    if (prev) {
      for (let i = Math.max(0, prev - 3); i < Math.min(lines.length, prev + 2); i++) {
        console.log(`      ${i + 1}: ${lines[i]}`);
      }
    }
  }
}

/** JS 里 el('x') 引用的 id，HTML 里必须都有 */
function checkIds(label, html) {
  const js = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((x) => x[1]));
  const used = [...new Set([...js.matchAll(/el\('([A-Za-z0-9_-]+)'\)/g)].map((x) => x[1]))];
  const missing = used.filter((u) => !ids.has(u));
  ok(`${label}：JS 引用的元素都存在`, missing.length === 0, missing.join(', '));
}

/** 模板占位符必须全部被替换，不能漏出 ${...} */
function checkNoPlaceholder(label, html) {
  const bad = html.match(/\$\{[A-Za-z_$]/g);
  ok(`${label}：没有漏出的模板占位符`, !bad, bad ? bad.slice(0, 5).join(' ') : '');
}

checkScript('主面板', adminPage());
checkIds('主面板', adminPage());
checkNoPlaceholder('主面板', adminPage());

checkScript('登录页', loginPage());
checkNoPlaceholder('登录页', loginPage());

checkScript('未配置页', setupPage('ADMIN_TOKEN'));
checkNoPlaceholder('未配置页', setupPage('ADMIN_TOKEN'));

// 登录页必须有用户名字段和口令字段，且都用 POST
{
  const html = loginPage('口令不对');
  ok('登录页有用户名输入框', /name="user"/.test(html));
  ok('登录页有口令输入框', /name="token"/.test(html));
  ok('登录页用 POST 提交', /method="post"/i.test(html));
  ok('登录页没有把口令放进 URL', !/action="[^"]*\?/.test(html) && !/name="token"[^>]*value=/.test(html));
}

// 主面板必须有密钥管理的关键控件
{
  const html = adminPage();
  for (const [name, re] of [
    ['显示密钥开关', /id="keyReveal"/],
    ['新增一把按钮', /id="keyAddBtn"/],
    ['新增表单', /id="keyAdd"/],
    ['创建按钮', /id="kaCreate"/],
    ['名称输入', /id="kaName"/],
    ['次数上限输入', /id="kaCalls"/],
    ['流量上限输入', /id="kaBytes"/],
    ['域名白名单输入', /id="kaHosts"/],
    ['密钥列表容器', /id="keys"/],
  ]) {
    ok(`主面板：${name} 存在`, re.test(html));
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
