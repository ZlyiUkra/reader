-- A second database on the same server, `reader_test`, for the tests that need a real PostgreSQL (research R10, T068).
-- The application role cannot delete rows, so rows a test adds would stay for good and would take visible document numbers
-- in the real database. The tests connect to `reader_test` by name and refuse to run anywhere else; the schema is the same
-- file as the real one. Runs once, as the superuser, after 001 and 002 (docker-entrypoint-initdb.d).

CREATE DATABASE reader_test;
REVOKE ALL ON DATABASE reader_test FROM PUBLIC;
GRANT CONNECT ON DATABASE reader_test TO app;

\connect reader_test
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO app;
\ir 002-schema.sql
