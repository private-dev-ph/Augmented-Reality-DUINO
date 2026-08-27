import { boardWarning, first, layerOf, num, positionOf, refOf } from '../model/board.js';

export function createView() {
  const byId = (id) => document.getElementById(id);
  return {
    canvas: byId('board'),
    boardMenuButton: byId('boardMenuBtn'),
    boardMenu: byId('boardMenu'),
    searchButton: byId('searchBtn'),
    searchBackdrop: byId('searchBackdrop'),
    searchWindow: byId('searchWindow'),
    searchClose: byId('searchClose'),
    searchInput: byId('searchInput'),
    searchResults: byId('searchResults'),
    sequenceLoadButton: byId('sequenceLoadBtn'),
    sequenceBackdrop: byId('sequenceBackdrop'),
    sequenceWindow: byId('sequenceWindow'),
    sequenceName: byId('sequenceName'),
    sequenceUploadButton: byId('sequenceUploadBtn'),
    sequenceSampleButton: byId('sequenceSampleBtn'),
    sequenceSaveButton: byId('sequenceSaveBtn'),
    sequenceDoneButton: byId('sequenceDoneBtn'),
    sequenceFileInput: byId('sequenceFileInput'),
    sequenceSearchInput: byId('sequenceSearchInput'),
    sequenceSearchResults: byId('sequenceSearchResults'),
    sequenceItems: byId('sequenceItems'),
    sequenceEmpty: byId('sequenceEmpty'),
    sequenceCount: byId('sequenceCount'),
    sequenceTabCount: byId('sequenceTabCount'),
    sequenceTabs: [...document.querySelectorAll('[data-sequence-tab]')],
    sequencePanels: [...document.querySelectorAll('[data-sequence-panel]')],
    sequenceEditorStatus: byId('sequenceEditorStatus'),
    sequencePreview: byId('sequencePreview'),
    sequencePreviewType: byId('sequencePreviewType'),
    sequencePreviewName: byId('sequencePreviewName'),
    sequencePreviewMeta: byId('sequencePreviewMeta'),
    sequencePreviewPinField: byId('sequencePreviewPinField'),
    sequencePreviewPin: byId('sequencePreviewPin'),
    sequencePreviewBack: byId('sequencePreviewBack'),
    sequencePreviewAdd: byId('sequencePreviewAdd'),
    sequenceNav: byId('sequenceNav'),
    sequencePrevious: byId('sequencePrevious'),
    sequenceProgress: byId('sequenceProgress'),
    sequenceNext: byId('sequenceNext'),
    sequencePass: byId('sequencePass'),
    sequenceFlag: byId('sequenceFlag'),
    sequenceFit: byId('sequenceFit'),
    sequenceExit: byId('sequenceExit'),
    sequenceStepType: byId('sequenceStepType'),
    sequenceStepName: byId('sequenceStepName'),
    sequenceStepMeta: byId('sequenceStepMeta'),
    menuItems: [...document.querySelectorAll('.canvas-menu-item button')],
    controlBackdrop: byId('controlBackdrop'),
    controlWindow: byId('controlWindow'),
    controlWindowTitle: byId('controlWindowTitle'),
    controlWindowClose: byId('controlWindowClose'),
    controlPanels: [...document.querySelectorAll('.control-panel')],
    fileInput: byId('fileInput'),
    sampleOptions: [...document.querySelectorAll('[data-sample]')],
    themeToggle: byId('themeToggle'),
    themeToggleLabel: byId('themeToggleLabel'),
    layers: byId('layers'),
    info: byId('info'),
    selectionPanel: byId('selectionPanel'),
    selectionClose: byId('selectionClose'),
    selectionRestore: byId('selectionRestore'),
    warning: byId('warning'),
    status: byId('status'),
    coords: byId('coords'),
    zoom: byId('zoom'),
    viewControls: {
      grid: byId('grid'),
      showComponents: byId('showComponents'),
      showFootprints: byId('showFootprints'),
      showLabels: byId('showLabels'),
      showNetLabels: byId('showNetLabels'),
      showPinoutNames: byId('showPinoutNames'),
      showInTraceNetNames: byId('showInTraceNetNames'),
      showOutline: byId('showOutline'),
      highlightConnectivity: byId('highlightConnectivity'),
      showCopper: byId('showCopper'),
    },
    presets: [...document.querySelectorAll('[data-preset]')],
  };
}

