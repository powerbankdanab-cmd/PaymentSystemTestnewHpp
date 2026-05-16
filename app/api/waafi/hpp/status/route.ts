import { NextRequest, NextResponse } from "next/server";

import { completeHppPayment, isHttpError } from "@/lib/server/payment-service";

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  const referenceId =
    request.nextUrl.searchParams.get("referenceId") ||
    request.nextUrl.searchParams.get("reference_id");
  const jobId =
    request.nextUrl.searchParams.get("jobId") ||
    request.nextUrl.searchParams.get("job_id");

  if (!referenceId && !jobId) {
    return NextResponse.json(
      { error: "Missing referenceId or jobId" },
      { status: 400 },
    );
  }

  try {
    const result = await completeHppPayment({
      referenceId,
      jobId,
      source: "hpp_status_check",
    });

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to complete HPP payment",
      },
      { status: isHttpError(error) ? error.status : 500 },
    );
  }
}
