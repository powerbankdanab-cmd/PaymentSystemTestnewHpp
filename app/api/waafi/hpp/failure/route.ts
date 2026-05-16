import { NextRequest, NextResponse } from "next/server";

import { cancelHppPayment } from "@/lib/server/payment-service";

function firstParam(request: NextRequest, names: string[]) {
  for (const name of names) {
    const value = request.nextUrl.searchParams.get(name);
    if (value) {
      return value;
    }
  }

  return null;
}

export async function GET(request: NextRequest) {
  const referenceId = firstParam(request, [
    "referenceId",
    "reference_id",
    "merchantReferenceId",
  ]);
  const jobId = firstParam(request, ["jobId", "job_id"]);

  await cancelHppPayment({
    referenceId,
    jobId,
    reason: "Customer returned from Waafi HPP failure callback",
  });

  const url = new URL("/payment/result", request.url);
  url.searchParams.set("status", "failed");
  url.searchParams.set(
    "message",
    "Payment was not completed. Please try again.",
  );
  if (referenceId) url.searchParams.set("referenceId", referenceId);
  if (jobId) url.searchParams.set("jobId", jobId);

  return NextResponse.redirect(url);
}
