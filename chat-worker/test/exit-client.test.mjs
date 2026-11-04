import assert from 'node:assert/strict';
import test from 'node:test';

import { createExitFetch } from '../dist/exit-client.js';

test('exit fetch routes requests through /api/fetch with the client key', async () => {
  let seen;
  const exit = {
    fetch: async (url, init) => {
      seen = { url: String(url), init };
      return new Response('hello', {
        status: 200,
        headers: { 'x-exit-status': '201', 'x-exit-ctype': 'text/plain' },
      });
    },
  };
  const webFetch = createExitFetch(exit, 'sk-exit');
  const res = await webFetch('https://target.test/api?q=1', {
    method: 'POST',
    headers: { 'x-test': '1', 'content-type': 'application/json' },
    body: '{"n":1}',
  });

  assert.equal(res.status, 201);
  assert.equal(await res.text(), 'hello');
  assert.equal(res.headers.get('content-type'), 'text/plain');

  assert.match(seen.url, /\/api\/fetch$/);
  assert.equal(seen.init.headers.authorization, 'Bearer sk-exit');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.url, 'https://target.test/api?q=1');
  assert.equal(body.method, 'POST');
  assert.equal(body.headers['x-test'], '1');
  assert.equal(body.body, '{"n":1}');
  assert.equal(body.maxBytes, 262144);
});

test('exit fetch passes exit-side errors through', async () => {
  const exit = {
    fetch: async () =>
      new Response(JSON.stringify({ error: 'no_available_node' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      }),
  };
  const res = await createExitFetch(exit, 'sk-exit')('https://target.test/');
  assert.equal(res.status, 503);
});
