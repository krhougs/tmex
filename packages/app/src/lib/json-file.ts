import { readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ensureDir } from './fs-utils';

export async function readJsonFile<T>(path: string): Promise<T> {
  const content = await readFile(path, 'utf8');
  return JSON.parse(content) as T;
}

export async function writeJsonFile(path: string, value: unknown, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode });
}
