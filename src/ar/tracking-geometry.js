function asPositive(value, fallback = 1) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Mirrors CSS `object-fit: cover` so calibration handles and ImageBitmap pixels
 * describe the same point in the camera image.
 */
export function getCoveredVideoGeometry(videoSize, displaySize) {
  const videoWidth = asPositive(videoSize?.width);
  const videoHeight = asPositive(videoSize?.height);
  const displayWidth = asPositive(displaySize?.width);
  const displayHeight = asPositive(displaySize?.height);
  const scale = Math.max(displayWidth / videoWidth, displayHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  return {
    renderedWidth,
    renderedHeight,
    offsetX: (renderedWidth - displayWidth) / 2,
    offsetY: (renderedHeight - displayHeight) / 2,
  };
}

export function displayPointToVideo(point, videoSize, displaySize) {
  const geometry = getCoveredVideoGeometry(videoSize, displaySize);
  return {
    x: (point.x + geometry.offsetX) / geometry.renderedWidth,
    y: (point.y + geometry.offsetY) / geometry.renderedHeight,
  };
}

export function videoPointToDisplay(point, videoSize, displaySize) {
  const geometry = getCoveredVideoGeometry(videoSize, displaySize);
  return {
    x: point.x * geometry.renderedWidth - geometry.offsetX,
    y: point.y * geometry.renderedHeight - geometry.offsetY,
  };
}

function positiveNumber(value, fallback) {
  return Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function finiteCoordinate(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function lensDimensions(value) {
  if (value && typeof value === 'object') {
    return {
      width: positiveNumber(value.width, 100),
      height: positiveNumber(value.height, 100),
    };
  }
  const size = positiveNumber(value, 100);
  return { width: size, height: size };
}

/**
 * Returns an intrinsic-video crop and its destination rectangle in the loupe.
 * The requested crop is deliberately not shifted back into the video when it
 * reaches an edge: the selected display point therefore stays at the exact
 * centre and the clipped part is represented by empty lens space.
 */
export function getLoupeSourceCrop(point, videoSize, displaySize, {
  zoom = 3,
  lensSize = 100,
} = {}) {
  const videoWidth = positiveNumber(videoSize?.width, 1);
  const videoHeight = positiveNumber(videoSize?.height, 1);
  const displayWidth = positiveNumber(displaySize?.width, 1);
  const displayHeight = positiveNumber(displaySize?.height, 1);
  const lens = lensDimensions(lensSize);
  const safeZoom = positiveNumber(zoom, 3);
  const geometry = getCoveredVideoGeometry(
    { width: videoWidth, height: videoHeight },
    { width: displayWidth, height: displayHeight },
  );
  const normalized = displayPointToVideo(
    { x: finiteCoordinate(point?.x, displayWidth / 2), y: finiteCoordinate(point?.y, displayHeight / 2) },
    { width: videoWidth, height: videoHeight },
    { width: displayWidth, height: displayHeight },
  );
  const centerX = normalized.x * videoWidth;
  const centerY = normalized.y * videoHeight;
  const cropWidth = lens.width / (geometry.renderedWidth / videoWidth * safeZoom);
  const cropHeight = lens.height / (geometry.renderedHeight / videoHeight * safeZoom);
  const requested = {
    x: centerX - cropWidth / 2,
    y: centerY - cropHeight / 2,
    width: cropWidth,
    height: cropHeight,
  };
  const sourceX = Math.max(0, requested.x);
  const sourceY = Math.max(0, requested.y);
  const sourceRight = Math.min(videoWidth, requested.x + requested.width);
  const sourceBottom = Math.min(videoHeight, requested.y + requested.height);
  const sourceWidth = Math.max(0, sourceRight - sourceX);
  const sourceHeight = Math.max(0, sourceBottom - sourceY);
  return {
    center: { x: lens.width / 2, y: lens.height / 2 },
    requested,
    source: { x: sourceX, y: sourceY, width: sourceWidth, height: sourceHeight },
    destination: {
      x: (sourceX - requested.x) * (lens.width / cropWidth),
      y: (sourceY - requested.y) * (lens.height / cropHeight),
      width: sourceWidth * (lens.width / cropWidth),
      height: sourceHeight * (lens.height / cropHeight),
    },
    videoPoint: { x: centerX, y: centerY },
    zoom: safeZoom,
  };
}

/**
 * Chooses a lens position beside a calibration point. The candidate order
 * prefers upper-right, then flips around the point as needed. A final clamp
 * keeps the lens within the overlay when the point is near an edge.
 */
export function getCalibrationLoupePlacement(point, overlaySize, lensSize, pointerType = 'mouse') {
  const width = positiveNumber(overlaySize?.width, 1);
  const height = positiveNumber(overlaySize?.height, 1);
  const lens = lensDimensions(lensSize);
  const x = finiteCoordinate(point?.x, width / 2);
  const y = finiteCoordinate(point?.y, height / 2);
  const gap = String(pointerType).toLowerCase() === 'touch' || String(pointerType).toLowerCase() === 'pen' ? 34 : 18;
  const candidates = [
    { left: x + gap, top: y - lens.height - gap, flippedX: false, flippedY: false },
    { left: x - lens.width - gap, top: y - lens.height - gap, flippedX: true, flippedY: false },
    { left: x + gap, top: y + gap, flippedX: false, flippedY: true },
    { left: x - lens.width - gap, top: y + gap, flippedX: true, flippedY: true },
  ];
  const fits = (candidate) => candidate.left >= 8
    && candidate.top >= 8
    && candidate.left + lens.width <= width - 8
    && candidate.top + lens.height <= height - 8;
  const avoidsPointer = (candidate) => x < candidate.left
    || x > candidate.left + lens.width
    || y < candidate.top
    || y > candidate.top + lens.height;
  const selected = candidates.find((candidate) => fits(candidate) && avoidsPointer(candidate))
    || candidates.find(fits)
    || candidates[0];
  return {
    left: Math.max(8, Math.min(width - lens.width - 8, selected.left)),
    top: Math.max(8, Math.min(height - lens.height - 8, selected.top)),
    width: lens.width,
    height: lens.height,
    gap,
    flippedX: selected.flippedX,
    flippedY: selected.flippedY,
  };
}

function smoothingAlpha(cutoff, elapsedSeconds) {
  const safeCutoff = Math.max(0.001, cutoff);
  const safeElapsed = Math.max(0.001, elapsedSeconds);
  const timeConstant = 1 / (2 * Math.PI * safeCutoff);
  return 1 / (1 + timeConstant / safeElapsed);
}

/**
 * A board-pose One Euro filter. One adaptive gain is applied to all four
 * corners, so a noisy corner cannot bend the quadrilateral independently of
 * the other corners. Fast camera motion still raises the cutoff and remains
 * responsive, while low-confidence estimates are damped more heavily.
 */
export function createCornerSmoother({ minCutoff = 1.2, beta = 0.055, derivativeCutoff = 1.0 } = {}) {
  let previousPoints = [];
  let previousRawPoints = [];
  let previousSpeed = 0;
  let previousTimestamp = null;

  function reset() {
    previousPoints = [];
    previousRawPoints = [];
    previousSpeed = 0;
    previousTimestamp = null;
  }

  function filter(points, timestamp = Date.now(), confidence = 1) {
    if (!Array.isArray(points) || points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return [];
    }
    if (previousPoints.length !== points.length || previousTimestamp == null) {
      previousPoints = points.map((point) => ({ ...point }));
      previousRawPoints = points.map((point) => ({ ...point }));
      previousSpeed = 0;
      previousTimestamp = timestamp;
      return points.map((point) => ({ ...point }));
    }

    const elapsedSeconds = Math.max(0.01, Math.min(0.5, (timestamp - previousTimestamp) / 1000));
    const derivativeAlpha = smoothingAlpha(derivativeCutoff, elapsedSeconds);
    const rawSpeed = Math.sqrt(points.reduce((total, point, index) => {
      const previousRaw = previousRawPoints[index];
      return total + (point.x - previousRaw.x) ** 2 + (point.y - previousRaw.y) ** 2;
    }, 0) / points.length) / elapsedSeconds;
    const speed = derivativeAlpha * rawSpeed + (1 - derivativeAlpha) * previousSpeed;
    const safeConfidence = Math.max(0, Math.min(1, Number(confidence) || 0));
    const confidenceWeight = 0.5 + safeConfidence * 0.5;
    const cutoff = (minCutoff + beta * speed) * confidenceWeight;
    const alpha = smoothingAlpha(cutoff, elapsedSeconds);
    const nextPoints = points.map((point, index) => {
      const previous = previousPoints[index];
      return {
        x: alpha * point.x + (1 - alpha) * previous.x,
        y: alpha * point.y + (1 - alpha) * previous.y,
      };
    });
    previousRawPoints = points.map((point) => ({ ...point }));
    previousPoints = nextPoints.map((point) => ({ ...point }));
    previousSpeed = speed;
    previousTimestamp = timestamp;
    return nextPoints;
  }

  return { filter, reset };
}
