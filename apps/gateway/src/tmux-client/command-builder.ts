export function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function joinShellArgs(argv: readonly string[]): string {
  return argv.map((arg) => quoteShellArg(arg)).join(' ');
}
