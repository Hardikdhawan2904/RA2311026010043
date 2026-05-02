import axios from 'axios';
import { Log } from 'logging-middleware';

const BASE_URL = 'http://20.207.122.201/evaluation-service';

const AUTH_CONFIG = {
  email: 'hd7685@srmist.edu.in',
  name: 'Hardik Dhawan',
  rollNo: 'RA2311026010043',
  accessCode: 'QkbpxH',
  clientID: '665a2ce2-649a-48a9-ae64-9fa188a81995',
  clientSecret: 'PUSskJCQsDmubUsU',
};

interface Depot {
  ID: number;
  MechanicHours: number;
}

interface Vehicle {
  TaskID: string;
  Duration: number;
  Impact: number;
}

interface ScheduleResult {
  depotID: number;
  mechanicHours: number;
  selectedTasks: Vehicle[];
  totalDuration: number;
  totalImpact: number;
}

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

function knapsack(
  vehicles: Vehicle[],
  capacity: number
): { selected: Vehicle[]; totalImpact: number; totalDuration: number } {
  const n = vehicles.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(capacity + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    const { Duration: w, Impact: v } = vehicles[i - 1];
    for (let c = 0; c <= capacity; c++) {
      dp[i][c] = dp[i - 1][c];
      if (w <= c) {
        dp[i][c] = Math.max(dp[i][c], dp[i - 1][c - w] + v);
      }
    }
  }

  const selected: Vehicle[] = [];
  let c = capacity;
  for (let i = n; i > 0; i--) {
    if (dp[i][c] !== dp[i - 1][c]) {
      selected.push(vehicles[i - 1]);
      c -= vehicles[i - 1].Duration;
    }
  }

  return {
    selected,
    totalImpact: dp[n][capacity],
    totalDuration: selected.reduce((sum, v) => sum + v.Duration, 0),
  };
}

async function main() {
  await Log('backend', 'info', 'service', 'Vehicle Maintenance Scheduler starting');

  const authToken = await getToken();
  const headers = { Authorization: `Bearer ${authToken}` };

  await Log('backend', 'info', 'service', 'Fetching depots');
  const depotsRes = await axios.get<{ depots: Depot[] }>(
    `${BASE_URL}/depots`,
    { headers }
  );
  const depots = depotsRes.data.depots;
  await Log('backend', 'info', 'service', `Fetched ${depots.length} depots`);

  await Log('backend', 'info', 'service', 'Fetching vehicles');
  const vehiclesRes = await axios.get<{ vehicles: Vehicle[] }>(
    `${BASE_URL}/vehicles`,
    { headers }
  );
  const vehicles = vehiclesRes.data.vehicles;
  await Log('backend', 'info', 'service', `Fetched ${vehicles.length} vehicles`);

  const results: ScheduleResult[] = [];

  for (const depot of depots) {
    await Log(
      'backend',
      'info',
      'service',
      `Solving knapsack for depot ${depot.ID} with budget ${depot.MechanicHours} hours`
    );

    const { selected, totalImpact, totalDuration } = knapsack(
      vehicles,
      depot.MechanicHours
    );

    results.push({
      depotID: depot.ID,
      mechanicHours: depot.MechanicHours,
      selectedTasks: selected,
      totalDuration,
      totalImpact,
    });

    await Log(
      'backend',
      'info',
      'service',
      `Depot ${depot.ID}: ${selected.length} tasks selected, impact=${totalImpact}, duration=${totalDuration}`
    );
  }

  console.log('\n=== Vehicle Maintenance Schedule Results ===\n');
  for (const result of results) {
    console.log(
      `Depot ${result.depotID} | Budget: ${result.mechanicHours}h | Selected: ${result.selectedTasks.length} tasks | Duration: ${result.totalDuration}h | Impact: ${result.totalImpact}`
    );
    for (const task of result.selectedTasks) {
      console.log(
        `  TaskID: ${task.TaskID}  Duration: ${task.Duration}h  Impact: ${task.Impact}`
      );
    }
    console.log();
  }

  await Log('backend', 'info', 'service', 'Vehicle Maintenance Scheduler completed');
}

main().catch(async (err) => {
  await Log('backend', 'fatal', 'service', `Scheduler failed: ${String(err.message)}`);
  console.error(err);
  process.exit(1);
});
