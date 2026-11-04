import { PcmFramer, PcmResampler } from './resampler';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, processor: typeof CaptureProcessor): void;

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly resampler = new PcmResampler(sampleRate);
  private readonly framer: PcmFramer;
  private active = true;
  private credit: number;
  private readonly maxCredit: number;
  private overloaded = false;

  constructor(options: { processorOptions: { frameMs: number; maxBufferMs: number } }) {
    super();
    this.framer = new PcmFramer(options.processorOptions.frameMs * 16);
    this.credit = this.maxCredit = options.processorOptions.maxBufferMs * 32;
    this.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; bytes?: number };
      if (message.type === 'credit' && message.bytes && message.bytes > 0)
        this.credit = Math.min(this.maxCredit, this.credit + message.bytes);
      if (message.type === 'finish') {
        this.active = false;
        this.send(this.framer.push(this.resampler.finish(), true));
        if (!this.overloaded) this.port.postMessage({ type: 'finished' });
      } else if (message.type === 'abort') this.active = false;
    };
  }

  private send(frames: ArrayBuffer[]) {
    for (const buffer of frames) {
      if (buffer.byteLength > this.credit) {
        this.active = false;
        this.overloaded = true;
        this.port.postMessage({ type: 'overloaded' });
        return;
      }
      this.credit -= buffer.byteLength;
      this.port.postMessage({ type: 'pcm', buffer }, [buffer]);
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (!this.active) return false;
    const channels = inputs[0];
    if (channels?.length) this.send(this.framer.push(this.resampler.push(channels)));
    return this.active;
  }
}
registerProcessor('whiteboard-pcm', CaptureProcessor);
