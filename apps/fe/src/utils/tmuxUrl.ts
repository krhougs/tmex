export function decodePaneIdFromUrlParam(value: string | undefined): string | undefined {
  // React Router 已经对路径参数做过一次 decode。
  // 对 tmux paneId 再次 decode 会把合法的 "%25"、"%251" 误还原成 "%"、"%1"。
  return value;
}

export function encodePaneIdForUrl(value: string): string {
  return encodeURIComponent(value);
}
