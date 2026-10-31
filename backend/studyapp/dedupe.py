"""Deterministic, exact deduplication. No model is involved in deciding what is a duplicate.

A unit's content key is SHA-256 over its exact text plus the exact bytes-hashes of its images.
Units with neither text nor images are never treated as duplicates."""
import hashlib


def content_hash(text: str, image_hashes: list[str]) -> str:
    h = hashlib.sha256()
    h.update(text.encode("utf-8"))
    for ih in sorted(image_hashes):
        h.update(b"\x00img:" + ih.encode())
    return h.hexdigest()


def is_dedupable(text: str, image_hashes: list[str]) -> bool:
    return bool(text.strip()) or bool(image_hashes)


def find_original(conn, scope_doc_ids: list[int], chash: str) -> int | None:
    """Earliest non-duplicate unit with this exact content hash among the scope's documents."""
    if not scope_doc_ids:
        return None
    marks = ",".join("?" * len(scope_doc_ids))
    row = conn.execute(
        f"SELECT id FROM units WHERE content_hash=? AND duplicate_of IS NULL AND document_id IN ({marks}) ORDER BY id LIMIT 1",
        (chash, *scope_doc_ids)).fetchone()
    return row[0] if row else None
