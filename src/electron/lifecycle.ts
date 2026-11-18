export type QuitInspection = {
  active: number;
  queued: number;
  waitingApproval: number;
  scheduled: number;
  incognito?: string[];
};
export type QuitState = QuitInspection | 'unknown';

export function isQuitInspection(value: unknown): value is QuitInspection {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return ['active', 'queued', 'waitingApproval', 'scheduled'].every(
    (key) => typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0,
  );
}

export function needsQuitConfirmation(state: QuitState): boolean {
  return (
    state === 'unknown' ||
    state.active + state.queued + state.waitingApproval + state.scheduled > 0 ||
    !!state.incognito?.length
  );
}

/** Scheduled counts contain only future work; queued counts contain work ready to start. */
export function scriptedQuitReason(state: QuitState): string | undefined {
  if (state === 'unknown') return 'task state unknown';
  if (state.active) return 'work is running';
  if (state.queued) return 'work is queued';
  if (state.waitingApproval) return 'work is waiting for approval or confirmation';
  if (state.incognito?.length) return 'an incognito chat is open';
}

export function quitDescription(state: QuitState): string {
  if (state === 'unknown') return '无法确认后台任务状态。退出可能中断正在执行的任务，预约任务在应用关闭时不会运行。';
  const details = [
    state.incognito?.length ? '离开后这个隐身对话会被永久删除' : '',
    state.active ? `正在执行：${state.active}` : '',
    state.waitingApproval ? `等待审批：${state.waitingApproval}` : '',
    state.queued ? `排队或等待资源：${state.queued}` : '',
    state.scheduled ? `未来预约：${state.scheduled}` : '',
  ].filter(Boolean);
  return `${details.join('\n')}\n\n退出将停止当前执行。未开始的任务会保留，应用关闭期间不会运行；已开始的任务下次需检查结果后继续。`;
}

/** One decision at a time. A cancelled decision neither stops the backend nor closes a window. */
export class DesktopQuitController {
  private pending?: Promise<boolean>;
  private exiting = false;
  constructor(
    private readonly actions: {
      inspect: () => Promise<QuitInspection>;
      confirm: (state: QuitState) => Promise<boolean>;
      stop: () => Promise<unknown>;
      exit: (install?: () => void) => void;
      error: (error: unknown) => void;
    },
  ) {}
  get mayCloseWindows() {
    return this.exiting;
  }
  request(force: boolean | 'scripted' = false, install?: () => void): Promise<boolean> {
    if (this.exiting) return Promise.resolve(true);
    if (this.pending) {
      if (force === 'scripted') {
        if (!install) console.warn('PugPort --quit refused: another quit decision is pending.');
        return Promise.resolve(false);
      }
      return this.pending;
    }
    this.pending = this.decide(force, install).finally(() => {
      this.pending = undefined;
    });
    return this.pending;
  }
  private async decide(force: boolean | 'scripted', install?: () => void): Promise<boolean> {
    try {
      const state: QuitState =
        force === true
          ? { active: 0, queued: 0, waitingApproval: 0, scheduled: 0 }
          : await this.actions.inspect().catch(() => 'unknown' as const);
      if (force === 'scripted') {
        const reason = scriptedQuitReason(state);
        if (reason) {
          if (!install) console.warn(`PugPort --quit refused: ${reason}.`);
          return false;
        }
      } else if (needsQuitConfirmation(state) && !(await this.actions.confirm(state))) return false;
      await this.actions.stop();
      this.exiting = true;
      this.actions.exit(install);
      return true;
    } catch (error) {
      if (force === 'scripted')
        console.warn(`PugPort --quit failed: ${error instanceof Error ? error.message : error}`);
      else this.actions.error(error);
      return false;
    }
  }
}
