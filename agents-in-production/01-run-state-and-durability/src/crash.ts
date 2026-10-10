// Named crash points for the recovery tests. In production CRASH_AT is unset and these do
// nothing; in a test, the worker kills itself at the named point, with no cleanup, exactly
// as a deploy or an out-of-memory kill would.

export const Phase = { AfterClaim: 'after-claim', AfterIntent: 'after-intent', AfterEffect: 'after-effect', AfterResult: 'after-result' } as const;
export type Phase = (typeof Phase)[keyof typeof Phase];

// "after-effect:tool:refund" fires at every refund; "after-effect:tool:refund#4" only at step 4.
export function crashLabel(phase: Phase, stepName?: string, seq?: number): string {
  const label = stepName ? `${phase}:${stepName}` : phase;
  return seq ? `${label}#${seq}` : label;
}

export function crashPoint(phase: Phase, stepName?: string, seq?: number): void {
  const target = process.env.CRASH_AT;
  if (target === crashLabel(phase, stepName) || target === crashLabel(phase, stepName, seq)) {
    process.kill(process.pid, 'SIGKILL');
  }
}
