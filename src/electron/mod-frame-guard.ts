import type { Session, WebContents, WebFrameMain } from 'electron';
import { appNavigationAllowed } from './navigation.ts';

const sessions = new WeakMap<Session, Map<number, { contents: WebContents; origin: string }>>();

export function isAppMainFrame(contents: WebContents, frame: WebFrameMain | null | undefined, origin: string) {
  if (contents.isDestroyed() || !frame || frame !== contents.mainFrame) return false;
  try {
    return new URL(frame.url).origin === origin;
  } catch {
    return false;
  }
}

/** Session handlers are shared by the main window and every conversation pop-out. */
function protectSession(contents: WebContents, origin: string) {
  const session = contents.session;
  let owners = sessions.get(session);
  if (!owners) {
    owners = new Map();
    sessions.set(session, owners);
    const windows = owners;
    const trusted = (sender: WebContents | null, isMainFrame: boolean, url: string | undefined) => {
      if (!sender || !isMainFrame || !url) return false;
      const owner = windows.get(sender.id);
      if (!owner || !isAppMainFrame(sender, sender.mainFrame, owner.origin)) return false;
      try {
        return new URL(url).origin === owner.origin;
      } catch {
        return false;
      }
    };
    session.setPermissionRequestHandler((sender, _permission, callback, details) => {
      callback(trusted(sender, details.isMainFrame, details.requestingUrl));
    });
    session.setPermissionCheckHandler((sender, _permission, requestingOrigin, details) =>
      trusted(sender, details.isMainFrame, details.requestingUrl ?? requestingOrigin),
    );
    // No application feature uses HID, USB or serial device grants.
    session.setDevicePermissionHandler(() => false);
    session.on('will-download', (event, _item, sender, frame) => {
      const owner = windows.get(sender.id);
      if (owner && !isAppMainFrame(sender, frame, owner.origin)) event.preventDefault();
    });
    session.webRequest.onBeforeRequest((details, callback) => {
      const owner = details.webContentsId === undefined ? undefined : windows.get(details.webContentsId);
      // Null frame attribution is not a capability to make a network request.
      callback({
        cancel:
          !!owner &&
          details.frame !== owner.contents.mainFrame &&
          !/^(?:data:|blob:|about:blank$|about:srcdoc$)/.test(details.url),
      });
    });
    session.webRequest.onHeadersReceived((details, callback) => {
      if (details.webContentsId === undefined || !windows.has(details.webContentsId)) return callback({});
      callback({
        responseHeaders: { ...details.responseHeaders, 'X-DNS-Prefetch-Control': ['off'] },
      });
    });
  }
  owners.set(contents.id, { contents, origin });
  contents.once('destroyed', () => owners.delete(contents.id));
}

/** Candidate network policy; real HTTP/DNS/STUN receiver tests are the acceptance gate. */
export function installModFrameGuard(
  contents: WebContents,
  origin: string,
  openExternal: (url: string) => Promise<unknown>,
) {
  protectSession(contents, origin);
  // Voice.tsx captures microphone audio; the app does not create WebRTC peer connections.
  contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  // Electron's popup callback has no authoritative initiator. Main-frame links use authenticated IPC.
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
  });
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame) {
      if (event.url !== 'about:srcdoc' && event.url !== 'about:blank') event.preventDefault();
      return;
    }
    if (!isAppMainFrame(contents, event.initiator, origin)) event.preventDefault();
  });
  contents.on('will-navigate', (event) => {
    if (!isAppMainFrame(contents, event.initiator, origin)) {
      event.preventDefault();
      return;
    }
    if (!appNavigationAllowed(event.url, origin)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(event.url)) void openExternal(event.url);
    }
  });
}
