/** Measure natural height in CSS/DIP pixels, even while quota rows are clipped by the current window. */
export const trayPopupMeasurementScript = `(() => {
  const card = document.querySelector('.card');
  if (!card) return null;
  const cpu = document.querySelector('[data-resource-part="cpu-detail"]');
  if (cpu?.dataset.full) {
    cpu.textContent = cpu.dataset.full;
    if (cpu.scrollWidth > cpu.clientWidth && cpu.dataset.model) cpu.textContent = cpu.dataset.model;
  }
  const quota = document.getElementById('quota-content');
  const scrollTop = quota?.scrollTop ?? 0;
  const previous = card.style.maxHeight;
  card.style.maxHeight = 'none';
  const height = card.getBoundingClientRect().bottom + 6;
  card.style.maxHeight = previous;
  if (quota) quota.scrollTop = scrollTop;
  return height;
})()`;

/** Patch trusted, escaped tray markup in place so live readings never reload or flash the window. */
export function trayPopupUpdateScript(html: string): string {
  return `(() => {
    const next = new DOMParser().parseFromString(${JSON.stringify(html)}, 'text/html');
    const resources = document.getElementById('system-resources');
    if (!resources) return null;
    const parts = [...next.querySelectorAll('[data-resource-part]')].map(part => [
      resources.querySelector('[data-resource-part="' + part.getAttribute('data-resource-part') + '"]'), part
    ]);
    const sections = ['quota-content', 'tray-actions'].map(id => [
      document.getElementById(id), next.getElementById(id)
    ]);
    if (parts.some(([current]) => !current) || sections.some(([current, replacement]) => !current || !replacement)) return null;
    for (const [current, replacement] of parts) {
      // Cells keep their children; text leaves and bars keep their identity and CSS transitions.
      if (!replacement.children.length && current.textContent !== replacement.textContent) current.textContent = replacement.textContent;
      for (const attribute of ['title', 'style', 'aria-label', 'data-model', 'data-full']) {
        const value = replacement.getAttribute(attribute);
        if (current.getAttribute(attribute) === value) continue;
        if (value === null) current.removeAttribute(attribute);
        else current.setAttribute(attribute, value);
      }
    }
    for (const [current, replacement] of sections) {
      if (current.innerHTML !== replacement.innerHTML) {
        const scrollTop = current.scrollTop;
        current.innerHTML = replacement.innerHTML;
        current.scrollTop = scrollTop;
      }
    }
    const label = next.getElementById('system-resources').getAttribute('aria-label');
    if (label !== null) resources.setAttribute('aria-label', label);
    return ${trayPopupMeasurementScript};
  })()`;
}
