import { layerOf, normalizeBoard, physicalBoardBounds, refOf } from './model/board.js';
import { normalizeInspectionSequence, sequenceItemKey, serializeInspectionSequence } from './model/inspection-sequence.js';
import { resolveConnectivity } from './model/connectivity.js';
import { loadBoardFile } from './parsers/file-loader.js';
import { createCameraController } from './ar/camera.js';
import { createCameraTracker, TRACKING_PROFILE_KEY } from './ar/camera-tracker.js';
import { computeHomography, createFourCornerCalibration, isValidCalibrationQuad, unprojectPoint } from './ar/four-corner-calibration.js';
import { attachedArtworkProjectionBounds, createBoardOnlySnapshot, createProjectedOverlay } from './ar/projected-overlay.js';
import { createTrackingDiagnosticLog, TRACKING_DEBUG_KEY } from './ar/tracking-diagnostics.js';
import { sampleFiles } from 'virtual:sample-manifest';
import {
  createCornerSmoother,
  displayPointToVideo,
  expandCalibrationQuad,
  getCalibrationLoupePlacement,
  getLoupeSourceCrop,
  videoPointToDisplay,
} from './ar/tracking-geometry.js';
import { getPinchPresentationTransform, invertPresentationPoint } from './ar/presentation-zoom.js';
import { createBoardRenderer } from './render/board-renderer.js';
import { createViewport } from './render/viewport.js';
import { createAppState, setBoard } from './state.js';
import { createThemeController } from './ui/theme.js';
import {
  createView,
  fitStatusText,
  renderLayers,
  setCoordinates,
  setLayerPreset,
  setStatus,
  setZoom,
  showNetSelection,
  showSelection,
  updateBoardDetails,
} from './ui/view.js';

const SEQUENCE_AR_ISOLATION_KEY = 'ar-duino-isolate-sequence-step';
const TRACKING_LOG_UI_ENABLED = false;
const state = createAppState();
const view = createView();
const viewport = createViewport(view.canvas, state);

const HELP_SCROLL_SPEED = 32;
const HELP_SCROLL_START_DELAY = 1000;
const HELP_SCROLL_PAUSE = 1000;
let helpTooltipAnimation = null;
let helpTooltipRestartTimer = null;
let helpTooltipRun = 0;

function stopHelpTooltipAutoScroll() {
  helpTooltipRun += 1;
  if (helpTooltipRestartTimer !== null) {
    window.clearTimeout(helpTooltipRestartTimer);
    helpTooltipRestartTimer = null;
  }
  if (helpTooltipAnimation) {
    helpTooltipAnimation.cancel();
    helpTooltipAnimation = null;
  }
  if (view.helpTooltipText) view.helpTooltipText.style.transform = 'translate3d(0, 0, 0)';
}

function startHelpTooltipAutoScroll({ delay = HELP_SCROLL_START_DELAY } = {}) {
  stopHelpTooltipAutoScroll();
  if (!view.helpTooltip || !view.helpTooltipText) return;
  const tooltipStyles = getComputedStyle(view.helpTooltip);
  const horizontalPadding = parseFloat(tooltipStyles.paddingLeft) + parseFloat(tooltipStyles.paddingRight);
  const contentWidth = Math.max(0, view.helpTooltip.clientWidth - horizontalPadding);
  const distance = view.helpTooltipText.getBoundingClientRect().width - contentWidth;
  if (distance <= 1) return;
  const run = helpTooltipRun;
  const animation = view.helpTooltipText.animate(
    [
      { transform: 'translate3d(0, 0, 0)' },
      { transform: `translate3d(-${distance}px, 0, 0)` },
    ],
    {
      delay,
      duration: Math.max(2500, (distance / HELP_SCROLL_SPEED) * 1000),
      easing: 'linear',
      fill: 'both',
    },
  );
  helpTooltipAnimation = animation;
  animation.onfinish = () => {
    if (run !== helpTooltipRun) return;
    helpTooltipRestartTimer = window.setTimeout(() => {
      if (run !== helpTooltipRun) return;
      view.helpTooltipText.style.transform = 'translate3d(0, 0, 0)';
      startHelpTooltipAutoScroll({ delay: 0 });
    }, HELP_SCROLL_PAUSE);
  };
}

function helpTooltipIsActive() {
  return Boolean(view.helpControl?.matches(':hover') || view.helpControl?.contains(document.activeElement));
}

function syncHelpTooltipAutoScroll() {
  if (helpTooltipIsActive()) {
    if (!helpTooltipAnimation && helpTooltipRestartTimer === null) startHelpTooltipAutoScroll();
  } else {
    stopHelpTooltipAutoScroll();
  }
}

view.helpControl?.addEventListener('mouseenter', syncHelpTooltipAutoScroll);
view.helpControl?.addEventListener('mouseleave', () => window.setTimeout(syncHelpTooltipAutoScroll, 0));
view.helpControl?.addEventListener('focusin', syncHelpTooltipAutoScroll);
view.helpControl?.addEventListener('focusout', (event) => {
  if (!view.helpControl.contains(event.relatedTarget)) window.setTimeout(syncHelpTooltipAutoScroll, 0);
});
window.addEventListener('resize', () => {
  if (helpTooltipIsActive()) startHelpTooltipAutoScroll();
  else stopHelpTooltipAutoScroll();
});

const renderer = createBoardRenderer({
  canvas: view.canvas,
  state,
  viewport,
  onScaleChange: (scale) => setZoom(view, scale),
});
const fourCornerCalibration = createFourCornerCalibration();
const projectedOverlay = createProjectedOverlay(view.arOverlayCanvas);
const trackingDebugContext = view.arDebugCanvas.getContext('2d');
const trackingDiagnosticLog = createTrackingDiagnosticLog();
let arMenuOpen = false;
let calibrationDragIndex = null;
let calibrationPointerId = null;
let calibrationPointerType = 'mouse';
let calibrationLoupeFrameId = null;
let calibrationLoupeVideoCallbackId = null;
let calibrationVideoSize = null;
let calibrationInitialPoints = [];
let calibrationSearchPoints = [];
let calibrationDetecting = false;
let calibrationRequestToken = 0;
let calibrationPreviewEnabled = false;
let calibrationPreviewSourceCanvas = null;
let calibrationPreviewSourceViewport = null;
let projectedSourceCanvas = null;
let projectedSourceViewport = null;
let physicalCalibrationBounds = null;
let projectedOverlayBounds = null;
let trackingTarget = null;
let trackingPresentationFrameId = null;
let trackingDebugFrameId = null;
let latestTrackingDiagnostic = null;
let trackingDebugEnabled = false;
let isolateSequenceInAr = false;
const trackedCornerSmoother = createCornerSmoother();
let arPresentationZoom = { scale: 1, tx: 0, ty: 0 };

function applyArPresentationZoom() {
  const transform = `translate3d(${arPresentationZoom.tx.toFixed(2)}px, ${arPresentationZoom.ty.toFixed(2)}px, 0) scale(${arPresentationZoom.scale.toFixed(4)})`;
  for (const element of [view.arCameraVideo, view.arOverlayCanvas, view.arDebugCanvas]) {
    element.style.transformOrigin = '0 0';
    element.style.transform = transform;
  }
}

function resetArPresentationZoom() {
  arPresentationZoom = { scale: 1, tx: 0, ty: 0 };
  applyArPresentationZoom();
}

function setCalibrationActive(active) {
  view.boardWrap.classList.toggle('calibration-active', Boolean(active));
}

function invalidateCalibrationRequest({ resetTracker = false } = {}) {
  calibrationRequestToken += 1;
  calibrationDetecting = false;
  if (resetTracker) cameraTracker.reset();
  if (view.arCalibrationDetectEdgeButton) view.arCalibrationDetectEdgeButton.disabled = false;
  if (view.arCalibrationApplyButton) view.arCalibrationApplyButton.disabled = false;
}

const cameraTracker = createCameraTracker(view.arCameraVideo, {
  onState: handleCameraTrackerState,
  onTracking: applyTrackedCorners,
  onDiagnostic: handleTrackingDiagnostic,
});
let savedTrackingProfile = 'balanced';
try {
  savedTrackingProfile = localStorage.getItem(TRACKING_PROFILE_KEY) || 'balanced';
  trackingDebugEnabled = localStorage.getItem(TRACKING_DEBUG_KEY) === 'true';
  isolateSequenceInAr = localStorage.getItem(SEQUENCE_AR_ISOLATION_KEY) === 'true';
} catch {
  // Storage can be unavailable in private Safari sessions.
}
if (![...view.devTrackingMethod.options].some((option) => option.value === savedTrackingProfile)) savedTrackingProfile = 'balanced';
view.devTrackingMethod.value = savedTrackingProfile;
view.devShowTrackingFeatures.checked = trackingDebugEnabled;
view.devIsolateSequence.checked = isolateSequenceInAr;
view.arDebugCanvas.hidden = !trackingDebugEnabled;
cameraTracker.setDebugEnabled(trackingDebugEnabled);
const camera = createCameraController(view.arCameraVideo, ({ state: cameraState, message }) => {
  // Worker/WASM loading is independent of the camera stream. Start it while
  // the browser is resolving the permission request so calibration can be
  // ready sooner, without making the preview wait for it.
  if (cameraState === 'requesting') {
    cameraTracker.start();
    if (message) setStatus(view, message);
    return;
  }
  const active = cameraState === 'active';
  resetArPresentationZoom();
  view.boardWrap.classList.toggle('camera-active', active);
  view.arCameraVideo.hidden = !active;
  view.arCameraButton.setAttribute('aria-pressed', String(active));
  view.arCameraButton.setAttribute('aria-label', active ? 'Close camera' : 'Open camera');
  view.arCameraButton.title = active ? 'Close camera' : 'Open camera';
  view.arCameraLabel.textContent = active ? 'Close camera' : 'Open camera';
  view.arCalibrationButton.disabled = !active || !state.data;
  if (!active) {
    cancelFourCornerCalibration();
    setCalibrationActive(false);
    projectedOverlay.clear();
    projectedSourceCanvas = null;
    projectedSourceViewport = null;
    physicalCalibrationBounds = state.data ? physicalBoardBounds(state.data) : null;
    projectedOverlayBounds = physicalCalibrationBounds
      ? attachedArtworkProjectionBounds(physicalCalibrationBounds)
      : null;
    trackingTarget = null;
    trackedCornerSmoother.reset();
    setOverlayTrackingState('idle');
    clearTrackingDebugOverlay({ discardDiagnostic: true });
    view.devTrackingMetrics.textContent = 'Tracker inactive · diagnostics retained for download';
    cameraTracker.stop();
  } else {
    // The tracker may have completed while camera permission/playback was in
    // progress, so preserve its ready state instead of disabling calibration.
    view.arCalibrationButton.disabled = !state.data || !cameraTracker.ready;
    cameraTracker.start();
  }
  if (message) setStatus(view, message);
  renderSequenceControls();
});
let activeSequenceEntries = [];
let activeSequenceTab = 'find';
let previewSequenceEntry = null;
let previewSequenceEditIndex = null;
let sequenceResumeIndex = 0;
let renderQueued = false;
let refreshingProjectedSource = false;

let loadedSampleId = '';

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderer.render();
    refreshProjectedSource();
  });
}

function shouldIsolateSequenceSelection() {
  return isolateSequenceInAr
    && camera.active
    && state.sequence.active
    && Boolean(state.selected || state.selectedNet);
}

// AR is intentionally rendered with the dark board palette in both app themes.
// Keep this capture isolated: immediately restore the user's theme and redraw
// the regular viewer once the projection source has been copied.
function createDarkArSourceSnapshot({ isolateSequenceSelection = false } = {}) {
  const root = document.documentElement;
  const originalMode = root.getAttribute('data-mode');
  const gridVisible = state.view.grid;
  try {
    state.view.grid = false;
    root.dataset.mode = 'dark';
    renderer.render({ isolateSequenceSelection });
    return {
      canvas: createBoardOnlySnapshot(
        view.canvas,
        getComputedStyle(root).getPropertyValue('--canvas-bg'),
        {
          viewport,
          physicalBounds: physicalCalibrationBounds,
          projectionBounds: projectedOverlayBounds,
        },
      ),
      viewport: captureSourceViewport(),
    };
  } finally {
    if (originalMode === null) root.removeAttribute('data-mode');
    else root.setAttribute('data-mode', originalMode);
    state.view.grid = gridVisible;
    renderer.render();
  }
}

