import { NextRequest, NextResponse } from "next/server";

import { completeHppPayment, isHttpError } from "@/lib/server/payment-service";

export const maxDuration = 300;

function firstParam(request: NextRequest, names: string[]) {
  for (const name of names) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) {
      return value;
    }
  }

  return null;
}

function resultRedirect(
  request: NextRequest,
  params: Record<string, string | null | undefined>,
) {
  const url = new URL("/payment/result", request.url);
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value);
    }
  }

  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest) {
  const referenceId = firstParam(request, [
    "referenceId",
    "reference_id",
    "merchantReferenceId",
  ]);
  const jobId = firstParam(request, ["jobId", "job_id"]);

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
