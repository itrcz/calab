/**
 * The call's «active speaker» for video (the large tile, the camera PiP, «Экономить трафик»):
 * someone becomes active after speaking continuously for `holdMs` (800 ms, ADR-0066 §2), and
 * stays active after they fall silent until someone else qualifies. The current speaker keeps the
 * picture for at least `minMs` (1.5 s): a quick back-and-forth doesn't make the large tile flicker.
 * Short interjections («ага», a cough) don't switch the picture (review M2 / L5).
 */
export const ACTIVE_SPEAKER_HOLD_MS = 800;
/** The active speaker holds the large tile at least this long before someone else takes it. */
export const ACTIVE_SPEAKER_MIN_MS = 1500;

export class ActiveSpeaker {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private current: string | null = null;
  /** When `current` became active (`now()`). */
  private since = 0;

  constructor(
    private readonly onChange: (userId: string | null) => void,
    private readonly holdMs = ACTIVE_SPEAKER_HOLD_MS,
    private readonly minMs = ACTIVE_SPEAKER_MIN_MS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get value(): string | null {
    return this.current;
  }

  /** The debounced speaking map (userId → speaking); missing ids are silent. */
  update(speaking: Readonly<Record<string, boolean>>): void {
    for (const [id, on] of Object.entries(speaking)) {
      if (!on || id === this.current || this.timers.has(id)) continue;
      this.arm(id, this.holdMs);
    }
    for (const [id, timer] of this.timers) {
      if (speaking[id]) continue;
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /**
   * `id` qualifies after `ms` of speech. If the current speaker has not held the picture for
   * `minMs` yet, the switch waits for that — and is cancelled if `id` falls silent meanwhile
   * (`update` clears the re-armed timer).
   */
  private arm(id: string, ms: number): void {
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        if (id === this.current) return;
        const wait = this.current === null ? 0 : this.since + this.minMs - this.now();
        if (wait > 0) {
          this.arm(id, wait);
          return;
        }
        this.current = id;
        this.since = this.now();
        this.onChange(id);
      }, ms),
    );
  }

  /** Someone left the call: they can't stay the active speaker. */
  drop(userId: string): void {
    const timer = this.timers.get(userId);
    if (timer) clearTimeout(timer);
    this.timers.delete(userId);
    if (this.current === userId) {
      this.current = null;
      this.onChange(null);
    }
  }

  reset(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.current = null;
    this.since = 0;
  }
}
