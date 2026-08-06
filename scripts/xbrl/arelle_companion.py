#!/usr/bin/env python3
"""Bounded Arelle companion for the financial-model XBRL protocol.

The process reads exactly one JSON request from stdin and writes exactly one
JSON response to stdout. Arelle and its diagnostics are isolated from stdout so
the TypeScript adapter never has to scrape CLI text.
"""

from __future__ import annotations

import argparse
import contextlib
import datetime as dt
import hashlib
import json
import math
import os
import re
import sys
from collections import Counter
from pathlib import Path
from typing import Any


PROTOCOL_VERSION = 2
STATEMENTS = ("income_statement", "balance_sheet", "cash_flow_statement")
# A statement is suggested only when this share of the table's concepts sits in
# its presentation tree; a raw intersection tags every face table with two.
SUGGESTION_THRESHOLD = 0.3


class CompanionError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str, exit_code: int = 65) -> None:
    sys.stderr.write(json.dumps({"code": code, "message": message}) + "\n")
    raise SystemExit(exit_code)


def read_request() -> dict[str, Any]:
    try:
        request = json.load(sys.stdin)
    except Exception as error:
        raise CompanionError("xbrl_protocol_error", f"stdin is not valid JSON: {error}") from error
    if not isinstance(request, dict) or request.get("protocolVersion") != PROTOCOL_VERSION:
        raise CompanionError("xbrl_protocol_error", f"protocolVersion must be {PROTOCOL_VERSION}")
    if not isinstance(request.get("filings"), list) or not isinstance(request.get("periods"), list):
        raise CompanionError("xbrl_protocol_error", "filings and periods must be arrays")
    for filing in request["filings"]:
        if not isinstance(filing, dict) or not filing.get("accession") or not filing.get("primaryDocumentUrl"):
            raise CompanionError("xbrl_protocol_error", "each filing needs accession and primaryDocumentUrl")
    return request


