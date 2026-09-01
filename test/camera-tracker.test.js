import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraTracker } from '../src/ar/camera-tracker.js';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function installTrackerGlobals(createBitmap) {
  const names = ['window', 'document', 'localStorage', 'Worker', 'createImageBitmap', 'HTMLMediaElement'];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const workers = [];
  class FakeWorker {
    constructor() {
      this.listeners = new Map();
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }

    addEventListener(type, callback) { this.listeners.set(type, callback); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
    emit(message) { this.listeners.get('message')?.({ data: message }); }
  }
  const browserWindow = {
    Worker: FakeWorker,
    createImageBitmap: createBitmap,
    OffscreenCanvas: class {},
    WebAssembly,
    setTimeout,
    clearTimeout,
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: browserWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false } });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null } });
  Object.defineProperty(globalThis, 'Worker', { configurable: true, value: FakeWorker });
  Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: createBitmap });
  Object.defineProperty(globalThis, 'HTMLMediaElement', { configurable: true, value: { HAVE_CURRENT_DATA: 2 } });
  return {
    restore() {
      for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    },
    workers,
  };
}

test('a bitmap from an old tracker session cannot enter a restarted worker', async () => {
  const bitmapRequest = deferred();
  const globals = installTrackerGlobals(() => bitmapRequest.promise);
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video);
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  const oldCalibration = tracker.calibrate([
    { x: 20, y: 30 },
    { x: 300, y: 30 },
    { x: 300, y: 610 },
    { x: 20, y: 610 },
  ], video.getBoundingClientRect());
  tracker.stop();
  tracker.start();
  globals.workers[1].emit({ type: 'state', state: 'ready' });
  const bitmap = { closed: false, close() { this.closed = true; } };
  bitmapRequest.resolve(bitmap);
  try {
    await oldCalibration;
    assert.equal(bitmap.closed, true);
    assert.deepEqual(globals.workers[1].messages.map((message) => message.type), ['config']);
  } finally {
    tracker.stop();
    globals.restore();
  }
});

test('a current-session calibration capture failure is surfaced to the UI', async () => {
  const globals = installTrackerGlobals(() => Promise.reject(new Error('bitmap unavailable')));
  const states = [];
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video, { onState: (message) => states.push(message) });
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  try {
    await tracker.calibrate([
      { x: 20, y: 30 },
      { x: 300, y: 30 },
      { x: 300, y: 610 },
      { x: 20, y: 610 },
    ], video.getBoundingClientRect());
    assert.equal(states.at(-1).type, 'calibration-failed');
    assert.match(states.at(-1).message, /bitmap unavailable/);
  } finally {
    tracker.stop();
    globals.restore();
  }
});

test('debug diagnostics can be enabled live and normalized points use cover geometry', () => {
  const globals = installTrackerGlobals(async () => ({ close() {} }));
  const diagnostics = [];
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video, { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) });
  tracker.setDebugEnabled(true);
  tracker.start();
  try {
    assert.equal(globals.workers[0].messages[0].debugEnabled, true);
    globals.workers[0].emit({ type: 'state', state: 'ready' });
    globals.workers[0].emit({
      type: 'frame',
      diagnostic: {
        frameNumber: 1,
        points: { detected: [{ x: 0.5, y: 0.5 }], rejected: [{ x: null, y: 0.2 }] },
      },
    });
    assert.deepEqual(diagnostics[0].points.detected, [{ x: 160, y: 320 }]);
    assert.deepEqual(diagnostics[0].points.rejected, []);
    tracker.setDebugEnabled(false);
    assert.equal(globals.workers[0].messages.at(-1).debugEnabled, false);
  } finally {
    tracker.stop();
    globals.restore();
  }
});

