/**
 * Client-side copy of the upload ceiling (services enforce the real one; import-limits.test.ts
 * keeps the two equal). Kept here so client code never imports the services package.
 */
export const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
