// Web 工具：web_search（tavily/brave 分发）与 fetch_url（含 SSRF 防护）

import { type Tool, tool } from 'ai';
import { z } from 'zod';
import { decrypt } from '../../crypto';
import { type AgentSettingsRecord, getAgentSettings } from '../../db/agent';
import { wrapUntrusted } from './untrusted';

const WEB_SEARCH_MAX_RESULTS = 8;
const WEB_SEARCH_RESULT_MAX_BYTES = 8 * 1024;
const FETCH_URL_TIMEOUT_MS = 15_000;
const FETCH_URL_MAX_BODY_BYTES = 2 * 1024 * 1024;
const FETCH_URL_TEXT_MAX_BYTES = 16 * 1024;
const FETCH_URL_MAX_REDIRECTS = 3;

export interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

function truncateUtf8(text: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(text).length <= maxBytes) {
    return text;
  }
  let result = text;
  // 二分收敛到字节上限，避免逐字符循环
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  result = text.slice(0, low);
  return `${result}\n[truncated]`;
}

// ========== SSRF 防护 ==========

function normalizeHostname(hostname: string): string {
  let value = hostname.toLowerCase();
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  return value;
}

// 规范 IPv4 八位组：0-255、十进制、无前导零
const CANONICAL_IPV4_OCTET = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function isCanonicalIpv4(host: string): boolean {
  const parts = host.split('.');
  return parts.length === 4 && parts.every((part) => CANONICAL_IPV4_OCTET.test(part));
}

// 数字形式 host（十进制/0x 十六进制/前导零八进制段，1-4 段）：
// 非规范点分四段时是 IPv4 字面量的混淆写法（如 2130706433、127.1、0177.0.0.1、0x7f000001）
function isNumericHost(host: string): boolean {
  const parts = host.split('.');
  if (parts.length === 0 || parts.length > 4) {
    return false;
  }
  return parts.every((part) => /^(0x[0-9a-f]+|\d+)$/.test(part));
}

export function isPrivateHostname(hostname: string): boolean {
  const host = normalizeHostname(hostname);

  if (host === 'localhost' || host.endsWith('.localhost')) {
    return true;
  }

  if (isCanonicalIpv4(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    return false;
  }

  // 非规范数字形式（整数 IP、缺段、八进制/十六进制段）一律拒绝：
  // 正常网站不会用这种 host，放行只会留下绕过私网判断的口子
  if (isNumericHost(host)) {
    return true;
  }

  // IPv6（URL.hostname 对 IPv6 字面量返回带括号形式，已剥除）
  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7（含 fd00::/8）
    if (host.startsWith('fe80:')) return true; // link-local
    if (host.startsWith('::ffff:')) {
      return isPrivateHostname(host.slice('::ffff:'.length));
    }
  }

  return false;
}

function allowPrivateFetch(): boolean {
  return process.env.TMEX_AGENT_ALLOW_PRIVATE_FETCH === '1';
}

export function validateFetchUrl(rawUrl: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: `Invalid URL: ${rawUrl}` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${url.protocol} (only http/https are allowed)` };
  }
  if (!allowPrivateFetch() && isPrivateHostname(url.hostname)) {
    return { error: `Refusing to fetch private/internal address: ${url.hostname}` };
  }
  return { url };
}

// ========== web_search ==========

interface WebSearchDeps {
  fetchImpl?: typeof fetch;
  tavilyEndpoint?: string;
  braveEndpoint?: string;
}

async function searchTavily(
  apiKey: string,
  query: string,
  deps: Required<Pick<WebSearchDeps, 'fetchImpl' | 'tavilyEndpoint'>>
): Promise<WebSearchResultItem[]> {
  const response = await deps.fetchImpl(deps.tavilyEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Tavily 现行 API 使用 Bearer header，旧版接受 body api_key；两者都带以兼容
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: WEB_SEARCH_MAX_RESULTS,
    }),
    signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Tavily search failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  return (payload.results ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.content ?? '',
  }));
}

async function searchBrave(
  apiKey: string,
  query: string,
  deps: Required<Pick<WebSearchDeps, 'fetchImpl' | 'braveEndpoint'>>
): Promise<WebSearchResultItem[]> {
  const url = new URL(deps.braveEndpoint);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(WEB_SEARCH_MAX_RESULTS));
  const response = await deps.fetchImpl(url.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': apiKey,
    },
    signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Brave search failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (payload.web?.results ?? []).map((item) => ({
    title: item.title ?? '',
    url: item.url ?? '',
    snippet: item.description ?? '',
  }));
}

export interface CreateWebSearchToolOptions extends WebSearchDeps {
  settings?: AgentSettingsRecord;
}

/** searchProvider='none' 或未配置对应 key 时返回 null（不注册工具） */
export async function createWebSearchTool(
  options: CreateWebSearchToolOptions = {}
): Promise<Tool | null> {
  const settings = options.settings ?? getAgentSettings();
  const fetchImpl = options.fetchImpl ?? fetch;
  const tavilyEndpoint = options.tavilyEndpoint ?? 'https://api.tavily.com/search';
  const braveEndpoint = options.braveEndpoint ?? 'https://api.search.brave.com/res/v1/web/search';

  let search: ((query: string) => Promise<WebSearchResultItem[]>) | null = null;

  if (settings.searchProvider === 'tavily' && settings.tavilyApiKeyEnc) {
    const apiKey = await decrypt(settings.tavilyApiKeyEnc);
    search = (query) => searchTavily(apiKey, query, { fetchImpl, tavilyEndpoint });
  } else if (settings.searchProvider === 'brave' && settings.braveApiKeyEnc) {
    const apiKey = await decrypt(settings.braveApiKeyEnc);
    search = (query) => searchBrave(apiKey, query, { fetchImpl, braveEndpoint });
  }

  if (!search) {
    return null;
  }

  const searchFn = search;
  return tool({
    description: 'Search the web. Returns a JSON array of results with title, url and snippet.',
    inputSchema: z.object({
      query: z.string().min(1).describe('The search query.'),
    }),
    execute: async ({ query }) => {
      try {
        const results = await searchFn(query);
        return truncateUtf8(JSON.stringify(results), WEB_SEARCH_RESULT_MAX_BYTES);
      } catch (error) {
        return `Web search failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}

