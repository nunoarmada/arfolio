/**
 * The budget import speaks in codes and parameters; this turns them into message keys (under
 * `budgetImport`) with the values to fill in. Anything it does not know becomes a generic
 * message: raw text from the file or the services never reaches the screen.
 */

export interface Described {
  key: string;
  values: Record<string, string | number>;
}

type Params = Readonly<Record<string, string | number>> | undefined;

const NAME_MAX = 40;

/** Names come from the user's file: keep them short and single-line wherever they are shown. */
export function truncateName(value: string | number | undefined, max = NAME_MAX): string {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : text;
}

const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();

/** The message key suffix for a section the importer names, else null (shown as is, truncated). */
export function sectionKey(section: string | number | undefined): string | null {
  switch (fold(String(section ?? ''))) {
    case 'receitas':
    case 'income':
      return 'income';
    case 'despesas':
    case 'expenses':
      return 'expense';
    case 'poupanca':
    case 'savings':
      return 'saving';
    case 'accounts':
      return 'accounts';
    case 'groups':
      return 'groups';
    case 'subscriptions':
      return 'subscriptions';
    case 'ativos':
    case 'assets':
      return 'assets';
    case 'creditos':
    case 'liabilities':
      return 'liabilities';
    case 'objetivos':
    case 'goals':
      return 'goals';
    default:
      return null;
  }
}

const num = (v: string | number | undefined): number =>
  typeof v === 'number' ? v : Number(v) || 0;

/** One warning of the preview. `money` formats minor units; `section` names a section. */
export function describeWarning(
  warning: { code: string; params: Params },
  money: (minor: number) => string,
  section: (value: string | number | undefined) => string,
): Described {
  const p = warning.params ?? {};
  switch (warning.code) {
    case 'total_mismatch':
      return {
        key: p.line === undefined ? 'warning.totalMismatchSection' : 'warning.totalMismatchLine',
        values: {
          section: section(p.section),
          line: truncateName(p.line),
          expected: money(num(p.expected)),
          found: money(num(p.found)),
        },
      };
    case 'month_header_mismatch':
      return { key: 'warning.monthHeaderMismatch', values: { section: section(p.section) } };
    case 'unknown_periodicity':
      return {
        key: 'warning.unknownPeriodicity',
        values: { name: truncateName(p.name), value: truncateName(p.value) },
      };
    case 'empty_section':
      return { key: 'warning.emptySection', values: { section: section(p.section) } };
    case 'duplicate_line_name':
      return {
        key: 'warning.duplicateLineName',
        values: { section: section(p.section), name: truncateName(p.name) },
      };
    case 'zero_value_subscription':
      return { key: 'warning.zeroValueSubscription', values: { count: num(p.count) } };
    case 'unknown_net_worth_type':
      return {
        key: 'warning.unknownNetWorthType',
        values: { name: truncateName(p.name), value: truncateName(p.value) },
      };
    case 'derived_target':
      return { key: 'warning.derivedTarget', values: { name: truncateName(p.name) } };
    case 'saved_ignored':
      return {
        key: 'warning.savedIgnored',
        values: { name: truncateName(p.name), amount: money(num(p.amount)) },
      };
    case 'saved_differs':
      return {
        key: 'warning.savedDiffers',
        values: {
          name: truncateName(p.name),
          sheet: money(num(p.sheet)),
          app: money(num(p.app)),
        },
      };
    case 'currency_mismatch':
      return { key: 'warning.currencyMismatch', values: { name: truncateName(p.name) } };
    case 'goal_unlinked':
      return { key: 'warning.goalUnlinked', values: { name: truncateName(p.name) } };
    default:
      return { key: 'warning.unknown', values: {} };
  }
}

/** A failed upload or commit: the validation code and parameters from the services. */
export function describeImportError(
  code: string | undefined,
  params: Params,
  section: (value: string | number | undefined) => string,
): Described {
  const p = params ?? {};
  switch (code) {
    case 'too_many_rows':
      return { key: 'error.tooManyRows', values: { section: section(p.section), max: num(p.max) } };
    case 'missing_sheet':
      return { key: 'error.missingSheet', values: { sheet: truncateName(p.sheet) } };
    case 'invalid_amount':
      return {
        key: 'error.invalidAmount',
        values: {
          sheet: truncateName(p.sheet),
          cell: truncateName(p.cell, 12),
          value: truncateName(p.value, 24),
        },
      };
    case 'negative_amount':
      return {
        key: 'error.negativeAmount',
        values: { sheet: truncateName(p.sheet), cell: truncateName(p.cell, 12) },
      };
    case 'invalid_config':
      return { key: 'error.invalidConfig', values: { cell: truncateName(p.cell, 12) } };
    case 'name_too_long':
      return {
        key: 'error.nameTooLong',
        values: { name: truncateName(p.name), max: num(p.max) },
      };
    case 'missing_section':
      return { key: 'error.missingSection', values: { section: section(p.section) } };
    case 'missing_columns':
      return {
        key: 'error.missingColumns',
        values: { sheet: truncateName(p.sheet), columns: truncateName(p.columns, 60) },
      };
    case 'duplicate_month':
      return {
        key: 'error.duplicateMonth',
        values: { sheet: truncateName(p.sheet), month: truncateName(p.month, 12) },
      };
    case 'emergency_fund_exists':
      return { key: 'error.emergencyFundExists', values: {} };
    case 'account_already_linked':
      return { key: 'error.accountAlreadyLinked', values: { name: truncateName(p.name) } };
    case 'no_visible_sheet':
      return { key: 'error.noVisibleSheet', values: {} };
    case 'unreadable_file':
      return { key: 'error.unreadableFile', values: {} };
    default:
      return { key: 'error.unreadable', values: {} };
  }
}
