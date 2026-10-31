-- Creates the application role. Runs once, as the superuser, when the data directory is empty
-- (docker-entrypoint-initdb.d). The role is not a superuser, owns nothing and cannot create objects (FR-035).
-- The password comes from the APP_DB_PASSWORD environment variable of the db container; it is never written here.
\set app_password `printenv APP_DB_PASSWORD`

SELECT (:'app_password' <> '') AS password_present \gset
\if :password_present
\else
  DO $do$ BEGIN RAISE EXCEPTION 'APP_DB_PASSWORD is not set for the db container'; END $do$;
\endif

CREATE ROLE app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT PASSWORD :'app_password';

SELECT current_database() AS dbname \gset
REVOKE ALL ON DATABASE :"dbname" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"dbname" TO app;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app;
-- Privileges on the tables are granted at the end of 002-schema.sql, after the tables exist.
