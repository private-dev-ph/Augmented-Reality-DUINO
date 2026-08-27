import { refOf } from './board.js';

function addConnection(netToComponents, componentToNets, component, netName) {
  if (!netName) return;
  if (!componentToNets.has(component)) componentToNets.set(component, new Set());
  if (!netToComponents.has(netName)) netToComponents.set(netName, new Set());
  componentToNets.get(component).add(netName);
  netToComponents.get(netName).add(component);
}

function buildIndex(board) {
  const netToComponents = new Map();
  const componentToNets = new Map();
  const componentsByReference = new Map();

  for (const component of board.components || []) {
    const reference = refOf(component);
    if (reference) componentsByReference.set(reference, component);
    componentToNets.set(component, new Set());
  }

  const netNames = new Set([
    ...(board.nets || []).map((net) => String(net.name || '')),
    ...Object.keys(board.netPads || {}),
  ]);
  for (const netName of netNames) {
    if (!netName) continue;
    if (!netToComponents.has(netName)) netToComponents.set(netName, new Set());
    for (const pad of netPadsFor(board, netName)) {
      const component = componentsByReference.get(String(pad.element || pad.refDes || pad.refdes || ''));
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
  const fromNet = board.netPads?.[netName];
  if (Array.isArray(fromNet)) return fromNet;
  const net = (board.nets || []).find((value) => String(value.name || '') === netName);
  return net?.pads || net?.connections || [];
}

export function resolveConnectivity(board, selection) {
  const result = { components: new Set(), nets: new Set() };
  if (!board || (!selection?.component && !selection?.net)) return result;

  const { netToComponents, componentToNets } = buildIndex(board);
  const selectedComponent = selection.component;
  const selectedNet = selection.net ? String(selection.net) : '';

  if (selectedComponent) {
    result.components.add(selectedComponent);
    for (const netName of componentToNets.get(selectedComponent) || []) {
      result.nets.add(netName);
      for (const component of netToComponents.get(netName) || []) result.components.add(component);
    }
  }
  if (selectedNet) {
    result.nets.add(selectedNet);
    for (const component of netToComponents.get(selectedNet) || []) {
      result.components.add(component);
      for (const netName of componentToNets.get(component) || []) result.nets.add(netName);
    }
  }

  return result;
}
