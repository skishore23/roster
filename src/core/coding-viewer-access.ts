export const CODING_VIEWER_GRANT_REFRESH_LEAD_MS = 30_000;

export const codingViewerGrantIsFresh = (
  expiresAt: number,
  now: number,
  refreshLeadMs = CODING_VIEWER_GRANT_REFRESH_LEAD_MS,
): boolean => Number.isSafeInteger(expiresAt)
  && Number.isSafeInteger(now)
  && Number.isSafeInteger(refreshLeadMs)
  && refreshLeadMs >= 0
  && expiresAt - now > refreshLeadMs;

export const codingViewerGrantRefreshDelay = (
  expiresAt: number,
  now: number,
  maximumLeadMs = CODING_VIEWER_GRANT_REFRESH_LEAD_MS,
): number | undefined => {
  if (!Number.isSafeInteger(expiresAt)
    || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(maximumLeadMs)
    || maximumLeadMs < 1) return undefined;
  const remainingMs = expiresAt - now;
  if (remainingMs <= 1) return undefined;
  const leadMs = Math.min(maximumLeadMs, Math.max(1, Math.floor(remainingMs / 5)));
  return Math.min(2_147_000_000, Math.max(1, remainingMs - leadMs));
};

export type CodingViewerGrantRenewal = {
  readonly arm: (expiresAt: number, renewalExpiresAt?: number) => void;
  readonly stop: () => void;
};

/** One generation-fenced, single-timer loop for overlapping exact-run grants. */
export const createCodingViewerGrantRenewal = <Grant extends {
  readonly expiresAt: number;
  readonly renewalExpiresAt?: number;
}>(options: {
  readonly now: () => number;
  readonly setTimer: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimer: (timer: unknown) => void;
  readonly mint: () => Promise<Grant>;
  readonly redeem: (grant: Grant) => Promise<void>;
  readonly onError: (error: unknown) => void;
  readonly maximumLeadMs?: number;
}): CodingViewerGrantRenewal => {
  let generation = 0;
  let timer: unknown;
  const clear = (): void => {
    if (timer !== undefined) options.clearTimer(timer);
    timer = undefined;
  };
  const renewal: CodingViewerGrantRenewal = {
    arm: (expiresAt, renewalExpiresAt) => {
      const selectedGeneration = ++generation;
      clear();
      const effectiveExpiresAt = Number.isSafeInteger(renewalExpiresAt)
        ? Math.min(expiresAt, renewalExpiresAt!)
        : expiresAt;
      const delayMs = codingViewerGrantRefreshDelay(
        effectiveExpiresAt,
        options.now(),
        options.maximumLeadMs,
      );
      if (delayMs === undefined) {
        options.onError(new Error("Coding viewer grant expired before renewal"));
        return;
      }
      timer = options.setTimer(() => {
        timer = undefined;
        void options.mint().then(async (grant) => {
          if (selectedGeneration !== generation) return;
          await options.redeem(grant);
          if (selectedGeneration !== generation) return;
          renewal.arm(grant.expiresAt, grant.renewalExpiresAt);
        }).catch((error: unknown) => {
          if (selectedGeneration === generation) options.onError(error);
        });
      }, delayMs);
    },
    stop: () => {
      generation += 1;
      clear();
    },
  };
  return renewal;
};
