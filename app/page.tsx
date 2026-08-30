import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  IconArrowRight,
  IconBuildingStore,
  IconCamera,
  IconCheck,
  IconHome,
  IconMapPin,
  IconPackageExport,
  IconPhotoCheck,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconTool,
  IconTruckDelivery,
  IconUserCheck,
  IconUsers,
} from "@tabler/icons-react";
import { Brand } from "@/components/brand";

const customerSignInUrl = "/sign-in?portal=customer&redirect_url=/dashboard";
const scoutSignInUrl = "/sign-in?portal=scout&redirect_url=/dashboard";

const useCases = [
  {
    icon: IconTool,
    type: "Move It",
    title: "Keep the jobsite moving.",
    text: "Send a Scout to pick up a prepaid auto part, tool or supply order and bring it directly to the crew.",
    examples: ["Auto parts", "Tools", "Supplies"],
    href: "/request?type=move-it",
    cta: "Deliver to the jobsite",
    accent: "coral",
    size: "compact",
  },
  {
    icon: IconPackageExport,
    type: "Move It",
    title: "Send it across town.",
    text: "Deliver documents, a small package or a prepaid store order to a home or business, with status updates and proof of delivery.",
    examples: ["Packages", "Documents", "Store orders"],
    href: "/request?type=move-it",
    cta: "Start a delivery",
    accent: "navy",
    size: "compact",
  },
  {
    icon: IconPhotoCheck,
    type: "See It",
    title: "Get eyes on a property.",
    text: "Request current photos or video of a rental home, business sign, used equipment or repair—without making the trip.",
    examples: ["Rental homes", "Business signs", "Equipment"],
    href: "/request?type=see-it",
    cta: "Request photos or video",
    accent: "teal",
    size: "wide",
  },
  {
    icon: IconUsers,
    type: "Meet It",
    title: "Be there without being there.",
    text: "Have a Scout meet a contractor or cover an internet-installation or service window, confirm what happened and report back.",
    examples: ["Contractors", "Internet installers", "Service windows"],
    href: "/request?type=meet-it",
    cta: "Cover an appointment",
    accent: "coral",
    size: "wide",
  },
];

