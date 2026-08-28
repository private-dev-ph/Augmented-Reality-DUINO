import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCornerSmoother,
  displayPointToVideo,
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

test('corner smoother reduces small pose jitter without rejecting valid poses', () => {
  const smoother = createCornerSmoother();
  const baseline = [{ x: 10, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 70 }, { x: 10, y: 70 }];
  smoother.filter(baseline, 0);
  const noisy = [{ x: 13, y: 8 }, { x: 103, y: 8 }, { x: 103, y: 68 }, { x: 13, y: 68 }];
  const filtered = smoother.filter(noisy, 110);
  assert.ok(filtered[0].x > baseline[0].x && filtered[0].x < noisy[0].x);
  assert.ok(filtered[0].y > noisy[0].y && filtered[0].y < baseline[0].y);
});
