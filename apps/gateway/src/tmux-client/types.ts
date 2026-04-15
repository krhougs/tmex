export interface TmuxRuntime {
  readonly deviceId: string;
  shutdown(): Promise<void>;
}

export interface TmuxRuntimeRegistryOptions<TRuntime extends TmuxRuntime> {
  createRuntime: (deviceId: string) => Promise<TRuntime>;
}
