/** Stateful windowed-sinc low-pass resampler; phase/history survive render quantum boundaries. */
export class PcmResampler {
  readonly inputRate: number;
  readonly outputRate: number;
  private readonly ratio: number;
  private readonly cutoff: number;
  private readonly radius = 32;
  private history: number[] = [];
  private base = 0;
  private received = 0;
  private next = 0;
  private emitted = 0;
  private finished = false;

  constructor(inputRate: number, outputRate = 16000) {
    this.inputRate = inputRate;
    this.outputRate = outputRate;
    if (
      !Number.isFinite(inputRate) ||
      inputRate < 8000 ||
      inputRate > 192000 ||
      outputRate !== 16000
    )
      throw new Error('Unsupported PCM sample rate');
    this.ratio = inputRate / outputRate;
    this.cutoff = Math.min(1, outputRate / inputRate) * 0.9;
  }

  push(channels: readonly Float32Array[]): number[] {
    if (this.finished) throw new Error('Resampler has finished');
    if (!channels.length) return [];
    const length = channels[0]!.length;
    if (channels.some((c) => c.length !== length)) throw new Error('Channel length mismatch');
    for (let i = 0; i < length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i]! / channels.length;
      this.history.push(Number.isFinite(sample) ? sample : 0);
    }
    this.received += length;
    return this.produce(false);
  }

  finish(): number[] {
    if (this.finished) return [];
    this.finished = true;
    return this.produce(true);
  }

  private produce(final: boolean): number[] {
    const result: number[] = [];
    const total = Math.floor(this.received / this.ratio);
    while (this.emitted < total && (final || this.next + this.radius < this.received)) {
      const center = Math.floor(this.next);
      let value = 0;
      let weight = 0;
      for (let i = center - this.radius + 1; i <= center + this.radius; i++) {
        const distance = i - this.next;
        const scaled = this.cutoff * distance;
        const sinc = scaled === 0 ? 1 : Math.sin(Math.PI * scaled) / (Math.PI * scaled);
        const window =
          Math.abs(distance) < this.radius
            ? 0.5 + 0.5 * Math.cos((Math.PI * distance) / this.radius)
            : 0;
        const coefficient = this.cutoff * sinc * window;
        value +=
          (i < 0 || i >= this.received ? 0 : (this.history[i - this.base] ?? 0)) * coefficient;
        weight += coefficient;
      }
      result.push(Math.max(-1, Math.min(1, weight ? value / weight : 0)));
      this.emitted++;
      this.next = this.emitted * this.ratio;
    }
    const drop = Math.max(0, Math.floor(this.next) - this.radius - this.base);
    if (drop) {
      this.history.splice(0, drop);
      this.base += drop;
    }
    return result;
  }
}

export function pcm16le(samples: readonly number[]): ArrayBuffer {
  const result = new ArrayBuffer(samples.length * 2);
  const view = new DataView(result);
  samples.forEach((sample, i) => {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(i * 2, Math.round(clamped * (clamped < 0 ? 32768 : 32767)), true);
  });
  return result;
}

export class PcmFramer {
  readonly frameSamples: number;
  private samples: number[] = [];
  constructor(frameSamples = 1600) {
    this.frameSamples = frameSamples;
    if (!Number.isSafeInteger(frameSamples) || frameSamples < 16 || frameSamples > 16000)
      throw new Error('Invalid PCM frame size');
  }
  push(samples: readonly number[], final = false): ArrayBuffer[] {
    this.samples.push(...samples);
    const frames: ArrayBuffer[] = [];
    while (this.samples.length >= this.frameSamples)
      frames.push(pcm16le(this.samples.splice(0, this.frameSamples)));
    if (final && this.samples.length) frames.push(pcm16le(this.samples.splice(0)));
    return frames;
  }
}
