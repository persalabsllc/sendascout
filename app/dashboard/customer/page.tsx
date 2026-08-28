import { Dashboard } from "@/components/dashboard";

export const metadata = { title: "Customer Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default function CustomerDashboard() {
  return <Dashboard role="customer" />;
}
