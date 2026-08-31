import { desc, eq } from "drizzle-orm";
import { ControlRoomScouts } from "@/components/control-room-scouts";
import { getDb } from "@/db";
import { scoutProfiles, users } from "@/db/schema";
import { requireAdminUser } from "@/lib/app-user";
import { LEGAL_VERSION } from "@/lib/legal";
import { scoutApprovalChecklist } from "@/lib/scout-approval";
import { getStripeLivemode } from "@/lib/stripe";

export const metadata = { title: "Scout Management | Send a Scout", robots: { index: false, follow: false } };

export default async function ScoutManagementPage() {
  await requireAdminUser();
  const rows = await getDb().select({ profile: scoutProfiles, user: users }).from(scoutProfiles).innerJoin(users, eq(users.id, scoutProfiles.userId)).orderBy(desc(scoutProfiles.createdAt));
  const stripeLivemode = getStripeLivemode();
  return <ControlRoomScouts scouts={rows.map(({ profile, user }) => ({
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
    checklist: scoutApprovalChecklist({ ...profile, ...user }, LEGAL_VERSION, stripeLivemode),
  }))} />;
}
