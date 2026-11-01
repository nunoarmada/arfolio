import {
  Apple,
  Baby,
  Banknote,
  Briefcase,
  Bus,
  Car,
  Coffee,
  Droplets,
  Dumbbell,
  Film,
  Fuel,
  Gift,
  GraduationCap,
  HeartPulse,
  House,
  Landmark,
  PiggyBank,
  Plane,
  Receipt,
  Scissors,
  Shield,
  ShoppingBag,
  ShoppingCart,
  Shirt,
  Smartphone,
  Tag,
  Ticket,
  TrendingUp,
  Utensils,
  Wallet,
  Wifi,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';

/** The curated set a category can use (stored by key in `category.icon`). */
export const CATEGORY_ICONS = {
  apple: Apple,
  baby: Baby,
  banknote: Banknote,
  briefcase: Briefcase,
  bus: Bus,
  car: Car,
  coffee: Coffee,
  droplets: Droplets,
  dumbbell: Dumbbell,
  film: Film,
  fuel: Fuel,
  gift: Gift,
  'graduation-cap': GraduationCap,
  'heart-pulse': HeartPulse,
  house: House,
  landmark: Landmark,
  'piggy-bank': PiggyBank,
  plane: Plane,
  receipt: Receipt,
  scissors: Scissors,
  shield: Shield,
  'shopping-bag': ShoppingBag,
  'shopping-cart': ShoppingCart,
  shirt: Shirt,
  smartphone: Smartphone,
  tag: Tag,
  ticket: Ticket,
  'trending-up': TrendingUp,
  utensils: Utensils,
  wallet: Wallet,
  wifi: Wifi,
  wrench: Wrench,
  zap: Zap,
} as const satisfies Record<string, LucideIcon>;

export type CategoryIconKey = keyof typeof CATEGORY_ICONS;
export const CATEGORY_ICON_KEYS = Object.keys(CATEGORY_ICONS) as CategoryIconKey[];

const isKey = (value: string): value is CategoryIconKey => value in CATEGORY_ICONS;

/** Template categories have no stored icon: they get one from their template key. */
const TEMPLATE_ICONS: Array<[prefix: string, icon: CategoryIconKey]> = [
  ['income.', 'banknote'],
  ['housing.utilities', 'zap'],
  ['housing.communications', 'wifi'],
  ['housing.insurance', 'shield'],
  ['housing.maintenance', 'wrench'],
  ['housing.', 'house'],
  ['food.groceries', 'shopping-cart'],
  ['food.', 'utensils'],
  ['transport.fuel', 'fuel'],
  ['transport.public', 'bus'],
  ['transport.', 'car'],
  ['kids.school', 'graduation-cap'],
  ['kids.', 'baby'],
  ['personal.health', 'heart-pulse'],
  ['personal.clothing', 'shirt'],
  ['personal.care', 'scissors'],
  ['personal.sports', 'dumbbell'],
  ['personal.education', 'graduation-cap'],
  ['obligations.', 'receipt'],
  ['leisure.travel', 'plane'],
  ['leisure.gifts', 'gift'],
  ['leisure.online_shopping', 'shopping-bag'],
  ['leisure.subscriptions', 'smartphone'],
  ['leisure.', 'ticket'],
  ['savings.investments', 'trending-up'],
  ['savings.', 'piggy-bank'],
];

export function iconKeyFor(category: {
  icon: string | null;
  templateKey: string | null;
}): CategoryIconKey {
  if (category.icon && isKey(category.icon)) return category.icon;
  const key = category.templateKey;
  if (key) {
    const hit = TEMPLATE_ICONS.find(([prefix]) => key.startsWith(prefix));
    if (hit) return hit[1];
  }
  return 'tag';
}

export function iconFor(category: { icon: string | null; templateKey: string | null }): LucideIcon {
  return CATEGORY_ICONS[iconKeyFor(category)];
}

/** The CSS colour of a group slot (1-7); transfers use the dedicated transfer colour. */
export function slotColor(slot: number, kind?: string): string {
  if (kind === 'transfer') return 'var(--transfer)';
  return `var(--chart-${((slot - 1) % 7) + 1})`;
}
