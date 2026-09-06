import { spawnSync } from "node:child_process";

const PROCESS_RSS_POLL_MS = 500;

/**
 * Sums resident memory for a root process and every descendant reachable
 * through parent links. macOS enforces neither RLIMIT_AS nor RLIMIT_RSS, so
 * polling ps is the only portable resident-memory ceiling; Windows reports 0
 * and stays unguarded, matching descendant cancellation semantics.
 */
export const processTreeRssBytes = (rootPid: number): number => {
  if (process.platform === "win32") return 0;
  const listed = spawnSync("ps", ["-axo", "pid=,ppid=,rss="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (listed.status !== 0 || typeof listed.stdout !== "string") return 0;
  const children = new Map<number, number[]>();
  const rssKilobytes = new Map<number, number>();
  for (const line of listed.stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    rssKilobytes.set(pid, Number(match[3]));
    const siblings = children.get(parentPid) ?? [];
    siblings.push(pid);
    children.set(parentPid, siblings);
  }
  let totalKilobytes = rssKilobytes.get(rootPid) ?? 0;
  const pending = [...(children.get(rootPid) ?? [])];
  while (pending.length > 0) {
    const pid = pending.shift()!;
    totalKilobytes += rssKilobytes.get(pid) ?? 0;
    pending.push(...(children.get(pid) ?? []));
  }
  return totalKilobytes * 1024;
};

export type ProcessRssGuard = {
  readonly stop: () => void;
};

/**
 * Watches a process tree and reports the first observed breach of the
 * resident-memory ceiling. Enforcement stays with the caller so the command
 * runner keeps a single termination authority.
 */
export const startProcessRssGuard = (input: {
  readonly rootPid: number;
  readonly maxRssBytes: number;
  readonly pollMs?: number;
  readonly onExceeded: (rssBytes: number) => void;
}): ProcessRssGuard => {
  const timer = setInterval(() => {
    const rssBytes = processTreeRssBytes(input.rootPid);
    if (rssBytes <= input.maxRssBytes) return;
    clearInterval(timer);
    input.onExceeded(rssBytes);
  }, input.pollMs ?? PROCESS_RSS_POLL_MS);
  timer.unref();
  return { stop: () => clearInterval(timer) };
};
