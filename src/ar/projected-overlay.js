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

function validBounds(value) {
  return value
    && Number.isFinite(Number(value.minX))
    && Number.isFinite(Number(value.minY))
    && Number.isFinite(Number(value.maxX))
    && Number.isFinite(Number(value.maxY))
    && Number(value.maxX) > Number(value.minX)
    && Number(value.maxY) > Number(value.minY);
}

/**
 * Expands only the renderer's source rectangle by a small, physical collar.
 * Calibration continues to use the unexpanded board rectangle, so the PCB
 * edge itself never stretches. Twelve percent of the short side is a hard
 * upper bound for nearby packages, labels on the silkscreen, and connectors.
 */
export function attachedArtworkProjectionBounds(physicalBounds, { maxCollarRatio = 0.12 } = {}) {
  if (!validBounds(physicalBounds)) return physicalBounds;
  const width = Number(physicalBounds.maxX) - Number(physicalBounds.minX);
  const height = Number(physicalBounds.maxY) - Number(physicalBounds.minY);
  const ratio = Math.max(0, Math.min(0.12, Number(maxCollarRatio) || 0));
  const collar = Math.min(width, height) * ratio;
  return {
    minX: Number(physicalBounds.minX) - collar,
    minY: Number(physicalBounds.minY) - collar,
    maxX: Number(physicalBounds.maxX) + collar,
    maxY: Number(physicalBounds.maxY) + collar,
  };
}

