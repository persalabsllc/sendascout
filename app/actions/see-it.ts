"use server";
import { createMission, type MissionInput } from "@/app/actions/onboarding";
import { type SeeConfiguration } from "@/lib/see-it";
export type SeeOrder = { configuration: SeeConfiguration; address: string; addressLine2: string; city: string; state: string; zip: string; timeZone: string; phone: string };
export async function createSeeMission(order: SeeOrder) {
  const input: MissionInput = {
    type: "see", ...order, seeConfiguration: order.configuration,
    pickupName: "", pickupAddress: "", pickupAddressLine2: "", pickupCity: "", pickupState: "", pickupZip: "", pickupInstructions: "",
    dropoffName: "", dropoffAddress: "", dropoffAddressLine2: "", dropoffCity: "", dropoffState: "", dropoffZip: "", deliveryInstructions: "",
    largeItem: false, meetAuthorizedMinutes: 60, scheduledFor: "", title: "See It", instructions: "Complete the selected check.",
    sourceMissionId: "", templateId: "", preferredScoutId: "", enhancedReport: false, checklistItems: [],
    saveAsTemplate: false, templateName: "", recurrence: "once", recurrenceEndsOn: "", recurrenceScheduleId: "", recurrenceOccurrenceAt: "",
    deliveryMethod: "leave_at_location", deliveryPinRequired: false, deliveryPin: "",
    addMoveLeg: false, bundleDropoffName: "", bundleDropoffAddress: "", bundleDropoffAddressLine2: "", bundleDropoffCity: "", bundleDropoffState: "", bundleDropoffZip: "", bundleDeliveryInstructions: "", bundleTitle: "", bundleInstructions: "", bundleLargeItem: false,
    bundleDeliveryMethod: "leave_at_location", bundleDeliveryPinRequired: false, bundleDeliveryPin: "",
  };
  return createMission(input);
}
