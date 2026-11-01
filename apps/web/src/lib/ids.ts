import { notFound } from 'next/navigation';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A malformed id in a URL cannot name anything: 404 instead of a database cast error. */
export function assertValidId(id: string): void {
  if (!UUID.test(id)) notFound();
}
