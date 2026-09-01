import test from 'node:test';
import assert from 'node:assert/strict';

function makeContext() {
  const operations = [];
  const context = {
    operations,
    globalAlpha: 1,
    strokeStyle: '#000',
    fillStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    save() { operations.push({ type: 'save' }); },
    restore() { operations.push({ type: 'restore' }); },
    beginPath() { operations.push({ type: 'beginPath' }); },
    closePath() { operations.push({ type: 'closePath' }); },
    moveTo(x, y) { operations.push({ type: 'moveTo', x, y }); },
    lineTo(x, y) { operations.push({ type: 'lineTo', x, y }); },
    arc(x, y, radius) { operations.push({ type: 'arc', x, y, radius, alpha: this.globalAlpha }); },
    ellipse(x, y, radiusX, radiusY) { operations.push({ type: 'ellipse', x, y, radiusX, radiusY, alpha: this.globalAlpha }); },
    rect(x, y, width, height) { operations.push({ type: 'rect', x, y, width, height }); },
    fill() { operations.push({ type: 'fill', style: this.fillStyle, alpha: this.globalAlpha }); },
    stroke() { operations.push({ type: 'stroke', style: this.strokeStyle, alpha: this.globalAlpha }); },
    fillRect(x, y, width, height) { operations.push({ type: 'fillRect', x, y, width, height, style: this.fillStyle, alpha: this.globalAlpha }); },
    strokeRect(x, y, width, height) { operations.push({ type: 'strokeRect', x, y, width, height, style: this.strokeStyle, alpha: this.globalAlpha }); },
    fillText(text, x, y) { operations.push({ type: 'fillText', text, x, y, style: this.fillStyle, alpha: this.globalAlpha }); },
    measureText(text) { return { width: String(text).length * 6 }; },
    translate(x, y) { operations.push({ type: 'translate', x, y }); },
    rotate(angle) { operations.push({ type: 'rotate', angle }); },
    setLineDash(value) { operations.push({ type: 'setLineDash', value }); },
    clearRect(x, y, width, height) { operations.push({ type: 'clearRect', x, y, width, height }); },
    drawImage() { operations.push({ type: 'drawImage' }); },
  };
  return context;
}

function makeCanvas() {
  const context = makeContext();
  return {
    width: 100,
    height: 100,
    getContext() { return context; },
    context,
  };
}

let currentTheme = 'light';

function installDom() {
  globalThis.document = {
    documentElement: { dataset: { get mode() { return currentTheme; } } },
    createElement() { return makeCanvas(); },
  };
  globalThis.getComputedStyle = () => ({
    getPropertyValue(name) {
      const tokens = currentTheme === 'dark'
        ? {
          '--canvas-bg': '#302d29', '--accent': '#e85a4f', '--text': '#fff7eb', '--border': '#4c453c',
          '--sequence-selection': '#ff70c8', '--sequence-selection-fill': 'rgba(255, 112, 200, .36)',
          '--selected-net': '#ffe66d', '--connected-net': '#59d8ff', '--connected-component': '#59d8ff',
          '--unfocused-net': '#8d867d', '--unfocused-net-opacity': '.10',
        }
        : {
          '--canvas-bg': '#dedbd4', '--accent': '#e85a4f', '--text': '#343535', '--border': '#d8d2c7',
          '--sequence-selection': '#6f2dbd', '--sequence-selection-fill': 'rgba(111, 45, 189, .30)',
          '--selected-net': '#a45b00', '--connected-net': '#007f8b', '--connected-component': '#007f8b',
          '--unfocused-net': '#6f6b65', '--unfocused-net-opacity': '.08',
        };
      return tokens[name] || '';
    },
  });
}

function component(refDes, x, y) {
  return {
    refDes,
    position: { x, y },
    layer: 'F.Cu',
    outline: [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }],
    pads: [{ name: '1', x: 0, y: 0, width: 1, height: 1 }],
  };
}

