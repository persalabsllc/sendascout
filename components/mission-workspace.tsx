"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { upload } from "@vercel/blob/client";
import {
  IconAlertTriangle, IconArrowLeft, IconCheck, IconClock, IconFileUpload, IconMapPin, IconMessageCircle,
  IconNavigation, IconPhoto, IconRoute, IconSend, IconShieldCheck,
} from "@tabler/icons-react";
import {
  approveMeetExtension, claimMission, confirmMissionComplete, requestMissionChangeOrder,
  respondMissionChangeOrder, sendMissionMessage, setLocationSharing, submitMissionResults,
  setPreferredScoutFromMission, updateMissionLocation, updateMissionStatus, verifyMissionDeliveryPin,
} from "@/app/actions/missions";
import { openMissionCase } from "@/app/actions/operations";
import type { MissionCaseKind } from "@/lib/mission-operations";
import { meetActionOpensAt } from "@/lib/mission-timing";
import { formatDateTime } from "@/lib/time";

type Status = "draft" | "open" | "claimed" | "en_route" | "onsite" | "en_route_pickup" | "at_pickup" | "en_route_dropoff" | "at_dropoff" | "submitted" | "completed" | "cancelled" | "disputed";
type MissionView = {
  id: string;
  type: "see" | "move" | "meet";
  status: Status;
  title: string;
  instructions: string;
  pickup: string;
  pickupInstructions?: string | null;
  dropoff?: string | null;
  deliveryInstructions?: string | null;
  scheduledFor?: string | null;
  timeZone: string;
  customerPriceCents: number;
  scoutPayoutCents: number;
  claimCustomerPriceCents: number;
  claimScoutPayoutCents: number;
  largeItem: boolean;
  routeDistanceMeters?: number | null;
  routeDurationSeconds?: number | null;
  routeSource: string;
  meetAuthorizedMinutes: number;
  maximumCustomerPriceCents?: number | null;
  maximumScoutPayoutCents?: number | null;
  billableStartedAt?: string | null;
  billableEndedAt?: string | null;
  billableMinutes?: number | null;
  chargedMinutes?: number | null;
  verifiedCheckInAt?: string | null;
  verifiedCheckOutAt?: string | null;
  locationSharingActive: boolean;
  latitude?: number | null;
  longitude?: number | null;
  locationUpdatedAt?: string | null;
  directionsUrl?: string | null;
  customerName: string;
  scoutName?: string | null;
  scoutHeadshotUrl?: string | null;
  scoutCompletedMissions: number;
  scoutRating?: number | null;
  scoutRatingCount: number;
  scoutIdentityVerified: boolean;
  proofOfDeliveryRequired: boolean;
  deliveryPinRequired: boolean;
  deliveryPinVerified: boolean;
  isActiveBundleLeg: boolean;
  isFinalBundleLeg: boolean;
  bookingCompleted: boolean;
};
type MessageView = { id: string; body: string; sender: string; mine: boolean; createdAt: string };
type ResultView = { summary: string | null; mediaUrls: string[]; submittedAt: string | null };
type EvidenceView = { mediaUrls: string[]; submittedAt: string | null };
type ReviewView = { rating: number; review: string | null; tipCents: number } | null;
type BundleView = { id: string; title: string; status: string; activeSequence: number; totalLegs: number; listCustomerPriceCents: number; bundleDiscountCents: number; customerPriceCents: number; scoutPayoutCents: number } | null;
type ItineraryLegView = { id: string; sequence: number; type: MissionView["type"]; status: Status; title: string; pickup: string; dropoff: string | null; active: boolean; current: boolean };
type ChecklistView = { id: string; sequence: number; prompt: string; responseType: string; required: boolean; responseText: string | null; mediaUrls: string[] };
type ChangeOrderView = { id: string; status: string; description: string; customerDeltaCents: number; scoutDeltaCents: number; proposedByMe: boolean; awaitingPayment: boolean; expiresAt: string | null };

