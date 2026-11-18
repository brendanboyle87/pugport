import { useEffect, useLayoutEffect, useRef } from 'react';
import { createFollowBottom } from './follow-bottom';

export function ReasoningStream({ text, open }: { text: string; open: boolean }) {
  return (
    <details className="reasoning-stream" open={open}>
      <summary>思考过程</summary>
      <ReasoningPane text={text} />
    </details>
  );
}

export function ReasoningPane({ text, className }: { text: string; className?: string }) {
  const pane = useRef<HTMLPreElement>(null);
  const follow = useRef(createFollowBottom());
  const update = () => {
    if (pane.current) follow.current.update(pane.current);
  };

  useLayoutEffect(update, [text]);
  useEffect(() => {
    if (!pane.current) return;
    const observer = new ResizeObserver(update);
    observer.observe(pane.current);
    return () => observer.disconnect();
  }, []);

  return (
    <pre
      ref={pane}
      className={className}
      tabIndex={0}
      aria-label="思考过程"
      onScroll={(event) => follow.current.onScroll(event.currentTarget)}
    >
      {text}
    </pre>
  );
}
