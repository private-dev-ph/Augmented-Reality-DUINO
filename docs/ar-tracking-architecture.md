# How AR-DUINO tracks a PCB on mobile

Last reviewed: 1 September 2026

AR-DUINO uses markerless, planar tracking. The user identifies the four physical board corners once, and the app follows that board by recognizing and following visual details such as pads, holes, text, component edges, and copper patterns. The camera frames and all computer-vision work stay on the device. Cloudflare Pages only serves the application files.

This document describes the system that is implemented now. The research notes also discuss AprilTag, WebXR, neural feature matching, PnP, lens correction, and sensor fusion, but those are possible future directions, not current features.

## Reading this as a project case study

This is the engineering companion to the portfolio README, not a claim of production-grade inspection accuracy. The implementation shows how a static browser application can keep the data model, image processing, and projected interaction on-device while refusing to present a stale pose as live. Use the [mobile AR workflow](mobile-ar-workflow.md) for the hands-on demo path, [development and setup](development-and-setup.md) for a repeatable local environment, and [Cloudflare Pages development](cloudflare-pages-dev.md) for hosting checks.

The strongest current demonstration is a matching bundled Arduino sample and physical board under controlled light. The generic parser capabilities are real, but arbitrary board upload is disabled in the showcase UI. Treat every tracking threshold in this document as an engineering setting that needs validation against the intended physical boards and devices.

## The tracking path at a glance

```text
rear camera
    |
    v
video-frame-aware scheduler -- allows only one frame in flight
    |
    v
transferable ImageBitmap
    |
    v
classic Web Worker + OffscreenCanvas
    |
    v
OpenCV 4.13 WebAssembly on the device CPU
    |
    +--> AKAZE feature matching for a global position
    |
    +--> pyramidal Lucas-Kanade optical flow for nearby motion
    |
    v
RANSAC homography + quality and geometry checks
    |
    v
TRACKED / SUSPECT / RECOVERING / LOST state
    |
    v
coherent four-corner smoothing
    |
    v
exact WebGL projective overlay, with a Canvas2D fallback
```

The two tracking methods solve different parts of the problem. Feature matching can recognize the board after a larger move or angle change, but it costs more processing time. Optical flow is faster and follows small frame-to-frame motion well, but it can drift or fail after blur, occlusion, or a large jump. The app combines both instead of expecting one method to do everything.

## Why a homography fits a PCB

A homography is a 3-by-3 projective transform that maps points on one flat plane to points on another view of the same plane. A mostly flat PCB is a good match for this model: the canonical board image is one plane, and the visible board in the camera is another view of that plane.

At least four valid point pairs are needed. In practice the tracker uses many pairs, then RANSAC finds a transform that agrees with a strong group while rejecting mismatches. The result maps the four canonical board corners to the four camera corners.

A homography does not make weak matches trustworthy, and it is not a full 3D model. Tall components, severe lens distortion, a bent board, rolling-shutter motion, or a nearly edge-on board can break the flat-plane assumption. This is why the transform is accepted only after several independent quality checks.

## Four-corner calibration

Calibration gives the tracker its first trusted view.

1. The user places the handles in top-left, top-right, bottom-right, and bottom-left order around the physical board.
2. Display coordinates are converted back to camera-pixel coordinates. This conversion accounts for the camera preview's `object-fit: cover` crop, so portrait and landscape screens do not silently change the selected area.
3. The selected quadrilateral is checked for crossed corners, very short edges, and an unusably small area.
4. The calibration frame is processed at up to a 1100-pixel long edge.
5. OpenCV rectifies the selected quadrilateral into a front-facing canonical board image. Its long edge is 640 pixels and its shape follows the board-file aspect ratio.
6. Features and recovery views are built from that canonical image.

