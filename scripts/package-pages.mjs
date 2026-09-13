import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Only the built static app and the already public planning pages are published.
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
writeFileSync(resolve(output, '.nojekyll'), '');
console.log('GitHub Pages artifact ready: dist/github-pages (static app + planning archive only).');
