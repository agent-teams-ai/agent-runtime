import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Normalizer } from '../../../../src/features/provider-session-implementation/adapters/claude-sdk/normalize.ts';

test('malformed native message identity cannot invoke coercion or inherit the previous stream', () => {
  const normalizer = new Normalizer(1024); let coercions = 0;
  normalizer.normalize({ type: 'stream_event', event: { type: 'message_start', message: { id: 'previous' } } });
  const identity = { toString: () => { coercions++; throw new Error('untrusted coercion'); } };
  assert.deepEqual(normalizer.normalize({ type: 'stream_event',
    event: { type: 'message_start', message: { id: identity } },
  }), { facts: [] });
  assert.deepEqual(normalizer.normalize({ type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'unattributed' } },
  }), { facts: [] });
  assert.equal(coercions, 0);
});
