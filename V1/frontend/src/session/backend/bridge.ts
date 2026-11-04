import { z } from 'zod';
import { idSchema } from '../../contracts';
import { BackendSpeechSource } from '../../audio/backend';
import type { AudioEnvironment } from '../../audio/backend/browser';
import { BackendError, checked, HttpGenerationTransport } from '../../stream/backend/transport';

const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identitySchema = z.strictObject({
  sessionId: idSchema,
  sessionEpoch: counter,
  profile: idSchema,
  diagramProfile: idSchema,
  configurationFingerprint: z.string(),
});
const profile = z.object({
  id: idSchema,
  displayName: z.string(),
  available: z.boolean(),
  reason: z.string().nullable().optional(),
});
const capabilitiesSchema = z.object({
  protocolVersion: z.literal(1),
  wireVersion: z.literal(1),
  audioProtocolVersion: z.literal(1),
  transcriptionDefaultProfile: idSchema,
  transcriptionSelectionEnabled: z.boolean(),
  transcriptionProfiles: z.array(profile),
  diagramDefaultProfile: idSchema,
  diagramSelectionEnabled: z.boolean(),
  diagramProfiles: z.array(profile),
  services: z.record(z.string(), z.boolean()),
});
type Identity = z.infer<typeof identitySchema>;
type Capabilities = z.infer<typeof capabilitiesSchema>;
export interface BackendSnapshot {
  capabilities: Capabilities | null;
  identity: Identity | null;
  profile: string;
  diagramProfile: string;
  status: 'idle' | 'connecting' | 'ready' | 'error';
  message: string;
}
export interface BackendBridgeOptions {
  baseUrl?: string;
  fetcher?: typeof fetch;
  audioEnvironment?: AudioEnvironment;
}

