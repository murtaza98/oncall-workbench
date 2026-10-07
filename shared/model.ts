export type AlertStatus =
  | 'todo'
  | 'triaging'
  | 'backlog'
  | 'in_progress'
  | 'review'
  | 'merge_deploy_pending'
  | 'done';

export type Workflow = {
  status: AlertStatus;
  updatedAt: string | null;
};

export type LinkedItem = {
  reference: string;
  url: string;
  status: string;
};

export type AlertLinks = {
  jira: LinkedItem[];
  prs: LinkedItem[];
};

export type Alert = {
  id: string;
  kind?: 'slack' | 'jira';
  jira?: { key: string; status: string; type: string };
  pagerDuty?: { status: 'triggered' | 'acknowledged' | 'resolved' | 'unknown'; incidentUrl: string; updatedAt: string | null };
  channelId: string;
  source: string;
  title: string;
  text: string;
  timestamp: string;
  permalink: string;
  hasThread: boolean;
  replyCount: number;
  isAlert: boolean;
  workflow: Workflow;
  links: AlertLinks;
  carriedFromShift?: boolean;
};

export type JiraIssue = {
  key: string;
  summary: string;
  status: string;
  type: string;
  updated: string;
  url: string;
};

export type JiraSprint = {
  id: number;
  name: string;
  startDate: string;
  endDate: string;
};

export type Shift = {
  start: string;
  end: string;
  label: string;
  offset: number;
};

export type AlertsResponse = {
  shift: Shift;
  alerts: Alert[];
  otherPosts: Alert[];
  jiraSprint: JiraSprint | null;
  jiraError: string | null;
  syncedAt: string;
};