// The camera transform changes on every tracking frame, but the projected
// source only needs to be rebuilt when the PCB viewer state changes. Keeping
// this work behind the normal render queue makes AR selection, search, layer,
// and sequence changes visible without adding work to the tracking loop.
function refreshProjectedSource() {
  if (refreshingProjectedSource || !camera.active || !state.data || !fourCornerCalibration.homography) return;
  if (!physicalCalibrationBounds || !projectedOverlayBounds) return;
  refreshingProjectedSource = true;
  try {
    const { canvas: nextSourceCanvas, viewport: nextSourceViewport } = createDarkArSourceSnapshot({
      isolateSequenceSelection: shouldIsolateSequenceSelection(),
    });
    const overlayRendered = projectedOverlay.render({
      boardCanvas: nextSourceCanvas,
      viewport: nextSourceViewport,
      bounds: projectedOverlayBounds,
      matrix: fourCornerCalibration.homography,
      margin: 0,
    });
    if (overlayRendered) {
      projectedSourceCanvas = nextSourceCanvas;
      projectedSourceViewport = nextSourceViewport;
    }
  } catch (error) {
    // A tainted canvas or a lost rendering context should not disable all
    // future viewer updates or leave the grid hidden.
    try { setStatus(view, 'AR overlay refresh skipped; keeping the last projection.'); } catch { /* status UI may be unavailable during teardown */ }
  } finally {
    refreshingProjectedSource = false;
  }
}

function updateCalibrationPreviewButton() {
  const button = view.arCalibrationPreviewButton;
  if (!button) return;
  const visible = calibrationPreviewEnabled;
  button.setAttribute('aria-pressed', String(visible));
  button.setAttribute('aria-label', visible ? 'Hide PCB overlay preview' : 'Show PCB overlay preview');
  button.title = visible ? 'Hide PCB overlay preview' : 'Show PCB overlay preview';
}

function clearCalibrationPreview({ discardSource = true } = {}) {
  calibrationPreviewEnabled = false;
  updateCalibrationPreviewButton();
  projectedOverlay.clear();
  view.arOverlayCanvas.style.setProperty('--ar-tracking-opacity', '0');
  view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', '0');
  if (discardSource) {
    calibrationPreviewSourceCanvas = null;
    calibrationPreviewSourceViewport = null;
  }
}

function buildCalibrationPreviewSource() {
  if (calibrationPreviewSourceCanvas && calibrationPreviewSourceViewport) return true;
  if (!state.data || !physicalCalibrationBounds || !projectedOverlayBounds) return false;
  const snapshot = createDarkArSourceSnapshot();
  calibrationPreviewSourceCanvas = snapshot.canvas;
  calibrationPreviewSourceViewport = snapshot.viewport;
  return true;
}

function renderCalibrationPreview() {
  if (!calibrationPreviewEnabled || !fourCornerCalibration.active) return;
  const points = fourCornerCalibration.points;
  if (!isValidCalibrationQuad(points) || !physicalCalibrationBounds || !projectedOverlayBounds || !buildCalibrationPreviewSource()) {
    projectedOverlay.clear();
    view.arOverlayCanvas.style.setProperty('--ar-tracking-opacity', '0');
    view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', '0');
    return;
  }
  const { minX, minY, maxX, maxY } = physicalCalibrationBounds;
  const matrix = computeHomography(
    [{ x: minX, y: maxY }, { x: maxX, y: maxY }, { x: maxX, y: minY }, { x: minX, y: minY }],
    points,
  );
  if (!matrix) {
    projectedOverlay.clear();
    view.arOverlayCanvas.style.setProperty('--ar-tracking-opacity', '0');
    view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', '0');
    return;
  }
  const rendered = projectedOverlay.render({
    boardCanvas: calibrationPreviewSourceCanvas,
    viewport: calibrationPreviewSourceViewport,
    bounds: projectedOverlayBounds,
    matrix,
    margin: 0,
    opacity: 1,
  });
  if (rendered) {
    view.arOverlayCanvas.style.setProperty('--ar-tracking-opacity', '0.95');
    view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', '1');
  }
}

createThemeController(view.themeToggle, () => {
  renderer.invalidateThemeCache();
  render();
}, view.themeToggleLabel);

function refreshConnectivity() {
  const selection = {
    component: state.selected,
    net: state.selectedNet,
  };
  if (state.sequence.active) {
    const activeEntry = activeSequenceEntries[state.sequence.index];
    const activePin = String(state.sequence.activePin || '').trim();
    if (state.selected && activePin) {
      selection.pin = activePin;
      selection.pinNet = activeEntry?.pinNet || '';
    }
    if (state.selectedNet) selection.directOnly = true;
  }
  state.connectivity = resolveConnectivity(state.data, selection);
}

function selectConnectedComponent(component) {
  const netName = state.selectedNet;
  showSelection(view, state, component);
  refreshConnectivity();
  setStatus(view, `${refOf(component) || 'Component'} selected from net ${netName || 'connection'}.`);
  render();
}

function selectNet(netName) {
  state.selected = null;
  state.selectedNet = netName;
  refreshConnectivity();
  showNetSelection(view, state, netName, selectConnectedComponent);
  render();
}

function fitBoard() {
  viewport.fit();
  render();
}

function setArMenuOpen(open) {
  arMenuOpen = open;
  view.arMenu.hidden = !open;
  if (!open) {
    view.arTransparencyControl.hidden = true;
    view.arTransparencyButton.setAttribute('aria-expanded', 'false');
  }
  view.arMenuButton.setAttribute('aria-expanded', String(open));
  view.arMenuButton.setAttribute('aria-label', open ? 'Close AR controls' : 'Open AR controls');
  view.arMenuButton.title = open ? 'Close AR controls' : 'Open AR controls';
}

function captureSourceViewport() {
  const { w, h } = viewport.screenSize();
  const center = { ...state.viewport.center };
  const { offsetX, offsetY, scale } = state.viewport;
  return {
    screenSize: () => ({ w, h }),
    screen: (point) => ({
      x: w / 2 + offsetX + (point.x - center.x) * scale,
      y: h / 2 + offsetY - (point.y - center.y) * scale,
    }),
  };
}

function updateArTransparency(value) {
  const numericValue = Number(value);
  const percentage = Math.max(0, Math.min(100, Number.isFinite(numericValue) ? numericValue : 50));
  const balance = (percentage - 50) / 50;
  view.arTransparencyRange.value = String(percentage);
  view.arTransparencyValue.textContent = `${percentage}%`;
  if (view.sequenceArTransparencyRange) view.sequenceArTransparencyRange.value = String(percentage);
  if (view.sequenceArTransparencyValue) view.sequenceArTransparencyValue.textContent = `${percentage}%`;
  view.arCameraVideo.style.filter = `brightness(${(1 - balance * 0.35).toFixed(2)})`;
  view.arOverlayCanvas.style.filter = `brightness(${(1 + balance * 0.35).toFixed(2)})`;
  view.arOverlayCanvas.style.setProperty('--ar-user-opacity', (percentage / 100).toFixed(2));
}

function setOverlayTrackingState(state) {
  const opacities = {
    idle: 0,
    calibrating: 0.65,
    tracked: 1,
    suspect: 0.55,
    recovering: 0.2,
    lost: 0,
  };
  const normalized = Object.hasOwn(opacities, state) ? state : 'idle';
  view.arOverlayCanvas.dataset.trackingState = normalized;
  const canInteract = camera.active
    && Boolean(projectedSourceCanvas) && Boolean(fourCornerCalibration.homography);
  view.arOverlayCanvas.style.pointerEvents = canInteract ? 'auto' : 'none';
  view.arOverlayCanvas.style.setProperty('--ar-tracking-opacity', String(opacities[normalized]));
  if (normalized === 'lost' || normalized === 'idle') {
    view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', '0');
  }
}

function clearTrackingDebugOverlay({ discardDiagnostic = false } = {}) {
  if (trackingDebugFrameId != null) cancelAnimationFrame(trackingDebugFrameId);
  trackingDebugFrameId = null;
  if (discardDiagnostic) latestTrackingDiagnostic = null;
  if (!trackingDebugContext) return;
  trackingDebugContext.setTransform(1, 0, 0, 1, 0, 0);
  trackingDebugContext.clearRect(0, 0, view.arDebugCanvas.width, view.arDebugCanvas.height);
}

function prepareTrackingDebugCanvas() {
  const rect = view.boardWrap.getBoundingClientRect();
  const pixelRatio = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const width = Math.max(1, Math.round(rect.width * pixelRatio));
  const height = Math.max(1, Math.round(rect.height * pixelRatio));
  if (view.arDebugCanvas.width !== width || view.arDebugCanvas.height !== height) {
    view.arDebugCanvas.width = width;
    view.arDebugCanvas.height = height;
  }
  trackingDebugContext.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  trackingDebugContext.clearRect(0, 0, rect.width, rect.height);
  return rect;
}

function drawDebugPoints(points, { color, radius, fill = false, cross = false, alpha = 1 }) {
  if (!points?.length) return;
  trackingDebugContext.save();
  trackingDebugContext.globalAlpha = alpha;
  trackingDebugContext.strokeStyle = color;
  trackingDebugContext.fillStyle = color;
  trackingDebugContext.lineWidth = 1.5;
  for (const point of points) {
    if (cross) {
      trackingDebugContext.beginPath();
      trackingDebugContext.moveTo(point.x - radius, point.y);
      trackingDebugContext.lineTo(point.x + radius, point.y);
      trackingDebugContext.moveTo(point.x, point.y - radius);
      trackingDebugContext.lineTo(point.x, point.y + radius);
      trackingDebugContext.stroke();
      continue;
    }
    trackingDebugContext.beginPath();
    trackingDebugContext.arc(point.x, point.y, radius, 0, Math.PI * 2);
    if (fill) trackingDebugContext.fill();
    else trackingDebugContext.stroke();
  }
  trackingDebugContext.restore();
}

function drawTrackingDebugOverlay() {
  trackingDebugFrameId = null;
  if (!trackingDebugEnabled || !camera.active || !latestTrackingDiagnostic || !trackingDebugContext) {
    clearTrackingDebugOverlay();
    return;
  }
  const rect = prepareTrackingDebugCanvas();
  const points = latestTrackingDiagnostic.points || {};
  drawDebugPoints(points.detected, { color: '#42e8ff', radius: 1.8, fill: true, alpha: 0.62 });
  drawDebugPoints(points.matched, { color: '#ffc247', radius: 3, alpha: 0.9 });
  drawDebugPoints(points.flow, { color: '#ff63dc', radius: 3.2, cross: true, alpha: 0.9 });
  drawDebugPoints(points.inliers, { color: '#7cff6b', radius: 4.2, alpha: 1 });
  if (points.corners?.length === 4) {
    trackingDebugContext.save();
    trackingDebugContext.strokeStyle = '#7cff6b';
    trackingDebugContext.lineWidth = 2;
    trackingDebugContext.setLineDash([7, 5]);
    trackingDebugContext.beginPath();
    trackingDebugContext.moveTo(points.corners[0].x, points.corners[0].y);
    for (const point of points.corners.slice(1)) trackingDebugContext.lineTo(point.x, point.y);
    trackingDebugContext.closePath();
    trackingDebugContext.stroke();
    trackingDebugContext.restore();
  }
  trackingDebugContext.save();
  trackingDebugContext.fillStyle = 'rgba(0, 0, 0, .72)';
  trackingDebugContext.fillRect(8, Math.max(8, rect.height - 30), Math.min(330, rect.width - 16), 22);
  trackingDebugContext.fillStyle = '#f4f7f2';
  trackingDebugContext.font = '11px ui-monospace, monospace';
  trackingDebugContext.fillText(view.devTrackingMetrics.textContent.slice(0, 52), 14, Math.max(23, rect.height - 15));
  trackingDebugContext.restore();
}

function scheduleTrackingDebugOverlay() {
  if (!trackingDebugEnabled || trackingDebugFrameId != null) return;
  trackingDebugFrameId = requestAnimationFrame(drawTrackingDebugOverlay);
}

function metric(value, digits = 0) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : '—';
}

