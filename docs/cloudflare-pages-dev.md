## Cloudflare Pages

This is a static Vite deployment. For a Git-connected Cloudflare Pages project use:

- Build command: `npm run build`
- Build output directory: `dist`
- Node version: `22.12.0` or newer

No Functions, server runtime, cross-origin isolation, or camera-frame upload is required. Camera access works on the Pages HTTPS domain. `public/_headers` restricts microphone access and gives the OpenCV JavaScript/WASM assets revalidated caching, so a rebuilt custom runtime cannot be stranded behind a year-long immutable entry. Cloudflare serves `.wasm` with the required WebAssembly MIME type.

The custom runtime uses an `arduino-r2` filename revision. Increment that revision whenever the generated OpenCV JavaScript/WASM pair changes; the worker and both files must always be deployed together.

### Temporary mobile preview with TryCloudflare

Use the built `dist` through a temporary HTTPS URL before creating a Pages deployment. In the first PowerShell terminal:

```powershell
npm.cmd run build
npm.cmd run preview:mobile
```

In a second terminal:

```powershell
cloudflared tunnel --url http://127.0.0.1:4173 --http-host-header localhost:4173
```

Open the printed `https://...trycloudflare.com` URL on the phone. The URL is public, unauthenticated, changes every time, and exists only while both terminal processes remain running. It is intended for development and does not apply Cloudflare Pages `_headers`; verify those separately on a Pages preview deployment before production.