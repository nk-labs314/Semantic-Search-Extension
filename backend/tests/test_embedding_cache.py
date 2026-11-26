from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch

import faiss
import numpy as np

from backend.indexing import workspace_indexer as indexer


class EmbeddingCacheTests(TestCase):
    def setUp(self):
        temporary = TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / "sample.py"
        output = self.root / "index"
        paths = patch.multiple(
            indexer,
            OUTPUT_DIR=output,
            INDEX_PATH=output / "index.faiss",
            METADATA_PATH=output / "metadata.json",
            EMBEDDING_CACHE_PATH=output / "embeddings.npz",
        )
        paths.start()
        self.addCleanup(paths.stop)
        signature = patch.object(indexer, "embedding_signature", return_value="model-v1")
        self.signature = signature.start()
        self.addCleanup(signature.stop)
        inference = patch.object(indexer, "embed_functions", side_effect=self.embed)
        self.inference = inference.start()
        self.addCleanup(inference.stop)

    @staticmethod
    def embed(functions):
        vectors = np.zeros((len(functions), indexer.CODEBERT_DIM), dtype=np.float32)
        for vector, function in zip(vectors, functions):
            vector[int(function["code"].rsplit(maxsplit=1)[-1])] = 1
        return vectors

    def update(self, source):
        self.inference.reset_mock()
        self.source.write_text(source, encoding="utf-8")
        indexer.index_single_file(str(self.source), str(self.root))

    def test_edit_add_delete_and_line_changes(self):
        a = "def a():\n    return 1\n"
        b = "def b():\n    return 2\n"
        self.update(a + b)
        self.assertEqual(len(self.inference.call_args.args[0]), 2)

        self.update("\n" + a + b)
        self.inference.assert_not_called()
        self.assertEqual(indexer.load_metadata()[0]["start_line"], 2)

        self.update(a.replace("1", "3") + b)
        self.assertEqual([row["function_name"] for row in self.inference.call_args.args[0]], ["a"])

        self.update(b + "def c():\n    return 4\n")
        self.assertEqual([row["function_name"] for row in self.inference.call_args.args[0]], ["c"])
        self.update("def c():\n    return 4\n")
        self.inference.assert_not_called()
        self.assertEqual([row["function_name"] for row in indexer.load_metadata()], ["c"])
        index = faiss.read_index(str(indexer.INDEX_PATH))
        query = self.embed([{"code": "return 4"}])
        scores, ids = index.search(query, 1)
        self.assertEqual((scores.item(), ids.item(), index.ntotal), (1, 0, 1))

        indexer.delete_file_entries(str(self.source), str(self.root))
        self.inference.assert_not_called()
        self.assertEqual(indexer.load_metadata(), [])
        self.assertFalse(indexer.EMBEDDING_CACHE_PATH.exists())

    def test_full_reindex_reuses_disk_cache_and_invalidates_changed_model(self):
        self.update("def a():\n    return 1\n")
        self.inference.reset_mock()
        indexer.index_workspace(str(self.root))
        self.inference.assert_not_called()

        self.signature.return_value = "model-v2"
        indexer.index_workspace(str(self.root))
        self.inference.assert_called_once()

    def test_corrupt_cache_falls_back_to_embedding(self):
        source = "def a():\n    return 1\n"
        self.update(source)
        indexer.EMBEDDING_CACHE_PATH.write_bytes(b"invalid archive")
        with self.assertLogs(indexer.logger, level="WARNING"):
            self.update(source)
        self.inference.assert_called_once()
        self.update(source)
        self.inference.assert_not_called()
