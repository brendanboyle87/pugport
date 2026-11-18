import { VenetianMask } from 'lucide-react';

export function IncognitoLabel() {
  return (
    <span className="incognito-label" title="PugPort 不保留这个对话，但各 AI 自己的应用或 CLI 可能保留记录。">
      <VenetianMask size={13} aria-hidden="true" />
      隐身
    </span>
  );
}
