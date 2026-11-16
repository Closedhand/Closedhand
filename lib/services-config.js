// lib/services-config.js: the services a person can connect, as the chat names them.

// A service not listed here connects the way anything does: its MCP server
// or an API key pasted into the box on the Connections tab.
// mcp: the service connects through its company's own MCP server, at this
// host (the webapp's connection-catalogue.js `remote`;
// scripts/test-sign-in-anywhere.js keeps the two in step), so a connection
// to that host is this service connected.
const CONNECTABLE_SERVICES = {
  google: { name: "Google", provides: "Gmail, Calendar, Drive", isSignup: true },
  // Read and synced where a connection exists, but nothing adds one yet.
  imap: { name: "Email (IMAP)", provides: "Any mailbox via app password: read, send, drafts", noWayToAdd: true },
  ics_calendar: { name: "Calendar feed (ICS)", provides: "Read-only calendar via a secret iCal URL", noWayToAdd: true },
  microsoft: { name: "Microsoft 365", provides: "Outlook, Calendar, OneDrive", isSignup: true },
  shopify: { name: "Shopify", provides: "Orders, products, inventory" },
  meta_ads: { name: "Meta Ads", provides: "Facebook & Instagram ad campaigns", mcp: "mcp.facebook.com" },
  slack: { name: "Slack", provides: "Channels, messages", mcp: "mcp.slack.com" },
  atlassian: { name: "Atlassian", provides: "Jira, Trello, Confluence", mcp: "mcp.atlassian.com" },
  notion: { name: "Notion", provides: "Pages, databases", mcp: "mcp.notion.com" },
  github: { name: "GitHub", provides: "Repos, issues, PRs", mcp: "api.githubcopilot.com" },
  stripe: { name: "Stripe", provides: "Payments, customers", mcp: "mcp.stripe.com" },
  dropbox: { name: "Dropbox", provides: "File storage", mcp: "mcp.dropbox.com" },
  gitlab: { name: "GitLab", provides: "Repos, CI/CD", mcp: "gitlab.com" },
  // Connected from the dashboard's form, where the person pastes what the
  // bank service hands out.
  simplefin: { name: "US banks via SimpleFIN", provides: "Bank balances and transactions, read-only", dashboardForm: true },
  lunchflow: { name: "UK and EU banks via Lunch Flow", provides: "Bank balances and transactions, read-only", dashboardForm: true },
};

// The connected server that is this service, if there is one.
const serverFor = (svc, servers) => (svc && svc.mcp ? (servers || []).find((s) => s.host === svc.mcp) : null) || null;

module.exports = { CONNECTABLE_SERVICES, serverFor };
