'use client';

import { useTranslations } from 'next-intl';
import type { ColumnMapping } from '@arfolio/services';
import type { FileInfoDto } from '@/server/actions/imports';
import { Checkbox } from '../ui/checkbox';
import { Field } from '../ui/field';
import { Select } from '../ui/select';

export type EditableMapping = Partial<ColumnMapping> & {
  headerRow: number;
  dateFormat: ColumnMapping['dateFormat'];
};

type ColumnKey =
  | 'dateColumn'
  | 'descriptionColumn'
  | 'amountColumn'
  | 'debitColumn'
  | 'creditColumn'
  | 'valueDateColumn'
  | 'counterpartyColumn'
  | 'externalIdColumn';

/** True once the mapping holds what the services need: date, description and an amount. */
export function isComplete(m: EditableMapping): m is ColumnMapping {
  return Boolean(
    m.dateColumn && m.descriptionColumn && (m.amountColumn || m.debitColumn || m.creditColumn),
  );
}

/**
 * One Select per target, each listing the file's columns with a sample value ("Coluna C · ex.:
 * 14-10-2026"). A switch turns the amount into debit + credit. No drag and drop.
 */
export function ColumnMapper({
  file,
  mapping,
  onChange,
}: {
  file: FileInfoDto;
  mapping: EditableMapping;
  onChange: (next: EditableMapping) => void;
}) {
  const t = useTranslations('import.columns');
  const twoColumns = Boolean(mapping.debitColumn || mapping.creditColumn) && !mapping.amountColumn;
  const [headerRowSample] = [file.samples[0] ?? []];

  const sample = (header: string): string => {
    const at = file.headers.indexOf(header);
    const value = at >= 0 ? (headerRowSample[at] ?? '') : '';
    return value ? ` · ${t('example', { value: value.slice(0, 30) })}` : '';
  };
  const set = (key: ColumnKey, value: string) => {
    const next: EditableMapping = { ...mapping };
    if (value === '') delete next[key];
    else next[key] = value;
    onChange(next);
  };
  const select = (key: ColumnKey, label: string, required: boolean) => (
    <Field label={required ? label : `${label} (${t('optional')})`}>
      {(p) => (
        <Select {...p} value={mapping[key] ?? ''} onChange={(e) => set(key, e.target.value)}>
          <option value="">{required ? t('choose') : t('none')}</option>
          {file.headers.map((h, i) =>
            h.trim() === '' ? null : (
              <option key={`${h}-${i}`} value={h}>
                {`${h}${sample(h)}`}
              </option>
            ),
          )}
        </Select>
      )}
    </Field>
  );

  function setTwoColumns(on: boolean) {
    const next: EditableMapping = { ...mapping };
    if (on) {
      delete next.amountColumn;
    } else {
      delete next.debitColumn;
      delete next.creditColumn;
    }
    onChange(next);
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {select('dateColumn', t('date'), true)}
      {select('descriptionColumn', t('description'), true)}
      <div className="md:col-span-2">
        <Checkbox
          label={t('twoColumns')}
          checked={twoColumns}
          onChange={(e) => setTwoColumns(e.target.checked)}
        />
      </div>
      {twoColumns ? (
        <>
          {select('debitColumn', t('debit'), true)}
          {select('creditColumn', t('credit'), true)}
        </>
      ) : (
        select('amountColumn', t('amount'), true)
      )}
      {select('valueDateColumn', t('valueDate'), false)}
      {select('counterpartyColumn', t('counterparty'), false)}
      {select('externalIdColumn', t('reference'), false)}
      <Field label={t('dateFormat')}>
        {(p) => (
          <Select
            {...p}
            value={mapping.dateFormat}
            onChange={(e) =>
              onChange({ ...mapping, dateFormat: e.target.value as ColumnMapping['dateFormat'] })
            }
          >
            {(['auto', 'DMY', 'MDY', 'YMD'] as const).map((f) => (
              <option key={f} value={f}>
                {t(`dateFormats.${f}`)}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label={t('decimal')}>
        {(p) => (
          <Select
            {...p}
            value={mapping.decimal ?? ''}
            onChange={(e) => {
              const next = { ...mapping };
              if (e.target.value === '') delete next.decimal;
              else next.decimal = e.target.value as ',' | '.';
              onChange(next);
            }}
          >
            <option value="">{t('decimalAuto')}</option>
            <option value=",">{t('decimalComma')}</option>
            <option value=".">{t('decimalDot')}</option>
          </Select>
        )}
      </Field>
    </div>
  );
}