While a handle is being dragged, the calibration screen shows a live magnifier at about 3x. Its crop uses the same centered `object-fit: cover` geometry as the camera preview, including portrait cover-cropping. The selected point stays at the centre of the lens even when the requested crop reaches an edge of the camera image; the unavailable part is left empty instead of shifting the target away from the centre. The lens prefers the upper-right of the point, flips to another side when needed, uses a larger gap for touch, and never receives pointer input. Only one pointer owns a drag at a time. The four handles remain 44px touch targets with translucent fills and clear borders/numbers so the board edge is easier to see underneath.

The homography and calibration always use the physical board outline exactly. The render source may use a small attached-artwork collar around that outline, capped at 12% of the physical board's shorter side. That collar is only for nearby board-connected details such as a connector or package that physically protrudes beyond the PCB edge; it is not a destination margin and does not stretch the board boundary.

A careful calibration still matters. Keep the full outline visible, wait for camera focus, avoid bright glare, and place each handle on the real outer board edge rather than on a nearby shadow or connector.

### Detect edge

The AR menu has one `Calibration` action. It opens the same four-handle calibration screen whether the user wants to place the corners by hand or use the one-shot `Detect edge` action. When calibration begins, the app keeps a private copy of the original four handle positions and draws a second, faint dashed quadrilateral that is expanded by 10% around their centroid. That highlighted region is the only area given to the detector. Moving a handle changes the manual quad but does not move the search region; this keeps an accidental drag from silently changing what the detector is allowed to inspect.

`cameraTracker.detectEdges()` captures one current video frame and sends it to the existing tracking worker. The worker converts the frame to grayscale, builds horizontal and vertical gradient images, chooses an adaptive threshold from the expanded region, and scores candidate lines along each side of the starting quadrilateral. The best four lines are intersected into a new ordered quadrilateral, then checked for convexity, useful area, sensible edge lengths, image bounds, displacement from the starting quad, and a minimum score margin. This is a bounded gradient-and-line search, not a second continuous tracker. It uses the phone's CPU and does not send the camera frame to a server.

The result only moves the four handles. It never applies the calibration automatically. The UI shows a short confidence message and leaves the user in control of the final review, because a shadow, glare line, table edge, or connector can sometimes be stronger than the actual PCB outline. If a side is weak, ambiguous, out of bounds, or too far from the initial selection, the request fails safely and the manual points from before the request are restored. The user can tighten the handles, improve the lighting, try again, or place them manually. Cancel, camera stop, resize/orientation changes, and a new calibration invalidate older requests so a late worker response cannot overwrite newer work.

The eye button beside `Apply` provides a temporary overlay preview while calibration is still open. It uses the same filtered, board-only source and projection bounds as the final overlay, but maps that source through a temporary homography from the physical board corners to the current handles. Dragging a handle or accepting a detected edge redraws the preview immediately. The preview uses near-full temporary visibility (95%) so the artwork is easy to compare with the camera image. It does not commit calibration, start tracking, or change the tracker reference; it is only a visual aid for checking the board boundary and internal artwork before applying. It stays below the handles and magnifier, accepts no pointer input, and is cleared when turned off, cancelled, or when a new calibration starts. This uses the same on-device canvas path on supported phones and on the static Cloudflare Pages deployment; no preview image is uploaded or processed remotely.

## The reference-view atlas

A single front-facing photo is not enough for dependable recovery after a large perspective change. A feature's appearance can change substantially when the board is tilted. During calibration, AR-DUINO therefore creates a small set of synthetic views from the rectified board:

- one front view;
- yaw views at about 42 and 58 degrees in both directions;
- pitch views at about 48 degrees in both directions;
- roll views at about 25 and 45 degrees in both directions; and
- four diagonal pitch-and-yaw views.

That makes 15 possible recovery views. Each view keeps canonical board coordinates with its descriptors, so a match from any view still produces a transform in the same board coordinate system. The app keeps at most 520 well-distributed reference features per view. Calibration requires at least 45 stable front-view features and at least five usable atlas views.

Synthetic warps are an approximation. They make the tracker much less dependent on the original front view, but they cannot reproduce every lighting reflection, focus change, or parallax effect from real components.

### Trusted live views

