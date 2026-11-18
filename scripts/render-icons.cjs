// Renders PugPort's icons with Electron's own renderer, so no image tooling is needed.
// Run with: node scripts/build-icons.mjs (it launches this file in Electron). Output: assets/icons/ and the
// in-app logo in src/ui/brand/. Every size is drawn straight from the vector artwork in assets/brand/:
//   - App icon (exe, taskbar, desktop shortcut, Start, Alt-Tab): app-icon.svg, the line-art pug head on a black
//     rounded tile.
//   - Browser tab: app-tile-white.svg, the same pug head on a white rounded tile.
//   - In-app logo (sidebar): pug-line.svg, the same pug head on its own, with no tile.
//   - Window title bars and the tray: a monoline bone, dark for light taskbars and light for dark ones; the "-run" frames add the
//     green dot that blinks while tasks run. The dot is cut out of the bone so it reads on any taskbar.
// The browser tab and the sidebar draw the pug's lines a little heavier for the small size they are shown at (a stroke
// along their edges, no line moved) so they do not fade.
const { app, BrowserWindow } = require('electron');
const { mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const root = join(__dirname, '..');
const out = join(root, 'assets', 'icons');
const uiOut = join(root, 'src', 'ui', 'brand');
/** Extra line weight, in the artwork's 1024 units, for the pug shown at `size` px: none from 128 px up. */
const WEIGHTS = [
  [16, 28],
  [20, 24],
  [24, 20],
  [32, 16],
  [48, 10],
  [64, 6],
  [128, 0],
];
function weightAt(size) {
  if (size <= WEIGHTS[0][0]) return WEIGHTS[0][1];
  for (let i = 1; i < WEIGHTS.length; i++)
    if (size <= WEIGHTS[i][0]) {
      const [a, wa] = WEIGHTS[i - 1];
      const [b, wb] = WEIGHTS[i];
      return wa + ((wb - wa) * (size - a)) / (b - a);
    }
  return 0;
}
/**
 * A brand SVG rendered at `size` px, so each icon size comes from the vector instead of being scaled down. With
 * `shown` (the size it is displayed at; the sidebar shows a larger bitmap than it draws) its lines are weighted for
 * that display size; without it the artwork is drawn as it is.
 */
const brand = (name, size, shown) => {
  const svg = readFileSync(join(root, 'assets', 'brand', name), 'utf8');
  if (!svg.includes('width="1024" height="1024"')) throw new Error(`${name} must declare width="1024" height="1024"`);
  const lines = /(<path d="[^"]*") fill="#111214" fill-rule="evenodd"/;
  if (!lines.test(svg)) throw new Error(`${name} has no line layer to weight`);
  const weight = shown ? weightAt(shown) : 0;
  return svgData(
    svg
      .replace('width="1024" height="1024"', `width="${size}" height="${size}"`)
      .replace(
        lines,
        (_, path) =>
          `${path} fill="#111214" fill-rule="evenodd"${weight > 0 ? ` stroke="#111214" stroke-width="${weight.toFixed(1)}" stroke-linejoin="round"` : ''}`,
      ),
  );
};
const green = '#22C55E';

/** The bone on a 24 grid; thicker strokes at 16px keep it legible. */
const bone = (
  color,
  width,
  running,
  size,
) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24">
<defs><mask id="cut" maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24"><rect width="24" height="24" fill="#fff"/>
${running ? '<circle cx="19.4" cy="19.4" r="4.6" fill="#000"/>' : ''}</mask></defs>
<g mask="url(#cut)"><path transform="rotate(-35 12 12) translate(0 -0.2)" d="M7.2 9.6 C6.6 8.1 5.1 7.4 3.8 8 C2.4 8.6 2.1 10.3 3 11.3 C1.9 11.9 1.7 13.5 2.6 14.4 C3.7 15.5 5.6 15.1 6.3 13.9 L17.7 13.9 C18.4 15.1 20.3 15.5 21.4 14.4 C22.3 13.5 22.1 11.9 21 11.3 C21.9 10.3 21.6 8.6 20.2 8 C18.9 7.4 17.4 8.1 16.8 9.6 Z" fill="none" stroke="${color}" stroke-width="${width}" stroke-linejoin="round"/></g>
${running ? `<circle cx="19.4" cy="19.4" r="3.4" fill="${green}"/>` : ''}</svg>`;

/** Draws an SVG into a size x size canvas in the page and returns PNG bytes. */
async function render(window, source, size) {
  const url = await window.webContents.executeJavaScript(`(async () => {
  const image = new Image();
  image.src = ${JSON.stringify(source)};
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = ${size};
  canvas.getContext('2d').drawImage(image, 0, 0, ${size}, ${size});
  return canvas.toDataURL('image/png');
})()`);
  return Buffer.from(url.split(',')[1], 'base64');
}
const svgData = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** An ICO whose entries are PNG images (supported since Windows Vista). */
function ico(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = [];
  let offset = 6 + 16 * images.length;
  for (const { size, png } of images) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    entries.push(entry);
  }
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  mkdirSync(out, { recursive: true });
  mkdirSync(uiOut, { recursive: true });
  const window = new BrowserWindow({ width: 256, height: 256, show: false, webPreferences: { offscreen: true } });
  await window.loadURL('data:text/html,<html><body></body></html>');
  const images = [];
  for (const size of [16, 20, 24, 32, 48, 64, 128, 256]) {
    const png = await render(window, brand('app-icon.svg', size), size);
    images.push({ size, png });
    writeFileSync(join(out, `logo-${size}.png`), png);
  }
  writeFileSync(join(out, 'pugport.ico'), ico(images));
  // The sidebar shows the logo at 36px; 128px keeps it sharp on high-DPI screens. The browser tab gets a 64px copy.
  writeFileSync(join(uiOut, 'pug-head.png'), await render(window, brand('pug-line.svg', 128, 36), 128));
  writeFileSync(join(uiOut, 'favicon.png'), await render(window, brand('app-tile-white.svg', 64, 32), 64));
  for (const [theme, color] of [
    ['light', '#1D1D1F'],
    ['dark', '#F2F2F3'],
  ])
    for (const running of [false, true]) {
      const name = `tray-${theme}${running ? '-run' : ''}`;
      writeFileSync(join(out, `${name}.png`), await render(window, svgData(bone(color, 2.2, running, 16)), 16));
      writeFileSync(join(out, `${name}@2x.png`), await render(window, svgData(bone(color, 1.8, running, 32)), 32));
    }
  // Window icons: Windows draws the small sizes (16-24px) in the title bar and the large ones on the taskbar and
  // in Alt-Tab, so the small frames are the bone and the large frames are the app icon. One file per title bar
  // theme, with thicker strokes at the smallest sizes.
  for (const [theme, color] of [
    ['light', '#1D1D1F'],
    ['dark', '#F2F2F3'],
  ]) {
    const frames = [];
    for (const [size, width] of [
      [16, 2.2],
      [20, 2],
      [24, 1.8],
    ])
      frames.push({ size, png: await render(window, svgData(bone(color, width, false, size)), size) });
    frames.push(...images.filter((image) => image.size >= 32));
    writeFileSync(join(out, `window-${theme}.ico`), ico(frames));
  }
  app.exit(0);
});
