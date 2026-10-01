/**
 * Registry of renderer work that agents should wait for before reading the
 * screen: source fetches for mounted views. Long-running supervised processes
 * are deliberately not tracked; they report their own state.
 */
let inFlight = 0;
const waiters = new Set<() => void>();

/** Counts `work` as in flight until it settles; returns it unchanged. */
export function trackActivity<T>(work: Promise<T>): Promise<T> {
  inFlight += 1;
  const done = () => {
    inFlight -= 1;
    if (inFlight === 0) for (const waiter of [...waiters]) waiter();
  };
  work.then(done, done);
  return work;
}

export function pendingActivity(): number {
  return inFlight;
}

/**
 * Resolves true once nothing is in flight after `settleFrame` has run (so
 * effects started by the last render have registered their work), or false
 * when `timeoutMs` elapses first.
 */
export async function whenIdle(timeoutMs: number, settleFrame: () => Promise<void>): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    await settleFrame();
    if (inFlight === 0) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    let release!: () => void;
    const idle = new Promise<true>((resolve) => { release = () => resolve(true); });
    waiters.add(release);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), remaining); });
    try {
      if (!await Promise.race([idle, timeout])) return false;
    } finally {
      waiters.delete(release);
      clearTimeout(timer);
    }
  }
}
