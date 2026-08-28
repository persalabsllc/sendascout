import { SignIn } from "@clerk/nextjs";
import { Brand } from "@/components/brand";

export const metadata = { title: "Sign in | Send a Scout", robots: { index: false, follow: false } };

export default function SignInPage() {
  return <main className="auth-page"><Brand /><SignIn signUpUrl="/sign-up" fallbackRedirectUrl="/dashboard" /></main>;
}
