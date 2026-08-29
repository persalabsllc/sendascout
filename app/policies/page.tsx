import { PolicyPage } from "@/components/policy-page";

export const metadata = { title: "Marketplace Policies | Send a Scout", description: "Mission cancellation, completion, refund and dispute policies for Send a Scout." };

export default function PoliciesPage() {
  return <PolicyPage eyebrow="Marketplace policies" title="Clear rules for every mission." intro="These operating rules explain when missions become binding, how completion works and what happens when plans change.">
    <section><h2>Cancellations</h2><p>A customer may cancel an unclaimed mission without a Scout cancellation fee. After a Scout accepts, cancellation charges may cover verified travel or work already performed. The exact amount will be shown before payment is finalized. A Scout who cannot complete an accepted mission must cancel promptly; repeated avoidable cancellations may pause the Scout account.</p></section>
    <section><h2>Results and 24-hour approval</h2><p>After a Scout submits results, the customer has 24 hours to review them, confirm completion or report a problem. If no action is taken, the mission is automatically marked complete. Automatic completion does not remove the customer’s right to contact support about a legitimate issue.</p></section>
    <section><h2>Refunds and disputes</h2><p>Customers should report missing, materially incomplete or misrepresented work as soon as possible. Send a Scout may review mission instructions, timestamps, verified location events, route data, messages and submitted evidence. Refunds may be full, partial or denied based on the work completed and the available record. Payment disputes or chargebacks may pause related payouts while they are investigated.</p></section>
    <section><h2>Tips</h2><p>Tips are optional, go to the Scout except for unavoidable payment-processing adjustments, and do not change the platform fee. During the pre-payment test period, tip choices are recorded for product testing and no card is charged.</p></section>
    <section><h2>Safety and prohibited missions</h2><p>Scouts may decline unsafe, illegal, regulated, age-restricted or materially misrepresented work. Customers must not request transport of people, weapons, controlled substances, hazardous materials, cash or items that were not lawfully purchased or authorized.</p></section>
  </PolicyPage>;
}
