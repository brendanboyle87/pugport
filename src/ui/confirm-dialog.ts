import type { Confirmation } from '../shared/confirmation';

type Request = { id: number; options: Confirmation; finish: (answer: boolean) => void };
const queue: Request[] = [];
const listeners = new Set<() => void>();
let sequence = 0;
const changed = () => listeners.forEach((listener) => listener());

/** One question at a time, including questions arriving from the desktop shell. */
export function confirmDialog(options: Confirmation): Promise<boolean> {
  return new Promise((finish) => {
    queue.push({ id: ++sequence, options, finish });
    changed();
  });
}

export const confirmationStore = {
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => void listeners.delete(listener);
  },
  snapshot: () => queue[0],
  resolve(id: number, answer: boolean) {
    if (queue[0]?.id !== id) return;
    queue.shift()!.finish(answer);
    changed();
  },
};
