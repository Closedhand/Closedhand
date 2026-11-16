// lib/services-config.js: the services a person can connect, as the chat names them.

// noTile: no tile on the Connections tab until there is an app to sign in
// with, so its MCP server or an API key goes into the box there.
const CONNECTABLE_SERVICES = {
  google: { name: "Google", provides: "Gmail, Calendar, Drive", isSignup: true },
  // Read and synced where a connection exists, but nothing adds one yet.
  imap: { name: "Email (IMAP)", provides: "Any mailbox via app password: read, send, drafts", noWayToAdd: true },
  ics_calendar: { name: "Calendar feed (ICS)", provides: "Read-only calendar via a secret iCal URL", noWayToAdd: true },
  microsoft: { name: "Microsoft 365", provides: "Outlook, Calendar, OneDrive", isSignup: true },
  shopify: { name: "Shopify", provides: "Orders, products, inventory" },
  meta_ads: { name: "Meta Ads", provides: "Facebook & Instagram ad campaigns" },
  slack: { name: "Slack", provides: "Channels, messages" },
  notion: { name: "Notion", provides: "Pages, databases" },
  github: { name: "GitHub", provides: "Repos, issues, PRs" },
  stripe: { name: "Stripe", provides: "Payments, customers" },
  hubspot: { name: "HubSpot", provides: "CRM, contacts, deals", noTile: true },
  dropbox: { name: "Dropbox", provides: "File storage" },
  salesforce: { name: "Salesforce", provides: "CRM", noTile: true },
  spotify: { name: "Spotify", provides: "Music", noTile: true },
  gitlab: { name: "GitLab", provides: "Repos, CI/CD" },
  // Connected from the dashboard's form, where the person pastes what the
  // bank service hands out.
  simplefin: { name: "US banks via SimpleFIN", provides: "Bank balances and transactions, read-only", dashboardForm: true },
  lunchflow: { name: "UK and EU banks via Lunch Flow", provides: "Bank balances and transactions, read-only", dashboardForm: true },
};

module.exports = { CONNECTABLE_SERVICES };