export default async function Home() {
  const { userId } = await auth();
  return (
    <main>
      <header className="site-header shell">
        <Brand />
        <nav aria-label="Main navigation">
          <a href="#how">How it works</a>
          <a href="#missions">Ways to use it</a>
        </nav>
        <div className="header-actions">
          {userId ? <Link className="text-link desktop-account-link" href="/dashboard">Dashboard</Link> : <nav aria-label="Account sign in" className="desktop-auth-links">
            <Link className="text-link" href={customerSignInUrl}>Customer sign in</Link>
            <Link className="text-link" href={scoutSignInUrl}>Scout sign in</Link>
          </nav>}
          <Link className="button button-small" href="/request">Send a Scout</Link>
        </div>
        {userId
          ? <Link className="mobile-account-link" href="/dashboard">Open my dashboard</Link>
          : <nav aria-label="Account sign in" className="mobile-auth-links">
            <Link href={customerSignInUrl}>Customer sign in</Link>
            <Link href={scoutSignInUrl}>Scout sign in</Link>
          </nav>}
      </header>

      <section className="hero shell">
        <div className="hero-copy">
          <div className="eyebrow"><IconSparkles size={17} /> Local help, beyond delivery</div>
          <h1>Need someone there?<br /><em>Send a Scout.</em></h1>
          <p className="hero-lede">
            A trusted local person can check it, move it, meet it or wait for it—so you can be in two places at once.
          </p>
          <div className="hero-actions">
            <Link className="button" href="/request">Start a mission <IconArrowRight size={20} /></Link>
            <Link className="button button-ghost" href="/scout">Earn as a Scout</Link>
          </div>
          <div className="trust-row">
            <span><IconShieldCheck size={18} /> Vetted local Scouts</span>
            <span><IconMapPin size={18} /> Built for communities across the U.S.</span>
          </div>
        </div>

        <div className="mission-visual" aria-label="Example active mission">
          <div className="orbit orbit-one" />
          <div className="orbit orbit-two" />
          <div className="map-dot dot-one" />
          <div className="map-dot dot-two" />
          <div className="active-card">
            <div className="active-card-head">
              <span className="avatar"><IconUserCheck size={25} /></span>
              <div><small>Your Scout</small><strong>Jordan is en route</strong></div>
              <span className="live-pill">LIVE</span>
            </div>
            <div className="route-track"><span /><i /></div>
            <div className="active-route">
              <div><small>Mission</small><strong>Photograph equipment</strong></div>
              <div className="eta"><small>ETA</small><strong>14 min</strong></div>
            </div>
            <div className="mission-status"><IconCheck size={17} /> Details confirmed with your Scout</div>
          </div>
          <div className="floating-chip chip-one"><IconCamera size={20} /> See It</div>
          <div className="floating-chip chip-two"><IconRoute size={20} /> Scout on the move</div>
        </div>
      </section>

      <section className="mission-section" id="missions" aria-labelledby="use-cases-title">
        <div className="shell">
          <div className="section-heading">
            <div><span className="kicker">Real-life errands, solved</span><h2 id="use-cases-title">No truck? Not nearby? Can’t wait around? Send a Scout.</h2></div>
            <p>You make the purchase or book the appointment. A vetted local Scout handles the in-person part and keeps you updated.</p>
          </div>
          <div className="use-case-grid">
            <article className="use-case-card use-case-featured">
              <div className="use-case-card-head">
                <span className="use-case-icon featured"><IconTruckDelivery size={29} aria-hidden="true" /></span>
                <span className="use-case-type">Move It</span>
              </div>
              <span className="use-case-question">Need a pickup truck?</span>
              <h3>Buy it there. We’ll help get it home.</h3>
              <p>Purchase and prepay for a BBQ grill, boxed picnic table or other bulky store item. Choose the larger-item option so Scouts with an SUV, van or pickup can see the mission.</p>
              <ol className="pickup-journey" aria-label="How a store-pickup mission works">
                <li><span><IconBuildingStore size={22} aria-hidden="true" /></span><div><small>Step 1</small><strong>You buy &amp; prepay</strong></div></li>
                <li><span><IconTruckDelivery size={22} aria-hidden="true" /></span><div><small>Step 2</small><strong>A Scout picks it up</strong></div></li>
                <li><span><IconHome size={22} aria-hidden="true" /></span><div><small>Step 3</small><strong>Delivered to you</strong></div></li>
              </ol>
              <Link className="use-case-link use-case-link-light" href="/request?type=move-it">Arrange a store pickup <IconArrowRight size={18} aria-hidden="true" /></Link>
            </article>

            {useCases.map(({ icon: Icon, ...useCase }) => (
              <article className={`use-case-card use-case-${useCase.size}`} key={useCase.title}>
                <div className="use-case-card-head">
                  <span className={`use-case-icon ${useCase.accent}`}><Icon size={27} aria-hidden="true" /></span>
                  <span className="use-case-type">{useCase.type}</span>
                </div>
                <h3>{useCase.title}</h3>
                <p>{useCase.text}</p>
                <ul className="use-case-examples" aria-label={`${useCase.title} examples`}>
                  {useCase.examples.map((example) => <li key={example}>{example}</li>)}
                </ul>
                <Link className="use-case-link" href={useCase.href}>{useCase.cta} <IconArrowRight size={18} aria-hidden="true" /></Link>
              </article>
            ))}
          </div>
          <div className="use-case-endcap">
            <div><IconSparkles size={23} aria-hidden="true" /><p><strong>Have something else in mind?</strong> If it’s safe, legal and clearly described, tell us what needs to happen and what success looks like.</p></div>
            <Link className="button button-dark" href="/request">Describe your mission <IconArrowRight size={20} aria-hidden="true" /></Link>
          </div>
        </div>
      </section>

      <section className="how shell" id="how">
        <div className="how-intro">
          <span className="kicker">Simple by design</span>
          <h2>Post it. Match. Consider it scouted.</h2>
          <p>Tell us what needs to happen and where. Nearby Scouts can claim the mission, keep you updated and document the result.</p>
          <Link className="button button-dark" href="/request">Create your first mission <IconArrowRight size={20} /></Link>
        </div>
        <ol className="steps">
          <li><span>01</span><div><h3>Describe the mission</h3><p>Choose See It, Move It or Meet It and tell us exactly what success looks like.</p></div></li>
          <li><span>02</span><div><h3>Match with a Scout</h3><p>A vetted local accepts the mission. You’ll know who is going and when they’ll arrive.</p></div></li>
          <li><span>03</span><div><h3>Follow along</h3><p>Receive live status updates, photos and confirmation. Release payment when the mission is complete.</p></div></li>
        </ol>
      </section>

      <section className="scout-cta">
        <div className="shell scout-cta-inner">
          <div>
            <span className="kicker light">Founding Scouts wanted</span>
            <h2>Every mission is different.<br />And every mission pays.</h2>
          </div>
          <div className="scout-cta-copy">
            <p>Turn your local knowledge and spare time into better-paying work. No registration cost, no scheduled shifts and same-day payout options.</p>
            <Link className="button button-light" href="/scout">Join the Scout network <IconArrowRight size={20} /></Link>
          </div>
        </div>
      </section>

      <footer className="footer shell">
        <Brand />
        <p>© 2026 Send a Scout LLC. Your trusted local presence, on demand.</p>
        <div><a href="mailto:support@sendascout.com">support@sendascout.com</a><Link href="/policies">Policies</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></div>
      </footer>
    </main>
  );
}
