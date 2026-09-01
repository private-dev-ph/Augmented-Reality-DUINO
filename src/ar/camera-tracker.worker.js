/* global importScripts */

(() => {
const OPENCV_SCRIPT_URL = '/vendor/opencv/opencv-4.13.0-arduino-r2.js';
const OPENCV_WASM_URL = '/vendor/opencv/opencv-4.13.0-arduino-r2.wasm';
const CALIBRATION_MAX_EDGE = 1100;
const CANONICAL_LONG_EDGE = 640;
const EDGE_DETECTION_MAX_EDGE = 640;
const MIN_REFERENCE_FEATURES = 45;
const MAX_REFERENCE_FEATURES = 520;
const MAX_CURRENT_FEATURES = 760;
const MAX_FLOW_POINTS = 220;
const MIN_FEATURE_MATCHES = 10;
const MIN_FEATURE_INLIERS = 8;
const MIN_FLOW_INLIERS = 8;
const MIN_FLOW_CONTINUITY_POINTS = 6;
const FLOW_GRACE_FRAMES = 3;
const MAX_LIVE_REFERENCE_VIEWS = 6;
const FEATURE_GRID_COLUMNS = 4;
const FEATURE_GRID_ROWS = 3;
const ATLAS_POSES = [
  { id: 'front', pitch: 0, yaw: 0, roll: 0, scale: 1 },
  { id: 'yaw-left-42', pitch: 0, yaw: -42, roll: 0, scale: 1 },
  { id: 'yaw-right-42', pitch: 0, yaw: 42, roll: 0, scale: 1 },
  { id: 'yaw-left-58', pitch: 0, yaw: -58, roll: 0, scale: 1 },
  { id: 'yaw-right-58', pitch: 0, yaw: 58, roll: 0, scale: 1 },
  { id: 'pitch-up-48', pitch: -48, yaw: 0, roll: 0, scale: 1 },
  { id: 'pitch-down-48', pitch: 48, yaw: 0, roll: 0, scale: 1 },
  { id: 'roll-left-25', pitch: 0, yaw: 0, roll: -25, scale: 0.96 },
  { id: 'roll-right-25', pitch: 0, yaw: 0, roll: 25, scale: 0.96 },
  { id: 'roll-left-45', pitch: 0, yaw: 0, roll: -45, scale: 0.9 },
  { id: 'roll-right-45', pitch: 0, yaw: 0, roll: 45, scale: 0.9 },
  { id: 'diagonal-nw', pitch: -25, yaw: -42, roll: 0, scale: 1 },
  { id: 'diagonal-ne', pitch: -25, yaw: 42, roll: 0, scale: 1 },
  { id: 'diagonal-sw', pitch: 25, yaw: -42, roll: 0, scale: 1 },
  { id: 'diagonal-se', pitch: 25, yaw: 42, roll: 0, scale: 1 },
];

let cv = null;
let detector = null;
let matcher = null;
let runtimeReady = false;
let operationQueue = Promise.resolve();
let canvas = null;
let frameContext = null;
let reference = null;
let previousGray = null;
let flowImagePoints = null;
let flowCanonicalPoints = [];
let frameWidth = 0;
let frameHeight = 0;
let frameNumber = 0;
let missedFrames = 0;
let trackingState = 'READY';
let lastPose = null;
let lastAcceptedAt = 0;
let lastWinningViewId = 'front';
let profile = { name: 'balanced', maxEdge: 640, anchorInterval: 5 };
let debugEnabled = false;

self.Module = {
  locateFile(path) {
    if (String(path).endsWith('.wasm')) return new URL(OPENCV_WASM_URL, self.location.origin).href;
    return new URL(path, new URL(OPENCV_SCRIPT_URL, self.location.origin)).href;
  },
};

function safeDelete(value) {
  try {
    value?.delete?.();
  } catch {
    // OpenCV heap cleanup is best-effort during worker shutdown/error paths.
  }
}

function radians(degrees) {
  return degrees * Math.PI / 180;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function flattenPoints(points) {
  return points.flatMap((point) => [point.x, point.y]);
}

function pointMat(points) {
  return cv.matFromArray(points.length, 1, cv.CV_32FC2, flattenPoints(points));
}

function matrixArray(matrix) {
  const source = matrix?.data64F?.length >= 9 ? matrix.data64F : matrix?.data32F;
  return source?.length >= 9 ? Array.from(source.slice(0, 9)) : null;
}

function project(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-9) return null;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function invertMatrix(matrix) {
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const A = e * i - f * h;
  const B = c * h - b * i;
  const C = b * f - c * e;
  const D = f * g - d * i;
  const E = a * i - c * g;
  const F = c * d - a * f;
  const G = d * h - e * g;
  const H = b * g - a * h;
  const I = a * e - b * d;
  const determinant = a * A + b * D + c * G;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-10) return null;
  return [A / determinant, B / determinant, C / determinant, D / determinant, E / determinant, F / determinant, G / determinant, H / determinant, I / determinant];
}

function signedArea(points) {
  return points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0) / 2;
}

function isConvexQuad(points) {
  if (!Array.isArray(points) || points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  let direction = 0;
  for (let index = 0; index < 4; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % 4];
    const third = points[(index + 2) % 4];
    const cross = (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x);
    if (Math.abs(cross) < 1e-6) return false;
    const nextDirection = Math.sign(cross);
    if (direction && nextDirection !== direction) return false;
    direction = nextDirection;
  }
  return Math.abs(signedArea(points)) > 1e-6;
}

function validateCalibrationQuad(points, width, height) {
  if (!isConvexQuad(points)) return false;
  const minimumEdge = Math.max(18, Math.min(width, height) * 0.04);
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    if (Math.hypot(next.x - points[index].x, next.y - points[index].y) < minimumEdge) return false;
  }
  return Math.abs(signedArea(points)) >= width * height * 0.018;
}

function canonicalCorners(width = reference?.width, height = reference?.height) {
  return [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
}

function ensureCanvas(sourceWidth, sourceHeight, maximumEdge) {
  const scale = Math.min(1, maximumEdge / Math.max(sourceWidth, sourceHeight));
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (!canvas) {
    canvas = new OffscreenCanvas(width, height);
    frameContext = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  } else if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function bitmapToGray(bitmap, maximumEdge) {
  const size = ensureCanvas(bitmap.width, bitmap.height, maximumEdge);
  try {
    frameContext.drawImage(bitmap, 0, 0, size.width, size.height);
  } finally {
    bitmap.close();
  }
  const imageData = frameContext.getImageData(0, 0, size.width, size.height);
  const rgba = cv.matFromImageData(imageData);
  const gray = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  } finally {
    rgba.delete();
  }
  return gray;
}

function edgeSearchBounds(points, width, height, expansionRatio) {
  const safeExpansion = clamp(Number(expansionRatio) || 0.1, 0.04, 0.2);
  const minX = Math.min(...points.map((point) => point.x));
  const maxX = Math.max(...points.map((point) => point.x));
  const minY = Math.min(...points.map((point) => point.y));
  const maxY = Math.max(...points.map((point) => point.y));
  const marginX = Math.max(4, (maxX - minX) * safeExpansion);
  const marginY = Math.max(4, (maxY - minY) * safeExpansion);
  return {
    x0: clamp(Math.floor(minX - marginX), 0, width - 1),
    y0: clamp(Math.floor(minY - marginY), 0, height - 1),
    x1: clamp(Math.ceil(maxX + marginX), 0, width - 1),
    y1: clamp(Math.ceil(maxY + marginY), 0, height - 1),
  };
}

function buildGradient(gray) {
  const width = gray.cols;
  const height = gray.rows;
  const pixels = gray.data;
  const gradientX = new Float32Array(width * height);
  const gradientY = new Float32Array(width * height);
  const magnitude = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y += 1) {
    const row = y * width;
    for (let x = 1; x < width - 1; x += 1) {
      const index = row + x;
      const gx = (pixels[index + 1] - pixels[index - 1]) * 0.5;
      const gy = (pixels[index + width] - pixels[index - width]) * 0.5;
      gradientX[index] = gx;
      gradientY[index] = gy;
      magnitude[index] = Math.hypot(gx, gy);
    }
  }
  return { gradientX, gradientY, magnitude };
}

