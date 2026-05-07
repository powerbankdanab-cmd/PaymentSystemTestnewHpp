import { FieldValue, Timestamp } from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";

export const PAYMENT_JOBS_COLLECTION = "payment_jobs";

type PaymentJobStatus =
  | "started"
  | "blocked"
  | "reserved"
  | "charged"
  | "ejecting"
  | "verified_ejected"
  | "reversed"
  | "needs_support"
  | "completed"
  | "failed";

type PaymentJobEvent = {
  stage: string;
  message: string;
  at: Timestamp;
  details?: Record<string, unknown>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function stripUndefined(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefined);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      cleaned[key] = stripUndefined(entry);
    }
  }
  return cleaned;
}

function cleanRecord(input: Record<string, unknown>): Record<string, unknown> {
  return stripUndefined(input) as Record<string, unknown>;
}

function buildEvent(
  stage: string,
  message: string,
  details?: Record<string, unknown>,
): PaymentJobEvent {
  const event: PaymentJobEvent = {
    stage,
    message,
    at: Timestamp.now(),
  };

  if (details) {
    event.details = cleanRecord(details);
  }

  return event;
}

export async function createPaymentJob({
  phoneNumber,
  amount,
  requestedStationCode,
}: {
  phoneNumber: string;
  amount: number;
  requestedStationCode?: string | null;
}) {
  const now = Timestamp.now();
  const ref = getDb().collection(PAYMENT_JOBS_COLLECTION).doc();

  await ref.set(
    cleanRecord({
      phoneNumber,
      amount,
      requestedStationCode: requestedStationCode || null,
      status: "started" satisfies PaymentJobStatus,
      stage: "started",
      createdAt: now,
      updatedAt: now,
      events: [
        buildEvent("started", "Payment request received", {
          requestedStationCode: requestedStationCode || null,
        }),
      ],
    }),
  );

  return ref.id;
}

export async function updatePaymentJob({
  jobId,
  status,
  stage,
  message,
  patch,
  details,
}: {
  jobId: string;
  status?: PaymentJobStatus;
  stage: string;
  message: string;
  patch?: Record<string, unknown>;
  details?: Record<string, unknown>;
}) {
  const update = cleanRecord({
    ...(patch || {}),
    ...(status ? { status } : {}),
    stage,
    updatedAt: Timestamp.now(),
    events: FieldValue.arrayUnion(buildEvent(stage, message, details)),
  });

  await getDb()
    .collection(PAYMENT_JOBS_COLLECTION)
    .doc(jobId)
    .set(update, { merge: true });
}
