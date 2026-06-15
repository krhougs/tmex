#!/usr/bin/env bun
/**
 * 字体构建工具（issue #14）
 *
 * 流程：
 *  1. 读 fonts.config.ts（精选清单 + Nerd Fonts 资产）
 *  2. 逐字体从 Nerd Fonts pinned release 下载资产 zip（缓存到 scripts/fonts/.cache）
 *  3. 解压，定位 Mono 的 Regular + Bold 两字重（缺 Bold 即跳过并记录）
 *  4. 用 wawoff2 无损转码成 woff2（不子集、保留全部字形含 Nerd 图标）
 *     → apps/fe/public/fonts/generated/<id>/<id>-{regular,bold}.woff2
 *  5. 扫描成功产物，生成 apps/fe/src/lib/fonts/manifest.generated.ts
 *  6. 打印跳过清单
 *
 * 默认字体 Geist Mono 沿用仓库已有扁平 woff2（已静态 @font-face），不下载、不进 generated。
 *
 * 用法：bun run build:fonts
 * woff2 与 manifest 均入库；日常 build 无需重跑，仅在更新字体清单/版本时手动执行。
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as wawoff2 from 'wawoff2';
import {
  FONTS,
  type FontSource,
  NERD_FONTS_RELEASE_BASE,
  NERD_FONTS_VERSION,
} from './fonts.config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');
const CACHE_DIR = path.join(__dirname, '.cache');
const EXTRACT_DIR = path.join(CACHE_DIR, 'extract');
const PUBLIC_GENERATED_DIR = path.join(ROOT, 'apps/fe/public/fonts/generated');
const MANIFEST_OUT = path.join(ROOT, 'apps/fe/src/lib/fonts/manifest.generated.ts');

interface ManifestEntry {
  id: string;
  displayName: string;
  cssFamily: string;
  bundled: boolean;
  isDefault?: boolean;
  files?: { regular: string; bold: string };
}

interface SkipRecord {
  id: string;
  displayName: string;
  reason: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_-]/g, '');

async function downloadAsset(asset: string): Promise<string> {
  const dest = path.join(CACHE_DIR, asset);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    console.log(`[fonts]   缓存命中 ${asset}`);
    return dest;
  }
  const url = `${NERD_FONTS_RELEASE_BASE}/${asset}`;
  console.log(`[fonts]   下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`下载失败 ${url} -> HTTP ${res.status}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`[fonts]   已存 ${asset}（${(buf.length / 1048576).toFixed(1)} MB）`);
  return dest;
}

function extractAsset(zipPath: string, id: string): string {
  const dest = path.join(EXTRACT_DIR, id);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zipPath, '-d', dest]);
  return dest;
}

/** 在解压目录里找 `<matchPrefix>NerdFontMono-<weight>.{ttf,otf}` 的最佳匹配 */
function findWeightFile(
  extractDir: string,
  font: FontSource,
  weight: 'Regular' | 'Bold'
): string | null {
  const all = fs.readdirSync(extractDir, { recursive: true }) as string[];
  const re = new RegExp(`NerdFontMono-${weight}\\.(ttf|otf)$`, 'i');
  const prefix = norm(font.matchPrefix ?? font.id);

  let cands = all.filter((rel) => {
    const base = path.basename(rel);
    if (!re.test(base)) return false;
    if (!norm(base).startsWith(prefix)) return false;
    const lower = rel.toLowerCase();
    if (font.excludePathTokens?.some((t) => lower.includes(t.toLowerCase()))) return false;
    return true;
  });

  const prefer = font.preferPathTokens;
  if (prefer?.length) {
    const preferred = cands.filter((rel) =>
      prefer.every((t) => rel.toLowerCase().includes(t.toLowerCase()))
    );
    if (preferred.length) cands = preferred;
  }

  cands.sort((a, b) => a.length - b.length);
  return cands.length ? path.join(extractDir, cands[0]) : null;
}

async function transcode(srcTtf: string, outWoff2: string): Promise<void> {
  const input = new Uint8Array(fs.readFileSync(srcTtf));
  const out = await wawoff2.compress(input);
  fs.mkdirSync(path.dirname(outWoff2), { recursive: true });
  fs.writeFileSync(outWoff2, Buffer.from(out));
}

