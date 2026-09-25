import { useEffect, useId, useState } from "react";

import { when } from "../dates.js";

/** One of the user's agent grants, as `GET /api/v1/agents` lists it (`AgentGrant` in `platform/src/agents.ts`). */
export interface Agent {
  id: string;
  client_id: string;
  /** Null when the client names none, or its name is not known yet. */
  client_name: string | null;
  /** The host of a CIMD client's `client_id` URL, which published its name; null for another client. The page shows it when the name is not known. */
  client_host: string | null;
  approved_at: string | null;
  /** When the agent last got an access token, if known. */
  last_used_at: string | null;
}

/** The user's agent grants, or null when the service did not answer them. */
async function loadAgents(): Promise<Agent[] | null> {
  try {
    const res = await fetch("/api/v1/agents", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return ((await res.json()) as { agents: Agent[] }).agents;
  } catch {
    return null;
  }
}

/** Revokes an agent grant. Answers whether it is gone: 404 means it already was. */
async function saveRevoke(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE", headers: { Accept: "application/json" } });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

/**
 * The Connected agents page (§9, §13.2): the agents the user has approved,
 * each with when it was approved and last got a token. Revoking one ends its
 * grant and every token of it at once; the agent must be approved again.
 * Bridges are on the Devices page.
 */
export function ConnectedAgents() {
  const [agents, setAgents] = useState<Agent[] | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void loadAgents().then((loaded) => {
      if (!cancelled) setAgents(loaded ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function remove(id: string) {
    setAgents((current) => (Array.isArray(current) ? current.filter((agent) => agent.id !== id) : current));
  }

  return (
    <>
      <h1>Connected agents</h1>
      <p>
        The AI agents you have approved to read your game state. Revoking one disconnects it at once. To use it again, connect it again
        from the agent.
      </p>
      {agents === "loading" ? (
        <p>Loading…</p>
      ) : agents === "error" ? (
        <p role="alert">Open Gamer MCP did not answer. Reload the page to try again.</p>
      ) : agents.length === 0 ? (
        <p>No agents are connected.</p>
      ) : (
        <div className="og-cards">
          {agents.map((agent) => (
            <AgentCard key={agent.id} agent={agent} onRevoked={remove} />
          ))}
        </div>
      )}
    </>
  );
}

function AgentCard({ agent, onRevoked }: { agent: Agent; onRevoked: (id: string) => void }) {
  const id = useId();
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);

  async function revoke() {
    setSaving(true);
    setFailed(false);
    const revoked = await saveRevoke(agent.id);
    setSaving(false);
    if (revoked) onRevoked(agent.id);
    else setFailed(true);
  }

  return (
    <section className="og-card" aria-labelledby={`${id}-name`}>
      <div className="og-card__head">
        <h2 id={`${id}-name`}>
          <bdi>{agent.client_name ?? agent.client_host ?? "An agent with no name"}</bdi>
        </h2>
      </div>
      {agent.client_name !== null && agent.client_host !== null && (
        <p>
          Its name comes from <strong>{agent.client_host}</strong>.
        </p>
      )}
      <dl className="og-facts">
        {agent.approved_at !== null && (
          <>
            <dt>Approved</dt>
            <dd>{when(agent.approved_at)}</dd>
          </>
        )}
        {agent.last_used_at !== null && (
          <>
            <dt>Last used</dt>
            <dd>{when(agent.last_used_at)}</dd>
          </>
        )}
      </dl>
      {failed && <p role="alert">The agent was not revoked. Try again.</p>}
      {confirming ? (
        <>
          <p>Revoke this agent? It loses access to your game state at once.</p>
          <div className="og-card__actions">
            <button type="button" className="og-button" disabled={saving} onClick={() => void revoke()}>
              Revoke
            </button>
            <button type="button" className="og-button og-button--secondary" disabled={saving} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="og-card__actions">
          <button
            type="button"
            className="og-button og-button--secondary"
            onClick={() => {
              setFailed(false);
              setConfirming(true);
            }}
          >
            Revoke
          </button>
        </div>
      )}
    </section>
  );
}