export function MissionWorkspace({ role, mission, bundle, itinerary, messages, results, deliveryProof, checklist, changeOrders, review, canClaim, scoutPreferred }: { role: "customer" | "scout" | "admin"; mission: MissionView; bundle: BundleView; itinerary: ItineraryLegView[]; messages: MessageView[]; results: ResultView; deliveryProof: EvidenceView; checklist: ChecklistView[]; changeOrders: ChangeOrderView[]; review: ReviewView; canClaim: boolean; scoutPreferred: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resultSummary, setResultSummary] = useState("");
  const [resultFiles, setResultFiles] = useState<File[]>([]);
  const [deliveryProofFile, setDeliveryProofFile] = useState<File | null>(null);
  const [deliveryPin, setDeliveryPin] = useState("");
  const [checklistAnswers, setChecklistAnswers] = useState<Record<string, { text: string; files: File[] }>>(() => Object.fromEntries(checklist.map((item) => [item.id, { text: item.responseText ?? "", files: [] }])));
  const [changeOrderDescription, setChangeOrderDescription] = useState("");
  const [changeOrderOpen, setChangeOrderOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const [reviewText, setReviewText] = useState("");
  const [tipCents, setTipCents] = useState(0);
  const [tracking, setTracking] = useState(mission.locationSharingActive);
  const [clock, setClock] = useState<number | null>(null);
  const [scheduleClock, setScheduleClock] = useState<number | null>(null);
  const [changeOrderClock, setChangeOrderClock] = useState<number | null>(null);
  const lastLocationSent = useRef(0);
  const assigned = Boolean(mission.scoutName);

  useEffect(() => {
    if (!assigned) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") router.refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, 10000);
    return () => window.clearInterval(timer);
  }, [assigned, router]);

  useEffect(() => {
    if (role !== "scout" || !tracking || !navigator.geolocation) return;
    const watcher = navigator.geolocation.watchPosition((position) => {
      const now = Date.now();
      if (now - lastLocationSent.current < 20000) return;
      lastLocationSent.current = now;
      void updateMissionLocation(mission.id, position.coords.latitude, position.coords.longitude, position.coords.accuracy);
    }, () => setError("Your browser could not share location. Check location permission for Send a Scout."), {
      enableHighAccuracy: true,
      maximumAge: 15000,
      timeout: 15000,
    });
    return () => navigator.geolocation.clearWatch(watcher);
  }, [mission.id, role, tracking]);

  useEffect(() => {
    if (!mission.billableStartedAt || mission.billableEndedAt) return;
    const tick = () => setClock(Date.now());
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [mission.billableEndedAt, mission.billableStartedAt]);

  useEffect(() => {
    if (role !== "scout" || mission.type !== "meet" || !mission.scheduledFor) return;
    const tick = () => setScheduleClock(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [mission.scheduledFor, mission.type, role]);

  useEffect(() => {
    if (!changeOrders.some((order) => order.status === "pending" && order.expiresAt)) return;
    const tick = () => setChangeOrderClock(Date.now());
    tick();
    const timer = window.setInterval(tick, 30_000);
    return () => window.clearInterval(timer);
  }, [changeOrders]);

  function run(action: () => Promise<{ ok: true } | { ok: false; error: string }>) {
    setError("");
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error);
      else router.refresh();
    });
  }

  function toggleTracking() {
    if (!tracking) {
      if (!navigator.geolocation) return setError("Location sharing is not supported by this browser.");
      navigator.geolocation.getCurrentPosition((position) => {
        run(async () => {
          const enabled = await setLocationSharing(mission.id, true);
          if (!enabled.ok) return enabled;
          await updateMissionLocation(mission.id, position.coords.latitude, position.coords.longitude, position.coords.accuracy);
          setTracking(true);
          return { ok: true };
        });
      }, () => setError("Allow location access in your browser to start live tracking."), { enableHighAccuracy: true, timeout: 15000 });
      return;
    }
    run(async () => {
      const result = await setLocationSharing(mission.id, false);
      if (result.ok) setTracking(false);
      return result;
    });
  }

  function submitMessage() {
    if (!message.trim()) return;
    const body = message;
    run(async () => {
      const result = await sendMissionMessage(mission.id, body);
      if (result.ok) setMessage("");
      return result;
    });
  }

  function submitResults() {
    setError("");
    startTransition(async () => {
      try {
        if (mission.proofOfDeliveryRequired && !deliveryProofFile) {
          setError("Take or choose a delivery photo before submitting this mission.");
          return;
        }
        if (!resultSummary.trim() && resultFiles.length === 0 && !deliveryProofFile && checklist.length === 0) {
          setError("Add a written result, photo, video, or checklist response before submitting.");
          return;
        }
        async function uploadResultFile(file: File) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
          const blob = await upload(`mission-results/${mission.id}/${crypto.randomUUID()}-${safeName}`, file, {
            access: "private",
            handleUploadUrl: "/api/mission-results/upload",
            clientPayload: JSON.stringify({ missionId: mission.id }),
            multipart: file.size > 5 * 1024 * 1024,
          });
          return blob.pathname;
        }
        const mediaUrls = await Promise.all(resultFiles.map(uploadResultFile));
        const deliveryProofUrls = deliveryProofFile ? [await uploadResultFile(deliveryProofFile)] : [];
        const structuredResponses = [];
        for (const item of checklist) {
          const answer = checklistAnswers[item.id] ?? { text: "", files: [] };
          const uploadedFiles = await Promise.all(answer.files.map(uploadResultFile));
          structuredResponses.push({ itemId: item.id, responseText: answer.text, mediaUrls: uploadedFiles });
        }
        const result = await submitMissionResults(mission.id, resultSummary, mediaUrls, deliveryProofUrls, structuredResponses);
        if (!result.ok) setError(result.error);
        else router.refresh();
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "The result files could not be uploaded.");
      }
    });
  }

  const next = nextStatus(mission.type, mission.status);
  const actionAvailability = meetActionAvailability(mission, next, scheduleClock);
  const effectiveChangeOrders = changeOrders.map((order) => ({
    ...order,
    effectiveStatus: order.awaitingPayment
      ? "payment_pending"
      : order.status === "pending" && order.expiresAt && changeOrderClock !== null && Date.parse(order.expiresAt) <= changeOrderClock ? "expired" : order.status,
  }));
  const scoutLocationMapUrl = mission.latitude != null && mission.longitude != null ? approximateMapUrl(mission.latitude, mission.longitude) : null;
  const missionMapUrl = `/api/mission-map?missionId=${encodeURIComponent(mission.id)}`;
  return (
    <main className="mission-page">
      <div className="mission-shell">
        <Link className="mission-back" href={role === "scout" ? "/dashboard/scout" : role === "admin" ? "/control-room" : "/dashboard/customer"}><IconArrowLeft size={18} /> Back to dashboard</Link>
        <header className="mission-hero">
          <div><span className="kicker">{missionLabel(mission.type)}</span><h1>{mission.title}</h1><p><IconMapPin size={17} /> {mission.pickup}</p></div>
          <div className="mission-state"><small>Current status</small><strong>{statusLabel(mission.type, mission.status)}</strong></div>
        </header>

        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="mission-work-grid">
          <section className="mission-column">
            {bundle && <BundleItineraryPanel bundle={bundle} itinerary={itinerary} role={role} />}
            {bundle && !mission.isActiveBundleLeg && <article className="mission-panel case-pending-panel"><IconClock size={25} /><div><h2>This part is not active</h2><p>Only part {bundle.activeSequence} can be updated right now. Open the highlighted itinerary part to continue.</p><Link className="button button-small" href={`/dashboard/missions/${itinerary.find((leg) => leg.active)?.id ?? mission.id}`}>Open active part</Link></div></article>}
            <article className="mission-panel route-panel">
              <div className="panel-heading"><IconRoute size={22} /><div><h2>Mission route</h2><p>{mission.type === "move" ? "Pickup and delivery details" : "Where your Scout is going"}</p></div></div>
              <LocationStop number="1" label={mission.type === "move" ? "Pickup" : "Mission location"} location={mission.pickup} instructions={mission.pickupInstructions} />
              {mission.dropoff && <LocationStop number="2" label="Drop-off" location={mission.dropoff} instructions={mission.deliveryInstructions} />}
              {mission.type === "move" && <div className="mission-instructions"><strong>Vehicle requirement</strong><p>{mission.largeItem ? "Larger item — SUV, van or pickup truck requested" : "Small item — fits in a car or trunk"}</p></div>}
              {mission.type === "move" && <div className="mission-instructions"><strong>{mission.routeSource === "google" ? "Locked driving route" : "Route verification"}</strong><p>{mission.routeDistanceMeters ? `${routeMiles(mission.routeDistanceMeters)} road miles · approximately ${routeDuration(mission.routeDurationSeconds)}` : "Exact road mileage will be locked before this mission is released to Scouts."}</p></div>}
              <div className="mission-instructions"><strong>Mission instructions</strong><p>{mission.instructions}</p></div>
              {mission.scheduledFor && <p className="mission-time"><IconClock size={17} /> Scheduled for {formatDateTime(mission.scheduledFor, mission.timeZone)}</p>}
            </article>

            {canClaim && <article className="mission-panel claim-panel"><IconShieldCheck size={28} /><div><h2>Ready to take this mission?</h2><p>{bundle ? `One Scout completes all ${bundle.totalLegs} ordered parts. The complete itinerary pays ${money(mission.claimScoutPayoutCents)}.` : mission.type === "meet" && mission.maximumScoutPayoutCents && mission.maximumScoutPayoutCents > mission.scoutPayoutCents ? `${money(mission.scoutPayoutCents)} guaranteed first hour · up to ${money(mission.maximumScoutPayoutCents)} currently authorized` : "You’ll receive the full address and private customer chat after claiming."}</p></div><button className="button" disabled={pending} onClick={() => run(() => claimMission(mission.id))}>Claim for {money(mission.claimScoutPayoutCents)}</button></article>}

            {mission.type === "meet" && assigned && mission.isActiveBundleLeg && <MeetTimerPanel role={role} mission={mission} clock={clock} pending={pending} extend={() => run(() => approveMeetExtension(mission.id))} />}

            {role === "scout" && assigned && mission.isActiveBundleLeg && !["submitted", "completed", "cancelled", "disputed"].includes(mission.status) && <article className="mission-panel action-panel">
              <div><h2>Scout controls</h2><p>Update the customer as you move through the mission.</p></div>
              {next && <button className="button" disabled={pending || !actionAvailability.available} onClick={() => run(() => updateMissionStatus(mission.id, next.status))}>{actionAvailability.label ?? next.label}</button>}
              {actionAvailability.note && <small>{actionAvailability.note}</small>}
              <button className={`tracking-button ${tracking ? "tracking-on" : ""}`} disabled={pending} onClick={toggleTracking}><IconNavigation size={18} /> {tracking ? "Stop location sharing" : "Start live location sharing"}</button>
              <small>Location is shared only during this active mission and is removed when sharing stops.</small>
            </article>}

            {role === "scout" && assigned && mission.isActiveBundleLeg && mission.type === "move" && mission.status === "at_dropoff" && mission.deliveryPinRequired && <article className="mission-panel action-panel">
              <div className="panel-heading"><IconShieldCheck size={22} /><div><h2>Recipient delivery PIN</h2><p>{mission.deliveryPinVerified ? "Recipient PIN verified. You can submit delivery proof." : "Ask the recipient for their six-digit PIN, then enter it here. The PIN is never shown to Scouts."}</p></div></div>
              {!mission.deliveryPinVerified && <label className="field"><span>Six-digit PIN</span><input type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={6} value={deliveryPin} onChange={(event) => setDeliveryPin(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" /></label>}
              {!mission.deliveryPinVerified && <button className="button" disabled={pending || deliveryPin.length !== 6} onClick={() => run(() => verifyMissionDeliveryPin(mission.id, deliveryPin))}>Verify recipient PIN</button>}
              {mission.deliveryPinVerified && <span className="identity-verified"><IconCheck size={16} /> Verified at drop-off</span>}
              <small>Do not ask the customer to send the code in mission chat. The person receiving the item should provide it at handoff.</small>
            </article>}

            {assigned && mission.isActiveBundleLeg && (role === "customer" || role === "scout") && !["submitted", "completed", "cancelled", "disputed", "draft", "open"].includes(mission.status) && <article className="mission-panel mission-case-panel">
              <div className="panel-heading"><IconFileUpload size={22} /><div><h2>Additional task</h2><p>Both participants must approve the exact price before any extra work begins.</p></div></div>
              {effectiveChangeOrders.map((order) => <div className="mission-instructions" key={order.id}><strong>{order.effectiveStatus === "pending" ? "Awaiting approval" : order.effectiveStatus === "payment_pending" ? "Awaiting customer payment" : titleCase(order.effectiveStatus)}</strong><p>{order.description}</p><small>Customer: +{money(order.customerDeltaCents)} · Scout payout: +{money(order.scoutDeltaCents)}</small>{order.effectiveStatus === "pending" && order.expiresAt && <small>Approval expires {new Date(order.expiresAt).toLocaleString()}.</small>}{order.effectiveStatus === "expired" && <small>This price request expired without authorization. No extra work should be performed.</small>}{order.effectiveStatus === "payment_pending" && <small>Both participants accepted. Extra work remains unauthorized until Stripe confirms payment.</small>}{order.effectiveStatus === "payment_pending" && role === "customer" && <Link className="button button-small" href="/dashboard/customer/payments">Confirm payment</Link>}{order.effectiveStatus === "pending" && !order.proposedByMe && <div className="mission-case-actions"><button className="button button-ghost" disabled={pending} onClick={() => run(() => respondMissionChangeOrder(mission.id, order.id, false))}>Decline</button><button className="button" disabled={pending} onClick={() => run(() => respondMissionChangeOrder(mission.id, order.id, true))}>{role === "customer" ? `Approve ${money(order.customerDeltaCents)} charge` : `Accept ${money(order.scoutDeltaCents)} payout`}</button></div>}{order.effectiveStatus === "pending" && order.proposedByMe && <small>The other participant must accept before work is authorized.</small>}</div>)}
              {!effectiveChangeOrders.some((order) => ["pending", "payment_pending"].includes(order.effectiveStatus)) && (!changeOrderOpen ? <button className="button button-ghost" onClick={() => setChangeOrderOpen(true)}>Request an additional task</button> : <><label><span>Describe the added work</span><textarea rows={3} minLength={10} maxLength={1000} value={changeOrderDescription} onChange={(event) => setChangeOrderDescription(event.target.value)} placeholder="Describe exactly what should be added to this mission." /></label><p>Exact added price: customer +{money(900)} · Scout payout +{money(600)}</p><div className="mission-case-actions"><button className="button button-ghost" disabled={pending} onClick={() => setChangeOrderOpen(false)}>Cancel</button><button className="button" disabled={pending || changeOrderDescription.trim().length < 10} onClick={() => run(async () => { const result = await requestMissionChangeOrder(mission.id, changeOrderDescription); if (result.ok) { setChangeOrderDescription(""); setChangeOrderOpen(false); } return result; })}>Send for approval</button></div></>)}
            </article>}

            {role === "customer" && mission.isActiveBundleLeg && !["cancelled"].includes(mission.status) && <MissionCasePanel role="customer" status={mission.status} pending={pending} submit={(kind, summary) => run(() => openMissionCase(mission.id, kind, summary))} />}
            {role === "scout" && assigned && mission.isActiveBundleLeg && !["submitted", "completed", "cancelled", "disputed"].includes(mission.status) && <MissionCasePanel role="scout" status={mission.status} pending={pending} submit={(kind, summary) => run(() => openMissionCase(mission.id, kind, summary))} />}
            {mission.status === "disputed" && <article className="mission-panel case-pending-panel"><IconAlertTriangle size={25} /><div><h2>Mission paused for Control Room review</h2><p>Status changes, verified time and payout release are paused while the mission record is reviewed. Updates will appear here and by email.</p></div></article>}

            {role === "scout" && assigned && mission.isActiveBundleLeg && readyForResults(mission) && <article className="mission-panel result-form-panel">
              <div className="panel-heading"><IconFileUpload size={22} /><div><h2>{mission.type === "see" ? "Submit what you found" : mission.type === "move" ? "Submit delivery proof" : "Submit appointment results"}</h2><p>These notes and files go directly to the paying customer.</p></div></div>
              {checklist.length > 0 && <fieldset><legend>Required mission report</legend>{checklist.map((item) => {
                const answer = checklistAnswers[item.id] ?? { text: "", files: [] };
                if (item.responseType === "check") return <label className="field" key={item.id}><span>{item.sequence}. {item.prompt}{item.required ? " *" : ""}</span><select value={answer.text} onChange={(event) => setChecklistAnswers((current) => ({ ...current, [item.id]: { ...answer, text: event.target.value } }))}><option value="">Choose an answer</option><option value="yes">Yes — completed</option><option value="no">No</option></select></label>;
                if (item.responseType === "photo" || item.responseType === "video") return <label className="result-upload" key={item.id}><IconPhoto size={23} /><span><strong>{item.sequence}. {item.prompt}{item.required ? " *" : ""}</strong><small>{item.responseType === "photo" ? "Add at least one JPG, PNG, or WEBP photo" : "Add at least one video"}</small></span><input className="result-upload-input" aria-label={`${item.prompt} ${item.responseType} evidence`} type="file" accept={item.responseType === "photo" ? "image/jpeg,image/png,image/webp" : "video/mp4,video/quicktime,video/webm"} capture={item.responseType === "photo" ? "environment" : undefined} multiple onChange={(event) => setChecklistAnswers((current) => ({ ...current, [item.id]: { ...answer, files: Array.from(event.target.files ?? []).slice(0, 4) } }))} /></label>;
                return <label className="field" key={item.id}><span>{item.sequence}. {item.prompt}{item.required ? " *" : ""}</span><input type={item.responseType === "number" ? "number" : "text"} value={answer.text} onChange={(event) => setChecklistAnswers((current) => ({ ...current, [item.id]: { ...answer, text: event.target.value } }))} /></label>;
              })}</fieldset>}
              <label className="result-notes"><span>Result notes</span><textarea rows={6} maxLength={5000} placeholder={mission.type === "see" ? "Describe the condition, answer the customer’s questions, and call out anything important…" : "Describe what happened and any details the customer should know…"} value={resultSummary} onChange={(event) => setResultSummary(event.target.value)} /></label>
              {mission.proofOfDeliveryRequired && <label className="result-upload"><IconPhoto size={23} /><span><strong>Proof of delivery photo *</strong><small>Take or choose a clear JPG, PNG, or WEBP photo of the delivered item. The customer can view it securely.</small></span><input className="result-upload-input" aria-label="Proof of delivery photo" type="file" accept="image/jpeg,image/png,image/webp" capture="environment" required onChange={(event) => setDeliveryProofFile(event.target.files?.[0] ?? null)} /></label>}
              {deliveryProofFile && <div className="selected-files"><span>{deliveryProofFile.name}<small>{formatBytes(deliveryProofFile.size)}</small></span></div>}
              <label className="result-upload"><IconPhoto size={23} /><span><strong>Add photos or video <em>(optional)</em></strong><small>Include evidence when useful · up to 12 JPG, PNG, WEBP, MP4, MOV, or WEBM files</small></span><input className="result-upload-input" aria-label="Optional mission photos or video" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => setResultFiles(Array.from(event.target.files ?? []).slice(0, 12))} /></label>
              {resultFiles.length > 0 && <div className="selected-files">{resultFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}<small>{formatBytes(file.size)}</small></span>)}</div>}
              <button className="button" disabled={pending || (mission.deliveryPinRequired && !mission.deliveryPinVerified)} onClick={submitResults}>{pending ? "Uploading and submitting…" : mission.isFinalBundleLeg ? "Submit results to customer" : "Complete this part and start the next"}</button>
              {mission.deliveryPinRequired && !mission.deliveryPinVerified && <small>Verify the recipient PIN before submitting.</small>}
            </article>}

            {(results.summary || results.mediaUrls.length > 0) && <ResultPanel results={results} />}
            {deliveryProof.mediaUrls.length > 0 && <DeliveryProofPanel evidence={deliveryProof} />}
            {checklist.some((item) => item.responseText || item.mediaUrls.length) && !readyForResults(mission) && <ChecklistReportPanel checklist={checklist} />}

            {role === "customer" && mission.status === "submitted" && mission.isFinalBundleLeg && <article className="mission-panel completion-panel review-panel"><IconCheck size={28} /><div><h2>Confirm and rate your Scout</h2><p>Review the result, rate the service and optionally leave a tip.</p><div className="star-picker" aria-label="Scout rating">{[1, 2, 3, 4, 5].map((star) => <button type="button" aria-label={`${star} star${star === 1 ? "" : "s"}`} aria-pressed={rating === star} className={rating >= star ? "selected" : ""} key={star} onClick={() => setRating(star)}>★</button>)}</div><textarea aria-label="Optional Scout review" maxLength={1500} rows={3} placeholder="Optional note about your experience" value={reviewText} onChange={(event) => setReviewText(event.target.value)} /><div className="tip-picker"><span>Optional tip</span>{[0, 300, 500, 1000].map((amount) => <button type="button" aria-pressed={tipCents === amount} className={tipCents === amount ? "selected" : ""} key={amount} onClick={() => setTipCents(amount)}>{amount ? money(amount) : "No tip"}</button>)}</div><small>Tips are recorded during testing and will be charged only after secure payments are activated.</small></div><button className="button" disabled={pending || rating === 0} onClick={() => run(() => confirmMissionComplete(mission.id, rating, reviewText, tipCents))}>Confirm completion</button></article>}
            {review && <article className="mission-panel customer-review-panel"><div><span className="review-stars">{"★".repeat(review.rating)}{"☆".repeat(5 - review.rating)}</span><h2>Customer rating</h2>{review.review && <p>{review.review}</p>}{review.tipCents > 0 && <small>{money(review.tipCents)} tip selected</small>}</div></article>}
            {role === "customer" && mission.bookingCompleted && <article className="mission-panel claim-panel"><IconRoute size={28} /><div><h2>Need this again?</h2><p>Reuse the locations and instructions, review the latest price, and optionally offer it to {mission.scoutName ?? "your Scout"} first.</p></div><div className="mission-case-actions"><Link className="button" href={`/request?repeat=${itinerary[0]?.id ?? mission.id}`}>Book again</Link>{mission.scoutName && <button className="button button-ghost" disabled={pending} onClick={() => run(() => setPreferredScoutFromMission(mission.id, !scoutPreferred))}>{scoutPreferred ? "Remove preferred Scout" : `Prefer ${mission.scoutName}`}</button>}</div></article>}
          </section>

          <aside className="mission-column">
            {role === "customer" && assigned && <ScoutIdentityCard mission={mission} />}
            {role === "scout" ? <article className="mission-panel tracking-panel mission-map-panel">
              <div className="panel-heading"><IconRoute size={22} /><div><h2>{mission.type === "move" ? "Pickup-to-drop-off map" : mission.type === "meet" ? "Meeting location map" : "Inspection location map"}</h2><p>{mission.type === "move" ? "Plan the verified driving route" : "See where the mission takes place"}</p></div></div>
              <Image className="mission-map-image" src={missionMapUrl} alt={mission.type === "move" ? "Pickup-to-drop-off driving route" : "Mission location"} width={900} height={480} sizes="(max-width: 760px) 100vw, 42vw" unoptimized />
              <div className="map-footer"><small>{canClaim ? "Planning view · the exact address unlocks after claiming" : mission.type === "move" ? "Pickup and drop-off route" : "Mission location"}</small>{mission.directionsUrl && <a href={mission.directionsUrl} target="_blank" rel="noreferrer">Open in Google Maps <IconNavigation size={15} /></a>}</div>
            </article> : <article className="mission-panel tracking-panel">
              <div className="panel-heading"><IconNavigation size={22} /><div><h2>Scout location</h2><p>{trackingCopy(mission)}</p></div></div>
              {mission.locationSharingActive && scoutLocationMapUrl ? <>
                <iframe title="Approximate Scout location" src={scoutLocationMapUrl} loading="lazy" />
                <small>Approximate location · refreshed every 10 seconds · {mission.locationUpdatedAt ? `last update ${new Date(mission.locationUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "waiting for first update"}</small>
              </> : <div className="tracking-empty"><IconMapPin size={28} /><strong>Location is not currently being shared</strong><p>Status updates will still appear here.</p></div>}
            </article>}

            <article className="mission-panel chat-panel">
              <div className="panel-heading"><IconMessageCircle size={22} /><div><h2>Mission chat</h2><p>Private communication inside Send a Scout</p></div></div>
              {!assigned ? <div className="chat-empty">Chat opens when a Scout accepts the mission.</div> : <>
                <div className="message-list">{messages.length ? messages.map((item) => <div className={`message ${item.mine ? "mine" : ""}`} key={item.id}><small>{item.sender}</small><p>{item.body}</p><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</time></div>) : <div className="chat-empty">No messages yet. Keep all mission communication here so phone numbers remain private.</div>}</div>
                <div className="message-compose"><textarea aria-label="Mission message" maxLength={1500} rows={3} placeholder="Write a private message…" value={message} onChange={(event) => setMessage(event.target.value)} /><button aria-label="Send message" disabled={pending || !message.trim()} onClick={submitMessage}><IconSend size={19} /></button></div>
              </>}
            </article>
          </aside>
        </div>
      </div>
    </main>
  );
}

function MissionCasePanel({ role, status, pending, submit }: { role: "customer" | "scout"; status: Status; pending: boolean; submit: (kind: MissionCaseKind, summary: string) => void }) {
  const options: { value: MissionCaseKind; label: string }[] = role === "customer"
    ? [
        ...(!["completed"].includes(status) ? [{ value: "customer_cancellation" as const, label: "Cancel this mission" }] : []),
        { value: "customer_problem", label: "Report a service problem" },
      ]
    : [
        { value: "scout_customer_no_show", label: "Report customer no-show" },
        { value: "scout_safety_concern", label: "Report safety concern" },
      ];
  const [kind, setKind] = useState<MissionCaseKind>(options[0].value);
  const [summary, setSummary] = useState("");
  const [open, setOpen] = useState(false);
  if (!open) return <button className="mission-support-trigger" type="button" onClick={() => setOpen(true)}><IconAlertTriangle size={17} /> {role === "customer" ? "Cancel or report a problem" : "Report no-show or safety issue"}</button>;
  return <article className="mission-panel mission-case-panel"><div className="panel-heading"><IconAlertTriangle size={22} /><div><h2>Mission support</h2><p>Submitting this creates a permanent Control Room case.</p></div></div><label><span>Request type</span><select value={kind} onChange={(event) => setKind(event.target.value as MissionCaseKind)}>{options.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select></label><label><span>What happened?</span><textarea rows={4} minLength={10} maxLength={2000} value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="Give Control Room the facts needed to review the mission record." /></label><div className="mission-case-actions"><button className="button button-ghost" type="button" onClick={() => setOpen(false)}>Keep mission open</button><button className="button" type="button" disabled={pending || summary.trim().length < 10} onClick={() => submit(kind, summary)}>{kind === "customer_cancellation" ? "Submit cancellation" : "Open support case"}</button></div><small>{kind === "customer_cancellation" && ["draft", "open", "claimed"].includes(status) ? "Because verified work has not started, this cancellation takes effect immediately." : "The mission will pause while Control Room reviews timestamps, messages, location events and evidence."}</small></article>;
}

function ScoutIdentityCard({ mission }: { mission: MissionView }) {
  return <article className="mission-panel scout-identity-card"><div className="scout-headshot">{mission.scoutHeadshotUrl ? <Image src={mission.scoutHeadshotUrl} alt={`${mission.scoutName} profile photo`} width={76} height={76} unoptimized /> : <span>{mission.scoutName?.slice(0, 1).toUpperCase()}</span>}</div><div><small>Your Scout</small><h2>{mission.scoutName}</h2>{mission.scoutIdentityVerified && <span className="identity-verified"><IconShieldCheck size={15} /> Identity verified</span>}<p>{mission.scoutCompletedMissions} completed mission{mission.scoutCompletedMissions === 1 ? "" : "s"}</p>{mission.scoutRating ? <span className="scout-rating">★ {mission.scoutRating.toFixed(1)} <small>({mission.scoutRatingCount})</small></span> : <span className="new-scout">New Scout · not yet rated</span>}</div></article>;
}

function LocationStop({ number, label, location, instructions }: { number: string; label: string; location: string; instructions?: string | null }) {
  return <div className="mission-stop"><span>{number}</span><div><small>{label}</small><strong>{location}</strong>{instructions && <p>{instructions}</p>}</div></div>;
}

function BundleItineraryPanel({ bundle, itinerary, role }: { bundle: NonNullable<BundleView>; itinerary: ItineraryLegView[]; role: "customer" | "scout" | "admin" }) {
  return <article className="mission-panel route-panel"><div className="panel-heading"><IconRoute size={22} /><div><h2>Mission itinerary</h2><p>{bundle.totalLegs} ordered parts · one assigned Scout</p></div></div><ol>{itinerary.map((leg) => <li key={leg.id}><Link href={`/dashboard/missions/${leg.id}`} aria-current={leg.current ? "page" : undefined}><strong>Part {leg.sequence}: {missionLabel(leg.type)}</strong><span>{leg.title}</span><small>{leg.pickup}{leg.dropoff ? ` → ${leg.dropoff}` : ""}</small><small>{leg.active ? "Active now" : statusLabel(leg.type, leg.status)}</small></Link></li>)}</ol><div className="mission-instructions"><strong>{role === "scout" ? `Complete itinerary payout: ${money(bundle.scoutPayoutCents)}` : `Complete itinerary total: ${money(bundle.customerPriceCents)}`}</strong>{bundle.bundleDiscountCents > 0 && <p>Includes a {money(bundle.bundleDiscountCents)} multi-mission discount. Scout pay is not reduced.</p>}</div></article>;
}

function DeliveryProofPanel({ evidence }: { evidence: EvidenceView }) {
  return <article className="mission-panel result-panel"><div className="panel-heading"><IconPhoto size={22} /><div><h2>Proof of delivery</h2><p>{evidence.submittedAt ? `Submitted ${new Date(evidence.submittedAt).toLocaleString()}` : "Submitted securely by the Scout"}</p></div></div><div className="result-gallery">{evidence.mediaUrls.map((url) => <a href={url} target="_blank" rel="noreferrer" key={url}><Image src={url} alt="Proof showing the delivered item at its approved destination" width={720} height={540} unoptimized /></a>)}</div><small>This evidence is private to the customer, assigned Scout and Send a Scout operations.</small></article>;
}

function ChecklistReportPanel({ checklist }: { checklist: ChecklistView[] }) {
  return <article className="mission-panel result-panel"><div className="panel-heading"><IconCheck size={22} /><div><h2>Structured mission report</h2><p>Customer-requested checklist</p></div></div><ol>{checklist.map((item) => <li key={item.id}><strong>{item.prompt}</strong>{item.responseText && <p>{item.responseText === "yes" ? "Completed" : item.responseText}</p>}{item.mediaUrls.length > 0 && <div className="result-gallery">{item.mediaUrls.map((url) => isVideo(url) ? <video controls preload="metadata" src={url} key={url} /> : <a href={url} target="_blank" rel="noreferrer" key={url}><Image src={url} alt={`Scout evidence for: ${item.prompt}`} width={720} height={540} unoptimized /></a>)}</div>}</li>)}</ol></article>;
}

function nextStatus(type: MissionView["type"], status: Status): { status: Status; label: string } | null {
  if (type === "move") {
    const steps: Partial<Record<Status, { status: Status; label: string }>> = {
      claimed: { status: "en_route_pickup", label: "Start trip to pickup" },
      en_route_pickup: { status: "at_pickup", label: "I’ve arrived at pickup" },
      at_pickup: { status: "en_route_dropoff", label: "Item picked up — start delivery" },
      en_route_dropoff: { status: "at_dropoff", label: "I’ve arrived at drop-off" },
    };
    return steps[status] ?? null;
  }
  const steps: Partial<Record<Status, { status: Status; label: string }>> = {
    claimed: { status: "en_route", label: "Start trip to location" },
    en_route: { status: "onsite", label: type === "meet" ? "Verify arrival and start timer" : "I’ve arrived at location" },
  };
  return steps[status] ?? null;
}

function MeetTimerPanel({ role, mission, clock, pending, extend }: { role: "customer" | "scout" | "admin"; mission: MissionView; clock: number | null; pending: boolean; extend: () => void }) {
  const startedAt = mission.billableStartedAt ? new Date(mission.billableStartedAt).getTime() : null;
  const endedAt = mission.billableEndedAt ? new Date(mission.billableEndedAt).getTime() : null;
  const effectiveNow = endedAt ?? clock;
  const elapsedSeconds = startedAt && effectiveNow ? Math.max(0, Math.min(mission.meetAuthorizedMinutes * 60, Math.floor((effectiveNow - startedAt) / 1000))) : 0;
  const cap = money(mission.maximumCustomerPriceCents ?? 2900);
  return <article className="mission-panel timer-panel">
    <div className="panel-heading"><IconClock size={22} /><div><h2>Verified appointment time</h2><p>Server-controlled billing with onsite GPS verification</p></div></div>
    <div className="timer-display"><small>{mission.billableEndedAt ? "Final verified time" : mission.billableStartedAt ? "Verified timer running" : "Timer has not started"}</small><strong>{formatElapsed(elapsedSeconds)}</strong><span>{mission.meetAuthorizedMinutes / 60} hour{mission.meetAuthorizedMinutes === 60 ? "" : "s"} authorized · {cap} maximum</span></div>
    {!mission.billableStartedAt && <p className="timer-note">Verified check-in opens five minutes before the appointment. The timer starts only after current GPS confirms the Scout is onsite and the Scout checks in; travel time does not count.</p>}
    {mission.billableStartedAt && !mission.billableEndedAt && <p className="timer-note">Only time backed by recent onsite location heartbeats counts. Earnings stop automatically at the authorized limit.</p>}
    {mission.billableEndedAt && <p className="timer-note">Customer charged for {mission.chargedMinutes ?? 60} minutes. Actual verified presence: {mission.billableMinutes ?? 0} minutes.</p>}
    {role === "customer" && mission.status === "onsite" && mission.meetAuthorizedMinutes < 480 && <button className="button button-small" disabled={pending} onClick={extend}>Authorize one additional hour</button>}
  </article>;
}

function ResultPanel({ results }: { results: ResultView }) {
  return <article className="mission-panel result-panel"><div className="panel-heading"><IconCheck size={22} /><div><h2>Mission results</h2><p>{results.submittedAt ? `Submitted ${new Date(results.submittedAt).toLocaleString()}` : "Submitted by the Scout"}</p></div></div>{results.summary && <p className="result-summary">{results.summary}</p>}{results.mediaUrls.length > 0 && <div className="result-gallery">{results.mediaUrls.map((url) => isVideo(url) ? <video controls preload="metadata" src={url} key={url} /> : <a href={url} target="_blank" rel="noreferrer" key={url}><Image src={url} alt="Scout mission result" width={720} height={540} unoptimized /></a>)}</div>}</article>;
}

function statusLabel(type: MissionView["type"], status: Status) {
  const common: Partial<Record<Status, string>> = { draft: "Awaiting review", open: "Available to Scouts", claimed: "Scout assigned", submitted: "Awaiting customer confirmation", completed: "Completed", cancelled: "Cancelled", disputed: "Under review" };
  if (type === "move") return ({ en_route_pickup: "En route to pickup", at_pickup: "At pickup", en_route_dropoff: "On the way to drop-off", at_dropoff: "At drop-off", ...common })[status] ?? status;
  return ({ en_route: "En route to location", onsite: type === "see" ? "At inspection location" : "At meeting location", ...common })[status] ?? status;
}

function missionLabel(type: MissionView["type"]) { return type === "see" ? "See It mission" : type === "move" ? "Move It mission" : "Meet It mission"; }
function titleCase(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(cents / 100); }
function trackingCopy(mission: MissionView) { return mission.locationSharingActive ? statusLabel(mission.type, mission.status) : mission.scoutName ? `${mission.scoutName} is assigned` : "Waiting for a Scout"; }
function approximateMapUrl(latitude: number, longitude: number) {
  const lat = Math.round(latitude * 1000) / 1000;
  const lng = Math.round(longitude * 1000) / 1000;
  const delta = 0.012;
  return `https://www.openstreetmap.org/export/embed.html?bbox=${lng - delta}%2C${lat - delta}%2C${lng + delta}%2C${lat + delta}&layer=mapnik&marker=${lat}%2C${lng}`;
}
function readyForResults(mission: MissionView) { return mission.type === "move" ? mission.status === "at_dropoff" : mission.status === "onsite"; }
function isVideo(url: string) { return /\.(mp4|mov|webm)(?:\?|$)/i.test(url); }
function formatBytes(bytes: number) { return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function routeMiles(meters: number) { return Math.max(1, Math.ceil(meters / 1609.344)); }
function routeDuration(seconds?: number | null) { if (!seconds) return "route time unavailable"; const minutes = Math.max(1, Math.round(seconds / 60)); return minutes >= 60 ? `${Math.floor(minutes / 60)} hr ${minutes % 60} min` : `${minutes} min`; }
function formatElapsed(seconds: number) { const hours = Math.floor(seconds / 3600); const minutes = Math.floor((seconds % 3600) / 60); const remaining = seconds % 60; return [hours, minutes, remaining].map((value) => String(value).padStart(2, "0")).join(":"); }

function meetActionAvailability(mission: MissionView, next: ReturnType<typeof nextStatus>, now: number | null) {
  if (mission.type !== "meet" || !next || !mission.scheduledFor) return { available: true, label: null, note: null };
  const opensAt = next.status === "en_route" || next.status === "onsite" ? meetActionOpensAt(mission.scheduledFor, next.status).getTime() : null;
  if (opensAt === null) return { available: true, label: null, note: null };
  const action = next.status === "en_route" ? "Start trip" : "Check in";
  if (now === null || now < opensAt) {
    return { available: false, label: `${action} available at ${formatDateTime(new Date(opensAt), mission.timeZone)}`, note: next.status === "en_route" ? "Travel status opens 30 minutes before the appointment." : "Verified onsite check-in opens five minutes before the appointment." };
  }
  return { available: true, label: null, note: null };
}