function gradientThreshold(magnitude, width, bounds) {
  let count = 0;
  let total = 0;
  let squared = 0;
  for (let y = bounds.y0 + 1; y < bounds.y1; y += 3) {
    for (let x = bounds.x0 + 1; x < bounds.x1; x += 3) {
      const value = magnitude[y * width + x];
      total += value;
      squared += value * value;
      count += 1;
    }
  }
  const mean = total / Math.max(1, count);
  const deviation = Math.sqrt(Math.max(0, squared / Math.max(1, count) - mean * mean));
  return Math.max(7, mean + deviation * 0.35);
}

function sampleDirectionalGradient(gradients, width, height, point, normal) {
  const x = Math.round(point.x);
  const y = Math.round(point.y);
  if (x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return 0;
  const index = y * width + x;
  return Math.abs(gradients.gradientX[index] * normal.x + gradients.gradientY[index] * normal.y);
}

function scoreCandidateLine(gradients, width, height, bounds, segment, offset, angle, threshold) {
  const baseTangent = {
    x: segment.x / segment.length,
    y: segment.y / segment.length,
  };
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const tangent = {
    x: baseTangent.x * cosine - baseTangent.y * sine,
    y: baseTangent.x * sine + baseTangent.y * cosine,
  };
  const normal = { x: -tangent.y, y: tangent.x };
  const center = {
    x: segment.cx + segment.normal.x * offset,
    y: segment.cy + segment.normal.y * offset,
  };
  const sampleCount = clamp(Math.round(segment.length / 2), 56, 220);
  let total = 0;
  let strong = 0;
  let run = 0;
  let longestRun = 0;
  let used = 0;
  for (let index = 0; index < sampleCount; index += 1) {
    const progress = -0.08 + (index / Math.max(1, sampleCount - 1)) * 1.16;
    const point = {
      x: center.x + tangent.x * segment.length * (progress - 0.5),
      y: center.y + tangent.y * segment.length * (progress - 0.5),
    };
    if (point.x < bounds.x0 || point.y < bounds.y0 || point.x > bounds.x1 || point.y > bounds.y1) {
      run = 0;
      continue;
    }
    const value = sampleDirectionalGradient(gradients, width, height, point, normal);
    total += value;
    used += 1;
    if (value >= threshold) {
      strong += 1;
      run += 1;
      longestRun = Math.max(longestRun, run);
    } else {
      run = 0;
    }
  }
  if (used < sampleCount * 0.55) return null;
  const coverage = strong / Math.max(1, used);
  const continuity = longestRun / Math.max(1, used);
  if (coverage < 0.22 || continuity < 0.08) return null;
  const mean = total / Math.max(1, used);
  return {
    point: center,
    tangent,
    normal,
    score: mean * (0.35 + coverage * 0.65) * (0.65 + continuity * 0.35),
    coverage,
    continuity,
  };
}

function lineIntersection(first, second) {
  const denominator = first.tangent.x * second.tangent.y - first.tangent.y * second.tangent.x;
  if (Math.abs(denominator) < 1e-5) return null;
  const delta = { x: second.point.x - first.point.x, y: second.point.y - first.point.y };
  const alongFirst = (delta.x * second.tangent.y - delta.y * second.tangent.x) / denominator;
  return {
    x: first.point.x + first.tangent.x * alongFirst,
    y: first.point.y + first.tangent.y * alongFirst,
  };
}

function detectBoardEdges(bitmap, normalizedPoints, expansionRatio = 0.1) {
  const startedAt = performance.now();
  let gray = null;
  try {
    gray = bitmapToGray(bitmap, EDGE_DETECTION_MAX_EDGE);
    const width = gray.cols;
    const height = gray.rows;
    const initial = normalizedPoints.map((point) => ({
      x: clamp(Number(point.x), 0, 1) * Math.max(1, width - 1),
      y: clamp(Number(point.y), 0, 1) * Math.max(1, height - 1),
    }));
    if (initial.length !== 4 || !isConvexQuad(initial)) throw new Error('The four calibration corners do not form a valid board quadrilateral.');
    const bounds = edgeSearchBounds(initial, width, height, expansionRatio);
    const gradients = buildGradient(gray);
    const threshold = gradientThreshold(gradients.magnitude, width, bounds);
    const sides = [];
    const sideScores = [];
    for (let sideIndex = 0; sideIndex < 4; sideIndex += 1) {
      const start = initial[sideIndex];
      const end = initial[(sideIndex + 1) % 4];
      const delta = { x: end.x - start.x, y: end.y - start.y };
      const length = Math.hypot(delta.x, delta.y);
      if (!Number.isFinite(length) || length < 12) throw new Error('The calibration area is too small for edge detection.');
      const tangent = { x: delta.x / length, y: delta.y / length };
      const normal = { x: -tangent.y, y: tangent.x };
      const segment = {
        x: delta.x,
        y: delta.y,
        length,
        cx: (start.x + end.x) / 2,
        cy: (start.y + end.y) / 2,
        normal,
      };
      const offsetLimit = Math.max(4, Math.min(Math.max(width, height) * 0.14, length * 0.18));
      let best = null;
      let second = null;
      for (let angleIndex = -3; angleIndex <= 3; angleIndex += 1) {
        const angle = angleIndex * radians(5);
        for (let offsetIndex = -14; offsetIndex <= 14; offsetIndex += 1) {
          const offset = (offsetIndex / 14) * offsetLimit;
          const candidate = scoreCandidateLine(gradients, width, height, bounds, segment, offset, angle, threshold);
          if (!candidate) continue;
          if (!best || candidate.score > best.score) {
            second = best;
            best = candidate;
          } else if (!second || candidate.score > second.score) {
            second = candidate;
          }
        }
      }
      if (!best || best.score < threshold * 0.3) throw new Error(`The ${['top', 'right', 'bottom', 'left'][sideIndex]} board edge is not clear enough.`);
      const margin = second?.score > 0 ? best.score / second.score : 2;
      if (margin < 1.015) throw new Error(`The ${['top', 'right', 'bottom', 'left'][sideIndex]} board edge is ambiguous.`);
      sides.push(best);
      sideScores.push({ score: Math.round(best.score * 100) / 100, coverage: Math.round(best.coverage * 1000) / 1000 });
    }
    const result = [
      lineIntersection(sides[3], sides[0]),
      lineIntersection(sides[0], sides[1]),
      lineIntersection(sides[1], sides[2]),
      lineIntersection(sides[2], sides[3]),
    ];
    const initialArea = Math.abs(signedArea(initial));
    const resultArea = Math.abs(signedArea(result));
    const displacement = result.reduce((max, point, index) => Math.max(max, Math.hypot(point.x - initial[index].x, point.y - initial[index].y)), 0);
    if (!isConvexQuad(result) || !validateCalibrationQuad(result, width, height)) throw new Error('The detected edges do not form a usable board quadrilateral.');
    if (result.some((point) => point.x < bounds.x0 - 3 || point.y < bounds.y0 - 3 || point.x > bounds.x1 + 3 || point.y > bounds.y1 + 3)) throw new Error('The detected edges moved outside the calibration area.');
    if (resultArea < initialArea * 0.5 || resultArea > initialArea * 1.7 || displacement > Math.max(width, height) * 0.22) throw new Error('The detected edges moved too far from the calibration corners.');
    const averageScore = sideScores.reduce((sum, side) => sum + side.score, 0) / 4;
    const averageCoverage = sideScores.reduce((sum, side) => sum + side.coverage, 0) / 4;
    return {
      points: result.map((point) => ({ x: point.x / Math.max(1, width - 1), y: point.y / Math.max(1, height - 1) })),
      confidence: clamp((averageScore / Math.max(threshold * 2, 1)) * averageCoverage, 0, 1),
      diagnostics: {
        processingMs: Math.round((performance.now() - startedAt) * 10) / 10,
        searchBounds: {
          x: Math.round(bounds.x0 / Math.max(1, width - 1) * 1000) / 1000,
          y: Math.round(bounds.y0 / Math.max(1, height - 1) * 1000) / 1000,
          width: Math.round((bounds.x1 - bounds.x0) / Math.max(1, width - 1) * 1000) / 1000,
          height: Math.round((bounds.y1 - bounds.y0) / Math.max(1, height - 1) * 1000) / 1000,
        },
        sideScores,
      },
    };
  } finally {
    safeDelete(gray);
  }
}

function analyze(gray) {
  const pixels = gray.data;
  let total = 0;
  let totalSquared = 0;
  let edges = 0;
  let samples = 0;
  for (let y = 2; y < gray.rows - 4; y += 4) {
    for (let x = 2; x < gray.cols - 4; x += 4) {
      const index = y * gray.cols + x;
      const luminance = pixels[index];
      total += luminance;
      totalSquared += luminance * luminance;
      edges += Math.abs(luminance - pixels[index + 4]) + Math.abs(luminance - pixels[index + 4 * gray.cols]);
      samples += 1;
    }
  }
  const mean = total / Math.max(1, samples);
  return {
    brightness: Math.round(mean),
    contrast: Math.round(Math.sqrt(Math.max(0, totalSquared / Math.max(1, samples) - mean * mean))),
    edgeStrength: Math.round(edges / Math.max(1, samples)),
  };
}

function createInteriorMask(width, height, insetRatio = 0.03) {
  const mask = new cv.Mat(height, width, cv.CV_8UC1);
  mask.data.fill(0);
  const insetX = Math.max(3, Math.round(width * insetRatio));
  const insetY = Math.max(3, Math.round(height * insetRatio));
  for (let y = insetY; y < height - insetY; y += 1) {
    mask.data.fill(255, y * width + insetX, y * width + width - insetX);
  }
  return mask;
}

function distributeCandidates(candidates, width, height, limit, columns = FEATURE_GRID_COLUMNS, rows = FEATURE_GRID_ROWS) {
  const buckets = Array.from({ length: columns * rows }, () => []);
  for (const candidate of candidates) {
    const column = clamp(Math.floor(candidate.point.x / Math.max(1, width) * columns), 0, columns - 1);
    const row = clamp(Math.floor(candidate.point.y / Math.max(1, height) * rows), 0, rows - 1);
    buckets[row * columns + column].push(candidate);
  }
  for (const bucket of buckets) bucket.sort((left, right) => right.response - left.response);
  const selected = [];
  let offset = 0;
  while (selected.length < limit) {
    let added = false;
    for (const bucket of buckets) {
      if (!bucket[offset]) continue;
      selected.push(bucket[offset]);
      added = true;
      if (selected.length === limit) break;
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

function copyDescriptorRows(descriptors, selected) {
  const copied = new cv.Mat(selected.length, descriptors.cols, descriptors.type());
  const rowBytes = descriptors.cols;
  selected.forEach((candidate, outputIndex) => {
    const start = candidate.index * rowBytes;
    copied.data.set(descriptors.data.subarray(start, start + rowBytes), outputIndex * rowBytes);
  });
  return copied;
}

function extractFeatures(gray, mask, mapPoint, featureWidth, featureHeight, limit) {
  const keypoints = new cv.KeyPointVector();
  const descriptors = new cv.Mat();
  const emptyMask = mask ? null : new cv.Mat();
  try {
    detector.detectAndCompute(gray, mask || emptyMask, keypoints, descriptors);
    if (!descriptors.rows || !descriptors.cols) return { points: [], descriptors: new cv.Mat() };
    const candidates = [];
    for (let index = 0; index < keypoints.size(); index += 1) {
      const keypoint = keypoints.get(index);
      const mapped = mapPoint({ x: keypoint.pt.x, y: keypoint.pt.y });
      if (!mapped || !Number.isFinite(mapped.x) || !Number.isFinite(mapped.y)) continue;
      if (mapped.x < 2 || mapped.y < 2 || mapped.x >= featureWidth - 2 || mapped.y >= featureHeight - 2) continue;
      candidates.push({ index, point: mapped, response: Number(keypoint.response) || 0 });
    }
    const selected = distributeCandidates(candidates, featureWidth, featureHeight, limit);
    return {
      points: selected.map((candidate) => candidate.point),
      descriptors: copyDescriptorRows(descriptors, selected),
    };
  } finally {
    safeDelete(emptyMask);
    descriptors.delete();
    keypoints.delete();
  }
}

function poseDestination(pose, width, height, boardAspect) {
  const halfWidth = boardAspect / 2;
  const halfHeight = 0.5;
  const source = [
    { x: -halfWidth, y: -halfHeight, z: 0 },
    { x: halfWidth, y: -halfHeight, z: 0 },
    { x: halfWidth, y: halfHeight, z: 0 },
    { x: -halfWidth, y: halfHeight, z: 0 },
  ];
  const pitch = radians(pose.pitch);
  const yaw = radians(pose.yaw);
  const roll = radians(pose.roll);
  const cosPitch = Math.cos(pitch);
  const sinPitch = Math.sin(pitch);
  const cosYaw = Math.cos(yaw);
  const sinYaw = Math.sin(yaw);
  const cosRoll = Math.cos(roll);
  const sinRoll = Math.sin(roll);
  const distance = 2.6 * Math.hypot(halfWidth, halfHeight);
  const projected = source.map((point) => {
    const yPitch = point.y * cosPitch - point.z * sinPitch;
    const zPitch = point.y * sinPitch + point.z * cosPitch;
    const xYaw = point.x * cosYaw + zPitch * sinYaw;
    const zYaw = -point.x * sinYaw + zPitch * cosYaw;
    const xRoll = xYaw * cosRoll - yPitch * sinRoll;
    const yRoll = xYaw * sinRoll + yPitch * cosRoll;
    const denominator = distance + zYaw;
    if (denominator <= distance * 0.25) return null;
    return { x: xRoll / denominator, y: yRoll / denominator };
  });
  if (projected.some((point) => !point)) return null;
  const minX = Math.min(...projected.map((point) => point.x));
  const maxX = Math.max(...projected.map((point) => point.x));
  const minY = Math.min(...projected.map((point) => point.y));
  const maxY = Math.max(...projected.map((point) => point.y));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const scale = pose.scale * 0.9 * Math.min(width / Math.max(1e-6, maxX - minX), height / Math.max(1e-6, maxY - minY));
  const destination = projected.map((point) => ({
    x: width / 2 + scale * (point.x - centerX),
    y: height / 2 + scale * (point.y - centerY),
  }));
  return isConvexQuad(destination) ? destination : null;
}

function disposeViews(views) {
  for (const view of views || []) safeDelete(view.descriptors);
}

function disposeReference() {
  disposeViews(reference?.views);
  reference = null;
  lastPose = null;
  lastWinningViewId = 'front';
}

function discardFlow() {
  safeDelete(previousGray);
  safeDelete(flowImagePoints);
  previousGray = null;
  flowImagePoints = null;
  flowCanonicalPoints = [];
  frameWidth = 0;
  frameHeight = 0;
}

function buildAtlas(canonicalGray, canonicalMask, width, height, boardAspect) {
  const views = [];
  const sourceCorners = canonicalCorners(width, height);
  const sourceMat = pointMat(sourceCorners);
  try {
    for (let index = 0; index < ATLAS_POSES.length; index += 1) {
      const pose = ATLAS_POSES[index];
      let warped = canonicalGray;
      let warpedMask = canonicalMask;
      let transform = null;
      let inverse = [1, 0, 0, 0, 1, 0, 0, 0, 1];
      try {
        if (pose.id !== 'front') {
          const destination = poseDestination(pose, width, height, boardAspect);
          if (!destination) continue;
          const destinationMat = pointMat(destination);
          try {
            transform = cv.getPerspectiveTransform(sourceMat, destinationMat);
          } finally {
            destinationMat.delete();
          }
          const transformArray = matrixArray(transform);
          inverse = transformArray && invertMatrix(transformArray);
          if (!inverse) continue;
          warped = new cv.Mat();
          warpedMask = new cv.Mat();
          cv.warpPerspective(canonicalGray, warped, transform, new cv.Size(width, height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
          cv.warpPerspective(canonicalMask, warpedMask, transform, new cv.Size(width, height), cv.INTER_NEAREST, cv.BORDER_CONSTANT, new cv.Scalar(0));
        }
        const features = extractFeatures(
          warped,
          warpedMask,
          (point) => project(inverse, point),
          width,
          height,
          MAX_REFERENCE_FEATURES,
        );
        if (features.points.length >= MIN_FEATURE_INLIERS) {
          views.push({ ...pose, points: features.points, descriptors: features.descriptors });
        } else {
          features.descriptors.delete();
        }
      } finally {
        safeDelete(transform);
        if (warped !== canonicalGray) warped.delete();
        if (warpedMask !== canonicalMask) warpedMask.delete();
      }
      if (index > 0 && index % 3 === 0) {
        self.postMessage({ type: 'state', state: 'calibrating', message: `Building angle references ${index + 1}/${ATLAS_POSES.length}…` });
      }
    }
  } catch (error) {
    disposeViews(views);
    throw error;
  } finally {
    sourceMat.delete();
  }
  return views;
}

function canonicalDimensions(boardAspect) {
  const aspect = clamp(boardAspect, 0.35, 3);
  if (aspect >= 1) {
    return { width: CANONICAL_LONG_EDGE, height: Math.max(220, Math.round(CANONICAL_LONG_EDGE / aspect)), aspect };
  }
  return { width: Math.max(220, Math.round(CANONICAL_LONG_EDGE * aspect)), height: CANONICAL_LONG_EDGE, aspect };
}

function calibrate(bitmap, normalizedPoints, boardAspect) {
  self.postMessage({ type: 'state', state: 'calibrating', message: 'Rectifying the board and building angle references…' });
  const gray = bitmapToGray(bitmap, Math.max(CALIBRATION_MAX_EDGE, profile.maxEdge));
  let canonicalGray = null;
  let canonicalMask = null;
  let cameraToCanonical = null;
  let sourceMat = null;
  let destinationMat = null;
  try {
    const corners = normalizedPoints.map((point) => ({ x: point.x * gray.cols, y: point.y * gray.rows }));
    if (!validateCalibrationQuad(corners, gray.cols, gray.rows)) {
      throw new Error('The selected board corners are crossed, too small, or too close together. Keep the full board visible and adjust all four handles.');
    }
    const dimensions = canonicalDimensions(boardAspect);
    const targetCorners = canonicalCorners(dimensions.width, dimensions.height);
    sourceMat = pointMat(corners);
    destinationMat = pointMat(targetCorners);
    cameraToCanonical = cv.getPerspectiveTransform(sourceMat, destinationMat);
    canonicalGray = new cv.Mat();
    cv.warpPerspective(gray, canonicalGray, cameraToCanonical, new cv.Size(dimensions.width, dimensions.height), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0));
    canonicalMask = createInteriorMask(dimensions.width, dimensions.height);
    const views = buildAtlas(canonicalGray, canonicalMask, dimensions.width, dimensions.height, dimensions.aspect);
    const frontView = views.find((view) => view.id === 'front');
    if (!frontView || frontView.points.length < MIN_REFERENCE_FEATURES || views.length < 5) {
      disposeViews(views);
      throw new Error(`Only ${frontView?.points.length || 0} stable board features were found. Improve diffuse lighting, move closer, focus the camera, and calibrate again.`);
    }
    disposeReference();
    discardFlow();
    reference = {
      width: dimensions.width,
      height: dimensions.height,
      aspect: dimensions.aspect,
      views,
      liveViewCount: 0,
      capturedShapes: [normalizedPoseShape(normalizedPoints)],
    };
    lastPose = normalizedPoints.map((point) => ({ ...point }));
    frameNumber = 0;
    missedFrames = 0;
    trackingState = 'TRACKED';
    lastAcceptedAt = performance.now();
    const featureCount = views.reduce((total, view) => total + view.points.length, 0);
    self.postMessage({ type: 'calibrated', featureCount, viewCount: views.length });
  } finally {
    gray.delete();
    safeDelete(canonicalGray);
    safeDelete(canonicalMask);
    safeDelete(cameraToCanonical);
    safeDelete(sourceMat);
    safeDelete(destinationMat);
  }
}

function createPredictedBoardMask(gray) {
  if (!lastPose || missedFrames > 0) return null;
  const center = lastPose.reduce((total, point) => ({
    x: total.x + point.x * gray.cols / lastPose.length,
    y: total.y + point.y * gray.rows / lastPose.length,
  }), { x: 0, y: 0 });
  const polygon = lastPose.map((point) => ({
    x: center.x + (point.x * gray.cols - center.x) * 1.35,
    y: center.y + (point.y * gray.rows - center.y) * 1.35,
  }));
  const minimumY = Math.max(0, Math.floor(Math.min(...polygon.map((point) => point.y))));
  const maximumY = Math.min(gray.rows - 1, Math.ceil(Math.max(...polygon.map((point) => point.y))));
  const mask = new cv.Mat(gray.rows, gray.cols, cv.CV_8UC1);
  mask.data.fill(0);
  for (let y = minimumY; y <= maximumY; y += 1) {
    const sampleY = y + 0.5;
    const intersections = [];
    for (let index = 0; index < polygon.length; index += 1) {
      const first = polygon[index];
      const second = polygon[(index + 1) % polygon.length];
      if ((first.y <= sampleY && second.y > sampleY) || (second.y <= sampleY && first.y > sampleY)) {
        intersections.push(first.x + (sampleY - first.y) * (second.x - first.x) / (second.y - first.y));
      }
    }
    if (intersections.length < 2) continue;
    const startX = Math.max(0, Math.ceil(Math.min(...intersections)));
    const endX = Math.min(gray.cols, Math.floor(Math.max(...intersections)) + 1);
    if (endX > startX) mask.data.fill(255, y * gray.cols + startX, y * gray.cols + endX);
  }
  return mask;
}

function extractCurrentFeatures(gray, diagnostic) {
  const mask = createPredictedBoardMask(gray);
  if (diagnostic) diagnostic.featureRegion = mask ? 'predicted-board' : 'full-frame';
  try {
    return extractFeatures(
      gray,
      mask,
      (point) => point,
      gray.cols,
      gray.rows,
      MAX_CURRENT_FEATURES,
    );
  } finally {
    safeDelete(mask);
  }
}

function matchView(view, current) {
  if (!view.descriptors.rows || !current.descriptors.rows) return [];
  const pairs = new cv.DMatchVectorVector();
  const candidates = [];
  try {
    matcher.knnMatch(view.descriptors, current.descriptors, pairs, 2);
    const absoluteLimit = Math.max(82, Math.min(140, view.descriptors.cols * 8 * 0.27));
    for (let index = 0; index < pairs.size(); index += 1) {
      const pair = pairs.get(index);
      try {
        if (pair.size() < 2) continue;
        const best = pair.get(0);
        const second = pair.get(1);
        if (best.distance > absoluteLimit || best.distance >= second.distance * 0.77) continue;
        candidates.push({ queryIndex: best.queryIdx, trainIndex: best.trainIdx, distance: best.distance });
      } finally {
        pair.delete();
      }
    }
  } finally {
    pairs.delete();
  }
  const uniqueCurrent = new Map();
  for (const candidate of candidates) {
    const existing = uniqueCurrent.get(candidate.trainIndex);
    if (!existing || candidate.distance < existing.distance) uniqueCurrent.set(candidate.trainIndex, candidate);
  }
  return [...uniqueCurrent.values()]
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 240)
    .map((candidate) => ({
      canonical: view.points[candidate.queryIndex],
      current: current.points[candidate.trainIndex],
      distance: candidate.distance,
    }));
}

function median(values) {
  if (!values.length) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function gridCoverage(points) {
  const occupied = new Set();
  for (const point of points) {
    const column = clamp(Math.floor(point.x / Math.max(1, reference.width) * FEATURE_GRID_COLUMNS), 0, FEATURE_GRID_COLUMNS - 1);
    const row = clamp(Math.floor(point.y / Math.max(1, reference.height) * FEATURE_GRID_ROWS), 0, FEATURE_GRID_ROWS - 1);
    occupied.add(row * FEATURE_GRID_COLUMNS + column);
  }
  return occupied.size;
}

function validateProjectedQuad(points, matrix) {
  if (!isConvexQuad(points)) return false;
  const denominators = canonicalCorners().map((point) => matrix[6] * point.x + matrix[7] * point.y + matrix[8]);
  const sign = Math.sign(denominators[0]);
  if (!sign || denominators.some((value) => Math.sign(value) !== sign || Math.abs(value) < 1e-8)) return false;
  const minimumEdge = Math.max(6, Math.min(frameWidth, frameHeight) * 0.012);
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    if (Math.hypot(next.x - points[index].x, next.y - points[index].y) < minimumEdge) return false;
  }
  const areaRatio = Math.abs(signedArea(points)) / Math.max(1, frameWidth * frameHeight);
  if (areaRatio < 0.0025 || areaRatio > 4) return false;
  return !points.some((point) => point.x < -frameWidth * 0.65 || point.x > frameWidth * 1.65 || point.y < -frameHeight * 0.65 || point.y > frameHeight * 1.65);
}

function estimateCanonicalPose(pairs, kind = 'features', attempt = null) {
  const reject = (reason, details = {}) => {
    if (attempt) Object.assign(attempt, details, { accepted: false, rejectedBy: reason });
    return null;
  };
  const minimumMatches = kind === 'flow' ? MIN_FLOW_INLIERS : MIN_FEATURE_MATCHES;
  if (attempt) Object.assign(attempt, { method: kind, pairs: pairs.length });
  if (pairs.length < minimumMatches) return reject('insufficient-pairs');
  const source = pointMat(pairs.map((pair) => pair.canonical));
  const destination = pointMat(pairs.map((pair) => pair.current));
  const inlierMask = new cv.Mat();
  let homography = null;
  try {
    homography = cv.findHomography(
      source,
      destination,
      cv.RANSAC,
      kind === 'flow' ? 3.5 : 3.5,
      inlierMask,
      kind === 'flow' ? 1200 : 2000,
      0.995,
    );
    const matrix = matrixArray(homography);
    if (!matrix) return reject('homography');
    const inliers = pairs.filter((_, index) => inlierMask.data[index]);
    const minimumInliers = kind === 'flow' ? MIN_FLOW_INLIERS : (missedFrames > 2 ? 10 : MIN_FEATURE_INLIERS);
    const minimumRatio = kind === 'flow' ? 0.48 : 0.3;
    const inlierRatio = inliers.length / pairs.length;
    if (attempt) Object.assign(attempt, { inliers: inliers.length, inlierRatio });
    if (inliers.length < minimumInliers) return reject('inliers');
    if (inlierRatio < minimumRatio) return reject('inlier-ratio');
    const canonical = inliers.map((pair) => pair.canonical);
    const coverage = gridCoverage(canonical);
    if (attempt) attempt.coverage = coverage;
    if (coverage < (kind === 'flow' ? 3 : 4)) return reject('coverage');
    const spanX = (Math.max(...canonical.map((point) => point.x)) - Math.min(...canonical.map((point) => point.x))) / reference.width;
    const spanY = (Math.max(...canonical.map((point) => point.y)) - Math.min(...canonical.map((point) => point.y))) / reference.height;
    if (attempt) Object.assign(attempt, { spanX, spanY });
    if (spanX < (kind === 'flow' ? 0.16 : 0.2) || spanY < (kind === 'flow' ? 0.12 : 0.14)) return reject('span');
    const errors = inliers.map((pair) => {
      const estimated = project(matrix, pair.canonical);
      return estimated ? Math.hypot(estimated.x - pair.current.x, estimated.y - pair.current.y) : 1000;
    });
    const rms = Math.sqrt(errors.reduce((total, value) => total + value ** 2, 0) / errors.length);
    const medianError = median(errors);
    const maximumRms = kind === 'flow' ? 3.5 : 3.8;
    const maximumMedian = kind === 'flow' ? 2.8 : 2.8;
    if (attempt) Object.assign(attempt, { reprojectionError: rms, medianError });
    if (!Number.isFinite(rms) || rms > maximumRms || medianError > maximumMedian) return reject('reprojection');
    const projectedCorners = canonicalCorners().map((point) => project(matrix, point));
    if (projectedCorners.some((point) => !point) || !validateProjectedQuad(projectedCorners, matrix)) return reject('invalid-quad');
    const normalized = projectedCorners.map((point) => ({ x: point.x / frameWidth, y: point.y / frameHeight }));
    if (lastPose && missedFrames <= 2) {
      const jump = Math.max(...normalized.map((point, index) => Math.hypot(point.x - lastPose[index].x, point.y - lastPose[index].y)));
      if (attempt) attempt.poseJump = jump;
      if (jump > 0.55) return reject('pose-jump');
      const guardedJump = missedFrames === 0 ? 0.25 : 0.4;
      if (jump > guardedJump && (inliers.length < 22 || inlierRatio < 0.55 || rms > 2)) return reject('pose-jump');
    }
    const confidence = clamp(
      (inliers.length / Math.min(50, Math.max(inliers.length, pairs.length))) * 0.36
        + inlierRatio * 0.34
        + (coverage / 12) * 0.18
        + Math.max(0, 1 - rms / maximumRms) * 0.12,
      0,
      kind === 'flow' ? 0.94 : 1,
    );
    if (attempt) attempt.accepted = true;
    return {
      confidence,
      inliers: inliers.length,
      matches: pairs.length,
      coverage,
      reprojectionError: rms,
      medianError,
      points: normalized,
      matrix,
      method: kind,
      inlierCanonical: inliers.map((pair) => ({ ...pair.canonical })),
      inlierCurrent: inliers.map((pair) => ({ ...pair.current })),
      score: inliers.length * 2.2 + coverage * 2.5 + inlierRatio * 14 - rms * 3,
    };
  } finally {
    safeDelete(homography);
    inlierMask.delete();
    destination.delete();
    source.delete();
  }
}

function normalizedPoseShape(points) {
  const center = points.reduce((total, point) => ({ x: total.x + point.x / points.length, y: total.y + point.y / points.length }), { x: 0, y: 0 });
  const scale = Math.sqrt(points.reduce((total, point) => total + (point.x - center.x) ** 2 + (point.y - center.y) ** 2, 0) / points.length) || 1;
  return points.map((point) => ({ x: (point.x - center.x) / scale, y: (point.y - center.y) / scale }));
}

function poseShapeDistance(first, second) {
  if (!first?.length || first.length !== second?.length) return Number.POSITIVE_INFINITY;
  return Math.max(...first.map((point, index) => Math.hypot(point.x - second[index].x, point.y - second[index].y)));
}

function nearbyViews(limit = 6) {
  const current = reference.views.find((view) => view.id === lastWinningViewId) || reference.views[0];
  return [...reference.views]
    .sort((left, right) => {
      if (left === current) return -1;
      if (right === current) return 1;
      const leftDistance = (left.yaw - current.yaw) ** 2 + (left.pitch - current.pitch) ** 2 + (left.roll - current.roll) ** 2;
      const rightDistance = (right.yaw - current.yaw) ** 2 + (right.pitch - current.pitch) ** 2 + (right.roll - current.roll) ** 2;
      return leftDistance - rightDistance;
    })
    .slice(0, limit);
}

function normalizedDebugPoints(points, limit = 180) {
  if (!debugEnabled) return [];
  return points.slice(0, limit).map((point) => ({
    x: clamp(point.x / Math.max(1, frameWidth), 0, 1),
    y: clamp(point.y / Math.max(1, frameHeight), 0, 1),
  }));
}

function evaluateViews(views, current, diagnostic) {
  const allMatched = views.map((view) => ({ view, pairs: matchView(view, current) }));
  const ranked = [...allMatched].sort((left, right) => right.pairs.length - left.pairs.length);
  if (diagnostic) {
    diagnostic.featureViews = [
      ...(diagnostic.featureViews || []),
      ...ranked.slice(0, 8).map((entry) => ({ viewId: entry.view.id, matches: entry.pairs.length })),
    ].sort((left, right) => right.matches - left.matches).slice(0, 8);
    const bestMatched = ranked[0];
    if (bestMatched && bestMatched.pairs.length > (diagnostic.bestFeatureMatches || 0)) {
      diagnostic.bestFeatureMatches = bestMatched.pairs.length;
      if (debugEnabled) diagnostic.points.matched = normalizedDebugPoints(bestMatched.pairs.map((pair) => pair.current), 160);
    }
  }
  const matched = ranked
    .filter((entry) => entry.pairs.length >= MIN_FEATURE_MATCHES)
    .slice(0, 4);
  let best = null;
  for (const entry of matched) {
    const attempt = { method: 'features', viewId: entry.view.id, pairs: entry.pairs.length };
    const candidate = estimateCanonicalPose(entry.pairs, 'features', attempt);
    diagnostic?.attempts.push(attempt);
    if (!candidate) continue;
    candidate.sourceViewId = entry.view.id;
    if (!best || candidate.score > best.score) best = candidate;
  }
  return best;
}

function mappedFeatureCandidates(current, candidate, limit = MAX_FLOW_POINTS) {
  const inverse = invertMatrix(candidate.matrix);
  if (!inverse) return [];
  const insetX = reference.width * 0.025;
  const insetY = reference.height * 0.025;
  const candidates = [];
  current.points.forEach((point, index) => {
    const canonical = project(inverse, point);
    if (!canonical) return;
    if (canonical.x < insetX || canonical.y < insetY || canonical.x > reference.width - insetX || canonical.y > reference.height - insetY) return;
    candidates.push({ index, point: canonical, current: point, response: 1 });
  });
  return distributeCandidates(candidates, reference.width, reference.height, limit);
}

function createFeatureFlowSeeds(current, candidate) {
  return mappedFeatureCandidates(current, candidate, MAX_FLOW_POINTS)
    .map((entry) => ({ canonical: { ...entry.point }, current: { ...entry.current } }));
}

function createLiveReferenceView(current, candidate) {
  if (missedFrames > 0 || reference.liveViewCount >= MAX_LIVE_REFERENCE_VIEWS) return null;
  if (candidate.confidence < 0.58 || candidate.inliers < 16 || candidate.coverage < 5 || candidate.reprojectionError > 2.5) return null;
  const shape = normalizedPoseShape(candidate.points);
  if (reference.capturedShapes.some((captured) => poseShapeDistance(captured, shape) < 0.075)) return null;
  const selected = mappedFeatureCandidates(current, candidate, MAX_REFERENCE_FEATURES);
  if (selected.length < MIN_REFERENCE_FEATURES) return null;
  return {
    id: `live-${reference.liveViewCount + 1}`,
    pitch: 0,
    yaw: 0,
    roll: 0,
    scale: 1,
    isLive: true,
    shape,
    points: selected.map((entry) => ({ ...entry.point })),
    descriptors: copyDescriptorRows(current.descriptors, selected),
  };
}

function localizeWithFeatures(gray, diagnostic) {
  const current = extractCurrentFeatures(gray, diagnostic);
  try {
    if (diagnostic) {
      diagnostic.featureCount = current.points.length;
      if (debugEnabled) diagnostic.points.detected = normalizedDebugPoints(current.points, 300);
    }
    if (current.points.length < MIN_FEATURE_MATCHES) {
      if (diagnostic) diagnostic.featureRejectedBy = 'insufficient-current-features';
      return null;
    }
    const primaryViews = missedFrames > 2 ? reference.views : nearbyViews(missedFrames > 0 ? 8 : 6);
    let best = evaluateViews(primaryViews, current, diagnostic);
    if (!best && primaryViews.length < reference.views.length) {
      const primaryIds = new Set(primaryViews.map((view) => view.id));
      best = evaluateViews(reference.views.filter((view) => !primaryIds.has(view.id)), current, diagnostic);
    }
    if (!best && diagnostic && !diagnostic.attempts.length) diagnostic.featureRejectedBy = 'insufficient-view-matches';
    if (best) {
      best.flowSeeds = createFeatureFlowSeeds(current, best);
      best.liveView = createLiveReferenceView(current, best);
    }
    return best;
  } finally {
    current.descriptors.delete();
  }
}

function setFlowPairs(pairs) {
  safeDelete(flowImagePoints);
  const combined = pairs.map((pair, index) => ({
    index,
    point: pair.canonical,
    current: pair.current,
    response: 1,
  }));
  const selected = distributeCandidates(combined, reference.width, reference.height, MAX_FLOW_POINTS);
  flowCanonicalPoints = selected.map((entry) => ({ ...entry.point }));
  flowImagePoints = selected.length ? pointMat(selected.map((entry) => entry.current)) : null;
}

function setFlowPoints(candidate) {
  const pairs = candidate.flowSeeds?.length
    ? candidate.flowSeeds
    : candidate.inlierCanonical.map((point, index) => ({
      canonical: point,
      current: candidate.inlierCurrent[index],
    }));
  setFlowPairs(pairs);
}

function estimateFlow(gray, diagnostic) {
  const flowAttempt = { method: 'flow', seedCount: flowCanonicalPoints.length };
  if (diagnostic) diagnostic.flow = flowAttempt;
  if (!previousGray || !flowImagePoints || flowCanonicalPoints.length < MIN_FLOW_CONTINUITY_POINTS) {
    flowAttempt.accepted = false;
    flowAttempt.rejectedBy = 'no-seeds';
    return { candidate: null, pairs: [] };
  }
  if (previousGray.cols !== gray.cols || previousGray.rows !== gray.rows) {
    flowAttempt.accepted = false;
    flowAttempt.rejectedBy = 'frame-size';
    return { candidate: null, pairs: [] };
  }
  const nextPoints = new cv.Mat();
  const forwardStatus = new cv.Mat();
  const forwardError = new cv.Mat();
  const backPoints = new cv.Mat();
  const backwardStatus = new cv.Mat();
  const backwardError = new cv.Mat();
  try {
    const windowSize = new cv.Size(31, 31);
    const criteria = new cv.TermCriteria(cv.TERM_CRITERIA_COUNT | cv.TERM_CRITERIA_EPS, 30, 0.01);
    cv.calcOpticalFlowPyrLK(previousGray, gray, flowImagePoints, nextPoints, forwardStatus, forwardError, windowSize, 4, criteria, 0, 1e-4);
    cv.calcOpticalFlowPyrLK(gray, previousGray, nextPoints, backPoints, backwardStatus, backwardError, windowSize, 4, criteria, 0, 1e-4);
    const pairs = [];
    let forwardCount = 0;
    let backwardCount = 0;
    for (let index = 0; index < flowCanonicalPoints.length; index += 1) {
      if (!forwardStatus.data[index]) continue;
      forwardCount += 1;
      if (!backwardStatus.data[index]) continue;
      backwardCount += 1;
      const next = { x: nextPoints.data32F[index * 2], y: nextPoints.data32F[index * 2 + 1] };
      const backX = backPoints.data32F[index * 2];
      const backY = backPoints.data32F[index * 2 + 1];
      const previousX = flowImagePoints.data32F[index * 2];
      const previousY = flowImagePoints.data32F[index * 2 + 1];
      if (!Number.isFinite(next.x) || !Number.isFinite(next.y)) continue;
      if (next.x < 3 || next.y < 3 || next.x >= gray.cols - 3 || next.y >= gray.rows - 3) continue;
      if (Math.hypot(backX - previousX, backY - previousY) > 2.5) continue;
      if (forwardError.data32F[index] > 60) continue;
      pairs.push({ canonical: flowCanonicalPoints[index], current: next });
    }
    Object.assign(flowAttempt, { forwardCount, backwardCount, validCount: pairs.length });
    if (debugEnabled && diagnostic) diagnostic.points.flow = normalizedDebugPoints(pairs.map((pair) => pair.current), 180);
    const candidate = estimateCanonicalPose(pairs, 'flow', flowAttempt);
    if (candidate) {
      candidate.flowSeeds = pairs.filter((pair) => {
        const expected = project(candidate.matrix, pair.canonical);
        return expected && Math.hypot(expected.x - pair.current.x, expected.y - pair.current.y) <= 5;
      });
    }
    return { candidate, pairs };
  } finally {
    backwardError.delete();
    backwardStatus.delete();
    backPoints.delete();
    forwardError.delete();
    forwardStatus.delete();
    nextPoints.delete();
  }
}

function updateTrackingState(nextState, extra = {}) {
  if (trackingState === nextState && !extra.relocalized) return;
  trackingState = nextState;
  self.postMessage({ type: 'tracking-state', state: nextState, ...extra });
}

function replacePreviousGray(gray) {
  safeDelete(previousGray);
  previousGray = gray;
  frameWidth = gray.cols;
  frameHeight = gray.rows;
}

function poseDisagreement(first, second) {
  if (!first?.points || !second?.points) return Number.POSITIVE_INFINITY;
  return Math.max(...first.points.map((point, index) => Math.hypot(
    point.x - second.points[index].x,
    point.y - second.points[index].y,
  )));
}

function selectTrackingCandidate(flowCandidate, featureCandidate, diagnostic) {
  if (!flowCandidate) return featureCandidate;
  if (!featureCandidate) return flowCandidate;
  const disagreement = poseDisagreement(flowCandidate, featureCandidate);
  if (diagnostic) diagnostic.candidateDisagreement = disagreement;
  if (disagreement <= 0.045) {
    const winner = featureCandidate.score > flowCandidate.score * 1.12 ? featureCandidate : flowCandidate;
    if (winner === flowCandidate && featureCandidate.flowSeeds?.length) winner.flowSeeds = featureCandidate.flowSeeds;
    return winner;
  }
  if (missedFrames === 0 && flowCandidate.confidence >= 0.45) return flowCandidate;
  return featureCandidate.score > flowCandidate.score * 1.4 ? featureCandidate : flowCandidate;
}

function finalizeLiveReference(featureCandidate, tracking, diagnostic) {
  const liveView = featureCandidate?.liveView;
  if (!liveView) return;
  delete featureCandidate.liveView;
  const agreesWithWinner = tracking === featureCandidate || poseDisagreement(featureCandidate, tracking) <= 0.035;
  if (!agreesWithWinner || reference.liveViewCount >= MAX_LIVE_REFERENCE_VIEWS) {
    liveView.descriptors.delete();
    return;
  }
  reference.liveViewCount += 1;
  reference.capturedShapes.push(liveView.shape);
  reference.views.push(liveView);
  if (diagnostic) {
    diagnostic.learnedView = {
      id: liveView.id,
      featureCount: liveView.points.length,
      liveViewCount: reference.liveViewCount,
    };
  }
}

function track(bitmap) {
  const startedAt = performance.now();
  let gray = bitmapToGray(bitmap, profile.maxEdge);
  const quality = analyze(gray);
  if (!reference) {
    gray.delete();
    return { quality, tracking: null };
  }
  if (previousGray && (previousGray.cols !== gray.cols || previousGray.rows !== gray.rows)) discardFlow();
  frameWidth = gray.cols;
  frameHeight = gray.rows;
  frameNumber += 1;
  const diagnostic = {
    schema: 1,
    timestamp: Date.now(),
    frameNumber,
    frame: { width: frameWidth, height: frameHeight },
    profile: profile.name,
    referenceViewCount: reference.views.length,
    liveViewCount: reference.liveViewCount,
    stateBefore: trackingState,
    missedFramesBefore: missedFrames,
    quality: { ...quality },
    attempts: [],
  };
  if (debugEnabled) diagnostic.points = { detected: [], matched: [], flow: [], inliers: [], corners: [] };
  const flowResult = estimateFlow(gray, diagnostic);
  const flowCandidate = flowResult.candidate;
  const shouldAnchor = !flowCandidate || missedFrames > 0 || frameNumber % profile.anchorInterval === 0;
  diagnostic.anchorAttempted = shouldAnchor;
  const featureCandidate = shouldAnchor ? localizeWithFeatures(gray, diagnostic) : null;
  const tracking = selectTrackingCandidate(flowCandidate, featureCandidate, diagnostic);
  finalizeLiveReference(featureCandidate, tracking, diagnostic);
  if (tracking) {
    const relocalized = missedFrames > 0 || trackingState !== 'TRACKED';
    missedFrames = 0;
    lastAcceptedAt = performance.now();
    lastPose = tracking.points.map((point) => ({ ...point }));
    if (tracking.sourceViewId) lastWinningViewId = tracking.sourceViewId;
    setFlowPoints(tracking);
    updateTrackingState('TRACKED', { relocalized });
    tracking.relocalized = relocalized;
    tracking.processingMs = Math.round((performance.now() - startedAt) * 10) / 10;
    diagnostic.winner = {
      method: tracking.method,
      viewId: tracking.sourceViewId || null,
      confidence: tracking.confidence,
      matches: tracking.matches,
      inliers: tracking.inliers,
      coverage: tracking.coverage,
      reprojectionError: tracking.reprojectionError,
      medianError: tracking.medianError,
      flowSeedCount: flowCanonicalPoints.length,
    };
    if (debugEnabled) {
      diagnostic.points.inliers = normalizedDebugPoints(tracking.inlierCurrent, 180);
      diagnostic.points.corners = tracking.points.map((point) => ({ ...point }));
    }
    delete tracking.matrix;
    delete tracking.inlierCanonical;
    delete tracking.inlierCurrent;
    delete tracking.flowSeeds;
    delete tracking.score;
  } else {
    missedFrames += 1;
    const continuityPairs = flowResult.pairs;
    if (continuityPairs.length >= MIN_FLOW_CONTINUITY_POINTS && missedFrames <= FLOW_GRACE_FRAMES) {
      setFlowPairs(continuityPairs);
      diagnostic.flowContinuityPreserved = true;
    } else {
      safeDelete(flowImagePoints);
      flowImagePoints = null;
      flowCanonicalPoints = [];
      diagnostic.flowContinuityPreserved = false;
    }
    const age = lastAcceptedAt ? performance.now() - lastAcceptedAt : Number.POSITIVE_INFINITY;
    if (missedFrames <= 2 || age < 350) updateTrackingState('SUSPECT');
    else if (age < 1_200) updateTrackingState('RECOVERING');
    else updateTrackingState('LOST');
  }
  replacePreviousGray(gray);
  gray = null;
  quality.processingMs = Math.round((performance.now() - startedAt) * 10) / 10;
  diagnostic.processingMs = quality.processingMs;
  diagnostic.state = trackingState;
  diagnostic.missedFrames = missedFrames;
  diagnostic.flowSeedCount = flowCanonicalPoints.length;
  return { quality, tracking, diagnostic };
}

function resetTracking() {
  disposeReference();
  discardFlow();
  frameNumber = 0;
  missedFrames = 0;
  trackingState = 'READY';
  lastAcceptedAt = 0;
}

function disposeAll() {
  resetTracking();
  safeDelete(detector);
  safeDelete(matcher);
  detector = null;
  matcher = null;
}

function applyProfile(nextProfile) {
  const maximumEdge = clamp(Math.round(Number(nextProfile?.maxEdge) || 640), 480, 720);
  const anchorInterval = clamp(Math.round(Number(nextProfile?.anchorInterval) || 5), 3, 8);
  profile = {
    name: ['battery', 'balanced', 'accuracy'].includes(nextProfile?.name) ? nextProfile.name : 'balanced',
    maxEdge: maximumEdge,
    anchorInterval,
  };
}

function postWorkerError(error, type, requestId = null) {
  const message = error instanceof Error ? error.message : String(error || 'Unexpected on-device tracking error.');
  if (type === 'calibrate') {
    self.postMessage({ type: 'calibration-failed', message });
    return;
  }
  if (type === 'detect-edges') {
    self.postMessage({ type: 'edge-detection-failed', requestId, message });
    return;
  }
  self.postMessage({ type: 'state', state: 'error', message });
  if (type === 'frame') self.postMessage({ type: 'frame' });
}

self.addEventListener('message', (event) => {
  const { type, bitmap, points, boardAspect, requestId, expansionRatio } = event.data || {};
  if (type === 'config') {
    applyProfile(event.data.profile);
    debugEnabled = Boolean(event.data.debugEnabled);
    return;
  }
  if (type === 'video-resize') {
    discardFlow();
    if (reference) {
      missedFrames = 1;
      updateTrackingState('SUSPECT');
    }
    return;
  }
  if (type === 'reset') {
    operationQueue = operationQueue.then(resetTracking);
    return;
  }
  if (type === 'dispose') {
    operationQueue = operationQueue.then(disposeAll);
    return;
  }
  if (!bitmap) return;
  if (!runtimeReady) {
    bitmap.close();
    if (type === 'frame') self.postMessage({ type: 'frame' });
    if (type === 'calibrate') self.postMessage({ type: 'calibration-failed', message: 'The vision runtime is still loading.' });
    if (type === 'detect-edges') self.postMessage({ type: 'edge-detection-failed', requestId, message: 'The vision runtime is still loading.' });
    return;
  }
  operationQueue = operationQueue
    .then(() => {
      if (type === 'calibrate') calibrate(bitmap, points || [], boardAspect);
      else if (type === 'detect-edges') self.postMessage({ type: 'edges-detected', requestId, ...detectBoardEdges(bitmap, points || [], expansionRatio) });
      else if (type === 'frame') self.postMessage({ type: 'frame', ...track(bitmap) });
      else bitmap.close();
    })
    .catch((error) => {
      try { bitmap.close(); } catch { /* already consumed */ }
      postWorkerError(error, type, requestId);
    });
});

try {
  importScripts(OPENCV_SCRIPT_URL);
  Promise.resolve(self.cv)
    .then((runtime) => {
      cv = runtime;
      const missing = [
        ['AKAZE', cv.AKAZE],
        ['BFMatcher', cv.BFMatcher],
        ['KeyPointVector', cv.KeyPointVector],
        ['DMatchVectorVector', cv.DMatchVectorVector],
        ['getPerspectiveTransform', cv.getPerspectiveTransform],
        ['warpPerspective', cv.warpPerspective],
        ['findHomography', cv.findHomography],
        ['calcOpticalFlowPyrLK', cv.calcOpticalFlowPyrLK],
      ].filter(([, api]) => typeof api !== 'function').map(([name]) => name);
      if (missing.length) throw new Error(`The minimized OpenCV runtime is missing: ${missing.join(', ')}.`);
      detector = new cv.AKAZE();
      detector.setThreshold(0.001);
      detector.setNOctaves(4);
      detector.setNOctaveLayers(4);
      detector.setMaxPoints?.(MAX_CURRENT_FEATURES);
      matcher = new cv.BFMatcher(cv.NORM_HAMMING, false);
      runtimeReady = true;
      self.postMessage({ type: 'state', state: 'ready', engine: 'OpenCV 4.13 AKAZE + LK' });
    })
    .catch((error) => postWorkerError(error, 'initialization'));
} catch (error) {
  postWorkerError(error, 'initialization');
}
})();