function formatTrackingDiagnostic(diagnostic) {
  const winner = diagnostic.winner;
  const flow = diagnostic.flow || {};
  const bestRejected = [...(diagnostic.attempts || [])]
    .sort((left, right) => (right.pairs || 0) - (left.pairs || 0))[0];
  const result = winner
    ? `${winner.method}${winner.viewId ? `/${winner.viewId}` : ''} · ${winner.inliers}/${winner.matches} inliers · grid ${winner.coverage}/12 · err ${metric(winner.reprojectionError, 1)} px`
    : `no pose · ${bestRejected?.rejectedBy || diagnostic.featureRejectedBy || flow.rejectedBy || 'waiting for reference'}`;
  const learnedViews = diagnostic.learnedView?.liveViewCount ?? diagnostic.liveViewCount ?? 0;
  return `${diagnostic.state || 'READY'} · ${result}\nfeatures ${diagnostic.featureCount ?? '—'} · best match ${diagnostic.bestFeatureMatches ?? '—'} · LK ${flow.validCount ?? 0}/${flow.seedCount ?? 0} · learned ${learnedViews}/6 · ${metric(diagnostic.processingMs, 1)} ms`;
}

function handleTrackingDiagnostic(diagnostic) {
  latestTrackingDiagnostic = diagnostic;
  trackingDiagnosticLog.record('frame', diagnostic);
  if (TRACKING_LOG_UI_ENABLED) view.devDownloadTrackingLog.disabled = trackingDiagnosticLog.size === 0;
  view.devTrackingMetrics.textContent = formatTrackingDiagnostic(diagnostic);
  scheduleTrackingDebugOverlay();
}

function recordTrackerEvent(message) {
  trackingDiagnosticLog.record('tracker-state', {
    type: message.type,
    state: message.state || null,
    message: message.message || null,
    relocalized: Boolean(message.relocalized),
    featureCount: message.featureCount,
    viewCount: message.viewCount,
  });
  if (TRACKING_LOG_UI_ENABLED) view.devDownloadTrackingLog.disabled = false;
}

function selectedCameraSettings() {
  const settings = view.arCameraVideo.srcObject?.getVideoTracks?.()[0]?.getSettings?.() || {};
  const allowed = {};
  for (const key of ['width', 'height', 'frameRate', 'facingMode', 'resizeMode']) {
    if (['string', 'number', 'boolean'].includes(typeof settings[key])) allowed[key] = settings[key];
  }
  return allowed;
}