async function processFont(font: FontSource): Promise<ManifestEntry | SkipRecord> {
  console.log(`[fonts] 处理 ${font.displayName} (${font.id})`);

  if (font.useExisting) {
    console.log('[fonts]   使用仓库已有 woff2（默认字体，静态加载）');
    return {
      id: font.id,
      displayName: font.displayName,
      cssFamily: font.cssFamily,
      bundled: true,
      isDefault: font.isDefault,
      files: { regular: font.useExisting.regular, bold: font.useExisting.bold },
    };
  }

  if (!font.asset) {
    return { id: font.id, displayName: font.displayName, reason: '缺少 asset 配置' };
  }

  const zip = await downloadAsset(font.asset);
  const extractDir = extractAsset(zip, font.id);

  const regularSrc = findWeightFile(extractDir, font, 'Regular');
  const boldSrc = findWeightFile(extractDir, font, 'Bold');

  if (!regularSrc) {
    return {
      id: font.id,
      displayName: font.displayName,
      reason: `未在 ${font.asset} 找到 Regular（matchPrefix=${font.matchPrefix}，命名可能不符）`,
    };
  }
  if (!boldSrc) {
    return {
      id: font.id,
      displayName: font.displayName,
      reason: '上游缺 Bold 字重',
    };
  }

  const outDir = path.join(PUBLIC_GENERATED_DIR, font.id);
  const regularOut = path.join(outDir, `${font.id}-regular.woff2`);
  const boldOut = path.join(outDir, `${font.id}-bold.woff2`);

  // wawoff2 是共享 emscripten 单例，串行转码
  console.log(`[fonts]   转码 Regular: ${path.basename(regularSrc)}`);
  await transcode(regularSrc, regularOut);
  console.log(`[fonts]   转码 Bold:    ${path.basename(boldSrc)}`);
  await transcode(boldSrc, boldOut);

  const rSize = (fs.statSync(regularOut).size / 1048576).toFixed(2);
  const bSize = (fs.statSync(boldOut).size / 1048576).toFixed(2);
  console.log(`[fonts]   ✓ ${font.id}: regular ${rSize}MB / bold ${bSize}MB`);

  return {
    id: font.id,
    displayName: font.displayName,
    cssFamily: font.cssFamily,
    bundled: true,
    isDefault: font.isDefault,
    files: {
      regular: `/fonts/generated/${font.id}/${font.id}-regular.woff2`,
      bold: `/fonts/generated/${font.id}/${font.id}-bold.woff2`,
    },
  };
}

function writeManifest(entries: ManifestEntry[]): void {
  const defaultId = entries.find((e) => e.isDefault)?.id ?? entries[0]?.id ?? 'geist-mono';
  const body = entries
    .map((e) => {
      const lines = [
        `    id: ${JSON.stringify(e.id)},`,
        `    displayName: ${JSON.stringify(e.displayName)},`,
        `    cssFamily: ${JSON.stringify(e.cssFamily)},`,
        `    bundled: ${e.bundled},`,
      ];
      if (e.isDefault) lines.push('    isDefault: true,');
      if (e.files) {
        lines.push(
          `    files: { regular: ${JSON.stringify(e.files.regular)}, bold: ${JSON.stringify(e.files.bold)} },`
        );
      }
      return `  {\n${lines.join('\n')}\n  },`;
    })
    .join('\n');

  const content = `// Auto-generated by scripts/fonts/build-fonts.ts
// Do not edit this file directly. Run \`bun run build:fonts\` to regenerate.
// Nerd Fonts ${NERD_FONTS_VERSION}
import type { FontManifestEntry } from './types';

export const FONT_MANIFEST: FontManifestEntry[] = [
${body}
];

export const DEFAULT_FONT_ID = ${JSON.stringify(defaultId)};
`;

  fs.mkdirSync(path.dirname(MANIFEST_OUT), { recursive: true });
  fs.writeFileSync(MANIFEST_OUT, content, 'utf-8');
  console.log(
    `[fonts] 生成 manifest: ${path.relative(ROOT, MANIFEST_OUT)}（${entries.length} 个字体）`
  );
}

async function main() {
  console.log(`[fonts] Nerd Fonts ${NERD_FONTS_VERSION} —— 开始构建`);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(EXTRACT_DIR, { recursive: true });

  const entries: ManifestEntry[] = [];
  const skipped: SkipRecord[] = [];

  for (const font of FONTS) {
    const result = await processFont(font);
    if ('reason' in result) {
      skipped.push(result);
      console.log(`[fonts]   ✗ 跳过 ${font.id}：${result.reason}`);
    } else {
      entries.push(result);
    }
  }

  writeManifest(entries);

  console.log('\n========== 构建结果 ==========');
  console.log(`已处理（${entries.length}）：${entries.map((e) => e.id).join(', ')}`);
  if (skipped.length) {
    console.log(`\n跳过清单（${skipped.length}）：`);
    for (const s of skipped) {
      console.log(`  - ${s.displayName} (${s.id})：${s.reason}`);
    }
  }
  console.log('==============================');
}

main().catch((err) => {
  console.error('[fonts] 构建失败：', err);
  process.exit(1);
});
