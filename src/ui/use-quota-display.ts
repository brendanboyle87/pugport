import { useEffect, useRef, useState } from 'react';
import type { RuntimeSnapshot } from '../shared/types';

type Reading = Pick<RuntimeSnapshot, 'quota' | 'subscription' | 'lastKnownQuota'> & { id: string; scope: string };

function reading(runtime: RuntimeSnapshot): Reading {
  return {
    id: runtime.id,
    // An unverified/invalidated reading must never borrow the previous account's balance.
    scope: JSON.stringify([
      runtime.provider,
      runtime.environment,
      runtime.accountFingerprint ?? null,
      runtime.authMode ?? null,
      runtime.accounting?.mode ?? null,
      runtime.quota.status,
      !!runtime.lastKnownQuota,
      ['auth-required', 'missing'].includes(runtime.status),
    ]),
    quota: runtime.quota,
    lastKnownQuota: runtime.lastKnownQuota,
    subscription: runtime.subscription,
  };
}

/** Coalesce display updates only. Routing and task/connection status keep their live backend values. */
export function useQuotaDisplay(runtimes: RuntimeSnapshot[]): RuntimeSnapshot[] {
  const incoming = runtimes.map(reading);
  const signature = JSON.stringify(incoming);
  const latest = useRef(incoming);
  latest.current = incoming;
  const [displayed, setDisplayed] = useState(incoming);
  const displayedSignature = JSON.stringify(displayed);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (signature === displayedSignature) {
      clearTimeout(timer.current);
      timer.current = undefined;
    } else if (timer.current === undefined) {
      // A fixed window rather than a trailing debounce: continuous notifications cannot starve the display.
      timer.current = setTimeout(() => {
        timer.current = undefined;
        setDisplayed(latest.current);
      }, 1000);
    }
  }, [signature, displayedSignature]);
  useEffect(() => () => clearTimeout(timer.current), []);
  return runtimes.map((runtime) => {
    const current = incoming.find((value) => value.id === runtime.id)!;
    const previous = displayed.find((value) => value.id === runtime.id);
    if (!previous || previous.scope !== current.scope) return runtime;
    return {
      ...runtime,
      quota: previous.quota,
      lastKnownQuota: previous.lastKnownQuota,
      subscription: previous.subscription,
    };
  });
}
