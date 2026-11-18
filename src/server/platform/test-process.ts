import * as childProcess from 'node:child_process';
import { promisify } from 'node:util';
import { assertTestProcess, testProcessArgs, testProcessEnv, underTest, UnderTestError } from './under-test.ts';

export type * from 'node:child_process';

function guarded<T extends (...args: never[]) => unknown>(original: T, current: () => T = () => original): T {
  // Fully injected VM modules contain no native ChildProcess constructor.
  if (!childProcess.ChildProcess) return original;
  const invoke = (target: T, args: unknown[]) => {
    if (underTest()) {
      const settings = args.find((value) => value && typeof value === 'object' && !Array.isArray(value)) as
        childProcess.SpawnOptions | undefined;
      args[0] = assertTestProcess(args[0] as string, Array.isArray(args[1]) ? args[1] : [], false, settings?.env);
      if (Array.isArray(args[1])) args[1] = testProcessArgs(args[0] as string, args[1], settings?.env);
      let configured = false;
      for (let index = 1; index < args.length; index++) {
        const option = args[index];
        if (option && typeof option === 'object' && !Array.isArray(option)) {
          const options = option as childProcess.SpawnOptions;
          if (options.shell) throw new UnderTestError('shell command');
          args[index] = { ...options, env: testProcessEnv(args[0] as string, options.env) };
          configured = true;
        }
      }
      if (!configured) {
        const index = Array.isArray(args[1]) ? 2 : 1;
        args.splice(index, 0, { env: testProcessEnv(args[0] as string) });
      }
    }
    return Reflect.apply(target, childProcess, args);
  };
  // Look up runners when called so existing injected test doubles remain visible.
  const wrapper = ((...args: unknown[]) => {
    const runner = current();
    return invoke(runner, args);
  }) as unknown as T;
  const custom = Reflect.get(original, promisify.custom);
  if (typeof custom === 'function')
    Object.defineProperty(wrapper, promisify.custom, {
      value: (...args: unknown[]) => {
        const runner = current();
        if (runner !== original)
          return new Promise((resolve, reject) => {
            invoke(runner, [
              ...args,
              (error: unknown, stdout: string, stderr: string) => (error ? reject(error) : resolve({ stdout, stderr })),
            ]);
          });
        return invoke(custom as T, args);
      },
    });
  return wrapper;
}

export const spawn = guarded(childProcess.spawn, () => childProcess.spawn);
export const spawnSync = guarded(childProcess.spawnSync, () => childProcess.spawnSync);
export const execFile = guarded(childProcess.execFile, () => childProcess.execFile);
export const execFileSync = guarded(childProcess.execFileSync, () => childProcess.execFileSync);
export const fork = childProcess.ChildProcess
  ? new Proxy(childProcess.fork, {
      apply: (target, _this, args: unknown[]) => {
        if (underTest()) {
          const index = Array.isArray(args[1]) ? 2 : 1;
          const settings = (args[index] ?? {}) as childProcess.ForkOptions;
          const execPath = assertTestProcess(settings.execPath ?? process.execPath, [], false, settings.env);
          args[index] = { ...settings, execPath, env: testProcessEnv(execPath, settings.env) };
        }
        return Reflect.apply(target, childProcess, args);
      },
    })
  : childProcess.fork;
