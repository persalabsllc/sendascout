const UNSUPPORTED_SOCIAL_WEBVIEW = /(?:FBAN|FBAV|FB_IAB|FBIOS|FB4A|Instagram|Messenger)/i;

/**
 * Stripe-hosted Connect onboarding is not supported inside embedded webviews.
 * Facebook and Instagram are the known acquisition paths that commonly open
 * Send a Scout inside one, so block the handoff before creating an Account Link.
 */
export function isUnsupportedStripeEmbeddedBrowser(userAgent: string | null | undefined) {
  return Boolean(userAgent && UNSUPPORTED_SOCIAL_WEBVIEW.test(userAgent));
}
