// 修复验证：把真实 CanvasRenderer 打进页面，在 Chromium / WebKit 真实渲染含降部字符，
// 逐 cell 行扫描墨迹，确认升/降部完整落在各自 cell 带内（不被裁），并核对确定式 cell 高一致。
import { chromium, webkit } from '@playwright/test';

const ROOT =
  process.env.TMEX_RENDERER_PATH ??
  new URL('../../packages/ghostty-terminal/src/canvas-renderer.ts', import.meta.url).pathname;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

const built = await Bun.build({ entrypoints: [ROOT], format: 'esm', target: 'browser' });
const rendererCode = await built.outputs[0].text();

const CHARS = ['gyjpqf', 'MWAÅ', 'gjpqy', 'flkb'];

function makeFrame(dpr) {
  const cellH = Math.round(FONT_SIZE * LINE_HEIGHT); // 确定式 CSS cell 高 = 16
  const style = {
    bold: false, italic: false, faint: false, blink: false, inverse: false,
    invisible: false, strikethrough: false, overline: false, underline: 0,
  };
  const rows = CHARS.map((text, y) => ({
    y, dirty: true, wrap: false, wrapContinuation: false, text,
    cells: [...text].map((ch, x) => ({
      x, text: ch, codepoints: [ch.codePointAt(0)], widthKind: 'narrow',
      hasText: true, style, fgColor: null, bgColor: null,
    })),
  }));
  return {
    meta: {
      cols: 8, rows: CHARS.length, dirty: 'full',
      colors: {
        background: { r: 0, g: 0, b: 0 }, foreground: { r: 255, g: 255, b: 255 },
        cursor: null, palette: [],
      },
      cursor: { style: 'block', visible: false, blinking: false, passwordInput: false, x: null, y: null, wideTail: false },
    },
    rows,
    cellDimensions: { width: 8, height: cellH },
  };
}

async function verify(name, launcher) {
  const browser = await launcher.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addScriptTag({ content: rendererCode, type: 'module' }).catch(() => {});

  const result = await page.evaluate(
    async ({ rendererCode, frame, FONT_SIZE, LINE_HEIGHT }) => {
      const blob = new Blob([rendererCode], { type: 'text/javascript' });
      const url = URL.createObjectURL(blob);
      const mod = await import(url);
      const { CanvasRenderer } = mod;

      const screen = document.createElement('div');
      screen.style.position = 'absolute';
      document.body.appendChild(screen);

      const renderer = new CanvasRenderer({
        screenElement: screen,
        theme: { selectionBackground: 'rgba(0,0,0,0.3)' },
        fontFamily: 'monospace',
        fontSize: FONT_SIZE,
      });
      renderer.render(frame);

      const dpr = window.devicePixelRatio;
      const deviceCellH = Math.round(Math.round(FONT_SIZE * LINE_HEIGHT) * dpr);
      const main = screen.querySelector('canvas[data-layer="main"]');
      const ctx = main.getContext('2d');
      const W = main.width;
      const img = ctx.getImageData(0, 0, W, main.height).data;

      // 逐 cell 行扫描墨迹 top/bottom（相对该行带顶），判断是否溢出该行带
      const perRow = [];
      for (let r = 0; r < frame.rows.length; r++) {
        const bandTop = r * deviceCellH;
        let inkTop = -1;
        let inkBottom = -1;
        for (let row = bandTop; row < bandTop + deviceCellH; row++) {
          let hasInk = false;
          for (let col = 0; col < W; col++) {
            if (img[(row * W + col) * 4] > 40) { hasInk = true; break; }
          }
          if (hasInk) {
            if (inkTop === -1) inkTop = row - bandTop;
            inkBottom = row - bandTop;
          }
        }
        perRow.push({
          text: frame.rows[r].text,
          inkTop, inkBottom,
          // 墨迹是否触到带的首/末像素行（=潜在裁切）
          touchTop: inkTop === 0,
          touchBottom: inkBottom === deviceCellH - 1,
        });
      }

      return { dpr, deviceCellH, perRow };
    },
    { rendererCode, frame: makeFrame(2), FONT_SIZE, LINE_HEIGHT }
  );

  await browser.close();
  return { name, ...result };
}

const results = [];
results.push(await verify('chromium', chromium));
results.push(await verify('webkit', webkit));

let anyClip = false;
const heights = new Set();
for (const r of results) {
  heights.add(r.deviceCellH);
  console.log(`\n========= ${r.name} (dpr=${r.dpr}, deviceCellH=${r.deviceCellH}) =========`);
  for (const row of r.perRow) {
    const clipped = row.touchTop || row.touchBottom;
    if (clipped) anyClip = true;
    console.log(
      `  "${row.text.padEnd(7)}" ink ${String(row.inkTop).padStart(2)}..${String(row.inkBottom).padStart(2)}` +
        `  touchTop=${row.touchTop} touchBottom=${row.touchBottom}` +
        (clipped ? '  <-- 潜在裁切' : '  ok')
    );
  }
}

console.log('\n================ 结论 ================');
console.log(`#1 cell 高跨引擎一致: ${heights.size === 1 ? 'PASS' : 'FAIL'} (heights=${[...heights].join(',')})`);
console.log(`#2 无升/降部裁切: ${anyClip ? 'FAIL' : 'PASS'}`);
