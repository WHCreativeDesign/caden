// Tracks whether a chat turn (web UI or Telegram) is actively in flight.
// update.ts's self-update watcher checks this before restarting: a turn can
// legitimately run for up to several minutes now (see runAgentTurnRetrying
// in agent.ts), and a self-update racing that used to just call
// process.exit(0) mid-request with zero coordination — hard-killing the
// connection, which the browser reports as a raw "Failed to fetch". Waiting
// for idle before restarting fixes that without needing either side to know
// details about the other.
let active = 0;

export function markBusy(): void {
  active++;
}

export function markIdle(): void {
  active = Math.max(0, active - 1);
}

export function isBusy(): boolean {
  return active > 0;
}