function makeBoard(selectedComponent, selectedNet) {
  const first = component('U1', 3, 5);
  const second = component('U2', 7, 5);
  const third = component('U3', 5, 8);
  return {
    name: 'isolation-fixture',
    bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
    outline: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    boardCutouts: [],
    components: [first, second, third],
    drills: [{ x: 9, y: 9, diameter: 1 }],
    layers: [{ name: 'F.Cu', color: '#d44', function: 'CONDUCTOR' }],
    layerMap: new Map([['F.Cu', { name: 'F.Cu', color: '#d44', function: 'CONDUCTOR' }]]),
    layerFeatures: { 'F.Cu': [] },
    renderFeatures: [
      { source: 'net', type: 'poly', net: 'N1', layer: 'F.Cu', points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }] },
      { source: 'net', type: 'poly', net: 'N2', layer: 'F.Cu', points: [{ x: 8, y: 1 }, { x: 9, y: 1 }, { x: 9, y: 2 }] },
    ],
    traceGroups: [
      { sample: { source: 'net', type: 'segment', net: 'N1', layer: 'F.Cu', width: 0.2 }, paths: [[{ x: 1, y: 3 }, { x: 3, y: 3 }]] },
      { sample: { source: 'net', type: 'segment', net: 'N2', layer: 'F.Cu', width: 0.2 }, paths: [[{ x: 7, y: 3 }, { x: 9, y: 3 }]] },
    ],
    _fixtureComponents: { first, second, third },
    _selectedComponent: selectedComponent,
    _selectedNet: selectedNet,
  };
}

function makeState(board) {
  return {
    data: board,
    layers: new Map([['F.Cu', true]]),
    selected: board._selectedComponent || null,
    selectedNet: board._selectedNet || null,
    connectivity: { components: new Set(), nets: new Set() },
    sequence: { active: true, activePin: '1', index: 0, items: [] },
    view: {
      grid: true,
      showComponents: true,
      showFootprints: true,
      showLabels: true,
      showNetLabels: true,
      showPinoutNames: true,
      showInTraceNetNames: true,
      showOutline: true,
      highlightConnectivity: true,
      showCopper: true,
    },
    viewport: { dpr: 1, scale: 10, offsetX: 0, offsetY: 0, center: { x: 5, y: 5 } },
  };
}

function makeViewport() {
  return {
    screenSize: () => ({ w: 100, h: 100 }),
    screen: (value) => ({ x: value.x * 10, y: 100 - value.y * 10 }),
    world: (x, y) => ({ x: x / 10, y: (100 - y) / 10 }),
  };
}

const { createBoardRenderer } = await (async () => {
  installDom();
  return import('../src/render/board-renderer.js');
})();

test('normal render still draws board outline and unrelated content', () => {
  const board = makeBoard(null, null);
  const state = makeState(board);
  state.connectivity.components.add(board._fixtureComponents.second);
  state.connectivity.nets.add('N1');
  const canvas = makeCanvas();
  const renderer = createBoardRenderer({ canvas, state, viewport: makeViewport() });
  renderer.render();
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'stroke' && operation.style === '#343535'));
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U1'));
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U2'));
});

test('isolated component retains only selected artwork at full alpha', () => {
  const board = makeBoard(null, null);
  board._selectedComponent = board._fixtureComponents.first;
  const state = makeState(board);
  state.connectivity.components.add(board._fixtureComponents.second);
  state.connectivity.nets.add('N1');
  const canvas = makeCanvas();
  const renderer = createBoardRenderer({ canvas, state, viewport: makeViewport() });
  renderer.render({ isolateSequenceSelection: true });
  const operations = canvas.context.operations;
  assert.ok(operations.some((operation) => operation.type === 'fillText' && operation.text === 'U1'));
  assert.ok(operations.some((operation) => operation.type === 'fillText' && operation.text === 'U2'));
  assert.ok(!operations.some((operation) => operation.type === 'fillText' && operation.text === 'U3'));
  assert.ok(operations.some((operation) => operation.type === 'moveTo' && operation.x === 10));
  assert.ok(!operations.some((operation) => operation.type === 'moveTo' && operation.x === 80));
  assert.ok(!operations.some((operation) => operation.type === 'stroke' && operation.style === '#343535'));
  assert.ok(!operations.some((operation) => operation.type === 'drawImage'));
  assert.ok(operations.filter((operation) => ['fill', 'stroke', 'fillRect', 'strokeRect', 'fillText'].includes(operation.type))
    .filter((operation) => operation.type !== 'fillRect' || operation.y !== 0)
    .every((operation) => operation.alpha === undefined || operation.alpha === 1));
});

