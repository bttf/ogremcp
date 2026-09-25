import { type ReactNode, useEffect, useState } from "react";

/** What `GET /api/v1/contact` answers (`Contact` in `platform/src/api.ts`). */
interface Contact {
  email: string | null;
}

/**
 * `CONTACT_EMAIL`, from `GET /api/v1/contact`: undefined until the service
 * answers, and null when none is set or the service did not answer.
 */
function useContactEmail(): string | null | undefined {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    fetch("/api/v1/contact", { headers: { Accept: "application/json" } })
      .then(async (res) => (res.ok ? ((await res.json()) as Contact).email : null))
      .catch(() => null)
      .then((loaded) => {
        if (!cancelled) setEmail(loaded);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return email;
}

/**
 * The Contact section of the Privacy and Terms pages: a link to
 * `CONTACT_EMAIL`, or a sentence that says contact details are coming soon.
 * Nothing until the service answers.
 */
export function ContactSection() {
  const email = useContactEmail();
  return (
    <>
      <h2>Contact</h2>
      {email === null && <p>Contact details coming soon.</p>}
      {typeof email === "string" && (
        <p>
          Email <a href={`mailto:${email}`}>{email}</a>.
        </p>
      )}
    </>
  );
}

/**
 * The frame of the Privacy and Terms pages (§13.2): the heading, the date
 * the text last changed, and the text. Both are public: their routes sit
 * outside `RequireSession`, and they read no session.
 *
 * Adapted from `web/src/pages/Legal.tsx` in bttf/wow-guide@df80260.
 */
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: ReactNode }) {
  return (
    <article className="og-legal">
      <h1>{title}</h1>
      <p className="og-hint">Last updated {updated}</p>
      {children}
    </article>
  );
}
