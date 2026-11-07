import { useEffect, useSyncExternalStore } from 'react';
import type { BackendSessionBridge } from './bridge';

export function ProfilePicker({
  bridge,
  disabled,
}: {
  bridge: BackendSessionBridge;
  disabled: boolean;
}) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot, bridge.getSnapshot);
  useEffect(() => {
    void bridge.discover().catch(() => {});
  }, [bridge]);
  const caps = state.capabilities;
  return (
    <div className="panel-connection" aria-label="Backend connection">
      <p role="status">{state.message || 'Start connects to the local backend.'}</p>
      {!caps && (
        <button
          onClick={() => {
            void bridge.discover().catch(() => {});
          }}
        >
          Discover backend profiles
        </button>
      )}
      {caps &&
        (['profile', 'diagramProfile'] as const).map((kind) => {
          const speech = kind === 'profile';
          const profiles = speech ? caps.transcriptionProfiles : caps.diagramProfiles;
          const enabled = speech
            ? caps.transcriptionSelectionEnabled
            : caps.diagramSelectionEnabled;
          return (
            <label key={kind}>
              {speech ? 'Speech profile' : 'Diagram profile'}
              <select
                value={state[kind]}
                disabled={disabled || !enabled || state.status === 'connecting'}
                onChange={(event) => bridge.select(kind, event.target.value)}
              >
                {profiles.map((profile) => (
                  <option key={profile.id} value={profile.id} disabled={!profile.available}>
                    {profile.displayName}
                    {!profile.available ? ` — ${profile.reason ?? 'unavailable'}` : ''}
                  </option>
                ))}
              </select>
              {!enabled && <small>Configured by the backend.</small>}
            </label>
          );
        })}
    </div>
  );
}
