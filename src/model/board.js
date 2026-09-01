export function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function first(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export function point(value) {
  return { x: num(value?.x), y: num(value?.y) };
}

export function pointsOf(value) {
  return Array.isArray(value) ? value.map(point) : [];
}

export function color(value, fallback = '#888') {
  if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)) return value;
  if (typeof value === 'string' && /^[0-9a-f]{6}$/i.test(value)) return `#${value}`;
  if (value && typeof value === 'object') return color(value.hex || value.value, fallback);
  return fallback;
}

export function refOf(component) {
  return String(first(component?.refDes, component?.refdes, component?.name, '') || '');
}

export function positionOf(component) {
  const position = component?.position;
  return {
    x: num(first(position?.x, component?.x, component?.posX)),
    y: num(first(position?.y, component?.y, component?.posY)),
  };
}

export function layerOf(component) {
  return String(first(component?.layer, component?.side, '') || '');
}

export function box(points) {
  if (!points.length) return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
  const xs = points.map((value) => value.x);
  const ys = points.map((value) => value.y);
  return {
    minX: Math.min(...xs),
    minY: Math.min(...ys),
    maxX: Math.max(...xs),
    maxY: Math.max(...ys),
  };
}

export function featurePoints(feature) {
  if (Array.isArray(feature?._points)) return feature._points;
  return pointsOf(feature?.points || feature?.path || feature?.polyline);
}

export function allFeatures(board) {
  if (Array.isArray(board?.renderFeatures)) return board.renderFeatures;
  return buildRenderFeatures(board);
}

function buildRenderFeatures(board) {
  const features = [];

  for (const [layer, list] of Object.entries(board?.layerFeatures || {})) {
    for (const feature of Array.isArray(list) ? list : []) {
      features.push({ ...feature, layer, source: 'layer', _points: featurePoints(feature) });
    }
  }

  for (const net of board?.nets || []) {
    for (const feature of net.traces || net.segments || []) {
      features.push({ ...feature, layer: feature.layer || '', net: net.name || feature.net || '', source: 'net', _points: featurePoints(feature) });
    }
    for (const feature of net.contours || []) {
      features.push({ ...feature, type: 'poly', layer: feature.layer || '', net: net.name || feature.net || '', source: 'net', _points: featurePoints(feature) });
    }
  }

  return features;
}

function samePoint(firstPoint, secondPoint) {
  return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y) < 0.001;
}

function joinTracePoints(features) {
  const remaining = features.map((feature) => [...feature._points]);
  const paths = [];
  while (remaining.length) {
    const path = remaining.shift();
    let extended = true;
    while (extended && remaining.length) {
      extended = false;
      const end = path[path.length - 1];
      const start = path[0];
      const endIndex = remaining.findIndex((points) => samePoint(points[0], end) || samePoint(points[points.length - 1], end));
      if (endIndex >= 0) {
        let next = remaining.splice(endIndex, 1)[0];
        if (samePoint(next[next.length - 1], end)) next = next.reverse();
        path.push(...next.slice(1));
        extended = true;
        continue;
      }
      const startIndex = remaining.findIndex((points) => samePoint(points[points.length - 1], start) || samePoint(points[0], start));
      if (startIndex >= 0) {
        let previous = remaining.splice(startIndex, 1)[0];
        if (samePoint(previous[0], start)) previous = previous.reverse();
        path.unshift(...previous.slice(0, -1));
        extended = true;
      }
    }
    paths.push(path);
  }
  return paths;
}

function buildTraceGroups(features) {
  const grouped = new Map();
  for (const feature of features) {
    const isTrace = feature.source === 'net'
      && !['poly', 'polygon', 'contour'].includes(feature.type)
      && feature._points.length >= 2;
    if (!isTrace) continue;
    const key = [feature.net || '', feature.layer || '', num(feature.width, 0.1), feature.polarity || 'P'].join('|');
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(feature);
  }
  return [...grouped.values()].map((featuresInGroup) => ({
    sample: featuresInGroup[0],
    paths: joinTracePoints(featuresInGroup),
  }));
}

