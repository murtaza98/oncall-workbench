export async function workbenchToken(): Promise<string> {
  const response = await fetch('/api/token');
  if (!response.ok) throw new Error('Could not authorize the local workbench.');
  const payload = await response.json() as { token: string };
  return payload.token;
}
