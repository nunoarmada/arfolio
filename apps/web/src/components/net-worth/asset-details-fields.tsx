'use client';

import { useTranslations } from 'next-intl';
import { detailFieldsFor, type DetailField, type DetailValues } from '@/lib/asset-details-form';
import { cn } from '@/lib/cn';
import { useHouseholdFormat } from '../household-format';
import { Card, CardHeader } from '../ui/card';
import { Checkbox } from '../ui/checkbox';
import { Field, Input } from '../ui/field';
import { Select } from '../ui/select';
import { Textarea } from '../ui/textarea';
import { FormCard } from './form-parts';

/** The kind-specific details of an asset: selects for enums, numbers for areas, year and km. */
export function AssetDetailsFields({
  kind,
  values,
  errors,
  onChange,
}: {
  kind: string;
  values: DetailValues;
  /** Message per field key. */
  errors: Record<string, string>;
  onChange: (key: string, value: string) => void;
}) {
  const t = useTranslations('asset.details');
  const fields = detailFieldsFor(kind);
  if (fields.length === 0) return null;

  const labelOf = (field: DetailField) =>
    field.unit
      ? `${t(`field.${field.key}`)} (${t(`unit.${field.unit}`)})`
      : t(`field.${field.key}`);
  const hint = (field: DetailField) =>
    field.key === 'postalCode' || field.key === 'description' ? t(`hint.${field.key}`) : undefined;

  return (
    <FormCard legend={t('legend')} description={t('intro')}>
      <div className="grid grid-cols-1 items-start gap-4 sm:grid-cols-2">
        {fields.map((field) => {
          const value = values[field.key] ?? '';
          const name = `details.${field.key}`;
          const wide = field.wide && 'sm:col-span-2';
          if (field.type === 'boolean') {
            return (
              <Checkbox
                key={field.key}
                className={cn(wide)}
                name={name}
                label={labelOf(field)}
                checked={value === 'true'}
                onChange={(e) => onChange(field.key, e.target.checked ? 'true' : '')}
              />
            );
          }
          return (
            <Field
              key={field.key}
              className={cn(wide)}
              label={labelOf(field)}
              hint={hint(field)}
              error={errors[field.key]}
            >
              {(p) =>
                field.type === 'select' ? (
                  <Select
                    {...p}
                    name={name}
                    value={value}
                    onChange={(e) => onChange(field.key, e.target.value)}
                  >
                    <option value="">{t('noOption')}</option>
                    {field.options?.map((option) => (
                      <option key={option} value={option}>
                        {field.rawOptions ? option : t(`option.${field.key}.${option}`)}
                      </option>
                    ))}
                  </Select>
                ) : field.type === 'textarea' ? (
                  <Textarea
                    {...p}
                    name={name}
                    rows={3}
                    maxLength={field.maxLength}
                    value={value}
                    onChange={(e) => onChange(field.key, e.target.value)}
                  />
                ) : (
                  <Input
                    {...p}
                    name={name}
                    autoComplete="off"
                    maxLength={field.maxLength}
                    inputMode={
                      field.type === 'integer'
                        ? 'numeric'
                        : field.type === 'decimal'
                          ? 'decimal'
                          : undefined
                    }
                    className={cn(
                      (field.type === 'integer' || field.type === 'decimal') &&
                        'max-w-48 tabular-nums',
                    )}
                    value={value}
                    onChange={(e) => onChange(field.key, e.target.value)}
                  />
                )
              }
            </Field>
          );
        })}
      </div>
    </FormCard>
  );
}

/** The filled details of an asset as a compact list; nothing when none are filled. */
export function AssetDetailsSummary({
  kind,
  details,
}: {
  kind: string;
  details: Record<string, unknown>;
}) {
  const t = useTranslations('asset.details');
  const { locale } = useHouseholdFormat();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
  const rows = detailFieldsFor(kind).flatMap((field) => {
    const raw = details[field.key];
    if (raw === undefined || raw === null || raw === '' || raw === false) return [];
    let value: string;
    if (typeof raw === 'number') {
      const unit = field.unit ? `\u00a0${t(`unit.${field.unit}`)}` : '';
      value = `${field.type === 'integer' && !field.unit ? String(raw) : number.format(raw)}${unit}`;
    } else if (raw === true) value = t('yes');
    else if (field.type === 'select') {
      value = field.rawOptions ? String(raw) : t(`option.${field.key}.${String(raw)}`);
    } else value = String(raw);
    return [{ key: field.key, label: t(`field.${field.key}`), value }];
  });
  if (rows.length === 0) return null;
  return (
    <Card as="section" aria-labelledby="asset-details-title">
      <CardHeader title={t('summaryTitle')} titleId="asset-details-title" />
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
        {rows.map((row) => (
          <div key={row.key} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-words text-right font-medium">{row.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
