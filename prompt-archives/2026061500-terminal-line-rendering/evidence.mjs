// 证据采集：在 Chromium / WebKit 真实引擎里量化两个独立问题
//   #1 line-height 未被 enforce —— inline span 的 getBoundingClientRect 高度到底等于什么
//   #2 字形垂直被截 —— 现行 textBaseline='top' + textOffsetY 居中下，'g/y/f' 的实际墨迹是否落到 cell 外
// 不启动整个 app，直接用 playwright 浏览器内核跑 page.evaluate。
import { chromium, webkit } from '@playwright/test';

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.2;

async function gather(name, launcher) {
  const browser = await launcher.launch();
  const page = await browser.newPage({ deviceScaleFactor: 2 });
  await page.setContent('<!doctype html><html><body></body></html>');

  const result = await page.evaluate(
    ({ FONT_SIZE, LINE_HEIGHT }) => {
      const FAMILY = 'monospace';

      // ---- #1：probe span 高度，inline vs inline-block ----
      function probeHeight(display) {
        const span = document.createElement('span');
        span.textContent = 'WWWWWWWWWW';
        span.style.position = 'absolute';
        span.style.visibility = 'hidden';
        span.style.whiteSpace = 'pre';
        span.style.display = display;
        span.style.fontFamily = FAMILY;
        span.style.fontSize = `${FONT_SIZE}px`;
        span.style.lineHeight = String(LINE_HEIGHT);
        document.body.appendChild(span);
        const h = span.getBoundingClientRect().height;
        span.remove();
        return h;
      }

      const inlineH = probeHeight('inline'); // 现行实现用的就是 inline（默认 span）
      const inlineBlockH = probeHeight('inline-block');
      const computedH = FONT_SIZE * LINE_HEIGHT; // 真正想 enforce 的高度 15.6

      // ---- #2：canvas 字形墨迹是否越界 ----
      const dpr = window.devicePixelRatio;
      const cellH = Math.round(FONT_SIZE * LINE_HEIGHT); // CSS cell 高 16
      const deviceCellH = Math.round(cellH * dpr);
      const deviceFontSize = FONT_SIZE * dpr;
      const textOffsetY = Math.max(0, Math.round((deviceCellH - deviceFontSize) / 2)); // 现行居中偏移

      const canvas = document.createElement('canvas');
      canvas.width = 40 * dpr;
      canvas.height = deviceCellH;
      const ctx = canvas.getContext('2d');
      ctx.font = `${deviceFontSize}px ${FAMILY}`;

      // 真实字体度量
      const m = ctx.measureText('Mgyjpqf|');
      const metrics = {
        fontBoundingBoxAscent: m.fontBoundingBoxAscent,
        fontBoundingBoxDescent: m.fontBoundingBoxDescent,
        actualBoundingBoxAscent: m.actualBoundingBoxAscent,
        actualBoundingBoxDescent: m.actualBoundingBoxDescent,
      };

      // 复刻现行渲染：清成黑，textBaseline='top'，画含降部的字符
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.textBaseline = 'top';
      ctx.fillStyle = '#fff';
      ctx.fillText('gyjpqf', 0, textOffsetY);

      // 扫描每个设备像素行是否有前景墨迹，找墨迹 top/bottom
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let inkTop = -1;
      let inkBottom = -1;
      for (let row = 0; row < canvas.height; row++) {
        let hasInk = false;
        for (let col = 0; col < canvas.width; col++) {
          if (img[(row * canvas.width + col) * 4] > 40) {
            hasInk = true;
            break;
          }
        }
        if (hasInk) {
          if (inkTop === -1) inkTop = row;
          inkBottom = row;
        }
      }

      return {
        dpr,
        inlineH,
        inlineBlockH,
        computedH,
        cellH,
        deviceCellH,
        deviceFontSize,
        textOffsetY,
        metrics,
        ink: {
          top: inkTop,
          bottom: inkBottom,
          // 墨迹是否在 [0, deviceCellH) 内；bottom>=deviceCellH 即降部溢出被裁
          clippedBottom: inkBottom >= deviceCellH - 1,
          clippedTop: inkTop <= 0,
          overflowBottomPx: inkBottom - (deviceCellH - 1),
        },
      };
    },
    { FONT_SIZE, LINE_HEIGHT }
  );

  await browser.close();
  return { name, ...result };
}

const results = [];
results.push(await gather('chromium', chromium));
results.push(await gather('webkit', webkit));

for (const r of results) {
  console.log(`\n================ ${r.name} (dpr=${r.dpr}) ================`);
  console.log(`#1 probe 高度:`);
  console.log(`   inline span        = ${r.inlineH.toFixed(3)}px  ← 现行实现测量值`);
  console.log(`   inline-block span  = ${r.inlineBlockH.toFixed(3)}px`);
  console.log(`   computed 1.2*13    = ${r.computedH.toFixed(3)}px  ← 真正想 enforce`);
  console.log(`#2 字形墨迹 (device px, deviceCellH=${r.deviceCellH}, textOffsetY=${r.textOffsetY}):`);
  console.log(`   font bbox  ascent=${r.metrics.fontBoundingBoxAscent.toFixed(2)} descent=${r.metrics.fontBoundingBoxDescent.toFixed(2)} (sum=${(r.metrics.fontBoundingBoxAscent + r.metrics.fontBoundingBoxDescent).toFixed(2)})`);
  console.log(`   ink top=${r.ink.top} bottom=${r.ink.bottom}  clippedTop=${r.ink.clippedTop} clippedBottom=${r.ink.clippedBottom} overflowBottom=${r.ink.overflowBottomPx}px`);
}
