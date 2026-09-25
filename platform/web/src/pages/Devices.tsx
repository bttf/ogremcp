import { type FormEvent, useEffect, useId, useState } from "react";
import { Link } from "react-router";

import { day, when } from "../dates.js";

/** One of the user's devices, as `GET /api/v1/devices` lists it (`DeviceInfo` in `platform/src/devices.ts`). */
export interface Device {
  uuid: string;
  name: string | null;
  os: string | null;
  bridge_version: string | null;
  approved_at: string;
  last_seen_at: string | null;
  /** Revoked by the user, or its grant is gone. Its tokens no longer work. */
  revoked: boolean;
}

/** `DEVICE_NAME_MAX_LENGTH` in `platform/src/devices.ts`. */
const NAME_MAX_LENGTH = 64;

/** Names of the `client.os` values a bridge sends (§8.3). Another value is shown as sent. */
const OS_NAMES: Readonly<Record<string, string>> = { windows: "Windows", darwin: "macOS", macos: "macOS", linux: "Linux" };

const NOT_SAVED = "The change was not saved. Try again.";

function osName(os: string): string {
  return OS_NAMES[os.toLowerCase()] ?? os;
}

/**
 * The name of a device the user has not named: approval leaves it without
 * one. The OS is known from the bridge's first upload on.
 */
function fallbackName(device: Device): string {
  const approved = day(device.approved_at);
  return device.os === null ? `Bridge approved ${approved}` : `${osName(device.os)} bridge approved ${approved}`;
}

/** The user's devices, or null when the service did not answer them. */
export async function loadDevices(): Promise<Device[] | null> {
  try {
    const res = await fetch("/api/v1/devices", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return ((await res.json()) as { devices: Device[] }).devices;
  } catch {
    return null;
  }
}

/**
 * Renames a device; an empty name resets it to the fallback. Answers the
 * device, `invalid` when the service refused the name, or null when it did
 * not save it.
 */
async function saveName(uuid: string, name: string): Promise<Device | "invalid" | null> {
  try {
    const res = await fetch(`/api/v1/devices/${encodeURIComponent(uuid)}`, {
      method: "PATCH",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (res.status === 400) return "invalid";
    if (!res.ok) return null;
    return (await res.json()) as Device;
  } catch {
    return null;
  }
}

/** Revokes a device. Answers it, or null when the service did not revoke it. */
async function saveRevoke(uuid: string): Promise<Device | null> {
  try {
    const res = await fetch(`/api/v1/devices/${encodeURIComponent(uuid)}`, { method: "DELETE", headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return (await res.json()) as Device;
  } catch {
    return null;
  }
}

/**
 * The Devices page (§8.1, §13.2): the bridges the user has approved, live
 * ones first, each with when it was approved and last seen, and its OS and
 * bridge version once it has uploaded. A live device can be renamed and
 * revoked. Revoking signs the bridge out: its tokens stop working, and the
 * bridge asks to be approved again.
 *
 * The list is adapted from `web/src/pages/Account.tsx` in
 * bttf/wow-guide@df80260.
 */
export function Devices() {
  const [devices, setDevices] = useState<Device[] | "loading" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    void loadDevices().then((loaded) => {
      if (!cancelled) setDevices(loaded ?? "error");
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function update(saved: Device) {
    setDevices((current) => (Array.isArray(current) ? current.map((device) => (device.uuid === saved.uuid ? saved : device)) : current));
  }

  return (
    <>
      <h1>Devices</h1>
      <p>The bridges you have approved. Revoke a bridge you no longer use: it stops sending your game state until you approve it again.</p>
      {devices === "loading" ? (
        <p>Loading…</p>
      ) : devices === "error" ? (
        <p role="alert">Ogre MCP did not answer. Reload the page to try again.</p>
      ) : devices.length === 0 ? (
        <p>
          You have not approved a bridge yet. The bridge shows a code to enter on the <Link to="/device">approval page</Link>.
        </p>
      ) : (
        <div className="og-cards">
          {devices.map((device) => (
            <DeviceCard key={device.uuid} device={device} onSaved={update} />
          ))}
        </div>
      )}
    </>
  );
}

function DeviceCard({ device, onSaved }: { device: Device; onSaved: (device: Device) => void }) {
  const id = useId();
  const [mode, setMode] = useState<"view" | "rename" | "revoke">("view");
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start(next: "rename" | "revoke") {
    if (next === "rename") setDraft(device.name ?? "");
    setError(null);
    setMode(next);
  }

  async function rename(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    const saved = await saveName(device.uuid, draft);
    setSaving(false);
    if (saved === "invalid") setError(`A name is at most ${NAME_MAX_LENGTH} characters, with no control characters.`);
    else if (saved === null) setError(NOT_SAVED);
    else {
      onSaved(saved);
      setMode("view");
    }
  }

  async function revoke() {
    setSaving(true);
    setError(null);
    const saved = await saveRevoke(device.uuid);
    setSaving(false);
    if (saved === null) setError(NOT_SAVED);
    else {
      onSaved(saved);
      setMode("view");
    }
  }

  return (
    <section className={device.revoked ? "og-card og-card--revoked" : "og-card"} aria-labelledby={`${id}-name`}>
      <div className="og-card__head">
        <h2 id={`${id}-name`}>
          <bdi>{device.name ?? fallbackName(device)}</bdi>
        </h2>
        {device.revoked && <span className="og-badge">Revoked</span>}
      </div>
      <dl className="og-facts">
        <dt>Approved</dt>
        <dd>{when(device.approved_at)}</dd>
        <dt>Last seen</dt>
        <dd>{device.last_seen_at === null ? "Not yet" : when(device.last_seen_at)}</dd>
        {device.os !== null && (
          <>
            <dt>System</dt>
            <dd>{osName(device.os)}</dd>
          </>
        )}
        {device.bridge_version !== null && (
          <>
            <dt>Bridge version</dt>
            <dd>{device.bridge_version}</dd>
          </>
        )}
      </dl>
      {error !== null && <p role="alert">{error}</p>}
      {!device.revoked && mode === "view" && (
        <div className="og-card__actions">
          <button type="button" className="og-button og-button--secondary" onClick={() => start("rename")}>
            Rename
          </button>
          <button type="button" className="og-button og-button--secondary" onClick={() => start("revoke")}>
            Revoke
          </button>
        </div>
      )}
      {mode === "rename" && (
        <form className="og-card__form" onSubmit={(event) => void rename(event)}>
          <label>
            Name
            <input
              value={draft}
              maxLength={NAME_MAX_LENGTH}
              placeholder={fallbackName(device)}
              autoFocus
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <p className="og-hint">Leave it empty to use the default name.</p>
          <div className="og-card__actions">
            <button type="submit" className="og-button" disabled={saving}>
              Save
            </button>
            <button type="button" className="og-button og-button--secondary" disabled={saving} onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {mode === "revoke" && !device.revoked && (
        <>
          <p>Revoke this bridge? It stops sending your game state, and asks you to approve it again.</p>
          <div className="og-card__actions">
            <button type="button" className="og-button" disabled={saving} onClick={() => void revoke()}>
              Revoke
            </button>
            <button type="button" className="og-button og-button--secondary" disabled={saving} onClick={() => setMode("view")}>
              Cancel
            </button>
          </div>
        </>
      )}
    </section>
  );
}
