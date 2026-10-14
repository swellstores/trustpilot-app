# Trustpilot

Ask every customer for a Trustpilot review after their order, automatically.

## How it works

1. **Invites after each order.** When an order is fulfilled (or paid, or placed — you choose), the app creates a Trustpilot email invitation for the customer. Trustpilot sends it after the number of days you set.
2. **Your email, your template.** Choose the sender name, reply-to address, language, invitation template, tags and the page customers see after their review.
3. **Product reviews (optional).** Ask customers to review the products they bought, matched by SKU, with product names, images and links.
4. **Past and selected orders.** Invite recent orders placed before you installed the app, or select orders in the list and invite them in one go.
5. **Status on every order.** Each order shows whether it was invited, when the email goes out, and any error. An invitation Trustpilot may already have created is never sent again automatically. Send an invitation again from the order page.

## Setup

You need a paid Trustpilot plan with the API module add-on; the Enterprise plan includes it, and the free plan has no API access. Create an API application in Trustpilot Business → Integrations → Developers → APIs, enter the API key and secret in the app settings, then run **Test connection** to find your business unit ID and templates.
