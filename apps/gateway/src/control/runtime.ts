type RestartListener = () => Promise<void> | void;

class RuntimeController {
  private restarting = false;
  private listener: RestartListener | null = null;

  onRestart(listener: RestartListener): void {
    this.listener = listener;
  }

  isRestarting(): boolean {
    return this.restarting;
  }

  async requestRestart(): Promise<void> {
    if (this.restarting) {
      return;
    }

    this.restarting = true;
    await this.listener?.();
  }

  reset(): void {
    this.restarting = false;
    this.listener = null;
  }
}

export const runtimeController = new RuntimeController();
