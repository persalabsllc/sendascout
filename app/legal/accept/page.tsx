import Link from "next/link";
import { redirect } from "next/navigation";
import { acceptLegalTerms } from "@/app/actions/legal";
import { Brand } from "@/components/brand";
import { requireAuthenticatedAppUser } from "@/lib/app-user";
import { hasCurrentLegalAcceptance, LEGAL_VERSION } from "@/lib/legal";

export const metadata = { title: "Accept Marketplace Terms | Send a Scout", robots: { index: false, follow: false } };

export default async function LegalAcceptancePage() {
  const user = await requireAuthenticatedAppUser("customer");
  if (hasCurrentLegalAcceptance(user)) redirect(user.role === "scout" ? "/dashboard/scout" : user.role === "admin" ? "/control-room" : "/dashboard/customer");

  return <main className="legal-accept-page">
    <header><Brand href="/" /><span>Agreement version {LEGAL_VERSION}</span></header>
    <section className="legal-accept-card">
      <span className="kicker">Before entering the marketplace</span>
      <h1>Review and accept Send a Scout’s agreements.</h1>
      <p className="legal-accept-intro">These agreements govern customer requests, Scout services, payments, cancellations, safety, privacy and dispute resolution. Your acceptance is recorded with your account and the agreement version.</p>
      <div className="legal-summary-grid">
        <article><strong>Marketplace terms</strong><p>Send a Scout operates the marketplace; Scouts are independent providers who choose their missions.</p></article>
        <article><strong>Payments and refunds</strong><p>Mission charges, cancellations, refunds and payout holds follow the Marketplace Policies.</p></article>
        <article><strong>Risk and liability</strong><p>The Terms include important disclaimers, limits of liability and user responsibilities.</p></article>
        <article><strong>Individual arbitration</strong><p>Most disputes must be resolved through individual binding arbitration, with small-claims and opt-out rights.</p></article>
      </div>
      <p className="legal-document-links"><Link href="/terms" target="_blank">Terms of Service</Link><Link href="/policies" target="_blank">Marketplace & Refund Policies</Link><Link href="/privacy" target="_blank">Privacy Notice</Link></p>
      <form action={acceptLegalTerms} className="legal-accept-form">
        <label><input type="checkbox" name="agreements" value="accepted" required /><span>I have read and agree to the <Link href="/terms" target="_blank">Terms of Service</Link> and <Link href="/policies" target="_blank">Marketplace Policies</Link>, acknowledge the <Link href="/privacy" target="_blank">Privacy Notice</Link>, and consent to electronic records and signatures.</span></label>
        <label className="arbitration-consent"><input type="checkbox" name="arbitration" value="accepted" required /><span>I specifically agree to the binding individual arbitration agreement and class-action and jury-trial waivers in the Terms, including the right to opt out within 30 days.</span></label>
        <button className="button" type="submit">Accept and enter Send a Scout</button>
      </form>
      <small>Acceptance is required to use the marketplace. You may review these documents before deciding. Questions: <a href="mailto:support@sendascout.com">support@sendascout.com</a>.</small>
    </section>
  </main>;
}