// ========== fetch_url ==========

async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) {
    return '';
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
    if (total >= maxBytes) {
      await reader.cancel();
      break;
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const chunk of chunks) {
    const remaining = merged.length - offset;
    if (remaining <= 0) break;
    merged.set(chunk.subarray(0, Math.min(chunk.length, remaining)), offset);
    offset += Math.min(chunk.length, remaining);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

const STRIP_ELEMENT_SELECTORS = [
  'script',
  'style',
  'noscript',
  'template',
  'svg',
  'nav',
  'header',
  'footer',
  'aside',
  'iframe',
];

async function extractHtmlText(html: string): Promise<string> {
  let rewriter = new HTMLRewriter();
  for (const selector of STRIP_ELEMENT_SELECTORS) {
    rewriter = rewriter.on(selector, {
      element(element) {
        element.remove();
      },
    });
  }
  const cleaned = await rewriter.transform(new Response(html)).text();
  return cleaned
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/(?:[ \t]*\n[ \t]*){2,}/g, '\n\n')
    .trim();
}

export interface CreateFetchUrlToolOptions {
  fetchImpl?: typeof fetch;
}

export function createFetchUrlTool(options: CreateFetchUrlToolOptions = {}): Tool {
  const fetchImpl = options.fetchImpl ?? fetch;

  return tool({
    description:
      'Fetch a public http/https URL and return its readable text content (HTML is converted to plain text).',
    inputSchema: z.object({
      url: z.string().min(1).describe('The absolute http/https URL to fetch.'),
    }),
    execute: async ({ url: rawUrl }) => {
      let currentUrl = rawUrl;
      try {
        for (let redirects = 0; redirects <= FETCH_URL_MAX_REDIRECTS; redirects++) {
          const validated = validateFetchUrl(currentUrl);
          if ('error' in validated) {
            return validated.error;
          }

          const response = await fetchImpl(validated.url.toString(), {
            redirect: 'manual',
            signal: AbortSignal.timeout(FETCH_URL_TIMEOUT_MS),
            headers: { Accept: 'text/html,application/xhtml+xml,text/plain,*/*' },
          });

          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) {
              return `Fetch failed: HTTP ${response.status} redirect without Location header`;
            }
            currentUrl = new URL(location, validated.url).toString();
            continue;
          }

          if (!response.ok) {
            return `Fetch failed: HTTP ${response.status}`;
          }

          const contentType = response.headers.get('content-type') ?? '';
          const body = await readBodyWithLimit(response, FETCH_URL_MAX_BODY_BYTES);

          if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
            const text = await extractHtmlText(body);
            return wrapUntrusted(truncateUtf8(text, FETCH_URL_TEXT_MAX_BYTES), 'web');
          }

          return wrapUntrusted(truncateUtf8(body, FETCH_URL_TEXT_MAX_BYTES), 'web');
        }
        return `Fetch failed: too many redirects (>${FETCH_URL_MAX_REDIRECTS})`;
      } catch (error) {
        if (error instanceof DOMException && error.name === 'TimeoutError') {
          return `Fetch failed: timeout after ${FETCH_URL_TIMEOUT_MS}ms`;
        }
        return `Fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  });
}
