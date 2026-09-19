export type SeeEvidenceFile = { path: string; contentType: string; bytes: number; uploadedAt: string; deviceTimestamp?: string };
export type SeeAnswer = { itemId: string; text: string; unavailableReason: string; files: SeeEvidenceFile[] };
export type SeeDraft = { summary: string; answers: SeeAnswer[] };
export type SeeReportSnapshot = {
  missionId: string; revision: number; title: string; templateName: string; templateVersion: number;
  address: string; timeZone: string; submittedAt: string; visitAt: string | null;
  locationVerified: boolean; latitude: string | null; longitude: string | null; accuracyMeters: number | null;
  scoutName: string; scoutId: string; summary: string; requestedFocus: string;
  items: { id: string; prompt: string; responseType: string; text: string; unavailableReason: string; files: SeeEvidenceFile[] }[];
  sample?: boolean;
};
