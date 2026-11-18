if (process.env.PUGPORT_VISIBLE_TESTS !== '1') {
  console.error('Visible test helper requires PUGPORT_VISIBLE_TESTS=1');
  process.exit(1);
}

const { app, BrowserWindow } = require('electron');
const { writeFileSync } = require('node:fs');
const { join } = require('node:path');

app.setPath('userData', join(__dirname, 'child-profile'));
app.disableHardwareAcceleration();
setTimeout(() => app.exit(1), 40000);
app.whenReady().then(async () => {
  await new Promise((resolve) => setTimeout(resolve, Number(process.argv[2]) || 0));
  // Normal default show behavior: the launcher, not this app, must minimize it.
  const window = new BrowserWindow({ webPreferences: { sandbox: true } });
  window.webContents.session.webRequest.onBeforeRequest((details, done) =>
    done({ cancel: !details.url.startsWith('data:') }),
  );
  await window.loadURL('data:text/html,<title>Synthetic Grok launch</title>');
  const deadline = Date.now() + 30000;
  const timer = setInterval(() => {
    if ((!window.isMinimized() || window.isFocused()) && Date.now() < deadline) return;
    clearInterval(timer);
    writeFileSync(
      join(__dirname, 'child.json'),
      JSON.stringify({
        minimized: window.isMinimized(),
        focused: window.isFocused(),
        inheritedNodeMode: process.env.ELECTRON_RUN_AS_NODE ?? null,
        inheritedPugPort: process.env.PUGPORT_SYNTHETIC ?? null,
      }),
      'utf8',
    );
    setTimeout(() => app.exit(0), 1000);
  }, 100);
});
