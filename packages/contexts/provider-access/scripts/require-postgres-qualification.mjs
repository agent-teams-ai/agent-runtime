// The ordinary synthetic suite may skip the live database test; this gate may not.
if (!process.env.PA_POSTGRES_DISPOSABLE_URL?.trim()) {
  console.error("Provider Access PostgreSQL qualification requires PA_POSTGRES_DISPOSABLE_URL.");
  process.exit(1);
}
