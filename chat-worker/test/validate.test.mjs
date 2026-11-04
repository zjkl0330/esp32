import assert from 'node:assert/strict';
import test from 'node:test';

import { parseChatRequest } from '../dist/openai/validate.js';
import { GatewayError } from '../dist/openai/errors.js';

function expectCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof GatewayError, `expected GatewayError, got ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected code ${code}`);
}

test('accepts a normal request', () => {
  const req = parseChatRequest({
    model: 'kilo/kilo-auto/free',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    stream: true,
    temperature: 0.5,
    max_tokens: 128,
    stop: ['\n\n'],
  });
  assert.equal(req.model, 'kilo/kilo-auto/free');
  assert.equal(req.stream, true);
  assert.equal(req.messages.length, 2);
  assert.equal(req.max_tokens, 128);
});

test('developer role maps to system', () => {
  const req = parseChatRequest({
    model: 'kilo/x',
    messages: [{ role: 'developer', content: 'd' }],
  });
  assert.equal(req.messages[0].role, 'system');
});

test('rejects tools', () => {
  expectCode(
    () =>
      parseChatRequest({
        model: 'kilo/x',
        messages: [{ role: 'user', content: 'hi' }],
        tools: [{ type: 'function', function: { name: 'f' } }],
      }),
    'unsupported_parameter'
  );
});

test('rejects multimodal content arrays', () => {
  expectCode(
    () =>
      parseChatRequest({
        model: 'kilo/x',
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }],
      }),
    'unsupported_parameter'
  );
});

test('rejects n > 1', () => {
  expectCode(
    () => parseChatRequest({ model: 'kilo/x', messages: [{ role: 'user', content: 'hi' }], n: 2 }),
    'unsupported_parameter'
  );
});

test('rejects max_tokens over 4096', () => {
  expectCode(
    () =>
      parseChatRequest({
        model: 'kilo/x',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 5000,
      }),
    'invalid_request'
  );
});

test('rejects bad temperature', () => {
  expectCode(
    () =>
      parseChatRequest({
        model: 'kilo/x',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 3,
      }),
    'invalid_request'
  );
});

test('rejects stream_options without stream', () => {
  expectCode(
    () =>
      parseChatRequest({
        model: 'kilo/x',
        messages: [{ role: 'user', content: 'hi' }],
        stream_options: { include_usage: true },
      }),
    'invalid_request'
  );
});

test('rejects non-string content', () => {
  expectCode(
    () => parseChatRequest({ model: 'kilo/x', messages: [{ role: 'user', content: 42 }] }),
    'invalid_request'
  );
});
