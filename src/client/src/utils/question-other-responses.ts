export function createOtherResponses(keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, '']))
}
