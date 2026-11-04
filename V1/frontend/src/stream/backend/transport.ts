import {
  generationEventSchema,
  type GenerationEvent,
  type GenerationRequest,
  type GenerationTransport,
} from '../../contracts';
import { diagnostic } from '../../diagnostics';

export class BackendError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string };
  } | null;
  throw new BackendError(
    response.status,
    body?.error?.code ?? 'network_error',
    body?.error?.message ?? `Backend returned HTTP ${response.status}`,
  );
}

/** Wire metadata is validated and preserved, including original replay sequences. */
export class HttpGenerationTransport implements GenerationTransport {
  readonly baseUrl: string;
  private readonly fetcher: typeof fetch;
  private readonly onError: ((error: unknown, request: GenerationRequest) => void) | undefined;
  constructor(
    baseUrl: string,
    fetcher: typeof fetch = fetch,
    onError?: (error: unknown, request: GenerationRequest) => void,
  ) {
    this.baseUrl = baseUrl;
    this.fetcher = fetcher.bind(globalThis);
    this.onError = onError;
  }
  async *generate(request: GenerationRequest, signal: AbortSignal): AsyncIterable<GenerationEvent> {
    diagnostic('http.generation_start', {
      requestId: request.requestId,
      sessionEpoch: request.sessionEpoch,
      baseRevision: request.baseRevision,
      nodes: request.board?.nodes.length,
      edges: request.board?.edges.length,
      transcriptCharacters: request.transcript?.text.length,
    });
    const abort = () => {
      void this.cancel(request).catch(() => {});
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.fetcher(`${this.baseUrl}/api/v1/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
        signal,
      });
      diagnostic(
        'http.generation_response',
        { requestId: request.requestId, status: response.status },
        !response.ok,
      );
      yield* this.read(await checked(response), request, 0, signal);
    } catch (error) {
      diagnostic(
        'http.generation_error',
        {
          requestId: request.requestId,
          aborted: signal.aborted,
          errorType: error instanceof Error ? error.name : 'UnknownError',
          status: error instanceof BackendError ? error.status : undefined,
          code: error instanceof BackendError ? error.code : undefined,
        },
        !signal.aborted,
      );
      if (!signal.aborted) this.onError?.(error, request);
      throw error;
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
  async *replay(
    request: GenerationRequest,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<GenerationEvent> {
    diagnostic('http.replay_start', {
      requestId: request.requestId,
      sessionEpoch: request.sessionEpoch,
      after,
    });
    const query = new URLSearchParams({
      sessionId: request.sessionId,
      sessionEpoch: String(request.sessionEpoch),
      after: String(after),
    });
    const response = await checked(
      await this.fetcher(
        `${this.baseUrl}/api/v1/generations/${encodeURIComponent(request.requestId)}/events?${query}`,
        { signal },
      ),
    );
    yield* this.read(response, request, after, signal);
  }
  async cancel(request: GenerationRequest) {
    await checked(
      await this.fetcher(
        `${this.baseUrl}/api/v1/generations/${encodeURIComponent(request.requestId)}/cancel`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: request.sessionId,
            sessionEpoch: request.sessionEpoch,
          }),
          signal: AbortSignal.timeout(3000),
        },
      ),
    );
  }
  private async *read(
    response: Response,
    request: GenerationRequest,
    after: number,
    signal: AbortSignal,
  ): AsyncIterable<GenerationEvent> {
    if (!response.headers.get('content-type')?.startsWith('application/x-ndjson') || !response.body)
      throw new Error('Backend did not return an NDJSON stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let pending = '',
      sequence = after,
      terminal = false;
    const parse = (line: string): GenerationEvent => {
      const event = generationEventSchema.parse(JSON.parse(line));
      if (
        terminal ||
        event.requestId !== request.requestId ||
        event.sessionEpoch !== request.sessionEpoch ||
        event.sequence !== sequence + 1 ||
        ('baseRevision' in event && event.baseRevision !== request.baseRevision)
      )
        throw new Error('Backend stream identity, revision or sequence mismatch');
      if (sequence === 0 && event.event !== 'started') throw new Error('Missing started event');
      sequence = event.sequence;
      terminal = ['completed', 'failed', 'cancelled'].includes(event.event);
      if (event.event !== 'operation')
        diagnostic(
          'http.wire_event',
          {
            requestId: event.requestId,
            sessionEpoch: event.sessionEpoch,
            sequence: event.sequence,
            wireEvent: event.event,
            code: 'code' in event ? event.code : undefined,
            operations: event.event === 'completed' ? event.operationCount : undefined,
            warnings: event.event === 'completed' ? event.warningCount : undefined,
          },
          event.event === 'warning' || event.event === 'failed',
        );
      return event;
    };
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          if (new TextEncoder().encode(pending.slice(0, newline)).byteLength > 262144)
            throw new Error('Backend event exceeds byte limit');
          const line = pending.slice(0, newline).replace(/\r$/, '');
          pending = pending.slice(newline + 1);
          if (line.trim()) yield parse(line);
        }
        if (new TextEncoder().encode(pending).byteLength > 262144)
          throw new Error('Backend event exceeds byte limit');
        if (done) break;
      }
      if (pending.trim()) yield parse(pending);
      if (!terminal)
        throw new Error(
          'Backend stream interrupted before a terminal event. Replay the retained request.',
        );
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
}
