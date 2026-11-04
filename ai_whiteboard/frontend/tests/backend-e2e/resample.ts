// Reproducible WAV conversion through the exact production resampler, with no ffmpeg DSP substitute.
import { readFileSync, writeFileSync } from 'node:fs';
import { PcmResampler, pcm16le } from '../../src/audio/backend/resampler.ts';

const input = process.argv[2];
const output = process.argv[3];
if (!input || !output)
  throw new Error(
    'usage: node --experimental-strip-types tests/backend-e2e/resample.ts input.wav output.wav',
  );
const bytes = readFileSync(input);
if (bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE')
  throw new Error('Expected RIFF WAV');
let rate = 0,
  channels = 0,
  bits = 0,
  audio: Buffer | undefined;
for (let at = 12; at + 8 <= bytes.length;) {
  const length = bytes.readUInt32LE(at + 4);
  const tag = bytes.toString('ascii', at, at + 4);
  if (tag === 'fmt ') {
    if (bytes.readUInt16LE(at + 8) !== 1) throw new Error('Expected integer PCM');
    channels = bytes.readUInt16LE(at + 10);
    rate = bytes.readUInt32LE(at + 12);
    bits = bytes.readUInt16LE(at + 22);
  }
  if (tag === 'data') audio = bytes.subarray(at + 8, at + 8 + length);
  at += 8 + length + (length % 2);
}
if (!audio || bits !== 16 || !channels) throw new Error('Expected PCM16 audio');
const resampler = new PcmResampler(rate);
const samples: number[] = [];
const count = audio.length / 2 / channels;
for (let at = 0; at < count; at += 128) {
  const block = Array.from({ length: channels }, (_, channel) =>
    Float32Array.from(
      { length: Math.min(128, count - at) },
      (_, n) => audio!.readInt16LE(((at + n) * channels + channel) * 2) / 32768,
    ),
  );
  samples.push(...resampler.push(block));
}
samples.push(...resampler.finish());
const pcm = Buffer.from(pcm16le(samples));
const header = Buffer.alloc(44);
header.write('RIFF');
header.writeUInt32LE(36 + pcm.length, 4);
header.write('WAVEfmt ', 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(16000, 24);
header.writeUInt32LE(32000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(pcm.length, 40);
writeFileSync(output, Buffer.concat([header, pcm]));
console.log(
  JSON.stringify({
    inputRate: rate,
    inputChannels: channels,
    outputRate: 16000,
    samples: samples.length,
    seconds: samples.length / 16000,
  }),
);
