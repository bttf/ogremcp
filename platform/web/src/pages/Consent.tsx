import { useEffect, useState } from "react";
import { useParams } from "react-router";

/** What `GET /interaction/:uid/details` answers (`platform/src/oidc.ts`), in the fields this page reads. */
export interface ConsentDetails {
  prompt: { name: string };
  client_name: string | null;
  redirect_host: string | null;
  /** The requested scopes that approval grants. */
  scopes: string[];
}

/**
 * Plain words for each scope, keyed by the scope's name (§9). Agents ask for
 * `read`. Bridges ask for `ingest` and are approved on `/device`, so it
 * appears here only if a client asks for it. `openid` and `offline_access`
 * are oidc-provider's own. A scope without words here is shown by its name.
 */
const SCOPE_WORDS: Readonly<Record<string, string>> = {
  read: "Read your game state and search game info",
  ingest: "Send your game state to Open Gamer MCP",
  openid: "See your Open Gamer MCP account ID",
  offline_access: "Stay connected until you revoke access",
};

const EXPIRED = "This authorization request has expired or is not valid. Start again from your agent.";

type Loaded =
  | { status: "ready"; details: ConsentDetails }
  | { status: "expired" }
  | { status: "error" }
  /** The service handles this interaction's other steps, such as sign-in. */
  | { status: "leaving"; to: string };

function interactionPath(uid: string): string {
  return `/interaction/${encodeURIComponent(uid)}`;
}

async function loadDetails(uid: string): Promise<Loaded> {
  try {
    const res = await fetch(`${interactionPath(uid)}/details`, { headers: { Accept: "application/json" } });
    if (res.status === 400) return { status: "expired" };
    if (res.status === 401) return { status: "leaving", to: ((await res.json()) as { sign_in: string }).sign_in };
    if (res.status === 403) return { status: "leaving", to: interactionPath(uid) };
    if (!res.ok) return { status: "error" };
    const details = (await res.json()) as ConsentDetails;
    if (details.prompt.name !== "consent") return { status: "leaving", to: interactionPath(uid) };
    return { status: "ready", details };
  } catch {
    return { status: "error" };
  }
}

/** Sends the user's answer. Answers where the browser goes next, or why it stays. */
async function sendAnswer(uid: string, answer: "approve" | "deny"): Promise<{ to: string } | "expired" | "failed"> {
  try {
    const res = await fetch(`${interactionPath(uid)}/${answer}`, { method: "POST", headers: { Accept: "application/json" } });
    if (res.status === 400) return "expired";
    if (!res.ok) return "failed";
    return { to: ((await res.json()) as { location: string }).location };
  } catch {
    return "failed";
  }
}

/**
 * The Agent consent page (§9, §13.2), at `/consent/:uid`. The service sends
 * an agent's authorization request here once the user is signed in. The page
 * names the agent and the host its redirect URI points to, because a
 * registered or CIMD client chooses its own name. It lists the scopes in
 * plain words. Approve and Deny go to the service, which answers where the
 * browser goes next: back through the OAuth server to the agent, with a code
 * or with `access_denied`.
 */
export function Consent() {
  const uid = useParams()["uid"] ?? "";
  // Null while loading, and while the browser leaves.
  const [loaded, setLoaded] = useState<Exclude<Loaded, { status: "leaving" }> | null>(null);
  const [answer, setAnswer] = useState<"idle" | "sending" | "failed">("idle");

  useEffect(() => {
    let cancelled = false;
    void loadDetails(uid).then((next) => {
      if (cancelled) return;
      if (next.status === "leaving") window.location.replace(next.to);
      else setLoaded(next);
    });
    return () => {
      cancelled = true;
    };
  }, [uid]);

  async function send(choice: "approve" | "deny") {
    setAnswer("sending");
    const next = await sendAnswer(uid, choice);
    if (next === "expired") setLoaded({ status: "expired" });
    else if (next === "failed") setAnswer("failed");
    else window.location.replace(next.to);
  }

  if (loaded === null) return <p>Loading…</p>;
  if (loaded.status === "expired" || loaded.status === "error") {
    return (
      <>
        <h1>Approve an agent</h1>
        <p role="alert">{loaded.status === "expired" ? EXPIRED : "Open Gamer MCP did not answer. Reload the page to try again."}</p>
      </>
    );
  }

  const { client_name, redirect_host, scopes } = loaded.details;
  return (
    <div className="og-consent">
      <h1>Approve an agent</h1>
      <p>
        <strong>{client_name ?? "An agent with no name"}</strong> asks to connect to your Open Gamer MCP account.
      </p>
      {scopes.length === 0 ? (
        <p>It asks for no access to your data.</p>
      ) : (
        <>
          <p>It asks to:</p>
          <ul>
            {scopes.map((scope) => (
              <li key={scope}>{SCOPE_WORDS[scope] ?? <code>{scope}</code>}</li>
            ))}
          </ul>
        </>
      )}
      {redirect_host !== null && (
        <p>
          Approving sends access to <strong>{redirect_host}</strong>.
        </p>
      )}
      <p>Approve only if you started this from your agent.</p>
      {answer === "failed" && <p role="alert">Your answer was not sent. Try again.</p>}
      <div className="og-consent__actions">
        <button type="button" className="og-button" disabled={answer === "sending"} onClick={() => void send("approve")}>
          Approve
        </button>
        <button type="button" className="og-button og-button--secondary" disabled={answer === "sending"} onClick={() => void send("deny")}>
          Deny
        </button>
      </div>
    </div>
  );
}
