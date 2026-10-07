const CODEX_SESSION_ID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESUME_COMMAND = new RegExp(`^(?:codex\\s+resume\\s+)?(${CODEX_SESSION_ID})$`, 'i');

export function codexResumeId(value: string): string | null {
  return RESUME_COMMAND.exec(value.trim())?.[1].toLowerCase() ?? null;
}
