import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';

// Publish the built static app, planning pages, and the independent UI review preview.
const root = process.cwd();
const app = resolve(root, 'dist/pages/app');
const output = resolve(root, 'dist/github-pages');
if (!existsSync(resolve(app, 'index.html'))) {
  throw new Error('Static app missing. Run npm run pages:build first.');
}
rmSync(output, { recursive: true, force: true });
mkdirSync(resolve(output, 'docs'), { recursive: true });
cpSync(app, resolve(output, 'app'), { recursive: true, dereference: false });
for (const file of ['index.html', 'doc.html', 'decisions.html', 'style.css', 'docs/idea.md', 'docs/manual.md']) {
  cpSync(resolve(root, file), resolve(output, file));
}
const sourceOnly = new Set(['checks', 'references', 'screens', 'work', 'logs']);
for (const name of ['ui-components-v1', 'ui-adoption-flow-v1', 'ui-daily-core-v1']) {
  const source = resolve(root, name);
  cpSync(source, resolve(output, name), {
    recursive: true,
    dereference: false,
    filter: path => {
      const parts = path.slice(source.length + 1).split(sep);
      return !parts.some(part => sourceOnly.has(part))
        && !(name !== 'ui-components-v1' && parts[0] === 'assets' && path.endsWith('.png'))
        && basename(path) !== 'export.html' && !path.endsWith('.log');
    },
  });
}
writeFileSync(resolve(output, '.nojekyll'), '');
console.log('GitHub Pages artifact ready: dist/github-pages (static app + planning archive + UI review previews).');
