# Connecting Claude (MCP)

The web app serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint at
`https://<app-host>/api/mcp`, where `<app-host>` is the host in `APP_URL`. It lets an AI assistant such as
Claude read the household's accounts, transactions, budget and net worth and, if you allow it, create and
categorise transactions, create rules and record asset values.

There is nothing to switch on: the endpoint exists in every installation. What you need is a way for the
assistant to reach it (section 1) and a credential (sections 2 and 3). The address is also shown, with a copy
button, under **Settings > Claude & MCP**.

Every connection acts as the person who made it, with at most that person's role: a viewer can only read, a
member or owner can also write if they allow it. Owners must have two-step verification enabled, as everywhere
else in the app. Each credential is limited to 120 requests a minute.

## 1. Reachability

- **claude.ai** (the Claude connector) connects from Anthropic's servers on the internet, not from your
  browser. The MCP URL must therefore be reachable publicly over **HTTPS with a valid certificate**, and it
  must answer directly: **no redirect** of `/api/mcp` (for example http to https, or one host name to another),
  because the connector does not follow them. A server that is only reachable on your home network will not work
  with claude.ai.
- **Claude Code** runs on your own computer, so it only needs to reach the URL from there (a private address is
  fine).
- If a firewall or reverse proxy restricts inbound traffic, allow Anthropic's outbound range
  **160.79.104.0/21** to `/api/mcp`, the `/.well-known/` metadata paths and `/api/auth/` (the sign-in and OAuth
  endpoints the connector uses). Check Anthropic's documentation for the current range before relying on it.
- Keep the MCP URL's host equal to the host in `APP_URL`: the connector validates the address it was given
  against the server's own metadata.

## 2. Connect claude.ai

1. In claude.ai open **Settings > Connectors**.
2. Choose **Add custom connector**.
3. Paste the MCP URL (`https://<app-host>/api/mcp`) and confirm.
4. claude.ai opens the app's sign-in page. Sign in and press **Allow** (Permitir) on the consent page. It lists
   what the connection will be able to do; a viewer is only offered read access.
5. The connection now appears under **Settings > Claude & MCP > Connected apps**.

Only the claude.ai and claude.com callbacks, and `http://localhost:<port>/callback` or
`http://127.0.0.1:<port>/callback` for tools running on your machine, are accepted by default. To allow another
MCP client's OAuth callback, list its exact redirect URI(s) in the optional environment variable:

| Variable                     | Value                                                                              |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| `MCP_ALLOWED_REDIRECT_URIS`  | Comma-separated absolute URIs, no fragment, e.g. `https://client.example.org/cb`. |

This one is environment-only (it is not on the Services page), so restart the web app after changing it. (In the Helm chart it is a key of the optional Secret; see
[Kubernetes](kubernetes.md).)

## 3. Connect Claude Code

Claude Code uses a personal access token instead of the browser sign-in:

1. Open **Settings > Claude & MCP** and choose **Create token**. Give it a name, pick **Read only** or
   **Read and write** (a viewer can only pick read) and an expiry (90 days by default).
2. Copy the token from the dialog. It is shown **once**; only a hash is stored.
3. In a terminal run (the dialog's **Copy Claude Code command** fills in the token for you):

   ```sh
   claude mcp add --transport http <name> https://<app-host>/api/mcp --header "Authorization: Bearer <token>"
   ```

   `<name>` is the server name Claude Code will show: the page proposes your installation's brand name in
   lower case.

Other clients that accept a bearer token work the same way: send `Authorization: Bearer <token>` with every
request to the MCP URL.

## 4. Revoking access

Open **Settings > Claude & MCP**.

- **Personal access tokens**: **Revoke** a token to stop it at once. Clients using it get `401 Unauthorized`
  from the next request. Expired tokens stay in the list until you remove them.
- **Connected apps** (claude.ai and other OAuth clients): **Revoke access** deletes your consent and the app's
  access and refresh tokens for you. The app must be allowed again to reconnect. Revoking affects only your own
  connection, not other members'.
- Removing a member from the household also ends that member's tokens and connected apps for good: their
  consent and OAuth tokens are deleted, so inviting the person again starts from a clean slate and every app must
  be allowed again.
- Apps that registered but were never allowed by anyone are deleted after 7 days by the daily cleanup job.

Owners also see **Recent activity** on the same page: the last 50 entries of the audit log (tokens created and
revoked, apps revoked, and every change made through MCP, with the person and the token or app that made it).
The log records identifiers only, never amounts, tokens or other secrets.
