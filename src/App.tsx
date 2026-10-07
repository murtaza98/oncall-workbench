import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Alert, AlertLinks, AlertStatus, AlertsResponse, Workflow } from '../shared/model';
import { workbenchToken } from './api';
import { TerminalPanel } from './TerminalPanel';
import { useTerminalAttention } from './useTerminalAttention';

const statusLabels: Record<AlertStatus, string> = {
  todo: 'To do',
  triaging: 'Triaging',
  backlog: 'Backlog',
  in_progress: 'In progress',
  review: 'Review',
  merge_deploy_pending: 'Merge and deploy pending',
  done: 'Done',
};

const statusGroup: Record<AlertStatus, string> = {
  todo: 'To do',
  triaging: 'Triaging',
  backlog: 'Follow-up',
  in_progress: 'Follow-up',
  review: 'Follow-up',
  merge_deploy_pending: 'Follow-up',
  done: 'Done',
};

const dateTime = new Intl.DateTimeFormat('en-IN', {
  timeZone: 'Asia/Kolkata',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});

function timeLabel(value: string): string {
  return dateTime.format(new Date(value));
}

function shortText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function PagerDutyBadge({ alert }: { alert: Alert }) {
  const incident = alert.pagerDuty;
  if (!incident) return null;
  const label = incident.status === 'unknown' ? 'Status unavailable' : incident.status[0].toUpperCase() + incident.status.slice(1);
  return <span className={`pagerduty-badge ${incident.status}`} title={incident.updatedAt ? `PagerDuty update: ${timeLabel(incident.updatedAt)} IST` : 'PagerDuty status could not be confirmed'}>PagerDuty · {label}</span>;
}

async function readJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload && typeof payload === 'object' && 'error' in payload
      ? String(payload.error)
      : 'Request failed.';
    throw new Error(error);
  }
  return payload as T;
}

