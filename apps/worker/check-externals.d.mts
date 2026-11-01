export function undeclaredExternals(
  metafile: { outputs: Record<string, { imports: { path: string; external?: boolean }[] }> },
  pkgJson: { dependencies?: Record<string, string> },
): { pkg: string; importedBy: string }[];

export function mismatchedPins(
  workerPkg: { dependencies?: Record<string, string> },
  servicesPkg: { dependencies?: Record<string, string> },
): { pkg: string; worker: string; services: string }[];