export function setStatus(view, message) {
  view.status.textContent = message;
}

export function setZoom(view, scale) {
  view.zoom.textContent = scale == null ? '—' : `${Math.round(scale * 100)}%`;
}

export function setCoordinates(view, x, y) {
  view.coords.textContent = `X ${x.toFixed(3)}  Y ${y.toFixed(3)}`;
}

export function renderLayers(view, state, onChange) {
  view.layers.replaceChildren();
  if (!state.data.layers.length) {
    const empty = document.createElement('span');
    empty.className = 'badge';
    empty.textContent = 'No layer definitions found.';
    view.layers.append(empty);
    return;
  }

  for (const layer of state.data.layers) {
    const row = document.createElement('label');
    row.className = 'layer';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = state.layers.get(layer.name) !== false;
    checkbox.addEventListener('change', () => {
      state.layers.set(layer.name, checkbox.checked);
      onChange();
    });
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = layer.color;
    const name = document.createElement('span');
    name.className = 'layer-name';
    name.textContent = layer.name;
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = String((state.data.layerFeatures[layer.name] || []).length);
    row.append(checkbox, swatch, name, badge);
    view.layers.append(row);
  }
}

export function setLayerPreset(view, state, preset) {
  for (const layer of state.data?.layers || []) {
    let visible = preset === 'all';
    if (preset === 'fab') visible = /Cu|Mask|Silk|Drill/.test(layer.name);
    if (preset === 'top') visible = /^F\./.test(layer.name);
    if (preset === 'bottom') visible = /^B\./.test(layer.name);
    state.layers.set(layer.name, visible);
    const row = [...view.layers.querySelectorAll('.layer')].find(
      (candidate) => candidate.querySelector('.layer-name')?.textContent === layer.name,
    );
    if (row) row.querySelector('input').checked = visible;
  }
}

export function updateBoardDetails(view, board) {
  const warning = boardWarning(board);
  view.warning.textContent = warning;
  view.warning.style.display = warning ? 'block' : 'none';
}

function resetSelectionPanelPosition(view) {
  view.selectionPanel.style.removeProperty('--selection-minimized-top');
  view.selectionPanel.style.removeProperty('--selection-minimized-right');
}

function createDetailsContent(children = []) {
  const content = document.createElement('div');
  content.className = 'details-content';
  const inner = document.createElement('div');
  inner.className = 'details-content-inner';
  inner.append(...children);
  content.append(inner);
  return { content, inner };
}

function prepareDetailsAnimation(details) {
  const syncOpenState = () => {
    details.classList.remove('is-expanded');
    if (!details.open) return;
    requestAnimationFrame(() => {
      if (details.open) details.classList.add('is-expanded');
    });
  };
  details.addEventListener('toggle', syncOpenState);
  if (details.open) syncOpenState();
  return details;
}

function appendPropertyCategory(container, title, rows, open = false) {
  const category = document.createElement('details');
  category.className = 'property-category';
  category.open = open;
  prepareDetailsAnimation(category);
  const summary = document.createElement('summary');
  summary.textContent = title;
  const details = document.createElement('dl');
  details.className = 'kv property-kv';
  for (const [label, value] of rows) {
    const term = document.createElement('dt');
    term.textContent = label;
    const description = document.createElement('dd');
    description.textContent = String(value ?? '—');
    details.append(term, description);
  }
  const content = createDetailsContent([details]);
  category.append(summary, content.content);
  container.append(category);
}

function propertyRows(source, fields) {
  return fields.map(([label, ...keys]) => [label, first(...keys.map((key) => source?.[key]), 'Not specified')]);
}