The app can also learn up to six real camera angles during the current session. A live view is admitted only after a strong accepted pose with enough inliers, broad board coverage, low reprojection error, and a shape that is meaningfully different from stored views. This conservative rule prevents a weak pose from teaching the tracker the wrong location.

Live views are held in memory and disappear when the tracker is reset or the page is reloaded. They help most after the user has reached an angle confidently once; they are not a substitute for global recovery from a completely unseen, poor-quality view.

## Global recovery with AKAZE

The current runtime uses OpenCV 4.13 AKAZE with binary MLDB descriptors. AKAZE finds repeatable image locations and describes the small patch around each location as a binary value. A brute-force matcher compares those descriptors with Hamming distance.

For every selected reference view, the matcher asks for the two nearest current-frame matches. A ratio and distance check removes ambiguous results, which is important on a PCB where similar pads and pin rows repeat. The strongest view candidates then go through homography estimation and pose validation. When tracking is already healthy, nearby atlas views are tried first. During recovery, the search expands to all stored views.

The current frame may retain up to 760 features. This is enough to give RANSAC choices while keeping memory and CPU work bounded on a phone.

## Fast motion with optical flow

Between feature anchors, sparse pyramidal Lucas-Kanade optical flow follows trusted points from the previous grayscale frame into the current frame. Pyramids let the search handle more movement than a one-scale patch tracker.

Every point is checked in both directions:

1. track the point from the previous frame to the current frame;
2. track that result back to the previous frame; and
3. keep it only when it returns close to where it started.

This forward/backward check removes many points that landed on a similar-looking pad, changed due to glare, or became unreliable near an occlusion. Up to 220 spatially distributed points are used. A newly accepted feature pose replenishes the flow seeds, which keeps accumulated optical-flow drift from becoming the new reference.

The worker periodically runs a descriptor anchor even while flow is working. It also searches a predicted board region first and returns to a wider or full-frame feature search after a miss. There is no growing queue: the next camera frame is not submitted until the worker returns the current one.

## Deciding whether a pose is safe

A transform is not displayed just because OpenCV returned one. The current acceptance path checks:

- enough feature or flow pairs;
- RANSAC inlier count and inlier ratio;
- coverage across a 4-by-3 grid on the canonical board;
- horizontal and vertical spread of the inliers;
- root-mean-square and median reprojection error;
- finite, convex corners with a believable area;
- reasonable image bounds; and
- a temporal jump gate against the last accepted pose.

Feature and flow candidates are scored and compared. A weak feature result is not allowed to replace a clearly stronger flow pose simply because a descriptor cycle happened on that frame. This arbitration is one of the safeguards against a false recovery poisoning the next set of flow points.

The key current bounds are kept near the top of `src/ar/camera-tracker.worker.js`. They include a minimum of 10 feature pairs, at least 8 ordinary feature inliers, at least 8 flow inliers, and a minimum 30% feature or 48% flow inlier ratio. Recovery can ask for more inliers after repeated misses. These numbers are engineering settings, not universal truths; changes should be tested on real target boards rather than tuned around one recording.

## Tracking states and recovery

The worker reports four user-facing states:

| State | Meaning | Presentation |
| --- | --- | --- |
| `TRACKED` | A recent pose passed all checks. | Show the filtered live overlay. |
| `SUSPECT` | One or two recent updates failed, or the last good pose is very recent. | Start reducing trust while searching again. |
| `RECOVERING` | No good pose has arrived for longer, but recovery is still active. | Fade the overlay and use wider feature searches. |
| `LOST` | The last accepted pose is stale. | Hide or heavily fade it and ask the user to keep the board visible or recalibrate. |

The application does not present a frozen old pose as if it were live. Short gaps are softened visually, but stale tracking freshness reaches zero. A successful global feature match resets the corner filter so the recovered board is not slowly pulled toward an obsolete pose.

## Stabilization and overlay rendering

Raw corner measurements are noisy. AR-DUINO uses a confidence-aware One Euro style filter, but it applies one coherent smoothing gain to the four-corner set. Filtering four corners independently can bend and breathe a quadrilateral; a shared response keeps the projective shape more consistent while still reducing small jitter.

