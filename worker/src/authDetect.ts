/**
 * Worker auth failure is IN-BAND on some CLI versions ("Not logged in" as a
 * successful $0 result) and a thrown 401 stream error on others. Both must be
 * detected from text — never from the exit code — and routed to a
 * factory-health notification, never a step retry.
 */
export function isAuthFailureText(text: string): boolean {
  return /not logged in|invalid api key|please run \/login|authentication_error|401.*oauth|oauth.*(invalid|expired|revoked)|failed to authenticate/i.test(
    text,
  );
}
