import { allFeatures, featurePoints, first, layerOf, num, point, pointsOf, positionOf, refOf } from '../model/board.js';

export function createBoardRenderer({ canvas, state, viewport, onScaleChange }) {
  const context = canvas.getContext('2d');

  function themeColor(name, fallback) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
  }

  function connectivityFocusActive() {
    return state.view.highlightConnectivity
      && (state.selected || state.selectedNet)
      && (state.connectivity.components.size || state.connectivity.nets.size);
  }

  function path(points, close = false) {
    if (points.length < 2) return;
    context.beginPath();
    const firstPoint = viewport.screen(points[0]);
    context.moveTo(firstPoint.x, firstPoint.y);
    for (const pointValue of points.slice(1)) {
      const screenPoint = viewport.screen(pointValue);
      context.lineTo(screenPoint.x, screenPoint.y);
    }
    if (close) context.closePath();
  }

  function layerColor(name) {
    const layerName = String(name || '');
    return state.data.layerMap.get(layerName)?.color
      || (layerName.includes('B.') ? '#3988c0' : layerName.includes('F.') ? '#dc4949' : '#999');
  }

  function isCopperLayer(name) {
    const layer = state.data.layerMap.get(String(name || ''));
    return layer?.function === 'CONDUCTOR'
      || layer?.layerFunction === 'CONDUCTOR'
      || layer?.isEtchLayer === true
      || /^(F|B)\.Cu$/i.test(String(name || ''));
  }

  function isFilledNetCopper(feature) {
    return feature.source === 'net'
      && ['poly', 'polygon', 'contour'].includes(feature.type)
      && isCopperLayer(feature.layer);
  }

  function isFeatureVisible(feature) {
    if (feature.layer && state.layers.get(feature.layer) === false) return false;
    const isRawCopper = feature.source !== 'net' && isCopperLayer(feature.layer);
    if (!state.view.showCopper && (isRawCopper || isFilledNetCopper(feature))) return false;
    return true;
  }

  function isNetTrace(feature) {
    return feature.source === 'net'
      && !['poly', 'polygon', 'contour'].includes(feature.type)
      && featurePoints(feature).length >= 2;
  }

  function samePoint(firstPoint, secondPoint) {
    return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y) < 0.001;
  }

  function joinTraceSegments(features) {
    const remaining = features.map((feature) => featurePoints(feature));
    const paths = [];

    while (remaining.length) {
      const pathPoints = remaining.shift();
      let extended = true;
      while (extended && remaining.length) {
        extended = false;
        const end = pathPoints[pathPoints.length - 1];
        const start = pathPoints[0];
        const index = remaining.findIndex((points) => samePoint(points[0], end) || samePoint(points[points.length - 1], end));
        if (index >= 0) {
          let next = remaining.splice(index, 1)[0];
          if (samePoint(next[next.length - 1], end)) next = next.reverse();
          pathPoints.push(...next.slice(1));
          extended = true;
          continue;
        }
        const startIndex = remaining.findIndex((points) => samePoint(points[points.length - 1], start) || samePoint(points[0], start));
        if (startIndex >= 0) {
          let previous = remaining.splice(startIndex, 1)[0];
          if (samePoint(previous[0], start)) previous = previous.reverse();
          pathPoints.unshift(...previous.slice(0, -1));
          extended = true;
        }
      }
      paths.push(pathPoints);
    }
    return paths;
  }

  function drawGrid() {
    if (!state.view.grid || !state.data) return;
    const { w, h } = viewport.screenSize();
    const target = 70 / state.viewport.scale;
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(target, 0.0001))));
    const step = [1, 2, 5, 10].find((value) => value * power >= target) * power;
    const start = viewport.world(0, h);
    const end = viewport.world(w, 0);
    context.save();
    context.strokeStyle = '#273143';
    context.lineWidth = 1;
    context.globalAlpha = 0.65;
    for (let x = Math.floor(start.x / step) * step; x <= end.x + step; x += step) {
      const screenPoint = viewport.screen({ x, y: 0 });
      context.beginPath();
      context.moveTo(screenPoint.x, 0);
      context.lineTo(screenPoint.x, h);
      context.stroke();
    }
    for (let y = Math.floor(start.y / step) * step; y <= end.y + step; y += step) {
      const screenPoint = viewport.screen({ x: 0, y });
      context.beginPath();
      context.moveTo(0, screenPoint.y);
      context.lineTo(w, screenPoint.y);
      context.stroke();
    }
    context.restore();
  }

  function drawOutline() {
    if (!state.view.showOutline || !state.data.outline.length) return;
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    const accentColor = themeColor('--accent', '#e85a4f');
    const textColor = themeColor('--text', '#343535');
    path(state.data.outline, true);
    context.fillStyle = accentColor;
    context.globalAlpha = 0.12;
    context.fill();
    context.globalAlpha = 1;
    context.strokeStyle = textColor;
    context.lineWidth = Math.max(1, 1 / state.viewport.scale);
    context.stroke();

    for (const cutout of state.data.boardCutouts || []) {
      const points = pointsOf(cutout.points || cutout);
      if (points.length <= 2) continue;
      path(points, true);
      context.fillStyle = canvasColor;
      context.fill();
      context.strokeStyle = textColor;
      context.stroke();
    }
  }

  function drawFeatures() {
    const focusActive = connectivityFocusActive();
    const features = allFeatures(state.data);
    for (const feature of features) {
      if (!isFeatureVisible(feature)) continue;
      if (isNetTrace(feature)) continue;
      const isNetFeature = feature.source === 'net';
      const netName = String(feature.net || '');
      const isSelectedNet = Boolean(netName && netName === state.selectedNet);
      const isConnectedNet = Boolean(focusActive && netName && state.connectivity.nets.has(netName));
      const layerName = String(feature.layer || '');
      if (feature.type === 'circle') {
        const screenPoint = viewport.screen({ x: num(feature.x), y: num(feature.y) });
        const radius = Math.max(0.5, num(feature.r, 0.2) * state.viewport.scale);
        const featureColor = isSelectedNet ? '#fff200' : isConnectedNet ? '#5edbff' : layerColor(layerName);
        context.save();
        context.strokeStyle = featureColor;
        context.fillStyle = featureColor;
        context.globalAlpha = focusActive && netName && !isConnectedNet ? 0.12 : layerName.includes('Mask') ? 0.35 : 0.8;
        context.lineWidth = Math.max(0.5, num(feature.width, 0.1) * state.viewport.scale) * (isSelectedNet ? 2 : isConnectedNet ? 1.35 : 1);
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, radius, 0, Math.PI * 2);
        if (feature.polarity !== 'N') context.fill();
        context.stroke();
        context.restore();
        continue;
      }

      const points = featurePoints(feature);
      if (points.length < 2) continue;
      const featureColor = isSelectedNet ? '#fff200' : isConnectedNet ? '#5edbff' : layerColor(layerName);
      const width = Math.max(0.5, num(feature.width, 0.1) * state.viewport.scale);
      const closed = ['poly', 'polygon', 'contour'].includes(feature.type);
      context.save();
      context.strokeStyle = featureColor;
      context.fillStyle = featureColor;
      context.globalAlpha = focusActive && netName && !isConnectedNet ? 0.12 : layerName.includes('Courtyard') ? 0.38 : layerName.includes('Fab') ? 0.5 : 0.9;
      context.lineWidth = width * (isSelectedNet ? 2 : isConnectedNet ? 1.35 : 1);
      path(points, closed);
      if (closed) context.fill();
      else context.stroke();
      context.restore();
    }

    const traceGroups = new Map();
    for (const feature of features) {
      if (!isNetTrace(feature) || !isFeatureVisible(feature)) continue;
      const key = [feature.net || '', feature.layer || '', num(feature.width, 0.1), feature.polarity || 'P'].join('|');
      if (!traceGroups.has(key)) traceGroups.set(key, []);
      traceGroups.get(key).push(feature);
    }

    for (const traceFeatures of traceGroups.values()) {
      const sample = traceFeatures[0];
      const netName = String(sample.net || '');
      const isSelectedNet = Boolean(netName && netName === state.selectedNet);
      const isConnectedNet = Boolean(focusActive && netName && state.connectivity.nets.has(netName));
      const layerName = String(sample.layer || '');
      const traceColor = isSelectedNet ? '#fff200' : isConnectedNet ? '#5edbff' : layerColor(layerName);
      const opacity = focusActive && netName && !isConnectedNet ? 0.12 : 0.95;
      const width = Math.max(0.5, num(sample.width, 0.1) * state.viewport.scale)
        * (isSelectedNet ? 2 : isConnectedNet ? 1.35 : 1);

      context.save();
      context.strokeStyle = traceColor;
      context.globalAlpha = opacity;
      context.lineWidth = width;
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.miterLimit = 2;
      for (const tracePath of joinTraceSegments(traceFeatures)) {
        path(tracePath);
        context.stroke();
      }
      context.restore();
    }
  }

  function drawInTraceNetNames() {
    // Mirroring PCB editors, net names are only useful once the copper is
    // physically wide enough on screen to contain readable text.
    if (!state.view.showInTraceNetNames || state.viewport.scale < 30) return;
    const candidates = [];
    const groups = new Map();
    for (const feature of allFeatures(state.data)) {
      if (!isNetTrace(feature) || !isFeatureVisible(feature) || !feature.net) continue;
      const key = [feature.net, feature.layer || '', num(feature.width, 0.1)].join('|');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(feature);
    }
    for (const traceFeatures of groups.values()) {
      const sample = traceFeatures[0];
      const netName = String(sample.net || '');
      const traceWidth = Math.max(0.5, num(sample.width, 0.1) * state.viewport.scale);
      if (!netName || traceWidth < 6) continue;
      for (const tracePath of joinTraceSegments(traceFeatures)) {
        for (let index = 1; index < tracePath.length; index += 1) {
          const start = viewport.screen(tracePath[index - 1]);
          const end = viewport.screen(tracePath[index]);
          const length = Math.hypot(end.x - start.x, end.y - start.y);
          const candidate = { start, end, length, width: traceWidth };
          candidates.push({ netName, ...candidate });
        }
      }
    }

    const textColor = themeColor('--text', '#343535');
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const candidate of candidates) {
      const { netName } = candidate;
      const fontSize = Math.max(6, Math.min(14, candidate.width - 1));
      context.font = `700 ${fontSize}px ui-monospace, monospace`;
      if (context.measureText(netName).width + 4 > candidate.length) continue;
      let angle = Math.atan2(candidate.end.y - candidate.start.y, candidate.end.x - candidate.start.x);
      if (angle > Math.PI / 2 || angle < -Math.PI / 2) angle += Math.PI;
      context.save();
      context.translate((candidate.start.x + candidate.end.x) / 2, (candidate.start.y + candidate.end.y) / 2);
      context.rotate(angle);
      context.fillStyle = textColor;
      context.fillText(netName, 0, 0);
      context.restore();
    }
    context.restore();
  }

  function transformLocal(localPoint, component) {
    let x = num(localPoint.x);
    const y = num(localPoint.y);
    if (component.mirror === true) x = -x;
    const rotation = num(component.rotation) * Math.PI / 180;
    const position = positionOf(component);
    return {
      x: position.x + x * Math.cos(rotation) - y * Math.sin(rotation),
      y: position.y + x * Math.sin(rotation) + y * Math.cos(rotation),
    };
  }

  function componentPaths(component, key, fallback) {
    const segments = component[`${key}Segments`];
    if (Array.isArray(segments) && segments.length) return segments.map(pointsOf).filter((value) => value.length > 1);
    const points = component[key] || fallback;
    return Array.isArray(points) && points.length > 1 ? [pointsOf(points)] : [];
  }

  function drawLabel(text, worldPoint, color, selected = false) {
    if (!text || !worldPoint) return;
    const screenPoint = viewport.screen(worldPoint);
    const fontSize = Math.max(9, Math.min(14, 9 * state.viewport.scale / 5));
    const borderColor = themeColor('--border', '#d8d2c7');
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    context.save();
    context.translate(screenPoint.x, screenPoint.y);
    // `viewport.screen()` already returns screen-space coordinates. Do not
    // inherit the board's Y orientation so labels remain upright.
    context.font = `${fontSize}px ui-monospace, monospace`;
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    const width = context.measureText(text).width;
    context.fillStyle = canvasColor;
    context.globalAlpha = 0.9;
    context.fillRect(2, -fontSize - 7, width + 8, fontSize + 8);
    context.strokeStyle = selected ? color : borderColor;
    context.lineWidth = 1;
    context.strokeRect(2, -fontSize - 7, width + 8, fontSize + 8);
    context.globalAlpha = 1;
    context.fillStyle = color;
    context.fillText(text, 6, -5);
    context.restore();
  }

  function netLabelAnchors() {
    const anchors = new Map();
    const candidates = new Map();
    for (const feature of allFeatures(state.data)) {
      const netName = String(feature.net || '');
      if (!netName) continue;
      const visible = isFeatureVisible(feature);
      if (!visible && netName !== state.selectedNet) continue;
      const points = featurePoints(feature);
      let anchor = null;
      let score = 0;
      if (feature.type === 'circle') {
        anchor = { x: num(feature.x), y: num(feature.y) };
        score = Math.PI * Math.max(0, num(feature.r, 0.1)) ** 2;
      } else if (points.length >= 2) {
        for (let index = 1; index < points.length; index += 1) {
          const start = points[index - 1];
          const end = points[index];
          const length = Math.hypot(end.x - start.x, end.y - start.y);
          if (length > score) {
            score = length;
            anchor = { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 };
          }
        }
      }
      if (anchor && (!candidates.has(netName) || candidates.get(netName).score < score)) {
        candidates.set(netName, { anchor, score });
      }
    }

    for (const component of state.data.components || []) {
      for (const pad of component.pads || []) {
        const netName = String(pad.net || '');
        if (!netName || candidates.has(netName)) continue;
        candidates.set(netName, { anchor: transformLocal(pad, component), score: 0 });
      }
    }

    for (const [netName, candidate] of candidates) anchors.set(netName, candidate.anchor);
    return anchors;
  }

  function drawNetLabels() {
    const selectedNet = String(state.selectedNet || '');
    if (!state.view.showNetLabels && !selectedNet) return;
    const textColor = themeColor('--text', '#343535');
    const selectedColor = themeColor('--accent', '#e85a4f');
    for (const [netName, anchor] of netLabelAnchors()) {
      const selected = netName === selectedNet;
      if (!state.view.showNetLabels && !selected) continue;
      drawLabel(netName, anchor, selected ? selectedColor : textColor, selected);
    }
  }

  function drawPads(component, opacity = 1) {
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    for (const pad of component.pads || []) {
      const position = transformLocal(pad, component);
      const width = num(first(pad.width, pad.size?.x), 0.6);
      const height = num(first(pad.height, pad.size?.y), width);
      const screenPoint = viewport.screen(position);
      const radiusX = Math.max(1, width * state.viewport.scale / 2);
      const radiusY = Math.max(1, height * state.viewport.scale / 2);
      context.save();
      context.strokeStyle = '#f5c542';
      context.fillStyle = '#f5c54255';
      context.globalAlpha = opacity;
      context.lineWidth = Math.max(1, 1 / state.viewport.scale);
      if (String(pad.shape || '').toLowerCase().includes('circle')) {
        context.beginPath();
        context.ellipse(screenPoint.x, screenPoint.y, radiusX, radiusY, 0, 0, Math.PI * 2);
        context.fill();
        context.stroke();
      } else {
        context.fillRect(screenPoint.x - radiusX, screenPoint.y - radiusY, radiusX * 2, radiusY * 2);
        context.strokeRect(screenPoint.x - radiusX, screenPoint.y - radiusY, radiusX * 2, radiusY * 2);
      }
      if (num(pad.drill) > 0) {
        const holeRadius = Math.max(0.5, num(pad.drill) * state.viewport.scale / 2);
        context.fillStyle = canvasColor;
        context.beginPath();
        context.arc(screenPoint.x, screenPoint.y, holeRadius, 0, Math.PI * 2);
        context.fill();
      }
      context.restore();
    }
  }

  function overlaps(firstRect, secondRect, padding = 3) {
    return firstRect.x - padding < secondRect.x + secondRect.width
      && firstRect.x + firstRect.width + padding > secondRect.x
      && firstRect.y - padding < secondRect.y + secondRect.height
      && firstRect.y + firstRect.height + padding > secondRect.y;
  }

  function drawCompactPinoutMarkers(component, pads, color, canvasColor) {
    const { w: canvasWidth, h: canvasHeight } = viewport.screenSize();
    const center = viewport.screen(positionOf(component));
    const occupied = [];
    const fontSize = Math.max(8, Math.min(10, 7 * state.viewport.scale / 5));
    context.save();
    context.font = `700 ${fontSize}px ui-monospace, monospace`;
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    for (const { pad, name } of pads) {
      const anchor = viewport.screen(transformLocal(pad, component));
      const width = Math.ceil(context.measureText(name).width) + 7;
      const height = fontSize + 6;
      const directionX = Math.sign(anchor.x - center.x) || 1;
      const directionY = Math.sign(anchor.y - center.y);
      const directions = [[directionX, directionY], [directionX, 0], [0, directionY || -1], [directionX, -directionY], [-directionX, directionY]];
      const candidates = [];
      for (const distance of [5, 12, 21, 32]) {
        for (const [xDirection, yDirection] of directions) {
          const candidate = {
            x: anchor.x + xDirection * distance - width / 2,
            y: anchor.y + yDirection * distance - height / 2,
            width,
            height,
          };
          candidate.x = Math.max(1, Math.min(canvasWidth - width - 1, candidate.x));
          candidate.y = Math.max(1, Math.min(canvasHeight - height - 1, candidate.y));
          if (!candidates.some((value) => value.x === candidate.x && value.y === candidate.y)) candidates.push(candidate);
        }
      }
      const score = (candidate) => occupied.filter((other) => overlaps(candidate, other, 1)).length;
      const placement = candidates.find((candidate) => score(candidate) === 0)
        || candidates.reduce((best, candidate) => score(candidate) < score(best) ? candidate : best);
      occupied.push(placement);
      context.save();
      context.strokeStyle = color;
      context.globalAlpha = 0.55;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(anchor.x, anchor.y);
      context.lineTo(placement.x + width / 2, placement.y + height / 2);
      context.stroke();
      context.globalAlpha = 0.94;
      context.fillStyle = canvasColor;
      context.fillRect(placement.x, placement.y, width, height);
      context.strokeStyle = color;
      context.strokeRect(placement.x, placement.y, width, height);
      context.fillStyle = color;
      context.fillText(name, placement.x + width / 2, placement.y + height / 2 + .5);
      context.restore();
    }
    context.restore();
  }

  function drawInPadPinoutNames(component) {
    const color = themeColor('--accent', '#e85a4f');
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    context.save();
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    for (const pad of component.pads || []) {
      const pinName = String(first(pad.name, pad.number, pad.pin, pad.label) || '').trim();
      if (!pinName) continue;
      const position = viewport.screen(transformLocal(pad, component));
      const padWidth = Math.max(0, num(first(pad.width, pad.size?.x), 0.6) * state.viewport.scale);
      const padHeight = Math.max(0, num(first(pad.height, pad.size?.y), 0.6) * state.viewport.scale);
      const available = Math.min(padWidth, padHeight) - 4;
      if (available < 8) continue;
      const fontSize = Math.max(8, Math.min(13, available));
      context.font = `700 ${fontSize}px ui-monospace, monospace`;
      if (context.measureText(pinName).width > padWidth - 4) continue;
      // The halo keeps pad numbers legible while preserving the actual pad as
      // their anchor, matching the compact pad-number display in PCB editors.
      context.lineWidth = Math.max(2, fontSize / 4);
      context.strokeStyle = canvasColor;
      context.strokeText(pinName, position.x, position.y);
      context.fillStyle = color;
      context.fillText(pinName, position.x, position.y);
    }
    context.restore();
  }

  function drawSelectedPinoutNames() {
    const component = state.selected;
    if (!state.view.showPinoutNames || !component) return;
    drawInPadPinoutNames(component);
  }

  // Retained as a reference implementation for possible callout-mode tooling;
  // the live viewer uses in-pad labels above.
  function drawLegacyExternalPinoutNames() {
    const component = state.selected;
    if (!state.view.showPinoutNames || !component) return;
    const labeledPads = (component.pads || [])
      .map((pad) => ({ pad, name: String(first(pad.name, pad.number, pad.pin, pad.label) || '').trim() }))
      .filter((pad) => pad.name);
    if (labeledPads.length > 10) {
      drawCompactPinoutMarkers(component, labeledPads, themeColor('--accent', '#e85a4f'), themeColor('--canvas-bg', '#dedbd4'));
      return;
    }

    const { w: canvasWidth, h: canvasHeight } = viewport.screenSize();
    const color = themeColor('--accent', '#e85a4f');
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    const fontSize = Math.max(10, Math.min(14, 9 * state.viewport.scale / 5));
    const labelHeight = fontSize + 10;
    const occupied = [];
    const obstacles = (component.pads || []).map((pad) => {
      const position = viewport.screen(transformLocal(pad, component));
      const width = Math.max(8, num(first(pad.width, pad.size?.x), 0.6) * state.viewport.scale + 10);
      const height = Math.max(8, num(first(pad.height, pad.size?.y), 0.6) * state.viewport.scale + 10);
      return { x: position.x - width / 2, y: position.y - height / 2, width, height };
    });
    const canvasRect = canvas.getBoundingClientRect();
    const selectionPanel = document.getElementById('selectionPanel');
    if (selectionPanel?.classList.contains('open') && getComputedStyle(selectionPanel).visibility !== 'hidden') {
      const panelRect = selectionPanel.getBoundingClientRect();
      obstacles.push({
        x: panelRect.left - canvasRect.left,
        y: panelRect.top - canvasRect.top,
        width: panelRect.width,
        height: panelRect.height,
      });
    }

    context.save();
    context.font = `600 ${fontSize}px ui-monospace, monospace`;
    for (const { pad, name: pinName } of labeledPads) {
      const netName = String(pad.net || '').trim();
      const text = netName ? `${pinName} · ${netName}` : pinName;
      const anchor = viewport.screen(transformLocal(pad, component));
      const labelWidth = Math.ceil(context.measureText(text).width) + 12;
      const placements = [];
      const directions = [[1, -1], [1, 0], [0, -1], [-1, -1], [-1, 0], [0, 1], [1, 1], [-1, 1]];
      for (const distance of [8, 20, 36, 56, 80, 108]) {
        for (const [directionX, directionY] of directions) {
          const candidate = {
            x: anchor.x + directionX * distance - (directionX < 0 ? labelWidth : directionX === 0 ? labelWidth / 2 : 0),
            y: anchor.y + directionY * distance - (directionY < 0 ? labelHeight : directionY === 0 ? labelHeight / 2 : 0),
            width: labelWidth,
            height: labelHeight,
          };
          candidate.x = Math.max(2, Math.min(canvasWidth - labelWidth - 2, candidate.x));
          candidate.y = Math.max(2, Math.min(canvasHeight - labelHeight - 2, candidate.y));
          if (!placements.some((placed) => placed.x === candidate.x && placed.y === candidate.y)) placements.push(candidate);
        }
      }
      const collisionScore = (candidate) => (
        occupied.filter((other) => overlaps(candidate, other)).length * 100
        + obstacles.filter((other) => overlaps(candidate, other)).length
      );
      const placement = placements.find((candidate) => collisionScore(candidate) === 0)
        || placements.reduce((best, candidate) => collisionScore(candidate) < collisionScore(best) ? candidate : best);
      occupied.push(placement);

      context.save();
      context.strokeStyle = color;
      context.globalAlpha = 0.65;
      context.lineWidth = 1;
      context.beginPath();
      context.moveTo(anchor.x, anchor.y);
      context.lineTo(placement.x + placement.width / 2, placement.y + placement.height / 2);
      context.stroke();
      context.globalAlpha = 0.96;
      context.fillStyle = canvasColor;
      context.fillRect(placement.x, placement.y, placement.width, placement.height);
      context.strokeStyle = color;
      context.strokeRect(placement.x, placement.y, placement.width, placement.height);
      context.fillStyle = color;
      context.textBaseline = 'middle';
      context.fillText(text, placement.x + 6, placement.y + labelHeight / 2);
      context.restore();
    }
    context.restore();
  }

  function drawComponents() {
    if (!state.view.showComponents) return;
    const focusActive = connectivityFocusActive();
    for (const component of state.data.components) {
      const layerName = layerOf(component);
      const position = positionOf(component);
      const selected = component === state.selected;
      const connected = state.connectivity.components.has(component);
      const opacity = focusActive && !connected ? 0.14 : 1;
      const screenPoint = viewport.screen(position);
      const componentColor = selected ? '#fff200' : connected && focusActive ? '#5edbff' : layerColor(layerName);

      if (state.view.showFootprints) {
        for (const key of ['outline', 'courtyard', 'silkscreen']) {
          for (const localPoints of componentPaths(component, key)) {
            const points = localPoints.map((value) => transformLocal(value, component));
            context.save();
            context.strokeStyle = key === 'courtyard' ? '#c586ff' : key === 'silkscreen' ? '#f2f2f2' : componentColor;
            context.globalAlpha = opacity * (key === 'courtyard' ? 0.45 : key === 'silkscreen' ? 0.9 : 0.95);
            context.lineWidth = Math.max(1, (key === 'outline' ? 0.12 : 0.08) * state.viewport.scale);
            if (key === 'courtyard') context.setLineDash([4 / state.viewport.scale, 3 / state.viewport.scale]);
            path(points, true);
            context.stroke();
            context.restore();
          }
        }
        drawPads(component, opacity);
      }

      context.save();
      context.strokeStyle = componentColor;
      context.fillStyle = componentColor;
      context.globalAlpha = opacity;
      context.lineWidth = Math.max(1, 1 / state.viewport.scale);
      const radius = Math.max(1.5, 0.12 * state.viewport.scale);
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, radius, 0, Math.PI * 2);
      context.fill();
      context.beginPath();
      context.moveTo(screenPoint.x - radius * 2, screenPoint.y);
      context.lineTo(screenPoint.x + radius * 2, screenPoint.y);
      context.moveTo(screenPoint.x, screenPoint.y - radius * 2);
      context.lineTo(screenPoint.x, screenPoint.y + radius * 2);
      context.stroke();

      if ((state.view.showLabels && state.viewport.scale > 4) || selected) {
        const labelColor = selected ? themeColor('--accent', '#e85a4f') : themeColor('--text', '#343535');
        drawLabel(refOf(component), position, labelColor, selected);
      }
      context.restore();
    }
  }

  function drawDrills() {
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    const textColor = themeColor('--text', '#343535');
    for (const drill of state.data.drills || []) {
      const screenPoint = viewport.screen(point(drill));
      const radius = Math.max(1, num(first(drill.diameter, drill.size), 0.8) * state.viewport.scale / 2);
      context.save();
      context.strokeStyle = textColor;
      context.fillStyle = canvasColor;
      context.lineWidth = 1;
      context.beginPath();
      context.arc(screenPoint.x, screenPoint.y, radius, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      context.restore();
    }
  }

  function render() {
    const { w, h } = viewport.screenSize();
    const canvasColor = themeColor('--canvas-bg', '#dedbd4');
    context.clearRect(0, 0, w, h);
    context.fillStyle = canvasColor;
    context.fillRect(0, 0, w, h);
    if (!state.data) {
      onScaleChange?.(null);
      return;
    }
    drawGrid();
    drawOutline();
    drawFeatures();
    drawDrills();
    drawComponents();
    drawNetLabels();
    drawInTraceNetNames();
    drawSelectedPinoutNames();
    onScaleChange?.(state.viewport.scale);
  }

  function nearestComponent(x, y) {
    if (!state.data || !state.view.showComponents) return null;
    const target = viewport.world(x, y);
    let nearest = null;
    let distance = Infinity;
    for (const component of state.data.components) {
      let current = Math.hypot(positionOf(component).x - target.x, positionOf(component).y - target.y);
      for (const pad of component.pads || []) {
        const position = transformLocal(pad, component);
        const radius = Math.max(num(first(pad.width, pad.size?.x), 0.6), num(first(pad.height, pad.size?.y), 0.6)) / 2;
        current = Math.min(current, Math.max(0, Math.hypot(position.x - target.x, position.y - target.y) - radius));
      }
      for (const localPoints of componentPaths(component, 'outline')) {
        const points = localPoints.map((value) => transformLocal(value, component));
        for (let index = 1; index < points.length; index += 1) {
          current = Math.min(current, distanceToSegment(target, points[index - 1], points[index]));
        }
      }
      if (current < distance) {
        distance = current;
        nearest = component;
      }
    }
    return distance <= Math.max(0.12, 8 / state.viewport.scale) ? nearest : null;
  }

  function distanceToSegment(pointValue, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (!lengthSquared) return Math.hypot(pointValue.x - start.x, pointValue.y - start.y);
    const t = Math.max(0, Math.min(1, ((pointValue.x - start.x) * dx + (pointValue.y - start.y) * dy) / lengthSquared));
    return Math.hypot(pointValue.x - (start.x + t * dx), pointValue.y - (start.y + t * dy));
  }

  function pointInPolygon(pointValue, points) {
    let inside = false;
    for (let index = 0, previous = points.length - 1; index < points.length; previous = index++) {
      const current = points[index];
      const prior = points[previous];
      const intersects = ((current.y > pointValue.y) !== (prior.y > pointValue.y))
        && pointValue.x < ((prior.x - current.x) * (pointValue.y - current.y)) / (prior.y - current.y) + current.x;
      if (intersects) inside = !inside;
    }
    return inside;
  }

  function distanceToFeature(pointValue, feature) {
    if (feature.type === 'circle') {
      return Math.max(0, Math.hypot(pointValue.x - num(feature.x), pointValue.y - num(feature.y)) - num(feature.r, 0.1));
    }
    const points = featurePoints(feature);
    if (points.length < 2) return Infinity;
    const closed = ['poly', 'polygon', 'contour'].includes(feature.type);
    if (closed && pointInPolygon(pointValue, points)) return 0;
    let distance = Infinity;
    for (let index = 1; index < points.length; index += 1) {
      distance = Math.min(distance, distanceToSegment(pointValue, points[index - 1], points[index]));
    }
    if (closed) distance = Math.min(distance, distanceToSegment(pointValue, points[points.length - 1], points[0]));
    return distance;
  }

  function nearestNet(x, y) {
    if (!state.data) return null;
    const target = viewport.world(x, y);
    let nearest = null;
    let distance = Infinity;
    for (const feature of allFeatures(state.data)) {
      if (!isFeatureVisible(feature)) continue;
      if (feature.source !== 'net') continue;
      const netName = String(feature.net || '');
      if (!netName) continue;
      const current = distanceToFeature(target, feature);
      if (current < distance) {
        distance = current;
        nearest = netName;
      }
    }
    return distance <= Math.max(0.8, 8 / state.viewport.scale) ? nearest : null;
  }

  return { render, nearestComponent, nearestNet };
}
