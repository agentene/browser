// A console thumbnail source: a screencast of one tab. Frames only arrive
// when the page repaints, and they are downscaled without the viewport
// emulation a captureScreenshot clip brings (overlapping clipped captures
// restore each other's emulation and leave the live page laid out at
// thumbnail width).

import { CdpClient } from './cdp-client.mjs';

// How long before a frame may go out the frame for it is asked for (one
// ack): enough for chromium to repaint and encode it, so the thumbnail is
// about this fresh rather than an interval old.
export const ACK_LEAD_MS = 250;

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
    // Chromium sends a frame only while it has a free slot (a few frames
    // may wait for an ack), and every frame it encodes costs a JPEG, its
    // base64 and its parse here. So frames are acked at most one per
    // interval, ACK_LEAD_MS before the next one may go out: chromium
    // encodes about as many frames as go out, the latest at that moment.
    this.unacked = 0;
    this.castSession = null; // Page.screencastFrame's sessionId, echoed in acks
    this.ackedAt = Date.now(); // the first frames come without one
    this.ackTimer = null;
    this.start(pipe);
  }

  async start(pipe) {
    try {
      const cdp = await CdpClient.connect(pipe, { targetId: this.id });
      if (this.closed) return cdp.close();
      this.cdp = cdp;
      cdp.ws.once('close', () => this.onEnd()); // the next tick retries
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        this.castSession = sessionId;
        this.unacked++;
        this.frame = data;
        this.schedule();
        this.scheduleAck();
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
    this.scheduleAck(); // the sent frame's slot goes back before the next send
  }

  scheduleAck() {
    if (this.ackTimer !== null || !this.unacked || this.closed) return;
    const at = Math.max(this.sentAt + this.every - ACK_LEAD_MS, this.ackedAt + this.every);
    this.ackTimer = setTimeout(() => this.ack(), Math.max(0, at - Date.now()));
  }

  ack() {
    this.ackTimer = null;
    if (this.closed || !this.unacked) return;
    this.unacked--;
    this.ackedAt = Date.now();
    this.cdp.send('Page.screencastFrameAck', { sessionId: this.castSession }).catch(() => { /* tab gone */ });
    this.scheduleAck();
  }

  // The interval may have changed (the browser came to the front, or went
  // behind): a frame or an ack waiting for the old one goes by the new one.
  reschedule() {
    if (this.every === this.interval()) return;
    this.every = this.interval();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
      this.schedule();
    }
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
      this.scheduleAck();
    }
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearTimeout(this.ackTimer);
    this.cdp?.close();
  }
}