The PCB artwork is rendered once into a transparent source canvas when calibration is applied. Camera motion then changes the transform rather than rebuilding the board drawing every frame.

The source snapshot is filtered after background removal. Opaque pixels inside the physical outline are always kept. Outside the outline, an opaque connected component is kept only when it touches the board or a narrow near-edge seed band, and only while it remains inside the collar. This keeps close attached artwork while dropping detached frames, logos, copyright text, and notes without relying on component names or reference-designator lists. Pixels outside the collar are cleared.

The preferred renderer is WebGL. Two triangles carry homogeneous clip-space positions so the texture follows a true projective warp rather than ordinary affine interpolation. The physical board bounds land on the tracked physical corners, while the collar carries only the allowed nearby source pixels. WebGL passes raw texture coordinates and the fragment shader makes out-of-texture coordinates transparent; this prevents `CLAMP_TO_EDGE` sampling from smearing the source edge into a stretched strip. If WebGL cannot be created, a 10-by-7 Canvas2D triangle mesh follows the same physical/collar geometry and uses the same filtered source. WebGL accelerates overlay composition only; AKAZE, optical flow, and RANSAC remain CPU work inside WebAssembly.

Sequence isolation uses separate theme roles for the active sequence component and pin, the selected net, connected components and nets, and muted unfocused nets. Light and dark themes provide their own values for these roles so the active inspection target and its connected context remain clear in either mode. Unrelated board artwork is left transparent in the isolated source. The normal viewer is rendered again immediately after the temporary AR source is created, so this presentation choice does not alter the flat viewer. It is still the same client-side canvas work on mobile and Cloudflare Pages, with no change to deployment or camera processing.

### Transparency and full overlay visibility

The transparency control is a user-facing camera/overlay balance from 0% to 100%. After a successful calibration the app selects 100%, so the board artwork is not additionally faded by the user's transparency setting. At 100%, a healthy `TRACKED` pose therefore uses the full overlay opacity available from the renderer; the camera is dimmed separately for contrast. Tracking safety still wins over that preference: `SUSPECT`, `RECOVERING`, and `LOST` states reduce or hide stale artwork so a frozen projection is not presented as current. The attached-artwork collar remains geometrically bounded at every setting, so increased visibility does not reintroduce stretched or detached artwork.

## The PCB viewer remains the same state inside AR

AR does not create a separate, reduced copy of the PCB viewer. The ordinary viewer state remains the source of the projected board image: visible layers, component/footprint/label switches, copper and outline settings, connectivity highlighting, the selected component, and the selected net all continue to use the same renderer and state object. When one of those settings changes, `refreshProjectedSource()` rebuilds the transparent source canvas from the updated viewer state and keeps the current camera homography.

The projected canvas is interactive after a good pose. A tap is converted through the inverse homography into the board coordinate system, then uses the viewer's existing nearest-net and nearest-component hit tests. Tapping a trace or pad selects its net first; the normal selection panel and connectivity highlighting then show the same information used in the flat PCB view. This means net names, connected pads, component details, and related traces do not need a second AR-specific data model.

Inspection sequences use the same shared state as well. The sequence editor, sequence preview, saved steps, probe pins, previous/next navigation, pass/flag actions, and the sequence view can be opened while the camera remains active. The sequence viewer remembers the last valid step for the current in-memory board/sequence session and resumes there, clamping the index safely if the sequence changed. While that viewer is open in AR, its camera/overlay transparency slider appears as a full-width top row in the sequence navigation and stays synchronized with the AR menu control. The camera overlay stays behind the workspace, and changes made by the viewer or sequence controls are reflected in the next projected source refresh. AR is an alternate presentation and input surface for the PCB viewer, not a separate application with a separate set of selections.