function validBounds(value) {
  return value
    && typeof value === 'object'
    && ['minX', 'minY', 'maxX', 'maxY'].every((key) => Number.isFinite(Number(value[key])));
}

function nonDegenerateBounds(value) {
  return validBounds(value)
    && Number(value.maxX) > Number(value.minX)
    && Number(value.maxY) > Number(value.minY);
}

/**
 * Returns the physical board rectangle used by calibration and tracking.
 * A real outline is preferred because imported `bounds` may include labels or
 * other drawing extents. The normalized board bounds remain the safe fallback.
 */
export function physicalBoardBounds(board) {
  const outline = pointsOf(board?.outline || board?.boardOutline);
  if (outline.length >= 3) {
    const outlineBounds = box(outline);
    if (nonDegenerateBounds(outlineBounds)) return outlineBounds;
  }
  if (nonDegenerateBounds(board?.bounds)) {
    return {
      minX: num(board.bounds.minX),
      minY: num(board.bounds.minY),
      maxX: num(board.bounds.maxX),
      maxY: num(board.bounds.maxY),
    };
  }
  return { minX: 0, minY: 0, maxX: 1, maxY: 1 };
}

export function normalizeBoard(raw) {
  const source = raw?.overlayData && typeof raw.overlayData === 'object' ? raw.overlayData : raw;
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('Board data root is not an object.');
  }

  const rawLayers = Array.isArray(source.layers) ? source.layers : [];
  const layers = rawLayers.map((layer, index) => ({
    ...layer,
    name: String(layer?.name || `Layer ${index + 1}`),
    color: color(layer?.color, '#888'),
    visible: true,
  }));
  const layerMap = new Map(layers.map((layer) => [layer.name, layer]));
  const outline = pointsOf(source.boardOutline);
  const bounds = validBounds(source.bounds)
    ? {
        minX: num(source.bounds.minX),
        minY: num(source.bounds.minY),
        maxX: num(source.bounds.maxX),
        maxY: num(source.bounds.maxY),
      }
    : outline.length
      ? box(outline)
      : { minX: 0, minY: 0, maxX: 1, maxY: 1 };

  const board = {
    ...source,
    layers,
    layerMap,
    outline,
    components: Array.isArray(source.components) ? source.components : [],
    layerFeatures: source.layerFeatures && typeof source.layerFeatures === 'object' ? source.layerFeatures : {},
    nets: Array.isArray(source.nets) ? source.nets : [],
    bounds,
  };
  board.renderFeatures = buildRenderFeatures(board);
  board.traceGroups = buildTraceGroups(board.renderFeatures);
  return board;
}

export function boardStats(board) {
  const features = allFeatures(board).length;
  const drills = (board.drills || []).length + (board.components || []).reduce(
    (total, component) => total + (component.pads || []).filter((pad) => num(pad.drill) > 0).length,
    0,
  );

  return {
    name: first(board.name, '(unnamed)'),
    units: first(board.units, 'MILLIMETER'),
    layers: board.layers.length,
    components: board.components.length,
    features,
    nets: board.nets.length,
    drills,
  };
}

export function boardWarning(board) {
  const copperGeometry = board.layers.some(
    (layer) => layer.function === 'CONDUCTOR' && (board.layerFeatures[layer.name] || []).length,
  );
  const hasNetData = board.nets.length || (board.netPads && Object.keys(board.netPads).length);
  const stats = boardStats(board);
  let warning = '';

  if (!hasNetData) {
    warning = copperGeometry
      ? 'Graphic copper layers loaded, but no netlist or pad connectivity is present.'
      : 'No nets or pad connectivity are present; copper traces cannot be displayed.';
  }
  if (!stats.drills) warning += warning ? ' Drills are also absent.' : 'Drills are absent.';
  return warning;
}
