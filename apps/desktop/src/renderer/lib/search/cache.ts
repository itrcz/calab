/**
 * A small LRU of search answers (ADR-0062 §4: the last 20 requests for 60 s): typing back a
 * query, reopening ⌘K or switching panel tabs is answered at once, without a request.
 */
export class SearchCache<V> {
  private readonly map = new Map<string, { at: number; value: V }>();

  constructor(
    private readonly max = 20,
    private readonly ttlMs = 60_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The fresh value (refreshing its recency), or undefined; expired entries are dropped. */
  get(key: string): V | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (this.now() - e.at >= this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, e);
    return e.value;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, { at: this.now(), value });
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}
