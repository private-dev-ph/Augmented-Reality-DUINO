import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCornerSmoother,
  displayPointToVideo,
  getCalibrationLoupePlacement,
  getLoupeSourceCrop,
  videoPointToDisplay,
} from '../src/ar/tracking-geometry.js';

test('covered video coordinate conversions round-trip through a portrait preview', () => {
  const video = { width: 1920, height: 1080 };
  const display = { width: 300, height: 600 };
  const original = { x: 74, y: 428 };
  const cameraPoint = displayPointToVideo(original, video, display);
  const roundTrip = videoPointToDisplay(cameraPoint, video, display);
  assert.ok(Math.abs(roundTrip.x - original.x) < 1e-8);
  assert.ok(Math.abs(roundTrip.y - original.y) < 1e-8);
});

test('loupe crop follows the portrait cover crop and keeps the selected point centred', () => {
  const crop = getLoupeSourceCrop(
    { x: 150, y: 300 },
    { width: 1920, height: 1080 },
    { width: 300, height: 600 },
    { zoom: 3, lensSize: 100 },
  );
  assert.ok(Math.abs(crop.videoPoint.x - 960) < 1e-8);
  assert.ok(Math.abs(crop.videoPoint.y - 540) < 1e-8);
  assert.ok(Math.abs(crop.source.width - 60) < 1e-8);
  assert.deepEqual(crop.center, { x: 50, y: 50 });
  assert.ok(Math.abs(crop.destination.x) < 1e-8);
  assert.ok(Math.abs(crop.destination.y) < 1e-8);
});

test('loupe crop clips at an intrinsic edge without shifting its target', () => {
  const crop = getLoupeSourceCrop(
    { x: 0, y: 180 },
    { width: 1920, height: 1080 },
    { width: 640, height: 360 },
    { zoom: 3, lensSize: 100 },
  );
  assert.equal(crop.videoPoint.x, 0);
  assert.equal(crop.source.x, 0);
  assert.ok(crop.source.width < crop.requested.width);
  assert.ok(crop.destination.x > 0);
  assert.equal(crop.destination.x + crop.destination.width, 100);
});

test('loupe placement stays within a mobile overlay and avoids the active pointer', () => {
  const overlay = { width: 390, height: 844 };
  for (const point of [{ x: 10, y: 10 }, { x: 380, y: 820 }, { x: 195, y: 422 }]) {
    const placement = getCalibrationLoupePlacement(point, overlay, 100, 'touch');
    assert.ok(placement.left >= 8 && placement.top >= 8);
    assert.ok(placement.left + placement.width <= overlay.width - 8);
    assert.ok(placement.top + placement.height <= overlay.height - 8);
    const overlaps = point.x >= placement.left && point.x <= placement.left + placement.width
      && point.y >= placement.top && point.y <= placement.top + placement.height;
    assert.equal(overlaps, false);
  }
});

test('corner smoother reduces small pose jitter without rejecting valid poses', () => {
  const smoother = createCornerSmoother();
  const baseline = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 70 }, { x: 10, y: 70 }];
  smoother.filter(baseline, 0);
  const noisy = [{ x: 13, y: 8 }, { x: 103, y: 8 }, { x: 103, y: 68 }, { x: 13, y: 68 }];
  const filtered = smoother.filter(noisy, 110);
  assert.ok(filtered[0].x > baseline[0].x && filtered[0].x < noisy[0].x);
  assert.ok(filtered[0].y > noisy[0].y && filtered[0].y < baseline[0].y);
});

test('corner smoother applies one coherent gain to the complete board pose', () => {
  const smoother = createCornerSmoother();
  const baseline = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 70 }, { x: 10, y: 70 }];
  const moved = [{ x: 14, y: 8 }, { x: 106, y: 13 }, { x: 108, y: 76 }, { x: 7, y: 74 }];
  smoother.filter(baseline, 0);
  const filtered = smoother.filter(moved, 100, 0.8);
  const gains = [];
  for (let index = 0; index < moved.length; index += 1) {
    for (const axis of ['x', 'y']) {
      const delta = moved[index][axis] - baseline[index][axis];
      if (Math.abs(delta) > 1e-9) gains.push((filtered[index][axis] - baseline[index][axis]) / delta);
    }
  }
  assert.ok(gains.every((gain) => Math.abs(gain - gains[0]) < 1e-10));
});
