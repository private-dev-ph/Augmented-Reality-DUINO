import { box, num } from '../model/board.js';

const EAGLE_FIXED_LAYERS = {
  '1': { name: 'F.Cu', function: 'CONDUCTOR', side: 'TOP', color: '#dc4949' },
  '16': { name: 'B.Cu', function: 'CONDUCTOR', side: 'BOTTOM', color: '#3988c0' },
  '17': { name: 'Pads', function: 'OTHER', side: 'ALL', color: '#f0c95a' },
  '18': { name: 'Vias', function: 'OTHER', side: 'ALL', color: '#d9a441' },
  '20': { name: 'Edge.Cuts', function: 'BOARD_OUTLINE', side: 'ALL', color: '#ffffff' },
  '21': { name: 'F.Fab', function: 'FAB', side: 'TOP', color: '#b78cff' },
  '22': { name: 'B.Fab', function: 'FAB', side: 'BOTTOM', color: '#b78cff' },
  '25': { name: 'F.Silkscreen', function: 'SILKSCREEN', side: 'TOP', color: '#f5f5f5' },
  '26': { name: 'B.Silkscreen', function: 'SILKSCREEN', side: 'BOTTOM', color: '#f5f5f5' },
  '27': { name: 'F.Silkscreen', function: 'SILKSCREEN', side: 'TOP', color: '#f5f5f5' },
  '28': { name: 'B.Silkscreen', function: 'SILKSCREEN', side: 'BOTTOM', color: '#f5f5f5' },
  '29': { name: 'F.Mask', function: 'SOLDERMASK', side: 'TOP', color: '#3caf56' },
  '30': { name: 'B.Mask', function: 'SOLDERMASK', side: 'BOTTOM', color: '#8c4dc4' },
  '31': { name: 'F.Paste', function: 'SOLDERPASTE', side: 'TOP', color: '#f3b34c' },
  '32': { name: 'B.Paste', function: 'SOLDERPASTE', side: 'BOTTOM', color: '#f3b34c' },
  '44': { name: 'Drills', function: 'DRILL', side: 'ALL', color: '#d4d4d4' },
  '45': { name: 'Holes', function: 'DRILL', side: 'ALL', color: '#d4d4d4' },
  '46': { name: 'Milling', function: 'BOARD_OUTLINE', side: 'ALL', color: '#ffffff' },
  '51': { name: 'F.Fab', function: 'FAB', side: 'TOP', color: '#b78cff' },
  '52': { name: 'B.Fab', function: 'FAB', side: 'BOTTOM', color: '#b78cff' },
};

function eagleAttr(node, name, fallback = '') {
  return node?.getAttribute(name) ?? fallback;
}

function eagleLayerInfo(number, rawName) {
  const key = String(number);
  const raw = String(rawName || '');
  if (EAGLE_FIXED_LAYERS[key]) return { ...EAGLE_FIXED_LAYERS[key], number: key, rawName: raw };

  const lower = raw.toLowerCase();
  if (lower === 'top') return { ...EAGLE_FIXED_LAYERS['1'], number: key, rawName: raw };
  if (lower === 'bottom') return { ...EAGLE_FIXED_LAYERS['16'], number: key, rawName: raw };
  if (lower === 'dimension') return { ...EAGLE_FIXED_LAYERS['20'], number: key, rawName: raw };
  if (lower.includes('silk') || lower.includes('name') || lower.includes('value')) {
    return { name: `Eagle:${raw}`, function: 'SILKSCREEN', side: lower.startsWith('b') ? 'BOTTOM' : 'TOP', color: '#f5f5f5', number: key, rawName: raw };
  }
  if (lower.includes('stop') || lower.includes('mask')) {
    return { name: `Eagle:${raw}`, function: 'SOLDERMASK', side: lower.startsWith('b') ? 'BOTTOM' : 'TOP', color: '#3caf56', number: key, rawName: raw };
  }
  if (lower.includes('cream') || lower.includes('paste')) {
    return { name: `Eagle:${raw}`, function: 'SOLDERPASTE', side: lower.startsWith('b') ? 'BOTTOM' : 'TOP', color: '#f3b34c', number: key, rawName: raw };
  }
  return { name: raw ? `Eagle:${raw}` : `Eagle:${key}`, function: 'OTHER', side: 'ALL', color: '#9aa4b2', number: key, rawName: raw };
}

