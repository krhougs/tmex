export function decodePaneIdFromUrlParam(value: string | undefined): string | undefined {
  if (!value) return value;

  let decoded = value;

  for (let i = 0; i < 2; i++) {
    // 注意：tmux paneId 本身形如 "%149"，其中的 "%14" 不能被当作 URL 编码。
    // 这里只处理“被编码过的百分号”(%25)，用于纠正双重编码场景（%2525xx -> %25xx -> %xx）。
    if (!/%25/i.test(decoded)) {
      return decoded;
    }

    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      return decoded;
    }
  }

  return decoded;
}

export function encodePaneIdForUrl(value: string): string {
  return encodeURIComponent(value);
}