function sourcePixelRect(viewport, bounds, scaleX, scaleY) {
  if (!viewport || !validBounds(bounds)) return null;
  const points = [
    viewport.screen({ x: bounds.minX, y: bounds.minY }),
    viewport.screen({ x: bounds.maxX, y: bounds.minY }),
    viewport.screen({ x: bounds.maxX, y: bounds.maxY }),
    viewport.screen({ x: bounds.minX, y: bounds.maxY }),
  ];
  if (points.some((point) => !point || !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  return {
    left: Math.min(...points.map((point) => point.x)) * scaleX,
    top: Math.min(...points.map((point) => point.y)) * scaleY,
    right: Math.max(...points.map((point) => point.x)) * scaleX,
    bottom: Math.max(...points.map((point) => point.y)) * scaleY,
  };
}

function filterAttachedArtwork(image, viewport, physicalBounds, projectionBounds) {
  if (!viewport || !validBounds(physicalBounds) || !validBounds(projectionBounds)) return;
  const width = image.width;
  const height = image.height;
  const pixelCount = width * height;
  const size = viewport.screenSize?.() || {};
  const scaleX = width / Math.max(1, Number(size.w) || width);
  const scaleY = height / Math.max(1, Number(size.h) || height);
  const physicalRect = sourcePixelRect(viewport, physicalBounds, scaleX, scaleY);
  const projectionRect = sourcePixelRect(viewport, projectionBounds, scaleX, scaleY);
  if (!physicalRect || !projectionRect) return;

  // The seed band is deliberately much smaller than the projection collar.
  // It lets an anti-aliased package that starts just outside the board remain
  // connected, while detached notes/logos never become projection anchors.
  const physicalShortSide = Math.min(
    Number(physicalBounds.maxX) - Number(physicalBounds.minX),
    Number(physicalBounds.maxY) - Number(physicalBounds.minY),
  );
  const seedBand = physicalShortSide * 0.015 * Math.min(scaleX, scaleY);
  const seedRect = {
    left: physicalRect.left - seedBand,
    top: physicalRect.top - seedBand,
    right: physicalRect.right + seedBand,
    bottom: physicalRect.bottom + seedBand,
  };
  const inside = (x, y, rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
  const visited = new Uint8Array(pixelCount);
  const keep = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  const data = image.data;
  const opaque = (index) => data[index * 4 + 3] > 0;

  for (let start = 0; start < pixelCount; start += 1) {
    if (visited[start] || !opaque(start)) continue;
    let head = 0;
    let tail = 0;
    let touchesSeedBand = false;
    visited[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const current = queue[head++];
      const x = current % width;
      const y = (current - x) / width;
      if (inside(x + 0.5, y + 0.5, seedRect)) touchesSeedBand = true;
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = y + offsetY;
        if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = x + offsetX;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (!visited[next] && opaque(next)) {
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    if (!touchesSeedBand) continue;
    for (let index = 0; index < tail; index += 1) {
      const current = queue[index];
      const x = current % width;
      const y = (current - x) / width;
      if (inside(x + 0.5, y + 0.5, projectionRect)) keep[current] = 1;
    }
  }

  // Physical board pixels are always part of the source, regardless of which
  // disconnected copper/silkscreen component they belong to.
  const left = Math.max(0, Math.floor(physicalRect.left));
  const top = Math.max(0, Math.floor(physicalRect.top));
  const right = Math.min(width, Math.ceil(physicalRect.right));
  const bottom = Math.min(height, Math.ceil(physicalRect.bottom));
  for (let y = top; y < bottom; y += 1) {
    for (let x = left; x < right; x += 1) {
      const index = y * width + x;
      if (opaque(index)) keep[index] = 1;
    }
  }

  for (let index = 0; index < pixelCount; index += 1) {
    if (!keep[index]) data[index * 4 + 3] = 0;
  }
}

export function createBoardOnlySnapshot(boardCanvas, backgroundColor, options = {}) {
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
  filterAttachedArtwork(image, options.viewport, options.physicalBounds, options.projectionBounds);
  snapshotContext.putImageData(image, 0, 0);
  return snapshot;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function createWebGlProjector(canvas) {
  const gl = canvas.getContext('webgl', {
    alpha: true,
    antialias: true,
    depth: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
  });
  if (!gl) return null;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, `
    attribute vec3 a_position;
    attribute vec2 a_uv;
    varying highp vec2 v_uv;
    void main() {
      gl_Position = vec4(a_position.xy, 0.0, a_position.z);
      v_uv = a_uv;
    }
  `);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, `
    precision mediump float;
    uniform sampler2D u_texture;
    uniform float u_opacity;
    varying highp vec2 v_uv;
    void main() {
      if (v_uv.x < 0.0 || v_uv.x > 1.0 || v_uv.y < 0.0 || v_uv.y > 1.0) discard;
      vec4 color = texture2D(u_texture, v_uv);
      gl_FragColor = vec4(color.rgb, color.a * u_opacity);
    }
  `);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  const positionBuffer = gl.createBuffer();
  const uvBuffer = gl.createBuffer();
  const texture = gl.createTexture();
  const positionLocation = gl.getAttribLocation(program, 'a_position');
  const uvLocation = gl.getAttribLocation(program, 'a_uv');
  const opacityLocation = gl.getUniformLocation(program, 'u_opacity');
  const textureLocation = gl.getUniformLocation(program, 'u_texture');
  let textureSource = null;

  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  function clear() {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  function render({ boardCanvas, viewport, bounds, matrix, margin, opacity, rect, dpr }) {
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    clear();

    const marginX = (bounds.maxX - bounds.minX) * margin;
    const marginY = (bounds.maxY - bounds.minY) * margin;
    const worldCorners = [
      { x: bounds.minX - marginX, y: bounds.maxY + marginY },
      { x: bounds.maxX + marginX, y: bounds.maxY + marginY },
      { x: bounds.maxX + marginX, y: bounds.minY - marginY },
      { x: bounds.minX - marginX, y: bounds.minY - marginY },
    ];
    const projected = worldCorners.map((point) => ({
      numeratorX: matrix[0] * point.x + matrix[1] * point.y + matrix[2],
      numeratorY: matrix[3] * point.x + matrix[4] * point.y + matrix[5],
      denominator: matrix[6] * point.x + matrix[7] * point.y + matrix[8],
    }));
    if (projected.some((point) => !Number.isFinite(point.denominator) || Math.abs(point.denominator) < 1e-8)) return false;
    const sign = projected[0].denominator < 0 ? -1 : 1;
    if (projected.some((point) => point.denominator * sign <= 0)) return false;

    const sourceSize = viewport.screenSize();
    const sourceUvs = worldCorners.map((point) => {
      const screen = viewport.screen(point);
      return {
        x: screen.x / Math.max(1, sourceSize.w),
        y: screen.y / Math.max(1, sourceSize.h),
      };
    });
    const order = [0, 1, 2, 0, 2, 3];
    const positions = [];
    const uvs = [];
    for (const index of order) {
      const point = projected[index];
      positions.push(
        sign * (2 * point.numeratorX / Math.max(1, rect.width) - point.denominator),
        sign * (point.denominator - 2 * point.numeratorY / Math.max(1, rect.height)),
        sign * point.denominator,
      );
      uvs.push(sourceUvs[index].x, sourceUvs[index].y);
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(uvs), gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (textureSource !== boardCanvas) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, boardCanvas);
      textureSource = boardCanvas;
    }
    gl.uniform1i(textureLocation, 0);
    gl.uniform1f(opacityLocation, opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    return true;
  }

  function dispose({ loseContext = false } = {}) {
    gl.deleteTexture(texture);
    gl.deleteBuffer(uvBuffer);
    gl.deleteBuffer(positionBuffer);
    gl.deleteProgram(program);
    if (loseContext) gl.getExtension('WEBGL_lose_context')?.loseContext();
  }

  return { clear, dispose, render };
}

function supportsWebGlProjector() {
  const probe = document.createElement('canvas');
  probe.width = 2;
  probe.height = 2;
  const projector = createWebGlProjector(probe);
  if (!projector) return false;
  projector.dispose({ loseContext: true });
  return true;
}

export function createProjectedOverlay(canvas) {
  // Probe on a detached canvas first. If shader compilation/linking is not
  // supported, the visible canvas remains unbound and can still use Canvas2D.
  const webGlProjector = supportsWebGlProjector() ? createWebGlProjector(canvas) : null;
  const context = webGlProjector ? null : canvas.getContext('2d');

  function clear() {
    if (webGlProjector) webGlProjector.clear();
    else context?.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
  }

  function render({ boardCanvas, viewport, bounds, matrix, margin = 0, opacity = 0.7 }) {
    if (!boardCanvas || !bounds || !matrix) return false;
    if (!webGlProjector && !context) return false;
    canvas.hidden = false;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    if (webGlProjector) return webGlProjector.render({ boardCanvas, viewport, bounds, matrix, margin, opacity, rect, dpr });
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
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
