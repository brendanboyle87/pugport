import { useEffect, useRef, useState } from 'react';
import type { DeviceView } from '../shared/devices';
import type { InstaboxMachineView, RemoteServerView, RemoteServersView } from '../shared/remote-servers';
import type { Api } from './Workspace';
import { withNames } from './i18n';
import { wakeInstabox } from './instabox';

type Stage = 'preflight' | 'bundle' | 'runtime' | 'dependencies' | 'service' | 'pairing' | 'done';
export type Enrollment = {
  id: string;
  server?: string;
  stage: Stage;
  status: 'running' | 'completed' | 'failed' | 'needs-command';
  log: string;
  command?: string;
  device?: DeviceView;
};
const stages: { id: Stage; label: string }[] = [
  { id: 'preflight', label: '检查服务器' },
  { id: 'bundle', label: '传送 PugPort' },
  { id: 'runtime', label: '安装运行环境' },
  { id: 'dependencies', label: '安装依赖' },
  { id: 'service', label: '启动服务' },
  { id: 'pairing', label: '配对设备' },
  { id: 'done', label: '完成' },
];

export function EnrollmentStatus({ job, disabled }: { job?: Enrollment; disabled?: boolean }) {
  if (disabled) return <p className="remote-server-reason">已断开，不会自动接入</p>;
  if (!job || job.status === 'completed') return null;
  if (job.status === 'running')
    return (
      <p className="remote-server-reason" role="status">
        {stages.find((stage) => stage.id === job.stage)?.label}…
      </p>
    );
  return (
    <p className="inline-error" role="alert">
      {job.status === 'needs-command' ? '请先在服务器运行这条命令，然后重新检查。' : job.log.trim().split('\n').at(-1)}
    </p>
  );
}
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : '操作没有完成，请重试。');

export function ServerEnroll({
  api,
  server,
  machine,
  onClose,
}: {
  api: Api;
  server: RemoteServerView;
  machine?: InstaboxMachineView;
  onClose: (device?: DeviceView) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [job, setJob] = useState<Enrollment>();
  const [device, setDevice] = useState<DeviceView>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const acting = useRef(false);
  const alive = useRef(true);
  const [sshAdded, setSshAdded] = useState(false);
  const started = useRef(false);
  const [label, setLabel] = useState('');
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => {
      dialog.current?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await api<{ enrollment: Enrollment }>(
          `/api/remote-servers/enrollments/${encodeURIComponent(job.id)}`,
          undefined,
          'GET',
        );
        if (!live) return;
        setJob(value.enrollment);
        if (value.enrollment.device) setDevice(value.enrollment.device);
      } catch (reason) {
        if (live) setError(errorMessage(reason));
      }
      if (live) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [api, job?.id, job?.status]);
  const start = async () => {
    if (acting.current) return;
    acting.current = true;
    setBusy(true);
    setError('');
    try {
      if (machine) {
        if (!alive.current) return;
        await api<RemoteServersView>('/api/remote-servers/instabox/ssh', { machineId: machine.machineId }, 'POST');
        if (!alive.current) return;
        setSshAdded(true);
        setLabel(withNames('正在唤醒 {0}…', [machine.name]));
        await wakeInstabox(api, machine);
        if (!alive.current) return;
      }
      const result = await api<{ enrollment: Enrollment }>(
        '/api/remote-servers/enrollments',
        machine ? { machineId: machine.machineId } : { name: server.name },
        'POST',
      );
      setJob(result.enrollment);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      acting.current = false;
      setBusy(false);
      setLabel('');
    }
  };
  useEffect(() => {
    if (machine && !started.current) {
      started.current = true;
      void start();
    }
  }, []);
  const refresh = async () => {
    if (job?.status === 'needs-command' || job?.status === 'failed') {
      await start();
      return;
    }
    setBusy(true);
    setError('');
    try {
      const known = device ?? job?.device;
      if (!known) return;
      const result = await api<{ device: DeviceView }>(
        `/api/devices/${encodeURIComponent(known.id)}/check`,
        {},
        'POST',
      );
      setDevice(result.device);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const close = () => onClose(job?.status === 'completed' ? (device ?? job.device) : undefined);
  const executors = (device ?? job?.device)?.executors;
  const ready = executors?.filter((item) => item.status === 'ready') ?? [];
  const completed = job?.status === 'completed';
  const ssh = device?.tunnel?.ssh ?? job?.device?.tunnel?.ssh ?? server.ssh;
  const command =
    job?.status === 'needs-command' ? job.command : completed && !ready.length && ssh ? `ssh ${ssh}` : undefined;
  return (
    <dialog
      ref={dialog}
      className="modal server-enroll-dialog"
      aria-modal="true"
      aria-labelledby="server-enroll-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <h2 id="server-enroll-title">{withNames('把 PugPort 装到 {0}？', [server.name])}</h2>
      {sshAdded && (
        <p role="status">
          已添加 ~/.ssh/pugport-instabox.conf 和 ~/.ssh/config 中的一行 Include。可在 instabox 卡片选择“移除 instabox
          SSH 配置”。
        </p>
      )}
      {!job && (
        <>
          <p>安装 PugPort，服务只监听 127.0.0.1。</p>
          <p>用 @@@ 发出的任务在服务器运行，并遵守这条消息的权限。</p>
          {server.purpose && <p translate="no">{server.purpose}</p>}
        </>
      )}
      {job && !completed && (
        <ol>
          {stages.map((stage, index) => {
            const current = stages.findIndex((item) => item.id === job.stage);
            return (
              <li key={stage.id} aria-current={index === current ? 'step' : undefined}>
                {stage.label}
                {index < current ? ' ✓' : index === current && job.status === 'running' ? ' …' : ''}
              </li>
            );
          })}
        </ol>
      )}
      {job?.status === 'failed' && (
        <pre className="inline-error" role="alert">
          {job.log.trim().split('\n').slice(-12).join('\n')}
        </pre>
      )}
      {job?.status === 'needs-command' && <p>请先在服务器运行这条命令，然后重新检查。</p>}
      {completed &&
        (executors ? (
          executors.length ? (
            <p>
              {withNames('已接入 {0} · 执行器：{1}', [
                server.name,
                executors
                  .map((item) =>
                    item.status === 'ready'
                      ? item.label
                      : `${item.label}（${item.status === 'auth-required' ? '要先登录' : '暂不可用'}）`,
                  )
                  .join(', '),
              ])}
            </p>
          ) : (
            <p>已接入，但它上面还没登录任何 CLI</p>
          )
        ) : (
          <p>已接入，暂时无法读取执行器</p>
        ))}
      {command && (
        <div>
          <code translate="no">{command}</code>{' '}
          <button type="button" className="button secondary" onClick={() => void copy(command)}>
            复制
          </button>
        </div>
      )}
      {label && <p role="status">{label}</p>}
      {error && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      <div className="modal-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={close}>
          {completed ? '关闭' : '取消'}
        </button>
        {!job && (
          <button type="button" className="button primary" disabled={busy} onClick={() => void start()}>
            接入
          </button>
        )}
        {(job?.status === 'needs-command' || job?.status === 'failed' || (completed && !ready.length)) && (
          <button type="button" className="button primary" disabled={busy} onClick={() => void refresh()}>
            重新检查
          </button>
        )}
      </div>
    </dialog>
  );
}
