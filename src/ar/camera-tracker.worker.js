let canvas = null;
let context = null;
let templates = [];
let trackedPoints = [];

function ensureCanvas(width, height) {
  const scale = Math.min(1, 360 / Math.max(width, height));
  const targetWidth = Math.max(1, Math.round(width * scale));
  const targetHeight = Math.max(1, Math.round(height * scale));
  if (!canvas || canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas = new OffscreenCanvas(targetWidth, targetHeight);
    context = canvas.getContext('2d', { willReadFrequently: true });
  }
}

function grayscale(bitmap) {
  ensureCanvas(bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const rgba = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const pixels = new Uint8Array(canvas.width * canvas.height);
  for (let index = 0, pixel = 0; index < rgba.length; index += 4, pixel += 1) pixels[pixel] = rgba[index] * 0.213 + rgba[index + 1] * 0.715 + rgba[index + 2] * 0.072;
  return pixels;
}

function patchAt(pixels, x, y, radius) {
  const data = [];
  for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
    for (let offsetX = -radius; offsetX <= radius; offsetX += 1) data.push(pixels[(y + offsetY) * canvas.width + x + offsetX]);
  }
  const mean = data.reduce((total, value) => total + value, 0) / data.length;
  return data.map((value) => value - mean);
}

function canSample(x, y, radius) {
  return x >= radius && y >= radius && x < canvas.width - radius && y < canvas.height - radius;
}

function matchTemplate(pixels, template, previous) {
  const radius = 6;
  const searchRadius = 18;
  let best = null;
  for (let y = previous.y - searchRadius; y <= previous.y + searchRadius; y += 2) {
    for (let x = previous.x - searchRadius; x <= previous.x + searchRadius; x += 2) {
      if (!canSample(x, y, radius)) continue;
      const candidate = patchAt(pixels, x, y, radius);
      let error = 0;
      for (let index = 0; index < candidate.length; index += 1) error += Math.abs(candidate[index] - template[index]);
      if (!best || error < best.error) best = { x, y, error };
    }
  }
  return best;
}

function analyze(pixels) {
  let total = 0;
  let totalSquared = 0;
  let edges = 0;
  let samples = 0;
  for (let y = 2; y < canvas.height - 2; y += 4) {
    for (let x = 2; x < canvas.width - 2; x += 4) {
      const luminance = pixels[y * canvas.width + x];
      total += luminance;
      totalSquared += luminance * luminance;
      edges += Math.abs(luminance - pixels[y * canvas.width + x + 4]) + Math.abs(luminance - pixels[(y + 4) * canvas.width + x]);
      samples += 1;
    }
  }
  const mean = total / Math.max(1, samples);
  return { brightness: Math.round(mean), contrast: Math.round(Math.sqrt(Math.max(0, totalSquared / samples - mean * mean))), edgeStrength: Math.round(edges / Math.max(1, samples)) };
}

function calibrate(bitmap, points) {
  const pixels = grayscale(bitmap);
  trackedPoints = points.map((point) => ({ x: Math.round(point.x * canvas.width), y: Math.round(point.y * canvas.height) }));
  templates = trackedPoints.map((point) => canSample(point.x, point.y, 6) ? patchAt(pixels, point.x, point.y, 6) : null);
  self.postMessage({ type: 'calibrated', validCorners: templates.filter(Boolean).length });
}

function track(bitmap) {
  const pixels = grayscale(bitmap);
  const matches = templates.map((template, index) => template && matchTemplate(pixels, template, trackedPoints[index]));
  if (matches.some((match) => !match)) return { quality: analyze(pixels) };
  const averageError = matches.reduce((total, match) => total + match.error, 0) / matches.length;
  if (averageError < 1850) trackedPoints = matches.map(({ x, y }) => ({ x, y }));
  return {
    quality: analyze(pixels),
    tracking: averageError < 1850 ? {
      confidence: Math.max(0, Math.min(1, 1 - averageError / 1850)),
      points: trackedPoints.map((point) => ({ x: point.x / canvas.width, y: point.y / canvas.height })),
    } : null,
  };
}

self.addEventListener('message', (event) => {
  const { type, bitmap, points } = event.data || {};
  if (!bitmap) return;
  if (type === 'calibrate') calibrate(bitmap, points || []);
  else if (type === 'frame') self.postMessage({ type: 'frame', ...track(bitmap) });
});
