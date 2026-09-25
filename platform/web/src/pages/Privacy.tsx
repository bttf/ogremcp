import { Link } from "react-router";

import { ContactSection, LegalPage } from "./Legal.js";

/** The day the text below last changed. Change it with the text. */
export const PRIVACY_UPDATED = "September 25, 2026";

/**
 * The Privacy page (§13.2). It describes the hosted service, with the default
 * limits. Every statement follows from the code and docs/architecture.md:
 * what the WoW adapter records (`kits/wow/adapter`), what the bridge sends
 * (§8.3), the tables (§11, `platform/migrations`), sign-in
 * (`sign-in-providers.ts`), retention (`retention.ts`), the deletes
 * (`account.ts`), the cleanup of expired sign-ins and tokens
 * (`auth-cleanup.ts`), and the log (`log.ts`). Paid retention is described,
 * but the public beta has only the free tier (§19.1 D5). The operator, the
 * no-sale statement, and Railway's request logs are the owner's decisions
 * (2026-09-25, RED-236). Change it, and `PRIVACY_UPDATED`, when they change.
 *
 * Adapted from `web/src/pages/Privacy.tsx` in bttf/wow-guide@df80260.
 */
export function Privacy() {
  return (
    <LegalPage title="Privacy policy" updated={PRIVACY_UPDATED}>
      <p>
        Ogre MCP is run by Red Pine Software. It has three parts: an addon in your game, the bridge app on your computer, and this
        service, which your AI agent connects to. This page says what each part collects, who else receives it, how long it is kept,
        and how to delete it.
      </p>
      <p>It describes the hosted service. Someone who runs their own server can change the limits below.</p>

      <h2>What the addon records</h2>
      <p>
        The World of Warcraft addon saves your current character's state to a file on your computer, in the game's SavedVariables folder.
        The file holds:
      </p>
      <ul>
        <li>The game's version.</li>
        <li>
          Your character: the game's ID for it, its name, realm, class, race, faction, level, experience, and money, and whether it is in
          combat, resting, or dead.
        </li>
        <li>
          Where it is: zone, subzone, position on the map, facing, whether it is in an instance, and where its hearthstone is set.
        </li>
        <li>Up to 20 places it visited recently, with times.</li>
        <li>The quests in its quest log: title, level, text, and objective progress.</li>
        <li>Its bags and equipped items: names, counts, and item details such as quality, level, and stats.</li>
        <li>The lines of its Skills tab, such as professions and weapon skills, with their ranks.</li>
        <li>When the state was saved, by the game server's clock.</li>
      </ul>
      <p>
        The addon does not read chat or other players, and it takes no screenshots. It never acts in the game. Its one command,{" "}
        <code>/transmit</code>, reloads the game's interface so that the game writes the file.
      </p>

      <h2>What the bridge sends</h2>
      <p>
        The bridge watches that file. When it changes, the bridge sends it to the service, compressed, over HTTPS. With the file it sends
        its own version, your computer's operating system, the time the file changed, and counts of its own errors. It sends the file's
        path only as a hash.
      </p>

      <h2>What the service stores</h2>
      <ul>
        <li>
          <strong>Your account:</strong> a random ID, your tier (free or paid), when the account was created, and when its tier last
          changed.
        </li>
        <li>
          <strong>Sign-ins:</strong> for each Google or Discord account you link, the ID that provider gives it. The service does not ask
          Google or Discord for your email address, and it does not store your name or picture.
        </li>
        <li>
          <strong>Web sessions:</strong> when you sign in, your browser gets a cookie. The service stores a hash of the cookie's token and
          when it expires.
        </li>
        <li>
          <strong>Games:</strong> the games you turned on.
        </li>
        <li>
          <strong>Devices:</strong> for each bridge you approve, the name you give it, its operating system, its version, and when it was
          approved, first uploaded, last seen, and revoked.
        </li>
        <li>
          <strong>Approvals:</strong> the agents and bridges you approved, and the tokens they use.
        </li>
        <li>
          <strong>Uploads:</strong> each file the bridge sends, as it arrived, with everything the addon records. It is kept so that it can
          be read again after a fix to the service.
        </li>
        <li>
          <strong>Snapshots:</strong> the game state read from each upload.
        </li>
        <li>
          <strong>Records of tool calls:</strong> for each tool call your agent makes, when it was made, which agent app made it, the tool,
          the options it chose, whether it failed, and which snapshot it read and how old that was.
        </li>
        <li>
          <strong>Records of uploads:</strong> for each upload, when it arrived, the result, the bridge's version, your operating system,
          and the bridge's error counts.
        </li>
        <li>
          <strong>Reported problems:</strong> when you ask your agent to report a problem, the note it sends, your recent tool calls, and
          which snapshot the agent read.
        </li>
        <li>
          <strong>Daily usage:</strong> how many tool calls you made each day.
        </li>
      </ul>
      <p>The service never sees your conversation with your agent. It sees only the tool calls the agent makes.</p>

      <h2>Who else receives your data</h2>
      <ul>
        <li>
          <strong>Railway</strong> hosts the service and its Postgres database, and stores the service's logs.
        </li>
        <li>
          <strong>Google</strong> and <strong>Discord</strong> confirm who you are when you sign in with them.
        </li>
        <li>
          <strong>Your AI agent</strong>, such as Claude or ChatGPT, receives the game state that its tool calls return. The agent
          provider's own terms and privacy policy cover what happens to it there.
        </li>
      </ul>
      <p>We do not sell your data or use it for advertising.</p>

      <h2>How long it is kept</h2>
      <p>There is no paid tier yet, so every account is on the free tier.</p>
      <ul>
        <li>Free accounts: uploads and snapshots are deleted 30 days after they arrive. A job checks once a day.</li>
        <li>Paid accounts: uploads and snapshots are kept until you delete them.</li>
        <li>After a change from paid to free, all of your uploads and snapshots are kept for 30 days. Then the free rule applies.</li>
        <li>
          Records of tool calls and uploads, reported problems, and daily usage counts are kept until you delete them, as described below.
        </li>
        <li>
          Your account, sign-ins, and devices are kept until you delete your account. Revoking a device or an agent ends its access.
        </li>
        <li>Web sessions, approvals, and their tokens are deleted by a daily job once they expire.</li>
      </ul>

      <h2>Deleting your data</h2>
      <p>Both deletes are on the <Link to="/account">Account</Link> page.</p>
      <ul>
        <li>
          <strong>Delete my data</strong> deletes your uploads, snapshots, records of tool calls and uploads, and reported problems. Your account, sign-ins, devices, connected agents, games, and daily usage counts stay. The counts stay so that
          a delete cannot reset the day's tool-call limit.
        </li>
        <li>
          <strong>Delete account</strong> deletes all of that, then your devices, your approvals and their tokens, your sign-ins, your web
          sessions, your games, your daily usage counts, and the account. Every bridge and agent loses access.
        </li>
      </ul>
      <p>Neither delete changes the logs.</p>
      <p>
        To stop sending data, quit the bridge or revoke it on the <Link to="/devices">Devices</Link> page. The addon's file on your
        computer is yours to delete.
      </p>

      <h2>Logs</h2>
      <p>
        The service writes its logs as JSON lines, which Railway stores. Each request writes one line with the method, the route, the
        status, and the time taken. When you are signed in, or the request comes from your bridge or agent, the line also holds your
        account's random ID. No line holds an IP address, a token, or a cookie.
      </p>
      <p>
        Railway, which hosts the service, keeps its own request logs. They can include IP addresses and are kept under Railway's
        retention.
      </p>

      <h2>Cookies</h2>
      <p>
        The site sets cookies only to sign you in and to approve agents and bridges. It has no analytics or advertising, and it loads no
        scripts from other sites.
      </p>

      <ContactSection />
    </LegalPage>
  );
}
