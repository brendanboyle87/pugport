import { app } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTranslator, isLocale, withSpacing, type Locale, type Translate } from '../shared/i18n/index.ts';
import english from '../shared/i18n/en.json';
import traditional from '../shared/i18n/zh-Hant.json';

/*
 * The tray menu, tooltip and quota card are drawn by the main process, outside the page; they follow the
 * language the page reports, remembered in the user-data folder for the next start.
 */
let translate: Translate | undefined;
let version = 0;
const file = () => join(app.getPath('userData'), 'locale.txt');

export function setMainLocale(locale: Locale, remember = true) {
  translate =
    locale === 'en'
      ? createTranslator(english as Record<string, string>)
      : locale === 'zh-TW'
        ? createTranslator(traditional as Record<string, string>)
        : undefined;
  version++;
  if (remember)
    try {
      writeFileSync(file(), locale);
    } catch {
      /* Next start then begins in the source language until the page reports again. */
    }
}

export function restoreMainLocale() {
  try {
    const saved = readFileSync(file(), 'utf8').trim();
    if (isLocale(saved)) setMainLocale(saved, false);
  } catch {
    /* No saved choice yet. */
  }
}

/** Bumps whenever the language changes, so the tray can rebuild its menu. */
export const localeVersion = () => version;

export const t = (text: string) => {
  const translated = translate?.(text);
  return translated === undefined ? text : withSpacing(text, translated);
};

/** Translates visible text, tooltips and accessible labels in the main process's small static pages. */
export function translateHtml(html: string): string {
  if (!translate) return html;
  return html
    .replace(/>([^<>]+)</g, (whole, text: string) => (/[㐀-鿿]/.test(text) ? `>${t(text)}<` : whole))
    .replace(/(title|aria-label|data-full)="([^"]*)"/g, (whole, attribute: string, text: string) =>
      /[㐀-鿿]/.test(text) ? `${attribute}="${t(text)}"` : whole,
    );
}
