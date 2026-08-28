import test from 'node:test';
import assert from 'node:assert/strict';
import jsfeat from '@webarkit/jsfeat-next';

test('RANSAC homography recovers a planar board translation from noisy correspondences', () => {
  const source = [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 70 }, { x: 0, y: 70 },
    { x: 40, y: 20 }, { x: 20, y: 50 }, { x: 70, y: 45 }, { x: 55, y: 12 },
  ];
  const destination = source.map((point) => ({ x: point.x + 12, y: point.y + 8 }));
  destination.push({ x: 220, y: -80 });
  source.push({ x: 10, y: 35 });
  const params = new jsfeat.ransac_params_t(4, 2, 0.65, 0.995);
  // jsfeat's RANSAC samples random minimal sets. Retry a few bounded attempts
  // so this unit test verifies the estimator rather than occasionally failing
  // because its first sample contains the intentional outlier.
  let found = false;
  let model;
  let mask;
  for (let attempt = 0; attempt < 4 && !found; attempt += 1) {
    model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
    mask = new jsfeat.matrix_t(source.length, 1, jsfeat.U8_t | jsfeat.C1_t);
    found = jsfeat.motion_estimator.ransac(params, jsfeat.homography2d, source, destination, source.length, model, mask, 600);
  }
  assert.equal(found, true);
  assert.ok(Math.abs(model.data[2] - 12) < 0.15);
  assert.ok(Math.abs(model.data[5] - 8) < 0.15);
  assert.ok(Array.from(mask.data.slice(0, source.length)).filter(Boolean).length >= 7);
});
