// Reproduces the global lexical name that previously collided with the raw
// tracker when OpenCV was loaded through importScripts.
let context = 'preexisting';
importScripts('/src/ar/camera-tracker.worker.js');

if (context !== 'preexisting') {
  self.postMessage({ type: 'state', state: 'error', message: 'The tracker changed the bootstrap worker context binding.' });
}
