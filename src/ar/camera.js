export function createCameraController(video, onStateChange = () => {}) {
  let stream = null;
  let startPromise = null;
  let generation = 0;

  function notify(state, message = '') {
    onStateChange({ state, message, stream });
  }

function logStartupTiming(operation, startedAt) {
  if (!import.meta.env?.DEV) return;
  console.info(`[camera] ${operation}: ${Math.round(performance.now() - startedAt)}ms`);
}

  function stop() {
    generation += 1;
    startPromise = null;
    const currentStream = stream;
    stream = null;
    video.srcObject = null;
    for (const track of currentStream?.getTracks() || []) track.stop();
    notify('stopped');
  }

  async function applySupportedCameraControls(track) {
    const controlsStartedAt = performance.now();
    try {
      const capabilities = track?.getCapabilities?.();
      if (!capabilities) return;
      const advanced = {};
      if (Array.isArray(capabilities.focusMode) && capabilities.focusMode.includes('continuous')) {
        advanced.focusMode = 'continuous';
      }
      if (Array.isArray(capabilities.exposureMode) && capabilities.exposureMode.includes('continuous')) {
        advanced.exposureMode = 'continuous';
      }
      if (!Object.keys(advanced).length) return;
      await track.applyConstraints({ advanced: [advanced] });
    } catch {
      // Capability reporting varies between mobile camera drivers. The stream
      // remains usable even when an advertised optional control is rejected.
    } finally {
      logStartupTiming('optional controls', controlsStartedAt);
    }
  }

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      const message = !window.isSecureContext
        ? 'Camera access requires HTTPS when opening this app from another device. Use an HTTPS URL (localhost is only trusted on this computer).'
        : 'Camera access is not supported by this browser or connection.';
      notify('error', message);
      throw new Error(message);
    }
    if (stream) return stream;
    if (startPromise) return startPromise;

    const requestGeneration = ++generation;
    notify('requesting', 'Requesting camera permission...');
    startPromise = (async () => {
      let requestedStream = null;
      const startupStartedAt = performance.now();
      try {
        requestedStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, max: 30 },
          },
        });
        logStartupTiming('getUserMedia', startupStartedAt);
        if (requestGeneration !== generation) {
          for (const track of requestedStream.getTracks()) track.stop();
          return null;
        }
        stream = requestedStream;
        video.srcObject = stream;
        const playStartedAt = performance.now();
        await video.play();
        logStartupTiming('video.play', playStartedAt);
        if (requestGeneration !== generation || stream !== requestedStream) {
          for (const track of requestedStream.getTracks()) track.stop();
          return null;
        }
        const [track] = requestedStream.getVideoTracks();
        track?.addEventListener('ended', () => {
          if (stream !== requestedStream) return;
          stream = null;
          video.srcObject = null;
          notify('stopped', 'Camera stopped.');
        }, { once: true });
        if (requestGeneration !== generation || stream !== requestedStream || track?.readyState === 'ended') {
          for (const requestedTrack of requestedStream.getTracks()) requestedTrack.stop();
          if (stream === requestedStream) stream = null;
          if (video.srcObject === requestedStream) video.srcObject = null;
          return null;
        }
        notify('active');
        void applySupportedCameraControls(track);
        return stream;
      } catch (error) {
        for (const track of requestedStream?.getTracks() || []) track.stop();
        if (requestGeneration !== generation) return null;
        stream = null;
        video.srcObject = null;
        const message = error?.name === 'NotAllowedError'
          ? 'Camera permission was not granted.'
          : error?.name === 'NotFoundError'
            ? 'No camera was found on this device.'
            : error?.name === 'NotReadableError'
              ? 'The camera is already in use by another app or browser tab.'
              : error?.name === 'AbortError'
                ? 'Camera startup was interrupted. Close and reopen AR mode to try again.'
                : error?.name === 'OverconstrainedError'
                  ? 'This camera could not satisfy the requested mobile video settings.'
                  : `Could not start the camera: ${error?.message || 'unknown error'}`;
        notify('error', message);
        throw error;
      } finally {
        if (requestGeneration === generation) startPromise = null;
      }
    })();
    return startPromise;
  }

  return {
    get active() { return Boolean(stream); },
    get pending() { return Boolean(startPromise) && !stream; },
    start,
    stop,
  };
}
