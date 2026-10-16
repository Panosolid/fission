// DRAFT: one machine library (I15): printers, lasers and CNC machines,
// shared by Slice, Laser and Manufacture, with one connection layer
// (WebSerial or network), one job queue and one job history.
//
// Only a person can send a job to a machine: sendJob takes a
// HumanConfirmation, which only the confirmation screen creates. Nothing
// automated (and never the AI assistant) can start, send to or control a
// physical machine.

export type MachineKind = "printer" | "laser" | "cnc";

export interface Machine {
  id: string;
  name: string;
  kind: MachineKind;
  /** Work area in mm. */
  workArea: [number, number, number];
  connection: { kind: "webserial" } | { kind: "network"; address: string } | { kind: "none" };
}

export interface Job {
  id: string;
  machine: string;
  /** What made it, e.g. a Slice plate or a Laser job, by id. */
  source: string;
  /** G-code or the machine's own format. */
  program: string;
  state: "prepared" | "queued" | "running" | "done" | "failed" | "cancelled";
}

/** Proof that a person pressed Send on the confirmation screen for this job. */
export interface HumanConfirmation {
  readonly jobId: string;
  readonly confirmedAt: Date;
  readonly __humanConfirmation: unique symbol;
}

export interface MachineLibrary {
  machines(): Machine[];
  add(machine: Machine): void;
  remove(id: string): void;
  /** Queued, running and finished jobs, newest first. */
  history(): Job[];
  /** Prepares a job; sending is a separate, human-confirmed step. */
  prepare(job: Omit<Job, "state">): Job;
  sendJob(jobId: string, confirmation: HumanConfirmation): Promise<void>;
}

/** The machine library for this browser. Not implemented yet. */
export function machineLibrary(): MachineLibrary {
  throw new Error("not implemented");
}
