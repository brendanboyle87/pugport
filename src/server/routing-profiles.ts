import type { Conversation, Project, Settings } from '../shared/types.ts';
import { routingProfileLimit, routingProfileSchema, type RoutingProfile } from '../shared/routing-profiles.ts';
import type { WorkspaceStore } from './workspace-store.ts';

export class RoutingProfileConflict extends Error {
  readonly status = 409;
}

/** Local saved rules only. Updating a definition never rewrites a workflow's captured routing context. */
export class RoutingProfiles {
  constructor(
    private readonly host: {
      store: WorkspaceStore;
      settings(): Settings;
      save(patch: Pick<Settings, 'routingProfiles'>): void;
    },
  ) {}
  list(): RoutingProfile[] {
    return structuredClone(this.host.settings().routingProfiles ?? []);
  }
  put(value: RoutingProfile) {
    const profile = routingProfileSchema.parse(value);
    const profiles = this.list();
    const index = profiles.findIndex((item) => item.id === profile.id);
    if (index < 0 && profiles.length >= routingProfileLimit) throw Error('最多保存 30 套路由方案。');
    if (
      profiles.some(
        (item) => item.id !== profile.id && item.name.toLocaleLowerCase() === profile.name.toLocaleLowerCase(),
      )
    )
      throw Error('已有同名路由方案，请换一个名称。');
    const saved = { ...profile, rules: { ...profile.rules, updatedAt: new Date().toISOString() } };
    if (index >= 0) profiles[index] = saved;
    else profiles.push(saved);
    this.host.save({ routingProfiles: profiles });
    return { profiles: this.list() };
  }
  remove(id: string) {
    if (
      this.host.store
        .list<Project>('project', undefined, Number.MAX_SAFE_INTEGER)
        .some((project) => project.routingProfileId === id)
    )
      throw new RoutingProfileConflict('仍有项目使用这套路由方案，请先更改项目的默认路由。');
    if (
      this.host.store
        .list<Conversation>('conversation', undefined, Number.MAX_SAFE_INTEGER)
        .some(
          (conversation) => !conversation.deletedAt && !conversation.closedAt && conversation.routingProfileId === id,
        )
    )
      throw new RoutingProfileConflict('仍有对话使用这套路由方案，请先在这些对话中切回自动。');
    this.host.save({ routingProfiles: this.list().filter((profile) => profile.id !== id) });
    return { profiles: this.list() };
  }
}
