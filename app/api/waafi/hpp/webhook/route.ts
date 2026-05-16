import { createHmac, timingSafeEqual } from "node:crypto";

import { FieldValue } from "firebase-admin/firestore";
import { NextRequest, NextResponse } from "next/server";

import {
  cancelHppPayment,
  completeHppPayment,
  isHttpError,
} from "@/lib/server/payment-service";
import { getOptionalEnv } from "@/lib/server/env";
import { getDb } from "@/lib/server/firebase-admin";

export const maxDuration = 300;

function normalizeSignature(value: string) {
  return value.trim().replace(/^sha256=/i, "");
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyWebhookSignature(rawBody: string, request: NextRequest) {
  const secret = getOptionalEnv("WAAFI_WEBHOOK_SECRET");
  if (!secret) {
    if (process.env.NODE_ENV === "production") {
      return false;
    }
    console.warn("WAAFI_WEBHOOK_SECRET is not set; accepting webhook in development.");
    return true;
  }

  const timestamp = request.headers.get("x-webhook-timestamp") || "";
  const eventId = request.headers.get("x-webhook-event-id") || "";
  const header = request.headers.get("x-webhook-signature") || "";

  if (!timestamp || !eventId || !header) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (
    !Number.isFinite(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > 300
  ) {
    return false;
  }

  const received = normalizeSignature(header);
  const signingString = `${timestamp}.${eventId}.${rawBody}`;
  const expectedHex = createHmac("sha256", secret)
    .update(signingString)
    .digest("hex");

  return safeEqual(received.toLowerCase(), expectedHex);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findStringByKeys(value: unknown, keys: string[], depth = 0): string | null {
  if (!isRecord(value) || depth > 5) {
    return null;
  }

  for (const key of keys) {
    const direct = value[key];
    if (typeof direct === "string" || typeof direct === "number") {
      const text = String(direct).trim();
      if (text) return text;
    }
  }

  for (const child of Object.values(value)) {
    const found = findStringByKeys(child, keys, depth + 1);
    if (found) return found;
  }

  return null;
}

async function claimWebhookEvent(eventId: string | null) {
  if (!eventId) {
    return true;
  }

  const db = getDb();
  const ref = db.collection("waafi_webhook_events").doc(eventId);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists) {
      return false;
    }

    tx.set(ref, {
      eventId,
      createdAt: FieldValue.serverTimestamp(),
    });
    return true;
  });
}

function isApprovedStatus(status: string | null) {
  return ["APPROVED", "SUCCESS", "PAID"].includes(String(status || "").toUpperCase());
}

function isClosedUnpaidStatus(status: string | null) {
  return ["FAILED", "DECLINED", "CANCELED", "CANCELLED", "EXPIRED", "TIMEOUT"].includes(
    String(status || "").toUpperCase(),
  );
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const event = findStringByKeys(payload, ["event"]);
  if (event === "webhook.test") {
    return NextResponse.json({ received: true, test: true });
  }

  if (!verifyWebhookSignature(rawBody, request)) {
    return NextResponse.json({ error: "Invalid webhook signature" }, { status: 401 });
  }

  const eventId = findStringByKeys(payload, [
    "event_id",
    "eventId",
    "id",
    "webhookId",
  ]);
  const claimed = await claimWebhookEvent(eventId);
  if (!claimed) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const referenceId = findStringByKeys(payload, [
    "referenceId",
    "reference_id",
    "merchantReferenceId",
  ]);
  const jobId = findStringByKeys(payload, ["jobId", "job_id"]);
  const status = findStringByKeys(payload, ["status", "state", "tranStatus"]);

  if (!referenceId && !jobId) {
    return NextResponse.json({ received: true, ignored: "missing_reference" });
  }

  try {
    if (isApprovedStatus(status)) {
      const result = await completeHppPayment({
        referenceId,
        jobId,
        source: "hpp_webhook",
      });
      return NextResponse.json({ received: true, completed: true, result });
    }

    if (isClosedUnpaidStatus(status)) {
      await cancelHppPayment({
        referenceId,
        jobId,
        reason: `Waafi HPP webhook closed without approval: ${status}`,
      });
      return NextResponse.json({ received: true, closed: true, status });
    }

    return NextResponse.json({ received: true, pending: true, status });
  } catch (error) {
    return NextResponse.json(
      {
        received: true,
        error:
          error instanceof Error
            ? error.message
            : "HPP webhook finalization failed",
      },
      { status: isHttpError(error) ? error.status : 500 },
    );
  }
}
