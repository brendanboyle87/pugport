import { packager } from '@electron/packager';
import { copyFileSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { verifyLicenseBundle } from './verify-license-bundle.mjs';
import { verifyLitePackage } from './verify-lite-package.mjs';
import {
  copyLocalComponents,
  localComponentsRequested,
  packageIgnore,
  packageLayout,
  packageTarget,
} from './package-policy.mjs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const target = packageTarget();
if (pkg.productName !== 'PugPort') throw new Error('Expected PugPort package identity.');
if (target.platform === 'darwin' && (process.platform !== 'darwin' || target.arch !== process.arch))
  throw new Error('Build the Mac app on a Mac with matching native Node and freshly installed dependencies.');
// Validate the dependencies actually shipped. Native CLI installations and retired
// gateway caches are outside the desktop package.
console.log('License bundle:', verifyLicenseBundle({ root }));
if (process.argv.includes('--check-assets')) {
  console.log('Dependency license materials verified; packaging not run.');
} else {
  let iconDirectory;
  let icon = join(root, 'assets', 'icons', 'pugport.ico');
  try {
    if (target.platform === 'darwin') {
      // Build the macOS container from the vector app icon, which keeps Apple's icon-grid margins.
      iconDirectory = await mkdtemp(join(tmpdir(), 'pugport-package-icon-'));
      const iconset = join(iconDirectory, 'pugport.iconset');
      await mkdir(iconset);
      const { default: sharp } = await import('sharp');
      for (const size of [16, 32, 128, 256, 512])
        for (const scale of [1, 2])
          // The SVG is 1024 px at 72 dpi; the density renders each size from the vector.
          await sharp(join(root, 'assets', 'brand', 'app-icon-mac.svg'), { density: (72 * size * scale) / 1024 })
            .resize(size * scale, size * scale)
            .png()
            .toFile(join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`));
      icon = join(iconDirectory, 'pugport.icns');
      execFileSync('/usr/bin/iconutil', ['--convert', 'icns', '--output', icon, iconset]);
    }
    const paths = await packager({
      dir: root,
      out: join(root, 'release'),
      name: pkg.productName,
      executableName: pkg.productName,
      ...target,
      appVersion: pkg.version,
      buildVersion: pkg.version,
      electronVersion: pkg.devDependencies.electron,
      asar: false,
      icon,
      overwrite: true,
      prune: true,
      ignore: (path) => packageIgnore(path, target),
      ...(target.platform === 'darwin'
        ? {
            appBundleId: 'com.pugport.desktop',
            appCategoryType: 'public.app-category.productivity',
            darwinDarkModeSupport: true,
            protocols: [{ name: 'PugPort conversation', schemes: ['pugport'] }],
            usageDescription: { Microphone: 'PugPort uses the microphone when you record a voice message.' },
            osxSign: false,
          }
        : {}),
      win32metadata: {
        CompanyName: `${pkg.productName} contributors`,
        ProductName: pkg.productName,
        FileDescription: pkg.description,
      },
      appCopyright: `${pkg.productName} contributors`,
    });
    for (const output of paths) {
      const withinRelease = relative(join(root, 'release'), resolve(output));
      if (!withinRelease || isAbsolute(withinRelease) || withinRelease.startsWith('..'))
        throw new Error('Unexpected package output directory.');
      // Electron Packager omits lockfiles; retain the public lock for the offline inventory check.
      const layout = packageLayout(output);
      copyFileSync(join(root, 'package-lock.json'), join(layout.app, 'package-lock.json'));
      if (layout.platform === 'darwin') {
        // A Mac user copies just the .app, so Electron's notices must travel inside it.
        copyFileSync(join(output, 'LICENSE'), layout.electronLicense);
        copyFileSync(join(output, 'LICENSES.chromium.html'), layout.chromiumLicense);
      }
      const components = copyLocalComponents(root, output, { includeComponents: localComponentsRequested() });
      console.log(
        components.length
          ? `Offline components: ${components.join(', ')}`
          : 'Lightweight package: local components are downloaded only when requested in the app.',
      );
      console.log('Packaged license bundle:', verifyLicenseBundle({ root, packageRoot: output }));
      if (!localComponentsRequested()) {
        const inventory = verifyLitePackage(output);
        console.log(`Lightweight package verified: ${inventory.fileCount} files, ${inventory.totalBytes} bytes.`);
      }
      console.log(output);
    }
  } finally {
    if (iconDirectory) await rm(iconDirectory, { recursive: true, force: true });
  }
}
