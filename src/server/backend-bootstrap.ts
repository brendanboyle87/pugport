type BootstrapTransport = {
  connected?: boolean;
  send?: (value: unknown) => unknown;
  on: (event: 'message' | 'disconnect', callback: (value?: unknown) => void) => unknown;
  off: (event: 'message' | 'disconnect', callback: (value?: unknown) => void) => unknown;
};

export function waitForPosixContainment(transport: BootstrapTransport, timeoutMs = 10000): Promise<void> {
  return new Promise((done, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      transport.off('message', message);
      transport.off('disconnect', disconnected);
      if (error) reject(error);
      else done();
    };
    const disconnected = () => finish(new Error('桌面连接已关闭，后台未启动。'));
    const message = (input?: unknown) => {
      const value = input as { type?: string; path?: string; token?: string } | undefined;
      if (value?.type !== 'posix-containment-go') return;
      if (
        typeof value.path !== 'string' ||
        !value.path.startsWith('/tmp/pugport-guard-') ||
        typeof value.token !== 'string' ||
        !/^[a-f0-9]{32}$/.test(value.token)
      )
        return finish(new Error('后台进程保护握手无效。'));
      process.env.PUGPORT_POSIX_GUARD_SOCKET = value.path;
      process.env.PUGPORT_POSIX_GUARD_TOKEN = value.token;
      finish();
    };
    const timer = setTimeout(() => finish(new Error('后台进程保护启动超时，未加载服务。')), timeoutMs);
    transport.on('message', message);
    transport.on('disconnect', disconnected);
    if (!transport.connected || !transport.send) return disconnected();
    transport.send({ type: 'posix-containment-bootstrap' });
  });
}

/** No server module, worker, timer or child process can start before this gate opens. */
export function waitForBackendContainment(transport: BootstrapTransport, timeoutMs = 40000): Promise<void> {
  return new Promise((done, reject) => {
    let nonce = '';
    const finish = (error?: Error) => {
      clearTimeout(timer);
      transport.off('message', message);
      transport.off('disconnect', disconnected);
      if (error) reject(error);
      else done();
    };
    const disconnected = () => finish(new Error('桌面连接已关闭，后台未启动。'));
    const message = (input?: unknown) => {
      const value = input as { type?: string; nonce?: string; birth?: string } | undefined;
      if (
        value?.type === 'containment-challenge' &&
        typeof value.nonce === 'string' &&
        /^[a-f0-9]{32}$/.test(value.nonce) &&
        typeof value.birth === 'string' &&
        /^\d{16,20}$/.test(value.birth)
      ) {
        nonce = value.nonce;
        transport.send?.({ type: 'containment-challenge-ack', nonce, birth: value.birth });
      } else if (value?.type === 'containment-go' && nonce && value.nonce === nonce) finish();
    };
    const timer = setTimeout(() => finish(new Error('后台进程保护启动超时，未加载服务。')), timeoutMs);
    transport.on('message', message);
    transport.on('disconnect', disconnected);
    if (!transport.connected || !transport.send) return disconnected();
    transport.send({ type: 'containment-bootstrap' });
  });
}
