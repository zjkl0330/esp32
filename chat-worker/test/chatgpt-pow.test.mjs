import assert from 'node:assert/strict';
import test from 'node:test';

import { solveChatGptPoW } from '../dist/providers/chatgpt.js';

// 固定向量来自 chat2api proofofWork.py 的同构 Python 实现：
// seed=0.123456, diff=0fffff, i=15
test('chatgpt PoW matches the reference Python vector', () => {
  const config = [
    3000,
    'Fri Nov 06 2026 15:00:00 GMT-0500 (Eastern Standard Time)',
    4294705152,
    0,
    'UA',
    'https://chatgpt.com/backend-api/sentinel/sdk.js',
    'dpl-test',
    'en-US',
    'en-US,es-US,en,es',
    0,
    'webdriver−false',
    'location',
    'window',
    123.456,
    'uuid',
    '',
    8,
    0,
  ];
  const result = solveChatGptPoW('0.123456', '0fffff', config);
  assert.equal(result.solved, true);
  assert.equal(
    result.answer,
    'WzMwMDAsIkZyaSBOb3YgMDYgMjAyNiAxNTowMDowMCBHTVQtMDUwMCAoRWFzdGVybiBTdGFuZGFyZCBUaW1lKSIsNDI5NDcwNTE1MiwxNSwiVUEiLCJodHRwczovL2NoYXRncHQuY29tL2JhY2tlbmQtYXBpL3NlbnRpbmVsL3Nkay5qcyIsImRwbC10ZXN0IiwiZW4tVVMiLCJlbi1VUyxlcy1VUyxlbixlcyIsNywid2ViZHJpdmVy4oiSZmFsc2UiLCJsb2NhdGlvbiIsIndpbmRvdyIsMTIzLjQ1NiwidXVpZCIsIiIsOCwwXQ=='
  );
});
