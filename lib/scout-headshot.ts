import sharp from "sharp";
import {
  SCOUT_HEADSHOT_MAX_BYTES,
  SCOUT_HEADSHOT_MAX_PIXELS,
  SCOUT_HEADSHOT_MIN_DIMENSION,
} from "./scout-headshot-policy.ts";

const expectedFormatByContentType = new Map<string, "jpeg" | "png" | "webp">([
  ["image/jpeg", "jpeg"],
  ["image/png", "png"],
  ["image/webp", "webp"],
]);

export type ScoutHeadshotMetadata = {
  width: number;
  height: number;
  format: "jpeg" | "png" | "webp";
};

/**
 * Verifies the decoded image rather than trusting an upload's filename or
 * declared content type. The final decode catches truncated images that can
 * sometimes expose plausible metadata before the corrupt bytes are reached.
 */
export async function validateScoutHeadshotBytes(
  bytes: Uint8Array,
  declaredContentType: string,
): Promise<ScoutHeadshotMetadata> {
  const contentType = declaredContentType.split(";", 1)[0]!.trim().toLowerCase();
  const expectedFormat = expectedFormatByContentType.get(contentType);
  if (!expectedFormat || bytes.byteLength <= 0 || bytes.byteLength > SCOUT_HEADSHOT_MAX_BYTES) {
    throw new Error("Profile photos must be readable JPG, PNG, or WEBP images no larger than 5 MB.");
  }

  try {
    const image = sharp(bytes, { failOn: "warning", limitInputPixels: SCOUT_HEADSHOT_MAX_PIXELS });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (
      metadata.format !== expectedFormat
      || (metadata.pages ?? 1) !== 1
      || width < SCOUT_HEADSHOT_MIN_DIMENSION
      || height < SCOUT_HEADSHOT_MIN_DIMENSION
      || width * height > SCOUT_HEADSHOT_MAX_PIXELS
    ) {
      throw new Error("invalid profile image metadata");
    }

    // Force a complete decode so a truncated or otherwise corrupt image never
    // becomes the customer-facing profile photo merely because metadata parsed.
    await image.rotate().resize({ width: 64, height: 64, fit: "cover" }).toBuffer();
    return { width, height, format: expectedFormat };
  } catch {
    throw new Error("Choose a complete, readable JPG, PNG, or WEBP profile photo at least 160 by 160 pixels.");
  }
}