export function App() {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<AlertsResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<AlertStatus | 'all'>('all');
  const [showTerminal, setShowTerminal] = useState(false);
  const [statusError, setStatusError] = useState('');
  const [linkEditor, setLinkEditor] = useState<{ id: string; kind: 'jira' | 'pr' } | null>(null);
  const [linkValue, setLinkValue] = useState('');
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState('');
  const requestId = useRef(0);
  const statusOverrides = useRef(new Map<string, AlertStatus>());
  const saveQueue = useRef(Promise.resolve());
  const alertIds = useMemo(() => data?.alerts.map((alert) => alert.id) || [], [data]);
  const needsInput = useTerminalAttention(alertIds);

  const loadAlerts = useCallback(async (force = false) => {
    const currentRequest = ++requestId.current;
    if (force) setRefreshing(true);
    else setLoading(true);
    try {
      const result = await readJson<AlertsResponse>(`/api/alerts?offset=${offset}${force ? '&refresh=1' : ''}`);
      if (currentRequest !== requestId.current) return;
      setData({
        ...result,
        alerts: result.alerts.map((alert) => {
          const status = statusOverrides.current.get(alert.id);
          return status ? { ...alert, workflow: { ...alert.workflow, status } } : alert;
        }),
      });
      setError('');
      setSelectedId((current) => {
        return result.alerts.some((post) => post.id === current) ? current : null;
      });
    } catch (cause) {
      if (currentRequest !== requestId.current) return;
      setError(cause instanceof Error ? cause.message : 'Could not sync alerts.');
    } finally {
      if (currentRequest === requestId.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [offset]);

  useEffect(() => {
    void loadAlerts();
    const timer = window.setInterval(() => void loadAlerts(), 60_000);
    return () => window.clearInterval(timer);
  }, [loadAlerts]);

  const posts = useMemo(() => {
    if (!data) return [];
    return data.alerts
      .filter((alert) => statusFilter === 'all' || alert.workflow.status === statusFilter)
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }, [data, statusFilter]);

  const selected = useMemo<Alert | null>(() => {
    if (!data) return null;
    return data.alerts.find((alert) => alert.id === selectedId) || null;
  }, [data, selectedId]);

  const groups = useMemo(() => {
    const names = ['To do', 'Triaging', 'Follow-up', 'Done'];
    return names.map((name) => ({
      name,
      alerts: posts.filter((alert) => statusGroup[alert.workflow.status] === name),
    })).filter((group) => group.alerts.length > 0);
  }, [posts]);

  const counts = useMemo(() => {
    const values = { todo: 0, triaging: 0, followup: 0, done: 0 };
    for (const alert of data?.alerts || []) {
      const group = statusGroup[alert.workflow.status];
      if (group === 'To do') values.todo++;
      else if (group === 'Triaging') values.triaging++;
      else if (group === 'Follow-up') values.followup++;
      else values.done++;
    }
    return values;
  }, [data]);

  function changeStatus(alert: Alert, status: AlertStatus) {
    if (status === alert.workflow.status) return;
    const previous = alert.workflow.status;
    setStatusError('');
    statusOverrides.current.set(alert.id, status);
    setData((current) => current && ({
      ...current,
      alerts: current.alerts.map((item) => item.id === alert.id
        ? { ...item, workflow: { ...item.workflow, status } }
        : item),
    }));
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const token = await workbenchToken();
        const result = await readJson<{ workflow: Workflow }>(`/api/alerts/${alert.id}/workflow`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-workbench-token': token },
          body: JSON.stringify({ status }),
        });
        if (statusOverrides.current.get(alert.id) === status) {
          setData((current) => current && ({
            ...current,
            alerts: current.alerts.map((item) => item.id === alert.id
              ? { ...item, workflow: result.workflow }
              : item),
          }));
        }
      } catch (cause) {
        if (statusOverrides.current.get(alert.id) === status) {
          statusOverrides.current.delete(alert.id);
          setData((current) => current && ({
            ...current,
            alerts: current.alerts.map((item) => item.id === alert.id
              ? { ...item, workflow: { ...item.workflow, status: previous } }
              : item),
          }));
          setStatusError(cause instanceof Error ? cause.message : 'Could not save status.');
        }
      }
    });
  }

  function changeShift(direction: number) {
    setSelectedId(null);
    setData(null);
    setOffset((current) => Math.min(12, Math.max(-12, current + direction)));
  }

  function openLinkEditor(id: string, kind: 'jira' | 'pr') {
    setLinkEditor({ id, kind });
    setLinkValue('');
    setLinkError('');
  }

  async function updateLink(alert: Alert, kind: 'jira' | 'pr', action: 'add' | 'remove', value: string) {
    setLinkBusy(true);
    setLinkError('');
    try {
      const token = await workbenchToken();
      const result = await readJson<{ links: AlertLinks }>(`/api/alerts/${alert.id}/links`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-workbench-token': token },
        body: JSON.stringify({ kind, action, value }),
      });
      setData((current) => current && ({
        ...current,
        alerts: current.alerts.map((item) => item.id === alert.id ? { ...item, links: result.links } : item),
      }));
      setLinkEditor(null);
      setLinkValue('');
      void loadAlerts(true);
    } catch (cause) {
      setLinkError(cause instanceof Error ? cause.message : 'Could not update link.');
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="identity">
          <span className="identity-mark" aria-hidden="true">↗</span>
          <div>
            <h1>On-call workbench</h1>
            <p>MEP · <a href="https://abnormalsecurity.slack.com/archives/C08122YHE5D" target="_blank" rel="noreferrer">#outbound-dlp-alerts</a> + active sprint</p>
          </div>
        </div>
        <div className="top-actions">
          {needsInput.size > 0 && <button className="attention-shortcut" onClick={() => {
            const first = data?.alerts.find((alert) => needsInput.has(alert.id));
            if (first) {
              setSelectedId(first.id);
              setShowTerminal(true);
            }
          }}>{needsInput.size} {needsInput.size === 1 ? 'terminal needs' : 'terminals need'} input</button>}
          <span className="local-badge"><span aria-hidden="true" /> Local</span>
          <button className="secondary-button" onClick={() => void loadAlerts(true)} disabled={refreshing || loading}>
            {refreshing ? 'Refreshing…' : 'Refresh alerts'}
          </button>
        </div>
      </header>

      <section className="shiftbar" aria-label="Selected on-call shift">
        <div className="shift-heading">
          <span className="field-label">On-call shift</span>
          <strong>{data?.shift.label || 'Loading shift…'}</strong>
        </div>
        <div className="shift-controls">
          <button className="icon-button" aria-label="Previous shift" onClick={() => changeShift(-1)} disabled={offset <= -12}>←</button>
          <button className="text-button" onClick={() => { setData(null); setOffset(0); }} disabled={offset === 0}>Current shift</button>
          <button className="icon-button" aria-label="Next shift" onClick={() => changeShift(1)} disabled={offset >= 12}>→</button>
        </div>
      </section>

      <section className="summarybar" aria-label="Queue summary">
        <div><strong>{data ? counts.todo : '—'}</strong><span>to do</span></div>
        <div><strong>{data ? counts.triaging : '—'}</strong><span>triaging</span></div>
        <div><strong>{data ? counts.followup : '—'}</strong><span>follow-up</span></div>
        <div><strong>{data ? counts.done : '—'}</strong><span>done</span></div>
        <div className="sync-status">{data ? `Last synced ${timeLabel(data.syncedAt)}` : 'Waiting for Slack sync'}</div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          <span>{error}</span>
          <button onClick={() => void loadAlerts(true)}>Try again</button>
        </div>
      )}
      {statusError && <div className="error-banner" role="alert"><span>Status was not saved: {statusError}</span><button onClick={() => setStatusError('')}>Dismiss</button></div>}
      {data?.jiraError && <div className="error-banner" role="alert"><span>{data.jiraError} Slack alerts are still available.</span><button onClick={() => void loadAlerts(true)}>Try again</button></div>}

      <main className={`workspace ${selected ? 'with-detail' : ''}`}>
        <aside className="queue-pane" aria-label="Alert queue">
          <div className="pane-heading">
            <div>
              <span className="field-label">Queue</span>
              <h2>Work items <span>{posts.length}</span></h2>
            </div>
          </div>
          <div className="queue-tools">
            <label className="filter-control">Filter by status
              <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as AlertStatus | 'all')}>
                <option value="all">All statuses</option>
                {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
          </div>
          <div className="queue-list">
            {loading && !data && <div className="empty-queue">Loading alerts from Slack…</div>}
            {!loading && data && posts.length === 0 && (
              <div className="empty-queue">{statusFilter !== 'all' ? 'No work items have this status.' : 'No work items in this shift yet.'}</div>
            )}
            {groups.map((group) => <div key={group.name} className="queue-group">
              <div className="queue-group-heading">{group.name}<span>{group.alerts.length}</span></div>
              {group.alerts.map((alert) => (
              <div
                key={alert.id}
                className={`alert-row ${selected?.id === alert.id ? 'selected' : ''}`}
              >
                <button className="alert-main" onClick={() => { setSelectedId(alert.id); setShowTerminal(true); }} aria-current={selected?.id === alert.id ? 'true' : undefined}>
                  <span className="alert-row-top"><span className="source-name">{alert.source}{alert.jira ? ` · ${alert.jira.type}` : ''}</span><time>{alert.jira ? 'Updated ' : ''}{timeLabel(alert.timestamp)}</time></span>
                  <strong>{alert.title}</strong>
                  {alert.jira ? <span className="alert-preview">Jira status: {alert.jira.status}</span> : <span className="alert-preview">{shortText(alert.text)}</span>}
                  {alert.carriedFromShift && <span className="carried-badge">Alert from a prior shift · linked to this sprint</span>}
                  <PagerDutyBadge alert={alert} />
                  {needsInput.has(alert.id) && <span className="attention-badge">Needs input</span>}
                </button>
                <div className="alert-row-actions">
                  <select value={alert.workflow.status} onChange={(event) => changeStatus(alert, event.target.value as AlertStatus)} aria-label={`Status for ${alert.title}`}>
                    {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                  {alert.jira && <span className="jira-status-badge">{alert.jira.status}</span>}
                  {alert.pagerDuty && <a href={alert.pagerDuty.incidentUrl} target="_blank" rel="noreferrer" title="Open PagerDuty incident">PagerDuty ↗</a>}
                  <a href={alert.permalink} target="_blank" rel="noreferrer" title={alert.jira ? 'Open Jira ticket' : 'Open Slack message'}>{alert.jira ? 'Jira ↗' : 'Slack ↗'}</a>
                  {alert.pagerDuty?.status === 'resolved' && alert.workflow.status !== 'done' && <button className="mark-done-button" onClick={() => changeStatus(alert, 'done')}>Mark as done</button>}
                </div>
                {(alert.links.jira.length > 0 || alert.links.prs.length > 0) && <div className="linked-items">
                  {alert.links.jira.map((item) => <span className="linked-item" key={item.reference}>
                    <a href={item.url} target="_blank" rel="noreferrer">{item.reference} <b>{item.status}</b></a>
                    <button aria-label={`Remove ${item.reference}`} onClick={() => void updateLink(alert, 'jira', 'remove', item.reference)}>×</button>
                  </span>)}
                  {alert.links.prs.map((item) => <span className={`linked-item ${item.status === 'Merged' ? 'merged' : ''}`} key={item.reference}>
                    <a href={item.url} target="_blank" rel="noreferrer">{item.reference} <b>{item.status}</b></a>
                    <button aria-label={`Remove ${item.reference}`} onClick={() => void updateLink(alert, 'pr', 'remove', item.url)}>×</button>
                  </span>)}
                </div>}
              </div>
              ))}
            </div>)}
          </div>
        </aside>

        {selected && <section className="detail-pane" aria-label="Selected alert">
              <div className="detail-intro">
                <div className="detail-heading-row"><div className="detail-kicker"><span className="status-dot" />{selected.source}</div><button className="close-detail" onClick={() => setSelectedId(null)} aria-label="Close alert details">Close ×</button></div>
                <h2 title={selected.title}>{selected.title}</h2>
                <div className="detail-meta">
                  <time>{timeLabel(selected.timestamp)} IST</time>
                  {selected.hasThread && <span>{selected.replyCount} {selected.replyCount === 1 ? 'reply' : 'replies'} in Slack</span>}
                  {selected.jira && <span>Jira status: {selected.jira.status}</span>}
                  <PagerDutyBadge alert={selected} />
                  {needsInput.has(selected.id) && <span className="attention-badge">Terminal needs input</span>}
                </div>
                <div className="detail-actions">
                  <label className="status-control"><span>Status</span>
                    <select value={selected.workflow.status} onChange={(event) => changeStatus(selected, event.target.value as AlertStatus)} aria-label="Alert status">
                      {Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                  <a className="slack-button" href={selected.permalink} target="_blank" rel="noreferrer">{selected.jira ? 'Open ticket in Jira ↗' : 'Open message in Slack ↗'}</a>
                  {selected.pagerDuty && <a className="add-link-button pagerduty-link" href={selected.pagerDuty.incidentUrl} target="_blank" rel="noreferrer">Open PagerDuty ↗</a>}
                  {selected.pagerDuty?.status === 'resolved' && selected.workflow.status !== 'done' && <button className="mark-done-button" onClick={() => changeStatus(selected, 'done')}>Mark as done</button>}
                  {!selected.jira && <button className="add-link-button" onClick={() => openLinkEditor(selected.id, 'jira')}>+ Link Jira</button>}
                  <button className="add-link-button" onClick={() => openLinkEditor(selected.id, 'pr')}>+ Link PR</button>
                </div>
                {linkEditor?.id === selected.id && <form className="detail-link-form" onSubmit={(event) => { event.preventDefault(); void updateLink(selected, linkEditor.kind, 'add', linkValue); }}>
                  <label>{linkEditor.kind === 'jira' ? 'Jira key or URL' : 'PR number or URL'}
                    <input autoFocus value={linkValue} onChange={(event) => setLinkValue(event.target.value)} placeholder={linkEditor.kind === 'jira' ? 'MEP-123' : '#12345 or GitHub PR URL'} />
                  </label>
                  <button type="submit" disabled={linkBusy || !linkValue.trim()}>Add</button>
                  <button type="button" onClick={() => setLinkEditor(null)}>Cancel</button>
                  {linkError && <span role="alert">{linkError}</span>}
                </form>}
              </div>

              <div className="detail-scroll">
                <TerminalPanel key={selected.id} alertId={selected.id} visible={showTerminal} onToggle={() => setShowTerminal((current) => !current)} needsInput={needsInput.has(selected.id)} />
              </div>
        </section>}
      </main>
    </div>
  );
}
