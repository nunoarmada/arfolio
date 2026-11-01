// The release version and commit of this build. Both are inlined by next.config.ts at build time
// (the root package.json version and the GIT_SHA build arg), so the literal property accesses
// below must stay as they are for Next to replace them.

export function appVersion(): string {
  return process.env.NEXT_PUBLIC_APP_VERSION || 'dev';
}

/** The build's commit, or undefined for a build made outside the release pipeline. */
export function appGitSha(): string | undefined {
  return process.env.NEXT_PUBLIC_GIT_SHA?.trim() || undefined;
}

/** "v<version> · <short sha>", with the sha only when known. */
export function appVersionLabel(version = appVersion(), sha = appGitSha()): string {
  const short = sha?.trim().slice(0, 7);
  return short ? `v${version} · ${short}` : `v${version}`;
}
