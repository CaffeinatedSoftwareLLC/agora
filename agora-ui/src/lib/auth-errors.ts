/**
 * Words for the error codes the sign-in routes send (src/routes/auth.ts POST /auth/login and
 * src/routes/passkeys.ts). Shared by the password form and the passkey button, so a code is
 * never shown raw. `account_pending` is not here: the auth store turns it into the /pending page.
 */
const SIGN_IN_ERRORS: Record<string, string> = {
  invalid_credentials: 'Wrong username, email or password.',
  // 429 with Retry-After: the account is locked after repeated failures (15 minutes by
  // default) or the instance-wide limit was hit (one minute)
  too_many_attempts: 'Too many attempts. Wait a few minutes and try again.',
  // 503: the server could not check the login limits, so it refuses rather than let guesses through
  login_unavailable: 'Sign-in is unavailable right now. Try again shortly.',
  account_suspended: 'Your account has been suspended. Contact an administrator.',
};

/** The message for a sign-in error code, or null when the code has no wording here. */
export function signInErrorMessage(code: string | undefined | null): string | null {
  return (code && Object.hasOwn(SIGN_IN_ERRORS, code)) ? SIGN_IN_ERRORS[code] : null;
}
