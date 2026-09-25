# S1: Discovery and auth against real clients

Spec: §9, §18.3 (S1). Issue: RED-309. Input to P6.1 (RED-325) and RED-305.

Question: what does each target client probe, how does it register, which
redirect URIs does it use, and does sign-in complete against our OAuth
server?

Answer: Claude, Claude Code, and ChatGPT all complete sign-in with no change
to the server. All three register by CIMD. None uses DCR or needs a static
client. Perplexity was not tested (no paid plan).

## Method

- Date: 2026-09-25, against `https://ogmcp-production.up.railway.app/mcp`,
  main at `abf54b3`. `/mcp` answered `501` after auth, because the MCP server
  is P6.
- The owner added the server in each client and approved the consent page.
- Evidence: Railway HTTP logs (method, path, status, user agent, source
  address) and each client's public CIMD document.

## Results

| | Claude (claude.ai) | Claude Code 2.1.282 | ChatGPT |
|---|---|---|---|
| Probes | `oauth-protected-resource/mcp`, `oauth-authorization-server`, `POST /mcp` (401) | same as Claude | same, plus `openid-configuration` |
| Registration | CIMD, `https://claude.ai/oauth/mcp-oauth-client-metadata` | CIMD, `https://claude.ai/oauth/claude-code-client-metadata` | CIMD, `https://chatgpt.com/oauth/client.json` |
| Redirect URIs | `https://claude.ai/api/mcp/auth_callback` | `http://localhost/callback`, `http://127.0.0.1/callback` (random port; RED-308) | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Token endpoint auth | `none` | `none` | `private_key_jwt` |
| Token request from | Anthropic egress (`160.79.106.0/24`), `python-httpx` | the user's machine, `Bun` | OpenAI egress (`172.183.143.0/24`), `openai-connectors-oauth/1.0` |
| `/mcp` calls from | Anthropic egress, `Claude-User` | the user's machine, `claude-code/2.1.282` | OpenAI egress, `openai-mcp/1.0.0` |
| Sign-in | completed | completed | completed |
| Origin check | no request refused | no request refused | no request refused |

- Every client fetched the path form of the protected resource metadata
  (`/.well-known/oauth-protected-resource/mcp`, RFC 9728) and RFC 8414
  metadata. Only ChatGPT also fetched `openid-configuration`.
- No client called `/oauth/register`.
- Claude's CIMD document also lists the `jwt-bearer` grant type. It did not
  use it.
- The default `MCP_ALLOWED_ORIGINS` refused nothing, so it fits these three
  clients. The logs do not record the Origin header itself.

## Not covered

- **Refresh behavior.** Access tokens last 60 minutes, and `/mcp` answered
  `501`, so no client refreshed during the test. Check it when P6 serves
  tools.
- **Perplexity.** Not tested. Its docs say it uses DCR when the server
  offers it (S2, RED-298). Test it in the client compatibility pass
  (RED-360) when a paid plan is available.

## Consequences

- P6 can start (RED-325).
- No tested client needs a pre-registered static client (RED-305).
