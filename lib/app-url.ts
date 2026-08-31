type AppUrlEnvironment = Record<string, string | undefined>;

function withoutTrailingSlashes(value: string) {
  return value.replace(/\/+$/, "");
}

function vercelHttpsUrl(value: string) {
  return `https://${withoutTrailingSlashes(value.replace(/^https?:\/\//i, ""))}`;
}

export function getAppUrl(environment: AppUrlEnvironment = process.env) {
  if (environment.VERCEL_ENV === "preview") {
    const previewHost = environment.VERCEL_BRANCH_URL?.trim() || environment.VERCEL_URL?.trim();
    if (previewHost) return vercelHttpsUrl(previewHost);
  }

  const configured = environment.NEXT_PUBLIC_APP_URL?.trim();
  return withoutTrailingSlashes(configured || "https://sendascout.com");
}
