export const PLATFORM_ALERT_RECIPIENT = "support@sendascout.com";

export type ActivityPayload = Record<string, string | number | null>;
export type ActivityEmail = { from: string; to: string[]; subject: string; text: string; html: string };

export function platformActivityEmail(kind: string, p: ActivityPayload, from: string): ActivityEmail {
  const text = (key: string, fallback = "Not provided") => String(p[key] ?? "").trim() || fallback;
  const money = (key: string) => `$${(Number(p[key] ?? 0) / 100).toFixed(2)}`;
  const when = (key: string) => {
    if (!p[key]) return "Not specified";
    const date = new Date(String(p[key]));
    if (Number.isNaN(date.getTime())) return "Not specified";
    let zone = text("timeZone", "America/New_York");
    try { new Intl.DateTimeFormat("en-US", { timeZone: zone }); } catch { zone = "UTC"; }
    return `${new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(date)} (${zone})`;
  };
  let subject: string;
  let body: string;
  let url: string;
  if (kind === "mission_launched") {
    subject = `[MISSION LIVE] ${text("missionType").toUpperCase()} IT — ${text("location")}`;
    url = `https://www.sendascout.com/dashboard/missions/${encodeURIComponent(text("missionId"))}`;
    body = `A paid mission has launched. Check Scout coverage and coordinate fulfillment.\n\nMission: ${text("title")}\nLocation: ${text("address")}\nCustomer: ${text("name")}\nEmail: ${text("email")}\nPhone: ${text("phone")}\n\nCustomer paid: ${money("customerPriceCents")}\nScout payout: ${money("scoutPayoutCents")}\nCompletion target: ${when("deadline")}\nAssign a Scout before: ${when("assignmentCutoff")}\nScheduled visit: ${when("scheduledFor")}\n\nInstructions:\n${text("instructions")}\n\nThis records the launch; open the mission for its current claim/status.`;
  } else if (kind === "customer_created" || kind === "scout_signup") {
    const scout = kind === "scout_signup";
    subject = `[NEW ${scout ? "SCOUT" : "CUSTOMER"}] ${text("name", text("email"))}`;
    url = `https://www.sendascout.com/control-room/${scout ? "scouts" : "customers"}`;
    body = `A new ${scout ? "Scout signup" : "customer account"} was recorded.\n\nName: ${text("name")}\nEmail: ${text("email")}\nPhone: ${text("phone")}\nLocation: ${text("location")}\nTime: ${when("createdAt")}\n\n${scout ? "This is a signup alert, not approval to claim missions. Profile, identity and payout onboarding may still be incomplete." : "This is an account alert, not a paid mission. You will receive a separate alert when a mission launches."}`;
  } else if (kind === "alerts_enabled") {
    subject = "Send a Scout — platform activity alerts are enabled";
    url = "https://www.sendascout.com/control-room";
    body = "Kyle, your platform activity alerts are enabled.\n\nYou will receive an email here when:\n• A paid mission launches\n• A new Scout signs up\n• A new customer account is created\n\nExisting customer and Scout email rules are unchanged. Alerts begin from activation; old accounts and missions will not be replayed.\n\nThis is a one-time setup confirmation, not a new mission or signup.";
  } else throw new Error("Unknown platform activity kind");
  subject = subject.replace(/[\r\n]/g, " ").slice(0, 200);
  const escape = (value: string) => value.replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return { from, to: [PLATFORM_ALERT_RECIPIENT], subject, text: `${body}\n\nOpen Send a Scout: ${url}`, html: `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#17354a"><p style="color:#e76550;font-weight:bold">SEND A SCOUT · PLATFORM ACTIVITY</p><h1 style="font-size:24px">${escape(subject)}</h1><div style="white-space:pre-wrap;line-height:1.6">${escape(body)}</div><p><a href="${escape(url)}" style="display:inline-block;padding:14px 20px;background:#17354a;color:white;border-radius:8px;text-decoration:none">Open Send a Scout</a></p></div>` };
}
