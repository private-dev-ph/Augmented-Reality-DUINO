import { readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { defineConfig } from 'vite';

const VIRTUAL_SAMPLE_MANIFEST_ID = 'virtual:sample-manifest';
const RESOLVED_VIRTUAL_SAMPLE_MANIFEST_ID = `\0${VIRTUAL_SAMPLE_MANIFEST_ID}`;

function walkFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = resolve(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function publicRelativeUrl(publicDirectory, filePath) {
  return relative(publicDirectory, filePath)
    .split(sep)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function createSampleManifestPlugin() {
  let publicDirectory = '';

  return {
    name: 'sample-manifest',
    configResolved(config) {
      publicDirectory = resolve(config.publicDir);
    },
    resolveId(id) {
      return id === VIRTUAL_SAMPLE_MANIFEST_ID ? RESOLVED_VIRTUAL_SAMPLE_MANIFEST_ID : null;
    },
    load(id) {
      if (id !== RESOLVED_VIRTUAL_SAMPLE_MANIFEST_ID) return null;

      const samplesByStem = new Map();
      for (const filePath of walkFiles(publicDirectory)) {
        const relativePath = publicRelativeUrl(publicDirectory, filePath);
        const match = relativePath.match(/^(.*)-(reference\.zip|sequence\.json)$/i);
        if (!match) continue;

        const [, stem, fileType] = match;
        const key = stem.toLowerCase();
        const sample = samplesByStem.get(key) || {
          id: stem,
          name: `Arduino ${stem.split('/').at(-1).replaceAll('-', ' ')}`,
          referencePath: '',
          sequencePath: '',
        };
        const pathKey = fileType.toLowerCase() === 'reference.zip' ? 'referencePath' : 'sequencePath';
        sample[pathKey] = relativePath;
        samplesByStem.set(key, sample);
      }

      const sampleFiles = [...samplesByStem.values()]
        .filter(({ referencePath }) => referencePath)
        .sort((first, second) => first.name.localeCompare(second.name));

      return `export const sampleFiles = ${JSON.stringify(sampleFiles)};\n`;
    },
  };
}

export default defineConfig({
  plugins: [createSampleManifestPlugin()],
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
