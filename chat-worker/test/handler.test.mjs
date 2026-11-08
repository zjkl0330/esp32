import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../dist/index.js';
import { MemoryAccountStore } from '../dist/storage/accounts.js';
import { MemoryModelCache } from '../dist/storage/cache.js';
import { MemoryStore } from '../dist/storage/store.js';

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function makeFetch({
  models = [{ id: 'kilo-auto/free', isFree: true }],
  qwenModels = [{ id: 'qwen3.7-plus' }],
  chat,
  chatStatus = 200,
  chatSse,
} = {}) {
  return async (input) => {
    const url = String(input);
    if (url.includes('qwen.test') && url.endsWith('/models')) return json({ data: qwenModels });
    if (url.endsWith('/models')) return json({ data: models });
    if (url.endsWith('/chat/completions')) {
      if (chatStatus !== 200) {
        return json({ error: { message: 'upstream says no' } }, chatStatus, { 'retry-after': '3' });
      }
      if (chatSse) {
        return new Response(chatSse, { headers: { 'content-type': 'text/event-stream' } });
      }
      return json(
        chat ?? {
          id: 'chatcmpl-1',
          created: 1762000000,
          model: 'stealth/glyph-cluster',
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: '你好' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }
      );
    }
    throw new Error(`unexpected url: ${url}`);
  };
}

function makeDeepSeekFetch(record = {}) {
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v0/chat_session/create')) {
      return json({ data: { biz_data: { chat_session: { id: 's1' } } } });
    }
    if (url.includes('/api/v0/chat/create_pow_challenge')) {
      return json({
        data: {
          biz_data: {
            challenge: {
              algorithm: 'DeepSeekHashV1',
              challenge: 'b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1',
              salt: 'dde3ed472be5a2494ee0',
              difficulty: 144000,
              expire_at: 1777057596443,
              signature: 'test',
              target_path: '/api/v0/chat/completion',
            },
          },
        },
      });
    }
    if (url.includes('/api/v0/chat/completion')) {
      record.headers = init.headers;
      return new Response(
        'data: {"p":"response/content","v":"你"}\n\n' +
          'data: {"v":"好"}\n\n' +
          'data: {"p":"response/status","v":"FINISHED"}\n\n',
        { headers: { 'content-type': 'text/event-stream' } }
      );
    }
    throw new Error(`unexpected DeepSeek url: ${url}`);
  };
}

