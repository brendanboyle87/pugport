import type { Locale } from './i18n/index.ts';

export const skillCategories = [
  'writing',
  'coding',
  'review',
  'research',
  'data',
  'design',
  'cloud',
  'productivity',
  'other',
] as const;
export type SkillCategory = (typeof skillCategories)[number];
export type SkillSummary = { hash: string; language: Locale; summary: string; category: SkillCategory };
export const skillSummaryLimit = (language: Locale) => (language === 'en' ? 90 : 60);

export function fallbackSkillSummary(description: string, language: Locale): string {
  const first = description
    .trim()
    .split(/(?<=[。！？])|(?<=[.!?])\s|[\r\n]+/u)[0]
    .replace(/\s+/g, ' ');
  const chars = Array.from(first);
  const limit = skillSummaryLimit(language);
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : first;
}