def validate_fixture(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or value.get("protocolVersion") != PROTOCOL_VERSION:
        raise CompanionError("xbrl_protocol_error", f"fixture protocolVersion must be {PROTOCOL_VERSION}")
    if not isinstance(value.get("filings"), list) or not isinstance(value.get("diagnostics"), list):
        raise CompanionError("xbrl_protocol_error", "fixture must contain filings and diagnostics arrays")
    return value


def qname_text(qname: Any) -> str:
    if qname is None:
        return ""
    prefix = getattr(qname, "prefix", None)
    local = getattr(qname, "localName", None)
    if prefix and local:
        return f"{prefix}:{local}"
    return str(qname)


def qname_label(model_xbrl: Any, qname: Any) -> str:
    concept = getattr(model_xbrl, "qnameConcepts", {}).get(qname)
    if concept is None:
        return qname_text(qname)
    try:
        return concept.label(lang="en-US", strip=True) or qname_text(qname)
    except Exception:
        return qname_text(qname)


def role_label(model_xbrl: Any, role_uri: str) -> str:
    definitions: list[str] = []
    for role_type in getattr(model_xbrl, "roleTypes", {}).get(role_uri, ()):
        definition = getattr(role_type, "definition", None)
        if definition:
            definitions.append(str(definition))
    definitions.append(role_uri.rsplit("/", 1)[-1])
    return " ".join(definitions)


def statement_score(statement: str, label: str) -> int:
    text = " ".join(label.lower().replace("_", "-").split())
    if any(term in text for term in ("parenthetical", "detail", "disclosure", "note")):
        return -1
    if statement == "income_statement":
        if any(term in text for term in ("shareholders equity", "stockholders equity", "comprehensive income")):
            return -1
        return 100 if any(term in text for term in (
            "income statement", "statements of income", "statement of income",
            "statements of operations", "statement of operations", "earnings",
        )) else 0
    if statement == "balance_sheet":
        return 100 if any(term in text for term in ("balance sheet", "financial position")) else 0
    return 100 if any(term in text for term in ("cash flow", "cashflow")) else 0


def relationship_roles(model_xbrl: Any, parent_child: str) -> list[str]:
    base_set = model_xbrl.relationshipSet(parent_child)
    roles = list(getattr(base_set, "linkRoleUris", ()) or ())
    if not roles:
        roles = list(getattr(model_xbrl, "roleTypes", {}).keys())
    return sorted({str(role) for role in roles})


def choose_statement_roles(model_xbrl: Any, parent_child: str) -> dict[str, str]:
    candidates = relationship_roles(model_xbrl, parent_child)
    selected: dict[str, str] = {}
    for statement in STATEMENTS:
        ranked = sorted(
            ((statement_score(statement, role_label(model_xbrl, role)), role) for role in candidates),
            key=lambda entry: (-entry[0], entry[1]),
        )
        if ranked and ranked[0][0] > 0:
            selected[statement] = ranked[0][1]
    return selected


def iso_date(value: Any, subtract_day: bool = False) -> str | None:
    if value is None:
        return None
    if isinstance(value, dt.datetime):
        date = value.date()
    elif isinstance(value, dt.date):
        date = value
    else:
        try:
            date = dt.date.fromisoformat(str(value)[:10])
        except ValueError:
            return None
    if subtract_day:
        date -= dt.timedelta(days=1)
    return date.isoformat()


def matching_periods(context: Any, requested_periods: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Arelle normalizes XBRL instant/end dates to the following midnight.
    if bool(getattr(context, "isInstantPeriod", False)):
        end = iso_date(getattr(context, "instantDatetime", None), subtract_day=True)
        return [period for period in requested_periods if period.get("cls") == "actual" and period.get("end") == end]
    if bool(getattr(context, "isStartEndPeriod", False)):
        start = iso_date(getattr(context, "startDatetime", None))
        end = iso_date(getattr(context, "endDatetime", None), subtract_day=True)
        exact = [period for period in requested_periods if period.get("cls") == "actual"
                 and period.get("start") == start and period.get("end") == end]
        # 52/53-week issuers do not match a synthetic one-year start date. End
        # date plus an annual-duration guard is the deterministic fallback.
        days = None
        if start and end:
            days = (dt.date.fromisoformat(end) - dt.date.fromisoformat(start)).days + 1
        return exact or [period for period in requested_periods if period.get("cls") == "actual"
                         and period.get("end") == end and days is not None and 300 <= days <= 400]
    return []


def period_id(context: Any, requested_periods: list[dict[str, Any]]) -> str | None:
    matches = matching_periods(context, requested_periods)
    return str(matches[0]["id"]) if len(matches) == 1 else None


def period_drop_diagnostics(model_xbrl: Any, requested_periods: list[dict[str, Any]]) -> list[str]:
    """A filing yielding half its facts must not look like correct comparative exclusion."""
    contexts: dict[str, Any] = {}
    for fact in getattr(model_xbrl, "facts", ()) or ():
        context = getattr(fact, "context", None)
        if context is not None:
            contexts.setdefault(str(getattr(context, "id", None) or getattr(fact, "contextID", "")), context)
    counts = Counter(("unmatched_context" if not matches else "ambiguous_period") if len(matches) != 1 else "matched"
                     for matches in (matching_periods(context, requested_periods) for context in contexts.values()))
    return [f"{code}:{counts[code]}" for code in ("unmatched_context", "ambiguous_period") if counts[code]]


def dimensions(model_xbrl: Any, context: Any) -> list[dict[str, str]]:
    result: list[dict[str, str]] = []
    values = getattr(context, "qnameDims", {}) or {}
    for axis_qname, dimension in sorted(values.items(), key=lambda entry: qname_text(entry[0])):
        axis = qname_text(axis_qname)
        if bool(getattr(dimension, "isExplicit", False)):
            member_qname = getattr(dimension, "memberQname", None)
            result.append({
                "axisQName": axis,
                "axisLabel": qname_label(model_xbrl, axis_qname),
                "memberQName": qname_text(member_qname),
                "memberLabel": qname_label(model_xbrl, member_qname),
            })
        else:
            typed_member = getattr(dimension, "typedMember", None)
            typed_value = getattr(typed_member, "stringValue", None) or getattr(dimension, "stringValue", None) or ""
            result.append({
                "axisQName": axis,
                "axisLabel": qname_label(model_xbrl, axis_qname),
                "memberQName": f"{axis}:typed",
                "memberLabel": str(typed_value),
                "typedMemberValue": str(typed_value),
            })
    return result


def unit_value(fact: Any) -> dict[str, str]:
    unit = getattr(fact, "unit", None)
    measures = getattr(unit, "measures", ((), ())) if unit is not None else ((), ())
    numerator = list(measures[0] if len(measures) > 0 else ())
    denominator = list(measures[1] if len(measures) > 1 else ())
    numerator_names = [qname_text(value) for value in numerator]
    denominator_names = [qname_text(value) for value in denominator]
    currency = next((getattr(value, "localName", "") for value in numerator
                     if "iso4217" in str(getattr(value, "namespaceURI", "")).lower()), "")
    if currency and any(name.lower().endswith(":shares") or name.lower() == "shares" for name in denominator_names):
        return {"kind": "per_share", "code": str(currency)}
    if currency and not denominator:
        return {"kind": "currency", "code": str(currency)}
    if len(numerator_names) == 1 and numerator_names[0].lower().endswith("shares") and not denominator:
        return {"kind": "shares"}
    if len(numerator_names) == 1 and numerator_names[0].lower().endswith("pure") and not denominator:
        return {"kind": "ratio"}
    return {"kind": "number"}


def numeric_value(fact: Any) -> float | None:
    if bool(getattr(fact, "isNil", False)):
        return None
    value = getattr(fact, "xValue", None)
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def fact_payload(model_xbrl: Any, fact: Any, filing_url: str, periods: list[dict[str, Any]],
                 occurrence: dict[str, Any] | None = None) -> dict[str, Any] | None:
    context = getattr(fact, "context", None)
    if context is None:
        return None
    matched_period = period_id(context, periods)
    value = numeric_value(fact)
    if matched_period is None or value is None:
        return None
    context_id = str(getattr(context, "id", None) or getattr(fact, "contextID", ""))
    fact_id = str(getattr(fact, "id", None) or "")
    occurrence_id = str((occurrence or {}).get("occurrenceId", ""))
    anchor = (f"{filing_url}#{fact_id}" if fact_id else
              f"{filing_url}#occurrence={occurrence_id}" if occurrence_id else
              f"{filing_url}#context={context_id}")
    payload: dict[str, Any] = {
        "contextId": context_id,
        "periodId": matched_period,
        "value": value,
        "unit": unit_value(fact),
        "dimensions": dimensions(model_xbrl, context),
        "sourceAnchor": anchor,
    }
    if occurrence:
        payload.update(occurrence)
    decimals = getattr(fact, "decimals", None)
    if decimals not in (None, "", "INF", "-INF"):
        try:
            payload["decimals"] = int(decimals)
        except (TypeError, ValueError):
            pass
    return payload


def local_name(element: Any) -> str:
    tag = getattr(element, "tag", "")
    return str(tag).rsplit("}", 1)[-1].lower()


def normalized_text(element: Any) -> str:
    try:
        values = element.itertext()
    except Exception:
        return ""
    return " ".join(" ".join(str(value).split()) for value in values if str(value).strip()).strip()


def nearest_ancestor(element: Any, name: str) -> Any | None:
    current = element
    while current is not None:
        if local_name(current) == name:
            return current
        try:
            current = current.getparent()
        except Exception:
            return None
    return None


def ancestors(element: Any) -> Any:
    current = element
    while current is not None:
        yield current
        try:
            current = current.getparent()
        except Exception:
            return


# Grid expansion below works over the minimal element protocol (tag, attributes,
# iteration over children, itertext) so it is exercisable with stdlib
# ElementTree, not only with the lxml tree Arelle hands back.

NUMERIC_CELL = re.compile(r"^[\s(\[]*[-+]?[$€£¥]?\s*\d[\d,\s]*(?:\.\d+)?\s*[%)\]]*$")
# A bare four-digit run is a column year, not a reported figure.
YEAR_CELL = re.compile(r"^\d{4}$")
LETTER = re.compile(r"[A-Za-z]")
INDENT_STYLE = re.compile(r"(?:padding|margin)-left\s*:\s*(-?\d+(?:\.\d+)?)\s*(pt|px|em|rem|in)", re.I)
# One indent step, per unit, as SEC filers actually emit it.
INDENT_STEP = {"pt": 9.0, "px": 12.0, "em": 1.0, "rem": 1.0, "in": 0.125}
MAX_SPAN = 64


def child_elements(element: Any) -> list[Any]:
    # lxml comments and processing instructions carry a callable tag.
    return [child for child in element if isinstance(getattr(child, "tag", None), str)]


def descend(element: Any, names: tuple[str, ...]) -> list[Any]:
    """Descendants named `names`, never crossing into a nested table."""
    result: list[Any] = []
    for child in child_elements(element):
        name = local_name(child)
        if name == "table":
            continue
        if name in names:
            result.append(child)
        else:
            result.extend(descend(child, names))
    return result


def span_value(element: Any, attribute: str) -> int:
    try:
        value = int(str(element.get(attribute, "1")).strip() or 1)
    except (AttributeError, ValueError):
        return 1
    return min(max(value, 1), MAX_SPAN)


def raw_text(element: Any) -> str:
    try:
        return "".join(str(value) for value in element.itertext())
    except Exception:
        return ""


def indent_level(element: Any) -> int:
    """Presentation evidence only. Indentation never carries accounting meaning."""
    styled = next((match for match in (INDENT_STYLE.search(str(node.get("style", "") or ""))
                                       for node in element.iter()) if match), None)
    level = max(int(float(styled.group(1)) / INDENT_STEP[styled.group(2).lower()]), 0) if styled else 0
    text = raw_text(element)
    return max(level, (len(text) - len(text.lstrip("\xa0 \t\r\n"))) // 2)


def expand_table(table: Any) -> dict[str, Any]:
    """Expand colspan/rowspan into a matrix so columnIndex is comparable across rows."""
    carried: dict[int, dict[int, dict[str, Any]]] = {}
    rows: list[dict[str, Any]] = []
    for row_index, row in enumerate(descend(table, ("tr",))):
        occupied = carried.pop(row_index, {})
        column = 0
        for element in descend(row, ("td", "th")):
            while column in occupied:
                column += 1
            colspan, rowspan = span_value(element, "colspan"), span_value(element, "rowspan")
            text = normalized_text(element)
            for offset in range(rowspan):
                target = occupied if offset == 0 else carried.setdefault(row_index + offset, {})
                for step in range(colspan):
                    target[column + step] = {"columnIndex": column + step, "text": text, "element": element,
                                             "header": local_name(element) == "th"}
            column += colspan
        ordered = [occupied[index] for index in sorted(occupied)]
        label = next((cell for cell in ordered if LETTER.search(cell["text"])), None)
        rows.append({
            "order": row_index + 1,
            "labelText": label["text"] if label else "",
            "indentLevel": indent_level(label["element"]) if label else 0,
            "labelColumnIndex": label["columnIndex"] if label else None,
            "cells": ordered,
        })
    return {"columns": grid_columns(rows), "rows": rows}


def header_row_count(rows: list[dict[str, Any]]) -> int:
    """Leading `th` rows when the filer marked them up; SEC filers mostly do not,
    so fall back to leading rows carrying no reported figure."""
    marked = next((index for index, row in enumerate(rows)
                   if not any(cell["header"] for cell in row["cells"] if cell["text"])), 0)
    if marked:
        return marked
    return next((index for index, row in enumerate(rows)
                 if any(NUMERIC_CELL.match(cell["text"]) and not YEAR_CELL.match(cell["text"])
                        for cell in row["cells"])), len(rows))


def grid_columns(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    width = max((cell["columnIndex"] for row in rows for cell in row["cells"]), default=-1) + 1
    first_data = header_row_count(rows)
    counts = Counter(row["labelColumnIndex"] for row in (rows[first_data:] or rows)
                     if row["labelColumnIndex"] is not None)
    label_column = min((index for index, count in counts.items() if count == max(counts.values())), default=0) if counts else 0
    columns: list[dict[str, Any]] = []
    for index in range(width):
        parts: list[str] = []
        for row in rows[:first_data]:
            text = next((cell["text"] for cell in row["cells"] if cell["columnIndex"] == index), "")
            if text and text not in parts:
                parts.append(text)
        columns.append({"index": index, "headerText": " ".join(parts), "isLabelColumn": index == label_column})
    return columns


def serialize_cell(cell: dict[str, Any]) -> dict[str, Any]:
    payload = {"columnIndex": cell["columnIndex"], "text": cell["text"]}
    if cell.get("fact"):
        payload["fact"] = cell["fact"]
    return payload


def serialize_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [{"order": row["order"], "labelText": row["labelText"], "indentLevel": row["indentLevel"],
             "cells": [serialize_cell(cell) for cell in row["cells"]]} for row in rows]


# `\b` cannot match between "sheet" and "S", so the old singular-only pattern
# missed BALANCE SHEETS — the single most important table in the filing.
HEADING_TERMS = re.compile(r"\b(statements?|balance\s+sheets?|cash\s+flows?|operations|notes?)\b", re.I)


def heading_text(element: Any) -> str:
    # SEC headings are dense with &nbsp;, which \s in the term pattern must not meet.
    return " ".join(raw_text(element).replace("\xa0", " ").split())


def element_parent(element: Any, parents: dict[int, Any] | None) -> Any | None:
    if parents is not None:
        return parents.get(id(element))
    try:
        return element.getparent()
    except Exception:
        return None


def previous_sibling(element: Any, parents: dict[int, Any] | None) -> Any | None:
    if parents is None:
        try:
            return element.getprevious()
        except Exception:
            return None
    siblings = child_elements(element_parent(element, parents)) if element_parent(element, parents) is not None else []
    index = next((position for position, child in enumerate(siblings) if child is element), 0)
    return siblings[index - 1] if index > 0 else None


def table_heading(table: Any, parents: dict[int, Any] | None = None) -> str:
    for descendant in table.iter():
        if local_name(descendant) == "caption":
            caption = normalized_text(descendant)
            if caption:
                return caption
    # Inline filings commonly place a heading in a div/p immediately before the
    # table. Walk nearby siblings and ancestors without interpreting the text.
    current = table
    for _ in range(4):
        sibling = previous_sibling(current, parents)
        checked = 0
        while sibling is not None and checked < 40:
            text = heading_text(sibling)
            if text and (local_name(sibling) in ("h1", "h2", "h3", "h4", "h5", "h6") or HEADING_TERMS.search(text)):
                return text
            sibling = previous_sibling(sibling, parents)
            checked += 1
        current = element_parent(current, parents)
        if current is None:
            break
    for row in descend(table, ("tr",))[:8]:
        text = heading_text(row)
        if text and HEADING_TERMS.search(text):
            return text
    return ""


def inline_tables(model_xbrl: Any) -> list[Any]:
    result: list[Any] = []
    seen: set[int] = set()
    roots = list(getattr(model_xbrl, "ixdsHtmlElements", ()) or ())
    for root in roots:
        try:
            elements = root.iter()
        except Exception:
            continue
        for element in elements:
            if local_name(element) == "table" and id(element) not in seen:
                seen.add(id(element))
                result.append(element)
    if result:
        return result
    # Non-inline or older Arelle builds may not expose ixdsHtmlElements. Facts
    # still retain their source DOM ancestry, so discover containing tables.
    for fact in getattr(model_xbrl, "facts", ()) or ():
        table = nearest_ancestor(fact, "table")
        if table is not None and id(table) not in seen:
            seen.add(id(table))
            result.append(table)
    return sorted(result, key=lambda table: (int(getattr(table, "sourceline", 0) or 0), id(table)))


def column_period_ids(grid: dict[str, Any]) -> None:
    """Majority vote per column. Ties and empty columns leave periodId absent."""
    votes: dict[int, Counter] = {}
    for row in grid["rows"]:
        for cell in row["cells"]:
            fact = cell.get("fact")
            if fact:
                votes.setdefault(cell["columnIndex"], Counter())[fact["periodId"]] += 1
    for column in grid["columns"]:
        counter = votes.get(column["index"])
        if not counter:
            continue
        ranked = counter.most_common()
        if len(ranked) == 1 or ranked[0][1] > ranked[1][1]:
            column["periodId"] = ranked[0][0]


def extract_tables(model_xbrl: Any, filing: dict[str, Any],
                   periods: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], dict[int, dict[str, Any]]]:
    tables = list(enumerate(inline_tables(model_xbrl), 1))
    table_by_index = dict(tables)
    grids = {index: expand_table(table) for index, table in tables}
    # Nested tables are registered under their own index, so walking a fact's
    # ancestry to the first registered cell lands it in the innermost table.
    cell_by_element: dict[int, tuple[int, dict[str, Any]]] = {}
    for index, _ in tables:
        for row in grids[index]["rows"]:
            for cell in row["cells"]:
                cell_by_element.setdefault(id(cell["element"]), (index, cell))

    # The heading walk climbs ancestors and siblings; a filing has thousands of
    # facts and only hundreds of tables, so resolve it once per table.
    headings: dict[int, str] = {}

    def heading_of(index: int) -> str:
        if index not in headings:
            headings[index] = table_heading(table_by_index[index])
        return headings[index]

    fact_elements: Counter = Counter()
    occurrence_order = 0
    for fact in getattr(model_xbrl, "facts", ()) or ():
        located = next((cell_by_element[id(node)] for node in ancestors(fact) if id(node) in cell_by_element), None)
        if located is None:
            continue
        table_index, cell = located
        fact_elements[table_index] += 1
        occurrence_order += 1
        occurrence_seed = "|".join((filing["accession"], str(table_index), str(occurrence_order),
                                    qname_text(getattr(fact, "qname", None)), str(getattr(fact, "contextID", ""))))
        occurrence = {
            "occurrenceId": "occ-" + hashlib.sha256(occurrence_seed.encode("utf-8")).hexdigest()[:24],
            "sourceTableId": f"{filing['accession']}:html-table:{table_index}",
            "htmlOrder": occurrence_order,
            "nearestHeading": heading_of(table_index),
        }
        payload = fact_payload(model_xbrl, fact, filing["primaryDocumentUrl"], periods, occurrence)
        if payload is None or cell.get("fact"):
            continue
        cell["fact"] = {**payload,
                        "conceptQName": qname_text(getattr(fact, "qname", None)),
                        "conceptLabel": qname_label(model_xbrl, getattr(fact, "qname", None))}

    emitted: list[dict[str, Any]] = []
    for table_index, table in tables:
        # A table whose facts were all dropped by period matching is still
        # emitted with factCount 0 rather than vanishing without a trace.
        if not fact_elements[table_index]:
            continue
        grid = grids[table_index]
        column_period_ids(grid)
        table_dom_id = str(getattr(table, "id", None) or "")
        emitted.append({
            "sourceTableId": f"{filing['accession']}:html-table:{table_index}",
            "accession": filing["accession"],
            "form": filing["form"],
            "filedAt": filing["filedAt"],
            "reportDate": filing["reportDate"],
            "heading": heading_of(table_index),
            "htmlOrder": table_index,
            "sourceAnchor": (f"{filing['primaryDocumentUrl']}#{table_dom_id}" if table_dom_id
                             else f"{filing['primaryDocumentUrl']}#table={table_index}"),
            "prescreen": {"tier": "weak", "presentationOverlap": 0.0, "dimensionlessRatio": 0.0,
                          "periodSpan": 0, "factCount": 0},
            "suggestedStatements": [],
            "columns": grid["columns"],
            "rows": serialize_rows(grid["rows"]),
        })
    return emitted


def table_facts(table: dict[str, Any]) -> list[dict[str, Any]]:
    return [cell["fact"] for row in table["rows"] for cell in row["cells"] if "fact" in cell]


def apply_prescreen(tables: list[dict[str, Any]], concepts_by_statement: dict[str, set[str]]) -> None:
    face_concepts = set().union(*concepts_by_statement.values()) if concepts_by_statement else set()
    for table in tables:
        facts = table_facts(table)
        concepts = {fact["conceptQName"] for fact in facts}
        overlaps = {statement: len(concepts & members) / len(concepts)
                    for statement, members in concepts_by_statement.items() if concepts}
        table["prescreen"] = {
            "tier": "weak",
            "presentationOverlap": len(concepts & face_concepts) / len(concepts) if concepts else 0.0,
            "dimensionlessRatio": sum(1 for fact in facts if not fact["dimensions"]) / len(facts) if facts else 0.0,
            "periodSpan": len({fact["periodId"] for fact in facts}),
            "factCount": len(facts),
        }
        prescreen = table["prescreen"]
        if (prescreen["presentationOverlap"] >= 0.5 and prescreen["dimensionlessRatio"] >= 0.8
                and prescreen["periodSpan"] >= 1):
            prescreen["tier"] = "strong"
        table["suggestedStatements"] = [statement for statement, _ in sorted(
            ((statement, overlap) for statement, overlap in overlaps.items() if overlap >= SUGGESTION_THRESHOLD),
            key=lambda entry: (-entry[1], STATEMENTS.index(entry[0])))]


def calculation_relations(model_xbrl: Any, summation_item: str) -> list[dict[str, Any]]:
    """Relationships only; the roll-up arithmetic is unit-testable TypeScript."""
    relations: list[dict[str, Any]] = []
    base_set = model_xbrl.relationshipSet(summation_item)
    # No linkRoleUris means the filing ships no calculation linkbase at all,
    # which verification reports as notAvailable rather than as a break.
    for role in sorted({str(role) for role in (getattr(base_set, "linkRoleUris", ()) or ())}):
        by_parent: dict[str, list[dict[str, Any]]] = {}
        for relation in getattr(model_xbrl.relationshipSet(summation_item, role), "modelRelationships", ()) or ():
            parent = qname_text(getattr(getattr(relation, "fromModelObject", None), "qname", None))
            child = qname_text(getattr(getattr(relation, "toModelObject", None), "qname", None))
            if not parent or not child:
                continue
            by_parent.setdefault(parent, []).append({
                "concept": child,
                "weight": float(getattr(relation, "weight", 1) or 0),
                "order": float(getattr(relation, "order", 0) or 0),
            })
        relations.extend({"roleUri": role, "parentConcept": parent,
                          "children": sorted(by_parent[parent], key=lambda child: (child["order"], child["concept"]))}
                         for parent in sorted(by_parent))
    return relations


def sorted_relationships(relationship_set: Any, concept: Any) -> list[Any]:
    relationships = list(relationship_set.fromModelObject(concept) or ())
    return sorted(relationships, key=lambda relation: (
        float(getattr(relation, "order", 0) or 0),
        qname_text(getattr(getattr(relation, "toModelObject", None), "qname", None)),
    ))


def presentation_evidence(relationship_set: Any) -> tuple[set[str], set[str]]:
    """Concept membership drives pre-screening; preferred labels remain auxiliary."""
    concepts: set[str] = set()
    negated: set[str] = set()
    active: set[int] = set()

    def visit(concept: Any) -> None:
        identity = id(concept)
        if identity in active:
            return
        active.add(identity)
        qname = qname_text(getattr(concept, "qname", None))
        if qname:
            concepts.add(qname)
        for relationship in sorted_relationships(relationship_set, concept):
            child = getattr(relationship, "toModelObject", None)
            if child is not None:
                child_qname = qname_text(getattr(child, "qname", None))
                preferred = str(getattr(relationship, "preferredLabel", "") or "").lower()
                if child_qname and "negated" in preferred:
                    negated.add(child_qname)
                visit(child)
        active.remove(identity)

    roots = sorted(list(getattr(relationship_set, "rootConcepts", ()) or ()), key=lambda concept: qname_text(concept.qname))
    for root in roots:
        visit(root)
    return concepts, negated


def model_diagnostics(model_xbrl: Any) -> list[str]:
    return sorted({str(error) for error in (getattr(model_xbrl, "errors", ()) or ())})


def extract_filing(model_manager: Any, parent_child: str, summation_item: str, filing: dict[str, Any],
                   periods: list[dict[str, Any]]) -> dict[str, Any]:
    model_xbrl = None
    try:
        model_xbrl = model_manager.load(filing["primaryDocumentUrl"])
        if model_xbrl is None or getattr(model_xbrl, "modelDocument", None) is None:
            raise CompanionError("xbrl_load_failed", "Arelle did not load an instance document")
        tables = extract_tables(model_xbrl, filing, periods)
        concepts_by_statement: dict[str, set[str]] = {}
        negated_concepts: set[str] = set()
        for statement, role_uri in choose_statement_roles(model_xbrl, parent_child).items():
            relationship_set = model_xbrl.relationshipSet(parent_child, role_uri)
            concepts, negated = presentation_evidence(relationship_set)
            concepts_by_statement[statement] = concepts
            negated_concepts.update(negated)
        apply_prescreen(tables, concepts_by_statement)
        diagnostics = model_diagnostics(model_xbrl) + period_drop_diagnostics(model_xbrl, periods)
        missing = [statement for statement in STATEMENTS if statement not in concepts_by_statement]
        if missing:
            # A Part III-only amendment carries no statements at all; reporting
            # that as a role lookup failure reads as an extraction defect.
            diagnostics.append(f"amendment_without_statements:{filing['accession']}"
                               if len(missing) == len(STATEMENTS)
                               and not any(table["prescreen"]["tier"] == "strong" for table in tables)
                               else "statement_role_not_found:" + ",".join(missing))
        return {"filing": filing, "tables": tables,
                "calculationRelations": calculation_relations(model_xbrl, summation_item),
                "negatedConcepts": sorted(negated_concepts), "diagnostics": diagnostics}
    except Exception as error:
        return {"filing": filing, "tables": [], "calculationRelations": [], "negatedConcepts": [],
                "diagnostics": [f"xbrl_extraction_failed:{type(error).__name__}:{error}"]}
    finally:
        if model_xbrl is not None:
            try:
                model_xbrl.close()
            except Exception:
                pass


def extract(request: dict[str, Any]) -> dict[str, Any]:
    try:
        from arelle import Cntlr, ModelManager, XbrlConst
    except ImportError as error:
        raise CompanionError(
            "xbrl_runtime_unavailable",
            "The Python package 'arelle-release' is required by scripts/xbrl/arelle_companion.py",
        ) from error

    controller = Cntlr.Cntlr(logFileName="logToBuffer")
    user_agent = os.environ.get("SEC_USER_AGENT", "").strip()
    if user_agent and getattr(controller, "webCache", None) is not None:
        try:
            controller.webCache.userAgent = user_agent
        except Exception:
            pass
    model_manager = ModelManager.initialize(controller)
    try:
        filings = [extract_filing(model_manager, XbrlConst.parentChild, XbrlConst.summationItem, filing, request["periods"])
                   for filing in request["filings"]]
        return {"protocolVersion": PROTOCOL_VERSION, "filings": filings, "diagnostics": []}
    finally:
        try:
            controller.close()
        except Exception:
            pass


def expand_table_cli() -> dict[str, Any]:
    """Grid expansion over one stdin table, so §5.1 is testable without Arelle or lxml."""
    from xml.etree import ElementTree

    root = ElementTree.fromstring(sys.stdin.read())
    table = root if local_name(root) == "table" else next(
        (node for node in root.iter() if local_name(node) == "table"), None)
    if table is None:
        raise CompanionError("xbrl_protocol_error", "stdin contains no table element")
    # ElementTree has no parent links; supply them so the heading walk, which
    # lxml drives with getparent/getprevious, runs identically here.
    parents = {id(child): node for node in root.iter() for child in child_elements(node)}
    grid = expand_table(table)
    return {"heading": table_heading(table, parents), "columns": grid["columns"], "rows": serialize_rows(grid["rows"])}


def main() -> None:
    parser = argparse.ArgumentParser(description="Arelle JSON companion")
    parser.add_argument("--fixture-response", type=Path, help="emit a checked fixture response; used only by protocol tests")
    parser.add_argument("--expand-table", action="store_true", help="expand one stdin HTML table into grid JSON; debug only")
    args = parser.parse_args()
    try:
        if args.expand_table:
            sys.stdout.write(json.dumps(expand_table_cli(), separators=(",", ":"), allow_nan=False) + "\n")
            return
        request = read_request()
        if args.fixture_response:
            response = validate_fixture(json.loads(args.fixture_response.read_text(encoding="utf-8")))
        else:
            # Some Arelle versions write progress to stdout. Redirect it so stdout
            # remains exactly one protocol response.
            with contextlib.redirect_stdout(sys.stderr):
                response = extract(request)
        sys.stdout.write(json.dumps(response, separators=(",", ":"), allow_nan=False) + "\n")
    except CompanionError as error:
        fail(error.code, str(error), 69 if error.code == "xbrl_runtime_unavailable" else 65)
    except Exception as error:
        fail("xbrl_companion_failed", f"{type(error).__name__}: {error}", 70)


if __name__ == "__main__":
    main()
