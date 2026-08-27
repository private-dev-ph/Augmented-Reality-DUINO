import { box, num, refOf } from '../model/board.js';

export function odbLines(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

export function odbUnitFactor(text) {
  return /^\s*UNITS\s*=\s*MM\s*$/im.test(text) ? 1 : 25.4;
}

function odbSizeToMm(value, factor) {
  return num(value) * (factor === 25.4 ? 0.0254 : 0.001);
}

function odbArcPoints(start, end, center, clockwise) {
  const radius = Math.hypot(start.x - center.x, start.y - center.y);
  if (!Number.isFinite(radius) || radius < 1e-9) return [end];

  const startAngle = Math.atan2(start.y - center.y, start.x - center.x);
  const endAngle = Math.atan2(end.y - center.y, end.x - center.x);
  let delta = clockwise ? startAngle - endAngle : endAngle - startAngle;
  if (delta <= 0) delta += Math.PI * 2;
  if (Math.hypot(start.x - end.x, start.y - end.y) < 1e-8) delta = Math.PI * 2;

  const count = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / 18)));
  const points = [];
  for (let index = 1; index <= count; index += 1) {
    const angle = startAngle + (clockwise ? -1 : 1) * delta * index / count;
    points.push({ x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) });
  }
  return points;
}

function odbPolygons(text, factor) {
  const polygons = [];
  let current = null;

  for (const line of odbLines(text)) {
    const tokens = line.split(/\s+/);
    const kind = tokens[0];
    if (kind === 'OB' && tokens.length >= 3) {
      current = {
        kind: String(tokens[3] || 'I').toUpperCase(),
        points: [{ x: num(tokens[1]) * factor, y: num(tokens[2]) * factor }],
      };
      continue;
    }
    if (!current) continue;
    if (kind === 'OS' && tokens.length >= 3) {
      current.points.push({ x: num(tokens[1]) * factor, y: num(tokens[2]) * factor });
    } else if (kind === 'OC' && tokens.length >= 6) {
      const start = current.points[current.points.length - 1];
      const end = { x: num(tokens[1]) * factor, y: num(tokens[2]) * factor };
      const center = { x: num(tokens[3]) * factor, y: num(tokens[4]) * factor };
      current.points.push(...odbArcPoints(start, end, center, String(tokens[5]).toUpperCase() === 'Y'));
    } else if (kind === 'OE') {
      if (current.points.length > 2) polygons.push(current);
      current = null;
    }
  }
  return polygons;
}

function odbSymbols(text) {
  const symbols = {};
  for (const line of odbLines(text)) {
    const tokens = line.split(/\s+/);
    if (tokens[0] === '$' && tokens.length >= 3) symbols[tokens[1]] = tokens.slice(2).join(' ');
  }
  return symbols;
}

function odbSymbolWidth(symbols, index, factor) {
  const value = String(symbols[index] || '').toLowerCase();
  const numbers = (value.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (!numbers.length) return 0.1;
  const size = (number) => odbSizeToMm(number, factor);
  if (value.startsWith('r') || value.startsWith('c') || value.startsWith('circle')) return size(numbers[0]);
  if (value.includes('rect') || value.includes('oval')) return Math.max(size(numbers[0]), size(numbers[1] || numbers[0]));
  return size(numbers[0]);
}

export function odbFeatureFile(text, factor) {
  const symbols = odbSymbols(text);
  const features = [];
  const polygons = odbPolygons(text, factor);

  for (const line of odbLines(text)) {
    const tokens = line.split(/\s+/);
    const kind = tokens[0];
    if (kind === 'L' && tokens.length >= 5) {
      features.push({
        type: 'line',
        points: [
          { x: num(tokens[1]) * factor, y: num(tokens[2]) * factor },
          { x: num(tokens[3]) * factor, y: num(tokens[4]) * factor },
        ],
        width: odbSymbolWidth(symbols, tokens[5], factor),
        polarity: tokens[6] || 'P',
      });
    } else if (kind === 'P' && tokens.length >= 5) {
      let symbol = tokens[3];
      let resize = 1;
      let polarity = tokens[4] || 'P';
      if (symbol === '-1' && tokens.length >= 6) {
        symbol = tokens[4];
        resize = num(tokens[5], 1);
        polarity = tokens[6] || 'P';
      }
      features.push({
        type: 'circle',
        x: num(tokens[1]) * factor,
        y: num(tokens[2]) * factor,
        r: Math.max(0.01, odbSymbolWidth(symbols, symbol, factor) * resize / 2),
        width: 0.05,
        polarity,
      });
    } else if (kind === 'A' && tokens.length >= 8) {
      const start = { x: num(tokens[1]) * factor, y: num(tokens[2]) * factor };
      const end = { x: num(tokens[3]) * factor, y: num(tokens[4]) * factor };
      const center = { x: num(tokens[5]) * factor, y: num(tokens[6]) * factor };
      features.push({
        type: 'line',
        points: [start, ...odbArcPoints(start, end, center, String(tokens[10] || tokens[9] || 'N').toUpperCase() === 'Y')],
        width: odbSymbolWidth(symbols, tokens[7], factor),
        polarity: tokens[8] || 'P',
      });
    }
  }

  for (const polygon of polygons) {
    features.push({ type: 'poly', points: polygon.points, polarity: polygon.kind === 'H' ? 'N' : 'P' });
  }
  return { features, polygons };
}

function odbFields(block) {
  const output = {};
  for (const line of block.split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Z_]+)=(.*)$/);
    if (match) output[match[1]] = match[2].trim();
  }
  return output;
}

