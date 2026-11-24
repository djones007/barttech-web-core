/**
 * rateLimit — one shared limiter: durable when a Postgres RPC is wired in, a
 * pruned in-memory sliding window otherwise (and as the fallback).
 * ---------------------------------------------------------------------------
 * Why this exists (code scan 2026-11-20, M7/M8, estate issue b4bd94c4): every site
 * hand-rolled `const ipCounts = new Map()` in its proxy. That is per-instance (each
 * warm lambda counts alone, a cold start resets it), was never pruned (grew for the
 * life of the instance) and was a fixed window (a burst straddling the boundary got
 * 2x the cap).
 *
 * The durable path calls the shared BartMail RPC `hit_rate_limit(p_bucket text,
 * p_max int, p_window_secs int) returns boolean` (bartmail migration
 * 20260718_rate_limit_rpc.sql; service_role only; TRUE = allowed). That function is a
 * fixed window by design (one atomic upsert); it is the cross-instance backstop, and
 * the in-memory sliding window still runs in front of it on every instance.
 *
 * No Supabase import here: the caller injects `rpc`, so this stays pure, testable in
 * node:test and usable from any runtime. Typical wiring:
 *
 *   const limiter = createRateLimiter({
 *     rpc: (fn, args) => supabase.rpc(fn, args),   // bartmail service-role client
 *     bucketPrefix: "my-site:",
 *     onRpcFailure: "memory",
 *   });
 *   if (!(await limiter.check(`${ip}:/api/optin`, 10, 60))) return 429;
 *
 * FAIL BEHAVIOUR (explicit, tested). `onRpcFailure` says what happens when the RPC
 * errors, throws or times out:
 *   - "memory" (default): decide from the in-memory sliding window alone. A limiter
 *     outage never blocks a real lead, but a flood is still capped per instance.
 *   - "allow": let the request through (the old fail-open).
 *   - "deny": refuse. Only for routes where an outage must not let a paid API be hit
 *     unmetered (Reoon, Serper, Graph mail).
 * With no `rpc` configured the limiter is the in-memory window and `onRpcFailure` is
 * irrelevant. A non-boolean RPC answer counts as a failure, never as "allowed".
 */

export type RpcFn = (
  fn: string,
  args: { p_bucket: string; p_max: number; p_window_secs: number },
) => PromiseLike<{ data: unknown; error: { message?: string } | null }>;

export type RpcFailureMode = "memory" | "allow" | "deny";

export interface RateLimiterOptions {
  /** Durable backend. Omit for in-memory only. */
  rpc?: RpcFn;
  /** RPC function name. Default `hit_rate_limit`. */
  rpcName?: string;
  /** Prepended to every bucket sent to the RPC, so sites cannot collide. */
  bucketPrefix?: string;
  /** What to do when the RPC fails. Default "memory". */
  onRpcFailure?: RpcFailureMode;
  /** Give up on the RPC after this many ms (counts as a failure). Default 1500. */
  rpcTimeoutMs?: number;
  /** Hard cap on tracked keys; the oldest are evicted past it. Default 10000. */
  maxKeys?: number;
  /** Called with RPC failures (e.g. to Sentry). Must not throw. */
  onError?: (err: unknown) => void;
  /** Clock, for tests. */
  now?: () => number;
}

export interface RateLimiter {
  /** true = allowed, false = over the limit. */
  check(bucket: string, max: number, windowSecs: number): Promise<boolean>;
  /** Number of in-memory keys currently tracked (for tests and monitoring). */
  size(): number;
}

/**
 * Pure in-memory sliding-window limiter. Keeps up to `max` timestamps per key (so
 * memory per key is bounded by the cap), prunes expired keys at most once a
 * window, and evicts the oldest key past `maxKeys`.
 */
export function createMemoryWindow(opts: { maxKeys?: number; now?: () => number } = {}) {
  const maxKeys = opts.maxKeys ?? 10_000;
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastPruneAt = 0;
  let longestWindowMs = 60_000;

  function prune(t: number): void {
    if (t - lastPruneAt < Math.min(longestWindowMs, 60_000)) return;
    lastPruneAt = t;
    for (const [key, stamps] of hits) {
      if (stamps.length === 0 || t - stamps[stamps.length - 1] > longestWindowMs) hits.delete(key);
    }
  }

  return {
    hit(key: string, max: number, windowSecs: number): boolean {
      const t = now();
      const windowMs = windowSecs * 1000;
      if (windowMs > longestWindowMs) longestWindowMs = windowMs;
      prune(t);
      const fresh = (hits.get(key) ?? []).filter((s) => t - s < windowMs);
      if (fresh.length >= max) {
        // Over the cap: do not record the refused hit, so a hammering client
        // recovers one window after it stops rather than never.
        hits.delete(key);
        hits.set(key, fresh);
        return false;
      }
      fresh.push(t);
      hits.delete(key); // re-insert so Map order tracks recency
      hits.set(key, fresh);
      while (hits.size > maxKeys) {
        const oldest = hits.keys().next().value;
        if (oldest === undefined) break;
        hits.delete(oldest);
      }
      return true;
    },
    size: () => hits.size,
  };
}

export function createRateLimiter(options: RateLimiterOptions = {}): RateLimiter {
  const {
    rpc,
    rpcName = "hit_rate_limit",
    bucketPrefix = "",
    onRpcFailure = "memory",
    rpcTimeoutMs = 1500,
    onError,
  } = options;
  const memory = createMemoryWindow({ maxKeys: options.maxKeys, now: options.now });

  function report(err: unknown): void {
    try {
      onError?.(err);
    } catch {
      /* a reporting failure must never change the decision */
    }
  }

  return {
    size: () => memory.size(),
    async check(bucket, max, windowSecs) {
      // The per-instance sliding window always runs first: it is the only thing
      // that works if the RPC is absent or down, and it sheds a flood before it
      // costs a database round trip.
      if (!memory.hit(bucket, max, windowSecs)) return false;
      if (!rpc) return true;

      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const call = Promise.resolve(
          rpc(rpcName, { p_bucket: bucketPrefix + bucket, p_max: max, p_window_secs: windowSecs }),
        );
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("rate-limit rpc timed out")), rpcTimeoutMs);
        });
        const { data, error } = await Promise.race([call, timeout]);
        if (error) throw new Error(error.message ?? "rate-limit rpc error");
        if (typeof data !== "boolean") throw new Error("rate-limit rpc returned a non-boolean");
        return data;
      } catch (err) {
        report(err);
        // "memory": the in-memory window already allowed this hit above.
        if (onRpcFailure === "deny") return false;
        return true;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}
