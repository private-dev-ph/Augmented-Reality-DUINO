export function createAppState() {
  return {
    data: null,
    layers: new Map(),
    selected: null,
    selectedNet: null,
    connectivity: {
      components: new Set(),
      nets: new Set(),
    },
    sequence: {
      name: 'Inspection sequence',
      boardName: '',
      items: [],
      active: false,
      index: -1,
    },
    view: {
      grid: true,
      showComponents: true,
      showFootprints: true,
      showLabels: false,
      showNetLabels: false,
      showPinoutNames: true,
      showInTraceNetNames: true,
      showOutline: true,
      highlightConnectivity: true,
      showCopper: false,
    },
    viewport: {
      dpr: 1,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      center: { x: 0, y: 0 },
      dragging: false,
      lastX: 0,
      lastY: 0,
    },
  };
}

export function setBoard(state, board) {
  state.data = board;
  state.layers = new Map(board.layers.map((layer) => [layer.name, true]));
  state.selected = null;
  state.selectedNet = null;
  state.connectivity = { components: new Set(), nets: new Set() };
  state.sequence = {
    name: 'Inspection sequence',
    boardName: board.name || '',
    items: [],
    active: false,
    index: -1,
  };
}
