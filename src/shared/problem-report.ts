import { diagnosticInput, redactDiagnosticText } from './diagnostics.ts';
import type { AppState } from './types.ts';

export type ProblemReportImage = { dataUrl: string };
export type ProblemReportPayload = {
  installId: string;
  version: string;
  os: string;
  description: string;
  diagnostics: Record<string, unknown>;
};
export type ProblemReportSummary = {
  localId: string;
  id?: string;
  description: string;
  status: 'draft' | 'sent' | 'fixed';
  fixedIn?: string;
  imageCount: number;
};
export type ProblemReportInboxItem = {
  id: string;
  createdAt: string;
  description: string;
  diagnostics?: Record<string, unknown>;
  version: string;
  os: string;
  status: 'new' | 'seen' | 'fixed' | 'ignored';
  fixedIn?: string;
  images: string[];
  duplicateCount: number;
  taskId?: string;
};
export const problemReportLimits = { description: 4000, diagnostics: 200 * 1024, images: 4, imageBytes: 1024 * 1024 };

export function redactProblemValue(value: unknown): unknown {
  if (typeof value === 'string') return redactDiagnosticText(value);
  if (Array.isArray(value)) return value.map(redactProblemValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [
          redactDiagnosticText(key),
          /(?:key|token|secret|password)$/i.test(key) ? '[secret]' : redactProblemValue(item),
        ]),
    );
  return value;
}

export function buildProblemReport(input: {
  installId: string;
  state: Pick<AppState, 'app' | 'runtimes'>;
  description: string;
  errors?: string;
  task?: unknown;
  conversation?: unknown;
}): ProblemReportPayload {
  const environment = diagnosticInput(input.state);
  return {
    installId: input.installId,
    version: redactDiagnosticText(environment.version ?? ''),
    os: redactDiagnosticText(environment.os ?? ''),
    description: redactDiagnosticText(input.description),
    diagnostics: redactProblemValue({
      environment,
      errors: (input.errors ?? '').split(/\r?\n/).slice(-200).join('\n'),
      ...(input.task ? { task: input.task } : {}),
      ...(input.conversation !== undefined ? { conversation: input.conversation } : {}),
    }) as Record<string, unknown>,
  };
}

export function validateProblemReport(payload: ProblemReportPayload, images: ProblemReportImage[]): void {
  if (
    !payload ||
    typeof payload.installId !== 'string' ||
    payload.installId.length > 100 ||
    !payload.installId ||
    typeof payload.description !== 'string' ||
    payload.description.length > problemReportLimits.description ||
    typeof payload.version !== 'string' ||
    payload.version.length > 120 ||
    typeof payload.os !== 'string' ||
    payload.os.length > 120 ||
    !payload.diagnostics ||
    typeof payload.diagnostics !== 'object' ||
    Array.isArray(payload.diagnostics)
  )
    throw Error('INVALID_REPORT');
  if (Object.keys(payload).some((key) => !['installId', 'version', 'os', 'description', 'diagnostics'].includes(key)))
    throw Error('INVALID_REPORT');
  if (JSON.stringify(redactProblemValue(payload)) !== JSON.stringify(payload)) throw Error('UNREDACTED_REPORT');
  if (new TextEncoder().encode(JSON.stringify(payload.diagnostics)).length > problemReportLimits.diagnostics)
    throw Error('DIAGNOSTICS_TOO_LARGE');
  validateProblemImages(images);
  if (!payload.description.trim() && !images.length) throw Error('EMPTY_REPORT');
}

export function validateProblemImages(images: ProblemReportImage[]): void {
  if (!Array.isArray(images) || images.length > problemReportLimits.images) throw Error('TOO_MANY_IMAGES');
  for (const image of images) {
    const match =
      typeof image?.dataUrl === 'string' &&
      /^data:image\/(jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image.dataUrl);
    if (
      !match ||
      match[2].length % 4 ||
      (match[2].length * 3) / 4 - (match[2].match(/=+$/)?.[0].length ?? 0) > problemReportLimits.imageBytes
    )
      throw Error('INVALID_IMAGE');
  }
}
