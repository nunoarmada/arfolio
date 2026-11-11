# Bank sync: Enable Banking and Trading 212

Everything on this page is optional. Without it the app works as before: bank connections are hidden (with a message), Trading 212 keeps working, and you can still add accounts and transactions by hand or import statements.

Throughout, `<app-host>` is the public host of your installation (the host in `APP_URL`).

## 1. Enable Banking (bank connections)

Bank connections for European banks go through [Enable Banking](https://enablebanking.com), a licensed account information provider. The Enable Banking application belongs to the installation (one per deployment); each household then authorises its own banks. Arfolio only reads balances and transactions. It can never move money.

### 1.1 Create the application

1. Sign in to the Enable Banking Control Panel and open **Applications** > **Register a new application**.
2. Choose the **production** environment in **restricted** mode. Restricted mode is meant for linking your own accounts for personal, non-commercial use. Its terms are Enable Banking's and may change, so read them on their site before you rely on them. At the time of writing:
   - only your own accounts can be linked;
   - the application stays inactive until you link your own accounts to it in the Control Panel;
   - a privacy policy URL, terms URL and a GDPR contact email are required when registering.
3. Use the **sandbox** environment instead if you only want to try the flow with mock banks (synthetic data, no real accounts).
4. Set the **redirect URL** to exactly:

   ```
   https://<app-host>/api/connections/callback
   ```

   It must be https and match `APP_URL` plus that path; the bank sends people back there after they authorise. The same address is shown, with a copy button, under **Settings > Services > Bank connections**.

### 1.2 Create the key pair

Enable Banking authenticates the application with a signed token, so you need an RSA key pair. Generate it yourself and keep the private key private:

```sh
openssl genrsa -out enablebanking-private.pem 2048
openssl rsa -in enablebanking-private.pem -pubout -out enablebanking-public.pem
```

Upload `enablebanking-public.pem` (the **public** key) when registering the application. The Control Panel can also generate the pair in the browser and download the private key as `<application-id>.pem`; that file works the same way. Only RSA keys are accepted.

### 1.3 Give the app the credentials

Two values are needed. Use either route; if both are set, the environment variable wins (see [Configuration](configuration.md)).

**From the app (easiest).** Sign in as a household owner and open **Settings > Services > Bank connections**. Enter the **Application ID** and paste the whole **Private key** (the PEM, including the BEGIN and END lines), then **Save**. **Test bank connection** checks that Enable Banking accepts them. The page needs a recent sign-in (within 10 minutes): if it asks, sign out and in again. Changes apply without a restart (the worker picks them up within about a minute).

**From the environment.**

| Variable                     | Value                                                          |
| ---------------------------- | -------------------------------------------------------------- |
| `ENABLE_BANKING_APP_ID`      | The application id shown in the Control Panel.                 |
| `ENABLE_BANKING_PRIVATE_KEY` | The private key in PEM format (real newlines or `\n` escaped). |
| `ENABLE_BANKING_API_URL`     | Optional. Defaults to `https://api.enablebanking.com`.         |

With Docker Compose, put them in `.env` (the commented lines in `.env.example`) and run `docker compose up -d` again. With the Helm chart they go in the optional Secret, which both web and worker read with `optional: true`. Its name is `<fullname>-optional` unless you set `optionalSecret.name`:

```sh
kubectl -n <namespace> create secret generic <fullname>-optional \
  --from-literal=ENABLE_BANKING_APP_ID='<application-id>' \
  --from-file=ENABLE_BANKING_PRIVATE_KEY=enablebanking-private.pem
kubectl -n <namespace> rollout restart deployment/<fullname>-web deployment/<fullname>-worker
```

If the Secret already exists (for example with `SMTP_URL`), add the two keys to it instead of creating a new one. Environment variables are read at start-up, so restart web and worker after changing them. A value set in the environment shows as **Set by environment** on the Services page and cannot be edited there.

If a key is malformed the app does not crash: bank connections are treated as not configured, and the log names the setting (never its value). Fix the value and save or restart.

The API address must be https (plain http is accepted only for loopback hosts, which is useful for tests).

### 1.4 What people see, and the limits

- Each household member with write access chooses a bank and is sent to the bank to authorise read-only access to balances and transactions.
- **Consent length** is decided by the bank: the app asks for the longest period the bank allows (many banks allow 90 days, some up to 180). When it ends, the connection shows as expired and the household is warned a week before. **Renew access** on the connection keeps the linked accounts.
- **Call budget.** Banks limit unattended requests per account per day (PSD2, about four). The automatic daily sync makes at least two requests per account (balances, plus every page of transactions) and is skipped if an earlier automatic sync succeeded in the last 20 hours. Unattended runs are limited to one per connection per ~20 h, so a newly linked account, or a renewal shortly after a run, waits for the next daily slot. **Sync now** is limited to two per connection per day and tells the bank that a person asked for it (their IP address and browser). **Sync all**, in the sidebar (members and owners, shown once a connection is active), runs **Sync now** on every active connection in turn: each one still counts against its own allowance, and a connection over it is skipped and reported, not retried.
- The connection stores only an encrypted bank session id; the bank credentials are never seen by the app.

## 2. Trading 212

No installation-level setup is needed: each connection stores its own API key, encrypted.

1. In the Trading 212 app open **Settings** > **API** and create a new key.
2. Enable **read-only** permissions only: `account`, `portfolio`, `history:transactions`, `history:dividends`, `history:orders`. Do not enable anything that places orders.
3. Copy the key and the secret straight away; the secret is shown only once.
4. In the app: **Connections** > **Add** > **Trading 212**, paste both, and link the account.

If the key is revoked or expires, the connection shows an expired state with **Update key**. The new key must belong to the same Trading 212 account that is already linked; keys of a different account are refused, so one account's data can never end up in another.

## 3. Keep the encryption key

Connection secrets (bank session ids and Trading 212 keys) are encrypted with `ENCRYPTION_KEY`. Losing or changing it makes every stored secret unreadable, so every connection has to be authorised again. Back the key up together with your database backups: see [Backup and upgrade](backup-and-upgrade.md).

## 4. Not covered by a connection

For a bank Enable Banking does not cover, or to load history older than the bank provides, import statements (CSV, XLSX or OFX) from an account's **Import statement** screen (saved formats live under **Settings > Import formats**), or add transactions by hand.
