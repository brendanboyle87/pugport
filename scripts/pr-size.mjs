import { appendFileSync } from 'node:fs';
import { githubClient, isBotComment, isMain, readEvent, setLabel } from './github-metadata.mjs';

export const LIMIT = 500;
const REPORT = '<!-- pugport-pr-size-v1 -->';

// Keep this exact policy in sync with CONTRIBUTING.md.
export function excludedPath(path) {
  return (
    /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(path) ||
    /^(dist|release|coverage|node_modules|\.runtime)\//.test(path) ||
    /(^|\/)[^/]*\.generated\.[^/]+$/.test(path) ||
    /\.(min\.js|min\.css|map)$/.test(path) ||
    /^src\/shared\/i18n\/[^/]+\.json$/.test(path)
  );
}

export function countLines(files) {
  let total = 0;
  let excluded = 0;
  const excludedFiles = [];
  for (const file of files) {
    const lines = file.additions + file.deletions;
    if (!Number.isSafeInteger(lines) || lines < 0) throw new Error('Invalid PR line count.');
    total += lines;
    if (excludedPath(file.filename) && (!file.previous_filename || excludedPath(file.previous_filename))) {
      excluded += lines;
      excludedFiles.push(file.filename);
    }
  }
  return { total, excluded, counted: total - excluded, excludedFiles };
}

export async function runSize(api, event, summaryPath = process.env.GITHUB_STEP_SUMMARY) {
  if (event.repository?.full_name !== api.repo) throw new Error('Unexpected repository.');
  const number = event.pull_request?.number;
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('A PR event is required.');
  const pr = await api.request('GET', `/pulls/${number}`);
  if (pr.state !== 'open') return { large: false };
  const files = await api.list(`/pulls/${number}/files`);
  // GitHub caps this endpoint at 3,000 files. Never report a partial count.
  if (files.length !== pr.changed_files) throw new Error('Incomplete PR file list; cannot verify size.');
  const counts = countLines(files);
  const comments = (await api.list(`/issues/${number}/comments`)).sort((a, b) => a.id - b.id);
  // Re-read before writing: a commit pushed during counting must not inherit this report.
  const latest = await api.request('GET', `/pulls/${number}`);
  if (latest.head.sha !== pr.head.sha) throw new Error('PR head changed during counting; rerun for the current head.');
  const result = { large: counts.counted > LIMIT };
  await setLabel(api, number, latest.labels, 'size:large', result.large);
  const body = `## PR size\n\nHead: \`${pr.head.sha}\`\n\nCounted: **${counts.counted}** added + removed lines (advisory threshold: ${LIMIT}). Total: ${counts.total}; excluded: ${counts.excluded}.\n\nExcluded files: ${counts.excludedFiles.length}. See [exact exclusions](https://github.com/${api.repo}/blob/main/.github/CONTRIBUTING.md#pr-size).\n\n${result.large ? 'Above the advisory threshold. Explain why the larger diff is cohesive and how to review it.' : 'Within the advisory threshold.'} Size alone does not fail this check or require an owner waiver.\n\n${REPORT}`;
  const report = comments.find((comment) => isBotComment(comment) && comment.body?.includes(REPORT));
  if (report && report.body !== body) await api.request('PATCH', `/issues/comments/${report.id}`, { body });
  if (!report) await api.request('POST', `/issues/${number}/comments`, { body });
  if (summaryPath) appendFileSync(summaryPath, `${body}\n`);
  console.log(`PR #${number}: ${counts.counted} counted lines; large=${result.large}; advisory only`);
  return result;
}

if (isMain(import.meta.url)) {
  runSize(githubClient(), readEvent()).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
