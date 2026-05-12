import {
  acquirePhonePaymentLock,
  releaseReservation,
  releasePhonePaymentLock,
  reserveBattery,
} from "@/lib/server/payment/battery-lock";
import { BatteryStateConflictError } from "@/lib/server/payment/battery-state";
import { normalizeBatteryId } from "@/lib/server/payment/battery-id";
import { HttpError, isHttpError } from "@/lib/server/payment/errors";
import {
  getPowerbankProvider,
  MIN_AVAILABLE_BATTERY_PERCENT,
} from "@/lib/server/payment/powerbank-provider";
import type { PowerbankProvider } from "@/lib/server/payment/powerbank-provider";
import { isPhoneBlacklisted } from "@/lib/server/payment/blacklist";
import {
  createRentalLog,
  hasActiveRentalForPhone,
  isDuplicateTransaction,
  updateRentalUnlockStatus,
} from "@/lib/server/payment/rentals";
import { getActiveStationConfig } from "@/lib/server/payment/station";
import { getStationConfigByCode } from "@/lib/server/station-config";
import { notifyPaidButNotEjected } from "@/lib/server/payment/telegram";
import { Battery, PaymentInput, PaymentPayload } from "@/lib/server/payment/types";
import {
  createPaymentJob,
  updatePaymentJob,
} from "@/lib/server/payment/payment-jobs";
import {
  extractWaafiAudit,
  extractWaafiIds,
  isWaafiApproved,
  requestWaafiPurchase,
  reverseWaafiPurchase,
} from "@/lib/server/payment/waafi";

const MAX_UNLOCK_ATTEMPTS = 5;
const UNLOCK_RETRY_DELAY_MS = 5_000;
const EJECT_VERIFY_CHECKS = 4;
const EJECT_VERIFY_DELAY_MS = 2_000;

type BatteryPresence = "present" | "missing" | "unknown";

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

