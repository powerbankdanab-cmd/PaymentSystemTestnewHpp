import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
} from "firebase-admin/firestore";

import { getDb } from "@/lib/server/firebase-admin";

export const PAYMENT_JOBS_COLLECTION = "payment_jobs";

export type PaymentJobStatus =
  | "started"
  | "blocked"
  | "reserved"
  | "hpp_pending"
  | "hpp_finalizing"
  | "hpp_cancelled"
  | "charged"
  | "ejecting"
  | "verified_ejected"
  | "reversed"
  | "needs_support"
  | "completed"
  | "failed";

export type PaymentJobRecord = {
  id: string;
  phoneNumber?: string;
  amount?: number;
  requestedStationCode?: string | null;
  imei?: string;
  stationCode?: string;
  provider?: string;
  batteryId?: string;
  slotId?: string;
  purchaseReferenceId?: string;
  hppOrderId?: string;
  hppUrl?: string;
  transactionId?: string;
  issuerTransactionId?: string | null;
  referenceId?: string | null;
  status?: PaymentJobStatus | string;
  stage?: string;
  createdAt?: Timestamp;
  updatedAt?: Timestamp;
  [key: string]: unknown;
};

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
  paymentMode,
}: {
  phoneNumber: string;
  amount: number;
  requestedStationCode?: string | null;
  paymentMode?: "direct" | "hpp";
}) {
  const now = Timestamp.now();
  const ref = getDb().collection(PAYMENT_JOBS_COLLECTION).doc();

  await ref.set(
    cleanRecord({
      phoneNumber,
      amount,
      requestedStationCode: requestedStationCode || null,
      paymentMode: paymentMode || "direct",
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

function paymentJobFromDoc(doc: DocumentSnapshot): PaymentJobRecord | null {
  if (!doc.exists) {
    return null;
  }

  return {
    id: doc.id,
    ...(doc.data() || {}),
  } as PaymentJobRecord;
}

export async function getPaymentJob(
  jobId: string,
): Promise<PaymentJobRecord | null> {
  const doc = await getDb()
    .collection(PAYMENT_JOBS_COLLECTION)
    .doc(jobId)
    .get();

  return paymentJobFromDoc(doc);
}

export async function getPaymentJobByReferenceId(
  referenceId: string,
): Promise<PaymentJobRecord | null> {
  const snapshot = await getDb()
    .collection(PAYMENT_JOBS_COLLECTION)
    .where("purchaseReferenceId", "==", referenceId)
    .limit(1)
    .get();

  return snapshot.empty ? null : paymentJobFromDoc(snapshot.docs[0]);
}

const TERMINAL_STATUSES = new Set<string>([
  "blocked",
  "hpp_cancelled",
  "reversed",
  "completed",
  "failed",
]);

const FINALIZATION_IN_PROGRESS_STATUSES = new Set<string>([
  "hpp_finalizing",
  "charged",
  "ejecting",
  "verified_ejected",
]);

export async function beginPaymentJobFinalization(jobId: string) {
  const db = getDb();
  const ref = db.collection(PAYMENT_JOBS_COLLECTION).doc(jobId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const job = paymentJobFromDoc(snap);

    if (!job) {
      return { allowed: false, reason: "missing" as const, job: null };
    }

    const status = String(job.status || "");
    if (TERMINAL_STATUSES.has(status)) {
      return { allowed: false, reason: "terminal" as const, job };
    }

    if (FINALIZATION_IN_PROGRESS_STATUSES.has(status)) {
      const updatedAt = job.updatedAt;
      const ageMs =
        updatedAt instanceof Timestamp ? Date.now() - updatedAt.toMillis() : 0;
      if (ageMs < 10 * 60_000) {
        return { allowed: false, reason: "busy" as const, job };
      }
    }

    tx.set(
      ref,
      cleanRecord({
        status: "hpp_finalizing" satisfies PaymentJobStatus,
        stage: "hpp_finalizing",
        updatedAt: Timestamp.now(),
        events: FieldValue.arrayUnion(
          buildEvent(
            "hpp_finalizing",
            "HPP payment approved; finalizing eject and rental",
          ),
        ),
      }),
      { merge: true },
    );

    return {
      allowed: true,
      reason: "started" as const,
      job: {
        ...job,
        status: "hpp_finalizing" satisfies PaymentJobStatus,
        stage: "hpp_finalizing",
      },
    };
  });
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
