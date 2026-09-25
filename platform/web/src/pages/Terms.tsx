import { Link } from "react-router";

import { ContactSection, LegalPage } from "./Legal.js";

/** The day the text below last changed. Change it with the text. */
export const TERMS_UPDATED = "September 25, 2026";

/**
 * The Terms page (§13.2): plain statements of how the service works. The
 * agent never acts in the game (§1), the service has limits (§8.3, §14), and
 * the licenses are §5's. No price: the public beta has only the free tier,
 * and billing comes after G2 (§19.1 D5).
 *
 * Adapted from `web/src/pages/Terms.tsx` in bttf/wow-guide@df80260.
 */
export function Terms() {
  return (
    <LegalPage title="Terms of use" updated={TERMS_UPDATED}>
      <h2>The service</h2>
      <p>
        Ogre MCP connects your game to an AI agent you choose, such as Claude or ChatGPT. The agent reads your game state and
        suggests what to do. It never acts in the game: you make every move.
      </p>

      <h2>Your account</h2>
      <p>
        You sign in with Google or Discord. You can delete your account at any time on the Account page. The{" "}
        <Link to="/privacy">Privacy policy</Link> says what is stored, how long it is kept, and what each delete removes.
      </p>

      <h2>Fair use</h2>
      <ul>
        <li>Use the service with your own account and your own characters.</li>
        <li>Follow the game's own terms while you play.</li>
        <li>
          The service has rate limits, such as on uploads per minute, and can cap tool calls per day. Do not try to get around them.
        </li>
        <li>Do not overload or attack the service, or use it to reach other people's data.</li>
      </ul>

      <h2>Your agent</h2>
      <p>Your agent is a separate service. Its provider's terms cover your use of it. Its answers can be wrong.</p>

      <h2>No warranty</h2>
      <p>
        The service is provided as is, without warranty of any kind. It can be unavailable, change, or stop. Stored data can be lost.
      </p>

      <h2>Licenses</h2>
      <p>
        The platform, which runs this service, is licensed under the GNU Affero General Public License, version 3 or later. The addon, the
        bridge, and the SDK are licensed under the MIT License.
      </p>

      <h2>Not affiliated with Blizzard</h2>
      <p>
        Ogre MCP is not made, endorsed, or supported by Blizzard Entertainment. World of Warcraft is a trademark of Blizzard
        Entertainment, Inc.
      </p>

      <h2>Changes</h2>
      <p>These terms can change. The date at the top says when they last changed.</p>

      <ContactSection />
    </LegalPage>
  );
}
