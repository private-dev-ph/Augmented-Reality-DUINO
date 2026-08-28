import jsfeat from '@webarkit/jsfeat-next';

const MAX_TRACKING_EDGE = 480;
const MAX_FEATURES = 220;
const MIN_REFERENCE_FEATURES = 30;
const MIN_INLIERS = 12;
const MIN_INLIER_RATIO = 0.28;
const DESCRIPTOR_BYTES = 32;
const MAX_FLOW_POINTS = 80;
const MIN_FLOW_INLIERS = 8;
const FEATURE_REFRESH_INTERVAL = 4;
const RECOVERY_SCALE = 0.74;
const RECOVERY_BASE_FEATURES = 150;
const RECOVERY_SCALED_FEATURES = 110;
const INTERIOR_REGION_SCALE = 0.86;
const FEATURE_GRID_COLUMNS = 4;
const FEATURE_GRID_ROWS = 3;
const POPCOUNT = Uint8Array.from({ length: 256 }, (_, value) => {
  let bits = value;
  let count = 0;
  while (bits) {
    count += bits & 1;
    bits >>>= 1;
  }
  return count;
});

let canvas = null;
let context = null;
let keypointPool = [];
let reference = null;
let lastPose = null;
let missedFrames = 0;
let previousGray = null;
let flowPoints = null;
let frameNumber = 0;
let operationQueue = Promise.resolve();

jsfeat.fast_corners.set_threshold(20);

function ensureCanvas(width, height) {
  const scale = Math.min(1, MAX_TRACKING_EDGE / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (!canvas || canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas = new OffscreenCanvas(targetWidth, targetHeight);
    context = canvas.getContext('2d', { willReadFrequently: true });
    // FAST writes directly into the supplied pool. Dense PCB silkscreen can
    // produce far more corners than the final descriptor budget, so reserve a
    // generous worker-only pool before selecting the strongest 220 features.
    keypointPool = Array.from({ length: Math.min(24000, Math.max(8000, Math.ceil(targetWidth * targetHeight / 6))) }, () => new jsfeat.keypoint_t());
  }
}

function bitmapToGray(bitmap) {
  ensureCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const image = context.getImageData(0, 0, canvas.width, canvas.height);
  const gray = new jsfeat.matrix_t(canvas.width, canvas.height, jsfeat.U8_t | jsfeat.C1_t);
  jsfeat.imgproc.grayscale(image.data, canvas.width, canvas.height, gray);
  return gray;
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

function quadCenter(points) {
  return points.reduce((total, point) => ({ x: total.x + point.x / points.length, y: total.y + point.y / points.length }), { x: 0, y: 0 });
}

function scaleQuad(points, factor) {
  const center = quadCenter(points);
  return points.map((point) => ({
    x: center.x + (point.x - center.x) * factor,
    y: center.y + (point.y - center.y) * factor,
  }));
}

function pointInPolygon(point, polygon) {
  let inside = false;
  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index, index += 1) {
    const first = polygon[index];
    const second = polygon[previous];
    const crosses = (first.y > point.y) !== (second.y > point.y)
      && point.x < (second.x - first.x) * (point.y - first.y) / (second.y - first.y) + first.x;
    if (crosses) inside = !inside;
  }
  return inside;
}

function keypointAngle(gray, x, y) {
  const radius = 15;
  let momentX = 0;
  let momentY = 0;
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    const row = (y + offsetY) * gray.cols + x;
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
      const luminance = gray.data[row + offsetX];
      momentX += offsetX * luminance;
      momentY += offsetY * luminance;
    }
  }
  return Math.atan2(momentY, momentX);
}

function distributeFeatures(candidates, region, maxFeatures) {
  if (!region || candidates.length <= maxFeatures) return candidates.slice(0, maxFeatures);
  const minX = Math.min(...region.map((point) => point.x));
  const maxX = Math.max(...region.map((point) => point.x));
  const minY = Math.min(...region.map((point) => point.y));
  const maxY = Math.max(...region.map((point) => point.y));
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const buckets = Array.from({ length: FEATURE_GRID_COLUMNS * FEATURE_GRID_ROWS }, () => []);
  for (const candidate of candidates) {
    const column = Math.min(FEATURE_GRID_COLUMNS - 1, Math.max(0, Math.floor((candidate.x - minX) / width * FEATURE_GRID_COLUMNS)));
    const row = Math.min(FEATURE_GRID_ROWS - 1, Math.max(0, Math.floor((candidate.y - minY) / height * FEATURE_GRID_ROWS)));
    buckets[row * FEATURE_GRID_COLUMNS + column].push(candidate);
  }
  const selected = [];
  let offset = 0;
  while (selected.length < maxFeatures) {
    let added = false;
    for (const bucket of buckets) {
      if (bucket[offset]) {
        selected.push(bucket[offset]);
        added = true;
        if (selected.length === maxFeatures) break;
      }
    }
    if (!added) break;
    offset += 1;
  }
  return selected;
}

