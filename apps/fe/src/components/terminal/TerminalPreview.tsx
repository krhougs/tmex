import { loadTerminalFonts, resolveFontStack } from '@/lib/fonts';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui';
import { FitAddon, createTerminalController } from 'ghostty-terminal';
import { useEffect, useRef } from 'react';
import { XTERM_THEME_DARK, XTERM_THEME_LIGHT } from './theme';

// 写死的预览内容：~10 行带 ANSI 颜色、含中文/符号/Nerd 图标的代码块，
// 用于整体预览字号、字体、行高效果。\r\n 为终端换行。
// 配色须在深/浅两套 seoul256 主题下都可读。seoul256-dark 的 black/brightBlack 均为
// #000000，故弱化文字不可用 90（bright black）——深色背景上看不见；改用 39（默认前景，
// 主题感知：深色 #d0d0d0 / 浅色 #616161）。同理别用 white/brightWhite 当文字（浅色下不可见）。
const E = '\x1b';
const PREVIEW_ANSI = [
  `${E}[1;32m  feat/terminal-font${E}[0m  ${E}[39m~/projects/tmex${E}[0m`,
  `${E}[39m// 渲染中文与彩色代码块：字号 / 字体 / 行高 实时预览${E}[0m`,
  `${E}[35mexport const${E}[0m ${E}[36mgreeting${E}[0m = ${E}[33m"你好，世界 🌏"${E}[0m;`,
  `${E}[35mfunction${E}[0m ${E}[34mfib${E}[0m(${E}[36mn${E}[0m: ${E}[32mnumber${E}[0m) {`,
  `  ${E}[35mreturn${E}[0m n ${E}[31m<${E}[0m ${E}[33m2${E}[0m ${E}[31m?${E}[0m n ${E}[31m:${E}[0m ${E}[34mfib${E}[0m(n${E}[31m-${E}[0m${E}[33m1${E}[0m) ${E}[31m+${E}[0m ${E}[34mfib${E}[0m(n${E}[31m-${E}[0m${E}[33m2${E}[0m);`,
  '}',
  `${E}[32m+ 新增${E}[0m  ${E}[31m- 删除${E}[0m  ${E}[33m~ 修改${E}[0m   ${E}[36m通过测试 ✓${E}[0m`,
  `${E}[1;34m dir/${E}[0m  ${E}[32m file.ts${E}[0m  ${E}[33m README.md${E}[0m  ${E}[35m config${E}[0m`,
  `${E}[39m$${E}[0m bun run ${E}[36mbuild:fonts${E}[0m  ${E}[32m✓${E}[0m  ${E}[39m14MB${E}[0m`,
  `${E}[7m NORMAL ${E}[0m ${E}[39m UTF-8  LF  TypeScript${E}[0m`,
].join('\r\n');

export function TerminalPreview({ className }: { className?: string }) {
  const fontId = useUIStore((state) => state.terminalFontId);
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const lineHeight = useUIStore((state) => state.terminalLineHeight);
  const theme = useUIStore((state) => state.theme);

  const mountRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    let cancelled = false;
    let term: Awaited<ReturnType<typeof createTerminalController>> | null = null;

    void (async () => {
      await loadTerminalFonts(fontId, fontSize);
      const mount = mountRef.current;
      if (cancelled || !mount) {
        return;
      }
      term = await createTerminalController({
        fontFamily: resolveFontStack(fontId),
        fontSize,
        lineHeight,
        scrollback: 100,
        theme: theme === 'light' ? XTERM_THEME_LIGHT : XTERM_THEME_DARK,
        disableStdin: true,
      });
      if (cancelled) {
        term.dispose();
        return;
      }
      term.open(mount);
      const fit = new FitAddon();
      term.loadAddon(fit);
      fitRef.current = fit;
      fit.fit();
      term.write(PREVIEW_ANSI);
    })();

    return () => {
      cancelled = true;
      fitRef.current = null;
      term?.dispose();
    };
  }, [fontId, fontSize, lineHeight, theme]);

  // 容器宽度变化时重新 fit（不重建控制器）
  useEffect(() => {
    const el = mountRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver(() => fitRef.current?.fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 固定约 12 行高度，保证 10 行内容在任意字号下完整可见
  const heightPx = Math.ceil(fontSize * lineHeight * 12);

  return (
    <div
      className={cn('relative w-full overflow-hidden rounded-md border', className)}
      style={{
        height: `${heightPx}px`,
        backgroundColor:
          theme === 'light' ? XTERM_THEME_LIGHT.background : XTERM_THEME_DARK.background,
      }}
    >
      <div ref={mountRef} className="absolute inset-0" />
    </div>
  );
}
