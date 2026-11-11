import importlib.util
import unittest
from io import BytesIO
from pathlib import Path

from openpyxl import Workbook, load_workbook

spec = importlib.util.spec_from_file_location("read_xlsx", Path(__file__).resolve().parents[1] / "read-xlsx.py")
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)


def workbook_bytes(rows):
    workbook = Workbook()
    for row in rows:
        workbook.active.append(row)
    payload = BytesIO()
    workbook.save(payload)
    workbook.close()
    return payload.getvalue()


class ReadWorkbookTests(unittest.TestCase):
    def test_header_numeric_code_and_source_lines(self):
        payload = workbook_bytes([[None, None, None], ["품번", "정상가 (원)", "할인 판매가"], [1026990, 49800, 44200]])
        self.assertEqual(reader.read_first_worksheet(payload, load_workbook), "\n\n01026990\t49800\t44200")

    def test_text_code_and_formatted_amounts(self):
        payload = workbook_bytes([["01026990", "49,800", "44,200"]])
        self.assertEqual(reader.read_first_worksheet(payload, load_workbook), "01026990\t49,800\t44,200")

    def test_formula_without_cached_result_is_explicit(self):
        payload = workbook_bytes([["01026990", 49800, "=B1*0.9"]])
        self.assertIn("수식 결과 없음", reader.read_first_worksheet(payload, load_workbook))

    def test_multiline_cell_does_not_create_phantom_products(self):
        payload = workbook_bytes([["01026990\n01026991", 49800, 44200]])
        result = reader.read_first_worksheet(payload, load_workbook)
        self.assertEqual(result, "잘못된 셀 값\t49800\t44200")

    def test_oversize_payload_is_rejected(self):
        with self.assertRaises(reader.InputError):
            reader.read_first_worksheet(b"0" * (reader.MAX_INPUT_BYTES + 1), load_workbook)

    def test_invalid_zip_is_rejected(self):
        with self.assertRaises(Exception):
            reader.read_first_worksheet(b"not an xlsx", load_workbook)


if __name__ == "__main__":
    unittest.main()