/** Owns network identity and capture only; the existing controller owns transcript scheduling. */
export class BackendSessionBridge {
  readonly baseUrl: string;
  readonly transport: HttpGenerationTransport;
  readonly source: BackendSpeechSource;
  private state: BackendSnapshot = {
    capabilities: null,
    identity: null,
    profile: '',
    diagramProfile: '',
    status: 'idle',
    message: '',
  };
  private listeners = new Set<() => void>();
  private fetcher: typeof fetch;
  private discovery: Promise<Capabilities> | undefined;
  private pending: Promise<Identity> | undefined;
  private pendingEpoch: number | undefined;
  private retirement: Promise<void> = Promise.resolve();
  private version = 0;
  private disposed = false;
  constructor(options: BackendBridgeOptions = {}) {
    this.baseUrl = (
      options.baseUrl ??
      import.meta.env.VITE_WHITEBOARD_BACKEND_URL ??
      (typeof window === 'undefined' ? 'http://127.0.0.1:8000' : window.location.origin)
    ).replace(/\/$/, '');
    this.fetcher = (options.fetcher ?? fetch).bind(globalThis);
    this.transport = new HttpGenerationTransport(this.baseUrl, this.fetcher, (error, request) => {
      if (
        this.state.identity?.sessionId === request.sessionId &&
        this.state.identity.sessionEpoch === request.sessionEpoch &&
        error instanceof BackendError &&
        (error.code === 'session_expired' || error.code === 'stale_epoch')
      ) {
        this.version++;
        this.pending = undefined;
        this.source.stop();
        this.publish({
          identity: null,
          status: 'error',
          message:
            'Backend session ended. Start reconnects while preserving the board. Continue with fresh context uses a new request.',
        });
      }
    });
    this.source = new BackendSpeechSource({
      session: () => {
        const current = this.state.identity;
        if (!current || this.state.status !== 'ready')
          throw new Error('Connect to the backend before capturing audio');
        return {
          url: `${this.baseUrl.replace(/^http/, 'ws')}/api/v1/sessions/${encodeURIComponent(current.sessionId)}/audio`,
          sessionEpoch: current.sessionEpoch,
          profile: current.profile,
        };
      },
      ...(options.audioEnvironment ? { environment: options.audioEnvironment } : {}),
      onError: (error) =>
        this.publish({
          status: error.code === 'audio_backlog' ? 'ready' : 'error',
          message: error.message,
        }),
    });
  }
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(patch: Partial<BackendSnapshot>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private async json(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await checked(
      await this.fetcher(`${this.baseUrl}/api/v1${path}`, {
        method,
        signal: AbortSignal.timeout(10000),
        ...(body === undefined
          ? {}
          : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      }),
    );
    return response.json() as Promise<unknown>;
  }
  discover(): Promise<Capabilities> {
    if (this.state.capabilities) return Promise.resolve(this.state.capabilities);
    if (!this.discovery) {
      this.discovery = this.json('/capabilities')
        .then((raw) => {
          const caps = capabilitiesSchema.parse(raw);
          if (!['sessions', 'audio', 'generation', 'replay'].every((key) => caps.services[key]))
            throw new Error('Backend session services are unavailable');
          this.publish({
            capabilities: caps,
            profile: caps.transcriptionDefaultProfile,
            diagramProfile: caps.diagramDefaultProfile,
            message: '',
          });
          return caps;
        })
        .catch((error: unknown) => {
          this.publish({ status: 'error', message: String(error) });
          throw error;
        })
        .finally(() => {
          this.discovery = undefined;
        });
    }
    return this.discovery;
  }
  select(kind: 'profile' | 'diagramProfile', id: string) {
    const caps = this.state.capabilities;
    const enabled =
      kind === 'profile' ? caps?.transcriptionSelectionEnabled : caps?.diagramSelectionEnabled;
    const profiles = kind === 'profile' ? caps?.transcriptionProfiles : caps?.diagramProfiles;
    if (!enabled || this.state[kind] === id || !profiles?.some((p) => p.id === id && p.available))
      return;
    this.version++;
    this.pending = undefined;
    this.source.stop();
    const previous = this.state.identity;
    this.retirement = this.retirement.then(() => this.retire(previous));
    this.publish({
      [kind]: id,
      identity: null,
      status: 'idle',
      message: 'Profile selected. Start to connect.',
    });
  }
  ensure(epoch: number): Promise<Identity> {
    if (this.disposed) return Promise.reject(new Error('Backend session is closed'));
    if (this.pending && this.pendingEpoch === epoch) return this.pending;
    const version = ++this.version;
    const previous = this.state.identity;
    let recoverable = previous?.sessionEpoch === epoch ? previous : null;
    this.publish({ status: 'connecting', message: 'Connecting to local backend…' });
    this.pendingEpoch = epoch;
    const work = async () => {
      await this.discover();
      await this.retirement;
      if (previous && previous.sessionEpoch !== epoch) await this.retire(previous);
      let identity: Identity | undefined;
      if (previous?.sessionEpoch === epoch) {
        try {
          identity = identitySchema.parse(
            await this.json(
              `/sessions/${encodeURIComponent(previous.sessionId)}?sessionEpoch=${epoch}`,
            ),
          );
        } catch (error) {
          if (!(error instanceof BackendError && [409, 410].includes(error.status))) throw error;
          recoverable = null;
        }
      }
      if (!identity)
        identity = identitySchema.parse(
          await this.json('/sessions', {
            sessionEpoch: epoch,
            profile: this.state.profile,
            diagramProfile: this.state.diagramProfile,
          }),
        );
      if (identity.sessionEpoch !== epoch) {
        recoverable = null;
        this.retire(identity);
        throw new Error('Backend returned an unexpected session epoch');
      }
      if (this.disposed || version !== this.version) {
        if (identity.sessionId !== previous?.sessionId) this.retire(identity);
        throw new Error('Backend connection was superseded');
      }
      if (previous?.sessionEpoch === epoch && previous.sessionId !== identity.sessionId)
        void this.retire(previous);
      this.publish({
        identity,
        status: 'ready',
        message: 'Backend connected. Audio is sent to the configured speech profile.',
      });
      return identity;
    };
    const pending = work()
      .catch((error: unknown) => {
        if (version === this.version)
          this.publish({ identity: recoverable, status: 'error', message: String(error) });
        throw error;
      })
      .finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
    this.pending = pending;
    return pending;
  }
  async reset(epoch: number): Promise<void> {
    const previous = this.state.identity,
      version = ++this.version;
    this.pending = undefined;
    this.source.stop();
    this.source.reset();
    this.publish({ identity: null, status: 'idle', message: 'Session reset. Start to reconnect.' });
    if (!previous) return;
    try {
      if (previous.sessionEpoch + 1 !== epoch) {
        this.retire(previous);
        return;
      }
      const identity = identitySchema.parse(
        await this.json(`/sessions/${encodeURIComponent(previous.sessionId)}/reset`, {
          sessionId: previous.sessionId,
          sessionEpoch: previous.sessionEpoch,
        }),
      );
      if (version === this.version && identity.sessionEpoch === epoch)
        this.publish({ identity, status: 'ready' });
      else this.retire(identity);
    } catch (error) {
      if (version === this.version)
        this.publish({
          message: `Backend session ended. Start creates a new session. ${String(error)}`,
        });
    }
  }
  private async retire(identity: Identity | null): Promise<void> {
    if (!identity) return;
    await this.fetcher(
      `${this.baseUrl}/api/v1/sessions/${encodeURIComponent(identity.sessionId)}?sessionEpoch=${identity.sessionEpoch}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3000), keepalive: true },
    ).catch(() => {});
  }
  dispose() {
    if (this.disposed) return;
    this.version++;
    this.source.dispose();
    this.retire(this.state.identity);
    this.disposed = true;
    this.listeners.clear();
  }
}
