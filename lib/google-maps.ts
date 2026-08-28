import "server-only";

export type Coordinates = { latitude: number; longitude: number };
export type DrivingRoute = { distanceMeters: number; durationSeconds: number };

function apiKey() {
  return process.env.GOOGLE_MAPS_SERVER_API_KEY?.trim() || null;
}

export function googleMapsConfigured() {
  return Boolean(apiKey());
}

export async function geocodeAddress(address: string): Promise<Coordinates | null> {
  const key = apiKey();
  if (!key || !address.trim()) return null;
  const url = new URL("https://maps.googleapis.com/maps/api/geocode/json");
  url.searchParams.set("address", address);
  url.searchParams.set("key", key);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Google could not verify this address.");
  const data = await response.json() as {
    status?: string;
    results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
  };
  const location = data.results?.[0]?.geometry?.location;
  if (data.status !== "OK" || !Number.isFinite(location?.lat) || !Number.isFinite(location?.lng)) {
    throw new Error("We could not locate that address. Check the street, city, state, and ZIP code.");
  }
  return { latitude: location!.lat!, longitude: location!.lng! };
}

export async function computeDrivingRoute(origin: Coordinates, destination: Coordinates): Promise<DrivingRoute> {
  const key = apiKey();
  if (!key) throw new Error("Verified route pricing is not configured.");
  const response = await fetch("https://routes.googleapis.com/directions/v2:computeRoutes", {
    method: "POST",
    cache: "no-store",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Api-Key": key,
      "X-Goog-FieldMask": "routes.distanceMeters,routes.duration",
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: origin.latitude, longitude: origin.longitude } } },
      destination: { location: { latLng: { latitude: destination.latitude, longitude: destination.longitude } } },
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      computeAlternativeRoutes: false,
      units: "IMPERIAL",
    }),
  });
  if (!response.ok) throw new Error("Google could not calculate a driving route for these addresses.");
  const data = await response.json() as { routes?: Array<{ distanceMeters?: number; duration?: string }> };
  const route = data.routes?.[0];
  if (!route?.distanceMeters) throw new Error("No drivable route was found between these addresses.");
  return {
    distanceMeters: Math.round(route.distanceMeters),
    durationSeconds: Math.max(0, Math.round(Number.parseFloat(route.duration ?? "0"))),
  };
}
