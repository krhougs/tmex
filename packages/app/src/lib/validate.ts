import { t } from '../i18n';

export function asString(value: string | boolean | undefined): string | undefined {
  if (typeof value === 'string') return value;
  return undefined;
}

export function asBoolean(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;

  const normalized = value.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'y') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'n') {
    return false;
  }

  return undefined;
}

export function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(t('errors.validate.invalidPort', { value }));
  }
  return port;
}

export function assertNonEmpty(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(t('errors.validate.emptyField', { field: fieldName }));
  }
  return trimmed;
}
