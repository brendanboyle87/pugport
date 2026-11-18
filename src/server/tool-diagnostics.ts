/** Keep useful native tool failure text without persisting credential values or terminal formatting. */
export function redactToolDiagnostic(value: string, limit = 1200): string {
  const diagnostic = value
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\b(?:sk|pk|xai)-[\w-]+/gi, '[redacted]')
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, '[redacted]')
    .replace(/((?:bearer|basic)\s+)[^\s"',;]+/gi, '$1[redacted]')
    .replace(
      /(["']?(?:api[_-]?key|(?:access|refresh|auth)[_-]?token|token|password|secret|authorization|credentials?|client[_-]?secret)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;]+)/gi,
      '$1[redacted]',
    )
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, '[redacted URL]')
    .trim();
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 1200;
  return diagnostic.length > max ? diagnostic.slice(0, Math.max(0, max - 1)) + (max ? '…' : '') : diagnostic;
}
