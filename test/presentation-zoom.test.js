import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getPinchPresentationTransform,
  invertPresentationPoint,
} from '../src/ar/presentation-zoom.js';

test('presentation pinch zoom accumulates from the gesture-start baseline', () => {
  const first = getPinchPresentationTransform({
    baseScale: 1,
    baseTx: 0,
    baseTy: 0,
    startDistance: 100,
    currentDistance: 200,
    startMidpoint: { x: 100, y: 80 },
    currentMidpoint: { x: 100, y: 80 },
    width: 300,
    height: 200,
  });
  const second = getPinchPresentationTransform({
    baseScale: 1,
    baseTx: 0,
    baseTy: 0,
    startDistance: 100,
    currentDistance: 300,
    startMidpoint: { x: 100, y: 80 },
    currentMidpoint: { x: 100, y: 80 },
    width: 300,
    height: 200,
  });
  assert.equal(first.scale, 2);
  assert.equal(second.scale, 3);
  assert.ok(second.tx < first.tx);
  assert.ok(second.ty < first.ty);
});

test('presentation zoom follows midpoint and clamps translation to the viewport', () => {
  const transform = getPinchPresentationTransform({
    baseScale: 1,
    startDistance: 100,
    currentDistance: 500,
    startMidpoint: { x: 120, y: 90 },
    currentMidpoint: { x: 260, y: 180 },
    width: 300,
    height: 200,
  });
  assert.equal(transform.scale, 4);
  assert.ok(transform.tx <= 0 && transform.tx >= -900);
  assert.ok(transform.ty <= 0 && transform.ty >= -600);
  assert.deepEqual(invertPresentationPoint({ x: 100, y: 80 }, { scale: 2, tx: -100, ty: -80 }), { x: 100, y: 80 });
});

test('a second pinch inherits the existing scale and translation', () => {
  const transform = getPinchPresentationTransform({
    baseScale: 2,
    baseTx: -150,
    baseTy: -80,
    startDistance: 100,
    currentDistance: 150,
    startMidpoint: { x: 100, y: 80 },
    currentMidpoint: { x: 100, y: 80 },
    width: 300,
    height: 200,
  });
  assert.deepEqual(transform, { scale: 3, tx: -275, ty: -160 });
});