Developer settings include `Isolate active sequence step in AR`. When it is on and a sequence is active, the projected source is rebuilt for the current step only. A component step with a defined probe pin follows only that pad's net, using the sequence item's `pinNet` as a safe fallback when the pad record has no net. It keeps the selected footprint, its pin highlight and label, and components directly attached to that one net; if the pin has no resolvable net, it safely keeps the selected component without expanding through the component's other pins. A net step keeps only the selected net and components directly attached to it, so traversal does not expand through every other net on those components or pull in large unrelated pours. Unrelated board content remains transparent. Outside an active sequence, normal viewer selection retains its broader connectivity exploration. Both normal sequence highlighting and isolated AR projection use the same scoped connectivity state. The ordinary flat PCB viewer is restored immediately after the temporary AR source is made, so isolation changes what is projected without changing the normal viewer. The choice is stored in local browser storage and defaults to off. With it off, AR uses the complete current viewer source exactly as before. It is a client-side presentation choice and does not send sequence or board data anywhere.

## How mobile processing is kept under control

The camera request prefers the rear camera, 1280 by 720 video, and 30 frames per second. These are ideal constraints, so the browser may return the nearest supported mode. Continuous focus and continuous exposure are requested only when the camera reports those controls.

The visible preview keeps the camera's useful resolution. Tracking uses a smaller grayscale work image selected by the performance profile:

| Profile | Tracking long edge | Capture opportunity | Descriptor anchor |
| --- | ---: | ---: | ---: |
| Battery saver | 512 px | up to about 15/s | every 6 processed frames |
| Balanced | 640 px | up to about 18/s | every 5 processed frames |
| Higher accuracy | 720 px | up to about 20/s | every 4 processed frames |

These rates are opportunities, not promised frames per second. A slower device naturally processes fewer frames because only one frame may be in flight. This backpressure prevents latency and memory use from growing without limit.

`requestVideoFrameCallback()` aligns capture opportunities with real camera frames where it exists. A timer is the fallback. Each frame crosses into the worker as a transferable `ImageBitmap`, and `OffscreenCanvas` handles worker-side resizing and pixel access. The main thread stays available for touch input, menus, and rendering.

After calibration, a two-finger pinch over the AR view applies a bounded 1x–4x visual zoom to the presentation. It uses the same CSS translate-and-scale transform for the visible camera video, projected overlay, and debug canvas, with translation clamped so the transformed layers do not reveal blank space. The raw camera/video frames supplied to the worker remain full-frame and untransformed; this preserves the whole-board context needed by AKAZE, optical flow, and recovery, and the pinch never changes the pixels used for tracking. AR taps invert the presentation transform before applying the existing homography mapping, so selection still lands on the board feature under the user's finger. Calibration, camera lifecycle changes, and resize/orientation changes reset the presentation transform. Browser page pinch/zoom is suppressed while the AR gesture is owned by the app, including Safari's touch behavior.

The OpenCV loader is deliberately a classic worker wrapped in its own function scope. The generated OpenCV file is loaded with `importScripts()`. The wrapper prevents generic names inside the application worker and the generated runtime from being declared in the same global scope, which was the cause of the earlier `Identifier 'context' has already been declared` startup failure.

## Browser and device compatibility

The design targets current Android Chrome/Chromium browsers and current iPhone/iPad Safari. Desktop Chrome, Edge, and Safari are useful for development, although desktop camera behavior does not prove mobile performance. Embedded social-media or messaging browsers are less predictable; opening the site in the phone's normal browser is the safer choice.

The tracker checks for these browser features before it starts:

- camera access through `navigator.mediaDevices.getUserMedia()`;
- Web Workers;
- `createImageBitmap()`;
- `OffscreenCanvas`;
- WebAssembly; and
- a secure context.

WebGL is preferred but optional because Canvas2D is available as the overlay fallback. `requestVideoFrameCallback()` is also optional. WebXR, a native application, a device GPU compute API, and an IMU permission are not required.

Camera permission is always controlled by the browser and user. Camera access normally requires HTTPS; `localhost` is the development exception on the same computer. A phone opening a computer's plain `http://192.168...` address is not treated as localhost and will usually not get camera access.

Compatibility means the required APIs are available, not that every device will give equal tracking quality. Camera optics, autofocus, thermal limits, browser memory, board texture, and lighting all matter. Test the actual device and board combinations intended for use.

