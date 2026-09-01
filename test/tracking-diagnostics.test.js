import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTrackingDiagnosticLog,
  mapDiagnosticPoints,
  stripDiagnosticPoints,
} from '../src/ar/tracking-diagnostics.js';

test('diagnostic logs are bounded and never retain visual point arrays', () => {
  let now = Date.parse('2026-08-29T00:00:00.000Z');
  const log = createTrackingDiagnosticLog({ limit: 2, clock: () => now });
  log.record('frame', { frameNumber: 1, points: { detected: [{ x: 0.2, y: 0.3 }] } });
  now += 10;
  log.record('frame', { frameNumber: 2, points: { inliers: [{ x: 0.4, y: 0.5 }] } });
  now += 10;
  log.record('state', { state: 'SUSPECT' });
  const snapshot = log.snapshot({ boardName: 'UNO' });
  assert.equal(snapshot.entries.length, 2);
  assert.equal(snapshot.entries[0].data.frameNumber, 2);
  assert.equal(Object.hasOwn(snapshot.entries[0].data, 'points'), false);
  assert.equal(snapshot.entries[1].data.state, 'SUSPECT');
  assert.equal(snapshot.context.boardName, 'UNO');
});

test('diagnostic point groups are mapped without mutating metrics', () => {
  const diagnostic = {
    frameNumber: 7,
    points: { detected: [{ x: 0.25, y: 0.5 }], invalid: [{ x: Number.NaN, y: 1 }] },
  };
  const mapped = mapDiagnosticPoints(diagnostic, (point) => ({ x: point.x * 200, y: point.y * 100 }));
  assert.deepEqual(mapped.points.detected, [{ x: 50, y: 50 }]);
  assert.deepEqual(mapped.points.invalid, []);
  assert.equal(mapped.frameNumber, 7);
  assert.deepEqual(stripDiagnosticPoints(diagnostic), { frameNumber: 7 });
});
