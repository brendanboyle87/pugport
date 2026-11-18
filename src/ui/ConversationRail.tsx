import { currentLocale } from './i18n';
import { useEffect, useRef, useState, type RefObject } from 'react';
import type { ConversationMessage } from '../shared/types';

/*
 * A quick-jump rail beside the conversation, like the Codex and Claude apps: one tick per message the user
 * sent, placed where it sits in the conversation. Hovering shows how that message began; clicking jumps there.
 * The wheel keeps scrolling the conversation as usual.
 */

type Tick = { id: string; at: number; text: string; quotes: number; time: string };

const excerpt = (message: ConversationMessage) => {
  const text = message.content.replace(/\s+/g, ' ').trim();
  const first = text || message.quotes?.[0]?.note || message.quotes?.[0]?.text || '（附件）';
  return first.length > 90 ? `${first.slice(0, 90)}…` : first;
};

export function ConversationRail({
  scrollRef,
  messages,
}: {
  scrollRef: RefObject<HTMLDivElement | null>;
  messages: ConversationMessage[];
}) {
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [current, setCurrent] = useState<string>();
  const [hover, setHover] = useState<{ tick: Tick; y: number }>();
  const rail = useRef<HTMLDivElement>(null);
  const users = messages.filter((message) => message.role === 'user');
  const key = users.map((message) => message.id).join(',');

  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const measure = () => {
      const height = scroller.scrollHeight;
      if (height <= scroller.clientHeight + 40) return setTicks([]);
      const next: Tick[] = [];
      for (const message of users) {
        const element = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`);
        if (!element) continue;
        next.push({
          id: message.id,
          at: element.offsetTop / height,
          text: excerpt(message),
          quotes: message.quotes?.length ?? 0,
          time: new Date(message.createdAt).toLocaleString(currentLocale(), {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
          }),
        });
      }
      setTicks(next.length >= 2 ? next : []);
    };
    const track = () => {
      // The message whose start is nearest above the top third of the view is "where you are".
      const mark = scroller.scrollTop + scroller.clientHeight / 3;
      let last: string | undefined;
      for (const message of users) {
        const element = scroller.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(message.id)}"]`);
        if (element && element.offsetTop <= mark) last = message.id;
      }
      setCurrent(last);
    };
    measure();
    track();
    const observer = new ResizeObserver(() => {
      measure();
      track();
    });
    observer.observe(scroller);
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    scroller.addEventListener('scroll', track, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', track);
    };
  }, [key, scrollRef]);

  if (!ticks.length) return null;
  const nearest = (clientY: number) => {
    const box = rail.current?.getBoundingClientRect();
    if (!box) return undefined;
    const at = (clientY - box.top) / box.height;
    return ticks.reduce((best, tick) => (Math.abs(tick.at - at) < Math.abs(best.at - at) ? tick : best), ticks[0]!);
  };
  const jump = (tick: Tick) => {
    const scroller = scrollRef.current;
    const element = scroller?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(tick.id)}"]`);
    if (scroller && element) scroller.scrollTo({ top: Math.max(0, element.offsetTop - 16), behavior: 'smooth' });
  };
  return (
    <div
      ref={rail}
      className="conversation-rail"
      role="navigation"
      aria-label="对话快速跳转"
      onMouseMove={(event) => {
        const tick = nearest(event.clientY);
        const box = rail.current?.getBoundingClientRect();
        if (tick && box) setHover({ tick, y: tick.at * box.height });
      }}
      onMouseLeave={() => setHover(undefined)}
      onClick={(event) => {
        const tick = nearest(event.clientY);
        if (tick) jump(tick);
      }}
      onWheel={(event) => scrollRef.current?.scrollBy({ top: event.deltaY })}
    >
      {ticks.map((tick) => (
        <span
          key={tick.id}
          className={`rail-tick ${tick.id === current ? 'current' : ''} ${tick.id === hover?.tick.id ? 'hover' : ''}`}
          style={{ top: `${tick.at * 100}%` }}
        />
      ))}
      {hover && (
        <div className="rail-preview" style={{ top: hover.y }}>
          <small>
            <span translate="no">{hover.tick.time}</span>
            {hover.tick.quotes ? ` · ${hover.tick.quotes} 条引用` : ''}
          </small>
          <p translate="no">{hover.tick.text}</p>
        </div>
      )}
    </div>
  );
}
