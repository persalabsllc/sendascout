import Image from "next/image";
import Link from "next/link";
import { IconArrowRight, IconCamera, IconCar, IconCheck, IconFileDescription, IconHome, IconMapPin, IconPackage, IconTool, IconEye, IconPlayerPlay, IconMessageCircle, IconArrowDown, IconClipboardCheck } from "@tabler/icons-react";
import { Brand } from "@/components/brand";
import { SEE_TEMPLATES, type SeeTemplate } from "@/lib/see-it";
import "@/app/see-it.css";

export const seeIcons = { property: IconHome, vehicle: IconCar, purchase: IconPackage, project: IconTool, custom: IconEye };

const productDetails = {
  property: { label: "Property Check", detail: "Homes. Rentals. Yards.", description: "See the condition of a property without being there." },
  vehicle: { label: "Vehicle Check", detail: "Before you make the drive.", description: "Get photos, displayed mileage, and a visual walkaround." },
  purchase: { label: "Purchase Verification", detail: "Put eyes on it first.", description: "See an item and its visible condition before buying remotely." },
  project: { label: "Project Check", detail: "Progress you can see.", description: "Document the work, from the first day to the finishing touches." },
  custom: { label: "Something Else?", detail: "Your questions. Our eyes.", description: "Build a custom photo and video check at one location." },
};

export function SeeHeader() {
  return (
    <header className="see-header see-shell">
      <Brand />
      <nav aria-label="Main navigation"><Link href="/#checks">What we check</Link><Link href="/#how">How it works</Link><Link href="/missions">Earn as a Scout</Link></nav>
      <div><Link className="see-login" href="/sign-in?redirect_url=/dashboard">Sign in</Link><Link className="button button-small" href="/request">Send a Scout <IconArrowRight size={17} aria-hidden="true" /></Link></div>
    </header>
  );
}

export function SeeFooter() {
  return (
    <footer className="see-footer see-shell">
      <div><Brand /><p>Real people. A clearer picture.</p></div>
      <nav aria-label="Footer"><Link href="/missions">Find Scout missions</Link><Link href="/scout">Scout account</Link><Link href="/request?type=move-it">Move It</Link><Link href="/request?type=meet-it">Meet It</Link><Link href="mailto:support@sendascout.com">Support</Link><Link href="/policies">Policies</Link><Link href="/terms">Terms</Link><Link href="/privacy">Privacy</Link></nav>
      <small>© {new Date().getFullYear()} Send a Scout LLC.</small>
    </footer>
  );
}

function LocationPreview({ template }: { template?: SeeTemplate }) {
  if (template) {
    const Icon = seeIcons[template.key];
    return (
      <aside className={`see-template-preview see-theme-${template.key}`} aria-label={`${template.name} package overview`}>
        <div className="see-template-preview-top"><span>Your Scout’s assignment</span><Icon size={38} stroke={1.5} aria-hidden="true" /></div>
        <h2>{template.name}</h2><p>A clear checklist.<br />A closer look.</p>
        <ul>{template.tasks.slice(0, 4).map(task => <li key={task.key}><IconCheck size={20} aria-hidden="true" />{task.prompt}</li>)}</ul>
        <div className="see-template-deliverables"><span><IconCamera size={20} aria-hidden="true" /> Up to {template.maxPhotos} photos</span><span><IconPlayerPlay size={20} aria-hidden="true" /> {template.maxVideos} short {template.maxVideos === 1 ? "video" : "videos"}</span></div>
        <Link href="#included">See the full checklist <IconArrowDown size={18} aria-hidden="true" /></Link>
      </aside>
    );
  }
  return (
    <figure className="see-location-preview">
      <div className="see-location-image">
        <Image src="/scout-on-location.webp" alt="Illustrative scene of a person photographing a home from the sidewalk" fill priority sizes="(max-width: 600px) 1px, (max-width: 900px) 90vw, 48vw" />
        <span className="see-location-label"><IconMapPin size={17} aria-hidden="true" /> A real person. On location.</span>
        <figcaption>AI-generated illustrative scene</figcaption>
      </div>
      <div className="see-location-caption"><span className="see-camera-mark"><IconCamera size={26} aria-hidden="true" /></span><div><strong>You ask. We take a look.</strong><span>Photos, video & answers. One clear report.</span></div><IconArrowRight className="see-caption-arrow" size={26} aria-hidden="true" /></div>
    </figure>
  );
}

