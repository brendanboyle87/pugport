import { packMod } from '../src/server/mod-pack.ts';
import { isMain } from './validate-mod.ts';

// The packing itself lives in src/server/mod-pack.ts, shared with the mod_load bridge tool.
export { packMod };

if (isMain(import.meta.url)) {
  try {
    const [dir, ...args] = process.argv.slice(2);
    if (!dir || dir.startsWith('--')) throw new Error('Usage: mods:pack <dir> [--dev] [--out <file>]');
    const options: { dev?: boolean; out?: string } = {};
    for (let index = 0; index < args.length; index++) {
      if (args[index] === '--dev') options.dev = true;
      else if (args[index] === '--out' && args[index + 1] && !args[index + 1].startsWith('--')) {
        options.out = args[++index];
      } else throw new Error(`Unknown or incomplete option: ${args[index]}`);
    }
    const result = await packMod(dir, options);
    for (const warning of result.warnings) console.warn(warning);
    console.log(`${result.path} (${result.bytes} bytes, ${result.sha256})`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
