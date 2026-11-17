// main.ts — Entry point. The trial environment runs `node /bot/main.ts` and
// hands us its base URL in MAKEFUN_ENV_URL. We start the forge on an
// ephemeral port, register that port with the environment, then poll until
// the environment says the trial is done — and only then shut down.
//
// Without MAKEFUN_ENV_URL there is no trial to join, so we exit 1. For local
// testing, import ./app.ts directly (see README.md) instead of running this.
import { createForgeServer } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One fetch with a 30 s timeout, returning null on any transport failure. */
async function fetchJson(url: string, init?: RequestInit): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return (await response.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    console.error('MAKEFUN_ENV_URL is not set; nothing to register with.');
    process.exit(1);
  }

  const server = createForgeServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not bind to a port'));
        return;
      }
      resolve(address.port);
    });
  });

  // Register: 200 is normal; 409 means a first registration already won,
  // which is also fine — the environment already knows where we are.
  const registered = await (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: controller.signal,
      });
      return response.ok || response.status === 409;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  })();
  if (!registered) {
    console.error('registration with the trial environment failed.');
    server.close();
    process.exit(1);
  }

  // Poll /done until the trial ends. Backoff grows 250 ms -> 2 s so a long
  // trial does not spin; a transient failure just retries.
  let backoffMs = 250;
  for (;;) {
    const done = await fetchJson(`${ENV_URL}/done`);
    if (done !== null && typeof done === 'object' && (done as { done?: unknown }).done === true) {
      break;
    }
    await sleep(backoffMs);
    backoffMs = Math.min(2000, backoffMs * 2);
  }

  server.close();
  process.exit(0);
}

void main();
