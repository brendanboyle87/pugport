import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Shared transport only; workflows never execute contributor code.
export function githubClient(env = process.env) {
  const repo = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '') || !env.GITHUB_TOKEN) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required.');
  }
  async function request(method, path, body) {
    const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (method === 'DELETE' && response.status === 404) return;
    if (!response.ok) throw new Error(`GitHub ${method} ${path}: HTTP ${response.status}`);
    return response.status === 204 ? undefined : response.json();
  }
  async function list(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }
  return { repo, request, list };
}

export function readEvent(env = process.env) {
  return JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
}

export function isMain(url) {
  return Boolean(process.argv[1]) && url === pathToFileURL(process.argv[1]).href;
}

export function isBotComment(comment) {
  return comment.user?.login === 'github-actions[bot]' && comment.user?.type === 'Bot';
}

export async function setLabel(api, number, labels, name, enabled) {
  const present = labels.some((label) => (typeof label === 'string' ? label : label.name) === name);
  if (enabled && !present) await api.request('POST', `/issues/${number}/labels`, { labels: [name] });
  if (!enabled && present) await api.request('DELETE', `/issues/${number}/labels/${encodeURIComponent(name)}`);
}

export async function notifyOnce(api, number, comments, key, message) {
  const marker = `<!-- pugport-notice:${key} -->`;
  if (comments.some((comment) => isBotComment(comment) && comment.body?.includes(marker))) return;
  const comment = await api.request('POST', `/issues/${number}/comments`, { body: `${message}\n\n${marker}` });
  comments.push(comment);
}
