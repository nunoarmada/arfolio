// Renders hero.png and social-preview.png from the HTML sources. Run from the repo root:
//   node docs/brand/src/render.mjs   (uses @playwright/test from apps/web; set CHROMIUM=/path/to/chrome if the bundled one is missing)
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
// Resolve Playwright from the web workspace so the repo needs no extra dependency.
const { chromium } = createRequire(path.join(root, 'apps/web/package.json'))('@playwright/test');
const jobs = [
  ['hero.html', 'docs/images/hero.png', 1600, 600, 2],
  ['social.html', '.github/social-preview.png', 1280, 640, 1],
];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM, args: ['--no-sandbox'] });
for (const [src, out, width, height, scale] of jobs) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.goto(pathToFileURL(path.join(here, src)).href);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(root, out), clip: { x: 0, y: 0, width, height } });
  await page.close();
}
await browser.close();
