import { sql } from "drizzle-orm";
import type { SeeReportSnapshot } from "./see-report-types";
export type SeeSubmittedEvidence = {item_id:string;path:string;content_type:string;bytes:number;kind:string;caption:string};
export function seeSubmissionSql(input:{id:string;scoutId:string;previousRevision:number;now:Date;snapshot:SeeReportSnapshot;items:SeeReportSnapshot["items"];evidence:SeeSubmittedEvidence[];summary:string}) {
 const {id,now,snapshot,items,evidence}=input;
 const user={id:input.scoutId},mission={seeReportRevision:input.previousRevision},draft={summary:input.summary};
 return sql`
      WITH submitted AS (
        UPDATE missions SET status='submitted', submitted_at=${now}, see_report_revision=see_report_revision+1,see_report_status='pending',see_report_released_at=NULL,location_sharing_active=false,scout_latitude=NULL,scout_longitude=NULL,scout_location_accuracy_meters=NULL,scout_location_updated_at=NULL,updated_at=${now}
        WHERE id=${id} AND scout_id=${user.id} AND status='onsite' AND archived_at IS NULL AND payment_status='paid' AND see_report_revision=${mission.seeReportRevision}
          AND NOT EXISTS (SELECT 1 FROM mission_change_orders WHERE mission_id=${id} AND status='pending' AND approved_by_user_id IS NOT NULL)
          AND NOT EXISTS (SELECT 1 FROM mission_cases WHERE mission_id=${id} AND status='open')
        RETURNING id,see_report_revision
      ), report AS (
        INSERT INTO see_reports (mission_id,revision,snapshot) SELECT id,see_report_revision,${JSON.stringify(snapshot)}::jsonb FROM submitted RETURNING id
      ), answers AS (
        UPDATE mission_checklist_items item SET response_text=response.text,unavailable_reason=NULLIF(response."unavailableReason",''),completed_by_user_id=${user.id},completed_at=${now},updated_at=${now}
        FROM jsonb_to_recordset(${JSON.stringify(items)}::jsonb) AS response(id uuid,text text,"unavailableReason" text),submitted
        WHERE item.id=response.id AND item.mission_id=submitted.id RETURNING item.id
      ), evidence AS (
        INSERT INTO mission_evidence (mission_id,checklist_item_id,uploaded_by_user_id,kind,storage_path,content_type,byte_size,caption,customer_visible)
        SELECT submitted.id,file.item_id,${user.id},file.kind,file.path,file.content_type,file.bytes,file.caption,true FROM submitted,jsonb_to_recordset(${JSON.stringify(evidence)}::jsonb) AS file(item_id uuid,kind text,path text,content_type text,bytes integer,caption text)
        ON CONFLICT (storage_path) DO NOTHING RETURNING id
      ), results AS (
        INSERT INTO mission_part_results (mission_id,status,summary,submitted_by_user_id,submitted_at) SELECT id,'submitted',${draft.summary},${user.id},${now} FROM submitted
        ON CONFLICT (mission_id) DO UPDATE SET status='submitted',summary=EXCLUDED.summary,submitted_by_user_id=EXCLUDED.submitted_by_user_id,submitted_at=EXCLUDED.submitted_at,updated_at=${now} RETURNING id
      ), changes AS (UPDATE mission_change_orders SET status='fulfilled',fulfilled_at=${now},updated_at=${now} WHERE mission_id=${id} AND status='approved' AND EXISTS(SELECT 1 FROM submitted) RETURNING id
      ), timeline AS (INSERT INTO mission_updates (mission_id,author_id,status,message) SELECT id,${user.id},'submitted'::mission_status,'Scout submitted the structured check. Report preparation and evidence review are in progress.' FROM submitted RETURNING id)
      SELECT report.id AS report_id,1 / CASE WHEN (SELECT count(*) FROM answers)=${items.length} THEN 1 ELSE 0 END AS invariant FROM report
    `;
}
