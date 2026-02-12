export interface ParsedArgs {
  command: string | null;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface InitConfig {
  installDir: string;
  host: string;
  port: number;
  databasePath: string;
  autostart: boolean;
  serviceName: string;
  force: boolean;
  nonInteractive: boolean;
}

export type CheckLevel = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  message: string;
  detail?: string;
}

export interface InstallMeta {
  serviceName: string;
  platform: NodeJS.Platform;
  autostart: boolean;
  installDir: string;
  updatedAt: string;
  cliVersion: string;
}
