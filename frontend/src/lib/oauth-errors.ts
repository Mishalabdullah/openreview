/** Never echo provider messages, authorization codes, or callback URLs. */
export function safeOAuthErrorCode(value: string | null) {
  if (!value) return null;
  const code = value.toLowerCase();
  const allowed = [
    "access_denied",
    "user_denied",
    "state_mismatch",
    "state_not_found",
    "invalid_state",
    "invalid_installation_state",
    "email_not_found",
    "email_not_verified",
    "unable_to_link_account",
    "account_already_linked",
    "signup_disabled",
    "invalid_code",
    "invalid_authorization_code",
    "internal_server_error",
    "service_unavailable",
  ];
  return allowed.includes(code) ? code : "oauth_error";
}

export function oauthErrorMessage(code: string | null | undefined) {
  if (!code) return "";
  switch (code.toLowerCase()) {
    case "access_denied":
    case "user_denied":
      return "GitHub authorization was cancelled. You can try again when ready.";
    case "state_mismatch":
    case "state_not_found":
    case "invalid_state":
    case "invalid_installation_state":
      return "The authorization request expired or could not be verified. Start the connection again in this browser.";
    case "email_not_found":
    case "email_not_verified":
      return "GitHub did not provide a verified email. Check your account email and the app's email permission.";
    case "unable_to_link_account":
    case "account_already_linked":
      return "This GitHub account could not be linked. Use the account originally connected to OpenReview or contact support.";
    case "signup_disabled":
      return "New account registration is currently disabled. Contact an administrator.";
    case "invalid_code":
    case "invalid_authorization_code":
      return "This authorization attempt is no longer valid. Start GitHub sign-in again.";
    case "internal_server_error":
    case "service_unavailable":
      return "The sign-in service is temporarily unavailable. Please try again later.";
    default:
      return "GitHub authorization could not be completed. Try again, or contact support if it keeps failing.";
  }
}
