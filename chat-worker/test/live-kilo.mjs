/**
 * 真实上游冒烟（可选，不在 npm test 里跑）：
 *   npm run live
 *
 * 会真的打 Kilo 公共网关，消耗免费额度；不经过 ESP32。
 */
import { createHandler } from '../dist/index.js';
import { MemoryModelCache } from '../dist/storage/cache.js';
import { MemoryStore } from '../dist/storage/store.js';

const API_KEY = process.env.CHAT_API_KEY || 'sk-chat_live_0123456789abcdef';
const KILO_BASE = process.env.KILO_BASE || 'https://api.kilo.ai/api/gateway';
const MODEL = process.env.CHAT_MODEL || 'kilo/kilo-auto/free';

const pending = [];
const handler = createHandler({
  env: {
    CHAT_API_KEYS: JSON.stringify([{ name: 'live', key: API_KEY, dayCalls: 20, dayBytes: null }]),
    KILO_BASE,
  },
  fetch: globalThis.fetch,
  store: new MemoryStore(),
  cache: new MemoryModelCache(),
  now: () => Date.now(),
  waitUntil: (promise) => pending.push(promise),
});

const headers = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

const models = await handler(new Request('https://chat.test/v1/models', { headers }));
console.log('models', models.status, models.headers.get('x-catalog-source'));
const modelBody = await models.json();
console.log('free models', modelBody.data.length);
console.log(modelBody.data.slice(0, 8).map((model) => model.id).join('\n'));

const started = Date.now();
const stream = await handler(
  new Request('https://chat.test/v1/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: MODEL,
      stream: true,
      max_tokens: 128,
      messages: [{ role: 'user', content: '用一句话介绍你自己' }],
    }),
  })
);

console.log('stream', stream.status, stream.headers.get('content-type'), `${Date.now() - started}ms`);
const text = await stream.text();
const dataLines = text.split('\n').filter((line) => line.startsWith('data:') && line !== 'data: [DONE]');
console.log('sse frames', dataLines.length);
console.log('last frame', dataLines.at(-1)?.slice(0, 300) ?? '(none)');
await Promise.all(pending);
