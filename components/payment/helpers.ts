import { PaymentErrors } from "@/components/payment/types";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function formatAmount(amount: number) {
  return `$${amount.toFixed(2)}`;
}

export function normalizePhone(value: string) {
  return value.replace(/\D/g, "");
}

export function validatePaymentInput(
  phone: string,
  agreeRules: boolean,
): PaymentErrors {
  const errors: PaymentErrors = {};
  const cleanPhone = normalizePhone(phone);

  if (!cleanPhone || cleanPhone.length < 7) {
    errors.phone = "Fadlan gali number sax ah (ugu yaraan 7 digit)";
  }

  if (!agreeRules) {
    errors.agreeRules = "Fadlan ogolow shuruudaha isticmaalka";
  }

  return errors;
}

export function mapBackendErrorMessage(message: string, waafiMsg?: string) {
  const lowerMessage = message.toLowerCase();

  if (
    message.includes("Station is offline") ||
    lowerMessage.includes("station offline") ||
    lowerMessage.includes("station is offline") ||
    lowerMessage.includes("offline or has no fresh report")
  ) {
    return "Station-ku hadda ma shaqeynayo. Fadlan isku day mar kale.";
  }

  if (message.includes("No available battery")) {
    return "Ma jiro baytari diyaar ah hadda.";
  }

  if (
    message.includes("Station query timed out") ||
    message.includes("Failed to query station")
  ) {
    return "Station-ka lama heli karo hadda. Fadlan isku day mar kale.";
  }

  if (message.includes("already have an active rental")) {
    return "Waxaad hore u haysataa battery, fadlan soo celi midkaas ka hor intaadan mid kale kireysanin";
  }

  if (message.includes("already being processed")) {
    return "Lacag bixinta number-kan horey ayay u socotaa. Fadlan sug wax yar oo hubi natiijada codsigii hore.";
  }

  if (message.includes("battery is already rented")) {
    return "Battery-gan waa la kireystay, fadlan mar kale isku day";
  }

  if (message.includes("blocked") || message.includes("blacklist")) {
    return "Adigu waxaad ku jirtaa liiska mamnuucida. Fadlan nala soo xiriir: 616586503";
  }

  if (message.includes("Payment not approved")) {
    if (waafiMsg) {
      return waafiMsg;
    }
    return "Lacag bixinta ma dhicin, fadlan hubi numberkaaga iyo haraagaaga";
  }

  if (message.includes("Waafi request timed out")) {
    return "Waafi wali jawaab kama bixin. Haddii lacag kaa baxday, fadlan ha isku dayin mar kale ee la xiriir support-ka Danab: 616586503.";
  }

  if (message.includes("Payment was approved")) {
    return "Codsiga lama xaqiijin. Fadlan la xiriir support-ka Danab.";
  }

  if (message.includes("Battery could not be released. Payment was reversed.")) {
    return "Codsiga lama dhameystirin. Fadlan mar kale isku day ama la xiriir support-ka Danab.";
  }

  if (
    message.includes(
      "Battery could not be released after payment was charged.",
    )
  ) {
    return "Codsiga lama dhameystirin. Fadlan la xiriir support-ka Danab.";
  }

  if (lowerMessage.includes("timed out") || lowerMessage.includes("timeout")) {
    return "Waqtigii codsiga wuu dhamaaday. Fadlan mar kale isku day.";
  }

  if (lowerMessage.includes("abort")) {
    return "Codsiga waa la joojiyay. Fadlan mar kale isku day.";
  }

  return message || "Khalad dhacay, fadlan mar kale isku day";
}
