import { neon } from "@neondatabase/serverless";

if (process.argv[2] !== "--confirm") throw new Error("Pass --confirm to archive the known pre-launch test missions.");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const sql = neon(process.env.DATABASE_URL);
const ids = [
  "0482f8f0-2c42-43d1-8148-76f4ba078e47",
  "c38d05a9-b366-44f7-b7f9-f19217f48f85",
  "10f1ff79-2a9d-47d1-97ea-fe5ac3628ac9",
  "ac547346-e066-48cf-822f-faeaef5cbb8c",
  "7992b74b-cafb-4ccd-93ef-eb6fe5bc47d5",
];

const results = await sql.transaction([
  sql`update missions set archived_at=now(), archived_reason=${"Pre-launch test mission archived during production readiness cleanup."}, status=case when status in ('claimed','en_route','onsite','en_route_pickup','at_pickup','en_route_dropoff','at_dropoff','submitted') then 'cancelled'::mission_status else status end, location_sharing_active=false, scout_latitude=null, scout_longitude=null, scout_location_accuracy_meters=null, scout_location_updated_at=null, updated_at=now() where id = any(${ids}::uuid[]) and payment_status='unpaid' and archived_at is null returning id,title,status`,
  sql`insert into mission_updates (mission_id,status,message) select id,status,${"Pre-launch test mission archived. Historical record retained; excluded from live dashboards and statistics."} from missions where id = any(${ids}::uuid[])`,
  sql`update notifications set read_at=coalesce(read_at,now()) where mission_id = any(${ids}::uuid[])`,
  sql`update scout_profiles sp set completed_missions=(select count(*)::int from missions m where m.scout_id=sp.user_id and m.status='completed' and m.archived_at is null), updated_at=now()`,
]);

console.log(JSON.stringify({ archived: results[0] }, null, 2));
