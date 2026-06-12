import type {
  AssistRegexRequest,
  AssistRegexResponse,
  CreateWatchRuleRequest,
  ListWatchRulesResponse,
  UpdateWatchRuleRequest,
  WatchRuleDto,
  WatchRuleResponse,
  WatchRuleStateResponse,
} from '@tmex/shared';

export const watchRulesQueryKey = (deviceId: string, paneId: string) =>
  ['watch-rules', deviceId, paneId] as const;

export const watchRuleStateQueryKey = (ruleId: string) => ['watch-rule-state', ruleId] as const;

export async function parseApiError(res: Response, fallback: string): Promise<string> {
  try {
    const payload = (await res.json()) as { error?: string };
    return payload.error ?? fallback;
  } catch {
    return fallback;
  }
}

export async function fetchWatchRules(deviceId: string, paneId: string): Promise<WatchRuleDto[]> {
  const params = new URLSearchParams({ deviceId, paneId });
  const res = await fetch(`/api/watch/rules?${params}`);
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load watch rules'));
  }
  const payload = (await res.json()) as ListWatchRulesResponse;
  return payload.rules;
}

export async function createWatchRule(body: CreateWatchRuleRequest): Promise<WatchRuleResponse> {
  const res = await fetch('/api/watch/rules', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to create watch rule'));
  }
  return (await res.json()) as WatchRuleResponse;
}

export async function updateWatchRule(
  ruleId: string,
  body: UpdateWatchRuleRequest
): Promise<WatchRuleResponse> {
  const res = await fetch(`/api/watch/rules/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to update watch rule'));
  }
  return (await res.json()) as WatchRuleResponse;
}

export async function deleteWatchRule(ruleId: string): Promise<void> {
  const res = await fetch(`/api/watch/rules/${ruleId}`, { method: 'DELETE' });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to delete watch rule'));
  }
}

export async function fetchWatchRuleState(ruleId: string): Promise<WatchRuleStateResponse> {
  const res = await fetch(`/api/watch/rules/${ruleId}/state`);
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to load watch rule state'));
  }
  return (await res.json()) as WatchRuleStateResponse;
}

export async function assistRegex(body: AssistRegexRequest): Promise<AssistRegexResponse> {
  const res = await fetch('/api/watch/assist-regex', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(await parseApiError(res, 'Failed to generate regex'));
  }
  return (await res.json()) as AssistRegexResponse;
}
