import { createElement, useEffect, useState, type CSSProperties } from 'react';
import {
  BookOpen,
  Calendar,
  ClipboardList,
  CodeXml,
  FlaskConical,
  GraduationCap,
  Image as ImageIcon,
  Kanban,
  Languages,
  Layers,
  Lightbulb,
  ListChecks,
  Map as MapIcon,
  Mic,
  Music,
  NotebookPen,
  PenLine,
  Puzzle,
  Sparkles,
  SquareCheck,
  Table,
  Target,
  Timer,
  Wallet,
} from 'lucide-react';
import type { ModeCatalogEntry } from '../../shared/conversation-modes';
import type { HostIcon } from '../../shared/mods-manifest';

const icons = {
  puzzle: Puzzle,
  'notebook-pen': NotebookPen,
  'book-open': BookOpen,
  'code-xml': CodeXml,
  languages: Languages,
  'list-checks': ListChecks,
  sparkles: Sparkles,
  calendar: Calendar,
  'check-square': SquareCheck,
  'clipboard-list': ClipboardList,
  'flask-conical': FlaskConical,
  'graduation-cap': GraduationCap,
  image: ImageIcon,
  kanban: Kanban,
  layers: Layers,
  lightbulb: Lightbulb,
  map: MapIcon,
  mic: Mic,
  music: Music,
  'pen-line': PenLine,
  table: Table,
  target: Target,
  timer: Timer,
  wallet: Wallet,
} satisfies Record<HostIcon, typeof Puzzle>;

type LogoProbe = { failed: boolean; listeners: Set<() => void> };
const logoProbes = new Map<string, LogoProbe>();

export function ModeIcon({ mode, size = 16 }: { mode?: Pick<ModeCatalogEntry, 'icon' | 'logo'>; size?: number }) {
  const src = mode?.logo?.src;
  const [, redraw] = useState(0);
  useEffect(() => {
    if (!src) return;
    let probe = logoProbes.get(src);
    const changed = () => redraw((revision) => revision + 1);
    if (!probe) {
      probe = { failed: false, listeners: new Set() };
      logoProbes.set(src, probe);
      probe.listeners.add(changed);
      if (typeof Image !== 'undefined') {
        const image = new Image();
        const current = probe;
        image.onerror = () => {
          current.failed = true;
          for (const listener of current.listeners) listener();
        };
        image.src = src;
      }
    } else probe.listeners.add(changed);
    return () => {
      probe.listeners.delete(changed);
    };
  }, [src]);
  if (src && !logoProbes.get(src)?.failed) {
    return createElement('span', {
      className: 'mod-logo',
      'aria-hidden': true,
      style: { '--mod-logo': `url("${src}")`, width: size, height: size } as CSSProperties,
    });
  }
  const Icon = (mode?.icon && icons[mode.icon]) || Puzzle;
  return createElement(Icon, { size, 'aria-hidden': true });
}
