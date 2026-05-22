export const EXIT_CODES = {
  OK: 0,
  USAGE_OR_CONFIG: 1,
  VERIFY_FAILED: 2,
  HALTED: 3,
  KILL_SWITCH_ACTIVE: 4,
  NOT_IMPLEMENTED: 5
} as const;

export type ExitCodeName = keyof typeof EXIT_CODES;