function extractFeatures(gray, region, regionScale = 1, maxFeatures = MAX_FEATURES, { interior = false } = {}) {
  const count = jsfeat.fast_corners.detect(gray, keypointPool, 20);
  const permittedRegion = region ? scaleQuad(region, regionScale) : null;
  const trackingRegion = region ? scaleQuad(region, regionScale * INTERIOR_REGION_SCALE) : null;
  const selected = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = keypointPool[index];
    if (candidate.x < 20 || candidate.y < 20 || candidate.x >= gray.cols - 20 || candidate.y >= gray.rows - 20) continue;
    if (permittedRegion && !pointInPolygon(candidate, permittedRegion)) continue;
    // The board outline and its corners are allowed to disappear at steep
    // angles. Prefer component, pad, and silkscreen detail well inside the
    // calibrated board instead of making those outer corners the evidence.
    if (interior && trackingRegion && !pointInPolygon(candidate, trackingRegion)) continue;
    selected.push(new jsfeat.keypoint_t(candidate.x, candidate.y, candidate.score, 0, keypointAngle(gray, candidate.x, candidate.y)));
  }
  selected.sort((left, right) => right.score - left.score);
  const keypoints = interior
    ? distributeFeatures(selected, trackingRegion, maxFeatures)
    : selected.slice(0, maxFeatures);
  const descriptors = new jsfeat.matrix_t(DESCRIPTOR_BYTES, keypoints.length, jsfeat.U8_t | jsfeat.C1_t);
  if (keypoints.length) jsfeat.orb.describe(gray, keypoints, keypoints.length, descriptors);
  return { keypoints, descriptors };
}

function mergeFeatureSets(featureSets) {
  const featureCount = featureSets.reduce((total, features) => total + features.keypoints.length, 0);
  const keypoints = [];
  const descriptors = new jsfeat.matrix_t(DESCRIPTOR_BYTES, featureCount, jsfeat.U8_t | jsfeat.C1_t);
  let offset = 0;
  for (const features of featureSets) {
    keypoints.push(...features.keypoints);
    descriptors.data.set(features.descriptors.data.slice(0, features.keypoints.length * DESCRIPTOR_BYTES), offset * DESCRIPTOR_BYTES);
    offset += features.keypoints.length;
  }
  return { keypoints, descriptors };
}

/**
 * ORB is rotation-aware but its descriptor patch is not fully scale invariant.
 * When a normal match has just failed, add one lower-resolution image pass.
 * This gives recovery enough scale tolerance for a noticeably tilted board
 * without paying that cost during ordinary frame-to-frame tracking.
 */
function extractRecoveryFeatures(gray, region, regionScale = 1) {
  const base = extractFeatures(gray, region, regionScale, RECOVERY_BASE_FEATURES, { interior: true });
  const scaledWidth = Math.max(48, Math.round(gray.cols * RECOVERY_SCALE));
  const scaledHeight = Math.max(48, Math.round(gray.rows * RECOVERY_SCALE));
  const scaledGray = new jsfeat.matrix_t(scaledWidth, scaledHeight, jsfeat.U8_t | jsfeat.C1_t);
  jsfeat.imgproc.resample(gray, scaledGray, scaledWidth, scaledHeight);
  const scaledRegion = region?.map((point) => ({ x: point.x * RECOVERY_SCALE, y: point.y * RECOVERY_SCALE })) || null;
  const scaled = extractFeatures(scaledGray, scaledRegion, regionScale, RECOVERY_SCALED_FEATURES, { interior: true });
  const remapped = {
    keypoints: scaled.keypoints.map((point) => new jsfeat.keypoint_t(
      point.x / RECOVERY_SCALE,
      point.y / RECOVERY_SCALE,
      point.score,
      point.level,
      point.angle,
    )),
    descriptors: scaled.descriptors,
  };
  return mergeFeatureSets([base, remapped]);
}

function keypointsToFlowPoints(keypoints) {
  const pointCount = Math.min(MAX_FLOW_POINTS, keypoints.length);
  const points = new Float32Array(pointCount * 2);
  for (let index = 0; index < pointCount; index += 1) {
    points[index * 2] = keypoints[index].x;
    points[index * 2 + 1] = keypoints[index].y;
  }
  return points;
}

