import { layerOf, normalizeBoard, refOf } from './model/board.js';
import { normalizeInspectionSequence, sequenceItemKey, serializeInspectionSequence } from './model/inspection-sequence.js';
import { resolveConnectivity } from './model/connectivity.js';
import { loadBoardFile } from './parsers/file-loader.js';
import { createBoardRenderer } from './render/board-renderer.js';
import { createViewport } from './render/viewport.js';
import { createAppState, setBoard } from './state.js';
import { createThemeController } from './ui/theme.js';
import {
  createView,
  renderLayers,
  setCoordinates,
  setLayerPreset,
  setStatus,
  setZoom,
  showNetSelection,
  showSelection,
  updateBoardDetails,
} from './ui/view.js';

const state = createAppState();
const view = createView();
const viewport = createViewport(view.canvas, state);
const renderer = createBoardRenderer({
  canvas: view.canvas,
  state,
  viewport,
  onScaleChange: (scale) => setZoom(view, scale),
});
let activeSequenceEntries = [];
let activeSequenceTab = 'find';
let previewSequenceEntry = null;

function render() {
  renderer.render();
}

createThemeController(view.themeToggle, render, view.themeToggleLabel);

function refreshConnectivity() {
  state.connectivity = resolveConnectivity(state.data, {
    component: state.selected,
    net: state.selectedNet,
  });
}

function fitBoard() {
  viewport.fit();
  render();
}

function loadBoard(rawBoard, name) {
  const board = normalizeBoard(rawBoard);
  setBoard(state, board);
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
    state.selected = null;
    state.selectedNet = netName;
    refreshConnectivity();
    showNetSelection(view, state, netName);
    render();
    return;
  }
  const component = renderer.nearestComponent(x, y);
  if (component) showSelection(view, state, component);
  else clearSelection();
  refreshConnectivity();
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

async function loadSampleBoard(path) {
  const name = path.split('/').pop();
  try {
    setStatus(view, `Reading ${name}...`);
    const response = await fetch(path);
    if (!response.ok) throw new Error(`Sample board could not be loaded (${response.status}).`);
    const blob = await response.blob();
    const file = new File([blob], name, { type: blob.type || 'application/zip' });
    const { board, name: boardName } = await loadBoardFile(file);
    loadBoard(board, boardName);
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
    state.selected = null;
    state.selectedNet = entry.value;
    refreshConnectivity();
    showNetSelection(view, state, entry.value);
  }
  render();
}

function sequenceDescriptor(entry) {
  return {
    type: entry.type,
    name: entry.name,
    layer: entry.layer || '',
    status: entry.status || 'pending',
  };
}

function sequenceEntriesForBoard() {
  const entries = searchEntries();
  return state.sequence.items
    .map((item) => entries.find((entry) => sequenceItemKey(entry) === sequenceItemKey(item)))
    .filter(Boolean);
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
    meta.textContent = `${sequenceItem.type} · Layer: ${sequenceItem.layer || '—'}`;
    content.append(name, meta);

    const actions = document.createElement('div');
    actions.className = 'sequence-item-actions';
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
  const added = new Set(state.sequence.items.map(sequenceItemKey));
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
    const isAdded = added.has(sequenceItemKey(entry));
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
    add.disabled = isAdded;
    if (!isAdded) add.addEventListener('click', () => addSequenceEntry(entry));
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
  if (state.sequence.items.some((item) => sequenceItemKey(item) === sequenceItemKey(entry))) return;
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

function openSequencePreview(entry) {
  previewSequenceEntry = entry;
  focusBoardEntry(entry);
  view.sequenceWindow.hidden = true;
  view.sequencePreviewType.textContent = `${entry.type} preview`;
  view.sequencePreviewName.textContent = entry.name;
  view.sequencePreviewMeta.textContent = entry.type === 'Net'
    ? `Layer: ${entry.layer || '—'}`
    : `Layer: ${entry.layer || '—'}${entry.detail ? ` · ${entry.detail}` : ''}`;
  const added = state.sequence.items.some((item) => sequenceItemKey(item) === sequenceItemKey(entry));
  view.sequencePreviewAdd.disabled = added;
  view.sequencePreviewAdd.textContent = added ? 'Already added' : 'Add step';
  view.sequencePreview.hidden = false;
}

function closeSequencePreview(returnToEditor = true) {
  view.sequencePreview.hidden = true;
  previewSequenceEntry = null;
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
  };
  activeSequenceEntries = [];
  view.sequenceName.value = state.sequence.name;
  renderSequenceEditor();
  closeSequenceEditor();
  setStatus(view, message);
}

