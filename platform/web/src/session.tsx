import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

/** The sign-in providers, in the order the Sign in page offers them (§13.1). */
export const PROVIDERS = ["google", "discord"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<Provider, string> = { google: "Google", discord: "Discord" };

/** What `GET /api/v1/me` answers for a signed-in user (`platform/src/api.ts`). */
export interface Me {
  uuid: string;
  providers: Provider[];
}

export type SessionState =
  | { status: "loading" }
  | { status: "signed-out" }
  | { status: "signed-in"; me: Me }
  /** The service did not answer, or answered something other than 200 or 401. */
  | { status: "error" };

const SessionContext = createContext<SessionState | null>(null);

async function loadMe(): Promise<SessionState> {
  try {
    const res = await fetch("/api/v1/me", { headers: { Accept: "application/json" } });
    if (res.status === 401) return { status: "signed-out" };
    if (!res.ok) return { status: "error" };
    return { status: "signed-in", me: (await res.json()) as Me };
  } catch {
    return { status: "error" };
  }
}

/**
 * Who is signed in, asked of the service once per page load. The web session
 * is an httpOnly cookie, so the app cannot read it; it asks `/api/v1/me`.
 * Signing in and signing out are full page loads through `/auth/*`, so the
 * next page load asks again.
 */
export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void loadMe().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return <SessionContext.Provider value={state}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const state = useContext(SessionContext);
  if (state === null) throw new Error("useSession needs a SessionProvider above it");
  return state;
}
