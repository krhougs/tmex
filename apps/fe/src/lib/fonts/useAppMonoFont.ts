import { useUIStore } from '@tmex/stores';
import { loadTerminalFonts, resolveFontStack } from '@tmex/theme';
import { useEffect } from 'react';

// 挂在应用根：把选中的等宽字体派生成 --font-mono 写到 :root，全应用所有 font-mono
// 用户（终端、markdown 代码块、code-viewer、侧边栏等）零改动统一跟随；并触发非默认
// 字体的 @font-face 注入与懒加载。字号在此仅用于触发字体文件加载，不影响各处实际字号。
export function useAppMonoFont(): void {
  const fontId = useUIStore((state) => state.terminalFontId);
  const fontSize = useUIStore((state) => state.terminalFontSize);
  const ligatures = useUIStore((state) => state.terminalLigatures);

  useEffect(() => {
    // loadTerminalFonts 在首个 await 前已同步完成 @font-face 注入，
    // 故此处可立即写 --font-mono（family 已可解析），font-display:swap 负责加载完成后的替换。
    void loadTerminalFonts(fontId, fontSize);
    const doc = (globalThis as { document?: Document }).document;
    doc?.documentElement.style.setProperty('--font-mono', resolveFontStack(fontId));
    // DOM 侧等宽文本（markdown 代码块、code-viewer 等）的连字随终端开关统一。
    doc?.documentElement.style.setProperty('--font-mono-ligatures', ligatures ? 'normal' : 'none');
  }, [fontId, fontSize, ligatures]);
}
