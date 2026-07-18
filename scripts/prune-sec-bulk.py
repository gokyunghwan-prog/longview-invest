#!/usr/bin/env python3
"""Select and compact SEC bulk ZIP members without extracting the archive."""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import tempfile
from typing import Any, Iterable
from zipfile import BadZipFile, ZipFile


ANNUAL_FORMS = {"10-K", "10-K/A", "20-F", "20-F/A", "40-F", "40-F/A"}
PERIODIC_FORMS = ANNUAL_FORMS | {"10-Q", "10-Q/A"}
RELEVANT_FORMS = ANNUAL_FORMS | {
    "10-Q",
    "10-Q/A",
    "8-K",
    "6-K",
    "DEF 14A",
    "NT 10-K",
    "NT 20-F",
}

FACT_TAGS = {
    "us-gaap": {
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "SalesRevenueNet",
        "Revenues",
        "OperatingIncomeLoss",
        "NetIncomeLoss",
        "ProfitLoss",
        "Assets",
        "Liabilities",
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
        "AssetsCurrent",
        "LiabilitiesCurrent",
        "NetCashProvidedByUsedInOperatingActivities",
        "NetCashProvidedByUsedInOperatingActivitiesContinuingOperations",
        "PaymentsToAcquirePropertyPlantAndEquipment",
        "PaymentsForAdditionsToPropertyPlantAndEquipment",
        "PaymentsToAcquireProductiveAssets",
        "EarningsPerShareBasic",
        "EarningsPerShareDiluted",
        "WeightedAverageNumberOfSharesOutstandingBasic",
        "WeightedAverageNumberOfDilutedSharesOutstanding",
        "CommonStockSharesOutstanding",
    },
    "ifrs-full": {
        "Revenue",
        "RevenueFromContractsWithCustomers",
        "OperatingProfitLoss",
        "ProfitLossFromOperatingActivities",
        "ProfitLoss",
        "Assets",
        "Liabilities",
        "Equity",
        "CurrentAssets",
        "CurrentLiabilities",
        "CashFlowsFromUsedInOperatingActivities",
        "CashFlowsFromUsedInOperatingActivitiesContinuingOperations",
        "PurchaseOfPropertyPlantAndEquipment",
        "PurchaseOfPropertyPlantAndEquipmentClassifiedAsInvestingActivities",
        "PurchaseOfPropertyPlantAndEquipmentIntangibleAssetsOtherThanGoodwillInvestmentPropertyAndOtherNoncurrentAssets",
        "BasicEarningsLossPerShare",
        "DilutedEarningsLossPerShare",
        "WeightedAverageShares",
        "AdjustedWeightedAverageShares",
    },
    "dei": {"EntityCommonStockSharesOutstanding"},
}

PERIODIC_SHARE_TAGS = {
    "CommonStockSharesOutstanding",
    "EntityCommonStockSharesOutstanding",
}

SUBMISSION_FIELDS = {
    "cik",
    "entityType",
    "sic",
    "sicDescription",
    "ownerOrg",
    "name",
    "tickers",
    "exchanges",
    "ein",
    "description",
    "website",
    "investorWebsite",
    "category",
    "fiscalYearEnd",
    "stateOfIncorporation",
    "stateOfIncorporationDescription",
}

RECENT_FIELDS = {
    "accessionNumber",
    "filingDate",
    "reportDate",
    "acceptanceDateTime",
    "act",
    "form",
    "fileNumber",
    "filmNumber",
    "items",
    "size",
    "isXBRL",
    "isInlineXBRL",
    "primaryDocument",
    "primaryDocDescription",
}


def normalize_cik(value: Any) -> str | None:
    digits = "".join(character for character in str(value) if character.isdigit())
    if not digits or len(digits) > 10:
        return None
    return digits.zfill(10)


def load_target_ciks(path: Path) -> list[str]:
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return []

    try:
        payload = json.loads(text)
        if isinstance(payload, dict):
            values: Iterable[Any] = payload.get("ciks", [])
        elif isinstance(payload, list):
            values = payload
        else:
            values = [payload]
    except json.JSONDecodeError:
        values = (line.strip() for line in text.splitlines() if line.strip())

    return sorted({cik for value in values if (cik := normalize_cik(value))})


def _fact_order(fact: dict[str, Any]) -> tuple[str, str, str, str]:
    return (
        str(fact.get("end") or ""),
        str(fact.get("filed") or ""),
        str(fact.get("accn") or ""),
        str(fact.get("start") or ""),
    )


