import Link from "next/link";
import { IconArrowRight, IconCircleCheck, IconCircleDashed, IconLifebuoy } from "@tabler/icons-react";
import type { ScoutOnboardingProgress } from "@/lib/scout-onboarding-progress";
import { SCOUT_SUPPORT_EMAIL } from "@/lib/scout-onboarding-progress";

export function ScoutOnboardingProgressTracker({ progress }: { progress: ScoutOnboardingProgress }) {
  if (progress.ready || !progress.nextStep) return null;

  return <section className="scout-onboarding-progress" aria-labelledby="scout-onboarding-progress-title">
    <div className="scout-onboarding-progress-heading">
      <div>
        <span className="kicker">Finish setup to claim missions</span>
        <h2 id="scout-onboarding-progress-title">Your Scout onboarding</h2>
        <p>{progress.completedCount} of {progress.totalCount} requirements complete. You can browse available missions while you finish.</p>
      </div>
      <strong aria-label={`${progress.percentComplete}% complete`}>{progress.percentComplete}%</strong>
    </div>
    <div
      aria-hidden="true"
      className="scout-onboarding-progress-bar"
      style={{ "--onboarding-progress": `${progress.percentComplete}%` } as React.CSSProperties}
    ><span /></div>
    <ul>
      {progress.steps.map((step) => <li className={step.complete ? "complete" : "missing"} key={step.key}>
        {step.complete ? <IconCircleCheck aria-hidden="true" size={20} /> : <IconCircleDashed aria-hidden="true" size={20} />}
        <span><span className="sr-only">{step.complete ? "Completed: " : "Still needed: "}</span>{step.label}</span>
      </li>)}
    </ul>
    <div className="scout-onboarding-progress-actions">
      <Link className="button" href={progress.nextStep.href}>{progress.nextStep.actionLabel} <IconArrowRight aria-hidden="true" size={18} /></Link>
      <a href={`mailto:${SCOUT_SUPPORT_EMAIL}`}><IconLifebuoy aria-hidden="true" size={18} /> Need help? Email {SCOUT_SUPPORT_EMAIL}</a>
    </div>
  </section>;
}
