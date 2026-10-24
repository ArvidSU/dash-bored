export type ScreenCaptureCommand = "status" | "request" | "repair" | "open-settings";

export interface ScreenCaptureStatus {
  supported: boolean;
  granted: boolean;
  /** A reset succeeded; the user must relaunch before requesting permission again. */
  reset?: boolean;
}
