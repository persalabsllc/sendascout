import { OnboardingForm } from "@/components/onboarding-form";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function ScoutPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/scout");
  return <OnboardingForm mode="scout" />;
}
