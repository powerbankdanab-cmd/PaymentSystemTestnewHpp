import { NextRequest, NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/server/env";
import { cancelHppPayment } from "@/lib/server/payment-service";

function cleanParam(value: string | null) {
  return value?.trim().split(/[?&#]/)[0] || null;
}

async function callbackParams(request: NextRequest) {
  const params = new URLSearchParams(request.nextUrl.searchParams);

  if (request.method === "GET") {
    return params;
  }

  const contentType = request.headers.get("content-type") || "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      for (const [key, value] of Object.entries(body || {})) {
        if (typeof value === "string" || typeof value === "number") {
          params.set(key, String(value));
        }
      }
    } else if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          params.set(key, value);
        }
      }
    } else {
      const text = await request.text();
      if (text) {
        const bodyParams = new URLSearchParams(text);
        bodyParams.forEach((value, key) => params.set(key, value));
      }
    }
  } catch {
    // Waafi may return only query params; keep those if body parsing fails.
  }

  return params;
}

function firstParam(params: URLSearchParams, names: string[]) {
  for (const name of names) {
    const value = cleanParam(params.get(name));
    if (value) {
      return value;
    }
  }

  return null;
}

function getPublicBaseUrl(request: NextRequest) {
  const configured = getOptionalEnv("WAAFI_HPP_CALLBACK_BASE_URL");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  const forwardedProto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "") ||
    "https";
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    request.nextUrl.host;

  return `${forwardedProto}://${forwardedHost}`;
}

async function handleReturn(request: NextRequest) {
  const params = await callbackParams(request);
  const referenceId = firstParam(params, [
    "referenceId",
    "reference_id",
    "merchantReferenceId",
  ]);
  const jobId = firstParam(params, ["jobId", "job_id"]);

  await cancelHppPayment({
    referenceId,
    jobId,
    reason: "Customer returned from Waafi HPP failure callback",
  });

  const url = new URL("/payment/result", getPublicBaseUrl(request));
  url.searchParams.set("status", "failed");
  url.searchParams.set(
    "message",
    "Payment was not completed. Please try again.",
  );
  if (referenceId) url.searchParams.set("referenceId", referenceId);
  if (jobId) url.searchParams.set("jobId", jobId);

  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  return handleReturn(request);
}

export async function POST(request: NextRequest) {
  return handleReturn(request);
}
