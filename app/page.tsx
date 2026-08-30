import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import {
  IconArrowRight,
  IconBox,
  IconCamera,
  IconCheck,
  IconClock,
  IconMapPin,
  IconRoute,
  IconShieldCheck,
  IconSparkles,
  IconUserCheck,
} from "@tabler/icons-react";
import { Brand } from "@/components/brand";

const customerSignInUrl = "/sign-in?portal=customer&redirect_url=/dashboard";
const scoutSignInUrl = "/sign-in?portal=scout&redirect_url=/dashboard";

const missions = [
  {
    icon: IconCamera,
    name: "See It",
    price: "$29",
    text: "Get current photos, video and answers from a real person standing there.",
    accent: "teal",
  },
  {
    icon: IconBox,
    name: "Move It",
    price: "From $19",
    text: "Move a small prepaid item across town from $19. Distance and larger-item pricing is shown before you submit.",
    accent: "coral",
  },
  {
    icon: IconClock,
    name: "Meet It",
    price: "$25/hr · $29 min",
    text: "Have a Scout meet a vendor, wait for a technician or be present for you.",
    accent: "navy",
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
          <a href="#missions">What Scouts do</a>
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
            <span><IconMapPin size={18} /> Starting in Eastern NC</span>
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

      <section className="mission-section" id="missions">
        <div className="shell">
          <div className="section-heading">
            <div><span className="kicker">One app. A thousand possibilities.</span><h2>What can we handle for you?</h2></div>
            <p>Not another food-delivery app. Send a Scout is built for the errands that still require an actual human being.</p>
          </div>
          <div className="mission-grid">
            {missions.map(({ icon: Icon, ...mission }) => (
              <article className={`mission-card ${mission.accent}`} key={mission.name}>
                <div className="mission-icon"><Icon size={28} /></div>
                <div className="mission-title"><h3>{mission.name}</h3><span>{mission.price}</span></div>
                <p>{mission.text}</p>
                <Link href={`/request?type=${mission.name.toLowerCase().replace(" ", "-")}`}>Start this mission <IconArrowRight size={18} /></Link>
              </article>
            ))}
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
