"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

import { CheckIcon, CloseIcon } from "@/components/payment/Icons";
import { cn, mapBackendErrorMessage } from "@/components/payment/helpers";

export function PaymentResultPage() {
  const searchParams = useSearchParams();
  const [result, setResult] = useState({
    status: searchParams.get("status") || "failed",
    message: searchParams.get("message") || "",
    battery: searchParams.get("battery") || "",
    slot: searchParams.get("slot") || "",
    station: searchParams.get("station") || "",
  });
  const jobId = searchParams.get("jobId") || "";
  const referenceId = searchParams.get("referenceId") || "";

  const isSuccess = result.status === "success";
  const isPending = result.status === "pending";
  const friendlyMessage = useMemo(() => {
    if (isSuccess) {
      return "Lacag bixinta way guuleysatay, power bank-gana wuu soo baxay. Fadlan qaado.";
    }

    if (isPending) {
      return "Lacag bixinta waa la dhameystirayaa. Fadlan sug, natiijada ayaan hubinaynaa.";
    }

    return mapBackendErrorMessage(
      result.message || "Payment was not completed. Please try again.",
    );
  }, [isSuccess, isPending, result.message]);

  useEffect(() => {
    if (!isPending || (!jobId && !referenceId)) {
      return;
    }

    let cancelled = false;
    let attempts = 0;

    const checkStatus = async () => {
      attempts += 1;
      const params = new URLSearchParams();
      if (jobId) params.set("jobId", jobId);
      if (referenceId) params.set("referenceId", referenceId);

      try {
        const response = await fetch(`/api/waafi/hpp/status?${params.toString()}`, {
          cache: "no-store",
        });
        const data = await response.json().catch(() => ({}));

        if (cancelled) return;

        if (response.ok && data.success) {
          setResult({
            status: "success",
            message: "",
            battery: data.battery_id || "",
            slot: data.slot_id || "",
            station: data.stationCode || "",
          });
          return;
        }

        if (response.status !== 202 && attempts >= 3) {
          setResult((current) => ({
            ...current,
            status: "failed",
            message: data.error || "Payment was not completed. Please try again.",
          }));
        }
      } catch {
        if (!cancelled && attempts >= 5) {
          setResult((current) => ({
            ...current,
            status: "failed",
            message: "Payment status could not be checked. Please contact support.",
          }));
        }
      }
    };

    const interval = window.setInterval(checkStatus, 3000);
    checkStatus();

    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [isPending, jobId, referenceId]);

  return (
    <div
      className={cn(
        "relative min-h-screen overflow-hidden px-4 py-10",
        "bg-[radial-gradient(circle_at_top,#ede9fe,#f0ebff_35%,#f8f8ff)]",
      )}
    >
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute left-[-100px] top-[-80px] h-72 w-72 rounded-full bg-violet-400/20 blur-3xl" />
        <div className="absolute bottom-[-110px] right-[-70px] h-72 w-72 rounded-full bg-emerald-400/20 blur-3xl" />
      </div>

      <main className="relative mx-auto mt-12 w-full max-w-lg rounded-[28px] border border-white/60 bg-white/90 p-7 text-center text-slate-800 shadow-[0_25px_70px_rgba(94,46,140,.25)] backdrop-blur-md">
        <div
          className={cn(
            "mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full",
            isSuccess ? "bg-green-100" : isPending ? "bg-blue-100" : "bg-red-100",
          )}
        >
          {isSuccess ? (
            <CheckIcon className="h-9 w-9 text-green-600" />
          ) : isPending ? (
            <span className="h-8 w-8 animate-spin rounded-full border-[3px] border-blue-600 border-t-transparent" />
          ) : (
            <CloseIcon className="h-9 w-9 text-red-600" />
          )}
        </div>

        <h1
          className={cn(
            "text-3xl font-bold",
            isSuccess ? "text-green-700" : isPending ? "text-blue-700" : "text-red-700",
          )}
        >
          {isSuccess
            ? "Guul!"
            : isPending
              ? "Fadlan sug"
              : "Lacag bixinta ma dhicin"}
        </h1>
        <p
          className={cn(
            "mt-4 rounded-xl border p-4 text-sm leading-6",
            isSuccess
              ? "border-green-200 bg-green-50 text-green-700"
              : isPending
                ? "border-blue-200 bg-blue-50 text-blue-700"
              : "border-red-200 bg-red-50 text-red-700",
          )}
        >
          {friendlyMessage}
        </p>

        {isSuccess && (
          <div className="mt-5 grid grid-cols-2 gap-3 text-left text-sm">
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
                Battery
              </p>
              <p className="mt-1 font-mono font-bold text-emerald-900">
                {result.battery || "--"}
              </p>
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-600">
                Slot
              </p>
              <p className="mt-1 font-mono font-bold text-emerald-900">
                {result.slot || "--"}
              </p>
            </div>
            <div className="col-span-2 rounded-xl border border-violet-100 bg-violet-50 p-3 text-center font-semibold text-violet-700">
              Station {result.station || "--"}
            </div>
          </div>
        )}

        {!isPending && (
          <div className="mt-7">
          <Link
            href="/"
            className="inline-flex items-center justify-center rounded-xl bg-gradient-to-r from-violet-500 to-emerald-400 px-6 py-3 text-base font-bold text-white shadow-lg"
          >
            {isSuccess ? "Samee lacag-bixin kale" : "Dib u isku day"}
          </Link>
          </div>
        )}
      </main>
    </div>
  );
}