function appendPadProperties(container, pads) {
  const category = document.createElement('details');
  category.className = 'property-category';
  const summary = document.createElement('summary');
  const content = createDetailsContent();
  summary.textContent = `Pad properties · ${pads.length} pads`;
  category.append(summary);
  for (const [index, pad] of pads.entries()) {
    const padDetails = document.createElement('details');
    padDetails.className = 'pad-property-details';
    prepareDetailsAnimation(padDetails);
    const padSummary = document.createElement('summary');
    const name = first(pad.name, pad.number, pad.pin, `Pad ${index + 1}`);
    padSummary.textContent = `${name}${pad.net ? ` · ${pad.net}` : ''}`;
    const properties = document.createElement('dl');
    properties.className = 'kv property-kv';
    const rows = [
      ['Pad type', first(pad.type, pad.padType, 'Not specified')],
      ['Pad shape', first(pad.shape, 'Not specified')],
      ['Pad number', first(pad.name, pad.number, pad.pin, 'Not specified')],
      ['Pin name', first(pad.pinName, pad.label, pad.name, 'Not specified')],
      ['Pin type', first(pad.pinType, pad.electricalType, 'Not specified')],
      ['Net', first(pad.net, 'No net')],
      ['Position X', num(pad.x).toFixed(4)],
      ['Position Y', num(pad.y).toFixed(4)],
      ['Size X', first(pad.width, pad.size?.x, 'Not specified')],
      ['Size Y', first(pad.height, pad.size?.y, 'Not specified')],
      ['Drill / hole size', first(pad.drill, pad.holeSize, 'None')],
      ['Layer', first(pad.layer, 'Inherited from component')],
    ];
    for (const [label, value] of rows) {
      const term = document.createElement('dt');
      term.textContent = label;
      const description = document.createElement('dd');
      description.textContent = String(value);
      properties.append(term, description);
    }
    const padContent = createDetailsContent([properties]);
    padDetails.append(padSummary, padContent.content);
    content.inner.append(padDetails);
  }
  category.append(content.content);
  container.append(category);
}

function appendConnectedComponentList(container, components, netName, onSelectComponent) {
  const details = document.createElement('details');
  details.className = 'pinout-details net-components-details';
  details.open = true;
  prepareDetailsAnimation(details);
  const summary = document.createElement('summary');
  summary.textContent = `Connected components (${components.length})`;
  const list = document.createElement('div');
  list.className = 'net-components-list';

  if (!components.length) {
    const empty = document.createElement('p');
    empty.className = 'net-components-empty';
    empty.textContent = 'No component pads are associated with this net.';
    list.append(empty);
  }

  for (const component of components) {
    const reference = refOf(component) || '(unnamed component)';
    const pads = (component.pads || [])
      .filter((pad) => String(pad.net || '') === String(netName || ''))
      .map((pad) => String(first(pad.name, pad.number, pad.pin, pad.label, '')).trim())
      .filter(Boolean)
      .sort((firstPad, secondPad) => firstPad.localeCompare(secondPad, undefined, { numeric: true }));
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'net-component-row';
    row.setAttribute('aria-label', `Select ${reference}, connected through ${netName}`);
    const ref = document.createElement('strong');
    ref.textContent = reference;
    const meta = document.createElement('span');
    const packageName = String(first(component.package, component.packageRef, component.part, '')).trim();
    const pins = pads.length ? `Pins ${pads.join(', ')}` : 'Connected pad details unavailable';
    meta.textContent = packageName ? `${pins} - ${packageName}` : pins;
    const selectHint = document.createElement('span');
    selectHint.className = 'net-component-select-hint';
    selectHint.textContent = 'Inspect';
    row.append(ref, meta, selectHint);
    row.addEventListener('click', () => onSelectComponent?.(component));
    list.append(row);
  }

  const content = createDetailsContent([list]);
  details.append(summary, content.content);
  container.append(details);
}

