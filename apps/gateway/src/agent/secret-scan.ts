// 凭证检测与消毒（高精度模式）。只匹配高置信度凭证，尽量不误伤普通配置/散文。
// - redactSecrets：把命中片段替换成 [REDACTED:<type>]，用于「机器来源内容」出站 LLM 前消毒。
// - detectSecrets：只检测不改写，用于用户输入消息的泄露告警。

export interface SecretMatch {
  type: string;
}

interface SecretRule {
  type: string;
  regex: RegExp;
  // 用命中的捕获组重建消毒后文本（保留前缀，仅抹掉密值）。
  redact: (groups: string[]) => string;
}

const REDACTED = (type: string) => `[REDACTED:${type}]`;

// 注意：所有 regex 必须带 g 标志；replace 回调里据捕获组重建。
const RULES: SecretRule[] = [
  {
    type: 'private-key',
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    redact: () => REDACTED('private-key'),
  },
  {
    // 含密码的连接串/URL：scheme://user:pass@host —— 仅抹掉 pass
    type: 'url-credential',
    regex: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)([^\s/@]+)@/gi,
    redact: (g) => `${g[1]}${REDACTED('password')}@`,
  },
  {
    type: 'bearer-token',
    regex: /(Authorization:\s*Bearer\s+)([A-Za-z0-9._~+/-]+=*)/gi,
    redact: (g) => `${g[1]}${REDACTED('token')}`,
  },
  {
    // 已知前缀的 API token / access key
    type: 'api-token',
    regex:
      /(?:sk-[A-Za-z0-9_-]{16,}|gh[posru]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|ya29\.[A-Za-z0-9._-]{20,}|AIza[0-9A-Za-z_-]{30,}|glpat-[A-Za-z0-9_-]{18,})/g,
    redact: () => REDACTED('token'),
  },
  {
    // 网络设备带加密类型号的口令：`password 7 <hex>` / `secret 5 <hash>`
    type: 'device-secret',
    regex: /\b(password|secret)\s+([0-9])\s+(\S+)/gi,
    redact: (g) => `${g[1]} ${g[2]} ${REDACTED('device-secret')}`,
  },
  {
    // `enable secret <pass>`（可带类型号）
    type: 'device-secret',
    regex: /\b(enable\s+secret)\s+(?:[0-9]\s+)?(\S+)/gi,
    redact: (g) => `${g[1]} ${REDACTED('device-secret')}`,
  },
  {
    // SNMP community 串
    type: 'device-secret',
    regex: /\b(snmp-server\s+community)\s+(\S+)/gi,
    redact: (g) => `${g[1]} ${REDACTED('device-secret')}`,
  },
];

export function redactSecrets(input: string): { text: string; matches: SecretMatch[] } {
  if (!input) {
    return { text: input, matches: [] };
  }
  let text = input;
  const matches: SecretMatch[] = [];
  for (const rule of RULES) {
    text = text.replace(rule.regex, (...args) => {
      // args = [fullMatch, ...captureGroups, offset, string, (groups?)]
      // 去掉末尾的 offset/string（及可能的 named groups 对象），保留 fullMatch + 捕获组
      const groups = args.filter((arg) => typeof arg === 'string') as string[];
      // 最后一个 string 是整串 input，剔除它
      groups.pop();
      matches.push({ type: rule.type });
      return rule.redact(groups);
    });
  }
  return { text, matches };
}

export function detectSecrets(input: string): SecretMatch[] {
  return redactSecrets(input).matches;
}

export function hasSecret(input: string): boolean {
  return detectSecrets(input).length > 0;
}
