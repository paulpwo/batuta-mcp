import type { LiveClient } from "../live/index.js";

/** The part of the Remote Script client the tool layer uses (the real client satisfies it). */
export type LiveApi = Pick<LiveClient, "call" | "ready" | "welcome" | "status"> & {
  /** Keeps the connection alive during long work without calls; returns the function that ends the hold. */
  hold?: () => () => void;
};
