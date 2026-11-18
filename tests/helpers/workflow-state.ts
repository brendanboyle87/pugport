import type { Workspace } from '../../src/server/workspace.ts';
import type { Workflow } from '../../src/shared/types.ts';

export function fixtureSignal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Fixture signal timed out')), 60_000);
    resolve = () => {
      clearTimeout(timer);
      done();
    };
  });
  void promise.catch(() => {});
  return { promise, resolve };
}

/** Observe transitions rather than racing disk/process latency against a polling budget. */
export function workflowState(workspace: Workspace, predicate: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let scheduled: NodeJS.Immediate | undefined;
    let finished = false;
    const cleanup = () => {
      finished = true;
      clearImmediate(scheduled);
      clearTimeout(timer);
      workspace.controller.off('state', changed);
      workspace.controller.off('run', changed);
      workspace.controller.off('execution-capacity', changed);
      workspace.controller.off('resources-refreshed', changed);
    };
    const check = () => {
      if (finished) return;
      try {
        if (!predicate()) return;
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    // Observe after the transition's promise continuations, once per notification (never poll).
    const changed = () => {
      if (finished || scheduled) return;
      scheduled = setImmediate(() => {
        scheduled = undefined;
        check();
      });
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Fixture state did not arrive within the hang guard'));
    }, 60_000);
    workspace.controller.on('state', changed);
    workspace.controller.on('run', changed);
    workspace.controller.on('execution-capacity', changed);
    workspace.controller.on('resources-refreshed', changed);
    check();
    changed();
  });
}

/** Drive manual fixture queues on state changes and wait for durable terminal state, with a hang guard. */
export function settledWorkflow(workspace: Workspace, id: string): Promise<Workflow> {
  return new Promise((resolve, reject) => {
    let pumping = false;
    let dirty = false;
    let finished = false;
    const cleanup = () => {
      finished = true;
      clearTimeout(timer);
      workspace.controller.off('state', changed);
      workspace.controller.off('run', changed);
      workspace.controller.off('execution-capacity', changed);
      workspace.controller.off('resources-refreshed', changed);
    };
    const check = () => {
      const workflow = workspace.store.get<Workflow>('workflow', id);
      if (workflow && ['completed', 'blocked', 'cancelled', 'failed', 'interrupted'].includes(workflow.status)) {
        cleanup();
        resolve(workflow);
      }
    };
    const pump = async () => {
      if (pumping || finished) return;
      pumping = true;
      try {
        while (dirty && !finished) {
          dirty = false;
          await workspace.tickQueue();
          check();
        }
      } catch (error) {
        cleanup();
        reject(error);
      } finally {
        pumping = false;
      }
    };
    const changed = () => {
      if (finished) return;
      check();
      dirty = true;
      // A broadcast may happen inside tickQueue; drain again if it arrived during the current evaluation.
      queueMicrotask(() => void pump());
    };
    const timer = setTimeout(() => {
      const workflow = workspace.store.get<Workflow>('workflow', id);
      cleanup();
      reject(new Error(`Fixture workflow did not settle: ${JSON.stringify(workflow)}`));
    }, 60_000);
    workspace.controller.on('state', changed);
    workspace.controller.on('run', changed);
    workspace.controller.on('execution-capacity', changed);
    workspace.controller.on('resources-refreshed', changed);
    changed();
  });
}