Visual pinch support depends on the browser's pointer/touch events and CSS transform support, which are available in the supported mobile browsers. It changes only the local presentation; it does not promise optical detail or increase the resolution of the camera frames processed by the tracker.

## Why Cloudflare Pages fits this application

The production output is a static Vite site. Cloudflare Pages serves `index.html`, JavaScript, CSS, the custom OpenCV JavaScript loader, and the OpenCV WebAssembly file. There are no Pages Functions and no server-side camera processing.

This is a good fit because:

- the Pages domain supplies HTTPS for camera access;
- the phone performs the vision work, so there is no video upload or vision server to scale;
- hashed Vite assets can be cached at the edge; and
- the current OpenCV WASM file is 3,404,498 bytes, well below Pages' current 25 MiB single-asset limit.

`public/_headers` is copied into `dist` during the build. It currently sends:

```text
Permissions-Policy: camera=(self), microphone=()
```

It also gives `/vendor/opencv/*` a one-day, revalidated browser cache. The OpenCV JavaScript and WASM filenames carry the same `arduino-r2` revision and must be deployed as a pair. Increment both filenames and the worker URLs together when rebuilding the runtime. On a real Pages deployment, also confirm that the WASM response has an `application/wasm` content type.

The current artifact does not require `SharedArrayBuffer`, cross-origin isolation, or server execution. It is a compact, single worker-side OpenCV runtime tailored to the APIs this tracker uses.

### Build settings for Git-connected Pages

Use these project settings:

```text
Build command:          npm run build
Build output directory: dist
Node version:           read from .node-version (22.12.0)
```

Cloudflare's current Pages documentation lists `npm run build` and `dist` for Vite. A normal push to a non-production branch can create a Pages preview when branch previews are enabled.

### Temporary HTTPS testing with TryCloudflare

For early phone testing, build first and expose the local production preview through a Quick Tunnel.

First PowerShell terminal:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run preview:mobile
```

Second PowerShell terminal:

```powershell
cloudflared tunnel --url http://127.0.0.1:4173 --http-host-header localhost:4173
```

Open the printed `https://...trycloudflare.com` address on the phone. It is a temporary, public, unauthenticated development URL. It changes when the tunnel restarts and has no production uptime promise.

TryCloudflare proxies the local Vite server. It does **not** make that server behave like Pages, so Pages-specific `_headers` rules are not applied in this step.

### A real Pages preview before production

After the Quick Tunnel test, upload `dist` to a non-production branch of an existing Pages project:

```powershell
npm.cmd run build
npx wrangler pages deploy dist --project-name <your-pages-project> --branch ar-dev
```

That preview is the right place to check the real Pages headers, cache behavior, JavaScript and WASM requests, camera permission, and phone performance. Use the production branch only after that preview passes.

## Debug points and local diagnostics

The developer settings panel can show the current computer-vision evidence over the camera with `Show tracked feature points`:

- cyan points are features detected in the current image;
- amber rings are descriptor matches;
- magenta crosses survived the optical-flow forward/backward check; and
- green rings are inliers used by the accepted pose. The green quadrilateral is the accepted board boundary.

The tracking diagnostic collector still records bounded, in-memory state, timing, match, coverage, reprojection, and rejection information for future troubleshooting. The former metrics and log controls are kept in the code but their settings-panel section is hidden and its buttons are disabled; runtime updates do not make that old UI appear. No diagnostic log or camera image is sent to a server. The visible feature-point switch is independent of that retained collection.

When the diagnostic data is inspected during development, these values help separate common failure modes:

| Symptom | Useful evidence |
| --- | --- |
| Very few cyan points | Blur, low contrast, glare, or board too small. |
| Many cyan points but few amber matches | New angle/appearance, repetitive texture, or weak reference. |
| Many matches but few green inliers | Matches do not agree on one board transform. |
| Good inliers but pose rejected | Coverage, reprojection, shape, bounds, or temporal jump gate failed. |
| Flow count falls during motion | Blur, occlusion, or movement too large between processed frames. |
| Processing time grows | Device load or thermal throttling; try a lower profile. |