function loadSampleSequence() {
  if (!state.data) {
    view.sequenceEditorStatus.textContent = 'Load a sample board before loading a starter sequence.';
    return;
  }

  const entries = searchEntries();
  const components = entries.filter((entry) => entry.type === 'Component');
  const nets = entries.filter((entry) => entry.type === 'Net');
  const chosen = [];
  const add = (entry) => {
    if (entry && !chosen.some((value) => sequenceItemKey(value) === sequenceItemKey(entry))) chosen.push(entry);
  };
  for (const entry of components.filter((value) => /^(U|IC|MCU|J)/i.test(value.name)).slice(0, 2)) add(entry);
  for (const entry of components.filter((value) => /^(R|C|D|Q)/i.test(value.name)).slice(0, 2)) add(entry);
  for (const entry of nets.filter((value) => /gnd|vcc|vin|\+5|3v3|reset/i.test(value.name)).slice(0, 2)) add(entry);
  for (const entry of [...components, ...nets]) {
    if (chosen.length >= 6) break;
    add(entry);
  }

  const boardName = state.data.name || 'Arduino board';
  const sequence = {
    version: 1,
    name: `${boardName} starter inspection`,
    boardName,
    items: chosen.map(sequenceDescriptor),
  };
  installSequence(sequence, `Loaded starter inspection sequence with ${sequence.items.length} step${sequence.items.length === 1 ? '' : 's'}.`);
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
  const sequenceLabel = state.sequence.name || 'inspection sequence';
  view.sequenceLoadButton.title = hasItems ? `Load ${sequenceLabel}` : 'Create or load a sequence first';
  view.sequenceLoadButton.setAttribute('aria-label', hasItems ? `Load ${sequenceLabel}` : 'Create or load a sequence first');
  const count = activeSequenceEntries.length;
  view.sequenceProgress.textContent = state.sequence.active ? `${state.sequence.index + 1} / ${count}` : '0 / 0';
  view.sequencePrevious.disabled = !state.sequence.active || state.sequence.index <= 0;
  view.sequenceNext.disabled = !state.sequence.active || state.sequence.index >= count - 1;
  const entry = state.sequence.active ? activeSequenceEntries[state.sequence.index] : null;
  const item = entry && state.sequence.items.find((candidate) => sequenceItemKey(candidate) === sequenceItemKey(entry));
  view.sequenceStepType.textContent = entry?.type || 'Inspection';
  view.sequenceStepName.textContent = entry?.name || '—';
  view.sequenceStepMeta.textContent = entry ? `Layer: ${entry.layer || '—'} · ${item?.status || 'pending'}` : '—';
  view.sequencePass.classList.toggle('is-active', item?.status === 'passed');
  view.sequenceFlag.classList.toggle('is-active', item?.status === 'flagged');
}

function applySequenceEntry(index) {
  const entry = activeSequenceEntries[index];
  if (!entry) return;
  state.sequence.index = index;
  if (entry.type === 'Component') {
    showSelection(view, state, entry.value);
  } else {
    state.selected = null;
    state.selectedNet = entry.value;
    showNetSelection(view, state, entry.value);
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
  state.sequence.index = 0;
  applySequenceEntry(0);
  const missing = state.sequence.items.length - activeSequenceEntries.length;
  setStatus(view, missing ? `Inspection sequence started (${missing} step${missing === 1 ? '' : 's'} unavailable on this board).` : `Inspection sequence started: ${state.sequence.name}.`);
}

function closeSequenceViewer() {
  state.sequence.active = false;
  state.sequence.index = -1;
  activeSequenceEntries = [];
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
  const item = state.sequence.items.find((candidate) => sequenceItemKey(candidate) === sequenceItemKey(entry));
  if (!item) return;
  item.status = item.status === status ? 'pending' : status;
  renderSequenceControls();
  setStatus(view, `${entry.name}: ${item.status}.`);
}

function handleSequenceButton() {
  if (state.sequence.items.length) startSequenceViewer();
  else openSequenceEditor();
}

view.boardMenuButton.addEventListener('click', () => {
  if (!view.controlWindow.hidden) {
    closeControlWindow();
    return;
  }
  setBoardMenuOpen(view.boardMenu.hidden);
});
view.searchButton.addEventListener('click', openSearchWindow);
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
  addSequenceEntry(previewSequenceEntry);
  activeSequenceTab = 'sequence';
  closeSequencePreview();
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
for (const option of view.sampleOptions) {
  option.addEventListener('click', () => loadSampleBoard(option.dataset.sample));
}
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

function pointerDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function pointerMidpoint(first, second) {
  return { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
}

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
  selectAt(event.offsetX, event.offsetY);
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
  viewport.resize();
  if (!view.sequenceWindow.hidden) setSequenceTab(activeSequenceTab);
  render();
});
window.addEventListener('keydown', (event) => {
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

viewport.resize();
renderSequenceControls();
render();
