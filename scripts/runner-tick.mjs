// Render cron job: one bounded automation pass per minute (see render.yaml).
// Plain JavaScript so the cron service needs no install or build step.
const origin = process.env.API_ORIGIN?.replace(/\/$/, '');
const secret = process.env.CRON_SECRET;
if (!origin || !secret) {
  console.error('Set API_ORIGIN (the Render API URL) and CRON_SECRET.');
  process.exit(1);
}
const response = await fetch(`${origin}/api/v1/internal/runner/tick`, {
  headers: { Authorization: `Bearer ${secret}` },
  signal: AbortSignal.timeout(60_000)
});
const body = await response.text();
console.log(response.status, body);
if (!response.ok) process.exitCode = 1;
