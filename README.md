# MEP on-call workbench

A personal local dashboard for alerts in `#outbound-dlp-alerts` and tickets assigned to you in the active MEP sprint. It reads Slack through the existing `slack` CLI and Jira through `abjira`.

## Run

Start this from your **normal laptop terminal** so Claude Code and Codex can write their own session files:

```bash
cd ~/code/mep-oncall-workbench
npm install
npm run dev
```

Open <http://127.0.0.1:5173/>. The API binds to `127.0.0.1:4171`. A Codex session's sandbox blocks writes to `~/.claude` and `~/.codex`, so starting `npm run dev` inside Codex will make the embedded agents fail. The app shows a direct error if it detects that restriction.

Slack access uses your existing `abnml_login` session and VPN. Refresh your login or VPN if alert sync fails. The app does not copy CLI credentials.

## How it works

- A shift starts Monday at **11 am IST** and ends the next Monday at 11 am IST. The current shift is selected by default; arrows move between shifts.
- The current on-call view also shows tickets assigned to your Jira account in the active MEP sprint, regardless of when the tickets were created or which Jira project owns them. Jira status is read-only in the workbench. Historical on-call views show their Slack alerts only.
- If a sprint ticket is linked to a Slack alert, that alert is the queue row and the Jira ticket appears as a linked badge. Linked alerts from an earlier shift are carried into the current view, marked as such. The workbench searches up to 12 earlier shifts for a linked alert; if it cannot load the alert, it keeps the Jira row visible so the task does not disappear.
- Routine posts titled `Internal Abnormal user changed outbound DLP config — N change(s)`, `Client Map Sync Completed`, `DLQ Replay Complete`, `DLQ Replay Dry Run`, `MEP Enablement Succeeded`, or `Outbound DLP Config Changed` are treated as notifications and excluded from the alert queue and counts.
- The dark alert list fills the workspace until you click a row. On desktop, the list scrolls independently; selecting a row opens a compact alert header and the terminal in the remaining right-panel space. The panel has a prominent Slack link, a collapsible terminal, and an Expand button for a screen-sized terminal.
- Unlinked Jira tickets are work items in the same queue as Slack alerts. Selecting either kind opens the same detail panel and investigation terminal. Jira's status sets the initial local workflow status; later Jira changes do not overwrite manual workflow changes.
- Use the status filter to show any exact workflow state. Change a work item's status directly in its row or in the open panel. Changes save automatically; external Jira and PR states never change the local status.
- PagerDuty alerts show the latest incident state reported by the PagerDuty bot in their Slack thread, plus a link to the incident. When that state is Resolved, **Mark as done** is available in the row and detail panel. PagerDuty resolution never changes the local work status automatically; a missing or unreadable thread shows Status unavailable.
- Link Jira tickets or abnormal-security GitHub PRs from the open panel. The list shows linked ticket statuses and PR states. These are read through `abjira` and `gh` and refresh with the alert list. PR numbers alone refer to `abnormal-security/source`; use a full GitHub PR URL for another repository. You can remove a link from its badge in the list.
- Each work item can run its own embedded Codex or Claude Code terminal. Codex is the default. Both launch in `~/source` (or `$SOURCE`). Collapsing or switching items leaves the PTY running; stopping the app ends those processes. The chat ID is saved with the work item in `data/statuses.json`, so **Resume session** restarts the same saved chat after an app restart. **Start new** explicitly replaces that association.
- A Codex terminal shows its session ID and a Copy ID button in the header as soon as Codex creates the thread. Saved chats can be resumed elsewhere with `codex resume <id>`.
- After stopping or exiting a terminal, choose **Resume Codex…** to paste either that session ID or the full `codex resume <id>` command. You can also use Resume Codex before starting a terminal for an alert. The app passes the ID directly to Codex, without executing the pasted text as a shell command.
- Expand a visible terminal to use most of the screen, then restore it with the same button. The browser shows a `Needs input` badge for recognizable terminal approval prompts, including on the alert row and in the header. The badge is inferred from the current terminal screen, so prompts with different wording may not be detected.
- In embedded Codex and Claude terminals, Shift+Enter inserts a new line and Enter submits. Command+Enter also inserts a new line in Codex.
- Paste a screenshot with Command+V into a running Codex terminal, or drop an image onto it. The app saves PNG, JPEG, or WebP files up to 10 MB in gitignored `data/attachments/` and inserts a local path into the Codex prompt. Review the prompt and press Enter to send it. Text paste continues to work normally.

The app writes a gitignored `data/statuses.json` with hashed work item IDs, workflow statuses, update times, linked Jira/PR references, and associated chat IDs. Pasted screenshots remain in `data/attachments/` until you remove them. It does not save Slack message bodies or terminal output to its own files. The CLIs manage their own chat histories and credentials. A new chat can be resumed after restart once its CLI has saved the chat file.

## Checks

```bash
npm run build
npm test
```
