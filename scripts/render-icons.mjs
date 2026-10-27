// Renders the extension's icons from their two sources in src/icons/:
// icon-small.svg (the tile fills the icon, a heavy mark: the toolbar at 16 and
// 32 px) and icon.svg (an eighth of transparent margin on each side, as the
// stores ask: 48 and 128 px). Every size is rasterized from the vector, never
// scaled down from a larger picture, so the small ones stay sharp.
//
//   npm ci && npx playwright install chromium
//   npm run icons
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const icons = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/icons");
const sizes = [
  [16, "icon-small.svg"],
  [32, "icon-small.svg"],
  [48, "icon.svg"],
  [128, "icon.svg"],
];

const browser = await chromium.launch();
try {
  for (const [size, source] of sizes) {
    const svg = await fs.readFile(path.join(icons, source));
    const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
    await page.setContent(
      `<body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${svg.toString("base64")}" width="${size}" height="${size}" style="display:block"></body>`,
    );
    await page.waitForFunction(() => document.images[0].complete);
    await page.screenshot({ path: path.join(icons, `icon-${size}.png`), omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await page.close();
    console.log(`icon-${size}.png from ${source}`);
  }
} finally {
  await browser.close();
}