export function showSelection(view, state, component) {
  state.selected = component;
  state.selectedNet = null;
  resetSelectionPanelPosition(view);
  view.selectionPanel.classList.remove('minimized');
  view.selectionPanel.classList.toggle('open', Boolean(component));
  if (!component) {
    view.info.textContent = 'Click a component to inspect it.';
    return;
  }

  const position = positionOf(component);
  view.info.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = refOf(component) || '(unnamed component)';
  const rows = [
    ['Type', 'Component'],
    ['Reference', refOf(component) || '—'],
    ['Package', first(component.package, component.packageRef, component.part, '—')],
    ['Layer', layerOf(component) || '—'],
    ['Position', `${position.x.toFixed(4)}, ${position.y.toFixed(4)}`],
    ['Rotation', `${num(component.rotation).toFixed(1)}°`],
    ['Geometry', component.outline?.length ? 'outline' : 'marker only'],
  ];
  view.info.append(title);
  appendPropertyCategory(view.info, 'Basic properties', rows, true);

  const pins = (component.pads || [])
    .map((pad) => ({
      name: String(first(pad.name, pad.number, pad.pin, pad.label, '')).trim(),
      net: String(pad.net || '').trim(),
    }))
    .filter((pad) => pad.name)
    .sort((firstPad, secondPad) => firstPad.name.localeCompare(secondPad.name, undefined, { numeric: true }));
  if (pins.length) {
    const pinout = document.createElement('details');
    pinout.className = 'pinout-details';
    pinout.open = pins.length <= 12;
    prepareDetailsAnimation(pinout);
    const summary = document.createElement('summary');
    summary.textContent = `Pinout · ${pins.length} pins`;
    const list = document.createElement('div');
    list.className = 'pinout-list';
    for (const pin of pins) {
      const row = document.createElement('div');
      const number = document.createElement('span');
      number.textContent = pin.name;
      const net = document.createElement('span');
      net.textContent = pin.net || 'No net';
      row.append(number, net);
      list.append(row);
    }
    const content = createDetailsContent([list]);
    pinout.append(summary, content.content);
    view.info.append(pinout);
  }
  const nets = [...new Set(pins.map((pin) => pin.net).filter(Boolean))];
  appendPropertyCategory(view.info, 'Connectivity', [
    ['Pads', component.pads?.length || 0],
    ['Connected nets', nets.length],
    ['Net names', nets.join(', ') || 'No assigned nets'],
  ]);
  appendPropertyCategory(view.info, 'Footprint & geometry', [
    ['Outline points', component.outline?.length || 0],
    ['Outline segments', component.outlineSegments?.length || 0],
    ['Silkscreen segments', component.silkscreenSegments?.length || 0],
    ['Courtyard segments', component.courtyardSegments?.length || 0],
    ['Mirror', component.mirror === true ? 'Yes' : 'No'],
  ]);
  appendPadProperties(view.info, component.pads || []);
  appendPropertyCategory(view.info, 'Post-matching properties', propertyRows(component.postMatching, [
    ['Top post-matching', 'top', 'topPostMatching'],
    ['Bottom post-matching', 'bottom', 'bottomPostMatching'],
  ]));
  appendPropertyCategory(view.info, 'Backdrill properties', propertyRows(component.backdrill, [
    ['Backdrill mode', 'mode', 'backdrillMode'],
  ]));
  appendPropertyCategory(view.info, 'Overrides', propertyRows(component.overrides, [
    ['Clearance override', 'clearance', 'clearanceOverride'],
    ['Solder mask margin', 'solderMaskMargin', 'maskMargin'],
    ['Solder paste margin', 'solderPasteMargin', 'pasteMargin'],
    ['Zone connection style', 'zoneConnection', 'zoneConnectionStyle'],
  ]));
  appendPropertyCategory(view.info, 'Teardrops', propertyRows(component.teardrops, [
    ['Enable teardrops', 'enabled', 'enable'],
    ['Best length ratio', 'bestLengthRatio'],
    ['Max length', 'maxLength'],
    ['Best width ratio', 'bestWidthRatio'],
    ['Max width', 'maxWidth'],
  ]));
}

export function showNetSelection(view, state, netName, onSelectComponent) {
  state.selected = null;
  state.selectedNet = netName;
  resetSelectionPanelPosition(view);
  view.selectionPanel.classList.remove('minimized');
  view.selectionPanel.classList.toggle('open', Boolean(netName));
  view.info.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = netName || '(unnamed net)';
  const rows = [
    ['Type', 'Net'],
    ['Name', netName || '—'],
    ['Connected components', state.connectivity.components.size],
    ['Connected nets', state.connectivity.nets.size],
  ];
  view.info.append(title);
  appendPropertyCategory(view.info, 'Basic properties', rows, true);
  const components = [...state.connectivity.components]
    .sort((firstComponent, secondComponent) => refOf(firstComponent).localeCompare(refOf(secondComponent), undefined, { numeric: true }));
  appendConnectedComponentList(view.info, components, netName, onSelectComponent);
  const net = (state.data?.nets || []).find((candidate) => String(candidate.name || '') === String(netName || '')) || { name: netName };
  const padConnections = state.data?.netPads?.[netName] || net.pads || net.connections || [];
  appendPropertyCategory(view.info, 'Connectivity', [
    ['Pad connections', Array.isArray(padConnections) ? padConnections.length : 0],
    ['Selected components', state.connectivity.components.size],
    ['Connected nets', state.connectivity.nets.size],
  ]);
  appendPropertyCategory(view.info, 'Routing properties', propertyRows(net, [
    ['Layer', 'layer'],
    ['Width', 'width'],
    ['Clearance', 'clearance'],
    ['Differential pair', 'differentialPair'],
  ]));
}
