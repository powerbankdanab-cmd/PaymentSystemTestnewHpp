"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { AmountCard } from "@/components/payment/AmountCard";
import {
  buildTimeOptions,
  DEFAULT_RENTAL_AMOUNT,
  PAYMENT_METHODS,
  PHONE_PLACEHOLDER_BY_METHOD,
} from "@/components/payment/constants";
import {
  cn,
  mapBackendErrorMessage,
  normalizePhone,
  validatePaymentInput,
} from "@/components/payment/helpers";
import { MethodPicker } from "@/components/payment/MethodPicker";
import { PayButton } from "@/components/payment/PayButton";
import { PaymentHeader } from "@/components/payment/PaymentHeader";
import { PhoneInput } from "@/components/payment/PhoneInput";
import { RulesAgreement } from "@/components/payment/RulesAgreement";
import { TimeOptions } from "@/components/payment/TimeOptions";
import { PaymentMethod } from "@/components/payment/types";
import { getStationRentalAmount } from "@/lib/client/station";

const PAYMENT_FLOW_RESET_KEY = "caste:payment-flow-reset-home-form";
const DEFAULT_METHOD: PaymentMethod = "EVC Plus";

type PayResponse = {
  success?: boolean;
  hppRequired?: boolean;
  redirectUrl?: string;
  jobId?: string;
  referenceId?: string;
  error?: string;
  waafiMsg?: string;
  waafiMessage?: string;
  battery_id?: string;
  slot_id?: string;
  stationCode?: string;
};

async function safeReadJson(response: Response): Promise<PayResponse> {
  try {
    return (await response.json()) as PayResponse;
  } catch {
    return {};
  }
}

