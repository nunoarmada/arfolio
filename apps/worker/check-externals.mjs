import { builtinModules } from 'node:module';

/** Package name of a bare import specifier (`@scope/pkg/sub` -> `@scope/pkg`), or undefined for relative/absolute/builtin paths. */
function packageName(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('/')) return undefined;
  if (specifier.startsWith('node:')) return undefined;
  const parts = specifier.split('/');
  const name = specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
  return builtinModules.includes(name) ? undefined : name;
}

/**
 * Bare imports left external by the bundle that the app does not declare in `dependencies`.
 * `pnpm deploy --prod` only links direct dependencies, so each of these would be an
 * ERR_MODULE_NOT_FOUND at runtime. Returns `[{ pkg, importedBy }]`.
 */
export function undeclaredExternals(metafile, pkgJson) {
  const declared = new Set(Object.keys(pkgJson.dependencies ?? {}));
  const missing = new Map();
  for (const [file, output] of Object.entries(metafile.outputs)) {
    if (file.endsWith('.map')) continue;
    for (const imp of output.imports) {
      if (!imp.external) continue;
      const name = packageName(imp.path);
      if (name && !declared.has(name)) missing.set(name, file);
    }
  }
  return [...missing].map(([pkg, importedBy]) => ({ pkg, importedBy }));
}

/**
 * Dependencies that apps/worker and @arfolio/services both declare but pin differently. The bundle inlines
 * services code that was written against the services pin, so the worker must install the same version.
 * Returns `[{ pkg, worker, services }]`.
 */
export function mismatchedPins(workerPkg, servicesPkg) {
  const services = servicesPkg.dependencies ?? {};
  return Object.entries(workerPkg.dependencies ?? {})
    .filter(([pkg, version]) => pkg in services && services[pkg] !== version)
    .map(([pkg, version]) => ({ pkg, worker: version, services: services[pkg] }));
}