function downloadTrackingDiagnostics() {
  const payload = trackingDiagnosticLog.snapshot({
    appOrigin: window.location.origin,
    trackingProfile: view.devTrackingMethod.value,
    debugFeaturesVisible: trackingDebugEnabled,
    boardName: state.data?.name || null,
    userAgent: navigator.userAgent,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemoryGiB: navigator.deviceMemory || null,
    screen: {
      width: window.screen?.width || null,
      height: window.screen?.height || null,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    camera: selectedCameraSettings(),
  });
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `ar-duino-tracking-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  setStatus(view, `Downloaded ${trackingDiagnosticLog.size} local tracking diagnostic entries.`);
}

function updateTrackingDebugEnabled(enabled) {
  trackingDebugEnabled = Boolean(enabled);
  view.devShowTrackingFeatures.checked = trackingDebugEnabled;
  view.arDebugCanvas.hidden = !trackingDebugEnabled;
  cameraTracker.setDebugEnabled(trackingDebugEnabled);
  if (trackingDebugEnabled) scheduleTrackingDebugOverlay();
  else clearTrackingDebugOverlay();
  trackingDiagnosticLog.record('debug-visibility', { enabled: trackingDebugEnabled });
  if (TRACKING_LOG_UI_ENABLED) view.devDownloadTrackingLog.disabled = false;
}

function presentTrackedOverlay(timestamp) {
  trackingPresentationFrameId = null;
  if (!camera.active || !projectedSourceCanvas || !projectedSourceViewport || !trackingTarget) return;
  const targetAge = Math.max(0, timestamp - trackingTarget.timestamp);
  const freshness = targetAge <= 450 ? 1 : Math.max(0, 1 - (targetAge - 450) / 650);
  view.arOverlayCanvas.style.setProperty('--ar-tracking-freshness', freshness.toFixed(3));
  const points = trackedCornerSmoother.filter(trackingTarget.points, timestamp, trackingTarget.confidence);
  if (fourCornerCalibration.updateTrackingPoints(points)) {
    projectedOverlay.render({
      boardCanvas: projectedSourceCanvas,
      viewport: projectedSourceViewport,
      bounds: projectedOverlayBounds || physicalCalibrationBounds || state.data.bounds,
      matrix: fourCornerCalibration.homography,
      margin: 0,
    });
  }
  if (freshness > 0 || targetAge < 1_600) trackingPresentationFrameId = requestAnimationFrame(presentTrackedOverlay);
}

function scheduleTrackedOverlayPresentation() {
  if (trackingPresentationFrameId == null) trackingPresentationFrameId = requestAnimationFrame(presentTrackedOverlay);
}

function renderFourCornerCalibration() {
  const points = fourCornerCalibration.points;
  view.arCalibrationOverlay.hidden = false;
  view.arCalibrationGuide.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = 'Calibration';
  const instruction = document.createElement('span');
  instruction.textContent = 'Drag the four handles onto the board corners, or detect the edge, then apply.';
  view.arCalibrationGuide.append(title, instruction);
  view.arCalibrationDetectEdgeButton.disabled = calibrationDetecting;
  view.arCalibrationDetectEdgeButton.textContent = calibrationDetecting ? 'Detecting…' : 'Detect edge';
  view.arCalibrationDetectEdgeButton.setAttribute('aria-busy', String(calibrationDetecting));
  view.arCalibrationApplyButton.disabled = calibrationDetecting;
  let searchFrame = view.arCalibrationOverlay.querySelector('.ar-calibration-search');
  if (calibrationSearchPoints.length === 4) {
    if (!searchFrame) {
      searchFrame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      searchFrame.setAttribute('class', 'ar-calibration-frame ar-calibration-search');
      searchFrame.setAttribute('aria-hidden', 'true');
      searchFrame.append(document.createElementNS('http://www.w3.org/2000/svg', 'polygon'));
      view.arCalibrationOverlay.append(searchFrame);
    }
    searchFrame.querySelector('polygon').setAttribute('points', calibrationSearchPoints.map((point) => `${point.x},${point.y}`).join(' '));
  } else if (searchFrame) searchFrame.remove();
  const frame = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  frame.setAttribute('class', 'ar-calibration-frame');
  frame.setAttribute('aria-hidden', 'true');
  let polygon = view.arCalibrationOverlay.querySelector('.ar-calibration-frame:not(.ar-calibration-search) polygon');
  if (!polygon) polygon = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
  polygon.setAttribute('points', points.map((point) => `${point.x},${point.y}`).join(' '));
  frame.append(polygon);
  const oldFrame = view.arCalibrationOverlay.querySelector('.ar-calibration-frame:not(.ar-calibration-search)');
  if (oldFrame) oldFrame.replaceWith(frame);
  else view.arCalibrationOverlay.append(frame);
  const handles = [...view.arCalibrationOverlay.querySelectorAll('.ar-calibration-handle')];
  points.forEach((point, index) => {
    const handle = handles[index] || document.createElement('button');
    if (!handles[index]) {
      handle.type = 'button';
      handle.className = 'ar-calibration-handle';
      view.arCalibrationOverlay.append(handle);
    }
    handle.dataset.cornerIndex = String(index);
    handle.setAttribute('aria-label', `Move ${['top-left', 'top-right', 'bottom-right', 'bottom-left'][index]} board corner`);
    handle.textContent = String(index + 1);
    handle.classList.toggle('is-dragging', index === calibrationDragIndex);
    handle.style.left = `${point.x}px`;
    handle.style.top = `${point.y}px`;
  });
  updateCalibrationPreviewButton();
  renderCalibrationPreview();
}

function hideCalibrationLoupe() {
  if (calibrationLoupeFrameId != null) cancelAnimationFrame(calibrationLoupeFrameId);
  calibrationLoupeFrameId = null;
  if (calibrationLoupeVideoCallbackId != null && typeof view.arCameraVideo.cancelVideoFrameCallback === 'function') {
    view.arCameraVideo.cancelVideoFrameCallback(calibrationLoupeVideoCallbackId);
  }
  calibrationLoupeVideoCallbackId = null;
  view.arCalibrationLoupe.hidden = true;
}

function drawCalibrationLoupe() {
  calibrationLoupeFrameId = null;
  calibrationLoupeVideoCallbackId = null;
  if (calibrationPointerId == null || calibrationDragIndex == null || !fourCornerCalibration.active || !calibrationVideoSize) return;
  const overlayRect = view.arCalibrationOverlay.getBoundingClientRect();
  const point = fourCornerCalibration.points[calibrationDragIndex];
  if (!point || !overlayRect.width || !overlayRect.height) return;
  view.arCalibrationLoupe.hidden = false;
  const lensRect = view.arCalibrationLoupe.getBoundingClientRect();
  const lensWidth = lensRect.width || 100;
  const lensHeight = lensRect.height || lensWidth;
  const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const canvas = view.arCalibrationLoupeCanvas;
  const pixelWidth = Math.max(1, Math.round(lensWidth * dpr));
  const pixelHeight = Math.max(1, Math.round(lensHeight * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#101515';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const crop = getLoupeSourceCrop(
    point,
    calibrationVideoSize,
    { width: overlayRect.width, height: overlayRect.height },
    { zoom: 3, lensSize: { width: lensWidth, height: lensHeight } },
  );
  if (crop.source.width > 0 && crop.source.height > 0) {
    context.imageSmoothingEnabled = true;
    context.drawImage(
      view.arCameraVideo,
      crop.source.x,
      crop.source.y,
      crop.source.width,
      crop.source.height,
      crop.destination.x * dpr,
      crop.destination.y * dpr,
      crop.destination.width * dpr,
      crop.destination.height * dpr,
    );
  }
  const placement = getCalibrationLoupePlacement(
    point,
    { width: overlayRect.width, height: overlayRect.height },
    { width: lensWidth, height: lensHeight },
    calibrationPointerType,
  );
  view.arCalibrationLoupe.style.left = `${placement.left}px`;
  view.arCalibrationLoupe.style.top = `${placement.top}px`;
}

function scheduleCalibrationLoupe() {
  if (calibrationPointerId == null || calibrationDragIndex == null) return;
  if (typeof view.arCameraVideo.requestVideoFrameCallback === 'function') {
    if (calibrationLoupeVideoCallbackId != null) return;
    calibrationLoupeVideoCallbackId = view.arCameraVideo.requestVideoFrameCallback(() => {
      drawCalibrationLoupe();
      scheduleCalibrationLoupe();
    });
    return;
  }
  if (calibrationLoupeFrameId == null) {
    calibrationLoupeFrameId = requestAnimationFrame(() => {
      drawCalibrationLoupe();
      scheduleCalibrationLoupe();
    });
  }
}

function endCalibrationHandleDrag(event, { commit = false } = {}) {
  if (calibrationPointerId == null || (event && event.pointerId !== calibrationPointerId)) return;
  const pointerId = calibrationPointerId;
  if (commit && event) moveCalibrationHandle(event);
  calibrationPointerId = null;
  calibrationDragIndex = null;
  hideCalibrationLoupe();
  renderFourCornerCalibration();
  if (view.arCalibrationOverlay.hasPointerCapture?.(pointerId)) {
    try { view.arCalibrationOverlay.releasePointerCapture(pointerId); } catch { /* capture may already be gone */ }
  }
}

function cancelFourCornerCalibration({ resetTracker = true } = {}) {
  invalidateCalibrationRequest({ resetTracker });
  clearCalibrationPreview();
  calibrationVideoSize = null;
  calibrationInitialPoints = [];
  calibrationSearchPoints = [];
  endCalibrationHandleDrag(null);
  hideCalibrationLoupe();
  if (!fourCornerCalibration.active && !fourCornerCalibration.homography) {
    setCalibrationActive(false);
    return;
  }
  calibrationDragIndex = null;
  fourCornerCalibration.cancel();
  view.arCalibrationOverlay.hidden = true;
  for (const element of view.arCalibrationOverlay.querySelectorAll('.ar-calibration-frame, .ar-calibration-handle')) element.remove();
  setCalibrationActive(false);
}

function beginFourCornerCalibration() {
  if (!camera.active) {
    setCalibrationActive(false);
    setStatus(view, 'Open the camera before starting calibration.');
    return;
  }
  if (!state.data?.bounds || !physicalCalibrationBounds) {
    setCalibrationActive(false);
    setStatus(view, 'Load a board before starting calibration.');
    return;
  }
  if (!cameraTracker.ready) {
    setCalibrationActive(false);
    setStatus(view, 'The on-device vision engine is still loading. Try calibration again in a moment.');
    return;
  }
  resetArPresentationZoom();
  clearCalibrationPreview();
  cameraTracker.reset();
  invalidateCalibrationRequest();
  endCalibrationHandleDrag(null);
  hideCalibrationLoupe();
  clearTrackingDebugOverlay({ discardDiagnostic: true });
  trackingTarget = null;
  trackedCornerSmoother.reset();
  projectedOverlay.clear();
  projectedSourceCanvas = null;
  projectedSourceViewport = null;
  setOverlayTrackingState('idle');
  setArMenuOpen(false);
  updateArTransparency(50);
  view.arCalibrationOverlay.hidden = false;
  const rect = view.arCalibrationOverlay.getBoundingClientRect();
  const frameWidth = Math.min(rect.width - 48, rect.width * 0.82);
  const frameHeight = Math.min(rect.height - 144, frameWidth * 0.52);
  const startX = (rect.width - frameWidth) / 2;
  const startY = (rect.height - frameHeight) / 2;
  fourCornerCalibration.begin(physicalCalibrationBounds, [
    { x: startX, y: startY },
    { x: startX + frameWidth, y: startY },
    { x: startX + frameWidth, y: startY + frameHeight },
    { x: startX, y: startY + frameHeight },
  ]);
  calibrationInitialPoints = fourCornerCalibration.points;
  calibrationSearchPoints = expandCalibrationQuad(calibrationInitialPoints, 0.1);
  setCalibrationActive(true);
  calibrationVideoSize = {
    width: view.arCameraVideo.videoWidth || 1,
    height: view.arCameraVideo.videoHeight || 1,
  };
  renderFourCornerCalibration();
  setStatus(view, 'Calibration: adjust the four handles or detect the board edge, then apply it.');
}

function moveCalibrationHandle(event) {
  if (!fourCornerCalibration.active || calibrationDragIndex == null || calibrationPointerId == null) return;
  if (event.pointerId !== calibrationPointerId) return;
  const rect = view.arCalibrationOverlay.getBoundingClientRect();
  fourCornerCalibration.setPoint(calibrationDragIndex, {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
  });
  renderFourCornerCalibration();
  scheduleCalibrationLoupe();
}

function startCalibrationHandleDrag(event) {
  if (calibrationPointerId != null) return;
  const handle = event.target.closest('.ar-calibration-handle');
  if (!handle) return;
  const index = Number(handle.dataset.cornerIndex);
  if (!Number.isInteger(index)) return;
  calibrationPointerId = event.pointerId;
  calibrationPointerType = event.pointerType || 'mouse';
  calibrationDragIndex = index;
  try { view.arCalibrationOverlay.setPointerCapture(event.pointerId); } catch { /* capture can fail for synthetic events */ }
  event.preventDefault();
  moveCalibrationHandle(event);
  scheduleCalibrationLoupe();
}

async function detectCalibrationEdge() {
  if (!fourCornerCalibration.active || calibrationDetecting) return;
  endCalibrationHandleDrag(null);
  hideCalibrationLoupe();
  const requestToken = ++calibrationRequestToken;
  const fallbackPoints = fourCornerCalibration.points;
  const initialPoints = calibrationInitialPoints.map((point) => ({ ...point }));
  if (initialPoints.length !== 4) return;
  calibrationDetecting = true;
  renderFourCornerCalibration();
  setStatus(view, 'Detecting the board edge in the highlighted region…');
  try {
    const result = await cameraTracker.detectEdges(initialPoints, view.arCalibrationOverlay.getBoundingClientRect(), { expansionRatio: 0.1 });
    if (requestToken !== calibrationRequestToken || !fourCornerCalibration.active) return;
    if (!result || !isValidCalibrationQuad(result.points, { minimumArea: 400, minimumEdge: 10 })) {
      throw new Error('The detected edge was not a clear board outline. Drag the handles closer and try again.');
    }
    for (const [index, point] of result.points.entries()) fourCornerCalibration.setPoint(index, point);
    renderFourCornerCalibration();
    const confidence = Number.isFinite(result.confidence) ? ` (${Math.round(result.confidence * 100)}% confidence)` : '';
    setStatus(view, `Board edge detected${confidence}. Review the four corners, then Apply.`);
  } catch (error) {
    if (requestToken !== calibrationRequestToken) return;
    // Keep the manual points from before the request if the detector failed.
    fallbackPoints.forEach((point, index) => fourCornerCalibration.setPoint(index, point));
    renderFourCornerCalibration();
    setStatus(view, error?.message || 'The board edge could not be detected. Drag the handles manually and try again.');
  } finally {
    if (requestToken === calibrationRequestToken) {
      calibrationDetecting = false;
      renderFourCornerCalibration();
    }
  }
}

function stopCalibrationHandleDrag(event) {
  endCalibrationHandleDrag(event, { commit: event.type === 'pointerup' });
}

function applyFourCornerCalibration() {
  if (calibrationDetecting) {
    setStatus(view, 'Wait for edge detection to finish before applying calibration.');
    return;
  }
  invalidateCalibrationRequest();
  if (!cameraTracker.ready) {
    setStatus(view, 'The on-device vision engine is still loading. Keep the corners in place and try Apply again.');
    return;
  }
  endCalibrationHandleDrag(null);
  hideCalibrationLoupe();
  const result = fourCornerCalibration.complete();
  if (result.error) {
    setStatus(view, result.error);
    return;
  }
  if (calibrationPreviewSourceCanvas && calibrationPreviewSourceViewport) {
    projectedSourceCanvas = calibrationPreviewSourceCanvas;
    projectedSourceViewport = calibrationPreviewSourceViewport;
  } else {
    const snapshot = createDarkArSourceSnapshot();
    projectedSourceCanvas = snapshot.canvas;
    projectedSourceViewport = snapshot.viewport;
  }
  renderer.render();
  const overlayRendered = projectedOverlay.render({
    boardCanvas: projectedSourceCanvas,
    viewport: projectedSourceViewport,
    bounds: projectedOverlayBounds || physicalCalibrationBounds || state.data.bounds,
    matrix: fourCornerCalibration.homography,
    margin: 0,
  });
  updateArTransparency(100);
  trackedCornerSmoother.reset();
  trackingTarget = null;
  setOverlayTrackingState('calibrating');
  const boardWidth = Math.abs(physicalCalibrationBounds.maxX - physicalCalibrationBounds.minX);
  const boardHeight = Math.abs(physicalCalibrationBounds.maxY - physicalCalibrationBounds.minY);
  cameraTracker.calibrate(
    fourCornerCalibration.points,
    view.arCameraVideo.getBoundingClientRect(),
    { boardAspect: boardWidth / Math.max(1e-6, boardHeight) },
  );
  calibrationPreviewEnabled = false;
  updateCalibrationPreviewButton();
  calibrationPreviewSourceCanvas = null;
  calibrationPreviewSourceViewport = null;
  // The preview source was built before calibration was committed and may
  // contain the full board. Rebuild through the normal source path now so an
  // active sequence-isolation preference is reflected on the first AR frame.
  refreshProjectedSource();
  calibrationVideoSize = null;
  calibrationInitialPoints = [];
  calibrationSearchPoints = [];
  view.arCalibrationOverlay.hidden = true;
  setCalibrationActive(false);
  setStatus(view, overlayRendered
    ? 'Calibration saved. The PCB artwork now maps to the selected physical board outline.'
    : 'Calibration saved, but the PCB overlay could not be drawn.');
}

function applyTrackedCorners(tracking) {
  if (fourCornerCalibration.active || !camera.active || !projectedSourceCanvas || tracking.confidence < 0.12) return;
  if (tracking.relocalized) trackedCornerSmoother.reset();
  trackingTarget = {
    points: tracking.points.map((point) => ({ ...point })),
    confidence: tracking.confidence,
    timestamp: performance.now(),
  };
  setOverlayTrackingState('tracked');
  scheduleTrackedOverlayPresentation();
}

function handleCameraTrackerState(message) {
  recordTrackerEvent(message);
  if (message.type === 'calibrated') {
    view.arCalibrationButton.disabled = !camera.active || !cameraTracker.ready;
    setOverlayTrackingState('tracked');
    setStatus(view, `Markerless tracking is active using ${message.featureCount} board features across ${message.viewCount || 1} reference views.`);
  } else if (message.type === 'tracking-state') {
    const messages = {
      SUSPECT: 'Tracking is uncertain. Checking a wider board region.',
      RECOVERING: 'Tracking is recovering from board features.',
      LOST: 'Tracking lost. Keep the board in view or realign the four corners.',
      TRACKED: 'Markerless tracking recovered.',
    };
    const stateName = String(message.state || '').toLowerCase();
    setOverlayTrackingState(stateName);
    if (message.state === 'LOST') {
      trackingTarget = null;
      trackedCornerSmoother.reset();
    } else if (message.state === 'TRACKED' && message.relocalized) {
      trackedCornerSmoother.reset();
    }
    setStatus(view, messages[message.state] || 'Markerless tracking status changed.');
  } else if (message.type === 'calibration-failed' || message.state === 'error') {
    if (message.state === 'error' && fourCornerCalibration.active) cancelFourCornerCalibration({ resetTracker: false });
    else {
      invalidateCalibrationRequest();
      setCalibrationActive(false);
    }
    trackingTarget = null;
    trackedCornerSmoother.reset();
    setOverlayTrackingState('lost');
    if (message.state === 'error') clearTrackingDebugOverlay({ discardDiagnostic: true });
    view.arCalibrationButton.disabled = !camera.active || !cameraTracker.ready;
    setStatus(view, message.message || 'Markerless tracking is unavailable. Calibrate again with the board fully visible.');
  } else if (message.type === 'state' && message.state === 'ready') {
    view.arCalibrationButton.disabled = !camera.active;
    view.arCalibrationButton.title = state.data
      ? 'Calibration'
      : 'Load a board before calibration';
    setStatus(view, state.data
      ? 'On-device vision is ready. Choose Calibration from the AR menu.'
      : 'On-device vision is ready. Load a board, then choose Calibration.');
  } else if (message.type === 'state' && message.message) {
    view.arCalibrationButton.disabled = true;
    setStatus(view, message.message);
  }
}

async function toggleCameraMode() {
  if (camera.active || camera.pending) {
    camera.stop();
    setStatus(view, 'AR camera mode closed.');
    return;
  }
  closeSearchWindow();
  closeControlWindow();
  setBoardMenuOpen(false);
  try {
    await camera.start();
    if (!camera.active) return;
    setStatus(view, state.data
    ? 'Camera active. Choose Calibration from the AR menu.'
      : 'Camera active. Load a board before calibration.');
  } catch {
    // The controller supplies a user-facing, permission-specific message.
  }
}

function loadBoard(rawBoard, name, { sampleId = '' } = {}) {
  resetArPresentationZoom();
  trackingTarget = null;
  sequenceResumeIndex = 0;
  trackedCornerSmoother.reset();
  cancelFourCornerCalibration();
  projectedOverlay.clear();
  projectedSourceCanvas = null;
  projectedSourceViewport = null;
  physicalCalibrationBounds = null;
  projectedOverlayBounds = null;
  cameraTracker.reset();
  clearTrackingDebugOverlay({ discardDiagnostic: true });
  setOverlayTrackingState('idle');
  const board = normalizeBoard(rawBoard);
  setBoard(state, board);
  loadedSampleId = sampleId;
  physicalCalibrationBounds = physicalBoardBounds(board);
  projectedOverlayBounds = attachedArtworkProjectionBounds(physicalCalibrationBounds);
  activeSequenceEntries = [];
  closeSearchWindow();
  view.sequenceWindow.hidden = true;
  view.sequencePreview.hidden = true;
  view.sequenceBackdrop.hidden = true;
  view.selectionPanel.classList.remove('open');
  view.selectionPanel.classList.remove('minimized');
  view.selectionPanel.style.removeProperty('--selection-minimized-top');
  view.selectionPanel.style.removeProperty('--selection-minimized-right');
  renderSequenceControls();
  renderLayers(view, state, render);
  updateBoardDetails(view, board);
  view.arCalibrationButton.disabled = !camera.active || !cameraTracker.ready;
  view.arCalibrationButton.title = 'Calibration';
  setStatus(view, `Loaded ${name || board.name || 'board'}`);
  viewport.fit();
  render();
}

function clearSelection() {
  showSelection(view, state, null);
  refreshConnectivity();
}

function selectAt(x, y) {
  // Copper is hit-tested first: a visible trace or zone should win over a
  // nearby component origin, especially at high zoom.
  const netName = renderer.nearestNet(x, y);
  if (netName) {
    selectNet(netName);
    return true;
  }
  const component = renderer.nearestComponent(x, y);
  if (component) showSelection(view, state, component);
  else {
    clearSelection();
    refreshConnectivity();
    return false;
  }
  refreshConnectivity();
  return true;
}

let arTapPointerId = null;
let arTapStart = null;
let arTapMoved = false;
const arPointers = new Map();
let arPinchStartDistance = 0;
let arPinchBaseTransform = null;
let arPinchStartMidpoint = null;
let arPinching = false;
const AR_TAP_MOVEMENT_THRESHOLD = 9;

function arOverlaySelectionEnabled() {
  return camera.active
    && ['tracked', 'suspect'].includes(view.arOverlayCanvas.dataset.trackingState)
    && Boolean(projectedSourceCanvas)
    && Boolean(fourCornerCalibration.homography);
}

function arOverlayInteractionEnabled() {
  return camera.active
    && Boolean(projectedSourceCanvas)
    && Boolean(fourCornerCalibration.homography);
}

function resetArTapGesture() {
  for (const pointerId of arPointers.keys()) {
    if (view.arOverlayCanvas.hasPointerCapture?.(pointerId)) {
      try { view.arOverlayCanvas.releasePointerCapture(pointerId); } catch { /* capture may already be gone */ }
    }
  }
  arPointers.clear();
  arTapPointerId = null;
  arTapStart = null;
  arTapMoved = false;
  arPinchStartDistance = 0;
  arPinchBaseTransform = null;
  arPinchStartMidpoint = null;
  arPinching = false;
}

function selectFromArOverlay(event) {
  if (!arOverlaySelectionEnabled()) return false;
  const rect = view.boardWrap.getBoundingClientRect();
  if (!rect.width || !rect.height) return false;
  const unzoomedPoint = invertPresentationPoint({
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  }, arPresentationZoom);
  const boardPoint = unprojectPoint(fourCornerCalibration.homography, unzoomedPoint);
  if (!boardPoint) return false;
  const screenPoint = viewport.screen(boardPoint);
  if (!Number.isFinite(screenPoint.x) || !Number.isFinite(screenPoint.y)) return false;
  return selectAt(screenPoint.x, screenPoint.y);
}

async function openBoardFile(file) {
  if (!file) return;
  try {
    setStatus(view, `Reading ${file.name}...`);
    const { board, name } = await loadBoardFile(file);
    loadBoard(board, name);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(view, `Load failed: ${message}`);
    window.alert(`Could not load board file:\n\n${message}`);
  }
}

function closeControlWindow() {
  view.controlWindow.hidden = true;
  view.controlBackdrop.hidden = true;
  for (const panel of view.controlPanels) panel.hidden = true;
}

function openControlPanel(name, title) {
  const panelIds = {
    samples: 'panelSamples',
    view: 'panelView',
    layers: 'panelLayers',
  };
  const panel = document.getElementById(panelIds[name]);
  if (!panel) return;
  view.boardMenu.hidden = true;
  view.boardMenuButton.setAttribute('aria-expanded', 'false');
  view.boardMenuButton.setAttribute('aria-label', 'Open board controls');
  view.controlBackdrop.hidden = false;
  view.controlWindowTitle.textContent = title;
  view.controlWindow.hidden = false;
  for (const candidate of view.controlPanels) candidate.hidden = candidate !== panel;
}

function setBoardMenuOpen(open) {
  view.boardMenu.hidden = !open;
  view.boardMenuButton.setAttribute('aria-expanded', String(open));
  view.boardMenuButton.setAttribute('aria-label', open ? 'Close board controls' : 'Open board controls');
  if (!open) closeControlWindow();
}

function sampleAssetUrl(path) {
  const baseUrl = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  // The build-time manifest URL-encodes every public-file path segment.
  return `${baseUrl}${path}`;
}

function renderSampleOptions() {
  view.sampleOptions.replaceChildren();
  for (const sample of sampleFiles) {
    const option = document.createElement('button');
    option.type = 'button';
    option.dataset.sampleId = sample.id;
    option.textContent = sample.name;
    view.sampleOptions.append(option);
  }
  if (!sampleFiles.length) {
    const empty = document.createElement('p');
    empty.className = 'control-copy';
    empty.textContent = 'No sample reference files were found.';
    view.sampleOptions.append(empty);
  }
}

async function loadSampleBoard(sample) {
  const name = sample.referencePath.split('/').at(-1);
  try {
    setStatus(view, `Reading ${name}...`);
    const response = await fetch(sampleAssetUrl(sample.referencePath));
    if (!response.ok) throw new Error(`Sample board could not be loaded (${response.status}).`);
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || 'application/zip' });
    const { board, name: boardName } = await loadBoardFile(file);
    loadBoard(board, sample.name || boardName, { sampleId: sample.id });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(view, `Load failed: ${message}`);
    window.alert(`Could not load sample board:\n\n${message}`);
  } finally {
    setBoardMenuOpen(false);
  }
}

function netLayers(net, board) {
  const layers = new Set();
  if (net?.layer) layers.add(String(net.layer));
  for (const layer of Array.isArray(net?.layers) ? net.layers : []) {
    if (layer) layers.add(String(layer));
  }
  const features = [
    ...(Array.isArray(net?.traces) ? net.traces : []),
    ...(Array.isArray(net?.segments) ? net.segments : []),
    ...(Array.isArray(net?.contours) ? net.contours : []),
  ];
  for (const feature of features) {
    if (feature?.layer) layers.add(String(feature.layer));
  }

  const netName = String(net?.name || '');
  for (const component of board?.components || []) {
    for (const pad of component.pads || []) {
      if (String(pad?.net || '') !== netName) continue;
      if (pad.layer) layers.add(String(pad.layer));
      else if (component.layer) layers.add(String(component.layer));
    }
  }

  const connections = board?.netPads?.[netName] || net?.pads || net?.connections || [];
  for (const connection of Array.isArray(connections) ? connections : []) {
    const reference = String(connection?.element || connection?.refDes || connection?.refdes || '');
    const padName = String(connection?.pad || connection?.name || connection?.number || '');
    const component = (board?.components || []).find((candidate) => refOf(candidate) === reference);
    const pad = component?.pads?.find((candidate) => String(candidate?.name || candidate?.number || '') === padName);
    if (pad?.layer) layers.add(String(pad.layer));
    else if (component?.layer) layers.add(String(component.layer));
  }

  return [...layers].filter(Boolean).sort((first, second) => first.localeCompare(second, undefined, { numeric: true })).join(', ') || '—';
}

function searchEntries() {
  const board = state.data;
  if (!board) return [];

  const components = (board.components || []).map((component) => {
    const name = refOf(component) || String(component.part || component.package || 'Unnamed component');
    const detail = String(component.part || component.value || component.package || '').trim();
    return {
      type: 'Component',
      name,
      layer: layerOf(component) || '—',
      detail,
      value: component,
      searchText: [name, detail, component.package, component.layer, component.side].filter(Boolean).join(' '),
    };
  });

  const netMap = new Map((board.nets || []).map((net) => [String(net.name || ''), net]));
  for (const name of Object.keys(board.netPads || {})) {
    if (!netMap.has(name)) netMap.set(name, { name });
  }
  const nets = [...netMap.values()]
    .filter((net) => String(net.name || ''))
    .map((net) => {
      const name = String(net.name);
      const layer = netLayers(net, board);
      return {
        type: 'Net',
        name,
        layer,
        detail: '',
        value: name,
        searchText: [name, layer, 'net'].join(' '),
      };
    });

  return [...components, ...nets];
}

function appendSearchText(parent, className, textValue) {
  const element = document.createElement('span');
  element.className = className;
  element.textContent = textValue;
  parent.append(element);
  return element;
}

function renderSearchResults(query = '') {
  const entries = searchEntries();
  const term = query.trim().toLowerCase();
  const matches = entries
    .filter((entry) => !term || entry.searchText.toLowerCase().includes(term))
    .sort((first, second) => {
      if (!term) return first.type.localeCompare(second.type) || first.name.localeCompare(second.name);
      const firstName = first.name.toLowerCase();
      const secondName = second.name.toLowerCase();
      return Number(!firstName.startsWith(term)) - Number(!secondName.startsWith(term))
        || first.type.localeCompare(second.type)
        || first.name.localeCompare(second.name);
    })
    .slice(0, 40);

  view.searchResults.replaceChildren();
  if (!entries.length) {
    appendSearchText(view.searchResults, 'search-empty', 'Load a sample board to search.');
    return;
  }
  if (!matches.length) {
    appendSearchText(view.searchResults, 'search-empty', `No matches for “${query}”.`);
    return;
  }

  for (const entry of matches) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'search-result';
    item.setAttribute('role', 'option');
    appendSearchText(item, 'search-result-type', entry.type);
    const name = document.createElement('strong');
    name.textContent = entry.name;
    item.append(name);
    const meta = entry.type === 'Net'
      ? `Layer: ${entry.layer}`
      : `Layer: ${entry.layer}${entry.detail ? ` · ${entry.detail}` : ''}`;
    appendSearchText(item, 'search-result-meta', meta);
    item.addEventListener('click', () => selectSearchEntry(entry));
    view.searchResults.append(item);
  }
}

function closeSearchWindow() {
  view.searchWindow.hidden = true;
  view.searchBackdrop.hidden = true;
  view.searchButton.setAttribute('aria-expanded', 'false');
}

function openSearchWindow() {
  closeControlWindow();
  setBoardMenuOpen(false);
  view.searchWindow.hidden = false;
  view.searchBackdrop.hidden = false;
  view.searchButton.setAttribute('aria-expanded', 'true');
  view.searchInput.value = '';
  renderSearchResults();
  requestAnimationFrame(() => view.searchInput.focus());
}

function selectSearchEntry(entry) {
  closeSearchWindow();
  focusBoardEntry(entry);
}

function focusBoardEntry(entry) {
  if (entry.type === 'Component') {
    showSelection(view, state, entry.value);
    refreshConnectivity();
  } else {
    selectNet(entry.value);
    return;
  }
  render();
}

function sequenceDescriptor(entry) {
  const descriptor = {
    type: entry.type,
    name: entry.name,
    layer: entry.layer || '',
    status: entry.status || 'pending',
  };
  if (entry.pin) descriptor.pin = entry.pin;
  if (entry.pinNet) descriptor.pinNet = entry.pinNet;
  return descriptor;
}

function sequencePinLabel(item) {
  if (!item?.pin) return '';
  return `Pin ${item.pin}${item.pinNet ? ` (${item.pinNet})` : ''}`;
}

function sequenceEntriesForBoard() {
  const entries = searchEntries();
  return state.sequence.items
    .map((item, sequenceIndex) => {
      const entry = entries.find((candidate) => sequenceItemKey(candidate) === sequenceItemKey(item));
      return entry ? {
        ...entry,
        pin: item.pin || '',
        pinNet: item.pinNet || '',
        sequenceItem: item,
        sequenceIndex,
      } : null;
    })
    .filter(Boolean);
}

function editSequenceStepPin(index) {
  const entry = sequenceEntriesForBoard().find((candidate) => candidate.sequenceIndex === index);
  if (!entry) {
    view.sequenceEditorStatus.textContent = 'That component is unavailable on the current board.';
    return;
  }
  openSequencePreview(entry, index);
}

function createSequenceIconButton(label, pathData, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `sequence-icon-button${className ? ` ${className}` : ''}`;
  button.setAttribute('aria-label', label);
  button.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'menu-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', pathData);
  svg.append(path);
  button.append(svg);
  return button;
}

function renderSequenceItems() {
  const items = state.sequence.items;
  view.sequenceItems.replaceChildren();
  view.sequenceCount.textContent = `${items.length} step${items.length === 1 ? '' : 's'}`;
  view.sequenceTabCount.textContent = String(items.length);
  view.sequenceEmpty.hidden = items.length > 0;

  items.forEach((sequenceItem, index) => {
    const row = document.createElement('li');
    row.className = `sequence-item sequence-item-${sequenceItem.status || 'pending'}`;

    const number = document.createElement('span');
    number.className = 'sequence-item-number';
    number.textContent = String(index + 1).padStart(2, '0');

    const content = document.createElement('div');
    content.className = 'sequence-item-content';
    const name = document.createElement('strong');
    name.textContent = sequenceItem.name;
    const meta = document.createElement('span');
    meta.className = 'sequence-item-meta';
    const pinLabel = sequencePinLabel(sequenceItem);
    meta.textContent = `${sequenceItem.type} · Layer: ${sequenceItem.layer || '—'}`;
    if (pinLabel) meta.textContent = `${sequenceItem.type} · Layer: ${sequenceItem.layer || '—'} · ${pinLabel}`;
    content.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'sequence-item-actions';
    if (sequenceItem.type === 'Component') {
      const editPin = createSequenceIconButton('Edit probe pin', 'M4 16.5V20h3.5L18.4 9.1l-3.5-3.5L4 16.5Zm13.8-9.2 1.1-1.1a1.5 1.5 0 0 0 0-2.1l-.8-.8a1.5 1.5 0 0 0-2.1 0l-1.1 1.1 3.5 3.5Z');
      editPin.addEventListener('click', () => editSequenceStepPin(index));
      actions.append(editPin);
    }
    const moveUp = createSequenceIconButton('Move step up', 'm6 15 6-6 6 6');
    moveUp.disabled = index === 0;
    moveUp.addEventListener('click', () => moveSequenceItem(index, -1));
    const moveDown = createSequenceIconButton('Move step down', 'm6 9 6 6 6-6');
    moveDown.disabled = index === items.length - 1;
    moveDown.addEventListener('click', () => moveSequenceItem(index, 1));
    const remove = createSequenceIconButton('Remove step', 'M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13M10 11v5M14 11v5', 'sequence-delete');
    remove.addEventListener('click', () => removeSequenceItem(index));
    actions.append(moveUp, moveDown, remove);
    row.append(number, content, actions);
    view.sequenceItems.append(row);
  });
}

function renderSequenceSearchResults(query = '') {
  const entries = searchEntries();
  const term = query.trim().toLowerCase();
  const matches = entries
    .filter((entry) => !term || entry.searchText.toLowerCase().includes(term))
    .sort((first, second) => {
      if (!term) return first.type.localeCompare(second.type) || first.name.localeCompare(second.name);
      return Number(!first.name.toLowerCase().startsWith(term))
        - Number(!second.name.toLowerCase().startsWith(term))
        || first.type.localeCompare(second.type)
        || first.name.localeCompare(second.name);
    })
    .slice(0, 40);

  view.sequenceSearchResults.replaceChildren();
  if (!entries.length) {
    appendSearchText(view.sequenceSearchResults, 'search-empty', 'Load a sample board before building a sequence.');
    return;
  }
  if (!matches.length) {
    appendSearchText(view.sequenceSearchResults, 'search-empty', `No matches for “${query}”.`);
    return;
  }

  for (const entry of matches) {
    const item = document.createElement('div');
    item.className = 'search-result sequence-search-result';
    item.setAttribute('role', 'option');
    const isAdded = false;
    const details = document.createElement('div');
    details.className = 'sequence-result-details';
    item.disabled = isAdded;
    appendSearchText(item, 'search-result-type', entry.type);
    const name = document.createElement('strong');
    name.textContent = entry.name;
    details.append(name);
    const meta = entry.type === 'Net'
      ? `Layer: ${entry.layer}`
      : `Layer: ${entry.layer}${entry.detail ? ` · ${entry.detail}` : ''}`;
    appendSearchText(details, 'search-result-meta', meta);
    const preview = document.createElement('button');
    preview.type = 'button';
    preview.className = 'sequence-preview-button';
    preview.textContent = 'Preview';
    preview.setAttribute('aria-label', `Preview ${entry.name} on board`);
    preview.addEventListener('click', () => openSequencePreview(entry));
    const add = document.createElement('button');
    add.type = 'button';
    add.className = 'sequence-add-button';
    add.textContent = isAdded ? 'Added' : 'Add';
    if (entry.type === 'Component') add.textContent = 'Choose pin';
    add.disabled = isAdded;
    if (!isAdded) add.addEventListener('click', () => {
      if (entry.type === 'Component') openSequencePreview(entry);
      else addSequenceEntry(entry);
    });
    item.append(details, preview, add);
    view.sequenceSearchResults.append(item);
  }
}

function renderSequenceEditor() {
  view.sequenceName.value = state.sequence.name || 'Inspection sequence';
  renderSequenceSearchResults(view.sequenceSearchInput.value);
  renderSequenceItems();
}

function updateSequenceName() {
  state.sequence.name = view.sequenceName.value.trim() || 'Inspection sequence';
}

function addSequenceEntry(entry) {
  state.sequence.items.push(sequenceDescriptor(entry));
  state.sequence.boardName = state.data?.name || state.sequence.boardName || '';
  renderSequenceEditor();
  view.sequenceEditorStatus.textContent = `Added ${entry.type.toLowerCase()} “${entry.name}”.`;
}

function setSequenceTab(tab) {
  activeSequenceTab = tab;
  const compact = window.matchMedia('(max-width: 900px)').matches;
  for (const button of view.sequenceTabs) {
    const selected = button.dataset.sequenceTab === tab;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  }
  for (const panel of view.sequencePanels) {
    const selected = panel.dataset.sequencePanel === tab;
    panel.classList.toggle('is-active', selected);
    panel.hidden = compact && !selected;
  }
}

function openSequencePreview(entry, editIndex = null) {
  previewSequenceEntry = entry;
  previewSequenceEditIndex = editIndex;
  focusBoardEntry(entry);
  view.sequenceWindow.hidden = true;
  view.sequencePreviewType.textContent = `${entry.type} preview`;
  view.sequencePreviewName.textContent = entry.name;
  view.sequencePreviewMeta.textContent = entry.type === 'Net'
    ? `Layer: ${entry.layer || '—'}`
    : `Layer: ${entry.layer || '—'}${entry.detail ? ` · ${entry.detail}` : ''}`;
  view.sequencePreviewPinField.hidden = entry.type !== 'Component';
  view.sequencePreviewPin.replaceChildren();
  if (entry.type === 'Component') {
    const wholeComponent = document.createElement('option');
    wholeComponent.value = '';
    wholeComponent.textContent = 'Whole component (no pin target)';
    view.sequencePreviewPin.append(wholeComponent);
    const pads = [...(entry.value?.pads || [])]
      .map((pad) => ({
        name: String(pad.name || pad.number || pad.pin || pad.label || '').trim(),
        net: String(pad.net || '').trim(),
      }))
      .filter((pad) => pad.name)
      .sort((firstPad, secondPad) => firstPad.name.localeCompare(secondPad.name, undefined, { numeric: true }));
    for (const pad of pads) {
      const option = document.createElement('option');
      option.value = pad.name;
      option.dataset.net = pad.net;
      option.textContent = pad.net ? `${pad.name} - ${pad.net}` : pad.name;
      view.sequencePreviewPin.append(option);
    }
    view.sequencePreviewPin.value = entry.pin || '';
  }
  view.sequencePreviewAdd.disabled = false;
  view.sequencePreviewAdd.textContent = editIndex == null ? 'Add step' : 'Update step';
  view.sequencePreview.hidden = false;
}

function closeSequencePreview(returnToEditor = true) {
  view.sequencePreview.hidden = true;
  previewSequenceEntry = null;
  previewSequenceEditIndex = null;
  if (returnToEditor) openSequenceEditor();
}

function removeSequenceItem(index) {
  const [removed] = state.sequence.items.splice(index, 1);
  renderSequenceEditor();
  if (removed) view.sequenceEditorStatus.textContent = `Removed ${removed.name} from the sequence.`;
}

function moveSequenceItem(index, direction) {
  const target = index + direction;
  if (target < 0 || target >= state.sequence.items.length) return;
  const items = state.sequence.items;
  [items[index], items[target]] = [items[target], items[index]];
  renderSequenceEditor();
}

function closeSequenceEditor() {
  updateSequenceName();
  view.sequenceWindow.hidden = true;
  view.sequenceBackdrop.hidden = true;
  renderSequenceControls();
}

function openSequenceEditor() {
  closeSearchWindow();
  closeControlWindow();
  setBoardMenuOpen(false);
  activeSequenceEntries = [];
  state.sequence.active = false;
  state.sequence.index = -1;
  state.sequence.activePin = '';
  view.sequencePreview.hidden = true;
  view.sequenceWindow.hidden = false;
  // Sequence editing is a canvas mode, not a blocking modal: keep the board visible.
  view.sequenceBackdrop.hidden = true;
  view.sequenceSearchInput.value = '';
  setSequenceTab(activeSequenceTab);
  view.sequenceEditorStatus.textContent = state.data
    ? 'Click an element to add it to the sequence.'
    : 'Load a sample board before building a sequence.';
  renderSequenceEditor();
  renderSequenceControls();
  requestAnimationFrame(() => view.sequenceSearchInput.focus());
}

function installSequence(sequence, message) {
  state.sequence = {
    ...sequence,
    boardName: sequence.boardName || state.data?.name || '',
    active: false,
    index: -1,
    activePin: '',
  };
  sequenceResumeIndex = 0;
  activeSequenceEntries = [];
  view.sequenceName.value = state.sequence.name;
  renderSequenceEditor();
  closeSequenceEditor();
  setStatus(view, message);
}

function sampleSequenceUrl() {
  const sample = sampleFiles.find((candidate) => candidate.id === loadedSampleId);
  return sample?.sequencePath ? sampleAssetUrl(sample.sequencePath) : '';
}

async function loadSampleSequence() {
  if (!state.data) {
    view.sequenceEditorStatus.textContent = 'Load a board before loading its sequence.';
    return;
  }
  const url = sampleSequenceUrl();
  if (!url) {
    view.sequenceEditorStatus.textContent = 'No bundled sequence is available for this board. You can create one or upload a JSON file.';
    return;
  }
  try {
    view.sequenceEditorStatus.textContent = 'Loading the board sequence...';
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load the bundled sequence (${response.status}).`);
    const sequence = normalizeInspectionSequence(await response.json());
    if (!sequence.items.length) throw new Error('The bundled sequence contains no valid steps.');
    installSequence(sequence, `Loaded ${sequence.name} with ${sequence.items.length} step${sequence.items.length === 1 ? '' : 's'}.`);
    startSequenceViewer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    view.sequenceEditorStatus.textContent = `Sequence load failed: ${message}`;
  }
}

