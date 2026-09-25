import { type FormEvent, useId, useState } from "react";

/** What the user types to confirm Delete account. */
export const DELETE_ACCOUNT_PHRASE = "delete my account";

/** Sends a delete of the web UI's API (`platform/src/api.ts`). Answers whether the service did it. */
async function sendDelete(path: string): Promise<boolean> {
  try {
    const res = await fetch(path, { method: "DELETE", headers: { Accept: "application/json" } });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * The Account page (§13.2). It holds Delete my data and Delete account
 * (§11), one card each; the tier and billing join it as cards of their own.
 */
export function Account() {
  return (
    <>
      <h1>Account</h1>
      <div className="og-cards">
        <DeleteData />
        <DeleteAccount />
      </div>
    </>
  );
}

/** Delete my data: a second click, after the page says what goes and what stays. */
function DeleteData() {
  const id = useId();
  const [step, setStep] = useState<"idle" | "confirming" | "deleting" | "deleted" | "failed">("idle");

  async function remove() {
    setStep("deleting");
    setStep((await sendDelete("/api/v1/account/data")) ? "deleted" : "failed");
  }

  return (
    <section className="og-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Delete my data</h2>
      <p>
        Deletes the game state your bridges uploaded, the record of your agents' tool calls and searches, and the problems you reported
        through your agent. Your account, devices, connected agents, and games stay. Your agents see no game state until your bridge
        uploads it again.
      </p>
      {step === "deleted" && <p role="status">Your data is deleted.</p>}
      {step === "failed" && <p role="alert">Your data was not deleted. Try again.</p>}
      {step === "confirming" || step === "deleting" ? (
        <>
          <p>Delete your data? This cannot be undone.</p>
          <div className="og-card__actions">
            <button type="button" className="og-button" disabled={step === "deleting"} onClick={() => void remove()}>
              Delete my data
            </button>
            <button type="button" className="og-button og-button--secondary" disabled={step === "deleting"} onClick={() => setStep("idle")}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div className="og-card__actions">
          <button type="button" className="og-button og-button--secondary" onClick={() => setStep("confirming")}>
            Delete my data
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Delete account: the button works once the user has typed
 * `DELETE_ACCOUNT_PHRASE`. The service ends the web session, so the browser
 * then loads `/`, which sends it to the Sign in page.
 */
function DeleteAccount() {
  const id = useId();
  const [typed, setTyped] = useState("");
  const [step, setStep] = useState<"idle" | "deleting" | "failed">("idle");
  const confirmed = typed.trim() === DELETE_ACCOUNT_PHRASE;

  async function remove(event: FormEvent) {
    event.preventDefault();
    if (!confirmed) return;
    setStep("deleting");
    if (await sendDelete("/api/v1/account")) window.location.replace("/");
    else setStep("failed");
  }

  return (
    <section className="og-card" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`}>Delete account</h2>
      <p>
        Deletes your data, your devices, your connected agents, your Google and Discord sign-ins, and your account. Every bridge and agent
        loses access at once, and you are signed out. This cannot be undone.
      </p>
      <form className="og-card__form" onSubmit={(event) => void remove(event)}>
        <label>
          <span>
            Type <strong>{DELETE_ACCOUNT_PHRASE}</strong> to confirm
          </span>
          <input value={typed} autoComplete="off" spellCheck={false} onChange={(event) => setTyped(event.currentTarget.value)} />
        </label>
        {step === "failed" && <p role="alert">Your account was not deleted. Try again.</p>}
        <div className="og-card__actions">
          <button type="submit" className="og-button" disabled={!confirmed || step === "deleting"}>
            Delete account
          </button>
        </div>
      </form>
    </section>
  );
}
