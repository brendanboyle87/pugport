import { createHash } from 'node:crypto';

/** Bump when the fixed verifier's matching rules or sampling plan change. */
export const mediaPairVerificationVersion = 'fixed-media-verifier-v2-bounded-reject';

/** A negative checkpoint means these bounded checks finished, never that whole contents differ. */
export function mediaPairCheckpointKey(input: {
  pair: string;
  mode: 'legacy' | 'adaptive' | 'full-index';
  decoder: string;
  videoSampleSeconds: number;
  anchors: readonly { a: number; b: number; score: number }[];
  version?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: input.version ?? mediaPairVerificationVersion,
        pair: input.pair,
        mode: input.mode,
        decoder: input.decoder,
        videoSampleSeconds: input.videoSampleSeconds,
        anchors: input.anchors,
      }),
    )
    .digest('hex');
}
