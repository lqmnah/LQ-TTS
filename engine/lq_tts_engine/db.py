from __future__ import annotations

import re
from pathlib import Path

import psycopg
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

SCHEMA_SQL = Path(__file__).with_name("schema.sql")
_SAFE = re.compile(r"^[a-z_][a-z0-9_]*$")


def _check(schema: str) -> str:
    if not _SAFE.match(schema):
        raise ValueError(f"unsafe schema name {schema!r}")
    return schema


def migrate(database_url: str, schema: str) -> None:
    sql = SCHEMA_SQL.read_text().replace("{schema}", _check(schema))
    with psycopg.connect(database_url, autocommit=True) as conn:
        conn.execute(sql)


def make_pool(database_url: str, schema: str, max_size: int = 8) -> ConnectionPool:
    pool = ConnectionPool(
        database_url,
        min_size=1,
        max_size=max_size,
        open=True,
        kwargs={"row_factory": dict_row, "autocommit": True, "options": f"-c search_path={_check(schema)}"},
    )
    pool.wait()
    return pool
