export type Battery = {
  battery_id: string;
  slot_id: string;
  lock_status: string;
  battery_capacity: string;
  battery_abnormal: string;
  cable_abnormal: string;
  battery_status?: string;
  slot_status?: string;
  battery_soh?: string;
};

export type WaafiParams = {
  accountNo?: string;
  accountType?: string;
  state?: string;
  merchantCharges?: string;
  transactionId?: string;
  issuerTransactionId?: string;
  referenceId?: string;
  txAmount?: string;
  amount?: string;
  tranAmount?: string;
  currency?: string;
  description?: string;
  payerId?: string;
  paymentMethod?: string;
  invoiceId?: string;
  tranDate?: string;
  tranStatusId?: string;
  status?: string;
  hppUrl?: string;
  directPaymentLink?: string;
  orderId?: string;
  hppRequestId?: string;
};

export type WaafiResponse = {
  schemaVersion?: string;
  timestamp?: string;
  responseId?: string;
  responseCode?: string | number;
  errorCode?: string;
  responseMsg?: string;
  params?: WaafiParams;
};

export type PaymentInput = {
  phoneNumber: string;
  amount: number;
  stationCode?: string;
  requestOrigin?: string;
};

export type PaymentSuccessPayload = {
  success: true;
  jobId: string;
  battery_id: string;
  slot_id: string;
  provider: string;
  stationCode: string;
  ejectVerified: boolean;
  unlock: unknown;
  waafiMessage: string;
  waafiResponse: WaafiResponse;
};

export type PaymentDuplicatePayload = {
  success: true;
  message: string;
  transactionId: string;
  jobId: string;
};

export type PaymentHppStartPayload = {
  success: false;
  hppRequired: true;
  redirectUrl: string;
  referenceId: string;
  jobId: string;
  stationCode: string;
  amount: number;
  battery_id: string;
  slot_id: string;
  provider: string;
  message: string;
};

export type PaymentPayload =
  | PaymentSuccessPayload
  | PaymentDuplicatePayload
  | PaymentHppStartPayload;
