import { createHash } from 'node:crypto';
import { runOutputLimit, runOutputTail } from '../../shared/run-output.ts';

export const codexItemLimit = 4096;
/** Retain only the final output window, with tiny streaming offsets for active messages. */
export class CodexOutput {
  readonly messages = new Map<string, string>();
  readonly activeLengths = new Map<string, number>();
  readonly completedItems = new Set<string>();
  chars = 0;
  private key(id: string) {
    return createHash('sha256').update(id).digest('hex');
  }
  private set(id: string, text: string) {
    this.chars -= this.messages.get(id)?.length ?? 0;
    this.messages.set(id, runOutputTail(text));
    this.chars += this.messages.get(id)!.length;
    while (this.messages.size > codexItemLimit || this.chars + 2 * (this.messages.size - 1) > runOutputLimit) {
      const [first, value] = this.messages.entries().next().value!;
      const excess = this.chars + 2 * (this.messages.size - 1) - runOutputLimit;
      if (this.messages.size <= codexItemLimit && excess < value.length) {
        this.messages.set(first, runOutputTail(value, value.length - excess));
        this.chars -= excess;
      } else {
        this.messages.delete(first);
        this.chars -= value.length;
      }
    }
  }
  delta(id: string, text: string): boolean {
    const key = this.key(id);
    if (this.completedItems.has(key)) return false;
    this.activeLengths.set(key, (this.activeLengths.get(key) ?? 0) + text.length);
    if (this.activeLengths.size > codexItemLimit) this.activeLengths.delete(this.activeLengths.keys().next().value!);
    this.set(key, (this.messages.get(key) ?? '') + text);
    return true;
  }
  complete(id: string, text: string): string {
    const key = this.key(id);
    if (this.completedItems.has(key)) return '';
    const length = this.activeLengths.get(key) ?? 0;
    const previous = this.messages.get(key) ?? '';
    const suffix = text.slice(Math.max(0, length - previous.length), length);
    const delta =
      text.length > length && suffix === previous ? Buffer.from(text.slice(length), 'utf16le').toString('utf16le') : '';
    this.set(key, text);
    this.activeLengths.delete(key);
    this.completedItems.add(key);
    if (this.completedItems.size > codexItemLimit)
      this.completedItems.delete(this.completedItems.values().next().value!);
    return delta;
  }
  output() {
    return [...this.messages.values()].join('\n\n').slice(-runOutputLimit);
  }
}
