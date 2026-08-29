import { PolicyPage } from "@/components/policy-page";

export const metadata = { title: "Privacy | Send a Scout", description: "How Send a Scout uses account, mission, location and communication data." };

export default function PrivacyPage() {
  return <PolicyPage eyebrow="Privacy notice" title="Privacy built around the mission." intro="We collect the information needed to match, operate, document and support local missions.">
    <section><h2>Information we use</h2><p>This may include account contact information, profile details, mission addresses and instructions, payment records, private mission messages, results, ratings and device-provided location during active work.</p></section>
    <section><h2>Scout identity</h2><p>After a Scout accepts a mission, the paying customer may see the Scout’s first name, headshot, completed-mission count and aggregate rating. Phone numbers remain private and mission communication stays inside Send a Scout.</p></section>
    <section><h2>Location</h2><p>Scout location sharing is limited to active missions. Customers see an approximate location. We keep the latest location heartbeat needed for live status and verification, not a permanent breadcrumb trail, and remove it when sharing stops or the mission ends.</p></section>
    <section><h2>Email and future text alerts</h2><p>Transactional email updates can be controlled in account settings. If text alerts are introduced, they will require separate affirmative consent; consent will not be required to use the marketplace, and opt-out instructions will be included.</p></section>
    <section><h2>Service providers and retention</h2><p>We use providers for authentication, hosting, databases, file storage, maps, email and, when activated, payments and text messaging. We retain records as reasonably needed for operations, safety, taxes, disputes and legal obligations, then delete or de-identify them where appropriate.</p></section>
    <section><h2>Your choices</h2><p>You may update profile and notification settings in your dashboard. For access or deletion requests, contact hello@sendascout.com. Certain transaction or safety records may need to be retained.</p></section>
  </PolicyPage>;
}
