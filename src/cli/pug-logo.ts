import { backgroundAnsi, foregroundAnsi, rgbColor, type TerminalColorMode } from './pi-tui.ts';

/**
 * PugPort's pug, drawn with characters. Each letter is one square pixel; two pixel rows share one text line
 * through half blocks, so this 22 x 18 grid prints as 22 columns by 9 lines. Edit the grid or the colours here
 * to change the logo everywhere.
 */
const pixels = [
  '...EEEE........EEEE...',
  '..EEEEEEFFFFFFEEEEEE..',
  '.EEEEEEFFFFFFFFEEEEEE.',
  'EEEEEEFFFFFFFFFFEEEEEE',
  'EEEE.FFFFDDDDFFFF.EEEE',
  'EEE.FFFFFFFFFFFFFF.EEE',
  '.E..FFFFFFFFFFFFFF..E.',
  '...FFKKKKFFFFKKKKFF...',
  '..FFKWWKKKFFKWWKKKFF..',
  '..FFKWKKKKFFKWKKKKFF..',
  '..FFKKKKKDDDDKKKKKFF..',
  '..FFFKKKDDNNDDKKKFFF..',
  '..FFFFFDDNNNNDDFFFFF..',
  '..FFFFDDDDNNDDDDFFFF..',
  '...FFFDDDDDDDDDDFFF...',
  '...FFFFDDDPPDDDFFFF...',
  '....FFFFFDPPDFFFFF....',
  '......FFFFFFFFFF......',
];
const colours = {
  E: rgbColor(92, 64, 48), // folded ears
  F: rgbColor(228, 186, 120), // fawn coat
  D: rgbColor(58, 42, 34), // dark muzzle mask and forehead wrinkle
  K: rgbColor(24, 20, 18), // eyes
  W: rgbColor(250, 248, 244), // eye shine
  N: rgbColor(12, 10, 10), // nose
  P: rgbColor(236, 122, 138), // tongue
} as const;

/** Without colours, a line drawing that still reads as a pug: folded ears, big eyes, flat muzzle. */
const plain = [
  ' .-.            .-.',
  '( ( `.--------.` ) )',
  ' `-./ __    __ \\.-`',
  '    | (@)  (@) |',
  '    |   .--.   |',
  '     \\ (_oo_) /',
  '      `.____.`',
];

export const pugLogoWidth = 22;
/** The one-line pug, for narrow terminals and `pugport --help`. */
export const pugFace = '(•ᴥ•)';

/** The pug as terminal lines, each `pugLogoWidth` columns wide. */
export function pugLogoLines(options: { color: boolean; mode?: TerminalColorMode }): string[] {
  if (!options.color) return plain.map((line) => line.padEnd(pugLogoWidth));
  const mode = options.mode ?? 'truecolor';
  const lines: string[] = [];
  for (let row = 0; row < pixels.length; row += 2) {
    let line = '';
    for (let column = 0; column < pugLogoWidth; column++) {
      const top = colours[pixels[row]![column] as keyof typeof colours];
      const bottom = colours[pixels[row + 1]?.[column] as keyof typeof colours];
      if (top && bottom) line += `${foregroundAnsi(top, mode)}${backgroundAnsi(bottom, mode)}▀\x1b[0m`;
      else if (top) line += `${foregroundAnsi(top, mode)}▀\x1b[0m`;
      else if (bottom) line += `${foregroundAnsi(bottom, mode)}▄\x1b[0m`;
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}
