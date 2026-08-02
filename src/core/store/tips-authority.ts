/**
 * Core port for the Project Tips authority consumed by the Bus's Control
 * Plane routes (`/api/tips*`). Declared in core so the infrastructure layer
 * never imports the tips module; `TipStore` satisfies this interface
 * structurally and deliberately does not import it (one-way dependency).
 *
 * Payload types stay opaque (`unknown`) on purpose: the Tip schema
 * (ProjectTip, TipCreateInput, ...) lives in the tips module and must not
 * be duplicated in core. Only the five methods the Control Plane actually
 * calls are part of the seam — nothing more.
 */
export interface TipsAuthority {
  /** List tip summaries for an absolute workspace; options are module-defined filters. */
  list(options: unknown, workspace: string): Promise<readonly unknown[]>;
  /** Read one tip by id; resolves undefined when absent. */
  read(id: string, workspace: string): Promise<unknown>;
  /** Create a tip from module-defined input; resolves the stored tip. */
  create(input: unknown, workspace: string): Promise<unknown>;
  /** Apply a partial update; null clears optional fields, actor is audit attribution. */
  update(id: string, patch: unknown, workspace: string, actor?: string | null): Promise<unknown>;
  /** Archive a tip by id; actor is optional audit attribution. */
  archive(id: string, workspace: string, actor?: string | null): Promise<unknown>;
}
