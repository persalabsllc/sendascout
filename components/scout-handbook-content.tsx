import {
  IconAlertTriangle,
  IconBook2,
  IconCheck,
  IconMessageCircle,
  IconPackage,
  IconShieldCheck,
  IconUsers,
} from "@tabler/icons-react";
import {
  SCOUT_HANDBOOK_EFFECTIVE_DATE,
  SCOUT_HANDBOOK_EFFECTIVE_DATE_ISO,
  SCOUT_HANDBOOK_PRINCIPLES,
  SCOUT_HANDBOOK_SECTIONS,
  SCOUT_HANDBOOK_VERSION,
} from "@/lib/scout-handbook";

const principleIcons = [
  IconUsers,
  IconShieldCheck,
  IconPackage,
  IconCheck,
  IconAlertTriangle,
] as const;

export function ScoutHandbookContent({
  variant = "page",
}: {
  variant?: "page" | "reader";
} = {}) {
  return (
    <article className={`handbook-document handbook-document-${variant}`} aria-label="Send a Scout Handbook">
      <header className="handbook-document-header">
        <span className="handbook-document-mark" aria-hidden="true"><IconBook2 size={28} /></span>
        <div>
          <span className="kicker">Scout Handbook</span>
          <h2>The standard for every mission.</h2>
          <p>Simple, practical guidance for protecting customers, their property, and yourself.</p>
        </div>
        <p className="handbook-document-meta">
          <strong>Current version</strong>
          <span>{SCOUT_HANDBOOK_VERSION}</span>
          <time dateTime={SCOUT_HANDBOOK_EFFECTIVE_DATE_ISO}>Effective {SCOUT_HANDBOOK_EFFECTIVE_DATE}</time>
        </p>
      </header>

      <section className="handbook-principles" aria-labelledby="handbook-principles-title">
        <div className="handbook-principles-heading">
          <span>Five promises</span>
          <h3 id="handbook-principles-title">The Scout standard at a glance</h3>
        </div>
        <div className="handbook-principles-grid">
          {SCOUT_HANDBOOK_PRINCIPLES.map((principle, index) => {
            const PrincipleIcon = principleIcons[index] ?? IconCheck;
            return (
              <article key={principle.title}>
                <span aria-hidden="true"><PrincipleIcon size={19} /></span>
                <strong>{principle.title}</strong>
                <p>{principle.text}</p>
              </article>
            );
          })}
        </div>
      </section>

      <div className="handbook-section-list">
        {SCOUT_HANDBOOK_SECTIONS.map((section, index) => {
          const headingId = `handbook-${section.id}-title`;
          return (
            <section className="handbook-section" id={`handbook-${section.id}`} aria-labelledby={headingId} key={section.id}>
              <header>
                <span className="handbook-section-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <h3 id={headingId}>{section.title}</h3>
              </header>
              {section.paragraphs?.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
              {section.bullets && (
                <ul>{section.bullets.map((item) => <li key={item}>{item}</li>)}</ul>
              )}
              {section.steps && (
                <ol className="handbook-steps">{section.steps.map((item) => <li key={item}>{item}</li>)}</ol>
              )}
              {section.callout && (
                <aside className={`handbook-callout handbook-callout-${section.callout.tone}`} role="note">
                  {section.callout.tone === "safety" ? <IconAlertTriangle size={21} /> : <IconShieldCheck size={21} />}
                  <div>
                    <strong>{section.callout.title}</strong>
                    <p>{section.callout.body}</p>
                  </div>
                </aside>
              )}
            </section>
          );
        })}
      </div>

      <footer className="handbook-document-footer">
        <IconMessageCircle size={24} aria-hidden="true" />
        <div>
          <strong>When in doubt, pause and ask.</strong>
          <p>Contact <a href="mailto:support@sendascout.com">support@sendascout.com</a> when a mission is unclear, unsafe, materially different, or involves a prohibited request. Call 911 first for an emergency.</p>
        </div>
      </footer>
    </article>
  );
}
