export function githubNeedsApproval(tool: string, args: Record<string, unknown>, defaultBranch?: string): boolean {
  if (tool === 'issue_write') return Object.hasOwn(args, 'state') || Object.hasOwn(args, 'duplicate_of');
  if (tool === 'update_pull_request') return Object.hasOwn(args, 'state');
  if (tool === 'pull_request_review_write')
    return typeof args.event === 'string' && args.event.toUpperCase() === 'APPROVE';
  if (tool === 'push_files' || tool === 'create_or_update_file') {
    const normalize = (branch: unknown) =>
      typeof branch === 'string'
        ? branch
            .trim()
            .replace(/^(refs\/heads\/|heads\/)/i, '')
            .toLowerCase()
        : '';
    const branch = normalize(args.branch);
    const target = normalize(defaultBranch);
    return !target || !branch || branch === target;
  }
  return ![
    'create_branch',
    'create_pull_request',
    'add_issue_comment',
    'add_reply_to_pull_request_comment',
    'add_comment_to_pending_review',
    'update_issue_comment',
    'sub_issue_write',
    'update_pull_request_branch',
  ].includes(tool);
}
