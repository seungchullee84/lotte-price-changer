import json
import re
import sys
from io import BytesIO
from zipfile import ZipFile


MAX_INPUT_BYTES = 5 * 1024 * 1024
MAX_EXPANDED_BYTES = 32 * 1024 * 1024
MAX_ROWS = 5_000
HEADERS = (
    {"품번", "상품품번", "스타일코드"},
    {"원가격", "원래가격", "정상가", "현재가", "기존판매가", "기존가격", "기준가"},
    {"할인가", "할인판매가", "변경가", "변경판매가"},
)


class InputError(ValueError):
    pass


def is_header(columns):
    labels = (re.sub(r"\s+", "", column).removesuffix("(원)") for column in columns)
    return all(label in accepted for label, accepted in zip(labels, HEADERS, strict=True))


def cell_text(value, original_cell, *, is_code):
    if value is None:
        return "수식 결과 없음" if original_cell.data_type == "f" else ""

    if type(value) is int or (type(value) is float and value.is_integer()):
        text = str(int(value))
        return text.zfill(8) if is_code and len(text) == 7 and text.isdecimal() else text

    text = str(value).strip()
    if len(text) > 64 or any(separator in text for separator in "\t\r\n"):
        return "잘못된 셀 값"
    return text


def read_first_worksheet(payload, load_workbook):
    if len(payload) > MAX_INPUT_BYTES:
        raise InputError("5MB 이하의 엑셀 파일을 선택해 주세요.")

    with ZipFile(BytesIO(payload)) as archive:
        members = archive.infolist()
        if len(members) > 1_000 or sum(member.file_size for member in members) > MAX_EXPANDED_BYTES:
            raise InputError("엑셀 파일 내부 자료가 너무 큽니다.")

    cached = load_workbook(BytesIO(payload), read_only=True, data_only=True, keep_links=False)
    try:
        if not cached.worksheets:
            raise InputError("엑셀 파일에서 작업 시트를 찾지 못했습니다.")

        original = load_workbook(BytesIO(payload), read_only=True, data_only=False, keep_links=False)
        try:
            cached_sheet = cached.worksheets[0]
            original_sheet = original.worksheets[0]
            # Some XLSX writers save stale dimensions that exclude existing rows.
            cached_sheet.reset_dimensions()
            original_sheet.reset_dimensions()
            cached_rows = cached_sheet.iter_rows(min_row=1, max_col=3, values_only=True)
            original_rows = original_sheet.iter_rows(min_row=1, max_col=3)
            lines = []
            first_content_row = True
            for row_number, (values, originals) in enumerate(zip(cached_rows, original_rows, strict=True), 1):
                if row_number > MAX_ROWS:
                    raise InputError("엑셀의 첫 시트는 5,000행까지 읽을 수 있습니다.")

                columns = [
                    cell_text(value, cell, is_code=(column == 0))
                    for column, (value, cell) in enumerate(zip(values, originals, strict=True))
                ]
                if not any(columns):
                    lines.append("")
                elif first_content_row and is_header(columns):
                    lines.append("")
                    first_content_row = False
                else:
                    lines.append("\t".join(columns))
                    first_content_row = False

            return "\n".join(lines)
        finally:
            original.close()
    finally:
        cached.close()


def main():
    try:
        from openpyxl import load_workbook
    except ImportError:
        sys.stderr.buffer.write("엑셀을 읽으려면 openpyxl이 설치된 Python이 필요합니다.\n".encode("utf-8"))
        return 1

    try:
        payload = sys.stdin.buffer.read(MAX_INPUT_BYTES + 1)
        result = read_first_worksheet(payload, load_workbook)
        sys.stdout.buffer.write(json.dumps({"sourceText": result}, ensure_ascii=False).encode("utf-8"))
    except InputError as error:
        sys.stderr.buffer.write(f"{error}\n".encode("utf-8"))
        return 1
    except Exception:
        sys.stderr.buffer.write("엑셀 파일을 열 수 없습니다. 정상적인 .xlsx 파일인지 확인해 주세요.\n".encode("utf-8"))
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