function saveSequenceToFile() {
  updateSequenceName();
  const payload = serializeInspectionSequence(state.sequence, state.data?.name || '');
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  const baseName = state.sequence.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'inspection-sequence';
  anchor.href = url;
  anchor.download = `${baseName}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  closeSequenceEditor();
  setStatus(view, `Saved ${state.sequence.name}.`);
}

async function openSequenceFile(file) {
  if (!file) return;
  try {
    const sequence = normalizeInspectionSequence(JSON.parse(await file.text()));
    if (!sequence.items.length) throw new Error('The sequence file contains no valid component or net steps.');
    installSequence(sequence, `Loaded ${sequence.name}.`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    view.sequenceEditorStatus.textContent = `Load failed: ${message}`;
    window.alert(`Could not load inspection sequence:\n\n${message}`);
  } finally {
    view.sequenceFileInput.value = '';
  }
}

function renderSequenceControls() {
  const hasItems = state.sequence.items.length > 0;
  // Keep the launch point visible between the burger and search controls even
  // before a sequence exists; it opens the editor until steps are available.
  view.sequenceLoadButton.hidden = state.sequence.active;
  view.sequenceNav.hidden = !state.sequence.active;
  view.sequenceArTransparencyControl.hidden = !state.sequence.active || !camera.active;
  const sequenceLabel = state.sequence.name || 'inspection sequence';
  view.sequenceLoadButton.title = hasItems ? `Load ${sequenceLabel}` : 'Create or load a sequence first';
  view.sequenceLoadButton.setAttribute('aria-label', hasItems ? `Load ${sequenceLabel}` : 'Create or load a sequence first');
  const count = activeSequenceEntries.length;
  view.sequenceProgress.textContent = state.sequence.active ? `${state.sequence.index + 1} / ${count}` : '0 / 0';
  view.sequencePrevious.disabled = !state.sequence.active || state.sequence.index <= 0;
  view.sequenceNext.disabled = !state.sequence.active || state.sequence.index >= count - 1;
  const entry = state.sequence.active ? activeSequenceEntries[state.sequence.index] : null;
  const item = entry?.sequenceItem;
  view.sequenceStepType.textContent = entry?.type || 'Inspection';
  view.sequenceStepName.textContent = entry?.name || '—';
  view.sequenceStepMeta.textContent = entry ? `Layer: ${entry.layer || '—'} · ${item?.status || 'pending'}` : '—';
  const pinLabel = sequencePinLabel(item);
  if (entry && pinLabel) view.sequenceStepMeta.textContent = `Layer: ${entry.layer || '—'} · ${pinLabel} · ${item?.status || 'pending'}`;
  view.sequencePass.classList.toggle('is-active', item?.status === 'passed');
  view.sequenceFlag.classList.toggle('is-active', item?.status === 'flagged');
}

function applySequenceEntry(index) {
  const entry = activeSequenceEntries[index];
  if (!entry) return;
  state.sequence.index = index;
  if (entry.type === 'Component') {
    state.sequence.activePin = entry.pin || '';
    showSelection(view, state, entry.value);
  } else {
    state.sequence.activePin = '';
    selectNet(entry.value);
    renderSequenceControls();
    return;
  }
  refreshConnectivity();
  renderSequenceControls();
  render();
}

function startSequenceViewer() {
  if (!state.data) {
    setStatus(view, 'Load a sample board before starting an inspection sequence.');
    return;
  }
  activeSequenceEntries = sequenceEntriesForBoard();
  if (!activeSequenceEntries.length) {
    setStatus(view, 'No sequence steps match the current board.');
    openSequenceEditor();
    return;
  }
  state.sequence.active = true;
  const resumeIndex = Math.max(0, Math.min(activeSequenceEntries.length - 1, Number.isInteger(sequenceResumeIndex) ? sequenceResumeIndex : 0));
  state.sequence.index = resumeIndex;
  applySequenceEntry(resumeIndex);
  const missing = state.sequence.items.length - activeSequenceEntries.length;
  setStatus(view, missing ? `Inspection sequence started (${missing} step${missing === 1 ? '' : 's'} unavailable on this board).` : `Inspection sequence started: ${state.sequence.name}.`);
}

function closeSequenceViewer() {
  if (state.sequence.active && Number.isInteger(state.sequence.index) && state.sequence.index >= 0) {
    sequenceResumeIndex = state.sequence.index;
  }
  state.sequence.active = false;
  state.sequence.index = -1;
  state.sequence.activePin = '';
  activeSequenceEntries = [];
  refreshConnectivity();
  renderSequenceControls();
  render();
  setStatus(view, 'Inspection sequence closed.');
}

function moveSequenceViewer(direction) {
  if (!state.sequence.active) return;
  const nextIndex = state.sequence.index + direction;
  if (nextIndex < 0 || nextIndex >= activeSequenceEntries.length) return;
  applySequenceEntry(nextIndex);
}

function setActiveStepStatus(status) {
  const entry = activeSequenceEntries[state.sequence.index];
  if (!entry) return;
  const item = entry.sequenceItem;
  if (!item) return;
  item.status = item.status === status ? 'pending' : status;
  renderSequenceControls();
  setStatus(view, `${entry.name}: ${item.status}.`);
}

function handleSequenceButton() {
  if (state.sequence.items.length) startSequenceViewer();
  else openSequenceEditor();
}

function setStatusPopupOpen(open) {
  view.statusPopup.hidden = !open;
  view.status.setAttribute('aria-expanded', String(open));
}

view.status.addEventListener('click', () => setStatusPopupOpen(view.statusPopup.hidden));
document.addEventListener('pointerdown', (event) => {
  if (!view.statusPopup.hidden && !event.target.closest('#status, #statusPopup')) setStatusPopupOpen(false);
});
view.boardMenuButton.addEventListener('click', () => {
  setArMenuOpen(false);
  if (!view.controlWindow.hidden) {
    closeControlWindow();
    return;
  }
  setBoardMenuOpen(view.boardMenu.hidden);
});
view.searchButton.addEventListener('click', openSearchWindow);
view.arMenuButton.addEventListener('click', () => {
  if (!view.boardMenu.hidden) setBoardMenuOpen(false);
  setArMenuOpen(!arMenuOpen);
});
view.devSettingsButton.addEventListener('click', () => {
  const open = view.devSettingsWindow.hidden;
  view.devSettingsWindow.hidden = !open;
  view.devSettingsButton.setAttribute('aria-expanded', String(open));
});
view.devTrackingMethod.addEventListener('change', () => {
  try {
    localStorage.setItem(TRACKING_PROFILE_KEY, view.devTrackingMethod.value);
    setStatus(view, 'Tracking performance profile saved. Restart AR mode to apply it.');
  } catch {
    setStatus(view, 'This browser did not allow the tracking preference to be saved.');
  }
});
view.devShowTrackingFeatures.addEventListener('change', () => {
  updateTrackingDebugEnabled(view.devShowTrackingFeatures.checked);
  try {
    localStorage.setItem(TRACKING_DEBUG_KEY, String(trackingDebugEnabled));
    setStatus(view, trackingDebugEnabled
      ? 'Tracking feature points are visible. Cyan is detected, amber matched, magenta optical flow, and green pose inliers.'
      : 'Tracking feature points are hidden. Diagnostic metrics will continue to be collected locally.');
  } catch {
    setStatus(view, 'Feature visibility changed, but this browser did not allow the preference to be saved.');
  }
});
view.devIsolateSequence.addEventListener('change', () => {
  isolateSequenceInAr = view.devIsolateSequence.checked;
  try {
    localStorage.setItem(SEQUENCE_AR_ISOLATION_KEY, String(isolateSequenceInAr));
  } catch {
    setStatus(view, 'Sequence isolation changed, but this browser did not allow the preference to be saved.');
  }
  render();
  setStatus(view, isolateSequenceInAr
    ? 'Active sequence step isolation enabled for AR.'
    : 'Active sequence step isolation disabled for AR.');
});
view.devDownloadTrackingLog.addEventListener('click', downloadTrackingDiagnostics);
view.devClearTrackingLog.addEventListener('click', () => {
  trackingDiagnosticLog.clear();
  if (TRACKING_LOG_UI_ENABLED) view.devDownloadTrackingLog.disabled = true;
  setStatus(view, 'Local tracking diagnostic log cleared.');
});
view.arCameraButton.addEventListener('click', toggleCameraMode);
view.arTransparencyButton.addEventListener('click', () => {
  const open = view.arTransparencyControl.hidden;
  view.arTransparencyControl.hidden = !open;
  view.arTransparencyButton.setAttribute('aria-expanded', String(open));
});
view.arTransparencyRange.addEventListener('input', (event) => updateArTransparency(event.target.value));
view.sequenceArTransparencyRange.addEventListener('input', (event) => updateArTransparency(event.target.value));
view.arCalibrationButton.addEventListener('click', beginFourCornerCalibration);
view.arCalibrationDetectEdgeButton.addEventListener('click', detectCalibrationEdge);
view.arCalibrationOverlay.addEventListener('pointerdown', startCalibrationHandleDrag);
view.arCalibrationOverlay.addEventListener('pointermove', moveCalibrationHandle);
view.arCalibrationOverlay.addEventListener('pointerup', stopCalibrationHandleDrag);
view.arCalibrationOverlay.addEventListener('pointercancel', stopCalibrationHandleDrag);
view.arCalibrationOverlay.addEventListener('lostpointercapture', (event) => endCalibrationHandleDrag(event));
view.arCalibrationApplyButton.addEventListener('click', applyFourCornerCalibration);
view.arCalibrationPreviewButton.addEventListener('click', () => {
  if (!fourCornerCalibration.active) return;
  calibrationPreviewEnabled = !calibrationPreviewEnabled;
  updateCalibrationPreviewButton();
  if (calibrationPreviewEnabled) renderCalibrationPreview();
  else projectedOverlay.clear();
});
view.arCalibrationCancelButton.addEventListener('click', () => {
  cancelFourCornerCalibration();
  setStatus(view, 'Calibration cancelled.');
});
view.searchClose.addEventListener('click', closeSearchWindow);
view.searchBackdrop.addEventListener('click', closeSearchWindow);
view.searchInput.addEventListener('input', () => renderSearchResults(view.searchInput.value));
view.searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') view.searchResults.querySelector('.search-result')?.click();
});
view.sequenceLoadButton.addEventListener('click', handleSequenceButton);
view.sequencePrevious.addEventListener('click', () => moveSequenceViewer(-1));
view.sequenceNext.addEventListener('click', () => moveSequenceViewer(1));
view.sequencePass.addEventListener('click', () => setActiveStepStatus('passed'));
view.sequenceFlag.addEventListener('click', () => setActiveStepStatus('flagged'));
view.sequenceFit.addEventListener('click', fitBoard);
view.sequenceExit.addEventListener('click', closeSequenceViewer);
view.sequenceBackdrop.addEventListener('click', closeSequenceEditor);
view.sequenceWindow.addEventListener('click', (event) => {
  if (event.target === view.sequenceWindow) closeSequenceEditor();
});
view.sequenceDoneButton.addEventListener('click', closeSequenceEditor);
view.sequenceSampleButton.addEventListener('click', loadSampleSequence);
view.sequenceSaveButton.addEventListener('click', saveSequenceToFile);
view.sequenceUploadButton.addEventListener('click', () => view.sequenceFileInput.click());
view.sequenceSearchInput.addEventListener('input', () => renderSequenceSearchResults(view.sequenceSearchInput.value));
view.sequenceSearchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') view.sequenceSearchResults.querySelector('.sequence-preview-button')?.click();
});
view.sequenceName.addEventListener('change', updateSequenceName);
for (const tab of view.sequenceTabs) tab.addEventListener('click', (event) => {
  event.preventDefault();
  setSequenceTab(tab.dataset.sequenceTab);
});
view.sequencePreviewBack.addEventListener('click', () => closeSequencePreview());
view.sequencePreviewAdd.addEventListener('click', () => {
  if (!previewSequenceEntry) return;
  let editorMessage = '';
  const selectedPin = view.sequencePreviewPin.selectedOptions[0];
  const updatedEntry = {
    ...previewSequenceEntry,
    pin: selectedPin?.value || '',
    pinNet: selectedPin?.dataset.net || '',
  };
  if (previewSequenceEditIndex != null) {
    const item = state.sequence.items[previewSequenceEditIndex];
    if (item) {
      if (updatedEntry.pin) item.pin = updatedEntry.pin;
      else delete item.pin;
      if (updatedEntry.pinNet) item.pinNet = updatedEntry.pinNet;
      else delete item.pinNet;
      renderSequenceEditor();
      editorMessage = `Updated probe pin for ${item.name}.`;
    }
  } else {
    addSequenceEntry(updatedEntry);
  }
  activeSequenceTab = 'sequence';
  closeSequencePreview();
  if (editorMessage) view.sequenceEditorStatus.textContent = editorMessage;
});
view.sequenceFileInput.addEventListener('change', (event) => openSequenceFile(event.target.files[0]));
for (const item of view.menuItems) {
  item.addEventListener('click', () => {
    if (item.dataset.action === 'upload') {
      setBoardMenuOpen(false);
      view.fileInput.click();
      return;
    }
    if (item.dataset.action === 'theme') {
      // The theme controller is already bound directly to this button.
      return;
    }
    if (item.dataset.action === 'inspection-sequence') {
      openSequenceEditor();
      return;
    }
    openControlPanel(item.dataset.panel, item.dataset.title || 'Controls');
  });
}
view.controlWindowClose.addEventListener('click', closeControlWindow);
view.controlBackdrop.addEventListener('click', closeControlWindow);
renderSampleOptions();
view.sampleOptions.addEventListener('click', (event) => {
  const option = event.target.closest('button[data-sample-id]');
  const sample = sampleFiles.find((candidate) => candidate.id === option?.dataset.sampleId);
  if (sample) loadSampleBoard(sample);
});
view.fileInput.addEventListener('change', (event) => {
  openBoardFile(event.target.files[0]);
  event.target.value = '';
});

for (const [key, control] of Object.entries(view.viewControls)) {
  control.addEventListener('change', () => {
    state.view[key] = control.checked;
    render();
  });
}

for (const preset of view.presets) {
  preset.addEventListener('click', () => {
    setLayerPreset(view, state, preset.dataset.preset);
    render();
  });
}

function minimizeSelectionPanel() {
  const closeRect = view.selectionClose.getBoundingClientRect();
  const size = 42;
  const centerX = closeRect.left + closeRect.width / 2;
  const centerY = closeRect.top + closeRect.height / 2;
  view.selectionPanel.style.setProperty('--selection-minimized-top', `${centerY - size / 2}px`);
  view.selectionPanel.style.setProperty('--selection-minimized-right', `${window.innerWidth - centerX - size / 2}px`);
  view.selectionPanel.classList.add('minimized');
}
view.selectionClose.addEventListener('click', minimizeSelectionPanel);
view.selectionRestore.addEventListener('click', () => {
  view.selectionPanel.classList.remove('minimized');
  view.selectionPanel.style.removeProperty('--selection-minimized-top');
  view.selectionPanel.style.removeProperty('--selection-minimized-right');
});

const activePointers = new Map();
let pinchDistance = 0;
let gestureStart = null;
let gestureMoved = false;
const TAP_MOVEMENT_THRESHOLD = 7;
let emptyTapCount = 0;
let lastEmptyTap = null;
const TRIPLE_TAP_DELAY = 600;
const TRIPLE_TAP_DISTANCE = 32;

function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerMidpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

view.arOverlayCanvas.addEventListener('pointerdown', (event) => {
  if (!arOverlayInteractionEnabled()) return;
  arPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (arPointers.size === 1) {
    arTapPointerId = event.pointerId;
    arTapStart = { x: event.clientX, y: event.clientY };
    arTapMoved = false;
  } else {
    arTapMoved = true;
    arPinching = true;
    if (arPointers.size === 2) {
      const [first, second] = [...arPointers.values()];
      arPinchStartDistance = pointerDistance(first, second);
      arPinchBaseTransform = { ...arPresentationZoom };
      arPinchStartMidpoint = pointerMidpoint(first, second);
    }
  }
  try { view.arOverlayCanvas.setPointerCapture(event.pointerId); } catch { /* capture can fail for synthetic events */ }
  event.preventDefault();
});

view.arOverlayCanvas.addEventListener('pointermove', (event) => {
  if (!arPointers.has(event.pointerId)) return;
  arPointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (arPointers.size >= 2) {
    const [first, second] = [...arPointers.values()];
    const nextDistance = pointerDistance(first, second);
    if (arPinchBaseTransform && arPinchStartMidpoint && arPinchStartDistance > 0 && nextDistance > 0) {
      const rect = view.boardWrap.getBoundingClientRect();
      arPresentationZoom = getPinchPresentationTransform({
        baseScale: arPinchBaseTransform.scale,
        baseTx: arPinchBaseTransform.tx,
        baseTy: arPinchBaseTransform.ty,
        startDistance: arPinchStartDistance,
        currentDistance: nextDistance,
        startMidpoint: arPinchStartMidpoint,
        currentMidpoint: pointerMidpoint(first, second),
        width: rect.width,
        height: rect.height,
      });
      applyArPresentationZoom();
    }
    arPinching = true;
    arTapMoved = true;
    event.preventDefault();
    return;
  }
  if (event.pointerId === arTapPointerId && arTapStart && Math.hypot(event.clientX - arTapStart.x, event.clientY - arTapStart.y) > AR_TAP_MOVEMENT_THRESHOLD) arTapMoved = true;
});

view.arOverlayCanvas.addEventListener('pointerup', (event) => {
  if (!arPointers.has(event.pointerId)) return;
  const wasPinching = arPinching;
  arPointers.delete(event.pointerId);
  if (view.arOverlayCanvas.hasPointerCapture?.(event.pointerId)) {
    try { view.arOverlayCanvas.releasePointerCapture(event.pointerId); } catch { /* capture can already be gone */ }
  }
  if (arPointers.size) {
    event.preventDefault();
    return;
  }
  const shouldSelect = !wasPinching && event.pointerId === arTapPointerId && !arTapMoved;
  if (shouldSelect) selectFromArOverlay(event);
  resetArTapGesture();
  if (shouldSelect) render();
  event.preventDefault();
});

view.arOverlayCanvas.addEventListener('pointercancel', (event) => {
  if (!arPointers.has(event.pointerId)) return;
  arPointers.delete(event.pointerId);
  if (!arPointers.size) resetArTapGesture();
  event.preventDefault();
});

view.arOverlayCanvas.addEventListener('lostpointercapture', (event) => {
  if (!arPointers.has(event.pointerId)) return;
  arPointers.delete(event.pointerId);
  if (!arPointers.size) resetArTapGesture();
});

function preventSafariArGesture(event) {
  if (camera.active) event.preventDefault();
}
view.arOverlayCanvas.addEventListener('gesturestart', preventSafariArGesture, { passive: false });
view.arOverlayCanvas.addEventListener('gesturechange', preventSafariArGesture, { passive: false });

view.canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const rect = view.canvas.getBoundingClientRect();
  viewport.zoom(event.deltaY < 0 ? 1.15 : 0.87, event.clientX - rect.left, event.clientY - rect.top);
  render();
}, { passive: false });

view.canvas.addEventListener('pointerdown', (event) => {
  if (!view.boardMenu.hidden) setBoardMenuOpen(false);
  const current = { x: event.offsetX, y: event.offsetY };
  activePointers.set(event.pointerId, current);
  if (activePointers.size === 1) {
    gestureStart = current;
    gestureMoved = false;
  }
  view.canvas.setPointerCapture(event.pointerId);
  if (activePointers.size >= 2) {
    gestureMoved = true;
    viewport.setDragging(false);
    const [first, second] = [...activePointers.values()];
    pinchDistance = pointerDistance(first, second);
    return;
  }
  viewport.setDragging(true, current.x, current.y);
});

view.canvas.addEventListener('pointermove', (event) => {
  if (activePointers.has(event.pointerId)) {
    activePointers.set(event.pointerId, { x: event.offsetX, y: event.offsetY });
  }
  if (activePointers.size >= 2) {
    const [first, second] = [...activePointers.values()];
    const nextDistance = pointerDistance(first, second);
    if (pinchDistance > 0 && nextDistance > 0) {
      const midpoint = pointerMidpoint(first, second);
      viewport.zoom(nextDistance / pinchDistance, midpoint.x, midpoint.y);
      render();
    }
    pinchDistance = nextDistance;
    return;
  }

  const worldPoint = viewport.world(event.offsetX, event.offsetY);
  setCoordinates(view, worldPoint.x, worldPoint.y);
  if (gestureStart && Math.hypot(event.offsetX - gestureStart.x, event.offsetY - gestureStart.y) > TAP_MOVEMENT_THRESHOLD) {
    gestureMoved = true;
  }
  if (!state.viewport.dragging) return;
  viewport.pan(event.offsetX - state.viewport.lastX, event.offsetY - state.viewport.lastY);
  viewport.setDragging(true, event.offsetX, event.offsetY);
  render();
});

function finishPointer(event) {
  const wasDragging = state.viewport.dragging;
  const wasGestureMoved = gestureMoved;
  activePointers.delete(event.pointerId);
  if (activePointers.size < 2) pinchDistance = 0;
  viewport.setDragging(false);
  if (activePointers.size) return;
  gestureStart = null;
  gestureMoved = false;
  if (!wasDragging || wasGestureMoved) return;
  const selected = selectAt(event.offsetX, event.offsetY);
  if (selected) {
    emptyTapCount = 0;
    lastEmptyTap = null;
  } else {
    const now = performance.now();
    const closeToPrevious = lastEmptyTap
      && now - lastEmptyTap.time <= TRIPLE_TAP_DELAY
      && Math.hypot(event.offsetX - lastEmptyTap.x, event.offsetY - lastEmptyTap.y) <= TRIPLE_TAP_DISTANCE;
    emptyTapCount = closeToPrevious ? emptyTapCount + 1 : 1;
    lastEmptyTap = { x: event.offsetX, y: event.offsetY, time: now };
    if (emptyTapCount >= 3) {
      emptyTapCount = 0;
      lastEmptyTap = null;
      fitBoard();
      setStatus(view, 'Fit board.');
      return;
    }
  }
  render();
}

view.canvas.addEventListener('pointerup', finishPointer);
view.canvas.addEventListener('pointercancel', (event) => {
  activePointers.delete(event.pointerId);
  if (activePointers.size < 2) pinchDistance = 0;
  if (!activePointers.size) {
    gestureStart = null;
    gestureMoved = false;
  }
  viewport.setDragging(false);
});

window.addEventListener('resize', () => {
  resetArPresentationZoom();
  endCalibrationHandleDrag(null);
  hideCalibrationLoupe();
  if (calibrationDetecting) invalidateCalibrationRequest({ resetTracker: true });
  const previousSize = viewport.screenSize();
  const calibrationPoints = fourCornerCalibration.active ? fourCornerCalibration.points : null;
  const previousVideoSize = calibrationVideoSize;
  viewport.resize();
  if (calibrationPoints?.length === 4 && state.data) {
    const nextSize = viewport.screenSize();
    const currentVideoSize = {
      width: view.arCameraVideo.videoWidth || 1,
      height: view.arCameraVideo.videoHeight || 1,
    };
    const intrinsicChanged = previousVideoSize
      && (currentVideoSize.width !== previousVideoSize.width || currentVideoSize.height !== previousVideoSize.height);
    if (intrinsicChanged) {
      cancelFourCornerCalibration();
      invalidateCalibrationRequest({ resetTracker: true });
      setCalibrationActive(false);
      setStatus(view, 'Camera orientation changed. Start calibration again for the new view.');
    } else {
      const videoSize = previousVideoSize || currentVideoSize;
      const convertPoint = (point) => videoPointToDisplay(
        displayPointToVideo(point, videoSize, { width: previousSize.w, height: previousSize.h }),
        currentVideoSize,
        { width: nextSize.w, height: nextSize.h },
      );
      const nextPoints = calibrationPoints.map(convertPoint);
      const nextInitialPoints = calibrationInitialPoints.map(convertPoint);
      fourCornerCalibration.begin(physicalCalibrationBounds || state.data.bounds, nextPoints);
      calibrationInitialPoints = nextInitialPoints;
      calibrationSearchPoints = expandCalibrationQuad(calibrationInitialPoints, 0.1);
      calibrationVideoSize = currentVideoSize;
      renderFourCornerCalibration();
    }
  }
  trackingTarget = null;
  trackedCornerSmoother.reset();
  clearTrackingDebugOverlay({ discardDiagnostic: true });
  if (camera.active && projectedSourceCanvas) setOverlayTrackingState('recovering');
  if (!view.sequenceWindow.hidden) setSequenceTab(activeSequenceTab);
  fitStatusText(view);
  render();
});

window.addEventListener('blur', () => endCalibrationHandleDrag(null));

function isTextEntryTarget(target) {
  return target instanceof HTMLElement
    && (target.matches('input, textarea, select') || target.isContentEditable);
}

window.addEventListener('keydown', (event) => {
  if (isTextEntryTarget(event.target)) return;
  if (event.key === 'Escape') {
    if (!view.sequencePreview.hidden) closeSequencePreview();
    else if (!view.sequenceWindow.hidden) closeSequenceEditor();
    else if (!view.searchWindow.hidden) closeSearchWindow();
    else if (!view.controlWindow.hidden) closeControlWindow();
    else if (state.sequence.active) closeSequenceViewer();
    else if (!view.boardMenu.hidden) setBoardMenuOpen(false);
    else if (state.selected || state.selectedNet) {
      clearSelection();
      render();
    }
    return;
  }
  if (state.sequence.active && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    event.preventDefault();
    moveSequenceViewer(event.key === 'ArrowLeft' ? -1 : 1);
    return;
  }
  if (event.key.toLowerCase() === 'f') fitBoard();
  if (event.key === '+') {
    viewport.zoom(1.2);
    render();
  }
  if (event.key === '-') {
    viewport.zoom(0.83);
    render();
  }
});

window.addEventListener('pagehide', () => camera.stop());

viewport.resize();
fitStatusText(view);
updateArTransparency(50);
renderSequenceControls();
render();
