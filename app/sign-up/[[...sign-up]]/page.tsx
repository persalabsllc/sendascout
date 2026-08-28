import { SignUp } from "@clerk/nextjs";
import { Brand } from "@/components/brand";

export const metadata = { title: "Create account | Send a Scout", robots: { index: false, follow: false } };

export default function SignUpPage() {
  return <main className="auth-page"><Brand /><SignUp signInUrl="/sign-in" fallbackRedirectUrl="/dashboard" /></main>;
}
