// A console thumbnail source: a screencast of one tab. Frames only arrive
// when the page repaints, and they are downscaled without the viewport
// emulation a captureScreenshot clip brings (overlapping clipped captures
// restore each other's emulation and leave the live page laid out at
// thumbnail width).

import { CdpClient } from './cdp-client.mjs';

export class Screencast {
  // interval(): how often a frame may go out at most (re-read on reschedule);
  // onFrame(jpeg): hands one out, false when it was not sent (unchanged);
  // onEnd(): the tab or its connection is gone.
  constructor(pipe, targetId, { interval, onFrame, onEnd }) {
    this.id = targetId;
    this.interval = interval;
    this.onFrame = onFrame;
    this.onEnd = onEnd;
    this.cdp = null;
    this.closed = false;
    this.frame = null; // the latest frame not sent yet
    this.sentAt = 0;
    this.timer = null;
    this.every = interval();
    this.start(pipe);
  }

  async start(pipe) {
    try {
      const cdp = await CdpClient.connect(pipe, { targetId: this.id });
      if (this.closed) return cdp.close();
      this.cdp = cdp;
      cdp.ws.once('close', () => this.onEnd()); // the next tick retries
      // Late acks slow chromium down (a frame at most every ackMs, so a sent
      // thumbnail is at most that old), but it keeps a few frames in flight,
      // so the frames are throttled here too: the latest one goes out at most
      // every this.every.
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        setTimeout(() => {
          if (!this.closed) cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => { /* tab gone */ });
        }, Math.min(this.interval() / 2, 5000));
        this.frame = data;
        this.schedule();
      });
      await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 640, maxHeight: 400 });
    } catch {
      // the tab closed in between; the next tick retries if it is still current
      this.onEnd();
    }
  }

  schedule() {
    this.timer ??= setTimeout(() => this.flush(), Math.max(0, this.sentAt + this.every - Date.now()));
  }

  flush() {
    this.timer = null;
    const data = this.frame;
    this.frame = null;
    if (this.closed || !data) return;
    if (this.onFrame(data) !== false) this.sentAt = Date.now();
  }

  // The interval may have changed (the browser came to the front, or went
  // behind): a frame waiting for the old one goes by the new one.
  reschedule() {
    if (this.every === this.interval()) return;
    this.every = this.interval();
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
    this.schedule();
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.cdp?.close();
  }
}