## Known limits

Markerless browser tracking can still be lost. This implementation can still fail when:

- motion blur removes stable image detail;
- hard reflections move across the solder mask or metal pads;
- the board is too small in the frame;
- too much of the board is covered or outside the image;
- the view becomes almost edge-on;
- rows of identical pads create ambiguous matches;
- tall components cause strong parallax against the flat-board model;
- autofocus or exposure is still changing;
- fast motion combines rolling shutter with blur; or
- a phone becomes hot and reduces sustained CPU speed.

A learned live view helps only after that view was reached through a strong pose. It cannot repair a bad first calibration. When recovery repeatedly fails, return the board to a clearer view or open `Calibration` again.

## A useful real-device test

Synthetic browser probes protect the geometry and recovery code from regressions, but they are not field proof. The current tracker probe covers front view, x/y translation, roll, scale, 45- and 60-degree yaw-like warps, a diagonal warp, and forced recovery. Real cameras add focus, reflections, exposure, blur, rolling shutter, and heat.

For each target Android and iPhone class, test the same physical board with:

1. slow x and y translation;
2. movement toward and away from the camera;
3. in-plane roll;
4. pitch and yaw in both directions, increasing in controlled steps;
5. short fast movements followed by a stop;
6. partial hand and tool occlusion;
7. diffuse, dim, directional, and reflective lighting; and
8. at least 15 minutes of continuous use.

Record how often the board stays tracked, the longest loss, the time to recover, visible corner error, processing latency, and the rejected-by reason. If the retained diagnostic tools are re-enabled in a future development build, compare those exported runs instead of judging only by how smooth one short session looked.

Before a Pages preview or release, run:

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
```

Then confirm on the deployed preview that calibration is touchable, the worker reaches `ready`, the OpenCV files return successfully, the overlay edges land on the physical board boundary, the debug toggle works, and a lost board can recover without returning exactly to the calibration view.

## Main implementation files

| File | Responsibility |
| --- | --- |
| `src/ar/camera.js` | Camera permission, rear-camera constraints, and supported focus/exposure controls. |
| `src/ar/camera-tracker.js` | Browser capability checks, frame scheduling, backpressure, worker messages, display/video coordinates, and the one-shot `detectEdges()` request. |
| `src/ar/camera-tracker.worker.js` | OpenCV loading, bounded gradient edge detection, calibration, atlas, AKAZE matching, optical flow, homography, validation, and recovery state. |
| `src/ar/four-corner-calibration.js` | Four-handle interaction state and board-to-camera homography. |
| `src/ar/tracking-geometry.js` | Cover-crop coordinate conversion, calibration-loupe crop and placement, initial search-quad expansion, and coherent corner smoothing. |
| `src/ar/projected-overlay.js` | Attached-artwork collar calculation, filtered board snapshot, and WebGL/Canvas2D projective rendering. |
| `src/ar/tracking-diagnostics.js` | Point mapping, point stripping, and bounded diagnostic logs. |
| `public/_headers` | Static Pages permissions and OpenCV cache rules. |

## Primary references

- [OpenCV: AKAZE local-feature matching](https://docs.opencv.org/4.13.0/db/d70/tutorial_akaze_matching.html)
- [OpenCV: pyramidal Lucas-Kanade optical flow](https://docs.opencv.org/4.13.0/dc/d6b/group__video__track.html)
- [OpenCV: feature matching and homography](https://docs.opencv.org/4.13.0/d1/de0/tutorial_py_feature_homography.html)
- [MDN: `getUserMedia()` and secure-context rules](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MDN: `requestVideoFrameCallback()`](https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback)
- [MDN: `OffscreenCanvas`](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas)
- [MDN: transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
- [Cloudflare Pages build configuration](https://developers.cloudflare.com/pages/configuration/build-configuration/)
- [Cloudflare Pages custom headers](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages direct upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
