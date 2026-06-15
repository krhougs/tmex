// 精选终端字体清单（issue #14）——build-fonts.ts 的真相源。
// 工具会逐个尝试从 Nerd Fonts release 定位 Mono 的 Regular + Bold 两字重，
// 缺 Bold 的自动跳过并计入跳过报告（不在此硬编码跳过清单）。
// 新增字体只需在此追加一项，重跑 `bun run build:fonts`。

export const NERD_FONTS_VERSION = 'v3.4.0';
export const NERD_FONTS_RELEASE_BASE = `https://github.com/ryanoasis/nerd-fonts/releases/download/${NERD_FONTS_VERSION}`;

export interface FontSource {
  /** manifest 主键 / store 中持久化的值 / 产物目录名 */
  id: string;
  /** 选择器展示名（纯文本，无字样预览） */
  displayName: string;
  /** @font-face 用的 CSS family 名（避免与系统同名字体冲突，统一加 Tmex 后缀） */
  cssFamily: string;
  /** Nerd Fonts release 资产名（zip）。useExisting 时忽略 */
  asset?: string;
  /**
   * 压缩包内字体文件名前缀（去空格、忽略大小写后比较）。
   * 工具匹配 `<matchPrefix>NerdFontMono-<Regular|Bold>.{ttf,otf}`。
   * 注意：与 asset 可能不同（如 BlexMono 在 IBMPlexMono.zip 内、文件名前缀仍是 BlexMono）。
   */
  matchPrefix?: string;
  /** 同名多套时，路径需包含这些 token（如 JetBrains 偏好 Ligatures） */
  preferPathTokens?: string[];
  /** 排除路径含这些 token 的文件（如 NoLigatures / Extended / 宽度变体） */
  excludePathTokens?: string[];
  /** 默认字体：沿用仓库已有的扁平 woff2（已静态 @font-face），不下载、不进 generated */
  useExisting?: { regular: string; bold: string };
  /** 是否默认选中 */
  isDefault?: boolean;
}

export const FONTS: FontSource[] = [
  {
    id: 'geist-mono',
    displayName: 'Geist Mono',
    cssFamily: 'GeistMonoTmex',
    isDefault: true,
    useExisting: {
      regular: '/fonts/GeistMonoNerdFontMono-Regular.woff2',
      bold: '/fonts/GeistMonoNerdFontMono-Bold.woff2',
    },
  },
  {
    id: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    cssFamily: 'JetBrainsMonoTmex',
    asset: 'JetBrainsMono.zip',
    matchPrefix: 'JetBrainsMono',
    excludePathTokens: ['NoLigatures'],
  },
  {
    id: 'fira-code',
    displayName: 'Fira Code',
    cssFamily: 'FiraCodeTmex',
    asset: 'FiraCode.zip',
    matchPrefix: 'FiraCode',
  },
  {
    id: 'blex-mono',
    displayName: 'Blex Mono (IBM Plex Mono)',
    cssFamily: 'BlexMonoTmex',
    asset: 'IBMPlexMono.zip',
    matchPrefix: 'BlexMono',
  },
  {
    id: 'noto-sans-mono',
    displayName: 'Noto Sans Mono',
    cssFamily: 'NotoSansMTmex',
    asset: 'Noto.zip',
    matchPrefix: 'NotoSansM',
  },
  {
    id: 'zed-mono',
    displayName: 'Zed Mono',
    cssFamily: 'ZedMonoTmex',
    asset: 'ZedMono.zip',
    matchPrefix: 'ZedMono',
    excludePathTokens: ['Extended'],
  },
  {
    id: 'victor-mono',
    displayName: 'Victor Mono',
    cssFamily: 'VictorMonoTmex',
    asset: 'VictorMono.zip',
    matchPrefix: 'VictorMono',
  },
  // 以下三个上游缺 Bold，工具会自动跳过并报告；保留在清单内以便将来上游补字重时自动纳入。
  {
    id: '3270',
    displayName: '3270',
    cssFamily: 'IbmThreeTwoSevenZeroTmex',
    asset: '3270.zip',
    matchPrefix: '3270',
  },
  {
    id: 'big-blue-term',
    displayName: 'BigBlue Terminal',
    cssFamily: 'BigBlueTermTmex',
    asset: 'BigBlueTerminal.zip',
    matchPrefix: 'BigBlueTerm',
  },
  {
    id: 'departure-mono',
    displayName: 'Departure Mono',
    cssFamily: 'DepartureMonoTmex',
    asset: 'DepartureMono.zip',
    matchPrefix: 'DepartureMono',
  },
];
