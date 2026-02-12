import { join } from 'node:path';
import { readJsonFile } from './json-file';

interface PackageJson {
  version?: string;
}

export async function readPackageVersion(packageRoot: string): Promise<string> {
  const pkg = await readJsonFile<PackageJson>(join(packageRoot, 'package.json'));
  return pkg.version || '0.0.0';
}
