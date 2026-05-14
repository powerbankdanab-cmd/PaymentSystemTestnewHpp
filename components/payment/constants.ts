import { PaymentMethod, TimeOption } from "@/components/payment/types";

export const DEFAULT_RENTAL_AMOUNT = 0.75;

export function buildTimeOptions(
  amount = DEFAULT_RENTAL_AMOUNT,
): TimeOption[] {
  return [{ label: `$${amount.toFixed(2)}`, amount, icon: "clock" }];
}

export const TIME_OPTIONS: TimeOption[] = buildTimeOptions();

export const PAYMENT_METHODS: PaymentMethod[] = ["EVC Plus", "ZAAD", "SAHAL"];

export const PHONE_PLACEHOLDER_BY_METHOD: Record<PaymentMethod, string> = {
  "EVC Plus": "61 xxxxx",
  ZAAD: "63 xxxxx",
  SAHAL: "37 xxxxx",
};
