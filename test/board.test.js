import test from 'node:test';
import assert from 'node:assert/strict';

import { allFeatures, boardStats, boardWarning, normalizeBoard, physicalBoardBounds } from '../src/model/board.js';
import { resolveConnectivity } from '../src/model/connectivity.js';
import { normalizeInspectionSequence, sequenceItemKey, serializeInspectionSequence } from '../src/model/inspection-sequence.js';
import { odbFeatureFile, odbUnitFactor } from '../src/parsers/odb.js';

test('normalizes overlayData and derives bounds from the board outline', () => {
  const board = normalizeBoard({
    overlayData: {
      name: 'demo',
      layers: [{ name: 'F.Cu', color: 'dc4949' }],
      boardOutline: [{ x: 2, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 9 }, { x: 2, y: 9 }],
      components: [{ refDes: 'R1', position: { x: 4, y: 6 } }],
      layerFeatures: { 'F.Cu': [{ type: 'line', points: [{ x: 2, y: 5 }, { x: 8, y: 5 }] }] },
    },
  });

  assert.equal(board.name, 'demo');
  assert.equal(board.layers[0].color, '#dc4949');
  assert.deepEqual(board.bounds, { minX: 2, minY: 4, maxX: 8, maxY: 9 });
  assert.equal(allFeatures(board).length, 1);
  assert.equal(allFeatures(board)[0].source, 'layer');
});

test('uses a valid outline box for physical board bounds and falls back safely', () => {
  const outlined = normalizeBoard({
    bounds: { minX: -30, minY: -30, maxX: 30, maxY: 30 },
    boardOutline: [{ x: 2, y: 4 }, { x: 8, y: 4 }, { x: 8, y: 9 }, { x: 2, y: 9 }],
  });
  assert.deepEqual(physicalBoardBounds(outlined), { minX: 2, minY: 4, maxX: 8, maxY: 9 });

  const fallback = normalizeBoard({
    bounds: { minX: 1, minY: 2, maxX: 11, maxY: 7 },
    boardOutline: [{ x: 4, y: 4 }, { x: 4, y: 4 }],
  });
  assert.deepEqual(physicalBoardBounds(fallback), { minX: 1, minY: 2, maxX: 11, maxY: 7 });
});

test('reports board summary and missing connectivity notes', () => {
  const board = normalizeBoard({
    layers: [{ name: 'F.Cu', function: 'CONDUCTOR' }],
    layerFeatures: { 'F.Cu': [{ type: 'line', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] },
    components: [{ pads: [{ drill: 0.8 }] }],
  });

  assert.deepEqual(boardStats(board), {
    name: '(unnamed)',
    units: 'MILLIMETER',
    layers: 1,
    components: 1,
    features: 1,
    nets: 0,
    drills: 1,
  });
  assert.match(boardWarning(board), /no netlist/i);
});

test('parses ODB++ line and polygon feature records', () => {
  const text = [
    'UNITS=MM',
    '$ 0 r1000',
    'L 0 0 10 0 0 P',
    'OB 0 0 I',
    'OS 10 0',
    'OS 10 10',
    'OS 0 10',
    'OE',
  ].join('\n');
  const parsed = odbFeatureFile(text, odbUnitFactor(text));

  assert.equal(odbUnitFactor(text), 1);
  assert.equal(parsed.features.length, 2);
  assert.equal(parsed.polygons[0].points.length, 4);
});

test('marks net geometry separately from raw layer artwork', () => {
  const board = normalizeBoard({
    layers: [{ name: 'F.Cu', function: 'CONDUCTOR' }],
    layerFeatures: { 'F.Cu': [{ type: 'line', points: [{ x: 0, y: 0 }, { x: 1, y: 0 }] }] },
    nets: [{ name: 'VIN', traces: [{ layer: 'F.Cu', points: [{ x: 0, y: 1 }, { x: 1, y: 1 }] }] }],
  });
  const features = allFeatures(board);

  assert.deepEqual(features.map((feature) => feature.source), ['layer', 'net']);
});

test('resolves component and net neighborhoods from pad connectivity', () => {
  const board = normalizeBoard({
    components: [
      { refDes: 'R1', pads: [{ name: '1', net: 'VIN' }, { name: '2', net: 'GND' }] },
      { refDes: 'C1', pads: [{ name: '1', net: 'VIN' }] },
      { refDes: 'U1', pads: [{ name: '1', net: 'GND' }] },
    ],
    nets: [{ name: 'VIN' }, { name: 'GND' }],
    netPads: {
      VIN: [{ element: 'R1', pad: '1' }, { element: 'C1', pad: '1' }],
      GND: [{ element: 'R1', pad: '2' }, { element: 'U1', pad: '1' }],
    },
  });

  const fromComponent = resolveConnectivity(board, { component: board.components[0] });
  assert.deepEqual([...fromComponent.nets].sort(), ['GND', 'VIN']);
  assert.deepEqual([...fromComponent.components].map((component) => component.refDes).sort(), ['C1', 'R1', 'U1']);

  const fromNet = resolveConnectivity(board, { net: 'VIN' });
  assert.deepEqual([...fromNet.components].map((component) => component.refDes).sort(), ['C1', 'R1']);
  assert.deepEqual([...fromNet.nets].sort(), ['GND', 'VIN']);
});

test('normalizes and serializes inspection sequences', () => {
  const sequence = normalizeInspectionSequence({
    name: 'Power inspection',
    items: [
      { type: 'component', refDes: 'R1', layer: 'F.Cu' },
      { type: 'component', refDes: 'R1', layer: 'F.Cu', pad: '2', padNet: 'GND' },
      { type: 'net', name: 'GND', layer: 'B.Cu' },
      { type: 'unknown', name: 'ignored' },
    ],
  });

  assert.equal(sequence.name, 'Power inspection');
  assert.deepEqual(sequence.items, [
    { type: 'Component', name: 'R1', layer: 'F.Cu' },
    { type: 'Component', name: 'R1', layer: 'F.Cu', pin: '2', pinNet: 'GND' },
    { type: 'Net', name: 'GND', layer: 'B.Cu' },
  ]);
  assert.equal(sequenceItemKey(sequence.items[0]), 'component:r1');
  assert.deepEqual(serializeInspectionSequence(sequence, 'UNO'), {
    version: 1,
    name: 'Power inspection',
    boardName: 'UNO',
    items: sequence.items,
  });
});