function MissionChoices() {
  return (
    <section id="checks" className="see-checks see-shell">
      <div className="see-section-heading"><div><span className="see-kicker">WHAT CAN A SCOUT CHECK?</span><h2>What do you need eyes on?</h2></div><p>Pick a check. Add a location.<br />We’ll take it from there.</p></div>
      <div className="see-products">
        {SEE_TEMPLATES.map(item => {
          const Icon = seeIcons[item.key];
          const copy = productDetails[item.key];
          return (
            <Link className={`see-product see-theme-${item.key}`} href={`/${item.slug}`} key={item.key}>
              <div className="see-product-top"><span className="see-product-icon"><Icon size={31} stroke={1.7} aria-hidden="true" /></span><span className="see-product-arrow"><IconArrowRight size={21} aria-hidden="true" /></span></div>
              <h3>{copy.label}</h3><span className="see-product-detail">{copy.detail}</span><p>{copy.description}</p>
              <div className="see-product-bottom"><span>From <b>${item.priceCents / 100}</b></span><span>View check</span></div>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

function IncludedChecklist({ template, href }: { template: SeeTemplate; href: string }) {
  return (
    <section id="included" className="see-section see-shell see-included">
      <div><span className="see-kicker">YOUR {template.name.toUpperCase()}</span><h2>Clear instructions.<br />Useful evidence.</h2><p>One location. Up to {template.maxPhotos} photos and {template.maxVideos === 1 ? "a short video" : `${template.maxVideos} short videos`}, plus written observations and up to five additional questions.</p><p>Standard targets completion within 72 hours of funding. You can specify an earlier or later completion target when requesting your check. We’ll show the assignment cutoff before payment.</p><Link className="button" href={href}>Start a {template.name} <IconArrowRight size={18} aria-hidden="true" /></Link></div>
      <ul>{template.tasks.map(task => <li key={task.key}><IconCheck size={19} aria-hidden="true" /><span>{task.prompt}<small>{task.responseType === "text" ? "Written observation" : task.responseType === "video" ? "Video" : "Photo"}</small></span></li>)}</ul>
    </section>
  );
}

function ReportDeliverables() {
  return (
    <section className="see-section see-shell see-report-pitch">
      <div><span className="see-kicker">THE RESULT? SOMETHING USEFUL.</span><h2>Not a camera roll.<br /><em>A clearer picture.</em></h2><p>Labeled photos. Answers to your questions. The details that matter, organized in a professional PDF you can download and share.</p><Link className="button button-dark" href="/sample-report">Open the sample report <IconArrowRight size={18} aria-hidden="true" /></Link></div>
      <div className="see-report-deliverables">
        <div className="see-deliverable-heading"><span className="see-document-icon"><IconFileDescription size={32} aria-hidden="true" /></span><div><span>INCLUDED WITH EVERY CHECK</span><h3>Your on-location report</h3></div><span className="see-pdf-label">PDF</span></div>
        <div className="see-deliverable-row"><IconCamera size={23} aria-hidden="true" /><div><b>Photos with context</b><p>Labeled views, not a folder of mystery filenames.</p></div></div>
        <div className="see-deliverable-row"><IconMessageCircle size={23} aria-hidden="true" /><div><b>Answers to your questions</b><p>Written observations tied to your Scout’s checklist.</p></div></div>
        <div className="see-deliverable-row"><IconPlayerPlay size={23} aria-hidden="true" /><div><b>Video, one click away</b><p>Links to your video in your private mission workspace.</p></div></div>
        <div className="see-deliverable-row"><IconClipboardCheck size={23} aria-hidden="true" /><div><b>The visit—and its limits</b><p>Visit details and anything the Scout couldn’t check.</p></div></div>
        <p className="see-report-disclaimer">Scouts document observations. Checks are not mechanical inspections, appraisals, or professional assessments.</p>
      </div>
    </section>
  );
}

export function SeeLanding({ template }: { template?: SeeTemplate }) {
  const href = template ? `/request?check=${template.key}` : "/request";
  return (
    <main className="see-site see-landing">
      <SeeHeader />
      <section className="see-hero see-shell">
        <div className="see-hero-copy">
          <span className="see-kicker"><IconEye size={19} aria-hidden="true" /> {template ? template.name.toUpperCase() : "YOUR EYES. ANYWHERE YOU NEED THEM."}</span>
          <h1>{template ? <>{template.key === "vehicle" ? "See the vehicle." : template.key === "property" ? "See the property." : template.key === "purchase" ? "See it before\nyou buy it." : template.key === "project" ? "See the progress." : "Need eyes\nsomewhere?"}<em>Skip the trip.</em></> : <>Need eyes<br />somewhere?<em>Send a Scout.</em></>}</h1>
          <p className="see-lede">{template ? template.description : "Get current photos, video, and answers from a real person on location—without making the trip yourself."}</p>
          <form action="/request" className="see-address-form">
            {template && <input type="hidden" name="check" value={template.key} />}
            <label htmlFor="hero-address">Where do you need eyes?</label>
            <div><IconMapPin size={23} aria-hidden="true" /><input id="hero-address" name="address" placeholder="Enter a location or street address" autoComplete="street-address" /><button className="button" type="submit">Send a Scout <IconArrowRight size={19} aria-hidden="true" /></button></div>
          </form>
          <div className="see-hero-bottom"><p className="see-hero-note">From <b>${template ? template.priceCents / 100 : 39}</b> · No contract · PDF report included</p><Link className="see-underlink" href={template ? "#included" : "#checks"}>Explore checks <IconArrowDown size={16} aria-hidden="true" /></Link></div>
        </div>
        <LocationPreview template={template} />
      </section>
      {template ? <IncludedChecklist template={template} href={href} /> : <MissionChoices />}
      <section id="how" className="see-how"><div className="see-shell">
        <div className="see-how-heading"><div><span className="see-kicker">LOCAL EYES. LESS GUESSWORK.</span><h2>You pick the place.<br />We find your eyes.</h2></div><p>No long drive. No complicated contract.<br />Just a clearer view of what’s there.</p></div>
        <div className="see-steps">
          <article><span>1</span><div><h3>Tell us what to check.</h3><p>Choose a check, enter the location, and add the details that matter to you.</p></div></article>
          <article><span>2</span><div><h3>A local Scout takes a look.</h3><p>We find a Scout to follow your checklist and capture photos, video, and observations.</p></div></article>
          <article><span>3</span><div><h3>Get the whole picture.</h3><p>Review your report in your account. Download a clean PDF to share with anyone who needs it.</p></div></article>
        </div>
        <p className="see-coverage-note">Request a check across the U.S. Availability varies by location. Standard targets 72 hours. If your mission is still unassigned at its stated cutoff, we cancel it and initiate a full refund.</p>
      </div></section>
      <ReportDeliverables />
      <section className="see-scout-band see-shell"><div className="see-scout-symbol" aria-hidden="true"><IconMapPin size={42} stroke={1.7} /></div><div><span className="see-kicker">A LITTLE LOCAL KNOW-HOW GOES A LONG WAY.</span><h2>Get paid to go look.</h2><p>See the work, payout, and deadline before you create a Scout account. Secure weekly payouts through Stripe.</p></div><Link className="button button-light" href="/missions">Browse photo missions <IconArrowRight size={19} aria-hidden="true" /></Link></section>
      <section className="see-section see-shell see-faq"><div><span className="see-kicker">GOOD QUESTIONS</span><h2>Know what<br />to expect.</h2><p>A few things to know before sending your first Scout.</p></div><div>{[
        ["Can I request a check where there aren’t any Scouts yet?", "Yes. We accept See It requests across the U.S. and look for a Scout around each funded mission. Coverage is still growing, so a completion target is not a guarantee. Your checkout states the assignment cutoff and full-refund policy."],
        ["What if the Scout can’t access something?", "Arrange any required access before ordering. Scouts only enter permitted, safe areas. They record access limitations or unavailable evidence for review, and your report makes those limits clear."],
        ["What exactly will I receive?", "The photos and videos specified in your check, written answers, and a downloadable PDF with labeled photos, observations, visit details, and links to video in your account. Any missing evidence is identified."],
        ["Can a Scout tell me whether a car or property is a good purchase?", "Scouts capture what they can observe. They do not diagnose mechanical problems, evaluate structural safety, determine value, or guarantee a seller or item. Use the evidence alongside any professional advice you need."],
      ].map(([q, a]) => <details key={q}><summary>{q}</summary><p>{a}</p></details>)}</div></section>
      <section className="see-other see-shell"><span>More ways to use a Scout</span><Link href="/request?type=move-it">Move It · local pickup & delivery <IconArrowRight size={17} aria-hidden="true" /></Link><Link href="/request?type=meet-it">Meet It · be there for an appointment <IconArrowRight size={17} aria-hidden="true" /></Link><small>Available where Scout coverage permits.</small></section>
      <SeeFooter />
    </main>
  );
}
