import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUpstreamBody,
  kiloBase,
  listKiloModels,
  requestKiloChat,
  responseToSseStream,
  rewriteJsonText,
} from '../dist/providers/kilo.js';
import { GatewayError } from '../dist/openai/errors.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

test('kiloBase strips trailing slashes', () => {
  assert.equal(kiloBase('https://api.kilo.ai/api/gateway///'), 'https://api.kilo.ai/api/gateway');
  assert.equal(kiloBase(undefined), 'https://api.kilo.ai/api/gateway');
});

test('listKiloModels keeps only isFree rows and dedupes', async () => {
  const models = await listKiloModels({
    base: 'https://kilo.test',
    fetchImpl: async () =>
      json({
        data: [
          { id: 'kilo-auto/free', isFree: true },
          { id: 'paid/model', isFree: false },
          { id: 'kilo-auto/free', isFree: true },
          { id: 'nvidia/nemotron:free', isFree: true },
        ],
      }),
    timeoutMs: 1000,
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ['kilo/kilo-auto/free', 'kilo/nvidia/nemotron:free']
  );
  assert.equal(models[0].upstream, 'kilo-auto/free');
});

test('requestKiloChat maps 401 to model_not_found', async () => {
  await assert.rejects(
    () =>
      requestKiloChat({
        base: 'https://kilo.test',
        body: { model: 'paid/model' },
        stream: false,
        fetchImpl: async () => json({ error: { message: 'paid model' } }, 401),
        timeoutMs: 1000,
      }),
    (error) => error instanceof GatewayError && error.status === 404 && error.code === 'model_not_found'
  );
});

test('requestKiloChat keeps Retry-After on 429', async () => {
  await assert.rejects(
    () =>
      requestKiloChat({
        base: 'https://kilo.test',
        body: { model: 'kilo-auto/free' },
        stream: true,
        fetchImpl: async () =>
          json({ error: { message: 'slow down' } }, 429, { 'retry-after': '5' }),
        timeoutMs: 1000,
      }),
    (error) =>
      error instanceof GatewayError &&
      error.status === 429 &&
      error.code === 'upstream_rate_limited' &&
      error.headers?.['retry-after'] === '5'
  );
});

test('requestKiloChat retries a 5xx once', async () => {
  let calls = 0;
  const response = await requestKiloChat({
    base: 'https://kilo.test',
    body: { model: 'kilo-auto/free' },
    stream: false,
    fetchImpl: async () => {
      calls += 1;
      return calls === 1 ? json({ error: { message: 'boom' } }, 500) : json({ ok: true });
    },
    timeoutMs: 1000,
  });
  assert.equal(calls, 2);
  assert.equal(response.status, 200);
});

test('rewriteJsonText rewrites model', async () => {
  const text = await rewriteJsonText(
    json({
      id: 'x',
      model: 'stealth/glyph-cluster',
      choices: [{ message: { role: 'assistant', content: 'hi' } }],
    }),
    'kilo/kilo-auto/free'
  );
  const parsed = JSON.parse(text);
  assert.equal(parsed.model, 'kilo/kilo-auto/free');
  assert.equal(parsed.choices[0].message.content, 'hi');
});

test('responseToSseStream rewrites an SSE upstream', async () => {
  const stream = await responseToSseStream(
    new Response(
      'data: {"model":"stealth/x","choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    ),
    'kilo/kilo-auto/free'
  );
  const text = await new Response(stream).text();
  assert.match(text, /"model":"kilo\/kilo-auto\/free"/);
  assert.match(text, /data: \[DONE\]/);
});

test('responseToSseStream converts a JSON upstream to SSE', async () => {
  const stream = await responseToSseStream(
    json({
      id: 'x',
      choices: [{ message: { role: 'assistant', content: 'hello' }, finish_reason: 'stop' }],
    }),
    'kilo/test'
  );
  const text = await new Response(stream).text();
  assert.match(text, /"model":"kilo\/test"/);
  assert.match(text, /"content":"hello"/);
  assert.match(text, /data: \[DONE\]/);
});

test('buildUpstreamBody strips gateway-only fields', () => {
  const body = buildUpstreamBody(
    {
      model: 'kilo/x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      max_tokens: 10,
      stream_options: { include_usage: true },
    },
    'upstream/x'
  );
  assert.equal(body.model, 'upstream/x');
  assert.equal(body.stream, true);
  assert.equal(body.max_tokens, 10);
  assert.deepEqual(body.messages, [{ role: 'user', content: 'hi' }]);
});

test('buildUpstreamBody defaults max_tokens to 1024', () => {
  const body = buildUpstreamBody(
    {
      model: 'kilo/x',
      messages: [{ role: 'user', content: 'hi' }],
      stream: false,
    },
    'upstream/x'
  );
  assert.equal(body.max_tokens, 1024);
});
