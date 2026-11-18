type ScrollPane = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

export function createFollowBottom() {
  let following = true;
  return {
    onScroll(pane: ScrollPane) {
      // Hidden details have no viewport and must not change the reader's choice.
      if (pane.clientHeight > 0) following = pane.scrollHeight - pane.clientHeight - pane.scrollTop <= 1;
    },
    update(pane: ScrollPane) {
      if (following && pane.clientHeight > 0) pane.scrollTop = Math.max(0, pane.scrollHeight - pane.clientHeight);
    },
  };
}
