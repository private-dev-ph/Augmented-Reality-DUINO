const TRACKING_INTERVAL_MS = 1000 / 12;

export function createCameraTracker(video, { onQuality = () => {}, onTracking = () => {} } = {}) {
  let worker = null;
  let intervalId = null;
  let pending = false;
  let active = false;

  function stop() {
    active = false;
    pending = false;
    if (intervalId != null) window.clearInterval(intervalId);
    intervalId = null;
    worker?.terminate();
    worker = null;
  }

  async function captureFrame() {
    if (!active || pending || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    pending = true;
    try {
      const bitmap = await createImageBitmap(video);
      if (!active || !worker) {
        bitmap.close();
        return;
      }
      worker.postMessage({ type: 'frame', bitmap }, [bitmap]);
    } catch {
      pending = false;
    }
  }

  async function calibrate(points, frameRect) {
    if (!active || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    try {
      const bitmap = await createImageBitmap(video);
      const normalizedPoints = points.map((point) => ({ x: point.x / frameRect.width, y: point.y / frameRect.height }));
      worker.postMessage({ type: 'calibrate', bitmap, points: normalizedPoints }, [bitmap]);
    } catch {
      // Frame capture can fail transiently while the camera starts.
    }
  }

  function start() {
    if (active || !window.Worker || !window.createImageBitmap) return;
    worker = new Worker(new URL('./camera-tracker.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      if (event.data?.quality) onQuality(event.data.quality);
      if (event.data?.tracking) onTracking(event.data.tracking);
      if (event.data?.type === 'frame') pending = false;
    });
    worker.addEventListener('error', () => stop());
    active = true;
    intervalId = window.setInterval(captureFrame, TRACKING_INTERVAL_MS);
  }

  return {
    get active() { return active; },
    calibrate,
    start,
    stop,
  };
}
