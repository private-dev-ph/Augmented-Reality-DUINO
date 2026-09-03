# Development and setup guide

This guide gets a contributor from a fresh clone to a verified local build. AR-DUINO is a static Vite application; it does not need a database, API key, server process, or locally installed OpenCV package.

## 1. Confirm the prerequisites

Install the following before starting:

| Requirement | Why it is needed | Check |
| --- | --- | --- |
| Node.js `22.12.0` or newer | Matches the repository’s pinned runtime and runs Vite, checks, and tests. | `node --version` |
| npm | Installs the locked Vite dependency and runs package scripts. | `npm --version` |
| A current Chromium-, Safari-, or Firefox-based browser | Runs the flat viewer. | Open a local Vite URL. |
| A phone with a rear camera (optional) | Needed for realistic AR validation. | Camera permission must be available over HTTPS. |
| `cloudflared` (optional) | Creates a temporary HTTPS address for phone testing. | `cloudflared --version` |

The repository includes [`.node-version`](../.node-version). If you use a Node version manager, select that version before installing packages. The project does not need a global Vite installation.

## 2. Install dependencies

From the repository root, install exactly what the lockfile describes:

```powershell
npm.cmd install
```

This creates `node_modules/`, which is a local generated directory and should not be committed. The browser-side OpenCV JavaScript and WebAssembly runtime are already versioned under `public/vendor/opencv/`; there is no post-install model or WASM download.

## 3. Start the desktop development server

```powershell
npm.cmd run dev
```

Vite prints a local address, normally `http://localhost:5173`. Open it in the same machine’s browser. Choose **Arduino samples** from the board controls, then load the UNO or MEGA example to confirm that the viewer renders.

The generic board-file upload logic exists in the codebase, but the current showcase interface intentionally disables it. Treat the bundled samples as the supported manual-demo path unless the product scope changes.

### Add a bundled sample

The sample menu is generated at Vite startup/build time from files under `public/`; no JavaScript menu or sequence mapping needs updating. Add a board reference as `<board-name>-reference.zip` and, when available, its inspection sequence as `<board-name>-sequence.json`. The shared `<board-name>` pairs the files case-insensitively, including in subfolders.

Hyphens in `<board-name>` become spaces in the menu, and the app adds the `Arduino` prefix. For example, `MEGA-2560-Rev3e-reference.zip` appears as **Arduino MEGA 2560 Rev3e** and pairs with `MEGA-2560-Rev3e-sequence.json`. Restart `npm.cmd run dev` after adding files, or run `npm.cmd run build`; Cloudflare Pages discovers them during its normal build.

## 4. Understand the commands before changing code

| Command | Purpose | When to run it |
| --- | --- | --- |
| `npm.cmd run dev` | Starts Vite with hot reload. | During normal UI or source work. |
| `npm.cmd run check` | Parses the maintained JavaScript modules with Node. | Before committing a source change. |
| `npm.cmd test` | Runs Node regression tests in `test/*.test.js`. | Before committing behavior changes. |
| `npm.cmd run build` | Produces a deployable static bundle in `dist/`. | Before a Pages preview/production deployment. |
| `npm.cmd run preview` | Serves the production bundle locally through Vite. | To inspect a build on this computer. |
| `npm.cmd run preview:mobile` | Serves the build at `127.0.0.1:4173`. | Before opening a built artifact through a Quick Tunnel. |

Use the project scripts rather than invoking Vite directly. They record the intended commands and make the local and deployment workflows repeatable.

## 5. Verify a change

For a typical source or documentation change, run:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
```

Then open the built output with `npm.cmd run preview` or `npm.cmd run preview:mobile`. For a visual change, load both bundled samples and check the relevant surface: flat board viewer, sequence workspace, or AR controls.

For tracking changes, automated tests are necessary but insufficient. Also use the mobile protocol below and exercise calibration, recovery after a brief occlusion, loss behavior, and re-calibration with the real board under representative lighting.

## 6. Test camera mode from a phone

Camera permission on a phone requires a secure origin. A phone opening `http://<computer-ip>:5173` cannot use AR mode even if the rest of the interface works.

Choose one of these paths:

1. **Fast source iteration** — run the Vite development server and a Quick Tunnel. Hot reload remains available. Follow [Local HTTPS camera testing](local-https-camera-testing.md).
2. **Release-like testing** — build first, serve `dist` with `preview:mobile`, then tunnel port `4173`. This catches asset and build issues before deployment. Follow [Cloudflare Pages development](cloudflare-pages-dev.md#test-the-production-artifact-on-a-phone).
3. **Hosted verification** — use a Cloudflare Pages preview deployment. It provides the production-style HTTPS origin and headers.

When the tunnel or preview opens on the phone, grant the site camera permission, choose a bundled board, open AR controls, and calibrate against the physical matching board. Good first conditions are diffuse light, a stable board, a focused rear camera, and the full board outline in frame.

## 7. Work safely around the AR runtime

The custom OpenCV pair is intentionally versioned as matching files:

```text
public/vendor/opencv/opencv-4.13.0-arduino-r2.js
public/vendor/opencv/opencv-4.13.0-arduino-r2.wasm
```

If that runtime is regenerated, update and deploy the JavaScript and WASM files together, then increment the `arduino-r2` filename revision wherever the runtime is referenced. A partial deployment can make the worker fail to load or pair a JavaScript glue file with the wrong binary. Keep the cache policy in [`public/_headers`](../public/_headers) aligned with that versioning approach.

The worker accepts one frame at a time by design. Do not “improve” perceived throughput by queueing unbounded frames; that causes stale poses and raises mobile memory pressure.

## 8. Know where a change belongs

| Area | Primary location |
| --- | --- |
| Browser event wiring and application composition | `src/main.js` |
| Shared board, selection, and sequence state | `src/state.js`, `src/model/` |
| File detection and board parsing | `src/parsers/` |
| Flat board rendering and interaction | `src/render/` |
| DOM updates, panels, and themes | `src/ui/`, `src/styles.css`, `src/theme.css` |
| Camera lifecycle and calibration | `src/ar/camera.js`, `src/ar/four-corner-calibration.js` |
| Worker-side tracking and pose acceptance | `src/ar/camera-tracker.worker.js` |
| Projected AR artwork | `src/ar/projected-overlay.js` |

The AR overlay uses the same viewer state and renderer output as the flat viewer. A change to selection, layer visibility, connectivity, or sequence scope may therefore affect both presentation modes.

## 9. Common setup problems

| Symptom | Likely cause | Action |
| --- | --- | --- |
| `npm` or `node` is not recognized | Node/npm is missing or not on PATH. | Install the required Node version and restart the terminal. |
| AR opens but camera permission fails on a phone | The origin is HTTP or the site permission was denied. | Use a Quick Tunnel or Pages URL, grant Camera permission, then reload. |
| Vision engine times out | The JS/WASM asset is missing, cached inconsistently, or the device lacks required browser APIs. | Build again, inspect `public/vendor/opencv/`, test a Pages preview, and check browser compatibility. |
| Tracking is unstable | Glare, blur, repetitive features, too little board in frame, or poor calibration. | Use diffuse light, refocus, keep the whole outline visible, and recalibrate carefully. |
| Overlay remains absent after movement | The tracker is recovering or lost rather than presenting a stale pose. | Bring the board back into view and wait; recalibrate if it cannot recover. |

For the deeper tracking rationale, quality gates, diagnostic meanings, and acceptance limits, read [AR tracking architecture](ar-tracking-architecture.md).
