import express from 'express';
import axios from 'axios';
import { Log } from 'logging-middleware';

const app = express();
const PORT = 3002;

const BASE_URL = 'http://20.207.122.201/evaluation-service';

const AUTH_CONFIG = {
  email: 'hd7685@srmist.edu.in',
  name: 'Hardik Dhawan',
  rollNo: 'RA2311026010043',
  accessCode: 'QkbpxH',
  clientID: '665a2ce2-649a-48a9-ae64-9fa188a81995',
  clientSecret: 'PUSskJCQsDmubUsU',
};

interface Notification {
  ID: string;
  Type: 'Placement' | 'Result' | 'Event';
  Message: string;
  Timestamp: string;
}

interface ScoredNotification extends Notification {
  priorityScore: number;
}

const TYPE_WEIGHT: Record<string, number> = {
  Placement: 3,
  Result: 2,
  Event: 1,
};

let token: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (token && now < tokenExpiry - 60) return token;
  const res = await axios.post(`${BASE_URL}/auth`, AUTH_CONFIG);
  token = res.data.access_token as string;
  tokenExpiry = res.data.expires_in as number;
  return token;
}

function getTopNotifications(
  notifications: Notification[],
  topN: number
): ScoredNotification[] {
  const timestamps = notifications.map((n) => new Date(n.Timestamp).getTime());
  const minTs = Math.min(...timestamps);
  const maxTs = Math.max(...timestamps);
  const tsRange = maxTs - minTs || 1;

  const scored: ScoredNotification[] = notifications.map((n) => {
    const normalizedWeight = (TYPE_WEIGHT[n.Type] - 1) / 2;
    const normalizedRecency = (new Date(n.Timestamp).getTime() - minTs) / tsRange;
    const priorityScore = 0.6 * normalizedWeight + 0.4 * normalizedRecency;
    return { ...n, priorityScore };
  });

  scored.sort((a, b) => b.priorityScore - a.priorityScore);
  return scored.slice(0, topN);
}

app.get('/notifications', async (req, res) => {
  const n = parseInt((req.query.n as string) ?? '10', 10);
  await Log('backend', 'info', 'route', `GET /notifications?n=${n} request received`);

  const authToken = await getToken();
  const headers = { Authorization: `Bearer ${authToken}` };

  await Log('backend', 'info', 'api', 'Fetching notifications from evaluation service');
  const result = await axios.get<{ notifications: Notification[] }>(
    `${BASE_URL}/notifications`,
    { headers }
  );
  const notifications = result.data.notifications;
  await Log('backend', 'info', 'api', `Received ${notifications.length} notifications`);

  const top = getTopNotifications(notifications, n);
  await Log('backend', 'info', 'service', `Returning top ${top.length} priority notifications`);

  res.json({ count: top.length, notifications: top });
});

app.listen(PORT, async () => {
  await Log('backend', 'info', 'service', `Notification App running on port ${PORT}`);
  console.log(`Notification App running on http://localhost:${PORT}`);
});
