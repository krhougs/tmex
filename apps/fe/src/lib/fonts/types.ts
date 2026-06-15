// 字体 manifest 的类型契约（手写，稳定）。
// 数据由 scripts/fonts/build-fonts.ts 生成到 manifest.generated.ts。

export interface FontManifestEntry {
  /** 主键 / store 中持久化的值 */
  id: string;
  /** 选择器展示名 */
  displayName: string;
  /** @font-face 用的 CSS family 名 */
  cssFamily: string;
  /** 是否随包分发了 woff2 产物 */
  bundled: boolean;
  /** 是否默认字体（沿用静态 @font-face，无需运行时注入） */
  isDefault?: boolean;
  /** woff2 文件 URL（public 下的绝对路径），用于运行时注入 @font-face 懒加载 */
  files?: { regular: string; bold: string };
}
