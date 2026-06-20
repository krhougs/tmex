import type { EventType, WebhookEvent } from '@tmex/shared';

/** 通知渠道抽象：EventNotifier 节流后遍历分发给所有已注册渠道，各渠道自行决定是否发送。 */
export interface NotificationChannel {
  readonly id: string;
  notify(eventType: EventType, event: WebhookEvent): Promise<void>;
}
