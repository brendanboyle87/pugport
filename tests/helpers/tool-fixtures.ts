import { allowTestTool } from '../../src/server/platform/under-test.ts';
import { findMediaExecutables } from '../../src/server/media-decoder.ts';

export function useMediaFixture() {
  const installed = findMediaExecutables(process.cwd());
  allowTestTool(installed.ffmpeg);
  allowTestTool(installed.ffprobe);
  return () => {};
}