function matchesToFlowPoints(matches) {
  const selected = matches.slice(0, MAX_FLOW_POINTS);
  const points = new Float32Array(selected.length * 2);
  for (let index = 0; index < selected.length; index += 1) {
    points[index * 2] = selected[index].destination.x;
    points[index * 2 + 1] = selected[index].destination.y;
  }
  return points;
}

function buildPyramid(gray) {
  const pyramid = new jsfeat.pyramid_t(4);
  pyramid.allocate(gray.cols, gray.rows, jsfeat.U8_t | jsfeat.C1_t);
  pyramid.build(gray, false);
  return pyramid;
}

function project(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-8) return null;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function polygonArea(points) {
  return Math.abs(points.reduce((total, point, index) => {
    const next = points[(index + 1) % points.length];
    return total + point.x * next.y - next.x * point.y;
  }, 0) / 2);
}

function matchDescriptors(referenceFeatures, currentFeatures) {
  const referenceData = referenceFeatures.descriptors.data;
  const currentData = currentFeatures.descriptors.data;
  const currentBestDistance = new Int16Array(currentFeatures.keypoints.length);
  const currentBestReference = new Int16Array(currentFeatures.keypoints.length);
  currentBestDistance.fill(32767);
  currentBestReference.fill(-1);
  const candidates = [];
  for (let referenceIndex = 0; referenceIndex < referenceFeatures.keypoints.length; referenceIndex += 1) {
    let bestIndex = -1;
    let bestDistance = 32767;
    let secondDistance = 32767;
    const referenceOffset = referenceIndex * DESCRIPTOR_BYTES;
    for (let currentIndex = 0; currentIndex < currentFeatures.keypoints.length; currentIndex += 1) {
      const currentOffset = currentIndex * DESCRIPTOR_BYTES;
      let distance = 0;
      for (let byte = 0; byte < DESCRIPTOR_BYTES; byte += 1) distance += POPCOUNT[referenceData[referenceOffset + byte] ^ currentData[currentOffset + byte]];
      if (distance < currentBestDistance[currentIndex]) {
        currentBestDistance[currentIndex] = distance;
        currentBestReference[currentIndex] = referenceIndex;
      }
      if (distance < bestDistance) {
        secondDistance = bestDistance;
        bestDistance = distance;
        bestIndex = currentIndex;
      } else if (distance < secondDistance) {
        secondDistance = distance;
      }
    }
    if (bestIndex >= 0 && bestDistance <= 64 && bestDistance < secondDistance * 0.74) {
      candidates.push({ referenceIndex, currentIndex: bestIndex, distance: bestDistance });
    }
  }
  return candidates
    .filter((match) => currentBestReference[match.currentIndex] === match.referenceIndex)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, 180)
    .map((match) => ({
      source: referenceFeatures.keypoints[match.referenceIndex],
      destination: currentFeatures.keypoints[match.currentIndex],
    }));
}

function estimatePose(currentFeatures) {
  if (!reference || !currentFeatures.keypoints.length) return null;
  const matches = matchDescriptors(reference, currentFeatures);
  if (matches.length < MIN_INLIERS) return null;
  const model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
  const inlierMask = new jsfeat.matrix_t(matches.length, 1, jsfeat.U8_t | jsfeat.C1_t);
  const params = new jsfeat.ransac_params_t(4, 3.25, 0.65, 0.995);
  const found = jsfeat.motion_estimator.ransac(
    params,
    jsfeat.homography2d,
    matches.map((match) => match.source),
    matches.map((match) => match.destination),
    matches.length,
    model,
    inlierMask,
    600,
  );
  if (!found) return null;
  const matrix = Array.from(model.data.slice(0, 9));
  const inliers = matches.filter((_, index) => inlierMask.data[index]);
  if (inliers.length < MIN_INLIERS || inliers.length / matches.length < MIN_INLIER_RATIO) return null;
  const sourceXs = inliers.map((pair) => pair.source.x);
  const sourceYs = inliers.map((pair) => pair.source.y);
  const spreadX = (Math.max(...sourceXs) - Math.min(...sourceXs)) / canvas.width;
  const spreadY = (Math.max(...sourceYs) - Math.min(...sourceYs)) / canvas.height;
  if (spreadX < 0.16 || spreadY < 0.13) return null;
  const rootMeanSquareError = Math.sqrt(inliers.reduce((total, pair) => {
    const estimated = project(matrix, pair.source);
    return total + (estimated ? (estimated.x - pair.destination.x) ** 2 + (estimated.y - pair.destination.y) ** 2 : 1000);
  }, 0) / inliers.length);
  if (!Number.isFinite(rootMeanSquareError) || rootMeanSquareError > 3.4) return null;
  const projectedCorners = reference.corners.map((point) => project(matrix, { x: point.x * canvas.width, y: point.y * canvas.height }));
  if (projectedCorners.some((point) => !point)) return null;
  const referenceArea = polygonArea(reference.corners.map((point) => ({ x: point.x * canvas.width, y: point.y * canvas.height })));
  const areaScale = polygonArea(projectedCorners) / Math.max(1, referenceArea);
  if (areaScale < 0.2 || areaScale > 4 || projectedCorners.some((point) => point.x < -canvas.width * 0.35 || point.x > canvas.width * 1.35 || point.y < -canvas.height * 0.35 || point.y > canvas.height * 1.35)) return null;
  return {
    confidence: Math.max(0, Math.min(1,
      (inliers.length / Math.min(45, matches.length)) * 0.42
        + (inliers.length / matches.length) * 0.43
        + Math.max(0, 1 - rootMeanSquareError / 3.4) * 0.15,
    )),
    inliers: inliers.length,
    matches: matches.length,
    reprojectionError: rootMeanSquareError,
    points: projectedCorners.map((point) => ({ x: point.x / canvas.width, y: point.y / canvas.height })),
    flowPoints: matchesToFlowPoints(inliers),
    method: 'features',
  };
}