function makeDoubaoFetch() {
  return async (input) => {
    const url = String(input);
    if (url.includes('/samantha/chat/completion')) {
      const events = [
        { event_type: 2001, event_data: JSON.stringify({ message: { content: '你', content_type: 0 } }) },
        { event_type: 2001, event_data: JSON.stringify({ message: { content: '好', content_type: 0 } }) },
        { event_type: 2003 },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected Doubao url: ${url}`);
  };
}

function makeDeepSeekLoginFetch({ loginError = false } = {}) {
  const chat = makeDeepSeekFetch({});
  return async (input, init) => {
    const url = String(input);
    if (url.includes('/api/v0/users/create_sms_verification_code')) {
      if (loginError) {
        return json({ data: { biz_code: 40001, biz_msg: 'captcha required' } });
      }
      return new Response(
        JSON.stringify({ data: { biz_code: 0, biz_data: { send_window_secs: 60 } } }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'ds_device=dev1; Path=/',
          },
        }
      );
    }
    if (url.includes('/api/v0/users/login_by_mobile_sms')) {
      return new Response(
        JSON.stringify({
          data: { biz_code: 0, biz_data: { user: { token: 'ds-login-token', id: 'u1' } } },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'ds_session=sess1; Path=/; HttpOnly',
          },
        }
      );
    }
    return chat(input, init);
  };
}

function makeDoubaoLoginFetch() {
  const chat = makeDoubaoFetch();
  return async (input, init) => {
    const url = String(input);
    if (url === 'https://accounts.doubao.test/') {
      return new Response('ok', { headers: { 'set-cookie': 'ttwid=tt1; Path=/' } });
    }
    if (url.includes('/passport/web/send_code/')) {
      return new Response(JSON.stringify({ message: 'success', data: {} }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'passport_csrf=csrf1; Path=/',
        },
      });
    }
    if (url.includes('/passport/web/sms_login/')) {
      return new Response(JSON.stringify({ message: 'success', data: {} }), {
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'sessionid=sess1; Path=/; Domain=.doubao.com; HttpOnly',
        },
      });
    }
    return chat(input, init);
  };
}

function makeChatGptFetch({ blocked = false } = {}) {
  return async (input) => {
    const url = String(input);
    if (url === 'https://chatgpt.test/') {
      return new Response('<html data-build="dpl-test"><script src="/sdk.js"></script></html>', {
        headers: { 'content-type': 'text/html' },
      });
    }
    if (url.includes('/sentinel/chat-requirements')) {
      if (blocked) return new Response('cf_chl_opt', { status: 403 });
      return json({
        token: 'sentinel-token',
        proofofwork: { required: false },
        turnstile: { required: false },
        arkose: { required: false },
      });
    }
    if (url.includes('/backend-api/conversation')) {
      const events = [
        { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你'] }, status: 'in_progress' } },
        { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好'] }, status: 'in_progress' } },
        { message: { id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: ['你好'] }, status: 'finished_successfully' } },
      ];
      const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n';
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    }
    throw new Error(`unexpected ChatGPT url: ${url}`);
  };
}

function makeGlmFetch() {
  return async (input) => {
    const url = String(input);
    if (url.includes('/chatglm/backend-api/assistant/stream')) {
      const events = [
        {
          conversation_id: 'c1',
          status: 'running',
          parts: [{ content: [{ type: 'text', text: '你' }] }],
        },
        {
          status: 'running',
          parts: [{ content: [{ type: 'text', text: '你好' }] }],
        },
        {
          status: 'finish',
          parts: [{ content: [{ type: 'text', text: '你好' }] }],
        },
      ];
      return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      });
    }
    throw new Error(`unexpected GLM url: ${url}`);
  };
}

function makeHandler({
  env = {},
  fetchImpl = makeFetch(),
  webFetch = fetchImpl,
  store = new MemoryStore(),
  accounts = new MemoryAccountStore(),
  cache = new MemoryModelCache(),
} = {}) {
  const pending = [];
  const handler = createHandler({
    env: {
      CHAT_API_KEYS: JSON.stringify([
        { name: 'test', key: 'sk-chat_test_0123456789', dayCalls: null, dayBytes: null },
      ]),
      KILO_BASE: 'https://kilo.test',
      ...env,
    },
    fetch: fetchImpl,
    webFetch,
    store,
    accounts,
    cache,
    now: () => Date.now(),
    waitUntil: (promise) => {
      pending.push(promise);
    },
  });
  return { handler, pending, store, cache };
}

function req(path, { method = 'GET', key = 'sk-chat_test_0123456789', body, headers = {} } = {}) {
  const merged = { ...headers };
  if (key) merged.authorization = `Bearer ${key}`;
  if (body !== undefined) merged['content-type'] = 'application/json';
  return new Request(`https://chat.test${path}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const CHAT_BODY = {
  model: 'kilo/kilo-auto/free',
  messages: [{ role: 'user', content: '你好' }],
};

test('GET /health is public', async () => {
  const { handler } = makeHandler();
  const res = await handler(req('/health', { key: '' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test('missing and wrong API keys are rejected', async () => {
  const { handler } = makeHandler();
  const missing = await handler(req('/v1/models', { key: '' }));
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'invalid_api_key');

  const wrong = await handler(req('/v1/models', { key: 'sk-chat_wrong' }));
  assert.equal(wrong.status, 401);
});

test('no configured keys fails closed with 503', async () => {
  const { handler } = makeHandler({ env: { CHAT_API_KEYS: '' } });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'not_configured');
});

test('GET /v1/models returns free models', async () => {
  const { handler } = makeHandler({
    fetchImpl: makeFetch({
      models: [
        { id: 'kilo-auto/free', isFree: true },
        { id: 'paid/model', isFree: false },
      ],
    }),
  });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-catalog-source'), 'upstream');
  const body = await res.json();
  assert.deepEqual(body.data.map((item) => item.id), ['kilo/kilo-auto/free']);
});

test('non-stream chat rewrites model and content', async () => {
  const { handler, pending } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', { method: 'POST', body: CHAT_BODY })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'kilo/kilo-auto/free');
  assert.equal(body.choices[0].message.content, '你好');
  await Promise.all(pending);
});

test('stream chat returns SSE with rewritten model', async () => {
  const { handler, pending } = makeHandler({
    fetchImpl: makeFetch({
      chatSse:
        'data: {"id":"x","model":"stealth/glyph-cluster","choices":[{"delta":{"content":"你"}}]}\n\n' +
        'data: {"id":"x","model":"stealth/glyph-cluster","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    }),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: { ...CHAT_BODY, stream: true },
    })
  );
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  const text = await res.text();
  assert.match(text, /"model":"kilo\/kilo-auto\/free"/);
  assert.doesNotMatch(text, /stealth\/glyph-cluster/);
  assert.match(text, /"content":"你"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('invalid tools return unsupported_parameter', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        ...CHAT_BODY,
        tools: [{ type: 'function', function: { name: 'f' } }],
      },
    })
  );
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'unsupported_parameter');
});

test('web/* is rejected until a provider is enabled', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: { ...CHAT_BODY, model: 'web/unknown/default' },
    })
  );
  assert.equal(res.status, 404);
  assert.equal((await res.json()).error.code, 'model_not_found');
});

