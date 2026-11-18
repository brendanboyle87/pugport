/** Empty means a software/remote adapter, which must not be presented as physical hardware. */
export function shortHardwareName(name: string): string {
  if (/virtual|remote|basic display|gameviewer/i.test(name)) return '';
  return name
    .replace(/\((?:R|TM)\)|[®™]/gi, '')
    .replace(/\b(?:with|w\/)\s*Radeon\b.*$/i, '')
    .replace(/\s*@\s*.*$|\s+\d+(?:\.\d+)?\s*[GM]Hz\s*$/i, '')
    .replace(/\b(?:Intel|AMD|NVIDIA|GeForce|CPU|GPU|Processor)\b/gi, '')
    .replace(/\b\d+-Core\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}
