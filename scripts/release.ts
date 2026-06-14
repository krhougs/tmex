// 发版准备：读取自上次 release 以来的 commit，生成「仅含当前版本」的 CHANGELOG 草稿，并 bump 版本号。
//
// 用法：
//   bun scripts/release.ts <newVersion>                 # 生成 changelog 草稿并把 tmex-cli 版本 bump 到 newVersion
//   bun scripts/release.ts <ver> --from <ref> --to <ref> --no-bump --date <YYYY-MM-DD>
//
// 说明：
//   - 本脚本只产出「commit 原文草稿」（带 DRAFT 标记）；发布前**必须由 agent 改写为面向普通
//     用户的人话**并删除标记，详见 docs/release/2026061406-release-changelog-flow.md。
//   - CHANGELOG 只覆盖当前版本（每次发版重写 packages/app/CHANGELOG.md，随包发布）。
//   - gateway 检查更新时从 CDN 拉目标版本包内的 CHANGELOG.md 展示。
//   - 默认 commit 范围 = 上一条 `chore(release)` 提交 .. HEAD。

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const pkgPath = resolve(repoRoot, 'packages/app/package.json');
const changelogPath = resolve(repoRoot, 'packages/app/CHANGELOG.md');

interface Args {
  version: string;
  from?: string;
  to: string;
  noBump: boolean;
  date?: string;
}

function parseArgs(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  const version = positionals[0];
  if (!version || !/^\d+\.\d+\.\d+(-.+)?$/.test(version)) {
    throw new Error('Invalid or missing version. Usage: bun scripts/release.ts <newVersion>');
  }
  return {
    version,
    from: typeof flags.from === 'string' ? flags.from : undefined,
    to: typeof flags.to === 'string' ? flags.to : 'HEAD',
    noBump: flags['no-bump'] === true,
    date: typeof flags.date === 'string' ? flags.date : undefined,
  };
}

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

function lastReleaseRef(): string | null {
  const out = git(['log', '--grep=^chore(release)', '-n', '1', '--format=%H']).trim();
  return out || null;
}

interface Commit {
  hash: string;
  subject: string;
}

function collectCommits(from: string | undefined, to: string): Commit[] {
  const range = from ? `${from}..${to}` : to;
  // %h（短 hash，无空格）+ 空格 + %s（subject），按首个空格切分，避免控制字符歧义。
  const out = git(['log', range, '--no-merges', '--format=%h %s']);
  const commits: Commit[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(' ');
    if (idx === -1) continue;
    const hash = line.slice(0, idx);
    const subject = line.slice(idx + 1).trim();
    if (!hash || !subject) continue;
    // 排除 release 提交自身
    if (/^chore\(release\)/.test(subject)) continue;
    commits.push({ hash, subject });
  }
  return commits;
}

const TYPE_SECTIONS: Array<{ type: string; title: string }> = [
  { type: 'feat', title: 'Features' },
  { type: 'fix', title: 'Bug Fixes' },
  { type: 'perf', title: 'Performance' },
  { type: 'refactor', title: 'Refactoring' },
  { type: 'docs', title: 'Documentation' },
];
const OTHER_TITLE = 'Other';

// 本脚本生成的是「commit 原文草稿」，发布前必须由 agent 改写为面向普通用户的人话并删除本标记行。
// 标记是 HTML 注释：万一漏改写被发布，前端 markdown 渲染不会展示它（不污染用户视图），
// 但维护者在文件 / npm pack 里仍可见，作为「未完成改写」的护栏。
export const DRAFT_MARKER =
  '<!-- DRAFT：commit 自动生成草稿，发布前必须由 agent 改写为面向普通用户的人话并删除本行（见 docs/release/2026061406-release-changelog-flow.md） -->';

function classifyType(subject: string): string {
  const m = subject.match(/^(\w+)(\([^)]*\))?(!)?:\s*/);
  return m ? m[1].toLowerCase() : 'other';
}

function buildChangelog(version: string, date: string, commits: Commit[]): string {
  const buckets = new Map<string, Commit[]>();
  for (const c of commits) {
    const type = classifyType(c.subject);
    const section = TYPE_SECTIONS.find((s) => s.type === type)?.title ?? OTHER_TITLE;
    if (!buckets.has(section)) buckets.set(section, []);
    buckets.get(section)?.push(c);
  }

  const lines: string[] = [DRAFT_MARKER, '', `# ${version}`, '', `_${date}_`, ''];

  const order = [...TYPE_SECTIONS.map((s) => s.title), OTHER_TITLE];
  let wrote = false;
  for (const title of order) {
    const items = buckets.get(title);
    if (!items || items.length === 0) continue;
    wrote = true;
    lines.push(`## ${title}`, '');
    for (const c of items) {
      lines.push(`- ${c.subject} (\`${c.hash}\`)`);
    }
    lines.push('');
  }

  if (!wrote) {
    lines.push('_No notable changes._', '');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function todayIso(): string {
  // release 脚本在真实开发机运行，Date 可用。
  return new Date().toISOString().slice(0, 10);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const from = args.from ?? lastReleaseRef() ?? undefined;
  const commits = collectCommits(from, args.to);
  const date = args.date ?? todayIso();

  const changelog = buildChangelog(args.version, date, commits);
  writeFileSync(changelogPath, changelog);
  console.log(
    `[release] wrote ${changelogPath} (${commits.length} commits, version ${args.version})`
  );

  if (!args.noBump) {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    const prev = pkg.version;
    pkg.version = args.version;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    console.log(`[release] bumped tmex-cli ${prev} -> ${args.version}`);
  }

  console.log('[release] CHANGELOG.md 当前是 commit 原文草稿（含 DRAFT 标记）。');
  console.log('[release] next steps:');
  console.log(
    '  1) 让 agent 把 packages/app/CHANGELOG.md 改写为面向普通用户的人话，并删除顶部 DRAFT 标记行'
  );
  console.log('     （改写规范见 docs/release/2026061406-release-changelog-flow.md）');
  console.log('  2) review packages/app/CHANGELOG.md（确认无 DRAFT 标记、无 commit 黑话）');
  console.log('  3) bun run build && bun run test:tmex');
  console.log(
    `  4) git commit -am "chore(release): tmex-cli ${args.version}" && bun run publish:tmex`
  );
}

main();
