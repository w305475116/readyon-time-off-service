import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export enum HcmErrorCode {
  InvalidDimensions = 'HCM_INVALID_DIMENSIONS',
  InsufficientBalance = 'HCM_INSUFFICIENT_BALANCE',
  Unavailable = 'HCM_UNAVAILABLE',
  ValidationFailed = 'HCM_VALIDATION_FAILED',
  AmbiguousOutcome = 'HCM_AMBIGUOUS_OUTCOME'
}

export class HcmError extends Error {
  constructor(
    readonly code: HcmErrorCode,
    message: string,
    readonly ambiguous = false
  ) {
    super(message);
  }
}

export interface HcmBalance {
  employeeId: string;
  locationId: string;
  availableDays: number;
}

export interface HcmFileTimeOffRequest {
  requestId: string;
  employeeId: string;
  locationId: string;
  requestedDays: number;
}

export interface HcmFileTimeOffResponse {
  hcmReferenceId: string;
  availableDays?: number;
}

export type HcmFilingLookup =
  | {
      status: 'FILED';
      hcmReferenceId: string;
      availableDays?: number;
    }
  | {
      status: 'NOT_FOUND';
    }
  | {
      status: 'UNKNOWN';
    };

@Injectable()
export class HcmClient {
  private readonly baseUrl: string;

  constructor(config: ConfigService) {
    this.baseUrl = config.get<string>('HCM_BASE_URL', 'http://localhost:4001').replace(/\/$/, '');
  }

  async getBalance(employeeId: string, locationId: string): Promise<HcmBalance> {
    const url = new URL(`${this.baseUrl}/hcm/balances`);
    url.searchParams.set('employeeId', employeeId);
    url.searchParams.set('locationId', locationId);

    const response = await this.fetchWithHcmErrors(url, { method: 'GET' });
    const body = (await response.json()) as HcmBalance;
    this.assertValidBalance(body);
    return body;
  }

  async fileTimeOff(request: HcmFileTimeOffRequest): Promise<HcmFileTimeOffResponse> {
    const response = await this.fetchWithHcmErrors(`${this.baseUrl}/hcm/time-off-filings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': request.requestId
      },
      body: JSON.stringify(request)
    });

    const body = (await response.json()) as HcmFileTimeOffResponse;
    if (!body.hcmReferenceId) {
      throw new HcmError(HcmErrorCode.ValidationFailed, 'HCM response did not include a reference ID.');
    }
    return body;
  }

  async getFilingStatus(requestId: string): Promise<HcmFilingLookup> {
    const response = await this.fetchWithHcmErrors(`${this.baseUrl}/hcm/time-off-filings/${requestId}`, {
      method: 'GET'
    });

    const body = (await response.json()) as HcmFilingLookup;
    if (body.status !== 'FILED' && body.status !== 'NOT_FOUND' && body.status !== 'UNKNOWN') {
      throw new HcmError(HcmErrorCode.ValidationFailed, 'HCM returned an invalid filing status.');
    }
    return body;
  }

  private async fetchWithHcmErrors(input: string | URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await globalThis.fetch(input, init);
    } catch {
      throw new HcmError(HcmErrorCode.Unavailable, 'HCM is unavailable.');
    }

    if (response.ok) {
      return response;
    }

    if (response.status >= 500) {
      throw new HcmError(HcmErrorCode.Unavailable, 'HCM is unavailable.', true);
    }

    const errorBody = await this.safeJson(response);
    const code = this.toHcmErrorCode(errorBody.code);
    throw new HcmError(code, errorBody.message ?? 'HCM rejected the request.');
  }

  private async safeJson(response: Response): Promise<{ code?: string; message?: string }> {
    try {
      return (await response.json()) as { code?: string; message?: string };
    } catch {
      return {};
    }
  }

  private toHcmErrorCode(code: string | undefined): HcmErrorCode {
    switch (code) {
      case HcmErrorCode.InvalidDimensions:
        return HcmErrorCode.InvalidDimensions;
      case HcmErrorCode.InsufficientBalance:
        return HcmErrorCode.InsufficientBalance;
      default:
        return HcmErrorCode.ValidationFailed;
    }
  }

  private assertValidBalance(balance: HcmBalance): void {
    if (
      typeof balance.employeeId !== 'string' ||
      typeof balance.locationId !== 'string' ||
      typeof balance.availableDays !== 'number' ||
      Number.isNaN(balance.availableDays)
    ) {
      throw new HcmError(HcmErrorCode.ValidationFailed, 'HCM returned an invalid balance response.');
    }
  }
}
