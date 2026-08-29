import { SignUp } from "@clerk/nextjs";
import { Brand } from "@/components/brand";

export const metadata = { title: "Create account | Send a Scout", robots: { index: false, follow: false } };

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ redirect_url?: string }> }) {
  const { redirect_url: requestedRedirect } = await searchParams;
  const redirectUrl = safeRedirect(requestedRedirect, "/dashboard");
  return <main className="auth-page"><Brand /><SignUp signInUrl={`/sign-in?redirect_url=${encodeURIComponent(redirectUrl)}`} fallbackRedirectUrl={redirectUrl} /></main>;
}

function safeRedirect(value: string | undefined, fallback: string) {
  return value?.startsWith("/") && !value.startsWith("//") ? value : fallback;
}
