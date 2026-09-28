const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

function statusOf(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

function isRetryable(err: unknown): boolean {
  const status = statusOf(err);
  if (status === undefined) return err instanceof TypeError; // fetch() tira TypeError en fallas de red
  if (!RETRYABLE_STATUS.has(status)) return false;
  // Una cuota diaria agotada no se libera esperando unos segundos.
  return !(status === 429 && /PerDay/i.test(String((err as Error).message)));
}

/** Gemini indica cuánto esperar en los 429 ("retryDelay": "37s"); si no, backoff exponencial. */
function delayMs(err: unknown, attempt: number): number {
  const hint = /"retryDelay":\s*"(\d+(?:\.\d+)?)s"/.exec(String((err as Error)?.message));
  if (hint) return Math.ceil(Number(hint[1]) * 1000) + 500;
  // 503 "high demand": la saturación dura más que unos segundos; reintentar rápido solo gasta requests.
  if (statusOf(err) === 503) return 20_000 * attempt + Math.random() * 2000;
  return Math.min(2 ** attempt * 1000, 30_000) + Math.random() * 500;
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 6,
  log: (line: string) => void = (line) => console.warn(`  ${line}`),
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const wait = delayMs(err, attempt);
      const reason = statusOf(err) === 503 ? "503 (Google saturado)" : (statusOf(err) ?? "error de red");
      log(`${label}: ${reason}, reintento ${attempt}/${attempts - 1} en ${Math.round(wait / 1000)}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
