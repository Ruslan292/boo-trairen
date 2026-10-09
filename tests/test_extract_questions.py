"""Validate source fidelity and refusal to guess ambiguous answer keys."""

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
        cls.bank = extract.extract_questions(extract.SOURCE)

    def parse_changed(self, change):
        document = deepcopy(self.document)
        change(document)
        return extract.parse_document(ET.tostring(document), extract.SOURCE.name)

    def test_generated_bank_matches_source(self):
        saved = json.loads(extract.OUTPUT.read_text(encoding="utf-8"))
        self.assertEqual(saved, self.bank)
        self.assertEqual([ticket["id"] for ticket in self.bank["tickets"]], list(range(1, 21)))
        questions = [question for ticket in self.bank["tickets"] for question in ticket["questions"]]
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

    def test_inline_options_and_wrapped_paragraphs_keep_all_words(self):
        question = self.bank["tickets"][10]["questions"][6]
        self.assertEqual(question["text"], "Для эффективного поражения цели предполагается ведение огня (в зависимости от дистанции):")
        self.assertEqual(question["options"][0]["text"], "На дистанции, не превышающей рекомендуемую для данного оружия")
        question = self.bank["tickets"][19]["questions"][8]
        self.assertEqual(question["options"][2]["text"], "Надежное удержание оружия при передвижениях, без каких-либо дополнительных требований")
        question = self.bank["tickets"][2]["questions"][9]
        self.assertTrue(question["options"][1]["text"].endswith("вершину мушки в точку прицеливания"))

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
