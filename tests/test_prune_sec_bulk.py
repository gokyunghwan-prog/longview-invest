import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "prune-sec-bulk.py"
SPEC = importlib.util.spec_from_file_location("prune_sec_bulk", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class PruneSecBulkTests(unittest.TestCase):
    def test_facts_pruning_reads_only_target_cik_and_allowed_annual_tags(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "companyfacts.zip"
            targets = root / "ciks.json"
            output = root / "facts.jsonl"
            fact_10k = {
                "end": "2025-12-31",
                "val": 100,
                "accn": "0000000123-26-000001",
                "fy": 2025,
                "fp": "FY",
                "form": "10-K",
                "filed": "2026-02-01",
            }
            fact_8k = {**fact_10k, "form": "8-K", "val": 999}
            fact_10q = {
                **fact_10k,
                "end": "2026-03-31",
                "form": "10-Q",
                "fp": "Q1",
                "val": 120,
                "filed": "2026-05-01",
            }
            payload = {
                "cik": 123,
                "entityName": "Target Corp",
                "facts": {
                    "us-gaap": {
                        "Revenues": {
                            "label": "Revenue",
                            "description": "Revenue",
                            "units": {"USD": [fact_10k, fact_10q, fact_8k]},
                        },
                        "EarningsPerShareDiluted": {
                            "units": {"USD/shares": [{**fact_10k, "val": 3.5}]},
                        },
                        "CustomExtension": {
                            "units": {"USD": [fact_10k]},
                        },
                    },
                    "dei": {
                        "EntityCommonStockSharesOutstanding": {
                            "units": {"shares": [fact_10k, fact_10q]},
                        }
                    },
                },
            }
            with ZipFile(archive, "w") as zipped:
                zipped.writestr("CIK0000000123.json", json.dumps(payload))
                zipped.writestr(
                    "CIK0000000999.json",
                    json.dumps({"cik": 999, "entityName": "Other", "facts": {}}),
                )
            targets.write_text(json.dumps({"ciks": ["123"]}), encoding="utf-8")

            summary = MODULE.prune_archive(
                archive, MODULE.load_target_ciks(targets), output, "facts"
            )
            record = json.loads(output.read_text(encoding="utf-8").strip())

            self.assertEqual(summary["requested"], 1)
            self.assertEqual(summary["found"], 1)
            self.assertEqual(record["cik"], "0000000123")
            concepts = record["data"]["facts"]["us-gaap"]
            self.assertIn("Revenues", concepts)
            self.assertIn("EarningsPerShareDiluted", concepts)
            self.assertNotIn("CustomExtension", concepts)
            kept_facts = concepts["Revenues"]["units"]["USD"]
            self.assertEqual([fact["form"] for fact in kept_facts], ["10-K"])
            shares = record["data"]["facts"]["dei"][
                "EntityCommonStockSharesOutstanding"
            ]["units"]["shares"]
            self.assertEqual([fact["form"] for fact in shares], ["10-K", "10-Q"])
            self.assertFalse((root / "CIK0000000123.json").exists())

    def test_submission_pruning_preserves_column_alignment_and_ignores_missing_cik(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / "submissions.zip"
            output = root / "submissions.jsonl"
            payload = {
                "cik": "0000000123",
                "entityType": "operating",
                "name": "Target Corp",
                "tickers": ["TGT"],
                "exchanges": ["NYSE"],
                "filings": {
                    "recent": {
                        "accessionNumber": ["annual", "owner", "current"],
                        "filingDate": ["2026-02-01", "2026-02-02", "2026-02-03"],
                        "form": ["10-K", "4", "8-K"],
                        "primaryDocument": ["annual.htm", "owner.xml", "current.htm"],
                    }
                },
            }
            with ZipFile(archive, "w") as zipped:
                zipped.writestr("CIK0000000123.json", json.dumps(payload))

            summary = MODULE.prune_archive(
                archive, ["0000000123", "0000000999"], output, "submissions"
            )
            record = json.loads(output.read_text(encoding="utf-8").strip())
            recent = record["data"]["filings"]["recent"]

            self.assertEqual(summary["found"], 1)
            self.assertEqual(summary["missing"], 1)
            self.assertEqual(recent["form"], ["10-K", "8-K"])
            self.assertEqual(recent["accessionNumber"], ["annual", "current"])
            self.assertEqual(recent["primaryDocument"], ["annual.htm", "current.htm"])


if __name__ == "__main__":
    unittest.main()
