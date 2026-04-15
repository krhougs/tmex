import type { TmuxEventType } from '@tmex/shared';

export interface TmuxEvent {
  type: TmuxEventType;
  data: unknown;
}
