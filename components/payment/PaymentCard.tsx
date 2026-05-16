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
  const [paymentNotice, setPaymentNotice] = useState<{
    tone: "error" | "info";
    title: string;
    message: string;
  } | null>(null);
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
      setPaymentNotice(null);
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
    setPaymentNotice(null);

    if (Object.keys(formErrors).length > 0) {
      return;
    }

    const cleanPhone = normalizePhone(phone);

    setIsSubmitting(true);
    window.sessionStorage.setItem(PAYMENT_FLOW_RESET_KEY, "1");
    setStatusMessage("Hubinaya station-ka iyo battery-ga...");
    setPaymentNotice({
      tone: "info",
      title: "Hubinaya station-ka",
      message: "Waxaan hubinaynaa in station-ku online yahay iyo in baytari diyaar ah jiro.",
    });

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
        setPaymentNotice({
          tone: "info",
          title: "Furaya Waafi",
          message: "Fadlan sug, waxaan kuu gudbineynaa bogga lacag bixinta.",
        });
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
      setPaymentNotice({
        tone: "error",
        title: "Lama sii wadi karo",
        message:
          error instanceof Error
            ? error.message
            : "Khalad dhacay, fadlan mar kale isku day",
      });
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

        <PayButton loading={isSubmitting} onClick={handlePay} />
      </section>

      {paymentNotice && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 px-5 backdrop-blur-sm">
          <div
            className={cn(
              "w-full max-w-sm rounded-3xl border bg-white p-6 text-center shadow-2xl",
              paymentNotice.tone === "error"
                ? "border-red-100 shadow-red-900/15"
                : "border-emerald-100 shadow-emerald-900/15",
            )}
          >
            <div
              className={cn(
                "mx-auto flex h-14 w-14 items-center justify-center rounded-full text-2xl font-black",
                paymentNotice.tone === "error"
                  ? "bg-red-50 text-red-600"
                  : "bg-emerald-50 text-emerald-600",
              )}
            >
              {paymentNotice.tone === "error" ? "!" : (
                <span className="h-6 w-6 animate-spin rounded-full border-[3px] border-current border-t-transparent" />
              )}
            </div>
            <h2 className="mt-4 text-2xl font-black text-slate-900">
              {paymentNotice.title}
            </h2>
            <p className="mt-3 text-base font-semibold leading-7 text-slate-600">
              {paymentNotice.message}
            </p>
            {paymentNotice.tone === "error" && (
              <button
                type="button"
                onClick={() => setPaymentNotice(null)}
                className="mt-6 w-full rounded-2xl bg-gradient-to-r from-violet-500 to-emerald-400 px-5 py-3 text-base font-bold text-white shadow-lg"
              >
                Waan fahmay
              </button>
            )}
          </div>
        </div>
      )}

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
