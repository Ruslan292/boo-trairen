#!/usr/bin/env python3
"""Extract the ticket bank and its explicit answer keys from the source DOCX.

Only the Python standard library is required. The original document is never
modified. Unexpected document structure fails before the JSON is replaced.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import re
import tempfile
from xml.etree import ElementTree as ET
from zipfile import BadZipFile, ZipFile


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "Билеты БОО с ответами 2026.docx"
OUTPUT = ROOT / "public" / "questions.json"
W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
TICKET_HEADING = re.compile(r"Билет\s*№\s*([1-9]\d*)")
# Some source options have no space after the dot, and two are inline. A
# decimal such as 1.5 is not an option marker.
OPTION_MARKER = re.compile(r"(?<!\S)([1-9]\d*)\.(?!\d)")


class ExtractionError(ValueError):
    """The source cannot be converted without guessing or dropping content."""


def normalize(text: str) -> str:
    """Remove Word layout whitespace without changing words or punctuation."""
    return " ".join(text.split())


def paragraph_text(paragraph: ET.Element) -> str:
    parts: list[str] = []
    for child in paragraph:
        if child.tag == W + "pPr":
            continue  # Tab-stop definitions are formatting, not text.
        for node in child.iter():
            if node.tag == W + "t":
                parts.append(node.text or "")
            elif node.tag in {W + "tab", W + "br", W + "cr"}:
                parts.append("\n" if node.tag != W + "tab" else "\t")
            elif node.tag == W + "noBreakHyphen":
                parts.append("\N{NON-BREAKING HYPHEN}")
    return "".join(parts)


def cell_text(cell: ET.Element) -> str:
    if cell.find(".//" + W + "tbl") is not None:
        raise ExtractionError("Nested tables are not supported")
    return "\n".join(paragraph_text(p) for p in cell.findall(W + "p"))


def parse_question(row: ET.Element, ticket_id: int, expected_number: int) -> dict:
    location = f"Ticket {ticket_id}, question {expected_number}"
    cells = row.findall(W + "tc")
    if len(cells) != 3:
        raise ExtractionError(f"{location}: expected exactly three cells")
    for cell in cells:
        if any(cell.find(W + "tcPr/" + W + tag) is not None
               for tag in ("gridSpan", "vMerge")):
            raise ExtractionError(f"{location}: merged cells are not supported")

    number_text = normalize(cell_text(cells[0]))
    if number_text != str(expected_number):
        raise ExtractionError(f"{location}: unexpected row number {number_text!r}")

    raw_text = cell_text(cells[1])
    markers = list(OPTION_MARKER.finditer(raw_text))
    if [match.group(1) for match in markers] != ["1", "2", "3"]:
        raise ExtractionError(f"{location}: expected ordered option markers 1., 2., 3.")
    question_text = normalize(raw_text[:markers[0].start()])
    if not question_text:
        raise ExtractionError(f"{location}: empty question text")

    options = []
    for index, marker in enumerate(markers):
        end = markers[index + 1].start() if index + 1 < len(markers) else len(raw_text)
        text = normalize(raw_text[marker.end():end])
        if not text:
            raise ExtractionError(f"{location}: empty option {index + 1}")
        options.append({"id": index + 1, "text": text})
    if len({option["text"] for option in options}) != len(options):
        raise ExtractionError(f"{location}: duplicate option text")

    # Never infer the answer from bold text, option position, or outside sources.
    answer_text = normalize(cell_text(cells[2]))
    if answer_text not in {"1", "2", "3"}:
        raise ExtractionError(f"{location}: invalid explicit answer {answer_text!r}")
    return {
        "id": f"{ticket_id}-{expected_number}",
        "number": expected_number,
        "text": question_text,
        "options": options,
        "correctOptionId": int(answer_text),
    }


def parse_document(
    document_xml: bytes,
    source_name: str,
    *,
    expected_ticket_count: int = 20,
    questions_per_ticket: int = 10,
) -> dict:
    try:
        document = ET.fromstring(document_xml)
    except ET.ParseError as error:
        raise ExtractionError(f"Invalid document XML: {error}") from error

    unsupported = {W + name for name in (
        "ins", "del", "moveFrom", "moveTo", "drawing", "pict", "sym",
        "numPr", "instrText", "footnoteReference", "endnoteReference",
    )}
    if any(element.tag in unsupported for element in document.iter()):
        raise ExtractionError("The document contains unsupported content or tracked changes")
    body = document.find(W + "body")
    if body is None:
        raise ExtractionError("The document has no body")

    tickets = []
    pending_ticket: int | None = None
    answer_keys: dict[tuple, tuple[int, str]] = {}
    for element in body:
        if element.tag == W + "p":
            text = normalize(paragraph_text(element))
            if not text:
                continue
            heading = TICKET_HEADING.fullmatch(text)
            if heading is None:
                raise ExtractionError(f"Unexpected text outside a ticket table: {text!r}")
            if pending_ticket is not None:
                raise ExtractionError(f"Ticket {pending_ticket} has no question table")
            pending_ticket = int(heading.group(1))
            if pending_ticket != len(tickets) + 1:
                raise ExtractionError(f"Unexpected ticket number {pending_ticket}")
        elif element.tag == W + "tbl":
            if pending_ticket is None:
                raise ExtractionError("A question table has no preceding ticket heading")
            rows = element.findall(W + "tr")
            if len(rows) != questions_per_ticket + 1:
                raise ExtractionError(f"Ticket {pending_ticket}: expected {questions_per_ticket} questions")
            headers = [normalize(cell_text(cell)) for cell in rows[0].findall(W + "tc")]
            if headers != ["№", "Вопрос", "Верно"]:
                raise ExtractionError(f"Ticket {pending_ticket}: unexpected table headers {headers!r}")

            questions = [parse_question(row, pending_ticket, number)
                         for number, row in enumerate(rows[1:], 1)]
            for question in questions:
                key = (question["text"], tuple(option["text"] for option in question["options"]))
                answer = question["correctOptionId"]
                previous = answer_keys.get(key)
                if previous is not None and previous[0] != answer:
                    raise ExtractionError(f"Conflicting answer keys for questions {previous[1]} and {question['id']}")
                answer_keys[key] = (answer, question["id"])
            tickets.append({"id": pending_ticket, "questions": questions})
            pending_ticket = None
        elif element.tag != W + "sectPr":
            raise ExtractionError(f"Unsupported body element: {element.tag}")

    if pending_ticket is not None:
        raise ExtractionError(f"Ticket {pending_ticket} has no question table")
    if len(tickets) != expected_ticket_count:
        raise ExtractionError(f"Expected {expected_ticket_count} tickets, found {len(tickets)}")
    return {"source": source_name, "tickets": tickets}


def extract_questions(source: Path) -> dict:
    try:
        with ZipFile(source) as archive:
            document_xml = archive.read("word/document.xml")
    except (BadZipFile, KeyError, OSError) as error:
        raise ExtractionError(f"Cannot read source DOCX: {error}") from error
    return parse_document(document_xml, source.name)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?", default=SOURCE)
    parser.add_argument("--output", type=Path, default=OUTPUT)
    args = parser.parse_args()
    try:
        result = extract_questions(args.source)
    except ExtractionError as error:
        parser.exit(1, f"Extraction failed: {error}\n")

    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=args.output.parent,
                                         prefix=".questions-", suffix=".json", delete=False) as file:
            temporary_path = Path(file.name)
            json.dump(result, file, ensure_ascii=False, indent=2)
            file.write("\n")
        temporary_path.replace(args.output)
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    count = sum(len(ticket["questions"]) for ticket in result["tickets"])
    print(f"Extracted {len(result['tickets'])} tickets / {count} questions to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
