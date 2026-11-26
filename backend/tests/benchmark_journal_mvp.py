"""Repeatable 30-query retrieval benchmark for the local journal_mvp codebase."""
from __future__ import annotations

import json
import time
from dataclasses import dataclass
from pathlib import Path

from backend.api.app import embed_query
from backend.indexing.workspace_indexer import (
    build_faiss_index,
    embed_functions,
    extract_all_functions,
)
from backend.tests.test_retrieval_metrics import median_latency_ms, recall_at_k


TARGET_ROOT = Path(__file__).resolve().parents[3] / "journal" / "journal_mvp"


@dataclass(frozen=True)
class BenchmarkCase:
    query: str
    file_path: str
    function_name: str


CASES = (
    BenchmarkCase("register a new user account with a password", "services/auth_service.py", "create_user"),
    BenchmarkCase("check a username and password during sign in", "services/auth_service.py", "verify_user"),
    BenchmarkCase("save a daily mood score for a user", "services/data_service.py", "insert_mood_log"),
    BenchmarkCase("record a user behaviour measurement", "services/data_service.py", "insert_behavior_log"),
    BenchmarkCase("load the latest mood records for a person", "services/data_service.py", "get_recent_mood"),
    BenchmarkCase("retrieve recent behaviour observations", "services/data_service.py", "get_recent_behavior"),
    BenchmarkCase("list every journal entry belonging to a user", "services/data_service.py", "get_all_journals"),
    BenchmarkCase("save a vector representation for a journal entry", "services/data_service.py", "insert_embedding"),
    BenchmarkCase("find the newest saved log identifier", "services/data_service.py", "get_last_log_id"),
    BenchmarkCase("load stored embedding vectors for one user", "services/data_service.py", "get_embeddings_for_user"),
    BenchmarkCase("turn one sentence into a normalized embedding vector", "services/embedding_service.py", "embed"),
    BenchmarkCase("encode many pieces of text as vectors", "services/embedding_service.py", "embed_batch"),
    BenchmarkCase("calculate cosine similarity between two vectors", "services/embedding_service.py", "similarity"),
    BenchmarkCase("find journal entries relevant to a question", "services/rag_service.py", "retrieve"),
    BenchmarkCase("write a chat reply using retrieved journals and forecasts", "services/rag_service.py", "generate"),
    BenchmarkCase("measure sentiment in a journal passage", "services/insight_service.py", "analyze_sentiment"),
    BenchmarkCase("explain whether two wellbeing signals are correlated", "services/insight_service.py", "interpret_correlation"),
    BenchmarkCase("detect whether a person's mood is improving or worsening", "services/insight_service.py", "detect_mood_trend"),
    BenchmarkCase("analyze behaviour patterns and their effects", "services/insight_service.py", "analyze_behavior"),
    BenchmarkCase("split journal text into useful tokens", "models/lexicon_model.py", "tokenize"),
    BenchmarkCase("build a shared mood word lexicon from training data", "models/lexicon_model.py", "build_global_lexicon"),
    BenchmarkCase("create a personal word lexicon for a user", "models/lexicon_model.py", "build_user_lexicon"),
    BenchmarkCase("look up the mood score for a particular word", "models/lexicon_model.py", "get_word_score"),
    BenchmarkCase("predict mood directly from text", "models/lexicon_model.py", "predict_mood_from_text"),
    BenchmarkCase("assemble numerical inputs for a forecasting model", "models/feature_builder.py", "build_features"),
    BenchmarkCase("make future prediction labels for a time series", "models/forecasting.py", "build_target"),
    BenchmarkCase("train a model to forecast multiple future horizons", "models/forecasting.py", "train_multi_horizon_forecast"),
    BenchmarkCase("calculate the data behind the user dashboard", "services/analytics_service.py", "compute_dashboard_analysis"),
    BenchmarkCase("produce a human-readable dashboard summary", "services/analytics_service.py", "generate_summary"),
    BenchmarkCase("generate a synthetic series of mood measurements", "dataset_generation/data_generator.py", "generate_mood_series"),
)


def identifier(item: dict[str, object]) -> str:
    return f'{item["file_path"]}::{item["function_name"]}::{item["start_line"]}'


def run(samples_per_query: int = 10) -> dict[str, object]:
    if samples_per_query < 1:
        raise ValueError("samples_per_query must be at least 1")
    if not TARGET_ROOT.is_dir():
        raise RuntimeError(f"Benchmark codebase is unavailable: {TARGET_ROOT}")

    metadata = extract_all_functions(str(TARGET_ROOT))
    index = build_faiss_index(embed_functions(metadata))
    expected = []
    for case in CASES:
        matches = [
            identifier(item)
            for item in metadata
            if item["file_path"] == case.file_path
            and item["function_name"] == case.function_name
        ]
        if len(matches) != 1:
            raise RuntimeError(f"Expected one benchmark target for {case}, found {len(matches)}")
        expected.append(matches[0])

    # Load the model and warm its execution path before timing.
    embed_query(CASES[0].query)
    retrieved: list[list[str]] = []
    latency_samples: list[float] = []
    misses: list[dict[str, object]] = []

    for case, target in zip(CASES, expected):
        query_vector = embed_query(case.query)
        _, indices = index.search(query_vector, 5)
        results = [identifier(metadata[idx]) for idx in indices[0] if idx != -1]
        retrieved.append(results)

        for _ in range(samples_per_query):
            start = time.perf_counter()
            query_vector = embed_query(case.query)
            index.search(query_vector, 5)
            latency_samples.append((time.perf_counter() - start) * 1000)

        if target not in results[:5]:
            misses.append({"query": case.query, "expected": target, "returned": results})

    return {
        "codebase": str(TARGET_ROOT),
        "indexed_functions": len(metadata),
        "queries": len(CASES),
        "samples_per_query": samples_per_query,
        "recall_at_1": sum(recall_at_k(found, {target}, 1) for found, target in zip(retrieved, expected)) / len(CASES),
        "recall_at_3": sum(recall_at_k(found, {target}, 3) for found, target in zip(retrieved, expected)) / len(CASES),
        "recall_at_5": sum(recall_at_k(found, {target}, 5) for found, target in zip(retrieved, expected)) / len(CASES),
        "median_latency_ms": median_latency_ms(latency_samples),
        "timed_requests": len(latency_samples),
        "top_5_misses": misses,
    }


if __name__ == "__main__":
    print(json.dumps(run(), indent=2))

