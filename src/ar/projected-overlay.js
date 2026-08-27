function project(matrix, point) {
  const denominator = matrix[6] * point.x + matrix[7] * point.y + matrix[8];
  if (Math.abs(denominator) < 1e-9) return null;
  return {
    x: (matrix[0] * point.x + matrix[1] * point.y + matrix[2]) / denominator,
    y: (matrix[3] * point.x + matrix[4] * point.y + matrix[5]) / denominator,
  };
}

function drawTriangle(context, image, source, destination) {
  const [firstSource, secondSource, thirdSource] = source;
  const [firstDestination, secondDestination, thirdDestination] = destination;
  const determinant = (secondSource.x - firstSource.x) * (thirdSource.y - firstSource.y)
    - (thirdSource.x - firstSource.x) * (secondSource.y - firstSource.y);
  if (Math.abs(determinant) < 1e-9) return;
  const a = ((secondDestination.x - firstDestination.x) * (thirdSource.y - firstSource.y)
    - (thirdDestination.x - firstDestination.x) * (secondSource.y - firstSource.y)) / determinant;
  const c = ((secondSource.x - firstSource.x) * (thirdDestination.x - firstDestination.x)
    - (thirdSource.x - firstSource.x) * (secondDestination.x - firstDestination.x)) / determinant;
  const b = ((secondDestination.y - firstDestination.y) * (thirdSource.y - firstSource.y)
    - (thirdDestination.y - firstDestination.y) * (secondSource.y - firstSource.y)) / determinant;
  const d = ((secondSource.x - firstSource.x) * (thirdDestination.y - firstDestination.y)
    - (thirdSource.x - firstSource.x) * (secondDestination.y - firstDestination.y)) / determinant;
  const e = firstDestination.x - a * firstSource.x - c * firstSource.y;
  const f = firstDestination.y - b * firstSource.x - d * firstSource.y;
  context.save();
  context.beginPath();
  context.moveTo(firstDestination.x, firstDestination.y);
  context.lineTo(secondDestination.x, secondDestination.y);
  context.lineTo(thirdDestination.x, thirdDestination.y);
  context.closePath();
  context.clip();
  context.transform(a, b, c, d, e, f);
  context.drawImage(image, 0, 0);
  context.restore();
}

function hexToRgb(value) {
  const match = String(value || '').trim().match(/^#([0-9a-f]{6})$/i);
  if (!match) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(match[1].slice(offset, offset + 2), 16));
}

export function createBoardOnlySnapshot(boardCanvas, backgroundColor) {
  const background = hexToRgb(backgroundColor);
  if (!background) return boardCanvas;
  const snapshot = document.createElement('canvas');
  snapshot.width = boardCanvas.width;
  snapshot.height = boardCanvas.height;
  const snapshotContext = snapshot.getContext('2d');
  snapshotContext.drawImage(boardCanvas, 0, 0);
  const image = snapshotContext.getImageData(0, 0, snapshot.width, snapshot.height);
  for (let index = 0; index < image.data.length; index += 4) {
    const distance = Math.max(
      Math.abs(image.data[index] - background[0]),
      Math.abs(image.data[index + 1] - background[1]),
      Math.abs(image.data[index + 2] - background[2]),
    );
    if (distance < 18) image.data[index + 3] = 0;
  }
  snapshotContext.putImageData(image, 0, 0);
  return snapshot;
}

export function createProjectedOverlay(canvas) {
  const context = canvas.getContext('2d');

  function clear() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
  }

  function render({ boardCanvas, viewport, bounds, matrix, margin = 0.2, opacity = 0.7 }) {
    if (!boardCanvas || !bounds || !matrix) return false;
    canvas.hidden = false;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const sourceDpr = boardCanvas.width / Math.max(1, viewport.screenSize().w);
    const columns = 10;
    const rows = 7;
    const marginX = (bounds.maxX - bounds.minX) * margin;
    const marginY = (bounds.maxY - bounds.minY) * margin;
    const sourceBounds = {
      minX: bounds.minX - marginX,
      minY: bounds.minY - marginY,
      maxX: bounds.maxX + marginX,
      maxY: bounds.maxY + marginY,
    };
    context.globalAlpha = opacity;
    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const point = (xRatio, yRatio) => ({
          x: sourceBounds.minX + (sourceBounds.maxX - sourceBounds.minX) * xRatio,
          y: sourceBounds.maxY - (sourceBounds.maxY - sourceBounds.minY) * yRatio,
        });
        const world = [
          point(column / columns, row / rows),
          point((column + 1) / columns, row / rows),
          point((column + 1) / columns, (row + 1) / rows),
          point(column / columns, (row + 1) / rows),
        ];
        const destination = world.map((value) => project(matrix, value)).map((value) => value && ({ x: value.x * dpr, y: value.y * dpr }));
        if (destination.some((value) => !value)) continue;
        const source = world.map((value) => {
          const screen = viewport.screen(value);
          return { x: screen.x * sourceDpr, y: screen.y * sourceDpr };
        });
        drawTriangle(context, boardCanvas, [source[0], source[1], source[2]], [destination[0], destination[1], destination[2]]);
        drawTriangle(context, boardCanvas, [source[0], source[2], source[3]], [destination[0], destination[2], destination[3]]);
      }
    }
    context.globalAlpha = 1;
    canvas.hidden = false;
    return true;
  }

  return { clear, render };
}
