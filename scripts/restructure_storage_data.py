from __future__ import annotations

import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SOURCE_FILES = [
    ROOT / "src" / "data" / "inventory.json",
    ROOT / "data" / "inventory.shared.json",
]
SETUP_SQL_FILE = ROOT / "supabase" / "setup.sql"
OLD_AREA = "家裡-防潮箱"
NEW_AREA = "家裡-書房"
NEW_LOCATION = "防潮箱 F1 專業防潮櫃"


def quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def array_literal(values: list[str]) -> str:
    if not values:
        return "ARRAY[]::text[]"
    return "ARRAY[" + ", ".join(quote(value) for value in values) + "]::text[]"


def rebuild_search_text(item: dict) -> str:
    parts = [
        item.get("area", ""),
        item.get("location", ""),
        item.get("parentLabel", ""),
        item.get("childLabel", ""),
        item.get("reason", ""),
        item.get("name", ""),
        item.get("stagingNote", ""),
        item.get("llmSuggestion", ""),
        item.get("status", ""),
        *(item.get("aliases", []) or []),
        *(item.get("tags", []) or []),
    ]
    return " ".join(str(part).strip() for part in parts if str(part).strip())


def standardize_item(item: dict) -> dict:
    if item.get("area") == OLD_AREA:
        item["area"] = NEW_AREA
        item["location"] = NEW_LOCATION

    area_tag = item.get("area", "").replace("家裡-", "")
    base_tags = [
        area_tag,
        "防潮箱" if "防潮箱" in item.get("location", "") else "",
        item.get("location", ""),
        item.get("parentLabel", ""),
        item.get("childLabel", ""),
    ]
    merged_tags: list[str] = []
    for tag in [*base_tags, *(item.get("tags", []) or [])]:
        tag = str(tag).strip()
        if not tag:
            continue
        if tag in {"家裡-防潮箱", "F1 專業防潮櫃"}:
            continue
        if tag not in merged_tags:
            merged_tags.append(tag)

    item["tags"] = merged_tags
    item["searchText"] = rebuild_search_text(item)
    return item


def update_source_files() -> list[dict]:
    shared_items: list[dict] = []
    for source_file in SOURCE_FILES:
        items = json.loads(source_file.read_text())
        normalized = [standardize_item(item) for item in items]
        source_file.write_text(json.dumps(normalized, ensure_ascii=False, indent=2) + "\n")
        if source_file.name == "inventory.shared.json":
            shared_items = normalized
    return shared_items


def render_insert_rows(items: list[dict]) -> str:
    rows = []
    for item in items:
        rows.append(
            "("
            + ", ".join(
                [
                    quote(item.get("id", "")),
                    quote(item.get("name", "")),
                    quote(item.get("area", "")),
                    quote(item.get("location", "")),
                    quote(item.get("parentLabel", "")),
                    quote(item.get("childLabel", "")),
                    quote(item.get("reason", "")),
                    array_literal(item.get("aliases", []) or []),
                    array_literal(item.get("tags", []) or []),
                    quote(item.get("searchText", "")),
                    quote(item.get("status", "active")),
                    quote(item.get("stagingNote", "")),
                    quote(item.get("llmSuggestion", "")),
                    quote(item.get("createdAt", "2026-06-24T00:00:00.000Z")),
                    quote(item.get("updatedAt", "2026-06-24T00:00:00.000Z")),
                ]
            )
            + ")"
        )
    return ",\n".join(rows)


def regenerate_setup_sql(items: list[dict]) -> None:
    SETUP_SQL_FILE.parent.mkdir(exist_ok=True)
    sql = f"""create extension if not exists pgcrypto;

create table if not exists public.storage_items (
  id text primary key,
  name text not null,
  area text not null default '',
  location text not null default '',
  parent_label text not null default '',
  child_label text not null default '',
  reason text not null default '',
  aliases text[] not null default '{{}}',
  tags text[] not null default '{{}}',
  search_text text not null default '',
  status text not null default 'active' check (status in ('active', 'staging')),
  staging_note text not null default '',
  llm_suggestion text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.storage_items enable row level security;

drop policy if exists "Public read storage items" on public.storage_items;
drop policy if exists "Public insert storage items" on public.storage_items;
drop policy if exists "Public update storage items" on public.storage_items;
drop policy if exists "Public delete storage items" on public.storage_items;

create policy "Public read storage items"
  on public.storage_items
  for select
  to anon, authenticated
  using (true);

create policy "Public insert storage items"
  on public.storage_items
  for insert
  to anon, authenticated
  with check (true);

create policy "Public update storage items"
  on public.storage_items
  for update
  to anon, authenticated
  using (true)
  with check (true);

create policy "Public delete storage items"
  on public.storage_items
  for delete
  to anon, authenticated
  using (true);

truncate table public.storage_items;

insert into public.storage_items (
  id,
  name,
  area,
  location,
  parent_label,
  child_label,
  reason,
  aliases,
  tags,
  search_text,
  status,
  staging_note,
  llm_suggestion,
  created_at,
  updated_at
)
values
{render_insert_rows(items)}
on conflict (id) do update set
  name = excluded.name,
  area = excluded.area,
  location = excluded.location,
  parent_label = excluded.parent_label,
  child_label = excluded.child_label,
  reason = excluded.reason,
  aliases = excluded.aliases,
  tags = excluded.tags,
  search_text = excluded.search_text,
  status = excluded.status,
  staging_note = excluded.staging_note,
  llm_suggestion = excluded.llm_suggestion,
  created_at = excluded.created_at,
  updated_at = excluded.updated_at;
"""
    SETUP_SQL_FILE.write_text(sql)


def main() -> None:
    items = update_source_files()
    regenerate_setup_sql(items)
    print(f"Updated {len(items)} shared items and regenerated {SETUP_SQL_FILE.name}.")


if __name__ == "__main__":
    main()
