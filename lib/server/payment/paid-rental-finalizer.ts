import { BatteryStateConflictError } from "@/lib/server/payment/battery-state";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { HttpError } from "@/lib/server/payment/errors";
import type { PowerbankProvider } from "@/lib/server/payment/powerbank-provider";
import {
  createRentalLog,
  isDuplicateTransaction,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import { notifyPaidButNotEjected } from "@/lib/server/payment/telegram";
import type {
  Battery,
  PaymentSuccessPayload,
  WaafiResponse,
} from "@/lib/server/payment/types";
import { updatePaymentJob } from "@/lib/server/payment/payment-jobs";

const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_RETRY_DELAY_MS = 5_000;
const EJECT_VERIFY_CHECKS = 4;
const EJECT_VERIFY_DELAY_MS = 2_000;

type BatteryPresence = "present" | "missing" | "unknown";

type RefundPaymentResult = {
  approved: boolean;
  response?: WaafiResponse;
  error?: unknown;
};

type FinalizePaidRentalInput = {
  jobId: string;
  phoneNumber: string;
  amount: number;
  imei: string;
  stationCode: string;
  battery: Battery;
  provider: PowerbankProvider;
  purchaseReferenceId: string;
  transactionId: string | null;
  issuerTransactionId: string | null;
  referenceId: string | null;
  waafiAudit?: Record<string, unknown>;
  waafiResponse: WaafiResponse;
  phoneAuthority?: string;
  refundPayment: (input: {
    transactionId: string | null;
    referenceId: string | null;
    amount: number;
    reason: string;
  }) => Promise<RefundPaymentResult>;
};

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function checkBatteryPresence(
  provider: PowerbankProvider,
  imei: string,
  batteryId: string,
  slotId: string,
): Promise<BatteryPresence> {
  try {
    const stationBatteries = await provider.queryStationBatteries(imei);
    const stillThere = stationBatteries.some(
      (battery) =>
        normalizeBatteryId(battery.battery_id) === normalizeBatteryId(batteryId) &&
        battery.slot_id === slotId,
    );

    return stillThere ? "present" : "missing";
  } catch (error) {
    console.warn(
      "Failed to recheck slot status after unlock attempt:",
      error instanceof Error ? error.message : error,
    );
    return "unknown";
  }
}

async function waitForBatteryEjection({
  provider,
  imei,
  batteryId,
  slotId,
}: {
  provider: PowerbankProvider;
  imei: string;
  batteryId: string;
  slotId: string;
}): Promise<BatteryPresence> {
  let lastPresence: BatteryPresence = "unknown";

  for (let check = 1; check <= EJECT_VERIFY_CHECKS; check++) {
    await delay(EJECT_VERIFY_DELAY_MS);
    lastPresence = await checkBatteryPresence(provider, imei, batteryId, slotId);

    if (lastPresence === "missing") {
      return "missing";
    }
  }

  return lastPresence;
}

export async function finalizePaidRental({
  jobId,
  phoneNumber,
  amount,
  imei,
  stationCode,
  battery,
  provider,
  purchaseReferenceId,
  transactionId,
  issuerTransactionId,
  referenceId,
  waafiAudit,
  waafiResponse,
  phoneAuthority = "requested_phone_only",
  refundPayment,
}: FinalizePaidRentalInput): Promise<PaymentSuccessPayload> {
  if (!transactionId) {
    await updatePaymentJob({
      jobId,
      status: "needs_support",
      stage: "missing_transaction_id",
      message: "Waafi approved payment but did not return a transaction ID",
      patch: {
        waafiResponseCode: waafiResponse.responseCode
          ? String(waafiResponse.responseCode)
          : null,
        waafiResponseMsg: waafiResponse.responseMsg || null,
      },
    });
    throw new HttpError(
      502,
      "Payment was approved, but Waafi did not return a transaction ID. Please contact support.",
      { jobId },
    );
  }

  const duplicate = await isDuplicateTransaction(transactionId);
  if (duplicate) {
    await updatePaymentJob({
      jobId,
      status: "completed",
      stage: "duplicate_transaction",
      message: "Waafi transaction was already processed",
      patch: {
        transactionId,
        issuerTransactionId,
        referenceId: referenceId || purchaseReferenceId,
      },
    });
    return {
      success: true,
      jobId,
      battery_id: battery.battery_id,
      slot_id: battery.slot_id,
      provider: provider.name,
      stationCode,
      ejectVerified: provider.verifyEjection,
      unlock: null,
      waafiMessage: "Payment already processed",
      waafiResponse,
    };
  }

  await updatePaymentJob({
    jobId,
    status: "charged",
    stage: "payment_approved",
    message: "Waafi HPP payment approved",
    patch: {
      transactionId,
      issuerTransactionId,
      referenceId: referenceId || purchaseReferenceId,
      waafiResponseCode: waafiResponse.responseCode
        ? String(waafiResponse.responseCode)
        : null,
      waafiResponseMsg: waafiResponse.responseMsg || null,
      waafiState: waafiResponse.params?.status || waafiResponse.params?.state || null,
    },
  });

  let unlock: unknown = null;
  let unlockAttempts = 0;
  let lastUnlockError: unknown = null;
  let lastKnownPresence: BatteryPresence = "unknown";

  for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
    unlockAttempts = attempt;

    try {
      await updatePaymentJob({
        jobId,
        status: "ejecting",
        stage: "eject_attempt",
        message: `Sending ${provider.displayName} eject command`,
        details: {
          attempt,
          batteryId: battery.battery_id,
          slotId: battery.slot_id,
        },
      });

      unlock = await provider.releaseBattery({
        imei,
        batteryId: battery.battery_id,
        slotId: battery.slot_id,
      });

      if (!provider.verifyEjection) {
        await updatePaymentJob({
          jobId,
          status: "verified_ejected",
          stage: "eject_command_accepted",
          message: `${provider.displayName} accepted eject command`,
          patch: { unlockAttempts },
          details: {
            attempt,
            verification: "command_accepted",
          },
        });
        lastKnownPresence = "unknown";
        lastUnlockError = null;
        break;
      }

      await updatePaymentJob({
        jobId,
        status: "ejecting",
        stage: "eject_command_accepted",
        message: `${provider.displayName} accepted eject command; verifying cabinet state`,
        details: { attempt },
      });

      lastKnownPresence = await waitForBatteryEjection({
        provider,
        imei,
        batteryId: battery.battery_id,
        slotId: battery.slot_id,
      });

      if (lastKnownPresence === "missing") {
        await updatePaymentJob({
          jobId,
          status: "verified_ejected",
          stage: "eject_verified",
          message: "Battery is no longer present in the slot",
          patch: { unlockAttempts },
        });
        lastUnlockError = null;
        break;
      }

      lastUnlockError = new Error(
        lastKnownPresence === "present"
          ? "Battery remained present after eject command"
          : "Battery eject could not be verified after command",
      );

      if (attempt < MAX_UNLOCK_ATTEMPTS) {
        await updatePaymentJob({
          jobId,
          status: "ejecting",
          stage: "eject_retry_wait",
          message: "Battery did not verify as ejected; waiting before retry",
          details: {
            attempt,
            presence: lastKnownPresence,
          },
        });
        await delay(UNLOCK_RETRY_DELAY_MS);
      }
    } catch (unlockError) {
      lastUnlockError = unlockError;
      console.error(
        `Battery unlock failed on attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} for battery=${battery.battery_id} phone=${phoneNumber} txn=${transactionId}:`,
        errorMessage(unlockError),
      );

      lastKnownPresence = await checkBatteryPresence(
        provider,
        imei,
        battery.battery_id,
        battery.slot_id,
      );

      if (lastKnownPresence === "missing") {
        await updatePaymentJob({
          jobId,
          status: "verified_ejected",
          stage: "eject_verified_after_error",
          message: "Battery disappeared after an eject error, treating as ejected",
          patch: { unlockAttempts },
          details: {
            attempt,
            unlockError: errorMessage(unlockError),
          },
        });
        lastUnlockError = null;
        unlock = null;
        break;
      }

      if (attempt < MAX_UNLOCK_ATTEMPTS) {
        await updatePaymentJob({
          jobId,
          status: "ejecting",
          stage: "eject_retry_wait",
          message: "Eject command failed; waiting before retry",
          details: {
            attempt,
            presence: lastKnownPresence,
            unlockError: errorMessage(unlockError),
          },
        });
        await delay(UNLOCK_RETRY_DELAY_MS);
      }
    }
  }

  if (lastUnlockError) {
    if (lastKnownPresence !== "present") {
      lastKnownPresence = await checkBatteryPresence(
        provider,
        imei,
        battery.battery_id,
        battery.slot_id,
      );
    }

    if (lastKnownPresence === "missing") {
      await updatePaymentJob({
        jobId,
        status: "verified_ejected",
        stage: "eject_verified_after_final_check",
        message: "Battery disappeared on final verification check",
        patch: { unlockAttempts },
      });
      lastUnlockError = null;
      unlock = null;
    }
  }

  if (lastUnlockError) {
    const failureNote =
      lastKnownPresence === "present"
        ? `Unlock failed after ${unlockAttempts} attempts, battery still present`
        : `Unlock failed after ${unlockAttempts} attempts, slot status could not be rechecked`;

    if (lastKnownPresence === "present") {
      try {
        await provider.markProblemSlot(
          imei,
          battery.slot_id,
          battery.battery_id,
          failureNote,
        );
        await updatePaymentJob({
          jobId,
          status: "needs_support",
          stage: "problem_slot_marked",
          message: "Slot marked as problem after failed eject",
          patch: {
            failureNote,
            unlockAttempts,
            lastKnownPresence,
          },
        });
      } catch (recoveryError) {
        console.error(
          "Failed to mark problem slot after HPP paid-but-not-ejected case:",
          errorMessage(recoveryError),
        );
      }
    }

    let refundError: unknown = null;
    try {
      await updatePaymentJob({
        jobId,
        status: "needs_support",
        stage: "refund_requested",
        message: "Attempting Waafi HPP refund after failed eject",
        details: {
          transactionId,
          referenceId: referenceId || purchaseReferenceId,
          failureNote,
          lastKnownPresence,
        },
      });

      const refundResult = await refundPayment({
        transactionId,
        referenceId: referenceId || purchaseReferenceId,
        amount,
        reason: "Battery release failed, payment refunded",
      });

      if (!refundResult.approved) {
        refundError =
          refundResult.error ||
          new Error(
            refundResult.response?.responseMsg ||
              "Waafi HPP refund was not approved",
          );
      } else {
        await updatePaymentJob({
          jobId,
          status: "reversed",
          stage: "refund_approved",
          message: "Waafi HPP refund approved after failed eject",
          patch: {
            refundResponseCode: refundResult.response?.responseCode
              ? String(refundResult.response.responseCode)
              : null,
            refundResponseMsg: refundResult.response?.responseMsg || null,
            refundState:
              refundResult.response?.params?.status ||
              refundResult.response?.params?.state ||
              null,
          },
        });
      }
    } catch (error) {
      refundError = error;
    }

    if (refundError) {
      await updatePaymentJob({
        jobId,
        status: "needs_support",
        stage: "refund_failed",
        message: "Waafi HPP refund failed after paid-but-not-ejected case",
        patch: {
          failureNote,
          unlockAttempts,
          lastKnownPresence,
          refundError: errorMessage(refundError),
        },
      });

      await notifyPaidButNotEjected({
        phoneNumber,
        amount,
        imei,
        stationCode,
        batteryId: battery.battery_id,
        slotId: battery.slot_id,
        transactionId,
        issuerTransactionId,
        referenceId: referenceId || purchaseReferenceId,
        unlockAttempts,
        reason: `Battery release failed after HPP payment, and Waafi refund failed: ${errorMessage(refundError)}`,
      });

      throw new HttpError(
        502,
        "Battery could not be released after payment was charged. Please contact support.",
        {
          jobId,
          transactionId,
          batteryId: battery.battery_id,
          slotId: battery.slot_id,
          unlockAttempts,
        },
      );
    }

    throw new HttpError(
      502,
      "Battery could not be released. Payment refund was requested.",
      {
        jobId,
        transactionId,
        batteryId: battery.battery_id,
        slotId: battery.slot_id,
        unlockAttempts,
        waafiMsg: "Payment refunded after eject failure",
      },
    );
  }

  let rentalRef;
  try {
    rentalRef = await createRentalLog({
      imei,
      stationCode,
      batteryId: battery.battery_id,
      slotId: battery.slot_id,
      phoneNumber,
      requestedPhoneNumber: phoneNumber,
      amount,
      transactionId,
      issuerTransactionId,
      referenceId: referenceId || purchaseReferenceId,
      phoneAuthority,
      waafiAudit,
    });
    await updatePaymentJob({
      jobId,
      status: "completed",
      stage: "rental_created",
      message: "Rental record created after verified eject",
      patch: {
        rentalId: rentalRef.id,
        unlockAttempts,
      },
    });
  } catch (error) {
    if (error instanceof BatteryStateConflictError) {
      await updatePaymentJob({
        jobId,
        status: "needs_support",
        stage: "battery_state_conflict",
        message: "Payment charged and ejected, but battery state was already claimed",
        patch: {
          activeRentalId: error.activeRentalId,
          conflictBatteryId: error.batteryId,
          unlockAttempts,
        },
      });

      await notifyPaidButNotEjected({
        phoneNumber,
        amount,
        imei,
        stationCode,
        batteryId: battery.battery_id,
        slotId: battery.slot_id,
        transactionId,
        issuerTransactionId,
        referenceId: referenceId || purchaseReferenceId,
        unlockAttempts,
        reason: `Payment charged but battery already linked to active rental ${error.activeRentalId || "unknown"}`,
      });

      throw new HttpError(
        409,
        "Payment was confirmed, but this battery was already linked to another active rental. Please contact support.",
        {
          jobId,
          batteryId: error.batteryId,
          activeRentalId: error.activeRentalId,
          transactionId,
        },
      );
    }

    throw error;
  }

  await updateRentalUnlockStatus(rentalRef.id, "unlocked");
  await updatePaymentJob({
    jobId,
    status: "completed",
    stage: "completed",
    message: "Payment and verified eject completed",
    patch: {
      rentalId: rentalRef.id,
    },
  });

  return {
    success: true,
    jobId,
    battery_id: battery.battery_id,
    slot_id: battery.slot_id,
    provider: provider.name,
    stationCode,
    ejectVerified: provider.verifyEjection,
    unlock,
    waafiMessage:
      "Lacag bixinta way guuleysatay, power bank-gana wuu soo baxay. Fadlan qaado.",
    waafiResponse,
  };
}
