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

function smoothingAlpha(cutoff, elapsedSeconds) {
  const safeCutoff = Math.max(0.001, cutoff);
  const safeElapsed = Math.max(0.001, elapsedSeconds);
  const timeConstant = 1 / (2 * Math.PI * safeCutoff);
  return 1 / (1 + timeConstant / safeElapsed);
}

/**
 * A small One Euro filter. Low-speed pose updates are smoothed aggressively;
 * fast, intentional camera moves receive a higher cutoff and remain responsive.
 */
export function createCornerSmoother({ minCutoff = 1.2, beta = 0.055, derivativeCutoff = 1.0 } = {}) {
  let previousPoints = [];
  let previousRawPoints = [];
  let previousDerivatives = [];
  let previousTimestamp = null;

  function reset() {
    previousPoints = [];
    previousRawPoints = [];
    previousDerivatives = [];
    previousTimestamp = null;
  }

  function filter(points, timestamp = Date.now()) {
    if (!Array.isArray(points) || points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
      return [];
    }
    if (previousPoints.length !== points.length || previousTimestamp == null) {
      previousPoints = points.map((point) => ({ ...point }));
      previousRawPoints = points.map((point) => ({ ...point }));
      previousDerivatives = points.map(() => ({ x: 0, y: 0 }));
      previousTimestamp = timestamp;
      return points.map((point) => ({ ...point }));
    }

    const elapsedSeconds = Math.max(0.01, Math.min(0.5, (timestamp - previousTimestamp) / 1000));
    const derivativeAlpha = smoothingAlpha(derivativeCutoff, elapsedSeconds);
    const nextPoints = points.map((point, index) => {
      const previousRaw = previousRawPoints[index];
      const previousDerivative = previousDerivatives[index];
      const rawDerivative = {
        x: (point.x - previousRaw.x) / elapsedSeconds,
        y: (point.y - previousRaw.y) / elapsedSeconds,
      };
      const derivative = {
        x: derivativeAlpha * rawDerivative.x + (1 - derivativeAlpha) * previousDerivative.x,
        y: derivativeAlpha * rawDerivative.y + (1 - derivativeAlpha) * previousDerivative.y,
      };
      const cutoff = minCutoff + beta * Math.hypot(derivative.x, derivative.y);
      const alpha = smoothingAlpha(cutoff, elapsedSeconds);
      const previous = previousPoints[index];
      previousDerivatives[index] = derivative;
      return {
        x: alpha * point.x + (1 - alpha) * previous.x,
        y: alpha * point.y + (1 - alpha) * previous.y,
      };
    });
    previousRawPoints = points.map((point) => ({ ...point }));
    previousPoints = nextPoints.map((point) => ({ ...point }));
    previousTimestamp = timestamp;
    return nextPoints;
  }

  return { filter, reset };
}
