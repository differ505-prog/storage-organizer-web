from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DATA_FILE = ROOT / "data" / "inventory.shared.json"


def require_env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing environment variable: {name}")
    return value


def patch_item(base_url: str, api_key: str, item: dict) -> None:
    item_id = urllib.parse.quote(item["id"], safe="")
    payload = json.dumps(
        {
            "area": item["area"],
            "location": item["location"],
            "tags": item["tags"],
            "search_text": item["searchText"],
            "updated_at": item.get("updatedAt", "2026-06-25T00:00:00.000Z"),
        }
    ).encode()
    request = urllib.request.Request(
        f"{base_url}/storage_items?id=eq.{item_id}",
        data=payload,
        method="PATCH",
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Prefer": "return=minimal",
        },
    )
    with urllib.request.urlopen(request) as response:
        response.read()


def fetch_count(base_url: str, api_key: str, *, area: str | None = None, location: str | None = None) -> int:
    query = ["select=id"]
    if area is not None:
        query.append(f"area=eq.{urllib.parse.quote(area, safe='')}")
    if location is not None:
        query.append(f"location=eq.{urllib.parse.quote(location, safe='')}")
    request = urllib.request.Request(
        f"{base_url}/storage_items?{'&'.join(query)}",
        headers={
            "apikey": api_key,
            "Authorization": f"Bearer {api_key}",
        },
    )
    with urllib.request.urlopen(request) as response:
        data = json.loads(response.read().decode())
    return len(data)


def main() -> None:
    supabase_url = require_env("SUPABASE_URL").rstrip("/")
    api_key = require_env("SUPABASE_ANON_KEY")
    base_url = f"{supabase_url}/rest/v1"
    items = json.loads(DATA_FILE.read_text())
    target_items = [item for item in items if item.get("location") == "防潮箱 F1 專業防潮櫃"]

    for item in target_items:
        patch_item(base_url, api_key, item)

    old_count = fetch_count(base_url, api_key, area="家裡-防潮箱")
    new_count = fetch_count(base_url, api_key, location="防潮箱 F1 專業防潮櫃")
    print(json.dumps({"patched": len(target_items), "old_area_count": old_count, "new_location_count": new_count}, ensure_ascii=False))


if __name__ == "__main__":
    main()
