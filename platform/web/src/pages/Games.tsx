import { type ReactNode, useEffect, useId, useState } from "react";

/** One first-class kit, as `GET /api/v1/games` lists it (`platform/src/api.ts`). */
export interface Game {
  kit: string;
  name: string;
  enabled: boolean;
}

/**
 * In-game tips by kit key (§13.2). The page shows a game's tips while the
 * game is enabled. The bridge installs and updates the addon (§7).
 */
const TIPS: Readonly<Record<string, readonly ReactNode[]>> = {
  wow: [
    <>
      Type <code>/transmit</code> in game to send your latest state.
    </>,
    "Restart WoW after the addon's first install.",
    "Close WoW to finish an addon update.",
  ],
};

/** The first-class kits, or null when the service did not answer them. */
export async function loadGames(): Promise<Game[] | null> {
  try {
    const res = await fetch("/api/v1/games", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return ((await res.json()) as { games: Game[] }).games;
  } catch {
    return null;
  }
}

/** Enables or disables a kit. Answers its new state, or null when the service did not save it. */
async function saveGame(kit: string, enabled: boolean): Promise<Game | null> {
  try {
    const res = await fetch(`/api/v1/games/${encodeURIComponent(kit)}`, {
      method: enabled ? "PUT" : "DELETE",
      headers: { Accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as Game;
  } catch {
    return null;
  }
}

/**
 * The Games page (§13.2): the first-class kits, each with a switch that
 * enables or disables it for the signed-in user, and its in-game tips while
 * it is enabled.
 */
export function Games() {
  const [games, setGames] = useState<Game[] | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void loadGames().then((loaded) => {
      if (!cancelled) setGames(loaded ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function update(saved: Game) {
    setGames((current) => (Array.isArray(current) ? current.map((game) => (game.kit === saved.kit ? saved : game)) : current));
  }

  return (
    <>
      <h1>Games</h1>
      <p>Enable the games you play. The bridge picks up changes on its own.</p>
      {games === "loading" ? (
        <p>Loading…</p>
      ) : games === "error" ? (
        <p role="alert">Open Gamer MCP did not answer. Reload the page to try again.</p>
      ) : (
        <div className="og-games">
          {games.map((game) => (
            <GameCard key={game.kit} game={game} onSaved={update} />
          ))}
        </div>
      )}
    </>
  );
}

function GameCard({ game, onSaved }: { game: Game; onSaved: (game: Game) => void }) {
  const id = useId();
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const tips = TIPS[game.kit] ?? [];

  async function toggle(enabled: boolean) {
    setSaving(true);
    setFailed(false);
    const saved = await saveGame(game.kit, enabled);
    setSaving(false);
    if (saved === null) setFailed(true);
    else onSaved(saved);
  }

  return (
    <section className="og-game" aria-labelledby={`${id}-name`}>
      <div className="og-game__head">
        <h2 id={`${id}-name`}>{game.name}</h2>
        <label className="og-switch">
          <input
            type="checkbox"
            role="switch"
            checked={game.enabled}
            disabled={saving}
            aria-labelledby={`${id}-name ${id}-label`}
            onChange={(event) => void toggle(event.currentTarget.checked)}
          />
          <span id={`${id}-label`}>Enabled</span>
        </label>
      </div>
      {failed && <p role="alert">The change was not saved. Try again.</p>}
      {game.enabled && tips.length > 0 && (
        <ul className="og-tips">
          {tips.map((tip, index) => (
            <li key={index}>{tip}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
