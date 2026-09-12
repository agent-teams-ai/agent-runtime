// The ordinary synthetic suite may skip the database test; this gate may not.
if (!process.env.RS_POSTGRES_DISPOSABLE_URL?.trim()) {
  console.error("Runtime Security PostgreSQL qualification requires RS_POSTGRES_DISPOSABLE_URL.");
  process.exit(1);
}
