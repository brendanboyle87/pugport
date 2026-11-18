import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const PDF_TEXT_MAX_BYTES = 30 * 1024 * 1024;
export const PDF_TEXT_MAX_PAGES = 500;
// pdfminer.six comes with the "Read local documents" component (MarkItDown). Text only: scanned pages come back empty.
const script = `
import json, sys
from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer
pages = []
for number, layout in enumerate(extract_pages(sys.argv[1]), 1):
    if number > ${PDF_TEXT_MAX_PAGES}:
        break
    pages.append({"page": number, "text": "".join(e.get_text() for e in layout if isinstance(e, LTTextContainer))})
sys.stdout.write(json.dumps(pages))
`;

export class PdfTextError extends Error {
  constructor(readonly code: 'E_INVALID' | 'E_UNAVAILABLE' | 'E_LIMIT') {
    super(
      { E_INVALID: 'Invalid request.', E_UNAVAILABLE: 'Mod is unavailable.', E_LIMIT: 'Request limit exceeded.' }[code],
    );
  }
}

/** Page-by-page text of a PDF, so each extracted line can point back to its page. The file is deleted afterwards. */
export async function pdfPages(python: string | undefined, bytes: Buffer): Promise<{ page: number; text: string }[]> {
  if (!python) throw new PdfTextError('E_UNAVAILABLE');
  if (bytes.length > PDF_TEXT_MAX_BYTES) throw new PdfTextError('E_LIMIT');
  if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new PdfTextError('E_INVALID');
  const directory = await mkdtemp(join(tmpdir(), 'pugport-pdf-'));
  try {
    const file = join(directory, 'statement.pdf');
    await writeFile(file, bytes, { mode: 0o600 });
    const { stdout } = await run(python, ['-I', '-c', script, file], {
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      windowsHide: true,
    }).catch(() => {
      throw new PdfTextError('E_INVALID');
    });
    const pages = JSON.parse(stdout) as { page: number; text: string }[];
    return pages.map((item) => ({ page: item.page, text: item.text.replace(/\r\n?/g, '\n').trimEnd() }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
