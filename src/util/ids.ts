import { randomUUID } from "node:crypto";

export function engagementId(): string {
  return `ENG-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function eventId(): string {
  return `EVT-${randomUUID().slice(0, 8).toUpperCase()}`;
}

export function decisionId(n: number): string {
  return `DEC-${String(n).padStart(4, "0")}`;
}

export function deliveryId(n: number): string {
  return `DEL-${String(n).padStart(3, "0")}`;
}

export function evidenceId(n: number): string {
  return `EVD-${String(n).padStart(4, "0")}`;
}

export function approvalId(n: number): string {
  return `APR-${String(n).padStart(4, "0")}`;
}

export function handoffId(n: number): string {
  return `HND-${String(n).padStart(4, "0")}`;
}

/**
 * A decision identifier.
 *
 * Unguessable on purpose: it names a judgement document on disk, so a
 * sequence would let one decision overwrite another's audit record. It is
 * deliberately distinct from the engagement's sequential `DEC-` identifier.
 */
export function judgementId(): string {
  return `JDG-${randomUUID().slice(0, 8).toUpperCase()}`;
}
