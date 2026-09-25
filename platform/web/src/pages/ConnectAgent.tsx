import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import { loadSetup, type Setup } from "../setup.js";

/** The name the Claude Code command gives the server. */
const CLAUDE_CODE_NAME = "ogmcp";

/**
 * The Connect your agent page (§13.2): the MCP URL, which every agent uses
 * (§1), and short steps for each §9 target client. Each agent registers
 * itself (CIMD or DCR, §9), so no client ID is shown. The steps name each
 * client's setting area, not exact menu paths, which the clients rename.
 */
export function ConnectAgent() {
  const [setup, setSetup] = useState<Setup | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void loadSetup().then((loaded) => {
      if (!cancelled) setSetup(loaded ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h1>Connect your agent</h1>
      <p>
        Every agent connects to Open Gamer MCP with this one URL. When you add it, your agent sends you here to sign in and approve it.
      </p>
      {setup === "loading" ? (
        <p>Loading…</p>
      ) : setup === "error" ? (
        <p role="alert">Open Gamer MCP did not answer. Reload the page to try again.</p>
      ) : (
        <>
          <Copyable text={setup.mcp_url} label="Copy URL" />
          <div className="og-cards">
            <Client name="Claude">
              <li>In Claude's connector settings, add a custom connector with the URL above.</li>
              <li>Connect it, then sign in and approve Claude.</li>
              <li>Claude's Free plan allows one custom connector. This one covers every game you enable.</li>
            </Client>
            <Client name="Claude Code">
              <li>
                Run this command:
                <Copyable text={`claude mcp add --transport http ${CLAUDE_CODE_NAME} ${setup.mcp_url}`} label="Copy command" />
              </li>
              <li>
                In Claude Code, run <code>/mcp</code>, choose <code>{CLAUDE_CODE_NAME}</code>, and sign in to approve it.
              </li>
            </Client>
            <Client name="ChatGPT">
              <li>In ChatGPT's settings, turn on developer mode.</li>
              <li>Create a connector with the URL above, and choose OAuth for authentication.</li>
              <li>Sign in and approve ChatGPT.</li>
            </Client>
            <Client name="Perplexity">
              <li>On a paid plan, add a custom connector with the URL above in Perplexity's connector settings.</li>
              <li>Sign in and approve Perplexity.</li>
            </Client>
          </div>
          <p className="og-hint">
            An agent you approve is listed under <Link to="/agents">Connected agents</Link>, where you can revoke it.
          </p>
        </>
      )}
    </>
  );
}

function Client({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section className="og-card">
      <h2>{name}</h2>
      <ol className="og-client-steps">{children}</ol>
    </section>
  );
}

/** Text to copy, such as the MCP URL, with a button that copies it. */
function Copyable({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState<boolean | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // No clipboard: an http page other than localhost, or the permission was refused.
      setCopied(false);
    }
  }

  return (
    <div className="og-copy">
      <code>{text}</code>
      <button type="button" className="og-button og-button--secondary" onClick={() => void copy()}>
        {label}
      </button>
      <span role="status">{copied === true ? "Copied." : copied === false ? "Could not copy. Select the text and copy it." : ""}</span>
    </div>
  );
}
