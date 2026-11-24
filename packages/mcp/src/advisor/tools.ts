import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { AdvisorLimits } from '@arfolio/core';
import {
  addNote,
  listGoals,
  NotFoundError,
  proposalDraftSchema,
  recentUserTexts,
  saveProposal,
  storedBasis,
  validateDraft,
  ValidationError,
  type ServiceCtx,
  type SpendingProfile,
  type TypicalSpend,
} from '@arfolio/services';
import { formatMoney } from '../money.js';
import type { AnyToolDef } from '../tools/define.js';
import { READ_TOOLS } from '../tools/registry.js';
import { searchTransactions, searchTransactionsTool } from '../tools/transactions.js';

/** What a tool call needs besides its arguments. */
export type AdvisorToolContext = {
  ctx: ServiceCtx;
  profile: SpendingProfile;
  /**
   * The member's latest messages. Informational: `propose_action` reads the window itself
   * (`recentUserTexts`, the same one `applyProposal` uses) so that both judge the same texts.
   */
  recentUserTexts: string[];
  /** The assistant message the turn is writing; proposals hang off it. */
  messageId: string;
  limits: AdvisorLimits;
};

export type AdvisorTool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  run(args: unknown, tc: AdvisorToolContext): Promise<unknown>;
};

/** Read tools never write, so they have nothing to audit. */
const noAudit = async (): Promise<void> => {};

const wrapRead = (def: AnyToolDef): AdvisorTool => ({
  name: def.name,
  description: def.description,
  inputSchema: def.input,
  run: async (args, { ctx }) => def.handler(def.input.parse(args), { ctx, audit: noAudit }),
});

/** Notes are hidden from the model, so they must not be searchable either (an oracle). */
const advisorSearchTransactions: AdvisorTool = {
  ...wrapRead(searchTransactionsTool),
  run: async (args, { ctx }) =>
    searchTransactions(ctx, searchTransactionsTool.input.parse(args), { searchNotes: false }),
};

const typicalOut = (t: TypicalSpend | null, currency: string) =>
  t && {
    median: formatMoney(t.median, currency),
    min: formatMoney(t.min, currency),
    max: formatMoney(t.max, currency),
    months: t.months,
    outlierMonths: t.outlierMonths,
  };

const getSpendingProfile: AdvisorTool = {
  name: 'get_spending_profile',
  description:
    'What a typical month looks like for this household: typical spending per category and per ' +
    'budget line (median, and the range once outlier months are left out), typical income, the ' +
    'monthly cost of recurring outflows, and whether the learning period is over. Amounts are ' +
    'decimal strings with a currency, plus `amount_minor`. Check it before proposing an amount.',
  inputSchema: z.strictObject({}),
  run: async (_args, { profile }) => {
    const c = profile.currency;
    return {
      learning: profile.learning,
      currency: c,
      window: profile.window,
      categories: profile.categories.map((x) => ({ ...x, typical: typicalOut(x.typical, c) })),
      income: typicalOut(profile.income, c),
      recurringMonthly: formatMoney(profile.recurringMonthly, c),
      budgetLines: profile.budgetLines.map((x) => ({ ...x, typical: typicalOut(x.typical, c) })),
    };
  },
};

const listGoalsTool: AdvisorTool = {
  name: 'list_goals',
  description:
    "The household's savings goals: target, target date, the monthly amount put aside, what is " +
    'saved so far and the progress in percent. Use the ids when proposing a goal update.',
  inputSchema: z.strictObject({}),
  run: async (_args, { ctx, profile }) => ({
    goals: (await listGoals(ctx)).map((g) => ({
      id: g.id,
      name: g.name,
      kind: g.kind,
      targetAmount: g.target === null ? null : formatMoney(g.target, profile.currency),
      targetDate: g.targetDate,
      monthlyContribution: formatMoney(g.contribution, profile.currency),
      saved: formatMoney(g.saved, profile.currency),
      progressPct:
        g.projection.progressBps === null ? null : Math.floor(g.projection.progressBps / 100),
    })),
  }),
};

const proposeAction: AdvisorTool = {
  name: 'propose_action',
  description:
    'Suggest one change for the member to review: a goal, a budget line amount, a categorisation ' +
    'rule or the category of a transaction. Nothing changes until the member applies it. The ' +
    'result is `{ proposal_id, status }`, or `{ refused: code }` when the suggestion does not fit ' +
    "the household's data: explain that to the member, and do not try again with another number. " +
    'Set `statedByMember` only when the member themselves said the amount.',
  inputSchema: z.strictObject({ draft: proposalDraftSchema }),
  run: async (args, tc) => {
    const parsed = z.strictObject({ draft: proposalDraftSchema }).safeParse(args);
    if (!parsed.success) return { refused: 'invalid' };
    const draft = parsed.data.draft;
    let verdict;
    try {
      verdict = await validateDraft(tc.ctx, draft, {
        profile: tc.profile,
        recentUserTexts: await recentUserTexts(tc.ctx, { limit: 10 }),
      });
    } catch (error) {
      if (error instanceof NotFoundError) return { refused: 'not_found' };
      throw error;
    }
    if (!verdict.ok) return { refused: verdict.code };
    const saved = await saveProposal(tc.ctx, {
      messageId: tc.messageId,
      kind: draft.kind,
      payload: draft,
      // Keeps the internal amounts snapshot that `applyProposal` compares against.
      basis: storedBasis(verdict),
      targetUpdatedAt: verdict.targetUpdatedAt,
    });
    return { proposal_id: saved.id, status: 'pending' };
  },
};

const saveNote: AdvisorTool = {
  name: 'save_note',
  description:
    'Remember a lasting preference or fact the member told you about their finances or how they ' +
    'want to be advised, in one short sentence. Do not save amounts from transactions, ' +
    'personal identifiers or anything the member did not say.',
  inputSchema: z.strictObject({ text: z.string().max(500) }),
  run: async (args, { ctx }) => {
    const { text } = z.strictObject({ text: z.string().max(500) }).parse(args);
    try {
      await addNote(ctx, text);
    } catch (error) {
      if (error instanceof ValidationError && error.code === 'note_limit') {
        return { refused: 'note_limit' };
      }
      throw error;
    }
    return { saved: true };
  },
};

/** The read tools, a spending profile, the goals, proposals and notes: nothing that writes household data. */
export function advisorTools(): AdvisorTool[] {
  return [
    ...READ_TOOLS.map((def) =>
      def.name === searchTransactionsTool.name ? advisorSearchTransactions : wrapRead(def),
    ),
    getSpendingProfile,
    listGoalsTool,
    proposeAction,
    saveNote,
  ];
}

/** The tools in the shape the Anthropic Messages API takes. */
export function toAnthropicTools(tools: AdvisorTool[]): Anthropic.Tool[] {
  return tools.map((tool) => {
    const schema: Record<string, unknown> = z.toJSONSchema(tool.inputSchema, { io: 'input' });
    delete schema.$schema;
    return {
      name: tool.name,
      description: tool.description,
      input_schema: { ...schema, type: 'object' as const },
    };
  });
}
