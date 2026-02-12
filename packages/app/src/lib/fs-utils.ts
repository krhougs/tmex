import { constants } from 'node:fs';
import { access, cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export async function copyDirectory(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, force: true });
}

export async function writeText(path: string, content: string, mode?: number): Promise<void> {
  await ensureDir(dirname(path));
  await writeFile(path, content, {
    encoding: 'utf8',
    mode,
  });
}

export async function readText(path: string): Promise<string> {
  return await readFile(path, 'utf8');
}

export function resolvePath(...parts: string[]): string {
  return resolve(...parts);
}
