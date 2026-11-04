import assert from 'node:assert/strict';
import test from 'node:test';

import { solveDeepSeekPow } from '../dist/providers/deepseek-pow.js';

test('DeepSeek PoW WASM matches the reference answer', async () => {
  const config = {
    algorithm: 'DeepSeekHashV1',
    challenge: 'b0000b22959bad0cc1ecbbfa07f97191b20332fa10d7341ff9c7ba6e7ed927f1',
    salt: 'dde3ed472be5a2494ee0',
    difficulty: 144000,
    expire_at: 1777057596443,
    signature: 'test',
    target_path: '/api/v0/chat/completion',
  };
  const token = await solveDeepSeekPow(config);
  const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
  assert.equal(decoded.answer, 58033);
  assert.equal(decoded.challenge, config.challenge);
  assert.equal(decoded.target_path, '/api/v0/chat/completion');
});
