import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type ActionNotice } from "./app-utils";

export interface Notices {
  /** Name of the app-level operation in flight, for per-control pending state. */
  pending: string | null;
  error: string | null;
  notice: ActionNotice | null;
  setError(message: string | null): void;
  showNotice(message: string): void;
  dismissNotice(): void;
  /** Runs one named app-level operation, reporting its failure as the error. */
  perform(name: string, action: () => Promise<unknown>): Promise<void>;
}

/** App-level feedback: the one pending operation, its error, and a timed notice. */
export function useNotices(): Notices {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);
  const nextNoticeId = useRef(0);

  useEffect(() => {
    if (!notice) return;
    const noticeId = notice.id;
    const timeout = window.setTimeout(() => {
      setNotice((current) => current?.id === noticeId ? null : current);
    }, 5_000);
    return () => window.clearTimeout(timeout);
  }, [notice?.id]);

  const showNotice = useCallback((message: string): void => {
    nextNoticeId.current += 1;
    setNotice({ id: nextNoticeId.current, message });
  }, []);
  const dismissNotice = useCallback((): void => setNotice(null), []);

  const perform = useCallback(async (name: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(name);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setPending(null);
    }
  }, []);

  return { pending, error, notice, setError, showNotice, dismissNotice, perform };
}
