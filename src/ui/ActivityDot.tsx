import { conversationActivityLabels, type conversationActivity } from './queue-utils';

export function ActivityDot({ activity }: { activity?: ReturnType<typeof conversationActivity> }) {
  if (!activity) return null;
  const label = conversationActivityLabels[activity];
  return <span className={`activity-dot activity-${activity}`} title={label} aria-label={label} role="img" />;
}
