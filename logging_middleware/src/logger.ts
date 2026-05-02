import axios from 'axios';

const BASE_URL = 'http://20.207.122.201/evaluation-service';

const AUTH_CONFIG = {
  email: 'hd7685@srmist.edu.in',
  name: 'Hardik Dhawan',
  rollNo: 'RA2311026010043',
  accessCode: 'QkbpxH',
  clientID: '665a2ce2-649a-48a9-ae64-9fa188a81995',
  clientSecret: 'PUSskJCQsDmubUsU',
};

export type Stack = 'backend' | 'frontend';
export type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';
export type Package =
  | 'cache' | 'controller' | 'cron_job' | 'db' | 'domain'
  | 'handler' | 'repository' | 'route' | 'service'
  | 'api' | 'component' | 'hook' | 'page' | 'state' | 'style'
  | 'auth' | 'config' | 'middleware' | 'utils';

let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && now < tokenExpiry - 60) {
    return cachedToken;
  }
  const res = await axios.post(`${BASE_URL}/auth`, AUTH_CONFIG);
  cachedToken = res.data.access_token as string;
  tokenExpiry = res.data.expires_in as number;
  return cachedToken;
}

export async function Log(
  stack: Stack,
  level: Level,
  pkg: Package,
  message: string
): Promise<void> {
  try {
    const token = await getToken();
    await axios.post(
      `${BASE_URL}/logs`,
      { stack, level, package: pkg, message },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch {
    // logging must not disrupt the application
  }
}
