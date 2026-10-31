"""Paths and default settings. Settings live in the DB; these are first-run defaults."""
import os
from pathlib import Path

from dotenv import load_dotenv

# Seed endpoints/keys on first run from a .env: the packaged app passes the one beside the portable exe
# (STUDY_ENV_FILE); in dev it is the repo's gitignored .env.
load_dotenv(os.environ.get("STUDY_ENV_FILE") or Path(__file__).resolve().parents[2] / ".env")

DATA_DIR = Path(os.environ.get("STUDY_DATA_DIR") or Path(os.environ.get("APPDATA", Path.home())) / "StudyApp")


def set_data_dir(path: str | None):
    global DATA_DIR
    if path:
        DATA_DIR = Path(path)


def files_dir() -> Path:
    return DATA_DIR / "files"


def assets_dir() -> Path:
    return DATA_DIR / "assets"


def db_path() -> Path:
    return DATA_DIR / "study.db"


DEFAULT_SETTINGS = {
    "llm_base_url": os.environ.get("LLM_BASE_URL", "http://127.0.0.1:8080/v1"),
    "llm_api_key": os.environ.get("LLM_API_KEY", ""),
    "llm_model": os.environ.get("LLM_MODEL", "qwen3.8-27b"),
    "llm_context": int(os.environ.get("LLM_CONTEXT", 100000)),
    "llm_concurrency": int(os.environ.get("LLM_CONCURRENCY", 1)),
    "embed_base_url": os.environ.get("EMBED_BASE_URL", "http://127.0.0.1:8989/v1"),
    "embed_api_key": os.environ.get("EMBED_API_KEY", ""),
    "embed_model": os.environ.get("EMBED_MODEL", "text-embedding-qwen3-embedding-4b"),
    "embed_batch": 16,
    # Online models (OpenRouter). Off by default: "local" keeps everything on this computer. Chat/generation and
    # embeddings switch independently. The key comes from the gitignored .env, never from source.
    "llm_provider": "local",  # "local" | "openrouter"
    "embed_provider": "local",  # "local" | "openrouter"
    "openrouter_base_url": os.environ.get("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1"),
    "openrouter_api_key": os.environ.get("OPENROUTER_API_KEY", ""),
    "openrouter_model": os.environ.get("OPENROUTER_MODEL", "google/gemma-4-26b-a4b-it:free"),
    "openrouter_embed_model": os.environ.get("OPENROUTER_EMBED_MODEL", "nvidia/nemotron-3.5-embed-1b:free"),
    "openrouter_context": int(os.environ.get("OPENROUTER_CONTEXT", 131072)),
    "openrouter_concurrency": int(os.environ.get("OPENROUTER_CONCURRENCY", 1)),
    # Vision: "off" | "auto" (heuristic) | "all" (every unit with any content)
    "vision_default_topic": "auto",
    "vision_default_reference": "all",
    # Qwen reasoning effort per use: "off" | "low" | "medium" | "xhigh" (the levels the chat template supports)
    "reasoning_levels": ["low", "medium", "xhigh"],
    "chat_reasoning_default": "off",
    "vision_reasoning": "medium",
    "generation_reasoning": "xhigh",
    "marking_reasoning": "xhigh",
    "review_reasoning": "medium",
    "vision_min_images": 2,
    "vision_big_image_area": 0.40,
    "vision_low_text_words": 15,
    "vision_pdf_figure_area": 0.03,
    "vision_pdf_vector_paths": 15,
    # Deterministic exact dedupe
    "dedupe_units": True,
    "strip_repeated_pdf_lines": True,
    # Chunking
    "chunk_target_tokens": 600,
    "chunk_max_slides": 5,
    # Chat tutor: custom rules ("" = built-in default) and style, each 0-2
    "chat_system_prompt": "",
    "chat_assistive": 1,  # show methods / worked steps
    "chat_concise": 1,  # 0 detailed, 1 balanced, 2 concise
    "chat_interactive": 0,  # guide with smaller questions instead of giving answers
    # Files sent straight to the chat (not ingested) must be at most this many words
    "chat_file_word_limit": 12000,
}
