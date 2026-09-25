import { type ReactNode, useEffect, useState } from "react";
import { Link } from "react-router";

import { loadSetup, type Setup } from "../setup.js";
import { loadAgents } from "./ConnectedAgents.js";
import { loadDevices } from "./Devices.js";
import { loadGames } from "./Games.js";

/** Which steps are done, from the user's data. Null when the service did not answer it. */
interface Progress {
  /** An enabled game (§11 `user_games`). */
  games: boolean | null;
  /** A live device: the bridge was downloaded and approved (§8.1). */
  bridge: boolean | null;
  /** An agent grant (§9). */
  agent: boolean | null;
}

async function loadProgress(): Promise<Progress> {
  const [games, devices, agents] = await Promise.all([loadGames(), loadDevices(), loadAgents()]);
  return {
    games: games === null ? null : games.some((game) => game.enabled),
    bridge: devices === null ? null : devices.some((device) => !device.revoked),
    agent: agents === null ? null : agents.length > 0,
  };
}

/**
 * The Get started page (§13.2): the one-time onboarding. Choose your games,
 * download the bridge, approve it at `/device`, and connect an agent. The
 * bridge installs the addon of each enabled game only (§8.2), so games come
 * first. A step shows as done when the user's games, devices, or agent
 * grants say so.
 */
export function GetStarted() {
  const [setup, setSetup] = useState<Setup | "loading" | "error">("loading");
  const [progress, setProgress] = useState<Progress>({ games: null, bridge: null, agent: null });

  useEffect(() => {
    let cancelled = false;
    void loadSetup().then((loaded) => {
      if (!cancelled) setSetup(loaded ?? "error");
    });
    void loadProgress().then((loaded) => {
      if (!cancelled) setProgress(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <>
      <h1>Get started</h1>
      <p>Four steps connect your games to your AI agent.</p>
      {setup === "loading" ? (
        <p>Loading…</p>
      ) : setup === "error" ? (
        <p role="alert">Ogre MCP did not answer. Reload the page to try again.</p>
      ) : (
        <ol className="og-cards og-steps">
          <Step title="Choose your games" done={progress.games}>
            <p>Enable the games you play. The bridge installs the addon for each one.</p>
            <p>
              <Link to="/games">Choose your games</Link>
            </p>
          </Step>
          <Step title="Download the bridge" done={progress.bridge}>
            <p>The bridge is one app for every game you play. It runs on Windows and macOS and sends your game state to Ogre MCP.</p>
            {setup.bridge_download_url === null ? (
              <p>The download is not available yet.</p>
            ) : (
              <p>
                <a className="og-button og-button--inline" href={setup.bridge_download_url}>
                  Download the bridge
                </a>
              </p>
            )}
          </Step>
          <Step title="Approve the bridge" done={progress.bridge}>
            <p>
              Open the bridge. It shows a code. Enter the code on the <Link to="/device">approval page</Link>.
            </p>
          </Step>
          <Step title="Connect your agent" done={progress.agent}>
            <p>Add Ogre MCP to your AI agent, such as Claude or ChatGPT, and approve it.</p>
            <p>
              <Link to="/connect">Connect your agent</Link>
            </p>
          </Step>
        </ol>
      )}
    </>
  );
}

function Step({ title, done, children }: { title: string; done: boolean | null; children: ReactNode }) {
  return (
    <li className="og-card">
      <div className="og-card__head">
        <h2>{title}</h2>
        {done === true && <span className="og-badge">Done</span>}
      </div>
      {children}
    </li>
  );
}
