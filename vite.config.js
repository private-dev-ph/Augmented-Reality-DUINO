import { defineConfig } from 'vite';

export default defineConfig({
  optimizeDeps: {
    entries: ['index.html'],
  },
  server: {
    host: '0.0.0.0',
    // Cloudflare Quick Tunnels use a random subdomain for each local test
    // session. Restrict the development host allow-list to that domain.
    allowedHosts: ['.trycloudflare.com'],
    watch: {
      ignored: ['**/tools/**'],
    },
  },
});