function estimateFlowPose(gray) {
  if (!previousGray || !flowPoints || flowPoints.length / 2 < MIN_FLOW_INLIERS || !lastPose) return null;
  const pointCount = flowPoints.length / 2;
  const nextPoints = new Float32Array(flowPoints.length);
  const status = new Uint8Array(pointCount);
  const previousPyramid = buildPyramid(previousGray);
  const currentPyramid = buildPyramid(gray);
  jsfeat.optical_flow_lk.track(
    previousPyramid,
    currentPyramid,
    flowPoints,
    nextPoints,
    pointCount,
    21,
    20,
    status,
    0.01,
    0.0001,
  );

  const matches = [];
  for (let index = 0; index < pointCount; index += 1) {
    if (!status[index]) continue;
    const x = nextPoints[index * 2];
    const y = nextPoints[index * 2 + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 4 || y < 4 || x >= canvas.width - 4 || y >= canvas.height - 4) continue;
    matches.push({
      source: { x: flowPoints[index * 2], y: flowPoints[index * 2 + 1] },
      destination: { x, y },
    });
  }
  if (matches.length < MIN_FLOW_INLIERS) return null;

  const model = new jsfeat.matrix_t(3, 3, jsfeat.F32_t | jsfeat.C1_t);
  const inlierMask = new jsfeat.matrix_t(matches.length, 1, jsfeat.U8_t | jsfeat.C1_t);
  const found = jsfeat.motion_estimator.ransac(
    new jsfeat.ransac_params_t(4, 2.8, 0.62, 0.995),
    jsfeat.homography2d,
    matches.map((match) => match.source),
    matches.map((match) => match.destination),
    matches.length,
    model,
    inlierMask,
    300,
  );
  if (!found) return null;
  const inliers = matches.filter((_, index) => inlierMask.data[index]);
  if (inliers.length < MIN_FLOW_INLIERS || inliers.length / matches.length < 0.5) return null;
  const sourceXs = inliers.map((pair) => pair.source.x);
  const sourceYs = inliers.map((pair) => pair.source.y);
  if ((Math.max(...sourceXs) - Math.min(...sourceXs)) / canvas.width < 0.12
    || (Math.max(...sourceYs) - Math.min(...sourceYs)) / canvas.height < 0.1) return null;

  const matrix = Array.from(model.data.slice(0, 9));
  const rootMeanSquareError = Math.sqrt(inliers.reduce((total, pair) => {
    const estimated = project(matrix, pair.source);
    return total + (estimated ? (estimated.x - pair.destination.x) ** 2 + (estimated.y - pair.destination.y) ** 2 : 1000);
  }, 0) / inliers.length);
  if (!Number.isFinite(rootMeanSquareError) || rootMeanSquareError > 2.8) return null;

  const projectedCorners = lastPose.map((point) => project(matrix, { x: point.x * canvas.width, y: point.y * canvas.height }));
  if (projectedCorners.some((point) => !point)) return null;
  const referenceArea = polygonArea(reference.corners.map((point) => ({ x: point.x * canvas.width, y: point.y * canvas.height })));
  const areaScale = polygonArea(projectedCorners) / Math.max(1, referenceArea);
  if (areaScale < 0.2 || areaScale > 4 || projectedCorners.some((point) => point.x < -canvas.width * 0.35 || point.x > canvas.width * 1.35 || point.y < -canvas.height * 0.35 || point.y > canvas.height * 1.35)) return null;

  return {
    confidence: Math.max(0, Math.min(0.92,
      (inliers.length / Math.min(40, matches.length)) * 0.42
        + (inliers.length / matches.length) * 0.43
        + Math.max(0, 1 - rootMeanSquareError / 2.8) * 0.15,
    )),
    inliers: inliers.length,
    matches: matches.length,
    reprojectionError: rootMeanSquareError,
    points: projectedCorners.map((point) => ({ x: point.x / canvas.width, y: point.y / canvas.height })),
    flowPoints: matchesToFlowPoints(inliers),
    method: 'flow',
  };
}

