-- ponytail: one Postgres instance, one database per service. Logically isolated
-- (each service only ever connects to its own DB, enforced by PGDATABASE env var),
-- physically shared to keep the kind cluster light. Split into per-service
-- StatefulSets if you need to demonstrate real infrastructure isolation.
CREATE DATABASE authdb;
CREATE DATABASE eventdb;
CREATE DATABASE productdb;
CREATE DATABASE orderdb;
CREATE DATABASE paymentdb;
CREATE DATABASE attendeedb;
CREATE DATABASE promodb;
CREATE DATABASE notifdb;
