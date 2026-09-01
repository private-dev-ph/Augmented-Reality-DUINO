import test from 'node:test';
import assert from 'node:assert/strict';

import { attachedArtworkProjectionBounds } from '../src/ar/projected-overlay.js';

test('attached artwork collar is based on the short side and bounded at twelve percent', () => {
  const physical = { minX: 0, minY: 0, maxX: 100, maxY: 50 };
  assert.deepEqual(attachedArtworkProjectionBounds(physical), {
    minX: -6,
    minY: -6,
    maxX: 106,
    maxY: 56,
  });
  assert.deepEqual(attachedArtworkProjectionBounds(physical, { maxCollarRatio: 0.5 }), {
    minX: -6,
    minY: -6,
    maxX: 106,
    maxY: 56,
  });
  assert.deepEqual(attachedArtworkProjectionBounds(physical, { maxCollarRatio: 0 }), physical);
});
