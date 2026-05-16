import {
  acquirePhonePaymentLock,
  releasePhonePaymentLock,
  releaseReservation,
  reserveBattery,
} from "@/lib/server/payment/battery-lock";
import { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
import { HttpError, isHttpError } from "@/lib/server/payment/errors";
import { finalizePaidRental } from "@/lib/server/payment/paid-rental-finalizer";
import {
  getPowerbankProvider,
  MIN_AVAILABLE_BATTERY_PERCENT,
} from "@/lib/server/payment/powerbank-provider";
import { getActiveStationConfig } from "@/lib/server/payment/station";
import {
  beginPaymentJobFinalization,
  createPaymentJob,
  getPaymentJob,
  getPaymentJobByReferenceId,
  type PaymentJobRecord,
  updatePaymentJob,
} from "@/lib/server/payment/payment-jobs";
import type {
  Battery,
  PaymentHppStartPayload,
  PaymentInput,
  PaymentSuccessPayload,
  WaafiResponse,
} from "@/lib/server/payment/types";
import { getStationConfigByCode } from "@/lib/server/station-config";
import {
  createWaafiHppReferenceId,
  extractWaafiAudit,
  extractWaafiHppIds,
  getWaafiHppTransactionInfo,
  isWaafiHppApproved,
  isWaafiHppRequestAccepted,
  isWaafiResponseSuccessful,
  mergeWaafiAuditRecords,
  refundWaafiHppPurchase,
  requestWaafiHppPurchase,
} from "@/lib/server/payment/waafi";

const DEFAULT_HPP_SESSION_TTL_MS = 15 * 60 * 1000;
const MIN_HPP_SESSION_TTL_MS = 2 * 60 * 1000;
const MAX_HPP_SESSION_TTL_MS = 30 * 60 * 1000;

function getHppSessionTtlMs() {
  const parsed = Number(process.env.WAAFI_HPP_SESSION_TTL_MS || "");
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_HPP_SESSION_TTL_MS;
  }

  return Math.min(MAX_HPP_SESSION_TTL_MS, Math.max(MIN_HPP_SESSION_TTL_MS, parsed));
}

function getHppCallbackBaseUrl(requestOrigin?: string) {
  const configured =
    process.env.WAAFI_HPP_CALLBACK_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.APP_URL ||
    requestOrigin;

  if (!configured) {
    throw new Error(
      "Missing WAAFI_HPP_CALLBACK_BASE_URL. Set it to your public payment domain before using Waafi HPP.",
    );
  }

  return configured.replace(/\/+$/, "");
}

