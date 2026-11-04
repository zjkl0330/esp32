import assert from 'node:assert/strict';
import test from 'node:test';

import {
  jsonCompletionToSse,
  plainTextToSse,
  rewriteSseStream,
  rewriteSseText,
} from '../dist/openai/sse.js';

function streamFrom(chunks) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

test('rewriteSseText rewrites model and keeps [DONE]', () => {
  const input =
    'data: {"id":"x","model":"stealth/glyph-cluster","choices":[{"delta":{"content":"hi"}}]}\n\n' +
    'data: [DONE]\n\n';
  const out = rewriteSseText(input, 'kilo/kilo-auto/free');
  assert.match(out, /"model":"kilo\/kilo-auto\/free"/);
  assert.doesNotMatch(out, /stealth\/glyph-cluster/);
  assert.match(out, /data: \[DONE\]/);
});

test('rewriteSseStream handles events split across chunks', async () => {
  const input = streamFrom([
    'data: {"id":"x","model":"stealth/glyph-cluster",',
    '"choices":[{"delta":{"content":"你"}}]}\n',
    '\ndata: [DONE]\n\n',
  ]);
  const out = await new Response(rewriteSseStream(input, 'kilo/test-model')).text();
  assert.match(out, /"model":"kilo\/test-model"/);
  assert.match(out, /"content":"你"/);
  assert.match(out, /data: \[DONE\]/);
});

test('rewriteSseStream preserves non-data lines and invalid JSON data', async () => {
  const input = streamFrom([
    ': keepalive\n',
    '\n',
    'event: custom\n',
    'data: not-json\n',
    '\n',
  ]);
  const out = await new Response(rewriteSseStream(input, 'kilo/test-model')).text();
  assert.match(out, /: keepalive/);
  assert.match(out, /event: custom/);
  assert.match(out, /data: not-json/);
});

test('jsonCompletionToSse converts a non-stream completion', () => {
  const sse = jsonCompletionToSse(
    {
      id: 'chatcmpl-1',
      created: 1762000000,
      choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    },
    'kilo/kilo-auto/free'
  );
  assert.match(sse, /"content":"你好"/);
  assert.match(sse, /"finish_reason":"stop"/);
  assert.match(sse, /"model":"kilo\/kilo-auto\/free"/);
  assert.match(sse, /"total_tokens":5/);
  assert.match(sse, /data: \[DONE\]/);
});

test('plainTextToSse wraps plain text', () => {
  const sse = plainTextToSse('raw answer', 'kilo/test-model');
  assert.match(sse, /"content":"raw answer"/);
  assert.match(sse, /data: \[DONE\]/);
});
