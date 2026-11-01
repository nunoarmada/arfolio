import { formatMoneyFor, type FormatMoney } from '@/lib/money-privacy';
import { readPrivacy } from '@/lib/privacy-cookie';

/** The money formatter for server components: same signature as `formatMoney`, masked when hidden. */
export async function getFormatMoney(): Promise<FormatMoney> {
  return formatMoneyFor(await readPrivacy());
}
