import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router";

import { useSession } from "../session.js";
import { normalizeUserCode } from "../user-code.js";
import { APPROVE_DELAY_MS, useSteadyFocus } from "./Consent.js";

/** What oidc-provider's `/device` answers this page (`DeviceAnswer` in `platform/src/devices.ts`). */
type Answer = { step: "enter"; xsrf: string; error?: string } | { step: "confirm"; xsrf: string; user_code: string; client_name: string };

type Confirm = Extract<Answer, { step: "confirm" }>;

/** The words of each `?result=` the service sends the browser back with, and of each `error`. */
const RESULTS: Readonly<Record<string, string>> = {
  approved: "Approved. The bridge finishes on its own within a few seconds.",
  denied: "Denied. The bridge stops asking.",
  no_code: "Enter the code your bridge shows.",
  not_found: "No bridge is waiting with that code. Check it against the code your bridge shows.",
  expired: "That code has expired. Codes last 10 minutes: start again from your bridge.",
  used: "That code has already been used. Start again from your bridge.",
  rate_limited: "Too many codes did not match a bridge. Wait a few minutes, then try again.",
  failed: "The approval did not finish. Start again from your bridge.",
};

const INVALID_CODE = "A code is 8 letters, such as BCDF-GHJK.";
const NO_ANSWER = "Open Gamer MCP did not answer. Try again.";

type View =
  | { name: "enter"; message: string | null }
  | { name: "checking" }
  | { name: "confirm"; answer: Confirm }
  | { name: "done"; message: string }
  /** The service says the web session has ended. */
  | { name: "signed-out" };

/** Calls oidc-provider's `/device`: a GET for the `xsrf`, or a POST of `form`. */
async function callDevice(form?: Record<string, string>): Promise<Answer | "signed-out" | "failed"> {
  try {
    const headers = { Accept: "application/json" };
    const res = await fetch("/device", form === undefined ? { headers } : { method: "POST", headers, body: new URLSearchParams(form) });
    if (res.status === 401) return "signed-out";
    // Too many misses: the answer is the page's `error` for it.
    if (res.status === 429) return { step: "enter", xsrf: "", error: "rate_limited" };
    const body = (await res.json()) as Partial<Answer>;
    return body.step === "enter" || body.step === "confirm" ? (body as Answer) : "failed";
  } catch {
    return "failed";
  }
}

/** Looks up a code in the stored form. Nothing is approved yet. */
async function lookUp(code: string): Promise<View> {
  const start = await callDevice();
  if (start === "signed-out") return { name: "signed-out" };
  if (start === "failed") return { name: "enter", message: NO_ANSWER };
  const found = await callDevice({ xsrf: start.xsrf, user_code: code });
  if (found === "signed-out") return { name: "signed-out" };
  if (found === "failed") return { name: "enter", message: NO_ANSWER };
  if (found.step === "confirm") return { name: "confirm", answer: found };
  return { name: "enter", message: RESULTS[found.error ?? "failed"] ?? RESULTS["failed"] ?? null };
}

function signInPath(returnTo: string): string {
  return `/signin?return_to=${encodeURIComponent(returnTo)}`;
}

/**
 * The Device approval page (§8.1, §13.2), at `/device`. The bridge shows a
 * code and this page's address, and its link carries the code in
 * `?user_code=`. A signed-in user enters or follows the code; the page looks
 * it up and names what asks for access, shows the code to compare with the
 * bridge's, and warns to approve only a code started on the user's own
 * computer. A signed-out user goes to sign in and comes back here.
 *
 * Approve and Deny are a form post to oidc-provider's `/device`, which goes
 * through the OAuth interaction and sends the browser back here with
 * `?result=`. Approval creates the device. The bridge then finishes on its
 * own at its next poll.
 *
 * Layout adapted from `web/src/pages/Pair.tsx` in bttf/wow-guide@df80260.
 */
