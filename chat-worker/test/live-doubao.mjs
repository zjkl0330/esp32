/**
 * 豆包网页通道真实冒烟（可选，不在 npm test 里跑）：
 *   DOUBAO_SESSIONID=... npm run live:doubao
 *
 * sessionid 从浏览器登录 www.doubao.com 后，在 DevTools → Application → Cookies
 * 里复制 sessionid。不要提交到仓库；只放在本地 .dev.vars 或 secret 里。
 */
import { createHandler } from '../dist/index.js';
import { MemoryModelCache } from '../dist/storage/cache.js';
import { MemoryStore } from '../dist/storage/store.js';

const SESSION = process.env.DOUBAO_SESSIONID || '';
const BASE = process.env.DOUBAO_BASE || 'https://www.doubao.com';
const API_KEY = process.env.CHAT_API_KEY || 'sk-chat_live_0123456789abcdef';
const MODEL = process.env.CHAT_MODEL || 'web/doubao/doubao';

if (!SESSION) {
  console.error('缺少 DOUBAO_SESSIONID。用法：DOUBAO_SESSIONID=... npm run live:doubao');
  process.exit(1);
}

const pending = [];
const handler = createHandler({
  env: {
    CHAT_API_KEYS: JSON.stringify([{ name: 'live', key: API_KEY, dayCalls: 20, dayBytes: null }]),
    KILO_BASE: 'https://api.kilo.ai/api/gateway',
    DOUBAO_BASE: BASE,
    DOUBAO_SESSIONID: SESSION,
  },
  fetch: globalThis.fetch,
  store: new MemoryStore(),
  cache: new MemoryModelCache(),
  now: () => Date.now(),
  waitUntil: (promise) => pending.push(promise),
});

const headers = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

const models = await handler(new Request('https://chat.test/v1/models', { headers }));
const modelBody = await models.json();
console.log(
  'doubao models',
  modelBody.data.filter((model) => model.id.startsWith('web/doubao/')).map((model) => model.id)
);

const started = Date.now();
const stream = await handler(
  new Request('https://chat.test/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 128,
      messages: [{ role: 'user', content: '只回复两个字：你好' }],
    }),
  })
);

console.log('stream', stream.status, stream.headers.get('content-type'), `${Date.now() - started}ms`);
const text = await stream.text();
console.log(text.slice(0, 800));
await Promise.all(pending);
