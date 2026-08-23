export function buildServerStartArgs(port: number): string[] {
  return ['start', '--port', String(port)]
}