test('detectEdges maps a worker quadrilateral back through portrait cover geometry', async () => {
  const globals = installTrackerGlobals(async () => ({ close() {} }));
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video);
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  try {
    const resultPromise = tracker.detectEdges([
      { x: 20, y: 150 },
      { x: 300, y: 150 },
      { x: 300, y: 490 },
      { x: 20, y: 490 },
    ], video.getBoundingClientRect());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const request = globals.workers[0].messages.at(-1);
    assert.equal(request.type, 'detect-edges');
    assert.equal(request.points.length, 4);
    assert.ok(request.points.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1));
    globals.workers[0].emit({
      type: 'edges-detected',
      requestId: request.requestId,
      points: [
        { x: 0.4, y: 0.2 },
        { x: 0.6, y: 0.2 },
        { x: 0.6, y: 0.8 },
        { x: 0.4, y: 0.8 },
      ],
      confidence: 0.83,
      diagnostics: { processingMs: 4 },
    });
    const result = await resultPromise;
    assert.deepEqual(result.points.map((point) => ({ x: Math.round(point.x), y: Math.round(point.y) })), [
      { x: 46, y: 128 },
      { x: 274, y: 128 },
      { x: 274, y: 512 },
      { x: 46, y: 512 },
    ]);
    assert.equal(result.confidence, 0.83);
  } finally {
    tracker.stop();
    globals.restore();
  }
});

test('detectEdges rejects a current-session capture failure', async () => {
  const globals = installTrackerGlobals(() => Promise.reject(new Error('bitmap unavailable')));
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video);
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  try {
    await assert.rejects(
      tracker.detectEdges([{ x: 20, y: 150 }, { x: 300, y: 150 }, { x: 300, y: 490 }, { x: 20, y: 490 }], video.getBoundingClientRect()),
      /edge-detection frame could not be captured: bitmap unavailable/,
    );
  } finally {
    tracker.stop();
    globals.restore();
  }
});

test('detectEdges rejects when the tracker stops before capture resolves', async () => {
  const bitmapRequest = deferred();
  const globals = installTrackerGlobals(() => bitmapRequest.promise);
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: () => 1,
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video);
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  const resultPromise = tracker.detectEdges([{ x: 20, y: 150 }, { x: 300, y: 150 }, { x: 300, y: 490 }, { x: 20, y: 490 }], video.getBoundingClientRect());
  tracker.stop();
  await assert.rejects(resultPromise, /camera tracker stopped/);
  const bitmap = { closed: false, close() { this.closed = true; } };
  bitmapRequest.resolve(bitmap);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(bitmap.closed, true);
  globals.restore();
});

test('detectEdges queues behind one ordinary frame without capturing a duplicate', async () => {
  const ordinaryCapture = deferred();
  const edgeCapture = deferred();
  let captureCount = 0;
  let frameCallback = null;
  const globals = installTrackerGlobals(() => {
    captureCount += 1;
    return captureCount === 1 ? ordinaryCapture.promise : edgeCapture.promise;
  });
  const video = {
    readyState: 2,
    videoWidth: 1280,
    videoHeight: 720,
    clientWidth: 320,
    clientHeight: 640,
    getBoundingClientRect: () => ({ width: 320, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    requestVideoFrameCallback: (callback) => { frameCallback = callback; return 1; },
    cancelVideoFrameCallback() {},
  };
  const tracker = createCameraTracker(video);
  tracker.start();
  globals.workers[0].emit({ type: 'state', state: 'ready' });
  frameCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captureCount, 1);
  const resultPromise = tracker.detectEdges([
    { x: 20, y: 150 },
    { x: 300, y: 150 },
    { x: 300, y: 490 },
    { x: 20, y: 490 },
  ], video.getBoundingClientRect());
  assert.equal(captureCount, 1);
  ordinaryCapture.resolve({ close() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(globals.workers[0].messages.at(-1).type, 'frame');
  globals.workers[0].emit({ type: 'frame' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(captureCount, 2);
  edgeCapture.resolve({ close() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const request = globals.workers[0].messages.at(-1);
  assert.equal(request.type, 'detect-edges');
  globals.workers[0].emit({
    type: 'edges-detected',
    requestId: request.requestId,
    points: [{ x: .4, y: .2 }, { x: .6, y: .2 }, { x: .6, y: .8 }, { x: .4, y: .8 }],
    confidence: .8,
  });
  await assert.doesNotReject(resultPromise);
  tracker.stop();
  globals.restore();
});
