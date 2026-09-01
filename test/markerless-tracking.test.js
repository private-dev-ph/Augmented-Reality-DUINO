import test from 'node:test';
import assert from 'node:assert/strict';
import { computeHomography, isValidCalibrationQuad } from '../src/ar/four-corner-calibration.js';

function project(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

test('homography maps canonical board corners into a perspective camera quad', () => {
  const source = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 80 }, { x: 0, y: 80 }];
  const destination = [{ x: 16, y: 9 }, { x: 152, y: 24 }, { x: 131, y: 104 }, { x: 5, y: 88 }];
  const matrix = computeHomography(source, destination);
  assert.ok(matrix);
  source.forEach((point, index) => {
    const mapped = project(matrix, point);
    assert.ok(Math.hypot(mapped.x - destination[index].x, mapped.y - destination[index].y) < 1e-7);
  });
});

test('calibration rejects crossed, collapsed, and tiny corner selections', () => {
  assert.equal(isValidCalibrationQuad([{ x: 10, y: 10 }, { x: 150, y: 10 }, { x: 150, y: 90 }, { x: 10, y: 90 }]), true);
  assert.equal(isValidCalibrationQuad([{ x: 10, y: 10 }, { x: 150, y: 90 }, { x: 150, y: 10 }, { x: 10, y: 90 }]), false);
  assert.equal(isValidCalibrationQuad([{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 12 }, { x: 10, y: 12 }]), false);
  assert.equal(isValidCalibrationQuad([{ x: 10, y: 10 }, { x: 150, y: 10 }, { x: 150, y: 11 }, { x: 10, y: 11 }]), false);
});
