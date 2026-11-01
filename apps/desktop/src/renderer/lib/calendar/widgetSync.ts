import type { HostCalendarWidgetCapability } from '../../../shared/hostCalendarWidget';

interface Grant { token: string; expiresAt: string }
/** Session fence for a grant request which may finish after logout or another account's login. */
export class CalendarWidgetSync {
  private identity: string | null | undefined;
  private revision = 0;
  private abort = new AbortController();
  private renewalAt = 0;
  private retryAt = 0;
  private issuing = false;
  private clear = Promise.resolve(true);
  constructor(private readonly capability: HostCalendarWidgetCapability, private readonly issue: (signal: AbortSignal) => Promise<Grant>) {}

  session(identity: string | null): void {
    if (identity === this.identity) return;
    this.identity = identity; this.revision++;
    this.abort.abort(); this.abort = new AbortController();
    this.renewalAt = 0; this.retryAt = 0; this.issuing = false;
    if (!identity) { this.clear = this.capability.clear().catch(() => false); return; }
    // Binding verifies native ownership without destroying the same session's offline cache.
    const revision = this.revision;
    this.clear = this.capability.bind(identity).catch(() => false);
    void this.clear.then(valid => {
      if (revision !== this.revision) return;
      if (valid) { this.renewalAt = Date.now() + 3600_000; this.refresh(); }
      else void this.provision();
    });
  }

  refresh(): void {
    if (!this.identity) return;
    if (Date.now() >= this.renewalAt) void this.provision();
    else {
      const revision = this.revision;
      void this.capability.refresh().catch(() => false).then(valid => {
        if (!valid && revision === this.revision) { this.renewalAt = 0; void this.provision(); }
      });
    }
  }

  private async provision(): Promise<void> {
    if (!this.identity || this.issuing || Date.now() < this.retryAt) return;
    const revision = this.revision, signal = this.abort.signal, identity = this.identity;
    const stale = () => revision !== this.revision || signal.aborted;
    this.issuing = true; this.retryAt = Date.now() + 60_000;
    try {
      await this.clear;
      if (stale()) return;
      await this.capability.bind(identity);
      if (stale()) return;
      const grant = await this.issue(signal);
      if (stale()) return;
      if (await this.capability.configure(grant.token, grant.expiresAt) && revision === this.revision) {
        this.renewalAt = Math.min(Date.now() + 6 * 3600_000, Date.parse(grant.expiresAt) - 3600_000);
      }
    } catch (error) {
      if (revision !== this.revision) return;
      const status = error && typeof error === 'object' && 'status' in error ? error.status : 0;
      if (status === 404) this.retryAt = Number.POSITIVE_INFINITY; // Older server: no foreground retry storm.
      if (status === 401 || status === 403) this.clear = this.capability.clear().catch(() => false);
    } finally { if (revision === this.revision) this.issuing = false; }
  }
}
