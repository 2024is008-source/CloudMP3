/**
 * The one-job-per-page rule the homepage downloads run through.
 *
 * A React state flag cannot do this: two clicks in the same frame both read the
 * value from before either handler ran, so both start a job and the second
 * controller replaces the first in the ref — leaving a request in flight that
 * nothing can cancel. A ref read synchronously is what closes that window.
 */

export type JobSlot = {
  /** Take the slot, or return null when a job already holds it. */
  take: () => AbortController | null;
  /** Release it — but only when this controller is the one still holding it. */
  release: (controller: AbortController) => void;
  /** The controller a running job answers to, or null when nothing is running. */
  current: () => AbortController | null;
  /** Abort what is running now, and nothing that already finished. */
  cancel: () => void;
};

export function createJobSlot(): JobSlot {
  let controller: AbortController | null = null;

  return {
    take: () => {
      if (controller) return null;
      controller = new AbortController();
      return controller;
    },
    // A late `finally` from a job that was cancelled belongs to a controller
    // nobody is waiting on any more. Releasing the slot then would let a second
    // job start beside the one still running, so ownership decides.
    release: (owner) => {
      if (controller !== owner) return;
      controller = null;
    },
    current: () => controller,
    cancel: () => controller?.abort(),
  };
}
