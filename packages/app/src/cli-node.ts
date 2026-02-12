import { runDoctor } from './commands/doctor';
import { runInit } from './commands/init';
import { runUninstall } from './commands/uninstall';
import { runUpgrade } from './commands/upgrade';
import { normalizeLang, setLang, t } from './i18n';
import { parseArgs } from './lib/args';

function printHelp(): void {
  console.log(t('cli.help'));
}

export async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  const requestedLang =
    (typeof parsed.flags.lang === 'string' ? parsed.flags.lang : undefined) ||
    process.env.TMEX_CLI_LANG;
  setLang(normalizeLang(requestedLang));

  switch (parsed.command) {
    case 'init':
      await runInit(parsed);
      return;
    case 'doctor':
      await runDoctor(parsed);
      return;
    case 'upgrade':
      await runUpgrade(parsed);
      return;
    case 'uninstall':
      await runUninstall(parsed);
      return;
    case '--help':
    case '-h':
    case 'help':
    case undefined:
    case null:
      printHelp();
      return;
    default:
      throw new Error(t('cli.error.unknownCommand', { command: parsed.command }));
  }
}
