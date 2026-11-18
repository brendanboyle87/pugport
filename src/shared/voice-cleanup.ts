/** Conservative filler cleanup for Mods' local speech recognition. */
export function cleanDictation(text: string): string {
  let value = text.replace(/\s+/g, ' ').trim();
  // Fillers on their own: 嗯 / 呃 / 额 / 啊 / 哦 / 唔 / emm, um, uh — with the comma that usually follows.
  // Repeated until nothing changes, since one filler's match uses up the separator before the next.
  const filler =
    /(^|[，。！？、,.!?；;：:\s])(?:嗯+|呃+|额+|啊+|哦+|唔+|e+m+|u+m+|u+h+|h+m+)(?:[，,、\s]+|(?=[。.!?！？]|$))/gi;
  for (let previous = ''; previous !== value;) {
    previous = value;
    value = value.replace(filler, '$1');
  }
  // A connective said twice in a row: 然后然后 / 就是就是 / 那个那个 / 我我 → once.
  value = value.replace(/(然后|就是说|就是|那个|这个|我们|我|你|他|它)(?:[，,\s]*\1)+/g, '$1');
  // "就是说，" or "那个，" opening a sentence adds nothing.
  value = value.replace(/(^|[。！？.!?]\s*)(?:就是说|那个|这个)[，,]\s*/g, '$1');
  // Tidy leftover punctuation.
  value = value
    .replace(/[，,]{2,}/g, '，')
    .replace(/^[，,、\s]+/, '')
    .replace(/[，,、\s]+([。！？.!?])/g, '$1')
    .trim();
  return value;
}
