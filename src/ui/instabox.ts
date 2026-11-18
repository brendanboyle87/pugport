import type { InstaboxMachineView, RemoteServersView } from '../shared/remote-servers';
import type { Api } from './Workspace';

export async function wakeInstabox(api: Api, machine: InstaboxMachineView): Promise<RemoteServersView> {
  return api<RemoteServersView>(
    '/api/remote-servers/instabox/action',
    { machineId: machine.machineId, action: 'wake' },
    'POST',
  );
}