function buildHppCallbackUrls({
  baseUrl,
  referenceId,
  jobId,
}: {
  baseUrl: string;
  referenceId: string;
  jobId: string;
}) {
  const params = new URLSearchParams({ referenceId, jobId });
  return {
    successCallbackUrl: `${baseUrl}/api/waafi/hpp/success?${params.toString()}`,
    failureCallbackUrl: `${baseUrl}/api/waafi/hpp/failure?${params.toString()}`,
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function mergeJobIdIntoDetails(details: unknown, jobId: string) {
  if (details && typeof details === "object" && !Array.isArray(details)) {
    return {
      ...(details as Record<string, unknown>),
      jobId,
    };
  }

  return { jobId };
}

function makeBatteryFromJob(job: PaymentJobRecord): Battery {
  return {
    battery_id: String(job.batteryId || ""),
    slot_id: String(job.slotId || ""),
    lock_status: "1",
    battery_capacity: String(job.batteryCapacity || "100"),
    battery_abnormal: "0",
    cable_abnormal: "0",
  };
}

function completedPayloadFromJob(job: PaymentJobRecord): PaymentSuccessPayload {
  return {
    success: true,
    jobId: job.id,
    battery_id: String(job.batteryId || ""),
    slot_id: String(job.slotId || ""),
    provider: String(job.provider || ""),
    stationCode: String(job.stationCode || ""),
    ejectVerified: Boolean(job.ejectVerified),
    unlock: null,
    waafiMessage:
      "Lacag bixinta way guuleysatay, power bank-gana wuu soo baxay. Fadlan qaado.",
    waafiResponse: {},
  };
}

function getHppStatus(response: WaafiResponse) {
  return String(response.params?.status || response.params?.state || "")
    .trim()
    .toUpperCase();
}

function isTerminalUnpaidHppStatus(status: string) {
  return ["FAILED", "DECLINED", "CANCELED", "CANCELLED", "EXPIRED", "TIMEOUT"].includes(
    status,
  );
}

async function releaseLocksForJob(job: PaymentJobRecord) {
  const imei = String(job.imei || "");
  const batteryId = String(job.batteryId || "");
  const phoneNumber = String(job.phoneNumber || "").replace(/\D/g, "");

  await Promise.allSettled([
    imei && batteryId ? releaseReservation(imei, batteryId) : Promise.resolve(),
    phoneNumber ? releasePhonePaymentLock(phoneNumber) : Promise.resolve(),
  ]);
}

async function markHppNotApproved({
  job,
  response,
  message,
}: {
  job: PaymentJobRecord;
  response?: WaafiResponse;
  message: string;
}) {
  await updatePaymentJob({
    jobId: job.id,
    status: "failed",
    stage: "hpp_not_approved",
    message,
    patch: {
      hppStatus: response ? getHppStatus(response) || null : null,
      waafiResponseCode: response?.responseCode
        ? String(response.responseCode)
        : null,
      waafiResponseMsg: response?.responseMsg || null,
    },
  });
  await releaseLocksForJob(job);
}

export async function startHppPayment(
  input: PaymentInput,
): Promise<PaymentHppStartPayload> {
  const phoneNumber = input.phoneNumber.replace(/\D/g, "");
  let amount = Number(input.amount);
  const requestedStationCode = String(input.stationCode || "").replace(/\D/g, "");
  const jobId = await createPaymentJob({
    phoneNumber,
    amount,
    requestedStationCode: requestedStationCode || null,
    paymentMode: "hpp",
  });

  const ttlMs = getHppSessionTtlMs();
  let phoneLockAcquired = false;
  let imei = "";
  let stationCode = "";
  let reservedBatteryId: string | null = null;

  try {
    const requestedStationConfig = requestedStationCode
      ? getStationConfigByCode(requestedStationCode)
      : null;
    if (requestedStationCode && !requestedStationConfig) {
      throw new HttpError(400, "Invalid station code");
    }

    const stationConfig = requestedStationConfig || (await getActiveStationConfig());
    if (!stationConfig.imei) {
      throw new HttpError(
        500,
        `Station ${stationConfig.code} hardware ID is not configured`,
      );
    }

    const powerbankProvider = getPowerbankProvider(stationConfig.provider);
    imei = stationConfig.imei;
    stationCode = stationConfig.code;

    if (
      Number.isFinite(stationConfig.rentalAmount) &&
      stationConfig.rentalAmount > 0 &&
      stationConfig.rentalAmount !== amount
    ) {
      const requestedAmount = amount;
      amount = stationConfig.rentalAmount;
      await updatePaymentJob({
        jobId,
        stage: "amount_normalized",
        message: "Station rental amount applied",
        patch: { amount, requestedAmount },
        details: {
          stationCode,
          provider: stationConfig.provider,
        },
      });
    }

    await updatePaymentJob({
      jobId,
      stage: "station_resolved",
      message: "Station resolved for HPP payment request",
      patch: {
        imei,
        stationCode,
        provider: powerbankProvider.name,
      },
      details: {
        requestedStationCode: requestedStationCode || null,
      },
    });

    const blacklisted = await isPhoneBlacklisted(phoneNumber);
    if (blacklisted) {
      await updatePaymentJob({
        jobId,
        status: "blocked",
        stage: "blacklisted",
        message: "Payment blocked because phone is blacklisted",
      });
      throw new HttpError(
        403,
        "You are blocked from renting. Please contact support.",
      );
    }

    phoneLockAcquired = await acquirePhonePaymentLock(phoneNumber, {
      ttlMs,
      jobId,
    });
    if (!phoneLockAcquired) {
      throw new HttpError(
        409,
        "A payment for this phone is already being processed. Please wait a moment before trying again.",
      );
    }

    await updatePaymentJob({
      jobId,
      stage: "phone_locked",
      message: "Phone payment lock acquired for HPP session",
      patch: { hppSessionTtlMs: ttlMs },
    });

    const MAX_RESERVE_ATTEMPTS = 3;
    let battery: Battery | null = null;

    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      const candidate = await powerbankProvider.getAvailableBattery(imei);
      if (!candidate) break;

      await updatePaymentJob({
        jobId,
        stage: "reserve_attempt",
        message: "Trying to reserve a candidate battery before HPP",
        details: {
          attempt: attempt + 1,
          batteryId: candidate.battery_id,
          slotId: candidate.slot_id,
          capacity: candidate.battery_capacity,
        },
      });

      const reserved = await reserveBattery(
        imei,
        candidate.battery_id,
        phoneNumber,
        { ttlMs, jobId },
      );

      if (!reserved) {
        continue;
      }

      const stillReady = await powerbankProvider.isSpecificBatteryReadyForRental({
        imei,
        batteryId: candidate.battery_id,
        slotId: candidate.slot_id,
      });

      if (!stillReady) {
        await releaseReservation(imei, candidate.battery_id);
        continue;
      }

      battery = candidate;
      reservedBatteryId = candidate.battery_id;
      await updatePaymentJob({
        jobId,
        status: "reserved",
        stage: "battery_reserved",
        message: "Battery reserved before HPP redirect",
        patch: {
          batteryId: candidate.battery_id,
          slotId: candidate.slot_id,
          batteryCapacity: candidate.battery_capacity,
        },
      });
      break;
    }

    if (!battery) {
      await updatePaymentJob({
        jobId,
        status: "failed",
        stage: "no_available_battery",
        message: "No rentable battery was available",
      });
      throw new HttpError(
        400,
        `No available battery ≥ ${MIN_AVAILABLE_BATTERY_PERCENT}%`,
      );
    }

    const purchaseReferenceId = createWaafiHppReferenceId();
    const callbackBaseUrl = getHppCallbackBaseUrl(input.requestOrigin);
    const { successCallbackUrl, failureCallbackUrl } = buildHppCallbackUrls({
      baseUrl: callbackBaseUrl,
      referenceId: purchaseReferenceId,
      jobId,
    });

    await updatePaymentJob({
      jobId,
      stage: "hpp_purchase_requested",
      message: "Creating Waafi Hosted Payment Page",
      patch: {
        purchaseReferenceId,
        hppSuccessCallbackUrl: successCallbackUrl,
        hppFailureCallbackUrl: failureCallbackUrl,
      },
    });

    const purchaseResponse = await requestWaafiHppPurchase({
      phoneNumber,
      amount,
      referenceId: purchaseReferenceId,
      successCallbackUrl,
      failureCallbackUrl,
      description: `Danab powerbank rental station ${stationCode}`,
    });

    if (!isWaafiHppRequestAccepted(purchaseResponse)) {
      await updatePaymentJob({
        jobId,
        status: "failed",
        stage: "hpp_purchase_rejected",
        message: "Waafi did not create the Hosted Payment Page",
        patch: {
          waafiResponseCode: purchaseResponse.responseCode
            ? String(purchaseResponse.responseCode)
            : null,
          waafiResponseMsg: purchaseResponse.responseMsg || null,
        },
      });
      throw new HttpError(502, "Waafi could not create payment page", {
        waafiResponse: purchaseResponse,
      });
    }

    const redirectUrl =
      purchaseResponse.params?.directPaymentLink || purchaseResponse.params?.hppUrl;
    if (!redirectUrl) {
      throw new HttpError(502, "Waafi HPP response did not include a payment URL");
    }

    await updatePaymentJob({
      jobId,
      status: "hpp_pending",
      stage: "hpp_redirect_ready",
      message: "Waafi Hosted Payment Page created; redirecting customer",
      patch: {
        purchaseReferenceId,
        referenceId: purchaseReferenceId,
        hppOrderId: purchaseResponse.params?.orderId || null,
        hppRequestId: purchaseResponse.params?.hppRequestId || null,
        hppUrl: purchaseResponse.params?.hppUrl || null,
        directPaymentLink: purchaseResponse.params?.directPaymentLink || null,
        hppExpiresAt: Date.now() + ttlMs,
      },
    });

    return {
      success: false,
      hppRequired: true,
      redirectUrl,
      referenceId: purchaseReferenceId,
      jobId,
      stationCode,
      amount,
      battery_id: battery.battery_id,
      slot_id: battery.slot_id,
      provider: powerbankProvider.name,
      message: "Redirecting to Waafi secure payment page",
    };
  } catch (error) {
    await updatePaymentJob({
      jobId,
      status:
        isHttpError(error) && error.status === 403
          ? "blocked"
          : isHttpError(error) && error.status < 500
            ? "failed"
            : "needs_support",
      stage: "failed",
      message: errorMessage(error),
      patch: {
        errorStatus: isHttpError(error) ? error.status : 500,
        errorMessage: errorMessage(error),
      },
    });

    if (reservedBatteryId) {
      await releaseReservation(imei, reservedBatteryId);
    }
    if (phoneLockAcquired) {
      await releasePhonePaymentLock(phoneNumber);
    }

    if (isHttpError(error)) {
      throw new HttpError(
        error.status,
        error.message,
        mergeJobIdIntoDetails(error.details, jobId),
      );
    }

    throw error;
  }
}

export async function completeHppPayment({
  referenceId,
  jobId,
  source,
}: {
  referenceId?: string | null;
  jobId?: string | null;
  source: string;
}): Promise<PaymentSuccessPayload> {
  const job =
    (jobId ? await getPaymentJob(jobId) : null) ||
    (referenceId ? await getPaymentJobByReferenceId(referenceId) : null);

  if (!job) {
    throw new HttpError(404, "Payment job was not found");
  }

  if (job.status === "completed") {
    return completedPayloadFromJob(job);
  }

  if (["failed", "blocked", "hpp_cancelled", "reversed"].includes(String(job.status))) {
    throw new HttpError(400, "Payment is already closed", { jobId: job.id });
  }

  const finalization = await beginPaymentJobFinalization(job.id);
  if (!finalization.allowed) {
    if (finalization.reason === "terminal" && finalization.job?.status === "completed") {
      return completedPayloadFromJob(finalization.job);
    }

    throw new HttpError(409, "Payment is already being finalized", {
      jobId: job.id,
      reason: finalization.reason,
    });
  }

  const activeJob = finalization.job || job;
  const resolvedReferenceId =
    referenceId || String(activeJob.purchaseReferenceId || activeJob.referenceId || "");

  if (!resolvedReferenceId) {
    throw new HttpError(400, "Missing HPP reference ID", { jobId: activeJob.id });
  }

  try {
    await updatePaymentJob({
      jobId: activeJob.id,
      status: "hpp_finalizing",
      stage: "hpp_status_check",
      message: "Checking Waafi HPP transaction status before eject",
      details: { source, referenceId: resolvedReferenceId },
    });

    const transactionInfo = await getWaafiHppTransactionInfo({
      referenceId: resolvedReferenceId,
    });
    const hppStatus = getHppStatus(transactionInfo);

    if (!isWaafiHppApproved(transactionInfo)) {
      await markHppNotApproved({
        job: activeJob,
        response: transactionInfo,
        message: isTerminalUnpaidHppStatus(hppStatus)
          ? `Waafi HPP ended without approval: ${hppStatus}`
          : "Waafi HPP payment is not approved yet",
      });
      throw new HttpError(
        isTerminalUnpaidHppStatus(hppStatus) ? 400 : 409,
        "Payment not approved",
        {
          jobId: activeJob.id,
          hppStatus,
          waafiResponse: transactionInfo,
        },
      );
    }

    const { transactionId, issuerTransactionId, invoiceId } =
      extractWaafiHppIds(transactionInfo);
    const finalReferenceId =
      transactionInfo.params?.referenceId || invoiceId || resolvedReferenceId;
    const phoneNumber = String(activeJob.phoneNumber || "").replace(/\D/g, "");
    const amount = Number(activeJob.amount || 0);
    const imei = String(activeJob.imei || "");
    const stationCode = String(activeJob.stationCode || "");
    const providerName = String(activeJob.provider || "heycharge");
    const provider = getPowerbankProvider(
      providerName === "appsphere" ? "appsphere" : "heycharge",
    );
    const battery = makeBatteryFromJob(activeJob);

    if (!phoneNumber || !amount || !imei || !stationCode || !battery.battery_id || !battery.slot_id) {
      throw new HttpError(500, "Payment job is missing required eject data", {
        jobId: activeJob.id,
      });
    }

    const stillReady = await provider.isSpecificBatteryReadyForRental({
      imei,
      batteryId: battery.battery_id,
      slotId: battery.slot_id,
    });

    if (!stillReady) {
      await updatePaymentJob({
        jobId: activeJob.id,
        status: "needs_support",
        stage: "reserved_battery_not_ready",
        message: "Reserved battery was no longer ready after HPP payment",
        patch: {
          batteryId: battery.battery_id,
          slotId: battery.slot_id,
        },
      });

      const refundResponse = await refundWaafiHppPurchase({
        referenceId: finalReferenceId,
        transactionId,
        amount,
        description: "Battery unavailable after HPP payment",
      });

      if (isWaafiResponseSuccessful(refundResponse)) {
        await updatePaymentJob({
          jobId: activeJob.id,
          status: "reversed",
          stage: "refund_approved",
          message: "Waafi HPP refund approved because battery was unavailable",
          patch: {
            refundResponseCode: refundResponse.responseCode
              ? String(refundResponse.responseCode)
              : null,
            refundResponseMsg: refundResponse.responseMsg || null,
          },
        });
      } else {
        await updatePaymentJob({
          jobId: activeJob.id,
          status: "needs_support",
          stage: "refund_failed",
          message: "Waafi HPP refund was not approved after battery became unavailable",
          patch: {
            refundResponseCode: refundResponse.responseCode
              ? String(refundResponse.responseCode)
              : null,
            refundResponseMsg: refundResponse.responseMsg || null,
          },
        });
        throw new HttpError(
          502,
          "Battery is no longer available and automatic refund was not approved. Please contact support.",
          { jobId: activeJob.id },
        );
      }

      throw new HttpError(
        409,
        "Battery is no longer available. Payment refund was requested.",
        { jobId: activeJob.id },
      );
    }

    const waafiAudit = mergeWaafiAuditRecords(extractWaafiAudit(transactionInfo), {
      paymentMode: "hpp",
      hppReferenceId: finalReferenceId,
      hppOrderId: activeJob.hppOrderId || null,
      hppStatus,
      hppPayerId: transactionInfo.params?.payerId || null,
      hppPaymentMethod: transactionInfo.params?.paymentMethod || null,
      hppTranStatusId: transactionInfo.params?.tranStatusId || null,
      hppTranDate: transactionInfo.params?.tranDate || null,
      hppInvoiceId: transactionInfo.params?.invoiceId || null,
    });

    return await finalizePaidRental({
      jobId: activeJob.id,
      phoneNumber,
      amount,
      imei,
      stationCode,
      battery,
      provider,
      purchaseReferenceId: resolvedReferenceId,
      transactionId,
      issuerTransactionId,
      referenceId: finalReferenceId,
      waafiAudit,
      waafiResponse: transactionInfo,
      refundPayment: async ({ transactionId: txId, referenceId: refId, amount: refundAmount, reason }) => {
        try {
          const response = await refundWaafiHppPurchase({
            transactionId: txId,
            referenceId: refId,
            amount: refundAmount,
            description: reason,
          });

          return {
            approved: isWaafiResponseSuccessful(response),
            response,
          };
        } catch (error) {
          return {
            approved: false,
            error,
          };
        }
      },
    });
  } finally {
    await releaseLocksForJob(activeJob);
  }
}

export async function cancelHppPayment({
  referenceId,
  jobId,
  reason,
}: {
  referenceId?: string | null;
  jobId?: string | null;
  reason: string;
}) {
  const job =
    (jobId ? await getPaymentJob(jobId) : null) ||
    (referenceId ? await getPaymentJobByReferenceId(referenceId) : null);

  if (!job) {
    return null;
  }

  if (!["completed", "reversed"].includes(String(job.status))) {
    await updatePaymentJob({
      jobId: job.id,
      status: "hpp_cancelled",
      stage: "hpp_cancelled",
      message: reason,
      patch: {
        hppCancelledAt: Date.now(),
      },
    });
    await releaseLocksForJob(job);
  }

  return job;
}
