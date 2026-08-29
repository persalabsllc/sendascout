import { SignIn } from "@clerk/nextjs";
import { Brand } from "@/components/brand";

export const metadata = { title: "Sign in | Send a Scout", robots: { index: false, follow: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url: requestedRedirect } = await searchParams;
  const redirectUrl = safeRedirect(requestedRedirect, "/dashboard");
  return <main className="auth-page"><Brand /><SignIn signUpUrl={`/sign-up?redirect_url=${encodeURIComponent(redirectUrl)}`} fallbackRedirectUrl={redirectUrl} /></main>;
}

function safeRedirect(value: string | undefined, fallback: string) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