test('qwen models appear when QWEN_TOKEN is configured', async () => {
  const { handler } = makeHandler({
    env: { QWEN_TOKEN: 'qwen-token', QWEN_BASE: 'https://qwen.test' },
  });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((model) => model.id === 'web/qwen/qwen3.7-plus'));
});

test('qwen chat streams through the web channel', async () => {
  const { handler, pending } = makeHandler({
    env: { QWEN_TOKEN: 'qwen-token', QWEN_BASE: 'https://qwen.test' },
    fetchImpl: makeFetch({
      chatSse:
        'data: {"id":"x","model":"qwen3.7-plus","choices":[{"delta":{"content":"你"}}]}\n\n' +
        'data: {"id":"x","model":"qwen3.7-plus","choices":[{"delta":{"content":"好"},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n',
    }),
  });

  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/qwen/qwen3.7-plus',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-channel'), 'qwen');
  const text = await res.text();
  assert.match(text, /"model":"web\/qwen\/qwen3.7-plus"/);
  assert.match(text, /"content":"你"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('qwen without token fails closed', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/qwen/qwen3.7-plus',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'web_not_configured');
});

test('qwen rejected token maps to invalid_web_token', async () => {
  const { handler } = makeHandler({
    env: { QWEN_TOKEN: 'bad-token', QWEN_BASE: 'https://qwen.test' },
    fetchImpl: async (input) => {
      const url = String(input);
      if (url.endsWith('/models')) return json({ data: [{ id: 'qwen3.7-plus' }] });
      return json({ error: { message: 'token expired' } }, 401);
    },
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/qwen/qwen3.7-plus',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, 'invalid_web_token');
});

test('deepseek models appear when DEEPSEEK_TOKEN is configured', async () => {
  const { handler } = makeHandler({
    env: { DEEPSEEK_TOKEN: 'ds-token', DEEPSEEK_BASE: 'https://deepseek.test' },
  });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((model) => model.id === 'web/deepseek/deepseek-default'));
});

test('deepseek chat streams through PoW and session', async () => {
  const record = {};
  const { handler, pending } = makeHandler({
    env: {
      DEEPSEEK_TOKEN: 'ds-token',
      DEEPSEEK_BASE: 'https://deepseek.test',
      DEEPSEEK_SESSION_ID: 's1',
    },
    fetchImpl: makeDeepSeekFetch(record),
  });

  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/deepseek/deepseek-default',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-channel'), 'deepseek');
  assert.ok(record.headers['x-ds-pow-response']);
  const text = await res.text();
  assert.match(text, /"model":"web\/deepseek\/deepseek-default"/);
  assert.match(text, /"content":"你"/);
  assert.match(text, /"content":"好"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('deepseek non-stream aggregates content', async () => {
  const { handler, pending } = makeHandler({
    env: {
      DEEPSEEK_TOKEN: 'ds-token',
      DEEPSEEK_BASE: 'https://deepseek.test',
      DEEPSEEK_SESSION_ID: 's1',
    },
    fetchImpl: makeDeepSeekFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/deepseek/deepseek-default',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'web/deepseek/deepseek-default');
  assert.equal(body.choices[0].message.content, '你好');
  await Promise.all(pending);
});

test('deepseek without token fails closed', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/deepseek/deepseek-default',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'web_not_configured');
});

test('doubao models appear when DOUBAO_SESSIONID is configured', async () => {
  const { handler } = makeHandler({
    env: { DOUBAO_SESSIONID: 'doubao-sid', DOUBAO_BASE: 'https://doubao.test' },
  });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((model) => model.id === 'web/doubao/doubao'));
});

test('doubao chat streams through samantha endpoint', async () => {
  const { handler, pending } = makeHandler({
    env: { DOUBAO_SESSIONID: 'doubao-sid', DOUBAO_BASE: 'https://doubao.test' },
    fetchImpl: makeDoubaoFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/doubao/doubao',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-channel'), 'doubao');
  const text = await res.text();
  assert.match(text, /"model":"web\/doubao\/doubao"/);
  assert.match(text, /"content":"你"/);
  assert.match(text, /"content":"好"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('doubao non-stream aggregates content', async () => {
  const { handler, pending } = makeHandler({
    env: { DOUBAO_SESSIONID: 'doubao-sid', DOUBAO_BASE: 'https://doubao.test' },
    fetchImpl: makeDoubaoFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/doubao/doubao',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'web/doubao/doubao');
  assert.equal(body.choices[0].message.content, '你好');
  await Promise.all(pending);
});

test('doubao without sessionid fails closed', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/doubao/doubao',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'web_not_configured');
});

test('deepseek sms login stores account and chat uses it', async () => {
  const accounts = new MemoryAccountStore();
  const { handler, pending } = makeHandler({
    env: { ADMIN_TOKEN: 'admin-secret', DEEPSEEK_BASE: 'https://deepseek.test' },
    fetchImpl: makeDeepSeekLoginFetch(),
    accounts,
  });

  const sent = await handler(
    req('/v1/auth/deepseek/sms/send', {
      method: 'POST',
      key: 'admin-secret',
      body: { mobile: '13800000000' },
    })
  );
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.equal(sentBody.provider, 'deepseek');
  assert.match(sentBody.deviceId, /^7\d{18}$/);
  assert.equal(sentBody.sendWindowSecs, 60);
  assert.equal(sentBody.cookie, 'ds_device=dev1');

  const verified = await handler(
    req('/v1/auth/deepseek/sms/verify', {
      method: 'POST',
      key: 'admin-secret',
      body: {
        mobile: '13800000000',
        code: '123456',
        deviceId: sentBody.deviceId,
        cookie: sentBody.cookie,
      },
    })
  );
  assert.equal(verified.status, 200);
  const verifiedBody = await verified.json();
  assert.equal(verifiedBody.account.provider, 'deepseek');
  const saved = await accounts.getByProvider('deepseek');
  assert.match(saved.credentials.cookie, /ds_device=dev1/);
  assert.match(saved.credentials.cookie, /ds_session=sess1/);
  assert.equal(saved.credentials.token, 'ds-login-token');

  const models = await handler(req('/v1/models'));
  const body = await models.json();
  assert.ok(body.data.some((model) => model.id === 'web/deepseek/deepseek-default'));

  const chat = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/deepseek/deepseek-default',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-chat-channel'), 'deepseek');
  await Promise.all(pending);
});

test('deepseek sms login surfaces captcha failure', async () => {
  const { handler } = makeHandler({
    env: { ADMIN_TOKEN: 'admin-secret', DEEPSEEK_BASE: 'https://deepseek.test' },
    fetchImpl: makeDeepSeekLoginFetch({ loginError: true }),
  });
  const res = await handler(
    req('/v1/auth/deepseek/sms/send', {
      method: 'POST',
      key: 'admin-secret',
      body: { mobile: '13800000000' },
    })
  );
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, 'login_failed');
  assert.match(body.error.message, /captcha/);
});

test('login endpoints are fail-closed without admin token', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/auth/deepseek/sms/send', {
      method: 'POST',
      key: 'admin-secret',
      body: { mobile: '13800000000' },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'not_configured');
});

test('admin panel HTML is served', async () => {
  const { handler } = makeHandler();
  const res = await handler(req('/admin', { key: '' }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  assert.match(html, /chat2api 控制台/);
});

test('admin accounts API stores and removes credentials', async () => {
  const accounts = new MemoryAccountStore();
  const { handler } = makeHandler({ env: { ADMIN_TOKEN: 'admin-secret' }, accounts });

  const created = await handler(
    req('/admin/api/accounts', {
      method: 'POST',
      key: 'admin-secret',
      body: { provider: 'qwen', label: 'q1', credentials: { token: 'qwen-token' } },
    })
  );
  assert.equal(created.status, 201);
  const body = await created.json();
  assert.equal(body.account.provider, 'qwen');
  assert.equal(body.account.label, 'q1');
  assert.equal(body.account.credentials, undefined);

  const listed = await handler(req('/admin/api/accounts', { key: 'admin-secret' }));
  assert.equal(listed.status, 200);
  assert.equal((await listed.json()).data.length, 1);

  const removed = await handler(
    req('/admin/api/accounts/' + body.account.id, {
      method: 'DELETE',
      key: 'admin-secret',
    })
  );
  assert.equal(removed.status, 200);
  const remaining = await handler(req('/admin/api/accounts', { key: 'admin-secret' }));
  assert.equal((await remaining.json()).data.length, 0);
});

test('glm models appear when GLM_TOKEN is configured', async () => {
  const { handler } = makeHandler({
    env: { GLM_TOKEN: 'glm-token', GLM_BASE: 'https://glm.test' },
  });
  const res = await handler(req('/v1/models'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(body.data.some((model) => model.id === 'web/glm/glm'));
});

test('glm chat streams snapshot parts as deltas', async () => {
  const { handler, pending } = makeHandler({
    env: { GLM_TOKEN: 'glm-token', GLM_BASE: 'https://glm.test' },
    fetchImpl: makeGlmFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/glm/glm',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-channel'), 'glm');
  const text = await res.text();
  assert.match(text, /"model":"web\/glm\/glm"/);
  assert.match(text, /"content":"你"/);
  assert.match(text, /"content":"好"/);
  assert.doesNotMatch(text, /"content":"你好"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('glm non-stream aggregates content', async () => {
  const { handler, pending } = makeHandler({
    env: { GLM_TOKEN: 'glm-token', GLM_BASE: 'https://glm.test' },
    fetchImpl: makeGlmFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/glm/glm',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.model, 'web/glm/glm');
  assert.equal(body.choices[0].message.content, '你好');
  await Promise.all(pending);
});

test('glm without token fails closed', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/glm/glm',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'web_not_configured');
});

test('chatgpt models appear when access token is configured', async () => {
  const { handler } = makeHandler({
    env: { CHATGPT_ACCESS_TOKEN: 'chatgpt-token', CHATGPT_BASE: 'https://chatgpt.test' },
  });
  const res = await handler(req('/v1/models'));
  const body = await res.json();
  assert.ok(body.data.some((model) => model.id === 'web/chatgpt/gpt-4o'));
});

test('chatgpt chat streams sentinel conversation SSE', async () => {
  const { handler, pending } = makeHandler({
    env: { CHATGPT_ACCESS_TOKEN: 'chatgpt-token', CHATGPT_BASE: 'https://chatgpt.test' },
    fetchImpl: makeChatGptFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/chatgpt/gpt-4o',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-chat-channel'), 'chatgpt');
  const text = await res.text();
  assert.match(text, /"content":"你"/);
  assert.match(text, /"content":"好"/);
  assert.doesNotMatch(text, /"content":"你好"/);
  assert.match(text, /data: \[DONE\]/);
  await Promise.all(pending);
});

test('chatgpt non-stream aggregates content', async () => {
  const { handler, pending } = makeHandler({
    env: { CHATGPT_ACCESS_TOKEN: 'chatgpt-token', CHATGPT_BASE: 'https://chatgpt.test' },
    fetchImpl: makeChatGptFetch(),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/chatgpt/gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.choices[0].message.content, '你好');
  await Promise.all(pending);
});

test('chatgpt cf_chl_opt is surfaced as provider_blocked', async () => {
  const { handler } = makeHandler({
    env: { CHATGPT_ACCESS_TOKEN: 'chatgpt-token', CHATGPT_BASE: 'https://chatgpt.test' },
    fetchImpl: makeChatGptFetch({ blocked: true }),
  });
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/chatgpt/gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'provider_blocked');
});

test('chatgpt without token fails closed', async () => {
  const { handler } = makeHandler();
  const res = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/chatgpt/gpt-4o',
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error.code, 'web_not_configured');
});

test('doubao sms login stores sessionid and cookie, then chat uses it', async () => {
  const accounts = new MemoryAccountStore();
  const { handler, pending } = makeHandler({
    env: { ADMIN_TOKEN: 'admin-secret', DOUBAO_PASSPORT_BASE: 'https://accounts.doubao.test' },
    fetchImpl: makeDoubaoLoginFetch(),
    accounts,
  });

  const sent = await handler(
    req('/v1/auth/doubao/sms/send', {
      method: 'POST',
      key: 'admin-secret',
      body: { mobile: '13800000000' },
    })
  );
  assert.equal(sent.status, 200);
  const sentBody = await sent.json();
  assert.match(sentBody.cookie, /ttwid=tt1/);
  assert.match(sentBody.cookie, /passport_csrf=csrf1/);

  const verified = await handler(
    req('/v1/auth/doubao/sms/verify', {
      method: 'POST',
      key: 'admin-secret',
      body: { mobile: '13800000000', code: '123456', cookie: sentBody.cookie },
    })
  );
  assert.equal(verified.status, 200);
  const saved = await accounts.getByProvider('doubao');
  assert.equal(saved.credentials.sessionid, 'sess1');
  assert.match(saved.credentials.cookie, /sessionid=sess1/);

  const models = await handler(req('/v1/models'));
  const body = await models.json();
  assert.ok(body.data.some((model) => model.id === 'web/doubao/doubao'));

  const chat = await handler(
    req('/v1/chat/completions', {
      method: 'POST',
      body: {
        model: 'web/doubao/doubao',
        stream: true,
        messages: [{ role: 'user', content: '你好' }],
      },
    })
  );
  assert.equal(chat.status, 200);
  assert.equal(chat.headers.get('x-chat-channel'), 'doubao');
  await Promise.all(pending);
});

test('daily call quota is enforced', async () => {
  const { handler } = makeHandler({
    env: {
      CHAT_API_KEYS: JSON.stringify([
        { name: 'test', key: 'sk-chat_test_0123456789', dayCalls: 1, dayBytes: null },
      ]),
    },
  });
  const first = await handler(req('/v1/chat/completions', { method: 'POST', body: CHAT_BODY }));
  assert.equal(first.status, 200);

  const second = await handler(req('/v1/chat/completions', { method: 'POST', body: CHAT_BODY }));
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'quota_exceeded');
});

test('upstream 429 is passed through with Retry-After', async () => {
  const { handler } = makeHandler({ fetchImpl: makeFetch({ chatStatus: 429 }) });
  const res = await handler(req('/v1/chat/completions', { method: 'POST', body: CHAT_BODY }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('retry-after'), '3');
  assert.equal((await res.json()).error.code, 'upstream_rate_limited');
});

test('admin can create, list, use and revoke a key', async () => {
  const store = new MemoryStore();
  const { handler } = makeHandler({
    store,
    env: { ADMIN_TOKEN: 'admin-secret' },
  });

  const created = await handler(
    req('/admin/api/keys', {
      method: 'POST',
      key: 'admin-secret',
      body: { name: 'proj', dayCalls: 10, dayBytes: 1000 },
    })
  );
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.match(createdBody.key, /^sk-chat_/);
  assert.equal(createdBody.name, 'proj');

  const listed = await handler(req('/admin/api/keys', { key: 'admin-secret' }));
  assert.equal(listed.status, 200);
  const listedBody = await listed.json();
  assert.equal(listedBody.data.length, 1);
  assert.equal(listedBody.data[0].name, 'proj');

  const models = await handler(req('/v1/models', { key: createdBody.key }));
  assert.equal(models.status, 200);

  const revoked = await handler(
    req('/admin/api/keys/proj', { method: 'DELETE', key: 'admin-secret' })
  );
  assert.equal(revoked.status, 200);

  const after = await handler(req('/v1/models', { key: createdBody.key }));
  assert.equal(after.status, 401);

  // 吊销最后一把后，secret 里的种子不能“复活”
  const seedAfter = await handler(req('/v1/models', { key: 'sk-chat_test_0123456789' }));
  assert.equal(seedAfter.status, 401);
});

test('admin rejects the same key under two names', async () => {
  const store = new MemoryStore();
  const { handler } = makeHandler({ store, env: { ADMIN_TOKEN: 'admin-secret' } });
  const shared = 'sk-chat_shared_0123456789abcdef';
  const first = await handler(
    req('/admin/api/keys', { method: 'POST', key: 'admin-secret', body: { name: 'one', key: shared } })
  );
  assert.equal(first.status, 201);
  const second = await handler(
    req('/admin/api/keys', { method: 'POST', key: 'admin-secret', body: { name: 'two', key: shared } })
  );
  assert.equal(second.status, 409);
  assert.equal((await second.json()).error.code, 'duplicate_key');
});

test('admin duplicate name returns 409', async () => {
  const store = new MemoryStore();
  const { handler } = makeHandler({ store, env: { ADMIN_TOKEN: 'admin-secret' } });
  const body = { name: 'dup', key: 'sk-chat_abcdefghijklmnopqrstuvwx' };
  const first = await handler(req('/admin/api/keys', { method: 'POST', key: 'admin-secret', body }));
  assert.equal(first.status, 201);
  const second = await handler(req('/admin/api/keys', { method: 'POST', key: 'admin-secret', body }));
  assert.equal(second.status, 409);
});

test('admin is fail-closed without ADMIN_TOKEN', async () => {
  const { handler } = makeHandler();
  const res = await handler(req('/admin/api/keys', { key: 'admin-secret' }));
  assert.equal(res.status, 503);
});

test('OPTIONS returns 204 with CORS', async () => {
  const { handler } = makeHandler();
  const res = await handler(req('/v1/models', { method: 'OPTIONS', key: '' }));
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('GET /api/me reports usage after a chat', async () => {
  const { handler, pending } = makeHandler();
  await handler(req('/v1/chat/completions', { method: 'POST', body: CHAT_BODY }));
  await Promise.all(pending);
  const res = await handler(req('/api/me'));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.calls, 1);
  assert.ok(body.bytes > 0);
});
