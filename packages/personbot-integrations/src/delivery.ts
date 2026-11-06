import type { ChannelDeliveryRecord } from '../../personbot-protocol/src/index.ts';

export interface CallbackResult {
  state: 'delivered' | 'pending' | 'uncertain' | 'failed';
  error?: string;
  nextAttemptAt?: string;
}

/** Callback destinations are explicit owner configuration, never event-provided addresses. */
export function validateCallbackUrl(value: string): string {
  if (typeof value !== 'string' || value.length > 4096 || value.includes('#') ||
    Array.from(value).some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) {
    throw new TypeError('Callback URL must be an absolute HTTP(S) URL without credentials or a fragment');
  }
  let url: URL;
  try { url = new URL(value); }
  catch { throw new TypeError('Callback URL must be an absolute HTTP(S) URL'); }
  if (url.username || url.password || url.hash || !url.hostname ||
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) {
    throw new TypeError('Callback URL requires HTTPS or exact loopback HTTP, without credentials or a fragment');
  }
  return url.href;
}

function unsuccessful(delivery: ChannelDeliveryRecord, error: string): CallbackResult {
  if (delivery.mode === 'at-most-once') return { state: 'uncertain', error };
  if (delivery.attempts >= 5) return { state: 'failed', error };
  return {
    state: 'pending', error,
    nextAttemptAt: new Date(Date.now() + Math.min(30_000, 1000 * 2 ** Math.max(0, delivery.attempts - 1))).toISOString(),
  };
}

/** A durable sending receipt must exist before this function performs its one HTTP attempt. */
export async function deliverCallback(delivery: ChannelDeliveryRecord, signal?: AbortSignal): Promise<CallbackResult> {
  let url: string;
  try {
    url = validateCallbackUrl(delivery.url);
    if (delivery.state !== 'sending' || !Number.isSafeInteger(delivery.attempts) || delivery.attempts < 1 ||
      !['idempotent', 'at-most-once'].includes(delivery.mode)) throw new TypeError('Callback requires a persisted sending receipt');
  } catch {
    return { state: 'failed', error: 'Invalid callback delivery configuration' };
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(delivery.mode === 'idempotent' ? { 'idempotency-key': delivery.id } : {}),
      },
      body: JSON.stringify(delivery.payload),
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5_000)]) : AbortSignal.timeout(5_000),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status >= 200 && response.status < 300) return { state: 'delivered' };
    return unsuccessful(delivery, `Callback returned HTTP ${response.status}`);
  } catch {
    return unsuccessful(delivery, 'Callback request failed or was interrupted; the remote result may be unknown');
  }
}
