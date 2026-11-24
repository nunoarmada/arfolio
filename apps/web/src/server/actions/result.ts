import { notFound } from 'next/navigation';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
  type ValidationCode,
} from '@arfolio/services';
import { ForbiddenError as SessionForbiddenError, StaleSessionError } from '../session';

/**
 * Stable codes for service validation failures the UI explains in the user's language. Services
 * speak English; the web layer never forwards their text.
 */
export type ValidationReason =
  | 'unrecognised_layout'
  | 'file_too_large'
  | 'unsupported_type'
  | 'empty_file'
  | 'no_rows'
  | 'too_many_rows'
  | 'currency_mismatch'
  | 'account_archived'
  | 'already_undone'
  | 'column_missing'
  | 'invalid_file'
  | 'resave_spreadsheet'
  | 'protected_file'
  | 'template_protected'
  | 'group_not_empty'
  | 'already_transfer'
  | 'ai_unavailable'
  | 'confirmation_required'
  | 'rate_limited'
  | 'not_a_pdf'
  | 'pdf_no_rows'
  | 'pdf_too_long'
  | 'ai_unusable'
  | 'ai_timeout'
  | 'ai_unreachable'
  | 'pdf_rejected'
  | 'ai_key_rejected'
  | 'ai_busy'
  | 'ai_model_unavailable'
  | 'pdf_multiple_accounts'
  /** Set by the client when a request got no answer at all; no service message maps to it. */
  | 'connection_lost'
  | 'invalid_input';

const REASONS: Array<[RegExp, ValidationReason]> = [
  [/AI is not available for this household/, 'ai_unavailable'],
  [/confirmation is required/, 'confirmation_required'],
  [/Too many PDF statements/, 'rate_limited'],
  [/is not a PDF/, 'not_a_pdf'],
  [/No movements were found in this PDF/, 'pdf_no_rows'],
  [/too many movements/, 'pdf_too_long'],
  [/AI answer could not be used/, 'ai_unusable'],
  [/took too long to answer/, 'ai_timeout'],
  [/could not be reached/, 'ai_unreachable'],
  [/AI service could not read this PDF/, 'pdf_rejected'],
  [/AI service rejected the API key/, 'ai_key_rejected'],
  [/AI service is busy/, 'ai_busy'],
  [/AI service did not find the configured model or address/, 'ai_model_unavailable'],
  [/movements of more than one account/, 'pdf_multiple_accounts'],
  [/recognise the file layout/i, 'unrecognised_layout'],
  [/file is too large|too large when unpacked/i, 'file_too_large'],
  [/unsupported file type/i, 'unsupported_type'],
  [/file is empty|spreadsheet is empty/i, 'empty_file'],
  [/no rows to import/i, 'no_rows'],
  [/too many (rows|columns|cells)|too much text/i, 'too_many_rows'],
  [/statement is in .* but the account is in/i, 'currency_mismatch'],
  [/account is archived/i, 'account_archived'],
  [/already undone/i, 'already_undone'],
  [/column .* was not found|has no .* column|header row is beyond/i, 'column_missing'],
  [/password-protected/i, 'protected_file'],
  [/save it as \.xlsx|workbooks are not supported/i, 'resave_spreadsheet'],
  [/not a valid xlsx?\b|zip bomb|corrupt|unreadable|malformed|workbook has no/i, 'invalid_file'],
  [/template (groups|categories) cannot be deleted/i, 'template_protected'],
  [/still has categories/i, 'group_not_empty'],
  [/already part of a transfer/i, 'already_transfer'],
];

export function validationReason(message: string): ValidationReason {
  return REASONS.find(([pattern]) => pattern.test(message))?.[1] ?? 'invalid_input';
}

/** The services' own code for a validation failure, with the values the UI fills into its copy. */
export interface ValidationDetail {
  code: ValidationCode;
  params?: Record<string, string | number>;
}

export type ActionFailure =
  | { ok: false; code: 'forbidden' }
  | { ok: false; code: 'reauth' }
  | {
      ok: false;
      code: 'validation';
      reason: ValidationReason;
      fields: string[];
      /** Only when the service gave the failure a code (budgets, import, recurring items). */
      detail?: ValidationDetail;
    }
  | { ok: false; code: 'conflict'; conflict: ConflictError['code'] }
  | { ok: false; code: 'error' };
export type ActionResult<T = null> = { ok: true; data: T } | ActionFailure;

/** Redirects and 404s raised by guards are control flow, not failures: let Next handle them. */
function isControlFlow(error: unknown): boolean {
  return typeof (error as { digest?: unknown })?.digest === 'string';
}

/**
 * Runs a server action body and maps service errors: NotFound renders the 404 page, Forbidden
 * becomes a 403 result the client shows as a toast, a stale session asks for a new sign-in, Validation carries a reason code and the
 * names of the offending fields (plus the service's own code and parameters when it has one),
 * Conflict carries its code, anything else is logged and reported as a generic error.
 */
export async function run<T>(body: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { ok: true, data: await body() };
  } catch (error) {
    if (isControlFlow(error)) throw error;
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError || error instanceof SessionForbiddenError) {
      return { ok: false, code: 'forbidden' };
    }
    if (error instanceof StaleSessionError) return { ok: false, code: 'reauth' };
    if (error instanceof ValidationError) {
      const fields = [
        ...new Set(error.issues.map((i) => String(i.path[0] ?? '')).filter((f) => f !== '')),
      ];
      return {
        ok: false,
        code: 'validation',
        reason: validationReason(error.message),
        fields,
        ...(error.code
          ? {
              detail: {
                code: error.code,
                ...(error.params ? { params: { ...error.params } } : {}),
              },
            }
          : {}),
      };
    }
    if (error instanceof ConflictError)
      return { ok: false, code: 'conflict', conflict: error.code };
    // The type only: messages can carry provider text, URLs or fragments of credentials.
    console.error(`action failed: ${error instanceof Error ? error.name : 'unknown error'}`);
    return { ok: false, code: 'error' };
  }
}
