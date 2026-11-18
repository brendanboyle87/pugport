import type { ConversationModesView, ModeCatalogEntry } from './conversation-modes';
import type { ModeSourceView } from './mode-source';

export type StoreMode = ModeCatalogEntry & { sourceRevision?: string; sourceRepository?: string };

/** Invalid versions never outrank a valid release; ties preserve the local package. */
export function compareModVersions(left: string, right: string): number {
  const parse = (value: string) =>
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) ? value.split('.').map(BigInt) : undefined;
  const a = parse(left),
    b = parse(right);
  if (!a || !b) return Number(!!a) - Number(!!b);
  for (let i = 0; i < 3; i++) {
    if (a[i]! !== b[i]!) return a[i]! > b[i]! ? 1 : -1;
  }
  return 0;
}

export function selectStoreModes(data?: ConversationModesView, source?: ModeSourceView) {
  const localKeys = new Set(data?.catalog.map((mode) => `${mode.id}@${mode.version}`));
  const catalog = new Map<string, StoreMode>();
  const add = (mode: StoreMode) => {
    const current = catalog.get(mode.id);
    if (!current || compareModVersions(mode.version, current.version) > 0) catalog.set(mode.id, mode);
  };
  data?.catalog.forEach(add);
  if (source?.config?.enabled && source.revision) {
    for (const mode of source.catalog)
      add({
        ...mode,
        schemaVersion: mode.schemaVersion ?? 1,
        sourceRevision: source.revision,
        sourceRepository: source.config.repository,
      });
  }
  const installations = new Map(data?.installed.map((item) => [item.modeId, item]));
  const localBuilds = new Map(data?.catalog.flatMap((mode) => (mode.localBuild ? [[mode.id, mode.localBuild]] : [])));
  return new Map(
    [...catalog].map(([id, mode]) => {
      const installation = installations.get(id);
      return [
        id,
        {
          mode,
          installation,
          /** Built in a Mods author chat on this computer; kept even when a catalog source has a newer version. */
          localBuild: localBuilds.get(id),
          local: localKeys.has(`${id}@${mode.version}`),
          updateAvailable: !!installation && compareModVersions(mode.version, installation.version) > 0,
        },
      ];
    }),
  );
}
