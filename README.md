# AR-DUINO PCB viewer

This project is a browser-based PCB viewer for POGI JSON, EAGLE XML/ZIP, and ODB++ ZIP files. The application is now organized as a Vite-powered Node project instead of one self-contained HTML file.

## Development

```bash
npm install
npm run dev
```

The production bundle is generated with `npm run build`. `npm run check` validates module syntax and `npm test` runs the model/parser tests.

## Architecture

```text
index.html                 Application shell and semantic markup
src/main.js                Composition root and browser event wiring
src/state.js               Application state and board lifecycle
src/model/board.js         Board normalization, geometry helpers, and statistics
src/model/connectivity.js  Component/net graph resolution for selection highlighting
src/parsers/
  file-loader.js           File-type detection and loading workflow
  zip.js                   Browser-native ZIP reader
  eagle.js                 EAGLE board/schematic parser
  odb.js                   ODB++ parser
src/render/
  viewport.js              World/screen coordinates, zoom, pan, and fit
  board-renderer.js        Canvas drawing and component hit testing
src/ui/view.js             DOM updates for layers, warnings, and selection
src/styles.css             Application styles
test/board.test.js         Regression tests for normalization and ODB++ parsing
```

`pcb_json_viewer.html` is retained as the original single-file reference. The maintained application entry point is `index.html`.

The interface uses LibreFlow Annotate's Clay & Coral palette through `src/theme.css`: warm neutral surfaces, coral actions, stone borders, muted text, and a matching canvas work surface.

When connectivity highlighting is enabled, clicking a component highlights its incident nets and the components attached to them. Clicking a rendered net trace or copper contour selects that net and highlights its connected components and neighboring nets.

The View panel also includes a Copper artwork toggle. Turning it off hides raw conductor-layer graphics and filled copper pours while preserving net traces and connectivity data, so net/component selection remains available.

Board controls are opened from the hamburger button in the canvas corner. The demo loads the provided Arduino samples, along with View and Layers & presets panels. Desktop zoom uses the mouse wheel; touch devices support pinch zoom and drag pan. The upload workflow remains in code but is currently disabled for the sample-only demo.
