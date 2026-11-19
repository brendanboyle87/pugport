'use strict';

// A frame that a navigation, a reload or a React remount has just replaced stays in `mainFrame.frames` for a moment;
// any getter on it (even `url`) then throws this. Slow machines hit that window often enough to fail a test.
const DISPOSED = /Render frame was disposed before WebFrameMain could be accessed/;

/** Whether an error only says the frame went away, so the caller should look the frame up again. */
function frameDisposed(error) {
  return DISPOSED.test(String(error?.message ?? error));
}

/** The live `about:srcdoc` child frames of a window, skipping frames disposed while they are being listed. */
function srcdocFrames(contents) {
  const found = [];
  let frames;
  try {
    frames = contents.mainFrame.frames;
  } catch (error) {
    if (frameDisposed(error)) return found;
    throw error;
  }
  for (const frame of frames)
    try {
      if (frame.url === 'about:srcdoc') found.push(frame);
    } catch (error) {
      if (!frameDisposed(error)) throw error;
    }
  return found;
}

module.exports = { frameDisposed, srcdocFrames };
