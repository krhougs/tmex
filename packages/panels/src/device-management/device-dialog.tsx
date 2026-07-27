// 设备增改对话框：local/ssh 表单（四种 authMode）、校验与提交，成功后按注入的 queryKey 失效缓存。

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createDevice as createDeviceApi, updateDevice as updateDeviceApi } from '@tmex/api-client';
import type { CreateDeviceRequest, Device, UpdateDeviceRequest } from '@tmex/shared';
import { useRuntime } from '@tmex/stores/react';
import { Button } from '@tmex/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@tmex/ui/dialog';
import { Input } from '@tmex/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@tmex/ui/select';
import { Textarea } from '@tmex/ui/textarea';
import { type FormEvent, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@tmex/ui/toast';
import {
  type DeviceFormValues,
  buildCreatePayload,
  buildUpdatePayload,
  createDefaultFormValues,
  isValidSshPort,
  validateDeviceForm,
} from './device-form';

export interface DeviceDialogProps {
  mode: 'create' | 'edit';
  device?: Device;
  onClose: () => void;
  queryKey: readonly unknown[];
}

export function DeviceDialog({ mode, device, onClose, queryKey }: DeviceDialogProps) {
  const { t } = useTranslation();
  const runtime = useRuntime();
  const queryClient = useQueryClient();
  const [formData, setFormData] = useState<DeviceFormValues>(createDefaultFormValues(device));
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attempted, setAttempted] = useState(false);

  const isEditMode = mode === 'edit';
  const isSSH = formData.type === 'ssh';

  const createDevice = useMutation({
    mutationFn: (payload: CreateDeviceRequest) =>
      createDeviceApi(payload, t('device.createFailed'), runtime.apiClient),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(t('common.success'));
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const updateDevice = useMutation({
    mutationFn: async (payload: UpdateDeviceRequest) => {
      if (!device) {
        throw new Error(t('apiError.deviceNotFound'));
      }

      return updateDeviceApi(device.id, payload, t('device.updateFailed'), runtime.apiClient);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(t('common.success'));
      onClose();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : t('common.error'));
    },
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);

    const validationError = validateDeviceForm(formData);
    if (validationError) {
      toast.error(t(validationError));
      return;
    }

    setIsSubmitting(true);

    try {
      if (mode === 'create') {
        await createDevice.mutateAsync(buildCreatePayload(formData));
      } else {
        await updateDevice.mutateAsync(buildUpdatePayload(formData));
      }
    } catch {
      // handled by mutation onError
    } finally {
      setIsSubmitting(false);
    }
  };

  const deviceNameInputId = `${mode}-device-name`;
  const deviceTypeSelectId = `${mode}-device-type`;
  const sshHostInputId = `${mode}-device-host`;
  const sshPortInputId = `${mode}-device-port`;
  const sshUsernameInputId = `${mode}-device-username`;
  const sessionInputId = `${mode}-device-session`;
  const defaultWorkingDirInputId = `${mode}-device-default-working-dir`;
  const authModeSelectId = `${mode}-device-auth-mode`;
  const passwordInputId = `${mode}-device-password`;
  const privateKeyTextareaId = `${mode}-device-private-key`;
  const privateKeyPassphraseInputId = `${mode}-device-private-key-passphrase`;

  const typeLabels: Record<string, string> = {
    local: t('device.typeLocal'),
    ssh: t('device.typeSSH'),
  };
  const authLabels: Record<string, string> = {
    password: t('device.authPassword'),
    key: t('device.authKey'),
    agent: t('device.authAgent'),
    configRef: t('device.authConfigRef'),
  };

  const sectionHeading = (text: string) => (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
      {text}
    </div>
  );

  const fieldLabel = (htmlFor: string, text: string, required?: boolean) => (
    <label className="block text-xs font-medium text-foreground" htmlFor={htmlFor}>
      {text}
      {required && <span className="ml-0.5 text-destructive">*</span>}
    </label>
  );

  return (
    <Dialog open={true} onOpenChange={(open) => !open && onClose()}>
      <DialogContent data-testid="device-dialog" className="w-full max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isEditMode ? t('device.editDevice') : t('device.addDevice')}</DialogTitle>
          <DialogDescription>
            {isEditMode ? t('device.editDeviceDescription') : t('device.addDeviceDescription')}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="-mr-2 max-h-[min(70dvh,720px)] space-y-5 overflow-y-auto pr-2">
            <section className="space-y-2.5">
              {sectionHeading(t('device.sectionBasic'))}
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5 sm:col-span-2">
                  {fieldLabel(deviceNameInputId, t('device.name'), true)}
                  <Input
                    id={deviceNameInputId}
                    data-testid="device-name-input"
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t('device.namePlaceholder')}
                    required
                  />
                </div>

                <div className="space-y-1.5">
                  {fieldLabel(deviceTypeSelectId, t('device.type'))}
                  <Select
                    value={formData.type}
                    onValueChange={(nextValue) => {
                      if (!nextValue) return;
                      const nextType = nextValue as 'local' | 'ssh';
                      setFormData((d) => ({
                        ...d,
                        type: nextType,
                        authMode:
                          nextType === 'local'
                            ? 'auto'
                            : d.authMode === 'auto'
                              ? 'agent'
                              : d.authMode,
                      }));
                    }}
                    disabled={isEditMode}
                  >
                    <SelectTrigger
                      id={deviceTypeSelectId}
                      data-testid="device-type-select"
                      className="w-full"
                    >
                      <SelectValue placeholder={t('device.type')}>
                        {(value) => typeLabels[value as string] ?? ''}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="local">{t('device.typeLocal')}</SelectItem>
                      <SelectItem value="ssh">{t('device.typeSSH')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  {fieldLabel(sessionInputId, t('device.session'))}
                  <Input
                    id={sessionInputId}
                    data-testid="device-session-input"
                    type="text"
                    value={formData.session}
                    onChange={(e) => setFormData((d) => ({ ...d, session: e.target.value }))}
                    placeholder={t('device.sessionPlaceholder')}
                  />
                </div>

                <div className="space-y-1.5 sm:col-span-2">
                  {fieldLabel(defaultWorkingDirInputId, t('device.defaultWorkingDir'))}
                  <Input
                    id={defaultWorkingDirInputId}
                    data-testid="device-default-working-dir-input"
                    type="text"
                    value={formData.defaultWorkingDir}
                    onChange={(e) =>
                      setFormData((d) => ({ ...d, defaultWorkingDir: e.target.value }))
                    }
                    placeholder={t('device.defaultWorkingDirPlaceholder')}
                  />
                </div>
              </div>
            </section>

            {isSSH && (
              <>
                <section className="space-y-2.5">
                  {sectionHeading(t('device.sectionConnection'))}
                  <div className="grid gap-3 sm:grid-cols-3">
                    <div className="space-y-1.5 sm:col-span-2">
                      {fieldLabel(sshHostInputId, t('device.host'), true)}
                      <Input
                        id={sshHostInputId}
                        type="text"
                        value={formData.host}
                        onChange={(e) => setFormData((d) => ({ ...d, host: e.target.value }))}
                        placeholder={t('device.hostPlaceholder')}
                        aria-invalid={attempted && !formData.host.trim()}
                      />
                    </div>

                    <div className="space-y-1.5">
                      {fieldLabel(sshPortInputId, t('device.port'), true)}
                      <Input
                        id={sshPortInputId}
                        type="number"
                        value={Number.isNaN(formData.port) ? '' : formData.port}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setFormData((d) => ({
                            ...d,
                            port: raw === '' ? Number.NaN : Number.parseInt(raw, 10),
                          }));
                        }}
                        min={1}
                        max={65535}
                        aria-invalid={attempted && !isValidSshPort(formData.port)}
                      />
                    </div>

                    <div className="space-y-1.5 sm:col-span-2">
                      {fieldLabel(sshUsernameInputId, t('device.username'), true)}
                      <Input
                        id={sshUsernameInputId}
                        type="text"
                        value={formData.username}
                        onChange={(e) => setFormData((d) => ({ ...d, username: e.target.value }))}
                        placeholder={t('device.usernamePlaceholder')}
                        aria-invalid={attempted && !formData.username.trim()}
                      />
                    </div>
                  </div>
                </section>

                <section className="space-y-2.5">
                  {sectionHeading(t('device.sectionAuth'))}
                  <div className="space-y-3">
                    <div className="space-y-1.5">
                      {fieldLabel(authModeSelectId, t('device.authMode'))}
                      <Select
                        value={formData.authMode}
                        onValueChange={(nextValue) => {
                          if (!nextValue) return;
                          setFormData((d) => ({
                            ...d,
                            authMode: nextValue as CreateDeviceRequest['authMode'],
                          }));
                        }}
                      >
                        <SelectTrigger
                          id={authModeSelectId}
                          data-testid="device-auth-mode-select"
                          className="w-full"
                        >
                          <SelectValue placeholder={t('device.authMode')}>
                            {(value) => authLabels[value as string] ?? ''}
                          </SelectValue>
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="password">{t('device.authPassword')}</SelectItem>
                          <SelectItem value="key">{t('device.authKey')}</SelectItem>
                          <SelectItem value="agent">{t('device.authAgent')}</SelectItem>
                          <SelectItem value="configRef">{t('device.authConfigRef')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {formData.authMode === 'password' && (
                      <div className="space-y-1.5">
                        {fieldLabel(passwordInputId, t('device.password'))}
                        <Input
                          id={passwordInputId}
                          type="password"
                          value={formData.password}
                          onChange={(e) => setFormData((d) => ({ ...d, password: e.target.value }))}
                        />
                      </div>
                    )}

                    {formData.authMode === 'key' && (
                      <>
                        <div className="space-y-1.5">
                          {fieldLabel(privateKeyTextareaId, t('device.privateKey'))}
                          <Textarea
                            id={privateKeyTextareaId}
                            value={formData.privateKey}
                            onChange={(e) =>
                              setFormData((d) => ({ ...d, privateKey: e.target.value }))
                            }
                            className="h-28 font-mono text-xs"
                            placeholder={t('device.privateKeyPlaceholder')}
                          />
                        </div>
                        <div className="space-y-1.5">
                          {fieldLabel(privateKeyPassphraseInputId, t('device.passphrase'))}
                          <Input
                            id={privateKeyPassphraseInputId}
                            type="password"
                            value={formData.privateKeyPassphrase}
                            onChange={(e) =>
                              setFormData((d) => ({
                                ...d,
                                privateKeyPassphrase: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </>
                    )}

                    {formData.authMode === 'configRef' && (
                      <div className="space-y-1.5">
                        {fieldLabel(
                          `${mode}-device-ssh-config-ref`,
                          t('device.authConfigRef'),
                          true
                        )}
                        <Input
                          id={`${mode}-device-ssh-config-ref`}
                          data-testid="device-ssh-config-ref-input"
                          type="text"
                          value={formData.sshConfigRef}
                          onChange={(e) =>
                            setFormData((d) => ({ ...d, sshConfigRef: e.target.value }))
                          }
                          placeholder={t('device.sshConfigRefPlaceholder')}
                          aria-invalid={attempted && !formData.sshConfigRef.trim()}
                        />
                        <p className="text-[11px] text-muted-foreground">
                          {t('device.sshConfigRefHint')}
                        </p>
                      </div>
                    )}
                  </div>
                </section>
              </>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="default"
              data-testid="device-dialog-save"
              disabled={isSubmitting}
            >
              {isSubmitting ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