export function Device() {
  const session = useSession();
  const { pathname, search } = useLocation();
  switch (session.status) {
    case "loading":
      return <p>Loading…</p>;
    case "error":
      return (
        <>
          <h1>Approve a bridge</h1>
          <p role="alert">Open Gamer MCP did not answer. Reload the page to try again.</p>
        </>
      );
    case "signed-out":
      return <Navigate to={signInPath(`${pathname}${search}`)} replace />;
    case "signed-in":
      return <DeviceApproval />;
  }
}

function initialView(result: string | null, code: string): View {
  if (result === "approved" || result === "denied") return { name: "done", message: RESULTS[result] ?? "" };
  if (result !== null) return { name: "enter", message: RESULTS[result] ?? RESULTS["failed"] ?? null };
  return normalizeUserCode(code) === null ? { name: "enter", message: null } : { name: "checking" };
}

function DeviceApproval() {
  const [params] = useSearchParams();
  const { pathname, search } = useLocation();
  const [code, setCode] = useState(() => {
    const given = params.get("user_code") ?? "";
    return given.length > 32 ? "" : given;
  });
  const [view, setView] = useState<View>(() => initialView(params.get("result"), code));
  // The wait starts when the buttons appear.
  const approvable = useSteadyFocus(APPROVE_DELAY_MS, view.name === "confirm");
  const lookedUp = useRef(false);
  const submitted = useRef(false);

  async function check(input: string) {
    const normalized = normalizeUserCode(input);
    if (normalized === null) return setView({ name: "enter", message: INVALID_CODE });
    setView({ name: "checking" });
    setView(await lookUp(normalized));
  }

  // A link from the bridge carries its code: look it up at once, and once
  // only. Each lookup makes a new xsrf, which would fail a lookup under way.
  useEffect(() => {
    if (lookedUp.current || view.name !== "checking") return;
    lookedUp.current = true;
    void check(code);
  }, []);

  switch (view.name) {
    case "signed-out":
      return <Navigate to={signInPath(`${pathname}${search}`)} replace />;
    case "checking":
      return (
        <>
          <h1>Approve a bridge</h1>
          <p>Checking the code…</p>
        </>
      );
    case "done":
      return (
        <>
          <h1>Approve a bridge</h1>
          <p role="status">{view.message}</p>
        </>
      );
    case "confirm": {
      const { xsrf, user_code, client_name } = view.answer;
      return (
        <div className="og-device">
          <h1>Approve a bridge</h1>
          <p>
            <strong>
              <bdi>{client_name}</bdi>
            </strong>{" "}
            asks to send your game state to your Open Gamer MCP account.
          </p>
          <p className="og-device__code">
            <code>{user_code}</code>
          </p>
          <p>Check that this code matches the one your bridge shows.</p>
          <p className="og-device__warning">
            Approve only a code you started on your own computer. If someone sent you this code or a link to this page, deny it:
            approving lets their bridge send data to your account.
          </p>
          <form
            className="og-device__actions"
            method="post"
            action="/device"
            onSubmit={(event) => {
              // A second click would post again and find the code in use.
              if (submitted.current) event.preventDefault();
              submitted.current = true;
            }}
          >
            <input type="hidden" name="xsrf" value={xsrf} />
            <input type="hidden" name="user_code" value={user_code} />
            <button type="submit" className="og-button" name="confirm" value="yes" disabled={!approvable}>
              Approve
            </button>
            <button type="submit" className="og-button og-button--secondary" name="abort" value="yes">
              Deny
            </button>
          </form>
        </div>
      );
    }
    case "enter":
      return (
        <div className="og-device">
          <h1>Approve a bridge</h1>
          <p>Enter the code your bridge shows. Approve only a bridge you started yourself.</p>
          <form
            className="og-device__enter"
            onSubmit={(event) => {
              event.preventDefault();
              void check(code);
            }}
          >
            <label>
              Code
              <input
                name="user_code"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                placeholder="BCDF-GHJK"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={32}
                required
              />
            </label>
            <button type="submit" className="og-button">
              Continue
            </button>
          </form>
          {view.message !== null && <p role="alert">{view.message}</p>}
        </div>
      );
  }
}
