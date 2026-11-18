import type { ModManifestV2 } from '../../shared/mods-manifest';

export type ModSlot = 'mainView' | 'rightPanel' | 'sidebarPanel';
type Surface = { mounted: boolean; visible: boolean };

export function modChatPlacement(bodyWidth: number, viewportWidth: number): 'beside' | 'over' {
  return bodyWidth - Math.min(420, Math.max(380, viewportWidth * 0.3)) >= 640 ? 'beside' : 'over';
}

/** Ownership is supplied by Studio's existing first-pane selection, separately in each window. */
export function resolveModLayout(
  manifest: ModManifestV2 | null | undefined,
  hidden: boolean,
  sideChatOpen: boolean,
  ownsSurfaces = true,
) {
  const contributions = manifest?.contributions;
  const right = contributions?.rightPanel;
  const present = {
    mainView: !!contributions?.mainView,
    rightPanel:
      !!right &&
      (right.kind === 'web' || !!(right.form.markdown || right.form.fields.length || right.form.actions.length)),
    sidebarPanel: !!contributions?.sidebarPanel,
  };
  const surface = (slot: ModSlot): Surface => ({
    mounted: ownsSurfaces && present[slot],
    visible:
      ownsSurfaces &&
      present[slot] &&
      !hidden &&
      (slot === 'mainView' || !present.mainView) &&
      (slot !== 'rightPanel' || !sideChatOpen),
  });
  const mainView = surface('mainView');
  const rightPanel = surface('rightPanel');
  const sidebarPanel = surface('sidebarPanel');
  return {
    mainView,
    rightPanel,
    sidebarPanel,
    hasSurface: Object.values(present).some(Boolean),
    main: mainView.visible ? ('mod' as const) : ('chat' as const),
    right:
      !mainView.visible && sideChatOpen
        ? ('sideChat' as const)
        : rightPanel.visible
          ? ('mod' as const)
          : ('none' as const),
  };
}
