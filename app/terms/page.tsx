import { PolicyPage } from "@/components/policy-page";

export const metadata = { title: "Terms | Send a Scout", description: "Terms for customers and independent Scouts using Send a Scout." };

export default function TermsPage() {
  return <PolicyPage eyebrow="Terms of service" title="Terms for using Send a Scout." intro="These terms apply to customers, Scouts and anyone using the Send a Scout marketplace.">
    <section><h2>Marketplace role</h2><p>Send a Scout provides technology that helps customers request local tasks and independent Scouts choose whether to accept them. Scouts are not employees, agents or representatives of Send a Scout. They control whether to accept available missions and are responsible for lawful, safe performance.</p></section>
    <section><h2>Accounts and accurate information</h2><p>You must provide accurate account, mission, identity and payment information and keep your sign-in secure. Customers must describe the work honestly. Scouts must maintain accurate service-area, vehicle and qualification information.</p></section>
    <section><h2>Pricing and payment</h2><p>The customer sees the mission price before submission, and the Scout sees the Scout payout before claiming. When payments activate, Send a Scout may authorize or collect the customer total, retain the disclosed platform portion and transfer the Scout payout after completion, subject to refunds, disputes and payment-provider requirements.</p></section>
    <section><h2>Mission record</h2><p>Status events, approximate location during active work, verified route or onsite data, private messages and submitted results may be used to operate the mission and resolve disputes. Long-term breadcrumb location history is not retained; active location is removed when sharing stops or the mission ends.</p></section>
    <section><h2>Ratings and conduct</h2><p>Customers may leave mission-based ratings and reviews. Manipulation, harassment, discrimination, fraud, off-platform payment circumvention and misuse of personal information are prohibited. We may pause or remove accounts to protect the marketplace.</p></section>
    <section><h2>Changes and contact</h2><p>We may update these terms as the service develops. Material changes will be posted here. Questions may be sent to hello@sendascout.com.</p></section>
  </PolicyPage>;
}
