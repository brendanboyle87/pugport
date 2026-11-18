import type { SubscriptionPlan } from '../shared/types.ts';
/** Only pass a provider's dedicated plan field, never arbitrary account strings. */
export function subscriptionPlan(
  value: unknown,
  source: string,
  observedAt = new Date().toISOString(),
): SubscriptionPlan | undefined {
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9 _+().-]{0,63}$/.test(value)) return undefined;
  const raw = value.trim();
  if (!raw || /^(unknown|none|null|undefined)$/i.test(raw)) return undefined;
  const labels: Record<string, string> = {
    pro: 'Pro',
    plus: 'Plus',
    max: 'Max',
    ultra: 'Ultra',
    free: 'Free',
    team: 'Team',
    business: 'Business',
    enterprise: 'Enterprise',
    edu: 'Edu',
    go: 'Go',
    supergrok: 'SuperGrok',
    supergrok_heavy: 'SuperGrok Heavy',
  };
  return { label: labels[raw.toLowerCase()] ?? raw, source, observedAt };
}
