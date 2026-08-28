import { redirect } from "next/navigation";
import { requireAppUser } from "@/lib/app-user";

export default async function DashboardIndex() {
  const user = await requireAppUser("customer");
  if (user.role === "admin") redirect("/control-room");
  redirect(user.role === "scout" ? "/dashboard/scout" : "/dashboard/customer");
}
