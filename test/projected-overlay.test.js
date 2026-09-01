import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attachedArtworkProjectionBounds,
  DEFAULT_PROJECTED_OVERLAY_OPACITY,
  normalizeOverlayOpacity,
} from '../src/ar/projected-overlay.js';

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

test('projector preserves full source opacity at the 100% setting', () => {
  assert.equal(DEFAULT_PROJECTED_OVERLAY_OPACITY, 1);
  assert.equal(normalizeOverlayOpacity(1), 1);
  assert.equal(normalizeOverlayOpacity(1.5), 1);
  assert.equal(normalizeOverlayOpacity(-0.2), 0);
});
