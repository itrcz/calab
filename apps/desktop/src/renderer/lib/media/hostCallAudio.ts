import type { HostAudioConnect, HostAudioControls, HostAudioState, HostCallAudioCapability } from '../../../shared/hostCallAudio';

/** One call-scoped transport. A late native callback can never adopt a newer web call. */
export class HostCallAudioSession {
  private closed = false;
  private unsubscribe: () => void;
  private input: HostAudioConnect | null;
  private readonly eventId: string;
  private readonly connectionId: string;
  state: HostAudioState | null = null;
  constructor(private readonly capability: HostCallAudioCapability, input: HostAudioConnect, private readonly changed: (state: HostAudioState) => void) {
    this.input = input;
    this.eventId = input.eventId;
    this.connectionId = input.connectionId;
    this.unsubscribe = capability.subscribe(state => this.receive(state));
  }
  get connected(): boolean { return !this.closed && this.state?.phase === 'connected'; }
  get alive(): boolean { return !this.closed && !['ended', 'failed'].includes(this.state?.phase ?? 'connecting'); }
  private matches(state: HostAudioState): boolean { return !this.closed && state.eventId === this.eventId && state.connectionId === this.connectionId; }
  private receive(state: HostAudioState): void {
    if (!this.matches(state) || (state.phase === 'connected' && state.canSpeak && !state.microphoneReady)) return;
    this.state = state;
    this.changed(state);
  }
  async start(): Promise<void> {
    const input = this.input;
    this.input = null;
    if (!input || this.closed) throw new Error('Native call audio superseded');
    let state: HostAudioState | null;
    try { state = await this.capability.connect(input); }
    catch (error) { this.stop(); throw error; }
    if (!state || !this.matches(state) || state.phase !== 'connected' || (state.canSpeak && !state.microphoneReady)) {
      this.stop();
      throw new Error(`Native call audio unavailable: ${state?.error ?? 'connection'}`);
    }
    this.receive(state);
  }
  control(controls: HostAudioControls): void {
    if (!this.closed) this.capability.control(this.eventId, this.connectionId, controls);
  }
  stop(): void {
    if (this.closed) return;
    this.closed = true;
    this.input = null;
    this.unsubscribe();
    this.capability.disconnect(this.eventId, this.connectionId);
  }
}
