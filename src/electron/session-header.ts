type HeaderDetails = {
  webContentsId?: number;
  initiatorOrigin?: string;
  url: string;
  requestHeaders: Record<string, string>;
};

export function attachSessionHeader(
  session: {
    webRequest: {
      onBeforeSendHeaders(
        filter: { urls: string[] },
        listener: (
          details: HeaderDetails,
          callback: (result: { requestHeaders: Record<string, string> }) => void,
        ) => void,
      ): void;
    };
  },
  origin: string,
  token: () => string | undefined,
  windows: Set<number>,
  owner: () => string | undefined = () => undefined,
) {
  session.webRequest.onBeforeSendHeaders({ urls: [`${origin}/*`] }, (details, callback) => {
    const value = token();
    if (
      details.webContentsId !== undefined &&
      windows.has(details.webContentsId) &&
      details.initiatorOrigin === origin &&
      details.url.startsWith(origin + '/') &&
      value
    ) {
      for (const key of Object.keys(details.requestHeaders))
        if (['x-agent-token', 'x-pugport-owner'].includes(key.toLowerCase())) delete details.requestHeaders[key];
      details.requestHeaders['x-agent-token'] = value;
      const ownerValue = owner();
      if (ownerValue) details.requestHeaders['x-pugport-owner'] = ownerValue;
    }
    callback({ requestHeaders: details.requestHeaders });
  });
}

let sessionOwner: () => string | undefined = () => undefined;
export function setSessionOwner(getter: () => string | undefined) {
  sessionOwner = getter;
}
let sessionToken: () => string | undefined = () => undefined;
export function setSessionToken(getter: () => string | undefined) {
  sessionToken = getter;
}
/** Undefined while the backend is starting or recovering. */
export const heldSessionToken = () => sessionToken();
export function backendRequest(url: string, init: RequestInit = {}, request: typeof fetch = fetch) {
  const token = sessionToken();
  return request(
    url,
    token
      ? {
          ...init,
          headers: {
            ...(init.headers as Record<string, string>),
            'x-agent-token': token,
            ...(sessionOwner() ? { 'x-pugport-owner': sessionOwner()! } : {}),
          },
        }
      : init,
  );
}
