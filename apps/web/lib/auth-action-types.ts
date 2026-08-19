/**
 * Types and constants for the auth server actions.
 *
 * Separate from `auth-actions.ts` because a `'use server'` module may only
 * export async functions — exporting a constant or a type from it is a build
 * error, and the failure surfaces late, during page-data collection.
 */
export interface ActionState {
  status: 'idle' | 'error' | 'success';
  message?: string;
  /** Field-level problems, keyed by field name. */
  fieldErrors?: Record<string, string[]>;
  requestId?: string;
}

export const IDLE: ActionState = { status: 'idle' };
