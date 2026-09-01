# AR-DUINO PCB viewer

This project is a browser-based PCB viewer for POGI JSON, EAGLE XML/ZIP, and ODB++ ZIP files. The application is now organized as a Vite-powered Node project instead of one self-contained HTML file.

## Development

```bash
npm install
npm run dev
```

The production bundle is generated with `npm run build`. `npm run check` validates module syntax and `npm test` runs the model/parser tests.

Node 22.12 or newer is recommended (the repository includes `.node-version`).

## Mobile AR tracking

AR tracking is markerless and runs completely on the phone. Four-corner calibration rectifies the live board into a canonical reference, builds a 15-view synthetic angle/roll atlas, and uses OpenCV 4.13 AKAZE feature matching for global recovery. Pyramidal Lucas–Kanade optical flow supplies the faster frames between descriptor anchors. Trusted real camera angles are learned as a small, bounded set of on-device recovery views. Every pose must pass RANSAC inlier, board coverage, reprojection-error, convexity, bounds, and temporal checks before it is presented.

See [How AR-DUINO tracks a PCB on mobile](docs/ar-tracking-architecture.md) for the full tracking pipeline, mobile compatibility, debugging guide, known limits, and Cloudflare Pages deployment model.

The vision engine is a custom 3.4 MB single-threaded WebAssembly build in `public/vendor/opencv`. It is loaded inside a classic worker, allows only one frame in flight, and performs no server-side image processing. The overlay is presented at display refresh rate with a coherent pose filter and an exact WebGL homography; Canvas2D remains the rendering fallback. Suspect poses fade and lost poses are hidden instead of leaving a frozen overlay that looks live.

For best results:

1. Use diffuse lighting and avoid glare across the solder mask.
2. Fill a useful portion of the camera view with the board and wait for focus.
3. Place the four handles in top-left, top-right, bottom-right, bottom-left order.
4. Calibrate while the complete physical board is visible.

No markerless system can recover detail that is nearly edge-on, fully occluded, blurred, or visually repetitive. The angle atlas materially improves recovery through large perspective changes, but production acceptance still requires replay and live-device validation using the actual boards, lighting, and maximum intended angle.

Developer settings include **Show tracked feature points**. Cyan dots are detected features, amber rings are descriptor matches, magenta crosses survived forward/backward optical flow, and green rings are the inliers used for the accepted board pose. The panel also shows live counts and rejection metrics. **Download log** exports a bounded JSON session containing those metrics, camera settings, and rejection reasons; it never includes camera frames or board-file contents.

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
src/ar/camera-tracker.js   Camera-frame scheduling and worker bridge
src/ar/camera-tracker.worker.js  AKAZE atlas, LK flow, and pose validation
src/ar/projected-overlay.js      WebGL homography renderer with 2D fallback
test/board.test.js         Regression tests for normalization and ODB++ parsing
```

`pcb_json_viewer.html` is retained as the original single-file reference. The maintained application entry point is `index.html`.

The interface uses LibreFlow Annotate's Clay & Coral palette through `src/theme.css`: warm neutral surfaces, coral actions, stone borders, muted text, and a matching canvas work surface.

When connectivity highlighting is enabled, clicking a component highlights its incident nets and the components attached to them. Clicking a rendered net trace or copper contour selects that net and highlights its connected components and neighboring nets.

The View panel also includes a Copper artwork toggle. Turning it off hides raw conductor-layer graphics and filled copper pours while preserving net traces and connectivity data, so net/component selection remains available.

Board controls are opened from the hamburger button in the canvas corner. The demo loads the provided Arduino samples, along with View and Layers & presets panels. Desktop zoom uses the mouse wheel; touch devices support pinch zoom and drag pan. The upload workflow remains in code but is currently disabled for the sample-only demo.
