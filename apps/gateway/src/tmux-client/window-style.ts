// window-style 值会嵌入 set-hook 的命令字符串（含单引号包裹），来源可能是
// 环境变量或客户端消息，只放行 tmux style 语法需要的安全字符，避免穿透 tmux/shell 解析。
const WINDOW_STYLE_PATTERN = /^[A-Za-z0-9#=,]+$/;

export function resolveTmuxWindowStyle(value: string): string | null {
  const style = value.trim();
  if (!style || style.toLowerCase() === 'off') {
    return null;
  }
  if (!WINDOW_STYLE_PATTERN.test(style)) {
    console.warn(`[tmex] ignoring invalid tmux window-style: ${style}`);
    return null;
  }
  return style;
}
