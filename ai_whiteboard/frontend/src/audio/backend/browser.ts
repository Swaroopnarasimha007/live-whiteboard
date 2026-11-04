import workletUrl from './capture.worklet.ts?worker&url';

export interface PcmCapture {
  finish(): Promise<void>;
  abort(): Promise<void>;
  credit(bytes: number): void;
}
export interface AudioEnvironment {
  secure: boolean;
  supported: boolean;
  connect(url: string): WebSocket;
  capture(
    onFrame: (frame: ArrayBuffer) => void,
    onFailure: (code: string) => void,
    frameMs: number,
    maxBufferMs: number,
    signal: AbortSignal,
  ): Promise<PcmCapture>;
}

async function capture(
  onFrame: (frame: ArrayBuffer) => void,
  onFailure: (code: string) => void,
  frameMs: number,
  maxBufferMs: number,
  signal: AbortSignal,
): Promise<PcmCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: { ideal: 1 } },
  });
  let context: AudioContext | undefined;
  let node: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let gain: GainNode | undefined;
  let disposed = false;
  let finishResolve: (() => void) | undefined;
  let finishReject: ((error: Error) => void) | undefined;
  const abort = () => {
    void dispose();
  };
  const ended = () => onFailure('device_lost');
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener('abort', abort);
    for (const track of stream.getTracks()) {
      track.removeEventListener('ended', ended);
      track.stop();
    }
    if (node) {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      node.port.close();
      node.disconnect();
    }
    source?.disconnect();
    gain?.disconnect();
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    finishResolve?.();
  };
  try {
    if (signal.aborted) throw new Error('Capture cancelled');
    signal.addEventListener('abort', abort, { once: true });
    context = new AudioContext();
    await context.audioWorklet.addModule(workletUrl);
    if (disposed || signal.aborted) throw new Error('Capture cancelled');
    node = new AudioWorkletNode(context, 'whiteboard-pcm', {
      processorOptions: { frameMs, maxBufferMs },
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCountMode: 'max',
    });
    node.onprocessorerror = () => onFailure('worklet_failed');
    node.port.onmessage = (event: MessageEvent) => {
      const message = event.data as { type: string; buffer?: ArrayBuffer };
      if (disposed) return;
      if (message.type === 'pcm' && message.buffer) onFrame(message.buffer);
      else if (message.type === 'finished') finishResolve?.();
      else if (message.type === 'overloaded') {
        finishReject?.(new Error('Audio worklet buffer exceeded'));
        onFailure('overloaded');
      }
    };
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = 0;
    source.connect(node);
    node.connect(gain);
    gain.connect(context.destination);
    for (const track of stream.getTracks()) track.addEventListener('ended', ended);
    await context.resume();
    if (disposed || signal.aborted) throw new Error('Capture cancelled');
    return {
      credit: (bytes) => {
        if (!disposed) node?.port.postMessage({ type: 'credit', bytes });
      },
      async finish() {
        if (disposed) return;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await new Promise<void>((resolve, reject) => {
            finishResolve = resolve;
            finishReject = reject;
            timeout = setTimeout(() => reject(new Error('Audio worklet flush timed out')), 2000);
            node!.port.postMessage({ type: 'finish' });
          });
        } finally {
          clearTimeout(timeout);
          await dispose();
        }
      },
      async abort() {
        node?.port.postMessage({ type: 'abort' });
        await dispose();
      },
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

export function browserAudioEnvironment(): AudioEnvironment {
  return {
    secure: globalThis.isSecureContext,
    supported:
      !!navigator.mediaDevices?.getUserMedia &&
      typeof AudioContext !== 'undefined' &&
      typeof AudioWorkletNode !== 'undefined',
    connect: (url) => new WebSocket(url),
    capture,
  };
}
