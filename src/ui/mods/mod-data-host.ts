import type { BankConnectionView, LinkSessionView, ModDataMethod, ModPdfText } from '../../shared/mod-data';
import { requestBankLink } from '../BankLinkDialog';
import { ModBridgeError } from './mod-host-bridge';

type Api = <T>(path: string, body?: unknown, method?: string) => Promise<T>;
export type ModDataHost = {
  call(method: ModDataMethod, args: Record<string, unknown>, canShow?: () => boolean): Promise<unknown>;
  /** Connections this Mod may read, for the `connections` event. */
  connections(): Promise<BankConnectionView[]>;
};
const TEXT_CHUNK = 256 * 1024;
const FILES_MAX = 8;
const FILE_MAX_BYTES = 30 * 1024 * 1024;

/** Opens the host's own file chooser. The Mod frame never sees a path, only the file the user picked. */
function chooseFile(accept: readonly string[]): Promise<File | undefined> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept.join(',');
    input.addEventListener('change', () => resolve(input.files?.[0]), { once: true });
    input.addEventListener('cancel', () => resolve(undefined), { once: true });
    input.click();
  });
}

/**
 * The data, connection and file half of a Mod binding. Server calls carry the instance ID; the server derives the
 * Mod from the chat's binding. Picked files stay in this window and end with the binding.
 */
export function createModDataHost(input: {
  api: Api;
  conversationId: string;
  instanceId: string;
  modId: string;
  title: string;
  pick?: typeof chooseFile;
}): ModDataHost {
  const files = new Map<string, { file: File; text?: string; pdf?: ModPdfText }>();
  const server = <T>(method: ModDataMethod, params: Record<string, unknown>) =>
    input.api<T>(`/api/conversations/${encodeURIComponent(input.conversationId)}/mod-data`, {
      instanceId: input.instanceId,
      method,
      params,
    });
  const held = (fileId: unknown) => {
    const entry = typeof fileId === 'string' ? files.get(fileId) : undefined;
    if (!entry) throw new ModBridgeError('E_INVALID');
    return entry;
  };
  async function link(
    method: 'connections.authorize' | 'connections.reconnect',
    args: Record<string, unknown>,
    canShow?: () => boolean,
  ) {
    // One Plaid step at a time; a Mod cannot stack dialogs over the user's.
    await requestBankLink({
      api: input.api,
      start: () => server<LinkSessionView>(method, args),
      requester: input.title,
      modId: input.modId,
      canShow,
    });
    // The result arrives as a `connections` event; the Plaid page and its address stay with the host.
    return { status: 'pending' };
  }
  return {
    connections: async () => (await server<{ connections: BankConnectionView[] }>('connections.list', {})).connections,
    async call(method, args, canShow) {
      switch (method) {
        case 'connections.authorize':
        case 'connections.reconnect':
          return link(method, args, canShow);
        case 'files.pick': {
          const file = await (input.pick ?? chooseFile)(args.accept as string[]);
          if (!file) return { cancelled: true };
          const extension = `.${file.name.split('.').at(-1)?.toLowerCase() ?? ''}`;
          if (!(args.accept as string[]).includes(extension) || file.size > FILE_MAX_BYTES)
            throw new ModBridgeError('E_INVALID');
          if (files.size >= FILES_MAX) files.delete(files.keys().next().value!);
          const fileId = `file_${crypto.randomUUID()}`;
          files.set(fileId, { file });
          return { fileId, name: file.name, size: file.size, type: extension.slice(1) };
        }
        case 'files.readText': {
          const entry = held(args.fileId);
          if (entry.file.name.toLowerCase().endsWith('.pdf')) throw new ModBridgeError('E_INVALID');
          entry.text ??= await entry.file.text();
          const offset = (args.offset as number | undefined) ?? 0;
          const text = entry.text.slice(offset, offset + TEXT_CHUNK);
          return {
            text,
            length: entry.text.length,
            ...(offset + TEXT_CHUNK < entry.text.length ? { nextOffset: offset + TEXT_CHUNK } : {}),
          };
        }
        case 'files.pdfText': {
          const entry = held(args.fileId);
          if (!entry.file.name.toLowerCase().endsWith('.pdf')) throw new ModBridgeError('E_INVALID');
          const fromPage = (args.fromPage as number | undefined) ?? 1;
          return input.api<ModPdfText>(
            `/api/conversations/${encodeURIComponent(input.conversationId)}/mod-files/pdf-text?instanceId=${encodeURIComponent(input.instanceId)}&fromPage=${fromPage}`,
            new Blob([await entry.file.arrayBuffer()], { type: 'application/pdf' }),
          );
        }
        default:
          return server(method, args);
      }
    },
  };
}
