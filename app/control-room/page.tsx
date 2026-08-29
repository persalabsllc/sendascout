import { desc, eq, sql } from "drizzle-orm";
import { ControlRoom } from "@/components/control-room";
import { getDb } from "@/db";
import { missions, scoutProfiles, users } from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";

export const metadata = { title: "Control Room | Send a Scout", robots: { index: false, follow: false } };

export default async function ControlRoomPage() {
  await requireAdminUser();
  const db = getDb();
  const [scoutRows, missionRows, [userCount]] = await Promise.all([
    db.select({ profile: scoutProfiles, user: users }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).orderBy(desc(scoutProfiles.createdAt)),
    db.select({ mission: missions, customer: users }).from(missions).innerJoin(users, eq(users.id, missions.customerId)).orderBy(desc(missions.createdAt)),
    db.select({ count: sql<number>`count(*)::int` }).from(users),
  ]);
  const activeStatuses = ["claimed", "en_route", "onsite", "en_route_pickup", "at_pickup", "en_route_dropoff", "at_dropoff", "submitted"] as const;
  return <ControlRoom
    stats={{
      users: userCount?.count ?? 0,
      applicants: scoutRows.filter(({ profile }) => ["applicant", "review"].includes(profile.status)).length,
      open: missionRows.filter(({ mission }) => mission.status === "open").length,
      active: missionRows.filter(({ mission }) => activeStatuses.includes(mission.status as typeof activeStatuses[number])).length,
    }}
    scouts={scoutRows.map(({ profile, user }) => ({
      id: profile.id,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ") || "Unnamed applicant",
      email: user.email,
      phone: user.phone ?? "",
      zip: profile.homeZip ?? "No ZIP",
      vehicle: profile.vehicleType ?? "",
      radius: profile.serviceRadiusMiles,
      status: profile.status,
      identityStatus: profile.identityCheck,
      identityProvider: profile.identityProvider,
      identityVerifiedAt: profile.identityVerifiedAt?.toISOString() ?? null,
      legalVersion: user.legalVersion,
      legalAcceptedAt: user.legalAcceptedAt?.toISOString() ?? null,
      capabilities: [profile.canSee && "See", profile.canMove && "Move", profile.canMeet && "Meet"].filter(Boolean).join(" / "),
    }))}
    missions={missionRows.map(({ mission, customer }) => ({
      id: mission.id,
      title: mission.title,
      type: mission.type,
      status: mission.status,
      customer: [customer.firstName, customer.lastName].filter(Boolean).join(" ") || customer.email,
      location: `${mission.city}, ${mission.state} ${mission.zip}`,
      price: mission.customerPriceCents,
      payout: mission.scoutPayoutCents,
      routeMiles: mission.routeDistanceMeters ? Math.max(1, Math.ceil(mission.routeDistanceMeters / 1609.344)) : null,
      routeVerified: mission.routeSource === "google",
      authorizedMinutes: mission.meetAuthorizedMinutes,
      createdAt: mission.createdAt.toISOString(),
    }))}
  />;
}
