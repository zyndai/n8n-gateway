#!/bin/sh
# Runs once, on the first start of an empty Postgres volume: gives n8n its own database.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE DATABASE "${N8N_DB:-n8n}" OWNER "$POSTGRES_USER";
SQL
