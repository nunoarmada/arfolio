import {
  FileUp,
  House,
  KeyRound,
  Palette,
  Plug,
  Settings2,
  ShieldCheck,
  Tags,
  Users,
  Wallet,
  WandSparkles,
  type LucideIcon,
} from 'lucide-react';

/** One icon per settings section, keyed by the section's name (so server data stays serialisable). */
export const SECTION_ICONS: Record<string, LucideIcon> = {
  household: House,
  budget: Wallet,
  categories: Tags,
  rules: WandSparkles,
  branding: Palette,
  members: Users,
  import: FileUp,
  integrations: Plug,
  services: KeyRound,
  preferences: Settings2,
  security: ShieldCheck,
};
