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
      homography = computeHomography(sourceCorners(), points);
      if (!homography) return { error: 'The selected corners could not form a calibration. Adjust the handles and try again.' };
      return { complete: true };
    },
    updateTrackingPoints(nextPoints) {
      if (!boardBounds || !Array.isArray(nextPoints) || nextPoints.length !== 4) return false;
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
