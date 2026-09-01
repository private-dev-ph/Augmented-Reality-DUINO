import { refOf } from './board.js';

function normalizeName(value) {
  return String(value ?? '').trim();
}

function addConnection(netToComponents, componentToNets, component, netName) {
  const normalizedNet = normalizeName(netName);
  if (!normalizedNet) return;
  if (!componentToNets.has(component)) componentToNets.set(component, new Set());
  if (!netToComponents.has(normalizedNet)) netToComponents.set(normalizedNet, new Set());
  componentToNets.get(component).add(normalizedNet);
  netToComponents.get(normalizedNet).add(component);
}

function buildIndex(board) {
  const netToComponents = new Map();
  const componentToNets = new Map();
  const componentsByReference = new Map();

  for (const component of board.components || []) {
    const reference = normalizeName(refOf(component));
    if (reference) componentsByReference.set(reference, component);
    componentToNets.set(component, new Set());
  }

  const netNames = new Set([
    ...(board.nets || []).map((net) => normalizeName(net.name)),
    ...Object.keys(board.netPads || {}).map(normalizeName),
  ]);
  for (const netName of netNames) {
    if (!netName) continue;
    if (!netToComponents.has(netName)) netToComponents.set(netName, new Set());
    for (const pad of netPadsFor(board, netName)) {
      const component = componentsByReference.get(normalizeName(pad.element || pad.refDes || pad.refdes));
      if (component) addConnection(netToComponents, componentToNets, component, netName);
    }
  }

  for (const component of board.components || []) {
    for (const pad of component.pads || []) {
      addConnection(netToComponents, componentToNets, component, String(pad.net || ''));
    }
  }

  return { netToComponents, componentToNets };
}

function netPadsFor(board, netName) {
  const fromNet = Object.entries(board.netPads || {}).find(([key]) => normalizeName(key) === netName)?.[1];
  if (Array.isArray(fromNet)) return fromNet;
  const net = (board.nets || []).find((value) => normalizeName(value.name) === netName);
  return net?.pads || net?.connections || [];
}

function padMatchesPin(pad, pinName) {
  return [pad?.name, pad?.number, pad?.pin, pad?.label]
    .some((identifier) => normalizeName(identifier) === pinName);
}

function directComponents(netToComponents, netName) {
  return netToComponents.get(netName) || new Set();
}

export function resolveConnectivity(board, selection) {
  const result = { components: new Set(), nets: new Set() };
  if (!board || (!selection?.component && !selection?.net)) return result;

  const { netToComponents, componentToNets } = buildIndex(board);
  const selectedComponent = selection.component;
  const selectedNet = normalizeName(selection.net);
  const scopedPin = selection.pin !== undefined && selection.pin !== null;
  const scopedPinName = normalizeName(selection.pin);
  const pinNetFallback = normalizeName(selection.pinNet);

  if (selectedComponent) {
    result.components.add(selectedComponent);
    const scopedNet = scopedPin
      ? normalizeName((selectedComponent.pads || []).find((pad) => padMatchesPin(pad, scopedPinName))?.net) || pinNetFallback
      : '';
    const componentNets = scopedPin ? (scopedNet ? new Set([scopedNet]) : new Set()) : componentToNets.get(selectedComponent) || [];
    for (const netName of componentNets) {
      result.nets.add(netName);
      for (const component of directComponents(netToComponents, netName)) result.components.add(component);
    }
  }
  if (selectedNet) {
    result.nets.add(selectedNet);
    for (const component of directComponents(netToComponents, selectedNet)) {
      result.components.add(component);
      if (!selection.directOnly) {
        for (const netName of componentToNets.get(component) || []) result.nets.add(netName);
      }
    }
  }

  return result;
}
