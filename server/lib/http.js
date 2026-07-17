// Wrap fetch with an AbortSignal timeout so no external call can park a
// tenant transaction on the DB pool while a slow processor (MP, Stripe,
// Facturapi, Twilio, Uber Direct, Clip, Anthropic) hangs. Without a
// timeout one slow processor day exhausts the 30-connection tenant pool
// and every tenant reads "Service temporarily unavailable".
//
// Callers can pass their own AbortSignal in opts.signal; we combine with
// the timeout signal via AbortSignal.any() so whichever fires first wins.
export function fetchWithTimeout(url, opts = {}, timeoutMs = 8000) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...opts, signal });
}
