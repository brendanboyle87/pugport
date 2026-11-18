export interface MediaWorkPriority<T> {
  /** Higher finite scores win; direction breaks ties. This callback must not perform I/O. */
  score?: (value: T, index: number) => number;
  /** Nearby pending candidates considered even without a cached source. Defaults to 128, maximum 1024. */
  lookahead?: number;
  /** Adds globally pending candidates sharing these cached sources to the bounded score window. */
  preferredSources?: Iterable<string>;
}

/** Synchronous claims on one event loop: asynchronous decoders cannot claim the same pair twice. */
export class MediaWorkQueue<T> {
  private front = 0;
  private back: number;
  private readonly pending = new Set<number>();
  private readonly active = new Set<number>();
  private readonly returned = new Set<number>();
  private readonly sourceCandidates = new Map<string, Set<number>>();
  private readonly itemSources: string[][] = [];
  readonly length: number;

  constructor(
    private readonly items: readonly T[],
    sources?: (value: T) => readonly string[],
  ) {
    this.back = items.length - 1;
    this.length = items.length;
    for (const [index, item] of items.entries()) {
      this.pending.add(index);
      const keys = sources ? [...new Set(sources(item))] : [];
      this.itemSources[index] = keys;
      for (const key of keys) {
        const candidates = this.sourceCandidates.get(key) ?? new Set<number>();
        candidates.add(index);
        this.sourceCandidates.set(key, candidates);
      }
    }
  }

  get remaining() {
    return this.pending.size + this.returned.size;
  }

  claim(direction: 'front' | 'back', priority?: MediaWorkPriority<T>): { index: number; value: T } | undefined {
    let index: number;
    if (this.returned.size) {
      index = direction === 'front' ? Math.min(...this.returned) : Math.max(...this.returned);
      this.returned.delete(index);
    } else {
      while (this.front <= this.back && !this.pending.has(this.front)) this.front++;
      while (this.front <= this.back && !this.pending.has(this.back)) this.back--;
      if (this.front > this.back) return undefined;
      index = direction === 'front' ? this.front : this.back;
      if (priority) index = this.prioritize(direction, index, priority);
      this.pending.delete(index);
      for (const source of this.itemSources[index]!) {
        const candidates = this.sourceCandidates.get(source)!;
        candidates.delete(index);
        if (!candidates.size) this.sourceCandidates.delete(source);
      }
    }
    this.active.add(index);
    return { index, value: this.items[index]! };
  }

  private prioritize(direction: 'front' | 'back', fallback: number, priority: MediaWorkPriority<T>): number {
    const lookahead = priority.lookahead ?? 128;
    if (!Number.isInteger(lookahead) || lookahead < 1 || lookahead > 1024)
      throw new Error('Media priority lookahead must be an integer from 1 to 1024.');
    const candidates = new Set<number>();
    const step = direction === 'front' ? 1 : -1;
    for (let index = fallback; index >= this.front && index <= this.back && candidates.size < lookahead; index += step)
      if (this.pending.has(index)) candidates.add(index);
    const preferred = new Set<string>();
    for (const source of priority.preferredSources ?? []) {
      if (preferred.size >= 256) break;
      preferred.add(source);
      const matches = this.sourceCandidates.get(source);
      if (!matches) continue;
      const indexes = direction === 'front' ? matches : [...matches].reverse();
      for (const index of indexes) {
        if (candidates.size >= 1024) break;
        candidates.add(index);
      }
      if (candidates.size >= 1024) break;
    }
    let chosen = fallback;
    let best = -Infinity;
    for (const index of candidates) {
      const value = priority.score
        ? priority.score(this.items[index]!, index)
        : this.itemSources[index]!.some((source) => preferred.has(source))
          ? 1
          : 0;
      const score = Number.isFinite(value) ? value : 0;
      if (score > best || (score === best && (direction === 'front' ? index < chosen : index > chosen))) {
        best = score;
        chosen = index;
      }
    }
    return chosen;
  }

  complete(index: number): void {
    if (!this.active.delete(index)) throw new Error('Media pair is not claimed.');
  }

  /** An interrupted verifier returns only its own unfinished claim to the shared queue. */
  release(index: number): void {
    if (!this.active.delete(index)) throw new Error('Media pair is not claimed.');
    this.returned.add(index);
  }
}
