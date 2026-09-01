import test from 'node:test';
import assert from 'node:assert/strict';

import { invertHomography, projectPoint, unprojectPoint } from '../src/ar/four-corner-calibration.js';

test('homography projection and inverse round-trip preserve perspective points', () => {
  const matrix = [1.08, 0.12, 18, -0.08, 0.94, 26, 0.0007, -0.0004, 1];
  const source = { x: 42, y: 17 };
  const projected = projectPoint(matrix, source);
  assert.ok(projected);
  const restored = unprojectPoint(matrix, projected);
  assert.ok(restored);
  assert.ok(Math.abs(restored.x - source.x) < 1e-8);
  assert.ok(Math.abs(restored.y - source.y) < 1e-8);
  assert.ok(invertHomography(matrix));
});

test('singular, non-finite, and invalid homographies are rejected safely', () => {
  assert.equal(invertHomography([1, 2, 3, 2, 4, 6, 0, 0, 0]), null);
  assert.equal(invertHomography([1, 2, 3, 4, 5, Number.NaN, 7, 8, 9]), null);
  assert.equal(projectPoint([1, 2, 3], { x: 1, y: 2 }), null);
  assert.equal(unprojectPoint([1, 2, 3, 2, 4, 6, 0, 0, 0], { x: 1, y: 2 }), null);
});
