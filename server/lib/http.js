// Wrap fetch with an AbortSignal timeout so no external call can park a
// tenant transaction on the DB pool while a slow processor (MP, Stripe,
// Facturapi, Twilio, Uber Direct, Clip, Anthropic) hangs. Without a
// timeout one slow processor day exhausts the 30-connection tenant pool
// and every tenant reads "Service temporarily unavailable".
//
// Callers can pass their own AbortSignal in opts.signal; we combine with
// the timeout signal via AbortSignal.any() so whichever fires first wins.
//
// The timeout can be set either as the third argument or as opts.timeoutMs
// (handy when the call site builds one big options object). Third argument
// wins if both are given. Default 8000ms — slow-by-nature calls (LLM
// vision/translate, audio transcription) should pass 15000–90000 explicitly.
export function fetchWithTimeout(url, opts = {}, timeoutMs = undefined) {
  const { timeoutMs: optsTimeoutMs, ...rest } = opts;
  const ms = timeoutMs ?? optsTimeoutMs ?? 8000;
  const timeoutSignal = AbortSignal.timeout(ms);
  const signal = rest.signal
    ? AbortSignal.any([rest.signal, timeoutSignal])
    : timeoutSignal;
  return fetch(url, { ...rest, signal });
}
