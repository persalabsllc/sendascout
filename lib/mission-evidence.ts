const DELIVERY_PHOTO_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export const MAX_MISSION_EVIDENCE_BYTES = 10 * 1024 * 1024;

/**
 * Validates the stored evidence metadata used to satisfy proof of delivery.
 * A filename or pathname is intentionally not part of this decision.
 */
export function isVerifiedDeliveryPhoto(input: {
  kind: string;
  contentType: string | null | undefined;
  byteSize?: number | null;
}) {
  if (input.kind !== "delivery_photo" || !input.contentType) return false;
  const contentType = input.contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (!contentType || !DELIVERY_PHOTO_CONTENT_TYPES.has(contentType)) return false;
  if (input.byteSize !== undefined && input.byteSize !== null) {
    if (!Number.isSafeInteger(input.byteSize) || input.byteSize <= 0 || input.byteSize > MAX_MISSION_EVIDENCE_BYTES) {
      return false;
    }
  }
  return true;
}
