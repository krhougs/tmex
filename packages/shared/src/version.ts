// monorepo 版本展示工具（前后端共享，浏览器安全：无 node 依赖）。
//
// 「monorepo 版本」即发布的 tmex-cli（packages/app）版本，是唯一真相源。
// 非 production 环境追加 _dev 后缀，便于一眼区分开发态与正式发布态。

export function formatDisplayVersion(baseVersion: string, isProd: boolean): string {
  const base = baseVersion?.trim() || 'unknown';
  return isProd ? base : `${base}_dev`;
}
