import type { PlaidApiError } from '../types.ts';

let requestCounter = 0;
export function requestId(): string {
  requestCounter += 1;
  return `chaos-req-${requestCounter.toString(36)}`;
}

export function mutationDuringPagination(): PlaidApiError {
  return {
    error_type: 'TRANSACTIONS_ERROR',
    error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
    error_message:
      'Underlying transaction data changed since last page was fetched. Please restart pagination from last update.',
    display_message: null,
    status: 400,
    documentation_url: 'https://plaid.com/docs/errors/transactions/#transactions_sync_mutation_during_pagination',
    suggested_action: null,
    causes: [],
  };
}

export function itemLoginRequired(): PlaidApiError {
  return {
    error_type: 'ITEM_ERROR',
    error_code: 'ITEM_LOGIN_REQUIRED',
    error_message: "the login details of this item have changed (credentials, MFA, or required user action) and a user login is required to update this information. use Link's update mode to restore the item to a good state",
    display_message: null,
    status: 400,
    documentation_url: 'https://plaid.com/docs/errors/item/#item_login_required',
    suggested_action: null,
    causes: [],
  };
}

export function invalidCursor(): PlaidApiError {
  return {
    error_type: 'INVALID_REQUEST',
    error_code: 'INVALID_FIELD',
    error_message: 'cursor is not valid',
    display_message: null,
    status: 400,
    causes: [],
  };
}

export function invalidAccessToken(): PlaidApiError {
  return {
    error_type: 'INVALID_INPUT',
    error_code: 'INVALID_ACCESS_TOKEN',
    error_message: 'provided access token is in an invalid format. expected format: access-<environment>-<identifier>',
    display_message: null,
    status: 400,
    causes: [],
  };
}

/** Error thrown by the fake. Carries the Plaid error body. */
export class FakePlaidError extends Error {
  constructor(public readonly body: PlaidApiError) {
    super(`${body.error_code}: ${body.error_message}`);
    this.name = 'FakePlaidError';
  }
}

/**
 * Convert to the shape the classic axios-based SDK throws, so code written as
 * `err.response.data.error_code` behaves exactly as it would against Plaid.
 */
export function toAxiosStyleError(err: FakePlaidError): Error {
  return axiosStyleError(err.body);
}

export function axiosStyleError(body: PlaidApiError): Error {
  const e = new Error(`Request failed with status code ${body.status}`) as Error & Record<string, unknown>;
  e.isAxiosError = true;
  e.name = 'AxiosError';
  e.code = 'ERR_BAD_REQUEST';
  e.response = { status: body.status, statusText: 'Bad Request', data: body, headers: {} };
  return e;
}
