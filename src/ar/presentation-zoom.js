export const PRESENTATION_ZOOM_MIN = 1;
export const PRESENTATION_ZOOM_MAX = 4;

function safePositive(value, fallback = 1) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

export function clampPresentationScale(value) {
  return Math.max(PRESENTATION_ZOOM_MIN, Math.min(PRESENTATION_ZOOM_MAX, safePositive(value, 1)));
}

export function constrainPresentationTransform({ scale = 1, tx = 0, ty = 0, width = 1, height = 1 } = {}) {
  const safeScale = clampPresentationScale(scale);
  const safeWidth = safePositive(width);
  const safeHeight = safePositive(height);
  return {
    scale: safeScale,
    tx: Math.max(safeWidth * (1 - safeScale), Math.min(0, Number(tx) || 0)),
    ty: Math.max(safeHeight * (1 - safeScale), Math.min(0, Number(ty) || 0)),
  };
}

/**
 * Keeps the content point under the original pinch midpoint and follows any
 * movement of that midpoint, while clamping the scaled presentation to the
 * viewport so no uncovered strip is exposed.
 */
export function getPinchPresentationTransform({
  baseScale = 1,
  baseTx = 0,
  baseTy = 0,
  startDistance = 1,
  currentDistance = 1,
  startMidpoint = { x: 0, y: 0 },
  currentMidpoint = startMidpoint,
  width = 1,
  height = 1,
} = {}) {
  const safeBaseScale = clampPresentationScale(baseScale);
  const safeStartDistance = Math.max(0.001, safePositive(startDistance));
  const safeCurrentDistance = Math.max(0.001, safePositive(currentDistance));
  const scale = clampPresentationScale(safeBaseScale * safeCurrentDistance / safeStartDistance);
  const ratio = scale / safeBaseScale;
  const startX = Number(startMidpoint?.x) || 0;
  const startY = Number(startMidpoint?.y) || 0;
  const currentX = Number(currentMidpoint?.x) || 0;
  const currentY = Number(currentMidpoint?.y) || 0;
  const tx = currentX - (startX - (Number(baseTx) || 0)) * ratio;
  const ty = currentY - (startY - (Number(baseTy) || 0)) * ratio;
  return constrainPresentationTransform({ scale, tx, ty, width, height });
}

export function invertPresentationPoint(point, transform = {}) {
  const scale = clampPresentationScale(transform.scale);
  return {
    x: ((Number(point?.x) || 0) - (Number(transform.tx) || 0)) / scale,
    y: ((Number(point?.y) || 0) - (Number(transform.ty) || 0)) / scale,
  };
}