export function PaymentCard({
  darkMode,
  onToggleTheme,
}: {
  darkMode: boolean;
  onToggleTheme: () => void;
}) {
  const router = useRouter();

  const [stationAmount, setStationAmount] = useState(DEFAULT_RENTAL_AMOUNT);
  const [selectedAmount, setSelectedAmount] = useState(DEFAULT_RENTAL_AMOUNT);
  const [selectedMethod, setSelectedMethod] =
    useState<PaymentMethod>(DEFAULT_METHOD);
  const [phone, setPhone] = useState("");
  const [agreeRules, setAgreeRules] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [paymentError, setPaymentError] = useState("");
  const [errors, setErrors] = useState<{ phone?: string; agreeRules?: string }>(
    {},
  );
  const timeOptions = useMemo(
    () => buildTimeOptions(stationAmount),
    [stationAmount],
  );

  useEffect(() => {
    router.prefetch("/payment");

    const resetForm = () => {
      const nextAmount = getStationRentalAmount();
      setStationAmount(nextAmount);
      setSelectedAmount(nextAmount);
      setSelectedMethod(DEFAULT_METHOD);
      setPhone("");
      setAgreeRules(true);
      setErrors({});
      setStatusMessage("");
      setPaymentError("");
      setIsSubmitting(false);
    };

    resetForm();

    const maybeResetOnReturnFromPayment = () => {
      if (window.sessionStorage.getItem(PAYMENT_FLOW_RESET_KEY) === "1") {
        window.sessionStorage.removeItem(PAYMENT_FLOW_RESET_KEY);
        resetForm();
        return;
      }

      setStationAmount(getStationRentalAmount());
      setStatusMessage("");
      setIsSubmitting(false);
    };

    const onVisibilityChange = () => {
      if (!document.hidden) {
        maybeResetOnReturnFromPayment();
      }
    };

    maybeResetOnReturnFromPayment();
    window.addEventListener("pageshow", maybeResetOnReturnFromPayment);
    window.addEventListener("focus", maybeResetOnReturnFromPayment);
    window.addEventListener("popstate", maybeResetOnReturnFromPayment);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.removeEventListener("pageshow", maybeResetOnReturnFromPayment);
      window.removeEventListener("focus", maybeResetOnReturnFromPayment);
      window.removeEventListener("popstate", maybeResetOnReturnFromPayment);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [router]);

  const handlePay = async () => {
    if (isSubmitting) {
      return;
    }

    const formErrors = validatePaymentInput(phone, agreeRules);
    setErrors(formErrors);
    setPaymentError("");

    if (Object.keys(formErrors).length > 0) {
      return;
    }

    const cleanPhone = normalizePhone(phone);

    setIsSubmitting(true);
    window.sessionStorage.setItem(PAYMENT_FLOW_RESET_KEY, "1");
    setStatusMessage("Hubinaya station-ka iyo battery-ga...");

    try {
      const response = await fetch("/api/pay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          phoneNumber: cleanPhone,
          amount: selectedAmount,
          method: selectedMethod,
        }),
      });
      const data = await safeReadJson(response);

      if (response.ok && data.hppRequired) {
        if (!data.redirectUrl) {
          throw new Error("Waafi payment page URL lama helin. Fadlan mar kale isku day.");
        }

        setStatusMessage("Furaya bogga lacag bixinta Waafi...");
        window.location.assign(data.redirectUrl);
        return;
      }

      if (response.ok && data.success) {
        const params = new URLSearchParams({ status: "success" });
        if (data.battery_id) params.set("battery", data.battery_id);
        if (data.slot_id) params.set("slot", data.slot_id);
        if (data.stationCode) params.set("station", data.stationCode);
        if (data.jobId) params.set("jobId", data.jobId);
        router.push(`/payment/result?${params.toString()}`);
        return;
      }

      throw new Error(
        mapBackendErrorMessage(
          data.error || "Khalad dhacay, fadlan mar kale isku day",
          data.waafiMsg,
        ),
      );
    } catch (error) {
      window.sessionStorage.removeItem(PAYMENT_FLOW_RESET_KEY);
      setStatusMessage("");
      setPaymentError(
        error instanceof Error
          ? error.message
          : "Khalad dhacay, fadlan mar kale isku day",
      );
      setIsSubmitting(false);
    }
  };

  return (
    <main
      className={cn(
        "relative mx-auto w-full max-w-md rounded-3xl border p-4 shadow-lg sm:p-5",
        darkMode
          ? "border-white/[0.08] bg-white/[0.06] text-white shadow-2xl shadow-violet-500/10 backdrop-blur-xl"
          : "border-gray-200 bg-white text-slate-800",
      )}
    >
      <PaymentHeader darkMode={darkMode} onToggleTheme={onToggleTheme} />

      <section className="rounded-3xl pb-6">
        <TimeOptions
          options={timeOptions}
          selectedAmount={selectedAmount}
          onSelect={setSelectedAmount}
        />

        <AmountCard amount={selectedAmount} />

        <MethodPicker
          methods={PAYMENT_METHODS}
          selectedMethod={selectedMethod}
          onSelect={setSelectedMethod}
        />

        <PhoneInput
          value={phone}
          onChange={setPhone}
          placeholder={PHONE_PLACEHOLDER_BY_METHOD[selectedMethod]}
          error={errors.phone}
        />

        <RulesAgreement
          checked={agreeRules}
          onToggle={() => setAgreeRules((prev) => !prev)}
          error={errors.agreeRules}
        />

        {(statusMessage || paymentError) && (
          <div
            className={cn(
              "mx-3 mt-5 rounded-2xl border px-4 py-3 text-sm font-semibold sm:mx-4",
              paymentError
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-emerald-200 bg-emerald-50 text-emerald-700",
            )}
          >
            {paymentError || statusMessage}
          </div>
        )}

        <PayButton loading={isSubmitting} onClick={handlePay} />
      </section>

      <footer
        className={cn(
          "mt-6 px-4 py-3 text-center text-xs sm:text-sm",
          darkMode ? "text-gray-400" : "text-gray-600",
        )}
      >
        Call us any feedback or problem{" "}
        <span
          className={cn("font-bold", darkMode ? "text-white" : "text-gray-900")}
        >
          616586503 / 616251068
        </span>
      </footer>
    </main>
  );
}
