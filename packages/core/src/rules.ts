import { foldText as fold } from './fold';

export type RuleCondition = {
  descriptionContains?: string[];
  /** Wildcard text: `*` any sequence, `?` any one character, everything else literal. */
  descriptionPattern?: string;
  counterpartyContains?: string[];
  amountMin?: number;
  amountMax?: number;
  direction?: 'in' | 'out';
  accountIds?: string[];
};

export type Rule = {
  id: string;
  priority: number;
  enabled: boolean;
  condition: RuleCondition;
  categoryId: string;
};

export type RuleTransaction = {
  description: string;
  counterparty?: string | null;
  amount: number;
  accountId: string;
};

/** Any-of match; blank needles are ignored and an empty list does not constrain. */
function containsAny(haystack: string, needles: string[]): boolean {
  if (needles.length === 0) return true;
  return needles.some((n) => {
    const needle = fold(n);
    return needle !== '' && haystack.includes(needle);
  });
}

export const MAX_PATTERN_LENGTH = 200;
const MAX_MATCH_TEXT = 500;

export type WildcardPatternCheck = { ok: true } | { ok: false; reason: 'too_long' | 'empty' };

export function validateWildcardPattern(pattern: string): WildcardPatternCheck {
  if (pattern.length === 0) return { ok: false, reason: 'empty' };
  if (pattern.length > MAX_PATTERN_LENGTH) return { ok: false, reason: 'too_long' };
  return { ok: true };
}

/**
 * Whole-text wildcard match: `*` is any sequence, `?` any single character, all else literal.
 * Iterative two-pointer scan that backtracks only to the last `*`: O(text x pattern) worst case,
 * and no RegExp is ever built from user input.
 */
function wildcardMatch(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star >= 0) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p++;
  return p === pattern.length;
}

function patternMatches(pattern: string, text: string): boolean {
  // Empty or over-long user-supplied patterns simply never match.
  if (!validateWildcardPattern(pattern).ok) return false;
  return wildcardMatch(fold(pattern), text.slice(0, MAX_MATCH_TEXT));
}

function conditionMatches(c: RuleCondition, tx: RuleTransaction): boolean {
  const description = fold(tx.description);
  if (c.descriptionContains && !containsAny(description, c.descriptionContains)) return false;
  if (c.descriptionPattern !== undefined && !patternMatches(c.descriptionPattern, description)) {
    return false;
  }
  if (c.counterpartyContains && c.counterpartyContains.length > 0) {
    if (!tx.counterparty || !containsAny(fold(tx.counterparty), c.counterpartyContains)) {
      return false;
    }
  }
  if (c.amountMin !== undefined && tx.amount < c.amountMin) return false;
  if (c.amountMax !== undefined && tx.amount > c.amountMax) return false;
  if (c.direction === 'in' && !(tx.amount > 0)) return false;
  if (c.direction === 'out' && !(tx.amount < 0)) return false;
  if (c.accountIds && c.accountIds.length > 0 && !c.accountIds.includes(tx.accountId)) {
    return false;
  }
  return true;
}

/** First enabled matching rule by ascending priority, ties broken by id. */
export function matchRule(tx: RuleTransaction, rules: Rule[]): Rule | null {
  const ordered = rules
    .filter((r) => r.enabled)
    .sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return ordered.find((r) => conditionMatches(r.condition, tx)) ?? null;
}