test('isolated net retains only matching geometry at full alpha', () => {
  const board = makeBoard(null, 'N1');
  const state = makeState(board);
  state.connectivity.components.add(board._fixtureComponents.second);
  state.connectivity.nets.add('N1');
  state.connectivity.nets.add('N2');
  const canvas = makeCanvas();
  const renderer = createBoardRenderer({ canvas, state, viewport: makeViewport() });
  renderer.render({ isolateSequenceSelection: true });
  const strokes = canvas.context.operations.filter((operation) => operation.type === 'stroke');
  assert.ok(strokes.length > 0);
  assert.ok(strokes.every((operation) => operation.alpha === 1));
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'moveTo' && operation.x === 10));
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'moveTo' && operation.x === 80));
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U2'));
  assert.ok(!canvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U1'));
  assert.ok(!canvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U3'));
});

test('dark theme keeps sequence component and selected/connected net colors distinct', () => {
  currentTheme = 'dark';
  const componentBoard = makeBoard(null, null);
  componentBoard._selectedComponent = componentBoard._fixtureComponents.first;
  const componentState = makeState(componentBoard);
  componentState.connectivity.components.add(componentBoard._fixtureComponents.second);
  componentState.connectivity.nets.add('N1');
  const componentCanvas = makeCanvas();
  createBoardRenderer({ canvas: componentCanvas, state: componentState, viewport: makeViewport() })
    .render({ isolateSequenceSelection: true });
  assert.ok(componentCanvas.context.operations.some((operation) => operation.type === 'fillText' && operation.text === 'U1' && operation.style === '#ff70c8'));
  assert.ok(componentCanvas.context.operations.some((operation) => operation.type === 'stroke' && operation.style === '#ff70c8'));

  const netBoard = makeBoard(null, 'N1');
  const netState = makeState(netBoard);
  netState.connectivity.components.add(netBoard._fixtureComponents.second);
  netState.connectivity.nets.add('N1');
  netState.connectivity.nets.add('N2');
  const netCanvas = makeCanvas();
  createBoardRenderer({ canvas: netCanvas, state: netState, viewport: makeViewport() })
    .render({ isolateSequenceSelection: true });
  assert.ok(netCanvas.context.operations.some((operation) => operation.type === 'stroke' && operation.style === '#ffe66d'));
  assert.ok(netCanvas.context.operations.some((operation) => operation.type === 'stroke' && operation.style === '#59d8ff'));
  currentTheme = 'light';
});

test('light connectivity focus mutes unconnected net geometry with the theme token', () => {
  currentTheme = 'light';
  const board = makeBoard(null, 'N1');
  const state = makeState(board);
  state.connectivity.nets.add('N1');
  const canvas = makeCanvas();
  createBoardRenderer({ canvas, state, viewport: makeViewport() }).render();
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'stroke'
    && operation.style === '#6f6b65' && operation.alpha === 0.08));
  assert.ok(!canvas.context.operations.some((operation) => operation.type === 'stroke'
    && operation.style === '#d44' && operation.alpha === 0.08));
});

test('normal render after isolated render uses the complete cached board frame', () => {
  const board = makeBoard(null, null);
  const state = makeState(board);
  const canvas = makeCanvas();
  const renderer = createBoardRenderer({ canvas, state, viewport: makeViewport() });
  renderer.render();
  const initialNormalOperations = canvas.context.operations.length;
  state.selected = board._fixtureComponents.first;
  renderer.render({ isolateSequenceSelection: true });
  state.selected = null;
  canvas.context.operations.length = 0;
  renderer.render();
  assert.ok(canvas.context.operations.some((operation) => operation.type === 'drawImage'));
  assert.ok(canvas.context.operations.length < initialNormalOperations);
});
