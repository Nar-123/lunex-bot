// Copies the non-TypeScript static assets (index.html, style.css) into
// ui/dist/ after `tsc -p tsconfig.ui.json` compiles the .ts files there --
// tsc only ever emits .js from .ts, it never copies plain static files.
// Run as part of `npm run build:ui` (see package.json).
const fs = require('node:fs');
const path = require('node:path');

const root = __dirname;
const dist = path.join(root, 'dist');
fs.mkdirSync(dist, { recursive: true });

for (const file of ['index.html', 'style.css']) {
  fs.copyFileSync(path.join(root, file), path.join(dist, file));
}

console.log('ui/copy-static.js: copied index.html + style.css into ui/dist/');
