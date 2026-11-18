import { useEffect, useState } from 'react';
import type { Project } from '../shared/types';
import type { RoutingProfile } from '../shared/routing-profiles';
import type { Api } from './Workspace';

export function ProjectRoutingDefault({
  project,
  api,
  selected,
  onChange,
  disabled,
}: {
  project: Project;
  api: Api;
  selected: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [profiles, setProfiles] = useState<RoutingProfile[]>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let alive = true;
    setProfiles(undefined);
    setError('');
    void api<{ profiles: RoutingProfile[] }>('/api/routing-profiles', undefined, 'GET')
      .then((value) => {
        if (alive) setProfiles(value.profiles);
      })
      .catch((cause) => {
        if (alive) setError(String(cause));
      });
    return () => {
      alive = false;
    };
  }, [api, project.id, revision]);
  return (
    <fieldset className="local-memory-settings" disabled={disabled} aria-label="项目默认路由">
      <label className="field">
        <span>项目默认路由</span>
        <select
          aria-label="项目默认路由方案"
          value={selected}
          disabled={!profiles}
          onChange={(event) => onChange(event.target.value)}
        >
          <option value="">自动（全局与对话规则）</option>
          {profiles?.map((profile) => (
            <option key={profile.id} value={profile.id}>
              {profile.name}
            </option>
          ))}
          {selected && !profiles?.some((profile) => profile.id === selected) && (
            <option value={selected} disabled>
              路由方案不可用
            </option>
          )}
        </select>
      </label>
      <p>当前项目中未另选方案的对话会继承此设置。只影响之后创建的任务；权限与额度限制仍然有效。</p>
      {error && (
        <p role="alert">
          {error}
          {!profiles && (
            <button type="button" className="inline-link" onClick={() => setRevision((value) => value + 1)}>
              重试
            </button>
          )}
        </p>
      )}
    </fieldset>
  );
}
