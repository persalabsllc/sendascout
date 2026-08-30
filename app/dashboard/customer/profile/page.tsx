import { CustomerProfileForm } from "@/components/customer-profile-form";
import { requireAppUser } from "@/lib/app-user";

export const metadata = { title: "Your Profile | Send a Scout", robots: { index: false, follow: false } };

export default async function CustomerProfilePage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const user = await requireAppUser("customer");
  const { next } = await searchParams;
  const nextPath = next === "/request" || next?.startsWith("/request?") || next === "/dashboard/customer" ? next : "/dashboard/customer";

  return <CustomerProfileForm nextPath={nextPath} initialValue={{
    firstName: user.firstName ?? "",
    lastName: user.lastName ?? "",
    phone: user.phone ?? "",
    addressLine1: user.addressLine1 ?? "",
    addressLine2: user.addressLine2 ?? "",
    city: user.city ?? "",
    state: user.state ?? "NC",
    zip: user.zip ?? "",
    emailNotificationsEnabled: user.emailNotificationsEnabled,
    smsNotificationsEnabled: user.smsNotificationsEnabled,
  }} />;
}
