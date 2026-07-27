// NotificationSink 的统一 toast 适配器（开源外壳的默认通知出口）

import type { NotificationOptions, NotificationSink } from '@tmex/notifications';
import { toast } from '@tmex/ui/toast';

function toToastOptions(options?: NotificationOptions) {
  if (!options) return undefined;
  return {
    ...(options.description !== undefined ? { description: options.description } : {}),
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
    ...(options.action
      ? { action: { label: options.action.label, onClick: options.action.onClick } }
      : {}),
  };
}

export const sonnerNotificationSink: NotificationSink = {
  info(title, options) {
    toast.info(title, toToastOptions(options));
  },
  success(title, options) {
    toast.success(title, toToastOptions(options));
  },
  warning(title, options) {
    toast.warning(title, toToastOptions(options));
  },
  error(title, options) {
    toast.error(title, toToastOptions(options));
  },
};
