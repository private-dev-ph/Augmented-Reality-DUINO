function solveLinearSystem(matrix, values) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);
  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-9) return null;
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let item = column; item <= size; item += 1) augmented[column][item] /= divisor;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let item = column; item <= size; item += 1) augmented[row][item] -= factor * augmented[column][item];
    }
  }
  return augmented.map((row) => row[size]);
}

function finiteHomography(matrix) {
  return Array.isArray(matrix)
    && matrix.length >= 9
    && matrix.slice(0, 9).every((value) => Number.isFinite(Number(value)));
}

/** Map a board/world point through a row-major 3x3 homography. */
export function projectPoint(matrix, point) {
  if (!finiteHomography(matrix) || !point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (!Number.isFinite(denominator) || Math.abs(denominator) < 1e-12) return null;
  const x = (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator;
  const y = (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator;
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Return the inverse of a row-major 3x3 homography, or null if singular. */
export function invertHomography(matrix) {
  if (!finiteHomography(matrix)) return null;
  const [a, b, c, d, e, f, g, h, i] = matrix;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const inverse = [
    (e * i - f * h) / determinant,
    (c * h - b * i) / determinant,
    (b * f - c * e) / determinant,
    (f * g - d * i) / determinant,
    (a * i - c * g) / determinant,
    (c * d - a * f) / determinant,
    (d * h - e * g) / determinant,
    (b * g - a * h) / determinant,
    (a * e - b * d) / determinant,
  ];
  return inverse.every(Number.isFinite) ? inverse : null;
}

/** Map a camera/display point back into board/world space. */
export function unprojectPoint(matrix, point) {
  const inverse = invertHomography(matrix);
  return inverse ? projectPoint(inverse, point) : null;
}

export function computeHomography(source, destination) {
  if (source.length !== 4 || destination.length !== 4) return null;
  const matrix = [];
  const values = [];
  for (let index = 0; index < 4; index += 1) {
    const { x, y } = source[index];
    const { x: u, y: v } = destination[index];
    matrix.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    values.push(u);
    matrix.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    values.push(v);
  }
  const solved = solveLinearSystem(matrix, values);
  return solved ? [...solved, 1] : null;
}

export function isValidCalibrationQuad(points, { minimumArea = 400, minimumEdge = 10 } = {}) {
  if (!Array.isArray(points) || points.length !== 4 || points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return false;
  let direction = 0;
  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % points.length];
    const third = points[(index + 2) % points.length];
    if (Math.hypot(second.x - first.x, second.y - first.y) < minimumEdge) return false;
    const cross = (second.x - first.x) * (third.y - second.y) - (second.y - first.y) * (third.x - second.x);
    if (Math.abs(cross) < 1e-6) return false;
    const nextDirection = Math.sign(cross);
    if (direction && nextDirection !== direction) return false;
    direction = nextDirection;
    twiceArea += first.x * second.y - second.x * first.y;
  }
  return Math.abs(twiceArea) / 2 >= minimumArea;
}

export function createFourCornerCalibration() {
  let points = [];
  let boardBounds = null;
  let homography = null;

  function sourceCorners() {
    if (!boardBounds) return [];
    const { minX, minY, maxX, maxY } = boardBounds;
    // Camera coordinates begin at the visual top-left, while board Y values
    // increase upward in the existing viewport transform.
    return [{ x: minX, y: maxY }, { x: maxX, y: maxY }, { x: maxX, y: minY }, { x: minX, y: minY }];
  }

  return {
    get active() { return Boolean(boardBounds) && !homography; },
    get points() { return points.map((point) => ({ ...point })); },
    get homography() { return homography ? [...homography] : null; },
    begin(bounds, initialPoints = []) {
      boardBounds = bounds ? { ...bounds } : null;
      points = initialPoints.slice(0, 4).map((point) => ({ x: point.x, y: point.y }));
      homography = null;
    },
    setPoint(index, point) {
      if (!boardBounds || homography || index < 0 || index > 3) return;
      points[index] = { x: point.x, y: point.y };
    },
    complete() {
      if (!boardBounds || points.length !== 4) return { error: 'Position all four corner handles before applying calibration.' };
      if (!isValidCalibrationQuad(points)) return { error: 'The four corners must form one non-crossing board outline with useful area.' };
      homography = computeHomography(sourceCorners(), points);
      if (!homography) return { error: 'The selected corners could not form a calibration. Adjust the handles and try again.' };
      return { complete: true };
    },
    updateTrackingPoints(nextPoints) {
      if (!boardBounds || !Array.isArray(nextPoints) || nextPoints.length !== 4) return false;
      if (!isValidCalibrationQuad(nextPoints, { minimumArea: 16, minimumEdge: 2 })) return false;
      const nextHomography = computeHomography(sourceCorners(), nextPoints);
      if (!nextHomography) return false;
      points = nextPoints.map((point) => ({ x: point.x, y: point.y }));
      homography = nextHomography;
      return true;
    },
    reset() {
      points = [];
      homography = null;
    },
    cancel() {
      points = [];
      boardBounds = null;
      homography = null;
    },
  };
}
