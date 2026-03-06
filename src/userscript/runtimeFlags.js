const INLINE_WORKER_DEFAULT_ENABLED =
  typeof __US_INLINE_WORKER_ENABLED__ === 'boolean' ? __US_INLINE_WORKER_ENABLED__ : false;

export function shouldUseInlineWorker(workerCode, env = globalThis) {
  const forceEnable = env?.__GWR_FORCE_INLINE_WORKER__ === true;
  if (!INLINE_WORKER_DEFAULT_ENABLED && !forceEnable) return false;
  if (typeof workerCode !== 'string' || workerCode.length === 0) return false;
  return typeof env?.Worker !== 'undefined' && typeof env?.Blob !== 'undefined';
}
