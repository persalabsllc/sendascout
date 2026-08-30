import { createHmac, timingSafeEqual } from "node:crypto";

const PIN_PATTERN = /^\d{6}$/;
const HASH_PREFIX = "hmac-sha256:";
export const MAX_DELIVERY_PIN_ATTEMPTS = 5;
export const DELIVERY_PIN_LOCK_MINUTES = 15;

export function normalizeDeliveryPin(value: string) {
  const pin = value.trim();
  if (!PIN_PATTERN.test(pin)) throw new Error("Delivery PINs must contain exactly six digits.");
  return pin;
}

export function isValidDeliveryPin(value: string) {
  return PIN_PATTERN.test(value.trim());
}

export function hashDeliveryPin(pin: string, pepper: string, missionId: string) {
  const normalizedPin = normalizeDeliveryPin(pin);
  const normalizedMissionId = requireSecretInput(missionId, "Mission ID");
  const normalizedPepper = requireSecretInput(pepper, "Delivery PIN pepper");
  const digest = createHmac("sha256", normalizedPepper)
    .update(`${normalizedMissionId}:${normalizedPin}`, "utf8")
    .digest("hex");
  return `${HASH_PREFIX}${digest}`;
}

export function verifyDeliveryPin(pin: string, storedHash: string, pepper: string, missionId: string) {
  if (!isValidDeliveryPin(pin) || !storedHash.startsWith(HASH_PREFIX)) return false;
  const expectedHex = storedHash.slice(HASH_PREFIX.length);
  if (!/^[a-f0-9]{64}$/i.test(expectedHex)) return false;
  const candidateHex = hashDeliveryPin(pin, pepper, missionId).slice(HASH_PREFIX.length);
  return timingSafeEqual(Buffer.from(candidateHex, "hex"), Buffer.from(expectedHex, "hex"));
}

export function nextDeliveryPinFailureState(currentFailedAttempts: number, now = new Date()) {
  if (!Number.isSafeInteger(currentFailedAttempts) || currentFailedAttempts < 0 || Number.isNaN(now.getTime())) {
    throw new Error("Delivery PIN attempt state is invalid.");
  }
  const failedAttempts = currentFailedAttempts + 1;
  return {
    failedAttempts,
    lockedUntil: failedAttempts >= MAX_DELIVERY_PIN_ATTEMPTS
      ? new Date(now.getTime() + DELIVERY_PIN_LOCK_MINUTES * 60_000)
      : null,
  };
}

export function isDeliveryPinLocked(lockedUntil: Date | null | undefined, now = new Date()) {
  if (!lockedUntil) return false;
  if (Number.isNaN(lockedUntil.getTime()) || Number.isNaN(now.getTime())) throw new Error("Delivery PIN lock time is invalid.");
  return lockedUntil.getTime() > now.getTime();
}

function requireSecretInput(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} is required.`);
  return normalized;
}
