import { OnboardingForm } from "@/components/onboarding-form";
import { redirect } from "next/navigation";
import { requireAppUser } from "@/lib/app-user";

export default async function RequestPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const initialMissionType = type === "move-it" ? "move" : type === "meet-it" ? "meet" : "see";
  const requestPath = type ? `/request?type=${encodeURIComponent(type)}` : "/request";
  const user = await requireAppUser("customer");
  if (!user.profileCompletedAt) redirect(`/dashboard/customer/profile?next=${encodeURIComponent(requestPath)}`);
  return <OnboardingForm mode="customer" initialMissionType={initialMissionType} initialMissionAddress={{
    address: user.addressLine1 ?? "",
    addressLine2: user.addressLine2 ?? "",
    city: user.city ?? "",
    zip: user.zip ?? "",
  }} initialPhone={user.phone ?? ""} />;
}
