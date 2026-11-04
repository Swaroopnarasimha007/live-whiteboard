import type { CaptureState, SpeechEvent, SpeechSource } from './types';
import { speechEventSchema } from './types';
export interface SpeechFixture {
  atMs: number;
  event: SpeechEvent;
}
export function demoSpeechFixtures(run = 1): SpeechFixture[] {
  const event = (
    id: string,
    text: string,
    startMs: number,
    endMs: number,
    isFinal = true,
  ): SpeechEvent => ({ id: `${id}__${run}`, text, startMs, endMs, isFinal });
  return [
    {
      atMs: 0,
      event: event('tour-1', 'Segment 1: the browser sends a request to the API.', 0, 2000),
    },
    {
      atMs: 2400,
      event: event('tour-2', 'Segment 2: the API checks the cache and database.', 2000, 4000),
    },
    {
      atMs: 4800,
      event: event('tour-3', 'Segment 3: a worker processes the queued job.', 4000, 6000),
    },
    {
      atMs: 7200,
      event: event(
        'tour-edit-1',
        'Return to segment 1: rename the API and add authentication.',
        6000,
        8000,
      ),
    },
    {
      atMs: 9600,
      event: event('tour-4', 'Segment 4: send the response and record metrics.', 8000, 10000),
    },
    {
      atMs: 12000,
      event: event('tour-add-2', 'Return to segment 2: add a cache refresh path.', 10000, 12000),
    },
    {
      atMs: 14400,
      event: event(
        'tour-edit-4',
        'Return to segment 4: improve the response and add monitoring.',
        12000,
        14000,
      ),
    },
  ];
}
/** Paused time does not consume fixture events; backpressure retains the current event. */
export class MockSpeechSource implements SpeechSource {
  private readonly fixture: readonly SpeechFixture[] | undefined;
  private events: readonly SpeechFixture[] = [];
  private cursor = 0;
  private run = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private due = 0;
  private remaining = 0;
  private state: CaptureState = 'idle';
  private disposed = false;
  private onEvent: (event: SpeechEvent) => boolean = () => true;
  private onState: (state: CaptureState) => void = () => {};
  constructor(fixture?: readonly SpeechFixture[]) {
    if (fixture) {
      let previous = 0;
      this.fixture = fixture.map(({ atMs, event }) => {
        if (!Number.isFinite(atMs) || atMs < previous)
          throw new Error('Speech fixtures must be ordered');
        previous = atMs;
        return { atMs, event: speechEventSchema.parse(event) };
      });
    }
  }
  private status(state: CaptureState) {
    this.state = state;
    this.onState(state);
  }
  private schedule() {
    if (this.state !== 'recording' || this.disposed) return;
    if (this.cursor >= this.events.length) {
      this.status('idle');
      return;
    }
    this.due = performance.now() + this.remaining;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.state !== 'recording' || this.disposed) return;
      const item = this.events[this.cursor]!;
      if (!this.onEvent({ ...item.event })) {
        this.remaining = 0;
        this.status('paused');
        return;
      }
      this.cursor++;
      this.remaining = (this.events[this.cursor]?.atMs ?? item.atMs) - item.atMs;
      this.schedule();
    }, this.remaining);
  }
  start(
    onEvent: (event: SpeechEvent) => boolean,
    onState: (state: CaptureState) => void = () => {},
  ) {
    if (this.disposed || this.state === 'recording') return;
    this.onEvent = onEvent;
    this.onState = onState;
    if (!this.events.length || this.cursor >= this.events.length) {
      this.events = this.fixture ?? demoSpeechFixtures(++this.run);
      this.cursor = 0;
      this.remaining = this.events[0]?.atMs ?? 0;
    }
    this.status('recording');
    this.schedule();
  }
  pause() {
    if (this.state !== 'recording') return;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.remaining = Math.max(0, this.due - performance.now());
    this.status('paused');
  }
  resume() {
    if (this.disposed || this.state !== 'paused') return;
    this.status('recording');
    this.schedule();
  }
  stop() {
    this.pause();
    this.status('idle');
  }
  reset() {
    this.stop();
    this.events = [];
    this.cursor = 0;
    this.remaining = 0;
  }
  dispose() {
    this.stop();
    this.disposed = true;
    this.onEvent = () => false;
    this.onState = () => {};
  }
}
