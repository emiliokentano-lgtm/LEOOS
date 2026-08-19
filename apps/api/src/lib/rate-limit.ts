/**
 * In-process rate limiter.
 *
 * Deliberately in-memory for this phase: Redis arrives with the real-time layer
 * in Phase 5, and adding it now for one consumer would be a dependency ahead of
 * its second use (engineering rules 28, 29). The interface is the shape a Redis
 * implementation will have, so the swap is internal.
 *
 * KNOWN LIMITATION, stated rather than hidden: with more than one API process
 * these counters are per-process, so the effective limit multiplies by the
 * instance count. Acceptable while the deployment is single-process; it must
 * move to Redis before horizontal scaling. Progressive account lockout is
 * persisted in the database and is NOT affected by this.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(private readonly sweepIntervalMs = 60_000) {}

  start(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = undefined;
  }

  /** Fixed-window counter. Simple, and adequate for auth surfaces. */
  consume(key: string, limit: number, windowSeconds: number): RateLimitResult {
    const now = Date.now();
    const existing = this.buckets.get(key);

    if (!existing || existing.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowSeconds * 1000 });
      return { allowed: true, remaining: limit - 1, retryAfterSeconds: 0 };
    }

    existing.count += 1;
    if (existing.count > limit) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)),
      };
    }
    return { allowed: true, remaining: limit - existing.count, retryAfterSeconds: 0 };
  }

  /** Clears a key — called after a successful login so a legitimate user who
   *  fat-fingered their password is not left throttled. */
  reset(key: string): void {
    this.buckets.delete(key);
  }

  /** Clears every bucket. Test-support only; never called by request handling. */
  resetAll(): void {
    this.buckets.clear();
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

/**
 * Limits per surface. Login is keyed on BOTH identifier and IP so that neither
 * a single account nor a single source can be hammered, and so that an attacker
 * spraying one password across many accounts still hits the IP limit.
 */
export const LIMITS = {
  login: { limit: 5, windowSeconds: 900 },
  loginPerIp: { limit: 30, windowSeconds: 900 },
  register: { limit: 3, windowSeconds: 3600 },
  passwordResetRequest: { limit: 3, windowSeconds: 3600 },
  passwordResetPerIp: { limit: 10, windowSeconds: 3600 },
  verificationResend: { limit: 3, windowSeconds: 3600 },
  general: { limit: 300, windowSeconds: 60 },
} as const;