function trackingSearchRegion() {
  if (!lastPose) return { region: null, scale: 1 };
  if (missedFrames <= 1) return { region: lastPose, scale: 1.25 };
  if (missedFrames <= 3) return { region: lastPose, scale: 1.7 };
  if (missedFrames <= 5) return { region: lastPose, scale: 2.25 };
  if (missedFrames <= 8) return { region: reference.corners, scale: 1.8 };
  // A large camera move can leave both the previous and calibration quads.
  // Search the reduced camera frame to re-acquire rather than remaining stuck.
  return { region: null, scale: 1 };
}

function calibrate(bitmap, points) {
  const gray = bitmapToGray(bitmap);
  const corners = points.map((point) => ({ x: point.x * canvas.width, y: point.y * canvas.height }));
  // Keep a compact multi-scale reference only once, at calibration time. It
  // is consulted during re-acquisition after viewpoint changes.
  const features = extractRecoveryFeatures(gray, corners);
  if (features.keypoints.length < MIN_REFERENCE_FEATURES) {
    reference = null;
    lastPose = null;
    self.postMessage({
      type: 'calibration-failed',
      message: 'The camera view has too few distinct board features. Improve lighting, move closer, and calibrate again.',
      featureCount: features.keypoints.length,
    });
    return;
  }
  reference = {
    ...features,
    corners: points.map((point) => ({ ...point })),
    width: canvas.width,
    height: canvas.height,
  };
  lastPose = reference.corners.map((point) => ({ ...point }));
  missedFrames = 0;
  previousGray = gray;
  flowPoints = keypointsToFlowPoints(reference.keypoints);
  frameNumber = 0;
  self.postMessage({ type: 'calibrated', featureCount: reference.keypoints.length });
}

function track(bitmap) {
  const gray = bitmapToGray(bitmap);
  const quality = analyze(gray);
  if (!reference || reference.width !== canvas.width || reference.height !== canvas.height) return { quality, tracking: null };
  frameNumber += 1;
  const shouldRefreshFeatures = missedFrames > 0 || !previousGray || !flowPoints || frameNumber % FEATURE_REFRESH_INTERVAL === 0;
  let tracking = shouldRefreshFeatures ? null : estimateFlowPose(gray);
  if (!tracking) {
    const search = trackingSearchRegion();
    const region = search.region?.map((point) => ({ x: point.x * canvas.width, y: point.y * canvas.height })) || null;
    const features = missedFrames > 0
      ? extractRecoveryFeatures(gray, region, search.scale)
      : extractFeatures(gray, region, search.scale, MAX_FEATURES, { interior: true });
    tracking = estimatePose(features);
  }
  if (tracking) {
    lastPose = tracking.points.map((point) => ({ ...point }));
    flowPoints = tracking.flowPoints;
    missedFrames = 0;
  } else {
    missedFrames += 1;
    flowPoints = null;
  }
  previousGray = gray;
  return { quality, tracking };
}

function postWorkerError(error, type) {
  const message = error instanceof Error ? error.message : 'Unexpected markerless tracking error.';
  self.postMessage({ type: 'state', state: 'error', message });
  if (type === 'frame') self.postMessage({ type: 'frame' });
  if (type === 'calibrate') self.postMessage({ type: 'calibration-failed', message });
}

self.postMessage({ type: 'state', state: 'ready' });

self.addEventListener('message', (event) => {
  const { type, bitmap, points } = event.data || {};
  if (!bitmap) return;
  operationQueue = operationQueue
    .then(() => {
      if (type === 'calibrate') calibrate(bitmap, points || []);
      else if (type === 'frame') self.postMessage({ type: 'frame', ...track(bitmap) });
      else bitmap.close();
    })
    .catch((error) => {
      bitmap.close?.();
      postWorkerError(error, type);
    });
});
