import { ZodError } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@arfolio/services';
import { InvalidAmountError } from './money.js';

export type ToolErrorCode =
  | 'forbidden'
  | 'insufficient_scope'
  | 'not_found'
  | 'invalid_input'
  | 'conflict'
  | 'internal_error';

/** A failure the model can act on: a stable code and a short English message. */
export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ToolError';
  }
}

function classify(error: unknown): ToolError | null {
  if (error instanceof ToolError) return error;
  if (error instanceof ForbiddenError) return new ToolError('forbidden', error.message);
  if (error instanceof NotFoundError) return new ToolError('not_found', error.message);
  if (error instanceof ValidationError || error instanceof InvalidAmountError)
    return new ToolError('invalid_input', error.message);
  if (error instanceof ZodError) return new ToolError('invalid_input', 'Invalid input');
  if (error instanceof ConflictError) return new ToolError('conflict', error.message);
  return null;
}

/** A successful result: the data as `structuredContent` and as one JSON text block. */
export function ok(data: Record<string, unknown>): CallToolResult {
  return { structuredContent: data, content: [{ type: 'text', text: JSON.stringify(data) }] };
}

/**
 * A tool error (`isError`). Unexpected failures are logged by name only (never the message, which
 * may hold data or hosts) and reach the model as `internal_error`, with no stack.
 */
export function failure(tool: string, error: unknown): CallToolResult {
  const known = classify(error);
  if (!known) {
    console.error(
      `mcp tool ${tool} failed: ${error instanceof Error ? error.name : 'unknown error'}`,
    );
  }
  const body = known
    ? { code: known.code, message: known.message }
    : { code: 'internal_error', message: 'Something went wrong. Try again later.' };
  return {
    isError: true,
    structuredContent: { error: body },
    content: [{ type: 'text', text: JSON.stringify({ error: body }) }],
  };
}
