declare module 'proper-lockfile' {
  export function lockSync(path: string, options?: { stale?: number; onCompromised?(error: Error): void }): () => void;
}
