import { Dashboard } from "@/components/dashboard";

export const metadata = { title: "Scout Dashboard | Send a Scout", robots: { index: false, follow: false } };

export default function ScoutDashboard() {
  return <Dashboard role="scout" />;
}
