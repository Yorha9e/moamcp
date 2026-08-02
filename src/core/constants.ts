/**
 * Core-wide constants shared by the infrastructure layer and the modules
 * built on top of it.
 */

/** Safety cap for one long-poll wait (25min), shared by debate turns and board waits. */
export const DEFAULT_WAIT_CAP_MS = 25 * 60 * 1000;
