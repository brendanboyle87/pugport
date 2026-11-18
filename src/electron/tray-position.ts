/** Electron window, tray and display coordinates are already device-independent pixels. */
export type TrayRectangle = { x: number; y: number; width: number; height: number };
export type TrayDisplay = { bounds: TrayRectangle; workArea: TrayRectangle };

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high));
const right = (rect: TrayRectangle) => rect.x + rect.width;
const bottom = (rect: TrayRectangle) => rect.y + rect.height;

/** Fit a moved card to its current screen without sending it back to the notification icon. */
export function fitTrayPopup(position: TrayRectangle, area: TrayRectangle): TrayRectangle {
  const width = Math.min(Math.max(1, position.width), Math.max(1, area.width));
  const height = Math.min(Math.max(1, position.height), Math.max(1, area.height));
  return {
    x: Math.round(clamp(position.x, area.x, right(area) - width)),
    y: Math.round(clamp(position.y, area.y, bottom(area) - height)),
    width: Math.round(width),
    height: Math.round(height),
  };
}

/** Anchor to the taskbar edge on the icon's display, including side taskbars and negative origins. */
export function trayPopupBounds(
  icon: TrayRectangle,
  display: TrayDisplay,
  size: { width: number; height: number },
): TrayRectangle {
  const screen = display.bounds;
  const work = display.workArea;
  const center = { x: icon.x + icon.width / 2, y: icon.y + icon.height / 2 };
  const edges = [
    { side: 'bottom', distance: Math.abs(bottom(screen) - center.y), reserved: bottom(screen) - bottom(work) },
    { side: 'top', distance: Math.abs(center.y - screen.y), reserved: work.y - screen.y },
    { side: 'right', distance: Math.abs(right(screen) - center.x), reserved: right(screen) - right(work) },
    { side: 'left', distance: Math.abs(center.x - screen.x), reserved: work.x - screen.x },
  ];
  // A reserved side is reliable only when the icon is near that side. Auto-hide/overflow trays may have
  // no reserved side; then choose the nearest screen edge instead of assuming a bottom/top taskbar.
  const reserved = edges.filter((edge) => edge.reserved > 0 && edge.distance <= edge.reserved + 32);
  const edge = (reserved.length ? reserved : edges).sort((a, b) => a.distance - b.distance)[0]!.side;
  const area = { ...work };
  // Some desktop docks reserve a second strip. If it separates the work area from the actual tray by
  // more than an icon's normal inset, align to the tray, rather than leaving that entire strip blank.
  const inset = Math.max(12, Math.min(32, Math.max(icon.width, icon.height)));
  if (edge === 'bottom' && icon.y - bottom(work) > inset) area.height = Math.min(bottom(screen), icon.y) - area.y;
  else if (edge === 'top' && work.y - bottom(icon) > inset) {
    const y = Math.max(screen.y, bottom(icon));
    area.height = bottom(work) - y;
    area.y = y;
  } else if (edge === 'right' && icon.x - right(work) > inset) area.width = Math.min(right(screen), icon.x) - area.x;
  else if (edge === 'left' && work.x - right(icon) > inset) {
    const x = Math.max(screen.x, right(icon));
    area.width = right(work) - x;
    area.x = x;
  }
  const width = Math.min(Math.max(1, size.width), Math.max(1, area.width));
  const height = Math.min(Math.max(1, size.height), Math.max(1, area.height));
  const position = {
    x: center.x - width / 2,
    y: center.y - height / 2,
    width,
    height,
  };
  if (edge === 'bottom') position.y = bottom(area) - height;
  else if (edge === 'top') position.y = area.y;
  else if (edge === 'right') position.x = right(area) - width;
  else position.x = area.x;
  return fitTrayPopup(position, area);
}
