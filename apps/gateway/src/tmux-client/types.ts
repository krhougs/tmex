export interface TmuxRuntime {
  readonly deviceId: string;
  /** runtime 已永久关闭（连接断开或已 shutdown），不可再复用 */
  readonly isTerminated?: boolean;
  shutdown(): Promise<void>;
}

export interface TmuxRuntimeRegistryOptions<TRuntime extends TmuxRuntime> {
  createRuntime: (deviceId: string) => Promise<TRuntime>;
}
