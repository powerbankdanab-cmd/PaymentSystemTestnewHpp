import { Suspense } from "react";

import { PaymentResultPage } from "@/components/payment/PaymentResultPage";

export default function ResultPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-white" />}>
      <PaymentResultPage />
    </Suspense>
  );
}
