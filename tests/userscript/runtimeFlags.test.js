import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldUseInlineWorker } from '../../src/userscript/runtimeFlags.js';

test('shouldUseInlineWorker should be disabled by default in userscript', () => {
  const env = {
    Worker: function Worker() {},
    Blob: function Blob() {}
  };
  assert.equal(shouldUseInlineWorker('worker-code', env), false);
});

test('shouldUseInlineWorker should allow force enable with prerequisites', () => {
  const env = {
    __GWR_FORCE_INLINE_WORKER__: true,
    Worker: function Worker() {},
    Blob: function Blob() {}
  };
  assert.equal(shouldUseInlineWorker('worker-code', env), true);
});

test('shouldUseInlineWorker should reject when worker prerequisites are missing', () => {
  const env = {
    __GWR_FORCE_INLINE_WORKER__: true,
    Worker: function Worker() {}
  };
  assert.equal(shouldUseInlineWorker('worker-code', env), false);
  assert.equal(shouldUseInlineWorker('', { __GWR_FORCE_INLINE_WORKER__: true, Worker: function Worker() {}, Blob: function Blob() {} }), false);
});
