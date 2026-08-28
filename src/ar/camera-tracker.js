import { displayPointToVideo, videoPointToDisplay } from './tracking-geometry.js';

const TRACKING_INTERVAL_MS = 1000 / 9;

export function createCameraTracker(video, { onQuality = () => {}, onState = () => {}, onTracking = () => {} } = {}) {
  let worker = null;
  let intervalId = null;
  let pending = false;
  let calibrating = false;
  let active = false;

  function displaySize(frameRect = video.getBoundingClientRect()) {
    return { width: frameRect.width, height: frameRect.height };
  }

  function videoSize() {
    return {
      width: video.videoWidth || video.clientWidth || 1,
      height: video.videoHeight || video.clientHeight || 1,
    };
  }

  function stop() {
    active = false;
    pending = false;
    calibrating = false;
    if (intervalId != null) window.clearInterval(intervalId);
    intervalId = null;
    worker?.terminate();
    worker = null;
  }

  async function captureFrame() {
    if (!active || pending || calibrating || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
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
    calibrating = true;
    pending = true;
    try {
      const bitmap = await createImageBitmap(video);
      if (!active || !worker) {
        bitmap.close();
        return;
      }
      const normalizedPoints = points.map((point) => displayPointToVideo(point, videoSize(), displaySize(frameRect)));
      worker.postMessage({ type: 'calibrate', bitmap, points: normalizedPoints }, [bitmap]);
    } catch {
      // Frame capture can fail transiently while the camera starts.
      pending = false;
      calibrating = false;
    }
  }

  function start() {
    if (active || !window.Worker || !window.createImageBitmap) return;
    worker = new Worker(new URL('./camera-tracker.worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', (event) => {
      const message = event.data || {};
      if (message.quality) onQuality(message.quality);
      if (message.type === 'frame') pending = false;
      if (message.type === 'calibrated' || message.type === 'calibration-failed') {
        pending = false;
        calibrating = false;
      }
      if (message.type === 'state' || message.type === 'calibrated' || message.type === 'calibration-failed') onState(message);
      if (message.type === 'state' && message.state === 'error') {
        stop();
        return;
      }
      if (message.tracking) {
        const points = message.tracking.points.map((point) => videoPointToDisplay(point, videoSize(), displaySize()));
        onTracking({ ...message.tracking, points });
      }
    });
    worker.addEventListener('error', () => {
      onState({ type: 'state', state: 'error', message: 'Markerless tracking could not start in this browser.' });
      stop();
    });
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
