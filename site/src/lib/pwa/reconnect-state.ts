export type ReconnectTrigger = "closed" | "error" | "connect_rejected";

/** Gates reconnect requests for one transport lifecycle and terminal bye state. */
export class ReconnectState {
  private terminal = false;
  private scheduled = false;
  private connectionToken = 0;

  get isTerminal(): boolean {
    return this.terminal;
  }

  beginConnection(): number {
    this.connectionToken += 1;
    this.scheduled = false;
    return this.connectionToken;
  }

  replacementBye(): void {
    this.terminal = false;
  }

  terminalBye(): void {
    this.terminal = true;
    this.scheduled = true;
  }

  userRecover(): void {
    this.terminal = false;
    this.scheduled = false;
  }

  request(trigger: ReconnectTrigger, schedule: (trigger: ReconnectTrigger) => void, token = this.connectionToken): boolean {
    if (token !== this.connectionToken || this.terminal || this.scheduled) return false;
    this.scheduled = true;
    schedule(trigger);
    return true;
  }
}