export async function processPayment(
  input: PaymentInput,
): Promise<PaymentPayload> {
  const phoneNumber = input.phoneNumber.replace(/\D/g, "");
  const { amount } = input;
  const requestedStationCode = String(input.stationCode || "").replace(/\D/g, "");
  const jobId = await createPaymentJob({
    phoneNumber,
    amount,
    requestedStationCode: requestedStationCode || null,
  });

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

    await updatePaymentJob({
      jobId,
      stage: "station_resolved",
      message: "Station resolved for payment request",
      patch: {
        imei,
        stationCode,
      },
      details: {
        requestedStationCode: requestedStationCode || null,
        provider: powerbankProvider.name,
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

    phoneLockAcquired = await acquirePhonePaymentLock(phoneNumber);
    if (!phoneLockAcquired) {
      throw new HttpError(
        409,
        "A payment for this phone is already being processed. Please wait a moment before trying again.",
      );
    }

    await updatePaymentJob({
      jobId,
      stage: "phone_locked",
      message: "Phone payment lock acquired",
    });

    const hasActiveRental = await hasActiveRentalForPhone(phoneNumber);
    if (hasActiveRental) {
      throw new HttpError(
        409,
        "You already have an active rental. Please return it before renting another battery.",
      );
    }

    // ── Atomic battery reservation ────────────────────────────────
    // Try up to 3 different batteries in case another user reserves
    // the first one between our query and our reservation attempt.
    const MAX_RESERVE_ATTEMPTS = 3;
    let battery: Battery | null = null;

    for (let attempt = 0; attempt < MAX_RESERVE_ATTEMPTS; attempt++) {
      const candidate = await powerbankProvider.getAvailableBattery(imei);
      if (!candidate) break;

      await updatePaymentJob({
        jobId,
        stage: "reserve_attempt",
        message: "Trying to reserve a candidate battery",
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
      );
      if (reserved) {
        const stillReady = await powerbankProvider.isSpecificBatteryReadyForRental({
          imei,
          batteryId: candidate.battery_id,
          slotId: candidate.slot_id,
        });

        if (!stillReady) {
          console.warn(
            `Reserve attempt ${attempt + 1}: battery ${candidate.battery_id} is no longer ready before payment, trying next`,
          );
          await releaseReservation(imei, candidate.battery_id);
          continue;
        }

        battery = candidate;
        reservedBatteryId = candidate.battery_id;
        await updatePaymentJob({
          jobId,
          status: "reserved",
          stage: "battery_reserved",
          message: "Battery reserved before charging customer",
          patch: {
            batteryId: candidate.battery_id,
            slotId: candidate.slot_id,
            batteryCapacity: candidate.battery_capacity,
          },
        });
        break;
      }
      console.warn(
        `Reserve attempt ${attempt + 1}: battery ${candidate.battery_id} already taken, trying next`,
      );
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

    // Charge first with Waafi purchase, then release the reserved battery.
    const purchaseReferenceId = `ref-${Date.now()}`;
    await updatePaymentJob({
      jobId,
      stage: "charging",
      message: "Sending Waafi purchase request",
      patch: {
        purchaseReferenceId,
      },
    });
    const purchaseResponse = await requestWaafiPurchase({
      phoneNumber,
      amount,
      referenceId: purchaseReferenceId,
    });

    if (!isWaafiApproved(purchaseResponse)) {
      await updatePaymentJob({
        jobId,
        status: "failed",
        stage: "payment_not_approved",
        message: "Waafi payment was not approved",
        patch: {
          waafiResponseCode: purchaseResponse.responseCode
            ? String(purchaseResponse.responseCode)
            : null,
          waafiResponseMsg: purchaseResponse.responseMsg || null,
          waafiState: purchaseResponse.params?.state || null,
        },
      });
      throw new HttpError(400, "Payment not approved", {
        waafiResponse: purchaseResponse,
        waafiMsg: purchaseResponse.responseMsg || "",
      });
    }

    const { transactionId, issuerTransactionId, referenceId } =
      extractWaafiIds(purchaseResponse);
    const waafiAudit = extractWaafiAudit(purchaseResponse);
    const waafiConfirmedPhoneNumber =
      typeof waafiAudit.waafiConfirmedPhoneNumber === "string" &&
      waafiAudit.waafiConfirmedPhoneNumber.trim().length > 0
        ? waafiAudit.waafiConfirmedPhoneNumber.trim()
        : null;
    // Keep the approved requested phone immutable for operations/calling.
    // Waafi account data stays in dedicated audit fields because it
    // may return a masked account string that is not safe to treat as the
    // main customer phone number.
    const canonicalPhoneNumber = phoneNumber;
    const phoneAuthority = waafiConfirmedPhoneNumber
      ? waafiConfirmedPhoneNumber === phoneNumber
        ? "waafi_confirmed_full_match"
        : "requested_phone_waafi_mismatch"
      : "requested_phone_only";

    if (!transactionId) {
      await updatePaymentJob({
        jobId,
        status: "needs_support",
        stage: "missing_transaction_id",
        message: "Waafi approved payment but did not return a transaction ID",
        patch: {
          waafiResponseCode: purchaseResponse.responseCode
            ? String(purchaseResponse.responseCode)
            : null,
          waafiResponseMsg: purchaseResponse.responseMsg || null,
        },
      });
      throw new HttpError(
        502,
        "Payment was approved, but Waafi did not return a transaction ID. Please try again.",
      );
    }

    if (transactionId) {
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
          message: "Payment already processed",
          transactionId,
          jobId,
        };
      }
    }

    await updatePaymentJob({
      jobId,
      status: "charged",
      stage: "payment_approved",
      message: "Waafi payment approved",
      patch: {
        transactionId,
        issuerTransactionId,
        referenceId: referenceId || purchaseReferenceId,
        waafiResponseCode: purchaseResponse.responseCode
          ? String(purchaseResponse.responseCode)
          : null,
        waafiResponseMsg: purchaseResponse.responseMsg || null,
        waafiState: purchaseResponse.params?.state || null,
      },
    });

    let unlock: unknown = null;
    let unlockAttempts = 0;
    let lastUnlockError: unknown = null;
    const currentBattery = battery;
    let lastKnownPresence: BatteryPresence = "unknown";

    for (let attempt = 1; attempt <= MAX_UNLOCK_ATTEMPTS; attempt++) {
      unlockAttempts = attempt;

      try {
        await updatePaymentJob({
          jobId,
          status: "ejecting",
          stage: "eject_attempt",
          message: `Sending ${powerbankProvider.displayName} eject command`,
          details: {
            attempt,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
          },
        });

        unlock = await powerbankProvider.releaseBattery({
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
        });

        if (!powerbankProvider.verifyEjection) {
          await updatePaymentJob({
            jobId,
            status: "verified_ejected",
            stage: "eject_command_accepted",
            message: `${powerbankProvider.displayName} accepted eject command`,
            patch: {
              unlockAttempts,
            },
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
          message: `${powerbankProvider.displayName} accepted eject command; verifying cabinet state`,
          details: {
            attempt,
          },
        });

        lastKnownPresence = await waitForBatteryEjection({
          provider: powerbankProvider,
          imei,
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
        });

        if (lastKnownPresence === "missing") {
          await updatePaymentJob({
            jobId,
            status: "verified_ejected",
            stage: "eject_verified",
            message: "Battery is no longer present in the slot",
            patch: {
              unlockAttempts,
            },
          });
          lastUnlockError = null;
          break;
        }

        lastUnlockError = new Error(
          lastKnownPresence === "present"
            ? "Battery remained present after eject command"
            : "Battery eject could not be verified after command",
        );

        console.error(
          `Battery eject not verified on attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} for battery=${currentBattery.battery_id} phone=${phoneNumber} txn=${transactionId}: ${errorMessage(lastUnlockError)}`,
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
          `Battery unlock failed on attempt ${attempt}/${MAX_UNLOCK_ATTEMPTS} for battery=${currentBattery.battery_id} phone=${phoneNumber} txn=${transactionId}:`,
          unlockError instanceof Error ? unlockError.message : unlockError,
        );

        lastKnownPresence = await checkBatteryPresence(
          powerbankProvider,
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
        );

        if (lastKnownPresence === "missing") {
          await updatePaymentJob({
            jobId,
            status: "verified_ejected",
            stage: "eject_verified_after_error",
            message: "Battery disappeared after an eject error, treating as ejected",
            patch: {
              unlockAttempts,
            },
            details: {
              attempt,
              unlockError: errorMessage(unlockError),
            },
          });
          console.error(
            `Battery ${currentBattery.battery_id} is no longer in slot ${currentBattery.slot_id} after unlock error — treating as successful eject`,
          );
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
          console.warn(
            `Battery ${currentBattery.battery_id} still not confirmed ejected after attempt ${attempt}; retrying in ${UNLOCK_RETRY_DELAY_MS}ms`,
          );
          await delay(UNLOCK_RETRY_DELAY_MS);
        }
      }
    }

    if (lastUnlockError) {
      if (lastKnownPresence !== "present") {
        lastKnownPresence = await checkBatteryPresence(
          powerbankProvider,
          imei,
          currentBattery.battery_id,
          currentBattery.slot_id,
        );
      }

      if (lastKnownPresence === "missing") {
        await updatePaymentJob({
          jobId,
          status: "verified_ejected",
          stage: "eject_verified_after_final_check",
          message: "Battery disappeared on final verification check",
          patch: {
            unlockAttempts,
          },
        });
        console.error(
          `Battery ${currentBattery.battery_id} not in slot ${currentBattery.slot_id} after unlock error — likely ejected successfully`,
        );
        lastUnlockError = null;
        unlock = null;
      }

      if (lastUnlockError) {
        const failureNote =
          lastKnownPresence === "present"
            ? `Unlock failed after ${unlockAttempts} attempts, battery still present`
            : `Unlock failed after ${unlockAttempts} attempts, slot status could not be rechecked`;

        if (lastKnownPresence === "present") {
          try {
            await powerbankProvider.markProblemSlot(
              imei,
              currentBattery.slot_id,
              currentBattery.battery_id,
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
              "Failed to mark problem slot after purchase reversal path:",
              recoveryError instanceof Error
                ? recoveryError.message
                : recoveryError,
            );
          }
        }

        let reversalError: unknown = null;

        try {
          await updatePaymentJob({
            jobId,
            status: "needs_support",
            stage: "reversal_requested",
            message: "Attempting Waafi reversal after failed eject",
            details: {
              transactionId,
              failureNote,
              lastKnownPresence,
            },
          });

          const reversalResponse = await reverseWaafiPurchase({
            transactionId,
            description: "Battery release failed, payment reversed",
          });

          if (!isWaafiApproved(reversalResponse)) {
            reversalError = new Error(
              reversalResponse.responseMsg || "Waafi reversal was not approved",
            );
          } else {
            await updatePaymentJob({
              jobId,
              status: "reversed",
              stage: "reversal_approved",
              message: "Waafi reversal approved after failed eject",
              patch: {
                reversalResponseCode: reversalResponse.responseCode
                  ? String(reversalResponse.responseCode)
                  : null,
                reversalResponseMsg: reversalResponse.responseMsg || null,
                reversalState: reversalResponse.params?.state || null,
              },
            });
          }
        } catch (error) {
          reversalError = error;
        }

        if (reversalError) {
          await updatePaymentJob({
            jobId,
            status: "needs_support",
            stage: "reversal_failed",
            message: "Waafi reversal failed after paid-but-not-ejected case",
            patch: {
              failureNote,
              unlockAttempts,
              lastKnownPresence,
              reversalError: errorMessage(reversalError),
            },
          });

          await notifyPaidButNotEjected({
            phoneNumber,
            amount,
            imei,
            stationCode,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            transactionId,
            issuerTransactionId,
            referenceId,
            unlockAttempts,
            reason: `Battery release failed after payment charge, and Waafi reversal failed: ${reversalError instanceof Error ? reversalError.message : String(reversalError)}`,
          });

          throw new HttpError(
            502,
            "Battery could not be released after payment was charged. Please contact support.",
            {
              jobId,
              transactionId,
              batteryId: currentBattery.battery_id,
              slotId: currentBattery.slot_id,
              unlockAttempts,
            },
          );
        }

        throw new HttpError(
          502,
          "Battery could not be released. Payment was reversed.",
          {
            jobId,
            transactionId,
            batteryId: currentBattery.battery_id,
            slotId: currentBattery.slot_id,
            unlockAttempts,
            waafiMsg: "Payment reversed after eject failure",
          },
        );
      }
    }

    let rentalRef;
    try {
      rentalRef = await createRentalLog({
        imei,
        stationCode,
        batteryId: currentBattery.battery_id,
        slotId: currentBattery.slot_id,
        phoneNumber: canonicalPhoneNumber,
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
          batteryId: currentBattery.battery_id,
          slotId: currentBattery.slot_id,
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

    await releaseReservation(imei, currentBattery.battery_id);
    reservedBatteryId = null;
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
      battery_id: currentBattery.battery_id,
      slot_id: currentBattery.slot_id,
      provider: powerbankProvider.name,
      stationCode,
      ejectVerified: powerbankProvider.verifyEjection,
      unlock,
      waafiMessage: "Lacag bixinta way guuleysatay, power bank-gana wuu soo baxay. Fadlan qaado.",
      waafiResponse: purchaseResponse,
    };
  } catch (error) {
    const httpDetails =
      isHttpError(error) && error.details && typeof error.details === "object"
        ? (error.details as Record<string, unknown>)
        : {};
    const paymentReversed =
      httpDetails.waafiMsg === "Payment reversed after eject failure";
    const paymentBlocked =
      isHttpError(error) &&
      error.status === 403 &&
      error.message.includes("blocked");

    await updatePaymentJob({
      jobId,
      status: paymentReversed
        ? "reversed"
        : paymentBlocked
          ? "blocked"
          : isHttpError(error) && error.status < 500
            ? "failed"
            : "needs_support",
      stage: paymentReversed ? "reversed" : paymentBlocked ? "blocked" : "failed",
      message: errorMessage(error),
      patch: {
        errorStatus: isHttpError(error) ? error.status : 500,
        errorMessage: errorMessage(error),
      },
    });

    if (isHttpError(error)) {
      throw new HttpError(
        error.status,
        error.message,
        mergeJobIdIntoDetails(error.details, jobId),
      );
    }

    throw error;
  } finally {
    if (reservedBatteryId) {
      await releaseReservation(imei, reservedBatteryId);
    }
    if (phoneLockAcquired) {
      await releasePhonePaymentLock(phoneNumber);
    }
  }
}
