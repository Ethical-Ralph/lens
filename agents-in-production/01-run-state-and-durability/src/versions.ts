// Which version a resumed run uses (S1.5). A run keeps the version it started with while
// that version is still deployed; otherwise it moves only through an explicit migration.

export const Resolution = { Pinned: 'pinned', Migrate: 'migrate', Unknown: 'unknown' } as const;

export type VersionChoice =
  | { kind: typeof Resolution.Pinned; version: string }
  | { kind: typeof Resolution.Migrate; from: string; to: string }
  | { kind: typeof Resolution.Unknown; version: string };

export function chooseVersion(runVersion: string, deployed: string[], migrations: Record<string, string>): VersionChoice {
  if (deployed.includes(runVersion)) {
    return { kind: Resolution.Pinned, version: runVersion };
  }

  const target = migrations[runVersion];
  if (target && deployed.includes(target)) {
    return { kind: Resolution.Migrate, from: runVersion, to: target };
  }

  return { kind: Resolution.Unknown, version: runVersion };
}
