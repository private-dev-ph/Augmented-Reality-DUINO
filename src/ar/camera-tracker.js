import { displayPointToVideo, videoPointToDisplay } from './tracking-geometry.js';
import { mapDiagnosticPoints } from './tracking-diagnostics.js';

export const TRACKING_PROFILE_KEY = 'ar-duino.tracking-profile';

const PROFILES = {
  battery: { intervalMs: 1000 / 15, maxEdge: 512, anchorInterval: 6 },
  balanced: { intervalMs: 1000 / 18, maxEdge: 640, anchorInterval: 5 },
  accuracy: { intervalMs: 1000 / 20, maxEdge: 720, anchorInterval: 4 },
};
const WORKER_START_TIMEOUT_MS = 25_000;
const EDGE_DETECTION_TIMEOUT_MS = 8_000;

function logStartupTiming(stage, startedAt) {
  if (!import.meta.env?.DEV) return;
  console.info(`[AR-DUINO] ${stage}: ${Math.round(performance.now() - startedAt)} ms`);
}

function selectedProfile() {
  let name = 'balanced';
  try {
    const saved = localStorage.getItem(TRACKING_PROFILE_KEY);
    if (saved && PROFILES[saved]) name = saved;
  } catch {
    // Storage can be disabled in private browsing; balanced is a safe default.
  }
  return { name, ...PROFILES[name] };
}

