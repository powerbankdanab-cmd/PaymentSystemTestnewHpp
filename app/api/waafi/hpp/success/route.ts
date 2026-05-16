import { NextRequest, NextResponse } from "next/server";

import { getOptionalEnv } from "@/lib/server/env";
import { completeHppPayment, isHttpError } from "@/lib/server/payment-service";

export const maxDuration = 300;

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
  const forwardedProto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    request.nextUrl.protocol.replace(":", "") ||
    "https";
  const forwardedHost =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host") ||
    request.nextUrl.host;

  const publicOrigin = `${forwardedProto}://${forwardedHost}`.replace(/\/+$/, "");
  if (!/\/\/(?:localhost|127\.0\.0\.1)(?::|$)/i.test(publicOrigin)) {
    return publicOrigin;
  }

  const configured = getOptionalEnv("WAAFI_HPP_CALLBACK_BASE_URL");
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  return publicOrigin;
}

function resultRedirect(
  request: NextRequest,
  params: Record<string, string | null | undefined>,
) {
  const url = new URL("/payment/result", getPublicBaseUrl(request));
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return NextResponse.redirect(url);
}

async function handleReturn(request: NextRequest) {
  const params = await callbackParams(request);
  const referenceId = firstParam(params, [
    "referenceId",
    "reference_id",
    "merchantReferenceId",
  ]);
  const jobId = firstParam(params, ["jobId", "job_id"]);

  try {
    const result = await completeHppPayment({
      referenceId,
      jobId,
      source: "hpp_success_callback",
    });

    return resultRedirect(request, {
      status: "success",
      jobId: result.jobId,
      battery: result.battery_id,
      slot: result.slot_id,
      station: result.stationCode,
    });
  } catch (error) {
    return resultRedirect(request, {
      status: "failed",
      jobId,
      referenceId,
      message: error instanceof Error ? error.message : "Payment finalization failed",
      code: isHttpError(error) ? String(error.status) : "500",
    });
  }
}

export async function GET(request: NextRequest) {
  return handleReturn(request);
}

export async function POST(request: NextRequest) {
  return handleReturn(request);
}
