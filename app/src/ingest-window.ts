// The event window of the browser input. The end time lives in an SSM parameter that the operator command
// writes (YYYY-MM-DDTHH:MM:SSZ, UTC). The app reads it at start and polls it, so a new end time takes effect within a
// minute. After the end time the window is closed: no subscribing, and the publisher is removed (onClose).
// An unreadable value at start means closed. A read error later keeps the last value.
const NOT_AFTER_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export function parseNotAfter(v: string | undefined): number | null {
  if (typeof v !== "string" || !NOT_AFTER_RE.test(v)) return null;
  const ms = Date.parse(v);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) + "Z" !== v) return null;
  return ms;
}
export interface WindowLog {
  info(...a: unknown[]): void;
  warn(...a: unknown[]): void;
}
export class PublisherWindow {
  private notAfter: number | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private closedFired = false;
  constructor(
    private readonly read: () => Promise<string | undefined>,
    private readonly onClose: () => void,
    private readonly log: WindowLog,
    private readonly pollMs = 60000,
  ) {}
  isOpen(): boolean {
    return this.notAfter !== null && Date.now() < this.notAfter;
  }
  endsAt(): number | null {
    return this.notAfter;
  }
  async start(): Promise<void> {
    await this.refresh(true);
    this.pollTimer = setInterval(() => void this.refresh(false), this.pollMs);
    this.pollTimer.unref?.();
  }
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.pollTimer = this.closeTimer = null;
  }
  async refresh(initial: boolean): Promise<void> {
    let value: string | undefined;
    try {
      value = await this.read();
    } catch (err) {
      this.log.warn(`[ingest] end time unreadable${initial ? ", ingest stays closed" : ", keeping the last value"}:`, err);
      if (initial) this.arm();
      return;
    }
    const parsed = parseNotAfter(value);
    if (parsed === null) {
      this.log.warn(`[ingest] end time missing or invalid${initial ? ", ingest stays closed" : ", keeping the last value"}`);
      if (initial) this.arm();
      return;
    }
    if (parsed !== this.notAfter) {
      this.notAfter = parsed;
      this.closedFired = false;
      this.log.info(`[ingest] event end time ${new Date(parsed).toISOString()}`);
    }
    this.arm();
  }
  private arm(): void {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.notAfter === null) return;
    const wait = this.notAfter - Date.now();
    if (wait <= 0) {
      this.fireClosed();
      return;
    }
    // setTimeout caps at ~24.8 days; re-arm in slices.
    this.closeTimer = setTimeout(() => this.arm(), Math.min(wait, 2 ** 31 - 1));
    this.closeTimer.unref?.();
  }
  private fireClosed(): void {
    if (this.closedFired) return;
    this.closedFired = true;
    this.log.warn("[ingest] event end time reached: removing the publisher and closing the ingest");
    this.onClose();
  }
}