def prune_facts(payload: dict[str, Any], facts_per_unit: int = 24) -> dict[str, Any]:
    pruned_taxonomies: dict[str, Any] = {}
    source_taxonomies = payload.get("facts") if isinstance(payload.get("facts"), dict) else {}

    for taxonomy, allowed_tags in FACT_TAGS.items():
        source_concepts = source_taxonomies.get(taxonomy)
        if not isinstance(source_concepts, dict):
            continue

        concepts: dict[str, Any] = {}
        for tag in sorted(allowed_tags):
            source_concept = source_concepts.get(tag)
            if not isinstance(source_concept, dict):
                continue
            source_units = source_concept.get("units")
            if not isinstance(source_units, dict):
                continue

            units: dict[str, Any] = {}
            for unit, source_facts in source_units.items():
                if not isinstance(source_facts, list):
                    continue
                allowed_forms = (
                    PERIODIC_FORMS if tag in PERIODIC_SHARE_TAGS else ANNUAL_FORMS
                )
                annual = [
                    fact
                    for fact in source_facts
                    if isinstance(fact, dict)
                    and fact.get("form") in allowed_forms
                    and fact.get("end")
                    and isinstance(fact.get("val"), (int, float))
                ]
                if annual:
                    units[str(unit)] = sorted(annual, key=_fact_order)[-facts_per_unit:]

            if units:
                concepts[tag] = {
                    "label": source_concept.get("label"),
                    "description": source_concept.get("description"),
                    "units": units,
                }

        if concepts:
            pruned_taxonomies[taxonomy] = concepts

    return {
        "cik": payload.get("cik"),
        "entityName": payload.get("entityName"),
        "facts": pruned_taxonomies,
    }


def prune_submissions(payload: dict[str, Any], filing_limit: int = 24) -> dict[str, Any]:
    pruned = {field: payload.get(field) for field in SUBMISSION_FIELDS if field in payload}
    recent = payload.get("filings", {}).get("recent", {})
    forms = recent.get("form") if isinstance(recent, dict) else []
    forms = forms if isinstance(forms, list) else []
    selected = [
        index for index, form in enumerate(forms) if form in RELEVANT_FORMS
    ][:filing_limit]

    compact_recent: dict[str, list[Any]] = {}
    for field in sorted(RECENT_FIELDS):
        values = recent.get(field)
        if not isinstance(values, list):
            continue
        compact_recent[field] = [
            values[index] if index < len(values) else None for index in selected
        ]

    pruned["filings"] = {"recent": compact_recent}
    return pruned


def prune_archive(
    archive_path: Path,
    target_ciks: Iterable[str],
    output_path: Path,
    kind: str,
    max_entry_bytes: int = 128 * 1024 * 1024,
) -> dict[str, int | str]:
    ciks = sorted(set(target_ciks))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    found = 0
    missing = 0
    unreadable = 0
    oversized = 0

    temporary_name: str | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            newline="\n",
            prefix=output_path.name + ".",
            suffix=".tmp",
            dir=output_path.parent,
            delete=False,
        ) as output:
            temporary_name = output.name
            with ZipFile(archive_path) as archive:
                for cik in ciks:
                    member_name = f"CIK{cik}.json"
                    try:
                        member = archive.getinfo(member_name)
                    except KeyError:
                        missing += 1
                        continue

                    if member.file_size > max_entry_bytes:
                        oversized += 1
                        continue

                    try:
                        with archive.open(member) as source:
                            with io.TextIOWrapper(source, encoding="utf-8") as text_source:
                                payload = json.load(text_source)
                        compact = (
                            prune_facts(payload)
                            if kind == "facts"
                            else prune_submissions(payload)
                        )
                        output.write(
                            json.dumps(
                                {"cik": cik, "data": compact},
                                ensure_ascii=False,
                                separators=(",", ":"),
                            )
                            + "\n"
                        )
                        found += 1
                    except (BadZipFile, UnicodeDecodeError, json.JSONDecodeError, OSError, RuntimeError):
                        unreadable += 1

            output.flush()
            os.fsync(output.fileno())

        os.replace(temporary_name, output_path)
        temporary_name = None
    finally:
        if temporary_name:
            try:
                os.unlink(temporary_name)
            except FileNotFoundError:
                pass

    return {
        "kind": kind,
        "requested": len(ciks),
        "found": found,
        "missing": missing,
        "unreadable": unreadable,
        "oversized": oversized,
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read only selected SEC CIK JSON members and write compact JSONL."
    )
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--ciks", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--kind", required=True, choices=("facts", "submissions"))
    parser.add_argument("--max-entry-bytes", type=int, default=128 * 1024 * 1024)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    target_ciks = load_target_ciks(args.ciks)
    summary = prune_archive(
        args.archive,
        target_ciks,
        args.output,
        args.kind,
        args.max_entry_bytes,
    )
    print(json.dumps(summary, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
