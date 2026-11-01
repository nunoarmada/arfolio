import {
  Banknote,
  Briefcase,
  CreditCard,
  Landmark,
  PiggyBank,
  Receipt,
  TrendingUp,
  Utensils,
  type LucideIcon,
} from 'lucide-react';

export const ACCOUNT_TYPES = [
  'checking',
  'savings',
  'card',
  'meal_benefit',
  'investment',
  'cash',
  'loan',
  'other',
] as const;

/** One glyph per account type, shared by the account form and the home mini-cards. */
export const TYPE_ICONS: Record<(typeof ACCOUNT_TYPES)[number], LucideIcon> = {
  checking: Landmark,
  savings: PiggyBank,
  card: CreditCard,
  meal_benefit: Utensils,
  investment: TrendingUp,
  cash: Banknote,
  loan: Receipt,
  other: Briefcase,
};
