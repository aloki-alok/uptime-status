// Probes a single HTTP target and reports up/down using the DOWN=0 convention
// shared with @uptime-status/uptime-math. Never throws: failure is a return value.

export type CheckTarget = {
  url: string;
  timeoutMs?: number;
  acceptedStatus?: string[];
  confirmRetries?: number;
};

export type CheckResult = {
  status: 1 | 0;
  responseMs: number;
  httpStatus?: number;
  error?: string;
};

type FetchImpl = typeof fetch;

function parseAcceptedStatus(entries: string[]) {
  return entries.map((entry) => {
    const [min, max] = entry.includes("-")
      ? entry.split("-").map(Number)
      : [Number(entry), Number(entry)];
    return { min, max };
  });
}

function isAccepted(httpStatus: number, ranges: { min: number; max: number }[]) {
  return ranges.some(({ min, max }) => httpStatus >= min && httpStatus <= max);
}

async function attempt(
  url: string,
  timeoutMs: number,
  fetchImpl: FetchImpl,
): Promise<{ ok: boolean; responseMs: number; httpStatus?: number; error?: string }> {
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    const responseMs = Math.round(performance.now() - startedAt);
    return { ok: true, responseMs, httpStatus: response.status };
  } catch (err) {
    const responseMs = Math.round(performance.now() - startedAt);
    return { ok: false, responseMs, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function check(
  target: CheckTarget,
  fetchImpl: FetchImpl = globalThis.fetch,
): Promise<CheckResult> {
  const timeoutMs = target.timeoutMs ?? 10_000;
  const ranges = parseAcceptedStatus(target.acceptedStatus ?? ["200-299"]);
  const confirmRetries = target.confirmRetries ?? 1;
  const succeeded = (result: Awaited<ReturnType<typeof attempt>>) =>
    result.ok && result.httpStatus !== undefined && isAccepted(result.httpStatus, ranges);

  // Runs at least once, plus up to confirmRetries more on failure.
  let last = await attempt(target.url, timeoutMs, fetchImpl);
  for (let retry = 0; retry < confirmRetries && !succeeded(last); retry++) {
    last = await attempt(target.url, timeoutMs, fetchImpl);
  }

  if (succeeded(last))
    return { status: 1, responseMs: last.responseMs, httpStatus: last.httpStatus };
  return { status: 0, responseMs: last.responseMs, httpStatus: last.httpStatus, error: last.error };
}
