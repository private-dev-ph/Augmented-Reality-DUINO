import test from 'node:test';
import assert from 'node:assert/strict';

import { eagleJoinPath } from '../src/parsers/eagle.js';

const point = (x, y) => ({ x, y });

test('joins rounded EAGLE Edge.Cuts endpoints into the UNO-SMD perimeter', () => {
  // Equivalent to UNOSMD_V3.brd layer 20, deliberately out of drawing order.
  // The left vertical segment ends 0.016 mm from the lower rounded corner.
  const segments = [
    [point(64.516, 53.34), point(66.04, 51.816)],
    [point(68.58, 5.08), point(66.04, 2.54)],
    [point(0, 52.34), point(1, 53.34)],
    [point(66.04, 1), point(65.04, 0)],
    [point(66.04, 51.816), point(66.04, 40.386)],
    [point(1, 53.34), point(64.516, 53.34)],
    [point(0, 52.324), point(0, 1.016)],
    [point(68.58, 37.846), point(68.58, 5.08)],
    [point(66.04, 40.386), point(68.58, 37.846)],
    [point(1, 0), point(0, 1)],
    [point(65.04, 0), point(1, 0)],
    [point(66.04, 2.54), point(66.04, 1)],
  ];

  const outline = eagleJoinPath(segments);

  assert.equal(outline.length, 13, 'all 12 Edge.Cuts segments should join');
  assert.deepEqual(outline[0], outline.at(-1), 'the board outline should be closed');
  assert.ok(outline.some(({ x, y }) => x === 0 && y <= 1.016), 'includes the top-left rounded corner');
  assert.ok(outline.some(({ x, y }) => x === 0 && y === 52.324), 'includes the lower-left rounded corner');
});
