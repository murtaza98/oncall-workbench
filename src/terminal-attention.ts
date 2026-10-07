export function screenNeedsInput(screen: string): boolean {
  const text = screen.replace(/\s+/g, ' ').trim();
  if (/Working\s*\([^)]*esc to interrupt/i.test(text.slice(-450))) return false;
  return (
    /Would you like to run the following command\?/i.test(text) && /Yes, proceed/i.test(text)
  ) || (
    /Do you want to proceed\?|Would you like to make these edits\?/i.test(text) && /(?:Yes|Allow|Approve)/i.test(text)
  ) || (
    /Ask Codex to do anything/i.test(text.slice(-250)) &&
    /(?:May I|Should I|Would you|Do you want|Please confirm|requires confirmation)[^?]{0,500}(?:\?|\.)/i.test(text.slice(-700))
  );
}
