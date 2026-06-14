// 轻量 semver 比较，够用即可（支持 X.Y.Z 与可选 -prerelease）。
// gateway 不复用 packages/app 的 semver，避免对 CLI 包形成反向依赖。

interface Parsed {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parse(input: string): Parsed | null {
  const match = input.trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

/** 返回 a-b 的符号：a>b → 1，a<b → -1，相等 → 0；无法解析按 0 处理 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;

  if (pa.major !== pb.major) return pa.major > pb.major ? 1 : -1;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor ? 1 : -1;
  if (pa.patch !== pb.patch) return pa.patch > pb.patch ? 1 : -1;

  // 无 prerelease 的正式版 > 有 prerelease 的预发布版
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return pa.prerelease > pb.prerelease ? 1 : pa.prerelease < pb.prerelease ? -1 : 0;
}
