"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { upload } from "@vercel/blob/client";
import {
  IconArrowLeft, IconCheck, IconClock, IconFileUpload, IconMapPin, IconMessageCircle,
  IconNavigation, IconPhoto, IconRoute, IconSend, IconShieldCheck,
} from "@tabler/icons-react";
import {
  claimMission, confirmMissionComplete, sendMissionMessage, setLocationSharing,
  submitMissionResults, updateMissionLocation, updateMissionStatus,
} from "@/app/actions/missions";

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
  customerPriceCents: number;
  scoutPayoutCents: number;
  largeItem: boolean;
  locationSharingActive: boolean;
  latitude?: number | null;
  longitude?: number | null;
  locationUpdatedAt?: string | null;
  customerName: string;
  scoutName?: string | null;
};
type MessageView = { id: string; body: string; sender: string; mine: boolean; createdAt: string };
type ResultView = { summary: string | null; mediaUrls: string[]; submittedAt: string | null };

export function MissionWorkspace({ role, mission, messages, results, canClaim }: { role: "customer" | "scout" | "admin"; mission: MissionView; messages: MessageView[]; results: ResultView; canClaim: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [resultSummary, setResultSummary] = useState("");
  const [resultFiles, setResultFiles] = useState<File[]>([]);
  const [tracking, setTracking] = useState(mission.locationSharingActive);
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
        if (!resultSummary.trim() && resultFiles.length === 0) {
          setError("Add a written result, photo, or video before submitting.");
          return;
        }
        const mediaUrls: string[] = [];
        for (const file of resultFiles) {
          const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, "-");
          const blob = await upload(`mission-results/${mission.id}/${safeName}`, file, {
            access: "private",
            handleUploadUrl: "/api/mission-results/upload",
            clientPayload: JSON.stringify({ missionId: mission.id }),
            multipart: file.size > 5 * 1024 * 1024,
          });
          mediaUrls.push(blob.pathname);
        }
        const result = await submitMissionResults(mission.id, resultSummary, mediaUrls);
        if (!result.ok) setError(result.error);
        else router.refresh();
      } catch (uploadError) {
        setError(uploadError instanceof Error ? uploadError.message : "The result files could not be uploaded.");
      }
    });
  }

  const next = nextStatus(mission.type, mission.status);
  const mapUrl = mission.latitude != null && mission.longitude != null ? approximateMapUrl(mission.latitude, mission.longitude) : null;
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
            <article className="mission-panel route-panel">
              <div className="panel-heading"><IconRoute size={22} /><div><h2>Mission route</h2><p>{mission.type === "move" ? "Pickup and delivery details" : "Where your Scout is going"}</p></div></div>
              <LocationStop number="1" label={mission.type === "move" ? "Pickup" : "Mission location"} location={mission.pickup} instructions={mission.pickupInstructions} />
              {mission.dropoff && <LocationStop number="2" label="Drop-off" location={mission.dropoff} instructions={mission.deliveryInstructions} />}
              {mission.type === "move" && <div className="mission-instructions"><strong>Vehicle requirement</strong><p>{mission.largeItem ? "Larger item — SUV, van or pickup truck requested" : "Small item — fits in a car or trunk"}</p></div>}
              <div className="mission-instructions"><strong>Mission instructions</strong><p>{mission.instructions}</p></div>
              {mission.scheduledFor && <p className="mission-time"><IconClock size={17} /> Scheduled for {new Date(mission.scheduledFor).toLocaleString()}</p>}
            </article>

            {canClaim && <article className="mission-panel claim-panel"><IconShieldCheck size={28} /><div><h2>Ready to take this mission?</h2><p>You’ll receive the full address and private customer chat after claiming.</p></div><button className="button" disabled={pending} onClick={() => run(() => claimMission(mission.id))}>Claim for {money(mission.scoutPayoutCents)}</button></article>}

            {role === "scout" && assigned && !["submitted", "completed", "cancelled", "disputed"].includes(mission.status) && <article className="mission-panel action-panel">
              <div><h2>Scout controls</h2><p>Update the customer as you move through the mission.</p></div>
              {next && <button className="button" disabled={pending} onClick={() => run(() => updateMissionStatus(mission.id, next.status))}>{next.label}</button>}
              <button className={`tracking-button ${tracking ? "tracking-on" : ""}`} disabled={pending} onClick={toggleTracking}><IconNavigation size={18} /> {tracking ? "Stop location sharing" : "Start live location sharing"}</button>
              <small>Location is shared only during this active mission and is removed when sharing stops.</small>
            </article>}

            {role === "scout" && assigned && readyForResults(mission) && <article className="mission-panel result-form-panel">
              <div className="panel-heading"><IconFileUpload size={22} /><div><h2>{mission.type === "see" ? "Submit what you found" : mission.type === "move" ? "Submit delivery proof" : "Submit appointment results"}</h2><p>These notes and files go directly to the paying customer.</p></div></div>
              <label className="result-notes"><span>Result notes</span><textarea rows={6} maxLength={5000} placeholder={mission.type === "see" ? "Describe the condition, answer the customer’s questions, and call out anything important…" : "Describe what happened and any details the customer should know…"} value={resultSummary} onChange={(event) => setResultSummary(event.target.value)} /></label>
              <label className="result-upload"><IconPhoto size={23} /><span><strong>Add photos or video <em>(optional)</em></strong><small>Include evidence when useful · up to 12 JPG, PNG, WEBP, HEIC, MP4, MOV or WEBM files</small></span><input type="file" accept="image/jpeg,image/png,image/webp,image/heic,video/mp4,video/quicktime,video/webm" multiple onChange={(event) => setResultFiles(Array.from(event.target.files ?? []).slice(0, 12))} /></label>
              {resultFiles.length > 0 && <div className="selected-files">{resultFiles.map((file) => <span key={`${file.name}-${file.size}`}>{file.name}<small>{formatBytes(file.size)}</small></span>)}</div>}
              <button className="button" disabled={pending} onClick={submitResults}>{pending ? "Uploading and submitting…" : "Submit results to customer"}</button>
            </article>}

            {(results.summary || results.mediaUrls.length > 0) && <ResultPanel results={results} />}

            {role === "customer" && mission.status === "submitted" && <article className="mission-panel completion-panel"><IconCheck size={28} /><div><h2>Scout marked this mission complete</h2><p>Review the result, then confirm completion.</p></div><button className="button" disabled={pending} onClick={() => run(() => confirmMissionComplete(mission.id))}>Confirm completion</button></article>}
          </section>

          <aside className="mission-column">
            <article className="mission-panel tracking-panel">
              <div className="panel-heading"><IconNavigation size={22} /><div><h2>Scout location</h2><p>{trackingCopy(mission)}</p></div></div>
              {mission.locationSharingActive && mapUrl ? <>
                <iframe title="Approximate Scout location" src={mapUrl} loading="lazy" />
                <small>Approximate location · refreshed every 10 seconds · {mission.locationUpdatedAt ? `last update ${new Date(mission.locationUpdatedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "waiting for first update"}</small>
              </> : <div className="tracking-empty"><IconMapPin size={28} /><strong>Location is not currently being shared</strong><p>Status updates will still appear here.</p></div>}
            </article>

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

function LocationStop({ number, label, location, instructions }: { number: string; label: string; location: string; instructions?: string | null }) {
  return <div className="mission-stop"><span>{number}</span><div><small>{label}</small><strong>{location}</strong>{instructions && <p>{instructions}</p>}</div></div>;
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
    en_route: { status: "onsite", label: "I’ve arrived at location" },
  };
  return steps[status] ?? null;
}

function ResultPanel({ results }: { results: ResultView }) {
  return <article className="mission-panel result-panel"><div className="panel-heading"><IconCheck size={22} /><div><h2>Mission results</h2><p>{results.submittedAt ? `Submitted ${new Date(results.submittedAt).toLocaleString()}` : "Submitted by the Scout"}</p></div></div>{results.summary && <p className="result-summary">{results.summary}</p>}{results.mediaUrls.length > 0 && <div className="result-gallery">{results.mediaUrls.map((url) => isVideo(url) ? <video controls preload="metadata" src={url} key={url} /> : <a href={url} target="_blank" rel="noreferrer" key={url}><img loading="lazy" src={url} alt="Scout mission result" /></a>)}</div>}</article>;
}

function statusLabel(type: MissionView["type"], status: Status) {
  const common: Partial<Record<Status, string>> = { draft: "Awaiting review", open: "Available to Scouts", claimed: "Scout assigned", submitted: "Awaiting customer confirmation", completed: "Completed", cancelled: "Cancelled", disputed: "Under review" };
  if (type === "move") return ({ en_route_pickup: "En route to pickup", at_pickup: "At pickup", en_route_dropoff: "On the way to drop-off", at_dropoff: "At drop-off", ...common })[status] ?? status;
  return ({ en_route: "En route to location", onsite: type === "see" ? "At inspection location" : "At meeting location", ...common })[status] ?? status;
}

function missionLabel(type: MissionView["type"]) { return type === "see" ? "See It mission" : type === "move" ? "Move It mission" : "Meet It mission"; }
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
