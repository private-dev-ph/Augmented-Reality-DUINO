export function createCameraController(video, onStateChange = () => {}) {
  let stream = null;

  function notify(state, message = '') {
    onStateChange({ state, message, stream });
  }

  function stop() {
    for (const track of stream?.getTracks() || []) track.stop();
    stream = null;
    video.srcObject = null;
    notify('stopped');
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

    notify('requesting', 'Requesting camera permission...');
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      video.srcObject = stream;
      await video.play();
      const [track] = stream.getVideoTracks();
      track?.addEventListener('ended', () => {
        stream = null;
        video.srcObject = null;
        notify('stopped', 'Camera stopped.');
      }, { once: true });
      notify('active');
      return stream;
    } catch (error) {
      stream = null;
      video.srcObject = null;
      const message = error?.name === 'NotAllowedError'
        ? 'Camera permission was not granted.'
        : error?.name === 'NotFoundError'
          ? 'No camera was found on this device.'
          : `Could not start the camera: ${error?.message || 'unknown error'}`;
      notify('error', message);
      throw error;
    }
  }

  return {
    get active() { return Boolean(stream); },
    start,
    stop,
  };
}
