import { OnboardingForm } from "@/components/onboarding-form";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";

export default async function RequestPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in?redirect_url=/request");
  const { type } = await searchParams;
  const initialMissionType = type === "move-it" ? "move" : type === "meet-it" ? "meet" : "see";
  return <OnboardingForm mode="customer" initialMissionType={initialMissionType} />;
}
