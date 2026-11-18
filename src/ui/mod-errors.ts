export type FriendlyModError = { text: string; detail: string };

/** Keep diagnostic details available for copying, never render request messages directly. */
export function friendlyModError(failure: unknown, context?: 'source' | 'open' | 'list'): FriendlyModError {
  const value = failure && typeof failure === 'object' ? (failure as Record<string, unknown>) : {};
  const detail = typeof value.message === 'string' ? value.message : typeof failure === 'string' ? failure : '';
  const status = Number(value.status ?? value.statusCode);
  let text: string;
  if (context === 'open') text = '没能打开这个 Mod，请重试。';
  else if (context === 'list') text = '暂时读不到 Mods 列表。';
  else if (
    [
      '来源已更新，请重新打开这个 Mod。',
      '正在更新来源，请稍后重试。',
      '这个 Mod 的文件有问题，暂时不能加载。等作者更新后再试。',
      '下载的文件和来源记录对不上，为了安全没有加载。',
      '连不上 Mod 来源。检查网络后重试。',
      '需要更新 PugPort 才能使用这个 Mod。',
      '没能打开这个 Mod，请重试。',
      '暂时读不到 Mods 列表。',
      '没能完成，请重试。',
    ].includes(detail)
  )
    text = detail;
  else if (value.compatible === false || /hostVersion/i.test(detail)) text = '需要更新 PugPort 才能使用这个 Mod。';
  else if (context === 'source' && /sha256|\bsize\b|Mod 文件校验失败|Mod 包与目录信息不一致/i.test(detail))
    text = '下载的文件和来源记录对不上，为了安全没有加载。';
  else if (
    [502, 503, 504].includes(status) ||
    /(?:TypeError:.*fetch|failed to fetch|fetch failed)/i.test(detail) ||
    (context === 'source' &&
      (value.code === 'E_UNAVAILABLE' ||
        /E_UNAVAILABLE|timeout|(?:502|503|504)|Mod 源暂时无法访问|无法访问 GitHub Mod 源|Mod 源文件读取失败/i.test(
          detail,
        )))
  )
    text = '连不上 Mod 来源。检查网络后重试。';
  else if (status === 400 || /^\s*[\[{]/.test(detail) || /"code"\s*:|invalid_/.test(detail))
    text = '这个 Mod 的文件有问题，暂时不能加载。等作者更新后再试。';
  else text = '没能完成，请重试。';
  return { text, detail };
}
