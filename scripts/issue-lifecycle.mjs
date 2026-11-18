import { githubClient, isBotComment, isMain, notifyOnce, readEvent, setLabel } from './github-metadata.mjs';

export const DAY = 24 * 60 * 60 * 1000;
const STATE = 'pugport-claim-v1';

export function parseCommand(body) {
  return /^\/(claim|unclaim|renew)$/.exec((body ?? '').trim())?.[1] ?? null;
}

export function referencedIssues(text, repo) {
  const numbers = new Set();
  for (const match of (text ?? '').matchAll(/(?<![\w/])#([1-9]\d*)\b/g)) numbers.add(Number(match[1]));
  const escaped = repo.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&');
  for (const match of (text ?? '').matchAll(
    new RegExp(`https://github\\.com/${escaped}/issues/([1-9]\\d*)\\b`, 'gi'),
  )) {
    numbers.add(Number(match[1]));
  }
  return [...numbers].filter(Number.isSafeInteger);
}

export function claimStatus(claim, now, hasOpenPR) {
  if (!claim.claimer || hasOpenPR) return 'keep';
  const age = now - Date.parse(claim.renewedAt);
  if (age >= 7 * DAY) return 'release';
  return age >= 6 * DAY ? 'warn' : 'keep';
}

export function applyCommand(claim, command, actor, owner, at, hasOpenPR) {
  const active = claim.claimer && claimStatus(claim, Date.parse(at), hasOpenPR) !== 'release';
  if (command === 'claim') {
    if (active && actor !== claim.claimer)
      return { claim, message: `Claim refused: @${claim.claimer} holds the active claim.` };
    if (active) return { claim, message: `@${actor} already holds the claim. Use /renew to extend it.` };
    return {
      claim: {
        ...claim,
        releaseLogins: [...new Set([...claim.releaseLogins, ...(claim.claimer ? [claim.claimer] : [])])],
        claimer: actor,
        renewedAt: at,
      },
      message: `Claim confirmed for @${actor}. Renew within seven days with /renew, or release with /unclaim.`,
    };
  }
  if (command === 'unclaim') {
    if (actor !== claim.claimer && actor.toLowerCase() !== owner.toLowerCase())
      return { claim, message: 'Release refused: only the claimer or owner may release.' };
    return {
      claim: {
        ...claim,
        releaseLogins: [...new Set([...claim.releaseLogins, ...(claim.claimer ? [claim.claimer] : [])])],
        claimer: null,
        renewedAt: null,
      },
      message: `Claim released by @${actor}.`,
    };
  }
  if (command === 'renew') {
    if (actor !== claim.claimer || !active)
      return { claim, message: 'Renewal refused: only the active claimer may renew. Use /claim if it expired.' };
    return { claim: { ...claim, renewedAt: at }, message: `Claim renewed for @${actor} for seven days.` };
  }
  return { claim, message: '' };
}

export function needsFindingReminder(issue, claim, now, lastReminderAt) {
  return (
    issue.state === 'open' &&
    issue.labels.some((label) => label.name === 'finding') &&
    !claim.claimer &&
    !issue.labels.some((label) => label.name === 'claimed') &&
    now - Date.parse(issue.created_at) >= 14 * DAY &&
    (!lastReminderAt || now - Date.parse(lastReminderAt) >= 7 * DAY)
  );
}

export function readClaim(comments) {
  const record = [...comments]
    .reverse()
    .find((comment) => isBotComment(comment) && comment.body?.includes(`<!-- ${STATE} `));
  if (!record) return { record: null, claim: { claimer: null, renewedAt: null, releaseLogins: [], lastCommentId: 0 } };
  let claim;
  try {
    claim = JSON.parse(record.body.match(/<!-- pugport-claim-v1 (.*?) -->/)?.[1] ?? '');
  } catch {
    throw new Error('Invalid bot claim record; owner repair required.');
  }
  const login = (value) => value === null || /^[a-z\d-]{1,39}$/i.test(value ?? '');
  if (
    !login(claim.claimer) ||
    !Array.isArray(claim.releaseLogins) ||
    !claim.releaseLogins.every((value) => value !== null && login(value)) ||
    !Number.isSafeInteger(claim.lastCommentId) ||
    claim.lastCommentId < 0 ||
    (claim.claimer ? !Number.isFinite(Date.parse(claim.renewedAt)) : claim.renewedAt !== null)
  ) {
    throw new Error('Invalid bot claim record; owner repair required.');
  }
  return { record, claim };
}

async function reconcileIssue(api, issue, openPRs, owner, now) {
  const hasOpenPR = openPRs.some((pr) =>
    referencedIssues(`${pr.title}\n${pr.body ?? ''}`, api.repo).includes(issue.number),
  );
  await setLabel(api, issue.number, issue.labels, 'in-flight', hasOpenPR);
  const comments = (await api.list(`/issues/${issue.number}/comments`)).sort((a, b) => a.id - b.id);
  const { record, claim: before } = readClaim(comments);
  let claim = before;
  const notices = [];
  for (const comment of comments) {
    const command = parseCommand(comment.body);
    if (!command || comment.user?.type !== 'User' || comment.id <= claim.lastCommentId) continue;
    const result =
      issue.state !== 'open' && command !== 'unclaim'
        ? { claim, message: 'Claim and renewal refused: the issue is closed.' }
        : applyCommand(claim, command, comment.user.login, owner, comment.created_at, hasOpenPR);
    claim = { ...result.claim, lastCommentId: comment.id };
    notices.push({ key: `command-${comment.id}`, message: result.message });
  }
  const status = claimStatus(claim, now, hasOpenPR);
  if (issue.state === 'open' && (status === 'warn' || status === 'release')) {
    const expires = new Date(Date.parse(claim.renewedAt) + 7 * DAY).toISOString();
    const message =
      status === 'warn'
        ? `@${claim.claimer}: your claim expires at ${expires} (within one day) without /renew or a linked open PR.`
        : `@${claim.claimer}: your seven-day claim expired without renewal or a linked open PR; it is released.`;
    notices.push({ key: `${status}-${claim.renewedAt}`, message });
    if (status === 'release')
      claim = {
        ...claim,
        releaseLogins: [...new Set([...claim.releaseLogins, claim.claimer])],
        claimer: null,
        renewedAt: null,
      };
  }
  if (record || claim.lastCommentId > 0) {
    // Apply idempotent effects before advancing the comment cursor or confirming a claim.
    // If an API call fails, the next run replays the same commands from the old record.
    await setLabel(api, issue.number, issue.labels, 'claimed', Boolean(claim.claimer));
    const released = claim.releaseLogins.filter(
      (login) => login !== claim.claimer && issue.assignees.some((user) => user.login === login),
    );
    if (released.length) await api.request('DELETE', `/issues/${issue.number}/assignees`, { assignees: released });
    if (claim.claimer && !issue.assignees.some((user) => user.login === claim.claimer)) {
      const assigned = await api.request('POST', `/issues/${issue.number}/assignees`, { assignees: [claim.claimer] });
      if (!assigned.assignees.some((user) => user.login === claim.claimer))
        throw new Error('GitHub did not assign the claimer.');
    }
    for (const notice of notices) await notifyOnce(api, issue.number, comments, notice.key, notice.message);
    claim = { ...claim, releaseLogins: [] };
    const summary = claim.claimer
      ? `Claim holder: @${claim.claimer}. Last claim/renewal: ${claim.renewedAt}. Linked open PR: ${hasOpenPR ? 'yes' : 'no'}.`
      : 'No active claim.';
    const body = `${summary}\n\n<!-- ${STATE} ${JSON.stringify(claim)} -->`;
    if (record && record.body !== body) await api.request('PATCH', `/issues/comments/${record.id}`, { body });
    if (!record) await api.request('POST', `/issues/${issue.number}/comments`, { body });
  }
  const reminder = [...comments]
    .reverse()
    .find((comment) => isBotComment(comment) && comment.body?.includes('<!-- pugport-notice:finding-reminder-'));
  const current = {
    ...issue,
    labels: issue.labels.filter((label) => label.name !== 'claimed' || (!record && !claim.lastCommentId)),
  };
  if (needsFindingReminder(current, claim, now, reminder?.created_at)) {
    await notifyOnce(
      api,
      issue.number,
      comments,
      `finding-reminder-${Math.floor(now / DAY)}`,
      `@${owner}: this finding is over 14 days old and unclaimed. Please triage or request an owner ruling. It remains open.`,
    );
  }
}

export async function runLifecycle(api, event, now = Date.now()) {
  // The repository may belong to an organisation; the maintainer who may release claims is a person.
  const owner = process.env.LIFECYCLE_MAINTAINER || api.repo.split('/')[0];
  if (event.repository?.full_name !== api.repo) throw new Error('Unexpected repository.');
  const openPRs = await api.list('/pulls?state=open');
  // Global serialization + reconciliation drains comments even if Actions coalesces pending runs.
  const issues = await api.list('/issues?state=all&sort=created&direction=asc');
  const errors = [];
  for (const issue of issues) {
    if (!issue.pull_request) {
      try {
        await reconcileIssue(api, issue, openPRs, owner, now);
      } catch (error) {
        errors.push(`Issue #${issue.number}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

if (isMain(import.meta.url)) {
  runLifecycle(githubClient(), readEvent()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
