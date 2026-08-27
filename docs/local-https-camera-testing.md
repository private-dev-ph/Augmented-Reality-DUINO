# Local HTTPS camera testing

Mobile browsers require a secure origin before exposing `getUserMedia`, the API used by AR camera mode. Consequently, a phone opening `http://<computer-LAN-IP>:5173` cannot grant camera permission, even when that browser supports the camera on HTTPS websites.

The application can be tested without deployment by running Vite locally and creating a temporary Cloudflare Quick Tunnel. A Quick Tunnel creates a random `https://*.trycloudflare.com` address, does not require a Cloudflare account, and ends when its process stops.

## Prerequisites

- Node.js and npm must be installed. Run `npm.cmd install` once in a newly cloned project to install the project's dependencies.
- `cloudflared` must be installed and available on the command line. It provides the temporary HTTPS tunnel; a Cloudflare account is not required for a Quick Tunnel.
- The computer needs outbound internet access so `cloudflared` can create the tunnel. The test device needs internet access to open the generated URL.

The repository includes the Vite development configuration that permits the tunnel's random `trycloudflare.com` host. No certificates, Cloudflare Pages project, account login, or machine-specific application configuration is required.

## Start a test session

Run the following commands from two PowerShell windows in the project folder.

Start Vite in the first window so the tunnel can reach the local development server:

```powershell
npm.cmd run dev -- --host 0.0.0.0 --port 5173
```

Start the HTTPS tunnel in the second window:

```powershell
cloudflared tunnel --url http://localhost:5173
```

After `cloudflared` prints its `https://*.trycloudflare.com` URL, open that exact address on the test device. Camera access can then be granted through the AR button. Vite hot-module reload remains active, so saved source changes refresh the page on the device.

The included Vite development configuration accepts the tunnel's random `trycloudflare.com` host. No production host allow-list is changed.

## Stop a test session

Use `Ctrl+C` in the Cloudflare Tunnel window to close the public HTTPS address. Use `Ctrl+C` in the Vite window to stop the local development server.

## Notes

- The Quick Tunnel URL is temporary and should be shared only with required testers; it exposes the running local application while the tunnel is active.
- The address changes each time the tunnel starts. This is expected.
- The phone and computer must remain online. They do not need to be on the same Wi-Fi network after the tunnel has started.
- If the camera button reports a permission error at the HTTPS URL, grant **Camera** permission for that `trycloudflare.com` site in the browser settings, then reload the page.
