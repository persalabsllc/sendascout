import { SignIn } from "@clerk/nextjs";
import { safeLocalReturn } from "@/lib/see-it";
import { Brand } from "@/components/brand";

export const metadata = { title: "Sign in | Send a Scout", robots: { index: false, follow: false } };

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string; portal?: string }> }) {
  const { redirect_url: requestedRedirect, portal: requestedPortal } = await searchParams;
  const redirectUrl = safeLocalReturn(requestedRedirect, "/dashboard");
  const signUpRedirect = safeLocalReturn(requestedRedirect, requestedPortal === "scout" ? "/scout" : "/dashboard");
  return <main className="auth-page"><Brand /><SignIn signUpUrl={`/sign-up?redirect_url=${encodeURIComponent(signUpRedirect)}`} fallbackRedirectUrl={redirectUrl} /></main>;
}
