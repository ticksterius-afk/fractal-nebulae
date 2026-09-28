import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset URLs: the production build in dist/ works from any folder or sub-path of a
  // static host (e.g. https://example.com/fractal-nebulae/), not only from the site root.
  base: './',
  // Fixed port so start.bat and bookmarks always find it; if it is taken Vite exits with
  // "Port 5190 is already in use" instead of silently moving to another port.
  server: { port: 5190, strictPort: true },
  preview: { port: 5191 },
  // WebGL2 + ES2022 browsers only (Chrome/Edge are the tuned targets). three.js and Tone.js
  // make one ~1.2 MB chunk, which is expected: the warning limit is raised accordingly.
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
