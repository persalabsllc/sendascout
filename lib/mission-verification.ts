import "server-only";

type LocationState = {
  scoutLatitude: string | null;
  scoutLongitude: string | null;
  scoutLocationAccuracyMeters: number | null;
  scoutLocationUpdatedAt: Date | null;
};

export function verifyScoutAtLocation(mission: LocationState, targetLatitude: string | null, targetLongitude: string | null) {
  if (!targetLatitude || !targetLongitude) throw new Error("This mission does not have a verified address yet.");
  if (!mission.scoutLatitude || !mission.scoutLongitude || !mission.scoutLocationUpdatedAt) {
    throw new Error("Start live location sharing and wait for a current GPS update before checking in.");
  }
  const ageMs = Date.now() - mission.scoutLocationUpdatedAt.getTime();
  if (ageMs > 2 * 60 * 1000) throw new Error("Your location update is too old. Keep the mission page open and try again.");
  const accuracy = mission.scoutLocationAccuracyMeters ?? 10000;
  if (accuracy > 200) throw new Error("GPS accuracy is too low to verify arrival. Move outdoors briefly and try again.");
  const distanceMeters = geographicDistanceMeters(
    Number(mission.scoutLatitude),
    Number(mission.scoutLongitude),
    Number(targetLatitude),
    Number(targetLongitude),
  );
  if (distanceMeters > 250) throw new Error(`You must be at the mission location to check in. Current verified distance is about ${Math.round(distanceMeters)} meters.`);
  return {
    latitude: mission.scoutLatitude,
    longitude: mission.scoutLongitude,
    accuracy,
    distanceMeters,
  };
}

export function geographicDistanceMeters(firstLatitude: number, firstLongitude: number, secondLatitude: number, secondLongitude: number) {
  const radians = (degrees: number) => degrees * Math.PI / 180;
  const earthRadiusMeters = 6371000;
  const deltaLatitude = radians(secondLatitude - firstLatitude);
  const deltaLongitude = radians(secondLongitude - firstLongitude);
  const a = Math.sin(deltaLatitude / 2) ** 2 + Math.cos(radians(firstLatitude)) * Math.cos(radians(secondLatitude)) * Math.sin(deltaLongitude / 2) ** 2;
  return earthRadiusMeters * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
