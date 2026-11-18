import { desktopBridge } from './desktop';
import { createTranslator, defaultLocale, isLocale, withSpacing, type Locale, type Translate } from '../shared/i18n';
import { defaultAccountLabels } from '../shared/accounts';
import { apiPresets, freePresets } from '../shared/api-providers';

/*
 * Interface language for the whole window. Components keep writing Simplified Chinese; when another
 * language is chosen, interface text, tooltips and placeholders are translated as they render. What people
 * and executors wrote — replies, messages, titles, paths, code, logs — is never translated.
 */

const storageKey = 'comborunner.locale';
/** User content and machine output stay exactly as written. */
const keepAsWritten =
  '[translate="no"], .message-text, .markdown, pre, code, textarea, .agent-output, .reasoning-stream, .conversation-link > span:not([class]), .project-name > span, .setting-path, .file-ref, .split-head strong';
/**
 * Interface text inside those: a code block's copy button, "model · requested effort" labels (IDs have no Chinese),
 * and the "view full details" note after cut-off trajectory text.
 */
const translatedAnyway =
  '.message-code-head > button, .run-record-item > code, .execution-chip > code, .trajectory-more, .reasoning-stream > summary, .conversation-trace-selection';
const attributes = ['title', 'placeholder', 'aria-label', 'alt'] as const;
/**
 * An element whose attributes were already filled in with withNames (aria-label={withNames('移除 {0}', [name])}):
 * its attributes are left alone, its text is still translated. translate="no" would keep the text as written too.
 */
const attributesAsWritten = '[data-names]';
let interfaceTranslator: Translate | undefined;
let interfaceTable: Record<string, string> | undefined;
export const routeTranslator = (keep: ReadonlySet<string>): Translate =>
  interfaceTable ? createTranslator(interfaceTable, keep) : () => undefined;
/**
 * Translates now: OS/browser titles, which are outside the translated body, and interface text embedded in a
 * sentence before the sentence itself is translated.
 */
export const translateInterfaceText = (text: string) => interfaceTranslator?.(text) ?? text;
/**
 * An interface sentence around names people chose, written with {0}, {1}… in their place: the sentence is
 * translated now and the names are filled in as written, so a side chat called 设置 stays 设置 in
 * “Delete “设置”?”. Show the result in a translate="no" element.
 */
export const withNames = (sentence: string, names: readonly string[]) =>
  translateInterfaceText(sentence).replace(/\{(\d+)\}/g, (slot, index: string) => names[Number(index)] ?? slot);
/** Names PugPort gives by default: the CLI accounts it finds and API or free sources nobody renamed. Longest first. */
const defaultNames = [
  ...Object.values(defaultAccountLabels),
  ...[...apiPresets, ...freePresets].map((preset) => preset.label),
].sort((a, b) => b.length - a.length);
/**
 * A name to show as written (translate="no") or to pass to withNames. A name PugPort gave by default (Codex · 本机,
 * 通义千问) is interface text and is translated, also with the number PugPort adds to a second one (通义千问 2), and a
 * CLI account's followed by " · model · effort" (taste tests); any other name is the user's and stays as written.
 */
export function shownName(name: string) {
  const own = defaultNames.find((value) => {
    const rest = name.slice(value.length);
    return (
      name.startsWith(value) &&
      (/^(?: \d+)?$/.test(rest) ||
        (rest.startsWith(' · ') && Object.values<string>(defaultAccountLabels).includes(value)))
    );
  });
  return own ? translateInterfaceText(own) + name.slice(own.length) : name;
}

/** A conversation title to show as written: PugPort's title for one nobody named yet (新对话) translates. */
export const shownTitle = (title: string) => (title === '新对话' ? translateInterfaceText(title) : title);

export function currentLocale(): Locale {
  try {
    const saved = localStorage.getItem(storageKey);
    if (isLocale(saved)) return saved;
  } catch {
    /* Storage unavailable: follow the system. */
  }
  return typeof navigator === 'undefined' ? 'zh-CN' : defaultLocale(navigator.languages ?? [navigator.language]);
}