function odbMatrix(text) {
  const output = {};
  for (const match of String(text || '').matchAll(/LAYER\s*\{([\s\S]*?)\}/gi)) {
    const fields = odbFields(match[1]);
    if (fields.NAME) {
      output[fields.NAME] = {
        name: fields.NAME,
        type: fields.TYPE || '',
        polarity: fields.POLARITY || 'POSITIVE',
        color: fields.COLOR || '',
      };
    }
  }
  return output;
}

function odbLayerFunction(name, type) {
  const text = `${String(type || '')} ${String(name || '')}`.toUpperCase();
  if (text.includes('SIGNAL') || text.includes('POWER') || text.includes('MIXED') || /^(F|B)?\.?CU|^L\d+/.test(text)) return 'CONDUCTOR';
  if (text.includes('SOLDER_MASK') || text.includes('MASK')) return 'SOLDERMASK';
  if (text.includes('SOLDER_PASTE') || text.includes('PASTE')) return 'SOLDERPASTE';
  if (text.includes('SILK')) return 'SILKSCREEN';
  if (text.includes('DRILL')) return 'DRILL';
  if (text.includes('ROUT') || text.includes('PROFILE')) return 'BOARD_OUTLINE';
  return 'OTHER';
}

function odbLayerSide(name, type) {
  const text = `${String(name || '')} ${String(type || '')}`.toUpperCase();
  if (/(^|[+_.-])(TOP|TOPSIDE|F|1)($|[+_.-])/.test(text) || text.includes('_+_TOP')) return 'TOP';
  if (/(^|[+_.-])(BOTTOM|BOTSIDE|BOT|B|2)($|[+_.-])/.test(text) || text.includes('_+_BOT')) return 'BOTTOM';
  return 'INTERNAL';
}

function odbLayerColor(name, type) {
  const functionName = odbLayerFunction(name, type);
  const side = odbLayerSide(name, type);
  if (functionName === 'CONDUCTOR') return side === 'BOTTOM' ? '#3988c0' : '#dc4949';
  if (functionName === 'SOLDERMASK') return side === 'BOTTOM' ? '#8c4dc4' : '#3caf56';
  if (functionName === 'SOLDERPASTE') return '#f3b34c';
  if (functionName === 'SILKSCREEN') return '#f5f5f5';
  if (functionName === 'DRILL') return '#d4d4d4';
  if (functionName === 'BOARD_OUTLINE') return '#ffffff';
  return '#9aa4b2';
}

function odbComponents(text, factor, packages) {
  const components = [];
  for (const line of odbLines(text)) {
    const tokens = line.split(/\s+/);
    if (tokens[0] !== 'PKG' && tokens[0] !== 'CMP') continue;
    if (tokens[0] === 'PKG' && tokens.length >= 7) {
      packages.push({
        name: tokens[1],
        box: [num(tokens[3]) * factor, num(tokens[4]) * factor, num(tokens[5]) * factor, num(tokens[6]) * factor],
      });
      continue;
    }
    if (tokens[0] === 'CMP' && tokens.length >= 8) {
      const packageInfo = packages[num(tokens[1], -1)];
      const componentBox = packageInfo?.box;
      const mirror = String(tokens[5]).toUpperCase() === 'M';
      components.push({
        refDes: tokens[6],
        refdes: tokens[6],
        name: tokens[6],
        part: tokens[7],
        package: tokens[7],
        layer: mirror ? 'B.Cu' : 'F.Cu',
        side: mirror ? 'B.Cu' : 'F.Cu',
        rotation: num(tokens[4]),
        mirror,
        position: { x: num(tokens[2]) * factor, y: num(tokens[3]) * factor },
        x: num(tokens[2]) * factor,
        y: num(tokens[3]) * factor,
        outline: componentBox
          ? [
              { x: componentBox[0], y: componentBox[1] },
              { x: componentBox[2], y: componentBox[1] },
              { x: componentBox[2], y: componentBox[3] },
              { x: componentBox[0], y: componentBox[3] },
              { x: componentBox[0], y: componentBox[1] },
            ]
          : [],
      });
    }
  }
  return components;
}