export function createCameraTracker(video, {
  onQuality = () => {},
  onState = () => {},
  onTracking = () => {},
  onDiagnostic = () => {},
} = {}) {
  let worker = null;
  let videoFrameCallbackId = null;
  let timerId = null;
  let workerStartTimerId = null;
  let lastCaptureTime = 0;
  let pending = false;
  let calibrating = false;
  let active = false;
  let ready = false;
  let captureScheduled = false;
  let profile = selectedProfile();
  let generation = 0;
  let debugEnabled = false;
  let edgeRequestSerial = 0;
  let edgeRequest = null;

  function displaySize(frameRect = video.getBoundingClientRect()) {
    return { width: frameRect.width, height: frameRect.height };
  }

  function videoSize() {
    return {
      width: video.videoWidth || video.clientWidth || 1,
      height: video.videoHeight || video.clientHeight || 1,
    };
  }

  function clearTimers() {
    if (videoFrameCallbackId != null && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(videoFrameCallbackId);
    if (timerId != null) window.clearTimeout(timerId);
    if (workerStartTimerId != null) window.clearTimeout(workerStartTimerId);
    videoFrameCallbackId = null;
    timerId = null;
    workerStartTimerId = null;
    captureScheduled = false;
  }

  function handleVideoResize() {
    worker?.postMessage({ type: 'video-resize' });
  }

  function stop() {
    if (edgeRequest) {
      const request = edgeRequest;
      edgeRequest = null;
      window.clearTimeout(request.timeoutId);
      request.bitmap?.close?.();
      request.reject(new Error('Edge detection was cancelled because the camera tracker stopped.'));
    }
    generation += 1;
    active = false;
    ready = false;
    pending = false;
    calibrating = false;
    clearTimers();
    video.removeEventListener('resize', handleVideoResize);
    worker?.postMessage({ type: 'dispose' });
    worker?.terminate();
    worker = null;
  }

  async function captureFrame() {
    if (!active || !ready || pending || calibrating || edgeRequest || !worker || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
    const captureGeneration = generation;
    const captureWorker = worker;
    pending = true;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(video);
      if (!active || !ready || worker !== captureWorker || generation !== captureGeneration) {
        bitmap.close();
        return;
      }
      captureWorker.postMessage({ type: 'frame', bitmap }, [bitmap]);
      bitmap = null;
    } catch {
      bitmap?.close?.();
      if (worker === captureWorker && generation === captureGeneration) {
        pending = false;
        const request = edgeRequest;
        if (request?.waitingForFrame) startEdgeCapture(request);
      }
    }
  }

  function scheduleCapture() {
    if (!active || !ready || captureScheduled) return;
    captureScheduled = true;
    const request = () => {
      captureScheduled = false;
      if (!active || !ready) return;
      const now = performance.now();
      if (now - lastCaptureTime >= profile.intervalMs && !pending && !calibrating && !edgeRequest && !document.hidden) {
        lastCaptureTime = now;
        captureFrame();
      }
      scheduleCapture();
    };
    if (video.requestVideoFrameCallback) videoFrameCallbackId = video.requestVideoFrameCallback(request);
    else timerId = window.setTimeout(request, profile.intervalMs);
  }

  async function calibrate(points, frameRect, { boardAspect = 1 } = {}) {
    if (!active || !worker) {
      onState({ type: 'calibration-failed', message: 'The tracking worker is not active. Close and reopen AR mode, then calibrate again.' });
      return;
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      onState({ type: 'calibration-failed', message: 'The camera frame is not ready yet. Wait for the live preview, then calibrate again.' });
      return;
    }
    if (!ready) {
      onState({ type: 'state', state: 'loading', message: 'The on-device vision engine is still loading. Try Apply again in a moment.' });
      return;
    }
    const calibrationGeneration = generation;
    const calibrationWorker = worker;
    calibrating = true;
    pending = true;
    let bitmap = null;
    try {
      bitmap = await createImageBitmap(video);
      if (!active || !ready || worker !== calibrationWorker || generation !== calibrationGeneration) {
        bitmap.close();
        return;
      }
      const normalizedPoints = points.map((point) => displayPointToVideo(point, videoSize(), displaySize(frameRect)));
      calibrationWorker.postMessage({
        type: 'calibrate',
        bitmap,
        points: normalizedPoints,
        boardAspect: Math.max(0.1, Math.min(10, Number(boardAspect) || 1)),
      }, [bitmap]);
      bitmap = null;
    } catch (error) {
      bitmap?.close?.();
      if (worker === calibrationWorker && generation === calibrationGeneration) {
        pending = false;
        calibrating = false;
        onState({
          type: 'calibration-failed',
          message: error?.message
            ? `The calibration frame could not be captured: ${error.message}`
            : 'The calibration frame could not be captured. Wait for the live preview and try again.',
        });
      }
    }
  }

  function startEdgeCapture(request) {
    if (!request || edgeRequest !== request || (!request.waitingForFrame && request.captureStarted)) return;
    request.waitingForFrame = false;
    request.captureStarted = true;
    request.ownsPending = true;
    pending = true;
    const { id: requestId, generation: detectionGeneration, worker: detectionWorker, normalizedPoints } = request;
    Promise.resolve()
      .then(() => createImageBitmap(video))
      .then((bitmap) => {
        if (!edgeRequest || edgeRequest.id !== requestId || worker !== detectionWorker || generation !== detectionGeneration || !active || !ready) {
          bitmap.close?.();
          return;
        }
        edgeRequest.bitmap = bitmap;
        detectionWorker.postMessage({
          type: 'detect-edges',
          requestId,
          bitmap,
          points: normalizedPoints,
          expansionRatio: request.expansionRatio,
        }, [bitmap]);
        edgeRequest.bitmap = null;
      })
      .catch((error) => {
        if (edgeRequest?.id !== requestId) return;
        settleEdgeRequest(error?.message ? new Error(`The edge-detection frame could not be captured: ${error.message}`) : new Error('The edge-detection frame could not be captured.'));
      });
  }

  function settleEdgeRequest(error, result) {
    const request = edgeRequest;
    if (!request) return;
    edgeRequest = null;
    window.clearTimeout(request.timeoutId);
    if (request.ownsPending) pending = false;
    if (error) request.reject(error);
    else request.resolve(result);
    scheduleCapture();
  }

  function detectEdges(points, frameRect = video.getBoundingClientRect(), { expansionRatio = 0.1 } = {}) {
    if (!active || !worker) return Promise.reject(new Error('The tracking worker is not active.'));
    if (!ready) return Promise.reject(new Error('The on-device vision engine is still loading.'));
    if (edgeRequest) return Promise.reject(new Error('Edge detection is already in progress.'));
    if (calibrating) return Promise.reject(new Error('Wait for calibration to finish before detecting edges.'));
    if (!Array.isArray(points) || points.length !== 4 || points.some((point) => !Number.isFinite(point?.x) || !Number.isFinite(point?.y))) {
      return Promise.reject(new Error('Edge detection needs four finite calibration corners.'));
    }
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return Promise.reject(new Error('The camera frame is not ready yet.'));
    }
    const safeExpansion = Math.max(0.04, Math.min(0.2, Number(expansionRatio) || 0.1));
    const detectionGeneration = generation;
    const detectionWorker = worker;
    const normalizedPoints = points.map((point) => displayPointToVideo(point, videoSize(), displaySize(frameRect)));
    const requestId = ++edgeRequestSerial;
    return new Promise((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        if (edgeRequest?.id !== requestId) return;
        settleEdgeRequest(new Error('Edge detection timed out. Try holding the board steadier and run Detect edge again.'));
      }, EDGE_DETECTION_TIMEOUT_MS);
      edgeRequest = {
        id: requestId,
        generation: detectionGeneration,
        worker: detectionWorker,
        frameRect,
        normalizedPoints,
        expansionRatio: safeExpansion,
        waitingForFrame: pending,
        captureStarted: false,
        ownsPending: false,
        timeoutId,
        resolve,
        reject,
      };
      if (!edgeRequest.waitingForFrame) startEdgeCapture(edgeRequest);
    });
  }

  function reset() {
    const request = edgeRequest;
    if (request) {
      edgeRequest = null;
      window.clearTimeout(request.timeoutId);
      request.bitmap?.close?.();
      request.reject(new Error('Edge detection was cancelled by reset.'));
      if (request.ownsPending) pending = false;
    } else {
      pending = false;
    }
    calibrating = false;
    worker?.postMessage({ type: 'reset' });
  }

  function setDebugEnabled(enabled) {
    debugEnabled = Boolean(enabled);
    worker?.postMessage({ type: 'config', profile, debugEnabled });
  }

  function start() {
    if (active) return;
    if (!window.Worker || !window.createImageBitmap || !window.OffscreenCanvas || !window.WebAssembly) {
      onState({ type: 'state', state: 'error', message: 'This browser is missing the worker, canvas, or WebAssembly support required for on-device tracking.' });
      return;
    }

    profile = selectedProfile();
    const startupStartedAt = performance.now();
    let createdWorker = null;
    try {
      createdWorker = new Worker(new URL('./camera-tracker.worker.js', import.meta.url));
    } catch (error) {
      onState({ type: 'state', state: 'error', message: error?.message || 'The on-device tracking worker could not be created.' });
      return;
    }
    const workerGeneration = ++generation;
    worker = createdWorker;
    createdWorker.addEventListener('message', (event) => {
      if (worker !== createdWorker || generation !== workerGeneration) return;
      const message = event.data || {};
      if (message.type === 'edges-detected' || message.type === 'edge-detection-failed') {
        if (!edgeRequest || message.requestId !== edgeRequest.id || worker !== edgeRequest.worker || generation !== edgeRequest.generation) return;
        if (message.type === 'edge-detection-failed') {
          settleEdgeRequest(new Error(message.message || 'The board edges could not be detected.'));
        } else if (!Array.isArray(message.points) || message.points.length !== 4) {
          settleEdgeRequest(new Error('The edge detector returned an invalid board quadrilateral.'));
        } else {
          const request = edgeRequest;
          const sourceSize = videoSize();
          const displayPoints = message.points.map((point) => videoPointToDisplay(
            { x: point.x, y: point.y },
            sourceSize,
            displaySize(request.frameRect),
          ));
          settleEdgeRequest(null, {
            points: displayPoints,
            confidence: Number(message.confidence) || 0,
            diagnostics: message.diagnostics || {},
          });
        }
        return;
      }
      if (message.quality) onQuality(message.quality);
      if (message.type === 'frame') {
        pending = false;
        const request = edgeRequest;
        if (request?.waitingForFrame) startEdgeCapture(request);
      }
      if (message.type === 'calibrated' || message.type === 'calibration-failed') {
        pending = false;
        calibrating = false;
      }
      if (message.type === 'state' && message.state === 'ready') {
        ready = true;
        logStartupTiming('tracker initialization', startupStartedAt);
        if (workerStartTimerId != null) window.clearTimeout(workerStartTimerId);
        workerStartTimerId = null;
        scheduleCapture();
      }
      if (message.type === 'state' && message.state === 'error') {
        ready = false;
        onState(message);
        stop();
        return;
      }
      if (message.type === 'state' || message.type === 'tracking-state' || message.type === 'calibrated' || message.type === 'calibration-failed') onState(message);
      if (message.diagnostic) {
        const diagnostic = mapDiagnosticPoints(
          message.diagnostic,
          (point) => videoPointToDisplay(point, videoSize(), displaySize()),
        );
        onDiagnostic(diagnostic);
      }
      if (message.tracking) {
        const points = message.tracking.points.map((point) => videoPointToDisplay(point, videoSize(), displaySize()));
        onTracking({ ...message.tracking, points });
      }
    });
    createdWorker.addEventListener('error', (event) => {
      if (worker !== createdWorker || generation !== workerGeneration) return;
      ready = false;
      onState({ type: 'state', state: 'error', message: event.message || 'Markerless tracking could not start in this browser.' });
      stop();
    });
    active = true;
    video.addEventListener('resize', handleVideoResize);
    worker.postMessage({ type: 'config', profile, debugEnabled });
    onState({ type: 'state', state: 'loading', message: 'Loading the on-device vision engine…' });
    workerStartTimerId = window.setTimeout(() => {
      if (!active || ready) return;
      onState({ type: 'state', state: 'error', message: 'The on-device vision engine did not finish loading. Reload the page and check that the OpenCV WASM asset is available.' });
      stop();
    }, WORKER_START_TIMEOUT_MS);
  }

  return {
    get active() { return active; },
    get ready() { return ready; },
    calibrate,
    detectEdges,
    reset,
    setDebugEnabled,
    start,
    stop,
  };
}