/** Saves the choice and reloads, so every part of the window starts in the new language. */
export function changeLocale(locale: Locale) {
  try {
    localStorage.setItem(storageKey, locale);
  } catch {
    /* The choice then lasts until the window reloads. */
  }
  location.reload();
}

async function loadTable(locale: Locale): Promise<Record<string, string> | undefined> {
  if (locale === 'en') return (await import('../shared/i18n/en.json')).default as Record<string, string>;
  if (locale === 'zh-TW') return (await import('../shared/i18n/zh-Hant.json')).default as Record<string, string>;
  return undefined;
}

const sourceTexts = new WeakMap<Text, { source: string; rendered: string }>();
const sourceAttributes = new WeakMap<Element, Map<string, { source: string; rendered: string }>>();
let languageObserver: MutationObserver | undefined;
let languageGeneration = 0;

function translateTree(root: Node, translate: Translate, deep = true) {
  const skip = (element: Element | null) => !element?.closest(translatedAnyway) && !!element?.closest(keepAsWritten);
  const text = (node: Text) => {
    const value = node.nodeValue ?? '';
    if (!value.trim() || skip(node.parentElement)) return;
    const previous = sourceTexts.get(node);
    const source = previous?.rendered === value ? previous.source : value;
    // Short labels can need a different translation in a specific UI context.
    const next = translate(node.parentElement?.getAttribute('data-i18n') ?? source);
    // Only translated text gets spacing; untranslated text renders exactly as written.
    const rendered = next === undefined ? source : withSpacing(source, next);
    sourceTexts.set(node, { source, rendered });
    if (rendered !== value) node.nodeValue = rendered;
  };
  const element = (node: Element) => {
    if (node.tagName === 'TEXTAREA' ? node.getAttribute('translate') === 'no' || skip(node.parentElement) : skip(node))
      return;
    if (node.matches(attributesAsWritten)) return;
    for (const name of attributes) {
      const value = node.getAttribute(name);
      if (!value) continue;
      let saved = sourceAttributes.get(node);
      if (!saved) {
        saved = new Map();
        sourceAttributes.set(node, saved);
      }
      const previous = saved.get(name);
      const source = previous?.rendered === value ? previous.source : value;
      const rendered = translate(source) ?? source;
      saved.set(name, { source, rendered });
      if (rendered !== value) node.setAttribute(name, rendered);
    }
  };
  if (root.nodeType === Node.TEXT_NODE) return text(root as Text);
  if (root.nodeType !== Node.ELEMENT_NODE) return;
  element(root as Element);
  if (!deep) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeType === Node.TEXT_NODE) text(node as Text);
    else element(node as Element);
  }
}

/** Starts translating the window when the chosen language is not the source language. */
export async function startInterfaceLanguage(): Promise<Locale> {
  const locale = currentLocale();
  const generation = ++languageGeneration;
  const table = await loadTable(locale);
  if (generation !== languageGeneration) return currentLocale();
  languageObserver?.disconnect();
  languageObserver = undefined;
  document.documentElement.lang = locale === 'zh-TW' ? 'zh-Hant' : locale === 'en' ? 'en' : 'zh-Hans';
  void desktopBridge()
    ?.setLocale?.(locale)
    .catch(() => undefined);
  const translate: Translate = table ? createTranslator(table) : () => undefined;
  interfaceTable = table;
  interfaceTranslator = translate;
  translateTree(document.body, translate);
  const translatedTitle = translate(document.title);
  if (translatedTitle) document.title = translatedTitle;
  if (!table) return locale;
  // Mutation callbacks run before the browser paints, so new text never flashes in the source language.
  languageObserver = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData') translateTree(record.target, translate);
      else if (record.type === 'attributes') translateTree(record.target, translate, false);
      else record.addedNodes.forEach((node) => translateTree(node, translate));
    }
  });
  languageObserver.observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: [...attributes],
  });
  return locale;
}

/** Pulled preferences apply without reloading or losing a draft. */
export async function applyInterfaceLocale(locale: Locale): Promise<void> {
  try {
    localStorage.setItem(storageKey, locale);
  } catch {
    /* Session-only locale. */
  }
  await startInterfaceLanguage();
  window.dispatchEvent(new Event('pugport-locale-changed'));
}
