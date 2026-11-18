import { clipboard, Menu, shell, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { t } from './locale.ts';

/**
 * The right-click menu Electron leaves out: editing commands in text fields, copy for selected text, link
 * actions and spelling suggestions. The page shows its own menu where it has one (conversation rows,
 * selected conversation text), which suppresses this one there.
 */
export function attachContextMenu(contents: WebContents) {
  contents.on('context-menu', (_event, params) => {
    // Native link/clipboard actions are host capabilities, never available to Mod subframes.
    if (params.frame !== contents.mainFrame) return;
    const items: MenuItemConstructorOptions[] = [];
    if (params.misspelledWord && params.dictionarySuggestions.length) {
      for (const suggestion of params.dictionarySuggestions.slice(0, 5))
        items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
      items.push({ type: 'separator' });
    }
    if (/^https?:\/\//i.test(params.linkURL)) {
      items.push(
        { label: t('打开链接'), click: () => void shell.openExternal(params.linkURL) },
        { label: t('复制链接'), click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      );
    }
    if (params.isEditable) {
      const can = params.editFlags;
      items.push(
        { role: 'undo', label: t('撤销'), enabled: can.canUndo },
        { role: 'redo', label: t('重做'), enabled: can.canRedo },
        { type: 'separator' },
        { role: 'cut', label: t('剪切'), enabled: can.canCut },
        { role: 'copy', label: t('复制'), enabled: can.canCopy },
        { role: 'paste', label: t('粘贴'), enabled: can.canPaste },
        { type: 'separator' },
        { role: 'selectAll', label: t('全选'), enabled: can.canSelectAll },
      );
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy', label: t('复制') }, { role: 'selectAll', label: t('全选') });
    }
    while (items.at(-1)?.type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}