export function parseOdbEntries(entries) {
  const names = [...entries.keys()];
  const profileName = names.find((name) => /(^|\/)steps\/[^/]+\/profile$/i.test(name));
  if (!profileName) throw new Error('ODB++ profile not found. Expected steps/<step>/profile inside the ZIP.');

  const match = profileName.match(/^(.*\/)?steps\/([^/]+)\/profile$/i);
  const prefix = match?.[1] || '';
  const step = match?.[2] || 'board';
  const profile = entries.get(profileName) || '';
  const factor = odbUnitFactor(profile);
  const profileData = odbFeatureFile(profile, factor);
  const islands = profileData.polygons.filter((polygon) => polygon.kind !== 'H');
  const holes = profileData.polygons.filter((polygon) => polygon.kind === 'H');
  const matrixName = names.find((name) => name.toLowerCase() === `${prefix}matrix/matrix`.toLowerCase());
  const matrix = odbMatrix(matrixName ? entries.get(matrixName) : '');
  const escapePart = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const layerPattern = new RegExp(`^${escapePart(prefix)}steps/${escapePart(step)}/layers/([^/]+)/features$`, 'i');
  const layerEntries = names
    .map((name) => ({ name, match: name.match(layerPattern) }))
    .filter((entry) => entry.match);
  const layerFeatures = {};
  const layers = [];
  const drills = [];

  for (const entry of layerEntries) {
    const layerName = entry.match[1];
    const info = matrix[layerName] || {};
    const text = entries.get(entry.name) || '';
    const parsed = odbFeatureFile(text, odbUnitFactor(text));
    const type = info.type || layerName;
    const functionName = odbLayerFunction(layerName, type);
    if (functionName === 'DRILL') {
      for (const feature of parsed.features) {
        if (feature.type === 'circle') drills.push({ x: feature.x, y: feature.y, diameter: feature.r * 2 });
      }
    }
    layerFeatures[layerName] = functionName === 'DRILL'
      ? parsed.features.filter((feature) => feature.type !== 'circle')
      : parsed.features;
    layers.push({
      name: layerName,
      type,
      function: functionName,
      layerFunction: functionName,
      side: odbLayerSide(layerName, type),
      color: odbLayerColor(layerName, type),
      isEtchLayer: functionName === 'CONDUCTOR',
    });
  }

  const packages = [];
  const components = [];
  const edaName = names.find((name) => name.toLowerCase() === `${prefix}steps/${step}/eda/data`.toLowerCase());
  if (edaName) components.push(...odbComponents(entries.get(edaName), odbUnitFactor(entries.get(edaName)), packages));
  for (const name of names.filter((value) => /\/components$/i.test(value))) {
    components.push(...odbComponents(entries.get(name), odbUnitFactor(entries.get(name)), packages));
  }

  const unique = [];
  const seen = new Set();
  for (const component of components) {
    const key = `${refOf(component)}|${component.x.toFixed(6)}|${component.y.toFixed(6)}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(component);
    }
  }

  const outline = islands[0]?.points || [];
  const boardCutouts = holes.map((polygon) => polygon.points);
  const bounds = outline.length ? box(outline) : { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  if (!layers.some((layer) => layer.name === 'PROFILE') && outline.length) {
    layers.push({ name: 'PROFILE', type: 'ROUT', function: 'BOARD_OUTLINE', layerFunction: 'BOARD_OUTLINE', side: 'ALL', color: '#ffffff', isEtchLayer: false });
  }
  if (outline.length) layerFeatures.PROFILE = [{ type: 'poly', points: outline, polarity: 'P' }];

  return {
    name: `ODB++ ${step}`,
    revision: 'ODB++',
    units: 'MILLIMETER',
    layers,
    components: unique,
    nets: [],
    layerFeatures,
    boardOutline: outline,
    boardCutouts,
    drills,
    netPads: {},
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
      totalComponents: unique.length,
      totalNets: 0,
      totalBoardFeatures: Object.values(layerFeatures).reduce((total, value) => total + value.length, 0),
    },
  };
}
