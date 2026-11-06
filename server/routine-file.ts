import type { RoutineHoldCause } from "../shared/routines.ts";
import type { EventRunReceipt } from "./routine-event-receipts.ts";
import type { RoutineOwnerNotice } from "./routine-recovery.ts";
import type { Routine, RoutineRequestReceipt, RoutineRun } from "./routines.ts";

export interface RoutineFile {
  version: 1;
  frozenResultsCleared?: true;
  routines: Routine[];
  runs: RoutineRun[];
  routineRequestReceipts?: RoutineRequestReceipt[];
  webhookRunReceipts?: EventRunReceipt[];
  startupLaunchId?: string;
  ownerNotices?: RoutineOwnerNotice[];
  holds?: RoutineHoldCause[];
}

export function assertRoutineFileWritable(readOnly: boolean | undefined, unreadable: boolean): void {
  if (readOnly) throw Object.assign(new Error("Saved routines are read-only in this runtime."), { status: 409 });
  if (unreadable) throw Object.assign(new Error("Saved routines could not be read. Repair routines.json before changing them."), { status: 503 });
}
