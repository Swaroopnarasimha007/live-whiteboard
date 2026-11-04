import { describe, expect, it } from 'vitest';
import { PcmFramer, PcmResampler, pcm16le } from './resampler';

function signal(rate: number, hz: number, seconds = 0.2) {
  return Float32Array.from(
    { length: rate * seconds },
    (_, i) => Math.sin((i * 2 * Math.PI * hz) / rate) * 0.5,
  );
}
function convert(rate: number, input: Float32Array, block: number) {
  const converter = new PcmResampler(rate);
  const result: number[] = [];
  for (let at = 0; at < input.length; at += block)
    result.push(...converter.push([input.slice(at, at + block)]));
  result.push(...converter.finish());
  return result;
}
const rms = (values: number[]) =>
  Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length);

describe('production PCM conversion', () => {
  for (const rate of [44100, 48000]) {
    it(`resamples ${rate} Hz with continuous phase independent of block boundaries`, () => {
      const input = signal(rate, 1000);
      const whole = convert(rate, input, input.length);
      const chunks = convert(rate, input, 128);
      expect(chunks).toHaveLength(3200);
      expect(chunks).toEqual(whole);
      expect(rms(chunks.slice(100, -100))).toBeCloseTo(Math.sqrt(0.125), 2);
      const alias = convert(rate, signal(rate, 12000), 128);
      expect(rms(alias.slice(100, -100))).toBeLessThan(0.01);
    });
  }
  it('downmixes channels before filtering and keeps a short aligned final frame', () => {
    const converter = new PcmResampler(48000);
    const channel = signal(48000, 1000, 0.15);
    const zero = Float32Array.from(channel, (x) => -x);
    const samples = [...converter.push([channel, zero]), ...converter.finish()];
    expect(samples).toHaveLength(2400);
    expect(samples.every((x) => x === 0)).toBe(true);
    const framer = new PcmFramer();
    expect(framer.push(samples, true).map((f) => f.byteLength)).toEqual([3200, 1600]);
    expect(converter.finish()).toEqual([]);
    expect(() => converter.push([channel])).toThrow('finished');
  });
  it('encodes saturated signed little-endian samples and validates formats', () => {
    const view = new DataView(pcm16le([-2, -0.5, 0, 0.5, 2]));
    expect(Array.from({ length: 5 }, (_, i) => view.getInt16(i * 2, true))).toEqual([
      -32768, -16384, 0, 16384, 32767,
    ]);
    expect(() => new PcmResampler(0)).toThrow();
    expect(() => new PcmFramer(0)).toThrow();
    expect(() =>
      new PcmResampler(48000).push([new Float32Array(2), new Float32Array(3)]),
    ).toThrow();
  });
});
