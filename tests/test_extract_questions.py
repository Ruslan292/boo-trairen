"""Validate source fidelity, safe deduplication and stable progress aliases."""

from copy import deepcopy
import importlib.util
import json
from pathlib import Path
import re
import unittest
from xml.etree import ElementTree as ET
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("extract_questions", ROOT / "scripts" / "extract_questions.py")
extract = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extract)
W = extract.W


class ExtractionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with ZipFile(extract.SOURCE) as archive:
            cls.document = ET.fromstring(archive.read("word/document.xml"))
        cls.raw_bank = extract.parse_document(ET.tostring(cls.document), extract.SOURCE.name)
        cls.bank = extract.extract_questions(extract.SOURCE)

    def parse_changed(self, change):
        document = deepcopy(self.document)
        change(document)
        return extract.parse_document(ET.tostring(document), extract.SOURCE.name)

    def test_all_original_questions_are_strictly_read_before_deduplication(self):
        self.assertEqual([ticket["id"] for ticket in self.raw_bank["tickets"]], list(range(1, 21)))
        questions = [question for ticket in self.raw_bank["tickets"] for question in ticket["questions"]]
        self.assertEqual(len(questions), 200)
        self.assertEqual(len({question["id"] for question in questions}), 200)
        # Independently compare every answer with the explicit "Верно" column.
        rows = [row for table in self.document.find(W + "body").findall(W + "tbl")
                for row in table.findall(W + "tr")[1:]]
        for question, row in zip(questions, rows):
            source_answer = "".join(node.text or "" for node in row.findall(W + "tc")[2].iter(W + "t"))
            self.assertEqual(question["correctOptionId"], int(source_answer.strip()))
            # Reconstruct the full question cell without its option numbers.
            # This catches words lost at run boundaries or continuation lines.
            source_text = "\n".join(
                "".join(node.text or "" for node in paragraph.iter(W + "t"))
                for paragraph in row.findall(W + "tc")[1].findall(W + "p")
            )
            unnumbered = re.sub(r"(?<!\S)[123]\.(?!\d)", "", source_text)
            extracted_text = " ".join([question["text"], *(option["text"] for option in question["options"])])
            self.assertEqual(" ".join(unnumbered.split()), extracted_text)

    def test_generated_bank_traces_every_original_question_and_answer(self):
        saved = json.loads(extract.OUTPUT.read_text(encoding="utf-8"))
        self.assertEqual(saved, self.bank)
        self.assertEqual(self.bank["metadata"], {
            "schemaVersion": 2,
            "originalTicketCount": 20,
            "originalQuestionCount": 200,
            "uniqueQuestionCount": 116,
            "duplicatesRemoved": 84,
            "questionsPerTicket": 10,
        })
        self.assertEqual([ticket["id"] for ticket in self.bank["tickets"]], list(range(1, 13)))
        self.assertEqual([len(ticket["questions"]) for ticket in self.bank["tickets"]], [10] * 11 + [6])
        originals = {question["id"]: question for ticket in self.raw_bank["tickets"]
                     for question in ticket["questions"]}
        refs = []
        canonical_ids = []
        for ticket in self.bank["tickets"]:
            for number, question in enumerate(ticket["questions"], 1):
                self.assertEqual(question["number"], number)
                self.assertEqual(question["id"], question["aliases"][0])
                self.assertEqual(question["aliases"], [ref["id"] for ref in question["sourceRefs"]])
                canonical_ids.append(question["id"])
                first = originals[question["id"]]
                self.assertEqual(question["text"], first["text"])
                self.assertEqual(question["options"], first["options"])
                for ref in question["sourceRefs"]:
                    self.assertEqual(ref["id"], f"{ref['ticketId']}-{ref['questionNumber']}")
                    original = originals[ref["id"]]
                    self.assertEqual(original["number"], ref["questionNumber"])
                    self.assertEqual(question["text"].casefold().removesuffix("?").rstrip(),
                                     original["text"].casefold().removesuffix("?").rstrip())
                    self.assertEqual([option["text"].casefold() for option in question["options"]],
                                     [option["text"].casefold() for option in original["options"]])
                    self.assertEqual(question["correctOptionId"], original["correctOptionId"])
                    refs.append(ref["id"])
        self.assertEqual(len(refs), 200)
        self.assertEqual(set(refs), set(originals))
        self.assertEqual(len(set(canonical_ids)), 116)
        # First occurrences keep their original order and IDs across regeneration.
        self.assertEqual(canonical_ids, sorted(canonical_ids, key=lambda value: tuple(map(int, value.split("-")))))

    def test_inline_options_and_wrapped_paragraphs_keep_all_words(self):
        question = self.raw_bank["tickets"][10]["questions"][6]
        self.assertEqual(question["text"], "Для эффективного поражения цели предполагается ведение огня (в зависимости от дистанции):")
        self.assertEqual(question["options"][0]["text"], "На дистанции, не превышающей рекомендуемую для данного оружия")
        question = self.raw_bank["tickets"][19]["questions"][8]
        self.assertEqual(question["options"][2]["text"], "Надежное удержание оружия при передвижениях, без каких-либо дополнительных требований")
        question = self.raw_bank["tickets"][2]["questions"][9]
        self.assertTrue(question["options"][1]["text"].endswith("вершину мушки в точку прицеливания"))

    def test_terminal_question_mark_duplicate_is_removed(self):
        questions = [question for ticket in self.bank["tickets"] for question in ticket["questions"]]
        question = next(question for question in questions if question["id"] == "5-9")
        self.assertEqual(question["aliases"], ["5-9", "7-8", "17-10"])
        self.assertEqual(question["sourceRefs"], [
            {"id": "5-9", "ticketId": 5, "questionNumber": 9},
            {"id": "7-8", "ticketId": 7, "questionNumber": 8},
            {"id": "17-10", "ticketId": 17, "questionNumber": 10},
        ])

    def test_same_stem_with_different_rules_is_preserved(self):
        questions = [question for ticket in self.bank["tickets"] for question in ticket["questions"]]
        safety = [question for question in questions if question["text"] ==
                  "Безопасное использование оружия предполагает в период непосредственного применения:"]
        self.assertEqual([question["id"] for question in safety], ["1-9", "2-9", "3-9", "8-9"])
        self.assertEqual([question["correctOptionId"] for question in safety], [3, 2, 2, 1])

    def test_deduplication_preserves_option_order_and_internal_punctuation(self):
        base = self.raw_bank["tickets"][0]["questions"][0]
        reordered = deepcopy(base)
        reordered["id"] = "1-2"
        reordered["number"] = 2
        reordered["options"][0]["text"], reordered["options"][2]["text"] = (
            reordered["options"][2]["text"], reordered["options"][0]["text"])
        punctuation = deepcopy(base)
        punctuation["id"] = "1-3"
        punctuation["number"] = 3
        punctuation["text"] = punctuation["text"].replace("«", "").replace("»", "")
        raw = {"source": "fixture.docx", "tickets": [{"id": 1, "questions": [base, reordered, punctuation]}]}
        before = deepcopy(raw)
        bank = extract.deduplicate_bank(raw)
        self.assertEqual(bank["metadata"]["uniqueQuestionCount"], 3)
        self.assertEqual(raw, before)

    def test_case_and_layout_variations_merge_without_mutating_source(self):
        base = self.raw_bank["tickets"][0]["questions"][0]
        duplicate = deepcopy(base)
        duplicate["id"] = "2-7"
        duplicate["number"] = 7
        duplicate["text"] = base["text"].upper().replace(" ", "\t  ") + "?"
        for option in duplicate["options"]:
            option["text"] = option["text"].upper().replace(" ", "\n  ")
        raw = {"source": "fixture.docx", "tickets": [
            {"id": 1, "questions": [base]}, {"id": 2, "questions": [duplicate]}]}
        before = deepcopy(raw)
        bank = extract.deduplicate_bank(raw)
        self.assertEqual(bank["metadata"]["uniqueQuestionCount"], 1)
        self.assertEqual(bank["tickets"][0]["questions"][0]["aliases"], ["1-1", "2-7"])
        self.assertEqual(raw, before)
        duplicate["correctOptionId"] = 1
        with self.assertRaisesRegex(extract.ExtractionError, "Conflicting answer keys"):
            extract.deduplicate_bank(raw)

    def test_empty_or_invalid_answer_is_rejected(self):
        for value in ("", "4", "1, 2", "неизвестно"):
            with self.subTest(value=value), self.assertRaises(extract.ExtractionError):
                def change(document):
                    cell = document.find(W + "body/" + W + "tbl/" + W + "tr[2]").findall(W + "tc")[2]
                    next(cell.iter(W + "t")).text = value
                self.parse_changed(change)

    def test_missing_ticket_or_row_is_rejected(self):
        with self.assertRaises(extract.ExtractionError):
            def change(document):
                table = document.find(W + "body/" + W + "tbl")
                table.remove(table.findall(W + "tr")[-1])
            self.parse_changed(change)
        with self.assertRaises(extract.ExtractionError):
            def change(document):
                body = document.find(W + "body")
                body.remove(body.findall(W + "tbl")[-1])
            self.parse_changed(change)

    def test_duplicate_or_missing_option_marker_is_rejected(self):
        with self.assertRaises(extract.ExtractionError):
            def change(document):
                cell = document.find(W + "body/" + W + "tbl/" + W + "tr[2]").findall(W + "tc")[1]
                for node in cell.iter(W + "t"):
                    if (node.text or "").lstrip().startswith("3."):
                        node.text = node.text.replace("3.", "2.", 1)
                        break
            self.parse_changed(change)

    def test_conflicting_repeated_question_answers_are_rejected(self):
        with self.assertRaisesRegex(extract.ExtractionError, "Conflicting answer keys"):
            def change(document):
                # Ticket 2 question 1 repeats ticket 1 question 5 (answer 3).
                table = document.find(W + "body").findall(W + "tbl")[1]
                cell = table.findall(W + "tr")[1].findall(W + "tc")[2]
                next(cell.iter(W + "t")).text = "1"
            self.parse_changed(change)


if __name__ == "__main__":
    unittest.main()
