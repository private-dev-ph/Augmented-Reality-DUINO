import test from 'node:test';
import assert from 'node:assert/strict';
import { createCameraController } from '../src/ar/camera.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function installBrowserGlobals(getUserMedia) {
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { mediaDevices: { getUserMedia } } });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { isSecureContext: true } });
  return () => {
    if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor);
    else delete globalThis.navigator;
    if (windowDescriptor) Object.defineProperty(globalThis, 'window', windowDescriptor);
    else delete globalThis.window;
  };
}

function fakeStream({ constraintPromise = Promise.resolve() } = {}) {
  const constraints = [];
  const track = {
    stopped: false,
    addEventListener() {},
    applyConstraints(value) { constraints.push(value); return constraintPromise; },
    getCapabilities() { return { focusMode: ['manual', 'continuous'], exposureMode: ['continuous'] }; },
    stop() { this.stopped = true; },
  };
  return {
    constraints,
    getTracks: () => [track],
    getVideoTracks: () => [track],
    track,
  };
}

test('camera start is serialized and capability-gates continuous controls', async () => {
  const request = deferred();
  let requestCount = 0;
  const restore = installBrowserGlobals(() => {
    requestCount += 1;
    return request.promise;
  });
  const video = { srcObject: null, play: () => Promise.resolve() };
  const controller = createCameraController(video);
  const first = controller.start();
  const second = controller.start();
  const stream = fakeStream();
  request.resolve(stream);
  try {
    assert.equal(await first, stream);
    assert.equal(await second, stream);
    assert.equal(requestCount, 1);
    assert.equal(video.srcObject, stream);
    assert.deepEqual(stream.constraints, [{ advanced: [{ focusMode: 'continuous', exposureMode: 'continuous' }] }]);
  } finally {
    controller.stop();
    restore();
  }
});

test('stopping during permission acquisition disposes the late camera stream', async () => {
  const request = deferred();
  const restore = installBrowserGlobals(() => request.promise);
  const video = { srcObject: null, play: () => Promise.resolve() };
  const controller = createCameraController(video);
  const starting = controller.start();
  controller.stop();
  const stream = fakeStream();
  request.resolve(stream);
  try {
    assert.equal(await starting, null);
    assert.equal(stream.track.stopped, true);
    assert.equal(video.srcObject, null);
    assert.equal(controller.active, false);
  } finally {
    restore();
  }
});

test('camera becomes active before optional controls finish and stopping cannot reactivate it', async () => {
  const controls = deferred();
  const stream = fakeStream({ constraintPromise: controls.promise });
  const states = [];
  const restore = installBrowserGlobals(() => Promise.resolve(stream));
  const video = { srcObject: null, play: () => Promise.resolve() };
  const controller = createCameraController(video, ({ state }) => states.push(state));
  const starting = controller.start();
  try {
    assert.equal(await starting, stream);
    assert.deepEqual(states, ['requesting', 'active']);
    assert.deepEqual(stream.constraints, [{ advanced: [{ focusMode: 'continuous', exposureMode: 'continuous' }] }]);

    let controlsFinished = false;
    controls.promise.then(() => { controlsFinished = true; });
    await Promise.resolve();
    assert.equal(controlsFinished, false);

    controller.stop();
    controls.resolve();
    await Promise.resolve();
    assert.deepEqual(states, ['requesting', 'active', 'stopped']);
    assert.equal(stream.track.stopped, true);
    assert.equal(video.srcObject, null);
    assert.equal(controller.active, false);
  } finally {
    restore();
  }
});