function eagleDoc(text) {
  const doc = new DOMParser().parseFromString(String(text || ''), 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('Invalid EAGLE XML.');
  const board = doc.querySelector('drawing > board') || doc.querySelector('board');
  if (!board) throw new Error('EAGLE board element not found.');
  return { doc, board };
}

function eagleNum(value, fallback = 0) {
  return num(value, fallback);
}

function eaglePoints(node) {
  return Array.from(node?.children || [])
    .filter((child) => child.tagName === 'vertex')
    .map((vertex) => ({ x: eagleNum(eagleAttr(vertex, 'x')), y: eagleNum(eagleAttr(vertex, 'y')) }));
}

function eagleCirclePoints(x, y, radius) {
  const points = [];
  for (let index = 0; index <= 32; index += 1) {
    const angle = Math.PI * 2 * index / 32;
    points.push({ x: x + radius * Math.cos(angle), y: y + radius * Math.sin(angle) });
  }
  return points;
}

function eagleJoinPath(segments) {
  if (!segments.length) return [];
  const unused = segments.map((segment) => segment.slice());
  const path = [...unused.shift()];
  const same = (first, second) => Math.hypot(first.x - second.x, first.y - second.y) < 0.001;
  let current = path[path.length - 1];

  for (let guard = 0; guard < segments.length * 2; guard += 1) {
    const index = unused.findIndex((segment) => same(segment[0], current) || same(segment[segment.length - 1], current));
    if (index < 0) break;
    let next = unused.splice(index, 1)[0];
    if (same(next[next.length - 1], current)) next = next.reverse();
    path.push(...next.slice(1));
    current = path[path.length - 1];
    if (same(current, path[0])) break;
  }
  return path;
}

function eaglePackageMap(board) {
  const output = new Map();
  const libraries = board.querySelector('libraries');
  for (const library of Array.from(libraries?.children || []).filter((child) => child.tagName === 'library')) {
    const packages = Array.from(library.children || []).find((child) => child.tagName === 'packages');
    if (!packages) continue;
    for (const packageNode of Array.from(packages.children || []).filter((child) => child.tagName === 'package')) {
      const key = `${library.getAttribute('name')}|${packageNode.getAttribute('name')}`;
      output.set(key, packageNode);
      output.set(packageNode.getAttribute('name'), packageNode);
    }
  }
  return output;
}

function eagleSchematicParts(text) {
  const output = new Map();
  if (!text) return output;
  try {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    for (const part of doc.querySelectorAll('parts > part')) {
      output.set(eagleAttr(part, 'name'), {
        value: eagleAttr(part, 'value'),
        library: eagleAttr(part, 'library'),
        deviceset: eagleAttr(part, 'deviceset'),
        device: eagleAttr(part, 'device'),
      });
    }
  } catch {
    // The board remains usable when an optional schematic is malformed.
  }
  return output;
}

function eaglePackageGeometry(packageNode) {
  const outlineSegments = [];
  const silkscreenSegments = [];
  const pads = [];

  for (const child of Array.from(packageNode?.children || [])) {
    const tag = child.tagName;
    const layer = eagleLayerInfo(eagleAttr(child, 'layer'), '');
    if (tag === 'wire') {
      const points = [
        { x: eagleNum(eagleAttr(child, 'x1')), y: eagleNum(eagleAttr(child, 'y1')) },
        { x: eagleNum(eagleAttr(child, 'x2')), y: eagleNum(eagleAttr(child, 'y2')) },
      ];
      if (layer.function === 'SILKSCREEN' || (layer.function === 'FAB' && layer.side === 'TOP')) silkscreenSegments.push(points);
      else outlineSegments.push(points);
    } else if (tag === 'rectangle') {
      const x1 = eagleNum(eagleAttr(child, 'x1'));
      const y1 = eagleNum(eagleAttr(child, 'y1'));
      const x2 = eagleNum(eagleAttr(child, 'x2'));
      const y2 = eagleNum(eagleAttr(child, 'y2'));
      outlineSegments.push([{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }]);
    } else if (tag === 'circle') {
      outlineSegments.push(eagleCirclePoints(eagleNum(eagleAttr(child, 'x')), eagleNum(eagleAttr(child, 'y')), eagleNum(eagleAttr(child, 'radius'))));
    } else if (tag === 'pad') {
      const diameter = eagleNum(eagleAttr(child, 'diameter'), eagleNum(eagleAttr(child, 'drill'), 0.8));
      const shape = eagleAttr(child, 'shape', 'round').toLowerCase();
      pads.push({
        name: eagleAttr(child, 'name'),
        x: eagleNum(eagleAttr(child, 'x')),
        y: eagleNum(eagleAttr(child, 'y')),
        width: shape === 'long' ? diameter * 1.5 : diameter,
        height: diameter,
        diameter,
        drill: eagleNum(eagleAttr(child, 'drill')),
        shape: shape === 'round' ? 'circle' : 'rect',
      });
    } else if (tag === 'smd') {
      const round = eagleNum(eagleAttr(child, 'roundness')) >= 99;
      pads.push({
        name: eagleAttr(child, 'name'),
        x: eagleNum(eagleAttr(child, 'x')),
        y: eagleNum(eagleAttr(child, 'y')),
        width: eagleNum(eagleAttr(child, 'dx')),
        height: eagleNum(eagleAttr(child, 'dy')),
        shape: round ? 'circle' : 'rect',
        layer: eagleAttr(child, 'layer'),
      });
    } else if (tag === 'hole') {
      const diameter = eagleNum(eagleAttr(child, 'drill'), 0.8);
      pads.push({ name: 'hole', x: eagleNum(eagleAttr(child, 'x')), y: eagleNum(eagleAttr(child, 'y')), width: diameter, height: diameter, diameter, drill: diameter, shape: 'circle' });
    }
  }
  return { outlineSegments, silkscreenSegments, pads };
}

export function parseEagleXml(boardText, schematicText = '', sourceName = 'EAGLE board') {
  const parsed = eagleDoc(boardText);
  const board = parsed.board;
  const schematic = eagleSchematicParts(schematicText);
  const layerDefinitions = new Map();
  const layerTable = board.parentElement?.parentElement?.querySelector('layers') || parsed.doc.querySelector('drawing > layers');

  for (const layer of Array.from(layerTable?.children || []).filter((child) => child.tagName === 'layer')) {
    layerDefinitions.set(eagleAttr(layer, 'number'), eagleLayerInfo(eagleAttr(layer, 'number'), eagleAttr(layer, 'name')));
  }

  const infoFor = (number) => layerDefinitions.get(String(number)) || eagleLayerInfo(number, '');
  const layerFeatures = {};
  const usedLayers = new Set();
  const ensureLayer = (name) => {
    if (!layerFeatures[name]) layerFeatures[name] = [];
    usedLayers.add(name);
    return layerFeatures[name];
  };
  const dimensionSegments = [];
  const addWire = (wire, target) => {
    const info = infoFor(eagleAttr(wire, 'layer'));
    const points = [
      { x: eagleNum(eagleAttr(wire, 'x1')), y: eagleNum(eagleAttr(wire, 'y1')) },
      { x: eagleNum(eagleAttr(wire, 'x2')), y: eagleNum(eagleAttr(wire, 'y2')) },
    ];
    ensureLayer(info.name).push({ type: 'line', points, width: eagleNum(eagleAttr(wire, 'width'), 0.1), curve: eagleNum(eagleAttr(wire, 'curve')) });
    if (target && info.name === 'Edge.Cuts') target.push(points);
  };

  const plain = board.querySelector('plain');
  for (const child of Array.from(plain?.children || [])) {
    if (child.tagName === 'wire') addWire(child, dimensionSegments);
    else if (child.tagName === 'circle') {
      const info = infoFor(eagleAttr(child, 'layer'));
      ensureLayer(info.name).push({ type: 'circle', x: eagleNum(eagleAttr(child, 'x')), y: eagleNum(eagleAttr(child, 'y')), r: eagleNum(eagleAttr(child, 'radius')), width: eagleNum(eagleAttr(child, 'width'), 0.1) });
    } else if (child.tagName === 'rectangle') {
      const info = infoFor(eagleAttr(child, 'layer'));
      const x1 = eagleNum(eagleAttr(child, 'x1'));
      const y1 = eagleNum(eagleAttr(child, 'y1'));
      const x2 = eagleNum(eagleAttr(child, 'x2'));
      const y2 = eagleNum(eagleAttr(child, 'y2'));
      ensureLayer(info.name).push({ type: 'poly', points: [{ x: x1, y: y1 }, { x: x2, y: y1 }, { x: x2, y: y2 }, { x: x1, y: y2 }, { x: x1, y: y1 }] });
    } else if (child.tagName === 'polygon') {
      const info = infoFor(eagleAttr(child, 'layer'));
      const points = eaglePoints(child);
      if (points.length > 2) ensureLayer(info.name).push({ type: 'poly', points });
    } else if (child.tagName === 'hole') {
      ensureLayer('Holes').push({ type: 'circle', x: eagleNum(eagleAttr(child, 'x')), y: eagleNum(eagleAttr(child, 'y')), r: eagleNum(eagleAttr(child, 'drill'), 0.8) / 2, width: 0.05 });
    }
  }

  const packageMap = eaglePackageMap(board);
  const components = [];
  for (const element of board.querySelectorAll('elements > element')) {
    const reference = eagleAttr(element, 'name');
    const library = eagleAttr(element, 'library');
    const packageName = eagleAttr(element, 'package');
    const packageNode = packageMap.get(`${library}|${packageName}`) || packageMap.get(packageName);
    const rotationRaw = eagleAttr(element, 'rot', 'R0');
    const mirror = rotationRaw.startsWith('M');
    const rotation = eagleNum(rotationRaw.replace(/^[MR]/, ''));
    const position = { x: eagleNum(eagleAttr(element, 'x')), y: eagleNum(eagleAttr(element, 'y')) };
    const geometry = eaglePackageGeometry(packageNode);
    const schematicPart = schematic.get(reference);
    const component = {
      refDes: reference,
      refdes: reference,
      name: reference,
      part: eagleAttr(element, 'value') || schematicPart?.value || '',
      package: packageName,
      packageRef: packageName,
      layer: mirror ? 'B.Cu' : 'F.Cu',
      side: mirror ? 'B.Cu' : 'F.Cu',
      mountType: 'OTHER',
      rotation,
      mirror,
      position,
      x: position.x,
      y: position.y,
      outlineSegments: geometry.outlineSegments,
      silkscreenSegments: geometry.silkscreenSegments,
      pads: geometry.pads,
    };
    for (const pad of component.pads) pad.net = '';
    components.push(component);
  }

  const nets = [];
  const netPads = {};
  const signals = board.querySelector('signals');
  for (const signal of Array.from(signals?.children || []).filter((child) => child.tagName === 'signal')) {
    const name = eagleAttr(signal, 'name');
    const net = { name, traces: [], contours: [] };
    netPads[name] = [];
    nets.push(net);
    for (const child of Array.from(signal.children || [])) {
      if (child.tagName === 'contactref') {
        netPads[name].push({ element: eagleAttr(child, 'element'), pad: eagleAttr(child, 'pad') });
      } else if (child.tagName === 'wire') {
        const info = infoFor(eagleAttr(child, 'layer'));
        net.traces.push({
          layer: info.name,
          points: [{ x: eagleNum(eagleAttr(child, 'x1')), y: eagleNum(eagleAttr(child, 'y1')) }, { x: eagleNum(eagleAttr(child, 'x2')), y: eagleNum(eagleAttr(child, 'y2')) }],
          width: eagleNum(eagleAttr(child, 'width'), 0.1),
        });
      } else if (child.tagName === 'polygon') {
        const info = infoFor(eagleAttr(child, 'layer'));
        const points = eaglePoints(child);
        if (points.length > 2) net.contours.push({ layer: info.name, points });
      } else if (child.tagName === 'via') {
        ensureLayer('Vias').push({ type: 'circle', x: eagleNum(eagleAttr(child, 'x')), y: eagleNum(eagleAttr(child, 'y')), r: eagleNum(eagleAttr(child, 'drill'), 0.8) / 2, width: 0.05 });
      }
    }
  }

  const padNet = new Map();
  for (const [name, references] of Object.entries(netPads)) {
    for (const reference of references) padNet.set(`${reference.element}|${reference.pad}`, name);
  }
  for (const component of components) {
    for (const pad of component.pads) pad.net = padNet.get(`${component.refDes}|${pad.name}`) || '';
  }

  const outline = eagleJoinPath(dimensionSegments);
  const allPoints = [
    ...outline,
    ...Object.values(layerFeatures).flatMap((list) => list.flatMap((feature) => feature.points || [])),
    ...nets.flatMap((net) => net.traces.flatMap((trace) => trace.points)),
    ...components.map((component) => component.position),
  ];
  const bounds = allPoints.length ? box(allPoints) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const layers = [];

  for (const info of layerDefinitions.values()) {
    if ((usedLayers.has(info.name) || ['F.Cu', 'B.Cu', 'Edge.Cuts'].includes(info.name)) && !layers.some((layer) => layer.name === info.name)) {
      layers.push({ name: info.name, type: info.function, function: info.function, layerFunction: info.function, side: info.side, color: info.color, isEtchLayer: info.function === 'CONDUCTOR' });
    }
  }
  for (const name of usedLayers) {
    if (!layers.some((layer) => layer.name === name)) {
      const info = [...layerDefinitions.values()].find((layer) => layer.name === name) || eagleLayerInfo('', name.replace(/^Eagle:/, ''));
      layers.push({ name, type: info.function, function: info.function, layerFunction: info.function, side: info.side, color: info.color, isEtchLayer: false });
    }
  }

  return {
    name: sourceName.replace(/\.[^.]+$/, ''),
    revision: 'EAGLE XML',
    units: 'MILLIMETER',
    layers,
    components,
    nets,
    layerFeatures,
    boardOutline: outline,
    boardCutouts: [],
    drills: [],
    netPads,
    bounds: {
      ...bounds,
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      centerX: (bounds.minX + bounds.maxX) / 2,
      centerY: (bounds.minY + bounds.maxY) / 2,
    },
    stats: {
      units: 'MILLIMETER',
      totalLayers: layers.length,
      totalComponents: components.length,
      totalNets: nets.length,
      totalBoardFeatures: Object.values(layerFeatures).reduce((total, value) => total + value.length, 0),
    },
  };
}

export function parseEagleArchive(entries, boardName, schematicName) {
  return parseEagleXml(entries.get(boardName) || '', schematicName ? entries.get(schematicName) || '' : '', boardName);
}
