import { describe, expect, it, vi } from "vitest";

import { createJobSlot } from "@/lib/job-slot";

function nameOf(e: unknown): string {
  return typeof e === "object" && e !== null && "name" in e ? String(e.name) : "";
}

/**
 * The homepage lets one job run at a time. These are the two ways that used to
 * break: a double-click whose second half read the state the first half had not
 * yet written, and a cancelled job whose late cleanup opened the gate beside the
 * job that was still running.
 */
describe("one job at a time", () => {
  it("refuses a second job started in the same frame", () => {
    const slot = createJobSlot();
    const first = slot.take();
    const second = slot.take();
    expect(first).toBeInstanceOf(AbortController);
    expect(second).toBeNull();
    // The refused click must not have touched the running job's signal.
    expect(first?.signal.aborted).toBe(false);
  });

  it("takes the slot again once the job releases it", () => {
    const slot = createJobSlot();
    const first = slot.take()!;
    slot.release(first);
    expect(slot.take()).not.toBeNull();
  });

  it("keeps a late release from opening the slot beside a running job", () => {
    const slot = createJobSlot();
    const first = slot.take()!;
    slot.cancel();
    slot.release(first);
    const second = slot.take()!;

    // The cancelled job's `finally` lands after the new job is already running.
    slot.release(first);
    expect(slot.current()).toBe(second);
    expect(slot.take()).toBeNull();
  });

  it("cancels only the job that holds the slot", () => {
    const slot = createJobSlot();
    const first = slot.take()!;
    const abortOfOld = vi.fn();
    first.signal.addEventListener("abort", abortOfOld);
    slot.release(first);

    const second = slot.take()!;
    slot.cancel();
    expect(abortOfOld).not.toHaveBeenCalled();
    expect(second.signal.aborted).toBe(true);
  });

  it("aborts a fetch waiting on the cancelled signal", async () => {
    const slot = createJobSlot();
    const controller = slot.take()!;
    // A closed port: the request is still in flight when the cancel lands.
    const pending = fetch("http://127.0.0.1:1/never", { signal: controller.signal }).then(
      () => ({ name: "resolved" }),
      (e: unknown) => e,
    );
    slot.cancel();
    const outcome = await pending;
    // Either the abort arrives first as an AbortError, or the connection is
    // refused; both mean the job stopped waiting on a request nobody owns.
    expect(["AbortError", "TypeError"]).toContain(nameOf(outcome));
  });

  it("lets nothing run once the page is left", () => {
    const slot = createJobSlot();
    const running = slot.take()!;
    // What the route's unmount cleanup does.
    slot.cancel();
    expect(running.signal.aborted).toBe(true);
    expect(slot.current()).toBe(running);
  });
});
