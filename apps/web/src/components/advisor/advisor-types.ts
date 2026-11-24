import type { AdvisorMessageView } from '@arfolio/services';

/** The advisor loads this many messages at once, and per "load earlier" page (see advisor-data). */
export const ADVISOR_PAGE_SIZE = 30;

export type ProposalStatus = 'pending' | 'applied' | 'dismissed' | 'stale';

/** The figures a proposed amount was judged against, in minor units of `currency`. */
export interface ProposalBasis {
  months: number;
  min: number;
  max: number;
  median: number;
  currency: string;
}

/** A change the advisor suggests, as the chat shows it (from a stored row or an SSE event). */
export interface ChatProposal {
  id: string;
  kind: string;
  /** The draft the model made: ids, decimal-string amounts, and the `reason` it gave. */
  payload: Record<string, unknown>;
  basis: ProposalBasis | null;
  status: ProposalStatus;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  origin: 'chat' | 'proactive';
  text: string;
  status: 'pending' | 'complete' | 'failed';
  createdAt: Date;
  proposals: ChatProposal[];
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'applied', 'dismissed', 'stale']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function toBasis(value: unknown): ProposalBasis | null {
  if (!isRecord(value)) return null;
  const { months, min, max, median, currency } = value;
  if (
    typeof months === 'number' &&
    typeof min === 'number' &&
    typeof max === 'number' &&
    typeof median === 'number' &&
    typeof currency === 'string'
  ) {
    return { months, min, max, median, currency };
  }
  return null;
}

/** Reads a stored proposal row or the JSON of an SSE `proposal` event; nothing in it is trusted. */
export function toChatProposal(row: {
  id: string;
  kind: string;
  payload: unknown;
  basis: unknown;
  status: string;
}): ChatProposal {
  return {
    id: row.id,
    kind: row.kind,
    payload: isRecord(row.payload) ? row.payload : {},
    basis: toBasis(row.basis),
    status: STATUSES.has(row.status) ? (row.status as ProposalStatus) : 'pending',
  };
}

export function toChatMessage(view: AdvisorMessageView): ChatMessage {
  return {
    id: view.id,
    role: view.role === 'user' ? 'user' : 'assistant',
    origin: view.origin === 'proactive' ? 'proactive' : 'chat',
    text: view.text,
    status:
      view.status === 'failed' || view.status === 'pending' ? view.status : ('complete' as const),
    createdAt: new Date(view.createdAt),
    proposals: view.proposals.map(toChatProposal),
  };
}

/** The reason the model gave for a proposal ("" when it gave none). */
export function proposalReason(proposal: ChatProposal): string {
  const reason = proposal.payload.reason;
  return typeof reason === 'string' ? reason : '';
}
