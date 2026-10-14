# Trustpilot integration

A Swell app that sends [Trustpilot](https://www.trustpilot.com/) review invitations to customers after their orders, with an
optional product review invitation, and records each invitation on the order.

## Features

### Invitations after orders

`functions/order-invitations.ts` runs on `order.submitted`, `order.paid` and `order.delivered`. Only the event chosen in
**Send invitation when** sends an invitation; the others return right away. The function loads the order with its account and
items, then creates an email invitation with the
[Invitation API](https://developers.trustpilot.com/invitation-api) (`POST /v1/private/business-units/{id}/email-invitations`).

| Setting value       | Swell event       | Order state                       |
| ------------------- | ----------------- | --------------------------------- |
| Order is fulfilled  | `order.delivered` | all items fulfilled (`delivered`) |
| Order is paid       | `order.paid`      | paid in full (`paid`)             |
| Order is placed     | `order.submitted` | submitted, no longer a draft      |

The invitation is sent with:

| Trustpilot field                     | Value                                                                          |
| ------------------------------------ | ------------------------------------------------------------------------------ |
| `consumerEmail`                      | order account email                                                            |
| `consumerName`                       | billing name, account name, shipping name, or the email's local part           |
| `referenceNumber`                    | order `number` (falls back to `id`)                                            |
| `locale`                             | **Language** (default `en-US`)                                                 |
| `senderName`, `replyTo`              | **Sender name**, **Reply-to email** (left out when empty)                      |
| `serviceReviewInvitation.templateId` | **Template ID**, or the business unit's default service template               |
| `…preferredSendTime`                 | now + **Days to wait** (left out when 0, so Trustpilot sends right away)       |
| `…tags`, `…redirectUri`              | **Tags**, **Redirect URL** (left out when empty)                               |

- Orders that are canceled, drafts, or have no customer email are skipped and logged.
- An order is invited once: after a successful invitation the app stores `trustpilot_status: sent` on the order and skips it
  on later events and runs. If saving the status fails, the error is logged and the invitation is not sent again.
- Invitations are never retried after Trustpilot may have created them, so a customer isn't emailed twice:
  - HTTP 429 on the invitation (rejected, nothing created) is rethrown so Swell retries the event.
  - A network error, timeout or 5xx on the invitation is recorded as `unconfirmed` with a note to check Trustpilot, and not
    retried. Unconfirmed orders are skipped like sent ones; **Send again** sends a new invitation.
  - Network errors, 429 and 5xx on the access token or templates are rethrown, since nothing has been sent yet.
  - Other errors (invalid email, rejected credentials) are recorded on the order as `failed` with the message, or logged
    when no order was reached.

### Product reviews

With **Invite to product reviews** on, the invitation also gets a `productReviewInvitation` with one product per SKU:

| Trustpilot product field | Swell value                                                                 |
| ------------------------ | --------------------------------------------------------------------------- |
| `sku`                    | variant SKU, else product SKU (items without a SKU are left out)            |
| `name`                   | product name                                                                |
| `brand`                  | product `brand`, when set                                                   |
| `imageUrl`               | first variant image, else first product image                               |
| `productUrl`             | **Product page URL** with `{slug}` / `{id}`, else `<store url>/products/<slug>` |

Template: **Product template ID**, or the business unit's default product template. If no item has a SKU, only the service
review invitation is sent. Product reviews must be part of the merchant's Trustpilot plan.

### Invitation status on orders

`models/orders.json` adds fields to orders (stored under `$app.trustpilot`), and `content/orders.json` shows them:

| Field                  | Shown as             | Meaning                                       |
| ---------------------- | -------------------- | --------------------------------------------- |
| `trustpilot_status`    | Invitation / column  | `sent`; `failed` when Trustpilot rejected it; `unconfirmed` (Not confirmed) when Trustpilot didn't answer and may have created it |
| `trustpilot_sent_at`   | Sent to Trustpilot   | when the app created the invitation           |
| `trustpilot_send_time` | Email goes out       | when Trustpilot emails the customer           |
| `trustpilot_error`     | Error                | Trustpilot's message for the last failure     |

- The **Trustpilot** tab on the order page shows the fields; the orders list gets a **Trustpilot** column.
- **Actions → Send Trustpilot invitation** on an order (`functions/send-invitation.ts`) sends the invitation right away,
  without the delay. The modal option **Send again if this order was already invited** sends a second invitation.

### Invite past and selected orders

`functions/invite-orders.ts` is a workflow started by two actions:

| Action                                         | Orders                                                                                      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Apps → Trustpilot → Actions → Invite past orders** | placed since the modal's **Orders placed since** date, in the **Send invitation when** state, not canceled |
| Orders list → select orders → **Send Trustpilot invitations** | the selected orders (the bulk action's `selection.query`)                        |

- Orders are read 50 at a time, oldest first (`id` cursor, `functions/lib/batch.ts`). Each page is one durable workflow step,
  retried up to 5 times with exponential backoff (starting at 30 s) on HTTP 429 from the invitation and on network errors,
  429 and 5xx from the token, templates or Swell. Orders invited before the retry are skipped on it.
- Invitations are sent right away (no delay), 5 at a time. Orders already invited, canceled, drafts or without email are skipped.
- The workflow returns and logs the totals: sent, skipped, failed and not confirmed. Running it again is safe: sent and
  unconfirmed orders are skipped.
- With **Enabled** off or a required setting missing, the run doesn't send anything and fails with the reason.
- Settings are read again at the start of each page; only flags and **Send invitation when** are stored in the run's step
  output, never the API key or secret.

### Test connection

**Apps → Trustpilot → Actions → Test connection** (`functions/test-connection.ts`):

- with a **Business unit ID**: reads the business unit (`GET /v1/business-units/{id}`, `apikey` header) and shows its name,
  TrustScore and review count, then gets an access token and lists the invitation templates with their IDs;
- without one: looks up the business unit by the store's domain (`GET /v1/business-units/find?name=<domain>`) and shows its ID.

Only a 404 from the business unit lookup is reported as an unknown ID. Other errors are shown with Trustpilot's message, with
"try again later" only for temporary ones (network error, HTTP 429 or 5xx). **Send Trustpilot invitation** words its errors the same way.

### Turning the app off

With **Enabled** off nothing is sent: order events return before loading the order, **Send Trustpilot invitation** says the
app is off, and the workflow run fails without sending. A running workflow checks the setting before each page; the page
being sent finishes, then the run fails with the totals so far. **Test connection** still works; it sends no customer data.

## Settings

All credentials and options are set by the merchant in the app settings (`settings/trustpilot.json`) and are never stored in code.
Functions read them with `getSettings` (`functions/lib/trustpilot.ts`), which applies the defaults below to values not yet saved.

| Setting               | Type     | Required | Default     | Description                                                                 |
| --------------------- | -------- | -------- | ----------- | --------------------------------------------------------------------------- |
| `api_key`             | secret   | yes      |             | Trustpilot API key (Business → Integrations → Developers → APIs).           |
| `api_secret`          | secret   | yes      |             | API secret of the same application.                                         |
| `business_unit_id`    | text     | yes      |             | Trustpilot business unit. Test connection can look it up by store domain.   |
| `enabled`             | toggle   | no       | on          | Turns off all invitations without uninstalling the app.                     |
| `invite_on`           | select   | no       | `delivered` | `delivered` (Order is fulfilled), `paid` or `submitted` (Order is placed).  |
| `delay_days`          | number   | no       | `3`         | Days Trustpilot waits before emailing (0–90). Not used for manual and bulk sends. |
| `sender_name`         | text     | no       |             | Email sender name. Empty: Trustpilot's default.                             |
| `reply_to`            | email    | no       |             | Reply-to address. Empty: Trustpilot's default.                              |
| `locale`              | text     | no       | `en-US`     | Locale of the email and review page.                                        |
| `service_template_id` | text     | no       |             | Invitation template. Empty: the business unit's default service template.   |
| `tags`                | text     | no       |             | Comma-separated tags added to the reviews.                                  |
| `redirect_uri`        | url      | no       |             | Page shown after the review. Empty: Trustpilot's page.                      |
| `product_reviews`     | toggle   | no       | off         | Add a product review invitation for items with a SKU.                       |
| `product_template_id` | text     | no       |             | Product review template. Empty: the default product template.               |
| `product_url`         | text     | no       |             | Product page URL with `{slug}` or `{id}`. Empty: `<store url>/products/<slug>`. |

Actions:

| Action                        | Where                      | Function                          | Options                                  |
| ----------------------------- | -------------------------- | --------------------------------- | ---------------------------------------- |
| Test connection               | settings                   | `test-connection.ts` (function)   |                                          |
| Invite past orders            | settings                   | `invite-orders.ts` (workflow)     | `since` date (required)                  |
| Send Trustpilot invitation    | order page, Actions menu   | `send-invitation.ts` (function)   | `send_again` checkbox                    |
| Send Trustpilot invitations   | orders list, bulk action   | `invite-orders.ts` (workflow)     |                                          |

## Setup

1. Install the Swell CLI and log in:

   ```bash
   npm install -g @swell/cli
   swell login
   ```

2. Install dependencies:

   ```bash
   cd /path/to/trustpilot
   npm install
   ```

3. Push the app to your store's test environment:

   ```bash
   swell app push
   ```

4. In Trustpilot Business, open **Integrations → Developers → APIs**, create an application and copy its API key and secret.
5. In the Swell dashboard open **Apps → Trustpilot**, enter the API key and secret and save.
6. Run **Actions → Test connection**. Without a Business unit ID it looks one up by the store domain; enter it and save,
   then run Test connection again to see your templates.
7. Choose **Send invitation when**, **Days to wait** and the email options on the **Invitations** tab, and save.
8. Optionally run **Actions → Invite past orders** for recent orders placed before the app was installed.
9. To install in the live environment, create a version and install it:

   ```bash
   swell app version minor
   swell app install
   ```

## Limits and known behavior

- **One invitation per order.** Later events and runs skip orders with `trustpilot_status` `sent` or `unconfirmed`. Only
  **Send again** on the order page sends a second one. Trustpilot may still apply its own duplicate rules per customer.
- **Unconfirmed invitations aren't retried.** When Trustpilot doesn't answer the invitation request, the app can't tell whether
  it was created. It marks the order **Not confirmed** instead of risking a second email; check Trustpilot Business →
  **Invitations** and use **Send again** if it's missing.
- **Customer email required.** Orders without an account email are skipped.
- **Test orders are invited too.** Orders placed in test mode are not treated differently; use test customer emails.
- **Order edits and cancellations after sending** don't change or withdraw the invitation already created in Trustpilot.
- **Delay applies to automatic invitations only.** Manual, past and bulk sends go out right away.
- **Access tokens** use the client credentials grant and are requested once per function run or workflow page; they are
  not cached between runs.
- **Template defaults.** When no template ID is set, each run lists the templates and picks the default one of the matching
  kind for the locale (or any default). Set the template IDs to skip that call.
- **Product reviews** need SKUs and a Trustpilot plan with product reviews; items without a SKU are left out.
- **Function timeout.** Each event makes at most 3 Trustpilot calls (token, templates, invitation) within the 10 s limit.
- Trustpilot API hosts: `https://api.trustpilot.com/v1` and `https://invitations-api.trustpilot.com/v1` (`functions/lib/trustpilot.ts`).

## Development

### Project layout

```
functions/
  order-invitations.ts  # order.submitted/paid/delivered → invitation for the configured event
  send-invitation.ts    # order page action: send now (optionally again)
  invite-orders.ts      # workflow: past orders (settings action) or selected orders (bulk action)
  test-connection.ts    # settings action: business unit, TrustScore, templates
  lib/trustpilot.ts     # settings, Trustpilot API client, payload mapping, inviteOrder
  lib/batch.ts          # order paging and page invites for the workflow
models/orders.json      # invitation fields on orders ($app.trustpilot)
content/orders.json     # Trustpilot tab, list column, order and bulk actions
settings/trustpilot.json  # merchant settings and settings actions
assets/icon.png         # app icon (official Trustpilot star)
assets/screenshots/     # listing screenshots, referenced by `images` in swell.json
test/unit/              # vitest unit tests (Trustpilot API mocked)
test/integration/       # vitest tests against the store using CLI auth
```

### Commands

```bash
npm run typecheck                 # TypeScript check for functions and tests
npm test                          # run all vitest tests
swell app dev                     # run functions locally, triggered by the test environment
swell app push                    # deploy to the test environment
swell inspect functions --app=.   # check deployed functions
swell inspect workflows --app=.   # check the invite-orders workflow
swell logs --type function -s order-invitations   # function logs
swell inspect workflow-runs --workflow app.trustpilot.invite-orders   # workflow runs
```

Tests run in the Cloudflare Workers runtime via `@cloudflare/vitest-pool-workers` and use your `swell login` session
(or `SWELL_STORE_ID` / `SWELL_SESSION_ID` in CI). Unit tests mock `fetch` by Trustpilot endpoint
(`test/helpers/trustpilot-fixtures.ts`), so no real Trustpilot calls are made.

To try it end to end, set real credentials in the test environment, set **Days to wait** to 0, mark a test order with your
own email as fulfilled, and check the order's Trustpilot tab, `swell logs --type function -s order-invitations` and
Trustpilot Business → **Invitations**.

Workflows don't run under `swell app dev`; the actions always start the pushed version.

Logs are also available in the dashboard under **Developer → Console → Logs**.
