/** Keep this metadata-only: no requests, operations, Error objects, transcripts or credentials. */
export function diagnostic(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined> = {},
  warning = false,
) {
  try {
    const line = JSON.stringify({ time: new Date().toISOString(), event, ...fields });
    if (warning) console.warn(`[whiteboard.frontend] ${line}`);
    else console.info(`[whiteboard.frontend] ${line}`);
  } catch {
    // Instrumentation must not change capture, streaming or scene behavior.
  }
}
