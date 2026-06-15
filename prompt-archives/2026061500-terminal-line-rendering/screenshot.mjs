// 出验收截图：真实 CanvasRenderer 渲染样例文本 + 红色 cell 网格线叠加，直观看
//   - 升/降部（g y j p q f / Å）完整落在 cell 内、上下居中
//   - 组合记号 Zalgo（n̈̃, 故意超出字形盒）允许向上溢出而不被裁
// 注意：本机用 monospace 演示机制；生产实际字体为 GeistMonoTmex，请在 app 内最终验收。
import { chromium } from '@playwright/test';

const ROOT =
  process.env.TMEX_RENDERER_PATH ??
  new URL('../../packages/ghostty-terminal/src/canvas-renderer.ts', import.meta.url).pathname;
const OUT = new URL('./terminal-line-rendering.png', import.meta.url).pathname;
const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

const built = await Bun.build({ entrypoints: [ROOT], format: 'esm', target: 'browser' });
const rendererCode = await built.outputs[0].text();

const ROWS = ['gyjpqf GYJPQF', 'Ágly|kb déjà', 'n̈̃ Z̧a̧ļģo̧ 溢出', 'underline test'];

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 2 });
await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');

const dataUrl = await page.evaluate(
  async ({ rendererCode, ROWS, FONT_SIZE, LINE_HEIGHT }) => {
    const blob = new Blob([rendererCode], { type: 'text/javascript' });
    const mod = await import(URL.createObjectURL(blob));
    const { CanvasRenderer } = mod;

    const cols = Math.max(...ROWS.map((r) => [...r].length));
    const cellH = Math.round(FONT_SIZE * LINE_HEIGHT);
    const style = {
      bold: false, italic: false, faint: false, blink: false, inverse: false,
      invisible: false, strikethrough: false, overline: false, underline: 0,
    };
    const rows = ROWS.map((text, y) => ({
      y, dirty: true, wrap: false, wrapContinuation: false, text,
      cells: [...text].map((ch, x) => ({
        x, text: ch, codepoints: [ch.codePointAt(0)], widthKind: 'narrow',
        hasText: true,
        style: { ...style, underline: y === 3 ? 1 : 0 },
        fgColor: null, bgColor: null,
      })),
    }));

    const screen = document.createElement('div');
    screen.style.position = 'absolute';
    screen.style.left = '0';
    screen.style.top = '0';
    document.body.appendChild(screen);

    const renderer = new CanvasRenderer({
      screenElement: screen,
      theme: { selectionBackground: 'rgba(0,0,0,0.3)' },
      fontFamily: 'monospace',
      fontSize: FONT_SIZE,
    });
    renderer.render({
      meta: {
        cols, rows: ROWS.length, dirty: 'full',
        colors: {
          background: { r: 38, g: 38, b: 38 }, foreground: { r: 208, g: 208, b: 208 },
          cursor: null, palette: [],
        },
        cursor: { style: 'block', visible: false, blinking: false, passwordInput: false, x: null, y: null, wideTail: false },
      },
      rows,
      cellDimensions: { width: 8, height: cellH },
    });

    // 叠加红色 cell 网格线（device px）
    const main = screen.querySelector('canvas[data-layer="main"]');
    const dpr = window.devicePixelRatio;
    const out = document.createElement('canvas');
    out.width = main.width;
    out.height = main.height;
    const o = out.getContext('2d');
    o.drawImage(main, 0, 0);
    o.strokeStyle = 'rgba(255,0,0,0.55)';
    o.lineWidth = 1;
    const deviceCellH = Math.round(cellH * dpr);
    for (let r = 0; r <= ROWS.length; r++) {
      const y = r * deviceCellH + 0.5;
      o.beginPath();
      o.moveTo(0, y);
      o.lineTo(out.width, y);
      o.stroke();
    }
    return out.toDataURL('image/png');
  },
  { rendererCode, ROWS, FONT_SIZE, LINE_HEIGHT }
);

const base64 = dataUrl.split(',')[1];
await Bun.write(OUT, Buffer.from(base64, 'base64'));
await browser.close();
console.log(`saved ${OUT}`);
