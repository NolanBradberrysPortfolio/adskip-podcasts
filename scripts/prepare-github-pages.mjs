import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const basePath = normalizeBasePath(process.env.GITHUB_PAGES_BASE_PATH || '/adskip-podcasts/');
const distDir = path.resolve('dist');
const indexPath = path.join(distDir, 'index.html');

const html = await readFile(indexPath, 'utf8');
const patchedHtml = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${basePath}`);

await writeFile(indexPath, patchedHtml);
await writeFile(path.join(distDir, '.nojekyll'), '');

function normalizeBasePath(value) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '/') {
    return '/';
  }

  return `/${trimmed.replace(/^\/+|\/+$/g, '')}/`;
}
