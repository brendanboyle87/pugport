import pugHead from './brand/pug-head.png';

/** The PugPort mark: the pug head, with a green dot that pulses while tasks run (like the tray icon). */
export function Logo({
  size = 22,
  running = false,
  local = false,
}: {
  size?: number;
  running?: boolean;
  local?: boolean;
}) {
  return (
    <span className="logo-mark" style={{ width: size, height: size }} aria-hidden="true">
      <img src={pugHead} width={size} height={size} alt="" draggable={false} />
      {(running || local) && <span className={`logo-dot running${!running && local ? ' local' : ''}`} />}
    </span>
  );
}
