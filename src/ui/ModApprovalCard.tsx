import { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import type { Conversation } from '../shared/types';
import { modPermissionText } from '../shared/mod-permission-copy';
import { withNames } from './i18n';

/**
 * A local build that mod_load saved but could not install: only the user approves new permissions. Same words as
 * the Store's load prompt.
 */
export function ModApprovalCard({
  request,
  onAnswer,
}: {
  request: NonNullable<Conversation['modApproval']>;
  onAnswer: (
    answer: Pick<NonNullable<Conversation['modApproval']>, 'modeId' | 'version' | 'permissions'> & {
      approved: boolean;
    },
  ) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (approved: boolean) => {
    setBusy(true);
    void onAnswer({
      approved,
      modeId: request.modeId,
      version: request.version,
      permissions: [...request.permissions],
    }).finally(() => setBusy(false));
  };
  return (
    <section className="question-card mod-approval-card" aria-label="Mod 权限">
      <p className="mod-approval-title">
        <ShieldCheck size={15} aria-hidden="true" />
        <span data-names>{withNames('允许「{0}」{1} 使用这些权限？', [request.title, request.version])}</span>
      </p>
      <ul>
        {request.permissions.map((permission) => (
          <li key={permission}>{modPermissionText[permission] ?? permission}</li>
        ))}
      </ul>
      <div className="question-card-actions">
        <button type="button" className="button primary" disabled={busy} onClick={() => answer(true)}>
          允许并加载
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => answer(false)}>
          以后再说
        </button>
      </div>
    </section>
  );
}
