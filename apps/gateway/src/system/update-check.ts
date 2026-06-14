import type { UpdateCheckResult } from '@tmex/shared';
import { compareVersions } from './semver';
import { getBaseVersion } from './version';

const REGISTRY_URL = 'https://registry.npmjs.org/tmex-cli';
const changelogCdnUrl = (version: string) =>
  `https://cdn.jsdelivr.net/npm/tmex-cli@${version}/CHANGELOG.md`;

const FETCH_TIMEOUT_MS = 10_000;

interface Packument {
  'dist-tags'?: { latest?: string };
  time?: Record<string, string>;
}

/**
 * 直接查询 npm registry 取 tmex-cli 最新版本，并尽力从 CDN 拉取目标版本的 CHANGELOG.md。
 * registry 与 CDN 均 no-store 强制取新。changelog 拉取失败返回 null（前端回退版本+日期）。
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const current = getBaseVersion();

  const res = await fetch(REGISTRY_URL, {
    cache: 'no-store',
    headers: { accept: 'application/json', 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`npm registry HTTP ${res.status}`);
  }

  const packument = (await res.json()) as Packument;
  const latest = packument['dist-tags']?.latest ?? null;
  const publishedAt = latest ? (packument.time?.[latest] ?? null) : null;
  const hasUpdate =
    latest !== null && current !== 'unknown' && compareVersions(latest, current) > 0;

  const changelog = latest ? await fetchChangelog(latest) : null;

  return {
    currentVersion: current,
    latestVersion: latest,
    hasUpdate,
    changelog,
    publishedAt,
  };
}

async function fetchChangelog(version: string): Promise<string | null> {
  try {
    const res = await fetch(changelogCdnUrl(version), {
      cache: 'no-store',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const text = await res.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
