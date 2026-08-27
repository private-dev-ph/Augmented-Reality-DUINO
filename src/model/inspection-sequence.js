const SEQUENCE_VERSION = 1;

function sequenceType(value, item = {}) {
  const type = String(value || '').toLowerCase();
  if (type.includes('net')) return 'Net';
  if (type.includes('component') || type.includes('part') || type.includes('device')) return 'Component';
  if (item.refDes || item.refdes || item.reference) return 'Component';
  if (item.net) return 'Net';
  return '';
}

function normalizeItem(item) {
  if (typeof item === 'string') return { type: 'Component', name: item.trim(), layer: '' };
  if (!item || typeof item !== 'object') return null;
  const type = sequenceType(item.type || item.kind || item.elementType, item);
  const name = String(item.name || item.refDes || item.refdes || item.reference || item.net || '').trim();
  if (!type || !name) return null;
  const normalized = {
    type,
    name,
    layer: String(item.layer || '').trim(),
  };
  const status = String(item.status || '').toLowerCase();
  if (['passed', 'flagged', 'skipped'].includes(status)) normalized.status = status;
  return normalized;
}

export function sequenceItemKey(item) {
  return `${String(item?.type || '').toLowerCase()}:${String(item?.name || '').trim().toLowerCase()}`;
}

export function normalizeInspectionSequence(raw) {
  const source = raw?.sequence && typeof raw.sequence === 'object' ? raw.sequence : raw;
  const rawItems = Array.isArray(source?.items)
    ? source.items
    : Array.isArray(source)
      ? source
      : [];
  const items = rawItems.map(normalizeItem).filter(Boolean);
  return {
    version: SEQUENCE_VERSION,
    name: String(source?.name || 'Inspection sequence').trim() || 'Inspection sequence',
    boardName: String(source?.boardName || '').trim(),
    items,
  };
}

export function serializeInspectionSequence(sequence, boardName = '') {
  const normalized = normalizeInspectionSequence(sequence);
  return {
    version: SEQUENCE_VERSION,
    name: normalized.name,
    boardName: normalized.boardName || boardName || '',
    items: normalized.items,
  };
}
