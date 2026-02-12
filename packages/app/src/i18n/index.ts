export type CliLang = 'en' | 'zh-CN';

type Vars = Record<string, string | number | boolean | undefined>;

const MESSAGES: Record<CliLang, Record<string, string>> = {
  en: {
    'cli.help': `tmex CLI

Usage:
  tmex init [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false>]
  tmex doctor [--install-dir <path>] [--json]
  tmex upgrade [--version <version>] [--install-dir <path>]
  tmex uninstall [--install-dir <path>] [--yes] [--purge]

Global flags:
  --lang <en|zh-CN>`,

    'cli.error.unknownCommand': 'Unknown command: {{command}}',

    'common.cancelled': 'Cancelled by user.',
    'common.done': 'Done.',

    'errors.args.missingFlag': 'Missing required flag: --{{flag}}',
    'errors.args.invalidFlag': 'Invalid flag value: --{{flag}}={{value}}',

    'errors.validate.invalidPort': 'Invalid port: {{value}}',
    'errors.validate.emptyField': '{{field}} cannot be empty.',

    'errors.version.invalid': 'Invalid version: {{input}}',

    'errors.layout.packageRootNotFound':
      'Unable to locate tmex package root. Please ensure dist artifacts are complete.',
    'errors.layout.runtimeMissing': 'Runtime artifact not found: {{path}}',
    'errors.layout.feMissing': 'Frontend static assets not found: {{path}}',
    'errors.layout.drizzleMissing': 'Gateway migration assets not found: {{path}}',

    'bun.notFound': 'Bun not found. Please install Bun and ensure it is available in PATH.',
    'bun.versionExecFailed': 'Failed to execute bun --version. Please verify Bun installation.',
    'bun.versionTooLow': 'Bun version too low: current {{version}}, required >= {{minVersion}}',
    'bun.checkFailed': 'Bun check failed.',

    'service.install.unsupportedPlatform':
      'Automatic service installation is not supported on this platform: {{platform}}',
    'service.systemd.daemonReloadFailed': 'systemctl daemon-reload failed: {{detail}}',
    'service.systemd.enableFailed': 'systemctl enable failed: {{detail}}',
    'service.systemd.restartFailed': 'systemctl restart failed: {{detail}}',
    'service.systemd.startFailed': 'systemctl start failed: {{detail}}',
    'service.systemd.startRuntimeFailed': 'systemctl start failed: {{detail}}',
    'service.launchd.bootstrapFailed': 'launchctl bootstrap failed: {{detail}}',
    'service.status.none': 'Service manager is not integrated for platform: {{platform}}',
    'service.status.plistMissing': 'launchd plist not found',
    'service.hint.systemd': 'systemctl --user status {{serviceName}}',
    'service.hint.launchd': 'launchctl print gui/$(id -u)/com.tmex.{{serviceName}}',
    'service.hint.none': 'No service manager command on this platform.',

    'init.prompt.installDir': 'Install directory (install-dir)',
    'init.prompt.host': 'Bind host',
    'init.prompt.port': 'Bind port',
    'init.prompt.dbPath': 'Database path (db-path)',
    'init.prompt.autostart': 'Enable autostart',
    'init.prompt.serviceName': 'Service name (service-name)',
    'init.prompt.dirExistsConfirm':
      'Directory {{installDir}} already exists. Continue (will not delete existing config/db)?',
    'init.error.installDirNotEmpty':
      'Install directory is not empty: {{installDir}}. Use --force to overwrite.',
    'init.warning.noServiceManager':
      'Service manager is not supported on platform {{platform}}. Files are deployed but autostart is not configured.',
    'init.done': 'Initialization completed.',
    'init.summary.installDir': 'Install dir',
    'init.summary.serviceName': 'Service name',
    'init.summary.bun': 'Bun',
    'init.summary.autostart': 'Autostart',
    'init.summary.autostart.on': 'on',
    'init.summary.autostart.off': 'off',
    'init.summary.serviceHint': 'Service status command',

    'doctor.platform.supported': 'Platform: {{platform}}',
    'doctor.platform.unsupported':
      'Platform {{platform}} is not officially supported (only macOS and common Linux distros are guaranteed).',
    'doctor.bun.ok': 'Bun installed: {{version}}',
    'doctor.bun.fail': 'Bun check failed: {{reason}}',
    'doctor.tmux.ok': 'tmux installed',
    'doctor.tmux.fail': 'tmux not found (tmex requires tmux).',
    'doctor.ssh.ok': 'ssh installed',
    'doctor.ssh.missing': 'ssh not found; SSH devices will not work.',
    'doctor.installDir.exists': 'Install directory exists: {{installDir}}',
    'doctor.installDir.missing': 'Install directory not found: {{installDir}}',
    'doctor.env.exists': 'Config file found: {{envPath}}',
    'doctor.env.missing': 'Config file not found: {{envPath}}',
    'doctor.env.keyMissing': 'Missing config key: {{key}}',
    'doctor.db.missing': 'Database file not found (may be normal before first start): {{path}}',
    'doctor.db.exists': 'Database file exists: {{path}}',
    'doctor.port.invalid': 'Invalid port in config: {{value}}',
    'doctor.service.notInstalled': 'Service not installed: {{serviceName}}',
    'doctor.service.notRunning': 'Service not running: {{serviceName}}',
    'doctor.service.running': 'Service running: {{serviceName}}',
    'doctor.service.noManager': '{{detail}}',
    'doctor.health.pass': 'Health check OK: {{url}}',
    'doctor.health.fail': 'Health check failed or unreachable: {{url}}',

    'upgrade.delegateFailed': 'Upgrade delegation failed with exit code {{code}}',
    'upgrade.missingMeta': 'Install metadata not found: {{path}}. Please run init first.',
    'upgrade.healthFailed': 'Health check failed: HTTP {{status}}',
    'upgrade.done': 'Upgrade completed.',
    'upgrade.failedRollingBack': 'Upgrade failed; rolling back.',
    'upgrade.summary.targetVersion': 'Target version',
    'upgrade.summary.installDir': 'Install dir',

    'uninstall.prompt.removeService': 'Uninstall system service',
    'uninstall.prompt.removeProgram': 'Remove program files (runtime/resources/run.sh/meta)',
    'uninstall.prompt.removeEnv': 'Remove app.env',
    'uninstall.prompt.removeDatabase': 'Remove database file',
    'uninstall.done': 'Uninstall completed.',
    'uninstall.summary.installDir': 'Install dir',
    'uninstall.summary.serviceName': 'Service name',

    'runtime.restartRequested': 'Restart requested; exiting for service manager restart.',
    'runtime.started': 'Service started on {{url}}',
    'runtime.frontendMissing': 'Frontend assets not found.',
    'runtime.methodNotAllowed': 'Method Not Allowed',
    'runtime.forbidden': 'Forbidden',
  },
  'zh-CN': {
    'cli.help':
      'tmex CLI\n\n用法：\n  tmex init [--no-interactive --install-dir <path> --host <host> --port <port> --db-path <path> --autostart <true|false>]\n  tmex doctor [--install-dir <path>] [--json]\n  tmex upgrade [--version <version>] [--install-dir <path>]\n  tmex uninstall [--install-dir <path>] [--yes] [--purge]\n\n全局参数：\n  --lang <en|zh-CN>',

    'cli.error.unknownCommand': '未知命令：{{command}}',

    'common.cancelled': '已取消。',
    'common.done': '完成。',

    'errors.args.missingFlag': '缺少必要参数：--{{flag}}',
    'errors.args.invalidFlag': '参数值非法：--{{flag}}={{value}}',

    'errors.validate.invalidPort': '非法端口：{{value}}',
    'errors.validate.emptyField': '{{field}} 不能为空。',

    'errors.version.invalid': '非法版本号：{{input}}',

    'errors.layout.packageRootNotFound': '无法定位 tmex 包根目录，请确认 dist 产物完整。',
    'errors.layout.runtimeMissing': '未找到 runtime 产物：{{path}}',
    'errors.layout.feMissing': '未找到前端静态资源：{{path}}',
    'errors.layout.drizzleMissing': '未找到网关迁移资源：{{path}}',

    'bun.notFound': '未检测到 Bun，请先安装 Bun 并确保在 PATH 中可用。',
    'bun.versionExecFailed': '无法执行 bun --version，请检查 Bun 安装是否完整。',
    'bun.versionTooLow': 'Bun 版本过低：当前 {{version}}，要求 >= {{minVersion}}',
    'bun.checkFailed': 'Bun 检查失败。',

    'service.install.unsupportedPlatform': '当前平台不支持自动安装服务：{{platform}}',
    'service.systemd.daemonReloadFailed': 'systemctl daemon-reload 失败：{{detail}}',
    'service.systemd.enableFailed': 'systemctl enable 失败：{{detail}}',
    'service.systemd.restartFailed': 'systemctl restart 失败：{{detail}}',
    'service.systemd.startFailed': 'systemctl start 失败：{{detail}}',
    'service.systemd.startRuntimeFailed': 'systemctl 启动失败：{{detail}}',
    'service.launchd.bootstrapFailed': 'launchctl bootstrap 失败：{{detail}}',
    'service.status.none': '当前平台未集成服务管理：{{platform}}',
    'service.status.plistMissing': 'plist 不存在',
    'service.hint.systemd': 'systemctl --user status {{serviceName}}',
    'service.hint.launchd': 'launchctl print gui/$(id -u)/com.tmex.{{serviceName}}',
    'service.hint.none': '当前平台无服务管理命令',

    'init.prompt.installDir': '安装目录（install-dir）',
    'init.prompt.host': '监听 host',
    'init.prompt.port': '监听端口',
    'init.prompt.dbPath': '数据库路径（db-path）',
    'init.prompt.autostart': '是否启用开机启动',
    'init.prompt.serviceName': '服务名称（service-name）',
    'init.prompt.dirExistsConfirm':
      '目录 {{installDir}} 已存在，是否继续（不会删除现有配置与数据库）？',
    'init.error.installDirNotEmpty': '安装目录已存在且非空：{{installDir}}。如需覆盖请加 --force',
    'init.warning.noServiceManager': '当前平台 {{platform}} 未实现自动服务安装，已完成文件部署。',
    'init.done': '初始化完成。',
    'init.summary.installDir': '安装目录',
    'init.summary.serviceName': '服务名称',
    'init.summary.bun': 'Bun',
    'init.summary.autostart': '自启动',
    'init.summary.autostart.on': '开启',
    'init.summary.autostart.off': '关闭',
    'init.summary.serviceHint': '服务状态命令',

    'doctor.platform.supported': '平台：{{platform}}',
    'doctor.platform.unsupported':
      '当前平台 {{platform}} 非官方支持范围（仅保证 macOS 与常见 Linux 发行版）。',
    'doctor.bun.ok': 'Bun 已安装：{{version}}',
    'doctor.bun.fail': 'Bun 检查失败：{{reason}}',
    'doctor.tmux.ok': 'tmux 已安装',
    'doctor.tmux.fail': '未检测到 tmux（tmex 需要 tmux 才能工作）。',
    'doctor.ssh.ok': 'ssh 已安装',
    'doctor.ssh.missing': '未检测到 ssh，远程设备将不可用。',
    'doctor.installDir.exists': '安装目录存在：{{installDir}}',
    'doctor.installDir.missing': '未发现安装目录：{{installDir}}',
    'doctor.env.exists': '发现配置文件：{{envPath}}',
    'doctor.env.missing': '未发现配置文件：{{envPath}}',
    'doctor.env.keyMissing': '配置缺失：{{key}}',
    'doctor.db.missing': '数据库文件不存在（首次启动前可能正常）：{{path}}',
    'doctor.db.exists': '数据库文件存在：{{path}}',
    'doctor.port.invalid': '配置端口非法：{{value}}',
    'doctor.service.notInstalled': '服务未安装：{{serviceName}}',
    'doctor.service.notRunning': '服务未运行：{{serviceName}}',
    'doctor.service.running': '服务运行中：{{serviceName}}',
    'doctor.service.noManager': '{{detail}}',
    'doctor.health.pass': '健康检查通过：{{url}}',
    'doctor.health.fail': '健康检查失败或不可达：{{url}}',

    'upgrade.delegateFailed': '委托升级失败，退出码 {{code}}',
    'upgrade.missingMeta': '未找到安装元数据：{{path}}，请先执行 init',
    'upgrade.healthFailed': '健康检查失败：HTTP {{status}}',
    'upgrade.done': '升级完成。',
    'upgrade.failedRollingBack': '升级失败，开始回滚。',
    'upgrade.summary.targetVersion': '目标版本',
    'upgrade.summary.installDir': '安装目录',

    'uninstall.prompt.removeService': '是否卸载系统服务',
    'uninstall.prompt.removeProgram': '是否删除程序文件（runtime/resources/run.sh/meta）',
    'uninstall.prompt.removeEnv': '是否删除 app.env',
    'uninstall.prompt.removeDatabase': '是否删除数据库文件',
    'uninstall.done': '卸载完成。',
    'uninstall.summary.installDir': '安装目录',
    'uninstall.summary.serviceName': '服务名称',

    'runtime.restartRequested': '收到重启请求，退出并等待服务管理器拉起。',
    'runtime.started': '服务已启动：{{url}}',
    'runtime.frontendMissing': '未找到前端静态资源。',
    'runtime.methodNotAllowed': '方法不允许',
    'runtime.forbidden': '禁止访问',
  },
};

let currentLang: CliLang = 'en';

export function normalizeLang(input: string | undefined): CliLang {
  if (!input) return 'en';

  const raw = input.trim();
  if (!raw) return 'en';

  const lower = raw.toLowerCase();
  if (lower === 'en' || lower === 'en-us' || lower === 'en_us') return 'en';
  if (lower === 'zh' || lower === 'zh-cn' || lower === 'zh_cn' || lower === 'cn') return 'zh-CN';

  return 'en';
}

export function setLang(lang: CliLang): void {
  currentLang = lang;
}

export function getLang(): CliLang {
  return currentLang;
}

function interpolate(template: string, vars: Vars | undefined): string {
  if (!vars) return template;
  return template.replaceAll(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key];
    return value === undefined ? '' : String(value);
  });
}

export function t(key: string, vars?: Vars): string {
  const table = MESSAGES[currentLang] ?? MESSAGES.en;
  const fallback = MESSAGES.en[key];
  const template = table[key] ?? fallback ?? key;
  return interpolate(template, vars);
}
