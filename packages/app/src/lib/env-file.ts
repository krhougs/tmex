import { readFile, writeFile } from 'node:fs/promises';

export function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex <= 0) continue;

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();
    result[key] = value;
  }

  return result;
}

export function stringifyEnv(values: Record<string, string>): string {
  const lines = Object.keys(values)
    .sort((left, right) => left.localeCompare(right))
    .map((key) => `${key}=${values[key]}`);

  return `${lines.join('\n')}\n`;
}

export async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  const content = await readFile(filePath, 'utf8');
  return parseEnvContent(content);
}

export async function writeEnvFile(
  filePath: string,
  values: Record<string, string>
): Promise<void> {
  await writeFile(filePath, stringifyEnv(values), { encoding: 'utf8', mode: 0o600 });
}
