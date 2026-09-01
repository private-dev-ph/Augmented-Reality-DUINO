export const TRACKING_DEBUG_KEY = 'ar-duino.debug-features';

function cloneJson(value) {
  if (value == null) return value;
  return JSON.parse(JSON.stringify(value, (_key, entry) => (
    typeof entry === 'number' && !Number.isFinite(entry) ? null : entry
  )));
}

export function stripDiagnosticPoints(diagnostic) {
  if (!diagnostic || typeof diagnostic !== 'object') return diagnostic;
  const { points: _points, ...metrics } = diagnostic;
  return cloneJson(metrics);
}

export function mapDiagnosticPoints(diagnostic, mapPoint) {
  if (!diagnostic || typeof diagnostic !== 'object') return diagnostic;
  const mappedGroups = {};
  for (const [name, points] of Object.entries(diagnostic.points || {})) {
    if (!Array.isArray(points)) continue;
    mappedGroups[name] = points
      .filter((point) => Number.isFinite(point?.x) && Number.isFinite(point?.y))
      .map((point) => mapPoint(point));
  }
  return { ...diagnostic, points: mappedGroups };
}

export function createTrackingDiagnosticLog({ limit = 3600, clock = () => Date.now() } = {}) {
  const maximumEntries = Math.max(1, Math.round(Number(limit) || 3600));
  let startedAt = clock();
  let entries = [];

  function record(kind, data = {}) {
    entries.push({
      elapsedMs: Math.max(0, clock() - startedAt),
      kind: String(kind || 'event'),
      data: stripDiagnosticPoints(data),
    });
    if (entries.length > maximumEntries) entries.splice(0, entries.length - maximumEntries);
  }

  function clear() {
    startedAt = clock();
    entries = [];
  }

  function snapshot(context = {}) {
    return {
      schema: 'ar-duino-tracking-diagnostics/v1',
      exportedAt: new Date(clock()).toISOString(),
      sessionStartedAt: new Date(startedAt).toISOString(),
      context: cloneJson(context),
      entries: cloneJson(entries),
    };
  }

  return {
    clear,
    record,
    snapshot,
    get size() { return entries.length; },
  };
}
